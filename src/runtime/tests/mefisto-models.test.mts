import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture, commandExists } from '../../../scripts/lib/cli.mts'
import { readModelsMapping, resolveModel, validateModelsMapping } from '../lib/mefisto-models.mts'
import type { ModelRequest } from '../lib/mefisto-models.mts'
import { adapterPath } from '../lib/mefisto-runtime.mts'
import { CONTRACT_DIR, LIB_DIR } from './runner-sandbox.mts'

const ALPHA_DEFAULT = `export function defaultModel(profile) {
  if (profile === 'fast') return 'alpha default'
  return profile === 'balanced' || profile === 'deep' ? '' : null
}
`
const NO_DEFAULT = 'export function isAvailable() { return true }\n'

let work = ''
let libs = ''
let mapping = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto models '))
  libs = join(work, 'libs')
  mkdirSync(libs)
  writeFileSync(join(libs, 'runtime-alpha.mts'), ALPHA_DEFAULT)
  writeFileSync(join(libs, 'runtime-nodefault.mts'), NO_DEFAULT)
  mapping = join(work, 'models.json')
  writeFileSync(
    mapping,
    '{"alpha":{"profiles":{"fast":"profile model","balanced":"balanced model"},"agents":{"writer":"agent model with spaces"}}}\n',
  )
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function file(name: string, content: string): string {
  const path = join(work, name)
  writeFileSync(path, content)
  return path
}

function alpha(request: Partial<ModelRequest>) {
  return resolveModel({ runtime: 'alpha', agentId: 'reviewer', profile: 'fast', libDir: libs, env: {}, ...request })
}

describe('precedencia', () => {
  test('override explicito, mapping por agente, mapping por perfil, default y herencia', async () => {
    assert.deepEqual(
      await alpha({ agentId: 'writer', explicitModel: 'explicit model with spaces', mappingFile: mapping }),
      { model: 'explicit model with spaces' },
    )
    assert.deepEqual(await alpha({ agentId: 'writer', mappingFile: mapping }), { model: 'agent model with spaces' })
    assert.deepEqual(await alpha({ mappingFile: mapping }), { model: 'profile model' })
    assert.deepEqual(await alpha({ profile: 'deep', mappingFile: mapping }), { model: '' })
  })

  test('una ruta omitida, inexistente o vacia equivale a no tener mapping', async () => {
    assert.deepEqual(await alpha({ mappingFile: join(work, 'inexistente.json') }), { model: 'alpha default' })
    assert.deepEqual(await alpha({}), { model: 'alpha default' })
    assert.deepEqual(await alpha({ mappingFile: file('vacio.json', '') }), { model: 'alpha default' })
    assert.deepEqual(await alpha({ mappingFile: file('mapa-vacio.json', '{}') }), { model: 'alpha default' })
    assert.deepEqual(await alpha({ mappingFile: work }), { model: 'alpha default' })
  })

  test('un adaptador sin default hereda, tambien si antes declaraba uno', async () => {
    assert.deepEqual(
      await resolveModel({ runtime: 'nodefault', agentId: 'writer', profile: 'deep', libDir: libs, env: {} }),
      { model: '' },
    )
    writeFileSync(join(libs, 'runtime-alpha.mts'), NO_DEFAULT)
    try {
      assert.deepEqual(await alpha({}), { model: '' })
    } finally {
      writeFileSync(join(libs, 'runtime-alpha.mts'), ALPHA_DEFAULT)
    }
    assert.deepEqual(await alpha({}), { model: 'alpha default' })
  })
})

describe('mapping invalido', () => {
  const invalid: [string, string, string][] = [
    ['json-invalido.json', '{', 'no es JSON valido'],
    ['dos-documentos.json', '{}\n{}\n', 'no es JSON valido'],
    ['solo-espacios.json', ' \n', 'no es JSON valido'],
    ['raiz-invalida.json', '[]', '.: se esperaba un objeto'],
    ['campo-invalido.json', '{"alpha":{"otro":{}}}', 'alpha.otro: campo desconocido'],
    ['profiles-null.json', '{"alpha":{"profiles":null}}', 'alpha.profiles: se esperaba un objeto'],
    ['modelo-invalido.json', '{"alpha":{"agents":{"writer":7}}}', 'alpha.agents.writer: se esperaba un string no vacio'],
    ['modelo-vacio.json', '{"alpha":{"profiles":{"fast":""}}}', 'alpha.profiles.fast: se esperaba un string no vacio'],
    ['perfil-invalido.json', '{"alpha":{"profiles":{"slow":"x"}}}', 'alpha.profiles.slow: perfil desconocido'],
    ['runtime-invalido.json', '{"bad-id":{}}', 'bad-id: id de runtime invalido'],
    ['runtime-no-objeto.json', '{"alpha":7}', 'alpha: se esperaba un objeto'],
  ]
  for (const [name, content, reason] of invalid) {
    test(`${name} falla como "<archivo>: ${reason}"`, async () => {
      const path = file(name, content)
      assert.deepEqual(await alpha({ agentId: 'writer', mappingFile: path }), { error: `${path}: ${reason}` })
    })
  }

  test('varios motivos se juntan con "; " en el orden del mapping', () => {
    const path = file('varios.json', '{"alpha":{"otro":1,"profiles":{"slow":"x","fast":""},"agents":{"a":null}},"B":{}}')
    assert.deepEqual(readModelsMapping(path), {
      error: `${path}: alpha.otro: campo desconocido; alpha.profiles.slow: perfil desconocido; alpha.profiles.fast: se esperaba un string no vacio; alpha.agents.a: se esperaba un string no vacio; B: id de runtime invalido`,
    })
  })

  test('un override explicito no llega a leer el mapping', async () => {
    assert.deepEqual(await alpha({ explicitModel: 'x', mappingFile: file('roto.json', '{') }), { model: 'x' })
  })
})

