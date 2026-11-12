import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../../../scripts/lib/cli.mts'
import { forwardDependencies, hasDependenciesSection } from '../../../scripts/lib/issue-dependencies.mts'
import type { Outcome } from '../../../scripts/lib/next-order.mts'
import { fakeGh, fakeGhOnPath, issue } from '../../../scripts/tests/next-order-fake-gh.mts'
import type { GhFixtures } from '../../../scripts/tests/next-order-fake-gh.mts'
import { mefistoNextOrder } from '../../../src/internal/scripts/mefisto-next-order.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const INTERNAL = join(REPO_ROOT, 'src', 'internal', 'scripts')
const SCRIPT = join(INTERNAL, 'mefisto-next-order.mts')
const SHIM = join(INTERNAL, 'mefisto-next-order.sh')
const USAGE = 'Uso: src/internal/scripts/mefisto-next-order.sh [--refinement] [--json]'
const NO_BLOCKS = 'Sin ciclos ni bloqueos externos.'
const NONE = '## Dependencias\n\nNinguna.'

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto next-order interno '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function run(fixtures: GhFixtures, ...argv: string[]): Outcome {
  return mefistoNextOrder(argv, fakeGh(fixtures).gh)
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

describe('orden de lanzamiento', () => {
  test('A: cadena lineal, con la justificacion en cada linea', () => {
    const outcome = run({
      issues: [issue(401, 'Base', NONE), issue(402, 'Medio', depends(401)), issue(403, 'Tope', depends(402))],
    })
    assert.equal(outcome.status, 0)
    assert.deepEqual(outcome.warnings, [])
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #401 Base -- sin dependencias abiertas',
        '2. #402 Medio -- tras #401',
        '3. #403 Tope -- tras #402',
        '/mefisto-sequential 401 402 403',
      ),
    )
  })

  test('B: diamante, la junta lista sus dos dependencias en orden ascendente', () => {
    const outcome = run({
      issues: [
        issue(410, 'Base', NONE),
        issue(411, 'RamaA', depends(410)),
        issue(412, 'RamaB', depends(410)),
        issue(413, 'Junta', depends(411, 412)),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #410 Base -- sin dependencias abiertas',
        '2. #411 RamaA -- tras #410',
        '3. #412 RamaB -- tras #410',
        '4. #413 Junta -- tras #411, #412',
        '/mefisto-sequential 410 411 412 413',
      ),
    )
  })

  test('C: ciclo de dos, excluido del orden y exit 1', () => {
    const outcome = run({ issues: [issue(420, 'A', depends(421)), issue(421, 'B', depends(420))] })
    assert.equal(outcome.status, 1)
    assert.equal(outcome.stdout, text('ciclo: #420 -> #421 -> #420', '', '/mefisto-sequential (sin issues lanzables)'))
  })

  test('D: ciclo de tres, con sus tres miembros', () => {
    const outcome = run({
      issues: [issue(430, 'A', depends(431)), issue(431, 'B', depends(432)), issue(432, 'C', depends(430))],
    })
    assert.equal(outcome.status, 1)
    assert.match(outcome.stdout, /^ciclo: #430 -> #431 -> #432 -> #430$/m)
  })

  test('E: bloqueo externo abierto, excluido del orden', () => {
    const outcome = run({ issues: [issue(440, 'Depende de externo', depends(900))], states: { 900: 'OPEN' } })
    assert.equal(outcome.status, 1)
    assert.equal(
      outcome.stdout,
      text(
        '#440 bloqueado por #900: fuera de estado:listo, estado OPEN',
        '',
        '/mefisto-sequential (sin issues lanzables)',
      ),
    )
  })

  test('F: una dependencia CLOSED no bloquea ni genera arista', () => {
    const outcome = run({ issues: [issue(450, 'Depende de cerrada', depends(901))], states: { 901: 'CLOSED' } })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(NO_BLOCKS, '', '1. #450 Depende de cerrada -- sin dependencias abiertas', '/mefisto-sequential 450'),
    )
  })

  test("G: 'Bloquea #N' es una referencia inversa y se ignora", () => {
    const outcome = run({ issues: [issue(460, 'Bloquea a otra', '## Dependencias\n\nBloquea #461')] })
    assert.equal(outcome.status, 0)
    assert.match(outcome.stdout, /^1\. #460 Bloquea a otra -- sin dependencias abiertas$/m)
  })

  test('H: el empate se resuelve por numero de issue ascendente', () => {
    const outcome = run({ issues: [issue(472, 'Segunda', NONE), issue(471, 'Primera', NONE)] })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #471 Primera -- sin dependencias abiertas',
        '2. #472 Segunda -- sin dependencias abiertas',
        '/mefisto-sequential 471 472',
      ),
    )
  })

  test('I: universo vacio, exit 1 con la linea de lanzamiento', () => {
    const outcome = run({ issues: [] })
    assert.equal(outcome.status, 1)
    assert.equal(outcome.stdout, text(NO_BLOCKS, '', '/mefisto-sequential (sin issues lanzables)'))
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
    const outcome = run({ issues: [issue(480, 'Depende de un PR mergeado', depends(902))], prStates: { 902: 'MERGED' } })
    assert.equal(outcome.status, 0)
    assert.match(outcome.stdout, /^1\. #480 Depende de un PR mergeado -- sin dependencias abiertas$/m)
  })

  test('L: quien depende de un bloqueado no se cuela al orden y se reporta', () => {
    const outcome = run({
      issues: [
        issue(504, 'Sana', NONE),
        issue(505, 'Bloqueada por externo', depends(999)),
        issue(506, 'Depende de la bloqueada', depends(505)),
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
        '1. #504 Sana -- sin dependencias abiertas',
        '/mefisto-sequential 504',
      ),
    )
  })

  test('M: quien depende de un ciclo se reporta y no figura como miembro', () => {
    const outcome = run({
      issues: [
        issue(511, 'CicloA', depends(512)),
        issue(512, 'CicloB', depends(511)),
        issue(513, 'Detras del ciclo', depends(511)),
        issue(514, 'Sana', NONE),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        'ciclo: #511 -> #512 -> #511',
        '#513 bloqueado por #511: excluido del orden',
        '',
        '1. #514 Sana -- sin dependencias abiertas',
        '/mefisto-sequential 514',
      ),
    )
  })

  test('N: la cabecera no arranca con una linea en blanco', () => {
    const outcome = run({ issues: [issue(521, 'Bloqueada', depends(998))], states: { 998: 'OPEN' } })
    assert.notEqual(outcome.stdout.split('\n')[0], '')
  })

  test("R: 'No depende de #M' no es dependencia ni genera un ciclo falso", () => {
    const outcome = run({
      issues: [
        issue(501, 'Neg', '## Dependencias\n\n- No depende de #502'),
        issue(502, 'Dep', '## Dependencias\n\n- Depende de #501'),
      ],
    })
    assert.equal(outcome.status, 0)
    assert.doesNotMatch(outcome.stdout, /ciclo: /i)
    assert.match(outcome.stdout, /^\/mefisto-sequential 501 502$/m)
  })
})

describe('--refinement', () => {
  test('O: el universo son los borradores y el que depende de otro va despues', () => {
    const outcome = run(
      {
        issues: [
          issue(601, 'Base borrador', NONE),
          issue(602, 'Sobre la base', depends(601)),
          issue(603, 'Idea suelta', '## Idea\n\nAlgo.'),
        ],
        listo: [],
      },
      '--refinement',
    )
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #603 Idea suelta -- sin dependencias abiertas',
        '2. #601 Base borrador -- sin dependencias abiertas',
        '3. #602 Sobre la base -- tras #601',
        'Siguiente a refinar: #603',
      ),
    )
  })

  test('O: entre los disponibles gana el mayor numero, sin romper la dependencia', () => {
    const outcome = run(
      {
        issues: [issue(10, 'Antiguo', NONE), issue(20, 'Medio', NONE), issue(30, 'Reciente tras 10', depends(10))],
        listo: [],
      },
      '--refinement',
    )
    assert.deepEqual(outcome.stdout.match(/^\d+\. #\d+/gm), ['1. #20', '2. #10', '3. #30'])
    assert.equal(outcome.stdout.trimEnd().split('\n').at(-1), 'Siguiente a refinar: #20')
  })

  test('P: una dependencia listo abierta esta satisfecha; una abierta sin estado bloquea', () => {
    const gh = fakeGh({
      issues: [issue(611, 'Tras un listo', depends(950)), issue(612, 'Tras algo abierto', depends(951))],
      listo: [{ number: 950 }],
      states: { 951: 'OPEN' },
    })
    const outcome = mefistoNextOrder(['--refinement'], gh.gh)
    assert.equal(outcome.status, 0)
    assert.equal(
      outcome.stdout,
      text(
        '#612 bloqueado por #951: fuera de estado:borrador, estado OPEN',
        '',
        '1. #611 Tras un listo -- sin dependencias abiertas',
        'Siguiente a refinar: #611',
      ),
    )
    assert.deepEqual(
      gh.calls.filter((args) => args[1] === 'list').map((args) => [args[3], args.at(-1)]),
      [
        ['estado:borrador', 'number,title,body'],
        ['estado:listo', 'number'],
      ],
    )
  })
})

describe('--json', () => {
  const fixtures: GhFixtures = {
    issues: [
      issue(621, 'Base', NONE),
      issue(622, 'Tras base', depends(621)),
      issue(623, 'Bloqueado', depends(952)),
      issue(624, 'Ciclo A', depends(625)),
      issue(625, 'Ciclo B', depends(624)),
      issue(626, 'Sin seccion', 'Texto'),
    ],
    states: { 952: 'OPEN' },
  }

  test('Q: objeto completo con items, blocked, cycles y launch', () => {
    const outcome = run(fixtures, '--json')
    assert.equal(outcome.status, 0)
    assert.deepEqual(json(outcome), {
      mode: 'launch',
      items: [
        { position: 1, number: 621, hasDepsSection: true, after: [], title: 'Base' },
        { position: 2, number: 622, hasDepsSection: true, after: [621], title: 'Tras base' },
        { position: 3, number: 626, hasDepsSection: false, after: [], title: 'Sin seccion' },
      ],
      blocked: [{ number: 623, by: 952, reason: 'external' }],
      inPr: [],
      cycles: [[624, 625]],
      launch: '/mefisto-sequential 621 622 626',
    })
  })

  test('Q: conserva el orden de claves y el formato indentado que imprimia jq', () => {
    const outcome = run(fixtures, '--json')
    const parsed = json(outcome)
    assert.equal(outcome.stdout, `${JSON.stringify(parsed, null, 2)}\n`)
    assert.deepEqual(Object.keys(parsed), ['mode', 'items', 'blocked', 'inPr', 'cycles', 'launch'])
    assert.deepEqual(Object.keys(parsed.items[0]), ['position', 'number', 'hasDepsSection', 'after', 'title'])
  })

  test('Q: universo vacio termina en 1 con items vacios y launch null', () => {
    const outcome = run({ issues: [] }, '--json', '--refinement')
    assert.equal(outcome.status, 1)
    assert.deepEqual(json(outcome), { mode: 'refinement', items: [], blocked: [], inPr: [], cycles: [], launch: null })
  })
})

describe('lectura de dependencias', () => {
  const body = [
    '## Dependencias',
    '',
    '- Depende de #10 (igual que en #11)',
    '* Bloqueado por #12',
    'Depende de #13',
    '- No depende de #20',
    '- Ya no depende de #21',
    'Esta prosa Depende de #22 a mitad de linea',
  ].join('\n')

  test('S: el marcador solo cuenta al inicio del item', () => {
    assert.deepEqual(forwardDependencies(body), ['10', '12', '13'])
  })

  test('S: corta en el siguiente encabezado de segundo nivel, no repite y acepta CRLF', () => {
    const cases: [string, string[], boolean][] = [
      ['## Dependencias\n- Depende de #99\n- Depende de #100\n- Depende de #99\n## Otra\n- Depende de #5', ['100', '99'], true],
      ['## Dependencias\r\n\t -  DEPENDE DE   #7\r\n### Sub\r\n* bloqueado por #8\r\n', ['7', '8'], true],
      ['## Idea\n\n- Depende de #1', [], false],
      ['', [], false],
    ]
    for (const [candidate, dependencies, section] of cases) {
      assert.deepEqual(forwardDependencies(candidate), dependencies, candidate)
      assert.equal(hasDependenciesSection(candidate), section, candidate)
    }
  })
})

describe('issues con PR abierto', () => {
  const issues = [
    issue(601, 'A', ''),
    issue(602, 'B', '## Dependencias\n- Depende de #601'),
    issue(603, 'C', '## Dependencias\n- Depende de #602'),
    issue(604, 'D', ''),
    issue(605, 'E', ''),
    issue(606, 'F', ''),
  ]
  const fixtures: GhFixtures = {
    issues,
    prs: [
      { number: 900, headRefName: 'otra', closingIssuesReferences: [{ number: 601 }] },
      { number: 899, headRefName: 'worktree-mefisto-issue-601-x', closingIssuesReferences: [] },
      { number: 901, headRefName: 'worktree-mefisto-issue-605-y', closingIssuesReferences: [] },
    ],
  }

  test('U: en PR por closing o por rama sale de items y de launch; gana el PR menor', () => {
    const parsed = json(run(fixtures, '--json'))
    assert.deepEqual(
      parsed.items.map((item: Json) => item.number),
      [604, 606],
    )
    assert.equal(parsed.launch, '/mefisto-sequential 604 606')
    assert.deepEqual(parsed.inPr, [
      { number: 601, title: 'A', pr: 899 },
      { number: 605, title: 'E', pr: 901 },
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

  test('U: las ramas del pipeline publicado no delatan un issue de Mefisto', () => {
    const parsed = json(
      run({ issues: [issue(611, 'A', '')], prs: [{ number: 5, headRefName: 'worktree-issue-611-x' }] }, '--json'),
    )
    assert.deepEqual(parsed.inPr, [])
  })

  test('U: con todo en PR termina en 1', () => {
    const outcome = run({
      issues: [issue(611, 'A', '')],
      prs: [{ number: 950, headRefName: 'worktree-mefisto-issue-611-x', closingIssuesReferences: [] }],
    })
    assert.equal(outcome.status, 1)
    assert.equal(outcome.stdout, text('#611 en PR #950: pendiente de merge', '', '/mefisto-sequential (sin issues lanzables)'))
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
    const gh = fakeGh({ issues: [issue(621, 'Borr', '')], listo: [], prListFails: true })
    const outcome = mefistoNextOrder(['--refinement', '--json'], gh.gh)
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

describe('linea de comando', () => {
  test('mefisto-next-order.sh es el shim hacia mefisto-next-order.mts y conserva el bit de ejecucion', () => {
    assert.equal(
      readFileSync(SHIM, 'utf8'),
      text(
        '#!/usr/bin/env bash',
        '# Shim: la implementacion vive en mefisto-next-order.mts (MEF-ADR-0057). No editar.',
        'exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/mefisto-next-order.mts" "$@"',
      ),
    )
    if (process.platform !== 'win32') accessSync(SHIM, constants.X_OK)
  })

  test('imprime el orden en stdout, los avisos en stderr y sale con el codigo del resultado', { skip: process.platform === 'win32' }, () => {
    const bin = mkdtempSync(join(work, 'bin '))
    const fixtures: GhFixtures = {
      issues: [issue(401, 'Base', NONE), issue(402, 'Medio', depends(401))],
      prListFails: true,
    }
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: work,
      encoding: 'utf8',
      env: fakeGhOnPath(bin, fixtures),
    })
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      text(
        NO_BLOCKS,
        '',
        '1. #401 Base -- sin dependencias abiertas',
        '2. #402 Medio -- tras #401',
        '/mefisto-sequential 401 402',
      ),
    )
    assert.equal(
      result.stderr,
      text('ADVERTENCIA: no se pudo consultar PRs abiertos; el orden no excluye issues en PR'),
    )

    const empty = spawnSync(process.execPath, [SCRIPT, '--json'], {
      cwd: work,
      encoding: 'utf8',
      env: fakeGhOnPath(bin, { issues: [] }),
    })
    assert.equal(empty.status, 1)
    assert.equal((JSON.parse(empty.stdout) as Json).launch, null)
  })

  test('un argumento desconocido sale con 2 y el uso en stderr', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--json', '--launch-command'], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, text('ERROR: argumento desconocido: --launch-command.', USAGE))
  })
})
