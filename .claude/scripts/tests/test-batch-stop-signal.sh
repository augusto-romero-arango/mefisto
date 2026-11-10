#!/usr/bin/env bash
# test-batch-stop-signal.sh -- Tests de la senal de parada suave del batch
# interno (issue #966): detiene el motor tras el eslabon en curso sin matar
# ningun proceso.
#
# Cubre:
#   [pre] El script existe, es ejecutable y tiene sintaxis valida.
#   [A]   batch_stop_requested()/defer_from_index() en aislamiento: sin senal
#         no dispara nada; con senal, defer_from_index consume el archivo
#         (CA-4) y marca "aplazado" (CA-2/CA-3) solo desde el indice indicado,
#         sin tocar los issues anteriores.
#   [B]   Guard de regresion: defer_from_index() nunca toca HAVE_ERRORS ni
#         FAILED (CA-5 -- una parada solicitada no es un fallo).
#   [C]   Corrida real end-to-end con un origin/gh falsos: la senal YA
#         presente antes de arrancar detiene el batch entero sin invocar el
#         tooling-pipeline para NINGUN issue (CA-1 momento 1, CA-2), deja
#         "aplazado" a los tres, exit 0 (CA-5) y consume la senal (CA-4).
#   [D]   Corrida real end-to-end donde la senal aparece DURANTE el primer
#         eslabon: ese eslabon se completa entero (pipeline, PR, merge, sync
#         verificado) y los restantes quedan "aplazado" sin arrancar ningun
#         worktree (CA-1 momento 2, CA-2), exit 0 y sin incrementar FAILED
#         (CA-5), con la linea de relanzamiento en el orden correcto (CA-3).
#   [E]   Caso limite: la senal llega durante el ULTIMO eslabon. No queda nada
#         que aplazar (defer de cero issues, que bajo `set -e` no debe matar al
#         motor), no se imprime linea de relanzamiento y la senal se consume
#         igual (CA-4).
#
# Uso: .claude/scripts/tests/test-batch-stop-signal.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CANON_BATCH="$REPO_ROOT/src/internal/scripts/mefisto-batch-pipeline.sh"
CANON_LIB="$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"
CANON_STATE_LIB="$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh"
CANON_RUNTIME="$REPO_ROOT/src/runtime"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# -------- Bloque pre: el script existe, es ejecutable y tiene sintaxis valida --------

echo "[pre] mefisto-batch-pipeline.sh existe, es ejecutable y tiene sintaxis valida"

if [ -x "$CANON_BATCH" ]; then
    pass "el script existe y es ejecutable"
else
    fail "el script no existe o no es ejecutable: $CANON_BATCH"
fi

if bash -n "$CANON_BATCH" 2>/dev/null; then
    pass "sintaxis valida (bash -n)"
else
    fail "bash -n reporto un error de sintaxis en $CANON_BATCH"
fi

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Extraer las funciones REALES bajo prueba (no reimplementarlas) --------

extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

SET_STATUS_SRC=$(extract_fn "set_status" "$CANON_BATCH")
GET_STATUS_SRC=$(extract_fn "get_status" "$CANON_BATCH")
STOP_REQ_SRC=$(extract_fn "batch_stop_requested" "$CANON_BATCH")
DEFER_SRC=$(extract_fn "defer_from_index" "$CANON_BATCH")

for pair in "set_status:$SET_STATUS_SRC" "get_status:$GET_STATUS_SRC" "batch_stop_requested:$STOP_REQ_SRC" "defer_from_index:$DEFER_SRC"; do
    name="${pair%%:*}"; src="${pair#*:}"
    if [ -z "$src" ]; then
        fail "no se pudo extraer $name() de $CANON_BATCH -- el resto de los bloques se omite"
        echo ""
        echo "----------------------------------------"
        echo "  Resumen: $PASS pass, $FAIL fail"
        echo "----------------------------------------"
        exit 1
    fi
done
pass "las cuatro funciones se extrajeron del script real"

