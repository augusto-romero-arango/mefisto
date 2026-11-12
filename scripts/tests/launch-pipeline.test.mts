// `launch-pipeline.mts` en proceso: guardas, modo de UI, preparseo de flags, enrutamiento y el
// comando y el entorno con que se lanza cada pipeline desacoplado.

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { kebabDomain, launchPipeline } from '../launch-pipeline.mts'
import type { CommandResult } from '../lib/cli.mts'
import { detachedEnv, insideHerdr, launchDetached, pipelineCommand, usesDetachedUi } from '../lib/launcher.mts'
import type { DelegateOptions, DetachedLaunch, LaunchDetached } from '../lib/launcher.mts'
import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { initRepo } from './consumer-sandbox.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'launch-pipeline')
const NOW = new Date(2026, 10, 11, 9, 8, 7)
const STAMP = '20261111-090807'
const PIPELINES = ['tdd', 'tooling', 'iac', 'scaffold', 'parallel']

let work = ''
let pkg = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto launch pipeline ')))
  restoreGit = isolateGitConfig(work)
  // batch-pipeline queda solo con su `.sh`: el camino que aun corre por bash.
  pkg = join(work, 'pkg', 'scripts')
  mkdirSync(pkg, { recursive: true })
  for (const name of PIPELINES) copyFileSync(join(FIXTURES, 'stub-pipeline.mts'), join(pkg, `${name}-pipeline.mts`))
  writeFileSync(join(pkg, 'batch-pipeline.sh'), '#!/usr/bin/env bash\necho "stub batch $*"\n')
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function consumer(files: Record<string, string> = {}): string {
  counter++
  return initRepo(join(work, `consumidor-${counter}`), files)
}

const LABELS: Record<string, string[]> = {
  '253': ['tipo:tooling'],
  '254': ['tipo:infra'],
  '255': ['tipo:feature', 'dom:ventas'],
  '256': ['tipo:projection'],
  '2285': ['tipo:tooling'],
}

/** `gh issue view <n> --json labels` con los labels de `LABELS`; un issue ajeno falla. */
function fakeGh(command: string, args: string[]): CommandResult {
  assert.equal(command, 'gh')
  const labels = LABELS[args[2] ?? '']
  if (labels === undefined) return { status: 1, stdout: '', stderr: 'no existe' }
  return { status: 0, stdout: `${JSON.stringify({ labels: labels.map((name) => ({ name })) })}\n`, stderr: '' }
}

interface Delegation {
  script: string
  args: readonly string[]
  options: DelegateOptions
}

interface Outcome {
  code: number
  out: string
  err: string
  root: string
  launches: DetachedLaunch[]
  delegated: Delegation[]
}

/** El entorno del proceso sin `HERDR_*` ni `MEFISTO_*`, con MEFISTO_UI=mod y MEFISTO_RUNTIME=claude. */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('HERDR_') && !key.startsWith('MEFISTO_')) env[key] = value
  }
  return { ...env, MEFISTO_UI: 'mod', MEFISTO_RUNTIME: 'claude' }
}

interface RunOptions {
  cwd?: string
  /** Se suma al entorno de `hermeticEnv`; `undefined` borra la variable. */
  env?: Record<string, string | undefined>
  herdrInPath?: boolean
  platform?: NodeJS.Platform
  launch?: LaunchDetached
  delegateCode?: number
}

async function launcher(argv: string[], options: RunOptions = {}): Promise<Outcome> {
  const root = options.cwd ?? consumer()
  const env = hermeticEnv()
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const launches: DetachedLaunch[] = []
  const delegated: Delegation[] = []
  let out = ''
  let err = ''
  const code = await launchPipeline({
    argv,
    cwd: root,
    env,
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    now: () => NOW,
    hasCommand: (command) => command === 'herdr' && options.herdrInPath !== false,
    run: fakeGh,
    scriptsDir: pkg,
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
    platform: options.platform ?? 'linux',
  })
  return { code, out, err, root, launches, delegated }
}

const INSIDE_HERDR = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0', HERDR_WORKSPACE_ID: 'w1' }
const OUTSIDE_HERDR = { HERDR_ENV: '0', HERDR_PANE_ID: '' }

