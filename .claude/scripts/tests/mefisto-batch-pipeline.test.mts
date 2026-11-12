// `mefisto-batch-pipeline.mts` de extremo a extremo sobre repos temporales con remoto bare, `gh`
// inyectado y eslabones falsos: runtime, gate de dependencias, parada suave, espera (hold),
// reconciliacion post-merge, raiz ejecutable aislada, gate de rama base y sync verificado.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { stripAnsi } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { git, gitOk, isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import { fakeGh, holdLine, issueStatus, newBatchRepo, pipelineIssues, readStatus, runMefistoBatch } from './mefisto-batch-pipeline-sandbox.mts'
import type { BatchRepo, BatchRun } from './mefisto-batch-pipeline-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto batch interno ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function mefisto(files?: Record<string, string>): BatchRepo {
  counter++
  return newBatchRepo(join(work, `caso-${counter}`), files)
}

const text = (run: BatchRun): string => stripAnsi(run.out)
const row = (run: BatchRun, issue: string): string =>
  text(run)
    .split('\n')
    .find((line) => new RegExp(`^#${issue}\\s`).test(line)) ?? ''
const callsOf = (run: BatchRun, role: string): Record<string, unknown>[] => run.calls.filter((call) => call.role === role)
const signalOf = (repo: BatchRepo): string => join(repo.stateDir, 'batch-stop')
const dependsOn = (issue: string): string => `## Contexto\nx\n\n## Dependencias\n- Depende de #${issue}\n`
const issueLog = (repo: BatchRepo, issue: string): string => {
  const dir = join(repo.stateDir, 'logs')
  const name = readdirSync(dir).find((file) => file.startsWith(`mefisto-batch-issue-${issue}-`)) ?? ''
  return readFileSync(join(dir, name), 'utf8')
}
const batchLog = (repo: BatchRepo): string => {
  const dir = join(repo.stateDir, 'logs')
  const name = readdirSync(dir).find((file) => /^mefisto-batch-\d{8}-\d{6}\.log$/.test(file)) ?? ''
  return readFileSync(join(dir, name), 'utf8')
}
const same = (a: string, b: string): boolean => realpathSync.native(a) === realpathSync.native(b)

describe('argumentos y precondiciones', () => {
  test('sin argumentos imprime el uso; un argumento ajeno y la falta de issues terminan en 1', async () => {
    const repo = mefisto()
    const usage = await runMefistoBatch(repo, [])
    assert.equal(usage.code, 1)
    assert.match(text(usage), /^Uso: src\/internal\/scripts\/mefisto-batch-pipeline\.sh <issue1> <issue2> \.\.\. \[--stop-on-error\]\n/)
    const unknown = await runMefistoBatch(repo, ['12', '--rapido'])
    assert.equal(unknown.code, 1)
    assert.equal(text(unknown), 'Argumento desconocido: --rapido\n')
    const none = await runMefistoBatch(repo, ['--stop-on-error'])
    assert.equal(none.code, 1)
    assert.equal(text(none), 'x No se especificaron issues.\n')
  })

  test('fuera del repo de Mefisto aborta con la guarda en stderr', async () => {
    const repo = mefisto()
    rmSync(join(repo.root, '.claude-plugin'), { recursive: true })
    const run = await runMefistoBatch(repo, ['1'])
    assert.equal(run.code, 1)
    assert.match(run.err, /ERROR: este pipeline solo se ejecuta dentro del repo de Mefisto/)
    assert.equal(run.out, '')
  })

  test('faltan git o gh: aborta antes de cualquier eslabon', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['1'], { hasCommand: (command) => command !== 'gh' })
    assert.equal(run.code, 1)
    assert.equal(text(run), 'x Dependencias faltantes: gh\n')
    assert.deepEqual(run.calls, [])
  })
})

