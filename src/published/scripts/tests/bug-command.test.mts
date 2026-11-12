// Contrato del comando bug neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absent,
  absentAll,
  afterFirst,
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

const command = commandContract('bug')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '[--tooling|--deployed] <descripcion del sintoma>' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:launch-agent tooling-investigator ', 'delegacion puntual a tooling-investigator')
  contains(body, '{{mefisto:launch-agent bug-investigator ', 'delegacion puntual a bug-investigator')
  contains(body, '{{mefisto:run azure-account-info.mts 2>&1}}', 'valida sesion con azure-account-info.mts')
  contains(body, '.mefisto/appinsights.env', 'valida appinsights.env')
  contains(body, 'Uso: {{mefisto:command bug}}', 'uso vacio con command bug')
  contains(body, '`.claude/`, `.mefisto/`', 'indicadores de tooling conservan .claude/ y suman .mefisto/')
  contains(body, '--tooling', 'flag --tooling')
  contains(body, '--deployed', 'flag --deployed')
  contains(body, 'No investigues nada tu mismo', 'regla no investigar')
  contains(body, 'No modifiques codigo', 'regla no modificar codigo')
  absent(body, 'claude --agent', 'fuente sin claude --agent')
  absent(body, 'az ', 'fuente sin az directo')
  absentAll(
    body,
    ['.plugin-root', 'plugins/cache', 'PLUGIN_SCRIPTS', 'CLAUDE_'],
    (token) => `fuente sin token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.mts" 2>&1',
    'claude invoca azure-account-info.mts',
  )
  absent(claude, '{{mefisto:', 'claude sin directivas sin resolver')
  absent(claude, 'claude --agent', 'claude sin claude --agent')
  absent(claude, 'az ', 'claude sin az directo')
  absent(claude, 'PLUGIN_SCRIPTS', 'claude sin PLUGIN_SCRIPTS')
  absent(claude, 'plugins/cache', 'claude sin plugins/cache')
  contains(claude, 'tooling-investigator', 'claude delega en tooling-investigator')
  contains(claude, 'bug-investigator', 'claude delega en bug-investigator')
  contains(
    beforeFirst(afterFirst(claude, 'Si entorno desplegado'), 'Si ambas validaciones pasan'),
    'azure-account-info.mts',
    'claude valida Azure antes de delegar a bug-investigator',
  )
  absent(
    beforeFirst(afterFirst(claude, 'Si tooling'), 'Si entorno desplegado'),
    'azure-account-info.mts',
    'claude: la ruta tooling no exige Azure',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  mirrorMatches(command)
  contains(
    mirror,
    'GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/bug.md',
    'mirror conserva marcador generado',
  )
  check(
    'inventario de dist/claude lo incluye',
    () => jsonStrings(inventoryJson()).includes('commands/bug.md'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})
