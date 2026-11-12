// Decisiones del pipeline TDD que no lanzan procesos: perfil de cada agente, rama read-side,
// senales del test-writer, gates de fase roja, verde y refactor, deteccion del Stage 2b y las
// etapas que entran a la tabla de metricas y al historial.

import { readFileSync } from 'node:fs'

import type { AgentStage, RunStage } from './run-history.mts'

/** Perfil neutral de cada agente del pipeline, o `null` si el agente no esta en la tabla. */
export function tddAgentProfile(agent: string): string | null {
  switch (agent) {
    case 'test-writer':
    case 'projection-test-writer':
    case 'implementer':
    case 'projection-implementer':
    case 'smoke-test-writer':
    case 'domain-scaffolder':
      return 'balanced'
    case 'reviewer':
      return 'deep'
    default:
      return null
  }
}

export interface StageAgents {
  isProjection: boolean
  stage1Agent: string
  stage2Agent: string
  stage1Label: string
  stage2Label: string
}

export const WRITE_SIDE: StageAgents = {
  isProjection: false,
  stage1Agent: 'test-writer',
  stage2Agent: 'implementer',
  stage1Label: 'Test Writer',
  stage2Label: 'Implementer',
}

export const READ_SIDE: StageAgents = {
  isProjection: true,
  stage1Agent: 'projection-test-writer',
  stage2Agent: 'projection-implementer',
  stage1Label: 'Projection Test Writer',
  stage2Label: 'Projection Implementer',
}

/** Nombres de los labels del JSON de `gh issue view`; vacio si el JSON no trae una lista legible. */
export function issueLabelNames(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const labels = (parsed as Record<string, unknown>).labels
  if (labels === undefined || labels === null || labels === false || labels === 0 || labels === '') return []
  if (!Array.isArray(labels)) return []
  const names: string[] = []
  for (const label of labels) {
    if (typeof label !== 'object' || label === null || Array.isArray(label) || !Object.hasOwn(label, 'name')) return []
    const name = (label as Record<string, unknown>).name
    if (typeof name !== 'string') return []
    names.push(name)
  }
  return names
}

/** La rama read-side solo la activa el label `tipo:projection` exacto, nunca un prefijo. */
export function stageAgentsFor(labels: readonly string[]): StageAgents {
  const lines = labels.flatMap((label) => label.split('\n'))
  return lines.includes('tipo:projection') ? READ_SIDE : WRITE_SIDE
}

/** Contenido de un archivo, o `null` si no se puede leer. */
export function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Valor de `<key>=` en una senal de `pipeline-state/`: lo que sigue al primer `=` de cada linea
 * que empieza asi, unidas por salto; `fallback` si no hay ninguna o el archivo no se lee.
 */
export function signalField(content: string | null, key: string, fallback: string): string {
  if (content === null) return fallback
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const values = lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1))
  return values.length > 0 ? values.join('\n') : fallback
}

export type RemovedTests = { value: number } | { invalid: string }

/** `REMOVED_TESTS` de la senal de refactor: 0 si falta; un valor que no es entero se informa. */
export function removedTests(content: string | null): RemovedTests {
  const raw = signalField(content, 'REMOVED_TESTS', '0')
  return /^[0-9]+$/.test(raw) ? { value: Number(raw) } : { invalid: raw }
}

const REFACTOR_EVIDENCE = /refactor[^\n]*pur|REFACTOR_ONLY|refactor-signal|refactoring puro/i

export type Stage1Output = 'refactor' | 'tests' | 'abort-signal-missing' | 'abort-nothing'

/**
 * Lo que dejo el Stage 1: senal de refactor, tests, o nada. Sin cambios, el log del stage dice si
 * el agente concluyo refactor puro pero no pudo escribir la senal.
 */
export function stage1Output(isRefactor: boolean, hasChanges: boolean, stageLog: string | null): Stage1Output {
  if (isRefactor) return 'refactor'
  if (hasChanges) return 'tests'
  if (stageLog !== null && stageLog.split('\n').some((line) => REFACTOR_EVIDENCE.test(line))) return 'abort-signal-missing'
  return 'abort-nothing'
}

