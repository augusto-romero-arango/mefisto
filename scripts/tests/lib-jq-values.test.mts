import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  JqError,
  add,
  alt,
  compare,
  divide,
  dump,
  get,
  groupBy,
  has,
  iterate,
  length,
  negate,
  numberText,
  parseStream,
  path,
  slice,
  sortBy,
  subtract,
  sum,
  toEntries,
  toNumber,
  toText,
  unique,
} from '../lib/jq-values.mts'
import type { Json } from '../lib/jq-values.mts'

// Los resultados esperados se tomaron de jq 1.7.1.

test('el orden total va de null a objetos', () => {
  const values: Json[] = [[null, 'a'], ['', 'a'], [false], [0], ['a', 1], { a: 1 }, 'b', 3, true, null, []]
  assert.deepEqual(sortBy(values, (value) => value), [null, true, 3, 'b', [], [null, 'a'], [false], [0], ['', 'a'], ['a', 1], { a: 1 }])
  assert.equal(compare(null, false), -1)
  assert.equal(compare('a', 0), 1)
  assert.equal(compare([], 'a'), 1)
  assert.equal(compare({}, []), 1)
  assert.equal(compare(1, 1.0), 0)
  assert.equal(compare({ a: 1, b: 2 }, { b: 2, a: 1 }), 0)
})

test('las cadenas se ordenan por punto de codigo', () => {
  assert.deepEqual(sortBy(['é', 'z', '😀', '￮'], (value) => value), ['z', 'é', '￮', '😀'])
  assert.equal(compare('a', 'ab'), -1)
})

test('sortBy es estable y groupBy conserva el orden de entrada en cada grupo', () => {
  const items = [{ k: 'b', n: 1 }, { k: null, n: 2 }, { k: 'a', n: 3 }, { n: 4 }, { k: 'b', n: 5 }]
  assert.deepEqual(
    groupBy(items, (item) => item.k ?? null).map((group) => group.map((item) => item.n)),
    [[2, 4], [3], [1, 5]],
  )
  assert.deepEqual(unique([null, 'b', 'a', 'b']), [null, 'a', 'b'])
})

test('indexar: null da null y lo que no es objeto falla', () => {
  assert.equal(get(null, 'a'), null)
  assert.equal(get({ a: 1 }, 'b'), null)
  assert.equal(path({ a: { b: 1 } }, 'a', 'b'), 1)
  assert.equal(path({ a: null }, 'a', 'b', 'c'), null)
  assert.throws(() => get('texto', 'a'), JqError)
  assert.throws(() => get([1], 'a'), JqError)
  assert.throws(() => path({ a: 5 }, 'a', 'b'), JqError)
  assert.equal(has({ a: null }, 'a'), true)
  assert.throws(() => has([1], 'a'), JqError)
})

test('`//` sustituye null y false, no el cero ni la cadena vacia', () => {
  assert.equal(alt(null, 5), 5)
  assert.equal(alt(false, 5), 5)
  assert.equal(alt(0, 7), 0)
  assert.equal(alt('', 8), '')
})

