// `AGENTS.md` es la fuente canonica de las directivas del repo y `CLAUDE.md` un shim que la
// importa con `@AGENTS.md` (#855, MEF-ADR-0049 CA-3): que nadie vuelva a poblar el shim.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { countOccurrences, linesOf, repoPath } from '../../../scripts/tests/text-contract.mts'

const CLAUDE_MD = repoPath('CLAUDE.md')
const AGENTS_MD = repoPath('AGENTS.md')

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('CLAUDE.md existe', () => {
  assert.ok(existsSync(CLAUDE_MD), 'CLAUDE.md no existe: el import de Claude Code hacia AGENTS.md no cargaria')
})

test('CLAUDE.md tiene <= 10 lineas', () => {
  const count = countOccurrences(readFileSync(CLAUDE_MD, 'utf8'), '\n')
  assert.ok(count <= 10, `CLAUDE.md tiene ${count} lineas (esperaba <= 10): dejo de ser un shim`)
})

test("CLAUDE.md contiene exactamente una linea '@AGENTS.md'", () => {
  const count = linesOf(readFileSync(CLAUDE_MD, 'utf8')).filter((line) => line === '@AGENTS.md').length
  assert.equal(count, 1, `CLAUDE.md contiene ${count} lineas '@AGENTS.md' (esperaba exactamente 1)`)
})

test('AGENTS.md existe y no esta vacio', () => {
  assert.notEqual(read(AGENTS_MD).length, 0, 'AGENTS.md no existe o esta vacio: la doctrina canonica desaparecio')
})

for (const header of [
  '## Principios de respuesta',
  '## Convenciones del marco',
  '## Dos paquetes de tooling: publicado vs interno',
  '## Trabajar sobre el propio plugin',
]) {
  test(`AGENTS.md contiene el encabezado '${header}'`, () => {
    assert.ok(read(AGENTS_MD).includes(header), `AGENTS.md no contiene el encabezado '${header}'`)
  })
}

for (const frase of [
  'Claude Code carga',
  'Claude Code los carga',
  'Es un **Claude Code Plugin**',
  'Harness opinionado para Claude Code',
]) {
  test(`AGENTS.md no contiene '${frase}'`, () => {
    assert.ok(!read(AGENTS_MD).includes(frase), `AGENTS.md todavia contiene la frase retirada '${frase}'`)
  })
}
