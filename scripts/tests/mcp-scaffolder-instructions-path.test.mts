// Contrato de instrucciones efectivo de mcp-scaffolder (#1507, MEF-ADR-0053 decision 4).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fencedBlocks, readRepoFile } from './text-contract.mts'

const AGENT = readRepoFile('agents/mcp-scaffolder.md')

test('extrae el preludio renderizado de instrucciones', () => {
  const prelude = fencedBlocks(AGENT, 'bash').find((block) => block.includes('MEFISTO_INSTRUCTIONS_PATH'))
  assert.ok(prelude !== undefined && prelude.length > 0, 'no encontro el preludio de instrucciones')
})

test('la prosa no remite los tokens a CLAUDE.md', () => {
  assert.ok(
    !AGENT.includes('Tokens de `CLAUDE.md`') && !AGENT.includes('`CLAUDE.md` raiz'),
    'reaparecio una referencia legacy directa a los tokens',
  )
})

test('la prosa usa el archivo efectivo y prohibe mutar instrucciones', () => {
  assert.ok(
    AGENT.includes('lee con tu tool `Read` la ruta `${MEFISTO_INSTRUCTIONS_PATH}`') &&
      AGENT.includes('Si el archivo efectivo no declara alguno de los cuatro') &&
      AGENT.includes('No crees, copies, migres ni escribas ese archivo de directivas.'),
    'la prosa no conserva el contrato del archivo efectivo',
  )
})
