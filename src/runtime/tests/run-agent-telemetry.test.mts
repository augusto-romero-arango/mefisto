import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  CLAUDE_FIXTURES,
  LIB_DIR,
  RUNNER,
  installClaudeStub,
  readEvents,
  runRunner,
  terminalsOf,
} from './runner-sandbox.mts'

const CLOCK = '\\[[0-2][0-9]:[0-5][0-9]:[0-5][0-9]\\]'
const TOOL = new RegExp(`^${CLOCK}\\[tool\\] [^ ]+ [^ ]+ (ok|fail) .+$`)
const ARCHIVO = new RegExp(`^${CLOCK}\\[archivo\\] .+$`)
const STAGE = new RegExp(`^${CLOCK}\\[stage\\] [^ ]+ (success|failed|timeout|protocol_invalid)$`)

let work = ''
let workdir = ''
let prompt = ''
let stubPath = ''
let serial = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto telemetria '))
  workdir = join(work, 'wt')
  mkdirSync(workdir)
  prompt = join(work, 'prompt.txt')
  writeFileSync(prompt, 'prompt de prueba\n')
  stubPath = installClaudeStub(join(work, 'bin'))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

interface Telemetry {
  status: number
  stderr: string
  eventLog: string
  lines: string[]
}

async function run(runtime: string, agent: string, env: NodeJS.ProcessEnv, eventsLog?: string): Promise<Telemetry> {
  const eventLog = join(work, `ev-${++serial}.jsonl`)
  const args = ['--runtime', runtime, '--agent', agent, '--cwd', workdir, '--prompt-file', prompt, '--event-log', eventLog]
  const result = await runRunner(eventsLog === undefined ? args : [...args, '--events-log', eventsLog], env)
  const lines = eventsLog !== undefined && existsSync(eventsLog) ? readFileSync(eventsLog, 'utf8').split('\n').slice(0, -1) : []
  return { status: result.status, stderr: result.stderr, eventLog, lines }
}

const withoutClock = (lines: string[]): string[] => lines.map((line) => line.replace(/^\[\d\d:\d\d:\d\d\]/, ''))

describe('--events-log', () => {
  test('una linea [tool] por tool terminado y la linea [stage] final, con el resumen ausente como "-"', async () => {
    const human = join(work, 'a1-events.log')
    const fake = await run('fake', 'fx-agent', { MEFISTO_FAKE_SCRIPT: 'success' }, human)
    assert.equal(fake.status, 0, fake.stderr)
    assert.equal(fake.lines.length, 2)
    assert.match(fake.lines[0] ?? '', TOOL)
    assert.match(fake.lines[1] ?? '', STAGE)
    assert.deepEqual(withoutClock(fake.lines), ['[tool] fx-agent demo ok -', '[stage] fx-agent success'])
  })

  test('las lineas se anexan: no se pierde lo que ya habia en el archivo', async () => {
    const human = join(work, 'anexo', 'events.log')
    mkdirSync(join(work, 'anexo'))
    writeFileSync(human, '[00:00:00][test] previo\n')
    const fake = await run('fake', 'fx-agent', { MEFISTO_FAKE_SCRIPT: 'fail' }, human)
    assert.deepEqual(withoutClock(fake.lines), ['[test] previo', '[stage] fx-agent failed'])
  })

  test('sin --events-log no se deriva ningun destino de estado', async () => {
    const state = join(work, 'state', '.mefisto', 'pipeline')
    const fake = await run('fake', 'fx-agent', { MEFISTO_FAKE_SCRIPT: 'success', MEFISTO_STATE_DIR: state })
    assert.equal(fake.status, 0)
    assert.equal(fake.stderr, '')
    assert.equal(existsSync(state), false)
  })

  test('la hora de cada linea es la local del proceso', { skip: process.platform === 'win32' ? 'TZ no rige en Windows' : false }, async () => {
    const human = join(work, 'tz-events.log')
    const fake = await run('fake', 'a', { MEFISTO_FAKE_SCRIPT: 'success', TZ: 'America/Bogota' }, human)
    const [terminal] = terminalsOf(readEvents(fake.eventLog))
    const expected = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Bogota',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(String(terminal?.ts)))
    assert.equal(fake.lines.at(-1), `[${expected}][stage] a success`)
  })

  test('un tool de archivo de Claude produce [archivo] y arrastra su ruta a la linea [tool]', async () => {
    const human = join(work, 'b-events.log')
    const claude = await run(
      'claude',
      'writer',
      { PATH: stubPath, MEFISTO_CLAUDE_STUB_FIXTURE: join(CLAUDE_FIXTURES, 'success.jsonl') },
      human,
    )
    assert.equal(claude.status, 0, claude.stderr)
    assert.match(claude.lines[0] ?? '', ARCHIVO)
    assert.deepEqual(withoutClock(claude.lines), ['[archivo] x', '[tool] writer Read ok x', '[stage] writer success'])
  })

  test('el comando de un Bash viaja como resumen de [tool], nunca como [archivo]', async () => {
    const fixture = join(work, 'b2-bash.jsonl')
    writeFileSync(
      fixture,
      [
        '{"type":"system","subtype":"init","session_id":"sess-b2","model":"claude-sonnet-5"}',
        '{"type":"assistant","timestamp":"2026-07-27T22:09:34.500Z","message":{"content":[{"type":"tool_use","id":"toolu_b2","name":"Bash","input":{"command":"git status -sb"}}]}}',
        '{"type":"user","timestamp":"2026-07-27T22:09:34.700Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_b2","content":"## main"}]}}',
        '{"type":"result","is_error":false,"subtype":"success","stop_reason":"end_turn","num_turns":1,"duration_ms":1000,"duration_api_ms":800,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5},"ttft_ms":100,"permission_denials":[],"timestamp":"2026-07-27T22:09:36.000Z"}',
        '',
      ].join('\n'),
    )
    const human = join(work, 'b2-events.log')
    const claude = await run('claude', 'writer', { PATH: stubPath, MEFISTO_CLAUDE_STUB_FIXTURE: fixture }, human)
    assert.deepEqual(withoutClock(claude.lines), ['[tool] writer Bash ok git status -sb', '[stage] writer success'])
  })

  test('un destino que no se puede escribir degrada a un aviso, sin tocar el exit ni el terminal', async () => {
    const blocked = join(prompt, 'sub', 'events.log')
    const fake = await run('fake', 'fx-agent', { MEFISTO_FAKE_SCRIPT: 'success' }, blocked)
    assert.equal(fake.status, 0)
    assert.equal(terminalsOf(readEvents(fake.eventLog)).length, 1)
    assert.equal(
      fake.stderr,
      `AVISO: no se pudo escribir la telemetria de herramientas en events.log (destino: '${blocked}'); se omite sin afectar el exit code ni el evento terminal de la corrida (CA-3, issue #863)\n`,
    )
  })

  test('el runner y sus librerias no nombran credenciales ni almacenes de autenticacion', () => {
    const sources = [RUNNER, ...readdirSync(LIB_DIR).filter((name) => name.endsWith('.mts')).map((name) => join(LIB_DIR, name))]
    for (const source of sources) {
      assert.doesNotMatch(readFileSync(source, 'utf8'), /ANTHROPIC_API_KEY|OPENAI_API_KEY|auth\.json|\.aws\/|\.ssh\//, source)
    }
  })
})
