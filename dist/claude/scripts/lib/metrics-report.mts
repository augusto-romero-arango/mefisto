// Piezas comunes de los reportes de metricas publicado e interno: lectura del historial,
// normalizacion de `agents.<stage>.metrics`, agregados por periodo y por grupo, formato de cifras
// y las tablas que los dos renderizan igual.
//
// Los agregados conservan la semantica del filtro jq del que salen (orden, `//`, nulos): un
// historial con tipos inesperados lanza `JqError` y el reporte entero se da por no procesable.

import { readFileSync, statSync } from 'node:fs'

import { CliError } from './cli.mts'
import {
  JqError,
  add,
  alt,
  compare,
  divide,
  equals,
  get,
  groupBy,
  has,
  iterate,
  length,
  negate,
  numberText,
  path,
  slice,
  sortBy,
  subtract,
  sum,
  toNumber,
  toText,
} from './jq-values.mts'
import type { Json, JsonObject } from './jq-values.mts'

export interface ReportIo {
  /** Recibe una linea sin su salto final. */
  out: (line: string) => void
  err: (line: string) => void
}

/** Corre `main` y traduce un `CliError` a su mensaje en `io.err` y su codigo de salida. */
export function runReport(io: ReportIo, main: () => number): number {
  try {
    return main()
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) io.err(error.message)
    return error.exitCode
  }
}

/** Escribe un texto de varias lineas. */
export function outLines(io: ReportIo, text: string): void {
  for (const line of text.split('\n')) io.out(line)
}

// --- Argumentos ---------------------------------------------------------------

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/**
 * Valores de las banderas de fecha (`--desde`, `--hasta`), vacios si no vienen; `null` si se
 * pidio la ayuda. `hint` es el uso que acompana al error de argumento desconocido.
 */
export function parseDateFlags(argv: string[], flags: string[], hint: string): Record<string, string> | null {
  const values: Record<string, string> = Object.fromEntries(flags.map((flag) => [flag, '']))
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    const flag = flags.find((name) => arg === name || arg.startsWith(`${name}=`))
    if (flag === undefined) {
      if (arg === '-h' || arg === '--help') return null
      throw new CliError(`ERROR: argumento desconocido: ${arg} (uso: ${hint})`)
    }
    if (arg !== flag) {
      values[flag] = arg.slice(flag.length + 1)
      continue
    }
    const value = argv[++index]
    if (value === undefined) throw new CliError(`ERROR: ${flag} requiere un valor YYYY-MM-DD`)
    values[flag] = value
  }
  for (const flag of flags) {
    const value = values[flag] ?? ''
    // Como `grep`, basta con que una linea del valor tenga el formato.
    if (value.length > 0 && !value.split('\n').some((line) => DATE.test(line))) {
      throw new CliError(`ERROR: ${flag} espera formato YYYY-MM-DD (recibido: '${value}')`)
    }
  }
  return values
}

// --- Historial ----------------------------------------------------------------

/** Contenido de los historiales, uno tras otro; un archivo ausente o ilegible aporta vacio. */
export function readHistory(paths: string[]): string {
  let content = ''
  for (const file of paths) {
    try {
      if (statSync(file).isFile()) content += readFileSync(file, 'utf8')
    } catch {
      // Se sigue con lo que se pudo leer.
    }
    // Un historial sin salto final no debe pegar su ultima linea con la primera del siguiente.
    content += '\n'
  }
  return content
}

/** Las lineas del historial que son objetos JSON; las vacias y las corruptas se ignoran. */
export function parseHistory(content: string): JsonObject[] {
  const entries: JsonObject[] = []
  for (const line of content.replaceAll('\0', '').split('\n')) {
    if (line.length === 0) continue
    try {
      const value = JSON.parse(line.startsWith('﻿') ? line.slice(1) : line) as Json
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) entries.push(value)
    } catch {
      // Linea corrupta.
    }
  }
  return entries
}

/** `true` si la fecha de `started` (sus 8 primeros caracteres) cae en `[desde, hasta]`. */
export function inWindow(entry: JsonObject, desde: string, hasta: string): boolean {
  const day = (): Json => slice(alt(get(entry, 'started'), ''), 0, 8)
  const bound = (limit: string): string => limit.replaceAll('-', '')
  if (desde !== '' && !(length(day()) === 8 && compare(day(), bound(desde)) >= 0)) return false
  return hasta === '' || (length(day()) === 8 && compare(day(), bound(hasta)) <= 0)
}

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9'
const isSpace = (char: string | undefined): boolean => char !== undefined && ' \t\n\v\f\r'.includes(char)

