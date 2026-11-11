import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  agentHoldWait,
  agentResumePrompt,
  agentSessionTranscriptCount,
  fmtHoldDuration,
  formatHoldStatus,
  holdLimits,
  holdNoteSuffix,
  holdSecondsInRange,
  localEpochAt,
  planHold,
  resetsAtEpoch,
  transcriptStoreSlug,
} from '../lib/pipeline/agent-hold.mts'
import { clockTime } from '../lib/pipeline/agent-log.mts'
import { NO_BASH, bashLibrary, chomp } from './pipeline-agents-parity.mts'

const NOW = new Date(2026, 5, 15, 12, 0, 0)
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000)
const isoUtc = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const announce = (start: string, probe: string, family = 'RATE_LIMIT'): string =>
  `[${start}][hold] ${family}: esperando, proxima sonda ${probe} (techo 23:59)`

const RANGE_LOG = [
  '=== SESSION TOOLING 20260101-080000 issue:41 from-stage:1 ===',
  '[08:00:00][hold] RATE_LIMIT: esperando, proxima sonda 08:05:00 (techo 14:00)',
  '=== SESSION TOOLING 20260101-090000 issue:42 from-stage:1 ===',
  '[09:00:00][hold] RATE_LIMIT: esperando, proxima sonda 09:05:00 (techo 15:00)',
  '[09:05:10][hold][resume] writer: sesion reanudada murio de nuevo sin resumen -- degradado a stage desde cero',
  '=== SESSION IAC 20260101-091000 issue:43 env:dev from-stage:1 ===',
  '[09:10:00][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda 09:20:00 (techo 15:10)',
  '─── SESSION 20260101-093000 issue:file from-stage:1 ───',
  '[09:30:00][hold] RATE_LIMIT: esperando, proxima sonda 09:35:00 (techo 15:30)',
  '',
].join('\n')

const EDGE_LOG = [
  '[23:58:00][hold] RATE_LIMIT: esperando, proxima sonda 00:03:00 (techo 05:00)',
  '',
  'ruido [10:00:00][hold] RATE_LIMIT: esperando, proxima sonda 10:01:00 (techo 11:00)',
  '[10:00:00][hold] RATE_LIMIT: esperando, proxima sonda 25:00:00 (techo 11:00)',
  'esperando, proxima sonda 10:00:10 ][hold] al reves',
  '=== SESSION TDD 20260101-100000 issue:7 issue:8 ===',
  '[11:00:00][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda 11:00:30 (techo 12:00)',
  '=== SESSION TDD 20260101-100000 issue:70 ===',
  '[11:10:00][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda 11:11:00 (techo 12:00)',
  '[11:20:00][hold] RATE_LIMIT: esperando, proxima sonda 11:22:00 (techo 12:00)',
].join('\n')

let work = ''
let eventsLog = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto agent hold '))
  eventsLog = join(work, 'events.log')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function logFile(name: string, content: string): string {
  const path = join(work, name)
  writeFileSync(path, content)
  return path
}

