#!/usr/bin/env bash
# test-mefisto-test-inventory.sh -- Tests de
# src/internal/scripts/lib/mefisto-test-inventory.sh (issue #1438).
#
# Cubre:
#   [pre] La lib existe, tiene sintaxis bash valida y no usa
#         'declare -A'/'mapfile'/'readarray' (bash 3.2, macOS).
#   [A] Descubrimiento dinamico: los tres carriles listan exactamente lo que
#       hay en disco, con la etiqueta de carril correcta.
#   [B] Orden deterministico: el orden de salida no cambia con el LC_ALL/LANG
#       externo del proceso llamador (siempre LC_ALL=C interno).
#   [C] Paths con espacios: se preservan enteros como un solo campo.
#   [D] Nuevo test automatico: agregar un archivo sin tocar la lib lo
#       incorpora al carril correspondiente en la siguiente llamada.
#   [E] Guard de cobertura (CA-4): fuente canonica sin shim ni registro ->
#       rojo; con shim homonimo -> verde; con registro explicito -> verde.
#   [F] Duplicado: la misma ruta relativa registrada en dos carriles ->
#       mefisto_test_inventory_validate falla identificando la repeticion.
#   [G] Archivo no ejecutable: excluido del descubrimiento dinamico (CA-2) y
#       rechazado por mefisto_test_inventory_validate si llega via registro.
#   [H] Symlink: excluido del descubrimiento dinamico y rechazado por
#       mefisto_test_inventory_validate si llega via registro.
#   [I] Ejecucion desde un subdirectorio: sin repo_root explicito, resuelve
#       la misma raiz que pasandola a mano (git rev-parse --show-toplevel).
#   [J] Smoke contra el repo REAL: mefisto_test_inventory_validate y
#       mefisto_test_inventory_check_canonical_coverage quedan verdes contra
#       Mefisto tal cual esta hoy -- esto es lo que el guard de cobertura
#       pone en rojo si una fuente canonica nueva llega sin shim ni registro.
#
# Todos los bloques salvo [J] corren contra un repo FIXTURE temporal (mktemp),
# nunca contra el inventario real mutable (CA-5).
#
# Uso: .claude/scripts/tests/test-mefisto-test-inventory.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB="$REPO_ROOT/src/internal/scripts/lib/mefisto-test-inventory.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[pre] La lib existe y tiene sintaxis valida"
if [ -f "$LIB" ]; then
    pass "mefisto-test-inventory.sh presente en src/internal/scripts/lib/"
else
    fail "mefisto-test-inventory.sh no existe en src/internal/scripts/lib/"
    echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
    exit 1
fi

if bash -n "$LIB" 2>/dev/null; then
    pass "sintaxis bash valida"
else
    fail "sintaxis bash invalida"
fi

# Se juzga sobre CODIGO, no sobre comentarios (mismo criterio que
# test-mefisto-state-dir.sh): un grep crudo leeria la propia prosa que
# describe la prohibicion como si fuera la infraccion.
CODE_ONLY="$(grep -v '^[[:space:]]*#' "$LIB")"
for forbidden in "declare -A" "mapfile" "readarray"; do
    if printf '%s' "$CODE_ONLY" | grep -q -- "$forbidden"; then
        fail "usa '$forbidden': rompe en bash 3.2"
    else
        pass "no usa '$forbidden' (compatible bash 3.2)"
    fi
done

# -------- Fixtures: repo temporal + runner que ejecuta funciones sueltas --------

# 'pwd -P' resuelve symlinks (macOS: /tmp -> /private/tmp): sin esto,
# 'git rev-parse --show-toplevel' (que SI resuelve symlinks) devolveria una
# ruta distinta a la que arma mktemp, y el bloque [I] fallaria por un prefijo
# /private/ ajeno al helper bajo prueba.
TMPDIR_ROOT=$(cd "$(mktemp -d)" && pwd -P)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

