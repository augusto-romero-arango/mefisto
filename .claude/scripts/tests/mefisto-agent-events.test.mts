import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  agentEventsErrorDetail,
  agentEventsErrorField,
  agentEventsErrorKind,
  agentEventsResetsAt,
  agentEventsSessionId,
  agentStreamCompletedSuccessfully,
  hasContent,
} from '../../../src/internal/scripts/lib/mefisto-agent-events.mts'
import { ERROR_AS_TEXT, INTERNAL_EVENTS, REPO_ROOT, writeFixtures } from './mefisto-agents-fixtures.mts'

let work = ''
let events: Record<string, string> = {}
let errorAsText = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent events '))
  events = writeFixtures(work, INTERNAL_EVENTS, '.jsonl')
  errorAsText = join(work, 'error-de-texto.unitario')
  writeFileSync(errorAsText, ERROR_AS_TEXT)
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const file = (name: string): string => events[name] ?? assert.fail(`sin fixture ${name}`)
const contract = (name: string): string => join(REPO_ROOT, 'src', 'runtime', 'contract', 'fixtures', 'run-events', `${name}.jsonl`)

describe('error.kind y error.detail del terminal', () => {
  test('[G-2] exponen el kind y el detalle del terminal fallido', () => {
    assert.equal(agentEventsErrorKind(file('error-del-proveedor-con-texto')), 'api_error')
    assert.equal(agentEventsErrorDetail(file('error-del-proveedor-con-texto')), 'API Error: 500 Overloaded')
  })

  test('[G-6] distinguen stream_cut de api_error', () => {
    assert.equal(agentEventsErrorKind(file('corte-de-stream')), 'stream_cut')
    assert.equal(agentEventsErrorKind(file('cliente')), 'api_error')
  })

  test('[G-8] dan vacio cuando el terminal no trae error o no hay terminal', () => {
    for (const name of ['exito', 'sin-terminal', 'terminal-truncado', 'error-false', 'error-vacio', 'vacio', 'solo-saltos']) {
      assert.equal(agentEventsErrorKind(file(name)), '', name)
      assert.equal(agentEventsErrorDetail(file(name)), '', name)
    }
  })

  test('[G-8b] dan vacio sin archivo, con ruta vacia o con un directorio', () => {
    for (const path of [join(work, 'no-existe.jsonl'), '', work]) {
      assert.equal(agentEventsErrorKind(path), '')
      assert.equal(agentEventsErrorDetail(path), '')
    }
  })

  test('el campo por defecto es kind y cualquier otro se lee de error', () => {
    assert.equal(agentEventsErrorField(file('cliente')), 'api_error')
    assert.equal(agentEventsErrorField(file('cliente'), ''), 'api_error')
    assert.equal(agentEventsErrorField(file('reset-solo-en-error'), 'resets_at'), '2031-01-01T00:00:00Z')
    assert.equal(agentEventsErrorField(file('cliente'), 'no-existe'), '')
    assert.equal(agentEventsErrorField(file('cliente'), 'resets_at'), '')
    assert.equal(agentEventsErrorField(file('reset-solo-en-error')), 'rate_limit')
    assert.equal(agentEventsErrorField(file('kind-objeto'), 'resets_at'), '')
    for (const name of ['exito', 'vacio']) {
      assert.equal(agentEventsErrorField(file(name)), '', name)
      assert.equal(agentEventsErrorField(file(name), 'resets_at'), '', name)
    }
  })

  test('un error que no es objeto no aporta nada', () => {
    assert.equal(agentEventsErrorKind(errorAsText), '')
    assert.equal(agentEventsErrorDetail(errorAsText), '')
  })

  test('un valor que no es texto sale como lo imprime jq, sin saltos finales', () => {
    assert.equal(agentEventsErrorKind(file('kind-objeto')), '{\n  "codigo": 7,\n  "partes": [\n    "a",\n    "b"\n  ]\n}')
    assert.equal(agentEventsErrorDetail(file('kind-objeto')), '[\n  "x"\n]')
    assert.equal(agentEventsErrorKind(file('kind-con-salto')), 'rate_limit')
    assert.equal(agentEventsErrorDetail(file('kind-con-salto')), 'dos\nlineas')
    // Una sustitucion de comando descarta los bytes nulos.
    assert.equal(agentEventsErrorKind(file('kind-con-nulo')), 'ratelimit')
    assert.equal(agentEventsSessionId(file('kind-con-nulo')), 's')
  })

  test('solo cuenta el ultimo terminal', () => {
    assert.equal(agentEventsErrorKind(file('dos-terminales')), 'api_error')
    assert.equal(agentEventsErrorKind(file('fallo-y-despues-exito')), '')
    assert.equal(agentEventsErrorKind(file('exito-y-despues-fallo')), 'stream_cut')
  })

  test('una linea que no es un objeto JSON se descarta sin perder las demas', () => {
    assert.equal(agentEventsErrorKind(file('ultima-linea-truncada')), 'rate_limit')
    assert.equal(agentEventsErrorKind(file('linea-que-no-es-json')), 'rate_limit')
    assert.equal(agentEventsErrorKind(file('valor-que-no-es-objeto')), 'rate_limit')
    assert.equal(agentEventsErrorKind(file('fin-de-linea-windows')), 'timeout')
    // Un valor repartido en varias lineas no es una linea de JSONL.
    assert.equal(agentEventsErrorKind(file('varias-lineas-por-valor')), '')
  })
})

