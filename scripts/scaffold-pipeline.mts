// Pipeline que crea un dominio nuevo en el proyecto consumidor.
//
// Uso:
//   scaffold-pipeline.sh 42                          issue (extrae el dominio del body)
//   scaffold-pipeline.sh 42 --domain calculo-horas   issue + dominio explicito
//   scaffold-pipeline.sh --domain calculo-horas      sin issue (solo scaffold + PR)
//   scaffold-pipeline.sh --help
//
// Ciclo: issue -> label dom:X -> worktree -> domain-scaffolder -> gates -> PR -> limpieza.
//
// Entorno: MEFISTO_RUN_AGENT_BIN (runner alterno), MEFISTO_HOLD_MAX_SECONDS (techo de la espera
// ante limite de uso o proveedor caido, 21600) y MEFISTO_HOLD_PROBE_SECONDS (cadencia de sondeo,
// 300), MEF-ADR-0051.

import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { resolveModel } from '../src/runtime/lib/mefisto-models.mts'
import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions } from './lib/cli.mts'
import { harnessConfigEnv, loadHarnessConfig } from './lib/harness-config.mts'
import type { HarnessConfig } from './lib/harness-config.mts'
import { appendEventsLine, clockTime } from './lib/pipeline/agent-log.mts'
import { runtimeCliAvailable, runtimeSupportsResume } from './lib/pipeline/agent-runtime.mts'
import { resolveRunnerCommand, runAgentWithPolicy, runnerProcess } from './lib/pipeline/pipeline-agent-run.mts'
import type { AgentRunEvent, LaunchRunner } from './lib/pipeline/pipeline-agent-run.mts'
import { PipelineExit, runPipeline } from './lib/pipeline/pipeline-exit.mts'
import type { SignalSource } from './lib/pipeline/pipeline-exit.mts'
import { appendText, createAbort, createPipelineLog, runLogged } from './lib/pipeline/pipeline-log.mts'
import type { Abort, LogGlyphs, LogKind, LoggedRun } from './lib/pipeline/pipeline-log.mts'
import { commentIssue, createPullRequest, pushBranch, repoSlugFromRemoteUrl } from './lib/pipeline/pipeline-pr.mts'
import { jsonText, localIsoSeconds, runStamp } from './lib/pipeline/pipeline-status.mts'
import { PIPELINE_OWN_WRITES, autoCommitIfNeeded, createWorktree, hasPendingChanges, removeWorktree } from './lib/pipeline/pipeline-worktree.mts'
import { findOpenPrForBranch } from './lib/pipeline/pull-requests.mts'
import { OTEL_PIN_CANONICO, checkOtelPin } from './lib/pipeline/scaffold-otel-pins.mts'
import { resolvePipelineAgentEffort } from './lib/pipeline/stage-models.mts'
import { renderWarningRemnantsSection } from './lib/pipeline/warning-remnants.mts'
import { statePath } from './lib/state.mts'

const SCRIPT_DIR = import.meta.dirname

const AGENT = 'domain-scaffolder'
const AGENT_TIMEOUT_SECONDS = '1800'
const RESUME_TASK_PROMPT = 'Continue the same task and complete it.'

const GLYPHS: LogGlyphs = { success: '✓', warn: '⚠', error: 'x', rule: '--' }

/** Linea de cada mensaje en el archivo de log: etiquetas en vez de las marcas de pantalla. */
function fileLine(kind: LogKind, message: string, clock: string): string {
  switch (kind) {
    case 'log':
      return `[${clock}] ${message}`
    case 'success':
      return `OK ${message}`
    case 'warn':
      return `WARN ${message}`
    case 'header':
      return `-- ${message} --`
  }
}

// El bash imprimia la ayuda con `cat`, que no interpreta los escapes de color: salen literales.
const RAW = { cyan: '\\033[0;36m', bold: '\\033[1m', reset: '\\033[0m' }

