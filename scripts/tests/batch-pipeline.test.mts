// `batch-pipeline.mts`: tracker del lote, compuerta de dependencias, senal de parada suave,
// contabilidad de la espera (hold) y `pipeline-status-batch.json`, con corridas de extremo a extremo
// sobre consumidores temporales y pipelines hijos falsos.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  DEFERRED_STATUS,
  deferFromIndex,
  getPr,
  getStatus,
  newBatchTracker,
  normalizedStatus,
  renderBatchStatus,
  setPr,
  setStatus,
} from '../batch-pipeline.mts'
import { stripAnsi } from '../lib/pipeline/pipeline-log.mts'
import { isolateGitConfig, writeFiles } from './field-note-sandbox.mts'
import { fakeGh, holdLine, newOrchestrated, readJson, runBatch } from './orchestrator-sandbox.mts'
import type { Orchestrated, OrchestratorRun } from './orchestrator-sandbox.mts'

let work = ''
let restoreGit: () => void = () => {}
let counter = 0

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto batch pipeline ')))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
})

function consumer(roles?: readonly string[]): Orchestrated {
  counter++
  return newOrchestrated(join(work, `caso-${counter}`), roles)
}

const text = (run: OrchestratorRun): string => stripAnsi(run.out)
const batchStatus = (repo: Orchestrated): Record<string, unknown> => readJson(join(repo.stateDir, 'pipeline-status-batch.json'))
const issuesOf = (status: Record<string, unknown>): Record<string, unknown>[] => status.issues as Record<string, unknown>[]
const summaryRow = (run: OrchestratorRun, issue: string): string =>
  text(run)
    .split('\n')
    .find((line) => new RegExp(`^#${issue}\\s`).test(line)) ?? ''
const pipelineCalls = (run: OrchestratorRun): string[] =>
  run.calls.filter((call) => !call.startsWith('pr-sync ')).map((call) => call.split(' ')[1] ?? '')
const signalOf = (repo: Orchestrated): string => join(repo.root, 'pipeline-state', 'batch-stop')
const batchLog = (repo: Orchestrated): string => {
  const name = readdirSync(join(repo.stateDir, 'logs')).find((file) => /^batch-\d{8}-\d{6}\.log$/.test(file)) ?? ''
  return readFileSync(join(repo.stateDir, 'logs', name), 'utf8')
}

