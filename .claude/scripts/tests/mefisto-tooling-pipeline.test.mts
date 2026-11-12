// Corridas de extremo a extremo de `mefisto-tooling-pipeline.mts` sobre un repo de Mefisto
// temporal: guardas, camino feliz con el runner real, gates de scope, neutralidad y changelog,
// variante, reanudacion, sincronizacion con main y publicacion del PR.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../../../scripts/lib/cli.mts'
import type { LaunchRunner } from '../../../scripts/lib/pipeline/pipeline-agent-run.mts'
import { stripAnsi } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { isolateGitConfig, newRepo, writeFiles } from '../../../scripts/tests/field-note-sandbox.mts'
import type { GuionStep } from '../../../scripts/tests/fixtures/tooling-pipeline/runtime-guion.mts'
import { runnerDouble } from '../../../scripts/tests/tooling-pipeline-sandbox.mts'
import { resolveStageEffort } from '../../../src/internal/scripts/mefisto-tooling-pipeline.mts'
import {
  REPO_ROOT,
  REVIEWER,
  WRITER,
  eventsLog,
  fakeGh,
  filesMatching,
  flag,
  guionCalls,
  history,
  newMefisto,
  readJson,
  runMefistoTooling,
} from './mefisto-tooling-pipeline-sandbox.mts'
import type { Mefisto, PipelineRun, RunOptions } from './mefisto-tooling-pipeline-sandbox.mts'

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

function mefisto(files: Record<string, string> = {}): Mefisto {
  return newMefisto(join(work, `caso-${++counter}`), files)
}

const git = (cwd: string, ...args: string[]): string => capture('git', args, { cwd }).stdout.replace(/\n+$/, '')
const out = (run: PipelineRun): string => stripAnsi(run.out)
const errText = (run: PipelineRun): string => stripAnsi(run.err)
const ghCalls = (run: PipelineRun, ...command: string[]): string[][] =>
  run.gh.calls.filter((args) => command.every((word, index) => args[index] === word))

const BRANCH = 'worktree-mefisto-issue-42-agregar-script-de-ci'
const worktreeOf = (repo: Mefisto, branch = BRANCH): string => join(repo.root, '.mefisto', 'worktrees', branch)
const statusFile = (repo: Mefisto, name = 'pipeline-status-mefisto-tooling-42.json'): string => join(repo.stateDir, name)
const logs = (repo: Mefisto, pattern: RegExp): string[] => filesMatching(join(repo.stateDir, 'logs'), pattern)
const lastLine = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8').trimEnd().split('\n').at(-1) ?? '{}') as Record<string, unknown>

/** Con el runner en proceso: mismo pipeline, sin lanzar procesos de agente. */
function runDouble(repo: Mefisto, argv: string[], steps: GuionStep[], options: RunOptions = {}): Promise<PipelineRun> {
  return runMefistoTooling(repo, argv, { ...options, steps })
}

// La fuga se arma por partes: este archivo no debe contener el literal que persigue el gate.
const LEAK = `---\n{"id": "fx-leak", "kind": "agent", "effort": "standard", "${'mo'}del": "${'son'}net"}\n---\n\nFuga de neutralidad.\n`

describe('guardas previas', () => {
  test('sin argumentos muestra el uso, menciona --models y --variant, y sale con 1', async () => {
    const run = await runMefistoTooling(mefisto(), [])
    assert.equal(run.code, 1)
    assert.equal(
      run.out,
      "Uso: src/internal/scripts/mefisto-tooling-pipeline.mts [--issue NUM | NUM] [--from-stage N] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]\n",
    )
  })

  test('fuera de un repo git se niega', async () => {
    const outside = mkdtempSync(join(work, 'sin-git-'))
    const run = await runMefistoTooling({ ...mefisto(), root: outside }, ['42'])
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no estas en un repositorio git\n')
  })

  test('en un repo que no es el de Mefisto se niega', async () => {
    const repo = newRepo(join(work, `consumidor-${++counter}`), { 'README.md': 'x\n' })
    const run = await runMefistoTooling({ root: repo.main, bare: repo.bare, guionFile: '', stateDir: '' }, ['42'])
    assert.equal(run.code, 1)
    // Como el bash: la raiz tal como la entrega git (con `/` tambien en Windows) y la ruta relativa detras.
    const top = git(repo.main, 'rev-parse', '--show-toplevel')
    assert.equal(
      run.err,
      [
        'ERROR: este pipeline solo se ejecuta dentro del repo de Mefisto',
        `  No se encontro ${top}/.claude-plugin/plugin.json`,
        '  Si querias trabajar sobre tu proyecto consumidor, usa los skills',
        '  publicados (/tooling, /implement, etc.) desde la raiz de ese repo.',
        '',
      ].join('\n'),
    )
  })

  test('activa los hooks versionados del repo y lo avisa en stderr', async () => {
    const repo = mefisto()
    capture('git', ['config', '--unset', 'core.hooksPath'], { cwd: repo.root })
    const run = await runMefistoTooling(repo, ['42', '--raro'])
    assert.ok(run.err.startsWith('AVISO: core.hooksPath configurado a src/internal/githooks (hook pre-push que desvia a PR los push directos a main).\n'))
    assert.equal(git(repo.root, 'config', '--get', 'core.hooksPath'), 'src/internal/githooks')
  })
})

describe('como proceso', () => {
  const SCRIPT = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-tooling-pipeline.mts')

  test('el modulo corre directo con Node y sale con 1 mostrando el uso', () => {
    const result = capture(process.execPath, [SCRIPT], { cwd: mefisto().root })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /^Uso: .*mefisto-tooling-pipeline\.mts \[--issue NUM \| NUM\] /)
  })

  for (const shim of [
    ['src', 'internal', 'scripts', 'mefisto-tooling-pipeline.sh'],
    ['.claude', 'scripts', 'mefisto-tooling-pipeline.sh'],
  ]) {
    test(`${shim.join('/')} lanza el modulo con sus argumentos`, { skip: process.platform === 'win32' }, () => {
      const result = capture('bash', [join(REPO_ROOT, ...shim), '42', '--from-stage', '9'], { cwd: mefisto().root })
      assert.equal(result.status, 1)
      assert.match(stripAnsi(result.stderr), /^x ERROR: --from-stage debe ser 1 o 2 \(recibido: 9\)\n/m)
    })
  }
})

