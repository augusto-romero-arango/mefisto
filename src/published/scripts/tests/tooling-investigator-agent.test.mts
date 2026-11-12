// Contrato del agente tooling-investigator neutral y su proyeccion publicada (issue #1668).

import { describe } from 'node:test'

import { linesOf, matchingLines, repoPath } from '../../../../scripts/tests/text-contract.mts'
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

const AGENT = agent('tooling-investigator')
const { body, claude: claudeBody } = AGENT

describe('[a] metadata y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata agent/tooling-investigator/all/deep/read-edit-shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'tooling-investigator',
          mode: 'all',
          profile: 'deep',
          capabilities: ['read', 'edit', 'shell'],
        },
        without: ['mcp'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:run work-status-collect.sh', 'usa el colector')
  contains(body, '{{mefisto:config-path}}', 'lee el config via config-path')
  contains(body, '{{mefisto:instructions-path}}', 'lee directivas via instructions-path')
  contains(body, 'docs/bitacora/field-notes/', 'conserva la restriccion de escritura')
  contains(body, '.mefisto/', 'cubre .mefisto/')
  contains(body, 'repoSlug', 'conserva el routing via repoSlug')
  contains(body, 'pgrep -fl "[s]cripts/[a-z]+-pipeline\\.(sh|mts)"', 'detecta pipelines vivos como .sh y como .mts')
  contains(claudeBody, 'pgrep -fl "[s]cripts/[a-z]+-pipeline\\.(sh|mts)"', 'claude conserva la deteccion .sh|.mts')
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
})

describe('[b] invocacion del colector', () => {
  const total = matchingLines(claudeBody, /work-status-collect\.sh/).length
  // El punto es comodin, como en el patron de grep del que viene.
  const good = matchingLines(
    claudeBody,
    /MEFISTO_RUNTIME=claude "\$\{MEFISTO_PACKAGE_ROOT\}\/scripts\/work-status-collect.sh"/,
  ).length
  check(
    `claude: ${good} invocaciones via MEFISTO_PACKAGE_ROOT`,
    () => total > 0 && total === good,
    `claude: ${good} de ${total} invocaciones bien formadas`,
  )
})

describe('[c] ausencia de acoplamientos', () => {
  for (const [name, full] of [
    ['body', body],
    ['claude_body', claudeBody],
  ] as const) {
    const text = linesOf(full)
      .filter((line) => !line.includes('.plugin-root'))
      .join('\n')
    absent(text, '.claude/pipeline/', `${name} sin .claude/pipeline/`)
    absent(text, 'tooling-status.json', `${name} sin tooling-status.json`)
    absent(text, 'tooling-history.jsonl', `${name} sin tooling-history.jsonl`)
    absent(text, 'status.json', `${name} sin status.json`)
    absent(text, 'history.jsonl', `${name} sin history.jsonl`)
    absent(text, 'Claude Code', `${name} sin Claude Code`)
  }
  absent(body, '.claude/', 'la fuente sin .claude/')
  absent(body, 'CLAUDE.md', 'la fuente sin CLAUDE.md')
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
