// Invocacion de agentes desde `tdd-pipeline.mts`: argv del runner, resumen del stage, modelos y
// effort por stage, fallos, rescate de trabajo, reintento por denegaciones, espera (hold) y
// reanudacion de sesion (issues #1360, #1361, #1362, #1363, #1450, #1600, #2504).

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import type { CoverageRun } from '../lib/pipeline/tdd-coverage.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import {
  BRANCH,
  GREEN,
  IMPLEMENTER,
  PREFIX,
  RED,
  REVIEWER,
  TEST_PROJECT,
  TEST_WRITER,
  eventsLog,
  flag,
  history,
  newTddConsumer,
  readJson,
  runTdd,
  runnerDouble,
  statusFile,
  tddTools,
  worktreeOf,
} from './tdd-pipeline-sandbox.mts'
import type { Consumer, DoubleStep, TddRun, TddRunOptions } from './tdd-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto tdd agents ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function consumer(files: Record<string, string> = {}): Consumer {
  counter++
  return newTddConsumer(join(work, `caso-${counter}`), files)
}

const text = (run: TddRun): string => stripAnsi(run.out)
const argOf = (args: string[] | undefined, name: string): string | undefined =>
  args === undefined || !args.includes(name) ? undefined : args[args.indexOf(name) + 1]
const agentOf = (args: string[] | undefined): string | undefined => argOf(args, '--agent')

interface Observed {
  run: TddRun
  calls: string[][]
  prompts: string[]
  /** Contenido del status justo antes de cada invocacion del runner. */
  statuses: (Record<string, unknown> | null)[]
}

async function runSteps(repo: Consumer, steps: DoubleStep[], options: TddRunOptions = {}, argv: string[] = ['42']): Promise<Observed> {
  const double = runnerDouble(steps)
  const statuses: (Record<string, unknown> | null)[] = []
  const status = statusFile(repo, argv.includes('--variant') ? `pipeline-status-tdd-42-${argv[argv.indexOf('--variant') + 1]}.json` : undefined)
  const launch: typeof double.launch = (args, output) => {
    statuses.push(existsSync(status) ? readJson(status) : null)
    return double.launch(args, output)
  }
  const run = await runTdd(repo, argv, { ...options, deps: { launchRunner: launch, ...options.deps } })
  return { run, calls: double.calls, prompts: double.prompts, statuses }
}

const HAPPY = [TEST_WRITER, IMPLEMENTER, REVIEWER]
const HOLD_ENV = { MEFISTO_HOLD_PROBE_SECONDS: '30', MEFISTO_HOLD_MAX_SECONDS: '3600', GUION_RESUME: '1' }

