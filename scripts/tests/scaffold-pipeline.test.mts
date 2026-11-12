// Corridas de extremo a extremo de `scaffold-pipeline.mts` sobre un consumidor temporal: guardas,
// camino feliz con el runner real, rutas de estado, gates de commit, integridad y pines, PR y
// cierre en cada camino de salida.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../lib/azure-cli.mts'
import { COLOR, capture } from '../lib/cli.mts'
import { loggedThrough, stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { scaffoldPrompt } from '../scaffold-pipeline.mts'
import { initRepo } from './consumer-sandbox.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { FIXTURES, PROJECT, mainLog, runScaffold, scaffoldFiles } from './scaffold-pipeline-sandbox.mts'
import type { ScaffoldRun, ScaffoldRunOptions } from './scaffold-pipeline-sandbox.mts'
import { GUION_LIB, eventsLog, fakeTools, flag, guionCalls, history, newConsumer, runWith, runnerDouble } from './tooling-pipeline-sandbox.mts'
import type { Consumer } from './tooling-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto scaffold pipeline ')))
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

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const git = (cwd: string, ...args: string[]): string => capture('git', args, { cwd }).stdout.replace(/\n+$/, '')
const text = (run: ScaffoldRun): string => stripAnsi(run.out)
const errText = (run: ScaffoldRun): string => stripAnsi(run.err)
const ghCalls = (run: ScaffoldRun, ...command: string[]): string[][] =>
  run.tools.gh.filter((args) => command.every((word, index) => args[index] === word))
