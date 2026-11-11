import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { git, isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import {
  agentFailureIsRetryable,
  agentFailureIsUnrecoverable,
  agentWorkIsTrustworthy,
  classifyAgentFailure,
} from '../../../src/internal/scripts/lib/mefisto-agent-failures.mts'
import {
  ERROR_AS_TEXT,
  FIXTURE_FILES,
  INTERNAL_EVENTS,
  NEUTRAL_EVENTS,
  NO_BASH,
  NO_BASH_JQ,
  mefistoBash,
  writeFixtures,
} from './mefisto-agents-parity.mts'

let work = ''
let events: Record<string, string> = {}
let published: Record<string, string> = {}
let errorAsText = ''
let worktree = ''
let baseCommit = ''
let summary = ''
let restoreGitConfig = (): void => {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent failures '))
  events = writeFixtures(work, INTERNAL_EVENTS, '.jsonl')
  errorAsText = join(work, 'error-de-texto.unitario')
  writeFileSync(errorAsText, ERROR_AS_TEXT)
  published = writeFixtures(work, NEUTRAL_EVENTS, '.publicado.jsonl')
  restoreGitConfig = isolateGitConfig(work)
  worktree = join(work, 'worktree')
  mkdirSync(join(worktree, 'commands'), { recursive: true })
  git(worktree, 'init', '-q')
  git(worktree, 'config', 'user.email', 't@t.test')
  git(worktree, 'config', 'user.name', 'test')
  writeFileSync(join(worktree, 'commands', 'base.md'), 'base\n')
  // Como el `.gitignore` del repo: el resumen del stage no ensucia el status por si solo.
  writeFileSync(join(worktree, '.gitignore'), '.mefisto/\n')
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'base')
  baseCommit = git(worktree, 'rev-parse', 'HEAD')
  summary = join(worktree, '.mefisto', 'pipeline', 'summaries', 'stage-1-writer.md')
})

after(() => {
  restoreGitConfig()
  rmSync(work, { recursive: true, force: true })
})

const file = (name: string): string => events[name] ?? assert.fail(`sin fixture ${name}`)

type Summary = 'presente' | 'vacio' | 'ausente'

/** Deja el worktree en `baseCommit`, limpio, con el resumen pedido. */
function resetWorktree(summaryState: Summary): void {
  git(worktree, 'reset', '-q', '--hard', baseCommit)
  git(worktree, 'clean', '-qfdx')
  mkdirSync(join(worktree, '.mefisto', 'pipeline', 'summaries'), { recursive: true })
  if (summaryState !== 'ausente') writeFileSync(summary, summaryState === 'presente' ? 'resumen del writer\n' : '')
}

const dirty = (): void => writeFileSync(join(worktree, 'commands', 'base.md'), 'cambio\n')

describe('classifyAgentFailure', () => {
  test('[A-1][A-8] el timeout del watchdog gana a cualquier otro sintoma', () => {
    assert.equal(classifyAgentFailure(true, '1', '99', file('sin-terminal')), 'TIMEOUT (99s, exit 1)')
    assert.equal(classifyAgentFailure(true, 1, 99, file('proveedor')), 'TIMEOUT (99s, exit 1)')
    assert.equal(classifyAgentFailure(true, 137, 5, file('exito')), 'TIMEOUT (5s, exit 137)')
  })

  test('[A-2][A-3] una senal se distingue por si el terminal ya habia declarado exito', () => {
    assert.equal(classifyAgentFailure(false, '137', '12', file('exito')), 'SIGNAL_POST_SUCCESS (exit 137, 12s)')
    assert.equal(classifyAgentFailure(false, '137', '12', file('sin-terminal')), 'SIGNAL_MID_FLIGHT (exit 137, 12s)')
    assert.equal(classifyAgentFailure(false, 143, 3, file('exito')), 'SIGNAL_POST_SUCCESS (exit 143, 3s)')
    assert.equal(classifyAgentFailure(false, 143, 3, file('proveedor')), 'SIGNAL_MID_FLIGHT (exit 143, 3s)')
    assert.equal(classifyAgentFailure(false, 137, 3, join(work, 'no-existe.jsonl')), 'SIGNAL_MID_FLIGHT (exit 137, 3s)')
  })

  test('[A-4][A-5][A-6][A-9] traduce el error.kind del terminal', () => {
    assert.equal(classifyAgentFailure(false, '1', '12', file('proveedor')), 'PROVIDER_UNAVAILABLE (exit 1)')
    assert.equal(classifyAgentFailure(false, '1', '12', file('cliente')), 'API_ERROR_CLIENT (exit 1)')
    assert.equal(classifyAgentFailure(false, '1', '12', file('corte-de-stream')), 'STREAM_CUT (exit 1)')
    assert.equal(classifyAgentFailure(false, '1', '12', file('limite-con-reset')), 'RATE_LIMIT (exit 1)')
    assert.equal(classifyAgentFailure(false, 1, 12, file('kind-con-salto')), 'RATE_LIMIT (exit 1)')
  })

  test('[A-7] sin sintoma reconocible es CLI_ERROR', () => {
    assert.equal(classifyAgentFailure(false, '3', '12', file('fallo-ordinario')), 'CLI_ERROR (exit 3)')
    for (const name of ['tiempo-agotado', 'exito', 'sin-terminal', 'kind-objeto', 'vacio']) {
      assert.equal(classifyAgentFailure(false, 1, 12, file(name)), 'CLI_ERROR (exit 1)', name)
    }
    assert.equal(classifyAgentFailure(false, 1, 12, errorAsText), 'CLI_ERROR (exit 1)')
    assert.equal(classifyAgentFailure(false, 1, 12, ''), 'CLI_ERROR (exit 1)')
    assert.equal(classifyAgentFailure(false, 0, 12, file('exito')), 'CLI_ERROR (exit 0)')
  })
})