describe('frontera con el runner neutral', () => {
  test('argv exacto con --model condicional; prompt con la linea del resumen y system prompt desatendido', async () => {
    const repo = consumer()
    const { run, calls, prompts } = await runSteps(repo, HAPPY, { tools: tddTools({ tests: [RED] }) }, ['42', '--models', 'test-writer=vendor/model'])
    assert.equal(run.code, 0, text(run))
    const args = calls[0] ?? []
    const tmp = dirname(argOf(args, '--prompt-file') ?? '')
    const logs = join(repo.stateDir, 'logs')
    const started = String(history(repo)[0]?.started)
    assert.deepEqual(args, [
      '--runtime', 'guion',
      '--agent', 'test-writer',
      '--cwd', worktreeOf(repo),
      '--prompt-file', join(tmp, '1-test-writer.prompt.md'),
      '--system-file', join(tmp, '1-test-writer.system.md'),
      '--event-log', join(logs, `stage-1-test-writer-${started}-issue-42-attempt-1.events.jsonl`),
      '--events-log', join(repo.stateDir, 'events.log'),
      '--redact-observability',
      '--timeout', '1800',
      '--model', 'vendor/model',
    ])
    assert.match(basename(tmp), /^mefisto-tdd\./)
    assert.equal(existsSync(tmp), false, 'el directorio temporal se borra al cerrar')
    const summary = join(worktreeOf(repo), '.mefisto', 'pipeline', 'summaries', 'stage-1-test-writer.md')
    assert.equal(prompts[0]?.endsWith(`PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.\n\nAl cerrar este stage, deja tu resumen en: ${summary}`), true)
    for (const call of calls.slice(1)) assert.equal(call.includes('--model'), false, 'el override es solo del test-writer')
    for (const name of ['claude', 'bypassPermissions']) assert.equal(args.join(' ').includes(name), false)
    assert.match(text(run), /\] Modelos por stage \(--models\): test-writer=vendor\/model\n/)
    assert.match(eventsLog(repo), /MODELS: test-writer runtime=guion perfil=balanced solicitado='vendor\/model' resuelto='vendor\/model' \(override --models\)\n/)
  })

  test('el resumen que solo quedo en la ruta legacy llega al PR', async () => {
    const repo = consumer()
    const reviewer = { files: { '.claude/pipeline/summaries/stage-3-reviewer.md': 'summary legacy\n' } }
    const { run } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, reviewer], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(flag(run.tools.gh.find((args) => args[1] === 'create') ?? [], '--body'), /<summary>Reviewer \(fase refactor\) — 0m \d+s<\/summary>\n\nsummary legacy\n\n<\/details>/)
  })

  test('el log de cada stage se deriva del JSONL redactado, sin el prompt', async () => {
    const repo = consumer()
    const tools = tddTools({ tests: [RED], issue: { number: 42, title: 'Registrar turno', body: 'SECRETO_PROMPT_TEXT', state: 'OPEN' } })
    const writer = { ...TEST_WRITER, events: [{ v: 1, type: 'tool.started', tool: 'Bash', input_summary: null }] }
    const { run, calls } = await runSteps(repo, [writer, IMPLEMENTER, REVIEWER], { tools })
    assert.equal(run.code, 0, text(run))
    assert.ok(calls.every((args) => args.includes('--redact-observability')))
    const events = argOf(calls[0], '--event-log') ?? ''
    const log = events.replace(/-attempt-1\.events\.jsonl$/, '.log')
    assert.equal(readFileSync(log, 'utf8'), '[tool] Bash\nsuccess\n')
    assert.equal(readFileSync(events, 'utf8').includes('SECRETO'), false)
  })

  test('el reviewer recibe SHA, stat y rutas de las fases roja y verde, nunca el diff', async () => {
    const repo = consumer()
    const generated = Array.from({ length: 50_000 }, (_, index) => `linea ${index} de contenido generado por el test-writer para inflar el diff\n`).join('')
    const writer = { files: { ...TEST_WRITER.files, [`${TEST_PROJECT}/generated.txt`]: generated }, commit: 'tests' }
    const { run, prompts } = await runSteps(repo, [writer, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    const reviewer = prompts[2] ?? ''
    assert.ok(Buffer.byteLength(reviewer) < 65_536, `${Buffer.byteLength(reviewer)} bytes`)
    assert.match(reviewer, /\nCommit base: [0-9a-f]{40}\nHEAD del test-writer: [0-9a-f]{40}\n/)
    assert.ok(reviewer.includes(`A\t${TEST_PROJECT}/generated.txt`))
    assert.equal(reviewer.includes('diff --git'), false)
    assert.equal(reviewer.includes('@@'), false)
  })
})

