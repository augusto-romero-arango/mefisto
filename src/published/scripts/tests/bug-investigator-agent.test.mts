// Contrato del agente bug-investigator neutral y su proyeccion publicada (issue #1667).

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

const AGENT = agent('bug-investigator')
const { body, claude: claudeBody } = AGENT

describe('[a] metadata, perfil y capacidad web', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata agent/bug-investigator/all/deep/read-edit-shell-web sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'bug-investigator',
          mode: 'all',
          profile: 'deep',
          capabilities: ['read', 'edit', 'shell', 'web'],
        },
        without: ['mcp'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:instructions-path}}', 'lee instrucciones via instructions-path')
  contains(body, '{{mefisto:config-path}}', 'lee el config via config-path')
  contains(body, 'docs/bitacora/field-notes/', 'conserva la restriccion de escritura')
  contains(body, 'plan-sites', 'usa plan-sites')
  contains(body, 'plan-metrics', 'usa plan-metrics')
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  contains(claudeBody, 'name: "bug-investigator"', 'Claude expone el id')
  contains(claudeBody, 'model: "opus"', 'Claude materializa deep como opus')
  contains(claudeBody, 'WebSearch', 'Claude emite WebSearch')
  contains(claudeBody, 'WebFetch', 'Claude emite WebFetch')
})

describe('[b] invocaciones de appinsights-query.sh', () => {
  const total = matchingLines(claudeBody, /appinsights-query\.sh/).length
  // El punto es comodin, como en el patron de grep del que viene.
  const good = matchingLines(
    claudeBody,
    /MEFISTO_RUNTIME=claude "\$\{MEFISTO_PACKAGE_ROOT\}\/scripts\/appinsights-query.sh"/,
  ).length
  check(
    `claude: ${good} invocaciones via MEFISTO_PACKAGE_ROOT con su runtime`,
    () => total > 0 && total === good,
    `claude: ${good} de ${total} invocaciones bien formadas`,
  )
})

describe('[c] ausencia de acoplamientos', () => {
  for (const [name, text] of [
    ['body', body],
    ['claude_body', claudeBody],
  ] as const) {
    check(
      `${name} sin /tmp/`,
      () => matchingLines(text, /(^|[ \t\v\f\r=])\/tmp\//).length === 0,
      `${name} con /tmp/`,
    )
    absent(text, './scripts/', `${name} sin ./scripts/`)
    check(
      `${name} sin az directo`,
      () => matchingLines(text, /(^|[^A-Za-z])az [a-z]/).length === 0,
      `${name} con az directo`,
    )
  }
  absent(body, 'CLAUDE.md', 'la fuente sin CLAUDE.md')
  absent(body, 'curl ', 'la fuente sin curl')
  absent(body, 'MEFISTO_RUNTIME=claude', 'la fuente sin runtime claude')
  absent(body, '{{mefisto:state-path tmp}}/../', 'sin escape del state-path')
  contains(body, '{{mefisto:state-path tmp}}/publish', 'publish bajo state-path tmp')
  contains(body, '{{mefisto:state-path tmp}}/decompiled-vieja', 'decompilado bajo state-path tmp')
})

describe('[d] mirror e inventario', () => {
  check(
    'mirror identico a dist/claude',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror diverge',
  )
  check(
    'claude inventaria el agente',
    () => inventoriesDestination(readInventory(), AGENT.mirrorPath),
    'claude no inventaria el agente',
  )
  check('generate-published-adapters --check al dia', distributionIsCurrent, '--check detecto divergencias')
})
