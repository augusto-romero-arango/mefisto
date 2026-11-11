// Contrato del agente pr-sync neutral y su proyeccion publicada.

import { describe } from 'node:test'

import { matchingLines, repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  generatedMarker,
  isRegularFile,
  metadataMatches,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('pr-sync')
const { body, claude: claudeBody } = AGENT

describe('[fuente] contrato neutral y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata declara agent/pr-sync/all/balanced/shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: { kind: 'agent', id: 'pr-sync', mode: 'all', profile: 'balanced', capabilities: ['shell'] },
        keys: ['capabilities', 'description', 'effort', 'id', 'kind', 'mode', 'profile'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:run pr-sync.sh <PRs>}}', 'invoca pr-sync.sh sin merge')
  contains(body, '{{mefisto:run pr-sync.sh <PRs> --merge}}', 'invoca pr-sync.sh con merge y lista de PRs')
  contains(body, '{{mefisto:run pr-sync.sh --all}}', 'invoca pr-sync.sh con --all sin merge')
  contains(body, '{{mefisto:run pr-sync.sh --all --merge}}', 'invoca pr-sync.sh con --all y merge')
  contains(body, '{{mefisto:run pr-sync.sh <num>}}', 'reintento de un PR puntual via directiva run')
  contains(body, '{{mefisto:state-path logs}}', 'apunta al log via state-path')
  contains(body, 'pr-sync-<ts>.log', 'nombre de log con timestamp fuera de la directiva')
  contains(body, '{{mefisto:command merge}}', 'recomienda /mefisto:merge para el flujo con validaciones')
  absent(body, 'work-status', 'no remite a work-status')
  contains(body, 'NUNCA instales software', 'regla: nunca instalar software')
  contains(body, 'NUNCA ejecutes comandos git/gh por tu cuenta', 'regla: nunca compensar con git/gh manuales')
  contains(body, 'NUNCA diagnostiques ni arregles problemas del script', 'regla: nunca diagnosticar el script')
  contains(body, 'listar PRs', 'flujo: listar PRs')
  contains(body, 'confirma el orden', 'flujo: confirmar el orden')
  contains(body, 'reportar resultado', 'flujo: reportar resultado')
  contains(body, 'sincronizados', 'reporta PRs sincronizados')
  contains(body, 'mergeados', 'reporta PRs mergeados')
  contains(body, 'al día', 'reporta PRs al dia')
  contains(body, 'no lo inspecciones tú', 'worktree temporal queda como sugerencia al usuario, no como comando propio')
  absent(body, './scripts/', 'fuente no referencia ./scripts/ con ruta relativa')
  for (const forbidden of [
    'Claude',
    '.claude/',
    'cache',
    'model:',
    'tools:',
    'allowed-tools:',
    'permission:',
    '.plugin-root',
    'CLAUDE_',
  ]) {
    absent(body, forbidden, `fuente no publica token prohibido: ${forbidden}`)
  }
})

describe('[salidas] adaptador y mirror', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  for (const form of ['<PRs>', '<PRs> --merge', '--all', '--all --merge', '<num>']) {
    contains(
      claudeBody,
      `MEFISTO_RUNTIME=claude "\${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh" ${form}`,
      `Claude invoca pr-sync.sh ${form} con su runtime`,
    )
  }
  contains(claudeBody, 'name: "pr-sync"', 'Claude expone el id del agente')
  contains(claudeBody, 'tools: "Bash"', 'Claude deriva solo la capacidad shell')
  contains(claudeBody, 'model: "sonnet"', 'Claude materializa el perfil balanced')
  check('Claude omite MCP', () => !/[Mm][Cc][Pp]/.test(claudeBody))

  // El preambulo compartido que fija MEFISTO_PACKAGE_ROOT cita el marcador Claude como fallback
  // de lectura; solo se exige que las invocaciones propias de pr-sync.sh no lo reimplementen.
  const claudeInvocations = matchingLines(claudeBody, 'scripts/pr-sync.sh"')
    .map((line) => line.text)
    .join('\n')
  for (const forbiddenPath of ['./scripts/pr-sync.sh', '.claude/pipeline/.plugin-root', 'plugins/cache']) {
    absent(
      claudeInvocations,
      forbiddenPath,
      `invocacion Claude no reimplementa el lookup legacy (${forbiddenPath})`,
    )
  }
  absent(claudeBody, 'plugins/cache', 'salida Claude completa sin cache de plugins')
  absent(claudeBody, './scripts/pr-sync.sh', 'salida Claude completa sin ruta relativa rota')

  check(
    'mirror Claude coincide byte a byte',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror Claude diverge',
  )
  contains(AGENT.mirror, generatedMarker(AGENT.id), 'mirror conserva marcador generado')
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
