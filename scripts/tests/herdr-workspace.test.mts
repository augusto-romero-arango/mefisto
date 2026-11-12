import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { agentNameForRole, cksum, herdrWorkspace, plannerAgentForRepo, runtimesForRepo, workspaceSlug } from '../herdr-workspace.mts'
import { git, isolateGitConfig } from './field-note-sandbox.mts'
import { FakeClock, FakeHerdr, fail, ok, processInfoJson } from './herdr-sandbox.mts'

const REPO = join(import.meta.dirname, '..', '..')

describe('funciones puras', () => {
  test('workspaceSlug conserva su contrato', () => {
    assert.equal(workspaceSlug('Bitakora.ControlAsistencia'), 'bitakora-controlasis')
  })

  test('cksum coincide con el de POSIX', () => {
    assert.equal(cksum('eda-evsourcing-azure-harness'), 230639820)
    assert.equal(cksum('Cosmos.ControlPlane'), 4184187678)
    assert.equal(cksum(''), 4294967295)
  })

  test('agentNameForRole recorta con hash y respeta el tope de 32 caracteres', () => {
    const name = agentNameForRole('ejecucion', 'eda-evsourcing-azure-harness', 'claude')
    assert.equal(name, 'ejecucion-eda-evsour-48cc-claude')
    assert.ok(name.length <= 32)
  })

  test('anti-colision: el slug recortado lleva el hash del label (issue #2502)', () => {
    assert.equal(agentNameForRole('ejecucion', 'Cosmos.ControlPlane', 'claude'), 'ejecucion-cosmos-con-a31e-claude')
    assert.equal(agentNameForRole('ejecucion', 'Cosmos.ControlPlane', 'fake'), 'ejecucion-cosmos-contr-a31e-fake')
    assert.equal(agentNameForRole('ejecucion', 'Cosmos.ControlPlane.Front', 'claude'), 'ejecucion-cosmos-con-365f-claude')
    assert.equal(agentNameForRole('ejecucion', 'Cosmos.ControlPlane.Front', 'fake'), 'ejecucion-cosmos-contr-365f-fake')
    for (const rol of ['planner', 'ejecucion']) {
      for (const kind of ['claude', 'fake']) {
        const a = agentNameForRole(rol, 'Cosmos.ControlPlane', kind)
        const b = agentNameForRole(rol, 'Cosmos.ControlPlane.Front', kind)
        assert.notEqual(a, b)
        assert.equal(a, agentNameForRole(rol, 'Cosmos.ControlPlane', kind))
        assert.match(a, /^[a-z][a-z0-9_-]{0,31}$/)
        assert.match(b, /^[a-z][a-z0-9_-]{0,31}$/)
      }
    }
  })

  test('un label corto y el formato legacy sin kind conservan su nombre', () => {
    assert.equal(agentNameForRole('ejecucion', 'Bitakora', 'claude'), 'ejecucion-bitakora-claude')
    assert.equal(agentNameForRole('ejecucion', 'Bitakora', 'fake'), 'ejecucion-bitakora-fake')
    assert.equal(agentNameForRole('planner', 'Cosmos.ControlPlane.Front', ''), 'planner-cosmos-controlplane')
    assert.equal(agentNameForRole('planner', 'Bitakora', ''), 'planner-bitakora')
  })

  test('un kind absurdamente largo no rompe el calculo', () => {
    assert.match(agentNameForRole('planner', 'Bitakora', 'x'.repeat(40)), /^planner-b-/)
  })

  test('runtimesForRepo: default, una variable, lista normalizada y consumidor', () => {
    assert.deepEqual(runtimesForRepo('mefisto-planner', {}), ['claude'])
    assert.deepEqual(runtimesForRepo('mefisto-planner', { MEFISTO_RUNTIME: 'codex' }), ['codex'])
    assert.deepEqual(runtimesForRepo('mefisto-planner', { MEFISTO_RUNTIMES: ' fake, claude ,fake,, codex, claude ' }), [
      'fake',
      'claude',
      'codex',
    ])
    assert.deepEqual(runtimesForRepo('mefisto:planner', { MEFISTO_RUNTIMES: 'fake', MEFISTO_RUNTIME: 'fake' }), ['claude'])
    assert.deepEqual(runtimesForRepo('mefisto-planner', { MEFISTO_RUNTIMES: '', MEFISTO_RUNTIME: 'fake' }), [])
  })
})

