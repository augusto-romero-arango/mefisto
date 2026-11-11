import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { get, isJqObject } from '../lib/jq-literals.mts'
import { JqError } from '../lib/jq-values.mts'
import {
  ANSI,
  LogCursor,
  PLAIN,
  cell,
  clock,
  delta,
  epochSeconds,
  eventEpochMs,
  follow,
  hasSegmentBeforeSuffix,
  isMissing,
  isNewerThan,
  issueList,
  newestFirst,
  newestMatching,
  row,
  seconds,
  translateLine,
  tsvEscape,
} from '../lib/stream-watch.mts'
import type { Filter } from '../lib/stream-watch.mts'

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'lib-stream-watch-'))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function touch(file: string, isoTime: string, content = '{}\n'): string {
  writeFileSync(file, content)
  const time = new Date(isoTime)
  utimesSync(file, time, time)
  return file
}

describe('paleta', () => {
  test('los colores son los codigos ANSI del visor en bash y la paleta plana no pinta nada', () => {
    assert.deepEqual(ANSI, {
      red: '\u001b[0;31m',
      green: '\u001b[0;32m',
      yellow: '\u001b[1;33m',
      blue: '\u001b[0;34m',
      cyan: '\u001b[0;36m',
      bold: '\u001b[1m',
      reset: '\u001b[0m',
    })
    assert.equal(Object.values(PLAIN).join(''), '')
  })
})

describe('celdas y filas', () => {
  test('un valor nulo o vacio es `-`; el resto se imprime como jq', () => {
    assert.equal(cell(null), '-')
    assert.equal(cell(''), '-')
    assert.equal(cell(false), 'false')
    assert.equal(cell(0), '0')
    assert.equal(cell('texto'), 'texto')
    assert.equal(cell([1, 'a']), '[1,"a"]')
    assert.deepEqual(row('tool', 1788861600000, null, true), ['tool', '1788861600000', '-', 'true'])
  })

  test('falta lo vacio, el `-` de una celda y el literal `null`; 0 y false estan presentes', () => {
    for (const value of ['', '-', 'null']) assert.equal(isMissing(value), true, value)
    for (const value of ['0', 'false', '42']) assert.equal(isMissing(value), false, value)
  })

  test('el escapado de @tsv cubre tab, salto, retorno y barra invertida', () => {
    assert.equal(tsvEscape('a\tb\nc\rd\\e'), 'a\\tb\\nc\\rd\\\\e')
    assert.equal(tsvEscape('sin nada'), 'sin nada')
  })
})

describe('translateLine', () => {
  const types: Filter = (event) => {
    if (!isJqObject(event)) return []
    return [row('tipo', get(get(event, 'meta'), 'kind'))]
  }

  test('rinde las filas de cada valor JSON de la linea', () => {
    assert.deepEqual(translateLine('{"meta":{"kind":"a"}} {"meta":null}', types), {
      status: 'rows',
      rows: [
        ['tipo', 'a'],
        ['tipo', '-'],
      ],
    })
  })

  test('una linea vacia o un valor que el filtro descarta no rinde filas', () => {
    assert.deepEqual(translateLine('', types), { status: 'rows', rows: [] })
    assert.deepEqual(translateLine('  \r', types), { status: 'rows', rows: [] })
    assert.deepEqual(translateLine('"suelto"', types), { status: 'rows', rows: [] })
  })

  test('lo que no es JSON es invalido, tambien si empieza con un valor correcto', () => {
    assert.deepEqual(translateLine('{corrupta}', types), { status: 'invalid' })
    assert.deepEqual(translateLine('{"meta":null} basura', types), { status: 'invalid' })
    assert.deepEqual(translateLine('{"meta":', types), { status: 'invalid' })
  })

  test('si el filtro falla con un valor, la linea entera no rinde filas', () => {
    assert.deepEqual(translateLine('{"meta":{"kind":"a"}} {"meta":"cadena"}', types), { status: 'failed' })
  })
})

