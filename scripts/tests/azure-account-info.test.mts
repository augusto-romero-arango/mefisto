import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { NO_SESSION, accountInfo, azureAccountInfo } from '../azure-account-info.mts'
import type { AccountDeps } from '../azure-account-info.mts'
import { CliError } from '../lib/cli.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'azure-account-info.mts')
const ACCOUNT = {
  id: 'sub-1',
  name: 'Sub Uno',
  tenantId: 'ten-1',
  user: { name: 'a@b.co', type: 'user' },
  secret: 'x',
}

let work = ''
let consumer = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto azure '))
  consumer = join(work, 'consumidor')
  execFileSync('git', ['init', '--quiet', consumer])
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

interface FakeAz {
  deps: AccountDeps
  calls: string[][]
}

function fakeAz(cwd: string, az: { status: number; stdout: string } | null): FakeAz {
  const calls: string[][] = []
  return {
    calls,
    deps: {
      cwd,
      hasCommand: (command) => command === 'az' && az !== null,
      run: (command, args) => {
        calls.push([command, ...args])
        return { status: az?.status ?? null, stdout: az?.stdout ?? '', stderr: '' }
      },
    },
  }
}

function errorOf(deps: AccountDeps): CliError {
  try {
    azureAccountInfo(deps)
  } catch (error) {
    assert.ok(error instanceof CliError)
    return error
  }
  throw new Error('se esperaba un CliError')
}

describe('accountInfo', () => {
  test('emite solo los cuatro campos, en el orden del contrato', () => {
    assert.equal(
      accountInfo(JSON.stringify(ACCOUNT)),
      '{"subscriptionId":"sub-1","subscriptionName":"Sub Uno","tenantId":"ten-1","user":"a@b.co"}',
    )
  })

  test('sin usuario el campo queda vacio y un campo ausente queda en null', () => {
    assert.equal(
      accountInfo('{"id":"sub-1","user":null}'),
      '{"subscriptionId":"sub-1","subscriptionName":null,"tenantId":null,"user":""}',
    )
    assert.equal(JSON.parse(accountInfo('{"user":{}}') ?? '{}').user, '')
    assert.equal(
      accountInfo('null'),
      '{"subscriptionId":null,"subscriptionName":null,"tenantId":null,"user":""}',
    )
  })

  test('una salida que no es la cuenta devuelve null', () => {
    for (const raw of ['', 'no es json', '[1]', '"texto"', '7', '{"user":"texto"}']) {
      assert.equal(accountInfo(raw), null, raw)
    }
  })
})

describe('azureAccountInfo', () => {
  test('con sesion devuelve el JSON y solo invoca az account show', () => {
    const az = fakeAz(consumer, { status: 0, stdout: `${JSON.stringify(ACCOUNT)}\n` })
    assert.deepEqual(JSON.parse(azureAccountInfo(az.deps)), {
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub Uno',
      tenantId: 'ten-1',
      user: 'a@b.co',
    })
    assert.deepEqual(az.calls, [['az', 'account', 'show', '-o', 'json']])
  })

  test('sin az, sin sesion o con una salida ilegible pide az login', () => {
    const cases = [
      fakeAz(consumer, null),
      fakeAz(consumer, { status: 1, stdout: '' }),
      fakeAz(consumer, { status: 0, stdout: 'no es json' }),
    ]
    for (const az of cases) {
      const error = errorOf(az.deps)
      assert.equal(error.message, NO_SESSION)
      assert.equal(error.exitCode, 1)
    }
    assert.deepEqual(cases[0]?.calls, [])
  })

  test('en el repo de Mefisto se niega sin invocar az', () => {
    const az = fakeAz(REPO_ROOT, { status: 0, stdout: JSON.stringify(ACCOUNT) })
    assert.equal(
      errorOf(az.deps).message,
      'ERROR: scripts/azure-account-info.mts es del plugin publicado y solo aplica al consumidor.',
    )
    assert.deepEqual(az.calls, [])
  })
})

describe('linea de comando', () => {
  function run(cwd: string, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  }

  test('en el repo de Mefisto termina en 1 con el mensaje por stderr y sin stdout', () => {
    const result = run(REPO_ROOT)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })

  test('fuera de un repo git termina en 1', () => {
    const outside = join(work, 'sin repo')
    mkdirSync(outside)
    const result = run(outside, { GIT_CEILING_DIRECTORIES: work })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trim(), 'ERROR: no estas en un repositorio git')
  })
})
