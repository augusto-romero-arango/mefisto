// Log legible y metricas de un stage del pipeline interno, derivados del JSONL neutral que
// escribe el runner. Solo entiende el vocabulario neutral (`message`, `tool.started`,
// `tool.completed`, `run.completed`, `run.failed`): no interpreta el stream nativo de ningun
// runtime.
//
// Gemela de `derive_stage_log_from_stream` y `compute_stage_metrics` de `_mefisto-common.sh`:
// mientras tengan llamadores en bash, un cambio va en los dos lados. Las metricas viajan como el
// texto JSON que imprime jq, que es lo que se escribe en el historial.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import {
  add,
  dumpJq,
  equals,
  firstTruthy,
  get,
  isNumber,
  numberOf,
  path,
  plain,
  subtract,
  typeOf,
} from '../../../../scripts/lib/jq-literals.mts'
import type { JqObject, JqValue } from '../../../../scripts/lib/jq-literals.mts'
import { JqError, groupBy, sortBy } from '../../../../scripts/lib/jq-values.mts'
import { eventsOfType } from '../../../../scripts/lib/pipeline/stage-metrics.mts'
import { hasContent, neutralEvents, terminalEvent } from './mefisto-agent-events.mts'

// --- Log legible ----------------------------------------------------------------

/** Lo que un evento aporta al log, o `undefined` si no aporta nada. */
function logValue(event: JqObject): JqValue | undefined {
  const type = get(event, 'type')
  if (type === 'message') {
    // Sin `kind` el mensaje es texto.
    const kind = firstTruthy(
      () => get(event, 'kind'),
      () => 'text',
    )
    if (kind !== 'text') return undefined
    return firstTruthy(
      () => get(event, 'text'),
      () => '',
    )
  }
  if (type === 'tool.started') {
    const tool = firstTruthy(
      () => get(event, 'tool'),
      () => '?',
    )
    return add('[tool] ', tool)
  }
  if (type === 'run.completed' || type === 'run.failed') {
    const error = get(event, 'error')
    if (error === null || error === false) return undefined
    const kind = firstTruthy(
      () => get(error, 'kind'),
      () => 'error',
    )
    const detail = firstTruthy(
      () => get(error, 'detail'),
      () => '',
    )
    return add(add(kind, ': '), detail)
  }
  return undefined
}

/** Una linea por mensaje de texto, por tool call y por terminal con error; un evento que falla no aporta la suya. */
function logText(events: readonly JqObject[]): string {
  let text = ''
  for (const event of events) {
    let value: JqValue | undefined
    try {
      value = logValue(event)
    } catch (error) {
      if (!(error instanceof JqError)) throw error
      continue
    }
    if (value !== undefined) text += `${typeof value === 'string' ? value : dumpJq(value, 2)}\n`
  }
  return text
}

/**
 * Escribe en `outFile` el log legible del stage: el texto de los mensajes, `[tool] <nombre>` por
 * cada tool call y `<error.kind>: <error.detail>` del terminal fallido, seguido del contenido de
 * `stderrFile` tal cual. Nunca falla: el log es observabilidad.
 */
export function deriveStageLogFromStream(eventsFile: string, stderrFile: string, outFile: string): void {
  try {
    writeFileSync(outFile, logText(neutralEvents(eventsFile)))
  } catch {
    return
  }
  if (!hasContent(stderrFile)) return
  try {
    if (hasContent(outFile)) appendFileSync(outFile, '\n')
    appendFileSync(outFile, readFileSync(stderrFile))
  } catch {
    // Un stderr ilegible no detiene al pipeline.
  }
}

// --- Metricas -------------------------------------------------------------------

/** `add` de jq: la suma empieza en `null`. */
function sum(values: readonly JqValue[]): JqValue {
  return values.reduce<JqValue>((total, value) => add(total, value), null)
}

function median(values: readonly JqValue[]): JqValue {
  const sorted = sortBy(values, plain)
  const count = sorted.length
  if (count === 0) return null
  if (count % 2 === 1) return sorted[(count - 1) / 2] ?? null
  const pair = add(sorted[count / 2 - 1] ?? null, sorted[count / 2] ?? null)
  if (!isNumber(pair)) throw new JqError(`${typeOf(pair)} and number cannot be divided`)
  return numberOf(pair) / 2
}

/**
 * Histograma de tool calls por nombre: `count` cuenta las empezadas (`tool.started`) y las
 * duraciones salen de los `tool.completed` del mismo nombre que traen `duration_ms`. Un
 * `tool.completed` sin su `tool.started` no aparece.
 */
function toolCalls(events: readonly JqObject[]): JqValue[] {
  const byTool = (type: string): JqValue[][] => groupBy(eventsOfType(events, [type]), (event) => plain(get(event, 'tool')))
  const completed = byTool('tool.completed').map((group) => ({
    name: get(group[0], 'tool'),
    durations: group.map((event) => get(event, 'duration_ms')).filter((duration) => duration !== null),
  }))
  return byTool('tool.started').map((group) => {
    const name = get(group[0], 'tool')
    const durations = completed.find((entry) => equals(entry.name, name))?.durations ?? []
    return {
      name,
      count: group.length,
      duration_ms_sum: durations.length > 0 ? sum(durations) : null,
      duration_ms_median: durations.length > 0 ? median(durations) : null,
    }
  })
}

function stageMetrics(events: readonly JqObject[]): JqValue {
  const terminal = terminalEvent(events)
  if (terminal === null) return null
  const duration = get(terminal, 'duration_ms')
  const api = get(terminal, 'api_duration_ms')
  return {
    runtime: get(terminal, 'runtime'),
    model: get(terminal, 'model'),
    status: get(terminal, 'status'),
    error_kind: path(terminal, 'error', 'kind'),
    duration_ms: duration,
    api_duration_ms: api,
    non_api_ms: duration !== null && api !== null ? subtract(duration, api) : null,
    ttft_ms: get(terminal, 'ttft_ms'),
    turns: get(terminal, 'turns'),
    // Se copia tal cual: un terminal legado que solo trae `cost_usd` da `null`, no una estimacion.
    estimated_cost_usd: get(terminal, 'estimated_cost_usd'),
    tokens: {
      input: path(terminal, 'tokens', 'input'),
      output: path(terminal, 'tokens', 'output'),
      cache_read: path(terminal, 'tokens', 'cache_read'),
      cache_write: path(terminal, 'tokens', 'cache_write'),
      reasoning: path(terminal, 'tokens', 'reasoning'),
    },
    denials: get(terminal, 'denials'),
    tool_calls: toolCalls(events),
  }
}

/**
 * Metricas del stage: runtime, modelo, estado, duraciones, costo estimado, tokens, denials y tool
 * calls, copiados del terminal. Da el texto `null` si el archivo falta o esta vacio, si el stage
 * murio antes de escribir su terminal o si el terminal no tiene la forma del contrato.
 */
export function computeStageMetrics(eventsFile: string): string {
  try {
    return dumpJq(stageMetrics(neutralEvents(eventsFile)))
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return 'null'
  }
}
