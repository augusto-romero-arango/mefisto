// Valores JSON como los lee jq 1.7: un numero que el filtro copia sin recalcular se imprime con el
// literal que traia (`1.0`, `0.10`, `5E-7`), no con el texto de su double. Complementa a
// `jq-values.mts`, que trata todo numero como calculado.

import { JqError, compare as comparePlain, dump as dumpPlain, numberText } from './jq-values.mts'
import type { Json, JsonType } from './jq-values.mts'

/** Numero leido de un texto JSON; `text` es el literal en la forma canonica con que jq lo imprime. */
export class NumberLiteral {
  readonly value: number
  readonly text: string

  constructor(value: number, text: string) {
    this.value = value
    this.text = text
  }
}

export type JqValue = null | boolean | number | string | NumberLiteral | JqValue[] | JqObject
export interface JqObject {
  [key: string]: JqValue
}

export function isJqObject(value: JqValue | undefined): value is JqObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof NumberLiteral)
}

export function isNumber(value: JqValue): value is number | NumberLiteral {
  return typeof value === 'number' || value instanceof NumberLiteral
}

export function numberOf(value: number | NumberLiteral): number {
  return typeof value === 'number' ? value : value.value
}

export function typeOf(value: JqValue): JsonType {
  if (value === null) return 'null'
  if (isNumber(value)) return 'number'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value as JsonType
}

