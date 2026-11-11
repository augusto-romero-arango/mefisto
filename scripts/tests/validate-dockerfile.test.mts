import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { USAGE, validateDockerfile } from '../validate-dockerfile.mts'
import { PLUGIN_MANIFEST, initRepo, pathIn, sink, writeIn } from './consumer-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'validate-dockerfile.mts')
const DIST = join(REPO_ROOT, 'dist', 'claude', 'scripts')
const LOG = '.mefisto/pipeline/logs/projections-docker-build.log'
const NO_LINKS = process.platform === 'win32'

let work = ''
let consumer = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto dockerfile '))
  consumer = initRepo(join(work, 'consumidor'), {
    'src/App/Dockerfile': 'FROM scratch\n',
    'infra/Dockerfile': 'FROM scratch\n',
    Dockerfile: 'FROM scratch\n',
  })
  writeIn(work, 'fuera/Dockerfile', 'FROM scratch\n')
  if (!NO_LINKS) {
    symlinkSync(join(work, 'fuera'), pathIn(consumer, 'src/Escape'))
    symlinkSync(pathIn(work, 'fuera/Dockerfile'), pathIn(consumer, 'src/App/Enlace.Dockerfile'))
  }
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

interface Docker {
  /** `false`: docker no esta en el PATH. */
  installed?: boolean
  daemon?: boolean
  buildStatus?: number
  buildOutput?: string
}

interface Run {
  status: number
  out: string[]
  err: string[]
  /** Argumentos de cada invocacion de docker. */
  calls: string[][]
}

function run(argv: string[], docker: Docker = {}, cwd = consumer): Run {
  const output = sink()
  const calls: string[][] = []
  const status = validateDockerfile(argv, {
    cwd,
    hasCommand: (command) => command === 'docker' && docker.installed !== false,
    run: (command, args) => {
      assert.equal(command, 'docker')
      calls.push(args)
      return { status: docker.daemon === false ? 1 : 0, stdout: '', stderr: '' }
    },
    runToLog: (command, args, log) => {
      assert.equal(command, 'docker')
      calls.push(args)
      writeFileSync(log, docker.buildOutput ?? 'build-output\n')
      return docker.buildStatus ?? 0
    },
    ...output.io,
  })
  return { status, out: output.out, err: output.err, calls }
}

describe('ruta del Dockerfile', () => {
  const rejected: [string, string][] = [
    ['/abs/Dockerfile', 'ERROR: la ruta debe ser relativa al repo, no absoluta: /abs/Dockerfile'],
    ['src/../Dockerfile', "ERROR: la ruta no admite segmentos '..', '.' ni vacios: src/../Dockerfile"],
    ['infra/Dockerfile', 'ERROR: la ruta debe estar bajo src/: infra/Dockerfile'],
    [
      'src/App/../../x/Dockerfile',
      "ERROR: la ruta no admite segmentos '..', '.' ni vacios: src/App/../../x/Dockerfile",
    ],
    ['Dockerfile', 'ERROR: la ruta debe estar bajo src/: Dockerfile'],
    ['src/./App/Dockerfile', "ERROR: la ruta no admite segmentos '..', '.' ni vacios: src/./App/Dockerfile"],
    ['src//App/Dockerfile', "ERROR: la ruta no admite segmentos '..', '.' ni vacios: src//App/Dockerfile"],
    ['src/App/NoExiste', 'ERROR: no existe el Dockerfile: src/App/NoExiste'],
    ['src/App', 'ERROR: no existe el Dockerfile: src/App'],
    ['src/App/Dockerfile/x', 'ERROR: no existe el Dockerfile: src/App/Dockerfile/x'],
  ]

  for (const [path, message] of rejected) {
    test(`rechaza '${path}' sin invocar docker`, () => {
      const result = run([path])
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [message])
      assert.deepEqual(result.out, [])
      assert.deepEqual(result.calls, [])
    })
  }

  for (const path of ['src/Escape/Dockerfile', 'src/App/Enlace.Dockerfile']) {
    test(`rechaza '${path}', que sale de src/ por un enlace, sin invocar docker`, { skip: NO_LINKS }, () => {
      const result = run([path])
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [`ERROR: el Dockerfile resuelto queda fuera de src/ del repo: ${path}`])
      assert.deepEqual(result.calls, [])
    })
  }

  test('sin argumento, con uno vacio o con dos imprime el uso', () => {
    for (const argv of [[], [''], ['src/App/Dockerfile', 'otro']]) {
      const result = run(argv)
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [USAGE])
      assert.deepEqual(result.calls, [])
    }
  })
})