describe('runtime del eslabon', () => {
  for (const [runtime, other] of [
    ['claude', 'fake'],
    ['fake', 'claude'],
  ] as const) {
    test(`MEFISTO_RUNTIME=${runtime} sin su CLI (solo '${other}') aborta con el remedio`, async () => {
      const repo = mefisto()
      const run = await runMefistoBatch(repo, ['100', '200'], {
        env: { MEFISTO_RUNTIME: runtime },
        hasCommand: (command) => command !== runtime,
      })
      assert.notEqual(run.code, 0)
      assert.ok(text(run).includes(`'${runtime}'`))
      assert.ok(text(run).includes('Fija MEFISTO_RUNTIME con un runtime instalado.'))
      assert.deepEqual(pipelineIssues(run), [], 'ningun eslabon se lanzo')
    })

    test(`MEFISTO_RUNTIME=${runtime}: el eslabon lo hereda y --stop-on-error corta antes del segundo`, async () => {
      const repo = mefisto()
      const run = await runMefistoBatch(repo, ['100', '200', '--stop-on-error'], {
        env: { MEFISTO_RUNTIME: runtime },
        guion: { pipeline: { '100': { exit: 1, stderr: 'fallo simulado\n' } } },
      })
      assert.equal(run.code, 1)
      assert.deepEqual(pipelineIssues(run), ['100'])
      assert.equal(callsOf(run, 'mefisto-tooling-pipeline')[0]?.runtime, runtime)
      assert.match(text(run), /x ERROR FATAL: Detenido por --stop-on-error en issue #100/)
      assert.equal(readStatus(repo).state, 'failed')
    })

    test(`sin MEFISTO_RUNTIME el batch autodetecta '${runtime}' y el eslabon recibe ese mismo`, async () => {
      const repo = mefisto()
      const run = await runMefistoBatch(repo, ['100'], {
        env: { MEFISTO_RUNTIME: undefined, MEFISTO_FAKE_AVAILABLE: runtime === 'fake' ? '1' : undefined },
        hasCommand: (command) => command !== other,
        guion: { pipeline: { '100': { exit: 1 } } },
      })
      assert.equal(callsOf(run, 'mefisto-tooling-pipeline')[0]?.runtime, runtime)
      assert.ok(text(run).includes(`Runtime activo: ${runtime}`))
    })
  }

  test('el eslabon hereda el entorno completo, MEFISTO_AGENT_TIMEOUT_SECONDS incluido', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['100'], {
      env: { MEFISTO_AGENT_TIMEOUT_SECONDS: '77' },
      guion: { pipeline: { '100': { exit: 1 } } },
    })
    assert.equal(callsOf(run, 'mefisto-tooling-pipeline')[0]?.timeout, '77')
  })
})

describe('gate de dependencias por eslabon', () => {
  test('A falla: B y C dependen de A y se saltan, D independiente se lanza', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['501', '502', '503', '504'], {
      gh: fakeGh({ bodies: { '502': dependsOn('501'), '503': dependsOn('501') }, states: { '501': 'OPEN' } }),
      guion: { pipeline: { '501': { exit: 1 } } },
    })
    assert.deepEqual(pipelineIssues(run), ['501', '504'])
    for (const issue of ['502', '503']) assert.equal(issueStatus(repo, issue), 'saltado: depende de #501 (fallido en este batch)')
    assert.equal(readStatus(repo).state, 'failed')
    assert.ok(text(run).includes('/mefisto-sequential 502 503'), 'linea de relanzamiento en el orden del batch')
    assert.ok(text(run).includes('Fallidos: 3'), '1 fallido + 2 saltados')
    assert.ok(text(run).includes('! 2 issue(s) saltados por dependencia no satisfecha. No se lanzaron.'))
    assert.equal(run.code, 1)
  })

  test('dependencia completada en este batch con el issue aun OPEN en GitHub: se lanza', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['601', '602'], {
      gh: fakeGh({ bodies: { '602': dependsOn('601') }, states: { '601': 'OPEN' } }),
    })
    assert.deepEqual(pipelineIssues(run), ['601', '602'])
    assert.equal(run.code, 0)
  })

  test('dependencia externa OPEN: saltado sin marcar el batch como fallido', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['701', '702'], {
      gh: fakeGh({ bodies: { '702': dependsOn('999') }, states: { '999': 'OPEN' } }),
    })
    assert.equal(issueStatus(repo, '702'), 'saltado: depende de #999 (OPEN)')
    assert.deepEqual(pipelineIssues(run), ['701'])
    assert.equal(run.code, 0)
    assert.equal(readStatus(repo).state, 'completed')
    assert.ok(text(run).includes('! Issue #702 saltado: depende de #999 (OPEN); no se lanza el pipeline.'))
  })

  test('dependencia fallida en este batch pero CLOSED en GitHub: satisfecha', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['801', '802'], {
      gh: fakeGh({ bodies: { '802': dependsOn('801') }, states: { '801': 'CLOSED' } }),
      guion: { pipeline: { '801': { exit: 1 } } },
    })
    assert.deepEqual(pipelineIssues(run), ['801', '802'])
    assert.ok(!issueStatus(repo, '802').startsWith('saltado'))
  })

  test('una dependencia que es un PR MERGED satisface; una sin estado consultable no', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['901', '902'], {
      gh: fakeGh({ bodies: { '901': dependsOn('950'), '902': dependsOn('951') }, prStates: { '950': 'MERGED' } }),
    })
    assert.deepEqual(pipelineIssues(run), ['901'])
    assert.equal(issueStatus(repo, '902'), 'saltado: depende de #951 (no consultable)')
  })
})

