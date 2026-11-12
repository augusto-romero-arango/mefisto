// Corridas de extremo a extremo de `tdd-pipeline.mts` sobre un consumidor temporal: guardas,
// camino feliz con el runner real, gates de fase roja, verde y refactor, carriles de refactor puro,
// solo smoke y read-side, Stage 0 y 2b, coverage gate, variante, reanudacion y publicacion del PR.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../lib/cli.mts'
import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import type { CoverageRun } from '../lib/pipeline/tdd-coverage.mts'
import { initRepo } from './consumer-sandbox.mts'
import { isolateGitConfig, writeFiles } from './field-note-sandbox.mts'
import {
  BRANCH,
  GREEN,
  IMPLEMENTER,
  NO_TESTS,
  PREFIX,
  RED,
  REVIEWER,
  SMOKE_PROJECT,
  TEST_PROJECT,
  TEST_WRITER,
  eventsLog,
  flag,
  guionCalls,
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

const REPO_ROOT = join(import.meta.dirname, '..', '..')
let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto tdd pipeline ')))
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

const git = (cwd: string, ...args: string[]): string => capture('git', args, { cwd }).stdout.replace(/\n+$/, '')
const text = (run: TddRun): string => stripAnsi(run.out)
const ghCalls = (run: TddRun, ...command: string[]): string[][] =>
  run.tools.gh.filter((args) => command.every((word, index) => args[index] === word))
const prBody = (run: TddRun): string => flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--body')

/** Corre con el runner en proceso: mismo pipeline, sin lanzar procesos de agente. */
async function runSteps(repo: Consumer, steps: DoubleStep[], options: TddRunOptions = {}, argv: string[] = ['42']): Promise<{ run: TddRun; prompts: string[]; calls: string[][] }> {
  const double = runnerDouble(steps)
  const run = await runTdd(repo, argv, { ...options, deps: { launchRunner: double.launch, ...options.deps } })
  return { run, prompts: double.prompts, calls: double.calls }
}

const agentOf = (args: string[]): string => args[args.indexOf('--agent') + 1] ?? ''

describe('guardas previas', () => {
  test('sin argumentos muestra el uso y sale con 1', async () => {
    const run = await runTdd(consumer(), [])
    assert.equal(run.code, 1)
    assert.equal(
      run.out,
      "Uso: scripts/tdd-pipeline.mts [--issue NUM | --file PATH | NUM] [--from-stage N] [--status-file NOMBRE] [--scaffold-domain KEBAB] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]\n",
    )
  })

  test('fuera de un repo git se niega', async () => {
    const repo = consumer()
    const run = await runTdd({ ...repo, root: mkdtempSync(join(work, 'sin-git-')) }, ['42'])
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no estas en un repositorio git\n')
  })

  test('en el repo de Mefisto se niega sin dejar estado', async () => {
    const repo = consumer({ '.claude-plugin/plugin.json': '{"name":"mefisto"}\n' })
    const run = await runTdd(repo, ['42'])
    assert.equal(run.code, 1)
    assert.equal(
      run.err,
      'ERROR: scripts/tdd-pipeline.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Estas en el repo de Mefisto, que no es un proyecto .NET con TDD de dominio.\n' +
        'Para mejorar el plugin usa /mefisto-tooling.\n',
    )
    assert.deepEqual(run.tools.gh, [])
    assert.equal(existsSync(repo.stateDir), false)
  })

  test('sin harness.config.json informa el config requerido', async () => {
    const root = initRepo(join(work, `sin-config-${++counter}`), { 'README.md': 'x\n' })
    const run = await runTdd({ root, bare: '', guionFile: join(work, 'guion-x.json'), stateDir: join(root, '.mefisto', 'pipeline') }, ['42'])
    assert.equal(run.code, 1)
    assert.match(run.err, /^ERROR: no se encontro el config canonico requerido .*harness\.config\.json\.\n/)
  })
})

describe('como proceso', () => {
  const USAGE = /^Uso: .*tdd-pipeline\.mts \[--issue NUM \| --file PATH \| NUM\] \[--from-stage N\]/

  test('el modulo corre directo con Node y sale con 1 mostrando el uso', () => {
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'tdd-pipeline.mts')], { cwd: consumer().root })
    assert.equal(result.status, 1)
    assert.match(result.stdout, USAGE)
  })

  test('la copia distribuida en dist/claude carga toda su clausura y llega al uso', () => {
    const repo = consumer()
    const usage = capture(process.execPath, [join(REPO_ROOT, 'dist', 'claude', 'scripts', 'tdd-pipeline.mts')], { cwd: repo.root })
    assert.equal(usage.status, 1, usage.stderr)
    assert.match(usage.stdout, USAGE)
    const result = capture(process.execPath, [join(REPO_ROOT, 'dist', 'claude', 'scripts', 'tdd-pipeline.mts'), '42', '--raro'], { cwd: repo.root })
    assert.equal(result.status, 1, result.stderr)
    assert.match(stripAnsi(result.stdout), /✗ ERROR: Argumento no reconocido: --raro\n/)
  })

  test('en el repo de Mefisto el proceso se niega', () => {
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'tdd-pipeline.mts'), '42'], { cwd: REPO_ROOT })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: scripts\/tdd-pipeline\.mts es del plugin publicado y solo aplica al consumidor\.\n/)
  })
})

describe('argumentos: abortan antes de preparar el estado, sin status ni historial', () => {
  const CASES: { name: string; argv: string[]; missing?: string; error: RegExp }[] = [
    { name: 'argumento desconocido', argv: ['42', '--raro'], error: /✗ ERROR: Argumento no reconocido: --raro\n/ },
    { name: '--issue sin valor', argv: ['--issue'], error: /✗ ERROR: Falta el número de issue\n/ },
    { name: '--file sin valor', argv: ['--file'], error: /✗ ERROR: Falta la ruta del archivo\n/ },
    { name: '--from-stage sin valor', argv: ['42', '--from-stage'], error: /✗ ERROR: Falta el número de stage\n/ },
    { name: '--status-file sin valor', argv: ['42', '--status-file'], error: /✗ ERROR: Falta el nombre del archivo de status\n/ },
    { name: '--scaffold-domain sin valor', argv: ['42', '--scaffold-domain'], error: /✗ ERROR: Falta el nombre del dominio para --scaffold-domain\n/ },
    { name: '--models sin valor', argv: ['42', '--models'], error: /✗ ERROR: Falta el valor de --models\n/ },
    { name: '--variant sin valor', argv: ['42', '--variant'], error: /✗ ERROR: Falta el valor de --variant\n/ },
    { name: '--from-stage fuera de rango', argv: ['42', '--from-stage', '5'], error: /✗ ERROR: --from-stage debe ser 1, 2, 3 o 4 \(recibido: 5\)\n/ },
    {
      name: '--variant con mayusculas',
      argv: ['42', '--variant', 'Experimento'],
      error: /✗ ERROR: --variant mal formado: el label de --variant 'Experimento' es invalido: solo minusculas, digitos y guiones \(\[a-z0-9-\]\)\n/,
    },
    { name: 'falta dotnet', argv: ['42'], missing: 'dotnet', error: /✗ ERROR: Falta comando requerido: dotnet\n/ },
  ]
  for (const { name, argv, missing, error } of CASES) {
    test(name, async () => {
      const repo = consumer()
      const run = await runTdd(repo, argv, { deps: { hasCommand: (command) => command !== missing && command !== 'dotnet-coverage' } })
      assert.equal(run.code, 1)
      assert.match(text(run), error)
      assert.match(text(run), /Revisa el log: .*pipeline-\d{8}-\d{6}(-\w+)?\.log\n/)
      assert.deepEqual(run.tools.gh, [])
      assert.deepEqual(readdirSync(repo.stateDir).filter((entry) => entry !== 'logs'), [])
    })
  }
})

