import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess, StdioOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { resolveCommand } from '../lib/cli.mts'
import {
  claimDispatchMarker,
  descendsFromPaneShell,
  dispatchSpecPath,
  markPaneOccupied,
  occupancyPath,
  paneArgumentProblem,
  paneCommandLine,
  paneIsFree,
  posixParentOf,
  prunePanes,
  readDispatchSpec,
  readOccupancy,
  releasePane,
  runnableCommand,
  runPaneRunner,
  tailLines,
  waitForDispatchMarker,
  windowsParentOf,
  writeDispatchSpec,
} from '../lib/herdr.mts'
import type { DispatchSpec, LaunchChild, PaneRunnerDeps, PaneRunnerFlavor } from '../lib/herdr.mts'
import type { SignalSource } from '../lib/pipeline/pipeline-exit.mts'
import { FakeClock, FakeHerdr, fail, ok, processInfoJson } from './herdr-sandbox.mts'

let work: string
const spawned: ChildProcess[] = []

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'herdr-lib-')))
})

after(() => {
  for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill()
  rmSync(work, { recursive: true, force: true })
})

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

// --- Linea que se teclea en el pane ---

const SAFE_ARGUMENTS = [
  '--_pane-runner',
  'C:\\Users\\ana\\repo\\scripts\\herdr-pipeline.mts',
  '/home/ana/mi repo (copia)/.mefisto/pipeline/herdr-dispatch-1-2-3.json',
  "writer=claude-opus-5[1m],reviewer='sonnet'",
  'a & b | c ; d < e > f ( g ) ^h #i ~j {k} *l ?m @n =o +p ,q',
  'acentos: ñandú, café',
]

const UNSAFE_ARGUMENTS = [
  '',
  'con "comillas"',
  'precio $HOME',
  'sub `cmd`',
  '%PATH%',
  'hola!',
  'linea\nnueva',
  'tab\tcontrol',
  '\\\\servidor\\recurso',
  'C:\\termina\\',
  'escapa\\"',
  'tipografica \u201cx\u201d',
]

// Lectura de un argumento entre comillas dobles segun cada shell. Cada modelo rechaza lo que su
// shell interpretaria dentro de las comillas en vez de leerlo literal.
const SHELL_SPECIALS: Record<string, RegExp> = {
  bash: /[$`"!]|\\(?=[$`"\\\n])|\\$/,
  zsh: /[$`"!]|\\(?=[$`"\\\n])|\\$/,
  powershell: /[$`"\u201c\u201d\u201e]/,
  cmd: /[%"!\n]/,
}

function parseLine(shell: string, line: string): string[] {
  const special = SHELL_SPECIALS[shell] as RegExp
  const match = /^node((?: "[^"]*")*)$/.exec(line)
  if (match === null) throw new Error(`${shell}: la linea no tiene la forma node "..."`)
  return [...(match[1] as string).matchAll(/ "([^"]*)"/g)].map((m) => {
    const value = m[1] as string
    if (special.test(value)) throw new Error(`${shell} reinterpretaria ${JSON.stringify(value)}`)
    // Node en Windows: barras invertidas antes de una comilla se reinterpretan.
    if (/\\+$/.test(value)) throw new Error(`node reinterpretaria ${JSON.stringify(value)}`)
    return value
  })
}

describe('linea tecleada en el pane', () => {
  test('acepta argumentos con espacios y metacaracteres que las comillas dobles neutralizan', () => {
    for (const arg of SAFE_ARGUMENTS) assert.equal(paneArgumentProblem(arg), null, arg)
  })

  test('rechaza lo que algun shell reinterpretaria dentro de comillas dobles', () => {
    for (const arg of UNSAFE_ARGUMENTS) assert.notEqual(paneArgumentProblem(arg), null, JSON.stringify(arg))
    assert.throws(() => paneCommandLine('/x/herdr-pipeline.mts', ['$x']), /contiene '\$'/)
  })

  test('cada shell lee la misma lista de argumentos', () => {
    const line = paneCommandLine(SAFE_ARGUMENTS[1] as string, SAFE_ARGUMENTS.slice(2))
    for (const shell of Object.keys(SHELL_SPECIALS)) assert.deepEqual(parseLine(shell, line), SAFE_ARGUMENTS.slice(1), shell)
  })

  test('todo argumento rechazado lo reinterpretaria al menos un shell o node', () => {
    for (const arg of UNSAFE_ARGUMENTS.filter((value) => value !== '' && !/[\u0000-\u001f]/.test(value))) {
      const line = `node "${arg}"`
      const misread = Object.keys(SHELL_SPECIALS).some((shell) => {
        try {
          parseLine(shell, line)
          return false
        } catch {
          return true
        }
      })
      assert.ok(misread || /["\\]/.test(arg), JSON.stringify(arg))
    }
  })

  describe('ejecutada de verdad', () => {
    let printer: string
    let env: NodeJS.ProcessEnv
    const expected = SAFE_ARGUMENTS.filter((arg) => arg !== '--_pane-runner')

    before(() => {
      const dir = join(work, "shells (con espacios) & 'raro' #1")
      mkdirSync(dir, { recursive: true })
      printer = join(dir, 'imprime-argv.mjs')
      writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
      env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
    })

    const argvFrom = (result: { status: number | null; stdout: string; stderr: string }): string[] => {
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout) as string[]
    }
    const line = (): string => paneCommandLine(printer, expected)
    const onWindows = process.platform === 'win32'

    test('bash', { skip: onWindows || resolveCommand('bash') === null }, () => {
      assert.deepEqual(argvFrom(spawnSync('bash', ['-c', line()], { env, encoding: 'utf8' })), expected)
    })

    test('zsh', { skip: onWindows || resolveCommand('zsh') === null }, () => {
      assert.deepEqual(argvFrom(spawnSync('zsh', ['-f', '-c', line()], { env, encoding: 'utf8' })), expected)
    })

    test('PowerShell', { skip: process.platform !== 'win32' }, () => {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', line()], { env, encoding: 'utf8' })
      assert.deepEqual(argvFrom(result), expected)
    })

    test('cmd.exe', { skip: process.platform !== 'win32' }, () => {
      const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line()}"`], {
        env,
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      })
      assert.deepEqual(argvFrom(result), expected)
    })
  })
})