(cd "$TMPDIR_ROOT" && git init -q)

# bash 3.2 real (macOS): verificado en este entorno que /bin/bash es distinto
# del bash de PATH si hay uno mas nuevo instalado (p. ej. homebrew).
BASH_BIN="/bin/bash"
[ -x "$BASH_BIN" ] || BASH_BIN="bash"

RUNNER="$TMPDIR_ROOT/.runner.sh"
cat > "$RUNNER" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
if [ -n "${INV_TEST_CD:-}" ]; then
    cd "$INV_TEST_CD" || exit 1
fi
source "$INV_TEST_LIB"
"$@"
EOF
chmod +x "$RUNNER"

# call <cd-dir> <funcion> <args...>
# Corre <funcion> en bash 3.2 real, tras sourcear la lib, sin heredar
# MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES del proceso que corre este test.
call() {
    local cd_dir="$1"; shift
    env -u MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES \
        INV_TEST_LIB="$LIB" INV_TEST_CD="$cd_dir" \
        "$BASH_BIN" "$RUNNER" "$@"
}

# call_with_registry <cd-dir> <registro> <funcion> <args...>
# Variante de call() que fija MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES ANTES
# de sourcear la lib, para forzar entradas del carril canonico-adicional que
# el descubrimiento dinamico nunca produciria por si mismo (no ejecutable,
# symlink, duplicado con otro carril).
call_with_registry() {
    local cd_dir="$1" registry="$2"; shift 2
    env INV_TEST_LIB="$LIB" INV_TEST_CD="$cd_dir" \
        MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES="$registry" \
        "$BASH_BIN" "$RUNNER" "$@"
}

# call_with_locale <cd-dir> <LC_ALL> <funcion> <args...>
call_with_locale() {
    local cd_dir="$1" locale="$2"; shift 2
    env -u MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES LC_ALL="$locale" LANG="$locale" \
        INV_TEST_LIB="$LIB" INV_TEST_CD="$cd_dir" \
        "$BASH_BIN" "$RUNNER" "$@"
}

# -------- Baseline: BASE tiene la forma minima de un repo de Mefisto --------
#
# scripts/tests/{test-alpha.sh,test-beta.sh} (publicado)
# .claude/scripts/tests/{test-gamma.sh,test-delta.sh} (interno)
# src/published/scripts/tests/test-generate-published-adapters.sh (adicional,
# solo cuando el caso lo registra: el registro DEFAULT de la lib esta vacio).

BASE="$TMPDIR_ROOT"
mkdir -p "$BASE/scripts/tests" "$BASE/.claude/scripts/tests" "$BASE/src/published/scripts/tests"
for f in "$BASE/scripts/tests/test-alpha.sh" "$BASE/scripts/tests/test-beta.sh"; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$f"
    chmod +x "$f"
done
for f in "$BASE/.claude/scripts/tests/test-gamma.sh" "$BASE/.claude/scripts/tests/test-delta.sh"; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$f"
    chmod +x "$f"
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$BASE/src/published/scripts/tests/test-generate-published-adapters.sh"
chmod +x "$BASE/src/published/scripts/tests/test-generate-published-adapters.sh"

echo ""
echo "[A] Descubrimiento dinamico: los tres carriles listan lo que hay en disco"

A_PUB=$(call "$BASE" mefisto_test_inventory_lane_publicado "$BASE")
EXPECTED_A_PUB=$'publicado\tscripts/tests/test-alpha.sh\npublicado\tscripts/tests/test-beta.sh'
if [ "$A_PUB" = "$EXPECTED_A_PUB" ]; then
    pass "A-1: carril publicado descubre test-alpha.sh y test-beta.sh, en orden"
else
    fail "A-1: se esperaba '$EXPECTED_A_PUB', se obtuvo '$A_PUB'"
fi

