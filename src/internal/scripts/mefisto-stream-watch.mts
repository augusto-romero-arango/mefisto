// Visor en vivo de un stage del pipeline interno: sigue el `*.events.jsonl` que el runner escribe
// por stage (run-events.schema.json) y muestra una linea por actividad, con el texto completo de
// cada mensaje, cada herramienta al arrancar con su resumen, sus fallos y el cierre del stage con
// sus metricas. Un campo que el runtime no provee se muestra como `n/d`, nunca como cero.
//
// Uso:
//   mefisto-stream-watch.mts                      sigue el archivo mas reciente y cambia al siguiente
//   mefisto-stream-watch.mts <ruta>               sigue o inspecciona ese archivo
//   mefisto-stream-watch.mts --issues 42,43       solo los eventos de esos issues
//   mefisto-stream-watch.mts --newer-than <epoch> ignora lo modificado antes de ese segundo

import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { CliError, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import { firstTruthy, get, isJqObject, path, typeOf } from '../../../scripts/lib/jq-literals.mts'
import type { JqValue } from '../../../scripts/lib/jq-literals.mts'
import { JqError } from '../../../scripts/lib/jq-values.mts'
import { stateDirs } from '../../../scripts/lib/state.mts'
import type { StateDirs } from '../../../scripts/lib/state.mts'
import {
  ANSI,
  LogCursor,
  clock,
  delta,
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
  tsvEscape,
} from '../../../scripts/lib/stream-watch.mts'
import type { DiscoveryFilter, Palette, Row, Write } from '../../../scripts/lib/stream-watch.mts'
import { assertInMefisto } from './lib/mefisto-repo.mts'

const SUFFIX = '.events.jsonl'
const TERMINAL_TYPES = ['run.completed', 'run.failed']
const KNOWN_TYPES = ['run.started', 'message', 'tool.started', 'tool.completed', ...TERMINAL_TYPES]

/** Milisegundos epoch de `ts`; `undefined` si es un texto con otra forma. Falla si no es texto ni `null`. */
function epochMs(ts: JqValue): JqValue | undefined {
  if (ts === null) return null
  if (typeof ts !== 'string') throw new JqError(`${typeOf(ts)} cannot be matched, as it is not a string`)
  return eventEpochMs(ts)
}

/**
 * Filas de un evento. Lo que no es un objeto o trae un `type` fuera del vocabulario rinde una fila
 * `ignored`; un evento conocido cuyo `ts` es un texto con otra forma no rinde ninguna.
 */
export function eventRows(event: JqValue): Row[] {
  if (!isJqObject(event)) return [['ignored']]
  const type = get(event, 'type')
  if (typeof type !== 'string' || !KNOWN_TYPES.includes(type)) return [['ignored']]
  const ms = epochMs(get(event, 'ts'))
  if (ms === undefined) return []
  const field = (key: string): JqValue => get(event, key)
  const present = (...read: (() => JqValue)[]): JqValue => firstTruthy(...read, () => null)
  const optional = (key: string): JqValue => present(() => field(key))
  if (type === 'run.started') return [row('run_started', ms, optional('cwd'))]
  if (type === 'tool.started') return [row('tool_started', ms, optional('tool'), optional('input_summary'))]
  if (type === 'message') {
    const kind = optional('kind') === 'thinking' ? 'thinking' : 'text'
    return [row('message', ms, kind, optional('text'))]
  }
  if (type === 'tool.completed') return [row('tool', ms, optional('tool'), field('ok'), optional('duration_ms'))]
  return [
    row(
      'terminal',
      ms,
      field('status'),
      field('runtime'),
      optional('model'),
      optional('session_id'),
      field('duration_ms'),
      optional('api_duration_ms'),
      present(
        () => field('estimated_cost_usd'),
        () => field('cost_usd'),
      ),
      optional('turns'),
      present(() => path(event, 'tokens', 'input')),
      present(() => path(event, 'tokens', 'output')),
      optional('ttft_ms'),
      optional('denials'),
      present(() => path(event, 'error', 'kind')),
    ),
  ]
}

/**
 * `true` si el archivo es de uno de los issues de la lista: el del stage, una copia de reintento
 * (`.attempt-<k>`) o una corrida de variante (`-<label>`). Con la lista vacia, siempre.
 */
export function matchesIssues(name: string, issues: string): boolean {
  if (issues.length === 0) return true
  return issueList(issues).some(
    (issue) =>
      name.endsWith(`-issue-${issue}${SUFFIX}`) ||
      hasSegmentBeforeSuffix(name, `-issue-${issue}.attempt-`, SUFFIX) ||
      hasSegmentBeforeSuffix(name, `-issue-${issue}-`, SUFFIX),
  )
}

const NO_FILTER: DiscoveryFilter = { issues: '', newerThan: '' }

/** El `*.events.jsonl` mas reciente de `dir` que pasa los filtros, o `null`. */
export function discoverStream(dir: string, filter: DiscoveryFilter = NO_FILTER): string | null {
  return newestMatching(dir, SUFFIX, filter, matchesIssues)
}

/** El primer directorio con candidato gana, aunque otro posterior tenga uno mas reciente. */
export function discoverStreamInDirs(dirs: readonly string[], filter: DiscoveryFilter = NO_FILTER): string | null {
  for (const dir of dirs) {
    const found = discoverStream(dir, filter)
    if (found !== null) return found
  }
  return null
}

/** Los directorios de logs que ya existen, el canonico primero. */
export function logDirs(dirs: StateDirs): string[] {
  return [join(dirs.canonical, 'logs'), join(dirs.legacy, 'logs')].filter((dir) => existsSync(dir))
}

const STAGE_FILE = /^mefisto-tooling-stage-([^-]+)-([^-]+)-([0-9]{8}-[0-9]{6})-issue-([0-9]+)\.events\.jsonl$/

/** Encabezado de un archivo: issue, stage y agente salen de su nombre; si no los trae, el nombre tal cual. */
export function streamHeader(file: string, colors: Palette): string {
  const name = basename(file)
  const [, stage, agent, stamp, issue] = STAGE_FILE.exec(name) ?? []
  const title = issue === undefined ? name : `issue #${issue} -- stage ${stage} (${agent}) -- ${stamp}`
  return `${colors.cyan}${colors.bold}=== ${title} ===${colors.reset}\n${colors.cyan}${file}${colors.reset}\n`
}

/** `value` sin el prefijo `<cwd>/`; tal cual si no empieza por el o si falta alguno de los dos. */
export function relativizePath(value: string, cwd: string): string {
  if (isMissing(cwd) || isMissing(value)) return value
  return value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value
}

export function orNd(value: string): string {
  return isMissing(value) ? 'n/d' : value
}

export function msOrNd(ms: string): string {
  return isMissing(ms) ? 'n/d' : `${ms}ms`
}

export function secondsOrNd(ms: string, minus = '0'): string {
  return isMissing(ms) || isMissing(minus) ? 'n/d' : `${seconds(ms, minus)}s`
}

const withoutFinalNewlines = (text: string): string => text.replace(/\n+$/, '')

/** Celda tal como la imprime el visor cuando no la decodifica. */
const raw = (value: string): string => orNd(tsvEscape(value))

/** Cierre de un stage a partir de las celdas de su fila `terminal`, sin la clase ni la hora. */
export function terminalSummary(now: string, cells: readonly string[], ignored: number, colors: Palette): string {
  const [
    status = '',
    runtime = '',
    model = '',
    sessionId = '',
    durationMs = '',
    apiDurationMs = '',
    costUsd = '',
    turns = '',
    tokensIn = '',
    tokensOut = '',
    ttftMs = '',
    denials = '',
    errorKind = '',
  ] = cells
  const ok = status === 'success'
  const color = ok ? colors.green : colors.red
  let outcome = ok ? 'OK' : 'ERROR'
  // Un terminal con exito puede traer `error`: el runtime murio despues de cumplir su contrato.
  if (!isMissing(errorKind)) outcome = ok ? `OK, con ${errorKind} posterior` : `ERROR: ${errorKind}`
  return [
    '',
    `${color}${colors.bold}--- cierre de stage [${now}] (${outcome}) ---${colors.reset}`,
    `runtime=${raw(runtime)}  modelo=${raw(model)}  session_id=${raw(sessionId)}`,
    `turnos=${raw(turns)}  costo_usd=${raw(costUsd)}  duracion=${secondsOrNd(durationMs)}` +
      ` (api=${secondsOrNd(apiDurationMs)}, no-api=${secondsOrNd(durationMs, apiDurationMs)})`,
    `tokens: in=${raw(tokensIn)} out=${raw(tokensOut)}  ttft=${msOrNd(tsvEscape(ttftMs))}  denials=${raw(denials)}`,
    `eventos ignorados: ${ignored}`,
    `${color}${colors.bold}Esperando el siguiente archivo...${colors.reset}`,
    '',
    '',
  ].join('\n')
}

const CONTINUATION_INDENT = ' '.repeat(20)

export interface ViewerOptions {
  dirs: StateDirs
  filter?: DiscoveryFilter
  /** Ruta fija a seguir; vacia, el visor descubre la mas reciente en cada sondeo. */
  pinned?: string
  colors?: Palette
  write?: Write
}

export class EventViewer {
  current = ''
  cursor = new LogCursor()
  previousMs = ''
  ignored = 0
  /** `cwd` del `run.started` vigente, para mostrar relativo el resumen de cada herramienta. */
  cwd = ''
  private readonly dirs: StateDirs
  private readonly filter: DiscoveryFilter
  private readonly pinned: string
  private readonly colors: Palette
  private readonly write: Write

  constructor(options: ViewerOptions) {
    this.dirs = options.dirs
    this.filter = options.filter ?? NO_FILTER
    this.pinned = options.pinned ?? ''
    this.colors = options.colors ?? ANSI
    this.write = options.write ?? toStdout
  }

  private renderMessage(stamp: string, kind: string, text: string): void {
    const { yellow, reset } = this.colors
    const thinking = kind === 'thinking'
    if (isMissing(text)) {
      this.write(`${stamp}${yellow}${thinking ? '(pensando)' : '(texto)'}${reset}\n`)
      return
    }
    const label = thinking ? `${yellow}(pensando)${reset} ` : ''
    this.write(`${stamp}${label}${text.split('\n').join(`\n${CONTINUATION_INDENT}`)}\n`)
  }

  /**
   * Muestra una fila. Solo una fila visible mueve el instante de referencia: el exito de una
   * herramienta no imprime nada, asi que el delta de la siguiente linea incluye su duracion.
   */
  renderRow(cells: Row): void {
    const [kind = '', ms = '', a = '', b = '', c = ''] = cells
    const { blue, bold, reset } = this.colors
    if (kind === 'ignored') {
      this.ignored += 1
      return
    }
    if (kind === 'run_started') {
      this.cwd = withoutFinalNewlines(a)
      return
    }
    if (kind === 'terminal') {
      const now = clock(isMissing(ms) ? this.previousMs : ms)
      this.write(terminalSummary(now, cells.slice(2), this.ignored, this.colors))
      this.previousMs = ''
      this.ignored = 0
      return
    }
    const stamp = `${blue}[${clock(ms)}]${reset} ${delta(this.previousMs, ms)}  `
    if (kind === 'message') {
      this.renderMessage(stamp, a, withoutFinalNewlines(b))
    } else if (kind === 'tool_started') {
      const summary = withoutFinalNewlines(b)
      const detail = isMissing(summary) ? '' : `: ${relativizePath(summary, this.cwd)}`
      this.write(`${stamp}${bold}${tsvEscape(a)}${reset}${detail}\n`)
    } else if (kind === 'tool' && b === 'false') {
      this.write(`${stamp}${bold}${tsvEscape(a)}${reset} fallo (${msOrNd(c)})\n`)
    } else {
      return
    }
    this.previousMs = ms
  }

  /**
   * Un ciclo de lectura. Una linea que no se puede traducir cuenta como ignorada, salvo que sea la
   * ultima del lote: esa puede estar a medio escribir y se reintenta en el proximo ciclo.
   */
  processNewLines(stream: string = this.current): void {
    const pending = this.cursor.pending(stream)
    while (pending.at(-1)?.text === '') pending.pop()
    for (const [index, line] of pending.entries()) {
      if (line.text.length === 0) {
        this.cursor.consume(line)
        continue
      }
      const translation = translateLine(line.text, eventRows)
      if (translation.status !== 'rows') {
        if (index === pending.length - 1) break
        this.ignored += 1
        this.cursor.consume(line)
        continue
      }
      this.cursor.consume(line)
      for (const cells of translation.rows) this.renderRow(cells)
    }
  }

  activate(stream: string): void {
    this.current = stream
    this.cursor = new LogCursor()
    this.previousMs = ''
    this.ignored = 0
    this.cwd = ''
    this.write(`\n${streamHeader(stream, this.colors)}\n`)
  }

  /**
   * Un sondeo. Los directorios de logs se resuelven cada vez: el visor suele arrancar antes que el
   * pipeline, cuando todavia no existen.
   */
  step(): void {
    const stream =
      this.pinned.length > 0 ? this.pinned : discoverStreamInDirs(logDirs(this.dirs), this.filter)
    if (stream !== null && stream !== this.current) this.activate(stream)
    if (this.current.length > 0) this.processNewLines()
  }
}

export interface Arguments {
  filter: DiscoveryFilter
  pinned: string
}

export function parseArguments(argv: readonly string[]): Arguments {
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
      if (!/^[0-9]+$/.test(value)) {
        throw new CliError(`ERROR: --newer-than debe ser un epoch en segundos (recibido: '${value}')`, 2)
      }
      filter.newerThan = value
      index++
    } else {
      pinned = arg
    }
  }
  return { filter, pinned }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Lo que el visor anuncia al arrancar, antes del primer sondeo. */
