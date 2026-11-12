// `mefisto-launch-pipeline.mts` en proceso: guarda del repo de Mefisto, modo de UI, flags de
// --tooling, gate de rama de --batch y el comando y el entorno del pipeline desacoplado.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { repoRoot } from '../../../scripts/lib/cli.mts'
import { launchDetached } from '../../../scripts/lib/launcher.mts'
import type { DelegateOptions, DetachedLaunch, LaunchDetached } from '../../../scripts/lib/launcher.mts'
import { stripAnsi } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import { mefistoLaunchPipeline } from '../../../src/internal/scripts/mefisto-launch-pipeline.mts'
import { assertInMefisto } from '../../../src/internal/scripts/lib/mefisto-repo.mts'
import type { MefistoRepo } from '../../../src/internal/scripts/lib/mefisto-repo.mts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'tests', 'fixtures', 'launch-pipeline')
const NOW = new Date(2026, 10, 11, 9, 8, 7)
const STAMP = '20261111-090807'

let work = ''
let scripts = ''
let shared: Mefisto | null = null
let restoreGit: () => void = () => {}
let counter = 0

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n+$/, '')

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto launch pipeline ')))
  restoreGit = isolateGitConfig(work)
  // El batch interno sigue en bash: queda solo con su `.sh`.
  scripts = join(work, 'src', 'internal', 'scripts')
  mkdirSync(scripts, { recursive: true })
  copyFileSync(join(FIXTURES, 'stub-pipeline.mts'), join(scripts, 'mefisto-tooling-pipeline.mts'))
  writeFileSync(join(scripts, 'mefisto-batch-pipeline.mts'), '#!/usr/bin/env bash\necho "stub batch $*"\n')
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

interface Mefisto {
  root: string
  /** Clon con el que otro "publica" en el origin. */
  publisher: string
}

/** Repo de Mefisto de mentira en `main`, con un origin bare ya empujado. */
function mefistoRepo(): Mefisto {
  counter++
  const base = join(work, `caso-${counter}`)
  const root = join(base, 'mefisto')
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{ "name": "mefisto", "version": "0.0.0" }\n')
  writeFileSync(join(root, '.gitignore'), '.mefisto/\n')
  git(base, 'init', '--quiet', root)
  git(root, 'add', '-A')
  git(root, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'inicial')
  git(root, 'branch', '-M', 'main')
  const bare = join(base, 'origin.git')
  git(base, 'init', '--quiet', '--bare', bare)
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'remote', 'add', 'origin', bare)
  git(root, 'push', '--quiet', '-u', 'origin', 'main')
  const publisher = join(base, 'publisher')
  git(base, 'clone', '--quiet', bare, publisher)
  return { root: realpathSync.native(root), publisher }
}

/** La guarda real consulta `gh` para el slug, que el lanzador no usa. */
function repoOf(cwd: string): MefistoRepo {
  const root = repoRoot(cwd)
  assert.ok(root !== null)
  return { root, projectName: 'mefisto', repoSlug: '' }
}

function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('HERDR_') && !key.startsWith('MEFISTO_')) env[key] = value
  }
  return { ...env, MEFISTO_UI: 'mod', MEFISTO_RUNTIME: 'claude' }
}

interface Outcome {
  code: number
  out: string
  err: string
  root: string
  launches: DetachedLaunch[]
  delegated: { script: string; args: readonly string[]; options: DelegateOptions }[]
}

interface RunOptions {
  repo?: Mefisto
  cwd?: string
  env?: Record<string, string | undefined>
  realGuard?: boolean
  platform?: NodeJS.Platform
  launch?: LaunchDetached
  delegateCode?: number
}

async function launcher(argv: string[], options: RunOptions = {}): Promise<Outcome> {
  // Los casos que no mueven ramas comparten un repo: crearlo es lo lento.
  shared ??= mefistoRepo()
  const cwd = options.cwd ?? (options.repo ?? shared).root
  const env = hermeticEnv()
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const launches: DetachedLaunch[] = []
  const delegated: Outcome['delegated'] = []
  let out = ''
  let err = ''
  const code = await mefistoLaunchPipeline({
    argv,
    cwd,
    env,
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    now: () => NOW,
    hasCommand: (command) => command === 'herdr',
    scriptsDir: scripts,
    launch:
      options.launch ??
      ((spec) => {
        launches.push(spec)
        return 4242
      }),
    delegate: (script, args, delegateOptions) => {
      delegated.push({ script, args, options: delegateOptions })
      return options.delegateCode ?? 0
    },
    assertRepo: options.realGuard === true ? assertInMefisto : repoOf,
    platform: options.platform ?? 'linux',
  })
  return { code, out, err, root: cwd, launches, delegated }
}

