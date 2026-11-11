import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { stateDirs, statePath, stateReadFirst, stateReadPaths } from '../lib/state.mts'

let root = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mefisto estado '))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('con raiz explicita las rutas cuelgan de ese repo', () => {
  assert.deepEqual(stateDirs(root), {
    canonical: join(root, '.mefisto', 'pipeline'),
    legacy: join(root, '.claude', 'pipeline'),
  })
})

test('sin raiz respeta los overrides de entorno', () => {
  const env = { MEFISTO_STATE_DIR: join(root, 'canon'), MEFISTO_LEGACY_STATE_DIR: join(root, 'viejo') }
  assert.deepEqual(stateDirs(undefined, env), { canonical: env.MEFISTO_STATE_DIR, legacy: env.MEFISTO_LEGACY_STATE_DIR })
  const defaults = stateDirs(undefined, {})
  assert.ok(defaults.canonical.endsWith(join('.mefisto', 'pipeline')))
  assert.ok(defaults.legacy.endsWith(join('.claude', 'pipeline')))
})

test('statePath crea el directorio padre y no el archivo', () => {
  const path = statePath(join('logs', 'corrida.log'), root)
  assert.equal(path, join(root, '.mefisto', 'pipeline', 'logs', 'corrida.log'))
  assert.equal(existsSync(join(root, '.mefisto', 'pipeline', 'logs')), true)
  assert.equal(existsSync(path), false)
})

test('stateReadPaths lista lo que existe, canonico primero', () => {
  const canonical = join(root, '.mefisto', 'pipeline', 'status.json')
  const legacy = join(root, '.claude', 'pipeline', 'status.json')
  assert.deepEqual(stateReadPaths('status.json', root), [])
  assert.equal(stateReadFirst('status.json', root), null)

  mkdirSync(join(root, '.claude', 'pipeline'), { recursive: true })
  writeFileSync(legacy, '{}')
  assert.deepEqual(stateReadPaths('status.json', root), [legacy])

  mkdirSync(join(root, '.mefisto', 'pipeline'), { recursive: true })
  writeFileSync(canonical, '{}')
  assert.deepEqual(stateReadPaths('status.json', root), [canonical, legacy])
  assert.equal(stateReadFirst('status.json', root), canonical)
})
