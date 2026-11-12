// Estado final y limpieza de `tooling-pipeline.mts` en cada camino de salida: aborto, error no
// previsto, comando que falla sin mensaje, senal y exito. Incluye el texto exacto del status.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../lib/azure-cli.mts'
import { loggedThrough, stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { isolateGitConfig, writeFiles } from './field-note-sandbox.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { fakeTools, history, newConsumer, readJson, runTooling, runWith, runnerDouble } from './tooling-pipeline-sandbox.mts'
import type { Consumer, FakeTools, PipelineRun } from './tooling-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto tooling exit ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

interface Case {
  repo: Consumer
  tempRoot: string
  statusFile: string
}

function newCase(): Case {
  counter++
  const repo = newConsumer(join(work, `caso-${counter}`))
  return { repo, tempRoot: mkdtempSync(join(work, `temporales-${counter}-`)), statusFile: join(repo.stateDir, 'pipeline-status-tooling-42.json') }
}

const WRITER: GuionStep = { files: { 'scripts/ci.sh': 'echo ci\n' }, commit: 'agregar script de ci' }
const REVIEWER: GuionStep = { files: { 'docs/ci.md': 'Notas de CI\n' } }
const BRANCH = 'worktree-issue-42-agregar-workflow-de-ci'

/** `run` que hace fallar la primera llamada a `git` que cumpla `matches`. */
function failingGit(tools: FakeTools, matches: (args: string[]) => boolean, failure: () => ReturnType<Run>): Run {
  const real = runWith(tools)
  let failed = false
  return (command, args, options) => {
    if (!failed && command === 'git' && matches(args)) {
      failed = true
      return failure()
    }
    return real(command, args, options)
  }
}

async function runCase(c: Case, steps: GuionStep[], deps: Parameters<typeof runTooling>[2] = {}): Promise<PipelineRun> {
  return runTooling(c.repo, ['42'], { ...deps, deps: { launchRunner: runnerDouble(steps).launch, tempRoot: c.tempRoot, ...deps.deps } })
}

const snapshotCall = (args: string[]): boolean => args[0] === '-C' && args[2] === 'rev-parse' && args[3] === 'HEAD'

describe('cierre no controlado', () => {
  test('un comando que falla sin mensaje conserva su codigo y su diagnostico, marca el status y deja una entrada en el historial', async () => {
    const c = newCase()
    const tools = fakeTools()
    const run = failingGit(tools, snapshotCall, () => ({ status: 23, stdout: '', stderr: 'unhandled-diagnostic\n' }))
    const result = await runCase(c, [], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 23)
    assert.match(result.err, /unhandled-diagnostic/)
    const status = readJson(c.statusFile)
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, 'setup')
    assert.equal(status.last_error, 'Terminacion no controlada (exit code: 23)')
    const entries = history(c.repo)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.state, 'failed')
    assert.equal(entries[0]?.error, 'Terminacion no controlada (exit code: 23)')
    assert.deepEqual(readdirSync(c.tempRoot), [], 'los temporales se borran')
  })

  test('un error no previsto del propio pipeline se imprime, sale con 1 y cierra igual', async () => {
    const c = newCase()
    const tools = fakeTools()
    const run = failingGit(tools, snapshotCall, () => {
      throw new TypeError('defecto-no-previsto')
    })
    const result = await runCase(c, [], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 1)
    assert.match(result.err, /TypeError: defecto-no-previsto/)
    assert.equal(readJson(c.statusFile).state, 'failed')
    assert.equal(readJson(c.statusFile).last_error, 'Terminacion no controlada (exit code: 1)')
    assert.equal(history(c.repo).length, 1)
    assert.deepEqual(readdirSync(c.tempRoot), [])
  })

  test('un cierre no controlado durante una espera reconcilia el status hold y conserva el stage', async () => {
    const c = newCase()
    const result = await runCase(c, [{ status: 'failed', kind: 'rate_limit' }], {
      deps: {
        sleep: () => {
          assert.equal(readJson(c.statusFile).state, 'hold')
          throw new Error('corte durante la espera')
        },
      },
    })
    assert.equal(result.code, 1)
    const status = readJson(c.statusFile)
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, '1-writer')
    assert.equal(history(c.repo).length, 1)
    assert.equal(history(c.repo)[0]?.stage, '1-writer')
  })

  test('un fallo previo al primer status no deja evidencia incompleta y limpia los temporales', async () => {
    const c = newCase()
    // Una respuesta de gh sin el campo title con la forma que el pipeline reconoce.
    const tools = fakeTools()
    const real = runWith(tools)
    const run: Run = (command, args, options) =>
      command === 'gh' && args[1] === 'view' ? { status: 0, stdout: '{"body": "b", "state": "OPEN", "title": "con espacios"}\n', stderr: '' } : real(command, args, options)
    const result = await runCase(c, [], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(result.code, 1)
    assert.equal(existsSync(c.statusFile), false)
    assert.deepEqual(history(c.repo), [])
    assert.deepEqual(readdirSync(c.tempRoot), [])
  })
})

