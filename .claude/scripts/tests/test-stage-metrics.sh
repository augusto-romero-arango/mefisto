#!/usr/bin/env bash
# test-stage-metrics.sh -- Tests de las metricas por stage derivadas del
# JSONL neutral (issue #426, reescrita sobre run-events.schema.json en el
# issue #907).
#
# Contexto: con el puente del issue #906, `run_agent` ya escribe
# `<log_base>.events.jsonl` traduciendo la traza cruda de cualquier runtime
# al vocabulario cerrado de
# src/runtime/contract/run-events.schema.json, y la clasificacion de
# fallos ya lee solo ese archivo. Este issue termina la migracion: las dos
# funciones de METRICAS de _mefisto-common.sh dejan de nombrar nada propio
# de Claude Code y pasan a leer el evento terminal (`run.completed`/
# `run.failed`) y los eventos `tool.started`/`tool.completed` neutrales.
#
#   - compute_stage_metrics <events_file>: deriva runtime, model, status,
#     error_kind, duraciones (total/API/no-API), ttft_ms, turns,
#     estimated_cost_usd, tokens{input,output,cache_read,cache_write,reasoning},
#     denials y un histograma de tool calls por nombre
#     (count desde `tool.started`, duracion desde `tool.completed.duration_ms`
#     -- ya calculada por el traductor de cada runtime, sin emparejar por id).
#     Imprime JSON compacto o el literal "null"; nunca aborta (CA-5).
#   - build_agents_history_json <wr_dur> <wr_metrics> <rv_dur> <rv_metrics>:
#     construye el objeto "agents" de una entrada de pipeline-history.jsonl,
#     agregando agents.<agente>.metrics Y agents.<agente>.runtime SIN tocar
#     "duration" (CA-2). Sin jq degrada al formato plano de siempre (CA-5).
#
# Casos cubiertos:
#   [pre] Las dos funciones nuevas estan definidas en _mefisto-common.sh.
#   [A] JSONL neutral completo con varias tool calls -> todos los campos
#       derivados correctamente, incluido el histograma (CA-1).
#   [B] Sin evento terminal (`run.completed`/`run.failed`) -> "null", no
#       aborta (CA-5).
#   [C] Archivo vacio -> "null" (CA-5).
#   [D] Linea truncada a mitad, con terminal valido despues -> la linea rota
#       se ignora sin abortar; el resto de las metricas se deriva igual
#       (CA-1/CA-5).
#   [E] jq ausente -> degrada a "null" sin abortar (CA-5).
#   [F] Un `estimated_cost_usd: 0` real se preserva; un evento legacy que solo
#       trae `cost_usd: 0` produce estimacion null. jq `//` no colapsa cero:
#       solo selecciona el operando derecho para null o false.
#   [G] tool.completed con `duration_ms: null` (huerfana parcial) -> cuenta
#       en `count`, no contribuye a `duration_ms_sum`/`duration_ms_median`.
#   [H] tool.started sin ningun tool.completed emparejado (huerfana total,
#       el proceso murio a mitad de la llamada) -> mismo resultado que [G].
#   [I] Campos opcionales ausentes DEL TODO en el terminal (ni siquiera como
#       null explicito) -> compute_stage_metrics no aborta; el resto de las
#       cifras se deriva igual.
#   [J] build_agents_history_json: agrega "metrics" Y "runtime" preservando
#       "duration" intacto (CA-2); "runtime" es null si ese stage no dejo
#       metricas; sin jq degrada al formato plano legado (CA-5).
#   [K] Integracion: la linea resultante es JSON valido de una sola linea
#       (CA-4) y conserva `agents.writer.duration` numerico ademas de
#       agregar `agents.writer.metrics`/`agents.writer.runtime`.
#   [M] Exito con tool calls sobre el fixture real de Claude (CA-4): las
#       metricas derivadas de `runtime_claude_translate` sobre
#       fixtures/runtime-claude/success.jsonl traen `status`, la forma de
#       `tool_calls[].name/count` y las cifras ttft_ms, turns y
#       api_duration_ms.
#   [N] Fallo api_error y timeout (CA-4): terminales neutrales escritos
#       inline conforme al schema, con las cifras pobladas (runtime:"claude")
#       y con todas en null (runtime:"fake"), producen el mismo
#       status/error_kind.
#   [O] Guarda de neutralidad (CA-1): el CUERPO de compute_stage_metrics no
#       nombra el vocabulario de Claude Code. Los bloques A-N verifican el
#       comportamiento sobre entradas neutrales, y eso lo cumple tambien una
#       implementacion que siga parseando `type == "result"` como camino
#       alterno -- justo la recaida que este issue existe para cerrar. La
#       unica forma de cubrir "no contiene X" es mirar el texto.
#
# Uso: .claude/scripts/tests/test-stage-metrics.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DIR="$REPO_ROOT/src/internal/scripts/lib"
RUNTIME_LIB_DIR="$REPO_ROOT/src/runtime/lib"
FIXTURES_CLAUDE="$SCRIPT_DIR/fixtures/runtime-claude"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null
# shellcheck source=/dev/null
source "$RUNTIME_LIB_DIR/runtime-claude.sh" 2>/dev/null

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

