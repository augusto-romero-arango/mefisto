// `mefisto-herdr-pipeline.mts` en proceso, con la CLI de herdr inyectada: herencia del entorno
// por el archivo de despacho, flags, pool con clave de runtime, guardas, gate de rama de
// --batch, confirmacion de arranque y runner interno.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { isolateGitConfig, git } from '../../../scripts/tests/field-note-sandbox.mts'
import { FakeClock, FakeHerdr } from '../../../scripts/tests/herdr-sandbox.mts'
import type { FakeHerdrOptions } from '../../../scripts/tests/herdr-sandbox.mts'
import { mefistoHerdrPipeline } from '../../../src/internal/scripts/mefisto-herdr-pipeline.mts'
import type { MefistoHerdrDeps } from '../../../src/internal/scripts/mefisto-herdr-pipeline.mts'
import { assertInMefisto } from '../../../src/internal/scripts/lib/mefisto-repo.mts'

const OWN_PID = 4242
const INSIDE = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0', HERDR_WORKSPACE_ID: 'w1' }
const CANONICAL = join(import.meta.dirname, '..', '..', '..', 'src', 'internal', 'scripts', 'mefisto-herdr-pipeline.mts')

let work: string
let mefisto: string
let publisher: string
let restoreGit: () => void

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto-herdr-')))
  restoreGit = isolateGitConfig(work)
  mefisto = join(work, 'fake-mefisto')
  mkdirSync(join(mefisto, '.claude-plugin'), { recursive: true })
  writeFileSync(join(mefisto, '.claude-plugin', 'plugin.json'), '{"name":"mefisto","version":"0.0.0"}\n')
  writeFileSync(join(mefisto, '.gitignore'), '.mefisto/\n')
  git(mefisto, 'init', '-q')
  git(mefisto, 'add', '.')
  git(mefisto, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'inicial')
  git(mefisto, 'branch', '-M', 'main')
  const bare = join(work, 'origin.git')
  git(work, 'init', '-q', '--bare', bare)
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(mefisto, 'remote', 'add', 'origin', bare)
  git(mefisto, 'push', '-q', '-u', 'origin', 'main')
  publisher = join(work, 'publisher')
  git(work, 'clone', '-q', bare, publisher)
  mefisto = realpathSync.native(mefisto)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

const poolFile = (): string => join(mefisto, '.mefisto', 'pipeline', 'herdr-report-panes.txt')

function writePool(text: string): void {
  mkdirSync(join(mefisto, '.mefisto', 'pipeline'), { recursive: true })
  writeFileSync(poolFile(), text)
}

interface Outcome {
  code: number
  out: string
  err: string
  fake: FakeHerdr
}

interface RunOptions {
  env?: NodeJS.ProcessEnv
  fake?: FakeHerdrOptions
  /** CLIs de runtime en el PATH; por defecto solo `claude`. */
  runtimes?: string[]
  deps?: Partial<MefistoHerdrDeps>
}

async function runHerdr(argv: string[], options: RunOptions = {}): Promise<Outcome> {
  const fake = new FakeHerdr({ ownPane: 'w1:p0', ownerPid: OWN_PID, ...options.fake })
  let out = ''
  let err = ''
  const clock = new FakeClock()
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HERDR_DISPATCH_CONFIRM_TIMEOUT: '1', ...INSIDE, ...options.env }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  const runtimes = options.runtimes ?? ['claude']
  const code = await mefistoHerdrPipeline({
    argv,
    cwd: mefisto,
    env,
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    run: fake.run,
    hasCommand: (command) => command === 'herdr' || runtimes.includes(command),
    now: clock.now,
    sleep: clock.sleep,
    pid: OWN_PID,
    platform: 'linux',
    execPath: process.execPath,
    assertRepo: (cwd) => assertInMefisto(cwd, { hasCommand: () => false }),
    parentOf: () => null,
    isAlive: () => false,
    ...options.deps,
  })
  return { code, out, err, fake }
}

const lastSpec = (fake: FakeHerdr) => fake.typed.at(-1)?.spec

