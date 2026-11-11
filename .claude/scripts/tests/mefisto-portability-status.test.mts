import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  adrBody,
  collectStatus,
  countLines,
  formatStatus,
  hookCommandsOf,
  isComplete,
} from '../../../src/internal/scripts/mefisto-portability-status.mts'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'internal',
  'scripts',
  'mefisto-portability-status.mts',
)

function write(root: string, file: string, content: string): void {
  const path = join(root, ...file.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function initRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mefisto-portabilidad-'))
  execFileSync('git', ['init', '--quiet', root])
  for (const [file, content] of Object.entries(files)) write(root, file, content)
  execFileSync('git', ['-C', root, 'add', '--all'])
  return root
}

const HOOKS_BASH = JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'root="$(git rev-parse)"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node hooks/stop.mts' }] }],
  },
})

describe('funciones puras', () => {
  test('countLines cuenta saltos de linea, como wc -l', () => {
    assert.equal(countLines(Buffer.from('')), 0)
    assert.equal(countLines(Buffer.from('a\nb\n')), 2)
    assert.equal(countLines(Buffer.from('a\nb')), 1)
    assert.equal(countLines(Buffer.from('a\r\nb\r\n')), 2)
  })

  test('adrBody corta en la seccion de control de cambios', () => {
    const adr = '# ADR\n\n## Decision\n\ncuerpo\n\n## Control de cambios\n\n- historia tmux\n'
    assert.equal(adrBody(adr).includes('historia'), false)
    assert.equal(adrBody(adr).includes('cuerpo'), true)
    assert.equal(adrBody('sin seccion\n'), 'sin seccion\n')
  })

  test('hookCommandsOf recoge los comandos a cualquier profundidad', () => {
    assert.deepEqual(hookCommandsOf(JSON.parse(HOOKS_BASH)), [
      'root="$(git rev-parse)"',
      'node hooks/stop.mts',
    ])
    assert.deepEqual(hookCommandsOf({ modules: ['x'] }), [])
  })
})

describe('collectStatus sobre un repo de prueba', () => {
  let root = ''

  before(() => {
    root = initRepo({
      'scripts/a.sh': '#!/usr/bin/env bash\necho a\n',
      'scripts/b.sh': 'echo b\n',
      'scripts/filtro.jq': '.\n',
      'scripts/helper.py': 'print(1)\n',
      'dist/claude/scripts/a.sh': 'echo copia\n',
      'hooks/hooks.json': HOOKS_BASH,
      'README.md': 'requiere tmux\n',
      'docs/guia.md': 'el runtime OpenCode\n',
      'docs/bitacora/2026.md': 'tmux y opencode en la historia\n',
      'CHANGELOG.md': 'se retiro tmux\n',
      'docs/adr/mef-adr-0001-solo-historia.md':
        '# ADR\n\ncuerpo limpio\n\n## Control de cambios\n\n- salio tmux y OpenCode\n',
      'docs/adr/mef-adr-0002-en-el-cuerpo.md':
        '# ADR\n\nusa tmux\n\n## Control de cambios\n\n- creacion\n',
      'docs/adr/mef-adr-0057-portabilidad-typescript-node.md': '# ADR\n\nretira tmux y OpenCode\n',
      'docs/adr/INDICE-TEMATICO.md': '| tmux | MEF-ADR-0055 |\n',
      'src/atmuxb.txt': 'atmuxb no es la palabra\n',
    })
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('cuenta .sh, .jq y .py fuera de dist/', () => {
    const status = collectStatus(root)
    assert.equal(status.shellFiles, 2)
    assert.equal(status.shellLines, 3)
    assert.equal(status.jqFiles, 1)
    assert.equal(status.pythonFiles, 1)
  })

  test('tmux se busca como palabra completa y excluye la historia', () => {
    const { tmux } = collectStatus(root)
    assert.deepEqual([...tmux.files].sort(), [
      'README.md',
      'docs/adr/INDICE-TEMATICO.md',
      'docs/adr/mef-adr-0001-solo-historia.md',
      'docs/adr/mef-adr-0002-en-el-cuerpo.md',
      'docs/adr/mef-adr-0057-portabilidad-typescript-node.md',
    ])
    assert.deepEqual([...tmux.outsideExceptions].sort(), [
      'README.md',
      'docs/adr/mef-adr-0002-en-el-cuerpo.md',
    ])
  })

  test('opencode ignora mayusculas y acepta el control de cambios de un ADR', () => {
    const { opencode } = collectStatus(root)
    assert.deepEqual([...opencode.outsideExceptions].sort(), ['docs/guia.md'])
    assert.equal(opencode.files.includes('docs/adr/mef-adr-0001-solo-historia.md'), true)
  })

  test('cuenta los comandos de hooks.json que no son node', () => {
    const status = collectStatus(root)
    assert.equal(status.hookCommands, 2)
    assert.equal(status.hookCommandsNotNode, 1)
  })

  test('el reporte marca las metricas pendientes y lista lo que sobra', () => {
    const status = collectStatus(root)
    assert.equal(isComplete(status), false)
    const report = formatStatus(status)
    assert.match(report, /M1a\s+Archivos \.sh\s+2/)
    assert.match(report, /fuera de las excepciones: README\.md/)
    assert.match(report, /Metricas pendientes\./)
  })

  test('el script corre como comando y --json emite el estado', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--json', '--root', root], {
      encoding: 'utf8',
    })
    const status: unknown = JSON.parse(out)
    assert.equal(typeof status, 'object')
    assert.equal((status as { shellFiles: number }).shellFiles, 2)
  })

  test('un argumento desconocido termina en 1', () => {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, '--nope'], { stdio: 'pipe' }),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'status' in error && error.status === 1,
    )
  })
})

describe('repo portado', () => {
  test('sin bash, jq, python ni menciones, las metricas estan en su meta', () => {
    const root = initRepo({
      'scripts/a.mts': 'export const a = 1\n',
      'hooks/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node hooks/stop.mts' }] }] },
      }),
      'docs/adr/mef-adr-0057-portabilidad-typescript-node.md': '# ADR\n\nretira tmux\n',
    })
    try {
      const status = collectStatus(root)
      assert.equal(isComplete(status), true)
      assert.match(formatStatus(status), /Metricas en su meta\./)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
