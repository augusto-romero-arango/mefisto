import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { get } from '../lib/jq-values.mts'
import {
  agentEventsCompletedSuccessfully,
  agentEventsDenials,
  agentEventsKind,
  agentEventsResetsAt,
  agentEventsSessionId,
  agentEventsValue,
  jsonLineObjects,
  readText,
} from '../lib/pipeline/agent-events.mts'
import {
  NEUTRAL_EVENTS,
  NEUTRAL_EVENT_FILES,
  NO_BASH_JQ,
  REPO_ROOT,
  bashLibrary,
  chomp,
  writeFixtures,
} from './pipeline-agents-parity.mts'

let work = ''
let events: Record<string, string> = {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent events '))
  events = writeFixtures(work, NEUTRAL_EVENTS, '.jsonl')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const file = (name: string): string => events[name] ?? assert.fail(`sin fixture ${name}`)
const contract = (name: string): string => join(REPO_ROOT, 'src', 'runtime', 'contract', 'fixtures', 'run-events', `${name}.jsonl`)

function inline(name: string, content: string): string {
  const path = join(work, `${name}.jsonl`)
  writeFileSync(path, content)
  return path
}

interface Reading {
  kind: string
  resetsAt: string
  sessionId: string
  denials: string
  completed: boolean
}

function read(eventsFile: string): Reading {
  return {
    kind: agentEventsKind(eventsFile),
    resetsAt: agentEventsResetsAt(eventsFile),
    sessionId: agentEventsSessionId(eventsFile),
    denials: agentEventsDenials(eventsFile),
    completed: agentEventsCompletedSuccessfully(eventsFile),
  }
}

const NOTHING: Reading = { kind: '', resetsAt: '', sessionId: '', denials: '', completed: false }

describe('lectura del terminal neutral', () => {
  test('[contrato] lee session_id, denials, resets_at y error.kind del terminal fallido', () => {
    assert.deepEqual(read(file('tooling-fallido')), {
      kind: 'rate_limit',
      resetsAt: '2030-01-01T00:00:00Z',
      sessionId: 's 1',
      denials: '2',
      completed: false,
    })
  })

  test('[contrato] acepta run.completed con status success', () => {
    assert.deepEqual(read(file('tooling-exito')), { ...NOTHING, denials: '0', completed: true })
    assert.equal(agentEventsCompletedSuccessfully(file('exito-con-status-fallido')), false)
    assert.equal(agentEventsCompletedSuccessfully(file('fallido-con-status-exito')), false)
  })

  test('[B] resets_at sale de la raiz del terminal; null o ausente es cadena vacia', () => {
    assert.equal(agentEventsResetsAt(file('limite-con-reset')), '2026-08-05T15:00:00Z')
    assert.equal(agentEventsResetsAt(file('limite-sin-reset')), '')
    assert.equal(agentEventsResetsAt(file('5xx')), '')
    assert.equal(agentEventsResetsAt(file('exito')), '')
    assert.equal(agentEventsResetsAt(contract('valid-rate-limit-claude')), '2026-05-07T22:40:00Z')
    assert.equal(agentEventsResetsAt(contract('valid-rate-limit-sin-reset')), '')
    assert.equal(agentEventsResetsAt(file('reset-en-error')), '2031-01-01T00:00:00Z')
  })

  test('[A] session_id: poblado, null y archivo inexistente', () => {
    assert.equal(agentEventsSessionId(file('limite-con-reset')), 'sess-abc')
    assert.equal(agentEventsSessionId(file('limite-sin-reset')), '')
    assert.equal(agentEventsSessionId(join(work, 'no-existe.jsonl')), '')
    assert.equal(agentEventsSessionId(contract('valid-rate-limit-claude')), 'sess-ratelimit')
  })

  test('denials es 0 si el terminal no lo trae y vacio si no hay JSONL', () => {
    assert.equal(agentEventsDenials(file('sin-error')), '3')
    assert.equal(agentEventsDenials(file('error-nulo')), '0')
    assert.equal(agentEventsDenials(file('sin-terminal')), '0')
    assert.equal(agentEventsDenials(file('denials-texto')), 'muchas')
    assert.equal(agentEventsDenials(file('vacio')), '')
    assert.equal(agentEventsDenials(join(work, 'no-existe.jsonl')), '')
  })

  test('sin archivo, vacio o sin terminal no hay nada que leer', () => {
    for (const eventsFile of [join(work, 'no-existe.jsonl'), '', file('vacio')]) {
      assert.deepEqual(read(eventsFile), NOTHING, eventsFile)
    }
    assert.deepEqual(read(file('sin-terminal')), { ...NOTHING, denials: '0' })
    assert.deepEqual(read(file('solo-espacios')), { ...NOTHING, denials: '0' })
  })

  test('con varios terminales vale el ultimo que trae cada campo', () => {
    assert.deepEqual(read(file('dos-terminales')), {
      kind: 'api_error',
      resetsAt: '2030-06-01T00:00:00Z',
      sessionId: 'primera',
      denials: '0',
      completed: false,
    })
    assert.deepEqual(read(file('ultimo-terminal-vacio')), {
      kind: 'rate_limit',
      resetsAt: '',
      sessionId: 'primera',
      denials: '0',
      completed: true,
    })
    assert.equal(agentEventsCompletedSuccessfully(file('exito-y-despues-fallo')), false)
    assert.equal(agentEventsCompletedSuccessfully(file('fallo-y-despues-exito')), true)
  })

  test('un JSONL que no es JSON de punta a punta no se lee', () => {
    assert.deepEqual(read(file('ultima-linea-truncada')), NOTHING)
    assert.deepEqual(read(file('linea-que-no-es-json')), NOTHING)
    assert.deepEqual(read(join(REPO_ROOT, 'scripts', 'tests', 'fixtures', 'tooling-observability', 'truncated-input.events.jsonl')), NOTHING)
  })

  test('un valor suelto que no es objeto ni null invalida la lectura', () => {
    assert.deepEqual(read(file('valor-que-no-es-objeto')), NOTHING)
    assert.deepEqual(read(file('arreglo-suelto')), NOTHING)
    assert.deepEqual(read(file('nulo-suelto')), { ...NOTHING, sessionId: 'tras-nulo', denials: '0', completed: true })
  })

  test('un error que no es objeto invalida solo los campos que lo recorren', () => {
    const eventsFile = inline('error-texto', '{"type":"run.failed","error":"boom","resets_at":"X","session_id":"s","denials":1}\n')
    assert.deepEqual(read(eventsFile), { kind: '', resetsAt: '', sessionId: 's', denials: '1', completed: false })
  })

  test('los valores JSON pueden ocupar varias lineas o compartir una', () => {
    assert.equal(agentEventsSessionId(file('varias-lineas-por-valor')), 'bonito')
    assert.equal(agentEventsKind(file('varias-lineas-por-valor')), 'stream_cut')
    const glued = inline('pegados', '{"type":"run.failed","error":{"kind":"killed"}}{"type":"run.completed","status":"success","session_id":"pegado"}\n')
    assert.deepEqual(read(glued), { ...NOTHING, kind: 'killed', sessionId: 'pegado', denials: '0', completed: true })
    assert.equal(agentEventsSessionId(file('fin-de-linea-windows')), 'crlf')
  })

  test('un valor que no es texto se imprime como JSON', () => {
    const eventsFile = inline('kind-objeto', '{"type":"run.failed","error":{"kind":{"a":[1,2]}},"session_id":7}\n')
    assert.equal(agentEventsKind(eventsFile), '{\n  "a": [\n    1,\n    2\n  ]\n}')
    assert.equal(agentEventsSessionId(eventsFile), '7')
  })

  test('agentEventsValue lee cualquier campo del terminal', () => {
    const status = (eventsFile: string): string => agentEventsValue(eventsFile, (terminal) => get(terminal, 'status'))
    assert.equal(status(file('tooling-fallido')), 'failed')
    assert.equal(status(file('sin-terminal')), '')
    assert.equal(agentEventsValue(file('sin-terminal'), (terminal) => get(terminal, 'status'), 'ninguno'), 'ninguno')
  })
})

describe('lectura tolerante por lineas', () => {
  test('jsonLineObjects descarta lo que no es un objeto JSON', () => {
    const text = ['{"a":1}', '', 'no soy json', '[1]', '5', 'null', '  ', '{"b":2}\r', '{"c":'].join('\n')
    assert.deepEqual(jsonLineObjects(text), [{ a: 1 }, { b: 2 }])
    assert.deepEqual(jsonLineObjects(''), [])
  })

  test('readText da cadena vacia si el archivo no se puede leer', () => {
    assert.equal(readText(file('sin-terminal')), NEUTRAL_EVENTS['sin-terminal'])
    assert.equal(readText(join(work, 'no-existe')), '')
    assert.equal(readText(work), '')
  })
})

describe('paridad con la gemela bash', { skip: NO_BASH_JQ }, () => {
  test('agent_events_* sobre los fixtures de eventos del repo y los de los tests bash', () => {
    const files = [
      ...Object.values(events),
      ...NEUTRAL_EVENT_FILES.map((relative) => join(REPO_ROOT, relative)),
      join(work, 'no-existe.jsonl'),
      '',
    ]
    const script = [
      'for f in "$@"; do',
      '  printf "%s\\037%s\\037%s\\037%s\\037" "$(agent_events_kind "$f")" "$(agent_events_resets_at "$f")" "$(agent_events_session_id "$f")" "$(agent_events_denials "$f")"',
      // El codigo de un fallo es el de jq (1 o 5): solo cuenta si es cero.
      '  if agent_events_completed_successfully "$f"; then printf "0\\036"; else printf "1\\036"; fi',
      'done',
    ].join('\n')
    const fromBash = bashLibrary(script, files).stdout.split('\u001e')
    assert.equal(fromBash.length, files.length + 1)
    files.forEach((eventsFile, index) => {
      const own = read(eventsFile)
      assert.equal(
        [own.kind, own.resetsAt, own.sessionId, own.denials].map(chomp).concat(own.completed ? '0' : '1').join('\u001f'),
        fromBash[index],
        eventsFile,
      )
    })
  })
})
