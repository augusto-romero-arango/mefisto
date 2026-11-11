import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture } from '../lib/cli.mts'
import { get, iterate, path } from '../lib/jq-values.mts'
import type { Json } from '../lib/jq-values.mts'
import { computeMetricsReport, run } from '../metrics-report.mts'

// Los numeros esperados se derivaron a mano sumando los campos de cada fixture.

// 2 tdd instrumentados (test-writer en sonnet, implementer y reviewer en opus, coverage-gate sin
// metrics), 1 tdd fallido con reviewer sin metrics, 1 tooling legado y 1 infra legado.
const MIXED = `{"issue":"100","title":"Tooling legado","pipeline":"tooling","started":"20260505-090000","finished":"2026-05-05T09:07:00","state":"completed","agents":{"writer":{"duration":250},"reviewer":{"duration":170}},"pr":"https://github.com/x/x/pull/100"}
{"issue":"300","title":"Infra legado","pipeline":"infra","started":"20260701-100000","finished":"2026-07-01T10:05:00","state":"completed","agents":{"infra-writer":{"duration":60},"infra-reviewer":{"duration":40}},"pr":"https://github.com/x/x/pull/300"}
{"issue":"200","title":"TDD instrumentado semana1","pipeline":"tdd","started":"20260806-090000","finished":"2026-08-06T09:20:00","state":"completed","agents":{"test-writer":{"duration":320,"metrics":{"turns":8,"duration_ms":320000,"duration_api_ms":250000,"non_api_ms":70000,"cost_usd":0.45,"tokens":{"input":12000,"output":1800,"cache_read":40000,"cache_creation":6000},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[{"name":"Read","count":10,"duration_ms_sum":8000,"duration_ms_median":700},{"name":"Bash","count":5,"duration_ms_sum":15000,"duration_ms_median":2500}]}},"implementer":{"duration":400,"metrics":{"turns":12,"duration_ms":400000,"duration_api_ms":300000,"non_api_ms":100000,"cost_usd":0.6,"tokens":{"input":15000,"output":2000,"cache_read":30000,"cache_creation":8000},"model":"claude-opus-5","agent":"implementer","tool_calls":[{"name":"Edit","count":6,"duration_ms_sum":6000,"duration_ms_median":900}]}},"reviewer":{"duration":220,"metrics":{"turns":5,"duration_ms":220000,"duration_api_ms":180000,"non_api_ms":40000,"cost_usd":0.30,"tokens":{"input":9000,"output":1200,"cache_read":30000,"cache_creation":4000},"model":"claude-opus-5","agent":"reviewer","tool_calls":[{"name":"Read","count":6,"duration_ms_sum":4000,"duration_ms_median":650}]}},"coverage-gate":{"duration":30,"result":"clean","gaps":0,"patch_applied":false}},"pr":"https://github.com/x/x/pull/200"}
{"issue":"210","title":"TDD instrumentado semana2","pipeline":"tdd","started":"20260813-090000","finished":"2026-08-13T09:20:00","state":"completed","agents":{"test-writer":{"duration":620,"metrics":{"turns":18,"duration_ms":620000,"duration_api_ms":450000,"non_api_ms":170000,"cost_usd":0.85,"tokens":{"input":22000,"output":2800,"cache_read":50000,"cache_creation":9000},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[{"name":"Read","count":14,"duration_ms_sum":11000,"duration_ms_median":700}]}},"implementer":{"duration":700,"metrics":{"turns":20,"duration_ms":700000,"duration_api_ms":500000,"non_api_ms":200000,"cost_usd":1.1,"tokens":{"input":25000,"output":3200,"cache_read":40000,"cache_creation":12000},"model":"claude-opus-5","agent":"implementer","tool_calls":[{"name":"Edit","count":10,"duration_ms_sum":9000,"duration_ms_median":800}]}},"reviewer":{"duration":260,"metrics":{"turns":7,"duration_ms":260000,"duration_api_ms":210000,"non_api_ms":50000,"cost_usd":0.35,"tokens":{"input":9500,"output":1300,"cache_read":31000,"cache_creation":4200},"model":"claude-opus-5","agent":"reviewer","tool_calls":[{"name":"Read","count":7,"duration_ms_sum":4500,"duration_ms_median":600}]}},"coverage-gate":{"duration":20,"result":"clean","gaps":0,"patch_applied":false}},"pr":"https://github.com/x/x/pull/210"}
{"issue":"220","title":"TDD fallido en reviewer","pipeline":"tdd","started":"20260814-110000","finished":"2026-08-14T11:20:00","state":"failed","stage":"reviewer","agents":{"test-writer":{"duration":300,"metrics":{"turns":9,"duration_ms":300000,"duration_api_ms":230000,"non_api_ms":70000,"cost_usd":0.4,"tokens":{"input":11000,"output":1600,"cache_read":38000,"cache_creation":5000},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[{"name":"Bash","count":4,"duration_ms_sum":11000,"duration_ms_median":2200}]}},"implementer":{"duration":null,"metrics":null},"reviewer":{"duration":null,"metrics":null},"coverage-gate":{"duration":null,"result":"n/a","gaps":0,"patch_applied":false}},"error":"timeout"}
`

