import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { agentFailureIsHoldable, classifyAgentFailure, classifyNeutralAgentFailure } from '../lib/pipeline/agent-failures.mts'
import { NEUTRAL_EVENTS, NEUTRAL_EVENT_FILES, REPO_ROOT, writeFixtures } from './pipeline-agents-fixtures.mts'

const LOGS: Readonly<Record<string, string>> = {
  vacio: '',
  generico: 'algo no reconocido fallo\n',
  'sin-429-en-texto': 'algo salio mal\n',
  '5xx': 'API Error: 529 Overloaded\n',
  '4xx': 'API Error: 401 Unauthorized\n',
  '429-con-limite': 'Error: 429 Too Many Requests -- rate limit exceeded, try again later\n',
  '429-solo': 'HTTP 429 -- pero de otro subsistema, sin relacion\n',
  '429-y-limite-en-otra-linea': 'status 429\nYour Usage-Limit was reached\n',
  '429-ratelimit-pegado': 'x-ratelimit-remaining: 0 (429)\n',
  '429-limite-con-dos-espacios': '429: rate  limit\n',
  '429-limite-partido-en-dos-lineas': '429: rate\nlimit\n',
  '429-limite-con-retorno': '429: usage\rlimit\n',
  '429-del-api': 'API Error: 429 rate_limit_error\n',
  '4xx-y-5xx': 'API Error: 400 Bad Request\nAPI Error: 500 Internal\n',
  'limite-sin-429': 'rate limit exceeded\nAPI Error: 400\n',
  'sin-salto-final': 'API Error: 503',
}

const STREAMS: Readonly<Record<string, string>> = {
  rechazado: [
    '{"type":"system","subtype":"init","session_id":"abc"}',
    '{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","status":"allowed"}}',
    '{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","status":"rejected"}}',
    '{"type":"result","is_error":true,"subtype":"success"}',
    '',
  ].join('\n'),
  'solo-allowed': '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}\n{"type":"result","is_error":true,"subtype":"success"}\n',
  'sin-status': '{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour"}}\n',
  'status-nulo': '{"type":"rate_limit_event","rate_limit_info":{"status":null}}\n{"type":"rate_limit_event"}\n',
  'status-numero': '{"type":"rate_limit_event","rate_limit_info":{"status":0}}\n',
  'aviso-de-limite': '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}\n',
  'info-que-no-es-objeto': '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n{"type":"rate_limit_event","rate_limit_info":"rejected"}\n',
  'rechazado-entre-basura': 'no soy json\n[1,2]\n{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n{"type":"resu',
  'rechazado-con-fin-de-linea-windows': '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\r\n',
  'otro-tipo': '{"type":"rate_limit","rate_limit_info":{"status":"rejected"}}\n',
  vacio: '',
}