describe('agentHoldWait', () => {
  interface Wait {
    slept: number | null
    sleeps: number[]
    log: string
  }

  async function wait(env: NodeJS.ProcessEnv, failureType: string, holdStarted: number, resetsAt?: string): Promise<Wait> {
    writeFileSync(eventsLog, '')
    const sleeps: number[] = []
    const slept = await agentHoldWait({
      eventsLog,
      failureType,
      holdStarted,
      resetsAt,
      env,
      now: () => NOW,
      sleep: async (seconds) => {
        // El anuncio ya esta escrito cuando empieza la siesta.
        assert.notEqual(readFileSync(eventsLog, 'utf8'), '')
        sleeps.push(seconds)
      },
    })
    return { slept, sleeps, log: readFileSync(eventsLog, 'utf8') }
  }

  test('[8] duerme la sonda y deja la linea de hold', async () => {
    const env = { MEFISTO_HOLD_PROBE_SECONDS: '1', MEFISTO_HOLD_MAX_SECONDS: '3600' }
    assert.deepEqual(await wait(env, 'RATE_LIMIT (exit 1)', NOW_EPOCH), {
      slept: 1,
      sleeps: [1],
      log: '[12:00:00][hold] RATE_LIMIT: esperando, proxima sonda 12:00:01 (techo 13:00)\n',
    })
  })

  test('[9] con el techo agotado no duerme ni anota', async () => {
    const env = { MEFISTO_HOLD_MAX_SECONDS: '3600' }
    assert.deepEqual(await wait(env, 'PROVIDER_UNAVAILABLE (exit 1)', NOW_EPOCH - 7200), { slept: null, sleeps: [], log: '' })
    assert.deepEqual(await wait(env, 'PROVIDER_UNAVAILABLE (exit 1)', NOW_EPOCH - 3600), { slept: null, sleeps: [], log: '' })
    assert.deepEqual(await wait({ MEFISTO_HOLD_MAX_SECONDS: '0' }, 'RATE_LIMIT', NOW_EPOCH), { slept: null, sleeps: [], log: '' })
  })

  test('[9b] la sonda se recorta al remanente del techo', async () => {
    const env = { MEFISTO_HOLD_PROBE_SECONDS: '60', MEFISTO_HOLD_MAX_SECONDS: '2' }
    assert.deepEqual(await wait(env, 'RATE_LIMIT (exit 1)', NOW_EPOCH), {
      slept: 2,
      sleeps: [2],
      log: '[12:00:00][hold] RATE_LIMIT: esperando, proxima sonda 12:00:02 (techo 12:00)\n',
    })
  })

  test('sin variables usa la sonda de 5 minutos y el techo de 6 horas', async () => {
    assert.deepEqual(await wait({}, 'PROVIDER_UNAVAILABLE', NOW_EPOCH - 90), {
      slept: 300,
      sleeps: [300],
      log: '[12:00:00][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda 12:05:00 (techo 17:58)\n',
    })
  })

  test('con resets_at espera hasta ese instante mas un minuto', async () => {
    assert.deepEqual(await wait({}, 'RATE_LIMIT (exit 1)', NOW_EPOCH, isoUtc(NOW_EPOCH + 600)), {
      slept: 660,
      sleeps: [660],
      log: '[12:00:00][hold] RATE_LIMIT: esperando, proxima sonda 12:11:00 (techo 18:00)\n',
    })
    assert.equal((await wait({}, 'RATE_LIMIT', NOW_EPOCH, isoUtc(NOW_EPOCH - 3600))).slept, 1)
    assert.equal((await wait({}, 'RATE_LIMIT', NOW_EPOCH - 21_000, isoUtc(NOW_EPOCH + 7200))).slept, 600)
  })

  test('un resets_at que no se puede leer cae a la cadencia fija', async () => {
    for (const resetsAt of ['', 'pronto', '2026-06-15T18:00:00.500Z', '2026-06-15T18:00:00+02:00', '2026-13-15T18:00:00Z']) {
      assert.equal((await wait({}, 'RATE_LIMIT', NOW_EPOCH, resetsAt)).slept, 300, resetsAt)
    }
  })

  test('sin reloj ni siesta inyectados espera de verdad', async () => {
    writeFileSync(eventsLog, '')
    const slept = await agentHoldWait({
      eventsLog,
      failureType: 'RATE_LIMIT (exit 1)',
      holdStarted: Math.floor(Date.now() / 1000),
      env: { MEFISTO_HOLD_PROBE_SECONDS: '0' },
    })
    assert.equal(slept, 0)
    assert.match(readFileSync(eventsLog, 'utf8'), /^\[\d{2}:\d{2}:\d{2}\]\[hold\] RATE_LIMIT: esperando, proxima sonda \d{2}:\d{2}:\d{2} \(techo \d{2}:\d{2}\)\n$/)
  })

  test('un events.log que no se puede escribir no cancela la espera', async () => {
    const sleeps: number[] = []
    const slept = await agentHoldWait({
      eventsLog: join(work, 'no-existe', 'events.log'),
      failureType: 'RATE_LIMIT',
      holdStarted: NOW_EPOCH,
      env: {},
      now: () => NOW,
      sleep: async (seconds) => {
        sleeps.push(seconds)
      },
    })
    assert.equal(slept, 300)
    assert.deepEqual(sleeps, [300])
  })
})

