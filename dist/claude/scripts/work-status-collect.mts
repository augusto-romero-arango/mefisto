// work-status-collect.mts -- Consolida en un unico JSON el estado de los pipelines del
// consumidor (TDD, Tooling, Infra, pr-sync), leyendo el root canonico (.mefisto/pipeline/) y el
// legacy (.claude/pipeline/) sin migrar ni escribir nada (MEF-ADR-0053 seccion 4). Lo consume el
// agente tooling-investigator: el script entrega datos deterministicos y quien lo consume los
// presenta.
//
// Uso: node scripts/work-status-collect.mts --json
//
// --json es el unico argumento aceptado y es obligatorio; cualquier otra forma imprime el uso
// por stderr y sale con 2. Con --json siempre imprime un unico JSON y sale con 0, tambien sin
// ningun estado ni historial:
//   schemaVersion: 1
//   now:      "YYYY-MM-DD HH:MM:SS"
//   rows[]:   pipeline, issue, variant, title, runtime, stage, state, started, updated,
//             origin (canonical|legacy), log, pr, last_error, agents, activity, progress_pct
//   history[]: hasta 5, del mas reciente al mas antiguo -- pipeline, issue, variant, runtime,
//             result, duration, detail, pr, started, origin, log
//   empty:    {status, history}
//
// "runtime" se copia tal cual (null si falta) y nunca se infiere. Un archivo o una linea que no
// se puede leer se omite: nunca impide imprimir el JSON.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint, repoRoot } from './lib/cli.mts'
import { JqError, add, alt, dump, get, groupBy, parseStream, sortBy, toText } from './lib/jq-values.mts'
import type { Json, JsonObject } from './lib/jq-values.mts'
import { stateDirs } from './lib/state.mts'
import { holdRecentlyActive, lastHoldLine } from './lib/work-status-hold.mts'

const STALE_THRESHOLD_SECONDS = 2100
const HISTORY_LIMIT = 5

type Origin = 'canonical' | 'legacy'

interface Roots {
  canonical: string
  legacy: string
}

interface Collected extends JsonObject {
  origin: Origin
  seq: number
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// Solo cuando el JSON no trae "pipeline" (formatos antiguos).
function inferPipeline(fileName: string): string {
  if (fileName.includes('pr-sync')) return 'pr-sync'
  if (fileName.includes('tooling')) return 'tooling'
  return fileName.includes('infra') ? 'infra' : 'tdd'
}

const STAMPS = [
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
  /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/,
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
]

/** Epoch local de los timestamps que escriben los pipelines ("updated", "finished", "started"). */
export function parseEpoch(stamp: string): number | null {
  for (const shape of STAMPS) {
    const match = shape.exec(stamp)
    if (match === null) continue
    const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number)
    if (month < 1 || month > 12 || day > 31 || hour > 23 || minute > 59 || second > 60) return null
    const date = new Date(0)
    date.setFullYear(year, month - 1, day)
    date.setHours(hour, minute, second, 0)
    return Math.floor(date.getTime() / 1000)
  }
  return null
}

/** Texto de un campo como lo recibe el shell de `jq -r`: vacio si falta, sin saltos finales. */
function text(value: Json): string {
  return toText(alt(value, '')).replace(/\n+$/, '')
}

const field = (value: Json, key: string): Json => alt(get(value, key), null)

function pick(value: Json, keys: string[]): JsonObject {
  return Object.fromEntries(keys.map((key) => [key, field(value, key)]))
}

function named(dir: string, prefix: string, suffix: string): string[] {
  const minimum = prefix.length + suffix.length
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.length >= minimum && name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .map((name) => join(dir, name))
    .filter(isFile)
}

function statusFiles(dir: string): string[] {
  const modern = named(dir, 'pipeline-status-', '.json')
  if (modern.length > 0) return modern
  return [...named(dir, 'status', '.json'), ...named(dir, 'tooling-status', '.json'), ...named(dir, 'infra-status.json', '')]
}