describe('horas y duraciones', () => {
  test('epochSeconds lee la fecha UTC como strptime + mktime', () => {
    assert.equal(epochSeconds('2026-09-08T10:00:00Z'), 1788861600)
    assert.equal(epochSeconds('2026-9-8T1:2:3Z'), 1788829323)
    assert.equal(epochSeconds('2026-09-08T10:00:00Z y algo mas'), 1788861600)
    assert.equal(epochSeconds('2026-02-31T10:00:60Z'), 1772532060)
    assert.equal(epochSeconds('1900-01-01T00:00:00Z'), -2208988800)
  })

  test('epochSeconds falla con lo que no es esa fecha', () => {
    const invalid = [
      '2026-09-08T10:00:00.123Z',
      '2026-09-08T10:00:00Zx',
      '2026-09-08t10:00:00Z',
      ' 2026-09-08T10:00:00Z',
      '2026-13-08T10:00:00Z',
      '2026-00-08T10:00:00Z',
      '2026-02-01T24:00:00Z',
      '2026-02-01T10:00:61Z',
      '1899-12-31T00:00:00Z',
      '1969-12-31T23:59:59Z',
      '',
    ]
    for (const text of invalid) assert.throws(() => epochSeconds(text), JqError, text)
  })

  test('eventEpochMs suma los tres primeros digitos de la fraccion', () => {
    assert.equal(eventEpochMs('2026-09-08T10:00:00Z'), 1788861600000)
    assert.equal(eventEpochMs('2026-09-08T10:00:00.5Z'), 1788861600500)
    assert.equal(eventEpochMs('2026-09-08T10:00:00.125Z'), 1788861600125)
    assert.equal(eventEpochMs('2026-09-08T10:00:00.1234567Z'), 1788861600123)
    assert.equal(eventEpochMs('2026-09-08T10:00:00Z\n'), 1788861600000)
  })

  test('eventEpochMs no reconoce otra forma y falla con una fecha imposible', () => {
    assert.equal(eventEpochMs('2026-09-08T10:00:00+00:00'), undefined)
    assert.equal(eventEpochMs('2026-9-8T10:00:00Z'), undefined)
    assert.equal(eventEpochMs('ayer'), undefined)
    assert.throws(() => eventEpochMs('2026-13-08T10:00:00Z'), JqError)
  })

  test('seconds redondea a un decimal como printf, con los empates al digito par', () => {
    assert.equal(seconds('3000'), '3.0')
    assert.equal(seconds('1500.50'), '1.5')
    assert.equal(seconds('250'), '0.2')
    assert.equal(seconds('1250'), '1.2')
    assert.equal(seconds('350'), '0.3')
    assert.equal(seconds('45000', '40000'), '5.0')
    assert.equal(seconds('-250'), '-0.2')
  })

  test('seconds lee como awk: el prefijo numerico del texto, o cero', () => {
    assert.equal(seconds('12abc'), '0.0')
    assert.equal(seconds('1e3'), '1.0')
    assert.equal(seconds('abc'), '0.0')
    assert.equal(seconds('{"a":1}'), '0.0')
  })

  test('clock da la hora local del epoch y una marca fija si falta', () => {
    const date = new Date(1788861600000)
    const expected = [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':')
    assert.equal(clock('1788861600000'), expected)
    assert.equal(clock('1788861600999'), expected)
    for (const missing of ['-', '', 'null']) assert.equal(clock(missing), '--:--:--')
  })

  test('delta: `-` en siete columnas sin instante anterior, y la diferencia en segundos con el', () => {
    assert.equal(delta('', '1785190194169'), '      -')
    assert.equal(delta('1785190194169', '-'), '      -')
    assert.equal(delta('1785190174000', '1785190194169'), '+ 20.2s')
    assert.equal(delta('1000', '1250'), '+  0.2s')
    assert.equal(delta('20600', '19000'), '+ -1.6s')
    assert.equal(delta('0', '32277000'), '+32277.0s')
  })
})

