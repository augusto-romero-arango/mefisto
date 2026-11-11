import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { caffeinatePrefix } from '../lib/pipeline/caffeinate.mts'
import { bashLibrary, NO_BASH } from './pipeline-scope-parity.mts'

let tmp = ''
let withBinary = ''
let withoutBinary = ''

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mefisto caffeinate '))
  withBinary = join(tmp, 'con')
  withoutBinary = join(tmp, 'sin')
  mkdirSync(withBinary)
  mkdirSync(withoutBinary)
  writeFileSync(join(withBinary, 'caffeinate'), '#!/bin/sh\nexit 0\n')
  if (process.platform !== 'win32') chmodSync(join(withBinary, 'caffeinate'), 0o755)
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('caffeinatePrefix', () => {
  test('[A] en macOS con caffeinate en el PATH devuelve el prefijo', () => {
    assert.deepEqual(caffeinatePrefix({ PATH: withBinary }, 'darwin'), ['caffeinate', '-i'])
  })

  test('[A] sin caffeinate en el PATH devuelve una lista vacia', () => {
    assert.deepEqual(caffeinatePrefix({ PATH: withoutBinary }, 'darwin'), [])
    assert.deepEqual(caffeinatePrefix({ PATH: '' }, 'darwin'), [])
    assert.deepEqual(caffeinatePrefix({}, 'darwin'), [])
  })

  test('fuera de macOS devuelve una lista vacia aunque exista un caffeinate', () => {
    assert.deepEqual(caffeinatePrefix({ PATH: withBinary }, 'linux'), [])
    assert.deepEqual(caffeinatePrefix({ PATH: withBinary }, 'win32'), [])
  })

  test('coincide con caffeinate_prefix de la libreria bash', { skip: NO_BASH }, () => {
    for (const path of [withBinary, withoutBinary, '']) {
      const fromBash = bashLibrary('PATH="$1"; caffeinate_prefix', [path])
      assert.equal(caffeinatePrefix({ PATH: path }, 'darwin').join(' '), fromBash.stdout, path)
    }
  })
})
