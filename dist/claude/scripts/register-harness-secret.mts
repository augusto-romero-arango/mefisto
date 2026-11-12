// Registra los metadatos de un secreto en `.mefisto/harness.config.json` > secrets[]
// (MEF-ADR-0025: nunca valores).
//
// Uso: node scripts/register-harness-secret.mts <nombre> <output|github-secret|composite> <referencia>

import { CliError, isEntryPoint, runMain } from './lib/cli.mts'
import { consumerRepoRoot } from './lib/consumer-guard.mts'
import { upsertHarnessSecret } from './lib/harness-config.mts'

export const USAGE = 'Uso: register-harness-secret.mts <nombre> <output|github-secret|composite> <referencia>'

const SOURCE_TYPES = ['output', 'github-secret', 'composite']

export function registerHarnessSecret(argv: string[], cwd: string): void {
  const [name, type, reference] = argv
  if (argv.length !== 3 || name === undefined || type === undefined || reference === undefined) {
    throw new CliError(USAGE)
  }
  if (name === '' || reference === '' || !SOURCE_TYPES.includes(type)) throw new CliError(USAGE)
  consumerRepoRoot(cwd, [
    'ERROR: register-harness-secret.mts es del plugin publicado y solo aplica al consumidor.',
  ])
  upsertHarnessSecret(name, type, reference, undefined, { cwd })
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => registerHarnessSecret(process.argv.slice(2), process.cwd()))
}
