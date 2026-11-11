import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { holdLineWindow, holdRecentlyActive, lastHoldLine } from '../lib/work-status-hold.mts'

const NOW = new Date(2026, 5, 15, 12, 0, 0)
const epoch = (hours: number, minutes: number, seconds = 0, dayOffset = 0): number =>
  Math.floor(new Date(2026, 5, 15 + dayOffset, hours, minutes, seconds).getTime() / 1000)
const announce = (start: string, probe: string, family = 'RATE_LIMIT'): string =>
  `[${start}][hold] ${family}: esperando, proxima sonda ${probe} (techo 23:59)`

let work = ''
let log = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto hold '))
  log = join(work, 'events.log')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

test('lastHoldLine devuelve el ultimo anuncio e ignora las lineas de reanudacion', () => {
  writeFileSync(
    log,
    ['=== SESSION ===', announce('11:00:00', '11:05:00'), announce('11:50:00', '12:05:00', 'PROVIDER_UNAVAILABLE'), '[11:51:00][hold][resume] sesion reanudada', ''].join('\n'),
  )
  assert.equal(lastHoldLine(log), announce('11:50:00', '12:05:00', 'PROVIDER_UNAVAILABLE'))
  assert.equal(lastHoldLine(log, 2), announce('11:50:00', '12:05:00', 'PROVIDER_UNAVAILABLE'))
  assert.equal(lastHoldLine(log, 3), null)
  assert.equal(lastHoldLine(join(work, 'no-existe.log')), null)
  assert.equal(lastHoldLine(work), null)
})

test('holdLineWindow reconstruye los epochs contra el reloj', () => {
  assert.deepEqual(holdLineWindow(announce('11:50:00', '12:05:00'), NOW), { start: epoch(11, 50), probe: epoch(12, 5) })
  // La sonda cruza medianoche.
  assert.deepEqual(holdLineWindow(announce('11:50:00', '00:10:00'), NOW), { start: epoch(11, 50), probe: epoch(0, 10, 0, 1) })
  // Un anuncio en el futuro es de ayer.
  assert.deepEqual(holdLineWindow(announce('18:00:00', '18:05:00'), NOW), { start: epoch(18, 0, 0, -1), probe: epoch(18, 5, 0, -1) })
  assert.equal(holdLineWindow('[11:50:00][hold] RATE_LIMIT: sin sonda', NOW), null)
  assert.equal(holdLineWindow(announce('11:50:00', '25:00:00'), NOW), null)
  assert.equal(holdLineWindow(`x${announce('11:50:00', '12:05:00')}`, NOW), null)
})

test('holdRecentlyActive: hay espera mientras la proxima sonda no llega', () => {
  writeFileSync(log, `${announce('11:50:00', '12:05:00')}\n`)
  assert.equal(holdRecentlyActive(log, NOW), true)
  assert.equal(holdRecentlyActive(log, NOW, 1), false)
  writeFileSync(log, `${announce('11:50:00', '11:59:59')}\n`)
  assert.equal(holdRecentlyActive(log, NOW), false)
  writeFileSync(log, `${announce('18:00:00', '18:05:00')}\n`)
  assert.equal(holdRecentlyActive(log, NOW), false)
  writeFileSync(log, 'sin anuncios\n')
  assert.equal(holdRecentlyActive(log, NOW), false)
  assert.equal(holdRecentlyActive(join(work, 'no-existe.log'), NOW), false)
})
