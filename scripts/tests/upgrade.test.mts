import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { commandExists } from '../lib/cli.mts'
import { discoverRuntime } from '../lib/upgrade-runtime.mts'
import { upgrade } from '../upgrade.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'upgrade.mts')
const RUNTIME_LIB = join(REPO_ROOT, 'src', 'runtime', 'lib')
const USAGE = 'Uso: upgrade --status | --prune --only <v>[,<v>...] [--loaded <version>] | --disable-user'

let work = ''
let consumer = ''
let scripts = ''
let loadedRoots = ''
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES

function initRepo(name: string): string {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--quiet', repo])
  return repo
}

function pluginVersion(root: string, name: string, version: string): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }))
}

interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Codigo de salida que devuelve update-plugin.mts. */
  updateStatus?: number
  scriptDir?: string
  available?: string[]
}

interface Run {
  status: number
  out: string[]
  err: string[]
  /** Argumentos de cada delegacion en update-plugin.mts. */
  delegated: string[][]
}

function run(argv: string[], options: RunOptions = {}): Run {
  const result: Run = { status: -1, out: [], err: [], delegated: [] }
  const scriptDir = options.scriptDir ?? scripts
  result.status = upgrade(argv, {
    cwd: options.cwd ?? consumer,
    env: options.env ?? { MEFISTO_RUNTIME: 'claude' },
    scriptDir,
    program: 'upgrade',
    hasCommand: (command) => options.available?.includes(command) === true,
    delegate: (script, args) => {
      assert.equal(script, join(scriptDir, 'update-plugin.mts'))
      result.delegated.push(args)
      return options.updateStatus ?? 0
    },
    out: (line) => result.out.push(line),
    err: (line) => result.err.push(line),
  })
  return result
}

function claude(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MEFISTO_RUNTIME: 'claude', ...env }
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto upgrade '))
  process.env.GIT_CEILING_DIRECTORIES = work
  consumer = initRepo('consumer')
  mkdirSync(join(consumer, '.claude', 'pipeline'), { recursive: true })
  writeFileSync(join(consumer, '.claude', 'pipeline', '.plugin-root'), '/x/cache/mkt/mefisto/1.0.0')
  scripts = join(work, 'scripts')
  mkdirSync(scripts)
  writeFileSync(join(scripts, 'update-plugin.mts'), '')
  loadedRoots = join(work, 'cache', 'mefisto')
  for (const version of ['0.44.0', '0.44.1']) pluginVersion(join(loadedRoots, version), 'mefisto', version)
  pluginVersion(join(work, 'cache', 'otro', '9.9.9'), 'otro', '9.9.9')
})

after(() => {
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling
  rmSync(work, { recursive: true, force: true })
})

describe('delegacion en update-plugin.mts', () => {
  test('sin flags delega sin argumentos', () => {
    assert.deepEqual(run([]).delegated, [[]])
  })

  test('--prune reenvia --only y --loaded', () => {
    assert.deepEqual(run(['--prune', '--only', '0.8.0', '--loaded', '0.9.0']).delegated, [
      ['--prune', '--only', '0.8.0', '--loaded', '0.9.0'],
    ])
  })

  test('--prune sin --loaded no lo infiere de .plugin-root', () => {
    assert.deepEqual(run(['--prune', '--only', '0.43.0,0.44.0']).delegated, [
      ['--prune', '--only', '0.43.0,0.44.0'],
    ])
  })

  test('--disable-user delega con ese unico flag', () => {
    assert.deepEqual(run(['--disable-user']).delegated, [['--disable-user']])
  })

  test('propaga el codigo de salida de update-plugin.mts', () => {
    assert.equal(run([], { updateStatus: 7 }).status, 7)
    assert.equal(run(['--disable-user'], { updateStatus: 7 }).status, 7)
  })

  test('sin update-plugin.mts junto al script aborta', () => {
    for (const argv of [[], ['--disable-user']]) {
      const result = run(argv, { scriptDir: join(work, 'cache') })
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, ['ERROR: no se hallo update-plugin.sh junto a upgrade.sh.'])
      assert.deepEqual(result.delegated, [])
    }
  })
})

