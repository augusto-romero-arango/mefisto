import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildReport,
  findResultFiles,
  parseResults,
} from '../../../src/internal/scripts/mefisto-nightly-report.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', '..', '..', 'src', 'internal', 'scripts', 'mefisto-nightly-report.mts')
const RUN_URL = 'https://github.com/o/r/actions/runs/42'
const SHA = 'abc1234def'

let work = ''

type Row = [order: string, path: string, state: string]

function row([order, path, state]: Row): string {
  const rest = state === 'CANCELLED' ? ['-', '-', '-', '-', '-'] : [state === 'PASS' ? '0' : '1', '1', '2', '1', 'log']
  return `${[order, path, state, ...rest].join('\t')}\n`
}

function job(suite: string, name: string, rows: Row[]): void {
  const dir = join(work, suite, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'results.tsv'), rows.map(row).join(''))
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto nightly '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('buildReport', () => {
  test('[A] todos PASS: conteos y ninguna ruta con FAIL', () => {
    job('a', 'publicado', [['1', 't1.sh', 'PASS']])
    job('a', 'interno', [['1', 't2.sh', 'PASS']])
    const report = buildReport(join(work, 'a'), RUN_URL, SHA)
    assert.ok(report.includes(`- Run: ${RUN_URL}`))
    assert.ok(report.includes(`- SHA evaluado: \`${SHA}\``))
    assert.ok(report.includes('Total: PASS=2 FAIL=0'))
    assert.ok(report.includes('(ninguna: todos los archivos de test pasaron'))
  })

  test('[B] FAIL en dos jobs: totales, conteo por job y lista de rutas', () => {
    job('b', 'publicado', [
      ['1', 'scripts/tests/test-ok.sh', 'PASS'],
      ['2', 'scripts/tests/test-rojo-a.sh', 'FAIL'],
    ])
    job('b', 'interno', [
      ['1', '.claude/scripts/tests/test-rojo-b.sh', 'FAIL'],
      ['2', '.claude/scripts/tests/test-ok2.sh', 'PASS'],
      ['3', '.claude/scripts/tests/test-ok3.sh', 'PASS'],
    ])
    const report = buildReport(join(work, 'b'), RUN_URL, SHA)
    assert.ok(report.includes('Total: PASS=3 FAIL=2'))
    assert.ok(report.includes('| publicado | 1 | 1 |'))
    assert.ok(report.includes('| interno | 2 | 1 |'))
    assert.ok(report.includes('- `scripts/tests/test-rojo-a.sh` (job `publicado`)'))
    assert.ok(report.includes('- `.claude/scripts/tests/test-rojo-b.sh` (job `interno`)'))
    assert.equal(report.includes('test-ok.sh'), false)
    assert.equal(report.includes('CANCELLED'), false)
  })

  test('[D] las entradas CANCELLED se reportan aparte, sin contar como PASS ni FAIL', () => {
    job('d', 'interno', [
      ['1', 't-rojo.sh', 'FAIL'],
      ['2', 't-cortado.sh', 'CANCELLED'],
    ])
    const report = buildReport(join(work, 'd'), RUN_URL, SHA)
    assert.ok(report.includes('Total: PASS=0 FAIL=1'))
    assert.ok(report.includes('CANCELLED=1: entradas interrumpidas'))
    assert.ok(report.includes('| interno | 0 | 1 |'))
  })

  test('[C] sin ningun results.tsv lo dice de forma explicita', () => {
    mkdirSync(join(work, 'c'))
    for (const dir of [join(work, 'c'), join(work, 'no-existe')]) {
      const report = buildReport(dir, RUN_URL, SHA)
      assert.ok(report.includes('La suite no produjo resultados'))
      assert.ok(report.includes(RUN_URL))
      assert.equal(report.includes('### Conteo'), false)
    }
  })

  test('el cuerpo completo conserva el formato del issue', () => {
    job('e', 'interno', [
      ['1', 'a.sh', 'FAIL'],
      ['2', 'b.sh', 'CANCELLED'],
    ])
    assert.equal(
      buildReport(join(work, 'e'), RUN_URL, SHA),
      [
        '## Nightly roja',
        '',
        `- Run: ${RUN_URL}`,
        `- SHA evaluado: \`${SHA}\``,
        '',
        '### Conteo',
        '',
        'Total: PASS=0 FAIL=1',
        '',
        'CANCELLED=1: entradas interrumpidas o que no llegaron a correr (timeout o cancelacion del job).',
        '',
        '| Job | PASS | FAIL |',
        '|---|---|---|',
        '| interno | 0 | 1 |',
        '',
        '### Rutas con FAIL',
        '',
        '- `a.sh` (job `interno`)',
        '',
      ].join('\n'),
    )
  })
})

