#!/usr/bin/env bash
# test-scope-gate-untracked.sh -- Regresion del gate de scope interno (issue #882).
#
# validate_mefisto_scope_changes (.claude/scripts/_mefisto-common.sh) juzga los
# cambios del worktree con `git diff base..HEAD` mas `git status --porcelain`.
# Sin --untracked-files=all, git colapsa un directorio nuevo sin trackear a su
# raiz ("src/") y esa entrada no casa con patrones como src/internal/* de
# is_path_in_mefisto_scope: el gate rechazaba cambios que archivo por archivo
# estaban en scope (batch del 2026-09-05, issue #853).
#
#   [A] Arbol nuevo sin trackear bajo src/internal/ -> exit 0 (en scope).
#   [B] Arbol nuevo sin trackear bajo .claude/agents/ -> exit 0 (en scope).
#   [C] Archivo bajo un directorio nuevo FUERA de scope -> exit 1, y stderr
#       nombra el archivo concreto, no el directorio colapsado.
#   [D] Mezcla: arbol en scope + archivo fuera -> exit 1 y solo se lista el
#       archivo fuera de scope.
#
# Uso: .claude/scripts/tests/test-scope-gate-untracked.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMMON="$REPO_ROOT/.claude/scripts/_mefisto-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

set +u
# shellcheck source=/dev/null
source "$COMMON" 2>/dev/null
set -u

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Repo temporal con un commit base: el gate compara base..HEAD mas el working tree.
nuevo_repo() {
    local dir="$1"
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" config user.email "test@mefisto.local"
    git -C "$dir" config user.name "test"
    echo "# base" > "$dir/README.md"
    git -C "$dir" add README.md
    git -C "$dir" commit -q -m "base"
    git -C "$dir" rev-parse HEAD
}

echo "[A] Arbol nuevo sin trackear bajo src/internal/ pasa el gate"
REPO_A="$TMP/a"; BASE_A=$(nuevo_repo "$REPO_A")
mkdir -p "$REPO_A/src/internal/contract/fixtures/valid"
echo '{}' > "$REPO_A/src/internal/contract/internal-artifact.schema.json"
echo 'x' > "$REPO_A/src/internal/contract/fixtures/valid/ejemplo.md"
if ERR=$(set +u; validate_mefisto_scope_changes "$REPO_A" "$BASE_A" 2>&1); then
    pass "src/internal/ nuevo sin trackear -> exit 0"
else
    fail "src/internal/ nuevo sin trackear rechazado: $ERR"
fi

echo "[B] Arbol nuevo sin trackear bajo .claude/agents/ pasa el gate"
REPO_B="$TMP/b"; BASE_B=$(nuevo_repo "$REPO_B")
mkdir -p "$REPO_B/.claude/agents"
echo 'x' > "$REPO_B/.claude/agents/writer.md"
if ERR=$(set +u; validate_mefisto_scope_changes "$REPO_B" "$BASE_B" 2>&1); then
    pass ".claude/agents/ nuevo sin trackear -> exit 0"
else
    fail ".claude/agents/ nuevo sin trackear rechazado: $ERR"
fi

echo "[C] Archivo bajo un directorio nuevo fuera de scope se rechaza nombrando el archivo"
REPO_C="$TMP/c"; BASE_C=$(nuevo_repo "$REPO_C")
mkdir -p "$REPO_C/fuera/nuevo"
echo 'y' > "$REPO_C/fuera/nuevo/archivo.txt"
if ERR=$(set +u; validate_mefisto_scope_changes "$REPO_C" "$BASE_C" 2>&1); then
    fail "directorio fuera de scope aceptado"
else
    pass "directorio fuera de scope -> exit 1"
fi
if echo "$ERR" | grep -q -- "- fuera/nuevo/archivo.txt"; then
    pass "stderr nombra el archivo concreto"
else
    fail "stderr no nombra el archivo concreto: $ERR"
fi
if echo "$ERR" | grep -qx -- "  - fuera/"; then
    fail "stderr lista el directorio colapsado 'fuera/'"
else
    pass "stderr no lista el directorio colapsado"
fi

echo "[D] Mezcla en scope + fuera de scope: solo se lista lo de fuera"
REPO_D="$TMP/d"; BASE_D=$(nuevo_repo "$REPO_D")
mkdir -p "$REPO_D/src/internal/scripts" "$REPO_D/otro"
echo 'x' > "$REPO_D/src/internal/scripts/validar.sh"
echo 'y' > "$REPO_D/otro/cosa.md"
if ERR=$(set +u; validate_mefisto_scope_changes "$REPO_D" "$BASE_D" 2>&1); then
    fail "mezcla con archivo fuera de scope aceptada"
else
    pass "mezcla -> exit 1"
fi
if echo "$ERR" | grep -q -- "- otro/cosa.md" && ! echo "$ERR" | grep -q -- "- src/internal/"; then
    pass "se lista solo otro/cosa.md, no src/internal/"
else
    fail "listado de violaciones inesperado: $ERR"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
