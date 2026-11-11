// Contrato de ruta efectiva del flip de tenancy de /install-apim (#1504, MEF-ADR-0053): ningun
// bloque bash del comando toca el config legacy y el flip escribe la ruta que resolvio.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fencedBlocks, linesOf, readRepoFile } from './text-contract.mts'

const COMMAND = readRepoFile('commands/install-apim.md')

function bashBlockAfterHeading(heading: string): string {
  const lines = linesOf(COMMAND)
  const at = lines.indexOf(heading)
  return at === -1 ? '' : (fencedBlocks(lines.slice(at + 1).join('\n'), 'bash')[0] ?? '')
}

test('ningún bloque bash lee, escribe ni agrega directamente el config legacy', () => {
  assert.ok(
    !fencedBlocks(COMMAND, 'bash').join('\n').includes('.claude/harness.config.json'),
    'reapareció una lectura, escritura o staging directo del config legacy en un bloque bash',
  )
})

test('los bloques extraídos usan el helper compartido y la ruta escrita', () => {
  const flip = bashBlockAfterHeading('#### 9.2 Flip del token')
  const commit = bashBlockAfterHeading('### 10. Commitear la migracion de tenancy')
  assert.ok(
    flip.includes('source "$COMMON"') &&
      flip.includes('CONFIG=$(resolve_harness_config_path write "$REPO_ROOT")') &&
      commit.includes('git add "$CONFIG"'),
    'los bloques no usan el helper compartido o la ruta efectiva',
  )
})