/**
 * Epoch UTC de un `started` con forma `YYYYMMDD-HHMMSS`, o `null`. Acepta lo mismo que el
 * `strptime` de macOS: campos con menos digitos y minutos o segundos ausentes al final.
 */
export function parseStarted(started: Json): number | null {
  if (typeof started !== 'string') return null
  let position = 0
  const digits = (max: number): number | null => {
    let end = position
    while (end - position < max && isDigit(started[end])) end++
    if (end === position) return null
    const value = Number(started.slice(position, end))
    position = end
    return value
  }
  const exhausted = (): boolean => position >= started.length || isSpace(started[position])

  const year = digits(4)
  const month = digits(2)
  const day = digits(2)
  if (year === null || month === null || day === null) return null
  if (month < 1 || month > 12 || day > 31 || started[position] !== '-') return null
  position++
  const hour = digits(2)
  if (hour === null || hour > 23) return null
  let [minute, second] = [0, 0]
  if (!exhausted()) {
    const value = digits(2)
    if (value === null || value > 59) return null
    minute = value
  }
  if (!exhausted()) {
    const value = digits(2)
    if (value === null || value > 60) return null
    second = value
  }
  if (!exhausted()) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second)
  return date.getTime() / 1000
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** Semana ISO 8601 (`2026-W32`) del epoch, o `null` sin fecha. */
export function weekKey(ts: number | null): string | null {
  if (ts === null) return null
  const thursday = new Date(ts * 1000)
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3)
  const newYear = new Date(0)
  newYear.setUTCFullYear(thursday.getUTCFullYear(), 0, 1)
  const week = Math.floor((thursday.getTime() - newYear.getTime()) / (7 * 86_400_000)) + 1
  return `${thursday.getUTCFullYear()}-W${pad2(week)}`
}

