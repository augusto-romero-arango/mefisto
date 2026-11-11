// Invocacion de agentes desde `tooling-pipeline.mts`: argv del runner, modelos y effort, fallos,
// rescate de trabajo, reintento por denegaciones, espera (hold) y reanudacion de sesion.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { eventsLog, fakeTools, guionCalls, history, newConsumer, readJson, runTooling, runnerDouble } from './tooling-pipeline-sandbox.mts'
import type { Consumer, PipelineRun, RunnerDouble } from './tooling-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto tooling agents ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function consumer(files: Record<string, string> = {}): Consumer {
  counter++
  return newConsumer(join(work, `caso-${counter}`), files)
}

const text = (run: PipelineRun): string => stripAnsi(run.out)
const status = (repo: Consumer): Record<string, unknown> => readJson(join(repo.stateDir, 'pipeline-status-tooling-42.json'))
const argOf = (args: string[] | undefined, name: string): string | undefined =>
  args === undefined || !args.includes(name) ? undefined : args[args.indexOf(name) + 1]

const WRITER: GuionStep = { files: { 'scripts/ci.sh': 'echo ci\n' }, commit: 'agregar script de ci' }
const REVIEWER: GuionStep = { files: { 'docs/ci.md': 'Notas de CI\n' } }
const SUMMARY = '.mefisto/pipeline/summaries/stage-1-writer.md'
const HOLD_ENV = { MEFISTO_HOLD_PROBE_SECONDS: '30', MEFISTO_HOLD_MAX_SECONDS: '3600' }

async function runDouble(
  repo: Consumer,
  steps: GuionStep[],
  options: Parameters<typeof runTooling>[2] = {},
  argv: string[] = ['42'],
): Promise<{ run: PipelineRun; double: RunnerDouble }> {
  const double = runnerDouble(steps)
  const run = await runTooling(repo, argv, { ...options, deps: { launchRunner: double.launch, ...options.deps } })
  return { run, double }
}

describe('frontera con el runner neutral', () => {
  test('pasa al runner el argv exacto: observabilidad redactada, timeout y nada crudo', async () => {
    const repo = consumer()
    const { run, double } = await runDouble(repo, [WRITER, REVIEWER])
    assert.equal(run.code, 0, text(run))
    const [writer = [], reviewer = []] = double.calls
    const stamp = String(history(repo)[0]?.started)
    const worktree = join(repo.stateDir, 'worktrees', 'worktree-issue-42-agregar-workflow-de-ci')
    assert.deepEqual(writer.slice(0, 6), ['--runtime', 'guion', '--agent', 'tooling-writer', '--cwd', worktree])
    assert.match(argOf(writer, '--prompt-file') ?? '', /mefisto-tooling\..*1-writer\.prompt\.md$/)
    assert.match(argOf(writer, '--system-file') ?? '', /mefisto-tooling\..*1-writer\.system\.md$/)
    assert.equal(argOf(writer, '--event-log'), join(repo.stateDir, 'logs', `tooling-stage-1-writer-${stamp}-issue-42-attempt-1.events.jsonl`))
    assert.deepEqual(writer.slice(12), ['--events-log', join(repo.stateDir, 'events.log'), '--redact-observability', '--timeout', '1800'])
    assert.deepEqual(reviewer.slice(2, 4), ['--agent', 'tooling-reviewer'])
    assert.equal(argOf(reviewer, '--event-log'), join(repo.stateDir, 'logs', `tooling-stage-2-reviewer-${stamp}-issue-42-attempt-1.events.jsonl`))
    for (const args of double.calls) {
      for (const absent of ['--raw-log', '--stderr-log', '--model', '--effort', '--resume-session']) assert.equal(args.includes(absent), false, absent)
    }
  })

  test('MEFISTO_AGENT_TIMEOUT_SECONDS fija el timeout de cada agente', async () => {
    const { double } = await runDouble(consumer(), [WRITER, REVIEWER], { env: { MEFISTO_AGENT_TIMEOUT_SECONDS: '90' } })
    assert.deepEqual(
      double.calls.map((args) => argOf(args, '--timeout')),
      ['90', '90'],
    )
  })

  test('los temporales de la corrida (prompts, salida del runner) se borran al terminar', async () => {
    const tempRoot = mkdtempSync(join(work, 'temporales-'))
    const { run, double } = await runDouble(consumer(), [WRITER, REVIEWER], { deps: { tempRoot } })
    assert.equal(run.code, 0)
    assert.equal(argOf(double.calls[0], '--prompt-file')?.startsWith(join(tempRoot, 'mefisto-tooling.')), true)
    assert.equal(existsSync(argOf(double.calls[0], '--prompt-file') ?? ''), false)
  })
})

