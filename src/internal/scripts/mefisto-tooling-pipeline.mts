// Pipeline INTERNO de tooling para el repo de Mefisto.
//
// Uso:
//   mefisto-tooling-pipeline.sh 42
//   mefisto-tooling-pipeline.sh --issue 42
//   mefisto-tooling-pipeline.sh 42 --from-stage 2
//   mefisto-tooling-pipeline.sh 42 --models 'reviewer=<modelo>,writer=<modelo>'   modelo por stage
//   mefisto-tooling-pipeline.sh 42 --variant experimento-a    corrida paralela del mismo issue: sin PR, rama local
//
// Ciclo: issue -> worktree -> writer -> reviewer -> sync con main -> PR -> limpieza. Solo modifica
// archivos del propio plugin; no corre dotnet ni terraform.
//
// Entorno: MEFISTO_AGENT_TIMEOUT_SECONDS (timeout de cada agente, 1800), MEFISTO_RUN_AGENT_BIN
// (runner alterno), MEFISTO_AGENT_MAX_ATTEMPTS y MEFISTO_AGENT_RETRY_BACKOFF_SECONDS (reintento
// ante proveedor caido, 3 y 120), MEFISTO_HOLD_MAX_SECONDS y MEFISTO_HOLD_PROBE_SECONDS (techo y
// sondeo de la espera, 21600 y 300), MEFISTO_LAUNCH_ROOT (raiz con el estado cuando lo lanza el
// batch) y MEFISTO_MODELS_FILE (mapping de modelos).

import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { resolveEffort, resolveModel } from '../../runtime/lib/mefisto-models.mts'
import { resolveRuntime, runtimeLibDir } from '../../runtime/lib/mefisto-runtime.mts'
import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint } from '../../../scripts/lib/cli.mts'
import { appendEventsLine, clockTime } from '../../../scripts/lib/pipeline/agent-log.mts'
import { runtimeSupportsResume } from '../../../scripts/lib/pipeline/agent-runtime.mts'
import { runnerProcess } from '../../../scripts/lib/pipeline/pipeline-agent-run.mts'
import type { LaunchRunner, RunnerCommand } from '../../../scripts/lib/pipeline/pipeline-agent-run.mts'
import { PipelineExit, runPipeline } from '../../../scripts/lib/pipeline/pipeline-exit.mts'
import type { SignalSource } from '../../../scripts/lib/pipeline/pipeline-exit.mts'
import { appendText, createAbort, createPipelineLog, runLogged } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import type { Abort, LoggedRun } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { collectSummary, metricsComment } from '../../../scripts/lib/pipeline/pipeline-pr.mts'
import { localIsoSeconds, runStamp } from '../../../scripts/lib/pipeline/pipeline-status.mts'
import { createWorktree, issueSlug } from '../../../scripts/lib/pipeline/pipeline-worktree.mts'
import { findOpenPrForBranch } from '../../../scripts/lib/pipeline/pull-requests.mts'
import { renderRunMetricsTable } from '../../../scripts/lib/pipeline/run-history.mts'
import { formatStageModelsForLog, parseStageModels, resolveStageModel } from '../../../scripts/lib/pipeline/stage-models.mts'
import type { StageModels } from '../../../scripts/lib/pipeline/stage-models.mts'
import { validateVariantLabel } from '../../../scripts/lib/pipeline/variant.mts'
import { changelogFragmentAdded, changesRequireChangelog } from './lib/mefisto-changelog-gate.mts'
import { extractFrontmatter } from './lib/frontmatter.mts'
import { getHarnessSha, getHarnessVersion } from './lib/mefisto-harness-version.mts'
import { neutralityRemedy } from './lib/mefisto-release-lib.mts'
import { assertInMefisto, ensureGithooksInstalled } from './lib/mefisto-repo.mts'
import type { MefistoRepo } from './lib/mefisto-repo.mts'
import { validateMefistoScopeChanges } from './lib/mefisto-scope-gate.mts'
import { runToolingAgent } from './lib/mefisto-tooling-agent.mts'
import type { AgentRole, ToolingAgentContext, ToolingAgentOutcome } from './lib/mefisto-tooling-agent.mts'
import {
  AUTO_COMMIT_PATHS,
  WRITER_CHANGE_PATHS,
  abortErrorText,
  completedHistoryLine,
  failedHistoryLine,
  parseToolingIssue,
  renderToolingStatus,
} from './lib/mefisto-tooling-records.mts'
import type { AgentTrack, HistoryInput } from './lib/mefisto-tooling-records.mts'
import { mergePrompt, neutralityFixPrompt, pullRequestBody, stage1Prompt, stage2Prompt } from './lib/mefisto-tooling-texts.mts'

const SCRIPT_DIR = import.meta.dirname

/** Lineas del log que el aborto reemite: la causa de un fallo de `gh` o `git` vive ahi. */
const TAIL_LOG_LINES = 20

const STATUS_DEFAULT = 'pipeline-status-mefisto-tooling.json'

