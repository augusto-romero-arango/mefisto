import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { commandExists } from '../../../scripts/lib/cli.mts'
import {
  adapterIds,
  adapterPath,
  discoverRuntime,
  loadAdapter,
  resolveRuntime,
  runtimeLibDir,
} from '../lib/mefisto-runtime.mts'
import { LIB_DIR } from './runner-sandbox.mts'

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto runtime '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function libDir(name: string, adapters: Record<string, string>): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(adapters)) writeFileSync(join(dir, file), content)
  return dir
}

const envProbe = (variable: string): string =>
  `export function isAvailable(env) { return env.${variable} === '1' }\n`
const commandProbe = (command: string): string =>
  `export function isAvailable(_env, hasCommand) { return hasCommand('${command}') }\n`
const never = (): boolean => false

describe('descubrimiento abierto', () => {
  test('los ids salen de los archivos y la disponibilidad, de la prueba de cada adaptador', async () => {
    const libs = libDir('abierto', {
      'runtime-alpha.mts': envProbe('ALPHA_AVAILABLE'),
      'runtime-beta.mts': envProbe('BETA_AVAILABLE'),
      'runtime-Mal.mts': envProbe('ALPHA_AVAILABLE'),
      'otro.mts': '',
      'runtime-gamma.sh': '',
    })
    assert.deepEqual(adapterIds(libs), ['alpha', 'beta'])

    const none = await resolveRuntime('', {}, never, libs)
    assert.deepEqual(none, {
      error: 'no se detecto ningun runtime disponible entre los adaptadores (alpha, beta): fija MEFISTO_RUNTIME o --runtime',
    })
    assert.deepEqual(await resolveRuntime('', { ALPHA_AVAILABLE: '1' }, never, libs), { runtime: 'alpha' })
    assert.deepEqual(await resolveRuntime('', { ALPHA_AVAILABLE: '1', BETA_AVAILABLE: '1' }, never, libs), {
      error: 'se detectaron varios runtimes disponibles (alpha beta): fija MEFISTO_RUNTIME o --runtime para desambiguar',
    })
  })

  test('el runtime explicito gana al entorno y el entorno, a la autodeteccion', async () => {
    const libs = libDir('precedencia', {
      'runtime-alpha.mts': envProbe('ALPHA_AVAILABLE'),
      'runtime-beta.mts': envProbe('BETA_AVAILABLE'),
    })
    const env = { MEFISTO_RUNTIME: 'beta', ALPHA_AVAILABLE: '1' }
    assert.deepEqual(await resolveRuntime('alpha', env, never, libs), { runtime: 'alpha' })
    assert.deepEqual(await resolveRuntime('', env, never, libs), { runtime: 'beta' })
  })

  test('la deteccion por comando no depende del PATH real de la maquina', async () => {
    const libs = libDir('por-comando', {
      'runtime-claude.mts': commandProbe('claude'),
      'runtime-otro.mts': commandProbe('otro'),
    })
    const has = (...commands: string[]) => (command: string): boolean => commands.includes(command)

    const none = await resolveRuntime('', {}, has(), libs)
    assert.match('error' in none ? none.error : '', /MEFISTO_RUNTIME/)
    const both = await resolveRuntime('', {}, has('claude', 'otro'), libs)
    assert.match('error' in both ? both.error : '', /MEFISTO_RUNTIME/)
    assert.deepEqual(await resolveRuntime('', {}, has('claude'), libs), { runtime: 'claude' })
    assert.deepEqual(await resolveRuntime('otro', {}, has(), libs), { runtime: 'otro' })
    assert.deepEqual(await resolveRuntime('', { MEFISTO_RUNTIME: 'otro' }, has(), libs), { runtime: 'otro' })
  })

  test('un runtime sin adaptador o con id invalido falla con su motivo', async () => {
    const libs = libDir('sin-adaptador', { 'runtime-claude.mts': commandProbe('claude') })
    assert.deepEqual(await resolveRuntime('bogus', {}, never, libs), {
      error: `runtime 'bogus' no tiene adaptador (${adapterPath(libs, 'bogus')}): fija MEFISTO_RUNTIME a un runtime soportado`,
    })
    assert.deepEqual(await resolveRuntime('Mal-Id', {}, never, libs), { error: "runtime invalido: 'Mal-Id'" })
    assert.deepEqual(await resolveRuntime('', { MEFISTO_RUNTIME: '../x' }, never, libs), {
      error: "runtime invalido: '../x'",
    })
  })

  test('un adaptador que no carga o que no declara prueba cuenta como no disponible', async () => {
    const libs = libDir('rotos', {
      'runtime-roto.mts': 'esto no es codigo {\n',
      'runtime-mudo.mts': 'export const nada = 1\n',
      'runtime-lanza.mts': 'export function isAvailable() { throw new Error("x") }\n',
      'runtime-bueno.mts': envProbe('BUENO'),
    })
    assert.equal(await loadAdapter(libs, 'roto'), null)
    assert.equal(await loadAdapter(libs, 'no-existe'), null)
    assert.deepEqual(await resolveRuntime('', { BUENO: '1' }, never, libs), { runtime: 'bueno' })
  })

  test('un adaptador reescrito se vuelve a cargar', async () => {
    const libs = libDir('recarga', { 'runtime-alpha.mts': 'export const marca = 1\n' })
    assert.equal(((await loadAdapter(libs, 'alpha')) as { marca?: number }).marca, 1)
    writeFileSync(adapterPath(libs, 'alpha'), 'export const marca = 2\n')
    assert.equal(((await loadAdapter(libs, 'alpha')) as { marca?: number }).marca, 2)
  })
})

