#!/usr/bin/env bash
# test-mefisto-test-suite.sh -- Tests de
# src/internal/scripts/mefisto-test-suite.sh (issue #1416).
#
# Cubre:
#   [pre] El entrypoint existe con sintaxis bash valida, no cita literalmente
#         '.claude/pipeline'/'CLAUDE_PLUGIN_ROOT'/'CLAUDE_PROJECT_DIR' (ni
#         siquiera en comentarios -- restriccion de neutralidad del issue
#         #1416), y su shim en .claude/scripts/ es byte-a-byte identico a la
#         plantilla de src/internal/scripts/README.md (R4) y reenvia de
#         verdad.
#   [A] --help imprime uso y termina en 0; un argumento desconocido y
#       '--log-dir' sin valor abortan en 1 con mensaje accionable, sin tocar
#       git ni crear ningun run dir.
#   [B] Invocacion desde un subdirectorio del repo fixture, sin --log-dir:
#       resuelve la misma raiz, crea un run dir unico bajo
#       .mefisto/pipeline/test-suite/ y termina en 0 con las tres entradas
#       PASS.
#   [C] --log-dir explicito con espacios: se crea si no existe y ahi quedan
#       los tres results.tsv.
#   [D] Cero fallos: exit 0, veredicto PASS, conteos correctos.
#   [E] Un fallo: exit 1, veredicto FAIL, la entrada FAIL aparece en el
#       resumen con su log.
#   [F] Multiples fallos en carriles distintos: exit 1, subtotales y totales
#       reflejan el conteo real (sin depender de ningun numero historico).
#   [G] Orden estable del resumen: aunque el carril 'interno' tarde mas que
#       'publicado' en terminar, el resumen siempre imprime publicado ->
#       interno -> canonico-adicional.
#   [H] Determinismo (CA-3): dos corridas con el mismo --log-dir y los mismos
#       resultados producen el mismo resumen tras normalizar SOLO las
#       duraciones (la unica variacion que CA-3 permite); los conteos y el
#       orden se comparan literalmente.
#   [I] Inventario invalido (carril vacio + fuente canonica huerfana): aborta
#       en 1 SIN crear ningun run dir nuevo bajo .mefisto/pipeline/test-suite/,
#       y reporta las violaciones de las DOS validaciones (no corta en la
#       primera que falla).
#   [J] Cobertura canonica incompleta (fuente sin shim ni registro): aborta
#       en 1 sin lanzar ninguna prueba.
#   [K] Senal INT dentro de una pty real (igual que
#       test-mefisto-test-executor.sh [H]/[I]): termina en 130, con al menos
#       una entrada CANCELLED reflejada en el resumen.
#   [L] Senal TERM: identico a [K] pero con 143.
#
# Requiere `python3` para [K]/[L] (fixtures/pty-run.py da la pty real); si no
# esta en PATH, esos bloques FALLAN explicitamente, nunca se saltan en
# silencio (mismo criterio que test-mefisto-test-executor.sh).
#
# Nunca ejecuta la suite real de Mefisto: todo corre contra un repo fixture
# temporal (mktemp + git init) con sleepers/recorders sinteticos copiados
# junto al entrypoint y las dos bibliotecas que consume.
#
# Uso: .claude/scripts/tests/test-mefisto-test-suite.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

CANON="$REPO_ROOT/src/internal/scripts/mefisto-test-suite.sh"
SHIM="$REPO_ROOT/.claude/scripts/mefisto-test-suite.sh"
CANON_INVENTORY_LIB="$REPO_ROOT/src/internal/scripts/lib/mefisto-test-inventory.sh"
CANON_EXECUTOR_LIB="$REPO_ROOT/src/internal/scripts/lib/mefisto-test-executor.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[pre] El entrypoint existe, tiene sintaxis valida y respeta la restriccion de neutralidad"

if [ -f "$CANON" ]; then
    pass "mefisto-test-suite.sh presente en src/internal/scripts/"
else
    fail "mefisto-test-suite.sh no existe en src/internal/scripts/"
    echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
    exit 1
fi

if bash -n "$CANON" 2>/dev/null; then
    pass "sintaxis bash valida"
else
    fail "sintaxis bash invalida"
fi

