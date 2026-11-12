// Contrato del comando install-apim neutral y su proyeccion publicada. Los bloques bash del
// comando (flip de tenancy del paso 9.2, deteccion de servidores MCP del paso 2b) se ejecutan en
// install-apim-command-blocks.test.mts.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryText,
  lineCount,
  linesInOrder,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('install-apim')
const { body, claude } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    {
      profile: 'balanced',
      arguments:
        '--domain <Dominio> [--domain <Dominio2> ...] [--env <env>] [--cors-origin <origin> ...] [--authorization-server-url <url>]',
    },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(
    body,
    '{{mefisto:launch-agent apim-gateway-scaffolder ',
    'delegacion puntual a apim-gateway-scaffolder',
  )
  contains(body, 'Servidores MCP a exponer:', 'el mensaje conserva los servidores MCP')
  contains(body, 'authorization_server_url', 'el mensaje conserva authorization_server_url')
  contains(
    body,
    '"{{mefisto:package-root}}/scripts/harness-config-path.mts"',
    'harness-config-path.mts desde el paquete activo',
  )
  contains(body, '{{mefisto:instructions-path}}', 'RootNamespace se lee de instructions-path')
  for (const cmd of ['install-workos', 'scaffold', 'scaffold-mcp', 'infra-base', 'onboard']) {
    contains(body, `{{mefisto:command ${cmd}}}`, `remite a ${cmd} via command`)
  }
  contains(body, '{{mefisto:package-root}}/agents/domain-scaffolder.md', 'molde de agente por package-root')
  contains(body, 'ya en etapa (b)', 'flip idempotente')
  contains(body, 'ERROR: el config efectivo todavía es legacy', 'error si el config efectivo es legacy')
  absentAll(
    body,
    [
      'claude --agent',
      '.claude/',
      'CLAUDE_',
      '.plugin-root',
      'plugins/cache',
      'PLUGIN_SCRIPTS',
      'PLUGIN_ROOT',
      'CLAUDE.md',
      'export MEFISTO_INSTRUCTIONS_PATH',
    ],
    (token) => `fuente sin token prohibido: ${token}`,
  )
  linesInOrder(
    command.source,
    [
      '{{mefisto:assert-consumer-repo}}',
      '¿Continuar? (s/n)',
      'git switch -c "install-apim/',
      '{{mefisto:launch-agent',
      'node "$CONFIG_SCRIPT" valid',
      'git commit -m "tenancy(a->b)',
      'gh pr create',
    ],
    'orden: guard -> confirmacion -> rama -> agente -> flip -> commit -> PR',
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
  contains(
    claude,
    'agente `mefisto:apim-gateway-scaffolder`',
    'Claude delega en mefisto:apim-gateway-scaffolder',
  )
  contains(
    claude,
    'HARNESS_CONFIG_PATH=$(node "$CONFIG_SCRIPT" valid "$REPO_ROOT")',
    'Claude valida el config con harness-config-path.mts',
  )
  contains(
    claude,
    'CONFIG_SCRIPT="${MEFISTO_PACKAGE_ROOT}/scripts/harness-config-path.mts"',
    'Claude resuelve harness-config-path.mts desde MEFISTO_PACKAGE_ROOT',
  )
  absentAll(
    claude,
    ['claude --agent', 'plugins/cache', 'PLUGIN_SCRIPTS'],
    (token) => `claude sin token de runtime: ${token}`,
  )
  contains(claude, '/mefisto:install-workos', 'Claude resuelve command install-workos')
  mirrorMatches(command)
  check(
    'inventario de dist/claude lo incluye',
    () => inventoryText().includes('commands/install-apim.md'),
    'inventario de dist/claude no lo incluye',
  )
  test('claude resuelve instrucciones solo en el preambulo generado', () => {
    const count = lineCount(claude, 'export MEFISTO_INSTRUCTIONS_PATH')
    assert.equal(count, 1, `claude resuelve instrucciones ${count} veces`)
  })
  generatorIsUpToDate()
})
