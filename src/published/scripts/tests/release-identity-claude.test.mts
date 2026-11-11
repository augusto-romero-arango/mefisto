// Identidad Claude: fuente neutral cerrada y el manifiesto que el adaptador deriva de ella.

import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CliError } from '../../../../scripts/lib/cli.mts'
import { createAdapter, releaseManifest } from '../adapters/adapter-claude.mts'
import { generatePublishedAdapters } from '../generate-published-adapters.mts'
import { AdapterError } from '../lib/published-adapter.mts'

const HERE = import.meta.dirname
const REPO_ROOT = realpathSync.native(join(HERE, '..', '..', '..', '..'))
const IDENTITY = join(REPO_ROOT, 'src', 'published', 'release-identity.json')
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST = 'dist/claude/mefisto-manifest.json'
const INVENTORY = 'dist/claude/.mefisto-generated-assets.json'
const WINDOWS = process.platform === 'win32'

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto identidad claude ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const identity = (fields: Record<string, unknown>): string => `${JSON.stringify(fields)}\n`

describe('fuente neutral', () => {
  test('el bootstrap cerrado coincide con la identidad vigente', () => {
    const declared = JSON.parse(readFileSync(IDENTITY, 'utf8')) as Record<string, unknown>
    const plugin = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      version: string
    }
    assert.deepEqual(Object.keys(declared).sort(), ['commit', 'schemaVersion', 'version'])
    assert.equal(declared.schemaVersion, 1)
    assert.equal(declared.version, plugin.version)
    assert.match(String(declared.version), /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/)
    assert.match(String(declared.commit), /^[0-9a-f]{40}$/)
  })
})

describe('asset suplementario', () => {
  let fake = ''
  let source = ''
  const render = (path = source): string => releaseManifest(path, fake)
  const SNAPSHOT = `{"schemaVersion":1,"runtime":"claude","version":"1.2.3","commit":"${COMMIT}"}\n`

  before(() => {
    fake = join(work, 'repo con espacios')
    source = join(fake, 'src', 'published', 'release-identity.json')
    write(join(fake, '.claude-plugin', 'plugin.json'), '{"name":"mefisto","version":"1.2.3"}\n')
  })

  test('Claude declara el asset suplementario exacto', () => {
    assert.deepEqual(createAdapter({ repoRoot: fake }).assets?.(), [
      {
        id: 'mefisto-manifest',
        source: 'src/published/release-identity.json',
        destination: 'mefisto-manifest.json',
        mode: '0644',
      },
    ])
  })

  test('renderiza el manifiesto y solo conoce ese asset', () => {
    write(source, identity({ schemaVersion: 1, version: '1.2.3', commit: COMMIT }))
    const adapter = createAdapter({ repoRoot: fake })
    assert.equal(adapter.renderAsset?.('mefisto-manifest', source), SNAPSHOT)
    assert.throws(
      () => adapter.renderAsset?.('otro', source),
      new AdapterError('render-asset: asset desconocido: otro'),
    )
  })

  test('consume la fuente recibida por la interfaz', () => {
    write(source, identity({ schemaVersion: 1, version: '1.2.3', commit: COMMIT }))
    const alternative = join(fake, 'identidad alternativa.json')
    copyFileSync(source, alternative)
    write(source, identity({ schemaVersion: 1, version: 'rota', commit: COMMIT }))
    assert.equal(render(alternative), SNAPSHOT)
  })

  const INVALID = 'release-identity.json: schema, version o commit invalidos'
  const REJECTED: [string, Record<string, unknown>, string][] = [
    ['SemVer invalido', { schemaVersion: 1, version: 'version-invalida', commit: COMMIT }, INVALID],
    [
      'identificador numerico SemVer con cero inicial',
      { schemaVersion: 1, version: '1.2.3-01', commit: COMMIT },
      INVALID,
    ],
    ['SHA invalido', { schemaVersion: 1, version: '1.2.3', commit: 'corto' }, INVALID],
    ['schemaVersion invalido', { schemaVersion: 2, version: '1.2.3', commit: COMMIT }, INVALID],
    ['campo obligatorio ausente', { schemaVersion: 1, version: '1.2.3' }, INVALID],
    ['campo extra', { schemaVersion: 1, version: '1.2.3', commit: COMMIT, extra: true }, INVALID],
    [
      'version divergente de plugin',
      { schemaVersion: 1, version: '2.0.0', commit: COMMIT },
      'release-identity.json: version distinta de .claude-plugin/plugin.json',
    ],
  ]

  for (const [label, fields, expected] of REJECTED) {
    test(`${label} aborta`, () => {
      write(source, identity(fields))
      assert.throws(() => render(), new AdapterError(expected))
    })
  }

  test('fuente ausente aborta', () => {
    rmSync(source, { force: true })
    assert.throws(() => render(), new AdapterError('release-identity.json: fuente ausente o no regular'))
  })
})

