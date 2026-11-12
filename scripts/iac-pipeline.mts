// Pipeline IaC: escribe y revisa el HCL de un issue de infraestructura y abre su PR.
//
// Uso:
//   iac-pipeline.sh 42
//   iac-pipeline.sh 42 --env dev
//   iac-pipeline.sh 42 --from-stage 2      retoma desde el Stage 2 (revision estatica)
//
// Ciclo: issue -> worktree -> write (HCL) -> review (revision estatica) -> PR -> limpieza.
//
// El pipeline local NUNCA ejecuta `terraform plan` ni `terraform apply` (MEF-ADR-0021,
// MEF-ADR-0022): el writer escribe el HCL y el reviewer hace revision estatica (fmt -check,
// init -backend=false, validate), sin credenciales de Azure. El PR no lleva `Closes #N`: el plan
// corre en el PR (infra-cd.yml) y el apply al mergear a main, y ese workflow cierra el issue.
//
// Entorno: MEFISTO_RUN_AGENT_BIN (runner alterno), MEFISTO_HOLD_MAX_SECONDS (techo de la espera
// ante limite de uso o proveedor caido, 21600) y MEFISTO_HOLD_PROBE_SECONDS (cadencia de sondeo,
// 300), MEF-ADR-0051.

import type { ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { resolveModel } from '../src/runtime/lib/mefisto-models.mts'
import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions } from './lib/cli.mts'
import { harnessConfigEnv, loadHarnessConfig } from './lib/harness-config.mts'
import type { HarnessConfig } from './lib/harness-config.mts'
import { appendEventsLine, clockTime } from './lib/pipeline/agent-log.mts'
import { runtimeCliAvailable, runtimeSupportsResume } from './lib/pipeline/agent-runtime.mts'
import { getHarnessIdentity, harnessIdentityJson } from './lib/pipeline/harness-identity.mts'
import { resolveRunnerCommand, runAgentWithPolicy, runnerProcess } from './lib/pipeline/pipeline-agent-run.mts'
import type { AgentRunEvent, LaunchRunner } from './lib/pipeline/pipeline-agent-run.mts'
import { PipelineExit, runPipeline } from './lib/pipeline/pipeline-exit.mts'
import type { SignalSource } from './lib/pipeline/pipeline-exit.mts'
import { appendText, createAbort, createPipelineLog, runLogged } from './lib/pipeline/pipeline-log.mts'
import type { Abort, LoggedRun } from './lib/pipeline/pipeline-log.mts'
import {
  collectSummary,
  commentIssue,
  createPullRequest,
  parseIssueView,
  pushBranch,
  repoSlugFromRemoteUrl,
  summaryDetails,
  viewIssue,
} from './lib/pipeline/pipeline-pr.mts'
import { jsonText, localIsoSeconds, noHold, renderStatusJson, runStamp, writeStatus } from './lib/pipeline/pipeline-status.mts'
import type { HoldState } from './lib/pipeline/pipeline-status.mts'
import { PIPELINE_OWN_WRITES, createWorktree, hasPendingChanges, issueSlug, pipelineWorktreePath, removeWorktree, resumeWorktree } from './lib/pipeline/pipeline-worktree.mts'
import { findOpenPrForBranch } from './lib/pipeline/pull-requests.mts'
import { resolvePipelineAgentEffort } from './lib/pipeline/stage-models.mts'
import { renderWarningRemnantsSection } from './lib/pipeline/warning-remnants.mts'
import { statePath } from './lib/state.mts'

const SCRIPT_DIR = import.meta.dirname

const AGENT_TIMEOUT_SECONDS = '1800'

/** Lineas del log del agente que se muestran cuando falla. */
const AGENT_TAIL_LINES = 20

/** Lineas del diff que recibe el reviewer. */
const DIFF_CONTEXT_LINES = 200

const PUSH_RULE = "PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

export interface IacPromptInput {
  projectName: string
  issueContext: string
  environment: string
  /** Directorio del ambiente dentro del worktree, ruta real. */
  envDirAbs: string
  /** `infra/environments/<ambiente>`. */
  envDir: string
  snapshot: string
}

function promptHeader(input: IacPromptInput, contextTitle: string): string {
  return `Estas en el directorio raiz del proyecto ${input.projectName}.

${contextTitle}

${input.issueContext}

Ambiente target: ${input.environment}
Directorio del ambiente: ${input.envDirAbs}
Directorio relativo del ambiente: ${input.envDir}
Commit base: ${input.snapshot}`
}

export function iacStage1Prompt(input: IacPromptInput): string {
  return `${promptHeader(input, 'Contexto del issue de infraestructura a implementar:')}

Tu tarea: escribe o modifica los archivos Terraform necesarios para implementar este issue en el ambiente '${input.environment}'. Sigue todas las instrucciones de tu rol de infra-writer.

${PUSH_RULE}`
}

