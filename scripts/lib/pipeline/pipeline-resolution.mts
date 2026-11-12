// Que pipeline corre un issue segun sus labels o un override, y si un issue pendiente de un lote
// paralelo puede lanzarse ya.

import { join } from 'node:path'

import { parseJson } from '../azure-cli.mts'
import type { Run } from '../azure-cli.mts'
import { capture, CliError } from '../cli.mts'
import type { CommandResult } from '../cli.mts'
import { pipelineScriptsDir } from './harness-identity.mts'

export type PipelineName = 'tdd' | 'tooling'
export type SkipReason = 'infra' | 'no-tipo'

/** `script` es la ruta absoluta del pipeline dentro del plugin. */
export type Resolution =
  | { kind: 'pipeline'; pipeline: PipelineName; script: string }
  | { kind: 'skip'; reason: SkipReason }

export interface ResolveOptions {
  run?: Run
  scriptsDir?: string
}

export interface IssueResolution {
  /** Estado del issue en GitHub, o `UNKNOWN` si no se pudo consultar. */
  state: string
  resolution: Resolution
}

export interface IssueFacts extends IssueResolution {
  isProjection: boolean
}

/** La resolucion como texto: la ruta del pipeline o el centinela `SKIP:<motivo>`. */
export function resolutionText(resolution: Resolution): string {
  return resolution.kind === 'pipeline' ? resolution.script : `SKIP:${resolution.reason}`
}

function pipelineAt(pipeline: PipelineName, scriptsDir: string): Resolution {
  return { kind: 'pipeline', pipeline, script: join(scriptsDir, `${pipeline}-pipeline.mts`) }
}

function forcedPipeline(override: string, scriptsDir: string): Resolution {
  if (override === 'tdd' || override === 'tooling') return pipelineAt(override, scriptsDir)
  throw new CliError(`ERROR: override desconocido '${override}'`)
}

// Un label con salto de linea cuenta como varios: se compara linea a linea.
function labelLines(labels: readonly string[]): string[] {
  return labels.join('\n').split('\n')
}

/** `tipo:projection` enruta a TDD, que despacha por dentro la rama read-side. */
export function resolveFromLabels(labels: readonly string[], scriptsDir: string = pipelineScriptsDir()): Resolution {
  const lines = labelLines(labels)
  if (lines.some((label) => /^tipo:(feature|refactor|projection)$/.test(label))) return pipelineAt('tdd', scriptsDir)
  if (lines.includes('tipo:tooling')) return pipelineAt('tooling', scriptsDir)
  if (lines.includes('tipo:infra')) return { kind: 'skip', reason: 'infra' }
  return { kind: 'skip', reason: 'no-tipo' }
}

/** `true` solo con el label exacto, no con un prefijo como `tipo:projection-experimental`. */
export function isTipoProjectionFromLabels(labels: readonly string[]): boolean {
  return labelLines(labels).includes('tipo:projection')
}

function issueJson(result: CommandResult): Record<string, unknown> | null {
  if (result.status !== 0) return null
  const value = parseJson(result.stdout)?.value
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function labelNames(issue: Record<string, unknown> | null): string[] {
  const labels = issue !== null && Array.isArray(issue.labels) ? (issue.labels as unknown[]) : []
  return labels.map((label) => {
    const name = typeof label === 'object' && label !== null ? (label as Record<string, unknown>).name : null
    return typeof name === 'string' ? name : ''
  })
}

/** Con `override` no consulta GitHub; sin el, un `gh` que falla resuelve `SKIP:no-tipo`. */
export function resolvePipeline(issue: number | string, override = '', options: ResolveOptions = {}): Resolution {
  const scriptsDir = options.scriptsDir ?? pipelineScriptsDir()
  if (override.length > 0) return forcedPipeline(override, scriptsDir)
  const run = options.run ?? capture
  const found = issueJson(run('gh', ['issue', 'view', String(issue), '--json', 'labels']))
  return resolveFromLabels(labelNames(found), scriptsDir)
}

/**
 * Estado, flag de projection y pipeline de un issue con una sola consulta a GitHub. El override
 * se valida aunque `gh` falle, y uno valido se honra con el estado en `UNKNOWN`; `isProjection`
 * sale siempre de los labels, porque forzar el pipeline no cambia que archivos toca el issue.
 */
export function resolveIssueFacts(issue: number | string, override = '', options: ResolveOptions = {}): IssueFacts {
  const scriptsDir = options.scriptsDir ?? pipelineScriptsDir()
  const run = options.run ?? capture
  const found = issueJson(run('gh', ['issue', 'view', String(issue), '--json', 'state,labels']))
  const labels = labelNames(found)
  const state = found === null ? 'UNKNOWN' : found.state
  return {
    state: typeof state === 'string' ? state : JSON.stringify(state ?? null),
    isProjection: isTipoProjectionFromLabels(labels),
    resolution: override.length > 0 ? forcedPipeline(override, scriptsDir) : resolveFromLabels(labels, scriptsDir),
  }
}

export function resolvePipelineWithState(
  issue: number | string,
  override = '',
  options: ResolveOptions = {},
): IssueResolution {
  const { state, resolution } = resolveIssueFacts(issue, override, options)
  return { state, resolution }
}

/**
 * `maxParallel` 0 es sin limite. Dos issues `tipo:projection` nunca corren a la vez: comparten
 * los archivos del worker de proyecciones del Bounded Context (MEF-ADR-0034).
 */
export function canLaunchNow(
  maxParallel: number,
  running: number,
  isProjection: boolean,
  projectionRunning: boolean,
): boolean {
  if (maxParallel > 0 && running >= maxParallel) return false
  return !(isProjection && projectionRunning)
}