describe('argumentos y frontera neutral: abortan antes de crear el worktree', () => {
  const CASES: { name: string; argv: string[]; env?: NodeJS.ProcessEnv; missing?: string; error: string }[] = [
    { name: 'argumento desconocido', argv: ['42', '--raro'], error: 'Argumento no reconocido: --raro' },
    { name: '--issue sin valor', argv: ['--issue'], error: 'Falta el numero de issue' },
    { name: '--from-stage sin valor', argv: ['42', '--from-stage'], error: 'Falta el numero de stage' },
    { name: '--status-file sin valor', argv: ['42', '--status-file'], error: 'Falta el nombre del archivo de status' },
    { name: '--models sin valor', argv: ['42', '--models'], error: 'Falta el valor de --models' },
    { name: '--variant sin valor', argv: ['42', '--variant'], error: 'Falta el valor de --variant' },
    { name: 'sin issue', argv: ['--from-stage', '2'], error: 'Falta el numero de issue' },
    { name: '--from-stage fuera de rango', argv: ['42', '--from-stage', '3'], error: '--from-stage debe ser 1 o 2 (recibido: 3)' },
    {
      name: '--variant con mayusculas',
      argv: ['42', '--variant', 'Experimento'],
      error: "--variant mal formado: el label de --variant 'Experimento' es invalido: solo minusculas, digitos y guiones ([a-z0-9-])",
    },
    { name: 'timeout que no es un entero', argv: ['42'], env: { MEFISTO_AGENT_TIMEOUT_SECONDS: 'abc' }, error: "MEFISTO_AGENT_TIMEOUT_SECONDS 'abc' no es un entero" },
    { name: 'timeout en cero', argv: ['42'], env: { MEFISTO_AGENT_TIMEOUT_SECONDS: '0' }, error: 'MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0 (recibido: 0)' },
    { name: 'falta gh', argv: ['42'], missing: 'gh', error: 'Falta comando requerido: gh' },
    { name: 'falta git', argv: ['42'], missing: 'git', error: 'Falta comando requerido: git' },
    {
      name: 'falta el CLI del runtime resuelto',
      argv: ['42'],
      missing: 'guion',
      error: "Falta el CLI del runtime resuelto ('guion'). Fija MEFISTO_RUNTIME con un runtime instalado.",
    },
  ]
  for (const { name, argv, env, missing, error } of CASES) {
    test(name, async () => {
      const repo = mefisto()
      const run = await runMefistoTooling(repo, argv, {
        ...(env === undefined ? {} : { env }),
        deps: { hasCommand: (command) => command !== missing },
      })
      assert.equal(run.code, 1)
      // El motivo llega a stderr aun sin directorio de logs, sin linea en blanco delante.
      assert.ok(errText(run).startsWith(`x ERROR: ${error}\n`), errText(run))
      assert.match(errText(run), /\nRevisa el log: .*mefisto-tooling-pipeline-\d{8}-\d{6}\.log\n$/)
      assert.equal(run.out, '')
      assert.deepEqual(ghCalls(run, 'issue', 'view'), [])
      assert.equal(existsSync(join(repo.root, '.mefisto')), false, 'ni worktree, ni status, ni logs')
    })
  }

  test('runtime sin adaptador', async () => {
    const run = await runMefistoTooling(mefisto(), ['42'], { env: { MEFISTO_RUNTIME: 'inexistente' } })
    assert.equal(run.code, 1)
    assert.match(errText(run), /^x ERROR: No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador \(.*runtime-inexistente\.mts\): fija MEFISTO_RUNTIME a un runtime soportado\n/)
  })

  test('con el directorio de logs ya creado, el error queda tambien en el log', async () => {
    const repo = mefisto()
    writeFiles(repo.root, { '.mefisto/pipeline/logs/.keep': '' })
    const run = await runMefistoTooling(repo, ['42', '--raro'])
    const [log = ''] = logs(repo, /^mefisto-tooling-pipeline-/)
    assert.equal(stripAnsi(readFileSync(log, 'utf8')), '\nx ERROR: Argumento no reconocido: --raro\n')
    assert.equal(run.code, 1)
  })
})

