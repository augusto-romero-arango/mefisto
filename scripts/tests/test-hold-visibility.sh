#!/usr/bin/env bash
# test-hold-visibility.sh -- Tests de la visibilidad y la contabilidad de la
# espera (hold) en los orquestadores publicados con cola (issue #973,
# contraparte publicada de #969, consumidora de la politica de espera del
# issue #971).
#
# Contexto: agent_hold_wait (issue #971, _pipeline-common.sh) ya deja
# constancia de una espera activa en events.log, pero solo el pipeline que la
# sufre (tdd/tooling/iac-pipeline.sh) la ve -- esta bloqueado en su propio
# sleep. De ahi las dos necesidades que cubren las funciones bajo test:
#   - parallel-pipeline necesita saber, SIN bloquearse, si hay una espera
#     activa: para no lanzar mas issues de la cola (CA-3) y para reflejarlo en
#     su dashboard (CA-2).
#   - batch-pipeline esta bloqueado en el eslabon mientras este espera, asi
#     que solo puede anotar cuanto se espero AL CERRARLO -- como nota anexa al
#     desenlace real, nunca como fallo (CA-1/CA-5).
# El cableado de los dos orquestadores se prueba en
# scripts/tests/batch-pipeline.test.mts y scripts/tests/parallel-pipeline.test.mts.
#
# Casos cubiertos:
#   [1] hold_recently_active: sin events.log -> falso.
#   [2] hold_recently_active: events.log vacio -> falso.
#   [3] hold_recently_active: "proxima sonda" en el FUTURO -> espera activa.
#   [4] hold_recently_active: "proxima sonda" en el PASADO -> falso (se
#       resolvio, o se agoto el techo).
#   [5] hold_recently_active: solo lineas "[hold][resume]" -> falso (no son
#       el anuncio de la espera).
#   [6] hold_recently_active: con varias lineas de hold, usa la ULTIMA.
#   [7] hold_recently_active: linea de OTRO dia (hora de anuncio en el
#       futuro) -> falso, aunque su "proxima sonda" caiga mas adelante en el
#       reloj de hoy. Sin esto el scheduler se negaria a lanzar la cola por
#       una espera inexistente.
#   [8] hold_recently_active: la marca <from_line> descarta lo escrito antes
#       de que arrancara el consumidor.
#   [9] hold_line_window: un ciclo que cruza medianoche da duracion positiva.
#   [10] format_hold_status: con espera activa imprime causa + sonda + techo
#        sin el timestamp; sin espera activa no imprime nada y retorna 1.
#   [11] fmt_hold_duration / hold_note_suffix: formato y neutralidad (0
#        segundos -> sin nota, y retorna 0 para no matar un `set -e`).
#   [12] hold_seconds_in_range: suma los ciclos del rango, ignora
#        "[hold][resume]", respeta <from_line> y atribuye por cabecera de
#        sesion (una corrida concurrente de otro issue no le regala su espera
#        al eslabon en curso).
#
# Uso: scripts/tests/test-hold-visibility.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/_pipeline-common.sh"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# hms_at <delta_segundos> -- HH:MM:SS de "ahora + delta" (mismo patron que
# agent_hold_wait para formatear un epoch: date -r (BSD/macOS) con fallback a
# date -d (GNU)). Usado para construir lineas [hold] relativas al reloj real,
# sin acoplar el test a una hora fija.
hms_at() {
    local delta="$1"
    local epoch=$(( $(date +%s) + delta ))
    date -r "$epoch" +%H:%M:%S 2>/dev/null || date -d "@$epoch" +%H:%M:%S 2>/dev/null
}

echo "[1] hold_recently_active: sin events.log -> falso"
if hold_recently_active "$TMP/no-existe.log"; then
    fail "deberia ser falso sin events.log"
else
    pass "sin events.log -> falso"
fi

echo ""
echo "[2] hold_recently_active: events.log vacio -> falso"
EMPTY_LOG="$TMP/empty-events.log"
: > "$EMPTY_LOG"
if hold_recently_active "$EMPTY_LOG"; then
    fail "deberia ser falso con events.log vacio"
else
    pass "events.log vacio -> falso"
fi

echo ""
echo "[3] hold_recently_active: proxima sonda en el FUTURO -> espera activa"
FUTURE_LOG="$TMP/future.log"
FUTURE_HMS=$(hms_at 120)
cat > "$FUTURE_LOG" <<EOF
=== SESSION TOOLING 20260101-000000 issue:42 from-stage:1 ===
[$(hms_at -180)][hold] RATE_LIMIT: esperando, proxima sonda $FUTURE_HMS (techo 23:59)
EOF
if hold_recently_active "$FUTURE_LOG"; then
    pass "proxima sonda en el futuro -> espera activa"
