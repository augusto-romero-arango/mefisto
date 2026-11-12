import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import type { Gh } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import {
  closedIssues,
  positionInBatch,
  run,
} from '../../../src/internal/scripts/mefisto-validate-batch-deps.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-validate-batch-deps.mts')
const COMMANDS_DIR = join(REPO_ROOT, '.claude', 'commands')
const POSIX = process.platform !== 'win32'

interface Fixtures {
  labels: Record<string, string>
  body: Record<string, string>
  state: Record<string, string>
  prState: Record<string, string>
  prBody: Record<string, string>
  blocked: string[]
}

let fixtures: Fixtures
/** Cada `gh issue edit` recibido: lo que permite afirmar que un batch abortado no muta labels. */
let edits: string[]

function ok(stdout: string): CommandResult {
  return { status: 0, stdout: `${stdout}\n`, stderr: '' }
}

const FAILED: CommandResult = { status: 1, stdout: '', stderr: '' }

function jsonField(args: string[]): string {
  return args[args.indexOf('--json') + 1] ?? ''
}

const gh: Gh = (args) => {
  const [resource, action, number = ''] = args
  if (resource === 'issue' && action === 'view') {
    const field = jsonField(args)
    if (field === 'labels') return ok(fixtures.labels[number] ?? '')
    if (field === 'body') return ok(fixtures.body[number] ?? '')
    const state = fixtures.state[number]
    return field === 'state' && state !== undefined ? ok(state) : FAILED
  }
  if (resource === 'pr' && action === 'view') {
    const field = jsonField(args)
    const value = field === 'state' ? fixtures.prState[number] : field === 'body' ? fixtures.prBody[number] : undefined
    return value === undefined ? FAILED : ok(value)
  }
  if (resource === 'issue' && action === 'list') {
    return { status: 0, stdout: fixtures.blocked.map((issue) => `${issue}\n`).join(''), stderr: '' }
  }
  if (resource === 'issue' && action === 'edit') {
    edits.push(args.join(' '))
    fixtures.blocked = fixtures.blocked.filter((issue) => issue !== number)
    return { status: 0, stdout: '', stderr: '' }
  }
  return FAILED
}

interface Outcome {
  status: number
  stdout: string
  stderr: string
}

function invoke(...args: string[]): Outcome {
  const output = new Output()
  const status = run(args, gh, output)
  return { status, stdout: output.stdout, stderr: output.stderr }
}

function dependsOn(...lines: string[]): string {
  return ['## Dependencias', '', ...lines].join('\n')
}

function removedLabel(issue: string): boolean {
  return edits.includes(`issue edit ${issue} --remove-label bloqueado`)
}

beforeEach(() => {
  fixtures = { labels: {}, body: {}, state: {}, prState: {}, prBody: {}, blocked: [] }
  edits = []
})

describe('[pre] guarda de invocacion', () => {
  test('sin argumentos sale con 2 y avisa de que no valido nada', () => {
    assert.throws(
      () => invoke(),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 2 &&
        error.message ===
          [
            'ERROR: se invoco sin issues. No se valido NADA (no interpretes esto como OK).',
            'Uso: src/internal/scripts/mefisto-validate-batch-deps.mts <issue1> <issue2> ...',
          ].join('\n'),
    )
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^ERROR: se invoco sin issues\./)
  })

})

