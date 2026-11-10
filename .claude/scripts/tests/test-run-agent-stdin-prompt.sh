#!/usr/bin/env bash
# test-run-agent-stdin-prompt.sh -- Regresion ARG_MAX del canal de stdin del
# runner neutral (issue #1447; incidente de #1407, 2026-09-16: el reviewer
# recibio un prompt de 3.237.916 bytes por argv y el kernel
# rechazo el `exec` antes de arrancar -- duration_ms: 0, session_id: null, sin
# tokens; el writer si termino pero el reviewer nunca corrio).
#
# Contrato bajo prueba: runtime_fake_build_cmd (src/runtime/lib/runtime-fake.sh)
# materializa el prompt dentro de MEFISTO_RUNTIME_WORK_DIR y lo declara via
# MEFISTO_RUNTIME_STDIN_FILE; mefisto-process.sh conecta ese archivo a la
# entrada estandar del proceso EN VEZ del argv, asi que un prompt de
# cualquier tamano nunca pasa por `exec` (sujeto a ARG_MAX).
#
# Casos cubiertos:
#   [CA-5] Un fixture de tamano >= `getconf ARG_MAX` + 65536 bytes (saltos de
#       linea, tabuladores, `$`, `\` y UTF-8 multibyte, mas un centinela de 64
#       bytes), generado en $TMP -- nunca versionado --, corre como
#       --prompt-file de mefisto-run-agent.sh --runtime fake con el guion
#       dump-stdin: exit 0, exactamente un run.completed, el volcado de stdin
#       es identico byte a byte al fixture (`cmp`), el volcado de argv del
#       fake NO contiene el centinela (el prompt nunca viajo por argv) y
#       stdin no era TTY.
#   [CA-6] Control "no pasa en vacio": el MISMO fixture, pasado como un unico
#       argumento de argv con el idiom EXACTO de la rama Perl del watchdog
#       (`perl -e 'exec @ARGV' -- /usr/bin/true "$(cat fixture)"`), hace que
#       el propio `exec` de bash hacia `perl` falle con E2BIG ("Argument list
#       too long") -- demuestra que el fixture SI excede el limite real de
#       este host. El tamano del fixture se deriva siempre de `getconf
#       ARG_MAX` de la maquina donde corre el test (nunca de una constante
#       fija): si el host tuviera un limite mayor, el test se autoajusta en
#       vez de saltarse.
#
# Si `getconf ARG_MAX` no devuelve un entero o `perl` no esta en PATH, el
# test FALLA con un mensaje explicito -- nunca se salta en silencio (mismo
# criterio que test-watchdog-tty-isolation.sh con `tmux`).
#
# Uso: .claude/scripts/tests/test-run-agent-stdin-prompt.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.
# Bash 3.2 + jq 1.7 (MEF-ADR-0049 CA-6): sin arrays asociativos.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_ROOT/src/runtime/mefisto-run-agent.sh"

# El runner resuelve su adaptador via MEFISTO_RUNTIME_LIB_DIR y la EXPORTA
# (mefisto-runtime.sh la fija con `:=` solo si viene vacia). Un stage de
# pipeline de Mefisto ya la trae apuntando al repo de LANZAMIENTO, no al
# worktree en curso: sin fijarla, este test cargaria el runtime-fake.sh de
# ese otro arbol -- uno sin el guion `dump-stdin` -- y reprobaria un canal de
# stdin que en realidad esta bien (o peor: aprobaria el ajeno). Se pincha al
# lib/ de ESTE repo, mismo criterio que los bloques de PATH/LIB_DIR
# controlados de test-mefisto-run-agent.sh.
export MEFISTO_RUNTIME_LIB_DIR="$REPO_ROOT/src/runtime/lib"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

WORKDIR="$TMP/wt"; mkdir -p "$WORKDIR"

echo "[pre] getconf ARG_MAX y perl estan disponibles en este host (nunca se salta en silencio)"

ARG_MAX="$(getconf ARG_MAX 2>/dev/null)"
case "$ARG_MAX" in
    ''|*[!0-9]*)
        echo "FAIL: getconf ARG_MAX no devolvio un entero ('$ARG_MAX') -- este test exige el ARG_MAX real del host" >&2
        exit 1
        ;;
esac
pass "getconf ARG_MAX = $ARG_MAX"

if ! command -v perl >/dev/null 2>&1; then
    echo "FAIL: perl no esta en PATH -- CA-6 exige el mismo idiom que la rama Perl del watchdog" >&2
    exit 1
fi
pass "perl esta disponible en PATH"

if [ ! -x "$RUNNER" ]; then
    echo "FAIL: $RUNNER no existe o no es ejecutable" >&2
    exit 1
fi
pass "mefisto-run-agent.sh existe y es ejecutable"

# ============================================================================
echo ""
echo "[fixture] Generando un prompt >= ARG_MAX + 65536 bytes (no versionado, vive en \$TMP)"

# Centinela de EXACTAMENTE 64 bytes (padded con espacios): su unica funcion es
# demostrar que el contenido del prompt nunca aparece en el volcado de argv
# del "CLI fake" -- solo puede sobrevivir en el volcado de STDIN.
SENTINEL="$(printf '%-64s' 'MEFISTO_ARGMAX_SENTINEL_1447')"
SENTINEL_SIZE="${#SENTINEL}"
TARGET_SIZE=$((ARG_MAX + 65536))
BODY_SIZE=$((TARGET_SIZE - SENTINEL_SIZE))

