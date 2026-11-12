// Log legible y metricas de un stage, derivados del JSONL de eventos que deja el agente. Entiende
// el vocabulario neutral del runner (`run.started`, `run.completed`, `run.failed`) y el
// stream-json de Claude previo al contrato.
//
// Las metricas viajan como el texto JSON que imprime jq, que es lo que se escribe en el historial;
// `parseJq` de `jq-literals.mts` lo lee sin perder los literales.

import { readFileSync, writeFileSync } from 'node:fs'

import {
  add,
  dumpJq,
  firstTruthy,
  get,
  isJqObject,
  iterate,
  parseJq,
  path,
  plain,
  subtract,
  toText,
  typeOf,
} from '../jq-literals.mts'
import type { JqObject, JqValue } from '../jq-literals.mts'
import { JqError, groupBy } from '../jq-values.mts'
import { median } from '../metrics-report.mts'

const TERMINAL = ['run.completed', 'run.failed']
const NEUTRAL = ['run.started', ...TERMINAL]

/** Contenido del archivo, o `null` si falta, esta vacio o no se puede leer. */
function readNonEmpty(file: string): Buffer | null {
  try {
    const content = readFileSync(file)
    return content.length > 0 ? content : null
  } catch {
    return null
  }
}

/** Los valores de las lineas de un JSONL que son JSON valido; una truncada o vacia se ignora. */
export function streamValues(text: string): JqValue[] {
  const values: JqValue[] = []
  for (const line of text.split('\n')) {
    try {
      values.push(parseJq(line))
    } catch (error) {
      if (!(error instanceof JqError)) throw error
    }
  }
  return values
}

/** `.type` es uno de `types`; falla, como en jq, si el evento no es un objeto ni `null`. */
function hasType(event: JqValue, types: readonly string[]): boolean {
  const type = get(event, 'type')
  return typeof type === 'string' && types.includes(type)
}

/** Los eventos cuyo `.type` es uno de `types`. */
export function eventsOfType(events: readonly JqValue[], types: readonly string[]): JqValue[] {
  return events.filter((event) => hasType(event, types))
}

/** `true` si algun evento es de `types`; una linea que no es objeto antes del primero lo impide. */
function anyEvent(events: readonly JqValue[], types: readonly string[]): boolean {
  try {
    return events.some((event) => hasType(event, types))
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return false
  }
}

/** Corre un filtro; `null` si falla como fallaria en jq. */
function orNull<T>(filter: () => T): T | null {
  try {
    return filter()
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return null
  }
}

/** `a - b` si los dos estan presentes. */
function difference(a: JqValue, b: JqValue): JqValue {
  return a !== null && b !== null ? subtract(a, b) : null
}

// --- Log legible ----------------------------------------------------------------

/** `(.message.content // [])[]?`: solo la iteracion es opcional. */
function contentItems(event: JqValue): JqValue[] {
  const content = firstTruthy(
    () => path(event, 'message', 'content'),
    () => [],
  )
  return orNull(() => iterate(content)) ?? []
}

type Emit = (value: JqValue) => void

function neutralLog(event: JqObject, emit: Emit): void {
  const type = get(event, 'type')
  if (type === 'tool.started') {
    const tool = firstTruthy(
      () => get(event, 'tool'),
      () => get(event, 'name'),
      () => '?',
    )
    emit(add('[tool] ', tool))
  } else if (type === 'run.failed') {
    emit(
      firstTruthy(
        () => path(event, 'error', 'kind'),
        () => 'error',
      ),
    )
  } else if (type === 'run.completed') {
    emit(
      firstTruthy(
        () => get(event, 'status'),
        () => 'completed',
      ),
    )
  }
}

