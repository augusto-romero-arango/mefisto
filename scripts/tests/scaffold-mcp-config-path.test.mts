// Contrato de resolucion de config de /scaffold-mcp (#1501): canonico, coexistencia, fallback
// legacy y ausencia, y que el comando y el agente lean los tokens por la ruta efectiva.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'

import { resolveHarnessConfigPath } from '../lib/harness-config.mts'
import { readRepoFile } from './text-contract.mts'

const COMMAND = readRepoFile('commands/scaffold-mcp.md')
const AGENT = readRepoFile('agents/mcp-scaffolder.md')

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto scaffold-mcp ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const canonicalOf = (root: string): string => join(root, '.mefisto', 'harness.config.json')
const legacyOf = (root: string): string => join(root, '.claude', 'harness.config.json')

function writeConfig(path: string, namespace: string, solution: string, domain: string, tenancy: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      namespacePrefix: namespace,
      solutionFile: solution,
      boundedContext: { domains: [domain] },
      tenancy: { strategy: tenancy },
    })}\n`,
  )
}

function tokens(path: string): string {
  const config = JSON.parse(readFileSync(path, 'utf8'))
  return [
    config.namespacePrefix,
    config.solutionFile,
    config.boundedContext.domains[0],
    config.tenancy.strategy,
  ].join('|')
}

function resolve(root: string): { path: string; warnings: string[] } {
  const warnings: string[] = []
  const path = resolveHarnessConfigPath('read', root, { warn: (message) => warnings.push(message) })
  return { path, warnings }
}

function assertConfig(label: string, root: string, expectedPath: string, expectedTokens: string): void {
  const { path } = resolve(root)
  assert.deepEqual(
    { path, tokens: tokens(path) },
    { path: expectedPath, tokens: expectedTokens },
    `${label} esperaba ${expectedPath} (${expectedTokens})`,
  )
}

function bothRoot(): string {
  const root = join(work, 'both')
  writeConfig(canonicalOf(root), 'Canonical', 'Canonical.slnx', 'canonical-domain', 'multi-tenant-header')
  writeConfig(legacyOf(root), 'Legacy', 'Legacy.slnx', 'legacy-domain', 'mono-tenant-transitorio')
  return root
}

test('canonico resuelve los cuatro tokens esperados', () => {
  const root = join(work, 'canonical')
  writeConfig(canonicalOf(root), 'Canonical', 'Canonical.slnx', 'canonical-domain', 'multi-tenant-header')
  assertConfig('canonico', root, canonicalOf(root), 'Canonical|Canonical.slnx|canonical-domain|multi-tenant-header')
})

test('ambos resuelve los cuatro tokens esperados', () => {
  const root = bothRoot()
  assertConfig('ambos', root, canonicalOf(root), 'Canonical|Canonical.slnx|canonical-domain|multi-tenant-header')
})

test('ambos emite el AVISO canonico', () => {
  const root = bothRoot()
  assert.ok(
    resolve(root)
      .warnings.join('\n')
      .includes(
        `AVISO: se usara el config canonico ${canonicalOf(root)}; se ignora el legacy ${legacyOf(root)}. Migra o elimina conscientemente el archivo legacy para evitar divergencias.`,
      ),
    'ambos no emite el AVISO canonico',
  )
})

test('legacy resuelve los cuatro tokens esperados', () => {
  const root = join(work, 'legacy')
  writeConfig(legacyOf(root), 'Legacy', 'Legacy.slnx', 'legacy-domain', 'mono-tenant-transitorio')
  assertConfig('legacy', root, legacyOf(root), 'Legacy|Legacy.slnx|legacy-domain|mono-tenant-transitorio')
})

test('ausencia aborta y explica el contrato canonico y el fallback', () => {
  const root = join(work, 'missing')
  mkdirSync(root, { recursive: true })
  assert.throws(
    () => resolve(root),
    (error: Error) =>
      error.message.includes(`config canonico requerido ${canonicalOf(root)}`) &&
      error.message.includes(`fallback legacy ${legacyOf(root)}`),
    'ausencia debe abortar y explicar el contrato canonico y el fallback',
  )
})

for (const [name, text] of [
  ['scaffold-mcp.md', COMMAND],
  ['mcp-scaffolder.md', AGENT],
] as const) {
  test(`${name} resuelve canonico, fallback y AVISO mediante el preludio renderizado`, () => {
    assert.ok(
      text.includes('MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"') &&
        text.includes('MEFISTO_CONFIG_PATH=".claude/harness.config.json"') &&
        text.includes(
          'AVISO: se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json.',
        ),
      `${name} no contiene el resolver requerido`,
    )
  })
}

test('los tokens se leen desde la ruta efectiva del config', () => {
  assert.ok(
    COMMAND.includes(`json-value.mts" get "\${MEFISTO_CONFIG_PATH}" namespacePrefix --default ''`) &&
      COMMAND.includes(`json-value.mts" get "\${MEFISTO_CONFIG_PATH}" solutionFile --default ''`) &&
      AGENT.includes(`json-value.mts" get "$CONFIG" 'boundedContext.domains[0]' --default ''`) &&
      AGENT.includes(`json-value.mts" get "$CONFIG" tenancy.strategy --default mono-tenant-transitorio`) &&
      AGENT.includes(`json-value.mts" each "$CONFIG" boundedContext.domains)`),
    'alguno de los tokens no usa la ruta efectiva',
  )
})

test('el agente prohibe escribir el config', () => {
  assert.ok(
    AGENT.includes('Nunca copies, migres ni escribas el archivo de config'),
    'el agente no documenta la prohibicion de escritura',
  )
})