/** Mes (`2026-08`) del epoch, o `null` sin fecha. */
export function monthKey(ts: number | null): string | null {
  if (ts === null) return null
  const date = new Date(ts * 1000)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`
}

// --- Agregados ------------------------------------------------------------------

export function nonNull(values: readonly Json[]): Json[] {
  return values.filter((value) => value !== null)
}

function at(values: readonly Json[], index: number): Json {
  return values[index] ?? null
}

export function median(values: readonly Json[]): Json {
  const sorted = sortBy(values, (value) => value)
  const count = sorted.length
  if (count === 0) return null
  if (count % 2 === 1) return at(sorted, (count - 1) / 2)
  return divide(add(at(sorted, count / 2 - 1), at(sorted, count / 2)), 2)
}

/** Media de los valores no nulos, o `null` si no queda ninguno. */
export function mean(values: readonly Json[]): Json {
  const present = nonNull(values)
  return present.length === 0 ? null : divide(sum(present), present.length)
}

function sumOrNull(values: readonly Json[]): Json {
  const present = nonNull(values)
  return present.length === 0 ? null : sum(present)
}

function percent(part: Json, total: Json): Json {
  return compare(total, 0) > 0 ? divide(part, total) * 100 : null
}

/**
 * Proyecta `agents.<stage>.metrics`, en su forma neutral o en la vieja, a una sola forma. Es el
 * unico punto que nombra los campos de la forma vieja. `estimated_cost_usd` nunca se infiere de
 * `cost_usd` (MEF-ADR-0054): el segundo solo se conserva como dato legado si falta el primero.
 */
export function normalizeAgentMetrics(metrics: Json): JsonObject | null {
  if (metrics === null) return null
  const neutralApi = get(metrics, 'api_duration_ms')
  const apiMs = neutralApi !== null ? neutralApi : get(metrics, 'duration_api_ms')
  const runtime = get(metrics, 'runtime')
  const status = get(metrics, 'status')
  const isError = get(metrics, 'is_error')
  const durationMs = get(metrics, 'duration_ms')
  const cacheWrite = path(metrics, 'tokens', 'cache_write')
  const failed = typeof isError === 'boolean' ? (isError ? 'failed' : 'success') : null
  return {
    agent: get(metrics, 'agent'),
    runtime: typeof runtime === 'string' ? runtime : null,
    status: typeof status === 'string' ? status : failed,
    model: get(metrics, 'model'),
    estimated_cost_usd: get(metrics, 'estimated_cost_usd'),
    legacy_reported_cost_usd: has(metrics, 'estimated_cost_usd') ? null : get(metrics, 'cost_usd'),
    tokens: {
      input: path(metrics, 'tokens', 'input'),
      output: path(metrics, 'tokens', 'output'),
      cache_read: path(metrics, 'tokens', 'cache_read'),
      cache_write: cacheWrite !== null ? cacheWrite : path(metrics, 'tokens', 'cache_creation'),
      reasoning: path(metrics, 'tokens', 'reasoning'),
    },
    turns: get(metrics, 'turns'),
    duration_ms: durationMs,
    api_duration_ms: apiMs,
    // Sin los dos datos queda null, nunca 0.
    non_api_ms: durationMs !== null && apiMs !== null ? subtract(durationMs, apiMs) : null,
    tool_calls: alt(get(metrics, 'tool_calls'), []),
  }
}

/** Una corrida del historial con lo que el reporte deriva de ella una sola vez. */
export interface Run {
  entry: JsonObject
  wallS: Json
  hasMetrics: boolean
  ts: number | null
  version: string
}

/** Cifras de una corrida, sumadas sobre los agentes que dejaron `metrics`. */
export interface RunAccessors {
  apiMs: (entry: JsonObject) => Json
  nonApiMs: (entry: JsonObject) => Json
  /** Bloques `tool_calls` de la corrida, sin iterar. */
  toolCalls: (entry: JsonObject) => Json
  turns: (entry: JsonObject) => Json
  tokensInput: (entry: JsonObject) => Json
  tokensOutput: (entry: JsonObject) => Json
  cacheRead: (entry: JsonObject) => Json
  cacheWrite: (entry: JsonObject) => Json
  reasoning: (entry: JsonObject) => Json
  estimatedCost: (entry: JsonObject) => Json
  legacyCost: (entry: JsonObject) => Json
  metricsAgents: (entry: JsonObject) => number
  estimatedCostAgents: (entry: JsonObject) => number
}

function toolMs(acc: RunAccessors, entry: JsonObject): Json {
  return alt(sum(iterate(acc.toolCalls(entry)).map((call) => alt(get(call, 'duration_ms_sum'), 0))), 0)
}

function toolCallsCount(acc: RunAccessors, entry: JsonObject): Json {
  return alt(sum(iterate(acc.toolCalls(entry)).map((call) => get(call, 'count'))), 0)
}

function estimatedCostStatus(acc: RunAccessors, entry: JsonObject): string {
  const estimated = acc.estimatedCostAgents(entry)
  if (estimated === 0) return 'sin estimacion'
  return estimated === acc.metricsAgents(entry) ? 'completa' : 'parcial'
}

function countPresent<R extends Run>(runs: readonly R[], value: (entry: JsonObject) => Json): number {
  return runs.filter((run) => value(run.entry) !== null).length
}

/** Cuantas corridas instrumentadas traen costo estimado (completo o parcial) y cuantas el legado. */
export function costCoverage<R extends Run>(instrumented: readonly R[], acc: RunAccessors): JsonObject {
  const estimated = countPresent(instrumented, acc.estimatedCost)
  const withStatus = (status: string): number =>
    instrumented.filter((run) => estimatedCostStatus(acc, run.entry) === status).length
  return {
    estimated_cost_runs: estimated,
    estimated_cost_missing_runs: instrumented.length - estimated,
    estimated_cost_complete_runs: withStatus('completa'),
    estimated_cost_partial_runs: withStatus('parcial'),
    legacy_cost_runs: countPresent(instrumented, acc.legacyCost),
  }
}

export function startedRange<R extends Run>(runs: readonly R[]): JsonObject {
  const sorted = sortBy(nonNull(runs.map((run) => get(run.entry, 'started'))), (value) => value)
  return { oldest_started: at(sorted, 0), newest_started: sorted.at(-1) ?? null }
}

/**
 * Ranking de herramientas por tiempo total. `median_ms` es la mediana de las medianas por
 * corrida: el historial guarda por stage solo suma y mediana, no cada llamada.
 */
export function toolRanking<R extends Run>(instrumented: readonly R[], acc: RunAccessors): Json[] {
  const blocks = alt(sum(instrumented.map((run) => acc.toolCalls(run.entry))), [])
  if (!Array.isArray(blocks)) throw new JqError('tool_calls no es una lista')
  const ranking = groupBy(blocks, (block) => get(block, 'name')).map((group) => ({
    name: get(at(group, 0), 'name'),
    calls: sum(group.map((block) => get(block, 'count'))),
    time_ms: sum(group.map((block) => alt(get(block, 'duration_ms_sum'), 0))),
    median_ms: median(nonNull(group.map((block) => get(block, 'duration_ms_median')))),
  }))
  const total = alt(sum(ranking.map((tool) => tool.time_ms)), 0)
  return sortBy(
    ranking.map((tool) => ({ ...tool, pct: compare(total, 0) > 0 ? divide(tool.time_ms, total) * 100 : 0 })),
    (tool) => negate(tool.time_ms),
  )
}

export function wallclockAggregate<R extends Run>(instrumented: readonly R[], acc: RunAccessors): JsonObject {
  const apiMs = alt(sum(instrumented.map((run) => acc.apiMs(run.entry))), 0)
  const nonApiMs = alt(sum(instrumented.map((run) => acc.nonApiMs(run.entry))), 0)
  const tools = alt(sum(instrumented.map((run) => toolMs(acc, run.entry))), 0)
  const total = add(apiMs, nonApiMs)
  return {
    n: instrumented.length,
    api_ms: apiMs,
    non_api_ms: nonApiMs,
    tool_ms: tools,
    pct_api: percent(apiMs, total),
    pct_non_api: percent(nonApiMs, total),
    pct_tool_of_non_api: compare(nonApiMs, 0) > 0 ? divide(tools, nonApiMs) * 100 : null,
  }
}

/** Una fila por corrida instrumentada, por fecha de inicio; `extra` agrega columnas propias. */
export function perRun<R extends Run>(
  instrumented: readonly R[],
  acc: RunAccessors,
  extra: (run: R) => JsonObject = () => ({}),
): Json[] {
  return sortBy(instrumented, (run) => get(run.entry, 'started')).map((run) => {
    const { entry } = run
    const [apiMs, nonApiMs] = [acc.apiMs(entry), acc.nonApiMs(entry)]
    return {
      issue: get(entry, 'issue'),
      started: get(entry, 'started'),
      state: get(entry, 'state'),
      wall_s: run.wallS,
      api_ms: apiMs,
      non_api_ms: nonApiMs,
      tool_ms: toolMs(acc, entry),
      estimated_cost_usd: acc.estimatedCost(entry),
      estimated_cost_status: estimatedCostStatus(acc, entry),
      legacy_reported_cost_usd: acc.legacyCost(entry),
      pct_api: percent(apiMs, add(apiMs, nonApiMs)),
      ...extra(run),
    }
  })
}

export const NO_DATE = '(s/fecha)'

/**
 * Serie por periodo. `wall_mean_s` cubre todas las corridas del periodo; `wall_mean_instr_s` y el
 * resto de las cifras, solo las instrumentadas, que es el denominador que comparten.
 */
export function periodSummary<R extends Run>(
  runs: readonly R[],
  keyOf: (ts: number | null) => string | null,
  acc: RunAccessors,
): JsonObject[] {
  const periods = groupBy(runs, (run) => keyOf(run.ts)).map((group): JsonObject => {
    const instrumented = group.filter((run) => run.hasMetrics)
    const of = (value: (entry: JsonObject) => Json): Json[] => instrumented.map((run) => value(run.entry))
    const cacheRead = alt(sum(nonNull(of(acc.cacheRead))), 0)
    const cacheWrite = alt(sum(nonNull(of(acc.cacheWrite))), 0)
    const walls = nonNull(group.map((run) => run.wallS))
    return {
      period: alt(keyOf(group[0]?.ts ?? null), NO_DATE),
      n_total: group.length,
      n_instrumented: instrumented.length,
      wall_mean_s: mean(walls),
      wall_median_s: median(walls),
      wall_mean_instr_s: mean(instrumented.map((run) => run.wallS)),
      turns_mean: mean(of(acc.turns)),
      tool_calls_mean: mean(of((entry) => toolCallsCount(acc, entry))),
      tokens_input_mean: mean(of(acc.tokensInput)),
      tokens_output_mean: mean(of(acc.tokensOutput)),
      cache_read_mean: mean(of(acc.cacheRead)),
      cache_write_mean: mean(of(acc.cacheWrite)),
      reasoning_mean: mean(of(acc.reasoning)),
      cache_read_pct: percent(cacheRead, add(cacheRead, cacheWrite)),
      estimated_cost_usd_mean: mean(of(acc.estimatedCost)),
      estimated_cost_n: nonNull(of(acc.estimatedCost)).length,
      legacy_reported_cost_usd_mean: mean(of(acc.legacyCost)),
      non_api_ms_mean: mean(of(acc.nonApiMs)),
    }
  })
  return sortBy(periods, (period) => [equals(get(period, 'period'), NO_DATE), get(period, 'period')])
}

/** Agregados de un grupo de corridas (una version, un runtime), solo sobre las instrumentadas. */
export function groupSummary<R extends Run>(group: readonly R[], acc: RunAccessors): JsonObject {
  const instrumented = group.filter((run) => run.hasMetrics)
  const of = (value: (entry: JsonObject) => Json): Json[] => instrumented.map((run) => value(run.entry))
  const apiMs = alt(sum(of(acc.apiMs)), 0)
  const nonApiMs = alt(sum(of(acc.nonApiMs)), 0)
  return {
    n_total: group.length,
    n_instrumented: instrumented.length,
    wall_mean_instr_s: mean(instrumented.map((run) => run.wallS)),
    pct_api: percent(apiMs, add(apiMs, nonApiMs)),
    turns_mean: mean(of(acc.turns)),
    estimated_cost_usd_mean: mean(of(acc.estimatedCost)),
    estimated_cost_n: nonNull(of(acc.estimatedCost)).length,
    legacy_reported_cost_usd_mean: mean(of(acc.legacyCost)),
  }
}

export const NO_VERSION = '(sin version)'

// Semver numerico por componente: comparando cadenas, 0.25.0 iria antes que 0.9.0.
function versionSortKey(version: string): Json {
  const parts = version.length === 0 ? [] : version.split('.')
  return [
    parts.map((part) => {
      try {
        return toNumber(part)
      } catch {
        return -1
      }
    }),
    version,
  ]
}

export function byVersion<R extends Run>(runs: readonly R[], acc: RunAccessors): JsonObject[] {
  const groups = groupBy(runs, (run) => run.version).map(
    (group): JsonObject => ({ ...groupSummary(group, acc), version: group[0]?.version ?? NO_VERSION }),
  )
  return sortBy(groups, (group) => {
    const version = get(group, 'version')
    return [version === NO_VERSION, versionSortKey(typeof version === 'string' ? version : '')]
  })
}

/** Medias por agente sobre sus `metrics` ya normalizadas. */
export function summarizeMetrics(metrics: readonly Json[]): JsonObject {
  const of = (...keys: string[]): Json[] => metrics.map((item) => path(item, ...keys))
  return {
    n: metrics.length,
    turns_mean: mean(of('turns')),
    estimated_cost_usd_mean: mean(of('estimated_cost_usd')),
    estimated_cost_usd_total: sumOrNull(of('estimated_cost_usd')),
    legacy_reported_cost_usd_mean: mean(of('legacy_reported_cost_usd')),
    legacy_reported_cost_usd_total: sumOrNull(of('legacy_reported_cost_usd')),
    duration_ms_mean: mean(of('duration_ms')),
    duration_api_ms_mean: mean(of('api_duration_ms')),
    non_api_ms_mean: mean(of('non_api_ms')),
    tokens_input_mean: mean(of('tokens', 'input')),
    tokens_output_mean: mean(of('tokens', 'output')),
    tokens_cache_read_mean: mean(of('tokens', 'cache_read')),
    tokens_cache_write_mean: mean(of('tokens', 'cache_write')),
    tokens_reasoning_mean: mean(of('tokens', 'reasoning')),
  }
}

export function legacyIssues<R extends Run>(legacy: readonly R[]): Json[] {
  return sortBy(legacy, (run) => get(run.entry, 'started')).map((run) => ({
    issue: get(run.entry, 'issue'),
    started: get(run.entry, 'started'),
    state: get(run.entry, 'state'),
  }))
}

// Un extremo desconocido no equivale a cero: sin dato en un lado no hay variacion.
function deltaOf(first: Json, last: Json): JsonObject {
  const known = first !== null && last !== null && !equals(first, 0)
  return { first, last, pct: known ? divide(subtract(last, first), first) * 100 : null }
}

/** Variacion entre dos periodos; todas las filas usan solo las corridas instrumentadas. */
export function comparisonDeltas(first: Json, last: Json, wallLabel: string): Json[] {
  const delta = (key: string, label: string, unit: string, source = key): JsonObject => ({
    key,
    label,
    unit,
    ...deltaOf(get(first, source), get(last, source)),
  })
  const nonApiS = (period: Json): number => divide(alt(get(period, 'non_api_ms_mean'), 0), 1000)
  return [
    delta('wall_mean_s', wallLabel, 's', 'wall_mean_instr_s'),
    delta('turns_mean', 'Turnos medios', 'count1'),
    delta('tool_calls_mean', 'Tool calls medios', 'count1'),
    delta('tokens_input_mean', 'Tokens in medios', 'count0'),
    { key: 'non_api_s_mean', label: 'No-API medio', unit: 's', ...deltaOf(nonApiS(first), nonApiS(last)) },
    delta('estimated_cost_usd_mean', 'Costo estimado medio', 'usd'),
  ]
}

// --- Formato --------------------------------------------------------------------

export type Cell = Json | undefined

// Valor exacto del double como mantisa entera por potencia de dos.
function exactParts(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  const biased = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & 0xfffffffffffffn
  return biased === 0
    ? { mantissa: fraction, exponent: -1074 }
    : { mantissa: fraction | (1n << 52n), exponent: biased - 1075 }
}

/**
 * `printf '%.<decimals>f'` de C: redondea el valor exacto del double y, en un empate, al digito
 * par. `toFixed` redondea los empates hacia arriba (0.5 da 1, C da 0).
 */
export function fixed(value: number, decimals: number, plus = false): string {
  const sign = value < 0 || Object.is(value, -0) ? '-' : plus ? '+' : ''
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return `${sign}inf`
  const { mantissa, exponent } = exactParts(Math.abs(value))
  let numerator = mantissa * 10n ** BigInt(decimals)
  let denominator = 1n
  if (exponent >= 0) numerator <<= BigInt(exponent)
  else denominator <<= BigInt(-exponent)
  let quotient = numerator / denominator
  const twice = (numerator % denominator) * 2n
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n
  const digits = quotient.toString().padStart(decimals + 1, '0')
  if (decimals === 0) return sign + digits
  return `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
}

