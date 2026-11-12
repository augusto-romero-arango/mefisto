import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { repoRoot } from '../lib/cli.mts'
import type { Json } from '../lib/plugin-scopes.mts'
import {
  cacheVersions,
  changelogDelta,
  compareVersions,
  marketplaceDir,
  protectedVersions,
  prunableVersions,
  updatePlugin,
  versionOfPath,
} from '../update-plugin.mts'
import { upgrade } from '../upgrade.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import { Captured, commitSettings, failed, fakeClaude, newRepo, ok, writeJson } from './plugin-sandbox.mts'
import type { FakeClaudeOptions } from './plugin-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPTS = join(HERE, '..')
const SCRIPT = join(SCRIPTS, 'update-plugin.mts')
const MKT = 'un-fork-de-mentira'
const ID = `mefisto@${MKT}`
const USAGE = 'Uso: update-plugin [--prune --only <v>[,<v>...] [--loaded <version>]]'

// Cache real observado en el issue #531, mas la version recien traida.
const ALL = ['0.10.0', '0.15.0', '0.16.0', '0.17.0', '0.18.0', '0.19.0']
const ALL_AFTER_UPDATE = [...ALL, '0.20.0']
// Caso ControlAsistencia (#2248).
const CA = ['0.43.0', '0.44.0', '0.44.1']

let work = ''
let consumer = ''
let cache = ''
let configDir = ''
let serial = 0
let restoreGit = (): void => {}
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES

function mefistoDir(): string {
  return join(cache, MKT, 'mefisto')
}

function versionDir(version: string): string {
  return join(mefistoDir(), version)
}

function versions(...list: string[]): void {
  for (const version of list) mkdirSync(versionDir(version), { recursive: true })
}

function stateFile(...parts: string[]): string {
  return join(consumer, ...parts)
}

function writeState(content: string, ...parts: string[]): void {
  mkdirSync(dirname(stateFile(...parts)), { recursive: true })
  writeFileSync(stateFile(...parts), content)
}

function pluginRootAt(version: string): void {
  writeState(versionDir(version), '.claude', 'pipeline', '.plugin-root')
}

function pluginRoot(): string {
  return readFileSync(stateFile('.claude', 'pipeline', '.plugin-root'), 'utf8')
}

function cached(): string[] {
  return readdirSync(mefistoDir()).sort()
}

interface RunOptions extends FakeClaudeOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Comandos que resuelven en el PATH; por defecto, solo `claude`. */
  available?: string[]
}

interface Result extends Captured {
  status: number
  log: string[]
}

function deps(options: RunOptions, captured: Captured, claude: ReturnType<typeof fakeClaude>) {
  return {
    cwd: options.cwd ?? consumer,
    env: { MEFISTO_CACHE_ROOT: cache, CLAUDE_CONFIG_DIR: configDir, ...options.env },
    home: join(work, 'home'),
    program: 'update-plugin',
    hasCommand: (command: string) => (options.available ?? ['claude']).includes(command),
    run: claude.run,
    out: captured.writeOut,
    err: captured.writeErr,
  }
}

function run(argv: string[], options: RunOptions = {}): Result {
  const captured = new Captured()
  const claude = fakeClaude({ configDir, ...options })
  const status = updatePlugin(argv, deps(options, captured, claude))
  return Object.assign(captured, { status, log: claude.log })
}

/** Lineas `  - <version>` del reporte de podables. */
function listed(result: Result): string[] {
  return result.lines.filter((line) => line.startsWith('  - '))
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto update '))
  process.env.GIT_CEILING_DIRECTORIES = work
  restoreGit = isolateGitConfig(work)
})

beforeEach(() => {
  serial++
  consumer = newRepo(join(work, `consumer-${serial}`))
  cache = join(work, `cache-${serial}`)
  configDir = join(work, `config-${serial}`)
  mkdirSync(cache)
  mkdirSync(configDir)
})

after(() => {
  restoreGit()
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling
  rmSync(work, { recursive: true, force: true })
})

