import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { commandExists } from '../lib/cli.mts'
import {
  addedLines,
  newKeys,
  parseDotnet,
  parseShell,
  parseTerraform,
  runProgram,
  sortKeys,
  suppressionKeys,
  warningsDiff,
} from '../warnings-diff.mts'
import type { RunOptions, RunResult } from '../warnings-diff.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'warnings-diff.mts')
const FIXTURES = join(HERE, 'fixtures', 'warnings-diff')
const UNUSED = 'appears unused. Verify use (or export if used externally).'
const CD = "Use 'cd ... || exit' or 'cd ... || return' in case cd fails."
const ISOLATED_ENV = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'WARNINGS_DIFF_FIXTURE_DIR',
  'TF_PLUGIN_CACHE_DIR',
]
const savedEnv = new Map(ISOLATED_ENV.map((key) => [key, process.env[key]]))

let work = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

interface Repo {
  dir: string
  base: string
}

function newRepo(): Repo {
  const dir = mkdtempSync(join(work, 'repo '))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(join(dir, 'a.sh'), '#!/usr/bin/env bash\nfoo=1\ncd /tmp\necho ok\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return { dir, base: git(dir, 'rev-parse', 'HEAD') }
}

function worktreeCount(repo: Repo): number {
  return git(repo.dir, 'worktree', 'list').split('\n').length
}

function times(source: string): RegExp {
  return new RegExp(`^warnings-diff: base [0-9]+s \\(${source}\\), actual [0-9]+s$`, 'm')
}

type Tool = (args: string[], options: RunOptions) => Partial<RunResult>

// shellcheck simulado: una asignacion al inicio de linea es SC2034 y un `cd` sin guarda es SC2164.
const shellcheck: Tool = (args, options) => {
  const file = args.at(-1) ?? ''
  const lines = readFileSync(join(options.cwd ?? '', file), 'utf8').split('\n')
  const found = lines.flatMap((line, index) => {
    const variable = /^([a-z]+)=/.exec(line)?.[1]
    if (variable !== undefined) return [`${file}:${index + 1}:1: warning: ${variable} ${UNUSED} [SC2034]`]
    return line.startsWith('cd ') ? [`${file}:${index + 1}:1: warning: ${CD} [SC2164]`] : []
  })
  return { status: found.length > 0 ? 1 : 0, stdout: found.map((line) => `${line}\n`).join('') }
}

interface Outcome {
  status: number
  stdout: string
  stderr: string
  /** Cada programa invocado, con sus argumentos. */
  commands: string[][]
}

interface RunSetup {
  tools?: Record<string, Tool>
  env?: NodeJS.ProcessEnv
  clock?: number[]
}

function diff(repo: Repo, argv: string[], setup: RunSetup = {}): Outcome {
  const tools = setup.tools ?? { shellcheck }
  const clock = [...(setup.clock ?? [])]
  const outcome: Outcome = { status: -1, stdout: '', stderr: '', commands: [] }
  outcome.status = warningsDiff(argv, {
    cwd: repo.dir,
    env: { ...process.env, ...setup.env },
    hasCommand: (command) => command in tools,
    run: (command, args, options = {}) => {
      outcome.commands.push([command, ...args])
      const tool = tools[command]
      if (tool === undefined) return runProgram(command, args, options)
      return { status: 0, stdout: '', signal: null, ...tool(args, options) }
    },
    out: (text) => {
      outcome.stdout += text
    },
    err: (text) => {
      outcome.stderr += text
    },
    now: () => clock.shift() ?? Date.now(),
  })
  return outcome
}

function cli(repo: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(work, 'fixture '))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto warnings diff ')))
  writeFileSync(join(work, 'gitconfig-vacio'), '')
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: join(work, 'gitconfig-vacio'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  })
  delete process.env.WARNINGS_DIFF_FIXTURE_DIR
  delete process.env.TF_PLUGIN_CACHE_DIR
})

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(work, { recursive: true, force: true })
})

