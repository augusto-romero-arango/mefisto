// Hooks interactivos publicados: un binding de src/published/hooks/interactive-hooks.json por invocacion.
//
// Uso: node scripts/interactive-hooks.mts <binding>   (el evento llega en JSON por stdin)
//
// Todo fallo se calla y termina en 0: el contrato de entrega es `failure: continue`.

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { isEntryPoint } from './lib/cli.mts'

export const REMINDER_TEXT =
  '[recordatorio] Si esta sesion tuvo descubrimientos de dominio, decisiones o alternativas descartadas, considera escribir field notes en docs/bitacora/field-notes/ antes de continuar.'

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const COMMIT = /^[0-9a-f]{40}$/
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/
const MANIFEST_KEYS = ['commit', 'runtime', 'schemaVersion', 'version']

type JsonObject = Record<string, unknown>

export interface HookContext {
  /** Raiz del repo consumidor. */
  root: string
  /** Raiz de la distribucion cargada (CLAUDE_PLUGIN_ROOT), o vacio. */
  pluginRoot: string
  /** Evento del hook ya parseado; `undefined` si stdin no traia JSON. */
  input: unknown
  now: Date
}

export interface ReleaseIdentity {
  version: string
  commit: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// Lee un JSONL completo; `null` si falta o si alguna linea no es JSON.
export function readJsonl(path: string): unknown[] | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const entries: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const entry = parseJson(line)
    if (entry === undefined) return null
    entries.push(entry)
  }
  return entries
}

export function consumerRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

export function releaseIdentity(pluginRoot: string): ReleaseIdentity | null {
  if (pluginRoot.length === 0) return null
  let manifest: unknown
  try {
    manifest = parseJson(readFileSync(join(pluginRoot, 'mefisto-manifest.json'), 'utf8'))
  } catch {
    return null
  }
  if (!isObject(manifest)) return null
  const keys = Object.keys(manifest).sort()
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, i) => key !== MANIFEST_KEYS[i])) {
    return null
  }
  const { version, commit } = manifest
  if (manifest.schemaVersion !== 1 || manifest.runtime !== 'claude') return null
  if (typeof version !== 'string' || !SEMVER.test(version)) return null
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null
  return { version, commit }
}

