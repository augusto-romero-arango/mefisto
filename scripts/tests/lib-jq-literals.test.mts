import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { capture, commandExists } from '../lib/cli.mts'
import {
  NumberLiteral,
  add,
  compare,
  dumpJq,
  equals,
  firstTruthy,
  get,
  isJqObject,
  isNumber,
  iterate,
  numberFromToken,
  numberOf,
  parseJq,
  parseJqStream,
  path,
  plain,
  subtract,
  toNumber,
  toText,
  typeOf,
} from '../lib/jq-literals.mts'
import { JqError } from '../lib/jq-values.mts'

// Los resultados esperados se tomaron de jq 1.7.1.

const roundTrip = (text: string): string => dumpJq(parseJq(text))

// Textos de la paridad con `jq -c .`: cada uno es un valor JSON, con la tolerancia de jq.
const TEXTS = [
  '1.0', '0.10', '1e2', '1.5e3', '5e-7', '1E-7', '100000000000000000000', '0.1', '1e1000', '-1e1000', '-0', '-0.0', '1.10e1',
  '0.000001', '0.0000001', '1e-5', '12345678901234567890.5', '007', '+5', '.5', '5.', '5.e3', '0e5', '0.00', '2.50e2', '1E+2',
  '-12.340', '0', '123', 'nan', 'NaN', '-nan', 'inf', 'Infinity', '-Infinity', 'true', 'false', 'null', '""', '"a\\tb\\u00e9\\ud83d\\ude00"',
  '"x\\udc00"', '"\\udc00x\\ud83d\\ude00"', '"\\u007f\\u0000"', '[]', '{}', '[1.0,[2.50,{"a":3e0}],"x"]', '{"b":1.0,"a":{"c":[]},"b":2.00}',
  ' \t\r\n{"a" : [ 1 , 2 ] }\n', '\uFEFF{"a":1}', '{"__proto__":{"x":1.0},"constructor":2}',
]

// Textos que jq rechaza.
const INVALID = ['', ' ', '{', '[1,]', '{"a":1,}', '{"a"}', '{a:1}', "'x'", '"abc', '"a\tb"', '"\\x"', 'tru', 'nul', 'nanx', '0x10', '1e', '--5', '1_0', '.', '-', '1 2', '{}{}', '{"a":1}x', ']', '1,2', '"\\ud800x"', '"\\ud800\\u0041"', '"\\ud800"']

describe('literales de numero', () => {
  test('un numero conserva su literal en forma canonica', () => {
    const cases: [string, string][] = [
      ['1.0', '1.0'],
      ['0.10', '0.10'],
      ['1e2', '1E+2'],
      ['1.5e3', '1.5E+3'],
      ['5e-7', '5E-7'],
      ['100000000000000000000', '100000000000000000000'],
      ['1e1000', '1E+1000'],
      ['-0', '-0'],
      ['1.10e1', '11.0'],
      ['0.000001', '0.000001'],
      ['0.0000001', '1E-7'],
      ['1e-5', '0.00001'],
      ['12345678901234567890.5', '12345678901234567890.5'],
      ['007', '7'],
      ['+5', '5'],
      ['.5', '0.5'],
      ['5.', '5'],
      ['2.50e2', '250'],
      ['0.00', '0.00'],
    ]
    for (const [text, expected] of cases) assert.equal(roundTrip(text), expected, text)
  })

  test('nan sale como null e infinito como el mayor double', () => {
    assert.equal(roundTrip('nan'), 'null')
    assert.equal(roundTrip('NaN'), 'null')
    assert.equal(roundTrip('Infinity'), '1.7976931348623157e+308')
    assert.equal(roundTrip('-inf'), '-1.7976931348623157e+308')
  })

  test('numberFromToken da el valor del literal y rechaza lo que no es un numero', () => {
    const literal = numberFromToken('1.50')
    assert.ok(literal instanceof NumberLiteral)
    assert.equal(literal.value, 1.5)
    assert.equal(literal.text, '1.50')
    assert.equal(numberOf(numberFromToken('1e1000') ?? 0), Number.MAX_VALUE)
    for (const token of ['', '.', '-', 'e5', '1e', '0x10', '1_0', 'abc', '1 ']) assert.equal(numberFromToken(token), null, token)
  })

  test('un numero calculado pierde el literal', () => {
    const value = parseJq('{"a":1.0,"b":0.50}')
    assert.equal(dumpJq(subtract(get(value, 'a'), get(value, 'b'))), '0.5')
    assert.equal(dumpJq(add(get(value, 'a'), get(value, 'b'))), '1.5')
    assert.equal(dumpJq(add(get(value, 'a'), null)), '1.0')
  })

  test('toNumber lee una cadena como jq: con espacios alrededor, y solo si es un numero', () => {
    assert.equal(dumpJq(toNumber('125')), '125')
    assert.equal(dumpJq(toNumber(' 12 \n')), '12')
    assert.equal(dumpJq(toNumber('1.50')), '1.50')
    assert.equal(dumpJq(toNumber('nan')), 'null')
    for (const text of ['', 'abc', 'true', 'null', '[1]', '"5"', '1 2', '12abc']) assert.throws(() => toNumber(text), JqError, text)
  })
})