describe('toolchain shell', () => {
  test('un warning nuevo sale como NEW y termina en 2', () => {
    const repo = newRepo()
    appendFileSync(join(repo.dir, 'a.sh'), 'bar=2\n')
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, `NEW shell a.sh SC2034 bar ${UNUSED}\nwarnings nuevos: 1\n`)
  })

  test('un warning que solo cambia de linea no es nuevo', () => {
    const repo = newRepo()
    writeFileSync(join(repo.dir, 'a.sh'), '#!/usr/bin/env bash\ncd /tmp\necho ok\n\nfoo=1\n')
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base])
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'warnings nuevos: 0\n')
  })

  test('un .sh nuevo sin commitear se analiza', () => {
    const repo = newRepo()
    writeFileSync(join(repo.dir, 'b.sh'), '#!/usr/bin/env bash\nzed=1\n')
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base])
    assert.equal(result.status, 2)
    assert.match(result.stdout, /^NEW shell b\.sh SC2034 /m)
  })

  test('el duplicado de una clave existente cuenta una vez', () => {
    const repo = newRepo()
    appendFileSync(join(repo.dir, 'a.sh'), 'cd /tmp\n')
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, `NEW shell a.sh SC2164 ${CD}\nwarnings nuevos: 1\n`)
  })

  test('las supresiones anadidas en un .sh y en .shellcheckrc cuentan como nuevas', () => {
    const repo = newRepo()
    appendFileSync(join(repo.dir, 'a.sh'), '# shellcheck disable=SC2086\n')
    writeFileSync(join(repo.dir, '.shellcheckrc'), 'disable=SC2034\n')
    git(repo.dir, 'add', '.shellcheckrc')
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base])
    assert.equal(result.status, 2)
    assert.equal(
      result.stdout,
      [
        'NEW shell .shellcheckrc SUPPRESSION supresion anadida: disable=SC2034',
        'NEW shell a.sh SUPPRESSION supresion anadida: # shellcheck disable=SC2086',
        'warnings nuevos: 2',
        '',
      ].join('\n'),
    )
  })

  test('--path acota el analisis al subdirectorio', () => {
    const repo = newRepo()
    mkdirSync(join(repo.dir, 'sub'))
    writeFileSync(join(repo.dir, 'sub', 'c.sh'), '#!/usr/bin/env bash\nqux=1\n')
    appendFileSync(join(repo.dir, 'a.sh'), 'bar=2\n')
    for (const path of ['sub', './sub/']) {
      const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base, '--path', path])
      assert.equal(result.status, 2)
      assert.equal(result.stdout, `NEW shell sub/c.sh SC2034 qux ${UNUSED}\nwarnings nuevos: 1\n`)
    }
    assert.ok(existsSync(join(repo.dir, '.mefisto', 'pipeline', 'warnings-baseline', `shell-${repo.base}-sub.txt`)))
  })

  test('sin --base usa el merge-base con origin/main', () => {
    const repo = newRepo()
    assert.equal(
      diff(repo, ['--toolchain', 'shell']).stderr,
      'ERROR: no se pudo resolver la base (git merge-base HEAD origin/main); usa --base\n',
    )
    git(repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.base)
    appendFileSync(join(repo.dir, 'a.sh'), 'bar=2\n')
    git(repo.dir, 'commit', '-q', '-am', 'cambio')
    const result = diff(repo, ['--toolchain', 'shell'])
    assert.equal(result.status, 2)
    assert.ok(existsSync(join(repo.dir, '.mefisto', 'pipeline', 'warnings-baseline', `shell-${repo.base}-all.txt`)))
  })

  test('con el shellcheck real', { skip: !commandExists('shellcheck') }, () => {
    const repo = newRepo()
    appendFileSync(join(repo.dir, 'a.sh'), 'bar=2\n')
    const result = cli(repo.dir, ['--toolchain', 'shell', '--base', repo.base])
    assert.equal(result.status, 2)
    assert.match(result.stdout, /^NEW shell a\.sh SC2034 bar /)
    assert.match(result.stdout, /^warnings nuevos: 1$/m)
    assert.match(result.stderr, times('build'))
    assert.equal(worktreeCount(repo), 1)
  })
})

