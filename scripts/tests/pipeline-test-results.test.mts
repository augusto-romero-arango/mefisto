import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { extractTestCount, runTestsProjects, testProjects, testsJsonValue } from '../lib/pipeline/test-results.mts'
import type { DotnetResult } from '../lib/pipeline/test-results.mts'
import { NO_BASH_TWIN, bashTwin } from './pipeline-metrics-parity.mts'

const PREFIX = 'Cosmos.ControlPlane'

// Salidas de `dotnet test` de la paridad: las de los tests de bash y las variantes de cada resumen.
const OUTPUTS: string[] = [
  'Test summary: total: 55, failed: 1, succeeded: 53, skipped: 1, duration: 1.2s',
  'Passed: 7',
  'Resumen de pruebas: correcto: 4',
  'sin resumen reconocible',
  'Resumen de pruebas: total: 100, error: 0, correcto: 100\nResumen de pruebas: total: 325, error: 0, correcto: 325',
  'Superado: 10  con errores: 0\nPassed: 20\nPruebas correctas: 5',
  'Test summary: total: 5, failed: 0, succeeded: 5\nPassed: 3\nSuperado: 2',
  'correcto: 60\ncorrecto: 365',
  '',
  'PASSED:\t4 passed:5x correctas: 0010\r\nPassed: 3\r\n',
  'succeeded: 9',
  'TEST SUMMARY: succeeded: 1, succeeded: 2',
  'Test summary: passed: 3, succeeded: 4',
  'passed:\n7',
  'Passed : 7',
  'correcto: -5 superado: 1.5',
  'Superado:   12\n\n\n',
]

interface Layout {
  name: string
  dirs: string[]
  files?: string[]
  extraArgs?: string[]
}

const LAYOUTS: Layout[] = [
  { name: 'dos proyectos y un smoke', dirs: [`${PREFIX}.Onboarding.Tests`, `${PREFIX}.Onboarding.SmokeTests`, `${PREFIX}.UserManagement.Tests`] },
  { name: 'solo smoke', dirs: [`${PREFIX}.Onboarding.SmokeTests`] },
  { name: 'un proyecto falla', dirs: [`${PREFIX}.FAIL_MARKER.Tests`, `${PREFIX}.UserManagement.Tests`] },
  { name: 'dos fallan con codigos distintos', dirs: [`${PREFIX}.B.FAIL_MARKER.Tests`, `${PREFIX}.A.OTRO_FALLO.Tests`, `${PREFIX}.C.Tests`] },
  { name: 'proyectos sin tests', dirs: [`${PREFIX}.A.SIN_TESTS.Tests`, `${PREFIX}.B.SIN_TESTS.Tests`] },
  { name: 'uno sin tests y otro que pasa', dirs: [`${PREFIX}.A.SIN_TESTS.Tests`, `${PREFIX}.B.Tests`] },
  { name: 'sin carpeta tests', dirs: [] },
  { name: 'nombres que no son del prefijo', dirs: ['Otra.Cosa.Tests', `${PREFIX}.Tests`, `${PREFIX}..Tests`, `${PREFIX}X.Y.Tests`, `${PREFIX}.Y.Tests.Extra`], files: [`${PREFIX}.Archivo.Tests`] },
  { name: 'orden por bytes', dirs: [`${PREFIX}.b.Tests`, `${PREFIX}.B.Tests`, `${PREFIX}.a.Tests`, `${PREFIX}.A-1.Tests`, `${PREFIX}.A.B.Tests`] },
  { name: 'flags extra', dirs: [`${PREFIX}.A.Tests`], extraArgs: ['--no-build', '--verbosity', 'quiet'] },
]

// El mismo `dotnet` simulado de los dos lados: registra el proyecto y responde por su nombre.
const DOTNET_STUB = `#!/usr/bin/env bash
if [ "$1" = "test" ]; then
    shift
    proj=""
    extra=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) proj="$2"; shift 2 ;;
            *) extra="$extra $1"; shift ;;
        esac
    done
    echo "$proj|$extra" >> "\${DOTNET_STUB_LOG:?}"
    case "$proj" in
        *FAIL_MARKER*) echo "Resumen de pruebas: total: 3, error: 1, correcto: 2"; echo "a stderr" >&2; exit 2 ;;
        *OTRO_FALLO*) printf 'fallo sin salto final'; exit 3 ;;
        *SIN_TESTS*) printf 'No hay tests\\n\\n\\n'; exit 8 ;;
    esac
    echo "Resumen de pruebas: total: 5, error: 0, correcto: 5"
    exit 0
fi
exit 0
`

