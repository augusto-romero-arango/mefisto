import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture } from '../../../scripts/lib/cli.mts'
import { get, iterate, path } from '../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../scripts/lib/jq-values.mts'
import { computeMetricsReport, run } from '../../../src/internal/scripts/mefisto-metrics-report.mts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// Los numeros esperados se derivaron a mano sumando los campos de cada fixture.

// 2 legado sin metrics, 4 completed instrumentados y 1 failed con metrics de writer pero no de
// reviewer, mas una linea vacia y una corrupta.
const MIXED = `{"issue":"100","title":"Legacy issue mayo","pipeline":"mefisto-tooling","started":"20260505-090000","finished":"2026-05-05T09:07:00","state":"completed","agents":{"writer":{"duration":250},"reviewer":{"duration":170}},"pr":"https://github.com/x/x/pull/100"}

{ esto no es json valido, deberia ignorarse sin abortar
{"issue":"101","title":"Legacy issue junio","pipeline":"mefisto-tooling","started":"20260610-090000","finished":"2026-06-10T09:10:00","state":"completed","agents":{"writer":{"duration":330},"reviewer":{"duration":270}},"pr":"https://github.com/x/x/pull/101"}
{"issue":"200","title":"Nuevo instrumentado semana1","pipeline":"mefisto-tooling","started":"20260706-090000","finished":"2026-07-06T09:12:00","state":"completed","agents":{"writer":{"duration":320,"metrics":{"turns":8,"duration_ms":320000,"duration_api_ms":250000,"non_api_ms":70000,"cost_usd":0.45,"tokens":{"input":12000,"output":1800,"cache_read":40000,"cache_creation":6000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1200,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":10,"duration_ms_sum":8000,"duration_ms_median":700},{"name":"Bash","count":5,"duration_ms_sum":15000,"duration_ms_median":2500},{"name":"Edit","count":6,"duration_ms_sum":6000,"duration_ms_median":900}]}},"reviewer":{"duration":220,"metrics":{"turns":5,"duration_ms":220000,"duration_api_ms":180000,"non_api_ms":40000,"cost_usd":0.30,"tokens":{"input":9000,"output":1200,"cache_read":30000,"cache_creation":4000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1100,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":6,"duration_ms_sum":4000,"duration_ms_median":650},{"name":"Bash","count":3,"duration_ms_sum":9000,"duration_ms_median":3000}]}}},"pr":"https://github.com/x/x/pull/200"}
{"issue":"201","title":"Nuevo instrumentado semana1b","pipeline":"mefisto-tooling","started":"20260707-100000","finished":"2026-07-07T10:15:00","state":"completed","agents":{"writer":{"duration":300,"metrics":{"turns":7,"duration_ms":300000,"duration_api_ms":230000,"non_api_ms":70000,"cost_usd":0.40,"tokens":{"input":11000,"output":1600,"cache_read":38000,"cache_creation":5000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1300,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":9,"duration_ms_sum":7000,"duration_ms_median":600},{"name":"Bash","count":4,"duration_ms_sum":11000,"duration_ms_median":2200}]}},"reviewer":{"duration":210,"metrics":{"turns":4,"duration_ms":210000,"duration_api_ms":170000,"non_api_ms":40000,"cost_usd":0.28,"tokens":{"input":8500,"output":1100,"cache_read":28000,"cache_creation":3500},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1050,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Edit","count":5,"duration_ms_sum":5000,"duration_ms_median":800}]}}},"pr":"https://github.com/x/x/pull/201"}
{"issue":"210","title":"Nuevo instrumentado semana2 mas lento","pipeline":"mefisto-tooling","started":"20260720-090000","finished":"2026-07-20T09:34:00","state":"completed","agents":{"writer":{"duration":900,"metrics":{"turns":22,"duration_ms":900000,"duration_api_ms":650000,"non_api_ms":250000,"cost_usd":1.1,"tokens":{"input":45000,"output":5200,"cache_read":60000,"cache_creation":40000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":2100,"permission_denials":1,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":30,"duration_ms_sum":24000,"duration_ms_median":650},{"name":"Bash","count":18,"duration_ms_sum":70000,"duration_ms_median":3500},{"name":"Edit","count":12,"duration_ms_sum":18000,"duration_ms_median":1200}]}},"reviewer":{"duration":480,"metrics":{"turns":10,"duration_ms":480000,"duration_api_ms":380000,"non_api_ms":100000,"cost_usd":0.6,"tokens":{"input":20000,"output":2500,"cache_read":35000,"cache_creation":15000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1500,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":14,"duration_ms_sum":11000,"duration_ms_median":700},{"name":"Bash","count":6,"duration_ms_sum":21000,"duration_ms_median":3000}]}}},"pr":"https://github.com/x/x/pull/210"}
{"issue":"215","title":"Fallido en reviewer","pipeline":"mefisto-tooling","started":"20260722-110000","finished":"2026-07-22T11:20:00","state":"failed","stage":"reviewer","agents":{"writer":{"duration":400,"metrics":{"turns":9,"duration_ms":400000,"duration_api_ms":300000,"non_api_ms":100000,"cost_usd":0.5,"tokens":{"input":15000,"output":2000,"cache_read":30000,"cache_creation":8000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1400,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Bash","count":7,"duration_ms_sum":20000,"duration_ms_median":2800}]}},"reviewer":{"duration":null,"metrics":null}},"error":"timeout"}
{"issue":"230","title":"Nuevo instrumentado agosto mucho mas lento","pipeline":"mefisto-tooling","started":"20260803-090000","finished":"2026-08-03T09:37:00","state":"completed","agents":{"writer":{"duration":1400,"metrics":{"turns":30,"duration_ms":1400000,"duration_api_ms":900000,"non_api_ms":500000,"cost_usd":1.8,"tokens":{"input":60000,"output":7000,"cache_read":50000,"cache_creation":70000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":2500,"permission_denials":2,"rate_limit_events":1,"tool_calls":[{"name":"Read","count":40,"duration_ms_sum":32000,"duration_ms_median":700},{"name":"Bash","count":25,"duration_ms_sum":100000,"duration_ms_median":3800},{"name":"Edit","count":15,"duration_ms_sum":25000,"duration_ms_median":1300}]}},"reviewer":{"duration":700,"metrics":{"turns":14,"duration_ms":700000,"duration_api_ms":500000,"non_api_ms":200000,"cost_usd":0.9,"tokens":{"input":28000,"output":3500,"cache_read":25000,"cache_creation":30000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1800,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":18,"duration_ms_sum":14000,"duration_ms_median":720},{"name":"Bash","count":10,"duration_ms_sum":35000,"duration_ms_median":3400}]}}},"pr":"https://github.com/x/x/pull/230"}
`

