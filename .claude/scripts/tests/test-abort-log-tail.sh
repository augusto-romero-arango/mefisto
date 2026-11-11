#!/usr/bin/env bash
# test-abort-log-tail.sh -- Tests del emisor de tail del log en abort() (issue #379).
#
# Contexto (incidente del batch mefisto-batch-125628, 2026-07-26): cuando `gh pr
# create` fallaba, el log del batch solo mostraba "ERROR: No se pudo crear el
# PR" -- la causa real ("a pull request ... already exists") quedaba en OTRO
# archivo (el log del pipeline). abort() redirige stderr de los comandos
# externos al log del pipeline pero nunca lo mostraba.
#
# Arreglo: _tail_log_for_abort() emite por stdout las ultimas N lineas del log
# (sin ANSI) bajo un encabezado explicito; abort() lo captura en una variable
# antes de escribir nada y lo reemite en SU stream, antes de llamar a
# update_status. Esta funcion vive duplicada en los pipelines bash "ricos"; el
# de tooling publicado, ya en TypeScript, usa scripts/lib/pipeline/pipeline-log.mts
# (mismo patron que _strip_ansi/log/success/warn/header, que ya estan
# duplicadas per-pipeline y no centralizadas en _mefisto-common.sh /
# _pipeline-common.sh).
#
# Casos cubiertos (CA-1/CA-3/CA-6):
#   - log con contenido    -> devuelve las ultimas N lineas sin ANSI, con encabezado
#   - log inexistente      -> no imprime nada, no falla (exit 0)
#   - log vacio             -> no imprime nada, no falla (exit 0)
#   - log con menos de N   -> devuelve todas las lineas disponibles, no falla
#   - ANSI                  -> los codigos de color no aparecen en la salida
#   - stdout                -> emite por stdout, no por stderr (el stream lo elige abort)
#   - paridad de copias    -> el cuerpo de la funcion es identico en los pipelines bash
#   - captura antes del tee -> el tail no incluye la propia linea de ERROR de abort
#   - stream por pipeline  -> el tail sale por el mismo stream que el resto de abort
#
# Uso: .claude/scripts/tests/test-abort-log-tail.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

INTERNAL_PIPELINE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"
PUBLISHED_TDD="$REPO_ROOT/scripts/tdd-pipeline.sh"

# extract_fn <function_name> <file>
#
# Extrae el cuerpo de una funcion bash desde "<nombre>() {" hasta el "}" que
# cierra en columna 0 (mismo patron que extract_helper_body en
# test-pr-reuse-gate.sh).
extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# --- Preparar entorno de la funcion bajo prueba (sin ejecutar el pipeline completo) ---
# abort() y sus dependencias corren top-level (arg parsing, assert_in_mefisto...)
# antes de llegar a definir las funciones; sourcing el archivo completo dispararia
# ese codigo. En vez de eso extraemos SOLO _strip_ansi y _tail_log_for_abort y las
# evaluamos en este proceso, igual que test-pr-reuse-gate.sh extrae find_open_pr_for_branch
# para el chequeo de paridad (aqui ademas se ejecuta, no solo se compara texto).
YELLOW=""
NC=""

load_tail_fn() {
    local file="$1"
    local strip_body tail_body
    strip_body=$(extract_fn "_strip_ansi" "$file")
    tail_body=$(extract_fn "_tail_log_for_abort" "$file")
    [ -n "$strip_body" ] && [ -n "$tail_body" ] || return 1
    eval "$strip_body"
    eval "$tail_body"
}

echo "[pre] _tail_log_for_abort se puede cargar y ejecutar desde cada pipeline"
for f in "$INTERNAL_PIPELINE" "$PUBLISHED_TDD"; do
    if load_tail_fn "$f" && declare -F _tail_log_for_abort >/dev/null; then
        pass "$(basename "$f"): _tail_log_for_abort definida y cargable"
    else
        fail "$(basename "$f"): no se pudo extraer/cargar _tail_log_for_abort"
    fi
done

# A partir de aqui trabajamos con la copia cargada del pipeline interno (las dos
# son funcionalmente identicas -- lo verifica el bloque de paridad mas abajo).
load_tail_fn "$INTERNAL_PIPELINE"

echo ""
echo "[A] Log con contenido -> ultimas N lineas sin ANSI, con encabezado (CA-1)"

for i in $(seq 1 30); do
    printf '\033[0;31mlinea %02d\033[0m\n' "$i"