describe('cache de la base y worktree temporal', () => {
  let repo: Repo = { dir: '', base: '' }
  let cache = ''

  function worktreeAdds(result: Outcome): string[][] {
    return result.commands.filter((command) => command.includes('worktree') && command.includes('add'))
  }

  before(() => {
    repo = newRepo()
    cache = join(repo.dir, '.mefisto', 'pipeline', 'warnings-baseline', `shell-${repo.base}-all.txt`)
  })

  test('la primera corrida mide la base en un worktree y escribe el cache', () => {
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base], { clock: [10_000, 13_999, 16_000] })
    assert.equal(result.status, 0)
    assert.equal(readFileSync(cache, 'utf8'), `shell|a.sh|SC2034|foo ${UNUSED}\nshell|a.sh|SC2164|${CD}\n`)
    assert.equal(result.stderr, 'warnings-diff: base 3s (build), actual 3s\n')
    assert.equal(worktreeAdds(result).length, 1)
  })

  test('la segunda corrida reutiliza el cache sin crear worktree', () => {
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base])
    assert.equal(result.status, 0)
    assert.deepEqual(worktreeAdds(result), [])
    assert.match(result.stderr, times('cache'))
  })

  test('no deja worktrees temporales', () => {
    assert.equal(worktreeCount(repo), 1)
  })

  test('una base invalida termina en 1 sin worktree residual', () => {
    const result = diff(repo, ['--toolchain', 'shell', '--base', 'deadbeef'])
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: base invalida: deadbeef\n')
    assert.equal(result.stdout, '')
    assert.equal(worktreeCount(repo), 1)
  })

  test('un error tras crear el worktree termina en 1 y lo elimina', () => {
    rmSync(cache)
    const result = diff(repo, ['--toolchain', 'shell', '--base', repo.base], { tools: {} })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: shellcheck no esta instalado\n')
    const [added] = worktreeAdds(result)
    assert.ok(added !== undefined)
    assert.equal(existsSync(added.at(-2) ?? ''), false)
    assert.equal(worktreeCount(repo), 1)
    assert.equal(existsSync(cache), false)
  })
})

describe('argumentos y guard', () => {
  const usage = 'Uso: scripts/warnings-diff.sh --toolchain <t> [--base <sha>] [--path <dir>]\n'

  test('una toolchain no registrada termina en 1 con el uso', () => {
    const result = diff(newRepo(), ['--toolchain', 'nope', '--base', 'HEAD'])
    assert.equal(result.status, 1)
    assert.equal(result.stderr, `ERROR: toolchain no soportada: nope\n${usage}`)
  })

  test('sin --toolchain termina en 1 con el uso', () => {
    const repo = newRepo()
    assert.equal(diff(repo, []).stderr, `ERROR: falta --toolchain\n${usage}`)
    assert.equal(diff(repo, ['--toolchain']).stderr, usage)
    assert.equal(diff(repo, ['--otro', 'x']).stderr, `ERROR: argumento desconocido: --otro\n${usage}`)
    assert.equal(diff(repo, ['--otro', 'x']).status, 1)
  })

  test('terraform sin --path termina en 1 con el uso', () => {
    const repo = newRepo()
    const result = diff(repo, ['--toolchain', 'terraform', '--base', repo.base])
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      `ERROR: --toolchain terraform requiere --path <directorio del entorno>\n${usage}`,
    )
  })

  test('en el repo de Mefisto se niega antes de leer los argumentos', () => {
    for (const args of [[], ['--toolchain', 'shell']]) {
      const result = cli(REPO_ROOT, args)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.equal(
        result.stderr,
        'ERROR: scripts/warnings-diff.sh es del plugin publicado y solo aplica al consumidor.\nEstas en el repo de Mefisto.\n',
      )
    }
  })

  test('fuera de un repo git termina en 1', () => {
    const outside = mkdtempSync(join(work, 'sin repo '))
    const result = cli(outside, ['--toolchain', 'shell'], { GIT_CEILING_DIRECTORIES: work })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: no estas en un repositorio git\n')
  })
})