describe('protectedVersions', () => {
  test('protege exactamente la cargada y la nueva', () => {
    assert.deepEqual(protectedVersions(ALL_AFTER_UPDATE, '0.20.0', '0.19.0', '0.20.0'), ['0.19.0', '0.20.0'])
  })

  test('sin version cargada conocida protege la N-1', () => {
    assert.deepEqual(protectedVersions(ALL, '0.19.0', '', ''), ['0.18.0', '0.19.0'])
  })

  test('protege la union de la nueva, la cargada y la de .plugin-root', () => {
    assert.deepEqual(protectedVersions(ALL, '0.19.0', '0.17.0', '0.18.0'), ['0.17.0', '0.18.0', '0.19.0'])
  })

  test('protege la version del marcador canonico', () => {
    const kept = protectedVersions(CA, '0.44.1', '0.44.1', '0.44.1', '0.44.0')
    assert.deepEqual(kept, ['0.44.0', '0.44.1'])
    assert.deepEqual(prunableVersions(CA, kept), ['0.43.0'])
  })

  test('con el canonico ausente el comportamiento no cambia', () => {
    const kept = protectedVersions(CA, '0.44.1', '0.44.1', '0.44.1', '')
    assert.deepEqual(prunableVersions(CA, kept), ['0.43.0', '0.44.0'])
  })
})

describe('prunableVersions', () => {
  test('poda las viejas acumuladas', () => {
    assert.deepEqual(prunableVersions(ALL, ['0.19.0', '0.20.0']), ['0.10.0', '0.15.0', '0.16.0', '0.17.0', '0.18.0'])
  })

  // Dos corridas de /mefisto:upgrade en la misma sesion: la sesion sigue con 0.18.0 cargada
  // aunque .plugin-root ya apunte a 0.19.0.
  test('la cargada queda fuera de la poda aunque no sea la nueva', () => {
    const kept = protectedVersions(ALL, '0.19.0', '0.18.0', '0.19.0')
    assert.deepEqual(prunableVersions(ALL, kept), ['0.10.0', '0.15.0', '0.16.0', '0.17.0'])
  })

  test('con el cache ya limpio no hay nada podable', () => {
    assert.deepEqual(prunableVersions(['0.19.0', '0.20.0'], ['0.19.0', '0.20.0']), [])
  })
})

describe('marketplaceDir', () => {
  test('lo deriva del .plugin-root cargado, sin fijar el nombre del marketplace', () => {
    versions('0.19.0')
    assert.equal(marketplaceDir(versionDir('0.19.0'), cache), mefistoDir())
    assert.equal(marketplaceDir(`${versionDir('0.19.0')}/`, `${cache}/`), mefistoDir())
  })

  test('recorre el cache cuando no hay .plugin-root o apunta fuera', () => {
    versions('0.19.0')
    assert.equal(marketplaceDir('', cache), mefistoDir())
    assert.equal(marketplaceDir(join(work, 'otra', 'mefisto', '0.19.0'), cache), mefistoDir())
  })

  test('sin ningun mefisto en el cache devuelve null', () => {
    mkdirSync(join(cache, 'otro', 'plugin'), { recursive: true })
    assert.equal(marketplaceDir('', cache), null)
    assert.equal(marketplaceDir('', join(cache, 'no-existe')), null)
  })

  test('con varios marketplaces avisa y usa el primero', () => {
    for (const name of ['zeta', 'alfa', '.oculto']) mkdirSync(join(cache, name, 'mefisto'), { recursive: true })
    const warnings: string[] = []
    assert.equal(marketplaceDir('', cache, (line) => warnings.push(line)), join(cache, 'alfa', 'mefisto'))
    assert.deepEqual(warnings, [
      "ADVERTENCIA: hay 2 marketplaces con 'mefisto' en el cache; se usa el primero.",
      `  - ${join(cache, 'alfa', 'mefisto')}`,
      `  - ${join(cache, 'zeta', 'mefisto')}`,
    ])
  })
})

