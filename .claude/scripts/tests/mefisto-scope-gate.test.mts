import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { git, isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import { changedPaths } from '../../../src/internal/scripts/lib/mefisto-changed-paths.mts'
import { validateMefistoScopeChanges } from '../../../src/internal/scripts/lib/mefisto-scope-gate.mts'

const SCOPE_NOTE = [
  '',
  'Mefisto solo permite cambios en: commands/, skills/, agents/, scripts/,',
  'hooks/, docs/, .claude-plugin/, .claude/{commands,skills,agents,scripts,mods}/,',
  '.claude/settings.json, .mcp.json, src/{internal,published,runtime}/, dist/,',
  '.github/{workflows,rulesets}/, AGENTS.md,',
  'changelog.d/, README.md, CHANGELOG.md, CLAUDE.md, .gitignore, .gitattributes, LICENSE, NOTICE',
]

function diagnostic(violations: string[]): string[] {
  return ['ERROR: cambios fuera del scope de Mefisto:', ...violations.map((path) => `  - ${path}`), ...SCOPE_NOTE]
}

// Rutas limite: se compara el texto tal cual, sin normalizar.
const LIMIT_PATHS = [
  'commands/foo.md',
  'skills/projections/SKILL.md',
  'agents/x.md',
  'scripts/lib/cli.mts',
  'hooks/hooks.json',
  'docs/adr/mef-adr-0001.md',
  'src/internal/x.ts',
  'src/published/x.md',
  'src/runtime/x.sh',
  'dist/claude/plugin.json',
  '.claude-plugin/plugin.json',
  '.claude/commands/x.md',
  '.claude/skills/x/SKILL.md',
  '.claude/agents/x.md',
  '.claude/scripts/x.sh',
  '.claude/mods/x/register.tsx',
  '.claude/settings.json',
  '.mcp.json',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  '.gitignore',
  '.gitattributes',
  'AGENTS.md',
  'LICENSE',
  'NOTICE',
  'mefisto-manifest.json',
  'changelog.d/1.added.md',
  '.github/workflows/ci.yml',
  '.github/rulesets/main.json',
  'src/Foo.cs',
  'src/otro/x.sh',
  'src/publication/foo.md',
  'src/runtime-local/foo.sh',
  'src/internal',
  'src/',
  'distribution/x',
  'dist-local/x',
  'dist',
  'tests/Foo.cs',
  'infra/main.tf',
  '.github/CODEOWNERS',
  '.github/workflows',
  '.claude/harness.config.json',
  '.claude/settings.local.json',
  '.claude/settings.json/x',
  '.claude/pipeline/x',
  '.mefisto/harness.config.json',
  'sub/README.md',
  'README.md.bak',
  'LICENSE.txt',
  'sub/LICENSE',
  'docs2/NOTICE',
  'x/.mcp.json',
  'mefisto-manifest.json/x',
  './commands/foo.md',
  '../commands/foo.md',
  '/commands/foo.md',
  'x/../commands/foo.md',
  'commands/../src/Foo.cs',
  'commands//foo.md',
  'Commands/foo.md',
  'DOCS/x.md',
  'readme.md',
  'commands\\foo.md',
  'src\\internal\\x.ts',
  ' commands/foo.md',
  'commands /foo.md',
  'README.md ',
  'commands/*',
  '*',
  '[c]ommands/x',
  'comm?nds/x',
  'commands/"x"',
  '"commands/a\\303\\261o.md"',
  '"fuera/a\\303\\261o.md"',
  '$HOME/commands/x',
  '-n',
  'commands/ñandú.md',
  'ñ/commands/x',
  'src/internal/a -> fuera/b',
  'fuera/a -> src/internal/b',
  'docs',
  'x',
]

interface FakeGit {
  diff?: string
  status?: string
}

function fakeGit(outputs: FakeGit): { run: Run; calls: string[][] } {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    const text = args.includes('diff') ? outputs.diff : outputs.status
    return text === undefined ? { status: 128, stdout: '', stderr: 'fatal' } : { status: 0, stdout: text, stderr: '' }
  }
  return { run, calls }
}

describe('changedPaths', () => {
  test('consulta lo commiteado desde la base y lo pendiente, con los archivos sin trackear uno a uno', () => {
    const { run, calls } = fakeGit({ diff: 'docs/a.md\n', status: ' M scripts/b.sh\n?? src/internal/c.ts\n' })
    assert.deepEqual(changedPaths('/wt', 'abc123', { run }), ['docs/a.md', 'scripts/b.sh', 'src/internal/c.ts'])
    assert.deepEqual(calls, [
      ['git', '-C', '/wt', 'diff', '--name-only', 'abc123..HEAD'],
      ['git', '-C', '/wt', 'status', '--porcelain', '--untracked-files=all'],
    ])
  })

  test('no quita repetidos ni lineas en blanco con contenido, y solo recorta el estado de git status', () => {
    const { run } = fakeGit({
      diff: 'docs/a.md\n\n  \ndocs/a.md\n',
      status: 'R  docs/a.md -> docs/b.md\nA  "docs/a\\303\\261o.md"\n D x\n',
    })
    assert.deepEqual(changedPaths('/wt', 'abc', { run }), [
      'docs/a.md',
      '  ',
      'docs/a.md',
      'docs/a.md -> docs/b.md',
      '"docs/a\\303\\261o.md"',
      'x',
    ])
  })

  test('un git que falla no aporta rutas', () => {
    assert.deepEqual(changedPaths('/wt', 'abc', { run: fakeGit({}).run }), [])
    assert.deepEqual(changedPaths('/wt', 'abc', { run: fakeGit({ status: '?? x\n' }).run }), ['x'])
  })
})