// --- Ocupacion ---

describe('ocupacion de un pane', () => {
  const herdr = (foregroundFree: boolean): FakeHerdr =>
    new FakeHerdr({ respond: (args) => (args[1] === 'process-info' ? ok(processInfoJson(100, foregroundFree ? 100 : 200)) : undefined) })

  test('un pane marcado con un PID vivo esta ocupado aunque el shell este en su prompt', () => {
    const state = join(work, 'ocupacion-viva')
    markPaneOccupied(occupancyPath(state, 'w1:p1'), { pane: 'w1:p1', pid: process.pid, token: 't', title: 'x' })
    for (const platform of ['linux', 'win32'] as const) {
      const fake = herdr(true)
      assert.equal(paneIsFree('w1:p1', { run: fake.run, stateDir: state, platform }), false, platform)
    }
  })

  test('un pane marcado con un PID muerto esta libre', () => {
    const state = join(work, 'ocupacion-muerta')
    markPaneOccupied(occupancyPath(state, 'w1:p1'), { pane: 'w1:p1', pid: deadPid(), token: 't', title: 'x' })
    assert.equal(paneIsFree('w1:p1', { run: herdr(true).run, stateDir: state, platform: 'linux' }), true)
    const windows = herdr(true)
    assert.equal(paneIsFree('w1:p1', { run: windows.run, stateDir: state, platform: 'win32' }), true)
    assert.equal(windows.calls.length, 0)
  })

  test('liberado por su runner: libre en Windows; en POSIX decide el grupo de foreground', () => {
    const state = join(work, 'ocupacion-liberada')
    const path = occupancyPath(state, 'w1:p2')
    markPaneOccupied(path, { pane: 'w1:p2', pid: process.pid, token: 't', title: 'x' })
    releasePane(path, 't')
    assert.equal(readOccupancy(path)?.pid, null)
    assert.equal(paneIsFree('w1:p2', { run: herdr(false).run, stateDir: state, platform: 'win32' }), true)
    assert.equal(paneIsFree('w1:p2', { run: herdr(true).run, stateDir: state, platform: 'linux' }), true)
    assert.equal(paneIsFree('w1:p2', { run: herdr(false).run, stateDir: state, platform: 'linux' }), false)
  })

  test('sin marca: en POSIX decide herdr; en Windows cuenta como ocupado', () => {
    const state = join(work, 'sin-marca')
    assert.equal(paneIsFree('w1:p3', { run: herdr(true).run, stateDir: state, platform: 'linux' }), true)
    assert.equal(paneIsFree('w1:p3', { run: herdr(false).run, stateDir: state, platform: 'linux' }), false)
    assert.equal(paneIsFree('w1:p3', { run: herdr(true).run, stateDir: state, platform: 'win32' }), false)
    const failing = new FakeHerdr({ respond: () => fail() })
    assert.equal(paneIsFree('w1:p3', { run: failing.run, stateDir: state, platform: 'linux' }), false)
  })

  test('liberar no pisa la marca de otro despacho', () => {
    const path = occupancyPath(join(work, 'otro-token'), 'w1:p4')
    markPaneOccupied(path, { pane: 'w1:p4', pid: process.pid, token: 'nuevo', title: 'x' })
    releasePane(path, 'viejo')
    assert.equal(readOccupancy(path)?.pid, process.pid)
  })

  test('el nombre del registro es valido en Windows', () => {
    assert.ok(occupancyPath('/s', 'w1:p3').endsWith(join('herdr-panes', 'w1_p3.json')))
  })
})

