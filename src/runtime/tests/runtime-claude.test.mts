import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { dump } from '../../../scripts/lib/jq-values.mts'
import type { JsonObject } from '../../../scripts/lib/jq-values.mts'
import {
  buildCmd,
  defaultEffort,
  defaultModel,
  interactiveRefresh,
  isAvailable,
  supportsResume,
  translate,
  translateStream,
} from '../lib/runtime-claude.mts'
import type { BuildCommandInput } from '../lib/mefisto-runtime.mts'
import {
  CLAUDE_FIXTURES,
  installClaudeStub,
  invalidEvents,
  readEvents,
  runRunner,
  terminalsOf,
} from './runner-sandbox.mts'

const SENTINELS = /PROMPT_SENTINEL|ASSISTANT_SENTINEL|COMMAND_SENTINEL|STDERR_SENTINEL|HEADER_SENTINEL|AUTH_TOKEN_SENTINEL/

let work = ''
let workdir = ''
let prompt = ''
let stubPath = ''
let serial = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto claude '))
  workdir = join(work, 'wt')
  mkdirSync(workdir)
  prompt = join(work, 'prompt.txt')
  writeFileSync(prompt, 'prompt\n')
  stubPath = installClaudeStub(join(work, 'bin stub'))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const fixture = (name: string): string => join(CLAUDE_FIXTURES, name)

function translated(name: string, model = '', exitCode: number | null = null, stderrText = ''): JsonObject[] {
  return translateStream(readFileSync(fixture(name), 'utf8'), 'claude', model, exitCode, stderrText)
}

function terminalOf(events: JsonObject[]): JsonObject {
  const terminals = terminalsOf(events)
  assert.equal(terminals.length, 1, 'exactamente un evento terminal')
  return terminals[0] as JsonObject
}

function errorOf(event: JsonObject): JsonObject {
  return (event.error ?? {}) as JsonObject
}

function command(overrides: Partial<BuildCommandInput> = {}) {
  return buildCmd({
    agent: 'writer',
    cwd: work,
    promptFile: prompt,
    model: '',
    systemFile: '',
    resumeSessionId: '',
    effort: '',
    workDir: '',
    env: {},
    ...overrides,
  })
}

function hasPair(argv: string[], flag: string, value: string): boolean {
  return argv.some((arg, index) => arg === flag && argv[index + 1] === value)
}

