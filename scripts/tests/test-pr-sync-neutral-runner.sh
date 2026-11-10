#!/usr/bin/env bash
# test-pr-sync-neutral-runner.sh -- Regresiones de run_agent() delegado al
# runner neutral (issue #1582): pr-sync.sh ya no invoca ningun CLI de runtime
# concreto directo, sino src/runtime/mefisto-run-agent.sh via MEFISTO_RUN_AGENT_BIN.
#
# Mismo patron de extraccion por awk que test-pr-sync-merge-retry.sh: la
# funcion real se extrae tal cual vive en pr-sync.sh y se ejecuta con un
# runner neutral stub, sin invocar ningun runtime real.
#
#   N-1: los argumentos que recibe el stub incluyen --agent implementer y
#        --cwd <worktree> (CA-1).
#   N-2: exit 0 del runner + terminal run.completed{status:success} en el
#        JSONL -> run_agent retorna 0 (CA-4).
#   N-3: exit != 0 del runner -> run_agent retorna != 0 aunque el JSONL
#        declare un terminal exitoso (CA-4).
#   N-4: exit 0 del runner sin terminal exitoso en el JSONL (run.failed, o
#        JSONL vacio) -> run_agent retorna != 0 (CA-4).
#
# Uso: scripts/tests/test-pr-sync-neutral-runner.sh
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

if ! grep -q -- '--runtime "\$MEFISTO_RUNTIME_RESUELTO"' <<< "$FUNC_SRC" \
    || ! grep -q -- '"\$RUN_AGENT_BIN"' <<< "$FUNC_SRC"; then
    fail "run_agent() ya no delega en el runner neutral (\$RUN_AGENT_BIN)"
else
    pass "run_agent() delega en el runner neutral (\$RUN_AGENT_BIN)"
fi

if grep -qE 'claude -p|--permission-mode' <<< "$FUNC_SRC"; then
    fail "run_agent() todavia invoca un CLI de runtime concreto"
else
    pass "run_agent() no invoca ningun CLI de runtime concreto"
fi

# make_stub_runner <bin_dir> <exit_code> <terminal_status>
#   terminal_status: "success" | "failed" | "none" (JSONL vacio, sin terminal)
make_stub_runner() {
    local bin_dir="$1" exit_code="$2" terminal_status="$3"
    mkdir -p "$bin_dir"
    cat > "$bin_dir/mefisto-run-agent-stub.sh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "$TMP_DIR/stub-args.txt"

prev="" event_log=""
for a in "\$@"; do
    if [ "\$prev" = "--event-log" ]; then event_log="\$a"; fi
    prev="\$a"
done

if [ -n "\$event_log" ]; then
    mkdir -p "\$(dirname "\$event_log")"
    case "$terminal_status" in
        none) : > "\$event_log" ;;
        success) printf '{"type":"run.completed","status":"success"}\n' > "\$event_log" ;;
        *) printf '{"type":"run.failed","status":"$terminal_status"}\n' > "\$event_log" ;;
    esac
fi
exit $exit_code
STUB
    chmod +x "$bin_dir/mefisto-run-agent-stub.sh"
}

