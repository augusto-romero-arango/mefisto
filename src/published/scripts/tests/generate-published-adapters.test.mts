// Motor publicado sobre repos temporales, un validador simulado y adaptadores de prueba; nunca
// toca el dist/ real.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CliError } from '../../../../scripts/lib/cli.mts'
import {
  TOOLING_CLOSURE_ASSETS,
  generatePublishedAdapters,
  loadAdapters,
  parseArgs,
} from '../generate-published-adapters.mts'
import type { ValidatorResult } from '../generate-published-adapters.mts'
import type { PublishedAdapter } from '../lib/published-adapter.mts'
import { createAdapter as alphaAdapter } from './fixtures/adapters/adapter-alpha.mts'
import { assetsAdapter } from './fixtures/adapters/adapter-assets.mts'
import { createAdapter as betaAdapter } from './fixtures/adapters/adapter-beta.mts'
import { manyAssetsAdapter } from './fixtures/adapters/adapter-many-assets.mts'

const HERE = import.meta.dirname
const SCRIPTS = join(HERE, '..')
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const WINDOWS = process.platform === 'win32'
const SOURCE = 'src/published/agents/valida con espacios.md'
const MARKDOWN = 'artefactos/valida con espacios.md'
const INVENTORY = '.mefisto-generated-assets.json'
const KNOWLEDGE = [
  'docs/adr/mef-adr-0011.md',
  'docs/adr/mef-adr-0053.md',
  'docs/testing/harness-cheatsheet.md',
]
const CLOSURE = TOOLING_CLOSURE_ASSETS.map((declared) => {
  const [source = '', mode = ''] = declared.split('|')
  return { source, mode }
})
const [FIRST_CLOSURE_SOURCE] = CLOSURE.map((asset) => asset.source)

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto generador ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const pathIn = (root: string, rel: string): string => join(root, ...rel.split('/'))

