// Merge con reintentos y desbloqueo de issues dependientes de `pr-sync`, con `gh` simulado.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { CommandResult } from '../lib/cli.mts'
import { createPipelineLog } from '../lib/pipeline/pipeline-log.mts'
import {
  closedIssueNumbers,
  dependencySectionLines,
  forwardDependencyNumbers,
  mergeFlag,
  mergePrWithRetry,
  referencesIssue,
  unblockDependentIssues,
} from '../lib/pipeline/pr-sync-github.mts'
import type { PrSyncGithubTools } from '../lib/pipeline/pr-sync-github.mts'

let work = ''
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto pr-sync github ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr })

interface Recorder {
  tools: PrSyncGithubTools
  calls: string[][]
  edits: string[]
  logs: string[]
  warns: string[]
  successes: string[]
  sleeps: number[]
  logFile: string
}

function recorder(gh: (args: string[]) => CommandResult): Recorder {
  counter++
  const logFile = join(work, `log-${counter}.txt`)
  const r: Recorder = { calls: [], edits: [], logs: [], warns: [], successes: [], sleeps: [], logFile, tools: undefined as unknown as PrSyncGithubTools }
  const log = createPipelineLog({ logFile: () => logFile, out: () => {} })
  r.tools = {
    run: (command, args) => {
      assert.equal(command, 'gh')
      r.calls.push(args)
      return gh(args)
    },
    runLogged: (command, args) => {
      assert.equal(command, 'gh')
      r.calls.push(args)
      r.edits.push(args[2] ?? '')
      return gh(args).status
    },
    options: {},
    log: { ...log, log: (m) => void r.logs.push(m), warn: (m) => void r.warns.push(m), success: (m) => void r.successes.push(m) },
    logFile,
    sleep: (seconds) => {
      r.sleeps.push(seconds)
      return Promise.resolve()
    },
  }
  return r
}

describe('metodo de merge', () => {
  test('prefiere merge, luego squash, luego rebase; sin ninguno cae a --merge', () => {
    assert.equal(mergeFlag('merge squash rebase'), '--merge')
    assert.equal(mergeFlag('squash rebase'), '--squash')
    assert.equal(mergeFlag('rebase'), '--rebase')
    assert.equal(mergeFlag(''), '--merge')
  })

  test('lo pregunta a la API del repo con el filtro de jq de siempre', async () => {
    const r = recorder((args) => (args[0] === 'api' ? done(0, 'rebase\n') : done(0, '{"state":"MERGED","mergeStateStatus":"UNKNOWN"}')))
    await mergePrWithRetry('123', r.tools)
    assert.deepEqual(r.calls[0], [
      'api',
      'repos/{owner}/{repo}',
      '--jq',
      '(if .allow_merge_commit then "merge " else "" end)\n            + (if .allow_squash_merge then "squash " else "" end)\n            + (if .allow_rebase_merge then "rebase" else "" end)',
    ])
    assert.deepEqual(r.logs, ['Método de merge permitido por el repo: rebase'])
  })
})

/** `gh` de un escenario de merge: estado inicial, resultado de `gh pr merge` y estado posterior. */
function mergeScenario(view: string, merge: CommandResult, stateAfter = 'OPEN'): (args: string[]) => CommandResult {
  return (args) => {
    if (args[0] === 'api') return done(0, 'merge \n')
    if (args[1] === 'merge') return merge
    if (args.includes('state,mergeStateStatus')) return done(0, view)
    if (args.includes('.state')) return done(0, `${stateAfter}\n`)
    return done(1)
  }
}

