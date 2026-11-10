#!/usr/bin/env bash
# test-herdr-refresh-agents.sh -- Tests del modo --refresh-agents (#1333, #1335).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HERDR_SCRIPT="$REPO_ROOT/scripts/herdr-pipeline.sh"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 -- se esperaba '$2', fue '$3'"; fi
}
assert_contains() {
    if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 -- falta '$3'"; fi
}
assert_not_contains() {
    if printf '%s' "$2" | grep -qF -- "$3"; then fail "$1 -- aparece '$3'"; else pass "$1"; fi
}
extract_fn() {
    awk -v fn="$1" '$0 ~ "^" fn "\\(\\) \\{" { p=1 } p { print } p && /^}/ { p=0 }' "$2"
}

FAKE_CONSUMER="$(mktemp -d)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
FAKE_NO_JQ_BIN="$TMP_DIR/bin-no-jq"
FAKE_NO_HERDR_BIN="$TMP_DIR/bin-no-herdr"
FAKE_RUNTIME="$TMP_DIR/runtime"
mkdir -p "$FAKE_BIN" "$FAKE_NO_JQ_BIN" "$FAKE_NO_HERDR_BIN" "$FAKE_RUNTIME"
trap 'rm -rf "$FAKE_CONSUMER" "$TMP_DIR"' EXIT
(cd "$FAKE_CONSUMER" && git init -q)
export HERDR_STUB_LOG="$TMP_DIR/herdr.log"
export HERDR_READY_POLLED="$TMP_DIR/ready-polled"

cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
{
    printf 'herdr'
    printf ' <%s>' "$@"
    printf '\n'
} >> "$HERDR_STUB_LOG"
case "${1:-} ${2:-}" in
  "agent list")
    printf '%s' '{"result":{"agents":[' \
      '{"agent":"prompted","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:self","workspace_id":"w9"},' \
      '{"agent":"prompted","agent_status":"working","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:work","workspace_id":"w9"},' \
      '{"agent":"prompted","agent_status":"blocked","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:block","workspace_id":"w9"},' \
      '{"agent":"missing","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:missing","workspace_id":"w9"},' \
      '{"agent":"without","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:without","workspace_id":"w9"},' \
      '{"agent":"broken","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:broken","workspace_id":"w9"},' \
      '{"agent":"prompted","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:ok","workspace_id":"w9"},' \
      '{"agent":"prompted","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:fail","workspace_id":"w9"},' \
      '{"agent":"restarting","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","name":"restart-nombrado","pane_id":"w9:restart-listo","workspace_id":"w9"},' \
      '{"agent":"restarting","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:sin-nombre","workspace_id":"w9"},' \
      '{"agent":"restarting","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w9:sin-salida","workspace_id":"w9"},' \
      '{"agent":"restarting","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","name":"restart-fallido","pane_id":"w9:inicio-falla","workspace_id":"w9"},' \
      '{"agent":"prompted","agent_status":"idle","cwd":"/otro","pane_id":"w9:other-cwd","workspace_id":"w9"},' \
      '{"agent":"prompted","agent_status":"idle","cwd":"'"$(git rev-parse --show-toplevel)"'","pane_id":"w8:other-workspace","workspace_id":"w8"}' \
      ']}}'
    printf '\n'
    ;;
  "agent prompt")
    [ "${3:-}" = "w9:fail" ] && exit 1
    exit 0
    ;;
  "pane process-info")
    case "${4:-}" in
      w9:restart-listo)
        if [ ! -f "$HERDR_READY_POLLED" ]; then
          : > "$HERDR_READY_POLLED"
          printf '%s\n' '{"result":{"process_info":{"foreground_process_group_id":99,"shell_pid":42}}}'
        else
          printf '%s\n' '{"result":{"process_info":{"foreground_process_group_id":42,"shell_pid":42}}}'
        fi
        ;;
      w9:sin-nombre|w9:inicio-falla)
        printf '%s\n' '{"result":{"process_info":{"foreground_process_group_id":42,"shell_pid":42}}}'
        ;;
      *)
        printf '%s\n' '{"result":{"process_info":{"foreground_process_group_id":99,"shell_pid":42}}}'
        ;;
    esac
    ;;
  "agent start")
    [ "${3:-}" = "restart-fallido" ] && exit 1
    exit 0
    ;;
esac
STUB
chmod +x "$FAKE_BIN/herdr"

