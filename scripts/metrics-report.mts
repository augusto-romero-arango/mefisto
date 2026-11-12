// metrics-report.mts -- Reporte agregado de metricas de los pipelines del consumidor.
//
// Uso:
//   node scripts/metrics-report.mts
//   node scripts/metrics-report.mts --desde 2026-08-01 --hasta 2026-08-15
//
// Agrega los pipeline-history.jsonl canonico y legacy del repo principal (una linea por corrida,
// con agents.<stage>.metrics): ranking de herramientas, reparto API vs no-API del wall-clock,
// turnos por stage, deriva semanal y mensual y agregados por harness_version, todo segmentado
// por el valor de "pipeline". Solo lectura.
//
// - tdd, tooling e infra aparecen siempre, en ese orden; cualquier otro valor de "pipeline" se
//   agrega al final y una linea sin el campo cae en "(sin-pipeline)".
// - Los stages se leen de las claves presentes en cada linea; las que no traen "metrics"
//   (coverage-gate) quedan fuera de turnos, tokens y tool calls sin nombrarlas.
// - "Por stage" agrupa por (stage, agente, modelo): la ruta read-side corre otros agentes bajo
//   las mismas claves, y turnos de modelos o agentes distintos no se promedian en una cifra.

import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { CliError, gitOutput, isEntryPoint, repoRoot } from './lib/cli.mts'
import { JqError, alt, get, groupBy, iterate, path, sortBy, sum, toEntries, unique } from './lib/jq-values.mts'
import type { Json, JsonObject } from './lib/jq-values.mts'
import {
  NO_DATE,
  NO_VERSION,
  byVersion,
  cell,
  comparisonDeltas,
  costCoverage,
  fmt,
  fmtDurS,
  fmtPct,
  inWindow,
  legacyIssues,
  money,
  monthKey,
  nonNull,
  normalizeAgentMetrics,
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
} from './lib/metrics-report.mts'
import type { ReportIo, Run, RunAccessors } from './lib/metrics-report.mts'
import { stateReadPaths } from './lib/state.mts'

const HELP = `Uso: metrics-report.mts [--desde YYYY-MM-DD] [--hasta YYYY-MM-DD]

Reporte agregado de las corridas de los pipelines del consumidor (tdd/tooling/
infra), segmentado por pipeline: ranking de herramientas, reparto del
wall-clock (API vs no-API), deriva de turnos por stage (con su modelo
declarado), deriva temporal semanal/mensual y agregados por harness_version
(que version corrio cada corrida). --desde/--hasta acotan la ventana
analizada (por defecto, todo el historico). Solo lectura.`

const RULE_MAJOR = '='.repeat(139)
const RULE_MINOR = '-'.repeat(139)
const NO_PIPELINE = '(sin-pipeline)'
const KNOWN_PIPELINES = ['tdd', 'tooling', 'infra']

interface PipelineRun extends Run {
  pipeline: string
}

interface StagePair {
  stage: string | number
  metrics: JsonObject | null
}

const agentsOf = (entry: JsonObject): Json => alt(get(entry, 'agents'), {})

const pairsByEntry = new WeakMap<JsonObject, StagePair[]>()

// Las claves de `agents` cuya `metrics` no es null, sin nombrar ninguna.
function stagePairs(entry: JsonObject): StagePair[] {
  let pairs = pairsByEntry.get(entry)
  if (pairs === undefined) {
    pairs = toEntries(agentsOf(entry))
      .filter((agent) => get(agent.value, 'metrics') !== null)
      .map((agent) => ({ stage: agent.key, metrics: normalizeAgentMetrics(get(agent.value, 'metrics')) }))
    pairsByEntry.set(entry, pairs)
  }
  return pairs
}

const perStage = (entry: JsonObject, ...keys: string[]): Json[] =>
  stagePairs(entry).map((pair) => path(pair.metrics, ...keys))

function sumPresent(values: Json[]): Json {
  const present = nonNull(values)
  return present.length === 0 ? null : sum(present)
}

