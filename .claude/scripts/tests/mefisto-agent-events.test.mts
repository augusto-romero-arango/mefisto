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
import {
  ERROR_AS_TEXT,
  FIXTURE_FILES,
  INTERNAL_EVENTS,
  NEUTRAL_EVENTS,
  NO_BASH_JQ,
  RECORD,
  REPO_ROOT,
  mefistoBash,
  writeFixtures,
} from './mefisto-agents-parity.mts'

let work = ''
let events: Record<string, string> = {}
let published: Record<string, string> = {}
let errorAsText = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent events '))
  events = writeFixtures(work, INTERNAL_EVENTS, '.jsonl')
  errorAsText = join(work, 'error-de-texto.unitario')
  writeFileSync(errorAsText, ERROR_AS_TEXT)
  published = writeFixtures(work, NEUTRAL_EVENTS, '.publicado.jsonl')
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
    assert.equal(agentEventsErrorKind(published['ultima-linea-truncada'] ?? ''), 'rate_limit')
    assert.equal(agentEventsErrorKind(published['linea-que-no-es-json'] ?? ''), 'rate_limit')
    assert.equal(agentEventsErrorKind(published['valor-que-no-es-objeto'] ?? ''), 'rate_limit')
    assert.equal(agentEventsErrorKind(file('fin-de-linea-windows')), 'timeout')
    // Un valor repartido en varias lineas no es una linea de JSONL.
    assert.equal(agentEventsErrorKind(published['varias-lineas-por-valor'] ?? ''), '')
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

describe('paridad con la gemela bash', { skip: NO_BASH_JQ }, () => {
  test('lectores del terminal sobre todos los fixtures', () => {
    const files = [...Object.values(events), ...Object.values(published), ...FIXTURE_FILES, join(work, 'no-existe.jsonl'), work, '']
    const script = `for f in "$@"; do
  agent_events_error_kind "$f"; printf '\\036'
  agent_events_error_detail "$f"; printf '\\036'
  agent_events_resets_at "$f"; printf '\\036'
  agent_events_session_id "$f"; printf '\\036'
  if agent_stream_completed_successfully "$f"; then echo si; else echo no; fi; printf '\\036'
done`
    const fromBash = mefistoBash(script, files).stdout.split(RECORD)
    const own = files.flatMap((eventsFile) => [
      agentEventsErrorKind(eventsFile),
      agentEventsErrorDetail(eventsFile),
      agentEventsResetsAt(eventsFile),
      agentEventsSessionId(eventsFile),
      agentStreamCompletedSuccessfully(eventsFile) ? 'si' : 'no',
    ])
    assert.deepEqual([...own.map((value) => `${value}\n`), ''], fromBash)
    assert.ok(own.includes('si') && own.includes('rate_limit') && own.includes('2026-05-07T22:40:00Z'))
  })

  test('agent_events_error_field con el campo por defecto y con otro campo', () => {
    const files = ['cliente', 'reset-solo-en-error', 'kind-objeto', 'exito', 'vacio'].map(file)
    const script = `for f in "$@"; do for field in "" resets_at; do agent_events_error_field "$f" "$field"; printf '\\036'; done; agent_events_error_field "$f"; printf '\\036'; done`
    const own = files.flatMap((eventsFile) => [
      agentEventsErrorField(eventsFile, ''),
      agentEventsErrorField(eventsFile, 'resets_at'),
      agentEventsErrorField(eventsFile),
    ])
    assert.deepEqual([...own.map((value) => `${value}\n`), ''], mefistoBash(script, files).stdout.split(RECORD))
  })
})