describe('merge con reintentos', () => {
  test('gh pr merge falla despues de mergear: cuenta como exito, sin reintentar, y avisa con su salida', async () => {
    const r = recorder(mergeScenario('{"state":"OPEN","mergeStateStatus":"CLEAN"}', done(1, '', 'failed to delete remote branch\n'), 'MERGED'))
    assert.equal(await mergePrWithRetry('123', r.tools), true)
    assert.deepEqual(r.sleeps, [])
    assert.deepEqual(r.warns, ['PR #123: el merge se completó, pero gh pr merge falló después: failed to delete remote branch'])
    assert.equal(readFileSync(r.logFile, 'utf8').endsWith('failed to delete remote branch\n'), true)
    assert.deepEqual(
      r.calls.find((args) => args[1] === 'merge'),
      ['pr', 'merge', '123', '--merge', '--delete-branch'],
    )
  })

  test('un rechazo no reintentable falla de inmediato con la causa', async () => {
    const r = recorder(mergeScenario('{"state":"OPEN","mergeStateStatus":"CLEAN"}', done(1, 'not mergeable\n')))
    assert.equal(await mergePrWithRetry('123', r.tools), false)
    assert.deepEqual(r.sleeps, [])
    assert.deepEqual(r.warns, ['PR #123: GitHub rechazó el merge y no es reintentable → not mergeable'])
  })

  test('un PR bloqueado se consulta cinco veces con esperas crecientes y nunca se intenta mergear', async () => {
    const r = recorder(mergeScenario('{"state":"OPEN","mergeStateStatus":"BLOCKED"}', done(0)))
    assert.equal(await mergePrWithRetry('123', r.tools), false)
    assert.deepEqual(r.sleeps, [3, 6, 12, 24])
    assert.equal(r.calls.some((args) => args[1] === 'merge'), false)
    assert.equal(r.logs[1], 'GitHub aún no reporta PR #123 como mergeable (estado: BLOCKED). Reintentando en 3s... (1/5)')
    assert.deepEqual(r.warns, ['PR #123 no fue mergeable después de 5 intentos (último estado: BLOCKED)'])
  })

  test('un PR ya mergeado no se vuelve a mergear', async () => {
    const r = recorder(mergeScenario('{"state":"MERGED","mergeStateStatus":"UNKNOWN"}', done(0)))
    assert.equal(await mergePrWithRetry('123', r.tools), true)
    assert.deepEqual(r.sleeps, [])
    assert.equal(r.calls.some((args) => args[1] === 'merge'), false)
  })

  test('un fallo reintentable informa la primera linea no vacia en cada reintento', async () => {
    const r = recorder(mergeScenario('{"state":"OPEN","mergeStateStatus":"CLEAN"}', done(1, '\n  \ntemporary failure\ndiagnostic detail\n')))
    assert.equal(await mergePrWithRetry('123', r.tools), false)
    assert.equal(r.logs.filter((line) => line.startsWith('gh pr merge falló: temporary failure. Reintentando en ')).length, 4)
    assert.equal(r.logs.some((line) => /aún no reporta.*estado: CLEAN/.test(line)), false)
    assert.deepEqual(r.warns, ['PR #123: gh pr merge falló tras 5 intentos: temporary failure'])
  })

  test('sin respuesta de gh el estado es UNKNOWN', async () => {
    const r = recorder((args) => (args[0] === 'api' ? done(1) : done(1, '', 'sin red\n')))
    assert.equal(await mergePrWithRetry('123', r.tools), false)
    assert.deepEqual(r.warns, ['PR #123 no fue mergeable después de 5 intentos (último estado: UNKNOWN)'])
    assert.deepEqual(r.logs[0], 'Método de merge permitido por el repo: merge')
  })
})

describe('lectura del body', () => {
  test('Closes #N sin distinguir mayusculas, en orden y con repeticiones', () => {
    assert.deepEqual(closedIssueNumbers('Closes #5\ncloses #7 y CLOSES #5\nRefs #9'), ['5', '7', '5'])
  })

  test('la seccion de dependencias exige el encabezado exacto y termina en el siguiente ##', () => {
    assert.deepEqual(dependencySectionLines('## Dependencias\n- Depende de #1\n## Otro\n- Depende de #2\n## Dependencias extra\n- x'), ['- Depende de #1', '- x'])
    assert.deepEqual(dependencySectionLines('## dependencias\n- Depende de #1'), [])
  })

  test('la referencia a un issue no acepta que la siga otro digito', () => {
    assert.equal(referencesIssue(['- Depende de #50'], '5'), false)
    assert.equal(referencesIssue(['- Depende de #5, y algo'], '5'), true)
    assert.equal(referencesIssue(['#5'], '5'), true)
  })

  test('solo cuentan Depende de / Bloqueado por al inicio del item, en orden de texto y sin repetir', () => {
    assert.deepEqual(
      forwardDependencyNumbers(['- Depende de #9', '* bloqueado por #10', 'No depende de #3', 'Algo: Depende de #4', '  Depende de #9', '- Bloquea a #11']),
      ['10', '9'],
    )
  })
})

/** `gh` de un escenario de desbloqueo. `open` lista los numeros que siguen abiertos; el resto responde `depState`. */
function unblockScenario(input: { body: string; blocked: object[] | null; depState?: string; open?: string[]; edit?: number }): (args: string[]) => CommandResult {
  return (args) => {
    const [noun, verb, number = ''] = args
    if (noun === 'pr' && verb === 'view' && args.includes('body')) return done(0, `${input.body}\n`)
    if (noun === 'issue' && verb === 'list') return input.blocked === null ? done(1) : done(0, `${JSON.stringify(input.blocked)}\n`)
    if (verb === 'view') return done(0, `${(input.open ?? []).includes(number) ? 'OPEN' : (input.depState ?? '')}\n`)
    if (noun === 'issue' && verb === 'edit') return done(input.edit ?? 0)
    return done(1)
  }
}