/** `printf` reducido a `%s`, `%-Ns` y `%Ns`; el ancho se cuenta en bytes, como en bash. */
export function fmt(template: string, ...args: string[]): string {
  let next = 0
  return template.replace(/%(-?)(\d*)s/g, (_match, left: string, width: string) => {
    const text = args[next++] ?? ''
    const padding = ' '.repeat(Math.max(0, Number(width) - Buffer.byteLength(text)))
    return left === '-' ? text + padding : padding + text
  })
}

/** `true` si la fila se puede escribir: jq no acepta arreglos ni objetos en una fila `@tsv`. */
function isScalarRow(values: readonly Json[]): boolean {
  return values.every((value) => typeof value !== 'object' || value === null)
}

/** Filas de una tabla; como en jq, la primera que falla corta la tabla ahi. */
export function tableRows<T>(items: readonly T[], project: (item: T) => Json[]): Json[][] {
  const rows: Json[][] = []
  for (const item of items) {
    let values: Json[]
    try {
      values = project(item)
    } catch (error) {
      if (error instanceof JqError) break
      throw error
    }
    if (!isScalarRow(values)) break
    rows.push(values)
  }
  return rows
}

const TSV_ESCAPES: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r', '\\': '\\\\' }

/** Texto de una celda: `null` y vacio salen como el literal `null`, igual que en la fila `@tsv`. */
export function cell(value: Cell): string {
  if (value === undefined || value === null || value === '') return 'null'
  if (typeof value === 'string') return value.replace(/[\t\n\r\\]/g, (char) => TSV_ESCAPES[char] ?? char)
  if (typeof value === 'number') return numberText(value)
  return typeof value === 'boolean' ? String(value) : 'null'
}

