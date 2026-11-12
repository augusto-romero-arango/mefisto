// Lectura del terminal (`run.completed` o `run.failed`) del JSONL neutral de un stage del
// pipeline interno. Lee linea por linea: una truncada o que no es un objeto JSON se descarta sin
// perder las demas, y solo cuenta el ultimo terminal.

import { statSync } from 'node:fs'

import { dumpJq, firstTruthy, get, isJqObject } from '../../../../scripts/lib/jq-literals.mts'
import type { JqObject, JqValue } from '../../../../scripts/lib/jq-literals.mts'
import { JqError } from '../../../../scripts/lib/jq-values.mts'
import { readText } from '../../../../scripts/lib/pipeline/agent-events.mts'
import { streamValues } from '../../../../scripts/lib/pipeline/stage-metrics.mts'

/** `true` si `file` existe y no esta vacio (`[ -s archivo ]`). */
export function hasContent(file: string): boolean {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

/** Objetos JSON de `eventsFile`, uno por linea; ninguno si el archivo falta o no se puede leer. */
export function neutralEvents(eventsFile: string): JqObject[] {
  return streamValues(readText(eventsFile)).filter(isJqObject)
}

/** Ultimo `run.completed` o `run.failed` de `events`, o `null` si no hay. */
export function terminalEvent(events: readonly JqObject[]): JqObject | null {
  return (
    events.findLast((event) => {
      const type = get(event, 'type')
      return type === 'run.completed' || type === 'run.failed'
    }) ?? null
  )
}

// Lo que una sustitucion de comando de bash conserva de la salida de `jq -r`.
function captured(value: JqValue): string {
  const text = typeof value === 'string' ? value : dumpJq(value, 2)
  return text.replaceAll('\0', '').replace(/\n+$/, '')
}

/** Texto de lo que `pick` saca del terminal; vacio si es `null` o `false`, o si `pick` falla. */
function terminalText(eventsFile: string, pick: (terminal: JqObject | null) => JqValue): string {
  try {
    const value = pick(terminalEvent(neutralEvents(eventsFile)))
    return value === null || value === false ? '' : captured(value)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return ''
  }
}

/** `true` si el terminal es `run.completed` con `status: success`. Ante la duda, `false`. */
export function agentStreamCompletedSuccessfully(eventsFile: string): boolean {
  const terminal = terminalEvent(neutralEvents(eventsFile))
  return get(terminal, 'type') === 'run.completed' && get(terminal, 'status') === 'success'
}

/** `error.<field>` del terminal (`kind` si `field` va vacio), o cadena vacia si no hay terminal o no trae ese dato. */
export function agentEventsErrorField(eventsFile: string, field = ''): string {
  return terminalText(eventsFile, (terminal) =>
    get(
      firstTruthy(
        () => get(terminal, 'error'),
        () => ({}),
      ),
      field.length > 0 ? field : 'kind',
    ),
  )
}

/** `error.kind` del terminal. */
export function agentEventsErrorKind(eventsFile: string): string {
  return agentEventsErrorField(eventsFile, 'kind')
}

/** `error.detail` del terminal: el texto crudo del fallo. */
export function agentEventsErrorDetail(eventsFile: string): string {
  return agentEventsErrorField(eventsFile, 'detail')
}

/** `resets_at` de la raiz del terminal: el instante en que se levanta el limite de uso. */
export function agentEventsResetsAt(eventsFile: string): string {
  return terminalText(eventsFile, (terminal) => get(terminal, 'resets_at'))
}

/** `session_id` del terminal, la llave para reanudar la sesion. */
export function agentEventsSessionId(eventsFile: string): string {
  return terminalText(eventsFile, (terminal) => get(terminal, 'session_id'))
}