/** Argv que recibe el pipeline: lo que sigue a la ruta de su script en el comando lanzado. */
function pipelineArgv(spec: DetachedLaunch | undefined): { script: string; argv: string[] } {
  assert.ok(spec !== undefined, 'no se lanzo ningun pipeline')
  const index = spec.args.findIndex((arg) => arg.startsWith(pkg))
  assert.ok(index >= 0, `el comando no nombra un pipeline del paquete: ${spec.args.join(' ')}`)
  return { script: spec.args[index] as string, argv: spec.args.slice(index + 1) }
}

function single(outcome: Outcome): { name: string; argv: string[] } {
  assert.equal(outcome.code, 0, outcome.err)
  assert.equal(outcome.launches.length, 1)
  const launched = pipelineArgv(outcome.launches[0])
  return { name: launched.script.slice(pkg.length + 1), argv: launched.argv }
}

const reportOf = (outcome: Outcome): string => outcome.launches[0]?.reportLog ?? ''

function assertAborts(outcome: Outcome, message: string): void {
  assert.equal(outcome.code, 1, outcome.out)
  assert.ok(outcome.err.includes(message), `stderr sin '${message}': ${outcome.err}`)
  assert.equal(outcome.launches.length, 0)
  assert.equal(outcome.delegated.length, 0)
}

describe('guardas', () => {
  test('fuera de un repo git se niega', async () => {
    const outside = mkdtempSync(join(work, 'sin-git-'))
    const run = await launcher(['--tooling', '42'], { cwd: outside })
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no estas en un repositorio git\n')
    assert.equal(run.out, '')
  })

  test('en el repo de Mefisto se niega, incluso con --help', async () => {
    const mefisto = consumer({ '.claude-plugin/plugin.json': '{"name":"mefisto"}\n' })
    for (const argv of [['--tooling', '42'], ['--help'], []]) {
      const run = await launcher(argv, { cwd: mefisto })
      assert.equal(run.code, 1)
      assert.equal(
        run.err,
        'ERROR: scripts/launch-pipeline.sh es del plugin publicado y solo aplica al consumidor.\n' +
          'Estas en el repo de Mefisto. Para trabajar issues del plugin usa los skills internos /mefisto-tooling o /mefisto-sequential.\n',
      )
      assert.equal(run.launches.length, 0)
    }
  })

  test('sin el directorio de adaptadores de runtime no arranca', async () => {
    const run = await launcher(['--tooling', '42'], { env: { MEFISTO_RUNTIME_LIB_DIR: join(work, 'no-existe') } })
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no se encontro src/runtime/lib junto al paquete publicado\n')
  })
})

describe('ayuda y flags retirados', () => {
  test('sin argumentos o con --help/-h en cualquier posicion imprime la ayuda y sale con 0', async () => {
    for (const argv of [[], ['--help'], ['--tooling', '42', '-h']]) {
      const run = await launcher(argv)
      assert.equal(run.code, 0)
      assert.ok(run.out.startsWith('\n\u001b[0;36m\u001b[1mlaunch-pipeline.sh\u001b[0m --- Despachador de los pipelines publicados\n'))
      assert.ok(run.out.endsWith('  igual, usa /sequential o parallel-pipeline.sh directo.\n\n'))
      assert.equal(run.launches.length, 0)
    }
  })

  test('--help no depende del modo de UI', async () => {
    const run = await launcher(['--help'], { env: { MEFISTO_UI: 'sesiones' } })
    assert.equal(run.code, 0)
    assert.ok(run.out.includes('launch-pipeline.sh'))
  })

  for (const argv of [['--attach'], ['--attach', 'tooling-2285'], ['--tooling', '2285', '--if-exists', 'replace']]) {
    for (const ui of ['mod', 'herdr']) {
      test(`'${argv.join(' ')}' (MEFISTO_UI=${ui}) da un error explicito y no lanza nada`, async () => {
        const run = await launcher(argv, { env: { MEFISTO_UI: ui, ...INSIDE_HERDR } })
        assertAborts(run, '--attach e --if-exists ya no existen')
        assert.equal(
          run.err,
          '\n\u001b[0;31m\u001b[1m✗ --attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5).\u001b[0m\n',
        )
      })
    }
  }

  test('un argumento desconocido imprime el error en rojo y la ayuda, y sale con 1', async () => {
    const run = await launcher(['foo'])
    assert.equal(run.code, 1)
    assert.ok(run.out.startsWith('\u001b[0;31mArgumento desconocido: foo\u001b[0m\n\n\u001b[0;36m'))
    assert.equal(run.launches.length, 0)
  })
})