test('[B] agentFailureIsRetryable: solo PROVIDER_UNAVAILABLE se reintenta', () => {
  assert.equal(agentFailureIsRetryable('PROVIDER_UNAVAILABLE (exit 1)'), true)
  assert.equal(agentFailureIsRetryable('PROVIDER_UNAVAILABLE'), true)
  for (const label of [
    'TIMEOUT (1800s, exit 137)',
    'API_ERROR_CLIENT (exit 1)',
    'STREAM_CUT (exit 1)',
    'CLI_ERROR (exit 3)',
    'RATE_LIMIT (exit 1)',
    'SIGNAL_MID_FLIGHT (exit 137, 12s)',
    'SIGNAL_POST_SUCCESS (exit 137, 12s)',
    ' PROVIDER_UNAVAILABLE',
    '',
  ]) {
    assert.equal(agentFailureIsRetryable(label), false, label)
  }
})

describe('agentFailureIsUnrecoverable', () => {
  test('[D-1] el timeout del watchdog es irrecuperable aunque el exit sea 0', () => {
    assert.equal(agentFailureIsUnrecoverable(true, '0', file('fallo-ordinario')), true)
  })

  test('[D-2] una senal es irrecuperable sin mirar el terminal', () => {
    assert.equal(agentFailureIsUnrecoverable(false, '137', file('fallo-ordinario')), true)
    assert.equal(agentFailureIsUnrecoverable(false, 143, file('fallo-ordinario')), true)
  })

  test('[D-3] error.kind stream_cut es irrecuperable con un exit ordinario', () => {
    assert.equal(agentFailureIsUnrecoverable(false, '1', file('corte-de-stream')), true)
  })

  test('[D-4] un fallo ordinario sigue siendo recuperable', () => {
    assert.equal(agentFailureIsUnrecoverable(false, '1', file('fallo-ordinario')), false)
    for (const name of ['proveedor', 'limite-con-reset', 'cliente', 'tiempo-agotado', 'sin-terminal']) {
      assert.equal(agentFailureIsUnrecoverable(false, 1, file(name)), false, name)
    }
  })

  test('[G-6] un terminal de exito exime de irrecuperable a una senal y a un timeout', () => {
    assert.equal(agentFailureIsUnrecoverable(false, '137', file('exito')), false)
    assert.equal(agentFailureIsUnrecoverable(true, '0', file('exito')), false)
  })

  test('[G-7][G-8] sin terminal, una senal o un timeout siguen irrecuperables', () => {
    assert.equal(agentFailureIsUnrecoverable(false, '137', file('sin-terminal')), true)
    assert.equal(agentFailureIsUnrecoverable(true, '0', file('sin-terminal')), true)
    assert.equal(agentFailureIsUnrecoverable(false, 137, file('terminal-truncado')), true)
  })

  test('[G-9] sin archivo de eventos, una senal sigue irrecuperable', () => {
    assert.equal(agentFailureIsUnrecoverable(false, '137', ''), true)
    assert.equal(agentFailureIsUnrecoverable(false, '1', ''), false)
  })
})