describe('WARNINGS_DIFF_FIXTURE_DIR', () => {
  function fixture(repo: Repo, toolchain: string, dir: string, extra: string[] = []) {
    return cli(repo.dir, ['--toolchain', toolchain, '--base', repo.base, ...extra], {
      WARNINGS_DIFF_FIXTURE_DIR: dir,
    })
  }

  test('shell: lee la salida cruda de cada lado sin worktree ni cache', () => {
    const repo = newRepo()
    const dir = fixtureDir({
      'base.out': `a.sh:2:1: warning: foo ${UNUSED} [SC2034]\n`,
      'current.out': `a.sh:2:1: warning: foo ${UNUSED} [SC2034]\na.sh:3:1: warning: bar ${UNUSED} [SC2034]\n`,
    })
    const result = fixture(repo, 'shell', dir)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, `NEW shell a.sh SC2034 bar ${UNUSED}\nwarnings nuevos: 1\n`)
    assert.match(result.stderr, times('build'))
    assert.equal(existsSync(join(repo.dir, '.mefisto')), false)
  })

  describe('dotnet', () => {
    const dotnet = join(FIXTURES, 'dotnet')
    let repo: Repo = { dir: '', base: '' }

    before(() => {
      repo = newRepo()
    })

    test('un warning solo en el actual sale como NEW y termina en 2', () => {
      const result = fixture(repo, 'dotnet', join(dotnet, 'new'))
      assert.equal(result.status, 2)
      assert.equal(
        result.stdout,
        "NEW dotnet Poc/Class1.cs CS0168 The variable 'x' is declared but never used\nwarnings nuevos: 1\n",
      )
      assert.match(result.stderr, times('build'))
    })

    test('los mismos warnings en otras lineas no son nuevos, y los tiempos salen igual', () => {
      const result = fixture(repo, 'dotnet', join(dotnet, 'moved'))
      assert.equal(result.status, 0)
      assert.equal(result.stdout, 'warnings nuevos: 0\n')
      assert.match(result.stderr, times('build'))
    })

    test('el prefijo de nodo y las rutas absolutas distintas dan la misma clave', () => {
      assert.equal(fixture(repo, 'dotnet', join(dotnet, 'abs')).status, 0)
    })

    test('las ubicaciones (l) y (l,c,l,c) y el warning sin linea dan la misma clave', () => {
      const cs = "warning CS0168: The variable 'x' is declared but never used [/w/Poc/Poc.csproj]"
      const nu = '/w/Poc/Poc.csproj : warning NU1603: Poc depends on X (>= 1.0.0) but X 1.0.0 was not found [/w/Poc/Poc.csproj]'
      const dir = fixtureDir({
        'base.out': `1:7>/w/Poc/Class1.cs(4): ${cs}\n1:7>${nu}\n`,
        'current.out': `/w/Poc/Class1.cs(14,27,14,28) : ${cs}\n${nu}\n`,
        'base.root': '/w\n',
        'current.root': '/w\n',
      })
      assert.equal(fixture(repo, 'dotnet', dir).status, 0)
    })

    test('una base que no compila termina en 1', () => {
      const result = fixture(repo, 'dotnet', join(dotnet, 'fail-base'))
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /^ERROR: la base no compila\n/)
    })

    test('un arbol actual que no compila termina en 1', () => {
      const result = fixture(repo, 'dotnet', join(dotnet, 'fail-current'))
      assert.equal(result.status, 1)
      assert.match(
        result.stderr,
        /^ERROR: el arbol actual no compila: corrige los errores antes de medir warnings\n/,
      )
    })

    test('la consola con errores muestra hasta 20 y la ruta del log', () => {
      const errors = Array.from(
        { length: 25 },
        (_, i) => `/w/Poc/Class1.cs(${i + 1},1): error CS1002: ; expected [/w/Poc/Poc.csproj]\n`,
      )
      const dir = fixtureDir({ 'current.out': '', 'base.console': `${errors.join('')}Build FAILED.\n` })
      for (const name of readdirSync(join(dotnet, 'fail-base'))) {
        if (name !== 'current.out') copyFileSync(join(dotnet, 'fail-base', name), join(dir, name))
      }
      const result = fixture(repo, 'dotnet', dir)
      assert.equal(result.status, 1)
      assert.equal(
        result.stderr,
        `ERROR: la base no compila\n${errors.slice(0, 20).join('')}log completo del build: ${join(dir, 'base.console')}\n`,
      )
      assert.equal(existsSync(join(repo.dir, '.mefisto', 'pipeline', 'logs')), false)

      const lines = Array.from({ length: 30 }, (_, i) => `linea ${i + 1}\n`)
      writeFileSync(join(dir, 'base.console'), lines.join(''))
      assert.equal(
        fixture(repo, 'dotnet', dir).stderr,
        `ERROR: la base no compila\n${lines.slice(10).join('')}log completo del build: ${join(dir, 'base.console')}\n`,
      )

      writeFileSync(join(dir, 'base.console'), '')
      assert.equal(
        fixture(repo, 'dotnet', dir).stderr,
        `ERROR: la base no compila\n(la consola del build esta vacia) log: ${join(dir, 'base.console')}\n`,
      )
    })

    test('las supresiones anadidas cuentan como nuevas', () => {
      const dirty = newRepo()
      writeFileSync(join(dirty.dir, 'A.cs'), '#pragma warning disable CS0168\n')
      writeFileSync(
        join(dirty.dir, 'P.csproj'),
        '<Project><PropertyGroup><NoWarn>CS0168</NoWarn></PropertyGroup></Project>\n',
      )
      writeFileSync(join(dirty.dir, '.editorconfig'), 'dotnet_diagnostic.CS0168.severity = none\n')
      const result = fixture(dirty, 'dotnet', join(dotnet, 'abs'))
      assert.equal(result.status, 2)
      assert.equal(
        result.stdout,
        [
          'NEW dotnet .editorconfig SUPPRESSION supresion anadida: dotnet_diagnostic.CS0168.severity = none',
          'NEW dotnet A.cs SUPPRESSION supresion anadida: #pragma warning disable CS0168',
          'NEW dotnet P.csproj SUPPRESSION supresion anadida: <Project><PropertyGroup><NoWarn>CS0168</NoWarn></PropertyGroup></Project>',
          'warnings nuevos: 3',
          '',
        ].join('\n'),
      )
    })
  })

  describe('terraform', () => {
    const terraform = join(FIXTURES, 'terraform')
    const path = ['--path', 'infra/environments/dev']
    let repo: Repo = { dir: '', base: '' }

    before(() => {
      repo = newRepo()
    })

    test('un warning solo en el actual sale como NEW y termina en 2', () => {
      const result = fixture(repo, 'terraform', join(terraform, 'new'), path)
      assert.equal(result.status, 2)
      assert.equal(
        result.stdout,
        'NEW terraform main.tf Deprecated attribute The attribute "x" is deprecated.\nwarnings nuevos: 1\n',
      )
    })

    test('el mismo warning en otra linea no es nuevo', () => {
      const result = fixture(repo, 'terraform', join(terraform, 'moved'), path)
      assert.equal(result.status, 0)
      assert.match(result.stderr, times('build'))
    })

    test('los diagnosticos de error no cuentan como warnings', () => {
      assert.equal(fixture(repo, 'terraform', join(terraform, 'errors-only'), path).status, 0)
    })

    test('valid=false termina en 1 y lista los errores', () => {
      const result = fixture(repo, 'terraform', join(terraform, 'invalid'), path)
      assert.equal(result.status, 1)
      assert.equal(
        result.stderr,
        [
          'ERROR: terraform validate reporta valid=false en el lado current; corrige el HCL antes de medir warnings:',
          '  error: main.tf: Reference to undeclared input variable: An input variable with the name "y" has not been declared.',
          '',
        ].join('\n'),
      )
    })

    test('una salida que no es el JSON de validate termina en 1', () => {
      const dir = fixtureDir({ 'base.out': 'no es json\n' })
      assert.equal(
        fixture(repo, 'terraform', dir, path).stderr,
        'ERROR: terraform validate no devolvio JSON valido en el lado base\n',
      )
    })
  })
})

