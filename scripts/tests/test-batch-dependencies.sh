#!/usr/bin/env bash
# test-batch-dependencies.sh -- Parser de dependencias canonicas de la libreria
# bash (extract_canonical_dependencies de _pipeline-common.sh, issue #2471). La
# compuerta de dependencias de batch-pipeline vive en
# scripts/tests/batch-pipeline.test.mts.
#
# Uso: scripts/tests/test-batch-dependencies.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMMON_LIB="$REPO_ROOT/scripts/_pipeline-common.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# --- Parser ---
echo "[P] extract_canonical_dependencies"
# shellcheck disable=SC1090
source "$COMMON_LIB"
BODY=$'## Contexto\nDepende de #999 en prosa\n\n## Dependencias\n- Depende de #10\n* bloqueado por #11\n  Depende de #10\n- Bloquea #12\n- Relacionado: #13\nVer tambien Depende de #14\n\n## Otra\nDepende de #15\n'
GOT=$(extract_canonical_dependencies "$BODY" | tr '\n' ' ')
if [ "$GOT" = "10 11 " ]; then pass "P: solo canonicas, sin repetir, anclado a la seccion"; else fail "P: se obtuvo '$GOT', se esperaba '10 11 '"; fi
if [ -z "$(extract_canonical_dependencies $'## Dependencias\nNinguna\n')" ]; then pass "P: 'Ninguna' no produce dependencias"; else fail "P: 'Ninguna' produjo dependencias"; fi

echo ""; echo "----------------------------------------"; echo "  Resumen: $PASS pass, $FAIL fail"; echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