describe('frontera neutral: aborta antes del worktree, ya con status e historial de setup', () => {
  const CASES: { name: string; env?: NodeJS.ProcessEnv; argv?: string[]; error: RegExp }[] = [
    { name: '--models mal formado', argv: ['42', '--models', 'reviewer'], error: /✗ ERROR: --models mal formado: entrada 'reviewer' no tiene la forma agente=modelo\n/ },
    { name: 'timeout que no es un entero', env: { MEFISTO_AGENT_TIMEOUT_SECONDS: '30s' }, error: /✗ ERROR: MEFISTO_AGENT_TIMEOUT_SECONDS '30s' no es un entero\n/ },
    { name: 'timeout en cero', env: { MEFISTO_AGENT_TIMEOUT_SECONDS: '0' }, error: /✗ ERROR: MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0\n/ },
    { name: 'runner alterno que no existe', env: { MEFISTO_RUN_AGENT_BIN: join(tmpdir(), 'no-existe-runner') }, error: /✗ ERROR: No es ejecutable el runner neutral: .*no-existe-runner\n/ },
    { name: 'runtime sin adaptador', env: { MEFISTO_RUNTIME: 'inexistente' }, error: /✗ ERROR: No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador/ },
  ]
  for (const { name, env, argv, error } of CASES) {
    test(name, async () => {
      const repo = consumer()
      const run = await runTdd(repo, argv ?? ['42'], env === undefined ? {} : { env })
      assert.equal(run.code, 1)
      assert.match(text(run), error)
      assert.equal(existsSync(join(repo.stateDir, 'worktrees')), false)
      const status = readJson(statusFile(repo))
      assert.equal(status.stage, 'setup')
      assert.equal(status.state, 'failed')
      assert.equal(status.pipeline, 'tdd')
      const [entry = {}] = history(repo)
      assert.equal(entry.state, 'failed')
      assert.equal(entry.stage, 'setup')
      assert.match(String(entry.error), error.source.includes('ERROR: ') ? /./ : /./)
      assert.match(eventsLog(repo), /^─── SESSION \d{8}-\d{6} issue:42 from-stage:1 ───\n/)
    })
  }
})

describe('camino feliz con el runner real', () => {
  let repo: Consumer
  let run: TddRun

  before(async () => {
    repo = consumer()
    run = await runTdd(repo, ['42'], { guion: [TEST_WRITER, IMPLEMENTER, REVIEWER] })
  })

  test('termina bien e invoca a test-writer, implementer y reviewer en el worktree', () => {
    assert.equal(run.code, 0, run.out + run.err)
    assert.deepEqual(guionCalls(repo).map((call) => call.agent), ['test-writer', 'implementer', 'reviewer'])
    for (const call of guionCalls(repo)) {
      assert.equal(call.cwd.endsWith(join('worktrees', BRANCH)), true)
      assert.match(call.system, /^You are running in non-interactive print mode\./)
      assert.equal(call.model, '')
    }
  })

  test('cada prompt termina pidiendo el resumen en el estado del worktree', () => {
    const worktree = worktreeOf(repo)
    for (const [stage, call] of [['1', 0], ['2', 1], ['3', 2]] as const) {
      const agent = guionCalls(repo)[call]?.agent ?? ''
      const summary = join(worktree, '.mefisto', 'pipeline', 'summaries', `stage-${stage}-${agent}.md`)
      assert.equal(guionCalls(repo)[call]?.prompt.endsWith(`\n\nAl cerrar este stage, deja tu resumen en: ${summary}`), true)
    }
    assert.match(guionCalls(repo)[0]?.prompt ?? '', /^Estás en el directorio raíz del proyecto Proyecto\.\n\nContexto de la historia de usuario a implementar:\n\n# Issue #42: Registrar turno\n\nCuerpo del issue\.\n/)
  })

  test('gates: compila, confirma la fase roja sin compilar de nuevo y la verde', () => {
    assert.deepEqual(run.tools.dotnet[0], ['build', worktreeOf(repo)])
    const tests = run.tools.dotnet.filter((args) => args[0] === 'test')
    assert.equal(tests[0]?.at(-1), '--no-build')
    assert.equal(tests.length, 3)
    assert.match(text(run), /\] Fase roja confirmada \(exit code: 2\)\n✓ Stage 1 completado — fase roja confirmada\n/)
    assert.match(text(run), /\] Tests pasando: 3\n✓ Stage 2 completado — fase verde confirmada\n/)
    assert.match(text(run), /\] No se detectaron Function Apps ni tools MCP modificadas — saltando smoke tests\n/)
    assert.match(text(run), /⚠ dotnet-coverage no encontrado — saltando coverage gate\n/)
  })

  test('crea el PR con el cuerpo TDD, comenta el issue y deja la rama en el remoto', () => {
    const [create = []] = ghCalls(run, 'pr', 'create')
    assert.equal(flag(create, '--title'), 'Registrar turno')
    assert.equal(flag(create, '--head'), BRANCH)
    assert.match(prBody(run), /^## Resumen\n\nPipeline TDD completado:\n- Fase roja: tests escritos con stubs\n- Fase verde: implementación completa\n- Fase refactor: revisión de calidad\n\n## Decisiones del pipeline\n\n<details>\n<summary>Test Writer \(fase roja\) — 0m \d+s<\/summary>\n\n_\(El agente no generó resumen\)_\n/)
    assert.match(prBody(run), /\nCloses #42$/)
    assert.equal(flag(ghCalls(run, 'issue', 'comment')[0] ?? [], '--body'), 'Pipeline TDD completado. Decisiones de los agentes en el PR: https://github.com/acme/consumidor/pull/7')
    assert.equal(git(repo.bare, 'log', '--format=%s', BRANCH, '-2'), 'feat(hu-42): implementacion\ntest(hu-42): tests fase roja')
  })

  test('cierra: status borrado, worktree eliminado, historial completo y resumen final', () => {
    assert.equal(existsSync(statusFile(repo)), false)
    assert.equal(existsSync(worktreeOf(repo)), false)
    const [entry = {}] = history(repo)
    assert.deepEqual(Object.keys(entry), ['issue', 'title', 'pipeline', 'variant', 'identity', 'runtime', 'started', 'finished', 'state', 'agents', 'tests', 'pr', 'log'])
    assert.equal(entry.pipeline, 'tdd')
    assert.equal(entry.state, 'completed')
    assert.equal(entry.tests, 3)
    assert.equal(entry.runtime, 'guion')
    assert.equal(entry.log, join(repo.stateDir, 'logs', `pipeline-${String(entry.started)}.log`))
    const agents = entry.agents as Record<string, { duration: number; metrics: Record<string, unknown> }>
    // Sin dotnet-coverage el gate igual corrio: deja su fila con duracion y resultado.
    assert.deepEqual(Object.keys(agents), ['test-writer', 'implementer', 'reviewer', 'coverage-gate'])
    assert.deepEqual({ ...agents['coverage-gate'], duration: 0 }, { duration: 0, result: 'skipped', gaps: 0, patch_applied: false })
    for (const [key, stage, profile] of [['test-writer', '1', 'balanced'], ['implementer', '2', 'balanced'], ['reviewer', '3', 'deep']] as const) {
      assert.equal(agents[key]?.metrics.pipeline, 'tdd')
      assert.equal(agents[key]?.metrics.stage, stage)
      assert.equal(agents[key]?.metrics.agent, key)
      assert.equal(agents[key]?.metrics.profile, profile)
      const file = join(repo.stateDir, 'metrics', `tdd-${String(entry.started)}-issue-42-stage-${stage}-${key}.json`)
      assert.equal(existsSync(file), true, file)
    }
    assert.match(text(run), /\n═══ Pipeline completado ═══\n\n {2}Commits: 2\n {2}Rama: {4}worktree-issue-42-registrar-turno\n {2}PR: {6}https:\/\/github\.com\/acme\/consumidor\/pull\/7\n {2}Log: {5}.*\.log\n\n$/)
  })

  test('events.log: sesion, stages y modelos', () => {
    const events = eventsLog(repo)
    assert.match(events, /^─── SESSION \d{8}-\d{6} issue:42 from-stage:1 ───\n/)
    for (const line of ['=== STAGE 1: test-writer ===', '=== STAGE 2: implementer ===', '=== STAGE 3: reviewer ===']) assert.ok(events.includes(line), line)
    assert.match(events, /MODELS: reviewer runtime=guion perfil=deep solicitado=<automatico> resuelto='<heredado>'\n/)
    assert.match(events, /EFFORTS: test-writer -> <heredado> \(nivel light\)\n/)
  })
})