// Salida completa del reporte sobre MIXED: fija textos, columnas, anchos y redondeos (los empates
// van al digito par: 8.25 sale 8.2 y 33.75 sale 33.8).
const MIXED_REPORT = `========================================================================================================================
Mefisto - Reporte agregado de metricas del pipeline interno
========================================================================================================================
Filtro --desde: (todo el historico)
Corridas mefisto-tooling en la ventana: 7 (instrumentadas: 5, sin instrumentar: 2)
Costo estimado con valor: 0 corridas (completas: 0, parciales: 0); sin estimacion: 5
Costo reportado legado: 5 corridas (separado; excluido de estimados)
Rango: 20260505-090000 -> 20260803-090000

------------------------------------------------------------------------------------------------------------------------
RANKING DE HERRAMIENTAS (n=5 corridas instrumentadas)
------------------------------------------------------------------------------------------------------------------------
Herramienta          Llamadas   Tiempo total  Mediana/llamada   % tiempo
Bash                       78         281.0s             3.0s      64.6%
Read                      127         100.0s             0.7s      23.0%
Edit                       38          54.0s             1.1s      12.4%

Nota: 'Mediana/llamada' es la mediana de las medianas por corrida (el
      historial guarda por stage solo suma+mediana, no cada llamada);
      leela como orden de magnitud, no como percentil exacto.

------------------------------------------------------------------------------------------------------------------------
REPARTO DEL WALL-CLOCK (n=5 corridas instrumentadas)
------------------------------------------------------------------------------------------------------------------------
Agregado: API 3560.0s (72.2%)  No-API 1370.0s (27.8%)
  De lo no-API, atribuible a tool calls: 435.0s (31.8% del no-API)
  (las tool calls en paralelo se suman por separado, asi que ese % puede pasar de 100)

Por corrida:
Issue    Inicio            Estado          Wall      API   No-API    Tools    %API Costo est. Cobertura est. Costo leg.       SHA
#200     20260706-090000   completed       540s   430.0s   110.0s    42.0s   79.6%          - sin estimacion       0.75         -
#201     20260707-100000   completed       510s   400.0s   110.0s    23.0s   78.4%          - sin estimacion       0.68         -
#210     20260720-090000   completed      1380s  1030.0s   350.0s   144.0s   74.6%          - sin estimacion       1.70         -
#215     20260722-110000   failed          400s   300.0s   100.0s    20.0s   75.0%          - sin estimacion       0.50         -
#230     20260803-090000   completed      2100s  1400.0s   700.0s   206.0s   66.7%          - sin estimacion       2.70         -

Writer vs Reviewer:
                                 Writer       Reviewer
Corridas (n)                          5              4
Turnos medios                      15.2            8.2
Tokens in medios                  28600          16375
Tokens out medios                  3520           2075
Cache read medio                  43600          29500
Cache write medio                 25800          13125
Reasoning medio                       -              -
Costo estimado medio                  -              -
Costo estimado total                  -              -
Costo legado reportado             0.85           0.52
Costo legado total                 4.25           2.08
Duracion media                   11m04s          6m42s
  de la cual API                  7m46s          5m08s
  de la cual no-API               3m18s          1m35s

------------------------------------------------------------------------------------------------------------------------
DERIVA TEMPORAL - SEMANAL
------------------------------------------------------------------------------------------------------------------------
n(t/i) = corridas totales / de ellas instrumentadas. El wall usa las
totales; turnos, tools y tokens solo las instrumentadas.

Periodo    n(t/i)   WallMedia   WallP50  Turnos   Tools   Tok.in  Tok.out Cache.rd Cache.wr   Reason     %rd   n(est) Costo est. Costo leg.
2026-W19   1/0          7m00s     7m00s       -       -        -        -        -        -        -       -      0/0          -          -
2026-W24   1/0         10m00s    10m00s       -       -        -        -        -        -        -       -      0/0          -          -
2026-W28   2/2          8m45s     8m45s    12.0    24.0    20.2k     2.9k    68.0k     9.2k        -   88.0%      0/2          -       0.72
2026-W30   2/2         14m50s    14m50s    20.5    43.5    40.0k     4.8k    62.5k    31.5k        -   66.5%      0/2          -       1.10
2026-W32   1/1         35m00s    35m00s    44.0   108.0    88.0k    10.5k    75.0k   100.0k        -   42.9%      0/1          -       2.70

%rd = cache_read / (cache_read + cache_write): cae cuando el contexto
      deja de acertar en cache.

------------------------------------------------------------------------------------------------------------------------
DERIVA TEMPORAL - MENSUAL
------------------------------------------------------------------------------------------------------------------------
n(t/i) = corridas totales / de ellas instrumentadas. El wall usa las
totales; turnos, tools y tokens solo las instrumentadas.

Periodo    n(t/i)   WallMedia   WallP50  Turnos   Tools   Tok.in  Tok.out Cache.rd Cache.wr   Reason     %rd   n(est) Costo est. Costo leg.
2026-05    1/0          7m00s     7m00s       -       -        -        -        -        -        -       -      0/0          -          -
2026-06    1/0         10m00s    10m00s       -       -        -        -        -        -        -       -      0/0          -          -
2026-07    4/4         11m48s     8m45s    16.2    33.8    30.1k     3.9k    65.2k    20.4k        -   76.2%      0/4          -       0.91
2026-08    1/1         35m00s    35m00s    44.0   108.0    88.0k    10.5k    75.0k   100.0k        -   42.9%      0/1          -       2.70

%rd = cache_read / (cache_read + cache_write): cae cuando el contexto
      deja de acertar en cache.

------------------------------------------------------------------------------------------------------------------------
RESUMEN: QUE CRECIO (primer vs ultimo mes con corridas instrumentadas)
------------------------------------------------------------------------------------------------------------------------
Comparando 2026-07 (n=4; costo estimado=0/4) vs 2026-08 (n=1; costo estimado=0/1):
Todas las filas, el wall incluido, se calculan solo sobre esas corridas
instrumentadas -- si no compartieran denominador la atribucion no valdria.

Metrica                     Primero       Ultimo    Variacion
Wall medio (issue)           11m48s       35m00s      +196.8%
Turnos medios                  16.2         44.0      +170.8%
Tool calls medios              33.8        108.0      +220.0%
Tokens in medios              30125        88000      +192.1%
No-API medio                  2m48s       11m40s      +317.9%
Costo estimado medio              -            -          n/d

------------------------------------------------------------------------------------------------------------------------
POR VERSION DE HARNESS (n = corridas totales/instrumentadas de esa version)
------------------------------------------------------------------------------------------------------------------------
n(t/i) = corridas totales / de ellas instrumentadas. A diferencia de la
deriva temporal, aqui TODAS las cifras -- el wall incluido -- salen solo
de las instrumentadas: comparar dos versiones exige el mismo denominador.

Version              n(t/i)    WallMedia  Turnos    %API Costo est.
(sin version)        7/5          16m26s    21.8   72.2%          -

------------------------------------------------------------------------------------------------------------------------
POR RUNTIME (n = corridas totales/instrumentadas de ese runtime)
------------------------------------------------------------------------------------------------------------------------
n(t/i) = corridas totales / de ellas instrumentadas. Mismo criterio que POR
VERSION DE HARNESS: todas las cifras -- el wall incluido -- salen solo de las
instrumentadas.

Runtime              n(t/i)    WallMedia  Turnos    %API Costo est.
(sin runtime)        7/5          16m26s    21.8   72.2%          -

------------------------------------------------------------------------------------------------------------------------
SIN INSTRUMENTAR (n=2 -- corridas previas a #426, solo duracion total)
------------------------------------------------------------------------------------------------------------------------
#100      20260505-090000   completed
#101      20260610-090000   completed

========================================================================================================================
`

