#!/usr/bin/env bash
# test-agent-failure-hold.sh -- Tests de la clasificacion unificada de fallos
# de agente y la politica de espera (hold) del lado publicado (issue #971).
#
# Contexto: hasta este issue, tdd-pipeline.sh y tooling-pipeline.sh (hoy
# en TypeScript, cubiertos por sus *-pipeline*.test.mts)
# duplicaban byte a byte una cadena de `grep` sobre el log del stage para
# clasificar el fallo ("API Error: 5" / "API Error: 4" / resto CLI_ERROR), y
# el reintento ante 5xx era one-shot y solo corria "sin trabajo previo".
# Este issue extrae esa clasificacion a classify_agent_failure y la politica
# de espera a agent_failure_is_holdable/agent_hold_wait, ambas en
# _pipeline-common.sh, con los MISMOS defaults/variables de entorno que el
# homologo interno (MEF-ADR-0051, issue #967 del lado interno) -- divergir
# seria doctrina duplicada.
#
# Casos cubiertos:
#   [1] classify_agent_failure: TIMEOUT por senal (137/143), sin mirar el log.
#   [2] classify_agent_failure: RATE_LIMIT detectado en el stream crudo
#       (evento estructurado rate_limit_event con status != "allowed"),
#       aunque el log derivado no traiga "429" en texto.
#   [3] classify_agent_failure: RATE_LIMIT por el fallback de texto (sin
#       stream capturado) -- exige "429" Y un indicio de "rate limit"/"usage
#       limit" a la vez, para no confundir un 4xx no relacionado.
#   [4] classify_agent_failure: PROVIDER_UNAVAILABLE ("API Error: 5" en el
#       log, reemplazo 1:1 de la vieja etiqueta API_ERROR_SERVER).
#   [5] classify_agent_failure: API_ERROR_CLIENT ("API Error: 4" en el log).
#   [6] classify_agent_failure: CLI_ERROR (fallback, causa no identificada).
#   [7] agent_failure_is_holdable: RATE_LIMIT/PROVIDER_UNAVAILABLE si,
#       API_ERROR_CLIENT/CLI_ERROR/TIMEOUT no.
#   [8] agent_hold_wait: duerme la sonda, deja la linea [hold] en events.log
#       con el mismo formato que el lado interno, y retorna los segundos
#       dormidos.
#   [9] agent_hold_wait: techo agotado -> retorna 1 SIN dormir de nuevo.
#   [9b] agent_hold_wait: la sonda se recorta al remanente del techo -- nunca
#        duerme mas alla de MEFISTO_HOLD_MAX_SECONDS.
#   [10] CA-6: _pipeline-common.sh define classify_agent_failure/
#        agent_failure_is_holdable/agent_hold_wait. Los pipelines que las
#        consumian ya estan en TypeScript y cubren su clasificacion, su espera
#        y el watchdog de la sonda en sus propios tests (*-pipeline*.test.mts).
#
# Uso: scripts/tests/test-agent-failure-hold.sh
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

echo "[1] classify_agent_failure: TIMEOUT por senal, sin mirar el log"
LOG_EMPTY="$TMP/empty.log"
: > "$LOG_EMPTY"
R=$(classify_agent_failure "137" "1800" "$LOG_EMPTY" "")
case "$R" in
    "TIMEOUT (signal 137, 1800s)") pass "exit 137 -> TIMEOUT" ;;
    *) fail "esperaba TIMEOUT, obtuve '$R'" ;;
esac
R=$(classify_agent_failure "143" "42" "$LOG_EMPTY" "")
case "$R" in
    "TIMEOUT (signal 143, 42s)") pass "exit 143 -> TIMEOUT" ;;
    *) fail "esperaba TIMEOUT, obtuve '$R'" ;;
esac