function writeIn(root: string, rel: string, content: string, mode?: number): void {
  const path = pathIn(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  if (mode !== undefined && !WINDOWS) chmodSync(path, mode)
}

const read = (root: string, rel: string): string => readFileSync(pathIn(root, rel), 'utf8')
const fileMode = (root: string, rel: string): number => statSync(pathIn(root, rel)).mode & 0o777
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Repo temporal con una fuente Markdown, toda la clausura declarada y el conocimiento TDD. */
function setupRepo(name: string): string {
  const repo = join(work, name)
  writeIn(repo, SOURCE, '---\n{}\n---\nfixture\n')
  for (const { source, mode } of CLOSURE) {
    writeIn(repo, source, mode === '0755' ? '#!/usr/bin/env bash\n' : 'fixture\n', Number.parseInt(mode, 8))
  }
  writeIn(repo, 'docs/adr/mef-adr-0011.md', 'ADR uno\n')
  writeIn(repo, 'docs/adr/mef-adr-0053.md', 'ADR dos\n')
  writeIn(repo, 'docs/adr/INDICE-TEMATICO.md', 'indice excluido\n')
  writeIn(repo, 'docs/testing/harness-cheatsheet.md', 'cheatsheet\n')
  writeIn(repo, 'docs/testing/otro.md', 'documento excluido\n')
  return repo
}

function addAssetSources(repo: string): void {
  writeIn(repo, 'src/published/assets/config.txt', 'configuracion fuente\n')
  writeIn(repo, 'src/published/assets/launcher.txt', 'launcher fuente\n')
}

interface Run {
  status: number
  /** Lineas de divergencia de `--check`. */
  out: string
  err: string
}

interface RunOptions {
  check?: boolean
  files?: string[]
  adapters?: PublishedAdapter[]
  /** Cuenta las invocaciones del validador simulado. */
  validations?: { count: number }
}

const baseAdapters = (): PublishedAdapter[] => [alphaAdapter(), betaAdapter()]

async function run(repo: string, out: string, options: RunOptions = {}): Promise<Run> {
  const lines: string[] = []
  const validate = (files: readonly string[]): ValidatorResult => {
    if (options.validations !== undefined) options.validations.count++
    const rejected = files.find((file) => file.includes('invalida'))
    return rejected === undefined
      ? { status: 0, output: '' }
      : { status: 1, output: `${rejected}: invalida\n` }
  }
  try {
    const status = await generatePublishedAdapters({
      check: options.check ?? false,
      outRoot: out,
      files: options.files ?? [pathIn(repo, SOURCE)],
      repoRoot: repo,
      adapters: options.adapters ?? baseAdapters(),
      validate,
      out: (line) => lines.push(line),
    })
    return { status, out: lines.join('\n'), err: '' }
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    return { status: error.exitCode, out: lines.join('\n'), err: error.message }
  }
}

interface InventoryAsset {
  adapter: string
  id: string
  source: string
  destination: string
  mode: string
  sha256: string
}

function inventory(out: string, runtime: string): { schemaVersion: number; assets: InventoryAsset[] } {
  return JSON.parse(read(out, `dist/${runtime}/${INVENTORY}`)) as {
    schemaVersion: number
    assets: InventoryAsset[]
  }
}

describe('shims', () => {
  const COMMANDS = [
    'generate-published-adapters',
    'validate-published-artifacts',
    'validate-published-mcp',
    'validate-interactive-hooks',
    'generate-claude-hooks',
  ]

  for (const command of COMMANDS) {
    test(`${command}.sh delega en su .mts`, () => {
      assert.equal(
        readFileSync(join(SCRIPTS, `${command}.sh`), 'utf8'),
        [
          '#!/usr/bin/env bash',
          `# Shim: la implementacion vive en ${command}.mts (MEF-ADR-0057). No editar.`,
          `exec node "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)/${command}.mts" "$@"`,
          '',
        ].join('\n'),
      )
      assert.ok(existsSync(join(SCRIPTS, `${command}.mts`)))
    })
  }

  test('los que se invocan por ruta conservan el bit de ejecucion', { skip: WINDOWS }, () => {
    for (const command of COMMANDS.filter((name) => name !== 'generate-claude-hooks')) {
      assert.notEqual(statSync(join(SCRIPTS, `${command}.sh`)).mode & 0o111, 0, command)
    }
  })
})

describe('argumentos', () => {
  test('separa opciones y fuentes', () => {
    assert.deepEqual(parseArgs(['--check', '--out', 'salida', 'a.md', 'b.md']), {
      check: true,
      outRoot: 'salida',
      files: ['a.md', 'b.md'],
    })
  })

  test('una opcion desconocida y un --out sin raiz fallan con exit 1', () => {
    assert.throws(
      () => parseArgs(['--desconocida']),
      new CliError('ERROR: opcion desconocida: --desconocida'),
    )
    assert.throws(() => parseArgs(['--out']), new CliError('ERROR: --out requiere una raiz'))
  })

  test('el comando termina en 1 con el diagnostico en stderr', () => {
    const result = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'generate-published-adapters.mts'), '--desconocida'],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: opcion desconocida: --desconocida\n')
    assert.equal(result.stdout, '')
  })
})

