import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { get, iterate, path } from '../lib/jq-values.mts'
import type { Json } from '../lib/jq-values.mts'
import { main, parseEpoch } from '../work-status-collect.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'work-status')
const SHIM = join(HERE, '..', 'work-status-collect.sh')
const NOW = new Date(2026, 5, 15, 12, 0, 0)

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto estado trabajo '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const pad2 = (value: number): string => String(value).padStart(2, '0')
const at = (delta: number): Date => new Date(NOW.getTime() + delta * 1000)
const day = (date: Date): string[] => [String(date.getFullYear()), pad2(date.getMonth() + 1), pad2(date.getDate())]
const hms = (delta: number): string => [at(delta).getHours(), at(delta).getMinutes(), at(delta).getSeconds()].map(pad2).join(':')
const iso = (delta: number): string => `${day(at(delta)).join('-')}T${hms(delta)}`
const stamp = (delta: number): string => `${day(at(delta)).join('')}-${hms(delta).replaceAll(':', '')}`

interface Run {
  code: number
  stdout: string
  stderr: string
}

function run(argv: string[], env: NodeJS.ProcessEnv, cwd = work): Run {
  let [stdout, stderr] = ['', '']
  const code = main(argv, { cwd, env, now: NOW, out: (text) => (stdout += text), err: (text) => (stderr += text) })
  return { code, stdout, stderr }
}

function collect(canonical: string, legacy: string): Json {
  const { code, stdout, stderr } = run(['--json'], { MEFISTO_STATE_DIR: canonical, MEFISTO_LEGACY_STATE_DIR: legacy })
  assert.equal(code, 0)
  assert.equal(stderr, '')
  return JSON.parse(stdout) as Json
}

const fixture = (name: string, root: string): string => join(FIXTURES, name, root)
const missing = (name: string): string => join(work, `no-existe-${name}`)
const rows = (result: Json, issue: Json): Json[] => iterate(get(result, 'rows')).filter((row) => get(row, 'issue') === issue)
const row = (result: Json, issue: Json): Json => rows(result, issue)[0] ?? null
const history = (result: Json, issue: Json): Json =>
  iterate(get(result, 'history')).find((entry) => get(entry, 'issue') === issue) ?? null

function roots(name: string): { canonical: string; legacy: string } {
  const [canonical, legacy] = [join(work, name, 'canonical'), join(work, name, 'legacy')]
  mkdirSync(join(canonical, 'logs'), { recursive: true })
  mkdirSync(join(legacy, 'logs'), { recursive: true })
  return { canonical, legacy }
}

const write = (file: string, value: Json | string): void =>
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
const touch = (file: string): void => writeFileSync(file, '')

function runningTooling(issue: string, extra: Record<string, Json> = {}): Json {
  return {
    issue,
    title: 'hold textual',
    pipeline: 'tooling',
    variant: null,
    runtime: null,
    stage: '1-writer',
    state: 'running',
    started: stamp(0),
    updated: iso(0),
    log: `/no/existe/${issue}.log`,
    pr: null,
    last_error: null,
    agents: { writer: { duration: null, result: 'running' }, reviewer: { duration: null, result: 'pending' } },
    ...extra,
  }
}

function checksum(dir: string): string {
  if (!existsSync(dir)) return 'no-dir'
  const hash = createHash('sha256')
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) hash.update(entry.name).update(readFileSync(join(entry.parentPath, entry.name)))
  }
  return hash.digest('hex')
}

test('--json es obligatorio: cualquier otra forma imprime el uso y sale con 2', () => {
  const env = { MEFISTO_STATE_DIR: missing('uso-c'), MEFISTO_LEGACY_STATE_DIR: missing('uso-l') }
  for (const argv of [[], ['--otro'], ['--json', '--json']]) {
    const { code, stdout, stderr } = run(argv, env)
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr, `Uso: ${SHIM} --json\n`)
  }
})