let work: string
let mefisto: string
let consumer: string
let legacyConsumer: string
let unconfigured: string
let worktree: string
let restoreGit: () => void

function newRepo(path: string, files: Record<string, string>): string {
  mkdirSync(path, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, '..'), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  git(path, 'init', '-q')
  git(path, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'inicial')
  return realpathSync.native(path)
}

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'herdr-workspace-')))
  restoreGit = isolateGitConfig(work)
  mefisto = newRepo(join(work, 'fake-mefisto-repo'), { '.claude-plugin/plugin.json': '{}\n' })
  consumer = newRepo(join(work, 'fake consumer repo'), { '.mefisto/harness.config.json': '{}\n' })
  legacyConsumer = newRepo(join(work, 'fake legacy consumer repo'), { '.claude/harness.config.json': '{}\n' })
  unconfigured = newRepo(join(work, 'fake unconfigured consumer repo'), {})
  git(consumer, 'worktree', 'add', '-q', '-b', 'fixture-worktree', join(work, 'fake consumer worktree'))
  worktree = realpathSync.native(join(work, 'fake consumer worktree'))
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

interface StubOptions {
  existingLabel?: string
  secondWorkspace?: boolean
  panes?: string
  panesW2?: string
  failSplit?: boolean
  failKind?: string
  expectCwd?: string
}

interface Outcome {
  code: number
  out: string
  err: string
  log: string
  calls: string[]
}

function optionValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function paneListJson(spec: string): string {
  const panes = spec
    .split(';')
    .filter((item) => item !== '')
    .map((item) => {
      const at = item.indexOf('=')
      return { pane_id: item.slice(at + 1), label: item.slice(0, at) }
    })
  return `${JSON.stringify({ result: { panes } })}\n`
}

async function runWorkspace(
  repo: string,
  options: StubOptions = {},
  splitStart = 2,
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = 'linux',
): Promise<Outcome> {
  let counter = splitStart
  const fake = new FakeHerdr({
    respond: (args) => {
      const key = `${args[0]} ${args[1]}`
      if (options.expectCwd !== undefined && (key === 'workspace create' || key === 'pane split')) {
        const cwd = optionValue(args, '--cwd')
        if (cwd !== options.expectCwd) return fail(64, `cwd recibido como argv distinto: <${cwd}>\n`)
      }
      if (key === 'status server') return ok('')
      if (key === 'workspace list') {
        if (options.existingLabel === undefined) return ok('{"result":{"workspaces":[]}}\n')
        const list = [{ workspace_id: 'w1', label: options.existingLabel }]
        if (options.secondWorkspace === true) list.push({ workspace_id: 'w2', label: options.existingLabel })
        return ok(`${JSON.stringify({ result: { workspaces: list } })}\n`)
      }
      if (key === 'workspace create') return ok('{"result":{"workspace":{"workspace_id":"w1"},"root_pane":{"pane_id":"w1:p1"}}}\n')
      if (key === 'pane split') {
        if (options.failSplit === true) return fail(73, '{"error":"split rechazado"}\n')
        return ok(`{"result":{"pane":{"pane_id":"w1:p${counter++}"}}}\n`)
      }
      if (key === 'pane list') {
        return ok(paneListJson(optionValue(args, '--workspace') === 'w2' ? (options.panesW2 ?? '') : (options.panes ?? '')))
      }
      if (key === 'pane process-info') return ok(processInfoJson(100, 100))
      if (key === 'agent start') {
        const kind = optionValue(args, '--kind')
        if (options.failKind !== undefined && kind === options.failKind) return fail(72, `{"error":"runtime ${kind} ausente"}\n`)
        return ok()
      }
      if (key === 'agent get') return fail()
      return ok()
    },
  })
  let out = ''
  let err = ''
  const clock = new FakeClock()
  const code = await herdrWorkspace({
    argv: [repo],
    cwd: work,
    env: { MEFISTO_AGENT_START_RETRY_PAUSE: '0', ...env },
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    run: fake.run,
    hasCommand: (command) => command === 'herdr',
    now: clock.now,
    sleep: clock.sleep,
    platform,
  })
  return { code, out, err, log: fake.calls.join('\n'), calls: fake.calls }
}

