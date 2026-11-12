// El modo desacoplado de `launch-pipeline.mts` como proceso real: el lanzador termina enseguida
// y el pipeline sigue vivo despues, escribiendo en su report log.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { initRepo } from './consumer-sandbox.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(SCRIPTS, '..')

let work = ''
let restoreGit: () => void = () => {}

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto launch detached ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== null || Date.now() > deadline) return value
    await sleep(100)
  }
}

/** Copia del paquete publicado con lo que el lanzador importa y un pipeline de tooling falso. */
function packageCopy(): string {
  const pkg = join(work, 'pkg')
  mkdirSync(join(pkg, 'scripts'), { recursive: true })
  copyFileSync(join(SCRIPTS, 'launch-pipeline.mts'), join(pkg, 'scripts', 'launch-pipeline.mts'))
  cpSync(join(SCRIPTS, 'lib'), join(pkg, 'scripts', 'lib'), { recursive: true })
  cpSync(join(REPO, 'src', 'runtime', 'lib'), join(pkg, 'src', 'runtime', 'lib'), { recursive: true })
  copyFileSync(
    join(SCRIPTS, 'tests', 'fixtures', 'launch-pipeline', 'long-pipeline.mts'),
    join(pkg, 'scripts', 'tooling-pipeline.mts'),
  )
  return pkg
}

test('el lanzador sale enseguida y el pipeline sigue vivo y escribe en su report log', async () => {
  const pkg = packageCopy()
  const root = initRepo(join(work, 'consumidor'))
  const pidFile = join(work, 'pipeline.pid')
  const stopFile = join(work, 'pipeline.stop')
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('HERDR_') && !key.startsWith('MEFISTO_')) env[key] = value
  }
  Object.assign(env, { MEFISTO_UI: 'mod', MEFISTO_RUNTIME: 'claude', LAUNCH_TEST_OUT: pidFile, LAUNCH_TEST_STOP: stopFile })

  const started = Date.now()
  const launcher = spawnSync(process.execPath, [join(pkg, 'scripts', 'launch-pipeline.mts'), '--tooling', '42'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const elapsed = Date.now() - started
  assert.equal(launcher.status, 0, launcher.stderr)
  assert.ok(launcher.stdout.includes('Pipeline tooling-issue-42 iniciado'), launcher.stdout)

  const pidText = await waitFor(() => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : null), 20_000)
  assert.ok(pidText !== null, 'el pipeline no anoto su PID')
  const pid = Number(pidText.trim())
  try {
    assert.ok(isAlive(pid), 'el pipeline murio con el lanzador')
    // El pipeline espera hasta un minuto: un lanzador que lo esperara no habria salido aun.
    assert.ok(elapsed < 30_000, `el lanzador tardo ${elapsed} ms`)

    const logs = join(root, '.mefisto', 'pipeline', 'logs')
    const report = readdirSync(logs).find((name) => /^tooling-issue-42-run-\d{8}-\d{6}\.report\.log$/.test(name))
    assert.ok(report !== undefined, `sin report log en ${logs}`)
    assert.ok(launcher.stdout.includes(join(logs, report)))
    const text = await waitFor(() => {
      const content = readFileSync(join(logs, report), 'utf8')
      return content.length > 0 ? content : null
    }, 10_000)
    assert.equal(text, 'arrancado: [42]\n')
  } finally {
    writeFileSync(stopFile, '')
    if (isAlive(pid)) process.kill(pid)
    await waitFor(() => (isAlive(pid) ? null : true), 10_000)
  }
})
