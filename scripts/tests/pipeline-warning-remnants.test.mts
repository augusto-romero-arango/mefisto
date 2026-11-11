import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { renderWarningRemnantsSection, warningRemnantRefs } from '../lib/pipeline/warning-remnants.mts'
import { NO_BASH_TWIN, bashTwin } from './pipeline-metrics-parity.mts'

// Contenidos de warnings-remanentes.txt de la paridad; `null`: sin archivo.
const CONTENTS: (string | null)[] = [
  null,
  '',
  'nada\n\n  texto suelto\n',
  '#12\n15\n',
  'owner/repo#7\n',
  '#5\n5\n#5\nbasura\n',
  '  #3 \r\n\t4\t\r\nmi-org/mi.repo_x#10\r\n',
  '#1 #2\n# 3\n#\nowner/repo#\n/repo#1\nowner/#1\nowner/repo/x#1\n-5\n1.5\n#12',
  '0007\n#0007\n7\n',
]

let worktree = ''
let file = ''

function setContent(content: string | null): void {
  rmSync(file, { force: true })
  if (content !== null) writeFileSync(file, content)
}

before(() => {
  worktree = mkdtempSync(join(tmpdir(), 'mefisto warning remnants '))
  mkdirSync(join(worktree, '.mefisto', 'pipeline'), { recursive: true })
  file = join(worktree, '.mefisto', 'pipeline', 'warnings-remanentes.txt')
})

after(() => {
  rmSync(worktree, { recursive: true, force: true })
})

describe('renderWarningRemnantsSection', () => {
  test('sin archivo o sin referencias no imprime nada', () => {
    setContent(null)
    assert.equal(renderWarningRemnantsSection(worktree), '')
    setContent('nada\n\n  texto suelto\n')
    assert.equal(renderWarningRemnantsSection(worktree), '')
    assert.equal(renderWarningRemnantsSection(join(worktree, 'no-existe')), '')
  })

  test('una linea por referencia, en orden de aparicion; N se normaliza a #N', () => {
    setContent('#12\n15\n')
    assert.equal(renderWarningRemnantsSection(worktree), '## Warnings remanentes\n\n- Relacionado: #12\n- Relacionado: #15\n\n')
  })

  test('acepta owner/repo#N y no repite referencias', () => {
    setContent('owner/repo#7\n')
    assert.equal(renderWarningRemnantsSection(worktree), '## Warnings remanentes\n\n- Relacionado: owner/repo#7\n\n')
    setContent('#5\n5\n#5\nbasura\n')
    assert.equal(renderWarningRemnantsSection(worktree), '## Warnings remanentes\n\n- Relacionado: #5\n\n')
  })

  test('warningRemnantRefs ignora espacios, CR y lo que no es una referencia', () => {
    assert.deepEqual(warningRemnantRefs('  #3 \r\n\t4\t\r\nmi-org/mi.repo_x#10\r\n#1 #2\n# 3\n'), ['#3', '#4', 'mi-org/mi.repo_x#10'])
  })
})

describe('paridad con la gemela bash', { skip: NO_BASH_TWIN }, () => {
  for (const [index, content] of CONTENTS.entries()) {
    test(`render_warning_remnants_section: contenido ${index}`, () => {
      setContent(content)
      const bash = bashTwin('render_warning_remnants_section "$@"', [worktree])
      assert.equal(bash.status, 0)
      assert.equal(renderWarningRemnantsSection(worktree), bash.stdout)
    })
  }
})
