import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import type { Gh } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import {
  deliver,
  isMerged,
  latestPullRequest,
  parseArguments,
  parsePullRequests,
  prepare,
} from '../../../src/internal/scripts/mefisto-bitacora-worktree.mts'
import type { BitacoraContext } from '../../../src/internal/scripts/mefisto-bitacora-worktree.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-bitacora-worktree.mts')
const CANONICAL_SHIM = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-bitacora-worktree.sh')
const STABLE_SHIM = join(REPO_ROOT, '.claude', 'scripts', 'mefisto-bitacora-worktree.sh')
const POSIX = process.platform !== 'win32'
const FECHA = '2026-10-08'
const BRANCH = `docs/bitacora-hasta-${FECHA}`
const SLUG = 'acme/mefisto-fake'
const USAGE = [
  'Uso:',
  '  mefisto-bitacora-worktree.sh prepare --fecha <YYYY-MM-DD>',
  '  mefisto-bitacora-worktree.sh deliver --worktree <ruta>',
].join('\n')

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Mefisto Test',
  GIT_AUTHOR_EMAIL: 't@mefisto.local',
  GIT_COMMITTER_NAME: 'Mefisto Test',
  GIT_COMMITTER_EMAIL: 't@mefisto.local',
  GIT_CONFIG_NOSYSTEM: '1',
}
const savedEnv: Record<string, string | undefined> = {}

interface FakePr {
  number: number
  url: string
  state: string
  mergedAt: string | null
  createdAt: string
}

let tmp = ''
let main = ''
let bare = ''
let store: FakePr[] = []
let calls: string[] = []
let ghFailure: string | null = null

const gh: Gh = (args) => {
  calls.push(args.join(' '))
  const [resource, action] = args
  const done = (stdout: string, stderr = ''): CommandResult => ({ status: 0, stdout, stderr })
  if (ghFailure !== null && `${resource} ${action}` === ghFailure) return { status: 1, stdout: '', stderr: 'gh: fallo\n' }
  if (resource === 'pr' && action === 'list') return done(`${JSON.stringify(store)}\n`)
  if (resource === 'pr' && action === 'create') {
    const number = store.length + 77
    const url = `https://github.com/${SLUG}/pull/${number}`
    store.push({ number, url, state: 'OPEN', mergedAt: null, createdAt: `2026-10-08T00:00:${String(number).slice(0, 2)}Z` })
    return done(`${url}\n`, 'creating...\n')
  }
  if (resource === 'pr' && action === 'reopen') {
    for (const pr of store) if (pr.state === 'CLOSED') pr.state = 'OPEN'
    return done('')
  }
  return { status: 1, stdout: '', stderr: '' }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

interface Outcome {
  status: number
  stdout: string
  stderr: string
}

function context(output: Output): BitacoraContext {
  return { root: main, repoSlug: SLUG, gh, output }
}

function runPrepare(fecha: string = FECHA): Outcome {
  const output = new Output()
  const status = prepare(context(output), fecha)
  return { status, stdout: output.stdout, stderr: output.stderr }
}

function runDeliver(worktree: string): Outcome {
  const output = new Output()
  const status = deliver(context(output), worktree)
  return { status, stdout: output.stdout, stderr: output.stderr }
}

function prepared(fecha: string = FECHA): string {
  const result = runPrepare(fecha)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.split('\n').length, 2, 'la ruta es la unica linea de stdout')
  return result.stdout.trimEnd()
}

function snapshot(): string {
  return [
    git(main, 'symbolic-ref', '-q', '--short', 'HEAD'),
    git(main, 'rev-parse', 'HEAD'),
    git(main, 'status', '--porcelain=v1', '--untracked-files=all'),
  ].join('|')
}

function createCalls(): number {
  return calls.filter((call) => call.startsWith('pr create')).length
}

function setState(number: number, state: string, mergedAt: string | null): void {
  for (const pr of store) {
    if (pr.number !== number) continue
    pr.state = state
    pr.mergedAt = mergedAt
  }
}

function remoteCommits(): string {
  return git(bare, 'rev-list', '--count', `main..${BRANCH}`)
}