describe('buildCmd', () => {
  test('compone `claude -p` con sus flags fijos y el prompt solo por la entrada estandar', () => {
    const plain = join(work, 'prompt-plain.txt')
    writeFileSync(plain, 'Instrucciones de prueba.')
    const system = join(work, 'system.txt')
    writeFileSync(system, 'You are running in non-interactive print mode.')
    const built = command({ promptFile: plain, model: 'sonnet', systemFile: system })

    assert.deepEqual(built.argv.slice(0, 2), ['claude', '-p'])
    assert.equal(hasPair(built.argv, '--permission-mode', 'bypassPermissions'), true)
    assert.equal(hasPair(built.argv, '--output-format', 'stream-json'), true)
    assert.equal(built.argv.includes('--verbose'), true)
    assert.equal(hasPair(built.argv, '--agent', 'writer'), true)
    assert.equal(hasPair(built.argv, '--model', 'sonnet'), true)
    assert.equal(hasPair(built.argv, '--append-system-prompt-file', system), true)
    assert.equal(built.stdinFile, plain)
    assert.equal(built.argv.some((arg) => arg.includes('Instrucciones de prueba.')), false)
    assert.equal(built.argv.some((arg) => arg.includes('non-interactive print mode')), false)
    assert.equal(built.env, undefined)
  })

  test('modelo y system file vacios no agregan sus flags', () => {
    const { argv } = command()
    assert.equal(argv.includes('--model'), false)
    assert.equal(argv.includes('--append-system-prompt-file'), false)
    assert.equal(argv.includes('--resume'), false)
    assert.equal(argv.includes('--plugin-dir'), false)
  })

  test('backticks, $() y comillas del prompt nunca tocan el argv', () => {
    const dangerous = join(work, 'prompt-dangerous.txt')
    writeFileSync(dangerous, 'Linea con `comando`, $(echo pwned) y "comillas".')
    const built = command({ promptFile: dangerous })
    assert.equal(built.argv.some((arg) => arg.includes('`comando`')), false)
    assert.equal(built.stdinFile, dangerous)
  })

  test('un modelo opaco con [1m] se reenvia literal', () => {
    assert.equal(hasPair(command({ model: 'claude-opus-5[1m]' }).argv, '--model', 'claude-opus-5[1m]'), true)
  })

  test('una sesion a reanudar agrega --resume <id>', () => {
    assert.equal(hasPair(command({ resumeSessionId: 'sess-abc-123' }).argv, '--resume', 'sess-abc-123'), true)
    assert.equal(supportsResume(), true)
  })

  test('el effort viaja por CLAUDE_CODE_EFFORT_LEVEL y nunca como --effort', () => {
    const built = command({ effort: 'high' })
    assert.deepEqual(built.env, { CLAUDE_CODE_EFFORT_LEVEL: 'high' })
    assert.deepEqual(built.argv.slice(0, 2), ['claude', '-p'])
    assert.equal(built.argv.includes('--effort'), false)
    assert.equal(built.argv.includes('env'), false)
  })

  test('--plugin-dir solo con una raiz que es un plugin de Claude', () => {
    const root = join(work, 'release-claude')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"mefisto","version":"0.0.0"}')
    assert.equal(hasPair(command({ env: { MEFISTO_AGENT_PACKAGE_ROOT: root } }).argv, '--plugin-dir', root), true)
    assert.equal(command({ env: { MEFISTO_AGENT_PACKAGE_ROOT: work } }).argv.includes('--plugin-dir'), false)
    assert.equal(command({ env: { MEFISTO_AGENT_PACKAGE_ROOT: '' } }).argv.includes('--plugin-dir'), false)
  })

  test('el refresco interactivo es una linea `prompt /reload-plugins`', () => {
    assert.equal(interactiveRefresh(), 'prompt /reload-plugins')
  })

  test('disponibilidad y tablas por defecto', () => {
    assert.equal(isAvailable({}, (name) => name === 'claude'), true)
    assert.equal(isAvailable({}, () => false), false)
    assert.deepEqual(['fast', 'balanced', 'deep', 'otro', 'toString'].map(defaultModel), ['haiku', 'sonnet', 'opus', null, null])
    assert.deepEqual(
      ['quick', 'light', 'standard', 'thorough', 'exhaustive', 'otro'].map(defaultEffort),
      ['low', 'medium', 'high', 'xhigh', 'max', null],
    )
  })
})

