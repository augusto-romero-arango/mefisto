import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { runtimeCliAvailable, runtimeSupportsResume } from '../lib/pipeline/agent-runtime.mts'

const RUNTIME_LIB_DIR = join(import.meta.dirname, '..', '..', 'src', 'runtime', 'lib')

let work = ''
let customLib = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent runtime '))
  customLib = join(work, 'lib')
  mkdirSync(customLib)
  writeFileSync(join(customLib, 'runtime-capaz.mts'), 'export const isAvailable = () => true\nexport const supportsResume = () => true\n')
  writeFileSync(join(customLib, 'runtime-incapaz.mts'), 'export const isAvailable = () => false\nexport const supportsResume = () => false\n')
  writeFileSync(join(customLib, 'runtime-mudo.mts'), 'export const buildCmd = () => ({ argv: [] })\n')
  writeFileSync(
    join(customLib, 'runtime-roto.mts'),
    'export const isAvailable = () => { throw new Error("sin CLI") }\nexport const supportsResume = () => { throw new Error("sin CLI") }\n',
  )
  writeFileSync(join(customLib, 'runtime-ilegible.mts'), 'export const = \n')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('runtimeCliAvailable', () => {
  test('pregunta al adaptador del runtime', async () => {
    const libDir = RUNTIME_LIB_DIR
    assert.equal(await runtimeCliAvailable('fake', { env: { MEFISTO_FAKE_AVAILABLE: '1' }, libDir }), true)
    assert.equal(await runtimeCliAvailable('fake', { env: {}, libDir }), false)
    assert.equal(await runtimeCliAvailable('fake', { env: { MEFISTO_FAKE_AVAILABLE: '0' }, libDir }), false)
    assert.equal(await runtimeCliAvailable('claude', { env: {}, libDir, hasCommand: (command) => command === 'claude' }), true)
    assert.equal(await runtimeCliAvailable('claude', { env: {}, libDir, hasCommand: () => false }), false)
  })

  test('sin hasCommand busca el CLI en el PATH del entorno', async () => {
    const bin = join(work, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
    chmodSync(join(bin, 'claude'), 0o755)
    assert.equal(await runtimeCliAvailable('claude', { env: { PATH: bin }, libDir: RUNTIME_LIB_DIR }), true)
    assert.equal(await runtimeCliAvailable('claude', { env: { PATH: join(work, 'vacio') }, libDir: RUNTIME_LIB_DIR }), false)
  })

  test('el directorio de adaptadores sale de MEFISTO_RUNTIME_LIB_DIR', async () => {
    assert.equal(await runtimeCliAvailable('capaz', { env: { MEFISTO_RUNTIME_LIB_DIR: customLib } }), true)
    assert.equal(await runtimeCliAvailable('capaz', { env: { MEFISTO_RUNTIME_LIB_DIR: join(work, 'no-existe') } }), false)
  })

  test('un runtime sin adaptador, sin la prueba o que falla no esta disponible', async () => {
    for (const runtime of ['incapaz', 'mudo', 'roto', 'ilegible', 'inexistente', 'runtime-inexistente', '../lib/capaz', '']) {
      assert.equal(await runtimeCliAvailable(runtime, { env: {}, libDir: customLib }), false, runtime)
    }
  })
})

describe('runtimeSupportsResume', () => {
  test('pregunta al adaptador del runtime', async () => {
    const libDir = RUNTIME_LIB_DIR
    assert.equal(await runtimeSupportsResume('claude', { env: {}, libDir }), true)
    assert.equal(await runtimeSupportsResume('fake', { env: { MEFISTO_FAKE_SUPPORTS_RESUME: '1' }, libDir }), true)
    assert.equal(await runtimeSupportsResume('fake', { env: {}, libDir }), false)
    assert.equal(await runtimeSupportsResume('fake', { env: { MEFISTO_FAKE_SUPPORTS_RESUME: 'si' }, libDir }), false)
    assert.equal(await runtimeSupportsResume('claude', { env: { PATH: join(work, 'vacio') }, libDir }), true)
    assert.equal(await runtimeSupportsResume('capaz', { env: {}, libDir: customLib }), true)
  })

  test('[pre-2] un runtime sin adaptador o sin la capacidad degrada a no soportado', async () => {
    for (const runtime of ['incapaz', 'mudo', 'roto', 'ilegible', 'runtime-inexistente', '']) {
      assert.equal(await runtimeSupportsResume(runtime, { env: {}, libDir: customLib }), false, runtime)
    }
  })
})
