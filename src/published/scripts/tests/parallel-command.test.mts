// Contrato del comando parallel neutral y su proyeccion publicada.

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

const command = commandContract('parallel')
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
  contains(body, '{{mefisto:run launch-pipeline.mts --parallel $ARGUMENTS}}', 'despacho neutral exacto')
  check(
    'existe un unico despacho',
    () => lineCount(command.source, '{{mefisto:run launch-pipeline.mts --parallel $ARGUMENTS}}') === 1,
    'el despacho no es unico',
  )
  contains(body, 'gh issue view', 'valida issues antes de lanzar')
  contains(body, 'esta cerrado, informalo y excluyelo', 'excluye issues inexistentes o cerrados')
  contains(body, 'Si no queda ningun issue valido, detente', 'se detiene sin issues validos')
  contains(body, 'pasando `--pipeline` si el usuario lo proporciono', 'pasa --pipeline al wrapper')
  contains(body, 'arranques escalonados de 30s', 'documenta arranque escalonado en Herdr')
  contains(
    body,
    'sin pane: lo sigue la consola de Fausto',
    'reconoce el modo desacoplado por la salida del wrapper',
  )
  contains(
    body,
    'Pipeline paralelo corriendo sin panes. Para monitorear, en otra terminal:',
    'documenta el seguimiento desacoplado fuera de Herdr',
  )
  contains(body, 'stream-watch.mts', 'remite al visor en otra terminal')
  contains(body, '{{mefisto:state-path logs}}', 'documenta logs por issue')
  contains(body, '{{mefisto:state-path events.log}}', 'documenta events.log')
  absent(body, 'propio tab', 'describe correctamente panes, no tabs')
  for (const id of ['merge', 'batch-stop', 'sequential']) {
    contains(body, `{{mefisto:command ${id}}}`, `referencia ${id} via directiva command`)
  }
  absent(body, 'work-status', 'no remite a work-status')
  contains(
    body,
    '{{mefisto:package-root}}/scripts/parallel-pipeline.mts',
    'scheduler directo usa package-root',
  )
  contains(body, '--max-parallel', 'documenta limite de concurrencia')
  contains(body, 'tipo:projection', 'conserva serializacion de projections')
  contains(body, 'No esperes a que termine', 'regla: no esperar')
  contains(body, 'No implementes nada tu mismo', 'regla: no implementar')
  contains(body, 'NO se mergean', 'regla: PRs sin merge automatico')
  absentAll(
    body,
    [
      '.claude/',
      'CLAUDE_',
      '.plugin-root',
      'plugins/cache',
      'model:',
      'tools:',
      'allowed-tools:',
      'permission:',
    ],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" --parallel $ARGUMENTS',
    'Claude invoca launch-pipeline.mts --parallel y fija su runtime',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  for (const id of ['merge', 'batch-stop']) {
    contains(claude, `/mefisto:${id}`, `Claude resuelve ${id}`)
  }
  absentAll(
    linesWith(claude, 'scripts/launch-pipeline.mts" --parallel'),
    ['.claude/pipeline/.plugin-root', 'plugins/cache'],
    (path) => `invocacion Claude no reimplementa lookup legacy (${path})`,
  )
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/parallel.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  check(
    'parallel-pipeline.mts empaquetado en dist/claude/scripts',
    () => repoFileExists('dist/claude/scripts/parallel-pipeline.mts'),
    'falta dist/claude/scripts/parallel-pipeline.mts',
  )
  check(
    'parallel-pipeline.mts identico en dist/claude/scripts',
    () => sameBytes('scripts/parallel-pipeline.mts', 'dist/claude/scripts/parallel-pipeline.mts'),
    'dist/claude/scripts/parallel-pipeline.mts diverge de la fuente',
  )
  generatorIsUpToDate()
})
