// Contrato de lectura de instrucciones de projections-scaffolder (#1514, MEF-ADR-0053 decision 4):
// el Paso 0 resuelve el archivo efectivo y la prosa no vuelve a nombrar el legacy como fuente.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fencedBlocks, linesOf, readRepoFile } from './text-contract.mts'

const AGENT = readRepoFile('agents/projections-scaffolder.md')

function withoutBashBlock(text: string, target: number): string {
  let seen = 0
  let skipping = false
  return linesOf(text)
    .filter((line) => {
      if (line === '```bash') {
        seen += 1
        if (seen === target) {
          skipping = true
          return false
        }
      }
      if (line === '```' && skipping) {
        skipping = false
        return false
      }
      return !skipping
    })
    .join('\n')
}

test('el Paso 0 contiene el bloque de resolucion de instrucciones', () => {
  const resolver = fencedBlocks(AGENT, 'bash')[1] ?? ''
  assert.ok(
    resolver.length > 0 && resolver.includes('MEFISTO_INSTRUCTIONS_PATH'),
    'no se encontro el bloque de resolucion en el Paso 0',
  )
})

test('la prosa usa exclusivamente MEFISTO_INSTRUCTIONS_PATH como fuente de tokens', () => {
  const prose = withoutBashBlock(AGENT, 2)
  assert.ok(
    !prose.includes('Lee `CLAUDE.md`') && !prose.includes('`CLAUDE.md` raiz'),
    'la prosa todavia nombra el archivo legacy como fuente de tokens',
  )
})

test('la prosa nombra AGENTS.md al diagnosticar tokens ausentes', () => {
  assert.ok(
    AGENT.includes('Lee `${MEFISTO_INSTRUCTIONS_PATH}`') &&
      AGENT.includes('Si el archivo de directivas no declara alguno de los dos'),
    'la prosa no declara la fuente y el diagnostico canonicos',
  )
})
