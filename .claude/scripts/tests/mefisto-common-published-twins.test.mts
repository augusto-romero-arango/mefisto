// Paridad de las funciones de `_mefisto-common.sh` cuya gemela en TypeScript es la del lado
// publicado: el comportamiento es el mismo y no hay modulo interno aparte.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { caffeinatePrefix } from '../../../scripts/lib/pipeline/caffeinate.mts'
import { findOpenPrForBranch } from '../../../scripts/lib/pipeline/pull-requests.mts'
import { validateVariantLabel } from '../../../scripts/lib/pipeline/variant.mts'
import { FAKE_GH, mefistoBash, NO_BASH, NO_BASH_JQ } from './mefisto-common-parity.mts'

function fakeGh(stdout: string, status: number): { run: Run; calls: string[][] } {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    return { status, stdout, stderr: status === 0 ? '' : 'error: not authenticated' }
  }
  return { run, calls }
}

describe('find_open_pr_for_branch interna', { skip: NO_BASH_JQ }, () => {
  const PR_42 = '[{"url":"https://github.com/owner/repo/pull/42"}]\n'

  test('findOpenPrForBranch devuelve lo mismo', () => {
    const responses: [string, number][] = [
      [PR_42, 0],
      ['[{"url":"https://github.com/o/r/pull/1"},{"url":"https://github.com/o/r/pull/2"}]', 0],
      ['[]', 0],
      ['[{"url":null}]', 0],
      ['[{}]', 0],
      ['[{"url":"null"}]', 0],
      [PR_42, 1],
    ]
    const script = `${FAKE_GH}
find_open_pr_for_branch "$1" "$2" "$3"; echo "rc=$?"`
    for (const [stdout, status] of responses) {
      for (const [branch, repo, base] of [
        ['worktree-mefisto-issue-1-x', '', ''],
        ['worktree-mefisto-issue-1-x', 'owner/repo', 'develop'],
        ['', '', ''],
      ] as const) {
        const env = { ...process.env, GH_JSON: stdout, GH_RC: String(status) }
        const fromBash = mefistoBash(script, [branch, repo, base], { env })
        const options = { run: fakeGh(stdout, status).run, repo, ...(base.length > 0 ? { base } : {}) }
        assert.equal(`${findOpenPrForBranch(branch, options) ?? ''}\nrc=0\n`, fromBash.stdout, `${stdout} ${branch}`)
      }
    }
  })

  test('findOpenPrForBranch pasa a gh los mismos filtros', () => {
    const script = `gh() { printf '%s\\n' "$@"; }
find_open_pr_for_branch "$1" "$2" "$3"`
    for (const [repo, base] of [
      ['', ''],
      ['owner/repo', ''],
      ['', 'develop'],
      ['owner/repo', 'develop'],
    ] as const) {
      const gh = fakeGh('[]', 0)
      findOpenPrForBranch('rama-x', { run: gh.run, repo, ...(base.length > 0 ? { base } : {}) })
      const fromBash = mefistoBash(script, ['rama-x', repo, base]).stdout.trimEnd().split('\n')
      // La gemela bash delega en `-q` de gh lo que la de TypeScript lee del JSON.
      const query = fromBash.indexOf('-q')
      assert.deepEqual(fromBash.splice(query, 2), ['-q', '.[0].url'])
      assert.deepEqual(gh.calls[0]?.slice(1), fromBash)
    }
  })
})

describe('validate_variant_label interna', { skip: NO_BASH }, () => {
  test('validateVariantLabel da el mismo veredicto y el mismo motivo', () => {
    const labels = [
      '',
      'a',
      'experimento-a',
      '123-456',
      '-',
      '--',
      'a'.repeat(40),
      'a'.repeat(41),
      'Experimento',
      'experimento_a',
      'experimento a',
      'experimento.a',
      'a/b',
      'ñandu',
      'ñ'.repeat(40),
      'ñ'.repeat(41),
      'A'.repeat(41),
      ' a',
      'a\t',
      'a$b',
      "a'b",
      'a\nb',
      'A\nb',
      'A\nB',
      'a\n',
      '\n',
    ]
    const script =
      'for label in "$@"; do validate_variant_label "$label"; printf "%s|%s\\0" "$?" "$MEFISTO_VARIANT_LABEL_ERROR"; done'
    const fromBash = mefistoBash(script, labels)
    assert.equal(fromBash.status, 0, fromBash.stderr)
    const verdicts = fromBash.stdout.split('\0').slice(0, -1)
    assert.equal(verdicts.length, labels.length)
    labels.forEach((label, index) => {
      const error = validateVariantLabel(label)
      assert.equal(`${error === null ? 0 : 1}|${error ?? ''}`, verdicts[index], JSON.stringify(label))
    })
  })
})

describe('caffeinate_prefix interna', { skip: NO_BASH }, () => {
  test('caffeinatePrefix devuelve el mismo prefijo', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mefisto caffeinate interno '))
    try {
      const withBinary = join(tmp, 'con')
      const withoutBinary = join(tmp, 'sin')
      mkdirSync(withBinary)
      mkdirSync(withoutBinary)
      writeFileSync(join(withBinary, 'caffeinate'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(withBinary, 'caffeinate'), 0o755)
      for (const path of [withBinary, withoutBinary, '']) {
        const fromBash = mefistoBash('PATH="$1"; caffeinate_prefix; echo "|rc=$?"', [path])
        assert.equal(`${caffeinatePrefix({ PATH: path }, 'darwin').join(' ')}|rc=0\n`, fromBash.stdout, path)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