A_INT=$(call "$BASE" mefisto_test_inventory_lane_interno "$BASE")
EXPECTED_A_INT=$'interno\t.claude/scripts/tests/test-delta.sh\ninterno\t.claude/scripts/tests/test-gamma.sh'
if [ "$A_INT" = "$EXPECTED_A_INT" ]; then
    pass "A-2: carril interno descubre test-delta.sh y test-gamma.sh, ordenados"
else
    fail "A-2: se esperaba '$EXPECTED_A_INT', se obtuvo '$A_INT'"
fi

BASE_REGISTRY='src/published/scripts/tests/test-generate-published-adapters.sh'
A_ADI=$(call_with_registry "$BASE" "$BASE_REGISTRY" mefisto_test_inventory_lane_adicional "$BASE")
EXPECTED_A_ADI=$'canonico-adicional\tsrc/published/scripts/tests/test-generate-published-adapters.sh'
if [ "$A_ADI" = "$EXPECTED_A_ADI" ]; then
    pass "A-3: carril canonico-adicional expone el registro"
else
    fail "A-3: se esperaba '$EXPECTED_A_ADI', se obtuvo '$A_ADI'"
fi

A_LIST=$(call_with_registry "$BASE" "$BASE_REGISTRY" mefisto_test_inventory_list "$BASE")
EXPECTED_A_LIST="$EXPECTED_A_PUB"$'\n'"$EXPECTED_A_INT"$'\n'"$EXPECTED_A_ADI"
if [ "$A_LIST" = "$EXPECTED_A_LIST" ]; then
    pass "A-4: mefisto_test_inventory_list concatena publicado -> interno -> canonico-adicional"
else
    fail "A-4: se esperaba '$EXPECTED_A_LIST', se obtuvo '$A_LIST'"
fi

A_VALID=$(call_with_registry "$BASE" "$BASE_REGISTRY" mefisto_test_inventory_validate "$BASE" 2>&1)
A_VALID_RC=$?
if [ "$A_VALID_RC" -eq 0 ]; then
    pass "A-5: mefisto_test_inventory_validate acepta el inventario baseline"
else
    fail "A-5: se esperaba exit 0, se obtuvo rc=$A_VALID_RC: $A_VALID"
fi

A_EMPTY=$(call "$BASE" mefisto_test_inventory_lane_adicional "$BASE")
A_EMPTY_VALID_RC=0
call "$BASE" mefisto_test_inventory_validate "$BASE" >/dev/null 2>&1 || A_EMPTY_VALID_RC=$?
if [ -z "$A_EMPTY" ] && [ "$A_EMPTY_VALID_RC" -eq 0 ]; then
    pass "A-6: el registro default esta vacio y un carril canonico-adicional vacio es valido"
else
    fail "A-6: se esperaba un carril vacio y rc=0, se obtuvo '$A_EMPTY' rc=$A_EMPTY_VALID_RC"
fi

echo ""
echo "[B] Orden deterministico: no depende del LC_ALL/LANG externo del llamador"

ORDER_CASE="$TMPDIR_ROOT/order-case"
mkdir -p "$ORDER_CASE/scripts/tests" "$ORDER_CASE/.claude/scripts/tests" "$ORDER_CASE/src/published/scripts/tests"
for name in "test-Z.sh" "test-alpha.sh" "test-mid.sh"; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$ORDER_CASE/scripts/tests/$name"
    chmod +x "$ORDER_CASE/scripts/tests/$name"
done
EXPECTED_ORDER=$'publicado\tscripts/tests/test-Z.sh\npublicado\tscripts/tests/test-alpha.sh\npublicado\tscripts/tests/test-mid.sh'

B_C=$(call_with_locale "$ORDER_CASE" "C" mefisto_test_inventory_lane_publicado "$ORDER_CASE")
if [ "$B_C" = "$EXPECTED_ORDER" ]; then
    pass "B-1: bajo LC_ALL=C, orden ASCII ('Z' antes que 'a')"