describe('resets_at del terminal', () => {
  test('[B-1] poblado se lee tal cual', () => {
    assert.equal(agentEventsResetsAt(file('limite-con-reset')), '2026-05-07T22:40:00Z')
  })

  test('[B-2][B-3] null o ausente dan cadena vacia', () => {
    assert.equal(agentEventsResetsAt(file('limite-sin-reset')), '')
    assert.equal(agentEventsResetsAt(file('proveedor')), '')
    assert.equal(agentEventsResetsAt(file('error-false')), '')
  })

  test('[B-4][B-5] fixtures canonicos del contrato', () => {
    assert.equal(agentEventsResetsAt(contract('valid-rate-limit-claude')), '2026-05-07T22:40:00Z')
    assert.equal(agentEventsResetsAt(contract('valid-rate-limit-sin-reset')), '')
  })

  test('lee la raiz del ultimo terminal, nunca error.resets_at', () => {
    assert.equal(agentEventsResetsAt(file('reset-solo-en-error')), '')
    assert.equal(agentEventsResetsAt(file('reset-en-error-y-raiz')), '2032-01-01T00:00:00Z')
    assert.equal(agentEventsResetsAt(file('dos-terminales')), '')
    assert.equal(agentEventsResetsAt(file('kind-objeto')), 'true')
  })
})

describe('session_id del terminal', () => {
  test('[A-1] poblado se lee tal cual', () => {
    assert.equal(agentEventsSessionId(file('limite-con-reset')), 'sess-abc')
  })

  test('[A-2] null da cadena vacia', () => {
    assert.equal(agentEventsSessionId(file('limite-sin-reset')), '')
    assert.equal(agentEventsSessionId(file('error-false')), '')
  })

  test('[A-3] un archivo inexistente da cadena vacia', () => {
    assert.equal(agentEventsSessionId(join(work, 'no-existe.jsonl')), '')
    assert.equal(agentEventsSessionId(''), '')
  })

  test('no hereda el de un terminal anterior', () => {
    assert.equal(agentEventsSessionId(file('dos-terminales')), '')
    assert.equal(agentEventsSessionId(file('kind-objeto')), '42')
    assert.equal(agentEventsSessionId(file('sin-salto-final')), 's')
  })
})

describe('agentStreamCompletedSuccessfully', () => {
  test('[G-1] un terminal run.completed con status success declara exito', () => {
    assert.equal(agentStreamCompletedSuccessfully(file('exito')), true)
    assert.equal(agentStreamCompletedSuccessfully(file('fallo-y-despues-exito')), true)
  })

  test('[G-2][G-3] sin terminal o con run.failed no se afirma exito', () => {
    assert.equal(agentStreamCompletedSuccessfully(file('sin-terminal')), false)
    assert.equal(agentStreamCompletedSuccessfully(file('fallo-ordinario')), false)
    assert.equal(agentStreamCompletedSuccessfully(file('exito-y-despues-fallo')), false)
  })

  test('[G-4] un terminal truncado a media linea no afirma exito', () => {
    assert.equal(agentStreamCompletedSuccessfully(file('terminal-truncado')), false)
  })

  test('[G-5] sin archivo no se afirma exito', () => {
    assert.equal(agentStreamCompletedSuccessfully(join(work, 'no-existe.jsonl')), false)
    assert.equal(agentStreamCompletedSuccessfully(''), false)
    assert.equal(agentStreamCompletedSuccessfully(file('vacio')), false)
  })

  test('el tipo y el status tienen que coincidir los dos', () => {
    assert.equal(agentStreamCompletedSuccessfully(file('exito-con-status-fallido')), false)
    assert.equal(agentStreamCompletedSuccessfully(file('fallido-con-status-exito')), false)
  })
})

test('hasContent: solo un archivo que existe y no esta vacio', () => {
  assert.equal(hasContent(file('exito')), true)
  assert.equal(hasContent(file('vacio')), false)
  assert.equal(hasContent(join(work, 'no-existe.jsonl')), false)
  assert.equal(hasContent(''), false)
})

test('lectores del terminal sobre los fixtures del contrato', () => {
  const expected: Record<string, [string, string, string, string, boolean]> = {
    'invalid-missing-cost-name': ['', '', '', '', true],
    'invalid-missing-field': ['', '', '', '', true],
    'invalid-status-mismatch': ['timeout', 'un terminal exitoso no puede declararse timeout', '', '', false],
    'invalid-two-terminals': ['nonzero_exit', 'segundo terminal, no deberia existir', '', '', false],
    'invalid-unknown-type': ['', '', '', '', false],
    'legacy-cost-usd': ['', '', '', '', true],
    'valid-failed': ['api_error', 'API Error: 529 overloaded', '', '', false],
    'valid-rate-limit-claude': [
      'rate_limit',
      'ventana de uso agotada (rateLimitType=five_hour, resetsAt=2026-05-07T22:40:00Z)',
      '2026-05-07T22:40:00Z',
      'sess-ratelimit',
      false,
    ],
    'valid-success': ['', '', '', '', true],
    'valid-timeout': ['timeout', 'el watchdog mato el proceso tras superar 1800s', '', '', false],
  }
  for (const [name, values] of Object.entries(expected)) {
    const path = contract(name)
    assert.deepEqual(
      [agentEventsErrorKind(path), agentEventsErrorDetail(path), agentEventsResetsAt(path), agentEventsSessionId(path), agentStreamCompletedSuccessfully(path)],
      values,
      name,
    )
  }
})
