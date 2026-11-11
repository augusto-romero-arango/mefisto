import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../../../scripts/lib/cli.mts'
import type { JsonObject } from '../../../scripts/lib/jq-values.mts'
import { humanTelemetry, parseArgs, redactEvents } from '../mefisto-run-agent.mts'
import {
  CONTRACT_DIR,
  RUNNER,
  RUNTIME_DIR,
  RUN_EVENTS_FIXTURES,
  eventErrors,
  invalidEvents,
  readEvents,
  runRunner,
  runnerEnv,
  terminalsOf,
} from './runner-sandbox.mts'
import type { RunnerResult } from './runner-sandbox.mts'

const SENTINELS = /PROMPT_SENTINEL|ASSISTANT_SENTINEL|COMMAND_SENTINEL|STDERR_SENTINEL|HEADER_SENTINEL|AUTH_TOKEN_SENTINEL/
const TOKEN_FIELDS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning']

let work = ''
let workdir = ''
let prompt = ''
let system = ''
let serial = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto run agent '))
  workdir = join(work, 'wt')
  mkdirSync(workdir)
  prompt = join(work, 'prompt.txt')
  writeFileSync(prompt, 'prompt de prueba\n')
  system = join(work, 'system.txt')
  writeFileSync(system, 'system de prueba\n')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

interface FakeRun extends RunnerResult {
  eventLog: string
  events: JsonObject[]
}

const nextEventLog = (): string => join(work, `ev-${++serial}.jsonl`)

function baseArgs(eventLog: string): string[] {
  return ['--runtime', 'fake', '--agent', 'test-agent', '--cwd', workdir, '--prompt-file', prompt, '--event-log', eventLog]
}