const noAnchorProtocol = (run: Outcome): void => {
  assert.ok(!/pane close|pane rename .*fila libre/.test(run.log), run.log)
}

describe('workspace nuevo de Mefisto', () => {
  const oneRow = (): string =>
    [
      'herdr status server',
      'herdr workspace list',
      `herdr workspace create --cwd ${mefisto} --label fake-mefisto-repo --env MEFISTO_RUNTIME=claude`,
      `herdr pane split --pane w1:p1 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`,
      'herdr pane rename w1:p1 planner [claude]',
      'herdr pane rename w1:p2 ejecucion [claude]',
      'herdr pane process-info --pane w1:p1',
      'herdr agent start planner-fake-mefis-92c3-claude --kind claude --pane w1:p1 --timeout 90000 -- --agent mefisto-planner',
      'herdr pane process-info --pane w1:p2',
      'herdr agent start ejecucion-fake-mefis-92c3-claude --kind claude --pane w1:p2 --timeout 90000',
    ].join('\n')

  test('el default monta una fila sin splits down y conserva --env y --kind', async () => {
    const run = await runWorkspace(mefisto)
    assert.equal(run.code, 0, run.err)
    assert.equal(run.log, oneRow())
    noAnchorProtocol(run)
    const explicit = await runWorkspace(mefisto, {}, 2, { MEFISTO_RUNTIMES: 'claude' })
    assert.equal(explicit.log, oneRow())
    assert.ok(run.out.includes("Workspace 'fake-mefisto-repo' listo (w1): 1 fila(s) de runtime."))
  })

  test('dos runtimes: downs antes de rights y argumentos exactos', async () => {
    const run = await runWorkspace(mefisto, {}, 2, { MEFISTO_RUNTIMES: 'claude,fake' })
    assert.equal(run.code, 0, run.err)
    assert.equal(
      run.log,
      [
        'herdr status server',
        'herdr workspace list',
        `herdr workspace create --cwd ${mefisto} --label fake-mefisto-repo --env MEFISTO_RUNTIME=claude`,
        `herdr pane split --pane w1:p1 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=fake`,
        `herdr pane split --pane w1:p1 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`,
        `herdr pane split --pane w1:p2 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=fake`,
        'herdr pane rename w1:p1 planner [claude]',
        'herdr pane rename w1:p3 ejecucion [claude]',
        'herdr pane process-info --pane w1:p1',
        'herdr agent start planner-fake-mefis-92c3-claude --kind claude --pane w1:p1 --timeout 90000 -- --agent mefisto-planner',
        'herdr pane process-info --pane w1:p3',
        'herdr agent start ejecucion-fake-mefis-92c3-claude --kind claude --pane w1:p3 --timeout 90000',
        'herdr pane rename w1:p2 planner [fake]',
        'herdr pane rename w1:p4 ejecucion [fake]',
        'herdr pane process-info --pane w1:p2',
        'herdr agent start planner-fake-mefisto-repo-fake --kind fake --pane w1:p2 --timeout 90000 -- --agent mefisto-planner',
        'herdr pane process-info --pane w1:p4',
        'herdr agent start ejecucion-fake-mefisto-repo-fake --kind fake --pane w1:p4 --timeout 90000',
      ].join('\n'),
    )
    noAnchorProtocol(run)
  })

  test('tres runtimes: los down recorren la lista al reves y todos van antes de cualquier right', async () => {
    const run = await runWorkspace(mefisto, {}, 2, { MEFISTO_RUNTIMES: 'claude,fake,codex' })
    assert.deepEqual(
      run.calls.filter((call) => call.includes(' --direction down ')),
      [
        `herdr pane split --pane w1:p1 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=codex`,
        `herdr pane split --pane w1:p1 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=fake`,
      ],
    )
    const lastDown = run.calls.findLastIndex((call) => call.includes(' --direction down '))
    const firstRight = run.calls.findIndex((call) => call.includes(' --direction right '))
    assert.ok(lastDown < firstRight)
    for (const rename of ['herdr pane rename w1:p1 planner [claude]', 'herdr pane rename w1:p3 planner [fake]', 'herdr pane rename w1:p2 planner [codex]']) {
      assert.ok(run.calls.includes(rename), rename)
    }
    noAnchorProtocol(run)
  })

  test('MEFISTO_MODELS_FILE viaja como --env a cada pane de la fila', async () => {
    const run = await runWorkspace(mefisto, {}, 2, { MEFISTO_MODELS_FILE: '/x/modelos.json' })
    assert.ok(run.log.includes('--env MEFISTO_RUNTIME=claude --env MEFISTO_MODELS_FILE=/x/modelos.json'))
  })
})

