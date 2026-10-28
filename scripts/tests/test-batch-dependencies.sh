#!/usr/bin/env bash
# test-batch-dependencies.sh -- Compuerta de dependencias de batch-pipeline.sh
# (issue #2471). Reproduce el caso del origen: batch A B C D; B y C dependen de
# A; D es independiente; A falla -> B y C se saltan, D se lanza. Cubre tambien
# la dependencia completada en este batch con el issue aun OPEN en GitHub.
#
# Uso: scripts/tests/test-batch-dependencies.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BATCH_SCRIPT="$REPO_ROOT/scripts/batch-pipeline.sh"
COMMON_LIB="$REPO_ROOT/scripts/_pipeline-common.sh"
RUNTIME_DIR_SRC="$REPO_ROOT/src/runtime"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- Parser ---
echo "[P] extract_canonical_dependencies"
# shellcheck disable=SC1090
source "$COMMON_LIB"
BODY=$'## Contexto\nDepende de #999 en prosa\n\n## Dependencias\n- Depende de #10\n* bloqueado por #11\n  Depende de #10\n- Bloquea #12\n- Relacionado: #13\nVer tambien Depende de #14\n\n## Otra\nDepende de #15\n'
GOT=$(extract_canonical_dependencies "$BODY" | tr '\n' ' ')
if [ "$GOT" = "10 11 " ]; then pass "P: solo canonicas, sin repetir, anclado a la seccion"; else fail "P: se obtuvo '$GOT', se esperaba '10 11 '"; fi
if [ -z "$(extract_canonical_dependencies $'## Dependencias\nNinguna\n')" ]; then pass "P: 'Ninguna' no produce dependencias"; else fail "P: 'Ninguna' produjo dependencias"; fi