export function iacStage2Prompt(input: IacPromptInput & { diffContext: string }): string {
  return `${promptHeader(input, 'Contexto del issue:')}

Diff de archivos .tf modificados en esta rama:
${input.diffContext}

Tu tarea: revisa el HCL producido por infra-writer, corrige problemas de seguridad o calidad, y ejecuta la revision estatica ('terraform fmt -check', 'terraform init -backend=false' y 'terraform validate') en '${input.envDirAbs}'. NUNCA ejecutes 'terraform plan' ni 'terraform apply': no hay credenciales de Azure disponibles en este flujo local. Sigue todas las instrucciones de tu rol de infra-reviewer.

${PUSH_RULE}`
}

function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

/** Aviso del cuerpo del PR: el issue lo cierra el apply en CI, nunca el merge (MEF-ADR-0022). */
export function applyPendingLine(issue: string): string {
  return `> **Apply pendiente en CI**: este PR no cierra el issue #${issue}. El \`terraform apply\` lo ejecuta el workflow **Infra CD** al mergear este PR a \`main\` (MEF-ADR-0022); el issue se cierra automaticamente cuando ese apply termine exitosamente.`
}

export interface IacBodyInput {
  issue: string
  environment: string
  writerSummary: string
  /** Segundos del writer; `null` si no corrio en esta invocacion. */
  writerSeconds: number | null
  reviewerSummary: string
  reviewerSeconds: number | null
  /** Seccion de warnings remanentes, o vacia. */
  remnants: string
  /** `git diff --stat` de infra/, o `(ver diff del PR)`. */
  diffStat: string
  commits: string
}

export function iacPullRequestBody(input: IacBodyInput): string {
  return chomp(
    [
      '## Infraestructura',
      '',
      `Implementa los cambios de infraestructura del issue #${input.issue}.`,
      '',
      `- **Ambiente**: ${input.environment}`,
      '- **Estado**: HCL escrito y revisado localmente (sin plan ni apply local); pendiente de aplicar por CI',
      '- **Pipeline**: iac-pipeline.sh',
      '',
      '## Decisiones del pipeline',
      '',
      summaryDetails('infra-writer', input.writerSeconds, input.writerSummary),
      '',
      summaryDetails('infra-reviewer', input.reviewerSeconds, input.reviewerSummary),
      '',
      chomp(input.remnants),
      '',
      '## Cambios Terraform',
      '',
      input.diffStat,
      '',
      '## Commits',
      '',
      input.commits,
      '',
      applyPendingLine(input.issue),
    ].join('\n'),
  )
}

// El bash leia el JSON de `gh` con Python: `print()` de un valor, `.get()` de un objeto.
function pythonText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return JSON.stringify(value)
}

function parseObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

/** `true` si el issue lleva el label `bloqueado`; una respuesta que no se entiende cuenta como sin label. */
export function issueHasBlockedLabel(raw: string): boolean {
  const issue = parseObject(raw)
  if (issue === null) return false
  const labels = issue.labels
  if (labels === undefined || labels === null || labels === false || labels === 0 || labels === '') return false
  let items: unknown[]
  if (Array.isArray(labels)) items = labels
  else if (typeof labels === 'string') items = [...labels]
  else if (typeof labels === 'object') items = Object.keys(labels)
  else return false
  return items.some((label) =>
    typeof label === 'object' && label !== null && !Array.isArray(label) ? (label as Record<string, unknown>).name === 'bloqueado' : label === 'bloqueado',
  )
}

const DEPENDENCIES_SECTION = /^## Dependencias[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m

