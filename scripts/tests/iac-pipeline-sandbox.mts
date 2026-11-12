// Consumidor de usar y tirar para correr `iac-pipeline.mts` de extremo a extremo: repo con remoto
// bare y `infra/environments/dev`, `gh` y `terraform` inyectados, reloj falso y el agente
// guionado del sandbox de tooling. Nada toca GitHub, Azure ni este repo.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../lib/azure-cli.mts'
import { capture } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'
import { loggedThrough } from '../lib/pipeline/pipeline-log.mts'
import { iacPipeline } from '../iac-pipeline.mts'
import type { IacPipelineDeps } from '../iac-pipeline.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { fakeClock, newConsumer, pipelineEnv } from './tooling-pipeline-sandbox.mts'
import type { Consumer } from './tooling-pipeline-sandbox.mts'

export const FIXTURES = join(import.meta.dirname, 'fixtures', 'iac-pipeline')
export const TITLE = 'Crear storage de reportes'
export const BRANCH = 'infra-issue-42-crear-storage-de-reportes'

/** Consumidor con `infra/environments/dev` versionado y el estado del pipeline ignorado. */
export function newIacConsumer(dir: string, files: Record<string, string> = {}): Consumer {
  return newConsumer(dir, { 'infra/environments/dev/main.tf': '# base\n', ...files })
}

export interface FakeIac {
  /** Respuesta de `gh issue view` del issue principal; `null` hace fallar a `gh`. */
  issue: string | null
  /** Respuesta de `gh issue view <N>` y `gh pr view <N>` de cada dependencia; sin entrada, `gh` falla. */
  issues: Record<string, string>
  prs: Record<string, string>
  openPr: string | null
  createdPr: string | null
  /** Subcomandos de `gh` que fallan (`issue edit`, `issue comment`). */
  failing: string[]
  /** Codigo de `terraform init` y de `terraform validate` en cada gate, en orden. */
  terraform: { init: number[]; validate: number[] }
  gh: string[][]
  terraformCalls: { args: string[]; cwd: string }[]
  /** Comandos que se pidieron a `run`, para ver que nunca se invoca `az`. */
  commands: string[]
}

export function issueJson(fields: { title?: string; body?: string; state?: string; labels?: unknown } = {}): string {
  return JSON.stringify({
    body: fields.body ?? 'Cuerpo del issue.',
    labels: fields.labels ?? [],
    number: 42,
    state: fields.state ?? 'OPEN',
    title: fields.title ?? TITLE,
  })
}

export function fakeIac(overrides: Partial<FakeIac> = {}): FakeIac {
  return {
    issue: issueJson(),
    issues: {},
    prs: {},
    openPr: null,
    createdPr: 'https://github.com/acme/consumidor/pull/7',
    failing: [],
    terraform: { init: [], validate: [] },
    gh: [],
    terraformCalls: [],
    commands: [],
    ...overrides,
  }
}

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

function gh(tools: FakeIac, args: string[]): CommandResult {
  tools.gh.push(args)
  const command = args.slice(0, 2).join(' ')
  if (tools.failing.includes(command)) return done(1, '', `gh: ${command} fallo\n`)
  if (command === 'issue view') {
    const number = args[2] ?? ''
    if (number === '42') return tools.issue === null ? done(1, '', 'GraphQL: Could not resolve to an Issue\n') : done(0, `${tools.issue}\n`)
    const dependency = tools.issues[number]
    return dependency === undefined ? done(1, '', 'no existe\n') : done(0, `${dependency}\n`)
  }
  if (command === 'pr view') {
    const dependency = tools.prs[args[2] ?? '']
    return dependency === undefined ? done(1, '', 'no existe\n') : done(0, `${dependency}\n`)
  }
  if (command === 'pr list') return done(0, `${JSON.stringify(tools.openPr === null ? [] : [{ url: tools.openPr }])}\n`)
  if (command === 'pr create') return tools.createdPr === null ? done(1, '', 'pull request create failed\n') : done(0, `${tools.createdPr}\n`)
  return done(0)
}

/** `run` de los tests: `gh` y `terraform` son dobles; `git` es el real. */
export function iacRun(tools: FakeIac): Run {
  return (command, args, options) => {
    tools.commands.push(command)
    if (command === 'gh') return gh(tools, args)
    if (command === 'terraform') {
      tools.terraformCalls.push({ args, cwd: options?.cwd ?? '' })
      const queue = args[0] === 'init' ? tools.terraform.init : tools.terraform.validate
      const status = queue.shift() ?? 0
      return done(status, `terraform ${args.join(' ')}\n`, status === 0 ? '' : `Error: terraform ${args[0]} roto\n`)
    }
    return capture(command, args, options)
  }
}

export interface IacRun {
  code: number
  out: string
  err: string
  tools: FakeIac
  /** Comandos que se preguntaron a `hasCommand`. */
  asked: string[]
}

export interface IacRunOptions {
  tools?: FakeIac
  env?: NodeJS.ProcessEnv
  guion?: GuionStep[]
  /** Directorio desde el que se lanza; por defecto, la raiz del consumidor. */
  cwd?: string
  deps?: Partial<IacPipelineDeps>
}

/** Corre el pipeline en proceso, con el runner real como hijo y el agente guionado. */
export async function runIac(consumer: Consumer, argv: string[], options: IacRunOptions = {}): Promise<IacRun> {
  const tools = options.tools ?? fakeIac()
  if (options.guion !== undefined) {
    writeFileSync(consumer.guionFile, JSON.stringify(options.guion))
    writeFileSync(`${consumer.guionFile}.n`, '0')
  }
  let out = ''
  let err = ''
  const asked: string[] = []
  const run = iacRun(tools)
  const clock = fakeClock()
  const code = await iacPipeline({
    argv,
    cwd: options.cwd ?? consumer.root,
    env: pipelineEnv(consumer, options.env),
    scriptPath: 'scripts/iac-pipeline.mts',
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    run,
    runLogged: loggedThrough(run),
    hasCommand: (command) => {
      asked.push(command)
      return true
    },
    now: clock.now,
    sleep: clock.sleep,
    ...options.deps,
  })
  return { code, out, err, tools, asked }
}

/** Resumen que deja un agente en el worktree, donde el pipeline lo recoge para el PR. */
export function summaryFile(stage: '1' | '2', agent: 'infra-writer' | 'infra-reviewer', text: string): Record<string, string> {
  return { [`.mefisto/pipeline/summaries/stage-${stage}-${agent}.md`]: text }
}

export function statusOf(consumer: Consumer, issue = '42'): Record<string, unknown> | null {
  const file = join(consumer.stateDir, `pipeline-status-infra-${issue}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null
}