describe('dos adaptadores', () => {
  let repo = ''
  let out = ''
  const fresh = async (): Promise<void> => {
    assert.equal((await run(repo, out)).status, 0)
  }
  const check = (): Promise<Run> => run(repo, out, { check: true })

  before(async () => {
    repo = setupRepo('valido')
    out = join(work, 'salida con espacios')
    await fresh()
  })

  test('procesan la fuente y rutas con espacios', () => {
    assert.ok(existsSync(pathIn(out, `dist/alpha/${MARKDOWN}`)))
    assert.ok(existsSync(pathIn(out, `dist/beta/${MARKDOWN}`)))
  })

  test('el inventario atribuye Markdown, pipeline y conocimiento TDD con checksum', () => {
    const { assets } = inventory(out, 'alpha')
    assert.equal(assets.length, CLOSURE.length + KNOWLEDGE.length + 1)
    const markdown = assets.find((asset) => asset.adapter === 'adapter-alpha.mts')
    assert.deepEqual(
      { source: markdown?.source, destination: markdown?.destination, mode: markdown?.mode },
      { source: SOURCE, destination: MARKDOWN, mode: '0644' },
    )
    assert.equal(markdown?.sha256.length, 64)
    const pipeline = assets.find(
      (asset) => asset.adapter === 'tooling-closure' && asset.source === 'scripts/tdd-pipeline.sh',
    )
    assert.deepEqual(
      { destination: pipeline?.destination, mode: pipeline?.mode, digest: pipeline?.sha256.length },
      { destination: 'scripts/tdd-pipeline.sh', mode: '0755', digest: 64 },
    )
    assert.deepEqual(
      assets.filter((asset) => asset.adapter === 'tooling-knowledge').map((asset) => asset.source),
      KNOWLEDGE,
    )
  })

  test('el conocimiento TDD conserva sus bytes en ambos runtimes y excluye el resto de docs', () => {
    for (const runtime of ['alpha', 'beta']) {
      for (const source of ['docs/adr/mef-adr-0011.md', 'docs/testing/harness-cheatsheet.md']) {
        assert.equal(read(out, `dist/${runtime}/${source}`), read(repo, source))
      }
    }
    assert.ok(!existsSync(pathIn(out, 'dist/alpha/docs/adr/INDICE-TEMATICO.md')))
    assert.ok(!existsSync(pathIn(out, 'dist/alpha/docs/testing/otro.md')))
  })

  test('el conocimiento TDD se publica con modo 0644', { skip: WINDOWS }, () => {
    assert.equal(fileMode(out, 'dist/alpha/docs/adr/mef-adr-0011.md'), 0o644)
    assert.equal(fileMode(out, 'dist/beta/docs/testing/harness-cheatsheet.md'), 0o644)
  })

  test('el marcador puede ir despues del frontmatter', () => {
    assert.equal(
      read(out, `dist/beta/${MARKDOWN}`).split('\n')[3],
      `<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde ${SOURCE}. No editar a mano. -->`,
    )
  })

  test('--check informa salidas faltantes sin crear la raiz de salida', async () => {
    const missing = join(work, 'check no crea salida')
    assert.equal((await run(repo, missing, { check: true })).status, 1)
    assert.ok(!existsSync(missing))
  })

  test('--check al dia', async () => {
    assert.deepEqual(await check(), { status: 0, out: '', err: '' })
  })

  test('--check distinta', async () => {
    await fresh()
    appendFileSync(pathIn(out, `dist/alpha/${MARKDOWN}`), 'cambio\n')
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes(`dist/alpha/${MARKDOWN}: distinta`), result.out)
  })

  test('--check faltante', async () => {
    await fresh()
    rmSync(pathIn(out, `dist/beta/${MARKDOWN}`))
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes(`dist/beta/${MARKDOWN}: faltante`), result.out)
  })

  test('--check combina huerfanas y archivos sin marcador, y la escritura lo reconcilia', async () => {
    await fresh()
    writeIn(
      out,
      'dist/alpha/artefactos/huerfana.md',
      '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde x. No editar a mano. -->\n',
    )
    writeIn(out, 'dist/beta/artefactos/manual.md', 'manual\n')
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes('huerfana.md: huerfana'), result.out)
    assert.ok(result.out.includes('manual.md: sin marcador'), result.out)
    await fresh()
    assert.deepEqual(await check(), { status: 0, out: '', err: '' })
  })

  test('cada runtime atribuye su Markdown a su adaptador', () => {
    for (const runtime of ['alpha', 'beta']) {
      assert.ok(
        inventory(out, runtime).assets.some(
          (asset) => asset.adapter === `adapter-${runtime}.mts` && asset.destination === MARKDOWN,
        ),
        runtime,
      )
    }
  })

  test('los inventarios de clausura son identicos entre runtimes', () => {
    const closure = (runtime: string): InventoryAsset[] =>
      inventory(out, runtime).assets.filter((asset) => asset.adapter.startsWith('tooling-'))
    assert.deepEqual(closure('alpha'), closure('beta'))
  })

  test('--check detecta conocimiento divergente', async () => {
    await fresh()
    writeIn(out, 'dist/alpha/docs/adr/mef-adr-0011.md', 'ADR alterado\n')
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes('dist/alpha/docs/adr/mef-adr-0011.md: distinta'), result.out)
  })

  test('--check detecta el modo divergente del conocimiento', { skip: WINDOWS }, async () => {
    await fresh()
    chmodSync(pathIn(out, 'dist/beta/docs/testing/harness-cheatsheet.md'), 0o755)
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(
      result.out.includes('dist/beta/docs/testing/harness-cheatsheet.md: modo divergente'),
      result.out,
    )
  })

  test('--check detecta conocimiento faltante', async () => {
    await fresh()
    rmSync(pathIn(out, 'dist/alpha/docs/adr/mef-adr-0053.md'))
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes('dist/alpha/docs/adr/mef-adr-0053.md: faltante'), result.out)
  })

  test('--check detecta contenido divergente en la clausura', async () => {
    await fresh()
    appendFileSync(pathIn(out, 'dist/alpha/scripts/_pipeline-common.sh'), 'alterada\n')
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes('dist/alpha/scripts/_pipeline-common.sh: distinta'), result.out)
  })

  test('--check detecta el modo divergente en la clausura', { skip: WINDOWS }, async () => {
    await fresh()
    chmodSync(pathIn(out, 'dist/alpha/scripts/_pipeline-common.sh'), 0o644)
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes('dist/alpha/scripts/_pipeline-common.sh: modo divergente'), result.out)
  })

  test('--check rechaza un symlink en una salida de la clausura', { skip: WINDOWS }, async () => {
    await fresh()
    const published = pathIn(out, 'dist/alpha/scripts/_pipeline-common.sh')
    rmSync(published)
    symlinkSync(pathIn(repo, 'scripts/_pipeline-common.sh'), published)
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes('dist/alpha/scripts/_pipeline-common.sh: enlace simbolico'), result.out)
  })

  test('--check detecta un symlink huerfano', { skip: WINDOWS }, async () => {
    await fresh()
    symlinkSync(join(work, 'fuera-del-repo'), pathIn(out, 'dist/alpha/scripts/huerfano.sh'))
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes('dist/alpha/scripts/huerfano.sh: enlace simbolico'), result.out)
    await fresh()
  })

  // Va al final: retira una fuente del repo temporal.
  test('--check detecta conocimiento huerfano en ambos runtimes', async () => {
    await fresh()
    rmSync(pathIn(repo, 'docs/adr/mef-adr-0053.md'))
    const result = await check()
    assert.equal(result.status, 1)
    const alpha = result.out.indexOf('dist/alpha/docs/adr/mef-adr-0053.md: huerfana')
    const beta = result.out.indexOf('dist/beta/docs/adr/mef-adr-0053.md: huerfana')
    assert.ok(alpha !== -1 && beta > alpha, result.out)
  })
})