describe('[H] reconciliacion post-merge de los labels bloqueado', () => {
  test('H-1: varios Closes canonicos desbloquean un issue con todas sus dependencias cerradas', () => {
    fixtures.prState['900'] = 'MERGED'
    fixtures.prBody['900'] = 'closes #100\nClOsEs #101'
    fixtures.blocked = ['200']
    fixtures.body['200'] = '## Dependencias\nDepende de #100\nBloqueado por #101'
    fixtures.state['100'] = 'CLOSED'
    fixtures.state['101'] = 'CLOSED'
    const result = invoke('--reconcile-pr', '900')
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      "Quitado 'bloqueado' de #200: todas sus dependencias forward están CLOSED/MERGED.\n",
    )
    assert.ok(removedLabel('200'))
  })

  test('H-2: otra dependencia abierta conserva el label con diagnostico', () => {
    fixtures.prState['901'] = 'MERGED'
    fixtures.prBody['901'] = 'Closes #110'
    fixtures.blocked = ['201']
    fixtures.body['201'] = '## Dependencias\nDepende de #110\nDepende de #111'
    fixtures.state['110'] = 'CLOSED'
    fixtures.state['111'] = 'OPEN'
    const result = invoke('--reconcile-pr', '901')
    assert.equal(result.status, 0)
    assert.equal(result.stderr, 'Issue #201 sigue bloqueado: la dependencia #111 está OPEN.\n')
    assert.deepEqual(edits, [])
  })

  test('H-3: una dependencia que es un PR MERGED desbloquea', () => {
    fixtures.prState['902'] = 'MERGED'
    fixtures.prBody['902'] = 'Closes #120'
    fixtures.blocked = ['202']
    fixtures.body['202'] = '## Dependencias\nBloqueado por #120'
    fixtures.prState['120'] = 'MERGED'
    assert.equal(invoke('--reconcile-pr', '902').status, 0)
    assert.ok(removedLabel('202'))
  })

  test('H-4: una referencia inversa o no canonica no desbloquea y emite un warning', () => {
    fixtures.prState['903'] = 'MERGED'
    fixtures.prBody['903'] = 'Closes #130'
    fixtures.blocked = ['203']
    fixtures.body['203'] = '## Dependencias\nBloquea #130\nDepende del write-side: #130'
    const result = invoke('--reconcile-pr', '903')
    assert.equal(result.status, 0)
    assert.equal(
      result.stderr,
      "WARNING: issue #203 referencia el issue recién cerrado #130 en '## Dependencias' sin redacción canónica parseable ('Depende de #N' / 'Bloqueado por #N'); no se pudo evaluar su desbloqueo automático.\n",
    )
    assert.deepEqual(edits, [])
  })

  test('H-4: un numero que solo contiene al cerrado no es una referencia', () => {
    fixtures.prState['903'] = 'MERGED'
    fixtures.prBody['903'] = 'Closes #13'
    fixtures.blocked = ['203']
    fixtures.body['203'] = '## Dependencias\nBloquea #130'
    const result = invoke('--reconcile-pr', '903')
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
  })

  test('H-5: un PR sin mergear falla sin mutar', () => {
    fixtures.prState['904'] = 'CLOSED'
    const result = invoke('--reconcile-pr', '904')
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: el PR #904 no está MERGED (estado: CLOSED). La reconciliación solo corre después del merge.\n',
    )
    assert.deepEqual(edits, [])
  })

  test('H-5: un argumento de PR invalido o de mas falla con el uso y sale con 2', () => {
    for (const args of [['abc'], ['904', 'extra'], []]) {
      assert.throws(
        () => invoke('--reconcile-pr', ...args),
        (error: unknown) =>
          error instanceof CliError &&
          error.exitCode === 2 &&
          error.message ===
            'ERROR: uso: src/internal/scripts/mefisto-validate-batch-deps.mts --reconcile-pr <pr>',
      )
    }
    assert.deepEqual(edits, [])
  })

  test('H-5: un PR inexistente falla con un diagnostico accionable', () => {
    const result = invoke('--reconcile-pr', '999')
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: no se pudo consultar el PR #999. Verifica que exista y que gh tenga acceso.\n',
    )
    assert.deepEqual(edits, [])
  })

  test('H-6: un body sin Closes termina bien sin hacer nada', () => {
    fixtures.prState['905'] = 'MERGED'
    fixtures.prBody['905'] = 'Sin cierre automático.'
    const result = invoke('--reconcile-pr', '905')
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "PR #905 no declara cierres 'Closes #N'; no hay nada que reconciliar.\n")
  })

  test('H-7: un fallo de API conserva el label y falla con diagnostico', () => {
    fixtures.prState['906'] = 'MERGED'
    fixtures.prBody['906'] = 'Closes #140'
    fixtures.blocked = ['204']
    fixtures.body['204'] = '## Dependencias\nDepende de #140'
    const result = invoke('--reconcile-pr', '906')
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      "ERROR: issue #204 conserva 'bloqueado': no se pudo determinar el estado de la dependencia #140.\n",
    )
    assert.deepEqual(edits, [])
  })

  test('H-8: repetir la invocacion es idempotente', () => {
    fixtures.prState['907'] = 'MERGED'
    fixtures.prBody['907'] = 'Closes #150'
    fixtures.blocked = ['205']
    fixtures.body['205'] = '## Dependencias\nDepende de #150'
    fixtures.state['150'] = 'CLOSED'
    assert.equal(invoke('--reconcile-pr', '907').status, 0)
    assert.equal(invoke('--reconcile-pr', '907').status, 0)
    assert.deepEqual(edits, ['issue edit 205 --remove-label bloqueado'])
  })

  test('un issue bloqueado que no depende del cerrado no se toca', () => {
    fixtures.prState['908'] = 'MERGED'
    fixtures.prBody['908'] = 'Closes #160'
    fixtures.blocked = ['206', '207']
    fixtures.body['206'] = '## Dependencias\nDepende de #161'
    fixtures.body['207'] = '## Dependencias\nDepende de #160'
    fixtures.state['160'] = 'CLOSED'
    fixtures.state['161'] = 'CLOSED'
    assert.equal(invoke('--reconcile-pr', '908').status, 0)
    assert.deepEqual(edits, ['issue edit 207 --remove-label bloqueado'])
  })

  test('closedIssues lee cada Closes, tambien varios por linea, sin cruzar de linea', () => {
    assert.deepEqual(closedIssues('closes #100\nClOsEs  #9 y Closes\t#100, closes\n#55\nCloses#7'), ['100', '9'])
    assert.deepEqual(closedIssues('Sin cierre'), [])
  })
})

