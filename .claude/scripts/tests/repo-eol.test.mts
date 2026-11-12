import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// En Windows git convierte a CRLF al clonar salvo que .gitattributes fije LF.
test('los archivos de texto del repo llegan con LF en cualquier sistema', () => {
  for (const file of [
    '.gitattributes',
    'AGENTS.md',
    'hooks/hooks.json',
    'scripts/lib/cli.mts',
    'src/internal/scripts/mefisto-worktree.mts',
  ]) {
    assert.equal(readFileSync(join(REPO_ROOT, ...file.split('/')), 'utf8').includes('\r'), false, file)
  }
})