describe('toolchain terraform', () => {
  const VALID = '{"valid":true,"warning_count":0,"error_count":0,"diagnostics":[]}\n'
  const args = (repo: Repo): string[] => ['--toolchain', 'terraform', '--base', repo.base, '--path', 'infra/environments/dev']

  function infraRepo(): Repo {
    const repo = newRepo()
    mkdirSync(join(repo.dir, 'infra', 'environments', 'dev'), { recursive: true })
    writeFileSync(join(repo.dir, 'infra', 'environments', 'dev', 'main.tf'), '# tf\n')
    git(repo.dir, 'add', '-A')
    git(repo.dir, 'commit', '-q', '-m', 'infra')
    return { dir: repo.dir, base: git(repo.dir, 'rev-parse', 'HEAD') }
  }

  function terraform(log: string[], initStatus = 0): Tool {
    return (toolArgs, options) => {
      log.push(`${toolArgs.join(' ')} cache=${options.env?.TF_PLUGIN_CACHE_DIR ?? 'UNSET'} pwd=${basename(options.cwd ?? '')}`)
      if (toolArgs[0] !== 'init') return { stdout: VALID }
      writeFileSync(options.outputFile ?? '', 'salida de init\n')
      return { status: initStatus }
    }
  }

  test('sin TF_PLUGIN_CACHE_DIR lo fija bajo .mefisto y crea el directorio', () => {
    const repo = infraRepo()
    const log: string[] = []
    const result = diff(repo, args(repo), { tools: { terraform: terraform(log) } })
    const pluginCache = join(repo.dir, '.mefisto', 'pipeline', 'terraform-plugin-cache')
    assert.equal(result.status, 0)
    assert.ok(existsSync(pluginCache))
    assert.deepEqual(log, [
      `init -backend=false -input=false cache=${pluginCache} pwd=dev`,
      `validate -json -no-color cache=${pluginCache} pwd=dev`,
      `init -backend=false -input=false cache=${pluginCache} pwd=dev`,
      `validate -json -no-color cache=${pluginCache} pwd=dev`,
    ])
  })

  test('un TF_PLUGIN_CACHE_DIR definido se conserva', () => {
    const repo = infraRepo()
    const log: string[] = []
    const custom = join(work, 'mi-cache')
    const result = diff(repo, args(repo), {
      tools: { terraform: terraform(log) },
      env: { TF_PLUGIN_CACHE_DIR: custom },
    })
    assert.equal(result.status, 0)
    assert.equal(log[0], `init -backend=false -input=false cache=${custom} pwd=dev`)
    assert.equal(existsSync(join(repo.dir, '.mefisto', 'pipeline', 'terraform-plugin-cache')), false)
  })

  test('un init fallido termina en 1 con su salida', () => {
    const repo = infraRepo()
    const result = diff(repo, args(repo), { tools: { terraform: terraform([], 1) } })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: terraform init fallo en el lado base:\nsalida de init\n')
    assert.equal(worktreeCount(repo), 1)
  })

  test('un --path que no existe en la base termina en 1', () => {
    const repo = newRepo()
    mkdirSync(join(repo.dir, 'nuevo'))
    const result = diff(repo, ['--toolchain', 'terraform', '--base', repo.base, '--path', 'nuevo'], {
      tools: { terraform: terraform([]) },
    })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: --path no existe en el lado base: nuevo\n')
  })
})

