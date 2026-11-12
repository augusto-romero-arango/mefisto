// Corridas de extremo a extremo de `iac-pipeline.mts` sobre un consumidor temporal: guardas, gate
// de dependencias, camino feliz con el runner real, gates de terraform, sincronizacion con main,
// PR, reanudacion desde el Stage 2, estado y cierre en cada camino de salida.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../lib/azure-cli.mts'
import { COLOR, capture } from '../lib/cli.mts'
import { getHarnessIdentity, harnessIdentityJson } from '../lib/pipeline/harness-identity.mts'
import { loggedThrough, stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { applyPendingLine } from '../iac-pipeline.mts'
import { initRepo } from './consumer-sandbox.mts'
import { isolateGitConfig, writeFiles } from './field-note-sandbox.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { BRANCH, TITLE, fakeIac, iacRun, issueJson, newIacConsumer, runIac, statusOf, summaryFile } from './iac-pipeline-sandbox.mts'
import type { IacRun, IacRunOptions } from './iac-pipeline-sandbox.mts'
import { GUION_LIB, eventsLog, flag, guionCalls, history, runnerDouble } from './tooling-pipeline-sandbox.mts'
import type { Consumer } from './tooling-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto iac pipeline ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function consumer(files: Record<string, string> = {}): Consumer {
  counter++
  return newIacConsumer(join(work, `caso-${counter}`), files)
}

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const git = (cwd: string, ...args: string[]): string => capture('git', args, { cwd }).stdout.replace(/\n+$/, '')
const text = (run: IacRun): string => stripAnsi(run.out)
const ghCalls = (run: IacRun, ...command: string[]): string[][] => run.tools.gh.filter((args) => command.every((word, index) => args[index] === word))
const worktreeOf = (repo: Consumer, branch = BRANCH): string => join(repo.stateDir, 'worktrees', branch)
const remoteHas = (repo: Consumer, branch: string): boolean => capture('git', ['-C', repo.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
const mainLog = (repo: Consumer): string => {
  const logs = join(repo.stateDir, 'logs')
  const found = existsSync(logs) ? readdirSync(logs).filter((name) => /^iac-pipeline-\d{8}-\d{6}\.log$/.test(name)) : []
  return found.length === 1 ? join(logs, found[0] ?? '') : ''
}

const WRITER: GuionStep = { files: { 'infra/environments/dev/main.tf': '# base\nresource "x" "y" {}\n', ...summaryFile('1', 'infra-writer', 'Agregue el storage.\n') } }
const REVIEWER: GuionStep = { files: { 'infra/environments/dev/variables.tf': 'variable "z" {}\n', ...summaryFile('2', 'infra-reviewer', 'Revisado.\n') } }

/** Corre con el runner en proceso: mismo pipeline, sin lanzar procesos de agente. */
function runDouble(repo: Consumer, argv: string[], steps: GuionStep[], options: IacRunOptions = {}): Promise<IacRun> & { double: ReturnType<typeof runnerDouble> } {
  const double = runnerDouble(steps)
  return Object.assign(runIac(repo, argv, { ...options, deps: { launchRunner: double.launch, ...options.deps } }), { double })
}

const errorLine = (message: string): string => `\n${COLOR.red}${COLOR.bold}x ERROR: ${message}${COLOR.reset}\n`

describe('guardas previas', () => {
  test('sin argumentos muestra el uso y sale con 1', async () => {
    const run = await runIac(consumer(), [])
    assert.equal(run.code, 1)
    assert.equal(run.out, 'Uso: scripts/iac-pipeline.mts <issue-num> [--env <dev|staging|prod>] [--from-stage N] [--status-file NOMBRE]\n')
  })

  test('fuera de un repo git se niega', async () => {
    const repo = consumer()
    const run = await runIac({ ...repo, root: mkdtempSync(join(work, 'sin-git-')) }, ['42'])
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no estas en un repositorio git\n')
  })

  test('en el repo de Mefisto se niega sin dejar estado', async () => {
    const repo = consumer({ '.claude-plugin/plugin.json': '{"name":"mefisto"}\n' })
    const run = await runIac(repo, ['42'])
    assert.equal(run.code, 1)
    assert.equal(
      run.err,
      'ERROR: scripts/iac-pipeline.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Estas en el repo de Mefisto, que no tiene infraestructura Terraform/Azure.\n' +
        'Para mejorar el plugin usa /mefisto-tooling.\n',
    )
    assert.equal(existsSync(repo.stateDir), false)
  })

  test('sin harness.config.json informa el config requerido', async () => {
    const root = initRepo(join(work, `sin-config-${++counter}`), { 'README.md': 'x\n' })
    const run = await runIac({ root, bare: '', guionFile: join(work, 'guion-sin-config.json'), stateDir: join(root, '.mefisto', 'pipeline') }, ['42'])
    assert.equal(run.code, 1)
    assert.match(run.err, /^ERROR: no se encontro el config canonico requerido .*harness\.config\.json\.\n/)
  })

  const CASES: { name: string; argv: string[]; env?: NodeJS.ProcessEnv; missing?: string; error: string | RegExp }[] = [
    { name: 'argumento desconocido', argv: ['42', '--raro'], error: 'Argumento no reconocido: --raro' },
    { name: '--env sin valor', argv: ['42', '--env'], error: 'Falta el nombre del ambiente' },
    { name: '--from-stage sin valor', argv: ['42', '--from-stage'], error: 'Falta el numero de stage' },
    { name: '--status-file sin valor', argv: ['42', '--status-file'], error: 'Falta el nombre del archivo de status' },
    { name: 'sin issue', argv: ['--env', 'dev'], error: 'Falta el numero de issue' },
    { name: '--from-stage fuera de rango', argv: ['42', '--from-stage', '3'], error: '--from-stage debe ser 1 o 2' },
    { name: 'ambiente sin directorio', argv: ['42', '--env', 'prod'], error: 'No existe el directorio de ambiente: infra/environments/prod' },
    { name: 'falta terraform', argv: ['42'], missing: 'terraform', error: 'Falta comando requerido: terraform' },
    { name: 'falta gh', argv: ['42'], missing: 'gh', error: 'Falta comando requerido: gh' },
    { name: 'falta git', argv: ['42'], missing: 'git', error: 'Falta comando requerido: git' },
    { name: 'runner alterno que no existe', argv: ['42'], env: { MEFISTO_RUN_AGENT_BIN: join(tmpdir(), 'no-existe-runner') }, error: /No es ejecutable el runner neutral: .*no-existe-runner/ },
    { name: 'runtime sin adaptador', argv: ['42'], env: { MEFISTO_RUNTIME: 'inexistente' }, error: /No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador/ },
  ]
  for (const { name, argv, env, missing, error } of CASES) {
    test(`${name}: aborta sin dejar status, historial ni worktree`, async () => {
      const repo = consumer()
      const run = await runIac(repo, argv, { ...(env === undefined ? {} : { env }), deps: { hasCommand: (command) => command !== missing } })
      assert.equal(run.code, 1)
      if (typeof error === 'string') assert.ok(run.out.startsWith(errorLine(error)), run.out)
      else assert.match(text(run), error)
      assert.match(text(run), /Revisa el log: .*iac-pipeline-\d{8}-\d{6}\.log\n/)
      assert.deepEqual(run.tools.gh, [])
      assert.deepEqual(readdirSync(repo.stateDir).filter((entry) => entry !== 'logs'), [])
    })
  }

  test('el ambiente se busca desde el directorio de lanzamiento, no desde la raiz', async () => {
    const repo = consumer()
    mkdirSync(join(repo.root, 'sub'))
    const run = await runIac(repo, ['42'], { cwd: join(repo.root, 'sub') })
    assert.equal(run.code, 1)
    assert.ok(run.out.startsWith(errorLine('No existe el directorio de ambiente: infra/environments/dev')))
  })

  test('nunca exige az ni jq', async () => {
    const run = await runDouble(consumer(), ['42'], [WRITER, REVIEWER])
    assert.equal(run.code, 0, run.out + run.err)
    assert.deepEqual([...new Set(run.asked)].filter((command) => ['gh', 'git', 'terraform', 'az', 'jq'].includes(command)), ['gh', 'git', 'terraform'])
    assert.equal(run.tools.commands.includes('az'), false)
  })
})

describe('issue', () => {
  test('un issue cerrado aborta y deja el fallo en el status y el historial', async () => {
    const repo = consumer()
    const run = await runIac(repo, ['42'], { tools: fakeIac({ issue: issueJson({ state: 'CLOSED' }) }) })
    assert.equal(run.code, 1)
    assert.ok(
      run.out.includes(
        errorLine(
          "El issue #42 esta CLOSED -- una corrida solo procesa issues abiertos.\nEl cierre de un issue de infra lo hace el workflow de CI (infra-cd.yml) tras un 'terraform\napply' exitoso en main (MEF-ADR-0022), no este pipeline. Si necesitas reescribir/revisar la infra\nde un issue ya cerrado, reabrelo primero.",
        ),
      ),
    )
    const status = statusOf(repo)
    assert.equal(status?.state, 'failed')
    assert.equal(status?.stage, 'setup')
    assert.match(String(status?.last_error), /^El issue #42 esta CLOSED -- una corrida solo procesa issues abiertos\. El cierre .* reabrelo primero\. $/)
    const [entry] = history(repo)
    assert.deepEqual(Object.keys(entry ?? {}), ['issue', 'title', 'pipeline', 'identity', 'runtime', 'environment', 'started', 'finished', 'state', 'stage', 'error', 'log'])
    assert.equal(entry?.state, 'failed')
    assert.equal(entry?.title, '', 'el titulo aun no se conocia')
    assert.equal(entry?.environment, 'dev')
    assert.equal(entry?.runtime, 'guion')
    assert.equal(entry?.error, status?.last_error)
    assert.equal(entry?.log, mainLog(repo))
  })

  test('un issue que gh no puede leer aborta con la causa en el log', async () => {
    const repo = consumer()
    const run = await runIac(repo, ['42'], { tools: fakeIac({ issue: null }) })
    assert.equal(run.code, 1)
    assert.ok(run.out.includes(errorLine('No se pudo obtener el issue #42')))
    assert.match(readFileSync(mainLog(repo), 'utf8'), /Could not resolve to an Issue/)
  })
})

describe('gate de dependencias bloqueadas', () => {
  const blocked = (body: string): string => issueJson({ body, labels: [{ name: 'bloqueado' }] })
  const fetchFails = (tools: ReturnType<typeof fakeIac>): Run => {
    const real = iacRun(tools)
    return (command, args, options) => (command === 'git' && args[0] === 'fetch' ? { status: 88, stdout: '', stderr: 'fetch stub\n' } : real(command, args, options))
  }
  const runGate = async (tools: ReturnType<typeof fakeIac>): Promise<IacRun> => {
    const run = fetchFails(tools)
    return runIac(consumer(), ['42'], { tools, deps: { run, runLogged: loggedThrough(run) } })
  }

  test('sin el label no consulta dependencias y sigue hasta el fetch', async () => {
    const tools = fakeIac({ issue: issueJson({ body: '## Dependencias\n- Depende de #7\n' }) })
    const run = await runGate(tools)
    assert.deepEqual(ghCalls(run, 'issue', 'view')[0], ['issue', 'view', '42', '--json', 'number,title,body,state,labels'])
    assert.equal(ghCalls(run, 'issue', 'view', '7').length, 0)
    assert.deepEqual(ghCalls(run, 'issue', 'edit'), [])
    assert.ok(run.out.includes(errorLine('No se pudo hacer fetch de origin/main')))
  })

  test('una dependencia abierta aborta antes de traer origin/main, crear el worktree o invocar agentes', async () => {
    const tools = fakeIac({ issue: blocked('## Dependencias\n- Depende de #7\n'), issues: { '7': '{"state":"OPEN","title":"Dependencia abierta"}' } })
    const run = await runGate(tools)
    assert.equal(run.code, 1)
    assert.ok(
      run.out.includes(errorLine('El issue #42 esta bloqueado. Dependencias abiertas:\n  - #7: Dependencia abierta (OPEN)\n\nResuelve estas dependencias antes de lanzar el pipeline.')),
    )
    assert.deepEqual(ghCalls(run, 'issue', 'view', '7')[0], ['issue', 'view', '7', '--json', 'state,title'])
    assert.equal(text(run).includes('Actualizando origin/main'), false)
    assert.equal(text(run).includes('Invocando'), false)
  })

  test('issue cerrado y PR mergeado: quita el label y continua', async () => {
    const tools = fakeIac({
      issue: blocked('Intro\n## Dependencias\n- Depende de #7 y PR #8, otra vez #7\n## Ambiente\ndev #9'),
      issues: { '7': '{"state":"CLOSED","title":"Issue cerrado"}' },
      prs: { '8': '{"state":"MERGED","title":"PR mergeado"}' },
    })
    const run = await runGate(tools)
    assert.deepEqual(ghCalls(run, 'pr', 'view')[0], ['pr', 'view', '8', '--json', 'state,title'])
    assert.equal(ghCalls(run, 'issue', 'view', '7').length, 1, 'cada dependencia se consulta una vez')
    assert.equal(ghCalls(run, 'issue', 'view', '9').length, 0, 'fuera de la seccion no cuenta')
    assert.deepEqual(ghCalls(run, 'issue', 'edit')[0], ['issue', 'edit', '42', '--remove-label', 'bloqueado'])
    assert.ok(text(run).includes("v Dependencias resueltas: se quito el label 'bloqueado' del issue #42\n"))
    assert.ok(text(run).includes('Actualizando origin/main...'))
  })

  test('una dependencia que gh no encuentra queda como UNKNOWN', async () => {
    const run = await runGate(fakeIac({ issue: blocked('## Dependencias\n#5\n') }))
    assert.ok(run.out.includes('  - #5: titulo no disponible (UNKNOWN)\n'))
  })

  test('una seccion sin referencias quita el label', async () => {
    const run = await runGate(fakeIac({ issue: blocked('## Dependencias\nNinguna.\n') }))
    assert.deepEqual(ghCalls(run, 'issue', 'edit')[0], ['issue', 'edit', '42', '--remove-label', 'bloqueado'])
    assert.ok(text(run).includes('Actualizando origin/main...'))
  })

  test('si no puede quitar el label aborta', async () => {
    const run = await runGate(fakeIac({ issue: blocked('sin seccion'), failing: ['issue edit'] }))
    assert.equal(run.code, 1)
    assert.ok(run.out.includes(errorLine("No se pudo quitar el label 'bloqueado' del issue #42")))
  })
})

describe('camino feliz con el runner real', () => {
  let repo: Consumer
  let run: IacRun
  let base = ''

  before(async () => {
    repo = consumer()
    base = git(repo.root, 'rev-parse', 'HEAD')
    run = await runIac(repo, ['42', '--env', 'dev'], { guion: [WRITER, REVIEWER] })
  })

  test('termina bien e invoca al writer y al reviewer por su id neutral en el worktree', () => {
    assert.equal(run.code, 0, run.out + run.err)
    const calls = guionCalls(repo)
    assert.deepEqual(calls.map((call) => call.agent), ['infra-writer', 'infra-reviewer'])
    for (const call of calls) {
      assert.equal(call.cwd.endsWith(join('worktrees', BRANCH)), true)
      assert.match(call.system, /^You are running in non-interactive print mode\./)
      assert.equal(call.model, '')
      assert.equal(call.resume, '')
    }
  })

  test('los prompts traen el contexto, el ambiente, sus directorios y el commit base', () => {
    const envDirAbs = join(worktreeOf(repo), 'infra', 'environments', 'dev')
    const [writer, reviewer] = guionCalls(repo)
    for (const prompt of [writer?.prompt ?? '', reviewer?.prompt ?? '']) {
      assert.ok(prompt.includes(`# Issue #42: ${TITLE}\n\nCuerpo del issue.\n\nAmbiente target: dev\nDirectorio del ambiente: ${envDirAbs}\nDirectorio relativo del ambiente: infra/environments/dev\nCommit base: ${base}\n`))
    }
    assert.ok(reviewer?.prompt.includes('Diff de archivos .tf modificados en esta rama:\ndiff --git a/infra/environments/dev/main.tf'))
  })

  test('cada gate corre init sin backend y validate en el directorio del ambiente, nunca plan ni apply', () => {
    const envDirAbs = join(worktreeOf(repo), 'infra', 'environments', 'dev')
    assert.deepEqual(
      run.tools.terraformCalls.map((call) => [call.args.join(' '), call.cwd]),
      [
        ['init -backend=false -input=false', envDirAbs],
        ['validate', envDirAbs],
        ['init -backend=false -input=false', envDirAbs],
        ['validate', envDirAbs],
      ],
    )
    assert.ok(text(run).includes('v Gate 1: HCL valido\n'))
    assert.ok(text(run).includes('v Gate 2: HCL revisado y valido\n'))
  })

  test('commitea el HCL de cada stage con su mensaje y muestra la salida de git', () => {
    assert.deepEqual(git(repo.bare, 'log', '--format=%s', `main..${BRANCH}`).split('\n'), ['infra(dev): correcciones de revision issue #42', 'infra(dev): escritura HCL issue #42'])
    assert.match(text(run), /\] Commiteando cambios de HCL\.\.\.\n.*\[infra-issue-42-crear-storage-de-reportes [0-9a-f]+\] infra\(dev\): escritura HCL issue #42\n/s)
    assert.equal(git(repo.bare, 'show', '--name-only', '--format=', `${BRANCH}~1`), 'infra/environments/dev/main.tf')
  })

  test('abre el PR sin Closes, con las decisiones de cada agente y el aviso de apply pendiente', () => {
    const create = ghCalls(run, 'pr', 'create')[0] ?? []
    assert.equal(flag(create, '--title'), `infra(dev): #42 ${TITLE}`)
    assert.equal(flag(create, '--head'), BRANCH)
    const body = flag(create, '--body')
    assert.match(body, /<summary>infra-writer -- \dm \d+s<\/summary>\n\nAgregue el storage\.\n\n<\/details>/)
    assert.match(body, /<summary>infra-reviewer -- \dm \d+s<\/summary>\n\nRevisado\.\n\n<\/details>/)
    assert.match(body, /## Cambios Terraform\n\n infra\/environments\/dev\/main\.tf +\| 1 \+\n infra\/environments\/dev\/variables\.tf \| 1 \+\n 2 files changed, 2 insertions\(\+\)\n\n## Commits\n\n/)
    assert.ok(body.endsWith(`\n\n${applyPendingLine('42')}`))
    assert.equal(body.includes('Closes'), false)
    assert.equal(
      flag(ghCalls(run, 'issue', 'comment')[0] ?? [], '--body'),
      'Pipeline IaC completado (HCL escrito y revisado, sin plan ni apply local). PR: https://github.com/acme/consumidor/pull/7. Infra pendiente de aplicar por CI: el workflow **Infra CD** aplica al mergear a main y cierra este issue tras un apply exitoso (MEF-ADR-0022).',
    )
  })

  test('el historial declara identidad, ambiente, agentes, PR y log; sin harness_version plano', () => {
    const [entry] = history(repo)
    assert.deepEqual(Object.keys(entry ?? {}), ['issue', 'title', 'pipeline', 'identity', 'runtime', 'environment', 'started', 'finished', 'state', 'agents', 'pr', 'log'])
    assert.equal(entry?.state, 'completed')
    assert.equal(entry?.pipeline, 'infra')
    assert.deepEqual(entry?.identity, JSON.parse(harnessIdentityJson(getHarnessIdentity('guion'))))
    assert.equal(entry?.runtime, 'guion')
    assert.equal(entry?.environment, 'dev')
    const agents = entry?.agents as Record<string, { duration: unknown; result: unknown }>
    assert.equal(agents['infra-writer']?.result, 'passed')
    assert.equal(typeof agents['infra-writer']?.duration, 'number')
    assert.equal(agents['infra-reviewer']?.result, 'passed')
    assert.equal(entry?.pr, 'https://github.com/acme/consumidor/pull/7')
    assert.equal(entry?.log, mainLog(repo))
    assert.equal(readFileSync(mainLog(repo), 'utf8').startsWith('Pipeline IaC iniciado: '), true)
  })

  test('borra su status, el worktree y deja el checkout principal limpio', () => {
    assert.equal(statusOf(repo), null)
    assert.equal(existsSync(worktreeOf(repo)), false)
    assert.equal(git(repo.root, 'status', '--porcelain'), '')
    assert.equal(existsSync(join(repo.root, '.claude', 'pipeline')), false)
  })

  test('events.log anota la sesion, los modelos, el effort y cada stage', () => {
    const events = eventsLog(repo)
    assert.match(events, /^=== SESSION IAC \d{8}-\d{6} issue:42 env:dev from-stage:1 runtime:guion ===\n/)
    for (const line of [
      "MODELS: infra-writer runtime=guion perfil=balanced solicitado=<automatico> resuelto='<heredado>'",
      "MODELS: infra-reviewer runtime=guion perfil=deep solicitado=<automatico> resuelto='<heredado>'",
      'EFFORTS: infra-writer -> <heredado> (nivel light)',
      'EFFORTS: infra-reviewer -> <heredado> (nivel standard)',
      '=== IAC STAGE 1: infra-writer ===',
      '=== IAC STAGE 2: infra-reviewer ===',
    ]) {
      assert.ok(events.includes(`] ${line}\n`), line)
    }
  })

  test('deriva el log de cada stage del JSONL neutral', () => {
    const logs = readdirSync(join(repo.stateDir, 'logs'))
    for (const stage of ['1-infra-writer', '2-infra-reviewer']) {
      const name = logs.find((entry) => new RegExp(`^iac-stage-${stage}-\\d{8}-\\d{6}-issue-42\\.log$`).test(entry)) ?? ''
      assert.equal(readFileSync(join(repo.stateDir, 'logs', name), 'utf8'), 'success\n')
      assert.ok(logs.some((entry) => entry.startsWith(`iac-stage-${stage}-`) && entry.endsWith('-attempt-1.events.jsonl')))
    }
  })

  test('el resumen final nombra issue, ambiente, commits, rama, PR y log', () => {
    const summary = run.out.slice(run.out.indexOf(`\n${COLOR.cyan}${COLOR.bold}=== Pipeline IaC completado ===`))
    assert.equal(
      summary,
      `\n${COLOR.cyan}${COLOR.bold}=== Pipeline IaC completado ===${COLOR.reset}\n\n` +
        `  Issue:     #42 -- ${TITLE}\n  Ambiente:  dev\n  Commits:   2\n  Rama:      ${BRANCH}\n` +
        `  PR:        https://github.com/acme/consumidor/pull/7\n  Log:       ${mainLog(repo)}\n\n` +
        `${COLOR.yellow}Infra pendiente de aplicar por CI:${COLOR.reset} el workflow Infra CD aplica al mergear el PR a main y cierra el issue #42 tras un apply exitoso (MEF-ADR-0022).\n\n`,
    )
  })
})

describe('backend.tf del checkout', () => {
  test('sin versionar en origin/main: se copia y se commitea en la rama', async () => {
    const repo = consumer()
    writeFiles(repo.root, { 'infra/environments/dev/backend.tf': 'terraform { backend "azurerm" {} }\n' })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER])
    assert.equal(run.code, 0, run.out)
    assert.ok(text(run).includes('] Copiando backend.tf del working tree al worktree...\n'))
    assert.deepEqual(git(repo.bare, 'log', '--format=%s', `main..${BRANCH}`).split('\n').at(-1), 'infra(dev): incluir backend.tf generado por bootstrap')
  })

  test('ya versionado e identico: no hay nada que commitear', async () => {
    const repo = consumer({ 'infra/environments/dev/backend.tf': 'terraform {}\n' })
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER])
    assert.ok(text(run).includes('] backend.tf ya estaba versionado e identico en origin/main -- sin cambios que commitear\n'))
  })

  test('ausente: avisa y continua', async () => {
    const run = await runDouble(consumer(), ['42'], [WRITER, REVIEWER])
    assert.ok(
      text(run).includes(
        '! No existe infra/environments/dev/backend.tf en el working tree -- el pipeline continua sin abortar; si necesitas backend remoto, ejecuta primero bootstrap-backend.mts\n',
      ),
    )
  })
})

