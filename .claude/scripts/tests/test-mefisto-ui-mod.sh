#!/usr/bin/env bash
# test-mefisto-ui-mod.sh -- Modo desacoplado y decision de modo de
# mefisto-launch-pipeline.sh (MEF-ADR-0055, MEF-ADR-0057 decision 5): --tooling
# y --batch corren desacoplados, sin pane herdr, para que los siga el mod
# mefisto-divine-wager de la sesion que los lanzo.
#
# Cubre:
#   [1] --tooling con MEFISTO_UI=mod no toca herdr, aun dentro de herdr.
#   [2] el pipeline recibe el issue y los flags en orden, y escribe su reporte
#       en .mefisto/pipeline/logs/mefisto-tooling-run-*-issue-<n>.report.log.
#   [3] el pipeline corre sin HERDR_* ni MEFISTO_UI y con MEFISTO_RUNTIME.
#   [4] --batch con MEFISTO_UI=mod corre el batch desacoplado, sin herdr,
#       con los issues en orden y su reporte mefisto-batch-run-*.report.log.
#   [5] --batch con MEFISTO_UI=mod rechaza un issue no numerico.
#   [6] un MEFISTO_UI distinto de mod|herdr aborta nombrando los dos modos,
#       sin lanzar nada; --help no depende del modo.
#   [7] sin MEFISTO_UI, con un runtime sin cinta y fuera de herdr, corre
#       desacoplado y anuncia el reporte y la linea del visor.
#   [8] --attach e --if-exists abortan con un error explicito.
#
# Uso: .claude/scripts/tests/test-mefisto-ui-mod.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAKE_MEFISTO="$TMP_DIR/fake-mefisto"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_MEFISTO/.claude-plugin" "$FAKE_MEFISTO/.claude/scripts" "$FAKE_MEFISTO/src/internal/scripts/lib" "$FAKE_BIN"

printf '{ "name": "mefisto", "version": "0.0.0" }\n' > "$FAKE_MEFISTO/.claude-plugin/plugin.json"
printf '.mefisto/\n' > "$FAKE_MEFISTO/.gitignore"
cp "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/"
cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/"
cp "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" "$FAKE_MEFISTO/.claude/scripts/"
cp -R "$REPO_ROOT/src/runtime" "$FAKE_MEFISTO/src/runtime"
cp "$REPO_ROOT/.claude/scripts/mefisto-launch-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/"
cp "$REPO_ROOT/src/internal/scripts/mefisto-launch-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/"
cp "$REPO_ROOT/.claude/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/"
cp "$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/"

export PIPELINE_STUB_LOG="$TMP_DIR/pipeline.log"
cat > "$FAKE_MEFISTO/src/internal/scripts/mefisto-tooling-pipeline.sh" <<'STUB'
#!/usr/bin/env bash
{
    echo "args: $*"
    echo "herdr: ${HERDR_ENV:-}${HERDR_PANE_ID:-}"
    echo "ui: ${MEFISTO_UI:-}"
    echo "runtime: ${MEFISTO_RUNTIME:-}"
} > "$PIPELINE_STUB_LOG"
echo "salida del pipeline"
STUB
chmod +x "$FAKE_MEFISTO/src/internal/scripts/mefisto-tooling-pipeline.sh"
export BATCH_STUB_LOG="$TMP_DIR/batch.log"
cat > "$FAKE_MEFISTO/src/internal/scripts/mefisto-batch-pipeline.sh" <<'STUB'
#!/usr/bin/env bash
{
    echo "args: $*"
    echo "herdr: ${HERDR_ENV:-}${HERDR_PANE_ID:-}"
    echo "ui: ${MEFISTO_UI:-}"
} > "$BATCH_STUB_LOG"
echo "salida del batch"
STUB
chmod +x "$FAKE_MEFISTO/src/internal/scripts/mefisto-batch-pipeline.sh"
(cd "$FAKE_MEFISTO" && git init -q && git add . && git -c user.email="t@e.com" -c user.name="T" commit -q -m init && git branch -M main)

export UI_STUB_LOG="$TMP_DIR/ui.log"
cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
echo "herdr $*" >> "$UI_STUB_LOG"
exit 0
STUB
chmod +x "$FAKE_BIN/herdr"

wait_for_file() {
    local f="$1" i
    for i in $(seq 1 50); do
        [ -s "$f" ] && return 0
        sleep 0.1
    done
    return 1
}

# run_wrapper_env <asignaciones de entorno...> -- <args del lanzador...>
run_wrapper_env() {
    local assigns=()
    while [ "$1" != "--" ]; do assigns+=("$1"); shift; done
    shift
    : > "$UI_STUB_LOG"
    rm -f "$PIPELINE_STUB_LOG" "$BATCH_STUB_LOG"
    (
        cd "$FAKE_MEFISTO" || exit 99
        env -u MEFISTO_UI -u MEFISTO_RUNTIME -u HERDR_ENV -u HERDR_PANE_ID \
            PATH="$FAKE_BIN:$PATH" "${assigns[@]}" \
            "$FAKE_MEFISTO/.claude/scripts/mefisto-launch-pipeline.sh" "$@"
    ) </dev/null >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
    LAST_RC=$?
}

