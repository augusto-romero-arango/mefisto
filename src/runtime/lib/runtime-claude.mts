// Adaptador de runtime Claude Code (MEF-ADR-0049): compone la invocacion `claude -p` y traduce
// su stream-json al JSONL neutral de `contract/run-events.schema.json`. Es el unico modulo que
// nombra el CLI y sus flags.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { JqError, alt, get, isObject, path, slice, toText, typeOf } from '../../../scripts/lib/jq-values.mts'
import type { Json, JsonObject } from '../../../scripts/lib/jq-values.mts'
import type { BuildCommandInput, RuntimeCommand, TranslateInput } from './mefisto-runtime.mts'

const DEFAULT_MODELS: Readonly<Record<string, string>> = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }
const DEFAULT_EFFORTS: Readonly<Record<string, string>> = {
  quick: 'low',
  light: 'medium',
  standard: 'high',
  thorough: 'xhigh',
  exhaustive: 'max',
}

export function isAvailable(_env: NodeJS.ProcessEnv, hasCommand: (command: string) => boolean): boolean {
  return hasCommand('claude')
}

export function defaultModel(profile: string): string | null {
  return Object.hasOwn(DEFAULT_MODELS, profile) ? (DEFAULT_MODELS[profile] ?? null) : null
}

export function defaultEffort(level: string): string | null {
  return Object.hasOwn(DEFAULT_EFFORTS, level) ? (DEFAULT_EFFORTS[level] ?? null) : null
}

export function supportsResume(): boolean {
  return true
}

