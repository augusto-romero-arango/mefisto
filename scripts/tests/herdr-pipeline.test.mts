import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { herdrPipeline, refreshAgentName, stackSplitRatio } from '../herdr-pipeline.mts'
import type { HerdrPipelineDeps } from '../herdr-pipeline.mts'
import { capture } from '../lib/cli.mts'
import { occupancyPath, readOccupancy } from '../lib/herdr.mts'
import { git, isolateGitConfig } from './field-note-sandbox.mts'
import { FakeClock, FakeHerdr, fail, ok, processInfoJson } from './herdr-sandbox.mts'
import type { FakeHerdrOptions } from './herdr-sandbox.mts'

const OWN_PID = 4242
const INSIDE = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0', HERDR_WORKSPACE_ID: 'w1' }
const ISSUES = {
  '42': { state: 'OPEN', labels: ['tipo:tooling'] },
  '43': { state: 'OPEN', labels: ['tipo:tooling'] },
  '44': { state: 'OPEN', labels: ['tipo:tooling'] },
  '50': { state: 'OPEN', labels: ['tipo:projection', 'dom:x'] },
  '51': { state: 'OPEN', labels: ['tipo:projection', 'dom:x'] },
  '60': { state: 'CLOSED', labels: ['tipo:tooling'] },
  '253': { state: 'OPEN', labels: ['tipo:tooling'] },
  '254': { state: 'OPEN', labels: ['tipo:tooling'] },
}

let work: string
let consumer: string
let restoreGit: () => void

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'herdr-pipeline-')))
  restoreGit = isolateGitConfig(work)
  consumer = join(work, 'consumidor')
  mkdirSync(consumer)
  git(consumer, 'init', '-q')
  consumer = realpathSync.native(consumer)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

const stateDir = (): string => join(consumer, '.mefisto', 'pipeline')
const poolFile = (): string => join(stateDir(), 'herdr-report-panes.txt')

function resetState(): void {
  rmSync(join(consumer, '.mefisto'), { recursive: true, force: true })
  rmSync(join(consumer, '.claude'), { recursive: true, force: true })
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
  herdrInPath?: boolean
  deps?: Partial<HerdrPipelineDeps>
}

async function runHerdr(argv: string[], options: RunOptions = {}): Promise<Outcome> {
  const fake = new FakeHerdr({ ownPane: 'w1:p0', ownerPid: OWN_PID, issues: ISSUES, ...options.fake })
  let out = ''
  let err = ''
  const clock = new FakeClock()
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    MEFISTO_RUNTIME: 'claude',
    HERDR_DISPATCH_CONFIRM_TIMEOUT: '1',
    ...INSIDE,
    ...options.env,
  }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  const code = await herdrPipeline({
    argv,
    cwd: consumer,
    env,
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    run: fake.run,
    hasCommand: (command) => command === 'herdr' && options.herdrInPath !== false,
    now: clock.now,
    sleep: clock.sleep,
    pid: OWN_PID,
    platform: 'linux',
    execPath: process.execPath,
    parentOf: () => null,
    isAlive: () => false,
    ...options.deps,
  })
  return { code, out, err, fake }
}

const lastSpec = (fake: FakeHerdr) => fake.typed.at(-1)?.spec

describe('stackSplitRatio', () => {
  test('alturas parejas para lotes de 2, 3 y 4 panes', () => {
    assert.equal(stackSplitRatio(2, 1), '0.5000')
    assert.equal(stackSplitRatio(3, 1), '0.3333')
    assert.equal(stackSplitRatio(3, 2), '0.5000')
    assert.equal(stackSplitRatio(4, 1), '0.2500')
    assert.equal(stackSplitRatio(4, 2), '0.3333')
    assert.equal(stackSplitRatio(4, 3), '0.5000')
  })
})