/** Salida de `jq -r` capturada por el shell: cadena tal cual, sin saltos finales. */
export function raw(value: Json): string {
  return toText(value).replace(/\n+$/, '')
}

function numberOf(value: Cell): number | null {
  if (typeof value === 'number') return value
  const text = cell(value)
  if (text === 'null') return null
  const parsed = Number(text)
  return Number.isNaN(parsed) ? 0 : parsed
}

function formatted(value: Cell, missing: string, format: (value: number) => string): string {
  const number = numberOf(value)
  return number === null ? missing : format(number)
}

/** Texto tal cual, `-` si falta. */
export function txt(value: Cell): string {
  const text = cell(value)
  return text === 'null' ? '-' : text
}

/** `XmYYs` desde un minuto, `Ys` si no; redondea al segundo. */
export function fmtDurS(value: Cell): string {
  return formatted(value, '-', (seconds) => {
    const total = Number(fixed(seconds, 0))
    const minutes = Math.trunc(total / 60)
    const rest = total % 60
    return minutes > 0 ? `${minutes}m${pad2(rest)}s` : `${rest}s`
  })
}

export const fmtPct = (value: Cell): string => formatted(value, '-', (number) => `${fixed(number, 1)}%`)
export const fmtSignedPct = (value: Cell): string =>
  formatted(value, 'n/d', (number) => `${fixed(number, 1, true)}%`)
