// Contrato del agente apim-gateway-scaffolder neutral y su proyeccion publicada (issue #1656).

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

const AGENT = agent('apim-gateway-scaffolder')
const { body, claude: claudeBody } = AGENT

describe('[fuente] (a) metadata y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata declara agent/apim-gateway-scaffolder/all/balanced/read-edit-shell-web sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'apim-gateway-scaffolder',
          mode: 'all',
          profile: 'balanced',
          capabilities: ['read', 'edit', 'shell', 'web'],
        },
        without: ['mcp'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:instructions-path}}', 'cita Verificacion de fuentes via instructions-path')
  contains(
    body,
    'https://api.workos.com/user_management/<client_id>/.well-known/openid-configuration',
    'Paso 0.3 apunta al discovery doc',
  )
  contains(body, 'NO VERIFICADO -- reconfirmar antes de aplicar', 'se conserva la marca NO VERIFICADO')
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

describe('[salidas] adaptador y capacidad web', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  contains(claudeBody, 'name: "apim-gateway-scaffolder"', 'Claude expone el id del agente')
  contains(claudeBody, 'model: "sonnet"', 'Claude materializa el perfil balanced como sonnet')
  contains(claudeBody, 'WebFetch', 'Claude emite WebFetch')
  contains(claudeBody, 'WebSearch', 'Claude emite WebSearch')
  absent(claudeBody, 'curl -', 'claude_body no invoca curl')
  absent(claudeBody, 'claude --agent', 'claude_body no invoca el CLI de un runtime')
})

describe('[mirror] agents/apim-gateway-scaffolder.md pasa a generado', () => {
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

describe('[org-membership] header X-Organization-Membership-Id (issue #2397)', () => {
  contains(
    body,
    '<set-header name="X-Organization-Membership-Id" exists-action="override">',
    'politica emite set-header X-Organization-Membership-Id con override',
  )
  contains(body, '${var.claim_organization_membership_id}', 'politica usa el claim de la variable')
  contains(
    body,
    'variable "claim_organization_membership_id"',
    'declara la variable claim_organization_membership_id',
  )
  contains(body, 'default     = "organization_membership_id"', 'default organization_membership_id')
  contains(body, 'los tres `<set-header>`', 'nota B10 habla de tres set-header')
  contains(
    body,
    'variable "apim_claim_organization_membership_id"',
    'apim.tf del entorno declara apim_claim_organization_membership_id',
  )
  contains(
    body,
    'claim_organization_membership_id = var.apim_claim_organization_membership_id',
    'apim.tf cablea la variable al modulo',
  )
})
