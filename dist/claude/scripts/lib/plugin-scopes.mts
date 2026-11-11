// Scopes de instalacion de mefisto que aplican al proyecto activo (issue #2130) y su activacion
// por repositorio (MEF-ADR-0053 decision 2, issue #2261).
//
// Precedencia de Claude Code cuando el mismo plugin esta en varios scopes: local > project > user
// (https://code.claude.com/docs/en/discover-plugins, "Choose an install scope"). Actualizar solo
// `user` deja vieja la instalacion que la sesion realmente carga. `managed` queda fuera: no lo
// controla el usuario.
//
// Los archivos de mefisto se instalan a scope user pero quedan deshabilitados a ese nivel; cada
// consumidor lo habilita en su `.claude/settings.json` commiteado (proyecto > usuario).
// `claude plugin install --scope user` reescribe el nivel usuario a true (verificado en 2.1.296),
// por eso todo install va seguido de `disableAtUserLevel`.
//
// Las lecturas degradan en silencio: sin una salida JSON valida del CLI, `applicableScopes`
// devuelve `user` y `effectiveInstallation` no devuelve nada.

import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, win32 } from 'node:path'

import { gitOutput } from './cli.mts'
import type { CommandResult } from './cli.mts'

// Slug del repo de Mefisto y el previo al rename (#2349): GitHub redirige el viejo, y los
// consumidores lo conservan en known_marketplaces.json y en su extraKnownMarketplaces.
export const PUBLISHED_SLUG = 'augusto-romero-arango/mefisto'
export const PREVIOUS_SLUG = 'augusto-romero-arango/eda-evsourcing-azure-harness'
const PUBLISHED_MARKETPLACE = 'augusto-romero-arango-harness'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export type Run = (command: string, args: string[]) => CommandResult

/** Entorno de Claude Code del usuario y el CLI `claude`, sustituibles en un test. */
export interface ClaudeContext {
  env: NodeJS.ProcessEnv
  /** Carpeta personal del usuario (`os.homedir()`). */
  home: string
  run: Run
  out: (line: string) => void
  err: (line: string) => void
}

export type ClaudeConfig = Pick<ClaudeContext, 'env' | 'home'>

export interface Installation {
  scope: string
  version: string
  installPath: string
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `undefined` si `text` no es un unico valor JSON. */
export function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text) as Json
  } catch {
    return undefined
  }
}

