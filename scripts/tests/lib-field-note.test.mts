import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CliError } from '../lib/cli.mts'
import {
  exitCodeOf,
  isMerged,
  parseFlags,
  parsePrList,
  prField,
  requireCommands,
  trimTrailingNewlines,
  validateSlug,
  validateTimestamp,
  worktreePathOf,
} from '../lib/field-note.mts'
import type { Tools } from '../lib/field-note.mts'

function silentTools(has: (command: string) => boolean = () => true): Tools & { stderr: string } {
  const tools = {
    stderr: '',
    run: () => ({ status: 0, stdout: '', stderr: '' }),
    has,
    out: () => {},
    err: (text: string) => {
      tools.stderr += text
    },
  }
  return tools
}

function cliError(body: () => unknown): CliError {
  try {
    body()
  } catch (error) {
    if (error instanceof CliError) return error
    throw error
  }
  throw new Error('se esperaba un CliError')
}

describe('parseFlags', () => {
  const FLAGS = ['--a', '--b']

  test('lee los pares flag-valor, y el ultimo valor de un flag repetido gana', () => {
    const flags = parseFlags(['--a', '1', '--b', '--a', '--a', '2'], FLAGS, 'uso')
    assert.equal(flags.get('--a'), '2')
    assert.equal(flags.get('--b'), '--a')
  })

  test('un flag sin valor o desconocido falla con el uso a continuacion', () => {
    const missing = cliError(() => parseFlags(['--a'], FLAGS, 'uso'))
    assert.equal(missing.message, 'ERROR: --a requiere un valor\nuso')
    assert.equal(missing.exitCode, 1)
    const unknown = cliError(() => parseFlags(['--a', '1', 'suelto'], FLAGS, 'uso'))
    assert.equal(unknown.message, "ERROR: argumento desconocido 'suelto'\nuso")
  })

  test('-h y --help entregan el uso con codigo 0', () => {
    for (const help of ['-h', '--help']) {
      const error = cliError(() => parseFlags(['--a', '1', help, '--nada'], FLAGS, 'uso'))
      assert.equal(error.message, 'uso')
      assert.equal(error.exitCode, 0)
    }
  })
})

describe('validaciones de forma', () => {
  test('validateSlug acepta letras, digitos, guion y guion bajo', () => {
    validateSlug('2026-09-13-1530-07-abc_DEF', '--session-id', 120)
  })

  test('validateSlug rechaza lo que escaparia de la ruta o se leeria como flag', () => {
    assert.match(cliError(() => validateSlug('-x', '--agent', 60)).message, /'-x' no puede empezar con '-'/)
    for (const value of ['../evil', 'a/b', 'con espacio', 'a.b', 'a;b', 'ñ']) {
      assert.match(
        cliError(() => validateSlug(value, '--agent', 60)).message,
        /es invalido: solo se permiten letras, digitos, '-' y '_'/,
      )
    }
    assert.equal(
      cliError(() => validateSlug('abcd', '--agent', 3)).message,
      "ERROR: --agent 'abcd' supera 3 caracteres",
    )
  })

  test('validateTimestamp exige YYYY-MM-DD-HHMM exacto', () => {
    validateTimestamp('2026-09-13-1530')
    for (const value of ['13-09-2026', '2026-09-13', '2026-09-13-15300', ' 2026-09-13-1530', '2026-09-13-1530\n']) {
      assert.match(cliError(() => validateTimestamp(value)).message, /se espera el formato YYYY-MM-DD-HHMM/)
    }
  })

  test('requireCommands nombra el primer programa ausente', () => {
    requireCommands(silentTools(), ['git', 'gh'])
    const error = cliError(() => requireCommands(silentTools((command) => command !== 'gh'), ['git', 'gh']))
    assert.equal(error.message, "ERROR: 'gh' no esta disponible en PATH")
  })

  test('trimTrailingNewlines quita solo los saltos finales', () => {
    assert.equal(trimTrailingNewlines(Buffer.from('a\n\nb\n\n\n')).toString(), 'a\n\nb')
    assert.equal(trimTrailingNewlines(Buffer.from('a\r\n')).toString(), 'a\r')
    assert.equal(trimTrailingNewlines(Buffer.from('\n\n')).length, 0)
  })
})

describe('exitCodeOf', () => {
  test('traduce un CliError a su mensaje y su codigo, y deja pasar cualquier otro error', () => {
    const tools = silentTools()
    assert.equal(exitCodeOf(tools, () => 0), 0)
    assert.equal(
      exitCodeOf(tools, () => {
        throw new CliError('ERROR: mal', 3)
      }),
      3,
    )
    assert.equal(tools.stderr, 'ERROR: mal\n')
    assert.throws(
      () =>
        exitCodeOf(tools, () => {
          throw new TypeError('defecto')
        }),
      TypeError,
    )
  })
})

describe('PRs de gh', () => {
  test('una lista vacia o una salida que no es una lista no trae ningun PR', () => {
    assert.deepEqual(parsePrList('[]'), [])
    assert.deepEqual(parsePrList(''), [])
    assert.deepEqual(parsePrList('no es json'), [])
    assert.deepEqual(parsePrList('{"number":1}'), [])
  })

  test('prField devuelve "null" para lo ausente y el texto para lo demas', () => {
    const [pr] = parsePrList('[{"number":7,"url":"https://x/pull/7","state":"OPEN","mergedAt":null}]')
    assert.ok(pr !== undefined)
    assert.equal(prField(pr, 'number'), '7')
    assert.equal(prField(pr, 'url'), 'https://x/pull/7')
    assert.equal(prField(pr, 'mergedAt'), 'null')
    assert.equal(prField(pr, 'createdAt'), 'null')
  })

  test('isMerged se guia por el estado o por la fecha de merge', () => {
    assert.equal(isMerged({ state: 'MERGED', mergedAt: null }), true)
    assert.equal(isMerged({ state: 'CLOSED', mergedAt: '2026-09-13T19:30:00Z' }), true)
    assert.equal(isMerged({ state: 'CLOSED', mergedAt: null }), false)
    assert.equal(isMerged({ state: 'OPEN' }), false)
  })
})

describe('worktreePathOf', () => {
  const PORCELAIN = [
    'worktree /repo/principal',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /tmp/con espacio/field-note-x.AbC123',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/docs/planner-field-notes-x',
    '',
    'worktree /tmp/suelto',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
  ].join('\n')

  test('devuelve la ruta completa del worktree de la rama, con sus espacios', () => {
    assert.equal(worktreePathOf(PORCELAIN, 'docs/planner-field-notes-x'), '/tmp/con espacio/field-note-x.AbC123')
    assert.equal(worktreePathOf(PORCELAIN, 'main'), '/repo/principal')
  })

  test('una rama sin worktree, o que solo es prefijo de otra, no coincide', () => {
    assert.equal(worktreePathOf(PORCELAIN, 'docs/planner-field-notes'), '')
    assert.equal(worktreePathOf(PORCELAIN, 'otra'), '')
    assert.equal(worktreePathOf('', 'main'), '')
  })
})
