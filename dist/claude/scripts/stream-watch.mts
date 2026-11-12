// Visor de solo lectura de las corridas de agente del consumidor. Sigue los `*.events.jsonl`
// (run-events.v1) del estado publicado y conserva un parser separado para los `*.stream.jsonl` de
// Claude que dejaron las corridas previas al contrato. El camino neutral no muestra payloads: ni
// el texto de un mensaje ni la entrada de una herramienta llegan a la terminal.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'

import { CliError, isEntryPoint, repoRoot, runMain } from './lib/cli.mts'
import { firstTruthy, get, isJqObject, iterate, parseJqStream, path } from './lib/jq-literals.mts'
import type { JqValue } from './lib/jq-literals.mts'
import { JqError } from './lib/jq-values.mts'
import { stateDirs } from './lib/state.mts'
import type { StateDirs } from './lib/state.mts'
import {
  ANSI,
  LogCursor,
  cell,
  clock,
  delta,
  epochSeconds,
  eventEpochMs,
  hasSegmentBeforeSuffix,
  isMissing,
  issueList,
  newestMatching,
  row,
  runViewer,
  seconds,
  toStdout,
  translateLine,
} from './lib/stream-watch.mts'
import type { DiscoveryFilter, Filter, Palette, Row, Write } from './lib/stream-watch.mts'

export type StreamFormat = 'neutral' | 'legacy-claude'

const NEUTRAL_SUFFIX = '.events.jsonl'
const LEGACY_SUFFIX = '.stream.jsonl'

export function streamFormat(file: string): StreamFormat | null {
  if (file.endsWith(NEUTRAL_SUFFIX)) return 'neutral'
  return file.endsWith(LEGACY_SUFFIX) ? 'legacy-claude' : null
}

function orNull(read: () => number | undefined): JqValue {
  try {
    return read() ?? null
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return null
  }
}

function neutralEpochMs(event: JqValue): JqValue {
  const ts = get(event, 'ts')
  return typeof ts === 'string' ? orNull(() => eventEpochMs(ts)) : null
}

/** Filas de un evento run-events.v1: solo los campos que son seguros de mostrar. */
export function neutralRows(event: JqValue): Row[] {
  if (!isJqObject(event)) return []
  const field = (key: string): JqValue => get(event, key)
  const type = field('type')
  const epochMs = neutralEpochMs(event)
  if (type === 'run.started') return [row('started', epochMs, field('runtime'), field('agent'), field('model'))]
  if (type === 'message') {
    const kind = firstTruthy(
      () => field('kind'),
      () => 'text',
    )
    return [row('message', epochMs, kind)]
  }
  if (type === 'tool.started') return [row('tool-started', epochMs, field('tool'))]
  if (type === 'tool.completed') {
    return [row('tool-completed', epochMs, field('tool'), field('ok'), field('duration_ms'))]
  }
  if (type !== 'run.completed' && type !== 'run.failed') return []
  const errorKind = firstTruthy(
    () => path(event, 'error', 'kind'),
    () => null,
  )
  return [
    row('terminal', epochMs, type, field('status'), field('runtime'), field('model'), field('duration_ms'), errorKind),
  ]
}

function legacyEpochMs(event: JqValue): JqValue {
  const stamp = get(event, 'timestamp')
  return typeof stamp === 'string' ? orNull(() => epochSeconds(stamp) * 1000) : null
}

/** Filas de un evento del stream-json de Claude previo al contrato. */
export function legacyRows(event: JqValue): Row[] {
  if (!isJqObject(event)) return []
  const type = get(event, 'type')
  const epochMs = legacyEpochMs(event)
  if (type === 'result') {
    return [row('legacy-terminal', epochMs, get(event, 'is_error'), get(event, 'duration_ms'), get(event, 'num_turns'))]
  }
  if (type !== 'assistant') return []
  const content = firstTruthy(
    () => path(event, 'message', 'content'),
    () => [],
  )
  let items: JqValue[]
  try {
    items = iterate(content)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return []
  }
  const rows: Row[] = []
  for (const item of items) {
    const kind = get(item, 'type')
    if (kind === 'tool_use') rows.push(row('legacy-tool', epochMs, get(item, 'name')))
    else if (kind === 'text') rows.push(row('legacy-message', epochMs, 'texto'))
    else if (kind === 'thinking') rows.push(row('legacy-message', epochMs, 'pensamiento'))
  }
  return rows
}

