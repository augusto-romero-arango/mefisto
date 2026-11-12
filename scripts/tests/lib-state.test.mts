import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { stateDirs, statePath, stateReadFirst, stateReadPaths } from '../lib/state.mts'
import { git } from './field-note-sandbox.mts'

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

test('sin raiz, statePath y stateReadPaths resuelven contra MEFISTO_STATE_DIR', () => {
  const env = { MEFISTO_STATE_DIR: join(root, 'externo'), MEFISTO_LEGACY_STATE_DIR: join(root, 'externo-viejo') }
  const path = statePath(join('logs', 'x.log'), undefined, env)
  assert.equal(path, join(root, 'externo', 'logs', 'x.log'))
  writeFileSync(path, '')
  assert.deepEqual(stateReadPaths(join('logs', 'x.log'), undefined, env), [path])
})

test('statePath escribe en la canonica sin tocar la legacy', () => {
  const repo = join(root, 'con-legacy')
  const legacy = join(repo, '.claude', 'pipeline')
  mkdirSync(join(legacy, 'summaries'), { recursive: true })
  writeFileSync(join(legacy, 'summaries', 'stage-1-writer.md'), 'viejo\n')
  const path = statePath(join('summaries', 'stage-1-writer.md'), repo)
  assert.equal(path, join(repo, '.mefisto', 'pipeline', 'summaries', 'stage-1-writer.md'))
  assert.deepEqual(readdirSync(legacy, { recursive: true }).sort(), ['summaries', join('summaries', 'stage-1-writer.md')])
  assert.equal(readFileSync(join(legacy, 'summaries', 'stage-1-writer.md'), 'utf8'), 'viejo\n')
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

test('sin raiz ni overrides las rutas cuelgan de la raiz Git, aunque se este en un subdirectorio', () => {
  const repo = join(root, 'repo')
  const nested = join(repo, 'anidado', 'trabajo')
  mkdirSync(nested, { recursive: true })
  git(repo, 'init', '-q')
  const previous = process.cwd()
  process.chdir(nested)
  try {
    const dirs = stateDirs(undefined, {})
    const top = realpathSync.native(repo)
    assert.ok(dirs.canonical.endsWith(join('.mefisto', 'pipeline')))
    assert.ok(dirs.legacy.endsWith(join('.claude', 'pipeline')))
    assert.equal(realpathSync.native(join(dirs.canonical, '..', '..')), top)
    assert.equal(realpathSync.native(join(dirs.legacy, '..', '..')), top)
  } finally {
    process.chdir(previous)
  }
})

test('la lectura respeta el override legacy y la escritura nunca toca la legacy', () => {
  const env = { MEFISTO_STATE_DIR: join(root, 'override-canon'), MEFISTO_LEGACY_STATE_DIR: join(root, 'override-viejo') }
  const legacy = join(env.MEFISTO_LEGACY_STATE_DIR, 'logs', 'override.log')
  mkdirSync(join(env.MEFISTO_LEGACY_STATE_DIR, 'logs'), { recursive: true })
  writeFileSync(legacy, 'legacy')
  assert.equal(stateReadFirst(join('logs', 'override.log'), undefined, env), legacy)

  const canonical = statePath(join('logs', 'override.log'), undefined, env)
  assert.equal(canonical, join(env.MEFISTO_STATE_DIR, 'logs', 'override.log'))
  writeFileSync(canonical, 'canon')
  assert.equal(readFileSync(legacy, 'utf8'), 'legacy')
  assert.deepEqual(stateReadPaths(join('logs', 'override.log'), undefined, env), [canonical, legacy])
})

test('statePath falla sin devolver ruta si no puede crear el directorio padre', () => {
  const bad = join(root, 'bloqueado')
  mkdirSync(join(bad, '.mefisto', 'pipeline'), { recursive: true })
  writeFileSync(join(bad, '.mefisto', 'pipeline', 'logs'), 'archivo')
  assert.throws(() => statePath(join('logs', 'x.log'), bad))
})
