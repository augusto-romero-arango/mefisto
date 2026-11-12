// Registro del batch interno: estado de cada issue, `pipeline-status-mefisto-batch.json` que lee
// el mod mefisto-divine-wager (MEF-ADR-0055) y la espera (hold) que cada eslabon dejo anotada en
// events.log.

import { readFileSync, rmSync, statSync } from 'node:fs'

import { dump } from '../../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../../scripts/lib/jq-values.mts'

export interface BatchEntry {
  issue: string
  /** Texto libre: `pendiente`, `en curso`, `completado (...)`, `ERROR: ...`, `saltado: ...`, `aplazado (...)`. */
  status: string
  pr: string
}

export interface BatchTracker {
  entries: BatchEntry[]
  /** Corre tras cada cambio: reescribe el status del batch. */
  onChange: () => void
}

export function newBatchTracker(onChange: () => void = () => {}): BatchTracker {
  return { entries: [], onChange }
}

export function setStatus(tracker: BatchTracker, issue: string, status: string): void {
  const entry = tracker.entries.find((candidate) => candidate.issue === issue)
  if (entry === undefined) tracker.entries.push({ issue, status, pr: '' })
  else entry.status = status
  tracker.onChange()
}

export function getStatus(tracker: BatchTracker, issue: string): string {
  return tracker.entries.find((entry) => entry.issue === issue)?.status ?? 'desconocido'
}

export function setPr(tracker: BatchTracker, issue: string, pr: string): void {
  const entry = tracker.entries.find((candidate) => candidate.issue === issue)
  if (entry === undefined) tracker.entries.push({ issue, status: 'pendiente', pr })
  else entry.pr = pr
  tracker.onChange()
}

export function getPr(tracker: BatchTracker, issue: string): string {
  return tracker.entries.find((entry) => entry.issue === issue)?.pr ?? ''
}

export const DEFERRED_STATUS = 'aplazado (parada solicitada; no se proceso en esta corrida)'

/**
 * Consume la senal de parada y deja `aplazado` cada issue de `issues` desde `from`. Una parada
 * pedida no es un fallo: no toca contadores ni el codigo de salida.
 */
export function deferFromIndex(tracker: BatchTracker, issues: readonly string[], from: number, signalFile: string): void {
  rmSync(signalFile, { force: true })
  for (const issue of issues.slice(from)) setStatus(tracker, issue, DEFERRED_STATUS)
}

export interface BatchStatusInput {
  started: string
  state: string
  /** Issue del ultimo eslabon arrancado, o vacio. */
  current: string
  stopRequested: boolean
  holdSeconds: number
  log: string
  entries: readonly BatchEntry[]
}

/** El JSON que el bash armaba con jq: issue y PR como texto, el estado libre tal cual. */
export function renderBatchStatus(input: BatchStatusInput): string {
  const issues: Json[] = input.entries.map((entry) => ({
    issue: entry.issue,
    status: entry.status,
    pr: entry.pr === '' ? null : entry.pr,
  }))
  const value: Json = {
    pipeline: 'mefisto-batch',
    started: input.started,
    state: input.state,
    current: input.current === '' ? null : input.current,
    stop_requested: input.stopRequested,
    hold_seconds: input.holdSeconds,
    log: input.log,
    issues,
  }
  return `${dump(value, 2)}\n`
}

const SESSION = /^=== SESSION MEFISTO-TOOLING [^ ]+ issue:([0-9]+)/
const HOLD = /^\[([0-9]{2}:[0-9]{2}:[0-9]{2})\]\[hold\] [^:]+: esperando, proxima sonda ([0-9]{2}:[0-9]{2}:[0-9]{2})/

/** Epoch en segundos de `HH:MM:SS` en el dia local de `today`, o `null` si no es una hora. */
function epochToday(clock: string, today: Date): number | null {
  const [hours = 0, minutes = 0, seconds = 0] = clock.split(':').map(Number)
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  return Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours, minutes, seconds).getTime() / 1000)
}

/**
 * Segundos en espera anunciados en `eventsLog` despues de la linea `fromLine`: lo que va de cada
 * anuncio `[hold]` a su proxima sonda, un dia mas si cruzo la medianoche. Con `issue`, solo los
 * anuncios bajo una cabecera `=== SESSION MEFISTO-TOOLING <ts> issue:<issue>`, la unica marca de
 * events.log que nombra el issue; asi otra corrida del mismo checkout no le regala sus esperas.
 */
export function holdSecondsInRange(eventsLog: string, fromLine: number, issue = '', today: Date = new Date()): number {
  let content: string
  try {
    if (!statSync(eventsLog).isFile()) return 0
    content = readFileSync(eventsLog, 'utf8')
  } catch {
    return 0
  }
  const lines = content.split('\n')
  // `read` no entrega una ultima linea sin salto final.
  lines.pop()
  let total = 0
  let sessionIssue = ''
  for (const line of lines.slice(Math.max(0, fromLine))) {
    if (line.length === 0) continue
    const session = SESSION.exec(line)
    if (session !== null) {
      sessionIssue = session[1] ?? ''
      continue
    }
    if (issue.length > 0 && sessionIssue !== issue) continue
    const hold = HOLD.exec(line)
    if (hold === null) continue
    const start = epochToday(hold[1] ?? '', today)
    const probe = epochToday(hold[2] ?? '', today)
    if (start === null || probe === null) continue
    let delta = probe - start
    if (delta < 0) delta += 86_400
    total += delta
  }
  return total
}