const FILTERS: Record<StreamFormat, Filter> = { neutral: neutralRows, 'legacy-claude': legacyRows }

/** `true` si el archivo es de uno de los issues de la lista; con la lista vacia, siempre. */
export function matchesIssues(name: string, issues: string): boolean {
  if (issues.length === 0) return true
  return issueList(issues).some((issue) =>
    [NEUTRAL_SUFFIX, LEGACY_SUFFIX].some(
      (suffix) =>
        name.endsWith(`-issue-${issue}${suffix}`) || hasSegmentBeforeSuffix(name, `-issue-${issue}-`, suffix),
    ),
  )
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * El stream a seguir. Los directorios se consultan en orden y el primero con candidato gana; en
 * cada uno, run-events gana al stream de Claude, que nunca se elige si existe su par neutral.
 */
export function discoverStream(logDirs: readonly string[], filter: DiscoveryFilter): string | null {
  for (const dir of logDirs) {
    const neutral = newestMatching(dir, NEUTRAL_SUFFIX, filter, matchesIssues)
    if (neutral !== null) return neutral
    const legacy = newestMatching(dir, LEGACY_SUFFIX, filter, matchesIssues)
    if (legacy === null) continue
    if (isFile(legacy.slice(0, -LEGACY_SUFFIX.length) + NEUTRAL_SUFFIX)) continue
    return legacy
  }
  return null
}

export interface RunMetadata {
  runtime: string
  agent: string
  model: string
}

/** Runtime, agente y modelo del primer `run.started`; `-` en los tres si el archivo aun no es JSONL completo. */
export function runMetadata(file: string): RunMetadata {
  const missing = { runtime: '-', agent: '-', model: '-' }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return missing
  }
  const stream = parseJqStream(text)
  if (!stream.clean) return missing
  const started = stream.values.find((value) => isJqObject(value) && get(value, 'type') === 'run.started')
  if (started === undefined) return missing
  return {
    runtime: cell(get(started, 'runtime')),
    agent: cell(get(started, 'agent')),
    model: cell(get(started, 'model')),
  }
}

function isUnder(file: string, dir: string): boolean {
  const root = dir.replace(/[\\/]+$/, '')
  return file.startsWith(`${root}/`) || file.startsWith(root + sep)
}

/** Las dos lineas que encabezan un stream: lo que el nombre y el `run.started` dicen de la corrida, y su ruta. */
export function streamHeader(
  file: string,
  format: StreamFormat,
  run: RunMetadata,
  dirs: StateDirs,
  colors: Palette,
): string {
  const name = basename(file)
  const stage = /^.*stage-([0-9]+)/s.exec(name)?.[1]
  const issue = /^.*-issue-([0-9]+)/s.exec(name)?.[1]
  const details: string[] = [format]
  if (issue !== undefined) details.push(`issue #${issue}`)
  if (stage !== undefined) details.push(`stage ${stage}`)
  if (!isMissing(run.runtime)) details.push(`runtime ${run.runtime}`)
  if (!isMissing(run.agent)) details.push(`agente ${run.agent}`)
  if (!isMissing(run.model)) details.push(`modelo ${run.model}`)
  const state = isUnder(file, dirs.canonical) ? 'canonico' : isUnder(file, dirs.legacy) ? 'legacy' : 'manual'
  return (
    `${colors.cyan}${colors.bold}=== ${details.join(' | ')} ===${colors.reset}\n` +
    `${colors.cyan}estado: ${state} | ruta: ${file}${colors.reset}\n`
  )
}

function durationSeconds(ms: string): string {
  return isMissing(ms) ? '?' : seconds(ms)
}

const NO_RUN: RunMetadata = { runtime: '', agent: '', model: '' }

export interface ViewerOptions {
  dirs: StateDirs
  filter?: DiscoveryFilter
  /** Ruta fija a seguir; vacia, el visor descubre la mas reciente en cada sondeo. */
  pinned?: string
  colors?: Palette
  write?: Write
}

