import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseJq, plain } from '../lib/jq-literals.mts'
import { JqError } from '../lib/jq-values.mts'
import {
  PathError,
  documentText,
  eachValues,
  getLines,
  isJsonDocument,
  joinValues,
  lengthText,
  linesToArray,
  parsePath,
  pick,
  rawText,
  setText,
  valueAt,
} from '../lib/json-value.mts'

const CONFIG = parseJq(`{
  "projectName": "Demo",
  "namespacePrefix": "Acme",
  "peso": 1.0,
  "projections": { "enabled": false },
  "boundedContext": { "name": "Principal", "domains": ["control-horas", "nomina"] },
  "domainLabels": ["control-horas", "nomina", 3, null, true],
  "serviceBus": {
    "external": [
      { "alias": "BACKBONE", "alcance": "compartido" },
      { "alias": "SOCIO", "alcance": "externo" },
      { "alias": "OTRO", "alcance": "compartido", "secretName": null }
    ]
  },
  "tenancy": { "otro": 1 }
}`)

describe('parsePath', () => {
  test('separa claves e indices, con o sin punto inicial', () => {
    assert.deepEqual(parsePath('repoSlug'), ['repoSlug'])
    assert.deepEqual(parsePath('.tenancy.strategy'), ['tenancy', 'strategy'])
    assert.deepEqual(parsePath('boundedContext.domains[0]'), ['boundedContext', 'domains', 0])
    assert.deepEqual(parsePath('a[1][-1].b'), ['a', 1, -1, 'b'])
    assert.deepEqual(parsePath('[2].x'), [2, 'x'])
    assert.deepEqual(parsePath('.'), [])
  })

  test('rechaza una ruta vacia o mal formada', () => {
    for (const path of ['', 'a..b', 'a.', 'a[', 'a[x]', 'a[]', 'a.[0]', 'a[0]b']) {
      assert.throws(() => parsePath(path), PathError, path)
    }
  })
})

describe('valueAt', () => {
  test('lee por clave y por indice, y propaga null', () => {
    assert.equal(valueAt(CONFIG, ['namespacePrefix']), 'Acme')
    assert.equal(valueAt(CONFIG, ['boundedContext', 'domains', 1]), 'nomina')
    assert.equal(valueAt(CONFIG, ['boundedContext', 'domains', -1]), 'nomina')
    assert.equal(valueAt(CONFIG, ['boundedContext', 'domains', 9]), null)
    assert.equal(valueAt(CONFIG, ['noExiste', 'ni', 0, 'esto']), null)
    assert.equal(valueAt(CONFIG, []), CONFIG)
  })

  test('falla si el tipo no admite el paso', () => {
    assert.throws(() => valueAt(CONFIG, ['projectName', 'x']), JqError)
    assert.throws(() => valueAt(CONFIG, ['boundedContext', 0]), JqError)
    assert.throws(() => valueAt(CONFIG, ['domainLabels', 'x']), JqError)
  })
})

describe('getLines', () => {
  test('sin alternativa imprime el valor tal cual, null y false incluidos', () => {
    assert.deepEqual(getLines(CONFIG, ['namespacePrefix'], { kind: 'raw' }), ['Acme'])
    assert.deepEqual(getLines(CONFIG, ['projections', 'enabled'], { kind: 'raw' }), ['false'])
    assert.deepEqual(getLines(CONFIG, ['repoSlug'], { kind: 'raw' }), ['null'])
    assert.deepEqual(getLines(CONFIG, ['peso'], { kind: 'raw' }), ['1.0'])
  })

  test('empty no imprime nada cuando el valor es null o false', () => {
    assert.deepEqual(getLines(CONFIG, ['repoSlug'], { kind: 'empty' }), [])
    assert.deepEqual(getLines(CONFIG, ['projections', 'enabled'], { kind: 'empty' }), [])
    assert.deepEqual(getLines(CONFIG, ['namespacePrefix'], { kind: 'empty' }), ['Acme'])
  })

  test('un texto sustituye a null y a false', () => {
    const fallback = { kind: 'text', text: 'mono-tenant-transitorio' } as const
    assert.deepEqual(getLines(CONFIG, ['tenancy', 'strategy'], fallback), ['mono-tenant-transitorio'])
    assert.deepEqual(getLines(CONFIG, ['projections', 'enabled'], { kind: 'text', text: 'false' }), ['false'])
    assert.deepEqual(getLines(CONFIG, ['solutionFile'], { kind: 'text', text: '' }), [''])
    assert.deepEqual(getLines(CONFIG, ['namespacePrefix'], fallback), ['Acme'])
  })

  test('un objeto o un arreglo sale como JSON con sangria de 2', () => {
    assert.equal(rawText(parseJq('{"a":[1,{"b":null}],"c":{}}')), '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {}\n}')
    assert.deepEqual(getLines(CONFIG, ['projections'], { kind: 'raw' }), ['{\n  "enabled": false\n}'])
  })
})

