// Adaptador Claude Code de la interfaz publicada.

import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { equals, get, isObject, parseStream } from '../../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../../scripts/lib/jq-values.mts'
import { renderClaude } from '../lib/adapter-claude.mts'
import { AdapterError } from '../lib/published-adapter.mts'
import type { AdapterContext, PublishedAdapter } from '../lib/published-adapter.mts'
import { jqRegExp } from '../lib/published-schema.mts'
import { isFile, isSymlink } from '../lib/published-source.mts'

const SEMVER = jqRegExp(
  '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$',
)
const COMMIT = jqRegExp('^[0-9a-f]{40}$')
const IDENTITY_KEYS = ['commit', 'schemaVersion', 'version']

const MANIFEST_ASSET = {
  id: 'mefisto-manifest',
  source: 'src/published/release-identity.json',
  destination: 'mefisto-manifest.json',
  mode: '0644',
}

function readJson(path: string): Json | undefined {
  const parsed = parseStream(readFileSync(path, 'utf8'))
  return parsed.clean && parsed.values.length === 1 ? parsed.values[0] : undefined
}

/** Manifiesto Claude derivado de la identidad neutral de release, que debe coincidir con `plugin.json`. */
export function releaseManifest(identityPath: string, repoRoot: string): string {
  const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json')
  if (!isFile(identityPath) || isSymlink(identityPath)) {
    throw new AdapterError('release-identity.json: fuente ausente o no regular')
  }
  if (!isFile(pluginPath) || isSymlink(pluginPath)) {
    throw new AdapterError('plugin.json: fuente ausente o no regular')
  }
  const identity = readJson(identityPath)
  if (
    !isObject(identity) ||
    !equals(Object.keys(identity).sort(), IDENTITY_KEYS) ||
    identity.schemaVersion !== 1 ||
    typeof identity.version !== 'string' ||
    !SEMVER.test(identity.version) ||
    typeof identity.commit !== 'string' ||
    !COMMIT.test(identity.commit)
  ) {
    throw new AdapterError('release-identity.json: schema, version o commit invalidos')
  }
  const version = identity.version.replace(/\n+$/, '')
  const commit = identity.commit.replace(/\n+$/, '')
  const plugin = readJson(pluginPath)
  const pluginVersion = isObject(plugin) ? get(plugin, 'version') : null
  if (typeof pluginVersion !== 'string' || pluginVersion.replace(/\n+$/, '') !== version) {
    throw new AdapterError('release-identity.json: version distinta de .claude-plugin/plugin.json')
  }
  return `${JSON.stringify({ schemaVersion: 1, runtime: 'claude', version, commit })}\n`
}

function renderedPath(relSource: string): string {
  for (const kind of ['agents', 'commands']) {
    if (relSource.startsWith(`src/published/${kind}/`) && relSource.endsWith('.md')) {
      return `${kind}/${posix.basename(relSource)}`
    }
  }
  throw new AdapterError(`${relSource}: path: fuente publicada desconocida`)
}

export function createAdapter(context: AdapterContext): PublishedAdapter {
  return {
    // Identidad historica en el inventario de dist/: cambiarla altera la salida generada.
    name: 'adapter-claude.sh',
    root: () => 'dist/claude',
    path: renderedPath,
    render: (source, marker) => renderClaude(source, marker, context.repoRoot),
    assets: () => [{ ...MANIFEST_ASSET }],
    renderAsset: (id, source) => {
      if (id !== MANIFEST_ASSET.id) throw new AdapterError(`render-asset: asset desconocido: ${id}`)
      return releaseManifest(source, context.repoRoot)
    },
  }
}