else
    fail "B-1: se esperaba '$EXPECTED_ORDER', se obtuvo '$B_C'"
fi

B_OTHER=$(call_with_locale "$ORDER_CASE" "en_US.UTF-8" mefisto_test_inventory_lane_publicado "$ORDER_CASE")
if [ "$B_OTHER" = "$EXPECTED_ORDER" ]; then
    pass "B-2: bajo LC_ALL=en_US.UTF-8 (si esta disponible) el orden no cambia"
else
    fail "B-2: se esperaba el mismo orden que B-1, se obtuvo '$B_OTHER'"
fi

echo ""
echo "[C] Paths con espacios: se preservan enteros como un solo campo"

SPACE_CASE="$TMPDIR_ROOT/space-case"
mkdir -p "$SPACE_CASE/scripts/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SPACE_CASE/scripts/tests/test-with space.sh"
chmod +x "$SPACE_CASE/scripts/tests/test-with space.sh"

C_OUT=$(call "$SPACE_CASE" mefisto_test_inventory_lane_publicado "$SPACE_CASE")
if [ "$C_OUT" = $'publicado\tscripts/tests/test-with space.sh' ]; then
    pass "C-1: 'test-with space.sh' se preserva con el espacio intacto"
else
    fail "C-1: se esperaba path con espacio preservado, se obtuvo '$C_OUT'"
fi

echo ""
echo "[D] Nuevo test automatico: se incorpora sin tocar la lib"

printf '#!/usr/bin/env bash\nexit 0\n' > "$BASE/scripts/tests/test-nuevo.sh"
chmod +x "$BASE/scripts/tests/test-nuevo.sh"
D_OUT=$(call "$BASE" mefisto_test_inventory_lane_publicado "$BASE")
EXPECTED_D=$'publicado\tscripts/tests/test-alpha.sh\npublicado\tscripts/tests/test-beta.sh\npublicado\tscripts/tests/test-nuevo.sh'
if [ "$D_OUT" = "$EXPECTED_D" ]; then
    pass "D-1: test-nuevo.sh aparece en el carril publicado tras la siguiente llamada"
else
    fail "D-1: se esperaba '$EXPECTED_D', se obtuvo '$D_OUT'"
fi

echo ""
echo "[E] Guard de cobertura (CA-4): fuente canonica sin shim ni registro -> rojo"

COVERAGE_CASE="$TMPDIR_ROOT/coverage-case"
mkdir -p "$COVERAGE_CASE/scripts/tests" "$COVERAGE_CASE/.claude/scripts/tests" "$COVERAGE_CASE/src/published/scripts/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$COVERAGE_CASE/src/published/scripts/tests/test-orphan.sh"
chmod +x "$COVERAGE_CASE/src/published/scripts/tests/test-orphan.sh"

E1_OUT=$(call "$COVERAGE_CASE" mefisto_test_inventory_check_canonical_coverage "$COVERAGE_CASE" 2>&1)
E1_RC=$?
if [ "$E1_RC" -eq 1 ] && printf '%s' "$E1_OUT" | grep -q "test-orphan.sh"; then
    pass "E-1: fuente canonica sin shim ni registro pone rojo el guard de cobertura"
else
    fail "E-1: se esperaba rc=1 mencionando test-orphan.sh, se obtuvo rc=$E1_RC: $E1_OUT"
fi

# Con shim homonimo en scripts/tests/ -> verde
printf '#!/usr/bin/env bash\nexit 0\n' > "$COVERAGE_CASE/scripts/tests/test-orphan.sh"
chmod +x "$COVERAGE_CASE/scripts/tests/test-orphan.sh"
E2_RC=0
call "$COVERAGE_CASE" mefisto_test_inventory_check_canonical_coverage "$COVERAGE_CASE" >/dev/null 2>&1 || E2_RC=$?
if [ "$E2_RC" -eq 0 ]; then
    pass "E-2: con shim homonimo en scripts/tests/, el guard de cobertura queda verde"