export type RedGate = 'red-confirmed' | 'continue-no-red' | 'abort-all-green' | 'abort-no-tests'

/**
 * Gate 1b sobre el codigo de `dotnet test` (Microsoft Testing Platform: 0 pasan, 2 fallan, 8 no
 * hay tests). La senal no-red solo vale cuando todo pasa; sin tests siempre aborta.
 */
export function redGate(exitCode: number, noRedSignal: boolean): RedGate {
  if (exitCode === 0) return noRedSignal ? 'continue-no-red' : 'abort-all-green'
  if (exitCode === 8) return 'abort-no-tests'
  return 'red-confirmed'
}

export const ISSUE_INCOMPLETE_HEADING = '## Issue incompleto'

export type GreenGate = 'passed' | 'stop-blocked' | 'continue-blocked' | 'check-preexisting'

/**
 * Gate 2 con tests en rojo: el encabezado canonico del reporte (linea exacta) detiene el pipeline
 * como `blocked`, aunque el reporte traiga tambien tests bloqueados; cualquier otro reporte sigue
 * al reviewer. Sin reporte, decide el analisis de rojos preexistentes.
 */
export function greenGate(exitCode: number, report: string | null): GreenGate {
  if (exitCode === 0) return 'passed'
  if (report === null) return 'check-preexisting'
  return report.split('\n').includes(ISSUE_INCOMPLETE_HEADING) ? 'stop-blocked' : 'continue-blocked'
}

export type TestLoss = 'ok' | 'abort' | 'not-comparable'

/** Un refactor puede perder exactamente los tests que declaro la senal, ni uno mas. */
export function testLossGate(baseline: number | null, post: number | null, removed: number): TestLoss {
  if (baseline === null || post === null) return 'not-comparable'
  return post < baseline - removed ? 'abort' : 'ok'
}

// --- Stage 2b --------------------------------------------------------------------

/** Tool de un servidor MCP; el prefijo entra como expresion, igual que en el pipeline bash. */
export function mcpToolPattern(namespacePrefix: string): RegExp {
  return new RegExp(`^src/${namespacePrefix}\\.Mcp\\.[^/]+/.*Tool\\.cs$`)
}

const FUNCTION_FOLDER = /^src\/.*Function\//
const QUERY_ENDPOINT = /^src\/.*\/(Obtener|Listar)[A-Za-z0-9]*\/FunctionEndpoint\.cs$/

/**
 * Rutas del diff que piden smoke tests: Functions de comando, tools MCP y, en la rama read-side,
 * los endpoints GET de query. Todas ancladas a `src/`.
 */
export function smokeFiles(changed: readonly string[], namespacePrefix: string, isProjection: boolean): string[] {
  const mcp = mcpToolPattern(namespacePrefix)
  return changed.filter(
    (path) => FUNCTION_FOLDER.test(path) || mcp.test(path) || (isProjection && QUERY_ENDPOINT.test(path)),
  )
}

export interface SmokeTarget {
  /** Primera ruta detectada: decide dominio y tipo. */
  first: string
  domain: string
  /** `tests/<prefijo>.<dominio>.SmokeTests`. */
  project: string
  isMcp: boolean
  /** La ruta no tiene la forma `src/<prefijo>.<Dominio>/...` y no se pudo derivar el dominio. */
  anomaly: boolean
}

export function smokeTarget(files: readonly string[], namespacePrefix: string): SmokeTarget {
  const first = files[0] ?? ''
  const domain = first.replace(new RegExp(`src/${namespacePrefix}\\.([^/]*)/.*`), '$1')
  return {
    first,
    domain,
    project: `tests/${namespacePrefix}.${domain}.SmokeTests`,
    isMcp: mcpToolPattern(namespacePrefix).test(first),
    anomaly: domain === first || domain.includes('/'),
  }
}

const SMOKE_PROJECT = /^(tests\/[^/]*\.SmokeTests)\/.*/

