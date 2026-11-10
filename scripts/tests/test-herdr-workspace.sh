#!/usr/bin/env bash
# test-herdr-workspace.sh -- Funciones puras y montaje de filas de runtime
# mediante un stub determinista de herdr (issues #691, #875 y #958).

set -uo pipefail

# La suite compara argv literal: no debe heredar configuracion del checkout que
# la ejecuta.
unset MEFISTO_MODELS_FILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="$REPO_ROOT/scripts/herdr-workspace.sh"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[A] Funciones puras"
for fn in workspace_slug agent_name_for_role planner_agent_for_repo runtimes_for_repo; do
    body=$(extract_fn "$fn" "$TARGET")
    if [ -n "$body" ]; then
        eval "$body"
        pass "$fn se puede extraer y cargar"
    else
        fail "$fn no se pudo extraer"
    fi
done

[ "$(workspace_slug 'Bitakora.ControlAsistencia')" = "bitakora-controlasis" ] \
    && pass "workspace_slug conserva su contrato" \
    || fail "workspace_slug cambio su contrato"
name=$(agent_name_for_role ejecucion eda-evsourcing-azure-harness claude)
[ "$name" = "ejecucion-eda-evsour-48cc-claude" ] && [ "${#name}" -le 32 ] \
    && pass "agent_name_for_role recorta con hash y respeta el tope de 32 caracteres" \
    || fail "agent_name_for_role produjo un nombre inesperado: $name"

# Anti-colision (issue #2502)
[ "$(agent_name_for_role ejecucion Cosmos.ControlPlane claude)" = "ejecucion-cosmos-con-a31e-claude" ] \
    && [ "$(agent_name_for_role ejecucion Cosmos.ControlPlane fake)" = "ejecucion-cosmos-contr-a31e-fake" ] \
    && [ "$(agent_name_for_role ejecucion Cosmos.ControlPlane.Front claude)" = "ejecucion-cosmos-con-365f-claude" ] \
    && [ "$(agent_name_for_role ejecucion Cosmos.ControlPlane.Front fake)" = "ejecucion-cosmos-contr-365f-fake" ] \
    && pass "CA-1: slug recortado agrega hash del label (nombres exactos)" \
    || fail "CA-1: nombres con hash inesperados"