describe('rutas de estado (MEF-ADR-0053)', () => {
  test('un fallo duro del reviewer deja status failed, historial, logs y events.log bajo .mefisto/pipeline', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [WRITER, { status: 'failed', kind: 'api_error' }])
    assert.equal(run.code, 1)
    const status = statusOf(repo)
    assert.equal(status?.state, 'failed')
    assert.equal(status?.stage, '2-infra-reviewer')
    assert.equal(status?.runtime, 'guion')
    assert.equal(typeof status?.identity, 'object')
    assert.deepEqual(Object.keys(status?.hold as object), ['cause', 'next_probe', 'ceiling_seconds', 'accumulated_seconds'])
    assert.deepEqual(status?.agents, { 'infra-writer': { duration: (status?.agents as Record<string, { duration: number }>)['infra-writer']?.duration, result: 'passed' }, 'infra-reviewer': { duration: 0, result: 'failed' } })
    const logs = readdirSync(join(repo.stateDir, 'logs'))
    assert.ok(logs.some((name) => name.startsWith('iac-stage-1-infra-writer-')))
    assert.ok(logs.some((name) => name.startsWith('iac-stage-2-infra-reviewer-')))
    const [entry] = history(repo)
    assert.equal(entry?.state, 'failed')
    assert.equal(entry?.stage, '2-infra-reviewer')
    assert.match(String(entry?.error), /^infra-reviewer fallo \(API_ERROR_CLIENT\)\. Log completo: .*iac-stage-2-infra-reviewer-\d{8}-\d{6}-issue-42\.log $/)
    assert.equal(entry?.log, mainLog(repo))
    assert.match(eventsLog(repo), /\] FALLO infra-reviewer: API_ERROR_CLIENT\n/)
    assert.match(text(run), /\] infra-reviewer fallo tras \d+s -- tipo: API_ERROR_CLIENT\n/)
    assert.ok(run.out.includes(`\n${COLOR.red}-- Ultimas lineas del log de infra-reviewer:${COLOR.reset}\napi_error\n`))
    assert.ok(text(run).includes(`El worktree queda en: ${worktreeOf(repo)}\n`))
    assert.equal(existsSync(join(repo.root, '.claude', 'pipeline')), false)
  })

  test('MEFISTO_STATE_DIR recibe todo el estado y el repo ninguno', async () => {
    const repo = consumer()
    const override = join(work, `estado-${counter}`)
    const run = await runDouble(repo, ['42'], [WRITER, { status: 'failed', kind: 'api_error' }], { env: { MEFISTO_STATE_DIR: override } })
    assert.equal(run.code, 1)
    assert.ok(readdirSync(join(override, 'logs')).some((name) => /^iac-pipeline-/.test(name)))
    assert.equal(existsSync(join(override, 'pipeline-status-infra-42.json')), true)
    assert.equal(history({ ...repo, stateDir: override }).length, 1)
    assert.equal(existsSync(join(override, 'events.log')), true)
    assert.equal(existsSync(join(repo.stateDir, 'logs')), false)
  })

  test('--status-file cambia el nombre del status', async () => {
    const repo = consumer()
    await runDouble(repo, ['42', '--status-file', 'mi-status.json'], [WRITER, { status: 'failed', kind: 'api_error' }])
    assert.equal(existsSync(join(repo.stateDir, 'mi-status.json')), true)
  })
})

