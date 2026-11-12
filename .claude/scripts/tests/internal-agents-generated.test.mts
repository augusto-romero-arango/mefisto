// Los cinco agentes internos sobre la fuente neutral (MEF-ADR-0049): fuentes validas y
// neutrales, y adaptadores versionados que coinciden con lo que la fuente produce.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runGenerator } from '../../../src/internal/scripts/generate-internal-adapters.mts'
import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import { runValidator } from '../../../src/internal/scripts/validate-internal-artifacts.mts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const AGENTS_DIR = join(REPO_ROOT, 'src', 'internal', 'agents')

// Perfil declarado por cada agente: condiciona el `model:` de la salida.
const AGENTS: [string, string][] = [
  ['mefisto-planner', 'deep'],
  ['mefisto-investigator', 'deep'],
  ['mefisto-historiador', 'balanced'],
  ['mefisto-writer', 'balanced'],
  ['mefisto-reviewer', 'deep'],
]
const MODEL_OF: Record<string, string> = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }

// Mas estricto que el validador: aqui ni el manifiesto del plugin ni la superficie de scripts.
function bodyLinesNamingRuntime(content: string): number[] {
  const lines = content.split('\n')
  const close = lines.indexOf('---', 1)
  if (close === -1) return []
  return lines.flatMap((line, index) => (index > close && /claude/i.test(line) ? [index + 1] : []))
}

describe('fuentes neutrales de los agentes', () => {
  for (const [id] of AGENTS) {
    test(`${id}: existe, pasa el contrato y su body no nombra un runtime`, () => {
      const source = join(AGENTS_DIR, `${id}.md`)
      assert.ok(existsSync(source))
      const output = new Output()
      assert.equal(runValidator([source], output), 0, output.stdout)
      assert.deepEqual(bodyLinesNamingRuntime(readFileSync(source, 'utf8')), [])
    })
  }

  for (const id of ['mefisto-writer', 'mefisto-reviewer']) {
    test(`${id}: es seleccionable como agente primario (mode: all)`, () => {
      assert.ok(readFileSync(join(AGENTS_DIR, `${id}.md`), 'utf8').includes('"mode": "all"'))
    })
  }
})

describe('adaptadores generados de los agentes', () => {
  test('--check esta en verde', () => {
    const output = new Output()
    assert.equal(runGenerator(['--check'], output), 0, output.stdout + output.stderr)
  })

  for (const [id, profile] of AGENTS) {
    test(`${id}: lleva el marcador y el modelo de su perfil (${profile})`, () => {
      const generated = readFileSync(join(REPO_ROOT, '.claude', 'agents', `${id}.md`), 'utf8')
      assert.match(generated, /^<!-- GENERADO por src\/internal\/scripts\/generate-internal-adapters\.mts/m)
      assert.ok(generated.split('\n').includes(`model: "${MODEL_OF[profile]}"`))
    })
  }
})