describe('Stage 1: fase roja', () => {
  test('todo en verde sin senal aborta con las opciones y el motivo del carril solo-smoke', async () => {
    const repo = consumer()
    const { run } = await runSteps(repo, [TEST_WRITER], { tools: tddTools({ tests: [GREEN] }) })
    assert.equal(run.code, 1)
    assert.match(
      text(run),
      /✗ ERROR: Stage 1 fallido: todos los tests pasan \(exit code: 0\)\. Opciones: \(1\) el test-writer escribio implementacion real en lugar de stubs: .* Lo que impidio detectarlo: ninguno de los cambios cae bajo tests\/\*\.SmokeTests\/\.\n/,
    )
    const status = readJson(statusFile(repo))
    assert.equal(status.stage, '1-test-writer')
    assert.equal(status.state, 'failed')
  })

  test('con un smoke y otros cambios, el aborto nombra lo que impidio el carril solo-smoke', async () => {
    const repo = consumer()
    const step = { files: { ...TEST_WRITER.files, [`${SMOKE_PROJECT}/ASmokeTests.cs`]: 'x\n' }, commit: 'tests' }
    const { run } = await runSteps(repo, [step], { tools: tddTools({ tests: [GREEN] }) })
    assert.match(text(run), /Lo que impidio detectarlo: src\/Empresa\.Proyecto\.Turnos\/RegistrarTurno\/RegistrarTurnoCommandHandler\.cs,tests\/Empresa\.Proyecto\.Turnos\.Tests\/RegistrarTurnoTests\.cs\.\n/)
  })

  test('sin tests (exit 8) aborta', async () => {
    const { run } = await runSteps(consumer(), [TEST_WRITER], { tools: tddTools({ tests: [NO_TESTS] }) })
    assert.match(text(run), /✗ ERROR: Stage 1 fallido: no se encontraron tests para ejecutar \(exit code: 8\) — el test-writer no genero tests validos\n/)
  })

  test('un test-writer que no deja nada aborta pidiendo revisar el agente', async () => {
    const { run } = await runSteps(consumer(), [{}])
    assert.match(text(run), /✗ ERROR: El test-writer no generó ningún archivo\. Verifica que el agente 'test-writer' está disponible en el runtime activo\.\n/)
  })

  test('un log que muestra refactor puro sin senal aborta por la senal faltante', async () => {
    const repo = consumer()
    const { run } = await runSteps(repo, [{ events: [{ v: 1, type: 'tool.started', tool: 'Write refactor-signal.md' }] }])
    assert.match(text(run), /✗ ERROR: El test-writer detecto refactor puro pero no creo el archivo señal en .*pipeline-state[/\\]refactor-signal\.md \(ni en la ubicacion legacy\)\. Probable causa: el runtime intercepto la escritura\. Revisa el log: .*stage-1-test-writer-\d{8}-\d{6}-issue-42\.log\n/)
  })

  test('el proyecto que no compila tras el test-writer aborta', async () => {
    const { run } = await runSteps(consumer(), [TEST_WRITER], { tools: tddTools({ builds: [1] }) })
    assert.match(text(run), /✗ ERROR: Stage 1 fallido: el proyecto no compila después del test-writer\. Revisa .*logs\/stage-1-test-writer\.log\n/)
  })

  test('avisa de tests preexistentes en rojo que el test-writer no toco y sigue', async () => {
    const repo = consumer()
    const red = { status: 2, output: `  failed ${PREFIX}.Turnos.Tests.BaseTests.Guarda_Inventario (3ms)\nTest run summary: Failed!\n` }
    const { run } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [red] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ Tests PREEXISTENTES en rojo que el test-writer no modifico \(no se aborta\):\n⚠ {3}- Guarda_Inventario \(tests\/Empresa\.Proyecto\.Turnos\.Tests\/BaseTests\.cs\)\n/)
  })
})

