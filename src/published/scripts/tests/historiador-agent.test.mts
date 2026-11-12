// Contrato del agente historiador neutral y su proyeccion publicada, incluida la consolidacion del
// historial que hace el bloque de shell del agente.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { NO_BASH, runBashStreams, writeTree } from '../../../../scripts/tests/markdown-bash.mts'
import { countOccurrences, lineRanges, repoPath } from '../../../../scripts/tests/text-contract.mts'
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

describe('[b] consolidacion del historial, ejecutada con bash', { skip: NO_BASH }, () => {
  const block = lineRanges(claudeBody, /^HISTORIAL_CANONICO=/, /^done \| awk/)[0] ?? ''
  const CANONICAL = '.mefisto/pipeline/pipeline-history.jsonl'
  const LEGACY_NEW = '.claude/pipeline/pipeline-history.jsonl'
  const LEGACY_OLD = '.claude/pipeline/history.jsonl'
  let work = ''
  let cases = 0

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto historiador ')))
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  function consolidate(files: Record<string, string>): string {
    return runBashStreams(block, writeTree(join(work, `caso-${++cases}`), files)).stdout
  }

  test('se extrae el bloque de consolidacion', () => {
    assert.notEqual(block, '')
  })

  test('consolida las tres fuentes y cuenta una sola vez la fila identica', () => {
    const out = consolidate({
      [CANONICAL]: '{"n":"canon"}\n{"n":"dup"}\n',
      [LEGACY_NEW]: '{"n":"legacy-nuevo"}\n{"n":"dup"}\n',
      [LEGACY_OLD]: '{"n":"legacy-viejo"}\n{"n":"dup"}\n',
    })
    for (const row of ['canon', 'legacy-nuevo', 'legacy-viejo']) assert.ok(out.includes(`"${row}"`), row)
    assert.equal(countOccurrences(out, '"dup"'), 1)
  })

  test('cada fuente se lee aunque sea la unica', () => {
    assert.ok(consolidate({ [CANONICAL]: '{"n":"canon"}\n' }).includes('"canon"'))
    assert.ok(consolidate({ [LEGACY_NEW]: '{"n":"legacy-nuevo"}\n' }).includes('"legacy-nuevo"'))
    assert.ok(consolidate({ [LEGACY_OLD]: '{"n":"legacy-viejo"}\n' }).includes('"legacy-viejo"'))
  })
})
