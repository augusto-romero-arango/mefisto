// Bloques bash del comando install-apim publicado, ejecutados con bash tal como salen en
// dist/claude: el flip de tenancy del paso 9.2 y la deteccion de servidores MCP del paso 2b. Lo
// que se verifica leyendo el texto del comando esta en install-apim-command.test.mts.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { isolateGitConfig } from '../../../../scripts/tests/field-note-sandbox.mts'
import {
  NO_BASH,
  bashBlockAfterHeading,
  forwardSlashes,
  runBashBlock,
} from '../../../../scripts/tests/markdown-bash.mts'
import { git } from '../../../../scripts/tests/plugin-sandbox.mts'
import { readRepoFile, repoPath } from '../../../../scripts/tests/text-contract.mts'

const CLAUDE = readRepoFile('dist/claude/commands/install-apim.md')
const FLIP = bashBlockAfterHeading(CLAUDE, '#### 9.2 Flip del token')
const MCP_BLOCK = bashBlockAfterHeading(CLAUDE, '### 2b. Detectar los servidores MCP del BC', true)
const PACKAGE_ROOT = { MEFISTO_PACKAGE_ROOT: forwardSlashes(repoPath('dist/claude')) }

let work = ''
let restoreGit = (): void => {}

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto install-apim ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

function repo(name: string): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet', '.')
  return dir
}

function writeConfig(path: string, strategy: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const config = {
    projectName: 'Ejemplo',
    namespacePrefix: 'Ejemplo',
    solutionFile: 'Ejemplo.slnx',
    domainLabels: ['ventas'],
    boundedContext: { name: 'Principal', domains: ['ventas'] },
    tenancy: { strategy, extra: 'keep' },
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}

describe('[paso 9.2] flip de tenancy ejecutado con los scripts distribuidos', { skip: NO_BASH }, () => {
  test('se extrae el bloque del paso 9.2', () => {
    assert.notEqual(FLIP, '', 'no se pudo extraer el bloque del paso 9.2')
  })

  test('voltea tenancy.strategy en el canonico y preserva los demas campos; la segunda corrida es idempotente', () => {
    const dir = repo('canonico')
    const config = join(dir, '.mefisto', 'harness.config.json')
    writeConfig(config, 'mono-tenant-transitorio')
    const first = runBashBlock(FLIP, dir, PACKAGE_ROOT)
    assert.equal(first.status, 0, `no volteo el canonico: ${first.output}`)
    const written = JSON.parse(readFileSync(config, 'utf8')) as { projectName: string; tenancy: unknown }
    assert.deepEqual(written.tenancy, { strategy: 'multi-tenant-header', extra: 'keep' })
    assert.equal(written.projectName, 'Ejemplo')

    const before = readFileSync(config, 'utf8')
    const second = runBashBlock(FLIP, dir, PACKAGE_ROOT)
    assert.equal(second.status, 0, `no es idempotente: ${second.output}`)
    assert.match(second.output, /ya esta en etapa \(b\)/)
    assert.equal(readFileSync(config, 'utf8'), before)
  })

  test('aborta con solo el legacy sin modificarlo ni crear el canonico', () => {
    const dir = repo('legacy')
    const legacy = join(dir, '.claude', 'harness.config.json')
    writeConfig(legacy, 'mono-tenant-transitorio')
    const before = readFileSync(legacy, 'utf8')
    const result = runBashBlock(FLIP, dir, PACKAGE_ROOT)
    assert.notEqual(result.status, 0, 'no aborto con solo el legacy')
    assert.match(result.output, /todavía es legacy/)
    assert.equal(readFileSync(legacy, 'utf8'), before)
    assert.throws(() => readFileSync(join(dir, '.mefisto', 'harness.config.json')))
  })
})

describe('[paso 2b] deteccion de servidores MCP desde instructions-path', { skip: NO_BASH }, () => {
  test('detecta los servidores MCP con el RootNamespace de instructions-path', () => {
    const dir = join(work, 'mcp')
    mkdirSync(join(dir, 'src', 'Ejemplo.Principal.Mcp.Reportes'), { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), 'RootNamespace: Ejemplo.Principal\n')
    const result = runBashBlock(`${MCP_BLOCK}\nprintf "%s|%s" "$ROOT_NAMESPACE" "$SERVIDORES_MCP"`, dir, {
      MEFISTO_INSTRUCTIONS_PATH: 'AGENTS.md',
    })
    assert.equal(result.output, 'Ejemplo.Principal|Reportes')
  })
})
