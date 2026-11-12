// Corridas de extremo a extremo de `pr-sync.mts` sobre un consumidor temporal con remoto bare:
// guardas, ubicacion del estado, sincronizacion, conflictos, tests, push, merge, resumen y cierre.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../lib/cli.mts'
import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { configJson } from './consumer-sandbox.mts'
import { git, isolateGitConfig } from './field-note-sandbox.mts'
import {
  FIXTURES,
  TESTS_FAIL,
  TEST_PROJECT,
  advanceMain,
  fakeDotnet,
  fakeGithub,
  openPrBranch,
  runPrSync,
  syncConsumer,
} from './pr-sync-sandbox.mts'
import type { FakePr, SyncRun } from './pr-sync-sandbox.mts'
import { guionCalls, readJson } from './tooling-pipeline-sandbox.mts'
import type { Consumer } from './tooling-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto pr-sync ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function consumer(files: Record<string, string> = {}): Consumer {
  counter++
  return syncConsumer(join(work, `caso-${counter}`), files)
}

const text = (run: SyncRun): string => stripAnsi(run.out)
const ghCalls = (run: SyncRun, ...command: string[]): string[][] =>
  run.github.calls.filter((args) => command.every((word, index) => args[index] === word))
const statusOf = (repo: Consumer, pr = '7'): Record<string, unknown> => readJson(join(repo.stateDir, `pipeline-status-pr-sync-${pr}.json`))
const logOf = (repo: Consumer): string => {
  const [name = ''] = readdirSync(join(repo.stateDir, 'logs')).filter((entry) => /^pr-sync-\d{8}-\d{6}\.log$/.test(entry))
  return readFileSync(join(repo.stateDir, 'logs', name), 'utf8')
}
const BRANCH = 'worktree-issue-3-agregar-pedido'
const PR = (overrides: Partial<FakePr> = {}): FakePr => ({ state: 'OPEN', title: 'Agregar pedido', branch: BRANCH, ...overrides })

/** Consumidor con el PR #7 en `BRANCH` y `main` adelantado sin conflictos. */
function behindConsumer(prFiles: Record<string, string> = { 'src/Pedido.cs': 'class Pedido {}\n' }, mainFiles: Record<string, string> = { 'docs/main.md': 'nuevo en main\n' }): Consumer {
  const repo = consumer({ 'README.md': 'base\n' })
  openPrBranch(repo, BRANCH, prFiles)
  advanceMain(repo, mainFiles)
  return repo
}

/** Consumidor cuyo PR #7 y `main` editan la misma linea de README.md. */
function conflictConsumer(): Consumer {
  return behindConsumer({ 'README.md': 'version del PR\n' }, { 'README.md': 'version de main\n' })
}

const RESOLVE = { files: { 'README.md': 'version del PR\nversion de main\n' }, commit: 'resolver conflictos' }

