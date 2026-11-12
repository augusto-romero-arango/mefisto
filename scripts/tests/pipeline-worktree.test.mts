import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../lib/cli.mts'
import { PipelineAbort } from '../lib/pipeline/pipeline-exit.mts'
import { createAbort, createPipelineLog, loggedThrough, stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import {
  PIPELINE_OWN_WRITES,
  autoCommitIfNeeded,
  changedPaths,
  createWorktree,
  hasCommittedChanges,
  hasPendingChanges,
  issueBranchName,
  issueSlug,
  legacyWorktreePath,
  pipelineWorktreePath,
  removeWorktree,
  resumeWorktree,
} from '../lib/pipeline/pipeline-worktree.mts'
import type { WorktreeTools } from '../lib/pipeline/pipeline-worktree.mts'
import { isolateGitConfig, newRepo, writeFiles } from './field-note-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto pipeline worktree ')))
  restoreGit = isolateGitConfig(work)
})
after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

const git = (cwd: string, ...args: string[]): string => capture('git', args, { cwd }).stdout.replace(/\n+$/, '')

interface Fixture {
  root: string
  bare: string
  logFile: string
  screen: () => string
  tools: WorktreeTools
}

function fixture(): Fixture {
  counter++
  const dir = join(work, `caso-${counter}`)
  const repo = newRepo(dir, { 'README.md': 'base\n', '.gitignore': '.mefisto/pipeline/\n' })
  const logFile = join(dir, 'pipeline.log')
  let screen = ''
  const log = createPipelineLog({ logFile: () => logFile, out: (text) => void (screen += text) })
  const abort = createAbort({ log, worktree: () => '' })
  return {
    root: repo.main,
    bare: repo.bare,
    logFile,
    screen: () => stripAnsi(screen),
    tools: { run: capture, runLogged: loggedThrough(capture), log, abort, cwd: repo.main },
  }
}

describe('issueSlug e issueBranchName', () => {
  test('minusculas, guiones por espacios y solo [a-z0-9-]', () => {
    assert.equal(issueSlug('Agregar workflow de CI'), 'agregar-workflow-de-ci')
    assert.equal(issueSlug('Migrar  a .NET 10 (fase 2)!'), 'migrar-a-net-10-fase-2')
    assert.equal(issueSlug('Añadir validación más rápida'), 'aadir-validacin-ms-rpida')
  })
  test('corta en 40 caracteres y quita un guion final', () => {
    assert.equal(issueSlug('Refactorizar el pipeline de tooling para soportar variantes'), 'refactorizar-el-pipeline-de-tooling-para')
    assert.equal(issueSlug('a'.repeat(39) + ' bcd'), 'a'.repeat(39))
    assert.equal(issueSlug('termina en guion -'), 'termina-en-guion')
  })
  test('el nombre de rama lleva el issue y, si hay, la variante', () => {
    assert.equal(issueBranchName('42', 'agregar-ci'), 'worktree-issue-42-agregar-ci')
    assert.equal(issueBranchName('42', 'agregar-ci', 'exp-a'), 'worktree-issue-42-agregar-ci-exp-a')
  })
  test('un guion inicial se queda y los caracteres fuera de [a-z0-9-] se pierden', () => {
    assert.equal(issueSlug('--- Guiones --- repetidos ---'), '-guiones-repetidos')
    assert.equal(issueSlug('MAYUSCULAS_y_guion_bajo/barra'), 'mayusculasyguionbajobarra')
  })
})

describe('rutas del worktree', () => {
  test('el worktree vive bajo el estado del repo y la ubicacion anterior, a su lado', () => {
    assert.equal(pipelineWorktreePath(join(work, 'repo'), 'rama'), join(work, 'repo', '.mefisto', 'pipeline', 'worktrees', 'rama'))
    assert.equal(legacyWorktreePath(join(work, 'repo'), 'rama'), join(work, 'rama'))
  })
  test('lo propio del pipeline es solo su estado canonico', () => {
    assert.deepEqual(PIPELINE_OWN_WRITES, [':!.mefisto/pipeline'])
  })
})

