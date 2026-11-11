// Capacidades del runtime que un pipeline consulta a traves de su adaptador, sin conocer el
// nombre ni el formato de ninguno (MEF-ADR-0049).
//
// Gemela de `runtime_cli_available` y `runtime_supports_resume` de `_pipeline-common.sh`:
// mientras tengan llamadores en bash, un cambio va en los dos lados.

import { isRuntimeId, loadAdapter, runtimeLibDir } from '../../../src/runtime/lib/mefisto-runtime.mts'
import type { RuntimeAdapter } from '../../../src/runtime/lib/mefisto-runtime.mts'
import { commandExists } from '../cli.mts'

export interface RuntimeProbeOptions {
  env?: NodeJS.ProcessEnv
  /** Directorio de adaptadores; por defecto `MEFISTO_RUNTIME_LIB_DIR` o el del runtime. */
  libDir?: string
  hasCommand?: (command: string) => boolean
}

// Un runtime sin adaptador, sin la capacidad o cuya prueba falla responde que no.
async function probe(
  runtime: string,
  options: RuntimeProbeOptions,
  ask: (adapter: RuntimeAdapter, env: NodeJS.ProcessEnv) => boolean | undefined,
): Promise<boolean> {
  if (!isRuntimeId(runtime)) return false
  const env = options.env ?? process.env
  const adapter = await loadAdapter(options.libDir ?? runtimeLibDir(env), runtime)
  if (adapter === null) return false
  try {
    return ask(adapter, env) === true
  } catch {
    return false
  }
}

/** `true` si el CLI de `runtime` esta disponible, segun la prueba de su adaptador. */
export function runtimeCliAvailable(runtime: string, options: RuntimeProbeOptions = {}): Promise<boolean> {
  const hasCommand = options.hasCommand ?? ((command: string): boolean => commandExists(command, options.env))
  return probe(runtime, options, (adapter, env) => adapter.isAvailable?.(env, hasCommand))
}

/** `true` si `runtime` sabe reanudar una sesion; si no, la sonda de hold arranca de cero. */
export function runtimeSupportsResume(runtime: string, options: RuntimeProbeOptions = {}): Promise<boolean> {
  return probe(runtime, options, (adapter, env) => adapter.supportsResume?.(env))
}
