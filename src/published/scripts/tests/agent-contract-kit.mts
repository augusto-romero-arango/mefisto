// Piezas comunes de los tests de contrato de los agentes publicados: fuente neutral
// (`src/published/agents`), proyeccion Claude (`dist/claude/agents`), espejo raiz (`agents`),
// inventario de la distribucion y clausura de tooling.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { CliError } from '../../../../scripts/lib/cli.mts'
import {
  REPO_ROOT,
  assertAbsent,
  assertContains,
  bodyOf,
  frontmatterOf,
  linesOf,
  repoPath,
} from '../../../../scripts/tests/text-contract.mts'
import { TOOLING_CLOSURE_ASSETS, generatePublishedAdapters } from '../generate-published-adapters.mts'
import { validatePublishedArtifacts } from '../validate-published-artifacts.mts'

export const GUARD = '{{mefisto:assert-consumer-repo}}'
export const INVENTORY_FILE = '.mefisto-generated-assets.json'

/** Contenido de un archivo; vacio si no se puede leer, para que cada caso falle por separado. */
export function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Contenido de un archivo del repo, dado con `/` como separador; vacio si falta. */
export function repoText(relative: string): string {
  return readOrEmpty(repoPath(relative))
}

export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `true` si los dos archivos existen y tienen los mismos bytes. */
export function sameBytes(left: string, right: string): boolean {
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

export function sha256Of(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

/** Archivos regulares bajo `dir`, relativos a el y con `/`, ordenados. */
export function regularFilesUnder(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), relative)
      else if (entry.isFile()) found.push(relative)
    }
  }
  walk(dir, '')
  return found.sort()
}

/** Minusculas solo para ASCII, como `tr '[:upper:]' '[:lower:]'` con `LC_ALL=C`. */
export function lowerAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase())
}

/** Lineas del cuerpo, las que siguen al cierre del frontmatter; conserva las vacias del final. */
export function bodyLines(text: string): string[] {
  const lines = linesOf(text).slice(1)
  const close = lines.indexOf('---')
  return close === -1 ? [] : lines.slice(close + 1)
}

export type Metadata = Record<string, unknown>

/** Frontmatter JSON de una fuente publicada; vacio si no es un objeto JSON. */
export function metadataOf(text: string): Metadata {
  try {
    const parsed: unknown = JSON.parse(frontmatterOf(text))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Metadata) : {}
  } catch {
    return {}
  }
}

export interface MetadataExpectation {
  /** Campos cuyo valor debe ser exactamente este. */
  equal?: Metadata
  /** Claves que no pueden estar. */
  without?: string[]
  /** Lista exacta de claves, ordenada. */
  keys?: string[]
  /** Valores que `capabilities` debe incluir. */
  capabilities?: string[]
}

export function metadataMatches(metadata: Metadata, expectation: MetadataExpectation): boolean {
  const { equal = {}, without = [], keys, capabilities = [] } = expectation
  const declared = metadata.capabilities
  return (
    Object.entries(equal).every(([key, value]) => isDeepStrictEqual(metadata[key], value)) &&
    without.every((key) => !Object.hasOwn(metadata, key)) &&
    (keys === undefined || isDeepStrictEqual(Object.keys(metadata).sort(), keys)) &&
    capabilities.every((capability) => Array.isArray(declared) && declared.includes(capability))
  )
}

export interface Agent {
  id: string
  /** Rutas relativas al repo, con `/`. */
  sourcePath: string
  claudePath: string
  mirrorPath: string
  source: string
  claude: string
  mirror: string
  /** Cuerpo de la fuente neutral. */
  body: string
  metadata: Metadata
}

export function agent(id: string): Agent {
  const sourcePath = `src/published/agents/${id}.md`
  const claudePath = `dist/claude/agents/${id}.md`
  const mirrorPath = `agents/${id}.md`
  const source = repoText(sourcePath)
  return {
    id,
    sourcePath,
    claudePath,
    mirrorPath,
    source,
    claude: repoText(claudePath),
    mirror: repoText(mirrorPath),
    body: bodyOf(source),
    metadata: metadataOf(source),
  }
}

/** Marcador que el generador deja en la salida de un agente publicado. */
export function generatedMarker(id: string): string {
  return `<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/agents/${id}.md. No editar a mano. -->`
}

/** Caso con el mensaje de exito como nombre y el de fallo como diagnostico. */
export function check(pass: string, condition: () => boolean | Promise<boolean>, fail: string = pass): void {
  test(pass, async () => {
    assert.ok(await condition(), fail)
  })
}

export function contains(text: string, needle: string, message: string): void {
  test(message, () => {
    assertContains(text, needle, message)
  })
}

export function absent(text: string, needle: string, message: string): void {
  test(message, () => {
    assertAbsent(text, needle, message)
  })
}

/** `true` si el validador publicado acepta el archivo (ruta absoluta). */
export function sourceValidates(path: string): boolean {
  return validatePublishedArtifacts([path], REPO_ROOT).status === 0
}

export interface InventoryAsset {
  adapter?: string
  id?: string
  source?: string
  destination?: string
  mode?: string
  sha256?: string
}

export interface Inventory {
  schemaVersion?: number
  assets: InventoryAsset[]
}

/** Inventario de una distribucion; sin assets si falta o no es JSON. Por defecto, el de `dist/claude`. */
export function readInventory(path: string = repoPath(`dist/claude/${INVENTORY_FILE}`)): Inventory {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Inventory> | null
    return { ...parsed, assets: Array.isArray(parsed?.assets) ? parsed.assets : [] }
  } catch {
    return { assets: [] }
  }
}

export function inventoriesDestination(inventory: Inventory, destination: string): boolean {
  return inventory.assets.some((asset) => asset.destination === destination)
}

export interface GeneratorRun {
  status: number
  /** Lineas de divergencia de `--check` y el mensaje de error, si lo hubo. */
  output: string
}

async function runGenerator(check: boolean, outRoot: string, files: readonly string[]): Promise<GeneratorRun> {
  const lines: string[] = []
  try {
    const status = await generatePublishedAdapters({ check, outRoot, files, out: (line) => lines.push(line) })
    return { status, output: lines.join('\n') }
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    return { status: error.exitCode, output: [...lines, error.message].join('\n') }
  }
}

/** `generate-published-adapters --check` sobre el repo: `true` si la distribucion esta al dia. */
export async function distributionIsCurrent(): Promise<boolean> {
  return (await runGenerator(true, REPO_ROOT, [])).status === 0
}

/** Genera `sources` (relativas al repo) bajo `outRoot`, que nunca es el repo. */
export function generateInto(outRoot: string, sources: readonly string[]): Promise<GeneratorRun> {
  return runGenerator(false, outRoot, sources.map(repoPath))
}

/** `--check` de `sources` (relativas al repo) contra lo generado bajo `outRoot`. */
export function checkInto(outRoot: string, sources: readonly string[]): Promise<GeneratorRun> {
  return runGenerator(true, outRoot, sources.map(repoPath))
}

export interface ClosureAsset {
  source: string
  mode: string
}

/** Assets `ruta|modo` de la clausura de tooling, en el orden declarado. */
export function closureAssets(declared: readonly string[] = TOOLING_CLOSURE_ASSETS): ClosureAsset[] {
  return declared.flatMap((entry) => {
    const match = /^([^'|]+)\|(0644|0755)$/.exec(entry)
    return match === null ? [] : [{ source: match[1] ?? '', mode: match[2] ?? '' }]
  })
}
