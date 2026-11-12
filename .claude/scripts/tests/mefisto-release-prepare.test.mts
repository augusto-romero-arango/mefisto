import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { COLOR } from '../../../scripts/lib/cli.mts'
import { git, gitOk } from '../../../scripts/tests/field-note-sandbox.mts'
import {
  ABORT,
  BASE_FILES,
  GENERATED_ASSETS,
  ORIGINAL_BRANCH,
  PR_URL,
  RELEASE_BRANCH,
  RELEASED_CHANGELOG,
  Workspace,
} from './mefisto-release-sandbox.mts'
import type { ReleaseSandbox } from './mefisto-release-sandbox.mts'

const GATE_LINE = '.claude/agents/fx-agent.md: distinta: adapters-check'
const UNTOUCHED = [
  'CHANGELOG.md',
  '.claude-plugin/plugin.json',
  'src/published/release-identity.json',
  'mefisto-manifest.json',
  'dist/claude/mefisto-manifest.json',
  'dist/claude/.mefisto-generated-assets.json',
  'docs/adr/INDICE-TEMATICO.md',
  'changelog.d/10.added.md',
]

let workspace: Workspace

before(() => {
  workspace = new Workspace('mefisto release prepare ')
})

after(() => {
  workspace.dispose()
})

function assertNothingPrepared(sb: ReleaseSandbox): void {
  for (const file of UNTOUCHED) assert.equal(sb.read(file), BASE_FILES[file], file)
  assert.equal(sb.branch(), ORIGINAL_BRANCH)
  assert.equal(gitOk(sb.repo, 'show-ref', '--verify', '--quiet', `refs/heads/${RELEASE_BRANCH}`), false)
  assert.equal(git(sb.repo, 'status', '--porcelain'), '')
}

describe('deteccion de fase y precondiciones comunes', () => {
  test('sin gh aborta antes de tocar nada', () => {
    const sb = workspace.sandbox()
    sb.missingCommands.add('gh')
    sb.assertAborted(sb.release('patch'), 'Falta comando requerido: gh')
    assert.deepEqual(sb.events, [])
  })

  test('sin slug del repo vuelve a preguntar a gh y aborta si sigue vacio', () => {
    const sb = workspace.sandbox()
    sb.repoSlug = ''
    sb.ghRepoView = ''
    sb.assertAborted(sb.release('patch'), 'No se pudo determinar el repo slug (gh repo view fallo)')
    assert.deepEqual(sb.events, ['gh repo view --json nameWithOwner -q .nameWithOwner'])
  })

  test('sin el generador publicado aborta', () => {
    const sb = workspace.sandbox()
    const generator = join(sb.repo, 'src', 'published', 'scripts', 'generate-published-adapters.mts')
    rmSync(generator)
    sb.assertAborted(sb.release('patch'), `No existe el generador publicado: ${generator}`)
  })

  test('sin tags vX.Y.Z aborta', () => {
    const sb = workspace.sandbox()
    git(sb.repo, 'tag', '-d', 'v1.2.2')
    sb.assertAborted(
      sb.release('patch'),
      'El repo no tiene tags vX.Y.Z previos. Crea al menos uno manualmente antes de usar este skill.',
    )
  })

  test('el ultimo tag se elige por orden de version, no alfabetico', () => {
    const sb = workspace.sandbox()
    git(sb.repo, 'tag', 'v1.2.10')
    sb.assertAborted(
      sb.release('patch'),
      'Inconsistencia: plugin.json.version (1.2.2) es menor que el ultimo tag (v1.2.10).',
    )
  })

  test('los avisos llevan la hora y el color del script en bash', () => {
    const sb = workspace.sandbox()
    sb.release()
    const first = sb.output.stdout.split('\n')[0] ?? ''
    assert.ok(first.startsWith(COLOR.cyan), first)
    assert.match(first.slice(COLOR.cyan.length), /^\[\d\d:\d\d:\d\d\]/)
    assert.ok(first.endsWith(`]${COLOR.reset} Version en plugin.json: 1.2.2`), first)
    assert.ok(sb.output.stdout.includes(' Ultimo tag SemVer:      v1.2.2\n'))
    assert.ok(sb.output.stdout.includes(`\n${COLOR.cyan}${COLOR.bold}=== Fase prepare ===${COLOR.reset}\n`))
  })
})