before(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto-bitacora-')))
  // Aisla la config del usuario: una firma obligatoria o un hooksPath global cambiarian el resultado.
  writeFileSync(join(tmp, 'gitconfig-vacio'), '')
  for (const [key, value] of Object.entries({ ...GIT_ENV, GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig-vacio') })) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
  main = join(tmp, 'main-checkout')
  bare = join(tmp, 'origin.git')
  mkdirSync(join(main, '.claude-plugin'), { recursive: true })
  mkdirSync(join(main, 'docs', 'bitacora', 'field-notes'), { recursive: true })
  git(tmp, 'init', '-q', main)
  git(main, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(main, '.claude-plugin', 'plugin.json'), '{"name":"mefisto","version":"0.0.0"}\n')
  writeFileSync(join(main, '.gitignore'), '.mefisto/\n')
  writeFileSync(join(main, 'docs', 'bitacora', 'field-notes', '2026-10-08-1000-mefisto-planner.md'), 'nota\n')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'base')
  git(tmp, 'init', '-q', '--bare', bare)
  git(main, 'remote', 'add', 'origin', bare)
  git(main, 'push', '-q', 'origin', 'main')
  writeFileSync(join(main, 'untracked.txt'), 'sucio\n')
})

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('entrega de la bitacora en un worktree aislado', () => {
  let before0 = ''
  let first = ''
  let commits1 = ''
  let redelivered = ''

  test('[A] prepare crea el worktree de la rama bajo .mefisto/pipeline/summaries', () => {
    before0 = snapshot()
    first = prepared()
    assert.equal(statSync(first).isDirectory(), true)
    assert.equal(git(first, 'symbolic-ref', '--short', 'HEAD'), BRANCH)
    assert.equal(first, join(main, '.mefisto', 'pipeline', 'summaries', `bitacora-${FECHA}`))
  })

  test('prepare repetido reutiliza el worktree y lo avisa en stderr', () => {
    const again = runPrepare()
    assert.equal(again.status, 0)
    assert.equal(again.stdout, `${first}\n`)
    assert.ok(again.stderr.endsWith(`Worktree existente reutilizado: ${first}\n`))
  })

  test("[A][B] deliver commitea, empuja, crea el PR, imprime 'PR #<n>' y elimina el worktree limpio", () => {
    writeFileSync(join(first, 'docs', 'bitacora', `${FECHA}.md`), '# entrada\n')
    mkdirSync(join(first, 'docs', 'bitacora', 'field-notes', 'procesadas'), { recursive: true })
    git(
      first,
      'mv',
      'docs/bitacora/field-notes/2026-10-08-1000-mefisto-planner.md',
      'docs/bitacora/field-notes/procesadas/',
    )
    const result = runDeliver(first)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'PR #77\n')
    assert.ok(result.stderr.endsWith('creating...\n'))
    assert.equal(existsSync(first), false)
    assert.equal(snapshot(), before0)
    assert.equal(git(bare, 'log', '-1', '--format=%s', BRANCH), `docs(bitacora): entradas hasta el ${FECHA}`)
    commits1 = remoteCommits()
    assert.equal(commits1, '1')
    const create = calls.find((call) => call.startsWith('pr create')) ?? ''
    assert.equal(
      create,
      `pr create --repo ${SLUG} --base main --head ${BRANCH} --title docs(bitacora): entradas hasta el ${FECHA} --body Pone al dia la bitacora del harness (entrega aislada en worktree, hasta el ${FECHA}).`,
    )
  })

  test('[C] una segunda entrega sin cambios reutiliza el commit y el PR', () => {
    const again = prepared()
    const result = runDeliver(again)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'PR #77\n')
    assert.ok(result.stderr.startsWith('Commit existente reutilizado (sin cambios nuevos)\n'))
    assert.ok(result.stderr.endsWith(`PR existente reutilizado: https://github.com/${SLUG}/pull/77\n`))
    assert.equal(createCalls(), 1)
    assert.equal(remoteCommits(), commits1)
    assert.equal(snapshot(), before0)
  })

  test('[C] deliver con la ruta de un worktree ya eliminado reporta el PR', () => {
    const result = runDeliver(first)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'PR #77\n')
    assert.equal(result.stderr, `El worktree '${first}' ya no existe; la rama '${BRANCH}' ya fue entregada.\n`)
    assert.equal(createCalls(), 1)
  })

  test('[C2] una reentrega con cambios reutiliza el PR abierto', () => {
    const again = prepared()
    appendFileSync(join(again, 'docs', 'bitacora', `${FECHA}.md`), '# mas\n')
    const result = runDeliver(again)
    assert.equal(result.stdout, 'PR #77\n')
    assert.equal(createCalls(), 1)
    assert.equal(remoteCommits(), '2')
  })

  test('[F] con el PR mergeado, prepare recrea la rama desde origin/main y deliver abre un PR nuevo', () => {
    setState(77, 'MERGED', '2026-10-08T01:00:00Z')
    git(main, 'fetch', '-q', 'origin', 'main')
    const result = runPrepare()
    assert.equal(result.status, 0, result.stderr)
    redelivered = result.stdout.trimEnd()
    assert.ok(result.stderr.includes(`El PR mas reciente de '${BRANCH}' ya se mergeo; se recrea la rama desde origin/main.\n`))
    assert.equal(git(redelivered, 'log', 'origin/main..HEAD', '--oneline'), '')

    writeFileSync(join(redelivered, 'docs', 'bitacora', `${FECHA}-bis.md`), '# reentrega\n')
    const delivery = runDeliver(redelivered)
    assert.equal(delivery.status, 0, delivery.stderr)
    assert.equal(delivery.stdout, 'PR #78\n')
    assert.equal(delivery.stderr.includes('reutilizado'), false)
    assert.equal(createCalls(), 2)
    assert.ok(calls.at(-1)?.includes(`--title docs(bitacora): reentrega de entradas hasta el ${FECHA} `))
  })

  test('[G] un segundo deliver tras la reentrega reutiliza el PR abierto', () => {
    const again = prepared()
    const result = runDeliver(again)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'PR #78\n')
    assert.equal(runDeliver(redelivered).stdout, 'PR #78\n')
    assert.equal(createCalls(), 2)
  })

  test('[H] un PR cerrado sin merge se reabre en lugar de crear otro', () => {
    setState(78, 'CLOSED', null)
    const again = prepared()
    appendFileSync(join(again, 'docs', 'bitacora', `${FECHA}-bis.md`), '# cerrado\n')
    const result = runDeliver(again)
    assert.equal(result.stdout, 'PR #78\n')
    assert.ok(calls.includes(`pr reopen --repo ${SLUG} https://github.com/${SLUG}/pull/78`))
    assert.equal(store.find((pr) => pr.number === 78)?.state, 'OPEN')
    assert.equal(createCalls(), 2)
  })

  test('[H] si la reapertura falla, aborta con el checkpoint y la accion de recuperacion', () => {
    setState(78, 'CLOSED', null)
    const again = prepared()
    appendFileSync(join(again, 'docs', 'bitacora', `${FECHA}-bis.md`), '# otra vez\n')
    ghFailure = 'pr reopen'
    try {
      const result = runDeliver(again)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.ok(
        result.stderr.endsWith(
          [
            "ERROR: fallo en el paso 'reapertura-pr' de la entrega de la bitacora",
            'Ultimo checkpoint confirmado: push',
            `Accion de recuperacion: El PR https://github.com/${SLUG}/pull/78 esta cerrado sin merge y 'gh pr reopen' fallo; reabrelo a mano y reintenta.`,
            '',
          ].join('\n'),
        ),
      )
      assert.equal(existsSync(again), true)
    } finally {
      ghFailure = null
    }
    assert.equal(runDeliver(again).stdout, 'PR #78\n')
  })

  test('[D] deliver rechaza cambios fuera de docs/bitacora/ sin commitear nada', () => {
    const again = prepared()
    const head = git(again, 'rev-parse', 'HEAD')
    writeFileSync(join(again, 'AGENTS.md'), 'x\n')
    writeFileSync(join(again, 'docs', 'bitacora', 'dentro.md'), 'x\n')
    const result = runDeliver(again)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, "ERROR: el worktree contiene cambios fuera de 'docs/bitacora/':\nAGENTS.md\n")
    assert.equal(git(again, 'rev-parse', 'HEAD'), head)
    rmSync(join(again, 'AGENTS.md'))
    assert.equal(runDeliver(again).status, 0)
  })

  test('deliver sin nada que entregar falla y conserva el worktree', () => {
    const date = '2026-10-09'
    const fresh = prepared(date)
    const result = runDeliver(fresh)
    assert.equal(result.status, 1)
    assert.equal(result.stderr, `ERROR: no hay cambios que entregar en '${fresh}' (HEAD ya esta en origin/main).\n`)
    assert.equal(existsSync(fresh), true)
    git(main, 'worktree', 'remove', fresh)
  })

  test('deliver rechaza el checkout principal, una rama ajena y una ruta desconocida', () => {
    assert.equal(
      runDeliver(main).stderr,
      'ERROR: --worktree apunta al checkout principal; la entrega solo opera en un worktree aislado.\n',
    )
    const other = join(tmp, 'otra-rama')
    git(main, 'worktree', 'add', '-q', '-b', 'feat-otra', other, 'origin/main')
    const wrongBranch = runDeliver(other)
    assert.equal(wrongBranch.status, 1)
    assert.equal(wrongBranch.stderr, "ERROR: la rama del worktree ('feat-otra') no es docs/bitacora-hasta-<fecha>.\n")
    git(main, 'worktree', 'remove', other)

    const missing = join(tmp, 'no-existe')
    const unknown = runDeliver(missing)
    assert.equal(unknown.status, 1)
    assert.equal(unknown.stderr, `ERROR: el worktree '${missing}' no existe; corre 'prepare' de nuevo.\n`)
  })

  test('prepare se niega si la rama de la bitacora esta en el checkout principal', () => {
    const date = '2026-10-10'
    git(main, 'checkout', '-q', '-b', `docs/bitacora-hasta-${date}`)
    try {
      const result = runPrepare(date)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.ok(
        result.stderr.endsWith(
          `ERROR: la rama 'docs/bitacora-hasta-${date}' esta checkouteada en el checkout principal; muevelo a su rama de trabajo habitual y reintenta.\n`,
        ),
      )
    } finally {
      git(main, 'checkout', '-q', 'main')
      git(main, 'branch', '-D', `docs/bitacora-hasta-${date}`)
    }
  })

  test('prepare falla con un mensaje accionable si gh no puede listar los PRs de una rama existente', () => {
    ghFailure = 'pr list'
    try {
      const result = runPrepare()
      assert.equal(result.status, 1)
      assert.ok(
        result.stderr.endsWith(
          `ERROR: 'gh pr list' fallo al consultar el PR de '${BRANCH}'; revisa 'gh auth status' y reintenta 'prepare --fecha ${FECHA}'.\n`,
        ),
      )
    } finally {
      ghFailure = null
    }
  })

  test('el checkout principal conserva rama, HEAD y status tras todas las entregas', () => {
    assert.equal(snapshot(), before0)
  })
})

