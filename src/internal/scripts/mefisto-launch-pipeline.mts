// Lanzador de los pipelines INTERNOS de Mefisto. Solo corre dentro del repo de Mefisto.
//
// Uso:
//   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42
//   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42 --from-stage 2   # retomar
//   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42 --models 'writer=<modelo>'
//   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42 --variant experimento-a
//   src/internal/scripts/mefisto-launch-pipeline.sh --batch 42 43 44   # secuencial
//
// Dos modos de UI (MEF-ADR-0057 decision 5), elegidos en este orden:
//   1. Desacoplado: MEFISTO_UI=mod, o MEFISTO_UI sin definir con MEFISTO_RUNTIME=claude. Lo
//      sigue la cinta de la sesion que lo lanzo (mod mefisto-divine-wager, MEF-ADR-0055).
//   2. Herdr: MEFISTO_UI=herdr, o la sesion corre dentro de un pane herdr. Delega en
//      mefisto-herdr-pipeline.sh, que aborta si no hay contexto herdr.
//   3. En cualquier otro caso, desacoplado sin cinta: el report log y el visor en otra terminal.
//
// --from-stage, --models y --variant (en cualquier posicion) solo valen con --tooling y se
// propagan al pipeline, que valida rango y formato antes de crear el worktree.

import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, COLOR, commandExists, isEntryPoint } from '../../../scripts/lib/cli.mts'
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
} from '../../../scripts/lib/launcher.mts'
import type { LaunchDetached, RunDelegate } from '../../../scripts/lib/launcher.mts'
import { clockTime } from '../../../scripts/lib/pipeline/agent-log.mts'
import { caffeinatePrefix } from '../../../scripts/lib/pipeline/caffeinate.mts'
import { runStamp } from '../../../scripts/lib/pipeline/pipeline-status.mts'
import { ensureRepoOnBaseBranch } from './lib/mefisto-base-branch.mts'
import type { BaseBranchOptions, BaseBranchCheck } from './lib/mefisto-base-branch.mts'
import { assertInMefisto } from './lib/mefisto-repo.mts'
import type { MefistoRepo } from './lib/mefisto-repo.mts'

export interface MefistoLaunchContext {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  out: (text: string) => void
  err: (text: string) => void
  now: () => Date
  hasCommand: (command: string) => boolean
  /** Carpeta de los pipelines internos y del script de herdr. */
  scriptsDir: string
  launch: LaunchDetached
  delegate: RunDelegate
  assertRepo?: (cwd: string) => MefistoRepo
  baseBranch?: (options: BaseBranchOptions) => BaseBranchCheck
  platform?: NodeJS.Platform
}

const { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, bold: BOLD, reset: NC } = COLOR

