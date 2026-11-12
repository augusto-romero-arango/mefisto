// Contrato neutral de los hooks interactivos: el validador, los fixtures de sessions.jsonl y el
// destino del recordatorio.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { validateInteractiveHooks } from '../validate-interactive-hooks.mts'

const HERE = import.meta.dirname
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const HOOKS = join(REPO_ROOT, 'src', 'published', 'hooks')
const FIXTURES = join(HOOKS, 'fixtures')
const VALID = join(FIXTURES, 'valid', 'interactive-hooks.json')
const SESSIONS = join(FIXTURES, 'sessions')

interface Binding {
  id: string
  signal: string
  action: string
  destinations: string[]
  persistedFields: string[]
  delivery: { mode: string; failure: string; timeoutSeconds: number | null }
  [extra: string]: unknown
}

interface Contract {
  bindings: Binding[]
}

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto contrato hooks '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Valida el fixture valido tras aplicarle `mutate`. */
function validateMutated(
  name: string,
  mutate: (binding: (index: number) => Binding) => void,
): { status: number; text: string } {
  const contract = JSON.parse(readFileSync(VALID, 'utf8')) as Contract
  mutate((index) => {
    const binding = contract.bindings[index]
    assert.ok(binding !== undefined)
    return binding
  })
  const candidate = join(work, `${name}.json`)
  writeFileSync(candidate, JSON.stringify(contract))
  const result = validateInteractiveHooks([candidate], REPO_ROOT)
  return { status: result.status, text: result.errors.join('\n') }
}

