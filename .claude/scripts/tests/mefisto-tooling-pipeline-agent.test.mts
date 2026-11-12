// Invocacion de un agente del pipeline interno de tooling: reintento corto ante el proveedor
// caido, espera (hold) con techo propio, reanudacion de la sesion truncada y sus tres
// degradaciones, y el anuncio del modelo. Con un runner doble que deja el JSONL de cada intento.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../../../scripts/lib/cli.mts'
import type { LaunchRunner } from '../../../scripts/lib/pipeline/pipeline-agent-run.mts'
import { PipelineAbort } from '../../../scripts/lib/pipeline/pipeline-exit.mts'
import { createPipelineLog, stripAnsi } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import { effectiveModel, runToolingAgent } from '../../../src/internal/scripts/lib/mefisto-tooling-agent.mts'
import type { ToolingAgentContext } from '../../../src/internal/scripts/lib/mefisto-tooling-agent.mts'
import { REPO_ROOT } from './mefisto-tooling-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto tooling agent ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

const git = (cwd: string, ...args: string[]): string => capture('git', args, { cwd }).stdout.replace(/\n+$/, '')

function terminal(fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    v: 1,
    type: 'run.failed',
    ts: '2026-08-05T10:00:00Z',
    status: 'failed',
    runtime: 'guion',
    model: null,
    session_id: null,
    duration_ms: 100,
    tokens: { input: null, output: null },
    turns: null,
    denials: null,
    ttft_ms: null,
    api_duration_ms: null,
    error: null,
    ...fields,
  })}\n`
}

const OK = terminal({ type: 'run.completed', status: 'success', model: 'modelo-efectivo', session_id: 'sess-final' })
const PROVIDER_DOWN = terminal({ error: { kind: 'provider_unavailable', detail: 'API Error: 529 Overloaded' } })
const CLIENT_ERROR = terminal({ error: { kind: 'api_error', detail: 'API Error: 400 Bad Request' } })
const PLAIN_ERROR = terminal({ error: { kind: 'nonzero_exit', detail: 'stop_reason=?' } })
const rateLimit = (session: string | null, resetsAt: string | null = null): string =>
  terminal({ session_id: session, error: { kind: 'rate_limit', detail: '429' }, resets_at: resetsAt })

interface Attempt {
  events: string
  exit: number
  /** Trabajo que el intento deja en el worktree. */
  files?: Record<string, string>
  /** Segundos de reloj que consume el intento. */
  seconds?: number
}

interface Harness {
  ctx: ToolingAgentContext
  worktree: string
  calls: string[][]
  prompts: string[]
  out: () => string
  events: () => string
  slept: number[]
  aborts: string[]
}

const argOf = (args: string[], name: string): string => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? '') : '')

/** Worktree recien commiteado y un runner que reproduce `attempts`; agotados, termina bien. */
function harness(attempts: Attempt[], options: { env?: NodeJS.ProcessEnv; supportsResume?: boolean; model?: string; dirty?: boolean } = {}): Harness {
  const dir = join(work, `caso-${++counter}`)
  const worktree = join(dir, 'wt')
  mkdirSync(worktree, { recursive: true })
  git(worktree, 'init', '-q')
  git(worktree, 'config', 'user.email', 't@t.t')
  git(worktree, 'config', 'user.name', 't')
  writeFileSync(join(worktree, 'base.txt'), 'base\n')
  writeFileSync(join(worktree, '.gitignore'), '.mefisto/\n')
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'base')
  if (options.dirty === true) writeFileSync(join(worktree, 'previo.txt'), 'trabajo del writer sin commitear\n')
  const pipelineDir = join(dir, 'pipeline')
  const logDir = join(pipelineDir, 'logs')
  mkdirSync(join(pipelineDir, 'metrics'), { recursive: true })
  mkdirSync(logDir, { recursive: true })
  const eventsLog = join(pipelineDir, 'events.log')
  writeFileSync(eventsLog, '')

  let skewMs = 0
  const now = (): Date => new Date(Date.now() + skewMs)
  const slept: number[] = []
  const calls: string[][] = []
  const prompts: string[] = []
  const aborts: string[] = []
  let out = ''
  const launchRunner: LaunchRunner = (args, outputFile) => {
    calls.push(args)
    prompts.push(readFileSync(argOf(args, '--prompt-file'), 'utf8'))
    const attempt = attempts[calls.length - 1] ?? { events: OK, exit: 0 }
    for (const [rel, content] of Object.entries(attempt.files ?? {})) {
      mkdirSync(join(worktree, rel, '..'), { recursive: true })
      writeFileSync(join(worktree, rel), content)
    }
    writeFileSync(argOf(args, '--event-log'), attempt.events)
    writeFileSync(outputFile, 'salida del runner\n', { flag: 'a' })
    skewMs += (attempt.seconds ?? 0) * 1000
    return Promise.resolve(attempt.exit)
  }
  const log = createPipelineLog({
    logFile: () => join(logDir, 'pipeline.log'),
    out: (text) => {
      out += text
    },
    now,
  })
  const ctx: ToolingAgentContext = {
    runtime: 'guion',
    worktree,
    snapshot: 'HEAD',
    logDir,
    pipelineDir,
    eventsLog,
    timestamp: 'testts',
    issueLogTag: '999',
    systemFile: join(REPO_ROOT, 'src', 'internal', 'prompts', 'noninteractive-system.md'),
    timeout: '1800',
    model: () => options.model ?? '',
    effort: () => '',
    env: {
      MEFISTO_AGENT_MAX_ATTEMPTS: '3',
      MEFISTO_AGENT_RETRY_BACKOFF_SECONDS: '0',
      MEFISTO_HOLD_MAX_SECONDS: '0',
      MEFISTO_HOLD_PROBE_SECONDS: '0',
      ...options.env,
    },
    log,
    out: (text) => {
      out += text
    },
    abort: (message) => {
      aborts.push(message)
      throw new PipelineAbort(message)
    },
    onStart: () => {},
    onFailed: () => {},
    launchRunner,
    supportsResume: () => options.supportsResume ?? true,
    run: capture,
    now,
    sleep: (seconds) => {
      slept.push(seconds)
      skewMs += seconds * 1000
      return Promise.resolve()
    },
  }
  return { ctx, worktree, calls, prompts, out: () => stripAnsi(out), events: () => readFileSync(eventsLog, 'utf8'), slept, aborts }
}

async function settle(promise: Promise<unknown>): Promise<'ok' | 'aborted'> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    if (error instanceof PipelineAbort) return 'aborted'
    throw error
  }
}

describe('reintento corto ante el proveedor caido', () => {
  const fails = (events: string, count: number): Attempt[] => Array.from({ length: count }, () => ({ events, exit: 1 }))

  test('5xx transitorio: exito al segundo intento', async () => {
    const h = harness(fails(PROVIDER_DOWN, 1))
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'ok')
    assert.equal(h.calls.length, 2)
    assert.match(h.out(), /\] writer completado en \d+s \(intento 2\/3; \d+s el ultimo\)\n/)
  })

  test('5xx persistente: se detiene en el tope de 3 y aborta', async () => {
    const h = harness(fails(PROVIDER_DOWN, 9))
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'aborted')
    assert.equal(h.calls.length, 3)
    assert.match(h.aborts[0] ?? '', /^writer fallo \(PROVIDER_UNAVAILABLE \(exit 1\)\)\. Log completo: .*mefisto-tooling-stage-1-writer-testts-issue-999\.log$/)
  })

  for (const [name, events] of [
    ['4xx del cliente', CLIENT_ERROR],
    ['error generico del CLI', PLAIN_ERROR],
  ] as const) {
    test(`${name}: no se reintenta`, async () => {
      const h = harness(fails(events, 9))
      assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'aborted')
      assert.equal(h.calls.length, 1)
    })
  }

  test('el worktree que entraba limpio se restaura antes del reintento', async () => {
    const h = harness([{ events: PROVIDER_DOWN, exit: 1, files: { 'basura.txt': 'a medias\n', 'base.txt': 'modificado\n' } }])
    await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.equal(existsSync(join(h.worktree, 'basura.txt')), false)
    assert.equal(readFileSync(join(h.worktree, 'base.txt'), 'utf8'), 'base\n')
    assert.match(h.out(), /\] Worktree restaurado a [0-9a-f]{8} para el reintento\n/)
  })

  test('el trabajo previo sin commitear sobrevive al reintento', async () => {
    const h = harness(fails(PROVIDER_DOWN, 1), { dirty: true })
    await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.equal(existsSync(join(h.worktree, 'previo.txt')), true)
    assert.match(h.out(), /El worktree ya tenia cambios al entrar al stage: NO se restaura/)
  })

  test('cada reintento queda en events.log, con su aviso y la evidencia del intento fallido', async () => {
    const h = harness(fails(PROVIDER_DOWN, 1), { env: { MEFISTO_AGENT_RETRY_BACKOFF_SECONDS: '7' } })
    await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.match(h.events(), /^\[\d\d:\d\d:\d\d\] REINTENTO writer: PROVIDER_UNAVAILABLE \(exit 1\) \(intento 1\/3, espera 7s\)$/m)
    assert.match(h.out(), /^! writer: PROVIDER_UNAVAILABLE \(exit 1\) -- reintentando \(2\/3\) tras 7s$/m)
    assert.deepEqual(h.slept, [7])
    assert.equal(existsSync(join(h.ctx.logDir, 'mefisto-tooling-stage-1-writer-testts-issue-999.attempt-1.events.jsonl')), true)
  })
})

describe('espera (hold) con su propio techo y sondeo', () => {
  const HOLD = { MEFISTO_AGENT_MAX_ATTEMPTS: '1', MEFISTO_HOLD_MAX_SECONDS: '3600', MEFISTO_HOLD_PROBE_SECONDS: '1' }

  test('RATE_LIMIT sin resets_at: sondea cada MEFISTO_HOLD_PROBE_SECONDS y termina bien', async () => {
    const h = harness(
      [
        { events: rateLimit(null), exit: 1 },
        { events: rateLimit(null), exit: 1 },
      ],
      { env: HOLD, supportsResume: false },
    )
    const outcome = await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.equal(h.calls.length, 3)
    assert.deepEqual(h.slept, [1, 1])
    assert.equal(outcome.holdSeconds, 2)
    assert.match(h.events(), /^\[\d\d:\d\d:\d\d\]\[hold\] RATE_LIMIT: esperando, proxima sonda \d\d:\d\d:\d\d \(techo \d\d:\d\d\)$/m)
    assert.doesNotMatch(h.events(), /REINTENTO/, 'el hold no pasa por el reintento corto')
    assert.match(h.out(), /^! writer: RATE_LIMIT \(exit 1\) -- en espera \(hold\), proxima sonda a las \d\d:\d\d:\d\d$/m)
    assert.match(h.out(), /\] writer completado en \d+s \(incluye 0m 2s en espera\/hold\)\n/)
  })

  test('el hold nunca restaura el worktree: el trabajo parcial sobrevive', async () => {
    const h = harness([{ events: rateLimit(null), exit: 1, files: { 'parcial.txt': 'a medias\n' } }], { env: HOLD })
    await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.equal(existsSync(join(h.worktree, 'parcial.txt')), true)
  })

  test('PROVIDER_UNAVAILABLE persistente sigue en hold mas alla de MAX_ATTEMPTS', async () => {
    const h = harness(
      Array.from({ length: 4 }, () => ({ events: PROVIDER_DOWN, exit: 1 })),
      { env: HOLD },
    )
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'ok')
    assert.equal(h.calls.length, 5)
  })

  test('resets_at en el pasado acorta la espera a 1s en vez del sondeo', async () => {
    const h = harness(
      [
        { events: rateLimit(null, '2026-05-07T22:40:00Z'), exit: 1 },
        { events: rateLimit(null, '2026-05-07T22:40:00Z'), exit: 1 },
      ],
      { env: { ...HOLD, MEFISTO_HOLD_PROBE_SECONDS: '999' } },
    )
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'ok')
    assert.deepEqual(h.slept, [1, 1])
  })

  test('resets_at en el futuro espera hasta esa hora mas el margen', async () => {
    const reset = new Date(Date.now() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const h = harness([{ events: rateLimit(null, reset), exit: 1 }], { env: { ...HOLD, MEFISTO_HOLD_PROBE_SECONDS: '5' } })
    await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    const [slept = 0] = h.slept
    assert.ok(slept >= 175 && slept <= 181, `durmio ${slept}s`)
  })

  test('agotado el techo aborta nombrando la espera, el limite y la ultima senal, sin TIMEOUT', async () => {
    const h = harness(
      Array.from({ length: 99 }, () => ({ events: rateLimit(null), exit: 1 })),
      { env: { ...HOLD, MEFISTO_HOLD_MAX_SECONDS: '1' } },
    )
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'aborted')
    assert.match(
      h.aborts[0] ?? '',
      /^writer: techo de espera agotado tras 0m 1s \(limite 1s\) -- ultima senal: RATE_LIMIT \(exit 1\)\. Log completo: .*\.log$/,
    )
    assert.match(h.out(), /\] writer: techo de espera \(hold\) agotado tras 0m 1s -- ultima senal: RATE_LIMIT \(exit 1\)\n/)
    assert.match(h.out(), /\n-- Ultimas lineas del log de writer:\n/)
    assert.doesNotMatch(h.events(), /TIMEOUT/)
  })

  test('el techo se mide en reloj aunque las siestas sumen cero', async () => {
    const h = harness(
      Array.from({ length: 20 }, () => ({ events: rateLimit(null), exit: 1, seconds: 1 })),
      { env: { ...HOLD, MEFISTO_HOLD_MAX_SECONDS: '2', MEFISTO_HOLD_PROBE_SECONDS: '0' } },
    )
    await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt'))
    assert.ok(h.calls.length <= 6, `${h.calls.length} invocaciones`)
  })

  test('sin presupuesto de espera, un 5xx agotado aborta con el mensaje generico', async () => {
    const h = harness(Array.from({ length: 9 }, () => ({ events: PROVIDER_DOWN, exit: 1 })))
    await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt'))
    assert.match(h.aborts[0] ?? '', /^writer fallo \(PROVIDER_UNAVAILABLE/)
  })
})

describe('reanudacion de la sesion truncada', () => {
  const HOLD = { MEFISTO_AGENT_MAX_ATTEMPTS: '1', MEFISTO_HOLD_MAX_SECONDS: '3600', MEFISTO_HOLD_PROBE_SECONDS: '1' }

  test('tras la espera reanuda la sesion muerta con el mensaje corto de continuacion', async () => {
    const h = harness([{ events: rateLimit('sess-b1'), exit: 1 }], { env: HOLD })
    const outcome = await runToolingAgent(h.ctx, '1', 'writer', 'prompt original completo del stage 1')
    assert.equal(h.calls.length, 2)
    assert.equal(argOf(h.calls[1] ?? [], '--resume-session'), 'sess-b1')
    assert.equal(argOf(h.calls[0] ?? [], '--resume-session'), '')
    const resumeFile = argOf(h.calls[1] ?? [], '--prompt-file')
    assert.match(resumeFile, /mefisto-tooling-stage-1-writer-testts-issue-999\.resume-prompt\.md$/)
    assert.notEqual(resumeFile, argOf(h.calls[0] ?? [], '--prompt-file'))
    assert.doesNotMatch(h.prompts[1] ?? '', /prompt original completo/)
    assert.match(h.prompts[1] ?? '', /^Tu sesion anterior en este mismo stage \(stage 1, agente writer\)/)
    assert.match(h.events(), /\]\[hold\]\[resume\] writer: reanudando sesion sess-b1$/m)
    assert.match(h.events(), /\]\[hold\]\[resume\] writer: stage completado tras reanudar sesion$/m)
    assert.equal(outcome.resumed, true)
    assert.match(h.out(), /writer: la corrida reanudo al menos una sesion truncada por espera \(hold, issue #968\)/)
  })

  test('caso (a): sin session_id en el terminal reintenta sin reanudar', async () => {
    const h = harness([{ events: rateLimit(null), exit: 1 }], { env: HOLD })
    const outcome = await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.equal(argOf(h.calls[1] ?? [], '--resume-session'), '')
    assert.match(h.events(), /\]\[hold\]\[resume\] writer: sin session_id en el terminal -- reintento sin reanudar \(CA-4a\)$/m)
    assert.equal(outcome.resumed, false)
  })

  test('caso (b): runtime sin soporte de reanudacion reintenta sin reanudar', async () => {
    const h = harness([{ events: rateLimit('sess-d1'), exit: 1 }], { env: HOLD, supportsResume: false })
    await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.equal(argOf(h.calls[1] ?? [], '--resume-session'), '')
    assert.match(h.events(), /\]\[hold\]\[resume\] writer: runtime 'guion' sin soporte de reanudacion -- reintento sin reanudar \(CA-4b\)$/m)
  })

  test('caso (c): la sesion reanudada muere sin resumen y degrada para siempre', async () => {
    const h = harness(
      [
        { events: rateLimit('sess-e1'), exit: 1 },
        { events: rateLimit('sess-e2'), exit: 1 },
      ],
      { env: HOLD },
    )
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'ok')
    assert.equal(h.calls.length, 3)
    assert.equal(argOf(h.calls[1] ?? [], '--resume-session'), 'sess-e1')
    assert.equal(argOf(h.calls[2] ?? [], '--resume-session'), '')
    assert.match(h.events(), /writer: sesion sess-e1 murio de nuevo sin resumen -- degradado a stage desde cero \(CA-4c\)$/m)
  })

  test('con el resumen ya escrito, la sesion reanudada que vuelve a caer se sigue reanudando', async () => {
    const h = harness(
      [
        { events: rateLimit('sess-r1'), exit: 1 },
        { events: rateLimit('sess-r2'), exit: 1, files: { '.mefisto/pipeline/summaries/stage-1-writer.md': 'resumen\n' } },
      ],
      { env: HOLD },
    )
    await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    assert.equal(argOf(h.calls[2] ?? [], '--resume-session'), 'sess-r1')
  })

  test('agotado el techo, la reanudacion no relaja el aborto', async () => {
    const h = harness(
      Array.from({ length: 99 }, () => ({ events: rateLimit('sess-f1'), exit: 1 })),
      { env: { ...HOLD, MEFISTO_HOLD_MAX_SECONDS: '1' } },
    )
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'aborted')
    assert.match(h.aborts[0] ?? '', /techo de espera agotado/)
  })
})

describe('trabajo confiable de un agente que falla', () => {
  test('un fallo con resumen y cambios sigue adelante', async () => {
    const h = harness([
      { events: PLAIN_ERROR, exit: 3, files: { 'nuevo.txt': 'x\n', '.mefisto/pipeline/summaries/stage-1-writer.md': 'resumen\n' } },
    ])
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'ok')
    assert.match(h.out(), /^! writer: CLI retorno error \(CLI_ERROR \(exit 3\)\) pero hay trabajo util -- continuando$/m)
    assert.match(h.events(), /\] RECUPERADO writer: trabajo util detectado$/m)
  })

  test('un timeout nunca se rescata, aunque deje trabajo y resumen', async () => {
    const h = harness([
      { events: PLAIN_ERROR, exit: 124, files: { 'nuevo.txt': 'x\n', '.mefisto/pipeline/summaries/stage-1-writer.md': 'resumen\n' } },
    ])
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'aborted')
    assert.match(h.aborts[0] ?? '', /^writer fallo \(TIMEOUT \(\d+s, exit 124\)\)/)
  })

  test('sin resumen el trabajo no es confiable', async () => {
    const h = harness([{ events: PLAIN_ERROR, exit: 3, files: { 'nuevo.txt': 'x\n' } }])
    assert.equal(await settle(runToolingAgent(h.ctx, '1', 'writer', 'prompt')), 'aborted')
  })
})

describe('frontera con el runner neutral', () => {
  test('argv exacto del runner, sin modelo ni effort si se heredan', async () => {
    const h = harness([])
    await runToolingAgent(h.ctx, '2', 'reviewer', 'prompt')
    const logBase = join(h.ctx.logDir, 'mefisto-tooling-stage-2-reviewer-testts-issue-999')
    assert.deepEqual(h.calls[0], [
      '--runtime',
      'guion',
      '--agent',
      'mefisto-reviewer',
      '--cwd',
      h.worktree,
      '--prompt-file',
      join(h.ctx.pipelineDir, 'prompts', 'mefisto-tooling-stage-2-reviewer-testts-issue-999.prompt.md'),
      '--system-file',
      h.ctx.systemFile,
      '--event-log',
      `${logBase}.events.jsonl`,
      '--raw-log',
      `${logBase}.stream.jsonl`,
      '--stderr-log',
      `${logBase}.stderr.log`,
      '--events-log',
      h.ctx.eventsLog,
      '--timeout',
      '1800',
    ])
    assert.equal(h.prompts[0], 'prompt')
    assert.match(h.events(), /^\[\d\d:\d\d:\d\d\] === MEFISTO-TOOLING STAGE 2: reviewer ===$/m)
  })

  test('el stage merge corre como writer, con su modelo y su effort', async () => {
    const h = harness([])
    h.ctx.model = (role) => (role === 'writer' ? 'modelo-w' : 'modelo-r')
    h.ctx.effort = (role) => (role === 'writer' ? 'esfuerzo-w' : 'esfuerzo-r')
    await runToolingAgent(h.ctx, 'merge', 'writer', 'prompt')
    assert.equal(argOf(h.calls[0] ?? [], '--agent'), 'mefisto-writer')
    assert.equal(argOf(h.calls[0] ?? [], '--model'), 'modelo-w')
    assert.equal(argOf(h.calls[0] ?? [], '--effort'), 'esfuerzo-w')
  })

  test('las metricas de cada intento quedan en metrics/ y el log legible se deriva del JSONL', async () => {
    const h = harness([])
    const outcome = await runToolingAgent(h.ctx, '1', 'writer', 'prompt')
    const metrics = readFileSync(join(h.ctx.pipelineDir, 'metrics', 'mefisto-tooling-testts-issue-999-stage-1-writer.json'), 'utf8')
    assert.equal(metrics, `${outcome.metrics}\n`)
    assert.equal((JSON.parse(metrics) as Record<string, unknown>).status, 'success')
    assert.equal(readFileSync(join(h.ctx.logDir, 'mefisto-tooling-stage-1-writer-testts-issue-999.runner.log'), 'utf8'), 'salida del runner\n')
  })
})

describe('anuncio del modelo', () => {
  test('la invocacion muestra el modelo concreto o <heredado>', async () => {
    const declared = harness([], { model: 'vendor/model-v2' })
    await runToolingAgent(declared.ctx, '1', 'writer', 'prompt')
    assert.match(declared.out(), /\] Invocando writer \(modelo: vendor\/model-v2\)\.\.\.\n/)
    assert.equal(argOf(declared.calls[0] ?? [], '--model'), 'vendor/model-v2')
    assert.doesNotMatch(declared.out(), /\(efectivo\)/, 'un modelo declarado no anuncia el efectivo')

    const inherited = harness([])
    await runToolingAgent(inherited.ctx, '2', 'reviewer', 'prompt')
    assert.match(inherited.out(), /\] Invocando reviewer \(modelo: <heredado>\)\.\.\.\n/)
    assert.match(inherited.out(), /\] MODELS: stage 2\/reviewer -> modelo-efectivo \(efectivo\)\n/)
    assert.equal(inherited.calls[0]?.includes('--model'), false)
  })

  test('el modelo efectivo sale de las metricas; nulo o ausente no se anuncia', () => {
    assert.equal(effectiveModel('{"model":"runtime/model-effective"}'), 'runtime/model-effective')
    assert.equal(effectiveModel('{"model":null}'), '')
    assert.equal(effectiveModel('null'), '')
    assert.equal(effectiveModel('roto'), '')
  })
})

describe('cableado en el modulo', () => {
  const source = readFileSync(join(REPO_ROOT, 'src', 'internal', 'scripts', 'lib', 'mefisto-tooling-agent.mts'), 'utf8')

  test('la recuperacion pasa por las funciones de la politica, no por copias inline', () => {
    assert.ok(source.includes('agentWorkIsTrustworthy('))
    assert.ok(source.includes('agentFailureIsUnrecoverable('))
    assert.ok(source.includes('classifyAgentFailure('))
    assert.ok(source.includes('agentFailureIsUnrecoverable(timedOut, runExit, eventsFile)'))
    assert.ok(source.includes('classifyAgentFailure(timedOut, runExit, elapsed, eventsFile)'))
    assert.doesNotMatch(source, /Connection closed mid-response/)
    assert.doesNotMatch(source, /kill\(/)
    assert.doesNotMatch(source, /`TIMEOUT \(/, 'la etiqueta TIMEOUT la arma la clasificacion, con el codigo de salida')
  })

  test('las metricas se derivan del JSONL neutral del intento, no de la traza cruda', () => {
    assert.ok(source.includes('computeStageMetrics(eventsFile)'))
    assert.doesNotMatch(source, /computeStageMetrics\(streamFile\)/)
  })
})