# Restriccion de neutralidad del issue #1416: ni siquiera en prosa/comentarios
# (R3 del gate es un grep crudo sobre texto, no distingue mencion de uso).
for forbidden in ".claude/pipeline" "CLAUDE_PLUGIN_ROOT" "CLAUDE_PROJECT_DIR"; do
    if grep -qF -- "$forbidden" "$CANON"; then
        fail "el entrypoint cita literalmente '$forbidden' (R3 lo marcaria como fuga)"
    else
        pass "el entrypoint no cita '$forbidden'"
    fi
done

EXPECTED_SHIM=$'#!/usr/bin/env bash\n# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/. No editar.\nexec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"'
if [ -f "$SHIM" ] && printf '%s\n' "$EXPECTED_SHIM" | cmp -s - "$SHIM"; then
    pass "el shim de .claude/scripts/ es byte-a-byte identico a la plantilla (R4)"
else
    fail "el shim de .claude/scripts/ no coincide con la plantilla de tres lineas"
fi

# bash 3.2 real (macOS): mismo criterio que el resto de la suite de #1438/#1440.
BASH_BIN="/bin/bash"
[ -x "$BASH_BIN" ] || BASH_BIN="bash"

for forbidden in "declare -A" "mapfile" "readarray" "wait -n"; do
    CODE_ONLY="$(grep -v '^[[:space:]]*#' "$CANON")"
    if printf '%s' "$CODE_ONLY" | grep -q -- "$forbidden"; then
        fail "usa '$forbidden': rompe en bash 3.2"
    else
        pass "no usa '$forbidden' (compatible bash 3.2)"
    fi
done

# -------- Fixture repo compartido --------------------------------------

TMPDIR_ROOT=$(cd "$(mktemp -d)" && pwd -P)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# new_fixture <nombre>
#
# Crea bajo $TMPDIR_ROOT/<nombre> un repo git minimo con el entrypoint y las
# dos bibliotecas que consume copiados en su layout real
# (src/internal/scripts/{,lib/}), mas un carril 'publicado' y uno 'interno'
# con una entrada trivial cada uno (para que el inventario nunca quede
# vacio). El carril 'canonico-adicional' se resuelve via
# MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES al invocar, no por convencion de
# archivo -- igual que test-mefisto-test-inventory.sh. Deja la ruta en
# FIXTURE (variable global, no subshell).
new_fixture() {
    local name="$1"
    FIXTURE="$TMPDIR_ROOT/$name"
    mkdir -p "$FIXTURE/src/internal/scripts/lib" "$FIXTURE/scripts/tests" "$FIXTURE/.claude/scripts/tests" "$FIXTURE/extra"

    git init -q "$FIXTURE"
    git -C "$FIXTURE" config user.email "test@mefisto.local"
    git -C "$FIXTURE" config user.name "Mefisto Test"

    cp "$CANON" "$FIXTURE/src/internal/scripts/mefisto-test-suite.sh"
    cp "$CANON_INVENTORY_LIB" "$FIXTURE/src/internal/scripts/lib/mefisto-test-inventory.sh"
    cp "$CANON_EXECUTOR_LIB" "$FIXTURE/src/internal/scripts/lib/mefisto-test-executor.sh"
    chmod +x "$FIXTURE/src/internal/scripts/mefisto-test-suite.sh"

    printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE/scripts/tests/test-pub-ok.sh"
    chmod +x "$FIXTURE/scripts/tests/test-pub-ok.sh"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE/.claude/scripts/tests/test-int-ok.sh"
    chmod +x "$FIXTURE/.claude/scripts/tests/test-int-ok.sh"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE/extra/test-adicional-ok.sh"
    chmod +x "$FIXTURE/extra/test-adicional-ok.sh"

    git -C "$FIXTURE" add -A
    git -C "$FIXTURE" commit -q -m "base"
}

# run_suite <fixture> <args...>
#
# Invoca el entrypoint del fixture con MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES
# apuntando a extra/test-adicional-ok.sh (carril canonico-adicional resuelto
# sin depender del registro real de Mefisto), desde $FIXTURE como cwd salvo
# que RUN_SUITE_CD la sobreescriba. Imprime stdout+stderr combinados; el rc
# queda en $?.
run_suite() {
    local fixture="$1"; shift
    local cd_dir="${RUN_SUITE_CD:-$fixture}"
    ( cd "$cd_dir" && env -u MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES \
        MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES="extra/test-adicional-ok.sh" \
        "$BASH_BIN" "$fixture/src/internal/scripts/mefisto-test-suite.sh" "$@" 2>&1 )
}

