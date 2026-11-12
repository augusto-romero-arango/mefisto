// Interfaz de los adaptadores de runtime y resolucion del runtime activo. El conjunto de
// runtimes es abierto (MEF-ADR-0050): cada `runtime-<id>.mts` del directorio de adaptadores es
// uno, y ninguno se enumera aqui salvo en la tabla de pruebas sincronas.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Json } from '../../../scripts/lib/jq-values.mts'

export interface BuildCommandInput {
  agent: string
  cwd: string
  promptFile: string
  /** Opaco; vacio significa heredar. */
  model: string
  /** Ruta, o vacio si no hay system prompt. */
  systemFile: string
  /** Opaco; vacio significa sesion nueva. */
  resumeSessionId: string
  /** Effort ya en nombre nativo; vacio significa heredar. */
  effort: string
  /** Directorio temporal de la corrida, o vacio si el llamador no tiene uno. */
  workDir: string
  env: NodeJS.ProcessEnv
}

export interface RuntimeCommand {
  argv: string[]
  /** Variables que se suman al entorno del proceso. */
  env?: Record<string, string>
  /** Archivo regular que viaja por la entrada estandar; sin el, la entrada queda cerrada. */
  stdinFile?: string
}

export interface TranslateInput {
  rawFile: string
  runtime: string
  model: string
  /** `null` mientras el proceso sigue vivo. */
  exitCode: number | null
  /** Vacio mientras el proceso sigue vivo. */
  stderrFile: string
}

/** Lo que exporta un `runtime-<id>.mts`. Solo `buildCmd` y `translate` son obligatorias. */
export interface RuntimeAdapter {
  /** Prueba de disponibilidad, sin leer credenciales. */
  isAvailable?: (env: NodeJS.ProcessEnv, hasCommand: (command: string) => boolean) => boolean
  buildCmd?: (input: BuildCommandInput) => RuntimeCommand
  /** Eventos neutrales (mensajes, tools y terminal) de la traza cruda; nunca `run.started`. */
  translate?: (input: TranslateInput) => Json[]
  supportsResume?: (env: NodeJS.ProcessEnv) => boolean
  /** `prompt <texto>` o `restart <comando>`; `null` si el runtime no sabe refrescarse. */
  interactiveRefresh?: (env: NodeJS.ProcessEnv) => string | null
  /** Modelo de un perfil (vacio = heredar); `null` si no acepta el perfil. */
  defaultModel?: (profile: string, env: NodeJS.ProcessEnv) => string | null
  /** Valor nativo de un nivel de effort (vacio = heredar); `null` si no acepta el nivel. */
  defaultEffort?: (level: string, env: NodeJS.ProcessEnv) => string | null
}

const RUNTIME_ID = /^[a-z0-9_]+$/

export function isRuntimeId(id: string): boolean {
  return RUNTIME_ID.test(id)
}

/** Directorio de adaptadores: `MEFISTO_RUNTIME_LIB_DIR` o el de este modulo. */
export function runtimeLibDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MEFISTO_RUNTIME_LIB_DIR ?? ''
  return override.length > 0 ? override : dirname(fileURLToPath(import.meta.url))
}

export function adapterPath(libDir: string, runtime: string): string {
  return join(libDir, `runtime-${runtime}.mts`)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Ids de los adaptadores de `libDir`, en orden alfabetico. */
export function adapterIds(libDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(libDir).sort()
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    const id = /^runtime-([a-z0-9_]+)\.mts$/.exec(name)?.[1]
    if (id !== undefined && isFile(join(libDir, name))) ids.push(id)
  }
  return ids
}

/** Adaptador de `runtime` en `libDir`, o `null` si el archivo no existe o no carga. */
export async function loadAdapter(libDir: string, runtime: string): Promise<RuntimeAdapter | null> {
  const file = adapterPath(libDir, runtime)
  try {
    // El hash evita que un archivo reescrito se sirva desde la cache de modulos.
    const version = createHash('sha1').update(readFileSync(file)).digest('hex')
    return (await import(`${pathToFileURL(file).href}?v=${version}`)) as RuntimeAdapter
  } catch {
    return null
  }
}

export type RuntimeDiscovery = { runtime: string } | { error: string }

function pickRuntime(known: string[], available: string[]): RuntimeDiscovery {
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

type Probe = (env: NodeJS.ProcessEnv, hasCommand: (command: string) => boolean) => boolean

// Copia de `isAvailable` de cada adaptador para quien no puede esperar a cargarlos; un
// adaptador sin entrada aqui cuenta como no disponible en `discoverRuntime`.
const PROBES = new Map<string, Probe>([
  ['claude', (_env, hasCommand) => hasCommand('claude')],
  ['fake', (env) => env.MEFISTO_FAKE_AVAILABLE === '1'],
])

/** Unico runtime disponible entre los adaptadores de `libDir`, sin cargarlos. */
export function discoverRuntime(
  libDir: string,
  env: NodeJS.ProcessEnv,
  hasCommand: (command: string) => boolean,
): RuntimeDiscovery {
  const known = adapterIds(libDir)
  return pickRuntime(
    known,
    known.filter((id) => PROBES.get(id)?.(env, hasCommand) === true),
  )
}

/**
 * Runtime activo: `explicit`, luego `MEFISTO_RUNTIME`, luego el unico adaptador de `libDir` cuya
 * prueba `isAvailable` pasa. El elegido debe tener adaptador.
 */
export async function resolveRuntime(
  explicit: string,
  env: NodeJS.ProcessEnv,
  hasCommand: (command: string) => boolean,
  libDir: string = runtimeLibDir(env),
): Promise<RuntimeDiscovery> {
  let runtime = explicit.length > 0 ? explicit : (env.MEFISTO_RUNTIME ?? '')
  if (runtime.length === 0) {
    const known = adapterIds(libDir)
    const available: string[] = []
    for (const id of known) {
      const adapter = await loadAdapter(libDir, id)
      let ok = false
      try {
        ok = adapter?.isAvailable?.(env, hasCommand) === true
      } catch {
        ok = false
      }
      if (ok) available.push(id)
    }
    const found = pickRuntime(known, available)
    if ('error' in found) return found
    runtime = found.runtime
  }
  if (!isRuntimeId(runtime)) return { error: `runtime invalido: '${runtime}'` }
  const lib = adapterPath(libDir, runtime)
  if (!isFile(lib)) {
    return {
      error: `runtime '${runtime}' no tiene adaptador (${lib}): fija MEFISTO_RUNTIME a un runtime soportado`,
    }
  }
  return { runtime }
}