const worktreeOf = (repo: Consumer, branch = 'scaffold-prueba'): string => join(repo.stateDir, 'worktrees', branch)
const remoteHas = (repo: Consumer, branch: string): boolean => capture('git', ['-C', repo.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0

const SANO: GuionStep = { files: scaffoldFiles(), commit: 'scaffold(prueba): nuevo dominio Prueba' }

/** Corre con el runner en proceso: mismo pipeline, sin lanzar procesos de agente. */
function runDouble(repo: Consumer, argv: string[], steps: GuionStep[], options: ScaffoldRunOptions = {}): Promise<ScaffoldRun> & { double: ReturnType<typeof runnerDouble> } {
  const double = runnerDouble(steps)
  const promise = runScaffold(repo, argv, { ...options, deps: { launchRunner: double.launch, ...options.deps } })
  return Object.assign(promise, { double })
}

const abortLine = (message: string): string => `\n${COLOR.red}${COLOR.bold}x ${message}${COLOR.reset}\n`

describe('guardas previas', () => {
  test('fuera de un repo git se niega', async () => {
    const repo = consumer()
    const run = await runScaffold({ ...repo, root: mkdtempSync(join(work, 'sin-git-')) }, ['--domain', 'prueba'])
    assert.equal(run.code, 1)
    assert.equal(run.err, 'ERROR: no estas en un repositorio git\n')
  })

  test('en el repo de Mefisto se niega sin dejar estado', async () => {
    const repo = consumer({ '.claude-plugin/plugin.json': '{"name":"mefisto"}\n' })
    const run = await runScaffold(repo, ['--domain', 'prueba'])
    assert.equal(run.code, 1)
    assert.equal(
      run.err,
      'ERROR: scripts/scaffold-pipeline.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Estas en el repo de Mefisto, que no crea dominios de negocio.\n' +
        'Para mejorar el plugin usa /mefisto-tooling.\n',
    )
    assert.equal(existsSync(repo.stateDir), false)
  })

  test('sin harness.config.json informa el config requerido', async () => {
    const root = initRepo(join(work, `sin-config-${++counter}`), { 'README.md': 'x\n' })
    const run = await runScaffold({ root, bare: '', guionFile: join(work, 'guion-sin-config.json'), stateDir: join(root, '.mefisto', 'pipeline') }, ['--domain', 'prueba'])
    assert.equal(run.code, 1)
    assert.match(run.err, /^ERROR: no se encontro el config canonico requerido .*harness\.config\.json\.\n/)
  })

  test('--help imprime la ayuda tal cual la imprimia el bash y sale con 0', async () => {
    const repo = consumer()
    for (const flagName of ['--help', '-h']) {
      const run = await runScaffold(repo, ['--domain', 'prueba', flagName])
      assert.equal(run.code, 0)
      assert.equal(run.out, readFileSync(join(FIXTURES, 'help.txt'), 'utf8'))
    }
    assert.equal(existsSync(join(repo.stateDir, 'events.log')), true, 'el bash preparaba el estado antes de leer los argumentos')
  })

  const CASES: { name: string; argv: string[]; env?: NodeJS.ProcessEnv; missing?: string; error: string | RegExp }[] = [
    { name: 'argumento desconocido', argv: ['--raro'], error: 'Argumento desconocido: --raro. Usa --help para ver el uso.' },
    { name: '--domain sin valor', argv: ['--domain'], error: 'Falta el nombre del dominio para --domain' },
    {
      name: 'sin issue ni dominio',
      argv: [],
      error: "No se pudo determinar el nombre del dominio. Usa --domain <nombre> o incluye 'Dominio: nombre' en el body del issue.",
    },
    { name: '--domain= vacio', argv: ['--domain='], error: "No se pudo determinar el nombre del dominio. Usa --domain <nombre> o incluye 'Dominio: nombre' en el body del issue." },
    { name: 'dominio que no es kebab-case', argv: ['--domain', '9-ventas'], error: 'El nombre del dominio no se pudo normalizar a kebab-case. Recibido: 9-ventas' },
    { name: 'falta gh', argv: ['--domain', 'prueba'], missing: 'gh', error: 'gh no esta instalado' },
    { name: 'falta git', argv: ['--domain', 'prueba'], missing: 'git', error: 'git no esta instalado' },
    {
      name: 'runner alterno que no existe',
      argv: ['--domain', 'prueba'],
      env: { MEFISTO_RUN_AGENT_BIN: join(tmpdir(), 'no-existe-runner') },
      error: /^No es ejecutable el runner neutral: .*no-existe-runner$/,
    },
    {
      name: 'runtime sin adaptador',
      argv: ['--domain', 'prueba'],
      env: { MEFISTO_RUNTIME: 'inexistente' },
      error: /^No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador/,
    },
  ]
  for (const { name, argv, env, missing, error } of CASES) {
    test(`${name}: aborta por stderr, lo anota en el log y no crea worktree`, async () => {
      const repo = consumer()
      const run = await runScaffold(repo, argv, { ...(env === undefined ? {} : { env }), deps: { hasCommand: (command) => command !== missing } })
      assert.equal(run.code, 1)
      assert.equal(run.out, '')
      const message = /^\nx (.*)\n$/.exec(errText(run))?.[1] ?? ''
      if (typeof error === 'string') assert.equal(run.err, abortLine(error))
      else assert.match(message, error)
      assert.ok(readFileSync(mainLog(repo.stateDir), 'utf8').endsWith(`ABORT ${message}\n`))
      assert.equal(existsSync(join(repo.stateDir, 'worktrees')), false)
      assert.deepEqual(run.tools.gh, [])
    })
  }

  test('jq ya no es dependencia', async () => {
    const run = await runDouble(consumer(), ['--domain', 'prueba'], [SANO], { deps: { hasCommand: (command) => command !== 'jq' } })
    assert.equal(run.code, 0, run.err)
  })

  test('un dominio que ya existe aborta antes del label', async () => {
    const run = await runScaffold(consumer({ [`src/${PROJECT}/x.cs`]: 'x\n' }), ['--domain', 'Prueba'])
    assert.equal(run.code, 1)
    assert.equal(run.err, abortLine(`El dominio ya existe: src/${PROJECT}`))
    assert.deepEqual(run.tools.gh, [])
  })

  test('un issue cerrado aborta con su estado', async () => {
    const tools = fakeTools({ issue: { number: 42, title: 'x', body: 'Dominio: prueba', state: 'CLOSED' } })
    const run = await runScaffold(consumer(), ['42'], { tools })
    assert.equal(run.code, 1)
    assert.equal(run.err, abortLine('El issue #42 no esta abierto (estado: CLOSED)'))
  })

  test('un issue que gh no puede leer aborta y deja la causa en el log', async () => {
    const repo = consumer()
    const run = await runScaffold(repo, ['42'], { tools: fakeTools({ issue: null }) })
    assert.equal(run.code, 1)
    assert.equal(run.err, abortLine('No se pudo obtener el issue #42'))
    assert.match(readFileSync(mainLog(repo.stateDir), 'utf8'), /Could not resolve to an Issue/)
  })

  test('un issue sin Dominio en el body y sin --domain aborta', async () => {
    const tools = fakeTools({ issue: { number: 42, title: 'x', body: 'Sin dominio aqui', state: 'OPEN' } })
    const run = await runScaffold(consumer(), ['42'], { tools })
    assert.equal(run.code, 1)
    assert.match(errText(run), /No se pudo determinar el nombre del dominio/)
  })
})

describe('como proceso', () => {
  test('el modulo corre directo con Node y muestra la ayuda', () => {
    const repo = consumer()
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'scaffold-pipeline.mts'), '--help'], { cwd: repo.root })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, readFileSync(join(FIXTURES, 'help.txt'), 'utf8'))
  })

  test('la copia distribuida en dist/claude carga toda su clausura', () => {
    const repo = consumer()
    const result = capture(process.execPath, [join(REPO_ROOT, 'dist', 'claude', 'scripts', 'scaffold-pipeline.mts'), '--raro'], { cwd: repo.root })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(stripAnsi(result.stderr), '\nx Argumento desconocido: --raro. Usa --help para ver el uso.\n')
  })

  test('en el repo de Mefisto el proceso se niega', () => {
    const result = capture(process.execPath, [join(REPO_ROOT, 'scripts', 'scaffold-pipeline.mts'), '--domain', 'x'], { cwd: REPO_ROOT })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: scripts\/scaffold-pipeline\.mts es del plugin publicado y solo aplica al consumidor\.\n/)
  })
})

