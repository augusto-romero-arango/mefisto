// Interfaz herdr de los pipelines INTERNOS de Mefisto (porte de scripts/herdr-pipeline.mts).
//
// Implementacion canonica (MEF-ADR-0049 decision 2); .claude/scripts/mefisto-herdr-pipeline.sh
// reenvia aqui.
//
// Uso (misma superficie de modos que mefisto-launch-pipeline.sh):
//   src/internal/scripts/mefisto-herdr-pipeline.sh --tooling 42 [--from-stage N]
//   src/internal/scripts/mefisto-herdr-pipeline.sh --tooling 42 --models 'reviewer=<modelo>'
//   src/internal/scripts/mefisto-herdr-pipeline.sh --tooling 42 --variant experimento-a
//   src/internal/scripts/mefisto-herdr-pipeline.sh --batch 42 43 44
//
// Reutiliza (o crea) un pane de ejecucion en el workspace herdr actual y le teclea el runner,
// que corre el sub-pipeline en background y muestra intercalados el visor en vivo
// (mefisto-stream-watch) y el propio .report.log (issue #926). Mismo pool, ocupacion y
// confirmacion de arranque que el publicado (issue #1563, porte #1571); no tiene modo paralelo.
//
// Requiere correr dentro de un pane herdr (HERDR_ENV=1) y dentro del repo de Mefisto.

import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { words } from '../../../scripts/lib/azure-cli.mts'
import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { capture, CliError, COLOR, commandExists, isEntryPoint } from '../../../scripts/lib/cli.mts'
import {
  confirmTimeout,
  createDispatcher,
  defaultParentOf,
  descendsFromPaneShell,
  runPaneRunner,
  stateDirOf,
} from '../../../scripts/lib/herdr.mts'
import type { LaunchChild, ParentOf } from '../../../scripts/lib/herdr.mts'
import { launcherStatePath, LauncherExit } from '../../../scripts/lib/launcher.mts'
import { clockTime } from '../../../scripts/lib/pipeline/agent-log.mts'
import { caffeinatePrefix } from '../../../scripts/lib/pipeline/caffeinate.mts'
import type { SignalSource } from '../../../scripts/lib/pipeline/pipeline-exit.mts'
import { resolveRuntime, runtimeLibDir } from '../../runtime/lib/mefisto-runtime.mts'
import { ensureRepoOnBaseBranch } from './lib/mefisto-base-branch.mts'
import { assertInMefisto } from './lib/mefisto-repo.mts'
import type { MefistoRepo } from './lib/mefisto-repo.mts'

const SCRIPT_DIR = import.meta.dirname

const { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, bold: BOLD, reset: NC } = COLOR

export interface MefistoHerdrDeps {
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
  /** Carpeta de los pipelines internos; por defecto, la de este modulo. */
  scriptDir?: string
  assertRepo?: (cwd: string) => MefistoRepo
  parentOf?: ParentOf
  isAlive?: (pid: number) => boolean
  launch?: LaunchChild
  signals?: SignalSource
  exit?: (code: number) => void
}

export function usage(self: string): string {
  return [
    `Uso: ${self} --tooling <issue> [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>]`,
    `     ${self} --batch <issue1> <issue2> ...`,
    '',
    'Interfaz herdr de los pipelines internos: reutiliza (o crea) un pane',
    'de ejecucion en el workspace herdr actual con el visor en vivo',
    '(mefisto-stream-watch.sh) del agente en curso; una corrida concurrente',
    'abre un pane adicional.',
    '--variant <label> (issue #711) corre el mismo issue en un pane propio,',
    'sin push/PR/comentario al issue -- solo valido con --tooling; --batch',
    'lo rechaza (seria ambiguo sobre varios issues).',
    'Fuera de herdr usa mefisto-launch-pipeline.sh, que autodetecta y delega',
    'aqui solo cuando aplica.',
    '',
  ].join('\n')
}

/** Pipeline a correr: la gemela `.mts` de un `.sh` si existe. */
function runnable(script: string): string {
  const twin = script.replace(/\.sh$/, '.mts')
  return twin !== script && existsSync(twin) ? twin : script
}