describe('modelos por stage', () => {
  test('--models asigna el modelo por clave exacta, lo anuncia y lo deja en events.log y en las metricas', async () => {
    const repo = consumer()
    const { run, double } = await runDouble(repo, [WRITER, REVIEWER], {}, ['42', '--models', 'reviewer=modelo profundo,writer=claude-opus-5[1m]'])
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(
      double.calls.map((args) => argOf(args, '--model')),
      ['claude-opus-5[1m]', 'modelo profundo'],
    )
    assert.match(text(run), /\] Modelos por stage \(--models\): reviewer=modelo profundo, writer=claude-opus-5\[1m\]\n/)
    assert.match(text(run), /\] Invocando writer \(modelo: claude-opus-5\[1m\]\)\.\.\.\n/)
    const log = eventsLog(repo)
    assert.match(log, /\] MODELS: reviewer=modelo profundo, writer=claude-opus-5\[1m\]\n/)
    assert.match(log, /\] MODELS: writer runtime=guion perfil=balanced solicitado='claude-opus-5\[1m\]' resuelto='claude-opus-5\[1m\]' \(override --models\)\n/)
    assert.match(log, /\] MODELS: reviewer runtime=guion perfil=deep solicitado='modelo profundo' resuelto='modelo profundo' \(override --models\)\n/)
    const agents = history(repo)[0]?.agents as Record<string, { metrics: Record<string, unknown> }>
    assert.equal(agents.writer?.metrics.requested_model, 'claude-opus-5[1m]')
    assert.equal(agents.writer?.metrics.inherited, false)
  })

  test('un override de un solo rol deja al otro con su resolucion automatica', async () => {
    const repo = consumer()
    const { double } = await runDouble(repo, [WRITER, REVIEWER], { env: { GUION_DEFAULT_MODEL: 'modelo-del-adaptador' } }, ['42', '--models', 'reviewer=otro'])
    assert.deepEqual(
      double.calls.map((args) => argOf(args, '--model')),
      ['modelo-del-adaptador', 'otro'],
    )
    assert.match(eventsLog(repo), /\] MODELS: writer runtime=guion perfil=balanced solicitado=<automatico> resuelto='modelo-del-adaptador'\n/)
  })

  test('el mapping del consumidor (.mefisto/models.json) gana al default del adaptador', async () => {
    const repo = consumer({ '.mefisto/models.json': JSON.stringify({ guion: { agents: { 'tooling-writer': 'modelo-agente' }, profiles: { deep: 'modelo-perfil' } } }) })
    const { double } = await runDouble(repo, [WRITER, REVIEWER], { env: { GUION_DEFAULT_MODEL: 'modelo-del-adaptador' } })
    assert.deepEqual(
      double.calls.map((args) => argOf(args, '--model')),
      ['modelo-agente', 'modelo-perfil'],
    )
  })

  test('un --models malformado aborta antes de crear el worktree, con el fallo ya registrado', async () => {
    for (const [spec, reason] of [
      ['writer', "entrada 'writer' no tiene la forma agente=modelo"],
      ['writer=', "entrada 'writer=': agente y modelo no pueden estar vacios"],
      ['writer=a,writer=b', "el agente 'writer' esta repetido"],
    ] as const) {
      const repo = consumer()
      const { run, double } = await runDouble(repo, [], {}, ['42', '--models', spec])
      assert.equal(run.code, 1)
      assert.ok(text(run).includes(`x ERROR: --models mal formado: ${reason}\n`), text(run))
      assert.deepEqual(double.calls, [])
      assert.deepEqual(run.tools.gh, [])
      assert.equal(existsSync(join(repo.stateDir, 'worktrees')), false)
      assert.equal(status(repo).state, 'failed')
      assert.equal(status(repo).stage, 'setup')
      assert.equal(history(repo)[0]?.error, `--models mal formado: ${reason} `)
    }
  })

  test('un mapping de modelos invalido aborta citando el motivo', async () => {
    const repo = consumer({ '.mefisto/models.json': '{"guion": {"profiles": {"enorme": "x"}}}' })
    const { run } = await runDouble(repo, [])
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: No se pudo resolver el modelo de tooling-writer \(perfil balanced\): .*models\.json: .*enorme/)
  })

  test('el status declara agente, perfil y modelo pedido de cada rol', async () => {
    const repo = consumer()
    await runDouble(repo, [WRITER, { status: 'failed', kind: 'api_error' }], {}, ['42', '--models', 'writer=m-w'])
    const agents = status(repo).agents as Record<string, Record<string, unknown>>
    assert.deepEqual(
      { ...agents.writer, metrics: null, duration: null },
      { agent: 'tooling-writer', profile: 'balanced', requested_model: 'm-w', inherited: false, duration: null, result: 'passed', metrics: null },
    )
    assert.deepEqual(
      { ...agents.reviewer, metrics: null },
      { agent: 'tooling-reviewer', profile: 'deep', requested_model: null, inherited: true, duration: null, result: 'failed', metrics: null },
    )
    assert.equal(typeof agents.writer?.duration, 'number')
  })
})

