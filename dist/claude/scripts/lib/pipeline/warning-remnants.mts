// Seccion "Warnings remanentes" del cuerpo del PR (issue #2408, MEF-ADR-0056).

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OWN_ISSUE = /^#[0-9]+$/
const BARE_NUMBER = /^[0-9]+$/
const OTHER_REPO_ISSUE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/

/** Referencias distintas de `content`, en orden de aparicion: `#N`, `N` (sale como `#N`) y `owner/repo#N`. */
export function warningRemnantRefs(content: string): string[] {
  const refs = new Set<string>()
  for (const raw of content.split('\n')) {
    const line = raw.replaceAll('\r', '').replace(/^[ \t]+|[ \t]+$/g, '')
    if (OWN_ISSUE.test(line) || OTHER_REPO_ISSUE.test(line)) refs.add(line)
    else if (BARE_NUMBER.test(line)) refs.add(`#${line}`)
  }
  return [...refs]
}

/**
 * La seccion, con una linea `- Relacionado: <ref>` por referencia de
 * `<worktree>/.mefisto/pipeline/warnings-remanentes.txt`; vacia sin archivo o sin referencias.
 */
export function renderWarningRemnantsSection(worktree: string): string {
  const file = join(worktree, '.mefisto', 'pipeline', 'warnings-remanentes.txt')
  let content: string
  try {
    if (!statSync(file).isFile()) return ''
    content = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  const refs = warningRemnantRefs(content)
  if (refs.length === 0) return ''
  return `## Warnings remanentes\n\n${refs.map((ref) => `- Relacionado: ${ref}\n`).join('')}\n`
}
