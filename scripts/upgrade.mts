// upgrade.mts -- operacion neutral de actualizacion de Mefisto (MEF-ADR-0050/0053).
//
// Despacha por el runtime activo (MEFISTO_RUNTIME, o el unico adaptador disponible). Hoy el
// unico runtime con adaptador es claude: delega en update-plugin.mts, autoridad de ese lado.
//
// Uso:
//   upgrade.mts --status                   JSON versionado (schemaVersion 3) con la version
//                                          instalada en disco; es local, no informa si hay
//                                          una version mas nueva publicada
//   upgrade.mts                            actualiza
//   upgrade.mts --prune --only <v>[,<v>...] [--loaded <v>]
//                                          poda la lista confirmada en el comando
//   upgrade.mts --disable-user             retira Mefisto del nivel que lo carga en todos los
//                                          repos (solo tras confirmar); exige la activacion
//                                          commiteada del repo
//
// Nunca borra nada fuera de --prune. Refrescar panes, el mensaje de reload y la
// confirmacion de poda son responsabilidad del comando, no de este script.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, commandExists, isEntryPoint, repoRoot } from './lib/cli.mts'
import { discoverRuntime } from '../src/runtime/lib/mefisto-runtime.mts'

export interface UpgradeDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Carpeta de este script: junto a el vive update-plugin.mts. */
  scriptDir: string
  /** Nombre del script en la linea de uso. */
  program: string
  hasCommand: (command: string) => boolean
  /** Corre un script `.mts` con su salida en vivo y devuelve su codigo de salida. */
  delegate: (script: string, args: string[]) => number
  out: (line: string) => void
  err: (line: string) => void
}

type Mode = 'update' | 'status' | 'prune' | 'disable-user' | 'help'

interface Options {
  mode: Mode
  loaded: string
  /** `null` si no se paso `--only`. */
  only: string | null
}

const SEPARATORS = process.platform === 'win32' ? /[\\/]/ : /\//
const TRAILING_SEPARATOR = process.platform === 'win32' ? /[\\/]$/ : /\/$/

function usage(program: string): string {
  return `Uso: ${program} --status | --prune --only <v>[,<v>...] [--loaded <version>] | --disable-user`
}

function parseArgs(argv: string[], program: string): Options {
  const options: Options = { mode: 'update', loaded: '', only: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--status':
        options.mode = 'status'
        break
      case '--prune':
        options.mode = 'prune'
        break
      case '--disable-user':
        options.mode = 'disable-user'
        break
      case '--loaded':
        if (value === undefined || value.length === 0) {
          throw new CliError('ERROR: --loaded requiere una version.')
        }
        options.loaded = value
        i++
        break
      case '--only':
        if (value === undefined) throw new CliError('ERROR: --only requiere una lista de versiones.')
        options.only = value
        i++
        break
      case '-h':
      case '--help':
        return { ...options, mode: 'help' }
      default:
        throw new CliError(`ERROR: argumento desconocido '${arg}'\n${usage(program)}`)
    }
  }
  return options
}

function assertConsumerRepo(cwd: string): void {
  const root = repoRoot(cwd)
  if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
  if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
    throw new CliError(
      [
        'ERROR: /mefisto:upgrade no aplica al repo de Mefisto.',
        '       scripts/upgrade.mts es del plugin publicado y solo aplica al consumidor.',
        '       Mefisto se actualiza a si mismo por su propio flujo de release (/mefisto-release).',
      ].join('\n'),
    )
  }
}

