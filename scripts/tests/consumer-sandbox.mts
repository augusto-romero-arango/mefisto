// Repos de consumidor de usar y tirar para los tests de los scripts que leen el config.

import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BASE_CONFIG = {
  projectName: 'Proyecto',
  namespacePrefix: 'Empresa.Proyecto',
  solutionFile: 'Proyecto.slnx',
  domainLabels: ['ventas', 'cobros'],
  infraResourceGroupPrefix: 'rg-proy',
  boundedContext: { name: 'Principal', domains: ['ventas', 'cobros'] },
}

export const CANONICAL_CONFIG = '.mefisto/harness.config.json'
export const LEGACY_CONFIG = '.claude/harness.config.json'
export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json'

export function configJson(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...BASE_CONFIG, ...extra })}\n`
}

/** Ruta de `rel` (escrita con `/`) dentro de `root`. */
export function pathIn(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

/** Escribe `content` en la ruta `rel` de `root`, creando sus carpetas. */
export function writeIn(root: string, rel: string, content: string): string {
  const path = pathIn(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** Repo git nuevo en `dir` con los archivos dados; devuelve su ruta real. */
export function initRepo(dir: string, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--quiet', dir])
  const root = realpathSync.native(dir)
  for (const [rel, content] of Object.entries(files)) writeIn(root, rel, content)
  return root
}

export interface Sink {
  out: string[]
  err: string[]
  io: { out: (line: string) => void; err: (line: string) => void }
}

/** Salida inyectable que guarda lo que el script imprime. */
export function sink(): Sink {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
}
