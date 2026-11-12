#!/usr/bin/env bash
# test-agent-retry.sh -- Tests del reintento con backoff ante fallo transitorio
# del servidor (issue #534, actualizada sobre el JSONL neutral en el issue
# #906, y sobre el runner neutral en el issue #910).
#
# Contexto (medido el 2026-08-05): 6 de 10 intentos de stage murieron con
# 522/529 de api.anthropic.com. El pipeline no reintentaba nunca, asi que cada
# uno tiraba el trabajo del stage entero pese a que el payload del 522 declara
# `"retryable": true, "retry_after": 120`.
#
# classify_agent_failure lee `error.kind`/`error.detail` del
# `<log_base>.events.jsonl` que, desde el issue #910, escribe directo
# mefisto-run-agent.sh (run_agent ya no traduce nada -- ese puente era del
# issue #906 y se retiro). El bloque [A] usa fixtures de JSONL neutral
# escritas a mano (conforme a run-events.schema.json). El bucle de reintento
# del pipeline interno lo prueba mefisto-tooling-pipeline-agent.test.mts.
#
# Casos cubiertos:
#   [pre] las funciones nuevas existen en _mefisto-common.sh
#   [A]   classify_agent_failure: paridad con la clasificacion anterior, ahora
#         leyendo el JSONL neutral en vez de grepear un log de texto
#   [B]   agent_failure_is_retryable: solo PROVIDER_UNAVAILABLE reintenta
#         (issue #965: reemplaza a la vieja etiqueta API_ERROR_SERVER; RATE_LIMIT,
#         la otra etiqueta nueva del issue, queda deliberadamente fuera)
#
# Uso: .claude/scripts/tests/test-agent-retry.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre --------

echo "[pre] Las funciones nuevas estan definidas en _mefisto-common.sh"
for fn in classify_agent_failure agent_failure_is_retryable agent_events_error_kind; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: classify_agent_failure --------

echo ""
echo "[A] classify_agent_failure conserva las etiquetas, ahora desde el JSONL neutral"

# Fixtures inline conforme a run-events.schema.json (issue #906, kinds
# "rate_limit"/"provider_unavailable" agregados en el issue #965): un
# terminal run.completed/run.failed con `error{kind, detail}` estructurado.
# Desde #965 el kind YA viene disambiguado del adaptador -- EVENTS_5XX usa
# "provider_unavailable" (no "api_error") porque asi es como runtime-claude.jq
# clasifica hoy un 529 (ver su elif de `api_error_status | test("^5")`).
EVENTS_5XX="$TMP/events-5xx.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"provider_unavailable","detail":"API Error: 529 Overloaded"}}' > "$EVENTS_5XX"
EVENTS_RATE_LIMIT="$TMP/events-rate-limit.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"ventana de uso agotada (rateLimitType=five_hour, resetsAt=2026-08-05T15:00:00Z)"},"resets_at":"2026-08-05T15:00:00Z"}' > "$EVENTS_RATE_LIMIT"
EVENTS_4XX="$TMP/events-4xx.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"api_error","detail":"API Error: 400 Bad Request"}}' > "$EVENTS_4XX"
EVENTS_CUT="$TMP/events-cut.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"stream_cut","detail":"Connection closed mid-response"}}' > "$EVENTS_CUT"
EVENTS_PLAIN="$TMP/events-plain.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"nonzero_exit","detail":"stop_reason=? subtype=?"}}' > "$EVENTS_PLAIN"
EVENTS_OK="$TMP/events-ok.jsonl"
printf '%s\n' '{"v":1,"type":"run.completed","ts":"2026-08-05T10:00:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}' > "$EVENTS_OK"
EVENTS_BAD="$TMP/events-bad.jsonl"
printf '%s\n' '{"v":1,"type":"message","ts":"2026-08-05T10:00:00Z","role":"assistant","text":"trabajando"}' > "$EVENTS_BAD"

check_label() {
    local desc="$1" expected="$2"; shift 2
    local got
    got=$(classify_agent_failure "$@")
    if [ "$got" = "$expected" ]; then
        pass "$desc -> $expected"
    else
        fail "$desc: se esperaba '$expected', se obtuvo '$got'"
    fi
}

check_label "A-1: watchdog disparo" \
    "TIMEOUT (99s, exit 1)"                 "true"  "1"   "99" "$EVENTS_BAD"
check_label "A-2: senal con terminal de exito" \
    "SIGNAL_POST_SUCCESS (exit 137, 12s)"   "false" "137" "12" "$EVENTS_OK"
check_label "A-3: senal sin terminal" \
    "SIGNAL_MID_FLIGHT (exit 137, 12s)"     "false" "137" "12" "$EVENTS_BAD"
check_label "A-4: 5xx del proveedor (kind provider_unavailable)" \
    "PROVIDER_UNAVAILABLE (exit 1)"         "false" "1"   "12" "$EVENTS_5XX"
check_label "A-5: 4xx del cliente" \
    "API_ERROR_CLIENT (exit 1)"             "false" "1"   "12" "$EVENTS_4XX"
check_label "A-6: corte de stream" \
    "STREAM_CUT (exit 1)"                   "false" "1"   "12" "$EVENTS_CUT"
check_label "A-7: sin sintoma reconocible" \
    "CLI_ERROR (exit 3)"                    "false" "3"   "12" "$EVENTS_PLAIN"
check_label "A-9: ventana de uso agotada (kind rate_limit, issue #965)" \
    "RATE_LIMIT (exit 1)"                   "false" "1"   "12" "$EVENTS_RATE_LIMIT"
# El orden importa: un TIMEOUT del watchdog gana aunque el terminal traiga un 5xx.
check_label "A-8: TIMEOUT precede al 5xx" \
    "TIMEOUT (99s, exit 1)"                 "true"  "1"   "99" "$EVENTS_5XX"

# -------- Bloque B: agent_failure_is_retryable --------

echo ""
echo "[B] agent_failure_is_retryable: solo el 5xx transitorio se reintenta"

if agent_failure_is_retryable "PROVIDER_UNAVAILABLE (exit 1)"; then
    pass "B-1: PROVIDER_UNAVAILABLE es reintentable"
else
    fail "B-1: PROVIDER_UNAVAILABLE deberia ser reintentable"
fi

# RATE_LIMIT (issue #965) queda deliberadamente FUERA del reintento con
# backoff corto de este bucle: una ventana de 5h agotada no se arregla en
# segundos, hace falta la politica de espera (hold, issue #967) que prueba
# test-agent-hold.sh.
for label in "TIMEOUT (1800s, exit 137)" "API_ERROR_CLIENT (exit 1)" \
             "STREAM_CUT (exit 1)" "CLI_ERROR (exit 3)" \
             "RATE_LIMIT (exit 1)" \
             "SIGNAL_MID_FLIGHT (exit 137, 12s)" "SIGNAL_POST_SUCCESS (exit 137, 12s)" ""; do
    if agent_failure_is_retryable "$label"; then
        fail "B-2: '$label' NO deberia ser reintentable"
    else
        pass "B-2: '${label:-<vacio>}' no se reintenta"
    fi
done

# -------- Resumen --------

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
