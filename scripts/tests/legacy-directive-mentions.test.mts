// Anti-regresion de prosa (#1536): ningun agente o skill publicado presenta `CLAUDE.md` como el
// archivo efectivo de directivas del consumidor (MEF-ADR-0049 decision 3).
//
// La lista de archivos es cerrada: un barrido de todo `agents/*.md` marcaria en falso el preludio
// `MEFISTO_INSTRUCTIONS_PATH` de los agentes generados, que nombra `CLAUDE.md` legitimamente. Por
// eso tooling-investigator e historiador se verifican en su fuente neutral.

import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'

import { matchingLines, readRepoFile } from './text-contract.mts'

const PLANNER = 'agents/planner.md'
const FIX_REVIEW = 'commands/fix-review.md'
const ARTIFACTS = [
  'src/published/agents/tooling-investigator.md',
  PLANNER,
  'src/published/agents/historiador.md',
  FIX_REVIEW,
]

for (const artifact of ARTIFACTS) {
  const name = basename(artifact)
  test(`${name} no presenta CLAUDE.md como el archivo efectivo de directivas`, () => {
    const offending = matchingLines(readRepoFile(artifact), /CLAUDE\.md/).filter(
      (line) => !/legacy|fallback|@AGENTS/i.test(line.text),
    )
    assert.deepEqual(
      offending.map((line) => `${line.number}:${line.text}`),
      [],
      `${name} tiene linea(s) sin calificar:`,
    )
  })
}

test('planner.md nombra el indice tematico del plugin (INDICE-TEMATICO.md) al menos dos veces', () => {
  const count = matchingLines(readRepoFile(PLANNER), /INDICE-TEMATICO\.md/).length
  assert.ok(count >= 2, `planner.md nombra INDICE-TEMATICO.md solo ${count} vez/veces (se esperaban >= 2)`)
})

test('fix-review.md nombra mef-adr-0019 en todas sus lineas de routing cross-repo', () => {
  const routing = matchingLines(readRepoFile(FIX_REVIEW), /Routing cross-repo: solo drafts/i)
  assert.notEqual(
    routing.length,
    0,
    'fix-review.md no cita la seccion "Routing cross-repo: solo drafts" en ninguna linea',
  )
  assert.deepEqual(
    routing.filter((line) => !/mef-adr-0019/i.test(line.text)).map((line) => `${line.number}:${line.text}`),
    [],
    'fix-review.md tiene linea(s) de routing sin remitir a mef-adr-0019:',
  )
})
