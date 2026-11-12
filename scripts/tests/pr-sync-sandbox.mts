// Consumidor de usar y tirar para correr `pr-sync.mts` de extremo a extremo: repo con remoto bare
// donde viven main y las ramas de los PRs, `gh` y `dotnet` simulados y el agente en proceso o
// guionado. Nada toca GitHub ni este repo.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../lib/azure-cli.mts'
import { capture } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'
import { appendText, loggedThrough } from '../lib/pipeline/pipeline-log.mts'
import type { LoggedRun } from '../lib/pipeline/pipeline-log.mts'
import type { DotnetResult } from '../lib/pipeline/test-results.mts'
import { prSync } from '../pr-sync.mts'
import type { PrSyncDeps } from '../pr-sync.mts'
import { git, writeFiles } from './field-note-sandbox.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { fakeClock, newConsumer, pipelineEnv, runnerDouble } from './tooling-pipeline-sandbox.mts'
import type { Consumer, RunnerDouble } from './tooling-pipeline-sandbox.mts'

export const FIXTURES = join(import.meta.dirname, 'fixtures', 'pr-sync')

/** Proyecto de tests que `pr-sync` encuentra con el `namespacePrefix` del config de prueba. */
export const TEST_PROJECT = 'tests/Empresa.Proyecto.Ventas.Tests'

/** Consumidor con un proyecto `*.Tests` y un `*.SmokeTests`, y `main` empujado al remoto bare. */
export function syncConsumer(dir: string, files: Record<string, string> = {}): Consumer {
  return newConsumer(dir, {
    [`${TEST_PROJECT}/Ventas.Tests.csproj`]: '<Project />\n',
    'tests/Empresa.Proyecto.Ventas.SmokeTests/Ventas.SmokeTests.csproj': '<Project />\n',
    ...files,
  })
}

/** Rama de un PR en el remoto, nacida del `main` actual; el checkout principal vuelve a `main`. */
export function openPrBranch(repo: Consumer, branch: string, files: Record<string, string>): void {
  git(repo.root, 'checkout', '-q', '-b', branch)
  writeFiles(repo.root, files)
  git(repo.root, 'add', '.')
  git(repo.root, 'commit', '-q', '-m', `trabajo de ${branch}`)
  git(repo.root, 'push', '-q', 'origin', branch)
  git(repo.root, 'checkout', '-q', 'main')
  git(repo.root, 'branch', '-q', '-D', branch)
}

/** Commit nuevo en `main`, empujado al remoto. */
export function advanceMain(repo: Consumer, files: Record<string, string>): void {
  writeFiles(repo.root, files)
  git(repo.root, 'add', '.')
  git(repo.root, 'commit', '-q', '-m', 'avance de main')
  git(repo.root, 'push', '-q', 'origin', 'main')
}

export interface FakePr {
  state: string
  title: string
  branch: string
  body?: string
  /** `mergeStateStatus` de cada consulta; la ultima se repite. */
  mergeStates?: string[]
  /** Resultado de `gh pr merge`; por defecto mergea. */
  merge?: CommandResult
}

export interface FakeGithub {
  prs: Record<string, FakePr>
  /** Salida de `gh pr list ... -q '.[].number'`. */
  openList: string
  /** Salida de `gh api repos/{owner}/{repo}`. */
  methods: string
  /** Salida de `gh issue list --label bloqueado`; `null` hace fallar a `gh`. */
  blocked: string | null
  /** `state` de `gh issue view` por numero; sin entrada, `gh` falla. */
  issueStates: Record<string, string>
  /** Codigo de `gh issue edit`. */
  editStatus: number
  /** Subcomandos (`issue list`) que lanzan una excepcion: un fallo que no es de `gh`. */
  throwing: string[]
  calls: string[][]
}

export function fakeGithub(overrides: Partial<FakeGithub> = {}): FakeGithub {
  return {
    prs: {},
    openList: '',
    methods: 'merge squash rebase\n',
    blocked: '[]\n',
    issueStates: {},
    editStatus: 0,
    throwing: [],
    calls: [],
    ...overrides,
  }
}

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

const flagOf = (args: string[], name: string): string => {
  const index = args.indexOf(name)
  return index === -1 ? '' : (args[index + 1] ?? '')
}