describe('mapeo de eventos', () => {
  test('text -> message, tool_use -> tool.started y tool_result -> tool.completed, en orden', () => {
    const events = translated('success.jsonl')
    assert.deepEqual(
      events.filter((event) => event.type === 'message').map((event) => [event.role, event.text]),
      [
        ['assistant', 'Voy a investigar.'],
        ['assistant', 'Listo, hice el cambio.'],
      ],
    )
    assert.deepEqual(
      events.filter((event) => event.type === 'tool.started').map((event) => [event.tool, event.input_summary]),
      [['Read', 'x']],
    )
    assert.deepEqual(
      events.filter((event) => event.type === 'tool.completed').map((event) => [event.tool, event.ok, event.duration_ms]),
      [['Read', true, 200]],
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['message', 'tool.started', 'tool.completed', 'message', 'run.completed'],
    )
  })

  test('nunca emite run.started ni reemite el evento system/init', () => {
    const text = translated('success.jsonl').map((event) => dump(event)).join('\n')
    assert.doesNotMatch(text, /"type":"system"/)
    assert.doesNotMatch(text, /"type":"run\.started"/)
  })

  test('input_summary: ruta en tools de archivo, 80 caracteres del comando en Bash, null en el resto', () => {
    const tool = (name: string, input: string): string =>
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${name}","name":"${name}","input":${input}}]}}`
    const raw = [
      tool('Edit', '{"file_path":"a.ts"}'),
      tool('Write', '{"file_path":"b.ts"}'),
      tool('Bash', JSON.stringify({ command: 'ñ'.repeat(100) })),
      tool('Bash', '{}'),
      tool('Grep', '{"pattern":"x","file_path":"c.ts"}'),
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"Edit","is_error":true},{"type":"tool_result","tool_use_id":"nadie"}]}}',
      '{"type":"user","message":{"content":"texto suelto"}}',
    ].join('\n')
    const events = translateStream(raw, 'claude', '', null, '')
    assert.deepEqual(
      events.filter((event) => event.type === 'tool.started').map((event) => event.input_summary),
      ['a.ts', 'b.ts', 'ñ'.repeat(80), null, null],
    )
    assert.deepEqual(
      events.filter((event) => event.type === 'tool.completed').map((event) => [event.tool, event.ok, event.duration_ms]),
      [
        ['Edit', false, null],
        ['?', true, null],
      ],
    )
  })

  test('un evento sin timestamp usa la hora de la traduccion, con segundos enteros', () => {
    const raw = '{"type":"assistant","message":{"content":[{"type":"text","text":"hola"}]}}\n'
    const [message, terminal] = translateStream(raw, 'claude', '', null, '', new Date('2026-01-02T03:04:05.678Z'))
    assert.equal(message?.ts, '2026-01-02T03:04:05Z')
    assert.equal(terminal?.ts, '2026-01-02T03:04:05Z')
  })
})

describe('clasificacion', () => {
  test('exito declarado: is_error false, subtype success y stop_reason end_turn', () => {
    const terminal = terminalOf(translated('success.jsonl'))
    assert.deepEqual([terminal.type, terminal.status, terminal.error], ['run.completed', 'success', null])
  })

  test('is_error con status 5xx es provider_unavailable y con 4xx, api_error', () => {
    const unavailable = terminalOf(translated('api-error-529.jsonl'))
    assert.deepEqual([unavailable.type, unavailable.status, errorOf(unavailable).kind], ['run.failed', 'failed', 'provider_unavailable'])
    assert.match(String(errorOf(unavailable).detail), /529/)
    const api = terminalOf(translated('api-error-404.jsonl'))
    assert.equal(errorOf(api).kind, 'api_error')
    assert.match(String(errorOf(api).detail), /404/)
  })

  test('una ventana de uso agotada es rate_limit con resets_at poblado', () => {
    const terminal = terminalOf(translated('rate-limit-exhausted.jsonl', '', 1))
    assert.equal(errorOf(terminal).kind, 'rate_limit')
    assert.equal(terminal.resets_at, '2026-05-07T22:40:00Z')
  })

  test('sin result: ultima linea cortada es stream_cut; completa, no_result', () => {
    assert.equal(errorOf(terminalOf(translated('stream-truncated.jsonl'))).kind, 'stream_cut')
    assert.equal(errorOf(terminalOf(translated('killed-no-result.jsonl'))).kind, 'no_result')
  })

  test('exit 137 y 143 son killed y ganan a no_result', () => {
    const killed = terminalOf(translated('killed-no-result.jsonl', '', 137))
    assert.equal(errorOf(killed).kind, 'killed')
    assert.match(String(errorOf(killed).detail), /137/)
    assert.equal(errorOf(terminalOf(translated('killed-no-result.jsonl', '', 143))).kind, 'killed')
  })

  test('el exito declarado sobrevive a una muerte posterior, que queda anotada', () => {
    const terminal = terminalOf(translated('success.jsonl', '', 137))
    assert.deepEqual([terminal.type, terminal.status, errorOf(terminal).kind], ['run.completed', 'success', 'killed'])
    const nonzero = terminalOf(translated('success.jsonl', '', 2))
    assert.deepEqual([nonzero.status, errorOf(nonzero).kind], ['success', 'nonzero_exit'])
  })

  test('el API Error que solo llega por stderr se clasifica, y el 5xx gana al 4xx', () => {
    const only5 = terminalOf(translated('killed-no-result.jsonl', '', 1, 'ruido previo\nAPI Error: 500 Internal Server Error\n'))
    assert.equal(errorOf(only5).kind, 'provider_unavailable')
    assert.match(String(errorOf(only5).detail), /500/)
    const mixed = terminalOf(translated('killed-no-result.jsonl', '', 1, 'API Error: 400 Bad Request\nAPI Error: 529 Overloaded\n'))
    assert.equal(errorOf(mixed).kind, 'provider_unavailable')
    assert.match(String(errorOf(mixed).detail), /529/)
    const only4 = terminalOf(translated('killed-no-result.jsonl', '', 1, 'API Error: 400 Bad Request\n'))
    assert.equal(errorOf(only4).kind, 'api_error')
  })

  test('"Connection closed mid-response" en stderr es stream_cut', () => {
    const terminal = terminalOf(translated('killed-no-result.jsonl', '', 1, 'Connection closed mid-response\n'))
    assert.equal(errorOf(terminal).kind, 'stream_cut')
  })

  test('un result que no declara exito ni error es nonzero_exit', () => {
    const terminal = terminalOf(translated('result-max-turns.jsonl', '', 1))
    assert.equal(errorOf(terminal).kind, 'nonzero_exit')
    assert.match(String(errorOf(terminal).detail), /max_turns/)
  })

  test('el detalle de un error se recorta a 300 caracteres', () => {
    const terminal = terminalOf(translateStream('', 'claude', '', 1, `API Error: 500 ${'x'.repeat(1000)}\n`))
    assert.equal(String(errorOf(terminal).detail).length, 300)
  })

  test('una traza con una forma que el traductor no entiende no produce eventos', () => {
    const raw = join(work, 'forma-rara.jsonl')
    writeFileSync(raw, '{"type":"assistant","message":"no es un objeto"}\n')
    assert.deepEqual(translate({ rawFile: raw, runtime: 'claude', model: '', exitCode: null, stderrFile: '' }), [])
    assert.deepEqual(
      translate({ rawFile: join(work, 'no-existe'), runtime: 'claude', model: '', exitCode: null, stderrFile: '' }),
      [],
    )
  })
})