collision_ok=1
for rol in planner ejecucion; do
    for kind in claude fake; do
        a=$(agent_name_for_role "$rol" Cosmos.ControlPlane "$kind")
        b=$(agent_name_for_role "$rol" Cosmos.ControlPlane.Front "$kind")
        a2=$(agent_name_for_role "$rol" Cosmos.ControlPlane "$kind")
        [ "$a" != "$b" ] && [ "$a" = "$a2" ] || collision_ok=0
        [[ "$a" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] && [[ "$b" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || collision_ok=0
    done
done
[ "$collision_ok" = 1 ] \
    && pass "CA-2: labels con prefijo comun producen nombres distintos, validos y deterministas" \
    || fail "CA-2: colision, no determinismo o nombre invalido"
[ "$(agent_name_for_role ejecucion Bitakora claude)" = "ejecucion-bitakora-claude" ] \
    && [ "$(agent_name_for_role ejecucion Bitakora fake)" = "ejecucion-bitakora-fake" ] \
    && [ "$(agent_name_for_role planner Cosmos.ControlPlane.Front '')" = "planner-cosmos-controlplane" ] \
    && [ "$(agent_name_for_role planner Bitakora '')" = "planner-bitakora" ] \
    && pass "CA-3: label corto y formato legacy sin kind conservan su nombre" \
    || fail "CA-3: nombre sin colision cambio"

unset MEFISTO_RUNTIMES MEFISTO_RUNTIME
[ "$(runtimes_for_repo mefisto-planner)" = "claude" ] \
    && pass "default de Mefisto: claude" \
    || fail "default de Mefisto inesperado: $(runtimes_for_repo mefisto-planner)"
MEFISTO_RUNTIME=codex
export MEFISTO_RUNTIME
[ "$(runtimes_for_repo mefisto-planner)" = "codex" ] \
    && pass "MEFISTO_RUNTIME produce una lista de un elemento" \
    || fail "MEFISTO_RUNTIME no produjo un elemento"
MEFISTO_RUNTIMES=' fake, claude ,fake,, codex, claude '
export MEFISTO_RUNTIMES
[ "$(runtimes_for_repo mefisto-planner)" = $'fake\nclaude\ncodex' ] \
    && pass "MEFISTO_RUNTIMES recorta, descarta vacios y colapsa duplicados" \
    || fail "normalizacion inesperada: $(runtimes_for_repo mefisto-planner)"
[ "$(runtimes_for_repo mefisto:planner)" = "claude" ] \
    && pass "consumidor ignora ambas variables y conserva la fila claude" \
    || fail "el consumidor leyo configuracion de runtimes"
MEFISTO_RUNTIMES=''
export MEFISTO_RUNTIMES
[ -z "$(runtimes_for_repo mefisto-planner)" ] \
    && pass "MEFISTO_RUNTIMES definida vacia conserva precedencia" \
    || fail "MEFISTO_RUNTIMES vacia cayo en MEFISTO_RUNTIME"
unset MEFISTO_RUNTIMES MEFISTO_RUNTIME

FAKE_MEFISTO="$TMP/fake-mefisto-repo"
FAKE_CONSUMER="$TMP/fake consumer repo"
FAKE_LEGACY_CONSUMER="$TMP/fake legacy consumer repo"
FAKE_UNCONFIGURED_CONSUMER="$TMP/fake unconfigured consumer repo"
FAKE_WORKTREE="$TMP/fake consumer worktree"
FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_MEFISTO/.claude-plugin" "$FAKE_CONSUMER/.mefisto" \
    "$FAKE_LEGACY_CONSUMER/.claude" "$FAKE_UNCONFIGURED_CONSUMER" "$FAKE_BIN"
printf '{}\n' > "$FAKE_MEFISTO/.claude-plugin/plugin.json"
printf '{}\n' > "$FAKE_CONSUMER/.mefisto/harness.config.json"
printf '{}\n' > "$FAKE_LEGACY_CONSUMER/.claude/harness.config.json"
(cd "$FAKE_MEFISTO" && git init -q && git -c user.email=test@example.com -c user.name=Test commit --allow-empty -q -m inicial)
(cd "$FAKE_CONSUMER" && git init -q && git -c user.email=test@example.com -c user.name=Test commit --allow-empty -q -m inicial)
(cd "$FAKE_LEGACY_CONSUMER" && git init -q && git -c user.email=test@example.com -c user.name=Test commit --allow-empty -q -m inicial)
(cd "$FAKE_UNCONFIGURED_CONSUMER" && git init -q && git -c user.email=test@example.com -c user.name=Test commit --allow-empty -q -m inicial)
git -C "$FAKE_CONSUMER" worktree add -q -b fixture-worktree "$FAKE_WORKTREE"
FAKE_MEFISTO=$(cd "$FAKE_MEFISTO" && pwd -P)
FAKE_CONSUMER=$(cd "$FAKE_CONSUMER" && pwd -P)
FAKE_LEGACY_CONSUMER=$(cd "$FAKE_LEGACY_CONSUMER" && pwd -P)
FAKE_UNCONFIGURED_CONSUMER=$(cd "$FAKE_UNCONFIGURED_CONSUMER" && pwd -P)
FAKE_WORKTREE=$(cd "$FAKE_WORKTREE" && pwd -P)

cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
set -u
echo "herdr $*" >> "$HERDR_STUB_LOG"

option_value() {
    local wanted="$1"
    shift
    while [ "$#" -gt 0 ]; do
        if [ "$1" = "$wanted" ]; then
            [ "$#" -gt 1 ] || return 1
            printf '%s\n' "$2"
            return 0
        fi
        shift
    done
    return 1
}

if [ -n "${HERDR_STUB_EXPECT_CWD:-}" ] \
    && { [ "${1:-} ${2:-}" = "workspace create" ] || [ "${1:-} ${2:-}" = "pane split" ]; }; then
    actual_cwd=$(option_value --cwd "$@")
    if [ "$actual_cwd" != "$HERDR_STUB_EXPECT_CWD" ]; then
        printf 'cwd recibido como argv distinto: <%s>\n' "$actual_cwd" >&2
        exit 64
    fi
fi
case "${1:-} ${2:-}" in
    "status server") exit 0 ;;
    "workspace list")
        if [ -n "${HERDR_STUB_EXISTING_LABEL:-}" ]; then
            second=""
            [ -n "${HERDR_STUB_SECOND_WS:-}" ] \
                && second=$(printf ',{"workspace_id":"w2","label":"%s"}' "$HERDR_STUB_EXISTING_LABEL")
            printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"%s"}%s]}}\n' "$HERDR_STUB_EXISTING_LABEL" "$second"
        else
            echo '{"result":{"workspaces":[]}}'
        fi
        ;;
    "workspace create")
        echo '{"result":{"workspace":{"workspace_id":"w1"},"root_pane":{"pane_id":"w1:p1"}}}'
        ;;
    "pane split")
        if [ -n "${HERDR_STUB_FAIL_SPLIT:-}" ]; then
            echo '{"error":"split rechazado"}' >&2
            exit 73
        fi
        n=$(cat "$HERDR_STUB_SPLIT_COUNTER")
        echo $((n + 1)) > "$HERDR_STUB_SPLIT_COUNTER"
        printf '{"result":{"pane":{"pane_id":"w1:p%s"}}}\n' "$n"
        ;;
    "pane list")
        printf '{"result":{"panes":['
        first=1
        items=()
        list_ws=$(option_value --workspace "$@" || true)
        if [ "$list_ws" = "w2" ]; then
            IFS=';' read -ra items <<< "${HERDR_STUB_PANES_W2:-}"
        else
            IFS=';' read -ra items <<< "${HERDR_STUB_PANES:-}"
        fi
        for item in "${items[@]+"${items[@]}"}"; do
            [ -n "$item" ] || continue
            label="${item%%=*}"
            pane="${item#*=}"
            [ "$first" -eq 1 ] || printf ','
            first=0
            printf '{"pane_id":"%s","label":"%s"}' "$pane" "$label"
        done
        echo ']}}'
        ;;
    "pane process-info")
        echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":100}}}'
        ;;
    "agent start")
        kind=$(option_value --kind "$@" || true)
        if [ -n "${HERDR_STUB_FAIL_KIND:-}" ] && [ "$kind" = "$HERDR_STUB_FAIL_KIND" ]; then
            printf '{"error":"runtime %s ausente"}\n' "$kind" >&2
            exit 72
        fi
        echo '{"result":{"type":"ok"}}'
        ;;
    "agent get") exit 1 ;;
    *) echo '{"result":{"type":"ok"}}' ;;
