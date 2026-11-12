// Repo de Mefisto de usar y tirar para correr `mefisto-batch-pipeline.mts` de extremo a extremo:
// remoto bare, un clon "publisher" que hace de merge del lado de GitHub, `gh` inyectado y eslabones
// falsos que son procesos reales (`fixtures/mefisto-batch-pipeline/eslabon.mts`). Nada toca GitHub
// ni este repo.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { capture } from '../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { loggedThrough } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { git, newRepo } from '../../../scripts/tests/field-note-sandbox.mts'
import { mefistoBatchPipeline } from '../../../src/internal/scripts/mefisto-batch-pipeline.mts'
import type { MefistoBatchDeps } from '../../../src/internal/scripts/mefisto-batch-pipeline.mts'

const CHILD = readFileSync(join(import.meta.dirname, 'fixtures', 'mefisto-batch-pipeline', 'eslabon.mts'), 'utf8')

export interface BatchRepo {
  /** Checkout lanzador, en `main`. */
  root: string
  bare: string
  /** Clon que publica en origin/main lo que GitHub haria al mergear. */
  publisher: string
  stateDir: string
  guionFile: string
  callsFile: string
}

/** Repo minimo con la forma del de Mefisto, sus dos eslabones falsos ya empujados a origin/main. */
export function newBatchRepo(dir: string, files: Record<string, string> = {}): BatchRepo {
  const repo = newRepo(dir, {
    '.claude-plugin/plugin.json': '{\n  "name": "mefisto",\n  "version": "0.0.0"\n}\n',
    '.gitignore': '.mefisto/\n',
    'marker.txt': 'v1\n',
    'src/internal/scripts/mefisto-tooling-pipeline.mts': CHILD,
    'src/internal/scripts/mefisto-validate-batch-deps.mts': CHILD,
    ...files,
  })
  // Hooks ya activos, como en un clon que corrio el pipeline antes: sin el aviso en stderr.
  git(repo.main, 'config', 'core.hooksPath', 'src/internal/githooks')
  // Upstream de main, como en un clon real: `git pull --ff-only` lo necesita.
  git(repo.main, 'branch', '-q', '--set-upstream-to=origin/main', 'main')
  git(repo.bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const publisher = join(dir, 'publisher')
  git(dir, 'clone', '-q', repo.bare, publisher)
  git(publisher, 'config', 'user.email', 'test@mefisto.local')
  git(publisher, 'config', 'user.name', 'Mefisto Test')
  return {
    root: repo.main,
    bare: repo.bare,
    publisher,
    stateDir: join(repo.main, '.mefisto', 'pipeline'),
    guionFile: join(dir, 'guion.json'),
    callsFile: join(dir, 'llamadas.jsonl'),
  }
}

export interface Step {
  exit?: number
  output?: string
  stderr?: string
  events?: string[]
  signal?: boolean
  mutateLauncher?: boolean
}

export interface Guion {
  pipeline?: Record<string, Step>
  reconcile?: Record<string, Step>
}

export interface FakeGh {
  /** Body de cada issue para `gh issue view --json body`. */
  bodies: Record<string, string>
  /** Estado de cada issue; sin entrada, `gh issue view --json state` falla. */
  states: Record<string, string>
  /** Estado de cada PR; sin entrada, `gh pr view --json state` falla. */
  prStates: Record<string, string>
  /** PRs cuyo merge falla. */
  mergeFails: string[]
  /** Commit de merge que reporta `gh pr view` en vez del real. */
  mergeShas: Record<string, string>
  /** Lo que hace el merge en el publisher; por defecto, un commit vacio. */
  onMerge?: (pr: string, publisher: string) => void
  calls: string[][]
}

export function fakeGh(overrides: Partial<FakeGh> = {}): FakeGh {
  return { bodies: {}, states: {}, prStates: {}, mergeFails: [], mergeShas: {}, calls: [], ...overrides }
}

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

function gh(fake: FakeGh, repo: BatchRepo, merged: Record<string, string>, args: string[]): CommandResult {
  fake.calls.push(args)
  const command = args.slice(0, 2).join(' ')
  const number = args[2] ?? ''
  const json = args[args.indexOf('--json') + 1] ?? ''
  if (command === 'pr merge') {
    appendFileSync(repo.callsFile, `${JSON.stringify({ role: 'gh', args })}\n`)
    if (fake.mergeFails.includes(number)) return done(1, '', `merge simulado fallido del PR #${number}\n`)
    git(repo.publisher, 'pull', '-q', '--ff-only', 'origin', 'main')
    if (fake.onMerge === undefined) git(repo.publisher, 'commit', '-q', '--allow-empty', '-m', `merge PR #${number}`)
    else fake.onMerge(number, repo.publisher)
    git(repo.publisher, 'push', '-q', 'origin', 'main')
    merged[number] = git(repo.publisher, 'rev-parse', 'HEAD')
    return done(0, `Merged PR #${number}\n`)
  }
  if (command === 'pr view' && json === 'mergeCommit') {
    appendFileSync(repo.callsFile, `${JSON.stringify({ role: 'gh', args })}\n`)
    return done(0, `${fake.mergeShas[number] ?? merged[number] ?? ''}\n`)
  }
  if (command === 'pr view' && json === 'state') {
    const state = fake.prStates[number]
    return state === undefined ? done(1, '', 'no pull requests found\n') : done(0, `${state}\n`)
  }
  if (command === 'issue view' && json === 'body') return done(0, `${fake.bodies[number] ?? ''}\n`)
  if (command === 'issue view' && json === 'state') {
    const state = fake.states[number]
    return state === undefined ? done(1, '', 'GraphQL: Could not resolve to an Issue\n') : done(0, `${state}\n`)
  }
  return done(1, '', `gh simulado: ${args.join(' ')} sin respuesta\n`)
}

const INHERITED = [
  'MEFISTO_STATE_DIR',
  'MEFISTO_LEGACY_STATE_DIR',
  'MEFISTO_REPO_ROOT',
  'MEFISTO_PROJECT_NAME',
  'MEFISTO_REPO_SLUG',
  'MEFISTO_RUNTIME_LIB_DIR',
  'MEFISTO_LAUNCH_ROOT',
  'MEFISTO_MODELS_FILE',
  'MEFISTO_RUNTIME',
  'MEFISTO_AGENT_TIMEOUT_SECONDS',
]

export interface BatchRun {
  code: number
  out: string
  err: string
  gh: FakeGh
  /** Una entrada por invocacion de un eslabon o de `gh pr merge`/`gh pr view --json mergeCommit`. */
  calls: Record<string, unknown>[]
  /** Segundos de cada espera pedida por el sync. */
  slept: number[]
}

export interface BatchOptions {
  gh?: FakeGh
  guion?: Guion
  /** Entorno extra; un valor `undefined` quita la variable. */
  env?: NodeJS.ProcessEnv
  hasCommand?: (command: string) => boolean
  deps?: Partial<MefistoBatchDeps>
}

export async function runMefistoBatch(repo: BatchRepo, argv: string[], options: BatchOptions = {}): Promise<BatchRun> {
  writeFileSync(repo.guionFile, JSON.stringify({ calls: repo.callsFile, ...options.guion }))
  writeFileSync(repo.callsFile, '')
  const fake = options.gh ?? fakeGh()
  const merged: Record<string, string> = {}
  const run: Run = (command, args, given) => (command === 'gh' ? gh(fake, repo, merged, args) : capture(command, args, given))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of INHERITED) delete env[name]
  Object.assign(env, { MEFISTO_RUNTIME: 'claude', MEFISTO_BATCH_GUION: repo.guionFile }, options.env)
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name]
  const result: BatchRun = { code: -1, out: '', err: '', gh: fake, calls: [], slept: [] }
  result.code = await mefistoBatchPipeline({
    argv,
    cwd: repo.root,
    env,
    scriptPath: 'src/internal/scripts/mefisto-batch-pipeline.sh',
    out: (text) => {
      result.out += text
    },
    err: (text) => {
      result.err += text
    },
    run,
    runLogged: loggedThrough(run),
    hasCommand: options.hasCommand ?? (() => true),
    now: () => new Date(),
    sleep: async (seconds) => {
      result.slept.push(seconds)
    },
    signals: { on: () => {}, off: () => {} },
    ...options.deps,
  })
  result.calls = existsSync(repo.callsFile)
    ? readFileSync(repo.callsFile, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
  return result
}

/** Issues con que se invoco al pipeline de tooling, en orden. */
export function pipelineIssues(run: BatchRun): string[] {
  return run.calls.filter((call) => call.role === 'mefisto-tooling-pipeline').map((call) => (call.args as string[])[0] ?? '')
}

export function readStatus(repo: BatchRepo): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo.stateDir, 'pipeline-status-mefisto-batch.json'), 'utf8')) as Record<string, unknown>
}

/** Estado libre de `issue` en el status del batch. */
export function issueStatus(repo: BatchRepo, issue: string): string {
  const issues = readStatus(repo).issues as { issue: string; status: string }[]
  return issues.find((entry) => entry.issue === issue)?.status ?? ''
}

/** Anuncio de espera tal como lo escribe el eslabon en events.log. */
export function holdLine(start: string, probe: string, family = 'RATE_LIMIT'): string {
  return `[${start}][hold] ${family}: esperando, proxima sonda ${probe} (techo 23:59)`
}
