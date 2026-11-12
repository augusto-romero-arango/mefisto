// Lectura, validacion y escritura del `harness.config.json` del consumidor (MEF-ADR-0053).

import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CliError, repoRoot } from './cli.mts'

export type ConfigPathMode = 'read' | 'write'

export interface HarnessConfigOptions {
  /** Directorio desde el que se busca la raiz Git cuando no se da ruta ni raiz. */
  cwd?: string
  /** Recibe los avisos que no abortan; sin el, se descartan. */
  warn?: (message: string) => void
}

export interface ServiceBusExternal {
  alias: string
  alcance: 'compartido' | 'externo'
  secretName: string
}

export interface HarnessSecret {
  name: string
  type: 'output' | 'github-secret' | 'composite'
  value: string
}

export interface HarnessConfig {
  /** Ruta efectiva: la canonica, la legacy de solo lectura o la que paso el llamador, sin tocar. */
  configPath: string
  projectName: string
  namespacePrefix: string
  solutionFile: string
  rgPrefix: string
  tfstateStorage: string
  spName: string
  appInsightsApp: string
  domainLabels: string[]
  bcName: string
  bcDomains: string[]
  /** Vacio si el config no declara `serviceBus`. */
  sbInternalSecret: string
  sbExternal: ServiceBusExternal[]
  secrets: HarnessSecret[]
  projectionsEnabled: boolean
  azureRegionShort: string
  resourceSequence: string
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Paso de `get` sobre un tipo que no lo admite: el valor leido queda vacio. */
class JqError extends Error {}

function fail(lines: string[]): never {
  throw new CliError(lines.join('\n'))
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

/** Ruta del config: en `read` cae a la legacy si falta la canonica; en `write`, siempre la canonica. */
export function resolveHarnessConfigPath(
  mode: ConfigPathMode,
  root?: string,
  options: HarnessConfigOptions = {},
): string {
  if (mode !== 'read' && mode !== 'write') {
    fail([`ERROR: modo invalido '${String(mode)}'; use read o write.`])
  }
  const cwd = options.cwd ?? process.cwd()
  const given =
    root !== undefined && root.length > 0
      ? root
      : (repoRoot(cwd) ??
        fail(['ERROR: no se pudo resolver la raiz del repositorio Git para harness.config.json.']))
  if (!isDirectory(resolve(cwd, given))) fail([`ERROR: la raiz de repositorio no existe: ${given}`])
  const base = realpathSync.native(resolve(cwd, given))
  const canonical = join(base, '.mefisto', 'harness.config.json')
  const legacy = join(base, '.claude', 'harness.config.json')

  if (mode === 'write') return canonical
  if (isFile(canonical)) {
    if (isFile(legacy)) {
      options.warn?.(
        `AVISO: se usara el config canonico ${canonical}; se ignora el legacy ${legacy}. Migra o elimina conscientemente el archivo legacy para evitar divergencias.`,
      )
    }
    return canonical
  }
  if (isFile(legacy)) return legacy
  fail([
    `ERROR: no se encontro el config canonico requerido ${canonical}.`,
    `  Se acepta solo para lectura el fallback legacy ${legacy}.`,
  ])
}

/** `null` si no es JSON; `root` queda `undefined` cuando el archivo no trae ningun valor. */
function readJson(path: string): { root: Json | undefined } | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  if (content.startsWith('\ufeff')) content = content.slice(1)
  if (/^[ \t\r\n]*$/.test(content)) return { root: undefined }
  try {
    return { root: JSON.parse(content) as Json }
  } catch {
    return null
  }
}

/** `.a.b[0]` de jq: `null` se propaga y un tipo que no admite el paso es error. */
function get(value: Json, ...path: (string | number)[]): Json {
  let current = value
  for (const step of path) {
    if (current === null) continue
    if (typeof step === 'number') {
      if (!Array.isArray(current)) throw new JqError()
      current = current[step] ?? null
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) throw new JqError()
      current = Object.hasOwn(current, step) ? (current[step] ?? null) : null
    }
  }
  return current
}