const ACCESSORS: RunAccessors = {
  apiMs: (entry) => alt(sum(perStage(entry, 'api_duration_ms').map((value) => alt(value, 0))), 0),
  nonApiMs: (entry) => alt(sum(perStage(entry, 'non_api_ms').map((value) => alt(value, 0))), 0),
  toolCalls: (entry) => perStage(entry, 'tool_calls').flatMap((calls) => iterate(alt(calls, []))),
  turns: (entry) => sumPresent(perStage(entry, 'turns')),
  tokensInput: (entry) => sumPresent(perStage(entry, 'tokens', 'input')),
  tokensOutput: (entry) => sumPresent(perStage(entry, 'tokens', 'output')),
  cacheRead: (entry) => sumPresent(perStage(entry, 'tokens', 'cache_read')),
  cacheWrite: (entry) => sumPresent(perStage(entry, 'tokens', 'cache_write')),
  reasoning: (entry) => sumPresent(perStage(entry, 'tokens', 'reasoning')),
  estimatedCost: (entry) => sumPresent(perStage(entry, 'estimated_cost_usd')),
  legacyCost: (entry) => sumPresent(perStage(entry, 'legacy_reported_cost_usd')),
  metricsAgents: (entry) => stagePairs(entry).length,
  estimatedCostAgents: (entry) => nonNull(perStage(entry, 'estimated_cost_usd')).length,
}

function wallSeconds(entry: JsonObject): Json {
  const durations = iterate(agentsOf(entry)).map((agent) => get(agent, 'duration'))
  return durations.every((duration) => duration === null) ? null : sum(durations.map((value) => alt(value, 0)))
}

function versionOf(entry: JsonObject): string {
  const identity = path(entry, 'identity', 'harness_version')
  if (typeof identity === 'string') return identity
  const flat = get(entry, 'harness_version')
  return typeof flat === 'string' ? flat : NO_VERSION
}

function toRun(entry: JsonObject): PipelineRun {
  const pipeline = get(entry, 'pipeline')
  return {
    entry,
    wallS: wallSeconds(entry),
    hasMetrics: iterate(agentsOf(entry))
      .map((agent) => get(agent, 'metrics'))
      .some((metrics) => metrics !== null),
    ts: parseStarted(get(entry, 'started')),
    pipeline: typeof pipeline === 'string' ? pipeline : NO_PIPELINE,
    version: versionOf(entry),
  }
}

function byStage(runs: PipelineRun[]): Json[] {
  const rows = runs.flatMap((run) =>
    stagePairs(run.entry).map((pair) => ({
      stage: pair.stage,
      agent: get(pair.metrics, 'agent'),
      model: alt(get(pair.metrics, 'model'), '(desconocido)'),
      metrics: pair.metrics,
    })),
  )
  const groups = groupBy(rows, (row) => [row.stage, row.agent, row.model]).map((group) => {
    const head = group[0]
    return {
      ...summarizeMetrics(group.map((row) => row.metrics)),
      stage: head?.stage ?? null,
      agent: head?.agent ?? null,
      model: head?.model ?? null,
    }
  })
  return sortBy(groups, (group) => [group.stage, alt(group.agent, ''), group.model])
}

const withData = (periods: JsonObject[]): JsonObject[] =>
  periods.filter((period) => get(period, 'period') !== NO_DATE && Number(get(period, 'n_instrumented')) > 0)

// Compara semanas si la ventana ya trae dos con datos; si no, meses.
function buildComparison(weekly: JsonObject[], monthly: JsonObject[]): Json {
  const [weeks, months] = [withData(weekly), withData(monthly)]
  const [granularity, periods] = weeks.length >= 2 ? ['semanal', weeks] : ['mensual', months]
  const [first, last] = [periods[0], periods.at(-1)]
  if (periods.length < 2 || first === undefined || last === undefined) return null
  return { granularity, first, last, deltas: comparisonDeltas(first, last, 'Wall medio (corrida)') }
}

function pipelineReport(runs: PipelineRun[]): JsonObject {
  const instrumented = runs.filter((run) => run.hasMetrics)
  const legacy = runs.filter((run) => !run.hasMetrics)
  const weekly = periodSummary(runs, weekKey, ACCESSORS)
  const monthly = periodSummary(runs, monthKey, ACCESSORS)
  return {
    meta: {
      total: runs.length,
      instrumented: instrumented.length,
      legacy: legacy.length,
      ...costCoverage(instrumented, ACCESSORS),
      ...startedRange(runs),
    },
    tool_ranking: toolRanking(instrumented, ACCESSORS),
    wallclock: {
      aggregate: wallclockAggregate(instrumented, ACCESSORS),
      per_run: perRun(instrumented, ACCESSORS),
      by_stage: byStage(runs),
    },
    series: { weekly, monthly },
    by_version: byVersion(runs, ACCESSORS),
    legacy: { count: legacy.length, issues: legacyIssues(legacy) },
    comparison: buildComparison(weekly, monthly),
  }
}