describe('abortos con el directorio del pipeline ya preparado', () => {
  test('--models malformado aborta antes del worktree y deja el fallo en status e historial', async () => {
    const repo = mefisto()
    const run = await runMefistoTooling(repo, ['42', '--models', 'reviewer-opus'])
    assert.equal(run.code, 1)
    assert.match(errText(run), /^x ERROR: --models mal formado: .*reviewer-opus/)
    assert.equal(existsSync(worktreeOf(repo)), false)
    const status = readJson(statusFile(repo))
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, 'setup')
    assert.match(String(status.last_error), /^--models mal formado: /)
    const [entry = {}] = history(repo)
    assert.equal(entry.state, 'failed')
    assert.equal(entry.stage, 'setup')
    assert.equal(entry.runtime, 'guion')
    assert.match(eventsLog(repo), /^=== SESSION MEFISTO-TOOLING \d{8}-\d{6} issue:42 from-stage:1 ===\n\[\d\d:\d\d:\d\d\] RUNTIME: guion\n$/)
  })

  test('un mapping de modelos invalido aborta citando el agente y el perfil', async () => {
    const repo = mefisto()
    writeFiles(repo.root, { '.mefisto/models.json': '{roto' })
    const run = await runMefistoTooling(repo, ['42'])
    assert.equal(run.code, 1)
    assert.match(errText(run), /^x ERROR: No se pudo resolver el modelo de mefisto-writer \(perfil balanced\): /)
  })

  test('un issue que gh no encuentra aborta', async () => {
    const run = await runMefistoTooling(mefisto(), ['42'], { gh: fakeGh({ issue: null }) })
    assert.match(errText(run), /^x ERROR: No se pudo obtener el issue #42 \(debe existir en este repo\)\n/)
  })

  test('un issue cerrado aborta', async () => {
    const run = await runMefistoTooling(mefisto(), ['42'], { gh: fakeGh({ issue: { number: 42, title: 't', body: 'b', state: 'CLOSED' } }) })
    assert.match(errText(run), /^x ERROR: El issue #42 esta CLOSED -- solo se procesan issues abiertos\.\n/)
  })

  test('retomar sin worktree aborta', async () => {
    const repo = mefisto()
    const run = await runMefistoTooling(repo, ['42', '--from-stage', '2'])
    assert.match(errText(run), new RegExp(`^x ERROR: No existe el worktree en .*${BRANCH}\\. No se puede retomar desde Stage 2\\.\\n`))
  })
})

describe('camino feliz con el runner real', () => {
  let repo: Mefisto
  let run: PipelineRun

  before(async () => {
    repo = mefisto()
    run = await runMefistoTooling(repo, ['42'], { guion: [WRITER, REVIEWER] })
  })

  test('termina bien e invoca al writer y al reviewer por su id neutral en el worktree', () => {
    assert.equal(run.code, 0, run.out + run.err)
    assert.deepEqual(
      guionCalls(repo).map((call) => call.agent),
      ['mefisto-writer', 'mefisto-reviewer'],
    )
    for (const call of guionCalls(repo)) {
      assert.ok(call.cwd.endsWith(join('.mefisto', 'worktrees', BRANCH)), call.cwd)
      assert.equal(call.system, readFileSync(join(REPO_ROOT, 'src', 'internal', 'prompts', 'noninteractive-system.md'), 'utf8'))
      assert.equal(call.model, '')
      assert.equal(call.effort, '')
      assert.equal(call.resume, '')
    }
  })

  test('los prompts quedan en prompts/ y llevan el issue y la doctrina de neutralidad', () => {
    const [writer, reviewer] = guionCalls(repo)
    const saved = filesMatching(join(repo.stateDir, 'prompts'), /\.prompt\.md$/)
    assert.equal(saved.length, 2)
    assert.equal(readFileSync(saved.find((file) => file.includes('stage-1-writer')) ?? '', 'utf8'), writer?.prompt)
    assert.ok(writer?.prompt.includes('\n\n# Issue #42: Agregar script de CI\n\nCuerpo del issue.\n\n'))
    assert.ok(writer?.prompt.startsWith('Estas en el directorio raiz del repo de Mefisto (mefisto), '))
    for (const prompt of [writer?.prompt ?? '', reviewer?.prompt ?? '']) assert.ok(prompt.includes('NEUTRALIDAD DE RUNTIME:'))
    assert.equal(readFileSync(join(repo.stateDir, 'mefisto-tooling-input.md'), 'utf8'), '# Issue #42: Agregar script de CI\n\nCuerpo del issue.\n')
  })

  test('cada stage deja su JSONL neutral, su log legible y sus metricas con el runtime', () => {
    for (const [stage, agent] of [
      ['1', 'writer'],
      ['2', 'reviewer'],
    ]) {
      const [events = ''] = logs(repo, new RegExp(`^mefisto-tooling-stage-${stage}-${agent}-\\d{8}-\\d{6}-issue-42\\.events\\.jsonl$`))
      const terminal = lastLine(events)
      assert.equal(terminal.type, 'run.completed')
      assert.equal(terminal.status, 'success')
      assert.equal(terminal.runtime, 'guion')
      assert.equal(logs(repo, new RegExp(`stage-${stage}-${agent}-.*-issue-42\\.log$`)).length, 1)
      const [metrics = ''] = filesMatching(join(repo.stateDir, 'metrics'), new RegExp(`^mefisto-tooling-\\d{8}-\\d{6}-issue-42-stage-${stage}-${agent}\\.json$`))
      assert.equal(readJson(metrics).runtime, 'guion')
      assert.equal(readJson(metrics).status, 'success')
    }
    assert.equal(existsSync(join(repo.root, '.claude', 'pipeline')), false, 'nada bajo la ruta legacy')
  })

  test('events.log registra la sesion, el runtime, modelos, effort y cada stage', () => {
    assert.match(
      eventsLog(repo),
      /^=== SESSION MEFISTO-TOOLING \d{8}-\d{6} issue:42 from-stage:1 ===\n\[.{8}\] RUNTIME: guion\n\[.{8}\] MODELS: writer -> <heredado> \(perfil balanced\)\n\[.{8}\] MODELS: reviewer -> <heredado> \(perfil deep\)\n\[.{8}\] EFFORTS: writer -> <heredado> \(nivel standard\)\n\[.{8}\] EFFORTS: reviewer -> <heredado> \(nivel thorough\)\n\[.{8}\] === MEFISTO-TOOLING STAGE 1: writer ===\n/,
    )
  })

  test('crea el PR hacia main con el cuerpo del pipeline y comenta el issue', () => {
    const [create = []] = ghCalls(run, 'pr', 'create')
    assert.equal(ghCalls(run, 'pr', 'create').length, 1)
    assert.deepEqual([flag(create, '--title'), flag(create, '--base'), flag(create, '--head'), create.includes('--repo')], ['Agregar script de CI', 'main', BRANCH, false])
    const body = flag(create, '--body')
    assert.match(body, /^## Resumen\n\nPipeline mefisto-tooling completado:\n/)
    assert.match(body, /<summary>Writer -- 0m \d+s<\/summary>\n\nresumen del writer\n\n<\/details>/)
    assert.match(body, /<summary>Reviewer -- 0m \d+s<\/summary>\n\nresumen del reviewer\n\n<\/details>/)
    assert.match(body, /## Commits\n\n[0-9a-f]{7,} mefisto-tooling\(#42\): revision y correcciones\n[0-9a-f]{7,} agregar notas de CI\n\n## Metricas de la corrida\n\n\| Etapa \|/)
    assert.match(body, /\n\nCloses #42$/)
    assert.deepEqual(ghCalls(run, 'pr', 'list')[0], ['pr', 'list', '--head', BRANCH, '--base', 'main', '--state', 'open', '--json', 'url'])
    const [comment = []] = ghCalls(run, 'issue', 'comment')
    assert.deepEqual(comment, ['issue', 'comment', '42', '--body', 'Pipeline mefisto-tooling completado. PR: https://github.com/acme/mefisto/pull/7'])
  })

  test('la rama queda en el remoto con el commit del writer y el de seguridad del reviewer', () => {
    assert.equal(git(repo.bare, 'log', '--format=%s', BRANCH, '-2'), 'mefisto-tooling(#42): revision y correcciones\nagregar notas de CI')
    assert.match(out(run), /\] Haciendo commit automatico \(fase reviewer\)\.\.\.\n/)
    assert.equal(out(run).includes('(fase writer)'), false)
  })

  test('cierra: status borrado, worktree eliminado, historial completado y resumen final', () => {
    assert.equal(existsSync(statusFile(repo)), false)
    assert.equal(existsSync(worktreeOf(repo)), false)
    const [entry = {}] = history(repo)
    assert.deepEqual(Object.keys(entry), ['issue', 'title', 'pipeline', 'variant', 'runtime', 'harness_version', 'harness_sha', 'started', 'finished', 'state', 'agents', 'pr'])
    assert.equal(entry.state, 'completed')
    assert.equal(entry.runtime, 'guion')
    assert.equal(entry.pr, 'https://github.com/acme/mefisto/pull/7')
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(entry.harness_version, manifest.version)
    assert.equal(entry.harness_sha, git(repo.root, 'rev-parse', '--short', 'HEAD'))
    const agents = entry.agents as Record<string, Record<string, unknown>>
    assert.equal(agents.writer?.runtime, 'guion')
    assert.equal(agents.reviewer?.runtime, 'guion')
    assert.match(
      out(run),
      /-- Cleanup --\n\[.{8}\] Eliminando worktree\.\.\.\nv Worktree eliminado\n\n=== Pipeline mefisto-tooling completado ===\n\n {2}Commits: 2\n {2}Rama: {4}worktree-mefisto-issue-42-agregar-script-de-ci\n {2}PR: {6}https:\/\/github\.com\/acme\/mefisto\/pull\/7\n {2}Log: {5}.*mefisto-tooling-pipeline-\d{8}-\d{6}\.log\n\n$/,
    )
  })

  test('el log del pipeline empieza con su cabecera y guarda los mensajes sin color', () => {
    const [log = ''] = logs(repo, /^mefisto-tooling-pipeline-/)
    const content = readFileSync(log, 'utf8')
    assert.match(content, /^Pipeline mefisto-tooling iniciado: \d{8}-\d{6}\n/)
    assert.ok(content.includes('\n-- Stage 1: Writer (implementacion) --\n'))
    assert.equal(content.includes('\u001b['), false)
  })
})

describe('fallo terminal del writer con el runner real', () => {
  let repo: Mefisto
  let run: PipelineRun

  before(async () => {
    repo = mefisto()
    run = await runMefistoTooling(repo, ['42'], { guion: [{ status: 'failed' }] })
  })

  test('aborta en Stage 1 sin crear PR ni lanzar al reviewer', () => {
    assert.equal(run.code, 1)
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    assert.equal(logs(repo, /stage-2-reviewer/).length, 0)
    assert.match(errText(run), /^x ERROR: writer fallo \(CLI_ERROR \(exit 3\)\)\. Log completo: .*mefisto-tooling-stage-1-writer-\d{8}-\d{6}-issue-42\.log\n/)
    assert.match(errText(run), /\nEl worktree queda en: .*worktree-mefisto-issue-42-agregar-script-de-ci\n$/)
    assert.match(out(run), /\n-- Ultimas lineas del log de writer:\n/)
  })

  test('el status queda failed en el stage del writer y el historial con una entrada failed', () => {
    const status = readJson(statusFile(repo))
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, '1-writer')
    const agents = status.agents as Record<string, Record<string, unknown>>
    assert.equal(typeof agents.writer?.duration, 'number')
    assert.equal(agents.writer?.result, 'failed')
    assert.deepEqual(agents.reviewer, { duration: null, result: 'pending' })
    const entries = history(repo)
    assert.deepEqual(
      entries.map((entry) => entry.state),
      ['failed'],
    )
    const [entry = {}] = entries
    assert.equal(entry.stage, '1-writer')
    assert.match(String(entry.error), /^writer fallo \(CLI_ERROR \(exit 3\)\)\. Log completo: .* $/)
    assert.equal(typeof entry.harness_version, 'string')
    assert.equal(entry.harness_sha, git(repo.root, 'rev-parse', '--short', 'HEAD'))
    assert.equal((entry.agents as Record<string, Record<string, unknown>>).writer?.runtime, 'guion')
  })

  test('el JSONL del writer termina en run.failed', () => {
    const [events = ''] = logs(repo, /stage-1-writer-.*\.events\.jsonl$/)
    assert.equal(lastLine(events).type, 'run.failed')
  })
})

describe('textos con barras y comillas en el status y el historial', () => {
  test('un titulo con barras y comillas deja status e historial como JSON valido', async () => {
    const repo = mefisto()
    const title = 'Usar "C:\\ruta\\nueva" en el log'
    const gh = fakeGh({ issue: { number: 42, title, body: 'b', state: 'OPEN' } })
    const run = await runDouble(repo, ['42'], [{ status: 'failed' }], { gh })
    assert.equal(run.code, 1)
    const [status = ''] = filesMatching(repo.stateDir, /^pipeline-status-mefisto-tooling-42\.json$/)
    assert.equal(readJson(status).title, title)
    assert.match(String(readJson(status).last_error), /^writer fallo \(CLI_ERROR \(exit 3\)\)\. Log completo: /)
    const [entry = {}] = history(repo)
    assert.equal(entry.title, title)
    assert.equal(entry.error, readJson(status).last_error)
  })
})

describe('modelos y effort por stage', () => {
  test('sin override, cada rol usa el default del adaptador para su perfil', async () => {
    const repo = mefisto()
    const run = await runMefistoTooling(repo, ['42'], { guion: [WRITER, REVIEWER], env: { GUION_DEFAULT_MODEL: 'modelo-defecto' } })
    assert.equal(run.code, 0, run.err)
    assert.deepEqual(
      guionCalls(repo).map((call) => call.model),
      ['modelo-defecto', 'modelo-defecto'],
    )
    assert.match(out(run), /\] Invocando writer \(modelo: modelo-defecto\)\.\.\.\n/)
  })

  test('--models gana por clave exacta, se anuncia y queda en events.log', async () => {
    const repo = mefisto()
    const run = await runDouble(repo, ['42', '--models', 'writer=modelo-w,revieweer=typo'], [WRITER, REVIEWER])
    assert.equal(run.code, 0, run.err)
    assert.match(out(run), /\] Modelos por stage \(--models\): writer=modelo-w, revieweer=typo\n/)
    assert.match(eventsLog(repo), /\] MODELS: writer=modelo-w, revieweer=typo\n.*\] MODELS: writer -> modelo-w \(override --models\)\n.*\] MODELS: reviewer -> <heredado> \(perfil deep\)\n/)
  })

  test('el effort de fabrica de cada agente pasa al runner con el mapping local', async () => {
    const repo = mefisto()
    writeFiles(repo.root, {
      '.mefisto/models.json': '{"guion":{"efforts":{"levels":{"light":"g-light","standard":"g-standard","thorough":"g-thorough"},"agents":{"mefisto-writer":"light"}}}}',
    })
    const run = await runMefistoTooling(repo, ['42'], { guion: [WRITER, REVIEWER] })
    assert.equal(run.code, 0, run.err)
    assert.deepEqual(
      guionCalls(repo).map((call) => call.effort),
      ['g-light', 'g-thorough'],
    )
    // El nivel que se anota es el de fabrica de la fuente, aunque el mapping lo cambie.
    assert.match(eventsLog(repo), /\] EFFORTS: writer -> g-light \(nivel standard\)\n.*\] EFFORTS: reviewer -> g-thorough \(nivel thorough\)\n/)
  })

  test('cuando lo lanza el batch, el mapping sale de MEFISTO_LAUNCH_ROOT', async () => {
    const repo = mefisto()
    const launch = join(work, `lanzador-${++counter}`)
    capture('git', ['clone', '-q', '-b', 'main', repo.bare, launch])
    for (const [key, value] of [['user.email', 't@t'], ['user.name', 't'], ['core.hooksPath', 'src/internal/githooks']]) {
      capture('git', ['config', key ?? '', value ?? ''], { cwd: launch })
    }
    writeFiles(launch, { '.mefisto/models.json': '{"guion":{"profiles":{"deep":"modelo-del-lanzador"}}}' })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { env: { MEFISTO_LAUNCH_ROOT: launch } })
    assert.equal(run.code, 0, run.err)
    assert.match(eventsLog(repo), /\] MODELS: reviewer -> modelo-del-lanzador \(perfil deep\)\n/)
    assert.ok(out(run).includes(`Creando worktree: ${join(launch, '.mefisto', 'worktrees', BRANCH)} (base: origin/main)`))
    assert.equal(existsSync(join(launch, '.mefisto', 'worktrees', BRANCH)), false, 'el worktree se limpio en la raiz del lanzador')
  })
})

