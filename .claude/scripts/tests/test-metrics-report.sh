#!/usr/bin/env bash
# test-metrics-report.sh -- Tests del reporte agregado de metricas del pipeline
# interno (issue #427).
#
# Contexto: con las metricas por stage ya persistidas por #426 (agents.<agente>.metrics
# en pipeline-history.jsonl), faltaba la pieza que las convierte en decision --
# un reporte que responda "donde se van los 30 minutos" de un issue de tooling
# interno. mefisto-metrics-report.sh agrega TODO el historico (o una ventana
# --desde) en: ranking de herramientas (CA-2), reparto del wall-clock API vs
# no-API agregado/por-corrida/writer-vs-reviewer (CA-3), deriva temporal
# semanal/mensual (CA-4) y el conteo de corridas "sin instrumentar" -- las
# previas a #426, que solo traen la duracion plana de siempre (CA-5).
#
# Metodologia de testing (dos capas, igual que test-stage-metrics.sh /
# test-abort-log-tail.sh):
#   - compute_metrics_report_json se extrae con extract_fn + eval (NO se
#     sourcea el archivo completo: tiene `set -euo pipefail` y
#     assert_in_mefisto top-level, igual que los pipelines "ricos") y se
#     verifica con assert_field contra numeros derivados A MANO del fixture
#     (ver comentarios inline de cada bloque [C]).
#   - El resto (CLI, aborts, texto renderizado) se corre end-to-end como
#     subproceso real, dentro de un repo Mefisto de mentira (git init +
#     .claude-plugin/plugin.json minimo) para no tocar nunca
#     .claude/pipeline/pipeline-history.jsonl del repo real.
#
# Casos cubiertos:
#   [pre] El script existe, es ejecutable, y compute_metrics_report_json se
#         puede cargar.
#   [A] Historial vacio -> no falla, exit 0, "0" corridas (CA-6).
#   [B] Historial inexistente -> no falla, exit 0, mismo comportamiento (CA-6).
#   [C] Historial mixto (2 legado + 4 instrumentados completed + 1 failed con
#       reviewer sin metrics, mas una linea corrupta y una vacia) contra
#       compute_metrics_report_json: ranking de herramientas (CA-2), reparto
#       API/no-API agregado y writer vs reviewer con n distinto por agente
#       (CA-3), series semanal/mensual con cache_read_pct (CA-4), comparacion
#       primer-vs-ultimo mes (la pregunta de negocio del issue) y el conteo
#       de "sin instrumentar" (CA-5).
#   [D] El mismo historial mixto, end-to-end (stdout real del script):
#       ranking, reparto, series y SIN INSTRUMENTAR aparecen en el texto
#       renderizado (CA-2/CA-3/CA-4/CA-5/CA-6).
#   [E] --desde filtra corridas anteriores a la fecha.
#   [F] --desde con formato invalido -> aborta con mensaje claro, exit 1.
#   [G] Argumento desconocido -> aborta con mensaje claro, exit 1.
#   [H] jq ausente en PATH -> aborta con mensaje claro, exit 1 (CA-1).
#   [I] Regresion de corrimiento de columnas: una celda nula en medio de una
#       fila @tsv corria en silencio todas las columnas siguientes, porque el
#       tabulador es un caracter IFS *whitespace* y bash colapsa los
#       consecutivos (ver `JQ_ROW` en el script). Cubre mediana de herramienta
#       nula -- estado de primera clase del esquema de #426 -- y corridas sin
#       `started`.
#   [J] El RESUMEN calcula el delta de wall sobre las corridas instrumentadas,
#       el mismo denominador que turnos/tools/tokens: mezclarlos inflaba justo
#       la atribucion que el reporte existe para hacer.
#   [K] La serie temporal desglosa los tokens medios (in/out/cache_read/
#       cache_creation), no solo los de entrada (CA-4).
#   [L] Segmentacion por harness_version con harness_sha por-corrida (issue
#       #664): fixture con lineas que traen ambos campos, solo uno o ninguno.
#       by_version agrupa por harness_version (CA-1) restringiendo wall/turnos/
#       costo a cada grupo, cae a "(sin version)" para las lineas sin el campo
#       (CA-1), y harness_sha NUNCA agrupa -- viaja como columna nula/presente
#       en cada fila de per_run (CA-2). Verificado contra
#       compute_metrics_report_json y contra el render end-to-end de la
#       seccion "POR VERSION DE HARNESS" y la columna SHA de "Por corrida"
#       (CA-3), sin alterar las secciones existentes.
#   [M] Normalizacion vieja/neutral y tabla POR RUNTIME (issue #908): fixture
#       con una corrida forma vieja sin runtime de nivel de corrida, una
#       forma neutral Claude con runtime, una forma neutral de otro runtime
#       (`otro`), estimated_cost_usd:0 real y turns:null (ningun agente lo reporta), y
#       una sin instrumentar. Verifica que nada fuera de
#       normalize_agent_metrics lee los campos crudos de la forma vieja
#       (CA-1), que el ranking de herramientas admite el nombre de tool de
#       otro runtime igual que el de Claude (CA-2), que by_runtime agrupa por el
#       runtime de nivel de corrida cayendo a "(sin runtime)" para el
#       historico previo (CA-2), y que el 0 real de `otro` se agrega como
#       0 -- nunca "n/d" ni perdido -- mientras sus turnos ausentes SI
#       agregan como n/d en vez de leerse como 0 (CA-3). Verificado contra
#       compute_metrics_report_json y contra el render end-to-end de la
#       seccion "POR RUNTIME", sin alterar las secciones existentes.
#   [N] Costos estimados/legados y tokenizacion neutral (issue #1326): historias
#       solo nueva, solo legacy y mixta; ceros, nulos y alias cache_creation.
#   [O] Historial en las DOS ubicaciones (issue #869): el fixture pone una
#       corrida en .claude/pipeline/ y otra en .mefisto/pipeline/ para entrar
#       en la rama que las concatena en un temporal -- la que corre en
#       cualquier repo real con historico legacy y que ningun otro bloque
#       tocaba. Verifica que el reporte cierre en exit 0, que no imprima
#       "unbound variable" al limpiar ese temporal y que las corridas de
#       ambas ubicaciones entren en la ventana.
#
# Uso: .claude/scripts/tests/test-metrics-report.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPORT_SCRIPT="$REPO_ROOT/src/internal/scripts/mefisto-metrics-report.sh"
COMMON_SCRIPT="$REPO_ROOT/.claude/scripts/_mefisto-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

assert_field() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$desc"
    else
        fail "$desc (esperado '$expected', obtenido '$actual')"
    fi
}

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq no disponible en este entorno, no se puede correr la suite"; exit 0; }

echo "[pre] mefisto-metrics-report.sh existe y es ejecutable"
if [ -x "$REPORT_SCRIPT" ]; then
    pass "el script existe y es ejecutable"
else
    fail "no existe o no es ejecutable: $REPORT_SCRIPT"
fi

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# extract_fn <function_name> <file>
#
# Extrae el cuerpo de una funcion bash desde "<nombre>() {" hasta el "}" que
# cierra en columna 0 (mismo patron que test-abort-log-tail.sh /
# test-pr-reuse-gate.sh). No sourceamos mefisto-metrics-report.sh completo:
# tiene `set -euo pipefail` + assert_in_mefisto top-level, igual que los
# pipelines "ricos" -- sourcearlo disparia ese codigo en este shell.
extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

