// Rutas y listados de la fuente neutral: mismo orden en cualquier plataforma (bytes, como
// `find | sort` bajo LC_ALL=C) y siempre con `/`, porque esas rutas acaban en el marcador de
// los archivos generados.

import { readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { sep } from 'node:path'

export function toPosix(path: string): string {
  return sep === '\\' ? path.replaceAll('\\', '/') : path
}

/** Ruta relativa a `root` si `file` cae debajo; si no, `file` tal cual. */
export function stripRoot(file: string, root: string): string {
  const path = toPosix(file)
  const prefix = `${toPosix(root)}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Entradas bajo `dirs` (recursivo, sin seguir enlaces) que `accept` admite, ordenadas por los
 * bytes de su ruta completa. Un directorio que no existe no aporta nada.
 */
export function findSorted(dirs: string[], accept: (entry: Dirent) => boolean): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`
      if (accept(entry)) found.push(path)
      if (entry.isDirectory()) walk(path)
    }
  }
  for (const dir of dirs) walk(toPosix(dir))
  return found.sort(compareBytes)
}
