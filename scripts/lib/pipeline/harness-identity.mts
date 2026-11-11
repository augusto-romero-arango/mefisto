// Version e identidad de la release de Mefisto que corre un pipeline. Se leen del paquete donde
// vive este modulo, no del cwd del pipeline, que es la raiz del consumidor.
//
// Gemela de `_pc_script_dir`, `get_harness_version` y `get_harness_identity_json` de
// `_pipeline-common.sh`: mientras tengan llamadores en bash, un cambio va en los dos lados.

import { existsSync, lstatSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chomp, rawField } from '../azure-cli.mts'
import { dump } from '../jq-values.mts'
import { isObject, readJsonFile } from '../plugin-scopes.mts'

/** Directorio `scripts/` del plugin, sea cual sea la copia instalada desde la que se cargo este modulo. */
export function pipelineScriptsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** `version` de `.claude-plugin/plugin.json`; vacia si el archivo falta, no es JSON o no la declara. */
export function getHarnessVersion(scriptsDir: string = pipelineScriptsDir()): string {
  const version = chomp(rawField(readJsonFile(join(scriptsDir, '..', '.claude-plugin', 'plugin.json')), 'version'))
  return version === 'null' ? '' : version
}

export type IdentityState = 'complete' | 'metadata_missing' | 'metadata_invalid'

/** Las claves son las del JSON que persisten los pipelines y leen los mods. */
export interface HarnessIdentity {
  harness_version: string | null
  harness_commit: string | null
  identity_state: IdentityState
}

// El `$` de jq admite un salto de linea final, que la gemela recorta al capturar el valor.
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.-]+)?\n?$/
const COMMIT = /^[0-9a-f]{40}\n?$/

function isRegularFile(path: string): boolean {
  try {
    return !lstatSync(path).isSymbolicLink() && statSync(path).isFile()
  } catch {
    return false
  }
}

function manifestIdentity(path: string, expectedRuntime: string): { version: string; commit: string } | null {
  if (!isRegularFile(path)) return null
  const manifest = readJsonFile(path)
  if (!isObject(manifest)) return null
  const { schemaVersion, runtime, version, commit } = manifest
  if (schemaVersion !== 1) return null
  if (typeof runtime !== 'string' || (expectedRuntime.length > 0 && runtime !== expectedRuntime)) return null
  if (typeof version !== 'string' || !SEMVER.test(version)) return null
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null
  return { version: chomp(version), commit: chomp(commit) }
}

/**
 * Identidad segun `mefisto-manifest.json`, el manifiesto generado de la distribucion. Si falta,
 * es invalido o es de otro runtime que `expectedRuntime`, no se infiere de Git ni de `plugin.json`.
 */
export function getHarnessIdentity(
  expectedRuntime = '',
  scriptsDir: string = pipelineScriptsDir(),
): HarnessIdentity {
  const manifest = join(scriptsDir, '..', 'mefisto-manifest.json')
  const found = manifestIdentity(manifest, expectedRuntime)
  if (found !== null) {
    return { harness_version: found.version, harness_commit: found.commit, identity_state: 'complete' }
  }
  return {
    harness_version: null,
    harness_commit: null,
    identity_state: existsSync(manifest) ? 'metadata_invalid' : 'metadata_missing',
  }
}

/** JSON compacto de la identidad, con las claves en el orden del contrato. */
export function harnessIdentityJson(identity: HarnessIdentity): string {
  return dump({
    harness_version: identity.harness_version,
    harness_commit: identity.harness_commit,
    identity_state: identity.identity_state,
  })
}
