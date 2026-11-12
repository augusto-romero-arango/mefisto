// Lo que el pipeline interno de tooling deja escrito de una corrida: el status
// (`pipeline-status-mefisto-tooling-*.json`), las entradas de `pipeline-history.jsonl` y la
// lectura del issue. Los mods, los lanzadores y el batch leen esos archivos con este formato.

import { jsonText } from '../../../../scripts/lib/pipeline/pipeline-status.mts'
import { buildAgentsHistoryJson } from './mefisto-run-history.mts'

/** Rutas cuyo cambio sin commitear cuenta como trabajo del writer. */
export const WRITER_CHANGE_PATHS: readonly string[] = [
  'commands/',
  'agents/',
  'scripts/',
  'hooks/',
  'docs/',
  '.claude-plugin/',
  '.claude/commands/',
  '.claude/agents/',
  '.claude/scripts/',
  '.claude/settings.json',
  'changelog.d/',
  'src/internal/',
  'src/published/',
  'src/runtime/',
  'dist/',
  'AGENTS.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  '.gitignore',
  '.gitattributes',
  'LICENSE',
  'NOTICE',
]

/**
 * Rutas que el commit de seguridad agrega una por una. `changelog.d/` va porque el fragmento es
 * lo unico que acredita un cambio notable, y `.claude/settings.json` porque el pipeline ya no lo
 * inyecta: lo que aparezca ahi es una edicion legitima del agente.
 */
export const AUTO_COMMIT_PATHS: readonly string[] = [
  'commands/',
  'agents/',
  'scripts/',
  'hooks/',
  'docs/',
  '.claude-plugin/',
  '.claude/commands/',
  '.claude/agents/',
  '.claude/scripts/',
  '.claude/mods/',
  '.claude/settings.json',
  'changelog.d/',
  'src/internal/',
  'src/published/',
  'src/runtime/',
  'dist/',
  'AGENTS.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  '.gitignore',
  '.gitattributes',
  'LICENSE',
  'NOTICE',
]

/**
 * Texto del error que guardan el status y el historial: los saltos vueltos espacios, con el
 * espacio final del salto que cerraba el mensaje.
 */
export function abortErrorText(message: string): string {
  return `${message.replaceAll('\n', ' ')} `
}

/** Literal JSON de un valor opcional: la cadena codificada, o `null` si esta vacia. */
export function optionalJson(value: string): string {
  return value.length > 0 ? jsonText(value) : 'null'
}

export interface AgentTrack {
  /** Segundos del stage en texto; vacio mientras no se conocen. */
  duration: string
  result: string
  /** JSON de las metricas del stage; vacio si no se cosecharon. */
  metrics: string
}

export interface StatusInput {
  issue: string
  title: string
  variant: string
  runtime: string
  started: string
  stage: string
  state: string
  updated: string
  worktree: string
  log: string
  writer: AgentTrack
  reviewer: AgentTrack
  pr: string
  /** Error ya pasado por `abortErrorText`, o vacio. */
  error: string
}

/** Texto del status de la corrida. */
export function renderToolingStatus(input: StatusInput): string {
  const duration = (track: AgentTrack): string => (track.duration.length > 0 ? track.duration : 'null')
  return `{
  "issue": ${jsonText(input.issue.length > 0 ? input.issue : 'null')},
  "title": ${jsonText(input.title)},
  "pipeline": "mefisto-tooling",
  "variant": ${optionalJson(input.variant)},
  "runtime": ${optionalJson(input.runtime)},
  "started": ${jsonText(input.started)},
  "stage": ${jsonText(input.stage)},
  "state": ${jsonText(input.state)},
  "updated": ${jsonText(input.updated)},
  "worktree": ${jsonText(input.worktree)},
  "log": ${jsonText(input.log)},
  "agents": {
    "writer":   {"duration": ${duration(input.writer)}, "result": ${jsonText(input.writer.result)}},
    "reviewer": {"duration": ${duration(input.reviewer)}, "result": ${jsonText(input.reviewer.result)}}
  },
  "pr": ${optionalJson(input.pr)},
  "last_error": ${optionalJson(input.error)}
}
`
}

export interface HistoryInput {
  issue: string
  title: string
  variant: string
  runtime: string
  harnessVersion: string
  harnessSha: string
  started: string
  finished: string
  writer: AgentTrack
  reviewer: AgentTrack
}

function historyHead(input: HistoryInput): string {
  return `{"issue":${jsonText(input.issue)},"title":${jsonText(input.title)},"pipeline":"mefisto-tooling","variant":${optionalJson(input.variant)},"runtime":${optionalJson(input.runtime)},"harness_version":${optionalJson(input.harnessVersion)},"harness_sha":${optionalJson(input.harnessSha)},"started":${jsonText(input.started)},"finished":${jsonText(input.finished)}`
}

function agentsJson(input: HistoryInput): string {
  return buildAgentsHistoryJson(input.writer, input.reviewer)
}

/** Entrada de historial de una corrida completada, con su salto final. */
export function completedHistoryLine(input: HistoryInput & { pr: string }): string {
  return `${historyHead(input)},"state":"completed","agents":${agentsJson(input)},"pr":${optionalJson(input.pr)}}\n`
}

/** Entrada de historial de una corrida abortada en `stage`, con su salto final. */
export function failedHistoryLine(input: HistoryInput & { stage: string; error: string }): string {
  return `${historyHead(input)},"state":"failed","stage":${jsonText(input.stage)},"agents":${agentsJson(input)},"error":${jsonText(input.error)}}\n`
}

export interface ToolingIssue {
  /** `state` del issue, o `UNKNOWN` si la respuesta no es el JSON esperado. */
  state: string
  /** `null` si no se pudo leer ni del JSON ni del texto crudo. */
  title: string | null
  body: string
  /** `true` con el label `cierre:manual`: el PR no cierra el issue. */
  manualClose: boolean
}

// El bash imprimia estos campos con `print()` de Python.
function pythonText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return JSON.stringify(value)
}

const chomp = (text: string): string => text.replace(/\n+$/, '')

/** Lee lo que imprime `gh issue view --json number,title,body,state,labels`. */
export function parseToolingIssue(raw: string): ToolingIssue {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const issue = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  const field = (name: string): unknown => (issue !== null && Object.hasOwn(issue, name) ? issue[name] : undefined)

  const state = field('state')
  const title = field('title')
  const body = field('body')
  const rawTitles = [...raw.matchAll(/"title":"[^"\n]*"/g)].map((match) => match[0].slice('"title":"'.length, -1))
  const rawBody = chomp(
    raw
      .split('\n')
      .map((line) => line.replace(/.*"body":"/, '').replace(/","[^"]*":".*/, '').replaceAll('\\n', '\n').replaceAll('\\r', ''))
      .join('\n'),
  )
  const labels = field('labels')
  return {
    state: state === undefined ? 'UNKNOWN' : chomp(pythonText(state)),
    title: title !== undefined ? chomp(pythonText(title)) : rawTitles.length > 0 ? rawTitles.join('\n') : null,
    body: body !== undefined ? chomp(pythonText(body)) : rawBody,
    manualClose:
      Array.isArray(labels) &&
      labels.some((label) => typeof label === 'object' && label !== null && (label as Record<string, unknown>).name === 'cierre:manual'),
  }
}