describe('herencia de MEFISTO_RUNTIME y MEFISTO_MODELS_FILE (issue #872)', () => {
  test('--tooling lleva el runtime fijado y reenvia al pipeline de tooling con el issue', async () => {
    rmSync(join(mefisto, '.mefisto'), { recursive: true, force: true })
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'claude' } })
    assert.equal(run.code, 0, run.err)
    const spec = lastSpec(run.fake)
    assert.deepEqual(spec?.env, { MEFISTO_RUNTIME: 'claude' })
    assert.ok(spec?.command[0]?.endsWith('mefisto-tooling-pipeline.mts'))
    assert.deepEqual(spec?.command.slice(1), ['872'])
    assert.equal(spec?.title, 'mefisto-tooling #872')
    assert.match(run.fake.typed[0]?.line ?? '', /^node "[^"]+mefisto-herdr-pipeline\.mts" "--_pane-runner" "--dispatch" "[^"]+\.json"$/)
  })

  test('--tooling lleva el runtime fake y MEFISTO_MODELS_FILE', async () => {
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'fake', MEFISTO_MODELS_FILE: '/tmp/modelos-de-mentira.json' } })
    assert.equal(run.code, 0, run.err)
    assert.deepEqual(lastSpec(run.fake)?.env, { MEFISTO_RUNTIME: 'fake', MEFISTO_MODELS_FILE: '/tmp/modelos-de-mentira.json' })
  })

  test('--batch lleva el runtime y reenvia al pipeline de batch con ambos issues', async () => {
    for (const runtime of ['claude', 'fake']) {
      const run = await runHerdr(['--batch', '872', '873'], { env: { MEFISTO_RUNTIME: runtime } })
      assert.equal(run.code, 0, run.err)
      const spec = lastSpec(run.fake)
      assert.deepEqual(spec?.env, { MEFISTO_RUNTIME: runtime })
      assert.match(spec?.command[0] ?? '', /mefisto-batch-pipeline\.(sh|mts)$/)
      assert.deepEqual(spec?.command.slice(1), ['872', '873'])
      assert.equal(spec?.title, 'mefisto-batch 872,873')
      assert.equal(spec?.issues, '872,873')
    }
  })

  test('sin MEFISTO_RUNTIME ni MEFISTO_MODELS_FILE el despacho no fija entorno', async () => {
    const run = await runHerdr(['--tooling', '872'])
    assert.equal(run.code, 0, run.err)
    assert.deepEqual(lastSpec(run.fake)?.env, {})
    assert.ok(!run.fake.log.includes('MEFISTO_RUNTIME='))
  })
})

describe('argumentos', () => {
  test('--models con corchetes, coma o comilla simple llega intacto', async () => {
    for (const models of ['writer=claude-opus-5[1m],reviewer=sonnet', "writer=modelo-de-'prueba", 'writer=sonnet,reviewer=opus']) {
      const run = await runHerdr(['--tooling', '872', '--models', models])
      assert.equal(run.code, 0, run.err)
      assert.deepEqual(lastSpec(run.fake)?.command.slice(-2), ['--models', models])
    }
  })

  test('--from-stage, --models y --variant se reenvian en orden; la variante va en el titulo', async () => {
    const run = await runHerdr(['--tooling', '872', '--from-stage', '2', '--models', 'writer=sonnet', '--variant', 'experimento-a'])
    assert.equal(run.code, 0, run.err)
    const spec = lastSpec(run.fake)
    assert.deepEqual(spec?.command.slice(1), ['872', '--from-stage', '2', '--models', 'writer=sonnet', '--variant', 'experimento-a'])
    assert.equal(spec?.title, 'mefisto-tooling #872 (experimento-a)')
  })

  test('argumentos faltantes abortan con mensaje claro', async () => {
    for (const [argv, message] of [
      [['--tooling'], 'Falta el numero de issue'],
      [['--batch'], 'al menos un issue'],
      [['--tooling', '872', '--models'], 'Falta el valor de --models'],
      [['--tooling', '872', '--variant'], 'Falta el valor de --variant'],
      [['--tooling', '872', '--from-stage'], 'Falta el valor de --from-stage'],
      [['--tooling', '872', '--from-stage', 'dos'], 'numero entero'],
      [['--otra'], 'Argumento no reconocido: --otra'],
    ] as const) {
      const run = await runHerdr([...argv])
      assert.equal(run.code, 1, argv.join(' '))
      assert.ok(run.err.includes(message), run.err)
      assert.equal(run.fake.count('herdr pane run'), 0)
    }
  })

  test('--batch rechaza --models, --variant y --from-stage sin despachar', async () => {
    for (const extra of [['--models', 'writer=sonnet'], ['--variant', 'experimento-a'], ['--from-stage', '2']]) {
      const run = await runHerdr(['--batch', '872', '873', ...extra])
      assert.equal(run.code, 1)
      assert.ok(run.err.includes('no es valido con --batch'))
      assert.equal(run.fake.count('herdr pane run'), 0)
    }
  })

  test('--if-exists y --attach abortan sin despachar', async () => {
    for (const argv of [['--tooling', '872', '--if-exists', 'replace'], ['--attach']]) {
      const run = await runHerdr(argv)
      assert.equal(run.code, 1)
      assert.ok(run.err.includes('--attach e --if-exists ya no existen'))
      assert.equal(run.fake.count('herdr pane run'), 0)
    }
  })

  test('sin argumentos imprime el uso y sale 1; --help sale 0', async () => {
    const empty = await runHerdr([])
    assert.equal(empty.code, 1)
    assert.ok(empty.out.includes('--tooling <issue>'))
    const help = await runHerdr(['--help'])
    assert.equal(help.code, 0)
    assert.ok(help.out.includes('--batch <issue1>'))
  })
})