load_fns() {
    ISSUE_STATUS_NUMS=()
    ISSUE_STATUS_VALUES=()
    ISSUE_STATUS_PRS=()
    eval "$SET_STATUS_SRC"
    eval "$GET_STATUS_SRC"
    eval "$STOP_REQ_SRC"
    eval "$DEFER_SRC"
}

# -------- Bloque A: batch_stop_requested()/defer_from_index() en aislamiento --------

echo ""
echo "[A] batch_stop_requested()/defer_from_index() en aislamiento (CA-2/CA-3/CA-4)"

load_fns
BATCH_STOP_SIGNAL="$TMP/batch-stop"
ISSUE_NUMS=(101 102 103)
for i in "${ISSUE_NUMS[@]}"; do set_status "$i" "pendiente"; done

if ! batch_stop_requested; then
    pass "A: sin archivo de senal, batch_stop_requested() es falso"
else
    fail "A: sin archivo de senal, batch_stop_requested() no deberia ser verdadero"
fi

touch "$BATCH_STOP_SIGNAL"
if batch_stop_requested; then
    pass "A: con el archivo presente, batch_stop_requested() es verdadero"
else
    fail "A: con el archivo presente, batch_stop_requested() deberia ser verdadero"
fi

defer_from_index 1

if [ ! -e "$BATCH_STOP_SIGNAL" ]; then
    pass "A: defer_from_index() consumio (borro) la senal (CA-4)"
else
    fail "A: la senal deberia haberse borrado tras defer_from_index()"
fi

if [ "$(get_status 101)" = "pendiente" ]; then
    pass "A: el issue ANTES del indice (101) no se toco"
else
    fail "A: el issue 101 no deberia haberse tocado, quedo en '$(get_status 101)'"
fi

for i in 102 103; do
    st="$(get_status "$i")"
    case "$st" in
        aplazado*) pass "A: issue $i quedo 'aplazado' ($st)" ;;
        *) fail "A: issue $i deberia quedar 'aplazado', quedo en '$st'" ;;
    esac
done

# -------- Bloque B: defer_from_index() nunca toca HAVE_ERRORS/FAILED (CA-5) --------

echo ""
echo "[B] defer_from_index() no incrementa FAILED ni toca HAVE_ERRORS (CA-5)"

if echo "$DEFER_SRC" | grep -qE 'HAVE_ERRORS|FAILED'; then
    fail "B: defer_from_index() referencia HAVE_ERRORS o FAILED -- una parada solicitada no es un fallo"
else
    pass "B: defer_from_index() no referencia HAVE_ERRORS ni FAILED"
fi

# -------- Fixtures compartidas de los bloques C/D: repo Mefisto + origin real --------

# new_bare_with_publisher <bare> <publisher> -- origin bare en 'main' + un
# clone "publisher" que simula el merge server-side de `gh pr merge` (empuja
# commits nuevos al mismo bare que el batch bajo prueba usa como origin).
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

# setup_work_repo <dir> -- <dir> ya es un clone del bare (en 'main'); se le
# suma el scaffold minimo de Mefisto + los canonicos reales bajo prueba, mismo
# criterio que test-batch-runtime.sh.
setup_work_repo() {
    local dir="$1"
    mkdir -p "$dir/.claude-plugin" "$dir/src/internal/scripts/lib"
    cat > "$dir/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "0.0.0"
}
EOF
    cp "$CANON_LIB" "$dir/src/internal/scripts/lib/_mefisto-common.sh"
    cp "$CANON_STATE_LIB" "$dir/src/internal/scripts/lib/mefisto-state.sh"
    cp -R "$CANON_RUNTIME" "$dir/src/runtime"
    cp "$CANON_BATCH" "$dir/src/internal/scripts/mefisto-batch-pipeline.sh"
    cp "$REPO_ROOT/src/internal/scripts/mefisto-validate-batch-deps.sh" "$dir/src/internal/scripts/mefisto-validate-batch-deps.sh"
    chmod +x "$dir/src/internal/scripts/mefisto-batch-pipeline.sh"
    chmod +x "$dir/src/internal/scripts/mefisto-validate-batch-deps.sh"
    git -C "$dir" config user.email "test@mefisto.local"
    git -C "$dir" config user.name "Mefisto Test"
}