function utcTimestamp(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`
}

function utcClock(now: Date): string {
  return now.toISOString().slice(11, 19)
}

function pipelineDir(root: string): string {
  return join(root, '.mefisto', 'pipeline')
}

function appendLine(root: string, file: string, line: string): void {
  mkdirSync(pipelineDir(root), { recursive: true })
  appendFileSync(join(pipelineDir(root), file), `${line}\n`)
}

export function recordActiveRelease(context: HookContext): void {
  if (context.pluginRoot.length === 0) return
  const legacyDir = join(context.root, '.claude', 'pipeline')
  mkdirSync(pipelineDir(context.root), { recursive: true })
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(pipelineDir(context.root), '.plugin-root'), context.pluginRoot)
  writeFileSync(join(legacyDir, '.plugin-root'), context.pluginRoot)
  rmSync(join(legacyDir, '.plugin-root.previous'), { force: true })
}

export function appendSession(context: HookContext): void {
  const { input } = context
  if (!isObject(input)) return
  const identity = releaseIdentity(context.pluginRoot)
  const record = {
    record_type: 'session.started',
    session_id: input.session_id ?? null,
    transcript_path: input.transcript_path ?? null,
    cwd: input.cwd ?? null,
    source: input.source ?? null,
    timestamp: utcTimestamp(context.now),
    runtime: 'claude',
    model: nonEmptyString(input.model),
    harness_version: identity?.version ?? null,
    harness_commit: identity?.commit ?? null,
  }
  appendLine(context.root, 'sessions.jsonl', JSON.stringify(record))
}

export function lastAssistantModel(transcript: unknown[]): string | null {
  let model: string | null = null
  for (const entry of transcript) {
    if (!isObject(entry) || entry.type !== 'assistant' || !isObject(entry.message)) continue
    model = nonEmptyString(entry.message.model) ?? model
  }
  return model
}

export function lastObservedModel(sessionsPath: string, sessionId: string): string | null {
  let text: string
  try {
    text = readFileSync(sessionsPath, 'utf8')
  } catch {
    return null
  }
  let model: string | null = null
  for (const line of text.split('\n')) {
    const entry = parseJson(line)
    if (!isObject(entry)) continue
    if (entry.record_type !== 'session.model-observed' || entry.session_id !== sessionId) continue
    model = nonEmptyString(entry.model) ?? model
  }
  return model
}

export function appendSessionModel(context: HookContext): void {
  const { input } = context
  if (!isObject(input)) return
  const sessionId = nonEmptyString(input.session_id)
  const transcriptPath = nonEmptyString(input.transcript_path)
  if (sessionId === null || transcriptPath === null) return
  const transcript = readJsonl(transcriptPath)
  if (transcript === null) return
  const model = lastAssistantModel(transcript)
  if (model === null) return
  const sessionsPath = join(pipelineDir(context.root), 'sessions.jsonl')
  if (lastObservedModel(sessionsPath, sessionId) === model) return
  const identity = releaseIdentity(context.pluginRoot)
  const record = {
    record_type: 'session.model-observed',
    session_id: sessionId,
    timestamp: utcTimestamp(context.now),
    runtime: 'claude',
    model,
    harness_version: identity?.version ?? null,
    harness_commit: identity?.commit ?? null,
  }
  appendLine(context.root, 'sessions.jsonl', JSON.stringify(record))
}

export function countFileEdits(transcript: unknown[]): number {
  let edits = 0
  for (const entry of transcript) {
    if (!isObject(entry) || entry.type !== 'assistant' || !isObject(entry.message)) continue
    const { content } = entry.message
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_use') continue
      if (block.name === 'Write' || block.name === 'Edit') edits++
    }
  }
  return edits
}

// Devuelve el JSON que el hook imprime, o `null` si no hay nada que recordar.
export function remindFieldNotes(context: HookContext): string | null {
  const { input } = context
  if (!isObject(input)) return null
  const sessionId = nonEmptyString(input.session_id)
  const transcriptPath = nonEmptyString(input.transcript_path)
  if (sessionId === null || !SAFE_SESSION_ID.test(sessionId)) return null
  const marker = join(pipelineDir(context.root), `field-notes-reminded-${sessionId}`)
  if (existsSync(marker)) return null
  if (transcriptPath === null) return null
  const transcript = readJsonl(transcriptPath)
  if (transcript === null || countFileEdits(transcript) === 0) return null
  mkdirSync(pipelineDir(context.root), { recursive: true })
  writeFileSync(marker, '')
  return JSON.stringify({ systemMessage: REMINDER_TEXT })
}

function toolCommand(input: unknown): string | null {
  if (!isObject(input) || !isObject(input.tool_input)) return null
  const { command } = input.tool_input
  return typeof command === 'string' ? command : null
}

export function appendFileChange(context: HookContext): void {
  const { input } = context
  if (!isObject(input)) return
  const rawInput = input.tool_input ?? {}
  if (!isObject(rawInput)) return
  const path = rawInput.file_path ?? rawInput.path ?? '(desconocido)'
  if (typeof path !== 'string') return
  appendLine(context.root, 'events.log', `[${utcClock(context.now)}][archivo] ${path}`)
}

export function appendDotnetTestResult(context: HookContext): void {
  const command = toolCommand(context.input)
  if (command === null || !/dotnet test/.test(command) || !isObject(context.input)) return
  const result = context.input.tool_result ?? ''
  if (typeof result !== 'string') return
  const verdict = /passed|Passed|Superado|Correctas/.test(result) ? 'PASS' : 'FAIL'
  appendLine(context.root, 'events.log', `[${utcClock(context.now)}][test] ${verdict}`)
}

export function appendTerraformResult(context: HookContext): void {
  const command = toolCommand(context.input)
  if (command === null || !isObject(context.input)) return
  if (!/terraform (plan|apply|init|validate)/.test(command)) return
  const result = context.input.tool_result ?? null
  if (result !== null && !isObject(result)) return
  const exitCode = result?.exitCode ?? 0
  const subcommand = command.split(' ')[1] ?? '?'
  const verdict = exitCode === 0 ? 'OK' : 'ERROR'
  appendLine(
    context.root,
    'events.log',
    `[${utcClock(context.now)}][terraform] ${subcommand}: ${verdict}`,
  )
}

type Binding = (context: HookContext) => string | null | void

export const BINDINGS: Record<string, Binding> = {
  'record-active-release': recordActiveRelease,
  'append-session': appendSession,
  'append-session-model': appendSessionModel,
  'remind-field-notes': remindFieldNotes,
  'append-file-change': appendFileChange,
  'append-dotnet-test-result': appendDotnetTestResult,
  'append-terraform-result': appendTerraformResult,
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main(argv: string[]): number {
  const id = argv[0]
  const binding = id === undefined ? undefined : BINDINGS[id]
  if (binding === undefined) {
    console.error(`ERROR: binding desconocido '${id ?? ''}'. Validos: ${Object.keys(BINDINGS).join(', ')}`)
    return 1
  }
  try {
    const root = consumerRoot(process.cwd())
    if (root === null) return 0
    const output = binding({
      root,
      pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? '',
      input: parseJson(readStdin()),
      now: new Date(),
    })
    if (typeof output === 'string') process.stdout.write(`${output}\n`)
  } catch {
    // failure: continue
  }
  return 0
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2))