export class StreamViewer {
  current = ''
  format: StreamFormat = 'neutral'
  cursor = new LogCursor()
  previousMs = ''
  run: RunMetadata = NO_RUN
  terminals = 0
  private readonly dirs: StateDirs
  private readonly filter: DiscoveryFilter
  private readonly pinned: string
  private readonly colors: Palette
  private readonly write: Write

  constructor(options: ViewerOptions) {
    this.dirs = options.dirs
    this.filter = options.filter ?? { issues: '', newerThan: '' }
    this.pinned = options.pinned ?? ''
    this.colors = options.colors ?? ANSI
    this.write = options.write ?? toStdout
  }

  private line(text: string): void {
    this.write(`${text}\n`)
  }

  private warn(color: string, text: string): void {
    this.line(`${color}${text}${this.colors.reset}`)
  }

  /** Los directorios de logs que ya existen, el canonico primero. */
  logDirs(): string[] {
    return [join(this.dirs.canonical, 'logs'), join(this.dirs.legacy, 'logs')].filter((dir) => existsSync(dir))
  }

  private renderTerminal(type: string, status: string, runtime: string, model: string, ms: string, errorKind: string): void {
    const { red, yellow, bold, reset } = this.colors
    this.terminals += 1
    if (this.terminals > 1) {
      this.warn(red, 'Aviso: protocolo invalido; se observo mas de un terminal. El terminal adicional se omitio.')
      return
    }
    const shownRuntime = isMissing(runtime) ? this.run.runtime : runtime
    const shownModel = isMissing(model) ? this.run.model : model
    const agent = this.run.agent.length > 0 ? this.run.agent : '-'
    this.line(
      `${bold}--- desenlace ${type} | resultado=${status} | runtime=${shownRuntime} | agente=${agent}` +
        ` | modelo=${shownModel} | duracion=${durationSeconds(ms)}s${reset}`,
    )
    if (type !== 'run.completed' || status !== 'success') this.warn(red, 'La corrida no termino con exito.')
    else if (!isMissing(errorKind)) this.warn(yellow, `Incidente posterior al exito: ${errorKind}.`)
  }

  renderRow(cells: Row): void {
    const [kind = '', epochMs = '', a = '', b = '', c = '', d = '', e = '', f = ''] = cells
    const { blue, yellow, bold, reset } = this.colors
    const now = clock(epochMs)
    const stamp = `${blue}[${now}]${reset} ${delta(this.previousMs, epochMs)}  `
    const legacy = `${yellow}[legacy Claude]${reset}`
    const legacyStamp = `${legacy} [${now}] ${delta(this.previousMs, epochMs)}  `
    switch (kind) {
      case 'started':
        this.run = { runtime: a, agent: b, model: c }
        this.line(`${stamp}inicio runtime=${a} agente=${b} modelo=${c}`)
        break
      case 'message':
        this.line(`${stamp}mensaje (${a})`)
        break
      case 'tool-started':
        this.line(`${stamp}herramienta ${bold}${a}${reset} iniciada`)
        break
      case 'tool-completed':
        this.line(`${stamp}herramienta ${bold}${a}${reset}: ${b === 'true' ? 'ok' : 'fallo'} (${durationSeconds(c)}s)`)
        break
      case 'terminal':
        this.renderTerminal(a, b, c, d, e, f)
        break
      case 'legacy-tool':
        this.line(`${legacyStamp}herramienta ${a}`)
        break
      case 'legacy-message':
        this.line(`${legacyStamp}${a}`)
        break
      case 'legacy-terminal':
        this.line(`${legacy} cierre: ${a === 'true' ? 'ERROR' : 'OK'} duracion=${durationSeconds(b)}s turnos=${c}`)
        break
    }
    this.previousMs = epochMs
  }

  /**
   * Consume las lineas completas que falten. Una ultima linea invalida sin su salto se reintenta
   * en el proximo sondeo; una corrupta ya cerrada se omite con un aviso.
   */
  processNewLines(stream: string = this.current): void {
    const { yellow } = this.colors
    for (const line of this.cursor.pending(stream)) {
      const translation = translateLine(line.text, FILTERS[this.format])
      if (translation.status === 'invalid') {
        if (!line.terminated) {
          this.warn(yellow, 'Aviso: linea parcial; se reintentara.')
          return
        }
        this.warn(yellow, 'Aviso: linea corrupta omitida.')
        this.cursor.consume(line)
        continue
      }
      this.cursor.consume(line)
      if (translation.status === 'failed') {
        this.warn(yellow, 'Aviso: evento no renderizable omitido.')
        continue
      }
      for (const cells of translation.rows) this.renderRow(cells)
    }
  }