export function usage(self: string): string {
  return [
    `Uso: ${self} --tooling <issue> [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>]`,
    `     ${self} --batch <issue1> <issue2> ...`,
    '',
    `  Modo de UI (MEFISTO_UI). ${VALID_UI_MODES}`,
    '              Sin MEFISTO_UI: desacoplado con MEFISTO_RUNTIME=claude; si no,',
    '              herdr dentro de un pane herdr; si no, desacoplado.',
    '              En modo desacoplado el script imprime la ruta del report log',
    '              y la linea que abre el visor en vivo en otra terminal:',
    '                ./.claude/scripts/mefisto-stream-watch.sh --issues <issue>',
    '',
    '  --from-stage N  (issue #449) Retoma una corrida caida desde el Stage N.',
    '                  Solo valido con --tooling (un unico issue); --batch lo',
    '                  rechaza porque seria ambiguo sobre varios issues. El',
    '                  rango (1-2) lo valida mefisto-tooling-pipeline.sh, no',
    '                  este wrapper.',
    '',
    "  --models 'agente=modelo[,...]'  (issue #709, experimentos A/B de",
    '                  desempeno del harness) Sobreescribe el modelo de un',
    '                  stage puntual de mefisto-tooling-pipeline.sh. La clave',
    "                  es el nombre de agente que recibe run_agent(): hoy",
    "                  'reviewer' (Stage 2) y 'writer' -- que cubre DOS stages,",
    '                  el Stage 1 y la etapa de merge, ambos invocados con ese',
    '                  mismo nombre. Solo valido con --tooling; --batch lo',
    '                  rechaza por la misma ambiguedad que --from-stage. Un',
    '                  --models malformado aborta ANTES de crear el worktree.',
    '                  Ejemplo: --models writer=<modelo>,reviewer=<modelo> -- ver',
    '                  src/runtime/contract/models.example.json (issue #1072) para la',
    '                  forma de los ids por runtime.',
    '',
    '  --variant <label>  (issue #711, corridas paralelas del mismo issue)',
    '                  Corre el MISMO issue en un worktree/rama propios',
    '                  (sufijo -<label>), sin push, sin PR y sin mutar el',
    '                  issue -- la rama queda local, para comparar contra otra',
    '                  variante. Se combina con --models para comparar modelo',
    '                  por variante (una variante sin --models es la corrida',
    '                  de control). Solo valido con --tooling; --batch lo',
    '                  rechaza (seria ambiguo sobre varios issues). Un label',
    '                  invalido aborta ANTES de crear el worktree.',
  ].join('\n')
}

export interface WrapperFlags {
  fromStage: string[]
  models: string[]
  variant: string[]
  remaining: string[]
}

/** Saca --from-stage, --models y --variant de cualquier posicion; el resto queda en orden. */
export function extractWrapperFlags(args: readonly string[], abort: (msg: string) => never): WrapperFlags {
  const flags: WrapperFlags = { fromStage: [], models: [], variant: [], remaining: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--from-stage' || arg === '--models' || arg === '--variant') {
      i++
      const value = args[i] ?? ''
      if (value === '') abort(`Falta el valor de ${arg}`)
      if (arg === '--from-stage') {
        if (!/^[0-9]+$/.test(value)) abort(`--from-stage debe ser un numero entero (recibido: '${value}')`)
        flags.fromStage = [arg, value]
      } else if (arg === '--models') {
        flags.models = [arg, value]
      } else {
        flags.variant = [arg, value]
      }
    } else {
      flags.remaining.push(arg)
    }
  }
  return flags
}

