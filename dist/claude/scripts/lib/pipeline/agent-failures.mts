// Clasificacion del fallo de una invocacion de agente: de ella depende que un pipeline
// reintente, espere (hold) o aborte (MEF-ADR-0051).
//
// Gemela de `classify_neutral_agent_failure`, `classify_agent_failure` y
// `agent_failure_is_holdable` de `_pipeline-common.sh`: mientras tengan llamadores en bash, un
// cambio va en los dos lados.

import { statSync } from 'node:fs'

import { JqError, alt, path } from '../jq-values.mts'
import { agentEventsKind, jsonLineObjects, readText } from './agent-events.mts'

const FAILURE_BY_KIND = new Map<string, string>([
  ['provider_unavailable', 'PROVIDER_UNAVAILABLE'],
  ['rate_limit', 'RATE_LIMIT'],
  ['timeout', 'TIMEOUT'],
  ['killed', 'KILLED'],
  ['stream_cut', 'STREAM_CUT'],
  ['protocol_invalid', 'PROTOCOL_INVALID'],
  ['api_error', 'API_ERROR_CLIENT'],
])

/**
 * Etiqueta de fallo a partir del codigo de salida del runner neutral y del `error.kind` del
 * terminal de `eventsFile`. Lo que no se reconoce es `CLI_ERROR`.
 */
export function classifyNeutralAgentFailure(runExit: number | string, eventsFile: string): string {
  const exit = String(runExit)
  if (exit === '124') return 'TIMEOUT'
  if (exit === '65') return 'PROTOCOL_INVALID'
  const kind = agentEventsKind(eventsFile).replace(/\n+$/, '')
  return FAILURE_BY_KIND.get(kind) ?? 'CLI_ERROR'
}

// Evento estructurado del stream crudo del CLI: una ventana de uso que ya no esta `allowed`.
function rateLimitRejected(streamFile: string): boolean {
  if (streamFile.length === 0) return false
  try {
    if (statSync(streamFile).size === 0) return false
  } catch {
    return false
  }
  try {
    return (
      jsonLineObjects(readText(streamFile))
        .filter((event) => event.type === 'rate_limit_event')
        .filter((event) => alt(path(event, 'rate_limit_info', 'status'), 'allowed') !== 'allowed').length > 0
    )
  } catch (error) {
    if (error instanceof JqError) return false
    throw error
  }
}

// Sin stream: un 429 solo cuenta junto a un indicio de limite, para no confundir otro 4xx.
const RATE_LIMIT_TEXT = /rate[^\n]?limit|usage[^\n]?limit/i

/**
 * Etiqueta de fallo de una invocacion directa del CLI, leida del log derivado del stage y, si se
 * capturo, del stream crudo. El orden importa: la senal gana a todo y el limite de uso se
 * decide antes que `API Error: 4`.
 */
export function classifyAgentFailure(
  exitCode: number | string,
  elapsedSeconds: number | string,
  logStage: string,
  streamFile = '',
): string {
  const exit = String(exitCode)
  if (exit === '137' || exit === '143') return `TIMEOUT (signal ${exit}, ${elapsedSeconds}s)`
  if (rateLimitRejected(streamFile)) return `RATE_LIMIT (exit ${exit})`
  const log = readText(logStage)
  if (log.includes('429') && RATE_LIMIT_TEXT.test(log)) return `RATE_LIMIT (exit ${exit})`
  if (log.includes('API Error: 5')) return `PROVIDER_UNAVAILABLE (exit ${exit})`
  if (log.includes('API Error: 4')) return `API_ERROR_CLIENT (exit ${exit})`
  return `CLI_ERROR (exit ${exit})`
}

/**
 * `true` si el fallo amerita esperar en vez de abortar: limite de uso o proveedor caido. Compara
 * por prefijo, porque la etiqueta puede traer el codigo de salida (`RATE_LIMIT (exit 1)`).
 */
export function agentFailureIsHoldable(failureType: string): boolean {
  return failureType.startsWith('RATE_LIMIT') || failureType.startsWith('PROVIDER_UNAVAILABLE')
}
