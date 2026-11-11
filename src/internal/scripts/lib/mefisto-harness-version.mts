// Version y commit del harness con los que corre un pipeline interno. La version solo cambia en
// cada release; el commit distingue las corridas entre dos releases.
//
// Gemela de `get_harness_version` y `get_harness_sha` de `_mefisto-common.sh`: mientras tengan
// llamadores en bash, un cambio va en los dos lados. La paridad la verifica
// `.claude/scripts/tests/mefisto-harness-version.test.mts`.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Run } from '../../../../scripts/lib/azure-cli.mts'
import { capture } from '../../../../scripts/lib/cli.mts'
import { getHarnessVersion as publishedHarnessVersion } from '../../../../scripts/lib/pipeline/harness-identity.mts'
import { chomp } from './mefisto-script-io.mts'

/** Raiz del repo de Mefisto donde vive este modulo, sea cual sea el cwd del pipeline. */
export function mefistoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
}

/** `version` del manifiesto del plugin de `repoRoot`; vacia si falta, no es JSON o no la declara. */
export function getHarnessVersion(repoRoot: string = mefistoRoot()): string {
  // El lado publicado ubica el manifiesto desde su carpeta `scripts/`.
  return publishedHarnessVersion(join(repoRoot, 'scripts'))
}

/**
 * SHA corto del HEAD de `cwd`, que debe ser la raiz que aporta los scripts y no el worktree del
 * issue; vacio si no es un repo git o no hay `git`.
 */
export function getHarnessSha(cwd: string = process.cwd(), run: Run = capture): string {
  const result = run('git', ['rev-parse', '--short', 'HEAD'], { cwd })
  return result.status === 0 ? chomp(result.stdout) : ''
}
