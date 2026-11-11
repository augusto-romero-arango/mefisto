// Runner neutral a runtime de una invocacion de agente (MEF-ADR-0049). Recibe argumentos opacos,
// lanza el CLI del runtime a traves de su adaptador, escribe el JSONL neutral de
// `contract/run-events.schema.json` en --event-log mientras el agente corre y devuelve un codigo
// que resume el desenlace: 0 con un terminal de exito, 124 por timeout sin exito declarado, 65 si
// el adaptador no emitio exactamente un terminal, 64 por uso, 69 si no hay runtime o adaptador y,
// en otro caso, el codigo distinto de cero del adaptador. Ver `contract/README.md`.
//
// Entorno: MEFISTO_RUNTIME y MEFISTO_RUNTIME_LIB_DIR (resolucion del adaptador),
// MEFISTO_RUN_AGENT_LIVE_INTERVAL (segundos entre anexos en vivo, 2), MEFISTO_WATCHDOG_POLL_S
// (rebanada del watchdog, 5) y MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S (120): un agente que ya
// declaro exito y sigue vivo pasada esa gracia se termina, queda `POST-RESULT` en --events-log y
// la corrida cierra con su terminal de exito.

import { accessSync, appendFileSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CliError, commandExists, isEntryPoint } from '../../scripts/lib/cli.mts'
import { dump, get, isObject } from '../../scripts/lib/jq-values.mts'
import type { Json, JsonObject } from '../../scripts/lib/jq-values.mts'
import { runWithWatchdog } from './lib/mefisto-process.mts'
import type { ProcessTree, WatchdogResult } from './lib/mefisto-process.mts'
import { adapterPath, loadAdapter, resolveRuntime, runtimeLibDir } from './lib/mefisto-runtime.mts'
import type { RuntimeCommand } from './lib/mefisto-runtime.mts'

const USAGE = `Uso: mefisto-run-agent.sh --agent <id> --cwd <dir> --prompt-file <f> --event-log <jsonl>
                           [--runtime <id>] [--model <opaco>] [--effort <opaco>]
                           [--system-file <f>]
                           [--timeout <s>] [--raw-log <f>] [--stderr-log <f>]
                           [--events-log <archivo>] [--resume-session <id>]
                           [--redact-observability] [--help]`

const EXIT_USAGE = 64
const EXIT_PROTOCOL = 65
const EXIT_UNAVAILABLE = 69
const EXIT_TIMEOUT = 124

const DEFAULT_TIMEOUT_S = 1800
const DEFAULT_LIVE_INTERVAL_S = 2
const DEFAULT_POST_RESULT_GRACE_S = 120

function usageError(message: string): CliError {
  return new CliError(`ERROR: ${message}\n${USAGE}`, EXIT_USAGE)
}

function unavailable(message: string): CliError {
  return new CliError(`ERROR: ${message}`, EXIT_UNAVAILABLE)
}

export interface RunAgentOptions {
  runtime: string
  agent: string
  cwd: string
  promptFile: string
  eventLog: string
  model: string
  effort: string
  systemFile: string
  timeout: string
  rawLog: string
  stderrLog: string
  eventsLog: string
  resumeSession: string
  redact: boolean
  help: boolean
}

const VALUE_FLAGS: Readonly<Record<string, Exclude<keyof RunAgentOptions, 'redact' | 'help'>>> = {
  '--runtime': 'runtime',
  '--agent': 'agent',
  '--cwd': 'cwd',
  '--prompt-file': 'promptFile',
  '--event-log': 'eventLog',
  '--model': 'model',
  '--effort': 'effort',
  '--system-file': 'systemFile',
  '--timeout': 'timeout',
  '--raw-log': 'rawLog',
  '--stderr-log': 'stderrLog',
  '--events-log': 'eventsLog',
  '--resume-session': 'resumeSession',
}

