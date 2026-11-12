// Rutas que un pipeline interno cambio en su worktree: la entrada comun de los gates de scope y
// de changelog.

import type { Run } from '../../../../scripts/lib/azure-cli.mts'
import { capture } from '../../../../scripts/lib/cli.mts'

export interface ChangedPathsOptions {
  run?: Run
}

/**
 * Lo commiteado desde `base` y, despues, lo que `git status` reporta sin commitear, sin quitar
 * repetidos. Un git que falla no aporta rutas.
 */
export function changedPaths(worktree: string, base: string, options: ChangedPathsOptions = {}): string[] {
  const run = options.run ?? capture
  const committed = run('git', ['-C', worktree, 'diff', '--name-only', `${base}..HEAD`]).stdout
  // Sin `--untracked-files=all` git colapsa un directorio nuevo a su raiz, que no casa con ningun patron.
  const pending = run('git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=all']).stdout
  return [
    ...committed.split('\n'),
    // Solo se quita el estado `XY `: un renombre queda `viejo -> nuevo` y una ruta citada, con sus comillas.
    ...pending.split('\n').map((line) => line.replace(/^.../u, '')),
  ].filter((path) => path.length > 0)
}
