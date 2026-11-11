import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import {
  applicableInstallations,
  applicableScopes,
  committedActivation,
  disableAtUserLevel,
  effectiveInstallation,
  enabledAtUserLevel,
  marketplaceSource,
  mefistoMarketplace,
  pluginListJson,
  reportActivation,
  sameProjectPath,
  updateScopes,
  userSettingsPath,
} from '../lib/plugin-scopes.mts'
import type { ClaudeContext, Json } from '../lib/plugin-scopes.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import { Captured, commitSettings, failed, fakeClaude, newRepo, ok, writeJson } from './plugin-sandbox.mts'
import type { FakeClaudeOptions } from './plugin-sandbox.mts'

const MKT = 'mkt-act'
const ID = `mefisto@${MKT}`

let work = ''
let configDir = ''
let restoreGit = (): void => {}

function config(): { env: NodeJS.ProcessEnv; home: string } {
  return { env: { CLAUDE_CONFIG_DIR: configDir }, home: join(work, 'home') }
}

function context(options: FakeClaudeOptions = {}): ClaudeContext & { captured: Captured; log: string[] } {
  const captured = new Captured()
  const claude = fakeClaude({ configDir, ...options })
  return { ...config(), run: claude.run, out: captured.writeOut, err: captured.writeErr, captured, log: claude.log }
}

function userSettings(content: Json): void {
  writeJson(join(configDir, 'settings.json'), content)
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto scopes '))
  restoreGit = isolateGitConfig(work)
})

beforeEach(() => {
  configDir = join(work, 'config')
  rmSync(configDir, { recursive: true, force: true })
  mkdirSync(configDir, { recursive: true })
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

describe('committedActivation', () => {
  test('lee el settings.json de HEAD, no el disco', () => {
    const repo = newRepo(join(work, 'a1'))
    mkdirSync(join(repo, '.claude'))
    writeJson(join(repo, '.claude', 'settings.json'), { enabledPlugins: { [ID]: true } })
    assert.equal(committedActivation(MKT, repo), false, 'sin commitear no cuenta')
    commitSettings(repo, { enabledPlugins: { [ID]: true } })
    assert.equal(committedActivation(MKT, repo), true, 'commiteado en true cuenta')
    commitSettings(repo, { enabledPlugins: { 'mefisto@otro': true } })
    assert.equal(committedActivation(MKT, repo), false, 'otro marketplace no cuenta')
  })

  test('sin raiz, sin settings o con un settings que no es objeto no cuenta', () => {
    assert.equal(committedActivation(MKT, ''), false)
    const repo = newRepo(join(work, 'a1-vacio'))
    assert.equal(committedActivation(MKT, repo), false)
    commitSettings(repo, { enabledPlugins: [ID] })
    assert.equal(committedActivation(MKT, repo), false)
    commitSettings(repo, [ID])
    assert.equal(committedActivation(MKT, repo), false)
  })
})

describe('enabledAtUserLevel', () => {
  test('solo un false explicito lo deshabilita', () => {
    assert.equal(enabledAtUserLevel(config(), MKT), true, 'sin settings de usuario')
    userSettings({ enabledPlugins: {} })
    assert.equal(enabledAtUserLevel(config(), MKT), true, 'sin la clave')
    userSettings({ enabledPlugins: { [ID]: false } })
    assert.equal(enabledAtUserLevel(config(), MKT), false, 'false explicito')
  })

  test('un settings ilegible o con otra forma cuenta como habilitado', () => {
    writeFileSync(join(configDir, 'settings.json'), 'no es json')
    assert.equal(enabledAtUserLevel(config(), MKT), true)
    userSettings({ enabledPlugins: [false] })
    assert.equal(enabledAtUserLevel(config(), MKT), true)
    userSettings({ enabledPlugins: { [ID]: null } })
    assert.equal(enabledAtUserLevel(config(), MKT), true)
  })

  test('sin CLAUDE_CONFIG_DIR lee ~/.claude', () => {
    const home = join(work, 'home-propio')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: { [ID]: false } })
    assert.equal(userSettingsPath({ env: {}, home }), join(home, '.claude', 'settings.json'))
    assert.equal(enabledAtUserLevel({ env: {}, home }, MKT), false)
    assert.equal(enabledAtUserLevel({ env: { CLAUDE_CONFIG_DIR: '' }, home }, MKT), false)
  })
})

