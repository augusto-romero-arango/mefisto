import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../../../scripts/lib/cli.mts'
import { readText } from '../../../src/internal/scripts/lib/mefisto-release-lib.mts'
import {
  bumpVersion,
  compareVersions,
  isMechanicalDelta,
  isValidReleaseIdentity,
  parseReleaseArgs,
  releasePrBody,
  rewriteChangelogForRelease,
  summarizeVersionSection,
  unreleasedBody,
  versionSection,
} from '../../../src/internal/scripts/mefisto-release.mts'
import type { PrBodyInput } from '../../../src/internal/scripts/mefisto-release.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-release.mts')
const COMMAND = join(REPO_ROOT, '.claude', 'commands', 'mefisto-release.md')
const PR_BODY_LIMIT = 65536
const COMMIT = 'b'.repeat(40)

const CHANGELOG = `# Changelog

## [Unreleased]

### Changed
- Cambio de prueba.

## [1.2.2] - 2026-09-01

### Fixed

- arreglo previo

## [1.2.1] - 2026-08-01

- la primera

[Unreleased]: https://example.invalid/compare/v1.2.2...HEAD
[1.2.2]: https://example.invalid/compare/v1.2.1...v1.2.2
`

function prBody(overrides: Partial<PrBodyInput> = {}): string {
  return releasePrBody({
    newVersion: '0.19.0',
    prevVersion: '0.18.0',
    bump: 'minor',
    releaseBranch: 'release/v0.19.0',
    releaseDate: '2026-11-11',
    sourceCommit: COMMIT,
    repoUrl: 'https://github.com/owner/repo',
    notes: '### Fixed\n\n- un arreglo',
    ...overrides,
  })
}

describe('parseReleaseArgs', () => {
  test('la magnitud encadena por defecto', () => {
    assert.deepEqual(parseReleaseArgs(['patch']), { bump: 'patch', prepareOnly: false })
    assert.deepEqual(parseReleaseArgs(['minor']), { bump: 'minor', prepareOnly: false })
    assert.deepEqual(parseReleaseArgs(['major']), { bump: 'major', prepareOnly: false })
  })

  test('--prepare-only desactiva el encadenamiento en cualquier orden', () => {
    assert.deepEqual(parseReleaseArgs(['minor', '--prepare-only']), { bump: 'minor', prepareOnly: true })
    assert.deepEqual(parseReleaseArgs(['--prepare-only', 'major']), { bump: 'major', prepareOnly: true })
  })

  test('sin magnitud no aborta: deja que el script imprima el uso', () => {
    assert.deepEqual(parseReleaseArgs(['--prepare-only']), { bump: null, prepareOnly: true })
    assert.deepEqual(parseReleaseArgs([]), { bump: null, prepareOnly: false })
  })

  test('un argumento desconocido y dos magnitudes abortan', () => {
    assert.throws(() => parseReleaseArgs(['foo']), CliError)
    assert.throws(() => parseReleaseArgs(['patch', 'minor']), CliError)
    assert.throws(() => parseReleaseArgs(['patch', 'patch']), CliError)
  })
})

describe('versiones', () => {
  test('bumpVersion sigue SemVer', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0')
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
    assert.equal(bumpVersion('0.9.99', 'patch'), '0.9.100')
  })

  test('bumpVersion aborta si la version no es X.Y.Z', () => {
    assert.throws(() => bumpVersion('1.2', 'patch'), /La version actual no es SemVer X\.Y\.Z: 1\.2$/)
    assert.throws(() => bumpVersion('1.2.3-rc1', 'patch'), CliError)
    assert.throws(() => bumpVersion('null', 'patch'), CliError)
  })

  test('compareVersions ordena por componentes numericos, como sort -V', () => {
    const versions = ['1.2.10', '1.10.0', '1.2.3-rc1', '0.9.9', '1.2.2', '10.0.0', '1.2.3', '1.02.3']
    assert.deepEqual(versions.sort(compareVersions), [
      '0.9.9',
      '1.2.2',
      '1.02.3',
      '1.2.3',
      '1.2.3-rc1',
      '1.2.10',
      '1.10.0',
      '10.0.0',
    ])
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
    assert.ok(compareVersions('null', '1.2.2') > 0)
  })
})

