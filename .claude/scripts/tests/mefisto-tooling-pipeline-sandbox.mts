// Repo de Mefisto de usar y tirar para correr `mefisto-tooling-pipeline.mts` de extremo a
// extremo: clon minimo con remoto bare, `gh` inyectado y el agente guionado
// (`scripts/tests/fixtures/tooling-pipeline/runtime-guion.mts`), con el runner real o con el
// doble en proceso. Nada toca GitHub ni este repo.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { capture } from '../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import type { LaunchRunner } from '../../../scripts/lib/pipeline/pipeline-agent-run.mts'
import { loggedThrough } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { newRepo } from '../../../scripts/tests/field-note-sandbox.mts'
import type { GuionCall, GuionStep } from '../../../scripts/tests/fixtures/tooling-pipeline/runtime-guion.mts'
import { GUION_LIB, fakeClock, runnerDouble } from '../../../scripts/tests/tooling-pipeline-sandbox.mts'
import { mefistoToolingPipeline } from '../../../src/internal/scripts/mefisto-tooling-pipeline.mts'
import type { MefistoToolingDeps } from '../../../src/internal/scripts/mefisto-tooling-pipeline.mts'

export const FIXTURES = join(import.meta.dirname, 'fixtures', 'mefisto-tooling-pipeline')
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

export interface Mefisto {
  /** Checkout principal, en `main`. */
  root: string
  bare: string
  guionFile: string
  stateDir: string
}

/** Repo minimo con la forma del de Mefisto, `main` empujado al remoto bare. */
export function newMefisto(dir: string, files: Record<string, string> = {}): Mefisto {
  const repo = newRepo(dir, {
    '.claude-plugin/plugin.json': '{\n  "name": "mefisto",\n  "version": "0.0.0"\n}\n',
    '.gitignore': '.mefisto/\n.claude/pipeline/\n',
    'changelog.d/README.md': '# changelog.d\n',
    'docs/README.md': 'docs\n',
    ...files,
  })
  // Los hooks ya activos, como en un clon que corrio el pipeline antes: sin el aviso en stderr.
  capture('git', ['config', 'core.hooksPath', 'src/internal/githooks'], { cwd: repo.main })
  return { root: repo.main, bare: repo.bare, guionFile: join(dir, 'guion.json'), stateDir: join(repo.main, '.mefisto', 'pipeline') }
}

export interface FakeIssue {
  number: number
  title: string
  body: string | null
  state: string
  labels?: { name: string }[]
}

export interface FakeGh {
  /** Issue que devuelve `gh issue view`; `null` hace fallar a `gh`. */
  issue: FakeIssue | null
  /** PR abierto que reporta `gh pr list`. */
  openPr: string | null
  /** URL que imprime `gh pr create`; `null` lo hace fallar. */
  createdPr: string | null
  /** Subcomandos que fallan (`pr comment`, `issue comment`). */
  failing: string[]
  /** argv de cada llamada. */
  calls: string[][]
}

export function fakeGh(overrides: Partial<FakeGh> = {}): FakeGh {
  return {
    issue: { number: 42, title: 'Agregar script de CI', body: 'Cuerpo del issue.', state: 'OPEN' },
    openPr: null,
    createdPr: 'https://github.com/acme/mefisto/pull/7',
    failing: [],
    calls: [],
    ...overrides,
  }
}

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

function gh(fake: FakeGh, args: string[]): CommandResult {
  fake.calls.push(args)
  const command = args.slice(0, 2).join(' ')
  if (fake.failing.includes(command)) return done(1, '', `gh: ${command} fallo\n`)
  if (command === 'issue view') {
    if (fake.issue === null) return done(1, '', 'GraphQL: Could not resolve to an Issue\n')
    const { body, labels = [], number, state, title } = fake.issue
    return done(0, `${JSON.stringify({ body, labels, number, state, title })}\n`)
  }
  if (command === 'pr list') return done(0, `${JSON.stringify(fake.openPr === null ? [] : [{ url: fake.openPr }])}\n`)
  if (command === 'pr create') return fake.createdPr === null ? done(1, '', 'pull request create failed\n') : done(0, `${fake.createdPr}\n`)
  if (command === 'repo view') return done(1, '', 'sin remoto de GitHub\n')
  return done(0)
}

/** `run` de los tests: `gh` es el doble; `git` y el gate de neutralidad son los reales. */
export function runWith(fake: FakeGh): Run {
  return (command, args, options) => (command === 'gh' ? gh(fake, args) : capture(command, args, options))
}