describe('planHold y sus limites', () => {
  test('holdLimits lee las variables y cae a los defaults', () => {
    assert.deepEqual(holdLimits({}), { maxSeconds: 21_600, probeSeconds: 300 })
    assert.deepEqual(holdLimits({ MEFISTO_HOLD_MAX_SECONDS: '', MEFISTO_HOLD_PROBE_SECONDS: 'cinco' }), {
      maxSeconds: 21_600,
      probeSeconds: 300,
    })
    assert.deepEqual(holdLimits({ MEFISTO_HOLD_MAX_SECONDS: '7200', MEFISTO_HOLD_PROBE_SECONDS: '15' }), {
      maxSeconds: 7200,
      probeSeconds: 15,
    })
  })

  test('la familia del anuncio es la primera palabra de la etiqueta', () => {
    const limits = { maxSeconds: 3600, probeSeconds: 60 }
    const line = (failureType: string): string | undefined => planHold({ failureType, holdStarted: NOW_EPOCH, now: NOW, limits })?.line
    assert.equal(line('PROVIDER_UNAVAILABLE (exit 1)'), '[12:00:00][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda 12:01:00 (techo 13:00)')
    assert.equal(line('RATE_LIMIT'), '[12:00:00][hold] RATE_LIMIT: esperando, proxima sonda 12:01:00 (techo 13:00)')
    assert.equal(line(''), '[12:00:00][hold] : esperando, proxima sonda 12:01:00 (techo 13:00)')
  })

  test('resetsAtEpoch solo lee instantes UTC con segundos', () => {
    assert.equal(resetsAtEpoch('2030-01-01T00:00:00Z'), 1_893_456_000)
    assert.equal(resetsAtEpoch('2030-01-01T00:00:60Z'), 1_893_456_060)
    for (const text of ['', '2030-01-01', '2030-01-01T00:00:00', '2030-01-01T24:00:00Z', '2030-00-01T00:00:00Z', ' 2030-01-01T00:00:00Z']) {
      assert.equal(resetsAtEpoch(text), null, text)
    }
  })
})

describe('agentSessionTranscriptCount', () => {
  test('transcriptStoreSlug cambia separadores y puntos por guiones', () => {
    assert.equal(transcriptStoreSlug('/Users/ana/repo/.mefisto/worktrees/x.y', 'darwin'), '-Users-ana-repo--mefisto-worktrees-x-y')
    assert.equal(transcriptStoreSlug('/home/ana/mi_repo con espacios', 'linux'), '-home-ana-mi_repo con espacios')
    assert.equal(transcriptStoreSlug('/home/ana/a\\b:c', 'linux'), '-home-ana-a\\b:c')
    assert.equal(transcriptStoreSlug('C:\\Users\\ana\\repo\\.mefisto', 'win32'), 'C--Users-ana-repo--mefisto')
  })

  test('[1b] cuenta los transcripts del store del directorio', () => {
    const config = join(work, 'config')
    const probe = join(work, 'worktree.probe')
    mkdirSync(probe)
    const env = { CLAUDE_CONFIG_DIR: config }
    assert.equal(agentSessionTranscriptCount(probe, { env }), 0)

    const store = join(config, 'projects', transcriptStoreSlug(realpathSync.native(probe)))
    mkdirSync(store, { recursive: true })
    assert.equal(agentSessionTranscriptCount(probe, { env }), 0)
    for (const name of ['aaa.jsonl', 'bbb.jsonl', 'notas.txt', '.oculto.jsonl', 'ccc.jsonl.bak']) writeFileSync(join(store, name), '')
    mkdirSync(join(store, 'carpeta.jsonl'))
    assert.equal(agentSessionTranscriptCount(probe, { env }), 3)

    assert.equal(agentSessionTranscriptCount('', { env }), 0)
    assert.equal(agentSessionTranscriptCount(join(work, 'no-existe'), { env }), 0)
    assert.equal(agentSessionTranscriptCount(join(store, 'aaa.jsonl'), { env }), 0)
  })

  test('sin CLAUDE_CONFIG_DIR busca en .claude del home', () => {
    const home = join(work, 'home')
    const probe = join(work, 'otro-worktree')
    mkdirSync(probe)
    const store = join(home, '.claude', 'projects', transcriptStoreSlug(realpathSync.native(probe)))
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'sesion.jsonl'), '')
    assert.equal(agentSessionTranscriptCount(probe, { env: {}, home }), 1)
    assert.equal(agentSessionTranscriptCount(probe, { env: { CLAUDE_CONFIG_DIR: '' }, home }), 1)
    assert.equal(agentSessionTranscriptCount(probe, { env: {}, home: join(work, 'otro-home') }), 0)
  })
})

