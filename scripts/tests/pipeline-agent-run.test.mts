import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  NON_INTERACTIVE_SYSTEM_PROMPT,
  resolveRunnerCommand,
  runAgentWithPolicy,
  runnerProcess,
} from '../lib/pipeline/pipeline-agent-run.mts'
import type { AgentRunEvent, AgentRunPolicy, AgentRunRequest } from '../lib/pipeline/pipeline-agent-run.mts'

const work = mkdtempSync(join(tmpdir(), 'mefisto agent run '))
after(() => rmSync(work, { recursive: true, force: true }))

interface Scripted {
  exit?: number
  /** Terminal que el runner deja en el JSONL; sin el, el intento no escribe eventos. */
  terminal?: Record<string, unknown>
  /** Corre mientras el "agente" trabaja. */
  effect?: () => void
}

const SUCCESS = { type: 'run.completed', status: 'success', session_id: null, denials: 0, error: null }
const failed = (kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'run.failed',
  status: 'failed',
  session_id: null,
  denials: 0,
  error: { kind },
  ...extra,
})

let counter = 0

interface Harness {
  dir: string
  request: AgentRunRequest
  calls: string[][]
  prompts: string[]
  events: AgentRunEvent[]
  slept: number[]
  run: (script: Scripted[], policy?: Partial<AgentRunPolicy>, env?: NodeJS.ProcessEnv) => ReturnType<typeof runAgentWithPolicy>
  summary: string
}

function harness(overrides: Partial<AgentRunRequest> = {}): Harness {
  counter++
  const dir = join(work, `caso-${counter}`)
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const summary = join(dir, 'stage-1-writer.md')
  const request: AgentRunRequest = {
    runtime: 'fake',
    agentId: 'tooling-writer',
    worktree: dir,
    prompt: 'prompt de regresion',
    promptFile: join(dir, 'tmp', '1-writer.prompt.md'),
    systemFile: join(dir, 'tmp', '1-writer.system.md'),
    resumePromptFile: (attempt) => join(dir, 'tmp', `1-writer-resume-${attempt}.prompt.md`),
    eventsFile: (attempt) => join(dir, 'logs', `stage-attempt-${attempt}.events.jsonl`),
    stageLog: () => join(dir, 'logs', 'stage.log'),
    runnerOutput: () => join(dir, 'tmp', '1-writer.runner.log'),
    extraArgs: ['--events-log', join(dir, 'events.log'), '--redact-observability', '--timeout', '60'],
    model: '',
    effort: '',
    eventsLog: join(dir, 'events.log'),
    ...overrides,
  }
  const calls: string[][] = []
  const prompts: string[] = []
  const events: AgentRunEvent[] = []
  const slept: number[] = []
  let skew = 0
  const run: Harness['run'] = (script, policy = {}, env = {}) => {
    let index = 0
    return runAgentWithPolicy(
      request,
      { supportsResume: () => true, ...policy },
      {
        launchRunner: (args, outputFile) => {
          calls.push(args)
          prompts.push(readFileSync(args[args.indexOf('--prompt-file') + 1] ?? '', 'utf8'))
          const step = script[index++] ?? {}
          step.effect?.()
          writeFileSync(outputFile, 'salida del runner\n')
          if (step.terminal !== undefined) {
            writeFileSync(args[args.indexOf('--event-log') + 1] ?? '', `${JSON.stringify(step.terminal)}\n`)
          }
          skew += 2000
          return Promise.resolve(step.exit ?? 0)
        },
        onEvent: (event) => void events.push(event),
        env: { MEFISTO_HOLD_PROBE_SECONDS: '30', MEFISTO_HOLD_MAX_SECONDS: '3600', ...env },
        now: () => new Date(Date.UTC(2030, 0, 1, 12, 0, 0) + skew),
        sleep: (seconds) => {
          slept.push(seconds)
          skew += seconds * 1000
          return Promise.resolve()
        },
      },
    )
  }
  return { dir, request, calls, prompts, events, slept, run, summary }
}

