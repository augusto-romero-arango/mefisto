// Contrato del comando onboard neutral y su proyeccion publicada.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { lineOf } from '../../../../scripts/tests/text-contract.mts'
import {
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  CONSUMER_GUARD,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryText,
  lineCount,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('onboard')
const { body, claude } = command

describe('[a] metadata y perfil', () => {
  sourceValidates(command)
  hasExactMetadata(command, { profile: 'fast' }, 'metadata sin arguments, agent ni capabilities')
  claudeOutputExists(command)
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
})

describe('[b] invocaciones de scripts', () => {
  test('guard de consumidor una sola vez', () => {
    const guards = lineCount(command.source, CONSUMER_GUARD)
    assert.equal(guards, 1, `guard de consumidor aparece ${guards} veces`)
  })
  for (const script of [
    'onboard-diagnose.sh',
    'onboard-migrate-directives.sh',
    'setup-github-labels.sh',
    'setup-github-ci.sh',
    'bootstrap-backend.sh',
  ]) {
    contains(
      claude,
      `MEFISTO_RUNTIME=claude "\${MEFISTO_PACKAGE_ROOT}/scripts/${script}"`,
      `claude invoca ${script}`,
    )
  }
  contains(claude, 'onboard-migrate-directives.sh" --preview', 'claude usa --preview')
  contains(claude, 'onboard-migrate-directives.sh" --apply', 'claude usa --apply')
})

describe('[c] command-doc de scaffold-projections', () => {
  contains(body, '{{mefisto:command-doc scaffold-projections}}', 'fuente lee command-doc')
  contains(
    claude,
    '"${MEFISTO_PACKAGE_ROOT}/commands/scaffold-projections.md"',
    'Claude lee scaffold-projections',
  )
  for (const cmd of ['install-auth', 'scaffold-projections', 'infra-base', 'scaffold']) {
    contains(body, `{{mefisto:command ${cmd}}}`, `remite a ${cmd} via command`)
  }
})

describe('[d] ausencia de tokens de runtime', () => {
  absentAll(
    body,
    [
      '.plugin-root',
      'plugins/cache',
      'PLUGIN_SCRIPTS',
      'PLUGIN_ROOT',
      'commands/scaffold-projections.md',
      'CLAUDE_',
      '.claude/',
    ],
    (token) => `fuente sin token prohibido: ${token}`,
  )
  absentAll(claude, ['plugins/cache', 'PLUGIN_SCRIPTS'], (token) => `claude sin ${token}`)
})

describe('[e] cada provision despues de su confirmacion', () => {
  const provisions = [
    ['pregunta si desea aplicar', 'onboard-migrate-directives.sh --apply}}'],
    ['¿Quieres que los provisione ahora?', 'setup-github-labels.sh 2>&1}}'],
    ['¿Quieres que lo configure ahora? [si/no]', 'bootstrap-backend.sh --subscription'],
    ['¿Quieres que lo configure ahora? [si/no]', 'setup-github-ci.sh <subscription-id>}}'],
    ['¿Confirmas? [si/no]', 'ESTRATEGIA="<'],
    ['¿Quieres que corra', 'command-doc scaffold-projections}}'],
    ['pregunta si desea aplicar **ese contenido exacto**', 'onboard-provision-appinsights.sh --apply}}'],
    ['onboard-provision-appinsights.sh --preview}}', 'onboard-provision-appinsights.sh --apply}}'],
  ] as const
  for (const [question, provision] of provisions) {
    test(`confirmacion antes de: ${provision}`, () => {
      const asked = lineOf(command.source, question)
      const provisioned = lineOf(command.source, provision)
      const shown = (line: number): string => (line > 0 ? String(line) : 'ausente')
      assert.ok(
        asked > 0 && provisioned > 0 && asked <= provisioned,
        `orden invalido: '${question}' (${shown(asked)}) vs '${provision}' (${shown(provisioned)})`,
      )
    })
  }
  contains(body, 'Provision opt-in de `.mefisto/appinsights.env`', 'paso de provision de appinsights.env')
  contains(body, 'FALTA` para `.mefisto/appinsights.env`', 'el paso solo se ofrece ante FALTA')
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-provision-appinsights.sh"',
    'claude invoca onboard-provision-appinsights.sh',
  )
})

describe('[f] mirror y salidas', () => {
  mirrorMatches(command)
  check(
    'inventario de dist/claude lo incluye',
    () => inventoryText().includes('commands/onboard.md'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})

describe('[g] filas del checklist', () => {
  contains(body, 'solo en Windows, una fila **Git Bash**', 'describe la fila de Git Bash en Windows')
  contains(body, 'con la acción de instalar Git for Windows', 'la fila FALTA pide instalar Git for Windows')
})
