#!/usr/bin/env bash
# test-batch-dependency-skip.sh -- Gate de dependencias por eslabon del batch
# interno (issue #2478): un issue que depende de uno fallido/saltado en el mismo
# batch no se lanza y queda `saltado: depende de #N (<motivo>)`.
#
# Cubre:
#   [pre] Script existe y tiene sintaxis valida.
#   [A]   Batch A B C D; B y C dependen de A; D es independiente; A falla.
#         El pipeline nunca se invoca para B ni C (si para A y D); B y C quedan
#         `saltado: depende de #A (fallido en este batch)` en el JSON de estado;
#         el salto cuenta en FAILED, no cambia el exit por si solo (A ya lo hace
#         fallar) y el resumen lista la linea de relanzamiento en orden.
#   [B]   Dependencia completada en este batch con el issue aun OPEN en GitHub:
#         el dependiente SI se lanza.
#   [C]   Dependencia fuera del batch OPEN en GitHub: `saltado ... (OPEN)`,
#         y un salto por si solo no deja el batch en `failed` ni exit 1.
#   [D]   Dependencia fallida en este batch pero CLOSED en GitHub (fallo tras
#         el merge): satisfecha, el dependiente SI se lanza (CA-1).
#
# Uso: .claude/scripts/tests/test-batch-dependency-skip.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CANON_BATCH="$REPO_ROOT/src/internal/scripts/mefisto-batch-pipeline.sh"
LIBS="$REPO_ROOT/src/internal/scripts/lib"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[pre] mefisto-batch-pipeline.sh existe y tiene sintaxis valida"
[ -x "$CANON_BATCH" ] && pass "existe y es ejecutable" || fail "no existe o no es ejecutable"
bash -n "$CANON_BATCH" 2>/dev/null && pass "sintaxis valida" || fail "bash -n fallo"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

new_bare_with_publisher() {
    local bare="$1" publisher="$2"
    git init -q --bare "$bare"
    git -C "$bare" symbolic-ref HEAD refs/heads/main
    git clone -q "$bare" "$publisher"
    git -C "$publisher" config user.email "test@mefisto.local"
    git -C "$publisher" config user.name "Mefisto Test"
    git -C "$publisher" checkout -q -b main 2>/dev/null || git -C "$publisher" checkout -q main
    git -C "$publisher" commit -q --allow-empty -m "base"
    git -C "$publisher" push -q origin main
}

setup_work_repo() {
    local dir="$1"
    mkdir -p "$dir/.claude-plugin" "$dir/src/internal/scripts/lib"
    printf '{\n  "name": "mefisto",\n  "version": "0.0.0"\n}\n' > "$dir/.claude-plugin/plugin.json"
    cp "$LIBS/_mefisto-common.sh" "$LIBS/mefisto-state.sh" "$LIBS/mefisto-deps.sh" "$dir/src/internal/scripts/lib/"
    cp -R "$REPO_ROOT/src/runtime" "$dir/src/runtime"
    cp "$CANON_BATCH" "$dir/src/internal/scripts/mefisto-batch-pipeline.sh"
    cp "$REPO_ROOT/src/internal/scripts/mefisto-validate-batch-deps.sh" "$dir/src/internal/scripts/"
    chmod +x "$dir/src/internal/scripts/"*.sh
    git -C "$dir" config user.email "test@mefisto.local"
    git -C "$dir" config user.name "Mefisto Test"
}

# fake_tooling_pipeline <dir> <call_log> <fail_issue>
fake_tooling_pipeline() {
    local dir="$1" call_log="$2" fail_issue="${3:-}"
    cat > "$dir/src/internal/scripts/mefisto-tooling-pipeline.sh" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$call_log"
if [ -n "$fail_issue" ] && [ "\$1" = "$fail_issue" ]; then exit 1; fi
echo "v PR creado: https://github.com/acme/mefisto-fake/pull/\$((\$1 + 1000))"
exit 0
EOF
    chmod +x "$dir/src/internal/scripts/mefisto-tooling-pipeline.sh"
    git -C "$dir" add .
    git -C "$dir" commit -q -m "tooling falso"
    git -C "$dir" push -q origin main
}

