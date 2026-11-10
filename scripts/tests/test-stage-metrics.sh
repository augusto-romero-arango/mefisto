#!/usr/bin/env bash
# test-stage-metrics.sh -- Tests de las metricas por stage derivadas de la
# traza stream-json en el lado publicado (issue #646, porte de
# compute_stage_metrics/build_agents_history_json del interno #426).
#
# Contexto: con la traza cruda ya capturada en tdd-pipeline.sh (#645), el
# historico no derivaba ninguna cifra por stage mas alla de una duracion en
# segundos -- no alcanza para saber si un issue tardo mas por mas turnos, mas
# tool calls, o cache que dejo de acertar. Este issue agrega a
# _pipeline-common.sh:
#
#   - compute_stage_metrics <stream_file>: porte de la forma neutral del
#     interno -- turnos, duraciones (total/API/no-API), costo estimado o
#     legado, tokens desglosados, modelo, motivo de fin y un histograma de tool
#     calls por nombre. Imprime JSON compacto o "null"; nunca aborta (CA-4).
#   - build_agents_history_json <key> <agent> <dur> <metrics> [...]:
#     GENERALIZADO a N grupos variables (a diferencia del interno, especifico
#     a writer/reviewer) -- tdd-pipeline.sh tiene hasta 7 claves variables.
#     Cada grupo agrega una clave con {duration, metrics}; <agent> se inyecta
#     como metrics.agent (distingue projection-test-writer de test-writer
#     bajo la misma clave "test-writer", CA-1). Sin jq degrada a un objeto
#     plano con solo "duration" por clave (CA-4).
#
# A diferencia del test interno equivalente, este conserva la cobertura propia
# de los fallbacks publicados y de la generalizacion de
# build_agents_history_json (N grupos variables, no solo writer/reviewer),
# ademas de su cableado en tdd-pipeline.sh.
#
# Casos cubiertos:
#   [pre] compute_stage_metrics y build_agents_history_json estan definidas
#       en scripts/_pipeline-common.sh.
#   [A] compute_stage_metrics: terminal neutral nuevo completo, con costo
#       estimado y los cinco tokens copiados sin recalcular.
#   [B] compute_stage_metrics: terminal neutral nuevo con nulos/cero y
#       terminal legacy, que conserva costo ausente como estimacion null.
#   [C] compute_stage_metrics: fallback Claude previo al contrato conserva
#       total_cost_usd solo como cost_usd legado.
#   [D] compute_stage_metrics: sin evento result / stream vacio / jq ausente
#       -> "null", nunca aborta (CA-4).
#   [E] build_agents_history_json con 2 grupos (paridad con el interno):
#       agrega metrics preservando duration, agent se inyecta en
#       metrics.agent.
#   [F] build_agents_history_json: metrics null -> no se inventa un campo
#       "agent" (CA-1 nota: el campo vive DENTRO del esquema de metrics, no
#       hay donde anidarlo si metrics es null).
#   [G] build_agents_history_json: agent="" no agrega el campo aunque metrics
#       si sea un objeto (clave que siempre usa el mismo agente, ej reviewer).
#   [H] build_agents_history_json: N>2 grupos (generalizacion, CA-2 -- claves
#       nuevas solo aparecen cuando el caller las incluye).
#   [I] build_agents_history_json: sin jq degrada a plano, SOLO "duration"
#       por clave, sin "metrics" ni "agent" (CA-4/CA-5).
#   [J] Integracion: la linea de historial resultante es JSON valido de una
#       sola linea (CA-4/CA-6) y conserva duration numerico ademas de agregar
#       metrics.
#   [K] Cableado en tdd-pipeline.sh (CA-1 a CA-5):
#       - compute_stage_metrics se invoca al cierre de cada run_agent.
#       - build_agents_history_json alimenta las dos entradas de historial
#         (completed y la de abort).
#       - las metricas se cosechan por stage (case "$stage"), no por nombre
#         de agente -- el stage "merge" reusa el agente "implementer" y con
#         un case por agente pisaria las metricas del implementer de Stage 2.
#       - coverage-gate no pasa por el builder (su forma no cambia).
#       - cada invocacion deja su JSON individual en la ruta canonica de estado.
#         del consumidor.
#
# Uso: scripts/tests/test-stage-metrics.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq no disponible en este entorno, no se puede correr la suite"; exit 0; }

