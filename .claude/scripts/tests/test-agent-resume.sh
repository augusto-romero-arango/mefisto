#!/usr/bin/env bash
# test-agent-resume.sh -- Tests de la reanudacion de sesion tras un hold
# (issue #968).
#
# Contexto: el hold de #967 ya evitaba abortar ante RATE_LIMIT/
# PROVIDER_UNAVAILABLE persistente, pero el intento siguiente repetia el
# stage COMPLETO desde el prompt original -- tirando a la basura todo lo que
# el agente ya habia razonado y escrito en la sesion truncada. Este issue
# hace que, tras esperar, el proximo intento REANUDE esa misma sesion (via
# --resume-session, CA-1/CA-2) en vez de arrancar una nueva, salvo en tres
# casos exactos que degradan a "stage desde cero" con un aviso explicito
# (CA-4): sin session_id en el terminal muerto, runtime sin soporte de
# reanudacion, o la sesion reanudada vuelve a morir sin dejar el resumen del
# stage (ese ultimo caso degrada de forma PERMANENTE para el resto de la
# corrida, sin usar --fork para bifurcar a un id nuevo).
#
# Casos cubiertos:
#   [pre] las funciones nuevas estan definidas
#   [A]   agent_events_session_id: lee `session_id` del terminal, cadena
#         vacia cuando falta/es null
#
# La reanudacion en el bucle del pipeline interno la prueba
# mefisto-tooling-pipeline-agent.test.mts.
#
# Uso: .claude/scripts/tests/test-agent-resume.sh
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

echo "[pre] Las funciones nuevas estan definidas"
for fn in agent_events_session_id; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida (_mefisto-common.sh)"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: agent_events_session_id --------

echo ""
echo "[A] agent_events_session_id lee session_id del terminal"

EVENTS_WITH_SESSION="$TMP/events-with-session.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-09-06T22:00:05Z","status":"failed","runtime":"claude","model":null,"session_id":"sess-abc","duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"ventana agotada"},"resets_at":null}' > "$EVENTS_WITH_SESSION"

EVENTS_NULL_SESSION="$TMP/events-null-session.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-09-06T22:00:05Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"429"},"resets_at":null}' > "$EVENTS_NULL_SESSION"

got=$(agent_events_session_id "$EVENTS_WITH_SESSION")
if [ "$got" = "sess-abc" ]; then
    pass "A-1: session_id poblado se lee tal cual"
else
    fail "A-1: se esperaba 'sess-abc', se obtuvo '$got'"
fi

got=$(agent_events_session_id "$EVENTS_NULL_SESSION")
if [ -z "$got" ]; then
    pass "A-2: session_id null da cadena vacia"
else
    fail "A-2: se esperaba cadena vacia, se obtuvo '$got'"
fi

got=$(agent_events_session_id "$TMP/no-existe.jsonl")
if [ -z "$got" ]; then
    pass "A-3: archivo inexistente da cadena vacia (nunca aborta)"
else
    fail "A-3: se esperaba cadena vacia, se obtuvo '$got'"
fi

# -------- Resumen --------

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