# gh falso: bodies en $FAKE_GH_BODIES/<n>, estados en $FAKE_GH_STATES/<n>
# (sin archivo de estado => falla, "no consultable").
FAKE_BIN="$TMP/bin"; mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = pr ] && [ "${2:-}" = checks ]; then case " $* " in *" --json "*) echo '[{"name":"tests","state":"SUCCESS"}]';; esac; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
    num="$3"
    git -C "$FAKE_GH_PUBLISHER" pull -q --ff-only origin main >/dev/null 2>&1
    git -C "$FAKE_GH_PUBLISHER" commit -q --allow-empty -m "merge PR #$num" >/dev/null 2>&1
    git -C "$FAKE_GH_PUBLISHER" push -q origin main >/dev/null 2>&1
    mkdir -p "$FAKE_GH_SHA_DIR"
    git -C "$FAKE_GH_PUBLISHER" rev-parse main > "$FAKE_GH_SHA_DIR/$num"
    exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    num="$3"
    [ -f "$FAKE_GH_SHA_DIR/$num" ] && cat "$FAKE_GH_SHA_DIR/$num"
    exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
    num="$3"
    case " $* " in
        *" body "*|*".body"*) [ -f "$FAKE_GH_BODIES/$num" ] && cat "$FAKE_GH_BODIES/$num"; exit 0 ;;
        *".state"*) [ -f "$FAKE_GH_STATES/$num" ] && { cat "$FAKE_GH_STATES/$num"; exit 0; }; exit 1 ;;
    esac
    exit 0
fi
exit 0
STUB
chmod +x "$FAKE_BIN/gh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/claude"; chmod +x "$FAKE_BIN/claude"
SAFE_SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# body_dep <file> <n> -- body con '## Dependencias' que declara 'Depende de #n'
body_dep() { printf '## Contexto\nx\n\n## Dependencias\n- Depende de #%s\n' "$2" > "$1"; }

# run_case <name> <fail_issue> <args...> -- deja LAST_* y $WORK/$CALLS
run_case() {
    local name="$1" fail_issue="$2"; shift 2
    local bare="$TMP/origin-$name.git" pub="$TMP/pub-$name"
    WORK="$TMP/work-$name"; CALLS="$TMP/calls-$name"; : > "$CALLS"
    new_bare_with_publisher "$bare" "$pub"
    git clone -q "$bare" "$WORK"
    setup_work_repo "$WORK"
    fake_tooling_pipeline "$WORK" "$CALLS" "$fail_issue"
    (
        cd "$WORK" || exit 99
        env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT \
            -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG -u MEFISTO_RUNTIME_LIB_DIR \
            MEFISTO_RUNTIME=claude PATH="$FAKE_BIN:$SAFE_SYSTEM_PATH" \
            FAKE_GH_PUBLISHER="$pub" FAKE_GH_SHA_DIR="$TMP/sha-$name" \
            FAKE_GH_BODIES="$TMP/bodies-$name" FAKE_GH_STATES="$TMP/states-$name" \
            ./src/internal/scripts/mefisto-batch-pipeline.sh "$@"
    ) </dev/null >"$TMP/stdout" 2>"$TMP/stderr"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$TMP/stdout")
    STATUS_JSON="$WORK/.mefisto/pipeline/pipeline-status-mefisto-batch.json"
}

issue_status() { jq -r --arg n "$1" '.issues[] | select(.issue == $n) | .status' "$STATUS_JSON"; }

# -------- A: A falla; B y C dependen de A; D independiente --------
echo ""
echo "[A] A falla: B y C se saltan, D se lanza (CA-1/CA-2/CA-3)"
mkdir -p "$TMP/bodies-a" "$TMP/states-a"
body_dep "$TMP/bodies-a/502" 501
body_dep "$TMP/bodies-a/503" 501
printf 'OPEN' > "$TMP/states-a/501"
run_case a 501 501 502 503 504