else
    fail "E-2: se esperaba rc=0 con el shim presente, se obtuvo rc=$E2_RC"
fi
rm -f "$COVERAGE_CASE/scripts/tests/test-orphan.sh"

# Sin shim pero registrado en canonico-adicional -> verde
E3_RC=0
call_with_registry "$COVERAGE_CASE" "src/published/scripts/tests/test-orphan.sh" \
    mefisto_test_inventory_check_canonical_coverage "$COVERAGE_CASE" >/dev/null 2>&1 || E3_RC=$?
if [ "$E3_RC" -eq 0 ]; then
    pass "E-3: registrado en canonico-adicional sin shim, el guard de cobertura queda verde"
else
    fail "E-3: se esperaba rc=0 con el registro explicito, se obtuvo rc=$E3_RC"
fi

echo ""
echo "[F] Duplicado: la misma ruta relativa registrada en dos carriles -> validate falla"

DUP_CASE="$TMPDIR_ROOT/dup-case"
mkdir -p "$DUP_CASE/scripts/tests" "$DUP_CASE/.claude/scripts/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$DUP_CASE/scripts/tests/test-shared.sh"
chmod +x "$DUP_CASE/scripts/tests/test-shared.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$DUP_CASE/.claude/scripts/tests/test-other.sh"
chmod +x "$DUP_CASE/.claude/scripts/tests/test-other.sh"

F_OUT=$(call_with_registry "$DUP_CASE" "scripts/tests/test-shared.sh" \
    mefisto_test_inventory_validate "$DUP_CASE" 2>&1)
F_RC=$?
if [ "$F_RC" -eq 1 ] && printf '%s' "$F_OUT" | grep -q "repetida" && printf '%s' "$F_OUT" | grep -q "test-shared.sh"; then
    pass "F-1: el duplicado entre publicado y canonico-adicional se rechaza identificando la ruta"
else
    fail "F-1: se esperaba rc=1 mencionando la ruta repetida, se obtuvo rc=$F_RC: $F_OUT"
fi

echo ""
echo "[G] Archivo no ejecutable: excluido del descubrimiento, rechazado si llega via registro"

NOEXEC_CASE="$TMPDIR_ROOT/noexec-case"
mkdir -p "$NOEXEC_CASE/scripts/tests" "$NOEXEC_CASE/.claude/scripts/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$NOEXEC_CASE/scripts/tests/test-alpha.sh"
chmod +x "$NOEXEC_CASE/scripts/tests/test-alpha.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$NOEXEC_CASE/scripts/tests/test-noexec.sh"
chmod -x "$NOEXEC_CASE/scripts/tests/test-noexec.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$NOEXEC_CASE/.claude/scripts/tests/test-gamma.sh"
chmod +x "$NOEXEC_CASE/.claude/scripts/tests/test-gamma.sh"

G1_OUT=$(call "$NOEXEC_CASE" mefisto_test_inventory_lane_publicado "$NOEXEC_CASE")
if [ "$G1_OUT" = $'publicado\tscripts/tests/test-alpha.sh' ]; then
    pass "G-1: test-noexec.sh (sin +x) no aparece en el descubrimiento dinamico"
else
    fail "G-1: se esperaba solo test-alpha.sh, se obtuvo '$G1_OUT'"
fi

G2_OUT=$(call_with_registry "$NOEXEC_CASE" "scripts/tests/test-noexec.sh" \
    mefisto_test_inventory_validate "$NOEXEC_CASE" 2>&1)
G2_RC=$?
if [ "$G2_RC" -eq 1 ] && printf '%s' "$G2_OUT" | grep -q "no es ejecutable"; then
    pass "G-2: registrado explicitamente, un archivo sin +x se rechaza"
else
    fail "G-2: se esperaba rc=1 'no es ejecutable', se obtuvo rc=$G2_RC: $G2_OUT"