test('[1] agentResumePrompt nombra el stage, el agente y la ruta del resumen', () => {
  const prompt = agentResumePrompt('2', 'reviewer')
  assert.match(prompt, /^Tu sesion anterior en este mismo stage \(stage 2, agente reviewer\) se corto/)
  assert.ok(prompt.includes('.claude/pipeline/summaries/stage-2-reviewer.md'))
  assert.match(prompt, /no reinicies tu analisis/i)
  assert.ok(prompt.includes("'git push' o 'gh pr create'"))
  assert.ok(prompt.includes('SIN_SESION_PREVIA'))
  assert.equal(prompt.split('stage 2, agente reviewer').length, 3)
  assert.ok(prompt.endsWith('responsabilidad exclusiva del pipeline.\n'))
  assert.equal(prompt.split('\n').length, 10)
})

test('localEpochAt da el epoch de una fecha y hora locales', () => {
  assert.equal(localEpochAt('2026-06-15', '12:00:00'), NOW_EPOCH)
  assert.equal(localEpochAt('2026-06-15', '12:00:01'), NOW_EPOCH + 1)
  assert.equal(localEpochAt('2026-06-14', '12:00:00'), Math.floor(new Date(2026, 5, 14, 12, 0, 0).getTime() / 1000))
  for (const [date, time] of [
    ['2026-13-01', '10:00:00'],
    ['2026-06-32', '10:00:00'],
    ['2026-06-15', '24:00:00'],
    ['2026-06-15', '12:60:00'],
    ['2026-06-15', '12:00'],
    ['2026-06-15', ''],
    ['junio', '12:00:00'],
    ['', ''],
  ] as const) {
    assert.equal(localEpochAt(date, time), null, `${date} ${time}`)
  }
})

describe('formatHoldStatus', () => {
  test('[10] con espera activa da la causa, la sonda y el techo, sin la hora', () => {
    const active = logFile('activa.log', `=== SESSION TOOLING 20260101-000000 issue:42 from-stage:1 ===\n${announce('11:57:00', '12:02:00')}\n`)
    assert.equal(formatHoldStatus(active, NOW), 'RATE_LIMIT: esperando, proxima sonda 12:02:00 (techo 23:59)')
    assert.equal(formatHoldStatus(active, NOW, 1), 'RATE_LIMIT: esperando, proxima sonda 12:02:00 (techo 23:59)')
    assert.equal(formatHoldStatus(active, NOW, 2), null)
  })

  test('[10] sin espera activa no hay estado', () => {
    assert.equal(formatHoldStatus(logFile('pasada.log', `${announce('11:53:00', '11:58:00', 'PROVIDER_UNAVAILABLE')}\n`), NOW), null)
    assert.equal(formatHoldStatus(logFile('otro-dia.log', `${announce('14:00:00', '14:05:00')}\n`), NOW), null)
    assert.equal(formatHoldStatus(logFile('reanudacion.log', '[11:59:00][hold][resume] writer: reintento desde cero\n'), NOW), null)
    assert.equal(formatHoldStatus(logFile('vacio.log', ''), NOW), null)
    assert.equal(formatHoldStatus(join(work, 'no-existe.log'), NOW), null)
  })

  test('usa el ultimo anuncio', () => {
    const several = logFile('varias.log', `${announce('11:45:00', '11:50:00')}\n${announce('11:57:00', '12:02:00', 'PROVIDER_UNAVAILABLE')}\n`)
    assert.equal(formatHoldStatus(several, NOW), 'PROVIDER_UNAVAILABLE: esperando, proxima sonda 12:02:00 (techo 23:59)')
  })
})

test('[11] fmtHoldDuration y holdNoteSuffix', () => {
  assert.equal(fmtHoldDuration(130), '2m 10s')
  assert.equal(fmtHoldDuration(0), '0m 0s')
  assert.equal(fmtHoldDuration(59), '0m 59s')
  assert.equal(fmtHoldDuration(3600), '60m 0s')
  assert.equal(holdNoteSuffix(130), ' (incluye 2m 10s en espera/hold)')
  assert.equal(holdNoteSuffix(0), '')
  assert.equal(holdNoteSuffix(-5), '')
})

