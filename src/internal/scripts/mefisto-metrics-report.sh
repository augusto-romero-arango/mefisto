#!/usr/bin/env bash
# mefisto-metrics-report.sh -- Reporte agregado de metricas del pipeline interno (issue #427)
#
# Uso:
#   .claude/scripts/mefisto-metrics-report.sh
#   .claude/scripts/mefisto-metrics-report.sh --desde 2026-07-01
#
# Responde "donde se van los 30 minutos" de un issue de tooling interno,
# agregando pipeline-history.jsonl (una linea por corrida del pipeline
# mefisto-tooling, con agents.<agente>.metrics derivado de la traza por #426):
# ranking de herramientas, reparto API vs no-API del wall-clock (agregado, por
# corrida y writer vs reviewer), deriva temporal semanal/mensual y agregado por
# harness_version (issue #664). Solo lectura: nunca escribe estado.
#
# El historial se lee de las DOS ubicaciones que resuelve mefisto_state_read_paths
# (issue #869): la canonica .mefisto/pipeline/ -- donde el pipeline anota desde
# su traslado al layout de MEF-ADR-0049 -- y la ubicacion legacy (MEF-ADR-0049 seccion 3), que
# conserva el historico previo sin migrarlo. Ver main().
#
# El historico es MIXTO por diseno (CA-5): las corridas previas a #426 no
# traen "metrics" (solo la duracion plana de siempre) y se reportan aparte
# bajo SIN INSTRUMENTAR: toda cifra derivada de "metrics" declara n= sobre
# cuantas corridas se calculo.
#
# Solo requiere pipeline-history.jsonl: el detalle por tool call ya viaja en
# agents.<agente>.metrics (#426), asi que no hace falta bajar a los archivos
# metrics/*.json por stage (ver notas tecnicas del issue).
#
# Segmentacion por harness_version (issue #664, mismo shape que el porte
# publicado #663): cada linea trae "harness_version"/"harness_sha" desde #662.
# El reporte agrega una tabla "POR VERSION DE HARNESS" (por-version, mismos
# agregados de wall/turnos/costo que el resto, restringidos a las corridas
# instrumentadas de esa version) y cae a "(sin version)" para el historial
# previo a #662. harness_sha NO es eje de agrupacion (casi cada corrida
# tendria su propio grupo): viaja como columna en "Por corrida", ausente/null
# cuando la linea no lo trae.
#
# Normalizacion vieja/neutral y segmentacion por runtime (issue #908/#1326): desde
# #907 una corrida nueva anota agents.<agente>.metrics con la forma neutral
# (runtime, status, error_kind, tokens{input,output,cache_read,cache_write,
# reasoning}, estimated_cost_usd, api_duration_ms) mientras el historico previo
# sigue en la forma vieja (is_error, duration_api_ms, tokens con
# cache_read/cache_creation y cost_usd). normalize_agent_metrics (dentro del jq de
# compute_metrics_report_json) proyecta ambas formas a una sola forma interna
# antes de que el resto del reporte las toque -- ningun otro punto del script
# lee is_error/stop_reason/terminal_reason. El reporte agrega ademas una tabla
# "POR RUNTIME", leyendo el "runtime" de nivel de corrida (no el de
# metrics.runtime): cae a "(sin runtime)" para el historial previo a esta
# anotacion, mismo criterio que "(sin version)".

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/_mefisto-common.sh"
assert_in_mefisto || exit 1

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: este reporte requiere jq (no encontrado en PATH). Instalalo (p.ej. 'brew install jq') y reintenta." >&2
    exit 1
fi

# Prelude jq de los renderizadores: proyecta una fila a @tsv sin celdas
# vacias -- null y "" salen como el literal "null", que los formateadores de
# bash de mas abajo ya traducen a "-".
#
# No es cosmetico. Las filas se leen con `IFS=$'\t' read -r a b c ...`, y el
# tabulador es un caracter IFS *whitespace*: bash colapsa tabuladores
# consecutivos en un solo delimitador y descarta los iniciales. Una sola celda
# vacia en medio de la fila corre TODAS las columnas siguientes una posicion a
# la izquierda, en silencio y sin error -- p. ej. una herramienta con
# `duration_ms_median: null` (estado de primera clase del esquema de #426:
# tool_use sin tool_result emparejado, justo lo que pasa en los stages matados
# que este reporte existe para analizar) imprimiria su "% tiempo" dentro de la
# columna "Mediana/llamada". Con toda celda no vacia el colapso no puede
# ocurrir.
#
# INVARIANTE: toda fila destinada a `IFS=$'\t' read` se proyecta con `| row`,
# nunca con `| @tsv` a secas.
JQ_ROW='def row: map(if . == null or . == "" then "null" else . end) | @tsv;'

# Reglas horizontales. El detalle por corrida incorpora costos estimado y
# legado junto con la cobertura de la estimacion; una regla amplia evita que
# esas columnas parezcan pertenecer a otra seccion.
RULE_MAJOR=$(printf '%0120d' 0 | tr '0' '=')
RULE_MINOR=$(printf '%0120d' 0 | tr '0' '-')