describe('guardas', () => {
  test('fuera de herdr aborta remitiendo al modo desacoplado', async () => {
    const run = await runHerdr(['--tooling', '872'], { env: { HERDR_ENV: undefined } })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('mefisto-launch-pipeline.mts sin MEFISTO_UI=herdr'))
    assert.equal(run.fake.calls.length, 0)
  })

  test('fuera del repo de Mefisto aborta', async () => {
    const outside = join(work, 'fuera')
    mkdirSync(outside, { recursive: true })
    git(outside, 'init', '-q')
    let err = ''
    const code = await mefistoHerdrPipeline({
      argv: ['--tooling', '1'],
      cwd: outside,
      env: {},
      out: () => {},
      err: (text) => void (err += text),
      run: new FakeHerdr().run,
      hasCommand: () => true,
      now: () => new Date(),
      sleep: async () => {},
      pid: OWN_PID,
      platform: 'linux',
      execPath: process.execPath,
    })
    assert.equal(code, 1)
    assert.ok(err.includes('este pipeline solo se ejecuta dentro del repo de Mefisto'))
  })

  test('un pane heredado aborta sin split, run ni close (issue #2284)', async () => {
    rmSync(join(mefisto, '.mefisto'), { recursive: true, force: true })
    const run = await runHerdr(['--tooling', '2284'], { env: { MEFISTO_RUNTIME: 'fake' }, fake: { ownerPid: 999999 } })
    assert.notEqual(run.code, 0)
    assert.ok(run.err.includes('heredado'))
    assert.equal(run.fake.count('herdr pane split') + run.fake.count('herdr pane run') + run.fake.count('herdr pane close'), 0)
  })

  test('con el runtime fake el pane nuevo sale a la derecha de HERDR_PANE_ID', async () => {
    rmSync(join(mefisto, '.mefisto'), { recursive: true, force: true })
    const run = await runHerdr(['--tooling', '2284'], { env: { MEFISTO_RUNTIME: 'fake' } })
    assert.equal(run.code, 0, run.err)
    assert.ok(run.fake.log.includes('pane split --pane w1:p0 --direction right'))
  })
})

