import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { USAGE, harnessConfigPath } from '../harness-config-path.mts'
import { DIST_SCRIPTS, SCRIPTS, assertDistributed } from './azure-cli-sandbox.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import { git } from './plugin-sandbox.mts'

const VALID = {
  projectName: 'Ejemplo',
  namespacePrefix: 'Ejemplo',
  solutionFile: 'Ejemplo.slnx',
  domainLabels: ['ventas'],
  boundedContext: { name: 'Principal', domains: ['ventas'] },
}

let work = ''
let serial = 0
let restoreGit = (): void => {}

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto config-path ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

function repo(configs: { canonical?: unknown; legacy?: unknown } = {}): string {
  const dir = join(work, `repo-${++serial}`)
  mkdirSync(dir, { recursive: true })
  for (const [folder, content] of [
    ['.mefisto', configs.canonical],
    ['.claude', configs.legacy],
  ] as const) {
    if (content === undefined) continue
    mkdirSync(join(dir, folder), { recursive: true })
    writeFileSync(join(dir, folder, 'harness.config.json'), `${JSON.stringify(content, null, 2)}\n`)
  }
  return dir
}

function run(argv: string[], cwd = work): { status: number; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const status = harnessConfigPath(argv, { cwd, out: (line) => out.push(line), err: (line) => err.push(line) })
  return { status, out, err }
}

const canonicalOf = (dir: string): string => join(dir, '.mefisto', 'harness.config.json')
const legacyOf = (dir: string): string => join(dir, '.claude', 'harness.config.json')

describe('harness-config-path', () => {
  test('write imprime la ruta canonica aunque no exista', () => {
    const dir = repo()
    assert.deepEqual(run(['write', dir]), { status: 0, out: [canonicalOf(dir)], err: [] })
  })

  test('read prefiere la canonica y avisa si tambien hay legacy', () => {
    const dir = repo({ canonical: VALID, legacy: VALID })
    const result = run(['read', dir])
    assert.equal(result.status, 0)
    assert.deepEqual(result.out, [canonicalOf(dir)])
    assert.match(result.err.join('\n'), /se ignora el legacy/)
  })

  test('read y valid caen a la legacy cuando falta la canonica', () => {
    const dir = repo({ legacy: VALID })
    assert.deepEqual(run(['read', dir]), { status: 0, out: [legacyOf(dir)], err: [] })
    assert.deepEqual(run(['valid', dir]), { status: 0, out: [legacyOf(dir)], err: [] })
  })

  test('valid imprime la ruta solo si el config es valido', () => {
    const dir = repo({ canonical: VALID })
    assert.deepEqual(run(['valid', dir]), { status: 0, out: [canonicalOf(dir)], err: [] })

    const broken = repo({ canonical: { ...VALID, projectName: '' } })
    const result = run(['valid', broken])
    assert.equal(result.status, 1)
    assert.deepEqual(result.out, [])
    assert.match(result.err.join('\n'), /campos obligatorios ausentes en .*: projectName/)
  })

  test('valid y read fallan sin ningun config', () => {
    const dir = repo()
    for (const mode of ['read', 'valid']) {
      const result = run([mode, dir])
      assert.equal(result.status, 1, mode)
      assert.deepEqual(result.out, [], mode)
      assert.match(result.err.join('\n'), /no se encontro el config canonico requerido/, mode)
    }
  })

  test('sin raiz parte de la raiz Git del directorio actual', () => {
    const dir = repo({ canonical: VALID })
    git(dir, 'init', '--quiet', '.')
    mkdirSync(join(dir, 'src'))
    assert.deepEqual(run(['valid'], join(dir, 'src')), { status: 0, out: [canonicalOf(dir)], err: [] })
  })

  test('una raiz que no existe es error', () => {
    const missing = join(work, 'no-existe')
    assert.deepEqual(run(['write', missing]), {
      status: 1,
      out: [],
      err: [`ERROR: la raiz de repositorio no existe: ${missing}`],
    })
  })

  test('uso invalido sale con 2', () => {
    for (const argv of [[], ['otro'], ['write', 'a', 'b']]) {
      assert.deepEqual(run(argv), { status: 2, out: [], err: [USAGE] }, argv.join(' '))
    }
  })
})

describe('distribucion', () => {
  test('dist/claude trae el script identico a scripts/ y lo inventaria', () => {
    assertDistributed(['harness-config-path.mts', 'lib/harness-config.mts'])
  })

  test('la copia de dist corre como proceso', () => {
    const dir = repo({ canonical: VALID })
    for (const scripts of [SCRIPTS, DIST_SCRIPTS]) {
      const result = spawnSync(process.execPath, [join(scripts, 'harness-config-path.mts'), 'valid', dir], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, `${canonicalOf(dir)}\n`)
    }
  })
})
