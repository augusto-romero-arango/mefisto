import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CommandResult } from '../lib/cli.mts'
import { DEFAULT_LABELS, setupGithubLabels } from '../setup-github-labels.mts'
import {
  CANONICAL_CONFIG,
  LEGACY_CONFIG,
  PLUGIN_MANIFEST,
  configJson,
  initRepo,
  sink,
} from './consumer-sandbox.mts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup-github-labels.mts')
const OK: CommandResult = { status: 0, stdout: '', stderr: '' }

let work = ''
let consumer = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto labels '))
  consumer = initRepo(join(work, 'consumidor'), { [CANONICAL_CONFIG]: configJson() })
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

interface Run {
  status: number
  out: string[]
  err: string[]
  /** Argumentos de cada invocacion de gh. */
  calls: string[][]
}

function run(cwd: string, gh: (args: string[]) => CommandResult = () => OK): Run {
  const output = sink()
  const calls: string[][] = []
  const status = setupGithubLabels({
    cwd,
    run: (command, args) => {
      assert.equal(command, 'gh')
      calls.push(args)
      return gh(args)
    },
    ...output.io,
  })
  return { status, out: output.out, err: output.err, calls }
}

function created(calls: string[][]): string[] {
  return calls.filter((args) => args[1] === 'create').map((args) => args[2] ?? '')
}

test('borra los ocho labels default, crea el esquema en orden y lista el resultado', () => {
  const result = run(consumer, (args) => {
    if (args[1] === 'delete')
      return args[2] === 'question' ? OK : { status: 1, stdout: '', stderr: 'no existe' }
    if (args[1] === 'list') return { status: 0, stdout: 'bug\tdesc\t#D93F0B\n', stderr: '' }
    return OK
  })
  assert.equal(result.status, 0)
  assert.deepEqual(result.err, [])
  assert.deepEqual(
    result.calls.filter((args) => args[1] === 'delete'),
    DEFAULT_LABELS.map((label) => ['label', 'delete', label, '--yes']),
  )
  assert.deepEqual(created(result.calls), [
    'tipo:feature',
    'tipo:infra',
    'tipo:refactor',
    'tipo:tooling',
    'tipo:projection',
    'bug',
    'dom:ventas',
    'dom:cobros',
    'estado:borrador',
    'estado:listo',
    'bloqueado',
    'warning',
  ])
  assert.deepEqual(
    result.calls.find((args) => args[2] === 'dom:ventas'),
    ['label', 'create', 'dom:ventas', '--color', '0E8A16', '--description', 'Dominio ventas', '--force'],
  )
  assert.deepEqual(result.calls.at(-1), ['label', 'list'])
  assert.deepEqual(result.out, [
    'Eliminando labels default de GitHub...',
    '  - no encontrado (ok): documentation',
    '  - no encontrado (ok): duplicate',
    '  - no encontrado (ok): enhancement',
    '  - no encontrado (ok): good first issue',
    '  - no encontrado (ok): help wanted',
    '  - no encontrado (ok): invalid',
    '  - eliminado: question',
    '  - no encontrado (ok): wontfix',
    '',
    'Creando labels de tipo (azul)...',
    '',
    'Creando labels de origen (naranja)...',
    '',
    'Creando labels de dominio (verde) desde harness.config.json...',
    '',
    'Creando labels de estado (amarillo/rojo)...',
    '',
    'Creando labels especiales...',
    '',
    'Listo. Labels actuales:',
    'bug\tdesc\t#D93F0B',
  ])
})

test('un gh label create que falla detiene el script con su codigo de salida', () => {
  const result = run(consumer, (args) =>
    args[2] === 'tipo:refactor' ? { status: 4, stdout: '', stderr: 'boom\n' } : OK,
  )
  assert.equal(result.status, 4)
  assert.deepEqual(result.err, ['boom'])
  assert.deepEqual(created(result.calls), ['tipo:feature', 'tipo:infra', 'tipo:refactor'])
  assert.equal(result.out.at(-1), 'Creando labels de tipo (azul)...')
})

test('el codigo de salida es el de gh label list', () => {
  assert.equal(run(consumer, (args) => (args[1] === 'list' ? { ...OK, status: 3 } : OK)).status, 3)
})

test('sin gh en el PATH termina en 127 al primer create', () => {
  const result = run(consumer, () => ({ status: null, stdout: '', stderr: '' }))
  assert.equal(result.status, 127)
  assert.deepEqual(result.err, ['gh: command not found'])
  assert.equal(created(result.calls).length, 1)
})

test('sin config aborta nombrando el canonico y sin invocar gh', () => {
  const empty = initRepo(join(work, 'sin config'))
  const result = run(empty)
  assert.equal(result.status, 1)
  assert.match(result.err.join('\n'), /^ERROR: no se encontro el config canonico requerido /)
  assert.deepEqual(result.calls, [])
})

test('con los dos configs avisa por stderr y usa el canonico', () => {
  const both = initRepo(join(work, 'ambos'), {
    [CANONICAL_CONFIG]: configJson({ domainLabels: ['ventas', 'cobros', 'solo-canonico'] }),
    [LEGACY_CONFIG]: configJson(),
  })
  const result = run(both)
  assert.equal(result.status, 0)
  assert.equal(result.err.length, 1)
  assert.match(result.err[0] ?? '', /^AVISO: se usara el config canonico /)
  assert.ok(created(result.calls).includes('dom:solo-canonico'))
})

test('en el repo de Mefisto se niega sin invocar gh', () => {
  const mefisto = initRepo(join(work, 'mefisto'), {
    [PLUGIN_MANIFEST]: '{}',
    [CANONICAL_CONFIG]: configJson(),
  })
  const result = run(mefisto)
  assert.equal(result.status, 1)
  assert.deepEqual(result.err, [
    [
      'ERROR: scripts/setup-github-labels.mts es del plugin publicado y solo aplica al consumidor.',
      'Los labels de Mefisto se configuran manualmente o con un script interno.',
    ].join('\n'),
  ])
  assert.deepEqual(result.calls, [])
})

test('no presenta .claude/harness.config.json como el contrato canonico', () => {
  const unqualified = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => line.includes('.claude/harness.config.json') && !/legacy|fallback/i.test(line))
  assert.deepEqual(unqualified, [])
})