test('suma: null es neutro y los tipos distintos fallan', () => {
  assert.equal(add(null, 1), 1)
  assert.equal(add(1, null), 1)
  assert.equal(add(null, null), null)
  assert.equal(add('a', 'b'), 'ab')
  assert.deepEqual(add([1], [2]), [1, 2])
  assert.deepEqual(add({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
  assert.throws(() => add(1, 'a'), JqError)
  assert.equal(sum([]), null)
  assert.equal(sum([null, 2, null, 3]), 5)
})

test('resta, division y negacion solo operan numeros', () => {
  assert.equal(subtract(5, 2), 3)
  assert.equal(divide(3, 2), 1.5)
  assert.equal(negate(4), -4)
  assert.throws(() => subtract(null, 1), JqError)
  assert.throws(() => subtract('a', 'b'), JqError)
  assert.throws(() => divide('a', 2), JqError)
  assert.throws(() => divide(1, 0), JqError)
  assert.throws(() => negate('a'), JqError)
})

test('longitud, corte, iteracion y entradas', () => {
  assert.equal(length(null), 0)
  assert.equal(length('añ😀'), 3)
  assert.equal(length({ a: 1 }), 1)
  assert.equal(length(-5), 5)
  assert.throws(() => length(true), JqError)
  assert.equal(slice('añ😀bcdefgh', 0, 8), 'añ😀bcdef')
  assert.equal(slice(null, 0, 8), null)
  assert.deepEqual(slice([1, 2, 3], 0, 8), [1, 2, 3])
  assert.throws(() => slice(5, 0, 8), JqError)
  assert.deepEqual(iterate({ a: 1, b: 2 }), [1, 2])
  assert.throws(() => iterate('abc'), JqError)
  assert.throws(() => iterate(null), JqError)
  assert.deepEqual(toEntries([[1, 2]]), [{ key: 0, value: [1, 2] }])
  assert.deepEqual(toEntries({ z: 1, a: 2 }), [{ key: 'z', value: 1 }, { key: 'a', value: 2 }])
  assert.throws(() => toEntries('abc'), JqError)
})

test('tonumber', () => {
  assert.equal(toNumber(' 1'), 1)
  assert.equal(toNumber('1 '), 1)
  assert.equal(toNumber('+5'), 5)
  assert.equal(toNumber('.5'), 0.5)
  assert.equal(toNumber('5.'), 5)
  assert.equal(toNumber('1e2'), 100)
  assert.equal(toNumber('infinity'), Number.MAX_VALUE)
  assert.ok(Number.isNaN(toNumber('nan')))
  for (const text of ['', '-', '0x10', '1_0', '0-rc1']) assert.throws(() => toNumber(text), JqError)
})

test('texto de un numero calculado', () => {
  const cases: [number, string][] = [
    [78, '78'],
    [1e15, '1000000000000000'],
    [1e16, '1e+16'],
    [1.23e19, '1.23e+19'],
    [-1e16, '-1e+16'],
    [1e15 + 1, '1000000000000001'],
    [9007199254740992, '9007199254740992'],
    [1e-5, '1e-05'],
    [1e-4, '0.0001'],
    [0.001, '0.001'],
    [1.5e-7, '1.5e-07'],
    [123456789, '123456789'],
    [100 / 3, '33.333333333333336'],
    [0.1 + 0.2, '0.30000000000000004'],
    [1000000000000000.5, '1000000000000000.5'],
    [-0, '-0'],
    [1e301, '1e+301'],
    [5e-324, '5e-324'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
    [Infinity, '1.7976931348623157e+308'],
    [NaN, 'null'],
  ]
  for (const [value, expected] of cases) assert.equal(numberText(value), expected)
})

test('dump imprime compacto o con sangria, y escapa DEL', () => {
  const value: Json = { a: [], b: {}, c: '\u007f \u001f é 😀 </script>', d: [1, { x: null }] }
  assert.equal(dump(value), '{"a":[],"b":{},"c":"\\u007f \\u001f é 😀 </script>","d":[1,{"x":null}]}')
  assert.equal(
    dump(value, 2),
    ['{', '  "a": [],', '  "b": {},', '  "c": "\\u007f \\u001f é 😀 </script>",', '  "d": [', '    1,', '    {', '      "x": null', '    }', '  ]', '}'].join('\n'),
  )
  assert.equal(toText('x'), 'x')
  assert.equal(toText(7), '7')
  assert.equal(toText(null), 'null')
  assert.equal(toText({ a: [1, 'x'] }), '{"a":[1,"x"]}')
})

test('parseStream lee valores concatenados hasta el primero invalido', () => {
  assert.deepEqual(parseStream('{"a":1}\n'), { values: [{ a: 1 }], clean: true })
  assert.deepEqual(parseStream('﻿{"a":"}{"} [1,[2]] "x y" 5 true'), { values: [{ a: '}{' }, [1, [2]], 'x y', 5, true], clean: true })
  assert.deepEqual(parseStream('{"a":1} { roto'), { values: [{ a: 1 }], clean: false })
  assert.deepEqual(parseStream('{"a": '), { values: [], clean: false })
  assert.deepEqual(parseStream('  \n'), { values: [], clean: true })
})