describe('eleccion del PR', () => {
  const pr = (number: number, createdAt: string | null, state = 'OPEN', mergedAt: string | null = null) => ({
    number,
    createdAt,
    state,
    mergedAt,
  })

  test('el mas reciente es el de mayor fecha de creacion y, a igualdad, el de mayor numero', () => {
    assert.equal(latestPullRequest([pr(3, '2026-01-02'), pr(9, '2026-01-01')])?.number, 3)
    assert.equal(latestPullRequest([pr(5, '2026-01-01'), pr(4, '2026-01-01')])?.number, 5)
    assert.equal(latestPullRequest([pr(8, null), pr(2, '2026-01-01')])?.number, 2)
    assert.equal(latestPullRequest([]), null)
  })

  test('cuenta como mergeado por estado o por fecha de merge', () => {
    assert.equal(isMerged(pr(1, null, 'MERGED')), true)
    assert.equal(isMerged(pr(1, null, 'CLOSED', '2026-01-01T00:00:00Z')), true)
    assert.equal(isMerged(pr(1, null, 'CLOSED')), false)
    assert.equal(isMerged({ state: 'OPEN', mergedAt: '' }), false)
    assert.equal(isMerged({ state: 'OPEN' }), false)
  })

  test('una salida de gh que no es una lista de objetos no aporta PRs', () => {
    assert.deepEqual(parsePullRequests('[]'), [])
    assert.equal(parsePullRequests(''), null)
    assert.equal(parsePullRequests('{"number":1}'), null)
    assert.equal(parsePullRequests('[1]'), null)
    assert.deepEqual(parsePullRequests('[{"number":1}]\n'), [{ number: 1 }])
  })
})