describe('camino feliz con el runner real, dominio tomado del issue', () => {
  let repo: Consumer
  let run: ScaffoldRun
  const BRANCH = 'scaffold-issue-42-prueba'

  before(async () => {
    repo = consumer()
    const tools = fakeTools({ issue: { number: 42, title: 'Crear dominio', body: 'Contexto.\n\nDominio: Prueba\n', state: 'OPEN' } })
    run = await runScaffold(repo, ['42'], { tools, guion: [SANO] })
  })

  test('termina bien e invoca una vez al domain-scaffolder en el worktree', () => {
    assert.equal(run.code, 0, run.out + run.err)
    const calls = guionCalls(repo)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.agent, 'domain-scaffolder')
    assert.equal(calls[0]?.cwd.endsWith(join('worktrees', BRANCH)), true)
    assert.equal(calls[0]?.prompt, scaffoldPrompt('prueba'))
    assert.match(calls[0]?.system ?? '', /^You are running in non-interactive print mode\./)
    assert.equal(calls[0]?.model, '')
    assert.equal(calls[0]?.effort, '')
  })

  test('extrae y normaliza el dominio, configura el label y lo asigna al issue', () => {
    assert.match(text(run), /\] Issue: #42 - Crear dominio\n.*\] Dominio extraido del issue: Prueba\n.*\] Dominio: prueba \(PascalCase: Prueba\)\n/s)
    assert.deepEqual(ghCalls(run, 'label', 'create')[0], ['label', 'create', 'dom:prueba', '--color', '0E8A16', '--description', 'Dominio Prueba', '--force', '--repo', repo.bare])
    assert.deepEqual(ghCalls(run, 'issue', 'edit')[0]?.slice(0, 5), ['issue', 'edit', '42', '--add-label', 'dom:prueba'])
    assert.match(text(run), /✓ Label dom:prueba listo\n.*\] Label asignado al issue #42\n/s)
  })

  test('publica la rama y abre el PR que cierra el issue', () => {
    assert.equal(remoteHas(repo, BRANCH), true)
    const create = ghCalls(run, 'pr', 'create')[0] ?? []
    assert.equal(flag(create, '--title'), '#42 scaffold(prueba): nuevo dominio Prueba')
    assert.equal(flag(create, '--head'), BRANCH)
    assert.equal(flag(create, '--base'), 'main')
    assert.match(flag(create, '--body'), /^## Resumen\n\nScaffold del dominio \*\*Prueba\*\* \(`prueba`\)/)
    assert.match(flag(create, '--body'), /\n## Commits\n\n[0-9a-f]+ scaffold\(prueba\): nuevo dominio Prueba\n\n\n\nCloses #42$/)
    assert.deepEqual(ghCalls(run, 'issue', 'comment')[0]?.slice(0, 5), ['issue', 'comment', '42', '--body', 'Scaffold del dominio `prueba` completado. PR: https://github.com/acme/consumidor/pull/7'])
  })

  test('deja el historial, los logs y events.log bajo .mefisto/pipeline y borra el worktree', () => {
    const [entry] = history(repo)
    assert.deepEqual(Object.keys(entry ?? {}), ['pipeline', 'runtime', 'domain', 'issue', 'started', 'finished', 'state', 'duration', 'pr', 'log'])
    assert.equal(entry?.pipeline, 'scaffold')
    assert.equal(entry?.runtime, 'guion')
    assert.equal(entry?.domain, 'prueba')
    assert.equal(entry?.issue, '42')
    assert.equal(entry?.state, 'completed')
    assert.equal(entry?.pr, 'https://github.com/acme/consumidor/pull/7')
    assert.equal(entry?.log, mainLog(repo.stateDir))
    assert.match(String(entry?.log), /scaffold-\d{8}-\d{6}-4242\.log$/)
    const logs = readdirSync(join(repo.stateDir, 'logs'))
    assert.ok(logs.some((name) => /^scaffold-agent-\d{8}-\d{6}-prueba-4242-attempt-1\.log$/.test(name)))
    assert.ok(logs.some((name) => /^scaffold-agent-\d{8}-\d{6}-prueba-4242-attempt-1\.events\.jsonl$/.test(name)))
    assert.equal(existsSync(join(repo.root, '.claude', 'pipeline')), false)
    assert.equal(existsSync(worktreeOf(repo, BRANCH)), false)
    assert.equal(git(repo.root, 'status', '--porcelain'), '')
  })

  test('events.log anota effort, modelo, invocacion y resultado en el orden del bash', () => {
    const events = eventsLog(repo)
    const order = ['EFFORTS: domain-scaffolder -> <heredado> (nivel light)', "MODELS: domain-scaffolder runtime=guion perfil=balanced solicitado=<automatico> resuelto='<heredado>'", "=== SCAFFOLD: domain-scaffolder para 'prueba' ===", 'OK domain-scaffolder (']
    const positions = order.map((needle) => events.indexOf(needle))
    assert.ok(positions.every((position) => position !== -1), events)
    assert.deepEqual([...positions].sort((a, b) => a - b), positions)
    assert.equal(events.split('MODELS: domain-scaffolder').length, 2, 'una sola evidencia del modelo')
  })

  test('el log del agente se deriva del JSONL neutral', () => {
    const name = readdirSync(join(repo.stateDir, 'logs')).find((entry) => entry.endsWith('-attempt-1.log')) ?? ''
    assert.equal(readFileSync(join(repo.stateDir, 'logs', name), 'utf8'), 'success\n')
  })

  test('el log principal usa etiquetas propias y la pantalla los glifos', () => {
    const lines = readFileSync(mainLog(repo.stateDir), 'utf8').split('\n')
    assert.ok(lines.includes('-- Descargando issue #42 --'))
    assert.ok(lines.includes('OK Label dom:prueba listo'))
    assert.ok(lines.includes('-- Invocando domain-scaffolder (modelo: <heredado>)... --'))
    assert.ok(lines.some((line) => /^\[\d{2}:\d{2}:\d{2}\] Haciendo push de la rama\.\.\.$/.test(line)))
    assert.ok(text(run).includes('\n-- Invocando domain-scaffolder (modelo: <heredado>)... --\n'))
    assert.ok(text(run).includes('✓ Integridad textual verificada\n'))
    assert.ok(text(run).includes('✓ Pines OpenTelemetry verificados\n'))
  })

  test('el resumen final nombra dominio, issue, PR, duracion y log', () => {
    const summary = run.out.slice(run.out.indexOf(`\n${COLOR.green}${COLOR.bold}====`))
    assert.ok(summary.startsWith(`\n${COLOR.green}${COLOR.bold}========================================${COLOR.reset}\n${COLOR.green}${COLOR.bold}  Scaffold completado exitosamente${COLOR.reset}\n`))
    assert.ok(summary.includes(`  Dominio:  ${COLOR.bold}Prueba${COLOR.reset} (prueba)\n  Issue:    ${COLOR.bold}#42${COLOR.reset}\n  PR:       ${COLOR.bold}https://github.com/acme/consumidor/pull/7${COLOR.reset}\n`))
    assert.ok(summary.includes(`  Log:      ${mainLog(repo.stateDir)}\n\n${COLOR.yellow}Proximos pasos:${COLOR.reset}\n`))
    assert.ok(summary.endsWith(`  3. Crear issues de implementacion y usar ${COLOR.bold}/implement${COLOR.reset}\n\n`))
  })
})

describe('rutas de estado y worktree', () => {
  test('MEFISTO_STATE_DIR recibe todo el estado y el repo ninguno', async () => {
    const repo = consumer()
    const override = join(work, `estado-${counter}`)
    const run = await runDouble(repo, ['--domain', 'prueba'], [SANO], { env: { MEFISTO_STATE_DIR: override } })
    assert.equal(run.code, 0, run.err)
    assert.notEqual(mainLog(override), '')
    assert.equal(existsSync(join(override, 'events.log')), true)
    assert.equal(history({ ...repo, stateDir: override }).length, 1)
    assert.equal(existsSync(join(repo.stateDir, 'pipeline-history.jsonl')), false)
    assert.equal(existsSync(join(repo.root, '.claude', 'pipeline')), false)
  })

  test('sin issue la rama es scaffold-<dominio>, el PR no cierra nada y no se comenta', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['--domain=PruebaX'], [{ files: { 'src/Empresa.Proyecto.PruebaX/a.cs': 'a\n', ...pinsFor('Empresa.Proyecto.PruebaX') }, commit: 'agente' }])
    assert.equal(run.code, 0, run.err)
    const create = ghCalls(run, 'pr', 'create')[0] ?? []
    assert.equal(flag(create, '--title'), 'scaffold(prueba-x): nuevo dominio PruebaX')
    assert.equal(flag(create, '--head'), 'scaffold-prueba-x')
    assert.equal(flag(create, '--body').includes('Closes'), false)
    assert.deepEqual(ghCalls(run, 'issue'), [])
    assert.equal(text(run).includes('  Issue:'), false)
  })

  test('el worktree nace en .mefisto/pipeline/worktrees desde origin/main y el checkout principal queda limpio', async () => {
    const repo = consumer()
    git(repo.root, 'checkout', '-q', '-b', 'otra-rama')
    const before = git(repo.root, 'status', '--porcelain')
    const run = await runDouble(repo, ['--domain', 'prueba'], [SANO])
    assert.equal(run.code, 0, run.err)
    assert.ok(text(run).includes(`] Creando worktree: ${worktreeOf(repo)} (base: origin/main)\n`))
    assert.ok(text(run).includes("⚠ cwd en rama 'otra-rama' (no main/master): el worktree se creara igual desde origin/main\n"))
    assert.equal(existsSync(join(repo.root, '..', 'scaffold-prueba')), false)
    assert.equal(existsSync(worktreeOf(repo)), false)
    assert.equal(git(repo.root, 'status', '--porcelain'), before)
  })

  test('un worktree y una rama de una corrida anterior se limpian antes de crear', async () => {
    const repo = consumer()
    git(repo.root, 'branch', 'scaffold-prueba')
    const run = await runDouble(repo, ['--domain', 'prueba'], [SANO])
    assert.equal(run.code, 0, run.err)
    assert.ok(text(run).includes('⚠ La rama scaffold-prueba ya existe sin worktree -- eliminandola...\n'))
  })
})

