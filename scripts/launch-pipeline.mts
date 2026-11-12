// Despachador de los pipelines publicados.
//
// Uso:
//   scripts/launch-pipeline.sh 42                        # issue unico (enruta por label)
//   scripts/launch-pipeline.sh --pipeline tooling 42     # forzar pipeline tooling
//   scripts/launch-pipeline.sh --batch 42 43 44          # secuencial (enruta por label)
//   scripts/launch-pipeline.sh --parallel 42 43 44       # paralelo (enruta por label)
//   scripts/launch-pipeline.sh --parallel 42 43 --max-parallel 2
//   scripts/launch-pipeline.sh 42 --from-stage 3         # retomar issue #42 desde Stage 3
//
// Dos modos de UI (MEFISTO_UI, MEF-ADR-0057 decision 5): 'mod', desacoplado y default (el
// pipeline corre como proceso propio que sobrevive al lanzador), y 'herdr', que delega en
// herdr-pipeline.sh (un pane por corrida).

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRuntime, runtimeLibDir } from '../src/runtime/lib/mefisto-runtime.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint, repoRoot } from './lib/cli.mts'
import {
  detachedEnv,
  hasRetiredFlag,
  insideHerdr,
  isValidUiMode,
  launchDetached,
  launcherStatePath,
  LauncherExit,
  pipelineCommand,
  RETIRED_FLAGS_MESSAGE,
  runDelegate,
  touch,
  uiMode,
  usesDetachedUi,
  VALID_UI_MODES,
} from './lib/launcher.mts'
import type { LaunchDetached, RunDelegate } from './lib/launcher.mts'
import { clockTime } from './lib/pipeline/agent-log.mts'
import { caffeinatePrefix } from './lib/pipeline/caffeinate.mts'
import { resolvePipeline } from './lib/pipeline/pipeline-resolution.mts'
import { runStamp } from './lib/pipeline/pipeline-status.mts'

export interface LaunchPipelineContext {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  out: (text: string) => void
  err: (text: string) => void
  now: () => Date
  hasCommand: (command: string) => boolean
  /** `gh` del enrutamiento por label. */
  run: Run
  /** Carpeta `scripts/` del paquete: pipelines, herdr y visor. */
  scriptsDir: string
  launch: LaunchDetached
  delegate: RunDelegate
  platform?: NodeJS.Platform
}

const { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, bold: BOLD, reset: NC } = COLOR

// La ayuda del bash salia por un heredoc, que no interpreta los escapes: el texto lleva los
// codigos de color como literales `\033[...`.
const H = { cyan: '\\033[0;36m', bold: '\\033[1m', nc: '\\033[0m' }

