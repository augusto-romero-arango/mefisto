// Pipeline TDD del proyecto consumidor.
//
// Uso:
//   tdd-pipeline.mts 42
//   tdd-pipeline.mts --issue 42
//   tdd-pipeline.mts --file "docs/Historias de usuario/HU-25.md"
//   tdd-pipeline.mts 42 --from-stage 2|3|4                    retoma desde ese stage (4: coverage gate)
//   tdd-pipeline.mts 42 --models 'reviewer=<modelo>,test-writer=<modelo>'
//   tdd-pipeline.mts 42 --variant experimento-a              corrida paralela del mismo issue: sin PR, rama local
//   tdd-pipeline.mts 42 --scaffold-domain <kebab>            crea el dominio antes del Stage 1
//
// Ciclo: issue -> worktree -> test-writer (rojo) -> implementer (verde) -> smoke-test-writer ->
// reviewer (refactor) -> sync con main -> coverage gate -> PR -> limpieza. Un issue
// `tipo:projection` despacha la pareja read-side de agentes.
//
// Entorno: MEFISTO_AGENT_TIMEOUT_SECONDS (timeout de cada agente, 1800), MEFISTO_RUN_AGENT_BIN
// (runner alterno), MEFISTO_HOLD_MAX_SECONDS (techo de la espera ante limite de uso o proveedor
// caido, 21600) y MEFISTO_HOLD_PROBE_SECONDS (cadencia de sondeo, 300), MEF-ADR-0051.

import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { resolveModel } from '../src/runtime/lib/mefisto-models.mts'
import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions } from './lib/cli.mts'
import { harnessConfigEnv, loadHarnessConfig } from './lib/harness-config.mts'
import type { HarnessConfig } from './lib/harness-config.mts'
import { dumpJq, parseJq } from './lib/jq-literals.mts'
import type { JqObject, JqValue } from './lib/jq-literals.mts'
import { agentEventsCompletedSuccessfully } from './lib/pipeline/agent-events.mts'
import { appendEventsLine, clockTime } from './lib/pipeline/agent-log.mts'
import { runtimeCliAvailable, runtimeSupportsResume } from './lib/pipeline/agent-runtime.mts'
import { coverageClassifyFile } from './lib/pipeline/coverage.mts'
import { getHarnessIdentity, harnessIdentityJson } from './lib/pipeline/harness-identity.mts'
import { NON_INTERACTIVE_SYSTEM_PROMPT, resolveRunnerCommand, runAgentWithPolicy, runnerProcess } from './lib/pipeline/pipeline-agent-run.mts'
import type { AgentRunEvent, LaunchRunner } from './lib/pipeline/pipeline-agent-run.mts'
import { PipelineExit, runPipeline } from './lib/pipeline/pipeline-exit.mts'
import type { SignalSource } from './lib/pipeline/pipeline-exit.mts'
import { appendText, createAbort, createPipelineLog, lastLines, runLogged, stripAnsi } from './lib/pipeline/pipeline-log.mts'
import type { Abort, LoggedRun } from './lib/pipeline/pipeline-log.mts'
import {
  collectSummary,
  commentIssue,
  commentPullRequest,
  createPullRequest,
  metricsComment,
  parseIssueView,
  pushBranch,
  repoSlugFromRemoteUrl,
  viewIssue,
} from './lib/pipeline/pipeline-pr.mts'
import { jsonText, localIsoSeconds, noHold, renderStatusJson, runStamp, writeStatus } from './lib/pipeline/pipeline-status.mts'
import type { HoldState } from './lib/pipeline/pipeline-status.mts'
import {
  PIPELINE_OWN_WRITES,
  autoCommitIfNeeded,
  createWorktree,
  hasCommittedChanges,
  hasPendingChanges,
  issueBranchName,
  pipelineWorktreePath,
  removeWorktree,
  resumeWorktree,
} from './lib/pipeline/pipeline-worktree.mts'
import { findOpenPrForBranch } from './lib/pipeline/pull-requests.mts'
import { detectPreexistingRedTests, listReviewerTouchedTests, preexistingRedOnly, renderReviewerTouchedTestsSection } from './lib/pipeline/red-tests.mts'
import { appendCompletedHistory, buildAgentsHistoryJson, renderRunMetricsTable } from './lib/pipeline/run-history.mts'
import { changedFilesText, detectSmokeOnly, listSmokesInvokingRoutes, listSmokesInvokingTools } from './lib/pipeline/smokes.mts'
import type { SmokeInvoker } from './lib/pipeline/smokes.mts'
import { computeStageMetrics, deriveStageLogFromStream, enrichStageMetrics } from './lib/pipeline/stage-metrics.mts'
import { formatStageModelsForLog, parseStageModels, resolvePipelineAgentEffort, resolveStageModel } from './lib/pipeline/stage-models.mts'
import type { StageModels } from './lib/pipeline/stage-models.mts'
import {
  COVERAGE_TABLE_HEADER,
  COVERAGE_THRESHOLD,
  COVERAGE_XML,
  classificationRows,
  coveragePatchSpec,
  coverageSkipReason,
  evaluateCoverage,
  extractFileCoverage,
  measureCoverage,
  runCoverageStep,
} from './lib/pipeline/tdd-coverage.mts'
import type { CoverageRun, FileCoverage } from './lib/pipeline/tdd-coverage.mts'
import {
  WRITE_SIDE,
  abortHistoryStages,
  greenGate,
  issueLabelNames,
  mcpToolPattern,
  readOrNull,
  redGate,
  removedTests,
  runMetricsStages,
  signalField,
  smokeFiles,
  smokeTarget as detectSmokeTarget,
  stage1Output,
  stageAgentsFor,
  tddAgentProfile,
  testLossGate,
  touchedSmokeProjects,
} from './lib/pipeline/tdd-gates.mts'
import type { RunStages, StageAgents, StageRecord } from './lib/pipeline/tdd-gates.mts'
import {
  TDD_GLYPHS,
  TDD_WORKTREE_TEXTS,
  agentDetails,
  blockageComment,
  blockagePromptNote,
  coverageSection,
  invokersBlock,
  mergePrompt,
  pascalCase,
  patchImplementerPrompt,
  patchTestWriterPrompt,
  preexistingBlockageReport,
  preexistingRedWarning,
  prSummary,
  pullRequestBody,
  scaffoldPrompt,
  smokeAnomalySection,
  smokeOnlySection,
  smokeStageTexts,
  smokeUnchangedSection,
  stage1Prompt,
  stage2bPrompt,
  stage2Prompt,
  stage2SmokeOnlyPrompt,
  stage3RefactorPrompt,
  stage3ReviewerPrompt,
  tddFileSlug,
  tddIssueSlug,
} from './lib/pipeline/tdd-texts.mts'
import { extractTestCount, runTestsProjects, testsJsonValue } from './lib/pipeline/test-results.mts'
import type { RunDotnet } from './lib/pipeline/test-results.mts'
import { validateVariantLabel } from './lib/pipeline/variant.mts'
import { renderWarningRemnantsSection } from './lib/pipeline/warning-remnants.mts'
import { stateReadFirst, statePath } from './lib/state.mts'

const SCRIPT_DIR = import.meta.dirname

/** Lineas del log que el aborto reemite: la causa de un fallo de `gh`, `git` o `dotnet` vive ahi. */
const TAIL_LOG_LINES = 20

/** Desenlaces en que el protocolo quedo incompleto: su trabajo parcial nunca se rescata. */
const INCOMPLETE_FAILURES = ['TIMEOUT', 'KILLED', 'STREAM_CUT', 'PROTOCOL_INVALID']

const MISSING_SUMMARY = '_(El agente no generó resumen)_'

export interface TddPipelineDeps {
  argv: string[]
  /** Directorio del consumidor desde el que se lanza. */
  cwd: string
  env: NodeJS.ProcessEnv
  /** Ruta con que se muestra el script en el mensaje de uso. */
  scriptPath: string
  out: (text: string) => void
  err: (text: string) => void
  /** `git`, `gh` y `dotnet` cuando su salida se lee. */
  run: Run
  /** `git`, `gh` y `dotnet` cuando su salida va al log. */
  runLogged: LoggedRun
  /** `dotnet test` de un proyecto; por defecto corre el real. */
  runDotnet?: RunDotnet
  /** Pasos de la medicion de cobertura; por defecto, procesos reales con limite de tiempo. */
  runCoverage?: CoverageRun
  hasCommand: (command: string) => boolean
  now: () => Date
  /** Espera de un hold; por defecto duerme de verdad. */
  sleep?: (seconds: number) => Promise<void>
  /** Sustituye al proceso del runner; sin el se lanza el runner neutral como proceso hijo. */
  launchRunner?: LaunchRunner
  /** Fuente de senales y forma de terminar tras una; por defecto, las del proceso. */
  signals?: SignalSource
  exit?: (code: number) => void
  /** Carpeta donde nace el directorio temporal de la corrida; por defecto, la del sistema. */
  tempRoot?: string
}

interface AgentRecord extends StageRecord {
  result: string
}

interface RunState {
  issue: string
  issueTitle: string
  variant: string
  statusFilename: string
  timestamp: string
  logFile: string
  /** Desde aqui un aborto deja status e historial. */
  pipelineDirReady: boolean
  logFileAbs: string
  historyFile: string
  eventsLog: string
  tmpDir: string
  worktree: string
  identityJson: string
  runtime: string
  agents: StageAgents
  tw: AgentRecord
  im: AgentRecord
  st: AgentRecord
  rv: AgentRecord
  cg: AgentRecord
  scaffold: StageRecord
  patchTw: StageRecord
  patchIm: StageRecord
  tests: string
  pr: string
  error: string
  currentStage: string
  hold: HoldState
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

function isNonEmptyFile(path: string | null): boolean {
  if (path === null) return false
  try {
    const stats = statSync(path)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0)
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

const newRecord = (): AgentRecord => ({ duration: null, metrics: '', result: 'pending' })

/** Corre el pipeline y devuelve su codigo de salida. */
export async function tddPipeline(deps: TddPipelineDeps): Promise<number> {
  const { env, cwd, out, err, now } = deps

  // Guardas previas: fallan sin dejar estado.
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
  const top = deps.run('git', ['rev-parse', '--show-toplevel'], { cwd, env })
  if (top.status !== 0) {
    err('ERROR: no estas en un repositorio git\n')
    return 1
  }
  const consumerRoot = resolve(chomp(top.stdout))
  if (isFile(join(consumerRoot, '.claude-plugin', 'plugin.json'))) {
    err('ERROR: scripts/tdd-pipeline.mts es del plugin publicado y solo aplica al consumidor.\n')
    err('Estas en el repo de Mefisto, que no es un proyecto .NET con TDD de dominio.\n')
    err('Para mejorar el plugin usa /mefisto-tooling.\n')
    return 1
  }
  let config: HarnessConfig
  try {
    config = loadHarnessConfig(undefined, { cwd, warn: (message) => err(`${message}\n`) })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) err(`${error.message}\n`)
    return 1
  }
  const prefix = config.namespacePrefix
  const projectName = config.projectName

  const stateDir = nonEmpty(env.MEFISTO_STATE_DIR) ?? join(consumerRoot, '.mefisto', 'pipeline')
  const legacyStateDir = nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(consumerRoot, '.claude', 'pipeline')
  const stateEnv = { MEFISTO_STATE_DIR: stateDir, MEFISTO_LEGACY_STATE_DIR: legacyStateDir }
  const state = (rel: string): string => statePath(rel, undefined, stateEnv)
  // Lo que los pipelines bash exportaban y heredan el runner, el agente y los CLIs.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...stateEnv,
    MEFISTO_AGENT_PACKAGE_ROOT: nonEmpty(env.MEFISTO_AGENT_PACKAGE_ROOT) ?? realpathSync.native(join(SCRIPT_DIR, '..')),
    MEFISTO_RUNTIME_LIB_DIR: runtimeLibDir(env),
    ...harnessConfigEnv(config),
  }
  const options: CommandOptions = { cwd, env: childEnv }

