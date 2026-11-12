import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { git, isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import {
  changelogFragmentAdded,
  changesRequireChangelog,
  isPathChangelogExempt,
} from '../../../src/internal/scripts/lib/mefisto-changelog-gate.mts'

const EXEMPT = [
  'docs/bitacora/algo.md',
  'docs/bitacora/field-notes/2026-x.md',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.gitattributes',
  '.gitignore',
]

const NOTABLE = [
  'commands/x.md',
  'agents/y.md',
  'scripts/z.sh',
  '.claude/scripts/w.sh',
  'docs/adr/mef-adr-0021-infraestructura-base.md',
  'hooks/hooks.json',
  'CHANGELOG.md',
  'src/internal/x.ts',
]

// Rutas limite: se compara el texto tal cual, sin normalizar.
const LIMIT = [
  '',
  'docs/bitacora',
  'docs/bitacora/',
  'docs/bitacoras/x.md',
  'docs/Bitacora/x.md',
  'docs/bitacora\\x.md',
  './docs/bitacora/x.md',
  '/docs/bitacora/x.md',
  'x/docs/bitacora/x.md',
  'docs/bitacora/../adr/x.md',
  'docs/x.md',
  'readme.md',
  'README.md ',
  ' README.md',
  'README.md.bak',
  'sub/README.md',
  'sub/CLAUDE.md',
  'sub/AGENTS.md',
  'sub/.gitignore',
  '.gitignore.local',
  'changelog.d/1.added.md',
  'changelog.d/README.md',
  'LICENSE',
  'docs/bitacora/x -> scripts/x.sh',
  '"docs/bitacora/a\\303\\261o.md"',
  '*',
  'docs/bitacora/*',
  '[R]EADME.md',
]

const FRAGMENT_PATHS = [
  'changelog.d/380.added.md',
  'changelog.d/380.adr-index.md',
  'changelog.d/README.md',
  'changelog.d/sub/x.md',
  'changelog.d/sub/README.md',
  'changelog.d/.md',
  'changelog.d/x.txt',
  'changelog.d/x.md.bak',
  'changelog.d/x.MD',
  'changelog.d/',
  'changelog.d',
  'changelog.md',
  'changelog.d.md',
  'Changelog.d/x.md',
  'x/changelog.d/1.added.md',
  './changelog.d/1.added.md',
  'changelog.d\\1.added.md',
  'changelog.d/1.added.md ',
  '"changelog.d/a\\303\\261o.md"',
  'changelog.d/README.md -> changelog.d/1.added.md',
  'changelog.d/1.added.md -> changelog.d/README.md',
  'docs/x.md -> changelog.d/1.added.md',
  'CHANGELOG.md',
]

function fakeGit(diff: string, status = ''): Run {
  return (_command, args) => ({ status: 0, stdout: args.includes('diff') ? diff : status, stderr: '' })
}

/** La decision del pipeline: aborta solo ante un cambio notable sin fragmento. */
function gateWouldAbort(worktree: string, base: string): boolean {
  if (changelogFragmentAdded(worktree, base)) return false
  return changesRequireChangelog(worktree, base)
}

describe('isPathChangelogExempt', () => {
  test('[A] la bitacora y el gobierno del repo no exigen fragmento', () => {
    for (const path of EXEMPT) assert.equal(isPathChangelogExempt(path), true, path)
  })

  test('[A] el resto del scope es notable', () => {
    for (const path of NOTABLE) assert.equal(isPathChangelogExempt(path), false, path)
  })

  test('compara el texto tal cual', () => {
    assert.equal(isPathChangelogExempt('docs/bitacora/'), true)
    for (const path of ['', 'docs/bitacora', 'docs/Bitacora/x.md', './docs/bitacora/x.md', 'sub/README.md', 'README.md ']) {
      assert.equal(isPathChangelogExempt(path), false, path)
    }
  })

  test('de las rutas limite y de fragmento solo quedan exentas estas', () => {
    assert.deepEqual([...LIMIT, ...FRAGMENT_PATHS].filter(isPathChangelogExempt), [
      'docs/bitacora/',
      'docs/bitacora/../adr/x.md',
      'docs/bitacora/x -> scripts/x.sh',
      'docs/bitacora/*',
    ])
  })
})

describe('el gate sobre un worktree', () => {
  let tmp = ''
  let repo = ''
  let base = ''
  let restoreGit = (): void => {}

  function write(path: string, content: string): void {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mefisto changelog gate '))
    restoreGit = isolateGitConfig(tmp)
    repo = join(tmp, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t.test')
    git(repo, 'config', 'user.name', 'test')
    write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- inicial\n')
    write('commands/existente.md', 'base\n')
    write('docs/bitacora/vieja.md', 'base\n')
    write('changelog.d/README.md', '# Como funcionan los fragmentos\n')
    write('changelog.d/100.added.md', '- fragmento previo\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    base = git(repo, 'rev-parse', 'HEAD')
  })

  beforeEach(() => {
    git(repo, 'checkout', '-q', '--detach', base)
    git(repo, 'reset', '-q', '--hard', base)
    git(repo, 'clean', '-qfd')
  })

  after(() => {
    restoreGit()
    rmSync(tmp, { recursive: true, force: true })
  })

  interface State {
    arrange: () => void
    fragment: boolean
    notable: boolean
  }

  const STATES: Record<string, State> = {
    'sin cambios': { arrange: () => {}, fragment: false, notable: false },
    'B-1 fragmento nuevo sin trackear': {
      arrange: () => write('changelog.d/380.added.md', '- entrada del fragmento\n'),
      fragment: true,
      notable: true,
    },
    'B-2 solo cambia el README del mecanismo': {
      arrange: () => write('changelog.d/README.md', '# actualizacion del doc\n'),
      fragment: false,
      notable: true,
    },
    'B-3 y C-2 cambio notable sin fragmento': {
      arrange: () => write('commands/existente.md', 'cambio\n'),
      fragment: false,
      notable: true,
    },
    'C-1 cambio notable anotado como fragmento': {
      arrange: () => {
        write('commands/existente.md', 'cambio\n')
        write('changelog.d/380.added.md', '- entrada del fragmento\n')
      },
      fragment: true,
      notable: true,
    },
    'C-3 solo bitacora': {
      arrange: () => write('docs/bitacora/2026-x.md', 'nota de bitacora\n'),
      fragment: false,
      notable: false,
    },
    'solo gobierno, commiteado y pendiente': {
      arrange: () => {
        write('README.md', 'gobierno\n')
        write('AGENTS.md', 'doctrina\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', 'gobierno')
        write('.gitignore', '*.log\n')
        write('docs/bitacora/field-notes/nueva/nota.md', 'x\n')
      },
      fragment: false,
      notable: false,
    },
    'cambio notable y fragmento ya commiteados': {
      arrange: () => {
        write('scripts/z.sh', 'x\n')
        write('changelog.d/380.fixed.md', '- arreglo\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', 'agente')
      },
      fragment: true,
      notable: true,
    },
    'fragmento de indice de ADRs en un directorio nuevo': {
      arrange: () => write('changelog.d/sub/380.adr-index.md', '- adr\n'),
      fragment: true,
      notable: true,
    },
    'archivo que no es markdown bajo changelog.d': {
      arrange: () => write('changelog.d/380.added.txt', '- no cuenta\n'),
      fragment: false,
      notable: true,
    },
    'fragmento previo borrado': {
      arrange: () => git(repo, 'rm', '-q', 'changelog.d/100.added.md'),
      fragment: true,
      notable: true,
    },
    'bitacora renombrada fuera de la bitacora, sin commitear': {
      arrange: () => {
        mkdirSync(join(repo, 'scripts'))
        git(repo, 'mv', 'docs/bitacora/vieja.md', 'scripts/vieja.md')
      },
      fragment: false,
      notable: false,
    },
    'bitacora renombrada fuera de la bitacora, commiteada': {
      arrange: () => {
        mkdirSync(join(repo, 'scripts'))
        git(repo, 'mv', 'docs/bitacora/vieja.md', 'scripts/vieja.md')
        git(repo, 'commit', '-q', '-m', 'renombre')
      },
      fragment: false,
      notable: true,
    },
    'bitacora con nombre no ASCII, sin trackear': {
      arrange: () => write('docs/bitacora/año.md', 'x\n'),
      fragment: false,
      notable: true,
    },
  }

  function state(name: string): State {
    const found = STATES[name]
    assert.ok(found, name)
    found.arrange()
    return found
  }

  test('[B] changelogFragmentAdded detecta un fragmento y no cuenta el README del mecanismo', () => {
    state('B-1 fragmento nuevo sin trackear')
    assert.equal(changelogFragmentAdded(repo, base), true)
  })

  test('[B] sin fragmento, o tocando solo el README, changelogFragmentAdded da false', () => {
    state('B-2 solo cambia el README del mecanismo')
    assert.equal(changelogFragmentAdded(repo, base), false)
    state('B-3 y C-2 cambio notable sin fragmento')
    assert.equal(changelogFragmentAdded(repo, base), false)
  })

  test('[C-1] un cambio notable anotado como fragmento pasa el gate', () => {
    state('C-1 cambio notable anotado como fragmento')
    assert.equal(changesRequireChangelog(repo, base), true)
    assert.equal(gateWouldAbort(repo, base), false)
  })

  test('[C-2] un cambio notable sin fragmento aborta el gate', () => {
    state('B-3 y C-2 cambio notable sin fragmento')
    assert.equal(gateWouldAbort(repo, base), true)
  })

  test('[C-3] un cambio exento sin fragmento pasa el gate', () => {
    state('C-3 solo bitacora')
    assert.equal(changesRequireChangelog(repo, base), false)
    assert.equal(gateWouldAbort(repo, base), false)
  })

  test('clasifica cada estado del worktree', () => {
    for (const name of Object.keys(STATES)) {
      git(repo, 'checkout', '-q', '--detach', base)
      git(repo, 'reset', '-q', '--hard', base)
      git(repo, 'clean', '-qfd')
      const expected = state(name)
      assert.equal(changelogFragmentAdded(repo, base), expected.fragment, `fragmento: ${name}`)
      assert.equal(changesRequireChangelog(repo, base), expected.notable, `notable: ${name}`)
    }
  })

  test('un fragmento cuenta por su ruta tal cual la reporta git', () => {
    const added = FRAGMENT_PATHS.filter((path) => changelogFragmentAdded('/wt', 'abc', { run: fakeGit(`${path}\n`) }))
    assert.deepEqual(added, [
      'changelog.d/380.added.md',
      'changelog.d/380.adr-index.md',
      'changelog.d/sub/x.md',
      'changelog.d/sub/README.md',
      'changelog.d/.md',
      'changelog.d/README.md -> changelog.d/1.added.md',
      'changelog.d/1.added.md -> changelog.d/README.md',
    ])
  })

  test('un git que falla no aporta rutas: ni notable ni fragmento', () => {
    const failing: Run = () => ({ status: 128, stdout: '', stderr: 'fatal' })
    assert.equal(changesRequireChangelog('/wt', 'abc', { run: failing }), false)
    assert.equal(changelogFragmentAdded('/wt', 'abc', { run: failing }), false)
  })

  test('ruta a ruta, git diff y git status dan el mismo veredicto y es notable lo que no esta exento', () => {
    const samples = [...EXEMPT, ...NOTABLE, ...LIMIT, ...FRAGMENT_PATHS].filter((path) => path.length > 0)
    const verdict = (run: Run): [boolean, boolean] => [
      changelogFragmentAdded('wt', 'base', { run }),
      changesRequireChangelog('wt', 'base', { run }),
    ]
    const fragments: string[] = []
    for (const path of samples) {
      const fromDiff = verdict(fakeGit(`${path}\n`))
      assert.deepEqual(verdict(fakeGit('', `?? ${path}\n`)), fromDiff, JSON.stringify(path))
      assert.equal(fromDiff[1], !isPathChangelogExempt(path), JSON.stringify(path))
      if (fromDiff[0]) fragments.push(path)
    }
    assert.deepEqual(fragments, [
      'changelog.d/1.added.md',
      'changelog.d/380.added.md',
      'changelog.d/380.adr-index.md',
      'changelog.d/sub/x.md',
      'changelog.d/sub/README.md',
      'changelog.d/.md',
      'changelog.d/README.md -> changelog.d/1.added.md',
      'changelog.d/1.added.md -> changelog.d/README.md',
    ])
  })

  test('con una base que no existe cuenta el status; fuera de un repo no hay nada', () => {
    state('C-1 cambio notable anotado como fragmento')
    assert.deepEqual([changelogFragmentAdded(repo, 'no-es-un-commit'), changesRequireChangelog(repo, 'no-es-un-commit')], [true, true])
    const outside = join(tmp, 'no-es-un-repo')
    assert.deepEqual([changelogFragmentAdded(outside, base), changesRequireChangelog(outside, base)], [false, false])
  })
})