// --- Pertenencia ---

describe('pane propio', () => {
  const info = (shell: number | null): FakeHerdr =>
    new FakeHerdr({ respond: (args) => (args[1] === 'process-info' ? (shell === null ? fail() : ok(processInfoJson(shell, shell))) : undefined) })

  test('sube por la cadena de padres hasta el shell del pane', () => {
    const parents = new Map([[10, 20], [20, 30]])
    assert.equal(descendsFromPaneShell(info(30).run, 'w1:p0', 10, (pid) => parents.get(pid) ?? null), true)
    assert.equal(descendsFromPaneShell(info(10).run, 'w1:p0', 10, () => null), true)
  })

  test('falla cerrado si la cadena se corta, si herdr no responde o tras 64 niveles', () => {
    assert.equal(descendsFromPaneShell(info(99).run, 'w1:p0', 10, () => null), false)
    assert.equal(descendsFromPaneShell(info(null).run, 'w1:p0', 10, () => 1), false)
    let calls = 0
    const endless = (pid: number): number => {
      calls++
      return pid + 1
    }
    assert.equal(descendsFromPaneShell(info(5).run, 'w1:p0', 10, endless), false)
    assert.equal(calls, 64)
    assert.equal(descendsFromPaneShell(info(1).run, 'w1:p0', 2, () => 1), false)
  })

  test('POSIX consulta ps -o ppid= -p <pid>', () => {
    const seen: string[] = []
    const parentOf = posixParentOf((command, args) => {
      seen.push([command, ...args].join(' '))
      return ok('  321\n')
    })
    assert.equal(parentOf(42), 321)
    assert.deepEqual(seen, ['ps -o ppid= -p 42'])
    assert.equal(posixParentOf(() => fail())(42), null)
  })

  test('Windows lee Win32_Process una vez con PowerShell, sin shell intermedio', () => {
    const seen: string[][] = []
    const parentOf = windowsParentOf((command, args) => {
      seen.push([command, ...args])
      return ok('10 20\r\n20 30\r\n\r\n')
    })
    assert.equal(parentOf(10), 20)
    assert.equal(parentOf(20), 30)
    assert.equal(parentOf(30), null)
    assert.equal(seen.length, 1)
    const [command, ...args] = seen[0] as string[]
    assert.equal(command, 'powershell')
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    assert.match(Buffer.from(args[3] as string, 'base64').toString('utf16le'), /^Get-CimInstance Win32_Process /)
    assert.equal(windowsParentOf(() => fail())(10), null)
  })
})

// --- Pool, marcadores y archivo de despacho ---