describe('workspace existente de Mefisto', () => {
  test('con todas las filas solo se enfoca', async () => {
    const run = await runWorkspace(
      mefisto,
      { existingLabel: 'fake-mefisto-repo', panes: 'planner [claude]=w1:p1;ejecucion [claude]=w1:p3;planner [fake]=w1:p2;ejecucion [fake]=w1:p4' },
      5,
      { MEFISTO_RUNTIMES: 'claude,fake' },
    )
    assert.ok(run.calls.includes('herdr workspace focus w1'))
    assert.ok(!/pane split|pane rename|agent start/.test(run.log))
    assert.ok(run.out.includes('ya tiene todas las filas pedidas (w1)'))
    noAnchorProtocol(run)
  })

  test('con una fila faltante toca solo la nueva', async () => {
    const run = await runWorkspace(
      mefisto,
      { existingLabel: 'fake-mefisto-repo', panes: 'planner [claude]=w1:p1;ejecucion [claude]=w1:p3' },
      4,
      { MEFISTO_RUNTIMES: 'claude,fake' },
    )
    assert.ok(run.calls.includes(`herdr pane split --pane w1:p1 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=fake`))
    assert.ok(run.calls.includes(`herdr pane split --pane w1:p4 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=fake`))
    assert.ok(!/rename w1:p1|rename w1:p3|agent start .*claude/.test(run.log))
    assert.ok(run.calls.includes('herdr pane rename w1:p4 planner [fake]'))
    assert.ok(run.calls.includes('herdr pane rename w1:p5 ejecucion [fake]'))
    assert.ok(run.out.includes('se montaron 1 fila(s) faltante(s)'))
    noAnchorProtocol(run)
  })

  test('con una lista disjunta monta desde el ultimo planner disponible', async () => {
    const run = await runWorkspace(
      mefisto,
      { existingLabel: 'fake-mefisto-repo', panes: 'planner [codex]=w1:p7;ejecucion [codex]=w1:p8' },
      9,
      { MEFISTO_RUNTIMES: 'claude' },
    )
    assert.ok(run.calls.includes(`herdr pane split --pane w1:p7 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`))
    assert.ok(run.calls.includes(`herdr pane split --pane w1:p9 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`))
    assert.ok(!/rename w1:p7|rename w1:p8|agent start .*codex/.test(run.log))
    noAnchorProtocol(run)
  })
})

