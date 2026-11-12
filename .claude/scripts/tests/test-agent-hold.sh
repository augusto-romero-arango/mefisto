#!/usr/bin/env bash
# test-agent-hold.sh -- Tests de la politica de espera (hold) ante
# RATE_LIMIT/PROVIDER_UNAVAILABLE persistente (issue #967).
#
# Contexto: el reintento con backoff del issue #534 ya distinguia un fallo
# transitorio del proveedor, pero con la politica equivocada para una ventana
# de uso agotada o un proveedor caido de verdad -- espera fija y corta
# (MEFISTO_AGENT_RETRY_BACKOFF_SECONDS, default 120s) y presupuesto de
# intentos limitado (MEFISTO_AGENT_MAX_ATTEMPTS, default 3). Este issue agrega
# una SEGUNDA politica al mismo bucle de run_agent del pipeline interno:
# cuando RATE_LIMIT (nunca retryable con el backoff corto, #965) o
# PROVIDER_UNAVAILABLE (una vez agotado ese backoff corto) siguen fallando, el
# stage no aborta -- se sienta a esperar, con su propio techo
# (MEFISTO_HOLD_MAX_SECONDS) y su propia cadencia de sondeo
# (MEFISTO_HOLD_PROBE_SECONDS), sin tocar ni el watchdog del stage ni el
# presupuesto de reintento de #534.
#
# Casos cubiertos:
#   [pre] las funciones nuevas existen en _mefisto-common.sh
#   [A]   agent_failure_is_holdable: RATE_LIMIT/PROVIDER_UNAVAILABLE
#         califican, el resto no
#   [B]   agent_events_resets_at: lee `resets_at` de la RAIZ del terminal
#         (no de `error`), cadena vacia cuando falta/es null
#   [C]   iso8601_to_epoch: conversion redonda de una fecha conocida
#
# El bucle de espera del pipeline interno lo prueba
# mefisto-tooling-pipeline-agent.test.mts.
#
# Uso: .claude/scripts/tests/test-agent-hold.sh
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
for fn in agent_failure_is_holdable agent_events_resets_at iso8601_to_epoch; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: agent_failure_is_holdable --------

echo ""
echo "[A] agent_failure_is_holdable: solo RATE_LIMIT/PROVIDER_UNAVAILABLE esperan"

for label in "RATE_LIMIT (exit 1)" "PROVIDER_UNAVAILABLE (exit 1)"; do
    if agent_failure_is_holdable "$label"; then
        pass "A-1: '$label' es holdable"
    else
        fail "A-1: '$label' deberia ser holdable"
    fi
done

for label in "TIMEOUT (1800s, exit 137)" "API_ERROR_CLIENT (exit 1)" \
             "STREAM_CUT (exit 1)" "CLI_ERROR (exit 3)" \
             "SIGNAL_MID_FLIGHT (exit 137, 12s)" "SIGNAL_POST_SUCCESS (exit 137, 12s)" ""; do
    if agent_failure_is_holdable "$label"; then
        fail "A-2: '${label:-<vacio>}' NO deberia ser holdable"
    else
        pass "A-2: '${label:-<vacio>}' no espera"
    fi
done

# -------- Bloque B: agent_events_resets_at --------

echo ""
echo "[B] agent_events_resets_at lee la RAIZ del terminal, no error.*"

EVENTS_RATE_LIMIT_WITH_RESET="$TMP/events-rl-reset.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-05-07T22:00:05Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"ventana agotada"},"resets_at":"2026-05-07T22:40:00Z"}' > "$EVENTS_RATE_LIMIT_WITH_RESET"

EVENTS_RATE_LIMIT_NULL_RESET="$TMP/events-rl-noreset.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-09-06T22:00:05Z","status":"failed","runtime":"fake","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"429"},"resets_at":null}' > "$EVENTS_RATE_LIMIT_NULL_RESET"

EVENTS_5XX="$TMP/events-5xx.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"provider_unavailable","detail":"API Error: 529 Overloaded"}}' > "$EVENTS_5XX"

EVENTS_OK="$TMP/events-ok.jsonl"
printf '%s\n' '{"v":1,"type":"run.completed","ts":"2026-08-05T10:00:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}' > "$EVENTS_OK"

got=$(agent_events_resets_at "$EVENTS_RATE_LIMIT_WITH_RESET")
if [ "$got" = "2026-05-07T22:40:00Z" ]; then
    pass "B-1: resets_at poblado se lee tal cual"
else
    fail "B-1: se esperaba '2026-05-07T22:40:00Z', se obtuvo '$got'"
fi

got=$(agent_events_resets_at "$EVENTS_RATE_LIMIT_NULL_RESET")
if [ -z "$got" ]; then
    pass "B-2: resets_at null da cadena vacia"
else
    fail "B-2: se esperaba cadena vacia, se obtuvo '$got'"
fi

got=$(agent_events_resets_at "$EVENTS_5XX")
if [ -z "$got" ]; then
    pass "B-3: terminal sin campo resets_at (PROVIDER_UNAVAILABLE) da cadena vacia"
else
    fail "B-3: se esperaba cadena vacia, se obtuvo '$got'"
fi

FIXTURES_DIR="$REPO_ROOT/src/runtime/contract/fixtures/run-events"

got=$(agent_events_resets_at "$FIXTURES_DIR/valid-rate-limit-claude.jsonl")
if [ "$got" = "2026-05-07T22:40:00Z" ]; then
    pass "B-4: fixture canonico del contrato (claude) -> resets_at poblado"
else
    fail "B-4: se esperaba '2026-05-07T22:40:00Z' del fixture canonico, se obtuvo '$got'"
fi

got=$(agent_events_resets_at "$FIXTURES_DIR/valid-rate-limit-sin-reset.jsonl")
if [ -z "$got" ]; then
    pass "B-5: fixture canonico del contrato (sin reset) -> resets_at null da cadena vacia"
else
    fail "B-5: se esperaba cadena vacia del fixture canonico, se obtuvo '$got'"
fi

# -------- Bloque C: iso8601_to_epoch --------

echo ""
echo "[C] iso8601_to_epoch convierte ida y vuelta"

epoch=$(iso8601_to_epoch "2026-05-07T22:40:00Z" 2>/dev/null)
if [ -n "$epoch" ]; then
    back=$(date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
    if [ "$back" = "2026-05-07T22:40:00Z" ]; then
        pass "C-1: '2026-05-07T22:40:00Z' -> $epoch -> '$back'"
    else
        fail "C-1: la vuelta no coincide (obtuvo '$back')"
    fi
else
    fail "C-1: iso8601_to_epoch no pudo parsear una fecha valida"
fi

if ! iso8601_to_epoch "" >/dev/null 2>&1; then
    pass "C-2: cadena vacia falla (exit != 0)"
else
    fail "C-2: cadena vacia deberia fallar"
fi

# -------- Resumen --------

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