  /** Denuncia el stream que se deja si no declaro exactamente un terminal. */
  finishCurrent(): void {
    if (this.format !== 'neutral') return
    const { red, yellow } = this.colors
    if (this.terminals === 0) {
      this.warn(yellow, 'Aviso: el stream anterior quedo truncado: no declaro terminal.')
    } else if (this.terminals > 1) {
      this.warn(red, `Aviso: el stream anterior es invalido: declaro ${this.terminals} terminales.`)
    }
  }

  activate(stream: string): void {
    if (stream === this.current) return
    if (this.current.length > 0) this.finishCurrent()
    const format = streamFormat(stream)
    if (format === null) {
      throw new CliError(`ERROR: la ruta manual no es *.events.jsonl ni *.stream.jsonl: ${stream}`)
    }
    this.format = format
    this.current = stream
    this.cursor = new LogCursor()
    this.previousMs = ''
    this.terminals = 0
    this.run = format === 'neutral' ? runMetadata(stream) : NO_RUN
    this.write(streamHeader(stream, format, this.run, this.dirs, this.colors))
  }

  /** Un sondeo: cambia al stream que toque y muestra sus lineas nuevas. */
  step(): void {
    const stream = this.pinned.length > 0 ? this.pinned : discoverStream(this.logDirs(), this.filter)
    if (stream !== null) this.activate(stream)
    if (this.current.length > 0) this.processNewLines()
  }
}

export const USAGE = 'Uso: stream-watch.mts [<ruta-al-stream>] [--issues <n1,n2,...>] [--newer-than <epoch-segundos>]'

export interface Arguments {
  filter: DiscoveryFilter
  pinned: string
}

/** Los argumentos del visor, o `null` si se pidio la ayuda. */
export function parseArguments(argv: readonly string[]): Arguments | null {
  const filter: DiscoveryFilter = { issues: '', newerThan: '' }
  let pinned = ''
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    const value = argv[index + 1]
    if (arg === '--issues') {
      if (value === undefined) throw new CliError('ERROR: falta el valor de --issues', 2)
      filter.issues = value
      index++
    } else if (arg === '--newer-than') {
      if (value === undefined) throw new CliError('ERROR: falta el valor de --newer-than', 2)
      if (!/^[0-9]+$/.test(value)) throw new CliError('ERROR: --newer-than debe ser un epoch en segundos', 2)
      filter.newerThan = value
      index++
    } else if (arg === '--help' || arg === '-h') {
      return null
    } else if (arg.startsWith('-')) {
      throw new CliError(`ERROR: opcion desconocida: ${arg}`, 2)
    } else {
      if (pinned.length > 0) throw new CliError('ERROR: solo se admite una ruta manual', 2)
      pinned = arg
    }
  }
  return { filter, pinned }
}

/** Valida el repo y los argumentos y deja el visor listo; `null` si solo habia que mostrar la ayuda. */
export function prepare(argv: readonly string[], write: Write = toStdout): StreamViewer | null {
  const root = repoRoot()
  if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
  if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
    throw new CliError('ERROR: scripts/stream-watch.mts es del plugin publicado y solo aplica al consumidor.')
  }
  const args = parseArguments(argv)
  if (args === null) {
    write(`${USAGE}\n`)
    return null
  }
  const { filter, pinned } = args
  if (pinned.length > 0 && !isFile(pinned)) throw new CliError(`ERROR: no existe el stream indicado: ${pinned}`)
  if (pinned.length > 0 && streamFormat(pinned) === null) {
    throw new CliError(`ERROR: la ruta manual no es *.events.jsonl ni *.stream.jsonl: ${pinned}`)
  }
  write(`${ANSI.cyan}${ANSI.bold}Mefisto -- visor run-events.v1${ANSI.reset}\n`)
  return new StreamViewer({ dirs: stateDirs(), filter, pinned, write })
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => {
    const viewer = prepare(process.argv.slice(2))
    if (viewer !== null) runViewer(() => viewer.step())
  })
}
