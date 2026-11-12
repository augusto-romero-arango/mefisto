// `parallel-pipeline.mts`: scheduler con --max-parallel, serializacion de tipo:projection,
// escalonado, senal de parada suave, espera (hold) activa, dashboard y
// `pipeline-status-parallel.json`, con corridas de extremo a extremo sobre consumidores temporales y
// pipelines hijos falsos.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { issueStatusFiles, renderParallelStatus, statusReader } from '../parallel-pipeline.mts'
import { isolateGitConfig, writeFiles } from './field-note-sandbox.mts'
import { clockAt, fakeGh, holdLine, newOrchestrated, readJson, runParallel } from './orchestrator-sandbox.mts'
import type { Orchestrated, OrchestratorRun } from './orchestrator-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto parallel pipeline ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function consumer(roles?: readonly string[]): Orchestrated {
  counter++
  return newOrchestrated(join(work, `caso-${counter}`), roles)
}

const text = (run: OrchestratorRun): string => stripAnsi(run.out)
const parallelStatus = (repo: Orchestrated): Record<string, unknown> => readJson(join(repo.stateDir, 'pipeline-status-parallel.json'))
const issuesOf = (status: Record<string, unknown>): Record<string, unknown>[] => status.issues as Record<string, unknown>[]
const summaryRow = (run: OrchestratorRun, issue: string): string =>
  text(run)
    .split('\n')
    .filter((line) => new RegExp(`^#${issue}\\s`).test(line))
    .at(-1) ?? ''
const launchedIssues = (run: OrchestratorRun): string[] => run.calls.map((call) => call.split(' ')[1] ?? '')
const signalOf = (repo: Orchestrated): string => join(repo.root, 'pipeline-state', 'batch-stop')
const session = (issue: string): string => `=== SESSION TOOLING 20260101-000000 issue:${issue} from-stage:1 ===`

describe('piezas del lote', () => {
  test('renderParallelStatus: claves, nulos, numeros y detail en una linea', () => {
    const rendered = renderParallelStatus({
      started: '20260101-000000',
      state: 'running',
      stopRequested: true,
      log: '/tmp/parallel.log',
      entries: [
        { issue: '11', pipeline: 'tooling', status: 'terminado', pr: '1011', started: '100', finished: '160', detail: '' },
        { issue: '12', pipeline: '', status: 'saltado', pr: '', started: '', finished: '', detail: 'esta\tCLOSED\n' },
      ],
    })
    assert.equal(
      rendered,
      `${JSON.stringify(
        {
          pipeline: 'parallel',
          started: '20260101-000000',
          state: 'running',
          stop_requested: true,
          log: '/tmp/parallel.log',
          issues: [
            { issue: 11, pipeline: 'tooling', status: 'terminado', pr: 1011, started: 100, finished: 160, detail: null },
            { issue: 12, pipeline: null, status: 'saltado', pr: null, started: null, finished: null, detail: 'esta CLOSED ' },
          ],
        },
        null,
        2,
      )}\n`,
    )
  })

  test('statusReader lee el canonico y si falta el legacy, con "-" para lo vacio', () => {
    const root = mkdtempSync(join(work, 'estado-'))
    const env = { MEFISTO_STATE_DIR: join(root, '.mefisto', 'pipeline'), MEFISTO_LEGACY_STATE_DIR: join(root, '.claude', 'pipeline') }
    mkdirSync(env.MEFISTO_STATE_DIR, { recursive: true })
    mkdirSync(env.MEFISTO_LEGACY_STATE_DIR, { recursive: true })
    const name = 'pipeline-status-tdd-42.json'
    writeFileSync(join(env.MEFISTO_LEGACY_STATE_DIR, name), '{"stage":"legacy"}\n')
    assert.equal(statusReader(name, env).field('stage'), 'legacy', 'solo en .claude/pipeline')
    writeFileSync(
      join(env.MEFISTO_STATE_DIR, name),
      JSON.stringify({ stage: 'canonico', pr: null, tests: 0, last_error: '', ok: true, n: 7, agents: { reviewer: { result: 'passed', duration: 30 } } }),
    )
    const status = statusReader(name, env)
    assert.equal(status.field('stage'), 'canonico', 'el canonico gana')
    for (const field of ['pr', 'tests', 'last_error', 'falta']) assert.equal(status.field(field), '-', field)
    assert.equal(status.field('ok'), 'True')
    assert.equal(status.field('n'), '7')
    assert.equal(status.agent('reviewer', 'duration'), '30')
    assert.equal(status.agent('implementer', 'result'), '-')
    assert.equal(statusReader('no-existe.json', env).field('stage'), '-')
    writeFileSync(join(env.MEFISTO_STATE_DIR, 'roto.json'), '{no es json')
    assert.equal(statusReader('roto.json', env).field('stage'), '-')
  })

  test('issueStatusFiles toma pipeline-status-*-<issue>.json y nada mas', () => {
    const dir = mkdtempSync(join(work, 'limpieza-'))
    for (const name of [
      'pipeline-status-tooling-42.json',
      'pipeline-status-tdd-42.json',
      'pipeline-status-tooling-142.json',
      'pipeline-status-tooling-42-variante.json',
      'pipeline-status-parallel.json',
    ]) {
      writeFileSync(join(dir, name), '{}')
    }
    assert.deepEqual(
      issueStatusFiles(dir, '42').map((file) => file.slice(dir.length + 1)).sort(),
      ['pipeline-status-tdd-42.json', 'pipeline-status-tooling-42.json'],
    )
    assert.deepEqual(issueStatusFiles(join(dir, 'no-existe'), '42'), [])
  })
})