const NULL_MEDIAN = `{"issue":"300","title":"Read sin mediana derivable","pipeline":"mefisto-tooling","started":"20260706-090000","state":"completed","agents":{"writer":{"duration":100,"metrics":{"turns":3,"duration_ms":100000,"duration_api_ms":80000,"non_api_ms":20000,"cost_usd":0.1,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[{"name":"Read","count":10,"duration_ms_sum":8000,"duration_ms_median":null},{"name":"Bash","count":5,"duration_ms_sum":15000,"duration_ms_median":2500}]}},"reviewer":{"duration":null,"metrics":null}}}
`

const NO_STARTED = `{"issue":"301","title":"Sin started","pipeline":"mefisto-tooling","state":"completed","agents":{"writer":{"duration":100},"reviewer":{"duration":50}}}
`

// Julio trae una corrida legado ademas de la instrumentada.
const SHARED_DENOMINATOR = `{"issue":"400","title":"Legado rapido dentro de julio","pipeline":"mefisto-tooling","started":"20260705-080000","state":"completed","agents":{"writer":{"duration":40},"reviewer":{"duration":20}}}
{"issue":"401","title":"Instrumentado julio","pipeline":"mefisto-tooling","started":"20260706-090000","state":"completed","agents":{"writer":{"duration":600,"metrics":{"turns":10,"duration_ms":600000,"duration_api_ms":500000,"non_api_ms":100000,"cost_usd":0.5,"tokens":{"input":10000,"output":1000,"cache_read":9000,"cache_creation":1000},"tool_calls":[{"name":"Read","count":5,"duration_ms_sum":5000,"duration_ms_median":1000}]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"402","title":"Instrumentado agosto","pipeline":"mefisto-tooling","started":"20260803-090000","state":"completed","agents":{"writer":{"duration":1200,"metrics":{"turns":20,"duration_ms":1200000,"duration_api_ms":900000,"non_api_ms":300000,"cost_usd":1.0,"tokens":{"input":20000,"output":2000,"cache_read":10000,"cache_creation":10000},"tool_calls":[{"name":"Read","count":10,"duration_ms_sum":10000,"duration_ms_median":1000}]}},"reviewer":{"duration":null,"metrics":null}}}
`

