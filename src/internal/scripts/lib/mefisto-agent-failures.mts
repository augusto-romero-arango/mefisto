// Politica ante el fallo de un agente del pipeline interno: la etiqueta del fallo, si se
// reintenta, si es irrecuperable y si el trabajo que dejo en el worktree es confiable.

import type { Run } from '../../../../scripts/lib/azure-cli.mts'
import { capture } from '../../../../scripts/lib/cli.mts'
import { agentEventsErrorKind, agentStreamCompletedSuccessfully, hasContent } from './mefisto-agent-events.mts'

/** Codigos de salida de un proceso que murio por SIGKILL o SIGTERM. */
const SIGNAL_EXITS = new Set(['137', '143'])

/**
 * `true` si el fallo nunca admite recuperar el trabajo del stage: el watchdog agoto el tiempo
 * (`timedOut`), el proceso murio por una senal o el stream se corto a mitad de respuesta. Un
 * terminal de exito lo exime: la muerte fue posterior al trabajo.
 */
export function agentFailureIsUnrecoverable(timedOut: boolean, exitCode: number | string, eventsFile: string): boolean {
  if (agentStreamCompletedSuccessfully(eventsFile)) return false
  if (timedOut || SIGNAL_EXITS.has(String(exitCode))) return true
  return agentEventsErrorKind(eventsFile) === 'stream_cut'
}

const FAILURE_BY_KIND = new Map<string, string>([
  ['rate_limit', 'RATE_LIMIT'],
  ['provider_unavailable', 'PROVIDER_UNAVAILABLE'],
  ['api_error', 'API_ERROR_CLIENT'],
  ['stream_cut', 'STREAM_CUT'],
])

/**
 * Etiqueta del fallo de una invocacion del runner, para events.log. El orden importa: el timeout
 * del watchdog gana a todo y una senal gana al `error.kind` del terminal de `eventsFile`.
 */
export function classifyAgentFailure(
  timedOut: boolean,
  exitCode: number | string,
  elapsedSeconds: number | string,
  eventsFile: string,
): string {
  const exit = String(exitCode)
  if (timedOut) return `TIMEOUT (${elapsedSeconds}s, exit ${exit})`
  if (SIGNAL_EXITS.has(exit)) {
    const moment = agentStreamCompletedSuccessfully(eventsFile) ? 'SIGNAL_POST_SUCCESS' : 'SIGNAL_MID_FLIGHT'
    return `${moment} (exit ${exit}, ${elapsedSeconds}s)`
  }
  return `${FAILURE_BY_KIND.get(agentEventsErrorKind(eventsFile)) ?? 'CLI_ERROR'} (exit ${exit})`
}

/**
 * `true` si el fallo es transitorio del lado del proveedor, el unico que se reintenta tal cual.
 * Compara por prefijo, porque la etiqueta trae el codigo de salida (`PROVIDER_UNAVAILABLE (exit 1)`).
 */
export function agentFailureIsRetryable(failureType: string): boolean {
  return failureType.startsWith('PROVIDER_UNAVAILABLE')
}

/**
 * `true` si el trabajo que dejo un agente fallido en `worktree` sirve para dar el stage por
 * hecho: el fallo es recuperable, el agente alcanzo a escribir su resumen (`summaryFile`, lo
 * ultimo que hace) y hay cambios contra `base` o sin commitear. Un `git diff` que falla cuenta
 * como cambios.
 */
export function agentWorkIsTrustworthy(
  worktree: string,
  base: string,
  unrecoverable: boolean,
  summaryFile: string,
  run: Run = capture,
): boolean {
  if (unrecoverable) return false
  if (!hasContent(summaryFile)) return false
  const range = `${base.length > 0 ? base : 'HEAD'}..HEAD`
  if (run('git', ['-C', worktree, 'diff', '--quiet', range]).status !== 0) return true
  return run('git', ['-C', worktree, 'status', '--porcelain']).stdout.replace(/\n+$/, '').length > 0
}
