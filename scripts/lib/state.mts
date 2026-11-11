// Estado operativo del pipeline (MEF-ADR-0053): se escribe solo en `.mefisto/pipeline`;
// `.claude/pipeline` queda como fallback de lectura.
//
// Gemela de `mefisto_state_path` y `mefisto_state_read_paths` de `_pipeline-common.sh` y de
// `mefisto-state.sh`: mientras tengan llamadores en bash, un cambio va en los dos lados.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { repoRoot } from './cli.mts'

export interface StateDirs {
  canonical: string
  legacy: string
}

/** Con `root` usa ese repo; sin el respeta `MEFISTO_STATE_DIR` y `MEFISTO_LEGACY_STATE_DIR`. */
export function stateDirs(root?: string, env: NodeJS.ProcessEnv = process.env): StateDirs {
  if (root !== undefined && root.length > 0) {
    return { canonical: join(root, '.mefisto', 'pipeline'), legacy: join(root, '.claude', 'pipeline') }
  }
  const base = repoRoot() ?? process.cwd()
  return {
    canonical: nonEmpty(env.MEFISTO_STATE_DIR) ?? join(base, '.mefisto', 'pipeline'),
    legacy: nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(base, '.claude', 'pipeline'),
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

/** Ruta canonica de escritura; crea solo su directorio padre. */
export function statePath(rel: string, root?: string, env: NodeJS.ProcessEnv = process.env): string {
  const full = join(stateDirs(root, env).canonical, rel)
  mkdirSync(dirname(full), { recursive: true })
  return full
}

/** Rutas que existen, la canonica primero y la legacy despues; no migra nada. */
export function stateReadPaths(
  rel: string,
  root?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const { canonical, legacy } = stateDirs(root, env)
  return [join(canonical, rel), join(legacy, rel)].filter((path) => existsSync(path))
}

export function stateReadFirst(
  rel: string,
  root?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return stateReadPaths(rel, root, env)[0] ?? null
}