describe('[A] posicion en el batch', () => {
  test('calcula la posicion de cada uno de los tres issues', () => {
    const batch = ['44', '43', '45']
    assert.equal(positionInBatch(batch, '44'), 1)
    assert.equal(positionInBatch(batch, '43'), 2)
    assert.equal(positionInBatch(batch, '45'), 3)
    assert.equal(positionInBatch(batch, '46'), 0)
  })
})

describe('[B] ejemplos canonicos', () => {
  test("B-1: '44 43 45' lanza y quita el label de los que lo llevaban", () => {
    fixtures.labels['43'] = 'bloqueado'
    fixtures.labels['45'] = 'bloqueado'
    fixtures.body['43'] = dependsOn('Depende de #44')
    fixtures.body['45'] = dependsOn('Depende de #44')
    const result = invoke('44', '43', '45')
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      [
        "Quitado 'bloqueado' de #43: sus dependencias abiertas se resuelven por el",
        'orden del batch + sync verificado (#46); las cerradas ya estan satisfechas.',
        "Quitado 'bloqueado' de #45: sus dependencias abiertas se resuelven por el",
        'orden del batch + sync verificado (#46); las cerradas ya estan satisfechas.',
        'Validacion 1.5 OK: el batch se puede lanzar.',
        '',
      ].join('\n'),
    )
    assert.deepEqual(edits, ['issue edit 43 --remove-label bloqueado', 'issue edit 45 --remove-label bloqueado'])
  })

  test("B-2: '43 44' aborta y sugiere el reordenamiento concreto", () => {
    fixtures.labels['43'] = 'bloqueado'
    fixtures.body['43'] = dependsOn('Depende de #44')
    const result = invoke('43', '44')
    assert.equal(result.status, 1)
    assert.equal(
      result.stdout,
      [
        'ABORTAR el batch. Bloqueos reales detectados:',
        '',
        '#43 no se puede lanzar:',
        '  - #44 esta en el batch pero DESPUES de #43 (mal ordenada). Mueve #44 antes de #43.',
        '',
        'Reordena el batch (dependencias antes que sus dependientes) o cierra las',
        'dependencias externas antes de relanzar.',
        '',
      ].join('\n'),
    )
    assert.deepEqual(edits, [])
  })

  test("B-3: '43' solo aborta por un bloqueo real fuera del batch", () => {
    fixtures.labels['43'] = 'bloqueado'
    fixtures.body['43'] = dependsOn('Depende de #44')
    fixtures.state['44'] = 'OPEN'
    const result = invoke('43')
    assert.equal(result.status, 1)
    assert.ok(result.stdout.includes('  - #44 esta fuera del batch y no esta CLOSED/MERGED (bloqueo real).'))
    assert.deepEqual(edits, [])
  })

  test('un batch que aborta no quita el label de ningun issue, tampoco de los que si pasan', () => {
    fixtures.labels['43'] = 'bloqueado'
    fixtures.labels['45'] = 'bloqueado'
    fixtures.body['43'] = dependsOn('Depende de #44')
    fixtures.body['45'] = dependsOn('Depende de #99')
    const result = invoke('44', '43', '45')
    assert.equal(result.status, 1)
    assert.deepEqual(edits, [])
  })

  test('un argumento con varios issues se parte por espacios', () => {
    fixtures.body['43'] = dependsOn('Depende de #44')
    assert.equal(invoke('44 43').status, 0)
    assert.equal(invoke('43 44').status, 1)
  })
})

