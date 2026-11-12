#!/usr/bin/env bash
# test-tooling-state-paths.sh -- Tests del traslado de mefisto-tooling-pipeline.sh
# y _mefisto-common.sh al layout canonico, con rutas de estado neutrales
# (MEF-ADR-0049, issue #869).
#
# Cubre:
#   [pre] La politica interna y el nucleo comun existen con sintaxis
#         bash valida; los shims de .claude/scripts/ tambien (CA-1). Las rutas
#         de estado de una corrida real las prueba mefisto-tooling-pipeline.test.mts.
#   [A]   Los shims son EXACTAMENTE la plantilla documentada en
#         src/internal/scripts/README.md: exec de 3 lineas para el pipeline,
#         source de una linea para la lib (CA-1).
#
# Uso: .claude/scripts/tests/test-tooling-state-paths.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

CANON_PIPE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"
CANON_LIB="$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"
SHIM_PIPE="$REPO_ROOT/.claude/scripts/mefisto-tooling-pipeline.sh"
SHIM_LIB="$REPO_ROOT/.claude/scripts/_mefisto-common.sh"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre --------

echo "[pre] Canonicos y shims existen, con sintaxis bash valida"
for f in "$CANON_PIPE" "$CANON_LIB" "$SHIM_PIPE" "$SHIM_LIB"; do
    if [ -f "$f" ]; then
        pass "$(basename "$(dirname "$f")")/$(basename "$f"): presente"
    else
        fail "$f: ausente"
        echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
        exit 1
    fi
    if bash -n "$f" 2>/dev/null; then
        pass "$(basename "$f") ($f): sintaxis bash valida"
    else
        fail "$(basename "$f") ($f): sintaxis bash invalida"
    fi
done

# -------- Bloque A: los shims son la plantilla exacta --------

echo ""
echo "[A] Los shims siguen la plantilla documentada (CA-1)"

if [ -x "$SHIM_PIPE" ]; then pass "el shim del pipeline tiene bit de ejecucion"; else fail "el shim del pipeline no es ejecutable"; fi

EXPECTED_EXEC_SHIM='exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"'
if grep -qF "$EXPECTED_EXEC_SHIM" "$SHIM_PIPE"; then
    pass "el shim del pipeline usa 'exec' con la forma documentada"
else
    fail "el shim del pipeline no coincide con la plantilla de exec de src/internal/scripts/README.md"
fi
if [ "$(grep -cv '^\s*#' "$SHIM_PIPE" | grep -cv '^\s*$')" -le 2 ]; then
    pass "el shim del pipeline no tiene logica propia (solo shebang + exec)"
else
    fail "el shim del pipeline tiene mas codigo del esperado"
fi

if grep -q '^source ' "$SHIM_LIB"; then
    pass "el shim de la lib usa 'source' (no 'exec': se sourcea, no se ejecuta)"
else
    fail "el shim de la lib no usa 'source'"
fi
if grep -qF 'src/internal/scripts/lib/_mefisto-common.sh' "$SHIM_LIB"; then
    pass "el shim de la lib apunta al canonico en src/internal/scripts/lib/"
else
    fail "el shim de la lib no referencia la ruta canonica"
fi
if grep -q 'BASH_SOURCE\[0\]' "$SHIM_LIB"; then
    pass "el shim de la lib resuelve via BASH_SOURCE (correcto para un archivo sourceado, no ejecutado)"
else
    fail "el shim de la lib no usa BASH_SOURCE -- '\$0' resolveria mal cuando se sourcea"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