describe('pool con clave de runtime (issue #928)', () => {
  test('un pane libre registrado del mismo runtime se reutiliza; uno ocupado no', async () => {
    writePool('w1:p9 claude\n')
    const free = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'claude' } })
    assert.equal(free.code, 0, free.err)
    assert.equal(free.fake.count('herdr pane split'), 0)
    assert.equal(free.fake.count('herdr pane run w1:p9 '), 1)

    writePool('w1:p9 claude\n')
    const busy = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'claude' }, fake: { occupied: ['w1:p9'] } })
    assert.equal(busy.code, 0, busy.err)
    assert.equal(busy.fake.count('herdr pane split'), 1)
    assert.equal(busy.fake.count('herdr pane run w1:p9 '), 0)
  })

  test('un pane libre ocupado por un runner vivo de Mefisto no se reutiliza', async () => {
    writePool('w1:p9 claude\n')
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'claude' } })
    assert.equal(run.code, 0)
    // La reserva del despacho anterior nombra un PID vivo: el pane cuenta como ocupado.
    const again = await runHerdr(['--tooling', '873'], { env: { MEFISTO_RUNTIME: 'claude' }, deps: { isAlive: (pid) => pid === OWN_PID } })
    assert.equal(again.code, 0, again.err)
    assert.equal(again.fake.count('herdr pane run w1:p9 '), 0)
    assert.equal(again.fake.count('herdr pane split'), 1)
  })

  test('runtimes ambiguos abortan antes de tocar el pool y sin invocar herdr', async () => {
    writePool('w1:p9 claude\n')
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_FAKE_AVAILABLE: '1' } })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('No se pudo resolver el runtime activo'))
    assert.ok(run.err.includes('varios runtimes disponibles'))
    assert.equal(run.fake.calls.length, 0)
    assert.equal(readFileSync(poolFile(), 'utf8'), 'w1:p9 claude\n')
  })

  test('un pane nuevo se registra como <pane_id> <runtime>', async () => {
    rmSync(join(mefisto, '.mefisto'), { recursive: true, force: true })
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'fake' } })
    assert.equal(run.code, 0)
    assert.match(readFileSync(poolFile(), 'utf8'), /^w1:p[0-9]+ fake$/m)
  })

  test('un pane libre de otro runtime ni se reutiliza ni se cierra', async () => {
    writePool('w1:p9 claude\n')
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'fake' } })
    assert.equal(run.code, 0)
    assert.equal(run.fake.count('herdr pane split'), 1)
    assert.equal(run.fake.count('herdr pane close w1:p9'), 0)
    assert.ok(readFileSync(poolFile(), 'utf8').split('\n').includes('w1:p9 claude'))
  })

  test('la poda de sobrantes solo considera el mismo runtime', async () => {
    writePool('w1:p8 fake\nw1:p9 fake\nw1:p7 claude\n')
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'fake' } })
    assert.equal(run.code, 0, run.err)
    assert.equal(run.fake.count('herdr pane split'), 0)
    assert.equal(run.fake.count('herdr pane run w1:p8 '), 1)
    assert.equal(run.fake.count('herdr pane close w1:p9'), 1)
    assert.equal(run.fake.count('herdr pane close w1:p7'), 0)
    const pool = readFileSync(poolFile(), 'utf8').split('\n')
    assert.ok(pool.includes('w1:p7 claude'))
    assert.ok(!pool.includes('w1:p9 fake'))
  })

  test('una linea legacy sin runtime sale del pool sin cerrar su pane', async () => {
    writePool('w1:p9\n')
    const run = await runHerdr(['--tooling', '872'])
    assert.equal(run.code, 0, run.err)
    assert.equal(run.fake.count('herdr pane close w1:p9'), 0)
    assert.ok(!readFileSync(poolFile(), 'utf8').split('\n').includes('w1:p9'))
  })
})

