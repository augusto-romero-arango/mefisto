import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { COLOR } from '../../../scripts/lib/cli.mts'
import { git, gitOk } from '../../../scripts/tests/field-note-sandbox.mts'
import { ABORT, RELEASE_NOTES, Workspace, remoteTag } from './mefisto-release-sandbox.mts'

const RELEASE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'internal', 'scripts', 'mefisto-release.mts')
const NOT_WINDOWS = process.platform === 'win32' ? 'el gh simulado es bash' : false
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  'repo view') echo owner/mefisto ;;
  'auth status') ;;
  'release view') exit 1 ;;
  'pr create') echo https://example.invalid/pull/42 ;;
  'release create') echo https://example.invalid/releases/v1.2.3 ;;
  *) echo "gh simulado no esperaba: $*" >&2; exit 64 ;;
esac
`
const FAKE_GENERATOR = [
  "import { copyFileSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "const root = join(import.meta.dirname, '..', '..', '..')",
  "copyFileSync(join(root, 'mefisto-manifest.json'), join(root, 'dist', 'claude', 'mefisto-manifest.json'))",
  "writeFileSync(join(root, 'dist', 'claude', '.mefisto-generated-assets.json'), '{\"schemaVersion\":1,\"assets\":[]}\\n')",
  '',
].join('\n')

let workspace: Workspace

before(() => {
  workspace = new Workspace('mefisto release publish ')
})

after(() => {
  workspace.dispose()
})

describe('fase publish', () => {
  test('publica el tag anotado y el release con las notas integras de la seccion', () => {
    const sb = workspace.synced()
    assert.equal(sb.release(), 0, sb.output.stderr)
    assert.equal(remoteTag(sb, 'v1.2.3'), sb.mergeSha)
    assert.equal(git(sb.repo, 'tag', '-l', '--format=%(contents:subject)', 'v1.2.3'), 'Release v1.2.3')
    assert.equal(sb.releases.get('v1.2.3'), RELEASE_NOTES)
    assert.equal(sb.hasEvent('gate'), false)
    assert.equal(sb.hasEvent('generator'), false)
    assert.ok(sb.output.stdout.includes(`\n${COLOR.cyan}${COLOR.bold}=== Fase publish ===${COLOR.reset}\n`))
    assert.ok(sb.output.stdout.includes(' Tag a crear: v1.2.3 (publicando 1.2.2 -> 1.2.3)\n'))
    assert.equal(sb.output.stderr, '')
  })

  test('avisa de que ignora el primer argumento', () => {
    const sb = workspace.synced()
    assert.equal(sb.release('minor', '--prepare-only'), 0, sb.output.stderr)
    assert.equal(
      sb.output.stderr,
      `${COLOR.yellow}!${COLOR.reset} Argumento 'minor' ignorado en fase publish (plugin.json ya esta bumpeado).\n`,
    )
    assert.ok(sb.hasRemoteTag('v1.2.3'))
  })

  test('fuera de main aborta', () => {
    const sb = workspace.synced()
    git(sb.repo, 'switch', '-q', '-c', 'otra')
    sb.assertAborted(sb.release(), "Debes estar en 'main' para publicar el release (rama actual: otra).")
    assert.equal(sb.hasEvent('git fetch'), false)
  })

  test('con cambios sin commitear aborta', () => {
    const sb = workspace.synced()
    writeFileSync(join(sb.repo, 'suelto.txt'), 'x\n')
    sb.assertAborted(sb.release(), 'Hay cambios sin commitear. Limpia el working tree antes de continuar.')
  })

  test('con main por detras o por delante de origin/main aborta', () => {
    const behind = workspace.synced()
    behind.pushToMain('ajeno.txt')
    behind.assertAborted(
      behind.release(),
      "main local esta 1 commit(s) detras de origin/main. Ejecuta 'git pull --ff-only' y reintenta.",
    )

    const ahead = workspace.synced()
    git(ahead.repo, 'commit', '-q', '--allow-empty', '-m', 'local')
    ahead.assertAborted(
      ahead.release(),
      'main local tiene 1 commit(s) que no estan en origin/main. Pushea o resetea antes de publicar.',
    )
    assert.equal(ahead.hasRemoteTag('v1.2.3'), false)
  })

  test('una identidad invalida aborta', () => {
    const sb = workspace.prepared()
    sb.mutateMerge = (clone) => {
      writeFileSync(
        join(clone, 'src', 'published', 'release-identity.json'),
        '{"schemaVersion":1,"version":"1.2.3","commit":"corto"}\n',
      )
    }
    sb.mergeAndSync()
    sb.assertAborted(
      sb.release(),
      'release-identity.json es invalido; regenera la metadata con /mefisto-release <bump> antes de publicar',
    )
    assert.equal(sb.hasEvent('git tag -a'), false)
  })

  test('un merge que no fue squash sobre el commit fuente aborta', () => {
    const sb = workspace.prepared()
    sb.pushToMain('ajeno.txt')
    sb.mergeAndSync()
    sb.assertAborted(
      sb.release(),
      'El padre directo de HEAD no coincide con el commit fuente de release-identity.json; la release debe mergearse por squash y regenerarse',
    )
    assert.equal(sb.hasEvent('git tag -a'), false)
  })

  test('una identidad de otra version aborta', () => {
    const sb = workspace.prepared()
    sb.mutateMerge = (clone) => {
      writeFileSync(
        join(clone, '.claude-plugin', 'plugin.json'),
        '{\n  "name": "mefisto",\n  "version": "1.2.4"\n}\n',
      )
    }
    sb.mergeAndSync()
    sb.assertAborted(sb.release(), 'release-identity.json reporta 1.2.3, no 1.2.4; regenera la metadata')
  })

  test('un manifiesto que no coincide con la identidad aborta', () => {
    const root = workspace.prepared()
    root.mutateMerge = (clone) => {
      writeFileSync(join(clone, 'mefisto-manifest.json'), root.manifest('1.2.2'))
    }
    root.mergeAndSync()
    root.assertAborted(
      root.release(),
      'El manifiesto Claude mefisto-manifest.json no coincide con release-identity.json; regenera la metadata',
    )

    const dist = workspace.prepared()
    dist.mutateMerge = (clone) => {
      writeFileSync(join(clone, 'dist', 'claude', 'mefisto-manifest.json'), '{}\n')
    }
    dist.mergeAndSync()
    dist.assertAborted(
      dist.release(),
      'El manifiesto Claude dist/claude/mefisto-manifest.json no coincide con release-identity.json; regenera la metadata',
    )
  })

  test('dos manifiestos equivalentes pero no identicos por bytes abortan', () => {
    const sb = workspace.prepared()
    sb.mutateMerge = (clone) => {
      writeFileSync(
        join(clone, 'dist', 'claude', 'mefisto-manifest.json'),
        sb.manifest('1.2.3').replace('{', '{ '),
      )
    }
    sb.mergeAndSync()
    sb.assertAborted(
      sb.release(),
      'Los manifiestos Claude de raiz y dist/claude difieren por bytes; regenera la metadata',
    )
  })

  test('un delta con rutas ajenas a la release aborta sin crear el tag', () => {
    const sb = workspace.prepared()
    sb.mutateMerge = (clone) => {
      writeFileSync(join(clone, 'ajeno.txt'), 'x\n')
    }
    sb.mergeAndSync()
    sb.assertAborted(
      sb.release(),
      `El delta ${sb.source}..HEAD contiene rutas ajenas a la allowlist mecanica de release; regenera la metadata en un squash limpio`,
    )
    assert.equal(sb.hasEvent('git tag -a'), false)
    assert.equal(sb.hasRemoteTag('v1.2.3'), false)
  })

  test('si el tag o el release ya existen aborta', () => {
    const local = workspace.synced()
    local.answer('git rev-parse -q --verify refs/tags/v1.2.3', `${local.source}\n`)
    local.assertAborted(local.release(), 'Ya existe el tag local v1.2.3. Aborta.')

    const remote = workspace.synced()
    remote.answer('git ls-remote --tags --exit-code origin v1.2.3', 'x\trefs/tags/v1.2.3\n')
    remote.assertAborted(remote.release(), 'Ya existe el tag remoto v1.2.3. Aborta.')

    const released = workspace.synced()
    released.releases.set('v1.2.3', 'previo')
    released.assertAborted(released.release(), 'Ya existe un GitHub Release v1.2.3. Aborta.')
    assert.equal(released.hasEvent('git tag -a'), false)
  })

  test('si el push del tag falla revierte el tag local', () => {
    const sb = workspace.synced()
    sb.fail('git push origin v1.2.3')
    sb.assertAborted(sb.release(), 'No se pudo pushear el tag v1.2.3 (tag local revertido)')
    assert.ok(sb.inOrder('git tag -a v1.2.3', 'git tag -d v1.2.3'))
    assert.equal(gitOk(sb.repo, 'rev-parse', '-q', '--verify', 'refs/tags/v1.2.3'), false)
    assert.equal(sb.hasEvent('gh release create'), false)
  })

  test('si gh no crea el release deja el tag e imprime la recuperacion', () => {
    const sb = workspace.synced()
    sb.releaseCreateStatus = 1
    assert.equal(sb.release(), 1)
    assert.ok(sb.hasRemoteTag('v1.2.3'))
    assert.equal(
      sb.output.stderr,
      [
        'HTTP 500',
        `${ABORT}No se pudo crear el GitHub Release v1.2.3. El tag ya esta pusheado; no reedites la version ni el tag.`,
        'Recuperacion (ejecuta el bloque completo desde la raiz del repo):',
        '  recovery_notes=$(mktemp)',
        `  trap 'rm -f "$recovery_notes"' EXIT`,
        String.raw`  python3 -c 'import re,sys; text=open(sys.argv[1], encoding="utf-8").read(); match=re.search(r"(?ms)^##\s*\[" + re.escape(sys.argv[2]) + r"\][^\n]*\n(.*?)(?=^##\s*\[|^\[Unreleased\]:|\Z)", text); print(match.group(1).strip()) if match else sys.exit(1)' CHANGELOG.md "1.2.3" > "$recovery_notes"`,
        '  gh release create "v1.2.3" --title "v1.2.3" --notes-file "$recovery_notes"',
        '',
      ].join('\n'),
    )
  })
})

describe('proceso real', { skip: NOT_WINDOWS }, () => {
  test('prepara y publica con git real, gate y generador simulados en Node, y gh simulado en el PATH', () => {
    const sb = workspace.sandbox({
      'src/internal/scripts/mefisto-neutrality-gate.mts': 'process.exitCode = 0\n',
      'src/published/scripts/generate-published-adapters.mts': FAKE_GENERATOR,
    })
    const bin = join(sb.dir, 'bin')
    const ghLog = join(sb.dir, 'gh.log')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), FAKE_GH)
    chmodSync(join(bin, 'gh'), 0o755)
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [RELEASE, ...args], {
        cwd: sb.repo,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, GH_LOG: ghLog },
      })

    const prepared = run('patch', '--prepare-only')
    assert.equal(prepared.status, 0, prepared.stderr)
    assert.ok(prepared.stdout.includes('PR de release creado: https://example.invalid/pull/42\n'))
    assert.ok(prepared.stdout.endsWith('  /mefisto-release   # (sin argumentos) para publicar el tag y el release\n'))
    assert.equal(sb.read('src/published/release-identity.json'), sb.identity('1.2.3'))
    assert.equal(sb.read('dist/claude/mefisto-manifest.json'), sb.manifest('1.2.3'))
    assert.equal(git(sb.repo, 'log', '-1', '--format=%s'), 'chore(release): v1.2.3')
    assert.equal(git(sb.repo, 'status', '--porcelain'), '')

    const mergeSha = sb.squashMerge()
    git(sb.repo, 'switch', '-q', 'main')
    git(sb.repo, 'pull', '-q', '--ff-only', 'origin', 'main')
    const published = run()
    assert.equal(published.status, 0, published.stderr)
    assert.equal(remoteTag(sb, 'v1.2.3'), mergeSha)
    assert.ok(published.stdout.endsWith('  Release: https://example.invalid/releases/v1.2.3\n'))
    const calls = readFileSync(ghLog, 'utf8').split('\n')
    assert.ok(calls.some((call) => call.startsWith('pr create --base main --head release/v1.2.3 ')))
    assert.ok(calls.some((call) => call.startsWith('release create v1.2.3 --title v1.2.3 --notes-file ')))
    assert.equal(calls.some((call) => call.startsWith('pr merge')), false)
  })
})