describe('consumidor', () => {
  test('preflight de configuracion: canonica, legacy y ausente', async () => {
    const canonical = await runWorkspace(consumer)
    assert.equal(canonical.code, 0)
    assert.ok(!(canonical.out + canonical.err).includes('parece no estar onboardeado'))
    assert.ok(canonical.calls.includes(`herdr workspace create --cwd ${consumer} --label fake consumer repo --env MEFISTO_RUNTIME=claude`))
    assert.ok(canonical.calls.includes('herdr pane rename w1:p1 planner [claude]'))

    const legacy = await runWorkspace(legacyConsumer)
    assert.equal(legacy.code, 0)
    assert.ok(!(legacy.out + legacy.err).includes('parece no estar onboardeado'))
    assert.ok(legacy.calls.includes(`herdr workspace create --cwd ${legacyConsumer} --label fake legacy consumer repo --env MEFISTO_RUNTIME=claude`))

    const missing = await runWorkspace(unconfigured)
    assert.equal(missing.code, 0)
    assert.ok(missing.out.includes('.mefisto/harness.config.json ni el fallback legacy .claude/harness.config.json'))
    assert.ok(!missing.out.includes('pipelines fallaran'))
    assert.ok(missing.log.includes(`workspace create --cwd ${unconfigured}`))
    assert.equal(existsSync(join(unconfigured, '.mefisto', 'harness.config.json')), false)
    assert.equal(existsSync(join(unconfigured, '.claude', 'harness.config.json')), false)
  })

  test('una fila claude con path con espacios, sin leer MEFISTO_RUNTIME(S)', async () => {
    const run = await runWorkspace(consumer, { expectCwd: consumer }, 2, { MEFISTO_RUNTIME: 'fake', MEFISTO_RUNTIMES: 'claude,fake' })
    assert.equal(run.code, 0, run.err)
    assert.equal(
      run.log,
      [
        'herdr status server',
        'herdr workspace list',
        `herdr workspace create --cwd ${consumer} --label fake consumer repo --env MEFISTO_RUNTIME=claude`,
        `herdr pane split --pane w1:p1 --direction right --cwd ${consumer} --no-focus --env MEFISTO_RUNTIME=claude`,
        'herdr pane rename w1:p1 planner [claude]',
        'herdr pane rename w1:p2 ejecucion [claude]',
        'herdr pane process-info --pane w1:p1',
        'herdr agent start planner-fake-consu-ec20-claude --kind claude --pane w1:p1 --timeout 90000 -- --agent mefisto:planner',
        'herdr pane process-info --pane w1:p2',
        'herdr agent start ejecucion-fake-consu-ec20-claude --kind claude --pane w1:p2 --timeout 90000',
      ].join('\n'),
    )
    noAnchorProtocol(run)
  })

  test('un worktree usa su propio toplevel', async () => {
    const run = await runWorkspace(worktree, { expectCwd: worktree })
    assert.equal(run.code, 0, run.err)
    assert.ok(run.log.includes(`workspace create --cwd ${worktree}`))
    assert.ok(!run.log.includes(`--cwd ${consumer} `))
  })

  test('legacy: normaliza la fila claude sin reconstruir y converge', async () => {
    const legacy = await runWorkspace(consumer, { existingLabel: 'fake consumer repo', panes: 'planner=w1:p1' })
    assert.ok(legacy.calls.includes('herdr pane rename w1:p1 planner [claude]'))
    assert.ok(!/pane split|agent start|pane close/.test(legacy.log))

    const ambiguous = await runWorkspace(consumer, {
      existingLabel: 'fake consumer repo',
      panes: 'planner=w1:p1;planner [claude]=w1:p3;ejecucion=w1:p2',
    })
    assert.ok(!/pane rename|pane split|agent start|pane close/.test(ambiguous.log))
    assert.ok(ambiguous.out.includes('duplicados o ambiguos'))

    const normalized = { existingLabel: 'fake consumer repo', panes: 'planner [claude]=w1:p1;ejecucion [claude]=w1:p2;planner [fake]=w1:p3;ejecucion [fake]=w1:p4' }
    const first = await runWorkspace(consumer, normalized)
    const second = await runWorkspace(consumer, normalized)
    assert.equal(second.log, first.log)
    assert.ok(second.calls.includes('herdr workspace focus w1'))
    assert.ok(!/pane rename|pane split|agent start|pane close/.test(second.log))
  })

  test('sin planner ni planner [claude] solo enfoca y avisa', async () => {
    const run = await runWorkspace(consumer, { existingLabel: 'fake consumer repo', panes: 'ejecucion=w1:p1' })
    assert.ok(run.out.includes("no contiene 'planner' ni 'planner [claude]'"))
    assert.ok(run.out.includes('quedo enfocado; completa o reintenta la normalizacion de la fila.'))
    assert.ok(!/pane rename|pane split|agent start/.test(run.log))
  })
})

