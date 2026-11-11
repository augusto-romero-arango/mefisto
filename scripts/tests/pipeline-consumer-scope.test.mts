import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Run } from '../lib/azure-cli.mts'
import { resolveHarnessConfigPath } from '../lib/harness-config.mts'
import { isPathInConsumerBlocklist, validateConsumerScopeChanges } from '../lib/pipeline/consumer-scope.mts'
import { git, isolateGitConfig } from './field-note-sandbox.mts'
import { bashLibrary, NO_BASH } from './pipeline-scope-parity.mts'

const BLOCKED = [
  'commands/foo.md',
  'skills/projections/SKILL.md',
  'skills/projections/reference.md',
  'agents/bar.md',
  'hooks/baz.json',
  '.claude-plugin/plugin.json',
  'src/published/foo.md',
  'src/runtime/foo.sh',
  'dist/claude/plugin.json',
  'mefisto-manifest.json',
  'docs/adr/mef-adr-0001-service-bus-topics-por-evento.md',
  'commands/x.md',
  'agents/x.md',
  'hooks/x.sh',
]

const ALLOWED = [
  'src/Foo.cs',
  'src/publication/foo.md',
  'src/runtime-local/foo.sh',
  'distribution/foo.txt',
  'tests/Bar.cs',
  '.github/workflows/deploy.yml',
  '.claude/settings.json',
  'docs/bitacora/notes.md',
  'docs/testing/mefisto-certification/fixture.md',
  'docs/adr/0028-x.md',
  'docs/adr/ca-adr-0009-x.md',
  'AGENTS.md',
  '.github/workflows/ci.yml',
  '.github/rulesets/main.json',
  'sub/mefisto-manifest.json',
  'mefisto-manifest.json.bak',
  'foo-mefisto-manifest.json',
  'mefisto-manifest.json/foo',
  'mefisto-manifest.json\\foo',
  '.mefisto/harness.config.json',
  '.claude/harness.config.json',
  '.github/dependabot.yml',
  '.mefisto/appinsights.env',
  '.mcp.json',
]

// Rutas limite: la gemela bash compara el texto tal cual, sin normalizar.
const LIMIT = [
  '',
  '.',
  '/',
  'commands',
  'commands/',
  'skills',
  'dist',
  'dist/',
  'src/published',
  'src/published/',
  'src/runtime',
  'src/runtimes/x',
  '.claude-plugin',
  '.claude-plugins/x',
  'hooks.json',
  'agents.md',
  'docs/adr/',
  'docs/adr/mef-adr',
  'docs/adr/mef-adr-',
  'docs/adr/MEF-ADR-0001.md',
  './commands/foo.md',
  './mefisto-manifest.json',
  '../commands/foo.md',
  'x/../commands/foo.md',
  'commands/../src/Foo.cs',
  '/commands/foo.md',
  'commands//foo.md',
  'Commands/foo.md',
  'COMMANDS/FOO.MD',
  'Skills/x',
  'Dist/x',
  'Src/Published/x',
  'Mefisto-Manifest.json',
  'commands\\foo.md',
  'src\\published\\foo.md',
  '.claude-plugin\\plugin.json',
  'docs\\adr\\mef-adr-0001.md',
  'docs/adr\\mef-adr-0001.md',
  ' commands/foo.md',
  'commands /foo.md',
  'commands/foo.md ',
  'mefisto-manifest.json ',
  'mefisto-manifest.json\n',
  'commands/a\nb',
  'x\ncommands/foo',
  '*',
  'commands/*',
  'docs/adr/mef-adr-*',
  '[c]ommands/x',
  'comm?nds/x',
  "com'mands/x",
  'commands/"x"',
  '$HOME/commands/x',
  '-n',
  '--',
  'commands/ñandú.md',
  'ñ/commands/x',
]