describe('assets suplementarios', () => {
  let repo = ''
  let out = ''
  const adapters = (scenario?: string): PublishedAdapter[] => [...baseAdapters(), assetsAdapter(scenario)]
  const fresh = async (): Promise<void> => {
    assert.equal((await run(repo, out, { adapters: adapters() })).status, 0)
  }
  const check = (scenario?: string): Promise<Run> =>
    run(repo, out, { check: true, adapters: adapters(scenario) })
  const CONFIG = 'dist/assets/runtime/config.json'
  const LAUNCHER = 'dist/assets/bin/launcher'
  const digest = (...files: string[]): string => files.map((file) => sha(pathIn(out, file))).join(' ')

  before(async () => {
    repo = setupRepo('assets')
    addAssetSources(repo)
    out = join(work, 'assets-out')
    await fresh()
  })

  test('se generan junto con el Markdown, desde su fuente', () => {
    assert.equal(read(out, CONFIG), 'renderizado:configuracion fuente\n')
  })

  test('un asset ejecutable conserva el modo 0755', { skip: WINDOWS }, () => {
    assert.equal(fileMode(out, LAUNCHER), 0o755)
  })

  test('el inventario es determinista y atribuye Markdown y assets', () => {
    const { schemaVersion, assets } = inventory(out, 'assets')
    assert.equal(schemaVersion, 1)
    assert.equal(assets.length, CLOSURE.length + KNOWLEDGE.length + 1 + 2)
    assert.equal(assets[0]?.source, 'src/published/assets/config.txt')
    assert.equal(assets[1]?.mode, '0755')
    assert.ok(assets.some((asset) => asset.source === SOURCE && asset.destination === MARKDOWN))
    assert.ok(assets.every((asset) => asset.sha256.length === 64))
  })

  test('--check acepta assets e inventario al dia', async () => {
    assert.deepEqual(await check(), { status: 0, out: '', err: '' })
  })

  test('--check detecta un asset distinto', async () => {
    await fresh()
    writeIn(out, CONFIG, 'alterado\n')
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes(`${CONFIG}: distinta`), result.out)
  })

  test('--check detecta un asset faltante', async () => {
    await fresh()
    rmSync(pathIn(out, CONFIG))
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes(`${CONFIG}: faltante`), result.out)
  })

  test('--check detecta un modo divergente', { skip: WINDOWS }, async () => {
    await fresh()
    chmodSync(pathIn(out, LAUNCHER), 0o644)
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes(`${LAUNCHER}: modo divergente`), result.out)
  })

  test('--check detecta un inventario inconsistente', async () => {
    await fresh()
    writeIn(out, `dist/assets/${INVENTORY}`, '{"schemaVersion":0,"assets":[]}')
    const result = await check()
    assert.equal(result.status, 1)
    assert.ok(result.out.includes(`dist/assets/${INVENTORY}: inventario inconsistente`), result.out)
  })

  test('--check detecta un asset huerfano por el inventario ya publicado', async () => {
    await fresh()
    const result = await check('uno')
    assert.equal(result.status, 1)
    assert.ok(result.out.includes(`${LAUNCHER}: huerfana`), result.out)
  })

  test('assets e inventario son deterministas', async () => {
    await fresh()
    const first = digest(`dist/assets/${INVENTORY}`, CONFIG)
    await fresh()
    assert.equal(digest(`dist/assets/${INVENTORY}`, CONFIG), first)
  })

  test('un fallo de render conserva intactas todas las raices previas', async () => {
    await fresh()
    const published = [`dist/assets/${INVENTORY}`, CONFIG, LAUNCHER]
    const previous = digest(...published)
    const result = await run(repo, out, { adapters: adapters('render-fallar') })
    assert.equal(result.status, 1)
    assert.equal(digest(...published), previous)
  })
})