describe('findResultFiles', () => {
  test('busca a cualquier profundidad y ordena los jobs por ruta', () => {
    job('f', 'zeta', [])
    job('f', 'alfa', [])
    job(join('f', 'medio'), 'hondo', [])
    writeFileSync(join(work, 'f', 'otro.tsv'), '')
    assert.deepEqual(findResultFiles(join(work, 'f')), [
      join(work, 'f', 'alfa', 'results.tsv'),
      join(work, 'f', 'medio', 'hondo', 'results.tsv'),
      join(work, 'f', 'zeta', 'results.tsv'),
    ])
  })

  test('un archivo en lugar de un directorio no tiene resultados', () => {
    const file = join(work, 'no-es-directorio')
    writeFileSync(file, '')
    assert.deepEqual(findResultFiles(file), [])
  })
})

describe('parseResults', () => {
  test('lee las tres primeras columnas e ignora las lineas vacias', () => {
    const text = '1\ta.sh\tPASS\t0\n\n2\tb.sh\tFAIL\t1\n3\tc.sh\tCANCELLED\t-\n4\td.sh\tOTRO\n'
    assert.deepEqual(parseResults(text), { pass: 1, fail: 1, cancelled: 1, failedPaths: ['b.sh'] })
  })

  test('lee las lineas como el `read` de bash que consumia estos TSV', () => {
    // La ultima linea sin salto final no cuenta.
    assert.deepEqual(parseResults('1\ta.sh\tFAIL\n2\tb.sh\tFAIL').failedPaths, ['a.sh'])
    // Los tabuladores seguidos se colapsan: un campo vacio corre los demas.
    assert.equal(parseResults('3\t\tFAIL\n').fail, 0)
    assert.equal(parseResults('\t4\td.sh\tPASS\n').pass, 1)
    // Con CRLF y solo tres columnas, el estado arrastra el retorno de carro.
    assert.equal(parseResults('1\ta.sh\tFAIL\r\n').fail, 0)
    assert.equal(parseResults('1\ta.sh\tFAIL\t1\r\n').fail, 1)
  })
})

describe('linea de comandos', () => {
  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  }

  test('escribe el cuerpo en stdout y sale con 0, tambien sin resultados', () => {
    job('g', 'interno', [['1', 't.sh', 'PASS']])
    const withResults = run([join(work, 'g'), RUN_URL, SHA])
    assert.equal(withResults.status, 0)
    assert.equal(withResults.stdout, buildReport(join(work, 'g'), RUN_URL, SHA))
    const without = run([join(work, 'no-existe'), RUN_URL, SHA])
    assert.equal(without.status, 0)
    assert.ok(without.stdout.includes('no produjo resultados'))
  })

  test('sin los tres argumentos muestra el uso y sale con 2', () => {
    for (const args of [[], ['a', 'b'], ['a', 'b', 'c', 'd']]) {
      const result = run(args)
      assert.equal(result.status, 2)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /^Uso: .* <log-dir> <run-url> <sha>\n$/)
    }
  })
})