const kinds = (events: AgentRunEvent[]): string[] => events.map((event) => event.kind)

describe('resolveRunnerCommand', () => {
  const runtimeDir = join(work, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const runner = join(runtimeDir, 'mefisto-run-agent.mts')

  test('sin el runner de la clausura da el error que aborta al pipeline', () => {
    assert.deepEqual(resolveRunnerCommand({}, runtimeDir), { error: `No es ejecutable el runner neutral: ${runner}`, path: runner })
  })

  test('por defecto lanza con este Node el runner de la clausura', () => {
    writeFileSync(runner, '')
    assert.deepEqual(resolveRunnerCommand({}, runtimeDir), { runner: { command: process.execPath, args: [runner] }, path: runner })
    assert.deepEqual(resolveRunnerCommand({ MEFISTO_RUN_AGENT_BIN: '' }, runtimeDir), {
      runner: { command: process.execPath, args: [runner] },
      path: runner,
    })
  })

  test('MEFISTO_RUN_AGENT_BIN nombra otro runner: un modulo va con Node', () => {
    const other = join(work, 'otro-runner.mts')
    writeFileSync(other, '')
    assert.deepEqual(resolveRunnerCommand({ MEFISTO_RUN_AGENT_BIN: other }, runtimeDir), {
      runner: { command: process.execPath, args: [other] },
      path: other,
    })
  })

  test('un override que no existe no sirve', () => {
    const missing = join(work, 'no-existe')
    assert.deepEqual(resolveRunnerCommand({ MEFISTO_RUN_AGENT_BIN: missing }, runtimeDir), {
      error: `No es ejecutable el runner neutral: ${missing}`,
      path: missing,
    })
  })

  test('un override sin permiso de ejecucion no sirve; con el, se lanza directo', { skip: process.platform === 'win32' }, () => {
    const binary = join(work, 'runner-binario')
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o644 })
    assert.equal('error' in resolveRunnerCommand({ MEFISTO_RUN_AGENT_BIN: binary }, runtimeDir), true)
    const executable = join(work, 'runner-ejecutable')
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 })
    assert.deepEqual(resolveRunnerCommand({ MEFISTO_RUN_AGENT_BIN: executable }, runtimeDir), {
      runner: { command: executable, args: [] },
      path: executable,
    })
  })
})

describe('runnerProcess', () => {
  const script = join(work, 'runner-doble.mjs')
  writeFileSync(
    script,
    [
      "process.stdout.write('argv=' + process.argv.slice(2).join(',') + '\\n')",
      "process.stderr.write('env=' + process.env.MARCA + '\\n')",
      "if (process.argv[2] === 'colgar') setTimeout(() => {}, 60000)",
      "else process.exit(Number(process.argv[2] ?? 0))",
    ].join('\n'),
  )
  const runner = { command: process.execPath, args: [script] }

  test('lanza el runner con sus argumentos, deja su salida en el archivo y devuelve su codigo', async () => {
    const output = join(work, 'runner-salida.log')
    writeFileSync(output, 'contenido anterior\n')
    const seen: (number | undefined | null)[] = []
    const launch = runnerProcess({ runner, env: { ...process.env, MARCA: 'x' }, onChild: (child) => void seen.push(child === null ? null : child.pid) })
    assert.equal(await launch(['7', '--flag'], output), 7)
    assert.equal(readFileSync(output, 'utf8').split('\n').sort().join('|'), '|argv=7,--flag|env=x')
    assert.equal(seen.length, 2)
    assert.equal(typeof seen[0], 'number')
    assert.equal(seen[1], null)
  })

  test('un runner matado por una senal devuelve 128 mas su numero', { skip: process.platform === 'win32' }, async () => {
    const launch = runnerProcess({
      runner,
      env: { ...process.env, MARCA: 'x' },
      onChild: (child) => {
        if (child !== null) setTimeout(() => child.kill('SIGTERM'), 300)
      },
    })
    assert.equal(await launch(['colgar'], join(work, 'runner-senal.log')), 143)
  })

  test('con appendOutput agrega la salida al archivo en vez de reemplazarlo', async () => {
    const output = join(work, 'runner-anexo.log')
    writeFileSync(output, 'intento anterior\n')
    const launch = runnerProcess({ runner, env: { ...process.env, MARCA: 'y' }, appendOutput: true })
    assert.equal(await launch(['0'], output), 0)
    const content = readFileSync(output, 'utf8')
    assert.ok(content.startsWith('intento anterior\n'))
    assert.ok(content.includes('argv=0\n') && content.includes('env=y\n'))
  })

  test('un runner que no arranca devuelve 127', async () => {
    const launch = runnerProcess({ runner: { command: join(work, 'no-existe-binario'), args: [] }, env: process.env })
    assert.equal(await launch([], join(work, 'runner-ausente.log')), 127)
  })

  test('sin poder abrir el archivo de salida devuelve 1 sin lanzar nada', async () => {
    const launch = runnerProcess({ runner, env: process.env, onChild: () => assert.fail('no debio lanzarse') })
    assert.equal(await launch(['0'], join(work, 'no-existe', 'salida.log')), 1)
  })
})