describe('mefistoMarketplace y marketplaceSource', () => {
  const known = (): string => join(configDir, 'plugins', 'known_marketplaces.json')
  const checkout = (): string => join(work, 'checkout')

  test('deriva el nombre de la raiz del cache', () => {
    const root = join(work, 'cache', MKT, 'mefisto', '0.50.0')
    assert.equal(mefistoMarketplace(config(), root), MKT)
    assert.equal(mefistoMarketplace(config(), `${root}/`), MKT)
  })

  test('una raiz sin normalizar no se reconoce como ruta del cache', () => {
    const root = join(work, 'cache', MKT, 'mefisto', '0.50.0', 'scripts')
    assert.equal(mefistoMarketplace(config(), `${root}/..`), 'augusto-romero-arango-harness')
  })

  test('reconoce el marketplace registrado con el slug previo al rename (#2349)', () => {
    mkdirSync(join(configDir, 'plugins'))
    writeJson(known(), {
      'mkt-previo': { source: { source: 'github', repo: 'augusto-romero-arango/eda-evsourcing-azure-harness' } },
    })
    assert.equal(mefistoMarketplace(config(), checkout()), 'mkt-previo')
  })

  test('reconoce el marketplace registrado con el slug actual', () => {
    mkdirSync(join(configDir, 'plugins'))
    writeJson(known(), {
      otro: { source: { source: 'github', repo: 'augusto-romero-arango/mefisto-site' } },
      raro: 'no es un objeto',
      'mkt-nuevo': { source: { source: 'github', repo: 'augusto-romero-arango/mefisto' } },
    })
    assert.equal(mefistoMarketplace(config(), checkout()), 'mkt-nuevo')
  })

  test('sin registro cae al nombre publicado y a la fuente con el slug actual', () => {
    assert.equal(mefistoMarketplace(config(), checkout()), 'augusto-romero-arango-harness')
    assert.deepEqual(marketplaceSource(config(), 'augusto-romero-arango-harness'), {
      source: 'github',
      repo: 'augusto-romero-arango/mefisto',
    })
  })

  test('la fuente sale de known_marketplaces.json solo si es github o git', () => {
    mkdirSync(join(configDir, 'plugins'))
    const git = { source: 'git', url: 'https://ejemplo.test/mefisto.git' }
    writeJson(known(), { uno: { source: git }, dos: { source: { source: 'directory', path: '/x' } }, tres: 'x' })
    assert.deepEqual(marketplaceSource(config(), 'uno'), git)
    for (const name of ['dos', 'tres', 'cuatro']) {
      assert.deepEqual(marketplaceSource(config(), name), { source: 'github', repo: 'augusto-romero-arango/mefisto' })
    }
  })
})

describe('scopes aplicables', () => {
  const top = '/repos/consumidor'
  const list: Json[] = [
    { id: ID, version: '0.21.0', scope: 'user', installPath: '/cache/0.21.0' },
    { id: ID, version: '0.20.0', scope: 'project', projectPath: top, installPath: '/cache/0.20.0' },
    { id: ID, version: '0.21.0', scope: 'local', projectPath: '/otro/proyecto', installPath: '/cache/0.21.0' },
    { id: 'otro@x', version: '1.0.0', scope: 'user', installPath: '/x' },
    { id: ID, version: '0.21.0', scope: 'managed', installPath: '/cache/0.21.0' },
    'ruido',
    null,
  ]

  test('toma user y los project/local del proyecto, e ignora otros plugins y otros proyectos', () => {
    assert.deepEqual(applicableInstallations(MKT, list, top), [
      { scope: 'user', version: '0.21.0', installPath: '/cache/0.21.0' },
      { scope: 'project', version: '0.20.0', installPath: '/cache/0.20.0' },
    ])
    assert.deepEqual(applicableScopes(MKT, list, top), ['project', 'user'])
  })

  test('sin datos del CLI el unico scope es user y no hay instalacion efectiva', () => {
    assert.deepEqual(applicableScopes(MKT, null, top), ['user'])
    assert.deepEqual(applicableScopes(MKT, [], top), ['user'])
    assert.equal(effectiveInstallation(MKT, null, top), null)
  })

  test('la instalacion efectiva sigue la precedencia local > project > user', () => {
    assert.equal(effectiveInstallation(MKT, list, top)?.scope, 'project')
    const local: Json = { id: ID, scope: 'local', projectPath: top }
    assert.deepEqual(effectiveInstallation(MKT, [...list, local], top), {
      scope: 'local',
      version: '',
      installPath: '',
    })
    assert.equal(effectiveInstallation(MKT, list, '/ninguno')?.scope, 'user')
  })

  test('en Windows la raiz de git y el projectPath coinciden aunque cambien separadores y mayusculas', () => {
    assert.equal(sameProjectPath('C:\\Repos\\Consumidor', 'c:/repos/consumidor', 'win32'), true)
    assert.equal(sameProjectPath('C:\\Repos\\Otro', 'c:/repos/consumidor', 'win32'), false)
    assert.equal(sameProjectPath('/repos/Consumidor', '/repos/consumidor', 'linux'), false)
    const windows: Json[] = [{ id: ID, scope: 'project', projectPath: 'C:\\Repos\\Consumidor' }]
    assert.equal(applicableInstallations(MKT, windows, 'C:/Repos/Consumidor', 'win32').length, 1)
  })

  test('pluginListJson devuelve null si el CLI falla o no entrega un array', () => {
    assert.equal(pluginListJson(context()), null)
    assert.equal(pluginListJson(context({ list: () => ({}) })), null)
    assert.equal(pluginListJson({ run: () => ok('no es json') }), null)
    assert.deepEqual(pluginListJson(context({ list: () => [] })), [])
  })
})