describe('cifras del terminal', () => {
  test('se conservan cuando Claude las entrega', () => {
    const terminal = terminalOf(translated('success.jsonl'))
    assert.deepEqual(terminal, {
      v: 1,
      type: 'run.completed',
      ts: '2026-07-27T22:09:36.000Z',
      status: 'success',
      runtime: 'claude',
      model: 'claude-sonnet-5',
      session_id: 'sess-abc',
      duration_ms: null,
      tokens: { input: 100, output: 50, cache_read: 11, cache_write: 12, reasoning: null },
      estimated_cost_usd: 0.01,
      turns: 2,
      denials: 1,
      ttft_ms: 300,
      api_duration_ms: 1500,
      error: null,
      resets_at: null,
    })
    assert.equal('cost_usd' in terminal, false)
  })

  test('las ausentes son null, nunca cero', () => {
    const terminal = terminalOf(translated('success-minimal.jsonl'))
    for (const field of ['session_id', 'estimated_cost_usd', 'turns', 'ttft_ms', 'denials', 'api_duration_ms', 'model']) {
      assert.equal(terminal[field], null, field)
    }
    assert.deepEqual(terminal.tokens, { input: null, output: null, cache_read: null, cache_write: null, reasoning: null })
    assert.equal('cost_usd' in terminal, false)
  })

  test('el modelo sale del init, luego del primer assistant y al final del parametro', () => {
    assert.equal(terminalOf(translated('success.jsonl', 'parametro')).model, 'claude-sonnet-5')
    assert.equal(terminalOf(translated('success-minimal.jsonl', 'parametro')).model, 'parametro')
    const raw = '{"type":"assistant","message":{"model":"del-assistant","content":[]}}\n'
    assert.equal(terminalOf(translateStream(raw, 'claude', 'parametro', null, '')).model, 'del-assistant')
  })
})