const INSIDE_HERDR = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1' }

function launched(outcome: Outcome): { script: string; argv: string[]; spec: DetachedLaunch } {
  assert.equal(outcome.code, 0, outcome.err)
  assert.equal(outcome.delegated.length, 0)
  assert.equal(outcome.launches.length, 1)
  const spec = outcome.launches[0] as DetachedLaunch
  const index = spec.args.findIndex((arg) => arg.startsWith(scripts))
  assert.ok(index >= 0)
  return { script: (spec.args[index] as string).slice(scripts.length + 1), argv: spec.args.slice(index + 1), spec }
}

function assertAborts(outcome: Outcome, message: string): void {
  assert.equal(outcome.code, 1, outcome.out)
  assert.ok(outcome.err.includes(message), `stderr sin '${message}': ${outcome.err}`)
  assert.equal(outcome.launches.length, 0)
  assert.equal(outcome.delegated.length, 0)
}

const self = (): string => join(scripts, 'mefisto-launch-pipeline.mts')

describe('guarda del repo de Mefisto', () => {
  test('fuera del repo de Mefisto se niega', async () => {
    const other = join(work, 'otro')
    git(work, 'init', '--quiet', other)
    const run = await launcher(['--tooling', '42'], { cwd: other, realGuard: true })
    assert.equal(run.code, 1)
    assert.equal(
      run.err,
      [
        'ERROR: este pipeline solo se ejecuta dentro del repo de Mefisto',
        `  No se encontro ${repoRoot(other)}/.claude-plugin/plugin.json`,
        '  Si querias trabajar sobre tu proyecto consumidor, usa los skills',
        '  publicados (/tooling, /implement, etc.) desde la raiz de ese repo.',
        '',
      ].join('\n'),
    )
  })

  test('fuera de un repo git se niega', async () => {
    const run = await launcher(['--tooling', '42'], { cwd: mkdtempSync(join(work, 'sin-git-')), realGuard: true })
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no estas en un repositorio git\n')
  })
})

describe('uso, ayuda y argumentos rechazados', () => {
  test('sin argumentos imprime el uso y sale con 1; --help y -h, con 0', async () => {
    const empty = await launcher([])
    assert.equal(empty.code, 1)
    assert.ok(empty.out.startsWith(`Uso: node ${self()} --tooling <issue> [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>]\n     node ${self()} --batch <issue1> <issue2> ...\n`))
    assert.ok(empty.out.endsWith('                  invalido aborta ANTES de crear el worktree.\n'))
    for (const flag of ['--help', '-h']) {
      const run = await launcher([flag], { env: { MEFISTO_UI: 'sesion' } })
      assert.equal(run.code, 0)
      assert.equal(run.out, empty.out)
    }
  })

  for (const argv of [['--attach'], ['--tooling', '42', '--if-exists', 'replace']]) {
    test(`'${argv.join(' ')}' aborta con un error explicito`, async () => {
      assertAborts(await launcher(argv), '--attach e --if-exists ya no existen')
    })
  }

  test('un MEFISTO_UI distinto de mod|herdr aborta nombrando los dos modos', async () => {
    const run = await launcher(['--tooling', '42'], { env: { MEFISTO_UI: 'sesion' } })
    assertAborts(run, "MEFISTO_UI='sesion' no es un modo valido")
    assert.ok(run.err.includes("'mod' (desacoplado, el default)"))
    assert.ok(run.err.includes("'herdr' (panes, dentro de herdr)"))
  })

  test('un modo que no es --tooling ni --batch aborta', async () => {
    const run = await launcher(['42'])
    assertAborts(run, 'Argumento no reconocido: 42')
    assert.equal(run.err, '\n\u001b[0;31m\u001b[1mx Argumento no reconocido: 42\u001b[0m\n')
  })
})