function resolveRuntime(deps: UpgradeDeps): string {
  const libDir = join(deps.scriptDir, '..', 'src', 'runtime', 'lib')
  let runtime = deps.env.MEFISTO_RUNTIME ?? ''
  if (runtime.length === 0) {
    if (!isFile(join(libDir, 'mefisto-runtime.mts'))) throw new CliError('ERROR: fija MEFISTO_RUNTIME.')
    const override = deps.env.MEFISTO_RUNTIME_LIB_DIR ?? ''
    const found = discoverRuntime(override.length > 0 ? override : libDir, deps.env, deps.hasCommand)
    if ('error' in found) throw new CliError('ERROR: no se pudo resolver el runtime')
    runtime = found.runtime
  }
  if (runtime !== 'claude') {
    throw new CliError(`ERROR: runtime '${runtime}' no soportado por upgrade (solo claude).`)
  }
  return runtime
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

/** Version instalada en disco (la que cargara la proxima sesion), no la de la sesion viva. */
export function installedVersion(cwd: string): string | null {
  let root: string
  try {
    root = readFileSync(join(cwd, '.claude', 'pipeline', '.plugin-root'), 'utf8')
  } catch {
    return null
  }
  const version = basename(root.replace(/(?:\r?\n)+$/, '').replace(TRAILING_SEPARATOR, ''))
  return version.length > 0 ? version : null
}

/**
 * Version cargada segun MEFISTO_LOADED_ROOT (ruta de la version viva, sustituida por el
 * comando). Valida: ruta absoluta existente, plugin.json con name mefisto y version igual
 * al nombre del directorio. Vacia, sin sustituir o invalida: cadena vacia.
 */
export function loadedFromRoot(env: NodeJS.ProcessEnv): string {
  const raw = env.MEFISTO_LOADED_ROOT ?? ''
  if (raw.length === 0 || raw.includes('${') || !isAbsolute(raw)) return ''
  if (raw.split(SEPARATORS).includes('..')) return ''
  const root = raw.replace(TRAILING_SEPARATOR, '')
  const manifestPath = join(root, '.claude-plugin', 'plugin.json')
  if (!isDirectory(root) || !isFile(manifestPath)) return ''
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch {
    return ''
  }
  if (typeof manifest !== 'object' || manifest === null) return ''
  const { name, version } = manifest as Record<string, unknown>
  if (name !== 'mefisto' || typeof version !== 'string' || version.length === 0) return ''
  return version === basename(root) ? version : ''
}

function updatePluginScript(deps: UpgradeDeps): string {
  const script = join(deps.scriptDir, 'update-plugin.mts')
  if (!isFile(script)) throw new CliError('ERROR: no se hallo update-plugin.mts junto a upgrade.mts.')
  return script
}

function run(argv: string[], deps: UpgradeDeps): number {
  const options = parseArgs(argv, deps.program)
  if (options.mode === 'help') {
    deps.err(usage(deps.program))
    return 0
  }
  assertConsumerRepo(deps.cwd)
  const runtime = resolveRuntime(deps)

  if (options.mode === 'status') {
    deps.out(JSON.stringify({ schemaVersion: 3, runtime, installedVersion: installedVersion(deps.cwd) }))
    return 0
  }
  // Solo se ejecuta tras la confirmacion del comando; update-plugin.mts exige la activacion
  // commiteada del repo para no dejarlo sin Mefisto.
  if (options.mode === 'disable-user') return deps.delegate(updatePluginScript(deps), ['--disable-user'])

  const script = updatePluginScript(deps)
  const loaded = options.loaded.length > 0 ? options.loaded : loadedFromRoot(deps.env)
  const args: string[] = []
  if (options.mode === 'prune') {
    args.push('--prune')
    if (options.only !== null) args.push('--only', options.only)
  }
  if (loaded.length > 0) args.push('--loaded', loaded)
  return deps.delegate(script, args)
}

export function upgrade(argv: string[], deps: UpgradeDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deps.err(error.message)
    return error.exitCode
  }
}

function delegateToNode(script: string, args: string[]): number {
  return spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' }).status ?? 1
}

if (isEntryPoint(import.meta.url)) {
  const self = fileURLToPath(import.meta.url)
  process.exitCode = upgrade(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    scriptDir: dirname(self),
    program: self,
    hasCommand: commandExists,
    delegate: delegateToNode,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
