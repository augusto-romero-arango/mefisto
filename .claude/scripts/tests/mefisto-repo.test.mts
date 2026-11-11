import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CliError } from '../../../scripts/lib/cli.mts'
import { assertInMefisto, ensureGithooksInstalled } from '../../../src/internal/scripts/lib/mefisto-repo.mts'

let work = ''

function initRepo(name: string): string {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--quiet', repo])
  return repo
}

function hooksPath(repo: string): string {
  try {
    return execFileSync('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const savedEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto repo '))
  // Aisla la config global y de sistema: un core.hooksPath del usuario cambiaria el veredicto.
  writeFileSync(join(work, 'gitconfig-vacio'), '')
  process.env.GIT_CONFIG_GLOBAL = join(work, 'gitconfig-vacio')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(work, { recursive: true, force: true })
})

describe('assertInMefisto', () => {
  test('acepta el repo que tiene el manifiesto del plugin y lee su nombre', () => {
    const repo = initRepo('plugin')
    mkdirSync(join(repo, '.claude-plugin'))
    writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'mefisto-x' }))
    const sub = join(repo, 'docs')
    mkdirSync(sub)
    const info = assertInMefisto(sub)
    assert.equal(info.projectName, 'mefisto-x')
    assert.equal(typeof info.repoSlug, 'string')
    assert.ok(info.root.length > 0)
  })

  test('un manifiesto ilegible cae al nombre por defecto', () => {
    const repo = initRepo('ilegible')
    mkdirSync(join(repo, '.claude-plugin'))
    writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), '{no es json')
    assert.equal(assertInMefisto(repo).projectName, 'mefisto')
  })

  test('rechaza un repo consumidor con un mensaje accionable', () => {
    const repo = initRepo('consumidor')
    assert.throws(
      () => assertInMefisto(repo),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 1 &&
        /solo se ejecuta dentro del repo de Mefisto/.test(error.message) &&
        /skills\n {2}publicados/.test(error.message),
    )
  })

  test('rechaza una carpeta que no es un repo git', () => {
    const outside = join(work, 'sin repo')
    mkdirSync(outside)
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = work
    try {
      assert.throws(() => assertInMefisto(outside), /no estas en un repositorio git/)
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
    }
  })
})

describe('ensureGithooksInstalled', () => {
  test('configura core.hooksPath si esta vacio y es idempotente', () => {
    const repo = initRepo('hooks')
    const first = ensureGithooksInstalled(repo)
    assert.match(first ?? '', /core\.hooksPath configurado a src\/internal\/githooks/)
    assert.equal(hooksPath(repo), 'src/internal/githooks')
    assert.equal(ensureGithooksInstalled(repo), null)
  })

  test('no pisa un core.hooksPath ajeno', () => {
    const repo = initRepo('hooks ajenos')
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.husky'])
    assert.match(ensureGithooksInstalled(repo) ?? '', /apunta a '\.husky'; no se pisa/)
    assert.equal(hooksPath(repo), '.husky')
  })
})
