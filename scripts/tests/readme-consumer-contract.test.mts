// Contrato canonico `.mefisto/harness.config.json` en la documentacion del consumidor (#1518):
// ninguna instruccion de instalacion u onboarding nace legacy (MEF-ADR-0053 decision 4).

import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { test } from 'node:test'

import { assertAbsent, assertContains, matchingLines, readRepoFile, repoPath } from './text-contract.mts'

const CORPUS = ['README.md', 'docs/guia-del-consumidor.md', 'docs/migracion-y-versionado.md'].map(readRepoFile).join('')

test("cada linea con el config legacy incluye 'legacy' o 'fallback'", () => {
  const legacy = matchingLines(CORPUS, /\.claude\/harness\.config\.json/)
  assert.notEqual(
    legacy.length,
    0,
    'no se encontro ninguna mencion del config legacy (se esperaba al menos la subseccion de migracion)',
  )
  assert.deepEqual(
    legacy.filter((line) => !/legacy|fallback/i.test(line.text)).map((line) => `${line.number}:${line.text}`),
    [],
    'hay lineas con el config legacy sin marcarlo como legacy/fallback',
  )
})

test('el canonico .mefisto/harness.config.json aparece al menos 6 veces', () => {
  const count = matchingLines(CORPUS, /\.mefisto\/harness\.config\.json/).length
  assert.ok(count >= 6, `aparece solo ${count} veces (se esperaban >= 6)`)
})

test('una misma linea instruye .gitignore y .mefisto/pipeline/', () => {
  assert.ok(
    matchingLines(CORPUS, '.mefisto/pipeline/').some((line) => line.text.includes('.gitignore')),
    'ninguna linea del README instruye .mefisto/pipeline/ en el .gitignore',
  )
})

test('la instruccion replica la regla de scripts/onboard-diagnose.mts (agrega exactamente)', () => {
  assert.ok(
    matchingLines(CORPUS, '.mefisto/pipeline/').some((line) => line.text.includes('Agrega exactamente')),
    "la instruccion no replica la regla de scripts/onboard-diagnose.mts (falta 'Agrega exactamente')",
  )
})

test('el README no instruye ignorar .mefisto/ completo (solo lo niega explicitamente)', () => {
  const bad = matchingLines(CORPUS, /ignor[a-z]+[^|]{0,60}\.mefisto\/`? completo/).filter(
    (line) => !/nunca|no ignores/i.test(line.text),
  )
  assert.deepEqual(
    bad.map((line) => `${line.number}:${line.text}`),
    [],
    'el README sigue instruyendo ignorar .mefisto/ completo',
  )
})

test('el paso 3 aclara explicitamente que no se ignora .mefisto/ completo', () => {
  assertContains(
    CORPUS,
    'nunca ignores `.mefisto/` completo',
    'falta la aclaracion explicita de no ignorar .mefisto/ completo',
  )
})

test('el README enlaza docs/adr/INDICE-TEMATICO.md', () => {
  assertContains(CORPUS, 'docs/adr/INDICE-TEMATICO.md', 'el README no enlaza docs/adr/INDICE-TEMATICO.md')
})

test('ya no remite el indice tematico a CLAUDE.md', () => {
  assertAbsent(CORPUS, 'índice temático en `CLAUDE.md`', 'sigue remitiendo el indice tematico a CLAUDE.md')
})

test('docs/adr/INDICE-TEMATICO.md existe', () => {
  const stat = statSync(repoPath('docs/adr/INDICE-TEMATICO.md'), { throwIfNoEntry: false })
  assert.ok(stat?.isFile() === true, 'docs/adr/INDICE-TEMATICO.md no existe')
})

test('existe la subseccion de migracion con git mv y /mefisto:onboard', () => {
  const message = 'falta la subseccion de migracion del config al canonico'
  assertContains(CORPUS, '### Migrar el config al canónico `.mefisto/harness.config.json`', message)
  assertContains(CORPUS, 'git mv .claude/harness.config.json .mefisto/harness.config.json', message)
  assertContains(CORPUS, '/mefisto:onboard', message)
})