describe('docker', () => {
  test('una ruta valida corre solo docker info y docker build -f <ruta>, y deja el log bajo .mefisto', () => {
    rmSync(pathIn(consumer, LOG), { force: true })
    const result = run(['src/App/Dockerfile'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.err, [])
    assert.deepEqual(result.calls, [
      ['info'],
      ['build', '-f', 'src/App/Dockerfile', '-t', 'projections-worker-check', consumer],
    ])
    assert.equal(readFileSync(pathIn(consumer, LOG), 'utf8'), 'build-output\n')
    assert.deepEqual(result.out, ['docker build exit=0', 'build-output'])
  })

  test('un build fallido se reporta con su codigo y el script sale 0', () => {
    const result = run(['src/App/Dockerfile'], { buildStatus: 3 })
    assert.equal(result.status, 0)
    assert.equal(result.out[0], 'docker build exit=3')
  })

  test('imprime solo las ultimas veinte lineas del log', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `linea ${index + 1}`)
    const result = run(['src/App/Dockerfile'], { buildOutput: `${lines.join('\n')}\n` })
    assert.deepEqual(result.out, ['docker build exit=0', ...lines.slice(10)])
  })

  test('sin daemon o sin docker sale 0 avisando que queda pendiente, sin build', () => {
    for (const docker of [{ daemon: false }, { installed: false }]) {
      const result = run(['src/App/Dockerfile'], docker)
      assert.equal(result.status, 0)
      assert.deepEqual(result.out, ['docker no disponible: validacion del Dockerfile pendiente manual'])
      assert.deepEqual(result.calls, docker.installed === false ? [] : [['info']])
    }
  })
})

describe('guard de consumidor', () => {
  test('en el repo de Mefisto se niega antes de mirar los argumentos', () => {
    const mefisto = initRepo(join(work, 'mefisto'), { [PLUGIN_MANIFEST]: '{}' })
    for (const argv of [['src/x/Dockerfile'], []]) {
      const result = run(argv, {}, mefisto)
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [
        'ERROR: scripts/validate-dockerfile.sh es del plugin publicado y solo aplica al consumidor.',
      ])
      assert.deepEqual(result.calls, [])
    }
  })
})

describe('linea de comando', () => {
  function cli(script: string, argv: string[]) {
    return spawnSync(process.execPath, [script, ...argv], { cwd: consumer, encoding: 'utf8' })
  }

  test('el shim conserva el bit de ejecucion', { skip: process.platform === 'win32' }, () => {
    assert.notEqual(statSync(join(HERE, '..', 'validate-dockerfile.sh')).mode & 0o111, 0)
  })

  test('una ruta invalida termina en 1 con el mensaje por stderr', () => {
    const result = cli(SCRIPT, ['infra/Dockerfile'])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'ERROR: la ruta debe estar bajo src/: infra/Dockerfile\n')
  })

  test('la copia distribuida es identica y resuelve sus modulos', () => {
    for (const name of ['validate-dockerfile.sh', 'validate-dockerfile.mts']) {
      assert.ok(existsSync(join(DIST, name)), `falta dist/claude/scripts/${name}`)
      assert.deepEqual(readFileSync(join(DIST, name)), readFileSync(join(HERE, '..', name)), name)
    }
    const result = cli(join(DIST, 'validate-dockerfile.mts'), ['infra/Dockerfile'])
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: la ruta debe estar bajo src/: infra/Dockerfile\n')
  })
})
