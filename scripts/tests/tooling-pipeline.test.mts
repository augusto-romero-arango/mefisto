// Corridas de extremo a extremo de `tooling-pipeline.mts` sobre un consumidor temporal: guardas,
// camino feliz con el runner real, gates, variante, sincronizacion con main y publicacion del PR.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../lib/cli.mts'
import { loggedThrough, stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { initRepo } from './consumer-sandbox.mts'
import { isolateGitConfig, writeFiles } from './field-note-sandbox.mts'
import {
  eventsLog,
  fakeTools,
  flag,
  guionCalls,
  history,
  newConsumer,
  readJson,
  runTooling,
  runWith,
  runnerDouble,
} from './tooling-pipeline-sandbox.mts'
import type { Consumer, PipelineRun } from './tooling-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto tooling pipeline ')))
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

const git = (cwd: string, ...args: string[]): string => capture('git', args, { cwd }).stdout.replace(/\n+$/, '')
const text = (run: PipelineRun): string => stripAnsi(run.out)
const ghCalls = (run: PipelineRun, ...command: string[]): string[][] =>
  run.tools.gh.filter((args) => command.every((word, index) => args[index] === word))

const BRANCH = 'worktree-issue-42-agregar-workflow-de-ci'
const WRITER = { files: { 'scripts/ci.sh': 'echo ci\n' }, commit: 'agregar script de ci' }
const REVIEWER = { files: { 'docs/ci.md': 'Notas de CI\n' } }
const statusFile = (repo: Consumer, name = 'pipeline-status-tooling-42.json'): string => join(repo.stateDir, name)
const worktreeOf = (repo: Consumer, branch = BRANCH): string => join(repo.stateDir, 'worktrees', branch)

/** Corre con el runner en proceso: mismo pipeline, sin lanzar procesos de agente. */
function runDouble(repo: Consumer, argv: string[], steps: object[], options: Parameters<typeof runTooling>[2] = {}): Promise<PipelineRun> {
  return runTooling(repo, argv, { ...options, deps: { launchRunner: runnerDouble(steps).launch, ...options.deps } })
}

describe('guardas previas', () => {
  test('sin argumentos muestra el uso y sale con 1', async () => {
    const run = await runTooling(consumer(), [])
    assert.equal(run.code, 1)
    assert.equal(
      run.out,
      "Uso: scripts/tooling-pipeline.mts [--issue NUM | NUM] [--from-stage N] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]\n",
    )
  })

  test('fuera de un repo git se niega', async () => {
    const repo = consumer()
    const outside = mkdtempSync(join(work, 'sin-git-'))
    const run = await runTooling({ ...repo, root: outside }, ['42'])
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no estas en un repositorio git\n')
    assert.equal(run.out, '')
  })

  test('en el repo de Mefisto se niega: el pipeline publicado solo aplica al consumidor', async () => {
    const repo = consumer({ '.claude-plugin/plugin.json': '{"name":"mefisto"}\n' })
    const run = await runTooling(repo, ['42'])
    assert.equal(run.code, 1)
    assert.equal(
      run.err,
      'ERROR: scripts/tooling-pipeline.sh es del plugin publicado y solo aplica al consumidor.\n' +
        'Estas en el repo de Mefisto. Para mejorar el plugin, usa .claude/scripts/mefisto-tooling-pipeline.sh.\n',
    )
    assert.deepEqual(run.tools.gh, [])
    assert.equal(existsSync(repo.stateDir), false, 'no deja estado')
  })

  test('sin harness.config.json informa el config requerido', async () => {
    const root = initRepo(join(work, `sin-config-${++counter}`), { 'README.md': 'x\n' })
    const repo = { root, bare: '', guionFile: join(work, 'guion-sin-config.json'), stateDir: join(root, '.mefisto', 'pipeline') }
    const run = await runTooling(repo, ['42'])
    assert.equal(run.code, 1)
    assert.match(run.err, /^ERROR: no se encontro el config canonico requerido .*harness\.config\.json\.\n/)
  })
})

describe('como proceso', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..')
  const USAGE = /^Uso: .*tooling-pipeline\.mts \[--issue NUM \| NUM\] \[--from-stage N\] \[--models 'agente=modelo\[,agente=modelo\.\.\.\]'\] \[--variant <label>\]\n$/

  test('el modulo corre directo con Node y sale con 1 mostrando el uso', () => {
    const repo = consumer()
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'tooling-pipeline.mts')], { cwd: repo.root })
    assert.equal(result.status, 1)
    assert.match(result.stdout, USAGE)
    assert.equal(result.stderr, '')
  })

  test('la copia distribuida en dist/claude carga toda su clausura', () => {
    const repo = consumer()
    const result = capture(process.execPath, [join(REPO_ROOT, 'dist', 'claude', 'scripts', 'tooling-pipeline.mts'), '42', '--raro'], { cwd: repo.root })
    assert.equal(result.status, 1, result.stderr)
    assert.match(stripAnsi(result.stdout), /x ERROR: Argumento no reconocido: --raro\n/)
  })

  test('tooling-pipeline.sh es el shim que lo lanza con sus argumentos', { skip: process.platform === 'win32' }, () => {
    const repo = consumer()
    const result = capture('bash', [join(REPO_ROOT, 'scripts', 'tooling-pipeline.sh'), '42', '--from-stage', '9'], { cwd: repo.root })
    assert.equal(result.status, 1)
    assert.match(stripAnsi(result.stdout), /x ERROR: --from-stage debe ser 1 o 2 \(recibido: 9\)\n/)
  })

  test('en el repo de Mefisto el proceso se niega', () => {
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'tooling-pipeline.mts'), '42'], { cwd: REPO_ROOT })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: scripts\/tooling-pipeline\.sh es del plugin publicado y solo aplica al consumidor\.\n/)
  })
})