done > "$TMP/con-contenido.log"

# Capturamos SOLO stdout (sin 2>&1) a proposito: la funcion debe emitir por
# stdout para que cada abort elija el stream. El stderr se manda a un archivo
# aparte para verificar que quedo vacio.
OUT=$(_tail_log_for_abort "$TMP/con-contenido.log" 20 2>"$TMP/stderr-a.txt")
RC=$?

if [ ! -s "$TMP/stderr-a.txt" ]; then
    pass "emite por stdout, no por stderr (el stream lo elige abort)"
else
    fail "escribio a stderr: $(cat "$TMP/stderr-a.txt")"
fi

if [ "$RC" -eq 0 ]; then
    pass "exit 0 con log no vacio"
else
    fail "se esperaba exit 0, se obtuvo $RC"
fi

if echo "$OUT" | grep -q "Ultimas 20 lineas del log:"; then
    pass "encabezado explicito presente"
else
    fail "no se encontro el encabezado 'Ultimas 20 lineas del log:'"
fi

if echo "$OUT" | grep -q "linea 11" && echo "$OUT" | grep -q "linea 30" && ! echo "$OUT" | grep -q "linea 10"; then
    pass "devuelve exactamente las ultimas 20 lineas (11..30)"
else
    fail "el rango de lineas no es el esperado: $OUT"
fi

if printf '%s' "$OUT" | od -c | grep -q '033'; then
    fail "quedaron codigos ANSI en la salida"
else
    pass "sin codigos ANSI en la salida"
fi

echo ""
echo "[B] Log inexistente -> no imprime nada, no falla (CA-3)"

