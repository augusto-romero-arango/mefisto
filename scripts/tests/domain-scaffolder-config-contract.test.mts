// Lecturas del contrato del consumidor en domain-scaffolder (#1408, MEF-ADR-0053 seccion 4): ni la
// fuente neutral ni la salida generada hardcodean la ruta legacy del config.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { matchingLines, readRepoFile } from './text-contract.mts'

const SOURCE = readRepoFile('src/published/agents/domain-scaffolder.md')
const GENERATED = readRepoFile('agents/domain-scaffolder.md')
const LEGACY_JQ_READ = /(jq|json-value\.mts"?)\s.*\.claude\/harness\.config\.json/

test('src/published/agents/domain-scaffolder.md no hardcodea la ruta del config en los comandos jq', () => {
  assert.deepEqual(
    matchingLines(SOURCE, LEGACY_JQ_READ),
    [],
    'src/published/agents/domain-scaffolder.md conserva una lectura jq con ruta hardcodeada',
  )
})

test('la fuente neutral usa las directivas efectivas de config e instructions', () => {
  assert.ok(
    SOURCE.includes('{{mefisto:config-path}}') && SOURCE.includes('{{mefisto:instructions-path}}'),
    'la fuente neutral no usa {{mefisto:config-path}} y/o {{mefisto:instructions-path}}',
  )
})

test('Claude: las lecturas de serviceBus.external/tenancy.strategy usan la ruta efectiva, sin ruta legacy hardcodeada', () => {
  assert.ok(
    matchingLines(GENERATED, /\$\{?MEFISTO_CONFIG_PATH\}?/).length > 0 &&
      matchingLines(GENERATED, LEGACY_JQ_READ).length === 0,
    'Claude: alguna lectura del config no paso por la ruta efectiva',
  )
})

test('Claude: la ausencia de instrucciones remite a onboard', () => {
  assert.ok(
    GENERATED.includes('/mefisto:onboard'),
    'Claude: no remite a onboard cuando faltan las instrucciones efectivas',
  )
})