describe('guardas de entrada', () => {
  test('sin argumentos imprime la ayuda y sale 0', async () => {
    const run = await runHerdr([])
    assert.equal(run.code, 0)
    assert.ok(run.out.includes('herdr-pipeline.sh'))
    assert.ok(run.out.includes('--collapse-panes'))
  })

  test('en el repo de Mefisto aborta remitiendo a los skills internos', async () => {
    mkdirSync(join(consumer, '.claude-plugin'), { recursive: true })
    writeFileSync(join(consumer, '.claude-plugin', 'plugin.json'), '{}\n')
    try {
      const run = await runHerdr(['--tooling', '42'])
      assert.equal(run.code, 1)
      assert.ok(run.err.includes('es del plugin publicado y solo aplica al consumidor'))
      assert.equal(run.fake.calls.length, 0)
    } finally {
      rmSync(join(consumer, '.claude-plugin'), { recursive: true, force: true })
    }
  })

  test('fuera de herdr aborta sin tocar panes', async () => {
    const run = await runHerdr(['--tooling', '42'], { env: { HERDR_ENV: undefined } })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('No estas dentro de un pane de herdr'))
    assert.equal(run.fake.count('herdr pane'), 0)
  })

  test('--if-exists y --attach abortan', async () => {
    const retired = await runHerdr(['--tooling', '42', '--if-exists', 'x'])
    assert.equal(retired.code, 1)
    assert.ok(retired.err.includes('--attach e --if-exists ya no existen'))
    const attach = await runHerdr(['--attach'])
    assert.equal(attach.code, 1)
    assert.ok(attach.err.includes('En herdr no hay attach'))
  })

  test('un argumento desconocido aborta con la ayuda', async () => {
    const run = await runHerdr(['--nada'])
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('Argumento desconocido: --nada'))
    assert.ok(run.out.includes('Que hace:'))
  })

  test('un pane heredado aborta antes de cualquier split, run o close', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42'], { fake: { ownerPid: 999999 } })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('es heredado y no es el pane de esta sesion'))
    assert.equal(run.fake.count('herdr pane split') + run.fake.count('herdr pane run') + run.fake.count('herdr pane close'), 0)
  })

  test('el pane propio se reconoce subiendo por la cadena de padres', async () => {
    resetState()
    const parents = new Map([[OWN_PID, 300], [300, 77]])
    const run = await runHerdr(['--tooling', '42'], {
      fake: { ownerPid: 77 },
      deps: { parentOf: (pid) => parents.get(pid) ?? null },
    })
    assert.equal(run.code, 0, run.err)
  })
})

describe('--collapse-panes', () => {
  test('cierra solo los libres sobrantes del mismo workspace y runtime, sin despachar', async () => {
    resetState()
    mkdirSync(stateDir(), { recursive: true })
    const legacy = join(consumer, '.claude', 'pipeline', 'herdr-report-panes.txt')
    mkdirSync(join(consumer, '.claude', 'pipeline'), { recursive: true })
    writeFileSync(legacy, 'w1:legacy\n')
    writeFileSync(
      poolFile(),
      ['w1:p1 claude', 'w1:p2 claude', 'w1:p3 claude', 'w1:p4 fake', 'w1:p5 fake', 'w1:p6 fake', 'w1:p7 claude', 'w2:p9 claude', ''].join('\n'),
    )
    const run = await runHerdr(['--collapse-panes'], { fake: { dead: ['w1:p7'], occupied: ['w1:p3'] } })
    assert.equal(run.code, 0)
    assert.equal(run.out, '1\n')
    assert.equal(run.fake.count('herdr pane close'), 1)
    assert.ok(run.fake.calls.includes('herdr pane close w1:p2'))
    for (const pane of ['w1:p1', 'w1:p3', 'w1:p5', 'w2:p9']) assert.ok(!run.fake.calls.includes(`herdr pane close ${pane}`))
    assert.equal(run.fake.count('herdr pane split') + run.fake.count('herdr pane run'), 0)
    const pool = readFileSync(poolFile(), 'utf8')
    for (const row of ['w1:p1 claude', 'w1:p3 claude', 'w1:p5 fake', 'w2:p9 claude']) assert.ok(pool.includes(row))
    assert.ok(!pool.includes('w1:p2'))
    assert.ok(!pool.includes('w1:p7'))
    assert.equal(readFileSync(legacy, 'utf8'), 'w1:legacy\n')

    const fake = await runHerdr(['--collapse-panes'], { env: { MEFISTO_RUNTIME: 'fake' } })
    assert.equal(fake.out, '2\n')
    assert.ok(fake.fake.calls.includes('herdr pane close w1:p5'))
    assert.ok(fake.fake.calls.includes('herdr pane close w1:p6'))
    assert.ok(!fake.fake.calls.includes('herdr pane close w1:p1'))
    assert.ok(readFileSync(poolFile(), 'utf8').includes('w1:p4 fake'))
  })

  test('no-op seguro fuera de contexto, con runtime invalido o sin pool previo', async () => {
    resetState()
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(poolFile(), 'w1:p1 claude\nw1:p2 claude\n')
    const outside = await runHerdr(['--collapse-panes'], { env: { HERDR_ENV: undefined } })
    assert.deepEqual([outside.code, outside.out, outside.fake.calls.length], [0, '0\n', 0])

    const before = readFileSync(poolFile(), 'utf8')
    const invalid = await runHerdr(['--collapse-panes'], { env: { MEFISTO_RUNTIME: 'invalido' } })
    assert.deepEqual([invalid.code, invalid.out, invalid.fake.calls.length], [0, '0\n', 0])
    assert.equal(readFileSync(poolFile(), 'utf8'), before)

    rmSync(poolFile())
    const missing = await runHerdr(['--collapse-panes'])
    assert.deepEqual([missing.code, missing.out, missing.fake.calls.length], [0, '0\n', 0])

    const noHerdr = await runHerdr(['--collapse-panes'], { herdrInPath: false })
    assert.deepEqual([noHerdr.code, noHerdr.out], [0, '0\n'])
  })

  test('el despacho comparte la poda: cierra el sobrante y reutiliza el primer libre', async () => {
    resetState()
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(poolFile(), 'w1:p8 claude\nw1:p9 claude\n')
    const run = await runHerdr(['--tooling', '42'])
    assert.equal(run.code, 0, run.err)
    assert.ok(run.fake.calls.includes('herdr pane close w1:p9'))
    assert.ok(run.fake.calls.some((call) => call.startsWith('herdr pane run w1:p8 ')))
    assert.equal(run.fake.count('herdr pane split'), 0)
  })
})