describe('Stage 2: fase verde y bloqueos (issues #1561, #2062)', () => {
  const REPORT = '.mefisto/pipeline/blockage-report.md'

  test('issue incompleto: detiene el pipeline como blocked, sin reviewer ni PR', async () => {
    const repo = consumer()
    const implementer = { files: { [REPORT]: '## Issue incompleto\n\nFalta la seccion `## ADRs aplicables`.\n' } }
    const { run, calls } = await runSteps(repo, [TEST_WRITER, implementer], { tools: tddTools({ tests: [RED, RED] }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /✗ ERROR: Stage 2 detenido: el implementer reporto issue incompleto en .*blockage-report\.md\. Refina el issue con el planner \(completa la seccion '## ADRs aplicables'\) y reanuda con --from-stage 2\.\n/)
    assert.deepEqual(calls.map(agentOf), ['test-writer', 'implementer'])
    const status = readJson(statusFile(repo))
    assert.equal(status.state, 'blocked')
    assert.equal(status.stage, '2-implementer')
    assert.equal((status.agents as Record<string, { result: string }>).implementer?.result, 'blocked')
    const [entry = {}] = history(repo)
    assert.equal(entry.state, 'blocked')
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
  })

  test('tests bloqueados que el reviewer resuelve: el PR no sale bloqueado y lista los tests que ajusto', async () => {
    const repo = consumer()
    const implementer = { ...IMPLEMENTER, files: { ...IMPLEMENTER.files, [REPORT]: '## Reporte de bloqueo - Implementer\n\n### Tests bloqueados\n' } }
    const reviewer = { files: { [`${TEST_PROJECT}/BaseTests.cs`]: 'public class BaseTests { }\n' }, commit: 'reviewer ajusta la guarda' }
    const { run, prompts } = await runSteps(repo, [TEST_WRITER, implementer, reviewer], { tools: tddTools({ tests: [RED, RED, GREEN] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ Stage 2: hay tests rojos pero el implementer reporto bloqueo — continuando al reviewer\n/)
    assert.match(prompts[2] ?? '', /\n\nATENCION: hay tests bloqueados tras la fase verde .*Lee el reporte en .*blockage-report\.md y sigue/)
    assert.match(text(run), /\] Stage 3: el reviewer resolvio los tests bloqueados — el PR no se marca bloqueado\n/)
    assert.match(eventsLog(repo), /BLOCKAGE_RESOLVED: reviewer resolvio tests bloqueados\n/)
    assert.deepEqual(ghCalls(run, 'pr', 'edit'), [])
    assert.match(prBody(run), /## Tests ajustados por el reviewer\n\nEl reviewer modifico.*\n\nLo hizo al destrabar tests en rojo despues de la fase verde\.\n\n- `tests\/Empresa\.Proyecto\.Turnos\.Tests\/BaseTests\.cs`\n\n## Commits/)
  })

  test('el bloqueo que persiste tras el reviewer marca el PR y comenta el reporte', async () => {
    const repo = consumer()
    const implementer = { ...IMPLEMENTER, files: { ...IMPLEMENTER.files, [REPORT]: '## Reporte de bloqueo - Implementer\n\nDetalle.\n' } }
    const { run } = await runSteps(repo, [TEST_WRITER, implementer, REVIEWER], { tools: tddTools({ tests: [RED, RED, RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ Stage 3: hay tests rojos pero el bloqueo persiste desde el implementer — continuando a PR\n/)
    assert.deepEqual(ghCalls(run, 'pr', 'edit')[0], ['pr', 'edit', '7', '--add-label', 'bloqueado', '--repo', repo.bare])
    const comment = ghCalls(run, 'pr', 'comment')[0] ?? []
    assert.equal(comment[2], '7')
    assert.equal(
      flag(comment, '--body'),
      '## Tests bloqueados\n\nEste PR tiene tests en rojo que ni el implementer ni el reviewer pudieron resolver. Se requiere atencion humana.\n\n<details>\n<summary>Reporte de bloqueo</summary>\n\n## Reporte de bloqueo - Implementer\n\nDetalle.\n\n</details>',
    )
    assert.equal(history(repo)[0]?.state, 'completed')
  })

  test('solo rojos preexistentes: el pipeline escribe el reporte y sigue al reviewer', async () => {
    const repo = consumer()
    const preexisting = { status: 2, output: `  failed ${PREFIX}.Turnos.Tests.BaseTests.Guarda_Inventario (5ms)\nTest run summary: Failed!\n` }
    const { run, prompts } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED, preexisting, GREEN] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ Stage 2: todos los tests rojos son preexistentes no modificados — reporte generado, continuando al reviewer\n/)
    assert.match(eventsLog(repo), /BLOCKAGE: pipeline detecto solo rojos preexistentes, continuando al reviewer\n/)
    assert.ok((prompts[2] ?? '').includes('ATENCION: hay tests bloqueados'))
  })

  test('rojos sin reporte ni preexistentes: aborta mostrando la cola de la salida', async () => {
    const { run } = await runSteps(consumer(), [TEST_WRITER, IMPLEMENTER], { tools: tddTools({ tests: [RED, RED] }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /Test run summary: Failed!\n\n✗ ERROR: Stage 2 fallido: no todos los tests pasan después del implementer \(exit code: 2\)\. Revisa .*stage-2-implementer\.log\n/)
  })
})

describe('rama read-side y senal de fase roja no aplicable (issues #371, #585)', () => {
  const SIGNAL = { 'pipeline-state/no-red-signal.md': 'JUSTIFICATION=Unica capa posible: config-test del worker\n' }

  test('tipo:projection con senal y todo en verde continua, y la justificacion llega al reviewer y al PR', async () => {
    const repo = consumer()
    const writer = { files: { ...TEST_WRITER.files, ...SIGNAL }, commit: 'tests' }
    const { run, calls, prompts } = await runSteps(repo, [writer, IMPLEMENTER, REVIEWER], { tools: tddTools({ labels: ['tipo:projection', 'estado:listo'], tests: [GREEN] }) })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map(agentOf), ['projection-test-writer', 'projection-implementer', 'reviewer'])
    assert.match(text(run), /\] Label tipo:projection detectado — despachando trio read-side \(projection-test-writer \/ projection-implementer\)\n/)
    assert.match(text(run), /\] fase roja no aplicable: Unica capa posible: config-test del worker\n/)
    assert.match(text(run), /✓ Stage 1 completado — fase roja no aplicable \(señalizada por el projection-test-writer\)\n/)
    assert.ok((prompts[2] ?? '').includes('Nota: el projection-test-writer señalizo que la fase roja del Stage 1 era estructuralmente inalcanzable'))
    assert.match(prBody(run), /- Fase roja no aplicable: Unica capa posible: config-test del worker\n/)
    assert.match(prBody(run), /<summary>Projection Test Writer \(fase roja\) — /)
  })

  test('la misma senal en write-side se ignora y el todo-verde aborta', async () => {
    const writer = { files: { ...TEST_WRITER.files, ...SIGNAL }, commit: 'tests' }
    const { run } = await runSteps(consumer(), [writer], { tools: tddTools({ tests: [GREEN] }) })
    assert.match(text(run), /✗ ERROR: Stage 1 fallido: todos los tests pasan/)
  })
})

describe('carril solo smoke (issue #2357)', () => {
  const SMOKE_WRITER = { files: { [`${SMOKE_PROJECT}/RegistrarSmokeTests.cs`]: 'smoke\n' }, commit: 'smoke tests' }

  test('salta la fase roja, el 2b y el coverage gate; el PR deja la validacion pendiente', async () => {
    const repo = consumer()
    const documental = { files: { 'docs/adr/x.md': 'adr\n' } }
    const reviewer = { files: { 'docs/adr/x.md': 'adr revisado\n' }, commit: 'docs' }
    const { run, prompts } = await runSteps(repo, [SMOKE_WRITER, documental, reviewer], { tools: tddTools({ tests: [NO_TESTS, NO_TESTS, NO_TESTS] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /\] fase roja no aplica: solo smoke tests \(corren post-deploy, MEF-ADR-0013\)\n/)
    assert.ok((prompts[1] ?? '').includes('Este issue es de SOLO SMOKE TESTS (modo documental)'))
    assert.match(text(run), /\] El implementer no commitió los entregables documentales\. Haciendo commit automático \(modo documental\)\.\.\.\n/)
    assert.match(text(run), /\] Saltando Stage 2b \(smoke escritos en Stage 1\)\n/)
    assert.match(text(run), /\] Saltando Stage 4 \(sin cambios en src\/\)\n/)
    assert.ok((prompts[2] ?? '').includes('Nota: este issue es de SOLO SMOKE TESTS'))
    assert.match(prBody(run), /## Validación pendiente post-deploy\n[\s\S]*Archivos smoke:\n- `tests\/Empresa\.Proyecto\.Turnos\.SmokeTests\/RegistrarSmokeTests\.cs`\n<details>/)
    const events = eventsLog(repo)
    assert.ok(events.includes('SMOKE_ONLY detectado\n'))
    assert.ok(events.includes('SKIP coverage-gate: sin cambios en src/\n'))
    assert.equal(git(repo.bare, 'log', '--format=%s', BRANCH, '-3').split('\n')[1], 'docs(hu-42): entregables no-código (solo smoke)')
  })

  test('un implementer que toca src/ en modo documental aborta', async () => {
    const { run } = await runSteps(consumer(), [SMOKE_WRITER, IMPLEMENTER], { tools: tddTools({ tests: [NO_TESTS] }) })
    assert.match(text(run), /✗ ERROR: Stage 2 fallido \(solo smoke, modo documental\): el implementer toco src\/ o tests\/: src\/Empresa\.Proyecto\.Turnos\/RegistrarTurno\/RegistrarTurnoCommandHandler\.cs\n/)
  })
})

describe('refactor puro (MEF-ADR-0017, issue #294)', () => {
  const SIGNAL = { files: { 'pipeline-state/refactor-signal.md': 'REFACTOR_ONLY=true\nJUSTIFICATION=Extrae un value object\nREMOVED_TESTS=1\n' } }
  const REFACTOR = { files: { [`src/${PREFIX}.Turnos/Catalogo.cs`]: 'public static class Catalogo { int y; }\n' }, commit: 'refactor' }

  test('baseline verde, sin Stage 2 ni 2b, prompt de refactor y PR de refactor', async () => {
    const repo = consumer()
    const passing = (count: number) => ({ status: 0, output: `Passed!  - Failed: 0, Passed: ${count}, Skipped: 0, Total: ${count}\n` })
    const { run, calls, prompts } = await runSteps(repo, [SIGNAL, REFACTOR], { tools: tddTools({ tests: [passing(3), passing(2)] }) })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map(agentOf), ['test-writer', 'reviewer'])
    assert.match(text(run), /\] Señal de refactoring detectada: Extrae un value object \(REMOVED_TESTS=1\)\n/)
    assert.match(text(run), /\] Baseline refactoring: 3 tests pasando\n✓ Baseline verde confirmado\n/)
    assert.match(text(run), /\] Saltando Stage 2 \(refactoring puro — no hay tests que hacer pasar\)\n/)
    assert.match(prompts[1] ?? '', /^Estás en el directorio raíz del proyecto Proyecto\.\n\nEsta es una tarea de REFACTORING PURO\./)
    assert.match(text(run), /\] Tests post-refactoring: 2 \(baseline: 3, declarados como eliminados: 1\)\n/)
    assert.match(prBody(run), /Pipeline TDD completado \(refactoring puro\):\n- Análisis: no se requieren tests nuevos\n- Justificación: Extrae un value object\n- Baseline: 3 tests pasando\n/)
    assert.equal(history(repo)[0]?.tests, 2)
  })

  test('perder mas tests de los declarados aborta', async () => {
    const passing = (count: number) => ({ status: 0, output: `Passed: ${count}\n` })
    const { run } = await runSteps(consumer(), [SIGNAL, REFACTOR], { tools: tddTools({ tests: [passing(3), passing(1)] }) })
    assert.match(text(run), /✗ ERROR: El refactoring perdió tests: antes=3, después=1, declarados como eliminados=1 \(minimo permitido=2\)\n/)
  })

  test('refactor sobre una base roja aborta', async () => {
    const { run } = await runSteps(consumer(), [SIGNAL], { tools: tddTools({ tests: [RED] }) })
    assert.match(text(run), /✗ ERROR: Refactoring señalizado pero hay tests fallando \(exit code: 2\)\. No se puede refactorizar sobre una base roja\.\n/)
  })
})

describe('Stage 2b: smoke tests de lo que el issue modifico (issues #791, #1562, #2473, #2480)', () => {
  const FUNCTION = `src/${PREFIX}.Turnos/CrearTurnoFunction/FunctionEndpoint.cs`
  const ENDPOINT = '[Function("CrearTurno")]\npublic Task Run([HttpTrigger(AuthorizationLevel.Function, "post", Route = "turnos")] HttpRequest req) { }\n'
  const BASE_SMOKE = { [`${SMOKE_PROJECT}/Existente/ExistenteSmokeTests.cs`]: 'await client.PostAsync("/api/turnos", body);\n' }

  test('una Function nueva lanza al smoke-test-writer con los smokes que ya la invocan', async () => {
    const repo = consumer(BASE_SMOKE)
    const implementer = { files: { [FUNCTION]: ENDPOINT }, commit: 'feat' }
    const smoke = { files: { [`${SMOKE_PROJECT}/Crear/CrearSmokeTests.cs`]: 'nuevo\n' } }
    const { run, calls, prompts } = await runSteps(repo, [TEST_WRITER, implementer, smoke, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map(agentOf), ['test-writer', 'implementer', 'smoke-test-writer', 'reviewer'])
    assert.ok((prompts[2] ?? '').includes(`El implementer creó/modificó los siguientes endpoints:\n${FUNCTION}\n\nSmokes existentes que invocan los endpoints modificados (en cualquier proyecto SmokeTests, tambien de otros dominios o de la suite MCP):\n- ${SMOKE_PROJECT}/Existente/ExistenteSmokeTests.cs (ruta: turnos)\n`))
    assert.ok(run.tools.dotnet.some((args) => args[0] === 'build' && args[1] === join(worktreeOf(repo), SMOKE_PROJECT)))
    assert.match(text(run), /✓ Stage 2b completado — smoke tests escritos\n/)
    assert.equal(git(repo.bare, 'log', '--format=%s', BRANCH, '-1'), 'test(hu-42): smoke tests para endpoints')
    assert.match(prBody(run), /<summary>Smoke Test Writer — 0m \d+s<\/summary>/)
    assert.match(prBody(run), /## Smokes que invocan tools modificadas sin cambios\n[\s\S]*- `tests\/Empresa\.Proyecto\.Turnos\.SmokeTests\/Existente\/ExistenteSmokeTests\.cs` \(invoca `turnos`\)\n/)
  })

  test('un proyecto smoke que no compila aborta el Stage 2b', async () => {
    const repo = consumer(BASE_SMOKE)
    const { run } = await runSteps(repo, [TEST_WRITER, { files: { [FUNCTION]: ENDPOINT }, commit: 'feat' }, {}], { tools: tddTools({ tests: [RED], builds: [0, 2] }) })
    assert.match(text(run), /salida de dotnet build\n\n✗ ERROR: Stage 2b fallido: smoke tests no compilan en tests\/Empresa\.Proyecto\.Turnos\.SmokeTests \(exit code: 2\)\. Revisa el log\.\n/)
  })

  test('una ruta sin la forma src/<ns>.<Dominio>/ se senala como anomalia en el PR', async () => {
    const repo = consumer()
    const implementer = { files: { [`src/${PREFIX}/SharedFunction/FunctionEndpoint.cs`]: 'x\n' }, commit: 'feat' }
    const { run } = await runSteps(repo, [TEST_WRITER, implementer, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ No se pudo derivar el dominio de smoke tests desde 'src\/Empresa\.Proyecto\/SharedFunction\/FunctionEndpoint\.cs' — revisa el patron de deteccion de Stage 2b\n/)
    assert.match(eventsLog(repo), /SMOKE_ANOMALY: src\/Empresa\.Proyecto\/SharedFunction\/FunctionEndpoint\.cs\n/)
    assert.match(prBody(run), /## Anomalia de deteccion \(Stage 2b\)\n\nUn match bajo `src\/` no permitio derivar el proyecto de smoke tests: `src\/Empresa\.Proyecto\/SharedFunction\/FunctionEndpoint\.cs`\./)
  })

  test('sin proyecto SmokeTests del dominio, o del servidor MCP, se salta con su motivo', async () => {
    const domain = await runSteps(consumer(), [TEST_WRITER, { files: { [`src/${PREFIX}.Ventas/CrearVentaFunction/FunctionEndpoint.cs`]: 'x\n' }, commit: 'feat' }, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.match(text(domain.run), /\] Proyecto SmokeTests no existe para Ventas — saltando smoke tests\n/)
    const mcp = await runSteps(consumer(), [TEST_WRITER, { files: { [`src/${PREFIX}.Mcp.Asistente/Turnos/CrearTurnoTool.cs`]: 'x\n' }, commit: 'feat' }, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.match(text(mcp.run), /\] Proyecto tests\/Empresa\.Proyecto\.Mcp\.Asistente\.SmokeTests no existe — genéralo con \/scaffold-mcp; saltando smoke tests\n/)
  })

  test('una tool MCP lista los smokes que invocan su nombre y avisa de la que no lo declara', async () => {
    const mcpSmoke = `tests/${PREFIX}.Mcp.Asistente.SmokeTests`
    const repo = consumer({ [`${mcpSmoke}/A/ASmokeTests.cs`]: 'CallToolAsync("crear_turno", a);\n' })
    const implementer = {
      files: {
        [`src/${PREFIX}.Mcp.Asistente/Turnos/CrearTurnoTool.cs`]: 'internal const string NombreTool = "crear_turno";\n',
        [`src/${PREFIX}.Mcp.Asistente/Turnos/SinNombreTool.cs`]: 'public class Nada { }\n',
      },
      commit: 'feat',
    }
    const { run, prompts } = await runSteps(repo, [TEST_WRITER, implementer, {}, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.ok((prompts[2] ?? '').includes(`Smokes existentes que invocan las tools modificadas:\n- ${mcpSmoke}/A/ASmokeTests.cs (tool: crear_turno)\n`))
    assert.ok((prompts[2] ?? '').includes('(MEF-ADR-0048), no la de Functions HTTP.'))
    assert.match(stripAnsi(run.err), /⚠ No se pudo extraer el nombre de la tool MCP de 'src\/Empresa\.Proyecto\.Mcp\.Asistente\/Turnos\/SinNombreTool\.cs' \(sin NombreTool ni McpToolTrigger\)\n/)
    assert.equal(git(repo.bare, 'log', '--format=%s', BRANCH, '-1'), 'feat')
  })
})

describe('Stage 0: scaffold de un dominio nuevo', () => {
  const SCAFFOLDER = { files: { [`src/${PREFIX}.ControlHoras/Program.cs`]: 'x\n' }, commit: 'scaffold' }

  test('crea el dominio, respalda sus metricas y mueve el snapshot', async () => {
    const repo = consumer()
    const { run, calls, prompts } = await runSteps(repo, [SCAFFOLDER, TEST_WRITER, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED] }) }, ['42', '--scaffold-domain', 'control-horas'])
    assert.equal(run.code, 0, text(run))
    assert.equal(agentOf(calls[0] ?? []), 'domain-scaffolder')
    assert.equal(calls[0]?.includes('--model'), false)
    assert.match(prompts[0] ?? '', /^Crea el scaffold para el dominio 'control-horas'\./)
    assert.match(text(run), /── Stage 0: Scaffold del dominio 'control-horas' ──\n[\s\S]*✓ Scaffold del dominio 'control-horas' completado en \d+s\n\[.*\] Snapshot actualizado post-scaffold: [0-9a-f]{40}\n/)
    const [entry = {}] = history(repo)
    assert.equal(existsSync(join(repo.stateDir, 'metrics', `tdd-${String(entry.started)}-issue-42-stage-0-domain-scaffolder.json`)), true)
    assert.deepEqual(Object.keys(entry.agents as object), ['scaffolder', 'test-writer', 'implementer', 'reviewer', 'coverage-gate'])
    assert.match(eventsLog(repo), /OK domain-scaffolder \(\d+s\)\n/)
    assert.equal(git(repo.bare, 'diff', '--name-only', 'main', BRANCH).includes('ControlHoras'), true)
  })

  test('un terminal fallido aborta sin reintentar', async () => {
    const repo = consumer()
    const { run, calls } = await runSteps(repo, [{ status: 'failed', exit: 0 }], {}, ['42', '--scaffold-domain', 'control-horas'])
    assert.equal(run.code, 1)
    assert.equal(calls.length, 1)
    assert.match(text(run), /✗ ERROR: El scaffold del dominio 'control-horas' fallo despues de \d+s\. Revisa: .*stage-0-scaffold-\d{8}-\d{6}\.log\n/)
    assert.match(eventsLog(repo), /FALLO domain-scaffolder \(\d+s, exit 0\)\n/)
  })

  test('sin el proyecto del dominio aborta', async () => {
    const { run } = await runSteps(consumer(), [{}], {}, ['42', '--scaffold-domain', 'control-horas'])
    assert.match(text(run), /✗ ERROR: El scaffold no creo src\/Empresa\.Proyecto\.ControlHoras — revisa: /)
  })
})

describe('Stage 4: coverage gate (MEF-ADR-0014)', () => {
  const DLL = { [`${TEST_PROJECT}/bin/Debug/net10.0/${PREFIX}.Turnos.dll`]: '' }
  const HANDLER = 'src/Empresa.Proyecto.Turnos/RegistrarTurno/RegistrarTurnoCommandHandler.cs'
  const xml = (rate: string): string =>
    `<coverage><packages><package name="p"><classes><class name="c" filename="/r/${HANDLER}" line-rate="${rate}"><lines><line number="4" hits="0"/><line number="5" hits="0"/><line number="9" hits="1"/></lines></class></classes></package></packages></coverage>`

  /** dotnet-coverage falso que deja un XML con la cobertura de cada medicion, en orden. */
  function coverage(rates: string[]): { run: CoverageRun; calls: string[][] } {
    const calls: string[][] = []
    const run: CoverageRun = (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'collect') {
        writeFileSync(args[args.indexOf('--output') + 1] ?? '', xml(rates.shift() ?? '1'))
      }
      return { status: 0, timedOut: false }
    }
    return { run, calls }
  }

  test('una brecha relanza al test-writer con el patch spec, re-mide y publica la tabla', async () => {
    const repo = consumer(DLL)
    const patch = { files: { [`${TEST_PROJECT}/CoberturaTests.cs`]: 'x\n' }, commit: 'test(hu-42): tests de cobertura para brechas detectadas' }
    const fake = coverage(['0.5', '1'])
    const { run, calls, prompts } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, REVIEWER, patch], { tools: tddTools({ tests: [RED] }), coverage: fake.run })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map(agentOf), ['test-writer', 'implementer', 'reviewer', 'test-writer'])
    assert.match(prompts[3] ?? '', /^Estas en el directorio raiz del proyecto Proyecto\.\n\nEl pipeline detecto brechas de cobertura/)
    assert.ok((prompts[3] ?? '').includes(`### ${HANDLER} (50.0% - requiere 95%)\n\nLineas no cubiertas:\n- L4-L5\n`))
    assert.equal(fake.calls.filter((call) => call[1] === 'collect').length, 2)
    const events = eventsLog(repo)
    for (const line of ['=== STAGE 4: coverage-gate ===', 'GAPS: 1 archivos bajo 95%', 'REMEDIATION: relanzando test-writer', 'result=passed, gaps=0']) assert.ok(events.includes(line), line)
    assert.match(prBody(run), /## Cobertura\n\n\| Archivo \| Cobertura \| Umbral \| Estado \|\n\|---\|---\|---\|---\|\n\| RegistrarTurnoCommandHandler\.cs \| 100\.0% \| 95% \| ok \|\n\n### Remediacion\n\nSe agregaron tests de remediacion y todos los gaps fueron cerrados\.\n/)
    const [entry = {}] = history(repo)
    const agents = entry.agents as Record<string, Record<string, unknown>>
    assert.deepEqual(Object.keys(agents), ['test-writer', 'implementer', 'reviewer', 'patch-test-writer', 'coverage-gate'])
    assert.deepEqual({ ...agents['coverage-gate'], duration: 0 }, { duration: 0, result: 'passed', gaps: 0, patch_applied: true })
    assert.equal(existsSync(join(repo.stateDir, 'metrics', `tdd-${String(entry.started)}-issue-42-stage-4b-test-writer.json`)), true)
  })

  test('una remediacion fallida deja los gaps pendientes sin abortar', async () => {
    const repo = consumer(DLL)
    const { run } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, REVIEWER, { status: 'failed', exit: 0 }], { tools: tddTools({ tests: [RED] }), coverage: coverage(['0.5']).run })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ test-writer de remediacion fallo \(exit 0\) — continuando con gaps pendientes\n/)
    assert.match(eventsLog(repo), /REMEDIATION_FAILED: test-writer exit 0\n/)
    assert.match(text(run), /⚠ Stage 4 completado con 1 gap\(s\) pendiente\(s\)\n/)
    assert.match(prBody(run), /### Remediacion\n\nEl test-writer de remediacion fallo \(exit 0\)\. Los gaps quedan pendientes\.\n\n> \*\*Gaps pendientes\*\*: 1 archivo\(s\) no alcanzan el umbral de cobertura\. Requiere revision humana\.\n/)
  })

  test('tests que fallan bajo cobertura saltan el gate con el codigo real', async () => {
    const repo = consumer(DLL)
    const failing: CoverageRun = (_command, args) => {
      if (args[0] === 'collect') writeFileSync(args[args.indexOf('--output') + 1] ?? '', xml('1'))
      return { status: args[0] === 'collect' ? 2 : 0, timedOut: false }
    }
    const { run } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED] }), coverage: failing })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /⚠ SKIP coverage-gate: tests fallaron bajo cobertura \(exit code 2\)\n/)
    assert.equal(prBody(run).includes('## Cobertura'), false)
  })
})