esac
STUB
chmod +x "$FAKE_BIN/herdr"

HERDR_STUB_LOG="$TMP/herdr.log"
HERDR_STUB_SPLIT_COUNTER="$TMP/split-counter"
export HERDR_STUB_LOG HERDR_STUB_SPLIT_COUNTER MEFISTO_AGENT_START_RETRY_PAUSE=0
LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

run_workspace() {
    local repo="$1" split_start="${2:-2}"
    : > "$HERDR_STUB_LOG"
    printf '%s\n' "$split_start" > "$HERDR_STUB_SPLIT_COUNTER"
    PATH="$FAKE_BIN:$PATH" "$TARGET" "$repo" >"$TMP/stdout" 2>"$TMP/stderr"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$TMP/stdout")
    LAST_STDERR=$(cat "$TMP/stderr")
}

assert_no_anchor_protocol() {
    local block="$1"
    if grep -qE 'pane close|pane rename .*fila libre' "$HERDR_STUB_LOG"; then
        fail "$block: aparecio el protocolo de ancla: $(cat "$HERDR_STUB_LOG")"
    else
        pass "$block: no usa pane close ni fila libre"
    fi
}

echo ""
echo "[B] Workspace nuevo de Mefisto: default de una fila"
unset MEFISTO_RUNTIMES MEFISTO_RUNTIME HERDR_STUB_EXISTING_LABEL HERDR_STUB_PANES
run_workspace "$FAKE_MEFISTO"
EXPECTED=$(cat <<EOF
herdr status server
herdr workspace list
herdr workspace create --cwd $FAKE_MEFISTO --label fake-mefisto-repo --env MEFISTO_RUNTIME=claude
herdr pane split --pane w1:p1 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude
herdr pane rename w1:p1 planner [claude]
herdr pane rename w1:p2 ejecucion [claude]
herdr pane process-info --pane w1:p1
herdr agent start planner-fake-mefis-92c3-claude --kind claude --pane w1:p1 --timeout 90000 -- --agent mefisto-planner
herdr pane process-info --pane w1:p2
herdr agent start ejecucion-fake-mefis-92c3-claude --kind claude --pane w1:p2 --timeout 90000
EOF
)
[ "$LAST_RC" -eq 0 ] && pass "B-1: monta la fila sin abortar" || fail "B-1: rc=$LAST_RC, stderr=$LAST_STDERR"
[ "$(cat "$HERDR_STUB_LOG")" = "$EXPECTED" ] \
    && pass "B-2: una fila tiene cero splits down y conserva --env/--kind" \
    || fail "B-2: log inesperado. Esperado:\n$EXPECTED\nObtenido:\n$(cat "$HERDR_STUB_LOG")"
assert_no_anchor_protocol B-3
export MEFISTO_RUNTIMES=claude
run_workspace "$FAKE_MEFISTO"
unset MEFISTO_RUNTIMES
[ "$(cat "$HERDR_STUB_LOG")" = "$EXPECTED" ] \
    && pass "B-4: MEFISTO_RUNTIMES=claude monta lo mismo que el default" \
    || fail "B-4: log inesperado. Esperado:\n$EXPECTED\nObtenido:\n$(cat "$HERDR_STUB_LOG")"