describe('effort de cada agente desde su fuente neutral', () => {
  const AGENTS = join(REPO_ROOT, 'src', 'internal', 'agents')
  const LEVELS = '"levels":{"light":"fake-light","standard":"fake-standard","thorough":"fake-thorough"}'
  async function effortsWith(mapping: string, agentsDir = AGENTS): Promise<{ result: string; events: string }> {
    const dir = mkdtempSync(join(work, 'effort-'))
    writeFileSync(join(dir, 'models.json'), mapping)
    const eventsFile = join(dir, 'events.log')
    writeFileSync(eventsFile, '')
    const request = {
      runtime: 'fake',
      agentsDir,
      mappingFile: join(dir, 'models.json'),
      eventsLog: eventsFile,
      env: { MEFISTO_RUNTIME_LIB_DIR: join(REPO_ROOT, 'src', 'runtime', 'lib') },
      now: new Date(),
    }
    const results: string[] = []
    for (const [key, agentId] of [
      ['writer', 'mefisto-writer'],
      ['reviewer', 'mefisto-reviewer'],
    ] as const) {
      const effort = await resolveStageEffort({ ...request, key, agentId })
      results.push('error' in effort ? `ABORT: ${effort.error}` : effort.effort)
    }
    return { result: results.join(' '), events: readFileSync(eventsFile, 'utf8') }
  }

  test('sin mapping de agente: writer recibe el nativo de standard y reviewer el de thorough', async () => {
    const { result, events } = await effortsWith(`{"fake":{"efforts":{${LEVELS}}}}`)
    assert.equal(result, 'fake-standard fake-thorough')
    assert.match(events, /\] EFFORTS: writer -> fake-standard \(nivel standard\)\n.*\] EFFORTS: reviewer -> fake-thorough \(nivel thorough\)\n/)
  })

  test('efforts.agents cambia el nivel del writer y no el del reviewer', async () => {
    const { result } = await effortsWith(`{"fake":{"efforts":{${LEVELS},"agents":{"mefisto-writer":"light"}}}}`)
    assert.equal(result, 'fake-light fake-thorough')
  })

  test('una fuente sin effort aborta citando el agente y MEFISTO_EFFORTS_ERROR', async () => {
    const agents = mkdtempSync(join(work, 'agentes-'))
    for (const agent of ['mefisto-writer', 'mefisto-reviewer']) {
      const source = readFileSync(join(AGENTS, `${agent}.md`), 'utf8')
      writeFileSync(join(agents, `${agent}.md`), source.split('\n').filter((line) => !line.includes('"effort"')).join('\n'))
    }
    const { result } = await effortsWith(`{"fake":{"efforts":{${LEVELS}}}}`, agents)
    assert.match(result, /^ABORT: No se pudo resolver el effort de mefisto-writer: MEFISTO_EFFORTS_ERROR=la fuente .*mefisto-writer\.md no declara 'effort' o es ilegible /)
  })

  test('un mapping invalido aborta citando el agente, el nivel y MEFISTO_EFFORTS_ERROR', async () => {
    const { result } = await effortsWith('{"fake":{"efforts":{"agents":{"mefisto-writer":"extremo"}}}}')
    assert.match(result, /^ABORT: No se pudo resolver el effort de mefisto-writer \(nivel standard\): MEFISTO_EFFORTS_ERROR=\S/)
  })
})