const NULL_MEDIAN = `{"issue":"400","title":"Read sin mediana derivable","pipeline":"tdd","started":"20260806-090000","state":"completed","agents":{"test-writer":{"duration":100,"metrics":{"turns":3,"duration_ms":100000,"duration_api_ms":80000,"non_api_ms":20000,"cost_usd":0.1,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"model":"claude-sonnet-5","tool_calls":[{"name":"Read","count":10,"duration_ms_sum":8000,"duration_ms_median":null},{"name":"Bash","count":5,"duration_ms_sum":15000,"duration_ms_median":2500}]}},"reviewer":{"duration":null,"metrics":null}}}
`

// projection-test-writer corre bajo la clave "test-writer" y en el mismo modelo.
const READ_SIDE = `{"issue":"500","title":"TDD write-side","pipeline":"tdd","started":"20260806-090000","state":"completed","agents":{"test-writer":{"duration":300,"metrics":{"turns":20,"duration_ms":300000,"duration_api_ms":240000,"non_api_ms":60000,"cost_usd":0.4,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[]}}}}
{"issue":"510","title":"TDD read-side","pipeline":"tdd","started":"20260807-090000","state":"completed","agents":{"test-writer":{"duration":200,"metrics":{"turns":10,"duration_ms":200000,"duration_api_ms":160000,"non_api_ms":40000,"cost_usd":0.3,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"model":"claude-sonnet-5","agent":"projection-test-writer","tool_calls":[]}}}}
`

const NO_PIPELINE = `{"issue":"600","title":"Corrida sin campo pipeline","started":"20260806-090000","state":"completed","agents":{"writer":{"duration":120}}}
`

const MAIN_REPO = `{"issue":"700","title":"Corrida en el repo principal","pipeline":"tdd","started":"20260806-090000","state":"completed","agents":{"test-writer":{"duration":120}}}
`

// 0.9.0 y 0.25.0 son el par que un orden de cadenas invertiria.
const VERSIONS = `{"issue":"800","title":"TDD version 0.9.0 (a)","pipeline":"tdd","harness_version":"0.9.0","started":"20260806-090000","state":"completed","agents":{"test-writer":{"duration":100,"metrics":{"turns":10,"duration_ms":100000,"duration_api_ms":80000,"non_api_ms":20000,"cost_usd":0.5,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[]}}}}
{"issue":"810","title":"TDD version 0.9.0 (b)","pipeline":"tdd","harness_version":"0.9.0","started":"20260807-090000","state":"completed","agents":{"test-writer":{"duration":200,"metrics":{"turns":20,"duration_ms":200000,"duration_api_ms":150000,"non_api_ms":50000,"cost_usd":0.7,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[]}}}}
{"issue":"820","title":"TDD version 0.25.0","pipeline":"tdd","identity":{"harness_version":"0.25.0","harness_commit":"0123456789abcdef0123456789abcdef01234567","identity_state":"complete"},"started":"20260808-090000","state":"completed","agents":{"test-writer":{"duration":50,"metrics":{"turns":5,"duration_ms":50000,"duration_api_ms":30000,"non_api_ms":20000,"cost_usd":0.2,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[]}}}}
{"issue":"830","title":"TDD sin harness_version (historial previo a #660)","pipeline":"tdd","started":"20260809-090000","state":"completed","agents":{"test-writer":{"duration":150,"metrics":{"turns":12,"duration_ms":150000,"duration_api_ms":100000,"non_api_ms":50000,"cost_usd":0.3,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"model":"claude-sonnet-5","agent":"test-writer","tool_calls":[]}}}}
`

// 850 conserva un cero estimado real; 851 es legacy y su cero va aparte; en 852 el estimado gana
// a cost_usd y el reviewer no estima; 853 deja el estimado desconocido.
const COSTS = `{"issue":"850","pipeline":"tdd","started":"20260910-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":0,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}}}}
{"issue":"851","pipeline":"tdd","started":"20260911-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"cost_usd":0,"tokens":{"input":10,"output":2,"cache_read":3,"cache_creation":7},"turns":1,"duration_ms":10000,"duration_api_ms":9000,"tool_calls":[]}}}}
{"issue":"852","pipeline":"tdd","started":"20260912-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":2,"cost_usd":99,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":1,"metrics":{"estimated_cost_usd":null,"tokens":{"input":null,"output":null,"cache_read":null,"cache_write":null,"reasoning":null},"turns":null,"duration_ms":1000,"api_duration_ms":null,"tool_calls":[]}}}}
{"issue":"853","pipeline":"tdd","started":"20260917-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":null,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":null},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}}}}
`

const ONLY_CANONICAL = `{"issue":"899","pipeline":"tooling","variant":"solo-canonica","started":"20260901-080000","state":"completed","agents":{"writer":{"duration":10}}}
`

