// Prefijo que evita la suspension idle de macOS mientras corre un pipeline largo.
//
// Gemela de `caffeinate_prefix` de `_pipeline-common.sh`: mientras tenga llamadores en bash, un
// cambio va en los dos lados.

import { commandExists } from '../cli.mts'

/**
 * Argumentos que se anteponen al lanzamiento de un sub-pipeline; vacio fuera de macOS o sin
 * `caffeinate` en el PATH. `caffeinate` hace exec del comando envuelto, asi que su PID y su
 * codigo de salida se conservan.
 */
export function caffeinatePrefix(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === 'darwin' && commandExists('caffeinate', env) ? ['caffeinate', '-i'] : []
}
