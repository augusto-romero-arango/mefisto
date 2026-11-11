// Anotaciones de la invocacion de agentes en events.log: `[HH:MM:SS]...`, una por linea.

import { appendFileSync } from 'node:fs'

const two = (value: number): string => String(value).padStart(2, '0')

/** `HH:MM` en hora local. */
export function clockMinutes(date: Date): string {
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** `HH:MM:SS` en hora local. */
export function clockTime(date: Date): string {
  return `${clockMinutes(date)}:${two(date.getSeconds())}`
}

/** Agrega `line` a `eventsLog`. No poder anotar no cancela lo que el pipeline esta haciendo. */
export function appendEventsLine(eventsLog: string, line: string): void {
  try {
    appendFileSync(eventsLog, `${line}\n`)
  } catch {
    // Sin events.log escribible solo se pierde la anotacion.
  }
}
