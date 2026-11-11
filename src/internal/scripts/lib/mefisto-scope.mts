// Allowlist de rutas que el propio plugin puede tocar (MEF-ADR-0019).
//
// Gemela de `is_path_in_mefisto_scope` en `_mefisto-common.sh`: mientras esa libreria tenga
// llamadores en bash, un cambio en la lista va en las dos. La paridad la verifica
// `.claude/scripts/tests/mefisto-scope-hook.test.mts`.

const SCOPE_PREFIXES = [
  'commands/',
  'skills/',
  'agents/',
  'scripts/',
  'hooks/',
  'docs/',
  'src/internal/',
  'src/published/',
  'src/runtime/',
  'dist/',
  '.claude-plugin/',
  '.claude/commands/',
  '.claude/skills/',
  '.claude/agents/',
  '.claude/scripts/',
  '.claude/mods/',
  'changelog.d/',
  '.github/workflows/',
  '.github/rulesets/',
]

const SCOPE_FILES = new Set([
  '.claude/settings.json',
  '.mcp.json',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  '.gitignore',
  'AGENTS.md',
  'LICENSE',
  'NOTICE',
  'mefisto-manifest.json',
])

export const SCOPE_SUMMARY =
  'commands/, skills/, agents/, scripts/, hooks/, docs/, .claude-plugin/, ' +
  '.claude/{commands,skills,agents,scripts,mods}/, .claude/settings.json, .mcp.json, ' +
  'src/{internal,published,runtime}/, dist/, .github/{workflows,rulesets}/, AGENTS.md, changelog.d/, ' +
  'README.md, CHANGELOG.md, CLAUDE.md, .gitignore, LICENSE, NOTICE.'

/** `path` es relativo a la raiz del repo y usa `/` como separador. */
export function isPathInMefistoScope(path: string): boolean {
  if (path.length === 0) return false
  return SCOPE_FILES.has(path) || SCOPE_PREFIXES.some((prefix) => path.startsWith(prefix))
}