# El bloque repetido cubre los caracteres exigidos por CA-5: salto de linea,
# tabulador, '$', '\' y UTF-8 multibyte (acentos + CJK).
BLOCK_FILE="$TMP/block.txt"
printf 'linea con tab\tdolar $HOME y barra \\ y unicode: ñáéíóú 日本語\n' > "$BLOCK_FILE"

FIXTURE="$TMP/fixture-argmax.bin"
yes "$(cat "$BLOCK_FILE")" 2>/dev/null | head -c "$BODY_SIZE" > "$FIXTURE"
printf '%s' "$SENTINEL" >> "$FIXTURE"

FIXTURE_SIZE="$(wc -c < "$FIXTURE" | tr -d ' ')"
if [ "$FIXTURE_SIZE" -ge "$TARGET_SIZE" ]; then
    pass "fixture: $FIXTURE_SIZE bytes (>= ARG_MAX $ARG_MAX + 65536 = $TARGET_SIZE)"
else
    fail "fixture: $FIXTURE_SIZE bytes (se esperaba >= $TARGET_SIZE)"
fi

if grep -qF "$SENTINEL" "$FIXTURE" 2>/dev/null; then
    pass "fixture: contiene el centinela de 64 bytes"
else
    fail "fixture: no se encontro el centinela dentro del fixture"
fi

# ============================================================================
echo ""
echo "[CA-6] Control: el MISMO fixture como argv unico excede el ARG_MAX real de este host (no pasa en vacio)"

CONTROL_ERR="$TMP/control-argmax.err"
perl -e 'exec @ARGV' -- /usr/bin/true "$(cat "$FIXTURE")" >/dev/null 2>"$CONTROL_ERR"
CONTROL_RC=$?

if [ "$CONTROL_RC" -ne 0 ]; then
    pass "CA-6-1: el exec del fixture como argv unico falla (exit $CONTROL_RC != 0)"
else
    fail "CA-6-1: el exec del fixture como argv unico NO fallo -- el fixture no excede el ARG_MAX real de este host"
fi

if grep -qi "argument list too long" "$CONTROL_ERR" 2>/dev/null; then
    pass "CA-6-2: el fallo es E2BIG ('Argument list too long'), el mismo idiom que la rama Perl del watchdog"
else
    fail "CA-6-2: no se encontro 'Argument list too long' en la salida: $(cat "$CONTROL_ERR" 2>/dev/null)"
fi

# ============================================================================
echo ""
echo "[CA-5] mefisto-run-agent.sh transporta el fixture por stdin, no por argv"

EVENT_LOG="$TMP/event-log.jsonl"
DUMP_FILE="$TMP/stdin-dump.bin"
ARGS_FILE="$TMP/fake-args.txt"

MEFISTO_FAKE_SCRIPT=dump-stdin MEFISTO_FAKE_STDIN_DUMP_FILE="$DUMP_FILE" MEFISTO_FAKE_ARGS_FILE="$ARGS_FILE" \
    "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$FIXTURE" --event-log "$EVENT_LOG" --timeout 60 >/dev/null 2>&1
RUN_RC=$?

if [ "$RUN_RC" -eq 0 ]; then
    pass "CA-5-1: el runner termina con exit 0 pese a un prompt >= ARG_MAX"
else
    fail "CA-5-1: exit $RUN_RC (se esperaba 0)"
fi

TERMS="$(jq -c 'select(.type == "run.completed" or .type == "run.failed")' "$EVENT_LOG" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$TERMS" = "1" ]; then
    pass "CA-5-2: exactamente 1 evento terminal en --event-log"
else
    fail "CA-5-2: se contaron $TERMS eventos terminales (se esperaba 1)"
fi

if jq -e 'select(.type == "run.completed") | .status == "success"' "$EVENT_LOG" >/dev/null 2>&1; then
    pass "CA-5-3: el terminal es run.completed{status:success}"
else
    fail "CA-5-3: no se encontro run.completed{status:success} en --event-log: $(cat "$EVENT_LOG" 2>/dev/null)"
fi

if [ -f "$DUMP_FILE" ] && cmp -s "$FIXTURE" "$DUMP_FILE"; then
    pass "CA-5-4: el volcado de stdin es identico byte a byte al fixture (cmp)"
else
    fail "CA-5-4: el volcado de stdin difiere del fixture original"
fi

if [ -f "$ARGS_FILE" ] && ! grep -qF "$SENTINEL" "$ARGS_FILE"; then
    pass "CA-5-5: el volcado de argv del fake NO contiene el centinela (el prompt nunca paso por argv)"
else
    fail "CA-5-5: el centinela aparecio en el volcado de argv -- el prompt viajo por argv, no por stdin"
fi

if grep -qxF "STDIN_TTY=0" "$ARGS_FILE" 2>/dev/null; then
    pass "CA-5-6: stdin NO era TTY (el aislamiento de #943 se conserva con el canal nuevo)"
else
    fail "CA-5-6: no se registro STDIN_TTY=0 en el volcado de argv: $(cat "$ARGS_FILE" 2>/dev/null)"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
