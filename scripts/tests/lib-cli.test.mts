import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CliError, capture, commandExists, gitOutput, repoRoot } from '../lib/cli.mts'

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto cli '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('procesos', () => {
  test('capture devuelve salida y codigo sin pasar por un shell', () => {
    const ok = capture(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b; echo c'])
    assert.deepEqual(ok, { status: 0, stdout: 'a b; echo c', stderr: '' })
    const failed = capture(process.execPath, ['-e', 'console.error("mal"); process.exit(3)'])
    assert.equal(failed.status, 3)
    assert.match(failed.stderr, /mal/)
  })

  test('capture entrega stdin y respeta cwd', () => {
    const script = 'process.stdin.on("data", (d) => process.stdout.write(process.cwd() + "|" + d))'
    const result = capture(process.execPath, ['-e', script], { cwd: work, input: 'hola' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /\|hola$/)
  })

  test('un programa que no existe devuelve status null', () => {
    assert.equal(capture('mefisto-no-existe-este-programa', []).status, null)
  })

  test('commandExists encuentra programas del PATH', () => {
    assert.equal(commandExists('git'), true)
    assert.equal(commandExists('mefisto-no-existe-este-programa'), false)
    assert.equal(commandExists('git', { PATH: '' }), false)
  })
})

describe('git', () => {
  test('repoRoot resuelve la raiz desde un subdirectorio y null fuera de un repo', () => {
    const repo = join(work, 'repo con espacios')
    const sub = join(repo, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    execFileSync('git', ['init', '--quiet', repo])
    writeFileSync(join(sub, 'x.txt'), 'x')
    const root = repoRoot(sub)
    assert.notEqual(root, null)
    assert.equal(repoRoot(repo), root)
    assert.equal(gitOutput(['rev-parse', '--is-inside-work-tree'], sub), 'true')

    const outside = join(work, 'sin repo')
    mkdirSync(outside)
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = work
    try {
      assert.equal(repoRoot(outside), null)
      assert.equal(gitOutput(['rev-parse', '--show-toplevel'], outside), null)
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
    }
  })
})

describe('CliError', () => {
  test('lleva el mensaje y el codigo de salida', () => {
    const error = new CliError('ERROR: algo', 2)
    assert.equal(error.message, 'ERROR: algo')
    assert.equal(error.exitCode, 2)
    assert.equal(new CliError('x').exitCode, 1)
    assert.ok(error instanceof Error)
  })
})
