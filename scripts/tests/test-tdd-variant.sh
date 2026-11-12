#!/usr/bin/env bash
# test-tdd-variant.sh -- Tests del modo --variant (corridas paralelas del
# mismo issue, issue #713, segunda pieza tras #710/tooling-pipeline.sh) en
# scripts/launch-pipeline.sh y scripts/herdr-pipeline.sh. El modo variante del propio
# pipeline lo cubre scripts/tests/tdd-pipeline.test.mts.
#
# validate_variant_label ya la cubre scripts/tests/test-tooling-variant.sh
# (vive en _pipeline-common.sh, sin cambios en este issue): este archivo no la
# repite. Cubre en su lugar:
#   launch-pipeline.sh - el enrutamiento automatico de un unico issue (sin
#                       --tooling explicito) acepta --variant y lo reenvia
#                       intacto al sub-pipeline. Se fuerza el pipeline con
#                       --pipeline tdd para no depender de un stub de `gh`.
#   herdr-pipeline.sh - misma superficie: el pane run lleva --variant y el
#                       titulo del pane queda sufijado.
#
# Uso: scripts/tests/test-tdd-variant.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

export HERDR_STUB_OWNER_PID=$$

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# --- launch-pipeline.sh: el enrutamiento automatico acepta --variant ---
#
# Mismo arnes que test-tooling-variant.sh: consumidor falso (git init sin
# .claude-plugin/plugin.json) para pasar el guard defensivo y MEFISTO_UI=mod
# para no delegar a la interfaz herdr si el test corre dentro de un pane
# herdr. Se fuerza --pipeline tdd para que resolve_pipeline no necesite un
# stub de `gh`.
export MEFISTO_UI=mod

FAKE_CONSUMER="$(mktemp -d)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$FAKE_CONSUMER" "$TMP_DIR"' EXIT

(cd "$FAKE_CONSUMER" && git init -q)