describe('confirmacion de arranque (issue #1563)', () => {
  test('confirmado al primer intento: un split, un run, sin reintento', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42'])
    assert.equal(run.code, 0, run.err)
    assert.equal(run.fake.count('herdr pane split'), 1)
    assert.equal(run.fake.count('herdr pane run'), 1)
    assert.ok(run.err.includes('corriendo en el pane w1:p1'))
    assert.ok(!run.err.includes('Reintentando'))
  })

  test('fallo y reintento exitoso en un pane nuevo, sin volver a escribir en el sospechoso', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42'], { fake: { neverConfirm: ['w1:p1'] } })
    assert.equal(run.code, 0, run.err)
    assert.equal(run.fake.count('herdr pane split'), 2)
    assert.equal(run.fake.count('herdr pane run'), 2)
    assert.equal(run.fake.count('herdr pane run w1:p1 '), 1)
    assert.equal(run.fake.count('herdr pane run w1:p2 '), 1)
    assert.ok(run.err.includes('El pane w1:p1 no confirmo el arranque'))
    assert.ok(run.err.includes('corriendo en el pane w1:p2'))
    assert.ok(run.err.includes('reintento tras un arranque no confirmado en w1:p1'))
  })

  test('fallo doble: aborta nombrando ambos panes', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42'], { fake: { neverConfirm: ['w1:p1', 'w1:p2'] } })
    assert.equal(run.code, 1)
    assert.equal(run.fake.count('herdr pane split'), 2)
    assert.equal(run.fake.count('herdr pane run'), 2)
    assert.ok(run.err.includes('w1:p1'))
    assert.ok(run.err.includes('w1:p2'))
    assert.ok(run.err.includes('Cierra ambos paneles'))
    assert.ok(!run.err.includes('corriendo en el pane'))
    // El despachador reclamo los marcadores: un runner tardio no arrancaria.
    const markers = run.fake.typed.map((typed) => typed.spec?.startedMarker ?? '')
    for (const marker of markers) assert.equal(readFileSync(marker, 'utf8'), 'abandonado\n')
  })

  test('herdr pane run que falla aborta', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42'], {
      fake: { respond: (args) => (args[0] === 'pane' && args[1] === 'run' ? fail() : undefined) },
    })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('No se pudo lanzar el pipeline en el pane w1:p1 (herdr pane run fallo).'))
  })

  test('--scaffold despacha con MEFISTO_RUNTIME resuelto en el archivo de despacho', async () => {
    resetState()
    const run = await runHerdr(['--scaffold', '42', '--domain', 'DemoX'])
    assert.equal(run.code, 0, run.err)
    const spec = lastSpec(run.fake)
    assert.deepEqual(spec?.env, { MEFISTO_RUNTIME: 'claude' })
    assert.equal(spec?.title, 'scaffold demo-x')
    assert.deepEqual(spec?.command.slice(1), ['42', '--domain', 'demo-x'])
    assert.ok(spec?.command[0]?.endsWith('scaffold-pipeline.mts'))
  })
})

