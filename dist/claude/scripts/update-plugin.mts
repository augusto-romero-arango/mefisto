// update-plugin.mts -- actualiza el plugin Mefisto desde el consumidor (issue #531).
//
// Uso:
//   update-plugin.mts                                    actualiza (nunca borra nada)
//   update-plugin.mts --prune --only <v>[,<v>...] [--loaded <v>]
//                                                        borra las podables confirmadas
//   update-plugin.mts --disable-user                     deshabilita mefisto a nivel usuario
//
// Modo actualizar:
//   1. Detecta el marketplace que provee `mefisto` en el cache de plugins, sin fijar su nombre:
//      lo deriva del .plugin-root cargado y, si eso no alcanza, recorre el cache. Asi funciona
//      igual en un fork publicado bajo otro marketplace.
//   2. Refresca el catalogo y actualiza `mefisto@<marketplace>` en cada scope que aplica al
//      proyecto (issue #2130). El nombre va calificado: el CLI rechaza `mefisto` a secas (#601).
//   3. Reescribe .claude/pipeline/.plugin-root a la instalacion efectiva del proyecto (sin datos
//      de `claude plugin list --json`, a la version mas reciente del cache), para que un pipeline
//      que arranque antes de /reload-plugins ya resuelva la version nueva, y falla si esa
//      version no es la destino.
//   4. Imprime el delta de CHANGELOG.md entre la version cargada y la nueva.
//   5. Reporta que versiones del cache quedarian podables.
//
// Modo poda: la unica operacion destructiva, y solo tras la confirmacion que pide el comando. No
// vuelve a llamar al CLI: repetir el update podria mover la version destino a mitad del ciclo.
//
// La poda nunca borra la version que la sesion tiene cargada: si el skill en ejecucion se borra a
// si mismo, la sesion rompe a mitad de camino. Esa version sale, en orden, de:
//   - `--loaded <version>`, que upgrade.mts deriva de la raiz viva del plugin (issue #2249).
//   - .claude/pipeline/.plugin-root.previous, que el modo actualizar escribe una sola vez por
//     sesion con el .plugin-root previo al paso 3 y que limpia el hook SessionStart. Protege la
//     version cargada entre dos corridas de la misma sesion; /reload-plugins no lo limpia, asi
//     que solo es respaldo para corridas sin `--loaded`.
//   - Si nada resuelve, se protegen las dos versiones mas nuevas del cache y se avisa.
// Ademas se conserva siempre la version de .plugin-root y la del marcador canonico
// .mefisto/pipeline/.plugin-root (issue #2248), que describe la version de la sesion viva: el peor
// caso es conservar una version de mas.
//
// Sale en 0 si el modo pedido corrio completo; en 1 si el repo es Mefisto, falta el CLI `claude`,
// no hay `mefisto` en el cache o el CLI fallo.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, capture, commandExists, isEntryPoint, repoRoot } from './lib/cli.mts'
import {
  committedActivation,
  disableAtUserLevel,
  effectiveInstallation,
  enabledAtUserLevel,
  isDirectory,
  isFile,
  pluginListJson,
  reportActivation,
  runClaude,
  stripTrailingSeparator,
  updateScopes,
} from './lib/plugin-scopes.mts'
import type { ClaudeContext } from './lib/plugin-scopes.mts'

export interface UpdatePluginDeps extends ClaudeContext {
  cwd: string
  /** Nombre del script en la linea de uso y en la pista de poda. */
  program: string
  hasCommand: (command: string) => boolean
}

const PLUGIN_ROOT_FILE = '.claude/pipeline/.plugin-root'
const MARKER_FILE = '.claude/pipeline/.plugin-root.previous'
const CANONICAL_ROOT_FILE = '.mefisto/pipeline/.plugin-root'
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/