export function readJsonFile(path: string): Json | undefined {
  try {
    return parseJson(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const TRAILING_SEPARATOR = process.platform === 'win32' ? /[\\/]$/ : /\/$/

export function stripTrailingSeparator(path: string): string {
  return path.replace(TRAILING_SEPARATOR, '')
}

/** Carpeta de configuracion de Claude Code: `CLAUDE_CONFIG_DIR` o `~/.claude`. */
export function claudeConfigDir(config: ClaudeConfig): string {
  const override = config.env.CLAUDE_CONFIG_DIR ?? ''
  return override.length > 0 ? override : join(config.home, '.claude')
}

export function userSettingsPath(config: ClaudeConfig): string {
  return join(claudeConfigDir(config), 'settings.json')
}

/** Lista de `claude plugin list --json`, o `null` si el CLI falla o no devuelve un array. */
export function pluginListJson(context: Pick<ClaudeContext, 'run'>): Json[] | null {
  const result = context.run('claude', ['plugin', 'list', '--json'])
  if (result.status !== 0) return null
  const list = parseJson(result.stdout)
  return Array.isArray(list) ? list : null
}

// git imprime la raiz con `/` tambien en Windows; Claude Code guarda `projectPath` con `\`.
export function sameProjectPath(
  projectPath: string,
  top: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (projectPath === top) return true
  if (platform !== 'win32' || projectPath.length === 0 || top.length === 0) return false
  return win32.resolve(projectPath).toLowerCase() === win32.resolve(top).toLowerCase()
}

function tsvField(value: Json | undefined): string {
  if (typeof value === 'string') return value
  return typeof value === 'number' || value === true ? String(value) : ''
}

/** Instalaciones de `mefisto@<marketplace>` en scope user, o en project/local de `top`. */
export function applicableInstallations(
  marketplace: string,
  list: Json[] | null,
  top: string,
  platform: NodeJS.Platform = process.platform,
): Installation[] {
  if (list === null) return []
  const id = `mefisto@${marketplace}`
  const found: Installation[] = []
  for (const entry of list) {
    if (!isObject(entry) || entry.id !== id) continue
    const { scope, projectPath } = entry
    const ofProject =
      (scope === 'project' || scope === 'local') &&
      typeof projectPath === 'string' &&
      sameProjectPath(projectPath, top, platform)
    if (scope !== 'user' && !ofProject) continue
    found.push({ scope, version: tsvField(entry.version), installPath: tsvField(entry.installPath) })
  }
  return found
}

/** Scopes a actualizar, sin repetir y en orden alfabetico; `user` si no hay datos. */
export function applicableScopes(marketplace: string, list: Json[] | null, top: string): string[] {
  const scopes = [...new Set(applicableInstallations(marketplace, list, top).map((entry) => entry.scope))]
  return scopes.length === 0 ? ['user'] : scopes.sort()
}

/** La instalacion de mayor precedencia (local > project > user), o `null` si no hay datos. */
export function effectiveInstallation(
  marketplace: string,
  list: Json[] | null,
  top: string,
): Installation | null {
  const installations = applicableInstallations(marketplace, list, top)
  for (const scope of ['local', 'project', 'user']) {
    const match = installations.find((entry) => entry.scope === scope)
    if (match !== undefined) return match
  }
  return null
}

function relay(result: CommandResult, context: ClaudeContext): void {
  if (result.stdout.length > 0) context.out(result.stdout.replace(/\r?\n$/, ''))
  if (result.stderr.length > 0) context.err(result.stderr.replace(/\r?\n$/, ''))
}

/** Corre `claude` y reenvia su salida; `true` si termino en 0. */
export function runClaude(context: ClaudeContext, args: string[]): boolean {
  const result = context.run('claude', args)
  relay(result, context)
  return result.status === 0
}

/** `claude plugin update` una vez por scope aplicable; `false` en el primero que falla. */
export function updateScopes(
  context: ClaudeContext,
  marketplace: string,
  list: Json[] | null,
  top: string,
): boolean {
  for (const scope of applicableScopes(marketplace, list, top)) {
    context.out(`Actualizando el plugin mefisto@${marketplace} (scope ${scope})...`)
    if (!runClaude(context, ['plugin', 'update', `mefisto@${marketplace}`, '--scope', scope])) {
      context.err(`ERROR: 'claude plugin update mefisto@${marketplace} --scope ${scope}' fallo.`)
      return false
    }
  }
  return true
}

/** `false` solo si el nivel usuario lo deshabilita con un false explicito: sin la clave, Claude Code lo carga. */
export function enabledAtUserLevel(config: ClaudeConfig, marketplace: string): boolean {
  const path = userSettingsPath(config)
  if (!isFile(path)) return true
  const settings = readJsonFile(path)
  if (!isObject(settings) || !isObject(settings.enabledPlugins)) return true
  return settings.enabledPlugins[`mefisto@${marketplace}`] !== false
}

/**
 * `true` si el `.claude/settings.json` de HEAD en `top` habilita `mefisto@<marketplace>`. Lee lo
 * commiteado, no el disco: los worktrees de pipeline nacen de origin/main.
 */
export function committedActivation(marketplace: string, top: string): boolean {
  if (top.length === 0) return false
  const content = gitOutput(['-C', top, 'show', 'HEAD:.claude/settings.json'])
  if (content === null) return false
  const settings = parseJson(content)
  if (!isObject(settings) || !isObject(settings.enabledPlugins)) return false
  const enabled = settings.enabledPlugins[`mefisto@${marketplace}`]
  return enabled === true || enabled === 'true'
}

/** Deja `enabledPlugins` en false a nivel usuario; `false` si el CLI falla o no surte efecto. */
export function disableAtUserLevel(context: ClaudeContext, marketplace: string): boolean {
  const id = `mefisto@${marketplace}`
  if (context.run('claude', ['plugin', 'disable', id, '--scope', 'user']).status !== 0) {
    context.err(`ERROR: 'claude plugin disable ${id} --scope user' fallo.`)
    return false
  }
  if (enabledAtUserLevel(context, marketplace)) {
    context.err(`ERROR: ${id} sigue habilitado a nivel usuario en ${userSettingsPath(context)}.`)
    return false
  }
  return true
}

/**
 * Diagnostico legible de la activacion. Avisa `MIGRACION PENDIENTE` cuando el repo ya habilita
 * mefisto y el nivel usuario todavia lo carga en todos los repos; el comando decide si migra.
 */
export function reportActivation(context: ClaudeContext, marketplace: string, top: string): void {
  const repo = committedActivation(marketplace, top)
  const user = enabledAtUserLevel(context, marketplace)
  context.out('Activacion de Mefisto:')
  context.out(`  Este repo lo habilita en .claude/settings.json commiteado: ${repo ? 'si' : 'no'}`)
  context.out(`  Nivel usuario (${userSettingsPath(context)}): ${user ? 'habilitado' : 'deshabilitado'}`)
  if (repo && user) {
    context.out('MIGRACION PENDIENTE: Mefisto se carga en todos tus repos. Deshabilitarlo a nivel usuario')
    context.out('  lo deja activo solo en los repos que lo habilitan, como este.')
  } else if (!repo) {
    context.out('AVISO: este repo no habilita Mefisto en un .claude/settings.json commiteado.')
    context.out(
      `  Agrega "enabledPlugins": {"mefisto@${marketplace}": true} (o corre /mefisto:onboard) y commitealo;`,
    )
    context.out('  sin eso, Mefisto no se cargara aqui cuando lo deshabilites a nivel usuario.')
  }
}

function knownMarketplaces(config: ClaudeConfig): Json | undefined {
  const path = join(claudeConfigDir(config), 'plugins', 'known_marketplaces.json')
  return isFile(path) ? readJsonFile(path) : undefined
}

/**
 * Nombre del marketplace que provee mefisto: el del cache (`<cache>/<mkt>/mefisto/<version>`) si
 * `root` vive ahi; si no, el que apunta al repo de Mefisto en known_marketplaces.json; por
 * ultimo, el publicado.
 */
export function mefistoMarketplace(config: ClaudeConfig, root: string): string {
  const parent = dirname(stripTrailingSeparator(root))
  if (basename(parent) === 'mefisto' && basename(dirname(dirname(parent))) === 'cache') {
    return basename(dirname(parent))
  }
  const known = knownMarketplaces(config)
  if (isObject(known)) {
    for (const [name, entry] of Object.entries(known)) {
      if (!isObject(entry) || !isObject(entry.source)) continue
      const { repo } = entry.source
      if (repo === PUBLISHED_SLUG || repo === PREVIOUS_SLUG) {
        return name.length > 0 ? name : PUBLISHED_MARKETPLACE
      }
    }
  }
  return PUBLISHED_MARKETPLACE
}

/** Objeto `source` del marketplace para extraKnownMarketplaces; si no esta registrado, el repo publicado. */
export function marketplaceSource(config: ClaudeConfig, marketplace: string): JsonObject {
  const known = knownMarketplaces(config)
  const entry = isObject(known) ? known[marketplace] : undefined
  const source = isObject(entry) ? entry.source : undefined
  if (isObject(source) && (source.source === 'github' || source.source === 'git')) return source
  return { source: 'github', repo: PUBLISHED_SLUG }
}