# fake_tooling_pipeline <dir> <call_log> [<signal_after_issue> <signal_path>]
#
# Stub que registra cada issue invocado en <call_log> y siempre "tiene exito"
# imprimiendo una URL de PR reconocible (numero = issue + 1000). Si se pasan
# los dos argumentos opcionales, ademas toca <signal_path> cuando procesa
# <signal_after_issue> -- simula a un humano corriendo /mefisto-batch-stop
# mientras ese eslabon esta en curso.
fake_tooling_pipeline() {
    local dir="$1" call_log="$2" signal_after="${3:-}" signal_path="${4:-}"
    cat > "$dir/src/internal/scripts/mefisto-tooling-pipeline.sh" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$call_log"
if [ -n "$signal_after" ] && [ "\$1" = "$signal_after" ]; then
    touch "$signal_path"
fi
echo "v PR creado: https://github.com/acme/mefisto-fake/pull/\$((\$1 + 1000))"
exit 0
EOF
    chmod +x "$dir/src/internal/scripts/mefisto-tooling-pipeline.sh"
    git -C "$dir" add .
    git -C "$dir" commit -q -m "tooling falso"
    git -C "$dir" push -q origin main
}

# fake_gh <bin_dir> -- gh falso: "pr merge" empuja un commit nuevo desde
# FAKE_GH_PUBLISHER a origin/main (simula el merge server-side de GitHub) y
# registra su SHA por numero de PR; "pr view ... mergeCommit.oid" lo devuelve.
setup_fake_gh() {
    local bin_dir="$1"
    cat > "$bin_dir/gh" <<'STUB'
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
exit 0
STUB
    chmod +x "$bin_dir/gh"
}

FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
setup_fake_gh "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/claude"

