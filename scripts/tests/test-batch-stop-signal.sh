#!/usr/bin/env bash
# test-batch-stop-signal.sh -- Tests de la senal de parada suave de
# parallel-pipeline.sh (issue #974, mismo diseno que el motor interno #966):
# detiene el lote tras el trabajo en curso sin matar ningun proceso, via
# pipeline-state/batch-stop (MEF-ADR-0017). Los casos de batch-pipeline.sh
# viven en scripts/tests/batch-pipeline.test.mts.
#
# Cubre:
#   [pre] parallel-pipeline.sh existe, es ejecutable y tiene sintaxis valida.
#   [C]   batch_stop_requested()/defer_pending_issues() de parallel-pipeline.sh
#         en aislamiento: consume la senal y marca DEFERRED_FLAG solo para los
#         indices que seguian pendientes de lanzar (CA-3/CA-5), sin tocar los
#         ya lanzados.
#   [D]   Guard de regresion: defer_pending_issues() de parallel-pipeline.sh
#         nunca toca PIDS ni FAILED (CA-5).
#   [H]   parallel-pipeline.sh, corrida real end-to-end: la senal YA presente
#         antes de la primera pasada del scheduler deja el lote entero
#         "aplazado" sin lanzar ningun worktree (CA-3), imprime la linea de
#         relanzamiento (CA-4), consume la senal y termina en exit 0 (CA-5).
#         Es ademas el guard de regresion del caso "cero lanzados": con PIDS
#         vacio, el loop de monitoreo no debe expandir "${PIDS[@]}" (bash 3.2
#         aborta bajo `set -u` y el resumen con los aplazados no se imprimiria).
#
# Uso: scripts/tests/test-batch-stop-signal.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PARALLEL_SCRIPT="$REPO_ROOT/scripts/parallel-pipeline.sh"
COMMON_LIB="$REPO_ROOT/scripts/_pipeline-common.sh"
RUNTIME_DIR_SRC="$REPO_ROOT/src/runtime"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# -------- Bloque pre: el script existe, es ejecutable y compila --------

echo "[pre] parallel-pipeline.sh existe, es ejecutable y tiene sintaxis valida"

for f in "$PARALLEL_SCRIPT"; do
    if [ -x "$f" ]; then
        pass "$(basename "$f"): existe y es ejecutable"
    else
        fail "$(basename "$f"): no existe o no es ejecutable"
    fi
    if bash -n "$f" 2>/dev/null; then
        pass "$(basename "$f"): sintaxis valida (bash -n)"
    else
        fail "$(basename "$f"): bash -n reporto un error de sintaxis"
    fi
done

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Extraer las funciones REALES bajo prueba (no reimplementarlas) --------

extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

PARALLEL_STOP_REQ_SRC=$(extract_fn "batch_stop_requested" "$PARALLEL_SCRIPT")
DEFER_PENDING_SRC=$(extract_fn "defer_pending_issues" "$PARALLEL_SCRIPT")

for pair in "parallel-pipeline.sh:batch_stop_requested:$PARALLEL_STOP_REQ_SRC" "parallel-pipeline.sh:defer_pending_issues:$DEFER_PENDING_SRC"; do
    file="${pair%%:*}"; rest="${pair#*:}"; name="${rest%%:*}"; src="${rest#*:}"
    if [ -z "$src" ]; then
        fail "no se pudo extraer $name() de $file -- el resto de los bloques se omite"
        echo ""
        echo "----------------------------------------"
        echo "  Resumen: $PASS pass, $FAIL fail"
        echo "----------------------------------------"
        exit 1
    fi
done
pass "las dos funciones se extrajeron del script real"

# -------- Bloque C: batch_stop_requested()/defer_pending_issues() (parallel-pipeline.sh) --------

echo ""
echo "[C] parallel-pipeline.sh: batch_stop_requested()/defer_pending_issues() en aislamiento (CA-3/CA-4)"

load_parallel_fns() {
    PENDING_IDXS=()
    DEFERRED_FLAG=()
    eval "$PARALLEL_STOP_REQ_SRC"
    eval "$DEFER_PENDING_SRC"
}

load_parallel_fns
BATCH_STOP_SIGNAL="$TMP/batch-stop-parallel"
# Simula 5 issues (indices 0..4): 0 y 1 ya lanzados (no aparecen en PENDING_IDXS), 2,3,4 en cola.
PENDING_IDXS=(2 3 4)