describe('toolchain dotnet', () => {
  // dotnet simulado: un warning por cada .cs de la raiz; `Roto.cs` rompe el build.
  const dotnet: Tool = (args, options) => {
    const root = options.cwd ?? ''
    const logger = args.find((arg) => arg.startsWith('-flp:logfile=')) ?? ''
    const log = logger.slice('-flp:logfile='.length).replace(/;warningsonly$/, '')
    const sources = readdirSync(root).filter((name) => name.endsWith('.cs'))
    if (sources.includes('Roto.cs')) {
      writeFileSync(options.outputFile ?? '', `${join(root, 'Roto.cs')}(1,1): error CS1002: ; expected\nBuild FAILED.\n`)
      return { status: 1 }
    }
    writeFileSync(options.outputFile ?? '', 'Build succeeded.\n')
    writeFileSync(
      log,
      sources.map((name) => `  1>${join(root, name)}(3,4): warning CS0168: sin usar [${join(root, 'P.csproj')}]\n`).join(''),
    )
    return {}
  }

  function csRepo(): Repo {
    const repo = newRepo()
    writeFileSync(join(repo.dir, 'A.cs'), 'x\n')
    git(repo.dir, 'add', '-A')
    git(repo.dir, 'commit', '-q', '-m', 'cs')
    return { dir: repo.dir, base: git(repo.dir, 'rev-parse', 'HEAD') }
  }

  test('compila cada lado sin incremental y relativiza las rutas a la raiz del lado', () => {
    const repo = csRepo()
    writeFileSync(join(repo.dir, 'B.cs'), 'y\n')
    const result = diff(repo, ['--toolchain', 'dotnet', '--base', repo.base], { tools: { dotnet } })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, 'NEW dotnet B.cs CS0168 sin usar\nwarnings nuevos: 1\n')
    const builds = result.commands.filter(([command]) => command === 'dotnet')
    assert.equal(builds.length, 2)
    assert.equal(normalize(builds[1]?.[2] ?? ''), repo.dir)
    assert.deepEqual(builds[1]?.slice(3, 7), ['-nologo', '--no-incremental', '-tl:off', '-fl'])
    assert.match(builds[1]?.[7] ?? '', /^-flp:logfile=.*build-current\.log;warningsonly$/)
    const logs = join(repo.dir, '.mefisto', 'pipeline', 'logs')
    for (const side of ['base', 'current']) {
      assert.equal(readFileSync(join(logs, `warnings-diff-dotnet-${side}.log`), 'utf8'), 'Build succeeded.\n')
    }
  })

  test('un lado que no compila muestra el error de la consola y la ruta del log', () => {
    const repo = csRepo()
    writeFileSync(join(repo.dir, 'Roto.cs'), 'z\n')
    const result = diff(repo, ['--toolchain', 'dotnet', '--base', repo.base], { tools: { dotnet } })
    const log = join(repo.dir, '.mefisto', 'pipeline', 'logs', 'warnings-diff-dotnet-current.log')
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      [
        'ERROR: el arbol actual no compila: corrige los errores antes de medir warnings',
        `${join(repo.dir, 'Roto.cs')}(1,1): error CS1002: ; expected`,
        `log completo del build: ${log}`,
        '',
      ].join('\n'),
    )
    assert.equal(worktreeCount(repo), 1)
  })

  test('--path apunta el build al subdirectorio', () => {
    const repo = csRepo()
    mkdirSync(join(repo.dir, 'src'))
    const result = diff(repo, ['--toolchain', 'dotnet', '--base', repo.base, '--path', 'src'], { tools: { dotnet } })
    assert.equal(result.commands.findLast(([command]) => command === 'dotnet')?.[2], join(repo.dir, 'src'))
  })
})