describe('gate de neutralidad de runtime', () => {
  test('una fuga que persiste tras el intento de correccion aborta Stage 1 con el remedio y la retoma', async () => {
    const repo = mefisto()
    const leak = { 'src/internal/agents/fx-leak.md': LEAK }
    const steps: GuionStep[] = [{ files: { ...WRITER.files, ...leak }, commit: 'writer con fuga' }, { files: leak }]
    const run = await runDouble(repo, ['42'], steps)
    assert.equal(run.code, 1)
    assert.match(errText(run), /src\/internal\/agents\/fx-leak\.md:\d+: R1\n/)
    assert.match(errText(run), /\nR1: reformula la mencion/)
    assert.doesNotMatch(errText(run), /R4:|adapters-check:/)
    assert.ok(errText(run).includes('\n  ./.claude/scripts/mefisto-tooling-pipeline.sh 42 --from-stage 1\n'))
    assert.match(errText(run), /^x ERROR: El intento de correccion de neutralidad ya fallo -- la fuga persiste\. Stage 1 fallido: el writer dejo fuga\(s\)/)
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    assert.equal(readJson(statusFile(repo)).state, 'failed')
    assert.deepEqual(
      history(repo).map((entry) => entry.state),
      ['failed'],
    )
    assert.equal(filesMatching(join(repo.stateDir, 'prompts'), /\.prompt\.md$/).length, 2, 'writer e intento, sin reviewer')
    assert.match(eventsLog(repo), /\] \[neutralidad\]\[fix\] writer: 1 violacion\(es\), intento de correccion\n/)
    assert.match(eventsLog(repo), /\] \[neutralidad\]\[fix\] writer: persiste\n/)
    assert.match(out(run), /^! writer: 1 violacion\(es\) de neutralidad -- intento de correccion$/m)
  })

  test('el intento de correccion recibe la salida del gate y su remedio', async () => {
    const repo = mefisto()
    const leak = { 'src/internal/agents/fx-leak.md': LEAK }
    await runDouble(repo, ['42'], [{ files: { ...WRITER.files, ...leak }, commit: 'writer con fuga' }, { files: leak }])
    const [fix = ''] = filesMatching(join(repo.stateDir, 'prompts'), /stage-1-fix-writer/)
    const prompt = readFileSync(fix, 'utf8')
    assert.match(prompt, /^Estas en el worktree de un stage de tooling del repo de Mefisto \(mefisto\) ya en curso \(issue #42\)\.\n/)
    assert.match(prompt, /\n\nsrc\/internal\/agents\/fx-leak\.md:\d+: R1\n\nRemedio por regla:\nR1: /)
  })

  test('si el intento corrige la fuga la corrida completa, con su duracion y metricas aparte', async () => {
    const repo = mefisto()
    const steps: GuionStep[] = [
      { files: { ...WRITER.files, 'src/internal/agents/fx-leak.md': LEAK }, commit: 'writer con fuga' },
      { files: {} },
      REVIEWER,
    ]
    const launch = runnerDouble(steps)
    const removeLeak: LaunchRunner = (args, output) => {
      if (launch.calls.length === 1) rmSync(join(args[args.indexOf('--cwd') + 1] ?? '', 'src', 'internal', 'agents', 'fx-leak.md'), { force: true })
      return launch.launch(args, output)
    }
    const run = await runMefistoTooling(repo, ['42'], { deps: { launchRunner: removeLeak } })
    assert.equal(run.code, 0, run.err)
    assert.equal(launch.calls.length, 3)
    assert.match(eventsLog(repo), /\] \[neutralidad\]\[fix\] writer: \d+s\n/)
    assert.match(eventsLog(repo), /\] \[neutralidad\]\[fix\] writer: corregido\n/)
    assert.match(out(run), /^v writer: fuga de neutralidad corregida$/m)
    assert.equal(filesMatching(join(repo.stateDir, 'metrics'), /-stage-1-fix-writer\.json$/).length, 1)
    assert.equal(filesMatching(join(repo.stateDir, 'metrics'), /-stage-1-writer\.json$/).length, 1)
    assert.equal(ghCalls(run, 'pr', 'create').length, 1)
  })

  test('cableado: en cada stage, gate de scope, gate de neutralidad y commit de seguridad, en ese orden', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-tooling-pipeline.mts'), 'utf8')
    assert.ok(source.includes("[join(SCRIPT_DIR, 'mefisto-neutrality-gate.mts'), '--root', worktree]"))
    for (const [stage, role] of [
      ['1', 'writer'],
      ['2', 'reviewer'],
    ]) {
      const block = source.slice(source.indexOf(`log.header('Stage ${stage}:`))
      const scope = block.indexOf('scopeViolated()')
      const gate = block.indexOf(`runNeutralityGate('${stage}', '${role}')`)
      const commit = block.indexOf(`autoCommit('${role}'`)
      assert.ok(scope !== -1 && scope < gate && gate < commit, `stage ${stage}: ${scope} ${gate} ${commit}`)
    }
  })
})