function fakeDotnet(log: string[]): (args: string[]) => DotnetResult {
  return (args) => {
    const project = args[2] ?? ''
    log.push(`${project}|${args.slice(3).map((arg) => ` ${arg}`).join('')}`)
    if (project.includes('FAIL_MARKER')) return { status: 2, output: 'Resumen de pruebas: total: 3, error: 1, correcto: 2\na stderr\n' }
    if (project.includes('OTRO_FALLO')) return { status: 3, output: 'fallo sin salto final' }
    if (project.includes('SIN_TESTS')) return { status: 8, output: 'No hay tests\n\n\n' }
    return { status: 0, output: 'Resumen de pruebas: total: 5, error: 0, correcto: 5\n' }
  }
}

let work = ''

function worktreeFor(layout: Layout): string {
  const worktree = join(work, layout.name)
  rmSync(worktree, { recursive: true, force: true })
  mkdirSync(worktree, { recursive: true })
  for (const dir of layout.dirs) mkdirSync(join(worktree, 'tests', dir), { recursive: true })
  for (const file of layout.files ?? []) writeFileSync(join(worktree, 'tests', file), '')
  return worktree
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto-test-results-'))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('extractTestCount', () => {
  test('reconoce el resumen de Microsoft.Testing.Platform, el localizado y VSTest', () => {
    assert.equal(extractTestCount('Test summary: total: 55, failed: 1, succeeded: 53, skipped: 1, duration: 1.2s'), 53)
    assert.equal(extractTestCount('Passed: 7'), 7)
    assert.equal(extractTestCount('Resumen de pruebas: correcto: 4'), 4)
  })

  test('suma el resumen de cada proyecto, no solo el primero', () => {
    assert.equal(extractTestCount('Resumen de pruebas: total: 100, error: 0, correcto: 100\nResumen de pruebas: total: 325, error: 0, correcto: 325'), 425)
    assert.equal(extractTestCount('Superado: 10  con errores: 0\nPassed: 20\nPruebas correctas: 5'), 35)
    assert.equal(extractTestCount('Test summary: total: 5, failed: 0, succeeded: 5\nPassed: 3\nSuperado: 2'), 10)
  })

  test('mover tests entre proyectos no cambia el total', () => {
    assert.equal(extractTestCount('correcto: 100\ncorrecto: 325'), extractTestCount('correcto: 60\ncorrecto: 365'))
  })

  test('sin resumen reconocible no devuelve cero sino null', () => {
    assert.equal(extractTestCount('sin resumen reconocible'), null)
    assert.equal(extractTestCount(''), null)
    assert.equal(extractTestCount('succeeded: 9'), null)
  })
})

describe('testsJsonValue', () => {
  test('el conteo desconocido cruza al historial como null', () => {
    assert.equal(testsJsonValue('?'), null)
    assert.equal(testsJsonValue(extractTestCount('nada')), null)
    assert.equal(JSON.stringify({ tests: testsJsonValue('?') }), '{"tests":null}')
  })

  test('solo un entero no negativo es un conteo', () => {
    assert.equal(testsJsonValue('12'), 12)
    assert.equal(testsJsonValue(12), 12)
    assert.equal(testsJsonValue('0'), 0)
    for (const text of ['', '-1', '1.5', '12 ', 'doce', 'null']) assert.equal(testsJsonValue(text), null, text)
  })
})

