// Adaptador de runtime falso: deja probar el runner y su contrato de eventos sin un CLI real,
// con escenarios guionados por variable de entorno. Este mismo archivo es el "CLI" que su
// `buildCmd` invoca: ejecutado directo, reproduce el guion de MEFISTO_FAKE_SCRIPT.
//
// Guiones (`success` por defecto):
//   success            mensaje, tool y terminal de exito. Sale con 0.
//   slow-success       las mismas lineas que `success`, con MEFISTO_FAKE_STEP_DELAY_S segundos
//                      (2 por defecto) entre una y otra.
//   success-then-hang  declara exito y no sale.
//   fail               terminal de fallo. Sale con MEFISTO_FAKE_EXIT_CODE (3 por defecto).
//   hang               un mensaje y no sale.
//   no-terminal        un mensaje y ningun terminal. Sale con 0.
//   two-terminals      dos terminales. Sale con 0.
//   malformed          una linea valida y otra cortada a media escritura. Sale con 1.
//   sensitive-success  centinelas en mensaje e input, para probar la redaccion. Sale con 0.
//   sensitive-fail     centinelas en el detalle del fallo y en stderr. Sale distinto de 0.
//   touch-tty          toca la terminal de control y la entrada estandar antes de terminar bien.
//   self-stop          se detiene a si mismo con SIGSTOP y, al reanudarse, termina bien.
//   dump-stdin         copia la entrada estandar a MEFISTO_FAKE_STDIN_DUMP_FILE y anota si era
//                      una terminal (`STDIN_TTY=0|1` en MEFISTO_FAKE_ARGS_FILE, o `<volcado>.tty`).
//
// MEFISTO_FAKE_ARGS_FILE recibe el argv del "CLI", un argumento por linea.

import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isatty, ReadStream } from 'node:tty'
import { fileURLToPath } from 'node:url'

import { isEntryPoint } from '../../../scripts/lib/cli.mts'
import { alt, get, isObject } from '../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../scripts/lib/jq-values.mts'
import type { BuildCommandInput, RuntimeCommand, TranslateInput } from './mefisto-runtime.mts'

const PROFILES = ['fast', 'balanced', 'deep']
const LEVELS = ['quick', 'light', 'standard', 'thorough', 'exhaustive']
const EMIT = '__mefisto-fake-emit'

export function isAvailable(env: NodeJS.ProcessEnv): boolean {
  return env.MEFISTO_FAKE_AVAILABLE === '1'
}

export function defaultModel(profile: string, env: NodeJS.ProcessEnv): string | null {
  return PROFILES.includes(profile) ? (env.MEFISTO_FAKE_DEFAULT_MODEL ?? '') : null
}

export function defaultEffort(level: string, env: NodeJS.ProcessEnv): string | null {
  return LEVELS.includes(level) ? (env.MEFISTO_FAKE_DEFAULT_EFFORT ?? '') : null
}

/** Sin soporte salvo que el test lo pida: el trato que le toca a un runtime sin reanudacion. */
export function supportsResume(env: NodeJS.ProcessEnv): boolean {
  return env.MEFISTO_FAKE_SUPPORTS_RESUME === '1'
}

