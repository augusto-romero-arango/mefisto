// Corte del bloque '---' de un artefacto neutral: frontmatter y body.
//
// Gemela de `extract_frontmatter` y `extract_body` de `frontmatter.sh`.

export interface Extraction {
  /** 0 bloque delimitado, 1 la primera linea no es '---', 2 falta el cierre. */
  status: 0 | 1 | 2
  /** Lineas extraidas, cada una con su salto. */
  text: string
}

/** Lineas de un archivo: un salto final no abre una linea vacia mas. */
export function fileLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function join(lines: string[]): string {
  return lines.map((line) => `${line}\n`).join('')
}

/** Bloque entre la primera linea ('---') y la siguiente que sea exactamente '---'. */
export function extractFrontmatter(content: string): Extraction {
  const lines = fileLines(content)
  if (lines.length === 0) return { status: 2, text: '' }
  if (lines[0] !== '---') return { status: 1, text: '' }
  const close = lines.indexOf('---', 1)
  if (close === -1) return { status: 2, text: join(lines.slice(1)) }
  return { status: 0, text: join(lines.slice(1, close)) }
}

/** Todo lo que sigue a la linea de cierre del frontmatter. */
export function extractBody(content: string): Extraction {
  const lines = fileLines(content)
  if (lines.length === 0) return { status: 2, text: '' }
  if (lines[0] !== '---') return { status: 1, text: '' }
  const close = lines.indexOf('---', 1)
  if (close === -1) return { status: 2, text: '' }
  return { status: 0, text: join(lines.slice(close + 1)) }
}