describe('guardas previas', () => {
  test('sin argumentos muestra el uso y sale con 1', async () => {
    const repo = consumer()
    const run = await runPrSync(repo, work, [])
    assert.equal(run.code, 1)
    assert.equal(
      run.out,
      'Uso: scripts/pr-sync.mts [PR_NUM...] [--all] [--merge]\n' +
        '  PR_NUM...   Números de PRs a sincronizar (en orden)\n' +
        '  --all       Sincronizar todos los PRs abiertos\n' +
        '  --merge     Mergear a main después de sincronizar\n',
    )
    assert.equal(existsSync(repo.stateDir), false)
  })

  test('el config se carga antes que el uso: sin harness.config.json solo informa el config', async () => {
    const dir = join(work, `sin-config-${++counter}`)
    mkdirSync(dir)
    git(dir, 'init', '-q')
    const run = await runPrSync({ root: dir, bare: '', guionFile: join(dir, 'guion.json'), stateDir: join(dir, '.mefisto', 'pipeline') }, work, [])
    assert.equal(run.code, 1)
    assert.equal(run.out, '')
    assert.match(run.err, /^ERROR: no se encontro .*harness\.config\.json/)
  })

  test('un argumento desconocido se informa en stdout sin dejar estado', async () => {
    const repo = consumer()
    const run = await runPrSync(repo, work, ['7', '--raro'])
    assert.equal(run.code, 1)
    assert.equal(run.out, 'Argumento desconocido: --raro\n')
    assert.equal(existsSync(repo.stateDir), false)
  })

  test('un argumento que empieza por digito cuenta como PR', async () => {
    const repo = consumer()
    const run = await runPrSync(repo, work, ['7abc'], { github: fakeGithub() })
    assert.equal(run.code, 0)
    assert.match(text(run), /PRs a procesar \(en orden\): 7abc\n/)
  })

  // El config se resuelve desde la raiz Git, asi que el aviso propio de pr-sync nunca llega a verse.
  test('fuera de un repo git se niega al resolver el config', async () => {
    const dir = join(work, `sin-git-${++counter}`)
    mkdirSync(join(dir, '.mefisto'), { recursive: true })
    writeFileSync(join(dir, '.mefisto', 'harness.config.json'), configJson())
    const run = await runPrSync({ root: dir, bare: '', guionFile: join(dir, 'guion.json'), stateDir: join(dir, '.mefisto', 'pipeline') }, work, ['7'])
    assert.equal(run.code, 1)
    assert.equal(run.out, '')
    assert.equal(run.err, 'ERROR: no se pudo resolver la raiz del repositorio Git para harness.config.json.\n')
  })

  test('en el repo de Mefisto se niega: el script publicado solo aplica al consumidor', async () => {
    const repo = consumer({ '.claude-plugin/plugin.json': '{"name":"mefisto"}\n' })
    const run = await runPrSync(repo, work, ['7'])
    assert.equal(run.code, 1)
    assert.equal(
      run.err,
      'ERROR: scripts/pr-sync.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Estás en el repo de Mefisto. Para mergear PRs del plugin, usa /mefisto-merge.\n',
    )
    assert.deepEqual(run.github.calls, [])
    assert.equal(existsSync(repo.stateDir), false)
  })

  const FATAL: { name: string; env?: NodeJS.ProcessEnv; missing?: string[]; argv?: string[]; error: string }[] = [
    { name: 'faltan dependencias', missing: ['gh', 'dotnet'], error: '✗ Dependencias faltantes: gh dotnet' },
    { name: 'runner alterno que no existe', env: { MEFISTO_RUN_AGENT_BIN: join(tmpdir(), 'no-existe-runner') }, error: `✗ No es ejecutable el runner neutral: ${join(tmpdir(), 'no-existe-runner')}` },
    {
      name: 'runtime sin adaptador',
      env: { MEFISTO_RUNTIME: 'inexistente' },
      error: "✗ No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador",
    },
    { name: '--merge sin PRs', argv: ['--merge'], error: '✗ No se especificaron PRs. Usa --all o proporciona números de PR.' },
  ]
  for (const { name, env, missing = [], argv = ['7'], error } of FATAL) {
    test(`${name}: aborta en stdout, tras el encabezado, sin consultar PRs`, async () => {
      const repo = consumer()
      const run = await runPrSync(repo, work, argv, {
        ...(env === undefined ? {} : { env }),
        deps: { hasCommand: (command) => !missing.includes(command) },
      })
      assert.equal(run.code, 1)
      assert.match(text(run), /^\n── pr-sync — Sincronización de PRs con main ──\n\[\d\d:\d\d:\d\d\] Log: .*pr-sync-\d{8}-\d{6}\.log\n/)
      assert.ok(text(run).includes(`${error}`), text(run))
      assert.equal(logOf(repo).includes('✗'), false, 'el error no va al log')
      assert.deepEqual(ghCalls(run, 'pr', 'view'), [])
    })
  }
})