# Mismo criterio que test-batch-runtime.sh: esta maquina de dogfooding tiene
# un 'claude' real instalado fuera de /usr/bin y /bin, asi que solo el tramo
# de sistema queda detras de FAKE_BIN (ahi viven git/jq/coreutils).
SAFE_SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# run_batch <dir> <publisher> <sha_dir> <args...>
run_batch() {
    local dir="$1" publisher="$2" sha_dir="$3"; shift 3
    local out="$TMP/stdout" err="$TMP/stderr"
    (
        cd "$dir" || exit 99
        env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT \
            -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG -u MEFISTO_RUNTIME_LIB_DIR \
            MEFISTO_RUNTIME=claude PATH="$FAKE_BIN:$SAFE_SYSTEM_PATH" \
            FAKE_GH_PUBLISHER="$publisher" FAKE_GH_SHA_DIR="$sha_dir" \
            ./src/internal/scripts/mefisto-batch-pipeline.sh "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

# -------- Bloque C: la senal YA presente detiene todo antes de arrancar --------

echo ""
echo "[C] Senal presente ANTES de arrancar: nada se procesa (CA-1 momento 1, CA-2, CA-5)"

BARE_C="$TMP/origin-c.git"; PUB_C="$TMP/pub-c"
new_bare_with_publisher "$BARE_C" "$PUB_C"
WORK_C="$TMP/work-c"
git clone -q "$BARE_C" "$WORK_C"
setup_work_repo "$WORK_C"
CALL_LOG_C="$TMP/call-log-c"; : > "$CALL_LOG_C"
fake_tooling_pipeline "$WORK_C" "$CALL_LOG_C"

mkdir -p "$WORK_C/.mefisto/pipeline"
touch "$WORK_C/.mefisto/pipeline/batch-stop"

run_batch "$WORK_C" "$PUB_C" "$TMP/sha-c" 201 202 203

if [ "$LAST_RC" -eq 0 ]; then
    pass "C: exit 0 (una parada solicitada no es un fallo, CA-5)"
else
    fail "C: se esperaba exit 0, se obtuvo $LAST_RC. stdout: $LAST_STDOUT / stderr: $LAST_STDERR"
fi

if [ ! -s "$CALL_LOG_C" ]; then
    pass "C: el tooling-pipeline nunca se invoco para ningun issue (CA-2)"
else
    fail "C: el tooling-pipeline se invoco pese a la senal previa: $(cat "$CALL_LOG_C")"
fi

ALL_DEFERRED=true
for i in 201 202 203; do
    if ! echo "$LAST_STDOUT" | grep -E "#$i\s" | grep -q "aplazado"; then
        ALL_DEFERRED=false
    fi
done
if [ "$ALL_DEFERRED" = true ]; then
    pass "C: los tres issues quedaron 'aplazado' en el resumen"
else
    fail "C: se esperaban tres issues 'aplazado' en el resumen. stdout: $LAST_STDOUT"
fi

if echo "$LAST_STDOUT" | grep -qF "/mefisto-sequential 201 202 203"; then
    pass "C: la linea de relanzamiento respeta el orden (CA-3)"
else
    fail "C: no se encontro la linea de relanzamiento esperada. stdout: $LAST_STDOUT"
fi

if [ ! -e "$WORK_C/.mefisto/pipeline/batch-stop" ]; then
    pass "C: la senal quedo consumida (borrada) al detenerse el batch (CA-4)"
else
    fail "C: la senal deberia haberse borrado tras detenerse el batch"
fi

if ! echo "$LAST_STDOUT" | grep -q "Fallidos: [^0]"; then
    pass "C: FAILED se mantuvo en 0"
else
    fail "C: FAILED no deberia incrementarse por una parada solicitada. stdout: $LAST_STDOUT"
fi

# -------- Bloque D: la senal aparece DURANTE el primer eslabon --------

echo ""
echo "[D] Senal aparece durante el primer eslabon: ese eslabon se completa entero, el resto queda aplazado (CA-1 momento 2, CA-2, CA-3, CA-5)"

BARE_D="$TMP/origin-d.git"; PUB_D="$TMP/pub-d"
new_bare_with_publisher "$BARE_D" "$PUB_D"
WORK_D="$TMP/work-d"
git clone -q "$BARE_D" "$WORK_D"
setup_work_repo "$WORK_D"
CALL_LOG_D="$TMP/call-log-d"; : > "$CALL_LOG_D"
SIGNAL_D="$WORK_D/.mefisto/pipeline/batch-stop"
fake_tooling_pipeline "$WORK_D" "$CALL_LOG_D" "301" "$SIGNAL_D"

run_batch "$WORK_D" "$PUB_D" "$TMP/sha-d" 301 302 303

if [ "$LAST_RC" -eq 0 ]; then
    pass "D: exit 0 (una parada solicitada no es un fallo, CA-5)"
else
    fail "D: se esperaba exit 0, se obtuvo $LAST_RC. stdout: $LAST_STDOUT / stderr: $LAST_STDERR"
fi

if grep -qF "301" "$CALL_LOG_D" && ! grep -qF "302" "$CALL_LOG_D" && ! grep -qF "303" "$CALL_LOG_D"; then
    pass "D: solo el primer eslabon (301) arranco un worktree; 302/303 nunca se invocaron (CA-2)"
else
    fail "D: invocaciones inesperadas del tooling-pipeline: $(cat "$CALL_LOG_D")"
fi

if echo "$LAST_STDOUT" | grep -qE '#301\s+#?1301\s+completado'; then
    pass "D: el issue 301 quedo 'completado' con su PR (#1301)"
else
    fail "D: el issue 301 deberia quedar 'completado' con PR #1301. stdout: $LAST_STDOUT"
fi

for i in 302 303; do
    if echo "$LAST_STDOUT" | grep -E "#$i\s" | grep -q "aplazado"; then
        pass "D: el issue $i quedo 'aplazado'"
    else
        fail "D: el issue $i deberia quedar 'aplazado'. stdout: $LAST_STDOUT"
    fi
done

if echo "$LAST_STDOUT" | grep -qF "/mefisto-sequential 302 303"; then
    pass "D: la linea de relanzamiento respeta el orden de los aplazados (CA-3)"
else
    fail "D: no se encontro la linea de relanzamiento esperada. stdout: $LAST_STDOUT"
fi

if [ ! -e "$SIGNAL_D" ]; then
    pass "D: la senal quedo consumida (borrada) tras el sync verificado del primer eslabon (CA-4)"
else
    fail "D: la senal deberia haberse borrado"
fi

if ! echo "$LAST_STDOUT" | grep -q "Fallidos: [^0]"; then
    pass "D: FAILED se mantuvo en 0 pese a la parada (CA-5)"
else
    fail "D: FAILED no deberia incrementarse por una parada solicitada. stdout: $LAST_STDOUT"
fi

# -------- Bloque E: la senal llega durante el ULTIMO eslabon --------

echo ""
echo "[E] Senal durante el ULTIMO eslabon: no hay nada que aplazar, pero la senal se consume igual (CA-4)"

BARE_E="$TMP/origin-e.git"; PUB_E="$TMP/pub-e"
new_bare_with_publisher "$BARE_E" "$PUB_E"
WORK_E="$TMP/work-e"
git clone -q "$BARE_E" "$WORK_E"
setup_work_repo "$WORK_E"
CALL_LOG_E="$TMP/call-log-e"; : > "$CALL_LOG_E"
SIGNAL_E="$WORK_E/.mefisto/pipeline/batch-stop"
fake_tooling_pipeline "$WORK_E" "$CALL_LOG_E" "402" "$SIGNAL_E"

run_batch "$WORK_E" "$PUB_E" "$TMP/sha-e" 401 402

# El caso limite del `for ((i = from; i < ${#ISSUE_NUMS[@]}; i++))` de
# defer_from_index: cero iteraciones bajo `set -e`. Si ese for devolviera un
# exit code no-cero, el motor moriria aqui en vez de cerrar el resumen.
if [ "$LAST_RC" -eq 0 ]; then
    pass "E: exit 0 (el defer de cero issues no mata el motor bajo set -e)"
else
    fail "E: se esperaba exit 0, se obtuvo $LAST_RC. stdout: $LAST_STDOUT / stderr: $LAST_STDERR"
fi

if grep -qF "401" "$CALL_LOG_E" && grep -qF "402" "$CALL_LOG_E"; then
    pass "E: los dos eslabones se procesaron completos"
else
    fail "E: se esperaban los dos eslabones procesados: $(cat "$CALL_LOG_E")"
fi

if ! echo "$LAST_STDOUT" | grep -q "aplazado"; then
    pass "E: ningun issue quedo 'aplazado' (no quedaba ninguno por arrancar)"
else
    fail "E: no deberia haber aplazados. stdout: $LAST_STDOUT"
fi

if ! echo "$LAST_STDOUT" | grep -qF "/mefisto-sequential 4"; then
    pass "E: no se imprimio linea de relanzamiento (no hay nada que relanzar)"
else
    fail "E: no deberia haber linea de relanzamiento. stdout: $LAST_STDOUT"
fi

if [ ! -e "$SIGNAL_E" ]; then
    pass "E: la senal se consumio igual (CA-4: no envenena la corrida siguiente)"
else
    fail "E: la senal deberia haberse borrado aunque no hubiera eslabones restantes"
fi

if echo "$LAST_STDOUT" | grep -qF "era el ultimo eslabon del batch"; then
    pass "E: el aviso dice la verdad (no promete aplazados inexistentes)"
else
    fail "E: se esperaba el aviso del caso 'ultimo eslabon'. stdout: $LAST_STDOUT"
fi

# -------- Resumen --------

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