describe('gates de scope y de cambios', () => {
  test('un writer que no deja cambios aborta nombrando su log', async () => {
    const repo = mefisto()
    const run = await runDouble(repo, ['42'], [{ files: { '.mefisto/pipeline/summaries/stage-1-writer.md': 'nada\n' } }])
    assert.match(errText(run), /^x ERROR: El writer no genero ningun cambio\. Revisa el log: .*mefisto-tooling-stage-1-writer-\d{8}-\d{6}-issue-42\.log\n/)
  })

  test('un cambio fuera del scope de Mefisto aborta antes del gate de neutralidad', async () => {
    const repo = mefisto()
    const run = await runDouble(repo, ['42'], [{ files: { 'infra/main.tf': 'x\n', 'docs/a.md': 'a\n' } }])
    assert.equal(run.code, 1)
    assert.match(errText(run), /^ERROR: cambios fuera del scope de Mefisto:\n {2}- infra\/main\.tf\n\nMefisto solo permite cambios en: /)
    assert.match(errText(run), /\nx ERROR: Stage 1 fallido: el writer toco archivos fuera del scope de Mefisto\.\n/)
    assert.equal(out(run).includes('Gate de neutralidad'), false)
  })

  test('el reviewer fuera de scope aborta Stage 2', async () => {
    const repo = mefisto()
    const run = await runDouble(repo, ['42'], [WRITER, { files: { 'infra/main.tf': 'x\n' } }])
    assert.match(errText(run), /x ERROR: Stage 2 fallido: el reviewer toco archivos fuera del scope de Mefisto\.\n/)
  })

  test('el commit de seguridad del writer agrega cada ruta del plugin, aunque falte alguna', async () => {
    const repo = mefisto()
    const run = await runDouble(repo, ['42'], [{ files: { 'docs/a.md': 'a\n', 'changelog.d/42.added.md': '- a\n' } }, REVIEWER])
    assert.equal(run.code, 0, run.err)
    assert.match(out(run), /\] Haciendo commit automatico \(fase writer\)\.\.\.\n/)
    assert.equal(git(repo.bare, 'show', '--name-only', '--format=%s', `${BRANCH}~1`), 'mefisto-tooling(#42): implementacion\n\nchangelog.d/42.added.md\ndocs/a.md')
  })
})

describe('gate de fragmentos de changelog.d/', () => {
  test('un cambio notable sin fragmento aborta con la retoma desde Stage 2', async () => {
    const repo = mefisto()
    const run = await runDouble(repo, ['42', '--variant', 'exp'], [{ files: { 'docs/a.md': 'a\n' }, commit: 'a' }, REVIEWER])
    assert.equal(run.code, 1)
    assert.ok(
      errText(run).startsWith(
        "x ERROR: Cambio notable sin fragmento en changelog.d/.\nEl writer debio crear 'changelog.d/42.<categoria>.md' (added/changed/fixed/removed)\n-- ver changelog.d/README.md para el formato. NUNCA se edita CHANGELOG.md directamente.\nCrea el fragmento en el worktree (",
      ),
    )
    assert.ok(errText(run).includes('y retoma con:\n  ./.claude/scripts/mefisto-tooling-pipeline.sh 42 --from-stage 2 --variant exp\n'))
  })

  test('un cambio solo de bitacora queda exento', async () => {
    const repo = mefisto()
    const run = await runDouble(repo, ['42'], [{ files: { 'docs/bitacora/2026.md': 'x\n' }, commit: 'bitacora' }, {}])
    assert.equal(run.code, 0, run.err)
    assert.match(out(run), /^v Cambio exento \(solo bitacora\/gobierno no notable\): no se exige fragmento$/m)
  })
})

describe('contexto acotado del reviewer y reanudacion', () => {
  test('un diff de mas de 3 MB no entra al prompt del reviewer', async () => {
    const repo = mefisto()
    const big = 'x'.repeat(3 * 1024 * 1024)
    const run = await runDouble(repo, ['42'], [{ files: { ...WRITER.files, 'docs/1449-big-file.md': big }, commit: 'grande' }, REVIEWER])
    assert.equal(run.code, 0, run.err)
    const [prompt = ''] = filesMatching(join(repo.stateDir, 'prompts'), /stage-2-reviewer.*\.prompt\.md$/)
    assert.ok(statSync(prompt).size < 65_536)
    const text = readFileSync(prompt, 'utf8')
    assert.doesNotMatch(text, /^diff --git|^@@/m)
    assert.match(text, /^Commit base: [0-9a-f]{40}$/m)
    assert.match(text, /^HEAD del writer: [0-9a-f]{40}$/m)
    assert.ok(text.includes('docs/1449-big-file.md'))
  })

  test('--from-stage 2 calcula el mismo commit base y HEAD del writer que la corrida completa', async () => {
    const repo = mefisto()
    const first = await runDouble(repo, ['42'], [WRITER, { status: 'failed' }])
    assert.equal(first.code, 1)
    const reviewerPrompt = (): string[] =>
      filesMatching(join(repo.stateDir, 'prompts'), /stage-2-reviewer.*\.prompt\.md$/).map((file) => readFileSync(file, 'utf8'))
    const [full = ''] = reviewerPrompt()
    // Otro segundo: el nombre del prompt lleva la marca de tiempo de la corrida.
    await new Promise((done) => setTimeout(done, 1100))
    const second = await runDouble(repo, ['42', '--from-stage', '2'], [{ status: 'failed' }])
    assert.equal(second.code, 1)
    assert.match(out(second), /\] Retomando desde Stage 2 -- worktree existente: .*\n\[.{8}\] Snapshot detectado: [0-9a-f]{40}\n/)
    const prompts = reviewerPrompt()
    assert.equal(prompts.length, 2)
    const pick = (text: string): string[] => text.split('\n').filter((line) => /^(Commit base|HEAD del writer): /.test(line))
    assert.deepEqual(pick(prompts[1] ?? ''), pick(full))
    assert.equal(pick(full).length, 2)
  })
})