describe('descubrimiento', () => {
  test('newestFirst ordena por fecha de modificacion y desempata por nombre', () => {
    const dir = join(work, 'orden')
    mkdirSync(dir)
    touch(join(dir, 'viejo.events.jsonl'), '2026-07-29T09:00:00Z')
    touch(join(dir, 'nuevo.events.jsonl'), '2026-07-29T09:30:00Z')
    touch(join(dir, 'b-empate.events.jsonl'), '2026-07-29T09:15:00Z')
    touch(join(dir, 'a-empate.events.jsonl'), '2026-07-29T09:15:00Z')
    touch(join(dir, 'otro.stream.jsonl'), '2026-07-29T10:00:00Z')
    touch(join(dir, '.oculto.events.jsonl'), '2026-07-29T11:00:00Z')
    mkdirSync(join(dir, 'carpeta.events.jsonl'))
    assert.deepEqual(newestFirst(dir, '.events.jsonl'), [
      join(dir, 'nuevo.events.jsonl'),
      join(dir, 'a-empate.events.jsonl'),
      join(dir, 'b-empate.events.jsonl'),
      join(dir, 'viejo.events.jsonl'),
    ])
  })

  test('newestFirst no falla si el directorio no existe', () => {
    assert.deepEqual(newestFirst(join(work, 'no-existe-jamas'), '.events.jsonl'), [])
  })

  test('isNewerThan compara el segundo de modificacion; sin corte o sin archivo, pasa', () => {
    const file = touch(join(work, 'corte.events.jsonl'), '2026-08-26T09:00:00.700Z')
    const second = String(Date.parse('2026-08-26T09:00:00Z') / 1000)
    assert.equal(isNewerThan(file, '9999999999'), false)
    assert.equal(isNewerThan(file, '1'), true)
    assert.equal(isNewerThan(file, second), true)
    assert.equal(isNewerThan(file, String(Number(second) + 1)), false)
    assert.equal(isNewerThan(file, ''), true)
    assert.equal(isNewerThan(join(work, 'no-existe.events.jsonl'), '9999999999'), true)
  })

  test('issueList separa por comas y espacios y descarta los vacios', () => {
    assert.deepEqual(issueList('42,43,,44'), ['42', '43', '44'])
    assert.deepEqual(issueList('5, 1124'), ['5', '1124'])
    assert.deepEqual(issueList(''), [])
  })

  test('hasSegmentBeforeSuffix casa `*segmento*sufijo` sin solapar los dos', () => {
    assert.equal(hasSegmentBeforeSuffix('a-issue-4-x.events.jsonl', '-issue-4-', '.events.jsonl'), true)
    assert.equal(hasSegmentBeforeSuffix('a-issue-4-.events.jsonl', '-issue-4-', '.events.jsonl'), true)
    assert.equal(hasSegmentBeforeSuffix('a-issue-42-x.events.jsonl', '-issue-4-', '.events.jsonl'), false)
    assert.equal(hasSegmentBeforeSuffix('a-issue-4-x.stream.jsonl', '-issue-4-', '.events.jsonl'), false)
    assert.equal(hasSegmentBeforeSuffix('a.events.jsonl', '.events.', '.events.jsonl'), false)
  })

  test('newestMatching devuelve el mas reciente que pasa los dos filtros', () => {
    const dir = join(work, 'filtros')
    mkdirSync(dir)
    const old = touch(join(dir, 's-issue-10.events.jsonl'), '2026-08-26T09:00:00Z')
    const recent = touch(join(dir, 's-issue-20.events.jsonl'), '2026-08-26T10:00:00Z')
    const byIssue = (name: string, issues: string): boolean => issues === '' || name.includes(`-issue-${issues}.`)
    assert.equal(newestMatching(dir, '.events.jsonl', { issues: '', newerThan: '' }, byIssue), recent)
    assert.equal(newestMatching(dir, '.events.jsonl', { issues: '10', newerThan: '' }, byIssue), old)
    assert.equal(newestMatching(dir, '.events.jsonl', { issues: '10', newerThan: '9999999999' }, byIssue), null)
    assert.equal(newestMatching(dir, '.stream.jsonl', { issues: '', newerThan: '' }, byIssue), null)
  })
})