# compute_metrics_report_json <history_file> <desde>
#
# Agrega pipeline-history.jsonl en un unico objeto JSON compacto: ranking de
# herramientas (CA-2), reparto del wall-clock agregado/por-corrida/writer-vs-
# reviewer (CA-3), series semanal y mensual (CA-4) y el conteo de corridas
# "sin instrumentar" (CA-5). <desde> es "" (todo el historico) o "YYYY-MM-DD".
# Tolera archivo ausente/vacio (contenido "") y lineas corruptas (se ignoran,
# igual que compute_stage_metrics). Nunca aborta: ante cualquier fallo de jq
# devuelve vacio y el caller decide.
compute_metrics_report_json() {
    local history_file="$1" desde="$2"
    local raw_content=""
    [ -f "$history_file" ] && raw_content="$(cat "$history_file" 2>/dev/null || true)"

    printf '%s' "$raw_content" | jq -R -s -c --arg desde "$desde" '
def median:
  sort as $s
  | ($s | length) as $n
  | if $n == 0 then null
    elif ($n % 2) == 1 then $s[($n - 1) / 2]
    else ($s[$n / 2 - 1] + $s[$n / 2]) / 2
    end;

def avgOrNull:
  if length == 0 then null else (add / length) end;

def parse_started:
  if . == null then null
  else (try (strptime("%Y%m%d-%H%M%S") | mktime) catch null)
  end;

# normalize_agent_metrics (issue #908, CA-1) -- proyecta agents.<agente>.metrics
# (forma vieja, pre-#907 -- is_error/stop_reason/duration_api_ms/tokens con
# cache_read+cache_creation/cost_usd -- o neutral, #1325 -- runtime/status/error_kind/
# api_duration_ms/tokens completos/estimated_cost_usd) a UNA sola forma interna.
# de aqui el resto del reporte solo lee este resultado: ningun otro punto de
# este jq nombra is_error/stop_reason/terminal_reason/duration_api_ms. `null`
# de entrada (el stage no dejo metrics) produce `null` de salida.
#
# status: si la forma ya trae "status" (neutral) se copia tal cual; si no,
# se deriva de is_error (forma vieja: false->"success", true->"failed"); sin
# ninguno de los dos, null.
#
# api_duration_ms lee api_duration_ms (neutral) o cae a duration_api_ms
# (vieja) -- incompatibilidad de nombre pura, NUNCA los dos a la vez. Con
# ambos ausentes/null, non_api_ms tambien null (nunca 0): un `0` real en
# cost_usd/tokens/turns nunca se confunde con "no hubo dato" (CA-1/CA-3).
def normalize_agent_metrics:
  if . == null then null
  else
    . as $m
    | (if ($m.api_duration_ms != null) then $m.api_duration_ms
       elif ($m.duration_api_ms != null) then $m.duration_api_ms
       else null end) as $api_ms
    | {
        runtime: (if ($m.runtime | type) == "string" then $m.runtime else null end),
        status: (
          if ($m.status | type) == "string" then $m.status
          elif ($m.is_error | type) == "boolean" then (if $m.is_error then "failed" else "success" end)
          else null end
        ),
        model: $m.model,
        # estimated_cost_usd y cost_usd no son sinonimos (MEF-ADR-0054): el
        # segundo solo se conserva como dato legado cuando falta el primero.
        estimated_cost_usd: $m.estimated_cost_usd,
        legacy_reported_cost_usd: (if ($m | has("estimated_cost_usd")) then null else $m.cost_usd end),
        tokens: {
          input: $m.tokens.input,
          output: $m.tokens.output,
          cache_read: $m.tokens.cache_read,
          cache_write: (if $m.tokens.cache_write != null then $m.tokens.cache_write else $m.tokens.cache_creation end),
          reasoning: $m.tokens.reasoning
        },
        turns: $m.turns,
        duration_ms: $m.duration_ms,
        api_duration_ms: $api_ms,
        non_api_ms: (if ($m.duration_ms != null and $api_ms != null) then ($m.duration_ms - $api_ms) else null end),
        tool_calls: ($m.tool_calls // [])
      }
  end;

def wr_norm: (.agents.writer.metrics | normalize_agent_metrics);
def rv_norm: (.agents.reviewer.metrics | normalize_agent_metrics);

# null_safe_sum(a; b) -- suma preservando null: null solo cuando AMBOS son
# null (ningun agente dejo el dato), suma de los no-null en cualquier otro
# caso. Evita que compute_metrics_report_json trate un `turns`/`cost_usd`/
# `tokens` neutral en null (p. ej. un runtime que no reporta turnos) como un 0 real
# al combinar writer+reviewer (CA-3): un `0` real (el costo de una corrida
# bajo suscripcion) sigue sumando como 0 gracias al `// 0` de la rama no-null.
def null_safe_sum(a; b): if (a == null and b == null) then null else ((a // 0) + (b // 0)) end;

def run_api_ms: ((wr_norm.api_duration_ms // 0) + (rv_norm.api_duration_ms // 0));
def run_non_api_ms: ((wr_norm.non_api_ms // 0) + (rv_norm.non_api_ms // 0));
def run_tool_calls_arr: ((wr_norm.tool_calls // []) + (rv_norm.tool_calls // []));
def run_tool_ms: ([run_tool_calls_arr[] | (.duration_ms_sum // 0)] | add // 0);
def run_tool_calls_count: ([run_tool_calls_arr[] | .count] | add // 0);
def run_turns: null_safe_sum(wr_norm.turns; rv_norm.turns);
def run_tokens_input: null_safe_sum(wr_norm.tokens.input; rv_norm.tokens.input);
def run_tokens_output: null_safe_sum(wr_norm.tokens.output; rv_norm.tokens.output);
def run_tokens_cache_read: null_safe_sum(wr_norm.tokens.cache_read; rv_norm.tokens.cache_read);
def run_tokens_cache_write: null_safe_sum(wr_norm.tokens.cache_write; rv_norm.tokens.cache_write);
def run_tokens_reasoning: null_safe_sum(wr_norm.tokens.reasoning; rv_norm.tokens.reasoning);
def run_estimated_cost_usd: null_safe_sum(wr_norm.estimated_cost_usd; rv_norm.estimated_cost_usd);
def run_legacy_reported_cost_usd: null_safe_sum(wr_norm.legacy_reported_cost_usd; rv_norm.legacy_reported_cost_usd);
def run_metrics_agents: ([wr_norm, rv_norm] | map(select(. != null)) | length);
def run_estimated_cost_agents: ([wr_norm.estimated_cost_usd, rv_norm.estimated_cost_usd] | map(select(. != null)) | length);
def run_estimated_cost_status:
  run_metrics_agents as $metrics_n
  | run_estimated_cost_agents as $estimated_n
  | if $estimated_n == 0 then "sin estimacion"
    elif $estimated_n == $metrics_n then "completa"
    else "parcial"
    end;

def week_key: if ._ts == null then null else (._ts | gmtime | strftime("%G-W%V")) end;
def month_key: if ._ts == null then null else (._ts | gmtime | strftime("%Y-%m")) end;

def period_summary(keyfn):
  group_by(keyfn)
  | map(
      . as $group
      | ($group[0] | keyfn) as $period
      | ($group | map(select(._has_metrics))) as $g_instr
      | ($g_instr | map(run_tokens_cache_read) | add // 0) as $cr_total
      | ($g_instr | map(run_tokens_cache_write) | add // 0) as $cw_total
      | {
          period: ($period // "(s/fecha)"),
          n_total: ($group | length),
          n_instrumented: ($g_instr | length),
          wall_mean_s: ($group | map(._wall_s) | map(select(. != null)) | avgOrNull),
          wall_median_s: ($group | map(._wall_s) | map(select(. != null)) | median),
          # Media del wall SOLO sobre las corridas instrumentadas. La seccion
          # RESUMEN compara esta y no wall_mean_s: el resto de sus filas
          # (turnos, tool calls, tokens, no-API) solo existe para las
          # instrumentadas, y mezclar denominadores volveria incomparable
          # justo la atribucion que el reporte existe para hacer.
          wall_mean_instr_s: ($g_instr | map(._wall_s) | map(select(. != null)) | avgOrNull),
          turns_mean: ($g_instr | map(run_turns) | map(select(. != null)) | avgOrNull),
          tool_calls_mean: ($g_instr | map(run_tool_calls_count) | avgOrNull),
          tokens_input_mean: ($g_instr | map(run_tokens_input) | map(select(. != null)) | avgOrNull),
          tokens_output_mean: ($g_instr | map(run_tokens_output) | map(select(. != null)) | avgOrNull),
          cache_read_mean: ($g_instr | map(run_tokens_cache_read) | map(select(. != null)) | avgOrNull),
          cache_write_mean: ($g_instr | map(run_tokens_cache_write) | map(select(. != null)) | avgOrNull),
          reasoning_mean: ($g_instr | map(run_tokens_reasoning) | map(select(. != null)) | avgOrNull),
          cache_read_pct: (if ($cr_total + $cw_total) > 0 then ($cr_total / ($cr_total + $cw_total) * 100) else null end),
          estimated_cost_usd_mean: ($g_instr | map(run_estimated_cost_usd) | map(select(. != null)) | avgOrNull),
          estimated_cost_n: ($g_instr | map(run_estimated_cost_usd) | map(select(. != null)) | length),
          legacy_reported_cost_usd_mean: ($g_instr | map(run_legacy_reported_cost_usd) | map(select(. != null)) | avgOrNull),
          non_api_ms_mean: ($g_instr | map(run_non_api_ms) | avgOrNull)
        }
    )
  | sort_by([(.period == "(s/fecha)"), .period]);

def summarize_agent:
  {
    n: length,
    turns_mean: (map(.turns) | map(select(. != null)) | avgOrNull),
    estimated_cost_usd_mean: (map(.estimated_cost_usd) | map(select(. != null)) | avgOrNull),
    estimated_cost_usd_total: (map(.estimated_cost_usd) | map(select(. != null)) | (if length == 0 then null else add end)),
    legacy_reported_cost_usd_mean: (map(.legacy_reported_cost_usd) | map(select(. != null)) | avgOrNull),
    legacy_reported_cost_usd_total: (map(.legacy_reported_cost_usd) | map(select(. != null)) | (if length == 0 then null else add end)),
    duration_ms_mean: (map(.duration_ms) | map(select(. != null)) | avgOrNull),
    duration_api_ms_mean: (map(.api_duration_ms) | map(select(. != null)) | avgOrNull),
    non_api_ms_mean: (map(.non_api_ms) | map(select(. != null)) | avgOrNull),
    tokens_input_mean: (map(.tokens.input) | map(select(. != null)) | avgOrNull),
    tokens_output_mean: (map(.tokens.output) | map(select(. != null)) | avgOrNull),
    tokens_cache_read_mean: (map(.tokens.cache_read) | map(select(. != null)) | avgOrNull),
    tokens_cache_write_mean: (map(.tokens.cache_write) | map(select(. != null)) | avgOrNull),
    tokens_reasoning_mean: (map(.tokens.reasoning) | map(select(. != null)) | avgOrNull),
    tool_calls_mean: (map([(.tool_calls // [])[] | .count] | add // 0) | avgOrNull)
  };

# group_summary -- agregados de wallclock/turnos/costo restringidos a UN grupo
# de corridas, sea cual sea el eje que lo formo: harness_version (issue #664,
# mismo shape que el porte publicado #663) o runtime de nivel de corrida
# (issue #908). Los dos ejes piden exactamente las mismas seis cifras, asi
# que comparten def: dos copias divergirian en la primera columna que se le
# agregue a una sola de las tablas.
#
# Opera sobre $group (corridas TOTALES del grupo), no solo sobre las
# instrumentadas, para que n_total/n_instrumented reutilicen el mismo par
# instrumented/legacy del resto del reporte. Filtra null antes de promediar
# turnos/costo (CA-3, #908): una corrida cuyo runtime no reporta turnos
# (turns: null) no debe leerse como 0 al mezclarse con las que si lo reportan.
def group_summary:
  . as $group
  | ($group | map(select(._has_metrics))) as $g_instr
  | ($g_instr | map(run_api_ms) | add // 0) as $api_total
  | ($g_instr | map(run_non_api_ms) | add // 0) as $non_api_total
  | {
      n_total: ($group | length),
      n_instrumented: ($g_instr | length),
      wall_mean_instr_s: ($g_instr | map(._wall_s) | map(select(. != null)) | avgOrNull),
      pct_api: (if ($api_total + $non_api_total) > 0 then ($api_total / ($api_total + $non_api_total) * 100) else null end),
      turns_mean: ($g_instr | map(run_turns) | map(select(. != null)) | avgOrNull),
      estimated_cost_usd_mean: ($g_instr | map(run_estimated_cost_usd) | map(select(. != null)) | avgOrNull),
      estimated_cost_n: ($g_instr | map(run_estimated_cost_usd) | map(select(. != null)) | length),
      legacy_reported_cost_usd_mean: ($g_instr | map(run_legacy_reported_cost_usd) | map(select(. != null)) | avgOrNull)
    };

# version_sort_key -- orden semver NUMERICO por componente, no lexicografico
# (mismo motivo que el porte publicado: comparar cadenas invertiria 0.9.0 y
# 0.25.0). Componentes no numericos caen a -1 y desempatan por la cadena cruda.
def version_sort_key:
  [(split(".") | map(try tonumber catch -1)), .];

def delta_of(f; l):
  {
    first: f,
    last: l,
    pct: (if f == null or l == null or f == 0 then null else ((l - f) / f * 100) end)
  };

(split("\n") | map(select(length > 0)) | map(try fromjson catch empty) | map(select(type == "object"))) as $raw

| ($raw | map(select(.pipeline == "mefisto-tooling"))) as $all0

| ($all0 | map(select(
    ($desde == "") or
    ((( .started // "")[0:8]) as $d8 | ($d8 | length) == 8 and $d8 >= ($desde | gsub("-"; "")))
  ))) as $all

| ($all | map(. + {
    _wall_s: (if (.agents.writer.duration == null and .agents.reviewer.duration == null) then null
              else ((.agents.writer.duration // 0) + (.agents.reviewer.duration // 0)) end),
    _has_metrics: (((.agents.writer.metrics? // null) != null) or ((.agents.reviewer.metrics? // null) != null)),
    _ts: (.started | parse_started),
    # harness_version llego con #662: el historial previo (o cualquier linea
    # futura que no lo traiga) cae en su propio cajon "(sin version)" en vez
    # de romper la segmentacion by_version (issue #664).
    _version: (if (.harness_version | type) == "string" then .harness_version else "(sin version)" end),
    # runtime de NIVEL DE CORRIDA (issue #908) -- distinto de metrics.runtime,
    # que vive dentro de cada agente. El historial previo a esta anotacion (o
    # cualquier linea futura que no lo traiga) cae en "(sin runtime)", mismo
    # criterio que "(sin version)".
    _runtime: (if (.runtime | type) == "string" then .runtime else "(sin runtime)" end)
  })) as $entries

| ($entries | length) as $total_n
| ($entries | map(select(._has_metrics | not))) as $legacy
| ($entries | map(select(._has_metrics))) as $instr
| ($legacy | length) as $legacy_n
| ($instr | length) as $instr_n
| ($instr | map(run_estimated_cost_usd) | map(select(. != null)) | length) as $estimated_cost_n
| ($instr | map(run_legacy_reported_cost_usd) | map(select(. != null)) | length) as $legacy_cost_n
| ($instr | map(select(run_estimated_cost_status == "completa")) | length) as $estimated_complete_n
| ($instr | map(select(run_estimated_cost_status == "parcial")) | length) as $estimated_partial_n

| ( ($instr | map(run_tool_calls_arr) | add) // [] ) as $tool_blocks
| ($tool_blocks
    | group_by(.name)
    | map({
        name: .[0].name,
        calls: (map(.count) | add),
        time_ms: (map(.duration_ms_sum // 0) | add),
        median_ms: (map(.duration_ms_median) | map(select(. != null)) | median)
      })
  ) as $tool_ranking_raw
| ($tool_ranking_raw | map(.time_ms) | add // 0) as $tool_time_grand_total
| ($tool_ranking_raw
    | map(. + {pct: (if $tool_time_grand_total > 0 then (.time_ms / $tool_time_grand_total * 100) else 0 end)})
    | sort_by(-.time_ms)
  ) as $tool_ranking

| ($instr | map(.agents.writer.metrics | normalize_agent_metrics) | map(select(. != null))) as $wr_metrics
| ($instr | map(.agents.reviewer.metrics | normalize_agent_metrics) | map(select(. != null))) as $rv_metrics

| ($instr | map(run_api_ms) | add // 0) as $agg_api_ms
| ($instr | map(run_non_api_ms) | add // 0) as $agg_non_api_ms
| ($instr | map(run_tool_ms) | add // 0) as $agg_tool_ms

| ($instr | sort_by(.started) | map({
    issue: .issue,
    started: .started,
    state: .state,
    wall_s: ._wall_s,
    api_ms: run_api_ms,
    non_api_ms: run_non_api_ms,
    tool_ms: run_tool_ms,
    estimated_cost_usd: run_estimated_cost_usd,
    estimated_cost_status: run_estimated_cost_status,
    legacy_reported_cost_usd: run_legacy_reported_cost_usd,
    pct_api: (if (run_api_ms + run_non_api_ms) > 0 then (run_api_ms / (run_api_ms + run_non_api_ms) * 100) else null end),
    # harness_sha (issue #664) NO es eje de agrupacion -- casi cada corrida
    # tendria su propio grupo -- solo columna por-corrida, null si la linea no
    # lo trae (historial previo a #662).
    harness_sha: (if (.harness_sha | type) == "string" then .harness_sha else null end)
  })) as $per_run

| ($entries | period_summary(week_key)) as $weekly
| ($entries | period_summary(month_key)) as $monthly

| ($monthly | map(select(.n_instrumented > 0))) as $monthly_with_data
| (if ($monthly_with_data | length) >= 2 then
    ($monthly_with_data[0]) as $f
    | ($monthly_with_data[-1]) as $l
    | {
        first: $f,
        last: $l,
        deltas: [
          ({key: "wall_mean_s", label: "Wall medio (issue)", unit: "s"} + delta_of($f.wall_mean_instr_s; $l.wall_mean_instr_s)),
          ({key: "turns_mean", label: "Turnos medios", unit: "count1"} + delta_of($f.turns_mean; $l.turns_mean)),
          ({key: "tool_calls_mean", label: "Tool calls medios", unit: "count1"} + delta_of($f.tool_calls_mean; $l.tool_calls_mean)),
          ({key: "tokens_input_mean", label: "Tokens in medios", unit: "count0"} + delta_of($f.tokens_input_mean; $l.tokens_input_mean)),
           ({key: "non_api_s_mean", label: "No-API medio", unit: "s"} + delta_of(($f.non_api_ms_mean // 0) / 1000; ($l.non_api_ms_mean // 0) / 1000)),
           ({key: "estimated_cost_usd_mean", label: "Costo estimado medio", unit: "usd"} + delta_of($f.estimated_cost_usd_mean; $l.estimated_cost_usd_mean))
        ]
      }
  else null end) as $comparison

| ($legacy | sort_by(.started) | map({issue: .issue, started: .started, state: .state})) as $legacy_list

| ($entries
    | group_by(._version)
    | map(. as $group | ($group | group_summary) + {version: $group[0]._version})
    | sort_by([(.version == "(sin version)"), (.version | version_sort_key)])
  ) as $by_version

| ($entries
    | group_by(._runtime)
    | map(. as $group | ($group | group_summary) + {runtime: $group[0]._runtime})
    | sort_by([(.runtime == "(sin runtime)"), .runtime])
  ) as $by_runtime

| {
    meta: {
      total: $total_n,
      instrumented: $instr_n,
      legacy: $legacy_n,
      estimated_cost_runs: $estimated_cost_n,
      estimated_cost_missing_runs: ($instr_n - $estimated_cost_n),
      estimated_cost_complete_runs: $estimated_complete_n,
      estimated_cost_partial_runs: $estimated_partial_n,
      legacy_cost_runs: $legacy_cost_n,
      desde: (if $desde == "" then null else $desde end),
      oldest_started: ($entries | map(.started) | map(select(. != null)) | (sort | .[0])),
      newest_started: ($entries | map(.started) | map(select(. != null)) | (sort | .[-1]))
    },
    tool_ranking: $tool_ranking,
    wallclock: {
      aggregate: {
        n: $instr_n,
        api_ms: $agg_api_ms,
        non_api_ms: $agg_non_api_ms,
        tool_ms: $agg_tool_ms,
        pct_api: (if ($agg_api_ms + $agg_non_api_ms) > 0 then ($agg_api_ms / ($agg_api_ms + $agg_non_api_ms) * 100) else null end),
        pct_non_api: (if ($agg_api_ms + $agg_non_api_ms) > 0 then ($agg_non_api_ms / ($agg_api_ms + $agg_non_api_ms) * 100) else null end),
        pct_tool_of_non_api: (if $agg_non_api_ms > 0 then ($agg_tool_ms / $agg_non_api_ms * 100) else null end)
      },
      per_run: $per_run,
      writer: ($wr_metrics | summarize_agent),
      reviewer: ($rv_metrics | summarize_agent)
    },
    series: {
      weekly: $weekly,
      monthly: $monthly
    },
    by_version: $by_version,
    by_runtime: $by_runtime,
    legacy: {
      count: $legacy_n,
      issues: $legacy_list
    },
    comparison: $comparison
  }
' 2>/dev/null
}

# fmt_dur_s <segundos|"">
#
# "Xm Ys" si >= 60s, "Ys" si no, "-" si vacio/null. Acepta enteros o floats
# (se redondean al segundo).
fmt_dur_s() {
    local s="$1"
    if [ -z "$s" ] || [ "$s" = "null" ]; then echo "-"; return 0; fi
    local total m r
    total=$(printf '%.0f' "$s")
    m=$((total / 60))
    r=$((total % 60))
    if [ "$m" -gt 0 ]; then
        printf '%dm%02ds' "$m" "$r"
    else
        printf '%ds' "$r"
    fi
}

# fmt_pct <numero|"">
fmt_pct() {
    local v="$1"
    if [ -z "$v" ] || [ "$v" = "null" ]; then echo "-"; return 0; fi
    printf '%.1f%%' "$v"
}

# fmt_signed_pct <numero|"">
fmt_signed_pct() {
    local v="$1"
    if [ -z "$v" ] || [ "$v" = "null" ]; then echo "n/d"; return 0; fi
    printf '%+.1f%%' "$v"
}

render_header() {
    local agg="$1"
    local desde total instr legacy estimated complete partial missing legacy_cost oldest newest
    desde=$(jq -r '.meta.desde // "(todo el historico)"' <<<"$agg")
    total=$(jq -r '.meta.total' <<<"$agg")
    instr=$(jq -r '.meta.instrumented' <<<"$agg")
    legacy=$(jq -r '.meta.legacy' <<<"$agg")
    estimated=$(jq -r '.meta.estimated_cost_runs' <<<"$agg")
    complete=$(jq -r '.meta.estimated_cost_complete_runs' <<<"$agg")
    partial=$(jq -r '.meta.estimated_cost_partial_runs' <<<"$agg")
    missing=$(jq -r '.meta.estimated_cost_missing_runs' <<<"$agg")
    legacy_cost=$(jq -r '.meta.legacy_cost_runs' <<<"$agg")
    oldest=$(jq -r '.meta.oldest_started // "-"' <<<"$agg")
    newest=$(jq -r '.meta.newest_started // "-"' <<<"$agg")

    echo "$RULE_MAJOR"
    echo "Mefisto - Reporte agregado de metricas del pipeline interno"
    echo "$RULE_MAJOR"
    echo "Filtro --desde: $desde"
    echo "Corridas mefisto-tooling en la ventana: $total (instrumentadas: $instr, sin instrumentar: $legacy)"
    echo "Costo estimado con valor: $estimated corridas (completas: $complete, parciales: $partial); sin estimacion: $missing"
    echo "Costo reportado legado: $legacy_cost corridas (separado; excluido de estimados)"
    if [ "$total" -gt 0 ]; then
        echo "Rango: $oldest -> $newest"
    fi
}

render_tool_ranking() {
    local agg="$1"
    local n count
    n=$(jq -r '.meta.instrumented' <<<"$agg")
    count=$(jq -r '.tool_ranking | length' <<<"$agg")

    echo ""
    echo "$RULE_MINOR"
    echo "RANKING DE HERRAMIENTAS (n=$n corridas instrumentadas)"
    echo "$RULE_MINOR"

    if [ "$count" -eq 0 ]; then
        echo "(sin tool calls en corridas instrumentadas dentro de la ventana)"
        return 0
    fi

    printf '%-18s %10s %14s %16s %10s\n' "Herramienta" "Llamadas" "Tiempo total" "Mediana/llamada" "% tiempo"
    while IFS=$'\t' read -r name calls time_s median_s pct; do
        local time_disp median_disp pct_disp
        time_disp=$(_secs "$time_s")
        median_disp=$(_secs "$median_s")
        pct_disp=$(fmt_pct "$pct")
        printf '%-18s %10s %14s %16s %10s\n' "$name" "$calls" "$time_disp" "$median_disp" "$pct_disp"
    done < <(jq -r "$JQ_ROW"'.tool_ranking[] | [.name, .calls, (.time_ms/1000), (if .median_ms == null then null else (.median_ms/1000) end), .pct] | row' <<<"$agg")

    echo ""
    echo "Nota: 'Mediana/llamada' es la mediana de las medianas por corrida (el"
    echo "      historial guarda por stage solo suma+mediana, no cada llamada);"
    echo "      leela como orden de magnitud, no como percentil exacto."
}

render_wallclock() {
    local agg="$1"
    local n
    n=$(jq -r '.wallclock.aggregate.n' <<<"$agg")

    echo ""
    echo "$RULE_MINOR"
    echo "REPARTO DEL WALL-CLOCK (n=$n corridas instrumentadas)"
    echo "$RULE_MINOR"

    if [ "$n" -eq 0 ]; then
        echo "(sin corridas instrumentadas en la ventana -- ver SIN INSTRUMENTAR)"
        return 0
    fi

    local api_s non_api_s tool_s pct_api pct_non_api pct_tool
    IFS=$'\t' read -r api_s non_api_s tool_s pct_api pct_non_api pct_tool < <(jq -r "$JQ_ROW"'
        .wallclock.aggregate
        | [(.api_ms/1000), (.non_api_ms/1000), (.tool_ms/1000), .pct_api, .pct_non_api, .pct_tool_of_non_api]
        | row' <<<"$agg")

    printf 'Agregado: API %s (%s)  No-API %s (%s)\n' \
        "$(_secs "$api_s")" "$(fmt_pct "$pct_api")" "$(_secs "$non_api_s")" "$(fmt_pct "$pct_non_api")"
    printf '  De lo no-API, atribuible a tool calls: %s (%s del no-API)\n' \
        "$(_secs "$tool_s")" "$(fmt_pct "$pct_tool")"
    echo "  (las tool calls en paralelo se suman por separado, asi que ese % puede pasar de 100)"

    echo ""
    echo "Por corrida:"
    printf '%-8s %-17s %-11s %8s %8s %8s %8s %7s %10s %-14s %10s %9s\n' \
        "Issue" "Inicio" "Estado" "Wall" "API" "No-API" "Tools" "%API" "Costo est." "Cobertura est." "Costo leg." "SHA"
    while IFS=$'\t' read -r issue started state wall_s run_api run_non_api run_tool pct_a estimated_cost estimated_status legacy_cost sha; do
        printf '#%-7s %-17s %-11s %8s %8s %8s %8s %7s %10s %-14s %10s %9s\n' \
            "$issue" "$(_txt "$started")" "$(_txt "$state")" \
            "$(_secs0 "$wall_s")" "$(_secs "$run_api")" "$(_secs "$run_non_api")" \
            "$(_secs "$run_tool")" "$(fmt_pct "$pct_a")" "$(_money "$estimated_cost")" \
            "$estimated_status" "$(_money "$legacy_cost")" "$(_txt "$sha")"
    done < <(jq -r "$JQ_ROW"'.wallclock.per_run[] | [.issue, .started, .state, .wall_s, (.api_ms/1000), (.non_api_ms/1000), (.tool_ms/1000), .pct_api, .estimated_cost_usd, .estimated_cost_status, .legacy_reported_cost_usd, .harness_sha] | row' <<<"$agg")

    echo ""
    echo "Writer vs Reviewer:"
    local w_n w_turns w_tin w_tout w_cread w_cwrite w_reasoning w_est_mean w_est_total w_legacy_mean w_legacy_total w_dur w_api w_nonapi
    IFS=$'\t' read -r w_n w_turns w_tin w_tout w_cread w_cwrite w_reasoning w_est_mean w_est_total w_legacy_mean w_legacy_total w_dur w_api w_nonapi < <(jq -r "$JQ_ROW"'
        .wallclock.writer
        | [.n, .turns_mean, .tokens_input_mean, .tokens_output_mean, .tokens_cache_read_mean, .tokens_cache_write_mean, .tokens_reasoning_mean,
           .estimated_cost_usd_mean, .estimated_cost_usd_total, .legacy_reported_cost_usd_mean, .legacy_reported_cost_usd_total,
           (if .duration_ms_mean == null then null else .duration_ms_mean/1000 end),
           (if .duration_api_ms_mean == null then null else .duration_api_ms_mean/1000 end),
           (if .non_api_ms_mean == null then null else .non_api_ms_mean/1000 end)]
        | row' <<<"$agg")
    local r_n r_turns r_tin r_tout r_cread r_cwrite r_reasoning r_est_mean r_est_total r_legacy_mean r_legacy_total r_dur r_api r_nonapi
    IFS=$'\t' read -r r_n r_turns r_tin r_tout r_cread r_cwrite r_reasoning r_est_mean r_est_total r_legacy_mean r_legacy_total r_dur r_api r_nonapi < <(jq -r "$JQ_ROW"'
        .wallclock.reviewer
        | [.n, .turns_mean, .tokens_input_mean, .tokens_output_mean, .tokens_cache_read_mean, .tokens_cache_write_mean, .tokens_reasoning_mean,
           .estimated_cost_usd_mean, .estimated_cost_usd_total, .legacy_reported_cost_usd_mean, .legacy_reported_cost_usd_total,
           (if .duration_ms_mean == null then null else .duration_ms_mean/1000 end),
           (if .duration_api_ms_mean == null then null else .duration_api_ms_mean/1000 end),
           (if .non_api_ms_mean == null then null else .non_api_ms_mean/1000 end)]
        | row' <<<"$agg")

    printf '%-24s %14s %14s\n' "" "Writer" "Reviewer"
    printf '%-24s %14s %14s\n' "Corridas (n)" "$w_n" "$r_n"
    printf '%-24s %14s %14s\n' "Turnos medios" "$(_num1 "$w_turns")" "$(_num1 "$r_turns")"
    printf '%-24s %14s %14s\n' "Tokens in medios" "$(_num0 "$w_tin")" "$(_num0 "$r_tin")"
    printf '%-24s %14s %14s\n' "Tokens out medios" "$(_num0 "$w_tout")" "$(_num0 "$r_tout")"
    printf '%-24s %14s %14s\n' "Cache read medio" "$(_num0 "$w_cread")" "$(_num0 "$r_cread")"
    printf '%-24s %14s %14s\n' "Cache write medio" "$(_num0 "$w_cwrite")" "$(_num0 "$r_cwrite")"
    printf '%-24s %14s %14s\n' "Reasoning medio" "$(_num0 "$w_reasoning")" "$(_num0 "$r_reasoning")"
    printf '%-24s %14s %14s\n' "Costo estimado medio" "$(_money "$w_est_mean")" "$(_money "$r_est_mean")"
    printf '%-24s %14s %14s\n' "Costo estimado total" "$(_money "$w_est_total")" "$(_money "$r_est_total")"
    printf '%-24s %14s %14s\n' "Costo legado reportado" "$(_money "$w_legacy_mean")" "$(_money "$r_legacy_mean")"
    printf '%-24s %14s %14s\n' "Costo legado total" "$(_money "$w_legacy_total")" "$(_money "$r_legacy_total")"
    printf '%-24s %14s %14s\n' "Duracion media" "$(fmt_dur_s "$w_dur")" "$(fmt_dur_s "$r_dur")"
    printf '%-24s %14s %14s\n' "  de la cual API" "$(fmt_dur_s "$w_api")" "$(fmt_dur_s "$r_api")"
    printf '%-24s %14s %14s\n' "  de la cual no-API" "$(fmt_dur_s "$w_nonapi")" "$(fmt_dur_s "$r_nonapi")"
}

_num1() {
    if [ -z "$1" ] || [ "$1" = "null" ]; then echo "-"; else printf '%.1f' "$1"; fi
}

# _txt <texto|null|""> -- texto tal cual, "-" si falta. Evita que el literal
# "null" con que `row` rellena las celdas vacias llegue crudo a la pantalla.
_txt() {
    if [ -z "$1" ] || [ "$1" = "null" ]; then echo "-"; else printf '%s' "$1"; fi
}

# _secs / _secs0 <segundos|null|""> -- segundos con y sin decimal, "-" si falta.
_secs() {
    if [ -z "$1" ] || [ "$1" = "null" ]; then echo "-"; else printf '%.1fs' "$1"; fi
}

_secs0() {
    if [ -z "$1" ] || [ "$1" = "null" ]; then echo "-"; else printf '%.0fs' "$1"; fi
}

# _numk <numero|null|""> -- miles compactos (12345 -> 12.3k), "-" si falta.
# Mantiene legible la tabla de deriva ahora que lleva los cuatro desgloses de
# tokens que pide CA-4.
_numk() {
    if [ -z "$1" ] || [ "$1" = "null" ]; then echo "-"; return 0; fi
    awk -v v="$1" 'BEGIN{ if (v >= 1000) printf "%.1fk", v/1000; else printf "%.0f", v }'
}

_num0() {
    if [ -z "$1" ] || [ "$1" = "null" ]; then echo "-"; else printf '%.0f' "$1"; fi
}

_money() {
    if [ -z "$1" ] || [ "$1" = "null" ]; then echo "-"; else printf '%.2f' "$1"; fi
}

render_period_table() {
    local agg="$1" path="$2" title="$3"
    echo ""
    echo "$RULE_MINOR"
    echo "$title"
    echo "$RULE_MINOR"
    local count
    count=$(jq -r "${path} | length" <<<"$agg")
    if [ "$count" -eq 0 ]; then
        echo "(sin datos en la ventana)"
        return 0
    fi
    echo "n(t/i) = corridas totales / de ellas instrumentadas. El wall usa las"
    echo "totales; turnos, tools y tokens solo las instrumentadas."
    echo ""
    printf '%-10s %-8s %9s %9s %7s %7s %8s %8s %8s %8s %8s %7s %8s %10s %10s\n' \
        "Periodo" "n(t/i)" "WallMedia" "WallP50" "Turnos" "Tools" "Tok.in" "Tok.out" "Cache.rd" "Cache.wr" "Reason" "%rd" "n(est)" "Costo est." "Costo leg."
    while IFS=$'\t' read -r period n_total n_instr wall_mean wall_median turns tools tin tout crd cwr reasoning cache_pct estimated_n estimated_mean legacy_mean; do
        local cache_disp
        if [ "$cache_pct" = "null" ]; then cache_disp="-"; else cache_disp=$(printf '%.1f%%' "$cache_pct"); fi
        printf '%-10s %-8s %9s %9s %7s %7s %8s %8s %8s %8s %8s %7s %8s %10s %10s\n' \
            "$period" "${n_total}/${n_instr}" "$(fmt_dur_s "$wall_mean")" "$(fmt_dur_s "$wall_median")" \
            "$(_num1 "$turns")" "$(_num1 "$tools")" "$(_numk "$tin")" "$(_numk "$tout")" \
            "$(_numk "$crd")" "$(_numk "$cwr")" "$(_numk "$reasoning")" "$cache_disp" \
            "${estimated_n}/${n_instr}" "$(_money "$estimated_mean")" "$(_money "$legacy_mean")"
    done < <(jq -r "$JQ_ROW ${path}[] | [.period, .n_total, .n_instrumented, .wall_mean_s, .wall_median_s, .turns_mean, .tool_calls_mean, .tokens_input_mean, .tokens_output_mean, .cache_read_mean, .cache_write_mean, .reasoning_mean, .cache_read_pct, .estimated_cost_n, .estimated_cost_usd_mean, .legacy_reported_cost_usd_mean] | row" <<<"$agg")
    echo ""
    echo "%rd = cache_read / (cache_read + cache_write): cae cuando el contexto"
    echo "      deja de acertar en cache."
}

render_comparison() {
    local agg="$1"
    echo ""
    echo "$RULE_MINOR"
    echo "RESUMEN: QUE CRECIO (primer vs ultimo mes con corridas instrumentadas)"
    echo "$RULE_MINOR"

    local has_cmp
    has_cmp=$(jq -r 'if .comparison == null then "no" else "yes" end' <<<"$agg")
    if [ "$has_cmp" = "no" ]; then
        echo "(se necesitan al menos 2 meses con corridas instrumentadas para comparar)"
        return 0
    fi

    local fp fn lp ln
    fp=$(jq -r '.comparison.first.period' <<<"$agg")
    fn=$(jq -r '.comparison.first.n_instrumented' <<<"$agg")
    lp=$(jq -r '.comparison.last.period' <<<"$agg")
    ln=$(jq -r '.comparison.last.n_instrumented' <<<"$agg")
    local fen len
    fen=$(jq -r '.comparison.first.estimated_cost_n' <<<"$agg")
    len=$(jq -r '.comparison.last.estimated_cost_n' <<<"$agg")
    echo "Comparando $fp (n=$fn; costo estimado=$fen/$fn) vs $lp (n=$ln; costo estimado=$len/$ln):"
    echo "Todas las filas, el wall incluido, se calculan solo sobre esas corridas"
    echo "instrumentadas -- si no compartieran denominador la atribucion no valdria."
    echo ""
    printf '%-22s %12s %12s %12s\n' "Metrica" "Primero" "Ultimo" "Variacion"

    while IFS=$'\t' read -r label unit first last pct; do
        local first_disp last_disp
        if [ "$unit" = "s" ]; then
            first_disp=$(fmt_dur_s "$first")
            last_disp=$(fmt_dur_s "$last")
        elif [ "$unit" = "count0" ]; then
            first_disp=$(_num0 "$first")
            last_disp=$(_num0 "$last")
        elif [ "$unit" = "usd" ]; then
            first_disp=$(_money "$first")
            last_disp=$(_money "$last")
        else
            first_disp=$(_num1 "$first")
            last_disp=$(_num1 "$last")
        fi
        printf '%-22s %12s %12s %12s\n' "$label" "$first_disp" "$last_disp" "$(fmt_signed_pct "$pct")"
    done < <(jq -r "$JQ_ROW"'.comparison.deltas[] | [.label, .unit, .first, .last, .pct] | row' <<<"$agg")
}

# render_by_version -- issue #664: una fila por harness_version presente en el
# historial (mas "(sin version)" para el historial previo a #662), restringiendo
# a esa version los mismos agregados de wallclock/turnos/costo que el resto
# del reporte. Mismo shape que la seccion homologa del reporte publicado (#663).
render_by_version() {
    local agg="$1"
    local count
    count=$(jq -r '.by_version | length' <<<"$agg")

    echo ""
    echo "$RULE_MINOR"
    echo "POR VERSION DE HARNESS (n = corridas totales/instrumentadas de esa version)"
    echo "$RULE_MINOR"

    if [ "$count" -eq 0 ]; then
        echo "(sin corridas en la ventana)"
        return 0
    fi

    echo "n(t/i) = corridas totales / de ellas instrumentadas. A diferencia de la"
    echo "deriva temporal, aqui TODAS las cifras -- el wall incluido -- salen solo"
    echo "de las instrumentadas: comparar dos versiones exige el mismo denominador."
    echo ""
    printf '%-20s %-8s %10s %7s %7s %10s\n' "Version" "n(t/i)" "WallMedia" "Turnos" "%API" "Costo est."
    while IFS=$'\t' read -r version n_total n_instr wall_mean turns pct_api cost_mean; do
        printf '%-20s %-8s %10s %7s %7s %10s\n' \
            "$(_txt "$version")" "${n_total}/${n_instr}" \
            "$(fmt_dur_s "$wall_mean")" "$(_num1 "$turns")" "$(fmt_pct "$pct_api")" "$(_money "$cost_mean")"
    done < <(jq -r "$JQ_ROW"'.by_version[] | [.version, .n_total, .n_instrumented, .wall_mean_instr_s, .turns_mean, .pct_api, .estimated_cost_usd_mean] | row' <<<"$agg")
}

# render_by_runtime -- issue #908: una fila por "runtime" de nivel de corrida
# presente en el historial (mas "(sin runtime)" para el historial previo a
# esta anotacion), restringiendo a ese runtime los mismos agregados de
# wallclock/turnos/costo que POR VERSION DE HARNESS. No asume ningun nombre
# de runtime concreto (CA-2): el valor sale tal cual de "runtime", sin lista
# fija de ids.
render_by_runtime() {
    local agg="$1"
    local count
    count=$(jq -r '.by_runtime | length' <<<"$agg")

    echo ""
    echo "$RULE_MINOR"
    echo "POR RUNTIME (n = corridas totales/instrumentadas de ese runtime)"
    echo "$RULE_MINOR"

    if [ "$count" -eq 0 ]; then
        echo "(sin corridas en la ventana)"
        return 0
    fi

    echo "n(t/i) = corridas totales / de ellas instrumentadas. Mismo criterio que POR"
    echo "VERSION DE HARNESS: todas las cifras -- el wall incluido -- salen solo de las"
    echo "instrumentadas."
    echo ""
    printf '%-20s %-8s %10s %7s %7s %10s\n' "Runtime" "n(t/i)" "WallMedia" "Turnos" "%API" "Costo est."
    while IFS=$'\t' read -r runtime n_total n_instr wall_mean turns pct_api cost_mean; do
        printf '%-20s %-8s %10s %7s %7s %10s\n' \
            "$(_txt "$runtime")" "${n_total}/${n_instr}" \
            "$(fmt_dur_s "$wall_mean")" "$(_num1 "$turns")" "$(fmt_pct "$pct_api")" "$(_money "$cost_mean")"
    done < <(jq -r "$JQ_ROW"'.by_runtime[] | [.runtime, .n_total, .n_instrumented, .wall_mean_instr_s, .turns_mean, .pct_api, .estimated_cost_usd_mean] | row' <<<"$agg")
}

render_legacy() {
    local agg="$1"
    local count
    count=$(jq -r '.legacy.count' <<<"$agg")
    echo ""
    echo "$RULE_MINOR"
    echo "SIN INSTRUMENTAR (n=$count -- corridas previas a #426, solo duracion total)"
    echo "$RULE_MINOR"
    if [ "$count" -eq 0 ]; then
        echo "(ninguna en la ventana)"
        return 0
    fi
    while IFS=$'\t' read -r issue started state; do
        printf '#%-8s %-17s %s\n' "$issue" "$(_txt "$started")" "$(_txt "$state")"
    done < <(jq -r "$JQ_ROW"'.legacy.issues[] | [.issue, .started, .state] | row' <<<"$agg")
}

main() {
    local desde=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --desde)
                [ $# -ge 2 ] || { echo "ERROR: --desde requiere un valor YYYY-MM-DD" >&2; exit 1; }
                desde="$2"
                shift 2
                ;;
            --desde=*)
                desde="${1#--desde=}"
                shift
                ;;
            -h|--help)
                cat <<'EOF'
Uso: mefisto-metrics-report.sh [--desde YYYY-MM-DD]

Reporte agregado de las corridas del pipeline mefisto-tooling: ranking de
herramientas, reparto del wall-clock (API vs no-API, writer vs reviewer),
deriva temporal semanal/mensual y agregados por harness_version (que version
corrio cada corrida, con harness_sha por-corrida en "Por corrida") y por
runtime (con que runtime corrio cada corrida). Solo lectura.
EOF
                exit 0
                ;;
            *)
                echo "ERROR: argumento desconocido: $1 (uso: --desde YYYY-MM-DD)" >&2
                exit 1
                ;;
        esac
    done

    if [ -n "$desde" ] && ! printf '%s' "$desde" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
        echo "ERROR: --desde espera formato YYYY-MM-DD (recibido: '$desde')" >&2
        exit 1
    fi

    # El historial se agrega desde las DOS ubicaciones (issue #869). Desde que
    # mefisto-tooling-pipeline.sh se traslado al layout canonico, las corridas
    # nuevas se anotan en .mefisto/pipeline/pipeline-history.jsonl mientras las
    # anteriores se quedan -- para siempre, sin migracion automatica
    # (MEF-ADR-0049 seccion 3) -- en la ubicacion legacy. Leer una sola de las dos
    # parte la serie justo en el commit del traslado: o el reporte pierde de
    # vista toda corrida nueva, o pierde los meses de historico contra los que
    # existe para comparar. Es el caso que mefisto_state_read_paths documenta
    # como propio ("un historial viejo que se queda en legacy para siempre").
    #
    # El orden de las lineas del archivo concatenado no importa: el jq de
    # compute_metrics_report_json agrupa por el campo "started" de cada linea,
    # nunca por posicion.
    local history_sources history_label history_file merged=""
    history_sources=$(mefisto_state_read_paths "pipeline-history.jsonl")

    if [ -z "$history_sources" ]; then
        # Ninguna de las dos existe todavia: se le pasa igual la canonica para
        # que el mensaje de "sin corridas registradas" nombre la ruta donde el
        # historial VA a aparecer, no una temporal.
        history_file="$MEFISTO_STATE_DIR/pipeline-history.jsonl"
        history_label="$history_file"
    elif [ "$(printf '%s\n' "$history_sources" | grep -c .)" -eq 1 ]; then
        history_file="$history_sources"
        history_label="$history_file"
    else
        merged=$(mktemp "${TMPDIR:-/tmp}/mefisto-history.XXXXXX") || merged=""
        if [ -n "$merged" ]; then
            # El trap se registra solo cuando hay algo que borrar: este script
            # no tiene otro trap EXIT que este pisaria.
            #
            # La ruta se INTERPOLA al registrar el trap, no se difiere entre
            # comillas simples: "$merged" es un local de main() y el trap EXIT
            # corre cuando main ya retorno y ese local ya no existe -- con
            # `set -u` eso aborta el shell con "merged: unbound variable" y
            # deja el reporte en exit 1 justo despues de imprimirlo entero.
            # Solo se manifiesta con las DOS ubicaciones de historial
            # presentes (la unica rama que crea temporal), que es el estado
            # normal de un repo con historico legacy.
            trap "rm -f '$merged'" EXIT
            while IFS= read -r _src; do
                [ -n "$_src" ] || continue
                cat "$_src" >> "$merged" 2>/dev/null || true
                # Sin este salto de linea defensivo, un historial legacy cuyo
                # ultimo caracter no sea '\n' pegaria su ultima corrida con la
                # primera del siguiente archivo y las DOS lineas se perderian
                # (jq las descarta como JSON invalido).
                printf '\n' >> "$merged"
            done <<< "$history_sources"
            history_file="$merged"
        else
            # Sin temporal utilizable se degrada a la canonica antes que abortar
            # el reporte entero: mejor una serie parcial que ninguna.
            history_file=$(printf '%s\n' "$history_sources" | head -n1)
        fi
        history_label=$(printf '%s\n' "$history_sources" | tr '\n' ' ' | sed 's/ $//')
    fi

    local agg
    agg=$(compute_metrics_report_json "$history_file" "$desde") || true
    if [ -z "$agg" ]; then
        echo "ERROR: no se pudo procesar el historial ($history_label)" >&2
        exit 1
    fi

    render_header "$agg"

    local total
    total=$(jq -r '.meta.total' <<<"$agg")
    if [ "$total" -eq 0 ]; then
        echo ""
        echo "(sin corridas registradas en la ventana solicitada)"
        return 0
    fi

    render_tool_ranking "$agg"
    render_wallclock "$agg"
    render_period_table "$agg" ".series.weekly" "DERIVA TEMPORAL - SEMANAL"
    render_period_table "$agg" ".series.monthly" "DERIVA TEMPORAL - MENSUAL"
    render_comparison "$agg"
    render_by_version "$agg"
    render_by_runtime "$agg"
    render_legacy "$agg"

    echo ""
    echo "$RULE_MAJOR"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
