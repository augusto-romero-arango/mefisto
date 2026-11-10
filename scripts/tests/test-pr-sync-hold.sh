#!/usr/bin/env bash
# test-pr-sync-hold.sh -- Regresiones de la politica de hold (MEF-ADR-0051)
# adoptada por run_agent() de pr-sync.sh (issue #1586): un fallo RATE_LIMIT*/
# PROVIDER_UNAVAILABLE* ya no retorna fallo de inmediato -- espera con
# agent_hold_wait y reintenta, reanudando con --resume-session cuando el
# terminal trajo session_id y el runtime activo soporta reanudacion.
#
# Mismo patron de extraccion por awk que test-pr-sync-neutral-runner.sh: la
# funcion real se extrae tal cual vive en pr-sync.sh y se ejecuta con un
# runner neutral stub (MEFISTO_RUN_AGENT_BIN), sin invocar ningun runtime
# real. MEFISTO_HOLD_PROBE_SECONDS=1 mantiene el test rapido.
#
#   H-a: rate_limit y luego exito -> run_agent retorna 0, hay 2 invocaciones
#        y la segunda lleva --resume-session <session_id de la primera>.
#   H-b: rate_limit persistente con MEFISTO_HOLD_MAX_SECONDS minimo -> el
#        techo de espera se agota y run_agent retorna != 0.
#   H-c: stream_cut (no holdable) -> run_agent retorna != 0 con una sola
#        invocacion y sin linea "[hold]" en events.log.
#   H-d: runtime sin capacidad de reanudacion -> la segunda invocacion NO
#        lleva --resume-session aunque el terminal trajo session_id.
#   H-e: mismo escenario de H-a, pero con el contexto de PR fijado
#        (CURRENT_PR_STATUS/CURRENT_PR_STAGE, issue #1601) -> durante la
#        espera, pipeline-status-pr-sync-<pr>.json queda en state:"hold" con
#        hold.cause/next_probe poblados; al volver de run_agent, hold.cause
#        es null y accumulated_seconds >= 1.
#
# Uso: scripts/tests/test-pr-sync-hold.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PR_SYNC="$REPO_ROOT/scripts/pr-sync.sh"
COMMON_LIB="$REPO_ROOT/scripts/_pipeline-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
export TMP_DIR

FUNC_SRC=$(awk '
    /^run_agent\(\) \{/ { flag=1 }
    flag && /^# ─── Función: validar tests post-merge/ { exit }
    flag { print }
' "$PR_SYNC")

if [ -z "$FUNC_SRC" ]; then
    fail "no se pudo extraer run_agent() de pr-sync.sh"
    echo ""
    echo "----------------------------------------"
    echo "  Resumen: $PASS pass, $FAIL fail"
    echo "----------------------------------------"
    exit 1
fi
pass "se extrajo run_agent() de pr-sync.sh"

# write_pr_status_file()/fail_pr() (issue #1601): run_agent() las llama para
# el status estructurado durante un ciclo de hold (H-e). Mismo patron de
# extraccion por awk, un bloque contiguo antes de "Parsear argumentos".
STATUS_FUNC_SRC=$(awk '
    /^write_pr_status_file\(\) \{/ { flag=1 }
    flag && /^# ─── Parsear argumentos/ { exit }
    flag { print }
' "$PR_SYNC")
if [ -z "$STATUS_FUNC_SRC" ]; then
    fail "no se pudo extraer write_pr_status_file()/fail_pr() de pr-sync.sh"
else
    pass "se extrajo write_pr_status_file()/fail_pr() de pr-sync.sh"
fi

if grep -q 'classify_neutral_agent_failure' <<< "$FUNC_SRC" \
    && grep -q 'agent_failure_is_holdable' <<< "$FUNC_SRC" \
    && grep -q 'agent_hold_wait' <<< "$FUNC_SRC"; then
    pass "run_agent() consulta la taxonomia y el hold de MEF-ADR-0051"
else
    fail "run_agent() no consulta classify_neutral_agent_failure/agent_failure_is_holdable/agent_hold_wait"
fi

# make_stub_runner <bin_dir> <behaviors_file>
#
# El stub lleva la cuenta de invocaciones en un archivo propio del caso
# ($CASE_NAME, exportado por run_case) y, para cada invocacion N, lee la
# linea N de <behaviors_file> ("<exit_code> <kind>") para decidir el exit
# code y el terminal que deja en --event-log. Registra el argv completo de
# cada invocacion en un archivo por-intento para que los tests inspeccionen
# --resume-session.
make_stub_runner() {
    local bin_dir="$1" behaviors_file="$2"
    mkdir -p "$bin_dir"
    cat > "$bin_dir/mefisto-run-agent-stub.sh" <<STUB
#!/usr/bin/env bash
count_file="$TMP_DIR/\${CASE_NAME}-count.txt"
n=0
[ -f "\$count_file" ] && n=\$(cat "\$count_file")
n=\$((n + 1))
echo "\$n" > "\$count_file"

printf '%s\n' "\$@" > "$TMP_DIR/\${CASE_NAME}-args-\${n}.txt"

line=\$(sed -n "\${n}p" "$behaviors_file")
exit_code=\$(echo "\$line" | cut -d' ' -f1)
kind=\$(echo "\$line" | cut -d' ' -f2)

prev="" event_log=""
for a in "\$@"; do
    if [ "\$prev" = "--event-log" ]; then event_log="\$a"; fi
    prev="\$a"
done

if [ -n "\$event_log" ]; then
    mkdir -p "\$(dirname "\$event_log")"
    case "\$kind" in
        success)    printf '{"type":"run.completed","status":"success"}\n' > "\$event_log" ;;
        rate_limit) printf '{"type":"run.failed","status":"failure","session_id":"sess-%s","error":{"kind":"rate_limit"}}\n' "\$n" > "\$event_log" ;;
        stream_cut) printf '{"type":"run.failed","status":"failure","error":{"kind":"stream_cut"}}\n' > "\$event_log" ;;
        *)          : > "\$event_log" ;;
    esac
fi
exit "\${exit_code:-1}"
STUB
    chmod +x "$bin_dir/mefisto-run-agent-stub.sh"
}