echo ""
echo "[C] Workspace nuevo de Mefisto: dos runtimes, orden byte a byte"
export MEFISTO_RUNTIMES=claude,fake
run_workspace "$FAKE_MEFISTO"
unset MEFISTO_RUNTIMES
EXPECTED=$(cat <<EOF
herdr status server
herdr workspace list
herdr workspace create --cwd $FAKE_MEFISTO --label fake-mefisto-repo --env MEFISTO_RUNTIME=claude
herdr pane split --pane w1:p1 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=fake
herdr pane split --pane w1:p1 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude
herdr pane split --pane w1:p2 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=fake
herdr pane rename w1:p1 planner [claude]
herdr pane rename w1:p3 ejecucion [claude]
herdr pane process-info --pane w1:p1
herdr agent start planner-fake-mefis-92c3-claude --kind claude --pane w1:p1 --timeout 90000 -- --agent mefisto-planner
herdr pane process-info --pane w1:p3
herdr agent start ejecucion-fake-mefis-92c3-claude --kind claude --pane w1:p3 --timeout 90000
herdr pane rename w1:p2 planner [fake]
herdr pane rename w1:p4 ejecucion [fake]
herdr pane process-info --pane w1:p2
herdr agent start planner-fake-mefisto-repo-fake --kind fake --pane w1:p2 --timeout 90000 -- --agent mefisto-planner
herdr pane process-info --pane w1:p4
herdr agent start ejecucion-fake-mefisto-repo-fake --kind fake --pane w1:p4 --timeout 90000
EOF
)
[ "$LAST_RC" -eq 0 ] && pass "C-1: monta dos filas sin abortar" || fail "C-1: rc=$LAST_RC, stderr=$LAST_STDERR"
[ "$(cat "$HERDR_STUB_LOG")" = "$EXPECTED" ] \
    && pass "C-2: downs antes de rights y argumentos exactos" \
    || fail "C-2: log inesperado. Esperado:\n$EXPECTED\nObtenido:\n$(cat "$HERDR_STUB_LOG")"
assert_no_anchor_protocol C-3

echo ""
echo "[C2] Workspace nuevo de Mefisto: tres runtimes"
export MEFISTO_RUNTIMES=claude,fake,codex
run_workspace "$FAKE_MEFISTO"
unset MEFISTO_RUNTIMES
DOWNS=$(grep -F ' --direction down ' "$HERDR_STUB_LOG")
EXPECTED_DOWNS=$(cat <<EOF
herdr pane split --pane w1:p1 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=codex
herdr pane split --pane w1:p1 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=fake
EOF
)
[ "$DOWNS" = "$EXPECTED_DOWNS" ] \
    && pass "C2-1: los down recorren tres runtimes en orden inverso" \
    || fail "C2-1: orden de down inesperado: $DOWNS"
FIRST_RIGHT_LINE=$(grep -nF ' --direction right ' "$HERDR_STUB_LOG" | cut -d: -f1 | head -1)
LAST_DOWN_LINE=$(grep -nF ' --direction down ' "$HERDR_STUB_LOG" | cut -d: -f1 | tail -1)
[ "$LAST_DOWN_LINE" -lt "$FIRST_RIGHT_LINE" ] \
    && pass "C2-2: todos los down ocurren antes de cualquier right" \
    || fail "C2-2: un right ocurrio antes de terminar los down"
grep -qxF 'herdr pane rename w1:p1 planner [claude]' "$HERDR_STUB_LOG" \
    && grep -qxF 'herdr pane rename w1:p3 planner [fake]' "$HERDR_STUB_LOG" \
    && grep -qxF 'herdr pane rename w1:p2 planner [codex]' "$HERDR_STUB_LOG" \
    && pass "C2-3: las tres filas quedan asociadas al kind correcto" \
    || fail "C2-3: labels inesperados: $(cat "$HERDR_STUB_LOG")"
assert_no_anchor_protocol C2-4

echo ""
echo "[D] Workspace existente con todas las filas: solo focus"
export HERDR_STUB_EXISTING_LABEL=fake-mefisto-repo
export HERDR_STUB_PANES='planner [claude]=w1:p1;ejecucion [claude]=w1:p3;planner [fake]=w1:p2;ejecucion [fake]=w1:p4'
export MEFISTO_RUNTIMES=claude,fake
run_workspace "$FAKE_MEFISTO" 5
unset HERDR_STUB_EXISTING_LABEL HERDR_STUB_PANES MEFISTO_RUNTIMES
grep -qxF 'herdr workspace focus w1' "$HERDR_STUB_LOG" \
    && pass "D-1: enfoca el workspace existente" \
    || fail "D-1: no enfoco: $(cat "$HERDR_STUB_LOG")"
if grep -qE 'pane split|pane rename|agent start' "$HERDR_STUB_LOG"; then
    fail "D-2: modifico filas ya presentes: $(cat "$HERDR_STUB_LOG")"
else
    pass "D-2: no hace split, rename ni agent start"
fi
assert_no_anchor_protocol D-3

echo ""
echo "[E] Workspace existente con una fila faltante: toca solo la fila nueva"
export HERDR_STUB_EXISTING_LABEL=fake-mefisto-repo
export HERDR_STUB_PANES='planner [claude]=w1:p1;ejecucion [claude]=w1:p3'
export MEFISTO_RUNTIMES=claude,fake
run_workspace "$FAKE_MEFISTO" 4
unset HERDR_STUB_EXISTING_LABEL HERDR_STUB_PANES MEFISTO_RUNTIMES
grep -qxF "herdr pane split --pane w1:p1 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=fake" "$HERDR_STUB_LOG" \
    && grep -qxF "herdr pane split --pane w1:p4 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=fake" "$HERDR_STUB_LOG" \
    && pass "E-1: monta la faltante desde el ultimo planner existente" \
    || fail "E-1: splits inesperados: $(cat "$HERDR_STUB_LOG")"