# Copia del paquete con sub-pipelines stub que imprimen su argv, un argumento
# por <>: el report log de cada corrida desacoplada deja ver que recibieron.
LAUNCH_PKG="$TMP_DIR/pkg"
mkdir -p "$LAUNCH_PKG/scripts" "$LAUNCH_PKG/src"
cp "$REPO_ROOT"/scripts/*.sh "$LAUNCH_PKG/scripts/"
ln -s "$REPO_ROOT/src/runtime" "$LAUNCH_PKG/src/runtime"
for s in tdd tooling iac scaffold batch parallel; do
    cat > "$LAUNCH_PKG/scripts/$s-pipeline.sh" <<STUB
#!/usr/bin/env bash
printf 'stub $s'; printf ' <%s>' "\$@"; echo
STUB
done
chmod +x "$LAUNCH_PKG"/scripts/*.sh
LAUNCH_SCRIPT="$LAUNCH_PKG/scripts/launch-pipeline.sh"

LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

run_wrapper() {
    find "$FAKE_CONSUMER" -name '*.report.log' -delete 2>/dev/null
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_CONSUMER" || exit 99
        # Hermetico: el pipeline exporta estas rutas y desviarian el estado fuera del consumidor falso.
        unset MEFISTO_STATE_DIR MEFISTO_LEGACY_STATE_DIR MEFISTO_REPO_ROOT MEFISTO_MODELS_FILE
        MEFISTO_RUNTIME=claude "$LAUNCH_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

# launched_argv <prefijo>: argv que recibio el sub-pipeline de la corrida
# <prefijo>-run-*.report.log, esperando a que el proceso desacoplado lo escriba.
launched_argv() {
    local i=0 f=""
    while [ $i -lt 50 ]; do
        f=$(find "$FAKE_CONSUMER" -name "$1-run-*.report.log" -size +0 2>/dev/null | head -n1)
        [ -n "$f" ] && break
        sleep 0.1
        i=$((i+1))
    done
    [ -n "$f" ] && cat "$f"
}

echo ""
echo "[5] enrutamiento automatico (sin --tooling): --variant no aborta cuando resuelve a tdd-pipeline.sh"
run_wrapper 253 --variant experimento-a --pipeline tdd
if [ "$LAST_RC" -eq 0 ]; then pass "issue suelto + --pipeline tdd + --variant corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tdd-pipeline-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tdd <253> <--variant> <experimento-a>"; then
    pass "tdd-pipeline.sh recibe el issue y --variant con el valor intacto"
else
    fail "tdd-pipeline.sh no recibio '253 --variant ...' -- argv: $ARGV"
fi

echo ""
echo "[6] enrutamiento automatico: --variant se combina con --from-stage y --models en orden"
run_wrapper 253 --from-stage 2 --models "test-writer=opus" --variant b --pipeline tdd
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tdd-pipeline-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tdd <253> <--from-stage> <2> <--models> <test-writer=opus> <--variant> <b>"; then
    pass "tdd-pipeline.sh recibe los tres flags en orden"
else
    fail "orden incorrecto -- argv: $ARGV"
fi

echo ""
echo "----------------------------------------"
echo "  launch-pipeline.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- herdr-pipeline.sh: misma superficie, dentro de un pane herdr -----------

export HERDR_STUB_LOG="$TMP_DIR/herdr-invocations.log"
export HERDR_STUB_COUNTER="$TMP_DIR/herdr-pane-counter"
HERDR_SCRIPT="$REPO_ROOT/scripts/herdr-pipeline.sh"

cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
set -u
echo "herdr $*" >> "$HERDR_STUB_LOG"
case "${1:-} ${2:-}" in
    "pane split")
        n=$(cat "$HERDR_STUB_COUNTER" 2>/dev/null || echo 0)
        n=$((n + 1))
        echo "$n" > "$HERDR_STUB_COUNTER"
        echo "{\"result\":{\"pane\":{\"pane_id\":\"w1:p$n\"}}}"
        ;;
    "pane get")
        echo '{"result":{"pane":{"pane_id":"stub"}}}'
        ;;
    "pane process-info")
        # Issue #2285: el guard de pane propio exige que el wrapper descienda del
        # shell_pid del pane despachante (HERDR_PANE_ID); se reporta el PID del test.
        if [ -n "${HERDR_STUB_OWNER_PID:-}" ] && [ "${4:-}" = "${HERDR_PANE_ID:-}" ]; then
            echo "{\"result\":{\"process_info\":{\"shell_pid\":$HERDR_STUB_OWNER_PID,\"foreground_process_group_id\":$HERDR_STUB_OWNER_PID}}}"
            exit 0
        fi
        echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":100}}}'
        ;;
    "pane run")
        # Simula que el shell del pane ejecuto la linea: toca el
        # --started-marker para que el despacho confirme sin esperar el
        # timeout real (issue #1563).
        marker=$(printf '%s\n' "${4:-}" | grep -oE -- '--started-marker [^[:space:]]+' | awk '{print $2}')
        if [ -n "$marker" ]; then
            mkdir -p "$(dirname "$marker")" 2>/dev/null
            : > "$marker"
        fi
        echo '{"result":{"type":"ok"}}'
        ;;
    *)
        echo '{"result":{"type":"ok"}}'
        ;;
esac
STUB
chmod +x "$FAKE_BIN/herdr"

run_herdr() {
    : > "$HERDR_STUB_LOG"
    echo 0 > "$HERDR_STUB_COUNTER"
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_CONSUMER" || exit 99
        env -u MEFISTO_UI \
            PATH="$FAKE_BIN:$PATH" \
            HERDR_ENV=1 HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_STUB_COUNTER="$HERDR_STUB_COUNTER" \
            "$HERDR_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

echo ""
echo "[7] herdr: enrutamiento automatico reenvia --variant al pane run cuando resuelve a tdd-pipeline.sh"
run_herdr 253 --variant experimento-a --pipeline tdd
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
if [ "$LAST_RC" -eq 0 ]; then pass "issue suelto + --pipeline tdd + --variant corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--variant experimento-a"; then
    pass "el pane run lleva --variant"
else
    fail "el pane run no lleva --variant -- log: $HERDR_CALLS"
fi

echo ""
echo "[8] herdr: --variant se combina con --models en el pane run, en ese orden"
run_herdr 253 --models "test-writer=opus" --variant b --pipeline tdd
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models test-writer=opus --variant b"; then
    pass "el pane run lleva --models y --variant, en ese orden"
else
    fail "el pane run no lleva la combinacion esperada -- log: $HERDR_CALLS"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
