// Adaptador de runtime de prueba para los pipelines: un agente guionado que, a diferencia de
// `runtime-fake.mts`, deja trabajo en el worktree y declara sesion, denegaciones y causa del
// fallo. Este mismo archivo es el "CLI" que su `buildCmd` invoca.
//
// GUION_FILE nombra un JSON con la lista de pasos (`GuionStep`), uno por invocacion y en orden;
// agotada la lista, cada invocacion termina bien sin tocar nada. Cada invocacion deja una linea
// en `<GUION_FILE>.calls.jsonl` con lo que recibio.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BuildCommandInput, RuntimeCommand, TranslateInput } from '../../../../src/runtime/lib/mefisto-runtime.mts'
import { isEntryPoint } from '../../../lib/cli.mts'

export interface GuionStep {
  /** Archivos que el agente escribe, relativos al worktree. */
  files?: Record<string, string>
  /** Mensaje del commit con que el agente cierra su trabajo; sin el, lo deja sin commitear. */
  commit?: string
  status?: 'success' | 'failed'
  /** `error.kind` del terminal fallido. */
  kind?: string
  session?: string
  denials?: number
  resetsAt?: string
  /** Codigo de salida del "CLI"; por defecto 0 si termina bien y 3 si falla. */
  exit?: number
  /** Sin terminal: el runner lo trata como protocolo invalido. */
  silent?: boolean
}

export interface GuionCall {
  agent: string
  prompt: string
  system: string
  model: string
  effort: string
  resume: string
  cwd: string
}

const EMIT = '__guion-emit'

export function isAvailable(): boolean {
  return true
}

export function supportsResume(env: NodeJS.ProcessEnv): boolean {
  return env.GUION_RESUME === '1'
}

export function defaultModel(_profile: string, env: NodeJS.ProcessEnv): string {
  return env.GUION_DEFAULT_MODEL ?? ''
}

export function buildCmd(input: BuildCommandInput): RuntimeCommand {
  return {
    argv: [
      process.execPath,
      fileURLToPath(import.meta.url),
      EMIT,
      input.agent,
      input.promptFile,
      input.systemFile,
      input.model,
      input.effort,
      input.resumeSessionId,
    ],
  }
}

const NO_TOKENS = { input: null, output: null, cache_read: null, cache_write: null, reasoning: null }

export function translate(input: TranslateInput): Record<string, unknown>[] {
  let raw: string
  try {
    if (!statSync(input.rawFile).isFile()) return []
    raw = readFileSync(input.rawFile, 'utf8')
  } catch {
    return []
  }
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const events: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    let step: GuionStep
    try {
      step = JSON.parse(line) as GuionStep
    } catch {
      continue
    }
    const success = (step.status ?? 'success') === 'success'
    events.push({
      v: 1,
      type: success ? 'run.completed' : 'run.failed',
      ts,
      status: success ? 'success' : 'failed',
      runtime: input.runtime,
      model: input.model.length > 0 ? input.model : null,
      session_id: step.session ?? null,
      duration_ms: null,
      tokens: { ...NO_TOKENS },
      estimated_cost_usd: null,
      turns: null,
      denials: step.denials ?? null,
      ttft_ms: null,
      api_duration_ms: null,
      error: success ? null : { kind: step.kind ?? 'nonzero_exit', detail: 'fallo del guion' },
      ...(step.resetsAt === undefined ? {} : { resets_at: step.resetsAt }),
    })
  }
  return events
}

function nextStep(guionFile: string): GuionStep {
  const steps = JSON.parse(readFileSync(guionFile, 'utf8')) as GuionStep[]
  const counter = `${guionFile}.n`
  const index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(index + 1))
  return steps[index] ?? {}
}

function emit(argv: string[], env: NodeJS.ProcessEnv): number {
  const guionFile = env.GUION_FILE ?? ''
  const [agent = '', promptFile = '', systemFile = '', model = '', effort = '', resume = ''] = argv
  const read = (file: string): string => (file.length > 0 && existsSync(file) ? readFileSync(file, 'utf8') : '')
  const call: GuionCall = { agent, prompt: read(promptFile), system: read(systemFile), model, effort, resume, cwd: process.cwd() }
  appendFileSync(`${guionFile}.calls.jsonl`, `${JSON.stringify(call)}\n`)

  const step = nextStep(guionFile)
  for (const [rel, content] of Object.entries(step.files ?? {})) {
    const path = join(process.cwd(), ...rel.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  if (step.commit !== undefined) {
    spawnSync('git', ['add', '-A', '--', '.', ':!.mefisto/pipeline'], { stdio: 'ignore' })
    spawnSync('git', ['commit', '-q', '-m', step.commit], { stdio: 'ignore' })
  }
  if (step.silent !== true) writeSync(1, `${JSON.stringify(step)}\n`)
  return step.exit ?? ((step.status ?? 'success') === 'success' ? 0 : 3)
}

if (isEntryPoint(import.meta.url) && process.argv[2] === EMIT) {
  process.exit(emit(process.argv.slice(3), process.env))
}