function legacyLog(event: JqObject, emit: Emit): void {
  const field = (key: string) => () => get(event, key)
  const type = get(event, 'type')
  if (type === 'assistant') {
    for (const item of contentItems(event)) {
      const kind = get(item, 'type')
      if (kind === 'text') {
        emit(
          firstTruthy(
            () => get(item, 'text'),
            () => '',
          ),
        )
      } else if (kind === 'tool_use') {
        const name = firstTruthy(
          () => get(item, 'name'),
          () => '?',
        )
        emit(add('[tool] ', name))
      }
    }
  } else if (type === 'message') emit(firstTruthy(field('text'), () => ''))
  else if (type === 'tool.started') emit(add('[tool] ', firstTruthy(field('tool'), () => '?')))
  else if (type === 'run.failed') {
    const detail = firstTruthy(
      () => path(event, 'error', 'detail'),
      () => path(event, 'error', 'kind'),
      () => 'error',
    )
    emit(toText(detail))
  } else if (type === 'result' && get(event, 'is_error') === true) {
    // Sin esta linea un 5xx que solo llega en el evento `result` no se clasifica como fallo del proveedor.
    const status = get(event, 'api_error_status')
    const prefix = status !== null && status !== false ? `API Error: ${toText(status)} ` : ''
    const reason = firstTruthy(field('result'), field('error'), field('terminal_reason'), field('subtype'), () => 'error')
    emit(prefix + toText(reason))
  }
}

/** Lo que `jq -r` escribe por cada evento; un fallo corta solo la linea en curso. */
function logText(stream: string, log: (event: JqObject, emit: Emit) => void): string {
  let text = ''
  for (const event of streamValues(stream)) {
    if (!isJqObject(event)) continue
    orNull(() => log(event, (value) => (text += `${typeof value === 'string' ? value : dumpJq(value, 2)}\n`)))
  }
  return text
}

/**
 * Escribe en `outFile` el log legible del stage. El stderr de `stderrFile` solo se anexa a un
 * stream legado: junto a eventos neutrales no, porque puede traer entradas sensibles. Nunca falla.
 */
export function deriveStageLogFromStream(streamFile: string, stderrFile: string, outFile: string): void {
  try {
    writeFileSync(outFile, '')
  } catch {
    return
  }
  const stream = readNonEmpty(streamFile)?.toString('utf8') ?? null
  const neutral = stream !== null && anyEvent(streamValues(stream), NEUTRAL)
  const log = stream === null ? '' : logText(stream, neutral ? neutralLog : legacyLog)
  const stderr = neutral ? null : readNonEmpty(stderrFile)
  const parts: Buffer[] = [Buffer.from(log)]
  if (stderr !== null) parts.push(Buffer.from(log.length > 0 ? '\n' : ''), stderr)
  try {
    writeFileSync(outFile, Buffer.concat(parts))
  } catch {
    // El log es observabilidad: no detiene al pipeline.
  }
}

// --- Metricas -------------------------------------------------------------------

function neutralMetrics(events: readonly JqValue[]): JqValue {
  const terminal = eventsOfType(events, TERMINAL).at(-1) ?? null
  if (terminal === null) return null
  const either = (first: string[], ...rest: string[][]): JqValue =>
    firstTruthy(...[first, ...rest].map((keys) => () => path(terminal, ...keys)))
  const duration = either(['duration_ms'], ['duration'])
  const api = either(['api_duration_ms'], ['duration_api_ms'])
  return {
    turns: either(['turns'], ['num_turns']),
    duration_ms: duration,
    duration_api_ms: api,
    non_api_ms: difference(duration, api),
    estimated_cost_usd: get(terminal, 'estimated_cost_usd'),
    tokens: {
      input: either(['tokens', 'input'], ['usage', 'input_tokens']),
      output: either(['tokens', 'output'], ['usage', 'output_tokens']),
      cache_read: either(['tokens', 'cache_read'], ['usage', 'cache_read_input_tokens']),
      cache_write: either(
        ['tokens', 'cache_write'],
        ['tokens', 'cache_creation'],
        ['usage', 'cache_write_input_tokens'],
        ['usage', 'cache_creation_input_tokens'],
      ),
      reasoning: either(['tokens', 'reasoning'], ['usage', 'reasoning_tokens']),
    },
    model: either(['model'], ['effective_model']),
    is_error: get(terminal, 'type') === 'run.failed',
    stop_reason: get(terminal, 'status'),
    terminal_reason: firstTruthy(
      () => path(terminal, 'error', 'kind'),
      () => null,
    ),
    ttft_ms: get(terminal, 'ttft_ms'),
    permission_denials: firstTruthy(
      () => get(terminal, 'denials'),
      () => null,
    ),
    rate_limit_events: null,
    tool_calls: [],
  }
}

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?Z(?=\n?$)/