describe('isPathInConsumerBlocklist', () => {
  test('bloquea las rutas del plugin y deja pasar las del consumidor', () => {
    for (const path of BLOCKED) assert.equal(isPathInConsumerBlocklist(path, 'linux'), true, path)
    for (const path of ALLOWED) assert.equal(isPathInConsumerBlocklist(path, 'linux'), false, path)
  })

  test('fuera de Windows compara el texto tal cual', () => {
    for (const path of ['commands/', 'dist/', 'src/published/', 'docs/adr/mef-adr-', 'commands//foo.md', 'commands/a\nb']) {
      assert.equal(isPathInConsumerBlocklist(path, 'darwin'), true, path)
    }
    for (const path of [
      '',
      'commands',
      './commands/foo.md',
      'x/../commands/foo.md',
      '/commands/foo.md',
      'Commands/foo.md',
      'Mefisto-Manifest.json',
      'commands\\foo.md',
      'docs\\adr\\mef-adr-0001.md',
      ' commands/foo.md',
      'mefisto-manifest.json\n',
    ]) {
      assert.equal(isPathInConsumerBlocklist(path, 'darwin'), false, path)
    }
  })

  test('en Windows normaliza separadores y mayusculas, sin volverse mas permisivo', () => {
    for (const path of [
      'commands\\foo.md',
      'src\\published\\foo.md',
      '.claude-plugin\\plugin.json',
      'docs\\adr\\mef-adr-0001.md',
      'docs/adr\\mef-adr-0001.md',
      'Commands/foo.md',
      'COMMANDS\\FOO.MD',
      'Dist/x',
      'Mefisto-Manifest.json',
      'docs/adr/MEF-ADR-0001.md',
    ]) {
      assert.equal(isPathInConsumerBlocklist(path, 'win32'), true, path)
    }
    for (const path of [...BLOCKED, ...ALLOWED, ...LIMIT]) {
      if (isPathInConsumerBlocklist(path, 'linux')) assert.equal(isPathInConsumerBlocklist(path, 'win32'), true, path)
    }
    for (const path of ['mefisto-manifest.json\\foo', 'src\\Foo.cs', 'Docs\\adr\\0028-x.md', '']) {
      assert.equal(isPathInConsumerBlocklist(path, 'win32'), false, path)
    }
  })

  test('coincide con is_path_in_consumer_blocklist de la libreria bash', { skip: NO_BASH }, () => {
    const samples = [...BLOCKED, ...ALLOWED, ...LIMIT]
    const result = bashLibrary(
      'for p in "$@"; do if is_path_in_consumer_blocklist "$p"; then echo 1; else echo 0; fi; done',
      samples,
    )
    assert.equal(result.status, 0, result.stderr)
    const fromBash = result.stdout.trim().split('\n')
    assert.equal(fromBash.length, samples.length)
    samples.forEach((path, index) => {
      assert.equal(isPathInConsumerBlocklist(path), fromBash[index] === '1', JSON.stringify(path))
    })
  })
})

interface FakeGit {
  diff?: string
  status?: string
  branch?: string
}

function fakeGit(outputs: FakeGit): { run: Run; calls: string[][] } {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    const text = args.includes('diff') ? outputs.diff : args.includes('status') ? outputs.status : outputs.branch
    return text === undefined ? { status: 128, stdout: '', stderr: 'fatal' } : { status: 0, stdout: text, stderr: '' }
  }
  return { run, calls }
}

function diagnostic(violations: string[], repoSlug: string, branch: string): string[] {
  return [
    'ERROR: el agente toco rutas reservadas al plugin Mefisto:',
    ...violations.map((path) => `  - ${path}`),
    '',
    'Las rutas commands/, skills/, agents/, hooks/, .claude-plugin/, src/published/, src/runtime/, dist/ y los archivos',
    `docs/adr/mef-adr-* pertenecen al plugin (repo ${repoSlug}).`,
    '',
    `El resto del trabajo del agente NO se perdio: ya quedo commiteado en '${branch}'.`,
    'Para recuperarlo, revierte ahi los archivos listados arriba y abre el PR a mano.',
    'Si necesitas modificar el plugin, abre un draft en su repo:',
    `  gh issue create -R ${repoSlug} \\`,
    '    --label "estado:borrador,tipo:tooling" --title "..."',
  ]
}

const DEFAULT_SLUG = 'augusto-romero-arango/mefisto'
const VIOLATION = 'A  docs/adr/mef-adr-0001-ejemplo.md\n'

