// Comprueba que un directorio es la raiz de un paquete Claude de Mefisto: lo invoca el preambulo
// que antepone el adaptador a cada comando y agente, antes de fijar MEFISTO_PACKAGE_ROOT.
//
// Uso: node verify-package-root.mts <raiz>
// Sale con 0 si `<raiz>/.claude-plugin/plugin.json` y `<raiz>/mefisto-manifest.json` describen el
// mismo paquete `mefisto` para el runtime `claude`; con 1 en cualquier otro caso. No imprime nada.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isEntryPoint } from './lib/cli.mts'

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?\n?$/
const COMMIT = /^[0-9a-f]{40}\n?$/
const MANIFEST_KEYS = ['commit', 'runtime', 'schemaVersion', 'version']

function readObject(path: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function verifyPackageRoot(root: string): boolean {
  const plugin = readObject(join(root, '.claude-plugin', 'plugin.json'))
  if (plugin === null || plugin.name !== 'mefisto') return false
  const version = plugin.version
  if (typeof version !== 'string' || !SEMVER.test(version)) return false

  const manifest = readObject(join(root, 'mefisto-manifest.json'))
  if (manifest === null) return false
  const keys = Object.keys(manifest).sort()
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== MANIFEST_KEYS[index])) return false
  return (
    manifest.schemaVersion === 1 &&
    manifest.runtime === 'claude' &&
    manifest.version === version &&
    typeof manifest.commit === 'string' &&
    COMMIT.test(manifest.commit)
  )
}

if (isEntryPoint(import.meta.url)) {
  const root = process.argv[2] ?? ''
  process.exit(root.length > 0 && verifyPackageRoot(root) ? 0 : 1)
}