describe('effort por agente, con el runner real', () => {
  const MAPPING = { guion: { efforts: { levels: { light: 'n-light', standard: 'n-standard', thorough: 'n-thorough' }, agents: { 'tooling-reviewer': 'thorough' } } } }

  test('sin mapping ni default, writer y reviewer no reciben effort', async () => {
    const repo = consumer()
    const run = await runTooling(repo, ['42'], { guion: [WRITER, REVIEWER] })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(
      guionCalls(repo).map((call) => call.effort),
      ['', ''],
    )
  })

  test('con mapping, el writer recibe su nivel de fabrica y el reviewer el que fija efforts.agents', async () => {
    const repo = consumer({ '.mefisto/models.json': JSON.stringify(MAPPING) })
    const run = await runTooling(repo, ['42'], { guion: [WRITER, REVIEWER] })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(
      guionCalls(repo).map((call) => call.effort),
      ['n-light', 'n-thorough'],
    )
    assert.match(eventsLog(repo), /\] EFFORTS: writer -> n-light \(nivel light\)\n/)
    assert.match(eventsLog(repo), /\] EFFORTS: reviewer -> n-thorough \(nivel standard\)\n/)
    const agents = history(repo)[0]?.agents as Record<string, { metrics: Record<string, unknown> }>
    assert.equal(agents.reviewer?.metrics.requested_effort, 'n-thorough')
  })
})