echo "[pre] Las funciones nuevas estan definidas en _mefisto-common.sh"
for fn in compute_stage_metrics build_agents_history_json; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: JSONL neutral completo con tool calls --------

echo ""
echo "[A] JSONL neutral completo con varias tool calls -> todos los campos derivados (CA-1)"

cat > "$TMP/a-events.jsonl" <<'EOF'
{"v":1,"type":"message","ts":"2026-07-27T22:09:34.000Z","role":"assistant","text":"Voy a investigar."}
{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:34.500Z","tool":"Read","input_summary":null}
{"v":1,"type":"tool.completed","ts":"2026-07-27T22:09:34.700Z","tool":"Read","ok":true,"duration_ms":200}
{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:35.000Z","tool":"Read","input_summary":null}
{"v":1,"type":"tool.completed","ts":"2026-07-27T22:09:35.900Z","tool":"Read","ok":true,"duration_ms":900}
{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:36.000Z","tool":"Write","input_summary":null}
{"v":1,"type":"tool.completed","ts":"2026-07-27T22:09:37.000Z","tool":"Write","ok":true,"duration_ms":1000}
{"v":1,"type":"run.completed","ts":"2026-07-27T22:09:37.500Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":"sess-abc","duration_ms":9451,"tokens":{"input":1200,"output":340,"cache_read":500,"cache_write":120,"reasoning":80},"estimated_cost_usd":0.0234,"turns":4,"denials":2,"ttft_ms":3797,"api_duration_ms":5289,"error":null}
EOF

A_OUT=$(compute_stage_metrics "$TMP/a-events.jsonl")

assert_field "A-1: runtime" "claude" "$(echo "$A_OUT" | jq -r '.runtime')"
assert_field "A-2: model" "claude-sonnet-5" "$(echo "$A_OUT" | jq -r '.model')"
assert_field "A-3: status" "success" "$(echo "$A_OUT" | jq -r '.status')"
assert_field "A-4: error_kind (terminal sin error)" "null" "$(echo "$A_OUT" | jq -r '.error_kind')"
assert_field "A-5: duration_ms" "9451" "$(echo "$A_OUT" | jq -r '.duration_ms')"
assert_field "A-6: api_duration_ms" "5289" "$(echo "$A_OUT" | jq -r '.api_duration_ms')"
assert_field "A-7: non_api_ms derivado (9451-5289)" "4162" "$(echo "$A_OUT" | jq -r '.non_api_ms')"
assert_field "A-8: ttft_ms" "3797" "$(echo "$A_OUT" | jq -r '.ttft_ms')"
assert_field "A-9: turns" "4" "$(echo "$A_OUT" | jq -r '.turns')"
assert_field "A-10: estimated_cost_usd" "0.0234" "$(echo "$A_OUT" | jq -r '.estimated_cost_usd')"
assert_field "A-11: tokens.input" "1200" "$(echo "$A_OUT" | jq -r '.tokens.input')"
assert_field "A-12: tokens.output" "340" "$(echo "$A_OUT" | jq -r '.tokens.output')"
assert_field "A-13: tokens.cache_read" "500" "$(echo "$A_OUT" | jq -r '.tokens.cache_read')"
assert_field "A-14: tokens.cache_write" "120" "$(echo "$A_OUT" | jq -r '.tokens.cache_write')"
assert_field "A-15: tokens.reasoning" "80" "$(echo "$A_OUT" | jq -r '.tokens.reasoning')"
assert_field "A-16: denials" "2" "$(echo "$A_OUT" | jq -r '.denials')"

# Histograma: Read aparece 2 veces (200ms y 900ms), Write 1 vez (1000ms)
assert_field "A-17: tool_calls[Read].count" "2" "$(echo "$A_OUT" | jq -r '.tool_calls[] | select(.name=="Read") | .count')"
assert_field "A-18: tool_calls[Read].duration_ms_sum (200+900)" "1100" "$(echo "$A_OUT" | jq -r '.tool_calls[] | select(.name=="Read") | .duration_ms_sum')"
assert_field "A-19: tool_calls[Read].duration_ms_median" "550" "$(echo "$A_OUT" | jq -r '.tool_calls[] | select(.name=="Read") | .duration_ms_median')"
assert_field "A-20: tool_calls[Write].count" "1" "$(echo "$A_OUT" | jq -r '.tool_calls[] | select(.name=="Write") | .count')"
assert_field "A-21: tool_calls[Write].duration_ms_sum" "1000" "$(echo "$A_OUT" | jq -r '.tool_calls[] | select(.name=="Write") | .duration_ms_sum')"

if [ "$(printf '%s' "$A_OUT" | wc -l | tr -d ' ')" = "0" ] && echo "$A_OUT" | jq -e 'type == "object"' >/dev/null 2>&1; then
    pass "A-22: la salida es un objeto JSON valido en una sola linea"
else
    fail "A-22: la salida no es un objeto JSON de una sola linea: $A_OUT"
fi

# -------- Bloque B: sin evento terminal --------

echo ""
echo "[B] Sin evento terminal -> \"null\", no aborta (CA-5)"

printf '{"v":1,"type":"message","ts":"2026-07-27T22:09:34.000Z","role":"assistant","text":"trabajando"}\n' > "$TMP/b-events.jsonl"

B_OUT=$(compute_stage_metrics "$TMP/b-events.jsonl")
RC=$?
if [ "$RC" -eq 0 ] && [ "$B_OUT" = "null" ]; then
    pass "B-1: sin evento terminal, la funcion retorna exit 0 y \"null\""
else
    fail "B-1: se esperaba exit 0 y 'null', se obtuvo rc=$RC salida='$B_OUT'"
fi

# -------- Bloque C: archivo vacio --------

echo ""
echo "[C] Archivo vacio -> \"null\" (CA-5)"

: > "$TMP/c-events.jsonl"
C_OUT=$(compute_stage_metrics "$TMP/c-events.jsonl")
RC=$?
if [ "$RC" -eq 0 ] && [ "$C_OUT" = "null" ]; then
    pass "C-1: archivo vacio, exit 0 y 'null'"
else
    fail "C-1: se esperaba exit 0 y 'null', se obtuvo rc=$RC salida='$C_OUT'"
fi

# -------- Bloque D: linea truncada, con terminal valido despues --------

echo ""
echo "[D] Linea truncada a mitad, con terminal valido despues -> se ignora sin abortar (CA-1/CA-5)"

{
    printf '{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:34.000Z","tool":"Bash","input_summary":"ls'
    printf '\n'
    printf '{"v":1,"type":"run.completed","ts":"2026-07-27T22:09:35.000Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null,"cache_read":null,"cache_write":null,"reasoning":null},"estimated_cost_usd":null,"turns":1,"denials":null,"ttft_ms":null,"api_duration_ms":80,"error":null}\n'
} > "$TMP/d-events.jsonl"

(
    set -euo pipefail
    D_OUT=$(compute_stage_metrics "$TMP/d-events.jsonl")
    echo "$D_OUT" > "$TMP/d-out.txt"
)
RC=$?

if [ "$RC" -eq 0 ]; then
    pass "D-1: linea truncada no aborta el pipeline (set -euo pipefail activo)"
else
    fail "D-1: se esperaba exit 0, se obtuvo $RC"
fi

D_OUT=$(cat "$TMP/d-out.txt" 2>/dev/null)
if echo "$D_OUT" | jq -e '.turns == 1 and .duration_ms == 100' >/dev/null 2>&1; then
    pass "D-2: el terminal valido posterior a la linea rota si se deriva"
else
    fail "D-2: no se derivaron las metricas del terminal valido: $D_OUT"
fi

if echo "$D_OUT" | jq -e '.estimated_cost_usd == null and .tokens == {input:null, output:null, cache_read:null, cache_write:null, reasoning:null}' >/dev/null 2>&1; then
    pass "D-3: campos estimados y tokens null se copian sin reconstruirlos"
else
    fail "D-3: no se preservaron los campos null del terminal: $D_OUT"
fi

if echo "$D_OUT" | jq -e '.tool_calls | length == 0' >/dev/null 2>&1; then
    pass "D-4: la tool call de la linea truncada no aparece en el histograma"
else
    fail "D-4: la linea truncada dejo rastro en tool_calls: $D_OUT"
fi

# -------- Bloque E: jq ausente --------

echo ""
echo "[E] jq ausente -> degrada a \"null\" sin abortar (CA-5)"

E_PATH_SIN_JQ="$TMP/bin-sin-jq"
mkdir -p "$E_PATH_SIN_JQ"

(
    set -euo pipefail
    PATH="$E_PATH_SIN_JQ:/bin"
    E_OUT=$(compute_stage_metrics "$TMP/a-events.jsonl")
    echo "$E_OUT" > "$TMP/e-out.txt"
)
RC=$?

E_OUT=$(cat "$TMP/e-out.txt" 2>/dev/null)
if [ "$RC" -eq 0 ] && [ "$E_OUT" = "null" ]; then
    pass "E-1: sin jq en PATH, exit 0 y 'null'"
else
    fail "E-1: se esperaba exit 0 y 'null', se obtuvo rc=$RC salida='$E_OUT'"
fi

# -------- Bloque F: costo estimado cero y evento legacy --------

echo ""
echo "[F] estimated_cost_usd:0 se preserva; cost_usd legacy no se rebautiza"

cat > "$TMP/f-events.jsonl" <<'EOF'
{"v":1,"type":"run.completed","ts":"2026-07-27T22:09:30.000Z","status":"success","runtime":"fake","model":null,"session_id":null,"duration_ms":500,"tokens":{"input":10,"output":5,"cache_read":null,"cache_write":null,"reasoning":null},"estimated_cost_usd":0,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}
EOF

F_OUT=$(compute_stage_metrics "$TMP/f-events.jsonl")
F_COST=$(echo "$F_OUT" | jq -r '.estimated_cost_usd')
if [ "$F_COST" = "0" ]; then
    pass "F-1: estimated_cost_usd:0 se preserva (jq // no colapsa cero)"
else
    fail "F-1: estimated_cost_usd deberia ser '0', se obtuvo '$F_COST': $F_OUT"
fi

cat > "$TMP/f-legacy-events.jsonl" <<'EOF'
{"v":1,"type":"run.completed","ts":"2026-07-27T22:09:30.000Z","status":"success","runtime":"fake","model":null,"session_id":null,"duration_ms":500,"tokens":{"input":10,"output":5},"cost_usd":0,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}
EOF

F_LEGACY_OUT=$(compute_stage_metrics "$TMP/f-legacy-events.jsonl")
if echo "$F_LEGACY_OUT" | jq -e 'has("estimated_cost_usd") and .estimated_cost_usd == null and (has("cost_usd") | not)' >/dev/null 2>&1; then
    pass "F-2: evento legacy con cost_usd:0 produce estimated_cost_usd:null sin abortar"
else
    fail "F-2: el evento legacy rebautizo cost_usd o no produjo null: $F_LEGACY_OUT"
fi

# -------- Bloque G: tool.completed con duration_ms null (huerfana parcial) --------

echo ""
echo "[G] tool.completed con duration_ms:null -> cuenta en count, no en duration_ms_sum/median"

cat > "$TMP/g-events.jsonl" <<'EOF'
{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:34.000Z","tool":"Bash","input_summary":null}
{"v":1,"type":"tool.completed","ts":"2026-07-27T22:09:34.100Z","tool":"Bash","ok":true,"duration_ms":null}
{"v":1,"type":"run.completed","ts":"2026-07-27T22:09:35.000Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":1,"denials":null,"ttft_ms":null,"api_duration_ms":80,"error":null}
EOF

G_OUT=$(compute_stage_metrics "$TMP/g-events.jsonl")
assert_field "G-1: count incluye la tool call con duration_ms null" "1" "$(echo "$G_OUT" | jq -r '.tool_calls[0].count')"
assert_field "G-2: duration_ms_sum es null" "null" "$(echo "$G_OUT" | jq -r '.tool_calls[0].duration_ms_sum')"
assert_field "G-3: duration_ms_median es null" "null" "$(echo "$G_OUT" | jq -r '.tool_calls[0].duration_ms_median')"

# -------- Bloque H: tool.started sin ningun tool.completed (huerfana total) --------

echo ""
echo "[H] tool.started sin tool.completed emparejado -> cuenta en count, no en duration_ms_sum/median"

cat > "$TMP/h-events.jsonl" <<'EOF'
{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:34.000Z","tool":"Bash","input_summary":null}
{"v":1,"type":"run.completed","ts":"2026-07-27T22:09:35.000Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":1,"denials":null,"ttft_ms":null,"api_duration_ms":80,"error":null}
EOF

H_OUT=$(compute_stage_metrics "$TMP/h-events.jsonl")
assert_field "H-1: count incluye la tool call huerfana" "1" "$(echo "$H_OUT" | jq -r '.tool_calls[0].count')"
assert_field "H-2: duration_ms_sum es null (sin tool.completed para emparejar)" "null" "$(echo "$H_OUT" | jq -r '.tool_calls[0].duration_ms_sum')"
assert_field "H-3: duration_ms_median es null" "null" "$(echo "$H_OUT" | jq -r '.tool_calls[0].duration_ms_median')"

# -------- Bloque I: campos opcionales ausentes del todo en el terminal --------

echo ""
echo "[I] Campos opcionales ausentes DEL TODO en el terminal (ni como null) -> no abortan (CA-5)"

cat > "$TMP/i-events.jsonl" <<'EOF'
{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:34.000Z","tool":"Grep","input_summary":null}
{"v":1,"type":"tool.completed","ts":"2026-07-27T22:09:34.200Z","tool":"Grep","ok":true,"duration_ms":150}
{"v":1,"type":"run.completed","ts":"2026-07-27T22:09:35.000Z","status":"success","runtime":"claude","model":"claude-sonnet-5","duration_ms":500,"tokens":{"input":10,"output":5},"cost_usd":0.001,"turns":2,"api_duration_ms":300,"error":null}
EOF

I_OUT=$(compute_stage_metrics "$TMP/i-events.jsonl")
assert_field "I-1: turns se deriva igual pese a las claves ausentes" "2" "$(echo "$I_OUT" | jq -r '.turns')"
assert_field "I-2: ttft_ms ausente -> null" "null" "$(echo "$I_OUT" | jq -r '.ttft_ms')"
assert_field "I-3: denials ausente -> null" "null" "$(echo "$I_OUT" | jq -r '.denials')"
assert_field "I-4: tool_calls[Grep].duration_ms_sum sigue derivandose" "150" "$(echo "$I_OUT" | jq -r '.tool_calls[0].duration_ms_sum')"

# -------- Bloque J: build_agents_history_json --------

echo ""
echo "[J] build_agents_history_json: agrega metrics y runtime preservando duration (CA-2); sin jq degrada al formato plano (CA-5)"

J_OUT=$(build_agents_history_json "125" "$A_OUT" "210" "null")
assert_field "J-1: preserva writer.duration" "125" "$(echo "$J_OUT" | jq -r '.writer.duration')"
assert_field "J-2: preserva reviewer.duration" "210" "$(echo "$J_OUT" | jq -r '.reviewer.duration')"
assert_field "J-3: agrega writer.metrics.turns" "4" "$(echo "$J_OUT" | jq -r '.writer.metrics.turns')"
assert_field "J-4: reviewer.metrics es null cuando no corrio ese stage" "null" "$(echo "$J_OUT" | jq -r '.reviewer.metrics')"
assert_field "J-5: agrega writer.runtime (issue #907)" "claude" "$(echo "$J_OUT" | jq -r '.writer.runtime')"
assert_field "J-6: reviewer.runtime es null cuando no hay metrics" "null" "$(echo "$J_OUT" | jq -r '.reviewer.runtime')"
if echo "$J_OUT" | jq -e '[.[] | .metrics | select(. != null) | .. | objects | has("cost_usd") or has("cache_creation")] | any | not' >/dev/null 2>&1; then
    pass "J-7: el historial nuevo no duplica cost_usd ni cache_creation dentro de metrics"
else
    fail "J-7: el historial nuevo conserva nombres legacy dentro de metrics: $J_OUT"
fi

J_NOJQ_OUT=$(PATH="$E_PATH_SIN_JQ:/bin" build_agents_history_json "125" "" "" "")
if echo "$J_NOJQ_OUT" | grep -qF '"writer":{"duration":125}' \
    && ! echo "$J_NOJQ_OUT" | grep -q "metrics" \
    && ! echo "$J_NOJQ_OUT" | grep -q "runtime"; then
    pass "J-8: sin jq, degrada al formato plano legado (mismas dos claves, sin 'metrics' ni 'runtime')"
else
    fail "J-8: el degrade sin jq no coincide con el formato legado: $J_NOJQ_OUT"
fi

# -------- Bloque K: integracion -- linea de historial valida --------

echo ""
echo "[K] Integracion: la linea de historial resultante es JSON valido de una sola linea (CA-4)"

HISTORY_LINE="{\"issue\":\"907\",\"title\":\"Test\",\"pipeline\":\"mefisto-tooling\",\"started\":\"20260906-100000\",\"finished\":\"2026-09-06T10:10:00\",\"state\":\"completed\",\"agents\":$J_OUT,\"pr\":\"https://github.com/x/y/pull/1\"}"

if [ "$(echo "$HISTORY_LINE" | wc -l)" -eq 1 ]; then
    pass "K-1: la entrada ocupa una sola linea"
else
    fail "K-1: la entrada ocupa mas de una linea"
fi

if echo "$HISTORY_LINE" | jq -e '.' >/dev/null 2>&1; then
    pass "K-2: la entrada es JSON valido"
else
    fail "K-2: la entrada no es JSON valido: $HISTORY_LINE"
fi

assert_field "K-3: agents.writer.duration sigue siendo numerico (campo legado intacto)" "125" "$(echo "$HISTORY_LINE" | jq -r '.agents.writer.duration')"
assert_field "K-4: agents.writer.metrics.turns esta presente (campo nuevo)" "4" "$(echo "$HISTORY_LINE" | jq -r '.agents.writer.metrics.turns')"
assert_field "K-5: agents.writer.runtime esta presente (campo nuevo)" "claude" "$(echo "$HISTORY_LINE" | jq -r '.agents.writer.runtime')"

# -------- Bloque M: exito con tool calls sobre el fixture real de Claude --------

echo ""
echo "[M] Fixture real de Claude: exito con tools (CA-4)"

if ! declare -F runtime_claude_translate >/dev/null; then
    fail "M-pre: runtime_claude_translate NO definida (falta sourcear runtime-claude.sh)"
fi

M_CLAUDE_EVENTS="$TMP/m-claude-events.jsonl"
runtime_claude_translate "$FIXTURES_CLAUDE/success.jsonl" "claude" "claude-sonnet-5" "0" "" > "$M_CLAUDE_EVENTS"

M_CLAUDE_OUT=$(compute_stage_metrics "$M_CLAUDE_EVENTS")

assert_field "M-1: status success" "success" "$(echo "$M_CLAUDE_OUT" | jq -r '.status')"
assert_field "M-2: tool_calls trae el nombre propio del runtime (Read)" "Read" "$(echo "$M_CLAUDE_OUT" | jq -r '.tool_calls[0].name')"
assert_field "M-3: tool_calls[0].count" "1" "$(echo "$M_CLAUDE_OUT" | jq -r '.tool_calls[0].count')"

if echo "$M_CLAUDE_OUT" | jq -e '.tool_calls[0] | has("name") and has("count") and has("duration_ms_sum") and has("duration_ms_median")' >/dev/null 2>&1; then
    pass "M-4: tool_calls[0] tiene la forma name/count/duration_ms_sum/duration_ms_median"
else
    fail "M-4: forma inesperada de tool_calls: $M_CLAUDE_OUT"
fi

if echo "$M_CLAUDE_OUT" | jq -e '.ttft_ms != null and .turns != null and .api_duration_ms != null' >/dev/null 2>&1; then
    pass "M-5: preserva ttft_ms/turns/api_duration_ms (no null)"
else
    fail "M-5: se perdieron ttft_ms/turns/api_duration_ms: $M_CLAUDE_OUT"
fi

# -------- Bloque N: fallo api_error y timeout, cifras pobladas o en null --------

echo ""
echo "[N] Fallo api_error y timeout: mismo status/error_kind con cifras pobladas o en null (CA-4)"

cat > "$TMP/n-api-claude-events.jsonl" <<'EOF'
{"v":1,"type":"run.failed","ts":"2026-09-06T10:00:00Z","status":"failed","runtime":"claude","model":"claude-sonnet-5","session_id":"sess-1","duration_ms":45000,"tokens":{"input":100,"output":20},"cost_usd":0.05,"turns":3,"denials":0,"ttft_ms":500,"api_duration_ms":40000,"error":{"kind":"api_error","detail":"API Error: 529"}}
EOF
cat > "$TMP/n-api-null-events.jsonl" <<'EOF'
{"v":1,"type":"run.failed","ts":"2026-09-06T10:00:00Z","status":"failed","runtime":"fake","model":null,"session_id":null,"duration_ms":12000,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"api_error","detail":"el proceso termino con exit 1"}}
EOF

N_API_CLAUDE_OUT=$(compute_stage_metrics "$TMP/n-api-claude-events.jsonl")
N_API_NULL_OUT=$(compute_stage_metrics "$TMP/n-api-null-events.jsonl")

assert_field "N-1: status api_error (cifras pobladas)" "failed" "$(echo "$N_API_CLAUDE_OUT" | jq -r '.status')"
assert_field "N-2: status api_error (cifras en null)" "failed" "$(echo "$N_API_NULL_OUT" | jq -r '.status')"
assert_field "N-3: error_kind api_error (cifras pobladas)" "api_error" "$(echo "$N_API_CLAUDE_OUT" | jq -r '.error_kind')"
assert_field "N-4: error_kind api_error (cifras en null)" "api_error" "$(echo "$N_API_NULL_OUT" | jq -r '.error_kind')"

cat > "$TMP/n-timeout-claude-events.jsonl" <<'EOF'
{"v":1,"type":"run.failed","ts":"2026-09-06T10:05:00Z","status":"timeout","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":1800000,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"timeout","detail":"el watchdog mato el proceso tras superar 1800s"}}
EOF
cat > "$TMP/n-timeout-null-events.jsonl" <<'EOF'
{"v":1,"type":"run.failed","ts":"2026-09-06T10:05:00Z","status":"timeout","runtime":"fake","model":null,"session_id":null,"duration_ms":1800000,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"timeout","detail":"el watchdog mato el proceso tras superar 1800s"}}
EOF

N_TIMEOUT_CLAUDE_OUT=$(compute_stage_metrics "$TMP/n-timeout-claude-events.jsonl")
N_TIMEOUT_NULL_OUT=$(compute_stage_metrics "$TMP/n-timeout-null-events.jsonl")

assert_field "N-5: status timeout (cifras pobladas)" "timeout" "$(echo "$N_TIMEOUT_CLAUDE_OUT" | jq -r '.status')"
assert_field "N-6: status timeout (cifras en null)" "timeout" "$(echo "$N_TIMEOUT_NULL_OUT" | jq -r '.status')"
assert_field "N-7: error_kind timeout (cifras pobladas)" "timeout" "$(echo "$N_TIMEOUT_CLAUDE_OUT" | jq -r '.error_kind')"
assert_field "N-8: error_kind timeout (cifras en null)" "timeout" "$(echo "$N_TIMEOUT_NULL_OUT" | jq -r '.error_kind')"

# -------- Bloque O: guarda de neutralidad del cuerpo de la funcion --------

echo ""
echo "[O] compute_stage_metrics no nombra el vocabulario de Claude Code (CA-1)"

# El rango va de la firma a la primera llave de cierre en columna 0: el jq
# embebido esta todo indentado, asi que ninguna de sus lineas cierra el rango
# antes de tiempo. Se lee la fuente canonica (src/internal/scripts/lib/), no el
# shim de .claude/scripts/.
O_BODY=$(awk '/^compute_stage_metrics\(\) \{/,/^\}/' "$LIB_DIR/_mefisto-common.sh")

if [ -z "$O_BODY" ]; then
    fail "O-pre: no se pudo extraer el cuerpo de compute_stage_metrics de _mefisto-common.sh"
fi

for token in 'type == "assistant"' '"result"' 'is_error' 'stop_reason' 'num_turns' 'total_cost_usd' 'rate_limit_event'; do
    if printf '%s' "$O_BODY" | grep -qF -- "$token"; then
        fail "O: el cuerpo de compute_stage_metrics todavia nombra '$token' -- CA-1 exige que derive solo del vocabulario neutral"
    else
        pass "O: el cuerpo de compute_stage_metrics no nombra '$token'"
    fi
done

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