describe('espera y reanudacion (MEF-ADR-0051)', () => {
  const HOLD_ENV = { MEFISTO_HOLD_PROBE_SECONDS: '2', MEFISTO_HOLD_MAX_SECONDS: '60' }

  test('durante un rate_limit el status queda en hold con su causa; luego reanuda y completa', async () => {
    const repo = consumer()
    const seen: Record<string, unknown>[] = []
    const run = runDouble(repo, ['42'], [{ status: 'failed', kind: 'rate_limit', session: 'sess-1' }, WRITER, REVIEWER], {
      env: { ...HOLD_ENV, GUION_RESUME: '1' },
      deps: {
        sleep: () => {
          seen.push(statusOf(repo) ?? {})
          return Promise.resolve()
        },
      },
    })
    const result = await run
    assert.equal(result.code, 0, result.out)
    assert.equal(seen[0]?.state, 'hold')
    const hold = seen[0]?.hold as Record<string, unknown>
    assert.match(String(hold.cause), /^RATE_LIMIT/)
    assert.equal(hold.ceiling_seconds, 60)
    assert.match(String(hold.next_probe), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    assert.equal(flag(run.double.calls[1] ?? [], '--resume-session'), 'sess-1')
    assert.equal(run.double.prompts[1], 'Continue the same stage and complete its summary.\n')
    assert.match(text(result), /! infra-writer: RATE_LIMIT\S* -- en espera \(hold\), reanudando sesion truncada\.\.\.\n/)
  })

  test('si la sesion reanudada termina sin resumen se degrada a inicio limpio y lo anota', async () => {
    const repo = consumer()
    const steps: GuionStep[] = [
      { status: 'failed', kind: 'rate_limit', session: 'sess-1' },
      { status: 'failed', kind: 'rate_limit', session: 'sess-1' },
      WRITER,
      REVIEWER,
    ]
    const run = runDouble(repo, ['42'], steps, { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    const result = await run
    assert.equal(result.code, 0, result.out)
    assert.ok(text(result).includes('! infra-writer: la sesion reanudada termino sin resumen; se degrada permanentemente a inicio limpio\n'))
    assert.match(eventsLog(repo), /\]\[hold\]\[resume\] infra-writer: sesion reanudada murio de nuevo sin resumen -- degradado a stage desde cero\n/)
    assert.equal((run.double.calls[2] ?? []).includes('--resume-session'), false)
  })

  test('sin session_id o sin soporte de reanudacion la sonda arranca de cero', async () => {
    const noSession = await runDouble(consumer(), ['42'], [{ status: 'failed', kind: 'rate_limit' }, WRITER, REVIEWER], { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    assert.ok(text(noSession).includes('! infra-writer: terminal sin session_id; la sonda inicia de cero\n'))
    const unsupported = await runDouble(consumer(), ['42'], [{ status: 'failed', kind: 'rate_limit', session: 's' }, WRITER, REVIEWER], { env: HOLD_ENV })
    assert.ok(text(unsupported).includes('! infra-writer: runtime sin capacidad de reanudacion; la sonda inicia de cero\n'))
  })

  test('con el techo agotado aborta con la ultima senal', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [{ status: 'failed', kind: 'rate_limit' }], { env: { MEFISTO_HOLD_MAX_SECONDS: '0' } })
    assert.equal(run.code, 1)
    assert.match(text(run), /! infra-writer: techo de espera \(hold\) agotado -- ultima senal: RATE_LIMIT/)
    assert.equal(statusOf(repo)?.state, 'failed')
  })

  test('stream_cut y un terminal ausente fallan sin esperar', async () => {
    for (const step of [{ status: 'failed' as const, kind: 'stream_cut' }, { silent: true, exit: 0 }]) {
      const repo = consumer()
      const run = runDouble(repo, ['42'], [step])
      assert.equal((await run).code, 1)
      assert.equal(run.double.calls.length, 1)
      assert.equal(eventsLog(repo).includes('[hold]'), false)
    }
  })
})

describe('modelos y effort', () => {
  test('el adaptador fija el modelo de cada stage y se anuncia una vez por stage', async () => {
    const repo = consumer()
    const run = runDouble(repo, ['42'], [WRITER, REVIEWER], { env: { GUION_DEFAULT_MODEL: 'modelo-x' } })
    const result = await run
    assert.deepEqual(run.double.calls.map((args) => flag(args, '--model')), ['modelo-x', 'modelo-x'])
    assert.equal(text(result).split('] Invocando infra-writer (modelo: modelo-x)...\n').length, 2)
    assert.equal(text(result).split('] Invocando infra-reviewer (modelo: modelo-x)...\n').length, 2)
  })

  test('el mapping del consumidor resuelve writer por perfil balanced y reviewer por deep', async () => {
    const repo = consumer({ '.mefisto/models.json': JSON.stringify({ guion: { profiles: { balanced: 'm-balanced', deep: 'm-deep' } } }) })
    const run = runDouble(repo, ['42'], [WRITER, REVIEWER])
    await run
    assert.deepEqual(run.double.calls.map((args) => flag(args, '--model')), ['m-balanced', 'm-deep'])
  })

  test('un mapping invalido aborta antes de descargar el issue', async () => {
    const repo = consumer({ '.mefisto/models.json': '{"guion": {"profiles": {"enorme": "x"}}}' })
    const run = await runIac(repo, ['42'])
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR: No se pudo resolver el modelo de infra-writer \(perfil balanced\): .*models\.json: .*enorme/)
    assert.deepEqual(run.tools.gh, [])
    assert.equal(statusOf(repo)?.state, 'failed')
  })

  test('efforts: sin mapping hereda; con mapping cada agente recibe el nativo de su nivel', async () => {
    const plain = runDouble(consumer(), ['42'], [WRITER, REVIEWER])
    await plain
    assert.equal(plain.double.calls.some((args) => args.includes('--effort')), false)
    const mapping = { guion: { efforts: { levels: { light: 'n-light', standard: 'n-standard' }, agents: { 'infra-writer': 'standard' } } } }
    const mapped = runDouble(consumer({ '.mefisto/models.json': JSON.stringify(mapping) }), ['42'], [WRITER, REVIEWER])
    await mapped
    assert.deepEqual(mapped.double.calls.map((args) => flag(args, '--effort')), ['n-standard', 'n-standard'])
  })

  test('un adaptador que rechaza el nivel de effort aborta citando MEFISTO_EFFORTS_ERROR', async () => {
    const lib = mkdtempSync(join(work, 'adaptador-'))
    const guion = pathToFileURL(join(GUION_LIB, 'runtime-guion.mts')).href
    writeFileSync(join(lib, 'runtime-sineffort.mts'), `export * from '${guion}'\nexport function defaultEffort() { return null }\n`)
    const run = await runIac(consumer(), ['42'], { env: { MEFISTO_RUNTIME: 'sineffort', MEFISTO_RUNTIME_LIB_DIR: lib } })
    assert.equal(run.code, 1)
    assert.ok(run.out.includes(errorLine("No se pudo resolver el effort de infra-writer: MEFISTO_EFFORTS_ERROR=runtime_sineffort_default_effort: no acepta el nivel 'light'")))
    assert.deepEqual(run.tools.gh, [])
  })

  test('un mapping de effort invalido lo detecta antes la resolucion de modelos', async () => {
    const repo = consumer({ '.mefisto/models.json': '{"guion": {"efforts": {"levels": {"enorme": "x"}}}}' })
    const run = await runIac(repo, ['42'])
    assert.match(text(run), /x ERROR: No se pudo resolver el modelo de infra-writer \(perfil balanced\): .*enorme: nivel desconocido/)
  })
})

describe('gates de terraform y commits', () => {
  for (const [stage, init, validate, message] of [
    ['1', [1], [], 'Stage 1 fallido: terraform init fallo'],
    ['1', [0], [1], 'Stage 1 fallido: terraform validate fallo. Revisa el log.'],
    ['2', [0, 1], [0], 'Stage 2 fallido: terraform init fallo'],
    ['2', [0, 0], [0, 1], 'Stage 2 fallido: terraform validate fallo. Revisa el log.'],
  ] as const) {
    test(message, async () => {
      const repo = consumer()
      const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { tools: fakeIac({ terraform: { init: [...init], validate: [...validate] } }) })
      assert.equal(run.code, 1)
      assert.ok(run.out.includes(errorLine(message)))
      assert.equal(statusOf(repo)?.stage, stage === '1' ? '1-infra-writer' : '2-infra-reviewer')
      assert.match(readFileSync(mainLog(repo), 'utf8'), /Error: terraform (init|validate) roto/)
    })
  }

  test('sin commits en la rama aborta', async () => {
    const run = await runDouble(consumer(), ['42'], [summaryStep('1', 'infra-writer'), summaryStep('2', 'infra-reviewer')])
    assert.equal(run.code, 1)
    assert.ok(run.out.includes(errorLine(`No hay commits en la rama ${BRANCH}.`)))
  })

  test('lo que el agente deja fuera de infra/ no entra en los commits del pipeline', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [{ files: { ...WRITER.files, 'docs/nota.md': 'x\n' } }, REVIEWER])
    assert.equal(run.code, 0, run.out)
    assert.equal(git(repo.bare, 'show', '--name-only', '--format=', `${BRANCH}~1`), 'infra/environments/dev/main.tf')
  })
})