test('sin ningun estado imprime un JSON valido con todo vacio', () => {
  const { code, stdout } = run(['--json'], { MEFISTO_STATE_DIR: missing('vacio-c'), MEFISTO_LEGACY_STATE_DIR: missing('vacio-l') })
  assert.equal(code, 0)
  assert.equal(
    stdout,
    ['{', '  "schemaVersion": 1,', '  "now": "2026-06-15 12:00:00",', '  "rows": [],', '  "history": [],', '  "empty": {', '    "status": true,', '    "history": true', '  }', '}', ''].join('\n'),
  )
})

test('la misma clave en los dos roots: gana el canonico', () => {
  const result = collect(fixture('dedup-canonical-wins', 'canonical'), fixture('dedup-canonical-wins', 'legacy'))
  assert.equal(rows(result, '100').length, 1)
  assert.equal(get(row(result, '100'), 'title'), 'canonical wins')
  assert.equal(get(row(result, '100'), 'origin'), 'canonical')
})

test('la salida conserva el orden de claves y la sangria', () => {
  const { stdout } = run(['--json'], {
    MEFISTO_STATE_DIR: fixture('dedup-canonical-wins', 'canonical'),
    MEFISTO_LEGACY_STATE_DIR: fixture('dedup-canonical-wins', 'legacy'),
  })
  const expected = {
    schemaVersion: 1,
    now: '2026-06-15 12:00:00',
    rows: [
      {
        pipeline: 'tooling',
        issue: '100',
        variant: null,
        title: 'canonical wins',
        runtime: 'claude',
        stage: '1-writer',
        state: 'running',
        started: '20260101-100000',
        updated: '20260101-100005',
        origin: 'canonical',
        log: null,
        pr: null,
        last_error: null,
        agents: { writer: { duration: null, result: 'running' }, reviewer: { duration: null, result: 'pending' } },
        activity: { kind: 'stale' },
        progress_pct: 25,
      },
    ],
    history: [],
    empty: { status: false, history: true },
  }
  assert.equal(stdout, `${JSON.stringify(expected, null, 2)}\n`)
})

test('status disjuntos: se conservan ambos con su origen', () => {
  const result = collect(fixture('dedup-disjoint', 'canonical'), fixture('dedup-disjoint', 'legacy'))
  assert.equal(get(row(result, '101'), 'origin'), 'canonical')
  assert.equal(get(row(result, '103'), 'origin'), 'legacy')
})

test('formato antiguo sin pipeline, variant ni runtime: pipeline inferido, el resto null', () => {
  const old = row(collect(missing('old'), fixture('old-format', 'legacy')), '55')
  assert.equal(get(old, 'pipeline'), 'tdd')
  assert.equal(get(old, 'variant'), null)
  assert.equal(get(old, 'runtime'), null)
  assert.equal(get(old, 'progress_pct'), null)
})

test('el pipeline se infiere del nombre del archivo', () => {
  const { canonical, legacy } = roots('inferido')
  write(join(legacy, 'tooling-status-1.json'), { issue: '1', state: 'running' })
  write(join(legacy, 'infra-status.json'), { issue: '2', state: 'running' })
  write(join(legacy, 'status.json'), { issue: '3', state: 'running' })
  write(join(legacy, 'tooling-history.jsonl'), '{"issue":"4","state":"completed"}\n')
  const result = collect(canonical, legacy)
  assert.deepEqual(
    ['1', '2', '3'].map((issue) => get(row(result, issue), 'pipeline')),
    ['tooling', 'infra', 'tdd'],
  )
  assert.equal(get(history(result, '4'), 'pipeline'), 'tooling')
})

test('con status modernos, los de nombre antiguo del mismo root no se leen', () => {
  const { canonical, legacy } = roots('modernos')
  write(join(canonical, 'pipeline-status-tdd-1.json'), { issue: '1', pipeline: 'tdd', state: 'running' })
  write(join(canonical, 'status-2.json'), { issue: '2', state: 'running' })
  const result = collect(canonical, legacy)
  assert.deepEqual(iterate(get(result, 'rows')).map((item) => get(item, 'issue')), ['1'])
})

