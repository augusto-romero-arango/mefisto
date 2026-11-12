// Contrato de lectura de instrucciones de projections-scaffolder (#1514, MEF-ADR-0053 decision 4):
// el Paso 0 resuelve el archivo efectivo (se ejecuta con bash) y la prosa no vuelve a nombrar el
// legacy como fuente.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { NO_BASH, runBashStreams, writeTree } from './markdown-bash.mts'
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

// El bloque de resolucion del Paso 0 ejecutado con bash: RootNamespace y SolutionFile salen solo
// del archivo efectivo.
describe('[ejecucion] el archivo efectivo resuelve ambos tokens', { skip: NO_BASH }, () => {
  const resolver = fencedBlocks(AGENT, 'bash')[1] ?? ''
  const script =
    `${resolver}\n` +
    `grep -F "RootNamespace:" "$MEFISTO_INSTRUCTIONS_PATH" >/dev/null && ` +
    `grep -F "SolutionFile:" "$MEFISTO_INSTRUCTIONS_PATH" >/dev/null && ` +
    `printf '%s\\n' "$MEFISTO_INSTRUCTIONS_PATH"`
  let work = ''

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto proyecciones instrucciones ')))
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  const resolve = (name: string, files: Record<string, string>) =>
    runBashStreams(
      script,
      writeTree(join(work, name), { '.mefisto/harness.config.json': '{"projections":{"enabled":true}}\n', ...files }),
    )

  test('el canonico completo resuelve ambos tokens y prevalece sobre el puente legacy', () => {
    const result = resolve('canonico', {
      'AGENTS.md': 'RootNamespace: Certificacion.Proyecciones\nSolutionFile: Certificacion.slnx\n',
      'CLAUDE.md': '@AGENTS.md\n',
    })
    assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md\n'])
    assert.ok(result.stderr.includes('se ignora el legacy CLAUDE.md'), result.stderr)
  })

  test('el consumidor solo legacy resuelve ambos tokens como fallback de lectura', () => {
    const result = resolve('legacy', { 'CLAUDE.md': 'RootNamespace: Certificacion.Legacy\nSolutionFile: Legacy.slnx\n' })
    assert.deepEqual(result, { status: 0, stdout: 'CLAUDE.md\n', stderr: '' })
  })

  test('la coexistencia usa el canonico y deja el aviso literal', () => {
    const result = resolve('ambos', {
      'AGENTS.md': 'RootNamespace: Certificacion.Canonica\nSolutionFile: Canonica.slnx\n',
      'CLAUDE.md': 'RootNamespace: Legacy.Divergente\nSolutionFile: Legacy.slnx\n',
    })
    assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md\n'])
    assert.ok(result.stderr.includes('AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md.'), result.stderr)
  })

  test('la ausencia aborta con el diagnostico de onboarding', () => {
    const result = resolve('ausente', {})
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.includes('ERROR: no se encontro AGENTS.md, la fuente canonica de directivas del consumidor.'))
    assert.ok(result.stderr.includes('/mefisto:onboard'))
  })
})
