// Apoyo de los tests del runner: lo lanza como proceso, valida su JSONL contra el contrato y
// pone en el PATH un `claude` simulado que corre igual en POSIX y en Windows.

import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateSchema } from '../../internal/scripts/lib/jsonschema-lite.mts'
import type { JsonObject } from '../../../scripts/lib/jq-values.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RUNTIME_DIR = join(HERE, '..')
export const REPO_ROOT = join(RUNTIME_DIR, '..', '..')
export const LIB_DIR = join(RUNTIME_DIR, 'lib')
export const RUNNER = join(RUNTIME_DIR, 'mefisto-run-agent.mts')
export const CONTRACT_DIR = join(RUNTIME_DIR, 'contract')
export const RUN_EVENTS_FIXTURES = join(CONTRACT_DIR, 'fixtures', 'run-events')
export const CLAUDE_FIXTURES = join(REPO_ROOT, '.claude', 'scripts', 'tests', 'fixtures', 'runtime-claude')

export interface RunnerResult {
  status: number
  stdout: string
  stderr: string
}

/** Entorno del runner: el del test sin lo que fijaria el runtime, mas `extra`. */
export function runnerEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MEFISTO_RUNTIME_LIB_DIR: LIB_DIR }
  for (const name of Object.keys(env)) {
    if (/^MEFISTO_(FAKE_|CLAUDE_STUB_|RUN_AGENT_|WATCHDOG_|RUNTIME$|AGENT_PACKAGE_ROOT$)/.test(name)) delete env[name]
  }
  const merged = { ...env, ...extra }
  // En Windows la variable se llama `Path`: sin esto el hijo recibiria las dos grafias.
  if (extra.PATH !== undefined) {
    for (const name of Object.keys(merged)) if (name !== 'PATH' && name.toUpperCase() === 'PATH') delete merged[name]
  }
  return merged
}

/** Corre el runner como proceso, sin bloquear al test que quiere mirar sus archivos en vivo. */
export function runRunner(args: string[], extra: NodeJS.ProcessEnv = {}, cwd?: string): Promise<RunnerResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RUNNER, ...args],
      { env: runnerEnv(extra), cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1
        resolve({ status: code, stdout, stderr })
      },
    )
  })
}

export function readEvents(file: string): JsonObject[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject)
}

export function isTerminal(event: JsonObject): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed'
}

export function terminalsOf(events: JsonObject[]): JsonObject[] {
  return events.filter(isTerminal)
}

interface RunEventsSchema {
  types: string[]
  definitions: Record<string, JsonObject>
}

const SCHEMA = JSON.parse(readFileSync(join(CONTRACT_DIR, 'run-events.schema.json'), 'utf8')) as RunEventsSchema

/**
 * Motivos por los que `event` no cumple el contrato; vacio si lo cumple. El schema discrimina por
 * `type` y no puede exigir uno de dos campos, asi que el nombre del costo se comprueba aparte.
 */
export function eventErrors(event: JsonObject): string[] {
  const type = event.type
  if (typeof type !== 'string') return ["linea sin campo 'type'"]
  const definition = SCHEMA.types.includes(type) ? SCHEMA.definitions[type] : undefined
  if (definition === undefined) return [`type '${type}' no esta en el vocabulario cerrado de 'types'`]
  const errors = validateSchema(definition, event)
  if (isTerminal(event) && !('estimated_cost_usd' in event) && !('cost_usd' in event)) {
    errors.push('terminal sin estimated_cost_usd ni cost_usd')
  }
  return errors
}

export function invalidEvents(events: JsonObject[]): string[] {
  return events.flatMap(eventErrors)
}

// CommonJS: en POSIX el archivo se llama `claude`, sin extension, y Node lo carga asi.
const CLAUDE_STUB = `
const fs = require('node:fs')
const tty = require('node:tty')
const env = process.env
const set = (name) => (env[name] ?? '').length > 0

if (set('MEFISTO_CLAUDE_STUB_ARGS_FILE')) {
  fs.writeFileSync(env.MEFISTO_CLAUDE_STUB_ARGS_FILE, process.argv.slice(2).map((arg) => arg + '\\n').join(''))
}
if (set('MEFISTO_CLAUDE_STUB_EFFORT_FILE')) {
  fs.writeFileSync(env.MEFISTO_CLAUDE_STUB_EFFORT_FILE, env.CLAUDE_CODE_EFFORT_LEVEL ?? '')
}

function drainStdin() {
  const target = env.MEFISTO_CLAUDE_STUB_STDIN_FILE ?? ''
  let dump = null
  if (target.length > 0) {
    fs.writeFileSync(target + '.tty', (tty.isatty(0) ? '1' : '0') + '\\n')
    dump = fs.openSync(target, 'w')
  }
  const chunk = Buffer.alloc(65536)
  for (;;) {
    let read = 0
    try {
      read = fs.readSync(0, chunk, 0, chunk.length, null)
    } catch {
      break
    }
    if (read === 0) break
    if (dump !== null) fs.writeSync(dump, chunk, 0, read)
  }
  if (dump !== null) fs.closeSync(dump)
}

function finish() {
  drainStdin()
  if (set('MEFISTO_CLAUDE_STUB_FIXTURE') && fs.existsSync(env.MEFISTO_CLAUDE_STUB_FIXTURE)) {
    fs.writeSync(1, fs.readFileSync(env.MEFISTO_CLAUDE_STUB_FIXTURE))
  }
  if (set('MEFISTO_CLAUDE_STUB_STDERR')) fs.writeSync(2, env.MEFISTO_CLAUDE_STUB_STDERR + '\\n')
  process.exit(Number(env.MEFISTO_CLAUDE_STUB_EXIT || '0'))
}

if (set('MEFISTO_CLAUDE_STUB_SLEEP')) setTimeout(finish, Number(env.MEFISTO_CLAUDE_STUB_SLEEP) * 1000)
else finish()
`

/**
 * Pone en `binDir` un `claude` simulado y devuelve el PATH que lo antepone. Lo guionan las
 * variables MEFISTO_CLAUDE_STUB_*: FIXTURE (traza que imprime), EXIT, STDERR, SLEEP (segundos),
 * ARGS_FILE (argv, uno por linea), EFFORT_FILE (el effort que recibio por entorno) y STDIN_FILE
 * (copia de la entrada estandar, con `<archivo>.tty` diciendo si era una terminal).
 */
export function installClaudeStub(binDir: string): string {
  mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'claude-stub.cjs'), CLAUDE_STUB)
    writeFileSync(join(binDir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0claude-stub.cjs" %*\r\n`)
  } else {
    const file = join(binDir, 'claude')
    writeFileSync(file, `#!/usr/bin/env node\n${CLAUDE_STUB}`)
    chmodSync(file, 0o755)
  }
  return `${binDir}${delimiter}${process.env.PATH ?? ''}`
}