assert_field() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$desc"
    else
        fail "$desc (esperado '$expected', obtenido '$actual')"
    fi
}

# -------- Bloque pre: funciones existen --------

echo "[pre] Las funciones estan definidas en scripts/_pipeline-common.sh"
for fn in compute_stage_metrics enrich_tooling_stage_metrics build_agents_history_json; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

cat > "$TMP/neutral.events.jsonl" <<'EOF'
{"v":1,"type":"run.started","runtime":"fake","agent":"tooling-writer","model":null}
{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"ses-1","duration_ms":900,"tokens":{"input":12,"output":4,"cache_read":3,"cache_write":2,"reasoning":1},"estimated_cost_usd":0.1,"turns":3,"denials":0,"ttft_ms":20,"api_duration_ms":700,"error":null}
EOF
N_BASE="$(compute_stage_metrics "$TMP/neutral.events.jsonl")"
N_OUT="$(enrich_tooling_stage_metrics "$TMP/neutral.events.jsonl" "$N_BASE" 1063 '"variante-a"' 1 tooling-writer balanced '{"harness_version":"1.2.3","harness_commit":"0123456789abcdef0123456789abcdef01234567","identity_state":"complete"}')"
if printf '%s' "$N_OUT" | jq -e '.pipeline == "tooling" and .issue == "1063" and .variant == "variante-a" and .stage == "1" and .agent == "tooling-writer" and .runtime == "fake" and .profile == "balanced" and .requested_model == null and .effective_model == "openai/gpt-5" and .inherited == true and .session_id == "ses-1" and .result == "success" and .duration_api_ms == 700 and .non_api_ms == 200 and .estimated_cost_usd == 0.1 and .tokens == {"input":12,"output":4,"cache_read":3,"cache_write":2,"reasoning":1} and (has("cost_usd") | not) and .harness_version == "1.2.3" and .identity_state == "complete"' >/dev/null; then
    pass "pre-4: metricas neutrales conservan contrato nuevo y dimensiones de correlacion"
else
    fail "pre-4: metricas neutrales incompletas: $N_OUT"
fi

cat > "$TMP/effort.events.jsonl" <<'EOF'
{"v":1,"type":"run.started","runtime":"claude","agent":"tooling-writer","model":null,"effort":"low"}
{"v":1,"type":"run.completed","status":"success","runtime":"claude","model":"m","session_id":"ses-e","duration_ms":900,"turns":1,"denials":0,"error":null}
EOF
E_BASE="$(compute_stage_metrics "$TMP/effort.events.jsonl")"
E_OUT="$(enrich_tooling_stage_metrics "$TMP/effort.events.jsonl" "$E_BASE" 2500 'null' 1 tooling-writer balanced '{}')"
assert_field "pre-5: requested_effort sale de run.started.effort" "low" "$(printf '%s' "$E_OUT" | jq -r '.requested_effort')"
assert_field "pre-6: sin effort en run.started, requested_effort es null (clave presente)" "true" "$(printf '%s' "$N_OUT" | jq -r 'has("requested_effort") and .requested_effort == null')"

# -------- Bloque A: terminal neutral nuevo completo --------

echo ""
echo "[A] compute_stage_metrics: terminal neutral nuevo copia costo estimado y tokens"

cat > "$TMP/a-stream.jsonl" <<'EOF'
{"v":1,"type":"run.started","runtime":"fake","agent":"writer","model":null}
{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"abc","duration_ms":1000,"api_duration_ms":700,"estimated_cost_usd":0.01,"tokens":{"input":100,"output":50,"cache_read":10,"cache_write":0,"reasoning":7},"turns":2,"denials":0,"ttft_ms":20,"error":null}
EOF

