import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CliError } from '../lib/cli.mts'
import { JqError } from '../lib/jq-values.mts'
import {
  cell,
  fixed,
  fmt,
  fmtDurS,
  fmtPct,
  fmtSignedPct,
  inWindow,
  mean,
  median,
  money,
  monthKey,
  normalizeAgentMetrics,
  num0,
  num1,
  numk,
  parseDateFlags,
  parseHistory,
  parseStarted,
  raw,
  secs,
  secs0,
  tableRows,
  txt,
  weekKey,
} from '../lib/metrics-report.mts'

test('fixed redondea como printf de C: el valor exacto, y los empates al digito par', () => {
  const cases: [number, number, string][] = [
    [0.5, 0, '0'],
    [1.5, 0, '2'],
    [2.5, 0, '2'],
    [150.5, 0, '150'],
    [151.5, 0, '152'],
    [0.25, 1, '0.2'],
    [0.75, 1, '0.8'],
    [0.35, 1, '0.3'],
    [0.15, 1, '0.1'],
    [0.45, 1, '0.5'],
    [0.05, 1, '0.1'],
    [2.675, 1, '2.7'],
    [1.005, 2, '1.00'],
    [0.125, 2, '0.12'],
    [0.375, 2, '0.38'],
    [0.325, 2, '0.33'],
    [(0.3 + 0.35) / 2, 2, '0.32'],
    [-0.04, 1, '-0.0'],
    [-0.4, 0, '-0'],
    [-2.5, 0, '-2'],
    [0, 1, '0.0'],
    [1e16, 0, '10000000000000000'],
    [1e-5, 1, '0.0'],
    [12.345, 1, '12.3'],
    [99.95, 1, '100.0'],
  ]
  for (const [value, decimals, expected] of cases) assert.equal(fixed(value, decimals), expected, `${value} con ${decimals}`)
  assert.equal(fixed(8, 1, true), '+8.0')
  assert.equal(fixed(0, 1, true), '+0.0')
  assert.equal(fixed(-35.18, 1, true), '-35.2')
})

test('formatos de cifra: "-" si falta el dato', () => {
  assert.equal(fmtDurS(150), '2m30s')
  assert.equal(fmtDurS(150.5), '2m30s')
  assert.equal(fmtDurS(59.5), '1m00s')
  assert.equal(fmtDurS(45), '45s')
  assert.equal(fmtDurS(0.4), '0s')
  assert.equal(fmtDurS(-0.4), '0s')
  assert.equal(fmtDurS(3600), '60m00s')
  // Una duracion negativa pierde los minutos.
  assert.equal(fmtDurS(-75), '-15s')
  assert.equal(fmtPct(34.78), '34.8%')
  assert.equal(fmtSignedPct(100), '+100.0%')
  assert.equal(fmtSignedPct(-2.06), '-2.1%')
  assert.equal(fmtSignedPct(null), 'n/d')
  assert.equal(num0(33750), '33750')
  assert.equal(num0(2.5), '2')
  assert.equal(num1(11.666666666666666), '11.7')
  assert.equal(secs(27.5), '27.5s')
  assert.equal(secs0(970), '970s')
  assert.equal(money((0.3 + 0.35) / 2), '0.32')
  assert.equal(money(0), '0.00')
  assert.equal(numk(12345), '12.3k')
  assert.equal(numk(1250), '1.2k')
  assert.equal(numk(1000), '1.0k')
  assert.equal(numk(999.5), '1000')
  assert.equal(numk(0.5), '0')
  for (const format of [fmtDurS, fmtPct, num0, num1, secs, secs0, money, numk]) {
    assert.equal(format(null), '-')
    assert.equal(format(''), '-')
    assert.equal(format('null'), '-')
  }
})

test('celdas: null y vacio salen como el literal null, y el texto, escapado', () => {
  assert.equal(cell(null), 'null')
  assert.equal(cell(''), 'null')
  assert.equal(cell('a\tb\nc\\d\re'), 'a\\tb\\nc\\\\d\\re')
  assert.equal(cell(78), '78')
  assert.equal(cell(true), 'true')
  assert.equal(txt(null), '-')
  assert.equal(txt('null'), '-')
  assert.equal(txt('completed'), 'completed')
  assert.equal(raw('linea\n\n'), 'linea')
  assert.equal(raw(null), 'null')
  assert.equal(raw(5), '5')
})

test('fmt rellena por bytes, a izquierda o a derecha', () => {
  assert.equal(fmt('%-6s|%6s|%s', 'ab', 'cd', 'ef'), 'ab    |    cd|ef')
  assert.equal(fmt('%-6s|%6s|', 'añ', 'añ'), 'añ   |   añ|')
  assert.equal(fmt('#%-7s %s', '12345678', 'x'), '#12345678 x')
})

test('una fila con un arreglo o un objeto corta la tabla ahi', () => {
  const rows = tableRows([{ v: 1 }, { v: [1] }, { v: 3 }], (item) => [item.v])
  assert.deepEqual(rows, [[1]])
  assert.deepEqual(
    tableRows([1, 2, 3], (item) => {
      if (item === 2) throw new JqError('falla')
      return [item]
    }),
    [[1]],
  )
})

