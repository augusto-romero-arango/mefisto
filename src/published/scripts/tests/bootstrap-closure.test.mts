// Clausura distribuida de los scripts de bootstrap greenfield: las copias de `dist/claude`
// son identicas a `scripts/`, resuelven sus modulos desde `dist/` y conservan su comportamiento.
// bootstrap-backend y setup-github-ci: scripts/tests/{bootstrap-backend,setup-github-ci}.test.mts.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import type { CommandResult } from '../../../../scripts/lib/cli.mts'
import { DIST_SCRIPTS, SCRIPTS, runScript, sandbox } from '../../../../scripts/tests/azure-cli-sandbox.mts'
import { check, isRegularFile, sameBytes } from './agent-contract-kit.mts'

type AccountModule = typeof import('../../../../scripts/azure-account-info.mts')

const ACCOUNT =
  '{"id":"sub-1","name":"Sub Uno","tenantId":"ten-1","user":{"name":"a@b.co","type":"user"},"secret":"x"}\n'
const NO_SESSION = "ERROR: no hay sesion de Azure activa. Ejecuta 'az login' y reintenta."

const box = sandbox('clausura bootstrap')
const consumer = box.repo('consumer')
const plugin = box.pluginRepo('plugin')

after(() => {
  box.remove()
})

interface AccountRun {
  /** Lo que el script imprimiria por stdout; vacio si aborto. */
  stdout: string
  /** Mensaje con el que aborto, o el del fallo al cargar el modulo de `dist/`. */
  error: string
  exitCode: number
  /** Argumentos de cada invocacion de `az`. */
  calls: string[][]
}

/** Corre la copia de `dist/` de azure-account-info en el consumidor, con un `az` falso. */
async function distAccountInfo(az: Partial<CommandResult>): Promise<AccountRun> {
  const calls: string[][] = []
  try {
    const module = (await import(
      pathToFileURL(join(DIST_SCRIPTS, 'azure-account-info.mts')).href
    )) as AccountModule
    const stdout = module.azureAccountInfo({
      cwd: consumer,
      hasCommand: () => true,
      run: (_command, args) => {
        calls.push(args)
        return { status: 0, stdout: '', stderr: '', ...az }
      },
    })
    return { stdout, error: '', exitCode: 0, calls }
  } catch (error) {
    // La copia de `dist/` lanza su propio `CliError`, distinto del de `scripts/`.
    const { message = String(error), exitCode = 1 } = error as { message?: string; exitCode?: number }
    return { stdout: '', error: message, exitCode, calls }
  }
}

const NO_AZ_SESSION = { status: 1, stderr: "ERROR: Please run 'az login' to setup account.\n" }

for (const name of ['azure-account-info', 'setup-github-labels']) {
  describe(name, () => {
    const copy = join(DIST_SCRIPTS, `${name}.mts`)
    check(
      `${name}: existe e identico a scripts/`,
      () => isRegularFile(copy) && sameBytes(copy, join(SCRIPTS, `${name}.mts`)),
      `${name}: falta o difiere de scripts/`,
    )

    test(`${name}: resuelve sus dependencias desde dist/ con la salida esperada`, async () => {
      // La salida esperada es el aviso de `az login` o el error del cargador del config: los dos
      // prueban que la copia resolvio sus modulos desde `dist/`.
      let output: string
      let expected: string
      if (name === 'azure-account-info') {
        output = (await distAccountInfo(NO_AZ_SESSION)).error
        expected = "Ejecuta 'az login' y reintenta"
      } else {
        const result = runScript(join(DIST_SCRIPTS, `${name}.mts`), ['--help'], consumer, box.work)
        output = result.stdout + result.stderr
        expected = 'no se encontro el config canonico'
      }
      const unresolved = output.split('\n').find((line) => /No such file|Cannot find module|ERR_MODULE_NOT_FOUND/.test(line))
      assert.equal(unresolved, undefined, `${name}: dependencia no resuelta (${unresolved})`)
      assert.ok(
        output.includes(expected),
        `${name}: salida inesperada: ${output.split('\n').slice(0, 2).join('\n')}`,
      )
    })

    test(`${name}: guard de consumidor aborta en el repo de Mefisto`, () => {
      const result = runScript(join(DIST_SCRIPTS, `${name}.mts`), [], plugin, box.work)
      assert.ok(
        result.status !== 0 && (result.stdout + result.stderr).includes('solo aplica al consumidor'),
        `${name}: guard de consumidor no aborto (rc=${result.status})`,
      )
    })
  })
}

describe('azure-account-info (d)', () => {
  test('con sesion emite JSON con las cuatro claves', async () => {
    const { stdout, exitCode } = await distAccountInfo({ stdout: ACCOUNT })
    const valid = (): boolean => {
      try {
        return isDeepStrictEqual(JSON.parse(stdout), {
          subscriptionId: 'sub-1',
          subscriptionName: 'Sub Uno',
          tenantId: 'ten-1',
          user: 'a@b.co',
        })
      } catch {
        return false
      }
    }
    assert.ok(exitCode === 0 && valid(), `JSON con sesion invalido (rc=${exitCode}): ${stdout}`)
  })

  test("solo se invoco 'az account show'", async () => {
    const { calls } = await distAccountInfo({ stdout: ACCOUNT })
    assert.ok(
      calls.length > 0 && calls.every((args) => args[0] === 'account' && args[1] === 'show'),
      `az invocado con otros comandos: ${calls.map((args) => args.join(' ')).join('\n')}`,
    )
  })

  test('sin sesion sale != 0 con mensaje de az login y sin stdout', async () => {
    const { stdout, error, exitCode } = await distAccountInfo(NO_AZ_SESSION)
    assert.ok(
      exitCode !== 0 && stdout === '' && error.includes(NO_SESSION),
      `sin sesion: rc=${exitCode} stdout='${stdout}'`,
    )
  })
})