/**
 * Agrega el contenido de los historiales (el canonico primero) en un objeto segmentado por
 * pipeline. `desde` y `hasta` son `''` o `YYYY-MM-DD`. Devuelve `null` si el historial trae
 * tipos con los que no se puede operar.
 */
export function computeMetricsReport(content: string, desde: string, hasta: string): JsonObject | null {
  try {
    // Solo se colapsa la identidad completa de una corrida, y gana la primera fuente.
    const identity = (entry: JsonObject): Json => ['pipeline', 'issue', 'variant', 'started'].map((key) => get(entry, key))
    const entries = groupBy(parseHistory(content), identity).flatMap((group) => group.slice(0, 1))
    const runs = entries.filter((entry) => inWindow(entry, desde, hasta)).map(toRun)
    const names = unique([...KNOWN_PIPELINES, ...runs.map((run) => run.pipeline)])
    const reports = names.map((name) => pipelineReport(runs.filter((run) => run.pipeline === name)))
    return {
      meta: {
        total: runs.length,
        desde: desde === '' ? null : desde,
        hasta: hasta === '' ? null : hasta,
        ...startedRange(runs),
        by_pipeline: names.map((pipeline, index) => ({
          pipeline,
          total: path(reports[index], 'meta', 'total'),
          instrumented: path(reports[index], 'meta', 'instrumented'),
          legacy: path(reports[index], 'meta', 'legacy'),
        })),
      },
      pipelines: Object.fromEntries(names.map((name, index) => [name, reports[index] ?? null])),
    }
  } catch (error) {
    if (error instanceof JqError) return null
    throw error
  }
}

function renderOverallHeader(io: ReportIo, agg: JsonObject): void {
  const meta = get(agg, 'meta')
  const total = get(meta, 'total')
  io.out(RULE_MAJOR)
  io.out('Mefisto - Reporte agregado de metricas de pipelines del consumidor')
  io.out(RULE_MAJOR)
  io.out(
    `Filtro --desde: ${raw(alt(get(meta, 'desde'), '(sin limite inferior)'))}  --hasta: ${raw(alt(get(meta, 'hasta'), '(sin limite superior)'))}`,
  )
  io.out(`Corridas totales en la ventana: ${raw(total)}`)
  if (Number(total) > 0) {
    io.out(`Rango: ${raw(alt(get(meta, 'oldest_started'), '-'))} -> ${raw(alt(get(meta, 'newest_started'), '-'))}`)
  }
  io.out('')
  io.out('Por pipeline:')
  const rows = tableRows(iterate(get(meta, 'by_pipeline')), (item) =>
    ['pipeline', 'total', 'instrumented', 'legacy'].map((key) => get(item, key)),
  )
  for (const [name, total_, instrumented, legacy] of rows) {
    io.out(
      fmt('  %-8s %5s corridas (instrumentadas: %s, sin instrumentar: %s)', txt(name), cell(total_), cell(instrumented), cell(legacy)),
    )
  }
}

function renderPipelineHeader(io: ReportIo, agg: Json, name: string): void {
  const meta = (key: string): string => raw(path(agg, 'meta', key))
  io.out('')
  io.out(RULE_MAJOR)
  io.out(`PIPELINE: ${name} (total=${meta('total')}, instrumentadas=${meta('instrumented')}, sin instrumentar=${meta('legacy')})`)
  io.out(
    `Costo estimado con valor: ${meta('estimated_cost_runs')} corridas (completas: ${meta('estimated_cost_complete_runs')}, parciales: ${meta('estimated_cost_partial_runs')}); sin estimacion: ${meta('estimated_cost_missing_runs')}`,
  )
  io.out(`Costo reportado legado: ${meta('legacy_cost_runs')} corridas (separado; excluido de estimados)`)
  io.out(RULE_MAJOR)
}