describe('guardas', () => {
  test('sin argumentos imprime el uso y sale con 1', async () => {
    const run = await runParallel(consumer(), [])
    assert.equal(run.code, 1)
    assert.match(run.out, /^Uso: scripts\/parallel-pipeline\.mts \[--pipeline tdd\|tooling\] <issue1> <issue2> \.\.\. \[--max-parallel N\] \[--keep-status\]\n/)
    assert.match(run.out, /--stagger S {8}Segundos entre lanzamientos \(por defecto: 30; 0 = sin espera\)/)
  })

  test('argumentos invalidos', async () => {
    const repo = consumer()
    const cases: [string[], string][] = [
      [['--pipeline'], 'Falta el valor de --pipeline\n'],
      [['--pipeline', 'iac', '1'], "Pipeline desconocido: iac. Usa 'tdd' o 'tooling'\n"],
      [['1', '--max-parallel'], 'Falta el valor de --max-parallel\n'],
      [['1', '--stagger'], 'Falta el valor de --stagger\n'],
      [['--stagger', 'x', '11'], "--stagger debe ser un entero >= 0 (recibido: 'x')\n"],
      [['1', '--rapido'], 'Argumento desconocido: --rapido\n'],
    ]
    for (const [argv, message] of cases) {
      const run = await runParallel(repo, argv)
      assert.equal(run.code, 1, argv.join(' '))
      assert.equal(run.out, message)
    }
    const empty = await runParallel(repo, ['--keep-status'])
    assert.equal(empty.code, 1)
    assert.equal(text(empty), '✗ No se especificaron issues.\n')
  })

  test('en el repo de Mefisto no arranca', async () => {
    const repo = consumer()
    writeFiles(repo.root, { '.claude-plugin/plugin.json': '{}\n' })
    const run = await runParallel(repo, ['1'])
    assert.equal(run.code, 1)
    assert.equal(
      run.err,
      'ERROR: parallel-pipeline.mts es del plugin publicado y solo aplica al consumidor.\nEstás en el repo de Mefisto. Los pipelines internos no soportan paralelismo aún;\ntrabaja los issues de Mefisto secuencialmente con /mefisto-tooling.\n',
    )
  })

  test('runtime sin resolver o sin CLI: no consulta ni lanza issues', async () => {
    const repo = consumer()
    const unknown = await runParallel(repo, ['1'], { env: { MEFISTO_RUNTIME: 'inexistente' } })
    assert.equal(unknown.code, 1)
    assert.match(text(unknown), /^✗ No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador/)
    const noCli = await runParallel(repo, ['1'], { hasCommand: (command) => command !== 'claude' })
    assert.equal(text(noCli), "✗ Dependencias faltantes: CLI del runtime 'claude'\n")
    assert.deepEqual(noCli.gh.calls, [])
    const missing = await runParallel(repo, ['1'], { hasCommand: (command) => command !== 'git' })
    assert.equal(text(missing), '✗ Dependencias faltantes: git\n')
  })

  test('sin issues validos aborta con el status en failed', async () => {
    const repo = consumer()
    const run = await runParallel(repo, ['1', '2'], { gh: fakeGh({ issues: { '1': { labels: ['tipo:infra'] }, '2': { state: 'CLOSED' } } }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /✗ ERROR FATAL: No hay issues validos para procesar\.\n/)
    const status = parallelStatus(repo)
    assert.equal(status.state, 'failed')
    assert.deepEqual(
      issuesOf(status).map((issue) => [issue.status, issue.detail]),
      [
        ['saltado', 'infra'],
        ['saltado', 'esta CLOSED'],
      ],
    )
  })
})

describe('corrida del lote', () => {
  test('[A] lote exitoso: PRs sin merge, status y limpieza de los status por issue', async () => {
    const repo = consumer()
    const status = { state: 'running', stage: '1-writer' }
    const run = await runParallel(repo, ['--stagger', '0', '11,12'], { guion: { pipeline: { '11': { status }, '12': { status } } } })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(run.calls.sort(), [
      'tooling-pipeline 11 --status-file pipeline-status-tooling-11.json',
      'tooling-pipeline 12 --status-file pipeline-status-tooling-12.json',
    ])
    const lote = parallelStatus(repo)
    assert.deepEqual(Object.keys(lote), ['pipeline', 'started', 'state', 'stop_requested', 'log', 'issues'])
    assert.equal(lote.pipeline, 'parallel')
    assert.equal(lote.state, 'completed')
    assert.equal(lote.stop_requested, false)
    assert.match(String(lote.log), /parallel-.*\.log$/)
    const issues = issuesOf(lote)
    assert.deepEqual(
      issues.map((issue) => [issue.issue, issue.pipeline, issue.status, issue.pr]),
      [
        [11, 'tooling', 'terminado', 1011],
        [12, 'tooling', 'terminado', 1012],
      ],
    )
    for (const issue of issues) assert.ok(typeof issue.started === 'number' && typeof issue.finished === 'number' && issue.finished >= issue.started)
    const output = text(run)
    assert.match(output, /── parallel-pipeline --- Procesamiento paralelo de issues ──/)
    assert.match(output, /Paralelismo maximo: sin limite/)
    assert.match(output, /Issue #11 -> tooling-pipeline\.mts\n/)
    assert.match(output, /Lanzado issue #11 con tooling-pipeline\.mts \(PID \d+\) -> pipeline-status-tooling-11\.json/)
    assert.match(output, /Todos los pipelines lanzados\. Monitoreando progreso \(Ctrl\+C para cancelar\)\.\.\./)
    assert.match(output, /── Recolectando resultados ──/)
    assert.match(output, /Issue {7}Estado {46}Duración {3}PR\n/)
    assert.match(summaryRow(run, '11'), /^#11 {9}completado {42}\d+s +https:\/\/github\.com\/acme\/consumidor\/pull\/1011$/)
    assert.match(output, /Total: 2 {2}\| {2}Completados: 2 {2}\| {2}Fallidos: 0 {2}\| {2}Aplazados: 0/)
    assert.match(output, /Nota: los PRs NO se mergearon automáticamente\.\n {2}Para integrar a main usa: \/merge <PR_NUM>/)
    assert.match(output, /✓ parallel-pipeline completado\. Log: /)
    assert.deepEqual(readdirSync(repo.stateDir).filter((name) => name.startsWith('pipeline-status-')), ['pipeline-status-parallel.json'])
    assert.equal(existsSync(repo.legacyStateDir), false, 'nada se escribe en la raiz legacy')
  })

  test('--keep-status conserva los status por issue y --max-parallel se informa', async () => {
    const repo = consumer()
    const run = await runParallel(repo, ['--stagger', '0', '--keep-status', '--max-parallel', '02', '13'], {
      guion: { pipeline: { '13': { status: { state: 'running' } } } },
    })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /Paralelismo maximo: 02\n/)
    assert.ok(existsSync(join(repo.stateDir, 'pipeline-status-tooling-13.json')))
  })

  test('[B] un pipeline fallido se reporta con su exit o con el error de su status', async () => {
    const repo = consumer()
    const run = await runParallel(repo, ['--stagger', '0', '21', '22', '23'], {
      guion: {
        pipeline: {
          '21': { exit: 3, output: 'boom\n' },
          '22': { exit: 1, status: { state: 'failed', last_error: 'tests rojos tras el reviewer' } },
        },
      },
    })
    assert.equal(run.code, 1)
    const issues = issuesOf(parallelStatus(repo))
    assert.equal(parallelStatus(repo).state, 'completed')
    assert.deepEqual(
      issues.map((issue) => [issue.status, issue.pr, issue.detail]),
      [
        ['fallido', null, 'exit 3'],
        ['fallido', null, 'tests rojos tras el reviewer'],
        ['terminado', 1023, null],
      ],
    )
    assert.match(summaryRow(run, '21'), /ERROR: exit 3 +\d+s +\(sin PR\)$/)
    assert.match(summaryRow(run, '22'), /ERROR: tests rojos tras el reviewer/)
    assert.match(text(run), /⚠ Algunos issues tuvieron errores\. Revisa el log: /)
  })

  test('[C] issues saltados por tipo o por estado no se lanzan', async () => {
    const repo = consumer()
    const gh = fakeGh({ issues: { '31': { labels: ['tipo:infra'] }, '32': { labels: [] }, '34': { state: 'CLOSED' } } })
    const run = await runParallel(repo, ['--stagger', '0', '31', '32', '33', '34'], { gh })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(launchedIssues(run), ['33'])
    assert.deepEqual(
      issuesOf(parallelStatus(repo)).map((issue) => [issue.status, issue.pipeline, issue.detail]),
      [
        ['saltado', null, 'infra'],
        ['saltado', null, 'no-tipo'],
        ['terminado', 'tooling', null],
        ['saltado', null, 'esta CLOSED'],
      ],
    )
    assert.match(text(run), /⚠ Issue #34 esta CLOSED --- saltando\./)
    assert.match(text(run), /1 issue\(s\) valido\(s\): 33\n/)
    assert.match(text(run), /Total: 1 /)
  })

  test('--pipeline fuerza el pipeline, que corre su .mts con Node', async () => {
    const repo = consumer(['tooling-pipeline'])
    const script = join(repo.scriptsDir, 'tdd-pipeline.mts')
    writeFileSync(
      script,
      [
        "const [issue = ''] = process.argv.slice(2)",
        "console.log(`tdd node ${process.argv.slice(2).join(' ')}`)",
        "console.log(`PR creado: https://github.com/acme/consumidor/pull/${Number(issue) + 1000}`)",
        '',
      ].join('\n'),
    )
    const run = await runParallel(repo, ['--pipeline', 'tdd', '--stagger', '0', '41'])
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /Pipeline: tdd \(override\)/)
    assert.match(summaryRow(run, '41'), /pull\/1041$/)
    assert.deepEqual(issuesOf(parallelStatus(repo)).map((issue) => issue.pipeline), ['tdd'])
  })
})

describe('scheduler', () => {
  test('--max-parallel retiene el turno y el dashboard muestra stage, agentes y la cola', async () => {
    const repo = consumer()
    const status = { state: 'running', stage: '2-implementer', agents: { 'test-writer': { result: 'passed', duration: 12 } } }
    const run = await runParallel(repo, ['--stagger', '0', '--max-parallel', '1', '51', '52'], {
      guion: { pipeline: { '51': { status, sleepMs: 400 } } },
    })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(launchedIssues(run), ['51', '52'])
    const output = text(run)
    assert.match(output, /parallel-pipeline — 2 issue\(s\) en proceso\n-{70}\n {2}Issue {3}Stage {11}Tiempo {4}Agentes\n/)
    assert.match(output, /\n {2}#51 {5}2-implementer {3}\d+m\d{2}s +tw:12s \n/)
    assert.match(output, /\n {2}#52 {5}en espera {7}- {9}\n/)
    assert.match(output, /1 issue\(s\) esperando turno\. Actualizando en 10s\.\.\. \(Ctrl\+C para cancelar\)/)
    assert.ok(run.slept.includes(10))
  })

  test('dos tipo:projection se serializan sin frenar al resto', async () => {
    const repo = consumer()
    const gh = fakeGh({ issues: { '71': { labels: ['tipo:projection'] }, '72': { labels: ['tipo:projection'] } } })
    const run = await runParallel(repo, ['--stagger', '0', '71', '72', '73'], { gh, guion: { pipeline: { '71': { sleepMs: 400 } } } })
    assert.equal(run.code, 0, run.out)
    const order = launchedIssues(run)
    assert.ok(order.indexOf('71') < order.indexOf('72'), order.join(' '))
    assert.ok(order.indexOf('73') < order.indexOf('72'), 'el issue que no es projection no espera')
    assert.ok(run.calls.includes('tdd-pipeline 72 --status-file pipeline-status-tdd-72.json'))
    const output = text(run)
    assert.match(output, /Issue #71 -> tdd-pipeline\.mts \(read-side: se serializa con otras projections\)/)
    assert.match(output, /⚠ 2 issues tipo:projection detectados --- se serializaran entre si \(comparten el worker de proyecciones del BC, MEF-ADR-0034\)\./)
    assert.match(output, /#72 {5}en espera/)
  })

  test('escalonado: 30 s por defecto entre lanzamientos, el valor dado, o ninguno con 0', async () => {
    const count = (run: OrchestratorRun, seconds: number): number => run.slept.filter((value) => value === seconds).length
    const byDefault = await runParallel(consumer(), ['11', '12', '13'])
    assert.equal(byDefault.code, 0, byDefault.out)
    assert.equal(count(byDefault, 30), 2, 'dos esperas para tres issues')
    assert.match(text(byDefault), /Escalonado: esperando 30s antes del siguiente lanzamiento\.\.\./)
    const none = await runParallel(consumer(), ['--stagger', '0', '11', '12', '13'])
    assert.equal(count(none, 30) + count(none, 0), 0)
    const seven = await runParallel(consumer(), ['--stagger', '7', '11', '12'])
    assert.equal(count(seven, 7), 1)
  })
})

describe('parada suave', () => {
  test('[H] la senal previa aplaza todo sin lanzar ningun worktree', async () => {
    const repo = consumer()
    mkdirSync(join(repo.root, 'pipeline-state'), { recursive: true })
    writeFileSync(signalOf(repo), '')
    const run = await runParallel(repo, ['--stagger', '0', '501', '502'])
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(run.calls, [])
    for (const issue of ['501', '502']) assert.match(summaryRow(run, issue), /aplazado \(parada solicitada; no se proceso en esta {2}- {11}\(sin PR\)/)
    const output = text(run)
    assert.match(
      output,
      /⚠ Parada solicitada \(pipeline-state\/batch-stop\): 2 issue\(s\) en cola quedan aplazados, sin lanzar ningun worktree\. Los ya lanzados terminan su pipeline y abren su PR\./,
    )
    assert.match(output, /Ningun pipeline quedo en vuelo: no hay nada que monitorear\./)
    assert.match(output, /Relanza los aplazados, en el mismo orden: parallel-pipeline\.mts 501 502\n/)
    assert.match(output, /Fallidos: 0 /)
    assert.equal(existsSync(signalOf(repo)), false)
    const status = parallelStatus(repo)
    assert.equal(status.state, 'stopped')
    assert.equal(status.stop_requested, true)
  })

  test('[D] la senal con un issue en cola deja terminar al lanzado y aplaza al resto', async () => {
    const repo = consumer()
    const run = await runParallel(repo, ['--stagger', '0', '41', '42', '--max-parallel', '1'], {
      guion: { pipeline: { '41': { signal: true, sleepMs: 300 } } },
    })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(launchedIssues(run), ['41'])
    const status = parallelStatus(repo)
    assert.equal(status.state, 'stopped')
    assert.equal(status.stop_requested, true)
    const issues = issuesOf(status)
    assert.deepEqual(
      issues.map((issue) => issue.status),
      ['terminado', 'aplazado'],
    )
    assert.match(String(issues[1]?.detail), /parada/)
    assert.equal(issues[1]?.started, null)
    assert.match(text(run), /\n {2}#42 {5}aplazado {8}- {9}\n/, 'el dashboard ya no lo muestra en espera')
    assert.match(text(run), /parallel-pipeline\.mts 42\n/)
    assert.equal(existsSync(signalOf(repo)), false)
  })

  test('la senal con todo ya lanzado se consume igual', async () => {
    const repo = consumer()
    const signal = signalOf(repo)
    // La espera del escalonado dura hasta que el primer pipeline escribe la senal.
    const sleep = async (): Promise<void> => {
      for (let tries = 0; tries < 500 && !existsSync(signal); tries++) await new Promise((done) => setTimeout(done, 10))
    }
    const run = await runParallel(repo, ['--stagger', '5', '61', '62'], { guion: { pipeline: { '61': { signal: true } } }, deps: { sleep } })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(launchedIssues(run).sort(), ['61', '62'])
    assert.match(
      text(run),
      /⚠ Parada solicitada \(pipeline-state\/batch-stop\): no quedaba ningun issue en cola por lanzar \(todos ya estaban en vuelo\)\. La senal se consumio igual, para no afectar la corrida siguiente\./,
    )
    assert.equal(existsSync(signal), false)
    const status = parallelStatus(repo)
    assert.equal(status.state, 'completed', 'no quedo nada aplazado')
    assert.equal(status.stop_requested, true)
  })
})

describe('espera (hold) activa', () => {
  /** Reloj que solo avanza una vez anunciada la espera: la carga de la maquina no la deja vencer antes de verla. */
  const holdClock = (eventsLog: string): { now: () => Date; sleep: (seconds: number) => Promise<void> } => {
    let skewMs = 0
    return {
      now: () => new Date(Date.now() + skewMs),
      sleep: async (seconds) => {
        if (existsSync(eventsLog) && readFileSync(eventsLog, 'utf8').includes('proxima sonda')) skewMs += seconds * 1000
        await new Promise((done) => setTimeout(done, 15))
      },
    }
  }

  test('una espera activa retiene la cola y el dashboard la muestra con etiqueta propia', async () => {
    const repo = consumer()
    const events = [session('81'), holdLine(clockAt(-60), clockAt(600))]
    const run = await runParallel(repo, ['--stagger', '0', '--max-parallel', '1', '81', '82'], {
      guion: { pipeline: { '81': { events, sleepMs: 400 } } },
      deps: holdClock(join(repo.stateDir, 'events.log')),
    })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(launchedIssues(run), ['81', '82'], 'la cola sigue sola cuando la espera se libera')
    const output = text(run)
    assert.match(
      output,
      /Espera \(hold\) activa -- RATE_LIMIT: esperando, proxima sonda \d{2}:\d{2}:\d{2} \(techo 23:59\)\. 1 issue\(s\) en cola esperan a que se libere antes de lanzar el siguiente\./,
    )
    assert.match(output, /\n {2}#81 {5}espera\/hold {5}\d+m\d{2}s +RATE_LIMIT: esperando, proxima sonda/)
    assert.match(output, /\n {2}#82 {5}en espera {7}- /, 'esperar turno y esperar por limite de uso se distinguen')
  })

  test('una espera escrita en el events.log legacy tambien retiene la cola', async () => {
    const repo = consumer()
    const legacyEvents = [session('85'), holdLine(clockAt(-60), clockAt(300))]
    const run = await runParallel(repo, ['--stagger', '0', '--max-parallel', '1', '85', '86'], {
      guion: { pipeline: { '85': { legacyEvents, sleepMs: 200 } } },
      deps: holdClock(join(repo.legacyStateDir, 'events.log')),
    })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /Espera \(hold\) activa -- RATE_LIMIT: esperando/)
  })

  test('una espera anterior al arranque no frena la cola', async () => {
    const repo = consumer()
    mkdirSync(repo.stateDir, { recursive: true })
    writeFileSync(join(repo.stateDir, 'events.log'), `${session('80')}\n${holdLine(clockAt(-60), clockAt(600))}\n`)
    const run = await runParallel(repo, ['--stagger', '0', '--max-parallel', '1', '83', '84'])
    assert.equal(run.code, 0, run.out)
    assert.doesNotMatch(text(run), /Espera \(hold\) activa/)
    assert.deepEqual(launchedIssues(run), ['83', '84'])
  })
})