describe('secciones del CHANGELOG', () => {
  test('unreleasedBody devuelve el cuerpo de [Unreleased] hasta la siguiente seccion', () => {
    assert.equal(unreleasedBody(CHANGELOG), '\n### Changed\n- Cambio de prueba.')
    assert.equal(unreleasedBody('# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n'), '')
    assert.equal(unreleasedBody('# Changelog\n\n## [1.0.0]\n'), '')
  })

  test('versionSection corta en la siguiente seccion y en los links del pie', () => {
    assert.equal(versionSection(CHANGELOG, '1.2.2'), '### Fixed\n\n- arreglo previo')
    assert.equal(versionSection(CHANGELOG, '1.2.1'), '- la primera')
    assert.equal(versionSection(CHANGELOG, '9.9.9'), null)
    assert.equal(versionSection(CHANGELOG, '1.2..'), null)
    assert.equal(versionSection('## [1x2y3]\n\nno es la 1.2.3\n', '1.2.3'), null)
    assert.equal(versionSection('## [1.0.0] - hoy\n', '1.0.0'), '')
  })

  test('rewriteChangelogForRelease mueve [Unreleased] y actualiza los links del pie', () => {
    assert.equal(
      rewriteChangelogForRelease(CHANGELOG, {
        newVersion: '1.2.3',
        prevVersion: '1.2.2',
        date: '2026-11-11',
        repoUrl: 'https://github.com/owner/repo',
      }),
      CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [1.2.3] - 2026-11-11\n').replace(
        '[Unreleased]: https://example.invalid/compare/v1.2.2...HEAD\n',
        '[Unreleased]: https://github.com/owner/repo/compare/v1.2.3...HEAD\n[1.2.3]: https://github.com/owner/repo/compare/v1.2.2...v1.2.3\n',
      ),
    )
  })

  test('rewriteChangelogForRelease agrega los links si el pie no los trae', () => {
    assert.equal(
      rewriteChangelogForRelease('## [Unreleased]\n- uno\n\n## [1.0.0]\n- cero', {
        newVersion: '1.0.1',
        prevVersion: '1.0.0',
        date: '2026-11-11',
        repoUrl: 'https://github.com/o/r',
      }),
      '## [Unreleased]\n\n## [1.0.1] - 2026-11-11\n- uno\n\n## [1.0.0]\n- cero\n[Unreleased]: https://github.com/o/r/compare/v1.0.1...HEAD\n[1.0.1]: https://github.com/o/r/compare/v1.0.0...v1.0.1\n',
    )
  })

  test('rewriteChangelogForRelease no reescribe sin [Unreleased] o con la seccion vacia', () => {
    const release = { newVersion: '1.0.1', prevVersion: '1.0.0', date: '2026-11-11', repoUrl: 'https://x' }
    assert.equal(rewriteChangelogForRelease('# Changelog\n\n## [1.0.0]\n', release), null)
    assert.equal(rewriteChangelogForRelease('## [Unreleased]\n\n  \n## [1.0.0]\n', release), null)
  })
})