describe('errores de la llamada', () => {
  test('perfil fuera del vocabulario', async () => {
    assert.deepEqual(await alpha({ profile: 'unknown' }), {
      error: "profile: 'unknown' no esta en el vocabulario fast|balanced|deep",
    })
  })

  test('runtime con id invalido o sin adaptador', async () => {
    assert.deepEqual(await alpha({ runtime: 'bad-id' }), { error: "runtime invalido: 'bad-id'" })
    assert.deepEqual(await alpha({ runtime: 'missing' }), {
      error: `runtime 'missing' no tiene adaptador (${adapterPath(libs, 'missing')})`,
    })
  })

  test('un adaptador que no carga y uno que rechaza el perfil', async () => {
    writeFileSync(join(libs, 'runtime-roto.mts'), 'esto no es codigo {\n')
    assert.deepEqual(await alpha({ runtime: 'roto' }), {
      error: `runtime 'roto': no se pudo cargar el adaptador (${adapterPath(libs, 'roto')})`,
    })
    writeFileSync(join(libs, 'runtime-terco.mts'), 'export function defaultModel() { return null }\n')
    assert.deepEqual(await alpha({ runtime: 'terco' }), {
      error: "runtime_terco_default_model: no acepta el perfil 'fast'",
    })
  })
})

describe('adaptadores del repo', () => {
  test('el fake hereda o se configura, y no deriva un mapping del cwd ni del estado', async () => {
    mkdirSync(join(work, '.mefisto'), { recursive: true })
    writeFileSync(
      join(work, '.mefisto', 'models.json'),
      '{"fake":{"profiles":{"balanced":"modelo de estado prohibido"}}}',
    )
    const previous = process.cwd()
    process.chdir(work)
    try {
      assert.deepEqual(
        await resolveModel({
          runtime: 'fake',
          agentId: 'writer',
          profile: 'balanced',
          libDir: LIB_DIR,
          env: { MEFISTO_REPO_ROOT: work },
        }),
        { model: '' },
      )
    } finally {
      process.chdir(previous)
    }
    assert.deepEqual(
      await resolveModel({
        runtime: 'fake',
        agentId: 'writer',
        profile: 'balanced',
        libDir: LIB_DIR,
        env: { MEFISTO_FAKE_DEFAULT_MODEL: 'fake model with spaces' },
      }),
      { model: 'fake model with spaces' },
    )
  })

  test('Claude usa su tabla vigente', async () => {
    for (const [profile, model] of [['fast', 'haiku'], ['balanced', 'sonnet'], ['deep', 'opus']] as const) {
      assert.deepEqual(
        await resolveModel({ runtime: 'claude', agentId: 'writer', profile, libDir: LIB_DIR, env: {} }),
        { model },
      )
    }
  })
})

describe('paridad con models.validate.jq', () => {
  const skip = process.platform === 'win32' || !commandExists('jq') ? 'requiere jq' : false
  const documents = [
    '{}',
    '[]',
    '"x"',
    '{"alpha":{"profiles":{"fast":"a","slow":"b","deep":""},"agents":{"w":"m","x":1},"otro":{}},"Mal":{},"beta":3}',
    '{"claude":{"efforts":{"agents":{"a":"thorough","b":"alto","c":3},"levels":{"quick":"low","alto":"x","light":""},"otro":1}}}',
    '{"claude":{"efforts":[],"profiles":[],"agents":"x"},"otro":{"efforts":{"agents":1,"levels":null}}}',
    '{"claude":{"profiles":{"fast":"haiku"},"agents":{"writer":"opus"},"efforts":{"agents":{"writer":"quick"},"levels":{"quick":"low"}}}}',
  ]
  test('los mismos motivos, en el mismo orden', { skip }, () => {
    for (const document of documents) {
      const jq = capture('jq', ['-r', '-f', join(CONTRACT_DIR, 'models.validate.jq')], { input: document })
      assert.equal(jq.status, 0, jq.stderr)
      const expected = jq.stdout.split('\n').filter((line) => line.length > 0)
      assert.deepEqual(validateModelsMapping(JSON.parse(document)), expected, document)
    }
  })
})