describe('argumentos y frontera neutral: abortan antes de crear el worktree y sin dejar status', () => {
  const CASES: { name: string; argv: string[]; env?: NodeJS.ProcessEnv; missing?: string; error: RegExp }[] = [
    { name: 'argumento desconocido', argv: ['42', '--raro'], error: /x ERROR: Argumento no reconocido: --raro\n/ },
    { name: '--issue sin valor', argv: ['--issue'], error: /x ERROR: Falta el numero de issue\n/ },
    { name: '--from-stage sin valor', argv: ['42', '--from-stage'], error: /x ERROR: Falta el numero de stage\n/ },
    { name: '--status-file sin valor', argv: ['42', '--status-file'], error: /x ERROR: Falta el nombre del archivo de status\n/ },
    { name: '--models sin valor', argv: ['42', '--models'], error: /x ERROR: Falta el valor de --models\n/ },
    { name: '--variant sin valor', argv: ['42', '--variant'], error: /x ERROR: Falta el valor de --variant\n/ },
    { name: 'sin issue', argv: ['--from-stage', '2'], error: /x ERROR: Falta el numero de issue\n/ },
    { name: '--from-stage fuera de rango', argv: ['42', '--from-stage', '3'], error: /x ERROR: --from-stage debe ser 1 o 2 \(recibido: 3\)\n/ },
    {
      name: '--variant con mayusculas',
      argv: ['42', '--variant', 'Experimento'],
      error: /x ERROR: --variant mal formado: el label de --variant 'Experimento' es invalido: solo minusculas, digitos y guiones \(\[a-z0-9-\]\)\n/,
    },
    {
      name: '--variant de mas de 40 caracteres',
      argv: ['42', '--variant', 'a'.repeat(41)],
      error: /x ERROR: --variant mal formado: el label de --variant 'a{41}' supera 40 caracteres\n/,
    },
    {
      name: 'timeout que no es un entero',
      argv: ['42'],
      env: { MEFISTO_AGENT_TIMEOUT_SECONDS: '30s' },
      error: /x ERROR: MEFISTO_AGENT_TIMEOUT_SECONDS '30s' no es un entero\n/,
    },
    {
      name: 'timeout en cero',
      argv: ['42'],
      env: { MEFISTO_AGENT_TIMEOUT_SECONDS: '0' },
      error: /x ERROR: MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0\n/,
    },
    { name: 'falta dotnet', argv: ['42'], missing: 'dotnet', error: /x ERROR: Falta comando requerido: dotnet\n/ },
    { name: 'falta gh', argv: ['42'], missing: 'gh', error: /x ERROR: Falta comando requerido: gh\n/ },
    {
      name: 'runner alterno que no existe',
      argv: ['42'],
      env: { MEFISTO_RUN_AGENT_BIN: join(tmpdir(), 'no-existe-runner') },
      error: /x ERROR: No es ejecutable el runner neutral: .*no-existe-runner\n/,
    },
    {
      name: 'runtime sin adaptador',
      argv: ['42'],
      env: { MEFISTO_RUNTIME: 'inexistente' },
      error: /x ERROR: No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador \(.*runtime-inexistente\.mts\): fija MEFISTO_RUNTIME a un runtime soportado\n/,
    },
  ]
  for (const { name, argv, env, missing, error } of CASES) {
    test(name, async () => {
      const repo = consumer()
      const run = await runTooling(repo, argv, {
        ...(env === undefined ? {} : { env }),
        deps: { hasCommand: (command) => command !== missing },
      })
      assert.equal(run.code, 1)
      assert.match(text(run), error)
      assert.match(text(run), /Revisa el log: .*tooling-pipeline-\d{8}-\d{6}(-\w+)?\.log\n/)
      assert.deepEqual(run.tools.gh, [], 'no consulta GitHub')
      assert.equal(existsSync(join(repo.stateDir, 'worktrees')), false, 'no crea worktree')
      assert.deepEqual(
        readdirSync(repo.stateDir).filter((entry) => entry !== 'logs'),
        [],
        'ni status, ni historial, ni events.log',
      )
    })
  }

  test('un numero suelto es el issue y --issue gana sobre el', async () => {
    const run = await runDouble(consumer(), ['7', '--issue', '42'], [WRITER, REVIEWER])
    assert.equal(run.code, 0)
    assert.deepEqual(ghCalls(run, 'issue', 'view')[0]?.slice(0, 3), ['issue', 'view', '42'])
  })
})

