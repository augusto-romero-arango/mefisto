// Contrato del comando install-workos neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryText,
  linesInOrder,
  mirrorMatches,
  repoFileExists,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('install-workos')
const { body, claude } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'balanced', arguments: '--domain <Dominio> [--env <env>]' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(
    body,
    '{{mefisto:launch-agent workos-identity-scaffolder ',
    'delegacion puntual al agente de identidad',
  )
  contains(body, 'WORKOS_API_KEY (fijo', 'el mensaje fija el app setting WORKOS_API_KEY')
  contains(body, '{{mefisto:command-doc seed-secret}}', 'lee el documento de seed-secret via command-doc')
  contains(
    body,
    '{{mefisto:run seed-secret.sh workos-api-key --domain <Dominio> --env <env> --from-github-secret WORKOS_API_KEY}}',
    'invocacion neutral de seed-secret.sh',
  )
  contains(body, '{{mefisto:command seed-secret}}', 'remite a seed-secret via command')
  contains(body, '{{mefisto:command install-apim}}', 'remite a install-apim via command')
  contains(body, '{{mefisto:command scaffold}}', 'remite a scaffold via command')
  contains(body, '¿Continuar? (s/n)', 'pide confirmacion explicita')
  contains(body, 'git switch -c install-workos/', 'rama unica compartida')
  contains(body, 'gh variable set WORKOS_CLIENT_ID', 'registra WORKOS_CLIENT_ID como variable')
  contains(body, 'gh secret list', 'verifica existencia de WORKOS_API_KEY')
  contains(body, 'NO VERIFICADO', 'degrada a NO VERIFICADO')
  contains(body, 'git push -u origin install-workos/', 'push de rama unica')
  contains(
    body,
    'Nunca pidas, imprimas ni manejes el valor de `WORKOS_API_KEY`',
    'regla: nunca manejar la API key',
  )
  contains(body, 'Nunca ejecutes `terraform plan`', 'regla: nunca plan/apply')
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
      'commands/seed-secret.md',
    ],
    (token) => `fuente sin token prohibido: ${token}`,
  )
  linesInOrder(
    command.source,
    [
      '{{mefisto:assert-consumer-repo}}',
      '¿Continuar? (s/n)',
      'git switch -c install-workos/',
      '{{mefisto:launch-agent',
      '{{mefisto:run seed-secret.sh',
      'gh pr create',
    ],
    'orden: guard -> confirmacion -> rama -> agente -> seed-secret -> PR',
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
  contains(
    claude,
    'agente `mefisto:workos-identity-scaffolder`',
    'Claude delega puntualmente en mefisto:workos-identity-scaffolder',
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/seed-secret.sh" workos-api-key',
    'Claude invoca seed-secret.sh con su runtime',
  )
  contains(claude, '"${MEFISTO_PACKAGE_ROOT}/commands/seed-secret.md"', 'Claude lee commands/seed-secret.md')
  check(
    'existe la ruta leida por Claude',
    () => repoFileExists('dist/claude/commands/seed-secret.md'),
    'falta la ruta leida por Claude',
  )
  absentAll(
    claude,
    ['claude --agent', 'plugins/cache', 'PLUGIN_SCRIPTS'],
    (token) => `claude sin token de runtime: ${token}`,
  )
  contains(claude, '/mefisto:install-apim', 'Claude resuelve command install-apim')
  mirrorMatches(command)
  check(
    'inventario de dist/claude lo incluye',
    () => inventoryText().includes('commands/install-workos.md'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})

describe('[jwt-template] paso 5 guia el JWT Template (issue #2397)', () => {
  contains(
    body,
    '"organization_membership_id": "{{ organization_membership.id }}"',
    'guia el JWT Template con organization_membership_id',
  )
  contains(body, 'https://workos.com/docs/fga/authkit-integration', 'cita la doc oficial de WorkOS')
  contains(body, '3072 bytes', 'advierte el limite de 3072 bytes')
})
