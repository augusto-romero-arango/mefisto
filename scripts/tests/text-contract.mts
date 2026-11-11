// Lectura de archivos del repo y extraccion de texto para los tests de contrato de prosa
// (instrucciones de agentes, comandos, plantillas embebidas, documentacion).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Ruta absoluta de un archivo del repo, dado con `/` como separador. */
export function repoPath(relative: string): string {
  return join(REPO_ROOT, ...relative.split('/'))
}

export function readRepoFile(relative: string): string {
  return readFileSync(repoPath(relative), 'utf8')
}

/** Lineas de un texto: un salto final no abre una linea vacia mas. */
export function linesOf(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export interface NumberedLine {
  /** Numero de linea, desde 1. */
  number: number
  text: string
}

function matcher(pattern: string | RegExp): (line: string) => boolean {
  if (typeof pattern === 'string') return (line) => line.includes(pattern)
  return (line) => {
    pattern.lastIndex = 0
    return pattern.test(line)
  }
}

/** Lineas que casan, como `grep -n`: una cadena casa por subcadena; una regex, linea por linea. */
export function matchingLines(text: string, pattern: string | RegExp): NumberedLine[] {
  const matches = matcher(pattern)
  return linesOf(text)
    .map((line, index) => ({ number: index + 1, text: line }))
    .filter((line) => matches(line.text))
}

/** Numero (desde 1) de la primera linea que casa, o 0 si ninguna casa. */
export function lineOf(text: string, pattern: string | RegExp): number {
  return matchingLines(text, pattern)[0]?.number ?? 0
}

/** Texto desde la primera linea que casa, incluida; vacio si ninguna casa. */
export function fromLine(text: string, pattern: string | RegExp): string {
  const first = lineOf(text, pattern)
  return first === 0 ? '' : linesOf(text).slice(first - 1).join('\n')
}

/** Frontmatter: lo que sigue a la primera linea hasta la siguiente que sea exactamente `---`. */
export function frontmatterOf(text: string): string {
  const lines = linesOf(text).slice(1)
  const close = lines.indexOf('---')
  return (close === -1 ? lines : lines.slice(0, close)).join('\n')
}

/** Cuerpo: lo que sigue a la linea que cierra el frontmatter; vacio si no cierra. */
export function bodyOf(text: string): string {
  const lines = linesOf(text).slice(1)
  const close = lines.indexOf('---')
  return close === -1 ? '' : lines.slice(close + 1).join('\n')
}

/**
 * Seccion markdown desde la linea `heading` (por ejemplo `## Paso 2`) hasta el siguiente
 * encabezado del mismo nivel o superior. Un `#` dentro de un bloque cercado no cuenta.
 */
export function sectionOf(text: string, heading: string): string {
  const lines = linesOf(text)
  const start = lines.indexOf(heading)
  const level = /^#+/.exec(heading)?.[0].length ?? 0
  if (start === -1 || level === 0) return ''
  const closing = new RegExp(`^#{1,${level}} `)
  let fenced = false
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('```')) fenced = !fenced
    else if (!fenced && closing.test(line)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/**
 * Contenido de los bloques cercados que abren con la linea ```` ```lang ```` y cierran con
 * ```` ``` ````, en orden. Un bloque sin cierre no se devuelve.
 */
export function fencedBlocks(text: string, lang: string): string[] {
  const blocks: string[] = []
  let current: string[] | null = null
  for (const line of linesOf(text)) {
    if (line === `\`\`\`${lang}`) current = []
    else if (line === '```') {
      if (current !== null) blocks.push(current.join('\n'))
      current = null
    } else current?.push(line)
  }
  return blocks
}

/**
 * Rangos de lineas como `awk '/start/,/end/'`: cada uno va de una linea que casa `start` a la
 * siguiente que casa `end` (puede ser la misma), ambas incluidas; sin cierre llega al final.
 */
export function lineRanges(text: string, start: RegExp, end: RegExp): string[] {
  const opens = matcher(start)
  const closes = matcher(end)
  const ranges: string[] = []
  let current: string[] | null = null
  for (const line of linesOf(text)) {
    if (current === null) {
      if (!opens(line)) continue
      current = []
    }
    current.push(line)
    if (closes(line)) {
      ranges.push(current.join('\n'))
      current = null
    }
  }
  if (current !== null) ranges.push(current.join('\n'))
  return ranges
}

/** Texto desde la primera aparicion de `start` hasta la primera de `end` que le sigue, excluida. */
export function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  assert.notEqual(from, -1, `no se encontro el inicio: ${start}`)
  const to = text.indexOf(end, from)
  assert.notEqual(to, -1, `no se encontro el final: ${end}`)
  return text.slice(from, to)
}

/** Apariciones de `needle` sin solaparse. */
export function countOccurrences(text: string, needle: string): number {
  return needle.length === 0 ? 0 : text.split(needle).length - 1
}

export function assertContains(text: string, needle: string, message?: string): void {
  assert.ok(text.includes(needle), message ?? `falta el texto esperado: ${needle}`)
}

export function assertAbsent(text: string, needle: string, message?: string): void {
  assert.ok(!text.includes(needle), message ?? `aparece un texto que no deberia: ${needle}`)
}
