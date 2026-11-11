// Llamadas a las funciones de `_pipeline-common.sh` para los tests de paridad de sus gemelas de
// `scripts/lib/pipeline/`. Se borra junto con la libreria bash.

import { join } from 'node:path'

import { capture, commandExists } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'

const BASH_LIBRARY = join(import.meta.dirname, '..', '_pipeline-common.sh')

const MISSING_TOOL = commandExists('bash') && commandExists('jq') ? false : 'requiere bash y jq'

/** Motivo para saltar la paridad, o `false`: en Windows no se exige bash. */
export const NO_BASH_TWIN: string | false =
  process.platform === 'win32' ? 'la libreria bash no se prueba en Windows' : MISSING_TOOL

/** Corre `script` con la libreria cargada y `args` como parametros posicionales. */
export function bashTwin(script: string, args: string[] = [], env: Record<string, string> = {}): CommandResult {
  return capture('bash', ['-c', `set +u; source "$1" 2>/dev/null; shift; ${script}`, 'bash', BASH_LIBRARY, ...args], {
    env: { ...process.env, ...env },
  })
}