describe('fallo de un agente', () => {
  test('con el runner real: un fallo sin trabajo aborta, marca al agente y deja el fallo en el historial', async () => {
    const repo = consumer()
    const run = await runTooling(repo, ['42'], { guion: [{ status: 'failed', kind: 'api_error' }] })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: writer fallo \(API_ERROR_CLIENT\)\. Log completo: .*tooling-stage-1-writer-\d{8}-\d{6}-issue-42\.log\n/)
    const current = status(repo)
    assert.equal(current.state, 'failed')
    assert.equal(current.stage, '1-writer')
    assert.equal((current.agents as { writer: { result: string } }).writer.result, 'failed')
    assert.match(String(current.last_error), /^writer fallo \(API_ERROR_CLIENT\)\. Log completo: .*\.log $/)
    const [entry = {}] = history(repo)
    assert.deepEqual(Object.keys(entry), ['issue', 'title', 'pipeline', 'variant', 'identity', 'runtime', 'started', 'finished', 'state', 'stage', 'error', 'agents', 'log'])
    assert.equal(entry.state, 'failed')
    assert.equal(entry.stage, '1-writer')
    assert.equal(entry.runtime, 'guion')
    assert.deepEqual(entry.identity, { harness_version: null, harness_commit: null, identity_state: 'metadata_invalid' })
    assert.equal('harness_version' in entry, false)
    assert.equal(entry.log, current.log)
    const agents = entry.agents as Record<string, { metrics: Record<string, unknown> | null }>
    assert.equal(agents.writer?.metrics?.error_kind, 'api_error')
    assert.equal(agents.reviewer?.metrics, null)
    assert.equal(guionCalls(repo).length, 1, 'un fallo que no amerita espera no se reintenta')
  })

  test('con el runner real: un agente que no deja terminal es protocolo invalido y descarta el trabajo parcial', async () => {
    const repo = consumer()
    const run = await runTooling(repo, ['42'], { guion: [{ ...WRITER, silent: true }] })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: writer fallo \(PROTOCOL_INVALID\); se descarta trabajo parcial\n/)
    assert.deepEqual(run.tools.dotnet, [], 'ni siquiera intenta el gate de confianza')
  })

  for (const [kind, exit, label] of [['timeout', 124, 'TIMEOUT'], ['killed', 137, 'KILLED'], ['stream_cut', 1, 'STREAM_CUT']] as const) {
    test(`${label} con trabajo hecho tampoco se rescata`, async () => {
      const { run } = await runDouble(consumer(), [{ ...WRITER, status: 'failed', kind, exit }])
      assert.equal(run.code, 1)
      assert.ok(text(run).includes(`x ERROR: writer fallo (${label}); se descarta trabajo parcial\n`))
      assert.deepEqual(run.tools.dotnet, [])
    })
  }

  test('un fallo ordinario con trabajo que compila se rescata y el pipeline sigue', async () => {
    const repo = consumer()
    const { run } = await runDouble(repo, [{ ...WRITER, status: 'failed', kind: 'nonzero_exit' }, REVIEWER])
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! writer: runner termino con CLI_ERROR, pero el trabajo paso el gate de confianza\n\[.*\] writer completado en \d+s\n/)
    assert.match(eventsLog(repo), /\] RECUPERADO writer: trabajo util detectado\n/)
    assert.equal(run.tools.dotnet[0]?.[0], 'build')
  })

  test('si ese trabajo no compila, el fallo se mantiene', async () => {
    const { run } = await runDouble(consumer(), [{ ...WRITER, status: 'failed', kind: 'nonzero_exit' }], { tools: fakeTools({ buildStatus: 1 }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: writer fallo \(CLI_ERROR\)\. Log completo: /)
  })

  test('un runner que muere sin dejar eventos aborta como error del CLI', async () => {
    const repo = consumer()
    const run = await runTooling(repo, ['42'], { deps: { launchRunner: () => Promise.resolve(69) } })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: writer fallo \(CLI_ERROR\)\. Log completo: /)
    // Sin eventos las metricas del stage no forman un JSON: la entrada de fallo no se puede armar.
    assert.equal(readFileSync(join(repo.stateDir, 'pipeline-history.jsonl'), 'utf8'), '')
  })

  test('un fallo del reviewer aborta en su stage y conserva lo del writer', async () => {
    const repo = consumer()
    const { run } = await runDouble(repo, [WRITER, { status: 'failed', kind: 'api_error' }])
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: reviewer fallo \(API_ERROR_CLIENT\)\. Log completo: .*tooling-stage-2-reviewer-/)
    assert.equal(status(repo).stage, '2-reviewer')
    const agents = history(repo)[0]?.agents as Record<string, { metrics: Record<string, unknown> | null }>
    assert.equal(agents.writer?.metrics?.result, 'success')
    assert.equal(agents.reviewer?.metrics?.result, 'failed')
  })
})

