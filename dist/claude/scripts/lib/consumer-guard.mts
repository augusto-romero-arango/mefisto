// Guard de los scripts publicados: solo aplican al repo de un consumidor (MEF-ADR-0019).

import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CliError, repoRoot } from './cli.mts'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Raiz del repo que contiene `cwd`; aborta fuera de git y, con `refusal`, en el repo de Mefisto. */
export function consumerRepoRoot(cwd: string, refusal: string[]): string {
  const root = repoRoot(cwd)
  if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
  if (isFile(join(root, '.claude-plugin', 'plugin.json'))) throw new CliError(refusal.join('\n'))
  // git imprime la ruta con `/` tambien en Windows.
  return resolve(root)
}
