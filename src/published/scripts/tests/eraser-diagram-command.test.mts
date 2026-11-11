// Contrato del comando eraser-diagram neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absent,
  absentAll,
  beforeFirst,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryJson,
  jsonStrings,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('eraser-diagram')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'balanced', arguments: '<descripcion del diagrama>' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  for (const step of ['## Paso 1 ', '## Paso 2 ', '## Paso 3 ', '## Paso 4 ']) {
    contains(body, step, `conserva ${step}`)
  }
  contains(body, 'https://app.eraser.io/api/render/elements', 'endpoint de render presente')
  contains(body, 'Authorization: Bearer ${ERASER_API_TOKEN}', 'Bearer con ERASER_API_TOKEN')
  contains(body, 'Si falla por falta de `ERASER_API_TOKEN`, muestra el DSL', 'degradacion visible sin token')
  absent(body, 'echo "$ERASER_API_TOKEN', 'el token no se imprime')
  absent(body, '${ERASER_API_TOKEN}" >', 'el token no se escribe a archivo')
  for (const diagram of [
    'sequence-diagram',
    'cloud-architecture-diagram',
    'flowchart-diagram',
    'entity-relationship-diagram',
    'bpmn-diagram',
  ]) {
    contains(body, diagram, `sintaxis de ${diagram}`)
  }
  absentAll(
    body,
    ['.claude', '.plugin-root', 'plugins/cache', 'PLUGIN_SCRIPTS', 'CLAUDE_'],
    (token) => `fuente sin token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'https://app.eraser.io/api/render/elements', 'claude llama al endpoint')
  contains(claude, 'Authorization: Bearer ${ERASER_API_TOKEN}', 'claude usa Bearer del entorno')
  contains(
    claude,
    'Si falla por falta de `ERASER_API_TOKEN`, muestra el DSL y explica que se puede pegar en https://app.eraser.io para renderizar.',
    'claude degrada sin token',
  )
  absent(claude, '{{mefisto:', 'claude sin directivas sin resolver')
  absent(claude, 'PLUGIN_SCRIPTS', 'claude sin PLUGIN_SCRIPTS')
  absent(claude, 'plugins/cache', 'claude sin plugins/cache')
  absent(claude, '.claude-plugin/plugin.json"', 'claude sin guard inline')
  const beforeCall = beforeFirst(claude, 'api/render/elements')
  contains(beforeCall, 'Paso 1', 'claude: pasos previos a la llamada')
  contains(
    beforeCall,
    'aborta si existe `src/internal/scripts/generate-internal-adapters.sh`',
    'claude: guard precede a la llamada',
  )
  contains(
    beforeFirst(body, 'api/render/elements'),
    '{{mefisto:assert-consumer-repo}}',
    'fuente: guard precede a la llamada',
  )
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
  mirrorMatches(command)
  contains(
    mirror,
    'GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/eraser-diagram.md',
    'mirror conserva marcador generado',
  )
  check(
    'inventario de dist/claude lo incluye',
    () => jsonStrings(inventoryJson()).includes('commands/eraser-diagram.md'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})
