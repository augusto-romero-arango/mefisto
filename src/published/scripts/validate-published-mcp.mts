// Valida el registro MCP neutral publicado y su proyeccion Claude.
// Uso: validate-published-mcp.sh [--registry archivo] [--artifact-schema archivo] [--claude-config archivo]

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isEntryPoint } from '../../../scripts/lib/cli.mts'
import {
  JqError,
  dump,
  equals,
  get,
  isObject,
  iterate,
  parseStream,
  path,
  typeOf,
  unique,
} from '../../../scripts/lib/jq-values.mts'
import type { Json, JsonObject } from '../../../scripts/lib/jq-values.mts'
import { jqRegExp, validateSchema } from './lib/published-schema.mts'
import { isFile, parseSingleJson } from './lib/published-source.mts'

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const USAGE =
  'Uso: validate-published-mcp.sh [--registry archivo] [--artifact-schema archivo] [--claude-config archivo]'
const SENSITIVE_KEY = jqRegExp('^(headers?|environment|env|oauth|token|secret|credential)s?$', 'i')
const HTTPS = jqRegExp('^https://')

export interface McpValidation {
  status: number
  /** Lineas de stderr. */
  errors: string[]
}

/** `filter` sobre el registro; `null` donde jq abortaria. */
function attempt<T>(filter: () => T): T | null {
  try {
    return filter()
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return null
  }
}

function hasSensitiveKey(value: Json): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveKey)
  if (!isObject(value)) return false
  return (
    Object.keys(value).some((key) => SENSITIVE_KEY.test(key)) || Object.values(value).some(hasSensitiveKey)
  )
}

const servers = (registry: Json): Json[] => iterate(get(registry, 'servers'))

// Un servidor que no se puede leer deja el chequeo entero sin efecto.
function violates(registry: Json, provisioning: string, broken: (server: Json) => boolean): boolean {
  const found = attempt(() =>
    servers(registry).filter((server) => get(server, 'provisioning') === provisioning && broken(server)),
  )
  return found !== null && found.length > 0
}

function bundledBroken(server: Json): boolean {
  const url = get(server, 'url')
  return (
    get(server, 'transport') !== 'remote-http' ||
    typeof url !== 'string' ||
    !HTTPS.test(url) ||
    get(server, 'authentication') !== 'none'
  )
}

function externalBroken(server: Json): boolean {
  return ['transport', 'url', 'authentication'].some((key) => get(server, key) !== null)
}

/** `join(", ")` de jq sobre valores escalares. */
function joined(values: Json[]): string {
  return values
    .map((value) => (value === null ? '' : typeof value === 'string' ? value : dump(value)))
    .join(', ')
}

const without = (values: Json[], removed: Json[]): Json[] =>
  values.filter((value) => !removed.some((candidate) => equals(candidate, value)))

/** Errores de los enum `mcp` del schema; `artifact` ausente es un archivo sin exactamente un valor JSON. */
function artifactEnumErrors(artifactFile: string, artifact: Json | undefined, ids: Json[] | null): string[] {
  const errors: string[] = []
  for (const kind of ['agent', 'command']) {
    const matches = attempt(() => {
      if (artifact === undefined) throw new JqError('el schema no trae exactamente un valor JSON')
      const oneOf = get(artifact, 'oneOf')
      const variants = typeof oneOf === 'object' && oneOf !== null ? iterate(oneOf) : []
      return variants
        .filter((variant) => equals(path(variant, 'properties', 'kind', 'enum'), [kind]))
        .map((variant) => path(variant, 'properties', 'mcp', 'items', 'enum'))
    })
    const declared = matches?.[0]
    if (matches === null || matches.length !== 1 || declared === undefined) {
      errors.push(`${artifactFile}: se esperaba exactamente un enum mcp para ${kind}`)
      continue
    }
    if (!Array.isArray(declared)) {
      errors.push(`${artifactFile}: falta enum mcp para ${kind}`)
      continue
    }
    if (unique(declared).length !== declared.length) {
      errors.push(`${artifactFile}: enum mcp para ${kind} contiene ids duplicados`)
      continue
    }
    if (ids === null) continue
    const unknown = without(declared, ids)
    const missing = without(ids, declared)
    if (unknown.length > 0) {
      errors.push(`${artifactFile}: enum mcp para ${kind} contiene id desconocido: ${joined(unknown)}`)
    }
    if (missing.length > 0) {
      errors.push(`${artifactFile}: enum mcp para ${kind} omite id del registro: ${joined(missing)}`)
    }
    if (unknown.length === 0 && missing.length === 0 && dump(declared) !== dump(ids)) {
      errors.push(`${artifactFile}: enum mcp para ${kind} difiere en orden del registro MCP`)
    }
  }
  return errors
}