describe('espera y reanudacion con el runner real', () => {
  const HOLD = { MEFISTO_AGENT_MAX_ATTEMPTS: '1', MEFISTO_HOLD_MAX_SECONDS: '3600', MEFISTO_HOLD_PROBE_SECONDS: '5' }

  test('ante un limite de uso espera y reanuda la sesion por su id si el runtime lo soporta', async () => {
    const repo = mefisto()
    const run = await runMefistoTooling(repo, ['42'], {
      guion: [{ status: 'failed', kind: 'rate_limit', session: 'sess-1' }, WRITER, REVIEWER],
      env: { ...HOLD, GUION_RESUME: '1' },
    })
    assert.equal(run.code, 0, run.err)
    assert.deepEqual(run.slept, [5])
    assert.deepEqual(
      guionCalls(repo).map((call) => call.resume),
      ['', 'sess-1', ''],
    )
    assert.match(guionCalls(repo)[1]?.prompt ?? '', /^Tu sesion anterior en este mismo stage \(stage 1, agente writer\)/)
    assert.match(eventsLog(repo), /\]\[hold\] RATE_LIMIT: esperando, proxima sonda \d\d:\d\d:\d\d \(techo \d\d:\d\d\)\n/)
    assert.match(flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--body'), /<summary>Writer -- \dm \d+s \(incluye 0m 5s en espera\/hold; reanudo la sesion truncada\)<\/summary>/)
  })

  test('un runtime sin reanudacion repite el stage desde cero', async () => {
    const repo = mefisto()
    const run = await runMefistoTooling(repo, ['42'], { guion: [{ status: 'failed', kind: 'rate_limit', session: 'sess-1' }, WRITER, REVIEWER], env: HOLD })
    assert.equal(run.code, 0, run.err)
    assert.equal(guionCalls(repo)[1]?.resume, '')
    assert.match(eventsLog(repo), /\]\[hold\]\[resume\] writer: runtime 'guion' sin soporte de reanudacion -- reintento sin reanudar \(CA-4b\)\n/)
  })
})

describe('timeout del stage', () => {
  test('MEFISTO_AGENT_TIMEOUT_SECONDS corta al agente colgado y aborta por TIMEOUT', async () => {
    const repo = mefisto()
    const started = Date.now()
    const run = await runMefistoTooling(repo, ['42'], {
      env: {
        MEFISTO_RUNTIME: 'fake',
        MEFISTO_RUNTIME_LIB_DIR: join(REPO_ROOT, 'src', 'runtime', 'lib'),
        MEFISTO_FAKE_SCRIPT: 'hang',
        MEFISTO_AGENT_TIMEOUT_SECONDS: '1',
      },
    })
    assert.equal(run.code, 1)
    assert.match(errText(run), /^x ERROR: writer fallo \(TIMEOUT \(\d+s, exit 124\)\)\./)
    assert.ok(Date.now() - started < 60_000)
  })
})