describe('fase prepare: argumentos y precondiciones', () => {
  test('sin magnitud imprime el uso y sale con 1', () => {
    const sb = workspace.sandbox()
    assert.equal(sb.release(), 1)
    assert.equal(
      sb.output.stderr,
      [
        'Uso: mefisto-release.mts {patch|minor|major} [--prepare-only]',
        '',
        'plugin.json.version (1.2.2) ya coincide con el ultimo tag (v1.2.2).',
        'Necesitas indicar la magnitud del bump para preparar el PR de release.',
        '',
      ].join('\n'),
    )
    assert.equal(sb.hasEvent('git switch'), false)
  })

  test('--prepare-only sin magnitud tambien imprime el uso', () => {
    const sb = workspace.sandbox()
    assert.equal(sb.release('--prepare-only'), 1)
    assert.ok(sb.output.stderr.startsWith('Uso: mefisto-release.mts {patch|minor|major} [--prepare-only]\n'))
  })

  test('un argumento desconocido y dos magnitudes abortan', () => {
    const unknown = workspace.sandbox()
    unknown.assertAborted(
      unknown.release('foo'),
      "Argumento invalido: 'foo'. Esperado patch|minor|major [--prepare-only].",
    )
    const twice = workspace.sandbox()
    twice.assertAborted(
      twice.release('patch', 'minor'),
      "Solo se admite una magnitud de bump (patch|minor|major); recibido tambien 'minor'.",
    )
  })

  test('con cambios sin commitear aborta', () => {
    const sb = workspace.sandbox()
    writeFileSync(join(sb.repo, 'suelto.txt'), 'x\n')
    sb.assertAborted(
      sb.release('patch'),
      'Hay cambios sin commitear. Limpia el working tree antes de continuar.',
    )
    assert.equal(sb.hasEvent('gh auth status'), false)
  })

  test('sin autenticacion de gh aborta', () => {
    const sb = workspace.sandbox()
    sb.authFailsFrom = 1
    sb.assertAborted(sb.release('patch'), "gh no esta autenticado. Ejecuta 'gh auth login' y reintenta.")
  })

  test('si el tag ya existe, local o remoto, aborta', () => {
    const local = workspace.sandbox()
    local.answer('git rev-parse -q --verify refs/tags/v1.2.3', `${local.source}\n`)
    local.assertAborted(local.release('patch'), 'Ya existe el tag v1.2.3. Aborta para no pisar historia.')
    assert.equal(local.hasEvent('git ls-remote'), false)

    const remote = workspace.sandbox()
    remote.answer('git ls-remote --tags --exit-code origin v1.2.3', `${remote.source}\trefs/tags/v1.2.3\n`)
    remote.assertAborted(remote.release('patch'), 'Ya existe el tag v1.2.3. Aborta para no pisar historia.')
    assert.equal(remote.hasEvent('git switch'), false)
  })

  test('si ya existe el GitHub Release aborta', () => {
    const sb = workspace.sandbox()
    sb.releases.set('v1.2.3', 'previo')
    sb.assertAborted(sb.release('patch'), 'Ya existe un GitHub Release v1.2.3. Aborta.')
  })

  test('si la rama de release ya existe en local aborta', () => {
    const sb = workspace.sandbox()
    git(sb.repo, 'branch', RELEASE_BRANCH)
    sb.assertAborted(
      sb.release('patch'),
      `Ya existe localmente la rama ${RELEASE_BRANCH}. Borrala o renombra antes de continuar.`,
    )
    assert.equal(sb.hasEvent('git fetch'), false)
  })

  test('si el fetch falla aborta sin crear la rama', () => {
    const sb = workspace.sandbox()
    sb.fail('git fetch origin --tags --quiet')
    sb.assertAborted(sb.release('patch'), 'No se pudo hacer fetch desde origin')
    assertNothingPrepared(sb)
  })
})