export const SCAFFOLD_HELP = `
${RAW.cyan}${RAW.bold}scaffold-pipeline.sh${RAW.reset} - Pipeline para crear un nuevo dominio

${RAW.bold}Uso:${RAW.reset}
  ./scripts/scaffold-pipeline.sh 42                          Issue (extrae dominio del body)
  ./scripts/scaffold-pipeline.sh 42 --domain calculo-horas   Issue + dominio explicito
  ./scripts/scaffold-pipeline.sh --domain calculo-horas       Sin issue (solo scaffold + PR)

${RAW.bold}El issue debe contener en el body:${RAW.reset}
  Dominio: nombre-en-kebab

${RAW.bold}El script:${RAW.reset}
  1. Crea el label dom:X y lo asigna al issue
  2. Crea un worktree aislado
  3. Invoca el agente domain-scaffolder
  4. Crea un PR con "Closes #N"
  5. Limpia el worktree

`

function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

const DOMAIN_LINE = /^.*[Dd]ominio:[ \t\v\f\r]*([a-zA-Z][a-zA-Z0-9-]*).*$/s

/** Primer `Dominio: <nombre>` del body; en una linea con varios, el ultimo. Vacio si no hay. */
export function domainFromIssueBody(body: string): string {
  for (const line of body.split('\n')) {
    const found = DOMAIN_LINE.exec(line)?.[1]
    if (found !== undefined) return found
  }
  return ''
}