const NODE_MODULE = /\.(mts|mjs|js)$/

export interface MefistoToolingDeps {
  argv: string[]
  /** Directorio desde el que se lanza: el repo de Mefisto o, en un batch, su raiz ejecutable. */
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
  /** Esperas de reintento y de hold; por defecto duerme de verdad. */
  sleep?: (seconds: number) => Promise<void>
  /** Sustituye al proceso del runner; sin el se lanza el runner neutral como proceso hijo. */
  launchRunner?: LaunchRunner
  /** Si el runtime sabe reanudar una sesion; por defecto lo responde su adaptador. */
  supportsResume?: (runtime: string) => boolean | Promise<boolean>
  signals?: SignalSource
  exit?: (code: number) => void
}

export interface StageEffortRequest {
  key: string
  agentId: string
  /** Carpeta de las fuentes neutrales de los agentes. */
  agentsDir: string
  runtime: string
  mappingFile: string
  eventsLog: string
  env: NodeJS.ProcessEnv
  now: Date
}

/**
 * Effort nativo de un agente a partir del nivel que declara su fuente neutral. Devuelve el
 * mensaje de aborto si la fuente no lo declara o el mapping no lo resuelve.
 */
export async function resolveStageEffort(request: StageEffortRequest): Promise<{ effort: string } | { error: string }> {
  const agentFile = join(request.agentsDir, `${request.agentId}.md`)
  let level = ''
  try {
    const front = extractFrontmatter(readFileSync(agentFile, 'utf8'))
    if (front.status === 0) {
      const parsed: unknown = JSON.parse(front.text)
      const effort = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).effort : undefined
      if (typeof effort === 'string') level = effort
      else if (effort !== undefined && effort !== null && effort !== false) level = JSON.stringify(effort)
    }
  } catch {
    level = ''
  }
  if (level.length === 0) {
    return {
      error: `No se pudo resolver el effort de ${request.agentId}: MEFISTO_EFFORTS_ERROR=la fuente ${agentFile} no declara 'effort' o es ilegible`,
    }
  }
  const resolved = await resolveEffort({
    runtime: request.runtime,
    agentId: request.agentId,
    level,
    mappingFile: request.mappingFile,
    env: request.env,
  })
  if ('error' in resolved) {
    const reason = resolved.error.length > 0 ? resolved.error : 'motivo desconocido'
    return { error: `No se pudo resolver el effort de ${request.agentId} (nivel ${level}): MEFISTO_EFFORTS_ERROR=${reason}` }
  }
  const native = resolved.effort.length > 0 ? resolved.effort : '<heredado>'
  appendEventsLine(request.eventsLog, `[${clockTime(request.now)}] EFFORTS: ${request.key} -> ${native} (nivel ${level})`)
  return { effort: resolved.effort }
}

