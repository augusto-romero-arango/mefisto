import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../lib/cli.mts'
import type { Outcome } from '../lib/next-order.mts'
import { nextOrder, parseArgs, tipoOf } from '../next-order.mts'
import { fakeGh, fakeGhOnPath, issue } from './next-order-fake-gh.mts'
import type { GhFixtures } from './next-order-fake-gh.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'next-order.mts')
const USAGE =
  'Uso: scripts/next-order.mts [--refinement] [--json] [--launch-command "<texto>"] [--parallel-command "<texto>"]'
const NO_BLOCKS = 'Sin ciclos ni bloqueos externos.'
const NONE = '## Dependencias\n\nNinguna.'

let work = ''
let consumer = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto next-order '))
  consumer = join(work, 'consumidor con espacios')
  mkdirSync(consumer)
  execFileSync('git', ['init', '--quiet', consumer])
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function run(fixtures: GhFixtures, ...argv: string[]): Outcome {
  return nextOrder(argv, { gh: fakeGh(fixtures).gh, cwd: consumer })
}

function failure(fixtures: GhFixtures, ...argv: string[]): CliError {
  try {
    run(fixtures, ...argv)
  } catch (error) {
    assert.ok(error instanceof CliError)
    return error
  }
  assert.fail('se esperaba un CliError')
}

function text(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

type Json = Record<string, any>

function json(outcome: Outcome): Json {
  return JSON.parse(outcome.stdout) as Json
}

function depends(...numbers: number[]): string {
  return `## Dependencias\n\n${numbers.map((n) => `Depende de #${n}`).join('\n')}`
}

describe('guard del consumidor', () => {
  test('en el repo de Mefisto aborta con exit 1 y el mensaje del guard', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(
      result.stderr,
      text(
        'ERROR: scripts/next-order.mts es del plugin publicado y solo aplica al consumidor.',
        'Estas en el repo de Mefisto. Usa src/internal/scripts/mefisto-next-order.mts en su lugar.',
      ),
    )
  })

  test('el guard va antes que la validacion de argumentos', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--nunca-existio'], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })

  test('fuera de un repo git aborta con exit 1', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mefisto sin repo '))
    try {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(outside) },
      })
      assert.equal(result.status, 1)
      assert.equal(result.stderr, text('ERROR: no estas en un repositorio git'))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('en un repo sin el manifiesto del plugin no aborta por el guard', () => {
    const outcome = run({ issues: [] })
    assert.equal(outcome.status, 1)
    assert.doesNotMatch(outcome.stdout, /plugin publicado/)
  })
})