describe('lectura y escritura', () => {
  test('parseJq exige un unico valor valido', () => {
    assert.deepEqual(plain(parseJq(' {"a":[1,"x",null,true]} ')), { a: [1, 'x', null, true] })
    for (const text of INVALID) assert.throws(() => parseJq(text), JqError, JSON.stringify(text))
  })

  test('parseJqStream lee valores seguidos hasta el primero invalido', () => {
    assert.deepEqual(parseJqStream('1 "a"{"b":2}[3] true').values.map(plain), [1, 'a', { b: 2 }, [3], true])
    assert.deepEqual(parseJqStream('  \n').values, [])
    assert.equal(parseJqStream('').clean, true)
    const cut = parseJqStream('{"a":1} {"b":')
    assert.equal(cut.clean, false)
    assert.deepEqual(cut.values.map(plain), [{ a: 1 }])
  })

  test('una clave repetida conserva su posicion y toma el ultimo valor', () => {
    assert.equal(roundTrip('{"b":1.0,"a":{"c":[]},"b":2.00}'), '{"b":2.00,"a":{"c":[]}}')
  })

  test('__proto__ es una clave como cualquier otra', () => {
    const value = parseJq('{"__proto__":{"x":1}}')
    assert.equal(dumpJq(value), '{"__proto__":{"x":1}}')
    assert.equal(Object.getPrototypeOf(value), Object.prototype)
    assert.equal(dumpJq(get(value, '__proto__')), '{"x":1}')
  })

  test('un surrogate bajo suelto se sustituye por U+FFFD; uno alto sin su par es invalido', () => {
    assert.equal(parseJq('"x\\udc00"'), 'x\uFFFD')
    assert.equal(parseJq('"\\ud83d\\ude00"'), '😀')
    assert.throws(() => parseJq('"\\ud800x"'), JqError)
  })

  test('dumpJq con sangria escribe como jq sin -c', () => {
    assert.equal(dumpJq(parseJq('{"a":[1,2.0],"b":"x","c":{},"d":[]}'), 2), '{\n  "a": [\n    1,\n    2.0\n  ],\n  "b": "x",\n  "c": {},\n  "d": []\n}')
  })

  test('toText deja las cadenas tal cual y serializa lo demas', () => {
    assert.equal(toText('a"b'), 'a"b')
    assert.equal(toText(parseJq('1.0')), '1.0')
    assert.equal(toText(parseJq('{"a":[1.50]}')), '{"a":[1.50]}')
    assert.equal(toText(null), 'null')
  })
})

