// onboard-activate-repo.mts -- habilita Mefisto en el repositorio consumidor
// (MEF-ADR-0053 decision 2, issue #2261). Provision opt-in de /onboard.
//
// Mefisto se instala por usuario e inerte; .claude/settings.json, commiteado, es lo que lo
// activa en el repo y en sus worktrees. Fusiona extraKnownMarketplaces y enabledPlugins sin
// tocar el resto de claves. No commitea.
//
// Uso: onboard-activate-repo.mts --preview | --apply   (cwd = raiz del consumidor)

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { CliError, isEntryPoint, repoRoot } from './lib/cli.mts'
import { isFile, isObject, marketplaceSource, mefistoMarketplace, readJsonFile } from './lib/plugin-scopes.mts'
import type { ClaudeConfig, Json, JsonObject } from './lib/plugin-scopes.mts'

export interface ActivateRepoDeps extends ClaudeConfig {
  cwd: string
  /** Carpeta de este script, dentro del paquete instalado. */
  scriptDir: string
  /** Nombre del script en la linea de uso. */
  program: string
  out: (line: string) => void
  err: (line: string) => void
}

function fail(lines: string[]): never {
  throw new CliError(lines.join('\n'))
}

/** Copia de `value` como objeto donde escribir una clave, o `null` si no admite claves. */
function writableObject(value: Json | undefined): JsonObject | null {
  if (value === undefined || value === null) return {}
  return isObject(value) ? { ...value } : null
}

/**
 * `settings` con el marketplace declarado (sin pisar una declaracion previa) y mefisto
 * habilitado. `null` si `extraKnownMarketplaces` o `enabledPlugins` no son objetos.
 */
export function withMefistoEnabled(
  settings: JsonObject,
  marketplace: string,
  source: JsonObject,
): JsonObject | null {
  const marketplaces = writableObject(settings.extraKnownMarketplaces)
  const plugins = writableObject(settings.enabledPlugins)
  if (marketplaces === null || plugins === null) return null
  const declared = marketplaces[marketplace]
  marketplaces[marketplace] = declared === undefined || declared === null || declared === false ? { source } : declared
  plugins[`mefisto@${marketplace}`] = true
  const merged = { ...settings }
  merged.extraKnownMarketplaces = marketplaces
  merged.enabledPlugins = plugins
  return merged
}

function run(argv: string[], deps: ActivateRepoDeps): number {
  const mode = argv[0] ?? ''
  const top = repoRoot(deps.cwd)
  if (top === null) fail(['ERROR: no estas en un repositorio git'])
  if (isFile(join(top, '.claude-plugin', 'plugin.json'))) {
    fail([
      'ERROR: /onboard no aplica al repo de Mefisto.',
      '       scripts/onboard-activate-repo.mts es del plugin publicado y solo aplica al consumidor.',
    ])
  }
  if (mode !== '--preview' && mode !== '--apply') fail([`Uso: ${deps.program} --preview | --apply`])

  // Comportamiento heredado: con el `..` sin resolver la raiz no se reconoce como ruta del cache
  // y el marketplace sale de known_marketplaces.json.
  const marketplace = mefistoMarketplace(deps, `${deps.scriptDir}${sep}..`)
  const source = marketplaceSource(deps, marketplace)
  const file = join(top, '.claude', 'settings.json')

  let current: JsonObject = {}
  if (isFile(file)) {
    const parsed = readJsonFile(file)
    if (!isObject(parsed)) fail([`ERROR: ${file} no es un objeto JSON valido; corrigelo a mano.`])
    current = parsed
  }
  const merged = withMefistoEnabled(current, marketplace, source)
  if (merged === null) {
    fail([
      `ERROR: ${file} tiene extraKnownMarketplaces o enabledPlugins que no son objetos; corrigelo a mano.`,
    ])
  }
  if (isDeepStrictEqual(current, merged)) {
    deps.out('OK: el repo ya habilita Mefisto (.claude/settings.json); no hay nada que escribir.')
    return 0
  }

  const content = JSON.stringify(merged, null, 2)
  if (mode === '--preview') {
    deps.out('Plan:')
    deps.out('  - escribir .claude/settings.json con este contenido (resto de claves intacto):')
    for (const line of content.split('\n')) deps.out(`      ${line}`)
    return 0
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${content}\n`)
  } catch {
    fail([`ERROR: no se pudo escribir ${file}.`])
  }
  deps.out(`OK: .claude/settings.json habilita mefisto@${marketplace}.`)
  deps.out('Commitea el archivo y llevalo a main: los worktrees de pipeline nacen de origin/main.')
  return 0
}

export function activateRepo(argv: string[], deps: ActivateRepoDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deps.err(error.message)
    return error.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  const self = fileURLToPath(import.meta.url)
  process.exitCode = activateRepo(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    home: homedir(),
    scriptDir: dirname(self),
    program: self,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