function renderByStage(io: ReportIo, agg: Json): void {
  const stages = iterate(path(agg, 'wallclock', 'by_stage'))
  io.out('')
  io.out('Por stage (n = corridas instrumentadas de ESE stage; agente y modelo declarados, CA-2):')
  if (stages.length === 0) {
    io.out('(sin corridas instrumentadas de ningun stage en la ventana)')
    return
  }
  const columns = '%-18s %-22s %-16s %4s %6s %8s %7s %7s %10s %10s'
  io.out(fmt(columns, 'Stage', 'Agente', 'Modelo', 'n', 'Turnos', 'Duracion', 'API', 'No-API', 'Costo est.', 'Costo leg.'))
  const rows = tableRows(stages, (stage) => [
    get(stage, 'stage'),
    get(stage, 'agent'),
    get(stage, 'model'),
    get(stage, 'n'),
    get(stage, 'turns_mean'),
    perThousand(get(stage, 'duration_ms_mean')),
    perThousand(get(stage, 'duration_api_ms_mean')),
    perThousand(get(stage, 'non_api_ms_mean')),
    get(stage, 'estimated_cost_usd_mean'),
    get(stage, 'legacy_reported_cost_usd_mean'),
  ])
  for (const [stage, agent, model, count, turns, duration, api, nonApi, estimated, legacy] of rows) {
    io.out(
      fmt(columns, txt(stage), txt(agent), txt(model), cell(count), num1(turns), fmtDurS(duration), fmtDurS(api), fmtDurS(nonApi), money(estimated), money(legacy)),
    )
  }
}

function renderWallclock(io: ReportIo, agg: Json): void {
  if (!renderWallclockAggregate(io, agg, RULE_MINOR)) return
  io.out('')
  io.out('Por corrida:')
  io.out(
    fmt('%-8s %-17s %-11s %8s %8s %8s %8s %7s %10s %-14s %10s', 'Issue', 'Inicio', 'Estado', 'Wall', 'API', 'No-API', 'Tools', '%API', 'Costo est.', 'Cobertura est.', 'Costo leg.'),
  )
  for (const row of perRunRows(agg)) {
    io.out(fmt('#%-7s %-17s %-11s %8s %8s %8s %8s %7s %10s %-14s %10s', ...perRunCells(row)))
  }
  renderByStage(io, agg)
}

function renderComparison(io: ReportIo, agg: Json): void {
  const comparison = get(agg, 'comparison')
  io.out('')
  io.out(RULE_MINOR)
  io.out('RESUMEN: QUE CRECIO (primer vs ultimo periodo con corridas instrumentadas)')
  io.out(RULE_MINOR)
  if (comparison === null) {
    io.out('(se necesitan al menos 2 periodos -- semanales o mensuales -- con corridas')
    io.out(' instrumentadas dentro de la ventana para comparar; ajusta --desde/--hasta)')
    return
  }
  const side = (which: string, key: string): string => raw(path(comparison, which, key))
  io.out(
    `Granularidad: ${raw(get(comparison, 'granularity'))}. Comparando ${side('first', 'period')} (n=${side('first', 'n_instrumented')}) vs ${side('last', 'period')} (n=${side('last', 'n_instrumented')}):`,
  )
  io.out('Todas las filas, el wall incluido, se calculan solo sobre esas corridas')
  io.out('instrumentadas -- si no compartieran denominador la atribucion no valdria.')
  io.out('')
  renderDeltas(io, comparison)
}

function renderByVersion(io: ReportIo, agg: Json): void {
  const versions = iterate(get(agg, 'by_version'))
  io.out('')
  io.out(RULE_MINOR)
  io.out('POR VERSION DE HARNESS (n = corridas totales/instrumentadas de esa version)')
  io.out(RULE_MINOR)
  if (versions.length === 0) {
    io.out('(sin corridas en la ventana)')
    return
  }
  io.out('n(t/i) = corridas totales / de ellas instrumentadas. A diferencia de la')
  io.out('deriva temporal, aqui TODAS las cifras -- el wall incluido -- salen solo')
  io.out('de las instrumentadas: comparar dos versiones exige el mismo denominador.')
  io.out('')
  const columns = '%-20s %-8s %10s %7s %7s %8s %10s %10s'
  io.out(fmt(columns, 'Version', 'n(t/i)', 'WallMedia', 'Turnos', '%API', 'n(est)', 'Costo est.', 'Costo leg.'))
  const keys = ['version', 'n_total', 'n_instrumented', 'wall_mean_instr_s', 'turns_mean', 'pct_api', 'estimated_cost_n', 'estimated_cost_usd_mean', 'legacy_reported_cost_usd_mean']
  for (const row of tableRows(versions, (version) => keys.map((key) => get(version, key)))) {
    const [version, total, instrumented, wall, turns, pctApi, estimatedN, estimated, legacy] = row
    io.out(
      fmt(columns, txt(version), `${cell(total)}/${cell(instrumented)}`, fmtDurS(wall), num1(turns), fmtPct(pctApi), `${cell(estimatedN)}/${cell(instrumented)}`, money(estimated), money(legacy)),
    )
  }
}