CMR_BODY=$(extract_fn "compute_metrics_report_json" "$REPORT_SCRIPT")
if [ -n "$CMR_BODY" ]; then
    eval "$CMR_BODY"
fi

if declare -F compute_metrics_report_json >/dev/null 2>&1 || [ -n "$CMR_BODY" ]; then
    pass "compute_metrics_report_json se pudo extraer y cargar"
else
    fail "no se pudo extraer/cargar compute_metrics_report_json"
fi

# --- Repo Mefisto de mentira para las pruebas end-to-end (CLI real, sin tocar el repo real) ---
FAKE_REPO="$TMP/fake-mefisto"
mkdir -p "$FAKE_REPO/.claude-plugin" "$FAKE_REPO/.claude/scripts" "$FAKE_REPO/.claude/pipeline" "$FAKE_REPO/src/internal/scripts/lib" "$FAKE_REPO/src/runtime/lib"
git -C "$FAKE_REPO" init -q
echo '{"name":"mefisto"}' > "$FAKE_REPO/.claude-plugin/plugin.json"
cp "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh" "$FAKE_REPO/src/internal/scripts/lib/_mefisto-common.sh"
cp "$COMMON_SCRIPT" "$FAKE_REPO/.claude/scripts/_mefisto-common.sh"
cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FAKE_REPO/src/internal/scripts/lib/mefisto-state.sh"
cp "$REPO_ROOT/src/runtime/lib/mefisto-process.sh" "$FAKE_REPO/src/runtime/lib/mefisto-process.sh"
cp "$REPORT_SCRIPT" "$FAKE_REPO/src/internal/scripts/mefisto-metrics-report.sh"
cp "$REPO_ROOT/.claude/scripts/mefisto-metrics-report.sh" "$FAKE_REPO/.claude/scripts/mefisto-metrics-report.sh"
chmod +x "$FAKE_REPO/src/internal/scripts/mefisto-metrics-report.sh"
chmod +x "$FAKE_REPO/.claude/scripts/mefisto-metrics-report.sh"

run_report() {
    # `env -u` de las MEFISTO_* de estado: esta suite corre dentro de una
    # invocacion real del pipeline interno, que EXPORTA MEFISTO_STATE_DIR /
    # MEFISTO_LEGACY_STATE_DIR apuntando al repo REAL (mefisto-state.sh los
    # resuelve con `: "${VAR:=...}"`, respetando a proposito un valor previo del
    # entorno). Sin desmontarlos aqui, el reporte lanzado contra FAKE_REPO
    # agregaria el historial del repo real -- y las aserciones de conteo de
    # abajo, calibradas sobre el fixture, medirian corridas ajenas.
    (cd "$FAKE_REPO" && env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
        -u MEFISTO_REPO_ROOT ./.claude/scripts/mefisto-metrics-report.sh "$@")
}

echo ""
echo "[A] Historial vacio -> no falla, exit 0, 0 corridas (CA-6)"

: > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl"
OUT=$(run_report)
RC=$?
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "ventana: 0 "; then
    pass "historial vacio: exit 0 y reporta 0 corridas"
else
    fail "historial vacio: se esperaba exit 0 y '0 corridas', se obtuvo rc=$RC: $OUT"
fi

echo ""
echo "[B] Historial inexistente -> no falla, exit 0, mismo comportamiento (CA-6)"

rm -f "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl"
OUT=$(run_report)
RC=$?
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "ventana: 0 "; then
    pass "historial inexistente: exit 0 y reporta 0 corridas"
else
    fail "historial inexistente: se esperaba exit 0 y '0 corridas', se obtuvo rc=$RC: $OUT"
fi

# --- Fixture mixto: 2 legado (pre-#426, sin "metrics") + 4 completed instrumentados
#     + 1 failed con metrics de writer pero reviewer sin metrics (murio antes de
#     esa fase) + una linea corrupta y una vacia (tolerancia, igual que
#     compute_stage_metrics). Los numeros esperados en el bloque [C] se derivaron
#     A MANO sumando estos mismos campos -- no son "lo que el script imprime".
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"100","title":"Legacy issue mayo","pipeline":"mefisto-tooling","started":"20260505-090000","finished":"2026-05-05T09:07:00","state":"completed","agents":{"writer":{"duration":250},"reviewer":{"duration":170}},"pr":"https://github.com/x/x/pull/100"}