/** Proyectos `tests/*.SmokeTests` que aparecen en `paths`, sin repetir y en orden de bytes. */
export function touchedSmokeProjects(paths: readonly string[]): string[] {
  const projects = new Set<string>()
  for (const path of paths) {
    const project = SMOKE_PROJECT.exec(path)?.[1]
    if (project !== undefined) projects.add(project)
  }
  return [...projects].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

// --- Metricas de la corrida ------------------------------------------------------

/** Lo que una etapa dejo en la corrida: `duration` nula si no corrio, `metrics` vacio si no tiene. */
export interface StageRecord {
  duration: number | null
  metrics: string
}

export interface RunStages {
  scaffold: StageRecord
  stage1: StageRecord
  stage2: StageRecord
  smoke: StageRecord
  reviewer: StageRecord
  patchStage1: StageRecord
  patchStage2: StageRecord
  coverageSeconds: number | null
}

export interface RunMetricsComposition {
  table: RunStage[]
  history: AgentStage[]
  /** El coverage gate corrio: el historial le agrega su forma propia. */
  coverageGate: boolean
}

/**
 * Etapas efectivamente corridas, en el orden del PR; la misma lista alimenta el historial. Una
 * etapa sin duracion no entra: seria una fila falsa. El coverage gate es una etapa del pipeline y
 * no un agente (MEF-ADR-0014): su fila no tiene metricas.
 */
export function runMetricsStages(stages: RunStages, agents: StageAgents): RunMetricsComposition {
  const composition: RunMetricsComposition = { table: [], history: [], coverageGate: false }
  const add = (label: string, record: StageRecord, key: string, agent: string): void => {
    if (record.duration === null) return
    composition.table.push({ label, duration: record.duration, metrics: record.metrics })
    composition.history.push({ key, agent, duration: String(record.duration), metrics: record.metrics })
  }
  add('Scaffolder', stages.scaffold, 'scaffolder', 'domain-scaffolder')
  add(agents.stage1Label, stages.stage1, 'test-writer', agents.stage1Agent)
  add(agents.stage2Label, stages.stage2, 'implementer', agents.stage2Agent)
  add('Smoke Test Writer', stages.smoke, 'smoke-test-writer', 'smoke-test-writer')
  add('Reviewer', stages.reviewer, 'reviewer', 'reviewer')
  add(`Remediacion: ${agents.stage1Label}`, stages.patchStage1, 'patch-test-writer', agents.stage1Agent)
  add(`Remediacion: ${agents.stage2Label}`, stages.patchStage2, 'patch-implementer', agents.stage2Agent)
  if (stages.coverageSeconds !== null) {
    composition.table.push({ label: 'coverage-gate', duration: stages.coverageSeconds, metrics: 'null' })
    composition.coverageGate = true
  }
  return composition
}

/**
 * Etapas que registra el historial de un aborto: las tres centrales siempre, aunque no hayan
 * corrido, y las demas solo si alcanzaron a dejar metricas.
 */
export function abortHistoryStages(stages: RunStages, agents: StageAgents): AgentStage[] {
  const entry = (key: string, agent: string, record: StageRecord): AgentStage => ({
    key,
    agent,
    duration: record.duration === null ? '' : String(record.duration),
    metrics: record.metrics,
  })
  const list = [
    entry('test-writer', agents.stage1Agent, stages.stage1),
    entry('implementer', agents.stage2Agent, stages.stage2),
    entry('reviewer', 'reviewer', stages.reviewer),
  ]
  if (stages.scaffold.metrics.length > 0) list.push(entry('scaffolder', 'domain-scaffolder', stages.scaffold))
  if (stages.smoke.metrics.length > 0) list.push(entry('smoke-test-writer', 'smoke-test-writer', stages.smoke))
  if (stages.patchStage1.metrics.length > 0) list.push(entry('patch-test-writer', agents.stage1Agent, stages.patchStage1))
  if (stages.patchStage2.metrics.length > 0) list.push(entry('patch-implementer', agents.stage2Agent, stages.patchStage2))
  return list
}