echo ""
echo "[2] classify_agent_failure: RATE_LIMIT via evento estructurado del stream (issue #965 portado)"
STREAM_RATE_LIMIT="$TMP/rate-limit.stream.jsonl"
LOG_NO_429_TEXT="$TMP/rate-limit.log"
cat > "$STREAM_RATE_LIMIT" <<'JSONL'
{"type":"system","subtype":"init","session_id":"abc"}
{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","status":"allowed"}}
{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","status":"rejected"}}
{"type":"result","is_error":true,"subtype":"success"}
JSONL
echo "algo salio mal" > "$LOG_NO_429_TEXT"
R=$(classify_agent_failure "1" "5" "$LOG_NO_429_TEXT" "$STREAM_RATE_LIMIT")
case "$R" in
    "RATE_LIMIT (exit 1)") pass "rate_limit_event{status:rejected} -> RATE_LIMIT aunque el log no diga 429" ;;
    *) fail "esperaba RATE_LIMIT, obtuve '$R'" ;;
esac

echo ""
echo "[2b] classify_agent_failure: un rate_limit_event solo 'allowed' NO dispara RATE_LIMIT"
STREAM_ALLOWED_ONLY="$TMP/allowed-only.stream.jsonl"
cat > "$STREAM_ALLOWED_ONLY" <<'JSONL'
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}
{"type":"result","is_error":true,"subtype":"success"}
JSONL
LOG_5XX="$TMP/5xx.log"
echo "API Error: 529 Overloaded" > "$LOG_5XX"
R=$(classify_agent_failure "1" "5" "$LOG_5XX" "$STREAM_ALLOWED_ONLY")
case "$R" in
    "PROVIDER_UNAVAILABLE (exit 1)") pass "sin rechazo real, cae al grep de texto (PROVIDER_UNAVAILABLE)" ;;
    *) fail "esperaba PROVIDER_UNAVAILABLE, obtuve '$R'" ;;
esac

echo ""
echo "[3] classify_agent_failure: RATE_LIMIT por fallback de texto (sin stream capturado)"
LOG_429_TEXT="$TMP/429-text.log"
echo "Error: 429 Too Many Requests -- rate limit exceeded, try again later" > "$LOG_429_TEXT"
R=$(classify_agent_failure "1" "3" "$LOG_429_TEXT" "")
case "$R" in
    "RATE_LIMIT (exit 1)") pass "429 + 'rate limit' en texto -> RATE_LIMIT" ;;
    *) fail "esperaba RATE_LIMIT, obtuve '$R'" ;;
esac

echo ""
echo "[3b] classify_agent_failure: un 429 SIN indicio de rate/usage limit no dispara RATE_LIMIT (evita falso positivo)"
LOG_429_SOLO="$TMP/429-solo.log"
echo "HTTP 429 -- pero de otro subsistema, sin relacion" > "$LOG_429_SOLO"
R=$(classify_agent_failure "1" "3" "$LOG_429_SOLO" "")
case "$R" in
    "CLI_ERROR (exit 1)") pass "429 aislado, sin 'rate/usage limit' -> no es RATE_LIMIT (cae a CLI_ERROR)" ;;
    *) fail "esperaba CLI_ERROR, obtuve '$R'" ;;
esac

echo ""
echo "[4] classify_agent_failure: PROVIDER_UNAVAILABLE (reemplazo 1:1 de API_ERROR_SERVER)"
R=$(classify_agent_failure "1" "10" "$LOG_5XX" "")
case "$R" in
    "PROVIDER_UNAVAILABLE (exit 1)") pass "'API Error: 5' -> PROVIDER_UNAVAILABLE" ;;
    *) fail "esperaba PROVIDER_UNAVAILABLE, obtuve '$R'" ;;
esac

echo ""
echo "[5] classify_agent_failure: API_ERROR_CLIENT"
LOG_4XX="$TMP/4xx.log"
echo "API Error: 401 Unauthorized" > "$LOG_4XX"
R=$(classify_agent_failure "1" "2" "$LOG_4XX" "")
case "$R" in
    "API_ERROR_CLIENT (exit 1)") pass "'API Error: 4' -> API_ERROR_CLIENT" ;;
    *) fail "esperaba API_ERROR_CLIENT, obtuve '$R'" ;;
esac

echo ""
echo "[6] classify_agent_failure: CLI_ERROR (fallback)"
LOG_GENERIC="$TMP/generic.log"
echo "algo no reconocido fallo" > "$LOG_GENERIC"
R=$(classify_agent_failure "1" "7" "$LOG_GENERIC" "")
case "$R" in
    "CLI_ERROR (exit 1)") pass "causa no identificada -> CLI_ERROR" ;;
    *) fail "esperaba CLI_ERROR, obtuve '$R'" ;;
