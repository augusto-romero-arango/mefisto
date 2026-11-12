// Consolidacion de `changelog.d/` y remedio del gate de neutralidad para la fase prepare del release.

import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bloque `[Unreleased]`: su encabezado y su cuerpo hasta la siguiente seccion `## [`. */
export const UNRELEASED_BLOCK = /^(##\s*\[Unreleased\][^\n]*\n)(.*?)(?=^##\s*\[|(?![\s\S]))/ms

const LINE_BREAK = /\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/
const SUBSECTION = /^###\s*([\p{L}\p{N}_]+)/u
const CATEGORY_HEADER = { added: 'Added', changed: 'Changed', fixed: 'Fixed', removed: 'Removed' } as const
type Category = keyof typeof CATEGORY_HEADER
const CATEGORIES = Object.keys(CATEGORY_HEADER) as Category[]
const ADR_TABLE_HEAD = '| Tema | ADR |\n|---|---|\n'

/** Lee un archivo de texto con los saltos de linea normalizados a `\n`. */
export function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')
}

/** Lineas de `text`, sin un elemento vacio final cuando termina en salto. */
export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fragmentNames(dir: string, suffix: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix) && !name.startsWith('.'))
    .sort()
}

function stripBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start++
  while (end > start && lines[end - 1]?.trim() === '') end--
  return lines.slice(start, end)
}

function isCategory(value: string | undefined): value is Category {
  return value !== undefined && value in CATEGORY_HEADER
}

/**
 * Vuelca los fragmentos `<issue>.<categoria>.md` de `changelog.d/` en las subsecciones de
 * `[Unreleased]` de `CHANGELOG.md` y los borra. Devuelve el mensaje de error, o `null`.
 */
export function consolidateChangelogFragments(repoRoot: string): string | null {
  const dir = join(repoRoot, 'changelog.d')
  if (!isDirectory(dir)) return null

  const buckets: Record<Category, string[]> = { added: [], changed: [], fixed: [], removed: [] }
  const consumed: string[] = []
  for (const name of fragmentNames(dir, '.md')) {
    if (name === 'README.md' || name.endsWith('.adr-index.md')) continue
    const category = /^\d+\.([a-z]+)\.md$/.exec(name)?.[1]
    if (!isCategory(category)) return `ERROR: fragmento de changelog con nombre invalido: ${name}`
    const path = join(dir, name)
    const body = readText(path).trim()
    if (body.length > 0) buckets[category].push(body)
    consumed.push(path)
  }
  if (consumed.length === 0) return null

  const changelogPath = join(repoRoot, 'CHANGELOG.md')
  const text = readText(changelogPath)
  const block = UNRELEASED_BLOCK.exec(text)
  if (block === null) return 'ERROR: no se encontro la seccion [Unreleased]'
  const header = block[1] ?? ''

  // Una subseccion repetida conserva solo las lineas de su ultima aparicion, y sale una vez por cada una.
  const existing = new Map<string, string[]>()
  const order: string[] = []
  let preamble: string[] = []
  let current: string | null = null
  let currentLines: string[] = []
  const close = (): void => {
    if (current === null) preamble = currentLines
    else existing.set(current, currentLines)
  }
  for (const line of splitLines(block[2] ?? '')) {
    const name = SUBSECTION.exec(line)?.[1]
    if (name === undefined) {
      currentLines.push(line)
      continue
    }
    close()
    current = name
    order.push(name)
    currentLines = []
  }
  close()

  preamble = stripBlankEdges(preamble)
  for (const [name, lines] of existing) existing.set(name, stripBlankEdges(lines))

  for (const category of CATEGORIES) {
    if (buckets[category].length === 0) continue
    const name = CATEGORY_HEADER[category]
    if (!order.includes(name)) {
      order.push(name)
      existing.set(name, [])
    }
    for (const entry of buckets[category]) existing.get(name)?.push(...splitLines(entry))
  }

  const lines = ['']
  if (preamble.length > 0) lines.push(...preamble, '')
  for (const name of order) lines.push(`### ${name}`, '', ...(existing.get(name) ?? []), '')
  const body = `${lines.join('\n').replace(/\n+$/, '')}\n\n`

  writeFileSync(changelogPath, text.slice(0, block.index) + header + body + text.slice(block.index + block[0].length))
  for (const path of consumed) rmSync(path)
  return null
}