describe('aborto', () => {
  test('conserva su error, sale con 1, deja una sola entrada en el historial y declara el log', async () => {
    const c = newCase()
    const result = await runCase(c, [{ status: 'failed', kind: 'api_error' }])
    assert.equal(result.code, 1)
    const status = readJson(c.statusFile)
    assert.equal(status.state, 'failed')
    assert.match(String(status.last_error), /^writer fallo \(API_ERROR_CLIENT\)/)
    const entries = history(c.repo)
    assert.equal(entries.length, 1)
    assert.match(String(entries[0]?.error), /^writer fallo \(API_ERROR_CLIENT\)/)
    assert.equal(entries[0]?.log, status.log)
    assert.equal(existsSync(String(status.log)), true)
    assert.deepEqual(readdirSync(c.tempRoot), [])
  })

  test('el error con comillas queda legible en el status y, como en el bash, escapado de mas en el historial', async () => {
    const c = newCase()
    const tools = fakeTools({ issue: { number: 42, title: 'Agregar CI', body: '', state: 'CLOSED "por duplicado"' } })
    const result = await runCase(c, [], { tools })
    assert.equal(result.code, 1)
    assert.equal(readJson(c.statusFile).last_error, 'El issue #42 esta CLOSED "por duplicado" -- solo se procesan issues abiertos. ')
    assert.equal(history(c.repo)[0]?.error, 'El issue #42 esta CLOSED \\"por duplicado\\" -- solo se procesan issues abiertos. ')
  })

  test('un mensaje de varias lineas se guarda en una sola', async () => {
    const c = newCase()
    const steps: GuionStep[] = [{ files: { 'README.md': 'writer\n', 'docs/a.md': 'writer\n' }, commit: 'cambios' }, {}, {}]
    const tools = fakeTools()
    const real = runWith(tools)
    let advanced = false
    const runLogged = loggedThrough((command, args, options) => {
      if (!advanced && args[0] === '-C' && args[2] === 'fetch') {
        advanced = true
        const side = join(work, `lateral-${counter}`)
        const git = (...gitArgs: string[]): void => void real('git', gitArgs, {})
        git('clone', '-q', '-b', 'main', c.repo.bare, side)
        git('-C', side, 'config', 'user.email', 'otro@mefisto.local')
        git('-C', side, 'config', 'user.name', 'Otro')
        writeFiles(side, { 'README.md': 'main\n', 'docs/a.md': 'main\n' })
        git('-C', side, 'add', '.')
        git('-C', side, 'commit', '-q', '-m', 'avance de main')
        git('-C', side, 'push', '-q', 'origin', 'HEAD:main')
      }
      return real(command, args, options)
    })
    const result = await runCase(c, steps, { tools, deps: { runLogged } })
    assert.equal(result.code, 1)
    assert.match(stripAnsi(result.out), /x ERROR: Aun quedan conflictos: README\.md\ndocs\/a\.md\. Revisa manualmente: cd /)
    assert.match(String(readJson(c.statusFile).last_error), /^Aun quedan conflictos: README\.md docs\/a\.md\. Revisa manualmente: cd .* $/)
  })
})

