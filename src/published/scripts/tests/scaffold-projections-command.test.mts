// Contrato del comando scaffold-projections neutral y su proyeccion publicada.

import { describe } from 'node:test'

import { lineOf } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  absentAll,
  ascending,
  check,
  claudeOutputExists,
  commandContract,
  CONSUMER_GUARD,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryHasDestination,
  linesWith,
  mirrorMatches,
  soleLine,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('scaffold-projections')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(command, { profile: 'fast' }, 'metadata sin agent, arguments ni capabilities')
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:config-path}}', 'lee projections.enabled desde config-path')
  contains(body, 'json-value.mts" get "{{mefisto:config-path}}" projections.enabled', 'gate lee projections.enabled')
  absent(linesWith(command.source, 'json-value.mts" get "{{mefisto:config-path}}" projections.enabled'), '--default', 'filtro jq sin //')
  absent(linesWith(command.source, 'json-value.mts" get "{{mefisto:config-path}}" projections.enabled'), '--or-empty', 'lectura sin --or-empty')
  contains(
    body,
    '{{mefisto:launch-agent projections-scaffolder ',
    'delegacion puntual a projections-scaffolder',
  )
  check(
    'guard y gate del token preceden la delegacion',
    () =>
      ascending(
        soleLine(command.source, CONSUMER_GUARD),
        lineOf(command.source, 'json-value.mts" get "{{mefisto:config-path}}" projections.enabled'),
        lineOf(command.source, '{{mefisto:launch-agent'),
      ),
    'guard/gate no preceden la delegacion',
  )
  contains(body, '**ausente**', 'distingue token ausente')
  contains(body, '**deshabilitado**', 'distingue token deshabilitado')
  contains(body, '"projections": { "enabled": true }', 'mensaje con el bloque JSON')
  contains(body, 'Se va a generar el worker de proyecciones', 'aviso de lo que se genera')
  contains(body, 'domain-scaffolder', 'recordatorio domain-scaffolder')
  contains(
    body,
    'projection-test-writer/projection-implementer',
    'recordatorio projection-test-writer/implementer',
  )
  contains(
    body,
    'deploy-projections.yml solo publica la imagen',
    'recordatorio orden de deploy-projections.yml',
  )
  contains(body, '{{mefisto:command onboard}}', 'referencia onboard')
  contains(body, '{{mefisto:command infra-base}}', 'referencia infra-base')
  contains(body, '.mefisto/harness.config.json', 'ruta canonica del config')
  contains(body, 'No generes nada tu mismo', 'regla: no generar')
  contains(body, 'nunca registra un store de dominio', 'regla: nunca registra stores')
  contains(body, 'idempotente', 'regla: idempotente')
  absentAll(
    body,
    [
      'claude --agent',
      'Claude',
      '.claude/',
      '.plugin-root',
      'CLAUDE_',
      'plugins/cache',
      'model:',
      'allowed-tools:',
    ],
    (token) => `fuente sin token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  contains(claude, 'agente `mefisto:projections-scaffolder`', 'Claude delega con la tool Task')
  contains(claude, '/mefisto:infra-base', 'Claude resuelve command infra-base')
  contains(claude, '/mefisto:onboard', 'Claude resuelve command onboard')
  absent(claude, 'claude --agent', 'salida Claude sin claude --agent')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/scaffold-projections.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  check(
    'inventariado en dist/claude',
    () => inventoryHasDestination('commands/scaffold-projections.md'),
    'ausente del inventario de dist/claude',
  )
  generatorIsUpToDate()
})