run_case() {
    local case_name="$1" exit_code="$2" terminal_status="$3"
    local case_file="$TMP_DIR/$case_name.sh"
    local bin_dir="$TMP_DIR/$case_name-bin"
    local fake_worktree="$TMP_DIR/$case_name-worktree"
    mkdir -p "$fake_worktree"
    make_stub_runner "$bin_dir" "$exit_code" "$terminal_status"
    : > "$TMP_DIR/stub-args.txt"
    : > "$TMP_DIR/log.txt"
    : > "$TMP_DIR/warn.txt"

    {
        printf '%s\n' 'set -uo pipefail'
        printf '%s\n' "source \"$COMMON_LIB\""
        printf '%s\n' "$FUNC_SRC"
        cat <<HARNESS
LOG_DIR_ABS="$TMP_DIR"
TIMESTAMP="ts"
RUN_AGENT_BIN="$bin_dir/mefisto-run-agent-stub.sh"
MEFISTO_RUNTIME_RESUELTO="fake-runtime"
IMPLEMENTER_MODEL=""
IMPLEMENTER_EFFORT=""
${EFFORT_SETUP:-}
LOG_FILE_ABS="$TMP_DIR/log.txt"
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
}

echo "[N-1] argumentos que recibe el runner neutral"
run_case argcheck 0 success
if [ "$RC" -eq 0 ] && echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "N-1: run_agent retorna 0 con exit 0 + terminal exitoso"
else
    fail "N-1: se esperaba RESULT=0. Salida: $OUTPUT"
fi
if grep -qx -- '--agent' "$TMP_DIR/stub-args.txt" && grep -qx 'implementer' "$TMP_DIR/stub-args.txt"; then
    pass "N-1: el stub recibio --agent implementer"
else
    fail "N-1: falta --agent implementer en los argumentos: $(cat "$TMP_DIR/stub-args.txt")"
fi
if grep -qx -- '--cwd' "$TMP_DIR/stub-args.txt" && grep -qx "$WORKTREE_PATH" "$TMP_DIR/stub-args.txt"; then
    pass "N-1: el stub recibio --cwd <worktree>"
else
    fail "N-1: falta --cwd <worktree> en los argumentos: $(cat "$TMP_DIR/stub-args.txt")"
fi

echo "[N-2] exit 0 + terminal exitoso -> 0"
run_case success 0 success
if [ "$RC" -eq 0 ] && echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "N-2: run_agent retorna 0"
else
    fail "N-2: se esperaba RESULT=0. Salida: $OUTPUT"
fi

echo "[N-3] exit != 0 -> != 0 aunque el JSONL declare exito"
run_case nonzero-exit 1 success
if [ "$RC" -eq 0 ] && ! echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "N-3: run_agent retorna != 0 cuando el runner sale != 0"
else
    fail "N-3: se esperaba RESULT != 0. Salida: $OUTPUT"
fi

echo "[N-4] exit 0 sin terminal exitoso -> != 0"
run_case no-success-terminal 0 failed
if [ "$RC" -eq 0 ] && ! echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "N-4a: run_agent retorna != 0 con terminal run.failed"
else
    fail "N-4a: se esperaba RESULT != 0. Salida: $OUTPUT"
fi

run_case no-terminal-at-all 0 none
if [ "$RC" -eq 0 ] && ! echo "$OUTPUT" | grep -q 'RESULT=0'; then
    pass "N-4b: run_agent retorna != 0 con JSONL sin terminal"
else
    fail "N-4b: se esperaba RESULT != 0. Salida: $OUTPUT"
fi

echo "[N-5] effort del implementer con el adaptador fake (issue #2500)"
if grep -Fq 'resolve_pipeline_agent_effort implementer implementer' "$PR_SYNC" \
    && grep -Fq '[ -n "$IMPLEMENTER_EFFORT" ] && args+=(--effort "$IMPLEMENTER_EFFORT")' "$PR_SYNC" \
    && grep -Fq 'MEFISTO_EFFORTS_ERROR' "$PR_SYNC"; then
    pass "N-5: pr-sync.sh resuelve el effort antes del bucle de PRs y pasa --effort condicional"
else
    fail "N-5: pr-sync.sh no resuelve/pasa el effort del implementer"
fi
cat > "$TMP_DIR/models-effort.json" <<'EOF'
{"fake":{"efforts":{"levels":{"light":"n-light","standard":"n-standard","thorough":"n-thorough"},"agents":{"implementer":"thorough"}}}}
EOF
cat > "$TMP_DIR/models-levels.json" <<'EOF'
{"fake":{"efforts":{"levels":{"light":"n-light","standard":"n-standard","thorough":"n-thorough"}}}}
EOF
effort_setup() {
    printf 'source "%s/src/runtime/lib/mefisto-models.sh"\nMEFISTO_RUNTIME_RESUELTO="fake"\nCONSUMER_MODELS_FILE="%s"\nresolve_pipeline_agent_effort implementer implementer || exit 9\nIMPLEMENTER_EFFORT="$RESOLVED_PIPELINE_EFFORT"' "$REPO_ROOT" "$1"
}
EFFORT_SETUP="$(effort_setup "$TMP_DIR/ausente.json")" run_case eff-none 0 success
if [ "$RC" -eq 0 ] && echo "$OUTPUT" | grep -q 'RESULT=0' && ! grep -qx -- '--effort' "$TMP_DIR/stub-args.txt"; then
    pass "N-5: sin mapping ni default el implementer no recibe --effort (hereda)"
else
    fail "N-5: sin mapping no debia pasarse --effort. Salida: $OUTPUT"
fi
EFFORT_SETUP="$(effort_setup "$TMP_DIR/models-levels.json")" run_case eff-level 0 success
if grep -qx -- '--effort' "$TMP_DIR/stub-args.txt" && grep -qx 'n-standard' "$TMP_DIR/stub-args.txt"; then
    pass "N-5: sin override el implementer recibe el nativo de su nivel de fabrica (standard)"
else
    fail "N-5: se esperaba --effort n-standard: $(tr '\n' ' ' < "$TMP_DIR/stub-args.txt")"
fi
EFFORT_SETUP="$(effort_setup "$TMP_DIR/models-effort.json")" run_case eff-agent 0 success
if grep -qx -- '--effort' "$TMP_DIR/stub-args.txt" && grep -qx 'n-thorough' "$TMP_DIR/stub-args.txt"; then
    pass "N-5: efforts.agents.implementer gana sobre el nivel de fabrica (n-thorough)"
else
    fail "N-5: se esperaba --effort n-thorough: $(tr '\n' ' ' < "$TMP_DIR/stub-args.txt")"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
