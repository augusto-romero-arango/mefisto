// Modelo y effort de cada stage de un pipeline: el override `--models`, el modelo declarado en
// el frontmatter de un agente y el nivel de effort de fabrica de los agentes publicados.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { resolveEffort } from '../../../src/runtime/lib/mefisto-models.mts'
import { appendEventsLine, clockTime } from './agent-log.mts'

const AGENTS_DIR = join(import.meta.dirname, '..', '..', '..', 'agents')

const SPACE = '[ \\t\\n\\v\\f\\r]'
const MODEL_KEY = new RegExp(`^model:($|${SPACE})`)
const TRAILING_COMMENT = new RegExp(`${SPACE}#.*$`, 's')
const OUTER_SPACE = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')

/**
 * Valor de la primera clave `model:` del frontmatter de `<agentsDir>/<agent>.md`, sin comillas
 * ni comentario. Cadena vacia si el archivo, la clave o el valor faltan.
 */
export function resolveDeclaredAgentModel(agent: string, agentsDir: string = AGENTS_DIR): string {
  const file = join(agentsDir, `${agent}.md`)
  let text: string
  try {
    if (!statSync(file).isFile()) return ''
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  let inFrontmatter = false
  for (const line of text.split('\n')) {
    if (!inFrontmatter) {
      inFrontmatter = line === '---'
      continue
    }
    if (line === '---') break
    if (!MODEL_KEY.test(line)) continue
    const model = line
      .slice(line.indexOf(':') + 1)
      .replace(TRAILING_COMMENT, '')
      .replace(OUTER_SPACE, '')
    return model.length >= 2 && model.startsWith('"') && model.endsWith('"') ? model.slice(1, -1) : model
  }
  return ''
}

/**
 * Nivel neutral de effort de fabrica de cada agente publicado. Duplica a proposito el campo
 * `effort` de `src/published/agents/`: el consumidor recibe `dist/`, sin las fuentes.
 */
export const PIPELINE_AGENT_EFFORT_LEVELS: Readonly<Record<string, string>> = {
  'bug-investigator': 'thorough',
  planner: 'thorough',
  reviewer: 'thorough',
  'tooling-investigator': 'thorough',
  implementer: 'standard',
  'infra-reviewer': 'standard',
  'projection-implementer': 'standard',
  'tooling-reviewer': 'standard',
  'apim-gateway-scaffolder': 'light',
  'domain-scaffolder': 'light',
  historiador: 'light',
  'infra-base-scaffolder': 'light',
  'infra-bootstrap': 'light',
  'infra-writer': 'light',
  'mcp-scaffolder': 'light',
  'pr-sync': 'light',
  'projection-test-writer': 'light',
  'projections-scaffolder': 'light',
  'smoke-test-writer': 'light',
  'test-writer': 'light',
  'tooling-writer': 'light',
  'workos-identity-scaffolder': 'light',
}

/** Nivel de fabrica de `agentId`, o `null` si no esta en la tabla. */
export function pipelineAgentEffortLevel(agentId: string): string | null {
  return Object.hasOwn(PIPELINE_AGENT_EFFORT_LEVELS, agentId) ? (PIPELINE_AGENT_EFFORT_LEVELS[agentId] ?? null) : null
}

export interface PipelineEffortRequest {
  /** Clave del stage; solo nombra la linea de events.log. */
  key: string
  agentId: string
  runtime: string
  /** Mapping opcional del consumidor (`.mefisto/models.json`). */
  mappingFile?: string
  /** events.log donde queda la linea `EFFORTS:`; sin el no se anota. */
  eventsLog?: string
  env?: NodeJS.ProcessEnv
  libDir?: string
  now?: Date
}

/** `effort` es el nombre nativo del runtime; vacio significa heredar (no se pasa `--effort`). */
export type PipelineEffortResolution = { effort: string; level: string } | { error: string }

/**
 * Effort nativo de un stage: el nivel de fabrica del agente, traducido por el mapping del
 * consumidor y el adaptador del runtime. Anota `EFFORTS: <clave> -> <nativo> (nivel <fabrica>)`.
 */
export async function resolvePipelineAgentEffort(request: PipelineEffortRequest): Promise<PipelineEffortResolution> {
  const { key, agentId, runtime } = request
  const level = pipelineAgentEffortLevel(agentId)
  if (level === null) {
    return { error: `agente '${agentId}' sin nivel de effort de fabrica en pipeline_agent_effort_level` }
  }
  const resolved = await resolveEffort({
    runtime,
    agentId,
    level,
    mappingFile: request.mappingFile,
    env: request.env,
    libDir: request.libDir,
  })
  if ('error' in resolved) return resolved
  const eventsLog = request.eventsLog ?? ''
  if (eventsLog.length > 0) {
    const native = resolved.effort.length > 0 ? resolved.effort : '<heredado>'
    appendEventsLine(eventsLog, `[${clockTime(request.now ?? new Date())}] EFFORTS: ${key} -> ${native} (nivel ${level})`)
  }
  return { effort: resolved.effort, level }
}

/** Overrides de `--models`, por clave de stage y en el orden en que se pasaron. */
export type StageModels = ReadonlyMap<string, string>

export type StageModelsParse = { models: StageModels } | { error: string }

/**
 * Lee `agente=modelo[,agente=modelo...]`. Solo valida la forma y que ninguna clave se repita: el
 * nombre del modelo pasa tal cual. El motivo de `error` es una linea lista para abortar; el
 * llamador lo invoca antes de crear el worktree.
 */
export function parseStageModels(spec: string): StageModelsParse {
  const models = new Map<string, string>()
  // Solo cuenta la primera linea del spec.
  const [firstLine = ''] = spec.split('\n')
  for (const entry of firstLine.split(',')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator === -1) return { error: `entrada '${entry}' no tiene la forma agente=modelo` }
    const agent = entry.slice(0, separator)
    const model = entry.slice(separator + 1)
    if (agent.length === 0 || model.length === 0) {
      return { error: `entrada '${entry}': agente y modelo no pueden estar vacios` }
    }
    if (models.has(agent)) return { error: `el agente '${agent}' esta repetido` }
    models.set(agent, model)
  }
  return { models }
}

/** Override de `agent` (clave exacta), o `fallback` si no tiene. */
export function resolveStageModel(models: StageModels, agent: string, fallback: string): string {
  return models.get(agent) ?? fallback
}

/** `agente=modelo, agente=modelo`, para el log; cadena vacia sin overrides. */
export function formatStageModelsForLog(models: StageModels): string {
  return [...models].map(([agent, model]) => `${agent}=${model}`).join(', ')
}