describe('camino feliz con el runner real', () => {
  let repo: Consumer
  let run: PipelineRun

  before(async () => {
    repo = consumer()
    // Un diff de mas de 3 MB: el reviewer debe recibir el resumen, nunca el diff.
    const generated = Array.from({ length: 50_000 }, (_, index) => `linea ${index} de contenido generado por el writer para inflar el diff\n`).join('')
    run = await runTooling(repo, ['42'], {
      guion: [{ files: { 'scripts/ci.sh': 'echo ci\n', 'scaffold/generated.txt': generated }, commit: 'agregar script de ci' }, REVIEWER],
    })
  })

  test('termina bien e invoca al writer y al reviewer por su id neutral', () => {
    assert.equal(run.code, 0, run.out + run.err)
    assert.deepEqual(
      guionCalls(repo).map((call) => call.agent),
      ['tooling-writer', 'tooling-reviewer'],
    )
    for (const call of guionCalls(repo)) {
      assert.equal(call.cwd.endsWith(join('worktrees', BRANCH)), true, 'el agente corre en el worktree')
      assert.match(call.system, /^You are running in non-interactive print mode\./)
      assert.equal(call.model, '', 'sin modelo resuelto no se pasa --model')
      assert.equal(call.effort, '', 'sin effort resuelto no se pasa --effort')
      assert.equal(call.resume, '')
    }
  })

  test('anuncia el modelo de cada invocacion', () => {
    assert.match(text(run), /\] Invocando writer \(modelo: <heredado>\)\.\.\.\n/)
    assert.match(text(run), /\] Invocando reviewer \(modelo: <heredado>\)\.\.\.\n/)
  })

  test('el writer recibe el issue y el commit base', () => {
    const [writer] = guionCalls(repo)
    const base = git(repo.bare, 'rev-parse', 'main')
    assert.match(writer?.prompt ?? '', /^Estas en el directorio raiz del proyecto consumidor Proyecto \(un consumidor del plugin Mefisto\)\./)
    assert.ok(writer?.prompt.includes('# Issue #42: Agregar workflow de CI\n\nCuerpo del issue.\n\nCommit base: ' + base))
    assert.ok(writer?.prompt.includes('gh issue create -R augusto-romero-arango/mefisto --label "estado:borrador,tipo:tooling"'))
  })

  test('el reviewer recibe SHA, stat y rutas del cambio, no el diff', () => {
    const reviewer = guionCalls(repo)[1]?.prompt ?? ''
    const base = git(repo.bare, 'rev-parse', 'main')
    const writerHead = git(repo.bare, 'rev-parse', `${BRANCH}~1`)
    assert.ok(Buffer.byteLength(reviewer) < 65_536, `prompt de ${Buffer.byteLength(reviewer)} bytes`)
    assert.ok(reviewer.includes(`Commit base: ${base}\nHEAD del writer: ${writerHead}\n`))
    assert.ok(reviewer.includes('A\tscaffold/generated.txt\nA\tscripts/ci.sh'))
    assert.ok(reviewer.includes(' scaffold/generated.txt | 50000 '))
    assert.equal(reviewer.includes('diff --git'), false)
    assert.equal(reviewer.includes('@@'), false)
  })

  test('la rama queda en el remoto con el commit del writer y el commit de seguridad del reviewer', () => {
    assert.equal(git(repo.bare, 'log', '--format=%s', BRANCH, '-2'), 'tooling(#42): revision y correcciones\nagregar script de ci')
    assert.equal(git(repo.bare, 'show', '--name-only', '--format=', BRANCH), 'docs/ci.md')
    assert.match(text(run), /\] Haciendo commit automatico \(fase reviewer\)\.\.\.\n/)
    assert.equal(text(run).includes('(fase writer)'), false, 'el writer ya habia commiteado')
  })

  test('crea el PR hacia main con el titulo del issue y comenta el issue', () => {
    const [create = []] = ghCalls(run, 'pr', 'create')
    assert.equal(flag(create, '--title'), 'Agregar workflow de CI')
    assert.equal(flag(create, '--head'), BRANCH)
    assert.equal(flag(create, '--base'), 'main')
    assert.equal(flag(create, '--repo'), repo.bare)
    const body = flag(create, '--body')
    assert.match(body, /^## Resumen\n\nPipeline tooling completado:\n/)
    assert.match(body, /<summary>Writer -- 0m \d+s<\/summary>\n\n_\(El agente no genero resumen\)_\n/)
    assert.match(body, /## Commits\n\n[0-9a-f]{7,} tooling\(#42\): revision y correcciones\n[0-9a-f]{7,} agregar script de ci\n\n## Metricas de la corrida\n\n\| Etapa \|/)
    assert.match(body, /\nCloses #42$/)
    assert.deepEqual(ghCalls(run, 'pr', 'list')[0], ['pr', 'list', '--head', BRANCH, '--base', 'main', '--state', 'open', '--json', 'url', '--repo', repo.bare])
    const [comment = []] = ghCalls(run, 'issue', 'comment')
    assert.equal(comment[2], '42')
    assert.equal(flag(comment, '--body'), 'Pipeline tooling completado. PR: https://github.com/acme/consumidor/pull/7')
    assert.deepEqual(ghCalls(run, 'pr', 'comment'), [])
  })

  test('cierra: status borrado, worktree eliminado, historial completado y resumen final', () => {
    assert.equal(existsSync(statusFile(repo)), false)
    assert.equal(existsSync(worktreeOf(repo)), false)
    const entries = history(repo)
    assert.equal(entries.length, 1)
    const [entry = {}] = entries
    assert.deepEqual(Object.keys(entry), ['issue', 'title', 'pipeline', 'variant', 'identity', 'runtime', 'started', 'finished', 'state', 'agents', 'tests', 'pr', 'log'])
    assert.equal(entry.issue, '42')
    assert.equal(entry.title, 'Agregar workflow de CI')
    assert.equal(entry.pipeline, 'tooling')
    assert.equal(entry.variant, null)
    assert.equal(entry.runtime, 'guion')
    assert.equal(entry.state, 'completed')
    assert.equal(entry.tests, null)
    assert.equal(entry.pr, 'https://github.com/acme/consumidor/pull/7')
    assert.match(String(entry.started), /^\d{8}-\d{6}$/)
    assert.match(String(entry.finished), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/)
    assert.equal(entry.log, join(repo.stateDir, 'logs', `tooling-pipeline-${String(entry.started)}.log`))
    assert.match(
      text(run),
      /\n=== Pipeline tooling completado ===\n\n {2}Commits: 2\n {2}Rama: {4}worktree-issue-42-agregar-workflow-de-ci\n {2}PR: {6}https:\/\/github\.com\/acme\/consumidor\/pull\/7\n {2}Log: {5}.*\.log\n\n$/,
    )
    assert.match(text(run), /-- Cleanup --\n\[.*\] Eliminando worktree\.\.\.\nv Worktree eliminado\n/)
  })

  test('la identidad se valida contra el runtime activo y viaja como objeto, nunca plana', () => {
    const [entry = {}] = history(repo)
    // El manifiesto de este repo es de otro runtime: no se infiere nada.
    assert.deepEqual(entry.identity, { harness_version: null, harness_commit: null, identity_state: 'metadata_invalid' })
    assert.equal('harness_version' in entry, false)
    assert.match(text(run), /^! Identidad de distribucion degradada: metadata ausente o invalida; version\/commit se registran como null\n/)
  })

  test('cada stage deja duracion y metricas enriquecidas en el historial y en su archivo', () => {
    const [entry = {}] = history(repo)
    const agents = entry.agents as Record<string, { duration: number; metrics: Record<string, unknown> }>
    assert.deepEqual(Object.keys(agents), ['writer', 'reviewer'])
    for (const [role, agent, profile, stage] of [['writer', 'tooling-writer', 'balanced', '1'], ['reviewer', 'tooling-reviewer', 'deep', '2']] as const) {
      const metrics = agents[role]?.metrics ?? {}
      assert.equal(typeof agents[role]?.duration, 'number')
      assert.equal(metrics.pipeline, 'tooling')
      assert.equal(metrics.issue, '42')
      assert.equal(metrics.variant, null)
      assert.equal(metrics.stage, stage)
      assert.equal(metrics.agent, agent)
      assert.equal(metrics.profile, profile)
      assert.equal(metrics.runtime, 'guion')
      assert.equal(metrics.inherited, true)
      assert.equal(metrics.result, 'success')
      assert.equal(metrics.identity_state, 'metadata_invalid')
      const file = join(repo.stateDir, 'metrics', `tooling-stage-${stage}-${role}-${String(entry.started)}-issue-42.json`)
      assert.deepEqual(readJson(file), metrics)
    }
  })

  test('cada intento conserva su JSONL neutral y el log del stage se deriva de el', () => {
    const [entry = {}] = history(repo)
    const logs = join(repo.stateDir, 'logs')
    for (const stage of ['1-writer', '2-reviewer']) {
      const base = join(logs, `tooling-stage-${stage}-${String(entry.started)}-issue-42`)
      const events = readFileSync(`${base}-attempt-1.events.jsonl`, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { type: string })
      assert.deepEqual([events[0]?.type, events.at(-1)?.type], ['run.started', 'run.completed'])
      assert.equal(readFileSync(`${base}.log`, 'utf8'), 'success\n')
    }
  })

  test('events.log abre la sesion, anota modelos y effort resueltos y la telemetria del runner', () => {
    const log = eventsLog(repo)
    assert.match(log, /^=== SESSION TOOLING \d{8}-\d{6} issue:42 from-stage:1 ===\n/)
    assert.match(log, /\[\d\d:\d\d:\d\d\] MODELS: writer runtime=guion perfil=balanced solicitado=<automatico> resuelto='<heredado>'\n/)
    assert.match(log, /\[\d\d:\d\d:\d\d\] MODELS: reviewer runtime=guion perfil=deep solicitado=<automatico> resuelto='<heredado>'\n/)
    assert.match(log, /\[\d\d:\d\d:\d\d\] EFFORTS: writer -> <heredado> \(nivel light\)\n/)
    assert.match(log, /\[\d\d:\d\d:\d\d\] EFFORTS: reviewer -> <heredado> \(nivel standard\)\n/)
    assert.match(log, /\[\d\d:\d\d:\d\d\]\[stage\] tooling-writer success\n/)
    assert.match(log, /\[\d\d:\d\d:\d\d\]\[stage\] tooling-reviewer success\n/)
  })

  test('el log del pipeline lleva la cabecera y los mensajes sin color', () => {
    const [entry = {}] = history(repo)
    const log = readFileSync(String(entry.log), 'utf8')
    assert.ok(log.startsWith(`Pipeline tooling iniciado: ${String(entry.started)}\n`))
    assert.match(log, /\n-- Stage 1: Writer \(implementacion\) --\n/)
    assert.equal(log.includes('\u001b['), false)
  })

  test('no deja nada bajo el estado del worktree en el remoto', () => {
    assert.equal(git(repo.bare, 'ls-tree', '-r', '--name-only', BRANCH).includes('.mefisto/pipeline'), false)
  })
})

describe('issue', () => {
  test('si gh no devuelve el issue aborta y deja el fallo en status e historial', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [], { tools: fakeTools({ issue: null }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: No se pudo obtener el issue #42\n/)
    assert.match(text(run), /Ultimas 20 lineas del log:\n(.*\n)*GraphQL: Could not resolve to an Issue\n/, 'la causa de gh viaja con el aborto')
    const status = readJson(statusFile(repo))
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, 'setup')
    assert.equal(status.last_error, 'No se pudo obtener el issue #42 ')
    const [entry = {}] = history(repo)
    assert.equal(entry.state, 'failed')
    assert.equal(entry.error, 'No se pudo obtener el issue #42 ')
    assert.equal(entry.log, status.log)
    assert.equal(existsSync(join(repo.stateDir, 'worktrees')), false)
  })

  test('un issue que no esta abierto no se procesa', async () => {
    const run = await runDouble(consumer(), ['42'], [], { tools: fakeTools({ issue: { number: 42, title: 'Cerrado', body: '', state: 'CLOSED' } }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: El issue #42 esta CLOSED -- solo se procesan issues abiertos\.\n/)
  })

  test('el titulo define la rama: slug de 40 caracteres como maximo', async () => {
    const repo = consumer()
    const tools = fakeTools({ issue: { number: 42, title: 'Refactorizar el Pipeline de tooling para soportar variantes!', body: 'x', state: 'OPEN' } })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { tools })
    assert.equal(run.code, 0)
    assert.equal(flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--head'), 'worktree-issue-42-refactorizar-el-pipeline-de-tooling-para')
  })
})

describe('writer sin cambios', () => {
  const noChanges = (summary?: string): object[] => [summary === undefined ? {} : { files: { '.mefisto/pipeline/summaries/stage-1-writer.md': summary } }]

  test('aborta, deja el worktree y muestra solo la seccion Pendiente/bloqueos del resumen', async () => {
    const repo = consumer()
    const summary = '## Implementado\n\nNada.\n\n## Pendiente/bloqueos\n\nBLOQUEO-CENTINELA-1315\n\nDetalle del bloqueo.\n\n## Verificacion\n\nNo aplica.\n'
    const run = await runDouble(repo, ['42'], noChanges(summary))
    assert.equal(run.code, 1)
    assert.match(text(run), /Pendiente\/bloqueos informado por el writer:\n\nBLOQUEO-CENTINELA-1315\n\nDetalle del bloqueo\.\n\nx ERROR: El writer no genero ningun cambio\. Revisa el log: .*tooling-stage-1-writer-\d{8}-\d{6}-issue-42\.log\n/)
    assert.equal(text(run).includes('Nada.'), false)
    assert.equal(text(run).includes('No aplica.'), false)
    assert.match(text(run), /El worktree queda en: .*\nPara inspeccionar: cd .*\n/)
    assert.equal(existsSync(worktreeOf(repo)), true)
    const status = readJson(statusFile(repo))
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, '1-writer')
    assert.equal(status.worktree, worktreeOf(repo))
  })

  for (const [name, summary] of [
    ['sin resumen', undefined],
    ['sin la seccion', '## Implementado\n\nSin cambios.\n'],
    ['con la seccion vacia', '## Pendiente/bloqueos\n\n## Verificacion\n\nNo aplica.\n'],
  ] as const) {
    test(`${name} conserva el aborto generico, sin bloqueos`, async () => {
      const run = await runDouble(consumer(), ['42'], noChanges(summary))
      assert.equal(run.code, 1)
      assert.match(text(run), /x ERROR: El writer no genero ningun cambio\./)
      assert.equal(text(run).includes('Pendiente/bloqueos informado'), false)
    })
  }

  test('un cambio solo de documentacion cuenta como trabajo', async () => {
    const run = await runDouble(consumer(), ['42'], [{ files: { 'docs/adr/ca-adr-0001.md': 'decision\n' } }, {}])
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /\] Haciendo commit automatico \(fase writer\)\.\.\.\n/)
  })
})

describe('gates de C#', () => {
  const CSHARP = { files: { 'src/Dominio/A.cs': 'class A {}\n' }, commit: 'agregar clase' }
  const withTests = (): Consumer => consumer({ 'tests/Empresa.Proyecto.Ventas.Tests/T.cs': 'class T {}\n' })

  test('sin cambios en C# no compila ni corre tests', async () => {
    const run = await runDouble(consumer(), ['42'], [WRITER, REVIEWER])
    assert.deepEqual(run.tools.dotnet, [])
    assert.match(text(run), /\] No hay cambios en C# -- saltando gate de compilacion\n/)
    assert.match(text(run), /\] No hay cambios en C# -- saltando gate de tests\n/)
  })

  test('con C# compila tras el writer, corre los tests tras el reviewer y registra el conteo', async () => {
    const repo = withTests()
    const run = await runDouble(repo, ['42'], [CSHARP, REVIEWER])
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(run.tools.dotnet[0], ['build', worktreeOf(repo)])
    assert.deepEqual(run.tools.dotnet[1]?.slice(0, 2), ['test', '--project'])
    assert.match(text(run), /\] Gate: verificando compilacion\.\.\.\nv Gate 1: compilacion exitosa\n/)
    assert.match(text(run), /\] Gate: verificando compilacion y tests\.\.\.\n\[.*\] Tests pasando: 3\nv Gate 2: compilacion y tests OK\n/)
    assert.equal(history(repo)[0]?.tests, 3)
    assert.match(readFileSync(String(history(repo)[0]?.log), 'utf8'), /salida de dotnet build\n/)
    assert.match(readFileSync(String(history(repo)[0]?.log), 'utf8'), /Passed!  - Failed: 0, Passed: 3, Skipped: 0, Total: 3\n/)
  })

  test('C# sin commitear tambien dispara el gate de compilacion', async () => {
    const run = await runDouble(withTests(), ['42'], [{ files: { 'src/B.cs': 'class B {}\n' } }, {}])
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /v Gate 1: compilacion exitosa\n/)
  })

  test('si no compila tras el writer aborta en el Stage 1', async () => {
    const repo = withTests()
    const run = await runDouble(repo, ['42'], [CSHARP], { tools: fakeTools({ buildStatus: 1 }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: Stage 1 fallido: el proyecto no compila despues del writer\.\n/)
    assert.equal(readJson(statusFile(repo)).stage, '1-writer')
  })

  test('si los tests fallan tras el reviewer muestra su cola y aborta con el codigo', async () => {
    const repo = withTests()
    const output = `${Array.from({ length: 30 }, (_, index) => `salida ${index + 1}`).join('\n')}\nFailed!  - Failed: 1, Passed: 2\n`
    const run = await runDouble(repo, ['42'], [CSHARP, REVIEWER], { tools: fakeTools({ test: { status: 2, output } }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /\nsalida 12\n(salida \d+\n)*Failed!  - Failed: 1, Passed: 2\n\nx ERROR: Stage 2 fallido: tests fallan despues del reviewer \(exit code: 2\)\.\n/)
    assert.equal(text(run).includes('salida 11\n'), false, 'solo las ultimas 20 lineas')
    assert.equal(readJson(statusFile(repo)).stage, '2-reviewer')
  })

  test('un conteo que no se reconoce queda como ? en pantalla y null en el historial', async () => {
    const repo = withTests()
    const run = await runDouble(repo, ['42'], [CSHARP, REVIEWER], { tools: fakeTools({ test: { status: 0, output: 'sin resumen\n' } }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /\] Tests pasando: \?\n/)
    assert.equal(history(repo)[0]?.tests, null)
  })
})

describe('gate de scope del consumidor', () => {
  test('un writer que toca rutas del plugin aborta con el diagnostico y conserva el trabajo', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [{ files: { 'commands/nuevo.md': 'x\n', 'scripts/ok.sh': 'y\n' }, commit: 'cambios' }])
    assert.equal(run.code, 1)
    assert.match(run.err, /^ERROR: el agente toco rutas reservadas al plugin Mefisto:\n {2}- commands\/nuevo\.md\n/)
    assert.match(run.err, /pertenecen al plugin \(repo augusto-romero-arango\/mefisto\)\./)
    assert.match(run.err, new RegExp(`ya quedo commiteado en '${BRANCH}'`))
    assert.match(text(run), /x ERROR: Stage 1 fallido: el writer toco rutas reservadas al plugin Mefisto\.\n/)
    assert.deepEqual(ghCalls(run, 'pr'), [])
    assert.equal(git(repo.bare, 'branch', '--list', BRANCH), '', 'no se publica la rama')
  })

  test('un reviewer que toca rutas del plugin aborta en el Stage 2', async () => {
    const run = await runDouble(consumer(), ['42'], [WRITER, { files: { 'dist/claude/x.md': 'x\n' } }])
    assert.equal(run.code, 1)
    assert.match(run.err, /- dist\/claude\/x\.md\n/)
    assert.match(text(run), /x ERROR: Stage 2 fallido: el reviewer toco rutas reservadas al plugin Mefisto\.\n/)
  })

  test('el diagnostico nombra el repo del plugin que declara el config', async () => {
    const repo = consumer({ '.mefisto/harness.config.json': `${JSON.stringify({ projectName: 'P', namespacePrefix: 'E.P', solutionFile: 'P.slnx', domainLabels: ['a'], boundedContext: { name: 'B', domains: ['a'] }, repoSlug: 'acme/mefisto-fork' })}\n` })
    const double = runnerDouble([{ files: { 'agents/x.md': 'x\n' } }])
    const run = await runTooling(repo, ['42'], { deps: { launchRunner: double.launch } })
    assert.match(run.err, /pertenecen al plugin \(repo acme\/mefisto-fork\)\./)
    assert.ok(double.prompts[0]?.includes('gh issue create -R acme/mefisto-fork --label'))
  })
})

describe('modo variante', () => {
  let repo: Consumer
  let run: PipelineRun

  before(async () => {
    repo = consumer()
    run = await runTooling(repo, ['42', '--variant', 'exp-a'], { guion: [WRITER, REVIEWER] })
  })

  test('la rama lleva el sufijo y queda local: sin push, sin PR y sin comentario al issue', () => {
    assert.equal(run.code, 0, run.out + run.err)
    assert.equal(git(repo.root, 'log', '--format=%s', `${BRANCH}-exp-a`, '-1'), 'tooling(#42): revision y correcciones')
    assert.equal(git(repo.bare, 'branch', '--list', `${BRANCH}-exp-a`), '')
    assert.deepEqual(
      run.tools.gh.map((args) => args.slice(0, 2).join(' ')),
      ['issue view'],
    )
    assert.equal(guionCalls(repo)[0]?.cwd.endsWith(join('worktrees', `${BRANCH}-exp-a`)), true)
  })

  test('status, log del pipeline, logs de stage y metricas llevan el label', () => {
    const [entry = {}] = history(repo)
    const stamp = String(entry.started)
    assert.equal(entry.variant, 'exp-a')
    assert.equal(entry.pr, null)
    assert.equal(entry.log, join(repo.stateDir, 'logs', `tooling-pipeline-${stamp}-exp-a.log`))
    assert.ok(existsSync(join(repo.stateDir, 'logs', `tooling-stage-1-writer-${stamp}-issue-42-exp-a.log`)))
    assert.ok(existsSync(join(repo.stateDir, 'logs', `tooling-stage-2-reviewer-${stamp}-issue-42-exp-a-attempt-1.events.jsonl`)))
    assert.equal(readJson(join(repo.stateDir, 'metrics', `tooling-stage-1-writer-${stamp}-issue-42-exp-a.json`)).variant, 'exp-a')
  })

  test('anuncia el modo y explica como promover la variante', () => {
    assert.match(text(run), /\] Modo variante: 'exp-a' -- sin push, sin PR, sin comentario al issue \(CA-3\); rama queda local\n/)
    assert.match(eventsLog(repo), /\[\d\d:\d\d:\d\d\] VARIANT: exp-a\n/)
    assert.match(text(run), /-- Modo variante: sin PR --\n! Variante 'exp-a': se omiten push, creacion de PR y comentario al issue \(CA-3\)\.\n\[.*\] La rama 'worktree-issue-42-agregar-workflow-de-ci-exp-a' queda LOCAL -- no se publica a origin\.\n/)
    assert.ok(
      text(run).endsWith(
        [
          "=== Pipeline tooling (variante 'exp-a') completado ===",
          '',
          '  Commits: 2',
          `  Rama:    ${BRANCH}-exp-a`,
          '  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)',
          `  Log:     ${String(history(repo)[0]?.log)}`,
          '',
          'Si esta variante gana la comparacion, promuevela a mano:',
          `  git -C ${repo.root} push -u origin ${BRANCH}-exp-a`,
          `  gh pr create --base main --head ${BRANCH}-exp-a --title "Agregar workflow de CI" --body "Closes #42"`,
          'O relanza el pipeline sin --variant para que una corrida normal abra el PR.',
          '',
          '',
        ].join('\n'),
      ),
    )
  })

  test('el status de una variante que falla no pisa el del issue', async () => {
    const other = consumer()
    const failed = await runDouble(other, ['42', '--variant', 'b'], [{}])
    assert.equal(failed.code, 1)
    assert.equal(readJson(statusFile(other, 'pipeline-status-tooling-42-b.json')).variant, 'b')
    assert.equal(existsSync(statusFile(other)), false)
    assert.equal(history(other)[0]?.variant, 'b')
  })

  test('--status-file fija el nombre del status', async () => {
    const other = consumer()
    await runDouble(other, ['42', '--status-file', 'pipeline-status-lote.json'], [{}])
    assert.equal(readJson(statusFile(other, 'pipeline-status-lote.json')).state, 'failed')
  })
})

