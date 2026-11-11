// Contrato del comando scaffold-mcp neutral y su proyeccion publicada.

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

const command = commandContract('scaffold-mcp')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '<proposito>' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:config-path}}', 'lee el config desde config-path')
  contains(body, '{{mefisto:launch-agent mcp-scaffolder ', 'delegacion puntual a mcp-scaffolder')
  contains(
    linesWith(command.source, '{{mefisto:launch-agent'),
    'PascalCase',
    'el mensaje lleva el proposito en PascalCase',
  )
  contains(body, '{{mefisto:package-root}}/mefisto-manifest.json', 'version desde el manifiesto neutral')
  contains(body, 'version desconocida', 'version informativa con fallback')
  absent(body, '.claude-plugin/plugin.json', 'sin plugin.json de runtime')
  contains(body, '{{mefisto:command install-apim}}', 'referencia install-apim')
  contains(body, 'Se va a generar el servidor MCP', 'aviso de lo que se genera')
  contains(body, 'No generes nada tu mismo', 'regla: no generar')
  contains(body, 'idempotente', 'regla: idempotente')
  contains(body, 'Uso: {{mefisto:command scaffold-mcp}} [<proposito>]', 'proposito opcional en la ayuda')
  contains(body, 'PROPOSITO_PASCAL=General', 'sin argumento usa General')
  contains(body, 'servidor MCP General del BC', 'resumen previo informa el servidor General')
  contains(body, 'Mcp.General/', 'detecta Mcp.General existente')
  contains(body, 'pasa un proposito', 'mensaje de parada indica pasar un proposito')
  absent(body, 'Consultas/Comandos', 'ayuda sin particion Consultas/Comandos')
  check(
    'guard y pre-condiciones preceden la delegacion',
    () =>
      ascending(
        soleLine(command.source, CONSUMER_GUARD),
        lineOf(command.source, 'Uso:'),
        lineOf(command.source, 'namespacePrefix'),
        lineOf(command.source, '{{mefisto:launch-agent'),
      ),
    'guard/pre-condiciones no preceden la delegacion',
  )
  absentAll(
    body,
    [
      'claude --agent',
      'Claude',
      '.claude/',
      '.claude-plugin/',
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
  contains(claude, 'agente `mefisto:mcp-scaffolder`', 'Claude delega con la tool Task')
  contains(claude, '/mefisto:install-apim', 'Claude resuelve command install-apim')
  absent(claude, 'claude --agent', 'salida Claude sin claude --agent')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/scaffold-mcp.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  check(
    'inventariado en dist/claude',
    () => inventoryHasDestination('commands/scaffold-mcp.md'),
    'ausente del inventario de dist/claude',
  )
  generatorIsUpToDate()
})
