// mefisto-metrics-report.mts -- Reporte agregado de metricas del pipeline interno.
//
// Uso:
//   .claude/scripts/mefisto-metrics-report.sh
//   .claude/scripts/mefisto-metrics-report.sh --desde 2026-07-01
//
// Responde donde se va el tiempo de un issue de tooling interno: agrega las corridas
// "mefisto-tooling" de pipeline-history.jsonl (ranking de herramientas, reparto API vs no-API
// del wall-clock agregado, por corrida y writer vs reviewer, deriva semanal y mensual, y
// agregados por harness_version y por runtime). Solo lectura.
//
// El historial se lee de la ubicacion canonica y de la legacy: las corridas viejas se quedan
// en la legacy sin migrar, y leer una sola partiria la serie. Las corridas sin "metrics" se
// listan aparte bajo SIN INSTRUMENTAR, y toda cifra declara sobre cuantas corridas se calculo.
// harness_sha no agrupa (casi cada corrida seria su propio grupo): es una columna de "Por
// corrida". El runtime de "POR RUNTIME" es el de la corrida, no el de cada agente.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CliError, isEntryPoint } from '../../../scripts/lib/cli.mts'
import { JqError, add, alt, get, groupBy, iterate, path, sortBy, sum } from '../../../scripts/lib/jq-values.mts'
import type { Json, JsonObject } from '../../../scripts/lib/jq-values.mts'
import {
  NO_VERSION,
  byVersion,
  cell,
  comparisonDeltas,
  costCoverage,
  fmt,
  fmtDurS,
  fmtPct,
  groupSummary,
  inWindow,
  legacyIssues,
  mean,
  money,
  monthKey,
  normalizeAgentMetrics,
  num0,
  num1,
  outLines,
  parseDateFlags,
  parseHistory,
  parseStarted,
  perRun,
  perRunCells,
  perRunRows,
  perThousand,
  periodSummary,
  raw,
  readHistory,
  renderDeltas,
  renderLegacyIssues,
  renderPeriodTable,
  renderToolRanking,
  renderWallclockAggregate,
  runReport,
  startedRange,
  summarizeMetrics,
  tableRows,
  toolRanking,
  txt,
  wallclockAggregate,
  weekKey,
} from '../../../scripts/lib/metrics-report.mts'
import type { ReportIo, Run, RunAccessors } from '../../../scripts/lib/metrics-report.mts'
import { stateDirs } from '../../../scripts/lib/state.mts'
import { assertInMefisto } from './lib/mefisto-repo.mts'
import type { MefistoRepo } from './lib/mefisto-repo.mts'

const HELP = `Uso: mefisto-metrics-report.sh [--desde YYYY-MM-DD]

Reporte agregado de las corridas del pipeline mefisto-tooling: ranking de
herramientas, reparto del wall-clock (API vs no-API, writer vs reviewer),
deriva temporal semanal/mensual y agregados por harness_version (que version
corrio cada corrida, con harness_sha por-corrida en "Por corrida") y por
runtime (con que runtime corrio cada corrida). Solo lectura.`

const RULE_MAJOR = '='.repeat(120)
const RULE_MINOR = '-'.repeat(120)
const NO_RUNTIME = '(sin runtime)'
const HISTORY = 'pipeline-history.jsonl'

interface ToolingRun extends Run {
  runtime: string
}

type Agent = 'writer' | 'reviewer'

const normalized = new WeakMap<JsonObject, Partial<Record<Agent, JsonObject | null>>>()

function metricsOf(entry: JsonObject, agent: Agent): JsonObject | null {
  let cached = normalized.get(entry)
  if (cached === undefined) normalized.set(entry, (cached = {}))
  let metrics = cached[agent]
  if (metrics === undefined) cached[agent] = metrics = normalizeAgentMetrics(path(entry, 'agents', agent, 'metrics'))
  return metrics
}

const both = (entry: JsonObject, ...keys: string[]): [Json, Json] => [
  path(metricsOf(entry, 'writer'), ...keys),
  path(metricsOf(entry, 'reviewer'), ...keys),
]