describe('pool de panes', () => {
  test('poda estricta (publicado) y laxa (interno)', () => {
    const file = join(work, 'pool', 'herdr-report-panes.txt')
    const rows = 'w1:p1\tx claude\nw1:p2 Raro!\nw1:p3 claude\nsin-salto claude'
    mkdirSync(dirname(file), { recursive: true })
    const logs: string[] = []
    const fake = new FakeHerdr()
    writeFileSync(file, rows)
    const strict = prunePanes({ file, workspace: 'w1', runtime: 'claude', strictRows: true }, fake.run, () => true, (m) => logs.push(m))
    assert.deepEqual(strict, { chosen: 'w1:p3', closed: 0 })
    assert.equal(readFileSync(file, 'utf8'), 'w1:p3 claude\n')
    writeFileSync(file, rows)
    const lenient = prunePanes({ file, workspace: 'w1', runtime: 'claude', strictRows: false }, fake.run, () => true, () => {})
    assert.deepEqual(lenient, { chosen: 'w1:p1\tx', closed: 1 })
    assert.equal(readFileSync(file, 'utf8'), 'w1:p1\tx claude\nw1:p2 Raro!\n')
  })

  test('crea el pool si no existe', () => {
    const file = join(work, 'pool-nuevo', 'herdr-report-panes.txt')
    assert.deepEqual(prunePanes({ file, workspace: 'w1', runtime: 'claude', strictRows: true }, new FakeHerdr().run, () => true, () => {}), {
      chosen: '',
      closed: 0,
    })
    assert.equal(readFileSync(file, 'utf8'), '')
  })
})

describe('marcadores de despacho', () => {
  test('espera hasta el plazo sin depender del reloj', async () => {
    const marker = join(work, 'marcadores', 'a.started')
    mkdirSync(dirname(marker), { recursive: true })
    const clock = new FakeClock()
    assert.equal(await waitForDispatchMarker(marker, 3, clock.sleep), false)
    let sleeps = 0
    const appears = async (): Promise<void> => {
      if (++sleeps === 2) writeFileSync(marker, '')
    }
    assert.equal(await waitForDispatchMarker(marker, 5, appears), true)
    assert.equal(sleeps, 2)
  })

  test('reclamar es exclusivo', () => {
    const marker = join(work, 'marcadores', 'b.started')
    assert.equal(claimDispatchMarker(marker), true)
    assert.equal(readFileSync(marker, 'utf8'), 'abandonado\n')
    assert.equal(claimDispatchMarker(marker), false)
  })

  test('el archivo de despacho conserva sus campos y rechaza uno mal formado', () => {
    const path = dispatchSpecPath(join(work, 'despacho'), '1-2-3')
    const spec: DispatchSpec = {
      title: 't',
      issues: '1,2',
      delay: 30,
      startedMarker: '/m',
      pane: 'w1:p1',
      token: '1-2-3',
      cwd: '/repo',
      env: { MEFISTO_RUNTIME: 'claude' },
      command: ['/x/tooling-pipeline.mts', '1', '--models', 'a=b c'],
    }
    writeDispatchSpec(path, spec)
    assert.deepEqual(readDispatchSpec(path), spec)
    writeFileSync(path, JSON.stringify({ ...spec, command: [] }))
    assert.equal(readDispatchSpec(path), null)
    writeFileSync(path, JSON.stringify({ ...spec, env: { A: 1 } }))
    assert.equal(readDispatchSpec(path), null)
    assert.equal(readDispatchSpec(join(work, 'no-existe.json')), null)
  })
})

describe('utilidades del runner', () => {
  test('runnableCommand corre con Node los .mts y la gemela de un .sh', () => {
    const dir = join(work, 'gemelas')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'con-gemela.mts'), '')
    assert.deepEqual(runnableCommand([join(dir, 'x.mts'), '1'], 'node'), ['node', join(dir, 'x.mts'), '1'])
    assert.deepEqual(runnableCommand([join(dir, 'con-gemela.sh'), '1'], 'node'), ['node', join(dir, 'con-gemela.mts'), '1'])
    assert.deepEqual(runnableCommand([join(dir, 'sin-gemela.sh')], 'node'), ['bash', join(dir, 'sin-gemela.sh')])
    assert.deepEqual(runnableCommand(['touch', 'x'], 'node'), ['touch', 'x'])
  })

  test('tailLines se comporta como tail -n', () => {
    assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc\n')
    assert.equal(tailLines('a\nb\nc', 2), 'b\nc')
    assert.equal(tailLines('a\n', 5), 'a\n')
  })
})

// --- Runner ---

interface RunnerHarness {
  out: () => string
  err: () => string
  renames: string[]
  exits: number[]
  signals: EventEmitter
  children: ChildProcess[]
  run: Promise<number>
}

const PUBLISHED: PaneRunnerFlavor = {
  allowDelay: true,
  reportPrefix: 'herdr-run',
  followReport: false,
  viewer: () => ['-e', "console.log('visor-arrancado'); setTimeout(() => {}, 30000)"],
}

const INTERNAL: PaneRunnerFlavor = { ...PUBLISHED, allowDelay: false, reportPrefix: 'mefisto-herdr-run', followReport: true }

