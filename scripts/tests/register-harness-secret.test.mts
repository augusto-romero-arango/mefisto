import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../lib/cli.mts'
import { USAGE, registerHarnessSecret } from '../register-harness-secret.mts'
import { CANONICAL_CONFIG, LEGACY_CONFIG, PLUGIN_MANIFEST, initRepo, pathIn } from './consumer-sandbox.mts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'register-harness-secret.mts')
const EMPTY = '{"secrets":[]}\n'

interface Secret {
  name: string
  source: { type: string; value: string }
}

let work = ''
let consumer = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto registro '))
  consumer = initRepo(join(work, 'consumidor'), { [CANONICAL_CONFIG]: EMPTY })
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function secrets(repo: string, config = CANONICAL_CONFIG): Secret[] {
  const root = JSON.parse(readFileSync(pathIn(repo, config), 'utf8')) as { secrets: Secret[] }
  return root.secrets
}

function errorOf(argv: string[], cwd: string): CliError {
  try {
    registerHarnessSecret(argv, cwd)
  } catch (error) {
    assert.ok(error instanceof CliError)
    return error
  }
  throw new Error('se esperaba un CliError')
}

test('(a) da de alta un secreto de cada tipo', () => {
  for (const type of ['output', 'github-secret', 'composite']) {
    registerHarnessSecret([`s-${type}`, type, `ref-${type}`], consumer)
    assert.deepEqual(
      secrets(consumer).find((secret) => secret.name === `s-${type}`),
      { name: `s-${type}`, source: { type, value: `ref-${type}` } },
    )
  }
})

test('(b) registrar un nombre que ya existe lo actualiza sin duplicarlo', () => {
  registerHarnessSecret(['s-output', 'output', 'otra'], consumer)
  const all = secrets(consumer)
  assert.equal(all.length, 3)
  assert.deepEqual(
    all.filter((secret) => secret.name === 's-output').map((secret) => secret.source.value),
    ['otra'],
  )
})

test('(c) un tipo invalido o una aridad distinta de tres imprimen el uso sin tocar el config', () => {
  const before = readFileSync(pathIn(consumer, CANONICAL_CONFIG))
  for (const argv of [
    ['x', 'bogus', 'ref'],
    ['x', 'output'],
    [],
    ['', 'output', 'ref'],
    ['x', 'output', ''],
  ]) {
    const error = errorOf(argv, consumer)
    assert.equal(error.message, USAGE)
    assert.equal(error.exitCode, 1)
  }
  assert.deepEqual(readFileSync(pathIn(consumer, CANONICAL_CONFIG)), before)
})

test('(d) con solo el config legacy aborta sin modificarlo ni crear el canonico', () => {
  const legacy = initRepo(join(work, 'legacy'), { [LEGACY_CONFIG]: EMPTY })
  const error = errorOf(['s', 'output', 'r'], legacy)
  assert.equal(error.exitCode, 1)
  assert.match(error.message, /^ERROR: solo existe el config legacy /)
  assert.equal(readFileSync(pathIn(legacy, LEGACY_CONFIG), 'utf8'), EMPTY)
  assert.equal(existsSync(pathIn(legacy, CANONICAL_CONFIG)), false)
})

test('(e) en el repo de Mefisto se niega sin registrar nada', () => {
  const mefisto = initRepo(join(work, 'mefisto'), { [PLUGIN_MANIFEST]: '{}', [CANONICAL_CONFIG]: EMPTY })
  assert.equal(
    errorOf(['s', 'output', 'r'], mefisto).message,
    'ERROR: register-harness-secret.sh es del plugin publicado y solo aplica al consumidor.',
  )
  assert.deepEqual(secrets(mefisto), [])
})

test('la linea de comando imprime el uso por stderr y termina en 1', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'x', 'bogus', 'ref'], {
    cwd: consumer,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `${USAGE}\n`)
})