function usage(program: string): string[] {
  return [
    `Uso: ${program} [--prune --only <v>[,<v>...] [--loaded <version>]]`,
    '  (sin flags)        actualiza marketplace + plugin, reescribe .plugin-root, imprime el',
    '                     delta de CHANGELOG y reporta versiones podables del cache (sin borrar).',
    '  --prune            borra versiones podables (solo tras confirmar con el usuario, CA-4); exige --only.',
    '  --only <lista>     versiones confirmadas por el usuario (separadas por coma). La poda borra solo la',
    '                     interseccion entre esa lista y las podables recalculadas al borrar.',
    '  --loaded <version> version que la sesion activa tiene cargada; la poda nunca la borra.',
    '  --disable-user     deshabilita mefisto a nivel usuario (solo tras confirmar); exige que el repo lo',
    '                     habilite en su .claude/settings.json commiteado (MEF-ADR-0053 decision 2).',
  ]
}

function fail(lines: string[]): never {
  throw new CliError(lines.join('\n'))
}

function stateFile(cwd: string, file: string): string {
  return join(cwd, ...file.split('/'))
}

/** Contenido sin saltos finales; vacio si el archivo no se puede leer. */
function readTrimmed(path: string): string {
  try {
    return readFileSync(path, 'utf8').replace(/(?:\r?\n)+$/, '')
  } catch {
    return ''
  }
}