describe('versiones del cache', () => {
  test('se ordenan por numero, no por texto', () => {
    versions('0.10.0', '0.9.0', '0.9.10', '1.0.0')
    writeFileSync(join(mefistoDir(), 'archivo'), '')
    mkdirSync(join(mefistoDir(), '.oculta'))
    assert.deepEqual(cacheVersions(mefistoDir()), ['0.9.0', '0.9.10', '0.10.0', '1.0.0'])
    assert.deepEqual(cacheVersions(join(cache, 'no-existe')), [])
  })

  test('compareVersions deja primero la version sin sufijo', () => {
    assert.deepEqual(['1.0.0-rc.2', '1.0.0', '1.0.0-rc.10'].sort(compareVersions), [
      '1.0.0',
      '1.0.0-rc.2',
      '1.0.0-rc.10',
    ])
    assert.equal(compareVersions('0.44.1', '0.44.1'), 0)
  })

  test('versionOfPath tolera el separador final y la ruta vacia', () => {
    assert.equal(versionOfPath(join('cache', 'mkt', 'mefisto', '0.19.0')), '0.19.0')
    assert.equal(versionOfPath('cache/mkt/mefisto/0.19.0/'), '0.19.0')
    assert.equal(versionOfPath(''), '')
  })
})

describe('changelogDelta', () => {
  function changelog(content: string): string {
    const file = join(work, `CHANGELOG-${serial}.md`)
    writeFileSync(file, content)
    return file
  }

  test('imprime las entradas publicadas despues de la version cargada', () => {
    const file = changelog('# Changelog\n\n## [0.21.0]\n- nuevo\n\n## [0.20.0]\n- viejo\n\n## [0.19.0]\n- x\n')
    assert.deepEqual(changelogDelta(file, '0.20.0', '0.21.0'), [
      '--- Delta de CHANGELOG.md (0.20.0 -> 0.21.0) ---',
      '## [0.21.0]',
      '- nuevo',
      '',
      '--- fin del delta ---',
    ])
  })

  test('sin el encabezado de la cargada avisa y muestra solo la seccion mas reciente', () => {
    const file = changelog('intro\n## [0.21.0]\n- nuevo\n## [0.20.5]\n- medio\n')
    assert.deepEqual(changelogDelta(file, '0.20.0', '0.21.0'), [
      `ADVERTENCIA: ${file} no tiene un encabezado '## [0.20.0]'; no se puede acotar el delta.`,
      '--- Seccion mas reciente de CHANGELOG.md ---',
      '## [0.21.0]',
      '- nuevo',
      '--- fin de la seccion ---',
    ])
  })

  test('un marcador a media linea no corta el delta', () => {
    const file = changelog('ver ## [0.20.0] abajo\n## [0.21.0]\n- nuevo')
    assert.deepEqual(changelogDelta(file, '0.20.0', '0.21.0'), [
      '--- Delta de CHANGELOG.md (0.20.0 -> 0.21.0) ---',
      '## [0.21.0]',
      '- nuevo',
      '--- fin del delta ---',
    ])
  })
})