export const num0 = (value: Cell): string => formatted(value, '-', (number) => fixed(number, 0))
export const num1 = (value: Cell): string => formatted(value, '-', (number) => fixed(number, 1))
export const secs = (value: Cell): string => formatted(value, '-', (number) => `${fixed(number, 1)}s`)
export const secs0 = (value: Cell): string => formatted(value, '-', (number) => `${fixed(number, 0)}s`)
export const money = (value: Cell): string => formatted(value, '-', (number) => fixed(number, 2))
/** Miles compactos: 12345 sale como `12.3k`. */
export const numk = (value: Cell): string =>
  formatted(value, '-', (number) => (number >= 1000 ? `${fixed(number / 1000, 1)}k` : fixed(number, 0)))

/** Milisegundos a segundos, conservando el dato ausente. */
export const perThousand = (value: Json): Json => (value === null ? null : divide(value, 1000))

// --- Tablas comunes -------------------------------------------------------------

export function renderToolRanking(io: ReportIo, agg: Json, rule: string): void {
  const tools = iterate(get(agg, 'tool_ranking'))
  io.out('')
  io.out(rule)
  io.out(`RANKING DE HERRAMIENTAS (n=${raw(path(agg, 'meta', 'instrumented'))} corridas instrumentadas)`)
  io.out(rule)
  if (tools.length === 0) {
    io.out('(sin tool calls en corridas instrumentadas dentro de la ventana)')
    return
  }
  const columns = '%-18s %10s %14s %16s %10s'
  io.out(fmt(columns, 'Herramienta', 'Llamadas', 'Tiempo total', 'Mediana/llamada', '% tiempo'))
  const rows = tableRows(tools, (tool) => [
    get(tool, 'name'),
    get(tool, 'calls'),
    divide(get(tool, 'time_ms'), 1000),
    perThousand(get(tool, 'median_ms')),
    get(tool, 'pct'),
  ])
  for (const [name, calls, time, medianS, pct] of rows) {
    io.out(fmt(columns, cell(name), cell(calls), secs(time), secs(medianS), fmtPct(pct)))
  }
  io.out('')
  io.out("Nota: 'Mediana/llamada' es la mediana de las medianas por corrida (el")
  io.out('      historial guarda por stage solo suma+mediana, no cada llamada);')
  io.out('      leela como orden de magnitud, no como percentil exacto.')
}

