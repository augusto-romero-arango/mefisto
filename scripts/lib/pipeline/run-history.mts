// Cierre de una corrida: tabla de metricas del cuerpo del PR, objeto `agents` del historial y
// registro de la entrada en `pipeline-history.jsonl`.
//
// Gemela de `_render_run_metric_count`, `render_run_metrics_table`, `build_agents_history_json` y
// `append_completed_history` de `_pipeline-common.sh`: mientras tengan llamadores en bash, un
// cambio va en los dos lados. Las metricas de cada etapa llegan como el texto JSON de
// `computeStageMetrics`.

import { appendFileSync, closeSync, openSync, writeSync } from 'node:fs'

import {
  add,
  dumpJq,
  get,
  isJqObject,
  isNumber,
  numberOf,
  parseJq,
  parseJqStream,
  path,
  toNumber,
  toText,
} from '../jq-literals.mts'
import type { JqObject, JqValue } from '../jq-literals.mts'
import { JqError } from '../jq-values.mts'
import { fixed } from '../metrics-report.mts'

const DIGITS = /^[0-9]+$/

function compact(count: number): string {
  if (count >= 1_000_000) return `${fixed(count / 1_000_000, 2)}M`
  if (count >= 1000) return `${fixed(count / 1000, 1)}k`.replace(/\.0k$/, 'k')
  return String(count)
}

/** Conteo compacto (`117k`, `1.32M`) de un entero en texto; `-` si no lo es. */
export function renderRunMetricCount(count: string): string {
  return DIGITS.test(count) ? compact(Number(count)) : '-'
}

const minutes = (seconds: number): string => `${Math.trunc(seconds / 60)}m ${seconds % 60}s`
const cell = (text: string): string => text.replaceAll('\n', ' ').replaceAll('|', '\\|')

const FIELD_SEPARATOR = '\u001c'

/** Texto de un contador de tokens: un entero no negativo, o vacio. */
function countText(value: JqValue): string {
  if (!isNumber(value)) return ''
  const count = numberOf(value)
  return Math.floor(count) === count && count >= 0 ? toText(value) : ''
}

function metricsRow(metrics: JqObject): string {
  const model = get(metrics, 'model')
  const cost = get(metrics, 'estimated_cost_usd')
  return [
    typeof model === 'string' && model !== '' ? model : '-',
    countText(path(metrics, 'tokens', 'input')),
    countText(path(metrics, 'tokens', 'output')),
    countText(path(metrics, 'tokens', 'cache_read')),
    countText(path(metrics, 'tokens', 'cache_write')),
    countText(path(metrics, 'tokens', 'reasoning')),
    isNumber(cost) && numberOf(cost) >= 0 ? toText(cost) : '',
  ].join(FIELD_SEPARATOR)
}

/** Campos de las metricas de una etapa, o `null` si el JSON es invalido o no trae un objeto. */
function metricsFields(metrics: string): string[] | null {
  const stream = parseJqStream(metrics)
  if (!stream.clean) return null
  let rows: string
  try {
    rows = stream.values
      .filter(isJqObject)
      .map((value) => `${metricsRow(value)}\n`)
      .join('')
      .replace(/\n+$/, '')
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return null
  }
  if (rows.length === 0) return null
  const fields = (rows.split('\n')[0] ?? '').split(FIELD_SEPARATOR)
  return [...fields.slice(0, 6), fields.slice(6).join(FIELD_SEPARATOR)]
}

export interface RunStage {
  label: string
  /** Segundos de la etapa; lo que no es un entero no negativo sale como `-`. */
  duration: string | number | null
  /** JSON de las metricas de la etapa; vacio, `null` o invalido degradan sus celdas a `-`. */
  metrics: string
}

/**
 * Tabla Markdown de metricas de una corrida, con una fila por etapa y la fila Total. El total es
 * parcial si a alguna etapa le falta un contador de tokens, la duracion o el costo. Solo presenta
 * el modelo, los tokens y el costo estimado que fijo el evento final: no recalcula precios
 * (MEF-ADR-0054).
 */