else
    fail "deberia detectar espera activa con proxima sonda en el futuro"
fi

echo ""
echo "[4] hold_recently_active: proxima sonda en el PASADO -> ya no esta activa"
PAST_LOG="$TMP/past.log"
cat > "$PAST_LOG" <<EOF
[$(hms_at -420)][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda $(hms_at -120) (techo 23:59)
EOF
if hold_recently_active "$PAST_LOG"; then
    fail "no deberia estar activa con proxima sonda ya pasada"
else
    pass "proxima sonda en el pasado -> no activa (resuelta o techo agotado)"
fi

echo ""
echo "[5] hold_recently_active: solo lineas [hold][resume] -> no cuentan como anuncio"
RESUME_ONLY_LOG="$TMP/resume-only.log"
cat > "$RESUME_ONLY_LOG" <<EOF
[$(hms_at -60)][hold][resume] writer: el intento fallido no dejo transcript en el worktree -- reintento desde cero (sin -c)
EOF
if hold_recently_active "$RESUME_ONLY_LOG"; then
    fail "una linea [hold][resume] sola no deberia contar como espera activa"
else
    pass "solo [hold][resume] -> no activa (no es el anuncio de agent_hold_wait)"
fi

echo ""
echo "[6] hold_recently_active: con varias lineas, usa la ULTIMA"
MULTI_LOG="$TMP/multi.log"
cat > "$MULTI_LOG" <<EOF
[$(hms_at -900)][hold] RATE_LIMIT: esperando, proxima sonda $(hms_at -600) (techo 23:59)
[$(hms_at -180)][hold] RATE_LIMIT: esperando, proxima sonda $FUTURE_HMS (techo 23:59)
EOF
if hold_recently_active "$MULTI_LOG"; then
    pass "usa la ultima linea (proxima sonda en el futuro), no la primera (ya pasada)"
else
    fail "deberia usar la ultima linea de hold, que sigue activa"
fi

echo ""
echo "[7] hold_recently_active: linea de otro dia (anuncio en el futuro) -> no activa"
STALE_LOG="$TMP/stale-yesterday.log"
cat > "$STALE_LOG" <<EOF
[$(hms_at 7200)][hold] RATE_LIMIT: esperando, proxima sonda $(hms_at 7500) (techo 23:59)
EOF
if hold_recently_active "$STALE_LOG"; then
    fail "una linea cuyo anuncio esta en el futuro es de otro dia: no deberia estar activa"
else
    pass "anuncio en el futuro -> linea de otro dia, no activa"
fi

echo ""
echo "[8] hold_recently_active: <from_line> descarta lo anterior al arranque del consumidor"
BOUNDED_LOG="$TMP/bounded.log"
cat > "$BOUNDED_LOG" <<EOF
=== SESSION TOOLING 20260101-000000 issue:41 from-stage:1 ===
[$(hms_at -180)][hold] RATE_LIMIT: esperando, proxima sonda $FUTURE_HMS (techo 23:59)
EOF
if hold_recently_active "$BOUNDED_LOG" 0; then
    pass "sin acotar (from_line=0) ve la espera activa"
else
    fail "sin acotar deberia ver la espera activa"
fi
if hold_recently_active "$BOUNDED_LOG" 2; then
    fail "acotado por encima de la linea de hold no deberia ver ninguna espera"
else
    pass "from_line descarta el hold escrito antes del arranque"
fi

echo ""
echo "[9] hold_line_window: un ciclo que cruza medianoche da duracion positiva"
WINDOW=$(hold_line_window "[23:58:00][hold] RATE_LIMIT: esperando, proxima sonda 00:03:00 (techo 05:00)")
if [ -n "$WINDOW" ] && [ "$(( ${WINDOW##* } - ${WINDOW%% *} ))" -eq 300 ]; then
    pass "23:58:00 -> 00:03:00 = 300s (rollover de medianoche resuelto)"
else
    fail "hold_line_window devolvio '$WINDOW' (esperaba una ventana de 300s)"
fi

echo ""
echo "[10] format_hold_status: causa + proxima sonda + techo, sin el timestamp"
OUT=$(format_hold_status "$FUTURE_LOG")
case "$OUT" in
    "RATE_LIMIT: esperando, proxima sonda $FUTURE_HMS (techo 23:59)")
        pass "format_hold_status: linea formateada como se esperaba" ;;
    *)  fail "format_hold_status devolvio '$OUT'" ;;