describe('assets rechazados antes de publicar', () => {
  const REJECTIONS: Record<string, string> = {
    colision: `ERROR: adapter-assets.mts asset 'colision' colisiona con salida agent/command: dist/assets/${MARKDOWN}`,
    'colision-anidada': `ERROR: adapter-assets.mts asset 'colision' colisiona con salida agent/command: dist/assets/${MARKDOWN}/hijo`,
    duplicado: "ERROR: adapter-assets.mts asset 'repetido' repite un id",
    'mismo-destino':
      "ERROR: adapter-assets.mts asset 'dos' colisiona en destino con otro asset: dist/assets/repetido",
    'destinos-anidados':
      "ERROR: adapter-assets.mts asset 'dos' colisiona en destino con otro asset: dist/assets/repetido/hijo",
    inventario: `ERROR: adapter-assets.mts asset 'inventario' colisiona con el inventario del motor: dist/assets/${INVENTORY}`,
    inseguro: "ERROR: adapter-assets.mts asset 'inseguro' declaro una fuente insegura",
    'id-inseguro': "ERROR: adapter-assets.mts asset '../inseguro' declaro un id inseguro",
    'destino-inseguro': "ERROR: adapter-assets.mts asset 'inseguro' declaro un destino inseguro",
    ausente:
      "ERROR: adapter-assets.mts asset 'ausente' declaro una fuente ausente: src/published/assets/no-existe",
    symlink:
      "ERROR: adapter-assets.mts asset 'symlink' declaro una fuente fuera del repositorio mediante symlink: src/published/assets/link",
    modo: "ERROR: adapter-assets.mts asset 'modo' declaro un modo desconocido: 0600",
    invalido: 'ERROR: adapter-assets.mts declaro assets suplementarios invalidos',
    fallar:
      'ERROR: adapter-assets.mts no pudo enumerar assets suplementarios\nadapter-assets.mts: fallo al enumerar assets',
    'render-fallar':
      "adapter-assets.mts: fallo al renderizar asset\nERROR: adapter-assets.mts no pudo renderizar el asset 'config'; no se escribio nada",
  }

  for (const [scenario, expected] of Object.entries(REJECTIONS)) {
    test(`asset ${scenario}`, { skip: WINDOWS && scenario === 'symlink' }, async () => {
      const repo = setupRepo(`asset-${scenario}`)
      addAssetSources(repo)
      if (scenario === 'symlink') {
        writeIn(work, 'fuera-del-repo', 'fuera\n')
        symlinkSync(join(work, 'fuera-del-repo'), pathIn(repo, 'src/published/assets/link'))
      }
      const out = join(work, `asset-${scenario}-out`)
      const result = await run(repo, out, { adapters: [...baseAdapters(), assetsAdapter(scenario)] })
      assert.deepEqual({ status: result.status, err: result.err }, { status: 1, err: expected })
      assert.ok(!existsSync(out), 'no deja salida parcial')
    })
  }
})

