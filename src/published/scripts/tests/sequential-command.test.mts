// Contrato del comando sequential neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absent,
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  guardPrecedesOperation,
  hasExactMetadata,
  lineCount,
  linesWith,
  mirrorMatches,
  repoFileExists,
  sameBytes,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('sequential')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '<issue1> <issue2> ... [--pipeline tdd|tooling]' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  guardPrecedesOperation(command, /gh issue view/)
  contains(body, '{{mefisto:run launch-pipeline.mts --batch $ARGUMENTS}}', 'despacho neutral exacto')
  check(
    'existe un unico despacho',
    () => lineCount(command.source, '{{mefisto:run launch-pipeline.mts --batch $ARGUMENTS}}') === 1,
    'el despacho no es unico',
  )
  contains(body, 'gh issue view', 'valida issues antes de lanzar')
  contains(body, 'esta cerrado, informalo y excluyelo', 'excluye issues inexistentes o cerrados')
  contains(body, 'Si no queda ningun issue valido, detente', 'se detiene sin issues validos')
  contains(body, 'pipeline resuelto', 'resumen numerado con el pipeline resuelto')
  contains(body, 'pasando `--pipeline` si el usuario lo proporciono', 'pasa --pipeline al wrapper')
  contains(body, 'Herdr', 'documenta despacho Herdr')
  contains(body, 'Secuencial corriendo sin pane.', 'documenta el seguimiento desacoplado fuera de Herdr')
  contains(body, 'stream-watch.mts', 'remite al visor en otra terminal')
  absent(body, 'work-status', 'no remite a work-status')
  contains(body, '{{mefisto:command batch-stop}}', 'referencia batch-stop via directiva command')
  contains(body, 'No esperes a que termine', 'regla: no esperar')
  contains(body, 'No implementes nada tu mismo', 'regla: no implementar')
  contains(
    body,
    '{{mefisto:package-root}}/scripts/batch-pipeline.mts',
    'regla --stop-on-error apunta a batch-pipeline.mts via package-root',
  )
  contains(
    body,
    'launch-pipeline.mts` no lo soporta',
    'regla --stop-on-error explica la limitacion de launch-pipeline.mts',
  )
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
      'plugins/cache',
    ],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" --batch $ARGUMENTS',
    'Claude invoca launch-pipeline.mts --batch y fija su runtime',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  absent(claude, 'work-status', 'no remite a work-status')
  contains(claude, '/mefisto:batch-stop', 'Claude resuelve la directiva command a /mefisto:batch-stop')
  // Solo la linea que lanza launch-pipeline.mts: el preambulo generado que resuelve
  // MEFISTO_PACKAGE_ROOT si cita el marcador legacy, como fallback de lectura.
  absentAll(
    linesWith(claude, 'scripts/launch-pipeline.mts" --batch'),
    ['.claude/pipeline/.plugin-root', 'plugins/cache'],
    (path) => `invocacion Claude no reimplementa el lookup legacy (${path})`,
  )
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/sequential.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  check(
    'batch-pipeline.mts empaquetado en dist/claude/scripts',
    () => repoFileExists('dist/claude/scripts/batch-pipeline.mts'),
    'falta dist/claude/scripts/batch-pipeline.mts',
  )
  check(
    'batch-pipeline.mts identico en dist/claude/scripts',
    () => sameBytes('scripts/batch-pipeline.mts', 'dist/claude/scripts/batch-pipeline.mts'),
    'dist/claude/scripts/batch-pipeline.mts diverge de la fuente',
  )
  generatorIsUpToDate()
})