/** Runner neutral, o el de `MEFISTO_RUN_AGENT_BIN`: un modulo de Node se lanza con este mismo Node. */
export function runnerCommand(env: NodeJS.ProcessEnv): RunnerCommand {
  const override = env.MEFISTO_RUN_AGENT_BIN ?? ''
  const path = override.length > 0 ? override : join(SCRIPT_DIR, '..', '..', 'runtime', 'mefisto-run-agent.mts')
  if (override.length === 0 || NODE_MODULE.test(path)) return { command: process.execPath, args: [path] }
  return { command: path, args: [] }
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

const chomp = (text: string): string => text.replace(/\n+$/, '')

interface RunState {
  issue: string
  issueTitle: string
  variant: string
  runtime: string
  timestamp: string
  statusFilename: string
  logFile: string
  logFileAbs: string
  /** Vacio hasta preparar el directorio del pipeline: antes de eso un aborto no deja status. */
  pipelineDir: string
  worktree: string
  currentStage: string
  writer: AgentTrack
  reviewer: AgentTrack
  pr: string
  error: string
  harnessVersion: string
  harnessSha: string
}

/** Corre el pipeline y devuelve su codigo de salida. */
export async function mefistoToolingPipeline(deps: MefistoToolingDeps): Promise<number> {
  const { env, cwd, out, err, now } = deps

  let repo: MefistoRepo
  try {
    repo = assertInMefisto(cwd, { run: deps.run, hasCommand: deps.hasCommand })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    err(`${error.message}\n`)
    return 1
  }
  const githooks = ensureGithooksInstalled(repo.root)
  // git entrega la raiz con `/` tambien en Windows: las rutas que se arman sobre ella se normalizan.
  const root = resolve(repo.root)
  if (githooks !== null) err(`${githooks}\n`)

  const stateDir = nonEmpty(env.MEFISTO_STATE_DIR) ?? join(root, '.mefisto', 'pipeline')
  const legacyStateDir = nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(root, '.claude', 'pipeline')
  // Lo que el bash exportaba al runner, al agente y a los CLIs.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    MEFISTO_STATE_DIR: stateDir,
    MEFISTO_LEGACY_STATE_DIR: legacyStateDir,
    MEFISTO_LEGACY_STATE_REL: join('.claude', 'pipeline'),
    MEFISTO_REPO_ROOT: root,
    MEFISTO_PROJECT_NAME: repo.projectName,
    ...(deps.hasCommand('gh') ? { MEFISTO_REPO_SLUG: repo.repoSlug } : {}),
    MEFISTO_RUNTIME_LIB_DIR: runtimeLibDir(env),
  }
  const modelsFile = nonEmpty(env.MEFISTO_MODELS_FILE) ?? join(nonEmpty(env.MEFISTO_LAUNCH_ROOT) ?? root, '.mefisto', 'models.json')

  const logDir = join(stateDir, 'logs')
  const timestamp = runStamp(now())
  const run: RunState = {
    issue: '',
    issueTitle: '',
    variant: '',
    runtime: '',
    timestamp,
    statusFilename: STATUS_DEFAULT,
    logFile: join(logDir, `mefisto-tooling-pipeline-${timestamp}.log`),
    logFileAbs: '',
    pipelineDir: '',
    worktree: '',
    currentStage: 'setup',
    writer: { duration: '', result: 'pending', metrics: '' },
    reviewer: { duration: '', result: 'pending', metrics: '' },
    pr: '',
    error: '',
    // Una sola vez y antes del worktree: el commit identifica la maquinaria que corre.
    harnessVersion: getHarnessVersion(),
    harnessSha: getHarnessSha(cwd, deps.run),
  }
  const currentLog = (): string => (run.logFileAbs.length > 0 ? run.logFileAbs : run.logFile)
  const log = createPipelineLog({ logFile: currentLog, out, now })
  const eventsLog = (): string => join(run.pipelineDir, 'events.log')
  const eventLine = (text: string): void => appendEventsLine(eventsLog(), `[${clockTime(now())}] ${text}`)

  const updateStatus = (stage: string, state: string): void => {
    run.currentStage = stage
    writeFileSync(
      join(run.pipelineDir, run.statusFilename),
      renderToolingStatus({
        issue: run.issue,
        title: run.issueTitle,
        variant: run.variant,
        runtime: run.runtime,
        started: run.timestamp,
        stage,
        state,
        updated: localIsoSeconds(now()),
        worktree: run.worktree,
        log: currentLog(),
        writer: run.writer,
        reviewer: run.reviewer,
        pr: run.pr,
        error: run.error,
      }),
    )
  }
  const historyInput = (): HistoryInput => ({
    issue: run.issue,
    title: run.issueTitle,
    variant: run.variant,
    runtime: run.runtime,
    harnessVersion: run.harnessVersion,
    harnessSha: run.harnessSha,
    started: run.timestamp,
    finished: localIsoSeconds(now()),
    writer: run.writer,
    reviewer: run.reviewer,
  })

  const abort: Abort = createAbort({
    log,
    tailLines: TAIL_LOG_LINES,
    worktree: () => run.worktree,
    stream: err,
    leadingBlankLine: false,
    inspectHint: false,
    onStart: (message) => {
      run.error = abortErrorText(message)
    },
    record: () => {
      if (run.pipelineDir.length === 0) return
      updateStatus(run.currentStage, 'failed')
      appendText(
        join(run.pipelineDir, 'pipeline-history.jsonl'),
        failedHistoryLine({ ...historyInput(), stage: run.currentStage, error: run.error }),
      )
    },
  })

  let runnerChild: ChildProcess | null = null

  /** `git` cuya salida se necesita: si falla, el pipeline termina con su codigo, sin mas mensajes. */
  const git = (args: string[]): string => {
    const result = deps.run('git', args, { cwd, env: childEnv })
    if (result.status !== 0) {
      if (result.stderr.length > 0) err(result.stderr)
      throw new PipelineExit(result.status ?? 1)
    }
    return chomp(result.stdout)
  }
  const logged = (command: string, args: string[], file: string = currentLog()): boolean =>
    deps.runLogged(command, args, file, { cwd, env: childEnv }) === 0

  const main = async (): Promise<number> => {
    // --- Argumentos ---
    const argv = [...deps.argv]
    if (argv.length === 0) {
      out(`Uso: ${deps.scriptPath} [--issue NUM | NUM] [--from-stage N] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]\n`)
      return 1
    }
    let fromStage = '1'
    let modelsSpec = ''
    const positional: string[] = []
    const valueOf = (missing: string): string => {
      if (argv.length < 2) abort(missing)
      const value = argv[1] ?? ''
      argv.splice(0, 2)
      return value
    }
    while (argv.length > 0) {
      const arg = argv[0] ?? ''
      if (arg === '--issue') run.issue = valueOf('Falta el numero de issue')
      else if (arg === '--from-stage') fromStage = valueOf('Falta el numero de stage')
      else if (arg === '--status-file') run.statusFilename = valueOf('Falta el nombre del archivo de status')
      else if (arg === '--models') modelsSpec = valueOf('Falta el valor de --models')
      else if (arg === '--variant') run.variant = valueOf('Falta el valor de --variant')
      else if (/^[0-9]/.test(arg)) {
        positional.push(arg)
        argv.shift()
      } else abort(`Argumento no reconocido: ${arg}`)
    }
    if (positional.length > 0 && run.issue.length === 0) run.issue = positional[0] ?? ''
    if (run.issue.length === 0) abort('Falta el numero de issue')
    const issue = run.issue

    // --- Variante: se valida antes del worktree y antes de nombrar cualquier archivo ---
    const variant = run.variant
    let issueLogTag = issue
    if (variant.length > 0) {
      const invalid = validateVariantLabel(variant)
      if (invalid !== null) abort(`--variant mal formado: ${invalid}`)
      issueLogTag = `${issue}-${variant}`
      // Dos variantes del mismo segundo comparten marca de tiempo: sin el label escribirian al mismo log.
      run.logFile = join(logDir, `mefisto-tooling-pipeline-${timestamp}-${variant}.log`)
    }
    if (run.statusFilename === STATUS_DEFAULT) {
      run.statusFilename =
        variant.length > 0 ? `pipeline-status-mefisto-tooling-${issue}-${variant}.json` : `pipeline-status-mefisto-tooling-${issue}.json`
    }
    if (!/^[1-2]$/.test(fromStage)) abort(`--from-stage debe ser 1 o 2 (recibido: ${fromStage})`)

    // --- Frontera neutral, antes de crear el worktree ---
    const timeout = nonEmpty(env.MEFISTO_AGENT_TIMEOUT_SECONDS) ?? '1800'
    if (!/^[0-9]+$/.test(timeout)) abort(`MEFISTO_AGENT_TIMEOUT_SECONDS '${timeout}' no es un entero`)
    if (Number(timeout) <= 0) abort(`MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0 (recibido: ${timeout})`)
    for (const command of ['gh', 'git']) {
      if (!deps.hasCommand(command)) abort(`Falta comando requerido: ${command}`)
    }
    const resolved = await resolveRuntime('', env, deps.hasCommand)
    if ('error' in resolved) abort(`No se pudo resolver el runtime activo: ${resolved.error}`)
    const runtime = resolved.runtime
    if (!deps.hasCommand(runtime)) {
      abort(`Falta el CLI del runtime resuelto ('${runtime}'). Fija MEFISTO_RUNTIME con un runtime instalado.`)
    }
    run.runtime = runtime

    // --- Directorio del pipeline ---
    mkdirSync(logDir, { recursive: true })
    mkdirSync(join(stateDir, 'metrics'), { recursive: true })
    writeFileSync(run.logFile, `Pipeline mefisto-tooling iniciado: ${timestamp}\n`)
    run.pipelineDir = realpathSync.native(stateDir)
    const logDirAbs = realpathSync.native(logDir)
    run.logFileAbs = realpathSync.native(run.logFile)
    appendFileSync(eventsLog(), '')
    appendText(eventsLog(), `=== SESSION MEFISTO-TOOLING ${timestamp} issue:${issue} from-stage:${fromStage} ===\n`)
    eventLine(`RUNTIME: ${runtime}`)

    // --- Modelos y effort: un valor malformado aborta antes de que exista el worktree ---
    const parsedModels = parseStageModels(modelsSpec)
    if ('error' in parsedModels) abort(`--models mal formado: ${parsedModels.error.length > 0 ? parsedModels.error : 'formato invalido'}`)
    const stageModels: StageModels = parsedModels.models
    if (stageModels.size > 0) {
      const summary = formatStageModelsForLog(stageModels)
      log.log(`Modelos por stage (--models): ${summary}`)
      eventLine(`MODELS: ${summary}`)
    }
    // El override --models gana por clave exacta; sin el decide el mapping local, luego el adaptador.
    const resolveStageModelFor = async (key: string, agentId: string, profile: string): Promise<string> => {
      const explicit = resolveStageModel(stageModels, key, '')
      if (explicit.length > 0) {
        eventLine(`MODELS: ${key} -> ${explicit} (override --models)`)
        return explicit
      }
      const model = await resolveModel({ runtime, agentId, profile, mappingFile: modelsFile, env })
      if ('error' in model) {
        abort(`No se pudo resolver el modelo de ${agentId} (perfil ${profile}): ${model.error.length > 0 ? model.error : 'motivo desconocido'}`)
      }
      eventLine(`MODELS: ${key} -> ${model.model.length > 0 ? model.model : '<heredado>'} (perfil ${profile})`)
      return model.model
    }
    const models: Record<AgentRole, string> = {
      writer: await resolveStageModelFor('writer', 'mefisto-writer', 'balanced'),
      reviewer: await resolveStageModelFor('reviewer', 'mefisto-reviewer', 'deep'),
    }
    const resolveStageEffortFor = async (key: string, agentId: string): Promise<string> => {
      const effort = await resolveStageEffort({
        key,
        agentId,
        agentsDir: join(SCRIPT_DIR, '..', 'agents'),
        runtime,
        mappingFile: modelsFile,
        eventsLog: eventsLog(),
        env,
        now: now(),
      })
      if ('error' in effort) abort(effort.error)
      return effort.effort
    }
    const efforts: Record<AgentRole, string> = {
      writer: await resolveStageEffortFor('writer', 'mefisto-writer'),
      reviewer: await resolveStageEffortFor('reviewer', 'mefisto-reviewer'),
    }

    if (variant.length > 0) {
      log.log(`Modo variante: '${variant}' -- sin push, sin PR, sin comentario al issue (CA-3); rama queda local`)
      eventLine(`VARIANT: ${variant}`)
    }

    // --- Issue ---
    log.header('Preparando contexto')
    log.log(`Descargando issue #${issue} del repo de Mefisto...`)
    const viewed = deps.run('gh', ['issue', 'view', issue, '--json', 'number,title,body,state,labels'], { cwd, env: childEnv })
    appendText(currentLog(), viewed.stderr)
    if (viewed.status !== 0) abort(`No se pudo obtener el issue #${issue} (debe existir en este repo)`)
    const view = parseToolingIssue(chomp(viewed.stdout))
    if (view.state !== 'OPEN') abort(`El issue #${issue} esta ${view.state} -- solo se procesan issues abiertos.`)
    if (view.title === null) throw new PipelineExit(1)
    run.issueTitle = view.title
    const issueTitle = view.title
    const reference = view.manualClose ? 'Refs' : 'Closes'
    const completionNote = view.manualClose ? ' Este PR no cierra el issue (label cierre:manual).' : ''
    const issueContext = `# Issue #${issue}: ${issueTitle}\n\n${view.body}`
    log.log(`Issue: ${issueTitle}`)
    writeFileSync(join(stateDir, 'mefisto-tooling-input.md'), `${issueContext}\n`)

    // --- Worktree ---
    log.header('Preparando worktree')
    const repoRoot = resolve(nonEmpty(env.MEFISTO_LAUNCH_ROOT) ?? root)
    const currentBranch = git(['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])
    let branch = `worktree-mefisto-issue-${issue}-${issueSlug(issueTitle)}`
    // Sufijo de la variante: varias corridas del mismo issue conviven sin chocar.
    if (variant.length > 0) branch = `${branch}-${variant}`
    const worktree = join(repoRoot, '.mefisto', 'worktrees', branch)
    run.worktree = worktree
    const worktreeGit = (args: string[]): string => git(['-C', worktree, ...args])

    let snapshot: string
    if (Number(fromStage) > 1) {
      if (!isDirectory(worktree)) abort(`No existe el worktree en ${worktree}. No se puede retomar desde Stage ${fromStage}.`)
      log.log(`Retomando desde Stage ${fromStage} -- worktree existente: ${worktree}`)
      snapshot = worktreeGit(['merge-base', 'HEAD', 'main'])
      log.log(`Snapshot detectado: ${snapshot}`)
    } else {
      createWorktree(
        { repoRoot, branch, currentBranch, path: worktree },
        {
          run: deps.run,
          runLogged: (command, args, _file, options) => deps.runLogged(command, args, run.logFile, options),
          log,
          abort,
          cwd: repoRoot,
          env: childEnv,
        },
      )
      mkdirSync(join(worktree, '.mefisto', 'pipeline', 'summaries'), { recursive: true })
      updateStatus('setup', 'running')
      snapshot = worktreeGit(['rev-parse', 'HEAD'])
      log.log(`Snapshot: ${snapshot}`)
    }

    const launchRunner =
      deps.launchRunner ??
      runnerProcess({
        runner: runnerCommand(env),
        env: childEnv,
        cwd,
        appendOutput: true,
        onChild: (child) => {
          runnerChild = child
        },
      })
    const track = (agent: string): AgentTrack | null => (agent === 'writer' ? run.writer : agent === 'reviewer' ? run.reviewer : null)
    const agentContext: ToolingAgentContext = {
      runtime,
      worktree,
      snapshot,
      logDir: logDirAbs,
      pipelineDir: run.pipelineDir,
      eventsLog: eventsLog(),
      timestamp,
      issueLogTag,
      systemFile: join(SCRIPT_DIR, '..', 'prompts', 'noninteractive-system.md'),
      timeout,
      model: (role) => models[role],
      effort: (role) => efforts[role],
      env,
      log,
      out,
      abort,
      onStart: (stage, agent) => {
        const role = track(agent)
        if (role !== null) role.result = 'running'
        updateStatus(`${stage}-${agent}`, 'running')
      },
      onFailed: (stage, agent, seconds, metrics) => {
        const role = track(agent)
        if (role !== null) {
          role.duration = String(seconds)
          role.result = 'failed'
        }
        // Por stage, no por agente: el merge corre como writer y no debe pisar sus metricas.
        if (stage === '1') run.writer.metrics = metrics
        if (stage === '2') run.reviewer.metrics = metrics
        updateStatus(`${stage}-${agent}`, 'failed')
      },
      launchRunner,
      supportsResume: () => (deps.supportsResume ?? ((id: string) => runtimeSupportsResume(id, { env: childEnv })))(runtime),
      run: deps.run,
      now,
      sleep: deps.sleep ?? ((seconds) => new Promise<void>((done) => setTimeout(done, seconds * 1000))),
    }
    const runAgent = (stage: string, agent: string, prompt: string): Promise<ToolingAgentOutcome> =>
      runToolingAgent(agentContext, stage, agent, prompt)

    const scopeViolated = (): boolean => {
      const check = validateMefistoScopeChanges(worktree, snapshot, { run: deps.run })
      if (check.violations.length === 0) return false
      err(`${check.message.join('\n')}\n`)
      return true
    }
    const stageAll = (): void => void deps.run('git', ['-C', worktree, 'add', '-A'], { cwd, env: childEnv })
    const gate = (): { passed: boolean; output: string } => {
      const result = deps.run(process.execPath, [join(SCRIPT_DIR, 'mefisto-neutrality-gate.mts'), '--root', worktree], { cwd, env: childEnv })
      return { passed: result.status === 0, output: chomp(result.stdout + result.stderr) }
    }
    const resumeCommand = (stage: string): string =>
      `  ./.claude/scripts/mefisto-tooling-pipeline.sh ${issue} --from-stage ${stage}${variant.length > 0 ? ` --variant ${variant}` : ''}`

    // El gate se carga del checkout principal y escanea el worktree. Antes de abortar, el mismo rol
    // tiene un unico intento de corregir la fuga.
    const runNeutralityGate = async (stage: string, role: AgentRole): Promise<void> => {
      // El gate lee lo versionado: lo nuevo del agente se registra en el indice antes de escanear.
      stageAll()
      let result = gate()
      if (result.passed) {
        log.success('Gate de neutralidad: sin fugas')
        return
      }
      const leaks = result.output.split('\n').filter((line) => /[^ \t]/.test(line)).length
      log.warn(`${role}: ${leaks} violacion(es) de neutralidad -- intento de correccion`)
      eventLine(`[neutralidad][fix] ${role}: ${leaks} violacion(es), intento de correccion`)
      const prompt = neutralityFixPrompt({
        projectName: repo.projectName,
        issue,
        gateOutput: result.output,
        remedy: neutralityRemedy(result.output),
      })
      const started = Math.floor(now().getTime() / 1000)
      await runAgent(`${stage}-fix`, role, prompt)
      eventLine(`[neutralidad][fix] ${role}: ${Math.floor(now().getTime() / 1000) - started}s`)

      if (scopeViolated()) {
        abort(`Stage ${stage} fallido: el intento de correccion de neutralidad (${role}) toco archivos fuera del scope de Mefisto.`)
      }
      stageAll()
      result = gate()
      if (result.passed) {
        log.success(`${role}: fuga de neutralidad corregida`)
        eventLine(`[neutralidad][fix] ${role}: corregido`)
        return
      }
      const remedy = neutralityRemedy(result.output)
      eventLine(`[neutralidad][fix] ${role}: persiste`)
      abort(
        `El intento de correccion de neutralidad ya fallo -- la fuga persiste. Stage ${stage} fallido: el ${role} dejo fuga(s) de neutralidad de runtime (MEF-ADR-0049):\n${result.output}\n${remedy}\nCorrige las fugas en el worktree (${worktree}) y retoma con:\n${resumeCommand(stage)}`,
      )
    }

    // Cada ruta se agrega por separado: una que no exista no impide agregar las demas.
    const autoCommit = (phase: string, message: string): void => {
      const pending = deps.run('git', ['-C', worktree, 'status', '--porcelain', '--', ...AUTO_COMMIT_PATHS], { cwd, env: childEnv })
      if (chomp(pending.stdout).length === 0) return
      log.log(`Haciendo commit automatico (fase ${phase})...`)
      for (const path of AUTO_COMMIT_PATHS) deps.run('git', ['-C', worktree, 'add', path], { cwd, env: childEnv })
      logged('git', ['-C', worktree, 'commit', '-m', message])
    }

    const finishStage = (role: AgentRole, outcome: ToolingAgentOutcome): void => {
      run[role].duration = String(outcome.seconds)
      run[role].metrics = outcome.metrics
      run[role].result = 'passed'
    }
    const holds: Record<AgentRole, { seconds: number; resumed: boolean }> = {
      writer: { seconds: 0, resumed: false },
      reviewer: { seconds: 0, resumed: false },
    }

    // --- Stage 1: writer ---
    if (Number(fromStage) <= 1) {
      log.header('Stage 1: Writer (implementacion)')
      const outcome = await runAgent('1', 'writer', stage1Prompt({ projectName: repo.projectName, issue, issueContext, timeout }))

      const committed = deps.run('git', ['-C', worktree, 'diff', '--quiet', snapshot, 'HEAD'], { cwd, env: childEnv }).status !== 0
      const pending =
        chomp(deps.run('git', ['-C', worktree, 'status', '--porcelain', '--', ...WRITER_CHANGE_PATHS], { cwd, env: childEnv }).stdout).length > 0
      if (!committed && !pending) {
        abort(`El writer no genero ningun cambio. Revisa el log: ${join(logDirAbs, `mefisto-tooling-stage-1-writer-${timestamp}-issue-${issueLogTag}.log`)}`)
      }
      if (scopeViolated()) abort('Stage 1 fallido: el writer toco archivos fuera del scope de Mefisto.')
      await runNeutralityGate('1', 'writer')
      autoCommit('writer', `mefisto-tooling(#${issue}): implementacion`)

      finishStage('writer', outcome)
      holds.writer = { seconds: outcome.holdSeconds, resumed: outcome.resumed }
      updateStatus('1-writer', 'passed')
      log.success('Stage 1 completado')
    }

    // --- Stage 2: reviewer ---
    {
      log.header('Stage 2: Reviewer (revision)')
      // Solo SHA, --stat y rutas: el diff completo puede no caber en el prompt y el reviewer lo pide por ruta.
      const prompt = stage2Prompt({
        projectName: repo.projectName,
        issueContext,
        snapshot,
        writerHead: worktreeGit(['rev-parse', 'HEAD']),
        diffStat: worktreeGit(['diff', '--stat=120', `${snapshot}..HEAD`]),
        diffNameStatus: worktreeGit(['diff', '--name-status', `${snapshot}..HEAD`]),
        timeout,
      })
      const outcome = await runAgent('2', 'reviewer', prompt)
      if (scopeViolated()) abort('Stage 2 fallido: el reviewer toco archivos fuera del scope de Mefisto.')
      await runNeutralityGate('2', 'reviewer')
      autoCommit('reviewer', `mefisto-tooling(#${issue}): revision y correcciones`)

      finishStage('reviewer', outcome)
      holds.reviewer = { seconds: outcome.holdSeconds, resumed: outcome.resumed }
      updateStatus('2-reviewer', 'passed')
      log.success('Stage 2 completado')
    }

    const commits = worktreeGit(['log', `${snapshot}..HEAD`, '--oneline'])
    if (commits.length === 0) abort(`No hay commits en la rama ${branch}.`)

    // --- Gate de fragmentos de changelog.d/ ---
    log.header('Verificando fragmento de CHANGELOG (changelog.d/)')
    if (changelogFragmentAdded(worktree, snapshot, { run: deps.run })) {
      log.success('El PR anota su cambio como fragmento en changelog.d/')
    } else if (!changesRequireChangelog(worktree, snapshot, { run: deps.run })) {
      log.success('Cambio exento (solo bitacora/gobierno no notable): no se exige fragmento')
    } else {
      abort(
        `Cambio notable sin fragmento en changelog.d/.\nEl writer debio crear 'changelog.d/${issue}.<categoria>.md' (added/changed/fixed/removed)\n-- ver changelog.d/README.md para el formato. NUNCA se edita CHANGELOG.md directamente.\nCrea el fragmento en el worktree (${worktree}) y retoma con:\n${resumeCommand('2')}`,
      )
    }

    // --- Sincronizar con main ---
    log.header('Sincronizando con main')
    log.log('Actualizando main desde origin...')
    if (!logged('git', ['-C', worktree, 'fetch', 'origin', 'main'])) abort('No se pudo hacer fetch de origin/main')
    const behind = worktreeGit(['rev-list', 'HEAD..origin/main', '--count'])
    if (Number(behind) === 0) {
      log.log('La rama ya esta al dia con main')
    } else {
      log.log(`main tiene ${behind} commit(s) nuevos. Haciendo merge...`)
      if (logged('git', ['-C', worktree, 'merge', 'origin/main', '--no-edit'])) {
        log.success('Merge automatico exitoso')
      } else {
        log.warn('Merge con conflictos. Resolviendo...')
        const conflictFiles = worktreeGit(['diff', '--name-only', '--diff-filter=U'])
        await runAgent('merge', 'writer', mergePrompt(conflictFiles))
        const remaining = chomp(deps.run('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=U'], { cwd, env: childEnv }).stdout)
        if (remaining.length > 0) abort(`Aun quedan conflictos: ${remaining}. Revisa manualmente: cd ${worktree}`)
        log.success('Conflictos resueltos')
      }
    }

    // --- PR; en modo variante no se publica nada ---
    let prUrl = ''
    if (variant.length > 0) {
      log.header('Modo variante: sin PR')
      log.warn(`Variante '${variant}': se omiten push, creacion de PR y comentario al issue (CA-3).`)
      log.log(`La rama '${branch}' queda LOCAL -- no se publica a origin.`)
    } else {
      log.header('Creando PR')
      log.log('Haciendo push de la rama...')
      if (!logged('git', ['-C', worktree, 'push', '-u', 'origin', branch])) abort(`No se pudo hacer push de la rama ${branch}`)

      log.log('Verificando si ya existe un PR abierto para la rama...')
      const existing = deps.hasCommand('gh')
        ? findOpenPrForBranch(branch, { run: (command, args) => deps.run(command, args, { cwd, env: childEnv }) })
        : null
      const metricsTable = chomp(
        renderRunMetricsTable([
          { label: 'Writer', duration: run.writer.duration, metrics: run.writer.metrics },
          { label: 'Reviewer', duration: run.reviewer.duration, metrics: run.reviewer.metrics },
        ]),
      )

      if (existing !== null) {
        prUrl = existing
        log.success(`PR existente reutilizado: ${prUrl}`)
        if (!logged('gh', ['pr', 'comment', prUrl, '--body', metricsComment(metricsTable, now())])) {
          log.warn(`No se pudo publicar las metricas en el PR reutilizado: ${prUrl}`)
        }
      } else {
        if (reference === 'Refs') log.warn(`El issue #${issue} tiene el label cierre:manual: el PR usara Refs y no cerrara el issue.`)
        log.log('Creando PR...')
        const summary = (stage: string, agent: string): string =>
          collectSummary(join(worktree, '.mefisto', 'pipeline', 'summaries', `stage-${stage}-${agent}.md`))
        const body = pullRequestBody({
          writer: { seconds: run.writer.duration, holdSeconds: holds.writer.seconds, resumed: holds.writer.resumed, summary: summary('1', 'writer') },
          reviewer: { seconds: run.reviewer.duration, holdSeconds: holds.reviewer.seconds, resumed: holds.reviewer.resumed, summary: summary('2', 'reviewer') },
          commits,
          metricsTable,
          reference,
          issue,
        })
        const created = deps.run('gh', ['pr', 'create', '--title', issueTitle, '--body', body, '--base', 'main', '--head', branch], {
          cwd,
          env: childEnv,
        })
        appendText(currentLog(), created.stderr)
        if (created.status !== 0) abort('No se pudo crear el PR')
        prUrl = chomp(created.stdout)
        log.success(`PR creado: ${prUrl}`)
      }

      if (!logged('gh', ['issue', 'comment', issue, '--body', `Pipeline mefisto-tooling completado. PR: ${prUrl}${completionNote}`], run.logFile)) {
        log.warn(`No se pudo comentar en el issue #${issue}`)
      }
    }

    run.pr = prUrl
    updateStatus('done', 'completed')
    appendFileSync(join(run.pipelineDir, 'pipeline-history.jsonl'), completedHistoryLine({ ...historyInput(), pr: prUrl }))
    rmSync(join(run.pipelineDir, run.statusFilename), { force: true })

    // --- Limpieza ---
    log.header('Cleanup')
    log.log('Eliminando worktree...')
    deps.run('git', ['-C', worktree, 'checkout', '--', '.claude/'], { cwd: repoRoot, env: childEnv })
    if (deps.runLogged('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktree], run.logFile, { cwd: repoRoot, env: childEnv }) !== 0) {
      log.warn(`No se pudo eliminar el worktree. Eliminalo manualmente: git worktree remove --force ${worktree}`)
    }
    run.worktree = ''
    log.success('Worktree eliminado')

    const totalCommits = commits.split('\n').length
    out('\n')
    if (variant.length > 0) {
      out(`${COLOR.cyan}${COLOR.bold}=== Pipeline mefisto-tooling (variante '${variant}') completado ===${COLOR.reset}\n`)
      out('\n')
      out(`  Commits: ${totalCommits}\n`)
      out(`  Rama:    ${branch}\n`)
      out('  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)\n')
      out(`  Log:     ${run.logFile}\n`)
      out('\n')
      const hint = (text: string): void => out(`${COLOR.yellow}${text}${COLOR.reset}\n`)
      hint('Si esta variante gana la comparacion, promuevela a mano:')
      hint(`  git -C ${repoRoot} push -u origin ${branch}`)
      hint(`  gh pr create --base main --head ${branch} --title "${issueTitle}" --body "${reference} #${issue}"`)
      hint('O relanza el pipeline sin --variant para que una corrida normal abra el PR.')
    } else {
      out(`${COLOR.cyan}${COLOR.bold}=== Pipeline mefisto-tooling completado ===${COLOR.reset}\n`)
      out('\n')
      out(`  Commits: ${totalCommits}\n`)
      out(`  Rama:    ${branch}\n`)
      out(`  PR:      ${prUrl}\n`)
      out(`  Log:     ${run.logFile}\n`)
    }
    out('\n')
    return 0
  }

  return runPipeline(main, {
    // El bash no tenia cierre propio: una corrida cortada deja su status como estaba.
    finalize: () => {},
    // Solo se mata el proceso que este pipeline lanzo: el runner corta a su agente y limpia.
    onSignal: () => void runnerChild?.kill('SIGTERM'),
    err,
    ...(deps.signals === undefined ? {} : { signals: deps.signals }),
    ...(deps.exit === undefined ? {} : { exit: deps.exit }),
  })
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await mefistoToolingPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'mefisto-tooling-pipeline.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