describe('dependencias ya satisfechas o que no cuentan', () => {
  test('[C] una dependencia CLOSED fuera del batch no bloquea', () => {
    fixtures.labels['50'] = 'bloqueado'
    fixtures.body['50'] = dependsOn('Depende de #51')
    fixtures.state['51'] = 'CLOSED'
    assert.equal(invoke('50').status, 0)
    assert.ok(removedLabel('50'))
  })

  test('[D] una dependencia que es un PR MERGED no bloquea', () => {
    fixtures.labels['90'] = 'bloqueado'
    fixtures.body['90'] = dependsOn('Depende de #80')
    fixtures.prState['80'] = 'MERGED'
    assert.equal(invoke('90').status, 0)
    assert.ok(removedLabel('90'))
  })

  test("[E] 'Bloquea #N' es una referencia inversa y se ignora", () => {
    fixtures.labels['60'] = 'bloqueado'
    fixtures.body['60'] = dependsOn('Bloquea #61')
    assert.equal(invoke('60').status, 0)
    assert.ok(removedLabel('60'))
  })

  test('[E2] una negacion no bloquea el batch', () => {
    fixtures.labels['64'] = 'bloqueado'
    fixtures.state['65'] = 'OPEN'
    fixtures.body['64'] = dependsOn('- No depende de #65', '- Ya no depende de #65')
    assert.equal(invoke('64').status, 0)
  })

  test('una dependencia sobre si mismo se ignora', () => {
    fixtures.body['70'] = dependsOn('Depende de #70')
    assert.equal(invoke('70').status, 0)
  })

  test('el label bloqueado se reconoce entre otros labels y no por parecido', () => {
    fixtures.labels['71'] = 'tipo:tooling,bloqueado,estado:listo'
    fixtures.labels['72'] = 'no-bloqueado,bloqueado-por-revision'
    assert.equal(invoke('71', '72').status, 0)
    assert.deepEqual(edits, ['issue edit 71 --remove-label bloqueado'])
  })
})

