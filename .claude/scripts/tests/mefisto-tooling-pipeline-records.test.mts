// Lo que el pipeline interno de tooling deja escrito: status, entradas del historial, lectura del
// issue y las listas de rutas de sus gates.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isPathInMefistoScope } from '../../../src/internal/scripts/lib/mefisto-scope.mts'
import {
  AUTO_COMMIT_PATHS,
  WRITER_CHANGE_PATHS,
  abortErrorText,
  completedHistoryLine,
  failedHistoryLine,
  parseToolingIssue,
  renderToolingStatus,
} from '../../../src/internal/scripts/lib/mefisto-tooling-records.mts'
import type { HistoryInput } from '../../../src/internal/scripts/lib/mefisto-tooling-records.mts'

const METRICS = '{"runtime":"guion","model":"m","status":"success"}'

const HISTORY: HistoryInput = {
  issue: '662',
  title: 'titulo con "comillas" adentro',
  variant: '',
  runtime: 'guion',
  harnessVersion: '0.25.0',
  harnessSha: 'abc1234',
  started: '20260816-101010',
  finished: '2026-08-16T10:20:00',
  writer: { duration: '600', result: 'passed', metrics: METRICS },
  reviewer: { duration: '', result: 'pending', metrics: '' },
}

describe('entradas de pipeline-history.jsonl', () => {
  for (const [name, line, state] of [
    ['completada', completedHistoryLine({ ...HISTORY, pr: 'https://example.test/pr/1' }), 'completed'],
    ['abortada', failedHistoryLine({ ...HISTORY, stage: '1-writer', error: abortErrorText('fallo de prueba') }), 'failed'],
  ] as const) {
    test(`${name}: JSON valido de una linea con version y commit del harness como texto`, () => {
      assert.ok(line.endsWith('}\n'))
      assert.equal(line.split('\n').length, 2)
      const entry = JSON.parse(line) as Record<string, unknown>
      assert.equal(entry.harness_version, '0.25.0')
      assert.equal(entry.harness_sha, 'abc1234')
      assert.equal(entry.issue, '662')
      assert.equal(entry.state, state)
      assert.equal(entry.title, 'titulo con "comillas" adentro')
      assert.equal(entry.pipeline, 'mefisto-tooling')
      assert.equal(entry.runtime, 'guion')
      assert.equal(entry.variant, null)
    })
    test(`${name}: sin version ni commit quedan null JSON, no la cadena "null"`, () => {
      const degraded =
        state === 'completed'
          ? completedHistoryLine({ ...HISTORY, harnessVersion: '', harnessSha: '', pr: '' })
          : failedHistoryLine({ ...HISTORY, harnessVersion: '', harnessSha: '', stage: 'setup', error: '' })
      const entry = JSON.parse(degraded) as Record<string, unknown>
      assert.ok('harness_version' in entry && 'harness_sha' in entry)
      assert.equal(entry.harness_version, null)
      assert.equal(entry.harness_sha, null)
    })
  }

  test('orden de claves de una corrida completada', () => {
    const entry = JSON.parse(completedHistoryLine({ ...HISTORY, variant: 'exp-a', pr: '' })) as Record<string, unknown>
    assert.deepEqual(Object.keys(entry), ['issue', 'title', 'pipeline', 'variant', 'runtime', 'harness_version', 'harness_sha', 'started', 'finished', 'state', 'agents', 'pr'])
    assert.equal(entry.variant, 'exp-a')
    assert.equal(entry.pr, null)
    assert.deepEqual(entry.agents, {
      writer: { duration: 600, metrics: JSON.parse(METRICS), runtime: 'guion' },
      reviewer: { duration: null, metrics: null, runtime: null },
    })
  })

  test('orden de claves de una corrida abortada, con la etapa y el error', () => {
    const entry = JSON.parse(failedHistoryLine({ ...HISTORY, stage: '2-reviewer', error: abortErrorText('dos\nlineas') })) as Record<string, unknown>
    assert.deepEqual(Object.keys(entry), ['issue', 'title', 'pipeline', 'variant', 'runtime', 'harness_version', 'harness_sha', 'started', 'finished', 'state', 'stage', 'agents', 'error'])
    assert.equal(entry.stage, '2-reviewer')
    assert.equal(entry.error, 'dos lineas ')
  })

  test('metricas que no son JSON degradan agents a solo la duracion', () => {
    const entry = JSON.parse(completedHistoryLine({ ...HISTORY, writer: { duration: '5', result: 'passed', metrics: '{roto' }, pr: '' })) as Record<string, unknown>
    assert.deepEqual(entry.agents, { writer: { duration: 5 }, reviewer: { duration: null } })
  })
})