export async function mefistoHerdrPipeline(deps: MefistoHerdrDeps): Promise<number> {
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
    const repo = (deps.assertRepo ?? assertInMefisto)(deps.cwd)
    const projectRoot = resolve(repo.root)
    const stateDir = stateDirOf(projectRoot, env)
    mkdirSync(stateDir, { recursive: true })
    const logDir = join(stateDir, 'logs')
    const caffeinate = caffeinatePrefix(env, deps.platform)
    const self = join(scriptDir, 'mefisto-herdr-pipeline.sh')
    const argv = deps.argv

    if (argv.length === 0) {
      deps.out(usage(self))
      return 1
    }
    if (argv[0] === '--_pane-runner') {
      return await runPaneRunner(
        {
          argv: argv.slice(1),
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
          allowDelay: false,
          reportPrefix: 'mefisto-herdr-run',
          followReport: true,
          viewer: (issues, newerThan) => [
            join(scriptDir, 'mefisto-stream-watch.mts'),
            ...(issues === '' ? [] : ['--issues', issues]),
            '--newer-than',
            String(newerThan),
          ],
        },
      )
    }

    // --from-stage, --models y --variant salen de cualquier posicion, como en el lanzador.
    let fromStage = ''
    let models = ''
    let variant = ''
    const remaining: string[] = []
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string
      const hasValue = i + 1 < argv.length
      if (arg === '--from-stage') {
        if (!hasValue) abort('Falta el valor de --from-stage')
        const stage = argv[++i] as string
        if (!/^[0-9]+$/.test(stage)) abort(`--from-stage debe ser un numero entero (recibido: '${stage}')`)
        fromStage = `--from-stage ${stage}`
      } else if (arg === '--models') {
        if (!hasValue) abort('Falta el valor de --models')
        models = argv[++i] as string
      } else if (arg === '--variant') {
        if (!hasValue) abort('Falta el valor de --variant')
        variant = argv[++i] as string
      } else if (arg === '--attach' || arg === '--if-exists') {
        abort('--attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5).')
      } else {
        remaining.push(arg)
      }
    }

    const paneId = env.HERDR_PANE_ID ?? ''
    const workspaceId = env.HERDR_WORKSPACE_ID ?? ''
    const requireHerdrContext = (): void => {
      const remedy = 'Fuera de herdr lanza con mefisto-launch-pipeline.sh sin MEFISTO_UI=herdr (modo desacoplado).'
      if (!deps.hasCommand('herdr')) abort(`herdr no esta instalado (https://herdr.dev). ${remedy}`)
      if (env.HERDR_ENV !== '1') abort(`No estas dentro de un pane de herdr (HERDR_ENV != 1). ${remedy}`)
      if (paneId === '' || workspaceId === '') {
        abort('Faltan HERDR_PANE_ID/HERDR_WORKSPACE_ID en el entorno (los inyecta herdr en cada pane).')
      }
    }

    const parentOf = deps.parentOf ?? defaultParentOf(run, deps.platform)
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

    // El runtime es parte de la clave del pool (issue #928) y se resuelve antes de tocarlo.
    const dispatchToPane = async (title: string, issues: string, command: string[]): Promise<void> => {
      const found = await resolveRuntime('', env, deps.hasCommand, runtimeLibDir(env))
      if ('error' in found) abort(`No se pudo resolver el runtime activo: ${found.error}`)
      const runtime = (found as { runtime: string }).runtime
      const dispatchEnv: Record<string, string> = {}
      if ((env.MEFISTO_RUNTIME ?? '') !== '') dispatchEnv.MEFISTO_RUNTIME = env.MEFISTO_RUNTIME as string
      if ((env.MEFISTO_MODELS_FILE ?? '') !== '') dispatchEnv.MEFISTO_MODELS_FILE = env.MEFISTO_MODELS_FILE as string
      const dispatcher = createDispatcher({
        run,
        projectRoot,
        pane: paneId,
        stateDir,
        pool: {
          file: launcherStatePath('herdr-report-panes.txt', projectRoot, env),
          workspace: workspaceId,
          runtime,
          strictRows: false,
        },
        runnerScript: join(scriptDir, 'mefisto-herdr-pipeline.mts'),
        dispatchEnv: () => dispatchEnv,
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
        liveHint: 'El pane muestra en vivo el visor del agente y el stdout del pipeline',
        logDir,
      })
      await dispatcher.dispatch(title, issues, command)
    }

    const [mode = '', ...rest] = remaining
    if (mode === '--help' || mode === '-h') {
      deps.out(usage(self))
    } else if (mode === '--tooling') {
      requireHerdrContext()
      const issue = rest[0]
      if (issue === undefined) {
        abort("Falta el numero de issue. Uso: --tooling <issue> [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>]")
      }
      const title = variant !== '' ? `mefisto-tooling #${issue} (${variant})` : `mefisto-tooling #${issue}`
      await dispatchToPane(title, issue as string, [
        runnable(join(scriptDir, 'mefisto-tooling-pipeline.sh')),
        issue as string,
        ...words(fromStage),
        ...(models !== '' ? ['--models', models] : []),
        ...(variant !== '' ? ['--variant', variant] : []),
      ])
    } else if (mode === '--batch') {
      if (rest.length === 0) abort('Debes especificar al menos un issue. Uso: --batch 42 43 44')
      if (fromStage !== '') {
        abort('--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --from-stage N para un unico issue.')
      }
      if (models !== '') {
        abort("--models no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --models 'agente=modelo' para un unico issue.")
      }
      if (variant !== '') {
        abort('--variant no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --variant <label> para un unico issue.')
      }
      requireHerdrContext()
      // La rama se valida antes de adquirir, reutilizar o cerrar panes.
      const check = ensureRepoOnBaseBranch({ repoRoot: projectRoot, run })
      if (check.gitStderr !== '') deps.err(check.gitStderr)
      if (!check.ok) abort(check.abort)
      if (check.ok) for (const warning of check.warnings) warn(warning)
      const csv = rest.join(',')
      await dispatchToPane(`mefisto-batch ${csv}`, csv, [runnable(join(scriptDir, 'mefisto-batch-pipeline.sh')), ...rest])
    } else if (mode === '') {
      deps.out(usage(self))
      return 1
    } else {
      abort(`Argumento no reconocido: ${mode}`)
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
  process.exitCode = await mefistoHerdrPipeline({
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