describe('eachValues', () => {
  test('itera un arreglo y los valores de un objeto', () => {
    assert.deepEqual(eachValues(CONFIG, ['boundedContext', 'domains']), ['control-horas', 'nomina'])
    assert.deepEqual(eachValues(CONFIG, ['boundedContext']), ['Principal', ['control-horas', 'nomina']])
  })

  test('sin orEmpty falla sobre null; con orEmpty, null y false no dan elementos', () => {
    assert.throws(() => eachValues(CONFIG, ['noExiste']), JqError)
    assert.deepEqual(eachValues(CONFIG, ['noExiste'], { orEmpty: true }), [])
    assert.deepEqual(eachValues(CONFIG, ['projections', 'enabled'], { orEmpty: true }), [])
    assert.throws(() => eachValues(CONFIG, ['projectName'], { orEmpty: true }), JqError)
  })

  test('where filtra por igualdad de campo y field proyecta', () => {
    const options = { orEmpty: true, where: [{ field: 'alcance', value: 'compartido' }], field: 'alias' }
    assert.deepEqual(eachValues(CONFIG, ['serviceBus', 'external'], options), ['BACKBONE', 'OTRO'])
    assert.deepEqual(eachValues(CONFIG, ['serviceBus', 'external'], { field: 'secretName' }), [null, null, null])
    assert.deepEqual(
      eachValues(CONFIG, ['serviceBus', 'external'], {
        where: [
          { field: 'alcance', value: 'compartido' },
          { field: 'alias', value: 'OTRO' },
        ],
        field: 'alias',
      }),
      ['OTRO'],
    )
  })

  test('where y field fallan si un elemento no es objeto', () => {
    assert.throws(() => eachValues(CONFIG, ['domainLabels'], { where: [{ field: 'alcance', value: 'x' }] }), JqError)
    assert.throws(() => eachValues(CONFIG, ['domainLabels'], { field: 'alias' }), JqError)
  })

  test('last deja los ultimos elementos', () => {
    assert.deepEqual(eachValues(CONFIG, ['domainLabels'], { last: 2 }), [null, true])
    assert.deepEqual(eachValues(CONFIG, ['boundedContext', 'domains'], { last: 5 }), ['control-horas', 'nomina'])
  })
})

describe('joinValues', () => {
  test('une cadenas, numeros y booleanos; null es vacio', () => {
    assert.equal(joinValues(eachValues(CONFIG, ['domainLabels']), ', '), 'control-horas, nomina, 3, , true')
    assert.equal(joinValues([], ', '), '')
  })

  test('falla con un objeto o un arreglo', () => {
    assert.throws(() => joinValues([{}], ','), JqError)
    assert.throws(() => joinValues([[]], ','), JqError)
  })
})

describe('lengthText', () => {
  test('cuenta elementos, claves y caracteres; null y false cuentan 0', () => {
    assert.equal(lengthText(CONFIG, ['domainLabels']), '5')
    assert.equal(lengthText(CONFIG, ['boundedContext']), '2')
    assert.equal(lengthText(CONFIG, ['projectName']), '4')
    assert.equal(lengthText(CONFIG, ['noExiste']), '0')
    assert.equal(lengthText(CONFIG, ['projections', 'enabled']), '0')
    assert.equal(lengthText(parseJq('{"n":-3}'), ['n']), '3')
  })

  test('falla sobre true', () => {
    assert.throws(() => lengthText(parseJq('{"a":true}'), ['a']), JqError)
  })
})

