#!/usr/bin/env bash
# test-tdd-variant.sh -- Tests del modo --variant (corridas paralelas del
# mismo issue, issue #713, segunda pieza tras #710/tooling-pipeline.sh) en
# scripts/tdd-pipeline.sh, scripts/launch-pipeline.sh y scripts/herdr-pipeline.sh.
#
# validate_variant_label ya la cubre scripts/tests/test-tooling-variant.sh
# (vive en _pipeline-common.sh, sin cambios en este issue): este archivo no la
# repite. Cubre en su lugar:
#   tdd-pipeline.sh   - chequeos estaticos al estilo de test-guards.sh: el
#                       sufijo -<label> llega a rama/worktree, status y log del
#                       pipeline (CA-2); los nombres de log de stage usan
#                       ISSUE_LOG_TAG en vez de ISSUE_NUM directo; los cuatro
#                       efectos externos (push, gh pr create, label+comentario
#                       de bloqueo, gh issue comment) quedan anidados bajo el
#                       gate de VARIANT_LABEL, ninguno en el nivel superior
#                       (CA-3); el reporte de bloqueo se preserva fuera del
#                       worktree que el cleanup borra; el campo "variant" viaja
#                       en el status, en la linea de historial de abort() y en
#                       la de exito (CA-4).
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

# --- tdd-pipeline.sh: wiring del modo variante (CA-2/CA-3/CA-4) -------------
#
# Chequeos estaticos sobre el fuente: correr el pipeline completo pediria
# stubs de claude/gh/dotnet, una config de consumidor y un worktree real, y lo
# que aqui importa es DONDE quedan cableados el sufijo y las supresiones --
# justamente lo que una refactorizacion futura puede mover de lugar sin que
# ningun test se queje.
PIPE="$REPO_ROOT/scripts/tdd-pipeline.sh"

echo "[1] tdd-pipeline.sh: el sufijo -<label> llega a rama/worktree, status y log del pipeline (CA-2)"
if grep -qF '[ -n "$VARIANT_LABEL" ] && BRANCH_NAME="${BRANCH_NAME}-${VARIANT_LABEL}"' "$PIPE"; then
    pass "la rama -- y con ella el path del worktree, derivado de BRANCH_NAME -- lleva el sufijo"
else
    fail "la rama no lleva el sufijo: dos variantes del mismo issue colisionarian"
fi
if grep -qF 'STATUS_FILENAME="pipeline-status-tdd-${ISSUE_NUM}-${VARIANT_LABEL}.json"' "$PIPE"; then
    pass "el archivo de status lleva el sufijo"
else
    fail "el status no lleva el sufijo: una variante pisaria el status de la otra"
fi
if grep -qF 'LOG_FILE="$LOG_DIR/pipeline-${TIMESTAMP}-${VARIANT_LABEL}.log"' "$PIPE"; then
    pass "el log del pipeline lleva el sufijo (dos variantes del mismo segundo comparten TIMESTAMP)"
else
    fail "el log del pipeline NO lleva el sufijo: dos variantes lanzadas en el mismo segundo escribirian al mismo archivo"
fi

echo ""
echo "[2] tdd-pipeline.sh: los nombres de log/metricas de stage usan ISSUE_LOG_TAG, no ISSUE_NUM directo"
# El patron a cazar es el prefijo comun de TODOS los nombres de log/metrics
# (`${TIMESTAMP}-issue-<tag>`), no solo los que terminan en .log/.json: asi el
# chequeo cubre tambien las variantes -retry.log y -stage-N-<agente>.json de una
# sola vez. Anclarlo a TIMESTAMP es lo que evita el falso positivo sobre
# BRANCH_NAME="worktree-issue-${ISSUE_NUM}-${SLUG}", donde ISSUE_NUM directo es
# correcto (el sufijo de variante se agrega aparte, sobre BRANCH_NAME ya armado).
if grep -qE '\$\{TIMESTAMP\}-issue-\$\{ISSUE_NUM\}' "$PIPE"; then
    fail "quedan nombres de log/metrics derivados de ISSUE_NUM directo (colisionan entre variantes)"
else
    pass "ningun nombre de log/metrics de stage deriva de ISSUE_NUM directo"
fi
LOG_TAG_HITS=$(grep -cF 'ISSUE_LOG_TAG' "$PIPE")
if [ "$LOG_TAG_HITS" -ge 8 ]; then
    pass "ISSUE_LOG_TAG cablea los nombres de log/metrics de stage ($LOG_TAG_HITS usos)"
