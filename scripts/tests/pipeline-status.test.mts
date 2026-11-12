import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  holdJson,
  jsonText,
  jsonTextOrNull,
  localIsoSeconds,
  noHold,
  renderStatusJson,
  runStamp,
  statusIsActive,
  statusState,
  utcIsoSeconds,
  writeStatus,
} from '../lib/pipeline/pipeline-status.mts'

const work = mkdtempSync(join(tmpdir(), 'mefisto pipeline status '))
after(() => rmSync(work, { recursive: true, force: true }))

describe('marcas de tiempo', () => {
  const date = new Date(2026, 0, 5, 7, 8, 9)
  test('runStamp y localIsoSeconds usan hora local con ceros', () => {
    assert.equal(runStamp(date), '20260105-070809')
    assert.equal(localIsoSeconds(date), '2026-01-05T07:08:09')
  })
  test('utcIsoSeconds da el instante en UTC sin milisegundos', () => {
    assert.equal(utcIsoSeconds(0), '1970-01-01T00:00:00Z')
    assert.equal(utcIsoSeconds(1_893_456_000), '2030-01-01T00:00:00Z')
  })
})

describe('renderStatusJson', () => {
  // Texto que escribia el heredoc de `update_status` de tooling-pipeline.mts para estos valores.
  const EXPECTED = `{
  "issue": "42",
  "title": "Agregar CI",
  "pipeline": "tooling",
  "variant": null,
  "agents": {
    "writer":   {"duration": 12, "result": "passed"},
    "reviewer": {"duration": null, "result": "running"}
  },
  "tests": null,
  "last_error": null
  ,"hold": {"cause": null, "next_probe": null, "ceiling_seconds": null, "accumulated_seconds": 0}
}
`
  const entries = [
    { key: 'issue', json: '"42"' },
    { key: 'title', json: '"Agregar CI"' },
    { key: 'pipeline', json: '"tooling"' },
    { key: 'variant', json: 'null' },
    {
      key: 'agents',
      members: [
        { key: 'writer', json: '{"duration": 12, "result": "passed"}' },
        { key: 'reviewer', json: '{"duration": null, "result": "running"}' },
      ],
    },
    { key: 'tests', json: 'null' },
    { key: 'last_error', json: 'null' },
  ]

  test('una linea por campo, los agentes alineados y el bloque hold al final', () => {
    assert.equal(renderStatusJson(entries, noHold()), EXPECTED)
    assert.deepEqual(Object.keys(JSON.parse(EXPECTED) as object), ['issue', 'title', 'pipeline', 'variant', 'agents', 'tests', 'last_error', 'hold'])
  })

  test('alinea los miembros con el nombre mas largo, como el status de TDD', () => {
    const text = renderStatusJson(
      [
        {
          key: 'agents',
          members: [
            { key: 'test-writer', json: '{}' },
            { key: 'smoke-test-writer', json: '{}' },
            { key: 'reviewer', json: '{}' },
          ],
        },
      ],
      noHold(),
    )
    assert.match(text, /^ {4}"test-writer": {7}\{\},\n {4}"smoke-test-writer": \{\},\n {4}"reviewer": {10}\{\}\n {2}\}$/m)
  })

  test('el bloque hold lleva la causa, la proxima sonda, el techo y lo acumulado', () => {
    const hold = { cause: 'RATE_LIMIT', nextProbe: '2030-01-01T00:05:00Z', ceilingSeconds: 21600, accumulatedSeconds: 300 }
    assert.equal(
      holdJson(hold),
      '{"cause": "RATE_LIMIT", "next_probe": "2030-01-01T00:05:00Z", "ceiling_seconds": 21600, "accumulated_seconds": 300}',
    )
    assert.deepEqual((JSON.parse(renderStatusJson(entries, hold)) as { hold: unknown }).hold, {
      cause: 'RATE_LIMIT',
      next_probe: '2030-01-01T00:05:00Z',
      ceiling_seconds: 21600,
      accumulated_seconds: 300,
    })
    assert.deepEqual(noHold(45), { cause: null, nextProbe: null, ceilingSeconds: null, accumulatedSeconds: 45 })
  })

  test('jsonText escapa comillas, barras y saltos; jsonTextOrNull vuelve null lo vacio', () => {
    assert.equal(jsonText('C:\\repo "x"\n'), '"C:\\\\repo \\"x\\"\\n"')
    assert.equal(jsonTextOrNull(''), 'null')
    assert.equal(jsonTextOrNull('a'), '"a"')
  })
})

describe('statusState y statusIsActive', () => {
  const file = join(work, 'status.json')
  test('lee el estado del archivo escrito', () => {
    writeStatus(file, renderStatusJson([{ key: 'state', json: '"running"' }], noHold()))
    assert.equal(statusState(file), 'running')
    assert.equal(statusIsActive(file), true)
    assert.ok(readFileSync(file, 'utf8').endsWith('}\n'))
  })
  test('hold cuenta como activo; failed, completed y passed no', () => {
    for (const [state, active] of [['hold', true], ['failed', false], ['completed', false], ['passed', false]] as const) {
      writeFileSync(file, JSON.stringify({ state }))
      assert.equal(statusIsActive(file), active, state)
    }
  })
  test('un archivo ausente, que no es JSON o sin estado no esta activo', () => {
    assert.equal(statusState(join(work, 'no-existe.json')), null)
    writeFileSync(file, '{"state": "running"')
    assert.equal(statusIsActive(file), false)
    writeFileSync(file, '[]')
    assert.equal(statusState(file), null)
    writeFileSync(file, '{"state": 3}')
    assert.equal(statusState(file), null)
  })
})
