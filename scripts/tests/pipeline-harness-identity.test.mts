import assert from 'node:assert/strict'
import {
  copyFileSync,
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
import { BASH_LIBRARY, bashLibrary, NO_BASH, NO_BASH_JQ, REPO_ROOT } from './pipeline-scope-parity.mts'

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
  assert.equal(existsSync(join(dir, 'tdd-pipeline.sh')), true)

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
    for (const content of ['no soy json {{{', '', '[]', '"texto"', '{"version":null}', '{"version":false}', '{"version":"null"}']) {
      writeFileSync(pluginJson, content)
      assert.equal(getHarnessVersion(scriptsDir), '', content)
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
    assert.deepEqual(getHarnessIdentity('opencode', scriptsDir), INVALID)
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
      // Mas de un valor JSON: la gemela lo da por completo con versiones multilinea.
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

describe('paridad con la gemela bash', { skip: NO_BASH }, () => {
  let library = ''

  before(() => {
    library = join(scriptsDir, '_pipeline-common.sh')
    copyFileSync(BASH_LIBRARY, library)
  })

  test('_pc_script_dir', () => {
    const fromBash = bashLibrary('_pc_script_dir', [], { cwd: tmp })
    assert.equal(fromBash.status, 0, fromBash.stderr)
    assert.equal(realpathSync.native(fromBash.stdout.trim()), realpathSync.native(pipelineScriptsDir()))
  })

  test('get_harness_version', { skip: NO_BASH_JQ }, () => {
    const contents = [
      null,
      '{\n  "name": "mefisto",\n  "version": "9.9.9"\n}\n',
      '{"name":"mefisto"}',
      '{"version":"1.2.3","description":"algo con la palabra version adentro"}',
      '{"version":null}',
      '{"version":false}',
      '{"version":"null"}',
      '{"version":""}',
      '{"version":3}',
      '{"version":{"mayor":1,"menor":[2,3]}}',
      '{"version":"1.0.0\\n"}',
      '﻿{"version":"4.5.6"}',
      'no soy json {{{',
      '',
      '[]',
      '"texto"',
      'null',
    ]
    for (const content of contents) {
      rmSync(pluginJson, { force: true })
      if (content !== null) writeFileSync(pluginJson, content)
      const fromBash = bashLibrary('get_harness_version', [], { library, cwd: tmp })
      assert.equal(fromBash.status, 0, fromBash.stderr)
      assert.equal(`${getHarnessVersion(scriptsDir)}\n`, fromBash.stdout, String(content))
    }
  })

  test('get_harness_identity_json', { skip: NO_BASH_JQ }, () => {
    const contents = [
      null,
      manifestJson(),
      `﻿${manifestJson()}`,
      manifestJson({ schemaVersion: 1.0, extra: true }),
      manifestJson({ version: '1.2.3-rc.1+build.5' }),
      manifestJson({ version: '1.2.3\n' }),
      manifestJson({ commit: `${COMMIT}\n` }),
      manifestJson({ version: '1.2.3\n\n' }),
      manifestJson({ version: 'x\n1.2.3' }),
      manifestJson({ runtime: 'opencode' }),
      manifestJson({ runtime: '' }),
      manifestJson({ schemaVersion: 2 }),
      manifestJson({ schemaVersion: '1' }),
      manifestJson({ runtime: 7 }),
      manifestJson({ runtime: undefined }),
      manifestJson({ version: '1.2' }),
      manifestJson({ version: '01.2.3' }),
      manifestJson({ version: undefined }),
      manifestJson({ commit: COMMIT.toUpperCase() }),
      manifestJson({ commit: COMMIT.slice(1) }),
      manifestJson({ commit: undefined }),
      'no soy json {{{',
      '',
      '[]',
      'null',
      '"texto"',
    ]
    for (const content of contents) {
      rmSync(manifest, { force: true })
      if (content !== null) writeFileSync(manifest, content)
      for (const runtime of ['', 'claude', 'opencode']) {
        const fromBash = bashLibrary('get_harness_identity_json "$1"', [runtime], { library, cwd: tmp })
        assert.equal(fromBash.status, 0, fromBash.stderr)
        assert.equal(
          `${harnessIdentityJson(getHarnessIdentity(runtime, scriptsDir))}\n`,
          fromBash.stdout,
          `${String(content)} [${runtime}]`,
        )
      }
    }
  })

  test('get_harness_identity_json con un directorio o un enlace por manifiesto', { skip: NO_BASH_JQ }, () => {
    const real = join(tmp, 'manifiesto-paridad.json')
    writeFileSync(real, manifestJson())
    const shapes: (() => void)[] = [
      () => mkdirSync(manifest),
      () => symlinkSync(real, manifest),
      () => symlinkSync(join(tmp, 'no-existe.json'), manifest),
    ]
    for (const shape of shapes) {
      rmSync(manifest, { recursive: true, force: true })
      shape()
      const fromBash = bashLibrary('get_harness_identity_json', [], { library, cwd: tmp })
      assert.equal(`${harnessIdentityJson(getHarnessIdentity('', scriptsDir))}\n`, fromBash.stdout)
    }
  })
})