describe('pick', () => {
  test('arma el objeto con las claves pedidas, null donde falten', () => {
    assert.deepEqual(pick(CONFIG, ['projectName', 'azureLocation', 'projections']), {
      projectName: 'Demo',
      azureLocation: null,
      projections: { enabled: false },
    })
    assert.deepEqual(pick(null, ['a']), { a: null })
  })

  test('falla si la raiz no es objeto', () => {
    assert.throws(() => pick([1], ['a']), JqError)
  })
})

describe('setText', () => {
  test('agrega la clave al objeto existente y conserva las demas', () => {
    assert.deepEqual(plain(setText(CONFIG, ['tenancy', 'strategy'], 'multi-tenant-header').tenancy ?? null), {
      otro: 1,
      strategy: 'multi-tenant-header',
    })
  })

  test('reemplaza el valor sin mover la clave', () => {
    const updated = setText(parseJq('{"a":1,"tenancy":{"strategy":"x","z":2},"b":3}'), ['tenancy', 'strategy'], 'y')
    assert.equal(documentText(updated), '{\n  "a": 1,\n  "tenancy": {\n    "strategy": "y",\n    "z": 2\n  },\n  "b": 3\n}\n')
  })

  test('crea los objetos intermedios que falten, o que sean null o false', () => {
    assert.deepEqual(plain(setText(parseJq('{"a":1}'), ['tenancy', 'strategy'], 'v')), { a: 1, tenancy: { strategy: 'v' } })
    assert.deepEqual(setText(parseJq('{"tenancy":null}'), ['tenancy', 'strategy'], 'v'), { tenancy: { strategy: 'v' } })
    assert.deepEqual(setText(parseJq('{"tenancy":false}'), ['tenancy', 'strategy'], 'v'), { tenancy: { strategy: 'v' } })
    assert.deepEqual(setText(null, ['a', 'b', 'c'], 'v'), { a: { b: { c: 'v' } } })
    assert.deepEqual(setText(parseJq('{"x":1}'), ['x'], 'v'), { x: 'v' })
  })

  test('conserva los literales de numero del resto del documento', () => {
    assert.equal(documentText(setText(parseJq('{"peso":1.0,"t":{}}'), ['t', 's'], 'v')), '{\n  "peso": 1.0,\n  "t": {\n    "s": "v"\n  }\n}\n')
  })

  test('falla si la raiz o un intermedio no es objeto', () => {
    assert.throws(() => setText(parseJq('{"tenancy":"x"}'), ['tenancy', 'strategy'], 'v'), JqError)
    assert.throws(() => setText(parseJq('{"tenancy":[1]}'), ['tenancy', 'strategy'], 'v'), JqError)
    assert.throws(() => setText(parseJq('[1]'), ['tenancy'], 'v'), JqError)
    assert.throws(() => setText(CONFIG, [], 'v'), PathError)
  })

  test('una clave __proto__ se escribe como dato', () => {
    const updated = setText(parseJq('{}'), ['__proto__', 'x'], 'v')
    assert.equal(documentText(updated), '{\n  "__proto__": {\n    "x": "v"\n  }\n}\n')
    assert.equal(Object.getPrototypeOf(updated), Object.prototype)
  })
})

describe('linesToArray', () => {
  test('cada linea es una cadena; el salto final no agrega un elemento', () => {
    assert.equal(linesToArray('https://a.test\nhttps://b.test\n'), '["https://a.test","https://b.test"]')
    assert.equal(linesToArray('sin salto final'), '["sin salto final"]')
    assert.equal(linesToArray('a\n\nb\n'), '["a","","b"]')
    assert.equal(linesToArray('con "comillas" y \\barra\n'), '["con \\"comillas\\" y \\\\barra"]')
  })

  test('sin lineas da un arreglo vacio; una linea vacia es una cadena vacia', () => {
    assert.equal(linesToArray(''), '[]')
    assert.equal(linesToArray('\n'), '[""]')
  })
})

describe('isJsonDocument', () => {
  test('acepta exactamente un documento JSON', () => {
    for (const text of ['{"a":1}', ' [1, 2]\n', '"x"', 'null', '3']) assert.equal(isJsonDocument(text), true, text)
  })

  test('rechaza el texto vacio, el JSON roto y mas de un documento', () => {
    for (const text of ['', ' \n', '{', '{"a":1,}', '{} {}', "{'a':1}", 'nan', '\uFEFF{}']) {
      assert.equal(isJsonDocument(text), false, text)
    }
  })
})
