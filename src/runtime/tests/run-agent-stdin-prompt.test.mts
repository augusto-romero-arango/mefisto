import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { readEvents, runRunner, terminalsOf } from './runner-sandbox.mts'

// Mayor que el limite de argv de cualquier sistema: 1 MiB en macOS, 2 MiB en Linux, 32 KiB en Windows.
const PROMPT_BYTES = 3 * 1024 * 1024
const SENTINEL = 'MEFISTO_ARGMAX_SENTINEL_1447'.padEnd(64)

let work = ''
let fixture = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto stdin prompt '))
  mkdirSync(join(work, 'wt'))
  const block = 'linea con tab\tdolar $HOME y barra \\ y unicode: ñáéíóú 日本語\n'
  fixture = join(work, 'fixture-argmax.bin')
  writeFileSync(fixture, block.repeat(Math.ceil(PROMPT_BYTES / Buffer.byteLength(block))) + SENTINEL)
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('prompt por la entrada estandar', () => {
  test('control: el mismo prompt como argumento unico no se puede lanzar', () => {
    const prompt = readFileSync(fixture, 'utf8')
    assert.equal(Buffer.byteLength(prompt) >= PROMPT_BYTES, true)
    assert.equal(prompt.endsWith(SENTINEL), true)
    const result = spawnSync(process.execPath, ['-e', '', prompt])
    assert.notEqual(result.error, undefined)
    if (process.platform !== 'win32') assert.equal((result.error as NodeJS.ErrnoException).code, 'E2BIG')
  })

  test('el runner lo entrega byte a byte por stdin, que no es una terminal, y nunca por argv', async () => {
    const eventLog = join(work, 'event-log.jsonl')
    const dump = join(work, 'stdin-dump.bin')
    const argsFile = join(work, 'fake-args.txt')
    const run = await runRunner(
      ['--runtime', 'fake', '--agent', 'test-agent', '--cwd', join(work, 'wt'), '--prompt-file', fixture, '--event-log', eventLog, '--timeout', '60'],
      { MEFISTO_FAKE_SCRIPT: 'dump-stdin', MEFISTO_FAKE_STDIN_DUMP_FILE: dump, MEFISTO_FAKE_ARGS_FILE: argsFile },
    )
    assert.equal(run.status, 0, run.stderr)
    const terminals = terminalsOf(readEvents(eventLog))
    assert.deepEqual(terminals.map((event) => [event.type, event.status]), [['run.completed', 'success']])
    assert.equal(readFileSync(dump).equals(readFileSync(fixture)), true)
    const args = readFileSync(argsFile, 'utf8')
    assert.equal(args.includes(SENTINEL), false)
    assert.equal(args.split('\n').includes('STDIN_TTY=0'), true)
  })
})
