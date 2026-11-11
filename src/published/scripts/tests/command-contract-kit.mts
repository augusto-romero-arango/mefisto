// Piezas comunes de los tests de contrato de los comandos publicados: la fuente neutral
// `src/published/commands/<id>.md`, su proyeccion `dist/claude/commands/<id>.md` y su espejo
// `commands/<id>.md`.

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

import { CliError } from '../../../../scripts/lib/cli.mts'
import {
  bodyOf,
  frontmatterOf,
  lineOf,
  matchingLines,
  repoPath,
} from '../../../../scripts/tests/text-contract.mts'
import { generatePublishedAdapters, parseArgs } from '../generate-published-adapters.mts'
import { chomp, isFile } from '../lib/published-source.mts'
import { validatePublishedArtifacts } from '../validate-published-artifacts.mts'

const INVENTORY = 'dist/claude/.mefisto-generated-assets.json'

export const CONSUMER_GUARD = '{{mefisto:assert-consumer-repo}}'

/** Texto de un archivo del repo sin sus saltos finales; vacio si no se puede leer. */
export function repoText(relative: string): string {
  try {
    return chomp(readFileSync(repoPath(relative), 'utf8'))
  } catch {
    return ''
  }
}

export function repoFileExists(relative: string): boolean {
  return isFile(repoPath(relative))
}

/** `true` si los dos archivos del repo se pueden leer y tienen los mismos bytes. */
export function sameBytes(left: string, right: string): boolean {
  try {
    return readFileSync(repoPath(left)).equals(readFileSync(repoPath(right)))
  } catch {
    return false
  }
}