# run_case <case_name> <behaviors_lines...> -- prepara y corre run_agent()
# con el stub y el harness minimo que pr-sync.sh ya usa en run_agent().
# Variables extra (runtime lib dir, hold ceiling) via env antes de llamar.
run_case() {
    local case_name="$1"; shift
    local case_file="$TMP_DIR/$case_name.sh"
    local bin_dir="$TMP_DIR/$case_name-bin"
    local behaviors_file="$TMP_DIR/$case_name-behaviors.txt"
    local fake_worktree="$TMP_DIR/$case_name-worktree"
    mkdir -p "$fake_worktree"
    printf '%s\n' "$@" > "$behaviors_file"
    make_stub_runner "$bin_dir" "$behaviors_file"
    : > "$TMP_DIR/log.txt"
    : > "$TMP_DIR/warn.txt"
    : > "$TMP_DIR/events.log"
    export CASE_NAME="$case_name"

    {
        printf '%s\n' 'set -uo pipefail'
        printf '%s\n' "source \"$COMMON_LIB\""
        printf '%s\n' "$FUNC_SRC"
        cat <<HARNESS
LOG_DIR_ABS="$TMP_DIR"
TIMESTAMP="ts"
RUN_AGENT_BIN="$bin_dir/mefisto-run-agent-stub.sh"
MEFISTO_RUNTIME_RESUELTO="${STUB_RUNTIME:-fake-runtime}"
MEFISTO_RUNTIME_LIB_DIR="${STUB_RUNTIME_LIB_DIR:-$TMP_DIR/no-such-dir}"
MEFISTO_HOLD_PROBE_SECONDS="${MEFISTO_HOLD_PROBE_SECONDS:-1}"
MEFISTO_HOLD_MAX_SECONDS="${STUB_HOLD_MAX_SECONDS:-21600}"
IMPLEMENTER_MODEL=""; IMPLEMENTER_EFFORT=""
LOG_FILE_ABS="$TMP_DIR/log.txt"
EVENTS_LOG_ABS="$TMP_DIR/events.log"
RED='' NC=''
log() { printf '%s\n' "\$1" >> "$TMP_DIR/log.txt"; }
warn() { printf '%s\n' "\$1" >> "$TMP_DIR/warn.txt"; }
set +e
run_agent "$case_name" "implementer" "prompt de prueba" "$fake_worktree"
rc=\$?
set -e
printf 'RESULT=%s\n' "\$rc"
HARNESS
    } > "$case_file"
    OUTPUT=$(/bin/bash "$case_file" 2>&1)
    RC=$?
    WORKTREE_PATH="$fake_worktree"
    N_INVOCATIONS=0
    [ -f "$TMP_DIR/${case_name}-count.txt" ] && N_INVOCATIONS=$(cat "$TMP_DIR/${case_name}-count.txt")
}