if grep -qE 'rename w1:p1|rename w1:p3|agent start .*claude' "$HERDR_STUB_LOG"; then
    fail "E-2: toco la fila claude existente: $(cat "$HERDR_STUB_LOG")"
else
    pass "E-2: la fila existente no recibe rename ni agent start"
fi
grep -qxF 'herdr pane rename w1:p4 planner [fake]' "$HERDR_STUB_LOG" \
    && grep -qxF 'herdr pane rename w1:p5 ejecucion [fake]' "$HERDR_STUB_LOG" \
    && pass "E-3: etiqueta solo los panes nuevos" \
    || fail "E-3: labels inesperados: $(cat "$HERDR_STUB_LOG")"
assert_no_anchor_protocol E-4

echo ""
echo "[F] Workspace existente con una lista disjunta: monta desde el ultimo planner disponible"
export HERDR_STUB_EXISTING_LABEL=fake-mefisto-repo
export HERDR_STUB_PANES='planner [codex]=w1:p7;ejecucion [codex]=w1:p8'
export MEFISTO_RUNTIMES=claude
run_workspace "$FAKE_MEFISTO" 9
unset HERDR_STUB_EXISTING_LABEL HERDR_STUB_PANES MEFISTO_RUNTIMES
grep -qxF "herdr pane split --pane w1:p7 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && grep -qxF "herdr pane split --pane w1:p9 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && pass "F-1: monta la fila pedida aunque ninguna configurada existiera antes" \
    || fail "F-1: no monto desde el planner disponible: $(cat "$HERDR_STUB_LOG")"
if grep -qE 'rename w1:p7|rename w1:p8|agent start .*codex' "$HERDR_STUB_LOG"; then
    fail "F-2: toco la fila codex existente: $(cat "$HERDR_STUB_LOG")"
else
    pass "F-2: no modifica la fila usada como base"
fi
assert_no_anchor_protocol F-3

echo ""
echo "[G] Preflight de configuracion del consumidor"
run_workspace "$FAKE_CONSUMER"
if [ "$LAST_RC" -eq 0 ] \
    && ! printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq 'parece no estar onboardeado' \
    && grep -qxF "herdr workspace create --cwd $FAKE_CONSUMER --label fake consumer repo --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && grep -qxF 'herdr pane rename w1:p1 planner [claude]' "$HERDR_STUB_LOG"; then
    pass "G-1: el config canonico abre la fila sin warning de onboarding"
else
    fail "G-1: el config canonico emitio warning o aborto: $LAST_STDOUT$LAST_STDERR"
fi
run_workspace "$FAKE_LEGACY_CONSUMER"
if [ "$LAST_RC" -eq 0 ] \
    && ! printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq 'parece no estar onboardeado' \
    && grep -qxF "herdr workspace create --cwd $FAKE_LEGACY_CONSUMER --label fake legacy consumer repo --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && grep -qxF 'herdr pane rename w1:p1 planner [claude]' "$HERDR_STUB_LOG"; then
    pass "G-2: el config legacy conserva el fallback y abre la fila sin warning"
else
    fail "G-2: el config legacy emitio warning o aborto: $LAST_STDOUT$LAST_STDERR"
fi
run_workspace "$FAKE_UNCONFIGURED_CONSUMER"
if [ "$LAST_RC" -eq 0 ] \
    && printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq '.mefisto/harness.config.json ni el fallback legacy .claude/harness.config.json' \
    && ! printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq 'pipelines fallaran' \
    && grep -qF "workspace create --cwd $FAKE_UNCONFIGURED_CONSUMER" "$HERDR_STUB_LOG" \
    && [ ! -e "$FAKE_UNCONFIGURED_CONSUMER/.mefisto/harness.config.json" ] \
    && [ ! -e "$FAKE_UNCONFIGURED_CONSUMER/.claude/harness.config.json" ]; then
    pass "G-3: sin config avisa rutas canonica y legacy, abre sin modificar el consumidor"
else
    fail "G-3: preflight ausente no fue no bloqueante o modifico el consumidor: $LAST_STDOUT$LAST_STDERR"
fi