const HELP = `
${H.cyan}${H.bold}launch-pipeline.sh${H.nc} --- Despachador de los pipelines publicados

${H.bold}Uso:${H.nc}
  ./scripts/launch-pipeline.sh 42                                   Issue unico (enruta por label)
  ./scripts/launch-pipeline.sh 42 --from-stage 3                    Retomar issue #42 desde Stage 3
  ./scripts/launch-pipeline.sh --pipeline tooling 42                Forzar pipeline tooling
  ./scripts/launch-pipeline.sh --tooling 42                         Issue de tooling (override explicito)
  ./scripts/launch-pipeline.sh --tooling 42 --models 'reviewer=opus,writer=sonnet'  Modelo por stage (experimentos)
  ./scripts/launch-pipeline.sh 42 --models 'reviewer=opus,test-writer=sonnet'      Idem, enrutando por label a tdd-pipeline.sh
  ./scripts/launch-pipeline.sh --tooling 42 --variant experimento-a                Corrida paralela del mismo issue (sin PR, rama local)
  ./scripts/launch-pipeline.sh 42 --variant a --models 'test-writer=sonnet'       Idem, enrutando por label a tdd-pipeline.sh
  ./scripts/launch-pipeline.sh 42 --variant a                                     Dos variantes del mismo issue
  ./scripts/launch-pipeline.sh 42 --variant b                                     (lanzar ambos comandos, cada uno arranca en background)
  ./scripts/launch-pipeline.sh --infra 42                           Issue de infraestructura (IaC)
  ./scripts/launch-pipeline.sh --scaffold 42 --domain nombre        Scaffold de dominio
  ./scripts/launch-pipeline.sh --scaffold --domain nombre           Scaffold sin issue
  ./scripts/launch-pipeline.sh --batch 42 43 44                     Secuencial (enruta por label)
  ./scripts/launch-pipeline.sh --batch --pipeline tooling 42 43     Secuencial forzando tooling
  ./scripts/launch-pipeline.sh --parallel 42 43 44                  Paralelo (enruta por label)
  ./scripts/launch-pipeline.sh --parallel --pipeline tdd 42 43      Paralelo forzando tdd

${H.bold}Modos de UI (MEFISTO_UI):${H.nc}
  mod    Desacoplado, el default: el sub-pipeline corre en background con
         nohup, sin pane. Con el runtime claude lo sigue la consola
         fausto-blood-pact de la sesion; en cualquier caso se imprime la ruta
         del report log y la linea de stream-watch.sh para abrir el visor en
         otra terminal.
  herdr  Panes: delega en herdr-pipeline.sh. Solo dentro de un pane herdr
         (HERDR_ENV=1, HERDR_PANE_ID y herdr en PATH); fuera de herdr aborta.
  Sin MEFISTO_UI: desacoplado con el runtime claude; con otro runtime, herdr
  si la invocacion corre dentro de un pane herdr y desacoplado si no.
  Cualquier otro valor de MEFISTO_UI aborta.

${H.bold}Retomar una corrida caida (--from-stage):${H.nc}
  Valido en los modos de un unico issue: <issue> suelto, --tooling y --infra.
  Se rechaza (mensaje explicito, nunca silencio) en --batch, --parallel, varios
  issues sueltos --- un unico --from-stage sobre un lote seria ambiguo --- y en
  --scaffold, que no tiene stages retomables. El despachador NO valida el
  rango: lo valida el sub-script destino (tdd-pipeline.sh acepta 1-4;
  tooling-pipeline.sh e iac-pipeline.sh, 1-2), para no desincronizarse con el
  la primera vez que un pipeline sume una fase.

${H.bold}Modelo por stage (--models, experimentos A/B de desempeno):${H.nc}
  Valido con --tooling y con el enrutamiento automatico de un unico issue
  (sea por label o por '--pipeline tdd|tooling <issue>' -- ambos overrides de
  resolve_pipeline() resuelven siempre a tdd-pipeline.sh o tooling-pipeline.sh):
  --models 'agente=modelo[,agente=modelo...]' sobreescribe el modelo de un
  stage puntual. La clave es el nombre de agente que recibe run_agent() en el
  sub-script destino:
    tooling-pipeline.sh: 'writer' (cubre Stage 1 y la etapa de merge, ambos
      invocados con ese mismo nombre) y 'reviewer' (Stage 2).
    tdd-pipeline.sh: 'test-writer'/'projection-test-writer' (Stage 1),
      'implementer'/'projection-implementer' (Stage 2, y la etapa de merge que
      SIEMPRE usa la clave 'implementer'), 'smoke-test-writer' (Stage 2b) y
      'reviewer' (Stage 3). Los dos sub-stages de remediacion del coverage gate
      (Stage 4) no pasan por run_agent, pero honran el mismo mapa con una clave
      fina propia -- 'patch-test-writer'/'patch-implementer' -- que, si no esta
      en el mapa, cae a la del agente que realmente relanzan (el del Stage 1 y
      el del Stage 2): asi '--models test-writer=X' cubre tambien su
      remediacion, y la clave fina existe solo para diferenciarla a proposito.
      El scaffold de dominio (Stage 0, domain-scaffolder) queda fuera del mapa
      -- no es un stage TDD.
  Sin entrada en el mapa, el stage usa su default de siempre (el frontmatter
  'model:' del agente en tdd-pipeline.sh; sonnet/opus hardcodeado en
  tooling-pipeline.sh). Se rechaza (mensaje explicito, nunca silencio) en
  --infra, --scaffold, --batch y --parallel, porque sus sub-scripts no
  implementan el flag o serian ambiguos sobre varios issues. Un --models
  malformado aborta ANTES de crear el worktree. En modo herdr, esta
  invocacion delega en herdr-pipeline.sh, que reenvia --models con la misma
  superficie.

${H.bold}Corridas paralelas del mismo issue (--variant <label>):${H.nc}
  Valido con --tooling y con el enrutamiento automatico de un unico issue (sea
  por label o por '--pipeline tdd|tooling <issue>' -- issue #713: tdd-pipeline.sh
  y tooling-pipeline.sh ya implementan el flag). Se rechaza (mensaje explicito,
  nunca silencio) en --infra, --scaffold, --batch, --parallel y varios issues
  sueltos -- serian ambiguos sobre un lote, o el sub-script destino
  (iac-pipeline.sh/scaffold-pipeline.sh) no implementa el flag. Corre el MISMO
  issue N veces en paralelo, cada corrida en su propio worktree y rama con el
  sufijo -<label> (slug [a-z0-9-], hasta 40 caracteres): dos corridas
  simultaneas del mismo issue sin --variant colisionarian worktree y rama.
  En modo variante el pipeline NO hace push, NO abre PR y NO comenta el issue
  -- la rama queda LOCAL. Se combina con --models para comparar modelo por
  variante (una variante sin --models es la corrida de control):
    launch-pipeline.sh --tooling 42 --variant a --models 'writer=sonnet'
    launch-pipeline.sh --tooling 42 --variant b --models 'writer=opus'
    launch-pipeline.sh 42 --variant a --models 'test-writer=sonnet'    (issue TDD)
    launch-pipeline.sh 42 --variant b --models 'test-writer=opus'
  Si una variante gana la comparacion, se promueve a mano (push + gh pr create
  sobre esa rama) o relanzando el pipeline sin --variant.

${H.bold}Runtime (MEF-ADR-0049/0050):${H.nc}
  Los modos que lanzan un sub-pipeline (issue suelto, --tooling, --infra,
  --scaffold, --batch y --parallel) resuelven el runtime activo una sola
  vez y lo propagan al sub-pipeline como MEFISTO_RUNTIME=<resuelto>. Sin
  runtime resoluble abortan con 'No se pudo resolver el runtime activo:
  <motivo>' sin lanzar nada. Queda exento --help.

${H.bold}Enrutamiento automatico:${H.nc}
  Sin --pipeline ni --tooling/--infra, el pipeline se determina por el label tipo:* del issue:
    tipo:feature|refactor|projection -> tdd-pipeline.sh
    tipo:tooling                     -> tooling-pipeline.sh
    tipo:infra                       -> SKIP (usar --infra explicitamente)

  Con --parallel, el modo desacoplado delega en parallel-pipeline.sh, cuyo
  scheduler serializa los issues tipo:projection del lote (comparten los
  archivos del worker de proyecciones del BC, MEF-ADR-0034) y respeta
  --max-parallel. En modo herdr no hay scheduler entre panes: un lote con dos
  o mas tipo:projection se rechaza con mensaje explicito; para correrlos
  igual, usa /sequential o parallel-pipeline.sh directo.

`

