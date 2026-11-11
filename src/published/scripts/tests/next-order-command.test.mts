// Contrato del comando next-order neutral y su proyeccion publicada.
// La linea de lanzamiento es el literal /mefisto:sequential: el validador no
// admite una directiva anidada en los argumentos de `run`, y el adaptador
// materializa {{mefisto:command}} como /mefisto:<id>, asi que el literal es igual.

import { describe } from 'node:test'

import {
  absent,
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryHasDestination,
  isExecutable,
  mirrorMatches,
  sameBytes,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('next-order')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(command, { profile: 'fast' }, 'metadata sin arguments, agent ni capabilities')
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(
    body,
    '{{mefisto:run next-order.sh --launch-command "/mefisto:sequential" --parallel-command "/mefisto:parallel"}}',
    'invocacion neutral del script',
  )
  contains(body, 'El lote parallel lo calcula el script', 'delega el lote parallel al script')
  contains(body, 'ADVERTENCIA', 'conserva la advertencia de universo truncado')
  contains(body, '$ARGUMENTS', 'avisa que ignora argumentos')
  contains(body, 'solo lectura', 'regla de solo lectura')
  absentAll(
    body,
    ['.claude/', '.plugin-root', 'plugins/cache', 'claude --agent'],
    (token) => `fuente sin token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(
    claude,
    '"${MEFISTO_PACKAGE_ROOT}/scripts/next-order.sh" --launch-command "/mefisto:sequential" --parallel-command "/mefisto:parallel"',
    'Claude invoca next-order.sh',
  )
  absent(claude, 'claude --agent', 'sin claude --agent')
  absent(claude, '{{mefisto:', 'sin directivas sin resolver')
  absent(claude, 'plugins/cache', 'sin plugins/cache')
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  mirrorMatches(command)
  contains(
    mirror,
    'GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/next-order.md',
    'mirror conserva marcador generado',
  )
})

describe('[assets] next-order.sh empaquetado', () => {
  check(
    'next-order.sh ejecutable en dist/claude',
    () => isExecutable('dist/claude/scripts/next-order.sh'),
    'falta next-order.sh ejecutable en dist/claude',
  )
  check(
    'dist/claude identico a la fuente',
    () => sameBytes('scripts/next-order.sh', 'dist/claude/scripts/next-order.sh'),
    'dist/claude diverge de la fuente',
  )
  check(
    'inventario de dist/claude lo incluye',
    () => inventoryHasDestination('scripts/next-order.sh'),
    'inventario de dist/claude no lo incluye',
  )
  generatorIsUpToDate()
})