function historyFiles(dir: string): string[] {
  const notEmpty = (file: string): boolean => {
    try {
      return statSync(file).size > 0
    } catch {
      return false
    }
  }
  const modern = join(dir, 'pipeline-history.jsonl')
  if (notEmpty(modern)) return [modern]
  return ['history.jsonl', 'tooling-history.jsonl', 'infra-history.jsonl'].map((name) => join(dir, name)).filter(notEmpty)
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const STATUS_FIELDS = ['issue', 'variant', 'title', 'runtime', 'stage', 'state', 'started', 'updated', 'log', 'pr', 'last_error', 'agents', 'hold']
const HISTORY_FIELDS = ['issue', 'variant', 'runtime', 'stage', 'state', 'started', 'finished', 'log', 'tests', 'environment', 'pr']

class Collector {
  readonly status: Collected[] = []
  readonly history: Collected[] = []
  private seq = 0

  // Un valor que no es un objeto no produce fila.
  private project(target: Collected[], value: Json, build: () => Collected): void {
    try {
      get(value, 'pipeline')
      target.push(build())
    } catch (error) {
      if (!(error instanceof JqError)) throw error
    }
  }

  collectStatus(dir: string, origin: Origin): void {
    if (!isDirectory(dir)) return
    for (const file of statusFiles(dir)) {
      const guess = inferPipeline(file.slice(dir.length + 1))
      const seq = ++this.seq
      for (const value of parseStream(readText(file)).values) {
        this.project(this.status, value, () => ({
          origin,
          seq,
          pipeline: alt(get(value, 'pipeline'), guess),
          ...pick(value, STATUS_FIELDS),
        }))
      }
    }
  }

  collectHistory(dir: string, origin: Origin): void {
    if (!isDirectory(dir)) return
    for (const file of historyFiles(dir)) {
      const guess = inferPipeline(file.slice(dir.length + 1))
      for (const line of readText(file).split('\n')) {
        if (line.length === 0) continue
        const seq = ++this.seq
        const { values, clean } = parseStream(line)
        const epoch = clean ? startedEpoch(values) : null
        for (const value of values) {
          this.project(this.history, value, () => ({
            origin,
            seq,
            started_epoch: epoch,
            pipeline: alt(get(value, 'pipeline'), guess),
            ...pick(value, HISTORY_FIELDS),
          }))
        }
      }
    }
  }
}

function startedEpoch(values: Json[]): number | null {
  try {
    return parseEpoch(values.map((value) => text(get(value, 'started'))).join('\n'))
  } catch (error) {
    if (error instanceof JqError) return null
    throw error
  }
}

// Ante la misma clave gana el origen canonico. "issue" se compara como texto: los status
// modernos lo escriben como cadena y los formatos antiguos pueden traerlo numerico.
function dedupe(rows: Collected[], keys: (row: Collected) => Json[]): Collected[] {
  return groupBy(rows, (row) => [row.pipeline ?? null, toText(row.issue ?? null), ...keys(row)]).flatMap((group) =>
    sortBy(group, (row) => (row.origin === 'canonical' ? 0 : 1)).slice(0, 1),
  )
}

function holdCause(row: Collected): Json {
  return alt(get(row.hold, 'cause'), null)
}

// El hold textual solo vale si hay una unica fila legacy "running" sin hold estructurado: con
// mas de una no se sabe a cual pertenece la linea de events.log.
function legacyEligibleCount(rows: Collected[]): number {
  try {
    return rows.filter((row) => row.origin === 'legacy' && row.state === 'running' && holdCause(row) === null).length
  } catch (error) {
    if (error instanceof JqError) return 0
    throw error
  }
}

const CAUSES: Record<string, string> = { RATE_LIMIT: 'limite de uso', PROVIDER_UNAVAILABLE: 'proveedor caido' }

function textFallback(eventsLog: string, now: Date): Json {
  if (!isFile(eventsLog) || !holdRecentlyActive(eventsLog, now)) return null
  const line = lastHoldLine(eventsLog)
  if (line === null || line.length === 0) return null
  const announcement = line.replace(/^\[[0-9:]+\]\[hold\] /, '')
  const cause = /^([A-Za-z_]+): esperando/.exec(announcement)?.[1] ?? ''
  return {
    kind: 'hold',
    cause: Object.hasOwn(CAUSES, cause) ? (CAUSES[cause] ?? cause) : cause,
    next_probe: /^.*proxima sonda (\d{2}:\d{2}:\d{2})/s.exec(announcement)?.[1] ?? null,
    ceiling: /^.*techo (\d{2}:\d{2})/s.exec(announcement)?.[1] ?? null,
  }
}

const PROGRESS: Record<string, Record<string, number>> = {
  tdd: {
    'test-writer': 10,
    'projection-test-writer': 10,
    implementer: 40,
    'projection-implementer': 40,
    'smoke-test-writer': 55,
    reviewer: 70,
    'coverage-gate': 90,
  },
  tooling: { writer: 25, reviewer: 70 },
  infra: { 'infra-writer': 30, 'infra-reviewer': 80 },
}

function progressPct(pipeline: string, stage: string): number | null {
  const agent = stage.includes('-') ? stage.slice(stage.indexOf('-') + 1) : stage
  const table = Object.hasOwn(PROGRESS, pipeline) ? PROGRESS[pipeline] : undefined
  return table !== undefined && Object.hasOwn(table, agent) ? (table[agent] ?? null) : null
}

function firstExisting(roots: Roots, names: string[]): string | null {
  for (const dir of [roots.canonical, roots.legacy]) {
    for (const name of names) {
      const file = join(dir, 'logs', name)
      if (isFile(file)) return file
    }
  }
  return null
}

interface RowTexts {
  pipeline: string
  issue: string
  variant: string
  stage: string
  started: string
}

// Log por stage: TDD stage-N-agente-INICIO-issue-N.log, Tooling tooling-stage-N-agente-INICIO.log,
// Infra iac-stage-N-agente-INICIO[-issue-N].log.
function stageLog(roots: Roots, row: RowTexts): string | null {
  const dash = row.stage.indexOf('-')
  if (dash === -1 || row.started.length === 0) return null
  const stage = `stage-${row.stage.slice(0, dash)}-${row.stage.slice(dash + 1)}-${row.started}`
  const issue = row.variant.length > 0 ? `${row.issue}-${row.variant}` : row.issue
  if (row.pipeline === 'tdd') return firstExisting(roots, [`${stage}-issue-${issue}.log`])
  if (row.pipeline === 'tooling') return firstExisting(roots, [`tooling-${stage}.log`])
  if (row.pipeline === 'infra') return firstExisting(roots, [`iac-${stage}-issue-${issue}.log`, `iac-${stage}.log`])
  return null
}

// Log de la corrida completa.
function runLog(roots: Roots, row: RowTexts): string | null {
  if (row.started.length === 0) return null
  const suffix = row.variant.length > 0 ? `-${row.variant}` : ''
  if (row.pipeline === 'infra') return firstExisting(roots, [`iac-pipeline-${row.started}.log`])
  if (row.pipeline === 'tooling') return firstExisting(roots, [`tooling-pipeline-${row.started}${suffix}.log`])
  if (row.pipeline === 'tdd') return firstExisting(roots, [`pipeline-${row.started}${suffix}.log`])
  return null
}

function textsOf(row: Collected): RowTexts {
  return {
    pipeline: text(row.pipeline ?? null),
    issue: text(row.issue ?? null),
    variant: text(row.variant ?? null),
    stage: text(row.stage ?? null),
    started: text(row.started ?? null),
  }
}

interface Context {
  roots: Roots
  cwd: string
  now: Date
}

function declaredLog(row: Collected, context: Context): string | null {
  const declared = text(row.log ?? null)
  return declared.length > 0 && isFile(resolve(context.cwd, declared)) ? declared : null
}

function activityOf(row: Collected, fallback: Json, stale: boolean): Json {
  if (row.state === 'failed') return null
  const hold = row.hold ?? null
  if (hold !== null && holdCause(row) !== null) {
    return { kind: 'hold', cause: get(hold, 'cause'), next_probe: field(hold, 'next_probe'), ceiling: field(hold, 'ceiling_seconds') }
  }
  if (fallback !== null) return fallback
  return { kind: stale ? 'stale' : 'stage' }
}

// Las filas "completed" no salen: pr-sync deja su status escrito al terminar.
function statusRow(row: Collected, context: Context, eligible: number, fallback: Json): JsonObject | null {
  const texts = textsOf(row)
  const state = text(row.state ?? null)
  if (state === 'completed') return null
  let cause: string
  try {
    cause = text(holdCause(row))
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    cause = ''
  }
  const updated = parseEpoch(text(row.updated ?? null))
  const stale = updated !== null && Math.floor(context.now.getTime() / 1000) - updated > STALE_THRESHOLD_SECONDS
  const textual = row.origin === 'legacy' && state === 'running' && cause.length === 0 && eligible === 1
  const log = declaredLog(row, context) ?? stageLog(context.roots, texts)
  try {
    return {
      ...pickOwn(row, ['pipeline', 'issue', 'variant', 'title', 'runtime', 'stage', 'state', 'started', 'updated', 'origin']),
      log,
      ...pickOwn(row, ['pr', 'last_error', 'agents']),
      activity: activityOf(row, textual ? fallback : null, stale),
      progress_pct: progressPct(texts.pipeline, texts.stage),
    }
  } catch (error) {
    if (error instanceof JqError) return null
    throw error
  }
}

function pickOwn(row: Collected, keys: string[]): JsonObject {
  return Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))
}