test('hold estructurado: la actividad sale del propio status, con prioridad sobre stale', () => {
  const result = collect(fixture('hold-structured', 'canonical'), missing('hs-legacy'))
  assert.deepEqual(get(row(result, '200'), 'activity'), {
    kind: 'hold',
    cause: 'RATE_LIMIT',
    next_probe: '2026-01-01T00:10:00',
    ceiling: 21600,
  })
})

test('hold textual con una unica fila legacy running: causa traducida, sonda y techo del events.log', () => {
  const { canonical, legacy } = roots('hold-text-one')
  write(join(legacy, 'pipeline-status-tooling-300.json'), runningTooling('300'))
  write(
    join(legacy, 'events.log'),
    `=== SESSION TOOLING ${stamp(0)} issue:300 from-stage:1 ===\n[${hms(-60)}][hold] RATE_LIMIT: esperando, proxima sonda ${hms(120)} (techo 23:59)\n`,
  )
  assert.deepEqual(get(row(collect(canonical, legacy), '300'), 'activity'), {
    kind: 'hold',
    cause: 'limite de uso',
    next_probe: hms(120),
    ceiling: '23:59',
  })
})

test('hold textual: una causa desconocida sale tal cual y una sonda vencida no cuenta', () => {
  const { canonical, legacy } = roots('hold-text-otros')
  write(join(legacy, 'pipeline-status-tooling-300.json'), runningTooling('300'))
  write(join(legacy, 'events.log'), `[${hms(-60)}][hold] OTRA_COSA: esperando, proxima sonda ${hms(120)} (techo 23:59)\n`)
  assert.equal(path(row(collect(canonical, legacy), '300'), 'activity', 'cause'), 'OTRA_COSA')
  write(join(legacy, 'events.log'), `[${hms(-60)}][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda ${hms(120)} (techo 23:59)\n`)
  assert.equal(path(row(collect(canonical, legacy), '300'), 'activity', 'cause'), 'proveedor caido')
  write(join(legacy, 'events.log'), `[${hms(-600)}][hold] RATE_LIMIT: esperando, proxima sonda ${hms(-10)} (techo 23:59)\n`)
  assert.deepEqual(get(row(collect(canonical, legacy), '300'), 'activity'), { kind: 'stage' })
})

test('hold textual con dos filas legacy running: ambiguo, no se atribuye a ninguna', () => {
  const { canonical, legacy } = roots('hold-text-two')
  for (const issue of ['301', '302']) write(join(legacy, `pipeline-status-tooling-${issue}.json`), runningTooling(issue))
  write(join(legacy, 'events.log'), `[${hms(-60)}][hold] RATE_LIMIT: esperando, proxima sonda ${hms(120)} (techo 23:59)\n`)
  const result = collect(canonical, legacy)
  for (const issue of ['301', '302']) assert.deepEqual(get(row(result, issue), 'activity'), { kind: 'stage' })
})

test('stale: "updated" con mas de 35 minutos', () => {
  const { canonical } = roots('stale')
  write(join(canonical, 'pipeline-status-tooling-400.json'), runningTooling('400', { runtime: 'claude', updated: iso(-2400) }))
  write(join(canonical, 'pipeline-status-tooling-401.json'), runningTooling('401', { updated: iso(-2100) }))
  write(join(canonical, 'pipeline-status-tooling-402.json'), runningTooling('402', { updated: iso(-2101).replace('T', ' ') }))
  write(join(canonical, 'pipeline-status-tooling-403.json'), runningTooling('403', { updated: 'ayer' }))
  const result = collect(canonical, missing('stale-legacy'))
  assert.deepEqual(
    ['400', '401', '402', '403'].map((issue) => path(row(result, issue), 'activity', 'kind')),
    ['stale', 'stage', 'stale', 'stage'],
  )
})

test('una fila fallida no tiene actividad y una completada no sale', () => {
  const { canonical, legacy } = roots('terminales')
  write(join(canonical, 'pipeline-status-tooling-1.json'), runningTooling('1', { state: 'failed' }))
  write(join(canonical, 'pipeline-status-pr-sync-2.json'), { issue: '2', pipeline: 'pr-sync', state: 'completed' })
  const result = collect(canonical, legacy)
  assert.deepEqual(iterate(get(result, 'rows')).map((item) => get(item, 'issue')), ['1'])
  assert.equal(get(row(result, '1'), 'activity'), null)
})

