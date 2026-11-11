// Contrato del comando health-check neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absent,
  absentAll,
  beforeFirst,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryJson,
  jsonStrings,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('health-check')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(command, { profile: 'balanced' }, 'metadata sin arguments, agent ni capabilities')
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(
    body,
    '{{mefisto:run azure-account-info.sh 2>&1}}',
    'fuente valida la sesion con azure-account-info.sh',
  )
  for (const query of ['health-summary', 'dead-letters', 'function-errors']) {
    contains(body, `{{mefisto:run appinsights-query.sh ${query} --hours 24}}`, `fuente consulta ${query} a 24h`)
  }
  contains(body, 'NO VERIFICADO', 'conserva NO VERIFICADO sin runs')
  contains(body, 'gh run list --workflow=infra-cd.yml', 'estado de infra-cd.yml via gh')
  contains(body, '{{mefisto:command bug}}', 'sugerencias con command bug')
  contains(body, '{{mefisto:command health-check}}', 'tip final con command health-check')
  contains(body, 'appinsights.env', 'reporta ausencia de appinsights.env')
  absent(body, 'az ', 'fuente sin az directo')
  absentAll(
    body,
    ['.plugin-root', 'plugins/cache', 'PLUGIN_SCRIPTS', 'CLAUDE_'],
    (token) => `fuente sin token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  for (const query of ['health-summary', 'dead-letters', 'function-errors']) {
    contains(
      claude,
      `MEFISTO_RUNTIME=claude "\${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh" ${query} --hours 24`,
      `claude invoca appinsights-query.sh ${query}`,
    )
  }
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.sh" 2>&1',
    'claude invoca azure-account-info.sh',
  )
  absent(claude, '{{mefisto:', 'claude sin directivas sin resolver')
  absent(claude, 'az ', 'claude sin az directo')
  absent(claude, 'PLUGIN_SCRIPTS', 'claude sin PLUGIN_SCRIPTS')
  absent(claude, 'plugins/cache', 'claude sin plugins/cache')
  contains(
    beforeFirst(claude, 'appinsights-query.sh'),
    'azure-account-info.sh',
    'claude valida la sesion antes de consultar',
  )
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
  mirrorMatches(command)
  contains(
    mirror,
    'GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/health-check.md',
    'mirror conserva marcador generado',
  )
  check(
    'inventario de dist/claude lo incluye',
    () => jsonStrings(inventoryJson()).includes('commands/health-check.md'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})
