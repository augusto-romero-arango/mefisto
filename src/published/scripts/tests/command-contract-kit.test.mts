// Piezas puras del kit de contrato de comandos: recortes de texto, orden de lineas y de
// marcadores, lectura tolerante de archivos y recorrido de JSON.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  afterFirst,
  ascending,
  beforeFirst,
  commandContract,
  isExecutable,
  jsonStrings,
  lineCount,
  linesWith,
  metadataOf,
  misplacedLines,
  misplacedOffsets,
  repoFileExists,
  repoText,
  sameBytes,
  soleLine,
} from './command-contract-kit.mts'

describe('recortes de texto', () => {
  test('afterFirst y beforeFirst cortan en la primera aparicion', () => {
    assert.equal(afterFirst('uno|dos|tres', '|'), 'dos|tres')
    assert.equal(beforeFirst('uno|dos|tres', '|'), 'uno')
    assert.equal(beforeFirst(afterFirst('a [b] c [d]', '['), ']'), 'b')
  })

  test('sin la marca devuelven el texto entero', () => {
    assert.equal(afterFirst('uno dos', '|'), 'uno dos')
    assert.equal(beforeFirst('uno dos', '|'), 'uno dos')
  })

  test('linesWith junta las lineas que casan y lineCount las cuenta', () => {
    const text = 'run a\nskip\nrun b run c'
    assert.equal(linesWith(text, 'run'), 'run a\nrun b run c')
    assert.equal(linesWith(text, /^skip$/), 'skip')
    assert.equal(linesWith(text, 'nada'), '')
    assert.equal(lineCount(text, 'run'), 2)
    assert.equal(lineCount(text, /^run/), 2)
  })
})

describe('orden de lineas', () => {
  test('soleLine exige una sola linea con la marca', () => {
    assert.equal(soleLine('a\nguard\nb', 'guard'), 2)
    assert.ok(Number.isNaN(soleLine('a\nb', 'guard')))
    assert.ok(Number.isNaN(soleLine('guard\nguard', 'guard')))
  })

  test('ascending pide lineas existentes y estrictamente crecientes', () => {
    assert.equal(ascending(1, 2, 5), true)
    assert.equal(ascending(3), true)
    assert.equal(ascending(2, 2), false)
    assert.equal(ascending(3, 2), false)
    assert.equal(ascending(0, 2), false)
    assert.equal(ascending(1, 0), false)
    assert.equal(ascending(Number.NaN, 2), false)
    assert.equal(ascending(1, Number.NaN), false)
  })

  test('misplacedLines compara la primera linea de cada marcador', () => {
    const text = 'guard\nconfirma\nrama\nconfirma\nPR'
    assert.deepEqual(misplacedLines(text, ['guard', 'confirma', 'rama', 'PR']), [])
    assert.deepEqual(misplacedLines(text, ['guard', 'rama', 'confirma', 'PR']), ['confirma'])
    assert.deepEqual(misplacedLines(text, ['guard', 'falta', 'rama']), ['falta'])
    assert.deepEqual(misplacedLines('a b', ['a', 'b']), ['b'])
  })

  test('misplacedOffsets compara posiciones, tambien dentro de una linea y entre lineas', () => {
    assert.deepEqual(misplacedOffsets('a b', ['a', 'b']), [])
    assert.deepEqual(misplacedOffsets('b a', ['a', 'b']), ['b'])
    assert.deepEqual(misplacedOffsets('--env "$ENV"\n```\nrerun', ['--env "$ENV"\n```', 'rerun']), [])
    assert.deepEqual(misplacedOffsets('a c', ['a', 'b', 'c']), ['b'])
    assert.deepEqual(misplacedOffsets('', ['a']), ['a'])
  })
})

describe('archivos del repo', () => {
  const kit = 'src/published/scripts/tests/command-contract-kit.mts'

  test('repoText devuelve vacio si el archivo no existe y quita los saltos finales', () => {
    assert.equal(repoText('no/existe.md'), '')
    assert.ok(repoText(kit).startsWith('// Piezas comunes'))
    assert.ok(!repoText(kit).endsWith('\n'))
  })

  test('repoFileExists, sameBytes e isExecutable no fallan con rutas ausentes', () => {
    assert.equal(repoFileExists(kit), true)
    assert.equal(repoFileExists('src/published/scripts/tests'), false)
    assert.equal(repoFileExists('no/existe.md'), false)
    assert.equal(sameBytes(kit, kit), true)
    assert.equal(sameBytes(kit, 'src/published/scripts/tests/command-contract-kit.test.mts'), false)
    assert.equal(sameBytes(kit, 'no/existe.md'), false)
    assert.equal(isExecutable('no/existe.sh'), false)
  })

  test('isExecutable mira el bit de ejecucion', { skip: process.platform === 'win32' }, () => {
    assert.equal(isExecutable('scripts/next-order.sh'), true)
    assert.equal(isExecutable(kit), false)
  })
})

describe('contrato de un comando', () => {
  test('commandContract arma las tres rutas y separa frontmatter y cuerpo', () => {
    const command = commandContract('bug')
    assert.equal(command.sourcePath, 'src/published/commands/bug.md')
    assert.equal(command.claudePath, 'dist/claude/commands/bug.md')
    assert.equal(command.mirrorPath, 'commands/bug.md')
    assert.equal(metadataOf(command).id, 'bug')
    assert.ok(!command.body.includes(command.metadata))
    assert.equal(command.claude, command.mirror)
  })

  test('un comando inexistente deja los textos vacios', () => {
    const command = commandContract('no-existe')
    assert.deepEqual(
      [command.source, command.metadata, command.body, command.claude, command.mirror],
      ['', '', '', '', ''],
    )
    assert.throws(() => metadataOf(command), SyntaxError)
  })
})

describe('jsonStrings', () => {
  test('recoge las cadenas que son valor, a cualquier profundidad, y no las claves', () => {
    const value = { clave: 'a', lista: ['b', { otra: 'c', n: 1, nulo: null }], vacio: {} }
    assert.deepEqual(jsonStrings(value), ['a', 'b', 'c'])
    assert.deepEqual(jsonStrings('suelta'), ['suelta'])
    assert.deepEqual(jsonStrings(7), [])
    assert.deepEqual(jsonStrings(null), [])
  })
})