describe('fallos', () => {
  test('un runtime que no arranca no contamina la otra fila', async () => {
    const run = await runWorkspace(mefisto, { failKind: 'fake' }, 2, { MEFISTO_RUNTIMES: 'claude,fake' })
    assert.equal(run.calls.filter((call) => /agent start .*--kind claude/.test(call)).length, 2)
    assert.equal(run.calls.filter((call) => /agent start .*--kind fake/.test(call)).length, 4)
    assert.ok(run.out.includes('El pane quedo con su shell'))
    assert.ok(run.out.includes('Detalle: {"error":"runtime fake ausente"}'))
    assert.ok(run.calls.includes('herdr pane rename w1:p2 planner [fake]'))
    assert.ok(run.calls.includes('herdr pane rename w1:p4 ejecucion [fake]'))
    noAnchorProtocol(run)
  })

  test('sin herdr o con el servidor caido aborta; fuera de git tambien', async () => {
    let err = ''
    const noHerdr = await herdrWorkspace({
      argv: [mefisto],
      cwd: work,
      env: {},
      out: () => {},
      err: (text) => void (err += text),
      run: () => fail(),
      hasCommand: () => false,
      now: () => new Date(),
      sleep: async () => {},
      platform: 'linux',
    })
    assert.equal(noHerdr, 1)
    assert.ok(err.includes('herdr no esta instalado (https://herdr.dev).'))
    const outside = await runWorkspace(join(work, 'no-es-un-repo'))
    assert.equal(outside.code, 1)
    assert.ok(outside.err.includes("no esta dentro de un repositorio git."))
  })

  test('en Windows un pane esta listo cuando herdr reporta su shell', async () => {
    const run = await runWorkspace(consumer, {}, 2, {}, 'win32')
    assert.equal(run.calls.filter((call) => call.startsWith('herdr agent start')).length, 2)
    assert.ok(!run.out.includes('no llego a su prompt'))
  })
})

