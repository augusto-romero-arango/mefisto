// Archivo de status de una corrida (`pipeline-status-*.json`): el texto que escribia el heredoc
// de `update_status` de cada pipeline, con sus claves en el orden que leen los mods y
// `work-status-collect.mts`, y el bloque `hold` de una espera (MEF-ADR-0051).

import { readFileSync, writeFileSync } from 'node:fs'

const two = (value: number): string => String(value).padStart(2, '0')

/** `YYYYMMDD-HHMMSS` en hora local: la marca que nombra los archivos de una corrida. */
export function runStamp(date: Date): string {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

/** `YYYY-MM-DDTHH:MM:SS` en hora local, sin zona. */
export function localIsoSeconds(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** `YYYY-MM-DDTHH:MM:SSZ` de un epoch en segundos. */
export function utcIsoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Espera en curso de una invocacion de agente; fuera de una espera solo cuenta lo acumulado. */
export interface HoldState {
  /** Etiqueta del fallo que causo la espera. */
  cause: string | null
  /** Instante estimado de la proxima sonda, en UTC. */
  nextProbe: string | null
  ceilingSeconds: number | null
  accumulatedSeconds: number
}

export function noHold(accumulatedSeconds = 0): HoldState {
  return { cause: null, nextProbe: null, ceilingSeconds: null, accumulatedSeconds }
}

/** Texto JSON de una cadena. */
export function jsonText(value: string): string {
  return JSON.stringify(value)
}

/** Texto JSON de una cadena, o `null` si esta vacia. */
export function jsonTextOrNull(value: string): string {
  return value.length > 0 ? JSON.stringify(value) : 'null'
}

export function holdJson(hold: HoldState): string {
  const cause = hold.cause === null ? 'null' : jsonText(hold.cause)
  const nextProbe = hold.nextProbe === null ? 'null' : jsonText(hold.nextProbe)
  return `{"cause": ${cause}, "next_probe": ${nextProbe}, "ceiling_seconds": ${hold.ceilingSeconds ?? 'null'}, "accumulated_seconds": ${hold.accumulatedSeconds}}`
}

/** Un campo del status, con su valor ya como texto JSON. */
export interface StatusField {
  key: string
  json: string
}

/** Un objeto anidado del status (`agents`), con una linea por miembro y los valores alineados. */
export interface StatusGroup {
  key: string
  members: readonly StatusField[]
}

export type StatusEntry = StatusField | StatusGroup

/**
 * Texto del status: una linea por campo en el orden dado y, al final, el bloque `hold`. Los
 * valores llegan como texto JSON y se insertan tal cual: quien llama decide como se codifican.
 */
export function renderStatusJson(entries: readonly StatusEntry[], hold: HoldState): string {
  const lines = entries.map((entry) => {
    if (!('members' in entry)) return `  "${entry.key}": ${entry.json}`
    const width = Math.max(0, ...entry.members.map((member) => member.key.length))
    const members = entry.members.map(
      (member) => `    "${member.key}":${' '.repeat(width - member.key.length + 1)}${member.json}`,
    )
    return `  "${entry.key}": {\n${members.join(',\n')}\n  }`
  })
  return `{\n${lines.join(',\n')}\n  ,"hold": ${holdJson(hold)}\n}\n`
}

export function writeStatus(file: string, text: string): void {
  writeFileSync(file, text)
}

/** `state` del status de `file`, o `null` si el archivo falta o no es un objeto JSON. */
export function statusState(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const state = (parsed as Record<string, unknown>).state
    return typeof state === 'string' ? state : null
  } catch {
    return null
  }
}

/** `true` si la corrida de `file` sigue viva segun su status: `running` o `hold`. */
export function statusIsActive(file: string): boolean {
  const state = statusState(file)
  return state === 'running' || state === 'hold'
}