export function parseArgs(argv: string[]): RunAgentOptions {
  const options: RunAgentOptions = {
    runtime: '',
    agent: '',
    cwd: '',
    promptFile: '',
    eventLog: '',
    model: '',
    effort: '',
    systemFile: '',
    timeout: '',
    rawLog: '',
    stderrLog: '',
    eventsLog: '',
    resumeSession: '',
    redact: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index] ?? ''
    const field = Object.hasOwn(VALUE_FLAGS, flag) ? VALUE_FLAGS[flag] : undefined
    if (field !== undefined) {
      const value = argv[index + 1]
      if (value === undefined) throw usageError(`${flag} requiere un valor`)
      options[field] = value
      index++
    } else if (flag === '--redact-observability') {
      options.redact = true
    } else if (flag === '--help') {
      options.help = true
      return options
    } else {
      throw usageError(`argumento desconocido: '${flag}'`)
    }
  }
  return options
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function ensureParent(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // Si el directorio no se puede crear, falla quien escriba el archivo.
  }
}

function validate(options: RunAgentOptions): number {
  if (options.agent.length === 0) throw usageError('--agent es obligatorio')
  if (options.cwd.length === 0) throw usageError('--cwd es obligatorio')
  if (options.promptFile.length === 0) throw usageError('--prompt-file es obligatorio')
  if (options.eventLog.length === 0) throw usageError('--event-log es obligatorio')
  if (!isDirectory(options.cwd)) throw usageError(`--cwd '${options.cwd}' no es un directorio existente`)
  if (!isFile(options.promptFile)) throw usageError(`--prompt-file '${options.promptFile}' no existe`)
  if (options.systemFile.length > 0 && !isFile(options.systemFile)) {
    throw usageError(`--system-file '${options.systemFile}' no existe`)
  }
  if (options.timeout.length === 0) return DEFAULT_TIMEOUT_S
  if (!/^[0-9]+$/.test(options.timeout)) throw usageError(`--timeout '${options.timeout}' no es un entero`)
  const timeout = Number(options.timeout)
  if (timeout <= 0) throw usageError('--timeout debe ser mayor que 0')
  return timeout
}

/**
 * Entero de una variable de entorno con minimo 1. Lo decide el valor, no la forma: "00" es todo
 * digitos y vale cero. `null` si no sirve.
 */
function positiveInteger(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null
  const value = Number(raw)
  return value >= 1 ? value : null
}

const two = (value: number): string => String(value).padStart(2, '0')

function localClock(date: Date): string {
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function utcSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const epochSeconds = (): number => Math.floor(Date.now() / 1000)

function isTerminal(event: JsonObject): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed'
}

/**
 * Proyeccion segura para observabilidad: sin `message`, sin `input_summary` y con `error.detail`
 * reducido a su `kind`. Con `redact` en falso devuelve los eventos tal cual.
 */
export function redactEvents(events: JsonObject[], redact: boolean): JsonObject[] {
  if (!redact) return events
  const out: JsonObject[] = []
  for (const event of events) {
    if (event.type === 'message') continue
    if (event.type === 'tool.started') {
      out.push({ ...event, input_summary: null })
    } else if (isObject(event.error)) {
      const kind = event.error.kind ?? null
      // Un `kind` que no es texto corta la proyeccion: lo ya emitido se conserva.
      if (kind !== null && typeof kind !== 'string') break
      out.push({ ...event, error: { ...event.error, detail: `detalle redactado: ${kind ?? ''}` } })
    } else {
      out.push(event)
    }
  }
  return out
}

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function eventClock(ts: Json): string {
  if (typeof ts !== 'string') return '--:--:--'
  const whole = ts.replace(/\.[0-9]+Z$/, 'Z')
  const time = ISO_SECONDS.test(whole) ? Date.parse(whole) : NaN
  return Number.isNaN(time) ? '--:--:--' : localClock(new Date(time))
}

const FILE_TOOLS = ['edit', 'write', 'read']