describe('modo actualizar', () => {
  beforeEach(() => {
    versions('0.20.0', '0.21.0')
    writeFileSync(
      join(versionDir('0.21.0'), 'CHANGELOG.md'),
      '## [0.21.0]\n- nada relevante\n\n## [0.20.0]\n- nada relevante\n',
    )
    pluginRootAt('0.20.0')
  })

  // El CLI rechaza `mefisto` a secas (issue #601).
  test('el update del plugin recibe el nombre calificado con su marketplace', () => {
    const result = run([])
    assert.equal(result.status, 0)
    assert.deepEqual(result.log, [`plugin marketplace update ${MKT}`, `plugin update ${ID} --scope user`])
    assert.equal(pluginRoot(), versionDir('0.21.0'))
  })

  test('imprime el reporte completo', () => {
    const result = run([], { respond: (args) => ok(`${args[1]} ok\n`) })
    assert.deepEqual(result.err, [])
    assert.deepEqual(result.out, [
      `Marketplace detectado: ${MKT}`,
      'Version cargada en esta sesion: 0.20.0 (fuente: .claude/pipeline/.plugin-root)',
      '',
      `Actualizando el catalogo del marketplace (${MKT})...`,
      'marketplace ok',
      '',
      `Actualizando el plugin ${ID} (scope user)...`,
      'update ok',
      '',
      `OK: .claude/pipeline/.plugin-root -> ${versionDir('0.21.0')}`,
      '',
      '--- Delta de CHANGELOG.md (0.20.0 -> 0.21.0) ---',
      '## [0.21.0]',
      '- nada relevante',
      '',
      '--- fin del delta ---',
      '',
      'Versiones conservadas: 0.20.0 0.21.0',
      'Cache limpio: no hay versiones podables.',
      '',
      'Activacion de Mefisto:',
      '  Este repo lo habilita en .claude/settings.json commiteado: no',
      `  Nivel usuario (${join(configDir, 'settings.json')}): habilitado`,
      'AVISO: este repo no habilita Mefisto en un .claude/settings.json commiteado.',
      `  Agrega "enabledPlugins": {"${ID}": true} (o corre /mefisto:onboard) y commitealo;`,
      '  sin eso, Mefisto no se cargara aqui cuando lo deshabilites a nivel usuario.',
      '',
      'Version destino: 0.21.0.',
      'Corre /reload-plugins (o reinicia la sesion) para activar la version 0.21.0.',
    ])
  })

  test('escribe el marker de sesion una sola vez', () => {
    run([])
    const marker = stateFile('.claude', 'pipeline', '.plugin-root.previous')
    assert.equal(readFileSync(marker, 'utf8'), versionDir('0.20.0'))
    const second = run([])
    assert.equal(readFileSync(marker, 'utf8'), versionDir('0.20.0'))
    assert.match(second.text, /Version cargada en esta sesion: 0\.20\.0 \(fuente: \.claude\/pipeline\/\.plugin-root\.previous\)/)
  })

  test('ya en la version mas reciente no hay delta', () => {
    pluginRootAt('0.21.0')
    const result = run([])
    assert.ok(result.out.includes('Ya estabas en la version mas reciente (0.21.0); no hay delta que mostrar.'))
  })

  test('sin el CLI claude aborta sin tocar .plugin-root', () => {
    const result = run([], { available: [] })
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ["ERROR: el CLI 'claude' no esta en el PATH. Requerido para actualizar el plugin."])
    assert.equal(pluginRoot(), versionDir('0.20.0'))
  })

  test('si falla el catalogo aborta antes de actualizar el plugin', () => {
    const result = run([], { respond: () => failed('sin acceso\n') })
    assert.equal(result.status, 1)
    assert.deepEqual(result.log, [`plugin marketplace update ${MKT}`])
    assert.deepEqual(result.errLines, [
      'sin acceso',
      `ERROR: 'claude plugin marketplace update ${MKT}' fallo.`,
      '       Sin refrescar el catalogo, el update no veria la version nueva.',
      '       Revisa el acceso al repo del marketplace y reintenta.',
    ])
    assert.equal(pluginRoot(), versionDir('0.20.0'))
  })

  test('si falla el update aborta sin tocar .plugin-root', () => {
    const result = run([], { respond: (args) => (args[1] === 'update' ? failed() : undefined) })
    assert.equal(result.status, 1)
    assert.deepEqual(result.errLines, [
      `ERROR: 'claude plugin update ${ID} --scope user' fallo.`,
      '       No se toco .plugin-root ni el cache; reintenta tras resolver la causa.',
      `       Verifica que el plugin este instalado en ese scope (claude plugin install ${ID} --scope <scope>).`,
    ])
    assert.equal(pluginRoot(), versionDir('0.20.0'))
  })
})

describe('scopes aplicables y version efectiva (issue #2130)', () => {
  function installations(projectVersion: string): () => Json {
    const top = repoRoot(consumer) ?? ''
    const list: Json[] = [
      { id: ID, version: '0.21.0', scope: 'user', installPath: versionDir('0.21.0') },
      { id: ID, version: projectVersion, scope: 'project', projectPath: top, installPath: versionDir(projectVersion) },
      { id: ID, version: '0.21.0', scope: 'local', projectPath: '/otro/proyecto', installPath: versionDir('0.21.0') },
    ]
    return () => list
  }

  beforeEach(() => {
    versions('0.20.0', '0.21.0')
    writeFileSync(join(versionDir('0.21.0'), 'CHANGELOG.md'), '## [0.21.0]\n- x\n\n## [0.20.0]\n- x\n')
    pluginRootAt('0.20.0')
  })

  test('con user y project al dia actualiza los dos scopes e ignora otros proyectos', () => {
    const result = run([], { list: installations('0.21.0') })
    assert.equal(result.status, 0)
    assert.deepEqual(result.log, [
      `plugin marketplace update ${MKT}`,
      `plugin update ${ID} --scope project`,
      `plugin update ${ID} --scope user`,
    ])
  })

  test('con el project desfasado falla y .plugin-root apunta a la efectiva', () => {
    const result = run([], { list: installations('0.20.0') })
    assert.equal(result.status, 1)
    assert.deepEqual(result.errLines, [
      'ERROR: la instalacion efectiva del proyecto (scope project) quedo en la version 0.20.0 y la version destino es 0.21.0.',
      `       La sesion siguiente cargaria 0.20.0. Corre 'claude plugin update ${ID} --scope project' y reintenta.`,
    ])
    assert.equal(pluginRoot(), versionDir('0.20.0'))
  })
})