describe('modo variante (issue #713)', () => {
  test('sin push, PR ni comentarios; rama, status y log llevan el label; el reporte de bloqueo se preserva', async () => {
    const repo = consumer()
    const implementer = { ...IMPLEMENTER, files: { ...IMPLEMENTER.files, '.mefisto/pipeline/blockage-report.md': '## Reporte de bloqueo\n' } }
    const { run, calls } = await runSteps(repo, [TEST_WRITER, implementer, REVIEWER], { tools: tddTools({ tests: [RED, RED, RED] }) }, ['42', '--variant', 'exp-a'])
    assert.equal(run.code, 0, text(run))
    assert.equal(calls[0]?.[calls[0].indexOf('--cwd') + 1]?.endsWith(`${BRANCH}-exp-a`), true)
    assert.deepEqual(run.tools.gh.map((args) => args.slice(0, 2).join(' ')), ['issue view'])
    assert.equal(git(repo.bare, 'branch', '--list', `${BRANCH}-exp-a`), '')
    assert.equal(git(repo.root, 'branch', '--list', `${BRANCH}-exp-a`).trim(), `${BRANCH}-exp-a`)
    const copy = join(repo.stateDir, 'blockage-report-tdd-42-exp-a.md')
    assert.equal(readFileSync(copy, 'utf8'), '## Reporte de bloqueo\n')
    assert.match(text(run), new RegExp(`⚠ Hay tests bloqueados que ni implementer ni el reviewer resolvieron -- revisa ${copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} antes de promover esta variante\\.\n`))
    const [entry = {}] = history(repo)
    assert.equal(entry.variant, 'exp-a')
    assert.equal(entry.pr, null)
    assert.match(String(entry.log), /pipeline-\d{8}-\d{6}-exp-a\.log$/)
    const metrics = readdirSync(join(repo.stateDir, 'metrics'))
    assert.ok(metrics.every((name) => name.includes('-issue-42-exp-a-stage-')), metrics.join(','))
    assert.match(text(run), /═══ Pipeline \(variante 'exp-a'\) completado ═══\n\n {2}Commits: 2\n {2}Rama: {4}worktree-issue-42-registrar-turno-exp-a\n {2}Estado: {2}LOCAL -- sin push, sin PR, sin comentario al issue \(modo variante\)\n/)
    assert.match(text(run), /gh pr create --base main --head worktree-issue-42-registrar-turno-exp-a --title "Registrar turno" --body "Closes #42"\n/)
  })

  test('el status de la variante lleva su label en el nombre y en el campo variant', async () => {
    const repo = consumer()
    const { run } = await runSteps(repo, [TEST_WRITER], { tools: tddTools({ tests: [GREEN] }) }, ['42', '--variant', 'exp-b'])
    assert.equal(run.code, 1)
    const status = readJson(statusFile(repo, 'pipeline-status-tdd-42-exp-b.json'))
    assert.equal(status.variant, 'exp-b')
    assert.equal(history(repo)[0]?.variant, 'exp-b')
  })
})