describe('agentWorkIsTrustworthy', () => {
  test('[D-5] un fallo irrecuperable no se recupera aunque haya cambios y resumen', () => {
    resetWorktree('presente')
    dirty()
    assert.equal(agentWorkIsTrustworthy(worktree, baseCommit, true, summary), false)
  })

  test('[D-6][E-3] con cambios sin commitear y resumen no vacio se recupera', () => {
    resetWorktree('presente')
    dirty()
    assert.equal(agentWorkIsTrustworthy(worktree, baseCommit, false, summary), true)
  })

  test('[E-1] sin resumen no se recupera', () => {
    resetWorktree('ausente')
    dirty()
    assert.equal(agentWorkIsTrustworthy(worktree, baseCommit, false, summary), false)
  })

  test('[E-2] con el resumen vacio no se recupera', () => {
    resetWorktree('vacio')
    dirty()
    assert.equal(agentWorkIsTrustworthy(worktree, baseCommit, false, summary), false)
  })

  test('[E-4] un worktree limpio no se recupera aunque haya resumen', () => {
    resetWorktree('presente')
    assert.equal(agentWorkIsTrustworthy(worktree, baseCommit, false, summary), false)
    assert.equal(agentWorkIsTrustworthy(worktree, '', false, summary), false)
  })

  test('un commit posterior a la base cuenta como trabajo, con el arbol limpio', () => {
    resetWorktree('presente')
    dirty()
    git(worktree, 'commit', '-qam', 'trabajo')
    assert.equal(agentWorkIsTrustworthy(worktree, baseCommit, false, summary), true)
    // Sin base se compara HEAD consigo mismo.
    assert.equal(agentWorkIsTrustworthy(worktree, '', false, summary), false)
  })

  test('un archivo nuevo sin seguimiento cuenta como trabajo', () => {
    resetWorktree('presente')
    writeFileSync(join(worktree, 'commands', 'nuevo.md'), 'nuevo\n')
    assert.equal(agentWorkIsTrustworthy(worktree, baseCommit, false, summary), true)
  })

  test('un git diff que falla cuenta como cambios', () => {
    resetWorktree('presente')
    assert.equal(agentWorkIsTrustworthy(worktree, 'no-es-un-commit', false, summary), true)
    assert.equal(agentWorkIsTrustworthy(join(work, 'no-es-un-repo'), baseCommit, false, summary), true)
  })

  test('consulta git solo cuando hace falta', () => {
    const calls: string[][] = []
    const run =
      (diffStatus: number, status: string): Run =>
      (command, args) => {
        calls.push([command, ...args])
        return args.includes('diff') ? { status: diffStatus, stdout: '', stderr: '' } : { status: 0, stdout: status, stderr: '' }
      }
    resetWorktree('presente')
    assert.equal(agentWorkIsTrustworthy('wt', 'abc', true, summary, run(1, '')), false)
    assert.equal(agentWorkIsTrustworthy('wt', 'abc', false, join(work, 'sin-resumen.md'), run(1, '')), false)
    assert.deepEqual(calls, [])
    assert.equal(agentWorkIsTrustworthy('wt', 'abc', false, summary, run(1, '')), true)
    assert.deepEqual(calls, [['git', '-C', 'wt', 'diff', '--quiet', 'abc..HEAD']])
    calls.length = 0
    assert.equal(agentWorkIsTrustworthy('wt', '', false, summary, run(0, ' M commands/base.md\n')), true)
    assert.deepEqual(calls, [
      ['git', '-C', 'wt', 'diff', '--quiet', 'HEAD..HEAD'],
      ['git', '-C', 'wt', 'status', '--porcelain'],
    ])
    assert.equal(agentWorkIsTrustworthy('wt', '', false, summary, run(0, '')), false)
  })
})

