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
  isExecutable,
  linesWith,
  mirrorMatches,
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
    '{{mefisto:run launch-pipeline.sh --scaffold <issue> --domain <dominio-kebab-confirmado>}}',
    'despacho con issue',
  )
  contains(
    body,
    '{{mefisto:run launch-pipeline.sh --scaffold --domain <dominio-kebab-confirmado>}}',
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
  contains(body, 'stream-watch.sh', 'remite al visor en otra terminal')
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
  guardPrecedesOperation(command, /gh issue view|jq -r/)
  check(
    'confirmacion precede al lanzamiento',
    () =>
      ascending(
        lineOf(command.source, '¿Continuar? (s/n)'),
        lineOf(command.source, '{{mefisto:run launch-pipeline.sh'),
      ),
    'confirmacion no precede al lanzamiento',
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  for (const form of ['--scaffold <issue> --domain', '--scaffold --domain']) {
    contains(
      claude,
      `"\${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" ${form}`,
      `Claude invoca launch-pipeline.sh ${form}`,
    )
  }
  absent(claude, 'plugins/cache', 'salida sin plugins/cache')
  absent(claude, 'grep -ioP', 'salida sin grep -ioP')
  absent(
    linesWith(claude, 'scripts/launch-pipeline.sh" --scaffold'),
    '.plugin-root',
    'invocacion Claude sin .plugin-root',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/scaffold.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
})

describe('[assets] scaffold-pipeline.sh empaquetado', () => {
  check(
    'scaffold-pipeline.sh ejecutable en dist/claude',
    () => isExecutable('dist/claude/scripts/scaffold-pipeline.sh'),
    'falta o no es ejecutable dist/claude/scripts/scaffold-pipeline.sh',
  )
  check(
    'dist/claude/scripts/scaffold-pipeline.sh identico a la fuente',
    () => sameBytes('scripts/scaffold-pipeline.sh', 'dist/claude/scripts/scaffold-pipeline.sh'),
    'dist/claude/scripts/scaffold-pipeline.sh diverge',
  )
  check(
    'inventario de dist/claude lista scaffold-pipeline.sh',
    () => inventoryHasDestination('scripts/scaffold-pipeline.sh'),
    'inventario de dist/claude no lista scaffold-pipeline.sh',
  )
  generatorIsUpToDate()
})