const CANONICAL = `{"issue":"900","pipeline":"tooling","variant":"canonica","started":"20260901-090000","state":"completed","runtime":"abierto","harness_commit":"abc","result":"resultado-neutral","prompt":"SECRETO_PROMPT","token":"SECRETO_TOKEN","tool_input":"SECRETO_INPUT","error":"SECRETO_ERROR","agents":{"writer":{"duration":10}}}
{"issue":"901","pipeline":"tooling","variant":"duplicada","started":"20260902-090000","state":"completed","runtime":"abierto","agents":{"writer":{"duration":10,"metrics":{"turns":7,"duration_ms":10000,"duration_api_ms":8000,"non_api_ms":2000,"cost_usd":0.1,"tokens":{"input":1,"output":1},"model":"modelo-abierto","tool_calls":[]}}}}
{"issue":"903","pipeline":"tdd","variant":"identica","started":"20260903-100000","state":"completed","agents":{"writer":{"duration":5}}}
{linea corrupta
`

const LEGACY = `{"issue":"902","pipeline":"infra","started":"20260903-090000","state":"completed","agents":{"writer":{"duration":10}}}
{"issue":"901","pipeline":"tooling","variant":"duplicada","started":"20260902-090000","state":"failed","agents":{"writer":{"duration":99}}}
{"issue":"901","pipeline":"tooling","variant":"otra","started":"20260902-090000","state":"completed","agents":{"writer":{"duration":10}}}
{"issue":"903","pipeline":"tdd","variant":"identica","started":"20260903-100000","state":"completed","agents":{"writer":{"duration":5}}}
`

let work = ''
let repo = ''

function git(cwd: string, ...args: string[]): void {
  const result = capture('git', ['-C', cwd, ...args])
  assert.equal(result.status, 0, result.stderr)
}

function newRepo(name: string): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  return dir
}

const legacyHistory = (): string => join(repo, '.claude', 'pipeline', 'pipeline-history.jsonl')
const canonicalHistory = (): string => join(repo, '.mefisto', 'pipeline', 'pipeline-history.jsonl')

function writeHistory(content: string, file = legacyHistory()): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

function clearHistory(): void {
  rmSync(join(repo, '.claude', 'pipeline'), { recursive: true, force: true })
  rmSync(join(repo, '.mefisto'), { recursive: true, force: true })
}

interface Outcome {
  code: number
  stdout: string
  stderr: string
}