let work = ''
let events: Record<string, string> = {}
let logs: Record<string, string> = {}
let streams: Record<string, string> = {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent failures '))
  events = writeFixtures(work, NEUTRAL_EVENTS, '.jsonl')
  logs = writeFixtures(work, LOGS, '.log')
  streams = writeFixtures(work, STREAMS, '.stream.jsonl')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const event = (name: string): string => events[name] ?? assert.fail(`sin fixture ${name}`)
const log = (name: string): string => logs[name] ?? assert.fail(`sin log ${name}`)
const stream = (name: string): string => streams[name] ?? assert.fail(`sin stream ${name}`)

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

describe('classifyAgentFailure', () => {
  test('[1] una senal es TIMEOUT sin mirar el log', () => {
    assert.equal(classifyAgentFailure('137', '1800', log('vacio'), ''), 'TIMEOUT (signal 137, 1800s)')
    assert.equal(classifyAgentFailure(143, 42, log('429-con-limite'), stream('rechazado')), 'TIMEOUT (signal 143, 42s)')
  })

  test('[2] el evento rate_limit_event rechazado del stream es RATE_LIMIT aunque el log no diga 429', () => {
    assert.equal(classifyAgentFailure(1, 5, log('sin-429-en-texto'), stream('rechazado')), 'RATE_LIMIT (exit 1)')
    assert.equal(classifyAgentFailure(1, 5, log('5xx'), stream('aviso-de-limite')), 'RATE_LIMIT (exit 1)')
    assert.equal(classifyAgentFailure(1, 5, log('5xx'), stream('rechazado-entre-basura')), 'RATE_LIMIT (exit 1)')
  })

  test('[2b] un rate_limit_event solo allowed no dispara RATE_LIMIT', () => {
    assert.equal(classifyAgentFailure(1, 5, log('5xx'), stream('solo-allowed')), 'PROVIDER_UNAVAILABLE (exit 1)')
    for (const name of ['sin-status', 'status-nulo', 'otro-tipo', 'vacio', 'info-que-no-es-objeto']) {
      assert.equal(classifyAgentFailure(1, 5, log('5xx'), stream(name)), 'PROVIDER_UNAVAILABLE (exit 1)', name)
    }
    assert.equal(classifyAgentFailure(1, 5, log('5xx'), join(work, 'no-existe.stream.jsonl')), 'PROVIDER_UNAVAILABLE (exit 1)')
  })

  test('[3] sin stream, un 429 junto a un indicio de limite es RATE_LIMIT', () => {
    assert.equal(classifyAgentFailure(1, 3, log('429-con-limite'), ''), 'RATE_LIMIT (exit 1)')
    assert.equal(classifyAgentFailure(1, 3, log('429-y-limite-en-otra-linea')), 'RATE_LIMIT (exit 1)')
    assert.equal(classifyAgentFailure(1, 3, log('429-ratelimit-pegado')), 'RATE_LIMIT (exit 1)')
    assert.equal(classifyAgentFailure(2, 3, log('429-del-api')), 'RATE_LIMIT (exit 2)')
  })

  test('[3b] un 429 sin indicio de limite, o el indicio sin 429, no es RATE_LIMIT', () => {
    assert.equal(classifyAgentFailure(1, 3, log('429-solo'), ''), 'CLI_ERROR (exit 1)')
    assert.equal(classifyAgentFailure(1, 3, log('429-limite-con-dos-espacios')), 'CLI_ERROR (exit 1)')
    assert.equal(classifyAgentFailure(1, 3, log('429-limite-partido-en-dos-lineas')), 'CLI_ERROR (exit 1)')
    assert.equal(classifyAgentFailure(1, 3, log('limite-sin-429')), 'API_ERROR_CLIENT (exit 1)')
  })

  test('[4] API Error: 5 es PROVIDER_UNAVAILABLE', () => {
    assert.equal(classifyAgentFailure(1, 10, log('5xx'), ''), 'PROVIDER_UNAVAILABLE (exit 1)')
    assert.equal(classifyAgentFailure(1, 10, log('4xx-y-5xx')), 'PROVIDER_UNAVAILABLE (exit 1)')
    assert.equal(classifyAgentFailure(1, 10, log('sin-salto-final')), 'PROVIDER_UNAVAILABLE (exit 1)')
  })

  test('[5] API Error: 4 es API_ERROR_CLIENT', () => {
    assert.equal(classifyAgentFailure(1, 2, log('4xx'), ''), 'API_ERROR_CLIENT (exit 1)')
  })

  test('[6] una causa no identificada es CLI_ERROR', () => {
    assert.equal(classifyAgentFailure(1, 7, log('generico'), ''), 'CLI_ERROR (exit 1)')
    assert.equal(classifyAgentFailure(1, 7, log('vacio')), 'CLI_ERROR (exit 1)')
    assert.equal(classifyAgentFailure(3, 7, join(work, 'no-existe.log')), 'CLI_ERROR (exit 3)')
    assert.equal(classifyAgentFailure(1, 7, work), 'CLI_ERROR (exit 1)')
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

  test('classifyAgentFailure solo ve RATE_LIMIT en el stream crudo con un evento rechazado', () => {
    const raw = join(REPO_ROOT, '.claude', 'scripts', 'tests', 'fixtures', 'runtime-claude')
    const names = ['api-error-404', 'api-error-529', 'killed-no-result', 'result-max-turns', 'sensitive-redaction', 'stream-truncated', 'success-minimal', 'success']
    for (const name of names) {
      assert.equal(classifyAgentFailure(1, 12, log('generico'), join(raw, `${name}.jsonl`)), 'CLI_ERROR (exit 1)', name)
      assert.equal(classifyAgentFailure(1, 12, log('5xx'), join(raw, `${name}.jsonl`)), 'PROVIDER_UNAVAILABLE (exit 1)', name)
    }
    assert.equal(classifyAgentFailure(1, 12, log('generico'), join(raw, 'rate-limit-exhausted.jsonl')), 'RATE_LIMIT (exit 1)')
    assert.equal(classifyAgentFailure(137, 12, log('generico'), join(raw, 'rate-limit-exhausted.jsonl')), 'TIMEOUT (signal 137, 12s)')
  })
})