if ! batch_stop_requested; then
    pass "C: sin archivo de senal, batch_stop_requested() es falso"
else
    fail "C: sin archivo de senal, batch_stop_requested() no deberia ser verdadero"
fi

touch "$BATCH_STOP_SIGNAL"
if batch_stop_requested; then
    pass "C: con el archivo presente, batch_stop_requested() es verdadero"
else
    fail "C: con el archivo presente, batch_stop_requested() deberia ser verdadero"
fi

defer_pending_issues

if [ ! -e "$BATCH_STOP_SIGNAL" ]; then
    pass "C: defer_pending_issues() consumio (borro) la senal (CA-4)"
else
    fail "C: la senal deberia haberse borrado tras defer_pending_issues()"
fi

if [ "${#PENDING_IDXS[@]}" -eq 0 ]; then
    pass "C: PENDING_IDXS quedo vacio (el scheduler no vuelve a intentar lanzarlos)"
else
    fail "C: PENDING_IDXS deberia quedar vacio, tiene ${#PENDING_IDXS[@]} elemento(s)"
fi

for i in 2 3 4; do
    if [ "${DEFERRED_FLAG[$i]:-false}" = "true" ]; then
        pass "C: indice $i (pendiente) quedo marcado DEFERRED_FLAG=true"
    else
        fail "C: indice $i deberia quedar DEFERRED_FLAG=true"
    fi
done

for i in 0 1; do
    if [ "${DEFERRED_FLAG[$i]:-false}" = "false" ]; then
        pass "C: indice $i (ya lanzado, fuera de PENDING_IDXS) no se toco"
    else
        fail "C: indice $i no deberia haberse marcado como aplazado"
    fi
done

# -------- Bloque D: defer_pending_issues() nunca toca PIDS/FAILED (CA-5) --------

echo ""
echo "[D] parallel-pipeline.sh: defer_pending_issues() no toca PIDS ni FAILED (CA-5)"

if echo "$DEFER_PENDING_SRC" | grep -qE '\bPIDS\[|FAILED'; then
    fail "D: defer_pending_issues() referencia PIDS o FAILED -- solo debe afectar a los pendientes sin lanzar"
else
    pass "D: defer_pending_issues() no referencia PIDS ni FAILED"
fi

# -------- Fixtures del bloque H: repo consumidor + origin real --------

# setup_work_repo <dir> -- clone de un origin real (en 'main') sumandole el
# scaffold minimo de un CONSUMIDOR (sin .claude-plugin/plugin.json -- el guard
# defensivo de parallel-pipeline.sh aborta si lo detecta) + el canonico real
# bajo prueba.
setup_work_repo() {
    local dir="$1"
    mkdir -p "$dir/scripts"
    cp "$COMMON_LIB" "$dir/scripts/_pipeline-common.sh"
    cp "$PARALLEL_SCRIPT" "$dir/scripts/parallel-pipeline.sh"
    chmod +x "$dir/scripts/parallel-pipeline.sh"
    # parallel-pipeline.sh (issue #1620) resuelve el runtime activo contra
    # src/runtime junto al paquete publicado -- el fixture necesita el
    # arbol real, no solo el script.
    mkdir -p "$dir/src"
    cp -R "$RUNTIME_DIR_SRC" "$dir/src/runtime"
}

# fake_tooling_pipeline <dir> <call_log> [<signal_after_issue> <signal_path>]
#
# Stub que registra cada issue invocado en <call_log> y siempre "tiene exito"
# imprimiendo una URL de PR reconocible (numero = issue + 1000). Si se pasan
# los dos argumentos opcionales, ademas toca <signal_path> cuando procesa
# <signal_after_issue> -- simula a un humano corriendo /batch-stop mientras
# ese eslabon esta en curso.
fake_tooling_pipeline() {
    local dir="$1" call_log="$2" signal_after="${3:-}" signal_path="${4:-}"
    cat > "$dir/scripts/tooling-pipeline.sh" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$call_log"
if [ -n "$signal_after" ] && [ "\$1" = "$signal_after" ]; then
    mkdir -p "$(dirname "$signal_path")"
    touch "$signal_path"
fi
echo "PR creado: https://github.com/acme/fake-consumer/pull/\$((\$1 + 1000))"
exit 0
EOF
    chmod +x "$dir/scripts/tooling-pipeline.sh"
}

FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
    printf 'OPEN|tipo:tooling\n'
    exit 0
