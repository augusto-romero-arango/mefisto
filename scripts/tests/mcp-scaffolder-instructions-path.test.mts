// Contrato de instrucciones efectivo de mcp-scaffolder (#1507, MEF-ADR-0053 decision 4): texto del
// agente y su preludio ejecutado con bash.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { NO_BASH, runBashStreams, writeTree } from './markdown-bash.mts'
import type { BashStreams } from './markdown-bash.mts'
import { fencedBlocks, linesOf, readRepoFile } from './text-contract.mts'

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

// El preludio ejecutado con bash: los cuatro tokens salen solo del archivo efectivo.
describe('[ejecucion] el preludio resuelve los cuatro tokens desde el archivo efectivo', { skip: NO_BASH }, () => {
  const prelude = fencedBlocks(AGENT, 'bash').find((block) => block.includes('MEFISTO_INSTRUCTIONS_PATH')) ?? ''
  const WARNING =
    'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md. Migra o elimina conscientemente el archivo legacy para evitar divergencias.'
  const TOKENS = /^(RootNamespace|SolutionFile|ProjectDisplayName|BoundedContext):/
  let work = ''

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto mcp instrucciones ')))
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  const tokens = (prefix: string): string =>
    `RootNamespace: ${prefix}.Namespace\nSolutionFile: ${prefix}.slnx\n` +
    `ProjectDisplayName: ${prefix} Display\nBoundedContext: ${prefix} Context\n`

  function resolve(name: string, files: Record<string, string>): { dir: string } & BashStreams {
    const dir = writeTree(join(work, name), { '.mefisto/harness.config.json': '{}\n', ...files })
    return { dir, ...runBashStreams(`${prelude}\nprintf '%s\\n' "$MEFISTO_INSTRUCTIONS_PATH"`, dir) }
  }

  function tokensOf(dir: string, file: string): string {
    return linesOf(readFileSync(join(dir, file), 'utf8'))
      .filter((line) => TOKENS.test(line))
      .join('\n')
  }

  test('consumidor canonico: resuelve los cuatro tokens desde AGENTS.md sin detenerse', () => {
    const result = resolve('canonico', { 'AGENTS.md': tokens('Canonico') })
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, 'AGENTS.md\n', ''])
    assert.equal(tokensOf(result.dir, 'AGENTS.md'), tokens('Canonico').trimEnd())
  })

  test('consumidor canonico con puente minimo: el puente no impide resolver los cuatro tokens', () => {
    const result = resolve('puente', { 'AGENTS.md': tokens('Puente'), 'CLAUDE.md': '@AGENTS.md\n' })
    assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md\n'])
    assert.equal(tokensOf(result.dir, 'AGENTS.md'), tokens('Puente').trimEnd())
    assert.ok(linesOf(result.stderr).includes(WARNING), result.stderr)
  })

  test('consumidor solo legacy: el fallback conserva los cuatro tokens', () => {
    const result = resolve('legacy', { 'CLAUDE.md': tokens('Legacy') })
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, 'CLAUDE.md\n', ''])
    assert.equal(tokensOf(result.dir, 'CLAUDE.md'), tokens('Legacy').trimEnd())
  })

  test('coexistencia divergente: AGENTS.md prevalece y emite el AVISO literal', () => {
    const result = resolve('ambos', { 'AGENTS.md': tokens('Canonico'), 'CLAUDE.md': tokens('Legacy') })
    assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md\n'])
    assert.ok(linesOf(result.stderr).includes(WARNING), result.stderr)
  })

  test('ausencia: aborta con el diagnostico de onboarding', () => {
    const result = resolve('ausente', {})
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    const lines = linesOf(result.stderr)
    assert.ok(lines.includes('ERROR: no se encontro AGENTS.md, la fuente canonica de directivas del consumidor.'))
    assert.ok(lines.includes('  Ejecuta /mefisto:onboard para diagnosticar y completar el contrato del consumidor.'))
  })
})
