// Contrato del comando scaffold neutral y su proyeccion publicada.

import { describe } from 'node:test'

import { lineOf } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  absentAll,
  ascending,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  guardPrecedesOperation,
  hasExactMetadata,
  inventoryHasDestination,
  linesWith,
  mirrorMatches,
  repoFileExists,
  sameBytes,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('scaffold')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '<issue> [dominio] | <dominio>' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(
    body,
    '{{mefisto:run launch-pipeline.mts --scaffold <issue> --domain <dominio-kebab-confirmado>}}',
    'despacho con issue',
  )
  contains(
    body,
    '{{mefisto:run launch-pipeline.mts --scaffold --domain <dominio-kebab-confirmado>}}',
    'despacho sin issue',
  )
  contains(body, 'namespacePrefix', 'RootNamespace desde namespacePrefix')
  contains(body, '{{mefisto:config-path}}', 'lee la config via directiva')
  contains(body, '{{mefisto:state-path logs}}', 'remite al log via directiva')
  absent(body, '/work-status', 'no remite a work-status')
  absent(body, 'work-status', 'no menciona work-status')
  contains(body, 'esta cerrado (`CLOSED`), informa y detente', 'rechaza issue inexistente o cerrado')
  contains(body, 'Dominio: nombre-kebab', 'extrae Dominio del body')
  absent(body, 'grep -ioP', 'sin grep -P en la extraccion')
  contains(body, 'No se pudo determinar el nombre del dominio', 'mensaje sin dominio')
  contains(body, 'Normalizar a kebab-case', 'normalizacion kebab/Pascal')
  contains(body, 'Si ya existe, informa y detente', 'aborta si el dominio existe')
  contains(body, '¿Continuar? (s/n)', 'confirmacion explicita')
  contains(body, 'Si dice no, detente', 'se detiene sin confirmacion')
  contains(body, 'MEF-ADR-0020', 'resumen refleja MEF-ADR-0020')
  contains(body, 'HERDR_ENV=1', 'distingue herdr')
  contains(body, 'Pipeline de scaffold corriendo sin pane.', 'seguimiento desacoplado fuera de herdr')
  contains(body, 'stream-watch.mts', 'remite al visor en otra terminal')
  contains(body, 'No esperes a que termine', 'regla: no esperar')
  contains(body, 'No crees el dominio tu mismo', 'regla: no crear el dominio')
  contains(body, 'Nunca crees un dominio sin confirmacion explicita', 'regla: confirmacion obligatoria')
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
  guardPrecedesOperation(command, /gh issue view|json-value\.mts/)
  check(
    'confirmacion precede al lanzamiento',
    () =>
      ascending(
        lineOf(command.source, '¿Continuar? (s/n)'),
        lineOf(command.source, '{{mefisto:run launch-pipeline.mts'),
      ),
    'confirmacion no precede al lanzamiento',
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  for (const form of ['--scaffold <issue> --domain', '--scaffold --domain']) {
    contains(
      claude,
      `"\${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" ${form}`,
      `Claude invoca launch-pipeline.mts ${form}`,
    )
  }
  absent(claude, 'plugins/cache', 'salida sin plugins/cache')
  absent(claude, 'grep -ioP', 'salida sin grep -ioP')
  absent(
    linesWith(claude, 'scripts/launch-pipeline.mts" --scaffold'),
    '.plugin-root',
    'invocacion Claude sin .plugin-root',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/scaffold.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
})

describe('[assets] scaffold-pipeline.mts empaquetado', () => {
  check(
    'scaffold-pipeline.mts empaquetado en dist/claude',
    () => repoFileExists('dist/claude/scripts/scaffold-pipeline.mts'),
    'falta dist/claude/scripts/scaffold-pipeline.mts',
  )
  check(
    'dist/claude/scripts/scaffold-pipeline.mts identico a la fuente',
    () => sameBytes('scripts/scaffold-pipeline.mts', 'dist/claude/scripts/scaffold-pipeline.mts'),
    'dist/claude/scripts/scaffold-pipeline.mts diverge',
  )
  check(
    'inventario de dist/claude lista scaffold-pipeline.mts',
    () => inventoryHasDestination('scripts/scaffold-pipeline.mts'),
    'inventario de dist/claude no lista scaffold-pipeline.mts',
  )
  generatorIsUpToDate()
})