function summaryStep(stage: '1' | '2', agent: 'infra-writer' | 'infra-reviewer'): GuionStep {
  return { files: summaryFile(stage, agent, 'Nada que cambiar.\n') }
}

describe('sincronizacion con main y PR', () => {
  test('si origin/main avanzo, mergea antes de publicar', async () => {
    const repo = consumer()
    const run = await runAdvancing(repo, { 'README.md': 'nuevo\n' })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /\] main tiene 1 commit\(s\) nuevos\. Haciendo merge\.\.\.\nv Merge automatico exitoso\n/)
  })

  test('un merge con conflictos aborta dejando el worktree', async () => {
    const repo = consumer()
    const run = await runAdvancing(repo, { 'infra/environments/dev/main.tf': '# otro cambio\n' })
    assert.equal(run.code, 1)
    assert.ok(run.out.includes(errorLine(`Merge con main tiene conflictos. Resuelve manualmente en: ${worktreeOf(repo)}`)))
  })

  test('sin cambios en main lo dice y publica', async () => {
    const run = await runDouble(consumer(), ['42'], [WRITER, REVIEWER])
    assert.ok(text(run).includes('] La rama ya esta al dia con main\n'))
  })

  test('un PR abierto de la rama se reutiliza', async () => {
    const run = await runDouble(consumer(), ['42'], [WRITER, REVIEWER], { tools: fakeIac({ openPr: 'https://github.com/acme/consumidor/pull/3' }) })
    assert.ok(text(run).includes('v PR existente reutilizado: https://github.com/acme/consumidor/pull/3\n'))
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
  })

  test('si no puede crear el PR solo avisa: el comentario dice pendiente y el historial queda sin PR', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['42'], [WRITER, REVIEWER], { tools: fakeIac({ createdPr: null }) })
    assert.equal(run.code, 0)
    assert.ok(text(run).includes('! No se pudo crear el PR automaticamente\n'))
    assert.match(flag(ghCalls(run, 'issue', 'comment')[0] ?? [], '--body'), /PR: pendiente\./)
    assert.equal(history(repo)[0]?.pr, '')
    assert.equal(text(run).includes('  PR:'), false)
  })

  test('si no puede publicar la rama aborta', async () => {
    const tools = fakeIac()
    const real = iacRun(tools)
    const run: Run = (command, args, options) => (command === 'git' && args.includes('push') ? { status: 1, stdout: '', stderr: 'rejected\n' } : real(command, args, options))
    const result = await runDouble(consumer(), ['42'], [WRITER, REVIEWER], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 1)
    assert.ok(result.out.includes(errorLine(`No se pudo hacer push de la rama ${BRANCH}`)))
  })

  test('los fallos del comentario y del borrado del worktree solo avisan', async () => {
    const tools = fakeIac({ failing: ['issue comment'] })
    const real = iacRun(tools)
    const run: Run = (command, args, options) => (command === 'git' && args[0] === 'worktree' && args[1] === 'remove' ? { status: 1, stdout: '', stderr: 'locked\n' } : real(command, args, options))
    const repo = consumer()
    const result = await runDouble(repo, ['42'], [WRITER, REVIEWER], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 0)
    assert.ok(text(result).includes('! No se pudo comentar en el issue #42\n'))
    assert.ok(text(result).includes(`! No se pudo eliminar el worktree. Eliminalo manualmente: git worktree remove --force ${worktreeOf(repo)}\n`))
  })
})

