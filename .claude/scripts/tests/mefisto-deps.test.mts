import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  dependenciesSection,
  forwardDependencies,
  hasDependenciesSection,
} from '../../../scripts/lib/issue-dependencies.mts'

const BODIES: Record<string, string> = {
  vacio: '',
  'sin seccion': '# Titulo\n\nDepende de #5\n',
  canonico: '## Dependencias\n\nDepende de #44\nBloqueado por #7\n',
  vinetas: '## Dependencias\n- Depende de #1\n* bloqueado POR #2\n  -   DEPENDE DE   #3\n\tDepende de\t#4\n',
  negaciones: '## Dependencias\n- No depende de #65\n- Ya no depende de #65\n- Esto depende de #66\n',
  inversas: '## Dependencias\nBloquea #61\nConsumido por #62\nRelacionado con #63\nDepende del write-side: #64\n',
  'solo el primer numero': '## Dependencias\n- Depende de #10 y de #11\n- Depende de #9, #8\n',
  'repetidas y orden de texto': '## Dependencias\nDepende de #9\nDepende de #10\nDepende de #9\nDepende de #100\n',
  'corta en el siguiente encabezado': '## Dependencias\nDepende de #1\n## Notas\nDepende de #2\n',
  'subencabezado dentro': '## Dependencias\n### Duras\nDepende de #1\n###Blandas\nDepende de #2\n',
  'encabezado sin espacio': '##dependencias\nDepende de #3\n##Otra\nDepende de #4\n',
  'seccion repetida': '## Dependencias\nDepende de #1\n## Otra\n## Dependencias tecnicas\nDepende de #2\n',
  'mayuscula inicial distinta': '## DEPENDENCIAS\nDepende de #1\n',
  'sin salto final': '## Dependencias\nDepende de #12',
  crlf: '## Dependencias\r\nDepende de #5\r\n- Bloqueado por #6\r\n## Otra\r\nDepende de #7\r\n',
  'sin numeral': '## Dependencias\nDepende de 5\nDepende de # 6\nDepende de #x7\n',
  'seccion vacia': '## Contexto\n\ntexto\n\n## Dependencias\n\n## Criterios\n',
}

describe('dependenciesSection', () => {
  test('devuelve las lineas de la seccion sin su encabezado', () => {
    assert.deepEqual(dependenciesSection('# T\n## Dependencias\n\nDepende de #1\n## Otra\nx\n'), [
      '',
      'Depende de #1',
    ])
  })

  test('sin seccion no devuelve nada', () => {
    assert.deepEqual(dependenciesSection('# T\n\ntexto\n'), [])
    assert.deepEqual(dependenciesSection(''), [])
  })

  test('un encabezado de tercer nivel no cierra la seccion', () => {
    assert.deepEqual(dependenciesSection('## Dependencias\n### Duras\nDepende de #1\n'), [
      '### Duras',
      'Depende de #1',
    ])
  })
})

describe('forwardDependencies', () => {
  test('lee Depende de y Bloqueado por, con vineta opcional y sin distinguir mayusculas', () => {
    assert.deepEqual(forwardDependencies(BODIES.vinetas ?? ''), ['1', '2', '3', '4'])
  })

  test('una negacion o un marcador a mitad de linea no es una dependencia', () => {
    assert.deepEqual(forwardDependencies(BODIES.negaciones ?? ''), [])
  })

  test('ignora las referencias inversas y la prosa', () => {
    assert.deepEqual(forwardDependencies(BODIES.inversas ?? ''), [])
  })

  test('toma solo el primer numero de cada linea', () => {
    assert.deepEqual(forwardDependencies(BODIES['solo el primer numero'] ?? ''), ['10', '9'])
  })

  test('no repite y ordena como texto', () => {
    assert.deepEqual(forwardDependencies(BODIES['repetidas y orden de texto'] ?? ''), ['10', '100', '9'])
  })

  test('no lee fuera de la seccion', () => {
    assert.deepEqual(forwardDependencies(BODIES['sin seccion'] ?? ''), [])
    assert.deepEqual(forwardDependencies(BODIES['corta en el siguiente encabezado'] ?? ''), ['1'])
  })
})

describe('hasDependenciesSection', () => {
  test('reconoce la seccion aunque este vacia', () => {
    assert.equal(hasDependenciesSection(BODIES['seccion vacia'] ?? ''), true)
    assert.equal(hasDependenciesSection('##dependencias\n'), true)
  })

  test('no la confunde con otro encabezado ni con otro nivel', () => {
    assert.equal(hasDependenciesSection('## Notas\nDependencias: ninguna\n'), false)
    assert.equal(hasDependenciesSection('### Dependencias\n'), false)
    assert.equal(hasDependenciesSection(' ## Dependencias\n'), false)
  })
})

test('cada body: dependencias, si tiene la seccion y sus lineas', () => {
  const expected: Record<string, [string[], boolean, string[]]> = {
    vacio: [[], false, []],
    'sin seccion': [[], false, []],
    canonico: [['44', '7'], true, ['', 'Depende de #44', 'Bloqueado por #7']],
    vinetas: [['1', '2', '3', '4'], true, ['- Depende de #1', '* bloqueado POR #2', '  -   DEPENDE DE   #3', '\tDepende de\t#4']],
    negaciones: [[], true, ['- No depende de #65', '- Ya no depende de #65', '- Esto depende de #66']],
    inversas: [[], true, ['Bloquea #61', 'Consumido por #62', 'Relacionado con #63', 'Depende del write-side: #64']],
    'solo el primer numero': [['10', '9'], true, ['- Depende de #10 y de #11', '- Depende de #9, #8']],
    'repetidas y orden de texto': [['10', '100', '9'], true, ['Depende de #9', 'Depende de #10', 'Depende de #9', 'Depende de #100']],
    'corta en el siguiente encabezado': [['1'], true, ['Depende de #1']],
    'subencabezado dentro': [['1', '2'], true, ['### Duras', 'Depende de #1', '###Blandas', 'Depende de #2']],
    'encabezado sin espacio': [['3', '4'], true, ['Depende de #3', '##Otra', 'Depende de #4']],
    'seccion repetida': [['1', '2'], true, ['Depende de #1', 'Depende de #2']],
    'mayuscula inicial distinta': [[], false, []],
    'sin salto final': [['12'], true, ['Depende de #12']],
    crlf: [['5', '6'], true, ['Depende de #5\r', '- Bloqueado por #6\r']],
    'sin numeral': [[], true, ['Depende de 5', 'Depende de # 6', 'Depende de #x7']],
    'seccion vacia': [[], true, ['']],
  }
  assert.deepEqual(Object.keys(expected), Object.keys(BODIES))
  for (const [name, body] of Object.entries(BODIES)) {
    assert.deepEqual([forwardDependencies(body), hasDependenciesSection(body), dependenciesSection(body)], expected[name], name)
  }
})
