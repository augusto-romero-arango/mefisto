// Medicion del coverage gate (#1550): dotnet-coverage corre solo los `*.Tests`, conserva el
// codigo de los tests que fallan y distingue esa causa de un fallo de instrumentacion.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, describe, test } from 'node:test'

import { capture } from '../lib/cli.mts'
import { createPipelineLog, stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import {
  COVERAGE_RC,
  COVERAGE_XML,
  coverageSkipReason,
  instrumentableDlls,
  measureCoverage,
  pythonRound1,
  runCoverageTests,
  uncoveredRanges,
} from '../lib/pipeline/tdd-coverage.mts'
import type { CoverageRun } from '../lib/pipeline/tdd-coverage.mts'

const PREFIX = 'Cosmos.ControlPlane'
const work = mkdtempSync(join(tmpdir(), 'mefisto tdd coverage '))
after(() => rmSync(work, { recursive: true, force: true }))
let counter = 0

function worktree(projects: Record<string, string[]>): string {
  const dir = join(work, `wt-${++counter}`)
  for (const [project, dlls] of Object.entries(projects)) {
    const bin = join(dir, 'tests', project, 'bin', 'Debug', 'net10.0')
    mkdirSync(bin, { recursive: true })
    for (const dll of dlls) writeFileSync(join(bin, dll), '')
  }
  return dir
}

interface Harness {
  run: CoverageRun
  calls: string[][]
  tested: string[]
  out: () => string
  log: ReturnType<typeof createPipelineLog>
}

/** dotnet y dotnet-coverage falsos: `collect` corre de verdad `runCoverageTests` con un dotnet falso. */
function harness(options: { build?: number; instrument?: number; failing?: string; timeoutOn?: string } = {}): Harness {
  let text = ''
  const logFile = join(work, `log-${++counter}`)
  const tested: string[] = []
  const calls: string[][] = []
  const run: CoverageRun = (command, args) => {
    calls.push([command, ...args])
    if (options.timeoutOn !== undefined && args[0] === options.timeoutOn) return { status: null, timedOut: true }
    if (command === 'dotnet') return { status: options.build ?? 0, timedOut: false }
    if (args[0] === 'instrument') return { status: options.instrument ?? 0, timedOut: false }
    const output = args[args.indexOf('--output') + 1] ?? ''
    const [wt = '', prefix = ''] = args.slice(args.indexOf('run-tests') + 1)
    const rc = runCoverageTests(wt, prefix, (testArgs) => {
      const project = testArgs[testArgs.indexOf('--project') + 1] ?? ''
      tested.push(project)
      return options.failing !== undefined && project.endsWith(`${options.failing}${sep}`) ? 2 : 0
    })
    writeFileSync(output, '<coverage/>\n')
    return { status: rc, timedOut: false }
  }
  const log = createPipelineLog({ logFile: () => logFile, out: (chunk) => void (text += chunk) })
  return { run, calls, tested, out: () => stripAnsi(text), log }
}

describe('recoleccion con dotnet-coverage', () => {
  test('conserva el exit 2 del test, devuelve 3, deja el XML y nunca corre un SmokeTests', () => {
    const wt = worktree({
      [`${PREFIX}.Unit.Tests`]: [`${PREFIX}.Domain.dll`],
      [`${PREFIX}.Failing.Tests`]: [`${PREFIX}.Domain.dll`],
      [`${PREFIX}.Api.SmokeTests`]: [`${PREFIX}.Domain.dll`],
    })
    const h = harness({ failing: `${PREFIX}.Failing.Tests` })
    const measurement = measureCoverage(wt, PREFIX, { run: h.run, log: h.log })
    assert.deepEqual(measurement, { exit: 3, timedOut: false })
    assert.equal(readFileSync(join(wt, COVERAGE_RC), 'utf8'), '2\n')
    assert.equal(existsSync(join(wt, COVERAGE_XML)), true)
    assert.equal(h.tested.some((project) => project.includes('SmokeTests')), false)
    assert.deepEqual(h.tested.map((project) => project.split(sep).at(-2)), [`${PREFIX}.Failing.Tests`])
    assert.equal(coverageSkipReason(measurement.exit, wt), 'SKIP coverage-gate: tests fallaron bajo cobertura (exit code 2)')
    assert.match(h.out(), /! dotnet-coverage collect termino con exit code 2\n/)
  })

  test('sin XML se reporta fallo de instrumentacion', () => {
    const wt = worktree({})
    mkdirSync(wt, { recursive: true })
    assert.equal(coverageSkipReason(1, wt), 'SKIP coverage-gate: instrumentacion fallo')
    writeFileSync(join(wt, COVERAGE_RC), '2\n')
    assert.equal(coverageSkipReason(3, wt), 'SKIP coverage-gate: instrumentacion fallo')
  })

  test('medicion exitosa: instrumenta una vez cada DLL del prefijo y envuelve la corrida de tests con Node', () => {
    const wt = worktree({
      [`${PREFIX}.A.Tests`]: [`${PREFIX}.Domain.dll`, `${PREFIX}.A.Tests.dll`, 'Otro.dll'],
      [`${PREFIX}.B.Tests`]: [`${PREFIX}.Domain.dll`, `${PREFIX}.Infra.dll`],
    })
    const h = harness()
    assert.deepEqual(measureCoverage(wt, PREFIX, { run: h.run, log: h.log }), { exit: 0, timedOut: false })
    const instrumented = h.calls.filter((call) => call[1] === 'instrument').map((call) => call[2]?.split(sep).at(-1))
    assert.deepEqual(instrumented, [`${PREFIX}.Domain.dll`, `${PREFIX}.Infra.dll`])
    assert.match(h.out(), /Instrumentacion: vistas=4, omitidas_tests=1, omitidas_duplicadas=1, instrumentadas=2\n/)
    assert.match(h.out(), /2 DLL\(s\) instrumentada\(s\)\n/)
    const collect = h.calls.find((call) => call[1] === 'collect') ?? []
    assert.deepEqual(collect.slice(0, 7), ['dotnet-coverage', 'collect', '--output', join(wt, COVERAGE_XML), '-f', 'cobertura', '--'])
    assert.equal(collect[7], process.execPath)
    assert.match(collect[8] ?? '', /tdd-coverage\.mts$/)
    assert.deepEqual(collect.slice(9), ['run-tests', wt, PREFIX])
    assert.match(h.out(), /Cobertura recolectada: .*coverage\.cobertura\.xml\n/)
  })

  test('un build que falla o ninguna DLL instrumentada son fallo de instrumentacion', () => {
    const wt = worktree({ [`${PREFIX}.A.Tests`]: [`${PREFIX}.Domain.dll`] })
    const broken = harness({ build: 1 })
    assert.deepEqual(measureCoverage(wt, PREFIX, { run: broken.run, log: broken.log }), { exit: 1, timedOut: false })
    assert.match(broken.out(), /! Build fallo antes de instrumentacion\n/)
    const refused = harness({ instrument: 1 })
    assert.deepEqual(measureCoverage(wt, PREFIX, { run: refused.run, log: refused.log }), { exit: 1, timedOut: false })
    assert.match(refused.out(), /! No se pudo instrumentar: Cosmos\.ControlPlane\.Domain\.dll\n[\s\S]*! No se instrumento ninguna DLL\n/)
  })

  test('agotar el tiempo mata el paso en curso y termina como la medicion cortada del bash (137)', () => {
    const wt = worktree({ [`${PREFIX}.A.Tests`]: [`${PREFIX}.Domain.dll`] })
    const h = harness({ timeoutOn: 'collect' })
    assert.deepEqual(measureCoverage(wt, PREFIX, { run: h.run, log: h.log }), { exit: 137, timedOut: true })
    assert.equal(existsSync(join(wt, COVERAGE_RC)), false)
    assert.equal(coverageSkipReason(137, wt), 'SKIP coverage-gate: instrumentacion fallo')
    let now = 0
    const late = harness()
    const clock = (): number => {
      now += 700_000
      return now
    }
    assert.deepEqual(measureCoverage(wt, PREFIX, { run: late.run, log: late.log, clock }), { exit: 137, timedOut: true })
    assert.deepEqual(late.calls, [])
  })

  test('las DLLs se buscan bajo bin/Debug/net10.0 de los *.Tests del prefijo', () => {
    const wt = worktree({ [`${PREFIX}.A.Tests`]: [`${PREFIX}.X.dll`], [`${PREFIX}.A.SmokeTests`]: [`${PREFIX}.Y.dll`], 'Otro.A.Tests': [`${PREFIX}.Z.dll`] })
    assert.deepEqual(instrumentableDlls(wt, PREFIX).map((dll) => dll.split(sep).at(-1)), [`${PREFIX}.X.dll`])
  })
})

describe('runCoverageTests', () => {
  test('sigue ante proyectos sin tests (8) y termina con el primer fallo real', () => {
    const wt = worktree({ [`${PREFIX}.A.Tests`]: [], [`${PREFIX}.B.Tests`]: [], [`${PREFIX}.C.Tests`]: [] })
    const seen: string[] = []
    const codes: Record<string, number> = { A: 8, B: 3, C: 0 }
    const rc = runCoverageTests(wt, PREFIX, (args) => {
      const project = args[2] ?? ''
      seen.push(project)
      assert.deepEqual(args.slice(3), ['--no-build'])
      return codes[project.split(sep).at(-2)?.split('.').at(-2) ?? ''] ?? 0
    })
    assert.equal(rc, 3)
    assert.equal(seen.length, 2)
  })
  test('sin proyectos termina en 0', () => {
    assert.equal(runCoverageTests(worktree({}), PREFIX, () => 1), 0)
  })
  test('como proceso: el comando que envuelve dotnet-coverage', () => {
    const script = join(import.meta.dirname, '..', 'lib', 'pipeline', 'tdd-coverage.mts')
    const result = capture(process.execPath, [script, 'run-tests', worktree({}), PREFIX])
    assert.equal(result.status, 0, result.stderr)
  })
})

describe('textos de Python que la tabla conserva', () => {
  test('round(x, 1) con desempate al par y el .0 de los enteros', () => {
    assert.equal(pythonRound1(83.33), '83.3')
    assert.equal(pythonRound1(100), '100.0')
    assert.equal(pythonRound1(0.25), '0.2')
    assert.equal(pythonRound1(0.75), '0.8')
    assert.equal(pythonRound1(99.95), '100.0')
  })
  test('rangos de lineas consecutivas, en el orden del XML', () => {
    assert.deepEqual(uncoveredRanges([3, 4, 5, 9, 11, 12]), ['- L3-L5', '- L9', '- L11-L12'])
    assert.deepEqual(uncoveredRanges([7]), ['- L7'])
    assert.deepEqual(uncoveredRanges([]), [])
  })
  test('paridad con el round de Python', { skip: process.platform === 'win32' || capture('python3', ['-c', '0']).status !== 0 }, () => {
    const values = [0.25, 0.75, 12.25, 83.33, 99.95, 100, 0.05, 33.349999]
    const python = capture('python3', ['-c', `print('\\n'.join(str(round(float(v), 1)) for v in [${values.join(',')}]))`]).stdout.trim().split('\n')
    assert.deepEqual(values.map(pythonRound1), python)
  })
})
