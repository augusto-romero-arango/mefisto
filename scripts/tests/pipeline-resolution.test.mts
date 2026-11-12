import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { describe, test } from 'node:test'

import type { Run } from '../lib/azure-cli.mts'
import { CliError } from '../lib/cli.mts'
import {
  canLaunchNow,
  isTipoProjectionFromLabels,
  resolutionText,
  resolveFromLabels,
  resolveIssueFacts,
  resolvePipeline,
  resolvePipelineWithState,
} from '../lib/pipeline/pipeline-resolution.mts'
import type { Resolution } from '../lib/pipeline/pipeline-resolution.mts'

interface FakeGh {
  run: Run
  calls: string[][]
}

/** `gh issue view` que responde `issue` como JSON, o falla si es `null`. */
function fakeGh(issue: { state?: string; labels?: string[] } | null): FakeGh {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    if (issue === null) return { status: 1, stdout: '', stderr: 'error: not authenticated' }
    const json = { state: issue.state, labels: (issue.labels ?? []).map((name) => ({ id: 'x', name, color: 'fff' })) }
    return { status: 0, stdout: `${JSON.stringify(json)}\n`, stderr: '' }
  }
  return { run, calls }
}

function scriptOf(resolution: Resolution): string {
  assert.equal(resolution.kind, 'pipeline')
  return resolution.kind === 'pipeline' ? resolution.script : ''
}

function assertPipeline(resolution: Resolution, name: 'tdd' | 'tooling'): void {
  const script = scriptOf(resolution)
  assert.equal(resolution.kind === 'pipeline' && resolution.pipeline, name)
  assert.equal(isAbsolute(script), true, script)
  assert.equal(basename(script), `${name}-pipeline.sh`)
  assert.equal(existsSync(script), true, script)
}

function unknownOverride(action: () => unknown, override: string): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.message, `ERROR: override desconocido '${override}'`)
    assert.equal(error.exitCode, 1)
    return true
  })
}

describe('resolvePipeline', () => {
  test('[R-1] con override devuelve una ruta absoluta y existente, sin consultar GitHub', () => {
    for (const override of ['tdd', 'tooling'] as const) {
      const gh = fakeGh({ state: 'OPEN', labels: ['tipo:infra'] })
      assertPipeline(resolvePipeline(999, override, { run: gh.run }), override)
      assert.deepEqual(gh.calls, [])
    }
  })

  test('un override desconocido es error', () => {
    unknownOverride(() => resolvePipeline(999, 'foo', { run: fakeGh(null).run }), 'foo')
  })

  test('sin override enruta por los labels del issue', () => {
    const gh = fakeGh({ labels: ['estado:listo', 'tipo:tooling'] })
    assertPipeline(resolvePipeline(42, '', { run: gh.run }), 'tooling')
    assert.deepEqual(gh.calls, [['gh', 'issue', 'view', '42', '--json', 'labels']])
  })

  test('si gh falla o no responde JSON resuelve SKIP:no-tipo', () => {
    assert.deepEqual(resolvePipeline(42, '', { run: fakeGh(null).run }), { kind: 'skip', reason: 'no-tipo' })
    const garbage: Run = () => ({ status: 0, stdout: 'no soy json', stderr: '' })
    assert.deepEqual(resolvePipeline(42, '', { run: garbage }), { kind: 'skip', reason: 'no-tipo' })
    const missing: Run = () => ({ status: null, stdout: '', stderr: '' })
    assert.deepEqual(resolvePipeline(42, '', { run: missing }), { kind: 'skip', reason: 'no-tipo' })
  })

  test('[R-5] la ruta resuelta no depende del cwd', () => {
    const fromRepo = scriptOf(resolvePipeline(999, 'tooling'))
    const previous = process.cwd()
    process.chdir(tmpdir())
    try {
      assert.equal(scriptOf(resolvePipeline(999, 'tooling')), fromRepo)
    } finally {
      process.chdir(previous)
    }
  })
})

