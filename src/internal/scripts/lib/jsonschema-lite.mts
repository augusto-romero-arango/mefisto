// Subconjunto de JSON Schema que valida el contrato neutral de agentes y comandos
// (src/internal/contract/internal-artifact.schema.json).
//
// Gemela de `jsonschema-lite.jq`, que siguen usando test-mefisto-run-agent.sh y
// test-runtime-claude.sh.
//
// Palabras clave: type, required, properties, additionalProperties (solo `false`), enum, items,
// pattern, minLength y oneOf. oneOf solo en su forma de despacho por `kind`: cada rama declara
// `properties.kind.enum`, se elige la que contiene el `kind` de la instancia y se valida solo
// esa, para que los motivos nombren el campo y no un "0/N ramas coinciden".
//
// Devuelve los motivos como "<campo>: <motivo>"; el campo usa "." entre segmentos y la raiz es "".

import { isJsonObject, jqJson, jqRaw } from './jq-json.mts'
import type { Json, JsonObject } from './jq-json.mts'

function typeOf(value: Json): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function field(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

function equal(left: Json, right: Json): boolean {
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => equal(item, right[index] ?? null))
    )
  }
  if (isJsonObject(left)) {
    if (!isJsonObject(right)) return false
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key] ?? null, right[key] ?? null))
    )
  }
  return left === right
}

// `index` de jq: un array como aguja se busca como subsecuencia contigua; lo demas, como elemento.
function indexOf(list: Json | undefined, needle: Json): number | null {
  if (!Array.isArray(list)) return null
  const run = Array.isArray(needle) ? needle : [needle]
  if (run.length === 0) return null
  for (let start = 0; start + run.length <= list.length; start++) {
    if (run.every((item, offset) => equal(list[start + offset] ?? null, item))) return start
  }
  return null
}

function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(text)
  } catch {
    return new RegExp(pattern).test(text)
  }
}

function kindsOf(branch: Json): Json | undefined {
  if (!isJsonObject(branch) || !isJsonObject(branch.properties)) return undefined
  const kind = branch.properties.kind
  return isJsonObject(kind) ? kind.enum : undefined
}

export function validateSchema(schema: JsonObject, instance: Json, path = ''): string[] {
  const errors: string[] = []
  const type = typeOf(instance)
  const has = (key: string): boolean => Object.hasOwn(schema, key)

  if (has('type') && type !== schema.type) {
    errors.push(`${path}: tipo esperado ${jqRaw(schema.type ?? null)}, encontrado ${type}`)
  }
  if (has('enum') && indexOf(schema.enum, instance) === null) {
    errors.push(
      `${path}: valor ${jqJson(instance)} no esta en el vocabulario permitido ${jqJson(schema.enum ?? null)}`,
    )
  }
  if (has('minLength') && typeof instance === 'string' && typeof schema.minLength === 'number') {
    const length = [...instance].length
    if (length < schema.minLength) {
      errors.push(`${path}: longitud minima ${schema.minLength}, encontrado ${length}`)
    }
  }
  if (has('pattern') && typeof instance === 'string' && typeof schema.pattern === 'string') {
    if (!matches(schema.pattern, instance)) {
      errors.push(`${path}: '${instance}' no coincide con el patron ${schema.pattern}`)
    }
  }
  if (has('required') && isJsonObject(instance) && Array.isArray(schema.required)) {
    for (const required of schema.required) {
      if (typeof required === 'string' && !Object.hasOwn(instance, required)) {
        errors.push(`${field(path, required)}: campo requerido ausente`)
      }
    }
  }
  const properties = isJsonObject(schema.properties) ? schema.properties : {}
  if (schema.additionalProperties === false && isJsonObject(instance)) {
    for (const key of Object.keys(instance)) {
      if (!Object.hasOwn(properties, key)) {
        errors.push(`${field(path, key)}: propiedad adicional no permitida`)
      }
    }
  }
  if (has('properties') && isJsonObject(instance)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(instance, key) && isJsonObject(sub)) {
        errors.push(...validateSchema(sub, instance[key] ?? null, field(path, key)))
      }
    }
  }
  if (has('items') && Array.isArray(instance) && isJsonObject(schema.items)) {
    for (const [index, item] of instance.entries()) {
      errors.push(...validateSchema(schema.items, item, field(path, String(index))))
    }
  }
  if (has('oneOf')) {
    const branches = Array.isArray(schema.oneOf) ? schema.oneOf : []
    if (!isJsonObject(instance)) {
      errors.push(`${path === '' ? '(raiz)' : path}: se esperaba un objeto JSON, encontrado ${type}`)
    } else if (!Object.hasOwn(instance, 'kind')) {
      errors.push(`${field(path, 'kind')}: campo requerido ausente`)
    } else {
      const kind = instance.kind ?? null
      const branch = branches.find((candidate) => indexOf(kindsOf(candidate), kind) !== null)
      if (isJsonObject(branch)) errors.push(...validateSchema(branch, instance, path))
      else {
        errors.push(
          `${field(path, 'kind')}: valor ${jqJson(kind)} no coincide con ningun 'kind' declarado en oneOf`,
        )
      }
    }
  }
  return errors
}
