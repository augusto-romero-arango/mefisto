// Descubrimiento del runtime activo cuando nadie lo fija con MEFISTO_RUNTIME.
//
// Gemela de la rama de descubrimiento de `mefisto_resolve_runtime`
// (`src/runtime/lib/mefisto-runtime.sh`): mientras tenga llamadores en bash, un cambio va en
// los dos lados. Bash prueba cada adaptador `runtime-<id>.sh` cargandolo; aqui la prueba de
// cada runtime vive en `PROBES` y un adaptador sin prueba cuenta como no disponible.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Probe = (env: NodeJS.ProcessEnv, hasCommand: (command: string) => boolean) => boolean

const PROBES = new Map<string, Probe>([
  ['claude', (_env, hasCommand) => hasCommand('claude')],
  ['fake', (env) => env.MEFISTO_FAKE_AVAILABLE === '1'],
])

export type RuntimeDiscovery = { runtime: string } | { error: string }

function adapterIds(libDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(libDir).sort()
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    const id = /^runtime-([a-z0-9_]+)\.sh$/.exec(name)?.[1]
    if (id !== undefined && statSync(join(libDir, name)).isFile()) ids.push(id)
  }
  return ids
}

/** Unico runtime disponible entre los adaptadores de `libDir`, o el error a mostrar. */
export function discoverRuntime(
  libDir: string,
  env: NodeJS.ProcessEnv,
  hasCommand: (command: string) => boolean,
): RuntimeDiscovery {
  const known = adapterIds(libDir)
  const available = known.filter((id) => PROBES.get(id)?.(env, hasCommand) === true)
  const [runtime] = available
  if (runtime === undefined) {
    return {
      error: `no se detecto ningun runtime disponible entre los adaptadores (${known.join(', ')}): fija MEFISTO_RUNTIME o --runtime`,
    }
  }
  if (available.length > 1) {
    return {
      error: `se detectaron varios runtimes disponibles (${available.join(' ')}): fija MEFISTO_RUNTIME o --runtime para desambiguar`,
    }
  }
  return { runtime }
}
