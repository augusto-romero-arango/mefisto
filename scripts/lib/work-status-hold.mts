// Lectura del ultimo anuncio de espera de un events.log:
// "[HH:MM:SS][hold] <FAMILIA>: esperando, proxima sonda HH:MM:SS (techo HH:MM)".
//
// Gemela de `last_hold_line`, `hold_line_window` y `hold_recently_active` de
// `_pipeline-common.sh`: mientras tengan llamadores en bash, un cambio va en los dos lados.

import { readFileSync, statSync } from 'node:fs'

const DAY_SECONDS = 86_400

/** Ultima linea de anuncio escrita despues de `fromLine`, o `null`. Las de `[hold][resume]` no cuentan. */
export function lastHoldLine(eventsLog: string, fromLine = 0): string | null {
  let content: string
  try {
    if (!statSync(eventsLog).isFile()) return null
    content = readFileSync(eventsLog, 'utf8')
  } catch {
    return null
  }
  const announcements = content
    .split('\n')
    .slice(fromLine)
    .filter((line) => line.includes('][hold] ') && line.includes('esperando, proxima sonda'))
  return announcements.at(-1) ?? null
}

/** Epoch local de `HH:MM:SS` en la fecha de `day`, o `null` si la hora no existe. */
function epochAt(day: Date, hms: string): number | null {
  const [hours = 0, minutes = 0, seconds = 0] = hms.split(':').map(Number)
  if (hours > 23 || minutes > 59 || seconds > 60) return null
  return Math.floor(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, seconds).getTime() / 1000)
}

export interface HoldWindow {
  start: number
  probe: number
}

/**
 * Epochs del anuncio y de su proxima sonda. El log guarda hora sin fecha: una sonda anterior al
 * anuncio cruzo medianoche, y un anuncio en el futuro es de ayer.
 */
export function holdLineWindow(line: string, now: Date): HoldWindow | null {
  const startHms = /^\[(\d{2}:\d{2}:\d{2})\]\[hold\] /.exec(line)?.[1]
  const probeHms = /^.*proxima sonda (\d{2}:\d{2}:\d{2})/s.exec(line)?.[1]
  if (startHms === undefined || probeHms === undefined) return null
  let start = epochAt(now, startHms)
  let probe = epochAt(now, probeHms)
  if (start === null || probe === null) return null
  if (probe < start) probe += DAY_SECONDS
  if (start > Math.floor(now.getTime() / 1000)) {
    start -= DAY_SECONDS
    probe -= DAY_SECONDS
  }
  return { start, probe }
}

/** `true` si la proxima sonda del ultimo anuncio todavia no llego. */
export function holdRecentlyActive(eventsLog: string, now: Date, fromLine = 0): boolean {
  const line = lastHoldLine(eventsLog, fromLine)
  if (line === null || line.length === 0) return false
  const window = holdLineWindow(line, now)
  return window !== null && Math.floor(now.getTime() / 1000) < window.probe
}