function detailOf(row: Collected): Json {
  const pr = row.pr ?? null
  const prNumber = (): Json => toText(pr).split('/').at(-1) ?? null
  const hasPr = pr !== null && pr !== ''
  if ((row.tests ?? null) !== null) return add(toText(row.tests ?? null), ' tests')
  const environment = row.environment ?? null
  if (environment !== null) {
    const base = add('env:', environment)
    return hasPr ? add(add(base, ', PR #'), prNumber()) : base
  }
  return hasPr ? add('PR #', prNumber()) : null
}

function historyRow(row: Collected, context: Context): JsonObject | null {
  const texts = textsOf(row)
  const started = parseEpoch(texts.started)
  const finished = parseEpoch(text(row.finished ?? null))
  const log = declaredLog(row, context) ?? stageLog(context.roots, texts) ?? runLog(context.roots, texts)
  try {
    return {
      ...pickOwn(row, ['pipeline', 'issue', 'variant', 'runtime']),
      result: row.state ?? null,
      duration: started !== null && finished !== null ? finished - started : null,
      detail: detailOf(row),
      ...pickOwn(row, ['pr', 'started', 'origin']),
      log,
    }
  } catch (error) {
    if (error instanceof JqError) return null
    throw error
  }
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

function displayTime(now: Date): string {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  return `${date} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

export interface CollectOptions {
  canonicalDir: string
  legacyDir: string
  now: Date
  /** Contra que carpeta se resuelve un "log" declarado con ruta relativa. */
  cwd: string
}

export function collectWorkStatus(options: CollectOptions): JsonObject {
  const roots: Roots = { canonical: options.canonicalDir, legacy: options.legacyDir }
  const context: Context = { roots, cwd: options.cwd, now: options.now }
  const collector = new Collector()
  collector.collectStatus(roots.canonical, 'canonical')
  collector.collectStatus(roots.legacy, 'legacy')
  collector.collectHistory(roots.canonical, 'canonical')
  collector.collectHistory(roots.legacy, 'legacy')

  const status = dedupe(collector.status, (row) => [alt(row.variant ?? null, '')])
  const runs = dedupe(collector.history, (row) => [alt(row.variant ?? null, ''), alt(row.started ?? null, '')])
  // Primero las fechadas, de la mas reciente a la mas antigua; despues las que no traen "started".
  const dated = sortBy(runs.filter((row) => row.started_epoch !== null), (row) => -Number(row.started_epoch))
  const undated = sortBy(runs.filter((row) => row.started_epoch === null), (row) => -row.seq)

  const eligible = legacyEligibleCount(status)
  const fallback = eligible === 1 ? textFallback(join(roots.legacy, 'events.log'), options.now) : null
  const present = (row: JsonObject | null): row is JsonObject => row !== null
  const rows = status.map((row) => statusRow(row, context, eligible, fallback)).filter(present)
  const history = [...dated, ...undated].slice(0, HISTORY_LIMIT).map((row) => historyRow(row, context)).filter(present)
  return {
    schemaVersion: 1,
    now: displayTime(options.now),
    rows,
    history,
    empty: { status: rows.length === 0, history: history.length === 0 },
  }
}

export interface CollectDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  now: Date
  out: (text: string) => void
  err: (text: string) => void
}

const SELF = fileURLToPath(import.meta.url)

export function main(argv: string[], deps: CollectDeps): number {
  if (argv.length !== 1 || argv[0] !== '--json') {
    deps.err(`Uso: node ${SELF} --json\n`)
    return 2
  }
  const defaults = stateDirs(repoRoot(deps.cwd) ?? deps.cwd)
  const override = (value: string | undefined, fallback: string): string =>
    value !== undefined && value.length > 0 ? value : fallback
  const result = collectWorkStatus({
    canonicalDir: override(deps.env.MEFISTO_STATE_DIR, defaults.canonical),
    legacyDir: override(deps.env.MEFISTO_LEGACY_STATE_DIR, defaults.legacy),
    now: deps.now,
    cwd: deps.cwd,
  })
  deps.out(`${dump(result, 2)}\n`)
  return 0
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    now: new Date(),
    out: (output) => process.stdout.write(output),
    err: (output) => process.stderr.write(output),
  })
}