describe('gate de rama de --batch', () => {
  test('con el arbol sucio fuera de main aborta antes de tocar panes', async () => {
    git(mefisto, 'checkout', '-q', '-b', 'feature-sucia-herdr')
    writeFileSync(join(mefisto, 'nota-pendiente.txt'), 'nota pendiente\n')
    try {
      const run = await runHerdr(['--batch', '872', '873'])
      assert.equal(run.code, 1)
      assert.match(run.err, /arbol.*limpio/i)
      assert.equal(run.fake.calls.length, 0)
    } finally {
      rmSync(join(mefisto, 'nota-pendiente.txt'))
      git(mefisto, 'checkout', '-q', 'main')
    }
  })

  test('con el arbol limpio recupera y actualiza main antes de despachar', async () => {
    git(publisher, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'origin avanza')
    git(publisher, 'push', '-q', 'origin', 'main')
    const expected = git(publisher, 'rev-parse', 'main').trim()
    git(mefisto, 'checkout', '-q', '-b', 'feature-limpia-herdr')
    const run = await runHerdr(['--batch', '872', '873'])
    assert.equal(run.code, 0, run.err)
    assert.equal(git(mefisto, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')
    assert.equal(git(mefisto, 'rev-parse', 'main').trim(), expected)
    assert.deepEqual(lastSpec(run.fake)?.command.slice(1), ['872', '873'])
  })
})

describe('confirmacion de arranque (issue #1563, porte #1571)', () => {
  test('confirmado al primer intento', async () => {
    rmSync(join(mefisto, '.mefisto'), { recursive: true, force: true })
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'claude' } })
    assert.equal(run.code, 0, run.err)
    assert.equal(run.fake.count('herdr pane split'), 1)
    assert.equal(run.fake.count('herdr pane run'), 1)
    assert.ok(run.err.includes('corriendo en el pane w1:p1'))
    assert.ok(run.err.includes('El pane muestra en vivo el visor del agente y el stdout del pipeline'))
    assert.ok(run.err.includes(`el reporte completo queda en ${join(mefisto, '.mefisto', 'pipeline', 'logs')}/.`))
    assert.ok(!run.err.includes('Reintentando'))
  })

  test('fallo del primer arranque y reintento en un pane nuevo', async () => {
    rmSync(join(mefisto, '.mefisto'), { recursive: true, force: true })
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'claude' }, fake: { neverConfirm: ['w1:p1'] } })
    assert.equal(run.code, 0, run.err)
    assert.equal(run.fake.count('herdr pane split'), 2)
    assert.equal(run.fake.count('herdr pane run'), 2)
    assert.equal(run.fake.count('herdr pane run w1:p1 '), 1)
    assert.equal(run.fake.count('herdr pane run w1:p2 '), 1)
    assert.ok(run.err.includes('El pane w1:p1 no confirmo el arranque'))
    assert.ok(run.err.includes('corriendo en el pane w1:p2'))
    assert.ok(run.err.includes('reintento tras un arranque no confirmado en w1:p1'))
    assert.ok(readFileSync(poolFile(), 'utf8').split('\n').includes('w1:p2 claude'))
  })

  test('fallo doble', async () => {
    rmSync(join(mefisto, '.mefisto'), { recursive: true, force: true })
    const run = await runHerdr(['--tooling', '872'], { env: { MEFISTO_RUNTIME: 'claude' }, fake: { neverConfirm: ['w1:p1', 'w1:p2'] } })
    assert.notEqual(run.code, 0)
    assert.equal(run.fake.count('herdr pane split'), 2)
    assert.equal(run.fake.count('herdr pane run'), 2)
    assert.ok(run.err.includes('w1:p1'))
    assert.ok(run.err.includes('w1:p2'))
    assert.ok(run.err.includes('Cierra ambos paneles'))
    assert.ok(!run.err.includes('corriendo en el pane'))
  })

  test('un runner tardio sobre un marcador reclamado aborta sin lanzar el pipeline', async () => {
    const late = join(work, 'late')
    mkdirSync(late, { recursive: true })
    const marker = join(late, 'herdr-dispatch-late.started')
    const sentinel = join(late, 'corrio')
    writeFileSync(marker, 'abandonado\n')
    const run = await runHerdr(
      ['--_pane-runner', '--title', 'late #872', '--started-marker', marker, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
      { env: { HERDR_ENV: undefined, HERDR_PANE_ID: undefined } },
    )
    assert.notEqual(run.code, 0)
    assert.ok(run.err.includes('ya reclamado por el despachador'))
    assert.equal(existsSync(sentinel), false)
  })
})

describe('guardas estaticas del canonico', () => {
  const source = readFileSync(CANONICAL, 'utf8')
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

  test('no nombra un runtime concreto ni compone el estado legacy', () => {
    assert.ok(!source.includes('claude -p'))
    assert.ok(!/:-claude|'claude'/.test(code))
    assert.ok(!code.includes('.claude/pipeline'))
    assert.ok(!code.includes('.claude/scripts'))
  })

  test('el runner del pane solo le quita al pipeline las variables HERDR_*', () => {
    const lib = readFileSync(join(import.meta.dirname, '..', '..', '..', 'scripts', 'lib', 'herdr.mts'), 'utf8')
    const filters = [...lib.matchAll(/startsWith\('([A-Z_]+)'\)/g)].map((match) => match[1])
    assert.deepEqual(filters, ['HERDR_'])
    assert.ok(!/MEFISTO_[A-Z_]*['"]\s*\]\s*=\s*undefined|delete\s+\w+\.MEFISTO_/.test(lib))
  })
})
