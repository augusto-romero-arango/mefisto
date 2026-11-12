// Gate de scope de los pipelines internos: lo que cambia un stage solo puede caer en las rutas
// del propio plugin (MEF-ADR-0019).
//
// Gemela de `validate_mefisto_scope_changes` de `_mefisto-common.sh`: mientras tenga llamadores
// en bash, un cambio va en los dos lados. La paridad la verifica
// `.claude/scripts/tests/mefisto-scope-gate.test.mts`.

import type { ScopeCheck } from '../../../../scripts/lib/pipeline/consumer-scope.mts'
import { changedPaths } from './mefisto-changed-paths.mts'
import type { ChangedPathsOptions } from './mefisto-changed-paths.mts'
import { isPathInMefistoScope } from './mefisto-scope.mts'

/** Revisa que lo cambiado en `worktree` desde `base` caiga en el scope de Mefisto. */
export function validateMefistoScopeChanges(
  worktree: string,
  base: string,
  options: ChangedPathsOptions = {},
): ScopeCheck {
  const violations = changedPaths(worktree, base, options).filter((path) => !isPathInMefistoScope(path))
  if (violations.length === 0) return { violations, message: [] }
  return {
    violations,
    message: [
      'ERROR: cambios fuera del scope de Mefisto:',
      ...violations.map((path) => `  - ${path}`),
      '',
      'Mefisto solo permite cambios en: commands/, skills/, agents/, scripts/,',
      'hooks/, docs/, .claude-plugin/, .claude/{commands,skills,agents,scripts,mods}/,',
      '.claude/settings.json, .mcp.json, src/{internal,published,runtime}/, dist/,',
      '.github/{workflows,rulesets}/, AGENTS.md,',
      'changelog.d/, README.md, CHANGELOG.md, CLAUDE.md, .gitignore, .gitattributes, LICENSE, NOTICE',
    ],
  }
}