const total = ([writer, reviewer]: [Json, Json], fallback: Json): Json => add(alt(writer, fallback), alt(reviewer, fallback))

// null solo cuando ningun agente dejo el dato; un 0 real sigue sumando como 0.
function sumOrNull(pair: [Json, Json]): Json {
  return pair[0] === null && pair[1] === null ? null : total(pair, 0)
}

const present = (values: Json[]): number => values.filter((value) => value !== null).length

const ACCESSORS: RunAccessors = {
  apiMs: (entry) => total(both(entry, 'api_duration_ms'), 0),
  nonApiMs: (entry) => total(both(entry, 'non_api_ms'), 0),
  toolCalls: (entry) => total(both(entry, 'tool_calls'), []),
  turns: (entry) => sumOrNull(both(entry, 'turns')),
  tokensInput: (entry) => sumOrNull(both(entry, 'tokens', 'input')),
  tokensOutput: (entry) => sumOrNull(both(entry, 'tokens', 'output')),
  cacheRead: (entry) => sumOrNull(both(entry, 'tokens', 'cache_read')),
  cacheWrite: (entry) => sumOrNull(both(entry, 'tokens', 'cache_write')),
  reasoning: (entry) => sumOrNull(both(entry, 'tokens', 'reasoning')),
  estimatedCost: (entry) => sumOrNull(both(entry, 'estimated_cost_usd')),
  legacyCost: (entry) => sumOrNull(both(entry, 'legacy_reported_cost_usd')),
  metricsAgents: (entry) => present([metricsOf(entry, 'writer'), metricsOf(entry, 'reviewer')]),
  estimatedCostAgents: (entry) => present(both(entry, 'estimated_cost_usd')),
}

function wallSeconds(entry: JsonObject): Json {
  const writer = path(entry, 'agents', 'writer', 'duration')
  if (writer === null && path(entry, 'agents', 'reviewer', 'duration') === null) return null
  return add(alt(writer, 0), alt(path(entry, 'agents', 'reviewer', 'duration'), 0))
}

// `metrics` de un agente que no es un objeto se lee como ausente, sin fallar.
function hasMetrics(entry: JsonObject, agent: Agent): boolean {
  const slot = path(entry, 'agents', agent)
  try {
    return alt(get(slot, 'metrics'), null) !== null
  } catch (error) {
    if (error instanceof JqError) return false
    throw error
  }
}

function toRun(entry: JsonObject): ToolingRun {
  const version = get(entry, 'harness_version')
  const runtime = get(entry, 'runtime')
  return {
    entry,
    wallS: wallSeconds(entry),
    hasMetrics: hasMetrics(entry, 'writer') || hasMetrics(entry, 'reviewer'),
    ts: parseStarted(get(entry, 'started')),
    version: typeof version === 'string' ? version : NO_VERSION,
    runtime: typeof runtime === 'string' ? runtime : NO_RUNTIME,
  }
}

function summarizeAgent(runs: ToolingRun[], agent: Agent): JsonObject {
  const metrics = runs.map((run) => metricsOf(run.entry, agent)).filter((item) => item !== null)
  const toolCalls = metrics.map((item) =>
    alt(sum(iterate(alt(get(item, 'tool_calls'), [])).map((call) => get(call, 'count'))), 0),
  )
  return { ...summarizeMetrics(metrics), tool_calls_mean: mean(toolCalls) }
}

function buildComparison(monthly: JsonObject[]): Json {
  const months = monthly.filter((month) => Number(get(month, 'n_instrumented')) > 0)
  const [first, last] = [months[0], months.at(-1)]
  if (months.length < 2 || first === undefined || last === undefined) return null
  return { first, last, deltas: comparisonDeltas(first, last, 'Wall medio (issue)') }
}

function byRuntime(runs: ToolingRun[]): JsonObject[] {
  const groups = groupBy(runs, (run) => run.runtime).map(
    (group): JsonObject => ({ ...groupSummary(group, ACCESSORS), runtime: group[0]?.runtime ?? NO_RUNTIME }),
  )
  return sortBy(groups, (group) => [get(group, 'runtime') === NO_RUNTIME, get(group, 'runtime')])
}

