// Semantica de valores de jq 1.7 (orden total, `//`, suma, indexado y texto de numeros), para que
// un filtro portado de jq de el mismo resultado, incluido cuando falla por un tipo inesperado.

export type Json = null | boolean | number | string | Json[] | JsonObject
export interface JsonObject {
  [key: string]: Json
}

/** Fallo que en jq aborta el filtro entero. */
export class JqError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JqError'
  }
}

export type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object'

export function typeOf(value: Json): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value as JsonType
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `.key`: `null` sobre `null` o clave ausente; falla sobre lo que no es objeto. */
export function get(value: Json | undefined, key: string): Json {
  if (value === null || value === undefined) return null
  if (!isObject(value)) throw new JqError(`Cannot index ${typeOf(value)} with "${key}"`)
  return Object.hasOwn(value, key) ? (value[key] ?? null) : null
}

/** `.a.b.c` */
export function path(value: Json | undefined, ...keys: string[]): Json {
  let current: Json = value ?? null
  for (const key of keys) current = get(current, key)
  return current
}

/** `value // fallback` */
export function alt(value: Json, fallback: Json): Json {
  return value === null || value === false ? fallback : value
}

export function has(value: Json, key: string): boolean {
  if (!isObject(value)) throw new JqError(`Cannot check whether ${typeOf(value)} has a string key`)
  return Object.hasOwn(value, key)
}

/** `.[]` */
export function iterate(value: Json): Json[] {
  if (Array.isArray(value)) return value
  if (isObject(value)) return Object.values(value)
  throw new JqError(`Cannot iterate over ${typeOf(value)}`)
}

export interface Entry {
  key: string | number
  value: Json
}

export function toEntries(value: Json): Entry[] {
  if (Array.isArray(value)) return value.map((item, key) => ({ key, value: item }))
  if (isObject(value)) return Object.keys(value).map((key) => ({ key, value: value[key] ?? null }))
  throw new JqError(`${typeOf(value)} has no keys`)
}

export function length(value: Json): number {
  if (value === null) return 0
  if (typeof value === 'string') return [...value].length
  if (typeof value === 'number') return Math.abs(value)
  if (Array.isArray(value)) return value.length
  if (isObject(value)) return Object.keys(value).length
  throw new JqError('boolean has no length')
}

/** `.[from:to]`; las cadenas se cortan por caracter. */
export function slice(value: Json, from: number, to: number): Json {
  if (value === null) return null
  if (typeof value === 'string') return [...value].slice(from, to).join('')
  if (Array.isArray(value)) return value.slice(from, to)
  throw new JqError(`Cannot index ${typeOf(value)} with object`)
}

function rank(value: Json): number {
  if (value === null) return 0
  if (value === false) return 1
  if (value === true) return 2
  if (typeof value === 'number') return 3
  if (typeof value === 'string') return 4
  return Array.isArray(value) ? 5 : 6
}

const isSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdfff

// Por punto de codigo, no por unidad UTF-16: un caracter fuera del plano basico va despues de U+FFFF.
function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index++) {
    const [unitA, unitB] = [a.charCodeAt(index), b.charCodeAt(index)]
    if (unitA === unitB) continue
    const [astralA, astralB] = [isSurrogate(unitA), isSurrogate(unitB)]
    if (astralA !== astralB) return astralA ? 1 : -1
    return unitA < unitB ? -1 : 1
  }
  return a.length < b.length ? -1 : 1
}

function compareArrays(a: Json[], b: Json[]): number {
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index++) {
    const order = compare(a[index] ?? null, b[index] ?? null)
    if (order !== 0) return order
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/** Orden total de jq: null < false < true < numeros < cadenas < arreglos < objetos. */
export function compare(a: Json, b: Json): number {
  const [rankA, rankB] = [rank(a), rank(b)]
  if (rankA !== rankB) return rankA < rankB ? -1 : 1
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a)) return -1
    return a < b ? -1 : a === b ? 0 : 1
  }
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b)
  if (Array.isArray(a) && Array.isArray(b)) return compareArrays(a, b)
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a).sort(compareStrings)
    const keysB = Object.keys(b).sort(compareStrings)
    const byKeys = compareArrays(keysA, keysB)
    if (byKeys !== 0) return byKeys
    for (const key of keysA) {
      const order = compare(a[key] ?? null, b[key] ?? null)
      if (order !== 0) return order
    }
  }
  return 0
}

export function equals(a: Json, b: Json): boolean {
  return compare(a, b) === 0
}

/** `sort_by(f)`: estable. */
export function sortBy<T>(values: readonly T[], key: (value: T) => Json): T[] {
  return values
    .map((value) => ({ value, key: key(value) }))
    .sort((left, right) => compare(left.key, right.key))
    .map((item) => item.value)
}

/** `group_by(f)`: grupos en el orden de su clave, cada uno en el orden de entrada. */
export function groupBy<T>(values: readonly T[], key: (value: T) => Json): T[][] {
  const groups: { key: Json; items: T[] }[] = []
  for (const value of sortBy(values.map((item) => ({ item, key: key(item) })), (entry) => entry.key)) {
    const last = groups.at(-1)
    if (last !== undefined && compare(last.key, value.key) === 0) last.items.push(value.item)
    else groups.push({ key: value.key, items: [value.item] })
  }
  return groups.map((group) => group.items)
}