describe('rechazos sin salida parcial', () => {
  test('el validador rechaza antes de crear la salida', async () => {
    const repo = setupRepo('invalida')
    const out = join(work, 'invalida-out')
    const file = pathIn(repo, 'src/published/agents/invalida.md')
    const result = await run(repo, out, { files: [file] })
    assert.deepEqual({ status: result.status, err: result.err }, { status: 1, err: `${file}: invalida` })
    assert.ok(!existsSync(out))
  })

  test('una fuente de la clausura ausente identifica su ruta exacta', async () => {
    const repo = setupRepo('clausura-ausente')
    const out = join(work, 'clausura-ausente-out')
    rmSync(pathIn(repo, FIRST_CLOSURE_SOURCE ?? ''))
    const result = await run(repo, out)
    assert.deepEqual(
      { status: result.status, err: result.err },
      {
        status: 1,
        err: `ERROR: tooling-closure declaro una fuente ausente o no regular: ${FIRST_CLOSURE_SOURCE}`,
      },
    )
    assert.ok(!existsSync(out))
  })

  test('una fuente de la clausura que no es un archivo regular identifica su ruta exacta', async () => {
    const repo = setupRepo('clausura-no-regular')
    const out = join(work, 'clausura-no-regular-out')
    rmSync(pathIn(repo, FIRST_CLOSURE_SOURCE ?? ''))
    mkdirSync(pathIn(repo, FIRST_CLOSURE_SOURCE ?? ''))
    const result = await run(repo, out)
    assert.equal(result.status, 1)
    assert.ok(result.err.includes(FIRST_CLOSURE_SOURCE ?? ''), result.err)
    assert.ok(!existsSync(out))
  })

  test('la desaparicion total de los ADRs produce un diagnostico accionable', async () => {
    const repo = setupRepo('conocimiento-ausente')
    const out = join(work, 'conocimiento-ausente-out')
    for (const name of readdirSync(pathIn(repo, 'docs/adr'))) {
      if (name.startsWith('mef-adr-')) rmSync(pathIn(repo, `docs/adr/${name}`))
    }
    const result = await run(repo, out)
    assert.deepEqual(
      { status: result.status, err: result.err },
      { status: 1, err: 'ERROR: tooling-knowledge no descubrio ningun docs/adr/mef-adr-*.md' },
    )
    assert.ok(!existsSync(out))
  })

  test('el fallo del segundo adaptador conserva intacta la salida anterior', async () => {
    const repo = setupRepo('fallo')
    const out = join(work, 'fallo-out')
    assert.equal((await run(repo, out)).status, 0)
    const artifacts = ['alpha', 'beta'].map((runtime) => pathIn(out, `dist/${runtime}/${MARKDOWN}`))
    const previous = artifacts.map(sha)
    const failing = pathIn(repo, 'src/published/agents/fallar.md')
    copyFileSync(pathIn(repo, SOURCE), failing)
    const result = await run(repo, out, { files: [failing] })
    assert.deepEqual(
      { status: result.status, err: result.err },
      {
        status: 1,
        err: "fallo fixture beta\nERROR: adapter-beta.mts no pudo renderizar 'src/published/agents/fallar.md'; no se escribio nada",
      },
    )
    assert.deepEqual(artifacts.map(sha), previous)
    assert.ok(!existsSync(pathIn(out, 'dist/alpha/artefactos/fallar.md')))
  })

  test('sin adaptadores, una fuente explicita falla y un repo sin fuentes termina verde', async () => {
    const repo = setupRepo('sin-adaptadores')
    const explicit = await run(repo, join(work, 'sin-adaptadores-out'), { adapters: [] })
    assert.deepEqual(
      { status: explicit.status, err: explicit.err },
      {
        status: 1,
        err: 'ERROR: no hay adapter-<runtime>.mts registrados para renderizar fuentes explicitas',
      },
    )
    rmSync(pathIn(repo, SOURCE))
    const empty = await run(repo, join(work, 'sin-adaptadores-vacio'), { adapters: [], files: [] })
    assert.deepEqual(empty, { status: 0, out: '', err: '' })
    assert.ok(!existsSync(join(work, 'sin-adaptadores-vacio')))
  })

  test('una fuente fuera del repositorio se rechaza', async () => {
    const repo = setupRepo('fuente-ajena')
    writeIn(work, 'ajena.md', '---\n{}\n---\nfixture\n')
    const result = await run(repo, join(work, 'fuente-ajena-out'), { files: [join(work, 'ajena.md')] })
    assert.deepEqual(
      { status: result.status, err: result.err },
      { status: 1, err: 'ERROR: fuente fuera del repositorio' },
    )
  })
})