describe("[F] el label 'bloqueado' no filtra la entrada al analisis", () => {
  test('F-1: sin el label, una dependencia abierta fuera del batch aborta igual', () => {
    fixtures.body['70'] = dependsOn('Depende de #71')
    fixtures.state['71'] = 'OPEN'
    const result = invoke('70')
    assert.equal(result.status, 1)
    assert.ok(result.stdout.includes('fuera del batch'))
    assert.deepEqual(edits, [])
  })

  test('F-2: sin el label, una dependencia que el orden resuelve lanza y se informa', () => {
    fixtures.body['72'] = dependsOn('Depende de #73')
    const result = invoke('73', '72')
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      [
        "Dependencias resueltas por el orden del batch (issues sin label 'bloqueado'):",
        '',
        "#72: dependencias abiertas #73 satisfechas por el orden del batch (no tenia label 'bloqueado' que quitar).",
        'Validacion 1.5 OK: el batch se puede lanzar.',
        '',
      ].join('\n'),
    )
    assert.deepEqual(edits, [])
  })

  test("F-3: el paso 1 de mefisto-sequential sigue excluyendo los issues sin 'estado:listo'", () => {
    const lines = readFileSync(join(COMMANDS_DIR, 'mefisto-sequential.md'), 'utf8').split('\n')
    const start = lines.findIndex((line) => /^### 1\. /.test(line))
    const end = lines.findIndex((line) => /^### 1\.5\./.test(line))
    assert.ok(start !== -1 && end > start, 'no se pudo extraer el paso 1')
    assert.ok(lines.slice(start + 1, end).join('\n').includes('estado:listo'))
  })
})

describe('[G] sin sintaxis posicional de shell en los bloques bash de los comandos', () => {
  // El runtime expande los $N del archivo del comando antes de que el agente lo lea.
  const POSITIONAL = [/\$[1-9]/, /\$\{[0-9]+\}/, /\$\*/, /\$@/, /\$#/]

  function positionalLeaks(markdown: string): string[] {
    const leaks: string[] = []
    let inBash = false
    for (const [index, line] of markdown.split('\n').entries()) {
      if (line.startsWith('```bash')) inBash = true
      else if (line.startsWith('```')) inBash = false
      else if (inBash && POSITIONAL.some((pattern) => pattern.test(line))) leaks.push(`${index + 1}: ${line}`)
    }
    return leaks
  }

  test('ningun comando interno generado la contiene', () => {
    const commands = readdirSync(COMMANDS_DIR).filter((name) => name.endsWith('.md'))
    assert.ok(commands.length > 0)
    for (const name of commands) {
      assert.deepEqual(positionalLeaks(readFileSync(join(COMMANDS_DIR, name), 'utf8')), [], name)
    }
  })

  test('el guard detecta un $1 escrito a mano', () => {
    assert.deepEqual(positionalLeaks('Prosa.\n\n```bash\necho "$1"\n```\n'), ['4: echo "$1"'])
    assert.equal(positionalLeaks('```bash\nshift; f "$@"; echo "$#" "${2}" "$*"\n```\n').length, 1)
  })

  test('el guard no marca $ARGUMENTS, ${#ARRAY[@]} ni lo que queda fuera de un bloque bash', () => {
    assert.deepEqual(positionalLeaks('```bash\necho "$ARGUMENTS"\necho "${#SEC_NAMES[@]}"\n```\n'), [])
    assert.deepEqual(positionalLeaks('Usa $1.\n\n```text\n$1\n```\n'), [])
  })
})

describe('[H-9] la reconciliacion como proceso', { skip: !POSIX }, () => {
  let work = ''

  // `gh` de Node, invocable sin shell: responde solo lo que pide la reconciliacion del PR 908.
  const GH_STUB = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
const key = args.slice(0, 3).join(' ') + ' ' + (args[args.indexOf('--json') + 1] ?? '')
const answers = {
  'pr view 908 state': 'MERGED',
  'pr view 908 body': 'Closes #160',
  'issue list --state number': '206',
  'issue view 206 body': '## Dependencias\\nDepende de #160',
  'issue view 160 state': 'CLOSED',
}
if (args[0] === 'issue' && args[1] === 'edit') {
  appendFileSync(process.env.GH_CALLS, args.join(' ') + '\\n')
} else if (key in answers) {
  console.log(answers[key])
} else {
  process.exit(1)
}
`

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'mefisto-validate-'))
    writeFileSync(join(work, 'gh'), GH_STUB)
    chmodSync(join(work, 'gh'), 0o755)
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  test('la reconciliacion corre de punta a punta como proceso', () => {
    const calls = join(work, 'gh-calls.log')
    const result = spawnSync(process.execPath, [SCRIPT, '--reconcile-pr', '908'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${work}${delimiter}${process.env.PATH ?? ''}`, GH_CALLS: calls },
    })
    assert.equal(result.stderr, '')
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      "Quitado 'bloqueado' de #206: todas sus dependencias forward están CLOSED/MERGED.\n",
    )
    assert.equal(readFileSync(calls, 'utf8'), 'issue edit 206 --remove-label bloqueado\n')
  })
})