# PATH determinista con herdr pero sin jq. El script solo necesita estas
# herramientas antes de que el no-op corte la ejecucion.
for tool in env bash dirname git uname; do
    ln -s "$(command -v "$tool")" "$FAKE_NO_JQ_BIN/$tool"
    ln -s "$(command -v "$tool")" "$FAKE_NO_HERDR_BIN/$tool"
done
ln -s "$FAKE_BIN/herdr" "$FAKE_NO_JQ_BIN/herdr"
ln -s "$(command -v jq)" "$FAKE_NO_HERDR_BIN/jq"

cat > "$FAKE_RUNTIME/runtime-prompted.sh" <<'ADAPTER'
runtime_prompted_interactive_refresh() { printf '%s\n' 'prompt reload all'; }
ADAPTER
cat > "$FAKE_RUNTIME/runtime-restarting.sh" <<'ADAPTER'
runtime_restarting_interactive_refresh() { printf '%s\n' 'restart /exit'; }
ADAPTER
cat > "$FAKE_RUNTIME/runtime-broken.sh" <<'ADAPTER'
runtime_broken_interactive_refresh() { return 1; }
ADAPTER
cat > "$FAKE_RUNTIME/runtime-without.sh" <<'ADAPTER'
runtime_without_other() { :; }
ADAPTER
: > "$FAKE_RUNTIME/mefisto-runtime.sh"

run_refresh() {
    : > "$HERDR_STUB_LOG"
    rm -f "$HERDR_READY_POLLED"
    (
        cd "$FAKE_CONSUMER" || exit 99
        env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID "$@" \
            PATH="$FAKE_BIN:$PATH" MEFISTO_RUNTIME_LIB_DIR="$FAKE_RUNTIME" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_READY_POLLED="$HERDR_READY_POLLED" \
            MEFISTO_REFRESH_EXIT_TIMEOUT="${MEFISTO_REFRESH_EXIT_TIMEOUT:-1}" \
            "$HERDR_SCRIPT" --refresh-agents \
            2>"$TMP_DIR/stderr.log"
    )
}

echo "[A] No-op seguro fuera de contexto"
OUT=$(run_refresh)
RC=$?
CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "sin contexto sale 0" "0" "$RC"
assert_eq "sin contexto no imprime panes" "" "$OUT"
assert_eq "sin contexto no invoca herdr" "" "$CALLS"

for scenario in \
    "sin HERDR_ENV|HERDR_PANE_ID=w9:self HERDR_WORKSPACE_ID=w9" \
    "sin HERDR_PANE_ID|HERDR_ENV=1 HERDR_WORKSPACE_ID=w9" \
    "sin HERDR_WORKSPACE_ID|HERDR_ENV=1 HERDR_PANE_ID=w9:self"; do
    label="${scenario%%|*}"
    variables="${scenario#*|}"
    # shellcheck disable=SC2086 # fixture deliberado de asignaciones env.
    OUT=$(run_refresh $variables)
    RC=$?
    CALLS=$(cat "$HERDR_STUB_LOG")
    assert_eq "$label sale 0" "0" "$RC"
    assert_eq "$label no imprime panes" "" "$OUT"
    assert_eq "$label no invoca herdr" "" "$CALLS"
done

: > "$HERDR_STUB_LOG"
OUT=$(cd "$FAKE_CONSUMER" && \
    PATH="$FAKE_NO_JQ_BIN" MEFISTO_RUNTIME_LIB_DIR="$FAKE_RUNTIME" \
    HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_ENV=1 \
    HERDR_PANE_ID=w9:self HERDR_WORKSPACE_ID=w9 \
    "$HERDR_SCRIPT" --refresh-agents 2>"$TMP_DIR/stderr.log")
RC=$?
CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "sin jq sale 0" "0" "$RC"
assert_eq "sin jq no imprime panes" "" "$OUT"
assert_eq "sin jq no invoca herdr" "" "$CALLS"

: > "$HERDR_STUB_LOG"
OUT=$(cd "$FAKE_CONSUMER" && \
    PATH="$FAKE_NO_HERDR_BIN" MEFISTO_RUNTIME_LIB_DIR="$FAKE_RUNTIME" \
    HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_ENV=1 \
    HERDR_PANE_ID=w9:self HERDR_WORKSPACE_ID=w9 \
    "$HERDR_SCRIPT" --refresh-agents 2>"$TMP_DIR/stderr.log")