new_fixture "base"
BASE="$FIXTURE"

# ============================================================================
echo ""
echo "[A] --help y argumentos invalidos: no tocan git ni crean run dir"

A_HELP_OUT="$(run_suite "$BASE" --help)"
A_HELP_RC=$?
if [ "$A_HELP_RC" -eq 0 ] && printf '%s' "$A_HELP_OUT" | grep -q -- "--log-dir"; then
    pass "A-1: --help termina en 0 y documenta --log-dir"
else
    fail "A-1: rc=$A_HELP_RC, salida: $A_HELP_OUT"
fi

A_BOGUS_OUT="$(run_suite "$BASE" --bogus)"
A_BOGUS_RC=$?
if [ "$A_BOGUS_RC" -eq 1 ] && printf '%s' "$A_BOGUS_OUT" | grep -qi "argumento desconocido"; then
    pass "A-2: un argumento desconocido aborta en 1 con mensaje accionable"
else
    fail "A-2: rc=$A_BOGUS_RC, salida: $A_BOGUS_OUT"
fi

A_NOVAL_OUT="$(run_suite "$BASE" --log-dir)"
A_NOVAL_RC=$?
if [ "$A_NOVAL_RC" -eq 1 ] && printf '%s' "$A_NOVAL_OUT" | grep -qi "requiere un valor"; then
    pass "A-3: '--log-dir' sin valor aborta en 1"
else
    fail "A-3: rc=$A_NOVAL_RC, salida: $A_NOVAL_OUT"
fi

if [ ! -d "$BASE/.mefisto" ]; then
    pass "A-4: ninguno de los argumentos invalidos creo un run dir"
else
    fail "A-4: se creo '$BASE/.mefisto' pese a que todos los argumentos eran invalidos"
fi

# ============================================================================
echo ""
echo "[B] Invocacion desde un subdirectorio, sin --log-dir: run dir por defecto"

new_fixture "subdir-case"
SUBDIR_BASE="$FIXTURE"
mkdir -p "$SUBDIR_BASE/scripts"
RUN_SUITE_CD="$SUBDIR_BASE/scripts" B_OUT="$(run_suite "$SUBDIR_BASE")"
B_RC=$?
unset RUN_SUITE_CD

if [ "$B_RC" -eq 0 ]; then
    pass "B-1: exit 0 con las tres entradas triviales en PASS"
else
    fail "B-1: se esperaba rc=0, se obtuvo $B_RC: $B_OUT"
fi

B_RUNDIR_LINE="$(printf '%s\n' "$B_OUT" | grep '^Run dir: ' | head -1)"
B_RUNDIR="${B_RUNDIR_LINE#Run dir: }"
case "$B_RUNDIR" in
    "$SUBDIR_BASE/.mefisto/pipeline/test-suite/"*)
        pass "B-2: el run dir por defecto cae bajo .mefisto/pipeline/test-suite/ de la raiz real (resuelta desde el subdirectorio)"
        ;;
    *)
        fail "B-2: run dir inesperado: '$B_RUNDIR'"
        ;;
esac

if [ -f "$B_RUNDIR/publicado/results.tsv" ] && [ -f "$B_RUNDIR/interno/results.tsv" ] && [ -f "$B_RUNDIR/canonico-adicional/results.tsv" ]; then
    pass "B-3: los tres results.tsv quedaron escritos en el run dir"
else
    fail "B-3: falta al menos un results.tsv en '$B_RUNDIR'"
fi

# ============================================================================
echo ""
echo "[C] --log-dir explicito con espacios: se crea si no existe"

new_fixture "space-case"
SPACE_BASE="$FIXTURE"
SPACE_LOGDIR="$TMPDIR_ROOT/log dir con espacios"

C_OUT="$(run_suite "$SPACE_BASE" --log-dir "$SPACE_LOGDIR")"
C_RC=$?

SPACE_LOGDIR_EXISTS="no"
[ -d "$SPACE_LOGDIR" ] && SPACE_LOGDIR_EXISTS="si"
if [ "$C_RC" -eq 0 ] && [ "$SPACE_LOGDIR_EXISTS" = "si" ]; then
    pass "C-1: --log-dir con espacios se crea y la corrida termina en 0"
