// Resolucion de modelo y de effort de un agente. El llamador entrega el override y el archivo
// de mapping: este nucleo no conoce estado, cwd, Git ni stages (MEF-ADR-0019).
//
// Gemela de `mefisto-models.sh` y de `contract/models.validate.jq`, que aun cargan los pipelines
// en bash: un cambio va en los dos lados.

import { readFileSync, statSync } from 'node:fs'

import { isObject, parseStream } from '../../../scripts/lib/jq-values.mts'
import type { Json, JsonObject } from '../../../scripts/lib/jq-values.mts'
import { adapterPath, isRuntimeId, loadAdapter, runtimeLibDir } from './mefisto-runtime.mts'
import type { RuntimeAdapter } from './mefisto-runtime.mts'

export const MODEL_PROFILES: readonly string[] = ['fast', 'balanced', 'deep']
export const EFFORT_LEVELS: readonly string[] = ['quick', 'light', 'standard', 'thorough', 'exhaustive']

const NON_EMPTY_STRING = 'se esperaba un string no vacio'
const OBJECT = 'se esperaba un objeto'

function modelErrors(value: Json, path: string): string[] {
  return typeof value === 'string' && value.length > 0 ? [] : [`${path}: ${NON_EMPTY_STRING}`]
}

function unknownFields(config: JsonObject, path: string, known: readonly string[]): string[] {
  return Object.keys(config)
    .filter((key) => !known.includes(key))
    .map((key) => `${path}.${key}: campo desconocido`)
}

/** Errores de la seccion `key` de `config` si esta presente; `each` juzga cada entrada. */
function sectionErrors(
  config: JsonObject,
  key: string,
  path: string,
  each: (name: string, value: Json, path: string) => string[],
): string[] {
  if (!Object.hasOwn(config, key)) return []
  const section = config[key] ?? null
  if (!isObject(section)) return [`${path}.${key}: ${OBJECT}`]
  return Object.entries(section).flatMap(([name, value]) => each(name, value, `${path}.${key}.${name}`))
}

function effortsErrors(config: JsonObject, runtime: string): string[] {
  if (!Object.hasOwn(config, 'efforts')) return []
  const efforts = config.efforts ?? null
  const path = `${runtime}.efforts`
  if (!isObject(efforts)) return [`${path}: ${OBJECT}`]
  return [
    ...unknownFields(efforts, path, ['agents', 'levels']),
    ...sectionErrors(efforts, 'agents', path, (_agent, value, at) =>
      typeof value === 'string' && EFFORT_LEVELS.includes(value) ? [] : [`${at}: nivel desconocido`],
    ),
    ...sectionErrors(efforts, 'levels', path, (level, value, at) =>
      EFFORT_LEVELS.includes(level) ? modelErrors(value, at) : [`${at}: nivel desconocido`],
    ),
  ]
}

/** Motivos `<ruta>: <motivo>` por los que `mapping` no es un mapping runtime -> {profiles, agents, efforts}. */
export function validateModelsMapping(mapping: Json): string[] {
  if (!isObject(mapping)) return [`.: ${OBJECT}`]
  return Object.entries(mapping).flatMap(([runtime, config]) => {
    if (!isRuntimeId(runtime)) return [`${runtime}: id de runtime invalido`]
    if (!isObject(config)) return [`${runtime}: ${OBJECT}`]
    return [
      ...unknownFields(config, runtime, ['profiles', 'agents', 'efforts']),
      ...sectionErrors(config, 'profiles', runtime, (profile, value, at) =>
        MODEL_PROFILES.includes(profile) ? modelErrors(value, at) : [`${at}: perfil desconocido`],
      ),
      ...sectionErrors(config, 'agents', runtime, (_agent, value, at) => modelErrors(value, at)),
      ...effortsErrors(config, runtime),
    ]
  })
}

type Mapping = { mapping: Json } | { error: string }

/** Mapping de `file`, ya validado. Una ruta omitida, inexistente o vacia equivale a no tener mapping. */
export function readModelsMapping(file: string): Mapping {
  if (file.length === 0) return { mapping: null }
  let text: string
  try {
    if (!statSync(file).isFile()) return { mapping: null }
    text = readFileSync(file, 'utf8')
  } catch {
    return { mapping: null }
  }
  if (text.length === 0) return { mapping: null }
  const parsed = parseStream(text)
  const [mapping] = parsed.values
  if (!parsed.clean || parsed.values.length !== 1 || mapping === undefined) {
    return { error: `${file}: no es JSON valido` }
  }
  const errors = validateModelsMapping(mapping)
  return errors.length > 0 ? { error: `${file}: ${errors.join('; ')}` } : { mapping }
}