describe('adopcion de un workspace sin panes de Mefisto (issue #2493)', () => {
  test('consumidor: monta la fila con down desde la raiz y right desde su planner', async () => {
    const run = await runWorkspace(consumer, { existingLabel: 'fake consumer repo', panes: '=w1:p1' })
    assert.equal(run.code, 0, run.err)
    assert.ok(run.calls.includes(`herdr pane split --pane w1:p1 --direction down --cwd ${consumer} --no-focus --env MEFISTO_RUNTIME=claude`))
    assert.ok(run.calls.includes(`herdr pane split --pane w1:p2 --direction right --cwd ${consumer} --no-focus --env MEFISTO_RUNTIME=claude`))
    assert.equal(run.calls.filter((call) => call.includes('--direction down')).length, 1)
    assert.equal(run.calls.filter((call) => call.includes('--direction right')).length, 1)
    assert.ok(run.calls.includes('herdr pane rename w1:p2 planner [claude]'))
    assert.ok(run.calls.includes('herdr pane rename w1:p3 ejecucion [claude]'))
    assert.ok(run.log.includes('herdr agent start planner-fake-consu-ec20-claude --kind claude --pane w1:p2 --timeout 90000 -- --agent mefisto:planner'))
    assert.ok(run.log.includes('herdr agent start ejecucion-fake-consu-ec20-claude --kind claude --pane w1:p3 '))
    assert.equal(run.calls.filter((call) => call.includes('agent start')).length, 2)
    assert.ok(!/pane rename w1:p1( |$)|--pane w1:p1 --timeout|pane split --pane w1:p1 --direction right/m.test(run.log))
    assert.ok(run.out.includes('no tenia panes de Mefisto: se montaron 1 fila(s) debajo del pane raiz.'))
    assert.ok(run.calls.includes('herdr workspace focus w1'))
    assert.ok(!run.out.includes('no contiene'))
    noAnchorProtocol(run)
  })

  test('Mefisto: monta las filas configuradas bajo la raiz sin tocarla', async () => {
    const run = await runWorkspace(mefisto, { existingLabel: 'fake-mefisto-repo', panes: '=w1:p1' }, 2, { MEFISTO_RUNTIMES: 'claude,fake' })
    assert.equal(run.code, 0, run.err)
    for (const call of [
      `herdr pane split --pane w1:p1 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=fake`,
      `herdr pane split --pane w1:p1 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`,
      `herdr pane split --pane w1:p3 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`,
      `herdr pane split --pane w1:p2 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=fake`,
    ]) {
      assert.ok(run.calls.includes(call), call)
    }
    assert.ok(run.log.includes('herdr agent start planner-fake-mefis-92c3-claude --kind claude --pane w1:p3 --timeout 90000 -- --agent mefisto-planner'))
    assert.equal(run.calls.filter((call) => call.includes('agent start')).length, 4)
    assert.ok(!/pane rename w1:p1( |$)|--pane w1:p1 --timeout/m.test(run.log))
    assert.ok(!run.out.includes('no contiene ningun planner'))
    assert.ok(run.out.includes('se montaron 2 fila(s) debajo del pane raiz.'))
    const lastDown = run.calls.findLastIndex((call) => call.includes(' --direction down '))
    const firstRight = run.calls.findIndex((call) => call.includes(' --direction right '))
    assert.ok(lastDown < firstRight)

    const single = await runWorkspace(mefisto, { existingLabel: 'fake-mefisto-repo', panes: '=w1:p1' })
    assert.ok(single.calls.includes(`herdr pane split --pane w1:p1 --direction down --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`))
    assert.ok(single.calls.includes(`herdr pane split --pane w1:p2 --direction right --cwd ${mefisto} --no-focus --env MEFISTO_RUNTIME=claude`))
    assert.ok(!/pane rename w1:p1( |$)/m.test(single.log))
  })

  test('un workspace solo con visores se adopta', async () => {
    const run = await runWorkspace(consumer, { existingLabel: 'fake consumer repo', panes: '[ok] mefisto-tooling #12=w1:p1;=w1:p2' })
    assert.ok(run.calls.includes(`herdr pane split --pane w1:p1 --direction down --cwd ${consumer} --no-focus --env MEFISTO_RUNTIME=claude`))
    assert.ok(!/pane rename w1:p1( |$)/m.test(run.log))
  })

  test('sin panes listados enfoca y avisa sin montar nada', async () => {
    const run = await runWorkspace(consumer, { existingLabel: 'fake consumer repo' })
    assert.ok(run.out.includes('no lista ningun pane desde el cual montar las filas'))
    assert.ok(!/pane split|pane rename|agent start/.test(run.log))
  })

  test('si ningun split prospera avisa en vez de reportar exito', async () => {
    const run = await runWorkspace(consumer, { existingLabel: 'fake consumer repo', panes: '=w1:p1', failSplit: true })
    assert.equal(run.code, 0)
    assert.ok(!/pane rename|agent start/.test(run.log))
    assert.ok(run.out.includes('no se pudo montar ninguna fila debajo del pane raiz'))
    assert.ok(!run.out.includes('se montaron 0 fila(s)'))
  })

  test('con dos workspaces del mismo label se prefiere el que tiene filas', async () => {
    const run = await runWorkspace(consumer, {
      existingLabel: 'fake consumer repo',
      secondWorkspace: true,
      panes: '=w1:p1',
      panesW2: 'planner [claude]=w2:p1;ejecucion [claude]=w2:p2',
    })
    assert.equal(run.code, 0, run.err)
    assert.ok(run.calls.includes('herdr workspace focus w2'))
    assert.ok(!/pane split|pane rename|agent start|workspace focus w1/.test(run.log))
  })

  test('los workspaces con panes de rol conservan su comportamiento', async () => {
    const legacy = await runWorkspace(consumer, { existingLabel: 'fake consumer repo', panes: 'planner=w1:p1' })
    assert.ok(legacy.calls.includes('herdr pane rename w1:p1 planner [claude]'))
    assert.ok(!/pane split|agent start/.test(legacy.log))
    const canonical = await runWorkspace(consumer, { existingLabel: 'fake consumer repo', panes: 'planner [claude]=w1:p1;ejecucion [claude]=w1:p3' }, 4)
    assert.ok(canonical.calls.includes('herdr workspace focus w1'))
    assert.ok(!/pane split|pane rename|agent start/.test(canonical.log))
  })
})

describe('distribucion y protocolo retirado', () => {
  test('dist/claude contiene el script fuente', () => {
    const source = readFileSync(join(REPO, 'scripts', 'herdr-workspace.mts'))
    assert.deepEqual(readFileSync(join(REPO, 'dist', 'claude', 'scripts', 'herdr-workspace.mts')), source)
  })

  test('no quedan cierres de panes ni el protocolo de ancla', () => {
    const source = readFileSync(join(REPO, 'scripts', 'herdr-workspace.mts'), 'utf8')
    assert.ok(!/mount_second_row|pane close|'close'|fila libre/.test(source))
  })

  test('plannerAgentForRepo distingue el repo de Mefisto', () => {
    assert.equal(plannerAgentForRepo(mefisto), 'mefisto-planner')
    assert.equal(plannerAgentForRepo(consumer), 'mefisto:planner')
  })
})