describe('argumentos', () => {
  const rejects = (argv: string[], message: string): void => {
    assert.throws(
      () => parseArguments(argv),
      (error: unknown) => error instanceof CliError && error.exitCode === 1 && error.message === message,
    )
  }

  test('acepta prepare con fecha y deliver con worktree', () => {
    assert.deepEqual(parseArguments(['prepare', '--fecha', FECHA]), { command: 'prepare', fecha: FECHA, worktree: '' })
    assert.deepEqual(parseArguments(['deliver', '--worktree', 'x']), { command: 'deliver', fecha: '', worktree: 'x' })
    assert.equal(parseArguments(['--help']).command, 'help')
    assert.equal(parseArguments(['-h']).command, 'help')
    assert.equal(parseArguments(['prepare', '--help']).command, 'help')
  })

  test('rechaza un subcomando desconocido o ausente con el uso', () => {
    rejects([], `ERROR: subcomando '' desconocido (prepare|deliver)\n${USAGE}`)
    rejects(['otro'], `ERROR: subcomando 'otro' desconocido (prepare|deliver)\n${USAGE}`)
    rejects(['prepare', '--otra'], `ERROR: argumento desconocido '--otra'\n${USAGE}`)
  })

  test('exige el valor y el formato de cada opcion', () => {
    rejects(['prepare', '--fecha'], 'ERROR: --fecha requiere un valor')
    rejects(['deliver', '--worktree'], 'ERROR: --worktree requiere un valor')
    rejects(['prepare'], 'ERROR: --fecha es obligatoria y debe tener el formato YYYY-MM-DD')
    rejects(['prepare', '--fecha', '2026-1-1'], 'ERROR: --fecha es obligatoria y debe tener el formato YYYY-MM-DD')
    rejects(['prepare', '--worktree', 'x'], 'ERROR: --fecha es obligatoria y debe tener el formato YYYY-MM-DD')
    rejects(['deliver'], 'ERROR: --worktree es obligatorio')
  })

  test('por linea de comandos el error va a stderr con codigo 1 y la ayuda con codigo 0', () => {
    const unknown = spawnSync(process.execPath, [SCRIPT, 'otro'], { encoding: 'utf8' })
    assert.equal(unknown.status, 1)
    assert.equal(unknown.stdout, '')
    assert.equal(unknown.stderr, `ERROR: subcomando 'otro' desconocido (prepare|deliver)\n${USAGE}\n`)
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.equal(help.stderr, `${USAGE}\n`)
  })
})

describe('[E] shim', () => {
  test('el canonico en bash es el shim hacia el .mts', () => {
    assert.equal(
      readFileSync(CANONICAL_SHIM, 'utf8'),
      [
        '#!/usr/bin/env bash',
        '# Shim: la implementacion vive en mefisto-bitacora-worktree.mts (MEF-ADR-0057). No editar.',
        'exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/mefisto-bitacora-worktree.mts" "$@"',
        '',
      ].join('\n'),
    )
    if (POSIX) assert.notEqual(statSync(CANONICAL_SHIM).mode & 0o111, 0)
  })

  test('el shim estable conserva la plantilla de exec', () => {
    assert.equal(
      readFileSync(STABLE_SHIM, 'utf8').split('\n')[2],
      'exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"',
    )
  })

  test('el shim estable llega al .mts', { skip: !POSIX }, () => {
    const result = spawnSync(STABLE_SHIM, ['deliver'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: --worktree es obligatorio\n')
  })
})
