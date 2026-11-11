// Contrato del agente historiador neutral y su proyeccion publicada. La consolidacion del
// historial, que ejecuta el bloque de shell del agente, la cubre test-historiador-agent.sh.

import { describe } from 'node:test'

import { repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  generatedMarker,
  metadataMatches,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('historiador')
const { body, claude: claudeBody } = AGENT

describe('[a] metadata y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata agent/historiador/all/balanced/read+edit+shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'historiador',
          mode: 'all',
          profile: 'balanced',
          capabilities: ['read', 'edit', 'shell'],
        },
        keys: ['capabilities', 'description', 'effort', 'id', 'kind', 'mode', 'profile'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:state-path pipeline-history.jsonl}}', 'historial canonico via state-path')
  contains(body, '{{mefisto:instructions-path}}', 'politica de ramas remite a instructions-path')
  contains(claudeBody, 'model: "sonnet"', 'Claude materializa balanced')
  contains(claudeBody, 'name: "historiador"', 'Claude expone el id')
})

describe('[b] consolidacion del historial', () => {
  contains(body, 'HISTORIALES_LEGACY', 'legacy declarado en su propio bloque')
})

describe('[c] sin CLAUDE.md literal ni tokens de runtime', () => {
  absent(body, 'CLAUDE.md', 'fuente sin CLAUDE.md literal')
  for (const forbidden of ['model:', 'tools:', 'allowed-tools:', 'permission:', '.plugin-root', 'CLAUDE_']) {
    absent(body, forbidden, `fuente sin token de runtime: ${forbidden}`)
  }
})

describe('[d] contrato del mensaje final', () => {
  contains(body, 'PR #123', 'menciona el formato PR #<numero>')
  contains(body, 'debe incluir explicitamente el numero del PR', 'exige reportar el numero')
  contains(body, 'mergear el PR no es tu trabajo', 'prohibe mergear')
  contains(body, 'git push -u origin HEAD', 'conserva push')
  contains(body, 'gh pr create --base main', 'conserva gh pr create')
})

describe('[e] mirror', () => {
  check(
    'mirror Claude coincide byte a byte',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror Claude diverge',
  )
  contains(AGENT.mirror, generatedMarker(AGENT.id), 'mirror conserva marcador generado')
  check(
    'generate-published-adapters --check al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