describe('validador del contrato', () => {
  test('existen el contrato y un schema JSON valido', () => {
    assert.ok(existsSync(join(HOOKS, 'interactive-hooks.json')))
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(HOOKS, 'interactive-hooks.schema.json'), 'utf8')))
  })

  test('acepta el descriptor vigente y el fixture valido', () => {
    assert.deepEqual(validateInteractiveHooks([], REPO_ROOT), { status: 0, errors: [] })
    assert.deepEqual(validateInteractiveHooks([join(HOOKS, 'interactive-hooks.json')], REPO_ROOT), {
      status: 0,
      errors: [],
    })
    assert.deepEqual(validateInteractiveHooks([VALID], REPO_ROOT), { status: 0, errors: [] })
  })

  const INVALID: Record<string, { mutate: (binding: (index: number) => Binding) => void; expected: string }> =
    {
      'action-without-contract': {
        mutate: (binding) => (binding(0).id = 'unmapped-release'),
        expected: 'accion sin contrato',
      },
      'additional-persisted-field': {
        mutate: (binding) => binding(0).persistedFields.push('runtime_version'),
        expected: 'allowlist de campos persistibles divergente',
      },
      'delivery-divergent': {
        mutate: (binding) => (binding(2).delivery.timeoutSeconds = 30),
        expected: 'delivery divergente',
      },
      'duplicate-destination': {
        mutate: (binding) => binding(0).destinations.push('legacy-release-marker'),
        expected: 'destinos duplicados',
      },
      'duplicate-id': {
        mutate: (binding) => (binding(1).id = 'record-active-release'),
        expected: 'id duplicado',
      },
      'extra-property': {
        mutate: (binding) => (binding(0).extra = true),
        expected: 'propiedad adicional o faltante',
      },
      'legacy-destination-on-other-binding': {
        mutate: (binding) => binding(1).destinations.push('legacy-release-marker'),
        expected: 'destinos no coinciden con su contrato',
      },
      'missing-canonical-destination': {
        mutate: (binding) => (binding(0).destinations = ['release-identity', 'legacy-release-marker']),
        expected: 'falta el destino canonico obligatorio',
      },
      'runtime-reference': {
        mutate: (binding) => (binding(0).id = 'claude-release'),
        expected: 'referencia a runtime',
      },
      'sensitive-field': {
        mutate: (binding) => binding(1).persistedFields.push('prompt'),
        expected: 'campo persistible sensible',
      },
      'unknown-action': {
        mutate: (binding) => (binding(0).action = 'start-tool'),
        expected: 'accion desconocida',
      },
      'unknown-destination': {
        mutate: (binding) => (binding(0).destinations = ['runtime-cache']),
        expected: 'destino desconocido',
      },
      'unknown-field': {
        mutate: (binding) => binding(3).persistedFields.push('unexpected'),
        expected: 'allowlist de campos persistibles divergente',
      },
      'unknown-pair': {
        mutate: (binding) => (binding(0).signal = 'session.turn-completed'),
        expected: 'par signal/action desconocido',
      },
      'unknown-signal': {
        mutate: (binding) => (binding(0).signal = 'tool.started'),
        expected: 'signal desconocida',
      },
    }

  for (const [name, { mutate, expected }] of Object.entries(INVALID)) {
    test(`rechaza ${name}: ${expected}`, () => {
      const result = validateMutated(name, mutate)
      assert.equal(result.status, 1)
      assert.ok(result.text.includes(expected), result.text)
    })
  }

  test('legacy-release-marker queda reservado a record-active-release', () => {
    for (const index of [1, 2, 3, 4, 5, 6]) {
      const result = validateMutated(`legacy-release-marker-${index}`, (binding) =>
        binding(index).destinations.push('legacy-release-marker'),
      )
      assert.equal(result.status, 1, `binding ${index}`)
      assert.ok(result.text.includes('destinos no coinciden con su contrato'), result.text)
    }
  })

  test('diagnostica argumentos y archivos que no puede leer', () => {
    assert.deepEqual(validateInteractiveHooks(['a', 'b'], REPO_ROOT), {
      status: 1,
      errors: ['Uso: validate-interactive-hooks.mts [contrato.json]'],
    })
    const missing = join(work, 'no-existe.json')
    assert.deepEqual(validateInteractiveHooks([missing], REPO_ROOT), {
      status: 1,
      errors: [`${missing}: archivo no existe`],
    })
    const broken = join(work, 'roto.json')
    writeFileSync(broken, '{')
    assert.deepEqual(validateInteractiveHooks([broken], REPO_ROOT), {
      status: 1,
      errors: [`${broken}: JSON invalido`],
    })
    const list = join(work, 'lista.json')
    writeFileSync(list, '[]')
    assert.deepEqual(validateInteractiveHooks([list], REPO_ROOT), {
      status: 1,
      errors: [`${list}: no se pudo evaluar el contrato`],
    })
    assert.deepEqual(validateInteractiveHooks([], join(work, 'sin-schema')), {
      status: 1,
      errors: [
        `ERROR: falta schema: ${join(work, 'sin-schema', 'src', 'published', 'hooks', 'interactive-hooks.schema.json')}`,
      ],
    })
  })

  // El validador evalua cada valor JSON del archivo; sin ninguno no hay hallazgos.
  test('un contrato vacio pasa sin errores', () => {
    const empty = join(work, 'vacio.json')
    writeFileSync(empty, '')
    assert.deepEqual(validateInteractiveHooks([empty], REPO_ROOT), { status: 0, errors: [] })
  })
})

type Session = Record<string, unknown>

const STARTED_KEYS = [
  'cwd',
  'harness_commit',
  'harness_version',
  'model',
  'record_type',
  'runtime',
  'session_id',
  'source',
  'timestamp',
  'transcript_path',
]
const OBSERVED_KEYS = [
  'harness_commit',
  'harness_version',
  'model',
  'record_type',
  'runtime',
  'session_id',
  'timestamp',
]
const LEGACY_KEYS = ['cwd', 'harness_version', 'session_id', 'source', 'timestamp', 'transcript_path']

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.length > 0
const timestamp = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value)
const version = (value: unknown): boolean => value === null || nonEmpty(value)
const commit = (value: unknown): boolean =>
  value === null || (typeof value === 'string' && /^[0-9a-f]{40}$/.test(value))