describe('ubicacion del estado (MEF-ADR-0053)', () => {
  test('--all sin PRs abiertos termina en 0 y deja el log bajo .mefisto/pipeline/logs', async () => {
    const repo = consumer()
    const run = await runPrSync(repo, work, ['--all'])
    assert.equal(run.code, 0)
    assert.match(text(run), /\] Obteniendo todos los PRs abiertos\.\.\.\n\[.*\] No hay PRs abiertos\.\n$/)
    assert.match(logOf(repo), /No hay PRs abiertos\.\n$/)
    assert.equal(existsSync(join(repo.root, '.claude', 'pipeline')), false, 'nunca escribe en .claude/pipeline')
    assert.match(readFileSync(join(repo.stateDir, 'events.log'), 'utf8'), /EFFORTS: implementer -> <heredado> \(nivel standard\)\n/)
  })

  test('MEFISTO_STATE_DIR redirige el log y no se escribe en la ruta canonica del repo', async () => {
    const repo = consumer()
    const override = join(work, `estado-${++counter}`)
    const run = await runPrSync(repo, work, ['--all'], { env: { MEFISTO_STATE_DIR: override } })
    assert.equal(run.code, 0)
    assert.equal(readdirSync(join(override, 'logs')).filter((name) => name.startsWith('pr-sync-')).length, 1)
    assert.equal(existsSync(join(repo.stateDir, 'logs')), false)
  })

  test('--all procesa los PRs abiertos en orden numerico y reemplaza los dados', async () => {
    const repo = consumer()
    const run = await runPrSync(repo, work, ['3', '--all'], { github: fakeGithub({ openList: '10\n9\n\n100\n' }) })
    assert.match(text(run), /PRs a procesar \(en orden\): 9 10 100\n/)
    assert.deepEqual(ghCalls(run, 'pr', 'list')[0], ['pr', 'list', '--state', 'open', '--json', 'number', '-q', '.[].number'])
  })
})

describe('effort y modelo del implementer (issue #2500)', () => {
  const EFFORTS = { levels: { light: 'n-light', standard: 'n-standard', thorough: 'n-thorough' } }
  const CASES: { name: string; mapping: object | null; native: string }[] = [
    { name: 'sin mapping hereda', mapping: null, native: '<heredado>' },
    { name: 'sin override toma el nivel de fabrica (standard)', mapping: { fake: { efforts: EFFORTS } }, native: 'n-standard' },
    { name: 'efforts.agents.implementer gana', mapping: { fake: { efforts: { ...EFFORTS, agents: { implementer: 'thorough' } } } }, native: 'n-thorough' },
  ]
  for (const { name, mapping, native } of CASES) {
    test(name, async () => {
      const repo = conflictConsumer()
      if (mapping !== null) writeFileSync(join(repo.root, '.mefisto', 'models.json'), JSON.stringify(mapping))
      const run = await runPrSync(repo, work, ['7'], {
        env: { MEFISTO_RUNTIME: 'fake', MEFISTO_RUNTIME_LIB_DIR: '' },
        github: fakeGithub({ prs: { '7': PR() } }),
        steps: [RESOLVE],
      })
      assert.equal(run.code, 0, run.out)
      assert.match(readFileSync(join(repo.stateDir, 'events.log'), 'utf8'), new RegExp(`EFFORTS: implementer -> ${native} \\(nivel standard\\)\\n`))
      const [args = []] = run.runner.calls
      if (native === '<heredado>') assert.equal(args.includes('--effort'), false)
      else assert.equal(args[args.indexOf('--effort') + 1], native)
      assert.equal(args.includes('--model'), false, 'sin modelo resuelto no se pasa --model')
    })
  }

  test('un mapping invalido aborta antes de procesar PRs', async () => {
    const repo = consumer()
    writeFileSync(join(repo.root, '.mefisto', 'models.json'), '{"fake": {"efforts": {"levels": {"standard": 7}}}}')
    const run = await runPrSync(repo, work, ['7'], { env: { MEFISTO_RUNTIME: 'fake', MEFISTO_RUNTIME_LIB_DIR: '' } })
    assert.equal(run.code, 1)
    assert.match(text(run), /✗ No se pudo resolver el (modelo de implementer \(perfil balanced\)|effort de implementer): /)
  })
})