/** Milisegundos de epoca del `timestamp` ISO-8601 del evento, o `null` si no es una fecha valida. */
function timestampMs(event: JqValue): number | null {
  const timestamp = get(event, 'timestamp')
  const match = typeof timestamp === 'string' ? TIMESTAMP.exec(timestamp) : null
  if (match === null) return null
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(Number)
  // Rangos que acepta `strptime`; un dia que el mes no tiene pasa al mes siguiente.
  if (month < 1 || month > 12 || day > 31 || hour > 23 || minute > 59 || second > 60) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second)
  return date.getTime() + (match[7] === undefined ? 0 : Number(`${match[7]}000`.slice(0, 3)))
}

interface ToolEvent {
  id: JqValue
  name: JqValue
  ts: number | null
}

/** Bloques `kind` del contenido de los eventos `type`, fechados por su evento. */
function toolEvents(events: readonly JqObject[], type: string, kind: string, idKey: string): ToolEvent[] {
  const found: ToolEvent[] = []
  for (const event of eventsOfType(events, [type])) {
    for (const item of contentItems(event)) {
      if (get(item, 'type') !== kind) continue
      found.push({ id: get(item, idKey), name: get(item, 'name'), ts: timestampMs(event) })
    }
  }
  return found
}

/** Histograma de tool calls por nombre, con el tiempo entre cada `tool_use` y su `tool_result`. */
function toolCalls(events: readonly JqObject[]): JqValue[] {
  const uses = toolEvents(events, 'assistant', 'tool_use', 'id')
  const resultsById = new Map<string, ToolEvent>()
  for (const result of toolEvents(events, 'user', 'tool_result', 'tool_use_id')) resultsById.set(toText(result.id), result)
  return groupBy(uses, (use) => plain(use.name)).map((group) => {
    const durations: number[] = []
    for (const use of group) {
      // Un `tool_use` sin `id` sigue contando: se busca con la clave vacia y no encuentra par.
      const id = use.id === null || use.id === false ? '' : use.id
      if (typeof id !== 'string') throw new JqError(`Cannot index object with ${typeOf(id)}`)
      const result = resultsById.get(id)
      if (result === undefined || use.ts === null || result.ts === null) continue
      durations.push(result.ts - use.ts)
    }
    return {
      name: group[0]?.name ?? null,
      count: group.length,
      duration_ms_sum: durations.length > 0 ? durations.reduce((total, duration) => total + duration, 0) : null,
      duration_ms_median: median(durations),
    }
  })
}

function legacyMetrics(values: readonly JqValue[]): JqValue {
  const events = values.filter(isJqObject)
  const result = eventsOfType(events, ['result']).at(-1) ?? null
  if (result === null) return null
  const init = events.find((event) => get(event, 'type') === 'system' && get(event, 'subtype') === 'init')
  const modelFromInit = get(init, 'model')
  const modelFromAssistant = path(eventsOfType(events, ['assistant'])[0], 'message', 'model')
  const denials = get(result, 'permission_denials')
  return {
    turns: get(result, 'num_turns'),
    duration_ms: get(result, 'duration_ms'),
    duration_api_ms: get(result, 'duration_api_ms'),
    non_api_ms: difference(get(result, 'duration_ms'), get(result, 'duration_api_ms')),
    // `total_cost_usd` de Claude es un dato legado: no se presenta como estimacion (MEF-ADR-0054).
    estimated_cost_usd: null,
    cost_usd: get(result, 'total_cost_usd'),
    tokens: {
      input: path(result, 'usage', 'input_tokens'),
      output: path(result, 'usage', 'output_tokens'),
      cache_read: path(result, 'usage', 'cache_read_input_tokens'),
      cache_write: path(result, 'usage', 'cache_creation_input_tokens'),
      reasoning: path(result, 'usage', 'reasoning_tokens'),
    },
    model: firstTruthy(
      () => modelFromInit,
      () => modelFromAssistant,
    ),
    is_error: get(result, 'is_error'),
    stop_reason: get(result, 'stop_reason'),
    terminal_reason: get(result, 'terminal_reason'),
    ttft_ms: get(result, 'ttft_ms'),
    permission_denials: Array.isArray(denials) ? denials.length : null,
    rate_limit_events: eventsOfType(events, ['rate_limit_event']).length,
    tool_calls: toolCalls(events),
  }
}

