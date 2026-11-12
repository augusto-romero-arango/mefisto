// Bloque de escritura de tenancy.strategy del paso 6 de /onboard (#1513), ejecutado con bash tal
// como sale en dist/claude: preserva los demas campos del objeto tenancy y del documento, igual
// que el escritor equivalente de /install-apim (#1504).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { isolateGitConfig } from './field-note-sandbox.mts'
import { NO_BASH, bashBlockAfterHeading, forwardSlashes, runBashBlock } from './markdown-bash.mts'
import { git } from './plugin-sandbox.mts'
import { readRepoFile, repoPath } from './text-contract.mts'

const HEADING = '### 6. Bifurcacion de auth: provision opt-in de la estrategia de tenancy (crecer vs POC)'
const PLACEHOLDER = '<mono-tenant-transitorio|multi-tenant-header>'
const WRITE_BLOCK = bashBlockAfterHeading(readRepoFile('dist/claude/commands/onboard.md'), HEADING)
const BASE = {
  projectName: 'Ejemplo',
  namespacePrefix: 'Ejemplo',
  solutionFile: 'Ejemplo.slnx',
  domainLabels: ['ventas'],
  boundedContext: { name: 'Principal', domains: ['ventas'] },
}

let work = ''
let restoreGit = (): void => {}

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto onboard-tenancy ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

function consumer(name: string, config: object): string {
  const repo = join(work, name)
  mkdirSync(join(repo, '.mefisto'), { recursive: true })
  git(repo, 'init', '--quiet', '.')
  writeFileSync(join(repo, '.mefisto', 'harness.config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return repo
}

function runWrite(repo: string, estrategia: string): { status: number | null; output: string } {
  const block = WRITE_BLOCK.replace(PLACEHOLDER, estrategia)
  // Sin el placeholder, el bloque escribiria su literal y el fallo apuntaria al lugar equivocado.
  assert.notEqual(block, WRITE_BLOCK, 'el bloque del paso 6 ya no expone el placeholder de ESTRATEGIA esperado')
  return runBashBlock(block, repo, { MEFISTO_PACKAGE_ROOT: forwardSlashes(repoPath('dist/claude')) })
}

function configOf(repo: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo, '.mefisto', 'harness.config.json'), 'utf8')) as Record<string, unknown>
}

test('se extrae el bloque bash del paso 6 de onboard.md', () => {
  assert.notEqual(WRITE_BLOCK, '', 'no se pudo extraer el bloque bash del paso 6 de onboard.md')
  assert.ok(
    !WRITE_BLOCK.includes('.tenancy = {strategy: $s}'),
    'el bloque extraido todavia reemplaza el objeto tenancy completo (.tenancy = {strategy: $s})',
  )
})

describe('escritura de tenancy.strategy', { skip: NO_BASH }, () => {
  test('[1] actualiza tenancy.strategy y preserva el campo adicional y el campo de nivel superior', () => {
    const repo = consumer('con-tenancy', { ...BASE, tenancy: { strategy: 'mono-tenant-transitorio', extra: 'preservar' } })
    const result = runWrite(repo, 'multi-tenant-header')
    assert.equal(result.status, 0, `el bloque aborto con tenancy existente: ${result.output}`)
    const config = configOf(repo)
    assert.deepEqual(config.tenancy, { strategy: 'multi-tenant-header', extra: 'preservar' })
    assert.equal(config.projectName, 'Ejemplo')
    assert.match(result.output, /escrito en/)
  })

  test('[2] crea tenancy.strategy sin alterar los demas campos del documento', () => {
    const repo = consumer('sin-tenancy', BASE)
    const result = runWrite(repo, 'multi-tenant-header')
    assert.equal(result.status, 0, `el bloque aborto sin tenancy previo: ${result.output}`)
    assert.deepEqual(configOf(repo), { ...BASE, tenancy: { strategy: 'multi-tenant-header' } })
    assert.match(result.output, /escrito en/)
  })
})
