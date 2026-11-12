// Piezas del batch interno en aislamiento: registro de estados, status JSON, contabilidad de la
// espera (hold) y sync verificado de main.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { capture } from '../../../scripts/lib/cli.mts'
import { loggedThrough } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { git, isolateGitConfig, newRepo } from '../../../scripts/tests/field-note-sandbox.mts'
import { executionRootPath, syncMainAfterMerge } from '../../../src/internal/scripts/lib/mefisto-batch-git.mts'
import type { BatchGit } from '../../../src/internal/scripts/lib/mefisto-batch-git.mts'
import {
  DEFERRED_STATUS,
  deferFromIndex,
  getPr,
  getStatus,
  holdSecondsInRange,
  newBatchTracker,
  renderBatchStatus,
  setPr,
  setStatus,
} from '../../../src/internal/scripts/lib/mefisto-batch-records.mts'
import { holdLine } from './mefisto-batch-pipeline-sandbox.mts'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const CANON_MTS = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-batch-pipeline.mts')

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto batch unidades ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

const caseDir = (name: string): string => {
  counter++
  const dir = join(work, `${name}-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('registro del batch', () => {
  test('set/get de estado y PR; un issue desconocido no tiene estado ni PR', () => {
    let writes = 0
    const tracker = newBatchTracker(() => writes++)
    setStatus(tracker, '11', 'pendiente')
    setPr(tracker, '11', '1011')
    setPr(tracker, '12', '1012')
    assert.equal(getStatus(tracker, '11'), 'pendiente')
    assert.equal(getPr(tracker, '11'), '1011')
    assert.equal(getStatus(tracker, '12'), 'pendiente', 'un PR de un issue nuevo lo agrega pendiente')
    assert.equal(getStatus(tracker, '99'), 'desconocido')
    assert.equal(getPr(tracker, '99'), '')
    assert.equal(writes, 3, 'cada cambio reescribe el status')
  })

  test('sin senal no hay parada; deferFromIndex consume la senal y aplaza solo desde el indice', () => {
    const dir = caseDir('senal')
    const signal = join(dir, 'batch-stop')
    const tracker = newBatchTracker()
    const issues = ['101', '102', '103']
    for (const issue of issues) setStatus(tracker, issue, 'pendiente')
    assert.equal(existsSync(signal), false)
    writeFileSync(signal, '')
    deferFromIndex(tracker, issues, 1, signal)
    assert.equal(existsSync(signal), false, 'la senal se consume')
    assert.equal(getStatus(tracker, '101'), 'pendiente', 'el anterior al indice no se toca')
    assert.equal(getStatus(tracker, '102'), DEFERRED_STATUS)
    assert.equal(getStatus(tracker, '103'), DEFERRED_STATUS)
    assert.doesNotThrow(() => deferFromIndex(tracker, issues, 3, signal), 'aplazar cero issues sin senal no falla')
  })

  test('el status es el JSON que armaba jq: issue y PR como texto, estado libre', () => {
    const rendered = renderBatchStatus({
      started: '20260101-000000',
      state: 'running',
      current: '12',
      stopRequested: true,
      holdSeconds: 90,
      log: '/tmp/mefisto-batch.log',
      entries: [
        { issue: '11', status: 'completado (PR #1011 mergeado)', pr: '1011' },
        { issue: '12', status: 'en curso', pr: '' },
      ],
    })
    assert.equal(
      rendered,
      `${JSON.stringify(
        {
          pipeline: 'mefisto-batch',
          started: '20260101-000000',
          state: 'running',
          current: '12',
          stop_requested: true,
          hold_seconds: 90,
          log: '/tmp/mefisto-batch.log',
          issues: [
            { issue: '11', status: 'completado (PR #1011 mergeado)', pr: '1011' },
            { issue: '12', status: 'en curso', pr: null },
          ],
        },
        null,
        2,
      )}\n`,
    )
    assert.match(
      renderBatchStatus({ started: 's', state: 'completed', current: '', stopRequested: false, holdSeconds: 0, log: 'l', entries: [] }),
      /"current": null,[\s\S]*"issues": \[\]/,
    )
  })
})

describe('espera (hold) por eslabon', () => {
  const session = (issue: string): string => `=== SESSION MEFISTO-TOOLING 20260101-090000 issue:${issue} from-stage:1 ===`

  test('suma los ciclos [hold], ignora [hold][resume] y respeta el offset de linea', () => {
    const file = join(caseDir('hold'), 'events.log')
    writeFileSync(
      file,
      [session('900'), holdLine('12:00:00', '12:05:00'), holdLine('12:10:00', '12:14:10'), '[12:15:00][hold][resume] writer: reanudando sesion abc123', ''].join('\n'),
    )
    assert.equal(holdSecondsInRange(file, 0), 550)
    assert.equal(holdSecondsInRange(file, 2, '900'), 0, 'desde la linea 2 la cabecera de sesion ya quedo atras')
    assert.equal(holdSecondsInRange(file, 2), 250, 'el offset excluye el ciclo anterior al rango')
  })

  test('con issue solo cuentan los ciclos bajo su cabecera de sesion', () => {
    const file = join(caseDir('hold'), 'events.log')
    writeFileSync(file, [session('900'), holdLine('12:00:00', '12:05:00'), session('999'), holdLine('12:20:00', '12:22:00'), ''].join('\n'))
    assert.equal(holdSecondsInRange(file, 0, '900'), 300)
    assert.equal(holdSecondsInRange(file, 0), 420)
    assert.equal(holdSecondsInRange(file, 0, '777'), 0, 'un issue sin cabecera propia nunca hereda la del vecino')
  })

  test('un ciclo que cruza la medianoche suma un dia; sin archivo o sin salto final no cuenta', () => {
    const dir = caseDir('hold')
    const file = join(dir, 'events.log')
    writeFileSync(file, `${holdLine('23:59:00', '00:01:00')}\n${holdLine('12:00:00', '12:05:00')}`)
    assert.equal(holdSecondsInRange(file, 0), 120, 'la ultima linea sin salto final no la entrega read')
    assert.equal(holdSecondsInRange(join(dir, 'no-existe.log'), 0), 0)
  })

  test('una cabecera de otro pipeline no cambia la atribucion', () => {
    const file = join(caseDir('hold'), 'events.log')
    writeFileSync(file, [session('900'), '=== SESSION TOOLING 20260101 issue:5 ===', holdLine('12:00:00', '12:01:00'), ''].join('\n'))
    assert.equal(holdSecondsInRange(file, 0, '900'), 60)
  })
})

interface SyncCase {
  work: string
  publisher: string
  /** SHA que reporta `gh pr view`. */
  sha: string
  warnings: string[]
  slept: number[]
  ctx: BatchGit
}

/** Remoto bare, un publisher que simula el merge y un clon de trabajo. */
function syncCase(name: string): SyncCase {
  const dir = caseDir(name)
  const repo = newRepo(join(dir, 'base'), { '.gitignore': '.mefisto/\n', 'README.md': 'c1\n' })
  git(repo.bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const publisher = join(dir, 'publisher')
  const workDir = join(dir, 'work')
  for (const clone of [publisher, workDir]) {
    git(dir, 'clone', '-q', repo.bare, clone)
    git(clone, 'config', 'user.email', 'test@mefisto.local')
    git(clone, 'config', 'user.name', 'Mefisto Test')
  }
  const logFile = join(dir, 'batch.log')
  writeFileSync(logFile, '')
  const state: SyncCase = {
    work: workDir,
    publisher,
    sha: '',
    warnings: [],
    slept: [],
    ctx: undefined as unknown as BatchGit,
  }
  const run: Run = (command, args, options) =>
    command === 'gh' ? { status: 0, stdout: `${state.sha}\n`, stderr: '' } : capture(command, args, options)
  state.ctx = {
    root: workDir,
    env: process.env,
    run,
    runLogged: loggedThrough(run),
    logFile,
    warn: (message) => void state.warnings.push(message),
    sleep: async (seconds) => void state.slept.push(seconds),
  }
  return state
}

const publish = (sync: SyncCase, message: string): string => {
  git(sync.publisher, 'commit', '-q', '--allow-empty', '-m', message)
  git(sync.publisher, 'push', '-q', 'origin', 'main')
  return git(sync.publisher, 'rev-parse', 'main')
}

describe('sync verificado de main', () => {
  test('rama activa cambiada: fast-forward de main por nombre sin tocar HEAD, codigo 0', async () => {
    const sync = syncCase('sync-a')
    git(sync.work, 'checkout', '-q', '-b', 'docs/otra-sesion-en-paralelo')
    sync.sha = publish(sync, 'c2 merge')
    const result = await syncMainAfterMerge('565', 'main', sync.ctx)
    assert.deepEqual(result, { code: 0, mergeSha: sync.sha })
    assert.equal(git(sync.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'docs/otra-sesion-en-paralelo')
    assert.equal(git(sync.work, 'rev-parse', 'refs/heads/main'), sync.sha)
    assert.ok(sync.warnings.some((line) => line.includes("rama activa del repo cambio a 'docs/otra-sesion-en-paralelo'")))
    assert.ok(!sync.warnings.some((line) => /divergencia/i.test(line)), 'no culpa a una divergencia inexistente')
  })

  test('rama activa cambiada y main divergente: codigo 1 con la rama observada, main intacto', async () => {
    const sync = syncCase('sync-b')
    git(sync.work, 'commit', '-q', '--allow-empty', '-m', 'local divergente')
    const divergent = git(sync.work, 'rev-parse', 'main')
    git(sync.work, 'checkout', '-q', '-b', 'feature-en-paralelo')
    sync.sha = publish(sync, 'c3 merge')
    const result = await syncMainAfterMerge('566', 'main', sync.ctx)
    assert.deepEqual(result, { code: 1, mergeSha: sync.sha })
    assert.equal(git(sync.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-en-paralelo')
    assert.equal(git(sync.work, 'rev-parse', 'refs/heads/main'), divergent)
    assert.ok(sync.warnings.some((line) => line.includes("rama activa observada: 'feature-en-paralelo'")))
  })

  test('en main y divergente: codigo 1 que nombra la posible divergencia local', async () => {
    const sync = syncCase('sync-diverge')
    git(sync.work, 'commit', '-q', '--allow-empty', '-m', 'local divergente')
    sync.sha = publish(sync, 'merge')
    const result = await syncMainAfterMerge('570', 'main', sync.ctx)
    assert.equal(result.code, 1)
    assert.ok(sync.warnings.some((line) => line.includes("no se pudo fast-forwardear 'main' local a origin/main (posible divergencia local)")))
  })

  test('commits locales ya rescatados por el hook pre-push: se remedia y queda en codigo 0', async () => {
    const sync = syncCase('sync-rescate')
    git(sync.work, 'commit', '-q', '--allow-empty', '-m', 'rescatado')
    const rescued = git(sync.work, 'rev-parse', 'main')
    mkdirSync(join(sync.work, '.mefisto', 'pipeline'), { recursive: true })
    writeFileSync(join(sync.work, '.mefisto', 'pipeline', 'rescued-main.txt'), `${rescued}\n`)
    sync.sha = publish(sync, 'merge')
    const result = await syncMainAfterMerge('571', 'main', sync.ctx)
    assert.deepEqual(result, { code: 0, mergeSha: sync.sha })
    assert.equal(git(sync.work, 'rev-parse', 'main'), sync.sha)
    assert.ok(sync.warnings.some((line) => line.includes("se hizo 'git reset --keep origin/main'")))
  })

  test('el merge nunca llega a origin/main: codigo 2 tras tres reintentos', async () => {
    const sync = syncCase('sync-c')
    sync.sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const result = await syncMainAfterMerge('567', 'main', sync.ctx)
    assert.deepEqual(result, { code: 2, mergeSha: '' })
    assert.ok(sync.warnings.some((line) => line.includes('no aparece en origin/main')))
    assert.deepEqual(sync.slept, [2, 2, 2])
  })

  test('sin commit de merge reportado: codigo 2 tras tres consultas', async () => {
    const sync = syncCase('sync-sin-sha')
    sync.sha = 'null'
    const result = await syncMainAfterMerge('568', 'main', sync.ctx)
    assert.deepEqual(result, { code: 2, mergeSha: '' })
    assert.deepEqual(sync.warnings, ['sync: no se pudo determinar el commit de merge del PR #568'])
    assert.deepEqual(sync.slept, [2, 2, 2])
  })

  test('la raiz ejecutable conserva la forma que reconoce mefisto-worktree clean', () => {
    assert.equal(executionRootPath(join('r'), '20260101-000000', 4242), join('r', '.mefisto', 'worktrees', 'mefisto-batch-execution-20260101-000000-4242'))
  })
})

describe('fuente', () => {
  test('ninguna linea de codigo nombra rutas legacy de .claude', () => {
    const code = readFileSync(CANON_MTS, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
    for (const needle of ['.claude/pipeline', '.claude/scripts']) {
      assert.deepEqual(code.filter((line) => line.includes(needle)), [], needle)
    }
  })

  test('fuera de un repo git el .mts termina en 1 con el error de la guarda', () => {
    const dir = caseDir('sin-repo')
    const result = spawnSync(process.execPath, [CANON_MTS], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ERROR: no estas en un repositorio git/)
  })

})
