// Textos de `pr-sync` que leen agentes, mods y personas, contra lo que producia el bash: prompts,
// archivo de status por PR y tabla del resumen.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { noHold } from '../lib/pipeline/pipeline-status.mts'
import { failedTestLines, fixPrompt, mergePrompt, padBytes, prStatusText, summaryTable, writePrStatusFile } from '../pr-sync.mts'
import type { PrStatus } from '../pr-sync.mts'
import { FIXTURES } from './pr-sync-sandbox.mts'

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto pr-sync formato ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

describe('prompts del implementer', () => {
  test('el de conflictos es identico byte a byte al del bash', () => {
    assert.equal(mergePrompt('Proyecto', 'README.md\nsrc/Ventas/Pedido.cs'), fixture('merge.prompt.txt'))
  })

  test('el de tests fallidos es identico byte a byte al del bash', () => {
    assert.equal(
      fixPrompt('Proyecto', '  Failed Ventas.Tests.PedidoTests.Crear [12 ms]\n  Con error Ventas.Tests.PedidoTests.Anular'),
      fixture('fix.prompt.txt'),
    )
  })

  test('los tests fallidos son las primeras 10 lineas que nombran un fallo, o nada', () => {
    const output = ['ok 1', ...Array.from({ length: 12 }, (_, index) => `  Failed T${index}`), 'Con error X'].join('\n')
    assert.equal(failedTestLines(output), Array.from({ length: 10 }, (_, index) => `  Failed T${index}`).join('\n'))
    assert.equal(failedTestLines('Con error X\nok'), 'Con error X')
    assert.equal(failedTestLines('failed en minusculas no cuenta'), null)
  })
})

const HOLD: PrStatus = {
  pr: '42',
  title: 'Título con "comillas" y \\\\ barra',
  runtime: 'claude',
  stage: 'merge-pr42',
  state: 'hold',
  log: '/ruta/al/log "citado".log',
  lastError: '',
  hold: { cause: 'RATE_LIMIT', nextProbe: '2030-01-02T08:09:10Z', ceilingSeconds: 21600, accumulatedSeconds: 300 },
}

describe('status por PR', () => {
  test('el texto coincide con el que escribia jq, con y sin espera', () => {
    assert.equal(prStatusText(HOLD, '2030-01-02T03:04:05', '2030-01-02T03:04:05'), fixture('status-hold.json'))
    assert.equal(
      prStatusText(
        { ...HOLD, pr: '43', runtime: '', stage: 'sync', state: 'failed', lastError: 'No se pudo hacer fetch de origin/main', hold: noHold() },
        '2030-01-02T03:04:05',
        '2030-01-02T03:04:05',
      ),
      fixture('status-failed.json'),
    )
  })

  test('declara exactamente los campos que leen los consumidores del status', () => {
    const parsed = JSON.parse(prStatusText(HOLD, 's', 'u')) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed), ['issue', 'pr', 'title', 'pipeline', 'variant', 'runtime', 'started', 'stage', 'state', 'updated', 'log', 'last_error', 'hold'])
    assert.deepEqual(Object.keys(parsed.hold as object), ['cause', 'next_probe', 'ceiling_seconds', 'accumulated_seconds'])
    assert.equal(parsed.issue, '42')
    assert.equal(parsed.pr, '42')
    assert.equal(parsed.pipeline, 'pr-sync')
    assert.equal(parsed.variant, null)
  })

  test('started se conserva entre escrituras sucesivas y updated avanza', () => {
    const file = join(work, 'pipeline-status-pr-sync-502.json')
    writePrStatusFile(file, { ...HOLD, pr: '502', stage: 'sync', state: 'running', hold: noHold() }, new Date(2030, 0, 2, 3, 4, 5))
    writePrStatusFile(file, { ...HOLD, pr: '502', stage: 'merge', state: 'completed', hold: noHold() }, new Date(2030, 0, 2, 4, 0, 0))
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(parsed.started, '2030-01-02T03:04:05')
    assert.equal(parsed.updated, '2030-01-02T04:00:00')
    assert.equal(parsed.stage, 'merge')
    assert.equal(parsed.state, 'completed')
  })

  test('un status previo ilegible no impide escribir uno nuevo', () => {
    const file = join(work, 'pipeline-status-pr-sync-503.json')
    writeFileSync(file, 'no es json')
    writePrStatusFile(file, { ...HOLD, pr: '503', hold: noHold() }, new Date(2030, 0, 2, 3, 4, 5))
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>).started, '2030-01-02T03:04:05')
  })
})

describe('resumen final', () => {
  test('la tabla coincide con la del bash: columnas rellenas por bytes y color por estado', () => {
    const rows = [
      { pr: '11', branch: 'worktree-issue-11-agregar-pedido', status: 'mergeado' },
      { pr: '12', branch: 'rama-con-acentos-día', status: 'sincronizado' },
      { pr: '13', branch: '(n/a)', status: 'omitido (MERGED)' },
      { pr: '14', branch: 'una-rama-con-un-nombre-muy-largo-que-supera-los-cincuenta-caracteres', status: 'al día' },
      { pr: '15', branch: 'worktree-issue-15-x', status: 'ERROR: No se pudo hacer push de worktree-issue-15-x' },
      { pr: '16', branch: 'rama-pendiente', status: 'pendiente' },
    ]
    assert.equal(`\n${summaryTable(rows)}`, fixture('summary.txt'))
  })

  test('el relleno cuenta bytes y nunca recorta', () => {
    assert.equal(padBytes('día', 6), 'día  ')
    assert.equal(padBytes('abcdef', 3), 'abcdef')
  })
})