describe('operaciones', () => {
  const value = parseJq('{"a":{"b":1.0},"s":"x","n":null,"f":false,"l":[1,2]}')

  test('indexar: null da null y lo que no es objeto falla', () => {
    assert.equal(dumpJq(path(value, 'a', 'b')), '1.0')
    assert.equal(path(value, 'n', 'x', 'y'), null)
    assert.equal(get(value, 'ausente'), null)
    assert.equal(get(undefined, 'a'), null)
    assert.throws(() => path(value, 's', 'x'), JqError)
    assert.throws(() => path(value, 'a', 'b', 'c'), JqError)
    assert.throws(() => get(get(value, 'l'), 'x'), JqError)
  })

  test('firstTruthy evalua solo los operandos que hacen falta', () => {
    const calls: string[] = []
    const operand = (name: string, result: ReturnType<typeof parseJq>) => () => {
      calls.push(name)
      return result
    }
    assert.equal(firstTruthy(operand('a', null), operand('b', 'x'), operand('c', 'y')), 'x')
    assert.deepEqual(calls, ['a', 'b'])
    assert.equal(firstTruthy(() => null, () => false), false)
    assert.equal(firstTruthy(() => false, () => null), null)
    assert.equal(firstTruthy(() => 0), 0)
    assert.equal(firstTruthy(() => ''), '')
    assert.throws(() => firstTruthy(() => null, () => path(value, 's', 'x')), JqError)
  })

  test('los literales se comparan por su valor', () => {
    assert.equal(equals(parseJq('1.0'), 1), true)
    assert.equal(equals(parseJq('[1.0,{"a":2.50}]'), parseJq('[1,{"a":2.5}]')), true)
    assert.equal(compare(parseJq('1.5'), parseJq('2')), -1)
    assert.equal(compare(parseJq('"a"'), parseJq('1e9')), 1)
  })

  test('tipos, iteracion y suma', () => {
    assert.deepEqual(['1.0', '1', '"a"', 'null', 'true', '[]', '{}'].map((text) => typeOf(parseJq(text))), ['number', 'number', 'string', 'null', 'boolean', 'array', 'object'])
    assert.equal(isNumber(parseJq('1.0')), true)
    assert.equal(isJqObject(parseJq('1.0')), false)
    assert.equal(isJqObject(parseJq('{}')), true)
    assert.deepEqual(iterate(parseJq('{"a":1,"b":2}')).map(plain), [1, 2])
    assert.throws(() => iterate('texto'), JqError)
    assert.throws(() => iterate(parseJq('1.0')), JqError)
    assert.equal(dumpJq(add(parseJq('{"a":1.0,"b":2}'), parseJq('{"a":9.50,"c":3}'))), '{"a":9.50,"b":2,"c":3}')
    assert.equal(add('a', 'b'), 'ab')
    assert.deepEqual(add([1], [2]), [1, 2])
    assert.throws(() => add(5, {}), JqError)
    assert.throws(() => add('x', parseJq('1.0')), JqError)
    assert.throws(() => subtract('5000', 1), JqError)
  })
})

const NO_JQ = process.platform === 'win32' || !commandExists('jq') ? 'requiere jq' : false

describe('paridad con jq', { skip: NO_JQ }, () => {
  const jq = (args: string[], input: string): { status: number | null; stdout: string } => capture('jq', args, { input })

  test('jq -c . imprime lo mismo que dumpJq', () => {
    for (const text of TEXTS) {
      const fromJq = jq(['-c', '.'], text)
      assert.equal(fromJq.status, 0, text)
      assert.equal(`${roundTrip(text)}\n`, fromJq.stdout, text)
    }
  })

  test('jq . imprime lo mismo que dumpJq con sangria', () => {
    for (const text of TEXTS) assert.equal(`${dumpJq(parseJq(text), 2)}\n`, jq(['.'], text).stdout, text)
  })

  test('fromjson acepta y rechaza los mismos textos', () => {
    for (const text of [...TEXTS, ...INVALID]) {
      const fromJq = jq(['-R', '-s', '-c', 'fromjson'], text)
      let fromTypescript: string | null = null
      try {
        fromTypescript = `${roundTrip(text)}\n`
      } catch (error) {
        assert.ok(error instanceof JqError)
      }
      assert.equal(fromTypescript, fromJq.status === 0 ? fromJq.stdout : null, JSON.stringify(text))
    }
  })

  test('tonumber acepta y rechaza las mismas cadenas', () => {
    for (const text of ['125', ' 12 \n', '1.50', '007', '+5', '.5', '1e3', 'nan', 'inf', '', 'abc', 'true', 'null', '[1]', '"5"', '1 2', '12abc', '0x10']) {
      const fromJq = jq(['-R', '-s', '-c', 'tonumber'], text)
      let fromTypescript: string | null = null
      try {
        fromTypescript = `${dumpJq(toNumber(text))}\n`
      } catch (error) {
        assert.ok(error instanceof JqError)
      }
      assert.equal(fromTypescript, fromJq.status === 0 ? fromJq.stdout : null, JSON.stringify(text))
    }
  })

  test('un stream de valores se corta donde lo corta jq', () => {
    for (const text of ['1 "a"{"b":2}[3] true', '{"a":1.0} {"b":', '1.0 2.00 x 3', '', ' \n ', '{}{}', '"a""b"', '1{}', 'truefalse', '[1][2', '007 +1 .5']) {
      const fromJq = jq(['-c', '.'], text)
      const stream = parseJqStream(text)
      assert.equal(stream.values.map((value) => `${dumpJq(value)}\n`).join(''), fromJq.stdout, JSON.stringify(text))
      assert.equal(stream.clean, fromJq.status === 0, JSON.stringify(text))
    }
  })
})
