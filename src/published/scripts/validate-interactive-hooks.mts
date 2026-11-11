// Valida el contrato neutral de hooks interactivos publicados.
// Uso: validate-interactive-hooks.sh [contrato.json]

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isEntryPoint } from '../../../scripts/lib/cli.mts'
import {
  JqError,
  equals,
  get,
  isObject,
  iterate,
  length,
  parseStream,
  path,
  sortBy,
  typeOf,
  unique,
} from '../../../scripts/lib/jq-values.mts'
import type { Json, JsonObject } from '../../../scripts/lib/jq-values.mts'
import { indexOf, jqRegExp, keysOf } from './lib/published-schema.mts'
import { isFile } from './lib/published-source.mts'

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const ID = jqRegExp('^[a-z0-9]+(-[a-z0-9]+)*$')
const SENSITIVE_FIELD = jqRegExp(
  '(^|[-_])(prompt|command|token|cookie|header|credential|authorization|password|secret|api[-_]?key|auth[-_]?store)([-_]|$)',
  'i',
)
const RUNTIME_REFERENCE = jqRegExp(
  'CLAUDE_[A-Z_]+|\\.claude(/|$)|SessionStart|PostToolUse|ExitPlanMode|Write\\|Edit|tool\\.execute\\.(before|after)|session\\.(created|idle)|(^|[^a-z])(claude|javascript|typescript|cache)([^a-z]|$)',
  'i',
)

export interface HooksValidation {
  status: number
  /** Lineas de stderr. */
  errors: string[]
}

const sorted = (values: Json[]): Json[] => sortBy(values, (value) => value)
const keysAre = (value: Json, expected: string[]): boolean => equals(sorted(keysOf(value)), sorted(expected))

/** `.[n]` de jq. */
function at(value: Json, index: number): Json {
  if (value === null) return null
  if (!Array.isArray(value)) throw new JqError(`Cannot index ${typeOf(value)} with number`)
  return value[index] ?? null
}

/** `.[]?`: nada sobre lo que no se puede recorrer. */
function each(value: Json): Json[] {
  return typeof value === 'object' && value !== null ? iterate(value) : []
}

function strings(value: Json): string[] {
  if (typeof value === 'string') return [value]
  return typeof value === 'object' && value !== null ? iterate(value).flatMap(strings) : []
}

function matches(pattern: RegExp, value: Json): boolean {
  if (typeof value !== 'string') {
    throw new JqError(`${typeOf(value)} cannot be matched, as it is not a string`)
  }
  return pattern.test(value)
}

interface Specification {
  spec: Json
  binding: Json
  /** Contrato de cada binding, por id. */
  contracts: JsonObject
  delivery: JsonObject
}

function readSpecification(spec: Json): Specification {
  const binding = path(spec, '$defs', 'binding')
  const contracts: JsonObject = {}
  for (const variant of iterate(
    get(at(path(spec, 'properties', 'bindings', 'items', 'allOf'), 1), 'oneOf'),
  )) {
    const id = path(variant, 'properties', 'id', 'const')
    if (typeof id !== 'string') throw new JqError(`Cannot use ${typeOf(id)} as object key`)
    contracts[id] = {
      signal: path(variant, 'properties', 'signal', 'const'),
      action: path(variant, 'properties', 'action', 'const'),
      destinations: path(variant, 'properties', 'destinations', 'const'),
      fields: path(variant, 'properties', 'persistedFields', 'const'),
    }
  }
  const delivery = path(binding, 'properties', 'delivery', 'properties')
  return {
    spec,
    binding,
    contracts,
    delivery: {
      mode: path(delivery, 'mode', 'const'),
      failure: path(delivery, 'failure', 'const'),
      timeoutSeconds: null,
    },
  }
}

function rootError(contract: Json, { spec }: Specification): string | null {
  if (!isObject(contract)) return 'raiz: debe ser objeto'
  if (!keysAre(contract, ['$schema', 'contractVersion', 'bindings'])) {
    return 'raiz: propiedad adicional o faltante'
  }
  if (!equals(get(contract, '$schema'), path(spec, 'properties', '$schema', 'const'))) {
    return '$schema: valor desconocido'
  }
  if (!equals(get(contract, 'contractVersion'), path(spec, 'properties', 'contractVersion', 'const'))) {
    return 'contractVersion: valor desconocido'
  }
  const bindings = get(contract, 'bindings')
  const expected = path(spec, 'properties', 'bindings', 'minItems')
  if (!Array.isArray(bindings) || !equals(bindings.length, expected)) {
    return 'bindings: se esperaban exactamente siete bindings'
  }
  return null
}

