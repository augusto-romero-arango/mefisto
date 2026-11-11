import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture } from '../lib/cli.mts'
import { cleanWorktrees } from '../worktree-clean.mts'
import type { CleanDeps } from '../worktree-clean.mts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'worktree-clean.mts')
const ISOLATED_ENV = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
]
const savedEnv = new Map(ISOLATED_ENV.map((key) => [key, process.env[key]]))

let work = ''
let repo = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Ruta del worktree como la imprime git: con `/` tambien en Windows.
function shown(branch: string): string {
  return worktree(branch).replaceAll('\\', '/')
}

function worktree(branch: string): string {
  return join(work, `wt-${branch}`)
}

function addWorktree(branch: string): void {
  git(repo, 'worktree', 'add', '-q', '--no-track', '-b', branch, worktree(branch), 'origin/main')
}

function commitIn(branch: string): void {
  writeFileSync(join(worktree(branch), `f-${branch}`), 'x\n')
  git(worktree(branch), 'add', '.')
  git(worktree(branch), 'commit', '-q', '-m', `c ${branch}`)
}

function branchExists(branch: string): boolean {
  return capture('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
}

function gone(branch: string): boolean {
  return !existsSync(worktree(branch)) && !branchExists(branch)
}

function kept(branch: string): boolean {
  return existsSync(worktree(branch)) && branchExists(branch)
}

interface Run {
  status: number
  out: string[]
  err: string[]
}

// gh simulado: `closed` son los issues cerrados; `null` es una maquina sin gh.
function clean(closed: string[] | null, ghStatus = 0): Run {
  const out: string[] = []
  const err: string[] = []
  const deps: CleanDeps = {
    cwd: repo,
    env: {},
    hasCommand: () => closed !== null,
    run: (command, args, options) => {
      if (command !== 'gh') return capture(command, args, options)
      const state = closed?.includes(args[2] ?? '') === true ? 'CLOSED' : 'OPEN'
      return { status: ghStatus, stdout: `${state}\n`, stderr: '' }
    },
    fetch: (mainRoot) => capture('git', ['-C', mainRoot, 'fetch', '--prune', 'origin']).status === 0,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  }
  return { status: cleanWorktrees(deps), out, err }
}

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto worktree clean ')))
  writeFileSync(join(work, 'gitconfig-vacio'), '')
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: join(work, 'gitconfig-vacio'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  })
  const remote = join(work, 'remote.git')
  repo = join(work, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'push', '-q', 'origin', 'main')
})

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(work, { recursive: true, force: true })
})

describe('cleanWorktrees', () => {
  let first: Run = { status: -1, out: [], err: [] }

  before(() => {
    addWorktree('merged')
    commitIn('merged')
    git(worktree('merged'), 'push', '-q', 'origin', 'HEAD:main')

    addWorktree('gone')
    commitIn('gone')
    git(worktree('gone'), 'push', '-q', '-u', 'origin', 'gone')
    git(worktree('gone'), 'push', '-q', 'origin', '--delete', 'gone')

    addWorktree('worktree-issue-100-abandonada')
    addWorktree('worktree-issue-200-enuelo')

    addWorktree('dirty')
    commitIn('dirty')
    git(worktree('dirty'), 'push', '-q', 'origin', 'HEAD:main')
    writeFileSync(join(worktree('dirty'), 'untracked'), 'y\n')

    addWorktree('unmerged')
    commitIn('unmerged')

    addWorktree('fresh')

    git(repo, 'worktree', 'add', '-q', '--detach', worktree('detached'), 'origin/main')

    first = clean(['100'])
  })

  test('termina en 0', () => {
    assert.equal(first.status, 0)
  })

  test('elimina la rama mergeada y limpia', () => {
    assert.ok(gone('merged'))
    assert.ok(first.out.includes(`Eliminado: ${shown('merged')} (rama 'merged')`))
  })

  test('elimina la rama con upstream [gone]', () => {
    assert.ok(gone('gone'))
  })

  test('elimina la rama de pipeline abandonada con el issue cerrado', () => {
    assert.ok(gone('worktree-issue-100-abandonada'))
  })

  test('conserva la rama de pipeline en vuelo (issue abierto)', () => {
    assert.ok(kept('worktree-issue-200-enuelo'))
    assert.ok(
      first.out.includes(
        `Conservado (rama 'worktree-issue-200-enuelo' aun no mergeada en origin/main): ${shown('worktree-issue-200-enuelo')}`,
      ),
    )
  })

  test('conserva con aviso la rama mergeada que tiene cambios sin commitear', () => {
    assert.ok(kept('dirty'))
    const at = first.err.indexOf(
      `AVISO: '${shown('dirty')}' (rama 'dirty' mergeada) tiene cambios sin commitear; se conserva:`,
    )
    assert.notEqual(at, -1)
    assert.equal(first.err[at + 1], '?? untracked')
  })

  test('conserva la rama sin mergear', () => {
    assert.ok(kept('unmerged'))
  })

  test('conserva la rama recien creada sin commits', () => {
    assert.ok(kept('fresh'))
  })

  test('conserva con aviso el worktree desacoplado', () => {
    assert.ok(existsSync(worktree('detached')))
    assert.ok(first.err.includes(`AVISO: '${shown('detached')}' sin rama (HEAD desacoplado); se conserva`))
  })

  test('cierra con el resumen', () => {
    assert.equal(first.out.at(-1), 'Limpieza: 3 eliminados, 5 conservados')
  })

  test('sin gh, o si gh falla, la rama de pipeline abandonada se conserva', () => {
    addWorktree('worktree-issue-100-sin-gh')
    assert.equal(clean(null).out.at(-1), 'Limpieza: 0 eliminados, 6 conservados')
    assert.ok(kept('worktree-issue-100-sin-gh'))
    assert.equal(clean(['100'], 1).out.at(-1), 'Limpieza: 0 eliminados, 6 conservados')
    assert.ok(kept('worktree-issue-100-sin-gh'))
  })
})

describe('linea de comando', () => {
  function run(cwd: string, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  }

  test('sin worktrees que limpiar imprime el resumen en ceros', () => {
    const solo = join(work, 'solo')
    execFileSync('git', ['clone', '-q', join(work, 'remote.git'), solo])
    const result = run(solo)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'Limpieza: 0 eliminados, 0 conservados\n')
  })

  test('si el fetch falla termina en 1 sin tocar nada', () => {
    const sinRemoto = join(work, 'sin-remoto')
    execFileSync('git', ['init', '-q', '-b', 'main', sinRemoto])
    const result = run(sinRemoto)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /ERROR: 'git fetch --prune origin' fallo; verifica la red y las credenciales\n$/)
  })

  test('fuera de un repo git termina en 1', () => {
    const outside = join(work, 'sin repo')
    mkdirSync(outside)
    const result = run(outside, { GIT_CEILING_DIRECTORIES: work })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: no estas dentro de un repositorio git\n')
  })
})