describe('runAgentWithPolicy: una invocacion que termina bien', () => {
  test('deriva el argv exacto del runner y hace una sola invocacion', async () => {
    const h = harness()
    const outcome = await h.run([{ terminal: SUCCESS }])
    assert.deepEqual(h.calls, [
      [
        '--runtime',
        'fake',
        '--agent',
        'tooling-writer',
        '--cwd',
        h.dir,
        '--prompt-file',
        join(h.dir, 'tmp', '1-writer.prompt.md'),
        '--system-file',
        join(h.dir, 'tmp', '1-writer.system.md'),
        '--event-log',
        join(h.dir, 'logs', 'stage-attempt-1.events.jsonl'),
        '--events-log',
        join(h.dir, 'events.log'),
        '--redact-observability',
        '--timeout',
        '60',
      ],
    ])
    assert.deepEqual(h.prompts, ['prompt de regresion'])
    assert.equal(readFileSync(h.request.systemFile, 'utf8'), `${NON_INTERACTIVE_SYSTEM_PROMPT}\n`)
    assert.equal(readFileSync(join(h.dir, 'tmp', '1-writer.runner.log'), 'utf8'), 'salida del runner\n')
    assert.deepEqual(outcome, {
      failureType: '',
      elapsedSeconds: 2,
      attemptSeconds: 2,
      holdSeconds: 0,
      attempts: 1,
      eventsFile: join(h.dir, 'logs', 'stage-attempt-1.events.jsonl'),
      denials: 0,
    })
    assert.deepEqual(h.events, [
      { kind: 'attempt', attempt: 1, eventsFile: join(h.dir, 'logs', 'stage-attempt-1.events.jsonl'), exitCode: 0, elapsedSeconds: 2, attemptSeconds: 2, resumed: false },
    ])
    assert.ok(existsSync(join(h.dir, 'logs', 'stage.log')), 'deriva el log legible del stage')
  })

  test('pasa --model y --effort solo si no estan vacios', async () => {
    const h = harness({ model: 'vendor/model-v2', effort: 'n-light' })
    await h.run([{ terminal: SUCCESS }])
    assert.deepEqual(h.calls[0]?.slice(-4), ['--model', 'vendor/model-v2', '--effort', 'n-light'])
    const bare = harness({ extraArgs: [] })
    await bare.run([{ terminal: SUCCESS }])
    assert.equal(bare.calls[0]?.at(-2), '--event-log')
  })

  test('sin stageLog no deriva log', async () => {
    const h = harness()
    delete h.request.stageLog
    await h.run([{ terminal: SUCCESS }])
    assert.equal(existsSync(join(h.dir, 'logs', 'stage.log')), false)
  })

  test('un exit 0 sin terminal de exito es un fallo', async () => {
    const h = harness()
    const outcome = await h.run([{ exit: 0, terminal: failed('api_error') }])
    assert.equal(outcome.failureType, 'API_ERROR_CLIENT')
    const silent = harness()
    assert.equal((await silent.run([{ exit: 0 }])).failureType, 'CLI_ERROR')
  })
})