describe('validateMefistoScopeChanges', () => {
  let tmp = ''
  let counter = 0
  let restoreGit = (): void => {}

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mefisto scope gate '))
    restoreGit = isolateGitConfig(tmp)
  })

  after(() => {
    restoreGit()
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Repo con un commit base: el gate compara `base..HEAD` mas el arbol de trabajo. */
  function newRepo(): { repo: string; base: string } {
    counter += 1
    const repo = join(tmp, `repo ${counter}`)
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@mefisto.local')
    git(repo, 'config', 'user.name', 'test')
    write(repo, 'README.md', '# base\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-q', '-m', 'base')
    return { repo, base: git(repo, 'rev-parse', 'HEAD') }
  }

  function write(repo: string, path: string, content = 'x\n'): void {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }

  test('[A] un arbol nuevo sin trackear bajo src/internal/ pasa el gate', () => {
    const { repo, base } = newRepo()
    write(repo, 'src/internal/contract/internal-artifact.schema.json', '{}\n')
    write(repo, 'src/internal/contract/fixtures/valid/ejemplo.md')
    assert.deepEqual(validateMefistoScopeChanges(repo, base), { violations: [], message: [] })
  })

  test('[B] un arbol nuevo sin trackear bajo .claude/agents/ pasa el gate', () => {
    const { repo, base } = newRepo()
    write(repo, '.claude/agents/writer.md')
    assert.deepEqual(validateMefistoScopeChanges(repo, base), { violations: [], message: [] })
  })

  test('[C] un archivo bajo un directorio nuevo fuera de scope se rechaza nombrando el archivo', () => {
    const { repo, base } = newRepo()
    write(repo, 'fuera/nuevo/archivo.txt', 'y\n')
    const check = validateMefistoScopeChanges(repo, base)
    assert.deepEqual(check.violations, ['fuera/nuevo/archivo.txt'])
    assert.deepEqual(check.message, diagnostic(['fuera/nuevo/archivo.txt']))
    assert.equal(check.message.includes('  - fuera/'), false)
  })

  test('[D] en una mezcla solo se lista lo que cae fuera de scope', () => {
    const { repo, base } = newRepo()
    write(repo, 'src/internal/scripts/validar.sh')
    write(repo, 'otro/cosa.md', 'y\n')
    const check = validateMefistoScopeChanges(repo, base)
    assert.deepEqual(check.violations, ['otro/cosa.md'])
    assert.equal(check.message.some((line) => line.includes('- src/internal/')), false)
  })

  test('lista primero lo commiteado y despues lo pendiente, sin quitar repetidos', () => {
    const { run } = fakeGit({
      diff: 'src/Foo.cs\ndocs/a.md\ninfra/main.tf\n',
      status: ' M src/Foo.cs\n?? tests/Nuevo.cs\n?? scripts/x.sh\n D .github/CODEOWNERS\n',
    })
    const check = validateMefistoScopeChanges('/wt', 'abc', { run })
    assert.deepEqual(check.violations, ['src/Foo.cs', 'infra/main.tf', 'src/Foo.cs', 'tests/Nuevo.cs', '.github/CODEOWNERS'])
    assert.deepEqual(check.message, diagnostic(check.violations))
  })

  test('juzga un renombre pendiente por su origen y una ruta citada por sus comillas', () => {
    const { run } = fakeGit({
      diff: '',
      status: 'R  src/internal/a.md -> fuera/a.md\nR  fuera/b.md -> src/internal/b.md\nA  "docs/a\\303\\261o.md"\n',
    })
    assert.deepEqual(validateMefistoScopeChanges('/wt', 'abc', { run }).violations, [
      'fuera/b.md -> src/internal/b.md',
      '"docs/a\\303\\261o.md"',
    ])
  })

  test('un git que falla no aporta rutas', () => {
    assert.deepEqual(validateMefistoScopeChanges('/wt', 'abc', { run: fakeGit({}).run }), { violations: [], message: [] })
  })

  describe('sobre repos reales', () => {
    /** Las rutas fuera de scope, comprobando que el diagnostico las nombra. */
    function violationsOf(repo: string, base: string): string[] {
      const check = validateMefistoScopeChanges(repo, base)
      assert.deepEqual(check.message, check.violations.length > 0 ? diagnostic(check.violations) : [])
      return check.violations
    }

    test('rechaza exactamente las rutas limite fuera de la allowlist, commiteadas o pendientes', () => {
      const rejected = [
      'src/Foo.cs',
      'src/otro/x.sh',
      'src/publication/foo.md',
      'src/runtime-local/foo.sh',
      'src/internal',
      'src/',
      'distribution/x',
      'dist-local/x',
      'dist',
      'tests/Foo.cs',
      'infra/main.tf',
      '.github/CODEOWNERS',
      '.github/workflows',
      '.claude/harness.config.json',
      '.claude/settings.local.json',
      '.claude/settings.json/x',
      '.claude/pipeline/x',
      '.mefisto/harness.config.json',
      'sub/README.md',
      'README.md.bak',
      'LICENSE.txt',
      'sub/LICENSE',
      'docs2/NOTICE',
      'x/.mcp.json',
      'mefisto-manifest.json/x',
      './commands/foo.md',
      '../commands/foo.md',
      '/commands/foo.md',
      'x/../commands/foo.md',
      'Commands/foo.md',
      'DOCS/x.md',
      'readme.md',
      'commands\\foo.md',
      'src\\internal\\x.ts',
      ' commands/foo.md',
      'commands /foo.md',
      'README.md ',
      '*',
      '[c]ommands/x',
      'comm?nds/x',
      '"commands/a\\303\\261o.md"',
      '"fuera/a\\303\\261o.md"',
      '$HOME/commands/x',
      '-n',
      'ñ/commands/x',
      'fuera/a -> src/internal/b',
      'docs',
      'x',
      ]
      const committed = fakeGit({ diff: LIMIT_PATHS.map((path) => `${path}\n`).join(''), status: '' })
      assert.deepEqual(validateMefistoScopeChanges('/wt', 'abc', { run: committed.run }).violations, rejected)
      const pending = fakeGit({ diff: '', status: LIMIT_PATHS.map((path) => `?? ${path}\n`).join('') })
      assert.deepEqual(validateMefistoScopeChanges('/wt', 'abc', { run: pending.run }).violations, rejected)
    })

    test('sin cambios y con cambios dentro de scope', () => {
      const { repo, base } = newRepo()
      assert.deepEqual(violationsOf(repo, base), [])
      write(repo, 'docs/bitacora/nota.md')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'dentro')
      write(repo, 'src/internal/contract/fixtures/valid/ejemplo.md')
      write(repo, '.claude/agents/writer.md')
      write(repo, 'README.md', '# cambio\n')
      assert.deepEqual(violationsOf(repo, base), [])
    })

    test('con cambios fuera de scope commiteados, preparados, sin trackear, renombrados y borrados', () => {
      const { repo, base } = newRepo()
      write(repo, 'docs/guia.md')
      write(repo, 'docs/se-va.md')
      write(repo, 'scripts/queda.sh')
      write(repo, 'src/Foo.cs')
      write(repo, 'infra/borrar.tf')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'agente')
      write(repo, 'src/Foo.cs', 'cambio\n')
      write(repo, 'tests/preparado.cs')
      git(repo, 'add', 'tests/preparado.cs')
      write(repo, 'fuera/nuevo/archivo.txt')
      write(repo, 'fuera/con espacio/a.md')
      write(repo, 'fuera/año.md')
      write(repo, 'docs/año.md')
      git(repo, 'mv', 'docs/guia.md', 'guia-fuera.md')
      git(repo, 'mv', 'docs/se-va.md', 'docs/se-queda.md')
      git(repo, 'rm', '-q', 'infra/borrar.tf')
      rmSync(join(repo, 'scripts/queda.sh'))
      const violations = violationsOf(repo, base)
      assert.ok(violations.length >= 7, violations.join('|'))
      for (const path of ['src/Foo.cs', 'fuera/nuevo/archivo.txt', '"fuera/con espacio/a.md"', '"docs/a\\303\\261o.md"']) {
        assert.ok(violations.includes(path), path)
      }
      assert.equal(violations.some((path) => path.includes('se-queda')), false)

      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'todo commiteado')
      assert.deepEqual(violationsOf(repo, base), [
        '"docs/a\\303\\261o.md"',
        '"fuera/a\\303\\261o.md"',
        'fuera/con espacio/a.md',
        'fuera/nuevo/archivo.txt',
        'guia-fuera.md',
        'src/Foo.cs',
        'tests/preparado.cs',
      ])
    })

    test('con HEAD separado y con una base que no existe', () => {
      const { repo, base } = newRepo()
      write(repo, 'src/Foo.cs')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'fuera')
      write(repo, 'otro/cosa.md')
      git(repo, 'checkout', '-q', '--detach')
      assert.deepEqual(violationsOf(repo, base), ['src/Foo.cs', 'otro/cosa.md'])
      assert.deepEqual(violationsOf(repo, 'no-es-un-commit'), ['otro/cosa.md'])
      assert.deepEqual(violationsOf(join(tmp, 'no-es-un-repo'), base), [])
    })
  })
})
