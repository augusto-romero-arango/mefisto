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
  contains(body, '{{mefisto:run appinsights-query.mts custom "', 'fuente usa appinsights-query.mts custom')
  contains(
    body,
    '{{mefisto:run purge-store.mts --domain "$DOMINIO_KEBAB" --env "$ENV" --dry-run}}',
    'fuente usa purge-store.mts --dry-run',
  )
  contains(
    body,
    '{{mefisto:run purge-store.mts --domain "$DOMINIO_KEBAB" --env "$ENV"}}',
    'fuente usa purge-store.mts de purga',
  )
  contains(body, '{{mefisto:run azure-account-info.mts', 'fuente valida sesion con azure-account-info.mts')
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
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.mts" --domain "$DOMINIO_KEBAB" --env "$ENV" --dry-run',
    'claude invoca purge-store.mts --dry-run',
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.mts" --domain "$DOMINIO_KEBAB" --env "$ENV"',
    'claude invoca purge-store.mts',
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.mts" custom',
    'claude invoca appinsights-query.mts',
  )
  contains(
    claude,
    '"${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.mts"',
    'claude invoca azure-account-info.mts',
  )
  absent(claude, '{{mefisto:', 'claude sin directivas sin resolver')
  absent(claude, 'az ', 'claude sin az directo')
  absentAll(claude, ['PLUGIN_SCRIPTS', 'plugins/cache', 'scripts/.env'], (token) => `claude sin ${token}`)
  check(
    'claude respeta el orden evidencia -> dry-run -> confirmacion -> purga -> rerun',
    () =>
      misplacedOffsets(claude, [
        'appinsights-query.mts',
        '--dry-run',
        'Continuar con la purga',
        '--env "$ENV"\n```',
        'gh run rerun',
      ]).length === 0,
  )
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
})

// La distribucion de purge-store.mts la cubre scripts/tests/purge-store.test.mts.
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
    'GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/purge-store.md',
    'mirror conserva marcador generado',
  )
  generatorIsUpToDate()
})