/** Cada `#N` de la seccion `## Dependencias`, sin repetir y en orden; cualquier mencion cuenta. */
export function dependencyReferences(body: string): string[] {
  const section = DEPENDENCIES_SECTION.exec(`${body}\n`)?.[1]
  if (section === undefined) return []
  return [...new Set([...section.matchAll(/#([0-9]+)/g)].map((found) => found[1] ?? ''))]
}

/** `state` y `title` de una dependencia, con los valores por defecto del bash si faltan. */
export function dependencyStatus(raw: string): { state: string; title: string } {
  const value = parseObject(raw)
  const field = (key: string, fallback: string): string =>
    value === null ? fallback : chomp(Object.hasOwn(value, key) ? pythonText(value[key]) : fallback)
  return { state: field('state', 'UNKNOWN'), title: field('title', 'titulo no disponible') }
}

/** Ultimas `count` lineas de `text` tal como las imprime `tail -n`. */
export function tailText(text: string, count: number): string {
  if (text.length === 0) return ''
  const ended = text.endsWith('\n')
  const lines = (ended ? text.slice(0, -1) : text).split('\n')
  return lines.slice(-count).join('\n') + (ended ? '\n' : '')
}

/** Primeras `count` lineas de `text`, como `head -n`. */
function headText(text: string, count: number): string {
  const lines = text.split('\n')
  if (lines.length <= count) return text
  return `${lines.slice(0, count).join('\n')}\n`
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

type AgentId = 'infra-writer' | 'infra-reviewer'

interface AgentTrack {
  model: string
  effort: string
  duration: number | null
  result: string
}

export interface IacPipelineDeps {
  argv: string[]
  /** Directorio del consumidor desde el que se lanza. */
  cwd: string
  env: NodeJS.ProcessEnv
  /** Ruta con que se muestra el script en el mensaje de uso. */
  scriptPath: string
  out: (text: string) => void
  err: (text: string) => void
  /** `git` y `gh` cuando su salida se lee. */
  run: Run
  /** `git`, `gh` y `terraform` cuando su salida va al log. */
  runLogged: LoggedRun
  hasCommand: (command: string) => boolean
  now: () => Date
  /** Espera de un hold; por defecto duerme de verdad. */
  sleep?: (seconds: number) => Promise<void>
  /** Sustituye al proceso del runner; sin el se lanza el runner neutral como proceso hijo. */
  launchRunner?: LaunchRunner
  signals?: SignalSource
  exit?: (code: number) => void
  /** Carpeta donde nace el directorio temporal de la corrida; por defecto, la del sistema. */
  tempRoot?: string
}

/** Corre el pipeline y devuelve su codigo de salida. */
export async function iacPipeline(deps: IacPipelineDeps): Promise<number> {
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
    err('ERROR: scripts/iac-pipeline.sh es del plugin publicado y solo aplica al consumidor.\n')
    err('Estas en el repo de Mefisto, que no tiene infraestructura Terraform/Azure.\n')
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

  const stateDir = nonEmpty(env.MEFISTO_STATE_DIR) ?? join(consumerRoot, '.mefisto', 'pipeline')
  const legacyStateDir = nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(consumerRoot, '.claude', 'pipeline')
  const stateEnv = { MEFISTO_STATE_DIR: stateDir, MEFISTO_LEGACY_STATE_DIR: legacyStateDir }
  const state = (rel: string): string => statePath(rel, undefined, stateEnv)
  // Lo que el pipeline bash exportaba y heredan el runner, el agente y los CLIs.
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
  state(join('logs', '.state'))
  const timestamp = runStamp(now())

  const run = {
    issue: '',
    issueTitle: '',
    environment: 'dev',
    statusFilename: '',
    logFile: join(logDir, `iac-pipeline-${timestamp}.log`),
    logFileAbs: '',
    /** Vacio hasta preparar el directorio del pipeline: antes, un aborto no deja status ni historial. */
    pipelineDirReady: false,
    historyFile: '',
    eventsLog: '',
    tmpDir: '',
    worktree: '',
    // Identidad declarada por el paquete; se revalida contra el runtime resuelto antes de dejar evidencia.
    identityJson: harnessIdentityJson(getHarnessIdentity()),
    runtime: '',
    writer: { model: '', effort: '', duration: null, result: 'pending' } as AgentTrack,
    reviewer: { model: '', effort: '', duration: null, result: 'pending' } as AgentTrack,
    /** Error del aborto, con sus saltos de linea vueltos espacios. */
    error: '',
    currentStage: 'setup',
    hold: noHold() as HoldState,
  }
  const currentLog = (): string => (run.logFileAbs.length > 0 ? run.logFileAbs : run.logFile)
  const log = createPipelineLog({ logFile: currentLog, out, now })
  const eventLine = (text: string): void => appendEventsLine(run.eventsLog, `[${clockTime(now())}] ${text}`)
  const track = (agent: AgentId): AgentTrack => (agent === 'infra-writer' ? run.writer : run.reviewer)
  // El titulo llega crudo de la respuesta de `gh`, con sus escapes JSON intactos.
  const titleJson = (): string => jsonText(run.issueTitle)
  const runtimeJson = (): string => (run.runtime.length > 0 ? jsonText(run.runtime) : 'null')

  const agentStatus = (agent: AgentTrack): string => `{"duration": ${agent.duration ?? 'null'}, "result": "${agent.result}"}`
  const updateStatus = (stage: string, statusState: string): void => {
    run.currentStage = stage
    writeStatus(
      state(run.statusFilename),
      renderStatusJson(
        [
          { key: 'issue', json: jsonText(run.issue.length > 0 ? run.issue : 'null') },
          { key: 'title', json: titleJson() },
          { key: 'environment', json: jsonText(run.environment.length > 0 ? run.environment : '?') },
          { key: 'pipeline', json: '"infra"' },
          { key: 'identity', json: run.identityJson },
          { key: 'runtime', json: runtimeJson() },
          { key: 'started', json: jsonText(timestamp) },
          { key: 'stage', json: jsonText(stage) },
          { key: 'state', json: jsonText(statusState) },
          { key: 'updated', json: jsonText(localIsoSeconds(now())) },
          { key: 'worktree', json: jsonText(run.worktree) },
          { key: 'log', json: jsonText(currentLog()) },
          {
            key: 'agents',
            members: [
              { key: 'infra-writer', json: agentStatus(run.writer) },
              { key: 'infra-reviewer', json: agentStatus(run.reviewer) },
            ],
          },
          { key: 'last_error', json: run.error.length > 0 ? jsonText(run.error) : 'null' },
        ],
        run.hold,
      ),
    )
  }

  const abort: Abort = createAbort({
    log,
    worktree: () => run.worktree,
    onStart: (message) => {
      run.error = `${message.replaceAll('\n', ' ')} `
    },
    record: () => {
      if (!run.pipelineDirReady) return
      updateStatus(run.currentStage, 'failed')
      const entry =
        `{"issue":${jsonText(run.issue)},"title":${titleJson()},"pipeline":"infra","identity":${run.identityJson},"runtime":${runtimeJson()},` +
        `"environment":${jsonText(run.environment)},"started":${jsonText(timestamp)},"finished":${jsonText(localIsoSeconds(now()))},` +
        `"state":"failed","stage":${jsonText(run.currentStage)},"error":${jsonText(run.error)},"log":${jsonText(run.logFileAbs)}}\n`
      appendText(run.historyFile, entry)
    },
  })

  let runnerChild: ChildProcess | null = null

  // Sin la reconciliacion del status que hacen otros pipelines: el bash de IaC no la tenia.
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
  /** `git` cuya salida va a la terminal, no al log: asi corrian en el bash el add y el commit del HCL. */
  const gitVisible = (args: string[]): void => {
    const result = deps.run('git', args, options)
    out(result.stdout)
    err(result.stderr)
    if (result.status !== 0) throw new PipelineExit(result.status ?? 1)
  }
  const realDir = (path: string): string => {
    try {
      return realpathSync.native(path)
    } catch {
      err(`realpath: ${path}: No such file or directory\n`)
      throw new PipelineExit(1)
    }
  }

  const main = async (): Promise<number> => {
    // --- Argumentos ---
    const argv = [...deps.argv]
    if (argv.length === 0) {
      out(`Uso: ${deps.scriptPath} <issue-num> [--env <dev|staging|prod>] [--from-stage N] [--status-file NOMBRE]\n`)
      return 1
    }
    let fromStage = '1'
    const positional: string[] = []
    const valueOf = (missing: string): string => {
      if (argv.length < 2) abort(missing)
      const value = argv[1] ?? ''
      argv.splice(0, 2)
      return value
    }
    while (argv.length > 0) {
      const arg = argv[0] ?? ''
      if (arg === '--env') run.environment = valueOf('Falta el nombre del ambiente')
      else if (arg === '--from-stage') fromStage = valueOf('Falta el numero de stage')
      else if (arg === '--status-file') run.statusFilename = valueOf('Falta el nombre del archivo de status')
      else if (/^[0-9]/.test(arg)) {
        positional.push(arg)
        argv.shift()
      } else abort(`Argumento no reconocido: ${arg}`)
    }
    if (positional.length > 0) run.issue = positional[0] ?? ''
    if (run.issue.length === 0) abort('Falta el numero de issue')
    const issue = run.issue
    if (run.statusFilename.length === 0) run.statusFilename = `pipeline-status-infra-${issue}.json`
    if (!/^[1-2]$/.test(fromStage)) abort('--from-stage debe ser 1 o 2')
    const environment = run.environment

    // El directorio del ambiente se busca desde donde se lanza, no desde la raiz del repo.
    const envDir = `infra/environments/${environment}`
    if (!isDirectory(resolve(cwd, envDir))) abort(`No existe el directorio de ambiente: ${envDir}`)

    // --- Dependencias: nunca el CLI de Azure ni su sesion, porque no hay plan ni apply local ---
    for (const command of ['gh', 'git', 'terraform']) {
      if (!deps.hasCommand(command)) abort(`Falta comando requerido: ${command}`)
    }
    const runner = resolveRunnerCommand(env, runtimeDir)
    if ('error' in runner) abort(runner.error)
    const resolved = await resolveRuntime('', env, deps.hasCommand)
    if ('error' in resolved) abort(`No se pudo resolver el runtime activo: ${resolved.error}`)
    const runtime = resolved.runtime
    run.runtime = runtime
    run.identityJson = harnessIdentityJson(getHarnessIdentity(runtime))
    if (!(await runtimeCliAvailable(runtime, { env, hasCommand: deps.hasCommand }))) {
      abort(`Falta el CLI del runtime resuelto ('${runtime}')`)
    }

    // --- Directorio del pipeline ---
    mkdirSync(logDir, { recursive: true })
    writeFileSync(run.logFile, `Pipeline IaC iniciado: ${timestamp}\n`)
    run.logFileAbs = state(join('logs', basename(run.logFile)))
    run.logFile = run.logFileAbs
    run.eventsLog = state('events.log')
    run.historyFile = state('pipeline-history.jsonl')
    run.pipelineDirReady = true
    try {
      run.tmpDir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'mefisto-iac.'))
    } catch {
      abort('No se pudo crear el directorio temporal del pipeline')
    }
    appendText(run.eventsLog, `=== SESSION IAC ${timestamp} issue:${issue} env:${environment} from-stage:${fromStage} runtime:${runtime} ===\n`)

    // --- Modelos y effort: el mapping del consumidor gana por clave exacta; sin el decide el adaptador o se hereda ---
    const consumerModelsFile = join(resolve(git(['rev-parse', '--show-toplevel'])), '.mefisto', 'models.json')
    for (const [agent, profile] of [['infra-writer', 'balanced'], ['infra-reviewer', 'deep']] as const) {
      const model = await resolveModel({ runtime, agentId: agent, profile, mappingFile: consumerModelsFile, env })
      if ('error' in model) {
        abort(`No se pudo resolver el modelo de ${agent} (perfil ${profile}): ${model.error.length > 0 ? model.error : 'motivo desconocido'}`)
      }
      track(agent).model = model.model
      eventLine(`MODELS: ${agent} runtime=${runtime} perfil=${profile} solicitado=<automatico> resuelto='${model.model.length > 0 ? model.model : '<heredado>'}'`)
    }
    for (const agent of ['infra-writer', 'infra-reviewer'] as const) {
      const effort = await resolvePipelineAgentEffort({ key: agent, agentId: agent, runtime, mappingFile: consumerModelsFile, eventsLog: run.eventsLog, env, now: now() })
      if ('error' in effort) {
        abort(`No se pudo resolver el effort de ${agent}: MEFISTO_EFFORTS_ERROR=${effort.error.length > 0 ? effort.error : 'motivo desconocido'}`)
      }
      track(agent).effort = effort.effort
    }

    // --- Issue ---
    log.header('Preparando contexto')
    log.log(`Descargando issue #${issue}...`)
    const rawIssue = viewIssue(issue, 'number,title,body,state,labels', { run: deps.run, logFile: currentLog(), cwd, env: childEnv })
    if (rawIssue === null) abort(`No se pudo obtener el issue #${issue}`)
    const view = parseIssueView(rawIssue)
    if (view.state !== 'OPEN') {
      abort(`El issue #${issue} esta ${view.state} -- una corrida solo procesa issues abiertos.
El cierre de un issue de infra lo hace el workflow de CI (infra-cd.yml) tras un 'terraform
apply' exitoso en main (MEF-ADR-0022), no este pipeline. Si necesitas reescribir/revisar la infra
de un issue ya cerrado, reabrelo primero.`)
    }
    if (view.title === null) throw new PipelineExit(1)
    run.issueTitle = view.title
    const issueTitle = view.title
    const issueContext = `# Issue #${issue}: ${issueTitle}\n\n${view.body}`
    log.log(`Issue: ${issueTitle}`)

    // --- Gate de dependencias: solo se consultan si el issue trae el label (MEF-ADR-0007) ---
    if (issueHasBlockedLabel(rawIssue)) {
      const pending: string[] = []
      for (const dependency of dependencyReferences(view.body)) {
        // Una referencia puede ser issue o PR: primero issue, el PR como respaldo.
        let raw = ''
        const asIssue = deps.run('gh', ['issue', 'view', dependency, '--json', 'state,title'], options)
        raw += asIssue.stdout
        if (asIssue.status !== 0) {
          const asPr = deps.run('gh', ['pr', 'view', dependency, '--json', 'state,title'], options)
          raw += asPr.stdout
          if (asPr.status !== 0) raw += '{"state":"UNKNOWN","title":"titulo no disponible"}\n'
        }
        const status = dependencyStatus(chomp(raw))
        if (status.state !== 'CLOSED' && status.state !== 'MERGED') pending.push(`  - #${dependency}: ${status.title} (${status.state})`)
      }
      if (pending.length > 0) {
        abort(`El issue #${issue} esta bloqueado. Dependencias abiertas:\n${pending.join('\n')}\n\nResuelve estas dependencias antes de lanzar el pipeline.`)
      }
      if (deps.runLogged('gh', ['issue', 'edit', issue, '--remove-label', 'bloqueado'], currentLog(), options) !== 0) {
        abort(`No se pudo quitar el label 'bloqueado' del issue #${issue}`)
      }
      log.success(`Dependencias resueltas: se quito el label 'bloqueado' del issue #${issue}`)
    }

    writeFileSync(join(run.tmpDir, 'infra-input.md'), `${issueContext}\n`)

    // --- Worktree ---
    log.header('Preparando worktree')
    const repoRoot = resolve(git(['rev-parse', '--show-toplevel']))
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = `infra-issue-${issue}-${issueSlug(issueTitle)}`
    run.worktree = pipelineWorktreePath(repoRoot, branch)
    const worktreeTools = { run: deps.run, runLogged: deps.runLogged, log, abort, cwd, env: childEnv }
    const worktreeGit = (args: string[]): string => git(['-C', run.worktree, ...args])

    let snapshot: string
    let envDirAbs: string
    if (Number(fromStage) > 1) {
      run.worktree = resumeWorktree({ repoRoot, branch, fromStage }, worktreeTools)
      snapshot = worktreeGit(['merge-base', 'HEAD', 'main'])
      log.log(`Snapshot detectado: ${snapshot}`)
      envDirAbs = realDir(join(run.worktree, envDir))
    } else {
      run.worktree = createWorktree({ repoRoot, branch, currentBranch }, worktreeTools)
      statePath(join('summaries', '.state'), run.worktree)

      // bootstrap-backend.sh deja el backend.tf en el checkout del consumidor, y el worktree nace
      // de origin/main, donde puede no estar versionado aun: se copia y se commitea para que viaje
      // en el PR. El reviewer sigue con `init -backend=false`; el backend remoto lo usa CI.
      const backendSrc = join(repoRoot, envDir, 'backend.tf')
      if (isFile(backendSrc)) {
        log.log('Copiando backend.tf del working tree al worktree...')
        mkdirSync(join(run.worktree, envDir), { recursive: true })
        copyFileSync(backendSrc, join(run.worktree, envDir, 'backend.tf'))
        const backendRel = `${envDir}/backend.tf`
        if (worktreeGit(['status', '--porcelain', '--', backendRel]).length > 0) {
          gitVisible(['-C', run.worktree, 'add', backendRel])
          gitVisible(['-C', run.worktree, 'commit', '-m', `infra(${environment}): incluir backend.tf generado por bootstrap`])
        } else {
          log.log('backend.tf ya estaba versionado e identico en origin/main -- sin cambios que commitear')
        }
      } else {
        log.warn(
          `No existe ${envDir}/backend.tf en el working tree -- el pipeline continua sin abortar; si necesitas backend remoto, ejecuta primero bootstrap-backend.sh`,
        )
      }

      envDirAbs = realDir(join(run.worktree, envDir))
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
    const runAgent = async (stage: string, agent: AgentId, prompt: string): Promise<number> => {
      const agentTrack = track(agent)
      const logBase = join(logDir, `iac-stage-${stage}-${agent}-${timestamp}-issue-${issue}`)
      const logStage = `${logBase}.log`
      eventLine(`=== IAC STAGE ${stage}: ${agent} ===`)
      agentTrack.result = 'running'
      updateStatus(`${stage}-${agent}`, 'running')
      log.log(`Invocando ${agent} (modelo: ${agentTrack.model.length > 0 ? agentTrack.model : '<heredado>'})...`)
      const summaryFile = statePath(join('summaries', `stage-${stage}-${agent}.md`), worktree)

      const onEvent = (event: AgentRunEvent): void => {
        switch (event.kind) {
          case 'failure':
            log.log(`${agent} fallo tras ${event.elapsedSeconds}s -- tipo: ${event.failureType}`)
            eventLine(`FALLO ${agent}: ${event.failureType}`)
            break
          case 'hold':
            run.hold = event.hold
            updateStatus(`${stage}-${agent}`, 'hold')
            break
          case 'hold-ceiling':
            log.warn(`${agent}: techo de espera (hold) agotado -- ultima senal: ${event.failureType}`)
            break
          case 'hold-waited':
            run.hold = { ...run.hold, accumulatedSeconds: event.holdSeconds }
            break
          case 'resume-degraded':
            log.warn(`${agent}: la sesion reanudada termino sin resumen; se degrada permanentemente a inicio limpio`)
            appendEventsLine(run.eventsLog, `[${clockTime(now())}][hold][resume] ${agent}: sesion reanudada murio de nuevo sin resumen -- degradado a stage desde cero`)
            break
          case 'resume-no-session':
            log.warn(`${agent}: terminal sin session_id; la sonda inicia de cero`)
            break
          case 'resume-unsupported':
            log.warn(`${agent}: runtime sin capacidad de reanudacion; la sonda inicia de cero`)
            break
          case 'resume':
            log.warn(`${agent}: ${event.failureType} -- en espera (hold), reanudando sesion truncada...`)
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
          extraArgs: ['--events-log', run.eventsLog, '--redact-observability', '--timeout', AGENT_TIMEOUT_SECONDS],
          model: agentTrack.model,
          effort: agentTrack.effort,
          eventsLog: run.eventsLog,
        },
        {
          resumeEvidence: () => {
            try {
              return statSync(summaryFile).size > 0
            } catch {
              return false
            }
          },
          supportsResume: () => runtimeSupportsResume(runtime, { env }),
        },
        { launchRunner, onEvent, env, now, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
      )
      run.hold = noHold(outcome.holdSeconds)

      if (outcome.failureType.length > 0) {
        // La duracion de un fallo incluye las esperas, como en el bash.
        agentTrack.duration = outcome.elapsedSeconds
        agentTrack.result = 'failed'
        updateStatus(`${stage}-${agent}`, 'failed')
        out(`\n${COLOR.red}-- Ultimas lineas del log de ${agent}:${COLOR.reset}\n`)
        let content: string
        try {
          content = readFileSync(logStage, 'utf8')
        } catch {
          err(`tail: ${logStage}: No such file or directory\n`)
          throw new PipelineExit(1)
        }
        out(tailText(content, AGENT_TAIL_LINES))
        abort(`${agent} fallo (${outcome.failureType}). Log completo: ${logStage}`)
      }
      const duration = outcome.elapsedSeconds - outcome.holdSeconds
      log.log(`${agent} completado en ${duration}s`)
      return duration
    }

    const terraformGate = (stage: string): void => {
      const terraform = (args: string[]): number | null => deps.runLogged('terraform', args, currentLog(), { cwd: envDirAbs, env: childEnv })
      if (terraform(['init', '-backend=false', '-input=false']) !== 0) abort(`Stage ${stage} fallido: terraform init fallo`)
      if (terraform(['validate']) !== 0) abort(`Stage ${stage} fallido: terraform validate fallo. Revisa el log.`)
    }
    const query = { run: deps.run, env: childEnv }
    const commitInfra = (announce: string, message: string): void => {
      if (!hasPendingChanges(query, worktree, ['infra/', ...PIPELINE_OWN_WRITES])) return
      log.log(announce)
      gitVisible(['-C', worktree, 'add', 'infra/'])
      gitVisible(['-C', worktree, 'commit', '-m', message])
    }
    const promptInput = { projectName: config.projectName, issueContext, environment, envDirAbs, envDir, snapshot }

    // --- Stage 1: infra-writer ---
    if (Number(fromStage) <= 1) {
      log.header('Stage 1: infra-writer (escribir HCL)')
      run.writer.duration = await runAgent('1', 'infra-writer', iacStage1Prompt(promptInput))
      run.writer.result = 'passed'
      log.log('Gate: verificando terraform validate...')
      terraformGate('1')
      log.success('Gate 1: HCL valido')
      commitInfra('Commiteando cambios de HCL...', `infra(${environment}): escritura HCL issue #${issue}`)
      updateStatus('1-infra-writer', 'passed')
    }

    // --- Stage 2: infra-reviewer ---
    log.header('Stage 2: infra-reviewer (revision estatica)')
    const diff = deps.run('git', ['-C', worktree, 'diff', 'main...HEAD', '--', 'infra/'], options)
    const diffContext = chomp(headText(diff.stdout, DIFF_CONTEXT_LINES) + (diff.status === 0 ? '' : '(sin diff disponible)\n'))
    run.reviewer.duration = await runAgent('2', 'infra-reviewer', iacStage2Prompt({ ...promptInput, diffContext }))
    run.reviewer.result = 'passed'
    log.log('Gate: verificando terraform validate tras la revision...')
    terraformGate('2')
    log.success('Gate 2: HCL revisado y valido')
    commitInfra('Commiteando correcciones del reviewer...', `infra(${environment}): correcciones de revision issue #${issue}`)
    updateStatus('2-infra-reviewer', 'passed')

    const repoSlug = repoSlugFromRemoteUrl(worktreeGit(['remote', 'get-url', 'origin']))
    const commits = worktreeGit(['log', `${snapshot}..HEAD`, '--oneline'])
    if (commits.length === 0) abort(`No hay commits en la rama ${branch}.`)

    // --- Sincronizar con main ---
    log.header('Sincronizando con main')
    log.log('Actualizando main desde origin...')
    const worktreeLogged = (args: string[]): number | null => deps.runLogged('git', ['-C', worktree, ...args], currentLog(), options)
    if (worktreeLogged(['fetch', 'origin', 'main']) !== 0) abort('No se pudo hacer fetch de origin/main')
    const behind = worktreeGit(['rev-list', 'HEAD..origin/main', '--count'])
    if (Number(behind) === 0) {
      log.log('La rama ya esta al dia con main')
    } else {
      log.log(`main tiene ${behind} commit(s) nuevos. Haciendo merge...`)
      if (worktreeLogged(['merge', 'origin/main', '--no-edit']) !== 0) abort(`Merge con main tiene conflictos. Resuelve manualmente en: ${worktree}`)
      log.success('Merge automatico exitoso')
    }

    // --- PR: nunca cierra el issue, lo cierra el apply en CI (MEF-ADR-0022) ---
    log.header('Creando PR')
    const github = { run: deps.run, runLogged: deps.runLogged, logFile: currentLog(), cwd, env: childEnv }
    log.log('Haciendo push de la rama...')
    if (!pushBranch(worktree, branch, github)) abort(`No se pudo hacer push de la rama ${branch}`)

    // Un agente que creo el PR por su cuenta, contra su prompt, no debe dejar el rastro del PR vacio.
    log.log('Verificando si ya existe un PR abierto para la rama...')
    const existing = findOpenPrForBranch(branch, { repo: repoSlug, run: (command, args, given) => deps.run(command, args, { ...given, ...options }) })
    let prUrl = ''
    if (existing !== null) {
      prUrl = existing
      log.success(`PR existente reutilizado: ${prUrl}`)
    } else {
      const summary = (stage: string, agent: AgentId): string => collectSummary(statePath(join('summaries', `stage-${stage}-${agent}.md`), worktree))
      const stat = deps.run('git', ['-C', worktree, 'diff', 'main...HEAD', '--stat', '--', 'infra/'], options)
      const created = createPullRequest(
        {
          title: `infra(${environment}): #${issue} ${issueTitle}`,
          body: iacPullRequestBody({
            issue,
            environment,
            writerSummary: summary('1', 'infra-writer'),
            writerSeconds: run.writer.duration,
            reviewerSummary: summary('2', 'infra-reviewer'),
            reviewerSeconds: run.reviewer.duration,
            remnants: renderWarningRemnantsSection(worktree),
            diffStat: chomp(stat.status === 0 ? stat.stdout : `${stat.stdout}(ver diff del PR)\n`),
            commits,
          }),
          head: branch,
          repo: repoSlug,
        },
        github,
      )
      if (created === null) log.warn('No se pudo crear el PR automaticamente')
      prUrl = created ?? ''
      if (prUrl.length > 0) log.success(`PR creado: ${prUrl}`)
    }

    const comment = `Pipeline IaC completado (HCL escrito y revisado, sin plan ni apply local). PR: ${prUrl.length > 0 ? prUrl : 'pendiente'}. Infra pendiente de aplicar por CI: el workflow **Infra CD** aplica al mergear a main y cierra este issue tras un apply exitoso (MEF-ADR-0022).`
    if (!commentIssue(issue, comment, repoSlug, github)) log.warn(`No se pudo comentar en el issue #${issue}`)

    appendFileSync(
      run.historyFile,
      `{"issue":${jsonText(issue)},"title":${titleJson()},"pipeline":"infra","identity":${run.identityJson},"runtime":${runtimeJson()},` +
        `"environment":${jsonText(environment)},"started":${jsonText(timestamp)},"finished":${jsonText(localIsoSeconds(now()))},"state":"completed",` +
        `"agents":{"infra-writer":${agentHistory(run.writer)},"infra-reviewer":${agentHistory(run.reviewer)}},` +
        `"pr":${jsonText(prUrl)},"log":${jsonText(run.logFile)}}\n`,
    )
    updateStatus('completed', 'completed')
    // El status individual ya esta en el historial.
    rmSync(state(run.statusFilename), { force: true })

    // --- Limpieza ---
    log.header('Cleanup')
    log.log('Eliminando worktree...')
    rmSync(run.tmpDir, { recursive: true, force: true })
    if (!removeWorktree(repoRoot, worktree, worktreeTools)) {
      log.warn(`No se pudo eliminar el worktree. Eliminalo manualmente: git worktree remove --force ${worktree}`)
    }
    run.worktree = ''
    log.success('Worktree eliminado')

    out(`\n${COLOR.cyan}${COLOR.bold}=== Pipeline IaC completado ===${COLOR.reset}\n\n`)
    out(`  Issue:     #${issue} -- ${issueTitle}\n`)
    out(`  Ambiente:  ${environment}\n`)
    out(`  Commits:   ${commits.split('\n').length}\n`)
    out(`  Rama:      ${branch}\n`)
    if (prUrl.length > 0) out(`  PR:        ${prUrl}\n`)
    out(`  Log:       ${run.logFileAbs}\n\n`)
    out(
      `${COLOR.yellow}Infra pendiente de aplicar por CI:${COLOR.reset} el workflow Infra CD aplica al mergear el PR a main y cierra el issue #${issue} tras un apply exitoso (MEF-ADR-0022).\n\n`,
    )
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

function agentHistory(agent: AgentTrack): string {
  return `{"duration":${agent.duration ?? 'null'},"result":"${agent.result}"}`
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await iacPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'iac-pipeline.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
