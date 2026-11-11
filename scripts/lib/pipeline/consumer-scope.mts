// Rutas del repo consumidor reservadas al plugin (MEF-ADR-0019) y el gate que las vigila despues
// de cada stage que invoca un agente.
//
// Gemela de `is_path_in_consumer_blocklist` y `validate_consumer_scope_changes` de
// `_pipeline-common.sh`: mientras tengan llamadores en bash, un cambio va en los dos lados. La
// paridad la verifica `scripts/tests/pipeline-consumer-scope.test.mts`.

import { chomp, rawField } from '../azure-cli.mts'
import type { Run } from '../azure-cli.mts'
import { capture } from '../cli.mts'
import { PUBLISHED_SLUG, readJsonFile } from '../plugin-scopes.mts'

const BLOCKED_PREFIXES = [
  'commands/',
  'skills/',
  'agents/',
  'hooks/',
  '.claude-plugin/',
  'src/published/',
  'src/runtime/',
  'dist/',
  'docs/adr/mef-adr-',
]

const BLOCKED_FILES = new Set(['mefisto-manifest.json'])

/**
 * `path` es relativo a la raiz del repo, como lo imprime git. En Windows `\` solo puede ser un
 * separador y el sistema de archivos no distingue mayusculas, asi que alli se normaliza antes de
 * comparar; en el resto el veredicto es el de la gemela bash para cualquier texto.
 */
export function isPathInConsumerBlocklist(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const candidate = platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path
  return BLOCKED_FILES.has(candidate) || BLOCKED_PREFIXES.some((prefix) => candidate.startsWith(prefix))
}

export interface ScopeCheckOptions {
  run?: Run
  /** Ruta efectiva del `harness.config.json`; su `repoSlug` nombra el repo del plugin en el diagnostico. */
  configPath?: string
  platform?: NodeJS.Platform
}

export interface ScopeCheck {
  /** Rutas cambiadas que caen en el blocklist, en el orden en que git las reporta. */
  violations: string[]
  /** Diagnostico para stderr, linea a linea; vacio si no hay violaciones. */
  message: string[]
}

function pluginRepoSlug(configPath: string | undefined): string {
  if (configPath === undefined || configPath.length === 0) return PUBLISHED_SLUG
  const slug = chomp(rawField(readJsonFile(configPath), 'repoSlug'))
  return slug.length > 0 ? slug : PUBLISHED_SLUG
}

/** Lo commiteado desde `base` y lo que `git status` reporta sin commitear; un git que falla no aporta rutas. */
function changedPaths(run: Run, worktree: string, base: string): string[] {
  const committed = run('git', ['-C', worktree, 'diff', '--name-only', `${base}..HEAD`]).stdout
  const pending = run('git', ['-C', worktree, 'status', '--porcelain']).stdout
  return [
    ...committed.split('\n'),
    // Solo se quita el estado `XY `: un renombre queda `viejo -> nuevo` y una ruta citada, con sus comillas.
    ...pending.split('\n').map((line) => line.replace(/^.../u, '')),
  ].filter((path) => path.length > 0)
}

/** Revisa que lo cambiado en `worktree` desde `base` no toque rutas reservadas al plugin. */
export function validateConsumerScopeChanges(
  worktree: string,
  base: string,
  options: ScopeCheckOptions = {},
): ScopeCheck {
  const run = options.run ?? capture
  const violations = changedPaths(run, worktree, base).filter((path) =>
    isPathInConsumerBlocklist(path, options.platform),
  )
  if (violations.length === 0) return { violations, message: [] }

  const repoSlug = pluginRepoSlug(options.configPath)
  const head = chomp(run('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout)
  const branch = head.length > 0 ? head : `la rama del worktree ${worktree}`
  return {
    violations,
    message: [
      'ERROR: el agente toco rutas reservadas al plugin Mefisto:',
      ...violations.map((path) => `  - ${path}`),
      '',
      'Las rutas commands/, skills/, agents/, hooks/, .claude-plugin/, src/published/, src/runtime/, dist/ y los archivos',
      `docs/adr/mef-adr-* pertenecen al plugin (repo ${repoSlug}).`,
      '',
      `El resto del trabajo del agente NO se perdio: ya quedo commiteado en '${branch}'.`,
      'Para recuperarlo, revierte ahi los archivos listados arriba y abre el PR a mano.',
      'Si necesitas modificar el plugin, abre un draft en su repo:',
      `  gh issue create -R ${repoSlug} \\`,
      '    --label "estado:borrador,tipo:tooling" --title "..."',
    ],
  }
}
