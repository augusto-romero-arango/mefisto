import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Json } from '../lib/plugin-scopes.mts'
import { activateRepo, withMefistoEnabled } from '../onboard-activate-repo.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import { Captured, newRepo, writeJson } from './plugin-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'onboard-activate-repo.mts')
const MKT = 'augusto-romero-arango-harness'
const ID = `mefisto@${MKT}`
const SOURCE = { source: 'github', repo: 'augusto-romero-arango/mefisto' }

let work = ''
let consumer = ''
let configDir = ''
let serial = 0
let restoreGit = (): void => {}
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES

function settingsFile(): string {
  return join(consumer, '.claude', 'settings.json')
}

function settings(): Record<string, Json> {
  return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, Json>
}

function writeSettings(content: string): void {
  mkdirSync(dirname(settingsFile()), { recursive: true })
  writeFileSync(settingsFile(), content)
}

interface Result extends Captured {
  status: number
}

function run(argv: string[], cwd = consumer): Result {
  const captured = new Captured()
  const status = activateRepo(argv, {
    cwd,
    env: { CLAUDE_CONFIG_DIR: configDir },
    home: join(work, 'home'),
    scriptDir: join(work, 'paquete', 'scripts'),
    program: 'onboard-activate-repo',
    out: captured.writeOut,
    err: captured.writeErr,
  })
  return Object.assign(captured, { status })
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto activate '))
  process.env.GIT_CEILING_DIRECTORIES = work
  restoreGit = isolateGitConfig(work)
})

beforeEach(() => {
  serial++
  consumer = newRepo(join(work, `consumer-${serial}`))
  configDir = join(work, `config-${serial}`)
  mkdirSync(configDir)
})

after(() => {
  restoreGit()
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling
  rmSync(work, { recursive: true, force: true })
})