export async function mefistoLaunchPipeline(ctx: MefistoLaunchContext): Promise<number> {
  const { env } = ctx
  const self = join(ctx.scriptsDir, 'mefisto-launch-pipeline.sh')
  const out = (line: string): void => ctx.out(`${line}\n`)
  const log = (msg: string): void => out(`${BLUE}[${clockTime(ctx.now())}]${NC} ${msg}`)
  const success = (msg: string): void => out(`${GREEN}${BOLD}v${NC} ${msg}`)
  const warn = (msg: string): void => out(`${YELLOW}!${NC} ${msg}`)
  const abort = (msg: string): never => {
    ctx.err(`\n${RED}${BOLD}x ${msg}${NC}\n`)
    throw new LauncherExit(1)
  }

  try {
    const repo = (ctx.assertRepo ?? assertInMefisto)(ctx.cwd)
    const projectRoot = resolve(repo.root)
    const eventsLog = launcherStatePath('events.log', projectRoot, env)
    const caffeinate = caffeinatePrefix(env, ctx.platform)
    const argv = ctx.argv

    if (argv.length === 0) {
      out(usage(self))
      return 1
    }
    if (argv[0] === '--help' || argv[0] === '-h') {
      out(usage(self))
      return 0
    }
    if (hasRetiredFlag(argv)) abort(RETIRED_FLAGS_MESSAGE)
    if (!isValidUiMode(env)) abort(`MEFISTO_UI='${uiMode(env)}' no es un modo valido. ${VALID_UI_MODES}`)

    const [mode = '', ...rest] = argv
    if (mode === '--batch') {
      // El gate de rama corre antes de delegar o lanzar nada; el motor lo repite ante una
      // invocacion directa.
      const flags = extractWrapperFlags(rest, abort)
      if (flags.remaining.length === 0) abort('Debes especificar al menos un issue. Uso: --batch 42 43 44')
      if (flags.fromStage.length > 0) {
        abort('--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --from-stage N para un unico issue.')
      }
      if (flags.models.length > 0) {
        abort("--models no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --models 'agente=modelo' para un unico issue.")
      }
      if (flags.variant.length > 0) {
        abort('--variant no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --variant <label> para un unico issue.')
      }
      const check = (ctx.baseBranch ?? ensureRepoOnBaseBranch)({ repoRoot: projectRoot })
      if (check.gitStderr !== '') ctx.err(check.gitStderr)
      if (!check.ok) abort(check.abort)
      if (check.ok) for (const warning of check.warnings) warn(warning)
    } else if (mode !== '--tooling') {
      abort(`Argumento no reconocido: ${mode}`)
    }

    const followedByMod = usesDetachedUi(env)
    if (!followedByMod && (uiMode(env) === 'herdr' || insideHerdr(env, ctx.hasCommand))) {
      return ctx.delegate(join(ctx.scriptsDir, 'mefisto-herdr-pipeline.sh'), argv, { cwd: ctx.cwd, env })
    }

    const logsDir = launcherStatePath('logs', projectRoot, env)

    const launchRun = (reportLog: string, pipeline: string, args: string[]): void => {
      const command = pipelineCommand(ctx.scriptsDir, pipeline, args, caffeinate)
      ctx.launch({ command: command.command, args: command.args, cwd: projectRoot, env: detachedEnv(env), reportLog })
    }
    const report = (title: string, reportLog: string, issuesCsv: string): void => {
      success(followedByMod ? `${title} (sin pane: lo sigue el mod mefisto-divine-wager)` : `${title} (sin pane)`)
      log(`Reporte: ${reportLog}`)
      log(`Visor en otra terminal: ./.claude/scripts/mefisto-stream-watch.sh --issues ${issuesCsv}`)
    }

    const flags = extractWrapperFlags(rest, abort)
    if (mode === '--tooling') {
      const issue = flags.remaining[0]
      if (issue === undefined) abort('Falta el numero de issue. Uso: --tooling <issue> [--from-stage N]')
      touch(eventsLog, ctx.now())
      mkdirSync(logsDir, { recursive: true })
      const reportLog = join(logsDir, `mefisto-tooling-run-${runStamp(ctx.now())}-issue-${issue}.report.log`)
      launchRun(reportLog, 'mefisto-tooling-pipeline', [
        issue as string,
        ...flags.fromStage,
        ...flags.models,
        ...flags.variant,
      ])
      report(`Pipeline mefisto-tooling iniciado para issue #${issue}`, reportLog, issue as string)
    } else {
      const issues = flags.remaining
      if (issues.length === 0) abort('Debes especificar al menos un issue. Uso: --batch 42 43 44')
      for (const issue of issues) {
        if (!/^[0-9]+$/.test(issue)) abort(`Issue invalido para --batch: '${issue}' (solo numeros).`)
      }
      touch(eventsLog, ctx.now())
      mkdirSync(logsDir, { recursive: true })
      const reportLog = join(logsDir, `mefisto-batch-run-${runStamp(ctx.now())}.report.log`)
      launchRun(reportLog, 'mefisto-batch-pipeline', issues)
      report(`Batch pipeline interno iniciado: issues ${issues.join(' ')}`, reportLog, issues.join(','))
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
  process.exitCode = await mefistoLaunchPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    now: () => new Date(),
    hasCommand: (command) => commandExists(command),
    scriptsDir: dirname(fileURLToPath(import.meta.url)),
    launch: launchDetached,
    delegate: runDelegate,
  })
}