/**
 * Anexa las filas de los fragmentos `<issue>.adr-index.md` al final de la tabla de
 * `docs/adr/INDICE-TEMATICO.md` y los borra. Devuelve el mensaje de error, o `null`.
 */
export function consolidateAdrIndexFragments(repoRoot: string): string | null {
  const dir = join(repoRoot, 'changelog.d')
  if (!isDirectory(dir)) return null
  const fragments = fragmentNames(dir, '.adr-index.md').map((name) => join(dir, name))
  const rows = fragments.flatMap((path) => splitLines(readText(path).trim()).filter((line) => line.trim() !== ''))
  if (rows.length === 0) return null

  const indexPath = join(repoRoot, 'docs', 'adr', 'INDICE-TEMATICO.md')
  const text = readText(indexPath)
  const head = text.indexOf(ADR_TABLE_HEAD)
  if (head === -1) return 'ERROR: no se encontro la tabla de indice de ADRs en docs/adr/INDICE-TEMATICO.md'
  const bodyStart = head + ADR_TABLE_HEAD.length
  const rest = text.slice(bodyStart)
  const bodyEnd = bodyStart + (/^(?!\|)/m.exec(rest)?.index ?? rest.length)

  writeFileSync(indexPath, text.slice(0, bodyEnd) + rows.map((row) => `${row}\n`).join('') + text.slice(bodyEnd))
  for (const path of fragments) rmSync(path)
  return null
}

const REMEDIES: readonly (readonly [string, string])[] = [
  [
    'R1',
    'R1: reformula la mencion (alias/id de modelo o clave de tool/permiso citada como texto crudo) en prosa neutral; solo como ultimo recurso, y solo si el contenido es correcto y permanente, registra una excepcion en la allowlist en un PR previo (MEF-ADR-0019 seccion E).',
  ],
  [
    'R2',
    'R2: reformula la mencion (invocacion directa de CLI citada como texto) en prosa neutral; solo como ultimo recurso, y solo si el contenido es correcto y permanente, registra una excepcion en la allowlist en un PR previo (MEF-ADR-0019 seccion E).',
  ],
  [
    'R3',
    'R3: reformula la mencion citando MEF-ADR-0050 en vez de nombrar la ruta o la variable de entorno de un runtime concreto; solo como ultimo recurso, y solo si el contenido es correcto y permanente, registra una excepcion en la allowlist en un PR previo (MEF-ADR-0019 seccion E).',
  ],
  [
    'adapters-check',
    'adapters-check: regenera los adaptadores con src/internal/scripts/generate-internal-adapters.mts (sin --check); su salida (.claude/{agents,commands}/) no se edita a mano -- se edita la fuente neutral de src/internal/{agents,commands}/ y se regenera.',
  ],
  [
    'published-adapters-check',
    'published-adapters-check: regenera la distribucion publicada con src/published/scripts/generate-published-adapters.mts (sin --check); su salida (dist/) no se edita a mano -- se edita la fuente publicada de src/published/ o src/runtime/ y se regenera.',
  ],
]

/**
 * Una linea de remedio por cada regla presente en la salida del gate de neutralidad, en orden
 * fijo; la regla de cada violacion es lo que sigue a su ultimo `: `.
 */
export function neutralityRemedy(gateOutput: string): string {
  const rules = new Set<string>()
  for (const line of gateOutput.split('\n')) {
    if (line.length === 0) continue
    const separator = line.lastIndexOf(': ')
    rules.add(separator === -1 ? line : line.slice(separator + 2))
  }
  const known = REMEDIES.filter(([rule]) => rules.has(rule))
  const unknown = [...rules].filter((rule) => !REMEDIES.some(([name]) => name === rule))
  return [
    ...known.map(([, remedy]) => remedy),
    ...unknown.map(
      (rule) =>
        `${rule}: regla no reconocida por este remedio -- revisa la cabecera de src/internal/scripts/mefisto-neutrality-gate.mts.`,
    ),
  ].join('\n')
}
