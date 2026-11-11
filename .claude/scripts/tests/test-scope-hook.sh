#!/usr/bin/env bash
# test-scope-hook.sh -- El pipeline interno no pisa `.claude/settings.json` y sus
# listas operativas cubren las raices de la allowlist (issue #523).
#
# El veredicto del hook de scope lo cubre mefisto-scope-hook.test.mts.
#
# Uso: .claude/scripts/tests/test-scope-hook.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SETTINGS="$REPO_ROOT/.claude/settings.json"
PIPELINE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[E] Cableado en settings.json y reconciliacion del pipeline"
if [ -f "$SETTINGS" ]; then
    pass ".claude/settings.json existe y esta versionado"
else
    fail ".claude/settings.json no existe (el hook no se cargaria)"
fi

# El pipeline NO debe revertir settings.json: esta versionado y un `git checkout --`
# borraria en silencio la edicion legitima de un writer que anada un hook nuevo.
# Se juzga sobre CODIGO, no sobre comentarios: el propio pipeline documenta en prosa
# por que no hace ninguna de las dos cosas.
PIPELINE_CODE=$(grep -v '^[[:space:]]*#' "$PIPELINE")

if printf '%s' "$PIPELINE_CODE" | grep -q "checkout -- .claude/settings.json"; then
    fail "el pipeline interno aun hace 'git checkout -- .claude/settings.json': destruiria una edicion no comiteada del archivo versionado"
else
    pass "el pipeline interno ya no revierte .claude/settings.json"
fi

if printf '%s' "$PIPELINE_CODE" | grep -q 'sed .*settings\.json'; then
    fail "el pipeline interno aun inyecta settings.json desde \$REPO_ROOT: pisaria el archivo versionado del worktree"
else
    pass "el pipeline interno ya no inyecta .claude/settings.json desde el clon principal"
fi

if printf '%s\n' "$PIPELINE_CODE" | grep 'local paths=' | grep -q 'src/published/ src/runtime/ dist/'; then
    pass "src/published/, src/runtime/ y dist/ estan en la lista operativa de auto-commit"
else
    fail "la lista operativa de auto-commit omite src/published/, src/runtime/ o dist/"
fi

if printf '%s\n' "$PIPELINE_CODE" | grep 'status --porcelain -- commands/' | grep -q 'src/published/ src/runtime/ dist/'; then
    pass "src/published/, src/runtime/ y dist/ estan en la deteccion de cambios del writer"
else
    fail "la deteccion de cambios del writer omite src/published/, src/runtime/ o dist/"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