describe('decision del modo de UI', () => {
  test('usesDetachedUi e insideHerdr', () => {
    assert.equal(usesDetachedUi({ MEFISTO_UI: 'mod' }), true)
    assert.equal(usesDetachedUi({ MEFISTO_RUNTIME: 'claude' }), true)
    assert.equal(usesDetachedUi({ MEFISTO_UI: '', MEFISTO_RUNTIME: 'claude' }), true)
    assert.equal(usesDetachedUi({ MEFISTO_UI: 'herdr', MEFISTO_RUNTIME: 'claude' }), false)
    assert.equal(usesDetachedUi({ MEFISTO_RUNTIME: 'fake' }), false)
    const herdr = (command: string): boolean => command === 'herdr'
    assert.equal(insideHerdr({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0' }, herdr), true)
    assert.equal(insideHerdr({ HERDR_ENV: '1', HERDR_PANE_ID: '' }, herdr), false)
    assert.equal(insideHerdr({ HERDR_ENV: '0', HERDR_PANE_ID: 'w1:p0' }, herdr), false)
    assert.equal(insideHerdr({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0' }, () => false), false)
  })

  test('un MEFISTO_UI invalido aborta nombrando los dos modos, sin lanzar nada', async () => {
    const run = await launcher(['--tooling', '2285'], { env: { MEFISTO_UI: 'sesiones' } })
    assertAborts(run, "MEFISTO_UI='sesiones' no es un modo valido")
    assert.ok(run.err.includes("'mod' (desacoplado, el default)"))
    assert.ok(run.err.includes("'herdr' (panes, dentro de herdr)"))
    assert.equal(existsSync(join(run.root, '.mefisto')), false)
  })

  test('MEFISTO_UI=herdr fuera de herdr aborta con mensaje claro', async () => {
    const run = await launcher(['--tooling', '2285'], { env: { MEFISTO_UI: 'herdr', ...OUTSIDE_HERDR } })
    assertAborts(run, 'MEFISTO_UI=herdr requiere correr dentro de un pane de herdr')
  })

  const DETACHED_MODES = [
    ['2285'],
    ['--pipeline', 'tooling', '2285'],
    ['--tooling', '2285'],
    ['--infra', '2285'],
    ['--scaffold', '--domain', 'pagos'],
    ['--batch', '2285', '2286'],
    ['--parallel', '1', '2', '3'],
  ]
  for (const argv of DETACHED_MODES) {
    test(`runtime claude sin MEFISTO_UI dentro de herdr corre desacoplado: ${argv.join(' ')}`, async () => {
      const run = await launcher(argv, { env: { MEFISTO_UI: undefined, ...INSIDE_HERDR } })
      assert.equal(run.code, 0, run.err)
      assert.equal(run.delegated.length, 0)
      assert.equal(run.launches.length, 1)
      assert.ok(run.out.includes('sin pane: lo sigue la consola de Fausto, fausto-blood-pact'))
      assert.ok(run.out.includes('.report.log'))
      assert.equal(existsSync(join(run.root, '.mefisto', 'pipeline', 'events.log')), true)
      assert.equal(existsSync(join(run.root, '.claude', 'pipeline', 'events.log')), false)
    })
  }

  test('--parallel fuera de herdr tambien corre desacoplado por parallel-pipeline', async () => {
    const run = await launcher(['--parallel', '1', '2', '3'], { env: { MEFISTO_UI: undefined, ...OUTSIDE_HERDR } })
    assert.deepEqual(single(run), { name: 'parallel-pipeline.mts', argv: ['1', '2', '3'] })
    assert.ok(reportOf(run).endsWith(`parallel-run-${STAMP}.report.log`))
    assert.ok(run.out.includes(`Visor en otra terminal: '${join(pkg, 'stream-watch.sh')}' --issues 1,2,3`))
  })

  test('un runtime distinto de claude dentro de herdr delega en herdr-pipeline.sh con los argumentos originales', async () => {
    const argv = ['--tooling', '2285', '--from-stage', '2']
    const run = await launcher(argv, { env: { MEFISTO_UI: undefined, MEFISTO_RUNTIME: 'fake', ...INSIDE_HERDR }, delegateCode: 7 })
    assert.equal(run.code, 7)
    assert.equal(run.launches.length, 0)
    assert.equal(run.delegated.length, 1)
    assert.equal(run.delegated[0]?.script, join(pkg, 'herdr-pipeline.sh'))
    assert.deepEqual(run.delegated[0]?.args, argv)
    assert.equal(run.delegated[0]?.options.env.HERDR_PANE_ID, 'w1:p0')
    assert.equal(run.delegated[0]?.options.env.MEFISTO_RUNTIME, 'fake')
  })

  test('MEFISTO_UI=herdr explicito gana sobre el runtime claude; --parallel tambien delega', async () => {
    for (const argv of [['--tooling', '2285'], ['--parallel', '2285', '2286']]) {
      const run = await launcher(argv, { env: { MEFISTO_UI: 'herdr', ...INSIDE_HERDR } })
      assert.equal(run.delegated.length, 1, argv.join(' '))
      assert.equal(run.launches.length, 0)
    }
    const other = await launcher(['--parallel', '6', '7'], { env: { MEFISTO_UI: undefined, MEFISTO_RUNTIME: 'fake', ...INSIDE_HERDR } })
    assert.equal(other.delegated.length, 1)
  })

  test('sin herdr en el PATH no delega aunque HERDR_ENV este fijado', async () => {
    const run = await launcher(['--tooling', '2285'], {
      env: { MEFISTO_UI: undefined, MEFISTO_RUNTIME: 'fake', ...INSIDE_HERDR },
      herdrInPath: false,
    })
    assert.equal(run.delegated.length, 0)
    assert.equal(run.launches.length, 1)
  })

  test('MEFISTO_UI=mod gana dentro de herdr con otro runtime', async () => {
    const run = await launcher(['--tooling', '2285', '--from-stage', '2'], {
      env: { MEFISTO_UI: 'mod', MEFISTO_RUNTIME: 'fake', ...INSIDE_HERDR },
    })
    assert.deepEqual(single(run), { name: 'tooling-pipeline.mts', argv: ['2285', '--from-stage', '2'] })
    assert.equal(run.delegated.length, 0)
  })

  test('ni mod ni herdr: desacoplado sin prometer la consola, con el report log y la linea del visor', async () => {
    const run = await launcher(['--tooling', '2285'], { env: { MEFISTO_UI: undefined, MEFISTO_RUNTIME: 'fake', ...OUTSIDE_HERDR } })
    assert.deepEqual(single(run), { name: 'tooling-pipeline.mts', argv: ['2285'] })
    const report = join(run.root, '.mefisto', 'pipeline', 'logs', `tooling-issue-2285-run-${STAMP}.report.log`)
    assert.equal(reportOf(run), report)
    assert.equal(
      run.out,
      '\u001b[0;32m\u001b[1m✓\u001b[0m Pipeline tooling-issue-2285 iniciado (sin pane)\n' +
        `\u001b[0;34m[09:08:07]\u001b[0m Log: ${report}\n` +
        `\u001b[0;34m[09:08:07]\u001b[0m Visor en otra terminal: '${join(pkg, 'stream-watch.sh')}' --issues 2285\n`,
    )
    assert.equal(run.err, '')
  })

  test('scaffold sin issue: el visor se sugiere sin --issues', async () => {
    const run = await launcher(['--scaffold', '--domain', 'pagos'], { env: { MEFISTO_RUNTIME: 'fake', MEFISTO_UI: undefined, ...OUTSIDE_HERDR } })
    assert.ok(stripAnsi(run.out).endsWith(`Visor en otra terminal: '${join(pkg, 'stream-watch.sh')}'\n`))
  })
})

describe('entorno y comando del pipeline desacoplado', () => {
  test('sin HERDR_* ni MEFISTO_UI, con el runtime resuelto y el resto del entorno intacto', async () => {
    const run = await launcher(['--tooling', '42'], {
      env: { ...INSIDE_HERDR, HERDR_OTRA: 'x', MEFISTO_AGENT_TIMEOUT_SECONDS: '60', MEFISTO_UI: 'mod' },
    })
    const spec = run.launches[0]
    assert.ok(spec !== undefined)
    assert.deepEqual(
      Object.keys(spec.env).filter((key) => key.startsWith('HERDR_') || key === 'MEFISTO_UI'),
      [],
    )
    assert.equal(spec.env.MEFISTO_RUNTIME, 'claude')
    assert.equal(spec.env.MEFISTO_AGENT_TIMEOUT_SECONDS, '60')
    assert.equal(spec.cwd, run.root)
    assert.equal(spec.command, process.execPath)
    assert.deepEqual(spec.args, [join(pkg, 'tooling-pipeline.mts'), '42'])
  })

  test('detachedEnv quita solo HERDR_* y MEFISTO_UI y suma los extras', () => {
    assert.deepEqual(detachedEnv({ A: '1', HERDR_ENV: '1', HERDR_X: '2', MEFISTO_UI: 'mod', MEFISTO_STATE_DIR: 's' }, { MEFISTO_RUNTIME: 'r' }), {
      A: '1',
      MEFISTO_STATE_DIR: 's',
      MEFISTO_RUNTIME: 'r',
    })
  })

  test('un pipeline sin .mts corre con bash y su .sh', async () => {
    const run = await launcher(['--batch', '1', '2'])
    const spec = run.launches[0]
    assert.equal(spec?.command, 'bash')
    assert.deepEqual(spec?.args, [join(pkg, 'batch-pipeline.sh'), '1', '2'])
    assert.equal(pipelineCommand(pkg, 'batch-pipeline', []).viaBash, true)
    assert.equal(pipelineCommand(pkg, 'tooling-pipeline', []).viaBash, false)
  })

  test('en macOS con caffeinate en el PATH el pipeline arranca envuelto en caffeinate -i', async () => {
    const bin = join(work, 'bin-caffeinate')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'caffeinate'), '')
    const run = await launcher(['--tooling', '42'], { env: { PATH: bin }, platform: 'darwin' })
    assert.equal(run.launches[0]?.command, 'caffeinate')
    assert.deepEqual(run.launches[0]?.args, ['-i', process.execPath, join(pkg, 'tooling-pipeline.mts'), '42'])
    const linux = await launcher(['--tooling', '42'], { env: { PATH: bin }, platform: 'linux' })
    assert.equal(linux.launches[0]?.command, process.execPath)
  })

  test('sin runtime resoluble aborta antes de lanzar', async () => {
    const run = await launcher(['--tooling', '42'], { env: { MEFISTO_RUNTIME: 'Malo!' } })
    assertAborts(run, "No se pudo resolver el runtime activo: runtime invalido: 'Malo!'")
  })

  test('los valores viajan como argumentos literales, sin pasar por un shell', async () => {
    const value = `a b;touch x $(id) 'c' "d" [1m] *`
    const run = await launcher(['--tooling', '42', '--variant', value, '--models', value])
    assert.deepEqual(single(run).argv, ['42', '--models', value, '--variant', value])
    assert.equal(existsSync(join(run.root, 'x')), false)
  })
})

describe('preparseo de --from-stage', () => {
  test('un unico issue con --from-stage despacha la corrida de un issue, no --parallel', async () => {
    const run = await launcher(['253', '--from-stage', '4', '--pipeline', 'tooling'])
    assert.deepEqual(single(run), { name: 'tooling-pipeline.mts', argv: ['253', '--from-stage', '4'] })
    assert.ok(!run.out.includes('Multiples issues'))
    assert.ok(reportOf(run).endsWith(`tooling-pipeline-issue-253-run-${STAMP}.report.log`))
  })

  test('se combina con --scaffold-domain en orden', async () => {
    const run = await launcher(['253', '--from-stage', '4', '--scaffold-domain', 'miDominio', '--pipeline', 'tooling'])
    assert.deepEqual(single(run).argv, ['253', '--scaffold-domain', 'miDominio', '--from-stage', '4'])
  })

  test('sin valor o no numerico aborta', async () => {
    assertAborts(await launcher(['253', '--pipeline', 'tooling', '--from-stage']), 'Falta el valor de --from-stage')
    assertAborts(await launcher(['253', '--from-stage', 'abc', '--pipeline', 'tooling']), "--from-stage debe ser un numero entero (recibido: 'abc')")
  })

  test('sobre un lote es ambiguo y se rechaza', async () => {
    assertAborts(await launcher(['--batch', '253', '254', '--from-stage', '4']), '--from-stage no es valido con --batch')
    assertAborts(await launcher(['--parallel', '253', '254', '--from-stage', '4']), '--from-stage no es valido con --parallel')
    assertAborts(await launcher(['253', '254', '--from-stage', '4']), '--from-stage no es valido con multiples issues')
  })

  test('--tooling e --infra lo propagan; --scaffold lo rechaza', async () => {
    const tooling = await launcher(['--tooling', '253', '--from-stage', '2'])
    assert.deepEqual(single(tooling), { name: 'tooling-pipeline.mts', argv: ['253', '--from-stage', '2'] })
    assert.ok(reportOf(tooling).endsWith(`tooling-issue-253-run-${STAMP}.report.log`))
    const infra = await launcher(['--infra', '253', '--from-stage', '2'])
    assert.deepEqual(single(infra), { name: 'iac-pipeline.mts', argv: ['253', '--from-stage', '2'] })
    assert.ok(reportOf(infra).endsWith(`infra-issue-253-run-${STAMP}.report.log`))
    assertAborts(await launcher(['--scaffold', '253', '--domain', 'miDominio', '--from-stage', '2']), '--from-stage no es valido con --scaffold')
  })

  test('solo flags, sin argumento posicional: mensaje de uso', async () => {
    const run = await launcher(['--from-stage', '4'])
    assertAborts(run, 'Faltan argumentos posicionales (numero de issue o modo).')
    assert.ok(run.err.includes(`Corre '${join(pkg, 'launch-pipeline.sh')} --help' para ver el uso.`))
  })

  test('--pipeline y --scaffold-domain sin valor abortan', async () => {
    assertAborts(await launcher(['--pipeline']), 'Falta el valor de --pipeline')
    assertAborts(await launcher(['--scaffold-domain']), 'Falta el nombre del dominio para --scaffold-domain')
  })
})

describe('--models', () => {
  test('--tooling lo reenvia intacto, incluido un id con corchetes', async () => {
    assert.deepEqual(single(await launcher(['--tooling', '253', '--models', 'writer=sonnet,reviewer=opus'])).argv, [
      '253',
      '--models',
      'writer=sonnet,reviewer=opus',
    ])
    assert.deepEqual(single(await launcher(['--tooling', '253', '--models', 'writer=claude-opus-5[1m]'])).argv, [
      '253',
      '--models',
      'writer=claude-opus-5[1m]',
    ])
  })

  test('--tooling combina --from-stage y --models en orden', async () => {
    assert.deepEqual(single(await launcher(['--tooling', '253', '--from-stage', '2', '--models', 'reviewer=opus'])).argv, [
      '253',
      '--from-stage',
      '2',
      '--models',
      'reviewer=opus',
    ])
  })

  test('sin valor aborta', async () => {
    assertAborts(await launcher(['--tooling', '253', '--models']), 'Falta el valor de --models')
  })

  test('se rechaza en los modos sin soporte', async () => {
    assertAborts(await launcher(['--infra', '253', '--models', 'writer=sonnet']), 'no es valido con --infra')
    assertAborts(await launcher(['--scaffold', '253', '--domain', 'miDominio', '--models', 'writer=sonnet']), 'no es valido con --scaffold')
    assertAborts(await launcher(['--batch', '253', '254', '--models', 'writer=sonnet', '--pipeline', 'tooling']), 'no es valido con --batch')
    assertAborts(await launcher(['--parallel', '253', '254', '--models', 'writer=sonnet', '--pipeline', 'tooling']), 'no es valido con --parallel')
    assertAborts(await launcher(['253', '254', '--models', 'a']), 'no es valido con multiples issues')
  })

  test('un issue suelto con --pipeline tooling o tdd lo reenvia', async () => {
    assert.deepEqual(single(await launcher(['253', '--models', 'writer=sonnet', '--pipeline', 'tooling'])), {
      name: 'tooling-pipeline.mts',
      argv: ['253', '--models', 'writer=sonnet'],
    })
    const tdd = await launcher(['253', '--models', 'test-writer=sonnet,reviewer=opus', '--pipeline', 'tdd'])
    assert.deepEqual(single(tdd), { name: 'tdd-pipeline.mts', argv: ['253', '--models', 'test-writer=sonnet,reviewer=opus'] })
    assert.ok(reportOf(tdd).endsWith(`tdd-pipeline-issue-253-run-${STAMP}.report.log`))
  })
})

describe('--variant', () => {
  test('--tooling lo reenvia intacto y lo combina con --from-stage y --models en orden', async () => {
    assert.deepEqual(single(await launcher(['--tooling', '253', '--variant', 'experimento-a'])).argv, ['253', '--variant', 'experimento-a'])
    assert.deepEqual(single(await launcher(['--tooling', '253', '--from-stage', '2', '--models', 'reviewer=opus', '--variant', 'b'])).argv, [
      '253',
      '--from-stage',
      '2',
      '--models',
      'reviewer=opus',
      '--variant',
      'b',
    ])
  })

  test('sin valor aborta', async () => {
    assertAborts(await launcher(['--tooling', '253', '--variant']), 'Falta el valor de --variant')
  })

  test('se rechaza en los modos sin soporte', async () => {
    assertAborts(await launcher(['--infra', '253', '--variant', 'a']), 'no es valido con --infra')
    assertAborts(await launcher(['--scaffold', '253', '--domain', 'miDominio', '--variant', 'a']), 'no es valido con --scaffold')
    assertAborts(await launcher(['--batch', '253', '254', '--variant', 'a', '--pipeline', 'tooling']), 'no es valido con --batch')
    assertAborts(await launcher(['--parallel', '253', '254', '--variant', 'a', '--pipeline', 'tooling']), 'no es valido con --parallel')
    assertAborts(await launcher(['253', '254', '--variant', 'a']), 'no es valido con multiples issues')
  })

  test('el enrutamiento automatico de un issue lo acepta, hacia tooling o tdd', async () => {
    assert.deepEqual(single(await launcher(['253', '--variant', 'a', '--pipeline', 'tooling'])), {
      name: 'tooling-pipeline.mts',
      argv: ['253', '--variant', 'a'],
    })
    assert.deepEqual(single(await launcher(['253', '--variant', 'experimento-a', '--pipeline', 'tdd'])), {
      name: 'tdd-pipeline.mts',
      argv: ['253', '--variant', 'experimento-a'],
    })
    assert.deepEqual(single(await launcher(['253', '--from-stage', '2', '--models', 'test-writer=opus', '--variant', 'b', '--pipeline', 'tdd'])).argv, [
      '253',
      '--from-stage',
      '2',
      '--models',
      'test-writer=opus',
      '--variant',
      'b',
    ])
  })
})

describe('enrutamiento de un issue suelto', () => {
  test('por label: tooling, feature y projection', async () => {
    assert.equal(single(await launcher(['253'])).name, 'tooling-pipeline.mts')
    assert.equal(single(await launcher(['255'])).name, 'tdd-pipeline.mts')
    assert.equal(single(await launcher(['256'])).name, 'tdd-pipeline.mts')
  })

  test('tipo:infra o sin tipo abortan con el motivo', async () => {
    assertAborts(await launcher(['254']), 'Issue #254 no se puede enrutar a un pipeline (infra).')
    assertAborts(await launcher(['999']), 'Issue #999 no se puede enrutar a un pipeline (no-tipo).')
  })

  test('un --pipeline desconocido aborta con el error del resolutor', async () => {
    const run = await launcher(['253', '--pipeline', 'bogus'])
    assert.equal(run.code, 1)
    assert.equal(run.err, "ERROR: override desconocido 'bogus'\n")
    assert.equal(run.launches.length, 0)
  })
})

describe('--batch y --parallel', () => {
  test('--batch lanza batch-pipeline con los issues y el override en orden', async () => {
    const run = await launcher(['--batch', '--pipeline', 'tooling', '42', '43'])
    assert.deepEqual(single(run), { name: 'batch-pipeline.sh', argv: ['--pipeline', 'tooling', '42', '43'] })
    assert.ok(reportOf(run).endsWith(`batch-run-${STAMP}.report.log`))
    assert.ok(stripAnsi(run.out).includes("stream-watch.sh' --issues 42,43"))
  })

  test('--batch rechaza issues no numericos, un override invalido y la falta de issues', async () => {
    assertAborts(await launcher(['--batch', '42', '43;touch x']), "Issue invalido para --batch: '43;touch x' (solo numeros).")
    assertAborts(await launcher(['--batch', '--pipeline', 'TOOL', '42']), "Valor invalido para --pipeline: 'TOOL'.")
    assertAborts(await launcher(['--batch']), 'Debes especificar al menos un issue. Uso: --batch 42 43 44')
  })

  test('--parallel pasa --pipeline y --max-parallel antes de los issues', async () => {
    assert.deepEqual(single(await launcher(['--parallel', '--max-parallel', '2', '--pipeline', 'tooling', '4', '5'])).argv, [
      '--pipeline',
      'tooling',
      '--max-parallel',
      '2',
      '4',
      '5',
    ])
    assert.deepEqual(single(await launcher(['--parallel', '--max-parallel=3', '4', '5'])).argv, ['--max-parallel', '3', '4', '5'])
  })

  test('--parallel rechaza --max-parallel o issues no numericos', async () => {
    assertAborts(await launcher(['--parallel', '--max-parallel', '2;x', '4', '5']), "Valor invalido para --max-parallel: '2;x'.")
    assertAborts(await launcher(['--parallel', '4', '5;x']), "Issue invalido para --parallel: '5;x' (solo numeros).")
    assertAborts(await launcher(['--parallel']), 'Debes especificar al menos un issue. Uso: --parallel 42 43 44')
  })

  test('--max-parallel sin valor sale con 1, como el `set -u` del bash', async () => {
    const run = await launcher(['--parallel', '4', '5', '--max-parallel'])
    assert.equal(run.code, 1)
    assert.equal(run.err, `${join(pkg, 'launch-pipeline.sh')}: $2: unbound variable\n`)
  })

  test('varios issues sin modo avisan y corren como --parallel', async () => {
    const run = await launcher(['253', '254', '--pipeline', 'tdd'])
    assert.deepEqual(single(run), { name: 'parallel-pipeline.mts', argv: ['--pipeline', 'tdd', '253', '254'] })
    assert.ok(run.out.startsWith('\u001b[1;33m⚠\u001b[0m Multiples issues sin modo especificado. Usando --parallel.\n'))
  })
})

describe('--scaffold', () => {
  test('normaliza el dominio a kebab-case y nombra la corrida con el', async () => {
    const run = await launcher(['--scaffold', '42', '--domain', 'miDominio_Nuevo'])
    assert.deepEqual(single(run), { name: 'scaffold-pipeline.mts', argv: ['42', '--domain', 'mi-dominio-nuevo'] })
    assert.ok(reportOf(run).endsWith(`scaffold-mi-dominio-nuevo-run-${STAMP}.report.log`))
    assert.deepEqual(single(await launcher(['--scaffold', '--domain=PagosABC'])).argv, ['--domain', 'pagos-abc'])
  })

  test('kebabDomain', () => {
    assert.equal(kebabDomain('PascalCase'), 'pascal-case')
    assert.equal(kebabDomain('camelCase'), 'camel-case')
    assert.equal(kebabDomain('snake_case'), 'snake-case')
    assert.equal(kebabDomain('aBC'), 'a-bc')
    assert.equal(kebabDomain('ya-kebab'), 'ya-kebab')
  })

  test('sin --domain, con un argumento desconocido o con --domain sin valor aborta', async () => {
    assertAborts(await launcher(['--scaffold', '42']), 'Falta --domain para --scaffold. Uso: --scaffold [issue] --domain nombre')
    assertAborts(await launcher(['--scaffold', 'x', '--domain', 'y']), 'Argumento desconocido para --scaffold: x')
    const run = await launcher(['--scaffold', '--domain'])
    assert.equal(run.code, 1)
    assert.ok(run.err.endsWith(': $2: unbound variable\n'))
  })
})

describe('lanzamiento real del pipeline desacoplado', () => {
  async function reportText(path: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8')
        if (text.includes('herdr:')) return text
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  test('el pipeline .mts recibe su argv y el entorno filtrado, y su salida queda en el report log', async () => {
    const run = await launcher(['--tooling', '42', '--models', 'w=m[1m]'], {
      env: { ...INSIDE_HERDR, MEFISTO_UI: 'mod' },
      launch: launchDetached,
    })
    assert.equal(run.code, 0, run.err)
    const report = join(run.root, '.mefisto', 'pipeline', 'logs', `tooling-issue-42-run-${STAMP}.report.log`)
    assert.equal(
      await reportText(report),
      [
        'script: tooling-pipeline.mts',
        'argv: [42] [--models] [w=m[1m]]',
        'runtime: claude',
        'models-file: ',
        'ui: ',
        'herdr: ',
        '',
      ].join('\n'),
    )
  })

  test('un pipeline sin .mts corre por bash', { skip: process.platform === 'win32' ? 'requiere bash' : false }, async () => {
    const run = await launcher(['--batch', '7', '8'], { launch: launchDetached })
    const report = join(run.root, '.mefisto', 'pipeline', 'logs', `batch-run-${STAMP}.report.log`)
    for (let i = 0; i < 100 && !(existsSync(report) && readFileSync(report, 'utf8').length > 0); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(readFileSync(report, 'utf8'), 'stub batch 7 8\n')
  })
})
