// Pipeline para tareas de tooling (no-TDD) del proyecto consumidor.
//
// Uso:
//   tooling-pipeline.sh 42
//   tooling-pipeline.sh --issue 42
//   tooling-pipeline.sh 42 --from-stage 2                       retoma desde el Stage 2
//   tooling-pipeline.sh 42 --models 'reviewer=<modelo>,writer=<modelo>'
//   tooling-pipeline.sh 42 --variant experimento-a              corrida paralela del mismo issue: sin PR, rama local
//
// Ciclo: issue -> worktree -> writer -> reviewer -> sync con main -> PR -> limpieza. No hay fases
// roja y verde: los gates son compilacion (Stage 1) y compilacion mas tests existentes (Stage 2).
//
// Entorno: MEFISTO_AGENT_TIMEOUT_SECONDS (timeout de cada agente, 1800), MEFISTO_RUN_AGENT_BIN
// (runner alterno), MEFISTO_HOLD_MAX_SECONDS (techo de la espera ante limite de uso o proveedor
// caido, 21600) y MEFISTO_HOLD_PROBE_SECONDS (cadencia de sondeo, 300), MEF-ADR-0051.

import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { resolveModel } from '../src/runtime/lib/mefisto-models.mts'
import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import { rawField } from './lib/azure-cli.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions } from './lib/cli.mts'
import { harnessConfigEnv, loadHarnessConfig } from './lib/harness-config.mts'
import type { HarnessConfig } from './lib/harness-config.mts'
import { dumpJq, parseJq } from './lib/jq-literals.mts'
import type { JqValue } from './lib/jq-literals.mts'
import { PUBLISHED_SLUG, readJsonFile } from './lib/plugin-scopes.mts'
import { appendEventsLine, clockTime } from './lib/pipeline/agent-log.mts'
import { runtimeCliAvailable, runtimeSupportsResume } from './lib/pipeline/agent-runtime.mts'
import { validateConsumerScopeChanges } from './lib/pipeline/consumer-scope.mts'
import { getHarnessIdentity, harnessIdentityJson } from './lib/pipeline/harness-identity.mts'
import { resolveRunnerCommand, runAgentWithPolicy, runnerProcess } from './lib/pipeline/pipeline-agent-run.mts'
import type { AgentRunEvent, LaunchRunner } from './lib/pipeline/pipeline-agent-run.mts'
import { PipelineExit, runPipeline } from './lib/pipeline/pipeline-exit.mts'
import type { SignalSource } from './lib/pipeline/pipeline-exit.mts'
import { appendText, createAbort, createPipelineLog, lastLines, runLogged } from './lib/pipeline/pipeline-log.mts'
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
  summaryDetails,
  viewIssue,
} from './lib/pipeline/pipeline-pr.mts'
import { jsonText, localIsoSeconds, noHold, renderStatusJson, runStamp, statusIsActive, writeStatus } from './lib/pipeline/pipeline-status.mts'
import type { HoldState } from './lib/pipeline/pipeline-status.mts'
import {
  PIPELINE_OWN_WRITES,
  autoCommitIfNeeded,
  changedPaths,
  createWorktree,
  hasCommittedChanges,
  hasPendingChanges,
  issueBranchName,
  issueSlug,
  pipelineWorktreePath,
  removeWorktree,
  resumeWorktree,
} from './lib/pipeline/pipeline-worktree.mts'
import { findOpenPrForBranch } from './lib/pipeline/pull-requests.mts'
import { appendCompletedHistory, renderRunMetricsTable } from './lib/pipeline/run-history.mts'
import { computeStageMetrics, enrichToolingStageMetrics } from './lib/pipeline/stage-metrics.mts'
import { formatStageModelsForLog, parseStageModels, resolvePipelineAgentEffort, resolveStageModel } from './lib/pipeline/stage-models.mts'
import type { StageModels } from './lib/pipeline/stage-models.mts'
import { extractTestCount, runTestsProjects, testsJsonValue } from './lib/pipeline/test-results.mts'
import type { RunDotnet } from './lib/pipeline/test-results.mts'
import { validateVariantLabel } from './lib/pipeline/variant.mts'
import { renderWarningRemnantsSection } from './lib/pipeline/warning-remnants.mts'
import { statePath } from './lib/state.mts'

const SCRIPT_DIR = import.meta.dirname

/** Lineas del log que el aborto reemite: la causa de un fallo de `gh`, `git` o `dotnet` vive ahi. */
const TAIL_LOG_LINES = 20

/** Desenlaces en que el protocolo quedo incompleto: su trabajo parcial nunca se rescata. */
const INCOMPLETE_FAILURES = ['TIMEOUT', 'KILLED', 'STREAM_CUT', 'PROTOCOL_INVALID']