describe('marcador canonico .mefisto/pipeline/.plugin-root (issue #2248)', () => {
  const canonical = (): string => stateFile('.mefisto', 'pipeline', '.plugin-root')

  // Caso ControlAsistencia: nueva y cargada 0.44.1, canonico en 0.44.0 (sesion viva sin reiniciar).
  beforeEach(() => {
    versions(...CA)
    pluginRootAt('0.44.1')
    writeState(versionDir('0.44.0'), '.mefisto', 'pipeline', '.plugin-root')
  })

  test('el modo actualizar conserva su version y no lo reescribe', () => {
    const result = run([])
    assert.equal(result.status, 0)
    assert.deepEqual(listed(result), ['  - 0.43.0'])
    assert.equal(readFileSync(canonical(), 'utf8'), versionDir('0.44.0'))
  })

  test('--prune conserva la version del canonico', () => {
    assert.equal(run([]).status, 0)
    assert.equal(run(['--prune', '--only', '0.43.0', '--loaded', '0.44.1']).status, 0)
    assert.deepEqual(cached(), ['0.44.0', '0.44.1'])
  })

  test('sin canonico se podan 0.43.0 y 0.44.0 como antes', () => {
    rmSync(canonical())
    assert.equal(run(['--prune', '--only', '0.43.0,0.44.0', '--loaded', '0.44.1']).status, 0)
    assert.deepEqual(cached(), ['0.44.1'])
  })
})

// Caso ControlAsistencia: /reload-plugins no dispara SessionStart, asi que .previous sigue en
// 0.44.0 mientras la sesion carga 0.44.1; la nueva es 0.45.0.
describe('upgrade.mts -> update-plugin.mts: la raiz viva gana sobre un .previous viejo (issue #2249)', () => {
  function viaUpgrade(argv: string[], loadedRoot: string): Result {
    const captured = new Captured()
    const claude = fakeClaude({ configDir })
    const options: RunOptions = {}
    const status = upgrade(argv, {
      cwd: consumer,
      env: { MEFISTO_RUNTIME: 'claude', MEFISTO_LOADED_ROOT: loadedRoot },
      scriptDir: SCRIPTS,
      program: 'upgrade',
      hasCommand: (command) => command === 'claude',
      delegate: (script, args) => {
        assert.equal(script, SCRIPT)
        return updatePlugin(args, deps(options, captured, claude))
      },
      out: captured.writeOut,
      err: captured.writeErr,
    })
    return Object.assign(captured, { status, log: claude.log })
  }

  beforeEach(() => {
    for (const version of ['0.43.0', '0.44.0', '0.44.1', '0.45.0']) {
      mkdirSync(join(versionDir(version), '.claude-plugin'), { recursive: true })
      writeJson(join(versionDir(version), '.claude-plugin', 'plugin.json'), { name: 'mefisto', version })
    }
    writeState(versionDir('0.44.0'), '.claude', 'pipeline', '.plugin-root.previous')
    pluginRootAt('0.45.0')
  })

  test('la version cargada sale de la raiz viva, no del .previous', () => {
    const result = viaUpgrade([], versionDir('0.44.1'))
    assert.equal(result.status, 0)
    assert.ok(result.out.includes('Version cargada en esta sesion: 0.44.1 (fuente: --loaded)'))
    assert.deepEqual(listed(result), ['  - 0.43.0', '  - 0.44.0'])
  })

  test('una raiz sin sustituir se ignora y sigue la cadena previa', () => {
    const result = viaUpgrade([], '${CLAUDE_PLUGIN_ROOT}')
    assert.ok(
      result.out.includes(
        'Version cargada en esta sesion: 0.44.0 (fuente: .claude/pipeline/.plugin-root.previous)',
      ),
    )
  })

  test('--prune conserva la version viva', () => {
    const result = viaUpgrade(['--prune', '--only', '0.43.0,0.44.0'], versionDir('0.44.1'))
    assert.equal(result.status, 0)
    assert.deepEqual(cached(), ['0.44.1', '0.45.0'])
  })
})