describe('parada suave', () => {
  test('senal presente antes de arrancar: nada se procesa, todo aplazado y la senal se consume', async () => {
    const repo = mefisto()
    const signal = signalOf(repo)
    mkdirSync(repo.stateDir, { recursive: true })
    writeFileSync(signal, '')
    const run = await runMefistoBatch(repo, ['201', '202', '203'])
    assert.equal(run.code, 0)
    assert.deepEqual(pipelineIssues(run), [])
    for (const issue of ['201', '202', '203']) assert.match(row(run, issue), /aplazado/)
    assert.ok(text(run).includes('/mefisto-sequential 201 202 203'))
    assert.equal(existsSync(signal), false)
    assert.ok(text(run).includes('Fallidos: 0'))
    assert.ok(text(run).includes(`Parada solicitada (${signal}) antes de arrancar el primer eslabon`))
    assert.equal(readStatus(repo).state, 'stopped')
  })

  test('senal durante el primer eslabon: se completa entero y el resto queda aplazado', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['301', '302', '303'], { guion: { pipeline: { '301': { signal: true } } } })
    assert.equal(run.code, 0)
    assert.deepEqual(pipelineIssues(run), ['301'])
    assert.match(row(run, '301'), /^#301\s+1301\s+completado/)
    for (const issue of ['302', '303']) assert.match(row(run, issue), /aplazado/)
    assert.ok(text(run).includes('/mefisto-sequential 302 303'))
    assert.equal(existsSync(signalOf(repo)), false)
    assert.ok(text(run).includes('Fallidos: 0'))
    assert.ok(text(run).includes('Aplazados: 2'))
  })

  test('senal durante el ultimo eslabon: nada que aplazar, pero se consume igual', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['401', '402'], { guion: { pipeline: { '402': { signal: true } } } })
    assert.equal(run.code, 0)
    assert.deepEqual(pipelineIssues(run), ['401', '402'])
    assert.ok(!text(run).includes('aplazado'))
    assert.ok(!text(run).includes('/mefisto-sequential 4'))
    assert.equal(existsSync(signalOf(repo)), false)
    assert.ok(text(run).includes('era el ultimo eslabon del batch'))
    assert.equal(readStatus(repo).state, 'completed')
  })
})

describe('espera (hold) de cada eslabon', () => {
  test('un eslabon que espera y se recupera queda completado con la nota y el total en el resumen', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['601', '602'], {
      guion: { pipeline: { '601': { events: [holdLine('12:00:00', '12:05:00'), holdLine('12:10:00', '12:15:00')] } } },
    })
    assert.equal(run.code, 0)
    assert.ok(text(run).includes('Fallidos: 0'))
    assert.match(row(run, '601'), /completado/)
    assert.ok(!row(run, '601').includes('ERROR'))
    assert.ok(row(run, '601').includes('incluye 10m 0s en espera/hold'))
    assert.match(row(run, '602'), /completado/)
    assert.ok(!row(run, '602').includes('en espera/hold'))
    assert.ok(text(run).includes('  Tiempo total en espera (hold): 10m 0s\n'))
    assert.ok(text(run).includes('Issue #601: 10m 0s en espera (hold) durante este eslabon'))
    assert.equal(readStatus(repo).hold_seconds, 600)
  })

  test('un eslabon que espera y falla de verdad cuenta como fallo, con la espera como contexto', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['701'], {
      guion: { pipeline: { '701': { exit: 1, events: [holdLine('12:00:00', '12:02:00', 'PROVIDER_UNAVAILABLE')] } } },
    })
    assert.equal(run.code, 1)
    assert.ok(text(run).includes('Fallidos: 1'))
    assert.match(row(run, '701'), /ERROR/)
    assert.ok(row(run, '701').includes('incluye 2m 0s en espera/hold'))
  })

  test('dos eslabones reportan cada uno su espera y el total es la suma exacta', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['801', '802'], {
      guion: {
        pipeline: {
          '801': { events: [holdLine('12:00:00', '12:05:00')] },
          '802': { events: [holdLine('13:00:00', '13:07:30')] },
        },
      },
    })
    assert.equal(run.code, 0)
    assert.ok(row(run, '801').includes('incluye 5m 0s en espera/hold'))
    assert.ok(row(run, '802').includes('incluye 7m 30s en espera/hold'))
    assert.ok(text(run).includes('Tiempo total en espera (hold): 12m 30s'))
  })

  test('una sesion ajena intercalada en events.log no le regala su espera al eslabon', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['901'], {
      guion: {
        pipeline: {
          '901': {
            events: [
              holdLine('12:00:00', '12:03:00'),
              '=== SESSION MEFISTO-TOOLING 20260101-000001 issue:99999 from-stage:1 ===',
              holdLine('12:05:00', '12:15:00'),
            ],
          },
        },
      },
    })
    assert.equal(run.code, 0)
    assert.ok(row(run, '901').includes('incluye 3m 0s en espera/hold'))
    assert.ok(text(run).includes('Tiempo total en espera (hold): 3m 0s'))
  })
})