describe('LogCursor', () => {
  test('entrega las lineas pendientes y, tras consumirlas, solo lee lo nuevo', () => {
    const file = join(work, 'cursor.jsonl')
    writeFileSync(file, 'uno\ndos\n')
    const cursor = new LogCursor()
    const first = cursor.pending(file)
    assert.deepEqual(
      first.map((line) => [line.text, line.terminated]),
      [
        ['uno', true],
        ['dos', true],
      ],
    )
    for (const line of first) cursor.consume(line)
    assert.equal(cursor.lines, 2)
    assert.deepEqual(cursor.pending(file), [])
    appendFileSync(file, 'tres ñ\r\n')
    assert.deepEqual(
      cursor.pending(file).map((line) => line.text),
      ['tres ñ\r'],
    )
  })

  test('una linea sin consumir se vuelve a entregar, ya completa, en el siguiente sondeo', () => {
    const file = join(work, 'parcial.jsonl')
    writeFileSync(file, 'completa\n{"a":')
    const cursor = new LogCursor()
    const [complete, partial] = cursor.pending(file)
    assert.ok(complete !== undefined && partial !== undefined)
    assert.equal(partial.terminated, false)
    cursor.consume(complete)
    assert.deepEqual(
      cursor.pending(file).map((line) => line.text),
      ['{"a":'],
    )
    appendFileSync(file, '1}\notra\n')
    assert.deepEqual(
      cursor.pending(file).map((line) => [line.text, line.terminated]),
      [
        ['{"a":1}', true],
        ['otra', true],
      ],
    )
    assert.equal(cursor.lines, 1)
  })

  test('lo que se agrega a una linea consumida sin su salto no se relee', () => {
    const file = join(work, 'sin-salto.jsonl')
    writeFileSync(file, '{"a":1}')
    const cursor = new LogCursor()
    const [line] = cursor.pending(file)
    assert.ok(line !== undefined)
    cursor.consume(line)
    appendFileSync(file, ' resto')
    assert.deepEqual(cursor.pending(file), [])
    appendFileSync(file, ' y fin\nsiguiente\n')
    assert.deepEqual(
      cursor.pending(file).map((entry) => entry.text),
      ['siguiente'],
    )
    assert.equal(cursor.lines, 1)
  })

  test('las lineas vacias cuentan como lineas', () => {
    const file = join(work, 'vacias.jsonl')
    writeFileSync(file, 'a\n\n\n')
    assert.deepEqual(
      new LogCursor().pending(file).map((line) => line.text),
      ['a', '', ''],
    )
  })

  test('un archivo que no existe, un directorio o un archivo vacio no tienen lineas', () => {
    const empty = join(work, 'vacio.jsonl')
    writeFileSync(empty, '')
    assert.deepEqual(new LogCursor().pending(join(work, 'no-existe.jsonl')), [])
    assert.deepEqual(new LogCursor().pending(work), [])
    assert.deepEqual(new LogCursor().pending(empty), [])
  })
})

describe('follow', () => {
  test('repite el paso con la pausa pedida hasta que la senal aborta', async () => {
    const controller = new AbortController()
    let steps = 0
    await follow(
      () => {
        steps += 1
        if (steps === 3) controller.abort()
      },
      { intervalMs: 1, signal: controller.signal },
    )
    assert.equal(steps, 3)
  })

  test('con la senal ya abortada no da ningun paso', async () => {
    let steps = 0
    await follow(() => (steps += 1), { intervalMs: 1, signal: AbortSignal.abort() })
    assert.equal(steps, 0)
  })

  test('un fallo del paso corta el bucle y llega al llamador', async () => {
    await assert.rejects(
      follow(
        () => {
          throw new Error('paso roto')
        },
        { intervalMs: 1 },
      ),
      /paso roto/,
    )
  })
})