function startRunner(argv: string[], flavor: PaneRunnerFlavor, overrides: Partial<PaneRunnerDeps> = {}): RunnerHarness {
  let out = ''
  let err = ''
  const renames: string[] = []
  const exits: number[] = []
  const signals = new EventEmitter()
  const children: ChildProcess[] = []
  const launch: LaunchChild = (command, args, options) => {
    // La salida heredada del visor se captura para leerla como la veria el pane.
    const stdio: StdioOptions = Array.isArray(options.stdio)
      ? options.stdio.map((entry) => (entry === 'inherit' ? 'pipe' : entry))
      : options.stdio
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio })
    child.stdout?.on('data', (chunk: Buffer) => void (out += chunk.toString()))
    children.push(child)
    spawned.push(child)
    return child
  }
  const fake = new FakeHerdr({
    respond: (args) => {
      if (args[0] === 'pane' && args[1] === 'rename') renames.push(args[3] ?? '')
      return undefined
    },
  })
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HERDR_PANE_ID: 'w1:p5', HERDR_ENV: '1', HERDR_OTRA: 'x' }
  const deps: PaneRunnerDeps = {
    argv,
    cwd: work,
    env,
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    run: fake.run,
    now: () => new Date(),
    sleep: async () => {},
    pid: process.pid,
    execPath: process.execPath,
    caffeinate: [],
    launch,
    signals: signals as unknown as SignalSource,
    exit: (code) => void exits.push(code),
    ...overrides,
  }
  return { out: () => out, err: () => err, renames, exits, signals, children, run: runPaneRunner(deps, flavor) }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.fail(`no ocurrio: ${what}`)
}

function childScript(body: string): string[] {
  return [process.execPath, '-e', body]
}