describe('--prune exige --only y borra solo lo confirmado (issue #2250)', () => {
  beforeEach(() => {
    versions(...CA)
    pluginRootAt('0.44.1')
  })

  test('sin una lista valida aborta sin borrar nada', () => {
    const cases: [string[], string][] = [
      [
        ['--prune', '--loaded', '0.44.1'],
        'ERROR: --prune exige --only <v>[,<v>...] con las versiones que el usuario confirmo. No se borro nada.',
      ],
      [['--prune', '--only', '--loaded', '0.44.1'], "ERROR: argumento desconocido '0.44.1'"],
      [['--prune', '--only', ',', '--loaded', '0.44.1'], 'ERROR: --only recibio una lista vacia. No se borro nada.'],
      [
        ['--prune', '--only', '0.43.0,abc', '--loaded', '0.44.1'],
        "ERROR: 'abc' en --only no es una version (se espera X.Y.Z). No se borro nada.",
      ],
      [
        ['--prune', '--only', '../0.43.0', '--loaded', '0.44.1'],
        "ERROR: '../0.43.0' en --only no es una version (se espera X.Y.Z). No se borro nada.",
      ],
    ]
    for (const [argv, message] of cases) {
      const result = run(argv)
      assert.equal(result.status, 1, argv.join(' '))
      assert.equal(result.errLines[0], message)
      assert.equal(result.errLines[1], USAGE)
      assert.deepEqual(cached(), CA, argv.join(' '))
    }
  })

  test('borra solo la confirmada e informa la podable no confirmada', () => {
    const result = run(['--prune', '--only', '0.43.0', '--loaded', '0.44.1'])
    assert.equal(result.status, 0)
    assert.deepEqual(cached(), ['0.44.0', '0.44.1'])
    assert.deepEqual(result.out, [
      `Marketplace detectado: ${MKT}`,
      'Version cargada en esta sesion: 0.44.1 (fuente: --loaded)',
      '',
      'Versiones conservadas: 0.44.1',
      'Borrando del cache solo las versiones confirmadas (--only) que siguen siendo podables...',
      '  borrada: 0.43.0',
      'Podables NO confirmadas (no se borraron): 0.44.0 ',
      '',
      'El marker de sesion (.claude/pipeline/.plugin-root.previous) se conserva: lo limpia el hook SessionStart',
      'del plugin en el proximo arranque. Mientras esta sesion viva, protege la version cargada.',
      '',
      'Version destino: 0.44.1.',
      'Corre /reload-plugins (o reinicia la sesion) para activar la version 0.44.1.',
    ])
    assert.deepEqual(result.log, [], 'la poda no llama al CLI')
  })

  test('no borra una confirmada que ahora esta protegida, y lo informa', () => {
    const result = run(['--prune', '--only', '0.43.0,0.44.1', '--loaded', '0.44.1'])
    assert.deepEqual(cached(), ['0.44.0', '0.44.1'])
    assert.ok(result.out.includes('Confirmadas que ahora estan protegidas (no se borraron): 0.44.1 '))
  })

  test('con el cache limpio informa igual la confirmada protegida', () => {
    rmSync(mefistoDir(), { recursive: true })
    versions('0.44.1')
    const result = run(['--prune', '--only', '0.44.1', '--loaded', '0.44.1'])
    assert.deepEqual(cached(), ['0.44.1'])
    assert.ok(result.out.includes('Cache limpio: no hay versiones podables.'))
    assert.ok(result.out.includes('Confirmadas que ahora estan protegidas (no se borraron): 0.44.1 '))
  })

  test('la pista del modo actualizar trae la lista exacta', () => {
    const result = run(['--loaded', '0.44.1'])
    assert.ok(result.out.includes('  update-plugin --prune --only 0.43.0,0.44.0 --loaded 0.44.1'))
    assert.deepEqual(cached(), CA)
  })

  test('sin version cargada conocida protege la N-1 y la pista no lleva --loaded', () => {
    rmSync(stateFile('.claude', 'pipeline', '.plugin-root'))
    const result = run([])
    assert.deepEqual(result.out.slice(1, 3), [
      'ADVERTENCIA: no se pudo determinar la version cargada en esta sesion.',
      '             Se protegera de la poda la version N-1 del cache por precaucion.',
    ])
    assert.ok(result.out.includes('Versiones conservadas: 0.44.0 0.44.1'))
    assert.ok(result.out.includes('  update-plugin --prune --only 0.43.0'))
  })
})

