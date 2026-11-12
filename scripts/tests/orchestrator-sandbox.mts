// Consumidor de usar y tirar para correr `batch-pipeline.mts` de extremo a extremo: repo con remoto
// bare, `gh` simulado y pipelines hijos falsos que son procesos reales
// (`fixtures/orchestrators/pipeline-hijo.mts`). Nada toca GitHub ni este repo.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { batchPipeline } from '../batch-pipeline.mts'
import type { BatchPipelineDeps } from '../batch-pipeline.mts'
import type { Run } from '../lib/azure-cli.mts'
import { capture } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'
import { loggedThrough } from '../lib/pipeline/pipeline-log.mts'
import { newRepo } from './field-note-sandbox.mts'

const CHILD = join(import.meta.dirname, 'fixtures', 'orchestrators', 'pipeline-hijo.mts')

/** Roles con que se copia el pipeline hijo falso. */
export const CHILD_ROLES = ['tooling-pipeline', 'tdd-pipeline', 'pr-sync'] as const

export interface Orchestrated {
  root: string
  bare: string
  stateDir: string
  legacyStateDir: string
  /** Donde viven los pipelines hijos falsos. */
  scriptsDir: string
  guionFile: string
  callsFile: string
}

export function newOrchestrated(dir: string, roles: readonly string[] = CHILD_ROLES): Orchestrated {
  const repo = newRepo(dir, { '.gitignore': '.mefisto/pipeline/\n.claude/pipeline/\npipeline-state/\n', 'README.md': 'base\n' })
  const scriptsDir = join(dir, 'paquete', 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  for (const role of roles) copyFileSync(CHILD, join(scriptsDir, `${role}.mts`))
  return {
    root: repo.main,
    bare: repo.bare,
    stateDir: join(repo.main, '.mefisto', 'pipeline'),
    legacyStateDir: join(repo.main, '.claude', 'pipeline'),
    scriptsDir,
    guionFile: join(dir, 'guion.json'),
    callsFile: join(dir, 'llamadas.txt'),
  }
}

export interface ChildStep {
  exit?: number
  output?: string
  signal?: boolean
  events?: string[]
  legacyEvents?: string[]
  status?: unknown
  sleepMs?: number
}

export interface ChildGuion {
  pipeline?: Record<string, ChildStep>
  prSync?: Record<string, ChildStep>
}

export interface FakeIssue {
  state?: string
  labels?: string[]
  body?: string
}

export interface FakeGh {
  /** Issues por numero; sin entrada, uno `OPEN` con `tipo:tooling`. */
  issues: Record<string, FakeIssue>
  /** Numeros que `gh issue view` no encuentra. */
  missing: string[]
  /** `state` de `gh pr view` por numero; sin entrada, falla. */
  prs: Record<string, string>
  editStatus: number
  calls: string[][]
}

export function fakeGh(overrides: Partial<FakeGh> = {}): FakeGh {
  return { issues: {}, missing: [], prs: {}, editStatus: 0, calls: [], ...overrides }
}

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

const flagOf = (args: string[], name: string): string => {
  const index = args.indexOf(name)
  return index === -1 ? '' : (args[index + 1] ?? '')
}

function gh(fake: FakeGh, args: string[]): CommandResult {
  fake.calls.push(args)
  const command = args.slice(0, 2).join(' ')
  const number = args[2] ?? ''
  if (command === 'issue edit') return done(fake.editStatus, '', fake.editStatus === 0 ? '' : 'no se pudo editar\n')
  if (command === 'pr view') {
    const state = fake.prs[number]
    return state === undefined ? done(1, '', 'no pull requests found\n') : done(0, `${state}\n`)
  }
  if (command !== 'issue view') return done(1, '', `gh simulado: ${args.join(' ')} sin respuesta\n`)
  if (fake.missing.includes(number)) return done(1, '', 'GraphQL: Could not resolve to an Issue\n')
  const issue = { state: 'OPEN', labels: ['tipo:tooling'], body: '', ...fake.issues[number] }
  const json = flagOf(args, '--json')
  // `gh` imprime el JSON compacto, con las claves en orden alfabetico.
  if (json === 'state,labels') return done(0, `${JSON.stringify({ labels: issue.labels.map((name) => ({ name })), state: issue.state })}\n`)
  if (json === 'body') return done(0, `${issue.body}\n`)
  if (json === 'labels') return done(0, `${issue.labels.join('\n')}\n`)
  if (json === 'state') return done(0, `${issue.state}\n`)
  return done(1, '', `gh simulado: ${args.join(' ')} sin respuesta\n`)
}

/** `run` de los tests: `gh` es el doble; `git` es el real. */
export function runWith(fake: FakeGh): Run {
  return (command, args, options) => (command === 'gh' ? gh(fake, args) : capture(command, args, options))
}

const INHERITED = [
  'MEFISTO_STATE_DIR',
  'MEFISTO_LEGACY_STATE_DIR',
  'MEFISTO_AGENT_PACKAGE_ROOT',
  'MEFISTO_RUNTIME_LIB_DIR',
  'MEFISTO_REPO_ROOT',
  'MEFISTO_LAUNCH_ROOT',
]

export function orchestratorEnv(repo: Orchestrated, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of INHERITED) delete env[name]
  return { ...env, MEFISTO_RUNTIME: 'claude', ORQUESTADOR_GUION: repo.guionFile, ...extra }
}

export interface OrchestratorRun {
  code: number
  out: string
  err: string
  gh: FakeGh
  /** Invocaciones de los hijos: `<rol> <argumentos>`. */
  calls: string[]
  /** Segundos de cada espera pedida (escalonado y refrescos). */
  slept: number[]
}

export interface OrchestratorOptions {
  gh?: FakeGh
  guion?: ChildGuion
  env?: NodeJS.ProcessEnv
  hasCommand?: (command: string) => boolean
}

function prepare(repo: Orchestrated, options: OrchestratorOptions): { fake: FakeGh; result: OrchestratorRun } {
  writeFileSync(repo.guionFile, JSON.stringify({ calls: repo.callsFile, ...options.guion }))
  writeFileSync(repo.callsFile, '')
  const fake = options.gh ?? fakeGh()
  return { fake, result: { code: -1, out: '', err: '', gh: fake, calls: [], slept: [] } }
}

function readCalls(repo: Orchestrated): string[] {
  return existsSync(repo.callsFile) ? readFileSync(repo.callsFile, 'utf8').split('\n').filter((line) => line.length > 0) : []
}

export async function runBatch(
  repo: Orchestrated,
  argv: string[],
  options: OrchestratorOptions & { deps?: Partial<BatchPipelineDeps> } = {},
): Promise<OrchestratorRun> {
  const { fake, result } = prepare(repo, options)
  const run = runWith(fake)
  result.code = await batchPipeline({
    argv,
    cwd: repo.root,
    env: orchestratorEnv(repo, options.env),
    scriptPath: 'scripts/batch-pipeline.sh',
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
    scriptsDir: repo.scriptsDir,
    ...options.deps,
  })
  result.calls = readCalls(repo)
  return result
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

const two = (value: number): string => String(value).padStart(2, '0')

/** `HH:MM:SS` local de ahora mas `offsetSeconds`. */
export function clockAt(offsetSeconds: number, base: Date = new Date()): string {
  const date = new Date(base.getTime() + offsetSeconds * 1000)
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** Anuncio de espera tal como lo escribe un pipeline en events.log. */
export function holdLine(start: string, probe: string): string {
  return `[${start}][hold] RATE_LIMIT: esperando, proxima sonda ${probe} (techo 23:59)`
}
