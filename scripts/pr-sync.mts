// Sincroniza las ramas de PRs abiertos con main y, si se pide, los mergea.
//
// Uso:
//   pr-sync.mts 40 41 42               sincroniza los PRs en orden
//   pr-sync.mts 40 41 42 --merge       sincroniza y mergea cada uno
//   pr-sync.mts --all                  todos los PRs abiertos
//   pr-sync.mts --all --merge          sincroniza y mergea todos
//
// Por PR: fetch, worktree temporal, merge de origin/main (el implementer resuelve los conflictos),
// build y tests (el implementer arregla una vez lo que falle), push con --force-with-lease y, con
// --merge, merge en GitHub y desbloqueo de los issues dependientes.
//
// Entorno: MEFISTO_RUN_AGENT_BIN (runner alterno), MEFISTO_HOLD_MAX_SECONDS (techo de la espera
// ante limite de uso o proveedor caido, 21600) y MEFISTO_HOLD_PROBE_SECONDS (300), MEF-ADR-0051.

import type { ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { resolveModel } from '../src/runtime/lib/mefisto-models.mts'
import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import { rawField } from './lib/azure-cli.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions } from './lib/cli.mts'
import { harnessConfigEnv, loadHarnessConfig } from './lib/harness-config.mts'
import type { HarnessConfig } from './lib/harness-config.mts'
import { dump } from './lib/jq-values.mts'
import { runtimeSupportsResume } from './lib/pipeline/agent-runtime.mts'
import { resolveRunnerCommand, runAgentWithPolicy, runnerProcess } from './lib/pipeline/pipeline-agent-run.mts'
import type { AgentRunEvent, LaunchRunner } from './lib/pipeline/pipeline-agent-run.mts'
import { PipelineExit, runPipeline } from './lib/pipeline/pipeline-exit.mts'
import type { SignalSource } from './lib/pipeline/pipeline-exit.mts'
import { createPipelineLog, lastLines, runLogged } from './lib/pipeline/pipeline-log.mts'
import type { LogGlyphs, LoggedRun, PipelineLog } from './lib/pipeline/pipeline-log.mts'
import { localIsoSeconds, noHold, runStamp, statusIsActive } from './lib/pipeline/pipeline-status.mts'
import type { HoldState } from './lib/pipeline/pipeline-status.mts'
import { mergePrWithRetry, orEcho, rawFieldOr, unblockDependentIssues } from './lib/pipeline/pr-sync-github.mts'
import type { PrSyncGithubTools } from './lib/pipeline/pr-sync-github.mts'
import { resolvePipelineAgentEffort } from './lib/pipeline/stage-models.mts'
import { runTestsProjects } from './lib/pipeline/test-results.mts'
import type { DotnetResult, RunDotnet } from './lib/pipeline/test-results.mts'
import { statePath } from './lib/state.mts'
import { runProgram } from './warnings-diff.mts'

const SCRIPT_DIR = import.meta.dirname

export const PR_SYNC_GLYPHS: LogGlyphs = { success: '✓', warn: '⚠', error: '✗', rule: '──' }

/** Prompt de la sonda que reanuda la sesion truncada: pr-sync no tiene resumen de stage. */
export const PR_SYNC_RESUME_PROMPT = 'Continue the same stage and complete its work.'

const TAIL_RUNNER_LINES = 20

export interface PrSyncDeps {
  argv: string[]
  /** Directorio desde el que se lanza. */
  cwd: string
  env: NodeJS.ProcessEnv
  /** Ruta con que se muestra el script en el mensaje de uso. */
  scriptPath: string
  out: (text: string) => void
  err: (text: string) => void
  /** `git` y `gh` cuando su salida se lee. */
  run: Run
  /** `git`, `gh` y la limpieza de worktrees cuando su salida va al log. */
  runLogged: LoggedRun
  /** `dotnet build` y `dotnet test`, con stdout y stderr juntos; por defecto corre el real. */
  runDotnet?: RunDotnet
  hasCommand: (command: string) => boolean
  now: () => Date
  /** Esperas del hold y de los reintentos de merge; por defecto duerme de verdad. */
  sleep?: (seconds: number) => Promise<void>
  /** Sustituye al proceso del runner; sin el se lanza el runner neutral como proceso hijo. */
  launchRunner?: LaunchRunner
  signals?: SignalSource
  exit?: (code: number) => void
  /** Carpeta donde nacen los worktrees temporales y los temporales de la corrida. */
  tempRoot?: string
}

export function mergePrompt(projectName: string, conflictFiles: string): string {
  return `Estás en el directorio raíz del proyecto ${projectName}.

Hay conflictos de merge con la rama main en los siguientes archivos:
${conflictFiles}

Resuelve los conflictos manteniendo tanto la funcionalidad nueva (de esta rama) como la existente (de main).
Después de resolver cada archivo, haz git add del archivo.
Cuando todos estén resueltos, haz git commit para completar el merge.
NO elimines código de ninguna de las dos ramas — integra ambos cambios.`
}

export function fixPrompt(projectName: string, failedTests: string): string {
  return `Estás en el directorio raíz del proyecto ${projectName}.

Después de hacer merge con main, los siguientes tests fallan:
${failedTests}

Arregla el código en src/ para que todos los tests pasen.
NO modifiques los tests.
Cuando termines, haz commit de los cambios.`
}

/**
 * Las primeras 10 lineas de la salida de tests que nombran un fallo, o `null` si ninguna lo hace:
 * en ese caso el bash moria por `pipefail` y este port lo conserva.
 */
export function failedTestLines(output: string): string | null {
  const lines = output.split('\n').filter((line) => /Failed|Con error/.test(line))
  return lines.length === 0 ? null : lines.slice(0, 10).join('\n')
}

/** `printf '%-<width>s'` de bash: rellena por bytes, no por caracteres, y nunca recorta. */
export function padBytes(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - Buffer.byteLength(text)))
}