describe('la linea tecleada en el pane', () => {
  test('es node con el script y el archivo de despacho, sin sintaxis de shell', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42', '--models', "writer=claude-opus-5[1m],reviewer='x'"])
    assert.equal(run.code, 0, run.err)
    const typed = run.fake.typed[0]
    assert.ok(typed !== undefined)
    assert.match(typed.line, /^node "[^"]+herdr-pipeline\.mts" "--_pane-runner" "--dispatch" "[^"]+herdr-dispatch-[0-9]+-4242-1\.json"$/)
    for (const forbidden of [';', '&&', '$(', '>', '<', '|', 'MEFISTO_RUNTIME=']) assert.ok(!typed.line.includes(forbidden))
    assert.deepEqual(typed.spec?.command.slice(1), ['42', '--models', "writer=claude-opus-5[1m],reviewer='x'"])
    assert.equal(typed.spec?.cwd, consumer)
    assert.equal(typed.spec?.pane, 'w1:p1')
  })

  test('el despachador reserva el pane con su PID antes de teclear', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42'])
    const record = readOccupancy(occupancyPath(stateDir(), 'w1:p1'))
    assert.equal(record?.pid, OWN_PID)
    assert.equal(record?.token, run.fake.typed[0]?.spec?.token)
  })

  test('una ruta de estado que no se puede citar aborta antes de abrir panes', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '42'], { env: { MEFISTO_STATE_DIR: join(work, 'estado$raro') } })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes("No se puede teclear el runner en un pane"))
    assert.equal(run.fake.count('herdr pane split'), 0)
  })
})