A_OUT=$(compute_stage_metrics "$TMP/a-stream.jsonl")
assert_field "A-1: turns" "2" "$(echo "$A_OUT" | jq -r '.turns')"
assert_field "A-2: model copiado del terminal" "openai/gpt-5" "$(echo "$A_OUT" | jq -r '.model')"
assert_field "A-3: non_api_ms derivado" "300" "$(echo "$A_OUT" | jq -r '.non_api_ms')"
assert_field "A-4: estimated_cost_usd copiado" "0.01" "$(echo "$A_OUT" | jq -r '.estimated_cost_usd')"
if echo "$A_OUT" | jq -e '.tokens == {"input":100,"output":50,"cache_read":10,"cache_write":0,"reasoning":7} and (has("cost_usd") | not) and (.tokens | has("cache_creation") | not)' >/dev/null 2>&1; then
    pass "A-5: conserva los cinco tokens, incluido cache_write cero, sin campos legacy"
else
    fail "A-5: contrato de tokens/costo inesperado: $A_OUT"
fi
if [ "$(printf '%s' "$A_OUT" | wc -l | tr -d ' ')" = "0" ] && echo "$A_OUT" | jq -e 'type == "object"' >/dev/null 2>&1; then
    pass "A-6: la salida es un objeto JSON valido en una sola linea"
else
    fail "A-6: la salida no es un objeto JSON de una sola linea: $A_OUT"
fi

# -------- Bloque B: terminales neutrales nulo/cero y legacy --------

echo ""
echo "[B] terminales neutrales: nulos/cero y legacy conservan la distincion de costo"

cat > "$TMP/b-null.events.jsonl" <<'EOF'
{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"ses-null","duration_ms":1,"api_duration_ms":null,"estimated_cost_usd":null,"tokens":{"input":null,"output":null,"cache_read":null,"cache_write":null,"reasoning":null},"turns":null,"denials":0,"ttft_ms":null,"error":null}
EOF
B_NULL_OUT=$(compute_stage_metrics "$TMP/b-null.events.jsonl")
if echo "$B_NULL_OUT" | jq -e '.estimated_cost_usd == null and .tokens == {"input":null,"output":null,"cache_read":null,"cache_write":null,"reasoning":null} and (has("cost_usd") | not)' >/dev/null 2>&1; then
    pass "B-1: costo estimado y contadores ausentes permanecen null"
else
    fail "B-1: los nulos del terminal nuevo cambiaron de semantica: $B_NULL_OUT"
fi

cat > "$TMP/b-zero.events.jsonl" <<'EOF'
{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"ses-null","duration_ms":0,"api_duration_ms":0,"estimated_cost_usd":0,"tokens":{"input":0,"output":0,"cache_read":0,"cache_write":0,"reasoning":0},"turns":0,"denials":0,"ttft_ms":0,"error":null}
EOF
B_ZERO_OUT=$(compute_stage_metrics "$TMP/b-zero.events.jsonl")
if echo "$B_ZERO_OUT" | jq -e '.estimated_cost_usd == 0 and .tokens == {"input":0,"output":0,"cache_read":0,"cache_write":0,"reasoning":0}' >/dev/null 2>&1; then
    pass "B-2: costo cero estimado y los cinco contadores cero no se colapsan"
else
    fail "B-2: se perdio un cero presente: $B_ZERO_OUT"
fi

cat > "$TMP/b-legacy.events.jsonl" <<'EOF'
{"v":1,"type":"run.completed","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":"ses-legacy","duration_ms":1,"api_duration_ms":1,"cost_usd":0.5,"tokens":{"input":1,"output":2,"cache_read":3,"cache_creation":4},"turns":1,"denials":0,"ttft_ms":1,"error":null}
EOF
B_LEGACY_OUT=$(compute_stage_metrics "$TMP/b-legacy.events.jsonl")
if echo "$B_LEGACY_OUT" | jq -e '.estimated_cost_usd == null and .tokens == {"input":1,"output":2,"cache_read":3,"cache_write":4,"reasoning":null} and (has("cost_usd") | not) and (.tokens | has("cache_creation") | not)' >/dev/null 2>&1; then
    pass "B-3: terminal legacy no aborta, normaliza tokens y no rebautiza su costo"
else
    fail "B-3: terminal legacy con forma inesperada: $B_LEGACY_OUT"
fi

# -------- Bloque C: fallback Claude previo al contrato --------

echo ""
echo "[C] fallback Claude previo al contrato conserva total_cost_usd como legado"

