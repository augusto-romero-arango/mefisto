// Consumidor de usar y tirar para correr `tooling-pipeline.mts` de extremo a extremo: repo con
// remoto bare, `gh` y `dotnet` inyectados y el runner real lanzando un agente guionado
// (`fixtures/tooling-pipeline/runtime-guion.mts`). Nada toca GitHub ni este repo.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../lib/azure-cli.mts'
import { capture } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'
import type { LaunchRunner } from '../lib/pipeline/pipeline-agent-run.mts'
import { loggedThrough } from '../lib/pipeline/pipeline-log.mts'
import type { DotnetResult } from '../lib/pipeline/test-results.mts'
import { toolingPipeline } from '../tooling-pipeline.mts'
import type { ToolingPipelineDeps } from '../tooling-pipeline.mts'
import { configJson } from './consumer-sandbox.mts'
import { newRepo, writeFiles } from './field-note-sandbox.mts'
import type { GuionCall, GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'

export const GUION_LIB = join(import.meta.dirname, 'fixtures', 'tooling-pipeline')
export const FIXTURES = GUION_LIB

export interface Consumer {
  /** Checkout principal del consumidor, en `main`. */
  root: string
  bare: string
  guionFile: string
  stateDir: string
}

/** Consumidor con config valido, `main` empujado al remoto bare y el estado del pipeline ignorado. */
export function newConsumer(dir: string, files: Record<string, string> = {}): Consumer {
  const repo = newRepo(dir, {
    '.mefisto/harness.config.json': configJson(),
    '.gitignore': '.mefisto/pipeline/\npipeline-state/\n',
    'README.md': 'base\n',
    ...files,
  })
  return {
    root: repo.main,
    bare: repo.bare,
    guionFile: join(dir, 'guion.json'),
    stateDir: join(repo.main, '.mefisto', 'pipeline'),
  }
}

export interface FakeIssue {
  number: number
  title: string
  body: string | null
  state: string
}

export interface FakeTools {
  /** Issue que devuelve `gh issue view`; `null` hace fallar a `gh`. */
  issue: FakeIssue | null
  /** PR abierto que reporta `gh pr list`. */
  openPr: string | null
  /** URL que imprime `gh pr create`; `null` lo hace fallar. */
  createdPr: string | null
  /** Subcomandos de `gh` que fallan (`pr comment`, `issue comment`). */
  failing: string[]
  /** Codigo de `dotnet build`. */
  buildStatus: number
  /** Resultado de `dotnet test` de cada proyecto. */
  test: DotnetResult
  /** argv de cada llamada a `gh` y a `dotnet`. */
  gh: string[][]
  dotnet: string[][]
}

export function fakeTools(overrides: Partial<FakeTools> = {}): FakeTools {
  return {
    issue: { number: 42, title: 'Agregar workflow de CI', body: 'Cuerpo del issue.', state: 'OPEN' },
    openPr: null,
    createdPr: 'https://github.com/acme/consumidor/pull/7',
    failing: [],
    buildStatus: 0,
    test: { status: 0, output: 'Passed!  - Failed: 0, Passed: 3, Skipped: 0, Total: 3\n' },
    gh: [],
    dotnet: [],
    ...overrides,
  }
}

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

function gh(tools: FakeTools, args: string[]): CommandResult {
  tools.gh.push(args)
  const command = args.slice(0, 2).join(' ')
  if (tools.failing.includes(command)) return done(1, '', `gh: ${command} fallo\n`)
  if (command === 'issue view') {
    if (tools.issue === null) return done(1, '', 'GraphQL: Could not resolve to an Issue\n')
    // `gh` imprime el JSON compacto, con las claves en orden alfabetico.
    const { body, number, state, title } = tools.issue
    return done(0, `${JSON.stringify({ body, number, state, title })}\n`)
  }
  if (command === 'pr list') return done(0, `${JSON.stringify(tools.openPr === null ? [] : [{ url: tools.openPr }])}\n`)
  if (command === 'pr create') {
    return tools.createdPr === null ? done(1, '', 'pull request create failed\n') : done(0, `${tools.createdPr}\n`)
  }
  return done(0)
}

/** `run` de los tests: `gh` y `dotnet` son dobles; `git` es el real. */
export function runWith(tools: FakeTools): Run {
  return (command, args, options) => {
    if (command === 'gh') return gh(tools, args)
    if (command === 'dotnet') {
      tools.dotnet.push(args)
      return done(tools.buildStatus, 'salida de dotnet build\n')
    }
    return capture(command, args, options)
  }
}

/** Reloj que avanza con cada espera en vez de dormir. */
export function fakeClock(): { now: () => Date; sleep: (seconds: number) => Promise<void>; slept: number[] } {
  let skewMs = 0
  const slept: number[] = []
  return {
    now: () => new Date(Date.now() + skewMs),
    sleep: (seconds) => {
      slept.push(seconds)
      skewMs += seconds * 1000
      return Promise.resolve()
    },
    slept,
  }
}

const INHERITED = [
  'MEFISTO_STATE_DIR',
  'MEFISTO_LEGACY_STATE_DIR',
  'MEFISTO_AGENT_PACKAGE_ROOT',
  'MEFISTO_RUN_AGENT_BIN',
  'MEFISTO_AGENT_TIMEOUT_SECONDS',
  'MEFISTO_HOLD_MAX_SECONDS',
  'MEFISTO_HOLD_PROBE_SECONDS',
  'MEFISTO_REPO_ROOT',
  'MEFISTO_MODELS_FILE',
]

/** Entorno del pipeline bajo prueba: runtime guionado y nada heredado de un pipeline que corra los tests. */
export function pipelineEnv(consumer: Consumer, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of INHERITED) delete env[name]
  return {
    ...env,
    MEFISTO_RUNTIME: 'guion',
    MEFISTO_RUNTIME_LIB_DIR: GUION_LIB,
    MEFISTO_RUN_AGENT_LIVE_INTERVAL: '1',
    GUION_FILE: consumer.guionFile,
    ...extra,
  }
}