describe('reconciliacion post-merge', () => {
  test('cada merge exitoso reconcilia una vez, despues del merge y antes del sync y del siguiente eslabon', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['101', '102'])
    assert.equal(run.code, 0)
    const trace = run.calls.map((call) => {
      const args = call.args as string[]
      if (call.role === 'gh') return `${args[0]} ${args[1]} ${args[2]}`
      return call.role === 'mefisto-tooling-pipeline' ? `tooling ${args[0]}` : `reconcile ${args.join(' ')}`
    })
    assert.deepEqual(trace, [
      'tooling 101',
      'pr merge 1101',
      'reconcile --reconcile-pr 1101',
      'pr view 1101',
      'tooling 102',
      'pr merge 1102',
      'reconcile --reconcile-pr 1102',
      'pr view 1102',
    ])
    const reconcile = callsOf(run, 'mefisto-validate-batch-deps')[0]
    assert.ok(same(String(reconcile?.cwd), repo.root), 'el reconciliador corre desde el checkout lanzador')
    assert.match(String(reconcile?.toplevel), /mefisto-batch-execution-/, 'pero es el del snapshot')
    assert.equal(git(repo.root, 'rev-parse', 'main'), git(repo.publisher, 'rev-parse', 'main'), 'main local quedo sincronizado')
    assert.deepEqual(run.gh.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge')[0], ['pr', 'merge', '1101', '--squash', '--delete-branch'])
  })

  test('un fallo de la reconciliacion es un aviso y no detiene el siguiente eslabon', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['201', '202'], {
      guion: { reconcile: { '1201': { exit: 1, output: '', stderr: 'fallo simulado del reconciliador para PR #1201\n' } } },
    })
    assert.equal(run.code, 0)
    assert.ok(text(run).includes('reconciliacion post-merge de bloqueados fallo (exit 1)'))
    assert.ok(issueLog(repo, '201').includes('fallo simulado del reconciliador para PR #1201'))
    assert.equal(callsOf(run, 'mefisto-validate-batch-deps').length, 2, 'sin reintento y el siguiente sigue')
    assert.equal(callsOf(run, 'gh').length, 4, 'dos merges y dos sync')
    assert.ok(issueLog(repo, '202').includes('reconciliado PR #1202'))
  })

  test('un merge fallido no reconcilia ni sincroniza', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['301'], { gh: fakeGh({ mergeFails: ['1301'] }) })
    assert.equal(run.code, 1)
    assert.deepEqual(callsOf(run, 'mefisto-validate-batch-deps'), [])
    assert.equal(run.gh.calls.filter((args) => args.includes('mergeCommit')).length, 0)
    assert.match(row(run, '301'), /ERROR: merge del PR #1301 fallo \(exit 1\)/)
    assert.ok(issueLog(repo, '301').includes('merge simulado fallido del PR #1301'))
  })

  test('sin URL de PR en la salida del eslabon el issue falla sin mergear', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['401'], { guion: { pipeline: { '401': { output: 'sin PR\n' } } } })
    assert.equal(run.code, 1)
    assert.match(row(run, '401'), /ERROR: no se pudo extraer la URL del PR del output\. Log: /)
    assert.deepEqual(callsOf(run, 'gh'), [])
  })
})