describe('MEFISTO_LOADED_ROOT', () => {
  function loaded(version: string): NodeJS.ProcessEnv {
    return claude({ MEFISTO_LOADED_ROOT: join(loadedRoots, version) })
  }

  test('una raiz valida reenvia --loaded al actualizar', () => {
    assert.deepEqual(run([], { env: loaded('0.44.1') }).delegated, [['--loaded', '0.44.1']])
    const trailing = claude({ MEFISTO_LOADED_ROOT: join(loadedRoots, '0.44.1') + sep })
    assert.deepEqual(run([], { env: trailing }).delegated, [['--loaded', '0.44.1']])
  })

  test('--prune reenvia --loaded desde la raiz', () => {
    assert.deepEqual(run(['--prune', '--only', '0.43.0'], { env: loaded('0.44.1') }).delegated, [
      ['--prune', '--only', '0.43.0', '--loaded', '0.44.1'],
    ])
  })

  test('un --loaded explicito gana', () => {
    const result = run(['--prune', '--only', '0.8.0', '--loaded', '0.9.0'], { env: loaded('0.44.1') })
    assert.deepEqual(result.delegated, [['--prune', '--only', '0.8.0', '--loaded', '0.9.0']])
  })

  test('una raiz vacia, sin sustituir, con .., inexistente, ajena o relativa se ignora', () => {
    const roots = [
      '',
      '${CLAUDE_PLUGIN_ROOT}',
      `${join(loadedRoots, '0.44.0')}${sep}..${sep}0.44.1`,
      join(loadedRoots, '9.9.9'),
      join(work, 'cache', 'otro', '9.9.9'),
      join('relativa', '0.44.1'),
    ]
    for (const root of roots) {
      assert.deepEqual(run([], { env: claude({ MEFISTO_LOADED_ROOT: root }) }).delegated, [[]], root)
    }
  })
})

describe('--status', () => {
  test('imprime el JSON de schemaVersion 3 sin delegar', () => {
    const result = run(['--status'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.out, ['{"schemaVersion":3,"runtime":"claude","installedVersion":"1.0.0"}'])
    assert.deepEqual(result.delegated, [])
  })

  test('sin .plugin-root la version instalada es null', () => {
    const result = run(['--status'], { cwd: initRepo('consumer-sin-root') })
    assert.deepEqual(result.out, ['{"schemaVersion":3,"runtime":"claude","installedVersion":null}'])
  })
})

describe('argumentos', () => {
  test('un argumento desconocido se rechaza con el uso y sin delegar', () => {
    for (const flag of ['--align-peer', '--keep']) {
      const result = run([flag])
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [`ERROR: argumento desconocido '${flag}'\n${USAGE}`])
      assert.deepEqual(result.delegated, [])
    }
  })

  test('--prune --keep no poda', () => {
    const result = run(['--prune', '--keep', '3'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.delegated, [])
  })

  test('--loaded y --only exigen un valor', () => {
    for (const argv of [['--loaded'], ['--loaded', '']]) {
      assert.deepEqual(run(argv).err, ['ERROR: --loaded requiere una version.'])
    }
    const only = run(['--prune', '--only'])
    assert.equal(only.status, 1)
    assert.deepEqual(only.err, ['ERROR: --only requiere una lista de versiones.'])
    assert.deepEqual(only.delegated, [])
  })

  test('--help imprime el uso y termina en 0 sin delegar', () => {
    for (const flag of ['-h', '--help']) {
      const result = run([flag])
      assert.equal(result.status, 0)
      assert.deepEqual(result.err, [USAGE])
      assert.deepEqual(result.delegated, [])
    }
  })
})

describe('runtime', () => {
  test('un runtime distinto de claude aborta sin delegar', () => {
    for (const argv of [['--status'], [], ['--prune', '--only', '0.8.0'], ['--disable-user']]) {
      const result = run(argv, { env: { MEFISTO_RUNTIME: 'fake' } })
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, ["ERROR: runtime 'fake' no soportado por upgrade (solo claude)."])
      assert.deepEqual(result.out, [])
      assert.deepEqual(result.delegated, [])
    }
  })

  test('sin MEFISTO_RUNTIME ni libreria de runtimes pide fijarlo', () => {
    const result = run(['--status'], { env: {} })
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ['ERROR: fija MEFISTO_RUNTIME.'])
  })

  test('sin MEFISTO_RUNTIME descubre el unico adaptador disponible', () => {
    const scriptDir = join(work, 'dist', 'scripts')
    const lib = join(work, 'dist', 'src', 'runtime', 'lib')
    mkdirSync(scriptDir, { recursive: true })
    mkdirSync(lib, { recursive: true })
    for (const name of ['update-plugin.mts', join('..', 'src', 'runtime', 'lib', 'mefisto-runtime.sh')]) {
      writeFileSync(join(scriptDir, name), '')
    }
    writeFileSync(join(lib, 'runtime-claude.sh'), '')

    const found = run(['--status'], { env: {}, scriptDir, available: ['claude'] })
    assert.deepEqual(found.out, ['{"schemaVersion":3,"runtime":"claude","installedVersion":"1.0.0"}'])

    const missing = run([], { env: {}, scriptDir })
    assert.equal(missing.status, 1)
    assert.deepEqual(missing.err, ['ERROR: no se pudo resolver el runtime'])
    assert.deepEqual(missing.delegated, [])
  })
})