describe('adaptadores del repo', () => {
  test('el directorio de adaptadores es el de la libreria salvo que el entorno lo cambie', () => {
    assert.equal(runtimeLibDir({}), LIB_DIR)
    assert.equal(runtimeLibDir({ MEFISTO_RUNTIME_LIB_DIR: '' }), LIB_DIR)
    assert.equal(runtimeLibDir({ MEFISTO_RUNTIME_LIB_DIR: work }), work)
  })

  test('fake resuelve contra la libreria real aunque no haya ningun runtime instalado', async () => {
    assert.deepEqual(await resolveRuntime('fake', {}, never, LIB_DIR), { runtime: 'fake' })
    assert.deepEqual(await resolveRuntime('', { MEFISTO_FAKE_AVAILABLE: '1' }, never, LIB_DIR), { runtime: 'fake' })
    assert.deepEqual(await resolveRuntime('', {}, (command) => command === 'claude', LIB_DIR), {
      runtime: 'claude',
    })
  })

  test('el fake solo declara refresco interactivo y reanudacion si el test lo pide', async () => {
    const fake = await loadAdapter(LIB_DIR, 'fake')
    assert.equal(fake?.interactiveRefresh?.({}), null)
    assert.equal(fake?.interactiveRefresh?.({ MEFISTO_FAKE_INTERACTIVE_REFRESH: '' }), null)
    assert.equal(fake?.interactiveRefresh?.({ MEFISTO_FAKE_INTERACTIVE_REFRESH: 'prompt /fake-refresh' }), 'prompt /fake-refresh')
    assert.equal(fake?.supportsResume?.({}), false)
    assert.equal(fake?.supportsResume?.({ MEFISTO_FAKE_SUPPORTS_RESUME: '1' }), true)
  })
})

describe('discoverRuntime', () => {
  test('elige el unico runtime disponible sin cargar los adaptadores', () => {
    const libs = libDir('sincrono', {
      'runtime-claude.mts': '',
      'runtime-fake.mts': '',
      'runtime-otro.mts': '',
      'runtime-Mal.mts': '',
      'otro.mts': '',
    })
    assert.deepEqual(discoverRuntime(libs, {}, (command) => command === 'claude'), { runtime: 'claude' })
    assert.deepEqual(discoverRuntime(libs, { MEFISTO_FAKE_AVAILABLE: '1' }, never), { runtime: 'fake' })
    assert.deepEqual(discoverRuntime(libs, {}, never), {
      error: 'no se detecto ningun runtime disponible entre los adaptadores (claude, fake, otro): fija MEFISTO_RUNTIME o --runtime',
    })
    assert.deepEqual(discoverRuntime(libs, { MEFISTO_FAKE_AVAILABLE: '1' }, () => true), {
      error: 'se detectaron varios runtimes disponibles (claude fake): fija MEFISTO_RUNTIME o --runtime para desambiguar',
    })
    assert.deepEqual(discoverRuntime(join(libs, 'no-existe'), {}, () => true), {
      error: 'no se detecto ningun runtime disponible entre los adaptadores (): fija MEFISTO_RUNTIME o --runtime',
    })
  })

  test('con los adaptadores del repo decide por el CLI de claude y MEFISTO_FAKE_AVAILABLE', async () => {
    const none = 'no se detecto ningun runtime disponible entre los adaptadores (claude, fake): fija MEFISTO_RUNTIME o --runtime'
    const both = 'se detectaron varios runtimes disponibles (claude fake): fija MEFISTO_RUNTIME o --runtime para desambiguar'
    const cases: [NodeJS.ProcessEnv, boolean, { runtime: string } | { error: string }][] = [
      [{}, true, { runtime: 'claude' }],
      [{}, false, { error: none }],
      [{ MEFISTO_FAKE_AVAILABLE: '1' }, true, { error: both }],
      [{ MEFISTO_FAKE_AVAILABLE: '1' }, false, { runtime: 'fake' }],
    ]
    for (const [env, withClaude, expected] of cases) {
      const has = (command: string): boolean => withClaude && command === 'claude'
      assert.deepEqual(discoverRuntime(LIB_DIR, env, has), expected)
      assert.deepEqual(await resolveRuntime('', env, has, LIB_DIR), expected)
    }
  })

  test('coincide con la resolucion que carga los adaptadores del repo', async () => {
    const cases: NodeJS.ProcessEnv[] = [{}, { MEFISTO_FAKE_AVAILABLE: '1' }, { PATH: '' }, { PATH: '', MEFISTO_FAKE_AVAILABLE: '1' }]
    for (const overrides of cases) {
      const env = { ...process.env, MEFISTO_RUNTIME: '', MEFISTO_FAKE_AVAILABLE: '', ...overrides }
      const has = (command: string): boolean => commandExists(command, env)
      assert.deepEqual(discoverRuntime(LIB_DIR, env, has), await resolveRuntime('', env, has, LIB_DIR))
    }
  })
})
