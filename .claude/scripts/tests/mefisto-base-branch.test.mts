import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { git, gitOk, isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import { ensureRepoOnBaseBranch, remediateMainAfterRescue } from '../../../src/internal/scripts/lib/mefisto-base-branch.mts'
import type { BaseBranchCheck, BaseBranchOptions } from '../../../src/internal/scripts/lib/mefisto-base-branch.mts'

const FOREIGN_SHA = '0123456789abcdef0123456789abcdef01234567'

let tmp = ''
let counter = 0
let restoreGit = (): void => {}
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mefisto base branch '))
  restoreGit = isolateGitConfig(tmp)
  process.env.GIT_CEILING_DIRECTORIES = tmp
})

after(() => {
  restoreGit()
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling
  rmSync(tmp, { recursive: true, force: true })
})

interface Fixture {
  dir: string
  origin: string
  /** Checkout bajo prueba, en `main` y al dia con el remoto. */
  work: string
}

function clone(origin: string, dest: string): string {
  git(tmp, 'clone', '-q', origin, dest)
  git(dest, 'config', 'user.email', 'test@mefisto.local')
  git(dest, 'config', 'user.name', 'Mefisto Test')
  return dest
}

function commit(repo: string, file: string, message: string): string {
  writeFileSync(join(repo, file), `${message}\n`)
  git(repo, 'add', '--', file)
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

function newFixture(): Fixture {
  counter += 1
  const dir = join(tmp, `caso ${counter}`)
  mkdirSync(dir)
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  const work = clone(origin, join(dir, 'work'))
  git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  commit(work, 'f', 'base')
  git(work, 'push', '-q', '-u', 'origin', 'main')
  appendFileSync(join(work, '.git', 'info', 'exclude'), '.mefisto/\n')
  return { dir, origin, work }
}

/** Otra sesion avanza `main` en el remoto; devuelve el SHA publicado. */
function advanceRemote(fixture: Fixture, file = 'g'): string {
  counter += 1
  const publisher = clone(fixture.origin, join(fixture.dir, `publisher ${counter}`))
  const sha = commit(publisher, file, `remoto ${file}`)
  git(publisher, 'push', '-q', 'origin', 'main')
  return sha
}

function rescuedFile(work: string): string {
  return join(work, '.mefisto', 'pipeline', 'rescued-main.txt')
}

function writeRescued(work: string, content: string): void {
  mkdirSync(join(work, '.mefisto', 'pipeline'), { recursive: true })
  writeFileSync(rescuedFile(work), content)
}

/** Contenido de la lista, `null` si no existe y `'<directorio>'` si en su lugar hay una carpeta. */
function rescuedContent(work: string): string | null {
  const file = rescuedFile(work)
  if (!existsSync(file)) return null
  return statSync(file).isFile() ? readFileSync(file, 'latin1') : '<directorio>'
}

function head(work: string): string {
  return git(work, 'rev-parse', 'HEAD')
}

function branch(work: string): string {
  return git(work, 'rev-parse', '--abbrev-ref', 'HEAD')
}

interface RepoState {
  branch: string
  head: string
  main: string
  status: string
  rescued: string | null
}

function repoState(work: string): RepoState {
  return {
    branch: branch(work),
    head: head(work),
    main: gitOk(work, 'rev-parse', '--verify', '-q', 'refs/heads/main') ? git(work, 'rev-parse', 'refs/heads/main') : '',
    status: git(work, 'status', '--porcelain'),
    rescued: rescuedContent(work),
  }
}

// --- remediate_main_after_rescue ---

interface RescueCase {
  branch?: string
  remoteRef?: string
  arrange: (fixture: Fixture) => void
}

/** Un commit local ya rescatado por el hook, con el remoto adelantado por el squash de su PR. */
function rescuedAndSquashed(fixture: Fixture, list: (sha: string) => string): string {
  const sha = commit(fixture.work, 'r', 'rescatado')
  writeRescued(fixture.work, list(sha))
  advanceRemote(fixture)
  git(fixture.work, 'fetch', '-q', 'origin')
  return sha
}

const RESCUE_CASES: Record<string, RescueCase> = {
  'rescatado y arbol limpio': {
    arrange: (fixture) => void rescuedAndSquashed(fixture, (sha) => `${FOREIGN_SHA}\n${sha}\n`),
  },
  'lista sin salto final, con lineas vacias y una linea que solo contiene al SHA': {
    arrange: (fixture) => void rescuedAndSquashed(fixture, (sha) => `${sha}\n\n x${sha}\n${sha} \n${FOREIGN_SHA}\r\nñ\n${sha}`),
  },
  'dos commits rescatados': {
    arrange: (fixture) => {
      const first = commit(fixture.work, 'r1', 'rescatado 1')
      rescuedAndSquashed(fixture, (sha) => `${sha}\n${first}\n`)
    },
  },
  'commit local no rescatado': {
    arrange: (fixture) => {
      const sha = commit(fixture.work, 'r', 'rescatado')
      writeRescued(fixture.work, `${sha}\n`)
      commit(fixture.work, 'x', 'propio')
      advanceRemote(fixture)
      git(fixture.work, 'fetch', '-q', 'origin')
    },
  },
  'el SHA solo aparece como parte de otra linea': {
    arrange: (fixture) => void rescuedAndSquashed(fixture, (sha) => `x${sha}\n${sha.slice(0, 12)}\n`),
  },
  'arbol sucio': {
    arrange: (fixture) => {
      rescuedAndSquashed(fixture, (sha) => `${sha}\n`)
      appendFileSync(join(fixture.work, 'f'), 'dirty\n')
    },
  },
  'archivo sin trackear': {
    arrange: (fixture) => {
      rescuedAndSquashed(fixture, (sha) => `${sha}\n`)
      writeFileSync(join(fixture.work, 'nuevo.txt'), 'x\n')
    },
  },
  'sin lista de rescatados': {
    arrange: (fixture) => {
      commit(fixture.work, 'r', 'rescatado')
      advanceRemote(fixture)
      git(fixture.work, 'fetch', '-q', 'origin')
    },
  },
  'la lista es un directorio': {
    arrange: (fixture) => {
      commit(fixture.work, 'r', 'rescatado')
      mkdirSync(rescuedFile(fixture.work), { recursive: true })
    },
  },
  'la rama activa no es la pedida': {
    arrange: (fixture) => {
      rescuedAndSquashed(fixture, (sha) => `${sha}\n`)
      git(fixture.work, 'switch', '-q', '-c', 'otra')
    },
  },
  'sin commits locales de mas': {
    arrange: (fixture) => {
      writeRescued(fixture.work, `${head(fixture.work)}\n`)
      advanceRemote(fixture)
      git(fixture.work, 'fetch', '-q', 'origin')
    },
  },
  'la referencia remota no existe': {
    remoteRef: 'origin/no-existe',
    arrange: (fixture) => void rescuedAndSquashed(fixture, (sha) => `${sha}\n`),
  },
}

function rescueCase(name: string): RescueCase {
  const found = RESCUE_CASES[name]
  assert.ok(found, name)
  return found
}

function arrangeRescue(name: string): { fixture: Fixture; before: RepoState } {
  const fixture = newFixture()
  rescueCase(name).arrange(fixture)
  return { fixture, before: repoState(fixture.work) }
}

function remediate(name: string, work: string, run?: Run): string | null {
  const { branch: target = 'main', remoteRef = 'origin/main' } = rescueCase(name)
  return remediateMainAfterRescue(work, target, remoteRef, run)
}

describe('remediateMainAfterRescue', () => {
  test('[A] commits rescatados y arbol limpio: remedia y limpia la lista', () => {
    const { fixture } = arrangeRescue('rescatado y arbol limpio')
    const rescued = head(fixture.work)
    assert.equal(
      remediate('rescatado y arbol limpio', fixture.work),
      "'main' local tenia commits ya rescatados por el hook pre-push; se hizo 'git reset --keep origin/main' y se retiraron de rescued-main.txt (issue #2112).",
    )
    assert.equal(head(fixture.work), git(fixture.work, 'rev-parse', 'origin/main'))
    assert.equal(readFileSync(rescuedFile(fixture.work), 'utf8'), `${FOREIGN_SHA}\n`)
    assert.equal(gitOk(fixture.work, 'cat-file', '-e', rescued), true)
  })

  test('retira solo las lineas que son exactamente un SHA remediado', () => {
    const name = 'lista sin salto final, con lineas vacias y una linea que solo contiene al SHA'
    const { fixture } = arrangeRescue(name)
    const sha = head(fixture.work)
    assert.notEqual(remediate(name, fixture.work), null)
    assert.equal(readFileSync(rescuedFile(fixture.work), 'utf8'), `\n x${sha}\n${sha} \n${FOREIGN_SHA}\r\nñ\n`)
  })

  test('remedia varios commits rescatados y deja la lista vacia', () => {
    const { fixture } = arrangeRescue('dos commits rescatados')
    assert.notEqual(remediate('dos commits rescatados', fixture.work), null)
    assert.equal(head(fixture.work), git(fixture.work, 'rev-parse', 'origin/main'))
    assert.equal(readFileSync(rescuedFile(fixture.work), 'utf8'), '')
  })

  test('[B] un commit local no rescatado: no remedia', () => {
    const { fixture, before: state } = arrangeRescue('commit local no rescatado')
    assert.equal(remediate('commit local no rescatado', fixture.work), null)
    assert.deepEqual(repoState(fixture.work), state)
  })

  test('[C] arbol sucio: no remedia', () => {
    for (const name of ['arbol sucio', 'archivo sin trackear']) {
      const { fixture, before: state } = arrangeRescue(name)
      assert.equal(remediate(name, fixture.work), null, name)
      assert.deepEqual(repoState(fixture.work), state, name)
    }
  })

  test('cualquier otra guarda incumplida devuelve null sin tocar nada', () => {
    for (const name of [
      'el SHA solo aparece como parte de otra linea',
      'sin lista de rescatados',
      'la lista es un directorio',
      'la rama activa no es la pedida',
      'sin commits locales de mas',
      'la referencia remota no existe',
    ]) {
      const { fixture, before: state } = arrangeRescue(name)
      assert.equal(remediate(name, fixture.work), null, name)
      assert.deepEqual(repoState(fixture.work), state, name)
    }
  })

  test('sin lista de rescatados no llega a invocar git', () => {
    const calls: string[][] = []
    const run: Run = (command, args) => {
      calls.push([command, ...args])
      return { status: 0, stdout: '', stderr: '' }
    }
    assert.equal(remediateMainAfterRescue(join(tmp, 'no-existe'), 'main', 'origin/main', run), null)
    assert.deepEqual(calls, [])
  })

  test('consulta rama, arbol y commits antes del unico comando que muta', () => {
    const { fixture } = arrangeRescue('rescatado y arbol limpio')
    const calls: string[][] = []
    const run: Run = (command, args, options) => {
      calls.push(args.slice(2))
      return runGit(command, args, options)
    }
    assert.notEqual(remediate('rescatado y arbol limpio', fixture.work, run), null)
    assert.deepEqual(calls, [
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['status', '--porcelain'],
      ['rev-list', 'origin/main..main'],
      ['reset', '--keep', 'origin/main'],
    ])
  })

  test('si el reset falla no retira nada de la lista', () => {
    const { fixture, before: state } = arrangeRescue('rescatado y arbol limpio')
    const run: Run = (command, args, options) =>
      args.includes('reset') ? { status: 1, stdout: '', stderr: 'fatal' } : runGit(command, args, options)
    assert.equal(remediate('rescatado y arbol limpio', fixture.work, run), null)
    assert.deepEqual(repoState(fixture.work), state)
  })
})

function runGit(command: string, args: string[], options?: { cwd?: string }): CommandResult {
  assert.equal(command, 'git')
  const cwd = options?.cwd ?? tmp
  try {
    return { status: 0, stdout: `${git(cwd, ...args)}\n`, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

// --- ensure_repo_on_base_branch ---

interface BaseCase {
  /** Deja el checkout en el estado de partida. */
  arrange: (fixture: Fixture) => void
  /** Opciones del gate; por defecto, la raiz explicita del checkout. */
  options?: (work: string) => BaseBranchOptions
}

const BASE_CASES: Record<string, BaseCase> = {
  'A rama ajena, arbol limpio, remoto adelantado': {
    arrange: (fixture) => {
      git(fixture.work, 'switch', '-q', '-c', 'docs/field-notes-refinamiento-718')
      advanceRemote(fixture)
    },
  },
  'B rama ajena, arbol sucio': {
    arrange: (fixture) => {
      git(fixture.work, 'switch', '-q', '-c', 'feature-sucia')
      writeFileSync(join(fixture.work, 'archivo-staged.txt'), 'cambio staged\n')
      git(fixture.work, 'add', 'archivo-staged.txt')
      writeFileSync(join(fixture.work, 'archivo-modificado.txt'), 'cambio modificado\n')
      git(fixture.work, 'add', 'archivo-modificado.txt')
      appendFileSync(join(fixture.work, 'archivo-modificado.txt'), 'cambio posterior\n')
      writeFileSync(join(fixture.work, 'archivo-sin-trackear.txt'), 'cambio sin trackear\n')
    },
  },
  'C rama ajena, main local diverge del remoto': {
    arrange: (fixture) => {
      commit(fixture.work, 'local', 'commit local divergente')
      git(fixture.work, 'switch', '-q', '-c', 'feature-diverge')
      advanceRemote(fixture)
    },
  },
  'D ya en main': { arrange: () => {} },
  'E main y master locales coexisten': {
    arrange: (fixture) => {
      git(fixture.work, 'branch', 'master', 'main')
      git(fixture.work, 'switch', '-q', '-c', 'feature-e')
    },
  },
  'F HEAD separado con arbol limpio': {
    arrange: (fixture) => git(fixture.work, 'checkout', '-q', '--detach', 'main'),
  },
  'G ya en master y sin main': {
    arrange: (fixture) => {
      git(fixture.work, 'branch', '-m', 'main', 'master')
      git(fixture.work, 'branch', '--unset-upstream')
    },
  },
  'solo existe master como base': {
    arrange: (fixture) => {
      git(fixture.work, 'branch', '-m', 'main', 'master')
      git(fixture.work, 'switch', '-q', '-c', 'feature-master')
      advanceRemote(fixture)
    },
  },
  'sin main ni master local': {
    arrange: (fixture) => {
      git(fixture.work, 'switch', '-q', '-c', 'feature-huerfana')
      git(fixture.work, 'branch', '-D', '-q', 'main')
    },
  },
  'main sin upstream': {
    arrange: (fixture) => {
      git(fixture.work, 'branch', '--unset-upstream')
      git(fixture.work, 'switch', '-q', '-c', 'feature-sin-upstream')
    },
  },
  'el pull falla pero el hook ya rescato los commits de mas': {
    arrange: (fixture) => {
      const sha = commit(fixture.work, 'r', 'rescatado')
      writeRescued(fixture.work, `${FOREIGN_SHA}\n${sha}\n`)
      git(fixture.work, 'switch', '-q', '-c', 'feature-rescate')
      advanceRemote(fixture)
    },
  },
  'el pull falla y solo parte de los commits de mas fue rescatada': {
    arrange: (fixture) => {
      const sha = commit(fixture.work, 'r', 'rescatado')
      writeRescued(fixture.work, `${sha}\n`)
      commit(fixture.work, 'x', 'propio')
      git(fixture.work, 'switch', '-q', '-c', 'feature-rescate-parcial')
      advanceRemote(fixture)
    },
  },
  'archivo ignorado en una rama ajena': {
    arrange: (fixture) => {
      git(fixture.work, 'switch', '-q', '-c', 'feature-ignorados')
      writeRescued(fixture.work, '')
    },
  },
  'raiz resuelta desde una subcarpeta del checkout': {
    arrange: (fixture) => {
      mkdirSync(join(fixture.work, 'sub'))
      commit(fixture.work, join('sub', 'a'), 'subcarpeta')
      git(fixture.work, 'push', '-q', 'origin', 'main')
      git(fixture.work, 'switch', '-q', '-c', 'feature-sub')
    },
    options: (work) => ({ cwd: join(work, 'sub') }),
  },
  'raiz irresoluble fuera de un repo': {
    arrange: (fixture) => {
      git(fixture.work, 'switch', '-q', '-c', 'feature-intacta')
      mkdirSync(join(fixture.dir, 'sin repo'))
    },
    options: (work) => ({ cwd: join(work, '..', 'sin repo') }),
  },
  'repo sin commits': {
    arrange: (fixture) => {
      rmSync(join(fixture.work, '.git'), { recursive: true, force: true })
      git(fixture.work, 'init', '-q', '-b', 'trunk')
    },
  },
}

function baseCase(name: string): BaseCase {
  const found = BASE_CASES[name]
  assert.ok(found, name)
  return found
}

function arrangeBase(name: string): { fixture: Fixture; before: RepoState | null } {
  const fixture = newFixture()
  baseCase(name).arrange(fixture)
  return { fixture, before: name === 'repo sin commits' ? null : repoState(fixture.work) }
}

function ensure(name: string, work: string): BaseBranchCheck {
  return ensureRepoOnBaseBranch(baseCase(name).options?.(work) ?? { repoRoot: work })
}

function passed(check: BaseBranchCheck): { mainBranch: string; warnings: string[] } {
  if (!check.ok) assert.fail(`se esperaba que el gate pasara: ${check.abort}`)
  return check
}

function aborted(check: BaseBranchCheck): string {
  if (check.ok) assert.fail('se esperaba que el gate abortara')
  return check.abort
}

function recoveredWarning(from: string, base: string): string {
  return `El repo principal estaba en la rama '${from}' (arbol limpio) al arrancar el batch; el gate se auto-recupero a '${base}' y lo sincronizo con origin/${base} (issue #726). Los commits de '${from}' siguen intactos en su rama.`
}

interface Scripted {
  run: Run
  calls: string[]
}

/** `git` simulado: responde por los argumentos que siguen a `-C <raiz>`; lo no previsto sale bien y vacio. */
function scripted(responses: Record<string, Partial<CommandResult>>): Scripted {
  const calls: string[] = []
  const run: Run = (command, args) => {
    const key = (args[0] === '-C' ? args.slice(2) : args).join(' ')
    calls.push(`${command} ${args.join(' ')}`)
    return { status: 0, stdout: '', stderr: '', ...responses[key] }
  }
  return { run, calls }
}

describe('ensureRepoOnBaseBranch', () => {
  test('[A] rama ajena con arbol limpio: cambia a main y trae lo nuevo del remoto', () => {
    const name = 'A rama ajena, arbol limpio, remoto adelantado'
    const { fixture } = arrangeBase(name)
    const published = git(fixture.origin, 'rev-parse', 'main')
    const check = passed(ensure(name, fixture.work))
    assert.equal(check.mainBranch, 'main')
    assert.deepEqual(check.warnings, [recoveredWarning('docs/field-notes-refinamiento-718', 'main')])
    assert.equal(branch(fixture.work), 'main')
    assert.equal(git(fixture.work, 'rev-parse', 'main'), published)
  })

  test('[B] arbol sucio: aborta sin tocar HEAD ni los cambios pendientes', () => {
    const name = 'B rama ajena, arbol sucio'
    const { fixture, before: state } = arrangeBase(name)
    assert.equal(
      aborted(ensure(name, fixture.work)),
      "El repo principal esta en la rama 'feature-sucia', no en main/master, y el arbol de trabajo no esta limpio (cambios sin commitear, staged o archivos sin trackear). Cada worktree del tooling-pipeline nace de origin/main sin importar la rama activa (issue #66), pero el batch tambien mantiene la base local sincronizada. La auto-recuperacion solo aplica con el arbol de trabajo LIMPIO; con cambios pendientes se requiere resolucion humana: conservalos, commitealos o resuelvelos y haz 'git switch main' a mano antes de lanzar el batch.",
    )
    assert.deepEqual(repoState(fixture.work), state)
    assert.equal(branch(fixture.work), 'feature-sucia')
    assert.equal(existsSync(join(fixture.work, 'archivo-sin-trackear.txt')), true)
    assert.equal(gitOk(fixture.work, 'diff', '--cached', '--quiet'), false)
    assert.equal(gitOk(fixture.work, 'diff', '--quiet'), false)
  })

  test('[C] main local diverge del remoto: aborta tras el switch, sin forzar nada', () => {
    const name = 'C rama ajena, main local diverge del remoto'
    const { fixture, before: state } = arrangeBase(name)
    const reason = aborted(ensure(name, fixture.work))
    assert.ok(
      reason.startsWith(
        "El repo principal estaba en la rama 'feature-diverge' (arbol limpio); el gate lo auto-recupero a 'main', pero 'git pull --ff-only' fallo ahi -- tipicamente porque 'main' local divergio de origin/main (tambien cae aqui una base sin upstream configurado). La premisa de higiene no se puede cumplir asi: resuelve la divergencia a mano (el repo quedo en 'main') antes de relanzar el batch. Salida de git: ",
      ),
      reason,
    )
    assert.equal(reason.includes('\n'), false)
    assert.equal(branch(fixture.work), 'main')
    assert.equal(git(fixture.work, 'rev-parse', 'main'), state?.main)
  })

  test('[D][G] ya en main o en master: no hace nada', () => {
    for (const [name, expected] of [
      ['D ya en main', 'main'],
      ['G ya en master y sin main', 'master'],
    ] as const) {
      const { fixture, before: state } = arrangeBase(name)
      assert.deepEqual(ensure(name, fixture.work), { ok: true, mainBranch: expected, warnings: [], gitStderr: '' })
      assert.deepEqual(repoState(fixture.work), state)
    }
  })

  test('[D] en la rama base no consulta el arbol ni sincroniza', () => {
    const fake = scripted({ 'rev-parse --abbrev-ref HEAD': { stdout: 'master\n' } })
    assert.equal(passed(ensureRepoOnBaseBranch({ repoRoot: '/repo', run: fake.run })).mainBranch, 'master')
    assert.deepEqual(fake.calls, ['git -C /repo rev-parse --abbrev-ref HEAD'])
  })

  test('[E] con main y master locales prefiere main', () => {
    const name = 'E main y master locales coexisten'
    const { fixture } = arrangeBase(name)
    assert.equal(passed(ensure(name, fixture.work)).mainBranch, 'main')
    assert.equal(branch(fixture.work), 'main')
  })

  test('[F] HEAD separado con arbol limpio se recupera por el mismo camino', () => {
    const name = 'F HEAD separado con arbol limpio'
    const { fixture } = arrangeBase(name)
    assert.deepEqual(passed(ensure(name, fixture.work)).warnings, [recoveredWarning('HEAD', 'main')])
    assert.equal(branch(fixture.work), 'main')
  })

  test('sin main local cae a master', () => {
    const name = 'solo existe master como base'
    const { fixture } = arrangeBase(name)
    const published = git(fixture.origin, 'rev-parse', 'main')
    const check = passed(ensure(name, fixture.work))
    assert.equal(check.mainBranch, 'master')
    assert.deepEqual(check.warnings, [recoveredWarning('feature-master', 'master')])
    assert.equal(branch(fixture.work), 'master')
    assert.equal(head(fixture.work), published)
  })

  test('sin main ni master local aborta sin cambiar de rama', () => {
    const name = 'sin main ni master local'
    const { fixture, before: state } = arrangeBase(name)
    assert.equal(
      aborted(ensure(name, fixture.work)),
      "El repo principal esta en la rama 'feature-huerfana' y no existe ni 'main' ni 'master' local para auto-recuperar el gate. Crea o rescata una de las dos antes de lanzar el batch.",
    )
    assert.deepEqual(repoState(fixture.work), state)
  })

  test('un pull fallido cuyos commits de mas ya rescato el hook se remedia y avisa dos veces', () => {
    const name = 'el pull falla pero el hook ya rescato los commits de mas'
    const { fixture } = arrangeBase(name)
    const published = git(fixture.origin, 'rev-parse', 'main')
    const check = passed(ensure(name, fixture.work))
    assert.equal(check.mainBranch, 'main')
    assert.deepEqual(check.warnings, [
      "'main' local tenia commits ya rescatados por el hook pre-push; se hizo 'git reset --keep origin/main' y se retiraron de rescued-main.txt (issue #2112).",
      recoveredWarning('feature-rescate', 'main'),
    ])
    assert.equal(head(fixture.work), published)
    assert.equal(readFileSync(rescuedFile(fixture.work), 'utf8'), `${FOREIGN_SHA}\n`)
  })

  test('un pull fallido con un commit de mas sin rescatar aborta y conserva main', () => {
    const name = 'el pull falla y solo parte de los commits de mas fue rescatada'
    const { fixture, before: state } = arrangeBase(name)
    assert.match(aborted(ensure(name, fixture.work)), /'git pull --ff-only' fallo ahi/)
    assert.equal(git(fixture.work, 'rev-parse', 'main'), state?.main)
    assert.equal(readFileSync(rescuedFile(fixture.work), 'utf8'), state?.rescued)
  })

  test('una base sin upstream aborta tras el switch como un pull fallido', () => {
    const name = 'main sin upstream'
    const { fixture, before: state } = arrangeBase(name)
    assert.match(aborted(ensure(name, fixture.work)), /^El repo principal estaba en la rama 'feature-sin-upstream' .*'git pull --ff-only' fallo ahi/)
    assert.equal(branch(fixture.work), 'main')
    assert.equal(git(fixture.work, 'rev-parse', 'main'), state?.main)
  })

  test('un archivo ignorado no ensucia el arbol', () => {
    const name = 'archivo ignorado en una rama ajena'
    const { fixture } = arrangeBase(name)
    assert.deepEqual(passed(ensure(name, fixture.work)).warnings, [recoveredWarning('feature-ignorados', 'main')])
    assert.equal(branch(fixture.work), 'main')
  })

  test('sin raiz explicita la resuelve con git desde cwd', () => {
    const name = 'raiz resuelta desde una subcarpeta del checkout'
    const { fixture } = arrangeBase(name)
    assert.equal(passed(ensure(name, fixture.work)).mainBranch, 'main')
    assert.equal(branch(fixture.work), 'main')

    const outside = arrangeBase('raiz irresoluble fuera de un repo')
    assert.equal(
      aborted(ensure('raiz irresoluble fuera de un repo', outside.fixture.work)),
      'No se pudo resolver la raiz del repo para prevalidar el batch.',
    )
    assert.deepEqual(repoState(outside.fixture.work), outside.before)
  })

  test('si no se puede leer la rama activa aborta con lo que dijo git', () => {
    const { fixture } = arrangeBase('repo sin commits')
    const check = ensure('repo sin commits', fixture.work)
    assert.equal(
      aborted(check),
      'No se pudo determinar la rama activa del repo principal antes de arrancar el batch.',
    )
    assert.match(check.gitStderr, /HEAD/)
  })

  test('recorre las guardas en orden y solo muta con switch y pull', () => {
    const fake = scripted({ 'rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' } })
    const check = passed(ensureRepoOnBaseBranch({ repoRoot: '/repo', run: fake.run }))
    assert.deepEqual(check, { ok: true, mainBranch: 'main', warnings: [recoveredWarning('feature', 'main')], gitStderr: '' })
    assert.deepEqual(fake.calls, [
      'git -C /repo rev-parse --abbrev-ref HEAD',
      'git -C /repo status --porcelain',
      'git -C /repo rev-parse --verify -q refs/heads/main',
      'git -C /repo switch -q main',
      'git -C /repo pull --ff-only',
    ])
  })

  test('con arbol sucio o sin rama base no llega a cambiar de rama', () => {
    const dirty = scripted({
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
      'status --porcelain': { stdout: '?? nuevo.txt\n' },
    })
    assert.match(aborted(ensureRepoOnBaseBranch({ repoRoot: '/repo', run: dirty.run })), /no esta limpio/)
    assert.deepEqual(dirty.calls, ['git -C /repo rev-parse --abbrev-ref HEAD', 'git -C /repo status --porcelain'])

    const orphan = scripted({
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
      'rev-parse --verify -q refs/heads/main': { status: 1 },
      'rev-parse --verify -q refs/heads/master': { status: 1 },
    })
    assert.match(aborted(ensureRepoOnBaseBranch({ repoRoot: '/repo', run: orphan.run })), /no existe ni 'main' ni 'master' local/)
    assert.equal(orphan.calls.some((call) => /switch|pull|reset/.test(call)), false)
  })

  test('si el switch falla aborta sin intentar el pull y conserva lo que dijo git', () => {
    const fake = scripted({
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
      'rev-parse --verify -q refs/heads/main': { status: 1 },
      'switch -q master': { status: 128, stderr: "fatal: 'master' is already used by worktree at '/otro'\n" },
    })
    const check = ensureRepoOnBaseBranch({ repoRoot: '/repo', run: fake.run })
    assert.deepEqual(check, {
      ok: false,
      abort:
        "El repo principal esta en la rama 'feature' (arbol limpio), pero 'git switch master' fallo. Resuelve a mano antes de lanzar el batch.",
      gitStderr: "fatal: 'master' is already used by worktree at '/otro'\n",
    })
    assert.equal(fake.calls.some((call) => call.includes('pull')), false)
  })

  test('el aborto por pull fallido cita la salida de git en una sola linea', () => {
    const fake = scripted({
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
      'pull --ff-only': { status: 1, stdout: 'Updating\n', stderr: 'hint: uno\nfatal: dos\n\n' },
    })
    const reason = aborted(ensureRepoOnBaseBranch({ repoRoot: join(tmp, 'no-existe'), run: fake.run }))
    assert.ok(reason.endsWith('antes de relanzar el batch. Salida de git: Updating hint: uno fatal: dos'), reason)
  })
})