describe('runAgentWithPolicy: clasificacion del fallo', () => {
  const CASES: [string, Scripted, string][] = [
    ['el timeout del runner', { exit: 124, terminal: failed('timeout') }, 'TIMEOUT'],
    ['protocolo invalido', { exit: 65 }, 'PROTOCOL_INVALID'],
    ['proceso matado', { exit: 137, terminal: failed('killed') }, 'KILLED'],
    ['stream cortado', { exit: 1, terminal: failed('stream_cut') }, 'STREAM_CUT'],
    ['error de API del cliente', { exit: 1, terminal: failed('api_error') }, 'API_ERROR_CLIENT'],
    ['causa no reconocida', { exit: 3, terminal: failed('nonzero_exit') }, 'CLI_ERROR'],
  ]
  for (const [name, step, expected] of CASES) {
    test(`${name} termina sin espera con ${expected}`, async () => {
      const h = harness()
      const outcome = await h.run([step])
      assert.equal(outcome.failureType, expected)
      assert.equal(outcome.attempts, 1)
      assert.deepEqual(h.slept, [])
      assert.deepEqual(kinds(h.events), ['attempt', 'failure'])
      assert.deepEqual(h.events[1], { kind: 'failure', failureType: expected, elapsedSeconds: 2, attemptSeconds: 2 })
    })
  }
})

describe('runAgentWithPolicy: reintento por denegaciones', () => {
  test('con denegaciones y sin trabajo reintenta una vez desde cero, aunque haya declarado exito', async () => {
    const h = harness()
    const outcome = await h.run([{ terminal: { ...SUCCESS, denials: 2 } }, { terminal: SUCCESS }], { denialRetry: { hasWork: () => false } })
    assert.equal(outcome.failureType, '')
    assert.equal(outcome.attempts, 2)
    assert.deepEqual(kinds(h.events), ['attempt', 'denial-retry', 'attempt'])
    assert.deepEqual(h.events[1], { kind: 'denial-retry', denials: 2 })
    assert.deepEqual(h.prompts, ['prompt de regresion', 'prompt de regresion'])
    assert.equal(h.calls[1]?.includes('--resume-session'), false)
    assert.equal(h.calls[1]?.[h.calls[1].indexOf('--event-log') + 1], join(h.dir, 'logs', 'stage-attempt-2.events.jsonl'))
  })

  test('el reintento es unico: una segunda tanda de denegaciones se juzga como venga', async () => {
    const h = harness()
    const outcome = await h.run(
      [{ terminal: { ...SUCCESS, denials: 2 } }, { terminal: { ...SUCCESS, denials: 5 } }, { terminal: SUCCESS }],
      { denialRetry: { hasWork: () => false } },
    )
    assert.equal(outcome.attempts, 2)
    assert.equal(outcome.denials, 5)
    assert.equal(outcome.failureType, '')
  })

  test('con trabajo hecho no reintenta', async () => {
    const h = harness()
    const outcome = await h.run([{ terminal: { ...SUCCESS, denials: 3 } }], { denialRetry: { hasWork: () => true } })
    assert.equal(outcome.attempts, 1)
    assert.deepEqual(kinds(h.events), ['attempt'])
  })

  test('sin politica de denegaciones no se miran', async () => {
    const h = harness()
    assert.equal((await h.run([{ terminal: { ...SUCCESS, denials: 3 } }])).attempts, 1)
  })

  test('un contador que no es un entero cuenta como cero', async () => {
    const h = harness()
    const outcome = await h.run([{ terminal: { ...SUCCESS, denials: 'muchas' } }], { denialRetry: { hasWork: () => false } })
    assert.equal(outcome.attempts, 1)
    assert.equal(outcome.denials, 0)
  })
})