esac
case "$OUT" in
    "["*) fail "format_hold_status no deberia dejar el timestamp/corchete inicial" ;;
    *)    pass "sin timestamp ni corchete inicial" ;;
esac
OUT=""
if OUT=$(format_hold_status "$PAST_LOG"); then
    fail "deberia retornar 1 sin espera activa"
else
    pass "retorna 1 sin espera activa"
fi
if [ -z "$OUT" ]; then
    pass "sin salida cuando no hay espera activa"
else
    fail "no deberia imprimir nada, imprimio '$OUT'"
fi

echo ""
echo "[11] fmt_hold_duration / hold_note_suffix"
if [ "$(fmt_hold_duration 130)" = "2m 10s" ]; then
    pass "fmt_hold_duration 130 -> '2m 10s'"
else
    fail "fmt_hold_duration 130 -> '$(fmt_hold_duration 130)'"
fi
if [ "$(hold_note_suffix 130)" = " (incluye 2m 10s en espera/hold)" ]; then
    pass "hold_note_suffix 130 -> nota anexa con el mismo vocabulario del eslabon"
else
    fail "hold_note_suffix 130 -> '$(hold_note_suffix 130)'"
fi
NOTE="pendiente"
if NOTE=$(hold_note_suffix 0); then
    pass "hold_note_suffix 0 retorna 0 (no mata un caller con set -e)"
else
    fail "hold_note_suffix 0 deberia retornar 0"
fi
if [ -z "$NOTE" ]; then
    pass "hold_note_suffix 0 -> sin nota"
else
    fail "hold_note_suffix 0 no deberia anotar nada, anoto '$NOTE'"
fi

echo ""
echo "[12] hold_seconds_in_range: suma, acota y atribuye por sesion"
RANGE_LOG="$TMP/range.log"
cat > "$RANGE_LOG" <<'EOF'
=== SESSION TOOLING 20260101-080000 issue:41 from-stage:1 ===
[08:00:00][hold] RATE_LIMIT: esperando, proxima sonda 08:05:00 (techo 14:00)
=== SESSION TOOLING 20260101-090000 issue:42 from-stage:1 ===
[09:00:00][hold] RATE_LIMIT: esperando, proxima sonda 09:05:00 (techo 15:00)
[09:05:10][hold][resume] writer: sesion reanudada murio de nuevo sin resumen -- degradado a stage desde cero
=== SESSION IAC 20260101-091000 issue:43 env:dev from-stage:1 ===
[09:10:00][hold] PROVIDER_UNAVAILABLE: esperando, proxima sonda 09:20:00 (techo 15:10)
─── SESSION 20260101-093000 issue:file from-stage:1 ───
[09:30:00][hold] RATE_LIMIT: esperando, proxima sonda 09:35:00 (techo 15:30)
EOF
TOTAL_ALL=$(hold_seconds_in_range "$RANGE_LOG" 0)
if [ "$TOTAL_ALL" = "1500" ]; then
    pass "sin issue: suma los cuatro ciclos (300+300+600+300=1500s), ignorando [hold][resume]"
else
    fail "sin issue devolvio '$TOTAL_ALL' (esperaba 1500)"
fi
TOTAL_42=$(hold_seconds_in_range "$RANGE_LOG" 0 42)
if [ "$TOTAL_42" = "300" ]; then
    pass "issue 42: solo su ciclo (300s) -- la espera de otra sesion no se le atribuye"
else
    fail "issue 42 devolvio '$TOTAL_42' (esperaba 300)"
fi
TOTAL_43=$(hold_seconds_in_range "$RANGE_LOG" 0 43)
if [ "$TOTAL_43" = "600" ]; then
    pass "issue 43: cabecera IAC reconocida (600s)"
else
    fail "issue 43 devolvio '$TOTAL_43' (esperaba 600)"
fi
TOTAL_BOUNDED=$(hold_seconds_in_range "$RANGE_LOG" 2 41)
if [ "$TOTAL_BOUNDED" = "0" ]; then
    pass "from_line descarta el ciclo del issue 41 escrito antes de la marca"
else
    fail "acotado devolvio '$TOTAL_BOUNDED' (esperaba 0)"
fi
TOTAL_MISSING=$(hold_seconds_in_range "$TMP/no-existe.log" 0 42)
if [ "$TOTAL_MISSING" = "0" ]; then
    pass "sin events.log -> 0, sin abortar"
else
    fail "sin events.log devolvio '$TOTAL_MISSING'"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
