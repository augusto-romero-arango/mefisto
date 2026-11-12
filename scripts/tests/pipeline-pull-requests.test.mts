import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Run } from '../lib/azure-cli.mts'
import { findOpenPrForBranch } from '../lib/pipeline/pull-requests.mts'

interface FakeGh {
  run: Run
  calls: string[][]
}

function fakeGh(stdout: string, status: number | null = 0): FakeGh {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    return { status, stdout, stderr: status === 0 ? '' : 'error: not authenticated' }
  }
  return { run, calls }
}

const PR_42 = '[{"url":"https://github.com/owner/repo/pull/42"}]\n'

describe('findOpenPrForBranch', () => {
  test('con un PR abierto devuelve su URL', () => {
    const gh = fakeGh(PR_42)
    assert.equal(findOpenPrForBranch('worktree-issue-1-x', { run: gh.run }), 'https://github.com/owner/repo/pull/42')
  })

  test('con varios PR abiertos devuelve el primero', () => {
    const several = '[{"url":"https://github.com/o/r/pull/1"},{"url":"https://github.com/o/r/pull/2"}]'
    assert.equal(findOpenPrForBranch('rama', { run: fakeGh(several).run }), 'https://github.com/o/r/pull/1')
  })

  test('filtra por la base main si no se indica otra', () => {
    const gh = fakeGh(PR_42)
    findOpenPrForBranch('worktree-issue-7-t', { run: gh.run })
    assert.deepEqual(gh.calls, [
      ['gh', 'pr', 'list', '--head', 'worktree-issue-7-t', '--base', 'main', '--state', 'open', '--json', 'url'],
    ])
  })

  test('la base explicita y el repo se propagan a gh', () => {
    const gh = fakeGh(PR_42)
    findOpenPrForBranch('worktree-issue-8-s', { run: gh.run, base: 'develop', repo: 'owner/repo' })
    assert.deepEqual(gh.calls, [
      ['gh', 'pr', 'list', '--head', 'worktree-issue-8-s', '--base', 'develop', '--state', 'open', '--json', 'url', '--repo', 'owner/repo'],
    ])

    const sinRepo = fakeGh(PR_42)
    findOpenPrForBranch('rama', { run: sinRepo.run, repo: '' })
    assert.equal(sinRepo.calls[0]?.includes('--repo'), false)
  })

  test('sin PR abierto devuelve null', () => {
    assert.equal(findOpenPrForBranch('worktree-issue-2-y', { run: fakeGh('[]\n').run }), null)
    assert.equal(findOpenPrForBranch('worktree-issue-2-y', { run: fakeGh('').run }), null)
  })

  test('si gh falla o no esta disponible degrada a null', () => {
    assert.equal(findOpenPrForBranch('worktree-issue-3-z', { run: fakeGh(PR_42, 1).run }), null)
    assert.equal(findOpenPrForBranch('worktree-issue-4-w', { run: fakeGh('', null).run }), null)
  })

  test('con la rama vacia no consulta', () => {
    const gh = fakeGh(PR_42)
    assert.equal(findOpenPrForBranch('', { run: gh.run }), null)
    assert.deepEqual(gh.calls, [])
  })

  test('una URL nula o una respuesta ilegible no se reutiliza como PR', () => {
    for (const stdout of ['[{"url":null}]', '[{}]', '[{"url":"null"}]', '[{"url":""}]', 'null', '{}', 'no soy json']) {
      assert.equal(findOpenPrForBranch('worktree-issue-6-u', { run: fakeGh(stdout).run }), null, stdout)
    }
  })

})