function hasContent(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

/** Entradas visibles de `dir`, como las recorre un glob `*`. */
function visibleEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

/** Version de una ruta del cache (`.../mefisto/0.19.0`), tolerando el separador final. */
export function versionOfPath(path: string): string {
  const trimmed = stripTrailingSeparator(path)
  return trimmed.length === 0 ? '' : basename(trimmed)
}

function insideCache(loaded: string, cacheRoot: string): boolean {
  const [path, root] =
    process.platform === 'win32'
      ? [loaded.replaceAll('\\', '/'), cacheRoot.replaceAll('\\', '/')]
      : [loaded, cacheRoot]
  return path.startsWith(`${root}/`) && path.slice(root.length + 1).includes('/mefisto/')
}

/**
 * Directorio `<cacheRoot>/<marketplace>/mefisto`. Prefiere derivarlo del .plugin-root cargado,
 * que ya apunta dentro del cache y desambigua sin adivinar; si no alcanza, recorre el cache y,
 * con mas de un candidato, avisa y usa el primero. `null` si no hay ninguno.
 */
export function marketplaceDir(
  loadedRoot: string,
  cacheRoot: string,
  warn: (line: string) => void = () => {},
): string | null {
  const loaded = stripTrailingSeparator(loadedRoot)
  const cache = stripTrailingSeparator(cacheRoot)
  if (loaded.length > 0 && insideCache(loaded, cache)) {
    const dir = dirname(loaded)
    if (basename(dir) === 'mefisto' && isDirectory(dir)) return dir
  }
  const candidates = visibleEntries(cache)
    .map((name) => join(cache, name, 'mefisto'))
    .filter((candidate) => existsSync(candidate))
    .sort()
  const [first] = candidates
  if (first === undefined) return null
  if (candidates.length > 1) {
    warn(`ADVERTENCIA: hay ${candidates.length} marketplaces con 'mefisto' en el cache; se usa el primero.`)
    for (const candidate of candidates) warn(`  - ${candidate}`)
  }
  return first
}

/** Orden de `sort -V`: los tramos de digitos se comparan como numeros. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.match(/\d+|\D+/g) ?? []
  const partsB = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    const [x, y] = [partsA[i] ?? '', partsB[i] ?? '']
    if (x === y) continue
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const diff = BigInt(x) - BigInt(y)
      if (diff !== 0n) return diff < 0n ? -1 : 1
      continue
    }
    return x < y ? -1 : 1
  }
  if (partsA.length !== partsB.length) return partsA.length - partsB.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** Versiones presentes en el cache, en orden ascendente. */
export function cacheVersions(mefistoDir: string): string[] {
  return visibleEntries(mefistoDir)
    .filter((name) => isDirectory(join(mefistoDir, name)))
    .sort(compareVersions)
}

/**
 * Versiones que la poda conserva, sin repetir y en orden lexicografico. Sin version cargada
 * conocida infiere la N-1 (la mas nueva distinta de `newest`): es la que la sesion cargo en el
 * caso normal, y protegerla de mas es preferible a borrar la que la sesion esta ejecutando.
 */
export function protectedVersions(
  all: string[],
  newest: string,
  loaded: string,
  inPluginRoot: string,
  canonical = '',
): string[] {
  const inferred =
    loaded.length > 0 ? loaded : (all.filter((version) => version.length > 0 && version !== newest).at(-1) ?? '')
  const kept = [newest, inferred, inPluginRoot, canonical].filter((version) => version.length > 0)
  return [...new Set(kept)].sort()
}

/** Versiones a borrar: las de `all` que no estan protegidas, en su orden. */
export function prunableVersions(all: string[], protectedList: string[]): string[] {
  return all.filter((version) => version.length > 0 && !protectedList.includes(version))
}

/**
 * Entradas de CHANGELOG.md publicadas despues de `loaded`: desde el primer encabezado `## [`
 * hasta el de la version cargada. Si ese encabezado no existe no vuelca el historico completo:
 * avisa y muestra solo la seccion mas reciente.
 */
export function changelogDelta(file: string, loaded: string, newest: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const isHeading = (line: string): boolean => line.startsWith('## [')
  const start = lines.findIndex(isHeading)
  const sections = start === -1 ? [] : lines.slice(start)
  const marker = `## [${loaded}]`

  if (lines.some((line) => line.includes(marker))) {
    const end = sections.findIndex((line) => line.startsWith(marker))
    return [
      `--- Delta de CHANGELOG.md (${loaded} -> ${newest}) ---`,
      ...(end === -1 ? sections : sections.slice(0, end)),
      '--- fin del delta ---',
    ]
  }
  const next = sections.findIndex((line, index) => index > 0 && isHeading(line))
  return [
    `ADVERTENCIA: ${file} no tiene un encabezado '## [${loaded}]'; no se puede acotar el delta.`,
    '--- Seccion mas reciente de CHANGELOG.md ---',
    ...(next === -1 ? sections : sections.slice(0, next)),
    '--- fin de la seccion ---',
  ]
}

function cacheRootOf(deps: UpdatePluginDeps): string {
  const override = deps.env.MEFISTO_CACHE_ROOT ?? ''
  return override.length > 0 ? override : join(deps.home, '.claude', 'plugins', 'cache')
}

/**
 * Migracion a activacion por repositorio. Nunca deja el repo actual sin Mefisto: se niega si el
 * .claude/settings.json commiteado no lo habilita.
 */
function disableUser(deps: UpdatePluginDeps, top: string): number {
  const cacheRoot = cacheRootOf(deps)
  if (!deps.hasCommand('claude')) fail(["ERROR: el CLI 'claude' no esta en el PATH."])
  const dir = marketplaceDir(readTrimmed(stateFile(deps.cwd, PLUGIN_ROOT_FILE)), cacheRoot, deps.err)
  if (dir === null) {
    fail([`ERROR: no se encontro ningun 'mefisto' en el cache de plugins (${cacheRoot}/*/mefisto).`])
  }
  const marketplace = basename(dirname(dir))
  if (!committedActivation(marketplace, top)) {
    reportActivation(deps, marketplace, top)
    fail(['ERROR: no se deshabilito nada: este repo quedaria sin Mefisto.'])
  }
  if (!enabledAtUserLevel(deps, marketplace)) {
    deps.out('Mefisto ya esta deshabilitado a nivel usuario; no se modifico nada.')
    return 0
  }
  if (!disableAtUserLevel(deps, marketplace)) return 1
  deps.out(`OK: mefisto@${marketplace} deshabilitado a nivel usuario. Sigue activo en los repos que lo habilitan.`)
  deps.out('Reinicia las sesiones de Claude Code abiertas en otros repos para descargarlo de ellas.')
  return 0
}

interface Options {
  prune: boolean
  loaded: string
  /** `null` si no se paso `--only`. */
  only: string | null
}

function parseArgs(argv: string[], program: string): Options | 'help' {
  const options: Options = { prune: false, loaded: '', only: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--prune':
        options.prune = true
        break
      case '--loaded':
        if (value === undefined || value.length === 0) {
          fail(['ERROR: --loaded requiere una version (p. ej. --loaded 0.19.0)', ...usage(program)])
        }
        options.loaded = value
        i++
        break
      case '--only':
        if (value === undefined) {
          fail([
            'ERROR: --only requiere una lista de versiones (p. ej. --only 0.43.0,0.44.0)',
            ...usage(program),
          ])
        }
        options.only = value
        i++
        break
      case '-h':
      case '--help':
        return 'help'
      default:
        fail([`ERROR: argumento desconocido '${arg}'`, ...usage(program)])
    }
  }
  return options
}

