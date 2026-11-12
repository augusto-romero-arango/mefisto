// Contrato del comando upgrade neutral y su adaptacion publicada (#1680).

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { fromLine, lineOf, linesOf } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  ascending,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  metadataOf,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('upgrade')
const { claude } = command
const name = command.claudePath
// Cuerpo propio del comando: excluye el preambulo que inyecta el adaptador.
const body = fromLine(claude, /^Actualiza Mefisto instalado/)

describe('[fuente] metadata', () => {
  sourceValidates(command)
  test('metadata: command/upgrade/fast sin arguments, agent ni capabilities', () => {
    const metadata = metadataOf(command)
    assert.deepEqual(
      {
        kind: metadata.kind,
        id: metadata.id,
        profile: metadata.profile,
        arguments: 'arguments' in metadata,
        agent: 'agent' in metadata,
        capabilities: 'capabilities' in metadata,
      },
      {
        kind: 'command',
        id: 'upgrade',
        profile: 'fast',
        arguments: false,
        agent: false,
        capabilities: false,
      },
      'metadata invalida',
    )
  })
})

describe('[salida] existencia y perfil', () => {
  claudeOutputExists(command)
  check(
    'perfil fast -> haiku en Claude',
    () =>
      linesOf(claude)
        .slice(0, 6)
        .some((line) => line.startsWith('model: "haiku"')),
    'perfil fast en Claude',
  )
})

describe('[invocaciones]', () => {
  for (const arg of ['--status', '--disable-user', '--prune --only <versiones-confirmadas>']) {
    contains(
      claude,
      `MEFISTO_RUNTIME=claude node "\${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.mts" ${arg}`,
      `${name} invoca upgrade.mts ${arg} con su runtime`,
    )
  }
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.mts" 2>&1',
    `${name} invoca la actualizacion simple`,
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/herdr-pipeline.mts" --refresh-agents',
    `${name} refresca agentes herdr`,
  )
  contains(body, 'HERDR_ENV=1', `${name} limita el refresco a herdr`)
})

describe('[actualizacion y consentimiento]', () => {
  contains(
    body,
    '**no informa si existe una version mas nueva publicada**',
    `${name}: --status es una consulta local`,
  )
  contains(
    body,
    'nunca autoriza concluir que Mefisto esta al dia',
    `${name}: --status no autoriza concluir que esta al dia`,
  )
  contains(body, '**exactamente una vez**', `${name} actualiza una sola vez por invocacion`)
  contains(
    body,
    'Nunca respondas "ya esta al dia"',
    `${name} no concluye al dia sin la salida del script`,
  )
  contains(body, 'exactamente `si`', `${name} exige confirmacion exacta`)
  contains(body, 'El update no borra nada', `${name} conserva que el update no borra`)
  check(
    `${name} precede --disable-user con su confirmacion`,
    () => ascending(lineOf(body, /MIGRACION PENDIENTE/), lineOf(body, /upgrade.mts" --disable-user/)),
    `${name} no precede --disable-user con su confirmacion`,
  )
  contains(
    body,
    'nunca ofrezcas retirar el nivel global en ese caso',
    `${name} no retira el nivel global si el repo no lo activa`,
  )
})

describe('[cierre y neutralidad]', () => {
  contains(
    body,
    'Recarga o reinicia la sesion de tu runtime para activar la version `<version-destino>`',
    `${name} cierra con reload neutral`,
  )
  contains(body, 'omitido:working', `${name} conserva aviso de panes`)
  absent(body, '/reload-plugins', `${name} sin /reload-plugins`)
  absent(body, '.plugin-root', `${name} sin .plugin-root`)
  absent(body, 'plugins/cache', `${name} sin plugins/cache`)
  absent(body, 'update-plugin.mts', `${name} no invoca update-plugin.mts directo`)
  const stripped = linesOf(body)
    .filter((line) => !line.startsWith('MEFISTO_LOADED_ROOT='))
    .join('\n')
  absent(stripped, 'CLAUDE_', `${name} sin variables CLAUDE_ salvo la raiz viva`)
  contains(body, "MEFISTO_LOADED_ROOT='${CLAUDE_PLUGIN_ROOT}'", `${name} pasa la raiz viva`)
  absent(body, 'solo desde Claude Code', `${name} sin regla transitoria`)
})

describe('[poda]', () => {
  check(
    `${name} precede la poda con su confirmacion`,
    () => ascending(lineOf(body, /pide confirmacion explicita/), lineOf(body, /upgrade.mts" --prune/)),
    `${name} no precede la poda con su confirmacion`,
  )
  contains(body, 'Nunca podes la version cargada', `${name} nunca poda la version cargada`)
})

describe('[mirror] commands/upgrade.md', () => {
  mirrorMatches(command, 'el mirror es identico a la salida Claude', 'el mirror diverge')
  generatorIsUpToDate()
})