describe('summarizeVersionSection', () => {
  test('cuenta las entradas de primer nivel de cada categoria presente', () => {
    const summary = summarizeVersionSection(
      '### Added\n\n- entrada 1\n- entrada 2\n  - sublinea\n- entrada 3\n\n### Fixed\n\n- entrada 4',
    )
    assert.equal(summary, '- **Added**: 3 entrada(s)\n- **Fixed**: 1 entrada(s)')
  })

  test('el orden es Added, Changed, Fixed, Removed, y despues las demas en orden de aparicion', () => {
    const summary = summarizeVersionSection(
      '### Seguridad\n\n- s\n\n### Removed\n\n- se quita algo\n\n### Añadido\n\n- a\n\n### Added\n\n- se agrega algo',
    )
    assert.deepEqual(summary.split('\n'), [
      '- **Added**: 1 entrada(s)',
      '- **Removed**: 1 entrada(s)',
      '- **Seguridad**: 1 entrada(s)',
      '- **Añadido**: 1 entrada(s)',
    ])
  })

  test('una categoria repetida suma sus entradas', () => {
    assert.equal(
      summarizeVersionSection('### Fixed\n\n- uno\n\n### Fixed\n\n- dos\n- tres'),
      '- **Fixed**: 3 entrada(s)',
    )
  })

  test('un release de una sola entrada produce un resumen legible', () => {
    assert.equal(
      summarizeVersionSection('### Fixed\n\n- se corrige un bug puntual'),
      '- **Fixed**: 1 entrada(s)',
    )
  })

  test('las lineas de un bloque cercado no cuentan como entradas', () => {
    const notes =
      '### Added\n\n- entrada real con un snippet:\n\n  ```yaml\n- no soy una entrada\n- yo tampoco\n  ```\n\n- segunda entrada real'
    assert.equal(summarizeVersionSection(notes), '- **Added**: 2 entrada(s)')
  })

  test('sin subsecciones de categoria el resumen queda vacio', () => {
    assert.equal(summarizeVersionSection('- entrada suelta sin subseccion'), '')
    assert.equal(summarizeVersionSection(''), '')
  })
})

describe('releasePrBody', () => {
  test('con la seccion [0.18.0] real, que supera el limite de GitHub, el body queda muy por debajo', () => {
    const notes = versionSection(readText(join(REPO_ROOT, 'CHANGELOG.md')), '0.18.0')
    assert.ok(notes !== null)
    assert.ok(notes.length > PR_BODY_LIMIT, `la seccion [0.18.0] mide ${notes.length}`)

    const summary = summarizeVersionSection(notes)
    for (const category of ['Added', 'Changed', 'Fixed', 'Removed']) {
      assert.match(summary, new RegExp(`^- \\*\\*${category}\\*\\*: [1-9][0-9]* entrada\\(s\\)$`, 'm'))
    }

    const body = prBody({ notes })
    assert.ok(body.length < 4096, `el body mide ${body.length}`)
    assert.ok(body.includes(`## Categorias del release\n\n${summary}\n\nNotas completas: `))
  })

  test('lleva el resumen, el link al CHANGELOG de la rama y el siguiente paso, no las notas', () => {
    const body = prBody({ notes: '### Fixed\n\n- una entrada que solo vive en el CHANGELOG' })
    assert.equal(body.includes('una entrada que solo vive en el CHANGELOG'), false)
    assert.ok(body.startsWith('## Resumen\n\nPR de release v0.19.0 (minor: 0.18.0 -> 0.19.0).\n'))
    assert.ok(body.includes('- **Fixed**: 1 entrada(s)\n'))
    assert.ok(
      body.includes(
        'Notas completas: [`CHANGELOG.md`](https://github.com/owner/repo/blob/release/v0.19.0/CHANGELOG.md) en esta rama (`release/v0.19.0`).\n',
      ),
    )
    assert.ok(body.includes(`- Persiste la identidad fuente \`${COMMIT}\` y regenera los manifiestos Claude.\n`))
    assert.ok(body.includes('- Mueve `[Unreleased]` a `[0.19.0] - 2026-11-11` en `CHANGELOG.md`.\n'))
    assert.ok(body.includes('\n## Siguiente paso\n\nPor defecto (issue #759) el propio `/mefisto-release minor` remata solo'))
    assert.ok(
      body.endsWith('3. `/mefisto-release` (sin argumentos) para crear el tag v0.19.0 y el GitHub Release.\n'),
    )
  })

  test('sin categorias que resumir remite a las notas completas', () => {
    assert.ok(
      prBody({ notes: '- entrada suelta' }).includes(
        '## Categorias del release\n\n- Sin subsecciones `### Categoria` en `[0.19.0]`; ver las notas completas.\n',
      ),
    )
  })
})

