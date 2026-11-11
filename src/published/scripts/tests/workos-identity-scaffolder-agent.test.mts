// Contrato del agente workos-identity-scaffolder neutral y su proyeccion publicada (issue #1654).

import { describe } from 'node:test'

import { repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  generatedMarker,
  inventoriesDestination,
  isRegularFile,
  metadataMatches,
  readInventory,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('workos-identity-scaffolder')
const { body, claude: claudeBody } = AGENT
const SEARCH =
  'dotnet package search WorkOS.net --exact-match --format json --source https://api.nuget.org/v3/index.json'

describe('[fuente] (a) metadata y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata declara agent/workos-identity-scaffolder/all/balanced/read-edit-shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'workos-identity-scaffolder',
          mode: 'all',
          profile: 'balanced',
          capabilities: ['read', 'edit', 'shell'],
        },
        without: ['mcp'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:instructions-path}}', 'lee RootNamespace via instructions-path')
})

describe('[fuente] (b) ausencia de curl y de tokens de runtime', () => {
  for (const pattern of [
    'curl',
    'export MEFISTO_INSTRUCTIONS_PATH',
    '.claude',
    'claude --agent',
    'AGENTS.md',
    'CLAUDE.md',
  ]) {
    absent(body, pattern, `fuente no contiene '${pattern}'`)
  }
})

describe('[c] Paso 0.5 usa dotnet package search', () => {
  contains(body, SEARCH, 'Paso 0.5 usa dotnet package search')
  contains(body, '5.5.0', 'se conserva la version fijada 5.5.0')
  contains(body, 'NO VERIFICADO contra NuGet en esta corrida', 'se conserva la marca NO VERIFICADO')
})

describe('[salida] adaptador', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  contains(claudeBody, 'name: "workos-identity-scaffolder"', 'Claude expone el id del agente')
  contains(claudeBody, 'model: "sonnet"', 'Claude materializa el perfil balanced como sonnet')
  contains(claudeBody, SEARCH, 'claude_body conserva dotnet package search')
  absent(claudeBody, 'claude --agent', 'claude_body no invoca el CLI de un runtime')
})

describe('[mirror] agents/workos-identity-scaffolder.md pasa a generado', () => {
  check(
    'mirror Claude coincide byte a byte',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror Claude diverge',
  )
  contains(AGENT.mirror, generatedMarker(AGENT.id), 'mirror conserva marcador generado')
  check(
    'claude inventaria el agente',
    () => inventoriesDestination(readInventory(), AGENT.mirrorPath),
    'claude no inventaria el agente',
  )
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
