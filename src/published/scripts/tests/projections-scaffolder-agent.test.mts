// Contrato del agente projections-scaffolder neutral y su proyeccion publicada (issue #1652).

import { describe } from 'node:test'

import { matchingLines, repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  inventoriesDestination,
  isRegularFile,
  metadataMatches,
  readInventory,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('projections-scaffolder')
const { body, claude: claudeBody } = AGENT

describe('[a] metadata y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata agent/projections-scaffolder/all/balanced/read-edit-shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'projections-scaffolder',
          mode: 'all',
          profile: 'balanced',
          capabilities: ['read', 'edit', 'shell'],
        },
        without: ['mcp'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:config-path}}', 'lee projections.enabled via config-path')
  contains(body, '{{mefisto:instructions-path}}', 'lee RootNamespace via instructions-path')
  contains(
    body,
    '{{mefisto:run validate-dockerfile.mts src/<RootNamespace>.Projections/Dockerfile}}',
    'valida el Dockerfile via run',
  )
})

describe('[b] ausencia de acoplamientos', () => {
  absent(body, '.claude/harness.config.json', 'sin config legacy')
  absent(body, 'export MEFISTO_INSTRUCTIONS_PATH', 'sin export de instrucciones')
  absent(body, 'claude --agent', 'sin invocacion directa del CLI')
  absent(body, '/tmp/', 'sin /tmp')
  check(
    'ningun rm usa $REPO_ROOT',
    () => matchingLines(body, /^[ \t\v\f\r]*rm /).every((line) => !line.text.includes('$REPO_ROOT')),
    'un rm usa $REPO_ROOT',
  )
})

describe('[salidas]', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  contains(claudeBody, 'name: "projections-scaffolder"', 'Claude expone el id')
  contains(claudeBody, 'model: "sonnet"', 'Claude materializa balanced como sonnet')
  absent(claudeBody, '/tmp/', 'Claude sin /tmp')
})

describe('[c] validacion del Dockerfile por script distribuido', () => {
  contains(
    claudeBody,
    'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/validate-dockerfile.mts"',
    'Claude invoca el script con su runtime',
  )
  absent(claudeBody, 'docker info', 'claude_body no ejecuta docker info directo')
  absent(claudeBody, 'docker build -f "src/', 'claude_body no ejecuta el docker build de validacion directo')
})

describe('[d] mirror', () => {
  check(
    'mirror identico a dist/claude',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror diverge',
  )
  check(
    'claude inventaria agente y script',
    () => {
      const inventory = readInventory()
      return (
        inventoriesDestination(inventory, AGENT.mirrorPath) &&
        inventoriesDestination(inventory, 'scripts/validate-dockerfile.mts')
      )
    },
    'claude no inventaria agente y script',
  )
  check('generate-published-adapters --check al dia', distributionIsCurrent, '--check detecto divergencias')
})