function renderLegacy(io: ReportIo, agg: Json): void {
  const count = path(agg, 'legacy', 'count')
  io.out('')
  io.out(RULE_MINOR)
  io.out(`SIN INSTRUMENTAR (n=${raw(count)} -- corridas de este pipeline sin agents.<stage>.metrics)`)
  io.out(RULE_MINOR)
  if (count === 0) {
    io.out('(ninguna en la ventana)')
    return
  }
  renderLegacyIssues(io, agg)
}

// tdd, tooling e infra primero; despues, por orden, los demas nombres presentes. Un nombre vacio
// o con saltos de linea no llega a tener seccion.
function sectionNames(pipelines: Json): string[] {
  const names = [...KNOWN_PIPELINES]
  const present = toEntries(pipelines).map((entry) => String(entry.key))
  for (const extra of unique(present).flatMap((name) => name.split('\n'))) {
    if (extra.length > 0 && !names.includes(extra)) names.push(extra)
  }
  return names.filter((name) => present.includes(name))
}

// El .git compartido es absoluto desde un worktree y relativo desde el repo principal.
function mainRepoTop(top: string): string {
  const common = gitOutput(['rev-parse', '--git-common-dir'], top) ?? ''
  if (common.length === 0) return top
  return isAbsolute(common) ? dirname(common) : resolve(top, dirname(common))
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export interface ReportDeps extends ReportIo {
  cwd: string
}

function report(argv: string[], deps: ReportDeps): number {
  const top = repoRoot(deps.cwd)
  if (top === null) throw new CliError('ERROR: no estas en un repositorio git')
  if (isFile(join(top, '.claude-plugin', 'plugin.json'))) {
    throw new CliError(
      'ERROR: scripts/metrics-report.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Mefisto tiene su propio reporte interno: src/internal/scripts/mefisto-metrics-report.mts',
    )
  }
  // Los pipelines escriben el historial en el repo principal, tambien cuando corren en un worktree.
  const mainTop = mainRepoTop(top)

  const flags = parseDateFlags(argv, ['--desde', '--hasta'], '--desde YYYY-MM-DD --hasta YYYY-MM-DD')
  if (flags === null) {
    outLines(deps, HELP)
    return 0
  }
  const [desde, hasta] = [flags['--desde'] ?? '', flags['--hasta'] ?? '']
  if (desde !== '' && hasta !== '' && desde > hasta) {
    throw new CliError(`ERROR: --desde (${desde}) es posterior a --hasta (${hasta})`)
  }

  const sources = stateReadPaths('pipeline-history.jsonl', mainTop)
  const label = sources.length === 0 ? 'ningun historial existente' : sources.join(' ')
  const agg = computeMetricsReport(readHistory(sources), desde, hasta)
  if (agg === null) throw new CliError(`ERROR: no se pudo procesar el historial (${label})`)

  renderOverallHeader(deps, agg)
  if (resolve(mainTop) !== resolve(top)) {
    deps.out('')
    deps.out('Nota: estas parado en un worktree; el historial se leyo del repo principal')
    deps.out(`      (${label}), que es donde lo escriben los pipelines.`)
  }
  if (path(agg, 'meta', 'total') === 0) {
    deps.out('')
    deps.out('(sin corridas registradas en la ventana solicitada)')
    return 0
  }

  const pipelines = get(agg, 'pipelines')
  for (const name of sectionNames(pipelines)) {
    const section = get(pipelines, name)
    renderPipelineHeader(deps, section, name)
    if (path(section, 'meta', 'total') === 0) {
      deps.out('(sin corridas de este pipeline en la ventana)')
      continue
    }
    renderToolRanking(deps, section, RULE_MINOR)
    renderWallclock(deps, section)
    renderPeriodTable(deps, path(section, 'series', 'weekly'), 'DERIVA TEMPORAL - SEMANAL', RULE_MINOR)
    renderPeriodTable(deps, path(section, 'series', 'monthly'), 'DERIVA TEMPORAL - MENSUAL', RULE_MINOR)
    renderComparison(deps, section)
    renderByVersion(deps, section)
    renderLegacy(deps, section)
  }
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
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