/** Metricas del stage cuyo JSONL es `stream`, como JSON compacto; `null` si no hay evento final. */
export function stageMetricsFromStream(stream: string): string {
  const values = streamValues(stream)
  // La forma se elige por vocabulario, nunca por runtime.
  const metrics = anyEvent(values, TERMINAL) ? orNull(() => neutralMetrics(values)) : orNull(() => legacyMetrics(values))
  return dumpJq(metrics)
}

/**
 * Metricas del stage: turnos, duraciones, costo, tokens, modelo, motivo de fin y tool calls. Da el
 * texto `null` si el archivo falta o esta vacio, o si el stage murio antes de escribir su evento final.
 */
export function computeStageMetrics(streamFile: string): string {
  const stream = readNonEmpty(streamFile)
  return stream === null ? 'null' : stageMetricsFromStream(stream.toString('utf8'))
}

export interface StageCorrelation {
  pipeline: string
  eventsFile: string
  /** JSON de `computeStageMetrics`; vacio cuenta como `null`. */
  baseMetrics: string
  issue: string
  /** JSON de la variante: una cadena entre comillas o `null`. */
  variantJson: string
  stage: string
  agent: string
  profile: string
  /** JSON con `harness_version`, `harness_commit` e `identity_state`. */
  identityJson: string
}

/**
 * `baseMetrics` mas las dimensiones de correlacion de la corrida. El modelo pedido sale de
 * `run.started` y el efectivo del evento final. Da el texto `null` si algun JSON es invalido. Si
 * el archivo de eventos no se puede leer, como en bash, da las metricas sin eventos y una segunda
 * linea `null`.
 */
export function enrichStageMetrics(input: StageCorrelation): string {
  let stream = ''
  let unreadable = false
  try {
    stream = readFileSync(input.eventsFile, 'utf8')
  } catch {
    unreadable = true
  }
  const enriched = orNull(() => {
    const metrics = parseJq(input.baseMetrics.length > 0 ? input.baseMetrics : 'null')
    const variant = parseJq(input.variantJson)
    const identity = parseJq(input.identityJson)
    const events = streamValues(stream)
    const started = eventsOfType(events, ['run.started'])[0] ?? null
    const terminal = eventsOfType(events, TERMINAL).at(-1) ?? null
    const orAbsent = (...operands: (() => JqValue)[]): JqValue => firstTruthy(...operands, () => null)
    const requestedModel = orAbsent(() => get(started, 'model'))
    const base = firstTruthy(
      () => metrics,
      () => ({}),
    )
    return add(base, {
      pipeline: input.pipeline,
      issue: input.issue,
      variant,
      stage: input.stage,
      agent: input.agent,
      runtime: orAbsent(
        () => get(terminal, 'runtime'),
        () => get(started, 'runtime'),
      ),
      profile: input.profile,
      requested_model: requestedModel,
      requested_effort: orAbsent(() => get(started, 'effort')),
      effective_model: orAbsent(() => get(terminal, 'model')),
      inherited: requestedModel === null,
      session_id: orAbsent(() => get(terminal, 'session_id')),
      result: orAbsent(() => get(terminal, 'status')),
      error_kind: orAbsent(() => path(terminal, 'error', 'kind')),
      harness_version: get(identity, 'harness_version'),
      harness_commit: get(identity, 'harness_commit'),
      identity_state: get(identity, 'identity_state'),
    })
  })
  if (enriched === null) return 'null'
  return unreadable ? `${dumpJq(enriched)}\nnull` : dumpJq(enriched)
}

/** `enrichStageMetrics` con el pipeline `tooling`. */
export function enrichToolingStageMetrics(input: Omit<StageCorrelation, 'pipeline'>): string {
  return enrichStageMetrics({ ...input, pipeline: 'tooling' })
}
