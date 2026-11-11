// Lectura del terminal (`run.completed` o `run.failed`) del JSONL neutral de una corrida de
// agente: es la unica autoridad para la politica de un pipeline.
//
// Gemela de `agent_events_value`, `agent_events_kind`, `agent_events_resets_at`,
// `agent_events_session_id`, `agent_events_denials` y `agent_events_completed_successfully` de
// `_pipeline-common.sh`: mientras tengan llamadores en bash, un cambio va en los dos lados.

import { readFileSync, statSync } from 'node:fs'

import { JqError, alt, dump, get, isObject, parseStream, path } from '../jq-values.mts'
import type { Json, JsonObject } from '../jq-values.mts'

/** Contenido de `file`, o cadena vacia si no se puede leer. */
export function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Objetos JSON de un texto con uno por linea; una linea que no lo es se descarta sin perder las demas. */
export function jsonLineObjects(text: string): JsonObject[] {
  const objects: JsonObject[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const value = JSON.parse(line) as Json
      if (isObject(value)) objects.push(value)
    } catch {
      // Linea truncada o que no es JSON.
    }
  }
  return objects
}

// Como `jq -s` tras comprobar que el archivo no esta vacio: un solo valor que no sea JSON
// invalida la lectura entera, y lo que no se puede abrir (un directorio) se lee como cero eventos.
function slurp(file: string): Json[] | null {
  try {
    if (statSync(file).size === 0) return null
  } catch {
    return null
  }
  const parsed = parseStream(readText(file))
  return parsed.clean ? parsed.values : null
}

function terminals(events: Json[]): Json[] {
  return events.filter((event) => {
    const type = get(event, 'type')
    return type === 'run.failed' || type === 'run.completed'
  })
}

// Lo que no es objeto donde el filtro espera uno aborta el filtro de la gemela, que no imprime nada.
function orOnFailure<T>(fallback: T, read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof JqError) return fallback
    throw error
  }
}

/**
 * Texto, como lo imprime `jq -r`, del ultimo valor que `pick` saca de un terminal de `eventsFile`
 * (`null` y `false` no cuentan), o de `fallback` si ninguno lo trae. Cadena vacia sin archivo,
 * sin valor o con un JSONL ilegible.
 */
export function agentEventsValue(eventsFile: string, pick: (terminal: Json) => Json, fallback: Json = null): string {
  const events = slurp(eventsFile)
  if (events === null) return ''
  return orOnFailure('', () => {
    const values = terminals(events)
      .map(pick)
      .filter((value) => value !== null && value !== false)
    const value = alt(values.at(-1) ?? null, fallback)
    if (value === null) return ''
    return typeof value === 'string' ? value : dump(value, 2)
  })
}

/** `error.kind` del terminal. */
export function agentEventsKind(eventsFile: string): string {
  return agentEventsValue(eventsFile, (terminal) => path(terminal, 'error', 'kind'))
}

/** Instante en que se levanta el limite de uso: `error.resets_at` o `resets_at` del terminal. */
export function agentEventsResetsAt(eventsFile: string): string {
  return agentEventsValue(eventsFile, (terminal) => alt(path(terminal, 'error', 'resets_at'), get(terminal, 'resets_at')))
}

/** `session_id` del terminal, la llave para reanudar la sesion. */
export function agentEventsSessionId(eventsFile: string): string {
  return agentEventsValue(eventsFile, (terminal) => get(terminal, 'session_id'))
}

/** `denials` del ultimo terminal, `0` si no lo trae. Es texto: el llamador decide si es un entero. */
export function agentEventsDenials(eventsFile: string): string {
  return agentEventsValue(eventsFile, (terminal) => alt(get(terminal, 'denials'), 0), 0)
}

/** `true` si el ultimo terminal es `run.completed` con `status: success`. */
export function agentEventsCompletedSuccessfully(eventsFile: string): boolean {
  const events = slurp(eventsFile)
  if (events === null) return false
  return orOnFailure(false, () => {
    const last = terminals(events).at(-1) ?? null
    return get(last, 'type') === 'run.completed' && get(last, 'status') === 'success'
  })
}