else
    fail "C-1: rc=$C_RC, existe=$SPACE_LOGDIR_EXISTS"
fi

if [ -f "$SPACE_LOGDIR/publicado/results.tsv" ]; then
    pass "C-2: results.tsv de 'publicado' quedo dentro del --log-dir explicito"
else
    fail "C-2: no se encontro '$SPACE_LOGDIR/publicado/results.tsv'"
fi

if printf '%s\n' "$C_OUT" | grep -qF "Run dir: $SPACE_LOGDIR"; then
    pass "C-3: el resumen referencia el --log-dir explicito tal cual"
else
    fail "C-3: el resumen no referencia '$SPACE_LOGDIR': $C_OUT"
fi

# ============================================================================
echo ""
echo "[D] Cero fallos: exit 0, veredicto PASS"

if printf '%s\n' "$C_OUT" | grep -q "^Veredicto: PASS$"; then
    pass "D-1: veredicto PASS cuando las tres entradas triviales pasan"
else
    fail "D-1: no se encontro 'Veredicto: PASS' en: $C_OUT"
fi
if printf '%s\n' "$C_OUT" | grep -qE '^Entradas: 3 \(3 PASS, 0 FAIL, 0 CANCELLED\)$'; then
    pass "D-2: totales '3 (3 PASS, 0 FAIL, 0 CANCELLED)' derivados del inventario, no hardcodeados"
else
    fail "D-2: no se encontro la linea de totales esperada en: $C_OUT"
fi

# ============================================================================
echo ""
echo "[E] Un fallo: exit 1, veredicto FAIL, la entrada FAIL aparece con su log"

new_fixture "one-fail"
ONEFAIL_BASE="$FIXTURE"
printf '#!/usr/bin/env bash\nexit 3\n' > "$ONEFAIL_BASE/scripts/tests/test-pub-ok.sh"

E_OUT="$(run_suite "$ONEFAIL_BASE")"
E_RC=$?

if [ "$E_RC" -eq 1 ]; then
    pass "E-1: exit 1 cuando hay exactamente una entrada FAIL"
else
    fail "E-1: se esperaba rc=1, se obtuvo $E_RC"
fi
if printf '%s\n' "$E_OUT" | grep -q "^Veredicto: FAIL$"; then
    pass "E-2: veredicto FAIL"
else
    fail "E-2: no se encontro 'Veredicto: FAIL' en: $E_OUT"
fi
if printf '%s\n' "$E_OUT" | grep -q '\[FAIL\].*scripts/tests/test-pub-ok.sh' \
    && printf '%s\n' "$E_OUT" | grep -q "log: .*publicado/logs/"; then
    pass "E-3: la entrada FAIL aparece en el resumen con la ruta de su log"
else
    fail "E-3: no se encontro la fila FAIL con su log en: $E_OUT"
fi
if printf '%s\n' "$E_OUT" | grep -qE '^Entradas: 3 \(2 PASS, 1 FAIL, 0 CANCELLED\)$'; then
    pass "E-4: totales reflejan 2 PASS / 1 FAIL"
else
    fail "E-4: totales incorrectos en: $E_OUT"
fi

# ============================================================================
echo ""
echo "[F] Multiples fallos en carriles distintos: subtotales y totales correctos"

new_fixture "multi-fail"
MULTI_BASE="$FIXTURE"
printf '#!/usr/bin/env bash\nexit 5\n' > "$MULTI_BASE/scripts/tests/test-pub-ok.sh"
printf '#!/usr/bin/env bash\nexit 7\n' > "$MULTI_BASE/.claude/scripts/tests/test-int-ok.sh"

F_OUT="$(run_suite "$MULTI_BASE")"
F_RC=$?

if [ "$F_RC" -eq 1 ]; then
    pass "F-1: exit 1 con dos entradas FAIL en carriles distintos"
else
    fail "F-1: se esperaba rc=1, se obtuvo $F_RC"
fi
if printf '%s\n' "$F_OUT" | grep -qE '^Subtotal publicado: 0 PASS, 1 FAIL, 0 CANCELLED'; then
    pass "F-2: subtotal de 'publicado' correcto"
else
    fail "F-2: subtotal de 'publicado' incorrecto en: $F_OUT"
fi
if printf '%s\n' "$F_OUT" | grep -qE '^Subtotal interno: 0 PASS, 1 FAIL, 0 CANCELLED'; then
    pass "F-3: subtotal de 'interno' correcto"
