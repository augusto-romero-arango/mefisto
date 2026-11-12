// Clasificacion del fallo de una invocacion de agente: de ella depende que un pipeline
// reintente, espere (hold) o aborte (MEF-ADR-0051).

import { agentEventsKind } from './agent-events.mts'

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

/**
 * `true` si el fallo amerita esperar en vez de abortar: limite de uso o proveedor caido. Compara
 * por prefijo, porque la etiqueta puede traer el codigo de salida (`RATE_LIMIT (exit 1)`).
 */
export function agentFailureIsHoldable(failureType: string): boolean {
  return failureType.startsWith('RATE_LIMIT') || failureType.startsWith('PROVIDER_UNAVAILABLE')
}