function bindingError(binding: Json, specification: Specification): string | null {
  if (!isObject(binding)) return 'binding: debe ser objeto'
  const properties = path(specification.binding, 'properties')
  const allowed = (key: string, ...enumPath: string[]): Json => path(properties, key, ...enumPath)
  if (!keysAre(binding, ['id', 'signal', 'action', 'destinations', 'persistedFields', 'delivery'])) {
    return 'binding: propiedad adicional o faltante'
  }
  const id = get(binding, 'id')
  if (typeof id !== 'string' || !ID.test(id)) return 'binding: id invalido'
  const label = `binding ${id}`
  if (indexOf(allowed('signal', 'enum'), get(binding, 'signal')) === null) {
    return `${label}: signal desconocida`
  }
  if (indexOf(allowed('action', 'enum'), get(binding, 'action')) === null) {
    return `${label}: accion desconocida`
  }
  const destinations = get(binding, 'destinations')
  if (
    !Array.isArray(destinations) ||
    destinations.length === 0 ||
    destinations.some(
      (destination) => indexOf(allowed('destinations', 'items', 'enum'), destination) === null,
    )
  ) {
    return `${label}: destino desconocido`
  }
  if (unique(destinations).length !== destinations.length) return `${label}: destinos duplicados`
  const fields = get(binding, 'persistedFields')
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string')) {
    return `${label}: campo persistible desconocido`
  }
  if (fields.some((field) => matches(SENSITIVE_FIELD, field))) return `${label}: campo persistible sensible`
  const delivery = get(binding, 'delivery')
  if (
    !isObject(delivery) ||
    !keysAre(delivery, ['mode', 'failure', 'timeoutSeconds']) ||
    !equals(delivery, specification.delivery)
  ) {
    return `${label}: delivery divergente`
  }
  const expected = get(specification.contracts, id)
  if (expected === null) return `${label}: accion sin contrato`
  if (
    !equals(get(binding, 'signal'), get(expected, 'signal')) ||
    !equals(get(binding, 'action'), get(expected, 'action'))
  ) {
    return `${label}: par signal/action desconocido`
  }
  if (id === 'record-active-release' && indexOf(destinations, 'canonical-state') === null) {
    return 'binding record-active-release: falta el destino canonico obligatorio'
  }
  if (!equals(destinations, get(expected, 'destinations'))) {
    return `${label}: destinos no coinciden con su contrato`
  }
  if (!equals(fields, get(expected, 'fields'))) return `${label}: allowlist de campos persistibles divergente`
  return null
}

/** Errores del contrato contra su schema; lanza `JqError` donde el filtro jq abortaba. */
export function contractErrors(contract: Json, spec: Json): string[] {
  const specification = readSpecification(spec)
  const errors: string[] = []
  const push = (error: string | null): void => {
    if (error !== null) errors.push(error)
  }
  push(rootError(contract, specification))
  const bindings = get(contract, 'bindings')
  for (const binding of each(bindings)) push(bindingError(binding, specification))
  if (unique(iterate(bindings).map((binding) => get(binding, 'id'))).length !== length(bindings)) {
    errors.push('bindings: id duplicado')
  }
  const declared = each(bindings).map((binding) => get(binding, 'id'))
  if (!equals(sorted(declared), sorted(keysOf(specification.contracts)))) {
    errors.push('bindings: falta un binding requerido o existe uno sin contrato')
  }
  for (const reference of unique(strings(contract).filter((text) => RUNTIME_REFERENCE.test(text)))) {
    errors.push(`contrato: referencia a runtime: ${reference}`)
  }
  return errors
}

export function validateInteractiveHooks(
  args: readonly string[],
  repoRoot: string = REPO_ROOT,
): HooksValidation {
  const fatal = (line: string): HooksValidation => ({ status: 1, errors: [line] })
  const hooksDir = join(repoRoot, 'src', 'published', 'hooks')
  const schemaFile = join(hooksDir, 'interactive-hooks.schema.json')
  if (!isFile(schemaFile)) return fatal(`ERROR: falta schema: ${schemaFile}`)
  const spec = parseStream(readFileSync(schemaFile, 'utf8'))
  if (!spec.clean) return fatal('ERROR: schema JSON invalido')
  if (args.length > 1) return fatal('Uso: validate-interactive-hooks.sh [contrato.json]')
  const [explicit] = args
  const contractFile =
    explicit === undefined || explicit === '' ? join(hooksDir, 'interactive-hooks.json') : explicit
  if (!isFile(contractFile)) return fatal(`${contractFile}: archivo no existe`)
  // Como jq, evalua cada valor JSON del archivo: uno vacio no trae ninguno y pasa sin errores.
  const contracts = parseStream(readFileSync(contractFile, 'utf8'))
  if (!contracts.clean) return fatal(`${contractFile}: JSON invalido`)
  try {
    const errors = contracts.values.flatMap((contract) => contractErrors(contract, spec.values[0] ?? null))
    return { status: errors.length > 0 ? 1 : 0, errors }
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return fatal(`${contractFile}: no se pudo evaluar el contrato`)
  }
}

if (isEntryPoint(import.meta.url)) {
  const result = validateInteractiveHooks(process.argv.slice(2))
  for (const line of result.errors) console.error(line)
  process.exitCode = result.status
}
