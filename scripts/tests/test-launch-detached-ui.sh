#!/usr/bin/env bash
# test-launch-detached-ui.sh -- Decision de modo de UI de scripts/launch-pipeline.sh
# (desacoplado o herdr) y guard de pane ajeno de scripts/herdr-pipeline.sh
# (issue #2285, contraparte publicada de #2284).
#
# Subproceso real con stubs de herdr/gh en PATH sobre una copia del paquete
# publicado cuyos sub-pipelines son stubs inocuos.
#
# Cubre:
#   CA-1  MEFISTO_RUNTIME=claude sin MEFISTO_UI: tdd/tooling/infra/scaffold/--batch
#         corren desacoplados (cero herdr pane split|run).
#   CA-2  Un runtime distinto de claude dentro de herdr: split a la derecha de HERDR_PANE_ID.
#   CA-3  MEFISTO_UI=herdr explicito gana; --parallel conserva panes en modo herdr.
#   CA-4  HERDR_PANE_ID ajeno: aborta con el mensaje del guard, sin tocar panes.
#   CA-5  Decision de modo: MEFISTO_UI invalido y MEFISTO_UI=herdr fuera de herdr
#         abortan; MEFISTO_UI=mod y "ni mod ni herdr" corren desacoplados e
#         imprimen el report log y la linea del visor; --attach e --if-exists
#         dan un error explicito; --help no depende del modo.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PKG="$TMP_DIR/pkg"
CONSUMER="$TMP_DIR/consumer"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$PKG/scripts" "$PKG/src" "$CONSUMER" "$FAKE_BIN"
cp "$REPO_ROOT"/scripts/*.sh "$PKG/scripts/"
ln -s "$REPO_ROOT/src/runtime" "$PKG/src/runtime"
for s in tdd tooling scaffold batch; do
    printf '#!/usr/bin/env bash\necho "stub %s $*"\n' "$s" > "$PKG/scripts/$s-pipeline.sh"
done
printf '#!/usr/bin/env bash\necho "stub iac $*"\n' > "$PKG/scripts/iac-pipeline.sh"
chmod +x "$PKG"/scripts/*.sh
(cd "$CONSUMER" && git init -q && git -c user.email=t@e.com -c user.name=T commit --allow-empty -q -m i)
CONSUMER="$(cd "$CONSUMER" && pwd -P)"

export STUB_LOG="$TMP_DIR/stub.log"
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in *state*) printf 'OPEN|tipo:tooling\n' ;; *) echo 'tipo:tooling' ;; esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/claude"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/sleep"
cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
echo "herdr $*" >> "$STUB_LOG"
case "${1:-} ${2:-}" in
    "pane split") echo '{"result":{"pane":{"pane_id":"w1:p1"}}}' ;;
    "pane process-info")
        echo "{\"result\":{\"process_info\":{\"shell_pid\":${STUB_OWNER_PID:-1},\"foreground_process_group_id\":${STUB_OWNER_PID:-1}}}}" ;;
    "pane run")
        marker=$(printf '%s\n' "${4:-}" | grep -oE -- '--started-marker [^[:space:]]+' | awk '{print $2}')
        [ -n "$marker" ] && { mkdir -p "$(dirname "$marker")"; : > "$marker"; }
        echo '{"result":{"type":"ok"}}' ;;
    *) echo '{"result":{"type":"ok"}}' ;;
esac
STUB
chmod +x "$FAKE_BIN"/*

LAST_RC=0
LAST_ERR=""
# run <ENV=VAL...> -- <args...>
run() {
    : > "$STUB_LOG"
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done
    shift
    (
        cd "$CONSUMER" || exit 99
        env -u MEFISTO_UI -u MEFISTO_RUNTIME -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
            -u MEFISTO_REPO_ROOT -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:/usr/bin:/bin" \
            HERDR_ENV=1 HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
            STUB_LOG="$STUB_LOG" STUB_OWNER_PID="${STUB_OWNER_PID-$$}" \
            ${envs[@]+"${envs[@]}"} "$PKG/scripts/launch-pipeline.sh" "$@"
    ) </dev/null >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
    LAST_RC=$?
    LAST_ERR=$(cat "$TMP_DIR/stderr")
}
no_panes() { ! grep -qE "pane (split|run|close)" "$STUB_LOG"; }
OUTSIDE_HERDR=(HERDR_ENV=0 HERDR_PANE_ID=)
# wait_report <patron-de-archivo> <texto>: espera a que el sub-pipeline desacoplado escriba su report.
wait_report() {
    local i=0
    while [ $i -lt 50 ] && ! grep -rqs -- "$2" "$CONSUMER" --include="$1"; do /bin/sleep 0.1; i=$((i+1)); done
    grep -rqs -- "$2" "$CONSUMER" --include="$1"
}
clear_reports() { find "$CONSUMER" -name '*.report.log' -delete 2>/dev/null; }

echo "[1] CA-1: runtime claude sin MEFISTO_UI corre desacoplado"
for mode in "2285" "--pipeline tooling 2285" "--tooling 2285" "--infra 2285" "--scaffold --domain pagos" "--batch 2285 2286"; do
    # shellcheck disable=SC2086
    run MEFISTO_RUNTIME=claude -- $mode
    if [ "$LAST_RC" -eq 0 ]; then pass "$mode: exit 0"; else fail "$mode: rc=$LAST_RC err=$LAST_ERR"; fi
    if no_panes; then pass "$mode: cero herdr pane split|run|close"; else fail "$mode abrio pane: $(cat "$STUB_LOG")"; fi
    if grep -q "sin pane" "$TMP_DIR/stdout" && grep -q "fausto-blood-pact" "$TMP_DIR/stdout" && grep -q "\.report\.log" "$TMP_DIR/stdout"; then
        pass "$mode: imprime 'sin pane', log y consola de Fausto"
    else
        fail "$mode: salida inesperada: $(cat "$TMP_DIR/stdout")"
    fi
done
if [ -f "$CONSUMER/.mefisto/pipeline/events.log" ]; then pass "se crea events.log canonico"; else fail "no se creo .mefisto/pipeline/events.log"; fi
if [ ! -e "$CONSUMER/.claude/pipeline/events.log" ]; then pass "no se escribe events.log legacy"; else fail "se creo .claude/pipeline/events.log"; fi

echo "[2] CA-2: un runtime distinto de claude dentro de herdr conserva el split a la derecha"
run MEFISTO_RUNTIME=fake -- --tooling 2285
if grep -qF "pane split --pane w1:p0 --direction right" "$STUB_LOG"; then pass "split a la derecha de w1:p0"; else fail "sin split -- log: $(cat "$STUB_LOG") err: $LAST_ERR"; fi

echo "[3] CA-3: MEFISTO_UI=herdr explicito gana; --parallel conserva panes en modo herdr"
run MEFISTO_RUNTIME=claude MEFISTO_UI=herdr -- --tooling 2285
if grep -qE "pane (split|run)" "$STUB_LOG"; then pass "MEFISTO_UI=herdr gana"; else fail "no uso herdr: $(cat "$STUB_LOG") err: $LAST_ERR"; fi
run MEFISTO_RUNTIME=claude MEFISTO_UI=herdr -- --parallel 2285 2286
if grep -qE "pane (split|run)" "$STUB_LOG"; then pass "--parallel con MEFISTO_UI=herdr conserva panes"; else fail "--parallel herdr cambio: $(cat "$STUB_LOG") err: $LAST_ERR"; fi
run MEFISTO_RUNTIME=fake -- --parallel 2285 2286
if grep -qE "pane (split|run)" "$STUB_LOG"; then pass "--parallel con otro runtime conserva panes"; else fail "--parallel con otro runtime cambio: $(cat "$STUB_LOG") err: $LAST_ERR"; fi

echo "[3b] #2448: --parallel con claude sin MEFISTO_UI corre desacoplado via parallel-pipeline.sh"
printf '#!/usr/bin/env bash\necho "stub parallel $*"\n' > "$PKG/scripts/parallel-pipeline.sh"
chmod +x "$PKG/scripts/parallel-pipeline.sh"
for inside in 1 0; do
    if [ "$inside" = 1 ]; then run MEFISTO_RUNTIME=claude -- --parallel 1 2 3; else run MEFISTO_RUNTIME=claude "${OUTSIDE_HERDR[@]}" -- --parallel 1 2 3; fi
    if [ "$LAST_RC" -eq 0 ]; then pass "parallel(herdr=$inside): exit 0"; else fail "parallel(herdr=$inside): rc=$LAST_RC err=$LAST_ERR"; fi
    if no_panes; then pass "parallel(herdr=$inside): sin panes"; else fail "parallel(herdr=$inside) abrio pane: $(cat "$STUB_LOG")"; fi
    if grep -q "parallel-run-.*\.report\.log" "$TMP_DIR/stdout"; then pass "parallel(herdr=$inside): report parallel-run-<ts>.report.log"; else fail "parallel(herdr=$inside): salida: $(cat "$TMP_DIR/stdout")"; fi
    if grep -q "stream-watch.sh' --issues 1,2,3" "$TMP_DIR/stdout"; then pass "parallel(herdr=$inside): visor filtrado por los issues del lote"; else fail "parallel(herdr=$inside): sin linea del visor: $(cat "$TMP_DIR/stdout")"; fi
    if wait_report 'parallel-run-*.report.log' "stub parallel 1 2 3"; then pass "parallel(herdr=$inside): lanzo parallel-pipeline.sh 1 2 3"; else fail "parallel(herdr=$inside): no llego parallel-pipeline.sh 1 2 3"; fi
    clear_reports
done
run MEFISTO_RUNTIME=claude -- --parallel --max-parallel 2 --pipeline tooling 4 5
if wait_report 'parallel-run-*.report.log' "stub parallel --pipeline tooling --max-parallel 2 4 5"; then pass "--max-parallel y --pipeline llegan a parallel-pipeline.sh"; else fail "flags no llegaron: $(cat "$TMP_DIR/stdout")"; fi
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in *state*) printf 'OPEN|tipo:projection\n' ;; *) echo 'tipo:projection' ;; esac
STUB
run MEFISTO_RUNTIME=claude -- --parallel --max-parallel '2;x' 4 5
if [ "$LAST_RC" -ne 0 ] && no_panes; then pass "--max-parallel no numerico aborta en modo desacoplado"; else fail "acepto --max-parallel invalido: rc=$LAST_RC"; fi
run MEFISTO_RUNTIME=claude -- --parallel 4 '5;x'
if [ "$LAST_RC" -ne 0 ] && no_panes; then pass "issue no numerico aborta en modo desacoplado"; else fail "acepto issue invalido: rc=$LAST_RC"; fi
run MEFISTO_RUNTIME=claude -- --parallel 6 7
if [ "$LAST_RC" -eq 0 ]; then pass "dos tipo:projection no abortan en modo desacoplado"; else fail "abort con projections: $LAST_ERR"; fi
run MEFISTO_RUNTIME=fake -- --parallel 6 7
if [ "$LAST_RC" -ne 0 ]; then pass "dos tipo:projection abortan en modo herdr"; else fail "no abortó en modo herdr"; fi

echo "[4] CA-4: HERDR_PANE_ID ajeno aborta sin tocar panes"
STUB_OWNER_PID=999999 run MEFISTO_RUNTIME=fake -- --tooling 2285
if [ "$LAST_RC" -ne 0 ]; then pass "exit != 0"; else fail "deberia abortar"; fi
if printf '%s' "$LAST_ERR" | grep -q "heredado"; then pass "mensaje del guard"; else fail "mensaje inesperado: $LAST_ERR"; fi
if no_panes; then pass "cero pane split|run|close"; else fail "toco panes: $(cat "$STUB_LOG")"; fi

echo "[5] CA-5: decision de modo"
clear_reports
run MEFISTO_RUNTIME=claude MEFISTO_UI=sesiones -- --tooling 2285
if [ "$LAST_RC" -eq 1 ]; then pass "MEFISTO_UI invalido: exit 1"; else fail "MEFISTO_UI invalido: rc=$LAST_RC"; fi
if printf '%s' "$LAST_ERR" | grep -qF "MEFISTO_UI='sesiones' no es un modo valido" \
    && printf '%s' "$LAST_ERR" | grep -qF "'mod' (desacoplado, el default)" \
    && printf '%s' "$LAST_ERR" | grep -qF "'herdr' (panes, dentro de herdr)"; then
    pass "MEFISTO_UI invalido: el mensaje nombra los dos modos validos"
else
    fail "MEFISTO_UI invalido: mensaje inesperado: $LAST_ERR"
fi
if no_panes && [ -z "$(find "$CONSUMER" -name '*.report.log')" ]; then pass "MEFISTO_UI invalido: no lanza nada"; else fail "MEFISTO_UI invalido lanzo algo"; fi

run MEFISTO_RUNTIME=claude MEFISTO_UI=herdr "${OUTSIDE_HERDR[@]}" -- --tooling 2285
if [ "$LAST_RC" -eq 1 ] && printf '%s' "$LAST_ERR" | grep -qF "MEFISTO_UI=herdr requiere correr dentro de un pane de herdr"; then
    pass "MEFISTO_UI=herdr fuera de herdr aborta con mensaje claro"
else
    fail "MEFISTO_UI=herdr fuera de herdr: rc=$LAST_RC err=$LAST_ERR"
fi
if no_panes && [ -z "$(find "$CONSUMER" -name '*.report.log')" ]; then pass "MEFISTO_UI=herdr fuera de herdr: no lanza nada"; else fail "MEFISTO_UI=herdr fuera de herdr lanzo algo"; fi

run MEFISTO_RUNTIME=fake MEFISTO_UI=mod -- --tooling 2285 --from-stage 2
if [ "$LAST_RC" -eq 0 ] && no_panes; then pass "MEFISTO_UI=mod gana dentro de herdr con otro runtime"; else fail "MEFISTO_UI=mod: rc=$LAST_RC log=$(cat "$STUB_LOG") err=$LAST_ERR"; fi
if wait_report 'tooling-issue-2285-run-*.report.log' "stub tooling 2285 --from-stage 2"; then pass "MEFISTO_UI=mod: lanzo tooling-pipeline.sh 2285 --from-stage 2"; else fail "MEFISTO_UI=mod: no llego el sub-pipeline"; fi
clear_reports

run MEFISTO_RUNTIME=fake "${OUTSIDE_HERDR[@]}" -- --tooling 2285
if [ "$LAST_RC" -eq 0 ] && no_panes; then pass "ni mod ni herdr: corre desacoplado"; else fail "ni mod ni herdr: rc=$LAST_RC err=$LAST_ERR"; fi
if grep -q "sin pane" "$TMP_DIR/stdout" && ! grep -q "fausto-blood-pact" "$TMP_DIR/stdout"; then pass "ni mod ni herdr: 'sin pane' sin prometer la consola"; else fail "ni mod ni herdr: salida: $(cat "$TMP_DIR/stdout")"; fi
if grep -q "tooling-issue-2285-run-.*\.report\.log" "$TMP_DIR/stdout"; then pass "ni mod ni herdr: imprime la ruta del report log"; else fail "ni mod ni herdr: sin report log: $(cat "$TMP_DIR/stdout")"; fi
if grep -qF "$PKG/scripts/stream-watch.sh' --issues 2285" "$TMP_DIR/stdout"; then pass "ni mod ni herdr: imprime la linea del visor"; else fail "ni mod ni herdr: sin linea del visor: $(cat "$TMP_DIR/stdout")"; fi
if wait_report 'tooling-issue-2285-run-*.report.log' "stub tooling 2285"; then pass "ni mod ni herdr: lanzo tooling-pipeline.sh 2285"; else fail "ni mod ni herdr: no llego el sub-pipeline"; fi
clear_reports

run MEFISTO_RUNTIME=fake "${OUTSIDE_HERDR[@]}" -- --scaffold --domain pagos
if grep -qF "$PKG/scripts/stream-watch.sh'" "$TMP_DIR/stdout" && ! grep -q -- "--issues" "$TMP_DIR/stdout"; then pass "scaffold sin issue: visor sin --issues"; else fail "scaffold sin issue: salida: $(cat "$TMP_DIR/stdout")"; fi
clear_reports

for flag in "--attach" "--attach tooling-2285" "--tooling 2285 --if-exists replace"; do
    for ui in mod herdr; do
        # shellcheck disable=SC2086
        run MEFISTO_RUNTIME=claude MEFISTO_UI=$ui -- $flag
        if [ "$LAST_RC" -eq 1 ] && printf '%s' "$LAST_ERR" | grep -qF -- "--attach e --if-exists ya no existen"; then
            pass "'$flag' (MEFISTO_UI=$ui): error explicito"
        else
            fail "'$flag' (MEFISTO_UI=$ui): rc=$LAST_RC err=$LAST_ERR"
        fi
        if no_panes && [ -z "$(find "$CONSUMER" -name '*.report.log')" ]; then pass "'$flag' (MEFISTO_UI=$ui): no lanza nada"; else fail "'$flag' (MEFISTO_UI=$ui) lanzo algo"; fi
    done
done

run MEFISTO_UI=sesiones -- --help
if [ "$LAST_RC" -eq 0 ] && grep -q "launch-pipeline.sh" "$TMP_DIR/stdout"; then pass "--help no depende del modo"; else fail "--help: rc=$LAST_RC err=$LAST_ERR"; fi

echo ""
echo "Resumen: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