/** Corre writer y reviewer; mientras corre el reviewer, origin/main avanza con `files` desde otro clon. */
function runAdvancing(repo: Consumer, files: Record<string, string>): Promise<IacRun> {
  const double = runnerDouble([WRITER, REVIEWER])
  const launch: typeof double.launch = (args, output) => {
    if (double.calls.length === 1) advanceMain(repo, files)
    return double.launch(args, output)
  }
  return runIac(repo, ['42'], { deps: { launchRunner: launch } })
}

function advanceMain(repo: Consumer, files: Record<string, string>): void {
  const other = join(work, `otro-${++counter}`)
  capture('git', ['clone', '-q', '-b', 'main', repo.bare, other])
  capture('git', ['-C', other, 'config', 'user.email', 'otro@mefisto.local'])
  capture('git', ['-C', other, 'config', 'user.name', 'Otro'])
  writeFiles(other, files)
  capture('git', ['-C', other, 'add', '.'])
  capture('git', ['-C', other, 'commit', '-q', '-m', 'avance en origin'])
  capture('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:main'])
}

describe('retomar desde el Stage 2', () => {
  test('sin worktree aborta', async () => {
    const repo = consumer()
    const run = await runIac(repo, ['42', '--from-stage', '2'])
    assert.equal(run.code, 1)
    assert.ok(run.out.includes(errorLine(`No existe el worktree en ${worktreeOf(repo)}. No se puede retomar desde Stage 2.`)))
  })

  test('con el worktree de una corrida fallida solo corre el reviewer, sobre el snapshot de main', async () => {
    const repo = consumer()
    const first = await runDouble(repo, ['42'], [WRITER, { status: 'failed', kind: 'api_error' }])
    assert.equal(first.code, 1)
    rmSync(join(repo.stateDir, 'pipeline-history.jsonl'))
    const run = runDouble(repo, ['42', '--from-stage', '2'], [REVIEWER])
    const result = await run
    assert.equal(result.code, 0, result.out)
    assert.equal(run.double.calls.length, 1)
    assert.equal(flag(run.double.calls[0] ?? [], '--agent'), 'infra-reviewer')
    assert.ok(text(result).includes(`] Retomando desde Stage 2 -- worktree existente: ${worktreeOf(repo)}\n`))
    assert.ok(text(result).includes(`] Snapshot detectado: ${git(repo.root, 'rev-parse', 'main')}\n`))
    const body = flag(ghCalls(result, 'pr', 'create')[0] ?? [], '--body')
    assert.ok(body.includes('<summary>infra-writer -- 0m 0s</summary>'))
    const agents = history(repo)[0]?.agents as Record<string, { duration: unknown; result: unknown }>
    assert.deepEqual(agents['infra-writer'], { duration: null, result: 'pending' })
    assert.equal(agents['infra-reviewer']?.result, 'passed')
  })

  test('si solo existe el worktree en la ubicacion anterior, usa ese', async () => {
    const repo = consumer()
    await runDouble(repo, ['42'], [WRITER, { status: 'failed', kind: 'api_error' }])
    const legacy = join(repo.root, '..', BRANCH)
    renameSync(worktreeOf(repo), legacy)
    capture('git', ['-C', repo.root, 'worktree', 'repair', legacy])
    const result = await runDouble(repo, ['42', '--from-stage', '2'], [REVIEWER])
    assert.equal(result.code, 0, result.out)
    assert.ok(text(result).includes(`] Worktree no encontrado en la ruta nueva; usando el de la ruta anterior: ${legacy}\n`))
  })
})

