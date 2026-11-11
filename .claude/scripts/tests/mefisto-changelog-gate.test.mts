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
import { mefistoBash, NO_BASH } from './mefisto-common-parity.mts'

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

// Rutas limite: la gemela bash compara el texto tal cual, sin normalizar.
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

  test('coincide con is_path_changelog_exempt de la libreria bash', { skip: NO_BASH }, () => {
    const samples = [...EXEMPT, ...NOTABLE, ...LIMIT, ...FRAGMENT_PATHS]
    const result = mefistoBash(
      'for p in "$@"; do if is_path_changelog_exempt "$p"; then echo 1; else echo 0; fi; done',
      samples,
    )
    assert.equal(result.status, 0, result.stderr)
    const fromBash = result.stdout.trim().split('\n')
    assert.equal(fromBash.length, samples.length)
    samples.forEach((path, index) => {
      assert.equal(isPathChangelogExempt(path), fromBash[index] === '1', JSON.stringify(path))
    })
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

  describe('paridad con la gemela bash', { skip: NO_BASH }, () => {
    const script =
      'changelog_fragment_added "$1" "$2"; printf "fragmento=%s\\n" "$?"; changes_require_changelog "$1" "$2"; printf "notable=%s\\n" "$?"'

    function verdict(worktree: string, from: string, run?: Run): string {
      const options = run === undefined ? {} : { run }
      const fragment = changelogFragmentAdded(worktree, from, options) ? 0 : 1
      const notable = changesRequireChangelog(worktree, from, options) ? 0 : 1
      return `fragmento=${fragment}\nnotable=${notable}\n`
    }

    for (const name of Object.keys(STATES)) {
      test(name, () => {
        state(name)
        const fromBash = mefistoBash(script, [repo, base], { cwd: tmp })
        assert.equal(fromBash.stderr, '')
        assert.equal(fromBash.stdout, verdict(repo, base))
      })
    }

    test('con una base que no existe y fuera de un repo', () => {
      state('C-1 cambio notable anotado como fragmento')
      for (const [worktree, from] of [
        [repo, 'no-es-un-commit'],
        [join(tmp, 'no-es-un-repo'), base],
      ] as const) {
        assert.equal(mefistoBash(script, [worktree, from], { cwd: tmp }).stdout, verdict(worktree, from))
      }
    })

    test('ruta a ruta, como salida de git diff y de git status', () => {
      const samples = [...EXEMPT, ...NOTABLE, ...LIMIT, ...FRAGMENT_PATHS].filter((path) => path.length > 0)
      const fake = [
        'git() {',
        '  case " $* " in',
        '    *" diff "*) [ "$FAKE_MODE" = diff ] && printf "%s\\n" "$FAKE_PATH" ;;',
        '    *" status "*) [ "$FAKE_MODE" = status ] && printf "?? %s\\n" "$FAKE_PATH" ;;',
        '  esac',
        '  return 0',
        '}',
        'for FAKE_MODE in diff status; do for FAKE_PATH in "$@"; do',
        '  changelog_fragment_added wt base; f=$?; changes_require_changelog wt base; n=$?',
        '  printf "%s%s\\n" "$f" "$n"',
        'done; done',
      ].join('\n')
      const fromBash = mefistoBash(fake, samples)
      assert.equal(fromBash.status, 0, fromBash.stderr)
      const verdicts = fromBash.stdout.trim().split('\n')
      assert.equal(verdicts.length, samples.length * 2)
      samples.forEach((path, index) => {
        for (const [offset, run] of [
          [0, fakeGit(`${path}\n`)],
          [samples.length, fakeGit('', `?? ${path}\n`)],
        ] as const) {
          const expected = `${changelogFragmentAdded('wt', 'base', { run }) ? 0 : 1}${changesRequireChangelog('wt', 'base', { run }) ? 0 : 1}`
          assert.equal(expected, verdicts[index + offset], JSON.stringify(path))
        }
      })
    })
  })
})
