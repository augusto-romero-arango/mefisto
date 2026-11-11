// Consumidores git temporales, un cache de plugins y un `claude` simulado para los tests del
// ciclo de vida del plugin. Nada toca la configuracion real de Claude Code.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CommandResult } from '../lib/cli.mts'
import type { Json, Run } from '../lib/plugin-scopes.mts'

const IDENTITY = ['-c', 'user.email=t@t', '-c', 'user.name=t']

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n+$/, '')
}

/** Repo git con un commit inicial vacio. */
export function newRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet', '.')
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'init')
  return dir
}

/** Commitea `content` como `.claude/settings.json` del repo. */
export function commitSettings(repo: string, content: Json): void {
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'settings.json'), `${JSON.stringify(content)}\n`)
  git(repo, 'add', '--force', '.claude/settings.json')
  git(repo, 'commit', '--quiet', '-m', 'settings')
}

export function writeJson(path: string, content: Json): void {
  writeFileSync(path, `${JSON.stringify(content)}\n`)
}

export function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' }
}

export function failed(stderr = '', status = 1): CommandResult {
  return { status, stdout: '', stderr }
}

export interface FakeClaude {
  run: Run
  /** Argumentos de cada llamada a `claude`, unidos por espacios; sin las de `plugin list`. */
  log: string[]
}

export interface FakeClaudeOptions {
  /** Carpeta de configuracion donde `plugin disable` deja `enabledPlugins` en false. */
  configDir?: string
  /** Lo que devuelve `plugin list --json`; sin el, ese subcomando falla. */
  list?: () => Json
  /** Respuesta de una llamada concreta; `undefined` deja la respuesta por defecto. */
  respond?: (args: string[]) => CommandResult | undefined
}

export function fakeClaude(options: FakeClaudeOptions = {}): FakeClaude {
  const log: string[] = []
  const run: Run = (command, args) => {
    if (command !== 'claude') return { status: null, stdout: '', stderr: '' }
    const [first, second, third] = args
    if (first === 'plugin' && second === 'list') {
      return options.list === undefined ? failed() : ok(JSON.stringify(options.list()))
    }
    log.push(args.join(' '))
    const response = options.respond?.(args)
    if (response !== undefined) return response
    if (first === 'plugin' && second === 'disable' && options.configDir !== undefined && third !== undefined) {
      const file = join(options.configDir, 'settings.json')
      const settings = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Json>) : {}
      const plugins = (settings.enabledPlugins ?? {}) as Record<string, Json>
      writeJson(file, { ...settings, enabledPlugins: { ...plugins, [third]: false } })
    }
    return ok()
  }
  return { run, log }
}

/** Salida de un script: `out` y `err` por separado y `all` en el orden en que se escribieron. */
export class Captured {
  out: string[] = []
  err: string[] = []
  all: string[] = []

  readonly writeOut = (line: string): void => {
    this.out.push(line)
    this.all.push(line)
  }

  readonly writeErr = (line: string): void => {
    this.err.push(line)
    this.all.push(line)
  }

  /** Todo lo escrito, como lo veria un `2>&1`. */
  get text(): string {
    return this.all.join('\n')
  }

  /** Las lineas de `text`, tambien las de una escritura de varias lineas. */
  get lines(): string[] {
    return this.text.split('\n')
  }

  get errLines(): string[] {
    return this.err.join('\n').split('\n')
  }
}
