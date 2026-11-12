// Contrato del comando batch-stop neutral y su proyeccion publicada
// (issue #1596: migracion desde el formato Claude-only commands/batch-stop.md).

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
  lineCount,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('batch-stop')
const { body, claude, mirror } = command

// Forma previa a #2206: la raiz de la senal era --show-toplevel sin pasar por --git-common-dir.
const SOLO_TOPLEVEL =
  'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ERROR: no estas en un repositorio git"; exit 1; }\npgrep'

// Un token de shell independiente (entre inicio o fin de linea, espacio o `;`, `&`, `|`), no una
// subcadena de otra palabra como "rm" dentro de "confirmar".
function absentWord(text: string, word: string, name: string): void {
  const token = new RegExp(`(^|[;&| \\t\\v\\f\\r])${word}([ \\t\\v\\f\\r]|$)`)
  check(name, () => lineCount(text, token) === 0)
}

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(command, { profile: 'fast' }, 'metadata sin arguments, agent ni capabilities (CA-1)')
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor antes del proceso')
  guardPrecedesOperation(command, /pgrep -f/)
  contains(body, '{{mefisto:command sequential}}', 'referencia neutral a sequential')
  contains(body, '{{mefisto:command parallel}}', 'referencia neutral a parallel')
  contains(body, '{{mefisto:command batch-stop}}', 'autoreferencia neutral (confirmacion ya dada)')
  contains(body, 'pgrep -f "[s]cripts/batch-pipeline\\.mts"', 'patron de deteccion sin auto-coincidencia')
  contains(body, 'pipeline-state/batch-stop', 'ruta de la senal relativa a la raiz del repo')
  contains(
    body,
    'git -C "$REPO_ROOT" rev-parse --git-common-dir',
    'la raiz de la senal sale de --git-common-dir (#2206)',
  )
  absent(body, SOLO_TOPLEVEL, 'la fuente ya no escribe la senal en --show-toplevel a secas (#2206)')
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
      '.claude-plugin',
      'CLAUDE_',
      '/mefisto-batch-stop',
    ],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(
    claude,
    'pgrep -f "[s]cripts/batch-pipeline\\.mts"',
    'claude conserva el patron de deteccion (CA-5a)',
  )
  contains(claude, 'pipeline-state/batch-stop', 'claude conserva la ruta de la senal (CA-5a)')
  contains(
    claude,
    'git -C "$REPO_ROOT" rev-parse --git-common-dir',
    'claude usa --git-common-dir para la raiz de la senal (#2206)',
  )
  absent(claude, SOLO_TOPLEVEL, 'claude ya no escribe la senal en --show-toplevel a secas (#2206)')
  absentWord(claude, 'kill', 'claude no invoca kill (CA-5b)')
  absentWord(claude, 'pkill', 'claude no invoca pkill (CA-5b)')
  absentWord(claude, 'rm', 'claude no invoca rm (CA-5b)')
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast (CA-5c)')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/batch-stop.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  generatorIsUpToDate()
})