describe('holdSecondsInRange', () => {
  test('[12] suma los ciclos, acota por linea y atribuye por sesion', () => {
    const range = logFile('range.log', RANGE_LOG)
    assert.equal(holdSecondsInRange(range, NOW), 1500)
    assert.equal(holdSecondsInRange(range, NOW, 0, 42), 300)
    assert.equal(holdSecondsInRange(range, NOW, 0, '43'), 600)
    assert.equal(holdSecondsInRange(range, NOW, 0, 41), 300)
    assert.equal(holdSecondsInRange(range, NOW, 2, 41), 0)
    assert.equal(holdSecondsInRange(range, NOW, 0, 4), 0)
    assert.equal(holdSecondsInRange(range, NOW, 8), 300)
    assert.equal(holdSecondsInRange(range, NOW, 99), 0)
    assert.equal(holdSecondsInRange(join(work, 'no-existe.log'), NOW, 0, 42), 0)
    assert.equal(holdSecondsInRange(work, NOW), 0)
  })

  test('[9] un ciclo que cruza medianoche cuenta en positivo', () => {
    const edge = logFile('edge.log', EDGE_LOG)
    // 300 del cruce de medianoche, 30 de la sesion 7, 60 de la 70; la ultima linea no tiene salto final.
    assert.equal(holdSecondsInRange(edge, NOW), 390)
    assert.equal(holdSecondsInRange(edge, NOW, 0, 7), 30)
    assert.equal(holdSecondsInRange(edge, NOW, 0, 8), 0)
    assert.equal(holdSecondsInRange(edge, NOW, 0, 70), 60)
    assert.equal(holdSecondsInRange(logFile('edge-con-salto.log', `${EDGE_LOG}\n`), NOW, 0, 70), 180)
  })
})