describe('PR', () => {
  test('un PR abierto de la rama se reutiliza y recibe la tabla de metricas en un comentario', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { tools: fakeTools({ openPr: 'https://github.com/acme/consumidor/pull/3' }) })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /v PR existente reutilizado: https:\/\/github\.com\/acme\/consumidor\/pull\/3\n/)
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    const [comment = []] = ghCalls(run, 'pr', 'comment')
    assert.equal(comment[2], 'https://github.com/acme/consumidor/pull/3')
    assert.equal(flag(comment, '--repo'), repo.bare)
    assert.match(flag(comment, '--body'), /^## Metricas de la corrida\n\nActualizado: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+\n\n\| Etapa \| Modelo \| Tokens \|.*\n(.*\n)*\| \*\*Total.*\|$/)
    assert.equal(flag(ghCalls(run, 'issue', 'comment')[0] ?? [], '--body'), 'Pipeline tooling completado. PR: https://github.com/acme/consumidor/pull/3')
    assert.equal(history(repo)[0]?.pr, 'https://github.com/acme/consumidor/pull/3')
  })

  test('no poder comentar las metricas ni el issue solo advierte', async () => {
    const tools = fakeTools({ openPr: 'https://github.com/acme/consumidor/pull/3', failing: ['pr comment', 'issue comment'] })
    const run = await runDouble(consumer(), ['42'], [WRITER, REVIEWER], { tools })
    assert.equal(run.code, 0)
    assert.match(text(run), /! No se pudo publicar las metricas en el PR reutilizado: https:\/\/github\.com\/acme\/consumidor\/pull\/3\n/)
    assert.match(text(run), /! No se pudo comentar en el issue #42\n/)
  })

  test('si gh no crea el PR aborta, con la rama ya publicada', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { tools: fakeTools({ createdPr: null }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: No se pudo crear el PR\n/)
    assert.match(text(run), /pull request create failed\n/)
    assert.notEqual(git(repo.bare, 'branch', '--list', BRANCH), '')
    assert.equal(readJson(statusFile(repo)).stage, '2-reviewer')
  })

  test('si no puede publicar la rama aborta antes de tocar GitHub', async () => {
    const repo = consumer()
    const tools = fakeTools()
    const real = runWith(tools)
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], {
      tools,
      deps: {
        runLogged: loggedThrough((command, args, options) =>
          args.includes('push') ? { status: 1, stdout: '', stderr: 'remote: rechazado\n' } : real(command, args, options),
        ),
      },
    })
    assert.equal(run.code, 1)
    assert.match(text(run), new RegExp(`x ERROR: No se pudo hacer push de la rama ${BRANCH}\\n`))
    assert.deepEqual(ghCalls(run, 'pr'), [])
  })

  test('el cuerpo incluye el resumen de cada agente y los warnings remanentes entre decisiones y commits', async () => {
    const steps = [
      { ...WRITER, files: { ...WRITER.files, '.mefisto/pipeline/summaries/stage-1-writer.md': '## Implementado\n\n- Script de CI\n', '.mefisto/pipeline/warnings-remanentes.txt': '#77\n' } },
      { files: { 'docs/ci.md': 'x\n', '.mefisto/pipeline/summaries/stage-2-reviewer.md': 'Todo en orden.\n\n' } },
    ]
    const run = await runDouble(consumer(), ['42'], steps)
    const body = flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--body')
    assert.match(body, /<summary>Writer -- 0m \d+s<\/summary>\n\n## Implementado\n\n- Script de CI\n\n<\/details>\n\n<details>\n<summary>Reviewer -- 0m \d+s<\/summary>\n\nTodo en orden\.\n\n<\/details>\n\n## Warnings remanentes\n\n- Relacionado: #77\n\n## Commits\n/)
  })

  test('si no puede registrar el historial advierte, deja evidencia y termina bien', async () => {
    const repo = consumer()
    mkdirSync(join(repo.stateDir, 'pipeline-history.jsonl'), { recursive: true })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER])
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! No se pudo registrar el historial completado; el PR ya fue creado\n/)
    assert.match(eventsLog(repo), /\[\d\d:\d\d:\d\d\] WARN: no se pudo registrar el historial completado; el PR ya fue creado\n/)
    assert.equal(statSync(join(repo.stateDir, 'pipeline-history.jsonl')).isDirectory(), true)
  })
})