describe('sincronizacion con main, reanudacion, archivo de HU y PR existente', () => {
  test('main avanzo: merge automatico y tests de nuevo', async () => {
    const repo = consumer()
    const advance = (): void => {
      writeFiles(repo.root, { 'docs/otro.md': 'cambio en main\n' })
      git(repo.root, 'add', '-A')
      git(repo.root, 'commit', '-qm', 'otro cambio')
      git(repo.root, 'push', '-q', 'origin', 'main')
    }
    const { run } = await runSteps(repo, [{ ...TEST_WRITER, before: advance }, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /\] main tiene 1 commit\(s\) nuevos\. Haciendo merge\.\.\.\n✓ Merge automático exitoso\n\[.*\] Verificando tests después del merge\.\.\.\n✓ Tests pasan después del merge con main\n/)
  })

  test('un conflicto con main lo resuelve el implementer en el stage merge', async () => {
    const repo = consumer()
    const conflicting = (): void => {
      writeFiles(repo.root, { [`src/${PREFIX}.Turnos/Catalogo.cs`]: 'version de main\n' })
      git(repo.root, 'commit', '-qam', 'main toca el catalogo')
      git(repo.root, 'push', '-q', 'origin', 'main')
    }
    const reviewer = { files: { [`src/${PREFIX}.Turnos/Catalogo.cs`]: 'version de la rama\n' }, commit: 'reviewer' }
    const merge = { files: { [`src/${PREFIX}.Turnos/Catalogo.cs`]: 'resuelto\n' }, commit: 'merge resuelto' }
    const { run, calls, prompts } = await runSteps(repo, [{ ...TEST_WRITER, before: conflicting }, IMPLEMENTER, reviewer, merge], { tools: tddTools({ tests: [RED] }) })
    assert.equal(run.code, 0, text(run))
    assert.equal(agentOf(calls[3] ?? []), 'implementer')
    assert.match(prompts[3] ?? '', /^Estás en el directorio raíz del proyecto Proyecto\.\n\nHay conflictos de merge con la rama main en los siguientes archivos:\nsrc\/Empresa\.Proyecto\.Turnos\/Catalogo\.cs\n/)
    assert.match(text(run), /⚠ Merge con conflictos\. Invocando agente para resolverlos\.\.\.\n[\s\S]*✓ Conflictos resueltos\n/)
    assert.ok(eventsLog(repo).includes('=== STAGE merge: implementer ==='))
  })

  test('--from-stage 2 retoma el worktree de una corrida que fallo en la fase verde', async () => {
    const repo = consumer()
    const failed = await runSteps(repo, [TEST_WRITER, {}], { tools: tddTools({ tests: [RED, RED] }) })
    assert.equal(failed.run.code, 1)
    assert.equal(existsSync(worktreeOf(repo)), true)
    const { run, calls } = await runSteps(repo, [IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [GREEN] }) }, ['42', '--from-stage', '2'])
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(calls.map(agentOf), ['implementer', 'reviewer'])
    assert.match(text(run), /\] Retomando desde Stage 2 — worktree existente: .*worktree-issue-42-registrar-turno\n\[.*\] Snapshot detectado: [0-9a-f]{40}\n\[.*\] Saltando Stage 1 \(--from-stage 2\)\n/)
    assert.match(eventsLog(repo), /─── SESSION \d{8}-\d{6} issue:42 from-stage:2 ───\n/)
  })

  test('--from-stage sin worktree previo aborta', async () => {
    const { run } = await runSteps(consumer(), [], {}, ['42', '--from-stage', '3'])
    assert.match(text(run), /✗ ERROR: No existe el worktree en .*worktree-issue-42-registrar-turno\. No se puede retomar desde Stage 3\.\n/)
  })

  test('--file: rama worktree-tdd-<slug>, status sin issue, PR sin Closes y sin comentar el issue', async () => {
    const repo = consumer()
    writeFiles(repo.root, { 'docs/HU-25 Registrar turno.md': '# HU-25\n\nComo usuario quiero registrar un turno.\n' })
    const { run, prompts } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED] }) }, ['--file', 'docs/HU-25 Registrar turno.md'])
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /\] Archivo: docs\/HU-25 Registrar turno\.md\n/)
    assert.ok((prompts[0] ?? '').includes('Contexto de la historia de usuario a implementar:\n\n# HU-25\n\nComo usuario quiero registrar un turno.\n\nTu tarea'))
    assert.equal(flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--head'), 'worktree-tdd-hu-25-registrar-turno')
    assert.equal(flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--title'), 'HU-25 Registrar turno')
    assert.equal(prBody(run).includes('Closes'), false)
    assert.deepEqual(ghCalls(run, 'issue'), [])
    assert.match(eventsLog(repo), /─── SESSION \d{8}-\d{6} issue:file from-stage:1 ───\n/)
    assert.equal(history(repo)[0]?.issue, '')
  })

  test('un PR abierto de la rama se reutiliza y recibe las metricas', async () => {
    const repo = consumer()
    const tools = tddTools({ tests: [RED], openPr: 'https://github.com/acme/consumidor/pull/3' })
    const { run } = await runSteps(repo, [TEST_WRITER, IMPLEMENTER, REVIEWER], { tools })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    const comment = ghCalls(run, 'pr', 'comment')[0] ?? []
    assert.equal(comment[2], 'https://github.com/acme/consumidor/pull/3')
    assert.match(flag(comment, '--body'), /^## Metricas de la corrida\n\nActualizado: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+\n\n\| Etapa \|/)
    assert.match(text(run), /✓ PR existente reutilizado: https:\/\/github\.com\/acme\/consumidor\/pull\/3\n/)
  })

  test('un PR que no se puede crear aborta tras el push', async () => {
    const { run } = await runSteps(consumer(), [TEST_WRITER, IMPLEMENTER, REVIEWER], { tools: tddTools({ tests: [RED], createdPr: null }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /✗ ERROR: No se pudo crear el PR\n/)
  })
})