describe('--tooling desacoplado', () => {
  test('con MEFISTO_UI=mod no abre pane aunque corra dentro de herdr, y pasa issue y flags en orden', async () => {
    const run = await launcher(['--tooling', '42', '--from-stage', '2', '--models', 'reviewer=opus'], {
      env: { ...INSIDE_HERDR, MEFISTO_MODELS_FILE: '/x/models.json', MEFISTO_AGENT_TIMEOUT_SECONDS: '60' },
    })
    const { script, argv, spec } = launched(run)
    assert.equal(script, 'mefisto-tooling-pipeline.mts')
    assert.deepEqual(argv, ['42', '--from-stage', '2', '--models', 'reviewer=opus'])
    assert.equal(spec.command, process.execPath)
    assert.equal(spec.cwd, run.root)
    assert.deepEqual(
      Object.keys(spec.env).filter((key) => key.startsWith('HERDR_') || key === 'MEFISTO_UI'),
      [],
    )
    assert.equal(spec.env.MEFISTO_RUNTIME, 'claude')
    assert.equal(spec.env.MEFISTO_MODELS_FILE, '/x/models.json')
    assert.equal(spec.env.MEFISTO_AGENT_TIMEOUT_SECONDS, '60')
    const report = join(run.root, '.mefisto', 'pipeline', 'logs', `mefisto-tooling-run-${STAMP}-issue-42.report.log`)
    assert.equal(spec.reportLog, report)
    assert.equal(
      run.out,
      '\u001b[0;32m\u001b[1mv\u001b[0m Pipeline mefisto-tooling iniciado para issue #42 (sin pane: lo sigue el mod mefisto-divine-wager)\n' +
        `\u001b[0;34m[09:08:07]\u001b[0m Reporte: ${report}\n` +
        '\u001b[0;34m[09:08:07]\u001b[0m Visor en otra terminal: node src/internal/scripts/mefisto-stream-watch.mts --issues 42\n',
    )
  })

  test('el events.log se prepara en el estado canonico, nunca en el legacy', async () => {
    const run = await launcher(['--tooling', '42'])
    assert.equal(existsSync(join(run.root, '.mefisto', 'pipeline', 'events.log')), true)
    assert.equal(existsSync(join(run.root, '.claude', 'pipeline')), false)
    const stateDir = join(work, `estado-${counter}`)
    const moved = await launcher(['--tooling', '42'], { env: { MEFISTO_STATE_DIR: stateDir } })
    assert.equal(existsSync(join(stateDir, 'events.log')), true)
    assert.equal(launched(moved).spec.reportLog, join(stateDir, 'logs', `mefisto-tooling-run-${STAMP}-issue-42.report.log`))
  })

  test('sin MEFISTO_UI, con un runtime sin cinta y fuera de herdr: desacoplado sin prometer el mod', async () => {
    const run = await launcher(['--tooling', '77'], { env: { MEFISTO_UI: undefined, MEFISTO_RUNTIME: 'fake' } })
    const { argv, spec } = launched(run)
    assert.deepEqual(argv, ['77'])
    assert.equal(spec.env.MEFISTO_RUNTIME, 'fake')
    assert.ok(run.out.includes('Pipeline mefisto-tooling iniciado para issue #77 (sin pane)\n'))
    assert.ok(!run.out.includes('lo sigue el mod'))
    assert.ok(run.out.includes('issue-77.report.log'))
    assert.ok(run.out.includes('src/internal/scripts/mefisto-stream-watch.mts --issues 77'))
  })

  test('sin MEFISTO_RUNTIME heredado no fija ninguno', async () => {
    const run = await launcher(['--tooling', '711'], { env: { MEFISTO_RUNTIME: undefined } })
    assert.equal(launched(run).spec.env.MEFISTO_RUNTIME, undefined)
  })

  test('--models llega intacto, incluido un id con corchetes, y se combina con --from-stage', async () => {
    assert.deepEqual(launched(await launcher(['--tooling', '709', '--models', 'writer=sonnet,reviewer=opus'])).argv, [
      '709',
      '--models',
      'writer=sonnet,reviewer=opus',
    ])
    assert.deepEqual(launched(await launcher(['--tooling', '709', '--models', 'writer=modelo-x[1m]'])).argv, [
      '709',
      '--models',
      'writer=modelo-x[1m]',
    ])
    assert.deepEqual(launched(await launcher(['--tooling', '709', '--from-stage', '2', '--models', 'reviewer=opus'])).argv, [
      '709',
      '--from-stage',
      '2',
      '--models',
      'reviewer=opus',
    ])
  })

  test('--variant llega intacto y en orden tras --from-stage y --models', async () => {
    assert.deepEqual(launched(await launcher(['--tooling', '711', '--variant', 'experimento-a'])).argv, ['711', '--variant', 'experimento-a'])
    assert.deepEqual(launched(await launcher(['--tooling', '--variant', 'b', '711', '--models', 'reviewer=opus', '--from-stage', '2'])).argv, [
      '711',
      '--from-stage',
      '2',
      '--models',
      'reviewer=opus',
      '--variant',
      'b',
    ])
  })

  test('un flag sin valor, un --from-stage no numerico o la falta de issue abortan', async () => {
    assertAborts(await launcher(['--tooling', '709', '--models']), 'Falta el valor de --models')
    assertAborts(await launcher(['--tooling', '709', '--models', '']), 'Falta el valor de --models')
    assertAborts(await launcher(['--tooling', '711', '--variant']), 'Falta el valor de --variant')
    assertAborts(await launcher(['--tooling', '711', '--from-stage']), 'Falta el valor de --from-stage')
    assertAborts(await launcher(['--tooling', '711', '--from-stage', 'x']), "--from-stage debe ser un numero entero (recibido: 'x')")
    assertAborts(await launcher(['--tooling', '--from-stage', '2']), 'Falta el numero de issue. Uso: --tooling <issue> [--from-stage N]')
  })

  test('los valores viajan como argumentos literales, sin pasar por un shell', async () => {
    const value = `a b;touch x $(id) 'c' "d" *`
    assert.deepEqual(launched(await launcher(['--tooling', '42', '--variant', value])).argv, ['42', '--variant', value])
  })

  test('en macOS con caffeinate en el PATH el pipeline arranca envuelto en caffeinate -i', async () => {
    const bin = join(work, 'bin-caffeinate')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'caffeinate'), '')
    const run = await launcher(['--tooling', '42'], { env: { PATH: bin }, platform: 'darwin' })
    assert.equal(run.launches[0]?.command, 'caffeinate')
    assert.deepEqual(run.launches[0]?.args, ['-i', process.execPath, join(scripts, 'mefisto-tooling-pipeline.mts'), '42'])
  })
})

