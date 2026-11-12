// Patrones `pgrep -f` con que los agentes y comandos detectan un pipeline vivo: el proceso vivo es
// `node .../x-pipeline.mts` (MEF-ADR-0057). Solo detectan; no matan nada.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

interface Detector {
  name: string
  /** Fuente neutral y su salida generada. */
  files: string[]
  pattern: string
  /** Ruta (relativa a una carpeta temporal) del pipeline vivo que debe detectar. */
  live: string
}

const DETECTORS: Detector[] = [
  {
    name: 'tooling-investigator',
    files: ['src/published/agents/tooling-investigator.md', 'agents/tooling-investigator.md'],
    pattern: '[s]cripts/[a-z]+-pipeline\\.mts',
    live: 'scripts/tooling-pipeline.mts',
  },
  {
    name: 'mefisto-investigator',
    files: ['src/internal/agents/mefisto-investigator.md', '.claude/agents/mefisto-investigator.md'],
    pattern: '[m]efisto-(tooling|batch)-pipeline\\.mts',
    live: 'src/internal/scripts/mefisto-tooling-pipeline.mts',
  },
  {
    name: 'mefisto-batch-stop',
    files: ['src/internal/commands/mefisto-batch-stop.md', '.claude/commands/mefisto-batch-stop.md'],
    pattern: '[m]efisto-batch-pipeline\\.mts',
    live: 'src/internal/scripts/mefisto-batch-pipeline.mts',
  },
]

describe('texto de los patrones', () => {
  for (const detector of DETECTORS) {
    test(`${detector.name}: fuente y salida generada traen el patron .mts`, () => {
      for (const file of detector.files) {
        const text = readFileSync(join(REPO_ROOT, file), 'utf8')
        assert.ok(text.includes(`"${detector.pattern}"`), `${file} no trae el patron ${detector.pattern}`)
      }
    })
  }
})

let work = ''
const children: ChildProcess[] = []

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto deteccion ')))
})

after(() => {
  // Solo los procesos que lanzo este test, por su PID.
  for (const child of children) child.kill()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function pgrepPids(pattern: string): string[] {
  return spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.length > 0)
}

const POSIX_WITH_PGREP = process.platform !== 'win32' && spawnSync('pgrep', ['-V']).error === undefined

describe('deteccion de un proceso real', { skip: !POSIX_WITH_PGREP }, () => {
  for (const detector of DETECTORS) {
    test(`${detector.name}: detecta node .../${detector.live}`, async () => {
      const path = join(work, detector.name, ...detector.live.split('/'))
      mkdirSync(join(path, '..'), { recursive: true })
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', path], { stdio: 'ignore' })
      children.push(child)
      await new Promise((ready) => child.once('spawn', ready))
      const pid = String(child.pid)
      assert.ok(pgrepPids(detector.pattern).includes(pid), 'el patron nuevo lo detecta')
      child.kill()
    })
  }
})
