// Contrato del comando install-auth neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absent,
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

const command = commandContract('install-auth')
const { body, claude } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    {
      profile: 'balanced',
      arguments:
        '--identity-domain <Dominio> --domain <Dominio> [--domain <Dominio2> ...] [--env <env>] [--cors-origin <origin> ...]',
    },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:command-doc install-workos}}', 'lee command-doc install-workos')
  contains(body, '{{mefisto:command-doc install-apim}}', 'lee command-doc install-apim')
  for (const cmd of ['install-workos', 'install-apim', 'infra-base', 'scaffold']) {
    contains(body, `{{mefisto:command ${cmd}}}`, `remite a ${cmd} via command`)
  }
  contains(body, '{{mefisto:package-root}}/agents/domain-scaffolder.md', 'domain-scaffolder por package-root')
  absentAll(
    body,
    [
      '.plugin-root',
      'plugins/cache',
      'commands/install-workos.md',
      'commands/install-apim.md',
      '.claude/',
      'CLAUDE_',
      'PLUGIN_ROOT',
    ],
    (token) => `fuente sin token prohibido: ${token}`,
  )
  linesInOrder(
    command.source,
    [
      '{{mefisto:assert-consumer-repo}}',
      'FALTA la infraestructura base',
      'FALTA: es la primera instalacion del gateway APIM',
      '¿Continuar? (s/n)',
      'git switch -c "install-auth/',
      '### 5. Etapa 1',
      'gh variable list',
      '### 7. Etapa 2',
      'gh pr create',
    ],
    'orden: guard -> prerequisitos -> CORS -> confirmacion -> rama -> etapa 1 -> gate -> etapa 2 -> PR',
  )
  absentAll(
    body,
    ['verbo QUERY', 'App Insights', 'codigo de exito documentado', 'headers de identidad'],
    (marker) => `sin copia del checklist post-deploy: ${marker}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
  contains(claude, '"${MEFISTO_PACKAGE_ROOT}/commands/install-workos.md"', 'Claude lee install-workos')
  contains(claude, '"${MEFISTO_PACKAGE_ROOT}/commands/install-apim.md"', 'Claude lee install-apim')
  for (const id of ['install-workos', 'install-apim']) {
    check(
      `existe dist/claude/commands/${id}.md`,
      () => repoFileExists(`dist/claude/commands/${id}.md`),
      `falta dist/claude/commands/${id}.md`,
    )
  }
  absent(claude, 'plugins/cache', 'claude sin token de runtime: plugins/cache')
  contains(claude, '/mefisto:install-workos', 'Claude resuelve command install-workos')
  contains(claude, '/mefisto:install-apim', 'Claude resuelve command install-apim')
  mirrorMatches(command)
  check(
    'inventario de dist/claude lo incluye',
    () => inventoryText().includes('commands/install-auth.md'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})