describe('--batch', () => {
  test('lanza el batch desacoplado con Node y los issues en orden', async () => {
    const run = await launcher(['--batch', '42', '43'], { env: INSIDE_HERDR })
    const { script, argv, spec } = launched(run)
    assert.equal(script, 'mefisto-batch-pipeline.mts')
    assert.equal(spec.command, process.execPath)
    assert.deepEqual(argv, ['42', '43'])
    assert.equal(spec.reportLog, join(run.root, '.mefisto', 'pipeline', 'logs', `mefisto-batch-run-${STAMP}.report.log`))
    assert.ok(stripAnsi(run.out).includes('v Batch pipeline interno iniciado: issues 42 43 (sin pane: lo sigue el mod mefisto-divine-wager)\n'))
    assert.ok(run.out.includes('node src/internal/scripts/mefisto-stream-watch.mts --issues 42,43'))
  })

  test('rechaza un issue no numerico sin lanzar nada', async () => {
    assertAborts(await launcher(['--batch', '42', '43;touch x']), "Issue invalido para --batch: '43;touch x' (solo numeros).")
  })

  test('--from-stage, --models y --variant son ambiguos sobre varios issues', async () => {
    assertAborts(await launcher(['--batch', '709', '710', '--from-stage', '2']), '--from-stage no es valido con --batch')
    assertAborts(await launcher(['--batch', '709', '710', '--models', 'writer=sonnet']), '--models no es valido con --batch')
    assertAborts(await launcher(['--batch', '711', '712', '--variant', 'a']), '--variant no es valido con --batch')
    assertAborts(await launcher(['--batch']), 'Debes especificar al menos un issue. Uso: --batch 42 43 44')
  })

  test('las validaciones del batch corren antes de delegar en herdr', async () => {
    assertAborts(await launcher(['--batch', '1', '--models', 'x'], { env: { MEFISTO_UI: 'herdr', ...INSIDE_HERDR } }), 'no es valido con --batch')
  })

  test('con el arbol sucio fuera de main aborta antes de lanzar', async () => {
    const repo = mefistoRepo()
    git(repo.root, 'checkout', '--quiet', '-b', 'feature-sucia')
    writeFileSync(join(repo.root, 'nota-pendiente.txt'), 'nota\n')
    const run = await launcher(['--batch', '711', '712'], { repo })
    assertAborts(run, "El repo principal esta en la rama 'feature-sucia', no en main/master, y el arbol de trabajo no esta limpio")
    assert.equal(git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-sucia')
  })

  test('con el arbol limpio fuera de main recupera main actualizado y despues despacha', async () => {
    const repo = mefistoRepo()
    git(repo.publisher, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--quiet', '--allow-empty', '-m', 'origin avanza')
    git(repo.publisher, 'push', '--quiet', 'origin', 'main')
    const expected = git(repo.publisher, 'rev-parse', 'main')
    git(repo.root, 'checkout', '--quiet', '-b', 'feature-limpia')
    const run = await launcher(['--batch', '711', '712'], { repo })
    assert.deepEqual(launched(run).argv, ['711', '712'])
    assert.equal(git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
    assert.equal(git(repo.root, 'rev-parse', 'main'), expected)
    assert.ok(
      run.out.startsWith(
        "\u001b[1;33m!\u001b[0m El repo principal estaba en la rama 'feature-limpia' (arbol limpio) al arrancar el batch; el gate se auto-recupero a 'main' y lo sincronizo con origin/main (issue #726).",
      ),
    )
  })
})

describe('delegacion en herdr', () => {
  test('con el runtime claude y sin MEFISTO_UI no delega aunque corra dentro de herdr', async () => {
    for (const argv of [['--tooling', '2284'], ['--batch', '2284', '2285']]) {
      const run = await launcher(argv, { env: { MEFISTO_UI: undefined, ...INSIDE_HERDR } })
      assert.equal(run.delegated.length, 0)
      assert.ok(run.out.includes('sin pane: lo sigue el mod mefisto-divine-wager'))
    }
  })

  test('otro runtime dentro de herdr delega con los argumentos originales y devuelve su codigo', async () => {
    const argv = ['--tooling', '2284', '--models', 'w=x']
    const run = await launcher(argv, { env: { MEFISTO_UI: undefined, MEFISTO_RUNTIME: 'fake', ...INSIDE_HERDR }, delegateCode: 3 })
    assert.equal(run.code, 3)
    assert.equal(run.launches.length, 0)
    assert.equal(run.delegated[0]?.script, join(scripts, 'mefisto-herdr-pipeline.mts'))
    assert.deepEqual(run.delegated[0]?.args, argv)
    assert.equal(run.delegated[0]?.options.env.HERDR_PANE_ID, 'w1:p1')
  })

  test('MEFISTO_UI=herdr delega incluso fuera de herdr: el script de herdr decide', async () => {
    const run = await launcher(['--tooling', '2284'], { env: { MEFISTO_UI: 'herdr', HERDR_ENV: '0' } })
    assert.equal(run.delegated.length, 1)
    assert.equal(run.launches.length, 0)
  })
})

describe('lanzamiento real', () => {
  test('el pipeline recibe su argv y el entorno sin HERDR_* ni MEFISTO_UI, y escribe en el reporte', async () => {
    const run = await launcher(['--tooling', '42', '--models', 'reviewer=opus'], { env: INSIDE_HERDR, launch: launchDetached })
    assert.equal(run.code, 0, run.err)
    const report = join(run.root, '.mefisto', 'pipeline', 'logs', `mefisto-tooling-run-${STAMP}-issue-42.report.log`)
    let text = ''
    for (let i = 0; i < 100 && !text.includes('herdr:'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      text = existsSync(report) ? readFileSync(report, 'utf8') : ''
    }
    assert.equal(
      text,
      [
        'script: mefisto-tooling-pipeline.mts',
        'argv: [42] [--models] [reviewer=opus]',
        'runtime: claude',
        'models-file: ',
        'ui: ',
        'herdr: ',
        '',
      ].join('\n'),
    )
  })
})