function minimalConfig(repoSlug: string): string {
  const slug = repoSlug.length > 0 ? `  "repoSlug": "${repoSlug}",\n` : ''
  return `{
  "projectName": "Prueba",
  "namespacePrefix": "Prueba.Backend",
  "solutionFile": "Prueba.slnx",
  "infraResourceGroupPrefix": "rg-prueba",
  "githubServicePrincipalName": "github-prueba-ci",
  "appInsightsApp": "appi-prueba",
  "domainLabels": ["prueba"],
${slug}  "boundedContext": { "name": "Principal", "domains": ["prueba"] }
}
`
}

describe('validateConsumerScopeChanges', () => {
  let tmp = ''

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mefisto consumer scope '))
  })

  after(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function configFile(name: string, repoSlug: string): string {
    const path = join(tmp, name, '.mefisto', 'harness.config.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, minimalConfig(repoSlug))
    return path
  }

  test('consulta lo commiteado desde la base y lo pendiente', () => {
    const { run, calls } = fakeGit({ diff: 'src/Foo.cs\n', status: ' M tests/Bar.cs\n' })
    assert.deepEqual(validateConsumerScopeChanges('/wt', 'abc123', { run }), { violations: [], message: [] })
    assert.deepEqual(calls, [
      ['git', '-C', '/wt', 'diff', '--name-only', 'abc123..HEAD'],
      ['git', '-C', '/wt', 'status', '--porcelain'],
    ])
  })

  test('acepta un fixture documental del consumidor', () => {
    const { run } = fakeGit({ diff: '', status: 'A  docs/testing/mefisto-certification/fixture.md\n' })
    assert.deepEqual(validateConsumerScopeChanges('/wt', 'abc', { run }).violations, [])
  })

  test('rechaza un ADR del marco y explica como recuperar el trabajo', () => {
    const { run, calls } = fakeGit({ diff: '', status: VIOLATION, branch: 'worktree-issue-7-x\n' })
    const check = validateConsumerScopeChanges('/wt', 'abc', { run })
    assert.deepEqual(check.violations, ['docs/adr/mef-adr-0001-ejemplo.md'])
    assert.deepEqual(check.message, diagnostic(check.violations, DEFAULT_SLUG, 'worktree-issue-7-x'))
    assert.deepEqual(calls.at(-1), ['git', '-C', '/wt', 'rev-parse', '--abbrev-ref', 'HEAD'])
  })

  test('lista primero lo commiteado, despues lo pendiente, y no quita repetidos', () => {
    const { run } = fakeGit({
      diff: 'commands/x.md\nsrc/Foo.cs\ndist/claude/a\n',
      status: ' M commands/x.md\n?? hooks/\n?? src/Nuevo.cs\nAM mefisto-manifest.json\n',
      branch: 'rama\n',
    })
    assert.deepEqual(validateConsumerScopeChanges('/wt', 'abc', { run }).violations, [
      'commands/x.md',
      'dist/claude/a',
      'commands/x.md',
      'hooks/',
      'mefisto-manifest.json',
    ])
  })

  test('como la gemela, no ve el destino de un renombre pendiente ni una ruta citada', () => {
    const { run } = fakeGit({
      diff: '',
      status: 'R  src/a.md -> commands/a.md\nA  "commands/a\\303\\261o.md"\n',
    })
    assert.deepEqual(validateConsumerScopeChanges('/wt', 'abc', { run }).violations, [])
  })

  test('un git que falla no aporta rutas ni rama', () => {
    assert.deepEqual(validateConsumerScopeChanges('/wt', 'abc', { run: fakeGit({}).run }).violations, [])

    const check = validateConsumerScopeChanges('/wt', 'abc', { run: fakeGit({ status: VIOLATION }).run })
    assert.deepEqual(check.message, diagnostic(check.violations, DEFAULT_SLUG, 'la rama del worktree /wt'))
  })

  test('el diagnostico nombra el repoSlug del config efectivo', () => {
    const { run } = fakeGit({ status: VIOLATION, branch: 'rama\n' })
    const check = validateConsumerScopeChanges('/wt', 'abc', { run, configPath: configFile('fork', 'org/fork') })
    assert.deepEqual(check.message, diagnostic(check.violations, 'org/fork', 'rama'))
    assert.equal(check.message.join('\n').includes(DEFAULT_SLUG), false)
  })

  test('el config legacy resuelto por resolveHarnessConfigPath tambien aporta el repoSlug', () => {
    const legacy = join(tmp, 'legacy', '.claude', 'harness.config.json')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, minimalConfig('org/legacy-fork'))
    const { run } = fakeGit({ status: VIOLATION, branch: 'rama\n' })
    const configPath = resolveHarnessConfigPath('read', join(tmp, 'legacy'))
    const check = validateConsumerScopeChanges('/wt', 'abc', { run, configPath })
    assert.deepEqual(check.message, diagnostic(check.violations, 'org/legacy-fork', 'rama'))
  })

  test('sin config, sin repoSlug o con un config ilegible aplica el repo publicado', () => {
    const { run } = fakeGit({ status: VIOLATION, branch: 'rama\n' })
    const expected = diagnostic(['docs/adr/mef-adr-0001-ejemplo.md'], DEFAULT_SLUG, 'rama')
    const broken = join(tmp, 'roto.json')
    writeFileSync(broken, 'no soy json {{{')
    for (const configPath of [undefined, '', configFile('sin-slug', ''), join(tmp, 'no-existe.json'), tmp, broken]) {
      const options = configPath === undefined ? { run } : { run, configPath }
      assert.deepEqual(validateConsumerScopeChanges('/wt', 'abc', options).message, expected, String(configPath))
    }
  })

  describe('paridad con la gemela bash', { skip: NO_BASH }, () => {
    let repo = ''
    let base = ''
    let restoreGit = (): void => {}

    before(() => {
      restoreGit = isolateGitConfig(tmp)
      repo = join(tmp, 'repo paridad')
      mkdirSync(repo)
      git(repo, 'init', '-q', '-b', 'main')
      git(repo, 'config', 'user.email', 'test@local')
      git(repo, 'config', 'user.name', 'Test')
      writeFileSync(join(repo, 'README.md'), '')
      git(repo, 'add', 'README.md')
      git(repo, 'commit', '-q', '-m', 'base')
      base = git(repo, 'rev-parse', 'HEAD')
    })

    after(() => {
      restoreGit()
    })

    function write(path: string, content = ''): void {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), content)
    }

    function assertParity(configPath?: string): number {
      const env = { ...process.env }
      delete env.HARNESS_CONFIG_PATH
      if (configPath !== undefined) env.HARNESS_CONFIG_PATH = configPath
      const fromBash = bashLibrary('validate_consumer_scope_changes "$1" "$2"', [repo, base], { env, cwd: tmp })
      const check = validateConsumerScopeChanges(repo, base, configPath === undefined ? {} : { configPath })
      assert.equal(fromBash.stdout, '')
      assert.equal(fromBash.status, check.violations.length > 0 ? 1 : 0)
      assert.equal(fromBash.stderr, check.message.map((line) => `${line}\n`).join(''))
      return check.violations.length
    }

    test('sin cambios y con cambios del consumidor', () => {
      assert.equal(assertParity(), 0)
      write('docs/testing/mefisto-certification/fixture.md')
      git(repo, 'add', '-A')
      write('src/Foo.cs', 'class Foo {}\n')
      assert.equal(assertParity(), 0)
    })

    test('con violaciones commiteadas, preparadas, sin seguimiento y renombradas', () => {
      write('commands/x.md')
      write('docs/adr/0028-x.md')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'agente')
      write('commands/x.md', 'cambio\n')
      write('docs/adr/mef-adr-0001-ejemplo.md')
      git(repo, 'add', 'docs/adr/mef-adr-0001-ejemplo.md')
      write('hooks/h.json')
      write('skills/con espacio/SKILL.md')
      write('agents/año.md')
      git(repo, 'mv', 'docs/adr/0028-x.md', 'mefisto-manifest.json')
      assert.ok(assertParity() >= 5)
      assert.ok(assertParity(configFile('fork-paridad', 'org/fork')) >= 5)
      assert.ok(assertParity(configFile('sin-slug-paridad', '')) >= 5)
      assert.ok(assertParity(join(tmp, 'no-existe.json')) >= 5)
    })

    test('con HEAD separado y con una base que no existe', () => {
      git(repo, 'checkout', '-q', '--detach')
      assert.ok(assertParity() >= 5)
      base = 'no-es-un-commit'
      assert.ok(assertParity() >= 1)
    })
  })
})