export function interactiveRefresh(env: NodeJS.ProcessEnv): string | null {
  const strategy = env.MEFISTO_FAKE_INTERACTIVE_REFRESH ?? ''
  return strategy.length > 0 ? strategy : null
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

export function buildCmd(input: BuildCommandInput): RuntimeCommand {
  const argv = [process.execPath, fileURLToPath(import.meta.url), EMIT, input.agent, input.promptFile, input.systemFile]
  if (input.model.length > 0) argv.push('--fake-model', input.model)
  if (input.effort.length > 0) argv.push('--fake-effort', input.effort)
  if (input.resumeSessionId.length > 0) argv.push('--fake-resume', input.resumeSessionId)
  if (input.workDir.length === 0 || !isDirectory(input.workDir)) return { argv }

  const stdinFile = join(input.workDir, 'fake-stdin-prompt')
  const prompt = readFileSync(input.promptFile)
  const withSystem = input.systemFile.length > 0 && isFile(input.systemFile)
  writeFileSync(
    stdinFile,
    withSystem ? Buffer.concat([readFileSync(input.systemFile), Buffer.from('\n\n'), prompt]) : prompt,
  )
  return { argv, stdinFile }
}

const EMPTY_TOKENS = { input: null, output: null, cache_read: null, cache_write: null, reasoning: null }

function translateLine(line: string, runtime: string, ts: string): Json | undefined {
  let event: Json
  try {
    event = JSON.parse(line) as Json
  } catch {
    return undefined
  }
  if (!isObject(event)) return undefined
  const fake = get(event, 'fake')
  if (fake === 'message') {
    return { v: 1, type: 'message', ts, role: 'assistant', text: alt(get(event, 'text'), '') }
  }
  if (fake === 'tool_start') {
    return {
      v: 1,
      type: 'tool.started',
      ts,
      tool: alt(get(event, 'tool'), '?'),
      input_summary: alt(get(event, 'input_summary'), null),
    }
  }
  if (fake === 'tool_end') {
    return {
      v: 1,
      type: 'tool.completed',
      ts,
      tool: alt(get(event, 'tool'), '?'),
      ok: alt(get(event, 'ok'), false),
      duration_ms: alt(get(event, 'duration_ms'), null),
    }
  }
  if (fake !== 'terminal') return undefined
  const status = get(event, 'status')
  if (status !== 'success' && status !== 'failed') return undefined
  return {
    v: 1,
    type: status === 'success' ? 'run.completed' : 'run.failed',
    ts,
    status,
    runtime,
    model: alt(get(event, 'model'), null),
    session_id: null,
    // Lo fija el runner, que es quien mide el reloj de pared de la corrida entera.
    duration_ms: null,
    tokens: { ...EMPTY_TOKENS },
    estimated_cost_usd: null,
    turns: null,
    denials: null,
    ttft_ms: null,
    api_duration_ms: null,
    error:
      status === 'success'
        ? null
        : {
            kind: alt(get(event, 'error_kind'), 'nonzero_exit'),
            detail: alt(get(event, 'error_detail'), 'fallo del guion fake'),
          },
  }
}

export function translate(input: TranslateInput): Json[] {
  if (!isFile(input.rawFile)) return []
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const events: Json[] = []
  for (const line of readFileSync(input.rawFile, 'utf8').split('\n')) {
    const event = translateLine(line, input.runtime, ts)
    if (event !== undefined) events.push(event)
  }
  return events
}

function out(line: string): void {
  writeSync(1, `${line}\n`)
}

function pause(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

/** Lee de `fd` hasta el primer salto de linea o el fin; cualquier fallo cuenta como fin. */
function readLine(fd: number): void {
  const byte = Buffer.alloc(1)
  try {
    while (readSync(fd, byte, 0, 1, null) === 1 && byte[0] !== 0x0a) {
      // Se descarta: solo importa haber leido.
    }
  } catch {
    // Sin terminal o sin entrada, la lectura falla enseguida y sin senal.
  }
}

function touchTty(): void {
  try {
    const tty = openSync('/dev/tty', 'r')
    readLine(tty)
    closeSync(tty)
  } catch {
    // Sin terminal de control no hay nada que tocar.
  }
  try {
    if (isatty(0)) new ReadStream(0).setRawMode(true)
  } catch {
    // Igual que arriba.
  }
  readLine(0)
}

function dumpStdin(env: NodeJS.ProcessEnv): void {
  const target = env.MEFISTO_FAKE_STDIN_DUMP_FILE ?? ''
  const argsFile = env.MEFISTO_FAKE_ARGS_FILE ?? ''
  const tty = isatty(0) ? '1' : '0'
  if (argsFile.length > 0) appendFileSync(argsFile, `STDIN_TTY=${tty}\n`)
  else if (target.length > 0) writeFileSync(`${target}.tty`, `${tty}\n`)

  const dump = target.length > 0 ? openSync(target, 'w') : null
  const chunk = Buffer.alloc(65536)
  for (;;) {
    let read = 0
    try {
      read = readSync(0, chunk, 0, chunk.length, null)
    } catch {
      break
    }
    if (read === 0) break
    if (dump !== null) writeSync(dump, chunk, 0, read)
  }
  if (dump !== null) closeSync(dump)
}

/** El "CLI" falso: devuelve el codigo de salida del guion, o no vuelve si el guion se cuelga. */
export async function emit(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const argsFile = env.MEFISTO_FAKE_ARGS_FILE ?? ''
  if (argsFile.length > 0) writeFileSync(argsFile, argv.map((arg) => `${arg}\n`).join(''))

  let model: string | null = null
  let effort: string | null = null
  // Tras el token, el agente, el prompt y el system file solo quedan los flags.
  for (let index = 4; index < argv.length; index++) {
    const value = argv[index + 1] ?? ''
    if (argv[index] === '--fake-model') model = value.length > 0 ? value : null
    else if (argv[index] === '--fake-effort') effort = value.length > 0 ? value : null
    else if (argv[index] !== '--fake-resume') continue
    index++
  }
  const tail = `"model":${JSON.stringify(model)},"effort":${JSON.stringify(effort)}`
  const success = `{"fake":"terminal","status":"success",${tail}}`
  const failure = (kind: string, detail: string): string =>
    `{"fake":"terminal","status":"failed",${tail},"error_kind":"${kind}","error_detail":"${detail}"}`
  const exitCode = Number(env.MEFISTO_FAKE_EXIT_CODE || '3')
  const script = env.MEFISTO_FAKE_SCRIPT ?? ''

  switch (script.length > 0 ? script : 'success') {
    case 'success':
      out('{"fake":"message","text":"hola desde el guion fake"}')
      out('{"fake":"tool_start","tool":"demo"}')
      out('{"fake":"tool_end","tool":"demo","ok":true,"duration_ms":5}')
      out(success)
      return 0
    case 'slow-success': {
      const delay = Number(env.MEFISTO_FAKE_STEP_DELAY_S || '2')
      out('{"fake":"message","text":"hola desde el guion fake"}')
      await pause(delay)
      out('{"fake":"tool_start","tool":"demo"}')
      await pause(delay)
      out('{"fake":"tool_end","tool":"demo","ok":true,"duration_ms":5}')
      await pause(delay)
      out(success)
      return 0
    }
    case 'success-then-hang':
      out('{"fake":"message","text":"declaro exito y no sale"}')
      out(success)
      await pause(3600)
      return 0
    case 'fail':
      out(failure('nonzero_exit', 'guion fail'))
      return exitCode
    case 'hang':
      out('{"fake":"message","text":"colgando hasta que el watchdog mate el proceso"}')
      await pause(3600)
      return 0
    case 'no-terminal':
      out('{"fake":"message","text":"nunca emite un evento terminal"}')
      return 0
    case 'two-terminals':
      out(success)
      out(failure('nonzero_exit', 'segundo terminal'))
      return 0
    case 'malformed':
      out('{"fake":"message","text":"antes del corte"}')
      writeSync(1, '{"fake":"terminal","status":"suc')
      return 1
    case 'sensitive-success':
      out('{"fake":"message","text":"PROMPT_SENTINEL ASSISTANT_SENTINEL AUTH_TOKEN_SENTINEL HEADER_SENTINEL"}')
      out('{"fake":"tool_start","tool":"Bash","input_summary":"COMMAND_SENTINEL input"}')
      out('{"fake":"tool_end","tool":"Bash","ok":true,"duration_ms":5}')
      out(success)
      return 0
    case 'sensitive-fail':
      out('{"fake":"message","text":"ASSISTANT_SENTINEL"}')
      out(failure('api_error', 'STDERR_SENTINEL AUTH_TOKEN_SENTINEL'))
      writeSync(2, 'STDERR_SENTINEL HEADER_SENTINEL AUTH_TOKEN_SENTINEL\n')
      return exitCode
    case 'touch-tty':
      out('{"fake":"message","text":"tocando la tty antes de terminar"}')
      touchTty()
      out(success)
      return 0
    case 'self-stop':
      out('{"fake":"message","text":"a punto de auto-detenerme con SIGSTOP"}')
      // Windows no tiene SIGSTOP: alli el guion sigue de largo.
      if (process.platform !== 'win32') process.kill(process.pid, 'SIGSTOP')
      out(success)
      return 0
    case 'dump-stdin':
      out('{"fake":"message","text":"volcando stdin a MEFISTO_FAKE_STDIN_DUMP_FILE"}')
      dumpStdin(env)
      out(success)
      return 0
    default:
      writeSync(2, `runtime-fake: MEFISTO_FAKE_SCRIPT desconocido: '${script}'\n`)
      return 2
  }
}

if (isEntryPoint(import.meta.url) && process.argv[2] === EMIT) {
  process.exit(await emit(process.argv.slice(2), process.env))
}