describe('tracker del lote', () => {
  test('set/get de estado y PR; un issue desconocido no tiene estado ni PR', () => {
    let writes = 0
    const tracker = newBatchTracker(() => writes++)
    setStatus(tracker, '11', 'pendiente')
    setPr(tracker, '11', '1011')
    setPr(tracker, '12', '1012')
    assert.equal(getStatus(tracker, '11'), 'pendiente')
    assert.equal(getPr(tracker, '11'), '1011')
    assert.equal(getStatus(tracker, '12'), 'pendiente', 'un PR de un issue nuevo lo agrega pendiente')
    assert.equal(getStatus(tracker, '99'), 'desconocido')
    assert.equal(getPr(tracker, '99'), '')
    assert.equal(writes, 3, 'cada cambio reescribe el status')
  })

  test('en-curso fija el issue actual y cualquier otro estado lo libera', () => {
    const tracker = newBatchTracker()
    setStatus(tracker, '11', 'en-curso')
    assert.equal(tracker.current, '11')
    setStatus(tracker, '12', 'pendiente')
    assert.equal(tracker.current, '11', 'otro issue no libera al actual')
    setStatus(tracker, '11', 'completado (PR #1011 mergeado)')
    assert.equal(tracker.current, '')
  })

  test('[A] deferFromIndex consume la senal y aplaza solo desde el indice dado', () => {
    const dir = mkdtempSync(join(work, 'senal-'))
    const signal = join(dir, 'batch-stop')
    const tracker = newBatchTracker()
    const issues = ['101', '102', '103']
    for (const issue of issues) setStatus(tracker, issue, 'pendiente')
    writeFileSync(signal, '')
    deferFromIndex(tracker, issues, 1, signal)
    assert.equal(existsSync(signal), false, 'la senal se consume')
    assert.equal(getStatus(tracker, '101'), 'pendiente', 'el anterior al indice no se toca')
    assert.equal(getStatus(tracker, '102'), DEFERRED_STATUS)
    assert.equal(getStatus(tracker, '103'), DEFERRED_STATUS)
    assert.doesNotThrow(() => deferFromIndex(tracker, issues, 3, signal), 'aplazar cero issues sin senal no falla')
  })

  test('el texto libre se normaliza para los mods y pasa a detail', () => {
    assert.equal(normalizedStatus('completado (PR #1 mergeado)'), 'mergeado')
    assert.equal(normalizedStatus('ERROR: pipeline fallo'), 'fallido')
    assert.equal(normalizedStatus(DEFERRED_STATUS), 'aplazado')
    assert.equal(normalizedStatus('saltado: infra'), 'saltado')
    assert.equal(normalizedStatus('en-curso'), 'en-curso')
    assert.equal(normalizedStatus('pendiente'), 'pendiente')
    const rendered = renderBatchStatus({
      started: '20260101-000000',
      state: 'running',
      current: '12',
      stopRequested: false,
      holdSeconds: 0,
      log: '/tmp/batch.log',
      entries: [
        { issue: '11', value: 'completado (PR #1011 mergeado)', pr: '1011' },
        { issue: '12', value: 'en-curso', pr: '' },
        { issue: '13', value: 'saltado: infra', pr: '' },
        { issue: '14', value: 'ERROR: pipeline fallo (exit 3)', pr: '' },
      ],
    })
    assert.equal(
      rendered,
      `${JSON.stringify(
        {
          pipeline: 'batch',
          started: '20260101-000000',
          state: 'running',
          current: 12,
          stop_requested: false,
          hold_seconds: 0,
          log: '/tmp/batch.log',
          issues: [
            { issue: 11, status: 'mergeado', pr: 1011, detail: 'completado (PR #1011 mergeado)' },
            { issue: 12, status: 'en-curso', pr: null, detail: null },
            { issue: 13, status: 'saltado', pr: null, detail: 'infra' },
            { issue: 14, status: 'fallido', pr: null, detail: 'pipeline fallo (exit 3)' },
          ],
        },
        null,
        2,
      )}\n`,
    )
  })
})