describe('fase prepare: identidad fuente', () => {
  test('--prepare-only materializa una identidad unica y se detiene tras crear el PR', () => {
    const sb = workspace.sandbox()
    assert.equal(sb.release('patch', '--prepare-only'), 0, sb.output.stderr)

    assert.equal(sb.read('src/published/release-identity.json'), sb.identity('1.2.3'))
    assert.equal(sb.read('mefisto-manifest.json'), sb.manifest('1.2.3'))
    assert.equal(sb.read('dist/claude/mefisto-manifest.json'), sb.manifest('1.2.3'))
    assert.equal(sb.read('.claude-plugin/plugin.json'), '{\n  "name": "mefisto",\n  "version": "1.2.3"\n}\n')
    assert.equal(sb.read('dist/claude/.mefisto-generated-assets.json'), GENERATED_ASSETS)

    assert.ok(sb.inOrder('git rev-parse --verify origin/main^{commit}', `git switch -c ${RELEASE_BRANCH} origin/main`))
    assert.ok(sb.inOrder('git rev-parse HEAD', 'generator'))
    assert.ok(
      sb.hasEvent(
        'git add CHANGELOG.md docs/adr/INDICE-TEMATICO.md .claude-plugin/plugin.json src/published/release-identity.json mefisto-manifest.json dist/claude/mefisto-manifest.json dist/claude/.mefisto-generated-assets.json',
      ),
    )
    assert.ok(sb.inOrder('git add CHANGELOG.md', 'git add -A changelog.d/'))
    assert.ok(sb.prBody?.includes(sb.source))
    assert.ok(sb.prBody?.includes('1.2.3'))
    assert.equal(sb.hasEvent('git tag -a'), false)
    assert.equal(sb.hasEvent('gh pr merge'), false)
    assert.equal(sb.generatorEnv?.MEFISTO_REPO_ROOT, sb.repo)

    assert.equal(sb.branch(), RELEASE_BRANCH)
    assert.equal(git(sb.repo, 'status', '--porcelain'), '')
    assert.equal(git(sb.repo, 'log', '-1', '--format=%s'), 'chore(release): v1.2.3')
    assert.equal(git(sb.repo, 'rev-parse', 'HEAD^'), sb.source)
    assert.equal(git(sb.origin, 'rev-parse', `refs/heads/${RELEASE_BRANCH}`), git(sb.repo, 'rev-parse', 'HEAD'))
    assert.ok(
      sb.hasEvent(
        `gh pr create --base main --head ${RELEASE_BRANCH} --title chore(release): v1.2.3 --body-file `,
      ),
    )

    assert.ok(
      sb.output.stdout.endsWith(
        [
          `${COLOR.green}${COLOR.bold}v${COLOR.reset} PR de release creado: ${PR_URL}`,
          '',
          `${COLOR.cyan}${COLOR.bold}=== Resumen prepare ===${COLOR.reset}`,
          '  Version:  1.2.2 -> 1.2.3 (patch)',
          `  Rama:     ${RELEASE_BRANCH}`,
          `  PR:       ${PR_URL}`,
          '',
          'Siguiente paso (--prepare-only):',
          '  /mefisto-merge 42',
          '  git switch main && git pull --ff-only',
          '  /mefisto-release   # (sin argumentos) para publicar el tag y el release',
          '',
        ].join('\n'),
      ),
      sb.output.stdout,
    )
    assert.ok(sb.output.stdout.includes('generado\n'), 'la salida del generador llega a la terminal')
  })

  test('consolida changelog.d/ en la rama de release y commitea el borrado de los fragmentos', () => {
    const sb = workspace.sandbox()
    assert.equal(sb.release('minor', '--prepare-only'), 0, sb.output.stderr)
    assert.equal(git(sb.repo, 'show', 'HEAD:CHANGELOG.md') + '\n', RELEASED_CHANGELOG.replaceAll('1.2.3', '1.3.0'))
    assert.ok(sb.read('docs/adr/INDICE-TEMATICO.md').endsWith('| Topics por evento | MEF-ADR-0001 |\n| Doctrina X | MEF-ADR-0036 |\n'))
    assert.deepEqual(git(sb.repo, 'diff', '--name-status', `${sb.source}..HEAD`).split('\n'), [
      'M\t.claude-plugin/plugin.json',
      'M\tCHANGELOG.md',
      'D\tchangelog.d/10.added.md',
      'D\tchangelog.d/10.adr-index.md',
      'M\tdist/claude/.mefisto-generated-assets.json',
      'M\tdist/claude/mefisto-manifest.json',
      'M\tdocs/adr/INDICE-TEMATICO.md',
      'M\tmefisto-manifest.json',
      'M\tsrc/published/release-identity.json',
    ])
    assert.equal(
      sb.prBody?.includes('## Categorias del release\n\n- **Added**: 1 entrada(s)\n- **Changed**: 1 entrada(s)\n'),
      true,
    )
  })

  test('el remate normal produce la misma metadata y se detiene donde falla el merge', () => {
    const sb = workspace.sandbox()
    sb.mergeStatus = 9
    const code = sb.release('patch')
    sb.assertAborted(
      code,
      `Fallo el merge del PR #42. Hecho: PR ${PR_URL} creado (sigue abierto). Paso manual: /mefisto-merge 42; luego git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
    assert.ok(sb.hasEvent('gh pr merge 42 --squash --delete-branch'))
    assert.equal(sb.read('src/published/release-identity.json'), sb.identity('1.2.3'))
    assert.equal(sb.hasEvent('git tag -a'), false)
    assert.equal(sb.hasEvent('gh pr view'), false)
    assert.ok(sb.output.stderr.includes('merge rechazado\n'), 'la salida de gh llega a la terminal')
  })

  test('un SHA invalido de origin/main aborta antes de crear la rama', () => {
    const sb = workspace.sandbox()
    sb.answer('git rev-parse --verify origin/main^{commit}', 'corto\n')
    sb.assertAborted(
      sb.release('patch', '--prepare-only'),
      'origin/main no resolvio un SHA completo y valido; no se modifico metadata',
    )
    assert.equal(sb.hasEvent('git switch -c'), false)
    assert.equal(sb.hasEvent('generator'), false)
    assertNothingPrepared(sb)
  })

  test('si origin/main no se puede resolver o diverge al capturarlo, aborta antes de crear la rama', () => {
    const missing = workspace.sandbox()
    missing.fail('git rev-parse --verify origin/main^{commit}')
    missing.assertAborted(missing.release('patch'), 'No se pudo resolver origin/main como commit fuente')
    assert.equal(missing.hasEvent('git switch -c'), false)

    const moved = workspace.sandbox()
    moved.answer('git rev-parse origin/main', `${'c'.repeat(40)}\n`)
    moved.assertAborted(
      moved.release('patch'),
      'origin/main divergio al capturar el commit fuente; reintenta antes de modificar metadata',
    )
    assert.equal(moved.hasEvent('git switch -c'), false)
  })

  test('una rama creada desde otra ref se descarta antes de tocar metadata', () => {
    const sb = workspace.sandbox()
    sb.answer('git rev-parse HEAD', `${'c'.repeat(40)}\n`)
    sb.assertAborted(
      sb.release('patch', '--prepare-only'),
      `La rama ${RELEASE_BRANCH} no se creo exactamente desde el commit fuente ${sb.source}; no se modifico metadata`,
    )
    assert.equal(sb.hasEvent('generator'), false)
    assert.equal(sb.hasEvent('gate'), false)
    assert.ok(sb.hasEvent(`git branch -D ${RELEASE_BRANCH}`))
    assertNothingPrepared(sb)
  })

  test('el fallo del generador descarta la rama sin dejar metadata parcial', () => {
    const sb = workspace.sandbox()
    sb.generatorStatus = 7
    sb.assertAborted(
      sb.release('patch', '--prepare-only'),
      `Fallo al generar la identidad o los manifiestos de release; la rama ${RELEASE_BRANCH} se descarto sin salida parcial`,
    )
    assert.ok(sb.inOrder('generator', 'git reset --hard'))
    assert.ok(sb.inOrder('git reset --hard', 'git clean -fd -- mefisto-manifest.json dist/claude'))
    assert.ok(sb.inOrder('git clean -fd', `git switch ${ORIGINAL_BRANCH}`))
    assert.ok(sb.inOrder(`git switch ${ORIGINAL_BRANCH}`, `git branch -D ${RELEASE_BRANCH}`))
    assert.equal(existsSync(join(sb.repo, 'dist', 'claude', 'sin-trackear.txt')), false)
    assert.equal(sb.hasEvent('gh pr create'), false)
    assert.equal(sb.hasEvent('git add'), false)
    assertNothingPrepared(sb)
    assert.ok(sb.output.stderr.includes('generador roto\n'))
  })

  test('un manifiesto de dist/claude distinto del de raiz tambien descarta la rama', () => {
    const sb = workspace.sandbox()
    sb.generatorManifest = 'distinto\n'
    sb.assertAborted(
      sb.release('patch'),
      `Fallo al generar la identidad o los manifiestos de release; la rama ${RELEASE_BRANCH} se descarto sin salida parcial`,
    )
    assert.equal(sb.hasEvent('git add'), false)
    assertNothingPrepared(sb)
  })
})

describe('fase prepare: gate de neutralidad', () => {
  test('corre una sola vez, en la rama de release y antes de consolidar changelog.d/', () => {
    const sb = workspace.sandbox()
    assert.equal(sb.release('patch', '--prepare-only'), 0, sb.output.stderr)
    assert.equal(sb.events.filter((event) => event === 'gate').length, 1)
    assert.ok(sb.inOrder(`git switch -c ${RELEASE_BRANCH} origin/main`, 'gate'))
    assert.deepEqual(sb.gateSaw, {
      branch: RELEASE_BRANCH,
      fragments: ['10.added.md', '10.adr-index.md', 'README.md'],
    })
    assert.ok(sb.output.stdout.includes(`${COLOR.green}${COLOR.bold}v${COLOR.reset} Gate de neutralidad: sin fugas\n`))
    assert.equal(sb.hasEvent(`git branch -D ${RELEASE_BRANCH}`), false)
  })

  test('en rojo deshace la rama y aborta sin efectos posteriores', () => {
    const sb = workspace.sandbox()
    sb.gate = { status: 1, stdout: `${GATE_LINE}\n` }
    assert.equal(sb.release('patch', '--prepare-only'), 1)

    assert.ok(sb.hasEvent(`git switch -c ${RELEASE_BRANCH} origin/main`))
    assert.ok(sb.inOrder(`git switch -c ${RELEASE_BRANCH} origin/main`, `git switch ${ORIGINAL_BRANCH}`))
    assert.ok(sb.inOrder(`git switch ${ORIGINAL_BRANCH}`, `git branch -D ${RELEASE_BRANCH}`))
    for (const later of ['generator', 'git add', 'git commit', 'git push', 'gh pr create', 'git reset']) {
      assert.equal(sb.hasEvent(later), false, later)
    }
    assertNothingPrepared(sb)
  })

  test('el aborto compone la salida del gate con el remedio de cada regla', () => {
    const sb = workspace.sandbox()
    sb.gate = { status: 1, stdout: `${GATE_LINE}\n` }
    sb.release('patch', '--prepare-only')
    assert.equal(
      sb.output.stderr,
      [
        `${ABORT}Fuga(s) de neutralidad de runtime (MEF-ADR-0049) en origin/main:`,
        GATE_LINE,
        'adapters-check: regenera los adaptadores con src/internal/scripts/generate-internal-adapters.mts (sin --check); su salida (.claude/{agents,commands}/) no se edita a mano -- se edita la fuente neutral de src/internal/{agents,commands}/ y se regenera.',
        `Una release no se publica con fugas: corrigelas en main via PR de issue (el pipeline de tooling corre este mismo gate) y reintenta '/mefisto-release patch'. La rama ${RELEASE_BRANCH} se deshizo (no tenia commits propios); estas de vuelta en ${ORIGINAL_BRANCH}.`,
        '',
      ].join('\n'),
    )
  })
})

describe('fase prepare: consolidacion y notas', () => {
  test('un fragmento mal nombrado aborta antes de reescribir el CHANGELOG', () => {
    const sb = workspace.sandbox({ 'changelog.d/sin-numero.added.md': '- oops\n' })
    const code = sb.release('patch')
    sb.assertAborted(
      code,
      'Fallo al consolidar los fragmentos de CHANGELOG (changelog.d/): revisa el nombre de cada fragmento (<issue>.<categoria>.md)',
    )
    assert.ok(sb.output.stderr.startsWith('ERROR: fragmento de changelog con nombre invalido: sin-numero.added.md\n'))
    assert.equal(sb.read('CHANGELOG.md'), BASE_FILES['CHANGELOG.md'])
    assert.equal(sb.hasEvent('generator'), false)
  })

  test('sin tabla en el indice de ADRs aborta', () => {
    const sb = workspace.sandbox({ 'docs/adr/INDICE-TEMATICO.md': '# Indice\n' })
    const code = sb.release('patch')
    sb.assertAborted(code, 'Fallo al consolidar los fragmentos del indice de ADRs (changelog.d/*.adr-index.md)')
    assert.ok(
      sb.output.stderr.includes(
        'ERROR: no se encontro la tabla de indice de ADRs en docs/adr/INDICE-TEMATICO.md\n',
      ),
    )
  })

  test('con [Unreleased] vacio y sin fragmentos aborta', () => {
    const sb = workspace.sandbox({
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [1.2.2] - 2026-09-01\n',
      'changelog.d/10.added.md': '\n',
      'changelog.d/10.adr-index.md': '\n',
    })
    sb.assertAborted(
      sb.release('patch'),
      'La seccion [Unreleased] del CHANGELOG esta vacia (ni fragmentos en changelog.d/ ni entradas previas). Agrega notas antes de hacer release.',
    )
    assert.equal(sb.hasEvent('generator'), false)
    assert.equal(sb.hasEvent('git commit'), false)
  })

  test('sin subsecciones de categoria el body del PR no queda mudo', () => {
    const sb = workspace.sandbox({
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- entrada suelta\n\n## [1.2.2] - 2026-09-01\n',
      'changelog.d/10.added.md': '\n',
    })
    assert.equal(sb.release('patch', '--prepare-only'), 0, sb.output.stderr)
    assert.ok(sb.prBody?.includes('- Sin subsecciones `### Categoria` en `[1.2.3]`; ver las notas completas.\n'))
  })

  test('si el push de la rama falla aborta sin crear el PR', () => {
    const sb = workspace.sandbox()
    sb.fail(`git push -u origin ${RELEASE_BRANCH}`)
    sb.assertAborted(sb.release('patch'), `No se pudo pushear la rama ${RELEASE_BRANCH}`)
    assert.equal(sb.hasEvent('gh pr create'), false)
  })

  test('si gh no crea el PR aborta', () => {
    const sb = workspace.sandbox()
    sb.prCreateStatus = 1
    sb.assertAborted(sb.release('patch'), 'No se pudo crear el PR')
    assert.ok(sb.output.stderr.includes('pr rechazado\n'))
    assert.equal(sb.hasEvent('gh pr merge'), false)
  })

  test('si la salida de gh no trae el numero del PR aborta sin mergear', () => {
    const sb = workspace.sandbox()
    sb.prCreateOutput = 'https://example.invalid/pull/nuevo\n'
    sb.assertAborted(
      sb.release('patch'),
      "No se pudo extraer el numero del PR de la salida de gh: 'https://example.invalid/pull/nuevo'. El PR quedo creado; retoma con /mefisto-merge <pr>, luego git switch main && git pull --ff-only, luego /mefisto-release (sin argumentos).",
    )
    assert.equal(sb.hasEvent('gh pr merge'), false)
  })
})