/** El mismo valor con sus numeros como doubles, para las operaciones de `jq-values.mts`. */
export function plain(value: JqValue): Json {
  if (value instanceof NumberLiteral) return value.value
  if (Array.isArray(value)) return value.map(plain)
  if (isJqObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}

export function compare(a: JqValue, b: JqValue): number {
  return comparePlain(plain(a), plain(b))
}

export function equals(a: JqValue, b: JqValue): boolean {
  return compare(a, b) === 0
}

/** `.key`: `null` sobre `null` o clave ausente; falla sobre lo que no es objeto. */
export function get(value: JqValue | undefined, key: string): JqValue {
  if (value === null || value === undefined) return null
  if (!isJqObject(value)) throw new JqError(`Cannot index ${typeOf(value)} with "${key}"`)
  return Object.hasOwn(value, key) ? (value[key] ?? null) : null
}

/** `.a.b.c` */
export function path(value: JqValue | undefined, ...keys: string[]): JqValue {
  let current: JqValue = value ?? null
  for (const key of keys) current = get(current, key)
  return current
}

/** `a // b // c`: el primer valor que no es `null` ni `false`; si no hay, el del ultimo. Cada operando solo se evalua si hace falta. */
export function firstTruthy(...operands: (() => JqValue)[]): JqValue {
  let value: JqValue = null
  for (const operand of operands) {
    value = operand()
    if (value !== null && value !== false) return value
  }
  return value
}

/** `.[]` */
export function iterate(value: JqValue): JqValue[] {
  if (Array.isArray(value)) return value
  if (isJqObject(value)) return Object.values(value)
  throw new JqError(`Cannot iterate over ${typeOf(value)}`)
}

/** `a + b` */
export function add(a: JqValue, b: JqValue): JqValue {
  if (a === null) return b
  if (b === null) return a
  if (isNumber(a) && isNumber(b)) return numberOf(a) + numberOf(b)
  if (typeof a === 'string' && typeof b === 'string') return a + b
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (isJqObject(a) && isJqObject(b)) return { ...a, ...b }
  throw new JqError(`${typeOf(a)} and ${typeOf(b)} cannot be added`)
}

export function subtract(a: JqValue, b: JqValue): number {
  if (isNumber(a) && isNumber(b)) return numberOf(a) - numberOf(b)
  throw new JqError(`${typeOf(a)} and ${typeOf(b)} cannot be subtracted`)
}

const NUMBER_TOKEN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/
const SPECIAL_TOKEN = /^([+-]?)(nan|inf|infinity)$/i

/** Numero de un texto con la gramatica de jq (admite `+5`, `.5`, `007`, `nan`, `inf`), o `null`. */
export function numberFromToken(token: string): number | NumberLiteral | null {
  const special = SPECIAL_TOKEN.exec(token)
  if (special !== null) {
    if ((special[2] ?? '').toLowerCase() === 'nan') return NaN
    return special[1] === '-' ? -Number.MAX_VALUE : Number.MAX_VALUE
  }
  const match = NUMBER_TOKEN.exec(token)
  if (match === null) return null
  const [, sign = '', whole = '', fraction = '', power = '0'] = match
  if (whole.length + fraction.length === 0) return null
  const digits = (whole + fraction).replace(/^0+(?=\d)/, '')
  const exponent = Number(power) - fraction.length
  const adjusted = exponent + digits.length - 1
  let body: string
  if (exponent > 0 || adjusted < -6) {
    const tail = digits.length > 1 ? `.${digits.slice(1)}` : ''
    body = `${digits.slice(0, 1)}${tail}E${adjusted < 0 ? '-' : '+'}${Math.abs(adjusted)}`
  } else if (exponent === 0) body = digits
  else if (digits.length > -exponent) body = `${digits.slice(0, exponent)}.${digits.slice(exponent)}`
  else body = `0.${'0'.repeat(-exponent - digits.length)}${digits}`
  const value = Number(`${sign}${digits}e${exponent}`)
  const finite = Number.isFinite(value) ? value : (sign === '-' ? -1 : 1) * Number.MAX_VALUE
  return new NumberLiteral(finite, (sign === '-' ? '-' : '') + body)
}

const SPACE = new Set([' ', '\t', '\n', '\r'])
const DELIMITER = new Set([...SPACE, '[', ']', '{', '}', ',', ':', '"'])
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function invalid(): never {
  throw new JqError('Invalid JSON text')
}

function skipSpace(text: string, start: number): number {
  let position = start
  while (position < text.length && SPACE.has(text[position] ?? '')) position++
  return position
}

interface Parsed {
  value: JqValue
  end: number
}

function parseString(text: string, start: number): { value: string; end: number } {
  let end = start + 1
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
  if (end >= text.length) invalid()
  let value: string
  try {
    value = JSON.parse(text.slice(start, end + 1)) as string
  } catch {
    return invalid()
  }
  // jq exige el par completo tras un surrogate alto y sustituye uno bajo suelto por U+FFFD.
  if (LONE_HIGH_SURROGATE.test(value)) invalid()
  return { value: value.replace(LONE_LOW_SURROGATE, '\uFFFD'), end: end + 1 }
}

function parseArray(text: string, start: number): Parsed {
  const items: JqValue[] = []
  let position = skipSpace(text, start + 1)
  if (text[position] === ']') return { value: items, end: position + 1 }
  for (;;) {
    const item = parseValue(text, position)
    items.push(item.value)
    position = skipSpace(text, item.end)
    if (text[position] === ']') return { value: items, end: position + 1 }
    if (text[position] !== ',') invalid()
    position = skipSpace(text, position + 1)
  }
}

function parseObject(text: string, start: number): Parsed {
  const object: JqObject = {}
  let position = skipSpace(text, start + 1)
  if (text[position] === '}') return { value: object, end: position + 1 }
  for (;;) {
    if (text[position] !== '"') invalid()
    const key = parseString(text, position)
    position = skipSpace(text, key.end)
    if (text[position] !== ':') invalid()
    const item = parseValue(text, skipSpace(text, position + 1))
    // Una asignacion a `__proto__` cambiaria el prototipo en vez de crear la clave.
    Object.defineProperty(object, key.value, { value: item.value, writable: true, enumerable: true, configurable: true })
    position = skipSpace(text, item.end)
    if (text[position] === '}') return { value: object, end: position + 1 }
    if (text[position] !== ',') invalid()
    position = skipSpace(text, position + 1)
  }
}

function parseValue(text: string, start: number): Parsed {
  const first = text[start]
  if (first === '"') return parseString(text, start)
  if (first === '[') return parseArray(text, start)
  if (first === '{') return parseObject(text, start)
  let end = start
  while (end < text.length && !DELIMITER.has(text[end] ?? '')) end++
  const token = text.slice(start, end)
  if (token === 'true') return { value: true, end }
  if (token === 'false') return { value: false, end }
  if (token === 'null') return { value: null, end }
  return { value: numberFromToken(token) ?? invalid(), end }
}

export interface JqStream {
  values: JqValue[]
  /** `false` si el texto se corto en un valor invalido. */
  clean: boolean
}

/** Los valores JSON concatenados en `text`, hasta el primero invalido (como lee jq una entrada). */
export function parseJqStream(text: string): JqStream {
  const values: JqValue[] = []
  let position = text.startsWith('\uFEFF') ? 1 : 0
  for (;;) {
    position = skipSpace(text, position)
    if (position >= text.length) return { values, clean: true }
    try {
      const parsed = parseValue(text, position)
      values.push(parsed.value)
      position = parsed.end
    } catch (error) {
      if (!(error instanceof JqError)) throw error
      return { values, clean: false }
    }
  }
}

/** `fromjson`: el unico valor JSON de `text`; falla si no hay exactamente uno. */
export function parseJq(text: string): JqValue {
  const stream = parseJqStream(text)
  if (!stream.clean || stream.values.length !== 1) invalid()
  return stream.values[0] ?? null
}

/** `tonumber` sobre una cadena. */
export function toNumber(text: string): number | NumberLiteral {
  let value: JqValue
  try {
    value = parseJq(text)
  } catch {
    throw new JqError(`Cannot use ${text} as a number`)
  }
  if (!isNumber(value)) throw new JqError(`Cannot use ${text} as a number`)
  return value
}

/** JSON como lo imprime jq: compacto con `indent` 0, o con esa sangria por nivel. */
export function dumpJq(value: JqValue, indent = 0, depth = 0): string {
  if (value instanceof NumberLiteral) return value.text
  if (typeof value === 'number') return numberText(value)
  if (value === null || typeof value !== 'object') return dumpPlain(value)
  const items = Array.isArray(value)
    ? value.map((item) => dumpJq(item, indent, depth + 1))
    : Object.keys(value).map(
        (key) => `${dumpPlain(key)}:${indent > 0 ? ' ' : ''}${dumpJq(value[key] ?? null, indent, depth + 1)}`,
      )
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (items.length === 0) return open + close
  if (indent === 0) return open + items.join(',') + close
  const inner = ' '.repeat(indent * (depth + 1))
  return `${open}\n${items.map((item) => inner + item).join(',\n')}\n${' '.repeat(indent * depth)}${close}`
}

/** `tostring` */
export function toText(value: JqValue): string {
  return typeof value === 'string' ? value : dumpJq(value)
}
