// Acceso a `_mefisto-common.sh` para los tests de paridad de sus gemelas en TypeScript.

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { bashLibrary, REPO_ROOT } from '../../../scripts/tests/pipeline-scope-parity.mts'
import type { BashOptions } from '../../../scripts/tests/pipeline-scope-parity.mts'

export { FAKE_GH, NO_BASH, NO_BASH_JQ, REPO_ROOT } from '../../../scripts/tests/pipeline-scope-parity.mts'

const LIBRARY_PATH = ['src', 'internal', 'scripts', 'lib', '_mefisto-common.sh']
// Lo que la libreria carga con `source`, relativo a su propia ubicacion.
const LIBRARY_DEPENDENCIES = [
  ['src', 'internal', 'scripts', 'lib', 'mefisto-state.sh'],
  ['src', 'runtime', 'lib', 'mefisto-process.sh'],
]

export const MEFISTO_LIBRARY = join(REPO_ROOT, ...LIBRARY_PATH)

/** Corre `script` en bash con `_mefisto-common.sh` ya cargada; `args` llegan como `$1`, `$2`, ... */
export function mefistoBash(script: string, args: string[] = [], options: BashOptions = {}): CommandResult {
  return bashLibrary(script, args, { library: MEFISTO_LIBRARY, ...options })
}

/** Copia la libreria a `root` con el layout del repo, para que resuelva sus rutas desde ahi. */
export function copyMefistoLibrary(root: string): string {
  for (const parts of [LIBRARY_PATH, ...LIBRARY_DEPENDENCIES]) {
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true })
    copyFileSync(join(REPO_ROOT, ...parts), join(root, ...parts))
  }
  return join(root, ...LIBRARY_PATH)
}