/** `value // fallback` de jq. */
function orElse(value: Json, fallback: Json): Json {
  return value === null || value === false ? fallback : value
}

/** `.[]` de jq. */
function items(value: Json): Json[] {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') return Object.values(value)
  throw new JqError()
}

/** `length` de jq; `null` donde bash no obtiene un entero. */
function count(value: Json): number | null {
  if (value === null) return 0
  if (typeof value === 'string') return [...value].length
  if (typeof value === 'number') return Number.isInteger(value) ? Math.abs(value) : null
  if (typeof value === 'boolean') return null
  return Array.isArray(value) ? value.length : Object.keys(value).length
}

/** Lo que imprime `jq -r` para un valor. */
function output(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** Sustitucion de comando de bash: sin saltos finales y vacia si `jq` falla. */
function substitution(read: () => string): string {
  try {
    return read().replace(/\n+$/, '')
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return ''
  }
}

/** `$(jq -r '<ruta> // ""')`. */
function text(root: Json, ...path: (string | number)[]): string {
  return substitution(() => {
    const value = orElse(get(root, ...path), '')
    return output(value)
  })
}

/** Elementos de `<ruta> // [] | join(" ")`, antes de unirlos. */
function list(root: Json, ...path: (string | number)[]): string[] {
  try {
    return items(orElse(get(root, ...path), [])).map((item) => {
      if (item === null) return ''
      if (typeof item === 'object') throw new JqError()
      return typeof item === 'string' ? item : JSON.stringify(item)
    })
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return []
  }
}

function has(root: Json, key: string): boolean {
  return root !== null && typeof root === 'object' && !Array.isArray(root) && Object.hasOwn(root, key)
}

/** `grep -Eq` recorre lineas: basta con que una cumpla. */
function anyLineMatches(value: string, pattern: RegExp): boolean {
  return value.split('\n').some((line) => pattern.test(line))
}

/** Carga y valida el config; sin `configPath` lo resuelve desde la raiz Git de `options.cwd`. */
export function loadHarnessConfig(configPath?: string, options: HarnessConfigOptions = {}): HarnessConfig {
  const config = configPath ?? resolveHarnessConfigPath('read', undefined, options)

  if (!isFile(config)) {
    fail([
      `ERROR: no se encontro ${config}`,
      '  El harness requiere .mefisto/harness.config.json en la raiz',
      '  del proyecto consumidor; .claude/harness.config.json solo se acepta',
      '  como fallback de lectura para consumidores legacy.',
      '  El archivo tiene la forma:',
      '    {',
      '      "projectName": "...",',
      '      "namespacePrefix": "...",',
      '      "solutionFile": "...",',
      '      "infraResourceGroupPrefix": "...",',
      '      "githubServicePrincipalName": "...",',
      '      "appInsightsApp": "...",',
      '      "domainLabels": ["...", "..."],',
      '      "boundedContext": { "name": "<NombreBC>", "domains": ["..."] }',
      '    }',
    ])
  }

  const parsed = readJson(config)
  if (parsed === null) fail([`ERROR: el JSON de ${config} no es parseable.`])
  const root = parsed.root ?? null

  const projectName = text(root, 'projectName')
  const namespacePrefix = text(root, 'namespacePrefix')
  const solutionFile = text(root, 'solutionFile')
  const tfstateStorage = text(root, 'terraformStateStorage')
  const domainLabels = list(root, 'domainLabels')
  const bcName = text(root, 'boundedContext', 'name')

  const missing = [
    ['projectName', projectName],
    ['namespacePrefix', namespacePrefix],
    ['solutionFile', solutionFile],
  ].flatMap(([field, value]) => (value === '' ? [field] : []))
  if (missing.length > 0) {
    fail([`ERROR: campos obligatorios ausentes en ${config}: ${missing.join(' ')}`])
  }

  if (!has(root, 'boundedContext')) {
    const exampleDomains = substitution(() =>
      items(orElse(get(root, 'domainLabels'), []))
        .map((label) => {
          if (label !== null && typeof label !== 'string') throw new JqError()
          return `"${label ?? ''}"`
        })
        .join(', '),
    )
    fail([
      `ERROR: falta 'boundedContext' en ${config} (campo obligatorio, MEF-ADR-0023).`,
      "  El campo 'boundedContext' es requerido por MEF-ADR-0023 (Bounded Context).",
      '  Anade el siguiente bloque a tu harness.config.json:',
      '    "boundedContext": {',
      '      "name": "<NombreDetuBC>",   // ej: Principal, Admin, Core',
      `      "domains": [${exampleDomains}]`,
      '    }',
      '  Los dominios deben ser un subconjunto de tus domainLabels existentes.',
      "  Ver /onboard para diagnostico o docs/migracion-y-versionado.md seccion 'Migracion para consumidores existentes'.",
    ])
  }

  if (bcName === '') {
    fail([
      `ERROR: boundedContext.name esta vacio en ${config}.`,
      '  Debe ser un string de 1-63 caracteres alfanumericos y guiones (ej: Principal).',
    ])
  }
  if (!anyLineMatches(bcName, /^[a-zA-Z0-9-]{1,63}$/)) {
    fail([
      `ERROR: boundedContext.name='${bcName}' no es valido en ${config}.`,
      '  Debe tener 1-63 caracteres alfanumericos y guiones ([a-zA-Z0-9-]).',
    ])
  }

  const declaredDomains = orElse(get(root, 'boundedContext', 'domains'), [])
  if (count(declaredDomains) === 0) {
    fail([
      `ERROR: boundedContext.domains esta vacio en ${config}.`,
      '  Debe contener al menos un dominio presente en domainLabels.',
    ])
  }

  const labelTokens = domainLabels.join(' ').split(/[ \n]/)
  let domainLines: string[] = []
  try {
    domainLines = items(declaredDomains).flatMap((domain) => output(domain).split('\n'))
  } catch (error) {
    if (!(error instanceof JqError)) throw error
  }
  const invalidDomains = domainLines.filter((domain) => domain !== '' && !labelTokens.includes(domain))
  if (invalidDomains.length > 0) {
    fail([
      'ERROR: boundedContext.domains contiene dominios no declarados en domainLabels:',
      ...invalidDomains.map((domain) => `  '${domain}' no esta en domainLabels`),
      '  Los dominios del BC deben ser un subconjunto de domainLabels.',
    ])
  }

  if (tfstateStorage !== '' && !anyLineMatches(tfstateStorage, /^[a-z0-9]{3,24}$/)) {
    fail([
      `ERROR: terraformStateStorage='${tfstateStorage}' no cumple las reglas de Azure Storage Account.`,
      '  Debe tener 3-24 caracteres, solo minusculas y digitos ([a-z0-9]).',
      '  Sugerencia: abrevia el prefijo del proyecto (ej. micontrolplane -> mcp -> stmcptfstatedev).',
    ])
  }

  let sbInternalSecret = ''
  const sbExternal: ServiceBusExternal[] = []
  if (has(root, 'serviceBus')) {
    sbInternalSecret = text(root, 'serviceBus', 'internal', 'secretName')
    if (sbInternalSecret === '') {
      fail([
        `ERROR: serviceBus.internal.secretName esta vacio o ausente en ${config} (MEF-ADR-0024).`,
        "  Si declaras 'serviceBus', el secreto de Key Vault de la cadena del ASB",
        '  propio del BC (alias reservado INTERNO) es obligatorio. Nunca la cadena',
        '  en claro (MEF-ADR-0024 decision #6). Anade:',
        '    "serviceBus": { "internal": { "secretName": "<nombre-secreto-kv>" } }',
      ])
    }

    const total = count(orElse(get(root, 'serviceBus', 'external'), [])) ?? 0
    const invalid: string[] = []
    for (let i = 0; i < total; i++) {
      const alias = text(root, 'serviceBus', 'external', i, 'alias')
      const alcance = text(root, 'serviceBus', 'external', i, 'alcance')
      const secretName = text(root, 'serviceBus', 'external', i, 'secretName')
      const upper = alias.toUpperCase()

      if (alias === '') {
        invalid.push(`entrada #${i}: 'alias' vacio o ausente`)
      } else if (upper === 'INTERNO') {
        invalid.push(`entrada #${i}: alias '${alias}' es el alias reservado INTERNO (ASB propio del BC)`)
      } else if (alcance !== 'compartido' && alcance !== 'externo') {
        invalid.push(
          `entrada #${i} (alias '${alias}'): alcance '${alcance}' invalido, debe ser 'compartido' o 'externo'`,
        )
      } else if (secretName === '') {
        invalid.push(`entrada #${i} (alias '${alias}'): 'secretName' vacio o ausente`)
      } else if (sbExternal.some((entry) => entry.alias.toUpperCase() === upper)) {
        invalid.push(`entrada #${i}: alias '${alias}' duplicado`)
      } else {
        sbExternal.push({ alias, alcance, secretName })
      }
    }

    if (invalid.length > 0) {
      fail([
        `ERROR: serviceBus.external mal formado en ${config} (MEF-ADR-0024):`,
        ...invalid.map((entry) => `  - ${entry}`),
        "  Cada entrada requiere: 'alias' no vacio y distinto de INTERNO (reservado),",
        "  'alcance' en {compartido, externo}, y 'secretName' no vacio (nombre del",
        '  secreto de Key Vault; nunca la cadena en claro).',
      ])
    }
  }

  const secrets: HarnessSecret[] = []
  if (has(root, 'secrets')) {
    const declared = get(root, 'secrets')
    if (!Array.isArray(declared)) fail([`ERROR: 'secrets' en ${config} debe ser un array (issue #256).`])

    const invalid: string[] = []
    for (let j = 0; j < declared.length; j++) {
      const name = text(declared, j, 'name')
      const type = text(declared, j, 'source', 'type')
      const value = text(declared, j, 'source', 'value')

      if (name === '') {
        invalid.push(`entrada #${j}: 'name' vacio o ausente`)
      } else if (type !== 'output' && type !== 'github-secret' && type !== 'composite') {
        invalid.push(
          `entrada #${j} (name '${name}'): source.type '${type}' invalido, debe ser 'output', 'github-secret' o 'composite'`,
        )
      } else if (value === '') {
        invalid.push(`entrada #${j} (name '${name}'): 'source.value' vacio o ausente`)
      } else if (secrets.some((entry) => entry.name === name)) {
        invalid.push(`entrada #${j}: name '${name}' duplicado`)
      } else {
        secrets.push({ name, type, value })
      }
    }

    if (invalid.length > 0) {
      fail([
        `ERROR: 'secrets' mal formado en ${config} (issue #256):`,
        ...invalid.map((entry) => `  - ${entry}`),
        "  Cada entrada requiere: 'name' no vacio y unico, y 'source.type' en",
        "  {output, github-secret, composite} con 'source.value' no vacio.",
      ])
    }
  }

  const resourceSequence = text(root, 'resourceSequence')
  return {
    configPath: config,
    projectName,
    namespacePrefix,
    solutionFile,
    rgPrefix: text(root, 'infraResourceGroupPrefix'),
    tfstateStorage,
    spName: text(root, 'githubServicePrincipalName'),
    appInsightsApp: text(root, 'appInsightsApp'),
    domainLabels,
    bcName,
    bcDomains: list(root, 'boundedContext', 'domains'),
    sbInternalSecret,
    sbExternal,
    secrets,
    projectionsEnabled: text(root, 'projections', 'enabled') === 'true',
    azureRegionShort: text(root, 'azureRegionShort'),
    resourceSequence: resourceSequence === '' ? '001' : resourceSequence,
  }
}

/** El config como variables `HARNESS_*`, para pasarlo a un proceso que las lee. */
export function harnessConfigEnv(config: HarnessConfig): Record<string, string> {
  return {
    HARNESS_CONFIG_PATH: config.configPath,
    HARNESS_PROJECT_NAME: config.projectName,
    HARNESS_NAMESPACE_PREFIX: config.namespacePrefix,
    HARNESS_SOLUTION_FILE: config.solutionFile,
    HARNESS_RG_PREFIX: config.rgPrefix,
    HARNESS_TFSTATE_STORAGE: config.tfstateStorage,
    HARNESS_SP_NAME: config.spName,
    HARNESS_APP_INSIGHTS_APP: config.appInsightsApp,
    HARNESS_DOMAIN_LABELS: config.domainLabels.join(' '),
    HARNESS_BC_NAME: config.bcName,
    HARNESS_BC_DOMAINS: config.bcDomains.join(' '),
    HARNESS_SB_INTERNAL_SECRET: config.sbInternalSecret,
    HARNESS_SB_EXTERNAL_ALIASES: config.sbExternal.map((entry) => entry.alias).join(' '),
    HARNESS_SB_EXTERNAL_ALCANCES: config.sbExternal.map((entry) => entry.alcance).join(' '),
    HARNESS_SB_EXTERNAL_SECRETS: config.sbExternal.map((entry) => entry.secretName).join(' '),
    HARNESS_SECRETS_NAMES: config.secrets.map((entry) => entry.name).join(' '),
    HARNESS_SECRETS_TYPES: config.secrets.map((entry) => entry.type).join(' '),
    HARNESS_SECRETS_VALUES: config.secrets.map((entry) => entry.value).join(' '),
    HARNESS_PROJECTIONS_ENABLED: config.projectionsEnabled ? 'true' : 'false',
    HARNESS_AZURE_REGION_SHORT: config.azureRegionShort,
    HARNESS_RESOURCE_SEQUENCE: config.resourceSequence,
  }
}

/** El config con la entrada `name` de `secrets[]` reemplazada, o agregada al final si no estaba. */
function withSecret(root: Json, name: string, type: string, value: string): Json {
  const entry: Json = { name, source: { type, value } }
  const existing = orElse(get(root, 'secrets'), [])
  const names = items(existing).map((item) => get(item, 'name'))
  let secrets: Json[]
  if (names.includes(name)) {
    secrets = items(existing).map((item) => (get(item, 'name') === name ? entry : item))
  } else if (Array.isArray(existing)) {
    secrets = [...existing, entry]
  } else {
    throw new JqError()
  }
  return root === null ? { secrets } : { ...(root as { [key: string]: Json }), secrets }
}

/**
 * Registra o actualiza por `name` una entrada de `secrets[]` y reemplaza el archivo de una vez.
 * Sin `configPath` escribe la canonica y se niega si solo existe la legacy; no valida `sourceType`.
 */
export function upsertHarnessSecret(
  name: string,
  sourceType: string,
  sourceValue: string,
  configPath?: string,
  options: HarnessConfigOptions = {},
): void {
  let config: string
  if (configPath !== undefined) {
    config = configPath
  } else {
    config = resolveHarnessConfigPath('write', undefined, options)
    const legacy = join(dirname(dirname(config)), '.claude', 'harness.config.json')
    if (!isFile(config) && isFile(legacy)) {
      fail([
        `ERROR: solo existe el config legacy ${legacy}; no se modificara.`,
        `  Migra conscientemente el archivo completo a ${config} antes de registrar secretos.`,
      ])
    }
  }

  if (!isFile(config)) fail([`ERROR: no se encontro ${config}`])

  const parsed = readJson(config)
  if (parsed === null) fail([`ERROR: el JSON de ${config} no es parseable; no se modifico el archivo.`])

  let content = ''
  if (parsed.root !== undefined) {
    try {
      content = `${JSON.stringify(withSecret(parsed.root, name, sourceType, sourceValue), null, 2)}\n`
    } catch (error) {
      if (!(error instanceof JqError)) throw error
      fail([`ERROR: jq fallo al actualizar 'secrets' en ${config}`])
    }
  }

  replaceFile(config, content)
}

/** Reemplaza `path` de una vez; queda en 0600, como el temporal de `mktemp` que bash movia encima. */
export function replaceFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  try {
    writeFileSync(temporary, content, { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
