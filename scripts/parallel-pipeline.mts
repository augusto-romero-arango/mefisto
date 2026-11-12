// Ejecuta pipelines para multiples issues en paralelo, cada uno en su worktree aislado, con una
// cola que respeta --max-parallel. Crea los PRs sin merge automatico.
//
// Uso:
//   parallel-pipeline.mts 42 43 44                              enrutamiento automatico por label
//   parallel-pipeline.mts --pipeline tooling 60 62 63           forzar pipeline tooling
//   parallel-pipeline.mts --pipeline tdd 42 43                  forzar pipeline tdd
//   parallel-pipeline.mts 42 43 44 --max-parallel 2             limitar concurrencia
//   parallel-pipeline.mts 42 43 44 --keep-status                no borrar los status por issue al terminar
//   MEFISTO_RUNTIME=<id> parallel-pipeline.mts 42 43 44         fijar runtime si la autodeteccion es ambigua
//
// Sin --pipeline, cada issue se enruta por su label tipo:*: feature, refactor y projection van a
// tdd-pipeline, tooling a tooling-pipeline; infra o sin tipo se saltan con aviso.
//
// Dos issues tipo:projection nunca corren a la vez: comparten los archivos del worker de
// proyecciones del Bounded Context (MEF-ADR-0034), y un repo es un solo BC (MEF-ADR-0023).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import type { Run } from './lib/azure-cli.mts'
import { COLOR, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import { dump } from './lib/jq-values.mts'
import type { Json } from './lib/jq-values.mts'
import { formatHoldStatus } from './lib/pipeline/agent-hold.mts'
import { runtimeCliAvailable } from './lib/pipeline/agent-runtime.mts'
import {
  BATCH_STOP_SIGNAL,
  ORCHESTRATOR_GLYPHS,
  REQUIRED_COMMANDS,
  batchStopPath,
  firstPullRequestUrl,
  isFile,
  launchChild,
  lineCount,
  missingCommandsLine,
  numberOrText,
  padBytes,
  runtimeClosureError,
  touch,
  writeAtomic,
} from './lib/pipeline/orchestrator.mts'
import type { ChildRun } from './lib/pipeline/orchestrator.mts'
import { appendText, createPipelineLog, stripAnsi } from './lib/pipeline/pipeline-log.mts'
import { canLaunchNow, resolveIssueFacts, resolutionText } from './lib/pipeline/pipeline-resolution.mts'
import { runStamp } from './lib/pipeline/pipeline-status.mts'
import { stateReadFirst } from './lib/state.mts'
import { holdRecentlyActive } from './lib/work-status-hold.mts'

const SCRIPT_DIR = import.meta.dirname

/** Segundos entre refrescos del scheduler y del monitoreo. */
export const MONITOR_INTERVAL = 10

export interface ParallelPipelineDeps {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Ruta con que se muestra el script en el mensaje de uso. */
  scriptPath: string
  out: (text: string) => void
  err: (text: string) => void
  /** `git` y `gh`. */
  run: Run
  hasCommand: (command: string) => boolean
  now: () => Date
  /** Espera del escalonado y de los refrescos; por defecto duerme de verdad. */
  sleep?: (seconds: number) => Promise<void>
  /** Carpeta de los pipelines hijos; por defecto, la de este script. */
  scriptsDir?: string
}

/** Un issue del lote tal como lo leen los mods en `pipeline-status-parallel.json`. */
export interface ParallelEntry {
  issue: string
  /** `tdd` o `tooling`; vacio si se salto antes de enrutarse. */
  pipeline: string
  /** `pendiente`, `en-curso`, `terminado`, `fallido`, `saltado` o `aplazado`. */
  status: string
  pr: string
  started: string
  finished: string
  detail: string
}

export interface ParallelStatusInput {
  started: string
  state: string
  stopRequested: boolean
  log: string
  entries: readonly ParallelEntry[]
}

const numberOrNull = (text: string): number | string | null => (text === '' ? null : numberOrText(text))

/** `pipeline-status-parallel.json`: como el del lote sequential, sin `current` y con `terminado`. */
export function renderParallelStatus(input: ParallelStatusInput): string {
  const issues: Json[] = input.entries.map((entry) => {
    const detail = entry.detail.replace(/[\t\n]/g, ' ')
    return {
      issue: numberOrText(entry.issue),
      pipeline: entry.pipeline === '' ? null : entry.pipeline,
      status: entry.status,
      pr: numberOrNull(entry.pr),
      started: numberOrNull(entry.started),
      finished: numberOrNull(entry.finished),
      detail: detail === '' ? null : detail,
    }
  })
  const value: Json = {
    pipeline: 'parallel',
    started: input.started,
    state: input.state,
    stop_requested: input.stopRequested,
    log: input.log,
    issues,
  }
  return `${dump(value, 2)}\n`
}

/** Texto con que Python imprime un valor JSON en el lector del status (`print(v or '-')`). */
function pythonText(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return '-'
  if (Array.isArray(value) && value.length === 0) return '-'
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return '-'
  if (value === true) return 'True'
  if (typeof value === 'string') return value.replace(/\n+$/, '')
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Lector de un status por issue (`pipeline-status-*.json`), canonico primero y legacy despues.
 * Cada campo ausente, vacio o ilegible se lee `-`.
 */
export function statusReader(file: string, env: NodeJS.ProcessEnv): { field: (name: string) => string; agent: (agent: string, name: string) => string } {
  let document: Record<string, unknown> | null | undefined
  const path = stateReadFirst(file, undefined, env)
  try {
    document = path === null ? undefined : asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    document = undefined
  }
  return {
    field: (name) => (document === undefined || document === null ? '-' : pythonText(document[name] ?? '-')),
    agent: (agent, name) => {
      const agents = document === undefined || document === null ? null : asObject(document.agents ?? {})
      const fields = agents === null ? null : asObject(agents[agent] ?? {})
      return fields === null ? '-' : pythonText(fields[name] ?? '-')
    },
  }
}

/** Nombres de los status por issue que borra la limpieza final (`pipeline-status-*-<issue>.json`). */
export function issueStatusFiles(dir: string, issue: string): string[] {
  const prefix = 'pipeline-status-'
  const suffix = `-${issue}.json`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length)
    .map((name) => join(dir, name))
    .filter((path) => isFile(path))
}

interface Slot {
  issue: string
  script: string
  isProjection: boolean
  run: ChildRun | null
  statusFile: string
  issueLog: string
  startTime: number
  deferred: boolean
}

const sleepFor = (seconds: number): Promise<void> => new Promise((done) => setTimeout(done, seconds * 1000))

/** Corre el lote y devuelve su codigo de salida. */
export async function parallelPipeline(deps: ParallelPipelineDeps): Promise<number> {
  const { env, out, err, now } = deps
  const sleep = deps.sleep ?? sleepFor
  const scriptsDir = deps.scriptsDir ?? SCRIPT_DIR
  const { red, green, yellow, blue, cyan, bold, reset } = COLOR
  const epoch = (): number => Math.floor(now().getTime() / 1000)

  const closureError = runtimeClosureError(SCRIPT_DIR)
  if (closureError !== null) {
    err(closureError)
    return 1
  }
  const timestamp = runStamp(now())

  // --- Argumentos ---
  const argv = [...deps.argv]
  if (argv.length === 0) {
    out(`Uso: ${deps.scriptPath} [--pipeline tdd|tooling] <issue1> <issue2> ... [--max-parallel N] [--keep-status]\n`)
    out("  --pipeline TYPE    Forzar pipeline: 'tdd' o 'tooling' (sin flag: enruta por label tipo:*)\n")
    out('  issue1 ...         Numeros de issues a procesar en paralelo\n')
    out('  --max-parallel N   Limitar a N pipelines simultaneos (por defecto: sin limite)\n')
    out('  --stagger S        Segundos entre lanzamientos (por defecto: 30; 0 = sin espera)\n')
    out('  --keep-status      No borrar los archivos status-N.json al terminar\n')
    return 1
  }
  let requested: string[] = []
  let maxParallelText = '0'
  let keepStatus = false
  let override = ''
  let stagger = 30
  while (argv.length > 0) {
    const arg = argv[0] ?? ''
    if (arg === '--pipeline') {
      if (argv.length < 2) {
        out('Falta el valor de --pipeline\n')
        return 1
      }
      const value = argv[1] ?? ''
      if (value !== 'tdd' && value !== 'tooling') {
        out(`Pipeline desconocido: ${value}. Usa 'tdd' o 'tooling'\n`)
        return 1
      }
      override = value
      argv.splice(0, 2)
    } else if (arg === '--max-parallel') {
      if (argv.length < 2) {
        out('Falta el valor de --max-parallel\n')
        return 1
      }
      maxParallelText = argv[1] ?? ''
      argv.splice(0, 2)
    } else if (arg === '--stagger') {
      if (argv.length < 2) {
        out('Falta el valor de --stagger\n')
        return 1
      }
      const value = argv[1] ?? ''
      if (!/^[0-9]+$/.test(value)) {
        out(`--stagger debe ser un entero >= 0 (recibido: '${value}')\n`)
        return 1
      }
      stagger = Number(value)
      argv.splice(0, 2)
    } else if (arg === '--keep-status') {
      keepStatus = true
      argv.shift()
    } else if (/^[0-9,]/.test(arg)) {
      // Acepta "42 43" y "42,43,44".
      requested.push(...arg.split(/[,\s]+/).filter((issue) => issue.length > 0))
      argv.shift()
    } else {
      out(`Argumento desconocido: ${arg}\n`)
      return 1
    }
  }
  // Un valor no entero se comporta como sin limite.
  const maxParallel = /^-?[0-9]+$/.test(maxParallelText.trim()) ? Number(maxParallelText) : 0
  if (requested.length === 0) {
    out(`${red}${bold}✗ No se especificaron issues.${reset}\n`)
    return 1
  }

  // --- Repo consumidor ---
  const top = deps.run('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd, env })
  if (top.status !== 0) {
    out('No estás en un repositorio git\n')
    return 1
  }
  const root = resolve(top.stdout.replace(/\n+$/, ''))
  if (isFile(join(root, '.claude-plugin', 'plugin.json'))) {
    err('ERROR: parallel-pipeline.mts es del plugin publicado y solo aplica al consumidor.\n')
    err('Estás en el repo de Mefisto. Los pipelines internos no soportan paralelismo aún;\n')
    err('trabaja los issues de Mefisto secuencialmente con /mefisto-tooling.\n')
    return 1
  }
  // Todos los issues se consultan en el repo actual: uno que no exista aqui queda UNKNOWN y se salta.

  const stateDir = nonEmpty(env.MEFISTO_STATE_DIR) ?? join(root, '.mefisto', 'pipeline')
  const legacyStateDir = nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(root, '.claude', 'pipeline')
  const stateEnv = { MEFISTO_STATE_DIR: stateDir, MEFISTO_LEGACY_STATE_DIR: legacyStateDir }
  // Lo que los pipelines bash exportaban y hereda cada pipeline hijo.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...stateEnv,
    MEFISTO_AGENT_PACKAGE_ROOT: nonEmpty(env.MEFISTO_AGENT_PACKAGE_ROOT) ?? realpathSync.native(join(SCRIPT_DIR, '..')),
    MEFISTO_RUNTIME_LIB_DIR: runtimeLibDir(env),
  }
  const signalFile = batchStopPath(root)
  const stopRequested = (): boolean => isFile(signalFile)

  // --- Log y estado del lote ---
  const logDir = join(stateDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, `parallel-${timestamp}.log`)
  touch(logFile)
  const log = createPipelineLog({ logFile: () => logFile, out, now, glyphs: ORCHESTRATOR_GLYPHS })
  const statusFile = join(stateDir, 'pipeline-status-parallel.json')

  // events.log del checkout: el mismo que escriben los pipelines hijos. Lo anterior al arranque es
  // de corridas pasadas: un hold colgado de una corrida interrumpida no debe frenar esta cola.
  const eventsLog = join(stateDir, 'events.log')
  const legacyEventsLog = join(legacyStateDir, 'events.log')
  touch(eventsLog)
  const eventsFrom = lineCount(eventsLog)
  const legacyEventsFrom = isFile(legacyEventsLog) ? lineCount(legacyEventsLog) : 0
  const holdActive = (): boolean =>
    holdRecentlyActive(eventsLog, now(), eventsFrom) ||
    (isFile(legacyEventsLog) && holdRecentlyActive(legacyEventsLog, now(), legacyEventsFrom))
  const activeHoldStatus = (): string =>
    formatHoldStatus(eventsLog, now(), eventsFrom) ??
    (isFile(legacyEventsLog) ? formatHoldStatus(legacyEventsLog, now(), legacyEventsFrom) : null) ??
    ''

  const entries: ParallelEntry[] = []
  let batchState = 'running'
  let stopSeen = false
  const writeParallelStatus = (state?: string): void => {
    if (state !== undefined && state.length > 0) batchState = state
    if (entries.length === 0) return
    writeAtomic(
      statusFile,
      renderParallelStatus({ started: timestamp, state: batchState, stopRequested: stopSeen || stopRequested(), log: logFile, entries }),
    )
  }
  const findEntry = (issue: string): ParallelEntry | undefined => entries.find((entry) => entry.issue === issue)
  const markIssue = (issue: string, status: string, pr = '', detail = ''): void => {
    const entry = findEntry(issue)
    if (entry === undefined) return
    entry.status = status
    if (pr.length > 0) entry.pr = pr.slice(pr.lastIndexOf('/') + 1)
    entry.detail = detail
    // Los tiempos se fijan una sola vez: la recoleccion vuelve a marcar un issue ya cerrado.
    if (status === 'en-curso' && entry.started === '') entry.started = String(epoch())
    if ((status === 'terminado' || status === 'fallido') && entry.finished === '') entry.finished = String(epoch())
    writeParallelStatus()
  }

  const abort = (message: string): number => {
    const line = `\n${red}${bold}✗ ERROR FATAL: ${message}${reset}\n`
    out(line)
    // Como el `tee -a` del bash, el log recibe el error con color.
    log.append(line)
    out(`${yellow}Revisa el log: ${logFile}${reset}\n`)
    writeParallelStatus('failed')
    return 1
  }

  // --- Dependencias y runtime: se resuelven antes de consultar o lanzar issues ---
  const missing = missingCommandsLine(REQUIRED_COMMANDS, deps.hasCommand)
  if (missing !== null) {
    out(missing)
    return 1
  }
  const resolved = await resolveRuntime('', env, deps.hasCommand)
  if ('error' in resolved) {
    out(`${red}${bold}✗ No se pudo resolver el runtime activo: ${resolved.error.length > 0 ? resolved.error : 'motivo desconocido'}${reset}\n`)
    return 1
  }
  const runtime = resolved.runtime
  if (!(await runtimeCliAvailable(runtime, { env, hasCommand: deps.hasCommand }))) {
    out(`${red}${bold}✗ Dependencias faltantes: CLI del runtime '${runtime}'${reset}\n`)
    return 1
  }
  // Cada pipeline hijo hereda la misma resolucion para que el lote no diverja.
  childEnv.MEFISTO_RUNTIME = runtime
  const options = { cwd: root, env: childEnv }

  log.header('parallel-pipeline --- Procesamiento paralelo de issues')
  log.log(`Runtime: ${runtime}`)
  log.log(`Pipeline: ${override.length > 0 ? `${override} (override)` : 'automatico por label'}`)
  log.log(`Issues a procesar: ${requested.join(' ')}`)
  log.log(`Paralelismo maximo: ${maxParallel > 0 ? maxParallelText : 'sin limite'}`)
  log.log(`Log: ${logFile}`)
  log.log('Parada suave: /batch-stop deja de lanzar issues de la cola sin matar los ya en vuelo (issue #974)')

  // --- Pre-validacion: una sola consulta a gh por issue (estado, labels y tipo:projection) ---
  log.log('Verificando estado de los issues y resolviendo pipelines...')
  const slots: Slot[] = []
  for (const issue of requested) {
    const facts = resolveIssueFacts(issue, override, {
      run: (command, args, given) => deps.run(command, args, { ...options, ...given }),
      scriptsDir,
    })
    const blank = { pr: '', started: '', finished: '' }
    if (facts.state !== 'OPEN') {
      log.warn(`Issue #${issue} esta ${facts.state} --- saltando.`)
      entries.push({ issue, pipeline: '', status: 'saltado', detail: `esta ${facts.state}`, ...blank })
      continue
    }
    if (facts.resolution.kind === 'skip') {
      log.warn(`Issue #${issue} saltado (${facts.resolution.reason}) --- no se puede enrutar a un pipeline.`)
      entries.push({ issue, pipeline: '', status: 'saltado', detail: facts.resolution.reason, ...blank })
      continue
    }
    const script = resolutionText(facts.resolution)
    entries.push({ issue, pipeline: basename(script).includes('tooling') ? 'tooling' : 'tdd', status: 'pendiente', detail: '', ...blank })
    slots.push({ issue, script, isProjection: facts.isProjection, run: null, statusFile: '', issueLog: '', startTime: 0, deferred: false })
    log.log(`Issue #${issue} -> ${basename(script)}${facts.isProjection ? ' (read-side: se serializa con otras projections)' : ''}`)
  }

  writeParallelStatus('running')

  if (slots.length === 0) return abort('No hay issues validos para procesar.')

  requested = slots.map((slot) => slot.issue)
  const total = slots.length
  log.log(`${total} issue(s) valido(s): ${requested.join(' ')}`)

  const projections = slots.filter((slot) => slot.isProjection).length
  if (projections > 1) {
    log.warn(
      `${projections} issues tipo:projection detectados --- se serializaran entre si (comparten el worker de proyecciones del BC, MEF-ADR-0034).`,
    )
  }

  // --- Lanzamiento y lectura de los pipelines hijos ---
  const launched = (): Slot[] => slots.filter((slot) => slot.run !== null)
  const isAlive = (slot: Slot): boolean => slot.run?.alive() === true
  const runningCount = (): number => slots.filter(isAlive).length
  const projectionRunning = (): boolean => slots.some((slot) => slot.isProjection && isAlive(slot))

  const launchPipeline = (slot: Slot): void => {
    const name = basename(slot.script)
    const type = name.includes('tooling') ? 'tooling' : name.includes('iac') ? 'infra' : 'tdd'
    slot.statusFile = `pipeline-status-${type}-${slot.issue}.json`
    slot.issueLog = join(logDir, `parallel-issue-${slot.issue}-${timestamp}.log`)
    const issueLog = openSync(slot.issueLog, 'w')
    let run: ChildRun
    try {
      // En su propio grupo de procesos (POSIX), como un trabajo en segundo plano de bash: un Ctrl+C
      // corta el monitoreo pero no a los pipelines en vuelo.
      run = launchChild(slot.script, [slot.issue, '--status-file', slot.statusFile], {
        ...options,
        stdio: ['ignore', issueLog, issueLog],
        detached: process.platform !== 'win32',
        onLaunchError: (message) => appendText(slot.issueLog, `${message}\n`),
      })
    } finally {
      closeSync(issueLog)
    }
    slot.run = run
    slot.startTime = epoch()
    markIssue(slot.issue, 'en-curso')
    log.log(`Lanzado issue #${slot.issue} con ${name} (PID ${run.child.pid ?? ''}) -> ${slot.statusFile}`)
  }

  // Cierra los que ya murieron segun su status por corrida; el desenlace definitivo lo fija la recoleccion.
  const refreshParallelStatus = (): void => {
    for (const slot of launched()) {
      if (isAlive(slot)) continue
      if (findEntry(slot.issue)?.status !== 'en-curso') continue
      const status = statusReader(slot.statusFile, stateEnv)
      const state = status.field('state')
      if (state === 'completed') {
        const pr = status.field('pr')
        markIssue(slot.issue, 'terminado', pr === '-' ? '' : pr)
      } else if (state === 'failed') {
        markIssue(slot.issue, 'fallido', '', status.field('last_error'))
      }
    }
  }

  const printDashboard = (): void => {
    const nowSeconds = epoch()
    // Una vez por refresco: el events.log no cambia dentro del mismo dibujo.
    const holdStatus = activeHoldStatus()
    const row = (color: string, issue: string, label: string, time: string, agents: string): void =>
      out(`  ${color}${padBytes(issue, 6)}  ${padBytes(label, 14)}  ${padBytes(time, 8)}  ${agents}${reset}\n`)
    out(`\n${cyan}${bold}parallel-pipeline — ${total} issue(s) en proceso${reset}\n`)
    out(`${'-'.repeat(70)}\n`)
    out(`  ${bold}${padBytes('Issue', 6)}  ${padBytes('Stage', 14)}  ${padBytes('Tiempo', 8)}  Agentes${reset}\n`)
    out(`${'-'.repeat(70)}\n`)

    for (const slot of slots) {
      const issue = `#${slot.issue}`
      // Un aplazado ya no espera turno: nunca se lanza en esta corrida.
      if (slot.deferred) {
        row(yellow, issue, 'aplazado', '-', '')
        continue
      }
      // Sin lanzar: el scheduler le retiene el turno (--max-parallel o una projection viva).
      if (slot.run === null) {
        row(yellow, issue, 'en espera', '-', '')
        continue
      }
      const elapsed = nowSeconds - slot.startTime
      const time = `${Math.trunc(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s`
      const running = isAlive(slot)
      const status = statusReader(slot.statusFile, stateEnv)
      const stage = status.field('stage')
      const state = status.field('state')
      let agents = ''
      for (const [agent, short] of [
        ['test-writer', 'tw'],
        ['implementer', 'im'],
        ['reviewer', 'rv'],
      ] as const) {
        if (status.agent(agent, 'result') === 'passed') agents += `${short}:${status.agent(agent, 'duration')}s${short === 'rv' ? '' : ' '}`
      }

      let color: string = reset
      let label: string
      if (state === 'running' || (running && state === '-')) {
        color = blue
        label = stage
      } else if (state === 'completed') {
        color = green
        const pr = status.field('pr')
        label = pr === '-' ? 'completado' : `PR: ${pr}`
      } else if (state === 'failed') {
        color = red
        label = `ERROR: ${[...status.field('last_error')].slice(0, 35).join('')}`
      } else if (!running) {
        color = yellow
        label = 'terminado'
      } else {
        label = stage
      }
      // Una espera activa se muestra con etiqueta propia: 'en espera' ya nombra a quien espera turno.
      if (running && state !== 'completed' && state !== 'failed' && holdStatus.length > 0) {
        color = yellow
        label = 'espera/hold'
        agents = holdStatus
      }
      row(color, issue, [...label].slice(0, 14).join(''), time, agents)
    }
    out(`${'-'.repeat(70)}\n`)
  }

  // Consume la senal y deja aplazados los que seguian en cola; los ya lanzados siguen su curso.
  const deferPending = (pending: Slot[]): void => {
    rmSync(signalFile, { force: true })
    stopSeen = true
    for (const slot of pending) {
      slot.deferred = true
      markIssue(slot.issue, 'aplazado', '', 'parada solicitada; no se proceso en esta corrida')
    }
    writeParallelStatus()
  }

  // --- Scheduler: en cada pasada lanza los pendientes que ya pueden correr ---
  let pending = [...slots]
  let launchedAny = false
  while (pending.length > 0) {
    if (stopRequested()) {
      const count = pending.length
      deferPending(pending)
      pending = []
      log.warn(
        `Parada solicitada (${BATCH_STOP_SIGNAL}): ${count} issue(s) en cola quedan aplazados, sin lanzar ningun worktree. Los ya lanzados terminan su pipeline y abren su PR.`,
      )
      break
    }

    // Un limite de uso pone en espera a todos los que corren: lanzar mas solo multiplicaria los que
    // esperan. No es una parada: en cuanto se libera, la cola sigue sola.
    if (holdActive()) {
      printDashboard()
      out('\n')
      log.log(
        `Espera (hold) activa -- ${activeHoldStatus()}. ${pending.length} issue(s) en cola esperan a que se libere antes de lanzar el siguiente.`,
      )
      await sleep(MONITOR_INTERVAL)
      continue
    }

    refreshParallelStatus()
    const next: Slot[] = []
    for (const slot of pending) {
      if (canLaunchNow(maxParallel, runningCount(), slot.isProjection, projectionRunning())) {
        if (launchedAny && stagger > 0) {
          log.log(`Escalonado: esperando ${stagger}s antes del siguiente lanzamiento...`)
          await sleep(stagger)
        }
        launchPipeline(slot)
        launchedAny = true
      } else {
        next.push(slot)
      }
    }
    pending = next
    if (pending.length > 0) {
      printDashboard()
      out('\n')
      log.log(`${pending.length} issue(s) esperando turno. Actualizando en ${MONITOR_INTERVAL}s... (Ctrl+C para cancelar)`)
      await sleep(MONITOR_INTERVAL)
    }
  }

  // La senal pudo llegar con todo ya lanzado: se consume igual para no envenenar la corrida siguiente.
  if (stopRequested()) {
    rmSync(signalFile, { force: true })
    stopSeen = true
    writeParallelStatus()
    log.warn(
      `Parada solicitada (${BATCH_STOP_SIGNAL}): no quedaba ningun issue en cola por lanzar (todos ya estaban en vuelo). La senal se consumio igual, para no afectar la corrida siguiente.`,
    )
  }

  // --- Monitoreo ---
  if (launched().length > 0) log.log('Todos los pipelines lanzados. Monitoreando progreso (Ctrl+C para cancelar)...')
  else log.log('Ningun pipeline quedo en vuelo: no hay nada que monitorear.')
  out('\n')

  while (launched().length > 0) {
    const allDone = !launched().some(isAlive)
    refreshParallelStatus()
    printDashboard()
    if (allDone) break
    out('\n')
    log.log(`Actualizando en ${MONITOR_INTERVAL}s... (Ctrl+C para cancelar monitoreo)`)
    await sleep(MONITOR_INTERVAL)
  }

  // --- Recoleccion ---
  log.header('Recolectando resultados')
  const results: { result: string; pr: string; duration: string }[] = []
  let completed = 0
  let failed = 0
  for (const slot of slots) {
    if (slot.deferred || slot.run === null) {
      results.push({ result: 'aplazado (parada solicitada; no se proceso en esta corrida)', pr: '', duration: '-' })
      continue
    }
    const exitCode = await slot.run.done
    // Se mide hasta la recoleccion, no hasta que termino el proceso.
    const duration = `${epoch() - slot.startTime}s`
    const status = statusReader(slot.statusFile, stateEnv)
    if (exitCode === 0) {
      let prUrl = status.field('pr')
      if (prUrl === '-') prUrl = ''
      if (prUrl === '' && existsSync(slot.issueLog)) prUrl = firstPullRequestUrl(stripAnsi(readFileSync(slot.issueLog, 'utf8')))
      results.push({ result: 'completado', pr: prUrl, duration })
      markIssue(slot.issue, 'terminado', prUrl)
      completed++
    } else {
      let error = status.field('last_error')
      if (error === '-') error = `exit ${exitCode}`
      results.push({ result: `ERROR: ${error}`, pr: '', duration })
      markIssue(slot.issue, 'fallido', '', error)
      failed++
    }
  }

  // --- Resumen ---
  log.header('Resumen final')
  out('\n')
  out(`${bold}${padBytes('Issue', 10)}  ${padBytes('Estado', 50)}  ${padBytes('Duración', 10)}  PR${reset}\n`)
  out(`${'─'.repeat(78)}\n`)
  slots.forEach((slot, index) => {
    const { result, pr, duration } = results[index] ?? { result: '', pr: '', duration: '' }
    const color = result.startsWith('completado') ? green : result.startsWith('ERROR') ? red : yellow
    out(`${color}${padBytes(`#${slot.issue}`, 10)}  ${padBytes([...result].slice(0, 50).join(''), 50)}  ${padBytes(duration, 10)}  ${pr.length > 0 ? pr : '(sin PR)'}${reset}\n`)
  })

  const deferred = slots.filter((slot) => slot.deferred).map((slot) => slot.issue)
  out('\n')
  out(`  Total: ${total}  |  ${green}Completados: ${completed}${reset}  |  ${red}Fallidos: ${failed}${reset}  |  ${yellow}Aplazados: ${deferred.length}${reset}\n`)
  out(`  Log: ${logFile}\n`)
  out('\n')

  if (deferred.length > 0) {
    log.warn(
      `Parada solicitada: ${deferred.length} issue(s) quedaron aplazados en esta corrida. No es un fallo del lote: el exit code no cambia por esto y ningun worktree lanzado quedo a medio pipeline.`,
    )
    // Apunta al orquestador que se detuvo: proponer /sequential degradaria el lote a secuencial.
    out(`  Relanza los aplazados, en el mismo orden: ${bold}parallel-pipeline.mts ${deferred.join(' ')}${reset}\n`)
    out('\n')
  }

  out(`  ${yellow}Nota: los PRs NO se mergearon automáticamente.${reset}\n`)
  out(`  Para integrar a main usa: ${cyan}/merge <PR_NUM>${reset}\n`)
  out('\n')

  writeParallelStatus(deferred.length > 0 ? 'stopped' : 'completed')

  if (!keepStatus) {
    for (const issue of requested) {
      for (const dir of [stateDir, legacyStateDir]) {
        for (const file of issueStatusFiles(dir, issue)) rmSync(file, { force: true })
      }
    }
  }

  if (failed > 0) {
    log.warn(`Algunos issues tuvieron errores. Revisa el log: ${logFile}`)
    return 1
  }
  log.success(`parallel-pipeline completado. Log: ${logFile}`)
  return 0
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await parallelPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'parallel-pipeline.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