echo "[H-a] rate_limit y luego exito: hold + resume-session"
STUB_RUNTIME="resumable-rt"
STUB_RUNTIME_LIB_DIR="$TMP_DIR/runtime-lib"
mkdir -p "$STUB_RUNTIME_LIB_DIR"
cat > "$STUB_RUNTIME_LIB_DIR/runtime-resumable-rt.sh" <<'EOF'
runtime_resumable-rt_supports_resume() { return 0; }
EOF
run_case ha "1 rate_limit" "0 success"
if [ "$RC" -eq 0 ] && echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "H-a: run_agent retorna 0 tras el hold"
else
    fail "H-a: se esperaba RESULT=0. Salida: $OUTPUT"
fi
if [ "$N_INVOCATIONS" -eq 2 ]; then
    pass "H-a: hubo exactamente 2 invocaciones (rate_limit + reintento exitoso)"
else
    fail "H-a: se esperaban 2 invocaciones, hubo $N_INVOCATIONS"
fi
if [ -f "$TMP_DIR/ha-args-2.txt" ] \
    && grep -qx -- '--resume-session' "$TMP_DIR/ha-args-2.txt" \
    && grep -qx 'sess-1' "$TMP_DIR/ha-args-2.txt"; then
    pass "H-a: la segunda invocacion lleva --resume-session sess-1 (session_id de la primera)"
else
    fail "H-a: la segunda invocacion no lleva --resume-session con el session_id esperado"
fi
if grep -q '\[hold\] RATE_LIMIT: esperando' "$TMP_DIR/events.log"; then
    pass "H-a: events.log deja la linea [hold] RATE_LIMIT (CA-4, leida por work-status-collect.sh)"
else
    fail "H-a: no se encontro la linea [hold] en events.log"
fi
unset STUB_RUNTIME STUB_RUNTIME_LIB_DIR

echo ""
echo "[H-e] hold escribe pipeline-status-pr-sync-<pr>.json (issue #1601, CA-3)"
HE_BIN_DIR="$TMP_DIR/he-bin"
HE_STATE_DIR="$TMP_DIR/he-state"
HE_WORKTREE="$TMP_DIR/he-worktree"
HE_BEHAVIORS="$TMP_DIR/he-behaviors.txt"
mkdir -p "$HE_WORKTREE" "$HE_STATE_DIR"
printf '%s\n' "1 rate_limit" "0 success" > "$HE_BEHAVIORS"
export CASE_NAME="he"
make_stub_runner "$HE_BIN_DIR" "$HE_BEHAVIORS"
# El stub de sleep captura el status EN EL INSTANTE de la espera (antes de que
# run_agent() lo devuelva a "running"), sin dormir de verdad -- el test mide
# el contenido del archivo, no el reloj.
cat > "$HE_BIN_DIR/sleep" <<SLEEPSTUB
#!/usr/bin/env bash
cp "$HE_STATE_DIR/pipeline-status-pr-sync-777.json" "$TMP_DIR/he-hold-snapshot.json" 2>/dev/null || true
exit 0
SLEEPSTUB
chmod +x "$HE_BIN_DIR/sleep"
rm -f "$TMP_DIR/he-hold-snapshot.json"
: > "$TMP_DIR/log.txt"
: > "$TMP_DIR/warn.txt"
: > "$TMP_DIR/events.log"
{
    printf '%s\n' 'set -uo pipefail'
    printf '%s\n' "source \"$COMMON_LIB\""
    printf '%s\n' "$STATUS_FUNC_SRC"
    printf '%s\n' "$FUNC_SRC"
    cat <<HARNESS
LOG_DIR_ABS="$TMP_DIR"
TIMESTAMP="ts"
RUN_AGENT_BIN="$HE_BIN_DIR/mefisto-run-agent-stub.sh"
MEFISTO_RUNTIME_RESUELTO="resumable-rt"
MEFISTO_RUNTIME_LIB_DIR="$TMP_DIR/runtime-lib"
MEFISTO_HOLD_PROBE_SECONDS=1
MEFISTO_HOLD_MAX_SECONDS=21600
IMPLEMENTER_MODEL=""; IMPLEMENTER_EFFORT=""
LOG_FILE_ABS="$TMP_DIR/log.txt"
EVENTS_LOG_ABS="$TMP_DIR/events.log"
MEFISTO_STATE_DIR="$HE_STATE_DIR"
CURRENT_PR_STATUS="777"
CURRENT_PR_STAGE="merge-pr777"
CURRENT_PR_TITLE="Titulo de prueba"
RED='' NC=''
log() { printf '%s\n' "\$1" >> "$TMP_DIR/log.txt"; }
warn() { printf '%s\n' "\$1" >> "$TMP_DIR/warn.txt"; }
set +e
run_agent "he" "implementer" "prompt de prueba" "$HE_WORKTREE"
rc=\$?
set -e
printf 'RESULT=%s\n' "\$rc"
HARNESS
} > "$TMP_DIR/he.sh"
HE_OUTPUT=$(PATH="$HE_BIN_DIR:$PATH" /bin/bash "$TMP_DIR/he.sh" 2>&1)
HE_RC=$?

