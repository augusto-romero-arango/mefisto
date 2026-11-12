// Invocacion del implementer en `pr-sync`: argumentos del runner neutral, exito segun codigo y
// terminal, y politica de espera (hold) con reanudacion de sesion (MEF-ADR-0051).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { LaunchRunner } from '../lib/pipeline/pipeline-agent-run.mts'
import { createPipelineLog, stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { noHold } from '../lib/pipeline/pipeline-status.mts'
import type { HoldState } from '../lib/pipeline/pipeline-status.mts'
import { PR_SYNC_GLYPHS, PR_SYNC_RESUME_PROMPT, runPrSyncAgent, writePrStatusFile } from '../pr-sync.mts'
import type { PrSyncAgentContext } from '../pr-sync.mts'
import { fakeClock } from './tooling-pipeline-sandbox.mts'

let work = ''
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto pr-sync agente ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

const argOf = (args: string[], name: string): string => args[args.indexOf(name) + 1] ?? ''

interface Behavior {
  exit: number
  /** `success`, un `error.kind` de `run.failed`, o `none` para un JSONL sin terminal. */
  terminal: string
  session?: string
}

interface Harness {
  ctx: PrSyncAgentContext
  dir: string
  worktree: string
  calls: string[][]
  /** Prompt que leyo cada invocacion. */
  prompts: string[]
  out: () => string
  holds: HoldState[]
  statuses: string[]
  slept: number[]
}

/** Runner que, en cada invocacion, deja el terminal que dicta `behaviors` y sale con su codigo. */
function scriptedRunner(behaviors: Behavior[], calls: string[][], prompts: string[]): LaunchRunner {
  return (args, outputFile) => {
    calls.push(args)
    prompts.push(readFileSync(argOf(args, '--prompt-file'), 'utf8'))
    const behavior = behaviors[calls.length - 1] ?? { exit: 0, terminal: 'success' }
    const terminal =
      behavior.terminal === 'success'
        ? { type: 'run.completed', status: 'success' }
        : { type: 'run.failed', status: 'failure', session_id: behavior.session ?? null, error: { kind: behavior.terminal } }
    writeFileSync(argOf(args, '--event-log'), behavior.terminal === 'none' ? '' : `${JSON.stringify(terminal)}\n`)
    writeFileSync(outputFile, `salida del intento ${calls.length}\n`)
    return Promise.resolve(behavior.exit)
  }
}

function harness(behaviors: Behavior[], overrides: Partial<PrSyncAgentContext> = {}): Harness {
  counter++
  const dir = join(work, `caso-${counter}`)
  const worktree = join(dir, 'worktree')
  const tmp = join(dir, 'tmp')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(tmp)
  let out = ''
  const clock = fakeClock()
  const calls: string[][] = []
  const prompts: string[] = []
  const holds: HoldState[] = []
  const statuses: string[] = []
  const ctx: PrSyncAgentContext = {
    runtime: 'fake-runtime',
    model: '',
    effort: '',
    logDir: dir,
    timestamp: 'ts',
    tmpDir: tmp,
    eventsLog: join(dir, 'events.log'),
    log: createPipelineLog({ logFile: () => join(dir, 'log.txt'), out: (text) => (out += text), now: clock.now, glyphs: PR_SYNC_GLYPHS }),
    launchRunner: scriptedRunner(behaviors, calls, prompts),
    supportsResume: () => false,
    setHold: (hold) => void holds.push(hold),
    writeStatus: (state) => void statuses.push(state),
    env: { MEFISTO_HOLD_PROBE_SECONDS: '1' },
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  }
  return { ctx, dir, worktree, calls, prompts, out: () => stripAnsi(out), holds, statuses, slept: clock.slept }
}

describe('runner neutral', () => {
  test('recibe runtime, agente, worktree, prompt, system y JSONL; sin modelo ni effort no los pasa', async () => {
    const h = harness([{ exit: 0, terminal: 'success' }])
    assert.equal(await runPrSyncAgent('merge-pr7', 'implementer', 'prompt de prueba', h.worktree, h.ctx), true)
    const [args = []] = h.calls
    assert.deepEqual(args, [
      '--runtime',
      'fake-runtime',
      '--agent',
      'implementer',
      '--cwd',
      h.worktree,
      '--prompt-file',
      argOf(args, '--prompt-file'),
      '--system-file',
      argOf(args, '--system-file'),
      '--event-log',
      join(h.dir, 'pr-sync-merge-pr7-ts-attempt-1.events.jsonl'),
    ])
    assert.equal(readFileSync(argOf(args, '--prompt-file'), 'utf8'), 'prompt de prueba')
    assert.equal(
      readFileSync(argOf(args, '--system-file'), 'utf8'),
      'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.\n',
    )
    assert.equal(readFileSync(join(h.dir, 'pr-sync-merge-pr7-ts-attempt-1.log'), 'utf8'), 'salida del intento 1\n')
    assert.match(h.out(), /^\[\d\d:\d\d:\d\d\] Invocando implementer \(modelo: <heredado>\)\.\.\.\n\[\d\d:\d\d:\d\d\] implementer completado en 0s\n$/)
  })

  test('modelo y effort resueltos viajan como --model y --effort', async () => {
    const h = harness([{ exit: 0, terminal: 'success' }], { model: 'm-1', effort: 'n-standard' })
    await runPrSyncAgent('fix-pr7', 'implementer', 'p', h.worktree, h.ctx)
    const [args = []] = h.calls
    assert.deepEqual(args.slice(-4), ['--model', 'm-1', '--effort', 'n-standard'])
    assert.match(h.out(), /Invocando implementer \(modelo: m-1\)/)
  })

  const FAILURES: { name: string; behavior: Behavior }[] = [
    { name: 'exit distinto de 0 aunque el JSONL declare exito', behavior: { exit: 1, terminal: 'success' } },
    { name: 'exit 0 con terminal run.failed', behavior: { exit: 0, terminal: 'nonzero_exit' } },
    { name: 'exit 0 sin terminal', behavior: { exit: 0, terminal: 'none' } },
  ]
  for (const { name, behavior } of FAILURES) {
    test(`${name}: falla y muestra la cola de la salida del runner`, async () => {
      const h = harness([behavior])
      assert.equal(await runPrSyncAgent('merge-pr7', 'implementer', 'p', h.worktree, h.ctx), false)
      assert.equal(h.calls.length, 1)
      assert.match(h.out(), /⚠ implementer falló después de 0s\n\n── Últimas líneas del log de implementer:\nsalida del intento 1\n$/)
      assert.equal(readFileSync(join(h.dir, 'log.txt'), 'utf8').includes('Últimas líneas'), false, 'la cola no va al log')
    })
  }
})

describe('espera (hold)', () => {
  test('rate_limit y luego exito: espera, reanuda la sesion y anuncia la espera en events.log', async () => {
    const h = harness(
      [
        { exit: 3, terminal: 'rate_limit', session: 'sess-1' },
        { exit: 0, terminal: 'success' },
      ],
      { supportsResume: () => true },
    )
    assert.equal(await runPrSyncAgent('merge-pr7', 'implementer', 'p', h.worktree, h.ctx), true)
    assert.equal(h.calls.length, 2)
    const second = h.calls[1] ?? []
    assert.equal(argOf(second, '--resume-session'), 'sess-1')
    assert.deepEqual(h.prompts, ['p', `${PR_SYNC_RESUME_PROMPT}\n`])
    assert.equal(existsSync(argOf(second, '--prompt-file')), false, 'el prompt de la sonda se borra al volver el runner')
    assert.match(readFileSync(h.ctx.eventsLog, 'utf8'), /\[hold\] RATE_LIMIT: esperando/)
    assert.deepEqual(h.slept, [1])
    assert.match(
      h.out(),
      /⚠ implementer: RATE_LIMIT\. Esperando \(hold\) antes de reintentar \(MEF-ADR-0051\)\.\.\.\n\[.*\] implementer: espera de 1s cumplida, reintentando\.\.\.\n\[.*\] Invocando implementer/,
    )
    assert.deepEqual(h.statuses, ['hold', 'running'])
  })

  test('el estado de hold se publica durante la espera y se limpia al volver, con lo acumulado', async () => {
    const h = harness(
      [
        { exit: 3, terminal: 'rate_limit', session: 'sess-1' },
        { exit: 0, terminal: 'success' },
      ],
      { supportsResume: () => true },
    )
    const statusFile = join(h.dir, 'pipeline-status-pr-sync-777.json')
    let hold: HoldState = noHold()
    let snapshot = ''
    const clock = fakeClock()
    const write = (state: string): void =>
      writePrStatusFile(statusFile, { pr: '777', title: 'Titulo de prueba', runtime: 'fake-runtime', stage: 'merge-pr777', state, log: 'log', lastError: '', hold }, clock.now())
    h.ctx.setHold = (next) => {
      hold = next
    }
    h.ctx.writeStatus = write
    h.ctx.sleep = async (seconds) => {
      snapshot = readFileSync(statusFile, 'utf8')
      await clock.sleep(seconds)
    }
    h.ctx.now = clock.now
    assert.equal(await runPrSyncAgent('merge-pr777', 'implementer', 'p', h.worktree, h.ctx), true)
    const during = JSON.parse(snapshot) as { state: string; hold: Record<string, unknown> }
    assert.equal(during.state, 'hold')
    assert.equal(during.hold.cause, 'RATE_LIMIT')
    assert.match(String(during.hold.next_probe), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    assert.equal(during.hold.ceiling_seconds, 21600)
    assert.equal(during.hold.accumulated_seconds, 0)
    write('completed')
    const final = JSON.parse(readFileSync(statusFile, 'utf8')) as { hold: Record<string, unknown> }
    assert.equal(final.hold.cause, null)
    assert.equal(final.hold.next_probe, null)
    assert.equal(final.hold.accumulated_seconds, 1)
  })

  test('rate_limit persistente agota el techo de espera y falla', async () => {
    const h = harness(
      [
        { exit: 3, terminal: 'rate_limit' },
        { exit: 3, terminal: 'rate_limit' },
        { exit: 3, terminal: 'rate_limit' },
      ],
      { env: { MEFISTO_HOLD_PROBE_SECONDS: '1', MEFISTO_HOLD_MAX_SECONDS: '1' } },
    )
    assert.equal(await runPrSyncAgent('merge-pr7', 'implementer', 'p', h.worktree, h.ctx), false)
    assert.equal(h.calls.length, 2)
    assert.match(
      h.out(),
      /⚠ implementer: se agotó el techo de espera \(MEFISTO_HOLD_MAX_SECONDS\) tras 0s en el último intento\n\n── Últimas líneas del log de implementer:\nsalida del intento 2\n$/,
    )
    assert.deepEqual(h.holds.at(-1), noHold(1))
  })

  test('stream_cut no amerita espera: una sola invocacion y ninguna linea [hold]', async () => {
    const h = harness([{ exit: 3, terminal: 'stream_cut' }])
    assert.equal(await runPrSyncAgent('merge-pr7', 'implementer', 'p', h.worktree, h.ctx), false)
    assert.equal(h.calls.length, 1)
    assert.equal(existsSync(h.ctx.eventsLog) && readFileSync(h.ctx.eventsLog, 'utf8').includes('[hold]'), false)
    assert.deepEqual(h.statuses, [])
  })

  test('un runtime sin reanudacion reintenta de cero y lo avisa', async () => {
    const h = harness([
      { exit: 3, terminal: 'rate_limit', session: 'sess-1' },
      { exit: 0, terminal: 'success' },
    ])
    assert.equal(await runPrSyncAgent('merge-pr7', 'implementer', 'p', h.worktree, h.ctx), true)
    assert.equal((h.calls[1] ?? []).includes('--resume-session'), false)
    assert.match(h.out(), /⚠ implementer: runtime sin capacidad de reanudación; la sonda inicia de cero\n/)
  })

  test('un terminal sin session_id reintenta de cero y lo avisa', async () => {
    const h = harness([
      { exit: 3, terminal: 'rate_limit' },
      { exit: 0, terminal: 'success' },
    ], { supportsResume: () => true })
    assert.equal(await runPrSyncAgent('merge-pr7', 'implementer', 'p', h.worktree, h.ctx), true)
    assert.equal((h.calls[1] ?? []).includes('--resume-session'), false)
    assert.match(h.out(), /⚠ implementer: terminal sin session_id; la sonda inicia de cero\n/)
  })

  test('cada invocacion parte sin la espera de la anterior', async () => {
    const h = harness([{ exit: 0, terminal: 'success' }])
    await runPrSyncAgent('fix-pr7', 'implementer', 'p', h.worktree, h.ctx)
    assert.deepEqual(h.holds, [noHold(), noHold()])
  })
})

describe('escritura del prompt', () => {
  test('el prompt de cada stage queda en la carpeta temporal de la corrida', async () => {
    const h = harness([{ exit: 0, terminal: 'success' }])
    await runPrSyncAgent('merge-pr7', 'implementer', 'texto', h.worktree, h.ctx)
    assert.equal(argOf(h.calls[0] ?? [], '--prompt-file'), join(h.ctx.tmpDir, 'merge-pr7.prompt.md'))
  })
})