/** Encabezado del reparto y su agregado; `false` si no hay corridas instrumentadas. */
export function renderWallclockAggregate(io: ReportIo, agg: Json, rule: string): boolean {
  const aggregate = path(agg, 'wallclock', 'aggregate')
  const count = get(aggregate, 'n')
  io.out('')
  io.out(rule)
  io.out(`REPARTO DEL WALL-CLOCK (n=${raw(count)} corridas instrumentadas)`)
  io.out(rule)
  if (count === 0) {
    io.out('(sin corridas instrumentadas en la ventana -- ver SIN INSTRUMENTAR)')
    return false
  }
  const seconds = (key: string): string => secs(divide(get(aggregate, key), 1000))
  const pct = (key: string): string => fmtPct(get(aggregate, key))
  io.out(`Agregado: API ${seconds('api_ms')} (${pct('pct_api')})  No-API ${seconds('non_api_ms')} (${pct('pct_non_api')})`)
  io.out(`  De lo no-API, atribuible a tool calls: ${seconds('tool_ms')} (${pct('pct_tool_of_non_api')} del no-API)`)
  io.out('  (las tool calls en paralelo se suman por separado, asi que ese % puede pasar de 100)')
  return true
}

/** Columnas comunes de una fila de "Por corrida"; cada reporte agrega las suyas con `tail`. */
export function perRunRows(agg: Json, tail: string[] = []): Json[][] {
  return tableRows(iterate(path(agg, 'wallclock', 'per_run')), (run) => [
    get(run, 'issue'),
    get(run, 'started'),
    get(run, 'state'),
    get(run, 'wall_s'),
    divide(get(run, 'api_ms'), 1000),
    divide(get(run, 'non_api_ms'), 1000),
    divide(get(run, 'tool_ms'), 1000),
    get(run, 'pct_api'),
    get(run, 'estimated_cost_usd'),
    get(run, 'estimated_cost_status'),
    get(run, 'legacy_reported_cost_usd'),
    ...tail.map((key) => get(run, key)),
  ])
}