function report(cwd: string, ...argv: string[]): Outcome {
  const [out, err]: [string[], string[]] = [[], []]
  const code = run(argv, { cwd, out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, stdout: out.join('\n'), stderr: err.join('\n') }
}

function aggregate(content: string, desde = '', hasta = ''): Json {
  const agg = computeMetricsReport(content, desde, hasta)
  assert.notEqual(agg, null)
  return agg
}

const where = (list: Json, key: string, value: Json): Json[] => iterate(list).filter((item) => get(item, key) === value)
const one = (list: Json, key: string, value: Json): Json => where(list, key, value)[0] ?? null
const tdd = (agg: Json, ...keys: string[]): Json => path(agg, 'pipelines', 'tdd', ...keys)
const lines = (text: string): string[] => text.split('\n')
const section = (text: string, from: string, to: string): string => {
  const all = lines(text)
  const start = all.findIndex((line) => line.includes(from))
  const end = all.findIndex((line, index) => index > start && line.includes(to))
  return all.slice(start, end === -1 ? undefined : end).join('\n')
}

before(() => {
  // git informa la raiz del repo por su ruta real.
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto metricas ')))
  repo = newRepo('fake consumer')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('historial vacio o inexistente', () => {
  test('vacio: sale con 0 y reporta 0 corridas', () => {
    writeHistory('')
    const { code, stdout } = report(repo)
    assert.equal(code, 0)
    assert.match(stdout, /Corridas totales en la ventana: 0/)
  })

  test('inexistente: sale con 0, reporta 0 corridas y no crea el directorio canonico', () => {
    clearHistory()
    const { code, stdout } = report(repo)
    assert.equal(code, 0)
    assert.match(stdout, /Corridas totales en la ventana: 0/)
    assert.equal(existsSync(join(repo, '.mefisto', 'pipeline')), false)
  })

  test('sin corridas no se renderiza ninguna seccion', () => {
    clearHistory()
    assert.deepEqual(lines(report(repo).stdout).slice(3), [
      'Filtro --desde: (sin limite inferior)  --hasta: (sin limite superior)',
      'Corridas totales en la ventana: 0',
      '',
      'Por pipeline:',
      '  infra        0 corridas (instrumentadas: 0, sin instrumentar: 0)',
      '  tdd          0 corridas (instrumentadas: 0, sin instrumentar: 0)',
      '  tooling      0 corridas (instrumentadas: 0, sin instrumentar: 0)',
      '',
      '(sin corridas registradas en la ventana solicitada)',
    ])
  })
})

test('dentro del repo de Mefisto aborta: el reporte es del consumidor', () => {
  const plugin = newRepo('fake-plugin')
  mkdirSync(join(plugin, '.claude-plugin'))
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"mefisto"}\n')
  const { code, stdout, stderr } = report(plugin)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    'ERROR: scripts/metrics-report.sh es del plugin publicado y solo aplica al consumidor.\n' +
      'Mefisto tiene su propio reporte interno: .claude/scripts/mefisto-metrics-report.sh',
  )
})

test('fuera de un repo git aborta', () => {
  const outside = mkdtempSync(join(tmpdir(), 'mefisto sin repo '))
  try {
    const { code, stderr } = report(outside)
    assert.equal(code, 1)
    assert.equal(stderr, 'ERROR: no estas en un repositorio git')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

describe('historial mixto multi-pipeline, agregado', () => {
  let agg: Json = null
  const stage = (name: string): Json => one(tdd(agg, 'wallclock', 'by_stage'), 'stage', name)

  before(() => {
    agg = aggregate(MIXED)
  })

  test('segmenta por pipeline', () => {
    assert.equal(tdd(agg, 'meta', 'total'), 3)
    assert.equal(tdd(agg, 'meta', 'instrumented'), 3)
    assert.equal(path(agg, 'pipelines', 'tooling', 'meta', 'total'), 1)
    assert.equal(path(agg, 'pipelines', 'tooling', 'meta', 'instrumented'), 0)
    assert.equal(path(agg, 'pipelines', 'infra', 'meta', 'total'), 1)
    assert.equal(path(agg, 'pipelines', 'infra', 'meta', 'instrumented'), 0)
  })

  test('ranking de herramientas de tdd', () => {
    // Read: 200 tw10+rv6, 210 tw14+rv7. Bash: 200 tw5, 220 tw4.
    assert.equal(get(one(tdd(agg, 'tool_ranking'), 'name', 'Read'), 'calls'), 37)
    assert.equal(get(one(tdd(agg, 'tool_ranking'), 'name', 'Bash'), 'calls'), 9)
  })

  test('el reparto API suma todas las claves presentes de cada corrida', () => {
    // 200: 250000+300000+180000; 210: 450000+500000+210000; 220: 230000.
    assert.equal(tdd(agg, 'wallclock', 'aggregate', 'api_ms'), 2120000)
  })

  test('coverage-gate queda fuera de la tabla por stage sin nombrarlo', () => {
    assert.equal(stage('coverage-gate'), null)
  })

  test('sonnet y opus no se mezclan en una fila', () => {
    assert.equal(get(stage('test-writer'), 'model'), 'claude-sonnet-5')
    assert.equal(get(stage('test-writer'), 'n'), 3)
    // (8 + 18 + 9) / 3
    assert.equal(get(stage('test-writer'), 'turns_mean'), 35 / 3)
    assert.equal(get(stage('reviewer'), 'model'), 'claude-opus-5')
    assert.equal(get(stage('reviewer'), 'n'), 2)
    assert.equal(where(tdd(agg, 'wallclock', 'by_stage'), 'stage', 'test-writer').length, 1)
    assert.equal(get(stage('test-writer'), 'agent'), 'test-writer')
  })

  test('tooling e infra legados se listan enteros como sin instrumentar', () => {
    assert.equal(path(agg, 'pipelines', 'tooling', 'legacy', 'count'), 1)
    assert.equal(get(iterate(path(agg, 'pipelines', 'tooling', 'legacy', 'issues'))[0] ?? null, 'issue'), '100')
    assert.equal(get(iterate(path(agg, 'pipelines', 'infra', 'legacy', 'issues'))[0] ?? null, 'issue'), '300')
    assert.equal(tdd(agg, 'legacy', 'count'), 0)
  })
})

describe('historial mixto multi-pipeline, texto renderizado', () => {
  let outcome: Outcome = { code: -1, stdout: '', stderr: '' }

  before(() => {
    clearHistory()
    writeHistory(MIXED)
    outcome = report(repo)
  })

  test('sale con 0 y trae las tres secciones', () => {
    assert.equal(outcome.code, 0)
    assert.equal(outcome.stderr, '')
    for (const name of ['tdd', 'tooling', 'infra']) assert.match(outcome.stdout, new RegExp(`^PIPELINE: ${name} `, 'm'))
  })

  test('tooling cae a SIN INSTRUMENTAR', () => {
    assert.match(section(outcome.stdout, 'PIPELINE: tooling', 'PIPELINE: infra'), /SIN INSTRUMENTAR \(n=1/)
  })

  test('la tabla por stage de tdd declara agente y modelo', () => {
    const text = section(outcome.stdout, 'PIPELINE: tdd', 'PIPELINE: tooling')
    assert.match(text, /test-writer +test-writer +claude-sonnet-5/)
    assert.match(text, /reviewer +reviewer +claude-opus-5/)
  })

  test('encabezado y lista por pipeline', () => {
    assert.deepEqual(lines(outcome.stdout).slice(0, 11), [
      '='.repeat(139),
      'Mefisto - Reporte agregado de metricas de pipelines del consumidor',
      '='.repeat(139),
      'Filtro --desde: (sin limite inferior)  --hasta: (sin limite superior)',
      'Corridas totales en la ventana: 5',
      'Rango: 20260505-090000 -> 20260814-110000',
      '',
      'Por pipeline:',
      '  infra        1 corridas (instrumentadas: 0, sin instrumentar: 1)',
      '  tdd          3 corridas (instrumentadas: 3, sin instrumentar: 0)',
      '  tooling      1 corridas (instrumentadas: 0, sin instrumentar: 1)',
    ])
  })

  // Fija columnas, anchos y redondeos de cada tabla de la seccion tdd.
  test('la seccion tdd conserva formato, columnas y redondeos', () => {
    const text = section(outcome.stdout, 'PIPELINE: tdd', 'PIPELINE: tooling')
    for (const line of [
      'PIPELINE: tdd (total=3, instrumentadas=3, sin instrumentar=0)',
      'Costo estimado con valor: 0 corridas (completas: 0, parciales: 0); sin estimacion: 3',
      'Costo reportado legado: 3 corridas (separado; excluido de estimados)',
      'RANKING DE HERRAMIENTAS (n=3 corridas instrumentadas)',
      'Herramienta          Llamadas   Tiempo total  Mediana/llamada   % tiempo',
      'Read                       37          27.5s             0.7s      40.1%',
      'Bash                        9          26.0s             2.4s      38.0%',
      'Edit                       16          15.0s             0.8s      21.9%',
      'REPARTO DEL WALL-CLOCK (n=3 corridas instrumentadas)',
      'Agregado: API 2120.0s (75.2%)  No-API 700.0s (24.8%)',
      '  De lo no-API, atribuible a tool calls: 68.5s (9.8% del no-API)',
      'Issue    Inicio            Estado          Wall      API   No-API    Tools    %API Costo est. Cobertura est. Costo leg.',
      '#200     20260806-090000   completed       970s   730.0s   210.0s    33.0s   77.7%          - sin estimacion       1.35',
      '#210     20260813-090000   completed      1600s  1160.0s   420.0s    24.5s   73.4%          - sin estimacion       2.30',
      '#220     20260814-110000   failed          300s   230.0s    70.0s    11.0s   76.7%          - sin estimacion       0.40',
      'Stage              Agente                 Modelo              n Turnos Duracion     API  No-API Costo est. Costo leg.',
      'implementer        implementer            claude-opus-5       2   16.0    9m10s   6m40s   2m30s          -       0.85',
      'reviewer           reviewer               claude-opus-5       2    6.0    4m00s   3m15s     45s          -       0.32',
      'test-writer        test-writer            claude-sonnet-5     3   11.7    6m53s   5m10s   1m43s          -       0.57',
      'Periodo    n(t/i)   WallMedia   WallP50  Turnos   Tools   Tok.in  Tok.out Cache.rd Cache.wr   Reason     %rd   n(est) Costo est. Costo leg.',
      '2026-W32   1/1         16m10s    16m10s    25.0    27.0    36.0k     5.0k   100.0k    18.0k        -   84.7%      0/1          -       1.35',
      '2026-W33   2/2         15m50s    15m50s    27.0    17.5    33.8k     4.5k    79.5k    15.1k        -   84.0%      0/2          -       1.35',
      '2026-08    3/3         15m57s    16m10s    26.3    20.7    34.5k     4.6k    86.3k    16.1k        -   84.3%      0/3          -       1.35',
      'Granularidad: semanal. Comparando 2026-W32 (n=1) vs 2026-W33 (n=2):',
      'Metrica                     Primero       Ultimo    Variacion',
      'Wall medio (corrida)         16m10s       15m50s        -2.1%',
      'Turnos medios                  25.0         27.0        +8.0%',
      'Tool calls medios              27.0         17.5       -35.2%',
      'Tokens in medios              36000        33750        -6.2%',
      'No-API medio                  3m30s        4m05s       +16.7%',
      'Costo estimado medio              -            -          n/d',
      'Version              n(t/i)    WallMedia  Turnos    %API   n(est) Costo est. Costo leg.',
      '(sin version)        3/3          15m57s    26.3   75.2%      0/3          -       1.35',
      'SIN INSTRUMENTAR (n=0 -- corridas de este pipeline sin agents.<stage>.metrics)',
      '(ninguna en la ventana)',
    ]) {
      assert.ok(lines(text).includes(line), `falta la linea: ${line}`)
    }
  })

  test('un pipeline legado lista sus corridas sin instrumentar', () => {
    const text = section(outcome.stdout, 'PIPELINE: tooling', 'PIPELINE: infra')
    assert.ok(lines(text).includes('(sin tool calls en corridas instrumentadas dentro de la ventana)'))
    assert.ok(lines(text).includes('(sin corridas instrumentadas en la ventana -- ver SIN INSTRUMENTAR)'))
    assert.ok(lines(text).includes('2026-W19   1/0          7m00s     7m00s       -       -        -        -        -        -        -       -      0/0          -          -'))
    assert.ok(lines(text).includes('#100      20260505-090000   completed'))
    assert.equal(lines(outcome.stdout).at(-1), '='.repeat(139))
  })
})

test('--desde y --hasta acotan la ventana', () => {
  clearHistory()
  writeHistory(MIXED)
  assert.match(report(repo, '--desde', '2026-08-01', '--hasta', '2026-08-10').stdout, /Corridas totales en la ventana: 1$/m)
  const equals = report(repo, '--desde=2026-08-07')
  assert.match(equals.stdout, /^Filtro --desde: 2026-08-07 {2}--hasta: \(sin limite superior\)$/m)
  assert.match(equals.stdout, /Corridas totales en la ventana: 2$/m)
})

describe('argumentos invalidos', () => {
  const failure = (...argv: string[]): string => {
    const { code, stdout, stderr } = report(repo, ...argv)
    assert.equal(code, 1)
    assert.equal(stdout, '')
    return stderr
  }

  test('fechas con formato invalido', () => {
    assert.equal(failure('--desde', '2026/08/01'), "ERROR: --desde espera formato YYYY-MM-DD (recibido: '2026/08/01')")
    assert.equal(failure('--hasta', '2026-08'), "ERROR: --hasta espera formato YYYY-MM-DD (recibido: '2026-08')")
  })

  test('--desde posterior a --hasta', () => {
    assert.equal(
      failure('--desde', '2026-08-01', '--hasta', '2026-01-01'),
      'ERROR: --desde (2026-08-01) es posterior a --hasta (2026-01-01)',
    )
  })

  test('bandera sin valor', () => {
    assert.equal(failure('--desde'), 'ERROR: --desde requiere un valor YYYY-MM-DD')
    assert.equal(failure('--hasta'), 'ERROR: --hasta requiere un valor YYYY-MM-DD')
  })

  test('argumento desconocido', () => {
    assert.equal(
      failure('--no-existe'),
      'ERROR: argumento desconocido: --no-existe (uso: --desde YYYY-MM-DD --hasta YYYY-MM-DD)',
    )
  })

  test('--help imprime el uso y sale con 0', () => {
    const { code, stdout } = report(repo, '--help')
    assert.equal(code, 0)
    assert.equal(lines(stdout)[0], 'Uso: metrics-report.sh [--desde YYYY-MM-DD] [--hasta YYYY-MM-DD]')
    assert.equal(lines(stdout).length, 8)
    assert.equal(report(repo, '-h').stdout, stdout)
  })
})

describe('comparacion entre periodos', () => {
  test('con dos semanas del mismo mes compara semanas', () => {
    const comparison = tdd(aggregate(MIXED, '2026-08-01', '2026-08-31'), 'comparison')
    assert.equal(get(comparison, 'granularity'), 'semanal')
    assert.equal(path(comparison, 'first', 'period'), '2026-W32')
    assert.equal(path(comparison, 'last', 'period'), '2026-W33')
  })

  test('con un solo periodo no hay comparacion', () => {
    assert.equal(tdd(aggregate(MIXED, '2026-08-06', '2026-08-06'), 'comparison'), null)
    clearHistory()
    writeHistory(MIXED)
    const { stdout } = report(repo, '--desde', '2026-08-06', '--hasta', '2026-08-06')
    assert.ok(lines(stdout).includes('(se necesitan al menos 2 periodos -- semanales o mensuales -- con corridas'))
    assert.ok(lines(stdout).includes(' instrumentadas dentro de la ventana para comparar; ajusta --desde/--hasta)'))
  })
})

test('una mediana nula sale como "-" en su columna, sin correr las siguientes', () => {
  clearHistory()
  writeHistory(NULL_MEDIAN)
  // Bash 15000 / 23000 = 65.2 %; Read 8000 / 23000 = 34.8 %.
  assert.match(report(repo).stdout, /^Read +10 +8\.0s +- +34\.8%$/m)
})

describe('misma clave de stage con agentes distintos', () => {
  test('cada agente tiene su fila y sus turnos', () => {
    const stages = tdd(aggregate(READ_SIDE), 'wallclock', 'by_stage')
    assert.equal(where(stages, 'stage', 'test-writer').length, 2)
    assert.equal(get(one(stages, 'agent', 'test-writer'), 'turns_mean'), 20)
    assert.equal(get(one(stages, 'agent', 'projection-test-writer'), 'turns_mean'), 10)
  })

  test('la fila read-side se renderiza con su agente', () => {
    clearHistory()
    writeHistory(READ_SIDE)
    assert.match(report(repo).stdout, /test-writer +projection-test-writer +claude-sonnet-5/)
  })
})

describe('linea sin "pipeline"', () => {
  test('cuenta en el total y cae en su propio cajon', () => {
    const agg = aggregate(NO_PIPELINE)
    assert.equal(path(agg, 'meta', 'total'), 1)
    assert.equal(path(agg, 'pipelines', '(sin-pipeline)', 'meta', 'total'), 1)
    assert.equal(get(iterate(path(agg, 'pipelines', '(sin-pipeline)', 'legacy', 'issues'))[0] ?? null, 'issue'), '600')
  })

  test('el cajon se renderiza como una seccion mas, despues de las fijas', () => {
    clearHistory()
    writeHistory(NO_PIPELINE)
    const sections = lines(report(repo).stdout).filter((line) => line.startsWith('PIPELINE: '))
    assert.deepEqual(
      sections.map((line) => line.split(' (total')[0]),
      ['PIPELINE: tdd', 'PIPELINE: tooling', 'PIPELINE: infra', 'PIPELINE: (sin-pipeline)'],
    )
  })
})

test('desde un worktree lee el historial del repo principal y lo declara', () => {
  clearHistory()
  writeHistory(MAIN_REPO)
  writeFileSync(join(repo, 'semilla.txt'), '')
  git(repo, 'add', 'semilla.txt')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'semilla')
  const worktree = join(work, 'fake-wt')
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'wt-test')
  try {
    const { code, stdout } = report(worktree)
    assert.equal(code, 0)
    assert.match(stdout, /Corridas totales en la ventana: 1$/m)
    assert.match(stdout, /^Nota: estas parado en un worktree; el historial se leyo del repo principal$/m)
    assert.match(stdout, /^ {6}\(.*pipeline-history\.jsonl\), que es donde lo escriben los pipelines\.$/m)
    assert.doesNotMatch(report(repo).stdout, /estas parado en un worktree/)
  } finally {
    git(repo, 'worktree', 'remove', '--force', worktree)
  }
})

describe('segmentacion por harness_version', () => {
  test('agrupa por version con sus propias medias', () => {
    const agg = aggregate(VERSIONS)
    const version = (name: string): Json => one(tdd(agg, 'by_version'), 'version', name)
    assert.equal(iterate(tdd(agg, 'by_version')).length, 3)
    assert.equal(get(version('0.9.0'), 'n_total'), 2)
    assert.equal(get(version('0.9.0'), 'n_instrumented'), 2)
    assert.equal(get(version('0.9.0'), 'turns_mean'), 15)
    assert.equal(get(version('0.9.0'), 'estimated_cost_usd_mean'), null)
    assert.equal(get(version('0.9.0'), 'wall_mean_instr_s'), 150)
    assert.equal(get(version('0.25.0'), 'n_total'), 1)
    assert.equal(get(version('0.25.0'), 'turns_mean'), 5)
    assert.equal(get(version('(sin version)'), 'n_total'), 1)
    assert.equal(get(version('(sin version)'), 'turns_mean'), 12)
    assert.deepEqual(
      iterate(tdd(agg, 'by_version')).map((item) => get(item, 'version')),
      ['0.9.0', '0.25.0', '(sin version)'],
    )
    assert.equal(tdd(agg, 'meta', 'total'), 4)
    assert.equal(tdd(agg, 'meta', 'instrumented'), 4)
  })

  test('renderiza una fila por version con su wall medio', () => {
    clearHistory()
    writeHistory(VERSIONS)
    const { code, stdout } = report(repo)
    assert.equal(code, 0)
    const start = lines(stdout).findIndex((line) => line.startsWith('POR VERSION DE HARNESS'))
    assert.deepEqual(lines(stdout).slice(start + 6, start + 10), [
      'Version              n(t/i)    WallMedia  Turnos    %API   n(est) Costo est. Costo leg.',
      '0.9.0                2/2           2m30s    15.0   76.7%      0/2          -       0.60',
      '0.25.0               1/1             50s     5.0   60.0%      0/1          -       0.20',
      '(sin version)        1/1           2m30s    12.0   66.7%      0/1          -       0.30',
    ])
  })
})

describe('costos estimados y legados, tokens neutrales', () => {
  test('el estimado y el legado no se mezclan', () => {
    const agg = aggregate(COSTS)
    const writer = one(tdd(agg, 'wallclock', 'by_stage'), 'stage', 'writer')
    const september = one(tdd(agg, 'series', 'monthly'), 'period', '2026-09')
    const perRun = (issue: string): Json => one(tdd(agg, 'wallclock', 'per_run'), 'issue', issue)
    const costDelta = one(tdd(agg, 'comparison', 'deltas'), 'key', 'estimated_cost_usd_mean')
    assert.equal(get(writer, 'estimated_cost_usd_total'), 2)
    assert.equal(get(writer, 'legacy_reported_cost_usd_total'), 0)
    assert.equal(tdd(agg, 'meta', 'estimated_cost_runs'), 2)
    assert.equal(tdd(agg, 'meta', 'estimated_cost_missing_runs'), 2)
    assert.equal(get(september, 'cache_write_mean'), 4.75)
    assert.equal(get(september, 'reasoning_mean'), 5)
    assert.equal(get(perRun('850'), 'estimated_cost_usd'), 0)
    assert.equal(get(perRun('851'), 'legacy_reported_cost_usd'), 0)
    assert.equal(get(perRun('852'), 'legacy_reported_cost_usd'), null)
    assert.equal(get(perRun('852'), 'estimated_cost_status'), 'parcial')
    assert.equal(tdd(agg, 'meta', 'instrumented'), 4)
    assert.equal(get(september, 'tokens_input_mean'), 10)
    assert.equal(get(september, 'wall_mean_s'), 10.25)
    assert.deepEqual([get(costDelta, 'last'), get(costDelta, 'pct')], [null, null])
  })

  test('resumen y detalle separan estimacion, legado y parcialidad', () => {
    clearHistory()
    writeHistory(COSTS)
    const { stdout } = report(repo)
    assert.match(stdout, /^Costo estimado con valor: 2 corridas \(completas: 1, parciales: 1\); sin estimacion: 2$/m)
    assert.match(stdout, /^Costo reportado legado: 1 corridas \(separado; excluido de estimados\)$/m)
    assert.match(stdout, /Cache\.wr/)
    assert.match(stdout, /Reason/)
    assert.match(stdout, /^Costo estimado medio +1\.00 +- +n\/d$/m)
    assert.ok(lines(stdout).includes('#852     20260912-090000   completed        11s     9.0s     1.0s     0.0s   90.0%       2.00 parcial                 -'))
    assert.ok(lines(stdout).includes('2026-09    4/4            10s       10s     1.0     0.0       10        2        3        5        5   38.7%      2/4       1.00       0.00'))
  })
})

describe('fuentes canonica y legacy', () => {
  test('con solo la canonica se agrega', () => {
    clearHistory()
    writeHistory(ONLY_CANONICAL, canonicalHistory())
    const { code, stdout } = report(repo)
    assert.equal(code, 0)
    assert.match(stdout, /Corridas totales en la ventana: 1$/m)
  })

  test('se combinan y un duplicado prefiere la entrada canonica', () => {
    const agg = aggregate(`${CANONICAL}\n${LEGACY}\n`)
    const tooling = (...keys: string[]): Json => path(agg, 'pipelines', 'tooling', ...keys)
    assert.equal(path(agg, 'meta', 'total'), 5)
    assert.equal(get(one(tooling('wallclock', 'per_run'), 'issue', '901'), 'state'), 'completed')
    assert.equal(tooling('meta', 'total'), 3)
    assert.equal(tdd(agg, 'meta', 'total'), 1)
  })

  test('de punta a punta combina las dos rutas, no las modifica y no expone campos ajenos', () => {
    clearHistory()
    writeHistory(CANONICAL, canonicalHistory())
    writeHistory(LEGACY)
    const { code, stdout } = report(repo, '--desde', '2026-09-01', '--hasta', '2026-09-03')
    assert.equal(code, 0)
    assert.match(stdout, /Corridas totales en la ventana: 5$/m)
    assert.equal(readFileSync(canonicalHistory(), 'utf8'), CANONICAL)
    assert.equal(readFileSync(legacyHistory(), 'utf8'), LEGACY)
    assert.doesNotMatch(stdout, /SECRETO_(PROMPT|TOKEN|INPUT|ERROR)|resultado-neutral|abc/)
  })

  test('un historial sin salto final no pega su ultima linea con la del siguiente', () => {
    clearHistory()
    writeHistory(CANONICAL.trimEnd(), canonicalHistory())
    writeHistory(LEGACY.trimEnd())
    assert.match(report(repo).stdout, /Corridas totales en la ventana: 5$/m)
  })
})

// La identidad es aditiva: el historial previo convive con el nuevo sin migrarse.
test('agrega un historial que mezcla lineas legadas, con version plana y con identity', () => {
  clearHistory()
  writeHistory(
    [
      '{"issue":"1","title":"linea legada sin el campo","pipeline":"tooling","started":"20260101-100000","finished":"2026-01-01T10:10:00","state":"completed","agents":{"writer":{"duration":600},"reviewer":{"duration":300}},"tests":null,"pr":"http://x/1"}',
      '{"issue":"2","title":"linea nueva con identidad","pipeline":"tooling","identity":{"harness_version":"0.25.0","harness_commit":"0123456789abcdef0123456789abcdef01234567","identity_state":"complete"},"started":"20260102-100000","finished":"2026-01-02T10:10:00","state":"completed","agents":{"writer":{"duration":600},"reviewer":{"duration":300}},"tests":null,"pr":"http://x/2"}',
      '{"issue":"3","title":"aborto con el campo en null","pipeline":"tdd","harness_version":null,"started":"20260103-100000","finished":"2026-01-03T10:10:00","state":"failed","stage":"test-writer","error":"algo"}',
      '',
    ].join('\n'),
  )
  const { code, stdout } = report(repo)
  assert.equal(code, 0)
  assert.match(stdout, /Corridas totales en la ventana: 3$/m)
  assert.match(stdout, /^0\.25\.0 +1\/0 /m)
})

describe('historial con tipos inesperados', () => {
  test('un tipo con el que no se puede operar hace fallar el reporte entero', () => {
    const broken = '{"issue":"1","pipeline":"tdd","started":"20260806-090000","agents":{"writer":{"duration":"lento"},"reviewer":{"duration":5}}}\n'
    assert.equal(computeMetricsReport(broken, '', ''), null)
    clearHistory()
    writeHistory(broken)
    const { code, stdout, stderr } = report(repo)
    assert.equal(code, 1)
    assert.equal(stdout, '')
    // La ruta sale de la raiz que informa git, que en Windows puede venir con otra grafia.
    assert.match(stderr, /^ERROR: no se pudo procesar el historial \(.*pipeline-history\.jsonl\)$/)
  })

  test('lineas corruptas y valores que no son objetos se ignoran', () => {
    const agg = aggregate(`{ roto\n\n[1,2]\n"texto"\n7\n${NO_PIPELINE}`)
    assert.equal(path(agg, 'meta', 'total'), 1)
  })
})