describe('guardas', () => {
  test('sin argumentos imprime el uso y sale con 1', async () => {
    const run = await runBatch(consumer(), [])
    assert.equal(run.code, 1)
    assert.match(run.out, /^Uso: scripts\/batch-pipeline\.sh \[--pipeline tdd\|tooling\] <issue1> <issue2> \.\.\. \[--stop-on-error\]\n/)
    assert.match(run.out, /--stop-on-error {4}Abortar en el primer fallo/)
  })

  test('argumentos invalidos', async () => {
    const repo = consumer()
    const cases: [string[], string][] = [
      [['--pipeline'], 'Falta el valor de --pipeline\n'],
      [['--pipeline', 'iac', '1'], "Pipeline desconocido: iac. Usa 'tdd' o 'tooling'\n"],
      [['1', '--rapido'], 'Argumento desconocido: --rapido\n'],
    ]
    for (const [argv, message] of cases) {
      const run = await runBatch(repo, argv)
      assert.equal(run.code, 1, argv.join(' '))
      assert.equal(run.out, message)
    }
    const empty = await runBatch(repo, ['--stop-on-error'])
    assert.equal(empty.code, 1)
    assert.equal(text(empty), '✗ No se especificaron issues.\n')
  })

  test('fuera de un repo git y en el repo de Mefisto no arranca', async () => {
    const repo = consumer()
    const outside = mkdtempSync(join(work, 'fuera-'))
    const run = await runBatch(repo, ['1'], { deps: { cwd: outside } })
    assert.equal(run.code, 1)
    assert.equal(run.out, 'No estás en un repositorio git\n')

    writeFiles(repo.root, { '.claude-plugin/plugin.json': '{}\n' })
    const mefisto = await runBatch(repo, ['1'])
    assert.equal(mefisto.code, 1)
    assert.equal(
      mefisto.err,
      'ERROR: batch-pipeline.sh es del plugin publicado y solo aplica al consumidor.\nEstás en el repo de Mefisto. Trabaja los issues internos secuencialmente con /mefisto-tooling.\n',
    )
    assert.deepEqual(mefisto.calls, [])
  })

  test('dependencias y runtime se verifican antes de tocar ningun issue', async () => {
    const repo = consumer()
    const missing = await runBatch(repo, ['1'], { hasCommand: (command) => command !== 'gh' && command !== 'dotnet' })
    assert.equal(missing.code, 1)
    assert.equal(text(missing), '✗ Dependencias faltantes: gh dotnet\n')

    const unknown = await runBatch(repo, ['1'], { env: { MEFISTO_RUNTIME: 'inexistente' } })
    assert.equal(unknown.code, 1)
    assert.match(text(unknown), /^✗ No se pudo resolver el runtime activo: runtime 'inexistente' no tiene adaptador/)

    const noCli = await runBatch(repo, ['1'], { hasCommand: (command) => command !== 'claude' })
    assert.equal(noCli.code, 1)
    assert.equal(text(noCli), "✗ Dependencias faltantes: CLI del runtime 'claude'\n")
    assert.deepEqual(noCli.calls, [])
    assert.deepEqual(noCli.gh.calls, [])
  })
})