describe('reintento por denegaciones de permisos', () => {
  test('denegaciones sin trabajo: reintenta una vez desde cero aunque el agente declare exito', async () => {
    const repo = consumer()
    const { run, double } = await runDouble(repo, [{ denials: 2 }, WRITER, REVIEWER])
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! writer: 2 denegacion\(es\) neutrales sin trabajo; reintentando una vez desde cero\n/)
    assert.match(eventsLog(repo), /\] RETRY writer: denials=2\n/)
    assert.deepEqual(
      double.calls.map((args) => argOf(args, '--agent')),
      ['tooling-writer', 'tooling-writer', 'tooling-reviewer'],
    )
    assert.equal(double.prompts[0], double.prompts[1])
    assert.match(argOf(double.calls[1], '--event-log') ?? '', /-attempt-2\.events\.jsonl$/)
  })

  test('denegaciones con trabajo hecho no reintentan', async () => {
    const { run, double } = await runDouble(consumer(), [{ ...WRITER, denials: 2 }, REVIEWER])
    assert.equal(run.code, 0)
    assert.equal(double.calls.length, 2)
  })

  test('si el reintento tampoco deja trabajo, aborta por falta de cambios', async () => {
    const { run, double } = await runDouble(consumer(), [{ denials: 2 }, { denials: 2 }])
    assert.equal(run.code, 1)
    assert.equal(double.calls.length, 2)
    assert.match(text(run), /x ERROR: El writer no genero ningun cambio\./)
  })
})