echo ""
echo "[H] Consumidor nuevo: una fila claude y path con espacios"
export MEFISTO_RUNTIME=fake MEFISTO_RUNTIMES=claude,fake
export HERDR_STUB_EXPECT_CWD="$FAKE_CONSUMER"
run_workspace "$FAKE_CONSUMER"
unset MEFISTO_RUNTIME MEFISTO_RUNTIMES HERDR_STUB_EXPECT_CWD
EXPECTED=$(cat <<EOF
herdr status server
herdr workspace list
herdr workspace create --cwd $FAKE_CONSUMER --label fake consumer repo --env MEFISTO_RUNTIME=claude
herdr pane split --pane w1:p1 --direction right --cwd $FAKE_CONSUMER --no-focus --env MEFISTO_RUNTIME=claude
herdr pane rename w1:p1 planner [claude]
herdr pane rename w1:p2 ejecucion [claude]
herdr pane process-info --pane w1:p1
herdr agent start planner-fake-consu-ec20-claude --kind claude --pane w1:p1 --timeout 90000 -- --agent mefisto:planner
herdr pane process-info --pane w1:p2
herdr agent start ejecucion-fake-consu-ec20-claude --kind claude --pane w1:p2 --timeout 90000
EOF
)
[ "$LAST_RC" -eq 0 ] && [ "$(cat "$HERDR_STUB_LOG")" = "$EXPECTED" ] \
    && pass "H-1: fila claude con labels, nombres, kind y env exactos, sin leer MEFISTO_RUNTIME(S)" \
    || fail "H-1: rama consumidor cambio. Esperado:\n$EXPECTED\nObtenido:\n$(cat "$HERDR_STUB_LOG")"
assert_no_anchor_protocol H-2

export HERDR_STUB_EXPECT_CWD="$FAKE_WORKTREE"
run_workspace "$FAKE_WORKTREE"
unset HERDR_STUB_EXPECT_CWD
[ "$LAST_RC" -eq 0 ] \
    && grep -qF "workspace create --cwd $FAKE_WORKTREE" "$HERDR_STUB_LOG" \
    && ! grep -qF -- "--cwd $FAKE_CONSUMER" "$HERDR_STUB_LOG" \
    && pass "H-3: un worktree usa su propio Git toplevel argv-safe" \
    || fail "H-3: worktree resuelto a otra raiz: $(cat "$HERDR_STUB_LOG")"

echo ""
echo "[J] Consumidor legacy: normaliza la fila claude y converge"
export HERDR_STUB_EXISTING_LABEL='fake consumer repo'
export HERDR_STUB_PANES='planner=w1:p1'
run_workspace "$FAKE_CONSUMER"
grep -qxF 'herdr pane rename w1:p1 planner [claude]' "$HERDR_STUB_LOG" \
    && ! grep -qE 'pane split|agent start|pane close' "$HERDR_STUB_LOG" \
    && pass "J-1: normaliza el planner legacy sin reconstruir el layout" \
    || fail "J-1: transicion legacy inesperada: $(cat "$HERDR_STUB_LOG")"
export HERDR_STUB_PANES='planner=w1:p1;planner [claude]=w1:p3;ejecucion=w1:p2'
run_workspace "$FAKE_CONSUMER"
! grep -qE 'pane rename|pane split|agent start|pane close' "$HERDR_STUB_LOG" \
    && printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -q 'duplicados o ambiguos' \
    && pass "J-2: un workspace legacy ambiguo solo enfoca" \
    || fail "J-2: ambiguedad no conservadora: $(cat "$HERDR_STUB_LOG")"
export HERDR_STUB_PANES='planner [claude]=w1:p1;ejecucion [claude]=w1:p2;planner [fake]=w1:p3;ejecucion [fake]=w1:p4'
run_workspace "$FAKE_CONSUMER"
FIRST_LOG=$(cat "$HERDR_STUB_LOG")
run_workspace "$FAKE_CONSUMER"
SECOND_LOG=$(cat "$HERDR_STUB_LOG")
unset HERDR_STUB_EXISTING_LABEL HERDR_STUB_PANES
[ "$SECOND_LOG" = "$FIRST_LOG" ] \
    && grep -qxF 'herdr workspace focus w1' <<< "$SECOND_LOG" \
    && ! grep -qE 'pane rename|pane split|agent start|pane close' <<< "$SECOND_LOG" \
    && pass "J-3: la fila normalizada solo enfoca byte a byte y no toca la fila de otro runtime" \
    || fail "J-3: normalizado no converge: $SECOND_LOG"

echo ""
echo "[L] Fallo aislado al iniciar un runtime"
export MEFISTO_RUNTIMES=claude,fake
export HERDR_STUB_FAIL_KIND=fake
run_workspace "$FAKE_MEFISTO"
unset HERDR_STUB_FAIL_KIND MEFISTO_RUNTIMES
[ "$(grep -c 'agent start .*--kind claude' "$HERDR_STUB_LOG")" -eq 2 ] \
    && [ "$(grep -c 'agent start .*--kind fake' "$HERDR_STUB_LOG")" -eq 4 ] \
    && grep -q 'El pane quedo con su shell' <<< "$LAST_STDOUT" \
    && grep -qxF 'herdr pane rename w1:p2 planner [fake]' "$HERDR_STUB_LOG" \
    && grep -qxF 'herdr pane rename w1:p4 ejecucion [fake]' "$HERDR_STUB_LOG" \
    && pass "L-1: cada pane del runtime que falla conserva shell sin cerrar ni reiniciar la otra fila" \
    || fail "L-1: el fallo de un runtime contamino otra fila: $(cat "$HERDR_STUB_LOG") $LAST_STDOUT$LAST_STDERR"
