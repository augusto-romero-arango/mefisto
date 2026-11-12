// Objeto `agents` de una entrada de `pipeline-history.jsonl` del pipeline interno, con sus dos
// stages fijos: writer y reviewer.

import { dumpJq, get, parseJq } from '../../../../scripts/lib/jq-literals.mts'
import { JqError } from '../../../../scripts/lib/jq-values.mts'

export interface AgentRun {
  /** Segundos del stage en texto; vacio da `duration: null`. */
  duration: string
  /** JSON de `computeStageMetrics`; vacio da `metrics: null`. */
  metrics: string
}

/**
 * `agents` como JSON compacto: por cada stage su duracion, sus metricas y el runtime de esas
 * metricas promovido a la raiz. Si una duracion o unas metricas no son JSON, o las metricas no
 * son un objeto, degrada a solo `duration` por stage, con la duracion copiada tal cual.
 */
export function buildAgentsHistoryJson(writer: AgentRun, reviewer: AgentRun): string {
  const orNull = (text: string): string => (text.length > 0 ? text : 'null')
  const writerDuration = orNull(writer.duration)
  const reviewerDuration = orNull(reviewer.duration)
  try {
    const stage = (duration: string, metricsText: string) => {
      const metrics = parseJq(orNull(metricsText))
      return { duration: parseJq(duration), metrics, runtime: get(metrics, 'runtime') }
    }
    return dumpJq({ writer: stage(writerDuration, writer.metrics), reviewer: stage(reviewerDuration, reviewer.metrics) })
  } catch (error) {
    if (!(error instanceof JqError)) throw error
  }
  return `{"writer":{"duration":${writerDuration}},"reviewer":{"duration":${reviewerDuration}}}`
}