describe('fusion de .claude/settings.json', () => {
  const EXISTING = '{"permissions":{"allow":["Bash(git:*)"]},"enabledPlugins":{"otro@x":true}}\n'

  test('--preview muestra el plan y no escribe', () => {
    writeSettings(EXISTING)
    const result = run(['--preview'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.out, [
      'Plan:',
      '  - escribir .claude/settings.json con este contenido (resto de claves intacto):',
      '      {',
      '        "permissions": {',
      '          "allow": [',
      '            "Bash(git:*)"',
      '          ]',
      '        },',
      '        "enabledPlugins": {',
      '          "otro@x": true,',
      `          "${ID}": true`,
      '        },',
      '        "extraKnownMarketplaces": {',
      `          "${MKT}": {`,
      '            "source": {',
      '              "source": "github",',
      '              "repo": "augusto-romero-arango/mefisto"',
      '            }',
      '          }',
      '        }',
      '      }',
    ])
    assert.equal(readFileSync(settingsFile(), 'utf8'), EXISTING)
  })

  test('--apply habilita mefisto, declara el marketplace y conserva el resto', () => {
    writeSettings(EXISTING)
    const result = run(['--apply'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.out, [
      `OK: .claude/settings.json habilita ${ID}.`,
      'Commitea el archivo y llevalo a main: los worktrees de pipeline nacen de origin/main.',
    ])
    assert.deepEqual(settings(), {
      permissions: { allow: ['Bash(git:*)'] },
      enabledPlugins: { 'otro@x': true, [ID]: true },
      extraKnownMarketplaces: { [MKT]: { source: SOURCE } },
    })
    assert.ok(readFileSync(settingsFile(), 'utf8').endsWith('}\n'))
  })

  test('es idempotente', () => {
    writeSettings(EXISTING)
    run(['--apply'])
    const before = readFileSync(settingsFile(), 'utf8')
    for (const mode of ['--apply', '--preview']) {
      assert.deepEqual(run([mode]).out, [
        'OK: el repo ya habilita Mefisto (.claude/settings.json); no hay nada que escribir.',
      ])
    }
    assert.equal(readFileSync(settingsFile(), 'utf8'), before)
  })

  test('sin settings.json lo crea', () => {
    assert.equal(run(['--preview']).status, 0)
    assert.equal(existsSync(settingsFile()), false)
    assert.equal(run(['--apply']).status, 0)
    assert.deepEqual(settings(), {
      extraKnownMarketplaces: { [MKT]: { source: SOURCE } },
      enabledPlugins: { [ID]: true },
    })
  })

  test('toma el marketplace y su fuente de known_marketplaces.json', () => {
    mkdirSync(join(configDir, 'plugins'))
    const source = { source: 'git', url: 'https://ejemplo.test/mefisto.git', repo: 'augusto-romero-arango/mefisto' }
    writeJson(join(configDir, 'plugins', 'known_marketplaces.json'), { 'mi-mkt': { source, installLocation: '/x' } })
    writeSettings('{"extraKnownMarketplaces":null,"enabledPlugins":{"mefisto@mi-mkt":false},"z":1}\n')
    assert.equal(run(['--apply']).status, 0)
    assert.deepEqual(settings(), {
      extraKnownMarketplaces: { 'mi-mkt': { source } },
      enabledPlugins: { 'mefisto@mi-mkt': true },
      z: 1,
    })
    assert.deepEqual(Object.keys(settings()), ['extraKnownMarketplaces', 'enabledPlugins', 'z'])
  })

  test('no pisa una declaracion previa del marketplace', () => {
    const declared = { source: { source: 'directory', path: '/ya' } }
    assert.deepEqual(withMefistoEnabled({ extraKnownMarketplaces: { [MKT]: declared } }, MKT, SOURCE), {
      extraKnownMarketplaces: { [MKT]: declared },
      enabledPlugins: { [ID]: true },
    })
  })
})

describe('settings.json que no se puede fusionar', () => {
  test('si no es un objeto JSON aborta sin escribir', () => {
    for (const content of ['[1]\n', '', '{ roto']) {
      writeSettings(content)
      const result = run(['--apply'])
      assert.equal(result.status, 1)
      assert.equal(result.err.length, 1)
      assert.match(result.err[0] ?? '', /^ERROR: .*settings\.json no es un objeto JSON valido; corrigelo a mano\.$/)
      assert.equal(readFileSync(settingsFile(), 'utf8'), content)
    }
  })

  test('si enabledPlugins o extraKnownMarketplaces no son objetos aborta sin escribir', () => {
    for (const content of ['{"enabledPlugins":["x"]}\n', '{"extraKnownMarketplaces":"x"}\n']) {
      writeSettings(content)
      const result = run(['--apply'])
      assert.equal(result.status, 1)
      assert.equal(result.err.length, 1)
      assert.match(
        result.err[0] ?? '',
        /^ERROR: .*settings\.json tiene extraKnownMarketplaces o enabledPlugins que no son objetos; corrigelo a mano\.$/,
      )
      assert.equal(readFileSync(settingsFile(), 'utf8'), content)
    }
  })
})

describe('argumentos y repositorio', () => {
  test('sin modo, o con uno desconocido, imprime el uso', () => {
    for (const argv of [[], ['--otro']]) {
      const result = run(argv)
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, ['Uso: onboard-activate-repo --preview | --apply'])
      assert.equal(existsSync(settingsFile()), false)
    }
  })

  test('se niega en el repo de Mefisto', () => {
    mkdirSync(join(consumer, '.claude-plugin'))
    writeFileSync(join(consumer, '.claude-plugin', 'plugin.json'), '{}')
    const result = run(['--apply'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.errLines, [
      'ERROR: /onboard no aplica al repo de Mefisto.',
      '       scripts/onboard-activate-repo.mts es del plugin publicado y solo aplica al consumidor.',
    ])
  })

  test('fuera de un repo git aborta', () => {
    const outside = join(work, `no-git-${serial}`)
    mkdirSync(outside)
    const result = run(['--apply'], outside)
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ['ERROR: no estas en un repositorio git'])
  })

  test('por linea de comando termina en 1 en el repo de Mefisto', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--preview'], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })
})