describe('raiz ejecutable aislada', () => {
  test('writer y reviewer usan la misma maquinaria aunque el lanzador cambie, y el siguiente recibe la mergeada', async () => {
    const repo = mefisto()
    git(repo.root, 'switch', '-q', '-c', 'docs/concurrent')
    writeFileSync(join(repo.root, 'marker.txt'), 'mutable\n')
    git(repo.root, 'commit', '-q', '-am', 'checkout mutable')
    git(repo.root, 'switch', '-q', 'main')
    const run = await runMefistoBatch(repo, ['1', '2'], {
      guion: { pipeline: { '1': { mutateLauncher: true } } },
      gh: fakeGh({
        onMerge: (pr, publisher) => {
          if (pr === '1001') writeFileSync(join(publisher, 'marker.txt'), 'v2\n')
          git(publisher, 'commit', '-q', '--allow-empty', '-am', `merge PR #${pr}`)
        },
      }),
    })
    assert.equal(run.code, 0, text(run) + run.err)
    const [first, second] = callsOf(run, 'mefisto-tooling-pipeline')
    assert.deepEqual(first?.markers, ['v1', 'v1'], 'el primer eslabon no cambio de maquinaria')
    assert.deepEqual(second?.markers, ['v2', 'v2'], 'el segundo corre con la de origin/main')
    for (const call of [first, second]) {
      // La raiz aislada ya no existe al terminar: se compara su texto.
      assert.match(String(call?.toplevel), /mefisto-batch-execution-\d{8}-\d{6}-\d+$/, 'ningun eslabon corre desde el checkout lanzador')
      assert.equal(resolve(String(call?.cwd)), resolve(String(call?.toplevel)), 'el cwd es el snapshot')
      assert.ok(same(String(call?.launchRoot), repo.root))
    }
    assert.equal(git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'docs/concurrent', 'el HEAD concurrente se preserva')
    assert.ok(readFileSync(join(repo.root, 'marker.txt'), 'utf8').includes('modificado'))
    assert.equal(gitOk(repo.root, 'diff', '--cached', '--quiet', '--', 'staged.txt'), false, 'el cambio staged sigue')
    assert.ok(existsSync(join(repo.root, 'untracked.txt')))
    assert.ok(!git(repo.root, 'worktree', 'list').includes('mefisto-batch-execution-'), 'la raiz aislada se limpio al cerrar')
    assert.equal(git(repo.root, 'rev-parse', 'refs/heads/main'), git(repo.publisher, 'rev-parse', 'main'), 'main se actualizo por nombre')
  })

  test('un snapshot sin el pipeline interno aborta antes de lanzar ningun stage y limpia su raiz', async () => {
    const repo = mefisto()
    git(repo.publisher, 'pull', '-q', 'origin', 'main')
    git(repo.publisher, 'rm', '-q', 'src/internal/scripts/mefisto-tooling-pipeline.mts')
    git(repo.publisher, 'commit', '-q', '-m', 'sin pipeline')
    git(repo.publisher, 'push', '-q', 'origin', 'main')
    const run = await runMefistoBatch(repo, ['1'])
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR FATAL: El snapshot [0-9a-f]{40} no contiene el pipeline interno ejecutable: .*mefisto-tooling-pipeline\.mts/)
    assert.deepEqual(pipelineIssues(run), [])
    assert.ok(!git(repo.root, 'worktree', 'list').includes('mefisto-batch-execution-'))
    const status = readStatus(repo)
    assert.equal(status.state, 'failed')
    assert.equal(status.current, '1', 'el aborto conserva el eslabon en curso')
    assert.ok(batchLog(repo).includes('ERROR FATAL: El snapshot'))
  })
})