describe('--parallel (issue #705)', () => {
  test('tres issues: panes apilados y arranques escalonados', async () => {
    resetState()
    const run = await runHerdr(['--parallel', '--pipeline', 'tooling', '42', '43', '44'])
    assert.equal(run.code, 0, run.err)
    assert.ok(run.fake.log.includes('pane split --pane w1:p0 --direction right'))
    assert.ok(run.fake.log.includes('pane split --pane w1:p1 --direction down --ratio 0.3333'))
    assert.ok(run.fake.log.includes('pane split --pane w1:p2 --direction down --ratio 0.5000'))
    assert.equal(run.fake.count('herdr pane run'), 3)
    const byPane = Object.fromEntries(run.fake.typed.map((typed) => [typed.pane, typed.spec]))
    assert.equal(byPane['w1:p1']?.issues, '42')
    assert.equal(byPane['w1:p1']?.delay, 0)
    assert.equal(byPane['w1:p2']?.issues, '43')
    assert.equal(byPane['w1:p2']?.delay, 30)
    assert.equal(byPane['w1:p3']?.issues, '44')
    assert.equal(byPane['w1:p3']?.delay, 60)
    assert.deepEqual(byPane['w1:p1']?.env, { MEFISTO_RUNTIME: 'claude' })
    assert.ok(run.fake.typed.every((typed) => typed.line.includes('"--_pane-runner"')))
    assert.equal(readFileSync(poolFile(), 'utf8'), 'w1:p1 claude\nw1:p2 claude\nw1:p3 claude\n')
    assert.ok(run.err.includes('arranca en 30s'))
  })

  test('un pane propio ocupado no se reutiliza y se registra el split nuevo', async () => {
    resetState()
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(poolFile(), 'w1:p9 claude\n')
    const run = await runHerdr(['--tooling', '42'], { fake: { occupied: ['w1:p9'] } })
    assert.equal(run.code, 0, run.err)
    assert.ok(run.fake.log.includes('pane split --pane w1:p0 --direction right'))
    assert.equal(run.fake.count('herdr pane run w1:p9'), 0)
    const pool = readFileSync(poolFile(), 'utf8')
    assert.ok(pool.includes('w1:p9 claude'))
    assert.ok(pool.includes('w1:p1 claude'))
  })

  test('el pool legacy nunca participa', async () => {
    resetState()
    const legacy = join(consumer, '.claude', 'pipeline', 'herdr-report-panes.txt')
    mkdirSync(join(consumer, '.claude', 'pipeline'), { recursive: true })
    writeFileSync(legacy, 'w1:legacy\n')
    const run = await runHerdr(['--tooling', '42'], { env: { MEFISTO_RUNTIME: 'fake' } })
    assert.equal(run.code, 0, run.err)
    assert.ok(run.fake.log.includes('pane split --pane w1:p0 --direction right'))
    assert.equal(readFileSync(poolFile(), 'utf8'), 'w1:p1 fake\n')
    assert.equal(readFileSync(legacy, 'utf8'), 'w1:legacy\n')
    assert.deepEqual(lastSpec(run.fake)?.env, { MEFISTO_RUNTIME: 'fake' })
  })

  test('un runtime invalido aborta antes de tocar el pool', async () => {
    resetState()
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(poolFile(), 'w1:p1 fake\n')
    const run = await runHerdr(['--parallel', '--pipeline', 'tooling', '42'], { env: { MEFISTO_RUNTIME: 'invalido' } })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('No se pudo resolver el runtime activo'))
    assert.equal(run.fake.count('herdr pane'), 0)
    assert.equal(readFileSync(poolFile(), 'utf8'), 'w1:p1 fake\n')
  })

  test('dos tipo:projection abortan sin despachar; una sola pasa', async () => {
    resetState()
    const run = await runHerdr(['--parallel', '50', '51'])
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('tipo:projection'))
    assert.ok(run.err.includes('/sequential'))
    assert.equal(run.fake.count('herdr pane run') + run.fake.count('herdr pane split'), 0)
    resetState()
    assert.equal((await runHerdr(['--parallel', '50', '42'])).code, 0)
  })

  test('issues cerrados se saltan; un lote sin validos aborta', async () => {
    resetState()
    const run = await runHerdr(['--parallel', '60', '42'])
    assert.equal(run.code, 0, run.err)
    assert.ok(run.err.includes('#60 esta CLOSED'))
    assert.equal(run.fake.count('herdr pane run'), 1)
    resetState()
    const empty = await runHerdr(['--parallel', '60'])
    assert.equal(empty.code, 1)
    assert.ok(empty.err.includes('No hay issues validos'))
  })

  test('un override invalido aborta', async () => {
    const run = await runHerdr(['--parallel', '--pipeline', 'otro', '42'])
    assert.equal(run.code, 1)
    assert.ok(run.err.includes("Override de pipeline invalido: 'otro' (usa tdd|tooling)."))
  })

  test('--from-stage con --parallel aborta; varios issues sin modo van a --parallel', async () => {
    const ambiguous = await runHerdr(['--parallel', '42', '43', '--from-stage', '3'])
    assert.equal(ambiguous.code, 1)
    assert.ok(ambiguous.err.includes('--from-stage no es valido con --parallel'))
    resetState()
    const fallback = await runHerdr(['--pipeline', 'tooling', '42', '43'])
    assert.equal(fallback.code, 0, fallback.err)
    assert.ok(fallback.err.includes('Usando --parallel'))
    assert.equal(fallback.fake.count('herdr pane run'), 2)
  })

  test('el marcador no confirmado de un issue del lote falla nombrando issue y pane', async () => {
    resetState()
    const run = await runHerdr(['--parallel', '--pipeline', 'tooling', '42', '43'], { fake: { neverConfirm: ['w1:p2'] } })
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('Issue #43: el pane w1:p2 no confirmo el arranque'))
    assert.ok(run.err.includes('No se confirmo el arranque de 1 issue(s) del lote: #43 en el pane w1:p2.'))
  })
})

describe('--infra (issue #1627)', () => {
  test('despacha iac-pipeline con el runtime resuelto', async () => {
    for (const runtime of ['claude', 'fake']) {
      resetState()
      const run = await runHerdr(['--infra', '42'], { env: { MEFISTO_RUNTIME: runtime } })
      assert.equal(run.code, 0, run.err)
      const spec = lastSpec(run.fake)
      assert.ok(spec?.command[0]?.endsWith('iac-pipeline.mts'))
      assert.deepEqual(spec?.env, { MEFISTO_RUNTIME: runtime })
      assert.equal(spec?.title, 'infra #42')
    }
  })
})

