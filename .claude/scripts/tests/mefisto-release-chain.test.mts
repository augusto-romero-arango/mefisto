import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { COLOR } from '../../../scripts/lib/cli.mts'
import { git } from '../../../scripts/tests/field-note-sandbox.mts'
import {
  ABORT,
  RELEASED_CHANGELOG,
  RELEASE_NOTES,
  RELEASE_URL,
  Workspace,
  remoteTag,
} from './mefisto-release-sandbox.mts'

let workspace: Workspace

before(() => {
  workspace = new Workspace('mefisto release chain ')
})

after(() => {
  workspace.dispose()
})

describe('remate: merge, sync y publish encadenados', () => {
  test('mergea el PR, sincroniza main y publica el tag con su GitHub Release', () => {
    const sb = workspace.sandbox()
    assert.equal(sb.release('patch'), 0, sb.output.stderr)

    const chain = [
      'gh pr merge 42 --squash --delete-branch',
      'gh pr view 42 --json state,mergeCommit',
      'git fetch origin main --quiet',
      `git merge-base --is-ancestor ${sb.mergeSha} origin/main`,
      'git switch main',
      'git merge --ff-only origin/main',
      'git tag -a v1.2.3 -m Release v1.2.3',
      'git push origin v1.2.3',
      'gh release create v1.2.3 --title v1.2.3 --notes-file ',
    ]
    for (let i = 1; i < chain.length; i++) assert.ok(sb.inOrder(chain[i - 1] ?? '', chain[i] ?? ''), chain[i])
    assert.ok(sb.inOrder('gh pr create', 'gh pr merge'))
    assert.deepEqual(sb.sleeps, [])
    assert.equal(sb.events.filter((event) => event === 'gate').length, 1, 'publish no repite el gate')

    assert.equal(sb.branch(), 'main')
    assert.equal(git(sb.repo, 'rev-parse', 'HEAD'), sb.mergeSha)
    assert.equal(git(sb.repo, 'rev-parse', 'HEAD^'), sb.source)
    assert.equal(remoteTag(sb, 'v1.2.3'), sb.mergeSha)
    assert.equal(git(sb.origin, 'cat-file', '-t', 'refs/tags/v1.2.3'), 'tag')
    assert.equal(sb.releases.get('v1.2.3'), RELEASE_NOTES)
    assert.equal(sb.read('CHANGELOG.md'), RELEASED_CHANGELOG)

    assert.ok(sb.output.stdout.includes(`\n${COLOR.cyan}${COLOR.bold}=== Encadenando merge + sync + publish ===${COLOR.reset}\n`))
    assert.ok(sb.output.stdout.includes(' Encadenando fase publish (re-invocando mefisto-release.mts sin argumentos)...\n'))
    assert.ok(sb.output.stdout.includes(`${COLOR.green}${COLOR.bold}v${COLOR.reset} PR #42 MERGED (commit ${sb.mergeSha}).\n`))
    assert.ok(
      sb.output.stdout.endsWith(
        [
          `${COLOR.green}${COLOR.bold}v${COLOR.reset} GitHub Release publicado: ${RELEASE_URL}`,
          '',
          `${COLOR.cyan}${COLOR.bold}=== Resumen publish ===${COLOR.reset}`,
          '  v1.2.2 -> v1.2.3',
          '  Tag:     v1.2.3',
          `  Release: ${RELEASE_URL}`,
          '',
        ].join('\n'),
      ),
    )
  })

  test('si el PR no llega a MERGED reintenta tres veces y aborta sin tocar main', () => {
    const sb = workspace.sandbox()
    sb.prState = 'OPEN'
    sb.assertAborted(
      sb.release('patch'),
      "No se pudo confirmar el estado MERGED del PR #42 tras reintentos. Hecho: merge disparado contra GitHub. Paso manual: verifica 'gh pr view 42'; luego git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).",
    )
    assert.equal(sb.events.filter((event) => event.startsWith('gh pr view')).length, 3)
    assert.deepEqual(sb.sleeps, [2000, 2000, 2000])
    assert.equal(sb.hasEvent('git switch main'), false)
    assert.equal(sb.hasEvent('git tag -a'), false)
  })

  test('una respuesta de gh que no es JSON cuenta como PR sin confirmar', () => {
    const sb = workspace.sandbox()
    sb.answer('gh pr view 42 --json state,mergeCommit', 'no es json')
    assert.equal(sb.release('patch'), 1)
    assert.ok(sb.output.stderr.includes('No se pudo confirmar el estado MERGED del PR #42 tras reintentos.'))
  })

  test('si el fetch de main falla aborta nombrando el paso manual', () => {
    const sb = workspace.sandbox()
    sb.fail('git fetch origin main --quiet')
    const code = sb.release('patch')
    sb.assertAborted(
      code,
      `git fetch origin main fallo. Hecho: PR #42 mergeado (commit ${sb.mergeSha}). Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
    assert.equal(sb.hasEvent('git merge-base'), false)
  })

  test('si el commit de merge no aparece en origin/main reintenta con fetch y aborta', () => {
    const sb = workspace.sandbox()
    sb.answer('gh pr view 42 --json state,mergeCommit', JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } }))
    sb.assertAborted(
      sb.release('patch'),
      `El commit de merge ${'d'.repeat(40)} no aparece como ancestro de origin/main tras reintentos. Hecho: PR #42 mergeado. Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
    assert.equal(sb.events.filter((event) => event.startsWith('git merge-base --is-ancestor')).length, 3)
    assert.equal(sb.events.filter((event) => event === 'git fetch origin main --quiet').length, 4)
    assert.deepEqual(sb.sleeps, [2000, 2000, 2000])
    assert.equal(sb.hasEvent('git switch main'), false)
  })

  test('si no puede cambiar a main aborta sin publicar', () => {
    const sb = workspace.sandbox()
    sb.fail('git switch main')
    const code = sb.release('patch')
    sb.assertAborted(
      code,
      `No se pudo hacer 'git switch main'. Hecho: merge #42 confirmado en origin/main (${sb.mergeSha}). Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
    assert.equal(sb.hasEvent('git merge --ff-only'), false)
    assert.equal(sb.hasEvent('git tag -a'), false)
  })

  test('si el fast-forward de main falla aborta sin publicar', () => {
    const sb = workspace.sandbox()
    sb.fail('git merge --ff-only origin/main')
    const code = sb.release('patch')
    sb.assertAborted(
      code,
      `'git merge --ff-only origin/main' fallo. Hecho: merge #42 confirmado en origin/main (${sb.mergeSha}), ya en rama main. Paso manual: git merge --ff-only origin/main; luego /mefisto-release (sin argumentos).`,
    )
    assert.equal(sb.hasEvent('git tag -a'), false)
  })

  test('si la fase publish falla reporta su precondicion y el paso manual', () => {
    const sb = workspace.sandbox()
    sb.authFailsFrom = 2
    const code = sb.release('patch')
    assert.equal(code, 1)
    assert.ok(
      sb.output.stderr.endsWith(
        [
          `${ABORT}gh no esta autenticado. Ejecuta 'gh auth login' y reintenta.`,
          `${ABORT}La fase publish fallo. Hecho: PR #42 mergeado y main sincronizado (commit ${sb.mergeSha}). Paso manual: resuelve la precondicion reportada arriba y reintenta con '/mefisto-release' (sin argumentos).`,
          '',
        ].join('\n'),
      ),
      sb.output.stderr,
    )
    assert.equal(sb.hasEvent('git tag -a'), false)
    assert.equal(sb.hasRemoteTag('v1.2.3'), false)
  })
})
