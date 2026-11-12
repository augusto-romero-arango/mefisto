// Contrato de ruta efectiva del flip de tenancy de /install-apim (#1504, MEF-ADR-0053): ningun
// bloque bash del comando toca el config legacy y el flip escribe la ruta que resolvio. Los
// bloques del paso 9.2 y del paso 10 se ejecutan con bash sobre repos temporales.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { isolateGitConfig } from './field-note-sandbox.mts'
import { NO_BASH, bashBlockAfterHeading, forwardSlashes, runBashBlock } from './markdown-bash.mts'
import { git } from './plugin-sandbox.mts'
import { REPO_ROOT, fencedBlocks, lineRanges, readRepoFile } from './text-contract.mts'

const COMMAND = readRepoFile('commands/install-apim.md')
const FLIP_BLOCK = bashBlockAfterHeading(COMMAND, '#### 9.2 Flip del token')
const COMMIT_BLOCK = bashBlockAfterHeading(COMMAND, '### 10. Commitear la migracion de tenancy')
const STAGE_BLOCK = lineRanges(COMMIT_BLOCK, /^if \[ "\$TENANCY_TOKEN_FLIPPED" = true \]; then$/, /^fi$/)[0] ?? ''

test('ningún bloque bash lee, escribe ni agrega directamente el config legacy', () => {
  assert.ok(
    !fencedBlocks(COMMAND, 'bash').join('\n').includes('.claude/harness.config.json'),
    'reapareció una lectura, escritura o staging directo del config legacy en un bloque bash',
  )
})

test('los bloques extraídos usan el helper compartido y la ruta escrita', () => {
  assert.ok(
    FLIP_BLOCK.includes('CONFIG_SCRIPT="${MEFISTO_PACKAGE_ROOT}/scripts/harness-config-path.mts"') &&
      FLIP_BLOCK.includes('CONFIG=$(node "$CONFIG_SCRIPT" write "$REPO_ROOT")') &&
      FLIP_BLOCK.includes('HARNESS_CONFIG_PATH=$(node "$CONFIG_SCRIPT" valid "$REPO_ROOT")') &&
      COMMIT_BLOCK.includes('git add "$CONFIG"'),
    'los bloques no usan el helper compartido o la ruta efectiva',
  )
})

describe('flip de tenancy ejecutado', { skip: NO_BASH }, () => {
  let work = ''
  let serial = 0
  let restoreGit = (): void => {}

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto install-apim-config ')))
    restoreGit = isolateGitConfig(work)
  })

  after(() => {
    restoreGit()
    rmSync(work, { recursive: true, force: true })
  })

  function repo(name: string): string {
    const dir = join(work, `${name}-${++serial}`)
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '--quiet', '.')
    return dir
  }

  function writeConfig(path: string, strategy: string, extra: string): void {
    mkdirSync(dirname(path), { recursive: true })
    const config = {
      projectName: 'Ejemplo',
      namespacePrefix: 'Ejemplo',
      solutionFile: 'Ejemplo.slnx',
      domainLabels: ['ventas'],
      boundedContext: { name: 'Principal', domains: ['ventas'] },
      tenancy: { strategy, extra },
    }
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  }

  const canonicalOf = (dir: string): string => join(dir, '.mefisto', 'harness.config.json')
  const legacyOf = (dir: string): string => join(dir, '.claude', 'harness.config.json')

  function runFlip(dir: string): { status: number | null; output: string } {
    return runBashBlock(`${FLIP_BLOCK}\n${STAGE_BLOCK}`, dir, { MEFISTO_PACKAGE_ROOT: forwardSlashes(REPO_ROOT) })
  }

  function staged(dir: string): string[] {
    return git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)
  }

  function assertValidFlip(label: string, dir: string, output: string): void {
    const config = JSON.parse(readFileSync(canonicalOf(dir), 'utf8')) as { tenancy: unknown }
    assert.deepEqual(config.tenancy, { strategy: 'multi-tenant-header', extra: 'preservar' }, label)
    assert.match(output, /escrito en/, label)
  }

  test('[1] canónico etapa (a): escribe el flip canónico y agrega al índice el config escrito', () => {
    const dir = repo('canonico')
    writeConfig(canonicalOf(dir), 'mono-tenant-transitorio', 'preservar')
    const result = runFlip(dir)
    assert.equal(result.status, 0, `canónico etapa (a) abortó: ${result.output}`)
    assertValidFlip('canónico etapa (a)', dir, result.output)
    assert.deepEqual(staged(dir), ['.mefisto/harness.config.json'])
  })

  test('[2] canónico etapa (b) no toca el archivo', () => {
    const dir = repo('ya-b')
    writeConfig(canonicalOf(dir), 'multi-tenant-header', 'preservar')
    const before = readFileSync(canonicalOf(dir), 'utf8')
    const result = runFlip(dir)
    assert.equal(result.status, 0, result.output)
    assert.equal(readFileSync(canonicalOf(dir), 'utf8'), before)
    assert.match(result.output, /ya esta en etapa \(b\)/)
    assert.deepEqual(staged(dir), [])
  })

  test('[3] coexistencia divergente: lee, escribe y agrega solo el canónico; legacy intacto', () => {
    const dir = repo('ambos')
    writeConfig(canonicalOf(dir), 'mono-tenant-transitorio', 'preservar')
    writeConfig(legacyOf(dir), 'multi-tenant-header', 'legacy')
    const legacyBefore = readFileSync(legacyOf(dir), 'utf8')
    const result = runFlip(dir)
    assert.equal(result.status, 0, `coexistencia abortó: ${result.output}`)
    assertValidFlip('coexistencia divergente', dir, result.output)
    assert.equal(readFileSync(legacyOf(dir), 'utf8'), legacyBefore)
    assert.match(result.output, /se ignora el legacy/)
    assert.deepEqual(staged(dir), ['.mefisto/harness.config.json'])
  })

  test('[4] solo legacy, en etapa (a) o (b), rechaza la escritura con instrucción de migración', () => {
    const dir = repo('legacy')
    for (const strategy of ['mono-tenant-transitorio', 'multi-tenant-header']) {
      writeConfig(legacyOf(dir), strategy, 'legacy')
      const before = readFileSync(legacyOf(dir), 'utf8')
      const result = runFlip(dir)
      assert.notEqual(result.status, 0, `solo legacy en ${strategy} no bloqueó`)
      assert.equal(readFileSync(legacyOf(dir), 'utf8'), before, strategy)
      assert.match(result.output, /Migra primero el config a/, strategy)
    }
  })

  test('[4] ausencia de ambos configs aborta', () => {
    const result = runFlip(repo('ausente'))
    assert.notEqual(result.status, 0)
    assert.match(result.output, /no se encontro el config canonico requerido/)
  })
})
