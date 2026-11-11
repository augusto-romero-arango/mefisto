// Subconjunto autocontenido de JSON Schema para el contrato publicado. Sigue la semantica de jq
// (igualdad, `index`, `$` de las expresiones regulares) con que estan escritos los schemas.

import {
  JqError,
  alt,
  compare,
  dump,
  equals,
  isObject,
  iterate,
  length,
  path as jqPath,
  sortBy,
  toText,
  typeOf,
  unique,
} from '../../../../scripts/lib/jq-values.mts'
import type { Json, JsonObject } from '../../../../scripts/lib/jq-values.mts'

/**
 * RegExp con la lectura de `$` que hace jq (Oniguruma): el fin del texto o justo antes de su
 * salto final.
 */
export function jqRegExp(pattern: string, flags = ''): RegExp {
  let source = ''
  let inClass = false
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? ''
    if (char === '\\') {
      source += char + (pattern[index + 1] ?? '')
      index++
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    source += char === '$' && !inClass ? '(?=\\n?$)' : char
  }
  return new RegExp(source, flags)
}

/** `index(needle)` de jq sobre un arreglo: el elemento, o la subsecuencia si `needle` es un arreglo. */
export function indexOf(values: Json, needle: Json): number | null {
  if (!Array.isArray(values)) {
    throw new JqError(`Cannot determine index of ${typeOf(needle)} in ${typeOf(values)}`)
  }
  if (!Array.isArray(needle)) {
    const found = values.findIndex((value) => equals(value, needle))
    return found === -1 ? null : found
  }
  if (needle.length === 0) return null
  for (let start = 0; start + needle.length <= values.length; start++) {
    if (needle.every((item, offset) => equals(values[start + offset] ?? null, item))) return start
  }
  return null
}

/** `keys` de jq: claves ordenadas de un objeto, indices de un arreglo. */
export function keysOf(value: Json): Json[] {
  if (Array.isArray(value)) return value.map((_, index) => index)
  if (isObject(value)) return sortBy(Object.keys(value), (key) => key)
  throw new JqError(`${typeOf(value)} has no keys`)
}

function objectHas(value: Json, key: Json): boolean {
  if (!isObject(value) || typeof key !== 'string') {
    throw new JqError(`Cannot check whether ${typeOf(value)} has a ${typeOf(key)} key`)
  }
  return Object.hasOwn(value, key)
}

const prefixed = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`)

function validateOneOf(schema: JsonObject, instance: Json, path: string): string[] {
  if (!isObject(instance)) {
    return [`${path === '' ? '(raiz)' : path}: se esperaba un objeto JSON, encontrado ${typeOf(instance)}`]
  }
  if (!Object.hasOwn(instance, 'kind')) return [`${prefixed(path, 'kind')}: campo requerido ausente`]
  const kind = instance.kind ?? null
  const matches = iterate(schema.oneOf ?? null).filter(
    (candidate) => indexOf(alt(jqPath(candidate, 'properties', 'kind', 'enum'), []), kind) !== null,
  )
  const [first] = matches
  if (first === undefined) {
    return [`${prefixed(path, 'kind')}: valor ${dump(kind)} no coincide con ningun 'kind' declarado en oneOf`]
  }
  return validateSchema(first, instance, path)
}

/** Errores de `instance` contra `schema`; lanza `JqError` donde el programa jq abortaba. */
export function validateSchema(schema: Json, instance: Json, path = ''): string[] {
  if (!isObject(schema)) throw new JqError(`Cannot check whether ${typeOf(schema)} has a string key`)
  const has = (key: string): boolean => Object.hasOwn(schema, key)
  const field = (key: string): Json => schema[key] ?? null
  const kind = typeOf(instance)
  const errors: string[] = []

  if (has('type')) {
    const expected = field('type')
    const mismatch = Array.isArray(expected) ? indexOf(expected, kind) === null : !equals(expected, kind)
    if (mismatch) errors.push(`${path}: tipo esperado ${dump(expected)}, encontrado ${kind}`)
  }
  if (has('enum') && indexOf(field('enum'), instance) === null) {
    errors.push(`${path}: valor ${dump(instance)} no esta en el vocabulario permitido ${dump(field('enum'))}`)
  }
  if (has('minLength') && typeof instance === 'string' && compare(length(instance), field('minLength')) < 0) {
    errors.push(`${path}: longitud minima ${toText(field('minLength'))}, encontrado ${length(instance)}`)
  }
  if (has('minItems') && Array.isArray(instance) && compare(instance.length, field('minItems')) < 0) {
    errors.push(
      `${path}: cantidad minima de elementos ${toText(field('minItems'))}, encontrados ${instance.length}`,
    )
  }
  if (has('pattern') && typeof instance === 'string') {
    const pattern = field('pattern')
    if (typeof pattern !== 'string') {
      throw new JqError(`${typeOf(pattern)} cannot be matched, as it is not a string`)
    }
    if (!jqRegExp(pattern).test(instance)) {
      errors.push(`${path}: '${instance}' no coincide con el patron ${pattern}`)
    }
  }
  if (has('required') && isObject(instance)) {
    for (const required of iterate(field('required'))) {
      if (!objectHas(instance, required)) {
        errors.push(`${prefixed(path, toText(required))}: campo requerido ausente`)
      }
    }
  }
  if (has('additionalProperties') && field('additionalProperties') === false && isObject(instance)) {
    const properties = alt(field('properties'), {})
    for (const key of Object.keys(instance)) {
      if (!objectHas(properties, key)) errors.push(`${prefixed(path, key)}: propiedad adicional no permitida`)
    }
  }
  if (has('properties') && isObject(instance)) {
    const properties = field('properties')
    if (!isObject(properties)) throw new JqError(`${typeOf(properties)} has no keys`)
    for (const key of Object.keys(properties)) {
      if (Object.hasOwn(instance, key)) {
        errors.push(...validateSchema(properties[key] ?? null, instance[key] ?? null, prefixed(path, key)))
      }
    }
  }
  if (has('items') && Array.isArray(instance)) {
    instance.forEach((item, index) => {
      errors.push(...validateSchema(field('items'), item, prefixed(path, String(index))))
    })
  }
  const uniqueItems = alt(field('uniqueItems'), false)
  if (uniqueItems !== false && Array.isArray(instance) && unique(instance).length !== instance.length) {
    errors.push(`${path}: elementos duplicados no permitidos`)
  }
  if (has('oneOf')) errors.push(...validateOneOf(schema, instance, path))
  return errors
}