test('historial sin "started": sigue visible, despues de las entradas fechadas', () => {
  const result = collect(fixture('history-mixed', 'canonical'), missing('hist-legacy'))
  const entries = iterate(get(result, 'history'))
  assert.deepEqual(entries.map((entry) => get(entry, 'issue')), ['10', '11'])
  assert.equal(get(entries[1] ?? null, 'started'), null)
  assert.equal(get(entries[0] ?? null, 'duration'), 300)
  assert.equal(get(entries[0] ?? null, 'detail'), 'PR #999')
  assert.deepEqual(Object.keys(entries[0] ?? {}), ['pipeline', 'issue', 'variant', 'runtime', 'result', 'duration', 'detail', 'pr', 'started', 'origin', 'log'])
})

test('el historial se recorta a las 5 corridas mas recientes', () => {
  const { canonical, legacy } = roots('recorte')
  const entry = (issue: number, hour: number): string =>
    JSON.stringify({ issue, pipeline: 'tdd', state: 'completed', started: `20260101-${pad2(hour)}0000`, tests: issue })
  write(join(canonical, 'pipeline-history.jsonl'), `${[1, 2, 3, 4].map((issue) => entry(issue, issue)).join('\n')}\n\n{ roto\n`)
  write(join(legacy, 'pipeline-history.jsonl'), `${[5, 6, 7].map((issue) => entry(issue, issue)).join('\n')}\n${entry(4, 4)}`)
  const entries = iterate(get(collect(canonical, legacy), 'history'))
  assert.deepEqual(entries.map((item) => get(item, 'issue')), [7, 6, 5, 4, 3])
  assert.deepEqual(entries.map((item) => get(item, 'origin')), ['legacy', 'legacy', 'legacy', 'canonical', 'canonical'])
  assert.equal(get(entries[0] ?? null, 'detail'), '7 tests')
})

test('reconstruye el log por stage cuando el status no declara uno', () => {
  const { canonical } = roots('log-reconstruct')
  cpSync(fixture('log-reconstruct', 'canonical'), canonical, { recursive: true })
  const log = join(canonical, 'logs', 'tooling-stage-2-reviewer-20260101-120000.log')
  touch(log)
  assert.equal(get(row(collect(canonical, missing('logrec-legacy')), '500'), 'log'), log)
})

test('es de solo lectura: ningun archivo de los roots cambia y no crea los ausentes', () => {
  const { canonical, legacy } = roots('readonly')
  cpSync(fixture('dedup-canonical-wins', 'canonical'), canonical, { recursive: true })
  cpSync(fixture('dedup-canonical-wins', 'legacy'), legacy, { recursive: true })
  cpSync(join(fixture('history-mixed', 'canonical'), 'pipeline-history.jsonl'), join(canonical, 'pipeline-history.jsonl'))
  const before = [checksum(canonical), checksum(legacy)]
  collect(canonical, legacy)
  assert.deepEqual([checksum(canonical), checksum(legacy)], before)
  collect(missing('ro-c'), missing('ro-l'))
  assert.equal(existsSync(missing('ro-c')), false)
  assert.equal(existsSync(missing('ro-l')), false)
})

test('issue como cadena o como numero es la misma clave; un pr numerico sale en detail', () => {
  const { canonical, legacy } = roots('issue-type')
  write(join(canonical, 'pipeline-status-tooling-7.json'), { issue: '7', pipeline: 'tooling', state: 'running', stage: '1-writer' })
  write(join(legacy, 'pipeline-status-tooling-7.json'), { issue: 7, pipeline: 'tooling', state: 'running', stage: '1-writer' })
  write(join(canonical, 'pipeline-history.jsonl'), {
    issue: 7,
    pipeline: 'tooling',
    state: 'completed',
    started: '20260101-100000',
    finished: '2026-01-01T10:05:00',
    pr: 42,
  })
  const result = collect(canonical, legacy)
  assert.equal(iterate(get(result, 'rows')).length, 1)
  assert.equal(get(row(result, '7'), 'origin'), 'canonical')
  assert.equal(get(history(result, 7), 'detail'), 'PR #42')
  assert.equal(get(history(result, 7), 'duration'), 300)
})