test('media y mediana ignoran lo que falta y no inventan ceros', () => {
  assert.equal(mean([]), null)
  assert.equal(mean([null, null]), null)
  assert.equal(mean([null, 10, 20]), 15)
  assert.equal(median([]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([2500, 2200]), 2350)
  assert.throws(() => mean(['a', 'b']), JqError)
})

test('parseStarted lee el sello de inicio como UTC', () => {
  // Epochs de jq 1.7.1 en macOS.
  const cases: [string, number | null][] = [
    ['20260505-090000', 1777971600],
    ['2026055-090000', 1777971600],
    ['20260505-090000 ', 1777971600],
    ['20260505-090000\n', 1777971600],
    ['20260505-090000\t x', 1777971600],
    ['20260505-0900', 1777971600],
    ['20260505-09', 1777971600],
    ['20260505-9', 1777971600],
    ['20260230-090000', 1772442000],
    ['20260500-090000', 1777539600],
    ['20260505-090060', 1777971660],
    ['20260505-090000x', null],
    [' 20260505-090000', null],
    ['20261305-090000', null],
    ['20260505-240000', null],
    ['20260505-090061', null],
    ['120260505-090000', null],
    ['2026050-5090000', null],
    ['20260505-', null],
    ['20260505', null],
    ['2026', null],
    ['', null],
  ]
  for (const [started, expected] of cases) assert.equal(parseStarted(started), expected, started)
  assert.equal(parseStarted(20260505), null)
  assert.equal(parseStarted(null), null)
})

test('claves de semana ISO y de mes', () => {
  assert.equal(weekKey(1778000000), '2026-W19')
  assert.equal(monthKey(1778000000), '2026-05')
  // El 1 de enero de 2027 es viernes: pertenece a la ultima semana ISO de 2026.
  assert.equal(weekKey(Date.UTC(2027, 0, 1) / 1000), '2026-W53')
  assert.equal(monthKey(Date.UTC(2027, 0, 1) / 1000), '2027-01')
  assert.equal(weekKey(Date.UTC(2024, 11, 30) / 1000), '2025-W01')
  assert.equal(weekKey(Date.UTC(2026, 7, 6, 9) / 1000), '2026-W32')
  assert.equal(weekKey(null), null)
  assert.equal(monthKey(null), null)
})

test('la ventana compara los 8 primeros caracteres de started', () => {
  const entry = { started: '20260806-090000' }
  assert.equal(inWindow(entry, '', ''), true)
  assert.equal(inWindow(entry, '2026-08-06', '2026-08-06'), true)
  assert.equal(inWindow(entry, '2026-08-07', ''), false)
  assert.equal(inWindow(entry, '', '2026-08-05'), false)
  assert.equal(inWindow({}, '', ''), true)
  assert.equal(inWindow({}, '2026-01-01', ''), false)
  assert.equal(inWindow({ started: '2026' }, '', '2026-12-31'), false)
  assert.throws(() => inWindow({ started: 20260806 }, '2026-01-01', ''), JqError)
})

test('parseHistory conserva solo las lineas que son objetos', () => {
  assert.deepEqual(parseHistory('{"a":1}\n\n{ roto\n[1]\n"x"\n﻿{"b":2}'), [{ a: 1 }, { b: 2 }])
})

test('normaliza la forma vieja y la neutral de metrics', () => {
  assert.equal(normalizeAgentMetrics(null), null)
  const old = normalizeAgentMetrics({
    is_error: false,
    duration_ms: 320000,
    duration_api_ms: 250000,
    cost_usd: 0.45,
    tokens: { input: 12000, output: 1800, cache_read: 40000, cache_creation: 6000 },
    turns: 8,
  })
  assert.deepEqual(old, {
    agent: null,
    runtime: null,
    status: 'success',
    model: null,
    estimated_cost_usd: null,
    legacy_reported_cost_usd: 0.45,
    tokens: { input: 12000, output: 1800, cache_read: 40000, cache_write: 6000, reasoning: null },
    turns: 8,
    duration_ms: 320000,
    api_duration_ms: 250000,
    non_api_ms: 70000,
    tool_calls: [],
  })
  const neutral = normalizeAgentMetrics({ runtime: 'otro', status: 'failed', estimated_cost_usd: null, cost_usd: 99, duration_ms: 1000 })
  assert.equal(neutral?.legacy_reported_cost_usd, null)
  assert.equal(neutral?.status, 'failed')
  assert.equal(neutral?.non_api_ms, null)
  assert.throws(() => normalizeAgentMetrics('texto'), JqError)
  assert.throws(() => normalizeAgentMetrics({ tokens: 'x' }), JqError)
})

test('banderas de fecha', () => {
  const hint = '--desde YYYY-MM-DD'
  assert.deepEqual(parseDateFlags([], ['--desde'], hint), { '--desde': '' })
  assert.deepEqual(parseDateFlags(['--desde', '2026-08-01'], ['--desde'], hint), { '--desde': '2026-08-01' })
  assert.deepEqual(parseDateFlags(['--desde=2026-08-01', '--desde='], ['--desde'], hint), { '--desde': '' })
  assert.equal(parseDateFlags(['--desde', '2026-08-01', '-h', '--nope'], ['--desde'], hint), null)
  assert.throws(() => parseDateFlags(['--nope', '-h'], ['--desde'], hint), CliError)
  assert.throws(() => parseDateFlags(['--desde'], ['--desde'], hint), /--desde requiere un valor YYYY-MM-DD/)
  assert.throws(() => parseDateFlags(['--desde', '2026-8-1'], ['--desde'], hint), /espera formato YYYY-MM-DD \(recibido: '2026-8-1'\)/)
  assert.throws(() => parseDateFlags(['--hasta', 'x'], ['--desde'], hint), /argumento desconocido: --hasta \(uso: --desde YYYY-MM-DD\)/)
})