const DIGITS = /^[0-9]+$/
const PIPELINE_OVERRIDE = /^[a-z-]+$/

/** Nombre de dominio en kebab-case (acepta PascalCase, camelCase y snake_case). */
export function kebabDomain(domain: string): string {
  return domain
    .replaceAll('_', '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function launchPipeline(ctx: LaunchPipelineContext): Promise<number> {
  const { env } = ctx
  const out = (line: string): void => ctx.out(`${line}\n`)
  const log = (msg: string): void => out(`${BLUE}[${clockTime(ctx.now())}]${NC} ${msg}`)
  const success = (msg: string): void => out(`${GREEN}${BOLD}✓${NC} ${msg}`)
  const warn = (msg: string): void => out(`${YELLOW}⚠${NC} ${msg}`)
  const abort = (msg: string): never => {
    ctx.err(`\n${RED}${BOLD}✗ ${msg}${NC}\n`)
    throw new LauncherExit(1)
  }
  const shPath = join(ctx.scriptsDir, 'launch-pipeline.sh')
  // Lo que el bash dejaba caer en `set -u` al leer un valor ausente.
  const unbound = (): never => {
    ctx.err(`${shPath}: $2: unbound variable\n`)
    throw new LauncherExit(1)
  }

  try {
    const libDir = runtimeLibDir(env)
    if (!isDirectory(libDir)) {
      ctx.err('ERROR: no se encontro src/runtime/lib junto al paquete publicado\n')
      return 1
    }
    const gitRoot = repoRoot(ctx.cwd)
    if (gitRoot === null) {
      ctx.err('ERROR: no estas en un repositorio git\n')
      return 1
    }
    const projectRoot = resolve(gitRoot)
    if (existsSync(join(projectRoot, '.claude-plugin', 'plugin.json'))) {
      ctx.err(
        'ERROR: scripts/launch-pipeline.sh es del plugin publicado y solo aplica al consumidor.\n' +
          'Estas en el repo de Mefisto. Para trabajar issues del plugin usa los skills internos /mefisto-tooling o /mefisto-sequential.\n',
      )
      return 1
    }
    const caffeinate = caffeinatePrefix(env, ctx.platform)
    let resolvedRuntime = ''

    const launchDetachedRun = (name: string, issuesCsv: string, pipeline: string, args: string[]): void => {
      // El visor y la consola leen events.log: debe existir antes de la primera linea.
      touch(launcherStatePath('events.log', projectRoot, env), ctx.now())
      const logsDir = launcherStatePath('logs', projectRoot, env)
      mkdirSync(logsDir, { recursive: true })
      const reportLog = join(logsDir, `${name}-run-${runStamp(ctx.now())}.report.log`)
      const command = pipelineCommand(ctx.scriptsDir, pipeline, args, caffeinate)
      ctx.launch({
        command: command.command,
        args: command.args,
        cwd: projectRoot,
        env: detachedEnv(env, { MEFISTO_RUNTIME: resolvedRuntime }),
        reportLog,
      })
      if (resolvedRuntime === 'claude') {
        success(`Pipeline ${name} iniciado (sin pane: lo sigue la consola de Fausto, fausto-blood-pact)`)
      } else {
        success(`Pipeline ${name} iniciado (sin pane)`)
      }
      log(`Log: ${reportLog}`)
      let watch = `'${join(ctx.scriptsDir, 'stream-watch.sh')}'`
      if (issuesCsv !== '') watch = `${watch} --issues ${issuesCsv}`
      log(`Visor en otra terminal: ${watch}`)
    }

    const cmdSingle = (issue: string, extra: string[], override: string): void => {
      const resolution = resolvePipeline(issue, override, { run: ctx.run, scriptsDir: ctx.scriptsDir })
      if (resolution.kind === 'skip') abort(`Issue #${issue} no se puede enrutar a un pipeline (${resolution.reason}).`)
      const pipeline = resolution.kind === 'pipeline' ? basename(resolution.script, '.sh') : ''
      launchDetachedRun(`${pipeline}-issue-${issue}`, issue, pipeline, [issue, ...extra])
    }

    const cmdBatch = (args: string[]): void => {
      let override = ''
      const issues: string[] = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string
        if (arg === '--pipeline') {
          override = args[i + 1] ?? unbound()
          i++
        } else {
          issues.push(arg)
        }
      }
      if (issues.length === 0) abort('Debes especificar al menos un issue. Uso: --batch 42 43 44')
      for (const issue of issues) {
        if (!DIGITS.test(issue)) abort(`Issue invalido para --batch: '${issue}' (solo numeros).`)
      }
      if (override !== '' && !PIPELINE_OVERRIDE.test(override)) abort(`Valor invalido para --pipeline: '${override}'.`)
      const flags = override !== '' ? ['--pipeline', override] : []
      launchDetachedRun('batch', issues.join(','), 'batch-pipeline', [...flags, ...issues])
    }

    // Sin panes, parallel-pipeline es el scheduler: serializa tipo:projection, respeta
    // --max-parallel y escalona los arranques.
    const cmdParallel = (args: string[]): void => {
      let maxParallel = ''
      let override = ''
      const issues: string[] = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string
        if (arg === '--max-parallel') {
          maxParallel = args[i + 1] ?? unbound()
          i++
        } else if (arg.startsWith('--max-parallel=')) {
          maxParallel = arg.slice('--max-parallel='.length)
        } else if (arg === '--pipeline') {
          override = args[i + 1] ?? unbound()
          i++
        } else {
          issues.push(arg)
        }
      }
      if (issues.length === 0) abort('Debes especificar al menos un issue. Uso: --parallel 42 43 44')
      for (const issue of issues) {
        if (!DIGITS.test(issue)) abort(`Issue invalido para --parallel: '${issue}' (solo numeros).`)
      }
      if (override !== '' && !PIPELINE_OVERRIDE.test(override)) abort(`Valor invalido para --pipeline: '${override}'.`)
      if (maxParallel !== '' && !DIGITS.test(maxParallel)) abort(`Valor invalido para --max-parallel: '${maxParallel}'.`)
      const flags = [
        ...(override !== '' ? ['--pipeline', override] : []),
        ...(maxParallel !== '' ? ['--max-parallel', maxParallel] : []),
      ]
      launchDetachedRun('parallel', issues.join(','), 'parallel-pipeline', [...flags, ...issues])
    }

    const cmdScaffold = (args: string[]): void => {
      let issue = ''
      let domain = ''
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string
        if (arg === '--domain') {
          domain = args[i + 1] ?? unbound()
          i++
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
      const args2 = [...(issue !== '' ? [issue] : []), '--domain', domain]
      launchDetachedRun(`scaffold-${domain}`, issue, 'scaffold-pipeline', args2)
    }

    const argv = ctx.argv
    if (argv.length === 0 || argv.some((arg) => arg === '--help' || arg === '-h')) {
      ctx.out(HELP)
      return 0
    }
    if (hasRetiredFlag(argv)) abort(RETIRED_FLAGS_MESSAGE)

    if (!isValidUiMode(env)) abort(`MEFISTO_UI='${uiMode(env)}' no es un modo valido. ${VALID_UI_MODES}`)
    if (!usesDetachedUi(env)) {
      if (insideHerdr(env, ctx.hasCommand)) {
        return ctx.delegate(join(ctx.scriptsDir, 'herdr-pipeline.sh'), argv, { cwd: ctx.cwd, env })
      }
      if (uiMode(env) === 'herdr') {
        abort(
          'MEFISTO_UI=herdr requiere correr dentro de un pane de herdr (HERDR_ENV=1, HERDR_PANE_ID y herdr en PATH). Fuera de herdr usa MEFISTO_UI=mod (desacoplado, el default).',
        )
      }
    }

    // --scaffold-domain, --pipeline, --from-stage, --models y --variant se sacan antes del
    // dispatch: si quedaran, "253 --from-stage 4" se veria como varios issues y desviaria a
    // --parallel.
    let scaffoldExtra: string[] = []
    let override = ''
    let fromStageExtra: string[] = []
    let modelsExtra: string[] = []
    let variantExtra: string[] = []
    const filtered: string[] = []
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string
      const value = argv[i + 1]
      switch (arg) {
        case '--scaffold-domain':
          if (value === undefined) abort('Falta el nombre del dominio para --scaffold-domain')
          scaffoldExtra = ['--scaffold-domain', value as string]
          i++
          break
        case '--pipeline':
          if (value === undefined) abort('Falta el valor de --pipeline')
          override = value as string
          i++
          break
        case '--from-stage':
          if (value === undefined) abort('Falta el valor de --from-stage')
          if (!DIGITS.test(value as string)) abort(`--from-stage debe ser un numero entero (recibido: '${value}')`)
          fromStageExtra = ['--from-stage', value as string]
          i++
          break
        case '--models':
          if (value === undefined) abort('Falta el valor de --models')
          modelsExtra = ['--models', value as string]
          i++
          break
        case '--variant':
          if (value === undefined) abort('Falta el valor de --variant')
          variantExtra = ['--variant', value as string]
          i++
          break
        default:
          filtered.push(arg)
      }
    }
    if (filtered.length === 0) {
      abort(`Faltan argumentos posicionales (numero de issue o modo). Corre '${shPath} --help' para ver el uso.`)
    }

    // Una sola resolucion propagada al sub-pipeline, para que no autodetecte otro runtime.
    const runtime = await resolveRuntime('', env, ctx.hasCommand, libDir)
    if ('error' in runtime) abort(`No se pudo resolver el runtime activo: ${runtime.error}`)
    resolvedRuntime = 'runtime' in runtime ? runtime.runtime : ''

    const [mode = '', ...rest] = filtered
    const hasFromStage = fromStageExtra.length > 0
    const hasModels = modelsExtra.length > 0
    const hasVariant = variantExtra.length > 0
    const withOverride = (args: string[]): string[] => (override !== '' ? ['--pipeline', override, ...args] : args)

    if (mode === '--tooling') {
      if (rest.length === 0) abort('Debes especificar un issue. Uso: --tooling 42')
      const issue = rest[0] as string
      launchDetachedRun(`tooling-issue-${issue}`, issue, 'tooling-pipeline', [
        issue,
        ...fromStageExtra,
        ...modelsExtra,
        ...variantExtra,
      ])
    } else if (mode === '--infra') {
      if (rest.length === 0) abort('Debes especificar un issue. Uso: --infra 42')
      if (hasModels) {
        abort(
          "--models todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling o un issue TDD: launch-pipeline.sh --tooling <issue> --models 'agente=modelo'",
        )
      }
      if (hasVariant) {
        abort(
          '--variant todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling: launch-pipeline.sh --tooling <issue> --variant <label>',
        )
      }
      const issue = rest[0] as string
      launchDetachedRun(`infra-issue-${issue}`, issue, 'iac-pipeline', [issue, ...fromStageExtra])
    } else if (mode === '--scaffold') {
      if (hasFromStage) abort('--from-stage no es valido con --scaffold (scaffold-pipeline.sh no tiene stages retomables).')
      if (hasModels) abort('--models no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag).')
      if (hasVariant) abort('--variant no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag).')
      cmdScaffold(rest)
    } else if (mode === '--batch' || mode === '--parallel') {
      if (rest.length === 0) abort(`Debes especificar al menos un issue. Uso: ${mode} 42 43 44`)
      if (hasFromStage) {
        abort(
          `--from-stage no es valido con ${mode} (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh <issue> --from-stage N`,
        )
      }
      if (hasModels) {
        abort(
          `--models no es valido con ${mode} (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh --tooling <issue> --models 'agente=modelo'`,
        )
      }
      if (hasVariant) {
        abort(
          `--variant no es valido con ${mode} (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh --tooling <issue> --variant <label>`,
        )
      }
      if (mode === '--batch') cmdBatch(withOverride(rest))
      else cmdParallel(withOverride(rest))
    } else if (/^[0-9]/.test(mode)) {
      if (filtered.length > 1) {
        if (hasFromStage) {
          abort(
            '--from-stage no es valido con multiples issues (se interpretaria como --parallel). Especifica un unico issue: launch-pipeline.sh <issue> --from-stage N',
          )
        }
        if (hasModels) {
          abort(
            "--models no es valido con multiples issues (se interpretaria como --parallel). Usa: launch-pipeline.sh --tooling <issue> --models 'agente=modelo'",
          )
        }
        if (hasVariant) {
          abort(
            '--variant no es valido con multiples issues (se interpretaria como --parallel). Usa: launch-pipeline.sh --tooling <issue> --variant <label>',
          )
        }
        warn('Multiples issues sin modo especificado. Usando --parallel.')
        cmdParallel(withOverride(filtered))
      } else {
        // El enrutamiento automatico resuelve a tdd o tooling, y ambos implementan --models y
        // --variant.
        cmdSingle(mode, [...scaffoldExtra, ...fromStageExtra, ...modelsExtra, ...variantExtra], override)
      }
    } else {
      out(`${RED}Argumento desconocido: ${mode}${NC}`)
      ctx.out(HELP)
      return 1
    }
    return 0
  } catch (error) {
    if (error instanceof LauncherExit) return error.code
    if (error instanceof CliError) {
      if (error.message.length > 0) ctx.err(`${error.message}\n`)
      return error.exitCode
    }
    throw error
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await launchPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    now: () => new Date(),
    hasCommand: (command) => commandExists(command),
    run: capture,
    scriptsDir: dirname(fileURLToPath(import.meta.url)),
    launch: launchDetached,
    delegate: runDelegate,
  })
}
