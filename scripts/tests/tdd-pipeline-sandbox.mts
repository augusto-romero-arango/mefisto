// Consumidor de usar y tirar para correr `tdd-pipeline.mts` de extremo a extremo: el de
// tooling-pipeline-sandbox.mts con un proyecto de tests, `dotnet test` guionado por gate, labels
// en el issue y dotnet-coverage inyectable. Nada toca GitHub ni este repo.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../lib/azure-cli.mts'
import { capture } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'
import type { LaunchRunner } from '../lib/pipeline/pipeline-agent-run.mts'
import { loggedThrough } from '../lib/pipeline/pipeline-log.mts'
import type { CoverageRun } from '../lib/pipeline/tdd-coverage.mts'
import type { DotnetResult } from '../lib/pipeline/test-results.mts'
import { tddPipeline } from '../tdd-pipeline.mts'
import type { TddPipelineDeps } from '../tdd-pipeline.mts'
import { writeFiles } from './field-note-sandbox.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { fakeClock, fakeTools, newConsumer, pipelineEnv, runWith } from './tooling-pipeline-sandbox.mts'
import type { Consumer, FakeTools } from './tooling-pipeline-sandbox.mts'

export { eventsLog, flag, guionCalls, history, readJson } from './tooling-pipeline-sandbox.mts'
export type { Consumer } from './tooling-pipeline-sandbox.mts'

export const PREFIX = 'Empresa.Proyecto'
export const TEST_PROJECT = `tests/${PREFIX}.Turnos.Tests`
export const SMOKE_PROJECT = `tests/${PREFIX}.Turnos.SmokeTests`
export const BRANCH = 'worktree-issue-42-registrar-turno'

/** Consumidor con un proyecto de tests del dominio Turnos ya en `main`. */
export function newTddConsumer(dir: string, files: Record<string, string> = {}): Consumer {
  return newConsumer(dir, {
    [`${TEST_PROJECT}/BaseTests.cs`]: 'public class BaseTests\n{\n    [Fact]\n    public void Guarda_Inventario()\n    {\n        Assert.Equal(28, Catalogo.Count);\n    }\n}\n',
    [`src/${PREFIX}.Turnos/Catalogo.cs`]: 'public static class Catalogo { }\n',
    ...files,
  })
}

export const GREEN: DotnetResult = { status: 0, output: 'Passed!  - Failed: 0, Passed: 3, Skipped: 0, Total: 3\n' }
export const RED: DotnetResult = {
  status: 2,
  output: `  failed ${PREFIX}.Turnos.Tests.RegistrarTurnoTests.Registra_El_Turno (1ms)\nTest run summary: Failed!\n`,
}
export const NO_TESTS: DotnetResult = { status: 8, output: 'Zero tests ran\n' }

export interface TddTools extends FakeTools {
  labels: string[]
  /** Resultado de cada `dotnet test`, en orden; agotada la lista, `GREEN`. */
  tests: DotnetResult[]
  /** Codigo de `dotnet build` por llamada, en orden; agotada la lista, `buildStatus`. */
  builds: number[]
}

export function tddTools(overrides: Partial<TddTools> = {}): TddTools {
  return {
    ...fakeTools({ issue: { number: 42, title: 'Registrar turno', body: 'Cuerpo del issue.', state: 'OPEN' } }),
    labels: [],
    tests: [RED],
    builds: [],
    ...overrides,
  }
}

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

/** `run` de los tests: `gh` y `dotnet` son dobles, con labels en el issue; `git` es el real. */
export function tddRunWith(tools: TddTools): Run {
  const base = runWith(tools)
  return (command, args, options) => {
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'view' && tools.issue !== null) {
      tools.gh.push(args)
      const { body, number, state, title } = tools.issue
      const labels = tools.labels.map((name) => ({ id: `LA_${name}`, name, description: '', color: '000000' }))
      return done(0, `${JSON.stringify({ body, labels, number, state, title })}\n`)
    }
    if (command === 'dotnet') {
      tools.dotnet.push(args)
      return done(tools.builds.shift() ?? tools.buildStatus, 'salida de dotnet build\n')
    }
    return base(command, args, options)
  }
}

export interface TddRun {
  code: number
  out: string
  err: string
  tools: TddTools
}

export interface TddRunOptions {
  tools?: TddTools
  env?: NodeJS.ProcessEnv
  /** Pasos del agente guionado del runner real. */
  guion?: GuionStep[]
  /** Pasos del runner en proceso; con ellos no se lanza ningun proceso de agente. */
  steps?: DoubleStep[]
  /** Pasos de la medicion de cobertura; sin ellos dotnet-coverage no esta disponible. */
  coverage?: CoverageRun
  deps?: Partial<TddPipelineDeps>
}

