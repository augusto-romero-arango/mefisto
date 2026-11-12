import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import {
  branchIsMerged,
  commandClean,
  commandNew,
  isOrphanExecutionRoot,
  isProcessAlive,
  mainRootOf,
} from '../../../src/internal/scripts/mefisto-worktree.mts'
import type { WorktreeContext } from '../../../src/internal/scripts/mefisto-worktree.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-worktree.mts')
const POSIX = process.platform !== 'win32'
const USAGE = 'Uso: mefisto-worktree.mts new <slug>\n     mefisto-worktree.mts clean\n'

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
}
const savedEnv: Record<string, string | undefined> = {}

let tmp = ''
let origin = ''
let repo = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOk(cwd: string, ...args: string[]): boolean {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0
}

function commit(dir: string, file: string): void {
  writeFileSync(join(dir, file), `${file}\n`)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', file)
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function runScript(cwd: string, ...args: string[]): Run {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

function newWorktree(slug: string, cwd: string = repo): string {
  const result = runScript(cwd, 'new', slug)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trimEnd()
}

function context(overrides: Partial<WorktreeContext> = {}): WorktreeContext {
  const mainRoot = mainRootOf(repo)
  assert.ok(mainRoot !== null)
  return { mainRoot, output: new Output(), issueState: () => null, isProcessAlive, ...overrides }
}

function clean(overrides: Partial<WorktreeContext> = {}): Output {
  const ctx = context(overrides)
  assert.equal(commandClean(ctx), 0, ctx.output.stderr)
  return ctx.output
}

function samePath(a: string, b: string): boolean {
  return realpathSync.native(a) === realpathSync.native(b)
}

function branchExists(branch: string): boolean {
  return gitOk(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
}

/** Worktree al lado del repo, como los que creaban los pipelines antes de vivir en .mefisto/worktrees. */
function siblingWorktree(branch: string): string {
  const dir = join(tmp, branch)
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir, 'origin/main')
  return dir
}

function mainSnapshot(): string {
  return [git(repo, 'rev-parse', 'HEAD'), git(repo, 'symbolic-ref', '--short', 'HEAD'), git(repo, 'status', '--porcelain')].join('|')
}

before(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto-worktree-')))
  // Aisla la config del usuario: una firma obligatoria o un hooksPath global cambiarian el resultado.
  writeFileSync(join(tmp, 'gitconfig-vacio'), '')
  for (const [key, value] of Object.entries({ ...GIT_ENV, GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig-vacio') })) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
  origin = join(tmp, 'origin.git')
  repo = join(tmp, 'repo')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
  git(tmp, 'clone', '-q', origin, repo)
  spawnSync('git', ['checkout', '-q', '-b', 'main'], { cwd: repo })
  commit(repo, 'f.txt')
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  writeFileSync(join(repo, '.gitignore'), '.mefisto/\n')
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-q', '-m', 'ignore')
  git(repo, 'push', '-q', 'origin', 'main')
})

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('new', () => {
  let before0 = ''
  let featA = ''

  test('crea el worktree en su rama e imprime la ruta como unica linea de stdout', () => {
    before0 = mainSnapshot()
    const result = runScript(repo, 'new', 'feat-a')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.split('\n').length, 2)
    featA = result.stdout.trimEnd()
    assert.equal(featA, join(repo, '.mefisto', 'worktrees', 'feat-a'))
    assert.equal(git(featA, 'symbolic-ref', '--short', 'HEAD'), 'feat-a')
    assert.equal(git(featA, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'))
  })

  test('no mueve el HEAD, la rama ni el status del checkout principal', () => {
    assert.equal(mainSnapshot(), before0)
  })

  test('repetido reutiliza el worktree, tambien desde dentro de el', () => {
    assert.equal(newWorktree('feat-a'), featA)
    assert.equal(newWorktree('feat-a', featA), featA)
  })

  test('reutiliza una rama local que ya existe sin worktree', () => {
    git(repo, 'branch', 'feat-existente', 'origin/main')
    const dir = newWorktree('feat-existente')
    assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'feat-existente')
    git(repo, 'worktree', 'remove', dir)
    git(repo, 'branch', '-D', 'feat-existente')
  })

  test('rechaza un slug vacio, que empieza con guion o con caracteres fuera del juego', () => {
    const cases: Array<[string, string]> = [
      ['', `ERROR: 'new' requiere un <slug>\n${USAGE}`],
      ['-x', "ERROR: slug '-x' no puede empezar con '-'\n"],
      ['a/b', "ERROR: slug 'a/b' es invalido: solo se permiten letras, digitos, '-' y '_'\n"],
      ['a b', "ERROR: slug 'a b' es invalido: solo se permiten letras, digitos, '-' y '_'\n"],
    ]
    for (const [slug, message] of cases) {
      const ctx = context()
      assert.equal(commandNew(ctx, slug), 1)
      assert.equal(ctx.output.stderr, message)
      assert.equal(ctx.output.stdout, '')
    }
    assert.equal(runScript(repo, 'new').status, 1)
  })

  test('si el fetch falla no crea nada y lo dice', () => {
    git(repo, 'remote', 'set-url', 'origin', join(tmp, 'no-existe.git'))
    try {
      const ctx = context()
      assert.equal(commandNew(ctx, 'feat-sin-red'), 1)
      assert.ok(ctx.output.stderr.endsWith("ERROR: 'git fetch origin main' fallo; verifica la red y las credenciales\n"))
      assert.equal(ctx.output.stdout, '')
      assert.equal(existsSync(join(repo, '.mefisto', 'worktrees', 'feat-sin-red')), false)
    } finally {
      git(repo, 'remote', 'set-url', 'origin', origin)
    }
  })
})

describe('clean', () => {
  let featA = ''
  let featB = ''
  let featC = ''
  let featD = ''
  let branch0 = ''

  test('prepara: mergeada limpia, sin commits, mergeada con cambios y mergeada por squash', () => {
    branch0 = git(repo, 'symbolic-ref', '--short', 'HEAD')
    featA = join(repo, '.mefisto', 'worktrees', 'feat-a')
    commit(featA, 'a.txt')
    git(repo, 'push', '-q', 'origin', 'feat-a:main')

    featB = newWorktree('feat-b')

    featC = newWorktree('feat-c')
    git(featC, 'pull', '-q', '--rebase', 'origin', 'main')
    commit(featC, 'c.txt')
    git(featC, 'push', '-q', 'origin', 'feat-c:main')
    writeFileSync(join(featC, 'dirty.txt'), 'dirty\n')

    featD = newWorktree('feat-d')
    git(featD, 'pull', '-q', '--rebase', 'origin', 'main')
    commit(featD, 'd.txt')
    git(featD, 'push', '-q', '-u', 'origin', 'feat-d')
    git(featD, 'fetch', '-q', 'origin', 'main')
    assert.equal(gitOk(featD, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'), false)
    git(origin, 'branch', '-q', '-D', 'feat-d')
  })

  test('por linea de comandos elimina lo mergeado y limpio, y conserva lo demas con su aviso', () => {
    const result = runScript(repo, 'clean')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.split('\n').filter((line) => !line.startsWith('Conservado')), [
      `Eliminado: ${featA} (rama 'feat-a')`,
      `Eliminado: ${featD} (rama 'feat-d')`,
      'Limpieza: 2 eliminados, 2 conservados',
      '',
    ])
    assert.ok(result.stdout.includes(`Conservado (rama 'feat-b' aun no mergeada en origin/main): ${featB}\n`))
    assert.ok(
      result.stderr.includes(
        `AVISO: '${featC}' (rama 'feat-c' mergeada) tiene cambios sin commitear; se conserva:\n?? dirty.txt\n`,
      ),
    )
  })

  test('la rama mergeada y limpia pierde el worktree y la rama local', () => {
    assert.equal(existsSync(featA), false)
    assert.equal(branchExists('feat-a'), false)
  })

  test('la rama sin commits propios se conserva', () => {
    assert.equal(existsSync(featB), true)
    assert.equal(branchExists('feat-b'), true)
  })

  test('la rama mergeada con cambios sin commitear se conserva', () => {
    assert.equal(existsSync(featC), true)
    assert.equal(existsSync(join(featC, 'dirty.txt')), true)
    assert.equal(branchExists('feat-c'), true)
  })

  test('la rama mergeada por squash, con el upstream borrado, se elimina', () => {
    assert.equal(existsSync(featD), false)
    assert.equal(branchExists('feat-d'), false)
  })

  test('el checkout principal sigue en su rama y nunca se elimina', () => {
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), branch0)
    assert.equal(existsSync(join(repo, 'f.txt')), true)
  })

  test('si el fetch falla no elimina nada', () => {
    git(repo, 'remote', 'set-url', 'origin', join(tmp, 'no-existe.git'))
    try {
      const ctx = context()
      assert.equal(commandClean(ctx), 1)
      assert.ok(ctx.output.stderr.endsWith("ERROR: 'git fetch --prune origin' fallo; verifica la red y las credenciales\n"))
      assert.equal(ctx.output.stdout, '')
      assert.equal(existsSync(featB), true)
      assert.equal(existsSync(featC), true)
    } finally {
      git(repo, 'remote', 'set-url', 'origin', origin)
    }
  })
})

describe('clean recorre todos los worktrees del repo', () => {
  test('elimina el antiguo al lado del repo ya mergeado y conserva el que tiene trabajo sin mergear', () => {
    git(repo, 'fetch', '-q', 'origin', 'main')
    const merged = siblingWorktree('legacy-e')
    commit(merged, 'e.txt')
    git(merged, 'push', '-q', '-u', 'origin', 'legacy-e')
    git(origin, 'branch', '-q', '-D', 'legacy-e')
    const unmerged = siblingWorktree('legacy-f')
    commit(unmerged, 'f2.txt')

    const output = clean()
    assert.equal(existsSync(merged), false)
    assert.equal(branchExists('legacy-e'), false)
    assert.equal(existsSync(unmerged), true)
    assert.equal(branchExists('legacy-f'), true)
    assert.ok(output.stdout.includes("Conservado (rama 'legacy-f' aun no mergeada en origin/main): "))
  })

  test('elimina la raiz de batch de un proceso muerto y conserva la de uno vivo', () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    const base = join(repo, '.mefisto', 'worktrees')
    const dead = join(base, `mefisto-batch-execution-20260101-000000-${deadPid}`)
    const live = join(base, `mefisto-batch-execution-20260101-000001-${process.pid}`)
    git(repo, 'worktree', 'add', '-q', '--detach', dead, 'origin/main')
    git(repo, 'worktree', 'add', '-q', '--detach', live, 'origin/main')

    const output = clean()
    assert.equal(existsSync(dead), false)
    assert.equal(existsSync(live), true)
    assert.match(output.stdout, /^Eliminado: .*mefisto-batch-execution-20260101-000000-\d+ \(raiz de batch sin proceso vivo\)$/m)
    assert.match(output.stderr, /^AVISO: '.*mefisto-batch-execution-20260101-000001-\d+' sin rama \(HEAD desacoplado\); se conserva$/m)
    git(repo, 'worktree', 'remove', '--force', live)
  })

  test('una raiz de batch muerta se elimina aunque tenga cambios sin commitear', () => {
    const dead = join(repo, '.mefisto', 'worktrees', 'mefisto-batch-execution-20260101-000002-77')
    git(repo, 'worktree', 'add', '-q', '--detach', dead, 'origin/main')
    writeFileSync(join(dead, 'resto.txt'), 'resto\n')
    clean({ isProcessAlive: () => false })
    assert.equal(existsSync(dead), false)
  })

  test('un worktree sin rama que no es raiz de batch se conserva con aviso', () => {
    const detached = join(tmp, 'suelto')
    git(repo, 'worktree', 'add', '-q', '--detach', detached, 'origin/main')
    const output = clean({ isProcessAlive: () => false })
    assert.equal(existsSync(detached), true)
    assert.match(output.stderr, /^AVISO: '.*suelto' sin rama \(HEAD desacoplado\); se conserva$/m)
    git(repo, 'worktree', 'remove', '--force', detached)
  })

  test('un worktree mergeado que git se niega a retirar se conserva con aviso', () => {
    const locked = siblingWorktree('legacy-bloqueado')
    commit(locked, 'l.txt')
    git(locked, 'push', '-q', '-u', 'origin', 'legacy-bloqueado')
    git(origin, 'branch', '-q', '-D', 'legacy-bloqueado')
    git(repo, 'worktree', 'lock', locked)

    const output = clean()
    assert.equal(existsSync(locked), true)
    assert.equal(branchExists('legacy-bloqueado'), true)
    assert.match(output.stderr, /^AVISO: no se pudo eliminar el worktree '.*legacy-bloqueado'; se conserva$/m)

    git(repo, 'worktree', 'unlock', locked)
    clean()
    assert.equal(existsSync(locked), false)
  })

  test('el checkout principal no cambia de rama', () => {
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main')
  })
})

describe('ramas de pipeline sin trabajo, segun el estado de su issue', () => {
  const issueState = (issue: string): string | null => (issue === '901' || issue === '903' ? 'CLOSED' : issue === '902' ? 'OPEN' : null)
  let closed = ''
  let open = ''
  let withWork = ''
  let direct = ''

  test('prepara las ramas de pipeline y una sesion directa recien creada', () => {
    git(repo, 'fetch', '-q', 'origin', 'main')
    closed = siblingWorktree('worktree-mefisto-issue-901-cerrado')
    open = siblingWorktree('worktree-mefisto-issue-902-abierto')
    withWork = siblingWorktree('worktree-mefisto-issue-903-con-trabajo')
    commit(withWork, 'w.txt')
    direct = newWorktree('feat-g')
  })

  test('sin gh, o con gh fallando, no se toca ninguna', () => {
    clean({ issueState: () => null })
    assert.equal(existsSync(closed), true)
    assert.equal(existsSync(open), true)
  })

  test('elimina la del issue cerrado y conserva la del abierto', () => {
    const asked: string[] = []
    clean({
      issueState: (issue) => {
        asked.push(issue)
        return issueState(issue)
      },
    })
    assert.equal(existsSync(closed), false)
    assert.equal(branchExists('worktree-mefisto-issue-901-cerrado'), false)
    assert.equal(existsSync(open), true)
    assert.equal(branchExists('worktree-mefisto-issue-902-abierto'), true)
    // La rama con commits propios ni siquiera consulta su issue.
    assert.deepEqual(asked.sort(), ['901', '902'])
  })

  test('conserva la rama de pipeline con commits propios aunque su issue este cerrado', () => {
    assert.equal(existsSync(withWork), true)
    assert.equal(branchIsMerged(context({ issueState }), 'worktree-mefisto-issue-903-con-trabajo'), false)
  })

  test('conserva la sesion directa recien creada: el estado del issue no aplica a su rama', () => {
    assert.equal(existsSync(direct), true)
    assert.equal(branchIsMerged(context({ issueState: () => 'CLOSED' }), 'feat-g'), false)
  })
})

describe('proceso de una raiz de batch', () => {
  const orphan = (dir: string, alive: boolean): boolean =>
    isOrphanExecutionRoot({ mainRoot: '', output: new Output(), issueState: () => null, isProcessAlive: () => alive }, dir)

  test('solo es huerfana una raiz de batch con PID numerico y sin proceso', () => {
    assert.equal(orphan(join('x', 'mefisto-batch-execution-20260101-000000-123'), false), true)
    assert.equal(orphan(join('x', 'mefisto-batch-execution-20260101-000000-123'), true), false)
    assert.equal(orphan(join('x', 'mefisto-batch-execution-20260101-abc'), false), false)
    assert.equal(orphan(join('x', 'mefisto-batch-execution-'), false), false)
    assert.equal(orphan(join('x', 'otra-cosa-123'), false), false)
    assert.equal(orphan(join('mefisto-batch-execution-1-2', 'feat-123'), false), false)
  })

  test('isProcessAlive distingue un proceso vivo de uno que ya termino', () => {
    assert.equal(isProcessAlive(process.pid), true)
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    assert.equal(isProcessAlive(deadPid), false)
  })

  // Heredado de `kill -0`: un proceso vivo de otro usuario cuenta como inexistente.
  test('un proceso ajeno sin permiso de senal cuenta como inexistente', { skip: !POSIX || process.getuid?.() === 0 }, () => {
    assert.equal(isProcessAlive(1), false)
  })
})

describe('linea de comandos y shim', () => {
  test('sin subcomando valido muestra el uso y sale con 1; con --help sale con 0', () => {
    for (const [args, status] of [[[], 1], [['otro'], 1], [['-h'], 0], [['--help'], 0]] as Array<[string[], number]>) {
      const result = runScript(repo, ...args)
      assert.equal(result.status, status)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, USAGE)
    }
  })

  test('fuera de un repositorio git falla antes de mirar los argumentos', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mefisto-sin-repo-'))
    try {
      const result = spawnSync(process.execPath, [SCRIPT, '--help'], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(realpathSync.native(outside)) },
      })
      assert.equal(result.status, 1)
      assert.equal(result.stderr, 'ERROR: no se esta dentro de un repositorio git\n')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('mainRootOf resuelve el checkout principal tambien desde un worktree', () => {
    const worktree = newWorktree('feat-raiz')
    const fromWorktree = mainRootOf(worktree)
    assert.ok(fromWorktree !== null && samePath(fromWorktree, repo))
    git(repo, 'worktree', 'remove', worktree)
    git(repo, 'branch', '-D', 'feat-raiz')
  })

  test('como proceso imprime la ruta del worktree en stdout', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'new', 'feat-shim'], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${join(repo, '.mefisto', 'worktrees', 'feat-shim')}\n`)
    git(repo, 'worktree', 'remove', join(repo, '.mefisto', 'worktrees', 'feat-shim'))
    git(repo, 'branch', '-D', 'feat-shim')
  })
})