describe('gate de rama base al arrancar', () => {
  test('rama ajena con arbol limpio: se recupera a main con aviso, antes de la cabecera', async () => {
    const repo = mefisto()
    git(repo.root, 'switch', '-q', '-c', 'docs/field-notes-refinamiento-718')
    git(repo.publisher, 'commit', '-q', '--allow-empty', '-m', 'c2')
    git(repo.publisher, 'push', '-q', 'origin', 'main')
    const run = await runMefistoBatch(repo, ['1'])
    assert.equal(run.code, 0, text(run))
    const output = text(run)
    const warned = output.indexOf("! El repo principal estaba en la rama 'docs/field-notes-refinamiento-718'")
    assert.ok(warned !== -1)
    assert.ok(warned < output.indexOf('-- mefisto-batch-pipeline --- Procesamiento secuencial de issues internos --'))
    assert.ok(output.includes('Rama base: main (el batch la mantiene sincronizada'))
  })

  test('rama ajena con arbol sucio: aborta sin tocar HEAD ni lanzar nada', async () => {
    const repo = mefisto()
    git(repo.root, 'switch', '-q', '-c', 'feature-sucia')
    writeFileSync(join(repo.root, 'archivo-sin-trackear.txt'), 'x\n')
    const run = await runMefistoBatch(repo, ['1'])
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR FATAL: .*no esta limpio/)
    assert.equal(git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-sucia')
    assert.deepEqual(pipelineIssues(run), [])
    assert.equal(readStatus(repo).state, 'failed')
  })
})

describe('desenlace del sync verificado', () => {
  const brokenMerge = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

  test('merge ausente de origin/main con eslabones pendientes: aborta la cadena', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['1', '2'], { gh: fakeGh({ mergeShas: { '1001': brokenMerge } }) })
    assert.equal(run.code, 1)
    assert.match(text(run), /x ERROR FATAL: Sync verificado de origin\/main tras el PR #1001 fallo/)
    assert.deepEqual(pipelineIssues(run), ['1'])
    assert.equal(issueStatus(repo, '1'), 'completado (PR #1001 mergeado; sync de origin/main FALLIDO)')
    assert.equal(readStatus(repo).state, 'failed')
  })

  test('merge ausente de origin/main en el ultimo eslabon: aviso y exit 1 sin abortar', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['1'], { gh: fakeGh({ mergeShas: { '1001': brokenMerge } }) })
    assert.equal(run.code, 1)
    assert.ok(text(run).includes('#1 era el ultimo eslabon: ningun issue posterior depende de este merge.'))
    assert.ok(!text(run).includes('ERROR FATAL'))
    assert.ok(text(run).includes('Algunos issues tuvieron errores.'))
  })

  test('solo main LOCAL sin sincronizar: aviso no fatal, la cadena sigue y el batch sale en 0', async () => {
    const repo = mefisto()
    git(repo.root, 'branch', 'docs/concurrent')
    git(repo.root, 'commit', '-q', '--allow-empty', '-m', 'local divergente')
    const run = await runMefistoBatch(repo, ['1', '2'], { guion: { pipeline: { '1': { mutateLauncher: true } } } })
    assert.equal(run.code, 0, text(run))
    assert.deepEqual(pipelineIssues(run), ['1', '2'])
    assert.equal(issueStatus(repo, '1'), 'completado (PR #1001 mergeado; sync de main LOCAL fallido, no fatal)')
    assert.ok(text(run).includes('No bloquea la cadena: el siguiente worktree nace de origin/main.'))
    assert.ok(text(run).includes("main LOCAL quedo sin sincronizar en algun eslabon (ver el detalle arriba). Ponte al dia con 'git switch main && git pull --ff-only'."))
    assert.equal(readStatus(repo).state, 'completed')
  })

  test('sync completo: completado, status final y log del batch', async () => {
    const repo = mefisto()
    const run = await runMefistoBatch(repo, ['1'])
    assert.equal(run.code, 0)
    assert.match(text(run), /v main local incluye el merge del PR #1001 \(commit [0-9a-f]{12}\)/)
    assert.ok(text(run).includes('Total: 1  |  Completados: 1  |  Fallidos: 0  |  Aplazados: 0'))
    const status = readStatus(repo)
    assert.equal(status.pipeline, 'mefisto-batch')
    assert.equal(status.state, 'completed')
    assert.equal(status.current, null)
    assert.equal(status.stop_requested, false)
    assert.deepEqual(status.issues, [{ issue: '1', status: 'completado (PR #1001 mergeado)', pr: '1001' }])
    assert.ok(same(String(status.log), join(repo.stateDir, 'logs', String(status.log).split(/[\\/]/).at(-1) ?? '')))
    const log = batchLog(repo)
    assert.ok(log.includes('-- mefisto-batch-pipeline --- Procesamiento secuencial de issues internos --'))
    assert.ok(log.includes('v PR creado: https://github.com/acme/mefisto/pull/1001'), 'la salida del eslabon se anexa sin color')
    assert.ok(!log.includes('\u001b[0;34m'), 'los mensajes van al log sin color')
  })
})