describe('desbloqueo de issues dependientes', () => {
  test('una referencia con redaccion no canonica no rompe nada: avisa y no desbloquea', () => {
    const r = recorder(
      unblockScenario({ body: 'Closes #500', blocked: [{ number: 501, title: 'Issue de prueba', body: '## Dependencias\n\nDepende del write-side: #500, algo mas\n' }] }),
    )
    unblockDependentIssues('999', r.tools)
    assert.deepEqual(r.edits, [])
    assert.deepEqual(r.warns, [
      "Issue #501 referencia un issue recien cerrado en su sección '## Dependencias' pero sin redacción canónica parseable ('Depende de #N' / 'Bloqueado por #N'); no se pudo evaluar su desbloqueo automático.",
    ])
  })

  test('redaccion canonica con todas sus dependencias cerradas: se desbloquea', () => {
    const r = recorder(
      unblockScenario({ body: 'Closes #600', blocked: [{ number: 602, title: 'Issue canonico', body: '## Dependencias\n\nDepende de #600\n' }], depState: 'CLOSED' }),
    )
    unblockDependentIssues('999', r.tools)
    assert.deepEqual(r.edits, ['602'])
    assert.deepEqual(r.calls.at(-1), ['issue', 'edit', '602', '--remove-label', 'bloqueado'])
    assert.deepEqual(r.warns, [])
    assert.deepEqual(r.logs, [
      'PR #999 cierra issue(s): 600. Buscando issues bloqueados dependientes...',
      'Desbloqueando issue #602: Issue canonico',
    ])
    assert.deepEqual(r.successes, ['Issue #602 desbloqueado: Issue canonico'])
  })

  test('la negacion no cuenta como dependencia', () => {
    const r = recorder(
      unblockScenario({
        body: 'Closes #700',
        blocked: [{ number: 703, title: 'Issue con negacion', body: '## Dependencias\n\n- Depende de #700\n- No depende de #701\n' }],
        depState: 'CLOSED',
        open: ['701'],
      }),
    )
    unblockDependentIssues('999', r.tools)
    assert.deepEqual(r.edits, ['703'])
  })

  test('una dependencia abierta lo deja bloqueado; un PR mergeado cuenta como cerrado', () => {
    const r = recorder((args) => {
      if (args.includes('body')) return done(0, 'Closes #800\n')
      if (args[1] === 'list') return done(0, `${JSON.stringify([{ number: 803, title: 'T', body: '## Dependencias\n- Depende de #800\n- Bloqueado por #801\n- Depende de #802\n' }])}\n`)
      if (args[0] === 'issue' && args[2] === '800') return done(0, 'CLOSED\n')
      if (args[0] === 'issue') return done(1, '', 'no es issue\n')
      if (args[2] === '801') return done(0, 'MERGED\n')
      return done(0, 'OPEN\n')
    })
    unblockDependentIssues('999', r.tools)
    assert.deepEqual(r.edits, [])
    assert.equal(r.logs.at(-1), 'Issue #803 sigue bloqueado (dependencia #802 aun abierta)')
  })

  test('si gh no logra quitar el label solo avisa', () => {
    const r = recorder(unblockScenario({ body: 'Closes #600', blocked: [{ number: 602, title: 'x', body: '## Dependencias\nDepende de #600\n' }], depState: 'CLOSED', edit: 1 }))
    unblockDependentIssues('999', r.tools)
    assert.deepEqual(r.warns, ["No se pudo quitar el label 'bloqueado' del issue #602"])
  })

  test('sin Closes, sin body o sin issues bloqueados no hace nada mas', () => {
    const noCloses = recorder(unblockScenario({ body: 'Refs #1', blocked: [] }))
    unblockDependentIssues('9', noCloses.tools)
    assert.deepEqual(noCloses.calls.length, 1)
    const none = recorder(unblockScenario({ body: 'Closes #1', blocked: [] }))
    unblockDependentIssues('9', none.tools)
    assert.deepEqual(none.logs.at(-1), "No hay issues con label 'bloqueado'.")
    const failing = recorder(unblockScenario({ body: 'Closes #1', blocked: null }))
    unblockDependentIssues('9', failing.tools)
    assert.deepEqual(failing.logs.at(-1), "No hay issues con label 'bloqueado'.")
  })

  test('un issue que no referencia los cerrados se ignora', () => {
    const r = recorder(unblockScenario({ body: 'Closes #1', blocked: [{ number: 2, title: 'x', body: '## Dependencias\n- Depende de #10\n' }], depState: 'CLOSED' }))
    unblockDependentIssues('9', r.tools)
    assert.deepEqual(r.edits, [])
    assert.deepEqual(r.warns, [])
  })
})