export function renderRunMetricsTable(stages: readonly RunStage[]): string {
  const lines = [
    '| Etapa | Modelo | Tokens | in/out/cache/reasoning | Tiempo | Costo estimado |',
    '|---|---|---:|---|---:|---:|',
  ]
  let totalTokens = 0
  let totalDuration = 0
  // El acumulado se redondea a 12 decimales en cada suma, como el `printf` de bash.
  let totalCost = '0'
  let costValues = 0
  let tokensComplete = true
  let durationComplete = true
  let costComplete = true

  for (const stage of stages) {
    let model = '-'
    let tokens = '-'
    let breakdown = '-'
    let duration = '-'
    let cost = '-'

    const seconds = stage.duration === null ? '' : String(stage.duration)
    if (DIGITS.test(seconds)) {
      duration = minutes(Number(seconds))
      totalDuration += Number(seconds)
    } else durationComplete = false

    const fields = stage.metrics.length > 0 ? metricsFields(stage.metrics) : null
    if (fields === null) {
      tokensComplete = false
      costComplete = false
    } else {
      const [name = '', input = '', output = '', cacheRead = '', cacheWrite = '', reasoning = '', costText = ''] = fields
      model = cell(name)
      const counters = [input, output, cacheRead, cacheWrite, reasoning]
      const cache = DIGITS.test(cacheRead) && DIGITS.test(cacheWrite) ? String(Number(cacheRead) + Number(cacheWrite)) : ''
      breakdown = [input, output, cache, reasoning].map(renderRunMetricCount).join(' / ')
      if (counters.every((counter) => DIGITS.test(counter))) {
        const sum = counters.reduce((total, counter) => total + Number(counter), 0)
        tokens = compact(sum)
        totalTokens += sum
      } else tokensComplete = false
      if (costText.length > 0) {
        cost = `$${fixed(Number(costText), 2)}`
        totalCost = fixed(Number(totalCost) + Number(costText), 12)
        costValues++
      } else costComplete = false
    }
    lines.push(`| ${cell(stage.label)} | ${model} | ${tokens} | ${breakdown} | ${duration} | ${cost} |`)
  }

  const complete = tokensComplete && durationComplete && costComplete
  lines.push(
    [
      `| ${complete ? '**Total**' : '**Total (parcial)**'}`,
      '-',
      tokensComplete ? `**${compact(totalTokens)}**` : '-',
      '-',
      durationComplete ? `**${minutes(totalDuration)}**` : '-',
      `${costValues > 0 ? `**$${fixed(Number(totalCost), 2)}**` : '-'} |`,
    ].join(' | '),
  )
  return `${lines.join('\n')}\n`
}

export interface AgentStage {
  /** Clave del stage en `agents` (`test-writer`, `reviewer`, ...). */
  key: string
  /** Agente despachado bajo esa clave; vacio no agrega `metrics.agent`. */
  agent: string
  /** Segundos del stage en texto; vacio o `null` dan `duration: null`. */
  duration: string
  /** JSON de las metricas del stage; vacio, `null` o invalido dan `metrics: null`. */
  metrics: string
}

function durationValue(text: string): JqValue {
  if (text === '' || text === 'null') return null
  try {
    return toNumber(text)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return null
  }
}

function metricsValue(text: string): JqValue {
  if (text === '' || text === 'null') return null
  try {
    return parseJq(text)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return null
  }
}

/**
 * Objeto `agents` de una entrada del historial, como JSON compacto: por cada stage, su duracion y
 * sus metricas con el agente real dentro de `metrics.agent`. Sin metricas no hay donde anidar el
 * agente y esa atribucion se pierde. Si unas metricas no son un objeto, degrada a solo `duration`
 * por clave.
 */
export function buildAgentsHistoryJson(stages: readonly AgentStage[]): string {
  try {
    const agents: JqObject = {}
    for (const stage of stages) {
      const metrics = metricsValue(stage.metrics)
      const attributed = metrics === null || stage.agent === '' ? metrics : add(metrics, { agent: stage.agent })
      Object.defineProperty(agents, stage.key, {
        value: { duration: durationValue(stage.duration), metrics: attributed },
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    return dumpJq(agents)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
  }
  const flat = stages.map((stage) => `"${stage.key}":{"duration":${stage.duration === '' ? 'null' : stage.duration}}`)
  return `{${flat.join(',')}}`
}

export interface HistoryDeps {
  warn: (message: string) => void
  now: () => Date
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * Agrega al historial la entrada que produce `entry`. Corre despues de crear el PR, asi que un
 * fallo no detiene nada: avisa, deja evidencia en `eventsLog` y devuelve `false`.
 */
export function appendCompletedHistory(
  historyFile: string,
  eventsLog: string,
  entry: () => string,
  deps: HistoryDeps = { warn: (message) => console.error(message), now: () => new Date() },
): boolean {
  try {
    // El archivo se abre antes de producir la entrada: existe aunque la entrada falle.
    const history = openSync(historyFile, 'a')
    try {
      const line = entry()
      if (line.length > 0) writeSync(history, line.endsWith('\n') ? line : `${line}\n`)
    } finally {
      closeSync(history)
    }
    return true
  } catch {
    // Cae al aviso.
  }
  try {
    deps.warn('No se pudo registrar el historial completado; el PR ya fue creado')
  } catch {
    // Un aviso que falla tampoco detiene el cierre.
  }
  const now = deps.now()
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
  try {
    appendFileSync(eventsLog, `[${time}] WARN: no se pudo registrar el historial completado; el PR ya fue creado\n`)
  } catch {
    // Sin events log no queda evidencia, pero el cierre sigue.
  }
  return false
}
