// Interfaz herdr de los pipelines publicados (issue #690).
//
// Uso (misma superficie de modos que launch-pipeline.sh):
//   herdr-pipeline.sh 42                          issue unico (enruta por label)
//   herdr-pipeline.sh 42 --from-stage 3           retomar desde Stage 3
//   herdr-pipeline.sh --pipeline tooling 42       forzar pipeline
//   herdr-pipeline.sh --tooling 42 | --infra 42 | --scaffold 42 --domain x
//   herdr-pipeline.sh --batch 42 43 44            secuencial
//   herdr-pipeline.sh --parallel 42 43            paralelo: un pane apilado por issue
//   herdr-pipeline.sh --collapse-panes            poda paneles libres sobrantes sin despachar
//   herdr-pipeline.sh --refresh-agents            refresca agentes interactivos sin despachar
//
// Trabaja dentro del workspace herdr actual: reutiliza (o crea a la derecha del pane que
// despacha) un pane de ejecucion y le teclea `node "<este script>" --_pane-runner --dispatch
// "<archivo>"`. El runner corre el pipeline en background con su reporte a un log y muestra el
// visor en vivo (stream-watch). Si el pane esta ocupado se abre otro; los libres se reutilizan.
//
// Confirmacion de arranque (issue #1563): quien despacha espera el marcador
// herdr-dispatch-<token>.started hasta HERDR_DISPATCH_CONFIRM_TIMEOUT segundos (15). Sin el,
// reintenta una vez en un pane nuevo; --parallel falla nombrando el issue y su pane. Al agotar el
// plazo el despachador reclama el marcador, y un runner tardio aborta sin lanzar nada
// (MEF-ADR-0017).
//
// Requiere correr dentro de un pane herdr (HERDR_ENV=1): la autodeteccion vive en
// launch-pipeline.sh.

import { appendFileSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { loadAdapter, resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import { chomp, words } from './lib/azure-cli.mts'
import type { Run } from './lib/azure-cli.mts'
import { capture, CliError, COLOR, commandExists, isEntryPoint } from './lib/cli.mts'
import {
  createDispatcher,
  defaultParentOf,
  descendsFromPaneShell,
  isDirectory,
  paneIsFree,
  prunePanes,
  runPaneRunner,
  splitPane,
  stateDirOf,
  confirmTimeout,
} from './lib/herdr.mts'
import type { Dispatcher, LaunchChild, ParentOf, PanePool } from './lib/herdr.mts'
import { launcherStatePath, LauncherExit } from './lib/launcher.mts'
import { clockTime } from './lib/pipeline/agent-log.mts'
import { caffeinatePrefix } from './lib/pipeline/caffeinate.mts'
import type { SignalSource } from './lib/pipeline/pipeline-exit.mts'
import { resolveIssueFacts, resolvePipeline } from './lib/pipeline/pipeline-resolution.mts'
import { kebabDomain } from './launch-pipeline.mts'

const SCRIPT_DIR = import.meta.dirname

const { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, bold: BOLD, reset: NC } = COLOR

/** Segundos entre arranques de un lote --parallel; la espera corre dentro de cada pane. */
export const PARALLEL_STAGGER = 30

export interface HerdrPipelineDeps {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  out: (text: string) => void
  err: (text: string) => void
  /** `herdr`, `git`, `gh` y `ps`. */
  run: Run
  hasCommand: (command: string) => boolean
  now: () => Date
  sleep: (seconds: number) => Promise<void>
  pid: number
  platform: NodeJS.Platform
  execPath: string
  /** Carpeta del paquete `scripts/`; por defecto, la de este modulo. */
  scriptDir?: string
  parentOf?: ParentOf
  isAlive?: (pid: number) => boolean
  launch?: LaunchChild
  signals?: SignalSource
  exit?: (code: number) => void
}

/**
 * Ratio del k-esimo split (1-indexado) al apilar `total` panes de alturas parejas partiendo
 * siempre el inferior. En herdr el ratio es la fraccion que conserva el pane original (el de
 * arriba en un split down), y lo acota a [0.1, 0.9].
 */
export function stackSplitRatio(total: number, k: number): string {
  return (1 / (total - k + 1)).toFixed(4)
}

/** Nombre con que se relanza un agente sin nombre: prefijo fijo y slug del pane (max. 32). */
export function refreshAgentName(reportedName: string, paneId: string): string {
  if (reportedName !== '') return reportedName
  const slug =
    paneId
      .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-/, '')
      .replace(/-$/, '')
      .slice(0, 16)
      .replace(/-$/, '') || 'pane'
  return `mefisto-refresh-${slug}`
}

// `cmd_help` imprimia las variables de color con `cat <<EOF`, que no interpreta `\033`: el
// texto lleva la secuencia literal.
const H = { cyan: '\\033[0;36m', bold: '\\033[1m', nc: '\\033[0m' }

export function helpText(): string {
  return `
${H.cyan}${H.bold}herdr-pipeline.sh${H.nc} --- Interfaz herdr de los pipelines publicados

${H.bold}Uso (misma superficie que launch-pipeline.sh):${H.nc}
  herdr-pipeline.sh 42                                   Issue unico (enruta por label)
  herdr-pipeline.sh 42 --from-stage 3                    Retomar issue #42 desde Stage 3
  herdr-pipeline.sh --pipeline tooling 42                Forzar pipeline tooling
  herdr-pipeline.sh --tooling 42                         Issue de tooling
  herdr-pipeline.sh --tooling 42 --models 'reviewer=opus'  Modelo por stage (experimentos)
  herdr-pipeline.sh 42 --models 'reviewer=opus,test-writer=sonnet'  Idem, enrutando por label a tdd-pipeline.sh
  herdr-pipeline.sh --tooling 42 --variant experimento-a Corrida paralela del mismo issue (sin PR, rama local)
  herdr-pipeline.sh 42 --variant a --models 'test-writer=sonnet'  Idem, enrutando por label a tdd-pipeline.sh
  herdr-pipeline.sh --infra 42                           Issue de infraestructura (IaC)
  herdr-pipeline.sh --scaffold 42 --domain nombre        Scaffold de dominio
  herdr-pipeline.sh --batch 42 43 44                     Secuencial
  herdr-pipeline.sh --parallel 42 43                     Paralelo: un pane apilado por issue
  herdr-pipeline.sh --collapse-panes                     Poda paneles libres sobrantes sin despachar (usado por /merge)
  herdr-pipeline.sh --refresh-agents                     Refresca los agentes interactivos del workspace

${H.bold}Que hace:${H.nc}
  Reutiliza (o crea) un pane de ejecucion en el workspace herdr actual: el
  pipeline corre en background con su reporte a un log y el pane muestra el
  visor en vivo (stream-watch.sh) del agente en curso, un solo pane para toda
  la secuencia de agentes del issue. Si el pane sigue ocupado con otra
  corrida, se abre un pane adicional; los libres se reutilizan.

  Con --parallel, cada issue corre en su propio pane apilado bajo el pane de
  ejecucion (alturas parejas, visor por issue, arranques escalonados de 30s
  dentro de cada pane). Un lote con dos o mas issues tipo:projection se
  rechaza: usa /sequential o parallel-pipeline.sh, que si los serializa.

${H.bold}Requisitos:${H.nc} correr dentro de un pane herdr (HERDR_ENV=1) y jq.
  Fuera de herdr usa launch-pipeline.sh, que ademas autodetecta herdr y delega
  aqui solo cuando aplica (para correr sin panes: MEFISTO_UI=mod).

`
}

/** Pipeline a correr: la gemela `.mts` de un `.sh` si existe. */
function runnable(script: string): string {
  if (!script.endsWith('.sh')) return script
  const twin = `${script.slice(0, -3)}.mts`
  return existsSync(twin) ? twin : script
}

// `read -r` con IFS de tabulador: los tabuladores seguidos cuentan como uno y el ultimo campo
// se queda con el resto de la linea.
function readTsvFields(line: string): string[] {
  let rest = line.replace(/^\t+/, '').replace(/\t+$/, '')
  const fields: string[] = []
  for (let i = 0; i < 3; i++) {
    const tab = rest.indexOf('\t')
    if (tab < 0) {
      fields.push(rest)
      rest = ''
    } else {
      fields.push(rest.slice(0, tab))
      rest = rest.slice(tab).replace(/^\t+/, '')
    }
  }
  return [...fields, rest]
}

function tsvValue(value: unknown): string {
  const text = value === null || value === undefined || value === false ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return text.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

export async function herdrPipeline(deps: HerdrPipelineDeps): Promise<number> {
  const { env, run } = deps
  const scriptDir = deps.scriptDir ?? SCRIPT_DIR
  const say = (line: string): void => deps.err(`${line}\n`)
  const log = (msg: string): void => say(`${BLUE}[${clockTime(deps.now())}]${NC} ${msg}`)
  const success = (msg: string): void => say(`${GREEN}${BOLD}v${NC} ${msg}`)
  const warn = (msg: string): void => say(`${YELLOW}!${NC} ${msg}`)
  const abort = (msg: string): never => {
    deps.err(`\n${RED}${BOLD}x ${msg}${NC}\n`)
    throw new LauncherExit(1)
  }

  try {
    const override = env.MEFISTO_RUNTIME_LIB_DIR ?? ''
    const libDir = override !== '' ? override : join(scriptDir, '..', 'src', 'runtime', 'lib')
    if (!isDirectory(libDir)) throw new CliError('ERROR: no se encontro src/runtime/lib junto al paquete publicado')
    if (override === '' && !existsSync(join(libDir, 'mefisto-runtime.mts'))) {
      throw new CliError('ERROR: no se encontro mefisto-runtime.mts en la clausura publicada')
    }
    const toplevel = run('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd })
    if (toplevel.status !== 0) throw new CliError('ERROR: no estas en un repositorio git')
    const projectRoot = resolve(chomp(toplevel.stdout))
    if (existsSync(join(projectRoot, '.claude-plugin', 'plugin.json'))) {
      throw new CliError(
        'ERROR: scripts/herdr-pipeline.sh es del plugin publicado y solo aplica al consumidor.\nEstas en el repo de Mefisto. Para trabajar issues del plugin usa los skills internos /mefisto-tooling o /mefisto-sequential.',
      )
    }
    const logDirAbs = resolve(launcherStatePath(join('logs', '.state'), projectRoot, env), '..')
    const caffeinate = caffeinatePrefix(env, deps.platform)
    const stateDir = stateDirOf(projectRoot, env)
    const paneId = env.HERDR_PANE_ID ?? ''
    const workspaceId = env.HERDR_WORKSPACE_ID ?? ''
    const parentOf = deps.parentOf ?? defaultParentOf(run, deps.platform)
    const freedom = {
      run,
      stateDir,
      platform: deps.platform,
      ...(deps.isAlive === undefined ? {} : { isAlive: deps.isAlive }),
    }

    const argv = deps.argv
    if (argv.length === 0) {
      deps.out(helpText())
      return 0
    }
    const [first = '', ...rest] = argv

    if (first === '--_pane-runner') {
      return await runPaneRunner(
        {
          argv: rest,
          cwd: deps.cwd,
          env,
          out: deps.out,
          err: deps.err,
          run,
          now: deps.now,
          sleep: deps.sleep,
          pid: deps.pid,
          execPath: deps.execPath,
          caffeinate,
          ...(deps.launch === undefined ? {} : { launch: deps.launch }),
          ...(deps.signals === undefined ? {} : { signals: deps.signals }),
          ...(deps.exit === undefined ? {} : { exit: deps.exit }),
        },
        {
          allowDelay: true,
          reportPrefix: 'herdr-run',
          followReport: false,
          viewer: (issues, newerThan) => [
            join(scriptDir, 'stream-watch.mts'),
            ...(issues === '' ? [] : ['--issues', issues]),
            '--newer-than',
            String(newerThan),
          ],
        },
      )
    }

    const insideHerdr = (): boolean =>
      env.HERDR_ENV === '1' && paneId !== '' && workspaceId !== '' && deps.hasCommand('herdr')

    const resolveActiveRuntime = async (): Promise<string | null> => {
      const found = await resolveRuntime('', env, deps.hasCommand, runtimeLibDir(env))
      return 'error' in found ? null : found.runtime
    }

    if (first === '--collapse-panes') {
      if (!insideHerdr() || !existsSync(join(stateDir, 'herdr-report-panes.txt'))) {
        deps.out('0\n')
        return 0
      }
      const runtime = await resolveActiveRuntime()
      if (runtime === null) {
        deps.out('0\n')
        return 0
      }
      const pool: PanePool = {
        file: launcherStatePath('herdr-report-panes.txt', projectRoot, env),
        workspace: workspaceId,
        runtime,
        strictRows: true,
      }
      const outcome = prunePanes(pool, run, (pane) => paneIsFree(pane, freedom), log)
      deps.out(`${outcome.closed}\n`)
      return 0
    }

    if (first === '--refresh-agents') {
      if (!insideHerdr()) return 0
      return await refreshAgents()
    }

    async function refreshAgents(): Promise<number> {
      const rawTimeout = env.MEFISTO_REFRESH_EXIT_TIMEOUT ?? ''
      const exitTimeout = rawTimeout === '' ? 30 : /^[0-9]+$/.test(rawTimeout) ? Number(rawTimeout) : 30
      const listed = run('herdr', ['agent', 'list'])
      if (listed.status !== 0) return 0
      const parsed = (() => {
        try {
          return JSON.parse(listed.stdout) as unknown
        } catch {
          return null
        }
      })()
      const agents = (parsed as { result?: { agents?: unknown } } | null)?.result?.agents
      if (!Array.isArray(agents)) return 0
      const rows: string[] = []
      for (const entry of agents) {
        if (typeof entry !== 'object' || entry === null) continue
        const agent = entry as Record<string, unknown>
        if (agent.workspace_id !== workspaceId) continue
        if (typeof agent.cwd !== 'string' || resolve(agent.cwd) !== projectRoot) continue
        rows.push([agent.pane_id, agent.agent, agent.agent_status, agent.name].map(tsvValue).join('\t'))
      }
      const libDirNow = runtimeLibDir(env)
      const line = (pane: string, kind: string, outcome: string): void => deps.out(`${pane} ${kind} ${outcome}\n`)
      for (const row of rows) {
        const [pane = '', kind = '', status = '', agentName = ''] = readTsvFields(row)
        if (pane === '') continue
        if (pane === paneId) {
          line(pane, kind, 'omitido:pane-propio')
          continue
        }
        if (status === 'working' || status === 'blocked') {
          line(pane, kind, `omitido:${status}`)
          continue
        }
        if (!/^[a-z0-9_]+$/.test(kind)) {
          line(pane, kind, 'omitido:sin-estrategia')
          continue
        }
        let strategy: string | null = null
        const adapter = await loadAdapter(libDirNow, kind)
        if (adapter !== null && typeof adapter.interactiveRefresh === 'function') {
          try {
            strategy = adapter.interactiveRefresh(env)
          } catch {
            strategy = null
          }
        }
        if (typeof strategy !== 'string') {
          line(pane, kind, 'omitido:sin-estrategia')
          continue
        }
        strategy = strategy.replace(/\n+$/, '')
        const space = strategy.indexOf(' ')
        const action = space < 0 ? strategy : strategy.slice(0, space)
        const payload = space < 0 ? strategy : strategy.slice(space + 1)
        if (action === 'prompt') {
          if (payload === strategy || payload === '') line(pane, kind, 'omitido:sin-estrategia')
          else if (run('herdr', ['agent', 'prompt', pane, payload]).status === 0) line(pane, kind, 'reload-enviado')
          else line(pane, kind, 'omitido:prompt-fallo')
        } else if (action === 'restart') {
          if (payload === strategy || payload === '') {
            line(pane, kind, 'omitido:sin-estrategia')
            continue
          }
          if (run('herdr', ['agent', 'prompt', pane, payload]).status !== 0) {
            line(pane, kind, 'omitido:prompt-fallo')
            continue
          }
          const seconds = (): number => Math.floor(deps.now().getTime() / 1000)
          const deadline = seconds() + exitTimeout
          let timedOut = false
          while (!paneIsFree(pane, freedom)) {
            if (seconds() >= deadline) {
              line(pane, kind, 'omitido:no-salio')
              timedOut = true
              break
            }
            await deps.sleep(0.1)
          }
          if (timedOut) continue
          const restartName = refreshAgentName(agentName, pane)
          if (run('herdr', ['agent', 'start', restartName, '--kind', kind, '--pane', pane]).status === 0) {
            line(pane, kind, 'reiniciado')
          } else {
            line(pane, kind, 'omitido:relanzamiento-fallo')
          }
        } else {
          line(pane, kind, 'omitido:sin-estrategia')
        }
      }
      return 0
    }

    // --scaffold-domain, --pipeline, --from-stage, --models y --variant salen de cualquier posicion.
    let scaffoldExtra = ''
    let pipelineOverride = ''
    let fromStageExtra = ''
    let modelsSpec = ''
    let variantSpec = ''
    const filtered: string[] = []
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string
      const value = (): string => {
        if (i + 1 >= argv.length) return ''
        i++
        return argv[i] as string
      }
      if (arg === '--scaffold-domain') {
        if (i + 1 >= argv.length) abort('Falta el nombre del dominio para --scaffold-domain')
        scaffoldExtra = `--scaffold-domain ${value()}`
      } else if (arg === '--pipeline') {
        if (i + 1 >= argv.length) abort('Falta el valor de --pipeline')
        pipelineOverride = value()
      } else if (arg === '--from-stage') {
        if (i + 1 >= argv.length) abort('Falta el valor de --from-stage')
        const stage = value()
        if (!/^[0-9]+$/.test(stage)) abort(`--from-stage debe ser un numero entero (recibido: '${stage}')`)
        fromStageExtra = `--from-stage ${stage}`
      } else if (arg === '--models') {
        if (i + 1 >= argv.length) abort('Falta el valor de --models')
        modelsSpec = value()
      } else if (arg === '--variant') {
        if (i + 1 >= argv.length) abort('Falta el valor de --variant')
        variantSpec = value()
      } else if (arg === '--if-exists') {
        abort(
          '--attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5). En herdr una corrida concurrente abre un pane adicional.',
        )
      } else {
        filtered.push(arg)
      }
    }
    if (filtered.length === 0) {
      abort(
        `Faltan argumentos posicionales (numero de issue o modo). Corre '${join(scriptDir, 'herdr-pipeline.sh')} --help' para ver el uso.`,
      )
    }

    let runtime = ''
    let owned = (env.HERDR_PANE_OWNERSHIP_OK ?? '') !== ''
    const assertOwnership = (): void => {
      if (owned) return
      if (descendsFromPaneShell(run, paneId, deps.pid, parentOf)) {
        owned = true
        return
      }
      abort(
        `HERDR_PANE_ID=${paneId} es heredado y no es el pane de esta sesion (este proceso no desciende de su shell): no se abre ningun pane. Usa MEFISTO_UI=mod, o lanza desde el pane herdr propio.`,
      )
    }

    const requireHerdrContext = async (): Promise<Dispatcher> => {
      if (!deps.hasCommand('herdr')) {
        abort('herdr no esta instalado (https://herdr.dev). Fuera de herdr usa: launch-pipeline.sh')
      }
      if (env.HERDR_ENV !== '1') {
        abort('No estas dentro de un pane de herdr (HERDR_ENV != 1). Fuera de herdr usa: launch-pipeline.sh')
      }
      if (paneId === '' || workspaceId === '') {
        abort('Faltan HERDR_PANE_ID/HERDR_WORKSPACE_ID en el entorno (los inyecta herdr en cada pane).')
      }
      const found = await resolveRuntime('', env, deps.hasCommand, runtimeLibDir(env))
      if ('error' in found) abort(`No se pudo resolver el runtime activo: ${found.error}`)
      runtime = (found as { runtime: string }).runtime
      return createDispatcher({
        run,
        projectRoot,
        pane: paneId,
        stateDir,
        pool: {
          file: launcherStatePath('herdr-report-panes.txt', projectRoot, env),
          workspace: workspaceId,
          runtime,
          strictRows: true,
        },
        runnerScript: join(scriptDir, 'herdr-pipeline.mts'),
        dispatchEnv: () => ({ MEFISTO_RUNTIME: runtime }),
        confirmTimeout: confirmTimeout(env),
        pid: deps.pid,
        platform: deps.platform,
        now: deps.now,
        sleep: deps.sleep,
        assertOwnership,
        ...(deps.isAlive === undefined ? {} : { isAlive: deps.isAlive }),
        log,
        success,
        warn,
        abort,
        liveHint: 'El pane muestra el visor en vivo del agente',
        logDir: logDirAbs,
      })
    }

    const pipelineArgs = (extra: string, models: string, variant: string): string[] => [
      ...words(extra),
      ...(models !== '' ? ['--models', models] : []),
      ...(variant !== '' ? ['--variant', variant] : []),
    ]

    const cmdSingle = async (d: Dispatcher, issue: string, extra: string): Promise<void> => {
      const resolution = resolvePipeline(issue, pipelineOverride, { run, scriptsDir: scriptDir })
      if (resolution.kind === 'skip') abort(`Issue #${issue} no se puede enrutar a un pipeline (${resolution.reason}).`)
      const script = (resolution as { script: string }).script
      const name = basename(script, '.sh').replace(/-pipeline$/, '')
      const title = variantSpec !== '' ? `${name} #${issue} (${variantSpec})` : `${name} #${issue}`
      await d.dispatch(title, issue, [runnable(script), issue, ...pipelineArgs(extra, modelsSpec, variantSpec)])
    }

    const cmdScaffold = async (d: Dispatcher, args: string[]): Promise<void> => {
      let issue = ''
      let domain = ''
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string
        if (arg === '--domain') {
          i++
          domain = args[i] ?? ''
        } else if (arg.startsWith('--domain=')) {
          domain = arg.slice('--domain='.length)
        } else if (/^[0-9]/.test(arg)) {
          issue = arg
        } else {
          abort(`Argumento desconocido para --scaffold: ${arg}`)
        }
      }
      if (domain === '') abort('Falta --domain para --scaffold. Uso: --scaffold [issue] --domain nombre')
      domain = kebabDomain(domain)
      const pipelineArgv = [...(issue !== '' ? [issue] : []), '--domain', domain]
      await d.dispatch(`scaffold ${domain}`, issue, [runnable(join(scriptDir, 'scaffold-pipeline.sh')), ...pipelineArgv])
    }

    const cmdBatch = async (d: Dispatcher, args: string[]): Promise<void> => {
      let batchOverride = ''
      const issues: string[] = []
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--pipeline') {
          i++
          batchOverride = args[i] ?? ''
        } else issues.push(args[i] as string)
      }
      if (issues.length === 0) abort('Debes especificar al menos un issue. Uso: --batch 42 43 44')
      const csv = issues.join(',')
      const batchArgs = [...(batchOverride !== '' ? ['--pipeline', batchOverride] : []), ...issues]
      await d.dispatch(`batch ${csv}`, csv, [runnable(join(scriptDir, 'batch-pipeline.sh')), ...batchArgs])
    }

    const cmdParallel = async (d: Dispatcher, args: string[]): Promise<void> => {
      let parallelOverride = ''
      const issues: string[] = []
      const maxParallelWarning =
        '--max-parallel no aplica en modo herdr (cada issue corre en su propio pane). Para limitar concurrencia usa parallel-pipeline.sh directo.'
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string
        if (arg === '--pipeline') {
          i++
          parallelOverride = args[i] ?? ''
        } else if (arg === '--max-parallel') {
          warn(maxParallelWarning)
          i++
        } else if (arg.startsWith('--max-parallel=')) {
          warn(maxParallelWarning)
        } else issues.push(arg)
      }
      if (issues.length === 0) abort('Debes especificar al menos un issue. Uso: --parallel 42 43 44')

      const valid: { issue: string; script: string }[] = []
      let projections = 0
      for (const issue of issues) {
        let facts
        try {
          facts = resolveIssueFacts(issue, parallelOverride, { run, scriptsDir: scriptDir })
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          return abort(`Override de pipeline invalido: '${parallelOverride}' (usa tdd|tooling).`)
        }
        if (facts.state !== 'OPEN') {
          warn(`Issue #${issue} esta ${facts.state} --- saltando.`)
          continue
        }
        if (facts.resolution.kind === 'skip') {
          warn(`Issue #${issue} saltado (${facts.resolution.reason}) --- no se abre pane.`)
          continue
        }
        valid.push({ issue, script: facts.resolution.script })
        if (facts.isProjection) projections++
      }
      if (valid.length === 0) abort('No hay issues validos para procesar en paralelo.')
      if (projections > 1) {
        abort(
          `${projections} issues tipo:projection en el lote: comparten el worker de proyecciones (MEF-ADR-0034) y en modo pane no se serializan entre si. Usa /sequential, o parallel-pipeline.sh directo (su scheduler si los serializa).`,
        )
      }

      const panes = [d.acquire()]
      const total = valid.length
      for (let k = 1; k < total; k++) {
        const split = splitPane(run, {
          from: panes[k - 1] as string,
          direction: 'down',
          ratio: stackSplitRatio(total, k),
          cwd: projectRoot,
        })
        if (!split.ok) abort(`No se pudo crear el pane apilado ${k + 1}/${total} (herdr pane split): ${split.response}`)
        if (split.pane === '') abort(`herdr pane split no devolvio pane_id. Respuesta: ${split.response}`)
        appendFileSync(launcherStatePath('herdr-report-panes.txt', projectRoot, env), `${split.pane} ${runtime}\n`)
        panes.push(split.pane)
      }

      const timeout = confirmTimeout(env)
      const failed: string[] = []
      for (const [i, { issue, script }] of valid.entries()) {
        const pane = panes[i] as string
        const title = `${basename(script, '.sh').replace(/-pipeline$/, '')} #${issue}`
        const delay = i * PARALLEL_STAGGER
        const outcome = await d.startInPane(pane, { title, issues: issue, delay, command: [runnable(script), issue] })
        if (outcome === 'run-failed') abort(`No se pudo lanzar el issue #${issue} en el pane ${pane} (herdr pane run fallo).`)
        if (outcome === 'confirmed') {
          log(delay > 0 ? `Issue #${issue} -> pane ${pane} (${title}, arranca en ${delay}s)` : `Issue #${issue} -> pane ${pane} (${title})`)
        } else {
          warn(
            `Issue #${issue}: el pane ${pane} no confirmo el arranque en ${timeout}s (marcador ausente). Sin reintento (ya es un pane nuevo del lote): revisa/cierra ${pane} y relanza el issue #${issue} a mano.`,
          )
          failed.push(`#${issue} en el pane ${pane}`)
        }
      }
      if (failed.length > 0) {
        abort(`No se confirmo el arranque de ${failed.length} issue(s) del lote: ${failed.join(',')}. Cierra esos paneles y relanzalos a mano.`)
      }
      success(`Pipeline paralelo corriendo: ${total} pane(s) apilados en este workspace, uno por issue.`)
      log(`Cada pane muestra el visor en vivo de su issue; los reportes quedan en ${logDirAbs}/.`)
      log('Los PRs NO se mergean automaticamente: usa /merge <PR_NUM> al terminar.')
    }

    const [mode = '', ...modeArgs] = filtered
    const parallelWith = async (args: string[]): Promise<void> => {
      const d = await requireHerdrContext()
      await cmdParallel(d, pipelineOverride !== '' ? ['--pipeline', pipelineOverride, ...args] : args)
    }
    if (mode === '--help' || mode === '-h') {
      deps.out(helpText())
    } else if (mode === '--attach') {
      abort(
        "En herdr no hay attach: los panes de ejecucion viven en el workspace del proyecto. Abrilo desde la barra lateral de herdr (o corre 'herdr' para adjuntar al servidor).",
      )
    } else if (mode === '--parallel') {
      if (modeArgs.length === 0) abort('Debes especificar al menos un issue. Uso: --parallel 42 43 44')
      if (fromStageExtra !== '') {
        abort('--from-stage no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue.')
      }
      if (modelsSpec !== '') {
        abort("--models no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'")
      }
      if (variantSpec !== '') {
        abort('--variant no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --variant <label>')
      }
      await parallelWith(modeArgs)
    } else if (mode === '--tooling') {
      const d = await requireHerdrContext()
      const issue = modeArgs[0]
      if (issue === undefined) abort('Debes especificar un issue. Uso: --tooling 42')
      const title = variantSpec !== '' ? `tooling #${issue} (${variantSpec})` : `tooling #${issue}`
      await d.dispatch(title, issue as string, [
        runnable(join(scriptDir, 'tooling-pipeline.sh')),
        issue as string,
        ...pipelineArgs(fromStageExtra, modelsSpec, variantSpec),
      ])
    } else if (mode === '--infra') {
      if (modelsSpec !== '') {
        abort("--models todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'")
      }
      if (variantSpec !== '') {
        abort('--variant todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling: herdr-pipeline.sh --tooling <issue> --variant <label>')
      }
      const d = await requireHerdrContext()
      const issue = modeArgs[0]
      if (issue === undefined) abort('Debes especificar un issue. Uso: --infra 42')
      await d.dispatch(`infra #${issue}`, issue as string, [
        runnable(join(scriptDir, 'iac-pipeline.sh')),
        issue as string,
        ...words(fromStageExtra),
      ])
    } else if (mode === '--scaffold') {
      if (fromStageExtra !== '') abort('--from-stage no es valido con --scaffold (scaffold-pipeline.sh no tiene stages retomables).')
      if (modelsSpec !== '') abort('--models no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag).')
      if (variantSpec !== '') abort('--variant no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag).')
      await cmdScaffold(await requireHerdrContext(), modeArgs)
    } else if (mode === '--batch') {
      if (modeArgs.length === 0) abort('Debes especificar al menos un issue. Uso: --batch 42 43 44')
      if (fromStageExtra !== '') {
        abort('--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue.')
      }
      if (modelsSpec !== '') {
        abort("--models no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'")
      }
      if (variantSpec !== '') {
        abort('--variant no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --variant <label>')
      }
      const d = await requireHerdrContext()
      await cmdBatch(d, pipelineOverride !== '' ? ['--pipeline', pipelineOverride, ...modeArgs] : modeArgs)
    } else if (/^[0-9]/.test(mode)) {
      if (filtered.length > 1) {
        if (fromStageExtra !== '') {
          abort('--from-stage no es valido con multiples issues (se interpretaria como --parallel). Especifica un unico issue.')
        }
        if (modelsSpec !== '') {
          abort("--models no es valido con multiples issues (se interpretaria como --parallel). Usa: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'")
        }
        if (variantSpec !== '') {
          abort('--variant no es valido con multiples issues (se interpretaria como --parallel). Usa: herdr-pipeline.sh --tooling <issue> --variant <label>')
        }
        warn('Multiples issues sin modo especificado. Usando --parallel.')
        await parallelWith(filtered)
      } else {
        const d = await requireHerdrContext()
        const extra = [scaffoldExtra, fromStageExtra].filter((part) => part !== '').join(' ')
        await cmdSingle(d, mode, extra)
      }
    } else {
      deps.err(`${RED}Argumento desconocido: ${mode}${NC}\n`)
      deps.out(helpText())
      return 1
    }
    return 0
  } catch (error) {
    if (error instanceof LauncherExit) return error.code
    if (error instanceof CliError) {
      if (error.message.length > 0) deps.err(`${error.message}\n`)
      return error.exitCode
    }
    throw error
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await herdrPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
    sleep: (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)),
    pid: process.pid,
    platform: process.platform,
    execPath: process.execPath,
  })
}