describe('paridad con la gemela bash', { skip: NO_BASH }, () => {
  test('classify_agent_failure y agent_failure_is_unrecoverable sobre todos los fixtures', { skip: NO_BASH_JQ }, () => {
    const files = [...Object.values(events), ...Object.values(published), ...FIXTURE_FILES, join(work, 'no-existe.jsonl'), '']
    const script = `for f in "$@"; do
  classify_agent_failure false 1 12 "$f"
  if agent_failure_is_unrecoverable false 1 "$f"; then echo irrecuperable; else echo recuperable; fi
done`
    const own = files.flatMap((eventsFile) => [
      classifyAgentFailure(false, 1, 12, eventsFile),
      agentFailureIsUnrecoverable(false, 1, eventsFile) ? 'irrecuperable' : 'recuperable',
    ])
    assert.deepEqual([...own, ''], mefistoBash(script, files).stdout.split('\n'))
    for (const label of ['RATE_LIMIT', 'PROVIDER_UNAVAILABLE', 'API_ERROR_CLIENT', 'STREAM_CUT', 'CLI_ERROR']) {
      assert.ok(own.includes(`${label} (exit 1)`), label)
    }
    assert.ok(own.includes('irrecuperable') && own.includes('recuperable'))
  })

  test('classify_agent_failure y agent_failure_is_unrecoverable con timeout y senales', { skip: NO_BASH_JQ }, () => {
    const names = ['exito', 'sin-terminal', 'terminal-truncado', 'proveedor', 'corte-de-stream', 'limite-con-reset', 'cliente', 'fallo-ordinario', 'exito-y-despues-fallo']
    const combos = [...names.map(file), join(work, 'no-existe.jsonl'), ''].flatMap((eventsFile) =>
      [true, false].flatMap((timedOut) => ['0', '3', '137', '143'].map((exit): [boolean, string, string] => [timedOut, exit, eventsFile])),
    )
    const script = `while [ "$#" -gt 0 ]; do
  classify_agent_failure "$1" "$2" 12 "$3"
  if agent_failure_is_unrecoverable "$1" "$2" "$3"; then echo irrecuperable; else echo recuperable; fi
  shift 3
done`
    const args = combos.flatMap(([timedOut, exit, eventsFile]) => [String(timedOut), exit, eventsFile])
    const own = combos.flatMap(([timedOut, exit, eventsFile]) => [
      classifyAgentFailure(timedOut, exit, 12, eventsFile),
      agentFailureIsUnrecoverable(timedOut, exit, eventsFile) ? 'irrecuperable' : 'recuperable',
    ])
    assert.deepEqual([...own, ''], mefistoBash(script, args).stdout.split('\n'))
    for (const label of ['TIMEOUT (12s, exit 143)', 'SIGNAL_POST_SUCCESS (exit 137, 12s)', 'SIGNAL_MID_FLIGHT (exit 143, 12s)', 'CLI_ERROR (exit 3)']) {
      assert.ok(own.includes(label), label)
    }
  })

  test('agent_failure_is_retryable', () => {
    const labels = [
      'PROVIDER_UNAVAILABLE (exit 1)',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_UNAVAILABLES',
      'RATE_LIMIT (exit 1)',
      'TIMEOUT (1800s, exit 137)',
      'API_ERROR_CLIENT (exit 1)',
      'STREAM_CUT (exit 1)',
      'CLI_ERROR (exit 3)',
      'SIGNAL_MID_FLIGHT (exit 137, 12s)',
      'SIGNAL_POST_SUCCESS (exit 137, 12s)',
      ' PROVIDER_UNAVAILABLE',
      'provider_unavailable',
      '',
    ]
    const script = 'for label in "$@"; do if agent_failure_is_retryable "$label"; then printf 1; else printf 0; fi; done'
    assert.equal(labels.map((label) => (agentFailureIsRetryable(label) ? '1' : '0')).join(''), mefistoBash(script, labels).stdout)
  })

  test('agent_work_is_trustworthy sobre worktrees reales', () => {
    const scenarios: { name: string; summaryState: Summary; arrange: () => void; base?: string; path?: string }[] = [
      { name: 'cambios sin commitear y resumen', summaryState: 'presente', arrange: dirty },
      { name: 'cambios sin resumen', summaryState: 'ausente', arrange: dirty },
      { name: 'cambios con resumen vacio', summaryState: 'vacio', arrange: dirty },
      { name: 'arbol limpio con resumen', summaryState: 'presente', arrange: () => {} },
      { name: 'arbol limpio sin base', summaryState: 'presente', arrange: () => {}, base: '' },
      {
        name: 'commit posterior a la base',
        summaryState: 'presente',
        arrange: () => {
          dirty()
          git(worktree, 'commit', '-qam', 'trabajo')
        },
      },
      { name: 'archivo sin seguimiento', summaryState: 'presente', arrange: () => writeFileSync(join(worktree, 'nuevo.md'), 'n\n') },
      { name: 'cambio en el index', summaryState: 'presente', arrange: () => (dirty(), void git(worktree, 'add', '-A')) },
      { name: 'base que no existe', summaryState: 'presente', arrange: () => {}, base: 'no-es-un-commit' },
      { name: 'ruta que no es un repo', summaryState: 'presente', arrange: () => {}, path: join(work, 'no-es-un-repo') },
    ]
    const script = 'if agent_work_is_trustworthy "$@"; then printf si; else printf no; fi'
    for (const scenario of scenarios) {
      resetWorktree(scenario.summaryState)
      scenario.arrange()
      const path = scenario.path ?? worktree
      const base = scenario.base ?? baseCommit
      for (const unrecoverable of [false, true]) {
        const own = agentWorkIsTrustworthy(path, base, unrecoverable, summary) ? 'si' : 'no'
        const fromBash = mefistoBash(script, [path, base, String(unrecoverable), summary]).stdout
        assert.equal(own, fromBash, `${scenario.name} (irrecuperable=${unrecoverable})`)
      }
    }
  })
})