OUT=$(_tail_log_for_abort "$TMP/no-existe.log" 20 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && [ -z "$OUT" ]; then
    pass "log inexistente: exit 0 y sin salida"
else
    fail "log inexistente: se esperaba exit 0 y vacio, se obtuvo rc=$RC out='$OUT'"
fi

echo ""
echo "[C] Log vacio -> no imprime nada, no falla (CA-3)"

: > "$TMP/vacio.log"
OUT=$(_tail_log_for_abort "$TMP/vacio.log" 20 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && [ -z "$OUT" ]; then
    pass "log vacio: exit 0 y sin salida"
else
    fail "log vacio: se esperaba exit 0 y vacio, se obtuvo rc=$RC out='$OUT'"
fi

echo ""
echo "[D] Log con menos de N lineas -> devuelve todas, no falla (CA-3)"

printf 'a\nb\nc\n' > "$TMP/corto.log"
OUT=$(_tail_log_for_abort "$TMP/corto.log" 20 2>&1)
RC=$?
LINE_COUNT=$(echo "$OUT" | grep -Ec '^[abc]$')
if [ "$RC" -eq 0 ] && [ "$LINE_COUNT" -eq 3 ]; then
    pass "log mas corto que N: exit 0 y devuelve las 3 lineas disponibles"
else
    fail "log mas corto que N: se esperaba exit 0 y 3 lineas, se obtuvo rc=$RC out='$OUT'"
fi

echo ""
echo "[E] Paridad: el cuerpo de _tail_log_for_abort es identico en los pipelines bash"

BODY_INTERNAL=$(extract_fn "_tail_log_for_abort" "$INTERNAL_PIPELINE")
BODY_TDD=$(extract_fn "_tail_log_for_abort" "$PUBLISHED_TDD")

if [ -z "$BODY_INTERNAL" ] || [ -z "$BODY_TDD" ]; then
    fail "paridad: no se pudo extraer el cuerpo de _tail_log_for_abort de alguna copia"
elif [ "$BODY_INTERNAL" = "$BODY_TDD" ]; then
    pass "paridad: identico en mefisto-tooling-pipeline.sh y tdd-pipeline.sh"
else
    fail "paridad: las copias DERIVARON entre si"
    diff <(echo "$BODY_INTERNAL") <(echo "$BODY_TDD") || true
fi

echo ""
echo "[F] Orden dentro de abort(): captura del tail < tee del ERROR < update_status (CA-4)"

# El tail tiene que leerse antes de las DOS escrituras que abort hace:
#   - el `tee -a` de su propia linea de ERROR al log -- si se leyera despues, las
#     dos ultimas lineas del tail serian un eco del mensaje ya impreso, ruido que
#     ademas se come dos lineas del contexto real;
#   - `update_status`, que reescribe el status file (nota tecnica del issue).
for f in "$INTERNAL_PIPELINE" "$PUBLISHED_TDD"; do
    ABORT_BODY=$(extract_fn "abort" "$f")
    TAIL_LINE=$(echo "$ABORT_BODY" | grep -n "_tail_log_for_abort " | head -1 | cut -d: -f1)
    TEE_LINE=$(echo "$ABORT_BODY" | grep -n "tee -a " | head -1 | cut -d: -f1)
    STATUS_LINE=$(echo "$ABORT_BODY" | grep -n "update_status " | head -1 | cut -d: -f1)
    if [ -z "$TAIL_LINE" ] || [ -z "$TEE_LINE" ] || [ -z "$STATUS_LINE" ]; then
        fail "$(basename "$f"): falta alguna llamada (tail=$TAIL_LINE, tee=$TEE_LINE, status=$STATUS_LINE)"
    elif [ "$TAIL_LINE" -lt "$TEE_LINE" ] && [ "$TEE_LINE" -lt "$STATUS_LINE" ]; then
        pass "$(basename "$f"): tail($TAIL_LINE) < tee($TEE_LINE) < update_status($STATUS_LINE)"
    else
        fail "$(basename "$f"): orden incorrecto (tail=$TAIL_LINE, tee=$TEE_LINE, status=$STATUS_LINE)"
    fi
done

echo ""
echo "[G] El tail sale por el mismo stream que el resto de los mensajes de abort()"

# abort() no usa el mismo stream en todos los pipelines: el interno manda todo a
# stderr (>&2), los publicados a stdout. Por eso _tail_log_for_abort emite
# por stdout y abort decide -- pero la reemision del tail tiene que coincidir con
# el stream de sus mensajes hermanos, o el humano que redirige un solo stream se
# queda con el diagnostico partido en dos.
for f in "$INTERNAL_PIPELINE" "$PUBLISHED_TDD"; do
    ABORT_BODY=$(extract_fn "abort" "$f")
    # Stream de referencia: la linea "Revisa el log:" que ya existia.
    REF_LINE=$(echo "$ABORT_BODY" | grep "Revisa el log:" | head -1)
    TAIL_ECHO_LINE=$(echo "$ABORT_BODY" | grep 'echo "\$log_tail"' | head -1)
    if [ -z "$TAIL_ECHO_LINE" ]; then
        fail "$(basename "$f"): no se encontro la reemision del tail capturado"
        continue
    fi
    REF_STDERR=no; TAIL_STDERR=no
    case "$REF_LINE"       in *">&2"*) REF_STDERR=yes ;; esac
    case "$TAIL_ECHO_LINE" in *">&2"*) TAIL_STDERR=yes ;; esac
    if [ "$REF_STDERR" = "$TAIL_STDERR" ]; then
        pass "$(basename "$f"): tail y mensajes de abort comparten stream (stderr=$TAIL_STDERR)"
    else
        fail "$(basename "$f"): streams desalineados (mensajes stderr=$REF_STDERR, tail stderr=$TAIL_STDERR)"
    fi
done

echo ""
echo "[H] Funcional: la causa real llega al stream de abort y el tail no ecoa el ERROR (CA-2)"

# Reproduce el escenario del incidente sobre un log temporal: el pipeline dejo en
# el log la causa real de `gh pr create`, abort corre, y la causa tiene que salir
# por el stream de abort SIN que la propia linea de ERROR cierre el tail.
SIM_LOG="$TMP/sim-pipeline.log"
for i in $(seq 1 6); do echo "[13:15:0$i] paso $i del pipeline" >> "$SIM_LOG"; done
echo 'a pull request for branch "worktree-mefisto-issue-360-x" into branch "main" already exists:' >> "$SIM_LOG"

SIM_TAIL="$(_tail_log_for_abort "$SIM_LOG" 20)"
# Emular la escritura que abort hace DESPUES de capturar el tail.
printf '\nx ERROR: No se pudo crear el PR\n' >> "$SIM_LOG"

if echo "$SIM_TAIL" | grep -q "already exists"; then
    pass "la causa real ('already exists') viaja en el tail"
else
    fail "la causa real no aparece en el tail: $SIM_TAIL"
fi

if echo "$SIM_TAIL" | grep -q "x ERROR:"; then
    fail "el tail ecoa la propia linea de ERROR de abort (se leyo despues del tee)"
else
    pass "el tail no ecoa la linea de ERROR de abort"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