esac

echo ""
echo "[7] agent_failure_is_holdable: solo RATE_LIMIT/PROVIDER_UNAVAILABLE son holdable"
if agent_failure_is_holdable "RATE_LIMIT (exit 1)"; then pass "RATE_LIMIT es holdable"; else fail "RATE_LIMIT deberia ser holdable"; fi
if agent_failure_is_holdable "PROVIDER_UNAVAILABLE (exit 1)"; then pass "PROVIDER_UNAVAILABLE es holdable"; else fail "PROVIDER_UNAVAILABLE deberia ser holdable"; fi
if agent_failure_is_holdable "API_ERROR_CLIENT (exit 1)"; then fail "API_ERROR_CLIENT no deberia ser holdable"; else pass "API_ERROR_CLIENT no es holdable"; fi
if agent_failure_is_holdable "CLI_ERROR (exit 1)"; then fail "CLI_ERROR no deberia ser holdable"; else pass "CLI_ERROR no es holdable"; fi
if agent_failure_is_holdable "TIMEOUT (signal 137, 5s)"; then fail "TIMEOUT no deberia ser holdable"; else pass "TIMEOUT no es holdable"; fi

echo ""
echo "[8] agent_hold_wait: duerme la sonda y deja la linea [hold] con el mismo formato que el interno"
EVENTS_LOG_TEST="$TMP/events.log"
: > "$EVENTS_LOG_TEST"
export MEFISTO_HOLD_PROBE_SECONDS=1
export MEFISTO_HOLD_MAX_SECONDS=3600
NOW_TS=$(date +%s)
SLEPT=$(agent_hold_wait "$EVENTS_LOG_TEST" "RATE_LIMIT (exit 1)" "$NOW_TS")
if [ "$SLEPT" = "1" ]; then pass "durmio exactamente la sonda (1s)"; else fail "esperaba dormir 1s, obtuve '$SLEPT'"; fi
if grep -q "\[hold\] RATE_LIMIT: esperando, proxima sonda .* (techo " "$EVENTS_LOG_TEST"; then
    pass "linea [hold] con el formato esperado"
else
    fail "linea [hold] no encontrada o con formato distinto: $(cat "$EVENTS_LOG_TEST")"
fi

echo ""
echo "[9] agent_hold_wait: techo ya agotado -> retorna 1 sin dormir"
PAST_TS=$(( $(date +%s) - 7200 ))
export MEFISTO_HOLD_MAX_SECONDS=3600
: > "$EVENTS_LOG_TEST"
if agent_hold_wait "$EVENTS_LOG_TEST" "PROVIDER_UNAVAILABLE (exit 1)" "$PAST_TS" >/dev/null; then
    fail "deberia retornar 1 con el techo agotado"
else
    pass "retorna 1 con el techo agotado"
fi
if [ -s "$EVENTS_LOG_TEST" ]; then fail "no deberia escribir linea [hold] si ya no va a dormir"; else pass "sin linea [hold] espuria"; fi

echo ""
echo "[9b] agent_hold_wait: la sonda se recorta al remanente del techo"
: > "$EVENTS_LOG_TEST"
export MEFISTO_HOLD_PROBE_SECONDS=60
export MEFISTO_HOLD_MAX_SECONDS=2
NOW_TS=$(date +%s)
SLEPT=$(agent_hold_wait "$EVENTS_LOG_TEST" "RATE_LIMIT (exit 1)" "$NOW_TS")
if [ "$SLEPT" = "2" ]; then
    pass "sonda de 60s recortada al remanente del techo (2s)"
else
    fail "esperaba dormir 2s (remanente del techo), obtuve '$SLEPT'"
fi
unset MEFISTO_HOLD_PROBE_SECONDS MEFISTO_HOLD_MAX_SECONDS

echo ""
echo "[10] CA-6: _pipeline-common.sh define la politica compartida"
for fn in classify_agent_failure agent_failure_is_holdable agent_hold_wait; do
    if grep -qE "^${fn}\(\)" "$REPO_ROOT/scripts/_pipeline-common.sh"; then
        pass "_pipeline-common.sh define $fn"
    else
        fail "_pipeline-common.sh deberia definir $fn"
    fi
done

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