describe('cierre en cada camino de salida', () => {
  test('el directorio temporal se borra al terminar bien y al abortar', async () => {
    for (const steps of [[WRITER, REVIEWER], [{ status: 'failed' as const, kind: 'api_error' }]]) {
      const tempRoot = mkdtempSync(join(work, 'temporales-'))
      await runDouble(consumer(), ['42'], steps, { deps: { tempRoot } })
      assert.deepEqual(readdirSync(tempRoot), [])
    }
  })

  test('un git que falla sin aborto termina con su codigo y, como el bash, no toca el status', async () => {
    const repo = consumer()
    const tools = fakeIac()
    const real = iacRun(tools)
    const run: Run = (command, args, options) => (command === 'git' && args.includes('remote') ? { status: 2, stdout: '', stderr: "error: No such remote 'origin'\n" } : real(command, args, options))
    const result = await runDouble(repo, ['42'], [WRITER, REVIEWER], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 2)
    assert.equal(result.err, "error: No such remote 'origin'\n")
    assert.equal(statusOf(repo)?.state, 'passed')
    assert.deepEqual(history(repo), [])
  })

  test('SIGTERM durante una espera termina con 143 y limpia los temporales', async () => {
    const repo = consumer()
    const signals = new EventEmitter()
    const exits: number[] = []
    const tempRoot = mkdtempSync(join(work, 'temporales-senal-'))
    await runDouble(repo, ['42'], [{ status: 'failed', kind: 'rate_limit' }], {
      env: { MEFISTO_HOLD_PROBE_SECONDS: '1' },
      deps: {
        tempRoot,
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
    assert.deepEqual(readdirSync(tempRoot), [])
    assert.equal(statusOf(repo)?.state, 'hold', 'sin trap de salida en el bash, el status queda como estaba')
  })
})

describe('como proceso', () => {
  test('el modulo corre directo con Node y sin argumentos muestra el uso', () => {
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'iac-pipeline.mts')], { cwd: consumer().root })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /^Uso: .*iac-pipeline\.mts <issue-num> \[--env <dev\|staging\|prod>\] \[--from-stage N\] \[--status-file NOMBRE\]\n$/)
  })

  test('la copia distribuida en dist/claude carga toda su clausura', () => {
    const result = capture(process.execPath, [join(REPO_ROOT, 'dist', 'claude', 'scripts', 'iac-pipeline.mts'), '42', '--raro'], { cwd: consumer().root })
    assert.equal(result.status, 1, result.stderr)
    assert.match(stripAnsi(result.stdout), /x ERROR: Argumento no reconocido: --raro\n/)
  })

  test('en el repo de Mefisto el proceso se niega', () => {
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'iac-pipeline.mts'), '42'], { cwd: REPO_ROOT })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: scripts\/iac-pipeline\.mts es del plugin publicado y solo aplica al consumidor\.\n/)
  })
})