export interface PipelineRun {
  code: number
  out: string
  err: string
  tools: FakeTools
}

export interface RunOptions {
  tools?: FakeTools
  env?: NodeJS.ProcessEnv
  guion?: GuionStep[]
  deps?: Partial<ToolingPipelineDeps>
}

/** Corre el pipeline en proceso, con el runner real como hijo y el agente guionado. */
export async function runTooling(consumer: Consumer, argv: string[], options: RunOptions = {}): Promise<PipelineRun> {
  const tools = options.tools ?? fakeTools()
  if (options.guion !== undefined) {
    writeFileSync(consumer.guionFile, JSON.stringify(options.guion))
    writeFileSync(`${consumer.guionFile}.n`, '0')
  }
  let out = ''
  let err = ''
  const run = runWith(tools)
  const clock = fakeClock()
  const code = await toolingPipeline({
    argv,
    cwd: consumer.root,
    env: pipelineEnv(consumer, options.env),
    scriptPath: 'scripts/tooling-pipeline.mts',
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    run,
    runLogged: loggedThrough(run),
    runDotnet: (args) => {
      tools.dotnet.push(args)
      return tools.test
    },
    hasCommand: () => true,
    now: clock.now,
    sleep: clock.sleep,
    ...options.deps,
  })
  return { code, out, err, tools }
}

export interface RunnerDouble {
  launch: LaunchRunner
  /** argv de cada invocacion del runner. */
  calls: string[][]
  /** Prompt que recibio cada invocacion. */
  prompts: string[]
}

const argOf = (args: string[], name: string): string => args[args.indexOf(name) + 1] ?? ''

/**
 * Runner en proceso que sigue un guion: hace el trabajo del agente en `--cwd` y deja en
 * `--event-log` el JSONL que dejaria el runner real. Agotado el guion, termina bien sin tocar nada.
 */
export function runnerDouble(steps: GuionStep[]): RunnerDouble {
  const double: RunnerDouble = {
    calls: [],
    prompts: [],
    launch: (args, outputFile) => {
      double.calls.push(args)
      double.prompts.push(readFileSync(argOf(args, '--prompt-file'), 'utf8'))
      const step = steps[double.calls.length - 1] ?? {}
      const cwd = argOf(args, '--cwd')
      writeFiles(cwd, step.files ?? {})
      if (step.commit !== undefined) {
        capture('git', ['add', '-A', '--', '.', ':!.mefisto/pipeline'], { cwd })
        capture('git', ['commit', '-q', '-m', step.commit], { cwd })
      }
      const success = (step.status ?? 'success') === 'success' && step.silent !== true
      const kind = step.silent === true ? 'protocol_invalid' : (step.kind ?? 'nonzero_exit')
      const model = args.includes('--model') ? argOf(args, '--model') : null
      const started = { v: 1, type: 'run.started', ts: '2030-01-01T00:00:00Z', runtime: argOf(args, '--runtime'), agent: argOf(args, '--agent'), model, effort: args.includes('--effort') ? argOf(args, '--effort') : null, cwd }
      const terminal = {
        v: 1,
        type: success ? 'run.completed' : 'run.failed',
        ts: '2030-01-01T00:00:01Z',
        status: success ? 'success' : step.silent === true ? 'protocol_invalid' : 'failed',
        runtime: argOf(args, '--runtime'),
        model,
        session_id: step.session ?? null,
        duration_ms: 1000,
        tokens: { input: 10, output: 5, cache_read: null, cache_write: null, reasoning: null },
        estimated_cost_usd: null,
        turns: 1,
        denials: step.denials ?? null,
        ttft_ms: null,
        api_duration_ms: null,
        error: success ? null : { kind, detail: `detalle redactado: ${kind}` },
        ...(step.resetsAt === undefined ? {} : { resets_at: step.resetsAt }),
      }
      writeFileSync(argOf(args, '--event-log'), `${JSON.stringify(started)}\n${JSON.stringify(terminal)}\n`)
      writeFileSync(outputFile, '')
      return Promise.resolve(step.exit ?? (success ? 0 : step.silent === true ? 65 : 3))
    },
  }
  return double
}

/** Lo que recibio el agente guionado en cada invocacion. */
export function guionCalls(consumer: Consumer): GuionCall[] {
  const file = `${consumer.guionFile}.calls.jsonl`
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GuionCall)
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** Entradas de `pipeline-history.jsonl`. */
export function history(consumer: Consumer): Record<string, unknown>[] {
  const file = join(consumer.stateDir, 'pipeline-history.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export function eventsLog(consumer: Consumer): string {
  const file = join(consumer.stateDir, 'events.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** Valor del flag `name` en un argv de `gh`. */
export function flag(args: string[], name: string): string {
  const index = args.indexOf(name)
  return index === -1 ? '' : (args[index + 1] ?? '')
}