export function banner(args: Arguments, dirs: StateDirs, colors: Palette): string {
  const { cyan, yellow, bold, reset } = colors
  const lines = [`${cyan}${bold}Mefisto -- visor en vivo del flujo de eventos (issue #434/#878)${reset}`]
  const warn = (text: string): void => {
    lines.push(`${yellow}${text}${reset}`)
  }
  if (args.pinned.length > 0) {
    lines.push(`Inspeccionando: ${args.pinned}`)
  } else {
    lines.push('Descubriendo el archivo de eventos mas reciente...')
    if (args.filter.issues.length > 0) lines.push(`Filtro de issues: ${args.filter.issues}`)
    if (args.filter.newerThan.length > 0) {
      warn('Esperando la traza de esta corrida (el archivo del stage 1 nace cuando arranca')
      warn('el primer agente, tras crear el worktree y validar el DoR)...')
    }
    if (logDirs(dirs).length === 0) {
      warn('Aviso: todavia no hay ningun directorio de logs del harness resuelto por')
      warn('mefisto_state_read_paths. Se creara cuando arranque un pipeline (el visor lo')
      warn('reintenta cada ciclo); si esperabas una corrida en curso, lanza el visor')
      warn('desde la raiz del repo principal.')
    }
  }
  return `${lines.join('\n')}\n\n`
}

/** Valida el repo y los argumentos, anuncia el arranque y deja el visor listo. */
export function prepare(argv: readonly string[], write: Write = toStdout): EventViewer {
  assertInMefisto()
  const args = parseArguments(argv)
  if (args.pinned.length > 0 && !isFile(args.pinned)) {
    throw new CliError(`ERROR: no existe el archivo de eventos indicado: ${args.pinned}`)
  }
  const dirs = stateDirs()
  write(banner(args, dirs, ANSI))
  return new EventViewer({ dirs, filter: args.filter, pinned: args.pinned, write })
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => {
    const viewer = prepare(process.argv.slice(2))
    runViewer(() => viewer.step())
  })
}