export interface SummaryRow {
  pr: string
  branch: string
  status: string
}

/** Tabla del resumen final, con el color de cada estado. */
export function summaryTable(rows: readonly SummaryRow[]): string {
  const lines = [`${COLOR.bold}${padBytes('PR', 8)} ${padBytes('Rama', 50)} ${padBytes('Estado', 15)}${COLOR.reset}`, '─'.repeat(77)]
  for (const row of rows) {
    let color: string = COLOR.yellow
    if (row.status === 'mergeado') color = COLOR.green
    else if (row.status === 'sincronizado' || row.status === 'al día') color = COLOR.blue
    lines.push(`${color}${padBytes(`#${row.pr}`, 8)} ${padBytes(row.branch, 50)} ${padBytes(row.status, 15)}${COLOR.reset}`)
  }
  return `${lines.join('\n')}\n`
}

export interface PrStatus {
  pr: string
  title: string
  /** Vacio se escribe `null`. */
  runtime: string
  stage: string
  state: string
  log: string
  /** Vacio se escribe `null`. */
  lastError: string
  hold: HoldState
}

/**
 * Texto de `pipeline-status-pr-sync-<pr>.json`, como lo imprimia `jq -n`. `issue` repite el
 * numero de PR: con `pipeline` forma la clave con que los lectores deduplican las corridas.
 */
export function prStatusText(status: PrStatus, started: string, updated: string): string {
  const value = {
    issue: status.pr,
    pr: status.pr,
    title: status.title,
    pipeline: 'pr-sync',
    variant: null,
    runtime: status.runtime.length > 0 ? status.runtime : null,
    started,
    stage: status.stage,
    state: status.state,
    updated,
    log: status.log,
    last_error: status.lastError.length > 0 ? status.lastError : null,
    hold: {
      cause: status.hold.cause,
      next_probe: status.hold.nextProbe,
      ceiling_seconds: status.hold.ceilingSeconds,
      accumulated_seconds: status.hold.accumulatedSeconds,
    },
  }
  return `${dump(value, 2)}\n`
}

/** Escribe el status del PR conservando el `started` de la primera escritura. */
export function writePrStatusFile(file: string, status: PrStatus, now: Date): void {
  let started = ''
  try {
    started = rawField(JSON.parse(readFileSync(file, 'utf8')) as unknown, 'started')
  } catch {
    started = ''
  }
  const updated = localIsoSeconds(now)
  writeFileSync(file, prStatusText(status, started.length > 0 ? started : updated, updated))
}

function chomp(text: string): string {
  return text.replace(/\n+$/, '')
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

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

/** `tail -n <count>` de un archivo; vacio si falta. */
function tailFile(file: string, count: number): string {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  if (content.length === 0) return ''
  return lastLines(content, count) + (content.endsWith('\n') ? '\n' : '')
}

/** Orden de `sort -n`: el numero inicial de cada linea y, si empatan, sus bytes. */
function sortNumeric(lines: readonly string[]): string[] {
  const key = (line: string): number => Number(/^[ \t]*(-?[0-9]+(?:\.[0-9]+)?)/.exec(line)?.[1] ?? 0)
  return [...lines].sort((a, b) => key(a) - key(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

export interface PrSyncAgentContext {
  runtime: string
  /** Vacio hereda el modelo. */
  model: string
  /** Vacio hereda el effort. */
  effort: string
  /** Donde quedan la salida del runner y el JSONL de cada intento. */
  logDir: string
  timestamp: string
  /** Carpeta de los prompts temporales. */
  tmpDir: string
  eventsLog: string
  log: PipelineLog
  launchRunner: LaunchRunner
  supportsResume: () => boolean | Promise<boolean>
  /** Recibe la espera en curso o la acumulada; el status del PR la publica. */
  setHold: (hold: HoldState) => void
  /** Reescribe el status del PR en curso con ese estado; fuera de un PR no hace nada. */
  writeStatus: (state: 'hold' | 'running') => void
  env: NodeJS.ProcessEnv
  now: () => Date
  sleep?: (seconds: number) => Promise<void>
}

/**
 * Invoca al agente con la politica de MEF-ADR-0051: ante limite de uso o proveedor caido espera
 * y reintenta, reanudando la sesion si el runtime sabe. `false` ante cualquier otro fallo o al
 * agotarse el techo de espera. El trabajo se juzga despues, con los conflictos o los tests.
 */
export async function runPrSyncAgent(
  label: string,
  agent: string,
  prompt: string,
  worktree: string,
  ctx: PrSyncAgentContext,
): Promise<boolean> {
  const { log } = ctx
  const logBase = join(ctx.logDir, `pr-sync-${label}-${ctx.timestamp}`)
  const runnerOutput = (attempt: number): string => `${logBase}-attempt-${attempt}.log`
  ctx.setHold(noHold())

  const launch: LaunchRunner = (args, outputFile) => {
    log.log(`Invocando ${agent} (modelo: ${ctx.model.length > 0 ? ctx.model : '<heredado>'})...`)
    return ctx.launchRunner(args, outputFile)
  }
  let ceilingReached = false
  const onEvent = (event: AgentRunEvent): void => {
    switch (event.kind) {
      case 'hold':
        log.warn(`${agent}: ${event.hold.cause ?? ''}. Esperando (hold) antes de reintentar (MEF-ADR-0051)...`)
        ctx.setHold(event.hold)
        ctx.writeStatus('hold')
        break
      case 'hold-ceiling':
        ceilingReached = true
        break
      case 'hold-waited':
        ctx.setHold(noHold(event.holdSeconds))
        log.log(`${agent}: espera de ${event.sleptSeconds}s cumplida, reintentando...`)
        ctx.writeStatus('running')
        break
      case 'resume-no-session':
        log.warn(`${agent}: terminal sin session_id; la sonda inicia de cero`)
        break
      case 'resume-unsupported':
        log.warn(`${agent}: runtime sin capacidad de reanudación; la sonda inicia de cero`)
        break
      default:
        break
    }
  }

  const outcome = await runAgentWithPolicy(
    {
      runtime: ctx.runtime,
      agentId: agent,
      worktree,
      prompt,
      promptFile: join(ctx.tmpDir, `${label}.prompt.md`),
      systemFile: join(ctx.tmpDir, `${label}.system.md`),
      resumePrompt: PR_SYNC_RESUME_PROMPT,
      resumePromptFile: (attempt) => join(ctx.tmpDir, `${label}-resume-${attempt}.prompt.md`),
      eventsFile: (attempt) => `${logBase}-attempt-${attempt}.events.jsonl`,
      runnerOutput,
      model: ctx.model,
      effort: ctx.effort,
      eventsLog: ctx.eventsLog,
    },
    { supportsResume: ctx.supportsResume },
    { launchRunner: launch, onEvent, env: ctx.env, now: ctx.now, ...(ctx.sleep === undefined ? {} : { sleep: ctx.sleep }) },
  )

  const seconds = outcome.attemptSeconds
  ctx.setHold(noHold(outcome.holdSeconds))
  if (outcome.failureType.length === 0) {
    log.log(`${agent} completado en ${seconds}s`)
    return true
  }
  if (ceilingReached) {
    log.warn(`${agent}: se agotó el techo de espera (MEFISTO_HOLD_MAX_SECONDS) tras ${seconds}s en el último intento`)
  } else {
    log.warn(`${agent} falló después de ${seconds}s`)
  }
  log.print(`\n${COLOR.red}── Últimas líneas del log de ${agent}:${COLOR.reset}\n`)
  log.print(tailFile(runnerOutput(outcome.attempts), TAIL_RUNNER_LINES))
  return false
}

/** `dotnet` en la raiz del consumidor, con stdout y stderr juntos en el orden en que se emiten. */
function dotnetIn(cwd: string, env: NodeJS.ProcessEnv, scratch: () => string): RunDotnet {
  return (args) => {
    const outputFile = join(scratch(), 'dotnet.log')
    const result = runProgram('dotnet', args, { cwd, env, outputFile })
    let output = ''
    try {
      output = readFileSync(outputFile, 'utf8')
    } catch {
      output = ''
    }
    return { status: result.status, output }
  }
}

/** Corre pr-sync y devuelve su codigo de salida. */
export async function prSync(deps: PrSyncDeps): Promise<number> {
  const { env, cwd, out, err, now } = deps
  const timestamp = runStamp(now())

  let runtimeDir: string
  try {
    runtimeDir = realpathSync.native(join(SCRIPT_DIR, '..', 'src', 'runtime'))
  } catch {
    err('ERROR: no se encontro src/runtime junto al paquete publicado\n')
    return 1
  }
  for (const library of ['mefisto-runtime.mts', 'mefisto-models.mts']) {
    if (!isFile(join(runtimeDir, 'lib', library))) {
      err(`ERROR: no se encontro ${library} en la clausura publicada\n`)
      return 1
    }
  }

  let config: HarnessConfig
  try {
    config = loadHarnessConfig(undefined, { cwd, warn: (message) => err(`${message}\n`) })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) err(`${error.message}\n`)
    return 1
  }

  if (deps.argv.length === 0) {
    out(`Uso: ${deps.scriptPath} [PR_NUM...] [--all] [--merge]\n`)
    out('  PR_NUM...   Números de PRs a sincronizar (en orden)\n')
    out('  --all       Sincronizar todos los PRs abiertos\n')
    out('  --merge     Mergear a main después de sincronizar\n')
    return 1
  }
  let prNums: string[] = []
  let doMerge = false
  let doAll = false
  for (const arg of deps.argv) {
    if (arg === '--merge') doMerge = true
    else if (arg === '--all') doAll = true
    else if (/^[0-9]/.test(arg)) prNums.push(arg)
    else {
      out(`Argumento desconocido: ${arg}\n`)
      return 1
    }
  }

  const top = deps.run('git', ['rev-parse', '--show-toplevel'], { cwd, env })
  if (top.status !== 0) {
    out('No estás en un repositorio git\n')
    return 1
  }
  const repoRoot = resolve(chomp(top.stdout))
  if (isFile(join(repoRoot, '.claude-plugin', 'plugin.json'))) {
    err('ERROR: scripts/pr-sync.mts es del plugin publicado y solo aplica al consumidor.\n')
    err('Estás en el repo de Mefisto. Para mergear PRs del plugin, usa /mefisto-merge.\n')
    return 1
  }

  const stateDir = nonEmpty(env.MEFISTO_STATE_DIR) ?? join(repoRoot, '.mefisto', 'pipeline')
  const stateEnv = {
    MEFISTO_STATE_DIR: stateDir,
    MEFISTO_LEGACY_STATE_DIR: nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(repoRoot, '.claude', 'pipeline'),
  }
  const state = (rel: string): string => statePath(rel, undefined, stateEnv)
  // Lo que el bash exportaba y heredan el runner, el agente y los CLIs.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...stateEnv,
    MEFISTO_AGENT_PACKAGE_ROOT: nonEmpty(env.MEFISTO_AGENT_PACKAGE_ROOT) ?? realpathSync.native(join(SCRIPT_DIR, '..')),
    MEFISTO_RUNTIME_LIB_DIR: runtimeLibDir(env),
    ...harnessConfigEnv(config),
  }
  const options: CommandOptions = { cwd: repoRoot, env: childEnv }
  const tempRoot = deps.tempRoot ?? realpathSync.native(tmpdir())
  const sleep = deps.sleep ?? ((seconds: number): Promise<void> => new Promise((done) => setTimeout(done, seconds * 1000)))

  let currentPr = ''
  let currentStage = ''
  let currentTitle = ''
  let runtime = ''
  let hold: HoldState = noHold()
  let logFile = ''
  let tmpDir = ''
  let runnerChild: ChildProcess | null = null

  const writePrStatus = (pr: string, stage: string, statusState: string, lastError = ''): void => {
    writePrStatusFile(
      state(`pipeline-status-pr-sync-${pr}.json`),
      { pr, title: currentTitle, runtime, stage, state: statusState, log: logFile, lastError, hold },
      now(),
    )
  }

  // Un PR que queda corriendo o en espera al salir (interrupcion, senal, fin abrupto) se marca
  // fallido; los ya cerrados no se tocan.
  const finalize = (): void => {
    if (currentPr.length > 0) {
      const file = join(stateDir, `pipeline-status-pr-sync-${currentPr}.json`)
      if (isFile(file) && statusIsActive(file)) {
        try {
          writePrStatus(currentPr, currentStage.length > 0 ? currentStage : 'sync', 'failed', 'pr-sync interrumpido')
        } catch {
          // Sin poder reescribir el status, la salida conserva su codigo.
        }
      }
    }
    if (tmpDir.length > 0) rmSync(tmpDir, { recursive: true, force: true })
  }

  const main = async (): Promise<number> => {
    const logDir = dirname(state(join('logs', '.state')))
    logFile = join(logDir, `pr-sync-${timestamp}.log`)
    closeSync(openSync(logFile, 'a'))
    const eventsLog = state('events.log')
    const log = createPipelineLog({ logFile: () => logFile, out, now, glyphs: PR_SYNC_GLYPHS })
    const fatal = (message: string): void => out(`${COLOR.red}${COLOR.bold}${PR_SYNC_GLYPHS.error} ${message}${COLOR.reset}\n`)
    const logged = (command: string, args: string[]): number | null => deps.runLogged(command, args, logFile, options)
    /** Comando cuya salida se necesita: si falla, pr-sync termina con su codigo, como `set -e`. */
    const required = (command: string, args: string[]): string => {
      const result = deps.run(command, args, options)
      if (result.stderr.length > 0) err(result.stderr)
      if (result.status !== 0) throw new PipelineExit(result.status ?? 1)
      return chomp(result.stdout)
    }

    log.header('pr-sync — Sincronización de PRs con main')
    log.log(`Log: ${logFile}`)

    const missing = ['gh', 'git', 'dotnet'].filter((command) => !deps.hasCommand(command))
    if (missing.length > 0) {
      fatal(`Dependencias faltantes:${missing.map((command) => ` ${command}`).join('')}`)
      return 1
    }

    const runner = resolveRunnerCommand(env, runtimeDir)
    if ('error' in runner) {
      fatal(runner.error)
      return 1
    }
    const resolved = await resolveRuntime('', env, deps.hasCommand)
    if ('error' in resolved) {
      fatal(`No se pudo resolver el runtime activo: ${resolved.error.length > 0 ? resolved.error : 'motivo desconocido'}`)
      return 1
    }
    runtime = resolved.runtime

    // El mapping del consumidor gana sobre el default del adaptador; vacio hereda (sin --model).
    const consumerModelsFile = join(repoRoot, '.mefisto', 'models.json')
    const model = await resolveModel({ runtime, agentId: 'implementer', profile: 'balanced', mappingFile: consumerModelsFile, env })
    if ('error' in model) {
      fatal(`No se pudo resolver el modelo de implementer (perfil balanced): ${model.error.length > 0 ? model.error : 'motivo desconocido'}`)
      return 1
    }
    const effort = await resolvePipelineAgentEffort({
      key: 'implementer',
      agentId: 'implementer',
      runtime,
      mappingFile: consumerModelsFile,
      eventsLog,
      env,
      now: now(),
    })
    if ('error' in effort) {
      fatal(`No se pudo resolver el effort de implementer: MEFISTO_EFFORTS_ERROR=${effort.error.length > 0 ? effort.error : 'motivo desconocido'}`)
      return 1
    }

    if (doAll) {
      log.log('Obteniendo todos los PRs abiertos...')
      const list = deps.run('gh', ['pr', 'list', '--state', 'open', '--json', 'number', '-q', '.[].number'], options)
      if (list.stderr.length > 0) err(list.stderr)
      prNums = sortNumeric(list.stdout.split('\n')).filter((line) => line.length > 0)
      if (prNums.length === 0) {
        log.log('No hay PRs abiertos.')
        return 0
      }
    }
    if (prNums.length === 0) {
      fatal('No se especificaron PRs. Usa --all o proporciona números de PR.')
      return 1
    }

    log.log(`PRs a procesar (en orden): ${prNums.join(' ')}`)
    if (doMerge) log.warn('Modo --merge activado: cada PR será mergeado a main después de sincronizar')

    tmpDir = mkdtempSync(join(tempRoot, 'mefisto-pr-sync.'))
    const launchRunner =
      deps.launchRunner ??
      runnerProcess({
        runner: runner.runner,
        env: childEnv,
        cwd: repoRoot,
        onChild: (child) => {
          runnerChild = child
        },
      })
    const runAgent = (label: string, prompt: string, worktree: string): Promise<boolean> =>
      runPrSyncAgent(label, 'implementer', prompt, worktree, {
        runtime,
        model: model.model,
        effort: effort.effort,
        logDir,
        timestamp,
        tmpDir,
        eventsLog,
        log,
        launchRunner,
        supportsResume: () => runtimeSupportsResume(runtime, { env: childEnv }),
        setHold: (next) => {
          hold = next
        },
        writeStatus: (statusState) => {
          if (currentPr.length > 0) writePrStatus(currentPr, currentStage.length > 0 ? currentStage : label, statusState)
        },
        env: childEnv,
        now,
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      })
    const dotnet = deps.runDotnet ?? dotnetIn(repoRoot, childEnv, () => tmpDir)

    // Contrato: 0 pasan, 1 tests fallidos, 2 no compila, 3 ningun proyecto tenia tests. Solo corren
    // los `*.Tests`: los smoke tests van contra el entorno desplegado (MEF-ADR-0013).
    const validateTests = (worktree: string): { code: number; output: string } => {
      // Build explicito: `dotnet test` con compilacion implicita falla en worktrees por assemblies de proyecto.
      const build: DotnetResult = dotnet(['build', join(worktree, config.solutionFile)])
      const buildOutput = chomp(build.output)
      log.append(`${buildOutput}\n`)
      if ((build.status ?? 127) !== 0) return { code: 2, output: buildOutput }
      const tests = runTestsProjects(worktree, config.namespacePrefix, ['--no-build'], dotnet)
      const testOutput = chomp(tests.output)
      log.append(`${testOutput}\n`)
      if (tests.status === 0) return { code: 0, output: testOutput }
      return { code: tests.status === 8 ? 3 : 1, output: testOutput }
    }

    const tracker = new Map<string, { status: string; branch: string }>()
    const setStatus = (pr: string, value: string): void => {
      tracker.set(pr, { status: value, branch: tracker.get(pr)?.branch ?? '' })
    }
    const setBranch = (pr: string, branch: string): void => {
      tracker.set(pr, { status: tracker.get(pr)?.status ?? 'pendiente', branch })
    }
    const getStatus = (pr: string): string => tracker.get(pr)?.status ?? 'desconocido'
    const getBranch = (pr: string): string => {
      const branch = tracker.get(pr)?.branch ?? ''
      return branch.length > 0 ? branch : '(no disponible)'
    }

    let currentWorktree = ''
    let haveErrors = false
    const failPr = (pr: string, message: string): void => {
      const line = `\n${COLOR.red}${COLOR.bold}${PR_SYNC_GLYPHS.error} PR #${pr}: ${message}${COLOR.reset}\n`
      out(line)
      log.append(line)
      setStatus(pr, `ERROR: ${message}`)
      writePrStatus(pr, currentStage.length > 0 ? currentStage : 'sync', 'failed', message)
      haveErrors = true
      if (currentWorktree.length > 0 && isDirectory(currentWorktree)) {
        log.warn(`Worktree temporal queda en: ${currentWorktree} (para inspección)`)
        logged('git', ['worktree', 'remove', '--force', currentWorktree])
      }
      currentWorktree = ''
    }

    const github: PrSyncGithubTools = { run: deps.run, runLogged: deps.runLogged, options, log, logFile, sleep }
    const mergeToMain = async (pr: string): Promise<void> => {
      log.log(`Mergeando PR #${pr} a main...`)
      currentStage = 'merge'
      writePrStatus(pr, 'merge', 'running')
      if (await mergePrWithRetry(pr, github)) {
        log.success(`PR #${pr} mergeado a main`)
        setStatus(pr, 'mergeado')
        writePrStatus(pr, 'merge', 'completed')
        try {
          unblockDependentIssues(pr, github)
        } catch {
          log.warn(
            `Post-merge: fallo al desbloquear issues dependientes del PR #${pr} (el merge sí se completó; revisar labels 'bloqueado' manualmente)`,
          )
        }
        logged('git', ['fetch', 'origin', 'main'])
      } else {
        failPr(pr, 'No se pudo mergear después de reintentos')
      }
    }

    for (const pr of prNums) {
      log.header(`PR #${pr}`)
      currentWorktree = ''
      currentTitle = ''

      const view = orEcho(deps.run('gh', ['pr', 'view', pr, '--json', 'state,title'], options), '{}')
      const prState = rawFieldOr(view, 'state', 'NOT_FOUND')
      currentTitle = rawFieldOr(view, 'title', '')
      if (prState !== 'OPEN') {
        log.warn(`PR #${pr} no está abierto (estado: ${prState}). Saltando.`)
        setStatus(pr, `omitido (${prState})`)
        setBranch(pr, '(n/a)')
        continue
      }

      currentPr = pr
      currentStage = 'sync'
      writePrStatus(pr, 'sync', 'running')

      const branch = required('gh', ['pr', 'view', pr, '--json', 'headRefName', '-q', '.headRefName'])
      log.log(`Rama: ${branch}`)
      setBranch(pr, branch)

      log.log('Actualizando referencias remotas...')
      if (logged('git', ['fetch', 'origin', 'main']) !== 0) {
        failPr(pr, 'No se pudo hacer fetch de origin/main')
        continue
      }
      if (logged('git', ['fetch', 'origin', branch]) !== 0) {
        failPr(pr, `No se pudo hacer fetch de origin/${branch}`)
        continue
      }

      const behind = required('git', ['rev-list', `origin/${branch}..origin/main`, '--count'])
      if (/^[0-9]+$/.test(behind) && Number(behind) === 0) {
        log.success(`PR #${pr} ya está al día con main. Nada que hacer.`)
        setStatus(pr, 'al día')
        if (doMerge) await mergeToMain(pr)
        else writePrStatus(pr, 'sync', 'completed')
        continue
      }

      log.log(`main tiene ${behind} commit(s) nuevos respecto a la rama.`)

      const worktree = join(tempRoot, `pr-sync-${pr}-${Math.floor(now().getTime() / 1000)}`)
      currentWorktree = worktree
      log.log(`Creando worktree temporal en ${worktree}...`)
      if (logged('git', ['worktree', 'add', worktree, '--detach', `origin/${branch}`]) !== 0) {
        failPr(pr, 'No se pudo crear el worktree temporal')
        continue
      }
      if (logged('git', ['-C', worktree, 'checkout', '-B', branch, `origin/${branch}`]) !== 0) {
        failPr(pr, `No se pudo hacer checkout de la rama ${branch}`)
        continue
      }

      log.log('Haciendo merge de origin/main...')
      if (logged('git', ['-C', worktree, 'merge', 'origin/main', '--no-edit']) === 0) {
        log.success('Merge automático exitoso')
      } else {
        log.warn('Merge con conflictos. Invocando implementer para resolverlos...')
        const conflictFiles = required('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=U'])
        log.log(`Archivos en conflicto: ${conflictFiles}`)
        currentStage = `merge-pr${pr}`
        writePrStatus(pr, currentStage, 'running')
        if (!(await runAgent(`merge-pr${pr}`, mergePrompt(config.projectName, conflictFiles), worktree))) {
          failPr(pr, 'El agente implementer falló al resolver conflictos')
          continue
        }
        const remaining = chomp(deps.run('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=U'], options).stdout)
        if (remaining.length > 0) {
          failPr(pr, `Aún quedan conflictos después del agente: ${remaining}`)
          continue
        }
        log.success('Conflictos resueltos')
      }

      log.log('Verificando tests después del merge...')
      const tests = validateTests(worktree)
      if (tests.code === 2) {
        failPr(pr, 'Error de compilación post-merge')
        continue
      } else if (tests.code === 3) {
        failPr(pr, 'No se ejecutaron tests (posible fallo silencioso)')
        continue
      } else if (tests.code === 1) {
        log.warn('Tests fallan post-merge. Invocando implementer para arreglar...')
        const failed = failedTestLines(tests.output)
        if (failed === null) throw new PipelineExit(1)
        currentStage = `fix-pr${pr}`
        writePrStatus(pr, currentStage, 'running')
        if (!(await runAgent(`fix-pr${pr}`, fixPrompt(config.projectName, failed), worktree))) {
          failPr(pr, 'El agente implementer falló al arreglar tests')
          continue
        }
        if (validateTests(worktree).code !== 0) {
          failPr(pr, 'Tests siguen fallando después del segundo intento')
          continue
        }
      }
      log.success('Todos los tests pasan')

      log.log('Haciendo push de la rama actualizada...')
      if (logged('git', ['-C', worktree, 'push', 'origin', branch, '--force-with-lease']) !== 0) {
        failPr(pr, `No se pudo hacer push de ${branch}`)
        continue
      }
      log.success(`Rama ${branch} actualizada en origin`)

      logged('git', ['worktree', 'remove', '--force', worktree])
      logged('git', ['branch', '-D', branch])
      currentWorktree = ''
      log.success('Worktree temporal limpiado')

      setStatus(pr, 'sincronizado')
      if (doMerge) await mergeToMain(pr)
      else writePrStatus(pr, 'sync', 'completed')
    }

    log.header('Resumen')
    out('\n')
    out(summaryTable(prNums.map((pr) => ({ pr, branch: getBranch(pr), status: getStatus(pr) }))))
    out('\n')

    // Una vez, si algun merge del lote salio bien; su fallo no cambia el codigo de salida.
    if (prNums.some((pr) => getStatus(pr) === 'mergeado')) {
      log.log('Limpiando worktrees mergeados o abandonados...')
      if (logged(process.execPath, [join(SCRIPT_DIR, 'worktree-clean.mts')]) !== 0) {
        log.warn(`worktree-clean.mts fallo; la limpieza de worktrees quedo pendiente (ver ${logFile})`)
      }
    }

    if (haveErrors) {
      log.warn(`Algunos PRs tuvieron errores. Revisa el log: ${logFile}`)
      return 1
    }
    log.success(`pr-sync completado. Log: ${logFile}`)
    return 0
  }

  return runPipeline(main, {
    finalize,
    // Solo se mata el proceso que pr-sync lanzo: el runner corta a su agente y limpia.
    onSignal: () => void runnerChild?.kill('SIGTERM'),
    err,
    ...(deps.signals === undefined ? {} : { signals: deps.signals }),
    ...(deps.exit === undefined ? {} : { exit: deps.exit }),
  })
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await prSync({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'pr-sync.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