describe('sincronizacion con main', () => {
  /** Hace avanzar `main` en el remoto justo antes de que el pipeline lo traiga para sincronizar. */
  function advancingMain(repo: Consumer, files: Record<string, string>, tools = fakeTools()) {
    const real = runWith(tools)
    let advanced = false
    const runLogged = loggedThrough((command, args, options) => {
      if (!advanced && command === 'git' && args[0] === '-C' && args[2] === 'fetch') {
        advanced = true
        const side = join(work, `lateral-${++counter}`)
        git(work, 'clone', '-q', '-b', 'main', repo.bare, side)
        git(side, 'config', 'user.email', 'otro@mefisto.local')
        git(side, 'config', 'user.name', 'Otro')
        writeFiles(side, files)
        git(side, 'add', '.')
        git(side, 'commit', '-q', '-m', 'avance de main')
        git(side, 'push', '-q', 'origin', 'HEAD:main')
      }
      return real(command, args, options)
    })
    return { tools, deps: { runLogged } }
  }

  test('con main al dia no hace merge', async () => {
    const run = await runDouble(consumer(), ['42'], [WRITER, REVIEWER])
    assert.match(text(run), /-- Sincronizando con main --\n\[.*\] Actualizando main desde origin\.\.\.\n\[.*\] La rama ya esta al dia con main\n/)
  })

  test('si main avanzo sin conflicto, hace el merge y publica la rama con el', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], advancingMain(repo, { 'otro.txt': 'de main\n' }))
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /\] main tiene 1 commit\(s\) nuevos\. Haciendo merge\.\.\.\nv Merge automatico exitoso\n/)
    assert.equal(git(repo.bare, 'show', `${BRANCH}:otro.txt`), 'de main')
  })

  test('con conflicto, el writer lo resuelve en un stage de merge', async () => {
    const repo = consumer()
    const steps = [
      { files: { 'README.md': 'cambio del writer\n' }, commit: 'cambiar readme' },
      {},
      { files: { 'README.md': 'cambio del writer y de main\n' }, commit: 'resolver conflicto con main' },
    ]
    const double = runnerDouble(steps)
    const advancing = advancingMain(repo, { 'README.md': 'cambio de main\n' })
    const run = await runTooling(repo, ['42'], { tools: advancing.tools, deps: { ...advancing.deps, launchRunner: double.launch } })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! Merge con conflictos\. Resolviendo\.\.\.\n\[.*\] Invocando writer \(modelo: <heredado>\)\.\.\.\n\[.*\] writer completado en \d+s\nv Conflictos resueltos\n/)
    assert.equal(
      double.prompts[2],
      'Hay conflictos de merge con main en los siguientes archivos:\nREADME.md\n\nResuelve los conflictos manteniendo tanto la funcionalidad nueva como la existente.\nDespues de resolver cada archivo, haz git add. Cuando todos esten resueltos, haz git commit.\n' +
        "PROHIBIDO hacer 'git push' o 'gh pr create': eso es responsabilidad exclusiva del pipeline, nunca tuya.",
    )
    assert.equal(double.calls[2]?.[double.calls[2].indexOf('--agent') + 1], 'tooling-writer')
    assert.equal(git(repo.bare, 'show', `${BRANCH}:README.md`), 'cambio del writer y de main')
    const stamp = String(history(repo)[0]?.started)
    assert.ok(existsSync(join(repo.stateDir, 'logs', `tooling-stage-merge-writer-${stamp}-issue-42.log`)))
    // El stage de merge reutiliza el rol writer: sus metricas reemplazan las del Stage 1.
    assert.equal((history(repo)[0]?.agents as { writer: { metrics: { stage: string } } }).writer.metrics.stage, 'merge')
  })

  test('si quedan conflictos tras el writer, aborta y dice donde revisarlos', async () => {
    const repo = consumer()
    const steps = [{ files: { 'README.md': 'cambio del writer\n' }, commit: 'cambiar readme' }, {}, {}]
    const advancing = advancingMain(repo, { 'README.md': 'cambio de main\n' })
    const run = await runTooling(repo, ['42'], { tools: advancing.tools, deps: { ...advancing.deps, launchRunner: runnerDouble(steps).launch } })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: Aun quedan conflictos: README\.md\. Revisa manualmente: cd .*worktree-issue-42-agregar-workflow-de-ci\n/)
  })

  test('con C# vuelve a correr los tests tras el merge y aborta si fallan', async () => {
    const repo = consumer({ 'tests/Empresa.Proyecto.Ventas.Tests/T.cs': 'class T {}\n' })
    const tools = fakeTools()
    const advancing = advancingMain(repo, { 'otro.txt': 'de main\n' }, tools)
    let testRuns = 0
    const run = await runTooling(repo, ['42'], {
      tools,
      deps: {
        ...advancing.deps,
        launchRunner: runnerDouble([{ files: { 'src/A.cs': 'class A {}\n' }, commit: 'clase' }, {}]).launch,
        runDotnet: () => (++testRuns === 1 ? { status: 0, output: 'Passed: 3\n' } : { status: 1, output: 'Failed: 1\n' }),
      },
    })
    assert.equal(run.code, 1)
    assert.match(text(run), /\] Verificando tests despues del merge\.\.\.\n\nx ERROR: Tests fallan despues del merge con main \(exit code: 1\)\.\n/)
  })
})