describe('texto del error', () => {
  test('escapa comillas y vuelve espacios los saltos, con el espacio final', () => {
    assert.equal(abortErrorText('dijo "no"\nadios'), 'dijo \\"no\\" adios ')
  })
})

describe('status de la corrida', () => {
  const status = renderToolingStatus({
    issue: '42',
    title: 'Titulo "citado"',
    variant: 'exp-a',
    runtime: 'guion',
    started: '20260816-101010',
    stage: '1-writer',
    state: 'running',
    updated: '2026-08-16T10:11:00',
    worktree: '/tmp/wt',
    log: '/tmp/log.log',
    writer: { duration: '', result: 'running', metrics: '' },
    reviewer: { duration: '30', result: 'pending', metrics: '' },
    pr: '',
    error: '',
  })

  test('mismo texto y orden de claves que el bash', () => {
    assert.equal(
      status,
      `{
  "issue": "42",
  "title": "Titulo \\"citado\\"",
  "pipeline": "mefisto-tooling",
  "variant": "exp-a",
  "runtime": "guion",
  "started": "20260816-101010",
  "stage": "1-writer",
  "state": "running",
  "updated": "2026-08-16T10:11:00",
  "worktree": "/tmp/wt",
  "log": "/tmp/log.log",
  "agents": {
    "writer":   {"duration": null, "result": "running"},
    "reviewer": {"duration": 30, "result": "pending"}
  },
  "pr": null,
  "last_error": null
}
`,
    )
  })

  test('sin issue el campo dice "null" como texto; sin variante ni runtime, null', () => {
    const parsed = JSON.parse(
      renderToolingStatus({
        issue: '',
        title: '',
        variant: '',
        runtime: '',
        started: 't',
        stage: 'setup',
        state: 'failed',
        updated: 'u',
        worktree: '',
        log: 'l',
        writer: { duration: '', result: 'pending', metrics: '' },
        reviewer: { duration: '', result: 'pending', metrics: '' },
        pr: '',
        error: abortErrorText('Falta el numero de issue'),
      }),
    ) as Record<string, unknown>
    assert.equal(parsed.issue, 'null')
    assert.equal(parsed.variant, null)
    assert.equal(parsed.runtime, null)
    assert.equal(parsed.last_error, 'Falta el numero de issue ')
  })
})

describe('lectura del issue', () => {
  test('titulo y cuerpo decodificados; sin cierre:manual el PR cierra el issue', () => {
    const issue = parseToolingIssue(JSON.stringify({ body: 'linea "1"\nlinea 2\n', labels: [{ name: 'tipo:tooling' }], number: 7, state: 'OPEN', title: 'Usar "comillas"' }))
    assert.deepEqual(issue, { state: 'OPEN', title: 'Usar "comillas"', body: 'linea "1"\nlinea 2', manualClose: false })
  })
  test('con el label cierre:manual el PR solo lo referencia', () => {
    assert.equal(parseToolingIssue('{"labels":[{"name":"cierre:manual"}],"state":"OPEN","title":"t","body":"b"}').manualClose, true)
  })
  test('cuerpo null se lee como None, igual que el print de Python', () => {
    assert.equal(parseToolingIssue('{"body":null,"state":"OPEN","title":"t"}').body, 'None')
  })
  test('una respuesta que no es JSON da estado UNKNOWN', () => {
    const issue = parseToolingIssue('no es json')
    assert.equal(issue.state, 'UNKNOWN')
    assert.equal(issue.title, null)
  })
  test('sin campo title se recorta del texto crudo', () => {
    assert.equal(parseToolingIssue('{"state":"OPEN"} "title":"crudo"').title, 'crudo')
  })
})

describe('rutas de los gates', () => {
  test('el commit de seguridad y la deteccion de cambios cubren changelog.d/ (el fragmento llega al PR)', () => {
    assert.ok(AUTO_COMMIT_PATHS.includes('changelog.d/'))
    assert.ok(WRITER_CHANGE_PATHS.includes('changelog.d/'))
  })
  test('src/published/, src/runtime/ y dist/ estan en las dos listas', () => {
    for (const path of ['src/published/', 'src/runtime/', 'dist/']) {
      assert.ok(AUTO_COMMIT_PATHS.includes(path), path)
      assert.ok(WRITER_CHANGE_PATHS.includes(path), path)
    }
  })
  test('toda ruta de las listas cae en el scope de Mefisto', () => {
    for (const path of new Set([...AUTO_COMMIT_PATHS, ...WRITER_CHANGE_PATHS])) {
      assert.ok(isPathInMefistoScope(path.endsWith('/') ? `${path}x` : path), path)
    }
  })
})
