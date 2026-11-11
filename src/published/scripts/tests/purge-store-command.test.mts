// Contrato del comando purge-store neutral y su proyeccion publicada.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  absent,
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  inventoryJson,
  jsonStrings,
  metadataOf,
  mirrorMatches,
  misplacedOffsets,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('purge-store')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  test('metadata neutral correcta', () => {
    const metadata = metadataOf(command)
    assert.deepEqual(
      {
        kind: metadata.kind,
        id: metadata.id,
        profile: metadata.profile,
        arguments: metadata.arguments,
        agent: 'agent' in metadata,
        capabilities: 'capabilities' in metadata,
      },
      {
        kind: 'command',
        id: 'purge-store',
        profile: 'balanced',
        arguments: '<dominio> [--env <env>]',
        agent: false,
        capabilities: false,
      },
      'metadata neutral invalida',
    )
  })
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:config-path}}', 'lee domainLabels desde config-path')
  contains(body, 'domainLabels', 'menciona domainLabels')
  contains(body, '{{mefisto:run appinsights-query.sh custom "', 'fuente usa appinsights-query.sh custom')
  contains(
    body,
    '{{mefisto:run purge-store.sh --domain "$DOMINIO_KEBAB" --env "$ENV" --dry-run}}',
    'fuente usa purge-store.sh --dry-run',
  )
  contains(
    body,
    '{{mefisto:run purge-store.sh --domain "$DOMINIO_KEBAB" --env "$ENV"}}',
    'fuente usa purge-store.sh de purga',
  )
  contains(body, '{{mefisto:run azure-account-info.sh', 'fuente valida sesion con azure-account-info.sh')
  contains(body, '.mefisto/appinsights.env', 'fuente cita .mefisto/appinsights.env')
  contains(body, 'gh run rerun "$RUN_ID" --failed', 'conserva rerun --failed')
  contains(body, 'ATTEMPT_PREVIO', 'espera el intento nuevo')
  contains(body, 'Veredicto', 'veredicto explicito')
  contains(body, 'sin purga', 'sin sintoma, sin purga')
  absent(body, 'az ', 'fuente sin az directo')
  absent(body, 'scripts/.env', 'fuente sin scripts/.env')
  absentAll(
    body,
    ['.plugin-root', 'plugins/cache', 'PLUGIN_SCRIPTS', 'CLAUDE_'],
    (token) => `fuente sin token prohibido: ${token}`,
  )
})

describe('[salida] adaptador', () => {
  claudeOutputExists(command)
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.sh" --domain "$DOMINIO_KEBAB" --env "$ENV" --dry-run',
    'claude invoca purge-store.sh --dry-run',
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.sh" --domain "$DOMINIO_KEBAB" --env "$ENV"',
    'claude invoca purge-store.sh',
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh" custom',
    'claude invoca appinsights-query.sh',
  )
  contains(
    claude,
    '"${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.sh"',
    'claude invoca azure-account-info.sh',
  )
  absent(claude, '{{mefisto:', 'claude sin directivas sin resolver')
  absent(claude, 'az ', 'claude sin az directo')
  absentAll(claude, ['PLUGIN_SCRIPTS', 'plugins/cache', 'scripts/.env'], (token) => `claude sin ${token}`)
  check(
    'claude respeta el orden evidencia -> dry-run -> confirmacion -> purga -> rerun',
    () =>
      misplacedOffsets(claude, [
        'appinsights-query.sh',
        '--dry-run',
        'Continuar con la purga',
        '--env "$ENV"\n```',
        'gh run rerun',
      ]).length === 0,
  )
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
})

// La distribucion de purge-store.sh la cubre scripts/tests/purge-store.test.mts.
describe('[assets] comando inventariado', () => {
  check(
    'inventario de dist/claude incluye el comando',
    () => jsonStrings(inventoryJson()).includes('commands/purge-store.md'),
    'inventario de dist/claude sin el comando',
  )
})

describe('[mirror]', () => {
  mirrorMatches(command)
  contains(
    mirror,
    'GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/purge-store.md',
    'mirror conserva marcador generado',
  )
  generatorIsUpToDate()
})
