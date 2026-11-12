import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { git, isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import { getHarnessSha, getHarnessVersion, mefistoRoot } from '../../../src/internal/scripts/lib/mefisto-harness-version.mts'
import { REPO_ROOT } from './mefisto-agents-fixtures.mts'

let tmp = ''
let fixture = ''
let pluginJson = ''
let repo = ''
let emptyRepo = ''
let outside = ''
let restoreGit = (): void => {}
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mefisto version '))
  restoreGit = isolateGitConfig(tmp)
  // Sin tope, git subiria desde la carpeta temporal hasta un repo que la contenga.
  process.env.GIT_CEILING_DIRECTORIES = tmp
  fixture = join(tmp, 'fixture')
  pluginJson = join(fixture, '.claude-plugin', 'plugin.json')
  mkdirSync(join(fixture, '.claude-plugin'), { recursive: true })

  repo = join(tmp, 'repo con commit')
  emptyRepo = join(tmp, 'repo vacio')
  outside = join(tmp, 'sin repo')
  for (const dir of [repo, emptyRepo, outside]) mkdirSync(dir)
  git(repo, 'init', '-q')
  git(repo, '-c', 'user.email=test@mefisto.local', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'inicial')
  git(emptyRepo, 'init', '-q')
})

beforeEach(() => {
  rmSync(pluginJson, { force: true })
})

after(() => {
  restoreGit()
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling
  rmSync(tmp, { recursive: true, force: true })
})

test('mefistoRoot es la raiz del repo donde vive el modulo, sin depender del cwd', () => {
  const root = mefistoRoot()
  assert.equal(realpathSync.native(root), realpathSync.native(REPO_ROOT))

  const previous = process.cwd()
  process.chdir(tmp)
  try {
    assert.equal(mefistoRoot(), root)
  } finally {
    process.chdir(previous)
  }
})

describe('getHarnessVersion', () => {
  test('[A] imprime la version de plugin.json tal cual', () => {
    writeFileSync(pluginJson, '{\n  "name": "mefisto",\n  "version": "9.9.9"\n}\n')
    assert.equal(getHarnessVersion(fixture), '9.9.9')
  })

  test('[B] sin campo version da cadena vacia', () => {
    writeFileSync(pluginJson, '{\n  "name": "mefisto"\n}\n')
    assert.equal(getHarnessVersion(fixture), '')
  })

  test('[C] no confunde la palabra version dentro de otro campo', () => {
    writeFileSync(
      pluginJson,
      '{\n  "name": "mefisto",\n  "version": "1.2.3",\n  "description": "algo con la palabra version adentro"\n}\n',
    )
    assert.equal(getHarnessVersion(fixture), '1.2.3')
  })

  test('[D] sin plugin.json da cadena vacia', () => {
    assert.equal(getHarnessVersion(fixture), '')
  })

  test('un plugin.json ilegible o con version nula da cadena vacia', () => {
    for (const content of ['no soy json {{{', '', '[]', '{"version":null}', '{"version":false}', '{"version":"null"}']) {
      writeFileSync(pluginJson, content)
      assert.equal(getHarnessVersion(fixture), '', content)
    }
  })

  test('otros valores de version: vacia, numero, objeto, salto final y BOM', () => {
    const cases: [string, string][] = [
      ['{"version":""}', ''],
      ['{"version":3}', '3'],
      ['{"version":{"mayor":1,"menor":[2,3]}}', '{\n  "mayor": 1,\n  "menor": [\n    2,\n    3\n  ]\n}'],
      ['{"version":"1.0.0\\n"}', '1.0.0'],
      ['\uFEFF{"version":"4.5.6"}', '4.5.6'],
      ['"texto"', ''],
      ['null', ''],
    ]
    for (const [content, expected] of cases) {
      writeFileSync(pluginJson, content)
      assert.equal(getHarnessVersion(fixture), expected, content)
    }
  })

  test('[E] coincide con el plugin.json real del repo', () => {
    const real = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }
    assert.match(real.version, /^\d+\.\d+\.\d+/)
    assert.equal(getHarnessVersion(), real.version)
  })
})

describe('getHarnessSha', () => {
  test('[F] dentro de un repo git es el SHA corto de HEAD', () => {
    const expected = git(repo, 'rev-parse', '--short', 'HEAD')
    assert.match(expected, /^[0-9a-f]{7,}$/)
    assert.equal(getHarnessSha(repo), expected)
  })

  test('[G] fuera de un repo git, o en uno sin commits, da cadena vacia', () => {
    assert.equal(getHarnessSha(outside), '')
    assert.equal(getHarnessSha(emptyRepo), '')
  })

  test('[H] sin git en el PATH da cadena vacia', () => {
    const calls: string[][] = []
    const run: Run = (command, args) => {
      calls.push([command, ...args])
      return { status: null, stdout: '', stderr: '' }
    }
    assert.equal(getHarnessSha(repo, run), '')
    assert.deepEqual(calls, [['git', 'rev-parse', '--short', 'HEAD']])
  })

  test('opera sobre el cwd del proceso si no se indica otro', () => {
    const previous = process.cwd()
    process.chdir(repo)
    try {
      assert.equal(getHarnessSha(), git(repo, 'rev-parse', '--short', 'HEAD'))
    } finally {
      process.chdir(previous)
    }
  })
})