describe('validaciones de publish', () => {
  test('isValidReleaseIdentity exige exactamente esquema 1, version SemVer y SHA completo', () => {
    const identity = { schemaVersion: 1, version: '1.2.3', commit: COMMIT }
    assert.equal(isValidReleaseIdentity(identity), true)
    assert.equal(isValidReleaseIdentity({ commit: COMMIT, version: '0.0.0', schemaVersion: 1 }), true)
    assert.equal(isValidReleaseIdentity({ ...identity, runtime: 'claude' }), false)
    assert.equal(isValidReleaseIdentity({ version: '1.2.3', commit: COMMIT }), false)
    assert.equal(isValidReleaseIdentity({ ...identity, schemaVersion: 2 }), false)
    assert.equal(isValidReleaseIdentity({ ...identity, schemaVersion: '1' }), false)
    assert.equal(isValidReleaseIdentity({ ...identity, version: '1.2' }), false)
    assert.equal(isValidReleaseIdentity({ ...identity, version: '01.2.3' }), false)
    assert.equal(isValidReleaseIdentity({ ...identity, version: 123 }), false)
    assert.equal(isValidReleaseIdentity({ ...identity, commit: 'abc' }), false)
    assert.equal(isValidReleaseIdentity({ ...identity, commit: 'B'.repeat(40) }), false)
    assert.equal(isValidReleaseIdentity([1, '1.2.3', COMMIT]), false)
    assert.equal(isValidReleaseIdentity(null), false)
    assert.equal(isValidReleaseIdentity(undefined), false)
  })

  test('isMechanicalDelta acepta la metadata de release y el borrado de fragmentos', () => {
    const delta = [
      'M\t.claude-plugin/plugin.json',
      'M\tCHANGELOG.md',
      'D\tchangelog.d/10.added.md',
      'D\tchangelog.d/10.adr-index.md',
      'M\tdist/claude/.mefisto-generated-assets.json',
      'A\tdist/claude/mefisto-manifest.json',
      'M\tdocs/adr/INDICE-TEMATICO.md',
      'A\tmefisto-manifest.json',
      'M\tsrc/published/release-identity.json',
      '',
    ].join('\n')
    assert.equal(isMechanicalDelta(delta), true)
    assert.equal(isMechanicalDelta(''), true)
  })

  test('isMechanicalDelta rechaza cualquier otra ruta o cambio', () => {
    for (const line of [
      'M\tsrc/internal/scripts/mefisto-release.mts',
      'A\tchangelog.d/11.added.md',
      'M\tchangelog.d/10.added.md',
      'D\tchangelog.d/README.md',
      'M\tchangelog.d/README.md',
      'D\tchangelog.d/notas.txt',
      'R100\tchangelog.d/10.added.md\tdocs/10.added.md',
      'M\tdist/claude/scripts/upgrade.mts',
    ]) {
      assert.equal(isMechanicalDelta(`M\tCHANGELOG.md\n${line}\n`), false, line)
    }
  })
})

describe('comando', () => {
  let work = ''

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'mefisto release comando '))
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  test('el .mts se niega a correr en un repo que no es el de Mefisto', () => {
    const repo = join(work, 'ajeno')
    mkdirSync(repo)
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
    const result = spawnSync(process.execPath, [SCRIPT, 'patch'], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.startsWith('ERROR: este pipeline solo se ejecuta dentro del repo de Mefisto\n'))
  })

  test('el .mts no depende de variables ni de rutas de un runtime concreto', () => {
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    for (const token of [['CLAUDE', 'PLUGIN', 'ROOT'].join('_'), ['CLAUDE', 'PROJECT', 'DIR'].join('_'), '.claude/scripts']) {
      assert.equal(code.includes(token), false, token)
    }
  })

  test('el comando documenta --prepare-only y el encadenamiento por defecto', () => {
    const command = readFileSync(COMMAND, 'utf8')
    assert.ok(command.includes('--prepare-only'))
    assert.ok(command.includes('encadena'))
  })
})