test('status y error.kind del terminal de cada fixture, por stderr y exit', () => {
  const stderrs = ['', 'ruido\nAPI Error: 500 Internal\n', 'API Error: 400 Bad\nAPI Error: 529 Over\n', 'Connection closed mid-response\n']
  const exits = [null, 0, 1, 137, 143]
  // Una fila por stderr, o una sola si el stderr no cambia nada; cada columna es un exit de `exits`.
  const expected: Record<string, string | string[]> = {
    'api-error-404.jsonl': 'failed/api_error failed/api_error failed/api_error failed/killed failed/killed',
    'api-error-529.jsonl': 'failed/provider_unavailable failed/provider_unavailable failed/provider_unavailable failed/killed failed/killed',
    'killed-no-result.jsonl': [
      'failed/no_result failed/no_result failed/no_result failed/killed failed/killed',
      'failed/provider_unavailable failed/provider_unavailable failed/provider_unavailable failed/killed failed/killed',
      'failed/provider_unavailable failed/provider_unavailable failed/provider_unavailable failed/killed failed/killed',
      'failed/stream_cut failed/stream_cut failed/stream_cut failed/killed failed/killed',
    ],
    'rate-limit-exhausted.jsonl': 'failed/rate_limit failed/rate_limit failed/rate_limit failed/killed failed/killed',
    'result-max-turns.jsonl': [
      'failed/nonzero_exit failed/nonzero_exit failed/nonzero_exit failed/killed failed/killed',
      'failed/provider_unavailable failed/provider_unavailable failed/provider_unavailable failed/killed failed/killed',
      'failed/provider_unavailable failed/provider_unavailable failed/provider_unavailable failed/killed failed/killed',
      'failed/nonzero_exit failed/nonzero_exit failed/nonzero_exit failed/killed failed/killed',
    ],
    'sensitive-redaction.jsonl': 'success/- success/- success/nonzero_exit success/killed success/killed',
    'stream-truncated.jsonl': [
      'failed/stream_cut failed/stream_cut failed/stream_cut failed/killed failed/killed',
      'failed/provider_unavailable failed/provider_unavailable failed/provider_unavailable failed/killed failed/killed',
      'failed/provider_unavailable failed/provider_unavailable failed/provider_unavailable failed/killed failed/killed',
      'failed/stream_cut failed/stream_cut failed/stream_cut failed/killed failed/killed',
    ],
    'success-minimal.jsonl': 'success/- success/- success/nonzero_exit success/killed success/killed',
    'success.jsonl': 'success/- success/- success/nonzero_exit success/killed success/killed',
  }
  assert.deepEqual(Object.keys(expected), readdirSync(CLAUDE_FIXTURES).filter((file) => file.endsWith('.jsonl')).sort())
  for (const [name, rows] of Object.entries(expected)) {
    stderrs.forEach((stderrText, index) => {
      const row = typeof rows === 'string' ? rows : rows[index]
      const actual = exits.map((exit) => {
        const terminal = terminalOf(translated(name, '', exit, stderrText))
        return `${String(terminal.status)}/${terminal.error === null ? '-' : String(errorOf(terminal).kind)}`
      })
      assert.equal(actual.join(' '), row, `${name} stderr=${index}`)
    })
  }
})