/** Corre el runner real contra un guion del runtime falso. */
async function fake(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<FakeRun> {
  const eventLog = nextEventLog()
  const run = await runRunner([...baseArgs(eventLog), ...args], { MEFISTO_FAKE_SCRIPT: script, ...env })
  return { ...run, eventLog, events: existsSync(eventLog) ? readEvents(eventLog) : [] }
}

function terminalOf(run: FakeRun): JsonObject {
  const terminals = terminalsOf(run.events)
  assert.equal(terminals.length, 1, 'exactamente un evento terminal')
  return terminals[0] as JsonObject
}

function errorOf(event: JsonObject): JsonObject {
  return (event.error ?? {}) as JsonObject
}

/** Lo que todo desenlace debe cumplir: codigo, contrato, un solo terminal, status y kind. */
function assertOutcome(run: FakeRun, exit: number, status: string, kind: string | null): JsonObject {
  assert.equal(run.status, exit, run.stderr)
  assert.deepEqual(invalidEvents(run.events), [])
  assert.equal(run.events[0]?.type, 'run.started')
  const terminal = terminalOf(run)
  assert.equal(run.events.at(-1), terminal)
  assert.equal('estimated_cost_usd' in terminal, true)
  assert.equal('cost_usd' in terminal, false)
  assert.deepEqual(Object.keys(terminal.tokens as JsonObject), TOKEN_FIELDS)
  assert.equal(terminal.status, status)
  assert.equal(errorOf(terminal).kind ?? null, kind)
  return terminal
}

const shape = (events: JsonObject[]): unknown[] =>
  events.map((event) => [event.type, event.tool ?? '', event.text ?? '', event.status ?? ''])

/** Espera a que `seen` se cumpla sobre el --event-log mientras el runner sigue corriendo. */
async function watchLive(eventLog: string, running: Promise<unknown>, seen: (events: JsonObject[]) => boolean): Promise<boolean> {
  let done = false
  void running.then(() => {
    done = true
  })
  while (!done) {
    if (existsSync(eventLog)) {
      const lines = readFileSync(eventLog, 'utf8').split('\n').filter((line) => line.length > 0)
      try {
        if (seen(lines.map((line) => JSON.parse(line) as JsonObject))) return true
      } catch {
        // Una linea a medio escribir: se vuelve a mirar.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

describe('argumentos', () => {
  const args = (): string[] => baseArgs(join(work, 'ev-uso.jsonl'))
  const without = (flag: string): string[] => {
    const all = args()
    all.splice(all.indexOf(flag), 2)
    return all
  }
  const replaced = (flag: string, value: string): string[] => {
    const all = args()
    all[all.indexOf(flag) + 1] = value
    return all
  }
  const cases: [string, () => string[], RegExp][] = [
    ['sin --agent', () => without('--agent'), /^ERROR: --agent es obligatorio\n/],
    ['sin --cwd', () => without('--cwd'), /^ERROR: --cwd es obligatorio\n/],
    ['sin --prompt-file', () => without('--prompt-file'), /^ERROR: --prompt-file es obligatorio\n/],
    ['sin --event-log', () => without('--event-log'), /^ERROR: --event-log es obligatorio\n/],
    ['--cwd inexistente', () => replaced('--cwd', join(work, 'no-existe')), /^ERROR: --cwd '.*no-existe' no es un directorio existente\n/],
    ['--prompt-file inexistente', () => replaced('--prompt-file', join(work, 'no-existe.txt')), /^ERROR: --prompt-file '.*no-existe\.txt' no existe\n/],
    ['--system-file inexistente', () => [...args(), '--system-file', join(work, 'no-existe.txt')], /^ERROR: --system-file '.*no-existe\.txt' no existe\n/],
    ['--timeout no entero', () => [...args(), '--timeout', 'abc'], /^ERROR: --timeout 'abc' no es un entero\n/],
    ['--timeout 0', () => [...args(), '--timeout', '0'], /^ERROR: --timeout debe ser mayor que 0\n/],
    ['argumento desconocido', () => [...args(), '--bogus-flag', 'x'], /^ERROR: argumento desconocido: '--bogus-flag'\n/],
    ['--effort sin valor', () => [...args(), '--effort'], /^ERROR: --effort requiere un valor\n/],
    ['--model sin valor', () => [...args(), '--model'], /^ERROR: --model requiere un valor\n/],
  ]
  for (const [name, build, message] of cases) {
    test(`${name} sale con 64 y muestra el uso`, async () => {
      const run = await runRunner(build(), { MEFISTO_FAKE_SCRIPT: 'success' })
      assert.equal(run.status, 64)
      assert.equal(run.stdout, '')
      assert.match(run.stderr, message)
      assert.match(run.stderr, /\nUso: mefisto-run-agent\.sh --agent <id> --cwd <dir> --prompt-file <f> --event-log <jsonl>\n/)
    })
  }

  test('--help muestra el uso, con --redact-observability, y sale con 0', async () => {
    const run = await runRunner(['--help'])
    assert.equal(run.status, 0)
    assert.match(run.stderr, /^Uso: mefisto-run-agent\.sh /)
    assert.match(run.stderr, /--redact-observability/)
  })

  test('un --event-log que no se puede escribir es un error de uso', async () => {
    const run = await runRunner(baseArgs(join(prompt, 'dentro-de-un-archivo.jsonl')), { MEFISTO_FAKE_SCRIPT: 'success' })
    assert.equal(run.status, 64)
    assert.match(run.stderr, /ERROR: --event-log '.*' no es escribible/)
  })

  test('parseArgs lee cada flag con su valor, tambien vacio', () => {
    const options = parseArgs(['--agent', 'a', '--effort', '', '--redact-observability', '--timeout', '5'])
    assert.deepEqual([options.agent, options.effort, options.redact, options.timeout, options.help], ['a', '', true, '5', false])
    assert.equal(parseArgs(['--help', '--bogus']).help, true)
    assert.throws(() => parseArgs(['--bogus']), /argumento desconocido: '--bogus'/)
  })
})

describe('resolucion de runtime', () => {
  test('sin runtime disponible o con uno sin adaptador sale con 69', async () => {
    const none = await runRunner(baseArgs(nextEventLog()).slice(2), { PATH: work, MEFISTO_FAKE_AVAILABLE: '' })
    assert.equal(none.status, 69)
    assert.match(none.stderr, /^ERROR: no se detecto ningun runtime disponible entre los adaptadores \(claude, fake\): fija MEFISTO_RUNTIME o --runtime\n$/)
    const bogus = await runRunner(['--runtime', 'bogus', ...baseArgs(nextEventLog()).slice(2)])
    assert.equal(bogus.status, 69)
    assert.match(bogus.stderr, /^ERROR: runtime 'bogus' no tiene adaptador \(.*runtime-bogus\.mts\): fija MEFISTO_RUNTIME a un runtime soportado\n$/)
  })

  test('MEFISTO_RUNTIME y la autodeteccion eligen el adaptador cuando no hay --runtime', async () => {
    const args = baseArgs(nextEventLog()).slice(2)
    const byEnv = await runRunner(args, { MEFISTO_RUNTIME: 'fake', MEFISTO_FAKE_SCRIPT: 'success' })
    assert.equal(byEnv.status, 0, byEnv.stderr)
    const detected = await runRunner(args, { PATH: work, MEFISTO_FAKE_AVAILABLE: '1', MEFISTO_FAKE_SCRIPT: 'success' })
    assert.equal(detected.status, 0, detected.stderr)
  })
})

describe('adaptadores con defectos', () => {
  function adapterDir(id: string, source: string): string {
    const dir = join(work, `libdir-${id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `runtime-${id}.mts`), source)
    return dir
  }
  const run = (id: string, dir: string): Promise<RunnerResult> =>
    runRunner(['--runtime', id, ...baseArgs(nextEventLog()).slice(2)], { MEFISTO_RUNTIME_LIB_DIR: dir })

  test('un stdinFile que no existe aborta con 69 sin lanzar el proceso', async () => {
    const marker = join(work, 'badstdin-ran')
    const argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]
    const bogus = join(work, 'does-not-exist', 'mefisto-stdin-1447')
    const dir = adapterDir(
      'badstdin',
      `export function buildCmd() { return { argv: ${JSON.stringify(argv)}, stdinFile: ${JSON.stringify(bogus)} } }
export function translate() { return [] }
`,
    )
    const result = await run('badstdin', dir)
    assert.equal(result.status, 69)
    assert.equal(
      result.stderr,
      `ERROR: runtime_badstdin_build_cmd fijo MEFISTO_RUNTIME_STDIN_FILE='${bogus}', que no es un archivo regular legible\n`,
    )
    assert.equal(existsSync(marker), false)
  })

  test('un adaptador sin buildCmd, sin translate o que no genera comando sale con 69', async () => {
    const noBuild = await run('sinbuild', adapterDir('sinbuild', 'export function translate() { return [] }\n'))
    assert.equal(noBuild.status, 69)
    assert.match(noBuild.stderr, /^ERROR: .*runtime-sinbuild\.mts no define buildCmd\n$/)
    const noTranslate = await run('sintranslate', adapterDir('sintranslate', 'export function buildCmd() { return { argv: ["x"] } }\n'))
    assert.equal(noTranslate.status, 69)
    assert.match(noTranslate.stderr, /^ERROR: .*runtime-sintranslate\.mts no define translate\n$/)
    const empty = await run(
      'vacio',
      adapterDir('vacio', 'export function buildCmd() { return { argv: [] } }\nexport function translate() { return [] }\n'),
    )
    assert.equal(empty.status, 69)
    assert.equal(empty.stderr, 'ERROR: runtime_vacio_build_cmd no genero ningun comando (MEFISTO_RUNTIME_CMD vacio)\n')
  })

  test('un comando que no existe termina como protocolo invalido, sin colgarse', async () => {
    const eventLog = nextEventLog()
    const dir = adapterDir(
      'fantasma',
      'export function buildCmd() { return { argv: ["mefisto-no-existe-este-programa"] } }\nexport function translate() { return [] }\n',
    )
    const result = await runRunner(['--runtime', 'fantasma', ...baseArgs(eventLog).slice(2)], { MEFISTO_RUNTIME_LIB_DIR: dir })
    assert.equal(result.status, 65)
    assert.deepEqual(readEvents(eventLog).map((event) => event.type), ['run.started', 'run.failed'])
  })
})

describe('fixtures del contrato', () => {
  const fixture = (name: string): JsonObject[] => readEvents(join(RUN_EVENTS_FIXTURES, name))

  test('las corridas validas cumplen el schema linea a linea', () => {
    for (const name of readdirSync(RUN_EVENTS_FIXTURES).filter((file) => /^(valid-|legacy-)/.test(file))) {
      assert.deepEqual(invalidEvents(fixture(name)), [], name)
    }
  })

  test('el limite de uso trae resets_at cuando el runtime lo conoce y null cuando no', () => {
    const failed = (name: string): JsonObject => fixture(name).find((event) => event.type === 'run.failed') ?? {}
    assert.deepEqual(
      [errorOf(failed('valid-rate-limit-claude.jsonl')).kind, failed('valid-rate-limit-claude.jsonl').resets_at],
      ['rate_limit', '2026-05-07T22:40:00Z'],
    )
    assert.deepEqual(
      [errorOf(failed('valid-rate-limit-sin-reset.jsonl')).kind, failed('valid-rate-limit-sin-reset.jsonl').resets_at],
      ['rate_limit', null],
    )
  })

  test('dos terminales es una violacion entre lineas que el schema no ve', () => {
    const events = fixture('invalid-two-terminals.jsonl')
    assert.deepEqual(invalidEvents(events), [])
    assert.equal(terminalsOf(events).length, 2)
  })

  test('cada fixture invalido se rechaza en su segunda linea', () => {
    for (const name of ['invalid-missing-field.jsonl', 'invalid-unknown-type.jsonl', 'invalid-status-mismatch.jsonl', 'invalid-missing-cost-name.jsonl']) {
      assert.notDeepEqual(eventErrors(fixture(name)[1] ?? {}), [], name)
    }
    assert.deepEqual(eventErrors(fixture('valid-failed.jsonl')[2] ?? {}), [])
  })

  test('el nombre del costo: cost_usd solo en el fixture legado, y alguno de los dos siempre', () => {
    const legacy = fixture('legacy-cost-usd.jsonl')[1] ?? {}
    assert.deepEqual(eventErrors(legacy), [])
    assert.equal('cost_usd' in legacy && !('estimated_cost_usd' in legacy), true)
    const failed = {
      ...(fixture('invalid-missing-cost-name.jsonl')[1] ?? {}),
      type: 'run.failed',
      status: 'failed',
      error: { kind: 'nonzero_exit', detail: 'fallo' },
    }
    assert.deepEqual(eventErrors(failed), ['terminal sin estimated_cost_usd ni cost_usd'])
    for (const name of readdirSync(RUN_EVENTS_FIXTURES).filter((file) => file !== 'legacy-cost-usd.jsonl')) {
      assert.doesNotMatch(readFileSync(join(RUN_EVENTS_FIXTURES, name), 'utf8'), /"cost_usd"/, name)
    }
  })
})

describe('guiones del runtime falso', { concurrency: true }, () => {
  test('success', async () => {
    const run = await fake('success')
    assertOutcome(run, 0, 'success', null)
    assert.deepEqual(shape(run.events), [
      ['run.started', '', '', ''],
      ['message', '', 'hola desde el guion fake', ''],
      ['tool.started', 'demo', '', ''],
      ['tool.completed', 'demo', '', ''],
      ['run.completed', '', '', 'success'],
    ])
    assert.deepEqual(Object.keys(run.events[0] ?? {}), ['v', 'type', 'ts', 'runtime', 'agent', 'model', 'effort', 'cwd'])
    assert.deepEqual(
      [run.events[0]?.runtime, run.events[0]?.agent, run.events[0]?.cwd],
      ['fake', 'test-agent', workdir],
    )
    assert.match(String(run.events[0]?.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    assert.equal(run.stderr, '')
    assert.equal(run.stdout, '')
  })

  test('fail conserva el exit del adaptador', async () => {
    assertOutcome(await fake('fail', [], { MEFISTO_FAKE_EXIT_CODE: '7' }), 7, 'failed', 'nonzero_exit')
    assertOutcome(await fake('fail'), 3, 'failed', 'nonzero_exit')
  })

  test('hang cae en timeout: exit 124, duracion real y los eventos previos intactos', async () => {
    // Con 1 s, en una maquina cargada el CLI falso moria antes de emitir su mensaje.
    const run = await fake('hang', ['--timeout', '4'])
    const terminal = assertOutcome(run, 124, 'timeout', 'timeout')
    assert.equal(Number(terminal.duration_ms) >= 4000, true)
    assert.equal(errorOf(terminal).detail, 'el watchdog mato el proceso tras superar 4s')
    assert.equal(run.events.some((event) => event.type === 'message'), true)
  })

  test('cero o dos terminales del adaptador se normalizan a un protocol_invalid', async () => {
    const none = assertOutcome(await fake('no-terminal'), 65, 'protocol_invalid', 'protocol_invalid')
    assert.equal(errorOf(none).detail, "el adaptador 'fake' emitio 0 eventos terminales (se esperaba exactamente 1)")
    const two = assertOutcome(await fake('two-terminals'), 65, 'protocol_invalid', 'protocol_invalid')
    assert.equal(errorOf(two).detail, "el adaptador 'fake' emitio 2 eventos terminales (se esperaba exactamente 1)")
  })

  test('malformed conserva el mensaje anterior a la linea cortada', async () => {
    const run = await fake('malformed')
    assertOutcome(run, 65, 'protocol_invalid', 'protocol_invalid')
    assert.deepEqual(run.events.filter((event) => event.type === 'message').map((event) => event.text), ['antes del corte'])
  })

  test('un guion desconocido es un fallo del CLI falso', async () => {
    const stderrLog = join(work, 'desconocido.stderr')
    const run = await fake('no-existe', ['--stderr-log', stderrLog])
    assertOutcome(run, 65, 'protocol_invalid', 'protocol_invalid')
    assert.equal(readFileSync(stderrLog, 'utf8'), "runtime-fake.sh: MEFISTO_FAKE_SCRIPT desconocido: 'no-existe'\n")
  })

  test('self-stop: el watchdog reanuda al proceso detenido y la corrida termina bien', { skip: process.platform === 'win32' ? 'Windows no tiene SIGSTOP' : false }, async () => {
    const run = await fake('self-stop', ['--timeout', '30'], { MEFISTO_WATCHDOG_POLL_S: '1' })
    assertOutcome(run, 0, 'success', null)
  })

  test('touch-tty: sin terminal de control el guion no se detiene', async () => {
    assertOutcome(await fake('touch-tty', ['--timeout', '30']), 0, 'success', null)
  })
})

describe('opciones que viajan al adaptador', { concurrency: true }, () => {
  async function withArgs(args: string[]): Promise<FakeRun & { argv: string[] }> {
    const argsFile = join(work, `args-${++serial}.txt`)
    const run = await fake('success', args, { MEFISTO_FAKE_ARGS_FILE: argsFile })
    return { ...run, argv: readFileSync(argsFile, 'utf8').split('\n').slice(0, -1) }
  }
  const after = (argv: string[], flag: string): string | undefined =>
    argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined

  test('--model llega a run.started, al CLI y al terminal; omitido es null en todos', async () => {
    const given = await withArgs(['--model', 'demo-model-xyz'])
    assert.deepEqual([given.events[0]?.model, terminalOf(given).model, after(given.argv, '--fake-model')], ['demo-model-xyz', 'demo-model-xyz', 'demo-model-xyz'])
    const omitted = await withArgs([])
    assert.deepEqual([omitted.events[0]?.model, terminalOf(omitted).model, omitted.argv.includes('--fake-model')], [null, null, false])
    assert.deepEqual(omitted.argv, ['__mefisto-fake-emit', 'test-agent', prompt, ''])
  })

  test('--resume-session se reenvia tal cual y omitido no agrega nada', async () => {
    const given = await withArgs(['--resume-session', 'sess-resume-1'])
    assert.equal(given.status, 0)
    assert.equal(after(given.argv, '--fake-resume'), 'sess-resume-1')
  })

  test('--effort llega al adaptador y a run.started; vacio u omitido es heredar', async () => {
    const raw = join(work, 'effort.raw')
    const given = await withArgs(['--effort', 'high', '--raw-log', raw])
    assert.equal(given.status, 0)
    assert.equal(after(given.argv, '--fake-effort'), 'high')
    assert.equal(given.events[0]?.effort, 'high')
    assert.match(readFileSync(raw, 'utf8'), /"fake":"terminal","status":"success","model":null,"effort":"high"/)
    for (const args of [[], ['--effort', '']]) {
      const inherited = await withArgs(args)
      assert.deepEqual([inherited.status, inherited.argv.includes('--fake-effort'), inherited.events[0]?.effort], [0, false, null])
    }
  })

  test('system file, modelo opaco y sesion llegan juntos; raw y stderr se conservan; no se inventa estado', async () => {
    const state = join(work, 'state')
    mkdirSync(state, { recursive: true })
    const raw = join(work, 'todo', 'raw.log')
    const stderrLog = join(work, 'todo', 'stderr.log')
    const argsFile = join(work, 'todo.args')
    const run = await fake(
      'success',
      ['--system-file', system, '--resume-session', 'session-x', '--model', 'provider/model', '--raw-log', raw, '--stderr-log', stderrLog],
      { MEFISTO_STATE_DIR: state, MEFISTO_FAKE_ARGS_FILE: argsFile },
    )
    assert.equal(run.status, 0, run.stderr)
    assert.equal(statSync(raw).isFile() && statSync(stderrLog).isFile(), true)
    assert.deepEqual(readdirSync(state), [])
    assert.deepEqual(readFileSync(argsFile, 'utf8').split('\n').slice(0, -1), [
      '__mefisto-fake-emit', 'test-agent', prompt, system, '--fake-model', 'provider/model', '--fake-resume', 'session-x',
    ])
    assert.equal(terminalOf(run).model, 'provider/model')
  })

  test('el proceso recibe por la entrada estandar el system file y el prompt del fake', async () => {
    const dump = join(work, 'fake-stdin.dump')
    const run = await fake('dump-stdin', ['--system-file', system], { MEFISTO_FAKE_STDIN_DUMP_FILE: dump })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(readFileSync(dump, 'utf8'), 'system de prueba\n\n\nprompt de prueba\n')
    assert.equal(readFileSync(`${dump}.tty`, 'utf8'), '0\n')
  })
})

describe('persistencia redactada', { concurrency: true }, () => {
  test('en un exito omite mensajes e inputs y conserva runtime, modelo y terminal', async () => {
    const run = await fake('sensitive-success', ['--redact-observability', '--model', 'runtime-model-allowed'])
    const terminal = assertOutcome(run, 0, 'success', null)
    assert.doesNotMatch(readFileSync(run.eventLog, 'utf8'), SENTINELS)
    assert.deepEqual(run.events.map((event) => event.type), ['run.started', 'tool.started', 'tool.completed', 'run.completed'])
    assert.equal(run.events[1]?.input_summary, null)
    assert.deepEqual([terminal.runtime, terminal.model], ['fake', 'runtime-model-allowed'])
  })

  test('sin el flag la persistencia no cambia', async () => {
    const run = await fake('sensitive-success', ['--model', 'runtime-model-allowed'])
    assertOutcome(run, 0, 'success', null)
    assert.match(readFileSync(run.eventLog, 'utf8'), SENTINELS)
    assert.equal(run.events.some((event) => event.type === 'message'), true)
    assert.equal(run.events.find((event) => event.type === 'tool.started')?.input_summary, 'COMMAND_SENTINEL input')
  })

  test('en un fallo conserva type, status, kind y exit, y sustituye el detalle', async () => {
    const redacted = await fake('sensitive-fail', ['--redact-observability'], { MEFISTO_FAKE_EXIT_CODE: '7' })
    const terminal = assertOutcome(redacted, 7, 'failed', 'api_error')
    assert.doesNotMatch(readFileSync(redacted.eventLog, 'utf8'), SENTINELS)
    assert.equal(errorOf(terminal).detail, 'detalle redactado: api_error')
    const plain = await fake('sensitive-fail', [], { MEFISTO_FAKE_EXIT_CODE: '7' })
    const baseline = assertOutcome(plain, 7, 'failed', 'api_error')
    assert.equal(errorOf(baseline).detail, 'STDERR_SENTINEL AUTH_TOKEN_SENTINEL')
    assert.deepEqual([terminal.type, terminal.status], [baseline.type, baseline.status])
  })

  for (const [script, exit, status] of [['hang', 124, 'timeout'], ['no-terminal', 65, 'protocol_invalid'], ['malformed', 65, 'protocol_invalid']] as const) {
    test(`${script} redactado sigue siendo ${status}`, async () => {
      const run = await fake(script, ['--redact-observability', ...(script === 'hang' ? ['--timeout', '1'] : [])])
      const terminal = assertOutcome(run, exit, status, status)
      assert.equal(run.events.some((event) => event.type === 'message'), false)
      assert.equal(errorOf(terminal).detail, `detalle redactado: ${status}`)
    })
  }

  test('el anexo en vivo usa el mismo filtro', async () => {
    const eventLog = nextEventLog()
    const running = runRunner([...baseArgs(eventLog), '--redact-observability'], {
      MEFISTO_FAKE_SCRIPT: 'slow-success',
      MEFISTO_FAKE_STEP_DELAY_S: '2',
      MEFISTO_RUN_AGENT_LIVE_INTERVAL: '1',
    })
    const seen = await watchLive(
      eventLog,
      running,
      (events) =>
        events.some((event) => event.type === 'tool.started' && event.input_summary === null) &&
        !events.some((event) => event.type === 'message') &&
        terminalsOf(events).length === 0,
    )
    assert.equal(seen, true)
    const run = await running
    assertOutcome({ ...run, eventLog, events: readEvents(eventLog) }, 0, 'success', null)
    assert.equal(readEvents(eventLog).some((event) => event.type === 'message'), false)
  })

  test('--raw-log y --stderr-log quedan intactos y el runner lo avisa con sus rutas', async () => {
    const raw = join(work, 'j-raw.log')
    const stderrLog = join(work, 'j-stderr.log')
    const run = await fake('sensitive-fail', ['--redact-observability', '--raw-log', raw, '--stderr-log', stderrLog])
    assert.equal(
      run.stderr,
      `AVISO: --redact-observability no redacta los destinos solicitados explicitamente (--raw-log: '${raw}', --stderr-log: '${stderrLog}'); no son observabilidad segura\n`,
    )
    assert.match(readFileSync(raw, 'utf8'), /AUTH_TOKEN_SENTINEL/)
    assert.match(readFileSync(stderrLog, 'utf8'), /AUTH_TOKEN_SENTINEL/)
    const onlyRaw = await fake('success', ['--redact-observability', '--raw-log', raw])
    assert.match(onlyRaw.stderr, /--stderr-log: '<no solicitado>'\)/)
  })

  test('--events-log sale de la misma proyeccion redactada', async () => {
    const human = join(work, 'j-events.log')
    const run = await fake('sensitive-success', ['--redact-observability', '--events-log', human])
    assert.equal(run.status, 0)
    const text = readFileSync(human, 'utf8')
    assert.doesNotMatch(text, SENTINELS)
    assert.match(text, /\[tool\] test-agent Bash ok -\n/)
  })

  test('los temporales de la corrida se borran al salir', async () => {
    const privateTmp = join(work, 'tmp privado')
    mkdirSync(privateTmp)
    const run = await fake('sensitive-success', ['--redact-observability'], { TMPDIR: privateTmp, TEMP: privateTmp, TMP: privateTmp })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(readdirSync(privateTmp), [])
    const failed = await fake('hang', ['--timeout', '1'], { TMPDIR: privateTmp, TEMP: privateTmp, TMP: privateTmp })
    assert.equal(failed.status, 124)
    assert.deepEqual(readdirSync(privateTmp), [])
  })

  test('redactEvents: sin flag no toca nada; con el, proyecta cada tipo', () => {
    const events: JsonObject[] = [
      { type: 'message', text: 'secreto' },
      { type: 'tool.started', tool: 'Bash', input_summary: 'secreto' },
      { type: 'tool.completed', tool: 'Bash', ok: true },
      { type: 'run.failed', error: { kind: 'api_error', detail: 'secreto' }, resets_at: null },
      { type: 'run.completed', error: null },
    ]
    assert.equal(redactEvents(events, false), events)
    assert.deepEqual(redactEvents(events, true), [
      { type: 'tool.started', tool: 'Bash', input_summary: null },
      { type: 'tool.completed', tool: 'Bash', ok: true },
      { type: 'run.failed', error: { kind: 'api_error', detail: 'detalle redactado: api_error' }, resets_at: null },
      { type: 'run.completed', error: null },
    ])
  })
})

describe('anexo en vivo', { concurrency: true }, () => {
  test('los no terminales aparecen antes de que el runner termine y nada se duplica al cierre', async () => {
    const eventLog = nextEventLog()
    const running = runRunner([...baseArgs(eventLog), '--timeout', '60'], {
      MEFISTO_FAKE_SCRIPT: 'slow-success',
      MEFISTO_FAKE_STEP_DELAY_S: '2',
      MEFISTO_RUN_AGENT_LIVE_INTERVAL: '1',
    })
    const seen = await watchLive(
      eventLog,
      running,
      (events) =>
        events.some((event) => event.type === 'message') &&
        events.some((event) => event.type === 'tool.started') &&
        terminalsOf(events).length === 0,
    )
    assert.equal(seen, true, 'message y tool.started ya estaban en --event-log sin terminal')
    const run = await running
    const slow: FakeRun = { ...run, eventLog, events: readEvents(eventLog) }
    assertOutcome(slow, 0, 'success', null)
    assert.equal(slow.events.filter((event) => event.type === 'tool.started').length, 1)
    assert.equal(slow.events.filter((event) => event.type === 'tool.completed').length, 1)

    const baseline = await fake('success')
    assert.deepEqual(shape(slow.events), shape(baseline.events))
  })

  for (const bad of ['abc', '0', '00', '-1']) {
    test(`MEFISTO_RUN_AGENT_LIVE_INTERVAL='${bad}' avisa, cae al default y no cambia el desenlace`, async () => {
      const run = await fake('success', [], { MEFISTO_RUN_AGENT_LIVE_INTERVAL: bad })
      assertOutcome(run, 0, 'success', null)
      assert.equal(
        run.stderr,
        `AVISO: MEFISTO_RUN_AGENT_LIVE_INTERVAL='${bad}' invalido (debe ser un entero > 0); usando el default (2s)\n`,
      )
    })
  }
})

describe('corte tras exito declarado', { concurrency: true }, () => {
  interface PostResult extends FakeRun {
    human: string
    elapsedMs: number
  }
  async function postResult(script: string, grace: string | undefined, timeout: string): Promise<PostResult> {
    const human = join(work, `m-${++serial}.events`)
    const started = Date.now()
    const run = await fake(script, ['--events-log', human, '--timeout', timeout], {
      MEFISTO_RUN_AGENT_LIVE_INTERVAL: '1',
      MEFISTO_WATCHDOG_POLL_S: '1',
      ...(grace === undefined ? {} : { MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S: grace }),
    })
    return { ...run, human: existsSync(human) ? readFileSync(human, 'utf8') : '', elapsedMs: Date.now() - started }
  }

  test('pasada la gracia corta al proceso antes del timeout y cierra con el terminal de exito', async () => {
    const run = await postResult('success-then-hang', '1', '40')
    assertOutcome(run, 0, 'success', null)
    assert.equal(run.elapsedMs < 30000, true, `tardo ${run.elapsedMs} ms`)
    assert.match(run.human, /^\[\d\d:\d\d:\d\d\] POST-RESULT: test-agent seguia vivo \d+s despues de declarar exito -- SIGTERM$/m)
    assert.doesNotMatch(run.human, /TIMEOUT tras exito/)
    assert.match(run.human, /\[stage\] test-agent success\n$/)
  })

  test('con la gracia mayor que el timeout gana el timeout, pero se respeta el exito', async () => {
    const run = await postResult('success-then-hang', '60', '3')
    assertOutcome(run, 0, 'success', null)
    assert.match(run.human, /^\[\d\d:\d\d:\d\d\] TIMEOUT tras exito declarado: test-agent$/m)
    assert.doesNotMatch(run.human, /POST-RESULT:/)
  })

  test('sin exito declarado el timeout sigue siendo timeout', async () => {
    const run = await postResult('hang', '1', '3')
    assertOutcome(run, 124, 'timeout', 'timeout')
    assert.doesNotMatch(run.human, /POST-RESULT:|TIMEOUT tras exito/)
  })

  test('un exito que sale solo no recibe senal ni linea POST-RESULT', async () => {
    const run = await postResult('success', '1', '30')
    assertOutcome(run, 0, 'success', null)
    assert.doesNotMatch(run.human, /POST-RESULT:|TIMEOUT tras exito/)
  })

  for (const grace of ['', '0', 'abc']) {
    test(`una gracia '${grace}' cae al default de 120 s`, async () => {
      const run = await postResult('success-then-hang', grace, '3')
      assertOutcome(run, 0, 'success', null)
      assert.match(run.human, /TIMEOUT tras exito declarado/)
      assert.doesNotMatch(run.human, /POST-RESULT:/)
      assert.equal(
        run.stderr,
        grace === ''
          ? ''
          : `AVISO: MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S='${grace}' invalido (debe ser un entero >= 1); usando el default (120s)\n`,
      )
    })
  }

  test('el runner y el contrato documentan la gracia y el corte', () => {
    for (const file of [RUNNER, join(CONTRACT_DIR, 'README.md')]) {
      const text = readFileSync(file, 'utf8')
      assert.match(text, /MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S/, file)
      assert.match(text, /POST-RESULT/, file)
    }
  })
})

describe('entorno del runner', () => {
  test('encuentra sus librerias por su ubicacion, no por el cwd de quien lo llama', async () => {
    const eventLog = nextEventLog()
    const run = await runRunner(baseArgs(eventLog), { MEFISTO_FAKE_SCRIPT: 'success', MEFISTO_RUNTIME_LIB_DIR: '' }, work)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(readEvents(eventLog).length > 1, true)
  })

  test('el shim de bash delega en el runner con los mismos argumentos', { skip: process.platform === 'win32' ? 'el shim es bash' : false }, () => {
    const shim = join(RUNTIME_DIR, 'mefisto-run-agent.sh')
    assert.equal(
      readFileSync(shim, 'utf8'),
      [
        '#!/usr/bin/env bash',
        '# Shim: la implementacion vive en mefisto-run-agent.mts (MEF-ADR-0057). No editar.',
        'exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/mefisto-run-agent.mts" "$@"',
        '',
      ].join('\n'),
    )
    assert.equal((statSync(shim).mode & 0o111) !== 0, true)
    const help = capture(shim, ['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stderr, /^Uso: mefisto-run-agent\.sh /)
    assert.equal(capture(shim, ['--bogus']).status, 64)
  })
})

describe('humanTelemetry', () => {
  const terminal = { ts: '2026-07-27T22:09:36.000Z', status: 'success' }

  test('empareja cada tool.completed con el tool.started pendiente mas antiguo de su tool', () => {
    const lines = humanTelemetry(
      [
        { type: 'tool.started', ts: '2026-07-27T22:09:34Z', tool: 'Read', input_summary: 'a.ts' },
        { type: 'tool.started', ts: '2026-07-27T22:09:34Z', tool: 'Read', input_summary: 'b.ts' },
        { type: 'message', ts: '2026-07-27T22:09:34Z', text: 'x' },
        { type: 'tool.completed', ts: '2026-07-27T22:09:35Z', tool: 'Read', ok: true },
        { type: 'tool.completed', ts: '2026-07-27T22:09:35Z', tool: 'Read', ok: false },
        { type: 'tool.completed', ts: '2026-07-27T22:09:35Z', tool: 'Read', ok: true },
      ],
      'writer',
      terminal,
    ).map((line) => line.replace(/^\[\d\d:\d\d:\d\d\]/, ''))
    assert.deepEqual(lines, [
      '[archivo] a.ts',
      '[archivo] b.ts',
      '[tool] writer Read ok a.ts',
      '[tool] writer Read fail b.ts',
      '[tool] writer Read ok -',
      '[stage] writer success',
    ])
  })

  test('solo un tool de archivo produce [archivo], con cualquier capitalizacion', () => {
    const started = (tool: string): JsonObject => ({ type: 'tool.started', ts: 'x', tool, input_summary: 'resumen' })
    const lines = humanTelemetry([started('edit'), started('WRITE'), started('Bash'), started('Grep')], 'a', terminal)
    assert.deepEqual(lines.slice(0, -1), ['[--:--:--][archivo] resumen', '[--:--:--][archivo] resumen'])
  })

  test('una hora que no es ISO 8601 en UTC se escribe como --:--:--', () => {
    for (const ts of [null, 7, 'ayer', '2026-07-27 22:09:36', '2026-13-40T99:99:99Z']) {
      assert.deepEqual(humanTelemetry([], 'a', { ts, status: 'failed' }), ['[--:--:--][stage] a failed'])
    }
  })

  test('un evento fuera del contrato hace fallar la telemetria entera', () => {
    assert.throws(() => humanTelemetry([{ type: 'tool.started', tool: null, input_summary: null }], 'a', terminal))
    assert.throws(() => humanTelemetry([{ type: 'tool.started', tool: 'Read', input_summary: 7 }], 'a', terminal))
  })
})

describe('senales al runner', () => {
  const skip = process.platform === 'win32' ? 'Windows no entrega SIGTERM a un proceso de Node' : false

  for (const [signal, exit] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
    test(`${signal} mata al agente, borra los temporales y sale con ${exit}`, { skip }, async () => {
      const dir = join(work, `libdir-senal-${signal}`)
      const privateTmp = join(work, `tmp-senal-${signal}`)
      const pidFile = join(work, `agente-${signal}.pid`)
      mkdirSync(dir)
      mkdirSync(privateTmp)
      const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 600000)`
      writeFileSync(
        join(dir, 'runtime-dormido.mts'),
        `export function buildCmd() { return { argv: ${JSON.stringify([process.execPath, '-e', script])} } }
export function translate() { return [] }
`,
      )
      const eventLog = nextEventLog()
      const runner = spawn(process.execPath, [RUNNER, '--runtime', 'dormido', ...baseArgs(eventLog).slice(2)], {
        env: runnerEnv({ MEFISTO_RUNTIME_LIB_DIR: dir, TMPDIR: privateTmp }),
        stdio: 'ignore',
      })
      const exited = new Promise<number | null>((resolve) => runner.once('exit', (code) => resolve(code)))
      while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const agent = Number(readFileSync(pidFile, 'utf8'))
      runner.kill(signal)
      assert.equal(await exited, exit)
      for (let tries = 0; tries < 50; tries++) {
        try {
          process.kill(agent, 0)
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.throws(() => process.kill(agent, 0), `el agente ${agent} sigue vivo`)
      assert.deepEqual(readdirSync(privateTmp), [])
      assert.deepEqual(readEvents(eventLog).map((event) => event.type), ['run.started'])
    })
  }
})