test('infra en curso: stage, progreso, hold y log con sufijo -issue-N o sin el', () => {
  const { canonical, legacy } = roots('infra')
  write(join(canonical, 'pipeline-status-infra-77.json'), {
    issue: '77',
    pipeline: 'infra',
    state: 'hold',
    stage: '1-infra-writer',
    started: '20260101-120000',
    runtime: 'claude',
    hold: { cause: 'rate_limit', next_probe: null, ceiling_seconds: 21600, accumulated_seconds: 0 },
  })
  const canonicalLog = join(canonical, 'logs', 'iac-stage-1-infra-writer-20260101-120000-issue-77.log')
  touch(canonicalLog)
  write(join(legacy, 'pipeline-status-infra-78.json'), { issue: '78', pipeline: 'infra', state: 'running', stage: '2-infra-reviewer', started: '20260101-110000' })
  const legacyLog = join(legacy, 'logs', 'iac-stage-2-infra-reviewer-20260101-110000.log')
  touch(legacyLog)
  const result = collect(canonical, legacy)
  const writer = row(result, '77')
  assert.equal(get(writer, 'origin'), 'canonical')
  assert.equal(get(writer, 'log'), canonicalLog)
  assert.equal(get(writer, 'progress_pct'), 30)
  assert.equal(get(writer, 'state'), 'hold')
  assert.equal(get(writer, 'stage'), '1-infra-writer')
  assert.deepEqual(get(writer, 'activity'), { kind: 'hold', cause: 'rate_limit', next_probe: null, ceiling: 21600 })
  assert.equal(get(row(result, '78'), 'origin'), 'legacy')
  assert.equal(get(row(result, '78'), 'log'), legacyLog)
  assert.equal(get(row(result, '78'), 'progress_pct'), 80)
})

test('progreso por pipeline y agente del stage', () => {
  const { canonical, legacy } = roots('progreso')
  const cases: [string, string, number | null][] = [
    ['tdd', '1-test-writer', 10],
    ['tdd', '1-projection-test-writer', 10],
    ['tdd', '2-implementer', 40],
    ['tdd', '2-projection-implementer', 40],
    ['tdd', '2b-smoke-test-writer', 55],
    ['tdd', '3-reviewer', 70],
    ['tdd', '4-coverage-gate', 90],
    ['tooling', '1-writer', 25],
    ['tooling', '2-reviewer', 70],
    ['infra', '1-infra-writer', 30],
    ['infra', '2-infra-reviewer', 80],
    ['tooling', '1-implementer', null],
    ['pr-sync', 'sync', null],
  ]
  cases.forEach(([pipeline, stage], index) =>
    write(join(canonical, `pipeline-status-${pipeline}-${index}.json`), { issue: index, pipeline, stage, state: 'running' }),
  )
  const result = collect(canonical, legacy)
  for (const [index, [, , expected]] of cases.entries()) assert.equal(get(row(result, index), 'progress_pct'), expected)
})