describe('runner real contra el CLI simulado', () => {
  interface Scenario {
    events: JsonObject[]
    status: number
    args: string[]
    files: { eventLog: string; rawLog: string; argsFile: string; stdinDump: string; effortFile: string; eventsLog: string }
  }

  async function scenario(stub: NodeJS.ProcessEnv, extraArgs: string[] = [], promptFile = prompt): Promise<Scenario> {
    const base = join(work, `caso-${++serial}`)
    const files = {
      eventLog: `${base}.jsonl`,
      rawLog: `${base}.raw`,
      argsFile: `${base}.args`,
      stdinDump: `${base}.stdin`,
      effortFile: `${base}.effort`,
      eventsLog: `${base}.events`,
    }
    const run = await runRunner(
      ['--runtime', 'claude', '--agent', 'test-agent', '--cwd', workdir, '--prompt-file', promptFile, '--event-log', files.eventLog, '--raw-log', files.rawLog, ...extraArgs],
      {
        PATH: stubPath,
        MEFISTO_CLAUDE_STUB_ARGS_FILE: files.argsFile,
        MEFISTO_CLAUDE_STUB_STDIN_FILE: files.stdinDump,
        MEFISTO_CLAUDE_STUB_EFFORT_FILE: files.effortFile,
        ...stub,
      },
    )
    const events = readEvents(files.eventLog)
    assert.deepEqual(invalidEvents(events), [], 'todas las lineas validan contra el schema')
    const args = readFileSync(files.argsFile, 'utf8').split('\n').slice(0, -1)
    return { events, status: run.status, args, files }
  }

  function outcome(run: Scenario): [number, unknown, unknown] {
    const terminal = terminalOf(run.events)
    return [run.status, terminal.status, errorOf(terminal).kind ?? null]
  }

  test('exito: exit 0, la traza cruda intacta y --agent en la linea de comando', async () => {
    const run = await scenario({ MEFISTO_CLAUDE_STUB_FIXTURE: fixture('success.jsonl') })
    assert.deepEqual(outcome(run), [0, 'success', null])
    assert.equal(readFileSync(run.files.rawLog, 'utf8'), readFileSync(fixture('success.jsonl'), 'utf8'))
    assert.equal(hasPair(run.args, '--agent', 'test-agent'), true)
    assert.equal(run.args.includes('--model'), false)
    assert.equal(readFileSync(run.files.effortFile, 'utf8'), '')
    assert.equal(run.events[0]?.type, 'run.started')
    assert.equal(run.events[0]?.runtime, 'claude')
  })

  test('fallos del proveedor: el exit del CLI y el kind del adaptador', async () => {
    const cases: [string, NodeJS.ProcessEnv, [number, string, string]][] = [
      ['api-error-529.jsonl', {}, [1, 'failed', 'provider_unavailable']],
      ['api-error-404.jsonl', {}, [1, 'failed', 'api_error']],
      ['killed-no-result.jsonl', { MEFISTO_CLAUDE_STUB_STDERR: 'API Error: 500 Internal Server Error' }, [1, 'failed', 'provider_unavailable']],
      ['rate-limit-exhausted.jsonl', {}, [1, 'failed', 'rate_limit']],
      ['stream-truncated.jsonl', {}, [1, 'failed', 'stream_cut']],
    ]
    for (const [name, stub, expected] of cases) {
      const run = await scenario({ MEFISTO_CLAUDE_STUB_FIXTURE: fixture(name), MEFISTO_CLAUDE_STUB_EXIT: '1', ...stub })
      assert.deepEqual(outcome(run), expected, name)
    }
  })

  test('un CLI que no termina cae en timeout con exit 124', async () => {
    const run = await scenario(
      { MEFISTO_CLAUDE_STUB_FIXTURE: fixture('success.jsonl'), MEFISTO_CLAUDE_STUB_SLEEP: '3600' },
      ['--timeout', '1'],
    )
    assert.deepEqual(outcome(run), [124, 'timeout', 'timeout'])
  })

  test('exit 137 sin timeout del watchdog es killed y el runner sale con 137', async () => {
    const run = await scenario({ MEFISTO_CLAUDE_STUB_FIXTURE: fixture('killed-no-result.jsonl'), MEFISTO_CLAUDE_STUB_EXIT: '137' })
    assert.deepEqual(outcome(run), [137, 'failed', 'killed'])
  })

  test('un modelo opaco con [1m], la sesion a reanudar y el system file llegan literales', async () => {
    const system = join(work, 'system con espacios.txt')
    writeFileSync(system, 'system')
    const run = await scenario({ MEFISTO_CLAUDE_STUB_FIXTURE: fixture('success.jsonl') }, [
      '--model', 'claude-opus-5[1m]',
      '--resume-session', 'sess-1',
      '--system-file', system,
    ])
    assert.deepEqual(outcome(run), [0, 'success', null])
    assert.equal(hasPair(run.args, '--model', 'claude-opus-5[1m]'), true)
    assert.equal(hasPair(run.args, '--resume', 'sess-1'), true)
    assert.equal(hasPair(run.args, '--append-system-prompt-file', system), true)
    assert.equal(run.events[0]?.model, 'claude-opus-5[1m]')
  })

  test('--effort llega al CLI por entorno y queda en run.started', async () => {
    const run = await scenario({ MEFISTO_CLAUDE_STUB_FIXTURE: fixture('success.jsonl') }, ['--effort', 'xhigh'])
    assert.deepEqual(outcome(run), [0, 'success', null])
    assert.equal(readFileSync(run.files.effortFile, 'utf8'), 'xhigh')
    assert.equal(run.args.includes('--effort'), false)
    assert.equal(run.events[0]?.effort, 'xhigh')
  })

  test('la persistencia redactada quita centinelas y conserva identidad, metricas y tools', async () => {
    const run = await scenario(
      { MEFISTO_CLAUDE_STUB_FIXTURE: fixture('sensitive-redaction.jsonl'), MEFISTO_CLAUDE_STUB_STDERR: 'STDERR_SENTINEL AUTH_TOKEN_SENTINEL' },
      ['--redact-observability', '--events-log', join(work, 'redactado.events')],
    )
    assert.deepEqual(outcome(run), [0, 'success', null])
    assert.doesNotMatch(readFileSync(run.files.eventLog, 'utf8'), SENTINELS)
    const human = readFileSync(join(work, 'redactado.events'), 'utf8')
    assert.equal(human.length > 0, true)
    assert.doesNotMatch(human, SENTINELS)
    assert.equal(run.events.some((event) => event.type === 'message'), false)
    assert.deepEqual(
      run.events.filter((event) => event.type === 'tool.started').map((event) => [event.tool, event.input_summary]),
      [['Bash', null]],
    )
    const terminal = terminalOf(run.events)
    assert.deepEqual(
      [terminal.runtime, terminal.model, terminal.session_id, terminal.tokens, terminal.estimated_cost_usd, terminal.turns],
      ['claude', 'claude-sonnet-5', 'sess-redaction-claude', { input: 21, output: 8, cache_read: null, cache_write: null, reasoning: null }, 0.02, 2],
    )
    assert.equal('cost_usd' in terminal, false)
  })

  test('la redaccion conserva resets_at y sustituye error.detail', async () => {
    const run = await scenario(
      { MEFISTO_CLAUDE_STUB_FIXTURE: fixture('rate-limit-exhausted.jsonl'), MEFISTO_CLAUDE_STUB_EXIT: '1' },
      ['--redact-observability'],
    )
    assert.deepEqual(outcome(run), [1, 'failed', 'rate_limit'])
    const terminal = terminalOf(run.events)
    assert.equal(terminal.resets_at, '2026-05-07T22:40:00Z')
    assert.equal(errorOf(terminal).detail, 'detalle redactado: rate_limit')
  })

  test('un prompt mayor que cualquier limite de argv viaja por la entrada estandar, byte a byte', async () => {
    const sentinel = 'MEFISTO_1448_CLAUDE_SENTINEL'.padEnd(64)
    const block = 'linea con tab\tdolar $HOME y barra \\ y unicode: ñáéíóú 日本語\n'
    const big = join(work, 'prompt-grande.bin')
    writeFileSync(big, block.repeat(Math.ceil((3 * 1024 * 1024) / Buffer.byteLength(block))) + sentinel)
    const run = await scenario({ MEFISTO_CLAUDE_STUB_FIXTURE: fixture('success.jsonl') }, ['--timeout', '60'], big)
    assert.deepEqual(outcome(run), [0, 'success', null])
    assert.equal(readFileSync(run.files.stdinDump).equals(readFileSync(big)), true)
    assert.equal(run.args.join('\n').includes(sentinel), false)
    assert.equal(readFileSync(`${run.files.stdinDump}.tty`, 'utf8'), '0\n')
  })
})