describe('senales', () => {
  test('SIGTERM durante una espera deja el status en failed, registra el fallo y termina con 143', async () => {
    const c = newCase()
    const signals = new EventEmitter()
    const exits: number[] = []
    const result = await runCase(c, [{ status: 'failed', kind: 'rate_limit' }], {
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
    assert.equal(result.code, 1, 'en el test el proceso no muere: el codigo real lo fija exit(143)')
    const status = readJson(c.statusFile)
    assert.equal(status.state, 'failed')
    assert.equal(status.stage, '1-writer')
    assert.equal(status.last_error, 'Terminacion no controlada (exit code: 143)')
    assert.equal(history(c.repo).length, 1, 'el cierre no se repite al volver main')
    assert.deepEqual(readdirSync(c.tempRoot), [])
    assert.equal(existsSync(join(c.repo.stateDir, 'worktrees', BRANCH)), true, 'el worktree queda para inspeccion')
  })

  test('SIGINT antes de que exista un status solo limpia los temporales', async () => {
    const c = newCase()
    const signals = new EventEmitter()
    const exits: number[] = []
    const tools = fakeTools()
    const real = runWith(tools)
    const run: Run = (command, args, options) => {
      if (command === 'gh' && args[1] === 'view') signals.emit('SIGINT', 'SIGINT')
      return real(command, args, options)
    }
    await runCase(c, [], {
      tools,
      deps: {
        run,
        runLogged: loggedThrough(run),
        signals,
        exit: (code) => {
          exits.push(code)
          throw new Error('proceso terminado')
        },
      },
    })
    assert.deepEqual(exits, [130])
    assert.equal(existsSync(c.statusFile), false)
    assert.deepEqual(history(c.repo), [])
    assert.deepEqual(readdirSync(c.tempRoot), [])
  })
})

describe('salida exitosa', () => {
  test('no deja status ni entradas de fallo y limpia los temporales', async () => {
    const c = newCase()
    const result = await runCase(c, [WRITER, REVIEWER])
    assert.equal(result.code, 0, stripAnsi(result.out))
    assert.equal(existsSync(c.statusFile), false)
    assert.deepEqual(
      history(c.repo).map((entry) => entry.state),
      ['completed'],
    )
    assert.deepEqual(readdirSync(c.tempRoot), [])
  })
})

describe('texto del status', () => {
  test('conserva claves, orden y forma del status que leen los mods', async () => {
    const c = newCase()
    const result = await runCase(c, [WRITER, { status: 'failed', kind: 'api_error' }], { env: { GUION_DEFAULT_MODEL: 'modelo "x"' } })
    assert.equal(result.code, 1)
    const text = readFileSync(c.statusFile, 'utf8')
    const status = readJson(c.statusFile)
    const agents = status.agents as Record<string, Record<string, unknown>>
    const json = (value: unknown): string => JSON.stringify(value)
    const expected = [
      '{',
      '  "issue": "42",',
      '  "title": "Agregar workflow de CI",',
      '  "pipeline": "tooling",',
      '  "variant": null,',
      '  "identity": {"harness_version":null,"harness_commit":null,"identity_state":"metadata_invalid"},',
      '  "runtime": "guion",',
      `  "started": ${json(status.started)},`,
      '  "stage": "2-reviewer",',
      '  "state": "failed",',
      `  "updated": ${json(status.updated)},`,
      `  "worktree": ${json(join(c.repo.stateDir, 'worktrees', BRANCH))},`,
      `  "log": ${json(join(c.repo.stateDir, 'logs', `tooling-pipeline-${String(status.started)}.log`))},`,
      '  "agents": {',
      `    "writer":   {"agent": "tooling-writer", "profile": "balanced", "requested_model": "modelo \\"x\\"", "inherited": false, "duration": ${String(agents.writer?.duration)}, "result": "passed", "metrics": ${json(agents.writer?.metrics)}},`,
      `    "reviewer": {"agent": "tooling-reviewer", "profile": "deep", "requested_model": "modelo \\"x\\"", "inherited": false, "duration": null, "result": "failed", "metrics": ${json(agents.reviewer?.metrics)}}`,
      '  },',
      '  "tests": null,',
      '  "pr": null,',
      `  "last_error": ${json(status.last_error)}`,
      '  ,"hold": {"cause": null, "next_probe": null, "ceiling_seconds": null, "accumulated_seconds": 0}',
      '}',
      '',
    ].join('\n')
    assert.equal(text, expected)
    assert.match(String(status.started), /^\d{8}-\d{6}$/)
    assert.match(String(status.updated), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/)
  })

  test('el primer status de la corrida es setup/running, con los agentes pendientes', async () => {
    const c = newCase()
    const tools = fakeTools()
    let first: Record<string, unknown> = {}
    const real = runWith(tools)
    const run: Run = (command, args, options) => {
      if (command === 'git' && snapshotCall(args) && Object.keys(first).length === 0) first = readJson(c.statusFile)
      return real(command, args, options)
    }
    await runCase(c, [WRITER, REVIEWER], { tools, deps: { run, runLogged: loggedThrough(run) } })
    assert.equal(first.stage, 'setup')
    assert.equal(first.state, 'running')
    assert.equal(first.last_error, null)
    assert.equal(first.worktree, join(c.repo.stateDir, 'worktrees', BRANCH))
    assert.deepEqual(first.agents, {
      writer: { agent: 'tooling-writer', profile: 'balanced', requested_model: null, inherited: true, duration: null, result: 'pending', metrics: null },
      reviewer: { agent: 'tooling-reviewer', profile: 'deep', requested_model: null, inherited: true, duration: null, result: 'pending', metrics: null },
    })
  })
})