describe('paridad con la gemela bash', { skip: NO_BASH }, () => {
  test('agent_hold_wait', async () => {
    const bashLog = join(work, 'hold-bash.log')
    const ownLog = join(work, 'hold-ts.log')
    // Sin dormir de verdad, y reintentando si la llamada cruzo un cambio de segundo.
    const script = [
      'sleep() { :; }',
      'for attempt in 1 2 3 4 5 6 7 8; do',
      '  : > "$1"',
      '  before=$(date +%s)',
      '  out=$(agent_hold_wait "$1" "$2" "$((before - $3))" "${4:-}"); rc=$?',
      '  [ "$(date +%s)" = "$before" ] && break',
      'done',
      'printf "%s\\n%s\\n%s\\n" "$before" "$rc" "$out"; cat "$1"',
    ].join('\n')
    const soon = Math.floor(Date.now() / 1000)
    const cases: [failureType: string, elapsed: number, resetsAt: string, env: Record<string, string>][] = [
      ['RATE_LIMIT (exit 1)', 0, '', { MEFISTO_HOLD_PROBE_SECONDS: '1', MEFISTO_HOLD_MAX_SECONDS: '3600' }],
      ['PROVIDER_UNAVAILABLE (exit 1)', 7200, '', { MEFISTO_HOLD_MAX_SECONDS: '3600' }],
      ['RATE_LIMIT (exit 1)', 0, '', { MEFISTO_HOLD_PROBE_SECONDS: '60', MEFISTO_HOLD_MAX_SECONDS: '2' }],
      ['RATE_LIMIT', 0, '', { MEFISTO_HOLD_MAX_SECONDS: '0' }],
      ['PROVIDER_UNAVAILABLE', 100, '', {}],
      ['PROVIDER_UNAVAILABLE', 100, '', { MEFISTO_HOLD_PROBE_SECONDS: '', MEFISTO_HOLD_MAX_SECONDS: '' }],
      ['RATE_LIMIT (exit 1)', 21_000, '', {}],
      ['RATE_LIMIT (exit 1)', 21_600, '', {}],
      ['RATE_LIMIT (exit 1)', 0, isoUtc(soon + 900), {}],
      ['RATE_LIMIT (exit 1)', 0, isoUtc(soon - 900), {}],
      ['RATE_LIMIT (exit 1)', 0, isoUtc(soon + 86_400), {}],
      ['RATE_LIMIT (exit 1)', 20_000, isoUtc(soon + 3000), {}],
      ['RATE_LIMIT (exit 1)', 0, 'no-es-una-fecha', {}],
      ['RATE_LIMIT (exit 1)', 0, '2030-13-01T00:00:00Z', { MEFISTO_HOLD_PROBE_SECONDS: '45' }],
      ['SIN_ESPACIOS', 5, '', { MEFISTO_HOLD_PROBE_SECONDS: '0' }],
    ]
    for (const [failureType, elapsed, resetsAt, extra] of cases) {
      const env = { ...process.env, MEFISTO_HOLD_PROBE_SECONDS: undefined, MEFISTO_HOLD_MAX_SECONDS: undefined, ...extra }
      const fromBash = bashLibrary(script, [bashLog, failureType, String(elapsed), resetsAt], { env })
      const [started = '', status = '', ...rest] = fromBash.stdout.split('\n')
      const startedEpoch = Number(started)
      writeFileSync(ownLog, '')
      const slept = await agentHoldWait({
        eventsLog: ownLog,
        failureType,
        holdStarted: startedEpoch - elapsed,
        resetsAt,
        env,
        now: () => new Date(startedEpoch * 1000),
        sleep: async () => {},
      })
      const label = `${failureType} ${elapsed} ${resetsAt} ${JSON.stringify(extra)}`
      assert.equal(slept === null ? '1' : '0', status, label)
      assert.equal(`${slept ?? ''}\n${readFileSync(ownLog, 'utf8')}`, rest.join('\n'), label)
    }
  })

  test('agent_session_transcript_count', () => {
    const config = join(work, 'paridad-config')
    const home = join(work, 'paridad-home')
    const probe = join(work, 'paridad.worktree')
    const link = join(work, 'paridad-enlace')
    const plainFile = logFile('paridad-archivo.txt', '')
    mkdirSync(probe)
    symlinkSync(probe, link)
    const slug = transcriptStoreSlug(realpathSync.native(probe))
    const environments = [{ CLAUDE_CONFIG_DIR: config, HOME: home }, { HOME: home }, { CLAUDE_CONFIG_DIR: '', HOME: home }]
    const compare = (stage: string): void => {
      for (const extra of environments) {
        const env = { PATH: process.env.PATH ?? '', ...extra }
        const dirs = [probe, link, `${probe}/`, plainFile, join(work, 'no-existe'), '']
        const fromBash = bashLibrary('for dir in "$@"; do agent_session_transcript_count "$dir" || echo fallo; done', dirs, { env })
        assert.equal(
          dirs.map((dir) => `${agentSessionTranscriptCount(dir, { env, home })}\n`).join(''),
          fromBash.stdout,
          `${stage} ${JSON.stringify(extra)}`,
        )
      }
    }
    compare('sin store')
    for (const [root, names] of [
      [config, ['aaa.jsonl', 'bbb.jsonl', '.oculto.jsonl', 'notas.txt']],
      [join(home, '.claude'), ['unica.jsonl', 'x.jsonl.bak']],
    ] as const) {
      const store = join(root, 'projects', slug)
      mkdirSync(store, { recursive: true })
      for (const name of names) writeFileSync(join(store, name), '')
      mkdirSync(join(store, 'carpeta.jsonl'))
    }
    compare('con store')
    assert.equal(agentSessionTranscriptCount(probe, { env: { CLAUDE_CONFIG_DIR: config } }), 3)
  })

  test('agent_resume_prompt', () => {
    for (const [stage, agent] of [
      ['2', 'reviewer'],
      ['merge', 'implementer'],
      ['2b', 'smoke-test-writer'],
      ['$HOME', 'a b`c`'],
      ['', ''],
    ] as const) {
      const fromBash = bashLibrary('agent_resume_prompt "$1" "$2"', [stage, agent])
      assert.equal(fromBash.status, 0)
      assert.equal(agentResumePrompt(stage, agent), fromBash.stdout, `${stage} ${agent}`)
    }
  })

  test('_pc_epoch_at', () => {
    const cases: [date: string, time: string][] = [
      ['2026-06-15', '12:00:00'],
      ['2026-01-01', '00:00:00'],
      ['2026-12-31', '23:59:59'],
      ['2024-02-29', '06:30:15'],
      ['1999-07-04', '18:45:09'],
      ['2026-13-01', '10:00:00'],
      ['2026-06-32', '10:00:00'],
      ['2026-06-15', '24:00:00'],
      ['2026-06-15', '12:60:00'],
      ['junio', '12:00:00'],
      ['2026-06-15', 'mediodia'],
    ]
    const script = 'while [ "$#" -gt 0 ]; do epoch=$(_pc_epoch_at "$1" "$2"); printf "%s %s\\n" "$?" "$epoch"; shift 2; done'
    assert.deepEqual(
      cases.map(([date, time]) => {
        const epoch = localEpochAt(date, time)
        return epoch === null ? '1 ' : `0 ${epoch}`
      }),
      chomp(bashLibrary(script, cases.flat()).stdout).split('\n'),
    )
    assert.equal(localEpochAt('2026-06-15', '12:00:00'), NOW_EPOCH)
  })

  test('format_hold_status', () => {
    const now = new Date()
    const at = (deltaSeconds: number): string => clockTime(new Date(now.getTime() + deltaSeconds * 1000))
    const logs = [
      logFile('p-activa.log', `=== SESSION TOOLING 20260101-000000 issue:42 from-stage:1 ===\n${announce(at(-180), at(600))}\n`),
      logFile('p-pasada.log', `${announce(at(-900), at(-600), 'PROVIDER_UNAVAILABLE')}\n`),
      logFile('p-varias.log', `${announce(at(-900), at(-600))}\n${announce(at(-180), at(600), 'PROVIDER_UNAVAILABLE')}\n`),
      logFile('p-otro-dia.log', `${announce(at(7200), at(7500))}\n`),
      logFile('p-reanudacion.log', `[${at(-60)}][hold][resume] writer: reintento desde cero (sin -c)\n`),
      logFile('p-sin-salto-final.log', announce(at(-180), at(600))),
      logFile('p-vacio.log', ''),
      join(work, 'p-no-existe.log'),
    ]
    const cases = logs.flatMap((log, index) => (index === 0 ? [0, 1, 2] : [0]).map((fromLine): [string, number] => [log, fromLine]))
    const script = 'while [ "$#" -gt 0 ]; do status=$(format_hold_status "$1" "$2"); printf "%s %s\\n" "$?" "$status"; shift 2; done'
    assert.deepEqual(
      cases.map(([log, fromLine]) => {
        const status = formatHoldStatus(log, now, fromLine)
        return status === null ? '1 ' : `0 ${status}`
      }),
      chomp(bashLibrary(script, cases.flat().map(String)).stdout).split('\n'),
    )
    assert.equal(formatHoldStatus(logs[0] ?? '', now), `RATE_LIMIT: esperando, proxima sonda ${at(600)} (techo 23:59)`)
  })

  test('fmt_hold_duration y hold_note_suffix', () => {
    const durations = [0, 1, 59, 60, 61, 130, 3599, 3600, 21_600, 86_399, -1, -130]
    const script = 'for seconds in "$@"; do printf "%s|%s|" "$(fmt_hold_duration "$seconds")" "$(hold_note_suffix "$seconds")"; hold_note_suffix "$seconds" >/dev/null; printf "%s\\n" "$?"; done'
    assert.deepEqual(
      durations.map((seconds) => `${fmtHoldDuration(seconds)}|${holdNoteSuffix(seconds)}|0`),
      chomp(bashLibrary(script, durations.map(String)).stdout).split('\n'),
    )
  })

  test('hold_seconds_in_range', () => {
    const now = new Date()
    const logs = [
      logFile('p-range.log', RANGE_LOG),
      logFile('p-edge.log', EDGE_LOG),
      logFile('p-edge-con-salto.log', `${EDGE_LOG}\n`),
      logFile('p-range-vacio.log', ''),
      join(work, 'p-range-no-existe.log'),
      work,
    ]
    const ranges: [fromLine: number, issue: string][] = [
      ...['', '41', '42', '43', '7', '8', '70', 'file', '4'].map((issue): [number, string] => [0, issue]),
      [2, ''],
      [2, '41'],
      [5, ''],
      [5, '70'],
      [99, ''],
    ]
    // Solo los tres primeros tienen anuncios; cada uno le cuesta a bash varios procesos.
    const cases = logs.flatMap((log, index) =>
      (index < 3 ? ranges : ranges.slice(0, 2)).map(([fromLine, issue]): [string, number, string] => [log, fromLine, issue]),
    )
    const script = 'while [ "$#" -gt 0 ]; do hold_seconds_in_range "$1" "$2" "$3" || echo fallo; shift 3; done'
    assert.deepEqual(
      cases.map(([log, fromLine, issue]) => String(holdSecondsInRange(log, now, fromLine, issue))),
      chomp(bashLibrary(script, cases.flat().map(String)).stdout).split('\n'),
    )
    assert.equal(holdSecondsInRange(logs[0] ?? '', now), 1500)
    assert.equal(existsSync(join(work, 'p-range-no-existe.log')), false)
  })
})
