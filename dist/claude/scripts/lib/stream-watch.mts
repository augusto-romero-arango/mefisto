// Piezas comunes de los dos visores de corridas (`scripts/stream-watch.mts` y
// `src/internal/scripts/mefisto-stream-watch.mts`): seguir un JSONL que crece, traducir cada linea
// a filas, dar formato a horas y duraciones, y descubrir el archivo mas reciente.

import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { COLOR, CliError } from './cli.mts'
import { parseJqStream, toText } from './jq-literals.mts'
import type { JqValue } from './jq-literals.mts'
import { JqError } from './jq-values.mts'
import { fixed } from './metrics-report.mts'

export interface Palette {
  red: string
  green: string
  yellow: string
  blue: string
  cyan: string
  bold: string
  reset: string
}

export const ANSI: Palette = COLOR
export const PLAIN: Palette = { red: '', green: '', yellow: '', blue: '', cyan: '', bold: '', reset: '' }

export type Write = (text: string) => void

export const toStdout: Write = (text) => {
  process.stdout.write(text)
}

// --- Filas ----------------------------------------------------------------------

/** Celdas de un evento; la primera dice que clase de fila es. */
export type Row = string[]

/** Celda de una fila: `-` si el valor falta; si no, el texto con que jq lo imprime. */
export function cell(value: JqValue): string {
  return value === null || value === '' ? '-' : toText(value)
}

export function row(...values: JqValue[]): Row {
  return values.map(cell)
}

export function isMissing(text: string): boolean {
  return text === '' || text === '-' || text === 'null'
}

const TSV_ESCAPES: Record<string, string> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' }

/** Escapado de `@tsv`: asi se ve una celda que el visor imprime sin decodificar. */
export function tsvEscape(text: string): string {
  return text.replace(/[\\\t\n\r]/g, (char) => TSV_ESCAPES[char] ?? char)
}

/** Filas que un filtro saca de un valor JSON; lanza `JqError` donde el filtro de jq fallaria. */
export type Filter = (event: JqValue) => Row[]

export type Translation = { status: 'rows'; rows: Row[] } | { status: 'invalid' } | { status: 'failed' }

/**
 * Filas de una linea del JSONL. `invalid` si la linea no es JSON; `failed` si el filtro falla con
 * alguno de sus valores, y entonces no rinde ninguna fila.
 */
export function translateLine(line: string, filter: Filter): Translation {
  const stream = parseJqStream(line)
  if (!stream.clean) return { status: 'invalid' }
  try {
    return { status: 'rows', rows: stream.values.flatMap(filter) }
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return { status: 'failed' }
  }
}

// --- Horas y duraciones ---------------------------------------------------------

const UTC_STAMP = /^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z(?:[ \t\n\v\f\r][\s\S]*)?$/

/** `strptime("%Y-%m-%dT%H:%M:%SZ") | mktime` de jq: segundos epoch; falla si el texto no es esa fecha. */
export function epochSeconds(text: string): number {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = (UTC_STAMP.exec(text) ?? [])
    .slice(1)
    .map(Number)
  const inRange = month >= 1 && month <= 12 && day <= 31 && hour <= 23 && minute <= 59 && second <= 60
  if (!inRange) throw new JqError(`date "${text}" does not match format "%Y-%m-%dT%H:%M:%SZ"`)
  const seconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1000
  // jq rechaza los anos previos a 1900 y los dos valores que `timegm` usa como error.
  if (year < 1900 || seconds === -1 || seconds === -2) throw new JqError('invalid gmtime representation')
  return seconds
}

const EVENT_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z\n?$/

/**
 * Milisegundos epoch del `ts` de un evento (`AAAA-MM-DDTHH:MM:SS[.fff]Z`); `undefined` si no tiene
 * esa forma. Falla si la forma es correcta pero la fecha no existe.
 */
export function eventEpochMs(ts: string): number | undefined {
  const match = EVENT_TS.exec(ts)
  if (match === null) return undefined
  const millis = match[2] === undefined ? 0 : Number(`${match[2]}000`.slice(0, 3))
  return epochSeconds(`${match[1]}Z`) * 1000 + millis
}

/** Numero que awk lee de un texto: su prefijo decimal, o 0. */
function awkNumber(text: string): number {
  const match = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text)
  return match === null ? 0 : Number(match[0])
}

/** Milisegundos como segundos con un decimal, redondeados como `printf '%.1f'`. */
export function seconds(ms: string, minus = '0'): string {
  return fixed((awkNumber(ms) - awkNumber(minus)) / 1000, 1)
}

const two = (value: number): string => String(value).padStart(2, '0')