// 900 y 910 en 0.9.0 (solo 900 con sha), 920 sin version y con sha, 930 sin ninguno.
const VERSIONS = `{"issue":"900","title":"Con version y sha","pipeline":"mefisto-tooling","harness_version":"0.9.0","harness_sha":"aaa1111","started":"20260810-090000","state":"completed","agents":{"writer":{"duration":100,"metrics":{"turns":10,"duration_ms":100000,"duration_api_ms":80000,"non_api_ms":20000,"cost_usd":0.5,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"910","title":"Con version, sin sha","pipeline":"mefisto-tooling","harness_version":"0.9.0","started":"20260811-090000","state":"completed","agents":{"writer":{"duration":200,"metrics":{"turns":20,"duration_ms":200000,"duration_api_ms":150000,"non_api_ms":50000,"cost_usd":0.7,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"920","title":"Sin version, con sha","pipeline":"mefisto-tooling","harness_sha":"ccc3333","started":"20260812-090000","state":"completed","agents":{"writer":{"duration":50,"metrics":{"turns":5,"duration_ms":50000,"duration_api_ms":30000,"non_api_ms":20000,"cost_usd":0.2,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"930","title":"Sin version ni sha (historial previo a #662)","pipeline":"mefisto-tooling","started":"20260813-090000","state":"completed","agents":{"writer":{"duration":150,"metrics":{"turns":12,"duration_ms":150000,"duration_api_ms":100000,"non_api_ms":50000,"cost_usd":0.3,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
`

// 600 forma vieja sin runtime de corrida; 601 forma neutral con runtime; 602 de otro runtime, con
// costo 0 real y turnos null; 603 sin instrumentar.
const RUNTIMES = `{"issue":"600","title":"Forma vieja sin runtime","pipeline":"mefisto-tooling","started":"20260901-090000","state":"completed","agents":{"writer":{"duration":250,"metrics":{"turns":6,"duration_ms":200000,"duration_api_ms":150000,"non_api_ms":50000,"estimated_cost_usd":0.35,"tokens":{"input":5000,"output":700,"cache_read":4000,"cache_creation":500},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"tool_calls":[{"name":"Read","count":4,"duration_ms_sum":3000,"duration_ms_median":700}]}},"reviewer":{"duration":130,"metrics":{"turns":3,"duration_ms":100000,"duration_api_ms":70000,"non_api_ms":30000,"estimated_cost_usd":0.15,"tokens":{"input":2000,"output":300,"cache_read":1500,"cache_creation":200},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"tool_calls":[{"name":"Bash","count":2,"duration_ms_sum":4000,"duration_ms_median":2000}]}}}}
{"issue":"601","title":"Forma neutral Claude con runtime","pipeline":"mefisto-tooling","runtime":"claude","started":"20260902-090000","state":"completed","agents":{"writer":{"duration":310,"metrics":{"runtime":"claude","status":"success","error_kind":null,"model":"claude-sonnet-5","estimated_cost_usd":0.5,"tokens":{"input":8000,"output":900},"turns":9,"duration_ms":300000,"api_duration_ms":200000,"non_api_ms":100000,"tool_calls":[{"name":"Read","count":5,"duration_ms_sum":4000,"duration_ms_median":800}]}},"reviewer":{"duration":160,"metrics":{"runtime":"claude","status":"success","error_kind":null,"model":"claude-sonnet-5","estimated_cost_usd":0.2,"tokens":{"input":3000,"output":400},"turns":4,"duration_ms":150000,"api_duration_ms":100000,"non_api_ms":50000,"tool_calls":[{"name":"Edit","count":2,"duration_ms_sum":2000,"duration_ms_median":1000}]}}}}
{"issue":"602","title":"Forma neutral otro runtime cost 0 turns null","pipeline":"mefisto-tooling","runtime":"otro","started":"20260903-090000","state":"completed","agents":{"writer":{"duration":190,"metrics":{"runtime":"otro","status":"success","error_kind":null,"model":null,"estimated_cost_usd":0,"tokens":{"input":6000,"output":500},"turns":null,"duration_ms":180000,"api_duration_ms":140000,"non_api_ms":40000,"tool_calls":[{"name":"glob","count":3,"duration_ms_sum":3000,"duration_ms_median":1000}]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"603","title":"Sin instrumentar","pipeline":"mefisto-tooling","started":"20260904-090000","state":"completed","agents":{"writer":{"duration":90},"reviewer":{"duration":40}}}
`

// 800 solo forma nueva con cero estimado; 801 solo legacy; en 802 el estimado gana a cost_usd y el
// reviewer no estima; 803 deja el estimado en null.
const COSTS = `{"issue":"800","pipeline":"mefisto-tooling","runtime":"otro","started":"20260910-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":0,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"801","pipeline":"mefisto-tooling","started":"20260911-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"cost_usd":0,"tokens":{"input":10,"output":2,"cache_read":3,"cache_creation":7},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"802","pipeline":"mefisto-tooling","started":"20260912-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":2,"cost_usd":99,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":1,"metrics":{"estimated_cost_usd":null,"tokens":{"input":null,"output":null,"cache_read":null,"cache_write":null,"reasoning":null},"turns":null,"duration_ms":1000,"api_duration_ms":null,"tool_calls":[]}}}}
{"issue":"803","pipeline":"mefisto-tooling","started":"20260913-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":null,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":null},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
`