const INHERITED = [
  'MEFISTO_STATE_DIR',
  'MEFISTO_LEGACY_STATE_DIR',
  'MEFISTO_REPO_ROOT',
  'MEFISTO_PROJECT_NAME',
  'MEFISTO_REPO_SLUG',
  'MEFISTO_LAUNCH_ROOT',
  'MEFISTO_RUNTIME_LIB_DIR',
  'MEFISTO_MODELS_FILE',
  'MEFISTO_RUN_AGENT_BIN',
  'MEFISTO_AGENT_TIMEOUT_SECONDS',
  'MEFISTO_AGENT_MAX_ATTEMPTS',
  'MEFISTO_AGENT_RETRY_BACKOFF_SECONDS',
  'MEFISTO_HOLD_MAX_SECONDS',
  'MEFISTO_HOLD_PROBE_SECONDS',
]

/** Entorno de la corrida: agente guionado y nada heredado de un pipeline que corra los tests. */
export function pipelineEnv(repo: Mefisto, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of INHERITED) delete env[name]
  return {
    ...env,
    MEFISTO_RUNTIME: 'guion',
    MEFISTO_RUNTIME_LIB_DIR: GUION_LIB,
    MEFISTO_RUN_AGENT_LIVE_INTERVAL: '1',
    GUION_FILE: repo.guionFile,
    ...extra,
  }
}

export interface PipelineRun {
  code: number
  out: string
  err: string
  gh: FakeGh
  /** Segundos que la corrida pidio dormir. */
  slept: number[]
}

export interface RunOptions {
  gh?: FakeGh
  env?: NodeJS.ProcessEnv
  /** Pasos del agente guionado, para el runner real. */
  guion?: GuionStep[]
  /** Pasos del runner en proceso; sin ellos corre el runner real. */
  steps?: GuionStep[]
  deps?: Partial<MefistoToolingDeps>
}

/** Corre el pipeline en proceso con `cwd` en el repo. */
export async function runMefistoTooling(repo: Mefisto, argv: string[], options: RunOptions = {}): Promise<PipelineRun> {
  const fake = options.gh ?? fakeGh()
  if (options.guion !== undefined) {
    writeFileSync(repo.guionFile, JSON.stringify(options.guion))
    writeFileSync(`${repo.guionFile}.n`, '0')
  }
  let out = ''
  let err = ''
  const run = runWith(fake)
  const clock = fakeClock()
  const launchRunner: LaunchRunner | undefined = options.steps === undefined ? undefined : runnerDouble(options.steps).launch
  const code = await mefistoToolingPipeline({
    argv,
    cwd: repo.root,
    env: pipelineEnv(repo, options.env),
    scriptPath: 'src/internal/scripts/mefisto-tooling-pipeline.mts',
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    run,
    runLogged: loggedThrough(run),
    hasCommand: () => true,
    now: clock.now,
    sleep: clock.sleep,
    ...(launchRunner === undefined ? {} : { launchRunner }),
    ...options.deps,
  })
  return { code, out, err, gh: fake, slept: clock.slept }
}

/** Lo que recibio el agente guionado en cada invocacion. */
export function guionCalls(repo: Mefisto): GuionCall[] {
  const file = `${repo.guionFile}.calls.jsonl`
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GuionCall)
}

export function history(repo: Mefisto): Record<string, unknown>[] {
  const file = join(repo.stateDir, 'pipeline-history.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export function eventsLog(repo: Mefisto): string {
  const file = join(repo.stateDir, 'events.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** Archivos de `dir` cuyo nombre casa con `pattern`, en orden. */
export function filesMatching(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => join(dir, name))
}

/** Valor del flag `name` en un argv de `gh`. */
export function flag(args: string[], name: string): string {
  const index = args.indexOf(name)
  return index === -1 ? '' : (args[index + 1] ?? '')
}

/** Pasos tipicos: el writer deja un cambio notable, su fragmento y su resumen; el reviewer, el suyo. */
export const WRITER: GuionStep = {
  files: {
    'docs/ci.md': 'Notas de CI\n',
    'changelog.d/42.added.md': '- script de CI\n',
    '.mefisto/pipeline/summaries/stage-1-writer.md': 'resumen del writer\n',
  },
  commit: 'agregar notas de CI',
}
export const REVIEWER: GuionStep = {
  files: { 'docs/ci.md': 'Notas de CI revisadas\n', '.mefisto/pipeline/summaries/stage-2-reviewer.md': 'resumen del reviewer\n' },
}