cat > "$TMP/c-claude-stream.jsonl" <<'EOF'
{"type":"system","subtype":"init","model":"claude-sonnet-5"}
{"type":"result","num_turns":2,"duration_ms":1000,"duration_api_ms":700,"total_cost_usd":0.01,"is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":0}}
EOF
C_LEGACY_OUT=$(compute_stage_metrics "$TMP/c-claude-stream.jsonl")
if echo "$C_LEGACY_OUT" | jq -e '.cost_usd == 0.01 and .estimated_cost_usd == null and .model == "claude-sonnet-5" and .tokens == {"input":100,"output":50,"cache_read":10,"cache_write":0,"reasoning":null}' >/dev/null 2>&1; then
    pass "C-1: fallback Claude mantiene modelo/tokens y etiqueta el costo como legado"
else
    fail "C-1: fallback Claude con forma inesperada: $C_LEGACY_OUT"
fi

# -------- Bloque D: degradaciones a "null" (CA-4) --------

echo ""
echo "[D] compute_stage_metrics degrada a \"null\" sin abortar (CA-4)"

printf '{"type":"assistant","message":{"content":[{"type":"text","text":"trabajando"}]}}\n' > "$TMP/b-sin-result.jsonl"
B1_OUT=$(compute_stage_metrics "$TMP/b-sin-result.jsonl")
RC=$?
if [ "$RC" -eq 0 ] && [ "$B1_OUT" = "null" ]; then
    pass "D-1: sin evento result -> exit 0 y 'null'"
else
    fail "D-1: se esperaba exit 0 y 'null', se obtuvo rc=$RC salida='$B1_OUT'"
fi

: > "$TMP/b-vacio.jsonl"
B2_OUT=$(compute_stage_metrics "$TMP/b-vacio.jsonl")
RC=$?
if [ "$RC" -eq 0 ] && [ "$B2_OUT" = "null" ]; then
    pass "D-2: stream vacio -> exit 0 y 'null'"
else
    fail "D-2: se esperaba exit 0 y 'null', se obtuvo rc=$RC salida='$B2_OUT'"
fi

E_PATH_SIN_JQ="$TMP/bin-sin-jq"
mkdir -p "$E_PATH_SIN_JQ"
(
    set -euo pipefail
    PATH="$E_PATH_SIN_JQ:/bin"
    B3_OUT=$(compute_stage_metrics "$TMP/a-stream.jsonl")
    echo "$B3_OUT" > "$TMP/b3-out.txt"
)
RC=$?
B3_OUT=$(cat "$TMP/b3-out.txt" 2>/dev/null)
if [ "$RC" -eq 0 ] && [ "$B3_OUT" = "null" ]; then
    pass "D-3: jq ausente -> exit 0 y 'null'"
else
    fail "D-3: se esperaba exit 0 y 'null' sin jq, se obtuvo rc=$RC salida='$B3_OUT'"
fi

# -------- Bloque E: build_agents_history_json con 2 grupos (paridad con el interno) --------

echo ""
echo "[E] build_agents_history_json con 2 grupos: agrega metrics, agent va en metrics.agent"

C_OUT=$(build_agents_history_json \
    "test-writer" "projection-test-writer" "125" "$A_OUT" \
    "reviewer" "reviewer" "300" "null")

assert_field "E-1: preserva test-writer.duration" "125" "$(echo "$C_OUT" | jq -r '.["test-writer"].duration')"
assert_field "E-2: preserva reviewer.duration" "300" "$(echo "$C_OUT" | jq -r '.reviewer.duration')"
assert_field "E-3: agrega test-writer.metrics.turns" "2" "$(echo "$C_OUT" | jq -r '.["test-writer"].metrics.turns')"
assert_field "E-4: agent real distingue projection-test-writer bajo la clave test-writer (CA-1)" "projection-test-writer" "$(echo "$C_OUT" | jq -r '.["test-writer"].metrics.agent')"
assert_field "E-5: reviewer.metrics es null cuando ese stage no corrio" "null" "$(echo "$C_OUT" | jq -r '.reviewer.metrics')"
if echo "$C_OUT" | jq -e '[.. | objects | select(has("cost_usd") or has("cache_creation"))] | length == 0' >/dev/null 2>&1 \
    && echo "$C_OUT" | jq -e '.["test-writer"].metrics.estimated_cost_usd == 0.01 and .["test-writer"].metrics.tokens.cache_write == 0' >/dev/null 2>&1; then
    pass "E-6: historial nuevo persiste costo estimado y no escribe claves legacy"
