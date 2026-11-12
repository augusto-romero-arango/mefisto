// Hook pre-push de rescate (src/internal/githooks/pre-push): lo ejecuta Git en un `git push` real
// contra un remoto local, con un `gh` falso en el PATH. El hook es bash; sin bash el test se salta.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture } from '../../../scripts/lib/cli.mts'
import { git, isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import { NO_BASH } from '../../../scripts/tests/markdown-bash.mts'

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'internal', 'githooks')

let work = ''
let restoreGit = (): void => {}
let bin = ''
let counter = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto pre-push '))
  restoreGit = isolateGitConfig(work)
  bin = join(work, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env bash\necho "$*" >> "$GH_LOG"\n[ "${GH_FAIL:-0}" = 1 ] && { echo "gh boom" >&2; exit 1; }\necho "https://github.com/o/r/pull/77"\n',
    { mode: 0o755 },
  )
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

interface Repo {
  work: string
  remote: string
  ghLog: string
}

/** Clon con un commit ya en origin/main y otro solo local, con el hook activo. */
function repo(): Repo {
  const dir = join(work, `caso-${++counter}`)
  const remote = join(dir, 'remote.git')
  const clone = join(dir, 'work')
  mkdirSync(clone, { recursive: true })
  git(dir, 'init', '-q', '--bare', remote)
  git(clone, 'init', '-q')
  git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(clone, 'config', 'user.email', 't@t')
  git(clone, 'config', 'user.name', 't')
  git(clone, 'remote', 'add', 'origin', remote)
  writeFileSync(join(clone, 'a'), '1\n')
  git(clone, 'add', 'a')
  git(clone, 'commit', '-qm', 'base')
  git(clone, 'push', '-q', 'origin', 'main')
  writeFileSync(join(clone, 'a'), '2\n')
  git(clone, 'commit', '-qam', 'cambio directo')
  git(clone, 'config', 'core.hooksPath', HOOKS)
  const ghLog = join(dir, 'gh.log')
  writeFileSync(ghLog, '')
  return { work: clone, remote, ghLog }
}

function push(r: Repo, refspec: string, env: NodeJS.ProcessEnv = {}) {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const result = capture('git', ['push', 'origin', refspec], {
    cwd: r.work,
    env: { ...process.env, [pathKey]: [bin, process.env[pathKey] ?? ''].join(delimiter), GH_LOG: r.ghLog, ...env },
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

const remoteRef = (r: Repo, ref: string): string => capture('git', ['--git-dir', r.remote, 'rev-parse', '--verify', '-q', ref]).stdout.trim()
const rescueBranches = (r: Repo): string => git(r.work, '--git-dir', r.remote, 'branch', '--list', 'rescate/*')

describe('hook pre-push', { skip: NO_BASH }, () => {
  test('[A] un push directo a main se desvia a una rama de rescate con su PR', () => {
    const r = repo()
    const head = git(r.work, 'rev-parse', 'HEAD')
    const run = push(r, 'main')
    assert.notEqual(run.status, 0)
    assert.match(run.output, /entregado como PR #77/)
    assert.notEqual(remoteRef(r, 'main'), head)
    assert.match(rescueBranches(r), /rescate\/\d{4}-\d\d-\d\d-[0-9a-f]+/)
    assert.match(readFileSync(r.ghLog, 'utf8'), /pr create --base main --head rescate\/.*cambio directo/)
    assert.equal(readFileSync(join(r.work, '.mefisto', 'pipeline', 'rescued-main.txt'), 'utf8'), `${head}\n`)
  })

  test('[B] un push a otra rama pasa sin intervencion', () => {
    const r = repo()
    const run = push(r, 'HEAD:refs/heads/feature/x')
    assert.equal(run.status, 0, run.output)
    assert.equal(readFileSync(r.ghLog, 'utf8'), '')
    assert.equal(remoteRef(r, 'feature/x'), git(r.work, 'rev-parse', 'HEAD'))
  })

  test('[C] si no se puede empujar la rama de rescate, rechaza sin PR y da el comando para reintentar', () => {
    const r = repo()
    writeFileSync(
      join(r.remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\nwhile read o n r; do case "$r" in refs/heads/rescate/*) exit 1;; esac; done\n',
      { mode: 0o755 },
    )
    const run = push(r, 'main')
    assert.notEqual(run.status, 0)
    assert.equal(readFileSync(r.ghLog, 'utf8'), '')
    assert.match(run.output, /Reintenta: git push --no-verify origin [0-9a-f]+:refs\/heads\/rescate\//)
    assert.equal(rescueBranches(r), '')
  })

  test('[D] si gh falla, la rama queda empujada y se imprime el gh pr create para hacerlo a mano', () => {
    const r = repo()
    const run = push(r, 'main', { GH_FAIL: '1' })
    assert.notEqual(run.status, 0)
    assert.match(rescueBranches(r), /rescate\//)
    assert.match(run.output, /'gh pr create' fallo: gh boom/)
    assert.match(run.output, /gh pr create --base main --head rescate\//)
  })
})
