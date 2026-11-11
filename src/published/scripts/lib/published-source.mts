// Lectura de las fuentes neutrales publicadas (`src/published/{agents,commands}/*.md`): lineas,
// frontmatter, cuerpo, listado y rutas relativas al repo.

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parseStream } from '../../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../../scripts/lib/jq-values.mts'

/** Quita los saltos finales, como la sustitucion de comandos de un shell. */
export function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

/** Lineas del texto; el salto final no abre una linea vacia. */
export function sourceLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Indice de la linea `---` que cierra el frontmatter (nunca la primera), o -1. */
export function closingIndex(lines: readonly string[]): number {
  return lines.findIndex((line, index) => index > 0 && line === '---')
}

export interface Frontmatter {
  status: 'ok' | 'ausente' | 'sin-cierre'
  text: string
}

/** Bloque entre el `---` de la primera linea y el siguiente. */
export function extractFrontmatter(lines: readonly string[]): Frontmatter {
  if (lines.length > 0 && lines[0] !== '---') return { status: 'ausente', text: '' }
  const end = closingIndex(lines)
  if (end === -1) return { status: 'sin-cierre', text: chomp(lines.slice(1).join('\n')) }
  return { status: 'ok', text: chomp(lines.slice(1, end).join('\n')) }
}

/** El unico valor JSON de `text`, o `null` si no es JSON valido o no trae exactamente un valor. */
export function parseSingleJson(text: string): { value: Json } | null {
  const parsed = parseStream(text)
  const [value] = parsed.values
  return parsed.clean && parsed.values.length === 1 && value !== undefined ? { value } : null
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** Orden por bytes, como `sort` con `LC_ALL=C`. */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function walk(dir: string, visit: (path: string, isRegular: boolean) => void): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    visit(path, entry.isFile())
    if (entry.isDirectory()) walk(path, visit)
  }
}

/** Archivos regulares y enlaces bajo `dir`, sin seguir enlaces, en orden por bytes. */
export function filesAndLinksUnder(dir: string): string[] {
  const found: string[] = []
  walk(dir, (path, isRegular) => {
    if (isRegular || isSymlink(path)) found.push(path)
  })
  return found.sort((a, b) => byteCompare(toPosix(a), toPosix(b)))
}

/** Los `*.md` de las fuentes publicadas en orden por bytes; con `onlyFiles`, solo archivos regulares. */
export function listPublishedSources(repoRoot: string, onlyFiles: boolean): string[] {
  const found: string[] = []
  for (const kind of ['agents', 'commands']) {
    walk(join(repoRoot, 'src', 'published', kind), (path, isRegular) => {
      if (path.endsWith('.md') && (isRegular || !onlyFiles)) found.push(path)
    })
  }
  return found.sort((a, b) => byteCompare(toPosix(a), toPosix(b)))
}

/** `true` si `path` queda estrictamente dentro de `root`. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Ruta con su carpeta resuelta a la real; la propia entrada no se sigue. `null` si la carpeta no existe. */
export function physicalPath(file: string): string | null {
  const absolute = resolve(file)
  try {
    return join(realpathSync.native(dirname(absolute)), basename(absolute))
  } catch {
    return null
  }
}

/** `file` relativo a `repoRoot` y con `/` si es una ruta absoluta dentro del repo; si no, tal cual. */
export function relativeToRepo(repoRoot: string, file: string): string {
  if (!isAbsolute(file)) return toPosix(file)
  for (const candidate of [file, physicalPath(file)]) {
    if (candidate !== null && isInside(repoRoot, candidate)) return toPosix(relative(repoRoot, candidate))
  }
  return file
}