describe('runner del pane', () => {
  test('con un archivo de despacho: confirma, ocupa el pane mientras corre y lo libera al terminar', async () => {
    const state = join(work, '.mefisto', 'pipeline')
    const token = '1-2-1'
    const marker = join(state, `herdr-dispatch-${token}.started`)
    const occupancy = occupancyPath(state, 'w1:p7')
    const spec = dispatchSpecPath(state, token)
    const probe = join(work, 'sonda.json')
    writeDispatchSpec(spec, {
      title: 'tooling #42',
      issues: '42',
      delay: 0,
      startedMarker: marker,
      pane: 'w1:p7',
      token,
      cwd: work,
      env: { MEFISTO_RUNTIME: 'fake' },
      command: childScript(
        `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ ocupacion: JSON.parse(fs.readFileSync(${JSON.stringify(occupancy)}, 'utf8')), runtime: process.env.MEFISTO_RUNTIME, herdr: Object.keys(process.env).filter((k) => k.startsWith('HERDR_')) })); console.log('reporte-del-pipeline'); process.exit(3)`,
      ),
    })
    const runner = startRunner(['--dispatch', spec], PUBLISHED)
    assert.equal(await runner.run, 3)
    assert.ok(existsSync(marker))
    assert.equal(existsSync(spec), false)
    const seen = JSON.parse(readFileSync(probe, 'utf8')) as { ocupacion: { pid: number; token: string }; runtime: string; herdr: string[] }
    assert.equal(seen.ocupacion.pid, process.pid)
    assert.equal(seen.ocupacion.token, token)
    assert.equal(seen.runtime, 'fake')
    assert.deepEqual(seen.herdr, [])
    assert.equal(readOccupancy(occupancy)?.pid, null)
    assert.deepEqual(runner.renames, ['tooling #42', '[fallo] tooling #42'])
    assert.ok(runner.out().includes('=== tooling #42: pipeline FALLO (exit 3) ==='))
    assert.ok(runner.out().includes('reporte-del-pipeline'))
    assert.ok(runner.out().includes('visor-arrancado'))
    await until(() => runner.children.every((child) => child.exitCode !== null || child.signalCode !== null), 'la muerte de los hijos')
  })

  test('libera el pane aunque el lanzamiento lance una excepcion', async () => {
    const state = join(work, '.mefisto', 'pipeline')
    const occupancy = occupancyPath(state, 'w1:p5')
    const runner = startRunner(['--title', 't', '--', 'x'], PUBLISHED, {
      launch: () => {
        throw new Error('sin procesos')
      },
    })
    await assert.rejects(runner.run, /sin procesos/)
    const record = readOccupancy(occupancy)
    assert.equal(record?.pid, null)
    assert.equal(record?.pane, 'w1:p5')
  })

  test('un reporte largo muestra solo las ultimas 40 lineas', async () => {
    const runner = startRunner(
      ['--title', 'largo', '--', ...childScript("for (let i = 1; i <= 70; i++) console.log('linea-' + i)")],
      PUBLISHED,
    )
    assert.equal(await runner.run, 0)
    const out = runner.out()
    assert.ok(out.includes('=== largo: pipeline terminado OK ==='))
    assert.ok(out.includes('(ultimas 40 lineas del reporte; completo en '))
    assert.ok(out.includes('linea-31\n'))
    assert.ok(!out.includes('linea-30\n'))
    assert.deepEqual(runner.renames.at(-1), '[ok] largo')
  })

  test('interno: sigue el reporte en vivo y al final solo nombra su ruta', async () => {
    const go = join(work, 'sigue')
    rmSync(go, { force: true })
    const runner = startRunner(
      [
        '--title',
        't',
        '--issues',
        '999999',
        '--',
        ...childScript(
          `const fs = require('fs'); console.log('linea-' + 'uno'); const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(wait); console.log('linea-' + 'dos'); process.exit(7) } }, 20)`,
        ),
      ],
      INTERNAL,
    )
    await until(() => runner.out().includes('linea-uno'), 'la primera linea en vivo')
    assert.ok(!runner.out().includes('linea-dos'))
    writeFileSync(go, '')
    assert.equal(await runner.run, 7)
    const out = runner.out()
    assert.equal(out.split('linea-uno').length - 1, 1)
    assert.equal(out.split('linea-dos').length - 1, 1)
    assert.ok(out.includes('pipeline FALLO (exit 7)'))
    assert.ok(out.includes('Reporte completo: '))
    assert.ok(out.includes('visor-arrancado'))
  })

  test('interno: --delay no es un argumento valido', async () => {
    const runner = startRunner(['--title', 't', '--delay', '3', '--', 'x'], INTERNAL)
    assert.equal(await runner.run, 1)
    assert.ok(runner.err().includes('Argumento no reconocido para --_pane-runner: --delay'))
  })

  test('una senal corta la corrida, renombra el pane [cortado] y lo libera', async () => {
    const state = join(work, '.mefisto', 'pipeline')
    const occupancy = occupancyPath(state, 'w1:p5')
    const runner = startRunner(['--title', 'larga', '--', ...childScript('setTimeout(() => {}, 30000)')], PUBLISHED)
    await until(() => readOccupancy(occupancy)?.pid === process.pid && runner.children.length === 2, 'el arranque del pipeline')
    runner.signals.emit('SIGINT', 'SIGINT')
    assert.equal(await runner.run, 130)
    assert.deepEqual(runner.exits, [130])
    assert.ok(runner.renames.includes('[cortado] larga'))
    assert.ok(runner.out().includes('Corrida interrumpida. Reporte parcial: '))
    assert.equal(readOccupancy(occupancy)?.pid, null)
    await until(() => runner.children.every((child) => child.exitCode !== null || child.signalCode !== null), 'la muerte de los hijos')
  })

  test('antepone el prefijo de caffeinate al pipeline, no al visor', async () => {
    const launched: string[][] = []
    const runner = startRunner(['--title', 'cafe', '--', ...childScript('process.exit(0)')], PUBLISHED, {
      caffeinate: ['caffeinate', '-i'],
      launch: (command, args, options) => {
        launched.push([command, ...args])
        const [real = '', ...rest] = command === 'caffeinate' ? args.slice(1) : [command, ...args]
        const child = spawn(real, rest, { cwd: options.cwd, env: options.env, stdio: 'ignore' })
        spawned.push(child)
        return child
      },
    })
    assert.equal(await runner.run, 0)
    assert.deepEqual(launched[0]?.slice(0, 3), ['caffeinate', '-i', process.execPath])
    assert.equal(launched[1]?.[0], process.execPath)
  })

  test('un comando que no existe termina con 127 y lo anota en el reporte', async () => {
    const runner = startRunner(['--title', 'roto', '--', join(work, 'no-existe-este-binario')], PUBLISHED)
    assert.equal(await runner.run, 127)
    assert.ok(runner.out().includes('pipeline FALLO (exit 127)'))
  })
})
