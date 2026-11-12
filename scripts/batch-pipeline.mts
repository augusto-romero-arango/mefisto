// Ejecuta pipelines para multiples issues secuencialmente: pipeline -> PR -> merge con pr-sync ->
// siguiente issue.
//
// Uso:
//   batch-pipeline.mts 42 43 44                          enrutamiento automatico por label
//   batch-pipeline.mts --pipeline tooling 60 62 63       forzar pipeline tooling
//   batch-pipeline.mts --pipeline tdd 42 43              forzar pipeline tdd
//   batch-pipeline.mts 42 43 --stop-on-error             abortar en el primer fallo
//   MEFISTO_RUNTIME=<id> batch-pipeline.mts 42           fija el runtime cuando hay mas de un CLI
//                                                       instalado (MEF-ADR-0049/0050); cada eslabon lo hereda
//
// Sin --pipeline, cada issue se enruta por su label tipo:*: feature, refactor y projection van a
// tdd-pipeline, tooling a tooling-pipeline; infra o sin tipo se saltan con aviso.

import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import type { Run } from './lib/azure-cli.mts'
import { COLOR, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import { canonicalDependencies } from './lib/issue-dependencies.mts'
import { dump } from './lib/jq-values.mts'
import type { Json } from './lib/jq-values.mts'
import { fmtHoldDuration, holdNoteSuffix, holdSecondsInRange } from './lib/pipeline/agent-hold.mts'
import { runtimeCliAvailable } from './lib/pipeline/agent-runtime.mts'
import {
  BATCH_STOP_SIGNAL,
  ORCHESTRATOR_GLYPHS,
  REQUIRED_COMMANDS,
  batchStopPath,
  firstPullRequestUrl,
  isFile,
  lineCount,
  missingCommandsLine,
  numberOrText,
  padBytes,
  runTeed,
  runtimeClosureError,
  touch,
  writeAtomic,
} from './lib/pipeline/orchestrator.mts'
import { createPipelineLog, runLogged, stripAnsi } from './lib/pipeline/pipeline-log.mts'
import type { LoggedRun } from './lib/pipeline/pipeline-log.mts'
import { resolvePipelineWithState, resolutionText } from './lib/pipeline/pipeline-resolution.mts'
import { runStamp } from './lib/pipeline/pipeline-status.mts'

const SCRIPT_DIR = import.meta.dirname

export interface BatchPipelineDeps {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Ruta con que se muestra el script en el mensaje de uso. */
  scriptPath: string
  out: (text: string) => void
  err: (text: string) => void
  /** `git` y `gh` cuando su salida se lee. */
  run: Run
  /** `git` y `gh` cuando su salida va al log. */
  runLogged: LoggedRun
  hasCommand: (command: string) => boolean
  now: () => Date
  /** Carpeta de los pipelines hijos y de pr-sync; por defecto, la de este script. */
  scriptsDir?: string
}

/** Un issue del lote: el texto libre de su estado y su PR. */
export interface BatchEntry {
  issue: string
  value: string
  pr: string
}

export interface BatchTracker {
  entries: BatchEntry[]
  /** Issue en curso, o vacio. */
  current: string
  /** Corre tras cada cambio: reescribe el status del lote. */
  onChange: () => void
}

export function newBatchTracker(onChange: () => void = () => {}): BatchTracker {
  return { entries: [], current: '', onChange }
}

export function setStatus(tracker: BatchTracker, issue: string, value: string): void {
  if (value.startsWith('en-curso')) tracker.current = issue
  else if (tracker.current === issue) tracker.current = ''
  const entry = tracker.entries.find((candidate) => candidate.issue === issue)
  if (entry === undefined) tracker.entries.push({ issue, value, pr: '' })
  else entry.value = value
  tracker.onChange()
}

export function getStatus(tracker: BatchTracker, issue: string): string {
  return tracker.entries.find((entry) => entry.issue === issue)?.value ?? 'desconocido'
}

export function setPr(tracker: BatchTracker, issue: string, pr: string): void {
  const entry = tracker.entries.find((candidate) => candidate.issue === issue)
  if (entry === undefined) tracker.entries.push({ issue, value: 'pendiente', pr })
  else entry.pr = pr
  tracker.onChange()
}

export function getPr(tracker: BatchTracker, issue: string): string {
  return tracker.entries.find((entry) => entry.issue === issue)?.pr ?? ''
}

export const DEFERRED_STATUS = 'aplazado (parada solicitada; no se proceso en esta corrida)'

/**
 * Consume la senal y deja `aplazado` cada issue de `issues` desde `from`. Una parada pedida no es
 * un fallo: no toca contadores ni el codigo de salida.
 */
export function deferFromIndex(tracker: BatchTracker, issues: readonly string[], from: number, signalFile: string): void {
  rmSync(signalFile, { force: true })
  for (const issue of issues.slice(from)) setStatus(tracker, issue, DEFERRED_STATUS)
}

/** Estado normalizado que leen los mods desde el texto libre del tracker. */
export function normalizedStatus(value: string): string {
  if (value.startsWith('completado')) return 'mergeado'
  if (value.startsWith('ERROR')) return 'fallido'
  if (value.startsWith('aplazado')) return 'aplazado'
  if (value.startsWith('saltado')) return 'saltado'
  if (value.startsWith('en-curso')) return 'en-curso'
  return 'pendiente'
}

export interface BatchStatusInput {
  started: string
  state: string
  current: string
  stopRequested: boolean
  holdSeconds: number
  log: string
  entries: readonly BatchEntry[]
}

/** `pipeline-status-batch.json` (MEF-ADR-0055 decision 1): el texto libre de cada issue pasa a `detail`. */
export function renderBatchStatus(input: BatchStatusInput): string {
  const issues: Json[] = input.entries.map((entry) => {
    const status = normalizedStatus(entry.value)
    const detail = entry.value.replace(/^(ERROR|saltado): /, '')
    return {
      issue: numberOrText(entry.issue),
      status,
      pr: entry.pr === '' ? null : numberOrText(entry.pr),
      detail: detail === status ? null : detail,
    }
  })
  const value: Json = {
    pipeline: 'batch',
    started: input.started,
    state: input.state,
    current: input.current === '' ? null : numberOrText(input.current),
    stop_requested: input.stopRequested,
    hold_seconds: input.holdSeconds,
    log: input.log,
    issues,
  }
  return `${dump(value, 2)}\n`
}

const chomp = (text: string): string => text.replace(/\n+$/, '')

/** Corre el lote y devuelve su codigo de salida. */
export async function batchPipeline(deps: BatchPipelineDeps): Promise<number> {
  const { env, out, err, now } = deps
  const scriptsDir = deps.scriptsDir ?? SCRIPT_DIR
  const { red, green, yellow, bold, reset } = COLOR

  const closureError = runtimeClosureError(SCRIPT_DIR)
  if (closureError !== null) {
    err(closureError)
    return 1
  }
  const timestamp = runStamp(now())

  // --- Argumentos ---
  const argv = [...deps.argv]
  if (argv.length === 0) {
    out(`Uso: ${deps.scriptPath} [--pipeline tdd|tooling] <issue1> <issue2> ... [--stop-on-error]\n`)
    out("  --pipeline TYPE    Forzar pipeline: 'tdd' o 'tooling' (sin flag: enruta por label tipo:*)\n")
    out('  issue1 ...         Numeros de issues a procesar (en orden)\n')
    out('  --stop-on-error    Abortar en el primer fallo (por defecto: continuar)\n')
    return 1
  }
  const issues: string[] = []
  let stopOnError = false
  let override = ''
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
    } else if (arg === '--stop-on-error') {
      stopOnError = true
      argv.shift()
    } else if (/^[0-9]/.test(arg)) {
      issues.push(arg)
      argv.shift()
    } else {
      out(`Argumento desconocido: ${arg}\n`)
      return 1
    }
  }
  if (issues.length === 0) {
    out(`${red}${bold}✗ No se especificaron issues.${reset}\n`)
    return 1
  }

  // --- Repo consumidor ---
  const top = deps.run('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd, env })
  if (top.status !== 0) {
    out('No estás en un repositorio git\n')
    return 1
  }
  const root = resolve(chomp(top.stdout))
  if (isFile(join(root, '.claude-plugin', 'plugin.json'))) {
    err('ERROR: batch-pipeline.mts es del plugin publicado y solo aplica al consumidor.\n')
    err('Estás en el repo de Mefisto. Trabaja los issues internos secuencialmente con /mefisto-tooling.\n')
    return 1
  }

  const stateDir = nonEmpty(env.MEFISTO_STATE_DIR) ?? join(root, '.mefisto', 'pipeline')
  const legacyStateDir = nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(root, '.claude', 'pipeline')
  // Lo que los pipelines bash exportaban y heredan cada eslabon y pr-sync.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    MEFISTO_STATE_DIR: stateDir,
    MEFISTO_LEGACY_STATE_DIR: legacyStateDir,
    MEFISTO_AGENT_PACKAGE_ROOT: nonEmpty(env.MEFISTO_AGENT_PACKAGE_ROOT) ?? realpathSync.native(join(SCRIPT_DIR, '..')),
    MEFISTO_RUNTIME_LIB_DIR: runtimeLibDir(env),
  }
  const options = { cwd: root, env: childEnv }
  const signalFile = batchStopPath(root)
  const stopRequested = (): boolean => isFile(signalFile)

  // --- Log ---
  const logDir = join(stateDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, `batch-${timestamp}.log`)
  touch(logFile)
  const log = createPipelineLog({ logFile: () => logFile, out, now, glyphs: ORCHESTRATOR_GLYPHS })

  // events.log del checkout: el mismo que escriben los eslabones. Mientras uno espera (hold) sigue
  // bloqueado en su propia espera; al cerrarlo, el lote anota cuanto espero sin contarlo como fallo.
  mkdirSync(stateDir, { recursive: true })
  const eventsLog = join(stateDir, 'events.log')
  const legacyEventsLog = join(legacyStateDir, 'events.log')
  touch(eventsLog)
  let totalHoldSeconds = 0
  const holdSecondsSince = (issue: string, from: number, legacyFrom: number): number =>
    holdSecondsInRange(eventsLog, now(), from, issue) +
    (isFile(legacyEventsLog) ? holdSecondsInRange(legacyEventsLog, now(), legacyFrom, issue) : 0)

  let statusFile = ''
  let batchState = 'running'
  const tracker = newBatchTracker(() => writeBatchStatus())
  function writeBatchStatus(state?: string): void {
    if (state !== undefined && state.length > 0) batchState = state
    if (statusFile.length === 0) return
    writeAtomic(
      statusFile,
      renderBatchStatus({
        started: timestamp,
        state: batchState,
        current: tracker.current,
        stopRequested: stopRequested(),
        holdSeconds: totalHoldSeconds,
        log: logFile,
        entries: tracker.entries,
      }),
    )
  }

  const abort = (message: string): number => {
    const line = `\n${red}${bold}✗ ERROR FATAL: ${message}${reset}\n`
    out(line)
    appendFileSync(logFile, line)
    out(`${yellow}Revisa el log: ${logFile}${reset}\n`)
    writeBatchStatus('failed')
    return 1
  }

  let haveErrors = false
  const failIssue = (issue: string, message: string): void => {
    const line = `\n${red}${bold}✗ Issue #${issue}: ${message}${reset}\n`
    out(line)
    appendFileSync(logFile, line)
    setStatus(tracker, issue, `ERROR: ${message}`)
    haveErrors = true
  }

  /**
   * Compuerta de dependencias previa a cada eslabon (MEF-ADR-0007/0011): devuelve el motivo para
   * saltar el issue, o `null` si puede lanzarse. Una dependencia canonica esta satisfecha si quedo
   * completada en este lote o si en GitHub esta CLOSED (issue) o MERGED (PR). Con todas
   * satisfechas, un issue con `bloqueado` pierde el label.
   */
  const dependencyGate = (issue: string): string | null => {
    const ghText = (args: string[]): { ok: boolean; text: string } => {
      const result = deps.run('gh', args, options)
      return { ok: result.status === 0, text: result.stdout }
    }
    const body = ghText(['issue', 'view', issue, '--json', 'body', '-q', '.body'])
    const labels = ghText(['issue', 'view', issue, '--json', 'labels', '-q', '.labels | map(.name) | join("\n")'])
    const hasBlocked = labels.ok && chomp(labels.text).split('\n').includes('bloqueado')
    const dependencies = canonicalDependencies(body.ok ? chomp(body.text) : '')

    if (dependencies.length === 0) return hasBlocked ? 'bloqueado sin dependencias canonicas' : null

    for (const dependency of dependencies) {
      if (dependency === issue) continue
      const status = getStatus(tracker, dependency)
      if (status.startsWith('completado')) continue
      // Un 'saltado: issue CLOSED' de este lote sigue satisfecho: GitHub decide antes que el motivo.
      let stateText = ''
      const asIssue = ghText(['issue', 'view', dependency, '--json', 'state', '-q', '.state'])
      stateText += asIssue.text
      if (!asIssue.ok) stateText += ghText(['pr', 'view', dependency, '--json', 'state', '-q', '.state']).text
      let state = chomp(stateText)
      if (state.length === 0) state = 'no consultable'
      if (state === 'CLOSED' || state === 'MERGED') continue
      return status.startsWith('saltado') || status.startsWith('ERROR')
        ? `depende de #${dependency} (fallido en este batch)`
        : `depende de #${dependency} (${state})`
    }

    if (hasBlocked) {
      if (deps.runLogged('gh', ['issue', 'edit', issue, '--remove-label', 'bloqueado'], logFile, options) === 0) {
        log.log(`Issue #${issue}: dependencias resueltas, se quito el label 'bloqueado'`)
      } else {
        log.warn(`Issue #${issue}: no se pudo quitar el label 'bloqueado' (continuando)`)
      }
    }
    return null
  }

  for (const issue of issues) setStatus(tracker, issue, 'pendiente')

  // --- Dependencias y runtime: fallan antes de tocar ningun issue ---
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
  // Sin herencia explicita del CLI no se comprueba que exista: se verifica aqui y no en el primer eslabon.
  if (!(await runtimeCliAvailable(runtime, { env, hasCommand: deps.hasCommand }))) {
    out(`${red}${bold}✗ Dependencias faltantes: CLI del runtime '${runtime}'${reset}\n`)
    return 1
  }
  // Cada eslabon y pr-sync heredan el runtime ya resuelto en vez de volver a detectarlo.
  childEnv.MEFISTO_RUNTIME = runtime

  mkdirSync(stateDir, { recursive: true })
  statusFile = join(stateDir, 'pipeline-status-batch.json')
  writeBatchStatus('running')

  log.header('batch-pipeline --- Procesamiento secuencial de issues')
  log.log(`Runtime: ${runtime}`)
  log.log(`Pipeline: ${override.length > 0 ? `${override} (override)` : 'automatico por label'}`)
  log.log(`Issues a procesar: ${issues.join(' ')}`)
  log.log(`Modo en error: ${stopOnError ? 'detener' : 'continuar'}`)
  log.log(`Log: ${logFile}`)
  log.log('Parada suave: /batch-stop detiene el batch tras el eslabon en curso (issue #974)')

  // --- Loop principal ---
  let completed = 0
  let failed = 0
  const total = issues.length
  let queue = [...issues]

  // Parada suave, momento 1: la senal ya estaba antes del primer eslabon.
  if (stopRequested()) {
    log.warn(`Parada solicitada (${BATCH_STOP_SIGNAL}) antes de arrancar el primer eslabon: ningun issue se procesa en esta corrida.`)
    deferFromIndex(tracker, issues, 0, signalFile)
    queue = []
  }

  for (const issue of queue) {
    const current = completed + failed + 1
    log.header(`Issue #${issue} (${current}/${total})`)

    const { state, resolution } = resolvePipelineWithState(issue, override, {
      run: (command, args, given) => deps.run(command, args, { ...options, ...given }),
      scriptsDir,
    })
    if (state !== 'OPEN') {
      log.log(`Issue #${issue} esta ${state} --- saltando.`)
      setStatus(tracker, issue, `saltado: issue ${state}`)
      failed++
      continue
    }
    if (resolution.kind === 'skip') {
      log.warn(`Issue #${issue} saltado (${resolution.reason}) --- no se puede enrutar a un pipeline.`)
      setStatus(tracker, issue, `saltado: ${resolution.reason}`)
      failed++
      continue
    }
    // Un salto por dependencias no toca los errores del lote ni --stop-on-error.
    const gateReason = dependencyGate(issue)
    if (gateReason !== null) {
      log.warn(`Issue #${issue} saltado (${gateReason}) --- no se lanza.`)
      setStatus(tracker, issue, `saltado: ${gateReason}`)
      failed++
      continue
    }

    const script = resolutionText(resolution)
    setStatus(tracker, issue, 'en-curso')

    // --- Stage 1: pipeline del issue ---
    log.log(`Ejecutando ${basename(script)} para issue #${issue}...`)
    const issueLog = join(logDir, `batch-issue-${issue}-${timestamp}.log`)
    writeFileSync(issueLog, '')

    // El hold se cuenta desde aqui y solo bajo cabeceras de sesion de este issue: otra corrida del
    // mismo checkout intercalada en events.log no le regala sus esperas.
    const holdFrom = lineCount(eventsLog)
    const holdFromLegacy = isFile(legacyEventsLog) ? lineCount(legacyEventsLog) : 0

    const teeOptions = { ...options, onOutput: out }
    const pipelineExit = await runTeed(script, [issue], issueLog, teeOptions)
    appendFileSync(logFile, stripAnsi(readFileSync(issueLog, 'utf8')))

    // La espera es una nota anexa a cualquier desenlace: nunca cambia fallos ni codigo de salida.
    const issueHoldSeconds = holdSecondsSince(issue, holdFrom, holdFromLegacy)
    const heldNote = holdNoteSuffix(issueHoldSeconds)
    if (issueHoldSeconds > 0) {
      totalHoldSeconds += issueHoldSeconds
      log.log(`Issue #${issue}: ${fmtHoldDuration(issueHoldSeconds)} en espera (hold) durante este eslabon -- no cuenta como fallo`)
    }

    if (pipelineExit !== 0) {
      failIssue(issue, `pipeline fallo (exit ${pipelineExit}). Log: ${issueLog}${heldNote}`)
      failed++
      if (stopOnError) return abort(`Detenido por --stop-on-error en issue #${issue}`)
      continue
    }

    // --- Stage 2: URL del PR que imprime el pipeline ---
    const prUrl = firstPullRequestUrl(stripAnsi(readFileSync(issueLog, 'utf8')))
    if (prUrl.length === 0) {
      failIssue(issue, `no se pudo extraer la URL del PR del output. Log: ${issueLog}${heldNote}`)
      failed++
      if (stopOnError) return abort(`Detenido por --stop-on-error en issue #${issue}`)
      continue
    }
    const prNumber = /[0-9]+$/.exec(prUrl)?.[0] ?? ''
    setPr(tracker, issue, prNumber)
    log.success(`Pipeline completado → PR #${prNumber} (${prUrl})`)

    // --- Stage 3: merge del PR ---
    log.log(`Mergeando PR #${prNumber} a main...`)
    const syncExit = await runTeed(join(scriptsDir, 'pr-sync.mts'), [prNumber, '--merge'], issueLog, teeOptions)
    // El log del issue se vuelve a anexar entero: la salida del pipeline queda dos veces en el del lote.
    appendFileSync(logFile, stripAnsi(readFileSync(issueLog, 'utf8')))

    if (syncExit !== 0) {
      failIssue(issue, `merge del PR #${prNumber} falló (exit ${syncExit}). Log: ${issueLog}${heldNote}`)
      failed++
      if (stopOnError) return abort(`Detenido por --stop-on-error en issue #${issue}`)
      continue
    }

    // --- Stage 4: main local al dia para el siguiente issue ---
    log.log('Actualizando main local...')
    if (deps.runLogged('git', ['pull', 'origin', 'main'], logFile, options) !== 0) {
      log.warn('git pull origin main falló (continuando)')
    }

    setStatus(tracker, issue, `completado (PR #${prNumber} mergeado)${heldNote}`)
    completed++
    log.success(`Issue #${issue} completado y mergeado${heldNote}`)

    // Parada suave, momento 2: el unico punto seguro de la cadena, con el PR ya mergeado. Un
    // eslabon fallido nunca llega aqui.
    if (stopRequested()) {
      if (current < total) {
        log.warn(`Parada solicitada (${BATCH_STOP_SIGNAL}) tras completar #${issue}: los eslabones restantes quedan aplazados, sin arrancar ningun worktree.`)
      } else {
        log.warn(
          `Parada solicitada (${BATCH_STOP_SIGNAL}) tras completar #${issue}, que era el ultimo eslabon del batch: no quedaba ninguno por arrancar. La senal se consumio igual, para no afectar la corrida siguiente.`,
        )
      }
      deferFromIndex(tracker, issues, current, signalFile)
      break
    }
  }

  // --- Resumen ---
  log.header('Resumen')
  out('\n')
  out(`${bold}${padBytes('Issue', 10)} ${padBytes('PR', 8)} ${padBytes('Estado', 45)}${reset}\n`)
  out(`${'─'.repeat(65)}\n`)
  for (const issue of issues) {
    const pr = getPr(tracker, issue)
    const status = getStatus(tracker, issue)
    const color = status.startsWith('completado') ? green : status.startsWith('ERROR') ? red : yellow
    out(`${color}${padBytes(`#${issue}`, 10)} ${padBytes(pr.length > 0 ? pr : '(n/a)', 8)} ${padBytes(status, 45)}${reset}\n`)
  }

  const deferred = issues.filter((issue) => getStatus(tracker, issue).startsWith('aplazado'))
  out('\n')
  out(`  Total: ${total}  |  ${green}Completados: ${completed}${reset}  |  ${red}Fallidos: ${failed}${reset}  |  ${yellow}Aplazados: ${deferred.length}${reset}\n`)
  out(`  Log: ${logFile}\n`)
  // Una espera nunca es un fallo ni un aplazado: se informa aparte.
  if (totalHoldSeconds > 0) {
    out(
      `  ${yellow}En espera (hold) durante el batch: ${fmtHoldDuration(totalHoldSeconds)}${reset} -- por limite de uso o caida del proveedor, no cuenta como fallo\n`,
    )
  }
  out('\n')

  const dependencySkipped = issues.filter((issue) => {
    const status = getStatus(tracker, issue)
    return status.startsWith('saltado: depende de') || status.startsWith('saltado: bloqueado sin dependencias')
  })
  if (dependencySkipped.length > 0) {
    log.warn(`${dependencySkipped.length} issue(s) saltados por dependencias no satisfechas. No cambia el exit code por si solo.`)
    out(`  Relanza tras resolver sus dependencias: ${bold}/sequential ${dependencySkipped.join(' ')}${reset}\n`)
    out('\n')
  }

  if (deferred.length > 0) {
    log.warn(
      `Parada solicitada: ${deferred.length} issue(s) quedaron aplazados en esta corrida. No es un fallo del batch: el exit code no cambia por esto y nada quedo a medio pipeline.`,
    )
    out(`  Relanza los aplazados, en el mismo orden: ${bold}/sequential ${deferred.join(' ')}${reset}\n`)
    out('\n')
  }

  writeBatchStatus(deferred.length > 0 ? 'stopped' : 'completed')

  if (haveErrors) {
    log.warn(`Algunos issues tuvieron errores. Revisa el log: ${logFile}`)
    return 1
  }
  log.success(`batch-pipeline completado. Log: ${logFile}`)
  return 0
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await batchPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'batch-pipeline.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
