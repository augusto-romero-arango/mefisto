// Contrato del comando infra neutral y su proyeccion publicada.

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
  inventoryHasDestination,
  lineCount,
  linesWith,
  mirrorMatches,
  repoFileExists,
  sameBytes,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('infra')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(command, { profile: 'fast', arguments: '<issue>' }, 'metadata sin agent ni capabilities')
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  guardPrecedesOperation(command, /gh issue view/)
  contains(body, '{{mefisto:run launch-pipeline.mts --infra $ARGUMENTS}}', 'despacho neutral exacto')
  check(
    'existe un unico despacho',
    () => lineCount(command.source, '{{mefisto:run launch-pipeline.mts --infra $ARGUMENTS}}') === 1,
    'el despacho no es unico',
  )
  contains(body, 'gh issue view', 'valida issues antes de lanzar')
  contains(body, 'esta cerrado (`CLOSED`), informa y detente', 'rechaza issue inexistente o cerrado')
  contains(body, 'tipo:infra', 'valida el label tipo:infra')
  contains(body, 'Continuar de todos modos? (s/n)', 'advierte sin tipo:infra con confirmacion')
  contains(body, 'Si no se confirma, detente', 'se detiene sin confirmacion')
  contains(body, 'Depende de #N', 'reconoce lineas canonicas Depende de #N')
  contains(body, 'Bloqueado por #N', 'reconoce lineas canonicas Bloqueado por #N')
  contains(body, 'gh pr view', 'consulta PR antes que issue')
  contains(body, 'Nunca supongas que un fallo significa cierre', 'falla cerrado ante consulta no resoluble')
  contains(body, 'HERDR_ENV=1', 'documenta deteccion de Herdr')
  contains(body, 'Pipeline infra corriendo sin pane.', 'documenta el seguimiento desacoplado fuera de Herdr')
  contains(body, 'stream-watch.mts', 'remite al visor en otra terminal')
  absent(body, 'work-status', 'no remite a work-status')
  contains(body, '{{mefisto:command implement}}', 'referencia implement via directiva command')
  contains(body, '{{mefisto:command tooling}}', 'referencia tooling via directiva command')
  contains(body, 'MEF-ADR-0021', 'documenta el ADR de cero permisos de Azure')
  contains(body, 'MEF-ADR-0022', 'documenta el ADR de cierre del issue en CI')
  contains(body, 'terraform plan', 'documenta que no se ejecuta terraform plan')
  contains(body, 'No esperes a que termine', 'regla: no esperar')
  contains(body, 'No implementes nada tu mismo', 'regla: no implementar')
  contains(body, '`MEFISTO_UI` admite `mod` (desacoplado) y `herdr`', 'documenta los modos de UI validos')
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
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" --infra $ARGUMENTS',
    'Claude invoca launch-pipeline.mts --infra y fija su runtime',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  absent(claude, 'work-status', 'no remite a work-status')
  contains(claude, '/mefisto:implement', 'Claude resuelve la directiva command a /mefisto:implement')
  contains(claude, '/mefisto:tooling', 'Claude resuelve la directiva command a /mefisto:tooling')
  absentAll(
    linesWith(claude, 'scripts/launch-pipeline.mts" --infra'),
    ['.claude/pipeline/.plugin-root', 'plugins/cache'],
    (path) => `invocacion Claude no reimplementa el lookup legacy (${path})`,
  )
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/infra.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
})

describe('[assets] iac-pipeline.mts empaquetado', () => {
  check(
    'iac-pipeline.mts empaquetado en dist/claude/scripts',
    () => repoFileExists('dist/claude/scripts/iac-pipeline.mts'),
    'falta dist/claude/scripts/iac-pipeline.mts',
  )
  check(
    'dist/claude/scripts/iac-pipeline.mts identico a la fuente',
    () => sameBytes('scripts/iac-pipeline.mts', 'dist/claude/scripts/iac-pipeline.mts'),
    'dist/claude/scripts/iac-pipeline.mts diverge de la fuente',
  )
  check(
    'scripts/iac-pipeline.mts en el inventario de dist/claude',
    () => inventoryHasDestination('scripts/iac-pipeline.mts'),
    'scripts/iac-pipeline.mts ausente del inventario de dist/claude',
  )
  generatorIsUpToDate()
})