describe('--models y --variant (issues #708, #710, #712, #713)', () => {
  test('--tooling reenvia --models intacto, combinado con --from-stage', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '253', '--from-stage', '2', '--models', 'writer=sonnet,reviewer=opus'])
    assert.equal(run.code, 0, run.err)
    assert.deepEqual(lastSpec(run.fake)?.command.slice(1), ['253', '--from-stage', '2', '--models', 'writer=sonnet,reviewer=opus'])
  })

  test('un id de modelo con caracteres de glob llega intacto', async () => {
    resetState()
    const run = await runHerdr(['--tooling', '253', '--models', 'writer=claude-opus-5[1m]'])
    assert.deepEqual(lastSpec(run.fake)?.command.slice(-2), ['--models', 'writer=claude-opus-5[1m]'])
  })

  test('--models y --variant sin valor o con un modo que no los admite abortan sin despachar', async () => {
    for (const [argv, message] of [
      [['--tooling', '253', '--models'], 'Falta el valor de --models'],
      [['--tooling', '253', '--variant'], 'Falta el valor de --variant'],
      [['--infra', '253', '--models', 'writer=sonnet'], '--models todavia no es valido con --infra'],
      [['--infra', '253', '--variant', 'a'], '--variant todavia no es valido con --infra'],
      [['--parallel', '253', '254', '--models', 'writer=sonnet', '--pipeline', 'tooling'], '--models no es valido con --parallel'],
      [['--parallel', '253', '254', '--variant', 'a', '--pipeline', 'tooling'], '--variant no es valido con --parallel'],
      [['--batch', '253', '254', '--models', 'writer=sonnet', '--pipeline', 'tooling'], '--models no es valido con --batch'],
      [['--batch', '253', '254', '--variant', 'a', '--pipeline', 'tooling'], '--variant no es valido con --batch'],
      [['--scaffold', '253', '--domain', 'x', '--models', 'a=b'], '--models no es valido con --scaffold'],
      [['253', '254', '--models', 'a=b'], '--models no es valido con multiples issues'],
      [['--tooling', '253', '--from-stage', 'dos'], '--from-stage debe ser un numero entero'],
    ] as const) {
      const run = await runHerdr([...argv])
      assert.equal(run.code, 1, argv.join(' '))
      assert.ok(run.err.includes(message), `${argv.join(' ')}: ${run.err}`)
      assert.equal(run.fake.count('herdr pane run'), 0)
    }
  })

  test('issue suelto enrutado por --pipeline reenvia --models y --variant en ese orden', async () => {
    resetState()
    const tooling = await runHerdr(['253', '--models', 'writer=sonnet', '--pipeline', 'tooling'])
    assert.equal(tooling.code, 0, tooling.err)
    assert.deepEqual(lastSpec(tooling.fake)?.command.slice(1), ['253', '--models', 'writer=sonnet'])
    resetState()
    const tdd = await runHerdr(['253', '--models', 'test-writer=opus', '--variant', 'b', '--pipeline', 'tdd'])
    const spec = lastSpec(tdd.fake)
    assert.ok(spec?.command[0]?.endsWith('tdd-pipeline.mts'))
    assert.deepEqual(spec?.command.slice(1), ['253', '--models', 'test-writer=opus', '--variant', 'b'])
    assert.equal(spec?.title, 'tdd #253 (b)')
    resetState()
    const variant = await runHerdr(['253', '--variant', 'experimento-a', '--pipeline', 'tdd'])
    assert.deepEqual(lastSpec(variant.fake)?.command.slice(1), ['253', '--variant', 'experimento-a'])
  })

  test('--tooling reenvia --variant con y sin --models, y lo muestra en el titulo', async () => {
    resetState()
    const both = await runHerdr(['--tooling', '253', '--models', 'writer=sonnet', '--variant', 'experimento-a'])
    assert.deepEqual(lastSpec(both.fake)?.command.slice(1), ['253', '--models', 'writer=sonnet', '--variant', 'experimento-a'])
    assert.equal(lastSpec(both.fake)?.title, 'tooling #253 (experimento-a)')
    resetState()
    const only = await runHerdr(['--tooling', '253', '--variant', 'b'])
    assert.deepEqual(lastSpec(only.fake)?.command.slice(1), ['253', '--variant', 'b'])
  })

  test('--batch despacha batch-pipeline con el override y los issues', async () => {
    resetState()
    const run = await runHerdr(['--batch', '42', '43', '--pipeline', 'tooling'])
    assert.equal(run.code, 0, run.err)
    const spec = lastSpec(run.fake)
    assert.ok(spec?.command[0]?.endsWith('batch-pipeline.mts'))
    assert.deepEqual(spec?.command.slice(1), ['--pipeline', 'tooling', '42', '43'])
    assert.equal(spec?.title, 'batch 42,43')
    assert.equal(spec?.issues, '42,43')
  })
})

