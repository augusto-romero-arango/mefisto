// Repos git temporales y un `gh` simulado para los tests de la entrega de field notes.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { capture } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'
import type { Tools } from '../lib/field-note.mts'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(
    /\n+$/,
    '',
  )
}

export function gitOk(cwd: string, ...args: string[]): boolean {
  return capture('git', args, { cwd }).status === 0
}

/**
 * Aisla la config global y de sistema de git: una firma de commits o un `core.hooksPath` del
 * usuario cambiarian el resultado. Devuelve la funcion que restaura el entorno.
 */
export function isolateGitConfig(dir: string): () => void {
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  }
  const isolated = join(dir, 'gitconfig-aislado')
  // Sin mantenimiento automatico: corre desacoplado y borra objetos mientras un test copia el repo.
  writeFileSync(isolated, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n')
  process.env.GIT_CONFIG_GLOBAL = isolated
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export interface Sandbox {
  /** Checkout principal, en `main`. */
  main: string
  /** Remoto bare, con `main` ya empujado. */
  bare: string
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, ...file.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

export function newRepo(dir: string, files: Record<string, string>): Sandbox {
  const main = join(dir, 'main-checkout')
  const bare = join(dir, 'origin.git')
  mkdirSync(main, { recursive: true })
  git(main, 'init', '-q')
  git(main, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(main, 'config', 'user.email', 'test@mefisto.local')
  git(main, 'config', 'user.name', 'Mefisto Test')
  writeFiles(main, files)
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'base')
  git(dir, 'init', '-q', '--bare', bare)
  git(main, 'remote', 'add', 'origin', bare)
  git(main, 'push', '-q', 'origin', 'main')
  return { main, bare }
}

/** Deja `branch` commiteada y empujada con `content` en `rel`, como una entrega de una sesion previa. */
export function deliverByHand(
  sandbox: Sandbox,
  scratch: string,
  branch: string,
  rel: string,
  content: string,
): void {
  git(sandbox.main, 'worktree', 'add', '-q', '-b', branch, scratch, 'origin/main')
  writeFiles(scratch, { [rel]: content })
  git(scratch, 'add', '--', rel)
  git(scratch, 'commit', '-q', '-m', 'docs(bitacora): entrega previa')
  git(scratch, 'push', '-q', '-u', 'origin', branch)
  git(sandbox.main, 'worktree', 'remove', scratch)
}

export interface CheckoutState {
  ref: string
  sha: string
  status: string
}

export function checkoutState(main: string): CheckoutState {
  return {
    ref: git(main, 'symbolic-ref', '-q', '--short', 'HEAD'),
    sha: git(main, 'rev-parse', 'HEAD'),
    status: git(main, 'status', '--porcelain=v1', '--untracked-files=all'),
  }
}

export interface FakePr {
  number: number
  url: string
  state: string
  mergedAt: string | null
  head: string
  base: string
  createdAt?: string
}

const REPO_VIEW_FLAGS = ['-b', '--branch', '--json', '-q', '--jq', '-t', '--template', '-w', '--web', '-h', '--help']

function done(status: number, stdout = '', stderr = ''): CommandResult {
  return { status, stdout, stderr }
}

/**
 * `gh` con un almacen de PRs que `pr list`, `pr create` y `pr reopen` leen y mutan. Escribe ruido
 * en stderr tambien cuando tiene exito, como el real, y rechaza en `repo view` los flags que el
 * real no acepta (`--repo`: el repositorio va posicional).
 */
export class FakeGh {
  readonly slug: string
  readonly calls: string[][] = []
  readonly prs: FakePr[] = []
  /** Subcomandos (`pr create`) que fallan: siempre o solo la proxima vez. */
  readonly failing = new Map<string, 'always' | 'once'>()

  constructor(slug: string) {
    this.slug = slug
  }

  /** Llamadas cuyo subcomando es `subcommand`, p. ej. `pr create`. */
  callsTo(subcommand: string): string[][] {
    return this.calls.filter((call) => `${call[0] ?? ''} ${call[1] ?? ''}` === subcommand)
  }

  run(args: string[]): CommandResult {
    this.calls.push(args)
    const subcommand = `${args[0] ?? ''} ${args[1] ?? ''}`
    const failure = this.failing.get(subcommand)
    if (failure !== undefined) {
      if (failure === 'once') this.failing.delete(subcommand)
      return done(1, '', `gh: fallo simulado en ${subcommand}\n`)
    }
    const option = (name: string): string => args[args.indexOf(name) + 1] ?? ''

    if (subcommand === 'repo view') {
      for (const arg of args.slice(2)) {
        const flag = arg.split('=')[0] ?? ''
        if (flag.startsWith('-') && !REPO_VIEW_FLAGS.includes(flag)) {
          return done(1, '', `unknown flag: ${flag}\nUsage:  gh repo view [<repository>] [flags]\n`)
        }
      }
      if (args.some((arg) => arg.includes('nameWithOwner'))) return done(0, `${this.slug}\n`)
      if (args.some((arg) => arg.includes('defaultBranchRef'))) {
        return done(0, 'main\n', 'aviso de gh: hay una version mas nueva disponible\n')
      }
      return done(1)
    }

    if (subcommand === 'pr list') {
      const rows = this.prs
        .filter((pr) => pr.head === option('--head') && pr.base === option('--base'))
        .map(({ number, url, state, mergedAt, createdAt }) => ({ number, url, state, mergedAt, createdAt }))
      return done(0, `${JSON.stringify(rows)}\n`)
    }

    if (subcommand === 'pr create') {
      const head = option('--head')
      const base = option('--base')
      const number = this.prs.length + 1
      const url = `https://github.com/${this.slug}/pull/${number}`
      this.prs.push({ number, url, state: 'OPEN', mergedAt: null, head, base, createdAt: '9999-12-31T23:59:59Z' })
      return done(0, `${url}\n`, `Creating pull request for ${head} into ${base} in ${this.slug}\n`)
    }

    if (subcommand === 'pr reopen') {
      const pr = this.prs.find((row) => args.includes(row.url) || args[2] === String(row.number))
      if (pr === undefined) return done(1, '', 'gh: no existe ese PR\n')
      pr.state = 'OPEN'
      pr.mergedAt = null
      return done(0, '', `Reopened pull request #${pr.number}\n`)
    }

    return done(1)
  }
}

export interface RecordingTools extends Tools {
  stdout: string
  stderr: string
  /** Cada comando corrido, con el programa en la primera posicion. */
  commands: string[][]
}

export interface SandboxToolsOptions {
  /** Programas que `has` reporta ausentes del PATH. */
  missing?: string[]
  /** Responde por un programa en lugar de ejecutarlo; `undefined` lo deja correr. */
  intercept?: (command: string, args: string[]) => CommandResult | undefined
}

/** `Tools` con `gh` simulado, `git` real y la salida acumulada en memoria. */
export function sandboxTools(gh: FakeGh, options: SandboxToolsOptions = {}): RecordingTools {
  const tools: RecordingTools = {
    stdout: '',
    stderr: '',
    commands: [],
    run(command, args, cwd) {
      tools.commands.push([command, ...args])
      if (command === 'gh') return gh.run(args)
      return options.intercept?.(command, args) ?? capture(command, args, { cwd })
    },
    has: (command) => options.missing?.includes(command) !== true,
    out(text) {
      tools.stdout += text
    },
    err(text) {
      tools.stderr += text
    },
  }
  return tools
}

/** Comandos de git que mutan el checkout `root`: la entrega no debe correr ninguno. */
export function mutationsOf(tools: RecordingTools, root: string): string[][] {
  const mutating = ['switch', 'checkout', 'add', 'commit', 'reset', 'merge', 'stash']
  return tools.commands.filter(
    (command) => command[0] === 'git' && command[1] === '-C' && command[2] === root && mutating.includes(command[3] ?? ''),
  )
}