describe('PR al dia con main', () => {
  test('sin --merge no crea worktree y completa el status de sync', async () => {
    const repo = consumer()
    openPrBranch(repo, BRANCH, { 'src/Pedido.cs': 'class Pedido {}\n' })
    const run = await runPrSync(repo, work, ['7'], { github: fakeGithub({ prs: { '7': PR() } }) })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /\n── PR #7 ──\n\[.*\] Rama: worktree-issue-3-agregar-pedido\n\[.*\] Actualizando referencias remotas\.\.\.\n✓ PR #7 ya está al día con main\. Nada que hacer\.\n/)
    assert.deepEqual(readdirSync(run.tempRoot).filter((name) => name.startsWith('pr-sync-')), [])
    const status = statusOf(repo)
    assert.equal(status.stage, 'sync')
    assert.equal(status.state, 'completed')
    assert.equal(status.title, 'Agregar pedido')
    assert.match(text(run), /#7 {7}worktree-issue-3-agregar-pedido {20}al día {8}\n/)
    assert.match(text(run), /✓ pr-sync completado\. Log: .*\.log\n$/)
    assert.equal(run.cleanups, 0)
  })

  test('con --merge mergea con el metodo del repo, desbloquea dependientes y limpia worktrees', async () => {
    const repo = consumer()
    openPrBranch(repo, BRANCH, { 'src/Pedido.cs': 'class Pedido {}\n' })
    const github = fakeGithub({
      prs: { '7': PR({ body: 'Closes #3' }) },
      methods: 'squash rebase\n',
      blocked: `${JSON.stringify([{ number: 9, title: 'Usar pedido', body: '## Dependencias\n\n- Depende de #3\n' }])}\n`,
      issueStates: { '3': 'CLOSED' },
    })
    const run = await runPrSync(repo, work, ['7', '--merge'], { github })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /⚠ Modo --merge activado: cada PR será mergeado a main después de sincronizar\n/)
    assert.deepEqual(ghCalls(run, 'pr', 'merge'), [['pr', 'merge', '7', '--squash', '--delete-branch']])
    assert.deepEqual(ghCalls(run, 'issue', 'edit'), [['issue', 'edit', '9', '--remove-label', 'bloqueado']])
    assert.match(text(run), /✓ PR #7 mergeado a main\n.*PR #7 cierra issue\(s\): 3\. Buscando issues bloqueados dependientes\.\.\.\n.*Desbloqueando issue #9: Usar pedido\n✓ Issue #9 desbloqueado: Usar pedido\n/)
    const status = statusOf(repo)
    assert.equal(status.stage, 'merge')
    assert.equal(status.state, 'completed')
    assert.match(text(run), /#7 {7}worktree-issue-3-agregar-pedido {20}mergeado {7}\n/)
    assert.equal(run.cleanups, 1)
    assert.match(text(run), /\] Limpiando worktrees mergeados o abandonados\.\.\.\n/)
    assert.match(logOf(repo), /worktree-clean simulado\n/)
  })

  test('un fallo inesperado al desbloquear solo avisa: el merge ya se completo', async () => {
    const repo = consumer()
    openPrBranch(repo, BRANCH, { 'src/Pedido.cs': 'x\n' })
    const github = fakeGithub({ prs: { '7': PR({ body: 'Closes #3' }) }, throwing: ['issue list'] })
    const run = await runPrSync(repo, work, ['7', '--merge'], { github })
    assert.equal(run.code, 0)
    assert.match(
      text(run),
      /⚠ Post-merge: fallo al desbloquear issues dependientes del PR #7 \(el merge sí se completó; revisar labels 'bloqueado' manualmente\)\n/,
    )
    assert.equal(statusOf(repo).state, 'completed')
  })

  test('si GitHub nunca lo deja mergear, el PR falla y pr-sync sale con 1 sin limpiar worktrees', async () => {
    const repo = consumer()
    openPrBranch(repo, BRANCH, { 'src/Pedido.cs': 'x\n' })
    const run = await runPrSync(repo, work, ['7', '--merge'], { github: fakeGithub({ prs: { '7': PR({ mergeStates: ['BLOCKED'] }) } }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /\n✗ PR #7: No se pudo mergear después de reintentos\n/)
    const status = statusOf(repo)
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, 'merge')
    assert.equal(status.last_error, 'No se pudo mergear después de reintentos')
    assert.equal(run.cleanups, 0)
    assert.match(text(run), /#7 {7}worktree-issue-3-agregar-pedido {20}ERROR: No se pudo mergear después de reintentos\n/)
    assert.match(text(run), /⚠ Algunos PRs tuvieron errores\. Revisa el log: .*\.log\n$/)
  })
})

describe('PR atrasado sin conflictos', () => {
  let repo: Consumer
  let run: SyncRun

  before(async () => {
    repo = behindConsumer()
    run = await runPrSync(repo, work, ['7'], { github: fakeGithub({ prs: { '7': PR() } }) })
  })

  test('mergea main en un worktree temporal y empuja la rama al remoto', () => {
    assert.equal(run.code, 0, run.out + run.err)
    assert.match(text(run), /\] main tiene 1 commit\(s\) nuevos respecto a la rama\.\n/)
    assert.ok(text(run).includes(`] Creando worktree temporal en ${join(run.tempRoot, 'pr-sync-7-')}`), text(run))
    assert.match(text(run), /\] Haciendo merge de origin\/main\.\.\.\n✓ Merge automático exitoso\n/)
    const remote = git(repo.bare, 'log', '--format=%s', BRANCH)
    assert.match(remote, /^Merge remote-tracking branch 'origin\/main' into worktree-issue-3-agregar-pedido\n/)
    assert.equal(git(repo.bare, 'merge-base', '--is-ancestor', 'main', BRANCH), '')
    assert.match(text(run), /✓ Rama worktree-issue-3-agregar-pedido actualizada en origin\n/)
  })

  test('compila la solucion y corre solo los *.Tests con --no-build', () => {
    const worktree = run.dotnet.calls[0]?.[1]?.replace(/[\\/]Proyecto\.slnx$/, '') ?? ''
    assert.deepEqual(run.dotnet.calls, [
      ['build', join(worktree, 'Proyecto.slnx')],
      ['test', '--project', join(worktree, ...TEST_PROJECT.split('/')) + sep, '--no-build'],
    ])
    assert.equal(run.dotnet.calls.flat().some((arg) => arg.includes('SmokeTests') || arg === '--solution'), false)
    assert.match(text(run), /\] Verificando tests después del merge\.\.\.\n✓ Todos los tests pasan\n/)
    assert.match(logOf(repo), /Build succeeded\.\nPassed! {2}- Failed: 0, Passed: 3/)
  })

  test('limpia el worktree y la rama local, y deja el status de sync completado', () => {
    assert.deepEqual(readdirSync(run.tempRoot).filter((name) => name.startsWith('pr-sync-')), [])
    assert.equal(git(repo.root, 'branch', '--list', BRANCH), '')
    assert.match(text(run), /✓ Worktree temporal limpiado\n/)
    assert.equal(statusOf(repo).state, 'completed')
    assert.match(text(run), /#7 {7}worktree-issue-3-agregar-pedido {20}sincronizado {3}\n/)
    assert.deepEqual(run.runner.calls, [], 'sin conflictos no se invoca al agente')
  })

  test('el resumen final tiene encabezado, separador y una fila por PR', () => {
    assert.match(
      run.out,
      /\n\u001b\[0;36m\u001b\[1m── Resumen ──\u001b\[0m\n\n\u001b\[1mPR {7}Rama {47}Estado {9}\u001b\[0m\n─{77}\n\u001b\[0;34m#7 {7}/,
    )
  })
})

describe('conflictos', () => {
  test('el implementer los resuelve con el prompt de pr-sync y la rama se empuja', async () => {
    const repo = conflictConsumer()
    const run = await runPrSync(repo, work, ['7'], { github: fakeGithub({ prs: { '7': PR() } }), steps: [RESOLVE] })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /⚠ Merge con conflictos\. Invocando implementer para resolverlos\.\.\.\n\[.*\] Archivos en conflicto: README\.md\n\[.*\] Invocando implementer \(modelo: <heredado>\)\.\.\.\n\[.*\] implementer completado en \d+s\n✓ Conflictos resueltos\n/)
    const [args = []] = run.runner.calls
    assert.equal(args[args.indexOf('--agent') + 1], 'implementer')
    assert.match(args[args.indexOf('--cwd') + 1] ?? '', /pr-sync-7-\d+$/)
    assert.equal(args.includes('--events-log') || args.includes('--timeout') || args.includes('--redact-observability'), false)
    assert.equal(run.runner.prompts[0], mergePromptFor('README.md'))
    assert.equal(git(repo.bare, 'show', `${BRANCH}:README.md`), 'version del PR\nversion de main')
    assert.equal(statusOf(repo).state, 'completed')
    const logs = readdirSync(join(repo.stateDir, 'logs'))
    assert.ok(logs.some((name) => /^pr-sync-merge-pr7-\d{8}-\d{6}-attempt-1\.events\.jsonl$/.test(name)), logs.join(','))
  })

  test('con el runner real el agente corre como proceso en el worktree temporal', async () => {
    const repo = conflictConsumer()
    const run = await runPrSync(repo, work, ['7'], { github: fakeGithub({ prs: { '7': PR() } }), guion: [RESOLVE] })
    assert.equal(run.code, 0, run.out + run.err)
    const [call] = guionCalls(repo)
    assert.equal(call?.agent, 'implementer')
    assert.match(call?.cwd ?? '', /pr-sync-7-\d+$/)
    assert.match(call?.system ?? '', /^You are running in non-interactive print mode\./)
    assert.equal(call?.prompt, mergePromptFor('README.md'))
  })

  test('si quedan conflictos el PR falla y el worktree temporal se elimina', async () => {
    const repo = conflictConsumer()
    const run = await runPrSync(repo, work, ['7'], { github: fakeGithub({ prs: { '7': PR() } }), steps: [{}] })
    assert.equal(run.code, 1)
    assert.match(text(run), /\n✗ PR #7: Aún quedan conflictos después del agente: README\.md\n⚠ Worktree temporal queda en: .*pr-sync-7-\d+ \(para inspección\)\n/)
    assert.deepEqual(readdirSync(run.tempRoot).filter((name) => name.startsWith('pr-sync-')), [])
    const status = statusOf(repo)
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, 'merge-pr7')
    assert.equal(status.last_error, 'Aún quedan conflictos después del agente: README.md')
    assert.match(logOf(repo), /\n\u001b\[0;31m\u001b\[1m✗ PR #7: Aún quedan conflictos/, 'el fallo va al log con su color, como tee')
  })

  test('si el agente falla se muestran las ultimas lineas de su salida y el PR falla', async () => {
    const repo = conflictConsumer()
    const run = await runPrSync(repo, work, ['7'], {
      github: fakeGithub({ prs: { '7': PR() } }),
      steps: [{ status: 'failed', kind: 'stream_cut' }],
    })
    assert.equal(run.code, 1)
    assert.match(text(run), /⚠ implementer falló después de \d+s\n\n── Últimas líneas del log de implementer:\n\n✗ PR #7: El agente implementer falló al resolver conflictos\n/)
  })
})

describe('tests despues del merge', () => {
  const CASES: { name: string; dotnet: ReturnType<typeof fakeDotnet>; error: string }[] = [
    { name: 'no compila', dotnet: fakeDotnet({ builds: [{ status: 1, output: 'error CS1002\n' }] }), error: 'Error de compilación post-merge' },
    { name: 'ningun proyecto tenia tests', dotnet: fakeDotnet({ tests: [{ status: 8, output: 'Zero tests ran\n' }] }), error: 'No se ejecutaron tests (posible fallo silencioso)' },
    { name: 'siguen fallando tras el arreglo', dotnet: fakeDotnet({ tests: [TESTS_FAIL] }), error: 'Tests siguen fallando después del segundo intento' },
  ]
  for (const { name, dotnet, error } of CASES) {
    test(`${name}: el PR falla`, async () => {
      const repo = behindConsumer()
      const run = await runPrSync(repo, work, ['7'], { github: fakeGithub({ prs: { '7': PR() } }), dotnet, steps: [{}] })
      assert.equal(run.code, 1)
      assert.match(text(run), new RegExp(`\\n✗ PR #7: ${error.replace(/[()]/g, '\\$&')}\\n`))
      assert.equal(statusOf(repo).last_error, error)
      assert.equal(git(repo.bare, 'log', '-1', '--format=%s', BRANCH), `trabajo de ${BRANCH}`, 'no se empuja nada')
    })
  }

  test('si fallan, el implementer recibe los tests que fallan y la rama se empuja tras arreglarlos', async () => {
    const repo = behindConsumer()
    const run = await runPrSync(repo, work, ['7'], {
      github: fakeGithub({ prs: { '7': PR() } }),
      dotnet: fakeDotnet({ tests: [TESTS_FAIL, { status: 0, output: 'Passed!\n' }] }),
      steps: [{ files: { 'src/Pedido.cs': 'class Pedido { }\n' }, commit: 'arreglar pedido' }],
    })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /⚠ Tests fallan post-merge\. Invocando implementer para arreglar\.\.\.\n/)
    assert.equal(run.runner.prompts[0], fixPromptFor('  Failed Ventas.Tests.PedidoTests.Crear [12 ms]\nFailed!  - Failed: 1, Passed: 2, Skipped: 0, Total: 3'))
    assert.equal(git(repo.bare, 'log', '-1', '--format=%s', BRANCH), 'arreglar pedido')
    assert.equal(run.dotnet.calls.filter((args) => args[0] === 'build').length, 2)
  })

  test('si fallan sin nombrar ningun test, pr-sync muere como el bash y marca el PR interrumpido', async () => {
    const repo = behindConsumer()
    const run = await runPrSync(repo, work, ['7'], {
      github: fakeGithub({ prs: { '7': PR() } }),
      dotnet: fakeDotnet({ tests: [{ status: 1, output: 'algo salio mal\n' }] }),
    })
    assert.equal(run.code, 1)
    assert.equal(text(run).includes('── Resumen ──'), false)
    assert.deepEqual(run.runner.calls, [])
    const status = statusOf(repo)
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, 'sync')
    assert.equal(status.last_error, 'pr-sync interrumpido')
  })
})

describe('otros caminos por PR', () => {
  test('un PR que no esta abierto se salta sin status', async () => {
    const repo = consumer()
    const run = await runPrSync(repo, work, ['7', '8'], { github: fakeGithub({ prs: { '7': PR({ state: 'MERGED' }) } }) })
    assert.equal(run.code, 0)
    assert.match(text(run), /⚠ PR #7 no está abierto \(estado: MERGED\)\. Saltando\.\n/)
    assert.match(text(run), /⚠ PR #8 no está abierto \(estado: NOT_FOUND\)\. Saltando\.\n/)
    assert.equal(existsSync(join(repo.stateDir, 'pipeline-status-pr-sync-7.json')), false)
    assert.match(text(run), /#7 {7}\(n\/a\) {46}omitido \(MERGED\)\n/)
  })

  test('si la rama no existe en el remoto el PR falla y el siguiente sigue', async () => {
    const repo = consumer()
    openPrBranch(repo, BRANCH, { 'src/Pedido.cs': 'x\n' })
    const run = await runPrSync(repo, work, ['7', '8'], {
      github: fakeGithub({ prs: { '7': PR({ branch: 'rama-borrada' }), '8': PR() } }),
    })
    assert.equal(run.code, 1)
    assert.match(text(run), /\n✗ PR #7: No se pudo hacer fetch de origin\/rama-borrada\n/)
    assert.equal(statusOf(repo, '7').state, 'failed')
    assert.equal(statusOf(repo, '8').state, 'completed')
  })

  test('si el push se rechaza el PR falla', async () => {
    const repo = behindConsumer()
    const run = await runPrSync(repo, work, ['7'], {
      github: fakeGithub({ prs: { '7': PR() } }),
      failLogged: (command, args) => (command === 'git' && args.includes('push') ? 1 : undefined),
    })
    assert.equal(run.code, 1)
    assert.match(text(run), /\] Haciendo push de la rama actualizada\.\.\.\n\n✗ PR #7: No se pudo hacer push de worktree-issue-3-agregar-pedido\n/)
    const push = run.logged.find((args) => args.includes('push')) ?? []
    assert.deepEqual(push.slice(-4), ['push', 'origin', BRANCH, '--force-with-lease'])
  })

  test('si gh no devuelve la rama, pr-sync termina con su codigo y marca el PR interrumpido', async () => {
    const repo = consumer()
    const github = fakeGithub({ prs: { '7': PR() } })
    const run = await runPrSync(repo, work, ['7'], {
      github,
      deps: {
        run: (command, args, options) =>
          command === 'gh' && args.includes('headRefName')
            ? { status: 4, stdout: '', stderr: 'gh: sin red\n' }
            : command === 'gh'
              ? { status: 0, stdout: `${JSON.stringify({ state: 'OPEN', title: 'Agregar pedido' })}\n`, stderr: '' }
              : capture(command, args, options),
      },
    })
    assert.equal(run.code, 4)
    assert.equal(run.err, 'gh: sin red\n')
    const status = statusOf(repo)
    assert.equal(status.state, 'failed')
    assert.equal(status.last_error, 'pr-sync interrumpido')
  })

  test('un fallo de worktree-clean solo avisa', async () => {
    const repo = consumer()
    openPrBranch(repo, BRANCH, { 'src/Pedido.cs': 'x\n' })
    const run = await runPrSync(repo, work, ['7', '--merge'], { github: fakeGithub({ prs: { '7': PR() } }), cleanStatus: 1 })
    assert.equal(run.code, 0)
    assert.match(text(run), /⚠ worktree-clean\.mts fallo; la limpieza de worktrees quedo pendiente \(ver .*\.log\)\n/)
  })
})

describe('cierre ante una senal', () => {
  test('SIGTERM durante la espera de un hold marca el PR interrumpido y termina con 143', async () => {
    const repo = conflictConsumer()
    const signals = new EventEmitter()
    const exits: number[] = []
    const run = await runPrSync(repo, work, ['7'], {
      github: fakeGithub({ prs: { '7': PR() } }),
      steps: [{ status: 'failed', kind: 'rate_limit' }],
      deps: {
        signals,
        exit: (code) => {
          exits.push(code)
          throw new Error('proceso terminado')
        },
        sleep: () => {
          signals.emit('SIGTERM', 'SIGTERM')
          return Promise.resolve()
        },
      },
    })
    assert.deepEqual(exits, [143])
    assert.equal(run.code, 1, 'en el test el proceso no muere: el codigo real lo fija exit(143)')
    const status = statusOf(repo)
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, 'merge-pr7')
    assert.equal(status.last_error, 'pr-sync interrumpido')
    assert.deepEqual(
      readdirSync(run.tempRoot).filter((name) => name.startsWith('mefisto-pr-sync.')),
      [],
      'los temporales de la corrida se borran',
    )
  })
})

describe('como proceso', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..')

  test('el modulo corre directo con Node', () => {
    const repo = consumer()
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'pr-sync.mts'), '7', '--raro'], { cwd: repo.root })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, 'Argumento desconocido: --raro\n')
  })

  test('la copia distribuida en dist/claude carga toda su clausura', () => {
    const repo = consumer()
    const result = capture(process.execPath, [join(REPO_ROOT, 'dist', 'claude', 'scripts', 'pr-sync.mts')], { cwd: repo.root })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /^Uso: .*pr-sync\.mts \[PR_NUM\.\.\.\] \[--all\] \[--merge\]\n/)
  })

})

function mergePromptFor(files: string): string {
  return readFileSync(join(FIXTURES, 'merge.prompt.txt'), 'utf8').replace('README.md\nsrc/Ventas/Pedido.cs', files)
}

function fixPromptFor(failed: string): string {
  return readFileSync(join(FIXTURES, 'fix.prompt.txt'), 'utf8').replace(
    '  Failed Ventas.Tests.PedidoTests.Crear [12 ms]\n  Con error Ventas.Tests.PedidoTests.Anular',
    failed,
  )
}
