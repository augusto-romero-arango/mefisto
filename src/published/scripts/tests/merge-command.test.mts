// Contrato del comando merge neutral y su proyeccion publicada.

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
  isExecutable,
  linesWith,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('merge')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '<numero-de-PR> [<numero-de-PR> ...] | --all' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:run pr-sync.sh <PRs> --merge}}', 'invoca pr-sync.sh con lista de PRs')
  contains(body, '{{mefisto:run pr-sync.sh --all --merge}}', 'invoca pr-sync.sh con --all')
  contains(
    body,
    '{{mefisto:run herdr-pipeline.sh --collapse-panes}}',
    'colapsa paneles Herdr via directiva run',
  )
  contains(body, 'HERDR_ENV=1', 'colapso de paneles condicionado a HERDR_ENV=1')
  contains(body, '{{mefisto:state-path logs}}', 'apunta al log via state-path')
  contains(body, 'pr-sync-<ts>.log', 'nombre de log con timestamp fuera de la directiva')
  contains(body, '{{mefisto:command merge}}', 'mensaje de reintento via directiva command')
  contains(body, 'CLOSED', 'descarta PRs CLOSED')
  contains(body, 'MERGED', 'descarta PRs MERGED')
  contains(body, 'No pidas confirmacion adicional', 'resumen sin pedir confirmacion extra')
  contains(body, 'Es best-effort', 'paso de Herdr es best-effort')
  contains(body, 'Nunca hagas merges manuales', 'regla: nunca merges manuales')
  contains(body, 'No diagnostiques errores del script', 'regla: no diagnosticar')
  contains(body, 'No reintentes automaticamente', 'regla: no reintentar')
  contains(body, 'No instales dependencias', 'regla: no instalar dependencias')
  contains(body, 'No toques PRs que no esten en la lista final', 'regla: no tocar PRs fuera de la lista')
  absentAll(
    body,
    [
      'Claude',
      '.claude/',
      'cache',
      'model:',
      'tools:',
      'allowed-tools:',
      'permission:',
      '.plugin-root',
      'CLAUDE_',
    ],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh" <PRs> --merge',
    'Claude invoca pr-sync.sh con lista de PRs y fija su runtime',
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh" --all --merge',
    'Claude invoca pr-sync.sh con --all y fija su runtime',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  // Solo las lineas que invocan los scripts: el preambulo generado que resuelve
  // MEFISTO_PACKAGE_ROOT si cita el marcador legacy, como fallback de lectura.
  absentAll(
    linesWith(claude, /scripts\/(pr-sync|herdr-pipeline)\.sh"/),
    ['.claude/pipeline/.plugin-root', 'plugins/cache'],
    (path) => `invocacion Claude no reimplementa el lookup legacy (${path})`,
  )
  absent(claude, 'plugins/cache', 'salida Claude completa sin cache de plugins')
  contains(claude, 'paneles_herdr_cerrados=${CLOSED:-0}', 'Claude conserva el colapso Herdr best-effort')

  contains(claude, 'Nunca hagas merges manuales', 'Claude conserva las reglas')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/merge.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  check(
    'pr-sync.sh empaquetado en dist/claude/scripts',
    () => isExecutable('dist/claude/scripts/pr-sync.sh'),
    'falta dist/claude/scripts/pr-sync.sh',
  )
  generatorIsUpToDate()
})