describe('piezas del diferencial', () => {
  test('parseShell normaliza la ruta y descarta lo que no es un hallazgo', () => {
    const raw = [
      './sub/a.sh:3:1: warning: bar [x] sobra. [SC2034]',
      'b.sh:1:1: error: boom | pipe [SC1000]\r',
      'b.sh:1:1: note: una nota [SC1001]',
      'basura',
    ].join('\n')
    assert.deepEqual(parseShell(raw), ['shell|sub/a.sh|SC2034|bar [x] sobra.', 'shell|b.sh|SC1000|boom | pipe'])
  })

  test('parseDotnet quita prefijo de nodo, raiz, proyecto y ubicacion', () => {
    const raw = [
      '  12>/w/a b/C.cs(1,2-3) : warning CA1000: con [corchetes] dentro [/w/p.csproj]',
      '/fisica/C.cs(9): warning CS1: desde la raiz fisica\r',
      'MSBUILD : warning MSB1234: sin archivo',
      '/w/x.cs(3,4): error CS1: no es un warning',
      'ultima sin salto: warning XX1: fin',
    ].join('\n')
    assert.deepEqual(parseDotnet(raw, '/w/', '/fisica'), [
      'dotnet|a b/C.cs|CA1000|con [corchetes] dentro',
      'dotnet|C.cs|CS1|desde la raiz fisica',
      'dotnet|MSBUILD|MSB1234|sin archivo',
      'dotnet|ultima sin salto|XX1|fin',
    ])
  })

  test('parseTerraform neutraliza | y los saltos de linea', () => {
    const raw = JSON.stringify({
      valid: true,
      diagnostics: [
        { severity: 'warning', summary: 'S|um', detail: 'uno\r\n\ndos | x', range: { filename: 'a|b.tf' } },
        { severity: 'warning', summary: 'Sin rango ni detalle' },
        { severity: 'warning', detail: 'sin summary', range: { filename: null } },
        { severity: 'error', summary: 'E' },
      ],
    })
    assert.deepEqual(parseTerraform(raw), [
      'terraform|a/b.tf|S/um|uno dos | x',
      'terraform|-|Sin rango ni detalle|',
      'terraform|-|-|sin summary',
    ])
    assert.deepEqual(parseTerraform('no es json'), [])
  })

  test('sortKeys ordena por bytes y newKeys resta como multiconjunto', () => {
    assert.deepEqual(sortKeys(['b', 'a|z', 'a', 'Z', 'ñ', 'a b']), ['Z', 'a', 'a b', 'a|z', 'b', 'ñ'])
    assert.deepEqual(newKeys(['a', 'a', 'b'], ['a', 'a', 'a', 'b', 'c', 'c']), ['a', 'c', 'c'])
  })

  test('addedLines recoge las lineas + de cada archivo y omite los borrados', () => {
    const patch = [
      'diff --git a/a.sh b/a.sh',
      '--- a/a.sh',
      '+++ b/a.sh',
      '@@ -1,0 +2 @@',
      '+nueva',
      '-vieja',
      '++++ no es cabecera',
      'diff --git a/b.sh b/b.sh',
      '--- a/b.sh',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-borrada',
      '+imposible',
    ].join('\n')
    assert.deepEqual(addedLines(patch), [
      ['a.sh', 'nueva'],
      ['a.sh', '+++ no es cabecera'],
    ])
  })

  test('suppressionKeys casa cada patron contra archivo:linea y recorta el mensaje', () => {
    const patterns = [/shellcheck[ \t]+disable=/, /(?:^|\/)\.shellcheckrc:disable=/]
    assert.deepEqual(
      suppressionKeys('shell', patterns, [
        ['a.sh', '\t\t# shellcheck   disable=SC2086 \t'],
        ['a.sh', 'echo ok'],
        ['sub/.shellcheckrc', '\tdisable=SC9'],
        ['.shellcheckrc', ' disable=SC1'],
      ]),
      [
        'shell|a.sh|SUPPRESSION|supresion anadida: # shellcheck   disable=SC2086',
        'shell|sub/.shellcheckrc|SUPPRESSION|supresion anadida: disable=SC9',
      ],
    )
  })
})

describe('cabecera del script', () => {
  const source = readFileSync(SCRIPT, 'utf8')

  test('documenta las opciones obligatorias del build', () => {
    assert.ok(source.includes('--no-incremental'))
    assert.ok(source.includes('warningsonly'))
  })

  test('documenta el log por lado y la linea de tiempos', () => {
    assert.ok(source.includes('warnings-diff-dotnet-<lado>.log'))
    assert.ok(source.includes('warnings-diff: base <N>s'))
  })
})
