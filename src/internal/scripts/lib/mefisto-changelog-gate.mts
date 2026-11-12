// Gate de fragmentos de changelog: un cambio notable se anota en un archivo propio bajo
// `changelog.d/`, nunca editando `CHANGELOG.md`.

import { changedPaths } from './mefisto-changed-paths.mts'
import type { ChangedPathsOptions } from './mefisto-changed-paths.mts'

const EXEMPT_FILES = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md', '.gitignore', '.gitattributes'])

/** `true` si cambiar `path` (bitacora o gobierno del repo) no obliga a dejar fragmento. */
export function isPathChangelogExempt(path: string): boolean {
  return path.startsWith('docs/bitacora/') || EXEMPT_FILES.has(path)
}

/** `true` si algo de lo cambiado en `worktree` desde `base` es notable; no mira si hay fragmento. */
export function changesRequireChangelog(worktree: string, base: string, options: ChangedPathsOptions = {}): boolean {
  return changedPaths(worktree, base, options).some((path) => !isPathChangelogExempt(path))
}

function isChangelogFragment(path: string): boolean {
  return path !== 'changelog.d/README.md' && path.startsWith('changelog.d/') && path.endsWith('.md')
}

/** `true` si lo cambiado incluye un fragmento bajo `changelog.d/`; no valida su nombre ni su formato. */
export function changelogFragmentAdded(worktree: string, base: string, options: ChangedPathsOptions = {}): boolean {
  return changedPaths(worktree, base, options).some(isChangelogFragment)
}