function pinsFor(project: string): Record<string, string> {
  return {
    [`src/${project}/${project}.csproj`]: '<Project><ItemGroup><PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" /></ItemGroup></Project>\n',
    [`tests/${project}.Tests/${project}.Tests.csproj`]: '<Project><ItemGroup><PackageReference Include="OpenTelemetry.Exporter.InMemory" Version="1.15.3" /></ItemGroup></Project>\n',
  }
}

describe('commit defensivo', () => {
  test('commitea lo que el agente dejo sin commitear, sin el estado runtime ni .claude/', async () => {
    const repo = consumer({ '.gitignore': '.mefisto/pipeline/\n.claude/pipeline/\n' })
    const run = await runDouble(repo, ['--domain', 'prueba'], [{ files: { ...scaffoldFiles(), '.claude/pipeline/.plugin-root': 'plugin-root' } }])
    assert.equal(run.code, 0, run.err)
    assert.ok(text(run).includes('⚠ El agente dejo cambios sin commitear; commiteando defensivamente.\n'))
    assert.equal(git(repo.bare, 'log', '-1', '--format=%s', 'scaffold-prueba'), 'scaffold(prueba): nuevo dominio Prueba')
    const files = git(repo.bare, 'show', '--name-only', '--format=', 'scaffold-prueba').split('\n')
    assert.ok(files.includes(`src/${PROJECT}/Program.cs`))
    assert.equal(files.some((file) => file.startsWith('.claude/') || file.startsWith('.mefisto/')), false)
  })

  test('si el agente ya commiteo y solo queda estado runtime, no hay commit defensivo', async () => {
    const repo = consumer({ '.gitignore': '.mefisto/pipeline/\n.claude/pipeline/\n' })
    const run = await runDouble(repo, ['--domain', 'prueba'], [{ ...SANO, files: { ...scaffoldFiles(), '.claude/pipeline/.plugin-root': 'x' } }])
    assert.equal(run.code, 0, run.err)
    assert.equal(text(run).includes('commiteando defensivamente'), false)
    assert.equal(git(repo.bare, 'rev-list', '--count', 'main..scaffold-prueba'), '1')
  })

  for (const [failing, message] of [
    ['add', "Fallo el 'git add -A' del commit defensivo del scaffold"],
    ['commit', 'Fallo el commit defensivo del scaffold'],
  ] as const) {
    test(`si falla git ${failing} aborta antes de publicar`, async () => {
      const repo = consumer()
      const tools = fakeTools()
      const real = runWith(tools)
      const attempted: string[] = []
      const run: Run = (command, args, options) => {
        if (command === 'git' && args[0] === '-C' && (args[2] === 'add' || args[2] === 'commit')) {
          attempted.push(args[2] ?? '')
          if (args[2] === failing) return { status: 128, stdout: '', stderr: `fatal: ${failing} roto\n` }
        }
        return real(command, args, options)
      }
      const result = await runDouble(repo, ['--domain', 'prueba'], [{ files: scaffoldFiles() }], { tools, deps: { run, runLogged: loggedThrough(run) } })
      assert.equal(result.code, 1)
      assert.equal(result.err, abortLine(message))
      assert.deepEqual(attempted, failing === 'add' ? ['add'] : ['add', 'commit'], 'sin add no se intenta el commit')
      assert.equal(remoteHas(repo, 'scaffold-prueba'), false)
      assert.match(readFileSync(mainLog(repo.stateDir), 'utf8'), new RegExp(`fatal: ${failing} roto`))
    })
  }

  test('sin el proyecto del dominio aborta nombrando el log del agente', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['--domain', 'prueba'], [{ files: { 'README.md': 'cambiado\n' } }])
    assert.equal(run.code, 1)
    assert.match(errText(run), /^\nx El scaffold no creo src\/Empresa\.Proyecto\.Prueba -- revisa: .*scaffold-agent-\d{8}-\d{6}-prueba-4242-attempt-1\.log\n$/)
  })

  test('sin ningun commit sobre origin/main no hay nada que publicar', async () => {
    const repo = consumer({ '.gitignore': '.mefisto/pipeline/\n*.log\n' })
    const run = await runDouble(repo, ['--domain', 'prueba'], [{ files: { [`src/${PROJECT}/build.log`]: 'ignorado\n' } }])
    assert.equal(run.code, 1)
    assert.match(errText(run), /^\nx El scaffold no genero ningun commit sobre origin\/main; nada que pushear\. Revisa: .*-attempt-1\.log\n$/)
    assert.deepEqual(ghCalls(run, 'pr'), [])
  })
})