export function unique<T extends Json>(values: readonly T[]): T[] {
  return groupBy(values, (value) => value).flatMap((group) => group.slice(0, 1))
}

/** `a + b` */
export function add(a: Json, b: Json): Json {
  if (a === null) return b
  if (b === null) return a
  if (typeof a === 'number' && typeof b === 'number') return a + b
  if (typeof a === 'string' && typeof b === 'string') return a + b
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (isObject(a) && isObject(b)) return { ...a, ...b }
  throw new JqError(`${typeOf(a)} and ${typeOf(b)} cannot be added`)
}

/** `add`: `null` sobre una lista vacia. */
export function sum(values: readonly Json[]): Json {
  return values.reduce<Json>((total, value) => add(total, value), null)
}

function numbers(a: Json, b: Json, operation: string): [number, number] {
  if (typeof a === 'number' && typeof b === 'number') return [a, b]
  throw new JqError(`${typeOf(a)} and ${typeOf(b)} cannot be ${operation}`)
}

export function subtract(a: Json, b: Json): number {
  const [left, right] = numbers(a, b, 'subtracted')
  return left - right
}

export function divide(a: Json, b: Json): number {
  const [left, right] = numbers(a, b, 'divided')
  if (right === 0) throw new JqError('cannot be divided because the divisor is zero')
  return left / right
}

export function negate(value: Json): number {
  if (typeof value !== 'number') throw new JqError(`${typeOf(value)} cannot be negated`)
  return -value
}

const NUMBER_TEXT = /^[ \t\n\v\f\r]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[ \t\n\v\f\r]*$/

/** `tonumber` sobre una cadena. */
export function toNumber(text: string): number {
  if (NUMBER_TEXT.test(text)) return Number(text)
  const word = text.trim().toLowerCase()
  if (/^[+-]?nan$/.test(word)) return NaN
  if (/^[+-]?inf(inity)?$/.test(word)) return word.startsWith('-') ? -Number.MAX_VALUE : Number.MAX_VALUE
  throw new JqError(`Cannot use ${text} as a number`)
}

/** Texto con que jq imprime un numero calculado. */
export function numberText(value: number): string {
  if (Number.isNaN(value)) return 'null'
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  const finite = Number.isFinite(value) ? value : Math.sign(value) * Number.MAX_VALUE
  const [mantissa = '', exponent = '0'] = Math.abs(finite).toExponential().split('e')
  const digits = mantissa.replace('.', '')
  const point = Number(exponent) + 1
  const sign = finite < 0 ? '-' : ''
  if (point <= -4 || point > digits.length + 15) {
    const head = digits.length > 1 ? `${digits.slice(0, 1)}.${digits.slice(1)}` : digits
    const power = point - 1
    return `${sign}${head}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`
  }
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

// jq escapa ademas el caracter DEL.
const quote = (text: string): string => JSON.stringify(text).replaceAll('\u007f', '\\u007f')

/** JSON como lo imprime jq: compacto con `indent` 0, o con esa sangria por nivel. */
export function dump(value: Json, indent = 0, depth = 0): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return numberText(value)
  if (typeof value === 'string') return quote(value)
  const items = Array.isArray(value)
    ? value.map((item) => dump(item, indent, depth + 1))
    : Object.keys(value).map(
        (key) => `${quote(key)}:${indent > 0 ? ' ' : ''}${dump(value[key] ?? null, indent, depth + 1)}`,
      )
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (items.length === 0) return open + close
  if (indent === 0) return open + items.join(',') + close
  const inner = ' '.repeat(indent * (depth + 1))
  return `${open}\n${items.map((item) => inner + item).join(',\n')}\n${' '.repeat(indent * depth)}${close}`
}

/** `tostring` */
export function toText(value: Json): string {
  return typeof value === 'string' ? value : dump(value)
}

const JSON_SPACE = new Set([' ', '\t', '\n', '\r'])
const JSON_DELIMITER = new Set([...JSON_SPACE, '[', ']', '{', '}', ',', ':', '"'])

function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') index++
    else if (char === '"') return index + 1
  }
  return -1
}

function valueEnd(text: string, start: number): number {
  const first = text[start]
  if (first === '"') return stringEnd(text, start)
  if (first !== '{' && first !== '[') {
    let index = start
    while (index < text.length && !JSON_DELIMITER.has(text[index] ?? '')) index++
    return index === start ? -1 : index
  }
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      const end = stringEnd(text, index)
      if (end === -1) return -1
      index = end - 1
    } else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return -1
}

export interface ParsedStream {
  values: Json[]
  /** `false` si el texto se corto en un valor invalido. */
  clean: boolean
}

/** Los valores JSON concatenados en `text`, hasta el primero invalido (como lee jq una entrada). */
export function parseStream(text: string): ParsedStream {
  const values: Json[] = []
  let position = text.startsWith('﻿') ? 1 : 0
  for (;;) {
    while (position < text.length && JSON_SPACE.has(text[position] ?? '')) position++
    if (position >= text.length) return { values, clean: true }
    const end = valueEnd(text, position)
    if (end === -1) return { values, clean: false }
    try {
      values.push(JSON.parse(text.slice(position, end)) as Json)
    } catch {
      return { values, clean: false }
    }
    position = end
  }
}