describe('generacion', () => {
  test('es determinista sin depender del mtime de la fuente', async () => {
    const repo = setupRepo('determinismo')
    const out = join(work, 'determinismo')
    const artifacts = ['alpha', 'beta'].map((runtime) => pathIn(out, `dist/${runtime}/${MARKDOWN}`))
    assert.equal((await run(repo, out)).status, 0)
    const first = artifacts.map(sha)
    const later = new Date(Date.now() + 60_000)
    utimesSync(pathIn(repo, SOURCE), later, later)
    assert.equal((await run(repo, out)).status, 0)
    assert.deepEqual(artifacts.map(sha), first)
  })

  test('sin fuentes explicitas valida una vez y cubre agents y commands', async () => {
    const repo = setupRepo('orden-default')
    const out = join(work, 'orden-default')
    writeIn(repo, 'src/published/commands/zeta.md', read(repo, SOURCE))
    writeIn(repo, 'src/published/agents/alfa.md', read(repo, SOURCE))
    const validations = { count: 0 }
    assert.equal((await run(repo, out, { files: [], validations })).status, 0)
    assert.equal(validations.count, 1)
    assert.ok(existsSync(pathIn(out, 'dist/alpha/artefactos/alfa.md')))
    assert.ok(existsSync(pathIn(out, 'dist/alpha/artefactos/zeta.md')))
  })

  // Umbral generoso a proposito (issue #1499): con una deteccion de colisiones cuadratica en
  // procesos esto tardaba minutos.
  test('un adaptador con 160 assets se comprueba muy por debajo del limite', async () => {
    const limitSeconds = Number(process.env.MEFISTO_ASSETS_PERF_LIMIT ?? '20')
    const repo = setupRepo('muchos-assets')
    writeIn(repo, 'src/published/assets/config.txt', 'configuracion fuente\n')
    const out = join(work, 'muchos-assets-out')
    const adapters = [...baseAdapters(), manyAssetsAdapter(160)]
    assert.equal((await run(repo, out, { adapters })).status, 0)
    assert.ok(inventory(out, 'many').assets.length >= 160)
    const start = performance.now()
    const result = await run(repo, out, { check: true, adapters })
    const elapsedSeconds = (performance.now() - start) / 1000
    assert.deepEqual(result, { status: 0, out: '', err: '' })
    assert.ok(
      elapsedSeconds < limitSeconds,
      `--check tardo ${elapsedSeconds.toFixed(2)}s (limite ${limitSeconds}s)`,
    )
  })
})

describe('descubrimiento de adaptadores', () => {
  test('carga los adapter-*.mts de la carpeta en orden por bytes', async () => {
    const adapters = await loadAdapters(join(HERE, 'fixtures', 'adapters'), REPO_ROOT)
    assert.deepEqual(
      adapters.map((adapter) => [adapter.name, adapter.root()]),
      [
        ['adapter-alpha.mts', 'dist/alpha'],
        ['adapter-assets.mts', 'dist/assets'],
        ['adapter-beta.mts', 'dist/beta'],
        ['adapter-many-assets.mts', 'dist/many'],
      ],
    )
  })

  test('el unico adaptador registrado es el de Claude', async () => {
    const adapters = await loadAdapters(join(SCRIPTS, 'adapters'), REPO_ROOT)
    assert.deepEqual(
      adapters.map((adapter) => [adapter.name, adapter.root()]),
      [['adapter-claude.sh', 'dist/claude']],
    )
  })

  test('un modulo sin fabrica se rechaza y una carpeta ausente no aporta adaptadores', async () => {
    const dir = join(work, 'adaptadores rotos')
    writeIn(dir, 'adapter-roto.mts', 'export const otro = 1\n')
    writeIn(dir, 'no-es-adaptador.mts', 'export const otro = 1\n')
    await assert.rejects(
      loadAdapters(dir, REPO_ROOT),
      new CliError('ERROR: adaptador no ejecutable: adapter-roto.mts'),
    )
    assert.deepEqual(await loadAdapters(join(work, 'no-existe'), REPO_ROOT), [])
  })

  test('raices inseguras, fuera de dist/ o anidadas se rechazan', async () => {
    const repo = setupRepo('raices')
    const rooted = (name: string, root: string): PublishedAdapter => ({
      ...alphaAdapter(),
      name,
      root: () => root,
    })
    const cases: [PublishedAdapter[], string][] = [
      [[rooted('uno', '../fuera')], 'ERROR: uno declaro una raiz insegura'],
      [[rooted('uno', 'otra/alpha')], 'ERROR: uno debe declarar una raiz dist/<runtime>'],
      [
        [rooted('uno', 'dist/alpha'), rooted('dos', 'dist/alpha/hija')],
        'ERROR: dos declaro una raiz duplicada o anidada: dist/alpha/hija',
      ],
    ]
    for (const [adapters, expected] of cases) {
      const result = await run(repo, join(work, 'raices-out'), { adapters })
      assert.deepEqual({ status: result.status, err: result.err }, { status: 1, err: expected })
    }
  })
})