test('historial de una corrida terminada: pr, detail y log de la corrida', () => {
  const { canonical, legacy } = roots('h1730')
  const log = (root: string, name: string): string => join(root, 'logs', name)
  for (const name of ['iac-pipeline-20260101-100000.log', 'tooling-pipeline-20260101-110000-v2.log', 'run-12-20260101-120000.log', 'pipeline-20260101-120000.log']) {
    touch(log(canonical, name))
  }
  touch(log(legacy, 'pipeline-20260101-130000-v3.log'))
  const entries: Json[] = [
    { issue: 66, pipeline: 'infra', state: 'completed', started: '20260101-100000', finished: '2026-01-01T10:05:00', environment: 'dev', pr: 'https://github.com/o/r/pull/66' },
    { issue: 67, pipeline: 'tooling', variant: 'v2', state: 'completed', started: '20260101-110000', finished: '2026-01-01T11:05:00' },
    { issue: 68, pipeline: 'tdd', state: 'completed', started: '20260101-120000', finished: '2026-01-01T12:05:00', log: log(canonical, 'run-12-20260101-120000.log') },
    { issue: 69, pipeline: 'tdd', variant: 'v3', state: 'completed', started: '20260101-130000', finished: '2026-01-01T13:05:00' },
  ]
  write(join(canonical, 'pipeline-history.jsonl'), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  const result = collect(canonical, legacy)
  assert.equal(get(history(result, 66), 'pr'), 'https://github.com/o/r/pull/66')
  assert.equal(get(history(result, 66), 'detail'), 'env:dev, PR #66')
  assert.equal(get(history(result, 66), 'log'), log(canonical, 'iac-pipeline-20260101-100000.log'))
  assert.equal(get(history(result, 67), 'log'), log(canonical, 'tooling-pipeline-20260101-110000-v2.log'))
  assert.equal(get(history(result, 67), 'pr'), null)
  assert.equal(get(history(result, 68), 'log'), log(canonical, 'run-12-20260101-120000.log'))
  assert.equal(get(history(result, 69), 'log'), log(legacy, 'pipeline-20260101-130000-v3.log'))
})

test('un archivo o una linea ilegibles se omiten sin impedir la salida', () => {
  const { canonical, legacy } = roots('ilegibles')
  write(join(canonical, 'pipeline-status-tdd-1.json'), '{ roto')
  write(join(canonical, 'pipeline-status-tdd-2.json'), '[1, 2]\n')
  write(join(canonical, 'pipeline-status-tdd-3.json'), { issue: '3', pipeline: 'tdd', state: 'running', hold: 'texto' })
  write(join(canonical, 'pipeline-status-tdd-4.json'), { issue: '4', pipeline: 'tdd', state: 'running' })
  write(join(canonical, 'pipeline-history.jsonl'), '{ roto\n7\n{"issue":"5","pipeline":"tdd","state":"failed","environment":3}\n{"issue":"6","pipeline":"tdd","state":"failed"}\n')
  const result = collect(canonical, legacy)
  assert.deepEqual(iterate(get(result, 'rows')).map((item) => get(item, 'issue')), ['4'])
  assert.deepEqual(iterate(get(result, 'history')).map((item) => get(item, 'issue')), ['6'])
})

test('sin overrides, los roots cuelgan de la carpeta de trabajo', () => {
  const cwd = join(work, 'sin-overrides')
  mkdirSync(join(cwd, '.mefisto', 'pipeline'), { recursive: true })
  mkdirSync(join(cwd, '.claude', 'pipeline'), { recursive: true })
  write(join(cwd, '.mefisto', 'pipeline', 'pipeline-status-tdd-1.json'), { issue: '1', pipeline: 'tdd', state: 'running' })
  write(join(cwd, '.claude', 'pipeline', 'pipeline-status-tdd-2.json'), { issue: '2', pipeline: 'tdd', state: 'running' })
  const { code, stdout } = run(['--json'], {}, cwd)
  assert.equal(code, 0)
  const result = JSON.parse(stdout) as Json
  assert.deepEqual(iterate(get(result, 'rows')).map((item) => [get(item, 'issue'), get(item, 'origin')]), [['1', 'canonical'], ['2', 'legacy']])
})

test('parseEpoch lee los tres formatos de fecha como hora local', () => {
  const expected = Math.floor(new Date(2026, 0, 1, 10, 5, 0).getTime() / 1000)
  assert.equal(parseEpoch('2026-01-01T10:05:00'), expected)
  assert.equal(parseEpoch('20260101-100500'), expected)
  assert.equal(parseEpoch('2026-01-01 10:05:00'), expected)
  for (const stamp of ['', '2026-01-01', '2026-13-01T10:05:00', '2026-01-01T24:00:00', '20260101-1005', 'ayer']) {
    assert.equal(parseEpoch(stamp), null)
  }
})
