#!/usr/bin/env bash
# test-scope-parity.sh -- Paridad del control de scope entre runtimes (issue #1684,
# MEF-ADR-0050): el hook PostToolUse del adaptador Claude (mefisto-scope-hook.sh,
# avisa DESPUES de escribir) y la politica edit/write/patch generada para
# OpenCode (deniega ANTES de escribir) juzgan igual desde is_path_in_mefisto_scope.
#
#   [fuera] Ruta fuera de scope: el hook sale 2 con aviso y la politica deniega
#           edit, write y patch.
#   [dentro] Ruta en scope: el hook sale 0 en silencio y la politica permite
#           edit, write y patch.
#
# Reutiliza el generador real y el evaluador jq de test-opencode-permissions.sh.
# Uso: .claude/scripts/tests/test-scope-parity.sh
# Exit code: 0 si todo pasa, 1 si alguno falla.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GENERATOR="$REPO_ROOT/src/internal/scripts/generate-internal-adapters.sh"
EVALUATOR="$REPO_ROOT/src/internal/scripts/lib/opencode-permission-eval.jq"
HOOK="$REPO_ROOT/.claude/scripts/mefisto-scope-hook.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 -- esperado: '$1', obtenido: '$2'"; fi; }

command -v jq >/dev/null 2>&1 || { echo "SKIP: requiere jq"; exit 0; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$WORKDIR/src"
cat > "$WORKDIR/src/mefisto-fx-parity-writer.md" <<'FX'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-parity-writer",
  "description": "Agente estilo writer para la paridad de scope (issue #1684).",
  "mode": "all",
  "capabilities": ["read", "edit", "shell"]
}
---

Cuerpo.
FX

if ! "$GENERATOR" --out "$WORKDIR/out" "$WORKDIR/src/mefisto-fx-parity-writer.md" >/dev/null 2>&1; then
    fail "el generador no produjo el agente de prueba"
    echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
    exit 1
fi
PERM="$(sed -n 's/^permission: //p' "$WORKDIR/out/.opencode/agents/mefisto-fx-parity-writer.md")"

eval_perm() {
    jq -rn --argjson permission "$PERM" --arg key "$1" --arg input "$2" -f "$EVALUATOR"
}

run_hook() {
    local payload
    payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"x"}}' "$1")
    HOOK_STDERR=$(cd "$REPO_ROOT" && printf '%s' "$payload" | "$HOOK" 2>&1 >/dev/null)
    HOOK_EXIT=$?
}

echo "[fuera] Rutas fuera de scope: hook exit 2 + politica deny"
for p in "src/Foo.cs" "infra/main.tf" ".github/CODEOWNERS" "LICENSE.txt" "docs2/NOTICE" "sub/LICENSE"; do
    run_hook "$p"
    assert_eq "2" "$HOOK_EXIT" "hook Claude sale 2 para $p"
    case "$HOOK_STDERR" in *"FUERA DE SCOPE"*) pass "aviso presente para $p" ;; *) fail "aviso ausente para $p" ;; esac
    for k in edit write patch; do
        assert_eq "deny" "$(eval_perm "$k" "$p")" "politica OpenCode deniega $k en $p"
    done
done

echo "[dentro] Rutas en scope: hook exit 0 silencioso + politica allow"
for p in "commands/x.md" "docs/adr/x.md" "src/internal/scripts/x.sh" "changelog.d/1.changed.md" ".github/workflows/ci.yml" ".github/rulesets/main.json" "LICENSE" "NOTICE"; do
    run_hook "$p"
    assert_eq "0" "$HOOK_EXIT" "hook Claude sale 0 para $p"
    assert_eq "" "$HOOK_STDERR" "hook silencioso para $p"
    for k in edit write patch; do
        assert_eq "allow" "$(eval_perm "$k" "$p")" "politica OpenCode permite $k en $p"
    done
done

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