/** Una sesion interactiva recarga sus plugins con este comando de barra. */
export function interactiveRefresh(): string {
  return 'prompt /reload-plugins'
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * El prompt nunca va en el argv, que tiene limite de tamano: viaja por la entrada estandar. El
 * effort va por variable de entorno porque es lo unico que gana al `effort` del frontmatter del
 * agente.
 */
export function buildCmd(input: BuildCommandInput): RuntimeCommand {
  const argv = [
    'claude',
    '-p',
    '--agent',
    input.agent,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
  if (input.model.length > 0) argv.push('--model', input.model)
  if (input.resumeSessionId.length > 0) argv.push('--resume', input.resumeSessionId)
  if (input.systemFile.length > 0) argv.push('--append-system-prompt-file', input.systemFile)
  // El agente carga el plugin de la release que corre el pipeline, no la instalada (MEF-ADR-0053).
  const packageRoot = input.env.MEFISTO_AGENT_PACKAGE_ROOT ?? ''
  if (packageRoot.length > 0 && isFile(join(packageRoot, '.claude-plugin', 'plugin.json'))) {
    argv.push('--plugin-dir', packageRoot)
  }
  const command: RuntimeCommand = { argv, stdinFile: input.promptFile }
  if (input.effort.length > 0) command.env = { CLAUDE_CODE_EFFORT_LEVEL: input.effort }
  return command
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.([0-9]+))?Z$/

/** Milisegundos de epoch de un instante ISO 8601 en UTC, o `null` si no tiene esa forma. */
function parseTimestamp(value: Json): number | null {
  if (typeof value !== 'string') return null
  const match = TIMESTAMP.exec(value)
  if (match === null) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    throw new JqError(`date "${value}" does not match format`)
  }
  const fraction = match[7] === undefined ? 0 : Number(`${match[7]}000`.slice(0, 3))
  return Date.UTC(year, month - 1, day, hour, minute, second) + fraction
}

function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** `.[]?` */
function elements(value: Json): Json[] {
  if (Array.isArray(value)) return value
  return isObject(value) ? Object.values(value) : []
}

const clip = (value: Json): string => slice(toText(value), 0, 300) as string

function inputSummary(name: Json, input: Json): Json {
  if (name === 'Edit' || name === 'Write' || name === 'Read') return alt(get(input, 'file_path'), null)
  if (name !== 'Bash') return null
  const command = alt(get(input, 'command'), null)
  return command === null ? null : slice(toText(command), 0, 80)
}

function firstMatching(lines: string[], needle: string): string | null {
  return lines.find((line) => line.includes(needle)) ?? null
}

interface Verdict {
  status: 'success' | 'failed'
  kind: string | null
  detail: string | null
}

function failed(kind: string, detail: string): Verdict {
  return { status: 'failed', kind, detail }
}

interface Evidence {
  result: Json
  exit: number | null
  truncated: boolean
  stderrLines: string[]
  rateLimit: Json
  resetsAt: string | null
}

// El orden es el contrato: exito declarado, senal, limite de uso, error de API del `result`,
// error de API del stderr (5xx antes que 4xx), corte de stream, sin resultado y, al final,
// salida distinta de cero. El timeout no aparece: lo decide el runner.
function classify(evidence: Evidence): Verdict {
  const { result, exit } = evidence
  const signaled = exit === 137 || exit === 143
  const nonzero = exit !== null && exit !== 0
  const declaredSuccess =
    result !== null &&
    get(result, 'is_error') === false &&
    get(result, 'subtype') === 'success' &&
    get(result, 'stop_reason') === 'end_turn'

  if (declaredSuccess) {
    // Una muerte posterior a declarar exito queda anotada sin degradar el status.
    if (signaled) {
      return { status: 'success', kind: 'killed', detail: `el CLI declaro exito y murio despues por senal (exit ${exit})` }
    }
    if (nonzero) {
      return { status: 'success', kind: 'nonzero_exit', detail: `el CLI declaro exito y termino despues con exit ${exit}` }
    }
    return { status: 'success', kind: null, detail: null }
  }
  if (signaled) return failed('killed', `el proceso murio por senal (exit ${exit}) sin declarar exito`)
  if (evidence.rateLimit !== null) {
    const type = alt(path(evidence.rateLimit, 'rate_limit_info', 'rateLimitType'), '?')
    if (typeof type !== 'string') throw new JqError('string and non-string cannot be added')
    return failed('rate_limit', `ventana de uso agotada (rateLimitType=${type}, resetsAt=${evidence.resetsAt ?? '?'})`)
  }
  if (result !== null && get(result, 'is_error') === true) {
    const status = alt(get(result, 'api_error_status'), null)
    const reason = [get(result, 'result'), get(result, 'error'), get(result, 'terminal_reason'), get(result, 'subtype')]
      .reduce<Json>((found, candidate) => alt(found, candidate), null)
    const detail = clip((status === null ? '' : `API Error: ${toText(status)} `) + toText(alt(reason, 'error')))
    const unavailable = status !== null && toText(status).startsWith('5')
    return failed(unavailable ? 'provider_unavailable' : 'api_error', detail)
  }
  const api5xx = firstMatching(evidence.stderrLines, 'API Error: 5')
  if (api5xx !== null) return failed('provider_unavailable', clip(api5xx))
  const api4xx = firstMatching(evidence.stderrLines, 'API Error: 4')
  if (api4xx !== null) return failed('api_error', clip(api4xx))
  if (result === null) {
    if (evidence.truncated) return failed('stream_cut', 'el stream de Claude se corto a mitad de escritura')
    const cut = firstMatching(evidence.stderrLines, 'Connection closed mid-response')
    if (cut !== null) return failed('stream_cut', clip(cut))
    return failed('no_result', `el stream de Claude termino sin un evento result${exit === null ? '' : ` (exit ${exit})`}`)
  }
  return failed(
    'nonzero_exit',
    `stop_reason=${toText(alt(get(result, 'stop_reason'), '?'))} subtype=${toText(alt(get(result, 'subtype'), '?'))}` +
      (exit === null ? '' : ` exit=${exit}`),
  )
}

function parseLine(line: string): Json {
  try {
    return JSON.parse(line) as Json
  } catch {
    return null
  }
}

/**
 * Eventos neutrales de la traza cruda de Claude Code, con su terminal al final. `exitCode` y
 * `stderrText` completan la clasificacion: una muerte por senal y el `API Error` que el CLI solo
 * escribe por stderr no se deducen del stream.
 */
export function translateStream(
  raw: string,
  runtime: string,
  model: string,
  exitCode: number | null,
  stderrText: string,
  now: Date = new Date(),
): JsonObject[] {
  const fallbackTs = isoSeconds(now.getTime())
  const parsed = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseLine)
  const events = parsed.filter(isObject)
  const truncated = parsed.length > 0 && parsed[parsed.length - 1] === null
  const ofType = (type: string): JsonObject[] => events.filter((event) => get(event, 'type') === type)

  // El ultimo rechazado: antes pueden venir avisos con status "allowed".
  const rateLimit =
    ofType('rate_limit_event').findLast(
      (event) => alt(path(event, 'rate_limit_info', 'status'), 'allowed') !== 'allowed',
    ) ?? null
  const resetsEpoch = rateLimit === null ? null : path(rateLimit, 'rate_limit_info', 'resetsAt')
  const resetsAt = typeof resetsEpoch === 'number' ? isoSeconds(Math.floor(resetsEpoch) * 1000) : null

  const init = events.find((event) => get(event, 'type') === 'system' && get(event, 'subtype') === 'init') ?? null
  const firstAssistant = ofType('assistant')[0] ?? null
  const resolvedModel = alt(
    alt(get(init, 'model'), path(firstAssistant, 'message', 'model')),
    model.length > 0 ? model : null,
  )

  const toolById = new Map<string, { name: Json; startMs: number | null }>()
  for (const event of ofType('assistant')) {
    for (const block of elements(alt(path(event, 'message', 'content'), []))) {
      if (get(block, 'type') !== 'tool_use') continue
      const id = alt(get(block, 'id'), '')
      if (typeof id !== 'string') throw new JqError('Object keys must be strings')
      toolById.set(id, { name: alt(get(block, 'name'), '?'), startMs: parseTimestamp(get(event, 'timestamp')) })
    }
  }

  const out: JsonObject[] = []
  for (const event of events) {
    const type = get(event, 'type')
    if (type !== 'assistant' && type !== 'user') continue
    const ts = alt(get(event, 'timestamp'), fallbackTs)
    for (const block of elements(alt(path(event, 'message', 'content'), []))) {
      const kind = get(block, 'type')
      if (type === 'assistant' && kind === 'text') {
        out.push({ v: 1, type: 'message', ts, role: 'assistant', text: alt(get(block, 'text'), '') })
      } else if (type === 'assistant' && kind === 'tool_use') {
        const name = alt(get(block, 'name'), '?')
        out.push({
          v: 1,
          type: 'tool.started',
          ts,
          tool: name,
          input_summary: inputSummary(name, alt(get(block, 'input'), {})),
        })
      } else if (type === 'user' && kind === 'tool_result') {
        const id = alt(get(block, 'tool_use_id'), '')
        if (typeof id !== 'string') throw new JqError(`Cannot index object with ${typeOf(id)}`)
        const started = toolById.get(id)
        const startMs = started?.startMs ?? null
        const endMs = parseTimestamp(get(event, 'timestamp'))
        out.push({
          v: 1,
          type: 'tool.completed',
          ts,
          tool: alt(started?.name ?? null, '?'),
          ok: get(block, 'is_error') !== true,
          duration_ms: startMs !== null && endMs !== null ? endMs - startMs : null,
        })
      }
    }
  }

  const result = ofType('result').at(-1) ?? null
  const verdict = classify({ result, exit: exitCode, truncated, stderrLines: stderrText.split('\n'), rateLimit, resetsAt })
  const denials = alt(get(result, 'permission_denials'), null)
  out.push({
    v: 1,
    type: verdict.status === 'success' ? 'run.completed' : 'run.failed',
    ts: alt(get(result, 'timestamp'), fallbackTs),
    status: verdict.status,
    runtime,
    model: resolvedModel,
    session_id: alt(get(init, 'session_id'), null),
    // Lo fija el runner, que es quien mide el reloj de pared de la corrida entera.
    duration_ms: null,
    tokens: {
      input: alt(path(result, 'usage', 'input_tokens'), null),
      output: alt(path(result, 'usage', 'output_tokens'), null),
      cache_read: alt(path(result, 'usage', 'cache_read_input_tokens'), null),
      cache_write: alt(path(result, 'usage', 'cache_creation_input_tokens'), null),
      reasoning: null,
    },
    estimated_cost_usd: alt(get(result, 'total_cost_usd'), null),
    turns: alt(get(result, 'num_turns'), null),
    denials: Array.isArray(denials) ? denials.length : null,
    ttft_ms: alt(get(result, 'ttft_ms'), null),
    api_duration_ms: alt(get(result, 'duration_api_ms'), null),
    error: verdict.kind === null ? null : { kind: verdict.kind, detail: verdict.detail },
    resets_at: verdict.kind === 'rate_limit' ? resetsAt : null,
  })
  return out
}

function readText(file: string): string | null {
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

export function translate(input: TranslateInput): Json[] {
  const raw = readText(input.rawFile)
  if (raw === null) return []
  const stderrText = input.stderrFile.length > 0 ? (readText(input.stderrFile) ?? '') : ''
  try {
    return translateStream(raw, input.runtime, input.model, input.exitCode, stderrText)
  } catch (error) {
    // Una traza con una forma inesperada no produce eventos, como cuando falla el filtro de jq.
    if (error instanceof JqError) return []
    throw error
  }
}