describe('modo variante', () => {
  let repo: Mefisto
  let run: PipelineRun
  const VARIANT_BRANCH = `${BRANCH}-exp-a`

  before(async () => {
    repo = mefisto()
    run = await runDouble(repo, ['42', '--variant', 'exp-a'], [WRITER, REVIEWER])
  })

  test('rama, worktree, logs y metricas llevan el sufijo', () => {
    assert.equal(run.code, 0, run.err)
    assert.equal(git(repo.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${VARIANT_BRANCH}`).length, 40)
    assert.ok(out(run).includes(`Creando worktree: ${worktreeOf(repo, VARIANT_BRANCH)} (base: origin/main)`))
    assert.equal(logs(repo, /^mefisto-tooling-pipeline-\d{8}-\d{6}-exp-a\.log$/).length, 1)
    assert.equal(logs(repo, /^mefisto-tooling-stage-1-writer-\d{8}-\d{6}-issue-42-exp-a\.log$/).length, 1)
    assert.equal(filesMatching(join(repo.stateDir, 'metrics'), /-issue-42-exp-a-stage-2-reviewer\.json$/).length, 1)
  })

  test('sin push, sin PR y sin comentario al issue', () => {
    assert.equal(git(repo.bare, 'branch', '--list', VARIANT_BRANCH), '')
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    assert.deepEqual(ghCalls(run, 'pr', 'list'), [])
    assert.deepEqual(ghCalls(run, 'issue', 'comment'), [])
    assert.match(out(run), /^! Variante 'exp-a': se omiten push, creacion de PR y comentario al issue \(CA-3\)\.$/m)
    assert.match(out(run), new RegExp(`\\] La rama '${VARIANT_BRANCH}' queda LOCAL -- no se publica a origin\\.\\n`))
  })

  test('el label viaja en el historial y en events.log; el resumen sugiere promoverla', () => {
    const [entry = {}] = history(repo)
    assert.equal(entry.variant, 'exp-a')
    assert.equal(entry.pr, null)
    assert.match(eventsLog(repo), /\] VARIANT: exp-a\n/)
    assert.ok(
      out(run).endsWith(
        `\n=== Pipeline mefisto-tooling (variante 'exp-a') completado ===\n\n  Commits: 2\n  Rama:    ${VARIANT_BRANCH}\n  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)\n  Log:     ${logs(repo, /-exp-a\.log$/)[0]}\n\nSi esta variante gana la comparacion, promuevela a mano:\n  git -C ${repo.root} push -u origin ${VARIANT_BRANCH}\n  gh pr create --base main --head ${VARIANT_BRANCH} --title "Agregar script de CI" --body "Closes #42"\nO relanza el pipeline sin --variant para que una corrida normal abra el PR.\n\n`,
      ),
    )
  })

  test('el status de la variante lleva su sufijo y su label', async () => {
    const other = mefisto()
    await runDouble(other, ['42', '--variant', 'exp-b'], [{ status: 'failed' }])
    const status = readJson(statusFile(other, 'pipeline-status-mefisto-tooling-42-exp-b.json'))
    assert.equal(status.variant, 'exp-b')
    assert.equal(status.state, 'failed')
  })
})

describe('cierre manual y PR existente', () => {
  test('con cierre:manual el PR usa Refs y el comentario lo explica', async () => {
    const repo = mefisto()
    const gh = fakeGh({ issue: { number: 42, title: 'Agregar script de CI', body: 'b', state: 'OPEN', labels: [{ name: 'cierre:manual' }] } })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { gh })
    assert.equal(run.code, 0, run.err)
    assert.match(flag(ghCalls(run, 'pr', 'create')[0] ?? [], '--body'), /\n\nRefs #42$/)
    assert.match(out(run), /^! El issue #42 tiene el label cierre:manual: el PR usara Refs y no cerrara el issue\.\n\[.{8}\] Creando PR\.\.\.$/m)
    assert.equal(flag(ghCalls(run, 'issue', 'comment')[0] ?? [], '--body'), 'Pipeline mefisto-tooling completado. PR: https://github.com/acme/mefisto/pull/7 Este PR no cierra el issue (label cierre:manual).')
  })

  test('un PR abierto de la rama se reutiliza y recibe las metricas como comentario', async () => {
    const repo = mefisto()
    const gh = fakeGh({ openPr: 'https://github.com/acme/mefisto/pull/3' })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { gh })
    assert.equal(run.code, 0, run.err)
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    const [comment = []] = ghCalls(run, 'pr', 'comment')
    assert.equal(comment[2], 'https://github.com/acme/mefisto/pull/3')
    assert.match(flag(comment, '--body'), /^## Metricas de la corrida\n\nActualizado: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+\n\n\| Etapa \| Modelo \|/)
    assert.match(out(run), /^v PR existente reutilizado: https:\/\/github\.com\/acme\/mefisto\/pull\/3$/m)
  })

  test('si gh no puede comentar, solo avisa', async () => {
    const repo = mefisto()
    const gh = fakeGh({ openPr: 'https://github.com/acme/mefisto/pull/3', failing: ['pr comment', 'issue comment'] })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { gh })
    assert.equal(run.code, 0, run.err)
    assert.match(out(run), /^! No se pudo publicar las metricas en el PR reutilizado: https:\/\/github\.com\/acme\/mefisto\/pull\/3$/m)
    assert.match(out(run), /^! No se pudo comentar en el issue #42$/m)
  })

  test('si gh no puede crear el PR, aborta', async () => {
    const run = await runDouble(mefisto(), ['42'], [WRITER, REVIEWER], { gh: fakeGh({ createdPr: null }) })
    assert.equal(run.code, 1)
    assert.match(errText(run), /^x ERROR: No se pudo crear el PR\n/)
    assert.match(errText(run), /pull request create failed/, 'la causa viaja en la cola del log')
  })
})

describe('sincronizacion con main', () => {
  /** Mientras corre el writer, otra rama cambia la misma linea en `origin/main`. */
  function conflicting(repo: Mefisto, steps: GuionStep[]): { launch: LaunchRunner; calls: () => number } {
    const double = runnerDouble(steps)
    return {
      calls: () => double.calls.length,
      launch: (args, output) => {
        if (double.calls.length === 0) {
          const other = join(work, `otro-${++counter}`)
          capture('git', ['clone', '-q', '-b', 'main', repo.bare, other])
          writeFiles(other, { 'docs/README.md': 'cambio en main\n' })
          capture('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'main avanza'])
          capture('git', ['-C', other, 'push', '-q', 'origin', 'main'])
        }
        return double.launch(args, output)
      },
    }
  }
  const WRITER_CONFLICT: GuionStep = { files: { ...WRITER.files, 'docs/README.md': 'cambio del writer\n' }, commit: 'writer' }

  test('un conflicto lo resuelve el writer y la corrida sigue hasta el PR', async () => {
    const repo = mefisto()
    const runner = conflicting(repo, [WRITER_CONFLICT, REVIEWER, { files: { 'docs/README.md': 'resuelto\n' }, commit: 'resolver conflicto' }])
    const run = await runMefistoTooling(repo, ['42'], { deps: { launchRunner: runner.launch } })
    assert.equal(run.code, 0, run.err)
    assert.equal(runner.calls(), 3)
    assert.match(out(run), /\] main tiene 1 commit\(s\) nuevos\. Haciendo merge\.\.\.\n! Merge con conflictos\. Resolviendo\.\.\.\n/)
    assert.match(out(run), /^v Conflictos resueltos$/m)
    const [merge = ''] = filesMatching(join(repo.stateDir, 'prompts'), /stage-merge-writer/)
    assert.match(readFileSync(merge, 'utf8'), /^Hay conflictos de merge con main en los siguientes archivos:\ndocs\/README\.md\n\n/)
  })

  test('si el merge falla, el historial conserva las metricas del writer de Stage 1', async () => {
    const repo = mefisto()
    const runner = conflicting(repo, [WRITER_CONFLICT, REVIEWER, { status: 'failed' }])
    const run = await runMefistoTooling(repo, ['42'], { deps: { launchRunner: runner.launch } })
    assert.equal(run.code, 1)
    assert.match(errText(run), /^x ERROR: writer fallo \(CLI_ERROR \(exit 3\)\)\./)
    const [entry = {}] = history(repo)
    assert.equal(entry.stage, 'merge-writer')
    const writer = (entry.agents as Record<string, Record<string, unknown>>).writer ?? {}
    assert.equal((writer.metrics as Record<string, unknown>).status, 'success', 'las metricas del merge fallido no pisan las del writer')
  })

  test('sin commits nuevos en main lo dice y no mergea', async () => {
    const run = await runDouble(mefisto(), ['42'], [WRITER, REVIEWER])
    assert.match(out(run), /\] La rama ya esta al dia con main\n/)
  })
})

describe('repo real', () => {
  test('el canonico es un shim de tres lineas hacia el modulo', () => {
    const shim = readFileSync(join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-tooling-pipeline.sh'), 'utf8')
    assert.equal(
      shim,
      '#!/usr/bin/env bash\n# Shim: la implementacion vive en mefisto-tooling-pipeline.mts (MEF-ADR-0057). No editar.\nexec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/mefisto-tooling-pipeline.mts" "$@"\n',
    )
  })

  test('runtime, modelos y runner salen de src/runtime/, sin fronteras internas temporales', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-tooling-pipeline.mts'), 'utf8')
    assert.ok(source.includes("from '../../runtime/lib/mefisto-runtime.mts'"))
    assert.ok(source.includes("from '../../runtime/lib/mefisto-models.mts'"))
    assert.ok(source.includes("'runtime', 'mefisto-run-agent.mts'"))
    for (const legacy of [
      ['src', 'internal', 'scripts', 'mefisto-run-agent.sh'],
      ['src', 'internal', 'scripts', 'lib', 'mefisto-models.sh'],
      ['src', 'internal', 'scripts', 'lib', 'runtime-claude.sh'],
    ]) {
      assert.equal(existsSync(join(REPO_ROOT, ...legacy)), false, legacy.join('/'))
    }
  })

  test('el gate de changelog es solo de fragmentos: nada del gate viejo sobre CHANGELOG.md', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-tooling-pipeline.mts'), 'utf8')
    assert.ok(source.includes('changelogFragmentAdded(worktree, snapshot'))
    assert.ok(source.includes('changesRequireChangelog(worktree, snapshot'))
    assert.doesNotMatch(source, /check_unreleased_touched|detect_misplaced_changelog_entry|checkUnreleased/)
  })

  test('el pipeline no inyecta ni revierte .claude/settings.json', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-tooling-pipeline.mts'), 'utf8')
    assert.equal(source.includes("'.claude/settings.json'"), false)
    assert.equal(readdirSync(join(REPO_ROOT, '.claude')).includes('settings.json'), true)
  })
})
