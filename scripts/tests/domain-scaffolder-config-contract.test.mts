// Lecturas del contrato del consumidor en domain-scaffolder (#1408, MEF-ADR-0053 seccion 4): ni la
// fuente neutral ni la salida generada hardcodean la ruta legacy del config, y las lecturas
// ejecutadas salen solo del config efectivo.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { NO_BASH, forwardSlashes, runBashStreams, writeTree } from './markdown-bash.mts'
import { REPO_ROOT, fencedBlocks, matchingLines, readRepoFile } from './text-contract.mts'

const SOURCE = readRepoFile('src/published/agents/domain-scaffolder.md')
const GENERATED = readRepoFile('agents/domain-scaffolder.md')
const LEGACY_JQ_READ = /(jq|json-value\.mts"?)\s.*\.claude\/harness\.config\.json/

test('src/published/agents/domain-scaffolder.md no hardcodea la ruta del config en los comandos jq', () => {
  assert.deepEqual(
    matchingLines(SOURCE, LEGACY_JQ_READ),
    [],
    'src/published/agents/domain-scaffolder.md conserva una lectura jq con ruta hardcodeada',
  )
})

test('la fuente neutral usa las directivas efectivas de config e instructions', () => {
  assert.ok(
    SOURCE.includes('{{mefisto:config-path}}') && SOURCE.includes('{{mefisto:instructions-path}}'),
    'la fuente neutral no usa {{mefisto:config-path}} y/o {{mefisto:instructions-path}}',
  )
})

test('Claude: las lecturas de serviceBus.external/tenancy.strategy usan la ruta efectiva, sin ruta legacy hardcodeada', () => {
  assert.ok(
    matchingLines(GENERATED, /\$\{?MEFISTO_CONFIG_PATH\}?/).length > 0 &&
      matchingLines(GENERATED, LEGACY_JQ_READ).length === 0,
    'Claude: alguna lectura del config no paso por la ruta efectiva',
  )
})

test('Claude: la ausencia de instrucciones remite a onboard', () => {
  assert.ok(
    GENERATED.includes('/mefisto:onboard'),
    'Claude: no remite a onboard cuando faltan las instrucciones efectivas',
  )
})

// El preambulo del config efectivo y las dos lecturas del agente generado, ejecutados con bash:
// los alias de serviceBus.external y tenancy.strategy salen solo del config seleccionado.
describe('[ejecucion] alias y tenancy proceden del config efectivo', { skip: NO_BASH }, () => {
  const preamble = fencedBlocks(GENERATED, 'bash').find((block) => block.includes('MEFISTO_CONFIG_PATH=')) ?? ''
  const reads = matchingLines(
    GENERATED,
    /json-value\.mts" (each|get) "\$\{MEFISTO_CONFIG_PATH\}" (serviceBus\.external|tenancy\.strategy) /,
  ).map((line) => line.text)
  const script = [preamble, ...reads].join('\n')
  const env = { MEFISTO_PACKAGE_ROOT: forwardSlashes(REPO_ROOT) }
  const config = (alias: string, strategy: string): string =>
    `${JSON.stringify({ serviceBus: { external: [{ alias, alcance: 'compartido' }] }, tenancy: { strategy } })}\n`
  const CANONICAL = config('canonico-alias', 'multi-tenant-header')
  const LEGACY = config('legacy-alias', 'mono-tenant-transitorio')
  let work = ''

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto domain config ')))
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  const run = (name: string, files: Record<string, string>) =>
    runBashStreams(script, writeTree(join(work, name), files), env)

  test('se extrajeron el preambulo y las dos lecturas del config', () => {
    assert.notEqual(preamble, '')
    assert.equal(reads.length, 2)
  })

  test('config canonico resuelve alias y tenancy sin aviso', () => {
    const result = run('canonico', { '.mefisto/harness.config.json': CANONICAL, 'AGENTS.md': '# AGENTS\n' })
    assert.deepEqual(result, { status: 0, stdout: 'canonico-alias\nmulti-tenant-header\n', stderr: '' })
  })

  test('config legacy resuelve como fallback de lectura', () => {
    const result = run('legacy', { '.claude/harness.config.json': LEGACY, 'AGENTS.md': '# AGENTS\n' })
    assert.deepEqual(result, { status: 0, stdout: 'legacy-alias\nmono-tenant-transitorio\n', stderr: '' })
  })

  test('coexistencia usa solo el canonico y deja visible que ignora el legacy', () => {
    const result = run('ambos', {
      '.mefisto/harness.config.json': CANONICAL,
      '.claude/harness.config.json': LEGACY,
      'AGENTS.md': '# AGENTS\n',
    })
    assert.equal(result.stdout, 'canonico-alias\nmulti-tenant-header\n')
    assert.ok(result.stderr.includes('se ignora el legacy'), result.stderr)
  })

  test('la ausencia de ambos configs aborta antes de resolver alias o tenancy', () => {
    const result = run('ausente', {})
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
  })
})