/** Corre el pipeline en proceso con el runner real (o el doble) y `gh`/`dotnet` falsos. */
export async function runTdd(consumer: Consumer, argv: string[], options: TddRunOptions = {}): Promise<TddRun> {
  const tools = options.tools ?? tddTools()
  if (options.guion !== undefined) {
    writeFileSync(consumer.guionFile, JSON.stringify(options.guion))
    writeFileSync(`${consumer.guionFile}.n`, '0')
  }
  let out = ''
  let err = ''
  const run = tddRunWith(tools)
  const clock = fakeClock()
  const code = await tddPipeline({
    argv,
    cwd: consumer.root,
    env: pipelineEnv(consumer, options.env),
    scriptPath: 'scripts/tdd-pipeline.mts',
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
      return tools.tests.shift() ?? GREEN
    },
    hasCommand: (command) => command !== 'dotnet-coverage' || options.coverage !== undefined,
    now: clock.now,
    sleep: clock.sleep,
    ...(options.steps === undefined ? {} : { launchRunner: runnerDouble(options.steps).launch }),
    ...(options.coverage === undefined ? {} : { runCoverage: options.coverage }),
    ...options.deps,
  })
  return { code, out, err, tools }
}

export interface DoubleStep extends GuionStep {
  /** Eventos que el agente emite antes del terminal (el runner los conserva redactados). */
  events?: Record<string, unknown>[]
  /** Archivos que el agente borra, relativos al worktree. */
  remove?: string[]
  /** Corre antes del trabajo del agente: lo que cambia en el mundo mientras el agente trabaja. */
  before?: () => void
}

export interface RunnerDouble {
  launch: LaunchRunner
  calls: string[][]
  prompts: string[]
}

const argOf = (args: string[], name: string): string => args[args.indexOf(name) + 1] ?? ''

/**
 * Runner en proceso que sigue un guion: hace el trabajo del agente en `--cwd` y deja en
 * `--event-log` el JSONL que dejaria el runner real. Agotado el guion, termina bien sin tocar nada.
 */
export function runnerDouble(steps: DoubleStep[]): RunnerDouble {
  const double: RunnerDouble = {
    calls: [],
    prompts: [],
    launch: (args, outputFile) => {
      double.calls.push(args)
      double.prompts.push(readFileSync(argOf(args, '--prompt-file'), 'utf8'))
      const step = steps[double.calls.length - 1] ?? {}
      step.before?.()
      const cwd = argOf(args, '--cwd')
      writeFiles(cwd, step.files ?? {})
      for (const rel of step.remove ?? []) capture('git', ['rm', '-q', '--', rel], { cwd })
      if (step.commit !== undefined) {
        capture('git', ['add', '-A', '--', '.', ':!.mefisto/pipeline', ':!pipeline-state'], { cwd })
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
      const lines = [started, ...(step.events ?? []), terminal].map((event) => `${JSON.stringify(event)}\n`)
      writeFileSync(argOf(args, '--event-log'), lines.join(''))
      writeFileSync(outputFile, '')
      return Promise.resolve(step.exit ?? (success ? 0 : step.silent === true ? 65 : 3))
    },
  }
  return double
}

/** Archivos que deja el test-writer de un issue normal: un test nuevo y el stub que lo compila. */
export const TEST_WRITER: DoubleStep = {
  files: {
    [`${TEST_PROJECT}/RegistrarTurnoTests.cs`]: 'public class RegistrarTurnoTests { }\n',
    [`src/${PREFIX}.Turnos/RegistrarTurno/RegistrarTurnoCommandHandler.cs`]: 'public class RegistrarTurnoCommandHandler { }\n',
  },
  commit: 'test(hu-42): tests fase roja',
}
export const IMPLEMENTER: DoubleStep = {
  files: { [`src/${PREFIX}.Turnos/RegistrarTurno/RegistrarTurnoCommandHandler.cs`]: 'public class RegistrarTurnoCommandHandler { int x; }\n' },
  commit: 'feat(hu-42): implementacion',
}
export const REVIEWER: DoubleStep = { files: { 'docs/notas.md': 'Revisado\n' } }

export function statusFile(consumer: Consumer, name = 'pipeline-status-tdd-42.json'): string {
  return join(consumer.stateDir, name)
}

export function worktreeOf(consumer: Consumer, branch = BRANCH): string {
  return join(consumer.stateDir, 'worktrees', branch)
}