describe('createWorktree', () => {
  test('crea la rama desde origin/main recien traido, aunque el directorio este en otra rama', () => {
    const f = fixture()
    // origin/main avanza sin que el checkout local lo sepa, y el checkout esta en otra rama.
    const other = join(work, `otro-${counter}`)
    git(work, 'clone', '-q', '-b', 'main', f.bare, other)
    git(other, 'config', 'user.email', 'otro@mefisto.local')
    git(other, 'config', 'user.name', 'Otro')
    writeFiles(other, { 'nuevo.txt': 'en origin\n' })
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'avance en origin')
    git(other, 'push', '-q', 'origin', 'HEAD:main')
    git(f.root, 'checkout', '-q', '-b', 'trabajo-local')

    const path = createWorktree({ repoRoot: f.root, branch: 'worktree-issue-1-x', currentBranch: 'trabajo-local' }, f.tools)
    assert.equal(path, join(f.root, '.mefisto', 'pipeline', 'worktrees', 'worktree-issue-1-x'))
    assert.equal(git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-issue-1-x')
    assert.equal(git(path, 'rev-parse', 'HEAD'), git(f.bare, 'rev-parse', 'main'))
    assert.ok(existsSync(join(path, 'nuevo.txt')))
    assert.match(f.screen(), /^! cwd en rama 'trabajo-local' \(no main\/master\): el worktree se creara igual desde origin\/main$/m)
    assert.match(f.screen(), /Actualizando origin\/main\.\.\.\n.*Creando worktree: .* \(base: origin\/main\)\nv Worktree creado: /s)
  })

  test('en main no avisa de la rama', () => {
    const f = fixture()
    createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main' }, f.tools)
    assert.equal(f.screen().includes('cwd en rama'), false)
  })

  test('con path crea el worktree donde se le pide', () => {
    const f = fixture()
    const wanted = join(f.root, '.mefisto', 'worktrees', 'rama-propia')
    const path = createWorktree({ repoRoot: f.root, branch: 'rama-propia', currentBranch: 'main', path: wanted }, f.tools)
    assert.equal(path, wanted)
    assert.equal(git(wanted, 'rev-parse', '--abbrev-ref', 'HEAD'), 'rama-propia')
    assert.equal(existsSync(pipelineWorktreePath(f.root, 'rama-propia')), false)
  })

  test('un worktree de una corrida anterior se limpia y se vuelve a crear', () => {
    const f = fixture()
    const request = { repoRoot: f.root, branch: 'rama', currentBranch: 'main' }
    const path = createWorktree(request, f.tools)
    writeFiles(path, { 'sobra.txt': 'de la corrida anterior\n' })
    createWorktree(request, f.tools)
    assert.equal(existsSync(join(path, 'sobra.txt')), false)
    assert.match(f.screen(), /! El worktree ya existe: .* -- limpiando para reiniciar\.\.\./)
  })

  test('una rama huerfana sin worktree se elimina antes de crear', () => {
    const f = fixture()
    git(f.root, 'branch', 'rama')
    createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main' }, f.tools)
    assert.match(f.screen(), /! La rama rama ya existe sin worktree -- eliminandola\.\.\./)
  })

  test('aborta si no puede traer origin/main, con la causa en el log', () => {
    const f = fixture()
    git(f.root, 'remote', 'set-url', 'origin', join(work, 'no-existe.git'))
    assert.throws(() => createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main' }, f.tools), PipelineAbort)
    assert.match(f.screen(), /x ERROR: No se pudo hacer fetch de origin\/main/)
    assert.match(readFileSync(f.logFile, 'utf8'), /fatal: /)
  })

  test('aborta si git no puede crear el worktree', () => {
    const f = fixture()
    const tools = {
      ...f.tools,
      runLogged: loggedThrough((command, args, options) =>
        args[0] === 'worktree' && args[1] === 'add' ? { status: 128, stdout: '', stderr: 'fatal: invalido\n' } : capture(command, args, options),
      ),
    }
    assert.throws(() => createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main' }, tools), PipelineAbort)
    assert.match(f.screen(), /x ERROR: No se pudo crear el worktree desde origin\/main/)
  })

  test('los textos son un parametro', () => {
    const f = fixture()
    createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main', texts: { created: (path) => `Listo en ${path}` } }, f.tools)
    assert.match(f.screen(), /^v Listo en /m)
  })

  test('beforeCreate corre tras limpiar la corrida anterior y antes de anunciar la creacion', () => {
    const f = fixture()
    git(f.root, 'branch', 'rama')
    const seen: string[] = []
    createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main', beforeCreate: () => void seen.push(f.screen()) }, f.tools)
    assert.equal(seen.length, 1)
    assert.match(seen[0] ?? '', /La rama rama ya existe sin worktree/)
    assert.equal((seen[0] ?? '').includes('Creando worktree'), false)
  })

  test('si beforeCreate aborta no se crea el worktree', () => {
    const f = fixture()
    const request = {
      repoRoot: f.root,
      branch: 'rama',
      currentBranch: 'main',
      beforeCreate: () => f.tools.abort('effort invalido'),
    }
    assert.throws(() => createWorktree(request, f.tools), PipelineAbort)
    assert.equal(existsSync(pipelineWorktreePath(f.root, 'rama')), false)
    assert.equal(f.screen().includes('Creando worktree'), false)
  })
})

describe('resumeWorktree y removeWorktree', () => {
  test('retoma el worktree del estado del repo', () => {
    const f = fixture()
    const created = createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main' }, f.tools)
    assert.equal(resumeWorktree({ repoRoot: f.root, branch: 'rama', fromStage: '2' }, f.tools), created)
    assert.match(f.screen(), /Retomando desde Stage 2 -- worktree existente: /)
  })

  test('si solo existe el de la ubicacion anterior, usa ese', () => {
    const f = fixture()
    const legacy = legacyWorktreePath(f.root, 'rama-vieja')
    mkdirSync(legacy)
    assert.equal(resumeWorktree({ repoRoot: f.root, branch: 'rama-vieja', fromStage: '2' }, f.tools), legacy)
    assert.match(f.screen(), /Worktree no encontrado en la ruta nueva; usando el de la ruta anterior: /)
  })

  test('aborta si no hay worktree que retomar', () => {
    const f = fixture()
    assert.throws(() => resumeWorktree({ repoRoot: f.root, branch: 'nunca', fromStage: '2' }, f.tools), PipelineAbort)
    assert.match(f.screen(), /x ERROR: No existe el worktree en .*nunca\. No se puede retomar desde Stage 2\./)
  })

  test('removeWorktree lo borra aunque tenga cambios, y avisa si git no pudo', () => {
    const f = fixture()
    const path = createWorktree({ repoRoot: f.root, branch: 'rama', currentBranch: 'main' }, f.tools)
    writeFiles(path, { 'sucio.txt': 'x\n' })
    assert.equal(removeWorktree(f.root, path, f.tools), true)
    assert.equal(existsSync(path), false)
    assert.equal(removeWorktree(f.root, path, f.tools), false)
  })
})

describe('deteccion de trabajo y commit de seguridad', () => {
  test('el estado del pipeline no cuenta como trabajo; cualquier otra ruta si', () => {
    const f = fixture()
    const query = { run: capture }
    writeFiles(f.root, { '.mefisto/pipeline/summaries/stage-1-writer.md': 'resumen\n' })
    assert.equal(hasPendingChanges(query, f.root), false)
    writeFiles(f.root, { 'docs/adr/local.md': 'doc\n' })
    assert.equal(hasPendingChanges(query, f.root), true)
    assert.equal(hasPendingChanges(query, f.root, ['*.cs', '*.csproj']), false)
  })

  test('hasCommittedChanges compara dos commits; changedPaths filtra por pathspec', () => {
    const f = fixture()
    const query = { run: capture }
    const base = git(f.root, 'rev-parse', 'HEAD')
    assert.equal(hasCommittedChanges(query, f.root, base), false)
    writeFiles(f.root, { 'src/A.cs': 'class A {}\n', 'docs/a.md': 'a\n' })
    git(f.root, 'add', '.')
    git(f.root, 'commit', '-q', '-m', 'cambio')
    assert.equal(hasCommittedChanges(query, f.root, base), true)
    assert.equal(hasCommittedChanges(query, f.root, base, 'HEAD', ['README.md']), false)
    assert.equal(changedPaths(query, f.root, base, ['*.cs', '*.csproj']), 'src/A.cs')
    assert.equal(hasCommittedChanges(query, f.root, 'no-es-un-commit'), true, 'un git que falla cuenta como diferencia')
  })

  test('commitea lo pendiente bajo el pathspec y deja fuera lo excluido', () => {
    const f = fixture()
    writeFileSync(join(f.root, '.gitignore'), '')
    writeFiles(f.root, { 'scripts/x.sh': 'x\n', 'pipeline-state/senal.md': 's\n', '.mefisto/pipeline/events.log': 'e\n' })
    const pending: string[] = []
    const result = autoCommitIfNeeded(
      {
        worktree: f.root,
        message: 'tooling(#1): implementacion',
        pathspec: ['.', ...PIPELINE_OWN_WRITES, ':!pipeline-state'],
        addAll: true,
        onPending: () => void pending.push('pendiente'),
      },
      f.tools,
    )
    assert.deepEqual(result, { addStatus: 0, commitStatus: 0 })
    assert.deepEqual(pending, ['pendiente'])
    assert.equal(git(f.root, 'log', '-1', '--format=%s'), 'tooling(#1): implementacion')
    assert.equal(git(f.root, 'show', '--name-only', '--format=', 'HEAD'), '.gitignore\nscripts/x.sh')
  })

  test('sin nada pendiente no commitea ni avisa', () => {
    const f = fixture()
    const head = git(f.root, 'rev-parse', 'HEAD')
    const result = autoCommitIfNeeded(
      { worktree: f.root, message: 'm', pathspec: ['.', ...PIPELINE_OWN_WRITES], onPending: () => assert.fail('no habia nada') },
      f.tools,
    )
    assert.equal(result, null)
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), head)
  })

  test('devuelve los codigos de git para que cada pipeline decida si aborta', () => {
    const f = fixture()
    writeFiles(f.root, { 'tests/A.cs': 'a\n' })
    const tools = { ...f.tools, runLogged: loggedThrough(() => ({ status: 1, stdout: '', stderr: 'fallo\n' })) }
    assert.deepEqual(autoCommitIfNeeded({ worktree: f.root, message: 'm', pathspec: ['tests/', 'src/'] }, tools), { addStatus: 1, commitStatus: 1 })
  })

  test('con stopOnAddFailure un git add fallido no intenta el commit', () => {
    const f = fixture()
    writeFiles(f.root, { 'tests/A.cs': 'a\n' })
    const calls: string[][] = []
    const tools = {
      ...f.tools,
      runLogged: loggedThrough((_command, args) => {
        calls.push(args)
        return { status: 1, stdout: '', stderr: 'fallo\n' }
      }),
    }
    const result = autoCommitIfNeeded({ worktree: f.root, message: 'm', pathspec: ['tests/'], stopOnAddFailure: true }, tools)
    assert.deepEqual(result, { addStatus: 1, commitStatus: null })
    assert.deepEqual(calls.map((args) => args[2]), ['add'])
  })
})