describe('orden de lanzamiento', () => {
  test('A: cadena lineal, con el label tipo: y la justificacion en cada linea', () => {
    const outcome = run({
      issues: [
        issue(401, 'Base', NONE, 'tipo:feature'),
        issue(402, 'Medio', depends(401), 'tipo:tooling'),
        issue(403, 'Tope', depends(402), 'tipo:refactor'),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.deepEqual(outcome.warnings, [])
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #401 [tipo:feature] Base -- sin dependencias abiertas',
        '2. #402 [tipo:tooling] Medio -- tras #401',
        '3. #403 [tipo:refactor] Tope -- tras #402',
        '/mefisto:sequential 401 402 403',
      ),
    )
  })

  test('B: diamante, la junta lista sus dos dependencias en orden ascendente', () => {
    const outcome = run({
      issues: [
        issue(410, 'Base', NONE, 'tipo:feature'),
        issue(411, 'RamaA', depends(410), 'tipo:feature'),
        issue(412, 'RamaB', depends(410), 'tipo:feature'),
        issue(413, 'Junta', depends(411, 412), 'tipo:feature'),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #410 [tipo:feature] Base -- sin dependencias abiertas',
        '2. #411 [tipo:feature] RamaA -- tras #410',
        '3. #412 [tipo:feature] RamaB -- tras #410',
        '4. #413 [tipo:feature] Junta -- tras #411, #412',
        '/mefisto:sequential 410 411 412 413',
      ),
    )
  })

  test("B2: 'No depende de #N' no es dependencia ni genera un ciclo falso", () => {
    const outcome = run({
      issues: [
        issue(430, 'Base', '## Dependencias\n\n- No depende de #431\n- Ya no depende de #431', 'tipo:feature'),
        issue(431, 'Tope', '## Dependencias\n\n- Depende de #430 (igual que en #999)', 'tipo:feature'),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #430 [tipo:feature] Base -- sin dependencias abiertas',
        '2. #431 [tipo:feature] Tope -- tras #430',
        '/mefisto:sequential 430 431',
      ),
    )
  })

  test("B3: la vineta '*' cuenta y el marcador a mitad de linea no", () => {
    const outcome = run({
      issues: [
        issue(440, 'Base', NONE, 'tipo:feature'),
        issue(441, 'Medio', '## Dependencias\n\n* Bloqueado por #440\nEsto no depende de #442 en absoluto.', 'tipo:feature'),
        issue(442, 'Tope', '## Dependencias\n\n- Depende de #441', 'tipo:feature'),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.doesNotMatch(outcome.stdout, /^ciclo:/m)
    assert.match(outcome.stdout, /^\/mefisto:sequential 440 441 442$/m)
  })

  test('C: ciclo de dos, excluido del orden y exit 1', () => {
    const outcome = run({
      issues: [issue(420, 'A', depends(421), 'tipo:feature'), issue(421, 'B', depends(420), 'tipo:feature')],
    })
    assert.equal(outcome.status, 1)
    assert.equal(outcome.stdout, text('ciclo: #420 -> #421 -> #420', '', '/mefisto:sequential (sin issues lanzables)'))
  })

  test('D: ciclo de tres, con sus tres miembros', () => {
    const outcome = run({
      issues: [
        issue(430, 'A', depends(431), 'tipo:feature'),
        issue(431, 'B', depends(432), 'tipo:feature'),
        issue(432, 'C', depends(430), 'tipo:feature'),
      ],
    })
    assert.equal(outcome.status, 1)
    assert.match(outcome.stdout, /^ciclo: #430 -> #431 -> #432 -> #430$/m)
  })

  test('E: bloqueo externo abierto, excluido del orden', () => {
    const outcome = run({
      issues: [issue(440, 'Depende de externo', depends(900), 'tipo:feature')],
      states: { 900: 'OPEN' },
    })
    assert.equal(outcome.status, 1)
    assert.equal(
      outcome.stdout,
      text(
        '#440 bloqueado por #900: fuera de estado:listo, estado OPEN',
        '',
        '/mefisto:sequential (sin issues lanzables)',
      ),
    )
  })

  test('F: una dependencia CLOSED no bloquea ni genera arista', () => {
    const outcome = run({
      issues: [issue(450, 'Depende de cerrada', depends(901), 'tipo:feature')],
      states: { 901: 'CLOSED' },
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(NO_BLOCKS, '', '1. #450 [tipo:feature] Depende de cerrada -- sin dependencias abiertas', '/mefisto:sequential 450'),
    )
  })

  test("G: 'Bloquea #N' es una referencia inversa y se ignora", () => {
    const outcome = run({ issues: [issue(460, 'Bloquea a otra', '## Dependencias\n\nBloquea #461', 'tipo:feature')] })
    assert.equal(outcome.status, 0)
    assert.match(outcome.stdout, /^1\. #460 \[tipo:feature\] Bloquea a otra -- sin dependencias abiertas$/m)
  })

  test('H: el empate se resuelve por numero de issue ascendente', () => {
    const outcome = run({
      issues: [issue(472, 'Segunda', NONE, 'tipo:feature'), issue(471, 'Primera', NONE, 'tipo:feature')],
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #471 [tipo:feature] Primera -- sin dependencias abiertas',
        '2. #472 [tipo:feature] Segunda -- sin dependencias abiertas',
        '/mefisto:sequential 471 472',
        '/mefisto:parallel 471 472',
      ),
    )
  })

  test('I: universo vacio, exit 1 con la linea de lanzamiento por defecto', () => {
    const outcome = run({ issues: [] })
    assert.equal(outcome.status, 1)
    assert.equal(outcome.stdout, text(NO_BLOCKS, '', '/mefisto:sequential (sin issues lanzables)'))
  })

  test("J: si 'gh issue list' falla termina en 2 sin imprimir ningun orden", () => {
    const error = failure({ down: true })
    assert.equal(error.exitCode, 2)
    assert.equal(error.message, "ERROR: fallo 'gh issue list --label estado:listo --state open'.")
  })

  test('K: un argumento desconocido termina en 2 con el uso', () => {
    const error = failure({ issues: [] }, '--nunca-existio')
    assert.equal(error.exitCode, 2)
    assert.equal(error.message, `ERROR: argumento desconocido: --nunca-existio.\n${USAGE}`)
  })

  test('K: una dependencia que es un PR MERGED no bloquea', () => {
    const outcome = run({
      issues: [issue(480, 'Depende de un PR mergeado', depends(902), 'tipo:feature')],
      prStates: { 902: 'MERGED' },
    })
    assert.equal(outcome.status, 0)
    assert.match(outcome.stdout, /^1\. #480 \[tipo:feature\] Depende de un PR mergeado -- sin dependencias abiertas$/m)
  })

  test('L: quien depende de un bloqueado no se cuela al orden y se reporta', () => {
    const outcome = run({
      issues: [
        issue(504, 'Sana', NONE, 'tipo:feature'),
        issue(505, 'Bloqueada por externo', depends(999), 'tipo:feature'),
        issue(506, 'Depende de la bloqueada', depends(505), 'tipo:feature'),
      ],
      states: { 999: 'OPEN' },
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        '#505 bloqueado por #999: fuera de estado:listo, estado OPEN',
        '#506 bloqueado por #505: excluido del orden',
        '',
        '1. #504 [tipo:feature] Sana -- sin dependencias abiertas',
        '/mefisto:sequential 504',
      ),
    )
  })

  test('M: quien depende de un ciclo se reporta y no figura como miembro', () => {
    const outcome = run({
      issues: [
        issue(511, 'CicloA', depends(512), 'tipo:feature'),
        issue(512, 'CicloB', depends(511), 'tipo:feature'),
        issue(513, 'Detras del ciclo', depends(511), 'tipo:feature'),
        issue(514, 'Sana', NONE, 'tipo:feature'),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        'ciclo: #511 -> #512 -> #511',
        '#513 bloqueado por #511: excluido del orden',
        '',
        '1. #514 [tipo:feature] Sana -- sin dependencias abiertas',
        '/mefisto:sequential 514',
      ),
    )
  })

  test('N: la cabecera no arranca con una linea en blanco', () => {
    const outcome = run({ issues: [issue(521, 'Bloqueada', depends(998), 'tipo:feature')], states: { 998: 'OPEN' } })
    assert.notEqual(outcome.stdout.split('\n')[0], '')
  })
})

describe('--launch-command', () => {
  const sola = (number: number): unknown => issue(number, 'Sola', NONE, 'tipo:feature')

  test('O: el texto personalizado va en la ultima linea, con y sin issues lanzables', () => {
    const withIssues = run({ issues: [sola(601)] }, '--launch-command', '/otro-runtime:sequential')
    assert.equal(withIssues.status, 0)
    assert.equal(withIssues.stdout.trimEnd().split('\n').at(-1), '/otro-runtime:sequential 601')

    const empty = run({ issues: [] }, '--launch-command', '/otro-runtime:sequential')
    assert.equal(empty.status, 1)
    assert.equal(empty.stdout.trimEnd().split('\n').at(-1), '/otro-runtime:sequential (sin issues lanzables)')
  })

  test("P: sin el flag cae al default '/mefisto:sequential'", () => {
    const outcome = run({ issues: [sola(602)] })
    assert.equal(outcome.status, 0)
    assert.equal(outcome.stdout.trimEnd().split('\n').at(-1), '/mefisto:sequential 602')
    assert.equal(parseArgs([]).launchCommand, '/mefisto:sequential')
    assert.equal(parseArgs([]).parallelCommand, '/mefisto:parallel')
  })

  test('Q: sin argumento o con texto vacio termina en 2', () => {
    const missing = failure({ issues: [] }, '--launch-command')
    assert.equal(missing.exitCode, 2)
    assert.equal(missing.message, `ERROR: --launch-command requiere un argumento.\n${USAGE}`)

    const empty = failure({ issues: [] }, '--launch-command', '')
    assert.equal(empty.exitCode, 2)
    assert.equal(
      empty.message,
      `ERROR: --launch-command no admite texto vacio (la ultima linea quedaria sin comando).\n${USAGE}`,
    )
  })
})

describe('--json', () => {
  const fixtures: GhFixtures = {
    issues: [
      issue(601, 'Base', '## Dependencias\nNinguna', 'tipo:feature', 'estado:listo'),
      issue(602, 'Sobre base', '## Dependencias\nDepende de #601', 'tipo:tooling'),
      issue(603, 'Sin tipo ni seccion', 'nada'),
      issue(604, 'Bloqueado', '## Dependencias\nDepende de #900'),
    ],
    states: { 900: 'OPEN' },
  }

  test('R: esquema completo, con tipo sin prefijo o null y launch por defecto', () => {
    const outcome = run(fixtures, '--json')
    assert.equal(outcome.status, 0)
    assert.deepEqual(json(outcome), {
      mode: 'launch',
      items: [
        { position: 1, number: 601, title: 'Base', tipo: 'feature', after: [], hasDepsSection: true },
        { position: 2, number: 602, title: 'Sobre base', tipo: 'tooling', after: [601], hasDepsSection: true },
        { position: 3, number: 603, title: 'Sin tipo ni seccion', tipo: null, after: [], hasDepsSection: false },
      ],
      blocked: [{ number: 604, by: 900, reason: 'external' }],
      inPr: [],
      cycles: [],
      launch: '/mefisto:sequential 601 602',
      infra: [],
      parallel: { issues: [601], launch: null },
    })
  })

  test('R: conserva el orden de claves y el formato indentado que imprimia jq', () => {
    const outcome = run(fixtures, '--json')
    const parsed = json(outcome)
    assert.equal(outcome.stdout, `${JSON.stringify(parsed, null, 2)}\n`)
    assert.deepEqual(Object.keys(parsed), ['mode', 'items', 'blocked', 'inPr', 'cycles', 'launch', 'infra', 'parallel'])
    assert.deepEqual(Object.keys(parsed.items[0]), ['position', 'number', 'title', 'tipo', 'after', 'hasDepsSection'])
    assert.match(outcome.stdout, /^\{\n  "mode": "launch",\n  "items": \[\n    \{\n      "position": 1,\n/)
  })

  test('R: launch respeta --launch-command', () => {
    assert.equal(json(run(fixtures, '--json', '--launch-command', '/otro:cmd')).launch, '/otro:cmd 601 602')
  })

  test('R: sin items termina en 1 con JSON valido, launch null y el ciclo reportado', () => {
    const outcome = run(
      {
        issues: [
          issue(611, 'A', '## Dependencias\nDepende de #612'),
          issue(612, 'B', '## Dependencias\nDepende de #611'),
        ],
      },
      '--json',
    )
    assert.equal(outcome.status, 1)
    const parsed = json(outcome)
    assert.deepEqual(parsed.items, [])
    assert.equal(parsed.launch, null)
    assert.deepEqual(parsed.cycles, [[611, 612]])
  })

  test('R: universo vacio termina en 1 con JSON valido', () => {
    const outcome = run({ issues: [] }, '--json')
    assert.equal(outcome.status, 1)
    assert.deepEqual(json(outcome), {
      mode: 'launch',
      items: [],
      blocked: [],
      inPr: [],
      cycles: [],
      launch: null,
      infra: [],
      parallel: { issues: [], launch: null },
    })
  })
})

describe('--refinement', () => {
  const fixtures: GhFixtures = {
    borrador: [
      issue(702, 'Depende de 705', '## Dependencias\nDepende de #705', 'tipo:feature'),
      issue(703, 'Depende de listo', '## Dependencias\nDepende de #800', 'tipo:tooling'),
      issue(705, 'Base', '## Dependencias\nNinguna'),
      issue(706, 'Depende de cerrado', '## Dependencias\nDepende de #801'),
    ],
    listo: [{ number: 800 }],
    states: { 801: 'CLOSED' },
  }

  test('S: el dependiente va despues; una dependencia listo o cerrada no bloquea', () => {
    const outcome = run(fixtures, '--refinement')
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #706 [tipo:desconocido] Depende de cerrado -- sin dependencias abiertas',
        '2. #705 [tipo:desconocido] Base -- sin dependencias abiertas',
        '3. #703 [tipo:tooling] Depende de listo -- sin dependencias abiertas',
        '4. #702 [tipo:feature] Depende de 705 -- tras #705',
        'Siguiente a refinar: #706',
      ),
    )
  })

  test('S: combinado con --json da mode refinement, launch null, tipo y after', () => {
    const outcome = run(fixtures, '--refinement', '--json')
    assert.equal(outcome.status, 0)
    const parsed = json(outcome)
    assert.equal(parsed.mode, 'refinement')
    assert.equal(parsed.launch, null)
    assert.deepEqual(
      parsed.items.map((item: Json) => item.number),
      [706, 705, 703, 702],
    )
    assert.equal(parsed.items[2].tipo, 'tooling')
    assert.equal(parsed.items[1].tipo, null)
    assert.deepEqual(parsed.items[3].after, [705])
  })

  test('S: sin borradores refinables termina en 1 con la linea explicita', () => {
    const outcome = run(
      { borrador: [issue(710, 'Bloq', '## Dependencias\nDepende de #901')], listo: [], states: { 901: 'OPEN' } },
      '--refinement',
    )
    assert.equal(outcome.status, 1)
    assert.equal(
      outcome.stdout,
      text(
        '#710 bloqueado por #901: fuera de estado:borrador, estado OPEN',
        '',
        'Siguiente a refinar: (sin borradores refinables)',
      ),
    )
  })

  test('S: entre los disponibles gana el mayor numero, sin romper la dependencia', () => {
    const recent: GhFixtures = {
      borrador: [
        issue(10, 'Antiguo', '## Dependencias\nNinguna'),
        issue(20, 'Medio', '## Dependencias\nNinguna'),
        issue(30, 'Reciente tras 10', '## Dependencias\nDepende de #10'),
      ],
      listo: [],
    }
    const outcome = run(recent, '--refinement')
    assert.deepEqual(outcome.stdout.match(/^\d+\. #\d+/gm), ['1. #20', '2. #10', '3. #30'])
    assert.equal(outcome.stdout.trimEnd().split('\n').at(-1), 'Siguiente a refinar: #20')
    assert.deepEqual(
      json(run(recent, '--refinement', '--json')).items.map((item: Json) => [item.position, item.number]),
      [
        [1, 20],
        [2, 10],
        [3, 30],
      ],
    )
  })

  test("S: si falla la consulta de los 'estado:listo' termina en 2", () => {
    const gh = fakeGh({ borrador: [] })
    const error = (() => {
      try {
        nextOrder(['--refinement'], {
          cwd: consumer,
          gh: (args) => (args.includes('estado:listo') ? { status: 1, stdout: '', stderr: '' } : gh.gh(args)),
        })
      } catch (thrown) {
        return thrown
      }
      return undefined
    })()
    assert.ok(error instanceof CliError)
    assert.equal(error.exitCode, 2)
    assert.equal(error.message, "ERROR: fallo 'gh issue list --label estado:listo --state open'.")
  })
})

describe('infra, sin tipo y lote paralelo', () => {
  const fixtures: GhFixtures = {
    issues: [
      issue(501, 'Infra', NONE, 'tipo:infra'),
      issue(502, 'Sin tipo', NONE),
      issue(503, 'Feat', NONE, 'tipo:feature'),
      issue(504, 'Proj A', NONE, 'tipo:projection'),
      issue(505, 'Proj B', NONE, 'tipo:projection'),
      issue(506, 'Dep abierta', depends(510), 'tipo:tooling'),
      issue(510, 'Base', NONE, 'tipo:tooling'),
      issue(511, 'Infra 2', NONE, 'tipo:infra'),
    ],
  }

  test('T: launch sin infra ni sin tipo, items intacto e infra en orden', () => {
    const outcome = run(fixtures, '--json', '--parallel-command', '/x:par')
    assert.equal(outcome.status, 0)
    const parsed = json(outcome)
    assert.equal(parsed.launch, '/mefisto:sequential 503 504 505 510 506')
    assert.deepEqual(parsed.infra, [501, 511])
    assert.deepEqual(
      parsed.items.map((item: Json) => item.number),
      [501, 502, 503, 504, 505, 510, 506, 511],
    )
  })

  test('T: el lote excluye al dependiente, la segunda projection, infra y sin tipo', () => {
    const parsed = json(run(fixtures, '--json', '--parallel-command', '/x:par'))
    assert.deepEqual(parsed.parallel, { issues: [503, 504, 510], launch: '/x:par 503 504 510' })
  })

  test('T: en texto la linea de infra va antes de sequential y la de parallel despues', () => {
    assert.deepEqual(run(fixtures).stdout.trimEnd().split('\n').slice(-3), [
      'Infra lanzable (desarrollala antes, sin exigirlo): /mefisto:infra #501 | /mefisto:infra #511',
      '/mefisto:sequential 503 504 505 510 506',
      '/mefisto:parallel 503 504 510',
    ])
  })

  test('T: con menos de dos en el lote, launch null y sin linea en texto', () => {
    const pair: GhFixtures = {
      issues: [issue(520, 'Solo', NONE, 'tipo:feature'), issue(521, 'Tras', depends(520), 'tipo:feature')],
    }
    const parsed = json(run(pair, '--json'))
    assert.deepEqual(parsed.parallel, { issues: [520], launch: null })
    assert.deepEqual(parsed.infra, [])
    assert.doesNotMatch(run(pair).stdout, /^\/mefisto:parallel/m)
  })

  test('T: solo infra no deja una linea de sequential copiable', () => {
    const onlyInfra: GhFixtures = { issues: [issue(540, 'Solo infra', NONE, 'tipo:infra')] }
    const outcome = run(onlyInfra)
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #540 [tipo:infra] Solo infra -- sin dependencias abiertas',
        'Infra lanzable (desarrollala antes, sin exigirlo): /mefisto:infra #540',
        'Sin issues para /mefisto:sequential: los lanzables son solo infra o sin tipo.',
      ),
    )
    const parsed = json(run(onlyInfra, '--json'))
    assert.equal(parsed.launch, null)
    assert.deepEqual(parsed.infra, [540])
  })

  test('T: --parallel-command vacio o sin argumento termina en 2', () => {
    const empty = failure({ issues: [] }, '--parallel-command', '')
    assert.equal(empty.exitCode, 2)
    assert.equal(
      empty.message,
      `ERROR: --parallel-command no admite texto vacio (la linea del lote quedaria sin comando).\n${USAGE}`,
    )
    const missing = failure({ issues: [] }, '--parallel-command')
    assert.equal(missing.exitCode, 2)
    assert.equal(missing.message, `ERROR: --parallel-command requiere un argumento.\n${USAGE}`)
  })

  test('T: --refinement no separa infra ni calcula lote', () => {
    const parsed = json(
      run(
        { borrador: [issue(530, 'Borr', '', 'tipo:infra'), issue(531, 'Borr2', '', 'tipo:feature')], listo: [] },
        '--refinement',
        '--json',
      ),
    )
    assert.deepEqual([parsed.infra, parsed.parallel, parsed.launch], [[], null, null])
    assert.deepEqual(
      parsed.items.map((item: Json) => item.number),
      [531, 530],
    )
  })

  test("un label 'tipo:' vacio cuenta como sin tipo", () => {
    assert.equal(tipoOf({ number: 1, title: '', body: '', labels: ['otro', 'tipo:'] }), null)
    assert.equal(tipoOf({ number: 1, title: '', body: '', labels: ['otro', 'tipo:bug', 'tipo:feature'] }), 'bug')
  })
})

describe('issues con PR abierto', () => {
  const issues = [
    issue(601, 'A', '', 'tipo:feature'),
    issue(602, 'B', '## Dependencias\n- Depende de #601', 'tipo:feature'),
    issue(603, 'C', '## Dependencias\n- Depende de #602', 'tipo:feature'),
    issue(604, 'D', '', 'tipo:feature'),
    issue(605, 'E', '', 'tipo:infra'),
    issue(606, 'F', '', 'tipo:feature'),
  ]
  const fixtures: GhFixtures = {
    issues,
    prs: [
      { number: 900, headRefName: 'otra', closingIssuesReferences: [{ number: 601 }] },
      { number: 899, headRefName: 'worktree-issue-601-x', closingIssuesReferences: [] },
      { number: 901, headRefName: 'infra-issue-605-y', closingIssuesReferences: [] },
    ],
  }

  test('U: en PR por closing o por rama sale de items, launch, parallel e infra; gana el PR menor', () => {
    const parsed = json(run(fixtures, '--json'))
    assert.deepEqual(
      parsed.items.map((item: Json) => item.number),
      [604, 606],
    )
    assert.deepEqual(parsed.infra, [])
    assert.deepEqual(parsed.parallel.issues, [604, 606])
    assert.equal(parsed.launch, '/mefisto:sequential 604 606')
    assert.deepEqual(parsed.inPr, [
      { number: 601, title: 'A', tipo: 'feature', pr: 899 },
      { number: 605, title: 'E', tipo: 'infra', pr: 901 },
    ])
  })

  test('U: el dependiente queda bloqueado con reason pr y el siguiente, indirecto', () => {
    assert.deepEqual(json(run(fixtures, '--json')).blocked, [
      { number: 602, by: 601, reason: 'pr', pr: 899 },
      { number: 603, by: 602, reason: 'indirect' },
    ])
  })

  test('U: el texto reporta el issue en PR y el bloqueo por PR', () => {
    assert.deepEqual(run(fixtures).stdout.split('\n').slice(0, 5), [
      '#601 en PR #899: pendiente de merge',
      '#605 en PR #901: pendiente de merge',
      '#602 bloqueado por #601: espera el merge del PR #899',
      '#603 bloqueado por #602: excluido del orden',
      '',
    ])
  })

  test('U: la rama de otro issue con el mismo prefijo numerico no cuenta', () => {
    const parsed = json(
      run({ issues: [issue(61, 'A', '', 'tipo:feature')], prs: [{ number: 5, headRefName: 'worktree-issue-611-x' }] }, '--json'),
    )
    assert.deepEqual(parsed.inPr, [])
  })

  test('U: con todo en PR termina en 1', () => {
    const outcome = run({
      issues: [issue(611, 'A', '', 'tipo:feature')],
      prs: [{ number: 950, headRefName: 'worktree-issue-611-x', closingIssuesReferences: [] }],
    })
    assert.equal(outcome.status, 1)
    assert.equal(
      outcome.stdout,
      text('#611 en PR #950: pendiente de merge', '', '/mefisto:sequential (sin issues lanzables)'),
    )
  })

  test("U: si 'gh pr list' falla avisa y calcula sin esa exclusion", () => {
    const outcome = run({ issues, prListFails: true }, '--json')
    assert.deepEqual(outcome.warnings, [
      'ADVERTENCIA: no se pudo consultar PRs abiertos; el orden no excluye issues en PR',
    ])
    const parsed = json(outcome)
    assert.deepEqual(
      parsed.items.map((item: Json) => item.number),
      [601, 602, 603, 604, 605, 606],
    )
    assert.deepEqual(parsed.inPr, [])
  })

  test('U: --refinement no consulta PRs', () => {
    const gh = fakeGh({ borrador: [issue(621, 'Borr', '', 'tipo:feature')], listo: [], prListFails: true })
    const outcome = nextOrder(['--refinement', '--json'], { gh: gh.gh, cwd: consumer })
    assert.deepEqual(outcome.warnings, [])
    const parsed = json(outcome)
    assert.deepEqual(
      parsed.items.map((item: Json) => item.number),
      [621],
    )
    assert.deepEqual(parsed.inPr, [])
    assert.equal(
      gh.calls.some((args) => args[0] === 'pr'),
      false,
    )
  })
})

describe('universo y consultas a gh', () => {
  test('pide los labels y avisa cuando el universo puede estar truncado', () => {
    const gh = fakeGh({ issues: Array.from({ length: 200 }, (_, i) => issue(1000 + i, `T${i}`, '', 'tipo:feature')) })
    const outcome = nextOrder(['--json'], { gh: gh.gh, cwd: consumer })
    assert.deepEqual(outcome.warnings, [
      "ADVERTENCIA: 'gh issue list' devolvio 200 issues (--limit 200):",
      'el universo puede estar truncado y el orden calculado sobre un grafo incompleto.',
    ])
    assert.deepEqual(gh.calls[0], [
      'issue',
      'list',
      '--label',
      'estado:listo',
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,body,labels',
    ])
    assert.equal(json(outcome).items.length, 200)
  })

  test('solo pregunta el estado de las dependencias de fuera del universo', () => {
    const gh = fakeGh({
      issues: [issue(1, 'a', '', 'tipo:feature'), issue(2, 'b', depends(1, 900), 'tipo:feature')],
      prStates: { 900: 'MERGED' },
    })
    nextOrder([], { gh: gh.gh, cwd: consumer })
    assert.deepEqual(
      gh.calls.filter((args) => args[1] === 'view'),
      [
        ['issue', 'view', '900', '--json', 'state', '-q', '.state'],
        ['pr', 'view', '900', '--json', 'state', '-q', '.state'],
      ],
    )
  })

  test('una dependencia de estado desconocido bloquea y se reporta como OPEN', () => {
    const outcome = run({ issues: [issue(2, 'b', depends(900), 'tipo:feature')] })
    assert.equal(outcome.status, 1)
    assert.match(outcome.stdout, /^#2 bloqueado por #900: fuera de estado:listo, estado OPEN$/m)
  })

  test('las dependencias se recorren en orden de texto, como sort -u', () => {
    const outcome = run({
      issues: [issue(5, 'a', depends(99, 100), 'tipo:feature')],
      states: { 99: 'OPEN', 100: 'OPEN' },
    })
    assert.deepEqual(outcome.stdout.split('\n').slice(0, 2), [
      '#5 bloqueado por #100: fuera de estado:listo, estado OPEN',
      '#5 bloqueado por #99: fuera de estado:listo, estado OPEN',
    ])
  })
})

describe('linea de comando', () => {
  test('imprime el orden en stdout, los avisos en stderr y sale con el codigo del resultado', { skip: process.platform === 'win32' }, () => {
    const bin = mkdtempSync(join(work, 'bin '))
    const fixtures: GhFixtures = {
      issues: [issue(401, 'Base', NONE, 'tipo:feature'), issue(402, 'Medio', depends(401), 'tipo:tooling')],
      prListFails: true,
    }
    const result = spawnSync(process.execPath, [SCRIPT, '--launch-command', '/otro:seq'], {
      cwd: consumer,
      encoding: 'utf8',
      env: fakeGhOnPath(bin, fixtures),
    })
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #401 [tipo:feature] Base -- sin dependencias abiertas',
        '2. #402 [tipo:tooling] Medio -- tras #401',
        '/otro:seq 401 402',
      ),
    )
    assert.equal(
      result.stderr,
      text('ADVERTENCIA: no se pudo consultar PRs abiertos; el orden no excluye issues en PR'),
    )

    const empty = spawnSync(process.execPath, [SCRIPT, '--json'], {
      cwd: consumer,
      encoding: 'utf8',
      env: fakeGhOnPath(bin, { issues: [] }),
    })
    assert.equal(empty.status, 1)
    assert.equal((JSON.parse(empty.stdout) as Json).launch, null)
  })

  test('un argumento invalido sale con 2 y el uso en stderr', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--launch-command'], { cwd: consumer, encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, text('ERROR: --launch-command requiere un argumento.', USAGE))
  })
})
