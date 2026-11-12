#!/usr/bin/env bash
# test-no-toplevel-local.sh -- Guard SC2168 (issue #308).
#
# Bash solo permite `local` dentro de funciones; con `set -e` activo, una
# declaracion `local` en el cuerpo top-level de un script (fuera de cualquier
# funcion) aborta el pipeline con "local: can only be used in a function" antes
# de llegar a su terminacion limpia (abort() con update_status "failed").
#
# Valida:
#   [A] Guard estatico: cero ocurrencias de `local` fuera de funcion en los
#       scripts publicados (scripts/*.sh), via shellcheck regla SC2168. Si el
#       binario no esta instalado, el guard FALLA explicitamente (no
#       silenciosamente) -- awk de BSD no soporta \b y un grep '\blocal\b'
#       da falsos positivos con la palabra "local" en prosa/prompts.
#
# Uso: scripts/tests/test-no-toplevel-local.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# -------- Bloque A: guard estatico -- cero 'local' fuera de funcion --------

echo "[A] Guard estatico: cero 'local' fuera de funcion en scripts/*.sh (shellcheck SC2168)"

if ! command -v shellcheck >/dev/null 2>&1; then
    fail "shellcheck no esta instalado -- el guard no puede verificar SC2168 (instalalo: https://github.com/koalaman/shellcheck#installing)"
else
    PUBLISHED_SCRIPTS=("$REPO_ROOT"/scripts/*.sh)
    SC2168_HITS=$(shellcheck -f gcc "${PUBLISHED_SCRIPTS[@]}" 2>/dev/null | grep 'SC2168' || true)
    if [ -z "$SC2168_HITS" ]; then
        pass "cero ocurrencias de SC2168 en scripts/*.sh"
    else
        fail "SC2168 detectado en scripts publicados:"
        echo "$SC2168_HITS" | sed 's/^/    /'
    fi
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