fi

echo ""
echo "[H] Symlink: excluido del descubrimiento, rechazado si llega via registro"

SYMLINK_CASE="$TMPDIR_ROOT/symlink-case"
mkdir -p "$SYMLINK_CASE/scripts/tests" "$SYMLINK_CASE/.claude/scripts/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SYMLINK_CASE/scripts/tests/test-real.sh"
chmod +x "$SYMLINK_CASE/scripts/tests/test-real.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SYMLINK_CASE/.claude/scripts/tests/test-gamma.sh"
chmod +x "$SYMLINK_CASE/.claude/scripts/tests/test-gamma.sh"
ln -s "test-real.sh" "$SYMLINK_CASE/scripts/tests/test-link.sh"

H1_OUT=$(call "$SYMLINK_CASE" mefisto_test_inventory_lane_publicado "$SYMLINK_CASE")
if [ "$H1_OUT" = $'publicado\tscripts/tests/test-real.sh' ]; then
    pass "H-1: test-link.sh (symlink) no aparece en el descubrimiento dinamico"
else
    fail "H-1: se esperaba solo test-real.sh, se obtuvo '$H1_OUT'"
fi

H2_OUT=$(call_with_registry "$SYMLINK_CASE" "scripts/tests/test-link.sh" \
    mefisto_test_inventory_validate "$SYMLINK_CASE" 2>&1)
H2_RC=$?
if [ "$H2_RC" -eq 1 ] && printf '%s' "$H2_OUT" | grep -q "symlink"; then
    pass "H-2: registrado explicitamente, un symlink se rechaza"
else
    fail "H-2: se esperaba rc=1 mencionando 'symlink', se obtuvo rc=$H2_RC: $H2_OUT"
fi

echo ""
echo "[I] Ejecucion desde un subdirectorio: misma raiz que pasandola explicita"

I_EXPLICIT=$(call "$BASE" mefisto_test_inventory_list "$BASE")
I_IMPLICIT=$(call "$BASE/scripts" mefisto_test_inventory_list)
if [ "$I_IMPLICIT" = "$I_EXPLICIT" ]; then
    pass "I-1: sin repo_root explicito desde un subdirectorio, mefisto_test_inventory_list coincide"
else
    fail "I-1: se esperaba '$I_EXPLICIT', se obtuvo '$I_IMPLICIT'"
fi

I_VALIDATE_RC=0
call "$BASE/.claude/scripts" mefisto_test_inventory_validate >/dev/null 2>&1 || I_VALIDATE_RC=$?
if [ "$I_VALIDATE_RC" -eq 0 ]; then
    pass "I-2: mefisto_test_inventory_validate sin repo_root explicito tambien resuelve la raiz correcta"
else
    fail "I-2: se esperaba rc=0, se obtuvo rc=$I_VALIDATE_RC"
fi

echo ""
echo "[J] Smoke contra el repo REAL de Mefisto"

J1_OUT=$(call "$REPO_ROOT" mefisto_test_inventory_validate "$REPO_ROOT" 2>&1)
J1_RC=$?
if [ "$J1_RC" -eq 0 ]; then
    pass "J-1: mefisto_test_inventory_validate queda verde contra el repo real"
else
    fail "J-1: se esperaba rc=0 contra el repo real, se obtuvo rc=$J1_RC: $J1_OUT"
fi

J2_OUT=$(call "$REPO_ROOT" mefisto_test_inventory_check_canonical_coverage "$REPO_ROOT" 2>&1)
J2_RC=$?
if [ "$J2_RC" -eq 0 ]; then
    pass "J-2: mefisto_test_inventory_check_canonical_coverage queda verde contra el repo real"
else
    fail "J-2: se esperaba rc=0 (toda fuente canonica cubierta por shim o registro), se obtuvo rc=$J2_RC: $J2_OUT"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