describe('gate de integridad textual', () => {
  for (const [name, content] of [
    ['espacios al final de linea', 'namespace Empresa.Proyecto.Prueba; \n'],
    ['finales CRLF', 'namespace Empresa.Proyecto.Prueba;\r\n'],
  ] as const) {
    test(`${name}: aborta antes de publicar y deja el diagnostico en el log`, async () => {
      const repo = consumer()
      const run = await runDouble(repo, ['--domain', 'prueba'], [{ files: scaffoldFiles({ files: { [`src/${PROJECT}/Program.cs`]: content } }), commit: 'agente' }])
      assert.equal(run.code, 1)
      const logFile = mainLog(repo.stateDir)
      assert.equal(
        run.err,
        abortLine(`El scaffold contiene errores de whitespace detectados por 'git diff --check'. Corrige el output del generador sin normalizarlo automaticamente y revisa el diagnostico en: ${logFile}`),
      )
      assert.match(readFileSync(logFile, 'utf8'), /Program\.cs:1: trailing whitespace/)
      assert.equal(remoteHas(repo, 'scaffold-prueba'), false)
      assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    })
  }
})

describe('gate de pines OpenTelemetry', () => {
  const HOSTING = `src/${PROJECT}/${PROJECT}.csproj`
  const EXPORTER = `tests/${PROJECT}.Tests/${PROJECT}.Tests.csproj`
  const duplicated = (paquete: string): string =>
    `<Project><ItemGroup><PackageReference Include="${paquete}" Version="1.15.3" /><PackageReference Include="${paquete}" Version="1.15.3" /></ItemGroup></Project>\n`
  const CASES: { name: string; work: Parameters<typeof scaffoldFiles>[0]; paquete: string; csproj: string; detail: string }[] = [
    { name: 'pin 1.13.1 en el Function App', work: { hosting: '1.13.1', exporter: '1.13.1' }, paquete: 'OpenTelemetry.Extensions.Hosting', csproj: HOSTING, detail: 'se encontro 1.13.1 como atributo Version.' },
    { name: 'pin 1.13.1 solo en tests', work: { exporter: '1.13.1' }, paquete: 'OpenTelemetry.Exporter.InMemory', csproj: EXPORTER, detail: 'se encontro 1.13.1 como atributo Version.' },
    { name: 'referencia duplicada en produccion', work: { files: { [HOSTING]: duplicated('OpenTelemetry.Extensions.Hosting') } }, paquete: 'OpenTelemetry.Extensions.Hosting', csproj: HOSTING, detail: 'se encontraron 2.' },
    { name: 'referencia duplicada en tests', work: { files: { [EXPORTER]: duplicated('OpenTelemetry.Exporter.InMemory') } }, paquete: 'OpenTelemetry.Exporter.InMemory', csproj: EXPORTER, detail: 'se encontraron 2.' },
    { name: 'csproj del Function App ausente', work: { without: ['function'] }, paquete: 'OpenTelemetry.Extensions.Hosting', csproj: HOSTING, detail: 'pero el archivo no existe.' },
    { name: 'csproj de tests ausente', work: { without: ['tests'] }, paquete: 'OpenTelemetry.Exporter.InMemory', csproj: EXPORTER, detail: 'pero el archivo no existe.' },
  ]
  for (const { name, work: scaffold, paquete, csproj, detail } of CASES) {
    test(`${name}: aborta antes del push con paquete, pin y csproj`, async () => {
      const repo = consumer()
      const run = await runDouble(repo, ['--domain', 'prueba'], [{ files: scaffoldFiles(scaffold), commit: 'agente' }])
      assert.equal(run.code, 1)
      const path = join(worktreeOf(repo), ...csproj.split('/'))
      assert.equal(run.err, abortLine(`El pin de ${paquete} debe ser 1.15.3 en ${path}. Corrige el scaffold sin normalizarlo automaticamente.`))
      const diagnostic = text(run).split('\n').find((line) => line.startsWith('ERROR: paquete')) ?? ''
      assert.ok(diagnostic.startsWith(`ERROR: paquete ${paquete}: se esperaba`), diagnostic)
      assert.ok(diagnostic.includes(` 1.15.3 en ${path}`) && diagnostic.endsWith(detail), diagnostic)
      assert.ok(readFileSync(mainLog(repo.stateDir), 'utf8').includes(`${diagnostic}\nABORT El pin de ${paquete}`))
      assert.equal(remoteHas(repo, 'scaffold-prueba'), false)
      assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    })
  }
})