describe('resolveFromLabels', () => {
  test('[R-2] ruta absoluta y existente por tipo', () => {
    assertPipeline(resolveFromLabels(['tipo:feature']), 'tdd')
    assertPipeline(resolveFromLabels(['tipo:refactor']), 'tdd')
    assertPipeline(resolveFromLabels(['tipo:tooling']), 'tooling')
    assertPipeline(resolveFromLabels(['tipo:projection']), 'tdd')
    assertPipeline(resolveFromLabels(['estado:listo', 'dom:x', 'tipo:feature']), 'tdd')
  })

  test('[R-3] los centinelas SKIP no llevan ruta', () => {
    assert.deepEqual(resolveFromLabels(['tipo:infra']), { kind: 'skip', reason: 'infra' })
    assert.deepEqual(resolveFromLabels(['otra-cosa']), { kind: 'skip', reason: 'no-tipo' })
    assert.deepEqual(resolveFromLabels([]), { kind: 'skip', reason: 'no-tipo' })
    assert.equal(resolutionText(resolveFromLabels(['tipo:infra'])), 'SKIP:infra')
    assert.equal(resolutionText(resolveFromLabels([])), 'SKIP:no-tipo')
  })

  test('exige el label exacto y prefiere TDD, luego tooling, luego infra', () => {
    assert.deepEqual(resolveFromLabels(['tipo:feature-x', 'xtipo:tooling', 'tipo:infraestructura']), {
      kind: 'skip',
      reason: 'no-tipo',
    })
    assertPipeline(resolveFromLabels(['tipo:infra', 'tipo:tooling', 'tipo:refactor']), 'tdd')
    assertPipeline(resolveFromLabels(['tipo:infra', 'tipo:tooling']), 'tooling')
    for (const labels of [['tipo:Feature', ' tipo:tooling', 'tipo:infra '], [''], ['tipo:projection-experimental']]) {
      assert.deepEqual(resolveFromLabels(labels), { kind: 'skip', reason: 'no-tipo' }, JSON.stringify(labels))
    }
  })

  test('la ruta sale del directorio de scripts indicado', () => {
    const scriptsDir = join(tmpdir(), 'plugin', 'scripts')
    assert.equal(resolutionText(resolveFromLabels(['tipo:tooling'], scriptsDir)), join(scriptsDir, 'tooling-pipeline.sh'))
  })
})

describe('isTipoProjectionFromLabels', () => {
  test('[S-1] reconoce el label exacto y descarta el prefijo', () => {
    assert.equal(isTipoProjectionFromLabels(['estado:listo', 'tipo:projection', 'dom:facturacion']), true)
    assert.equal(isTipoProjectionFromLabels(['tipo:projection-experimental']), false)
    assert.equal(isTipoProjectionFromLabels(['tipo:feature', 'estado:listo']), false)
    assert.equal(isTipoProjectionFromLabels([]), false)
    assert.equal(isTipoProjectionFromLabels(['']), false)
  })
})