else
    fail "solo $LOG_TAG_HITS usos de ISSUE_LOG_TAG: falta cablear algun nombre de log (stage, retry, scaffold, STAGE1_LOG, metrics, patch tw/im)"
fi

echo ""
echo "[3] tdd-pipeline.sh: en modo variante no hay push, PR, label/comentario de bloqueo ni comentario al issue (CA-3)"
if grep -qF 'if [ -n "$VARIANT_LABEL" ]; then' "$PIPE"; then
    pass "existe el gate por VARIANT_LABEL en la seccion de PR"
else
    fail "no hay gate por VARIANT_LABEL antes de crear el PR"
fi
# Los cuatro efectos externos deben estar ANIDADOS (con sangria) bajo el gate:
# en el nivel superior (columna 0) correrian tambien en modo variante.
if grep -qE '^git -C "\$WORKTREE_PATH" push' "$PIPE"; then
    fail "el push de la rama esta en el nivel superior: correria tambien en modo variante"
else
    pass "el push no esta en el nivel superior"
fi
if grep -qE '^gh issue comment' "$PIPE"; then
    fail "el comentario al issue esta en el nivel superior: correria tambien en modo variante"
else
    pass "el comentario al issue no esta en el nivel superior"
fi
if grep -qE '^ +git -C "\$WORKTREE_PATH" push -u origin' "$PIPE" \
    && grep -qE '^ +PR_URL=\$\(gh pr create' "$PIPE" \
    && grep -qE '^ +gh pr edit "\$PR_NUM" --add-label "bloqueado"' "$PIPE" \
    && grep -qE '^ +gh issue comment' "$PIPE"; then
    pass "push, gh pr create, gh pr edit (label bloqueado) y gh issue comment quedan anidados bajo el gate"
else
    fail "no se encontraron los cuatro efectos externos anidados bajo el gate (push / gh pr create / gh pr edit bloqueado / gh issue comment)"
fi

echo ""
echo "[3b] tdd-pipeline.sh: el reporte de bloqueo se preserva fuera del worktree en modo variante"
# Sin PR donde publicar su contenido, el reporte solo existe dentro del worktree
# -- que el cleanup elimina con --force al cierre. Si el aviso apunta al path
# del worktree en vez de a una copia en el repo principal, senala un archivo ya
# borrado en el momento en que el usuario lo lee.
if grep -qF 'VARIANT_BLOCKAGE_COPY="$(mefisto_state_path "blockage-report-tdd-${ISSUE_LOG_TAG}.md")"' "$PIPE"; then
    pass "el reporte se copia al estado canonico del repo principal, con el sufijo de variante"
else
    fail "el reporte de bloqueo no se preserva fuera del worktree: el cleanup lo borra antes de que se pueda leer"
fi

echo ""
echo "[4] tdd-pipeline.sh: el label viaja en el status y en las dos lineas de historial (CA-4)"
if grep -qF '"variant": ${VARIANT_LABEL_JSON:-null},' "$PIPE"; then
    pass "el JSON de status declara el campo variant"
else
    fail "el JSON de status no declara el campo variant"
fi
# Las dos lineas de historial se componen con jq -cn desde issue #1363 (antes,
# interpolacion de cadenas): el campo viaja como --argjson variant, no como
# literal "variant":${VARIANT_LABEL_JSON:-null}.
HISTORY_VARIANT_HITS=$(grep -cF -- '--argjson variant "${VARIANT_LABEL_JSON:-null}"' "$PIPE")
if [ "$HISTORY_VARIANT_HITS" -ge 2 ]; then
    pass "las dos lineas de pipeline-history.jsonl (completed y failed) llevan variant ($HISTORY_VARIANT_HITS)"
else
    fail "solo $HISTORY_VARIANT_HITS linea(s) de historial llevan variant: se esperan 2 (completed y failed)"
fi

LOG_HIST_ARGS=$(grep -cF -- '--arg log "' "$PIPE")
LOG_HIST_FIELDS=$(grep -cF ',log:' "$PIPE")
if [ "$LOG_HIST_ARGS" -ge 2 ] && [ "$LOG_HIST_FIELDS" -ge 2 ]; then
    pass "las entradas completed/failed declaran log en pipeline-history.jsonl (#1734)"
else
    fail "faltan --arg log / log: en las entradas terminales del historial"
fi

echo ""
echo "----------------------------------------"
echo "  tdd-pipeline.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

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