describe('--refresh-agents (#1333, #1335)', () => {
  let libDir: string
  let root: string

  before(() => {
    libDir = join(work, 'runtime')
    mkdirSync(libDir, { recursive: true })
    writeFileSync(join(libDir, 'runtime-prompted.mts'), "export function interactiveRefresh() { return 'prompt reload all\\n' }\n")
    writeFileSync(join(libDir, 'runtime-restarting.mts'), "export function interactiveRefresh() { return 'restart /exit' }\n")
    writeFileSync(join(libDir, 'runtime-broken.mts'), "export function interactiveRefresh() { throw new Error('roto') }\n")
    writeFileSync(join(libDir, 'runtime-without.mts'), 'export function other() { return 1 }\n')
    root = capture('git', ['rev-parse', '--show-toplevel'], { cwd: consumer }).stdout.trim()
  })

  const agentList = (): string => {
    const agent = (fields: Record<string, string>): Record<string, string> => ({ cwd: root, workspace_id: 'w9', agent_status: 'idle', ...fields })
    return `${JSON.stringify({
      result: {
        agents: [
          agent({ agent: 'prompted', pane_id: 'w9:self' }),
          agent({ agent: 'prompted', agent_status: 'working', pane_id: 'w9:work' }),
          agent({ agent: 'prompted', agent_status: 'blocked', pane_id: 'w9:block' }),
          agent({ agent: 'missing', pane_id: 'w9:missing' }),
          agent({ agent: 'without', pane_id: 'w9:without' }),
          agent({ agent: 'broken', pane_id: 'w9:broken' }),
          agent({ agent: 'prompted', pane_id: 'w9:ok' }),
          agent({ agent: 'prompted', pane_id: 'w9:fail' }),
          agent({ agent: 'restarting', name: 'restart-nombrado', pane_id: 'w9:restart-listo' }),
          agent({ agent: 'restarting', pane_id: 'w9:sin-nombre' }),
          agent({ agent: 'restarting', pane_id: 'w9:sin-salida' }),
          agent({ agent: 'restarting', name: 'restart-fallido', pane_id: 'w9:inicio-falla' }),
          agent({ agent: 'prompted', cwd: '/otro', pane_id: 'w9:other-cwd' }),
          agent({ agent: 'prompted', pane_id: 'w8:other-workspace', workspace_id: 'w8' }),
        ],
      },
    })}\n`
  }

  const refreshFake = (): FakeHerdrOptions => {
    let polled = false
    return {
      respond: (args) => {
        const key = `${args[0]} ${args[1]}`
        if (key === 'agent list') return ok(agentList())
        if (key === 'agent prompt') return args[2] === 'w9:fail' ? fail() : ok()
        if (key === 'agent start') return args[2] === 'restart-fallido' ? fail() : ok()
        if (key === 'pane process-info') {
          const pane = args[3]
          if (pane === 'w9:restart-listo') {
            const free = polled
            polled = true
            return ok(free ? processInfoJson(42, 42) : processInfoJson(42, 99))
          }
          return ok(pane === 'w9:sin-nombre' || pane === 'w9:inicio-falla' ? processInfoJson(42, 42) : processInfoJson(42, 99))
        }
        return undefined
      },
    }
  }

  const refreshEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'w9:self', HERDR_WORKSPACE_ID: 'w9', MEFISTO_REFRESH_EXIT_TIMEOUT: '1' }

  test('no-op silencioso fuera de contexto', async () => {
    for (const env of [
      { HERDR_ENV: undefined, HERDR_PANE_ID: undefined, HERDR_WORKSPACE_ID: undefined },
      { ...refreshEnv, HERDR_ENV: undefined },
      { ...refreshEnv, HERDR_PANE_ID: undefined },
      { ...refreshEnv, HERDR_WORKSPACE_ID: undefined },
    ]) {
      const run = await runHerdr(['--refresh-agents'], { env: { ...env, MEFISTO_RUNTIME_LIB_DIR: libDir }, fake: refreshFake() })
      assert.deepEqual([run.code, run.out, run.fake.calls.length], [0, '', 0])
    }
    const noHerdr = await runHerdr(['--refresh-agents'], {
      env: { ...refreshEnv, MEFISTO_RUNTIME_LIB_DIR: libDir },
      fake: refreshFake(),
      herdrInPath: false,
    })
    assert.deepEqual([noHerdr.code, noHerdr.out, noHerdr.fake.calls.length], [0, '', 0])
  })

  test('descubre, filtra y aplica la estrategia de cada adaptador', async () => {
    const run = await runHerdr(['--refresh-agents'], { env: { ...refreshEnv, MEFISTO_RUNTIME_LIB_DIR: libDir }, fake: refreshFake() })
    assert.equal(run.code, 0)
    assert.equal(
      run.out,
      [
        'w9:self prompted omitido:pane-propio',
        'w9:work prompted omitido:working',
        'w9:block prompted omitido:blocked',
        'w9:missing missing omitido:sin-estrategia',
        'w9:without without omitido:sin-estrategia',
        'w9:broken broken omitido:sin-estrategia',
        'w9:ok prompted reload-enviado',
        'w9:fail prompted omitido:prompt-fallo',
        'w9:restart-listo restarting reiniciado',
        'w9:sin-nombre restarting reiniciado',
        'w9:sin-salida restarting omitido:no-salio',
        'w9:inicio-falla restarting omitido:relanzamiento-fallo',
        '',
      ].join('\n'),
    )
    const argvs = run.fake.argvs.map((args) => args.join(' '))
    assert.ok(argvs.includes('agent prompt w9:ok reload all'))
    assert.ok(argvs.includes('agent prompt w9:restart-listo /exit'))
    assert.ok(argvs.includes('pane process-info --pane w9:restart-listo'))
    assert.ok(argvs.includes('agent start restart-nombrado --kind restarting --pane w9:restart-listo'))
    assert.ok(argvs.includes('agent start mefisto-refresh-w9-sin-nombre --kind restarting --pane w9:sin-nombre'))
    assert.ok(!argvs.some((args) => args.startsWith('agent start mefisto-refresh-w9-sin-salida')))
    assert.ok(argvs.includes('agent start restart-fallido --kind restarting --pane w9:inicio-falla'))
  })

  test('refreshAgentName deriva un nombre valido del pane', () => {
    assert.equal(refreshAgentName('nombre', 'w9:x'), 'nombre')
    assert.equal(refreshAgentName('', 'w9:sin-nombre'), 'mefisto-refresh-w9-sin-nombre')
    assert.equal(refreshAgentName('', 'W9::Muy-Largo-Para-El-Tope'), 'mefisto-refresh-w9-muy-largo-par')
    assert.equal(refreshAgentName('', '::'), 'mefisto-refresh-pane')
  })

  test('el script no compone rutas del estado legacy', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'herdr-pipeline.mts'), 'utf8')
    assert.ok(!source.includes('.claude/pipeline'))
    assert.ok(!/'\.claude', 'pipeline'/.test(source))
  })

  test('el modo no nombra runtimes ni mata procesos', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'herdr-pipeline.mts'), 'utf8')
    const block = source.slice(source.indexOf('async function refreshAgents'), source.indexOf('// --scaffold-domain'))
    assert.ok(block.length > 0)
    assert.ok(!/claude/i.test(block))
    assert.ok(!/\b(kill|pkill|killall)\b/.test(block))
  })
})

