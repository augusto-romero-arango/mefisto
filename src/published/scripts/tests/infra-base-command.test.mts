// Contrato del comando infra-base neutral y su proyeccion publicada.

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

const command = commandContract('infra-base')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '[dev|staging|prod]' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  check(
    'guard precede la delegacion',
    () =>
      ascending(soleLine(command.source, CONSUMER_GUARD), lineOf(command.source, '{{mefisto:launch-agent')),
    'guard no precede la delegacion',
  )
  contains(
    body,
    '{{mefisto:launch-agent infra-base-scaffolder ',
    'delegacion puntual a infra-base-scaffolder',
  )
  const launch = linesWith(command.source, '{{mefisto:launch-agent')
  contains(launch, 'Ambiente: <env>', 'el mensaje lleva el ambiente resuelto')
  absent(launch, '$ARGUMENTS', 'el mensaje no usa $ARGUMENTS crudo')
  contains(body, 'dev`/`staging`/`prod', 'valida dev/staging/prod')
  contains(body, 'usa `dev`', 'ambiente por defecto dev')
  contains(body, 'ALERT_EMAIL', 'recordatorio ALERT_EMAIL')
  contains(body, 'TF_VAR_POSTGRESQL_ADMIN_PASSWORD', 'recordatorio password PostgreSQL')
  contains(body, 'postgresql_region_short', 'recordatorio defaults regionales')
  contains(
    body,
    '{{mefisto:package-root}}/scripts/bootstrap-backend.mts',
    'cita bootstrap-backend.mts del paquete',
  )
  contains(body, '{{mefisto:package-root}}/scripts/setup-github-ci.mts', 'cita setup-github-ci.mts del paquete')
  contains(body, '{{mefisto:command infra}}', 'referencia infra')
  contains(body, '{{mefisto:command scaffold}}', 'referencia scaffold')
  contains(body, 'No generes la infraestructura tu mismo', 'regla: no generar')
  contains(body, 'nunca corre `terraform plan`/`apply`', 'regla: nunca plan/apply')
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
  contains(claude, 'agente `mefisto:infra-base-scaffolder`', 'Claude delega con la tool Task')
  contains(claude, '/mefisto:infra', 'Claude resuelve command infra')
  contains(claude, '/mefisto:scaffold', 'Claude resuelve command scaffold')
  absent(claude, 'claude --agent', 'salida Claude sin claude --agent')
  absent(claude, 'plugins/cache', 'salida Claude sin cache de plugins')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/infra-base.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  check(
    'inventariado en dist/claude',
    () => inventoryHasDestination('commands/infra-base.md'),
    'ausente del inventario de dist/claude',
  )
  generatorIsUpToDate()
})