grep -qx 501 "$CALLS" && pass "A: el pipeline corrio para A (501)" || fail "A: 501 no se invoco"
grep -qx 504 "$CALLS" && pass "A: el pipeline corrio para D (504)" || fail "A: 504 no se invoco"
if ! grep -qxE '502|503' "$CALLS"; then pass "A: el pipeline nunca se invoco para B ni C"; else fail "A: se invoco B o C: $(cat "$CALLS")"; fi
for i in 502 503; do
    [ "$(issue_status $i)" = "saltado: depende de #501 (fallido en este batch)" ] \
        && pass "A: $i -> saltado: depende de #501 (fallido en este batch)" \
        || fail "A: estado inesperado para $i: '$(issue_status $i)'"
done
[ "$(jq -r .state "$STATUS_JSON")" = "failed" ] && pass "A: estado del batch failed (por A)" || fail "A: estado del batch: $(jq -r .state "$STATUS_JSON")"
echo "$LAST_STDOUT" | grep -qF "/mefisto-sequential 502 503" \
    && pass "A: linea de relanzamiento en orden del batch" || fail "A: falta la linea de relanzamiento. stdout: $LAST_STDOUT"
echo "$LAST_STDOUT" | grep -q "Fallidos: 3" && pass "A: el salto incrementa FAILED (1 fallido + 2 saltados)" || fail "A: Fallidos != 3. stdout: $LAST_STDOUT"

# -------- B: dependencia completada en el batch, issue aun OPEN en GitHub --------
echo ""
echo "[B] Dependencia completada en este batch con el issue OPEN en GitHub: se lanza"
mkdir -p "$TMP/bodies-b" "$TMP/states-b"
body_dep "$TMP/bodies-b/602" 601
printf 'OPEN' > "$TMP/states-b/601"
run_case b "" 601 602
if grep -qx 602 "$CALLS"; then pass "B: el dependiente (602) se lanzo"; else fail "B: 602 no se invoco: $(cat "$CALLS")"; fi
[ "$LAST_RC" -eq 0 ] && pass "B: exit 0" || fail "B: exit $LAST_RC. stdout: $LAST_STDOUT"

# -------- C: dependencia externa OPEN: salto sin fallar el batch --------
echo ""
echo "[C] Dependencia externa OPEN: saltado, sin marcar el batch como failed (CA-2)"
mkdir -p "$TMP/bodies-c" "$TMP/states-c"
body_dep "$TMP/bodies-c/702" 999
printf 'OPEN' > "$TMP/states-c/999"
run_case c "" 701 702
[ "$(issue_status 702)" = "saltado: depende de #999 (OPEN)" ] && pass "C: 702 -> saltado: depende de #999 (OPEN)" || fail "C: estado de 702: '$(issue_status 702)'"
grep -qx 701 "$CALLS" && ! grep -qx 702 "$CALLS" && pass "C: solo 701 se lanzo" || fail "C: llamadas: $(cat "$CALLS")"
[ "$LAST_RC" -eq 0 ] && [ "$(jq -r .state "$STATUS_JSON")" = "completed" ] \
    && pass "C: exit 0 y batch completed (el salto no toca HAVE_ERRORS)" || fail "C: rc=$LAST_RC state=$(jq -r .state "$STATUS_JSON")"

# -------- D: dependencia fallida en el batch pero CLOSED en GitHub --------
echo ""
echo "[D] Dependencia fallida en este batch pero CLOSED en GitHub: se lanza (CA-1)"
mkdir -p "$TMP/bodies-d" "$TMP/states-d"
body_dep "$TMP/bodies-d/802" 801
printf 'CLOSED' > "$TMP/states-d/801"
run_case d 801 801 802
grep -qx 802 "$CALLS" && pass "D: el dependiente (802) se lanzo" || fail "D: 802 no se invoco: $(cat "$CALLS")"
case "$(issue_status 802)" in saltado*) fail "D: 802 quedo saltado: '$(issue_status 802)'" ;; *) pass "D: 802 no quedo saltado" ;; esac

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