describe('runTestsProjects', () => {
  test('corre los proyectos *.Tests y deja fuera los *.SmokeTests', () => {
    const log: string[] = []
    const worktree = worktreeFor(LAYOUTS[0] as Layout)
    const run = runTestsProjects(worktree, PREFIX, [], fakeDotnet(log))
    assert.equal(run.status, 0)
    assert.deepEqual(
      log.map((line) => basename(line.split('|')[0] ?? '')),
      [`${PREFIX}.Onboarding.Tests`, `${PREFIX}.UserManagement.Tests`],
    )
    assert.equal(log[0], `${join(worktree, 'tests', `${PREFIX}.Onboarding.Tests`)}${sep}|`)
    assert.equal(run.output, 'Resumen de pruebas: total: 5, error: 0, correcto: 5\n'.repeat(2))
    assert.equal(extractTestCount(run.output), 10)
  })

  test('sin ningun proyecto con tests devuelve 8', () => {
    assert.deepEqual(runTestsProjects(worktreeFor(LAYOUTS[1] as Layout), PREFIX, [], fakeDotnet([])), { output: '', status: 8 })
    assert.equal(runTestsProjects(worktreeFor(LAYOUTS[4] as Layout), PREFIX, [], fakeDotnet([])).status, 8)
    assert.equal(runTestsProjects(worktreeFor(LAYOUTS[5] as Layout), PREFIX, [], fakeDotnet([])).status, 0)
  })

  test('propaga el primer codigo de fallo y sigue con los demas proyectos', () => {
    const log: string[] = []
    const run = runTestsProjects(worktreeFor(LAYOUTS[3] as Layout), PREFIX, [], fakeDotnet(log))
    assert.equal(run.status, 3)
    assert.equal(log.length, 3)
    assert.equal(run.output, 'fallo sin salto final\nResumen de pruebas: total: 3, error: 1, correcto: 2\na stderr\nResumen de pruebas: total: 5, error: 0, correcto: 5\n')
  })

  test('pasa los flags extra a dotnet test', () => {
    const log: string[] = []
    runTestsProjects(worktreeFor(LAYOUTS[9] as Layout), PREFIX, ['--no-build', '--verbosity', 'quiet'], fakeDotnet(log))
    assert.match(log[0] ?? '', /\| --no-build --verbosity quiet$/)
  })

  test('un proceso que no arranca cuenta como fallo 127', () => {
    const run = runTestsProjects(worktreeFor(LAYOUTS[9] as Layout), PREFIX, [], () => ({ status: null, output: '' }))
    assert.deepEqual(run, { output: '\n', status: 127 })
  })

  test('testProjects solo lista carpetas <prefijo>.*.Tests', () => {
    const worktree = worktreeFor(LAYOUTS[7] as Layout)
    assert.deepEqual(testProjects(worktree, PREFIX).map((project) => basename(project)), [`${PREFIX}..Tests`])
    assert.deepEqual(testProjects(join(work, 'no-existe'), PREFIX), [])
  })
})

describe('paridad con la gemela bash', { skip: NO_BASH_TWIN }, () => {
  test('extract_test_count', () => {
    for (const output of OUTPUTS) {
      const count = extractTestCount(output)
      assert.equal(`${count ?? '?'}\n`, bashTwin('extract_test_count "$@"', [output]).stdout, output)
    }
  })

  test('tests_json_value', () => {
    for (const text of ['?', '', '0', '12', '-1', '1.5', '12 ', 'doce', 'null']) {
      assert.equal(`${JSON.stringify(testsJsonValue(text))}\n`, bashTwin('tests_json_value "$@"', [text]).stdout, text)
    }
  })

  for (const layout of LAYOUTS) {
    test(`run_tests_projects: ${layout.name}`, () => {
      const worktree = worktreeFor(layout)
      const bin = join(work, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'dotnet'), DOTNET_STUB)
      chmodSync(join(bin, 'dotnet'), 0o755)
      const bashLog = join(work, 'dotnet-bash.log')
      writeFileSync(bashLog, '')
      const bash = bashTwin('run_tests_projects "$@"', [worktree, ...(layout.extraArgs ?? [])], {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HARNESS_NAMESPACE_PREFIX: PREFIX,
        DOTNET_STUB_LOG: bashLog,
        LC_ALL: 'C',
      })
      const log: string[] = []
      const run = runTestsProjects(worktree, PREFIX, layout.extraArgs ?? [], fakeDotnet(log))
      assert.equal(run.status, bash.status)
      assert.equal(run.output, bash.stdout)
      assert.equal(log.map((line) => `${line}\n`).join(''), readFileSync(bashLog, 'utf8'))
    })
  }
})
