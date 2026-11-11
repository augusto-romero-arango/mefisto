// Acceso a `_pipeline-common.sh` para los tests de paridad de sus gemelas de `scripts/lib/pipeline/`.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { capture, commandExists } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BASH_LIBRARY = join(REPO_ROOT, 'scripts', '_pipeline-common.sh')

/** Motivo para saltar un test de paridad, o `false` si se puede correr. */
export const NO_BASH: string | false =
  process.platform === 'win32' || !commandExists('bash') ? 'requiere bash' : false
export const NO_BASH_JQ: string | false = NO_BASH || (commandExists('jq') ? false : 'requiere jq')

// `gh` falso para bash: aplica con jq el filtro `-q` del llamador al JSON de `GH_JSON`, o falla con `GH_RC`.
export const FAKE_GH = `gh() {
  [ "\${GH_RC:-0}" = 0 ] || return "$GH_RC"
  local query="." prev="" arg
  for arg in "$@"; do [ "$prev" = "-q" ] && query="$arg"; prev="$arg"; done
  printf '%s' "$GH_JSON" | jq -r "$query"
}
`

export interface BashOptions {
  /** Copia de la libreria a cargar en vez de la del repo. */
  library?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/** Corre `script` en bash con la libreria ya cargada; `args` llegan como `$1`, `$2`, ... */
export function bashLibrary(script: string, args: string[] = [], options: BashOptions = {}): CommandResult {
  return capture(
    'bash',
    ['-c', `set +u; source "$0" >/dev/null 2>&1\n${script}`, options.library ?? BASH_LIBRARY, ...args],
    { cwd: options.cwd, env: options.env },
  )
}
