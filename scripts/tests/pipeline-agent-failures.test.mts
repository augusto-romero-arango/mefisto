import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { agentFailureIsHoldable, classifyNeutralAgentFailure } from '../lib/pipeline/agent-failures.mts'
import { NEUTRAL_EVENTS, NEUTRAL_EVENT_FILES, REPO_ROOT, writeFixtures } from './pipeline-agents-fixtures.mts'

let work = ''
let events: Record<string, string> = {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent failures '))
  events = writeFixtures(work, NEUTRAL_EVENTS, '.jsonl')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const event = (name: string): string => events[name] ?? assert.fail(`sin fixture ${name}`)

describe('classifyNeutralAgentFailure', () => {
  test('el codigo del runner gana al terminal', () => {
    assert.equal(classifyNeutralAgentFailure(124, event('limite-con-reset')), 'TIMEOUT')
    assert.equal(classifyNeutralAgentFailure('124', join(work, 'no-existe.jsonl')), 'TIMEOUT')
    assert.equal(classifyNeutralAgentFailure(65, event('limite-con-reset')), 'PROTOCOL_INVALID')
  })

  test('[contrato] traduce el error.kind del terminal', () => {
    const expected: Record<string, string> = {
      'tooling-fallido': 'RATE_LIMIT',
      '5xx': 'PROVIDER_UNAVAILABLE',
      'limite-con-reset': 'RATE_LIMIT',
      '4xx': 'API_ERROR_CLIENT',
      corte: 'STREAM_CUT',
      'salida-no-cero': 'CLI_ERROR',
      'sin-resultado': 'CLI_ERROR',
      'tiempo-agotado': 'TIMEOUT',
      matado: 'KILLED',
      'protocolo-invalido': 'PROTOCOL_INVALID',
      'kind-desconocido': 'CLI_ERROR',
      'kind-con-salto': 'RATE_LIMIT',
      'dos-terminales': 'API_ERROR_CLIENT',
    }
    for (const [name, label] of Object.entries(expected)) assert.equal(classifyNeutralAgentFailure(1, event(name)), label, name)
  })

  test('sin terminal, sin error o con un JSONL ilegible es CLI_ERROR', () => {
    for (const name of ['exito', 'sin-terminal', 'sin-error', 'ultima-linea-truncada', 'valor-que-no-es-objeto', 'vacio']) {
      assert.equal(classifyNeutralAgentFailure(1, event(name)), 'CLI_ERROR', name)
    }
    assert.equal(classifyNeutralAgentFailure(1, join(work, 'no-existe.jsonl')), 'CLI_ERROR')
    assert.equal(classifyNeutralAgentFailure(137, event('exito')), 'CLI_ERROR')
  })
})

test('[7] agentFailureIsHoldable: solo RATE_LIMIT y PROVIDER_UNAVAILABLE ameritan esperar', () => {
  assert.equal(agentFailureIsHoldable('RATE_LIMIT (exit 1)'), true)
  assert.equal(agentFailureIsHoldable('PROVIDER_UNAVAILABLE (exit 1)'), true)
  assert.equal(agentFailureIsHoldable('RATE_LIMIT'), true)
  assert.equal(agentFailureIsHoldable('PROVIDER_UNAVAILABLE'), true)
  assert.equal(agentFailureIsHoldable('API_ERROR_CLIENT (exit 1)'), false)
  assert.equal(agentFailureIsHoldable('CLI_ERROR (exit 1)'), false)
  assert.equal(agentFailureIsHoldable('TIMEOUT (signal 137, 5s)'), false)
  assert.equal(agentFailureIsHoldable(' RATE_LIMIT'), false)
  assert.equal(agentFailureIsHoldable(''), false)
  for (const label of ['TIMEOUT', 'KILLED', 'STREAM_CUT', 'PROTOCOL_INVALID', 'rate_limit']) {
    assert.equal(agentFailureIsHoldable(label), false, label)
  }
  // Compara el prefijo, como el `case` del que se porto.
  assert.equal(agentFailureIsHoldable('RATE_LIMITADO'), true)
})

describe('fixtures del repo', () => {
  test('classifyNeutralAgentFailure lee el error.kind de los fixtures de eventos', () => {
    const expected: Record<string, string> = {
      'invalid-status-mismatch': 'TIMEOUT',
      'valid-failed': 'API_ERROR_CLIENT',
      'valid-rate-limit-claude': 'RATE_LIMIT',
      'valid-rate-limit-sin-reset': 'RATE_LIMIT',
      'valid-timeout': 'TIMEOUT',
      'neutral-failed.events': 'API_ERROR_CLIENT',
      'hold.events': 'RATE_LIMIT',
    }
    for (const relative of NEUTRAL_EVENT_FILES) {
      const name = relative.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? ''
      assert.equal(classifyNeutralAgentFailure(1, join(REPO_ROOT, relative)), expected[name] ?? 'CLI_ERROR', name)
      assert.equal(classifyNeutralAgentFailure(124, join(REPO_ROOT, relative)), 'TIMEOUT', name)
    }
  })

})