describe('runAgentWithPolicy: espera y reanudacion', () => {
  test('ante un limite de uso espera la sonda y reanuda la sesion truncada', async () => {
    const h = harness()
    const outcome = await h.run(
      [
        { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-1' }) },
        { terminal: SUCCESS, effect: () => writeFileSync(h.summary, 'resumen\n') },
      ],
      { resumeEvidence: () => existsSync(h.summary) },
    )
    assert.equal(outcome.failureType, '')
    assert.deepEqual(h.slept, [30])
    assert.deepEqual(outcome, {
      failureType: '',
      elapsedSeconds: 34,
      attemptSeconds: 2,
      holdSeconds: 30,
      attempts: 2,
      eventsFile: join(h.dir, 'logs', 'stage-attempt-2.events.jsonl'),
      denials: 0,
    })
    assert.deepEqual(kinds(h.events), ['attempt', 'failure', 'hold', 'hold-waited', 'resume', 'attempt'])
    assert.deepEqual(h.events[2], {
      kind: 'hold',
      hold: { cause: 'RATE_LIMIT', nextProbe: '2030-01-01T12:00:32Z', ceilingSeconds: 3600, accumulatedSeconds: 0 },
    })
    assert.deepEqual(h.events[3], { kind: 'hold-waited', failureType: 'RATE_LIMIT', sleptSeconds: 30, holdSeconds: 30 })
    assert.deepEqual(h.events[4], { kind: 'resume', failureType: 'RATE_LIMIT', sessionId: 'ses-1' })
    assert.deepEqual(h.calls[1]?.slice(-2), ['--resume-session', 'ses-1'])
    assert.equal(h.calls[1]?.[h.calls[1].indexOf('--prompt-file') + 1], join(h.dir, 'tmp', '1-writer-resume-2.prompt.md'))
    assert.deepEqual(h.prompts, ['prompt de regresion', 'Continue the same stage and complete its summary.\n'])
    assert.equal(existsSync(join(h.dir, 'tmp', '1-writer-resume-2.prompt.md')), false, 'el prompt de reanudacion se borra')
    assert.match(readFileSync(h.request.eventsLog, 'utf8'), /^\[\d\d:\d\d:\d\d\]\[hold\] RATE_LIMIT: esperando, proxima sonda \d\d:\d\d:\d\d \(techo \d\d:\d\d\)\n$/)
  })

  test('el texto de la sonda de reanudacion es un parametro', async () => {
    const h = harness({ resumePrompt: 'Continue the same task and complete it.' })
    await h.run([{ exit: 1, terminal: failed('provider_unavailable', { session_id: 's' }) }, { terminal: SUCCESS }])
    assert.equal(h.prompts[1], 'Continue the same task and complete it.\n')
  })

  test('con resets_at espera hasta ese instante mas el margen', async () => {
    const h = harness()
    await h.run([{ exit: 1, terminal: failed('rate_limit', { resets_at: '2030-01-01T12:10:02Z' }) }, { terminal: SUCCESS }])
    assert.deepEqual(h.slept, [660])
  })

  test('una sesion reanudada que termina sin evidencia degrada para siempre a inicio limpio', async () => {
    const h = harness()
    const outcome = await h.run(
      [
        { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-1' }) },
        { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-2' }) },
        { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-3' }) },
        { terminal: SUCCESS },
      ],
      { resumeEvidence: () => false },
    )
    assert.equal(outcome.attempts, 4)
    assert.deepEqual(
      h.calls.map((args) => (args.includes('--resume-session') ? args.at(-1) : null)),
      [null, 'ses-1', null, null],
    )
    assert.deepEqual(h.prompts.slice(2), ['prompt de regresion', 'prompt de regresion'])
    assert.equal(kinds(h.events).filter((kind) => kind === 'resume-degraded').length, 1)
    assert.equal(outcome.holdSeconds, 90)
  })

  test('con evidencia, la sesion reanudada que vuelve a caer se sigue reanudando', async () => {
    const h = harness()
    await h.run(
      [
        { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-1' }) },
        { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-2' }) },
        { terminal: SUCCESS },
      ],
      { resumeEvidence: () => true },
    )
    assert.deepEqual(
      h.calls.map((args) => (args.includes('--resume-session') ? args.at(-1) : null)),
      [null, 'ses-1', 'ses-2'],
    )
  })

  test('sin resumeEvidence nunca se degrada', async () => {
    const h = harness()
    await h.run([
      { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-1' }) },
      { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-2' }) },
      { terminal: SUCCESS },
    ])
    assert.equal(kinds(h.events).includes('resume-degraded'), false)
    assert.deepEqual(h.calls[2]?.slice(-2), ['--resume-session', 'ses-2'])
  })

  test('un terminal sin session_id hace que la sonda arranque de cero', async () => {
    const h = harness()
    await h.run([{ exit: 1, terminal: failed('rate_limit') }, { terminal: SUCCESS }])
    assert.deepEqual(kinds(h.events), ['attempt', 'failure', 'hold', 'hold-waited', 'resume-no-session', 'attempt'])
    assert.equal(h.calls[1]?.includes('--resume-session'), false)
    assert.deepEqual(h.prompts, ['prompt de regresion', 'prompt de regresion'])
  })

  test('un runtime sin reanudacion hace que la sonda arranque de cero', async () => {
    const h = harness()
    await h.run([{ exit: 1, terminal: failed('rate_limit', { session_id: 'ses-1' }) }, { terminal: SUCCESS }], {
      supportsResume: () => Promise.resolve(false),
    })
    assert.ok(kinds(h.events).includes('resume-unsupported'))
    assert.equal(h.calls[1]?.includes('--resume-session'), false)
  })

  test('agotado el techo termina con el ultimo fallo, sin dormir de nuevo', async () => {
    const h = harness()
    const outcome = await h.run(
      [
        { exit: 1, terminal: failed('provider_unavailable') },
        { exit: 1, terminal: failed('provider_unavailable') },
        { exit: 1, terminal: failed('provider_unavailable') },
      ],
      {},
      { MEFISTO_HOLD_PROBE_SECONDS: '40', MEFISTO_HOLD_MAX_SECONDS: '60' },
    )
    assert.equal(outcome.failureType, 'PROVIDER_UNAVAILABLE')
    assert.deepEqual(h.slept, [40, 18], 'la segunda sonda se recorta a lo que queda del techo')
    assert.equal(outcome.attempts, 3)
    assert.equal(h.events.at(-1)?.kind, 'hold-ceiling')
    assert.equal(outcome.holdSeconds, 58)
  })

  test('un fallo no esperable despues de una espera corta la invocacion', async () => {
    const h = harness()
    const outcome = await h.run([{ exit: 1, terminal: failed('rate_limit') }, { exit: 124, terminal: failed('timeout') }])
    assert.equal(outcome.failureType, 'TIMEOUT')
    assert.equal(outcome.holdSeconds, 30)
    assert.deepEqual(h.slept, [30])
  })

  test('las denegaciones tras una espera descartan la sesion a reanudar', async () => {
    const h = harness()
    await h.run(
      [
        { exit: 1, terminal: failed('rate_limit', { session_id: 'ses-1' }) },
        { terminal: { ...SUCCESS, denials: 1 } },
        { terminal: SUCCESS },
      ],
      { denialRetry: { hasWork: () => false } },
    )
    assert.deepEqual(h.calls[1]?.slice(-2), ['--resume-session', 'ses-1'])
    assert.equal(h.calls[2]?.includes('--resume-session'), false)
  })
})
