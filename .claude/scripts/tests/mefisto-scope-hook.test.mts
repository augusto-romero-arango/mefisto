import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isPathInMefistoScope } from '../../../src/internal/scripts/lib/mefisto-scope.mts'
import { editedPath, relativeToRoot, scopeWarning } from '../mefisto-scope-hook.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const HOOK = join(HERE, '..', 'mefisto-scope-hook.mts')
const BASH_LIB = join(REPO_ROOT, 'src', 'internal', 'scripts', 'lib', '_mefisto-common.sh')

const IN_SCOPE = [
  'docs/bitacora/prueba.md',
  '.claude/scripts/mefisto-tooling-pipeline.sh',
  '.claude/settings.json',
  '.claude/mods/mefisto-divine-wager/hooks/register.tsx',
  '.mcp.json',
  'changelog.d/523.added.md',
  'commands/implement.md',
  'skills/projections/SKILL.md',
  'CLAUDE.md',
  'src/internal/foo.ts',
  'src/published/foo.md',
  'src/runtime/foo.sh',
  'dist/x',
  'AGENTS.md',
  '.github/workflows/typescript.yml',
  '.github/rulesets/main.json',
  'mefisto-manifest.json',
  'LICENSE',
  '.gitattributes',
]

const OUT_OF_SCOPE = [
  'src/Foo.cs',
  'src/otro/x.sh',
  'src/publication/foo.md',
  'src/runtime-local/foo.sh',
  'distribution/x',
  'dist-local/x',
  'tests/Foo.Tests/FooTests.cs',
  '.github/CODEOWNERS',
  '.claude/harness.config.json',
  'infra/main.tf',
]

function payload(filePath: string): string {
  return JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } })
}

let repo = ''

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'mefisto scope '))
  execFileSync('git', ['init', '--quiet', repo])
  writeFileSync(join(repo, '.gitignore'), '.claude/pipeline/\n.mefisto/\n*.log\n')
})

after(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('allowlist', () => {
  test('acepta las rutas del plugin y rechaza las del consumidor', () => {
    for (const path of IN_SCOPE) assert.equal(isPathInMefistoScope(path), true, path)
    for (const path of OUT_OF_SCOPE) assert.equal(isPathInMefistoScope(path), false, path)
    for (const path of ['', 'docs', 'scripts', '.claude/settings.local.json', 'src/internal']) {
      assert.equal(isPathInMefistoScope(path), false, path)
    }
  })

  test(
    'coincide con is_path_in_mefisto_scope de la libreria bash',
    { skip: process.platform === 'win32' ? 'la libreria bash no corre en Windows' : false },
    () => {
      const samples = [...IN_SCOPE, ...OUT_OF_SCOPE, 'docs', 'docs/', 'README.md', 'NOTICE', 'x']
      const script =
        'source "$0" >/dev/null 2>&1; for p in "$@"; do if is_path_in_mefisto_scope "$p"; then echo 1; else echo 0; fi; done'
      const out = execFileSync('bash', ['-c', script, BASH_LIB, ...samples], { encoding: 'utf8' })
      const fromBash = out.trim().split('\n')
      assert.equal(fromBash.length, samples.length)
      samples.forEach((path, i) => {
        assert.equal(isPathInMefistoScope(path), fromBash[i] === '1', path)
      })
    },
  )
})

describe('entrada del hook', () => {
  test('editedPath toma file_path y, si falta, path', () => {
    assert.equal(editedPath({ tool_input: { file_path: 'a.md', path: 'b.md' } }), 'a.md')
    assert.equal(editedPath({ tool_input: { path: 'b.md' } }), 'b.md')
    assert.equal(editedPath({ tool_input: { file_path: '' } }), null)
    assert.equal(editedPath({ tool_input: {} }), null)
    assert.equal(editedPath({}), null)
    assert.equal(editedPath(null), null)
    assert.equal(editedPath('texto'), null)
  })

  test('relativeToRoot devuelve la ruta con / o null si queda fuera', () => {
    assert.equal(relativeToRoot(repo, 'docs/a.md'), 'docs/a.md')
    assert.equal(relativeToRoot(repo, join(repo, 'src', 'Foo.cs')), 'src/Foo.cs')
    assert.equal(relativeToRoot(repo, join(repo, '..', 'otro', 'x.md')), null)
    assert.equal(relativeToRoot(repo, repo), null)
  })
})

describe('veredicto', () => {
  test('una ruta en scope no avisa, relativa o absoluta', () => {
    for (const path of IN_SCOPE) assert.equal(scopeWarning(repo, payload(path)), null, path)
    assert.equal(scopeWarning(repo, payload(join(repo, 'docs', 'bitacora', 'prueba.md'))), null)
  })

  test('una ruta fuera de scope avisa con un mensaje accionable', () => {
    for (const path of OUT_OF_SCOPE) assert.notEqual(scopeWarning(repo, payload(path)), null, path)
    const message = scopeWarning(repo, payload(join(repo, 'src', 'Foo.cs'))) ?? ''
    assert.match(message, /'src\/Foo\.cs'/)
    assert.match(message, /is_path_in_mefisto_scope/)
    assert.match(message, /MEF-ADR-0019 seccion E/)
    assert.match(message, /revierte/)
    assert.ok(message.includes('src/{internal,published,runtime}/, dist/'))
  })

  test('una ruta ignorada por git no avisa', () => {
    for (const path of [
      '.claude/pipeline/summaries/stage-1-writer.md',
      '.mefisto/pipeline/summaries/stage-1-writer.md',
      'tests/salida.log',
    ]) {
      assert.equal(isPathInMefistoScope(path), false, path)
      assert.equal(scopeWarning(repo, payload(path)), null, path)
    }
  })

  test('degrada sin avisar ante entrada ilegible o archivo fuera del repo', () => {
    assert.equal(scopeWarning(repo, ''), null)
    assert.equal(scopeWarning(repo, 'no soy json {{{'), null)
    assert.equal(scopeWarning(repo, '{"tool_name":"Write","tool_input":{}}'), null)
    assert.equal(scopeWarning(repo, payload('')), null)
    assert.equal(scopeWarning(repo, payload(join(tmpdir(), 'fuera-del-repo.txt'))), null)
  })

  test('fuera de un repo git no avisa', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mefisto sin repo '))
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = dirname(outside)
    try {
      assert.equal(scopeWarning(outside, payload('src/Foo.cs')), null)
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('linea de comando y cableado', () => {
  function run(input: string) {
    return spawnSync(process.execPath, [HOOK], { cwd: repo, input, encoding: 'utf8' })
  }

  test('en scope termina en 0 sin ruido', () => {
    const result = run(payload('docs/a.md'))
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  })

  test('fuera de scope termina en 2 con el aviso en stderr', () => {
    const result = run(payload('src/Foo.cs'))
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /FUERA DE SCOPE: 'src\/Foo\.cs'/)
  })

  test('una entrada ilegible termina en 0', () => {
    assert.equal(run('no soy json').status, 0)
    assert.equal(run('').status, 0)
  })

  test('settings.json invoca este hook en forma exec, anclado al proyecto', () => {
    const settings = JSON.parse(
      readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> } }
    const [entry] = settings.hooks.PostToolUse
    assert.equal(entry?.matcher, 'Edit|Write')
    assert.deepEqual(entry?.hooks, [
      {
        type: 'command',
        command: 'node',
        args: ['${CLAUDE_PROJECT_DIR}/.claude/scripts/mefisto-scope-hook.mts'],
      },
    ])
    assert.equal(existsSync(HOOK), true)
  })
})