/** Hora local `HH:MM:SS` de un epoch en milisegundos; `--:--:--` si falta. */
export function clock(epochMs: string): string {
  if (isMissing(epochMs)) return '--:--:--'
  const date = new Date(Math.trunc(Number(epochMs) / 1000) * 1000)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** `+N.Ns` desde la fila anterior, en siete columnas; `-` si falta alguno de los dos instantes. */
export function delta(previousMs: string, epochMs: string): string {
  if (isMissing(previousMs) || isMissing(epochMs)) return '-'.padStart(7)
  return `+${seconds(epochMs, previousMs).padStart(5)}s`
}

// --- Descubrimiento -------------------------------------------------------------

/** Archivos de `dir` cuyo nombre termina en `suffix`, del mas reciente al mas antiguo (`ls -t dir/*suffix`). */
export function newestFirst(dir: string, suffix: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found: { path: string; name: string; mtime: bigint }[] = []
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith(suffix)) continue
    const path = join(dir, name)
    try {
      const stat = statSync(path, { bigint: true })
      if (!stat.isDirectory()) found.push({ path, name, mtime: stat.mtimeNs })
    } catch {
      // Un archivo que desaparece entre el listado y el `stat` no es candidato.
    }
  }
  found.sort((a, b) => (a.mtime === b.mtime ? (a.name < b.name ? -1 : 1) : a.mtime > b.mtime ? -1 : 1))
  return found.map((entry) => entry.path)
}

/** `true` si el archivo se modifico en el segundo `epoch` o despues; tambien si no se puede saber. */
export function isNewerThan(path: string, epoch: string): boolean {
  if (epoch.length === 0) return true
  try {
    return Math.floor(statSync(path).mtimeMs / 1000) >= Number(epoch)
  } catch {
    return true
  }
}

/** Los issues de una lista separada por comas o espacios. */
export function issueList(csv: string): string[] {
  return csv.split(/[,\s]+/).filter((issue) => issue.length > 0)
}

/** `true` si `name` casa con el glob `*<segment>*<suffix>`. */
export function hasSegmentBeforeSuffix(name: string, segment: string, suffix: string): boolean {
  const at = name.indexOf(segment)
  return at !== -1 && name.endsWith(suffix) && at + segment.length <= name.length - suffix.length
}

export interface DiscoveryFilter {
  /** Lista de issues separada por comas; vacia, sin filtro. */
  issues: string
  /** Epoch en segundos; vacio, sin filtro. */
  newerThan: string
}

/** El archivo mas reciente de `dir` con ese sufijo que pasa los dos filtros, o `null`. */
export function newestMatching(
  dir: string,
  suffix: string,
  filter: DiscoveryFilter,
  matchesIssues: (name: string, issues: string) => boolean,
): string | null {
  for (const candidate of newestFirst(dir, suffix)) {
    if (matchesIssues(basename(candidate), filter.issues) && isNewerThan(candidate, filter.newerThan)) return candidate
  }
  return null
}

// --- Seguimiento ----------------------------------------------------------------

export interface PendingLine {
  text: string
  /** `false` en la ultima linea del archivo si aun no tiene su salto. */
  terminated: boolean
  /** Offset del archivo justo despues de la linea y de su salto. */
  end: number
}

function readFrom(file: string, offset: number): Buffer | null {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fstatSync(fd).size
    if (size <= offset) return null
    const buffer = Buffer.alloc(size - offset)
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, offset))
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * Lector incremental de un log que solo crece: recuerda hasta donde se consumio y en cada sondeo
 * lee solo los bytes nuevos, sin `tail -f` ni vigilancia del sistema de archivos.
 */
export class LogCursor {
  /** Lineas ya consumidas. */
  lines = 0
  private offset = 0
  // Una linea consumida sin su salto: lo que se le agregue despues ya no se relee.
  private midLine = false

  /** Las lineas aun no consumidas, en orden. No avanza el cursor. */
  pending(file: string): PendingLine[] {
    const chunk = readFrom(file, this.offset)
    if (chunk === null) return []
    let start = 0
    if (this.midLine) {
      const newline = chunk.indexOf(0x0a)
      if (newline === -1) {
        this.offset += chunk.length
        return []
      }
      start = newline + 1
      this.midLine = false
    }
    const base = this.offset
    this.offset = base + start
    const lines: PendingLine[] = []
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      const stop = newline === -1 ? chunk.length : newline
      const next = newline === -1 ? stop : stop + 1
      lines.push({ text: chunk.toString('utf8', start, stop), terminated: newline !== -1, end: base + next })
      start = next
    }
    return lines
  }

  /** Da por consumida la siguiente linea pendiente. */
  consume(line: PendingLine): void {
    this.lines += 1
    this.offset = line.end
    this.midLine = !line.terminated
  }
}

export const POLL_INTERVAL_MS = 1000

export interface FollowOptions {
  intervalMs?: number
  /** Al abortar, el bucle termina; sin ella no termina nunca. */
  signal?: AbortSignal
}

/** Repite `step` con una pausa entre sondeos. */
export async function follow(step: () => void, options: FollowOptions = {}): Promise<void> {
  const { intervalMs = POLL_INTERVAL_MS, signal } = options
  while (signal?.aborted !== true) {
    step()
    try {
      await sleep(intervalMs, undefined, { signal })
    } catch {
      return
    }
  }
}

const INTERRUPTED = 130
const BROKEN_PIPE = 141

/**
 * Sigue una corrida hasta que el usuario la corta: Ctrl-C termina con 130. SIGTERM hace lo mismo
 * donde existe; en Windows no llega nunca.
 */
export function runViewer(step: () => void): void {
  process.on('SIGINT', () => process.exit(INTERRUPTED))
  process.on('SIGTERM', () => process.exit(INTERRUPTED))
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(BROKEN_PIPE)
    throw error
  })
  follow(step).catch((error: unknown) => {
    if (!(error instanceof CliError)) throw error
    console.error(error.message)
    process.exit(error.exitCode)
  })
}
