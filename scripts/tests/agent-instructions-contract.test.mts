// Lectura neutral del contrato del consumidor en los agentes del pipeline TDD (MEF-ADR-0053
// seccion 4): la fuente usa `{{mefisto:instructions-path}}` sin nombrar la ruta legacy, y la
// salida generada remite a onboard cuando falta el archivo efectivo.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertAbsent, assertContains, matchingLines, readRepoFile } from './text-contract.mts'

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