if [ "$HE_RC" -eq 0 ] && echo "$HE_OUTPUT" | grep -q 'RESULT=0'; then
    pass "H-e: run_agent retorna 0 tras el hold (con contexto de PR fijado)"
else
    fail "H-e: se esperaba RESULT=0. Salida: $HE_OUTPUT"
fi
if [ -f "$TMP_DIR/he-hold-snapshot.json" ] \
    && [ "$(jq -r '.state' "$TMP_DIR/he-hold-snapshot.json" 2>/dev/null)" = "hold" ] \
    && jq -e '.hold.cause | startswith("RATE_LIMIT")' "$TMP_DIR/he-hold-snapshot.json" >/dev/null 2>&1 \
    && [ "$(jq -r '.hold.next_probe' "$TMP_DIR/he-hold-snapshot.json" 2>/dev/null)" != "null" ]; then
    pass "H-e: durante la espera, el status queda en hold con cause RATE_LIMIT... y next_probe no nulo"
else
    fail "H-e: snapshot de hold invalido o ausente: $(cat "$TMP_DIR/he-hold-snapshot.json" 2>/dev/null || echo '<no existe>')"
fi
HE_FINAL="$HE_STATE_DIR/pipeline-status-pr-sync-777.json"
if [ -f "$HE_FINAL" ] \
    && [ "$(jq -r '.hold.cause' "$HE_FINAL" 2>/dev/null)" = "null" ] \
    && [ "$(jq -r '.hold.accumulated_seconds' "$HE_FINAL" 2>/dev/null)" -ge 1 ] 2>/dev/null; then
    pass "H-e: al volver de run_agent, hold.cause es null y accumulated_seconds >= 1"
else
    fail "H-e: status final invalido: $(cat "$HE_FINAL" 2>/dev/null || echo '<no existe>')"
fi
unset CASE_NAME

echo ""
echo "[H-b] rate_limit persistente con techo minimo: se agota la espera"
STUB_HOLD_MAX_SECONDS=1
run_case hb "1 rate_limit" "1 rate_limit" "1 rate_limit"
if [ "$RC" -eq 0 ] && ! echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "H-b: run_agent retorna != 0 al agotarse MEFISTO_HOLD_MAX_SECONDS"
else
    fail "H-b: se esperaba RESULT != 0. Salida: $OUTPUT"
fi
unset STUB_HOLD_MAX_SECONDS

echo ""
echo "[H-c] stream_cut: no holdable, una sola invocacion, sin linea [hold]"
run_case hc "1 stream_cut"
if [ "$RC" -eq 0 ] && ! echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "H-c: run_agent retorna != 0"
else
    fail "H-c: se esperaba RESULT != 0. Salida: $OUTPUT"
fi
if [ "$N_INVOCATIONS" -eq 1 ]; then
    pass "H-c: una sola invocacion (STREAM_CUT no es holdable)"
else
    fail "H-c: se esperaba 1 invocacion, hubo $N_INVOCATIONS"
fi
if [ ! -s "$TMP_DIR/events.log" ] || ! grep -q '\[hold\]' "$TMP_DIR/events.log"; then
    pass "H-c: events.log no tiene ninguna linea [hold]"
else
    fail "H-c: events.log tiene una linea [hold] para un fallo no holdable"
fi

echo ""
echo "[H-d] runtime sin capacidad de reanudacion: la segunda invocacion no lleva --resume-session"
STUB_RUNTIME="no-resume-rt"
run_case hd "1 rate_limit" "0 success"
if [ "$RC" -eq 0 ] && echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "H-d: run_agent retorna 0 igual (degrada, no rompe)"
else
    fail "H-d: se esperaba RESULT=0. Salida: $OUTPUT"
fi
if [ -f "$TMP_DIR/hd-args-2.txt" ] && ! grep -qx -- '--resume-session' "$TMP_DIR/hd-args-2.txt"; then
    pass "H-d: la segunda invocacion NO lleva --resume-session (runtime sin soporte)"
else
    fail "H-d: la segunda invocacion no deberia llevar --resume-session"
fi
unset STUB_RUNTIME

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
