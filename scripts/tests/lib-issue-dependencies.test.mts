import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dependenciesSection, forwardDependencies, hasDependenciesSection } from '../lib/issue-dependencies.mts'

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