function claudeProjection(registry: Json): JsonObject {
  const mcpServers: JsonObject = {}
  for (const server of servers(registry)) {
    if (get(server, 'provisioning') !== 'bundled' || get(server, 'transport') !== 'remote-http') continue
    const id = get(server, 'id')
    if (typeof id !== 'string') throw new JqError(`Cannot use ${typeOf(id)} as object key`)
    mcpServers[id] = { type: 'http', url: get(server, 'url') }
  }
  return { mcpServers }
}

export interface McpPaths {
  registry: string
  registrySchema: string
  artifactSchema: string
  claudeConfig: string
}

export function defaultMcpPaths(repoRoot: string = REPO_ROOT): McpPaths {
  const contract = join(repoRoot, 'src', 'published', 'contract')
  return {
    registry: join(contract, 'mcp-servers.json'),
    registrySchema: join(contract, 'mcp-servers.schema.json'),
    artifactSchema: join(contract, 'published-artifact.schema.json'),
    claudeConfig: join(repoRoot, '.mcp.json'),
  }
}

export function validatePublishedMcp(paths: McpPaths): McpValidation {
  const fatal = (line: string): McpValidation => ({ status: 1, errors: [line] })
  for (const required of [paths.registry, paths.registrySchema, paths.artifactSchema, paths.claudeConfig]) {
    if (!isFile(required)) return fatal(`ERROR: no existe '${required}'`)
  }
  const registryJson = parseStream(readFileSync(paths.registry, 'utf8'))
  if (!registryJson.clean) return fatal(`${paths.registry}: JSON invalido`)
  const [registry] = registryJson.values
  if (registryJson.values.length !== 1 || registry === undefined) {
    return fatal(
      `${paths.registry}: schema: el validador jq fallo: jq: invalid JSON text passed to --argjson`,
    )
  }
  const schema = parseSingleJson(readFileSync(paths.registrySchema, 'utf8'))
  const errors: string[] = []
  try {
    const found = validateSchema(schema === null ? null : schema.value, registry)
    errors.push(...found.map((error) => `${paths.registry}: ${error}`))
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return fatal(
      `${paths.registry}: schema: el validador jq fallo: jq: error (at <unknown>): ${error.message}`,
    )
  }

  const ids = attempt(() => servers(registry).map((server) => get(server, 'id')))
  if (ids !== null) {
    const sorted = unique(ids)
    if (sorted.length !== ids.length) errors.push(`${paths.registry}: servers: ids duplicados no permitidos`)
    else if (dump(sorted) !== dump(ids)) {
      errors.push(`${paths.registry}: servers: ids fuera de orden; se exige orden lexicografico`)
    }
  }
  if (hasSensitiveKey(registry)) {
    errors.push(`${paths.registry}: contiene material o configuracion sensible no permitida`)
  }
  if (violates(registry, 'bundled', bundledBroken)) {
    errors.push(`${paths.registry}: bundled exige transport remote-http, URL HTTPS y authentication none`)
  }
  if (violates(registry, 'external', externalBroken)) {
    errors.push(`${paths.registry}: external exige transport, url y authentication nulos`)
  }

  const artifact = parseStream(readFileSync(paths.artifactSchema, 'utf8'))
  if (!artifact.clean) return { status: 1, errors: [...errors, `${paths.artifactSchema}: JSON invalido`] }
  const artifactSchema = artifact.values.length === 1 ? artifact.values[0] : undefined
  errors.push(...artifactEnumErrors(paths.artifactSchema, artifactSchema, ids))

  const claude = parseStream(readFileSync(paths.claudeConfig, 'utf8'))
  if (!claude.clean) return { status: 1, errors: [...errors, `${paths.claudeConfig}: JSON invalido`] }
  const [config] = claude.values
  const projection = attempt(() => claudeProjection(registry))
  if (
    claude.values.length !== 1 ||
    config === undefined ||
    projection === null ||
    !equals(config, projection)
  ) {
    errors.push(`${paths.claudeConfig}: difiere de la proyeccion Claude derivada del registro MCP`)
  }
  return { status: errors.length > 0 ? 1 : 0, errors }
}

const OPTIONS: Record<string, keyof McpPaths> = {
  '--registry': 'registry',
  '--artifact-schema': 'artifactSchema',
  '--claude-config': 'claudeConfig',
}

export function main(argv: string[], repoRoot: string = REPO_ROOT): McpValidation {
  const paths = defaultMcpPaths(repoRoot)
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index] ?? ''
    const target = Object.hasOwn(OPTIONS, option) ? OPTIONS[option] : undefined
    if (target === undefined) return { status: 2, errors: [USAGE] }
    const value = argv[index + 1]
    if (value === undefined) return { status: 2, errors: [`ERROR: falta el archivo para ${option}`] }
    paths[target] = value
  }
  return validatePublishedMcp(paths)
}

if (isEntryPoint(import.meta.url)) {
  const result = main(process.argv.slice(2))
  for (const line of result.errors) console.error(line)
  process.exitCode = result.status
}
