import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  REPO_ROOT,
  assertAbsent,
  assertContains,
  bodyOf,
  countOccurrences,
  fencedBlocks,
  fromLine,
  frontmatterOf,
  lineOf,
  lineRanges,
  linesOf,
  matchingLines,
  readRepoFile,
  repoPath,
  sectionOf,
  sliceBetween,
} from './text-contract.mts'

const DOCUMENT = [
  '---',
  'name: ejemplo',
  'tools: Read, Bash',
  '---',
  '',
  '# Titulo',
  '',
  '## Paso 1',
  'Lee el config.',
  '```bash',
  '# comentario, no encabezado',
  'jq -r .a "$CONFIG"',
  '```',
  '### Detalle',
  'Mas texto.',
  '## Paso 2',
  '```yaml',
  'on: push',
  '```',
  '```bash',
  'echo fin',
  '```',
  '',
].join('\n')

test('repoPath y readRepoFile resuelven desde la raiz del repo', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'AGENTS.md')), true)
  assert.equal(repoPath('scripts/tests/text-contract.mts'), join(REPO_ROOT, 'scripts', 'tests', 'text-contract.mts'))
  assert.match(readRepoFile('CLAUDE.md'), /^@AGENTS\.md$/m)
})

test('linesOf no abre una linea vacia por el salto final', () => {
  assert.deepEqual(linesOf(''), [])
  assert.deepEqual(linesOf('a\nb\n'), ['a', 'b'])
  assert.deepEqual(linesOf('a\n\nb'), ['a', '', 'b'])
  assert.deepEqual(linesOf('a\n\n'), ['a', ''])
})

test('matchingLines numera desde 1 y casa por subcadena o por regex', () => {
  assert.deepEqual(matchingLines(DOCUMENT, '## Paso'), [
    { number: 8, text: '## Paso 1' },
    { number: 16, text: '## Paso 2' },
  ])
  assert.deepEqual(
    matchingLines(DOCUMENT, /^```bash$/g).map((line) => line.number),
    [10, 20],
  )
  assert.deepEqual(matchingLines(DOCUMENT, 'ausente'), [])
  assert.deepEqual(matchingLines('a.b\naxb\n', /a\.b/), [{ number: 1, text: 'a.b' }])
})

test('una regex no casa a traves de un salto de linea', () => {
  assert.deepEqual(matchingLines('jq -r\n.claude/x\n', /jq.*\.claude/s), [])
})

test('lineOf da la primera linea que casa, o 0', () => {
  assert.equal(lineOf(DOCUMENT, 'jq -r'), 12)
  assert.equal(lineOf(DOCUMENT, /^## /), 8)
  assert.equal(lineOf(DOCUMENT, 'ausente'), 0)
})

test('fromLine corta desde la primera linea que casa', () => {
  assert.equal(fromLine(DOCUMENT, '## Paso 2'), '## Paso 2\n```yaml\non: push\n```\n```bash\necho fin\n```')
  assert.equal(fromLine(DOCUMENT, 'ausente'), '')
})

test('frontmatterOf y bodyOf cortan en el primer cierre', () => {
  assert.equal(frontmatterOf(DOCUMENT), 'name: ejemplo\ntools: Read, Bash')
  assert.equal(bodyOf(DOCUMENT), DOCUMENT.split('---\n').slice(2).join('---\n').replace(/\n$/, ''))
  assert.equal(bodyOf('---\na: 1\n---\ncuerpo\n---\nresto\n'), 'cuerpo\n---\nresto')
})

test('sin cierre, el frontmatter llega al final y no hay cuerpo', () => {
  assert.equal(frontmatterOf('---\na: 1\nb: 2\n'), 'a: 1\nb: 2')
  assert.equal(bodyOf('---\na: 1\nb: 2\n'), '')
  assert.equal(frontmatterOf(''), '')
})

test('sectionOf llega hasta el siguiente encabezado del mismo nivel o superior', () => {
  assert.equal(
    sectionOf(DOCUMENT, '## Paso 1'),
    [
      '## Paso 1',
      'Lee el config.',
      '```bash',
      '# comentario, no encabezado',
      'jq -r .a "$CONFIG"',
      '```',
      '### Detalle',
      'Mas texto.',
    ].join('\n'),
  )
  assert.equal(sectionOf(DOCUMENT, '### Detalle'), '### Detalle\nMas texto.')
  assert.equal(sectionOf(DOCUMENT, '## Paso 2'), '## Paso 2\n```yaml\non: push\n```\n```bash\necho fin\n```')
  assert.equal(sectionOf(DOCUMENT, '## Paso 3'), '')
  assert.equal(sectionOf(DOCUMENT, 'Lee el config.'), '')
})

test('fencedBlocks devuelve los bloques del lenguaje pedido, en orden', () => {
  assert.deepEqual(fencedBlocks(DOCUMENT, 'bash'), ['# comentario, no encabezado\njq -r .a "$CONFIG"', 'echo fin'])
  assert.deepEqual(fencedBlocks(DOCUMENT, 'yaml'), ['on: push'])
  assert.deepEqual(fencedBlocks(DOCUMENT, 'json'), [])
  assert.deepEqual(fencedBlocks('```bash\nsin cierre\n', 'bash'), [])
})

test('lineRanges reproduce los rangos de awk', () => {
  const hcl = 'variable "a" {\n  default = 1\n}\nlocals {}\nvariable "b" {\n  default = 2\n}\n'
  assert.deepEqual(lineRanges(hcl, /^variable "a"/, /^}/), ['variable "a" {\n  default = 1\n}'])
  assert.deepEqual(lineRanges(hcl, /^variable /, /^}/), [
    'variable "a" {\n  default = 1\n}',
    'variable "b" {\n  default = 2\n}',
  ])
  assert.deepEqual(lineRanges(hcl, /^locals/, /\}$/), ['locals {}'])
  assert.deepEqual(lineRanges(hcl, /^variable "b"/, /^nunca/), ['variable "b" {\n  default = 2\n}'])
  assert.deepEqual(lineRanges(hcl, /^ausente/, /^}/), [])
})

test('sliceBetween corta entre dos marcas y falla si falta alguna', () => {
  assert.equal(sliceBetween('uno dos tres dos', 'dos', 'tres'), 'dos ')
  assert.equal(sliceBetween('a-b-a-c', 'a', 'a'), '')
  assert.throws(() => sliceBetween('uno', 'dos', 'tres'), /no se encontro el inicio: dos/)
  assert.throws(() => sliceBetween('tres dos', 'dos', 'tres'), /no se encontro el final: tres/)
})

test('countOccurrences cuenta apariciones sin solaparse', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2)
  assert.equal(countOccurrences('a.b a.b', 'a.b'), 2)
  assert.equal(countOccurrences('abc', 'x'), 0)
  assert.equal(countOccurrences('abc', ''), 0)
})

test('assertContains y assertAbsent fallan con el mensaje dado', () => {
  assertContains('uno dos', 'dos')
  assertAbsent('uno dos', 'tres')
  assert.throws(() => assertContains('uno', 'dos', 'falta dos'), { message: 'falta dos' })
  assert.throws(() => assertAbsent('uno', 'uno', 'sobra uno'), { message: 'sobra uno' })
  assert.throws(() => assertContains('uno', 'dos'), /falta el texto esperado: dos/)
  assert.throws(() => assertAbsent('uno', 'uno'), /aparece un texto que no deberia: uno/)
})