/** `.a.b.c // empty` como cadena: vacio si falta, es `null` o `false`. */
function lookup(mapping: Json, ...keys: string[]): string {
  let current: Json = mapping
  for (const key of keys) {
    if (!isObject(current) || !Object.hasOwn(current, key)) return ''
    current = current[key] ?? null
  }
  return typeof current === 'string' ? current : ''
}

type Loaded = { adapter: RuntimeAdapter } | { error: string }

async function adapterOf(runtime: string, libDir: string): Promise<Loaded> {
  if (!isRuntimeId(runtime)) return { error: `runtime invalido: '${runtime}'` }
  const file = adapterPath(libDir, runtime)
  let exists = false
  try {
    exists = statSync(file).isFile()
  } catch {
    exists = false
  }
  if (!exists) return { error: `runtime '${runtime}' no tiene adaptador (${file})` }
  const adapter = await loadAdapter(libDir, runtime)
  if (adapter === null) return { error: `runtime '${runtime}': no se pudo cargar el adaptador (${file})` }
  return { adapter }
}

export interface ModelRequest {
  runtime: string
  agentId: string
  profile: string
  /** Override del llamador; gana a todo. */
  explicitModel?: string
  mappingFile?: string
  env?: NodeJS.ProcessEnv
  libDir?: string
}

export type ModelResolution = { model: string } | { error: string }

/**
 * Modelo de un agente: override explicito, mapping por agente, mapping por perfil, default del
 * adaptador y, si nada lo fija, cadena vacia (heredar).
 */
export async function resolveModel(request: ModelRequest): Promise<ModelResolution> {
  const { runtime, agentId, profile } = request
  const env = request.env ?? process.env
  if (!MODEL_PROFILES.includes(profile)) {
    return { error: `profile: '${profile}' no esta en el vocabulario fast|balanced|deep` }
  }
  const loaded = await adapterOf(runtime, request.libDir ?? runtimeLibDir(env))
  if ('error' in loaded) return loaded
  const explicit = request.explicitModel ?? ''
  if (explicit.length > 0) return { model: explicit }

  const read = readModelsMapping(request.mappingFile ?? '')
  if ('error' in read) return read
  const mapped =
    lookup(read.mapping, runtime, 'agents', agentId) || lookup(read.mapping, runtime, 'profiles', profile)
  if (mapped.length > 0) return { model: mapped }
  const fallback = loaded.adapter.defaultModel
  if (fallback === undefined) return { model: '' }
  const model = fallback(profile, env)
  if (model === null) return { error: `runtime_${runtime}_default_model: no acepta el perfil '${profile}'` }
  return { model }
}

export interface EffortRequest {
  runtime: string
  agentId: string
  /** Nivel neutral de fabrica del agente. */
  level: string
  mappingFile?: string
  env?: NodeJS.ProcessEnv
  libDir?: string
}

export type EffortResolution = { effort: string } | { error: string }

/**
 * Effort nativo de un agente. Nivel: `efforts.agents[<id>]` o el de fabrica. Valor nativo:
 * `efforts.levels[<nivel>]`, el default del adaptador y, si nada lo fija, cadena vacia (heredar).
 */
export async function resolveEffort(request: EffortRequest): Promise<EffortResolution> {
  const { runtime, agentId } = request
  const env = request.env ?? process.env
  if (!EFFORT_LEVELS.includes(request.level)) {
    return {
      error: `nivel de fabrica: '${request.level}' no esta en el vocabulario quick|light|standard|thorough|exhaustive`,
    }
  }
  const loaded = await adapterOf(runtime, request.libDir ?? runtimeLibDir(env))
  if ('error' in loaded) return loaded
  const read = readModelsMapping(request.mappingFile ?? '')
  if ('error' in read) return read

  const level = lookup(read.mapping, runtime, 'efforts', 'agents', agentId) || request.level
  const mapped = lookup(read.mapping, runtime, 'efforts', 'levels', level)
  if (mapped.length > 0) return { effort: mapped }
  const fallback = loaded.adapter.defaultEffort
  if (fallback === undefined) return { effort: '' }
  const effort = fallback(level, env)
  if (effort === null) return { error: `runtime_${runtime}_default_effort: no acepta el nivel '${level}'` }
  return { effort }
}
