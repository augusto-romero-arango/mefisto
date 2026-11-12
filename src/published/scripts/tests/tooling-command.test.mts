// Contrato del comando tooling neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  guardPrecedesOperation,
  hasExactMetadata,
  lineCount,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('tooling')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    {
      profile: 'fast',
      arguments: "<issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]",
    },
    'metadata sin capacidades ni runtime',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor antes del proceso')
  guardPrecedesOperation(command, /gh issue view/)
  contains(body, 'primer token numerico', 'extrae el issue del primer token numerico')
  contains(body, 'no contiene un token compuesto solo por digitos', 'sin issue numerico muestra uso')
  contains(body, 'argumentos mal formados', 'flags mal formados muestran uso')
  contains(body, 'Si no es consultable', 'issue no consultable bloquea')
  contains(body, 'cerrado (`CLOSED`)', 'issue cerrado bloquea')
  contains(body, 'confirmacion explicita', 'falta tipo tooling requiere confirmacion')
  contains(body, 'Depende de #N', 'dependencias declaradas se filtran')
  contains(body, 'Bloqueado por #N', 'dependencias bloqueadas se filtran')
  contains(body, 'Ignora cualquier otro `#N`', 'ignora referencias ajenas a dependencias')
  contains(
    body,
    'Si no hay una dependencia canonica consultable',
    'label bloqueado sin dependencias no se retira',
  )
  contains(
    body,
    'dependencia `OPEN` o no consultable es un bloqueo visible',
    'dependencia abierta o no consultable bloquea',
  )
  contains(body, 'retira el label `bloqueado`', 'dependencias cerradas desbloquean')
  contains(body, 'Con `--variant`, nunca mutas labels', 'variante no muta labels')
  contains(body, 'claves de stage `writer` y `reviewer`', 'models conserva stages')
  contains(
    body,
    'no hace push, no abre PR ni muta el issue',
    'variante conserva aislamiento sin efectos remotos',
  )
  contains(body, 'reenvia ambos flags intactos', 'forwarding de flags intacto')
  contains(body, '{{mefisto:run launch-pipeline.mts --tooling $ARGUMENTS}}', 'despacho neutral exacto')
  check(
    'existe un unico despacho',
    () => lineCount(command.source, '{{mefisto:run launch-pipeline.mts --tooling $ARGUMENTS}}') === 1,
    'el despacho no es unico',
  )
  contains(body, 'Herdr', 'documenta despacho Herdr')
  contains(
    body,
    'la salida del wrapper dice `sin pane` sin nombrar la consola',
    'documenta el seguimiento desacoplado fuera de Herdr',
  )
  contains(body, 'stream-watch.mts', 'remite al visor en otra terminal')
  contains(body, '/mefisto:tooling', 'documenta el nombre canonico')
  absentAll(
    body,
    ['Claude', '.claude/', 'cache', 'model:', 'tools:', 'allowed-tools:', 'permission:', '/work-status'],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" --tooling $ARGUMENTS',
    'Claude cita package root con espacios y fija su runtime',
  )
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/tooling.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  generatorIsUpToDate()
})