describe('runner del pane', () => {
  test('un marcador ya reclamado aborta sin lanzar el pipeline', async () => {
    const late = join(work, 'late')
    mkdirSync(late, { recursive: true })
    const marker = join(late, 'herdr-dispatch-late.started')
    const sentinel = join(late, 'corrio')
    writeFileSync(marker, 'abandonado\n')
    const run = await runHerdr(
      ['--_pane-runner', '--title', 'late #42', '--started-marker', marker, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
      { env: { HERDR_ENV: undefined, HERDR_PANE_ID: undefined } },
    )
    assert.equal(run.code, 1)
    assert.ok(run.err.includes('ya reclamado por el despachador'))
    assert.equal(existsSync(sentinel), false)
  })

  test('valida sus argumentos', async () => {
    for (const [argv, message] of [
      [['--_pane-runner', '--', 'x'], '--_pane-runner requiere --title'],
      [['--_pane-runner', '--title', 't'], '--_pane-runner requiere un comando tras --'],
      [['--_pane-runner', '--title'], 'Falta el valor de --title'],
      [['--_pane-runner', '--title', 't', '--delay', 'x', '--', 'y'], '--delay debe ser un entero de segundos'],
      [['--_pane-runner', '--otra'], 'Argumento no reconocido para --_pane-runner: --otra'],
      [['--_pane-runner', '--dispatch', join(work, 'no-existe.json')], 'No se pudo leer el archivo de despacho'],
    ] as const) {
      const run = await runHerdr([...argv])
      assert.equal(run.code, 1, argv.join(' '))
      assert.ok(run.err.includes(message), run.err)
    }
  })
})
