// Corte vertical neutral de infra-writer e infra-reviewer (issue #1625): metadata y perfiles,
// allowlist MCP de Claude, ausencia de tokens de runtime en la fuente y paridad de los espejos.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  INVENTORY_FILE,
  absent,
  agent,
  check,
  checkInto,
  contains,
  distributionIsCurrent,
  generateInto,
  lowerAscii,
  metadataMatches,
  readInventory,
  readOrEmpty,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const WRITER = agent('infra-writer')
const REVIEWER = agent('infra-reviewer')
const AGENTS = [WRITER, REVIEWER]
const SOURCES = AGENTS.map((each) => each.sourcePath)
const WORK = mkdtempSync(join(tmpdir(), 'mefisto infra agents '))
const GENERATED = await generateInto(WORK, SOURCES)

after(() => {
  rmSync(WORK, { recursive: true, force: true })
})

describe('[a] metadata y perfiles de la fuente neutral', () => {
  for (const [each, profile] of [
    [WRITER, 'balanced'],
    [REVIEWER, 'deep'],
  ] as const) {
    check(
      `${each.id} valida contra el contrato`,
      () => sourceValidates(repoPath(each.sourcePath)),
      `${each.id} no valida contra el contrato`,
    )
    check(
      `${each.id} declara kind/id/mode/profile/capabilities esperados`,
      () =>
        metadataMatches(each.metadata, {
          equal: {
            kind: 'agent',
            id: each.id,
            mode: 'all',
            profile,
            capabilities: ['read', 'edit', 'shell', 'skill'],
            skills: ['code-comments'],
          },
        }),
      `${each.id} no declara kind/id/mode/profile/capabilities esperados`,
    )
  }
  const writerMcp = WRITER.metadata.mcp ?? []
  const reviewerMcp = REVIEWER.metadata.mcp ?? []
  check(
    'infra-writer declara mcp: ["terraform"]',
    () => isDeepStrictEqual(writerMcp, ['terraform']),
    `infra-writer declaro mcp inesperado: ${JSON.stringify(writerMcp)}`,
  )
  check(
    'infra-reviewer no declara mcp',
    () => isDeepStrictEqual(reviewerMcp, []),
    `infra-reviewer declaro mcp inesperado: ${JSON.stringify(reviewerMcp)}`,
  )
})

describe('[d] ausencia de tokens de runtime en la fuente neutral', () => {
  for (const each of AGENTS) {
    contains(each.body, '{{mefisto:assert-consumer-repo}}', `${each.id} conserva el guard`)
    for (const token of [
      '.claude',
      'claude',
      'marketplace',
      'cache',
      'model:',
      'tools:',
      'permission:',
      'allowed-tools:',
    ]) {
      absent(lowerAscii(each.body), token, `${each.id} no menciona token de runtime: ${token}`)
    }
  }
})

describe('[integracion] generacion de las dos salidas y check limpio', () => {
  check(
    'el generador procesa ambos agentes en conjunto',
    () => GENERATED.status === 0,
    'el generador no proceso ambos agentes en conjunto',
  )
})

describe('[b] allowlist MCP de Claude', () => {
  const claudeWriter = readOrEmpty(join(WORK, 'dist', 'claude', 'agents', 'infra-writer.md'))
  const claudeReviewer = readOrEmpty(join(WORK, 'dist', 'claude', 'agents', 'infra-reviewer.md'))
  contains(claudeWriter, 'mcp__terraform__*', 'Claude writer expone el matcher corto de terraform')
  contains(
    claudeWriter,
    'mcp__plugin_terraform_terraform__*',
    'Claude writer expone el matcher scoped del plugin terraform',
  )
  contains(claudeWriter, 'model: "sonnet"', 'Claude writer materializa perfil balanced')
  contains(claudeReviewer, 'model: "opus"', 'Claude reviewer materializa perfil deep')
  absent(claudeReviewer, 'mcp__', 'Claude reviewer no expone ningun matcher MCP')
})

describe('[e] mirrors identicos', () => {
  for (const each of AGENTS) {
    check(
      `integracion publica el mirror raiz de ${each.id}`,
      () =>
        sameBytes(
          join(WORK, 'agents', `${each.id}.md`),
          join(WORK, 'dist', 'claude', 'agents', `${each.id}.md`),
        ),
      `integracion no publica el mirror raiz de ${each.id}`,
    )
    check(
      `el mirror raiz versionado de ${each.id} coincide con dist/claude`,
      () => sameBytes(repoPath(each.mirrorPath), repoPath(each.claudePath)),
      `el mirror raiz versionado de ${each.id} diverge de dist/claude`,
    )
  }
})

describe('[inventario] la distribucion registra los dos agentes', () => {
  const inventory = readInventory(join(WORK, 'dist', 'claude', INVENTORY_FILE))
  for (const each of AGENTS) {
    check(
      `claude inventaria ${each.id}`,
      () => inventory.assets.some((asset) => asset.id === each.sourcePath),
      `claude no inventaria ${each.id}`,
    )
  }
  check(
    'check aislado no detecta divergencias, huerfanos ni copias manuales',
    async () => (await checkInto(WORK, SOURCES)).status === 0,
    'check aislado detecto divergencias, huerfanos o copias manuales',
  )
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