else
    fail "F-3: subtotal de 'interno' incorrecto en: $F_OUT"
fi
if printf '%s\n' "$F_OUT" | grep -qE '^Entradas: 3 \(1 PASS, 2 FAIL, 0 CANCELLED\)$'; then
    pass "F-4: totales globales '1 PASS, 2 FAIL' derivados en tiempo de ejecucion"
else
    fail "F-4: totales globales incorrectos en: $F_OUT"
fi

# ============================================================================
echo ""
echo "[G] Orden estable del resumen: publicado -> interno -> canonico-adicional, sin importar cual termina primero"

new_fixture "order-case"
ORDER_BASE="$FIXTURE"
# 'interno' tarda mas que 'publicado': si el resumen siguiera el orden real de
# terminacion, 'publicado' apareceria despues de 'interno'.
printf '#!/usr/bin/env bash\nsleep 0.5\nexit 0\n' > "$ORDER_BASE/.claude/scripts/tests/test-int-ok.sh"

G_OUT="$(run_suite "$ORDER_BASE")"
G_PUB_LINE=$(printf '%s\n' "$G_OUT" | grep -n '^--- Carril: publicado ---$' | head -1 | cut -d: -f1)
G_INT_LINE=$(printf '%s\n' "$G_OUT" | grep -n '^--- Carril: interno ---$' | head -1 | cut -d: -f1)
G_ADI_LINE=$(printf '%s\n' "$G_OUT" | grep -n '^--- Carril: canonico-adicional ---$' | head -1 | cut -d: -f1)

if [ -n "$G_PUB_LINE" ] && [ -n "$G_INT_LINE" ] && [ -n "$G_ADI_LINE" ] \
    && [ "$G_PUB_LINE" -lt "$G_INT_LINE" ] && [ "$G_INT_LINE" -lt "$G_ADI_LINE" ]; then
    pass "G-1: el resumen imprime publicado -> interno -> canonico-adicional aunque 'interno' tarde mas en terminar"
else
    fail "G-1: orden inesperado (pub=$G_PUB_LINE, int=$G_INT_LINE, adi=$G_ADI_LINE)"
fi

# ============================================================================
echo ""
echo "[H] Determinismo (CA-3): mismo --log-dir, mismos resultados -> mismo resumen salvo duraciones"

new_fixture "determinism-case"
DET_BASE="$FIXTURE"
DET_LOGDIR="$TMPDIR_ROOT/det-run"

H_OUT1="$(run_suite "$DET_BASE" --log-dir "$DET_LOGDIR")"
H_RC1=$?
rm -rf "$DET_LOGDIR"
H_OUT2="$(run_suite "$DET_BASE" --log-dir "$DET_LOGDIR")"
H_RC2=$?

# La normalizacion se acota a las duraciones (unico dato que CA-3 permite que
# varie entre dos corridas con los mismos resultados). Normalizar TODOS los
# digitos -- como haria un 's/[0-9]+/N/g' a secas -- enmascararia tambien los
# conteos y las posiciones de orden, que es justo lo que este bloque debe
# vigilar: con esta version, una deriva de '3 PASS' a '2 PASS' entre corridas
# rompe el check en vez de pasar desapercibida.
norm_durations() {
    sed -E \
        -e 's/^(  \[[A-Z]+\]) [0-9]+s /\1 Ns /' \
        -e 's/\(([0-9]+) entradas, [0-9]+s acumulados\)/(\1 entradas, Ns acumulados)/' \
        -e 's/^Tiempo de pared: [0-9]+s$/Tiempo de pared: Ns/'
}

H_NORM1="$(printf '%s\n' "$H_OUT1" | norm_durations)"
H_NORM2="$(printf '%s\n' "$H_OUT2" | norm_durations)"

if [ "$H_RC1" -eq 0 ] && [ "$H_RC2" -eq 0 ] && [ "$H_NORM1" = "$H_NORM2" ]; then
    pass "H-1: dos corridas con los mismos resultados producen el mismo resumen tras normalizar solo las duraciones"
else
    fail "H-1: los resumenes difieren mas alla de las duraciones.
--- corrida 1 (normalizada) ---
$H_NORM1
--- corrida 2 (normalizada) ---
$H_NORM2"
fi