function text(value: Json, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} no es texto`)
  return value
}

/**
 * Telemetria humana de una corrida: `[HH:MM:SS][archivo] <ruta>` por cada tool de archivo que
 * arranca, `[HH:MM:SS][tool] <agente> <tool> <ok|fail> <ruta-o-resumen|->` por cada tool que
 * termina y `[HH:MM:SS][stage] <agente> <status>` al final, en hora local. Los eventos no traen
 * id de llamada: un `tool.completed` toma el resumen del `tool.started` pendiente mas antiguo de
 * su mismo tool. Lanza si un evento no tiene la forma del contrato.
 */
export function humanTelemetry(nonTerminal: JsonObject[], agent: string, terminal: JsonObject): string[] {
  const pending = new Map<string, Json[]>()
  const lines: string[] = []
  for (const event of nonTerminal) {
    if (event.type === 'tool.started') {
      const tool = text(event.tool ?? null, 'tool')
      const summary = event.input_summary ?? null
      pending.set(tool, [...(pending.get(tool) ?? []), summary])
      // Solo un tool de archivo trae una ruta: el resumen de un comando no es un archivo.
      if (summary !== null && FILE_TOOLS.includes(tool.replace(/[A-Z]/g, (c) => c.toLowerCase()))) {
        lines.push(`[${eventClock(event.ts ?? null)}][archivo] ${text(summary, 'input_summary')}`)
      }
    } else if (event.type === 'tool.completed') {
      const tool = text(event.tool ?? null, 'tool')
      const [summary = null, ...rest] = pending.get(tool) ?? []
      pending.set(tool, rest)
      const ok = event.ok !== undefined && event.ok !== null && event.ok !== false
      const detail = summary === null || summary === false ? '-' : text(summary, 'input_summary')
      lines.push(`[${eventClock(event.ts ?? null)}][tool] ${agent} ${tool} ${ok ? 'ok' : 'fail'} ${detail}`)
    }
  }
  const raw = (value: Json): string => (typeof value === 'string' ? value : dump(value))
  lines.push(`[${eventClock(terminal.ts ?? null)}][stage] ${agent} ${raw(terminal.status ?? null)}`)
  return lines
}

const NULL_TOKENS = { input: null, output: null, cache_read: null, cache_write: null, reasoning: null }

function syntheticTerminal(status: string, runtime: string, model: string | null, detail: string): JsonObject {
  return {
    v: 1,
    type: 'run.failed',
    ts: utcSeconds(new Date()),
    status,
    runtime,
    model,
    session_id: null,
    duration_ms: null,
    tokens: { ...NULL_TOKENS },
    estimated_cost_usd: null,
    turns: null,
    denials: null,
    ttft_ms: null,
    api_duration_ms: null,
    error: { kind: status, detail },
  }
}

const jsonl = (events: JsonObject[]): string => events.map((event) => `${dump(event)}\n`).join('')

const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

export type Warn = (line: string) => void

/** Corre el agente y devuelve el codigo de salida del runner. */
export async function runAgent(argv: string[], env: NodeJS.ProcessEnv, warn: Warn): Promise<number> {
  const options = parseArgs(argv)
  if (options.help) {
    warn(USAGE)
    return 0
  }
  const timeoutS = validate(options)

  const rawInterval = env.MEFISTO_RUN_AGENT_LIVE_INTERVAL ?? ''
  let liveInterval = rawInterval.length === 0 ? DEFAULT_LIVE_INTERVAL_S : positiveInteger(rawInterval)
  if (liveInterval === null) {
    warn(
      `AVISO: MEFISTO_RUN_AGENT_LIVE_INTERVAL='${rawInterval}' invalido (debe ser un entero > 0); usando el default (${DEFAULT_LIVE_INTERVAL_S}s)`,
    )
    liveInterval = DEFAULT_LIVE_INTERVAL_S
  }
  const rawGrace = env.MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S ?? ''
  let grace = rawGrace.length === 0 ? DEFAULT_POST_RESULT_GRACE_S : positiveInteger(rawGrace)
  if (grace === null) {
    warn(
      `AVISO: MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S='${rawGrace}' invalido (debe ser un entero >= 1); usando el default (${DEFAULT_POST_RESULT_GRACE_S}s)`,
    )
    grace = DEFAULT_POST_RESULT_GRACE_S
  }

  const libDir = runtimeLibDir(env)
  const resolved = await resolveRuntime(options.runtime, env, (command) => commandExists(command, env), libDir)
  if ('error' in resolved) throw unavailable(resolved.error)
  const runtime = resolved.runtime
  const lib = adapterPath(libDir, runtime)
  const adapter = await loadAdapter(libDir, runtime)
  const buildCmd = adapter?.buildCmd
  const translate = adapter?.translate
  if (typeof buildCmd !== 'function') throw unavailable(`${lib} no define buildCmd`)
  if (typeof translate !== 'function') throw unavailable(`${lib} no define translate`)

  // Un directorio por corrida: de el cuelga todo lo efimero, incluido lo que el adaptador
  // materialice para la entrada estandar.
  let workDir: string
  try {
    workDir = mkdtempSync(join(tmpdir(), 'mefisto-run-agent.'))
  } catch {
    throw unavailable('no se pudo crear el directorio temporal de la corrida')
  }
  let tree: ProcessTree | null = null
  const onSignal = (signal: NodeJS.Signals): void => {
    // El watchdog vive en este proceso: si el runner muere, el agente no puede quedar sin limite.
    tree?.kill()
    rmSync(workDir, { recursive: true, force: true })
    process.exit(SIGNAL_EXIT[signal] ?? 1)
  }
  for (const signal of SIGNALS) process.on(signal, onSignal)

  try {
    const buildFn = `runtime_${runtime}_build_cmd`
    let command: RuntimeCommand = { argv: [] }
    try {
      command = buildCmd({
        agent: options.agent,
        cwd: options.cwd,
        promptFile: options.promptFile,
        model: options.model,
        systemFile: options.systemFile,
        resumeSessionId: options.resumeSession,
        effort: options.effort,
        workDir,
        env,
      })
    } catch {
      command = { argv: [] }
    }
    if (!Array.isArray(command.argv) || command.argv.length === 0) {
      throw unavailable(`${buildFn} no genero ningun comando (MEFISTO_RUNTIME_CMD vacio)`)
    }
    const stdinFile = command.stdinFile ?? ''
    // Un stdin roto en silencio es peor que fallar antes de lanzar el proceso.
    if (stdinFile.length > 0 && !(isFile(stdinFile) && isReadable(stdinFile))) {
      throw unavailable(
        `${buildFn} fijo MEFISTO_RUNTIME_STDIN_FILE='${stdinFile}', que no es un archivo regular legible`,
      )
    }

    ensureParent(options.eventLog)
    try {
      writeFileSync(options.eventLog, '')
    } catch {
      throw usageError(`--event-log '${options.eventLog}' no es escribible`)
    }
    const rawLog = options.rawLog.length > 0 ? options.rawLog : join(workDir, 'raw.log')
    const stderrLog = options.stderrLog.length > 0 ? options.stderrLog : join(workDir, 'stderr.log')
    if (options.rawLog.length > 0) ensureParent(rawLog)
    if (options.stderrLog.length > 0) ensureParent(stderrLog)
    if (options.redact && (options.rawLog.length > 0 || options.stderrLog.length > 0)) {
      warn(
        `AVISO: --redact-observability no redacta los destinos solicitados explicitamente (--raw-log: '${options.rawLog || '<no solicitado>'}', --stderr-log: '${options.stderrLog || '<no solicitado>'}'); no son observabilidad segura`,
      )
    }
    if (options.eventsLog.length > 0) ensureParent(options.eventsLog)
    const humanLog = (line: string): void => {
      if (options.eventsLog.length === 0) return
      try {
        appendFileSync(options.eventsLog, `[${localClock(new Date())}] ${line}\n`)
      } catch {
        // La telemetria humana nunca decide el desenlace.
      }
    }

    const model = options.model.length > 0 ? options.model : null
    writeFileSync(
      options.eventLog,
      jsonl([
        {
          v: 1,
          type: 'run.started',
          ts: utcSeconds(new Date()),
          runtime,
          agent: options.agent,
          model,
          effort: options.effort.length > 0 ? options.effort : null,
          cwd: options.cwd,
        },
      ]),
    )

    const translated = (exitCode: number | null, stderrFile: string): JsonObject[] => {
      try {
        return redactEvents(
          translate({ rawFile: rawLog, runtime, model: options.model, exitCode, stderrFile }).filter(isObject),
          options.redact,
        )
      } catch {
        return []
      }
    }

    let written = 0
    let successSince: number | null = null
    let terminate = false
    // El exito declarado se anota una vez; pasada la gracia con el proceso aun vivo, se pide
    // terminarlo. Nunca decide el exit ni el terminal, que se fijan al cierre.
    const postResultCheck = (events: JsonObject[]): void => {
      if (terminate) return
      if (!events.some((event) => event.type === 'run.completed' && event.status === 'success')) return
      const now = epochSeconds()
      if (successSince === null) {
        successSince = now
        return
      }
      const waited = now - successSince
      if (waited < grace) return
      humanLog(`POST-RESULT: ${options.agent} seguia vivo ${waited}s despues de declarar exito -- SIGTERM`)
      terminate = true
    }
    // Anexo en vivo: solo los no terminales nuevos, sin reescribir nada. Es best-effort.
    const liveTick = (): void => {
      if (!isFile(rawLog)) return
      const events = translated(null, '')
      if (events.length === 0) return
      postResultCheck(events)
      const pending = events.filter((event) => !isTerminal(event)).slice(written)
      if (pending.length === 0) return
      try {
        appendFileSync(options.eventLog, jsonl(pending))
        written += pending.length
      } catch {
        // Se reintenta en el siguiente intervalo o al cierre.
      }
    }

    const startEpoch = epochSeconds()
    const live = setInterval(liveTick, liveInterval * 1000)
    let result: WatchdogResult
    try {
      result = await runWithWatchdog({
        argv: command.argv,
        cwd: options.cwd,
        env: {
          ...env,
          LC_ALL: 'C',
          MEFISTO_RUNTIME_LIB_DIR: libDir,
          MEFISTO_RUNTIME_WORK_DIR: workDir,
          ...command.env,
        },
        timeoutSeconds: timeoutS,
        stdoutFile: rawLog,
        stderrFile: stderrLog,
        eventsLog: join(workDir, 'watchdog-events.log'),
        label: options.agent,
        ...(stdinFile.length > 0 ? { stdinFile } : {}),
        terminateRequested: () => terminate,
        onStart: (started) => {
          tree = started
        },
      })
    } catch {
      // Sin poder abrir sus archivos el proceso no arranca: se informa como un fallo suyo.
      result = { exitCode: 1, timedOut: false }
    } finally {
      clearInterval(live)
    }
    tree = null
    const elapsedS = epochSeconds() - startEpoch
    // El timeout exige dos evidencias: el corte del watchdog y el reloj de pared de la corrida.
    const timedOut = result.timedOut && elapsedS >= timeoutS

    const events = translated(result.exitCode, stderrLog)
    const nonTerminal = events.filter((event) => !isTerminal(event))
    const terminals = events.filter(isTerminal)
    const [declared] = terminals
    const declaredSuccess = terminals.length === 1 && declared?.status === 'success'

    let terminal: JsonObject
    let exitCode: number
    if (timedOut && !declaredSuccess) {
      // Cortado a mitad de vuelo, el terminal del adaptador no es confiable; los eventos previos
      // si se conservan: dicen donde se colgo la corrida.
      terminal = syntheticTerminal(
        'timeout',
        runtime,
        model,
        `el watchdog mato el proceso tras superar ${timeoutS}s`,
      )
      exitCode = EXIT_TIMEOUT
    } else if (terminals.length === 1 && declared !== undefined) {
      if (timedOut) humanLog(`TIMEOUT tras exito declarado: ${options.agent}`)
      terminal = declared
      // El exito declarado manda sobre un exit distinto de cero posterior.
      exitCode = declared.status === 'success' ? 0 : result.exitCode !== 0 ? result.exitCode : 1
    } else {
      terminal = syntheticTerminal(
        'protocol_invalid',
        runtime,
        model,
        `el adaptador '${runtime}' emitio ${terminals.length} eventos terminales (se esperaba exactamente 1)`,
      )
      exitCode = EXIT_PROTOCOL
    }
    // El reloj de pared de la corrida entera solo lo tiene el runner.
    terminal = { ...terminal, duration_ms: elapsedS * 1000 }
    const [closing] = redactEvents([terminal], options.redact)

    appendFileSync(options.eventLog, jsonl(nonTerminal.slice(written)) + (closing === undefined ? '\n' : jsonl([closing])))

    if (options.eventsLog.length > 0) {
      let wrote = false
      try {
        const lines = humanTelemetry(nonTerminal, options.agent, closing ?? {})
        appendFileSync(options.eventsLog, `${lines.join('\n')}\n`)
        wrote = true
      } catch {
        wrote = false
      }
      if (!wrote) {
        warn(
          `AVISO: no se pudo escribir la telemetria de herramientas en events.log (destino: '${options.eventsLog}'); se omite sin afectar el exit code ni el evento terminal de la corrida (CA-3, issue #863)`,
        )
      }
    }
    return exitCode
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal)
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (isEntryPoint(import.meta.url)) {
  const warn: Warn = (line) => process.stderr.write(`${line}\n`)
  try {
    process.exitCode = await runAgent(process.argv.slice(2), process.env, warn)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    warn(error.message)
    process.exitCode = error.exitCode
  }
}