assert_no_anchor_protocol L-2

echo ""
echo "[M] Copia distribuida"
cmp -s "$REPO_ROOT/dist/claude/scripts/herdr-workspace.sh" "$TARGET" \
    && pass "M-1: dist/claude contiene el script fuente" \
    || fail "M-1: dist/claude diverge del script fuente"

echo ""
echo "[N] Workspace del repo sin panes de Mefisto: se adopta y se montan las filas (issue #2493)"
unset MEFISTO_RUNTIMES MEFISTO_RUNTIME
export HERDR_STUB_EXISTING_LABEL='fake consumer repo'
export HERDR_STUB_PANES='=w1:p1'
run_workspace "$FAKE_CONSUMER"
[ "$LAST_RC" -eq 0 ] \
    && grep -qxF "herdr pane split --pane w1:p1 --direction down --cwd $FAKE_CONSUMER --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && grep -qxF "herdr pane split --pane w1:p2 --direction right --cwd $FAKE_CONSUMER --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && [ "$(grep -c -- '--direction down' "$HERDR_STUB_LOG")" -eq 1 ] \
    && [ "$(grep -c -- '--direction right' "$HERDR_STUB_LOG")" -eq 1 ] \
    && pass "N-1: consumidor, monta la fila con down desde la raiz y right desde su planner" \
    || fail "N-1: splits inesperados: $(cat "$HERDR_STUB_LOG") $LAST_STDOUT$LAST_STDERR"
grep -qxF 'herdr pane rename w1:p2 planner [claude]' "$HERDR_STUB_LOG" \
    && grep -qxF 'herdr pane rename w1:p3 ejecucion [claude]' "$HERDR_STUB_LOG" \
    && grep -qF 'herdr agent start planner-fake-consu-ec20-claude --kind claude --pane w1:p2 --timeout 90000 -- --agent mefisto:planner' "$HERDR_STUB_LOG" \
    && grep -qF 'herdr agent start ejecucion-fake-consu-ec20-claude --kind claude --pane w1:p3 ' "$HERDR_STUB_LOG" \
    && [ "$(grep -c 'agent start' "$HERDR_STUB_LOG")" -eq 2 ] \
    && pass "N-2: etiqueta y arranca los dos panes nuevos" \
    || fail "N-2: labels o agentes inesperados: $(cat "$HERDR_STUB_LOG")"
if grep -qE 'pane rename w1:p1( |$)|--pane w1:p1 --timeout|pane split --pane w1:p1 --direction right' "$HERDR_STUB_LOG"; then
    fail "N-3: toco el pane raiz: $(cat "$HERDR_STUB_LOG")"
else
    pass "N-3: el pane raiz queda intacto (sin rename ni agent start)"
fi
printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq "no tenia panes de Mefisto: se montaron 1 fila(s) debajo del pane raiz." \
    && grep -qxF 'herdr workspace focus w1' "$HERDR_STUB_LOG" \
    && ! printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq 'no contiene' \
    && pass "N-4: enfoca y avisa la adopcion" \
    || fail "N-4: mensaje de adopcion ausente: $LAST_STDOUT$LAST_STDERR"
assert_no_anchor_protocol N-5

export HERDR_STUB_EXISTING_LABEL=fake-mefisto-repo
export MEFISTO_RUNTIMES=claude,fake
run_workspace "$FAKE_MEFISTO"
unset MEFISTO_RUNTIMES
[ "$LAST_RC" -eq 0 ] \
    && grep -qxF "herdr pane split --pane w1:p1 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=fake" "$HERDR_STUB_LOG" \
    && grep -qxF "herdr pane split --pane w1:p1 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && grep -qxF "herdr pane split --pane w1:p3 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && grep -qxF "herdr pane split --pane w1:p2 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=fake" "$HERDR_STUB_LOG" \
    && grep -qF 'herdr agent start planner-fake-mefis-92c3-claude --kind claude --pane w1:p3 --timeout 90000 -- --agent mefisto-planner' "$HERDR_STUB_LOG" \
    && [ "$(grep -c 'agent start' "$HERDR_STUB_LOG")" -eq 4 ] \
    && ! grep -qE 'pane rename w1:p1( |$)|--pane w1:p1 --timeout' "$HERDR_STUB_LOG" \
    && ! printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq 'no contiene ningun planner' \
    && printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq "se montaron 2 fila(s) debajo del pane raiz." \
    && pass "N-6: repo de Mefisto, monta las filas de runtimes_for_repo bajo la raiz sin tocarla" \
    || fail "N-6: adopcion en Mefisto inesperada: $(cat "$HERDR_STUB_LOG") $LAST_STDOUT$LAST_STDERR"