/** kebab-case desde PascalCase, camelCase o snake_case, linea por linea. */
export function normalizeDomain(name: string): string {
  return chomp(
    name
      .split('\n')
      .map((line) => line.replaceAll('_', '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2'))
      .join('\n')
      .replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
  )
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** Como el `grep -qE` del bash: basta con que una linea sea kebab-case. */
export function isKebabDomain(domain: string): boolean {
  return domain.split('\n').some((line) => KEBAB.test(line))
}

export function pascalCase(domain: string): string {
  return domain
    .split('\n')
    .map((line) =>
      line
        .split('-')
        .map((part) => part.charAt(0).replace(/[a-z]/, (letter) => letter.toUpperCase()) + part.slice(1))
        .join(''),
    )
    .join('\n')
}

export function scaffoldPrompt(domain: string): string {
  return `Crea el scaffold para el dominio '${domain}'. El usuario ya confirmo la creacion -- omite la confirmacion del Paso 0 y procede directamente a crear el proyecto.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.`
}

export interface ScaffoldBodyInput {
  domain: string
  pascal: string
  namespacePrefix: string
  /** `git log --oneline main..HEAD`, o `(sin commits)`. */
  commits: string
  /** Seccion de warnings remanentes, o vacia. */
  remnants: string
  /** `Closes #N`, o vacia sin issue. */
  closesLine: string
}

export function scaffoldPullRequestBody(input: ScaffoldBodyInput): string {
  const { domain, pascal, namespacePrefix: prefix } = input
  return chomp(
    [
      '## Resumen',
      '',
      `Scaffold del dominio **${pascal}** (\`${domain}\`) creado con domain-scaffolder.`,
      '',
      '### Incluye',
      `- Function App: \`src/${prefix}.${pascal}/\``,
      `- Tests: \`tests/${prefix}.${pascal}.Tests/\``,
      `- Smoke Tests: \`tests/${prefix}.${pascal}.SmokeTests/\``,
      `- Terraform: storage account + function app en \`infra/environments/dev/dominio-${domain}.tf\``,
      `- GitHub Actions: \`.github/workflows/deploy-${domain}.yml\` (+ workflows \`smoke-tests-dominio.yml\` y \`smoke-tests.yml\` la primera vez en el repo)`,
      `- Smoke tests: registro del dominio en \`.github/smoke-tests/${domain}.json\``,
      '',
      '## Commits',
      '',
      input.commits,
      '',
      chomp(input.remnants),
      '',
      input.closesLine,
    ].join('\n'),
  )
}

// `print()` de Python sobre un valor del JSON del issue.
function pythonText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return JSON.stringify(value)
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

export interface ScaffoldPipelineDeps {
  argv: string[]
  /** Directorio del consumidor desde el que se lanza. */
  cwd: string
  env: NodeJS.ProcessEnv
  out: (text: string) => void
  err: (text: string) => void
  /** `git` y `gh` cuando su salida se lee. */
  run: Run
  /** `git` y `gh` cuando su salida va al log. */
  runLogged: LoggedRun
  hasCommand: (command: string) => boolean
  now: () => Date
  /** Distingue el log de dos corridas lanzadas en el mismo segundo; por defecto, el PID. */
  pid?: number
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
export async function scaffoldPipeline(deps: ScaffoldPipelineDeps): Promise<number> {
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
    err('ERROR: scripts/scaffold-pipeline.sh es del plugin publicado y solo aplica al consumidor.\n')
    err('Estas en el repo de Mefisto, que no crea dominios de negocio.\n')
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

  /** `git` cuya salida se necesita: si falla, el pipeline termina con su codigo, sin mas mensajes. */
  const git = (args: string[]): string => {
    const result = deps.run('git', args, { cwd, env: childEnv })
    if (result.status !== 0) {
      if (result.stderr.length > 0) err(result.stderr)
      throw new PipelineExit(result.status ?? 1)
    }
    return chomp(result.stdout)
  }
  const repoRoot = consumerRoot
  const logDir = join(stateDir, 'logs')
  state(join('logs', '.state'))
  const timestamp = runStamp(now())
  // El PID separa dos scaffolds lanzados en el mismo segundo.
  const logFile = join(logDir, `scaffold-${timestamp}-${deps.pid ?? process.pid}.log`)
  const eventsLog = state('events.log')
  const historyFile = state('pipeline-history.jsonl')
  appendText(eventsLog, '')

  const log = createPipelineLog({ logFile: () => logFile, out, now, glyphs: GLYPHS, fileLine })
  const eventLine = (text: string): void => appendEventsLine(eventsLog, `[${clockTime(now())}] ${text}`)

  let worktree = ''
  let tmpDir = ''
  let aborting = false
  let signaled = false
  let runnerChild: ChildProcess | null = null

  const abort: Abort = createAbort({
    log,
    worktree: () => worktree,
    stream: err,
    details: false,
    render: (message) => ({ stream: `\n${COLOR.red}${COLOR.bold}x ${message}${COLOR.reset}\n`, file: `ABORT ${message}\n` }),
    onStart: () => {
      aborting = true
    },
  })

  const finalize = (exitCode: number): void => {
    if (tmpDir.length > 0) rmSync(tmpDir, { recursive: true, force: true })
    // Un comando que falla sin aborto deja el worktree para inspeccionarlo.
    if (exitCode !== 0 && !aborting && !signaled && worktree.length > 0 && isDirectory(worktree)) {
      log.warn(`Error detectado. El worktree queda disponible para inspeccion: ${worktree}`)
    }
  }

  const main = async (): Promise<number> => {
    try {
      tmpDir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'mefisto-scaffold.'))
    } catch {
      abort('No se pudo crear el directorio temporal del pipeline')
    }

    // --- Argumentos ---
    const argv = [...deps.argv]
    let issue = ''
    let domain = ''
    while (argv.length > 0) {
      const arg = argv[0] ?? ''
      if (arg === '--help' || arg === '-h') {
        out(SCAFFOLD_HELP)
        return 0
      }
      if (arg === '--domain') {
        if (argv.length < 2) abort('Falta el nombre del dominio para --domain')
        domain = argv[1] ?? ''
        argv.splice(0, 2)
      } else if (arg.startsWith('--domain=')) {
        domain = arg.slice('--domain='.length)
        argv.shift()
      } else if (/^[0-9]/.test(arg)) {
        issue = arg
        argv.shift()
      } else {
        abort(`Argumento desconocido: ${arg}. Usa --help para ver el uso.`)
      }
    }

    // --- Dependencias y frontera neutral ---
    for (const command of ['gh', 'git']) {
      if (!deps.hasCommand(command)) abort(`${command} no esta instalado`)
    }
    const runner = resolveRunnerCommand(env, runtimeDir)
    if ('error' in runner) abort(runner.error)
    const resolved = await resolveRuntime('', env, deps.hasCommand)
    if ('error' in resolved) abort(`No se pudo resolver el runtime activo: ${resolved.error}`)
    const runtime = resolved.runtime
    if (!(await runtimeCliAvailable(runtime, { env, hasCommand: deps.hasCommand }))) {
      abort(`Falta el CLI del runtime resuelto ('${runtime}')`)
    }

    const repoSlug = repoSlugFromRemoteUrl(git(['-C', repoRoot, 'remote', 'get-url', 'origin']))
    const github = { run: deps.run, runLogged: deps.runLogged, logFile, cwd, env: childEnv }
    const options: CommandOptions = { cwd, env: childEnv }
    const logged = (command: string, args: string[]): number | null => deps.runLogged(command, args, logFile, options)

    // --- Issue ---
    if (issue.length > 0) {
      log.header(`Descargando issue #${issue}`)
      const view = deps.run('gh', ['issue', 'view', issue, '--json', 'number,title,body,state', '--repo', repoSlug], options)
      appendText(logFile, view.stderr)
      if (view.status !== 0) abort(`No se pudo obtener el issue #${issue}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(view.stdout)
      } catch {
        throw new PipelineExit(1)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new PipelineExit(1)
      const fields = parsed as Record<string, unknown>
      const field = (key: string): string => {
        if (!Object.hasOwn(fields, key)) throw new PipelineExit(1)
        return chomp(pythonText(fields[key]))
      }
      const issueState = field('state')
      if (issueState !== 'OPEN') abort(`El issue #${issue} no esta abierto (estado: ${issueState})`)
      const issueTitle = field('title')
      const issueBody = field('body')
      log.log(`Issue: #${issue} - ${issueTitle}`)
      if (domain.length === 0) {
        domain = domainFromIssueBody(issueBody)
        if (domain.length > 0) log.log(`Dominio extraido del issue: ${domain}`)
      }
    }

    // --- Dominio ---
    if (domain.length === 0) {
      abort("No se pudo determinar el nombre del dominio. Usa --domain <nombre> o incluye 'Dominio: nombre' en el body del issue.")
    }
    domain = normalizeDomain(domain)
    if (!isKebabDomain(domain)) abort(`El nombre del dominio no se pudo normalizar a kebab-case. Recibido: ${domain}`)
    const pascal = pascalCase(domain)
    log.log(`Dominio: ${domain} (PascalCase: ${pascal})`)
    const project = `${prefix}.${pascal}`
    if (isDirectory(join(repoRoot, 'src', project))) abort(`El dominio ya existe: src/${project}`)

    // --- Label ---
    log.header('Configurando label')
    const label = `dom:${domain}`
    if (logged('gh', ['label', 'create', label, '--color', '0E8A16', '--description', `Dominio ${pascal}`, '--force', '--repo', repoSlug]) !== 0) {
      log.warn(`No se pudo crear el label ${label} (puede que ya exista)`)
    }
    log.success(`Label ${label} listo`)
    if (issue.length > 0) {
      if (logged('gh', ['issue', 'edit', issue, '--add-label', label, '--repo', repoSlug]) !== 0) {
        log.warn(`No se pudo asignar el label al issue #${issue}`)
      }
      log.log(`Label asignado al issue #${issue}`)
    }

    // --- Worktree ---
    log.header('Preparando worktree')
    const currentBranch = git(['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = issue.length > 0 ? `scaffold-issue-${issue}-${domain}` : `scaffold-${domain}`
    const consumerModelsFile = join(repoRoot, '.mefisto', 'models.json')
    // El effort se resuelve antes de crear el worktree; un mapping invalido aborta ahi.
    const effortResolution = await resolvePipelineAgentEffort({ key: AGENT, agentId: AGENT, runtime, mappingFile: consumerModelsFile, env })
    const worktreeTools = { run: deps.run, runLogged: deps.runLogged, log, abort, cwd: repoRoot, env: childEnv }
    let effort = ''
    worktree = createWorktree(
      {
        repoRoot,
        branch,
        currentBranch,
        beforeCreate: () => {
          if ('error' in effortResolution) {
            abort(`No se pudo resolver el effort de ${AGENT}: MEFISTO_EFFORTS_ERROR=${effortResolution.error.length > 0 ? effortResolution.error : 'motivo desconocido'}`)
          }
          effort = effortResolution.effort
          eventLine(`EFFORTS: ${AGENT} -> ${effort.length > 0 ? effort : '<heredado>'} (nivel ${effortResolution.level})`)
        },
      },
      worktreeTools,
    )
    const wt = worktree

    // --- Modelo neutral: el mapping del consumidor gana por clave exacta; sin el decide el adaptador o se hereda ---
    const resolvedModel = await resolveModel({ runtime, agentId: AGENT, profile: 'balanced', mappingFile: consumerModelsFile, env })
    if ('error' in resolvedModel) {
      abort(`No se pudo resolver el modelo de ${AGENT} (perfil balanced): ${resolvedModel.error.length > 0 ? resolvedModel.error : 'motivo desconocido'}`)
    }
    const model = resolvedModel.model
    const shownModel = model.length > 0 ? model : '<heredado>'
    eventLine(`MODELS: ${AGENT} runtime=${runtime} perfil=balanced solicitado=<automatico> resuelto='${shownModel}'`)

    // --- domain-scaffolder ---
    log.header(`Invocando ${AGENT} (modelo: ${shownModel})...`)
    eventLine(`=== SCAFFOLD: ${AGENT} para '${domain}' ===`)

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
    const logBase = join(logDir, `scaffold-agent-${timestamp}-${domain}-${deps.pid ?? process.pid}`)
    const agentLog = (attempt: number): string => `${logBase}-attempt-${attempt}.log`
    const onEvent = (event: AgentRunEvent): void => {
      switch (event.kind) {
        case 'failure':
          eventLine(`FALLO ${AGENT}: ${event.failureType}`)
          break
        case 'hold-ceiling':
          log.warn(`${AGENT}: techo de espera (hold) agotado -- ultima senal: ${event.failureType}`)
          break
        case 'hold-waited':
          log.warn(`${AGENT}: ${event.failureType} -- en espera (hold), reintentando...`)
          break
        case 'resume-degraded':
          log.warn(`${AGENT}: la sesion reanudada termino sin crear el proyecto; se degrada permanentemente a inicio limpio`)
          break
        case 'resume-no-session':
          log.warn(`${AGENT}: terminal sin session_id; la sonda inicia de cero`)
          break
        case 'resume-unsupported':
          log.warn(`${AGENT}: runtime sin capacidad de reanudacion; la sonda inicia de cero`)
          break
        default:
          break
      }
    }
    const outcome = await runAgentWithPolicy(
      {
        runtime,
        agentId: AGENT,
        worktree: wt,
        prompt: scaffoldPrompt(domain),
        promptFile: join(tmpDir, 'scaffold.prompt.md'),
        systemFile: join(tmpDir, 'scaffold.system.md'),
        resumePrompt: RESUME_TASK_PROMPT,
        resumePromptFile: (attempt) => join(tmpDir, `scaffold-resume-${attempt}.prompt.md`),
        eventsFile: (attempt) => `${logBase}-attempt-${attempt}.events.jsonl`,
        stageLog: agentLog,
        runnerOutput: () => join(tmpDir, 'scaffold.runner.log'),
        extraArgs: ['--events-log', eventsLog, '--redact-observability', '--timeout', AGENT_TIMEOUT_SECONDS],
        model,
        effort,
        eventsLog,
      },
      {
        resumeEvidence: () => isDirectory(join(wt, 'src', project)),
        supportsResume: () => runtimeSupportsResume(runtime, { env }),
      },
      { launchRunner, onEvent, env, now, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
    )
    const scaffoldLog = agentLog(outcome.attempts)
    if (outcome.failureType.length > 0) {
      abort(`El scaffold del dominio '${domain}' fallo despues de ${outcome.elapsedSeconds}s (${outcome.failureType}). Revisa: ${scaffoldLog}`)
    }
    const duration = outcome.elapsedSeconds - outcome.holdSeconds

    if (!isDirectory(join(wt, 'src', project))) abort(`El scaffold no creo src/${project} -- revisa: ${scaffoldLog}`)
    eventLine(`OK ${AGENT} (${duration}s)`)
    log.success(`Scaffold completado en ${duration}s`)

    // --- Commit defensivo: el commit del agente no es determinista ---
    // Se excluye el estado del pipeline y, como defensa ante estado legacy, el arbol `.claude/`
    // completo: nombrar como exclusion una hija ignorada hace fallar a `git add`.
    const pathspec = ['.', ...PIPELINE_OWN_WRITES, ':!.claude/']
    const query = { run: deps.run, env: childEnv }
    if (hasPendingChanges(query, wt, pathspec)) {
      log.warn('El agente dejo cambios sin commitear; commiteando defensivamente.')
      const committed = autoCommitIfNeeded(
        { worktree: wt, message: `scaffold(${domain}): nuevo dominio ${pascal}`, pathspec, addAll: true, stopOnAddFailure: true },
        worktreeTools,
      )
      if (committed !== null && committed.addStatus !== 0) abort("Fallo el 'git add -A' del commit defensivo del scaffold")
      if (committed !== null && committed.commitStatus !== 0) abort('Fallo el commit defensivo del scaffold')
    }

    const ahead = deps.run('git', ['-C', wt, 'log', '--oneline', 'origin/main..HEAD'], options)
    if (chomp(ahead.stdout).length === 0) {
      abort(`El scaffold no genero ningun commit sobre origin/main; nada que pushear. Revisa: ${scaffoldLog}`)
    }

    // --- Gate de integridad textual: diagnostica, no corrige ---
    log.header('Verificando integridad textual')
    if (logged('git', ['-C', wt, 'diff', '--check', 'origin/main...HEAD']) !== 0) {
      abort(
        `El scaffold contiene errores de whitespace detectados por 'git diff --check'. Corrige el output del generador sin normalizarlo automaticamente y revisa el diagnostico en: ${logFile}`,
      )
    }
    log.success('Integridad textual verificada')

    // --- Gate de pines OpenTelemetry: el agente puede omitir su propio paso de verificacion ---
    log.header('Verificando pines OpenTelemetry')
    const pins: [string, string][] = [
      ['OpenTelemetry.Extensions.Hosting', join(wt, 'src', project, `${project}.csproj`)],
      ['OpenTelemetry.Exporter.InMemory', join(wt, 'tests', `${project}.Tests`, `${project}.Tests.csproj`)],
    ]
    for (const [paquete, csproj] of pins) {
      const problem = checkOtelPin(paquete, OTEL_PIN_CANONICO, csproj)
      if (problem !== null) {
        out(`${problem}\n`)
        log.append(`${problem}\n`)
        abort(`El pin de ${paquete} debe ser ${OTEL_PIN_CANONICO} en ${csproj}. Corrige el scaffold sin normalizarlo automaticamente.`)
      }
    }
    log.success('Pines OpenTelemetry verificados')

    // --- Push y PR ---
    log.header('Creando PR')
    log.log('Haciendo push de la rama...')
    if (!pushBranch(wt, branch, github)) abort(`No se pudo hacer push de la rama ${branch}`)

    log.log('Verificando si ya existe un PR abierto para la rama...')
    const existing = findOpenPrForBranch(branch, {
      repo: repoSlug,
      run: (command, args, given) => deps.run(command, args, { ...given, ...options }),
    })
    let prUrl: string
    if (existing !== null) {
      prUrl = existing
      log.success(`PR existente reutilizado: ${prUrl}`)
    } else {
      // Contra `main` local, no `origin/main`: asi lo listaba el bash.
      const commitsRun = deps.run('git', ['-C', wt, 'log', '--oneline', 'main..HEAD'], options)
      const commits = chomp(commitsRun.status === 0 ? commitsRun.stdout : `${commitsRun.stdout}(sin commits)\n`)
      const title = issue.length > 0 ? `#${issue} scaffold(${domain}): nuevo dominio ${pascal}` : `scaffold(${domain}): nuevo dominio ${pascal}`
      log.log('Creando PR...')
      const created = createPullRequest(
        {
          title,
          body: scaffoldPullRequestBody({
            domain,
            pascal,
            namespacePrefix: prefix,
            commits,
            remnants: renderWarningRemnantsSection(wt),
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

    if (issue.length > 0 && !commentIssue(issue, `Scaffold del dominio \`${domain}\` completado. PR: ${prUrl}`, repoSlug, github)) {
      log.warn(`No se pudo comentar en el issue #${issue}`)
    }

    const history =
      `{"pipeline":"scaffold","runtime":${jsonText(runtime)},"domain":${jsonText(domain)},"issue":${jsonText(issue)},` +
      `"started":${jsonText(timestamp)},"finished":${jsonText(localIsoSeconds(now()))},"state":"completed",` +
      `"duration":${duration},"pr":${jsonText(prUrl)},"log":${jsonText(logFile)}}\n`
    appendText(historyFile, history)

    // --- Limpieza ---
    log.header('Cleanup')
    log.log('Eliminando worktree...')
    rmSync(tmpDir, { recursive: true, force: true })
    if (!removeWorktree(repoRoot, wt, worktreeTools)) {
      log.warn(`No se pudo eliminar el worktree automaticamente. Eliminalo manualmente: git worktree remove --force ${wt}`)
    }
    worktree = ''
    log.success('Worktree eliminado')

    const { green, bold, yellow, reset } = COLOR
    const rule = `${green}${bold}========================================${reset}`
    out(`\n${rule}\n${green}${bold}  Scaffold completado exitosamente${reset}\n${rule}\n\n`)
    out(`  Dominio:  ${bold}${pascal}${reset} (${domain})\n`)
    if (issue.length > 0) out(`  Issue:    ${bold}#${issue}${reset}\n`)
    out(`  PR:       ${bold}${prUrl}${reset}\n`)
    out(`  Duracion: ${bold}${duration}s${reset}\n`)
    out(`  Log:      ${logFile}\n\n`)
    out(`${yellow}Proximos pasos:${reset}\n`)
    out(`  1. Configura los secrets OIDC de Azure en GitHub con ${bold}setup-github-ci.sh${reset} si no existen\n`)
    out(
      `     (${bold}AZURE_CLIENT_ID${reset}, ${bold}AZURE_TENANT_ID${reset}, ${bold}AZURE_SUBSCRIPTION_ID${reset}; sin AZURE_CREDENTIALS, ver MEF-ADR-0022):\n`,
    )
    out('     CI los necesita para aplicar la infraestructura al mergear.\n')
    out(`  2. Revisar y mergear el PR: al mergear a ${bold}main${reset}, CI aplica la infraestructura\n`)
    out(`     (${bold}terraform apply${reset}, workflow Infra CD) y despliega el codigo. No ejecutes\n`)
    out(`     ${bold}terraform apply${reset} en local (MEF-ADR-0021, MEF-ADR-0022).\n`)
    out(`  3. Crear issues de implementacion y usar ${bold}/implement${reset}\n\n`)
    return 0
  }

  return runPipeline(main, {
    finalize,
    // Solo se mata el proceso que este pipeline lanzo: el runner corta a su agente y limpia.
    onSignal: () => {
      signaled = true
      runnerChild?.kill('SIGTERM')
    },
    err,
    ...(deps.signals === undefined ? {} : { signals: deps.signals }),
    ...(deps.exit === undefined ? {} : { exit: deps.exit }),
  })
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await scaffoldPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
