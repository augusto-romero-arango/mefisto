import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  canonicalDependencies,
  dependenciesSection,
  forwardDependencies,
  hasDependenciesSection,
} from '../lib/issue-dependencies.mts'

const BATCH_BODY = [
  '## Contexto',
  'Depende de #999 en prosa',
  '',
  '## Dependencias',
  '- Depende de #10',
  '* bloqueado por #11',
  '  Depende de #10',
  '- Bloquea #12',
  '- Relacionado: #13',
  'Ver tambien Depende de #14',
  '',
  '## Otra',
  'Depende de #15',
  '',
].join('\n')

describe('canonicalDependencies', () => {
  test('solo las canonicas de la seccion, sin repetir', () => {
    assert.deepEqual(canonicalDependencies(BATCH_BODY), ['10', '11'])
    assert.deepEqual(canonicalDependencies('## Dependencias\nNinguna\n'), [])
    assert.deepEqual(canonicalDependencies(''), [])
  })

  test('conserva el orden de aparicion', () => {
    const body = '## Dependencias\n- Depende de #99\n- Bloqueado por #100\n- Depende de #99\n- Depende de #7'
    assert.deepEqual(canonicalDependencies(body), ['99', '100', '7'])
    assert.deepEqual(forwardDependencies(body), ['100', '7', '99'])
  })

  test('mismas reglas de seccion e item que forwardDependencies, sin ordenar', () => {
    const cases: [string, string[]][] = [
      ['## Dependencias\n- Depende de #99\n- Bloqueado por #100\n- Depende de #99\n- Depende de #007', ['99', '100', '007']],
      ['## Dependencias\n\t -   DEPENDE DE   #7\n  bloqueado por\t#8\n-Depende de #9', ['7', '8']],
      ['## Dependencias\r\n\r\n- Depende de #5\r\n* Bloqueado por #6\r\n\r\n## Notas\r\n- Depende de #7\r\n', ['5', '6']],
      ['- Depende de #1\n## Contexto\n- Depende de #2', []],
      ['##dependencias externas\n- Depende de #3 (igual que en #4)\n### Detalle\n* Bloqueado por #5\n## Otra\n- Depende de #6', ['3', '5']],
      ['## DEPENDENCIAS\n- Depende de #1', []],
      [' ## Dependencias\n- Depende de #1', []],
      ['## Dependencias\n- Depende de #1\n## Otra\n- Depende de #2\n## Dependencias\n- Depende de #3', ['1', '3']],
      ['## Dependencias\n- No depende de #20\n- Ya no depende de #21\n- Consumido por #24\n- Depende de#25\n- Depende de # 26', []],
    ]
    for (const [body, expected] of cases) assert.deepEqual(canonicalDependencies(body), expected, JSON.stringify(body))
  })
})

describe('forwardDependencies', () => {
  test('solo cuenta el marcador al inicio del item y el primer numero de la linea', () => {
    const body = [
      '## Dependencias',
      '',
      '- Depende de #10 (igual que en #11)',
      '* Bloqueado por #12',
      'Depende de #13',
      '- No depende de #20',
      '- Ya no depende de #21',
      'Esta prosa Depende de #22 a mitad de linea',
      '- Bloquea #23',
      '- Consumido por #24',
    ].join('\n')
    assert.deepEqual(forwardDependencies(body), ['10', '12', '13'])
  })

  test('no distingue mayusculas y admite sangria y espacios de mas', () => {
    const body = '## Dependencias\n\t -   DEPENDE DE   #7\n  bloqueado por\t#8\n-Depende de #9'
    assert.deepEqual(forwardDependencies(body), ['7', '8'])
  })

  test('no repite y ordena como texto, con el numero tal como esta escrito', () => {
    const body = '## Dependencias\n- Depende de #99\n- Depende de #100\n- Depende de #99\n- Depende de #007'
    assert.deepEqual(forwardDependencies(body), ['007', '100', '99'])
  })

  test('acepta finales de linea CRLF', () => {
    const body = '## Dependencias\r\n\r\n- Depende de #5\r\n* Bloqueado por #6\r\n\r\n## Notas\r\n- Depende de #7\r\n'
    assert.deepEqual(forwardDependencies(body), ['5', '6'])
  })

  test('fuera de la seccion no hay dependencias', () => {
    assert.deepEqual(forwardDependencies('- Depende de #1\n## Contexto\n- Depende de #2'), [])
    assert.deepEqual(forwardDependencies(''), [])
  })
})

describe('dependenciesSection', () => {
  test('va del encabezado al siguiente encabezado de segundo nivel', () => {
    const body = 'Intro\n## Dependencias\nuno\n### Detalle\ndos\n## Otra\ntres'
    assert.deepEqual(dependenciesSection(body), ['uno', '### Detalle', 'dos'])
  })

  test('el encabezado admite minuscula, falta de espacio y texto detras', () => {
    assert.deepEqual(dependenciesSection('##dependencias externas\nuno'), ['uno'])
    assert.deepEqual(dependenciesSection('## DEPENDENCIAS\nuno'), [])
    assert.deepEqual(dependenciesSection(' ## Dependencias\nuno'), [])
  })

  test('un segundo encabezado de dependencias reabre la seccion', () => {
    const body = '## Dependencias\nuno\n## Otra\ndos\n## Dependencias\ntres'
    assert.deepEqual(dependenciesSection(body), ['uno', 'tres'])
  })
})

describe('hasDependenciesSection', () => {
  test('distingue la seccion vacia de la ausente', () => {
    assert.equal(hasDependenciesSection('texto\n## Dependencias\n'), true)
    assert.equal(hasDependenciesSection('## Idea\n\nAlgo sobre Dependencias.'), false)
    assert.equal(hasDependenciesSection(''), false)
  })
})