describe('fallos del agente y rescate de trabajo', () => {
  test('un fallo sin trabajo aborta con su log y deja el stage fallido en status e historial', async () => {
    const repo = consumer()
    const { run } = await runSteps(repo, [{ status: 'failed' }])
    assert.equal(run.code, 1)
    assert.match(text(run), /\] test-writer falló después de \d+s — tipo: CLI_ERROR\n/)
    assert.match(text(run), /✗ ERROR: test-writer falló \(CLI_ERROR\)\. Log completo: .*stage-1-test-writer-\d{8}-\d{6}-issue-42\.log\n/)
    assert.match(eventsLog(repo), /FALLO test-writer: CLI_ERROR\n/)
    const status = readJson(statusFile(repo))
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, '1-test-writer')
    const agents = status.agents as Record<string, { duration: number | null; result: string }>
    assert.equal(agents['test-writer']?.result, 'failed')
    assert.equal(typeof agents['test-writer']?.duration, 'number')
    const [entry = {}] = history(repo)
    assert.equal(entry.state, 'failed')
    assert.equal(entry.error, `test-writer falló (CLI_ERROR). Log completo: ${join(repo.stateDir, 'logs', `stage-1-test-writer-${String(entry.started)}-issue-42.log`)}`)
    const historyAgents = entry.agents as Record<string, { metrics: Record<string, unknown> | null }>
    assert.deepEqual(Object.keys(historyAgents), ['test-writer', 'implementer', 'reviewer'])
    assert.equal(historyAgents['test-writer']?.metrics?.result, 'failed')
    assert.equal(historyAgents.implementer?.metrics, null)
  })

  test('TIMEOUT descarta el trabajo parcial sin pasar por el gate de rescate', async () => {
    const repo = consumer()
    const { run, calls } = await runSteps(repo, [{ files: { 'src/partial.txt': 'parcial\n' }, status: 'failed', kind: 'timeout', exit: 124 }])
    assert.equal(run.code, 1)
    assert.equal(calls.length, 1)
    assert.deepEqual(run.tools.dotnet, [])
    assert.match(text(run), /✗ ERROR: test-writer falló \(TIMEOUT\); se descarta trabajo parcial\n/)
  })

  test('un fallo ordinario con trabajo que pasa su gate se rescata y sigue', async () => {
    const repo = consumer()
    const implementer = { ...IMPLEMENTER, status: 'failed' as const }
    const { run } = await runSteps(repo, [TEST_WRITER, implementer, REVIEWER], { tools: tddTools({ tests: [RED, GREEN] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ implementer: runner retorno CLI_ERROR pero hay trabajo util completado — continuando\n/)
    assert.match(eventsLog(repo), /RECUPERADO implementer: trabajo util detectado post-CLI_ERROR, continuando\n/)
  })

  test('el Stage 1 rescata con el build; el Stage 2b nunca rescata', async () => {
    const writer = await runSteps(consumer(), [{ ...TEST_WRITER, status: 'failed' }, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.equal(writer.run.code, 0, text(writer.run))
    assert.match(text(writer.run), /⚠ test-writer: runner retorno CLI_ERROR pero hay trabajo util completado — continuando\n/)

    const smokeProject = `tests/${PREFIX}.Turnos.SmokeTests`
    const repo = consumer({ [`${smokeProject}/Base.cs`]: 'x\n' })
    const implementer = { files: { [`src/${PREFIX}.Turnos/CrearTurnoFunction/FunctionEndpoint.cs`]: 'x\n' }, commit: 'feat' }
    const smoke = { files: { [`${smokeProject}/Nuevo.cs`]: 'x\n' }, commit: 'smoke', status: 'failed' as const }
    const { run } = await runSteps(repo, [TEST_WRITER, implementer, smoke], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /✗ ERROR: smoke-test-writer falló \(CLI_ERROR\)\. Log completo: /)
    const agents = readJson(statusFile(repo)).agents as Record<string, { result: string }>
    assert.equal(agents['smoke-test-writer']?.result, 'failed')
  })
})

describe('reintento por denegaciones y espera ante limites (MEF-ADR-0051)', () => {
  test('denegaciones sin trabajo reintentan una sola vez desde cero, aunque el runtime declare exito', async () => {
    const repo = consumer()
    const { run, calls } = await runSteps(repo, [{ denials: 2 }, ...HAPPY], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.equal(agentOf(calls[1]), 'test-writer')
    assert.equal(argOf(calls[1], '--resume-session'), undefined)
    assert.match(argOf(calls[1], '--event-log') ?? '', /-attempt-2\.events\.jsonl$/)
    assert.match(text(run), /⚠ test-writer: 2 denegacion\(es\) neutrales sin trabajo; reintentando una vez desde cero\n/)
    assert.match(eventsLog(repo), /RETRY test-writer: denials=2\n/)
  })

  test('el estado del pipeline commiteado por el agente no cuenta como trabajo', async () => {
    const repo = consumer()
    const state = { files: { '.mefisto/pipeline/agent-state.txt': 'x\n' }, denials: 2 }
    const { run, calls } = await runSteps(repo, [state, ...HAPPY], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.equal(agentOf(calls[1]), 'test-writer')
  })

  test('un limite de uso espera, deja el status en hold y la sonda reanuda la sesion', async () => {
    const repo = consumer()
    const steps: DoubleStep[] = [{ status: 'failed', kind: 'rate_limit', session: 'session-1360' }, ...HAPPY]
    const { run, calls, prompts, statuses } = await runSteps(repo, steps, { env: HOLD_ENV, tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.equal(argOf(calls[0], '--resume-session'), undefined)
    assert.equal(argOf(calls[1], '--resume-session'), 'session-1360')
    assert.equal(prompts[1], 'Continue the same stage and complete its summary.\n')
    const hold = statuses[1] ?? {}
    assert.equal(hold.state, 'hold')
    assert.equal(hold.stage, '1-test-writer')
    const block = hold.hold as Record<string, unknown>
    assert.equal(block.cause, 'RATE_LIMIT')
    assert.match(String(block.next_probe), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    assert.equal(block.ceiling_seconds, 3600)
    const after = statuses[2]?.hold as Record<string, unknown>
    assert.equal(after.cause, null)
    assert.equal(after.next_probe, null)
    assert.ok(Number(after.accumulated_seconds) >= 30)
    assert.match(eventsLog(repo), /FALLO test-writer: RATE_LIMIT\n/)
  })
})

describe('effort por agente (issue #2504)', () => {
  const LEVELS = { light: 'n-light', standard: 'n-standard', thorough: 'n-thorough' }
  const mapping = (efforts: object): Record<string, string> => ({ '.mefisto/models.json': `${JSON.stringify({ guion: { efforts } })}\n` })

  test('sin mapping de agente cada uno recibe el nativo de su nivel de fabrica', async () => {
    const repo = consumer(mapping({ levels: LEVELS }))
    const { run, calls } = await runSteps(repo, HAPPY, { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map((args) => argOf(args, '--effort')), ['n-light', 'n-standard', 'n-thorough'])
    assert.match(eventsLog(repo), /EFFORTS: test-writer -> n-light \(nivel light\)\n[\s\S]*EFFORTS: implementer -> n-standard \(nivel standard\)\n/)
  })

  test('efforts.agents cambia el nivel; el reintento y la reanudacion reenvian el mismo effort', async () => {
    const repo = consumer(mapping({ levels: LEVELS, agents: { 'test-writer': 'standard' } }))
    const steps: DoubleStep[] = [{ denials: 1 }, { status: 'failed', kind: 'rate_limit', session: 's' }, ...HAPPY]
    const { run, calls } = await runSteps(repo, steps, { env: HOLD_ENV, tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.slice(0, 3).map((args) => argOf(args, '--effort')), ['n-standard', 'n-standard', 'n-standard'])
    assert.equal(argOf(calls[2], '--resume-session'), 's')
  })

  test('un mapping invalido aborta citando el agente y MEFISTO_EFFORTS_ERROR, sin lanzar el runner', async () => {
    const repo = consumer(mapping({ levels: { light: 'n-light' }, agents: { 'test-writer': 'bogus' } }))
    // Con el modelo fijado por --models, el mapping solo se lee al resolver el effort.
    const { run, calls } = await runSteps(repo, HAPPY, {}, ['42', '--models', 'test-writer=modelo-a'])
    assert.equal(run.code, 1)
    assert.deepEqual(calls, [])
    assert.match(text(run), /✗ ERROR: No se pudo resolver el effort de test-writer: MEFISTO_EFFORTS_ERROR=/)
  })

  test('el Stage 0 y las remediaciones 4b/4c usan el effort del agente que relanzan', async () => {
    const repo = consumer({
      ...mapping({ levels: LEVELS, agents: { 'test-writer': 'standard', implementer: 'light' } }),
      [`${TEST_PROJECT}/bin/Debug/net10.0/${PREFIX}.Turnos.dll`]: '',
    })
    const handler = 'src/Empresa.Proyecto.Turnos/RegistrarTurno/RegistrarTurnoCommandHandler.cs'
    const coverage: CoverageRun = (_command, args) => {
      if (args[0] === 'collect') {
        writeFileSync(args[args.indexOf('--output') + 1] ?? '', `<coverage><packages><package><classes><class filename="${handler}" line-rate="0.5"/></classes></package></packages></coverage>`)
      }
      return { status: 0, timedOut: false }
    }
    const scaffolder = { files: { [`src/${PREFIX}.ControlHoras/Program.cs`]: 'x\n' }, commit: 'scaffold' }
    const steps: DoubleStep[] = [scaffolder, ...HAPPY, { files: { [`${TEST_PROJECT}/C.cs`]: 'x\n' }, commit: 'cobertura' }, {}]
    const { run, calls } = await runSteps(repo, steps, { coverage, tools: tddTools({ tests: [RED], builds: [0, 1] }) }, ['42', '--scaffold-domain', 'control-horas'])
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map((args) => `${argOf(args, '--agent')}:${argOf(args, '--effort')}`), [
      'domain-scaffolder:n-light',
      'test-writer:n-standard',
      'implementer:n-light',
      'reviewer:n-thorough',
      'test-writer:n-standard',
      'implementer:n-light',
    ])
    const events = eventsLog(repo)
    for (const line of [
      'EFFORTS: domain-scaffolder -> n-light (nivel light)',
      'EFFORTS: patch-test-writer -> n-standard (nivel light)',
      'EFFORTS: patch-implementer -> n-light (nivel standard)',
      'REMEDIATION: build fallo, relanzando implementer',
    ]) {
      assert.ok(events.includes(line), line)
    }
    const [entry = {}] = history(repo)
    assert.deepEqual(Object.keys(entry.agents as object), ['scaffolder', 'test-writer', 'implementer', 'reviewer', 'patch-test-writer', 'patch-implementer', 'coverage-gate'])
    assert.equal(existsSync(join(repo.stateDir, 'metrics', `tdd-${String(entry.started)}-issue-42-stage-4c-implementer.json`)), true)
  })
})

describe('modelo neutral por perfil (issue #1362)', () => {
  test('sin override ni mapping, el default del adaptador; la evidencia queda en events.log', async () => {
    const repo = consumer()
    const { run, calls } = await runSteps(repo, HAPPY, { env: { GUION_DEFAULT_MODEL: 'modelo-x' }, tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map((args) => argOf(args, '--model')), ['modelo-x', 'modelo-x', 'modelo-x'])
    assert.match(eventsLog(repo), /MODELS: test-writer runtime=guion perfil=balanced solicitado=<automatico> resuelto='modelo-x'\n/)
    assert.match(text(run), /\] Invocando reviewer \(modelo: modelo-x\)\.\.\.\n/)
  })

  test('el mapping del consumidor: agents.<id> gana a profiles.<perfil>', async () => {
    const repo = consumer({ '.mefisto/models.json': `${JSON.stringify({ guion: { profiles: { balanced: 'modelo-perfil' }, agents: { 'test-writer': 'modelo-agente-mapping' } } })}\n` })
    const { run, calls } = await runSteps(repo, HAPPY, { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map((args) => argOf(args, '--model')), ['modelo-agente-mapping', 'modelo-perfil', undefined])
    assert.match(eventsLog(repo), /MODELS: reviewer runtime=guion perfil=deep solicitado=<automatico> resuelto='<heredado>'\n/)
  })

  test('las remediaciones heredan el override del agente salvo que su clave fina tenga uno', async () => {
    const run = async (models: string): Promise<string[][]> => {
      const repo = consumer({ [`${TEST_PROJECT}/bin/Debug/net10.0/${PREFIX}.Turnos.dll`]: '' })
      const handler = 'src/Empresa.Proyecto.Turnos/RegistrarTurno/RegistrarTurnoCommandHandler.cs'
      const coverage: CoverageRun = (_command, args) => {
        if (args[0] === 'collect') {
          writeFileSync(args[args.indexOf('--output') + 1] ?? '', `<coverage><packages><package><classes><class filename="${handler}" line-rate="0.5"/></classes></package></packages></coverage>`)
        }
        return { status: 0, timedOut: false }
      }
      const observed = await runSteps(repo, [...HAPPY, {}], { coverage, tools: tddTools({ tests: [RED] }) }, ['42', '--models', models])
      assert.equal(observed.run.code, 0, text(observed.run))
      return observed.calls
    }
    assert.equal(argOf((await run('test-writer=modelo-agente'))[3], '--model'), 'modelo-agente')
    assert.equal(argOf((await run('test-writer=modelo-agente,patch-test-writer=modelo-fino'))[3], '--model'), 'modelo-fino')
  })

  test('un mapping ilegible aborta nombrando el agente y su perfil', async () => {
    const repo = consumer({ '.mefisto/models.json': '{no es json\n' })
    const { run, calls } = await runSteps(repo, HAPPY)
    assert.equal(run.code, 1)
    assert.deepEqual(calls, [])
    assert.match(text(run), /✗ ERROR: No se pudo resolver el modelo de test-writer \(perfil balanced\): /)
  })
})


describe('status durante la corrida', () => {
  test('cada stage publica su estado con los cinco agentes alineados y el bloque hold', async () => {
    const repo = consumer()
    const { run, statuses } = await runSteps(repo, HAPPY, { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    const raw = statuses[1]
    assert.equal(raw?.stage, '2-implementer')
    assert.equal(raw?.state, 'running')
    assert.deepEqual(raw?.agents, {
      'test-writer': { duration: (raw?.agents as Record<string, { duration: number }>)['test-writer']?.duration, result: 'passed' },
      implementer: { duration: null, result: 'running' },
      'smoke-test-writer': { duration: null, result: 'pending' },
      reviewer: { duration: null, result: 'pending' },
      'coverage-gate': { duration: null, result: 'pending' },
    })
    assert.equal(raw?.worktree, worktreeOf(repo))
    assert.equal(raw?.runtime, 'guion')
    assert.deepEqual(Object.keys(raw ?? {}), ['issue', 'title', 'pipeline', 'variant', 'identity', 'runtime', 'started', 'stage', 'state', 'updated', 'worktree', 'log', 'agents', 'tests', 'pr', 'last_error', 'hold'])
    assert.equal(BRANCH, 'worktree-issue-42-registrar-turno')
  })
})
