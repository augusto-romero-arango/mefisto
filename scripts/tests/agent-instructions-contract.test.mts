// Lectura neutral del contrato del consumidor en los agentes del pipeline TDD (MEF-ADR-0053
// seccion 4): la fuente usa `{{mefisto:instructions-path}}` sin nombrar la ruta legacy, y la
// salida generada remite a onboard cuando falta el archivo efectivo y, ejecutada, lo resuelve con
// precedencia canonica.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { NO_BASH, runBashStreams, writeTree } from './markdown-bash.mts'
import { assertAbsent, assertContains, fencedBlocks, matchingLines, readRepoFile } from './text-contract.mts'

const AGENTS = [
  { name: 'implementer', defersToAnotherAgent: false },
  { name: 'test-writer', defersToAnotherAgent: false },
  { name: 'smoke-test-writer', defersToAnotherAgent: false },
  { name: 'projection-implementer', defersToAnotherAgent: true },
  { name: 'projection-test-writer', defersToAnotherAgent: true },
]

for (const { name, defersToAnotherAgent } of AGENTS) {
  const source = readRepoFile(`src/published/agents/${name}.md`)
  const generated = readRepoFile(`agents/${name}.md`)

  test(`${name}: la fuente neutral usa {{mefisto:instructions-path}}`, () => {
    assertContains(source, '{{mefisto:instructions-path}}', 'la fuente neutral no usa {{mefisto:instructions-path}}')
  })

  if (defersToAnotherAgent) {
    test(`${name}: la fuente neutral resuelve RootNamespace sin remitir al contrato de otro agente`, () => {
      assertAbsent(source, 'mismo contrato que', 'la fuente neutral conserva una remision ambigua a otro contrato')
    })
  }

  test(`${name}: la fuente neutral no nombra la ruta legacy directamente`, () => {
    assert.deepEqual(
      matchingLines(source, /CLAUDE\.md|archivo de instrucciones raiz/),
      [],
      'la fuente neutral nombra la ruta legacy o una lectura directa del archivo raiz',
    )
  })

  if (!defersToAnotherAgent) {
    test(`${name}: la fuente neutral no duplica la politica de precedencia`, () => {
      assert.deepEqual(
        matchingLines(source, /canonico primero|fallback legacy/i),
        [],
        'la fuente neutral duplica la politica de precedencia canonico-first',
      )
    })
  }

  test(`${name}: Claude: el diagnostico de ausencia total remite a onboard`, () => {
    assertContains(generated, '/mefisto:onboard', 'Claude: no remite a onboard cuando falta el contrato efectivo')
  })
}

// El preludio de la salida generada (su segundo bloque bash) ejecutado con bash: RootNamespace sale
// solo del archivo efectivo de instrucciones.
describe('[ejecucion] el preludio resuelve el archivo efectivo de instrucciones', { skip: NO_BASH }, () => {
  const ROOT_NAMESPACE = 'RootNamespace: Bitakora.ControlAsistencia\n'
  let work = ''

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto instrucciones ')))
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  for (const { name } of AGENTS) {
    const prelude = fencedBlocks(readRepoFile(`agents/${name}.md`), 'bash')[1] ?? ''
    const resolve = (scenario: string, files: Record<string, string>) =>
      runBashStreams(
        `${prelude}\nprintf '%s\\n' "$MEFISTO_INSTRUCTIONS_PATH"`,
        writeTree(join(work, `${name}-${scenario}`), files),
      )

    test(`${name}: se extrae el bloque de resolucion de instrucciones`, () => {
      assertContains(prelude, 'MEFISTO_INSTRUCTIONS_PATH')
    })

    test(`${name}: solo canonico resuelve sin aviso`, () => {
      assert.deepEqual(resolve('canonico', { 'AGENTS.md': ROOT_NAMESPACE }), {
        status: 0,
        stdout: 'AGENTS.md\n',
        stderr: '',
      })
    })

    test(`${name}: solo legacy resuelve como fallback de lectura`, () => {
      assert.deepEqual(resolve('legacy', { 'CLAUDE.md': ROOT_NAMESPACE }), {
        status: 0,
        stdout: 'CLAUDE.md\n',
        stderr: '',
      })
    })

    test(`${name}: coexistencia usa solo el canonico y deja visible que ignora el legacy`, () => {
      const result = resolve('ambos', { 'AGENTS.md': ROOT_NAMESPACE, 'CLAUDE.md': 'RootNamespace: Legacy.Divergente\n' })
      assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md\n'])
      assertContains(result.stderr, 'se ignora el legacy')
    })

    test(`${name}: la ausencia de ambos aborta antes de editar, con diagnostico de onboarding`, () => {
      const result = resolve('ausente', {})
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assertContains(result.stderr, '/mefisto:onboard')
    })
  }
})
