// Lecturas y escrituras de JSON que los bloques de bash de comandos y agentes hacian con `jq`
// (MEF-ADR-0057, decision 9). Cada funcion nombra el filtro de jq cuyo resultado reproduce.

import { JqError, numberText } from './jq-values.mts'
import {
  dumpJq,
  firstTruthy,
  get,
  isJqObject,
  isNumber,
  iterate,
  numberOf,
  typeOf,
} from './jq-literals.mts'
import type { JqObject, JqValue } from './jq-literals.mts'

export type Step = string | number

/** Ruta mal escrita: es un error de uso, no de los datos. */
export class PathError extends Error {}

const SEGMENT = /^([^.[\]]*)((?:\[-?\d+\])*)$/

/** Pasos de `a.b[0].c`; `.` es la raiz y el punto inicial es opcional. */
export function parsePath(text: string): Step[] {
  if (text === '.') return []
  const body = text.startsWith('.') ? text.slice(1) : text
  if (body === '') throw new PathError(`ruta vacia: '${text}'`)
  const steps: Step[] = []
  for (const [position, segment] of body.split('.').entries()) {
    const match = SEGMENT.exec(segment)
    const [, key = '', indexes = ''] = match ?? []
    if (match === null || (key === '' && (indexes === '' || position > 0))) {
      throw new PathError(`ruta invalida: '${text}'`)
    }
    if (key !== '') steps.push(key)
    for (const index of indexes.matchAll(/-?\d+/g)) steps.push(Number(index[0]))
  }
  return steps
}

/** `.a.b[0]`: `null` se propaga; un tipo que no admite el paso es error. */
export function valueAt(root: JqValue, steps: readonly Step[]): JqValue {
  let current = root
  for (const step of steps) {
    if (typeof step === 'string') {
      current = get(current, step)
    } else if (current !== null) {
      if (!Array.isArray(current)) throw new JqError(`Cannot index ${typeOf(current)} with number`)
      current = current.at(step) ?? null
    }
  }
  return current
}

/** Texto con que `jq -r` imprime un valor: la cadena tal cual; el resto, JSON con sangria de 2. */
export function rawText(value: JqValue): string {
  return typeof value === 'string' ? value : dumpJq(value, 2)
}

/**
 * Que imprime `get` cuando el valor es `null` o `false`: `raw` lo imprime (`.a`), `empty` no
 * imprime nada (`.a // empty`) y un texto lo sustituye (`.a // "texto"`).
 */
export type Fallback = { kind: 'raw' } | { kind: 'empty' } | { kind: 'text'; text: string }

/** Lineas de `jq -r '.ruta'`, `'.ruta // empty'` o `'.ruta // "texto"'`. */
export function getLines(root: JqValue, steps: readonly Step[], fallback: Fallback): string[] {
  const value = valueAt(root, steps)
  if (fallback.kind === 'raw' || (value !== null && value !== false)) return [rawText(value)]
  return fallback.kind === 'empty' ? [] : [fallback.text]
}

export interface FieldEquals {
  field: string
  value: string
}

export interface EachOptions {
  /** `(.ruta // [])[]` en vez de `.ruta[]`. */
  orEmpty?: boolean
  /** `select(.campo == "valor")` por cada condicion. */
  where?: readonly FieldEquals[]
  /** `.campo` de cada elemento, en vez del elemento. */
  field?: string
  /** Solo los ultimos `last` elementos (`.[-n:]`). */
  last?: number
}

function container(root: JqValue, steps: readonly Step[], orEmpty: boolean): JqValue {
  const value = valueAt(root, steps)
  return orEmpty ? firstTruthy(() => value, () => []) : value
}

/** Elementos de `.ruta[]` tras filtrar por `where`, proyectar `field` y recortar a `last`. */
export function eachValues(root: JqValue, steps: readonly Step[], options: EachOptions = {}): JqValue[] {
  let items = iterate(container(root, steps, options.orEmpty ?? false))
  for (const { field, value } of options.where ?? []) {
    items = items.filter((item) => get(item, field) === value)
  }
  const values = items.map((item) => (options.field === undefined ? item : get(item, options.field)))
  return options.last === undefined || options.last >= values.length ? values : values.slice(values.length - options.last)
}

/** `join(sep)` de jq: `null` es vacio, numeros y booleanos van como texto, lo demas falla. */
export function joinValues(values: readonly JqValue[], separator: string): string {
  return values
    .map((value) => {
      if (value === null) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'boolean' || isNumber(value)) return dumpJq(value)
      throw new JqError(`Cannot join with ${typeOf(value)}`)
    })
    .join(separator)
}

/** Texto de `.ruta // [] | length`. */
export function lengthText(root: JqValue, steps: readonly Step[]): string {
  const value = container(root, steps, true)
  if (typeof value === 'string') return String([...value].length)
  if (isNumber(value)) return numberText(Math.abs(numberOf(value)))
  if (Array.isArray(value)) return String(value.length)
  if (isJqObject(value)) return String(Object.keys(value).length)
  throw new JqError('boolean has no length')
}

/** `{a, b}`: el objeto con esas claves de la raiz, `null` donde falten. */
export function pick(root: JqValue, keys: readonly string[]): JqObject {
  const picked: JqObject = {}
  for (const key of keys) define(picked, key, get(root, key))
  return picked
}

// Una asignacion a `__proto__` cambiaria el prototipo en vez de crear la clave.
function define(object: JqObject, key: string, value: JqValue): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
}

function withKey(object: JqObject | null, key: string, value: JqValue): JqObject {
  const copy: JqObject = {}
  for (const [existing, item] of Object.entries(object ?? {})) define(copy, existing, item)
  define(copy, key, value)
  return copy
}

/**
 * `.a = $texto` y, con mas claves, `.a = ((.a // {}) + {b: $texto})` a cualquier profundidad: el
 * resto del documento y el orden de sus claves se conservan.
 */
export function setText(root: JqValue, keys: readonly string[], text: string): JqObject {
  const [key, ...rest] = keys
  if (key === undefined) throw new PathError('la ruta de escritura no puede ser la raiz')
  if (root !== null && !isJqObject(root)) throw new JqError(`Cannot index ${typeOf(root)} with "${key}"`)
  if (rest.length === 0) return withKey(root, key, text)
  const child = firstTruthy(() => get(root, key), () => ({}))
  if (!isJqObject(child)) throw new JqError(`${typeOf(child)} and object cannot be added`)
  return withKey(root, key, setText(child, rest, text))
}

/** Documento como lo escribe `jq .`: sangria de 2 y salto final. */
export function documentText(value: JqValue): string {
  return `${dumpJq(value, 2)}\n`
}

/** `jq -R . | jq -s -c .`: cada linea de `text` como cadena de un arreglo compacto. */
export function linesToArray(text: string): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return dumpJq(lines)
}

/** `true` si `text` es exactamente un documento JSON (lo que acepta `python3 -m json.tool`). */
export function isJsonDocument(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
