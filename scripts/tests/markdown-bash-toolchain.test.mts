// Los bloques de bash de comandos, agentes y skills corren en Git Bash en Windows (MEF-ADR-0057,
// decision 9): no pueden invocar `jq` ni `python3`, que Git for Windows no trae.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { REPO_ROOT } from './text-contract.mts'

const SOURCES = [
  'src/published/commands',
  'src/published/agents',
  'src/internal/commands',
  'src/internal/agents',
  'skills',
  'src/internal/skills',
]

const FENCE = /^\s*```+\s*([A-Za-z0-9_-]*)\s*$/
const SHELL = new Set(['bash', 'sh', 'shell'])
// `gh ... --jq` no cuenta: el filtro lo ejecuta `gh`.
const FORBIDDEN = /(^|[^\w.-])(jq|python3?)(\s|$)/

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** Lineas `archivo:numero: texto` de los bloques de shell de `text` que invocan una herramienta vetada. */
function forbiddenShellLines(name: string, text: string): string[] {
  const found: string[] = []
  let language: string | null = null
  for (const [index, line] of text.split('\n').entries()) {
    const fence = FENCE.exec(line)
    if (fence !== null) {
      language = language === null ? (fence[1] ?? '') : null
    } else if (language !== null && SHELL.has(language) && FORBIDDEN.test(line)) {
      found.push(`${name}:${index + 1}: ${line.trim()}`)
    }
  }
  return found
}

test('el detector ve jq y python3 en un bloque de shell, y no en prosa, yaml ni --jq', () => {
  const text = [
    'Prosa que nombra jq y python3.',
    '```bash',
    'X=$(jq -r .a f.json)',
    'gh api x --jq .a',
    'cat f | python3 -m json.tool',
    '   echo "$A" | jq .',
    '```',
    '```yaml',
    'run: jq -r .a f.json',
    '```',
    '   ```bash',
    '   jq empty f.json',
    '   ```',
  ].join('\n')
  assert.deepEqual(forbiddenShellLines('x.md', text), [
    'x.md:3: X=$(jq -r .a f.json)',
    'x.md:5: cat f | python3 -m json.tool',
    'x.md:6: echo "$A" | jq .',
    'x.md:12: jq empty f.json',
  ])
})

for (const source of SOURCES) {
  test(`${source}: ningun bloque de bash invoca jq ni python3`, () => {
    const found = markdownFiles(join(REPO_ROOT, source)).flatMap((file) =>
      forbiddenShellLines(relative(REPO_ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8')),
    )
    assert.deepEqual(found, [], 'usa node "{{mefisto:package-root}}/scripts/json-value.mts" en su lugar')
  })
}