describe('corrida del lote', () => {
  test('[A] lote exitoso: pipeline, PR, merge con pr-sync y main al dia', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['11', '12'])
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(run.calls, ['tooling-pipeline 11', 'pr-sync 1011 --merge', 'tooling-pipeline 12', 'pr-sync 1012 --merge'])
    const status = batchStatus(repo)
    assert.equal(status.pipeline, 'batch')
    assert.equal(status.state, 'completed')
    assert.equal(status.current, null)
    assert.equal(status.stop_requested, false)
    assert.equal(status.hold_seconds, 0)
    assert.match(String(status.started), /^\d{8}-\d{6}$/)
    assert.match(String(status.log), /batch-.*\.log$/)
    assert.deepEqual(
      issuesOf(status).map((issue) => [issue.issue, issue.status, issue.pr]),
      [
        [11, 'mergeado', 1011],
        [12, 'mergeado', 1012],
      ],
    )
    assert.deepEqual(Object.keys(status), ['pipeline', 'started', 'state', 'current', 'stop_requested', 'hold_seconds', 'log', 'issues'])
    const output = text(run)
    assert.match(output, /── batch-pipeline --- Procesamiento secuencial de issues ──/)
    assert.match(output, /Runtime: claude/)
    assert.match(output, /Pipeline: automatico por label/)
    assert.match(output, /Ejecutando tooling-pipeline\.sh para issue #11\.\.\./)
    assert.match(output, /✓ Pipeline completado → PR #1011 \(https:\/\/github\.com\/acme\/consumidor\/pull\/1011\)/)
    assert.match(output, /Actualizando main local\.\.\./)
    assert.match(output, /✓ Issue #11 completado y mergeado\n/)
    assert.match(summaryRow(run, '11'), /^#11 {8}1011 {5}completado \(PR #1011 mergeado\)/)
    assert.match(output, /Total: 2 {2}\| {2}Completados: 2 {2}\| {2}Fallidos: 0 {2}\| {2}Aplazados: 0/)
    assert.match(output, /✓ batch-pipeline completado\. Log: /)
    assert.match(batchLog(repo), /PR creado: https:\/\/github\.com\/acme\/consumidor\/pull\/1011/, 'el log del lote acumula el de cada eslabon')
    assert.ok(existsSync(join(repo.stateDir, 'logs')), 'los logs viven bajo el estado canonico')
  })

  test('--pipeline fuerza el pipeline sin leer los labels', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['--pipeline', 'tdd', '21'], { gh: fakeGh({ issues: { '21': { labels: ['tipo:infra'] } } }) })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(pipelineCalls(run), ['21'])
    assert.equal(run.calls[0], 'tdd-pipeline 21')
    assert.match(text(run), /Pipeline: tdd \(override\)/)
  })

  test('[B] un eslabon fallido no detiene el lote y deja exit 1', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['21', '22'], { guion: { pipeline: { '21': { exit: 3, output: 'boom\n' } } } })
    assert.equal(run.code, 1)
    const status = batchStatus(repo)
    assert.equal(status.state, 'completed', 'el lote termina aunque un issue falle')
    const [failed, merged] = issuesOf(status)
    assert.equal(failed?.status, 'fallido')
    assert.equal(failed?.pr, null)
    assert.match(String(failed?.detail), /^pipeline fallo \(exit 3\)\. Log: .*batch-issue-21-/)
    assert.equal(merged?.status, 'mergeado')
    assert.match(text(run), /✗ Issue #21: pipeline fallo \(exit 3\)/)
    assert.match(text(run), /⚠ Algunos issues tuvieron errores\. Revisa el log: /)
  })

  test('--stop-on-error aborta en el primer fallo con el status en failed', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['21', '22', '--stop-on-error'], { guion: { pipeline: { '21': { exit: 2 } } } })
    assert.equal(run.code, 1)
    assert.deepEqual(pipelineCalls(run), ['21'])
    assert.match(text(run), /✗ ERROR FATAL: Detenido por --stop-on-error en issue #21\n/)
    assert.match(text(run), /Revisa el log: /)
    assert.doesNotMatch(text(run), /── Resumen ──/)
    assert.equal(batchStatus(repo).state, 'failed')
    assert.match(stripAnsi(batchLog(repo)), /✗ ERROR FATAL: Detenido por --stop-on-error en issue #21/)
  })

  test('sin URL de PR en la salida, o con el merge fallido, el eslabon falla', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['31', '32'], {
      guion: { pipeline: { '31': { output: 'listo, sin PR\n' } }, prSync: { '1032': { exit: 4 } } },
    })
    assert.equal(run.code, 1)
    assert.match(summaryRow(run, '31'), /ERROR: no se pudo extraer la URL del PR del output\. Log: /)
    assert.match(text(run), /✗ Issue #32: merge del PR #1032 falló \(exit 4\)/)
    assert.equal(issuesOf(batchStatus(repo))[1]?.pr, 1032)
  })

  test('[C] issues saltados por tipo o por estado cuentan como fallidos sin cambiar el exit code', async () => {
    const repo = consumer()
    const gh = fakeGh({ issues: { '31': { labels: ['tipo:infra'] }, '32': { labels: [] }, '34': { state: 'CLOSED' } }, missing: ['35'] })
    const run = await runBatch(repo, ['31', '32', '33', '34', '35'], { gh })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(pipelineCalls(run), ['33'])
    const issues = issuesOf(batchStatus(repo))
    assert.deepEqual(
      issues.map((issue) => [issue.status, issue.detail]),
      [
        ['saltado', 'infra'],
        ['saltado', 'no-tipo'],
        ['mergeado', 'completado (PR #1033 mergeado)'],
        ['saltado', 'issue CLOSED'],
        ['saltado', 'issue UNKNOWN'],
      ],
    )
    assert.match(text(run), /⚠ Issue #31 saltado \(infra\) --- no se puede enrutar a un pipeline\./)
    assert.match(text(run), /Issue #34 esta CLOSED --- saltando\./)
    assert.match(text(run), /Fallidos: 4/)
  })

  test('el pipeline sin TypeScript se lanza tal cual', { skip: process.platform === 'win32' }, async () => {
    const repo = consumer(['tooling-pipeline', 'pr-sync'])
    const script = join(repo.scriptsDir, 'tdd-pipeline.sh')
    writeFileSync(script, `#!/usr/bin/env bash\necho "tdd bash $1"\necho "PR creado: https://github.com/acme/consumidor/pull/$(($1 + 1000))"\n`)
    chmodSync(script, 0o755)
    const run = await runBatch(repo, ['--pipeline', 'tdd', '41'])
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /tdd bash 41\n/)
    assert.deepEqual(run.calls, ['pr-sync 1041 --merge'])
  })
})

