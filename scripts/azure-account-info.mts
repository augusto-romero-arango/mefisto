// Expone la cuenta de Azure de la sesion `az` activa como JSON de solo lectura.
// Ejecuta unicamente `az account show`; nunca emite tokens ni secretos.
//
// Salida (stdout): {"subscriptionId","subscriptionName","tenantId","user"}
//
// Uso: node scripts/azure-account-info.mts
// Prerequisito: az login

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CliError, capture, commandExists, isEntryPoint, repoRoot, runMain } from './lib/cli.mts'
import type { CommandOptions, CommandResult } from './lib/cli.mts'

export const NO_SESSION = "ERROR: no hay sesion de Azure activa. Ejecuta 'az login' y reintenta."

export interface AccountDeps {
  cwd: string
  hasCommand: (command: string) => boolean
  run: (command: string, args: string[], options?: CommandOptions) => CommandResult
}

/** JSON de una linea con los cuatro campos, o `null` si `raw` no es la cuenta que imprime `az`. */
export function accountInfo(raw: string): string | null {
  let account: unknown
  try {
    // `null` es una cuenta sin campos: la salida conserva las cuatro claves.
    account = (JSON.parse(raw) as unknown) ?? {}
  } catch {
    return null
  }
  if (typeof account !== 'object' || account === null || Array.isArray(account)) return null
  const { id, name, tenantId, user } = account as Record<string, unknown>
  if (user !== undefined && user !== null && (typeof user !== 'object' || Array.isArray(user))) return null
  const userName = (user as Record<string, unknown> | null | undefined)?.name
  return JSON.stringify({
    subscriptionId: id ?? null,
    subscriptionName: name ?? null,
    tenantId: tenantId ?? null,
    user: userName === undefined || userName === null || userName === false ? '' : userName,
  })
}

export function azureAccountInfo(deps: AccountDeps): string {
  const root = repoRoot(deps.cwd)
  if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
  if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
    throw new CliError(
      'ERROR: scripts/azure-account-info.sh es del plugin publicado y solo aplica al consumidor.',
    )
  }
  if (!deps.hasCommand('az')) throw new CliError(NO_SESSION)
  const shown = deps.run('az', ['account', 'show', '-o', 'json'], { cwd: deps.cwd })
  const info = shown.status === 0 ? accountInfo(shown.stdout) : null
  if (info === null) throw new CliError(NO_SESSION)
  return info
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => {
    console.log(azureAccountInfo({ cwd: process.cwd(), hasCommand: commandExists, run: capture }))
  })
}