const hasKeys = (record: Session, keys: string[]): boolean =>
  JSON.stringify(Object.keys(record).sort()) === JSON.stringify(keys)

function meetsContract(record: Session): boolean {
  if (!('record_type' in record)) {
    return (
      hasKeys(record, LEGACY_KEYS) &&
      ['session_id', 'transcript_path', 'cwd', 'source'].every((key) => nonEmpty(record[key])) &&
      timestamp(record.timestamp) &&
      version(record.harness_version)
    )
  }
  if (record.record_type === 'session.started') {
    return (
      hasKeys(record, STARTED_KEYS) &&
      ['session_id', 'transcript_path', 'cwd', 'source'].every((key) => nonEmpty(record[key])) &&
      timestamp(record.timestamp) &&
      record.runtime === 'claude' &&
      (record.model === null || nonEmpty(record.model)) &&
      version(record.harness_version) &&
      commit(record.harness_commit)
    )
  }
  if (record.record_type === 'session.model-observed') {
    return (
      hasKeys(record, OBSERVED_KEYS) &&
      nonEmpty(record.session_id) &&
      timestamp(record.timestamp) &&
      record.runtime === 'claude' &&
      nonEmpty(record.model) &&
      version(record.harness_version) &&
      commit(record.harness_commit)
    )
  }
  return false
}

function sessions(name: string): Session[] {
  return readFileSync(join(SESSIONS, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Session)
}

describe('fixtures de sessions.jsonl', () => {
  for (const name of readdirSync(SESSIONS).filter((entry) => entry.endsWith('.jsonl'))) {
    test(`${name}: todas las lineas cumplen el contrato aplicable`, () => {
      const records = sessions(name)
      assert.ok(records.length > 0)
      for (const record of records) assert.ok(meetsContract(record), JSON.stringify(record))
    })
  }

  test('inicios: identidad completa, modelo nulo y manifiesto ausente quedan diferenciados', () => {
    const last = (name: string): Session => sessions(name).at(-1) ?? {}
    const complete = last('started-complete.jsonl')
    assert.equal(complete.record_type, 'session.started')
    assert.ok(
      complete.model !== null && complete.harness_version !== null && complete.harness_commit !== null,
    )
    const nullModel = last('started-null-model.jsonl')
    assert.deepEqual([nullModel.record_type, nullModel.model], ['session.started', null])
    const missing = last('missing-manifest.jsonl')
    assert.deepEqual(
      [missing.record_type, missing.harness_version, missing.harness_commit],
      ['session.started', null, null],
    )
  })

  test('la observacion conserva un modelo opaco sin campo provider', () => {
    const observation = sessions('first-model-observation.jsonl').at(-1) ?? {}
    assert.equal(observation.record_type, 'session.model-observed')
    assert.ok(nonEmpty(observation.model))
    assert.ok(!('provider' in observation))
  })

  test('un modelo repetido se omite y un cambio conserva ambos hechos', () => {
    const records = sessions('model-repeat-and-change.jsonl')
    assert.deepEqual(
      records.map((record) => record.record_type),
      ['session.started', 'session.model-observed', 'session.model-observed'],
    )
    assert.deepEqual(
      records.map((record) => record.model),
      [null, 'claude-sonnet-4-6', 'claude-opus-4-6'],
    )
  })

  test('seis campos se interpretan como inicio legacy sin migracion', () => {
    const [legacy, started, ...rest] = sessions('legacy-and-new.jsonl')
    assert.equal(rest.length, 0)
    assert.ok(legacy !== undefined && hasKeys(legacy, LEGACY_KEYS) && !('record_type' in legacy))
    assert.equal(started?.record_type, 'session.started')
  })
})

describe('remind-field-notes', () => {
  test('el recordatorio apunta a docs/bitacora/field-notes/', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'interactive-hooks.mts'), 'utf8')
    const reminder = /\[recordatorio\][^']*/.exec(script)?.[0] ?? ''
    assert.ok(reminder.includes('docs/bitacora/field-notes/'), reminder)
  })
})