const LEGACY_ONLY = `{"issue":"700","title":"Legacy","pipeline":"mefisto-tooling","started":"20260901-090000","state":"completed","agents":{"writer":{"duration":100},"reviewer":{"duration":50}}}
`

const CANONICAL_ONLY =
  '{"issue":"701","title":"Canonica","pipeline":"mefisto-tooling","runtime":"otro","started":"20260902-090000","state":"completed","agents":{"writer":{"duration":80},"reviewer":{"duration":40}}}'

let work = ''
let repo = ''

function newRepo(name: string, plugin: boolean): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  assert.equal(capture('git', ['-C', dir, 'init', '-q']).status, 0)
  if (plugin) {
    mkdirSync(join(dir, '.claude-plugin'))
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"mefisto"}\n')
  }
  return dir
}

const legacyHistory = (): string => join(repo, '.claude', 'pipeline', 'pipeline-history.jsonl')
const canonicalHistory = (): string => join(repo, '.mefisto', 'pipeline', 'pipeline-history.jsonl')

function writeHistory(content: string, file = legacyHistory()): void {
  mkdirSync(dirname(file), { recursive: true })
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

function report(argv: string[] = [], env: NodeJS.ProcessEnv = {}, cwd = repo): Outcome {
  const [out, err]: [string[], string[]] = [[], []]
  const code = run(argv, {
    cwd,
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    resolveRepo: (dir) => ({ root: dir, projectName: 'mefisto', repoSlug: '' }),
  })
  return { code, stdout: out.join('\n'), stderr: err.join('\n') }
}

function rendered(history: string): string {
  clearHistory()
  writeHistory(history)
  const { code, stdout, stderr } = report()
  assert.equal(code, 0)
  assert.equal(stderr, '')
  return stdout
}

function aggregate(content: string, desde = ''): Json {
  const agg = computeMetricsReport(content, desde)
  assert.notEqual(agg, null)
  return agg
}

const one = (list: Json, key: string, value: Json): Json => iterate(list).find((item) => get(item, key) === value) ?? null
const lines = (text: string): string[] => text.split('\n')

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto metricas internas ')))
  repo = newRepo('fake-mefisto', true)
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('historial vacio o inexistente', () => {
  const EMPTY = [
    '='.repeat(120),
    'Mefisto - Reporte agregado de metricas del pipeline interno',
    '='.repeat(120),
    'Filtro --desde: (todo el historico)',
    'Corridas mefisto-tooling en la ventana: 0 (instrumentadas: 0, sin instrumentar: 0)',
    'Costo estimado con valor: 0 corridas (completas: 0, parciales: 0); sin estimacion: 0',
    'Costo reportado legado: 0 corridas (separado; excluido de estimados)',
    '',
    '(sin corridas registradas en la ventana solicitada)',
  ].join('\n')

  test('vacio: sale con 0 y reporta 0 corridas', () => {
    assert.equal(rendered(''), EMPTY)
  })

  test('inexistente: mismo comportamiento', () => {
    clearHistory()
    assert.deepEqual(report(), { code: 0, stdout: EMPTY, stderr: '' })
  })
})

test('fuera del repo de Mefisto aborta', () => {
  const consumer = newRepo('fake-consumer', false)
  const [out, err]: [string[], string[]] = [[], []]
  const code = run([], { cwd: consumer, env: {}, out: (line) => out.push(line), err: (line) => err.push(line) })
  assert.equal(code, 1)
  assert.deepEqual(out, [])
  assert.match(err.join('\n'), /^ERROR: este pipeline solo se ejecuta dentro del repo de Mefisto$/m)
})

describe('historial mixto, agregado', () => {
  let agg: Json = null
  const tool = (name: string): Json => one(get(agg, 'tool_ranking'), 'name', name)
  const month = (period: string): Json => one(path(agg, 'series', 'monthly'), 'period', period)

  before(() => {
    agg = aggregate(MIXED)
  })

  test('cuenta las lineas validas e ignora la corrupta y la vacia', () => {
    assert.equal(path(agg, 'meta', 'total'), 7)
    assert.equal(path(agg, 'meta', 'instrumented'), 5)
    assert.equal(path(agg, 'meta', 'legacy'), 2)
  })

  test('ranking de herramientas sobre writer y reviewer', () => {
    // Bash: 200w5+200r3+201w4+210w18+210r6+215w7+230w25+230r10.
    assert.equal(get(tool('Bash'), 'calls'), 78)
    // 15000+9000+11000+70000+21000+20000+100000+35000.
    assert.equal(get(tool('Bash'), 'time_ms'), 281000)
    // Read: 200w10+200r6+201w9+210w30+210r14+230w40+230r18.
    assert.equal(get(tool('Read'), 'calls'), 127)
    assert.equal(get(iterate(get(agg, 'tool_ranking'))[0] ?? null, 'name'), 'Bash')
  })

  test('reparto API y no-API sobre las 5 instrumentadas', () => {
    assert.equal(path(agg, 'wallclock', 'aggregate', 'api_ms'), 3560000)
    assert.equal(path(agg, 'wallclock', 'aggregate', 'non_api_ms'), 1370000)
  })

  test('writer y reviewer tienen cada uno su n', () => {
    assert.equal(path(agg, 'wallclock', 'writer', 'n'), 5)
    // 215 murio antes del reviewer.
    assert.equal(path(agg, 'wallclock', 'reviewer', 'n'), 4)
    assert.equal(path(agg, 'wallclock', 'writer', 'turns_mean'), 15.2)
    assert.equal(path(agg, 'wallclock', 'reviewer', 'turns_mean'), 8.25)
  })

  test('series mensuales', () => {
    assert.equal(get(month('2026-07'), 'n_total'), 4)
    assert.equal(get(month('2026-07'), 'n_instrumented'), 4)
    assert.equal(get(month('2026-05'), 'n_instrumented'), 0)
    // (8+5) + (7+4) + (22+10) + (9+0), entre 4.
    assert.equal(get(month('2026-07'), 'turns_mean'), 16.25)
  })

  test('compara el primer mes con datos contra el ultimo', () => {
    assert.equal(path(agg, 'comparison', 'first', 'period'), '2026-07')
    assert.equal(path(agg, 'comparison', 'last', 'period'), '2026-08')
    assert.ok(Number(get(one(path(agg, 'comparison', 'deltas'), 'key', 'turns_mean'), 'pct')) > 0)
  })

  test('lista las corridas sin instrumentar', () => {
    assert.equal(path(agg, 'legacy', 'count'), 2)
    assert.deepEqual(
      iterate(path(agg, 'legacy', 'issues')).map((item) => get(item, 'issue')),
      ['100', '101'],
    )
  })
})

describe('historial mixto, texto renderizado', () => {
  let stdout = ''

  before(() => {
    stdout = rendered(MIXED)
  })

  test('la salida completa conserva textos, columnas y redondeos', () => {
    assert.equal(`${stdout}\n`, MIXED_REPORT)
  })

  test('trae cada seccion', () => {
    assert.match(stdout, /RANKING DE HERRAMIENTAS \(n=5/)
    assert.match(stdout, /^Bash +78 +281\.0s/m)
    assert.match(stdout, /REPARTO DEL WALL-CLOCK/)
    assert.match(stdout, /Writer vs Reviewer:/)
    assert.match(stdout, /DERIVA TEMPORAL - SEMANAL/)
    assert.match(stdout, /DERIVA TEMPORAL - MENSUAL/)
    assert.match(stdout, /2026-07 /)
    assert.match(stdout, /2026-08 /)
    assert.match(stdout, /RESUMEN: QUE CRECIO/)
    assert.match(stdout, /Comparando 2026-07/)
    assert.match(stdout, /SIN INSTRUMENTAR \(n=2/)
    assert.match(stdout, /#100/)
    assert.match(stdout, /#101/)
  })
})

test('--desde filtra las corridas anteriores a la fecha', () => {
  clearHistory()
  writeHistory(MIXED)
  for (const argv of [['--desde', '2026-07-01'], ['--desde=2026-07-01']]) {
    const { code, stdout } = report(argv)
    assert.equal(code, 0)
    assert.match(stdout, /^Filtro --desde: 2026-07-01$/m)
    assert.match(stdout, /ventana: 5 \(instrumentadas: 5, sin instrumentar: 0\)/)
  }
})

describe('argumentos invalidos', () => {
  const failure = (...argv: string[]): string => {
    const { code, stdout, stderr } = report(argv)
    assert.equal(code, 1)
    assert.equal(stdout, '')
    return stderr
  }

  test('--desde con formato invalido o sin valor', () => {
    assert.equal(failure('--desde', '2026/07/01'), "ERROR: --desde espera formato YYYY-MM-DD (recibido: '2026/07/01')")
    assert.equal(failure('--desde'), 'ERROR: --desde requiere un valor YYYY-MM-DD')
  })

  test('argumento desconocido', () => {
    assert.equal(failure('--no-existe'), 'ERROR: argumento desconocido: --no-existe (uso: --desde YYYY-MM-DD)')
    assert.equal(failure('--hasta', '2026-01-01'), 'ERROR: argumento desconocido: --hasta (uso: --desde YYYY-MM-DD)')
  })

  test('--help imprime el uso y sale con 0', () => {
    const { code, stdout } = report(['--help'])
    assert.equal(code, 0)
    assert.equal(lines(stdout)[0], 'Uso: mefisto-metrics-report.mts [--desde YYYY-MM-DD]')
    assert.equal(lines(stdout).length, 7)
  })
})

describe('las celdas nulas no corren las columnas', () => {
  test('mediana nula: "-" en su columna y el porcentaje en la suya', () => {
    // Bash 15000 / 23000 = 65.2 %; Read 8000 / 23000 = 34.8 %.
    assert.match(rendered(NULL_MEDIAN), /^Read +10 +8\.0s +- +34\.8%$/m)
  })

  test('corrida sin fecha: periodo "(s/fecha)" y "-" en SIN INSTRUMENTAR', () => {
    const stdout = rendered(NO_STARTED)
    assert.match(stdout, /^\(s\/fecha\) +1\/0 +2m30s/m)
    assert.match(stdout, /^#301 +- +completed$/m)
  })
})

test('el RESUMEN compara wall y turnos sobre el mismo denominador', () => {
  const agg = aggregate(SHARED_DENOMINATOR)
  const july = one(path(agg, 'series', 'monthly'), 'period', '2026-07')
  const wall = one(path(agg, 'comparison', 'deltas'), 'key', 'wall_mean_s')
  // Julio: (60 + 600) / 2 con todas, 600 con la instrumentada.
  assert.equal(get(july, 'wall_mean_s'), 330)
  assert.equal(get(july, 'wall_mean_instr_s'), 600)
  // 600 -> 1200 es +100 %; con el legado seria 330 -> 1200.
  assert.equal(get(wall, 'first'), 600)
  assert.equal(get(wall, 'pct'), 100)
})

test('la tabla de deriva desglosa los tokens medios', () => {
  const stdout = rendered(SHARED_DENOMINATOR)
  for (const column of ['Tok.in', 'Tok.out', 'Cache.rd', 'Cache.wr', 'Reason']) assert.ok(stdout.includes(column))
  assert.match(stdout, /^2026-08 +1\/1 +20m00s +20m00s +20\.0 +10\.0 +20\.0k +2\.0k +10\.0k +10\.0k +- +50\.0%/m)
})

describe('segmentacion por harness_version con harness_sha por corrida', () => {
  test('agrupa por version; el sha solo viaja como columna', () => {
    const agg = aggregate(VERSIONS)
    const version = (name: string): Json => one(get(agg, 'by_version'), 'version', name)
    const sha = (issue: string): Json => get(one(path(agg, 'wallclock', 'per_run'), 'issue', issue), 'harness_sha')
    assert.equal(iterate(get(agg, 'by_version')).length, 2)
    assert.equal(get(version('0.9.0'), 'n_total'), 2)
    assert.equal(get(version('0.9.0'), 'turns_mean'), 15)
    assert.equal(get(version('0.9.0'), 'estimated_cost_usd_mean'), null)
    assert.equal(get(version('0.9.0'), 'wall_mean_instr_s'), 150)
    assert.equal(get(version('(sin version)'), 'n_total'), 2)
    assert.equal(get(version('(sin version)'), 'turns_mean'), 8.5)
    assert.deepEqual(['900', '910', '920', '930'].map(sha), ['aaa1111', null, 'ccc3333', null])
  })

  test('renderiza la tabla por version y la columna SHA', () => {
    const stdout = rendered(VERSIONS)
    assert.match(stdout, /POR VERSION DE HARNESS/)
    assert.match(stdout, /^0\.9\.0 +2\/2 +2m30s +15\.0 +76\.7% +-$/m)
    assert.match(stdout, /^\(sin version\) +2\/2 +1m40s +8\.5 +65\.0% +-$/m)
    assert.match(stdout, /^#900 .*aaa1111$/m)
    assert.match(stdout, /^#910 .* -$/m)
  })
})

describe('normalizacion vieja y neutral, tabla por runtime', () => {
  // Fuera de normalizeAgentMetrics nada lee los campos crudos de la forma vieja.
  test('la forma vieja solo se nombra en la normalizacion', () => {
    const sources = ['scripts/lib/metrics-report.mts', 'scripts/metrics-report.mts', 'src/internal/scripts/mefisto-metrics-report.mts']
    const live: string[] = []
    for (const source of sources) {
      let skipping = false
      for (const line of lines(readFileSync(join(REPO_ROOT, source), 'utf8'))) {
        if (line.startsWith('export function normalizeAgentMetrics(')) skipping = true
        if (!skipping && !line.trimStart().startsWith('//')) live.push(line)
        if (skipping && line === '}') skipping = false
      }
    }
    const text = live.join('\n')
    for (const field of ['is_error', 'stop_reason', 'terminal_reason', 'duration_api_ms']) {
      assert.doesNotMatch(text, new RegExp(`(^|[^_A-Za-z0-9])${field}([^_A-Za-z0-9]|$)`, 'm'), field)
    }
    assert.match(text, /normalizeAgentMetrics\(/)
  })

  test('agrupa por el runtime de la corrida', () => {
    const agg = aggregate(RUNTIMES)
    const runtime = (name: string): Json => one(get(agg, 'by_runtime'), 'runtime', name)
    assert.equal(path(agg, 'meta', 'total'), 4)
    assert.equal(path(agg, 'meta', 'instrumented'), 3)
    assert.equal(path(agg, 'meta', 'legacy'), 1)
    assert.equal(get(one(get(agg, 'tool_ranking'), 'name', 'glob'), 'calls'), 3)
    assert.deepEqual(
      iterate(get(agg, 'by_runtime')).map((item) => get(item, 'runtime')),
      ['claude', 'otro', '(sin runtime)'],
    )
    assert.equal(get(runtime('claude'), 'n_total'), 1)
    assert.equal(get(runtime('claude'), 'turns_mean'), 13)
    assert.equal(get(runtime('claude'), 'estimated_cost_usd_mean'), 0.7)
    assert.equal(get(runtime('otro'), 'n_total'), 1)
    // El 0 es real; los turnos que nadie reporto no se cuentan como 0.
    assert.equal(get(runtime('otro'), 'estimated_cost_usd_mean'), 0)
    assert.equal(get(runtime('otro'), 'turns_mean'), null)
    assert.equal(get(runtime('(sin runtime)'), 'n_total'), 2)
    assert.equal(get(runtime('(sin runtime)'), 'n_instrumented'), 1)
    assert.equal(get(runtime('(sin runtime)'), 'turns_mean'), 9)
  })

  test('renderiza la tabla por runtime', () => {
    const stdout = rendered(RUNTIMES)
    const start = lines(stdout).findIndex((line) => line.startsWith('POR RUNTIME'))
    assert.deepEqual(lines(stdout).slice(start + 6, start + 10), [
      'Runtime              n(t/i)    WallMedia  Turnos    %API Costo est.',
      'claude               1/1           7m50s    13.0   66.7%       0.70',
      'otro                 1/1           3m10s       -   77.8%       0.00',
      '(sin runtime)        2/1           6m20s     9.0   73.3%       0.50',
    ])
  })
})

describe('costos estimados y legados, tokens neutrales', () => {
  test('el estimado y el legado no se mezclan', () => {
    const agg = aggregate(COSTS)
    const september = one(path(agg, 'series', 'monthly'), 'period', '2026-09')
    const perRun = (issue: string): Json => one(path(agg, 'wallclock', 'per_run'), 'issue', issue)
    assert.equal(path(agg, 'wallclock', 'writer', 'estimated_cost_usd_total'), 2)
    assert.equal(path(agg, 'wallclock', 'writer', 'legacy_reported_cost_usd_total'), 0)
    assert.equal(path(agg, 'meta', 'estimated_cost_runs'), 2)
    assert.equal(path(agg, 'meta', 'estimated_cost_missing_runs'), 2)
    assert.equal(get(september, 'cache_write_mean'), 4.75)
    assert.equal(get(september, 'reasoning_mean'), 5)
    assert.equal(get(perRun('800'), 'estimated_cost_usd'), 0)
    assert.equal(get(perRun('801'), 'legacy_reported_cost_usd'), 0)
    assert.equal(get(perRun('802'), 'legacy_reported_cost_usd'), null)
    assert.equal(get(perRun('802'), 'estimated_cost_status'), 'parcial')
    assert.equal(path(agg, 'meta', 'estimated_cost_complete_runs'), 1)
    assert.equal(path(agg, 'meta', 'estimated_cost_partial_runs'), 1)
  })

  test('resumen y detalle separan estimacion parcial y legado', () => {
    const stdout = rendered(COSTS)
    assert.match(stdout, /^Costo estimado con valor: 2 corridas \(completas: 1, parciales: 1\); sin estimacion: 2$/m)
    assert.match(stdout, /^Costo reportado legado: 1 corridas \(separado; excluido de estimados\)$/m)
    assert.match(stdout, /Cobertura est\./)
    assert.match(stdout, /Costo leg\./)
    assert.match(stdout, /^Cache write medio +5 +-$/m)
  })
})

describe('historial en las dos ubicaciones', () => {
  test('agrega la legacy y la canonica aunque una no termine en salto de linea', () => {
    clearHistory()
    writeHistory(LEGACY_ONLY)
    writeHistory(CANONICAL_ONLY, canonicalHistory())
    const { code, stdout, stderr } = report()
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.match(stdout, /ventana: 2 /)
    assert.match(stdout, /^#700 /m)
    assert.match(stdout, /^#701 /m)
  })

  test('el orden no importa: la que no termina en salto puede ser la legacy', () => {
    clearHistory()
    writeHistory(LEGACY_ONLY.trimEnd())
    writeHistory(`${CANONICAL_ONLY}\n`, canonicalHistory())
    assert.match(report().stdout, /ventana: 2 /)
  })

  test('con solo la legacy la sigue leyendo', () => {
    clearHistory()
    writeHistory(LEGACY_ONLY)
    assert.match(report().stdout, /ventana: 1 /)
  })

  test('MEFISTO_STATE_DIR y MEFISTO_LEGACY_STATE_DIR mandan sobre el repo', () => {
    clearHistory()
    writeHistory(LEGACY_ONLY)
    const [canonical, legacy] = [join(work, 'otro-canonico'), join(work, 'otro-legacy')]
    writeHistory(`${CANONICAL_ONLY}\n`, join(canonical, 'pipeline-history.jsonl'))
    const { stdout } = report([], { MEFISTO_STATE_DIR: canonical, MEFISTO_LEGACY_STATE_DIR: legacy })
    assert.match(stdout, /ventana: 1 /)
    assert.match(stdout, /^#701 /m)
  })
})

// Los campos de identidad son aditivos: el historial previo convive con el nuevo sin migrarse.
test('agrega un historial que mezcla lineas legadas y con harness_version y harness_sha', () => {
  const stdout = rendered(
    [
      '{"issue":"1","title":"linea legada sin los campos","pipeline":"mefisto-tooling","started":"20260101-100000","finished":"2026-01-01T10:10:00","state":"completed","agents":{"writer":{"duration":600},"reviewer":{"duration":300}},"pr":"http://x/1"}',
      '{"issue":"2","title":"linea nueva con ambos campos","pipeline":"mefisto-tooling","harness_version":"0.25.0","harness_sha":"abc1234","started":"20260102-100000","finished":"2026-01-02T10:10:00","state":"completed","agents":{"writer":{"duration":600},"reviewer":{"duration":300}},"pr":"http://x/2"}',
      '{"issue":"3","title":"aborto con ambos campos en null","pipeline":"mefisto-tooling","harness_version":null,"harness_sha":null,"started":"20260103-100000","finished":"2026-01-03T10:10:00","state":"failed","stage":"writer","error":"algo"}',
      '',
    ].join('\n'),
  )
  assert.match(stdout, /Corridas mefisto-tooling en la ventana: 3 /)
  assert.match(stdout, /^0\.25\.0 +1\/0 /m)
  assert.match(stdout, /^\(sin version\) +2\/0 /m)
})

test('un tipo con el que no se puede operar hace fallar el reporte entero', () => {
  clearHistory()
  writeHistory('{"issue":"1","pipeline":"mefisto-tooling","agents":"texto"}\n')
  const { code, stdout, stderr } = report()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `ERROR: no se pudo procesar el historial (${legacyHistory()})`)
})