/**
 * Agrega las corridas "mefisto-tooling" del historial en un objeto. `desde` es `''` o
 * `YYYY-MM-DD`. Devuelve `null` si el historial trae tipos con los que no se puede operar.
 */
export function computeMetricsReport(content: string, desde: string): JsonObject | null {
  try {
    const runs = parseHistory(content)
      .filter((entry) => get(entry, 'pipeline') === 'mefisto-tooling')
      .filter((entry) => inWindow(entry, desde, ''))
      .map(toRun)
    const legacy = runs.filter((run) => !run.hasMetrics)
    const instrumented = runs.filter((run) => run.hasMetrics)
    const weekly = periodSummary(runs, weekKey, ACCESSORS)
    const monthly = periodSummary(runs, monthKey, ACCESSORS)
    return {
      meta: {
        total: runs.length,
        instrumented: instrumented.length,
        legacy: legacy.length,
        ...costCoverage(instrumented, ACCESSORS),
        desde: desde === '' ? null : desde,
        ...startedRange(runs),
      },
      tool_ranking: toolRanking(instrumented, ACCESSORS),
      wallclock: {
        aggregate: wallclockAggregate(instrumented, ACCESSORS),
        per_run: perRun(instrumented, ACCESSORS, (run) => {
          const sha = get(run.entry, 'harness_sha')
          return { harness_sha: typeof sha === 'string' ? sha : null }
        }),
        writer: summarizeAgent(instrumented, 'writer'),
        reviewer: summarizeAgent(instrumented, 'reviewer'),
      },
      series: { weekly, monthly },
      by_version: byVersion(runs, ACCESSORS),
      by_runtime: byRuntime(runs),
      legacy: { count: legacy.length, issues: legacyIssues(legacy) },
      comparison: buildComparison(monthly),
    }
  } catch (error) {
    if (error instanceof JqError) return null
    throw error
  }
}

function renderHeader(io: ReportIo, agg: JsonObject): void {
  const meta = (key: string): string => raw(path(agg, 'meta', key))
  const or = (key: string, missing: string): string => raw(alt(path(agg, 'meta', key), missing))
  io.out(RULE_MAJOR)
  io.out('Mefisto - Reporte agregado de metricas del pipeline interno')
  io.out(RULE_MAJOR)
  io.out(`Filtro --desde: ${or('desde', '(todo el historico)')}`)
  io.out(
    `Corridas mefisto-tooling en la ventana: ${meta('total')} (instrumentadas: ${meta('instrumented')}, sin instrumentar: ${meta('legacy')})`,
  )
  io.out(
    `Costo estimado con valor: ${meta('estimated_cost_runs')} corridas (completas: ${meta('estimated_cost_complete_runs')}, parciales: ${meta('estimated_cost_partial_runs')}); sin estimacion: ${meta('estimated_cost_missing_runs')}`,
  )
  io.out(`Costo reportado legado: ${meta('legacy_cost_runs')} corridas (separado; excluido de estimados)`)
  if (Number(path(agg, 'meta', 'total')) > 0) io.out(`Rango: ${or('oldest_started', '-')} -> ${or('newest_started', '-')}`)
}

const AGENT_KEYS = [
  'n',
  'turns_mean',
  'tokens_input_mean',
  'tokens_output_mean',
  'tokens_cache_read_mean',
  'tokens_cache_write_mean',
  'tokens_reasoning_mean',
  'estimated_cost_usd_mean',
  'estimated_cost_usd_total',
  'legacy_reported_cost_usd_mean',
  'legacy_reported_cost_usd_total',
]
const AGENT_DURATIONS = ['duration_ms_mean', 'duration_api_ms_mean', 'non_api_ms_mean']