fi
exit 0
STUB
chmod +x "$FAKE_BIN/gh"
cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/claude"
cat > "$FAKE_BIN/dotnet" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/dotnet"

# Mismo criterio que los demas tests de pipelines publicados: solo el tramo de
# sistema (git/coreutils) queda fuera de FAKE_BIN.
SAFE_SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

new_origin() {
    local bare="$1" work="$2"
    git init -q --bare "$bare"
    git -C "$bare" symbolic-ref HEAD refs/heads/main
    git clone -q "$bare" "$work" 2>/dev/null
    git -C "$work" config user.email "test@mefisto.local"
    git -C "$work" config user.name "Mefisto Test"
    git -C "$work" commit -q --allow-empty -m "base"
    git -C "$work" push -q origin main
}

# run_parallel <dir> <args...>
run_parallel() {
    local dir="$1"; shift
    local out="$TMP/stdout" err="$TMP/stderr"
    (
        cd "$dir" || exit 99
        PATH="$FAKE_BIN:$SAFE_SYSTEM_PATH" MEFISTO_RUNTIME=claude ./scripts/parallel-pipeline.sh --stagger 0 "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

# -------- Bloque H: parallel-pipeline.sh con la senal presente antes de lanzar --------

echo ""
echo "[H] parallel-pipeline.sh, corrida real: senal presente ANTES de la primera pasada del scheduler -- nada se lanza (CA-3, CA-4, CA-5)"

WORK_H="$TMP/work-h"
new_origin "$TMP/origin-h.git" "$WORK_H"
setup_work_repo "$WORK_H"
CALL_LOG_H="$TMP/call-log-h"; : > "$CALL_LOG_H"
fake_tooling_pipeline "$WORK_H" "$CALL_LOG_H"

mkdir -p "$WORK_H/pipeline-state"
touch "$WORK_H/pipeline-state/batch-stop"

run_parallel "$WORK_H" 501 502

# Regresion del caso "cero lanzados": el loop de monitoreo corria
# `for pid in "${PIDS[@]}"` sobre un PIDS vacio y bash 3.2 lo mataba con
# "unbound variable" bajo `set -u`, justo antes del resumen que tenia todos los
# aplazados por reportar.
if [ "$LAST_RC" -eq 0 ]; then
    pass "H: exit 0 (una parada solicitada no es un fallo, CA-5)"
else
    fail "H: se esperaba exit 0, se obtuvo $LAST_RC. stdout: $LAST_STDOUT / stderr: $LAST_STDERR"
fi

if ! echo "$LAST_STDERR" | grep -q "unbound variable"; then
    pass "H: el motor no aborta por 'unbound variable' con cero pipelines en vuelo"
else
    fail "H: el motor aborto por 'unbound variable'. stderr: $LAST_STDERR"
fi

if [ ! -s "$CALL_LOG_H" ]; then
    pass "H: no se lanzo ningun worktree (CA-3)"
else
    fail "H: se lanzo algun pipeline pese a la senal previa: $(cat "$CALL_LOG_H")"
fi

ALL_DEFERRED_H=true
for i in 501 502; do
    if ! echo "$LAST_STDOUT" | grep -E "#$i\s" | grep -q "aplazado"; then
        ALL_DEFERRED_H=false
    fi
done
if [ "$ALL_DEFERRED_H" = true ]; then
    pass "H: los dos issues quedaron 'aplazado' en el resumen (CA-4)"
else
    fail "H: se esperaban dos issues 'aplazado' en el resumen. stdout: $LAST_STDOUT"
fi

if echo "$LAST_STDOUT" | grep -qF "parallel-pipeline.sh 501 502"; then
    pass "H: la linea de relanzamiento apunta al orquestador paralelo, en orden (CA-4)"
else
    fail "H: no se encontro la linea de relanzamiento esperada. stdout: $LAST_STDOUT"
fi

if [ ! -e "$WORK_H/pipeline-state/batch-stop" ]; then
    pass "H: la senal quedo consumida (borrada) (CA-5)"
else
    fail "H: la senal deberia haberse borrado tras detenerse el lote"
fi

if ! echo "$LAST_STDOUT" | grep -q "Fallidos: [^0]"; then
    pass "H: FAILED se mantuvo en 0 (CA-5)"
else
    fail "H: FAILED no deberia incrementarse por una parada solicitada. stdout: $LAST_STDOUT"
fi

# -------- Resumen --------

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