describe('updateScopes', () => {
  const list: Json[] = [
    { id: ID, scope: 'user' },
    { id: ID, scope: 'project', projectPath: '/repo' },
  ]

  test('actualiza una vez por scope y reenvia la salida del CLI', () => {
    const ctx = context({ respond: (args) => ok(`listo ${args.at(-1)}\n`) })
    assert.equal(updateScopes(ctx, MKT, list, '/repo'), true)
    assert.deepEqual(ctx.log, [`plugin update ${ID} --scope project`, `plugin update ${ID} --scope user`])
    assert.deepEqual(ctx.captured.all, [
      `Actualizando el plugin ${ID} (scope project)...`,
      'listo project',
      `Actualizando el plugin ${ID} (scope user)...`,
      'listo user',
    ])
  })

  test('se detiene en el primer scope que falla', () => {
    const ctx = context({ respond: () => failed('sin red\n') })
    assert.equal(updateScopes(ctx, MKT, list, '/repo'), false)
    assert.deepEqual(ctx.log, [`plugin update ${ID} --scope project`])
    assert.deepEqual(ctx.captured.err, ['sin red', `ERROR: 'claude plugin update ${ID} --scope project' fallo.`])
  })
})

describe('disableAtUserLevel', () => {
  test('deja el nivel usuario en false', () => {
    userSettings({ enabledPlugins: { [ID]: true } })
    const ctx = context()
    assert.equal(disableAtUserLevel(ctx, MKT), true)
    assert.deepEqual(ctx.log, [`plugin disable ${ID} --scope user`])
    assert.equal(enabledAtUserLevel(config(), MKT), false)
    assert.deepEqual(ctx.captured.all, [])
  })

  test('falla si el CLI falla o si el nivel usuario sigue habilitado', () => {
    const broken = context({ respond: () => failed() })
    assert.equal(disableAtUserLevel(broken, MKT), false)
    assert.deepEqual(broken.captured.err, [`ERROR: 'claude plugin disable ${ID} --scope user' fallo.`])

    const inert = context({ respond: () => ok() })
    assert.equal(disableAtUserLevel(inert, MKT), false)
    assert.deepEqual(inert.captured.err, [
      `ERROR: ${ID} sigue habilitado a nivel usuario en ${join(configDir, 'settings.json')}.`,
    ])
  })
})

describe('reportActivation', () => {
  const header = (repo: string, user: string): string[] => [
    'Activacion de Mefisto:',
    `  Este repo lo habilita en .claude/settings.json commiteado: ${repo}`,
    `  Nivel usuario (${join(configDir, 'settings.json')}): ${user}`,
  ]

  test('repo activo y usuario habilitado: migracion pendiente', () => {
    const repo = newRepo(join(work, 'reporte-activo'))
    commitSettings(repo, { enabledPlugins: { [ID]: true } })
    const ctx = context()
    reportActivation(ctx, MKT, repo)
    assert.deepEqual(ctx.captured.out, [
      ...header('si', 'habilitado'),
      'MIGRACION PENDIENTE: Mefisto se carga en todos tus repos. Deshabilitarlo a nivel usuario',
      '  lo deja activo solo en los repos que lo habilitan, como este.',
    ])

    userSettings({ enabledPlugins: { [ID]: false } })
    const migrated = context()
    reportActivation(migrated, MKT, repo)
    assert.deepEqual(migrated.captured.out, header('si', 'deshabilitado'))
  })

  test('repo sin activacion: aviso', () => {
    const repo = newRepo(join(work, 'reporte-inactivo'))
    const ctx = context()
    reportActivation(ctx, MKT, repo)
    assert.deepEqual(ctx.captured.out, [
      ...header('no', 'habilitado'),
      'AVISO: este repo no habilita Mefisto en un .claude/settings.json commiteado.',
      `  Agrega "enabledPlugins": {"${ID}": true} (o corre /mefisto:onboard) y commitealo;`,
      '  sin eso, Mefisto no se cargara aqui cuando lo deshabilites a nivel usuario.',
    ])
  })
})