# --- Fixture ---
FAKE_BIN="$TMP/bin"; mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Escenario por archivos en $GH_FIXTURE: body-N, labels-N, state-N (default OPEN)
n="$3"
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
    case "$*" in
        *"--json body"*) cat "$GH_FIXTURE/body-$n" 2>/dev/null; exit 0 ;;
        *"--json labels"*) cat "$GH_FIXTURE/labels-$n" 2>/dev/null; exit 0 ;;
        *"--json state,labels"*) printf '%s|tipo:tooling\n' "$(cat "$GH_FIXTURE/state-$n" 2>/dev/null || echo OPEN)"; exit 0 ;;
        *"--json state"*) cat "$GH_FIXTURE/state-$n" 2>/dev/null || echo OPEN; exit 0 ;;
    esac
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then echo "edit $*" >> "$GH_FIXTURE/edits"; exit 0; fi
exit 0
STUB
for b in claude dotnet; do printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/$b"; done
chmod +x "$FAKE_BIN"/*
SAFE="/usr/bin:/bin:/usr/sbin:/sbin"

setup_work() {
    local w="$1" bare="$1.git"
    git init -q --bare "$bare"; git -C "$bare" symbolic-ref HEAD refs/heads/main
    git clone -q "$bare" "$w" 2>/dev/null
    git -C "$w" config user.email t@m.local; git -C "$w" config user.name T
    git -C "$w" commit -q --allow-empty -m base; git -C "$w" push -q origin main
    mkdir -p "$w/scripts" "$w/src"
    cp "$COMMON_LIB" "$w/scripts/_pipeline-common.sh"
    cp "$BATCH_SCRIPT" "$w/scripts/batch-pipeline.sh"
    cp -R "$RUNTIME_DIR_SRC" "$w/src/runtime"
    chmod +x "$w/scripts/batch-pipeline.sh"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$w/scripts/pr-sync.sh"; chmod +x "$w/scripts/pr-sync.sh"
}
# fake_pipeline <dir> <call_log> <failing_issue>
fake_pipeline() {
    cat > "$1/scripts/tooling-pipeline.sh" <<EOT
#!/usr/bin/env bash
echo "\$1" >> "$2"
[ "\$1" = "$3" ] && exit 1
echo "PR creado: https://github.com/acme/x/pull/\$((\$1 + 1000))"
exit 0
EOT
    chmod +x "$1/scripts/tooling-pipeline.sh"
}
run_batch() {
    local dir="$1"; shift
    ( cd "$dir" || exit 99
      env -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT -u MEFISTO_LAUNCH_ROOT MEFISTO_STATE_DIR="$dir/.mefisto/pipeline" GH_FIXTURE="$FIX" PATH="$FAKE_BIN:$SAFE" MEFISTO_RUNTIME=claude ./scripts/batch-pipeline.sh "$@" ) \
        </dev/null >"$TMP/out" 2>"$TMP/err"
    LAST_RC=$?; LAST_OUT=$(cat "$TMP/out")
}
status_of() {
    local f
    f=$(find "$W" -name pipeline-status-batch.json -not -path "*/.git/*" 2>/dev/null | head -1)
    [ -n "$f" ] && jq -r --argjson n "$1" '.issues[] | select(.issue==$n) | .status' "$f"
}

# --- Escenario 1: caso del origen ---
echo ""; echo "[1] A falla; B y C dependen de A; D independiente"
W="$TMP/w1"; FIX="$TMP/fix1"; mkdir -p "$FIX"; setup_work "$W"
CALLS="$TMP/calls1"; : > "$CALLS"; fake_pipeline "$W" "$CALLS" 1
for i in 1 2 3 4; do echo OPEN > "$FIX/state-$i"; done
printf '## Dependencias\nDepende de #1\n' > "$FIX/body-2"; echo bloqueado > "$FIX/labels-2"
printf '## Dependencias\n- Depende de #1\n' > "$FIX/body-3"; echo bloqueado > "$FIX/labels-3"
printf '## Dependencias\nNinguna\n' > "$FIX/body-4"
run_batch "$W" 1 2 3 4
if [ "$LAST_RC" -eq 1 ]; then pass "1: exit 1 por el fallo real de A"; else fail "1: exit $LAST_RC (esperado 1)"; fi
if grep -qx 1 "$CALLS" && grep -qx 4 "$CALLS" && ! grep -qx 2 "$CALLS" && ! grep -qx 3 "$CALLS"; then
    pass "1: el pipeline corrio para A y D, nunca para B ni C"
else fail "1: invocaciones: $(tr '\n' ' ' < "$CALLS")"; fi
for i in 2 3; do
    [ "$(status_of $i)" = "saltado" ] && pass "1: #$i reportado 'saltado' en pipeline-status-batch.json" || fail "1: #$i no quedo saltado ($(status_of $i))"
    echo "$LAST_OUT" | grep -E "#$i\s" | grep -q "saltado: depende de #1 (fallido en este batch)" && pass "1: #$i con motivo 'fallido en este batch'" || fail "1: motivo de #$i ausente. $LAST_OUT"
done
echo "$LAST_OUT" | grep -F "Relanza tras resolver sus dependencias:" | grep -qF "/sequential 2 3" && pass "1: linea de relanzamiento en orden" || fail "1: falta linea de relanzamiento"
[ ! -e "$FIX/edits" ] && pass "1: no se quito 'bloqueado' a los saltados" || fail "1: se edito labels: $(cat "$FIX/edits")"

# --- Escenario 2: dependencia completada en este batch, issue aun OPEN ---
echo ""; echo "[2] A completa (sigue OPEN en GitHub); B depende de A y tiene 'bloqueado'"
W="$TMP/w2"; FIX="$TMP/fix2"; mkdir -p "$FIX"; setup_work "$W"
CALLS="$TMP/calls2"; : > "$CALLS"; fake_pipeline "$W" "$CALLS" 0
for i in 1 2; do echo OPEN > "$FIX/state-$i"; done
printf '## Dependencias\nBloqueado por #1\n' > "$FIX/body-2"; echo bloqueado > "$FIX/labels-2"
run_batch "$W" 1 2
if [ "$LAST_RC" -eq 0 ] && grep -qx 2 "$CALLS"; then pass "2: B se lanzo y exit 0"; else fail "2: rc=$LAST_RC calls=$(tr '\n' ' ' < "$CALLS")"; fi
grep -q "remove-label" "$FIX/edits" 2>/dev/null && pass "2: se quito 'bloqueado' antes de lanzar" || fail "2: no se quito 'bloqueado'"

# --- Escenario 3: dependencia externa abierta / cerrada; bloqueado sin canonicas ---
echo ""; echo "[3] externa OPEN salta; externa CLOSED lanza; bloqueado sin canonicas salta"
W="$TMP/w3"; FIX="$TMP/fix3"; mkdir -p "$FIX"; setup_work "$W"
CALLS="$TMP/calls3"; : > "$CALLS"; fake_pipeline "$W" "$CALLS" 0
echo OPEN > "$FIX/state-5"; echo OPEN > "$FIX/state-6"; echo OPEN > "$FIX/state-7"
echo OPEN > "$FIX/state-90"; echo CLOSED > "$FIX/state-91"
printf '## Dependencias\nDepende de #90\n' > "$FIX/body-5"
printf '## Dependencias\nDepende de #91\n' > "$FIX/body-6"
printf '## Dependencias\nNinguna\n' > "$FIX/body-7"; echo bloqueado > "$FIX/labels-7"
run_batch "$W" 5 6 7
grep -qx 6 "$CALLS" && ! grep -qx 5 "$CALLS" && ! grep -qx 7 "$CALLS" && pass "3: solo #6 se lanzo" || fail "3: calls=$(tr '\n' ' ' < "$CALLS")"
echo "$LAST_OUT" | grep -E "#5\s" | grep -q "depende de #90 (OPEN)" && pass "3: #5 con motivo OPEN" || fail "3: motivo de #5"
echo "$LAST_OUT" | grep -E "#7\s" | grep -q "bloqueado sin dependencias canonicas" && pass "3: #7 con motivo bloqueado sin canonicas" || fail "3: motivo de #7"
[ "$LAST_RC" -eq 0 ] && pass "3: el salto solo no cambia el exit code" || fail "3: exit $LAST_RC"

echo ""; echo "----------------------------------------"; echo "  Resumen: $PASS pass, $FAIL fail"; echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