describe('PR y comentarios', () => {
  test('reutiliza un PR abierto de la rama sin crear otro', async () => {
    const tools = fakeTools({ openPr: 'https://github.com/acme/consumidor/pull/3', issue: { number: 42, title: 't', body: 'Dominio: prueba', state: 'OPEN' } })
    const run = await runDouble(consumer(), ['42'], [SANO], { tools })
    assert.equal(run.code, 0, run.err)
    assert.ok(text(run).includes('✓ PR existente reutilizado: https://github.com/acme/consumidor/pull/3\n'))
    assert.deepEqual(ghCalls(run, 'pr', 'create'), [])
    assert.equal(flag(ghCalls(run, 'issue', 'comment')[0] ?? [], '--body'), 'Scaffold del dominio `prueba` completado. PR: https://github.com/acme/consumidor/pull/3')
  })

  test('si no puede crear el PR aborta', async () => {
    const run = await runDouble(consumer(), ['--domain', 'prueba'], [SANO], { tools: fakeTools({ createdPr: null }) })
    assert.equal(run.code, 1)
    assert.equal(run.err, abortLine('No se pudo crear el PR'))
  })

  test('si no puede publicar la rama aborta', async () => {
    const repo = consumer()
    const tools = fakeTools()
    const real = runWith(tools)
    const run: Run = (command, args, options) =>
      command === 'git' && args.includes('push') ? { status: 1, stdout: '', stderr: 'rejected\n' } : real(command, args, options)
    const result = await runDouble(repo, ['--domain', 'prueba'], [SANO], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 1)
    assert.equal(result.err, abortLine('No se pudo hacer push de la rama scaffold-prueba'))
  })

  test('los fallos del label, del comentario y del borrado del worktree solo avisan', async () => {
    const tools = fakeTools({ failing: ['label create', 'issue edit', 'issue comment'], issue: { number: 42, title: 't', body: 'Dominio: prueba', state: 'OPEN' } })
    const real = runWith(tools)
    const run: Run = (command, args, options) =>
      command === 'git' && args[0] === 'worktree' && args[1] === 'remove' ? { status: 1, stdout: '', stderr: 'locked\n' } : real(command, args, options)
    const repo = consumer()
    const result = await runDouble(repo, ['42'], [SANO], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 0, result.err)
    const screen = text(result)
    assert.ok(screen.includes('⚠ No se pudo crear el label dom:prueba (puede que ya exista)\n✓ Label dom:prueba listo\n'))
    assert.ok(screen.includes('⚠ No se pudo asignar el label al issue #42\n'))
    assert.ok(screen.includes('] Label asignado al issue #42\n'))
    assert.ok(screen.includes('⚠ No se pudo comentar en el issue #42\n'))
    assert.ok(screen.includes(`⚠ No se pudo eliminar el worktree automaticamente. Eliminalo manualmente: git worktree remove --force ${worktreeOf(repo, 'scaffold-issue-42-prueba')}\n✓ Worktree eliminado\n`))
  })
})

