import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture } from '../lib/cli.mts'
import { verifyPackageRoot } from '../verify-package-root.mts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-package-root.mts')
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

let work = ''
let count = 0

function root(plugin: unknown, manifest: unknown): string {
  const dir = join(work, `raiz con espacios ${++count}`)
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  if (plugin !== undefined) {
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), typeof plugin === 'string' ? plugin : JSON.stringify(plugin))
  }
  if (manifest !== undefined) {
    writeFileSync(join(dir, 'mefisto-manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  return dir
}

const plugin = (version = '1.2.3', name = 'mefisto'): Record<string, unknown> => ({ name, version })
const manifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  runtime: 'claude',
  version: '1.2.3',
  commit: COMMIT,
  ...overrides,
})

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto-raiz-'))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('verifyPackageRoot', () => {
  test('acepta una raiz cuyo plugin y manifiesto describen el mismo paquete', () => {
    assert.equal(verifyPackageRoot(root(plugin(), manifest())), true)
    assert.equal(
      verifyPackageRoot(root(plugin('1.2.3-rc.1+build.5'), manifest({ version: '1.2.3-rc.1+build.5' }))),
      true,
    )
  })

  test('rechaza un plugin ausente, ilegible, ajeno o sin version semver', () => {
    assert.equal(verifyPackageRoot(root(undefined, manifest())), false)
    assert.equal(verifyPackageRoot(root('{\n', manifest())), false)
    assert.equal(verifyPackageRoot(root('[]', manifest())), false)
    assert.equal(verifyPackageRoot(root(plugin('1.2.3', 'otro'), manifest())), false)
    for (const version of ['version-invalida', '1.2', '01.2.3', '1.2.3-', 'v1.2.3']) {
      assert.equal(verifyPackageRoot(root(plugin(version), manifest({ version }))), false, version)
    }
    assert.equal(verifyPackageRoot(root({ name: 'mefisto', version: 1 }, manifest())), false)
  })

  test('rechaza un manifiesto ausente, ilegible o de otro paquete', () => {
    assert.equal(verifyPackageRoot(root(plugin(), undefined)), false)
    assert.equal(verifyPackageRoot(root(plugin(), '{\n')), false)
    assert.equal(verifyPackageRoot(root(plugin(), manifest({ runtime: 'fake' }))), false)
    assert.equal(verifyPackageRoot(root(plugin(), manifest({ schemaVersion: 2 }))), false)
    assert.equal(verifyPackageRoot(root(plugin(), manifest({ version: '1.2.4' }))), false)
    assert.equal(verifyPackageRoot(root(plugin(), manifest({ commit: 'abc' }))), false)
    assert.equal(verifyPackageRoot(root(plugin(), manifest({ commit: COMMIT.toUpperCase() }))), false)
  })

  test('exige exactamente las cuatro claves del manifiesto', () => {
    assert.equal(verifyPackageRoot(root(plugin(), manifest({ extra: true }))), false)
    assert.equal(verifyPackageRoot(root(plugin(), { schemaVersion: 1, runtime: 'claude', version: '1.2.3' })), false)
  })

  test('una raiz que no existe se rechaza', () => {
    assert.equal(verifyPackageRoot(join(work, 'no-existe')), false)
  })
})

describe('linea de comando', () => {
  test('sale con 0 o 1 y no imprime nada', () => {
    const good = capture('node', [SCRIPT, root(plugin(), manifest())])
    assert.deepEqual([good.status, good.stdout, good.stderr], [0, '', ''])
    const bad = capture('node', [SCRIPT, root(plugin('1.2.3', 'otro'), manifest())])
    assert.deepEqual([bad.status, bad.stdout, bad.stderr], [1, '', ''])
    assert.equal(capture('node', [SCRIPT]).status, 1)
  })
})