describe('espera (hold) y reanudacion de sesion', () => {
  test('con el runner real: ante un limite de uso espera, reanuda la sesion por su id y termina', async () => {
    const repo = consumer()
    const run = await runTooling(repo, ['42'], {
      env: { ...HOLD_ENV, GUION_RESUME: '1' },
      guion: [{ status: 'failed', kind: 'rate_limit', session: 'ses-1' }, { ...WRITER, files: { ...WRITER.files, [SUMMARY]: 'resumen\n' } }, REVIEWER],
    })
    assert.equal(run.code, 0, text(run))
    const calls = guionCalls(repo)
    assert.deepEqual(
      calls.map((call) => [call.agent, call.resume]),
      [['tooling-writer', ''], ['tooling-writer', 'ses-1'], ['tooling-reviewer', '']],
    )
    assert.equal(calls[1]?.prompt, 'Continue the same stage and complete its summary.\n')
    assert.match(eventsLog(repo), /\[\d\d:\d\d:\d\d\]\[hold\] RATE_LIMIT: esperando, proxima sonda \d\d:\d\d:\d\d \(techo \d\d:\d\d\)\n/)
    const stamp = String(history(repo)[0]?.started)
    for (const attempt of [1, 2]) {
      assert.ok(existsSync(join(repo.stateDir, 'logs', `tooling-stage-1-writer-${stamp}-issue-42-attempt-${attempt}.events.jsonl`)))
    }
    const writer = (history(repo)[0]?.agents as { writer: { duration: number } }).writer
    assert.ok(writer.duration >= 0 && writer.duration < 30, `la espera no cuenta en la duracion (${writer.duration}s)`)
  })

  test('durante la espera el status pasa a hold con la causa, la proxima sonda y el techo', async () => {
    const repo = consumer()
    const seen: Record<string, unknown>[] = []
    const double = runnerDouble([{ status: 'failed', kind: 'provider_unavailable' }, WRITER, REVIEWER])
    const run = await runTooling(repo, ['42'], {
      env: HOLD_ENV,
      deps: {
        launchRunner: double.launch,
        sleep: (seconds) => {
          seen.push({ ...status(repo), slept: seconds })
          return Promise.resolve()
        },
      },
    })
    assert.equal(run.code, 0, text(run))
    const [during = {}] = seen
    assert.equal(during.slept, 30)
    assert.equal(during.state, 'hold')
    assert.equal(during.stage, '1-writer')
    const hold = during.hold as Record<string, unknown>
    assert.equal(hold.cause, 'PROVIDER_UNAVAILABLE')
    assert.match(String(hold.next_probe), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    assert.equal(hold.ceiling_seconds, 3600)
    assert.equal(hold.accumulated_seconds, 0)
    assert.equal((during.agents as { writer: { result: string } }).writer.result, 'running')
  })

  test('tras la espera, el bloque hold vuelve a null y conserva lo acumulado', async () => {
    const repo = consumer()
    const { run } = await runDouble(repo, [{ status: 'failed', kind: 'rate_limit' }, WRITER, { status: 'failed', kind: 'api_error' }], { env: HOLD_ENV })
    assert.equal(run.code, 1)
    assert.deepEqual(status(repo).hold, { cause: null, next_probe: null, ceiling_seconds: null, accumulated_seconds: 30 })
    assert.equal(status(repo).stage, '2-reviewer')
  })

  test('un runtime sin reanudacion repite el stage desde cero', async () => {
    const { run, double } = await runDouble(consumer(), [{ status: 'failed', kind: 'rate_limit', session: 'ses-1' }, WRITER, REVIEWER], { env: HOLD_ENV })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! writer: runtime sin capacidad de reanudacion; la sonda inicia de cero\n/)
    assert.equal(double.calls[1]?.includes('--resume-session'), false)
    assert.equal(double.prompts[1], double.prompts[0])
  })

  test('un terminal sin session_id repite el stage desde cero', async () => {
    const { run, double } = await runDouble(consumer(), [{ status: 'failed', kind: 'rate_limit' }, WRITER, REVIEWER], { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! writer: terminal sin session_id; la sonda inicia de cero\n/)
    assert.equal(double.calls[1]?.includes('--resume-session'), false)
  })

  test('una sesion reanudada que vuelve a caer sin resumen degrada para siempre a inicio limpio', async () => {
    const steps: GuionStep[] = [
      { status: 'failed', kind: 'rate_limit', session: 'ses-1' },
      { status: 'failed', kind: 'rate_limit', session: 'ses-2' },
      { status: 'failed', kind: 'rate_limit', session: 'ses-3' },
      WRITER,
      REVIEWER,
    ]
    const { run, double } = await runDouble(consumer(), steps, { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! writer: la sesion reanudada termino sin resumen; se degrada permanentemente a inicio limpio\n/)
    assert.deepEqual(
      double.calls.map((args) => argOf(args, '--resume-session') ?? null),
      [null, 'ses-1', null, null, null],
    )
  })

  test('con el resumen ya escrito, la sesion reanudada que vuelve a caer se sigue reanudando', async () => {
    const steps: GuionStep[] = [
      { status: 'failed', kind: 'rate_limit', session: 'ses-1' },
      { status: 'failed', kind: 'rate_limit', session: 'ses-2', files: { [SUMMARY]: 'resumen\n' } },
      WRITER,
      REVIEWER,
    ]
    const { double } = await runDouble(consumer(), steps, { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    assert.deepEqual(
      double.calls.map((args) => argOf(args, '--resume-session') ?? null),
      [null, 'ses-1', 'ses-2', null],
    )
  })

  test('agotado el techo de espera aborta con el ultimo fallo y deja la causa en el status', async () => {
    const repo = consumer()
    const steps: GuionStep[] = Array.from({ length: 5 }, () => ({ status: 'failed', kind: 'rate_limit' }))
    const { run, double } = await runDouble(repo, steps, { env: { MEFISTO_HOLD_PROBE_SECONDS: '40', MEFISTO_HOLD_MAX_SECONDS: '60' } })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: writer fallo \(RATE_LIMIT\)\. Log completo: /)
    assert.equal(double.calls.length, 3)
    const current = status(repo)
    assert.equal(current.state, 'failed')
    assert.equal((current.hold as { cause: string }).cause, 'RATE_LIMIT')
  })

  test('resets_at del terminal fija cuanto se espera', async () => {
    const slept: number[] = []
    const resetsAt = new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const double = runnerDouble([{ status: 'failed', kind: 'rate_limit', resetsAt }, WRITER, REVIEWER])
    const run = await runTooling(consumer(), ['42'], {
      env: HOLD_ENV,
      deps: {
        launchRunner: double.launch,
        sleep: (seconds) => {
          slept.push(seconds)
          return Promise.resolve()
        },
      },
    })
    assert.equal(run.code, 0, text(run))
    assert.ok((slept[0] ?? 0) > 600 && (slept[0] ?? 0) <= 660, `espero ${slept[0]}s`)
  })

  test('la espera tambien cubre al reviewer', async () => {
    const repo = consumer()
    const { run } = await runDouble(repo, [WRITER, { status: 'failed', kind: 'provider_unavailable' }, REVIEWER], { env: HOLD_ENV })
    assert.equal(run.code, 0, text(run))
    assert.match(eventsLog(repo), /\]\[hold\] PROVIDER_UNAVAILABLE: esperando, proxima sonda /)
    assert.match(readFileSync(String(history(repo)[0]?.log), 'utf8'), /reviewer completado en \d+s\n/)
  })
})
