// Contrato del comando bitacora neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryText,
  linesInOrder,
  mirrorMatches,
  repoFileExists,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('bitacora')
const { body, claude } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '[YYYY-MM-DD]' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:launch-agent historiador ', 'delegacion puntual a historiador')
  contains(body, 'unicamente las field notes del dia <fecha>', 'mensaje con filtro de fecha')
  contains(body, '{{mefisto:command-doc merge}}', 'lee command-doc merge')
  contains(body, 'gh pr view <num> --json number,state,headRefName,files', 'verifica el PR con gh pr view')
  contains(body, 'docs/bitacora/', 'exige archivos bajo docs/bitacora/')
  contains(body, 'mensaje final', 'PR tomado del mensaje final')
  contains(body, 'No pidas ninguna confirmacion adicional', 'sin confirmacion antes de mergear')
  contains(body, 'gh pr merge', 'regla de no merges manuales')
  contains(body, 'No diagnostiques errores de `pr-sync.sh`', 'regla de no diagnosticar pr-sync')
  absentAll(
    body,
    [
      'claude --agent',
      '.plugin-root',
      'plugins/cache',
      'commands/merge.md',
      'CLAUDE_',
      '.claude/',
      'PLUGIN_ROOT',
    ],
    (token) => `fuente sin token prohibido: ${token}`,
  )
  linesInOrder(
    command.source,
    [
      '{{mefisto:assert-consumer-repo}}',
      '{{mefisto:launch-agent historiador ',
      'gh pr view <num>',
      '{{mefisto:command-doc merge}}',
    ],
    'orden: guard -> historiador -> verificacion del PR -> merge',
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  contains(claude, 'mefisto:historiador', 'Claude delega en mefisto:historiador')
  contains(claude, '"${MEFISTO_PACKAGE_ROOT}/commands/merge.md"', 'Claude lee merge')
  check(
    'existe dist/claude/commands/merge.md',
    () => repoFileExists('dist/claude/commands/merge.md'),
    'falta dist/claude/commands/merge.md',
  )
  absentAll(claude, ['plugins/cache', 'claude --agent'], (token) => `claude sin token de runtime: ${token}`)
  mirrorMatches(command)
  check(
    'inventario de dist/claude lo incluye',
    () => inventoryText().includes('commands/bitacora.md'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})