describe('--from-stage 2', () => {
  test('retoma el worktree existente, corre solo el reviewer y cierra', async () => {
    const repo = consumer()
    const first = await runDouble(repo, ['42'], [WRITER, { status: 'failed', kind: 'api_error' }])
    assert.equal(first.code, 1)
    assert.equal(existsSync(worktreeOf(repo)), true)

    const double = runnerDouble([REVIEWER])
    const run = await runTooling(repo, ['42', '--from-stage', '2'], { deps: { launchRunner: double.launch } })
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /\] Retomando desde Stage 2 -- worktree existente: .*\n\[.*\] Snapshot detectado: [0-9a-f]{40}\n/)
    assert.equal(text(run).includes('Stage 1: Writer'), false)
    assert.deepEqual(
      double.calls.map((args) => args[args.indexOf('--agent') + 1]),
      ['tooling-reviewer'],
    )
    assert.match(eventsLog(repo), /=== SESSION TOOLING \d{8}-\d{6} issue:42 from-stage:2 ===\n/)
    const completed = history(repo).find((entry) => entry.state === 'completed') ?? {}
    assert.deepEqual((completed.agents as { writer: unknown }).writer, { duration: null, metrics: null })
    const body = flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--body')
    assert.match(body, /<summary>Writer -- 0m 0s<\/summary>/)
    assert.match(body, /agregar script de ci\n/)
  })

  test('sin worktree que retomar aborta', async () => {
    const run = await runDouble(consumer(), ['42', '--from-stage', '2'], [])
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: No existe el worktree en .*worktree-issue-42-agregar-workflow-de-ci\. No se puede retomar desde Stage 2\.\n/)
  })

  test('una corrida nueva sobre un worktree anterior lo reinicia desde origin/main', async () => {
    const repo = consumer()
    await runDouble(repo, ['42'], [WRITER, { status: 'failed', kind: 'api_error' }])
    const run = await runDouble(repo, ['42'], [{ files: { 'scripts/otro.sh': 'x\n' }, commit: 'otro intento' }, {}])
    assert.equal(run.code, 0, text(run))
    assert.match(text(run), /! El worktree ya existe: .* -- limpiando para reiniciar\.\.\.\n/)
    assert.equal(git(repo.bare, 'log', '--format=%s', BRANCH), 'otro intento\nbase')
  })
})