/** `true` si el archivo del repo existe y es ejecutable; Windows no tiene bit de ejecucion. */
export function isExecutable(relative: string): boolean {
  try {
    const stats = statSync(repoPath(relative))
    return process.platform === 'win32' || (stats.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export interface CommandContract {
  id: string
  /** Rutas relativas al repo, con `/`. */
  sourcePath: string
  claudePath: string
  mirrorPath: string
  /** Fuente neutral completa, su frontmatter y su cuerpo. */
  source: string
  metadata: string
  body: string
  claude: string
  mirror: string
}

export function commandContract(id: string): CommandContract {
  const sourcePath = `src/published/commands/${id}.md`
  const claudePath = `dist/claude/commands/${id}.md`
  const mirrorPath = `commands/${id}.md`
  const source = repoText(sourcePath)
  return {
    id,
    sourcePath,
    claudePath,
    mirrorPath,
    source,
    metadata: frontmatterOf(source),
    body: bodyOf(source),
    claude: repoText(claudePath),
    mirror: repoText(mirrorPath),
  }
}

export function metadataOf(command: CommandContract): Record<string, unknown> {
  return JSON.parse(command.metadata) as Record<string, unknown>
}

/** Lo que sigue a la primera aparicion de `needle`; el texto entero si no aparece. */
export function afterFirst(text: string, needle: string): string {
  const at = text.indexOf(needle)
  return at === -1 ? text : text.slice(at + needle.length)
}

/** Lo que precede a la primera aparicion de `needle`; el texto entero si no aparece. */
export function beforeFirst(text: string, needle: string): string {
  const at = text.indexOf(needle)
  return at === -1 ? text : text.slice(0, at)
}

/** Las lineas que casan, juntas, como la salida de `grep`. */
export function linesWith(text: string, pattern: string | RegExp): string {
  return matchingLines(text, pattern)
    .map((line) => line.text)
    .join('\n')
}

export function lineCount(text: string, pattern: string | RegExp): number {
  return matchingLines(text, pattern).length
}

/** Numero de la unica linea que contiene `needle`; `NaN`, que no ordena con nada, si no es una sola. */
export function soleLine(text: string, needle: string): number {
  const lines = matchingLines(text, needle)
  return lines.length === 1 ? (lines[0]?.number ?? Number.NaN) : Number.NaN
}

/** `true` si todos son numeros de linea (desde 1) y cada uno es mayor que el anterior. */
export function ascending(...lines: number[]): boolean {
  return lines.every((line, index) => line > 0 && (index === 0 || line > (lines[index - 1] ?? 0)))
}

/** Marcadores que faltan o cuya primera linea no queda despues de la del marcador anterior. */
export function misplacedLines(text: string, markers: readonly string[]): string[] {
  const misplaced: string[] = []
  let previous = 0
  for (const marker of markers) {
    const line = lineOf(text, marker)
    if (line <= previous) misplaced.push(marker)
    if (line > 0) previous = line
  }
  return misplaced
}

/** Marcadores que faltan o cuya primera aparicion no queda despues de la del marcador anterior. */
export function misplacedOffsets(text: string, markers: readonly string[]): string[] {
  const misplaced: string[] = []
  let previous = -1
  for (const marker of markers) {
    const at = text.indexOf(marker)
    if (at <= previous) misplaced.push(marker)
    previous = at
  }
  return misplaced
}

/** Las cadenas que aparecen como valor en cualquier nivel de `value`, como `.. | strings` de jq. */
export function jsonStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(jsonStrings)
}

export interface InventoryAsset {
  source: string
  destination: string
  mode: string
  sha256: string
}

export function inventoryText(): string {
  return repoText(INVENTORY)
}

export function inventoryJson(): unknown {
  return JSON.parse(readFileSync(repoPath(INVENTORY), 'utf8'))
}

export function inventoryAssets(): InventoryAsset[] {
  return (inventoryJson() as { assets: InventoryAsset[] }).assets
}

export function inventoryHasDestination(destination: string): boolean {
  return inventoryAssets().some((asset) => asset.destination === destination)
}

/** Registra un caso: pasa si `holds` devuelve `true`; `failure` es el mensaje del fallo. */
export function check(name: string, holds: () => boolean, failure: string = name): void {
  test(name, () => {
    assert.ok(holds(), failure)
  })
}

export function contains(text: string, needle: string, name: string): void {
  check(name, () => text.includes(needle))
}

export function absent(text: string, needle: string, name: string): void {
  check(name, () => !text.includes(needle))
}

/** Un caso `absent` por cada token, con el nombre que arma `name`. */
export function absentAll(text: string, needles: readonly string[], name: (needle: string) => string): void {
  for (const needle of needles) absent(text, needle, name(needle))
}

/** Un caso: la primera linea de cada marcador queda despues de la del marcador anterior. */
export function linesInOrder(
  text: string,
  markers: readonly string[],
  name: string,
  failure = 'orden de pasos invalido',
): void {
  test(name, () => {
    assert.deepEqual(misplacedLines(text, markers), [], failure)
  })
}

export function sourceValidates(command: CommandContract): void {
  check(
    'la fuente valida',
    () => validatePublishedArtifacts([repoPath(command.sourcePath)]).status === 0,
    'la fuente no valida',
  )
}

/** El guard del consumidor esta en una sola linea de la fuente, antes de la primera que casa `operation`. */
export function guardPrecedesOperation(command: CommandContract, operation: RegExp): void {
  check(
    'guard precede cualquier operacion',
    () => ascending(soleLine(command.source, CONSUMER_GUARD), lineOf(command.source, operation)),
    'guard no precede las operaciones',
  )
}

/** La metadata es un comando con ese perfil y esos argumentos, y no trae ninguna otra clave. */
export function hasExactMetadata(
  command: CommandContract,
  expected: { profile: string; arguments?: string },
  name: string,
  failure = 'metadata neutral invalida',
): void {
  test(name, () => {
    const metadata = metadataOf(command)
    const keys = ['description', 'id', 'kind', 'profile']
    if (expected.arguments !== undefined) keys.unshift('arguments')
    assert.deepEqual(
      {
        kind: metadata.kind,
        id: metadata.id,
        profile: metadata.profile,
        arguments: metadata.arguments,
        keys: Object.keys(metadata).sort(),
      },
      { kind: 'command', id: command.id, profile: expected.profile, arguments: expected.arguments, keys },
      failure,
    )
  })
}

export function claudeOutputExists(command: CommandContract): void {
  check(
    `existe ${command.claudePath}`,
    () => repoFileExists(command.claudePath),
    `falta ${command.claudePath}`,
  )
}

export function mirrorMatches(
  command: CommandContract,
  name = 'mirror Claude coincide byte a byte',
  failure = 'mirror Claude diverge',
): void {
  check(name, () => sameBytes(command.mirrorPath, command.claudePath), failure)
}

export function generatorIsUpToDate(): void {
  test('generate-published-adapters --check esta al dia', async () => {
    let status: number
    try {
      status = await generatePublishedAdapters({ ...parseArgs(['--check']), out: () => {} })
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      status = error.exitCode
    }
    assert.equal(status, 0, 'generate-published-adapters --check detecto divergencias')
  })
}
