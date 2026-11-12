import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import {
  getHarnessIdentity,
  getHarnessVersion,
  harnessIdentityJson,
  pipelineScriptsDir,
} from '../lib/pipeline/harness-identity.mts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const COMMIT = '4906fb885588801ce412e33263f558d187075b64'
const NO_SYMLINKS = process.platform === 'win32' ? 'los enlaces simbolicos requieren privilegio en Windows' : false

let tmp = ''
let scriptsDir = ''
let pluginJson = ''
let manifest = ''

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mefisto identidad '))
  scriptsDir = join(tmp, 'fixture', 'scripts')
  pluginJson = join(tmp, 'fixture', '.claude-plugin', 'plugin.json')
  manifest = join(tmp, 'fixture', 'mefisto-manifest.json')
  mkdirSync(scriptsDir, { recursive: true })
  mkdirSync(join(tmp, 'fixture', '.claude-plugin'))
})

beforeEach(() => {
  rmSync(pluginJson, { recursive: true, force: true })
  rmSync(manifest, { recursive: true, force: true })
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function manifestJson(fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ schemaVersion: 1, runtime: 'claude', version: '1.2.3', commit: COMMIT, ...fields })}\n`
}

const MISSING = { harness_version: null, harness_commit: null, identity_state: 'metadata_missing' }
const INVALID = { harness_version: null, harness_commit: null, identity_state: 'metadata_invalid' }

test('pipelineScriptsDir es el scripts/ del plugin, absoluto y sin depender del cwd', () => {
  const dir = pipelineScriptsDir()
  assert.equal(isAbsolute(dir), true)
  assert.equal(realpathSync.native(dir), realpathSync.native(join(REPO_ROOT, 'scripts')))
  assert.equal(existsSync(join(dir, 'tdd-pipeline.mts')), true)

  const previous = process.cwd()
  process.chdir(tmp)
  try {
    assert.equal(pipelineScriptsDir(), dir)
  } finally {
    process.chdir(previous)
  }
})

describe('getHarnessVersion', () => {
  test('[A] imprime la version de plugin.json tal cual', () => {
    writeFileSync(pluginJson, '{\n  "name": "mefisto",\n  "version": "9.9.9"\n}\n')
    assert.equal(getHarnessVersion(scriptsDir), '9.9.9')
  })

  test('[B] sin campo version da cadena vacia', () => {
    writeFileSync(pluginJson, '{\n  "name": "mefisto"\n}\n')
    assert.equal(getHarnessVersion(scriptsDir), '')
  })

  test('[C] no confunde la palabra version dentro de otro campo', () => {
    writeFileSync(
      pluginJson,
      '{\n  "name": "mefisto",\n  "version": "1.2.3",\n  "description": "algo con la palabra version adentro"\n}\n',
    )
    assert.equal(getHarnessVersion(scriptsDir), '1.2.3')
  })

  test('[D] sin plugin.json da cadena vacia', () => {
    assert.equal(getHarnessVersion(scriptsDir), '')
  })

  test('un plugin.json ilegible o con version nula da cadena vacia', () => {
    for (const content of ['no soy json {{{', '', '[]', '"texto"', 'null', '{"version":null}', '{"version":false}', '{"version":"null"}', '{"version":""}']) {
      writeFileSync(pluginJson, content)
      assert.equal(getHarnessVersion(scriptsDir), '', content)
    }
  })

  test('quita el BOM y el salto final, e imprime como JSON lo que no es texto', () => {
    const cases: [string, string][] = [
      ['\ufeff{"version":"4.5.6"}', '4.5.6'],
      ['{"version":"1.0.0\\n"}', '1.0.0'],
      ['{"version":3}', '3'],
      ['{"version":{"mayor":1,"menor":[2,3]}}', '{\n  "mayor": 1,\n  "menor": [\n    2,\n    3\n  ]\n}'],
    ]
    for (const [content, version] of cases) {
      writeFileSync(pluginJson, content)
      assert.equal(getHarnessVersion(scriptsDir), version, content)
    }
  })

  test('[E] coincide con el plugin.json real del repo', () => {
    const real = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }
    assert.match(real.version, /^\d+\.\d+\.\d+/)
    assert.equal(getHarnessVersion(), real.version)
  })
})

describe('getHarnessIdentity', () => {
  test('sin manifiesto: metadata_missing', () => {
    assert.deepEqual(getHarnessIdentity('', scriptsDir), MISSING)
    assert.deepEqual(getHarnessIdentity('claude', scriptsDir), MISSING)
  })

  test('manifiesto valido: complete, con o sin runtime esperado', () => {
    writeFileSync(manifest, manifestJson())
    const complete = { harness_version: '1.2.3', harness_commit: COMMIT, identity_state: 'complete' }
    assert.deepEqual(getHarnessIdentity('', scriptsDir), complete)
    assert.deepEqual(getHarnessIdentity('claude', scriptsDir), complete)
  })

  test('manifiesto de otro runtime: metadata_invalid', () => {
    writeFileSync(manifest, manifestJson())
    assert.deepEqual(getHarnessIdentity('otro-runtime', scriptsDir), INVALID)
    writeFileSync(manifest, manifestJson({ runtime: '' }))
    assert.equal(getHarnessIdentity('', scriptsDir).identity_state, 'complete')
    assert.deepEqual(getHarnessIdentity('claude', scriptsDir), INVALID)
  })

  test('tolera el BOM, campos de mas y un salto final en version o commit', () => {
    const complete = { harness_version: '1.2.3', harness_commit: COMMIT, identity_state: 'complete' }
    for (const content of [
      `\ufeff${manifestJson()}`,
      manifestJson({ extra: true }),
      manifestJson({ version: '1.2.3\n' }),
      manifestJson({ commit: `${COMMIT}\n` }),
    ]) {
      writeFileSync(manifest, content)
      assert.deepEqual(getHarnessIdentity('', scriptsDir), complete, content)
    }
  })

  test('acepta versiones con prerelease o build', () => {
    for (const version of ['0.0.0', '10.20.30', '1.2.3-rc.1', '1.2.3+build.5', '1.2.3-alpha-1.x']) {
      writeFileSync(manifest, manifestJson({ version }))
      assert.equal(getHarnessIdentity('', scriptsDir).harness_version, version)
    }
  })

  test('metadata incompleta o malformada: metadata_invalid, sin inferir nada', () => {
    writeFileSync(pluginJson, '{"version":"9.9.9"}')
    const contents = [
      'no soy json {{{',
      '',
      '[]',
      'null',
      manifestJson({ schemaVersion: 2 }),
      manifestJson({ schemaVersion: '1' }),
      manifestJson({ runtime: 7 }),
      manifestJson({ runtime: undefined }),
      manifestJson({ version: '1.2' }),
      manifestJson({ version: '01.2.3' }),
      manifestJson({ version: 'v1.2.3' }),
      manifestJson({ version: '1.2.3 ' }),
      manifestJson({ version: undefined }),
      manifestJson({ commit: COMMIT.toUpperCase() }),
      manifestJson({ commit: COMMIT.slice(1) }),
      manifestJson({ commit: `${COMMIT}0` }),
      manifestJson({ commit: undefined }),
      manifestJson({ version: '1.2.3-rc.1+build.5' }),
      manifestJson({ version: '1.2.3\n\n' }),
      manifestJson({ version: 'x\n1.2.3' }),
      '"texto"',
      manifestJson() + manifestJson(),
    ]
    for (const content of contents) {
      writeFileSync(manifest, content)
      assert.deepEqual(getHarnessIdentity('', scriptsDir), INVALID, content)
    }
  })

  test('un directorio en el lugar del manifiesto: metadata_invalid', () => {
    mkdirSync(manifest)
    assert.deepEqual(getHarnessIdentity('', scriptsDir), INVALID)
  })

  test('un enlace simbolico no vale como manifiesto', { skip: NO_SYMLINKS }, () => {
    const real = join(tmp, 'manifiesto-real.json')
    writeFileSync(real, manifestJson())
    symlinkSync(real, manifest)
    assert.deepEqual(getHarnessIdentity('', scriptsDir), INVALID)

    rmSync(manifest)
    symlinkSync(join(tmp, 'no-existe.json'), manifest)
    assert.deepEqual(getHarnessIdentity('', scriptsDir), MISSING)
  })

  test('el manifiesto real del repo, si esta completo, coincide con su contenido', () => {
    const identity = getHarnessIdentity()
    const real = join(REPO_ROOT, 'mefisto-manifest.json')
    if (!existsSync(real)) return assert.equal(identity.identity_state, 'metadata_missing')
    const { version, commit } = JSON.parse(readFileSync(real, 'utf8')) as { version: string; commit: string }
    assert.deepEqual(identity, { harness_version: version, harness_commit: commit, identity_state: 'complete' })
  })
})

describe('harnessIdentityJson', () => {
  test('emite JSON compacto con las claves en el orden del contrato', () => {
    assert.equal(
      harnessIdentityJson({ identity_state: 'complete', harness_commit: COMMIT, harness_version: '1.2.3' }),
      `{"harness_version":"1.2.3","harness_commit":"${COMMIT}","identity_state":"complete"}`,
    )
    assert.equal(
      harnessIdentityJson({ harness_version: null, harness_commit: null, identity_state: 'metadata_missing' }),
      '{"harness_version":null,"harness_commit":null,"identity_state":"metadata_missing"}',
    )
  })
})