/** Las once columnas comunes de "Por corrida", ya formateadas. */
export function perRunCells(row: readonly Json[]): string[] {
  const [issue, started, state, wall, api, nonApi, tools, pctApi, estimated, status, legacy] = row
  return [
    cell(issue),
    txt(started),
    txt(state),
    secs0(wall),
    secs(api),
    secs(nonApi),
    secs(tools),
    fmtPct(pctApi),
    money(estimated),
    cell(status),
    money(legacy),
  ]
}

const PERIOD_KEYS = [
  'period',
  'n_total',
  'n_instrumented',
  'wall_mean_s',
  'wall_median_s',
  'turns_mean',
  'tool_calls_mean',
  'tokens_input_mean',
  'tokens_output_mean',
  'cache_read_mean',
  'cache_write_mean',
  'reasoning_mean',
  'cache_read_pct',
  'estimated_cost_n',
  'estimated_cost_usd_mean',
  'legacy_reported_cost_usd_mean',
]

export function renderPeriodTable(io: ReportIo, periods: Json, title: string, rule: string): void {
  io.out('')
  io.out(rule)
  io.out(title)
  io.out(rule)
  const items = iterate(periods)
  if (items.length === 0) {
    io.out('(sin datos en la ventana)')
    return
  }
  io.out('n(t/i) = corridas totales / de ellas instrumentadas. El wall usa las')
  io.out('totales; turnos, tools y tokens solo las instrumentadas.')
  io.out('')
  const columns = '%-10s %-8s %9s %9s %7s %7s %8s %8s %8s %8s %8s %7s %8s %10s %10s'
  io.out(
    fmt(columns, 'Periodo', 'n(t/i)', 'WallMedia', 'WallP50', 'Turnos', 'Tools', 'Tok.in', 'Tok.out', 'Cache.rd', 'Cache.wr', 'Reason', '%rd', 'n(est)', 'Costo est.', 'Costo leg.'),
  )
  for (const row of tableRows(items, (period) => PERIOD_KEYS.map((key) => get(period, key)))) {
    const [period, total, instrumented, wallMean, wallMedian, turns, tools, tokIn, tokOut, cacheRd, cacheWr, reasoning, cachePct, estimatedN, estimatedMean, legacyMean] = row
    io.out(
      fmt(
        columns,
        cell(period),
        `${cell(total)}/${cell(instrumented)}`,
        fmtDurS(wallMean),
        fmtDurS(wallMedian),
        num1(turns),
        num1(tools),
        numk(tokIn),
        numk(tokOut),
        numk(cacheRd),
        numk(cacheWr),
        numk(reasoning),
        fmtPct(cachePct),
        `${cell(estimatedN)}/${cell(instrumented)}`,
        money(estimatedMean),
        money(legacyMean),
      ),
    )
  }
  io.out('')
  io.out('%rd = cache_read / (cache_read + cache_write): cae cuando el contexto')
  io.out('      deja de acertar en cache.')
}

const DELTA_FORMAT: Record<string, (value: Cell) => string> = { s: fmtDurS, count0: num0, usd: money }

/** Tabla Primero / Ultimo / Variacion de una comparacion. */
export function renderDeltas(io: ReportIo, comparison: Json): void {
  const columns = '%-22s %12s %12s %12s'
  io.out(fmt(columns, 'Metrica', 'Primero', 'Ultimo', 'Variacion'))
  const rows = tableRows(iterate(get(comparison, 'deltas')), (delta) =>
    ['label', 'unit', 'first', 'last', 'pct'].map((key) => get(delta, key)),
  )
  for (const [label, unit, first, last, pct] of rows) {
    const format = DELTA_FORMAT[cell(unit)] ?? num1
    io.out(fmt(columns, cell(label), format(first), format(last), fmtSignedPct(pct)))
  }
}

export function renderLegacyIssues(io: ReportIo, agg: Json): void {
  const rows = tableRows(iterate(path(agg, 'legacy', 'issues')), (run) =>
    ['issue', 'started', 'state'].map((key) => get(run, key)),
  )
  for (const [issue, started, state] of rows) io.out(fmt('#%-8s %-17s %s', cell(issue), txt(started), txt(state)))
}