function agentColumn(summary: Json): string[] {
  const [count, turns, tokIn, tokOut, cacheRd, cacheWr, reasoning, estMean, estTotal, legMean, legTotal] = AGENT_KEYS.map(
    (key) => get(summary, key),
  )
  const [duration, api, nonApi] = AGENT_DURATIONS.map((key) => perThousand(get(summary, key)))
  return [
    cell(count),
    num1(turns),
    num0(tokIn),
    num0(tokOut),
    num0(cacheRd),
    num0(cacheWr),
    num0(reasoning),
    money(estMean),
    money(estTotal),
    money(legMean),
    money(legTotal),
    fmtDurS(duration),
    fmtDurS(api),
    fmtDurS(nonApi),
  ]
}

const AGENT_ROWS = [
  'Corridas (n)',
  'Turnos medios',
  'Tokens in medios',
  'Tokens out medios',
  'Cache read medio',
  'Cache write medio',
  'Reasoning medio',
  'Costo estimado medio',
  'Costo estimado total',
  'Costo legado reportado',
  'Costo legado total',
  'Duracion media',
  '  de la cual API',
  '  de la cual no-API',
]

function renderWallclock(io: ReportIo, agg: Json): void {
  if (!renderWallclockAggregate(io, agg, RULE_MINOR)) return
  io.out('')
  io.out('Por corrida:')
  io.out(
    fmt('%-8s %-17s %-11s %8s %8s %8s %8s %7s %10s %-14s %10s %9s', 'Issue', 'Inicio', 'Estado', 'Wall', 'API', 'No-API', 'Tools', '%API', 'Costo est.', 'Cobertura est.', 'Costo leg.', 'SHA'),
  )
  for (const row of perRunRows(agg, ['harness_sha'])) {
    io.out(fmt('#%-7s %-17s %-11s %8s %8s %8s %8s %7s %10s %-14s %10s %9s', ...perRunCells(row), txt(row[11])))
  }

  io.out('')
  io.out('Writer vs Reviewer:')
  const writer = agentColumn(path(agg, 'wallclock', 'writer'))
  const reviewer = agentColumn(path(agg, 'wallclock', 'reviewer'))
  const columns = '%-24s %14s %14s'
  io.out(fmt(columns, '', 'Writer', 'Reviewer'))
  AGENT_ROWS.forEach((label, index) => io.out(fmt(columns, label, writer[index] ?? '', reviewer[index] ?? '')))
}

function renderComparison(io: ReportIo, agg: Json): void {
  const comparison = get(agg, 'comparison')
  io.out('')
  io.out(RULE_MINOR)
  io.out('RESUMEN: QUE CRECIO (primer vs ultimo mes con corridas instrumentadas)')
  io.out(RULE_MINOR)
  if (comparison === null) {
    io.out('(se necesitan al menos 2 meses con corridas instrumentadas para comparar)')
    return
  }
  const side = (which: string): string => {
    const period = (key: string): string => raw(path(comparison, which, key))
    return `${period('period')} (n=${period('n_instrumented')}; costo estimado=${period('estimated_cost_n')}/${period('n_instrumented')})`
  }
  io.out(`Comparando ${side('first')} vs ${side('last')}:`)
  io.out('Todas las filas, el wall incluido, se calculan solo sobre esas corridas')
  io.out('instrumentadas -- si no compartieran denominador la atribucion no valdria.')
  io.out('')
  renderDeltas(io, comparison)
}

const GROUP_KEYS = ['n_total', 'n_instrumented', 'wall_mean_instr_s', 'turns_mean', 'pct_api', 'estimated_cost_usd_mean']

// Una fila por valor de `axis` (version o runtime), con los mismos agregados.
function renderGroups(io: ReportIo, groups: Json, axis: string, heading: string, title: string, notes: string[]): void {
  const items = iterate(groups)
  io.out('')
  io.out(RULE_MINOR)
  io.out(title)
  io.out(RULE_MINOR)
  if (items.length === 0) {
    io.out('(sin corridas en la ventana)')
    return
  }
  for (const note of notes) io.out(note)
  io.out('')
  const columns = '%-20s %-8s %10s %7s %7s %10s'
  io.out(fmt(columns, heading, 'n(t/i)', 'WallMedia', 'Turnos', '%API', 'Costo est.'))
  for (const row of tableRows(items, (group) => [axis, ...GROUP_KEYS].map((key) => get(group, key)))) {
    const [name, count, instrumented, wall, turns, pctApi, cost] = row
    io.out(fmt(columns, txt(name), `${cell(count)}/${cell(instrumented)}`, fmtDurS(wall), num1(turns), fmtPct(pctApi), money(cost)))
  }
}

