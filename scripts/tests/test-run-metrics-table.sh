#!/usr/bin/env bash
# test-run-metrics-table.sh -- renderer Markdown de metricas por corrida (#1312).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null

echo "[pre] render_run_metrics_table esta definida"
if declare -F render_run_metrics_table >/dev/null; then pass "renderer disponible"; else fail "falta renderer"; fi

WRITER='{"model":"openai/gpt-5.6-terra","tokens":{"input":117000,"output":5700,"cache_read":1300000,"cache_write":22000,"reasoning":3000},"estimated_cost_usd":0.59}'
REVIEWER='{"model":"openai/gpt-5.6-sol","tokens":{"input":76000,"output":4300,"cache_read":1050000,"cache_write":1500,"reasoning":8500},"estimated_cost_usd":0.84}'
EXPECTED='| Etapa | Modelo | Tokens | in/out/cache/reasoning | Tiempo | Costo estimado |
|---|---|---:|---|---:|---:|
| Writer | openai/gpt-5.6-terra | 1.45M | 117k / 5.7k / 1.32M / 3k | 15m 7s | $0.59 |
| Reviewer | openai/gpt-5.6-sol | 1.14M | 76k / 4.3k / 1.05M / 8.5k | 4m 52s | $0.84 |
| **Total** | - | **2.59M** | - | **19m 59s** | **$1.43** |'

echo "[A] Metricas completas con cache y razonamiento"
OUT=$(render_run_metrics_table Writer 907 "$WRITER" Reviewer 292 "$REVIEWER")
if [ "$OUT" = "$EXPECTED" ]; then pass "Markdown completo coincide con el derivado a mano"; else fail "Markdown completo inesperado: $OUT"; fi

echo "[B] metrics:null y estimacion null degradan y conservan total parcial"
NO_COST='{"model":"modelo-sin-costo","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40,"reasoning":50},"estimated_cost_usd":null}'
OUT=$(render_run_metrics_table Writer 60 null Reviewer 30 "$NO_COST")
if printf '%s' "$OUT" | grep -qF '| Writer | - | - | - | 1m 0s | - |' \
   && printf '%s' "$OUT" | grep -qF '| Reviewer | modelo-sin-costo | 150 | 10 / 20 / 70 / 50 | 0m 30s | - |' \
   && printf '%s' "$OUT" | grep -qF '| **Total (parcial)** | - | - | - | **1m 30s** | - |'; then
    pass "ausencias se muestran como '-' y el total es parcial"
else
    fail "degradacion inesperada: $OUT"
fi

echo "[C] estimated_cost_usd:0 es presente y suma solo costos no nulos"
CERO='{"model":"modelo-cero","tokens":{"input":1,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"estimated_cost_usd":0,"cost_usd":99}'
OUT=$(render_run_metrics_table Cero 1 "$CERO" SinCosto 2 "$NO_COST")
if printf '%s' "$OUT" | grep -qF '| Cero | modelo-cero | 15 | 1 / 2 / 7 / 5 | 0m 1s | $0.00 |' \
   && printf '%s' "$OUT" | grep -qF '| **Total (parcial)** | - | **165** | - | **0m 3s** | **$0.00** |'; then
    pass "cero se muestra, el costo legado se ignora y el total parcial excluye null"
else
    fail "costo cero o total parcial inesperado: $OUT"
fi

echo "[D] Un contador ausente degrada su celda y vuelve parcial el total"
INCOMPLETA='{"model":"modelo-incompleto","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40},"estimated_cost_usd":1.25}'
OUT=$(render_run_metrics_table Incompleta 5 "$INCOMPLETA")
if printf '%s' "$OUT" | grep -qF '| Incompleta | modelo-incompleto | - | 10 / 20 / 70 / - | 0m 5s | $1.25 |' \
   && printf '%s' "$OUT" | grep -qF '| **Total (parcial)** | - | - | - | **0m 5s** | **$1.25** |'; then
    pass "contador ausente no se inventa como cero"
else
    fail "contador ausente deberia degradar la fila y el total: $OUT"
fi

echo "[F] jq ausente nunca aborta y degrada la tabla"
NO_JQ=$(mktemp -d)
OUT=$(PATH="$NO_JQ" render_run_metrics_table Writer 60 "$WRITER")
RC=$?
rm -rf "$NO_JQ"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qF '| Writer | - | - | - | 1m 0s | - |' \
   && printf '%s' "$OUT" | grep -qF '| **Total (parcial)** | - | - | - | **1m 0s** | - |'; then
    pass "sin jq degrada sin abortar"
else
    fail "sin jq deberia degradar con exit 0 (rc=$RC): $OUT"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