describe('resolveIssueFacts', () => {
  test('[S-2] estado, projection y pipeline salen de una sola consulta', () => {
    const gh = fakeGh({ state: 'OPEN', labels: ['tipo:projection', 'estado:listo'] })
    const facts = resolveIssueFacts(999, '', { run: gh.run })
    assert.equal(facts.state, 'OPEN')
    assert.equal(facts.isProjection, true)
    assertPipeline(facts.resolution, 'tdd')
    assert.deepEqual(gh.calls, [['gh', 'issue', 'view', '999', '--json', 'state,labels']])
  })

  test('tipo:feature no es projection', () => {
    const facts = resolveIssueFacts(998, '', { run: fakeGh({ state: 'OPEN', labels: ['tipo:feature'] }).run })
    assert.equal(facts.isProjection, false)
    assertPipeline(facts.resolution, 'tdd')
  })

  test('si gh falla degrada a UNKNOWN, sin projection y sin tipo', () => {
    assert.deepEqual(resolveIssueFacts(997, '', { run: fakeGh(null).run }), {
      state: 'UNKNOWN',
      isProjection: false,
      resolution: { kind: 'skip', reason: 'no-tipo' },
    })
  })

  test('con override el flag de projection sigue saliendo de los labels', () => {
    const run = fakeGh({ state: 'OPEN', labels: ['tipo:projection'] }).run
    const facts = resolveIssueFacts(996, 'tdd', { run })
    assert.equal(facts.isProjection, true)
    assertPipeline(facts.resolution, 'tdd')
    assertPipeline(resolveIssueFacts(996, 'tooling', { run }).resolution, 'tooling')
  })

  test('un override desconocido es error despues de consultar', () => {
    const gh = fakeGh({ state: 'OPEN', labels: ['tipo:feature'] })
    unknownOverride(() => resolveIssueFacts(995, 'no-existe', { run: gh.run }), 'no-existe')
    assert.equal(gh.calls.length, 1)
  })
})

describe('resolvePipelineWithState', () => {
  test('[R-4] antepone el estado y absolutiza, con override y por labels', () => {
    const run = fakeGh({ state: 'OPEN', labels: ['tipo:feature'] }).run
    const forced = resolvePipelineWithState(999, 'tooling', { run })
    assert.equal(forced.state, 'OPEN')
    assertPipeline(forced.resolution, 'tooling')

    const byLabels = resolvePipelineWithState(999, '', { run })
    assert.equal(byLabels.state, 'OPEN')
    assertPipeline(byLabels.resolution, 'tdd')
  })

  test('[R-4] con gh fallando el override se honra y el estado queda UNKNOWN', () => {
    for (const override of ['tdd', 'tooling'] as const) {
      const result = resolvePipelineWithState(999, override, { run: fakeGh(null).run })
      assert.equal(result.state, 'UNKNOWN')
      assertPipeline(result.resolution, override)
    }
  })

  test('[R-4] sin override y con gh fallando queda UNKNOWN y SKIP:no-tipo', () => {
    assert.deepEqual(resolvePipelineWithState(999, '', { run: fakeGh(null).run }), {
      state: 'UNKNOWN',
      resolution: { kind: 'skip', reason: 'no-tipo' },
    })
  })

  test('[R-4] un override desconocido es error aunque gh falle', () => {
    unknownOverride(() => resolvePipelineWithState(999, 'foo', { run: fakeGh(null).run }), 'foo')
  })

  test('un issue cerrado conserva su estado y su pipeline', () => {
    const result = resolvePipelineWithState(994, '', { run: fakeGh({ state: 'CLOSED', labels: ['tipo:tooling'] }).run })
    assert.equal(result.state, 'CLOSED')
    assertPipeline(result.resolution, 'tooling')
  })

  test('[S-2] solo lleva estado y pipeline, sin el flag de projection', () => {
    const result = resolvePipelineWithState(995, '', { run: fakeGh({ state: 'OPEN', labels: ['tipo:projection'] }).run })
    assert.deepEqual(Object.keys(result), ['state', 'resolution'])
    assert.equal(result.state, 'OPEN')
    assertPipeline(result.resolution, 'tdd')
  })
})

describe('canLaunchNow', () => {
  test('[S-3] matriz de limite de paralelismo y projection en curso', () => {
    assert.equal(canLaunchNow(0, 5, false, false), true)
    assert.equal(canLaunchNow(0, 5, true, false), true)
    assert.equal(canLaunchNow(0, 5, true, true), false)
    assert.equal(canLaunchNow(2, 2, false, false), false)
    assert.equal(canLaunchNow(2, 1, false, false), true)
    assert.equal(canLaunchNow(2, 1, true, true), false)
    assert.equal(canLaunchNow(2, 1, false, true), true)
    assert.equal(canLaunchNow(2, 3, false, false), false)
  })
})