describe('discoverRuntime', () => {
  test('ignora los adaptadores sin prueba y los nombres fuera de patron', () => {
    const lib = join(work, 'adaptadores')
    mkdirSync(lib)
    for (const name of ['runtime-claude.sh', 'runtime-fake.sh', 'runtime-otro.sh', 'runtime-Mal.sh', 'otro.sh']) {
      writeFileSync(join(lib, name), '')
    }
    assert.deepEqual(discoverRuntime(lib, {}, (command) => command === 'claude'), { runtime: 'claude' })
    assert.deepEqual(discoverRuntime(lib, { MEFISTO_FAKE_AVAILABLE: '1' }, () => false), { runtime: 'fake' })
    assert.deepEqual(discoverRuntime(lib, {}, () => false), {
      error:
        'no se detecto ningun runtime disponible entre los adaptadores (claude, fake, otro): fija MEFISTO_RUNTIME o --runtime',
    })
    assert.deepEqual(discoverRuntime(lib, { MEFISTO_FAKE_AVAILABLE: '1' }, () => true), {
      error:
        'se detectaron varios runtimes disponibles (claude fake): fija MEFISTO_RUNTIME o --runtime para desambiguar',
    })
    assert.deepEqual(discoverRuntime(join(lib, 'no-existe'), {}, () => true), {
      error: 'no se detecto ningun runtime disponible entre los adaptadores (): fija MEFISTO_RUNTIME o --runtime',
    })
  })

  // Paridad con la gemela en bash: los dos lados resuelven lo mismo con el mismo entorno.
  test('coincide con mefisto_resolve_runtime', { skip: process.platform === 'win32' }, () => {
    const bin = join(work, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
    chmodSync(join(bin, 'claude'), 0o755)
    const probe = 'source "$1/mefisto-runtime.sh"; mefisto_resolve_runtime || printf "%s\\n" "error: $MEFISTO_RUNTIME_ERROR"'
    for (const extra of [{}, { MEFISTO_FAKE_AVAILABLE: '1' }]) {
      for (const path of [`${bin}${delimiter}/usr/bin${delimiter}/bin`, `/usr/bin${delimiter}/bin`]) {
        const env = { PATH: path, ...extra }
        const bash = execFileSync('bash', ['-c', probe, 'bash', RUNTIME_LIB], { env, encoding: 'utf8' })
        const found = discoverRuntime(RUNTIME_LIB, env, (command) => commandExists(command, env))
        assert.equal('runtime' in found ? found.runtime : `error: ${found.error}`, bash.trimEnd())
      }
    }
  })
})

describe('guard del consumidor', () => {
  test('se niega en el repo de Mefisto sin delegar', () => {
    const mefisto = initRepo('mefisto')
    pluginVersion(mefisto, 'mefisto', '1.0.0')
    for (const argv of [['--status'], [], ['--disable-user']]) {
      const result = run(argv, { cwd: mefisto })
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [
        [
          'ERROR: /mefisto:upgrade no aplica al repo de Mefisto.',
          '       scripts/upgrade.sh es del plugin publicado y solo aplica al consumidor.',
          '       Mefisto se actualiza a si mismo por su propio flujo de release (/mefisto-release).',
        ].join('\n'),
      ])
      assert.deepEqual(result.delegated, [])
    }
  })

  test('fuera de un repo git aborta sin delegar', () => {
    const outside = join(work, 'no-git')
    mkdirSync(outside)
    const result = run([], { cwd: outside })
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ['ERROR: no estas en un repositorio git'])
    assert.deepEqual(result.delegated, [])
  })
})

describe('linea de comando', () => {
  function cli(args: string[], cwd: string) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, MEFISTO_RUNTIME: 'claude', MEFISTO_LOADED_ROOT: '' },
    })
  }

  test('--status imprime una linea JSON por stdout', () => {
    const result = cli(['--status'], consumer)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '{"schemaVersion":3,"runtime":"claude","installedVersion":"1.0.0"}\n')
    assert.equal(result.stderr, '')
  })

  test('el uso nombra el script y va por stderr', () => {
    const result = cli(['--no-existe'], consumer)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(
      result.stderr,
      `ERROR: argumento desconocido '--no-existe'\n${USAGE.replace('upgrade', realpathSync(SCRIPT))}\n`,
    )
  })

  test('en el repo de Mefisto termina en 1', () => {
    const result = cli([], REPO_ROOT)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })
})
