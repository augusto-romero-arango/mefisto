#!/usr/bin/env bash
# test-tooling-variant.sh -- Tests del modo --variant (corridas paralelas del
# mismo issue, issue #710) en scripts/_pipeline-common.sh, scripts/launch-pipeline.sh
# y scripts/herdr-pipeline.sh.
#
# Cubre:
#   validate_variant_label - vacio, longitud (40 chars limite, 41 rechazado),
#                            caracteres validos ([a-z0-9-]) e invalidos
#                            (mayusculas, espacios, guion bajo, unicode) -- todos
#                            los casos invalidos dejan el motivo en
#                            PIPELINE_VARIANT_LABEL_ERROR (CA-1), sin imprimir
#                            nada por si misma.
#   launch-pipeline.sh      - --tooling reenvia --variant intacto al
#                            sub-pipeline, combinado con --from-stage/--models
#                            en orden (CA-2). --variant sin valor aborta. El enrutamiento
#                            automatico de un unico issue (sin --tooling
#                            explicito) TAMBIEN lo acepta y lo reenvia (issue
#                            #713: tdd-pipeline.sh suma el flag, ya no es
#                            exclusivo de --tooling/tooling-pipeline.sh) --
#                            cubierto en detalle por test-tdd-variant.sh. El
#                            resto de los modos (--infra, --scaffold, --batch,
#                            --parallel, multiples issues) lo sigue
#                            rechazando con mensaje explicito: serian ambiguos
#                            sobre un lote, o el sub-script destino no
#                            implementa el flag.
#   herdr-pipeline.sh       - misma superficie que launch-pipeline.sh: --tooling
#                            y el enrutamiento automatico reenvian --variant al
#                            pane run (con --models combinado), y el resto de
#                            los modos lo rechaza.
#
# El modo variante dentro del propio pipeline (sufijos, sin push ni PR, label en
# status e historial) lo cubre scripts/tests/tooling-pipeline.test.mts.
#
# Uso: scripts/tests/test-tooling-variant.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

export HERDR_STUB_OWNER_PID=$$

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# validate_variant_label vive en _pipeline-common.sh; sourcearlo solo la
# define (es una libreria, no ejecuta nada), asi que es seguro incluso dentro
# del repo de Mefisto.
set +u
source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null
set -u

echo "[1] validate_variant_label: label vacio se rechaza (CA-1)"
if validate_variant_label ""; then fail "label vacio no deberia retornar 0"; else pass "label vacio aborta"; fi
if printf '%s' "$PIPELINE_VARIANT_LABEL_ERROR" | grep -qi "vacio"; then pass "el error menciona 'vacio'"; else fail "PIPELINE_VARIANT_LABEL_ERROR inesperado: '$PIPELINE_VARIANT_LABEL_ERROR'"; fi

echo ""
echo "[2] validate_variant_label: label valido de una letra"
if validate_variant_label "a"; then pass "label de 1 char retorna 0"; else fail "'a' no deberia rechazarse"; fi

echo ""
echo "[3] validate_variant_label: slug tipico valido"
if validate_variant_label "experimento-a"; then pass "'experimento-a' retorna 0"; else fail "'experimento-a' no deberia rechazarse"; fi

echo ""
echo "[4] validate_variant_label: limite de longitud (40 OK, 41 rechazado)"
LABEL_40=$(printf 'a%.0s' $(seq 1 40))
LABEL_41=$(printf 'a%.0s' $(seq 1 41))
if [ "${#LABEL_40}" -eq 40 ] && [ "${#LABEL_41}" -eq 41 ]; then pass "fixtures de longitud correctas"; else fail "fixtures mal construidas"; fi
if validate_variant_label "$LABEL_40"; then pass "label de 40 chars retorna 0"; else fail "40 chars no deberia rechazarse"; fi
if validate_variant_label "$LABEL_41"; then fail "label de 41 chars no deberia retornar 0"; else pass "41 chars aborta"; fi
if printf '%s' "$PIPELINE_VARIANT_LABEL_ERROR" | grep -q "40 caracteres"; then pass "el error menciona el limite de 40 caracteres"; else fail "PIPELINE_VARIANT_LABEL_ERROR inesperado: '$PIPELINE_VARIANT_LABEL_ERROR'"; fi

echo ""
echo "[5] validate_variant_label: caracteres invalidos se rechazan (CA-1)"
for bad in "Experimento" "experimento_a" "experimento a" "experimento.a" "a/b"; do
    if validate_variant_label "$bad"; then
        fail "'$bad' no deberia retornar 0"
    else
        pass "'$bad' aborta"
    fi
    if printf '%s' "$PIPELINE_VARIANT_LABEL_ERROR" | grep -qF "$bad"; then
        pass "el error nombra el label invalido '$bad'"
    else
        fail "PIPELINE_VARIANT_LABEL_ERROR no menciona '$bad': '$PIPELINE_VARIANT_LABEL_ERROR'"
    fi
done

echo ""
echo "[6] validate_variant_label: digitos y guiones solos son validos"
if validate_variant_label "123-456"; then pass "'123-456' retorna 0"; else fail "'123-456' no deberia rechazarse"; fi