describe('invocacion del agente: frontera neutral y politica de espera', () => {
  const HOLD_ENV = { MEFISTO_HOLD_PROBE_SECONDS: '1' }

  test('el argv lleva agente, cwd, events.log, redaccion y timeout de 1800 s, sin modelo ni effort heredados', async () => {
    const repo = consumer()
    const run = runDouble(repo, ['--domain', 'prueba'], [SANO])
    assert.equal((await run).code, 0)
    const args = run.double.calls[0] ?? []
    assert.deepEqual(args.slice(0, 6), ['--runtime', 'guion', '--agent', 'domain-scaffolder', '--cwd', worktreeOf(repo)])
    assert.equal(flag(args, '--events-log'), join(repo.stateDir, 'events.log'))
    assert.ok(args.includes('--redact-observability'))
    assert.equal(flag(args, '--timeout'), '1800')
    assert.equal(args.includes('--model') || args.includes('--effort') || args.includes('--resume-session'), false)
  })

  test('un terminal ausente con salida 0 falla con el log del intento', async () => {
    const run = await runDouble(consumer(), ['--domain', 'prueba'], [{ silent: true, exit: 0 }])
    assert.equal(run.code, 1)
    assert.match(errText(run), /^\nx El scaffold del dominio 'prueba' fallo despues de \d+s \(\S+\)\. Revisa: .*-attempt-1\.log\n$/)
  })

  test('stream_cut falla sin esperar', async () => {
    const repo = consumer()
    const run = runDouble(repo, ['--domain', 'prueba'], [{ status: 'failed', kind: 'stream_cut' }])
    assert.equal((await run).code, 1)
    assert.equal(run.double.calls.length, 1)
    assert.equal(eventsLog(repo).includes('[hold]'), false)
    assert.match(eventsLog(repo), /\] FALLO domain-scaffolder: STREAM_CUT\n/)
  })

  test('rate_limit espera, reanuda la sesion con el prompt de la tarea y termina bien', async () => {
    const repo = consumer()
    const run = runDouble(repo, ['--domain', 'prueba'], [{ status: 'failed', kind: 'rate_limit', session: 'sess-1' }, SANO], { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    const result = await run
    assert.equal(result.code, 0, result.err)
    assert.equal(flag(run.double.calls[1] ?? [], '--resume-session'), 'sess-1')
    assert.equal(run.double.prompts[1], 'Continue the same task and complete it.\n')
    assert.match(text(result), /⚠ domain-scaffolder: RATE_LIMIT\S* -- en espera \(hold\), reintentando\.\.\.\n/)
    assert.match(eventsLog(repo), /\] FALLO domain-scaffolder: RATE_LIMIT/)
    assert.match(eventsLog(repo), /\]\[hold\] RATE_LIMIT: esperando, proxima sonda /)
    assert.equal(eventsLog(repo).split('MODELS: domain-scaffolder').length, 2, 'la sonda no repite la evidencia del modelo')
  })

  test('si la sesion reanudada vuelve a caer sin crear el proyecto, se degrada a inicio limpio', async () => {
    const repo = consumer()
    const steps: GuionStep[] = [
      { status: 'failed', kind: 'rate_limit', session: 'sess-1' },
      { status: 'failed', kind: 'rate_limit', session: 'sess-1' },
      SANO,
    ]
    const run = runDouble(repo, ['--domain', 'prueba'], steps, { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    const result = await run
    assert.equal(result.code, 0, result.err)
    assert.ok(text(result).includes('⚠ domain-scaffolder: la sesion reanudada termino sin crear el proyecto; se degrada permanentemente a inicio limpio\n'))
    assert.equal((run.double.calls[2] ?? []).includes('--resume-session'), false)
    assert.equal(run.double.prompts[2], scaffoldPrompt('prueba'))
  })

  test('sin session_id o sin soporte de reanudacion la sonda arranca de cero', async () => {
    const noSession = await runDouble(consumer(), ['--domain', 'prueba'], [{ status: 'failed', kind: 'rate_limit' }, SANO], { env: { ...HOLD_ENV, GUION_RESUME: '1' } })
    assert.ok(text(noSession).includes('⚠ domain-scaffolder: terminal sin session_id; la sonda inicia de cero\n'))
    const unsupported = await runDouble(consumer(), ['--domain', 'prueba'], [{ status: 'failed', kind: 'rate_limit', session: 's' }, SANO], { env: HOLD_ENV })
    assert.ok(text(unsupported).includes('⚠ domain-scaffolder: runtime sin capacidad de reanudacion; la sonda inicia de cero\n'))
  })

  test('con el techo agotado aborta con la ultima senal', async () => {
    const run = await runDouble(consumer(), ['--domain', 'prueba'], [{ status: 'failed', kind: 'rate_limit' }], { env: { MEFISTO_HOLD_MAX_SECONDS: '0' } })
    assert.equal(run.code, 1)
    assert.match(text(run), /⚠ domain-scaffolder: techo de espera \(hold\) agotado -- ultima senal: RATE_LIMIT/)
    assert.match(errText(run), /fallo despues de \d+s \(RATE_LIMIT/)
  })

  test('el modelo del adaptador viaja en --model y se anuncia en el encabezado', async () => {
    const repo = consumer()
    const run = runDouble(repo, ['--domain', 'prueba'], [SANO], { env: { GUION_DEFAULT_MODEL: 'modelo-x' } })
    const result = await run
    assert.equal(flag(run.double.calls[0] ?? [], '--model'), 'modelo-x')
    assert.ok(text(result).includes('\n-- Invocando domain-scaffolder (modelo: modelo-x)... --\n'))
    assert.match(eventsLog(repo), /MODELS: domain-scaffolder runtime=guion perfil=balanced solicitado=<automatico> resuelto='modelo-x'\n/)
  })

  test('un adaptador que no acepta el perfil aborta antes de invocar al agente', async () => {
    const lib = mkdtempSync(join(work, 'adaptador-'))
    const guion = pathToFileURL(join(GUION_LIB, 'runtime-guion.mts')).href
    writeFileSync(join(lib, 'runtime-sinmodelo.mts'), `export * from '${guion}'\nexport function defaultModel() { return null }\n`)
    const run = runDouble(consumer(), ['--domain', 'prueba'], [SANO], { env: { MEFISTO_RUNTIME: 'sinmodelo', MEFISTO_RUNTIME_LIB_DIR: lib } })
    const result = await run
    assert.equal(result.code, 1)
    assert.equal(result.err, abortLine("No se pudo resolver el modelo de domain-scaffolder (perfil balanced): runtime_sinmodelo_default_model: no acepta el perfil 'balanced'"))
    assert.equal(run.double.calls.length, 0)
  })

  describe('effort del domain-scaffolder', () => {
    const effortOf = async (mapping: object | null): Promise<string[]> => {
      const repo = consumer(mapping === null ? {} : { '.mefisto/models.json': JSON.stringify(mapping) })
      const run = runDouble(repo, ['--domain', 'prueba'], [SANO])
      assert.equal((await run).code, 0)
      return run.double.calls[0] ?? []
    }
    test('sin mapping no se pasa --effort', async () => {
      assert.equal((await effortOf(null)).includes('--effort'), false)
    })
    test('efforts.agents eleva el nivel del agente', async () => {
      const args = await effortOf({ guion: { efforts: { levels: { light: 'n-light', standard: 'n-standard' }, agents: { 'domain-scaffolder': 'standard' } } } })
      assert.equal(flag(args, '--effort'), 'n-standard')
    })
    test('sin override recibe el nativo de su nivel de fabrica (light)', async () => {
      const args = await effortOf({ guion: { efforts: { levels: { light: 'n-light', standard: 'n-standard' } } } })
      assert.equal(flag(args, '--effort'), 'n-light')
    })
    test('un mapping invalido aborta tras traer origin/main y antes de crear el worktree', async () => {
      const repo = consumer({ '.mefisto/models.json': '{"guion": {"efforts": {"levels": {"enorme": "x"}}}}' })
      const run = await runDouble(repo, ['--domain', 'prueba'], [SANO])
      assert.equal(run.code, 1)
      assert.match(errText(run), /^\nx No se pudo resolver el effort de domain-scaffolder: MEFISTO_EFFORTS_ERROR=.*models\.json: .*enorme.*\n$/)
      assert.ok(text(run).includes('] Actualizando origin/main...\n'))
      assert.equal(text(run).includes('Creando worktree'), false)
      assert.equal(existsSync(worktreeOf(repo)), false)
    })
  })
})

describe('cierre en cada camino de salida', () => {
  test('el directorio temporal se borra al terminar bien y al abortar', async () => {
    for (const steps of [[SANO], [{ status: 'failed' as const, kind: 'api_error' }]]) {
      const tempRoot = mkdtempSync(join(work, 'temporales-'))
      await runDouble(consumer(), ['--domain', 'prueba'], steps, { deps: { tempRoot } })
      assert.deepEqual(readdirSync(tempRoot), [])
    }
  })

  test('un aborto no avisa del worktree, pero lo conserva', async () => {
    const repo = consumer()
    const run = await runDouble(repo, ['--domain', 'prueba'], [{ status: 'failed', kind: 'api_error' }])
    assert.equal(run.code, 1)
    assert.equal(text(run).includes('Error detectado'), false)
    assert.equal(existsSync(worktreeOf(repo)), true)
  })

  test('un error no previsto con el worktree creado lo deja disponible para inspeccion', async () => {
    const repo = consumer()
    const tools = fakeTools()
    const real = runWith(tools)
    const run: Run = (command, args, options) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') throw new TypeError('defecto-no-previsto')
      return real(command, args, options)
    }
    const result = await runDouble(repo, ['--domain', 'prueba'], [SANO], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 1)
    assert.match(result.err, /TypeError: defecto-no-previsto/)
    assert.ok(text(result).endsWith(`⚠ Error detectado. El worktree queda disponible para inspeccion: ${worktreeOf(repo)}\n`))
    assert.ok(readFileSync(mainLog(repo.stateDir), 'utf8').endsWith(`WARN Error detectado. El worktree queda disponible para inspeccion: ${worktreeOf(repo)}\n`))
  })

  test('un git que falla sin mensaje termina con su codigo', async () => {
    const tools = fakeTools()
    const real = runWith(tools)
    const run: Run = (command, args, options) =>
      command === 'git' && args.includes('get-url') ? { status: 2, stdout: '', stderr: "error: No such remote 'origin'\n" } : real(command, args, options)
    const result = await runScaffold(consumer(), ['--domain', 'prueba'], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 2)
    assert.equal(result.err, "error: No such remote 'origin'\n")
  })

  test('SIGTERM durante una espera mata al runner y termina con 143 sin avisar de error', async () => {
    const repo = consumer()
    const signals = new EventEmitter()
    const exits: number[] = []
    const tempRoot = mkdtempSync(join(work, 'temporales-senal-'))
    const result = await runDouble(repo, ['--domain', 'prueba'], [{ status: 'failed', kind: 'rate_limit' }], {
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
    assert.equal(text(result).includes('Error detectado'), false)
    assert.deepEqual(readdirSync(tempRoot), [])
    assert.deepEqual(history(repo), [])
  })
})

describe('el estado vive donde lo deja el pipeline, no en el repo', () => {
  test('una corrida fallida no escribe historial (el scaffold solo registra exitos)', async () => {
    const repo = consumer()
    mkdirSync(repo.stateDir, { recursive: true })
    const run = await runDouble(repo, ['--domain', 'prueba'], [{ status: 'failed', kind: 'api_error' }])
    assert.equal(run.code, 1)
    assert.deepEqual(history(repo), [])
    assert.equal(readdirSync(repo.stateDir).some((name) => name.startsWith('pipeline-status')), false)
  })
})