# ============================================================================
echo ""
echo "[I] Inventario invalido (carril vacio + fuente huerfana): aborta en 1 sin crear un run dir nuevo, reportando las DOS validaciones"

new_fixture "invalid-inventory"
INVALID_BASE="$FIXTURE"
rm -f "$INVALID_BASE/scripts/tests/test-pub-ok.sh"
# Ademas del carril vacio (que rompe mefisto_test_inventory_validate), una
# fuente canonica huerfana que rompe mefisto_test_inventory_check_canonical_coverage:
# CA-2 exige que el runner corra AMBAS validaciones, no que corte en la primera.
mkdir -p "$INVALID_BASE/src/published/scripts/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$INVALID_BASE/src/published/scripts/tests/test-huerfano.sh"
chmod +x "$INVALID_BASE/src/published/scripts/tests/test-huerfano.sh"

RUNS_BEFORE=0
[ -d "$INVALID_BASE/.mefisto/pipeline/test-suite" ] && RUNS_BEFORE=$(find "$INVALID_BASE/.mefisto/pipeline/test-suite" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')

I_OUT="$(run_suite "$INVALID_BASE")"
I_RC=$?

RUNS_AFTER=0
[ -d "$INVALID_BASE/.mefisto/pipeline/test-suite" ] && RUNS_AFTER=$(find "$INVALID_BASE/.mefisto/pipeline/test-suite" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')

if [ "$I_RC" -eq 1 ]; then
    pass "I-1: carril 'publicado' vacio aborta en 1"
else
    fail "I-1: se esperaba rc=1, se obtuvo $I_RC: $I_OUT"
fi
if [ "$RUNS_BEFORE" = "$RUNS_AFTER" ]; then
    pass "I-2: no se creo ningun run dir nuevo bajo .mefisto/pipeline/test-suite/"
else
    fail "I-2: aparecieron run dir(s) nuevos pese a que el inventario es invalido (antes=$RUNS_BEFORE, despues=$RUNS_AFTER)"
fi
if printf '%s\n' "$I_OUT" | grep -qi "inventario"; then
    pass "I-3: el mensaje de la biblioteca de inventario se propaga tal cual (no se reformula)"
else
    fail "I-3: no se encontro el mensaje esperado del inventario en: $I_OUT"
fi
if printf '%s\n' "$I_OUT" | grep -q "carril 'publicado'" \
    && printf '%s\n' "$I_OUT" | grep -q "test-huerfano.sh"; then
    pass "I-4: corren las DOS validaciones (validate y check_canonical_coverage): la primera en fallar no corta a la segunda"
else
    fail "I-4: falta la violacion de una de las dos validaciones en: $I_OUT"
fi

# ============================================================================
echo ""
echo "[J] Cobertura canonica incompleta: fuente sin shim ni registro aborta en 1"

new_fixture "coverage-case"
COVERAGE_BASE="$FIXTURE"
mkdir -p "$COVERAGE_BASE/src/published/scripts/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$COVERAGE_BASE/src/published/scripts/tests/test-orphan.sh"
chmod +x "$COVERAGE_BASE/src/published/scripts/tests/test-orphan.sh"

J_OUT="$(run_suite "$COVERAGE_BASE")"
J_RC=$?

if [ "$J_RC" -eq 1 ] && printf '%s\n' "$J_OUT" | grep -q "test-orphan.sh"; then
    pass "J-1: una fuente canonica sin shim ni registro aborta en 1 mencionando la ruta"
else
    fail "J-1: se esperaba rc=1 mencionando test-orphan.sh, se obtuvo rc=$J_RC: $J_OUT"
fi

# ============================================================================
# [K]/[L]: contrato de senales dentro de una pty real, mismo criterio
# que test-mefisto-test-executor.sh [H]/[I].

PTY_RUN="$SCRIPT_DIR/fixtures/pty-run.py"

if ! command -v python3 >/dev/null 2>&1; then
    echo ""
    echo "FAIL: python3 no esta en PATH -- [K]/[L] EXIGEN una pty real para reproducir el contrato de senales (issue #1416); no pueden saltarse en silencio" >&2
    FAIL=$((FAIL + 2))
else
    new_fixture "signal-case"
    SIGNAL_BASE="$FIXTURE"
    # Entrada lenta en el carril 'interno': el runner debe seguir vivo el
    # tiempo suficiente para que la senal llegue durante la corrida real.
    printf '#!/usr/bin/env bash\nsleep 30\nexit 0\n' > "$SIGNAL_BASE/.claude/scripts/tests/test-int-ok.sh"

    # signal_case <bloque> <senal> <rc_esperado>
    #
    # El wrapper termina en un 'exec' explicito del interprete bash contra el
    # entrypoint (misma tecnica que un shim de compatibilidad): pty-run.py
    # invoca un unico comando simple (el wrapper), que a su vez termina en
    # 'exec', asi que nunca hay un proceso intermedio -- el PID de --pid-file
    # ES el proceso real de mefisto-test-suite.sh, y la senal le llega directo
    # (sin depender de que un shell padre la reenvie). El exit code lo escribe
    # pty-run.py en --rc-file al cosechar al proceso, no un paso posterior del
    # wrapper -- ese paso posterior es justo lo que un 'exec' hace imposible,
    # a proposito.
    signal_case() {
        local block="$1" sig="$2" expected_rc="$3"

        local wrapper out_file pid_file rc_file
        wrapper="$TMPDIR_ROOT/sig-$block-wrapper.sh"
        out_file="$TMPDIR_ROOT/sig-$block.out"
        pid_file="$TMPDIR_ROOT/sig-$block.pid"
        rc_file="$TMPDIR_ROOT/sig-$block.rc"
        cat > "$wrapper" <<EOF
#!/usr/bin/env bash
cd "$SIGNAL_BASE" || exit 1
export MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES="extra/test-adicional-ok.sh"
exec "$BASH_BIN" "$SIGNAL_BASE/src/internal/scripts/mefisto-test-suite.sh" > "$out_file" 2>&1
EOF
        chmod +x "$wrapper"

        local pty_pid
        python3 "$PTY_RUN" --pid-file "$pid_file" --rc-file "$rc_file" -- "$wrapper" </dev/null >/dev/null 2>&1 &
        pty_pid=$!

        local i=0
        while [ ! -s "$out_file" ] && [ "$i" -lt 100 ]; do
            sleep 0.05
            i=$((i + 1))
        done
        sleep 0.3

        local pane_pid
        pane_pid="$(cat "$pid_file" 2>/dev/null)"
        if [ -z "$pane_pid" ]; then
            fail "$block-0: no se pudo obtener el PID de la suite dentro de la pty"
            kill "$pty_pid" 2>/dev/null; wait "$pty_pid" 2>/dev/null
            return
        fi

        kill "-$sig" "$pane_pid" 2>/dev/null

        local waited=0
        while [ ! -f "$rc_file" ] && [ "$waited" -lt 100 ]; do
            sleep 0.05
            waited=$((waited + 1))
        done

        if [ -f "$rc_file" ]; then
            pass "$block-1: el proceso raiz de la corrida termino (no quedo colgado)"
        else
            fail "$block-1: el proceso raiz sigue vivo tras 5s -- no reacciono a la senal"
        fi

        local rc
        rc="$(cat "$rc_file" 2>/dev/null)"
        if [ "$rc" = "$expected_rc" ]; then
            pass "$block-2: mefisto-test-suite.sh termino con exit $expected_rc"
        else
            fail "$block-2: se esperaba rc=$expected_rc, se obtuvo '$rc'"
        fi

        local out
        out="$(cat "$out_file" 2>/dev/null)"
        if printf '%s\n' "$out" | grep -q "CANCELLED"; then
            pass "$block-3: el resumen final refleja al menos una entrada CANCELLED"
        else
            fail "$block-3: no se encontro 'CANCELLED' en el resumen: $out"
        fi

        kill "$pty_pid" 2>/dev/null; wait "$pty_pid" 2>/dev/null
        # Barre por PID lo que sobreviva, identificado por la ruta temporal unica del caso.
        ps -axo pid=,comm=,command= | awk -v p="$SIGNAL_BASE/src/internal/scripts/mefisto-test-suite.sh" '$2 != "awk" && index($0, p) { print $1 }' \
            | while read -r leftover; do kill -9 "$leftover" 2>/dev/null; done
    }

    echo ""
    echo "[K] Senal INT: exit 130, resumen final con al menos una entrada CANCELLED"
    signal_case "INT" INT 130

    echo ""
    echo "[L] Senal TERM: exit 143, resumen final con al menos una entrada CANCELLED"
    signal_case "TERM" TERM 143
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