describe('compuerta de dependencias', () => {
  test('[1] A falla: B y C, que dependen de A, se saltan y D se lanza', async () => {
    const repo = consumer()
    const gh = fakeGh({
      issues: {
        '2': { body: '## Dependencias\nDepende de #1\n', labels: ['tipo:tooling', 'bloqueado'] },
        '3': { body: '## Dependencias\n- Depende de #1\n', labels: ['tipo:tooling', 'bloqueado'] },
        '4': { body: '## Dependencias\nNinguna\n' },
      },
    })
    const run = await runBatch(repo, ['1', '2', '3', '4'], { gh, guion: { pipeline: { '1': { exit: 1 } } } })
    assert.equal(run.code, 1, 'el fallo real de A')
    assert.deepEqual(pipelineCalls(run), ['1', '4'])
    const issues = issuesOf(batchStatus(repo))
    for (const index of [1, 2]) {
      assert.equal(issues[index]?.status, 'saltado')
      assert.equal(issues[index]?.detail, 'depende de #1 (fallido en este batch)')
    }
    assert.match(summaryRow(run, '2'), /saltado: depende de #1 \(fallido en este batch\)/)
    assert.match(text(run), /⚠ Issue #2 saltado \(depende de #1 \(fallido en este batch\)\) --- no se lanza\./)
    assert.match(text(run), /⚠ 2 issue\(s\) saltados por dependencias no satisfechas\. No cambia el exit code por si solo\./)
    assert.match(text(run), /Relanza tras resolver sus dependencias: \/sequential 2 3\n/)
    assert.equal(gh.calls.filter((args) => args[1] === 'edit').length, 0, 'a los saltados no se les quita bloqueado')
  })

  test('[2] dependencia completada en este lote aunque siga OPEN: se quita bloqueado y se lanza', async () => {
    const repo = consumer()
    const gh = fakeGh({ issues: { '2': { body: '## Dependencias\nBloqueado por #1\n', labels: ['tipo:tooling', 'bloqueado'] } } })
    const run = await runBatch(repo, ['1', '2'], { gh })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(pipelineCalls(run), ['1', '2'])
    assert.deepEqual(
      gh.calls.filter((args) => args[1] === 'edit'),
      [['issue', 'edit', '2', '--remove-label', 'bloqueado']],
    )
    assert.match(text(run), /Issue #2: dependencias resueltas, se quito el label 'bloqueado'/)
  })

  test('[2b] si no se puede quitar bloqueado, avisa y lanza igual', async () => {
    const repo = consumer()
    const gh = fakeGh({ issues: { '2': { body: '## Dependencias\nDepende de #9\n', labels: ['bloqueado'] } }, prs: {}, editStatus: 1 })
    gh.issues['9'] = { state: 'CLOSED' }
    const run = await runBatch(repo, ['--pipeline', 'tooling', '2'], { gh })
    assert.equal(run.code, 0, run.out)
    assert.match(text(run), /⚠ Issue #2: no se pudo quitar el label 'bloqueado' \(continuando\)/)
    assert.deepEqual(pipelineCalls(run), ['2'])
  })

  test('[3] externa OPEN salta, externa CLOSED o PR MERGED lanza, bloqueado sin canonicas salta', async () => {
    const repo = consumer()
    const gh = fakeGh({
      issues: {
        '5': { body: '## Dependencias\nDepende de #90\n' },
        '6': { body: '## Dependencias\nDepende de #91\n' },
        '7': { body: '## Dependencias\nNinguna\n', labels: ['tipo:tooling', 'bloqueado'] },
        '8': { state: 'CLOSED' },
        '9': { body: '## Dependencias\nDepende de #8\n' },
        '10': { body: '## Dependencias\nDepende de #92\n' },
        '11': { body: '## Dependencias\nDepende de #93\n' },
        '90': { state: 'OPEN' },
        '91': { state: 'CLOSED' },
      },
      missing: ['92', '93'],
      prs: { '92': 'MERGED' },
    })
    const run = await runBatch(repo, ['5', '6', '7', '8', '9', '10', '11'], { gh })
    assert.equal(run.code, 0, 'los saltos solos no cambian el exit code')
    assert.deepEqual(pipelineCalls(run), ['6', '9', '10'], '#8 saltado por CLOSED satisface a #9; un PR MERGED satisface a #10')
    assert.match(summaryRow(run, '5'), /depende de #90 \(OPEN\)/)
    assert.match(summaryRow(run, '7'), /bloqueado sin dependencias canonicas/)
    assert.match(summaryRow(run, '11'), /depende de #93 \(no consultable\)/)
  })
})

describe('parada suave', () => {
  test('[E] la senal previa detiene todo antes de arrancar y se consume', async () => {
    const repo = consumer()
    mkdirSync(join(repo.root, 'pipeline-state'), { recursive: true })
    writeFileSync(signalOf(repo), '')
    const run = await runBatch(repo, ['201', '202', '203'])
    assert.equal(run.code, 0, 'una parada solicitada no es un fallo')
    assert.deepEqual(run.calls, [])
    for (const issue of ['201', '202', '203']) assert.match(summaryRow(run, issue), /aplazado/)
    assert.match(
      text(run),
      /⚠ Parada solicitada \(pipeline-state\/batch-stop\) antes de arrancar el primer eslabon: ningun issue se procesa en esta corrida\./,
    )
    assert.match(text(run), /Relanza los aplazados, en el mismo orden: \/sequential 201 202 203\n/)
    assert.match(text(run), /Fallidos: 0 /)
    assert.equal(existsSync(signalOf(repo)), false)
    assert.equal(batchStatus(repo).state, 'stopped')
  })

  test('[D/F] la senal durante el primer eslabon lo deja completar y aplaza el resto', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['301', '302', '303'], { guion: { pipeline: { '301': { signal: true } } } })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(pipelineCalls(run), ['301'])
    assert.match(summaryRow(run, '301'), /^#301 {7}1301 {5}completado/)
    for (const issue of ['302', '303']) assert.match(summaryRow(run, issue), /aplazado/)
    assert.match(
      text(run),
      /Parada solicitada \(pipeline-state\/batch-stop\) tras completar #301: los eslabones restantes quedan aplazados, sin arrancar ningun worktree\./,
    )
    assert.match(text(run), /\/sequential 302 303\n/)
    assert.match(text(run), /Fallidos: 0 /)
    assert.equal(existsSync(signalOf(repo)), false)
    const status = batchStatus(repo)
    assert.equal(status.state, 'stopped')
    assert.equal(status.current, null)
    assert.deepEqual(
      issuesOf(status).map((issue) => issue.status),
      ['mergeado', 'aplazado', 'aplazado'],
    )
    assert.match(String(issuesOf(status)[1]?.detail), /parada/)
  })

  test('[G] la senal durante el ultimo eslabon no aplaza nada y se consume igual', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['401', '402'], { guion: { pipeline: { '402': { signal: true } } } })
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(pipelineCalls(run), ['401', '402'])
    assert.doesNotMatch(text(run), /aplazado/)
    assert.doesNotMatch(text(run), /\/sequential 4/)
    assert.match(text(run), /que era el ultimo eslabon del batch: no quedaba ninguno por arrancar\./)
    assert.equal(existsSync(signalOf(repo)), false)
    assert.equal(batchStatus(repo).state, 'completed')
  })

  test('un eslabon fallido no consulta la senal', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['501', '502'], { guion: { pipeline: { '501': { signal: true, exit: 1 } } } })
    assert.equal(run.code, 1)
    assert.deepEqual(pipelineCalls(run), ['501', '502'], 'la senal se lee tras el siguiente eslabon completado')
    assert.equal(existsSync(signalOf(repo)), false)
    assert.equal(batchStatus(repo).state, 'completed', 'no quedaba nada que aplazar')
  })
})

describe('espera (hold) de los eslabones', () => {
  const session = (issue: string): string => `=== SESSION TOOLING 20260101-000000 issue:${issue} from-stage:1 ===`

  test('la espera se anota en el desenlace, en el status y en el resumen sin contar como fallo', async () => {
    const repo = consumer()
    const events = [session('61'), holdLine('10:00:00', '10:02:00')]
    const run = await runBatch(repo, ['61', '62'], {
      guion: { pipeline: { '61': { events }, '62': { events: [session('62'), holdLine('11:00:00', '11:01:30')], exit: 5 } } },
    })
    assert.equal(run.code, 1)
    assert.match(text(run), /Issue #61: 2m 0s en espera \(hold\) durante este eslabon -- no cuenta como fallo/)
    assert.match(text(run), /✓ Issue #61 completado y mergeado \(incluye 2m 0s en espera\/hold\)\n/)
    assert.match(text(run), /✗ Issue #62: pipeline fallo \(exit 5\)\. Log: .* \(incluye 1m 30s en espera\/hold\)/)
    assert.match(text(run), /En espera \(hold\) durante el batch: 3m 30s -- por limite de uso o caida del proveedor, no cuenta como fallo/)
    assert.match(text(run), /Fallidos: 1 /, 'la espera no suma fallos')
    const status = batchStatus(repo)
    assert.equal(status.hold_seconds, 210)
    assert.equal(issuesOf(status)[0]?.detail, 'completado (PR #1061 mergeado) (incluye 2m 0s en espera/hold)')
  })

  test('solo cuenta la espera bajo la sesion del issue, y lee tambien el events.log legacy', async () => {
    const repo = consumer()
    const run = await runBatch(repo, ['63', '64'], {
      guion: {
        pipeline: {
          '63': { events: [session('99'), holdLine('10:00:00', '10:05:00')] },
          '64': { legacyEvents: [session('64'), holdLine('10:00:00', '10:02:00')] },
        },
      },
    })
    assert.equal(run.code, 0, run.out)
    assert.doesNotMatch(text(run), /Issue #63: .* en espera/, 'una corrida intercalada de otro issue no le regala su espera')
    assert.match(text(run), /Issue #64: 2m 0s en espera \(hold\) durante este eslabon/)
    assert.equal(batchStatus(repo).hold_seconds, 120)
  })

  test('lo escrito en events.log antes del eslabon no cuenta', async () => {
    const repo = consumer()
    mkdirSync(repo.stateDir, { recursive: true })
    writeFileSync(join(repo.stateDir, 'events.log'), `${session('65')}\n${holdLine('10:00:00', '10:02:00')}\n`)
    const run = await runBatch(repo, ['65'])
    assert.equal(run.code, 0, run.out)
    assert.doesNotMatch(text(run), /en espera \(hold\)/)
    assert.equal(batchStatus(repo).hold_seconds, 0)
  })
})