describe('clausura declarada', () => {
  test('cada entrada es `ruta|modo`, sin repetidos', () => {
    for (const declared of TOOLING_CLOSURE_ASSETS) assert.match(declared, /^[^'|]+\|(0644|0755)$/)
    assert.equal(new Set(CLOSURE.map((asset) => asset.source)).size, CLOSURE.length)
  })

  test('declara los scripts que arrancan el TDD publicado', () => {
    const sources = CLOSURE.map((asset) => asset.source)
    assert.ok(sources.includes('scripts/tdd-pipeline.sh'))
    assert.ok(sources.includes('src/runtime/lib/mefisto-process.sh'))
  })
})

/** Fuentes con expresiones GitHub Actions y los espejos que no conservan su conteo (#2052). */
function expressionMirrors(root: string): { evaluated: number; failures: string[] } {
  const count = (path: string): number =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('${{')).length
  const failures: string[] = []
  let evaluated = 0
  for (const kind of ['agents', 'commands']) {
    const dir = join(root, 'src', 'published', kind)
    for (const name of existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith('.md')) : []) {
      const expected = count(join(dir, name))
      if (expected === 0) continue
      evaluated++
      for (const mirror of [`${kind}/${name}`, `dist/claude/${kind}/${name}`]) {
        if (!existsSync(pathIn(root, mirror))) failures.push(`${name}: espejo ${mirror} ausente`)
        else {
          const found = count(pathIn(root, mirror))
          if (found !== expected) {
            failures.push(`${name}: espejo ${mirror} tiene ${found} expresiones, la fuente ${expected}`)
          }
        }
      }
    }
  }
  return { evaluated, failures }
}

describe('arbol real', () => {
  test('la distribucion publicada esta al dia', async () => {
    const lines: string[] = []
    const status = await generatePublishedAdapters({
      check: true,
      outRoot: REPO_ROOT,
      files: [],
      out: (line) => lines.push(line),
    })
    assert.deepEqual({ status, lines }, { status: 0, lines: [] })
  })

  test('fuente y espejos conservan el mismo conteo de expresiones GitHub Actions', () => {
    const { evaluated, failures } = expressionMirrors(REPO_ROOT)
    assert.ok(evaluated > 0, 'ninguna fuente con expresiones GitHub Actions evaluada')
    assert.deepEqual(failures, [])
  })

  test('un espejo con una expresion menos se detecta con su archivo y su espejo', () => {
    const copy = join(work, 'expr-neg')
    const source = read(REPO_ROOT, 'src/published/agents/domain-scaffolder.md')
    const mirrors = ['src/published/agents', 'agents', 'dist/claude/agents']
    for (const dir of mirrors) writeIn(copy, `${dir}/domain-scaffolder.md`, source)
    assert.deepEqual(expressionMirrors(copy), { evaluated: 1, failures: [] })
    const lines = source.split('\n')
    lines.splice(
      lines.findIndex((line) => line.includes('${{')),
      1,
    )
    writeIn(copy, 'dist/claude/agents/domain-scaffolder.md', lines.join('\n'))
    const { failures } = expressionMirrors(copy)
    assert.equal(failures.length, 1)
    assert.match(failures[0] ?? '', /domain-scaffolder\.md.*dist\/claude\/agents\/domain-scaffolder\.md/)
  })
})