  state('.state')
  const logDir = join(stateDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const timestamp = runStamp(now())

  const run: RunState = {
    issue: '',
    issueTitle: '',
    variant: '',
    statusFilename: '',
    timestamp,
    logFile: join(logDir, `pipeline-${timestamp}.log`),
    pipelineDirReady: false,
    logFileAbs: '',
    historyFile: '',
    eventsLog: '',
    tmpDir: '',
    worktree: '',
    // Identidad declarada por el paquete; se revalida contra el runtime resuelto.
    identityJson: harnessIdentityJson(getHarnessIdentity()),
    runtime: '',
    agents: WRITE_SIDE,
    tw: newRecord(),
    im: newRecord(),
    st: newRecord(),
    rv: newRecord(),
    cg: newRecord(),
    scaffold: { duration: null, metrics: '' },
    patchTw: { duration: null, metrics: '' },
    patchIm: { duration: null, metrics: '' },
    tests: '',
    pr: '',
    error: '',
    currentStage: 'setup',
    hold: noHold(),
  }
  const currentLog = (): string => (run.logFileAbs.length > 0 ? run.logFileAbs : run.logFile)
  const log = createPipelineLog({ logFile: currentLog, out, now, glyphs: TDD_GLYPHS })
  const eventLine = (text: string): void => appendEventsLine(run.eventsLog, `[${clockTime(now())}] ${text}`)
  const epoch = (): number => Math.floor(now().getTime() / 1000)
  // Un aviso por stderr con su copia en el log.
  const warnToErr = (message: string): void => {
    const line = `${COLOR.yellow}${TDD_GLYPHS.warn}${COLOR.reset} ${message}`
    err(`${line}\n`)
    log.append(`${stripAnsi(line)}\n`)
  }

  const runStages = (): RunStages => ({
    scaffold: run.scaffold,
    stage1: run.tw,
    stage2: run.im,
    smoke: run.st,
    reviewer: run.rv,
    patchStage1: run.patchTw,
    patchStage2: run.patchIm,
    coverageSeconds: run.cg.duration,
  })

  const updateStatus = (stage: string, statusState: string): void => {
    run.currentStage = stage
    const agent = (record: AgentRecord): string => `{"duration": ${record.duration ?? 'null'}, "result": "${record.result}"}`
    writeStatus(
      state(run.statusFilename),
      renderStatusJson(
        [
          { key: 'issue', json: jsonText(run.issue.length > 0 ? run.issue : 'null') },
          // El titulo llega crudo de la respuesta de `gh`, con sus escapes JSON intactos.
          { key: 'title', json: jsonText(run.issueTitle) },
          { key: 'pipeline', json: '"tdd"' },
          { key: 'variant', json: run.variant.length > 0 ? jsonText(run.variant) : 'null' },
          { key: 'identity', json: run.identityJson },
          { key: 'runtime', json: run.runtime.length > 0 ? jsonText(run.runtime) : 'null' },
          { key: 'started', json: jsonText(run.timestamp) },
          { key: 'stage', json: jsonText(stage) },
          { key: 'state', json: jsonText(statusState) },
          { key: 'updated', json: jsonText(localIsoSeconds(now())) },
          { key: 'worktree', json: jsonText(run.worktree) },
          { key: 'log', json: jsonText(currentLog()) },
          {
            key: 'agents',
            members: [
              { key: 'test-writer', json: agent(run.tw) },
              { key: 'implementer', json: agent(run.im) },
              { key: 'smoke-test-writer', json: agent(run.st) },
              { key: 'reviewer', json: agent(run.rv) },
              { key: 'coverage-gate', json: agent(run.cg) },
            ],
          },
          { key: 'tests', json: String(testsJsonValue(run.tests)) },
          { key: 'pr', json: run.pr.length > 0 ? jsonText(run.pr) : 'null' },
          { key: 'last_error', json: run.error.length > 0 ? jsonText(run.error) : 'null' },
        ],
        run.hold,
      ),
    )
  }

  const recordFailedHistory = (abortState: string): void => {
    let entry = ''
    try {
      let agents: JqValue = null
      try {
        agents = parseJq(buildAgentsHistoryJson(abortHistoryStages(runStages(), run.agents)))
      } catch {
        agents = null
      }
      const value: JqValue = {
        issue: run.issue,
        title: run.issueTitle,
        pipeline: 'tdd',
        variant: run.variant.length > 0 ? run.variant : null,
        identity: parseJq(run.identityJson),
        runtime: run.runtime.length > 0 ? run.runtime : null,
        started: run.timestamp,
        finished: localIsoSeconds(now()),
        state: abortState,
        stage: run.currentStage,
        agents,
        error: run.error,
        log: run.logFileAbs.length > 0 ? run.logFileAbs : null,
      }
      entry = `${dumpJq(value)}\n`
    } catch {
      entry = ''
    }
    appendText(run.historyFile, entry)
  }

  const abort: Abort = createAbort({
    log,
    tailLines: TAIL_LOG_LINES,
    worktree: () => run.worktree,
    onStart: (message) => {
      run.error = message.replaceAll('\n', ' ')
    },
    record: (_message, abortState) => {
      if (!run.pipelineDirReady) return
      updateStatus(run.currentStage, abortState)
      recordFailedHistory(abortState)
    },
  })

  let runnerChild: ChildProcess | null = null

  const finalize = (): void => {
    if (run.tmpDir.length > 0) rmSync(run.tmpDir, { recursive: true, force: true })
  }

  /** `git` cuya salida se necesita: si falla, el pipeline termina con su codigo, sin mas mensajes. */
  const git = (args: string[]): string => {
    const result = deps.run('git', args, options)
    if (result.status !== 0) {
      if (result.stderr.length > 0) err(result.stderr)
      throw new PipelineExit(result.status ?? 1)
    }
    return chomp(result.stdout)
  }

  const main = async (): Promise<number> => {
    // --- Argumentos ---
    const argv = [...deps.argv]
    if (argv.length === 0) {
      out(
        `Uso: ${deps.scriptPath} [--issue NUM | --file PATH | NUM] [--from-stage N] [--status-file NOMBRE] [--scaffold-domain KEBAB] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]\n`,
      )
      return 1
    }
    let inputFile = ''
    let fromStage = '1'
    let scaffoldDomain = ''
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
      if (arg === '--issue') run.issue = valueOf('Falta el número de issue')
      else if (arg === '--file') inputFile = valueOf('Falta la ruta del archivo')
      else if (arg === '--from-stage') fromStage = valueOf('Falta el número de stage')
      else if (arg === '--status-file') run.statusFilename = valueOf('Falta el nombre del archivo de status')
      else if (arg === '--scaffold-domain') scaffoldDomain = valueOf('Falta el nombre del dominio para --scaffold-domain')
      else if (arg === '--models') modelsSpec = valueOf('Falta el valor de --models')
      else if (arg === '--variant') run.variant = valueOf('Falta el valor de --variant')
      else if (/^[0-9]/.test(arg)) {
        positional.push(arg)
        argv.shift()
      } else abort(`Argumento no reconocido: ${arg}`)
    }
    if (positional.length > 0 && run.issue.length === 0) run.issue = positional[0] ?? ''
    const issue = run.issue
    const hu = issue.length > 0 ? issue : '?'

    if (!/^[1-4]$/.test(fromStage)) abort(`--from-stage debe ser 1, 2, 3 o 4 (recibido: ${fromStage})`)
    const stageFrom = Number(fromStage)

    // --- Variante: se valida antes de crear el worktree y de nombrar cualquier archivo de la corrida ---
    const variant = run.variant
    let issueLogTag = issue
    if (variant.length > 0) {
      const invalid = validateVariantLabel(variant)
      if (invalid !== null) abort(`--variant mal formado: ${invalid}`)
      issueLogTag = `${issue}-${variant}`
      // Dos variantes lanzadas en el mismo segundo comparten marca de tiempo.
      run.logFile = join(logDir, `pipeline-${timestamp}-${variant}.log`)
    }
    const variantJson = variant.length > 0 ? jsonText(variant) : 'null'

    if (run.statusFilename.length === 0) {
      if (issue.length > 0) run.statusFilename = variant.length > 0 ? `pipeline-status-tdd-${issue}-${variant}.json` : `pipeline-status-tdd-${issue}.json`
      else run.statusFilename = 'pipeline-status-tdd.json'
    }

    for (const command of ['gh', 'git', 'dotnet']) {
      if (!deps.hasCommand(command)) abort(`Falta comando requerido: ${command}`)
    }

    // --- Directorio del pipeline: desde aqui un aborto deja status e historial ---
    const logDirAbs = join(stateDir, 'logs')
    run.logFileAbs = state(join('logs', basename(run.logFile)))
    run.logFile = run.logFileAbs
    run.eventsLog = state('events.log')
    run.historyFile = state('pipeline-history.jsonl')
    run.pipelineDirReady = true
    writeFileSync(run.logFileAbs, `Pipeline iniciado: ${timestamp}\n`)
    appendText(run.eventsLog, `─── SESSION ${timestamp} issue:${issue.length > 0 ? issue : 'file'} from-stage:${fromStage} ───\n`)

    // --- Modelos: un valor malformado aborta antes de que exista el worktree ---
    const parsedModels = parseStageModels(modelsSpec)
    if ('error' in parsedModels) abort(`--models mal formado: ${parsedModels.error}`)
    const stageModels: StageModels = parsedModels.models
    if (stageModels.size > 0) {
      const summary = formatStageModelsForLog(stageModels)
      log.log(`Modelos por stage (--models): ${summary}`)
      eventLine(`MODELS: ${summary}`)
    }

    // --- Frontera neutral, antes de crear el worktree ---
    const timeout = nonEmpty(env.MEFISTO_AGENT_TIMEOUT_SECONDS) ?? '1800'
    if (!/^[0-9]+$/.test(timeout)) abort(`MEFISTO_AGENT_TIMEOUT_SECONDS '${timeout}' no es un entero`)
    if (Number(timeout) <= 0) abort('MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0')
    const runner = resolveRunnerCommand(env, runtimeDir)
    if ('error' in runner) abort(runner.error)
    const resolved = await resolveRuntime('', env, deps.hasCommand)
    if ('error' in resolved) abort(`No se pudo resolver el runtime activo: ${resolved.error}`)
    const runtime = resolved.runtime
    run.runtime = runtime
    const identity = getHarnessIdentity(runtime)
    run.identityJson = harnessIdentityJson(identity)
    if (!(await runtimeCliAvailable(runtime, { env, hasCommand: deps.hasCommand }))) {
      abort(`Falta el CLI del runtime resuelto ('${runtime}')`)
    }
    if (identity.identity_state !== 'complete') {
      log.warn('Identidad de distribucion degradada: metadata ausente o invalida; version/commit se registran como null')
    }

    // Sin --models deciden el mapping del consumidor y el adaptador, o se hereda.
    const consumerModelsFile = join(git(['rev-parse', '--show-toplevel']), '.mefisto', 'models.json')

    /** Modelo de un stage: la clave fina gana, luego el agente relanzado (`patch-*`), luego el mapping. */
    const resolveTddModel = async (key: string, agentId: string, profile: string): Promise<string> => {
      const explicit = resolveStageModel(stageModels, key, resolveStageModel(stageModels, agentId, ''))
      if (explicit.length > 0) {
        eventLine(`MODELS: ${key} runtime=${runtime} perfil=${profile} solicitado='${explicit}' resuelto='${explicit}' (override --models)`)
        return explicit
      }
      const model = await resolveModel({ runtime, agentId, profile, mappingFile: consumerModelsFile, env })
      if ('error' in model) {
        abort(`No se pudo resolver el modelo de ${agentId} (perfil ${profile}): ${model.error.length > 0 ? model.error : 'motivo desconocido'}`)
      }
      eventLine(
        `MODELS: ${key} runtime=${runtime} perfil=${profile} solicitado=<automatico> resuelto='${model.model.length > 0 ? model.model : '<heredado>'}'`,
      )
      return model.model
    }
    /** Effort del agente que corre; la clave solo nombra la linea de events.log. */
    const resolveTddEffort = async (key: string, agentId: string): Promise<string> => {
      const effort = await resolvePipelineAgentEffort({
        key,
        agentId,
        runtime,
        mappingFile: consumerModelsFile,
        eventsLog: run.eventsLog,
        env,
        now: now(),
      })
      if ('error' in effort) {
        abort(`No se pudo resolver el effort de ${agentId}: MEFISTO_EFFORTS_ERROR=${effort.error.length > 0 ? effort.error : 'motivo desconocido'}`)
      }
      return effort.effort
    }
    const profileOf = (agent: string): string => {
      const profile = tddAgentProfile(agent)
      if (profile === null) abort(`Agente '${agent}' fuera de la tabla de perfiles TDD (CA-1, issue #1362)`)
      return profile
    }

    if (variant.length > 0) {
      log.log(`Modo variante: '${variant}' -- sin push, sin PR, sin comentario al issue (CA-3); rama queda local`)
      eventLine(`VARIANT: ${variant}`)
    }

    try {
      run.tmpDir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'mefisto-tdd.'))
    } catch {
      abort('No se pudo crear el directorio temporal del pipeline')
    }

    // --- Contexto del issue o de la HU ---
    log.header('Preparando contexto')
    let issueContext = ''
    if (issue.length > 0) {
      log.log(`Descargando issue #${issue}...`)
      const rawIssue = viewIssue(issue, 'number,title,body,state,labels', { run: deps.run, logFile: currentLog(), cwd, env: childEnv })
      if (rawIssue === null) abort(`No se pudo obtener el issue #${issue}`)
      const view = parseIssueView(rawIssue)
      if (view.state !== 'OPEN') abort(`El issue #${issue} está ${view.state} — solo se procesan issues abiertos.`)
      if (view.title === null) throw new PipelineExit(1)
      run.issueTitle = view.title
      issueContext = `# Issue #${issue}: ${view.title}\n\n${view.body}`
      log.log(`Issue: ${view.title}`)
      run.agents = stageAgentsFor(issueLabelNames(rawIssue))
      if (run.agents.isProjection) {
        log.log(`Label tipo:projection detectado — despachando trio read-side (${run.agents.stage1Agent} / ${run.agents.stage2Agent})`)
      }
    } else if (inputFile.length > 0) {
      const file = resolve(cwd, inputFile)
      if (!isFile(file)) abort(`Archivo no encontrado: ${inputFile}`)
      run.issueTitle = basename(inputFile).replace(/(.)\.md$/, '$1')
      issueContext = chomp(readFileSync(file, 'utf8'))
      log.log(`Archivo: ${inputFile}`)
    }
    const issueTitle = run.issueTitle
    const { stage1Agent, stage2Agent, stage1Label, stage2Label, isProjection } = run.agents
    writeFileSync(state('input.md'), `${issueContext}\n`)

    // --- Worktree ---
    log.header('Preparando worktree')
    const repoRoot = resolve(git(['rev-parse', '--show-toplevel']))
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    let branch = issue.length > 0 ? issueBranchName(issue, tddIssueSlug(issueTitle)) : `worktree-tdd-${tddFileSlug(issueTitle)}`
    // Corridas simultaneas del mismo issue no comparten worktree ni rama.
    if (variant.length > 0) branch = `${branch}-${variant}`
    run.worktree = pipelineWorktreePath(repoRoot, branch)
    const worktreeTools = { run: deps.run, runLogged: deps.runLogged, log, abort, cwd, env: childEnv }
    const query = { run: deps.run, env: childEnv }
    const worktreeGit = (args: string[]): string => git(['-C', run.worktree, ...args])
    const worktreeLogged = (args: string[]): number | null => deps.runLogged('git', ['-C', run.worktree, ...args], currentLog(), options)

    const launchRunner =
      deps.launchRunner ??
      runnerProcess({
        runner: runner.runner,
        env: childEnv,
        cwd,
        onChild: (child) => {
          runnerChild = child
        },
      })

    /** Invocacion sin politicas de espera ni reintento: Stage 0 y remediaciones del Stage 4. */
    const invokeAgentOnce = async (
      agent: string,
      promptFile: string,
      eventsFile: string,
      stageLog: string,
      model: string,
      effort: string,
    ): Promise<{ exit: number; duration: number; metrics: string }> => {
      const systemFile = join(run.tmpDir, 'noninteractive.system.md')
      if (!isFile(systemFile)) writeFileSync(systemFile, `${NON_INTERACTIVE_SYSTEM_PROMPT}\n`)
      const start = epoch()
      const args = [
        '--runtime', runtime,
        '--agent', agent,
        '--cwd', run.worktree,
        '--prompt-file', promptFile,
        '--system-file', systemFile,
        '--event-log', eventsFile,
        '--events-log', run.eventsLog,
        '--redact-observability',
        '--timeout', timeout,
      ]
      if (model.length > 0) args.push('--model', model)
      if (effort.length > 0) args.push('--effort', effort)
      const exit = await launchRunner(args, `${eventsFile.replace(/\.events\.jsonl$/, '')}.runner.log`)
      deriveStageLogFromStream(eventsFile, '', stageLog)
      const metrics = computeStageMetrics(eventsFile)
      return { exit, duration: epoch() - start, metrics }
    }

    const enrich = (eventsFile: string, baseMetrics: string, stage: string, agent: string, profile: string): string =>
      enrichStageMetrics({
        pipeline: 'tdd',
        eventsFile,
        baseMetrics,
        issue,
        variantJson,
        stage,
        agent,
        profile,
        identityJson: run.identityJson,
      })
    const saveMetrics = (stage: string, agent: string, metrics: string): void => {
      try {
        writeFileSync(state(join('metrics', `tdd-${timestamp}-issue-${issueLogTag}-stage-${stage}-${agent}.json`)), `${metrics}\n`)
      } catch {
        // El respaldo en disco no detiene la corrida.
      }
    }

    let snapshot: string
    if (stageFrom > 1) {
      run.worktree = resumeWorktree({ repoRoot, branch, fromStage, texts: TDD_WORKTREE_TEXTS }, worktreeTools)
      snapshot = worktreeGit(['merge-base', 'HEAD', 'main'])
      log.log(`Snapshot detectado: ${snapshot}`)
    } else {
      run.worktree = createWorktree({ repoRoot, branch, currentBranch, texts: TDD_WORKTREE_TEXTS }, worktreeTools)
      updateStatus('setup', 'running')
      snapshot = worktreeGit(['rev-parse', 'HEAD'])
      log.log(`Snapshot: ${snapshot}`)

      // --- Stage 0: scaffold de un dominio nuevo ---
      if (scaffoldDomain.length > 0) {
        log.header(`Stage 0: Scaffold del dominio '${scaffoldDomain}'`)
        updateStatus('scaffold', 'running')
        const stageLog = join(logDirAbs, `stage-0-scaffold-${timestamp}.log`)
        const eventsFile = join(logDirAbs, `stage-0-scaffold-${timestamp}.events.jsonl`)
        const promptFile = join(run.tmpDir, '0-domain-scaffolder.prompt.md')
        eventLine('=== STAGE 0: domain-scaffolder ===')
        writeFileSync(promptFile, scaffoldPrompt(scaffoldDomain))
        const profile = profileOf('domain-scaffolder')
        const model = await resolveTddModel('domain-scaffolder', 'domain-scaffolder', profile)
        const effort = await resolveTddEffort('domain-scaffolder', 'domain-scaffolder')
        log.log(`Invocando domain-scaffolder (modelo: ${model.length > 0 ? model : '<heredado>'})...`)
        const result = await invokeAgentOnce('domain-scaffolder', promptFile, eventsFile, stageLog, model, effort)
        run.scaffold = { duration: result.duration, metrics: enrich(eventsFile, result.metrics, '0', 'domain-scaffolder', profile) }
        saveMetrics('0', 'domain-scaffolder', run.scaffold.metrics)
        if (result.exit !== 0 || !agentEventsCompletedSuccessfully(eventsFile)) {
          eventLine(`FALLO domain-scaffolder (${result.duration}s, exit ${result.exit})`)
          abort(`El scaffold del dominio '${scaffoldDomain}' fallo despues de ${result.duration}s. Revisa: ${stageLog}`)
        }
        const project = `${prefix}.${pascalCase(scaffoldDomain)}`
        if (!isDirectory(join(run.worktree, 'src', project))) abort(`El scaffold no creo src/${project} — revisa: ${stageLog}`)
        eventLine(`OK domain-scaffolder (${result.duration}s)`)
        log.success(`Scaffold del dominio '${scaffoldDomain}' completado en ${result.duration}s`)
        updateStatus('scaffold', 'completed')
        // Los diffs de los stages siguientes solo muestran la implementacion.
        snapshot = worktreeGit(['rev-parse', 'HEAD'])
        log.log(`Snapshot actualizado post-scaffold: ${snapshot}`)
      }
    }
    const worktree = run.worktree

    // Agentes anteriores a #1387 aun escriben resumenes en el estado legacy.
    statePath(join('summaries', '.state'), worktree)
    mkdirSync(join(worktree, basename(dirname(legacyStateDir)), basename(legacyStateDir), 'summaries'), { recursive: true })

    // Senales fuera de `.claude/` (MEF-ADR-0017): el runtime intercepta las escrituras ahi.
    let refactorSignal = join(worktree, 'pipeline-state', 'refactor-signal.md')
    const legacyRefactorSignal = join(worktree, '.claude', 'pipeline', 'refactor-signal.md')
    if (!isFile(refactorSignal) && isFile(legacyRefactorSignal)) refactorSignal = legacyRefactorSignal
    let isRefactor = false
    let refactorJustification = ''
    let baselineTests = '?'
    let removed = 0
    if (isFile(refactorSignal)) {
      isRefactor = true
      refactorJustification = signalField(readOrNull(refactorSignal), 'JUSTIFICATION', 'no especificada')
      log.log(`Señal de refactoring detectada (pre-existente): ${refactorJustification}`)
    }
    // La fase roja no aplicable solo se honra en la rama read-side.
    const noRedSignal = join(worktree, 'pipeline-state', 'no-red-signal.md')
    let noRedJustification: string | null = null
    if (stage1Agent === 'projection-test-writer' && isFile(noRedSignal)) {
      noRedJustification = signalField(readOrNull(noRedSignal), 'JUSTIFICATION', 'no especificada')
      log.log(`Señal de fase roja no aplicable detectada (pre-existente): ${noRedJustification}`)
    }
    mkdirSync(join(worktree, 'pipeline-state'), { recursive: true })

    let isSmokeOnly = false
    let smokeOnlyFiles: string[] = []
    let smokeAnomaly = ''
    let smokeInvokers: SmokeInvoker[] = []
    let hasBlockage = false
    let blockageResolved = false
    let reviewerTouchedTests: string[] = []
    let notEvaluatedFiles: string[] = []
    let coverageTable = ''
    let patchApplied = false
    let gapsRemaining = 0
    let remediationSummary = ''

    const summaryRel = (stage: string, agent: string): string => join('summaries', `stage-${stage}-${agent}.md`)
    const blockageReportFile = (): string | null => stateReadFirst('blockage-report.md', worktree)

    const recordFor = (agent: string): AgentRecord | null => {
      if (agent === 'test-writer' || agent === 'projection-test-writer') return run.tw
      if (agent === 'implementer' || agent === 'projection-implementer') return run.im
      if (agent === 'smoke-test-writer') return run.st
      if (agent === 'reviewer') return run.rv
      return null
    }
    const recordOfStage = (stage: string): AgentRecord | null =>
      stage === '1' ? run.tw : stage === '2' ? run.im : stage === '2b' ? run.st : stage === '3' ? run.rv : null

    /** Corre los tests del consumidor, deja su salida en el log y la devuelve con el codigo. */
    const runTests = (extraArgs: string[] = []): { output: string; status: number } => {
      const tests = runTestsProjects(worktree, prefix, extraArgs, deps.runDotnet)
      const output = chomp(tests.output)
      log.append(`${output}\n`)
      return { output, status: tests.status }
    }
    const dotnetBuild = (path: string): boolean => deps.runLogged('dotnet', ['build', path], currentLog(), options) === 0

    /**
     * Invoca un agente con la politica comun de reintento, espera y reanudacion, y devuelve lo que
     * tardo sin contar esperas. Un fallo ordinario se perdona si dejo trabajo que pasa su gate.
     */
    const runAgent = async (stage: string, agent: string, basePrompt: string): Promise<number> => {
      const name = `stage-${stage}-${agent}-${timestamp}-issue-${issueLogTag}`
      const logBase = join(logDirAbs, name)
      const logStage = `${logBase}.log`
      const summaryPath = statePath(summaryRel(stage, agent), worktree)
      const prompt = `${basePrompt}\n\nAl cerrar este stage, deja tu resumen en: ${summaryPath}`
      const entryCommit = worktreeGit(['rev-parse', 'HEAD'])
      // Un resumen de una corrida anterior no prueba que la sonda reanudada termino su contrato.
      rmSync(summaryPath, { force: true })
      const legacySummary = stateReadFirst(summaryRel(stage, agent), worktree)
      if (legacySummary !== null) rmSync(legacySummary, { force: true })
      eventLine(`=== STAGE ${stage}: ${agent} ===`)
      if (agent !== 'smoke-test-writer') {
        const record = recordFor(agent)
        if (record !== null) record.result = 'running'
      }
      const profile = profileOf(agent)
      const model = await resolveTddModel(agent, agent, profile)
      const effort = await resolveTddEffort(agent, agent)
      updateStatus(`${stage}-${agent}`, 'running')
      log.log(`Invocando ${agent} (modelo: ${model.length > 0 ? model : '<heredado>'})...`)

      const hasWork = (): boolean =>
        hasCommittedChanges(query, worktree, entryCommit, 'HEAD', ['.', ...PIPELINE_OWN_WRITES]) ||
        hasPendingChanges(query, worktree, ['tests/', 'src/', ...PIPELINE_OWN_WRITES])
      let metrics = 'null'

      const onEvent = (event: AgentRunEvent): void => {
        switch (event.kind) {
          case 'attempt':
            metrics = enrich(event.eventsFile, computeStageMetrics(event.eventsFile), stage, agent, profile)
            saveMetrics(stage, agent, metrics)
            break
          case 'denial-retry':
            log.warn(`${agent}: ${event.denials} denegacion(es) neutrales sin trabajo; reintentando una vez desde cero`)
            eventLine(`RETRY ${agent}: denials=${event.denials}`)
            break
          case 'failure':
            log.log(`${agent} falló después de ${event.elapsedSeconds}s — tipo: ${event.failureType}`)
            eventLine(`FALLO ${agent}: ${event.failureType}`)
            break
          case 'hold':
            run.hold = event.hold
            updateStatus(`${stage}-${agent}`, 'hold')
            break
          case 'hold-waited':
            run.hold = { ...run.hold, accumulatedSeconds: event.holdSeconds }
            break
          case 'resume-degraded':
            log.warn(`${agent}: la sesion reanudada termino sin resumen; se degrada permanentemente a inicio limpio`)
            break
          case 'resume-no-session':
            log.warn(`${agent}: terminal sin session_id; la sonda inicia de cero`)
            break
          case 'resume-unsupported':
            log.warn(`${agent}: runtime sin capacidad de reanudacion; la sonda inicia de cero`)
            break
          default:
            break
        }
      }

      const outcome = await runAgentWithPolicy(
        {
          runtime,
          agentId: agent,
          worktree,
          prompt,
          promptFile: join(run.tmpDir, `${stage}-${agent}.prompt.md`),
          systemFile: join(run.tmpDir, `${stage}-${agent}.system.md`),
          resumePromptFile: (attempt) => join(run.tmpDir, `${stage}-${agent}-resume-${attempt}.prompt.md`),
          eventsFile: (attempt) => `${logBase}-attempt-${attempt}.events.jsonl`,
          stageLog: () => logStage,
          runnerOutput: () => join(run.tmpDir, `${stage}-${agent}.runner.log`),
          extraArgs: ['--events-log', run.eventsLog, '--redact-observability', '--timeout', timeout],
          model,
          effort,
          eventsLog: run.eventsLog,
        },
        {
          denialRetry: { hasWork },
          resumeEvidence: () => isNonEmptyFile(stateReadFirst(summaryRel(stage, agent), worktree)),
          supportsResume: () => runtimeSupportsResume(runtime, { env }),
        },
        { launchRunner, onEvent, env, now, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
      )
      run.hold = noHold(outcome.holdSeconds)

      let failureType = outcome.failureType
      if (failureType.length > 0) {
        let recoverable = false
        if (!INCOMPLETE_FAILURES.includes(failureType) && hasWork()) {
          if (stage === '1') recoverable = dotnetBuild(worktree)
          else if (stage === '2' || stage === '3' || stage === 'merge') {
            const tests = runTestsProjects(worktree, prefix, [], deps.runDotnet)
            log.append(tests.output)
            recoverable = tests.status === 0
          }
        }
        if (recoverable) {
          log.warn(`${agent}: runner retorno ${failureType} pero hay trabajo util completado — continuando`)
          eventLine(`RECUPERADO ${agent}: trabajo util detectado post-${failureType}, continuando`)
          failureType = ''
        } else {
          const record = recordFor(agent)
          if (record !== null) {
            record.duration = outcome.elapsedSeconds
            record.result = 'failed'
          }
          const stageRecord = recordOfStage(stage)
          if (stageRecord !== null) stageRecord.metrics = metrics
          updateStatus(`${stage}-${agent}`, 'failed')
          if (INCOMPLETE_FAILURES.includes(failureType)) abort(`${agent} falló (${failureType}); se descarta trabajo parcial`)
          abort(`${agent} falló (${failureType}). Log completo: ${logStage}`)
        }
      }
      const stageRecord = recordOfStage(stage)
      if (stageRecord !== null) stageRecord.metrics = metrics
      const duration = outcome.elapsedSeconds - outcome.holdSeconds
      log.log(`${agent} completado en ${duration}s`)
      return duration
    }

    /** Commit de seguridad de lo que el agente dejo sin commitear en `tests/` y `src/`. */
    const autoCommit = (phase: string, message: string): void => {
      const result = autoCommitIfNeeded(
        {
          worktree,
          message,
          pathspec: ['tests/', 'src/'],
          onPending: () => log.log(`El agente no commitió cambios en tests/src. Haciendo commit automático (fase ${phase})...`),
        },
        worktreeTools,
      )
      // Un `git add` que falla (una de las dos carpetas no existe) corta la corrida, como `set -e`.
      if (result !== null && result.addStatus !== 0) throw new PipelineExit(result.addStatus ?? 1)
    }

    // `echo "$x" | while read -r l`: cada linea sin los blancos de sus extremos.
    const logEach = (text: string, mark: string): void => {
      for (const line of text.split('\n')) log.log(`${mark}${line.replace(/^[ \t]+|[ \t]+$/g, '')}`)
    }
    // `printf '%s' "$x" | while read -r l` nunca procesa la ultima linea, que llega sin salto.
    const logEachButLast = (text: string, mark: string): void => logEach(text.split('\n').slice(0, -1).join('\n'), mark)

    // --- Stage 1: test-writer (fase roja) ---
    let smokeDetectOut = ''
    if (stageFrom <= 1) {
      log.header(`Stage 1: ${stage1Label} (fase roja)`)
      const duration = await runAgent('1', stage1Agent, stage1Prompt({ projectName, issueContext, stage1Agent }))

      // La senal es la unica evidencia esperada de un refactor puro: se busca antes del gate de trabajo.
      if (!isFile(refactorSignal) && isFile(legacyRefactorSignal)) refactorSignal = legacyRefactorSignal
      if (isFile(refactorSignal) && !isRefactor) {
        isRefactor = true
        const content = readOrNull(refactorSignal)
        refactorJustification = signalField(content, 'JUSTIFICATION', 'no especificada')
        const declared = removedTests(content)
        if ('invalid' in declared) {
          log.warn(`REMOVED_TESTS='${declared.invalid}' en la señal no es un entero valido — se usa 0`)
          removed = 0
        } else removed = declared.value
        log.log(`Señal de refactoring detectada: ${refactorJustification} (REMOVED_TESTS=${removed})`)
      }
      if (stage1Agent === 'projection-test-writer' && isFile(noRedSignal) && noRedJustification === null) {
        noRedJustification = signalField(readOrNull(noRedSignal), 'JUSTIFICATION', 'no especificada')
        log.log(`Señal de fase roja no aplicable detectada: ${noRedJustification}`)
      }

      if (!isRefactor) {
        const hasChanges =
          hasCommittedChanges(query, worktree, snapshot) || hasPendingChanges(query, worktree, ['tests/', 'src/'])
        const stage1Log = join(logDirAbs, `stage-1-${stage1Agent}-${timestamp}-issue-${issueLogTag}.log`)
        const output = stage1Output(false, hasChanges, isFile(stage1Log) ? readOrNull(stage1Log) : null)
        if (output === 'abort-signal-missing') {
          abort(
            `El ${stage1Agent} detecto refactor puro pero no creo el archivo señal en ${refactorSignal} (ni en la ubicacion legacy). Probable causa: el runtime intercepto la escritura. Revisa el log: ${stage1Log}`,
          )
        }
        if (output === 'abort-nothing') {
          abort(`El ${stage1Agent} no generó ningún archivo. Verifica que el agente '${stage1Agent}' está disponible en el runtime activo.`)
        }
      }

      // Gate 1a: debe compilar.
      log.log('Gate: verificando compilación...')
      if (!dotnetBuild(worktree)) {
        abort(`Stage 1 fallido: el proyecto no compila después del ${stage1Agent}. Revisa ${logDirAbs}/stage-1-${stage1Agent}.log`)
      }

      if (!isRefactor) {
        const detection = detectSmokeOnly(worktree, snapshot, prefix, false, deps.run)
        smokeDetectOut = chomp(changedFilesText(detection.files))
        if (detection.smokeOnly) {
          isSmokeOnly = true
          smokeOnlyFiles = smokeDetectOut.split('\n')
          log.log('Issue de solo smoke detectado (archivos que lo decidieron):')
          if (smokeOnlyFiles.length > 1) logEachButLast(smokeDetectOut, '  ')
          eventLine('SMOKE_ONLY detectado')
        }
      }

      if (isSmokeOnly) {
        log.log('fase roja no aplica: solo smoke tests (corren post-deploy, MEF-ADR-0013)')
      } else if (!isRefactor) {
        log.log('Gate: verificando fase roja (tests deben fallar)...')
        const tests = runTests(['--no-build'])
        const gate = redGate(tests.status, noRedJustification !== null)
        if (gate === 'continue-no-red') {
          log.log(`fase roja no aplicable: ${noRedJustification ?? ''}`)
        } else if (gate === 'abort-all-green') {
          const smokeLines = smokeDetectOut.split('\n')
          const otherList = smokeLines.some((line) => line.startsWith('smoke: '))
            ? smokeLines.filter((line) => line.startsWith('otro: ')).map((line) => line.slice('otro: '.length)).join(',')
            : 'ninguno de los cambios cae bajo tests/*.SmokeTests/'
          abort(
            `Stage 1 fallido: todos los tests pasan (exit code: 0). Opciones: (1) el ${stage1Agent} escribio implementacion real en lugar de stubs: reemplazala por stubs que hagan fallar los tests; (2) en tipo:projection, la fase roja estructuralmente inalcanzable se señaliza con pipeline-state/no-red-signal.md (JUSTIFICATION=<razon>); (3) el carril solo-smoke se detecta solo cuando todo cambio cae en tests/*.SmokeTests/, docs/ o pipeline-state/ y hay al menos un archivo smoke. Lo que impidio detectarlo: ${otherList}.`,
          )
        } else if (gate === 'abort-no-tests') {
          abort(`Stage 1 fallido: no se encontraron tests para ejecutar (exit code: 8) — el ${stage1Agent} no genero tests validos`)
        } else {
          log.log(`Fase roja confirmada (exit code: ${tests.status})`)
          // Aviso, no aborto: tests que ya estaban en rojo y el test-writer no toco (write-side).
          if (!isProjection) {
            const warningFile = statePath('preexisting-red-warning.md', worktree)
            rmSync(warningFile, { force: true })
            const detected = detectPreexistingRedTests(worktree, snapshot, tests.output, deps.run)
            if (detected.status !== 0) {
              log.warn('No se pudo analizar si hay tests preexistentes en rojo (salida no parseable o snapshot no disponible); se continua')
            } else if (detected.tests.length > 0) {
              log.warn(`Tests PREEXISTENTES en rojo que el ${stage1Agent} no modifico (no se aborta):`)
              for (const red of detected.tests) log.warn(`  - ${red.test} (${red.file})`)
              try {
                writeFileSync(warningFile, preexistingRedWarning(detected.tests))
              } catch {
                log.warn('No se pudo escribir el aviso de tests preexistentes en rojo')
              }
            }
          }
        }
      }

      autoCommit('roja', `test(hu-${hu}): tests fase roja`)

      if (isRefactor) {
        log.log('Gate: verificando baseline verde para refactoring...')
        const tests = runTests()
        if (tests.status !== 0) {
          abort(`Refactoring señalizado pero hay tests fallando (exit code: ${tests.status}). No se puede refactorizar sobre una base roja.`)
        }
        baselineTests = String(extractTestCount(tests.output) ?? '?')
        log.log(`Baseline refactoring: ${baselineTests} tests pasando`)
        log.success('Baseline verde confirmado')
      }

      run.tw.duration = duration
      run.tw.result = 'passed'
      updateStatus(`1-${stage1Agent}`, 'passed')
      if (isSmokeOnly) {
        eventLine(`SMOKE_ONLY ${stage1Agent} passed: fase roja no aplica, solo smoke tests (corren post-deploy, MEF-ADR-0013)`)
        log.success('Stage 1 completado — fase roja no aplica: solo smoke tests (corren post-deploy, MEF-ADR-0013)')
      } else if (noRedJustification !== null) {
        log.success(`Stage 1 completado — fase roja no aplicable (señalizada por el ${stage1Agent})`)
      } else {
        log.success('Stage 1 completado — fase roja confirmada')
      }
    } else {
      log.log(`Saltando Stage 1 (--from-stage ${fromStage})`)
      if (!isRefactor) {
        const detection = detectSmokeOnly(worktree, snapshot, prefix, true, deps.run)
        if (detection.smokeOnly) {
          isSmokeOnly = true
          smokeDetectOut = chomp(changedFilesText(detection.files))
          smokeOnlyFiles = smokeDetectOut.split('\n')
          log.log('Issue de solo smoke detectado sobre SNAPSHOT..HEAD (archivos que lo decidieron):')
          if (smokeOnlyFiles.length > 1) logEachButLast(smokeDetectOut, '  ')
          eventLine(`SMOKE_ONLY detectado (--from-stage ${fromStage})`)
        }
      }
    }

    let stage1Files = ''
    if (!isRefactor) {
      stage1Files = worktreeGit(['diff', '--name-only', `${snapshot}..HEAD`])
      if (stage1Files.length === 0) {
        abort(`No se detectaron archivos nuevos después de Stage 1. El ${stage1Agent} no generó ni commitió cambios válidos. Verifica el log del ${stage1Agent}.`)
      }
      log.log(`Archivos del ${stage1Agent}:`)
      logEach(stage1Files, '  + ')
    } else {
      log.log('Refactoring puro: no se esperan archivos de test nuevos')
    }

    // --- Stage 2: implementer (fase verde) ---
    if (isRefactor) {
      log.log('Saltando Stage 2 (refactoring puro — no hay tests que hacer pasar)')
      run.im.result = 'skipped'
      updateStatus(`2-${stage2Agent}`, 'skipped')
    } else if (stageFrom <= 2) {
      log.header(`Stage 2: ${stage2Label} (fase verde)`)
      const blockageCanonical = statePath('blockage-report.md', worktree)
      const prompt = isSmokeOnly
        ? stage2SmokeOnlyPrompt({ projectName, issueContext, stage1Agent, stage1Files })
        : stage2Prompt({ projectName, issueContext, stage1Agent, stage2Agent, stage1Files, blockageReport: blockageCanonical })
      const baseHead = chomp(deps.run('git', ['-C', worktree, 'rev-parse', 'HEAD'], options).stdout)
      const duration = await runAgent('2', stage2Agent, prompt)

      let tests: { output: string; status: number }
      if (isSmokeOnly) {
        log.log('Gate: modo documental (solo smoke) — sin src/ ni tests/, compila, tests exit 0 u 8...')
        const touched = [
          ...lines(deps.run('git', ['-C', worktree, 'diff', '--name-only', baseHead], options).stdout),
          ...lines(deps.run('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'], options).stdout),
        ]
        const forbidden = [...new Set(touched)].sort(byBytes).filter((path) => /^(src|tests)\//.test(path))
        if (forbidden.length > 0) {
          abort(`Stage 2 fallido (solo smoke, modo documental): el ${stage2Agent} toco src/ o tests/: ${forbidden.join(',')}`)
        }
        if (!dotnetBuild(worktree)) {
          abort(`Stage 2 fallido (solo smoke): el proyecto no compila despues del ${stage2Agent}. Revisa ${logDirAbs}/stage-2-${stage2Agent}.log`)
        }
        tests = runTests()
        if (tests.status === 8) tests.status = 0
      } else {
        log.log('Gate: verificando fase verde...')
        tests = runTests()
      }
      const gate = greenGate(tests.status, (() => {
        const file = blockageReportFile()
        return file !== null && isFile(file) ? (readOrNull(file) ?? '') : null
      })())
      if (gate === 'stop-blocked') {
        run.im.result = 'blocked'
        abort(
          `Stage 2 detenido: el ${stage2Agent} reporto issue incompleto en ${blockageCanonical}. Refina el issue con el planner (completa la seccion '## ADRs aplicables') y reanuda con --from-stage 2.`,
          'blocked',
        )
      } else if (gate === 'continue-blocked') {
        log.warn(`Stage 2: hay tests rojos pero el ${stage2Agent} reporto bloqueo — continuando al reviewer`)
        eventLine(`BLOCKAGE: ${stage2Agent} reporto tests bloqueados, continuando`)
        hasBlockage = true
      } else if (gate === 'check-preexisting') {
        const preexisting = preexistingRedOnly(worktree, snapshot, tests.output, deps.run)
        if (preexisting.status === 0) {
          mkdirSync(dirname(blockageCanonical), { recursive: true })
          writeFileSync(blockageCanonical, preexistingBlockageReport(preexisting.tests, lastLines(stripAnsi(`${tests.output}\n`), 60)))
          log.warn('Stage 2: todos los tests rojos son preexistentes no modificados — reporte generado, continuando al reviewer')
          eventLine('BLOCKAGE: pipeline detecto solo rojos preexistentes, continuando al reviewer')
          hasBlockage = true
        } else {
          out(`${lastLines(`${tests.output}\n`, 20)}\n`)
          abort(`Stage 2 fallido: no todos los tests pasan después del ${stage2Agent} (exit code: ${tests.status}). Revisa ${logDirAbs}/stage-2-${stage2Agent}.log`)
        }
      }

      run.tests = String(extractTestCount(tests.output) ?? '?')
      log.log(`Tests pasando: ${run.tests}`)

      autoCommit('verde', `feat(hu-${hu}): implementación fase verde`)
      // El commit de seguridad solo cubre tests/ y src/; en modo documental los entregables viven fuera.
      if (isSmokeOnly) {
        for (const docPath of ['docs', 'AGENTS.md', 'CLAUDE.md']) {
          if (hasPendingChanges(query, worktree, [docPath])) worktreeLogged(['add', '-A', '--', docPath])
        }
        if (deps.run('git', ['-C', worktree, 'diff', '--cached', '--quiet'], options).status !== 0) {
          log.log(`El ${stage2Agent} no commitió los entregables documentales. Haciendo commit automático (modo documental)...`)
          worktreeLogged(['commit', '-m', `docs(hu-${hu}): entregables no-código (solo smoke)`])
        }
      }

      run.im.duration = duration
      if (hasBlockage) {
        run.im.result = 'blocked'
        updateStatus(`2-${stage2Agent}`, 'blocked')
        log.warn('Stage 2 completado con tests bloqueados — el reviewer intentara resolverlos')
      } else {
        run.im.result = 'passed'
        updateStatus(`2-${stage2Agent}`, 'passed')
        log.success(isSmokeOnly ? 'Stage 2 completado — modo documental (solo smoke)' : 'Stage 2 completado — fase verde confirmada')
      }
    } else {
      log.log(`Saltando Stage 2 (--from-stage ${fromStage})`)
    }

    // --- Stage 2b: smoke-test-writer, si el diff toca Functions o tools MCP ---
    if (isSmokeOnly) {
      log.log('Saltando Stage 2b (smoke escritos en Stage 1)')
      eventLine('SKIP smoke-test-writer: smoke escritos en Stage 1')
      run.st.result = 'skipped'
      updateStatus('2b-smoke-test-writer', 'skipped')
    } else if (!isRefactor && stageFrom <= 2) {
      const changed = lines(deps.run('git', ['-C', worktree, 'diff', '--name-only', `${snapshot}..HEAD`], options).stdout)
      const detected = smokeFiles(changed, prefix, isProjection)
      if (detected.length > 0) {
        const target = detectSmokeTarget(detected, prefix)
        if (target.anomaly) {
          // Senal visible en vez de un skip indistinguible del legitimo.
          log.warn(`No se pudo derivar el dominio de smoke tests desde '${target.first}' — revisa el patron de deteccion de Stage 2b`)
          eventLine(`SMOKE_ANOMALY: ${target.first}`)
          smokeAnomaly = target.first
          run.st.result = 'skipped'
          updateStatus('2b-smoke-test-writer', 'skipped')
        } else if (isDirectory(join(worktree, target.project))) {
          log.header('Stage 2b: Smoke Test Writer')
          const texts = smokeStageTexts(target.isMcp, issue)
          const mcp = mcpToolPattern(prefix)
          let listing: string
          if (target.isMcp) {
            smokeInvokers = listSmokesInvokingTools(
              worktree,
              target.project,
              detected.filter((path) => mcp.test(path)),
              warnToErr,
            )
            listing = smokeInvokers.map((smoke) => `- ${smoke.file} (tool: ${smoke.target})`).join('\n')
          } else {
            smokeInvokers = listSmokesInvokingRoutes(
              worktree,
              detected.filter((path) => !mcp.test(path) && path.endsWith('.cs')),
            )
            listing = smokeInvokers.map((smoke) => `- ${smoke.file} (ruta: ${smoke.target})`).join('\n')
          }
          const duration = await runAgent(
            '2b',
            'smoke-test-writer',
            stage2bPrompt({
              projectName,
              issueContext,
              stage2Agent,
              filesDescription: texts.filesDescription,
              smokeFiles: detected.join('\n'),
              invokersBlock: invokersBlock(target.isMcp, listing, target.project),
              taskLine: texts.taskLine,
            }),
          )

          // Compila el proyecto smoke del dominio y todo `*.SmokeTests` que el stage toco.
          log.log('Gate: verificando que smoke tests compilan...')
          const touched = [
            ...lines(deps.run('git', ['-C', worktree, 'status', '--porcelain'], options).stdout).map((line) => line.slice(3)),
            ...lines(deps.run('git', ['-C', worktree, 'diff', '--name-only', `${snapshot}..HEAD`], options).stdout),
          ]
          const projects = [
            target.project,
            ...touchedSmokeProjects(touched).filter((project) => project !== target.project && isDirectory(join(worktree, project))),
          ]
          for (const project of projects) {
            const build = deps.run('dotnet', ['build', join(worktree, project)], options)
            const output = chomp(build.stdout + build.stderr)
            log.append(`${output}\n`)
            if (build.status !== 0) {
              out(`${lastLines(`${output}\n`, 20)}\n`)
              abort(`Stage 2b fallido: smoke tests no compilan en ${project} (exit code: ${build.status ?? 127}). Revisa el log.`)
            }
          }

          autoCommit('smoke', texts.commitSubject)
          run.st.duration = duration
          run.st.result = 'passed'
          updateStatus('2b-smoke-test-writer', 'passed')
          log.success('Stage 2b completado — smoke tests escritos')
        } else {
          log.log(
            target.isMcp
              ? `Proyecto ${target.project} no existe — genéralo con /scaffold-mcp; saltando smoke tests`
              : `Proyecto SmokeTests no existe para ${target.domain} — saltando smoke tests`,
          )
          run.st.result = 'skipped'
          updateStatus('2b-smoke-test-writer', 'skipped')
        }
      } else {
        log.log('No se detectaron Function Apps ni tools MCP modificadas — saltando smoke tests')
        run.st.result = 'skipped'
        updateStatus('2b-smoke-test-writer', 'skipped')
      }
    } else {
      log.log(isRefactor ? 'Saltando Stage 2b (refactoring puro)' : `Saltando Stage 2b (--from-stage ${fromStage})`)
      run.st.result = 'skipped'
    }

    // --- Stage 3: reviewer (fase refactor) ---
    if (stageFrom <= 3) {
      log.header('Stage 3: Reviewer (fase refactor)')
      let prompt: string
      if (isRefactor) {
        prompt = stage3RefactorPrompt({ projectName, issueContext, issue, justification: refactorJustification, removedTests: removed })
      } else {
        prompt = stage3ReviewerPrompt({
          projectName,
          issueContext,
          snapshot,
          writerHead: worktreeGit(['rev-parse', 'HEAD']),
          diffStat: worktreeGit(['diff', '--stat=120', `${snapshot}..HEAD`]),
          diffNameStatus: worktreeGit(['diff', '--name-status', `${snapshot}..HEAD`]),
          noRedJustification,
          stage1Agent,
          smokeOnly: isSmokeOnly,
        })
      }
      if (hasBlockage) {
        const report = blockageReportFile()
        if (report !== null && isFile(report)) prompt += blockagePromptNote(statePath('blockage-report.md', worktree))
      }

      const baseHead = chomp(deps.run('git', ['-C', worktree, 'rev-parse', 'HEAD'], options).stdout)
      const duration = await runAgent('3', 'reviewer', prompt)

      log.log('Gate: verificando que refactor no rompió tests...')
      const tests = runTests()
      if (isSmokeOnly && tests.status === 8) tests.status = 0
      if (tests.status !== 0) {
        const report = blockageReportFile()
        if (hasBlockage && report !== null && isFile(report)) {
          log.warn('Stage 3: hay tests rojos pero el bloqueo persiste desde el implementer — continuando a PR')
          eventLine('BLOCKAGE_PERSISTS: reviewer no resolvio tests bloqueados')
        } else {
          out(`${lastLines(`${tests.output}\n`, 20)}\n`)
          abort(`Stage 3 fallido: el reviewer rompió tests al refactorizar (exit code: ${tests.status}). Revisa ${logDirAbs}/stage-3-reviewer.log`)
        }
      } else if (hasBlockage) {
        log.log('Stage 3: el reviewer resolvio los tests bloqueados — el PR no se marca bloqueado')
        eventLine('BLOCKAGE_RESOLVED: reviewer resolvio tests bloqueados')
        hasBlockage = false
        blockageResolved = true
      }

      if (isRefactor) {
        const post = extractTestCount(tests.output)
        const postText = String(post ?? '?')
        log.log(`Tests post-refactoring: ${postText} (baseline: ${baselineTests}, declarados como eliminados: ${removed})`)
        const baseline = /^[0-9]+$/.test(baselineTests) ? Number(baselineTests) : null
        if (testLossGate(baseline, post, removed) === 'abort' && baseline !== null) {
          abort(`El refactoring perdió tests: antes=${baselineTests}, después=${postText}, declarados como eliminados=${removed} (minimo permitido=${baseline - removed})`)
        }
        run.tests = postText
      }

      autoCommit('refactor', `refactor(hu-${hu}): revisión y refactor`)
      if (baseHead.length > 0) reviewerTouchedTests = listReviewerTouchedTests(worktree, baseHead, deps.run)

      run.rv.duration = duration
      run.rv.result = 'passed'
      updateStatus('3-reviewer', 'passed')
      log.success('Stage 3 completado — fase refactor confirmada')
    } else {
      log.log(`Saltando Stage 3 (--from-stage ${fromStage})`)
    }

    const commits = worktreeGit(['log', `${snapshot}..HEAD`, '--oneline'])
    if (commits.length === 0) abort(`No hay commits en la rama ${branch}. Los agentes no commitieron su trabajo y el auto-commit falló.`)

    // --- Sincronizar con main ---
    log.header('Sincronizando con main')
    log.log('Actualizando main desde origin...')
    if (worktreeLogged(['fetch', 'origin', 'main']) !== 0) abort('No se pudo hacer fetch de origin/main')
    const behind = worktreeGit(['rev-list', 'HEAD..origin/main', '--count'])
    if (Number(behind) === 0) {
      log.log('La rama ya está al día con main')
    } else {
      log.log(`main tiene ${behind} commit(s) nuevos. Haciendo merge...`)
      if (worktreeLogged(['merge', 'origin/main', '--no-edit']) === 0) {
        log.success('Merge automático exitoso')
      } else {
        log.warn('Merge con conflictos. Invocando agente para resolverlos...')
        const conflictFiles = worktreeGit(['diff', '--name-only', '--diff-filter=U'])
        await runAgent('merge', 'implementer', mergePrompt({ projectName, conflictFiles }))
        const remaining = chomp(deps.run('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=U'], options).stdout)
        if (remaining.length > 0) abort(`Aún quedan conflictos después del agente: ${remaining}. Revisa manualmente: cd ${worktree}`)
        log.success('Conflictos resueltos')
      }
      log.log('Verificando tests después del merge...')
      const tests = runTests()
      if (isSmokeOnly && tests.status === 8) tests.status = 0
      if (tests.status !== 0) abort(`Tests fallan después del merge con main (exit code: ${tests.status}). Revisa manualmente: cd ${worktree}`)
      log.success('Tests pasan después del merge con main')
    }

    // --- Stage 4: coverage gate ---
    if (isSmokeOnly) {
      log.log('Saltando Stage 4 (sin cambios en src/)')
      eventLine('SKIP coverage-gate: sin cambios en src/')
      run.cg.result = 'skipped'
      updateStatus('4-coverage-gate', 'skipped')
    } else if (!isRefactor && stageFrom <= 4) {
      log.header('Stage 4: Coverage Gate')
      const start = epoch()
      updateStatus('4-coverage-gate', 'running')
      eventLine('=== STAGE 4: coverage-gate ===')
      run.cg.result = 'running'
      const skip = (): void => {
        run.cg.result = 'skipped'
        run.cg.duration = epoch() - start
        updateStatus('4-coverage-gate', 'skipped')
      }
      const coverageTools = {
        run: deps.runCoverage ?? runCoverageStep,
        log,
        env: childEnv,
        clock: () => now().getTime(),
      }
      let measureExit = 0
      const measure = (timeoutLabel: string): boolean => {
        const measurement = measureCoverage(worktree, prefix, coverageTools)
        measureExit = measurement.exit
        if (measurement.timedOut) eventLine(`TIMEOUT: ${timeoutLabel} supero 600s`)
        return measurement.exit === 0 && isFile(join(worktree, COVERAGE_XML))
      }
      const readCoverage = (logicFiles: string[]): FileCoverage[] =>
        extractFileCoverage(readOrNull(join(worktree, COVERAGE_XML)) ?? '', logicFiles)

      if (!deps.hasCommand('dotnet-coverage')) {
        log.warn('dotnet-coverage no encontrado — saltando coverage gate')
        eventLine('SKIP coverage-gate: dotnet-coverage no disponible')
        skip()
      } else {
        const sources = lines(deps.run('git', ['-C', worktree, 'diff', '--name-only', `${snapshot}..HEAD`, '--', 'src/*.cs'], options).stdout).filter(
          (path) => !path.includes('/obj/') && !path.includes('/bin/'),
        )
        if (sources.length === 0) {
          log.log('No hay archivos .cs en src/ modificados — saltando coverage gate')
          skip()
        } else {
          log.log('Archivos .cs del PR:')
          logEach(sources.join('\n'), '  ')
          const logic: string[] = []
          const excluded: string[] = []
          notEvaluatedFiles = []
          for (const file of sources) {
            const kind = coverageClassifyFile(file, worktree, isProjection)
            if (kind === 'logic') logic.push(file)
            else if (kind === 'excluded') excluded.push(file)
            else notEvaluatedFiles.push(file)
          }
          if (logic.length > 0) {
            log.log(`Archivos de logica (requieren ${COVERAGE_THRESHOLD}%):`)
            logEach(logic.join('\n'), '  * ')
          }
          if (excluded.length > 0) {
            log.log('Archivos excluidos:')
            logEach(excluded.join('\n'), '  - ')
          }
          if (notEvaluatedFiles.length > 0) {
            log.log('Archivos sin clasificar:')
            logEach(notEvaluatedFiles.join('\n'), '  ? ')
          }
          const table = (rows: string[]): string => [COVERAGE_TABLE_HEADER, ...rows, ...classificationRows(excluded, notEvaluatedFiles)].join('\n')

          if (logic.length === 0) {
            log.log('No hay archivos de logica para evaluar — coverage gate pasa trivialmente')
            coverageTable = table([])
            run.cg.result = 'passed'
            run.cg.duration = epoch() - start
            updateStatus('4-coverage-gate', 'passed')
            log.success('Stage 4 completado — sin archivos de logica que evaluar')
          } else if (!measure('coverage measurement')) {
            const reason = coverageSkipReason(measureExit, worktree)
            log.warn(reason)
            eventLine(reason)
            skip()
          } else {
            const first = evaluateCoverage(readCoverage(logic))
            coverageTable = table(first.rows)
            let gaps = first.gaps.length
            log.log('Tabla de cobertura:')
            logEach(coverageTable, '  ')

            if (first.gaps.length > 0) {
              log.log(`Detectados ${first.gaps.length} archivo(s) con cobertura insuficiente`)
              eventLine(`GAPS: ${first.gaps.length} archivos bajo ${COVERAGE_THRESHOLD}%`)
              const patchSpec = statePath('coverage-patch-spec.md', worktree)
              writeFileSync(patchSpec, coveragePatchSpec(readOrNull(join(worktree, COVERAGE_XML)), first.gaps))
              log.log(`Patch spec generado: ${patchSpec}`)
              patchApplied = true

              // Remediacion 4b: el mismo agente del Stage 1, con la cadena fina de modelo.
              const twProfile = profileOf(stage1Agent)
              const twModel = await resolveTddModel('patch-test-writer', stage1Agent, twProfile)
              const twEffort = await resolveTddEffort('patch-test-writer', stage1Agent)
              log.log(`Invocando ${stage1Agent} (modelo: ${twModel.length > 0 ? twModel : '<heredado>'})...`)
              log.log(`Relanzando ${stage1Agent} para remediacion...`)
              const twLog = join(logDirAbs, `stage-4-${stage1Agent}-patch-${timestamp}.log`)
              const twEvents = join(logDirAbs, `stage-4-${stage1Agent}-patch-${timestamp}.events.jsonl`)
              const twPrompt = join(run.tmpDir, `4b-${stage1Agent}.prompt.md`)
              writeFileSync(
                twPrompt,
                patchTestWriterPrompt({ projectName, patchSpec, patchSpecContent: chomp(readOrNull(patchSpec) ?? ''), issue }),
              )
              eventLine(`REMEDIATION: relanzando ${stage1Agent}`)
              const tw = await invokeAgentOnce(stage1Agent, twPrompt, twEvents, twLog, twModel, twEffort)
              run.patchTw = { duration: tw.duration, metrics: enrich(twEvents, tw.metrics, '4b', stage1Agent, twProfile) }
              saveMetrics('4b', stage1Agent, run.patchTw.metrics)

              if (tw.exit !== 0 || !agentEventsCompletedSuccessfully(twEvents)) {
                log.warn(`${stage1Agent} de remediacion fallo (exit ${tw.exit}) — continuando con gaps pendientes`)
                eventLine(`REMEDIATION_FAILED: ${stage1Agent} exit ${tw.exit}`)
                remediationSummary = `El ${stage1Agent} de remediacion fallo (exit ${tw.exit}). Los gaps quedan pendientes.`
              } else {
                autoCommit('cobertura', `test(hu-${hu}): tests de cobertura para brechas detectadas`)
                log.log('Gate: verificando compilacion post-remediacion...')
                if (!dotnetBuild(worktree)) {
                  log.warn(`Build fallo post-remediacion — relanzando ${stage2Agent}...`)
                  eventLine(`REMEDIATION: build fallo, relanzando ${stage2Agent}`)
                  const imLog = join(logDirAbs, `stage-4-${stage2Agent}-patch-${timestamp}.log`)
                  const imEvents = join(logDirAbs, `stage-4-${stage2Agent}-patch-${timestamp}.events.jsonl`)
                  const imPrompt = join(run.tmpDir, `4c-${stage2Agent}.prompt.md`)
                  writeFileSync(imPrompt, patchImplementerPrompt({ projectName, stage1Agent }))
                  eventLine(`REMEDIATION: relanzando ${stage2Agent}`)
                  const imProfile = profileOf(stage2Agent)
                  const imModel = await resolveTddModel('patch-implementer', stage2Agent, imProfile)
                  const imEffort = await resolveTddEffort('patch-implementer', stage2Agent)
                  log.log(`Invocando ${stage2Agent} (modelo: ${imModel.length > 0 ? imModel : '<heredado>'})...`)
                  const im = await invokeAgentOnce(stage2Agent, imPrompt, imEvents, imLog, imModel, imEffort)
                  run.patchIm = { duration: im.duration, metrics: enrich(imEvents, im.metrics, '4c', stage2Agent, imProfile) }
                  saveMetrics('4c', stage2Agent, run.patchIm.metrics)
                  if (im.exit !== 0 || !agentEventsCompletedSuccessfully(imEvents)) {
                    log.warn(`${stage2Agent} de remediacion fallo (exit ${im.exit})`)
                    eventLine(`REMEDIATION_FAILED: ${stage2Agent} exit ${im.exit}`)
                  }
                  autoCommit('cobertura', `feat(hu-${hu}): fix compilacion tests de cobertura`)
                }

                log.log('Gate: verificando tests post-remediacion...')
                const tests = runTests()
                if (tests.status !== 0) {
                  log.warn(`Tests fallan post-remediacion (exit ${tests.status}) — continuando con gaps pendientes`)
                  eventLine('REMEDIATION: tests fallan post-remediacion')
                  remediationSummary = `Se agregaron tests de remediacion pero hay tests fallando (exit ${tests.status}). Requiere atencion humana.`
                } else {
                  log.log('Re-midiendo cobertura post-remediacion...')
                  if (measure('re-medicion cobertura')) {
                    const second = evaluateCoverage(readCoverage(logic))
                    coverageTable = table(second.rows)
                    gaps = second.gaps.length
                    const remaining = second.gaps.map((gap) => `${basename(gap.path)} (${gap.percent}%)`).join(', ')
                    remediationSummary =
                      gaps > 0
                        ? `Se agregaron tests de remediacion. Gaps restantes: ${remaining}`
                        : 'Se agregaron tests de remediacion y todos los gaps fueron cerrados.'
                  } else {
                    log.warn('Re-medicion de cobertura fallo — manteniendo tabla anterior')
                    remediationSummary = 'Se agregaron tests de remediacion pero la re-medicion fallo. Gaps originales pueden persistir.'
                  }
                }
              }
              gapsRemaining = gaps
            } else {
              log.log(`Todos los archivos de logica superan el umbral de ${COVERAGE_THRESHOLD}%`)
              gapsRemaining = 0
            }

            run.cg.duration = epoch() - start
            if (gapsRemaining > 0) {
              run.cg.result = 'gaps'
              updateStatus('4-coverage-gate', 'gaps')
              log.warn(`Stage 4 completado con ${gapsRemaining} gap(s) pendiente(s)`)
            } else {
              run.cg.result = 'passed'
              updateStatus('4-coverage-gate', 'passed')
              log.success('Stage 4 completado — cobertura verificada')
            }
            eventLine(`DONE coverage-gate: ${run.cg.duration}s, result=${run.cg.result}, gaps=${gapsRemaining}`)
          }
        }
      }
    } else {
      log.log(isRefactor ? 'Saltando Stage 4 (refactoring puro)' : `Saltando Stage 4 (--from-stage ${fromStage})`)
      run.cg.result = 'skipped'
    }

    // --- Metricas de la corrida: una sola lista para el PR y el historial ---
    const composition = runMetricsStages(runStages(), run.agents)
    const metricsTable = chomp(renderRunMetricsTable(composition.table))

    // --- PR; en modo variante no se publica nada ---
    const repoSlug = repoSlugFromRemoteUrl(worktreeGit(['remote', 'get-url', 'origin']))
    let prUrl = ''
    if (variant.length > 0) {
      log.header('Modo variante: sin PR')
      log.warn(`Variante '${variant}': se omiten push, creacion de PR, nota de bloqueo y comentario al issue (CA-3).`)
      log.log(`La rama '${branch}' queda LOCAL -- no se publica a origin.`)
      // El reporte vive en el worktree, que el cierre borra: sin PR que lo lleve, se copia al estado.
      if (hasBlockage) {
        const report = blockageReportFile()
        const copy = state(`blockage-report-tdd-${issueLogTag}.md`)
        let copied = false
        if (report !== null && isFile(report)) {
          try {
            writeFileSync(copy, readFileSync(report))
            copied = true
          } catch {
            copied = false
          }
        }
        log.warn(
          copied
            ? `Hay tests bloqueados que ni ${stage2Agent} ni el reviewer resolvieron -- revisa ${copy} antes de promover esta variante.`
            : `Hay tests bloqueados que ni ${stage2Agent} ni el reviewer resolvieron, y no se pudo preservar el reporte fuera del worktree -- revisa el log del reviewer antes de promover esta variante.`,
        )
      }
    } else {
      log.header('Creando PR')
      const github = { run: deps.run, runLogged: deps.runLogged, logFile: currentLog(), cwd, env: childEnv }
      log.log('Haciendo push de la rama...')
      if (!pushBranch(worktree, branch, github)) abort(`No se pudo hacer push de la rama ${branch}`)

      log.log('Verificando si ya existe un PR abierto para la rama...')
      const existing = findOpenPrForBranch(branch, {
        repo: repoSlug,
        run: (command, args, given) => deps.run(command, args, { ...given, ...options }),
      })
      if (existing !== null) {
        prUrl = existing
        log.success(`PR existente reutilizado: ${prUrl}`)
        if (!commentPullRequest(prUrl, metricsComment(metricsTable, now()), repoSlug, github)) {
          log.warn(`No se pudo publicar las metricas en el PR reutilizado: ${prUrl}`)
        }
      } else {
        log.log('Creando PR...')
        const summary = (stage: string, agent: string): string => collectSummary(stateReadFirst(summaryRel(stage, agent), worktree), MISSING_SUMMARY)
        const stage1Summary = summary('1', stage1Agent)
        const stage2Summary = summary('2', stage2Agent)
        const smokeSummary = summary('2b', 'smoke-test-writer')
        const reviewerSummary = summary('3', 'reviewer')

        let implementerSection = ''
        let smokeSection = ''
        if (isSmokeOnly) {
          implementerSection = agentDetails(`${stage2Label} (modo documental)`, run.im.duration, stage2Summary)
          smokeSection = smokeOnlySection(smokeOnlyFiles.filter((line) => line.startsWith('smoke: ')).map((line) => line.slice('smoke: '.length)))
        } else if (!isRefactor) {
          implementerSection = agentDetails(`${stage2Label} (fase verde)`, run.im.duration, stage2Summary)
          if (run.st.result === 'passed') smokeSection = agentDetails('Smoke Test Writer', run.st.duration, smokeSummary)
        }

        let unchanged: SmokeInvoker[] = []
        if (smokeInvokers.length > 0) {
          const changedNow = new Set(lines(deps.run('git', ['-C', worktree, 'diff', '--name-only', `${snapshot}..HEAD`], options).stdout))
          unchanged = smokeInvokers.filter((smoke) => smoke.file.length > 0 && !changedNow.has(smoke.file))
        }
        const remnants = chomp(renderWarningRemnantsSection(worktree))
        const reviewerTests = chomp(renderReviewerTouchedTestsSection(reviewerTouchedTests, blockageResolved))
        const extraSections = [
          smokeAnomaly.length > 0 ? smokeAnomalySection(smokeAnomaly) : '',
          smokeUnchangedSection(unchanged),
          coverageSection({
            table: coverageTable,
            hasNotEvaluated: notEvaluatedFiles.length > 0,
            remediation: patchApplied ? remediationSummary : '',
            gapsRemaining,
          }),
          remnants.length > 0 ? `${remnants}\n\n` : '',
          reviewerTests.length > 0 ? `${reviewerTests}\n\n` : '',
        ].join('')

        const created = createPullRequest(
          {
            title: issueTitle,
            body: pullRequestBody({
              summary: prSummary({
                refactor: isRefactor,
                smokeOnly: isSmokeOnly,
                justification: refactorJustification,
                baselineTests,
                smokeWritten: run.st.result === 'passed',
                noRedJustification,
              }),
              stage1Label,
              stage1Seconds: run.tw.duration,
              stage1Summary,
              implementerSection,
              smokeSection,
              reviewerSeconds: run.rv.duration,
              reviewerSummary,
              extraSections,
              commits,
              metricsTable,
              closesLine: issue.length > 0 ? `Closes #${issue}` : '',
            }),
            head: branch,
            repo: repoSlug,
          },
          github,
        )
        if (created === null) abort('No se pudo crear el PR')
        prUrl = created
        log.success(`PR creado: ${prUrl}`)
      }

      if (hasBlockage) {
        const prNumber = /[0-9]*$/.exec(prUrl)?.[0] ?? ''
        if (deps.runLogged('gh', ['pr', 'edit', prNumber, '--add-label', 'bloqueado', '--repo', repoSlug], currentLog(), options) !== 0) {
          log.warn("No se pudo agregar label 'bloqueado' al PR")
        }
        const report = blockageReportFile()
        if (report !== null && isFile(report)) {
          if (!commentPullRequest(prNumber, blockageComment(chomp(readOrNull(report) ?? '')), repoSlug, github)) {
            log.warn('No se pudo comentar reporte de bloqueo en el PR')
          }
        }
      }

      if (issue.length > 0) {
        if (!commentIssue(issue, `Pipeline TDD completado. Decisiones de los agentes en el PR: ${prUrl}`, repoSlug, github)) {
          log.warn(`No se pudo comentar en el issue #${issue}`)
        }
      }
    }

    run.pr = prUrl
    updateStatus('done', 'completed')

    appendCompletedHistory(
      run.historyFile,
      run.eventsLog,
      () => {
        const coverageGate: JqObject = {
          duration: run.cg.duration,
          result: run.cg.result,
          gaps: gapsRemaining,
          patch_applied: patchApplied,
        }
        let agents: JqValue = {
          'test-writer': { duration: run.tw.duration },
          implementer: { duration: run.im.duration },
          reviewer: { duration: run.rv.duration },
          'coverage-gate': coverageGate,
        }
        try {
          const core = parseJq(buildAgentsHistoryJson(composition.history))
          agents = core
          if (composition.coverageGate && typeof core === 'object' && core !== null && !Array.isArray(core)) {
            agents = { ...(core as JqObject), 'coverage-gate': coverageGate }
          }
        } catch {
          // Sin el detalle por stage queda la forma minima.
        }
        return dumpJq({
          issue,
          title: issueTitle,
          pipeline: 'tdd',
          variant: variant.length > 0 ? variant : null,
          identity: parseJq(run.identityJson),
          runtime,
          started: timestamp,
          finished: localIsoSeconds(now()),
          state: 'completed',
          agents,
          tests: testsJsonValue(run.tests),
          pr: prUrl.length > 0 ? prUrl : null,
          log: run.logFile,
        })
      },
      { warn: (message) => log.warn(message), now },
    )

    // El status individual ya esta en el historial.
    rmSync(state(run.statusFilename), { force: true })

    // --- Limpieza ---
    log.header('Cleanup')
    log.log('Eliminando worktree...')
    if (!removeWorktree(repoRoot, worktree, worktreeTools)) {
      log.warn(`No se pudo eliminar el worktree automáticamente. Elimínalo manualmente: git worktree remove --force ${worktree}`)
    }
    run.worktree = ''
    log.success('Worktree eliminado')

    const totalCommits = commits.split('\n').length
    out('\n')
    if (variant.length > 0) {
      out(`${COLOR.cyan}${COLOR.bold}═══ Pipeline (variante '${variant}') completado ═══${COLOR.reset}\n\n`)
      out(`  Commits: ${totalCommits}\n`)
      out(`  Rama:    ${branch}\n`)
      out('  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)\n')
      out(`  Log:     ${run.logFile}\n`)
      // Sin PR, los gaps son el numero que decide que variante gana.
      if (run.cg.result !== 'skipped' && run.cg.result !== 'pending') {
        out(`  Gaps:    ${gapsRemaining} (remediacion aplicada: ${patchApplied}) -- tabla completa en el log del coverage gate\n`)
      }
      out('\n')
      const hint = (text: string): void => out(`${COLOR.yellow}${text}${COLOR.reset}\n`)
      hint('Si esta variante gana la comparacion, promuevela a mano:')
      hint(`  git -C ${repoRoot} push -u origin ${branch}`)
      hint(`  gh pr create --base main --head ${branch} --title "${issueTitle}" --body "Closes #${issue}"`)
      hint('O relanza el pipeline sin --variant para que una corrida normal abra el PR.')
    } else {
      out(`${COLOR.cyan}${COLOR.bold}═══ Pipeline completado ═══${COLOR.reset}\n\n`)
      out(`  Commits: ${totalCommits}\n`)
      out(`  Rama:    ${branch}\n`)
      out(`  PR:      ${prUrl}\n`)
      out(`  Log:     ${run.logFile}\n`)
    }
    out('\n')
    return 0
  }

  return runPipeline(main, {
    finalize,
    // Solo se mata el proceso que este pipeline lanzo: el runner corta a su agente y limpia.
    onSignal: () => void runnerChild?.kill('SIGTERM'),
    err,
    ...(deps.signals === undefined ? {} : { signals: deps.signals }),
    ...(deps.exit === undefined ? {} : { exit: deps.exit }),
  })
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await tddPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'tdd-pipeline.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