LAST_DOWN_LINE=$(grep -nF ' --direction down ' "$HERDR_STUB_LOG" | cut -d: -f1 | tail -1)
FIRST_RIGHT_LINE=$(grep -nF ' --direction right ' "$HERDR_STUB_LOG" | cut -d: -f1 | head -1)
[ "$LAST_DOWN_LINE" -lt "$FIRST_RIGHT_LINE" ] \
    && pass "N-7: todos los down ocurren antes de cualquier right" \
    || fail "N-7: un right ocurrio antes de terminar los down"

run_workspace "$FAKE_MEFISTO"
grep -qxF "herdr pane split --pane w1:p1 --direction down --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && grep -qxF "herdr pane split --pane w1:p2 --direction right --cwd $FAKE_MEFISTO --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && ! grep -qE 'pane rename w1:p1( |$)' "$HERDR_STUB_LOG" \
    && pass "N-8: con el default de una fila tambien se monta debajo de la raiz" \
    || fail "N-8: una fila adoptada inesperada: $(cat "$HERDR_STUB_LOG")"

export HERDR_STUB_EXISTING_LABEL='fake consumer repo'
export HERDR_STUB_PANES='[ok] mefisto-tooling #12=w1:p1;=w1:p2'
run_workspace "$FAKE_CONSUMER"
grep -qxF "herdr pane split --pane w1:p1 --direction down --cwd $FAKE_CONSUMER --no-focus --env MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" \
    && ! grep -qE 'pane rename w1:p1( |$)' "$HERDR_STUB_LOG" \
    && pass "N-9: un workspace solo con visores se adopta" \
    || fail "N-9: visores tratados como panes de rol: $(cat "$HERDR_STUB_LOG")"

export HERDR_STUB_PANES='=w1:p1'
export HERDR_STUB_FAIL_SPLIT=1
run_workspace "$FAKE_CONSUMER"
unset HERDR_STUB_FAIL_SPLIT
[ "$LAST_RC" -eq 0 ] \
    && ! grep -qE 'pane rename|agent start' "$HERDR_STUB_LOG" \
    && printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq 'no se pudo montar ninguna fila debajo del pane raiz' \
    && ! printf '%s\n%s\n' "$LAST_STDOUT" "$LAST_STDERR" | grep -Fq 'se montaron 0 fila(s)' \
    && pass "N-10: si ningun split prospera, avisa en vez de reportar exito" \
    || fail "N-10: adopcion fallida reportada como exito: $(cat "$HERDR_STUB_LOG") $LAST_STDOUT$LAST_STDERR"

echo ""
echo "[N2] Dos workspaces con el mismo label: se prefiere el que tiene filas de Mefisto"
export HERDR_STUB_SECOND_WS=1
export HERDR_STUB_PANES='=w1:p1'
export HERDR_STUB_PANES_W2='planner [claude]=w2:p1;ejecucion [claude]=w2:p2'
run_workspace "$FAKE_CONSUMER"
[ "$LAST_RC" -eq 0 ] \
    && grep -qxF 'herdr workspace focus w2' "$HERDR_STUB_LOG" \
    && ! grep -qE 'pane split|pane rename|agent start|workspace focus w1' "$HERDR_STUB_LOG" \
    && pass "N2-1: enfoca el workspace con filas y no monta nada nuevo" \
    || fail "N2-1: eligio el workspace equivocado o duplico filas: $(cat "$HERDR_STUB_LOG")"
unset HERDR_STUB_SECOND_WS HERDR_STUB_PANES_W2

echo ""
echo "[N3] Workspaces con panes de rol conservan su comportamiento"
export HERDR_STUB_PANES='planner=w1:p1'
run_workspace "$FAKE_CONSUMER"
grep -qxF 'herdr pane rename w1:p1 planner [claude]' "$HERDR_STUB_LOG" \
    && ! grep -qE 'pane split|agent start' "$HERDR_STUB_LOG" \
    && pass "N3-1: legacy se normaliza sin montar filas" \
    || fail "N3-1: comportamiento legacy cambio: $(cat "$HERDR_STUB_LOG")"
export HERDR_STUB_PANES='planner [claude]=w1:p1;ejecucion [claude]=w1:p3'
run_workspace "$FAKE_CONSUMER" 4
grep -qxF 'herdr workspace focus w1' "$HERDR_STUB_LOG" \
    && ! grep -qE 'pane split|pane rename|agent start' "$HERDR_STUB_LOG" \
    && pass "N3-2: una fila canonica solo se enfoca" \
    || fail "N3-2: la fila canonica no quedo intacta: $(cat "$HERDR_STUB_LOG")"
unset HERDR_STUB_EXISTING_LABEL HERDR_STUB_PANES

echo ""
echo "[Z] Protocolo retirado del script"
if grep -qE 'mount_second_row|pane close|fila libre' "$TARGET"; then
    fail "Z-1: el script aun contiene referencias al protocolo de ancla"
else
    pass "Z-1: no quedan cierres, busquedas, renames ni menciones al ancla"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