function gh(fake: FakeGithub, args: string[]): CommandResult {
  fake.calls.push(args)
  const command = args.slice(0, 2).join(' ')
  if (fake.throwing.includes(command)) throw new Error(`gh: ${command} exploto`)
  const number = args[2] ?? ''
  const pr = fake.prs[number]
  const json = flagOf(args, '--json')
  if (command === 'pr list') return done(0, fake.openList)
  if (args[0] === 'api') return done(0, fake.methods)
  if (command === 'pr view') {
    if (json === 'state' && pr === undefined) {
      const state = fake.issueStates[`pr:${number}`]
      return state === undefined ? done(1, '', 'no pull requests found\n') : done(0, `${state}\n`)
    }
    if (pr === undefined) return done(1, '', `no pull requests found for ${number}\n`)
    if (json === 'state,title') return done(0, `${JSON.stringify({ state: pr.state, title: pr.title })}\n`)
    if (json === 'headRefName') return done(0, `${pr.branch}\n`)
    if (json === 'body') return done(0, `${pr.body ?? ''}\n`)
    if (json === 'state') return done(0, `${pr.state}\n`)
    if (json === 'state,mergeStateStatus') {
      const states = pr.mergeStates ?? ['CLEAN']
      const current = states.length > 1 ? (states.shift() ?? 'CLEAN') : (states[0] ?? 'CLEAN')
      return done(0, `${JSON.stringify({ state: pr.state, mergeStateStatus: current })}\n`)
    }
  }
  if (command === 'pr merge' && pr !== undefined) {
    const result = pr.merge ?? done(0, `Merged pull request #${number}\n`)
    if (result.status === 0) pr.state = 'MERGED'
    return result
  }
  if (command === 'issue list') return fake.blocked === null ? done(1, '', 'gh: issue list fallo\n') : done(0, fake.blocked)
  if (command === 'issue view') {
    const state = fake.issueStates[number]
    return state === undefined ? done(1, '', 'issue no encontrado\n') : done(0, `${state}\n`)
  }
  if (command === 'issue edit') return done(fake.editStatus, '', fake.editStatus === 0 ? '' : 'no se pudo editar\n')
  return done(1, '', `gh simulado: ${args.join(' ')} sin respuesta\n`)
}

export interface FakeDotnet {
  /** Resultado de cada `dotnet build`; el ultimo se repite. */
  builds: DotnetResult[]
  /** Resultado de cada `dotnet test` de un proyecto; el ultimo se repite. */
  tests: DotnetResult[]
  calls: string[][]
}

export const TESTS_PASS: DotnetResult = { status: 0, output: 'Passed!  - Failed: 0, Passed: 3, Skipped: 0, Total: 3\n' }
export const TESTS_FAIL: DotnetResult = {
  status: 1,
  output: '  Failed Ventas.Tests.PedidoTests.Crear [12 ms]\nFailed!  - Failed: 1, Passed: 2, Skipped: 0, Total: 3\n',
}

export function fakeDotnet(overrides: Partial<FakeDotnet> = {}): FakeDotnet {
  return { builds: [{ status: 0, output: 'Build succeeded.\n' }], tests: [TESTS_PASS], calls: [], ...overrides }
}

function next(queue: DotnetResult[]): DotnetResult {
  return (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 0, output: '' }
}

export interface SyncRun {
  code: number
  out: string
  err: string
  github: FakeGithub
  dotnet: FakeDotnet
  runner: RunnerDouble
  /** Codigos devueltos a cada lanzamiento de `worktree-clean.mts`. */
  cleanups: number
  /** argv de cada comando que fue al log. */
  logged: string[][]
  /** Donde nacieron los worktrees temporales y los temporales de la corrida. */
  tempRoot: string
}

export interface SyncOptions {
  github?: FakeGithub
  dotnet?: FakeDotnet
  env?: NodeJS.ProcessEnv
  /** Pasos del agente en proceso. */
  steps?: GuionStep[]
  /** Guion del agente que lanza el runner real; sustituye a `steps`. */
  guion?: GuionStep[]
  /** Codigo de `worktree-clean.mts`. */
  cleanStatus?: number
  /** Comandos al log que fallan con el codigo dado. */
  failLogged?: (command: string, args: string[]) => number | null | undefined
  deps?: Partial<PrSyncDeps>
}

/** Corre pr-sync en proceso sobre el consumidor, con los temporales dentro de `scratchRoot`. */
export async function runPrSync(repo: Consumer, scratchRoot: string, argv: string[], options: SyncOptions = {}): Promise<SyncRun> {
  const github = options.github ?? fakeGithub()
  const dotnet = options.dotnet ?? fakeDotnet()
  const runner = runnerDouble(options.steps ?? [])
  if (options.guion !== undefined) {
    writeFileSync(repo.guionFile, JSON.stringify(options.guion))
    writeFileSync(`${repo.guionFile}.n`, '0')
  }
  const tempRoot = mkdtempSync(join(scratchRoot, 'temporales-'))
  const result: SyncRun = { code: -1, out: '', err: '', github, dotnet, runner, cleanups: 0, logged: [], tempRoot }
  const run: Run = (command, args, given) => (command === 'gh' ? gh(github, args) : capture(command, args, given))
  const throughRun = loggedThrough(run)
  const runLogged: LoggedRun = (command, args, logFile, given) => {
    result.logged.push([command, ...args])
    if (command === process.execPath && (args[0] ?? '').endsWith('worktree-clean.mts')) {
      result.cleanups++
      appendText(logFile, 'worktree-clean simulado\n')
      return options.cleanStatus ?? 0
    }
    const failure = options.failLogged?.(command, args)
    if (failure !== undefined) return failure
    return throughRun(command, args, logFile, given)
  }
  const clock = fakeClock()
  result.code = await prSync({
    argv,
    cwd: repo.root,
    env: pipelineEnv(repo, options.env),
    scriptPath: 'scripts/pr-sync.sh',
    out: (text) => {
      result.out += text
    },
    err: (text) => {
      result.err += text
    },
    run,
    runLogged,
    runDotnet: (args) => {
      dotnet.calls.push(args)
      return next(args[0] === 'build' ? dotnet.builds : dotnet.tests)
    },
    hasCommand: () => true,
    now: clock.now,
    sleep: clock.sleep,
    tempRoot,
    ...(options.guion === undefined ? { launchRunner: runner.launch } : {}),
    ...options.deps,
  })
  return result
}