describe('argumentos', () => {
  beforeEach(() => {
    versions('0.44.1')
    pluginRootAt('0.44.1')
  })

  test('--only sin --prune, un valor ausente y un argumento desconocido se rechazan con el uso', () => {
    const cases: [string[], string][] = [
      [['--only', '0.43.0'], 'ERROR: --only solo aplica junto con --prune.'],
      [['--loaded'], 'ERROR: --loaded requiere una version (p. ej. --loaded 0.19.0)'],
      [['--loaded', ''], 'ERROR: --loaded requiere una version (p. ej. --loaded 0.19.0)'],
      [['--only'], 'ERROR: --only requiere una lista de versiones (p. ej. --only 0.43.0,0.44.0)'],
      [['--nada'], "ERROR: argumento desconocido '--nada'"],
      [['--prune', '--disable-user'], "ERROR: argumento desconocido '--disable-user'"],
      [['--disable-user', '--prune'], 'ERROR: --disable-user no se combina con otros argumentos.'],
    ]
    for (const [argv, message] of cases) {
      const result = run(argv)
      assert.equal(result.status, 1, argv.join(' '))
      assert.equal(result.errLines[0], message)
      assert.equal(result.errLines[1], USAGE)
      assert.equal(result.errLines.length, 10)
      assert.deepEqual(result.out, [])
      assert.deepEqual(result.log, [])
    }
  })

  test('--help imprime el uso por stderr y termina en 0', () => {
    for (const flag of ['-h', '--help']) {
      const result = run([flag])
      assert.equal(result.status, 0)
      assert.equal(result.err[0], USAGE)
      assert.equal(result.err.length, 9)
      assert.deepEqual(result.out, [])
    }
  })
})

describe('--disable-user (MEF-ADR-0053 decision 2)', () => {
  beforeEach(() => {
    versions('0.50.0')
    pluginRootAt('0.50.0')
    writeJson(join(configDir, 'settings.json'), { enabledPlugins: { [ID]: true } })
  })

  function userLevel(): Json {
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      enabledPlugins: Record<string, Json>
    }
    return settings.enabledPlugins[ID] ?? null
  }

  test('sin activacion commiteada se niega y no llama al CLI', () => {
    const result = run(['--disable-user'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ['ERROR: no se deshabilito nada: este repo quedaria sin Mefisto.'])
    assert.equal(result.out[0], 'Activacion de Mefisto:')
    assert.deepEqual(result.log, [])
    assert.equal(userLevel(), true)
  })

  test('con activacion commiteada deshabilita a scope user y es idempotente', () => {
    commitSettings(consumer, { enabledPlugins: { [ID]: true } })
    const first = run(['--disable-user'])
    assert.equal(first.status, 0)
    assert.deepEqual(first.log, [`plugin disable ${ID} --scope user`])
    assert.equal(userLevel(), false)
    assert.deepEqual(first.out, [
      `OK: ${ID} deshabilitado a nivel usuario. Sigue activo en los repos que lo habilitan.`,
      'Reinicia las sesiones de Claude Code abiertas en otros repos para descargarlo de ellas.',
    ])

    const second = run(['--disable-user'])
    assert.equal(second.status, 0)
    assert.deepEqual(second.out, ['Mefisto ya esta deshabilitado a nivel usuario; no se modifico nada.'])
    assert.deepEqual(second.log, [])
  })

  test('sin el CLI claude o sin mefisto en el cache aborta', () => {
    const noCli = run(['--disable-user'], { available: [] })
    assert.equal(noCli.status, 1)
    assert.deepEqual(noCli.err, ["ERROR: el CLI 'claude' no esta en el PATH."])

    rmSync(cache, { recursive: true })
    const noCache = run(['--disable-user'])
    assert.equal(noCache.status, 1)
    assert.deepEqual(noCache.err, [
      `ERROR: no se encontro ningun 'mefisto' en el cache de plugins (${cache}/*/mefisto).`,
    ])
  })
})

