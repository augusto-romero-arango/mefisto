import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestEvent } from 'node:test/reporters'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildReport } from '../../../src/internal/scripts/mefisto-nightly-report.mts'
import type { FileState } from '../../../src/internal/scripts/lib/mefisto-nightly-reporter.mts'
import { eventState, record, resultsTsv } from '../../../src/internal/scripts/lib/mefisto-nightly-reporter.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORTER = join(HERE, '..', '..', '..', 'src', 'internal', 'scripts', 'lib', 'mefisto-nightly-reporter.mts')

function pass(file: string | undefined, nesting = 0): TestEvent {
  return { type: 'test:pass', data: { name: 't', nesting, file, testNumber: 1, details: { duration_ms: 1 } } } as TestEvent
}

function fail(file: string | undefined, options: { nesting?: number; todo?: boolean; failureType?: string } = {}): TestEvent {
  const error = Object.assign(new Error('x'), { failureType: options.failureType ?? 'testCodeFailure' })
  return {
    type: 'test:fail',
    data: { name: 't', nesting: options.nesting ?? 0, file, testNumber: 1, todo: options.todo, details: { duration_ms: 1, error } },
  } as TestEvent
}

describe('eventState', () => {
  test('cuenta solo los eventos de primer nivel con archivo', () => {
    assert.deepEqual(eventState(pass('/r/a.test.mts')), { file: '/r/a.test.mts', state: 'PASS' })
    assert.deepEqual(eventState(fail('/r/a.test.mts')), { file: '/r/a.test.mts', state: 'FAIL' })
    assert.equal(eventState(fail('/r/a.test.mts', { nesting: 1 })), null)
    assert.equal(eventState(pass(undefined)), null)
    assert.equal(eventState({ type: 'test:watch:drained', data: undefined }), null)
  })

  test('un todo que falla no cuenta y una cancelacion se distingue del fallo', () => {
    assert.equal(eventState(fail('/r/a.test.mts', { todo: true })), null)
    assert.deepEqual(eventState(fail('/r/a.test.mts', { failureType: 'cancelledByParent' })), {
      file: '/r/a.test.mts',
      state: 'CANCELLED',
    })
  })
})

describe('record y resultsTsv', () => {
  test('FAIL pesa mas que CANCELLED y este que PASS, sin importar el orden', () => {
    const states = new Map<string, FileState>()
    for (const event of [
      fail(join('/r', 'b.test.mts')),
      pass(join('/r', 'b.test.mts')),
      pass(join('/r', 'a.test.mts')),
      fail(join('/r', 'c', 'd.test.mts'), { failureType: 'cancelledByParent' }),
      pass(join('/r', 'c', 'd.test.mts')),
    ]) {
      record(states, event)
    }
    assert.equal(resultsTsv(states, '/r'), '1\ta.test.mts\tPASS\n2\tb.test.mts\tFAIL\n3\tc/d.test.mts\tCANCELLED\n')
  })

  test('sin archivos no escribe nada', () => {
    assert.equal(resultsTsv(new Map(), '/r'), '')
  })
})

describe('node --test con el reporter', () => {
  let work = ''

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'mefisto nightly reporter '))
    writeFileSync(
      join(work, 'rojo.test.mts'),
      [
        "import { describe, test } from 'node:test'",
        "describe('grupo', () => { test('bien', () => {}); test('mal', () => { throw new Error('x') }) })",
        "test('pendiente', { todo: true }, () => { throw new Error('t') })",
        '',
      ].join('\n'),
    )
    writeFileSync(join(work, 'verde.test.mts'), "import { test } from 'node:test'\ntest('bien', () => {})\n")
    writeFileSync(join(work, 'no-carga.test.mts'), "throw new Error('carga')\n")
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  test('deja una linea por archivo que el reporte de la nightly lee', () => {
    const lane = join(work, 'logs', 'tests-macos-26-node-22.18.0')
    const results = join(work, 'results.tsv')
    // Sin NODE_TEST_CONTEXT: con el del test que lo lanza, el hijo reportaria a este proceso.
    const env = { ...process.env }
    delete env['NODE_TEST_CONTEXT']
    // Una ruta absoluta de Windows no es un especificador valido: el reporter se pasa como URL.
    const run = spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${pathToFileURL(REPORTER).href}`, `--test-reporter-destination=${results}`, '*.test.mts'],
      { cwd: work, env, encoding: 'utf8' },
    )
    assert.equal(run.status, 1, run.stderr)
    const tsv = readFileSync(results, 'utf8')
    assert.equal(tsv, '1\tno-carga.test.mts\tFAIL\n2\trojo.test.mts\tFAIL\n3\tverde.test.mts\tPASS\n')

    mkdirSync(lane, { recursive: true })
    writeFileSync(join(lane, 'results.tsv'), tsv)
    const report = buildReport(join(work, 'logs'), 'https://run', 'abc')
    assert.ok(report.includes('Total: PASS=1 FAIL=2'))
    assert.ok(report.includes('- `rojo.test.mts` (job `tests-macos-26-node-22.18.0`)'))
  })
})