else
    fail "E-6: el historial conserva claves legacy o perdio el contrato nuevo: $C_OUT"
fi

# -------- Bloque F: metrics null -> no inventa un campo "agent" --------

echo ""
echo "[F] metrics null -> no hay donde anidar agent, el campo no aparece"

D_OUT=$(build_agents_history_json "implementer" "projection-implementer" "" "")
if echo "$D_OUT" | jq -e '.implementer.metrics == null' >/dev/null 2>&1 \
   && ! echo "$D_OUT" | jq -e '.implementer | has("agent")' >/dev/null 2>&1; then
    pass "F-1: metrics null y sin campo agent a nivel de entrada"
else
    fail "F-1: forma inesperada con metrics null: $D_OUT"
fi

# -------- Bloque G: agent="" no agrega el campo aunque metrics si sea un objeto --------

echo ""
echo "[G] agent vacio no agrega metrics.agent (clave con un solo agente posible, ej reviewer)"

E_OUT=$(build_agents_history_json "reviewer" "" "300" "{\"turns\":5}")
if echo "$E_OUT" | jq -e '.reviewer.metrics.turns == 5' >/dev/null 2>&1 \
   && ! echo "$E_OUT" | jq -e '.reviewer.metrics | has("agent")' >/dev/null 2>&1; then
    pass "G-1: agent vacio -- metrics conserva sus campos, sin agregar 'agent'"
else
    fail "G-1: forma inesperada con agent vacio: $E_OUT"
fi

# -------- Bloque H: N>2 grupos (generalizacion, CA-2) --------

echo ""
echo "[H] N grupos variables (CA-2: el caller decide cuantas claves incluir)"

F_OUT=$(build_agents_history_json \
    "test-writer" "test-writer" "60" "null" \
    "implementer" "implementer" "90" "null" \
    "smoke-test-writer" "smoke-test-writer" "40" "null" \
    "reviewer" "reviewer" "120" "null" \
    "scaffolder" "domain-scaffolder" "300" "null" \
    "patch-test-writer" "test-writer" "30" "null" \
    "patch-implementer" "implementer" "20" "null")

F_KEY_COUNT=$(echo "$F_OUT" | jq 'keys | length')
assert_field "H-1: las 7 claves estan presentes" "7" "$F_KEY_COUNT"
assert_field "H-2: scaffolder.duration" "300" "$(echo "$F_OUT" | jq -r '.scaffolder.duration')"
assert_field "H-3: patch-implementer.duration" "20" "$(echo "$F_OUT" | jq -r '.["patch-implementer"].duration')"

# Guarda del paso de argumentos a jq: si el separador de fin de opciones se
# colara como un posicional literal, TODOS los grupos correrian un lugar y la
# primera clave del objeto seria "--" en vez de "test-writer". Es un modo de
# fallo silencioso (el objeto sigue siendo JSON valido y se escribe igual al
# historial), asi que se afirma explicitamente.
if ! echo "$F_OUT" | jq -e 'has("--")' >/dev/null 2>&1 \
   && echo "$F_OUT" | jq -e 'has("test-writer")' >/dev/null 2>&1; then
    pass "H-4: los grupos no se desplazan (sin clave espuria '--')"
else
    fail "H-4: los grupos se desplazaron -- el objeto tiene una clave espuria: $F_OUT"
fi

# -------- Bloque I: sin jq degrada a plano (CA-4/CA-5) --------

echo ""
echo "[I] build_agents_history_json sin jq: solo duration, sin metrics ni agent"

G_OUT=$(PATH="$E_PATH_SIN_JQ:/bin" build_agents_history_json \
    "test-writer" "projection-test-writer" "125" "$A_OUT" \
    "implementer" "" "" "")