run_wrapper() {
    run_wrapper_env MEFISTO_UI=mod MEFISTO_RUNTIME=claude HERDR_ENV=1 HERDR_PANE_ID=w1:p1 -- "$@"
}

echo "[1] --tooling con MEFISTO_UI=mod no abre pane herdr"
run_wrapper --tooling 42 --from-stage 2 --models "reviewer=opus"
if [ "$LAST_RC" -eq 0 ]; then pass "el wrapper termina sin error"; else fail "rc=$LAST_RC stderr: $(cat "$TMP_DIR/stderr")"; fi
if wait_for_file "$PIPELINE_STUB_LOG"; then pass "el pipeline corrio desacoplado"; else fail "el pipeline no corrio"; fi
if [ ! -s "$UI_STUB_LOG" ]; then pass "herdr no fue invocado"; else fail "se invoco UI: $(cat "$UI_STUB_LOG")"; fi

echo ""
echo "[2] el pipeline recibe issue y flags, y su salida va al reporte"
if grep -qF "args: 42 --from-stage 2 --models reviewer=opus" "$PIPELINE_STUB_LOG"; then pass "issue y flags en orden"; else fail "args: $(cat "$PIPELINE_STUB_LOG")"; fi
REPORT=$(ls "$FAKE_MEFISTO"/.mefisto/pipeline/logs/mefisto-tooling-run-*-issue-42.report.log 2>/dev/null | head -1)
if [ -n "$REPORT" ] && wait_for_file "$REPORT" && grep -q "salida del pipeline" "$REPORT"; then pass "reporte en logs/mefisto-tooling-run-*-issue-42.report.log"; else fail "reporte ausente o vacio: '$REPORT'"; fi
if grep -qF "$REPORT" "$TMP_DIR/stdout"; then pass "el wrapper anuncia la ruta del reporte"; else fail "stdout: $(cat "$TMP_DIR/stdout")"; fi
if grep -qF "sin pane: lo sigue el mod mefisto-divine-wager" "$TMP_DIR/stdout"; then pass "anuncia que lo sigue el mod"; else fail "stdout: $(cat "$TMP_DIR/stdout")"; fi

echo ""
echo "[3] entorno del pipeline aislado"
if grep -qx "herdr: " "$PIPELINE_STUB_LOG"; then pass "sin HERDR_*"; else fail "$(grep herdr "$PIPELINE_STUB_LOG")"; fi
if grep -qx "ui: " "$PIPELINE_STUB_LOG"; then pass "sin MEFISTO_UI (los gates hijos no heredan el modo)"; else fail "$(grep ui "$PIPELINE_STUB_LOG")"; fi
if grep -qx "runtime: claude" "$PIPELINE_STUB_LOG"; then pass "conserva MEFISTO_RUNTIME"; else fail "$(grep runtime "$PIPELINE_STUB_LOG")"; fi

echo ""
echo "[4] --batch con MEFISTO_UI=mod corre el batch desacoplado"
run_wrapper --batch 42 43
if [ "$LAST_RC" -eq 0 ]; then pass "el wrapper termina sin error"; else fail "rc=$LAST_RC stderr: $(cat "$TMP_DIR/stderr")"; fi
if wait_for_file "$BATCH_STUB_LOG"; then pass "el batch corrio desacoplado"; else fail "el batch no corrio"; fi
if [ ! -s "$UI_STUB_LOG" ]; then pass "herdr no fue invocado"; else fail "se invoco UI: $(cat "$UI_STUB_LOG")"; fi
if grep -qF "args: 42 43" "$BATCH_STUB_LOG"; then pass "issues en orden"; else fail "args: $(cat "$BATCH_STUB_LOG")"; fi
if grep -qx "herdr: " "$BATCH_STUB_LOG" && grep -qx "ui: " "$BATCH_STUB_LOG"; then pass "sin HERDR_* ni MEFISTO_UI"; else fail "$(cat "$BATCH_STUB_LOG")"; fi
REPORT=$(ls "$FAKE_MEFISTO"/.mefisto/pipeline/logs/mefisto-batch-run-*.report.log 2>/dev/null | head -1)
if [ -n "$REPORT" ] && wait_for_file "$REPORT" && grep -q "salida del batch" "$REPORT"; then pass "reporte en logs/mefisto-batch-run-*.report.log"; else fail "reporte ausente o vacio: '$REPORT'"; fi

