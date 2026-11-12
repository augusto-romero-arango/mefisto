// Piezas comunes de los orquestadores con cola (`scripts/lib/pipeline/orchestrator.mts`).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  childCommand,
  exitStatus,
  firstPullRequestUrl,
  launchChild,
  lineCount,
  missingCommandsLine,
  numberOrText,
  padBytes,
  runTeed,
  runtimeClosureError,
  writeAtomic,
} from '../lib/pipeline/orchestrator.mts'
import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto orquestador ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

describe('formato', () => {
  test('padBytes rellena por bytes, como el printf de bash', () => {
    assert.equal(padBytes('Issue', 10), 'Issue     ')
    assert.equal(padBytes('Duración', 10), 'Duración ', 'la o con tilde ocupa dos bytes')
    assert.equal(padBytes('demasiado largo', 4), 'demasiado largo')
  })

  test('firstPullRequestUrl toma la primera URL de PR sin cruzar lineas', () => {
    const output = 'Stage 2\nPR creado: https://github.com/acme/x/pull/42\n  PR:      https://github.com/acme/x/pull/43\n'
    assert.equal(firstPullRequestUrl(output), 'https://github.com/acme/x/pull/42')
    assert.equal(firstPullRequestUrl('https://github.com/acme\n/x/pull/1'), '')
    assert.equal(firstPullRequestUrl('sin PR'), '')
  })

  test('numberOrText es el tonumber? // . de jq', () => {
    assert.equal(numberOrText('1011'), 1011)
    assert.equal(numberOrText('011'), 11)
    assert.equal(numberOrText('12abc'), '12abc')
  })

  test('lineCount cuenta saltos de linea como wc -l', () => {
    const file = join(work, 'lineas.log')
    writeFileSync(file, 'a\nb\nsin salto')
    assert.equal(lineCount(file), 2)
    assert.equal(lineCount(join(work, 'no-existe.log')), 0)
  })

  test('writeAtomic reescribe el archivo entero y no falla si no puede', () => {
    const file = join(work, 'estado.json')
    writeAtomic(file, '{"a":1}\n')
    writeAtomic(file, '{"a":2}\n')
    assert.equal(readFileSync(file, 'utf8'), '{"a":2}\n')
    assert.doesNotThrow(() => writeAtomic(join(work, 'no', 'existe', 'estado.json'), '{}'))
  })

  test('missingCommandsLine lista los faltantes con el formato del bash', () => {
    assert.equal(missingCommandsLine(['gh', 'git'], () => true), null)
    assert.equal(stripAnsi(missingCommandsLine(['gh', 'git', 'dotnet'], (command) => command === 'git') ?? ''), '✗ Dependencias faltantes: gh dotnet\n')
  })

  test('exitStatus reporta 128 mas la senal, como wait', () => {
    assert.equal(exitStatus(3, null), 3)
    assert.equal(exitStatus(null, 'SIGTERM'), 143)
    assert.equal(exitStatus(null, 'SIGINT'), 130)
  })
})

describe('clausura y pipelines hijos', () => {
  test('runtimeClosureError exige src/runtime con mefisto-runtime.mts junto a scripts/', () => {
    const root = mkdtempSync(join(work, 'paquete-'))
    const scripts = join(root, 'scripts')
    mkdirSync(scripts)
    assert.equal(runtimeClosureError(scripts), 'ERROR: no se encontro src/runtime junto al paquete publicado\n')
    mkdirSync(join(root, 'src', 'runtime', 'lib'), { recursive: true })
    assert.equal(runtimeClosureError(scripts), 'ERROR: no se encontro mefisto-runtime.mts en la clausura publicada\n')
    writeFileSync(join(root, 'src', 'runtime', 'lib', 'mefisto-runtime.mts'), '')
    assert.equal(runtimeClosureError(scripts), null)
  })

  test('childCommand prefiere el .mts junto al .sh y si no lanza el .sh', () => {
    const dir = mkdtempSync(join(work, 'hijos-'))
    writeFileSync(join(dir, 'tooling-pipeline.mts'), '')
    assert.deepEqual(childCommand(join(dir, 'tooling-pipeline.sh')), { command: process.execPath, args: [join(dir, 'tooling-pipeline.mts')] })
    assert.deepEqual(childCommand(join(dir, 'tdd-pipeline.sh')), { command: join(dir, 'tdd-pipeline.sh'), args: [] })
  })

  test('runTeed copia la salida de los dos canales a pantalla y al log, y devuelve el codigo', async () => {
    const dir = mkdtempSync(join(work, 'tee-'))
    writeFileSync(join(dir, 'hijo.mts'), "process.stdout.write('salida\\n'); process.stderr.write('error\\n'); process.exitCode = 4\n")
    const log = join(dir, 'issue.log')
    writeFileSync(log, 'previo\n')
    let shown = ''
    const code = await runTeed(join(dir, 'hijo.sh'), [], log, {
      cwd: dir,
      env: process.env,
      onOutput: (text) => {
        shown += text
      },
    })
    assert.equal(code, 4)
    assert.deepEqual(shown.split('\n').sort(), ['', 'error', 'salida'])
    assert.equal(readFileSync(log, 'utf8').startsWith('previo\n'), true, 'anexa como tee -a')
  })

  test('launchChild sigue vivo hasta que el hijo termina y un hijo que no arranca da 127', async () => {
    const dir = mkdtempSync(join(work, 'vivo-'))
    writeFileSync(join(dir, 'hijo.mts'), 'setTimeout(() => {}, 150)\n')
    const run = launchChild(join(dir, 'hijo.sh'), [], { cwd: dir, env: process.env, stdio: 'ignore' })
    assert.equal(run.alive(), true)
    assert.equal(await run.done, 0)
    assert.equal(run.alive(), false)

    let failure = ''
    const missing = launchChild(join(dir, 'no-existe.sh'), [], {
      cwd: dir,
      env: process.env,
      stdio: 'ignore',
      onLaunchError: (message) => {
        failure = message
      },
    })
    assert.equal(await missing.done, 127)
    assert.match(failure, /no-existe\.sh: /)
  })
})