describe('integracion con el generador', () => {
  let out = ''
  const agent = join(REPO_ROOT, 'src', 'published', 'agents', 'tooling-reviewer.md')
  const published = (rel: string): string => join(out, ...rel.split('/'))

  async function generate(check = false): Promise<{ status: number; lines: string[] }> {
    const lines: string[] = []
    try {
      const status = await generatePublishedAdapters({
        check,
        outRoot: out,
        files: [agent],
        out: (line) => lines.push(line),
      })
      return { status, lines }
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      return { status: error.exitCode, lines: [error.message] }
    }
  }

  const divergences = async (): Promise<string[]> => {
    const result = await generate(true)
    assert.equal(result.status, 1)
    return result.lines
  }

  before(async () => {
    out = join(work, 'salida Claude con espacios')
    assert.deepEqual(await generate(), { status: 0, lines: [] })
  })

  test('el generador renderiza el manifiesto desde la identidad neutral', () => {
    const { schemaVersion, version, commit } = JSON.parse(readFileSync(IDENTITY, 'utf8')) as Record<
      string,
      unknown
    >
    assert.deepEqual(JSON.parse(readFileSync(published(MANIFEST), 'utf8')), {
      schemaVersion,
      runtime: 'claude',
      version,
      commit,
    })
  })

  test('el manifiesto tiene modo 0644', { skip: WINDOWS }, () => {
    assert.equal(statSync(published(MANIFEST)).mode & 0o777, 0o644)
  })

  test('el inventario atribuye el manifiesto a su fuente', () => {
    const { assets } = JSON.parse(readFileSync(published(INVENTORY), 'utf8')) as {
      assets: Record<string, string>[]
    }
    const manifest = assets.filter(
      (asset) => asset.adapter === 'adapter-claude.sh' && asset.id === 'mefisto-manifest',
    )
    assert.equal(manifest.length, 1)
    assert.deepEqual(
      [manifest[0]?.source, manifest[0]?.destination, manifest[0]?.mode],
      ['src/published/release-identity.json', 'mefisto-manifest.json', '0644'],
    )
  })

  test('--check acepta contenido, modo e inventario al dia', async () => {
    assert.deepEqual(await generate(true), { status: 0, lines: [] })
  })

  test('la generacion repetida es determinista y no modifica la fuente', async () => {
    const snapshot = (): string[] => [MANIFEST, INVENTORY].map((rel) => readFileSync(published(rel), 'utf8'))
    const source = readFileSync(IDENTITY, 'utf8')
    const first = snapshot()
    assert.deepEqual(await generate(), { status: 0, lines: [] })
    assert.deepEqual(snapshot(), first)
    assert.equal(readFileSync(IDENTITY, 'utf8'), source)
  })

  test('--check detecta el modo divergente del manifiesto', { skip: WINDOWS }, async () => {
    await generate()
    chmodSync(published(MANIFEST), 0o600)
    assert.ok((await divergences()).includes(`${MANIFEST}: modo divergente`))
  })

  test('--check detecta el inventario del manifiesto divergente', async () => {
    await generate()
    const inventory = JSON.parse(readFileSync(published(INVENTORY), 'utf8')) as Record<string, unknown>
    writeFileSync(published(INVENTORY), `${JSON.stringify({ ...inventory, assets: [] }, null, 2)}\n`)
    assert.ok((await divergences()).includes(`${INVENTORY}: inventario inconsistente`))
  })

  test('--check detecta un manifiesto divergente, que no lleva marcador', async () => {
    await generate()
    writeFileSync(published(MANIFEST), 'corrupto\n')
    assert.ok((await divergences()).includes(`${MANIFEST}: distinta`))
  })

  test('--check detecta el manifiesto faltante', async () => {
    await generate()
    rmSync(published(MANIFEST))
    assert.ok((await divergences()).includes(`${MANIFEST}: faltante`))
  })
})