function renderLegacy(io: ReportIo, agg: Json): void {
  const count = path(agg, 'legacy', 'count')
  io.out('')
  io.out(RULE_MINOR)
  io.out(`SIN INSTRUMENTAR (n=${raw(count)} -- corridas previas a #426, solo duracion total)`)
  io.out(RULE_MINOR)
  if (count === 0) {
    io.out('(ninguna en la ventana)')
    return
  }
  renderLegacyIssues(io, agg)
}

export interface ReportDeps extends ReportIo {
  cwd: string
  env: NodeJS.ProcessEnv
  resolveRepo?: (cwd: string) => MefistoRepo
}

function historySources(root: string, env: NodeJS.ProcessEnv): { files: string[]; label: string } {
  const defaults = stateDirs(root)
  const dir = (override: string | undefined, fallback: string): string =>
    override !== undefined && override.length > 0 ? override : fallback
  const candidates = [dir(env.MEFISTO_STATE_DIR, defaults.canonical), dir(env.MEFISTO_LEGACY_STATE_DIR, defaults.legacy)].map(
    (base) => join(base, HISTORY),
  )
  const files = candidates.filter((file) => existsSync(file))
  // Sin ningun historial, el mensaje nombra la ruta donde va a aparecer.
  return { files, label: files.length === 0 ? (candidates[0] ?? HISTORY) : files.join(' ') }
}

function report(argv: string[], deps: ReportDeps): number {
  const repo = (deps.resolveRepo ?? assertInMefisto)(deps.cwd)
  const flags = parseDateFlags(argv, ['--desde'], '--desde YYYY-MM-DD')
  if (flags === null) {
    outLines(deps, HELP)
    return 0
  }

  const { files, label } = historySources(repo.root, deps.env)
  const agg = computeMetricsReport(readHistory(files), flags['--desde'] ?? '')
  if (agg === null) throw new CliError(`ERROR: no se pudo procesar el historial (${label})`)

  renderHeader(deps, agg)
  if (path(agg, 'meta', 'total') === 0) {
    deps.out('')
    deps.out('(sin corridas registradas en la ventana solicitada)')
    return 0
  }
  renderToolRanking(deps, agg, RULE_MINOR)
  renderWallclock(deps, agg)
  renderPeriodTable(deps, path(agg, 'series', 'weekly'), 'DERIVA TEMPORAL - SEMANAL', RULE_MINOR)
  renderPeriodTable(deps, path(agg, 'series', 'monthly'), 'DERIVA TEMPORAL - MENSUAL', RULE_MINOR)
  renderComparison(deps, agg)
  renderGroups(deps, get(agg, 'by_version'), 'version', 'Version', 'POR VERSION DE HARNESS (n = corridas totales/instrumentadas de esa version)', [
    'n(t/i) = corridas totales / de ellas instrumentadas. A diferencia de la',
    'deriva temporal, aqui TODAS las cifras -- el wall incluido -- salen solo',
    'de las instrumentadas: comparar dos versiones exige el mismo denominador.',
  ])
  renderGroups(deps, get(agg, 'by_runtime'), 'runtime', 'Runtime', 'POR RUNTIME (n = corridas totales/instrumentadas de ese runtime)', [
    'n(t/i) = corridas totales / de ellas instrumentadas. Mismo criterio que POR',
    'VERSION DE HARNESS: todas las cifras -- el wall incluido -- salen solo de las',
    'instrumentadas.',
  ])
  renderLegacy(deps, agg)
  deps.out('')
  deps.out(RULE_MAJOR)
  return 0
}

export function run(argv: string[], deps: ReportDeps): number {
  return runReport(deps, () => report(argv, deps))
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