{ esto no es json valido, deberia ignorarse sin abortar
{"issue":"101","title":"Legacy issue junio","pipeline":"mefisto-tooling","started":"20260610-090000","finished":"2026-06-10T09:10:00","state":"completed","agents":{"writer":{"duration":330},"reviewer":{"duration":270}},"pr":"https://github.com/x/x/pull/101"}
{"issue":"200","title":"Nuevo instrumentado semana1","pipeline":"mefisto-tooling","started":"20260706-090000","finished":"2026-07-06T09:12:00","state":"completed","agents":{"writer":{"duration":320,"metrics":{"turns":8,"duration_ms":320000,"duration_api_ms":250000,"non_api_ms":70000,"cost_usd":0.45,"tokens":{"input":12000,"output":1800,"cache_read":40000,"cache_creation":6000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1200,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":10,"duration_ms_sum":8000,"duration_ms_median":700},{"name":"Bash","count":5,"duration_ms_sum":15000,"duration_ms_median":2500},{"name":"Edit","count":6,"duration_ms_sum":6000,"duration_ms_median":900}]}},"reviewer":{"duration":220,"metrics":{"turns":5,"duration_ms":220000,"duration_api_ms":180000,"non_api_ms":40000,"cost_usd":0.30,"tokens":{"input":9000,"output":1200,"cache_read":30000,"cache_creation":4000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1100,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":6,"duration_ms_sum":4000,"duration_ms_median":650},{"name":"Bash","count":3,"duration_ms_sum":9000,"duration_ms_median":3000}]}}},"pr":"https://github.com/x/x/pull/200"}
{"issue":"201","title":"Nuevo instrumentado semana1b","pipeline":"mefisto-tooling","started":"20260707-100000","finished":"2026-07-07T10:15:00","state":"completed","agents":{"writer":{"duration":300,"metrics":{"turns":7,"duration_ms":300000,"duration_api_ms":230000,"non_api_ms":70000,"cost_usd":0.40,"tokens":{"input":11000,"output":1600,"cache_read":38000,"cache_creation":5000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1300,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":9,"duration_ms_sum":7000,"duration_ms_median":600},{"name":"Bash","count":4,"duration_ms_sum":11000,"duration_ms_median":2200}]}},"reviewer":{"duration":210,"metrics":{"turns":4,"duration_ms":210000,"duration_api_ms":170000,"non_api_ms":40000,"cost_usd":0.28,"tokens":{"input":8500,"output":1100,"cache_read":28000,"cache_creation":3500},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1050,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Edit","count":5,"duration_ms_sum":5000,"duration_ms_median":800}]}}},"pr":"https://github.com/x/x/pull/201"}
{"issue":"210","title":"Nuevo instrumentado semana2 mas lento","pipeline":"mefisto-tooling","started":"20260720-090000","finished":"2026-07-20T09:34:00","state":"completed","agents":{"writer":{"duration":900,"metrics":{"turns":22,"duration_ms":900000,"duration_api_ms":650000,"non_api_ms":250000,"cost_usd":1.1,"tokens":{"input":45000,"output":5200,"cache_read":60000,"cache_creation":40000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":2100,"permission_denials":1,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":30,"duration_ms_sum":24000,"duration_ms_median":650},{"name":"Bash","count":18,"duration_ms_sum":70000,"duration_ms_median":3500},{"name":"Edit","count":12,"duration_ms_sum":18000,"duration_ms_median":1200}]}},"reviewer":{"duration":480,"metrics":{"turns":10,"duration_ms":480000,"duration_api_ms":380000,"non_api_ms":100000,"cost_usd":0.6,"tokens":{"input":20000,"output":2500,"cache_read":35000,"cache_creation":15000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1500,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":14,"duration_ms_sum":11000,"duration_ms_median":700},{"name":"Bash","count":6,"duration_ms_sum":21000,"duration_ms_median":3000}]}}},"pr":"https://github.com/x/x/pull/210"}
{"issue":"215","title":"Fallido en reviewer","pipeline":"mefisto-tooling","started":"20260722-110000","finished":"2026-07-22T11:20:00","state":"failed","stage":"reviewer","agents":{"writer":{"duration":400,"metrics":{"turns":9,"duration_ms":400000,"duration_api_ms":300000,"non_api_ms":100000,"cost_usd":0.5,"tokens":{"input":15000,"output":2000,"cache_read":30000,"cache_creation":8000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1400,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Bash","count":7,"duration_ms_sum":20000,"duration_ms_median":2800}]}},"reviewer":{"duration":null,"metrics":null}},"error":"timeout"}
{"issue":"230","title":"Nuevo instrumentado agosto mucho mas lento","pipeline":"mefisto-tooling","started":"20260803-090000","finished":"2026-08-03T09:37:00","state":"completed","agents":{"writer":{"duration":1400,"metrics":{"turns":30,"duration_ms":1400000,"duration_api_ms":900000,"non_api_ms":500000,"cost_usd":1.8,"tokens":{"input":60000,"output":7000,"cache_read":50000,"cache_creation":70000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":2500,"permission_denials":2,"rate_limit_events":1,"tool_calls":[{"name":"Read","count":40,"duration_ms_sum":32000,"duration_ms_median":700},{"name":"Bash","count":25,"duration_ms_sum":100000,"duration_ms_median":3800},{"name":"Edit","count":15,"duration_ms_sum":25000,"duration_ms_median":1300}]}},"reviewer":{"duration":700,"metrics":{"turns":14,"duration_ms":700000,"duration_api_ms":500000,"non_api_ms":200000,"cost_usd":0.9,"tokens":{"input":28000,"output":3500,"cache_read":25000,"cache_creation":30000},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":1800,"permission_denials":0,"rate_limit_events":0,"tool_calls":[{"name":"Read","count":18,"duration_ms_sum":14000,"duration_ms_median":720},{"name":"Bash","count":10,"duration_ms_sum":35000,"duration_ms_median":3400}]}}},"pr":"https://github.com/x/x/pull/230"}
EOF

echo ""
echo "[C] Historial mixto contra compute_metrics_report_json (numeros derivados a mano)"

AGG=$(compute_metrics_report_json "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" "")

echo "  -- meta / tolerancia a linea corrupta y vacia (CA-5) --"
assert_field "C-1: total (7 validas; la linea corrupta se ignora)" "7" "$(echo "$AGG" | jq -r '.meta.total')"
assert_field "C-2: instrumentadas" "5" "$(echo "$AGG" | jq -r '.meta.instrumented')"
assert_field "C-3: sin instrumentar (legado)" "2" "$(echo "$AGG" | jq -r '.meta.legacy')"

echo "  -- ranking de herramientas (CA-2): calls/time_ms sumados a mano sobre writer+reviewer de 200/201/210/215/230 --"
# Bash: 200w5+200r3+201w4+210w18+210r6+215w7+230w25+230r10 = 78
assert_field "C-4: Bash calls" "78" "$(echo "$AGG" | jq -r '.tool_ranking[] | select(.name=="Bash") | .calls')"
# Bash time_ms: 15000+9000+11000+70000+21000+20000+100000+35000 = 281000
assert_field "C-5: Bash time_ms" "281000" "$(echo "$AGG" | jq -r '.tool_ranking[] | select(.name=="Bash") | .time_ms')"
# Read: 200w10+200r6+201w9+210w30+210r14+230w40+230r18 = 127
assert_field "C-6: Read calls" "127" "$(echo "$AGG" | jq -r '.tool_ranking[] | select(.name=="Read") | .calls')"
assert_field "C-7: ranking ordenado por time_ms desc (Bash primero)" "Bash" "$(echo "$AGG" | jq -r '.tool_ranking[0].name')"

echo "  -- reparto del wall-clock (CA-3): API/no-API agregado sobre las 5 instrumentadas --"
# api_ms: 250000+180000+230000+170000+650000+380000+300000+900000+500000 = 3560000
assert_field "C-8: wallclock.aggregate.api_ms" "3560000" "$(echo "$AGG" | jq -r '.wallclock.aggregate.api_ms')"
# non_api_ms: 70000+40000+70000+40000+250000+100000+100000+500000+200000 = 1370000
assert_field "C-9: wallclock.aggregate.non_api_ms" "1370000" "$(echo "$AGG" | jq -r '.wallclock.aggregate.non_api_ms')"

echo "  -- writer vs reviewer (CA-3): n distinto por agente (215 solo trae writer.metrics) --"
assert_field "C-10: writer.n (las 5 instrumentadas)" "5" "$(echo "$AGG" | jq -r '.wallclock.writer.n')"
assert_field "C-11: reviewer.n (4 -- 215 murio antes del reviewer)" "4" "$(echo "$AGG" | jq -r '.wallclock.reviewer.n')"
# writer turns: 8+7+22+9+30=76 / 5 = 15.2
assert_field "C-12: writer.turns_mean (76/5)" "15.2" "$(echo "$AGG" | jq -r '.wallclock.writer.turns_mean')"
# reviewer turns: 5+4+10+14=33 / 4 = 8.25
assert_field "C-13: reviewer.turns_mean (33/4)" "8.25" "$(echo "$AGG" | jq -r '.wallclock.reviewer.turns_mean')"

echo "  -- deriva temporal (CA-4): series semanal/mensual --"
assert_field "C-14: mes 2026-07 n_total" "4" "$(echo "$AGG" | jq -r '.series.monthly[] | select(.period=="2026-07") | .n_total')"
assert_field "C-15: mes 2026-07 n_instrumented" "4" "$(echo "$AGG" | jq -r '.series.monthly[] | select(.period=="2026-07") | .n_instrumented')"
assert_field "C-16: mes 2026-05 (legado) n_instrumented=0" "0" "$(echo "$AGG" | jq -r '.series.monthly[] | select(.period=="2026-05") | .n_instrumented')"
# turns julio: (8+5)+(7+4)+(22+10)+(9+0) = 13+11+32+9 = 65 / 4 = 16.25
assert_field "C-17: mes 2026-07 turns_mean" "16.25" "$(echo "$AGG" | jq -r '.series.monthly[] | select(.period=="2026-07") | .turns_mean')"

echo "  -- comparacion primer vs ultimo mes con datos (la pregunta del issue) --"
assert_field "C-18: comparison.first.period" "2026-07" "$(echo "$AGG" | jq -r '.comparison.first.period')"
assert_field "C-19: comparison.last.period" "2026-08" "$(echo "$AGG" | jq -r '.comparison.last.period')"
TURNS_PCT=$(echo "$AGG" | jq -r '.comparison.deltas[] | select(.key=="turns_mean") | .pct')
if awk -v p="$TURNS_PCT" 'BEGIN{exit !(p>0)}'; then
    pass "C-20: turnos medios crecieron de julio a agosto (pct=$TURNS_PCT > 0)"
else
    fail "C-20: se esperaba variacion positiva en turnos, se obtuvo pct=$TURNS_PCT"
fi

echo "  -- sin instrumentar (CA-5) --"
assert_field "C-21: legacy.count" "2" "$(echo "$AGG" | jq -r '.legacy.count')"
assert_field "C-22: legacy incluye issue 100" "100" "$(echo "$AGG" | jq -r '.legacy.issues[0].issue')"
assert_field "C-23: legacy incluye issue 101" "101" "$(echo "$AGG" | jq -r '.legacy.issues[1].issue')"

echo ""
echo "[D] El mismo historial mixto, end-to-end (texto renderizado real, CA-2/CA-3/CA-4/CA-5/CA-6)"

OUT=$(run_report)
RC=$?

if [ "$RC" -eq 0 ]; then
    pass "D-1: exit 0 con historial mixto"
else
    fail "D-1: se esperaba exit 0, se obtuvo rc=$RC"
fi

if echo "$OUT" | grep -q "RANKING DE HERRAMIENTAS (n=5"; then
    pass "D-2: ranking declara n=5 corridas instrumentadas"
else
    fail "D-2: no se encontro el encabezado de ranking con n=5"
fi

if echo "$OUT" | grep -qE '^Bash +78 +281\.0s'; then
    pass "D-3: fila de Bash con calls y tiempo total correctos"
else
    fail "D-3: no se encontro la fila esperada de Bash en el ranking"
fi

if echo "$OUT" | grep -q "REPARTO DEL WALL-CLOCK"; then
    pass "D-4: seccion de reparto del wall-clock presente"
else
    fail "D-4: no se encontro la seccion de reparto del wall-clock"
fi

if echo "$OUT" | grep -q "Writer vs Reviewer:"; then
    pass "D-5: comparacion writer vs reviewer presente"
else
    fail "D-5: no se encontro la seccion writer vs reviewer"
fi

if echo "$OUT" | grep -q "DERIVA TEMPORAL - SEMANAL" && echo "$OUT" | grep -q "DERIVA TEMPORAL - MENSUAL"; then
    pass "D-6: series semanal y mensual presentes"
else
    fail "D-6: falta alguna de las series temporales"
fi

if echo "$OUT" | grep -q "2026-07 " && echo "$OUT" | grep -q "2026-08 "; then
    pass "D-7: la serie mensual incluye julio y agosto"
else
    fail "D-7: no se encontraron los periodos 2026-07/2026-08 en la serie mensual"
fi

if echo "$OUT" | grep -q "RESUMEN: QUE CRECIO" && echo "$OUT" | grep -q "Comparando 2026-07"; then
    pass "D-8: seccion RESUMEN compara 2026-07 vs 2026-08"
else
    fail "D-8: no se encontro la seccion RESUMEN esperada"
fi

if echo "$OUT" | grep -q "SIN INSTRUMENTAR (n=2" && echo "$OUT" | grep -q "#100" && echo "$OUT" | grep -q "#101"; then
    pass "D-9: seccion SIN INSTRUMENTAR con n=2 e issues 100/101"
else
    fail "D-9: no se encontro la seccion SIN INSTRUMENTAR esperada"
fi

echo ""
echo "[E] --desde filtra corridas anteriores a la fecha"

OUT=$(run_report --desde 2026-07-01)
RC=$?
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "ventana: 5 (instrumentadas: 5, sin instrumentar: 0)"; then
    pass "--desde 2026-07-01 deja solo las 5 corridas de julio/agosto"
else
    fail "--desde 2026-07-01: se esperaba 5/5/0, se obtuvo rc=$RC: $(echo "$OUT" | grep ventana)"
fi

echo ""
echo "[F] --desde con formato invalido -> aborta con mensaje claro"

OUT=$(run_report --desde 2026/07/01 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -qi "YYYY-MM-DD"; then
    pass "--desde con formato invalido aborta mencionando el formato esperado"
else
    fail "--desde invalido: se esperaba abort con mensaje de formato, se obtuvo rc=$RC: $OUT"
fi

echo ""
echo "[G] Argumento desconocido -> aborta con mensaje claro"

OUT=$(run_report --no-existe 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -qi "argumento desconocido"; then
    pass "argumento desconocido aborta con mensaje claro"
else
    fail "argumento desconocido: se esperaba abort, se obtuvo rc=$RC: $OUT"
fi

echo ""
echo "[H] jq ausente en PATH -> aborta con mensaje claro (CA-1)"

FAKE_BIN="$TMP/fake-bin"
mkdir -p "$FAKE_BIN"
for dir in /usr/bin /bin /usr/local/bin /opt/homebrew/bin; do
    [ -d "$dir" ] || continue
    for f in "$dir"/*; do
        [ -f "$f" ] || continue
        name=$(basename "$f")
        [ "$name" = "jq" ] && continue
        [ -e "$FAKE_BIN/$name" ] && continue
        ln -s "$f" "$FAKE_BIN/$name" 2>/dev/null || true
    done
done

OUT=$(cd "$FAKE_REPO" && PATH="$FAKE_BIN" ./.claude/scripts/mefisto-metrics-report.sh 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -qi "requiere jq"; then
    pass "jq ausente: aborta con mensaje claro (rc=$RC)"
else
    fail "jq ausente: se esperaba abort mencionando jq, se obtuvo rc=$RC: $OUT"
fi

echo ""
echo "[I] Celdas nulas no corren las columnas (regresion de corrimiento por @tsv)"

# Las filas se leen con `IFS=$'\t' read`, y el tabulador es un caracter IFS
# *whitespace*: bash colapsa tabuladores consecutivos y descarta los iniciales.
# Una sola celda vacia en medio de la fila corria TODAS las columnas siguientes
# una posicion a la izquierda, en silencio -- sin error y con numeros que
# parecen validos. Cada caso de abajo tiene al menos una celda nula en el medio.

# I-1: `duration_ms_median: null` es un estado de primera clase del esquema de
# #426 (tool_use sin tool_result emparejado: justo lo que pasa en los stages
# matados que este reporte existe para analizar). Antes del arreglo, el "%
# tiempo" de Read se imprimia DENTRO de la columna "Mediana/llamada".
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"300","title":"Read sin mediana derivable","pipeline":"mefisto-tooling","started":"20260706-090000","state":"completed","agents":{"writer":{"duration":100,"metrics":{"turns":3,"duration_ms":100000,"duration_api_ms":80000,"non_api_ms":20000,"cost_usd":0.1,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[{"name":"Read","count":10,"duration_ms_sum":8000,"duration_ms_median":null},{"name":"Bash","count":5,"duration_ms_sum":15000,"duration_ms_median":2500}]}},"reviewer":{"duration":null,"metrics":null}}}
EOF
OUT=$(run_report)
# Bash 15000 / (15000+8000) = 65.2% ; Read 8000/23000 = 34.8%
if echo "$OUT" | grep -qE '^Read +10 +8\.0s +- +34\.8%'; then
    pass "I-1: mediana nula -> '-' en su columna y el % en la suya (sin corrimiento)"
else
    fail "I-1: fila de Read corrida o mal formada: $(echo "$OUT" | grep '^Read' || echo '(no hay fila Read)')"
fi

# I-2: entrada sin `started`. Antes del arreglo la fila del periodo salia como
# "2  0/150" -- periodo, n_total y n_instrumented corridos desde el wall.
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"301","title":"Sin started","pipeline":"mefisto-tooling","state":"completed","agents":{"writer":{"duration":100},"reviewer":{"duration":50}}}
EOF
OUT=$(run_report)
if echo "$OUT" | grep -qE '^\(s/fecha\) +1/0 +2m30s'; then
    pass "I-2: corrida sin fecha -> periodo '(s/fecha)' con n(t/i) y wall en su columna"
else
    fail "I-2: fila de periodo sin fecha corrida: $(echo "$OUT" | grep 's/fecha' || echo '(no aparece)')"
fi

if echo "$OUT" | grep -qE '^#301 +- +completed'; then
    pass "I-2b: SIN INSTRUMENTAR muestra '-' por la fecha ausente, no el literal 'null'"
else
    fail "I-2b: fila legado mal formada: $(echo "$OUT" | grep '^#301' || echo '(no aparece)')"
fi

echo ""
echo "[J] El RESUMEN compara wall y turnos sobre el MISMO denominador"

# Si el primer mes con corridas instrumentadas tiene ademas corridas legado, el
# wall medio se calculaba sobre TODAS mientras turnos/tools/tokens se calculaban
# solo sobre las instrumentadas -- bajo un encabezado que declara n=<instrumentadas>.
# Eso inflaba justo la atribucion que el reporte existe para hacer.
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"400","title":"Legado rapido dentro de julio","pipeline":"mefisto-tooling","started":"20260705-080000","state":"completed","agents":{"writer":{"duration":40},"reviewer":{"duration":20}}}
{"issue":"401","title":"Instrumentado julio","pipeline":"mefisto-tooling","started":"20260706-090000","state":"completed","agents":{"writer":{"duration":600,"metrics":{"turns":10,"duration_ms":600000,"duration_api_ms":500000,"non_api_ms":100000,"cost_usd":0.5,"tokens":{"input":10000,"output":1000,"cache_read":9000,"cache_creation":1000},"tool_calls":[{"name":"Read","count":5,"duration_ms_sum":5000,"duration_ms_median":1000}]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"402","title":"Instrumentado agosto","pipeline":"mefisto-tooling","started":"20260803-090000","state":"completed","agents":{"writer":{"duration":1200,"metrics":{"turns":20,"duration_ms":1200000,"duration_api_ms":900000,"non_api_ms":300000,"cost_usd":1.0,"tokens":{"input":20000,"output":2000,"cache_read":10000,"cache_creation":10000},"tool_calls":[{"name":"Read","count":10,"duration_ms_sum":10000,"duration_ms_median":1000}]}},"reviewer":{"duration":null,"metrics":null}}}
EOF
AGG=$(compute_metrics_report_json "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" "")

# Julio: wall de TODAS = (60+600)/2 = 330s ; wall de las INSTRUMENTADAS = 600s.
assert_field "J-1: wall_mean_s de julio cubre las 2 corridas (tabla de deriva)" \
    "330" "$(echo "$AGG" | jq -r '.series.monthly[] | select(.period=="2026-07") | .wall_mean_s')"
assert_field "J-2: wall_mean_instr_s de julio cubre solo la instrumentada" \
    "600" "$(echo "$AGG" | jq -r '.series.monthly[] | select(.period=="2026-07") | .wall_mean_instr_s')"
# El delta del RESUMEN debe usar el instrumentado: 600 -> 1200 = +100%, no 330 -> 1200 = +263.6%.
assert_field "J-3: el delta de wall del RESUMEN usa el denominador instrumentado" \
    "600" "$(echo "$AGG" | jq -r '.comparison.deltas[] | select(.key=="wall_mean_s") | .first')"
assert_field "J-4: y por tanto la variacion es +100%, no la inflada por el legado" \
    "100" "$(echo "$AGG" | jq -r '.comparison.deltas[] | select(.key=="wall_mean_s") | .pct')"

echo ""
echo "[K] La tabla de deriva desglosa los tokens medios (CA-4)"

OUT=$(run_report)
if echo "$OUT" | grep -q "Tok.in" && echo "$OUT" | grep -q "Tok.out" \
   && echo "$OUT" | grep -q "Cache.rd" && echo "$OUT" | grep -q "Cache.wr" && echo "$OUT" | grep -q "Reason"; then
    pass "K-1: la serie temporal trae input, output, cache_read/cache_write y reasoning"
else
    fail "K-1: falta alguna columna del desglose de tokens en la serie temporal"
fi

if echo "$OUT" | grep -qE '^2026-08 +1/1 +20m00s +20m00s +20\.0 +10\.0 +20\.0k +2\.0k +10\.0k +10\.0k +- +50\.0%'; then
    pass "K-2: fila mensual completa y alineada (agosto: 20k in / 2k out / 50% cache read)"
else
    fail "K-2: fila mensual de agosto corrida o mal formada: $(echo "$OUT" | grep '^2026-08' || echo '(no aparece)')"
fi

echo ""
echo "[L] Segmentacion por harness_version con harness_sha por-corrida (issue #664)"

# Mezcla: 900/910 en "0.9.0" (900 trae ademas harness_sha, 910 no) + 920 sin
# harness_version pero con harness_sha (cae a "(sin version)") + 930 sin
# ninguno de los dos campos (historial previo a #662). Los numeros esperados
# se derivaron a mano sumando estos mismos campos (mismo criterio que [C]/[J]).
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"900","title":"Con version y sha","pipeline":"mefisto-tooling","harness_version":"0.9.0","harness_sha":"aaa1111","started":"20260810-090000","state":"completed","agents":{"writer":{"duration":100,"metrics":{"turns":10,"duration_ms":100000,"duration_api_ms":80000,"non_api_ms":20000,"cost_usd":0.5,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"910","title":"Con version, sin sha","pipeline":"mefisto-tooling","harness_version":"0.9.0","started":"20260811-090000","state":"completed","agents":{"writer":{"duration":200,"metrics":{"turns":20,"duration_ms":200000,"duration_api_ms":150000,"non_api_ms":50000,"cost_usd":0.7,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"920","title":"Sin version, con sha","pipeline":"mefisto-tooling","harness_sha":"ccc3333","started":"20260812-090000","state":"completed","agents":{"writer":{"duration":50,"metrics":{"turns":5,"duration_ms":50000,"duration_api_ms":30000,"non_api_ms":20000,"cost_usd":0.2,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"930","title":"Sin version ni sha (historial previo a #662)","pipeline":"mefisto-tooling","started":"20260813-090000","state":"completed","agents":{"writer":{"duration":150,"metrics":{"turns":12,"duration_ms":150000,"duration_api_ms":100000,"non_api_ms":50000,"cost_usd":0.3,"tokens":{"input":1000,"output":100,"cache_read":900,"cache_creation":100},"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
EOF

AGG_L=$(compute_metrics_report_json "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" "")

echo "  -- by_version (CA-1): 900/910 agrupan bajo 0.9.0, 920/930 caen a (sin version) --"
assert_field "L-1: dos grupos en by_version (0.9.0, sin version)" "2" "$(echo "$AGG_L" | jq -r '.by_version | length')"
assert_field "L-2: 0.9.0.n_total (900+910)" "2" "$(echo "$AGG_L" | jq -r '.by_version[] | select(.version=="0.9.0") | .n_total')"
assert_field "L-3: 0.9.0.turns_mean (10+20)/2" "15" "$(echo "$AGG_L" | jq -r '.by_version[] | select(.version=="0.9.0") | .turns_mean')"
assert_field "L-4: 0.9.0 no convierte costo legacy en estimacion" "null" "$(echo "$AGG_L" | jq -r '.by_version[] | select(.version=="0.9.0") | .estimated_cost_usd_mean')"
assert_field "L-5: 0.9.0.wall_mean_instr_s (100+200)/2" "150" "$(echo "$AGG_L" | jq -r '.by_version[] | select(.version=="0.9.0") | .wall_mean_instr_s')"
assert_field "L-6: (sin version).n_total (920+930, con o sin sha)" "2" "$(echo "$AGG_L" | jq -r '.by_version[] | select(.version=="(sin version)") | .n_total')"
assert_field "L-7: (sin version).turns_mean (5+12)/2" "8.5" "$(echo "$AGG_L" | jq -r '.by_version[] | select(.version=="(sin version)") | .turns_mean')"

echo "  -- harness_sha NUNCA agrupa, solo columna en per_run (CA-2) --"
assert_field "L-8: per_run de 900 trae su harness_sha" "aaa1111" "$(echo "$AGG_L" | jq -r '.wallclock.per_run[] | select(.issue=="900") | .harness_sha')"
assert_field "L-9: per_run de 910 (sin sha) trae null" "null" "$(echo "$AGG_L" | jq -r '.wallclock.per_run[] | select(.issue=="910") | .harness_sha')"
assert_field "L-10: per_run de 920 (sin version, con sha) trae su sha" "ccc3333" "$(echo "$AGG_L" | jq -r '.wallclock.per_run[] | select(.issue=="920") | .harness_sha')"
assert_field "L-11: per_run de 930 (sin ninguno) trae null" "null" "$(echo "$AGG_L" | jq -r '.wallclock.per_run[] | select(.issue=="930") | .harness_sha')"

echo "  -- render end-to-end: seccion POR VERSION DE HARNESS y columna SHA en Por corrida (CA-3) --"
OUT=$(run_report)
RC=$?
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "POR VERSION DE HARNESS"; then
    pass "L-12: la seccion POR VERSION DE HARNESS aparece en el render (exit 0)"
else
    fail "L-12: no aparecio la seccion POR VERSION DE HARNESS (rc=$RC)"
fi
if echo "$OUT" | grep -qE '^0\.9\.0 +2/2' && echo "$OUT" | grep -qE '^\(sin version\) +2/2'; then
    pass "L-13: las dos filas (0.9.0, (sin version)) se renderizan con su n(t/i)"
else
    fail "L-13: no se encontraron las filas esperadas: $(echo "$OUT" | grep -E '^(0\.9\.0|\(sin version\))')"
fi
if echo "$OUT" | grep -qE '^#900 .*aaa1111$'; then
    pass "L-14: la fila de la corrida 900 en 'Por corrida' muestra su SHA"
else
    fail "L-14: no se encontro la fila #900 con su SHA: $(echo "$OUT" | grep '^#900' || echo '(no aparece)')"
fi
if echo "$OUT" | grep -qE '^#910 .* -$'; then
    pass "L-15: la fila de la corrida 910 (sin sha) muestra '-' en su columna, sin corrimiento"
else
    fail "L-15: no se encontro la fila #910 con '-' en SHA: $(echo "$OUT" | grep '^#910' || echo '(no aparece)')"
fi

echo ""
echo "[M] Normalizacion vieja/neutral (CA-1) y tabla POR RUNTIME (CA-2/CA-3, issue #908)"

echo "  -- guarda de neutralidad (CA-1): nada fuera de normalize_agent_metrics lee los campos crudos de la forma vieja --"
# La guarda se aplica al jq de compute_metrics_report_json MENOS el bloque de
# normalize_agent_metrics (la unica funcion autorizada a nombrar la forma
# vieja) y MENOS las lineas de comentario (que la describen a proposito).
#
# Y busca el IDENTIFICADOR PELADO, no `.metrics.<campo>`: ese prefijo seria
# una guarda vacua para is_error/stop_reason/terminal_reason -- el reporte no
# los leia con esa sintaxis ni antes de este issue, asi que el patron pasaria
# en verde aunque alguien cableara `$m.is_error` en pleno agregado. Con el
# identificador pelado la guarda falla exactamente cuando CA-1 dice que debe
# fallar: cuando la forma vieja se vuelve a leer fuera de la normalizacion.
M_LIVE_SRC=$(awk '/^compute_metrics_report_json\(\) \{/,/^\}/' "$REPORT_SCRIPT" \
    | awk '/^def normalize_agent_metrics:/{skip=1} skip{if ($0 == "  end;") skip=0; next} {print}' \
    | grep -v '^[[:space:]]*#')
# El identificador se ancla entre no-identificadores para que la clave de
# SALIDA duration_api_ms_mean (vocabulario del reporte desde #427, ajena a la
# forma vieja de entrada) no dispare la guarda por ser un prefijo suyo.
for pattern in 'is_error' 'stop_reason' 'terminal_reason' 'duration_api_ms'; do
    if printf '%s' "$M_LIVE_SRC" | grep -qE -- "(^|[^_[:alnum:]])${pattern}([^_[:alnum:]]|\$)"; then
        fail "M-guard: '$pattern' aparece en codigo vivo fuera de normalize_agent_metrics (deberia leerse solo via \$m dentro de esa funcion)"
    else
        pass "M-guard: '$pattern' no aparece en codigo vivo (la lectura pasa por normalize_agent_metrics)"
    fi
done
# Contraprueba de la guarda: sin ella, un cambio que borre normalize_agent_metrics
# del recorte no la haria fallar. Si el recorte quedo vacio o no incluye el resto
# del agregado, la guarda de arriba es verde por vacuidad.
if printf '%s' "$M_LIVE_SRC" | grep -q 'normalize_agent_metrics'; then
    pass "M-guard: el recorte conserva las llamadas a normalize_agent_metrics (la guarda no es verde por vacuidad)"
else
    fail "M-guard: el recorte quedo sin llamadas a normalize_agent_metrics -- la guarda de arriba no prueba nada"
fi

# Fixture: 600 forma vieja SIN runtime de nivel de corrida (historico previo a
# #907/anotacion de runtime) + 601 forma neutral Claude CON runtime + 602
# forma neutral de `otro` CON runtime, cost_usd:0 real y turns:null (ningun
# agente lo reporto) + 603 sin instrumentar (sin metrics, sin runtime). Los
# numeros esperados de abajo se derivaron a mano sumando estos mismos campos
# (mismo criterio que los bloques [C]/[J]/[L]).
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"600","title":"Forma vieja sin runtime","pipeline":"mefisto-tooling","started":"20260901-090000","state":"completed","agents":{"writer":{"duration":250,"metrics":{"turns":6,"duration_ms":200000,"duration_api_ms":150000,"non_api_ms":50000,"estimated_cost_usd":0.35,"tokens":{"input":5000,"output":700,"cache_read":4000,"cache_creation":500},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"tool_calls":[{"name":"Read","count":4,"duration_ms_sum":3000,"duration_ms_median":700}]}},"reviewer":{"duration":130,"metrics":{"turns":3,"duration_ms":100000,"duration_api_ms":70000,"non_api_ms":30000,"estimated_cost_usd":0.15,"tokens":{"input":2000,"output":300,"cache_read":1500,"cache_creation":200},"model":"claude-opus","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"tool_calls":[{"name":"Bash","count":2,"duration_ms_sum":4000,"duration_ms_median":2000}]}}}}
{"issue":"601","title":"Forma neutral Claude con runtime","pipeline":"mefisto-tooling","runtime":"claude","started":"20260902-090000","state":"completed","agents":{"writer":{"duration":310,"metrics":{"runtime":"claude","status":"success","error_kind":null,"model":"claude-sonnet-5","estimated_cost_usd":0.5,"tokens":{"input":8000,"output":900},"turns":9,"duration_ms":300000,"api_duration_ms":200000,"non_api_ms":100000,"tool_calls":[{"name":"Read","count":5,"duration_ms_sum":4000,"duration_ms_median":800}]}},"reviewer":{"duration":160,"metrics":{"runtime":"claude","status":"success","error_kind":null,"model":"claude-sonnet-5","estimated_cost_usd":0.2,"tokens":{"input":3000,"output":400},"turns":4,"duration_ms":150000,"api_duration_ms":100000,"non_api_ms":50000,"tool_calls":[{"name":"Edit","count":2,"duration_ms_sum":2000,"duration_ms_median":1000}]}}}}
{"issue":"602","title":"Forma neutral otro runtime cost 0 turns null","pipeline":"mefisto-tooling","runtime":"otro","started":"20260903-090000","state":"completed","agents":{"writer":{"duration":190,"metrics":{"runtime":"otro","status":"success","error_kind":null,"model":null,"estimated_cost_usd":0,"tokens":{"input":6000,"output":500},"turns":null,"duration_ms":180000,"api_duration_ms":140000,"non_api_ms":40000,"tool_calls":[{"name":"glob","count":3,"duration_ms_sum":3000,"duration_ms_median":1000}]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"603","title":"Sin instrumentar","pipeline":"mefisto-tooling","started":"20260904-090000","state":"completed","agents":{"writer":{"duration":90},"reviewer":{"duration":40}}}
EOF

AGG_M=$(compute_metrics_report_json "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" "")

echo "  -- meta --"
assert_field "M-1: total (4 lineas)" "4" "$(echo "$AGG_M" | jq -r '.meta.total')"
assert_field "M-2: instrumentadas (600/601/602)" "3" "$(echo "$AGG_M" | jq -r '.meta.instrumented')"
assert_field "M-3: sin instrumentar (603)" "1" "$(echo "$AGG_M" | jq -r '.meta.legacy')"

echo "  -- ranking de herramientas: nombre de tool de otro runtime entra igual que el de Claude (CA-2) --"
assert_field "M-4: tool_ranking incluye 'glob' (runtime otro) con sus calls" "3" "$(echo "$AGG_M" | jq -r '.tool_ranking[] | select(.name=="glob") | .calls')"

echo "  -- tabla POR RUNTIME (CA-2/CA-3): 3 grupos, claude/otro/(sin runtime) --"
assert_field "M-5: tres grupos en by_runtime" "3" "$(echo "$AGG_M" | jq -r '.by_runtime | length')"

assert_field "M-6: claude.n_total/n_instrumented" "1" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="claude") | .n_total')"
assert_field "M-7: claude.turns_mean (9+4)" "13" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="claude") | .turns_mean')"
assert_field "M-8: claude.estimated_cost_usd_mean (0.5+0.2)" "0.7" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="claude") | .estimated_cost_usd_mean')"

assert_field "M-9: otro.n_total/n_instrumented" "1" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="otro") | .n_total')"
assert_field "M-10: otro.estimated_cost_usd_mean es el 0 REAL, no n/d ni perdido" "0" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="otro") | .estimated_cost_usd_mean')"
assert_field "M-11: otro.turns_mean es null (ningun agente reporto turnos, no se cuenta como 0)" "null" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="otro") | .turns_mean')"

assert_field "M-12: (sin runtime).n_total (600+603, el historico previo)" "2" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="(sin runtime)") | .n_total')"
assert_field "M-13: (sin runtime).n_instrumented (solo 600 -- 603 no dejo metrics)" "1" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="(sin runtime)") | .n_instrumented')"
assert_field "M-14: (sin runtime).turns_mean (6+3, forma vieja normalizada)" "9" "$(echo "$AGG_M" | jq -r '.by_runtime[] | select(.runtime=="(sin runtime)") | .turns_mean')"

echo "  -- render end-to-end: seccion POR RUNTIME con el 0 de otro y el n/d de sus turnos (CA-3) --"
OUT=$(run_report)
RC=$?
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "POR RUNTIME"; then
    pass "M-15: la seccion POR RUNTIME aparece en el render (exit 0)"
else
    fail "M-15: no aparecio la seccion POR RUNTIME (rc=$RC)"
fi
if echo "$OUT" | grep -qE '^otro +1/1 +3m10s +- +77\.8% +0\.00'; then
    pass "M-16: fila otro -- turnos en '-' (n/d) y costo 0.00 (el 0 real, no perdido)"
else
    fail "M-16: no se encontro la fila otro esperada: $(echo "$OUT" | grep '^otro' || echo '(no aparece)')"
fi
if echo "$OUT" | grep -qE '^claude +1/1 +7m50s +13\.0 +66\.7% +0\.70'; then
    pass "M-17: fila claude con turnos/costo/API correctos"
else
    fail "M-17: no se encontro la fila claude esperada: $(echo "$OUT" | grep '^claude' || echo '(no aparece)')"
fi
if echo "$OUT" | grep -qE '^\(sin runtime\) +2/1 +6m20s +9\.0 +73\.3% +0\.50'; then
    pass "M-18: fila (sin runtime) agrega el historico previo a la anotacion de runtime"
else
    fail "M-18: no se encontro la fila (sin runtime) esperada: $(echo "$OUT" | grep '^(sin runtime)' || echo '(no aparece)')"
fi

echo ""
echo "[N] Costos estimados/legados y tokens neutrales (issue #1326)"

# 800 es historia solo nueva: conserva el cero estimado y los cinco desgloses.
# 801 es solo legacy: incluso su cero queda fuera de toda cifra estimada. 802
# mezcla ambos campos: estimated_cost_usd gana, por lo que cost_usd no se duplica.
# 803 deja una estimacion nula para que el reporte declare su ausencia. En 802,
# el reviewer instrumentado no pudo estimar, por lo que la corrida queda parcial.
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"800","pipeline":"mefisto-tooling","runtime":"otro","started":"20260910-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":0,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"801","pipeline":"mefisto-tooling","started":"20260911-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"cost_usd":0,"tokens":{"input":10,"output":2,"cache_read":3,"cache_creation":7},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
{"issue":"802","pipeline":"mefisto-tooling","started":"20260912-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":2,"cost_usd":99,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":1,"metrics":{"estimated_cost_usd":null,"tokens":{"input":null,"output":null,"cache_read":null,"cache_write":null,"reasoning":null},"turns":null,"duration_ms":1000,"api_duration_ms":null,"tool_calls":[]}}}}
{"issue":"803","pipeline":"mefisto-tooling","started":"20260913-090000","state":"completed","agents":{"writer":{"duration":10,"metrics":{"estimated_cost_usd":null,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4,"reasoning":null},"turns":1,"duration_ms":10000,"api_duration_ms":9000,"tool_calls":[]}},"reviewer":{"duration":null,"metrics":null}}}
EOF
AGG_N=$(compute_metrics_report_json "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" "")
assert_field "N-1: solo los valores estimated_cost_usd entran al total" "2" "$(echo "$AGG_N" | jq -r '.wallclock.writer.estimated_cost_usd_total')"
assert_field "N-2: el costo legado incluido el cero queda en su total separado" "0" "$(echo "$AGG_N" | jq -r '.wallclock.writer.legacy_reported_cost_usd_total')"
assert_field "N-3: costo estimado disponible en 2 corridas; nulo explicita parcialidad" "2" "$(echo "$AGG_N" | jq -r '.meta.estimated_cost_runs')"
assert_field "N-4: dos corridas sin estimacion (legacy y null)" "2" "$(echo "$AGG_N" | jq -r '.meta.estimated_cost_missing_runs')"
assert_field "N-5: cache_creation antiguo se proyecta como cache_write" "4.75" "$(echo "$AGG_N" | jq -r '.series.monthly[] | select(.period=="2026-09") | .cache_write_mean')"
assert_field "N-6: reasoning se incorpora al desglose" "5" "$(echo "$AGG_N" | jq -r '.series.monthly[] | select(.period=="2026-09") | .reasoning_mean')"
assert_field "N-7: la fila solo nueva conserva costo estimado cero" "0" "$(echo "$AGG_N" | jq -r '.wallclock.per_run[] | select(.issue=="800") | .estimated_cost_usd')"
assert_field "N-8: la fila solo legacy expone costo reportado cero separado" "0" "$(echo "$AGG_N" | jq -r '.wallclock.per_run[] | select(.issue=="801") | .legacy_reported_cost_usd')"
assert_field "N-9: la fila mixta prioriza estimacion y no reclasifica cost_usd" "null" "$(echo "$AGG_N" | jq -r '.wallclock.per_run[] | select(.issue=="802") | .legacy_reported_cost_usd')"
assert_field "N-10: un agente estimado y otro nulo hacen explicita la parcialidad" "parcial" "$(echo "$AGG_N" | jq -r '.wallclock.per_run[] | select(.issue=="802") | .estimated_cost_status')"
assert_field "N-11: la cobertura distingue una corrida completa" "1" "$(echo "$AGG_N" | jq -r '.meta.estimated_cost_complete_runs')"
assert_field "N-12: la cobertura distingue una corrida parcial" "1" "$(echo "$AGG_N" | jq -r '.meta.estimated_cost_partial_runs')"
OUT=$(run_report)
if echo "$OUT" | grep -q "Costo estimado con valor: 2 corridas (completas: 1, parciales: 1); sin estimacion: 2" \
   && echo "$OUT" | grep -q "Costo reportado legado: 1 corridas (separado; excluido de estimados)" \
   && echo "$OUT" | grep -q "Cobertura est." && echo "$OUT" | grep -q "Costo leg." \
   && echo "$OUT" | grep -q "Cache write medio"; then
    pass "N-13: resumen y detalle separan estimacion parcial, legado y tokenizacion neutral"
else
    fail "N-13: faltan rotulos de costos/tokens neutrales: $OUT"
fi

echo ""
echo "[O] Historial en las DOS ubicaciones: se agregan ambas y el reporte cierra en 0 (issue #869)"

# Hasta aqui el repo de mentira solo tenia .claude/pipeline/ (una sola fuente),
# asi que ninguna prueba entraba en la rama que concatena las dos ubicaciones
# en un temporal -- la rama que corre en CUALQUIER repo real con historico
# legacy. Ahi el `trap ... EXIT` que borra el temporal se ejecuta cuando main()
# ya retorno: si difiere la expansion de su variable local, `set -u` tumba el
# shell con "unbound variable" y el reporte termina en exit 1 despues de
# haberse impreso entero.
mkdir -p "$FAKE_REPO/.mefisto/pipeline"
cat > "$FAKE_REPO/.claude/pipeline/pipeline-history.jsonl" <<'EOF'
{"issue":"700","title":"Legacy","pipeline":"mefisto-tooling","started":"20260901-090000","state":"completed","agents":{"writer":{"duration":100},"reviewer":{"duration":50}}}
EOF
printf '%s' '{"issue":"701","title":"Canonica","pipeline":"mefisto-tooling","runtime":"otro","started":"20260902-090000","state":"completed","agents":{"writer":{"duration":80},"reviewer":{"duration":40}}}' \
    > "$FAKE_REPO/.mefisto/pipeline/pipeline-history.jsonl"

OUT=$(run_report 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then
    pass "N-1: con las dos ubicaciones presentes el reporte cierra en exit 0"
else
    fail "N-1: el reporte cerro en rc=$RC con las dos ubicaciones presentes: $(echo "$OUT" | tail -3)"
fi
if echo "$OUT" | grep -q 'unbound variable'; then
    fail "N-2: el reporte imprimio 'unbound variable': $(echo "$OUT" | grep 'unbound variable')"
else
    pass "N-2: el reporte no imprime 'unbound variable' al limpiar el temporal"
fi
# Sin el salto de linea defensivo del concatenado, la ultima corrida del
# legacy y la primera de la canonica (que aqui se escribe SIN '\n' final) se
# pegarian y las dos se perderian.
assert_field "N-3: las corridas de AMBAS ubicaciones entran en la ventana" "2" \
    "$(echo "$OUT" | grep -oE 'ventana: [0-9]+' | head -1 | awk '{print $2}')"

rm -rf "$FAKE_REPO/.mefisto"

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