if echo "$G_OUT" | grep -qF '"test-writer":{"duration":125}' \
   && echo "$G_OUT" | grep -qF '"implementer":{"duration":null}' \
   && ! echo "$G_OUT" | grep -q "metrics" \
   && ! echo "$G_OUT" | grep -q "agent"; then
    pass "I-1: sin jq, degrada a plano (solo duration, sin metrics ni agent)"
else
    fail "I-1: el degrade sin jq no coincide con lo esperado: $G_OUT"
fi

# -------- Bloque J: integracion -- linea de historial valida --------

echo ""
echo "[J] Integracion: la linea de historial resultante es JSON valido de una sola linea (CA-4/CA-6)"

HISTORY_LINE="{\"issue\":\"646\",\"title\":\"Test\",\"pipeline\":\"tdd\",\"started\":\"20260816-100000\",\"finished\":\"2026-08-16T10:10:00\",\"state\":\"completed\",\"agents\":$C_OUT,\"tests\":10,\"pr\":\"https://github.com/x/y/pull/1\"}"

if [ "$(echo "$HISTORY_LINE" | wc -l)" -eq 1 ] && echo "$HISTORY_LINE" | jq -e '.' >/dev/null 2>&1; then
    pass "J-1: la entrada es JSON valido de una sola linea"
else
    fail "J-1: la entrada no es JSON valido de una sola linea: $HISTORY_LINE"
fi
assert_field "J-2: agents.test-writer.duration sigue siendo numerico" "125" "$(echo "$HISTORY_LINE" | jq -r '.agents["test-writer"].duration')"
assert_field "J-3: agents.test-writer.metrics.turns presente (campo nuevo)" "2" "$(echo "$HISTORY_LINE" | jq -r '.agents["test-writer"].metrics.turns')"

# -------- Bloque K: cableado en tdd-pipeline.sh --------

echo ""
echo "[K] Cableado en tdd-pipeline.sh (CA-1 a CA-5)"

PIPE="$REPO_ROOT/scripts/tdd-pipeline.sh"

if grep -q "compute_stage_metrics" "$PIPE"; then
    pass "K-1: el pipeline invoca compute_stage_metrics al cerrar cada stage"
else
    fail "K-1: el pipeline NO invoca compute_stage_metrics"
fi

if [ "$(grep -c "build_agents_history_json" "$PIPE")" -ge 2 ]; then
    pass "K-2: build_agents_history_json alimenta las dos entradas de historial (completed y la de abort)"
else
    fail "K-2: build_agents_history_json no se usa en las dos entradas de historial"
fi

if grep -q 'run_agent "merge" "implementer"' "$PIPE"; then
    pass "K-3: existe el stage merge reusando el nombre de agente 'implementer' (premisa de K-4)"
else
    fail "K-3: cambio el stage merge -- revisar si K-4 sigue teniendo sentido"
fi

if grep -qE '2\)\s+AGENT_IM_METRICS_JSON="\$metrics_json"' "$PIPE" \
   && ! grep -qE 'implementer\).*AGENT_IM_METRICS_JSON="\$metrics_json"' "$PIPE"; then
    pass "K-4: las metricas se cosechan por stage, no por nombre de agente (el merge no pisa al implementer de Stage 2)"
else
    fail "K-4: las metricas se cosechan por nombre de agente -- un merge fallido pisaria las del implementer de Stage 2"
fi

if grep -q 'coverage-gate' "$PIPE" && grep -qF '\"coverage-gate\":{\"duration\"' "$PIPE"; then
    pass "K-5: coverage-gate conserva su forma propia (duration/result/gaps/patch_applied), no pasa por el builder"
else
    fail "K-5: no se encontro la forma esperada de coverage-gate"
fi

if grep -qF 'mefisto_state_path "metrics/tdd-' "$PIPE"; then
    pass "K-6: cada invocacion respalda su JSON individual con mefisto_state_path"
else
    fail "K-6: no se encontro el respaldo por stage mediante mefisto_state_path"
fi

if grep -qF "mefisto_state_path 'logs/.state'" "$PIPE" \
    && ! grep -qF 'mkdir -p "$PIPELINE_DIR/metrics"' "$PIPE"; then
    pass "K-7: el estado y sus directorios padre se resuelven con mefisto_state_path"
else
    fail "K-7: el pipeline no resuelve el estado canonico o conserva el mkdir legacy"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