export interface ToolingPipelineDeps {
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

export interface Stage1PromptInput {
  projectName: string
  issueContext: string
  snapshot: string
  draftsSlug: string
}

export function stage1Prompt(input: Stage1PromptInput): string {
  return `Estas en el directorio raiz del proyecto consumidor ${input.projectName} (un consumidor del plugin Mefisto).

Contexto de la tarea de tooling a implementar:

${input.issueContext}

Commit base: ${input.snapshot}

Tu tarea: implementa lo descrito en el issue. Esto es una tarea de TOOLING del CONSUMIDOR (workflows de GitHub Actions, configuracion local, fixtures de test, scripts ad-hoc del consumidor), NO logica de dominio y NO modificaciones al plugin Mefisto.

ALCANCE PERMITIDO de escritura:
- .github/workflows/                         (workflows del consumidor)
- .github/dependabot.yml                     (configuracion de Dependabot del consumidor; solo este archivo)
- .mefisto/harness.config.json               (configuracion del consumidor: contrato canonico)
- .mefisto/appinsights.env                   (configuracion de telemetria del consumidor: solo nombres de recursos, sin secretos)
- .claude/harness.config.json                (solo si ya existe: fallback legacy de lectura, no lo crees)
- .claude/settings.json                      (configuracion Claude del consumidor)
- .mefisto/pipeline/                         (estado runtime canonico; .gitignored)
- pipeline-state/                            (senales del pipeline)
- scripts/                                   (scripts ad-hoc del consumidor)
- tests/                                     (SOLO fixtures, helpers, builders - NO logica de dominio)
- docs/**                                  (documentacion del consumidor, incluido docs/testing/;
  la unica exclusion documental es docs/adr/mef-adr-*, reservada al marco)

PROHIBIDO MODIFICAR (pertenece al plugin Mefisto, no a este repo):
- commands/, skills/, agents/, hooks/, .claude-plugin/, src/published/, src/runtime/, dist/
- docs/adr/mef-adr-*  (ADRs del marco; si copias uno para editarlo local, renombralo con tu propio prefijo)
- src/ (eso es para /implement, no para /tooling)

Si la tarea requiere modificar el plugin Mefisto, NO la ejecutes. En su lugar, propon crear un draft con:
  gh issue create -R ${input.draftsSlug} --label "estado:borrador,tipo:tooling" --title "..." --body "..."
Y registra esto en el resumen del stage.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). No hay un humano al otro lado.
- Nadie puede aprobar, confirmar ni responder preguntas.
- DEBES usar las herramientas Write y Edit directamente para crear y modificar archivos.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Las capacidades de edicion requeridas por el agente ya estan habilitadas.
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

Instrucciones:
1. Lee los archivos existentes relevantes antes de escribir codigo nuevo.
2. Reutiliza patrones y convenciones del proyecto (mira archivos similares).
3. Haz commits frecuentes con mensajes descriptivos en espanol.
4. Verifica que el proyecto compila con 'dotnet build' si modificaste codigo C#.
5. Comando de verificacion permitido: scripts/warnings-diff.sh del plugin (politica de cero warnings nuevos, MEF-ADR-0056); sigue la doctrina de tu agente con --base ${input.snapshot}.
6. Al terminar, escribe un resumen de lo que hiciste en .mefisto/pipeline/summaries/stage-1-writer.md`
}

export interface Stage2PromptInput {
  projectName: string
  issueContext: string
  snapshot: string
  writerHead: string
  diffStat: string
  diffNameStatus: string
}

export function stage2Prompt(input: Stage2PromptInput): string {
  return `Estas en el directorio raiz del proyecto consumidor ${input.projectName}.

Contexto de la tarea:

${input.issueContext}

Cambios del writer:

Commit base: ${input.snapshot}
HEAD del writer: ${input.writerHead}

Resumen (git diff --stat=120 ${input.snapshot}..HEAD):

${input.diffStat}

Rutas cambiadas (git diff --name-status ${input.snapshot}..HEAD):

${input.diffNameStatus}

Tu tarea: revisa la calidad del codigo producido por el writer.

ALCANCE PERMITIDO de escritura (igual al del writer):
.github/workflows/, .github/dependabot.yml, .mefisto/appinsights.env, .mefisto/harness.config.json (o .claude/harness.config.json solo si ya existe, legacy), .claude/settings.json,
.mefisto/pipeline/, pipeline-state/, scripts/, tests/ (fixtures/helpers),
docs/** (incluido docs/testing/; salvo docs/adr/mef-adr-*).

PROHIBIDO: commands/, skills/, agents/, hooks/, .claude-plugin/, src/published/, src/runtime/, dist/, docs/adr/mef-adr-*, src/.

Si el writer toco rutas prohibidas, reviertelas o reporta el problema en el resumen
y NO hagas cambios extra al plugin.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). No hay un humano al otro lado.
- Nadie puede aprobar, confirmar ni responder preguntas.
- DEBES usar las herramientas Write y Edit directamente para corregir problemas.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Las capacidades de edicion requeridas por el agente ya estan habilitadas.
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

ECONOMIA DE TURNOS:
- Ya tienes el commit base, el HEAD del writer, el --stat y las rutas cambiadas aqui arriba: para ver el diff de una ruta puntual pidelo bajo demanda con 'git diff ${input.snapshot}..HEAD -- <ruta>' (o 'git show <sha>' para inspeccionar un commit), agrupando varias rutas en el mismo turno si necesitas mas de una. No re-inspecciones el arbol con 'git status' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.

Instrucciones:
1. Verifica que los cambios cumplen con lo pedido en el issue.
2. Revisa calidad: reutilizacion de patrones existentes, naming, legibilidad.
3. Si hay codigo C#, verifica que compila y que los tests existentes pasan.
4. Corrige problemas que encuentres directamente (no solo los reportes).
5. Comando de verificacion permitido: scripts/warnings-diff.sh del plugin (politica de cero warnings nuevos, MEF-ADR-0056); sigue la doctrina de tu agente con --base ${input.snapshot}.
6. Haz commit de tus correcciones con mensajes descriptivos.
7. Al terminar, escribe un resumen en .mefisto/pipeline/summaries/stage-2-reviewer.md`
}

export function mergePrompt(input: { conflictFiles: string }): string {
  return `Hay conflictos de merge con main en los siguientes archivos:
${input.conflictFiles}

Resuelve los conflictos manteniendo tanto la funcionalidad nueva como la existente.
Despues de resolver cada archivo, haz git add. Cuando todos esten resueltos, haz git commit.
PROHIBIDO hacer 'git push' o 'gh pr create': eso es responsabilidad exclusiva del pipeline, nunca tuya.`
}

function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

export interface PullRequestBodyInput {
  issue: string
  writerSummary: string
  /** Segundos del writer; `null` si no corrio en esta invocacion. */
  writerSeconds: number | null
  reviewerSummary: string
  reviewerSeconds: number | null
  /** Seccion de warnings remanentes, o vacia. */
  remnants: string
  /** `git log --oneline` de la rama. */
  commits: string
  metricsTable: string
}

export function pullRequestBody(input: PullRequestBodyInput): string {
  return chomp(
    [
      '## Resumen',
      '',
      'Pipeline tooling completado:',
      '- Writer: implementacion de la tarea',
      '- Reviewer: revision de calidad',
      '',
      '## Decisiones del pipeline',
      '',
      summaryDetails('Writer', input.writerSeconds, input.writerSummary),
      '',
      summaryDetails('Reviewer', input.reviewerSeconds, input.reviewerSummary),
      '',
      chomp(input.remnants),
      '',
      '## Commits',
      '',
      input.commits,
      '',
      '## Metricas de la corrida',
      '',
      chomp(input.metricsTable),
      '',
      `Closes #${input.issue}`,
    ].join('\n'),
  )
}

const SPACE = '[ \\t\\n\\v\\f\\r]'
const BLOCKERS_HEADING = new RegExp(`^## Pendiente/bloqueos${SPACE}*$`)
const NEXT_HEADING = new RegExp(`^##${SPACE}`)
const NOT_SPACE = /[^ \t\n\v\f\r]/

/**
 * Contenido de la seccion `## Pendiente/bloqueos` del resumen del writer, sin saltos finales:
 * cuando no deja cambios, es el motivo estructurado que declaro.
 */
export function writerBlockers(summary: string): string {
  const lines = summary.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const collected: string[] = []
  let collecting = false
  for (const line of lines) {
    if (BLOCKERS_HEADING.test(line)) {
      collecting = true
      continue
    }
    if (!collecting) continue
    if (NEXT_HEADING.test(line)) break
    collected.push(line)
  }
  return chomp(collected.map((line) => `${line}\n`).join(''))
}

interface AgentTrack {
  agentId: string
  profile: string
  model: string
  effort: string
  duration: number | null
  result: string
  /** JSON de las metricas del ultimo stage que corrio este rol. */
  metrics: string
}

type AgentRole = 'writer' | 'reviewer'

interface RunState {
  issue: string
  issueTitle: string
  variant: string
  statusFilename: string
  timestamp: string
  logFile: string
  /** Vacios hasta que se prepara el directorio del pipeline: antes de eso un aborto no deja evidencia. */
  pipelineDirReady: boolean
  logFileAbs: string
  historyFile: string
  eventsLog: string
  tmpDir: string
  worktree: string
  identityJson: string
  runtime: string
  writer: AgentTrack
  reviewer: AgentTrack
  tests: string
  pr: string
  /** Error del aborto con sus saltos vueltos espacios, o el diagnostico de un cierre no controlado. */
  error: string
  errorFromAbort: boolean
  aborting: boolean
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

function isNonEmptyFile(path: string): boolean {
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

/** Corre el pipeline y devuelve su codigo de salida. */
export async function toolingPipeline(deps: ToolingPipelineDeps): Promise<number> {
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
    err('ERROR: scripts/tooling-pipeline.sh es del plugin publicado y solo aplica al consumidor.\n')
    err('Estas en el repo de Mefisto. Para mejorar el plugin, usa .claude/scripts/mefisto-tooling-pipeline.sh.\n')
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
  const draftsSlug = nonEmpty(chomp(rawField(readJsonFile(config.configPath), 'repoSlug'))) ?? PUBLISHED_SLUG

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
    logFile: join(logDir, `tooling-pipeline-${timestamp}.log`),
    pipelineDirReady: false,
    logFileAbs: '',
    historyFile: '',
    eventsLog: '',
    tmpDir: '',
    worktree: '',
    // Identidad declarada por el paquete; se revalida contra el runtime resuelto antes de dejar evidencia.
    identityJson: harnessIdentityJson(getHarnessIdentity()),
    runtime: '',
    writer: { agentId: 'tooling-writer', profile: 'balanced', model: '', effort: '', duration: null, result: 'pending', metrics: 'null' },
    reviewer: { agentId: 'tooling-reviewer', profile: 'deep', model: '', effort: '', duration: null, result: 'pending', metrics: 'null' },
    tests: '',
    pr: '',
    error: '',
    errorFromAbort: false,
    aborting: false,
    currentStage: 'setup',
    hold: noHold(),
  }
  const currentLog = (): string => (run.logFileAbs.length > 0 ? run.logFileAbs : run.logFile)
  const log = createPipelineLog({ logFile: currentLog, out, now })
  const eventLine = (text: string): void => appendEventsLine(run.eventsLog, `[${clockTime(now())}] ${text}`)

  const agentStatus = (track: AgentTrack): string => {
    const model = track.model.length > 0 ? jsonText(track.model) : 'null'
    return `{"agent": "${track.agentId}", "profile": "${track.profile}", "requested_model": ${model}, "inherited": ${track.model.length === 0}, "duration": ${track.duration ?? 'null'}, "result": "${track.result}", "metrics": ${track.metrics}}`
  }
  const updateStatus = (stage: string, statusState: string): void => {
    run.currentStage = stage
    writeStatus(
      state(run.statusFilename),
      renderStatusJson(
        [
          { key: 'issue', json: jsonText(run.issue.length > 0 ? run.issue : 'null') },
          // El titulo llega crudo de la respuesta de `gh`, con sus escapes JSON intactos.
          { key: 'title', json: `"${run.issueTitle.replaceAll('"', '\\"')}"` },
          { key: 'pipeline', json: '"tooling"' },
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
              { key: 'writer', json: agentStatus(run.writer) },
              { key: 'reviewer', json: agentStatus(run.reviewer) },
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

  const recordFailedHistory = (): void => {
    if (run.historyFile.length === 0) return
    // Si las metricas no son JSON la entrada no se puede armar: el historial queda como estaba.
    let entry = ''
    try {
      const value: JqValue = {
        issue: run.issue,
        title: run.issueTitle,
        pipeline: 'tooling',
        variant: run.variant.length > 0 ? run.variant : null,
        identity: parseJq(run.identityJson),
        runtime: run.runtime.length > 0 ? run.runtime : null,
        started: run.timestamp,
        finished: localIsoSeconds(now()),
        state: 'failed',
        stage: run.currentStage,
        // El bash guardaba el error del aborto ya escapado para el status y lo volvia a codificar aqui.
        error: run.errorFromAbort ? run.error.replaceAll('"', '\\"') : run.error,
        agents: { writer: { metrics: parseJq(run.writer.metrics) }, reviewer: { metrics: parseJq(run.reviewer.metrics) } },
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
      run.aborting = true
      run.error = `${message.replaceAll('\n', ' ')} `
      run.errorFromAbort = true
    },
    record: () => {
      if (!run.pipelineDirReady) return
      updateStatus(run.currentStage, 'failed')
      recordFailedHistory()
    },
  })

  let runnerChild: ChildProcess | null = null

  const finalize = (exitCode: number): void => {
    // Un aborto que no alcanzo a completar su escritura conserva su error; cualquier otro cierre
    // no controlado recibe un diagnostico generico.
    const statusFile = join(stateDir, run.statusFilename)
    if (exitCode !== 0 && run.statusFilename.length > 0 && run.pipelineDirReady && isFile(statusFile) && statusIsActive(statusFile)) {
      if (!run.aborting) {
        run.error = `Terminacion no controlada (exit code: ${exitCode})`
        run.errorFromAbort = false
      }
      try {
        updateStatus(run.currentStage, 'failed')
      } catch {
        // Sin poder reescribir el status, el historial conserva el fallo.
      }
      recordFailedHistory()
    }
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
        `Uso: ${deps.scriptPath} [--issue NUM | NUM] [--from-stage N] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]\n`,
      )
      return 1
    }
    let fromStage = '1'
    let modelsSpec = ''
    run.statusFilename = 'pipeline-status-tooling.json'
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

    // --- Variante: se valida antes de crear el worktree y de nombrar cualquier archivo de la corrida ---
    const variant = run.variant
    let issueLogTag = issue
    if (variant.length > 0) {
      const invalid = validateVariantLabel(variant)
      if (invalid !== null) abort(`--variant mal formado: ${invalid}`)
      issueLogTag = `${issue}-${variant}`
      // Dos variantes lanzadas en el mismo segundo comparten marca de tiempo: sin el label
      // escribirian al mismo log.
      run.logFile = join(logDir, `tooling-pipeline-${timestamp}-${variant}.log`)
    }
    const variantJson = variant.length > 0 ? jsonText(variant) : 'null'

    // Sin --status-file, un status por issue (y por variante) para que corridas paralelas no se pisen.
    if (run.statusFilename === 'pipeline-status-tooling.json') {
      run.statusFilename = variant.length > 0 ? `pipeline-status-tooling-${issue}-${variant}.json` : `pipeline-status-tooling-${issue}.json`
    }

    if (!/^[1-2]$/.test(fromStage)) abort(`--from-stage debe ser 1 o 2 (recibido: ${fromStage})`)
    const resuming = Number(fromStage) > 1

    // --- Frontera neutral, antes de crear el worktree ---
    const timeout = nonEmpty(env.MEFISTO_AGENT_TIMEOUT_SECONDS) ?? '1800'
    if (!/^[0-9]+$/.test(timeout)) abort(`MEFISTO_AGENT_TIMEOUT_SECONDS '${timeout}' no es un entero`)
    if (Number(timeout) <= 0) abort('MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0')
    for (const command of ['gh', 'git', 'dotnet']) {
      if (!deps.hasCommand(command)) abort(`Falta comando requerido: ${command}`)
    }
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

    // --- Directorio del pipeline ---
    mkdirSync(logDir, { recursive: true })
    writeFileSync(run.logFile, `Pipeline tooling iniciado: ${timestamp}\n`)
    const logDirAbs = join(stateDir, 'logs')
    run.logFileAbs = state(join('logs', basename(run.logFile)))
    run.logFile = run.logFileAbs
    run.eventsLog = state('events.log')
    run.historyFile = state('pipeline-history.jsonl')
    run.pipelineDirReady = true
    try {
      run.tmpDir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'mefisto-tooling.'))
    } catch {
      abort('No se pudo crear el directorio temporal del pipeline')
    }

    appendText(run.eventsLog, `=== SESSION TOOLING ${timestamp} issue:${issue} from-stage:${fromStage} ===\n`)
    if (identity.identity_state !== 'complete') {
      log.warn('Identidad de distribucion degradada: metadata ausente o invalida; version/commit se registran como null')
    }

    // --- Modelos y effort: un valor malformado aborta antes de que exista el worktree ---
    const parsedModels = parseStageModels(modelsSpec)
    if ('error' in parsedModels) abort(`--models mal formado: ${parsedModels.error}`)
    const stageModels: StageModels = parsedModels.models
    if (stageModels.size > 0) {
      const summary = formatStageModelsForLog(stageModels)
      log.log(`Modelos por stage (--models): ${summary}`)
      eventLine(`MODELS: ${summary}`)
    }

    // El override publico gana por clave exacta; sin el deciden el mapping del consumidor y el
    // adaptador, o se hereda.
    const consumerModelsFile = join(git(['rev-parse', '--show-toplevel']), '.mefisto', 'models.json')
    const resolveToolingModel = async (key: AgentRole): Promise<string> => {
      const track = run[key]
      const explicit = resolveStageModel(stageModels, key, '')
      if (explicit.length > 0) {
        eventLine(
          `MODELS: ${key} runtime=${runtime} perfil=${track.profile} solicitado='${explicit}' resuelto='${explicit}' (override --models)`,
        )
        return explicit
      }
      const model = await resolveModel({ runtime, agentId: track.agentId, profile: track.profile, mappingFile: consumerModelsFile, env })
      if ('error' in model) {
        abort(`No se pudo resolver el modelo de ${track.agentId} (perfil ${track.profile}): ${model.error.length > 0 ? model.error : 'motivo desconocido'}`)
      }
      eventLine(
        `MODELS: ${key} runtime=${runtime} perfil=${track.profile} solicitado=<automatico> resuelto='${model.model.length > 0 ? model.model : '<heredado>'}'`,
      )
      return model.model
    }
    const writerModel = await resolveToolingModel('writer')
    const reviewerModel = await resolveToolingModel('reviewer')
    const resolveToolingEffort = async (key: AgentRole): Promise<string> => {
      const agentId = run[key].agentId
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
    run.writer.effort = await resolveToolingEffort('writer')
    run.reviewer.effort = await resolveToolingEffort('reviewer')
    run.writer.model = writerModel
    run.reviewer.model = reviewerModel

    if (variant.length > 0) {
      log.log(`Modo variante: '${variant}' -- sin push, sin PR, sin comentario al issue (CA-3); rama queda local`)
      eventLine(`VARIANT: ${variant}`)
    }

    // --- Issue ---
    log.header('Preparando contexto')
    log.log(`Descargando issue #${issue}...`)
    const rawIssue = viewIssue(issue, 'number,title,body,state', { run: deps.run, logFile: currentLog(), cwd, env: childEnv })
    if (rawIssue === null) abort(`No se pudo obtener el issue #${issue}`)
    const view = parseIssueView(rawIssue)
    if (view.state !== 'OPEN') abort(`El issue #${issue} esta ${view.state} -- solo se procesan issues abiertos.`)
    if (view.title === null) throw new PipelineExit(1)
    run.issueTitle = view.title
    const issueTitle = view.title
    const issueContext = `# Issue #${issue}: ${issueTitle}\n\n${view.body}`
    log.log(`Issue: ${issueTitle}`)

    // --- Worktree ---
    log.header('Preparando worktree')
    const repoRoot = resolve(git(['rev-parse', '--show-toplevel']))
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = issueBranchName(issue, issueSlug(issueTitle), variant)
    run.worktree = pipelineWorktreePath(repoRoot, branch)
    const worktreeTools = { run: deps.run, runLogged: deps.runLogged, log, abort, cwd, env: childEnv }
    const query = { run: deps.run, env: childEnv }
    const worktreeGit = (args: string[]): string => git(['-C', run.worktree, ...args])

    let snapshot: string
    if (resuming) {
      run.worktree = resumeWorktree({ repoRoot, branch, fromStage }, worktreeTools)
      snapshot = worktreeGit(['merge-base', 'HEAD', 'main'])
      log.log(`Snapshot detectado: ${snapshot}`)
    } else {
      run.worktree = createWorktree({ repoRoot, branch, currentBranch }, worktreeTools)
      statePath(join('summaries', '.state'), run.worktree)
      updateStatus('setup', 'running')
      snapshot = worktreeGit(['rev-parse', 'HEAD'])
      log.log(`Snapshot: ${snapshot}`)
    }
    const worktree = run.worktree

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

    /**
     * Invoca al writer o al reviewer y devuelve lo que tardo sin contar esperas. El runner decide
     * timeout, argv y terminal; este nivel solo conserva la politica de espera y reintento.
     */
    const runAgent = async (stage: string, agent: AgentRole, prompt: string): Promise<number> => {
      const track = run[agent]
      const name = `tooling-stage-${stage}-${agent}-${timestamp}-issue-${issueLogTag}`
      const logBase = join(logDirAbs, name)
      const logStage = `${logBase}.log`
      const entryCommit = worktreeGit(['rev-parse', 'HEAD'])
      const summaryFile = statePath(join('summaries', `stage-${stage}-${agent}.md`), worktree)
      const hasWork = (): boolean => hasCommittedChanges(query, worktree, entryCommit) || hasPendingChanges(query, worktree)

      track.result = 'running'
      updateStatus(`${stage}-${agent}`, 'running')
      log.log(`Invocando ${agent} (modelo: ${track.model.length > 0 ? track.model : '<heredado>'})...`)

      const onEvent = (event: AgentRunEvent): void => {
        switch (event.kind) {
          case 'attempt': {
            const metrics = enrichToolingStageMetrics({
              eventsFile: event.eventsFile,
              baseMetrics: computeStageMetrics(event.eventsFile),
              issue,
              variantJson,
              stage,
              agent: track.agentId,
              profile: track.profile,
              identityJson: run.identityJson,
            })
            writeFileSync(state(join('metrics', `${name}.json`)), `${metrics}\n`)
            track.metrics = metrics
            break
          }
          case 'denial-retry':
            log.warn(`${agent}: ${event.denials} denegacion(es) neutrales sin trabajo; reintentando una vez desde cero`)
            eventLine(`RETRY ${agent}: denials=${event.denials}`)
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
          agentId: track.agentId,
          worktree,
          prompt,
          promptFile: join(run.tmpDir, `${stage}-${agent}.prompt.md`),
          systemFile: join(run.tmpDir, `${stage}-${agent}.system.md`),
          resumePromptFile: (attempt) => join(run.tmpDir, `${stage}-${agent}-resume-${attempt}.prompt.md`),
          eventsFile: (attempt) => `${logBase}-attempt-${attempt}.events.jsonl`,
          stageLog: () => logStage,
          runnerOutput: () => join(run.tmpDir, `${stage}-${agent}.runner.log`),
          extraArgs: ['--events-log', run.eventsLog, '--redact-observability', '--timeout', timeout],
          model: track.model,
          effort: track.effort,
          eventsLog: run.eventsLog,
        },
        {
          denialRetry: { hasWork },
          resumeEvidence: () => isNonEmptyFile(summaryFile),
          supportsResume: () => runtimeSupportsResume(runtime, { env }),
        },
        { launchRunner, onEvent, env, now, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
      )

      let failureType = outcome.failureType
      // Un fallo ordinario se perdona solo si dejo trabajo real que ademas compila.
      if (
        failureType.length > 0 &&
        !INCOMPLETE_FAILURES.includes(failureType) &&
        hasWork() &&
        deps.runLogged('dotnet', ['build', worktree], currentLog(), options) === 0
      ) {
        log.warn(`${agent}: runner termino con ${failureType}, pero el trabajo paso el gate de confianza`)
        eventLine(`RECUPERADO ${agent}: trabajo util detectado`)
        failureType = ''
      }
      if (failureType.length > 0) {
        track.result = 'failed'
        updateStatus(`${stage}-${agent}`, 'failed')
        if (INCOMPLETE_FAILURES.includes(failureType)) abort(`${agent} fallo (${failureType}); se descarta trabajo parcial`)
        abort(`${agent} fallo (${failureType}). Log completo: ${logStage}`)
      }
      run.hold = noHold(outcome.holdSeconds)
      const duration = outcome.elapsedSeconds - outcome.holdSeconds
      log.log(`${agent} completado en ${duration}s`)
      return duration
    }

    const autoCommit = (phase: string, message: string): void => {
      // `pipeline-state/` es senal transitoria que nunca se versiona: se excluye aunque el
      // consumidor no la tenga en su `.gitignore`.
      autoCommitIfNeeded(
        {
          worktree,
          message,
          pathspec: ['.', ...PIPELINE_OWN_WRITES, ':!pipeline-state'],
          addAll: true,
          onPending: () => log.log(`Haciendo commit automatico (fase ${phase})...`),
        },
        worktreeTools,
      )
    }
    const csharpChanged = (): boolean => changedPaths(query, worktree, snapshot, ['*.cs', '*.csproj']).length > 0
    const scopeViolated = (): boolean => {
      const check = validateConsumerScopeChanges(worktree, snapshot, {
        run: (command, args, given) => deps.run(command, args, { ...given, env: childEnv }),
        configPath: config.configPath,
      })
      if (check.violations.length === 0) return false
      err(`${check.message.join('\n')}\n`)
      return true
    }
    /** Corre los tests del consumidor, deja su salida en el log y la devuelve con el codigo. */
    const runTests = (): { output: string; status: number } => {
      const tests = runTestsProjects(worktree, config.namespacePrefix, [], deps.runDotnet)
      const output = chomp(tests.output)
      log.append(`${output}\n`)
      return { output, status: tests.status }
    }

    // --- Stage 1: writer ---
    if (Number(fromStage) <= 1) {
      log.header('Stage 1: Writer (implementacion)')
      const duration = await runAgent('1', 'writer', stage1Prompt({ projectName: config.projectName, issueContext, snapshot, draftsSlug }))

      // Cuenta como cambio todo lo que el writer dejo en el worktree y no escribe el pipeline.
      if (!hasCommittedChanges(query, worktree, snapshot) && !hasPendingChanges(query, worktree)) {
        // El resumen es evidencia runtime que git ignora: conserva el motivo que el writer declaro.
        let blockers = ''
        try {
          blockers = writerBlockers(readFileSync(statePath(join('summaries', 'stage-1-writer.md'), worktree), 'utf8'))
        } catch {
          blockers = ''
        }
        if (NOT_SPACE.test(blockers)) {
          out(`${COLOR.yellow}Pendiente/bloqueos informado por el writer:${COLOR.reset}\n`)
          out(`${blockers}\n`)
        }
        abort(`El writer no genero ningun cambio. Revisa el log: ${join(logDirAbs, `tooling-stage-1-writer-${timestamp}-issue-${issueLogTag}.log`)}`)
      }

      if (csharpChanged() || hasPendingChanges(query, worktree, ['*.cs', '*.csproj'])) {
        log.log('Gate: verificando compilacion...')
        if (deps.runLogged('dotnet', ['build', worktree], currentLog(), options) !== 0) {
          abort('Stage 1 fallido: el proyecto no compila despues del writer.')
        }
        log.success('Gate 1: compilacion exitosa')
      } else {
        log.log('No hay cambios en C# -- saltando gate de compilacion')
      }

      autoCommit('writer', `tooling(#${issue}): implementacion`)
      if (scopeViolated()) abort('Stage 1 fallido: el writer toco rutas reservadas al plugin Mefisto.')

      run.writer.duration = duration
      run.writer.result = 'passed'
      updateStatus('1-writer', 'passed')
      log.success('Stage 1 completado')
    }

    // --- Stage 2: reviewer ---
    {
      log.header('Stage 2: Reviewer (revision)')
      const duration = await runAgent(
        '2',
        'reviewer',
        stage2Prompt({
          projectName: config.projectName,
          issueContext,
          snapshot,
          writerHead: worktreeGit(['rev-parse', 'HEAD']),
          diffStat: worktreeGit(['diff', '--stat=120', `${snapshot}..HEAD`]),
          diffNameStatus: worktreeGit(['diff', '--name-status', `${snapshot}..HEAD`]),
        }),
      )

      if (csharpChanged()) {
        log.log('Gate: verificando compilacion y tests...')
        const tests = runTests()
        if (tests.status !== 0) {
          out(`${lastLines(`${tests.output}\n`, 20)}\n`)
          abort(`Stage 2 fallido: tests fallan despues del reviewer (exit code: ${tests.status}).`)
        }
        const count = extractTestCount(tests.output)
        run.tests = count === null ? '?' : String(count)
        log.log(`Tests pasando: ${run.tests}`)
        log.success('Gate 2: compilacion y tests OK')
      } else {
        log.log('No hay cambios en C# -- saltando gate de tests')
      }

      autoCommit('reviewer', `tooling(#${issue}): revision y correcciones`)
      if (scopeViolated()) abort('Stage 2 fallido: el reviewer toco rutas reservadas al plugin Mefisto.')

      run.reviewer.duration = duration
      run.reviewer.result = 'passed'
      updateStatus('2-reviewer', 'passed')
      log.success('Stage 2 completado')
    }

    const commits = worktreeGit(['log', `${snapshot}..HEAD`, '--oneline'])
    if (commits.length === 0) abort(`No hay commits en la rama ${branch}.`)

    // --- Sincronizar con main ---
    log.header('Sincronizando con main')
    log.log('Actualizando main desde origin...')
    const worktreeLogged = (args: string[]): number | null =>
      deps.runLogged('git', ['-C', worktree, ...args], currentLog(), options)
    if (worktreeLogged(['fetch', 'origin', 'main']) !== 0) abort('No se pudo hacer fetch de origin/main')

    const behind = worktreeGit(['rev-list', 'HEAD..origin/main', '--count'])
    if (Number(behind) === 0) {
      log.log('La rama ya esta al dia con main')
    } else {
      log.log(`main tiene ${behind} commit(s) nuevos. Haciendo merge...`)
      if (worktreeLogged(['merge', 'origin/main', '--no-edit']) === 0) {
        log.success('Merge automatico exitoso')
      } else {
        log.warn('Merge con conflictos. Resolviendo...')
        const conflictFiles = worktreeGit(['diff', '--name-only', '--diff-filter=U'])
        await runAgent('merge', 'writer', mergePrompt({ conflictFiles }))
        const remaining = chomp(deps.run('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=U'], options).stdout)
        if (remaining.length > 0) abort(`Aun quedan conflictos: ${remaining}. Revisa manualmente: cd ${worktree}`)
        log.success('Conflictos resueltos')
      }

      if (csharpChanged()) {
        log.log('Verificando tests despues del merge...')
        const tests = runTests()
        if (tests.status !== 0) abort(`Tests fallan despues del merge con main (exit code: ${tests.status}).`)
        log.success('Tests pasan despues del merge')
      }
    }

    // --- PR; en modo variante no se publica nada ---
    const repoSlug = repoSlugFromRemoteUrl(worktreeGit(['remote', 'get-url', 'origin']))
    let prUrl = ''
    if (variant.length > 0) {
      log.header('Modo variante: sin PR')
      log.warn(`Variante '${variant}': se omiten push, creacion de PR y comentario al issue (CA-3).`)
      log.log(`La rama '${branch}' queda LOCAL -- no se publica a origin.`)
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
      const metricsTable = chomp(
        renderRunMetricsTable([
          { label: 'Writer', duration: run.writer.duration, metrics: run.writer.metrics },
          { label: 'Reviewer', duration: run.reviewer.duration, metrics: run.reviewer.metrics },
        ]),
      )

      if (existing !== null) {
        prUrl = existing
        log.success(`PR existente reutilizado: ${prUrl}`)
        if (!commentPullRequest(prUrl, metricsComment(metricsTable, now()), repoSlug, github)) {
          log.warn(`No se pudo publicar las metricas en el PR reutilizado: ${prUrl}`)
        }
      } else {
        log.log('Creando PR...')
        const summary = (stage: string, agent: AgentRole): string =>
          collectSummary(statePath(join('summaries', `stage-${stage}-${agent}.md`), worktree))
        const created = createPullRequest(
          {
            title: issueTitle,
            body: pullRequestBody({
              issue,
              writerSummary: summary('1', 'writer'),
              writerSeconds: run.writer.duration,
              reviewerSummary: summary('2', 'reviewer'),
              reviewerSeconds: run.reviewer.duration,
              remnants: renderWarningRemnantsSection(worktree),
              commits,
              metricsTable,
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

      if (!commentIssue(issue, `Pipeline tooling completado. PR: ${prUrl}`, repoSlug, github)) {
        log.warn(`No se pudo comentar en el issue #${issue}`)
      }
    }

    run.pr = prUrl
    updateStatus('done', 'completed')

    appendCompletedHistory(
      run.historyFile,
      run.eventsLog,
      () =>
        dumpJq({
          issue,
          title: issueTitle,
          pipeline: 'tooling',
          variant: variant.length > 0 ? variant : null,
          identity: parseJq(run.identityJson),
          runtime,
          started: timestamp,
          finished: localIsoSeconds(now()),
          state: 'completed',
          agents: {
            writer: { duration: run.writer.duration, metrics: parseJq(run.writer.metrics) },
            reviewer: { duration: run.reviewer.duration, metrics: parseJq(run.reviewer.metrics) },
          },
          tests: testsJsonValue(run.tests),
          pr: prUrl.length > 0 ? prUrl : null,
          log: run.logFile,
        }),
      { warn: (message) => log.warn(message), now },
    )

    // El status individual ya esta en el historial.
    rmSync(state(run.statusFilename), { force: true })

    // --- Limpieza ---
    log.header('Cleanup')
    log.log('Eliminando worktree...')
    if (!removeWorktree(repoRoot, worktree, worktreeTools)) {
      log.warn(`No se pudo eliminar el worktree. Eliminalo manualmente: git worktree remove --force ${worktree}`)
    }
    run.worktree = ''
    log.success('Worktree eliminado')

    const totalCommits = commits.split('\n').length
    const title = variant.length > 0 ? `=== Pipeline tooling (variante '${variant}') completado ===` : '=== Pipeline tooling completado ==='
    out(`\n${COLOR.cyan}${COLOR.bold}${title}${COLOR.reset}\n\n`)
    out(`  Commits: ${totalCommits}\n`)
    out(`  Rama:    ${branch}\n`)
    if (variant.length > 0) {
      out('  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)\n')
      out(`  Log:     ${run.logFile}\n`)
      out('\n')
      const hint = (text: string): void => out(`${COLOR.yellow}${text}${COLOR.reset}\n`)
      hint('Si esta variante gana la comparacion, promuevela a mano:')
      hint(`  git -C ${repoRoot} push -u origin ${branch}`)
      hint(`  gh pr create --base main --head ${branch} --title "${issueTitle}" --body "Closes #${issue}"`)
      hint('O relanza el pipeline sin --variant para que una corrida normal abra el PR.')
    } else {
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
  process.exitCode = await toolingPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'tooling-pipeline.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