echo ""
echo "----------------------------------------"
echo "  _pipeline-common.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- launch-pipeline.sh: reenvio/rechazo de --variant por modo (CA-2/CA-5) ---
#
# Mismo arnes que test-stage-models.sh: consumidor falso (git init sin
# .claude-plugin/plugin.json) para pasar el guard defensivo y MEFISTO_UI=mod
# para no delegar a la interfaz herdr si el test corre dentro de un pane herdr.
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
echo "[7] --tooling reenvia --variant intacto al sub-pipeline (CA-2)"
run_wrapper --tooling 253 --variant experimento-a
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --variant corre sin abortar (rc=$LAST_RC)"; else fail "--tooling + --variant no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tooling-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tooling <253> <--variant> <experimento-a>"; then
    pass "tooling-pipeline.sh recibe el issue y --variant con el valor intacto"
else
    fail "tooling-pipeline.sh no recibio '253 --variant ...' -- argv: $ARGV"
fi

echo ""
echo "[8] --tooling combina --from-stage, --models y --variant en orden"
run_wrapper --tooling 253 --from-stage 2 --models "reviewer=opus" --variant b
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tooling-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tooling <253> <--from-stage> <2> <--models> <reviewer=opus> <--variant> <b>"; then
    pass "tooling-pipeline.sh recibe los tres flags en orden"
else
    fail "orden incorrecto -- argv: $ARGV"
fi

echo ""
echo "[9] --variant sin valor aborta con mensaje claro"
run_wrapper --tooling 253 --variant
if [ "$LAST_RC" -eq 1 ]; then pass "--variant sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --variant"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[10] --variant se rechaza (nunca se traga en silencio) en modos sin soporte"

run_wrapper --infra 253 --variant a
if [ "$LAST_RC" -eq 1 ]; then pass "--infra + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --infra"; then pass "mensaje: no valido con --infra"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_wrapper --scaffold 253 --domain miDominio --variant a
if [ "$LAST_RC" -eq 1 ]; then pass "--scaffold + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --scaffold"; then pass "mensaje: no valido con --scaffold"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_wrapper --batch 253 254 --variant a --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_wrapper --parallel 253 254 --variant a --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--parallel + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --parallel"; then pass "mensaje: no valido con --parallel"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_wrapper 253 254 --variant a
if [ "$LAST_RC" -eq 1 ]; then pass "multiples issues + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con multiples issues"; then pass "mensaje: no valido con multiples issues"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[11] issue suelto (sin --tooling explicito), enrutado por --pipeline tooling, acepta --variant (issue #713: tdd-pipeline.sh tambien lo implementa, ya no es exclusivo de --tooling)"
run_wrapper 253 --variant a --pipeline tooling
if [ "$LAST_RC" -eq 0 ]; then pass "issue suelto + --pipeline tooling + --variant corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tooling-pipeline-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tooling <253> <--variant> <a>"; then
    pass "tooling-pipeline.sh recibe --variant con el valor intacto"
else
    fail "tooling-pipeline.sh no recibio '253 --variant ...' -- argv: $ARGV"
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

cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -u
case "${3:-}" in
    253|254) printf 'OPEN|tipo:tooling\n' ;;
    *)       exit 1 ;;
esac
STUB
chmod +x "$FAKE_BIN/gh"

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
echo "[12] herdr: --tooling reenvia --variant al pane run, con --models combinado"
run_herdr --tooling 253 --models "writer=sonnet" --variant experimento-a
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --models + --variant corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models writer=sonnet --variant experimento-a"; then
    pass "el pane run lleva --models y --variant, en ese orden, con el valor intacto"
else
    fail "el pane run no lleva la combinacion esperada -- log: $HERDR_CALLS"
fi

echo ""
echo "[13] herdr: --tooling reenvia --variant solo (sin --models)"
run_herdr --tooling 253 --variant b
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --variant corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--variant b"; then
    pass "el pane run lleva --variant"
else
    fail "el pane run no lleva --variant -- log: $HERDR_CALLS"
fi

echo ""
echo "[14] herdr: --variant sin valor y rechazo por modo (nunca silencio)"
run_herdr --tooling 253 --variant
if [ "$LAST_RC" -eq 1 ]; then pass "--variant sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --variant"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_herdr --infra 253 --variant a
if [ "$LAST_RC" -eq 1 ]; then pass "--infra + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q -- "--infra"; then pass "mensaje: nombra --infra"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_herdr --parallel 253 254 --variant a --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--parallel + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$(cat "$HERDR_STUB_LOG")" | grep -q "pane run"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

run_herdr --batch 253 254 --variant a --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi

run_herdr 253 --variant a --pipeline tooling
if [ "$LAST_RC" -eq 0 ]; then pass "issue suelto + --pipeline tooling + --variant corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--variant a"; then
    pass "el pane run lleva --variant (issue #713: ya no exclusivo de --tooling)"
else
    fail "el pane run no lleva --variant -- log: $HERDR_CALLS"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