RC=$?
assert_eq "sin herdr sale 0" "0" "$RC"
assert_eq "sin herdr no imprime panes" "" "$OUT"
assert_eq "sin herdr no invoca herdr" "" "$(cat "$HERDR_STUB_LOG")"

echo "[B] Descubrimiento, filtro y estrategias"
OUT=$(run_refresh HERDR_ENV=1 HERDR_PANE_ID=w9:self HERDR_WORKSPACE_ID=w9)
RC=$?
CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "recorrido sale 0 aunque un prompt falle" "0" "$RC"
EXPECTED_OUT=$(cat <<'EOF'
w9:self prompted omitido:pane-propio
w9:work prompted omitido:working
w9:block prompted omitido:blocked
w9:missing missing omitido:sin-estrategia
w9:without without omitido:sin-estrategia
w9:broken broken omitido:sin-estrategia
w9:ok prompted reload-enviado
w9:fail prompted omitido:prompt-fallo
w9:restart-listo restarting reiniciado
w9:sin-nombre restarting reiniciado
w9:sin-salida restarting omitido:no-salio
w9:inicio-falla restarting omitido:relanzamiento-fallo
EOF
)
assert_eq "stdout es exactamente una linea por agente considerado" "$EXPECTED_OUT" "$OUT"
assert_contains "omite pane propio" "$OUT" "w9:self prompted omitido:pane-propio"
assert_contains "omite working" "$OUT" "w9:work prompted omitido:working"
assert_contains "omite blocked" "$OUT" "w9:block prompted omitido:blocked"
assert_contains "omite adaptador ausente" "$OUT" "w9:missing missing omitido:sin-estrategia"
assert_contains "omite funcion ausente" "$OUT" "w9:without without omitido:sin-estrategia"
assert_contains "omite estrategia fallida" "$OUT" "w9:broken broken omitido:sin-estrategia"
assert_contains "envia prompt" "$OUT" "w9:ok prompted reload-enviado"
assert_contains "continua tras fallo de prompt" "$OUT" "w9:fail prompted omitido:prompt-fallo"
assert_contains "reinicia tras salir del runtime" "$OUT" "w9:restart-listo restarting reiniciado"
assert_contains "reinicia el agente sin nombre" "$OUT" "w9:sin-nombre restarting reiniciado"
assert_contains "omite restart que no sale antes del timeout" "$OUT" "w9:sin-salida restarting omitido:no-salio"
assert_contains "continua tras fallo de relanzamiento" "$OUT" "w9:inicio-falla restarting omitido:relanzamiento-fallo"
assert_not_contains "no informa otro cwd" "$OUT" "other-cwd"
assert_not_contains "no informa otro workspace" "$OUT" "other-workspace"
assert_contains "envia la salida declarada al pane que reiniciara" "$CALLS" "herdr <agent> <prompt> <w9:restart-listo> </exit>"
assert_contains "sondea el pane hasta encontrar su shell" "$CALLS" "herdr <pane> <process-info> <--pane> <w9:restart-listo>"
assert_contains "relanza con el nombre reportado, kind y pane" "$CALLS" "herdr <agent> <start> <restart-nombrado> <--kind> <restarting> <--pane> <w9:restart-listo>"
assert_contains "usa un nombre derivado del pane sin nombre" "$CALLS" "herdr <agent> <start> <mefisto-refresh-w9-sin-nombre> <--kind> <restarting> <--pane> <w9:sin-nombre>"
assert_not_contains "no relanza un pane que no salio" "$CALLS" "herdr <agent> <start> <mefisto-refresh-w9-sin-salida> <--kind> <restarting> <--pane> <w9:sin-salida>"
assert_contains "intenta el relanzamiento que falla" "$CALLS" "herdr <agent> <start> <restart-fallido> <--kind> <restarting> <--pane> <w9:inicio-falla>"

echo "[C] Neutralidad estatica"
REFRESH_BODY=$(extract_fn cmd_refresh_agents "$HERDR_SCRIPT")
assert_eq "bloque nuevo no nombra runtimes" "0" "$(printf '%s' "$REFRESH_BODY" | grep -ic 'claude')"
assert_eq "timeout no envia senales ni mata procesos" "0" "$(printf '%s' "$REFRESH_BODY" | grep -Eic '(^|[;&|[:space:]])(kill|pkill|killall)([[:space:]]|$)')"

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