describe('reporte de activacion en el modo actualizar', () => {
  beforeEach(() => {
    versions('0.50.0')
    pluginRootAt('0.50.0')
  })

  test('repo activo y usuario habilitado: migracion pendiente', () => {
    commitSettings(consumer, { enabledPlugins: { [ID]: true } })
    writeJson(join(configDir, 'settings.json'), { enabledPlugins: { [ID]: true } })
    assert.match(run([]).text, /MIGRACION PENDIENTE/)
  })

  test('ya migrado: sin migracion pendiente', () => {
    commitSettings(consumer, { enabledPlugins: { [ID]: true } })
    writeJson(join(configDir, 'settings.json'), { enabledPlugins: { [ID]: false } })
    const result = run([])
    assert.doesNotMatch(result.text, /MIGRACION PENDIENTE/)
    assert.ok(result.out.includes(`  Nivel usuario (${join(configDir, 'settings.json')}): deshabilitado`))
  })

  test('repo sin activacion: aviso', () => {
    assert.match(run([]).text, /AVISO: este repo no habilita Mefisto/)
  })
})

describe('cache y repositorio', () => {
  test('sin mefisto en el cache explica como instalarlo', () => {
    const result = run([])
    assert.equal(result.status, 1)
    assert.deepEqual(result.errLines, [
      `ERROR: no se encontro ningun 'mefisto' en el cache de plugins (${cache}/*/mefisto).`,
      '       Verifica que el plugin este instalado (claude plugin install mefisto@<marketplace> --scope user',
      '       y luego claude plugin disable mefisto@<marketplace> --scope user: el repo lo habilita).',
    ])
  })

  test('sin MEFISTO_CACHE_ROOT busca el cache en la carpeta personal', () => {
    const result = run([], { env: { MEFISTO_CACHE_ROOT: '' } })
    const expected = join(work, 'home', '.claude', 'plugins', 'cache')
    assert.ok(result.errLines[0]?.endsWith(`(${expected}/*/mefisto).`))
  })

  test('un marketplace sin versiones aborta', () => {
    mkdirSync(mefistoDir(), { recursive: true })
    const result = run(['--prune', '--only', '0.1.0'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, [`ERROR: no se encontro ninguna version de mefisto en ${mefistoDir()}.`])
  })

  test('se niega en el repo de Mefisto', () => {
    mkdirSync(stateFile('.claude-plugin'))
    writeFileSync(stateFile('.claude-plugin', 'plugin.json'), '{}')
    for (const argv of [[], ['--prune', '--only', '0.1.0'], ['--disable-user']]) {
      const result = run(argv)
      assert.equal(result.status, 1)
      assert.deepEqual(result.errLines, [
        'ERROR: /mefisto:upgrade no aplica al repo de Mefisto.',
        '       scripts/update-plugin.mts es del plugin publicado y solo aplica al consumidor.',
        '       Mefisto se actualiza a si mismo por su propio flujo de release (/mefisto-release).',
      ])
      assert.deepEqual(result.log, [])
    }
  })

  test('fuera de un repo git aborta', () => {
    const outside = join(work, `no-git-${serial}`)
    mkdirSync(outside)
    const result = run([], { cwd: outside })
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ['ERROR: no estas en un repositorio git'])
  })
})

describe('linea de comando', () => {
  test('en el repo de Mefisto termina en 1 con el mensaje por stderr', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })

  test('upgrade.mts encuentra el modulo junto a el', () => {
    assert.ok(existsSync(join(SCRIPTS, 'upgrade.mts')))
    assert.ok(existsSync(SCRIPT))
  })
})