/** Versiones de `--only`, ya validadas; vacio fuera del modo poda. */
function confirmedVersions(options: Options, program: string): string[] {
  if (options.only !== null && !options.prune) {
    fail(['ERROR: --only solo aplica junto con --prune.', ...usage(program)])
  }
  if (!options.prune) return []
  if (options.only === null) {
    fail([
      'ERROR: --prune exige --only <v>[,<v>...] con las versiones que el usuario confirmo. No se borro nada.',
      ...usage(program),
    ])
  }
  const confirmed: string[] = []
  for (const item of options.only.split(/[,\n]/)) {
    if (item.length === 0) continue
    if (!VERSION.test(item)) {
      fail([
        `ERROR: '${item}' en --only no es una version (se espera X.Y.Z). No se borro nada.`,
        ...usage(program),
      ])
    }
    confirmed.push(item)
  }
  if (confirmed.length === 0) {
    fail(['ERROR: --only recibio una lista vacia. No se borro nada.', ...usage(program)])
  }
  return confirmed
}

function run(argv: string[], deps: UpdatePluginDeps): number {
  const { out, err } = deps
  const top = repoRoot(deps.cwd)
  if (top === null) fail(['ERROR: no estas en un repositorio git'])
  if (isFile(join(top, '.claude-plugin', 'plugin.json'))) {
    fail([
      'ERROR: /mefisto:upgrade no aplica al repo de Mefisto.',
      '       scripts/update-plugin.sh es del plugin publicado y solo aplica al consumidor.',
      '       Mefisto se actualiza a si mismo por su propio flujo de release (/mefisto-release).',
    ])
  }

  if (argv[0] === '--disable-user') {
    if (argv.length !== 1) {
      fail(['ERROR: --disable-user no se combina con otros argumentos.', ...usage(deps.program)])
    }
    return disableUser(deps, top)
  }
  const options = parseArgs(argv, deps.program)
  if (options === 'help') {
    for (const line of usage(deps.program)) err(line)
    return 0
  }
  const { prune } = options
  const confirmed = confirmedVersions(options, deps.program)

  const cacheRoot = cacheRootOf(deps)
  const pluginRootFile = stateFile(deps.cwd, PLUGIN_ROOT_FILE)
  const markerFile = stateFile(deps.cwd, MARKER_FILE)
  let pluginRoot = readTrimmed(pluginRootFile)

  const mefistoDir = marketplaceDir(pluginRoot, cacheRoot, err)
  if (mefistoDir === null) {
    fail([
      `ERROR: no se encontro ningun 'mefisto' en el cache de plugins (${cacheRoot}/*/mefisto).`,
      '       Verifica que el plugin este instalado (claude plugin install mefisto@<marketplace> --scope user',
      '       y luego claude plugin disable mefisto@<marketplace> --scope user: el repo lo habilita).',
    ])
  }
  const marketplace = basename(dirname(mefistoDir))

  let loaded = ''
  let loadedSource = ''
  if (options.loaded.length > 0) {
    loaded = options.loaded
    loadedSource = '--loaded'
  } else if (hasContent(markerFile)) {
    loaded = versionOfPath(readTrimmed(markerFile))
    loadedSource = MARKER_FILE
  } else if (pluginRoot.length > 0 && !prune) {
    // Primera corrida de la sesion: .plugin-root todavia describe lo que la sesion cargo.
    loaded = versionOfPath(pluginRoot)
    loadedSource = PLUGIN_ROOT_FILE
  }

  out(`Marketplace detectado: ${marketplace}`)
  if (loaded.length > 0) {
    out(`Version cargada en esta sesion: ${loaded} (fuente: ${loadedSource})`)
  } else {
    out('ADVERTENCIA: no se pudo determinar la version cargada en esta sesion.')
    out('             Se protegera de la poda la version N-1 del cache por precaucion.')
  }
  out('')

  if (!prune) {
    // Una vez por sesion y nunca se sobreescribe: la poda de este ciclo y las corridas
    // posteriores siguen viendo la version cargada aunque el paso 3 ya movio .plugin-root.
    if (!hasContent(markerFile) && pluginRoot.length > 0) {
      try {
        mkdirSync(dirname(markerFile), { recursive: true })
        writeFileSync(markerFile, pluginRoot)
      } catch {
        // Sin marker, la poda cae a la version inferida.
      }
    }

    if (!deps.hasCommand('claude')) {
      fail(["ERROR: el CLI 'claude' no esta en el PATH. Requerido para actualizar el plugin."])
    }

    out(`Actualizando el catalogo del marketplace (${marketplace})...`)
    if (!runClaude(deps, ['plugin', 'marketplace', 'update', marketplace])) {
      fail([
        `ERROR: 'claude plugin marketplace update ${marketplace}' fallo.`,
        '       Sin refrescar el catalogo, el update no veria la version nueva.',
        '       Revisa el acceso al repo del marketplace y reintenta.',
      ])
    }

    out('')
    if (!updateScopes(deps, marketplace, pluginListJson(deps), top)) {
      fail([
        '       No se toco .plugin-root ni el cache; reintenta tras resolver la causa.',
        `       Verifica que el plugin este instalado en ese scope (claude plugin install mefisto@${marketplace} --scope <scope>).`,
      ])
    }
    out('')
  }

  const newest = cacheVersions(mefistoDir).at(-1)
  if (newest === undefined) fail([`ERROR: no se encontro ninguna version de mefisto en ${mefistoDir}.`])
  let newestDir = join(mefistoDir, newest)

  if (!prune) {
    // Releida tras el update: .plugin-root debe apuntar a lo que la sesion siguiente cargara,
    // no a lo mas nuevo del cache (issue #2130).
    const effective = effectiveInstallation(marketplace, pluginListJson(deps), top)
    if (effective !== null && effective.installPath.length > 0 && isDirectory(effective.installPath)) {
      newestDir = stripTrailingSeparator(effective.installPath)
    }
    try {
      mkdirSync(dirname(pluginRootFile), { recursive: true })
      writeFileSync(pluginRootFile, newestDir)
    } catch {
      fail([`ERROR: no se pudo escribir ${PLUGIN_ROOT_FILE}.`])
    }
    out(`OK: ${PLUGIN_ROOT_FILE} -> ${newestDir}`)
    pluginRoot = newestDir
    out('')

    if (effective !== null && effective.version !== newest) {
      fail([
        `ERROR: la instalacion efectiva del proyecto (scope ${effective.scope}) quedo en la version ${effective.version} y la version destino es ${newest}.`,
        `       La sesion siguiente cargaria ${effective.version}. Corre 'claude plugin update mefisto@${marketplace} --scope ${effective.scope}' y reintenta.`,
      ])
    }

    const changelog = join(newestDir, 'CHANGELOG.md')
    if (loaded === newest) {
      out(`Ya estabas en la version mas reciente (${newest}); no hay delta que mostrar.`)
    } else if (loaded.length > 0 && isFile(changelog)) {
      for (const line of changelogDelta(changelog, loaded, newest)) out(line)
    } else {
      out(
        'ADVERTENCIA: no se pudo calcular el delta de CHANGELOG (version cargada desconocida o CHANGELOG.md ausente).',
      )
    }
    out('')
  }

  const all = cacheVersions(mefistoDir)
  const canonical = versionOfPath(readTrimmed(stateFile(deps.cwd, CANONICAL_ROOT_FILE)))
  const kept = protectedVersions(all, newest, loaded, versionOfPath(pluginRoot), canonical)
  const prunable = prunableVersions(all, kept)

  out(`Versiones conservadas: ${kept.join(' ')}`)
  const nowProtected = confirmed
    .filter((version) => !prunable.includes(version) && kept.includes(version))
    .map((version) => `${version} `)
    .join('')
  const reportNowProtected = (): void => {
    if (nowProtected.length > 0) {
      out(`Confirmadas que ahora estan protegidas (no se borraron): ${nowProtected}`)
    }
  }

  if (prunable.length === 0) {
    out('Cache limpio: no hay versiones podables.')
    reportNowProtected()
  } else if (prune) {
    out('Borrando del cache solo las versiones confirmadas (--only) que siguen siendo podables...')
    const unconfirmed: string[] = []
    for (const version of prunable) {
      if (!confirmed.includes(version)) {
        unconfirmed.push(version)
        continue
      }
      const target = join(mefistoDir, version)
      // Doble chequeo antes de borrar: un directorio de version dentro del cache de mefisto.
      if (basename(dirname(target)) !== 'mefisto' || basename(target) !== version) {
        out(`  omitida (ruta inesperada): ${target}`)
      } else if (!isDirectory(target)) {
        out(`  omitida (ya no existe): ${version}`)
      } else {
        try {
          rmSync(target, { recursive: true, force: true })
          out(`  borrada: ${version}`)
        } catch {
          out(`  FALLO al borrar: ${version}`)
        }
      }
    }
    if (unconfirmed.length > 0) {
      out(`Podables NO confirmadas (no se borraron): ${unconfirmed.map((version) => `${version} `).join('')}`)
    }
    reportNowProtected()
    out('')
    out(`El marker de sesion (${MARKER_FILE}) se conserva: lo limpia el hook SessionStart`)
    out('del plugin en el proximo arranque. Mientras esta sesion viva, protege la version cargada.')
  } else {
    out('Versiones podables en el cache (ni la cargada en esta sesion ni la nueva):')
    for (const version of prunable) out(`  - ${version}`)
    out('')
    out(
      'No se borro nada. Pide confirmacion al usuario y, si acepta, vuelve a correr con la lista exacta mostrada:',
    )
    const hint = `  ${deps.program} --prune --only ${prunable.join(',')}`
    out(loaded.length > 0 ? `${hint} --loaded ${loaded}` : hint)
  }
  out('')

  if (!prune) {
    reportActivation(deps, marketplace, top)
    out('')
  }

  out(`Version destino: ${newest}.`)
  out(`Corre /reload-plugins (o reinicia la sesion) para activar la version ${newest}.`)
  return 0
}

export function updatePlugin(argv: string[], deps: UpdatePluginDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deps.err(error.message)
    return error.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = updatePlugin(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    home: homedir(),
    program: fileURLToPath(import.meta.url),
    hasCommand: commandExists,
    run: capture,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