echo ""
echo "[5] --batch con MEFISTO_UI=mod rechaza un issue no numerico"
run_wrapper --batch 42 '43;touch x'
sleep 0.5
if [ "$LAST_RC" -ne 0 ]; then pass "el wrapper falla"; else fail "rc=0 con un issue invalido"; fi
if [ ! -e "$BATCH_STUB_LOG" ]; then pass "el batch no se lanza"; else fail "se lanzo el batch: $(cat "$BATCH_STUB_LOG")"; fi

echo ""
echo "[6] un MEFISTO_UI distinto de mod|herdr aborta nombrando los dos modos"
run_wrapper_env MEFISTO_UI=sesion MEFISTO_RUNTIME=claude -- --tooling 42
sleep 0.5
if [ "$LAST_RC" -eq 1 ]; then pass "el wrapper termina con exit 1"; else fail "rc=$LAST_RC"; fi
if grep -qF "MEFISTO_UI='sesion' no es un modo valido" "$TMP_DIR/stderr" && grep -qF "'mod' (desacoplado, el default)" "$TMP_DIR/stderr" && grep -qF "'herdr' (panes, dentro de herdr)" "$TMP_DIR/stderr"; then pass "el mensaje nombra mod y herdr"; else fail "stderr: $(cat "$TMP_DIR/stderr")"; fi
if [ ! -e "$PIPELINE_STUB_LOG" ] && [ ! -s "$UI_STUB_LOG" ]; then pass "no se lanza nada"; else fail "se lanzo algo: $(cat "$PIPELINE_STUB_LOG" "$UI_STUB_LOG" 2>/dev/null)"; fi
run_wrapper_env MEFISTO_UI=sesion -- --help
if [ "$LAST_RC" -eq 0 ] && grep -q "^Uso:" "$TMP_DIR/stdout"; then pass "--help no depende del modo"; else fail "rc=$LAST_RC stderr: $(cat "$TMP_DIR/stderr")"; fi

echo ""
echo "[7] sin MEFISTO_UI, runtime sin cinta y fuera de herdr: desacoplado con reporte y visor"
run_wrapper_env MEFISTO_RUNTIME=fake -- --tooling 77
if [ "$LAST_RC" -eq 0 ]; then pass "el wrapper termina sin error"; else fail "rc=$LAST_RC stderr: $(cat "$TMP_DIR/stderr")"; fi
if wait_for_file "$PIPELINE_STUB_LOG" && grep -qF "args: 77" "$PIPELINE_STUB_LOG"; then pass "el pipeline corrio desacoplado"; else fail "el pipeline no corrio"; fi
if grep -qx "runtime: fake" "$PIPELINE_STUB_LOG"; then pass "conserva MEFISTO_RUNTIME"; else fail "$(grep runtime "$PIPELINE_STUB_LOG")"; fi
if [ ! -s "$UI_STUB_LOG" ]; then pass "herdr no fue invocado"; else fail "se invoco UI: $(cat "$UI_STUB_LOG")"; fi
if grep -qF "(sin pane)" "$TMP_DIR/stdout" && ! grep -qF "lo sigue el mod" "$TMP_DIR/stdout"; then pass "no promete el mod"; else fail "stdout: $(cat "$TMP_DIR/stdout")"; fi
if grep -q "issue-77.report.log" "$TMP_DIR/stdout"; then pass "anuncia la ruta del reporte"; else fail "stdout: $(cat "$TMP_DIR/stdout")"; fi
if grep -qF "./.claude/scripts/mefisto-stream-watch.sh --issues 77" "$TMP_DIR/stdout"; then pass "anuncia la linea del visor"; else fail "stdout: $(cat "$TMP_DIR/stdout")"; fi
run_wrapper_env MEFISTO_RUNTIME=fake -- --batch 42 43
if [ "$LAST_RC" -eq 0 ] && wait_for_file "$BATCH_STUB_LOG"; then pass "--batch corre desacoplado"; else fail "rc=$LAST_RC stderr: $(cat "$TMP_DIR/stderr")"; fi
if grep -qF "./.claude/scripts/mefisto-stream-watch.sh --issues 42,43" "$TMP_DIR/stdout"; then pass "--batch anuncia el visor con sus issues"; else fail "stdout: $(cat "$TMP_DIR/stdout")"; fi

echo ""
echo "[8] --attach e --if-exists abortan con un error explicito"
for retired in "--attach" "--tooling 42 --if-exists replace"; do
    # shellcheck disable=SC2086
    run_wrapper $retired
    sleep 0.3
    if [ "$LAST_RC" -eq 1 ] && grep -qF -- "--attach e --if-exists ya no existen" "$TMP_DIR/stderr"; then pass "$retired: error explicito"; else fail "$retired: rc=$LAST_RC stderr: $(cat "$TMP_DIR/stderr")"; fi
    if [ ! -e "$PIPELINE_STUB_LOG" ]; then pass "$retired: no se lanza nada"; else fail "$retired: se lanzo el pipeline"; fi
done

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
