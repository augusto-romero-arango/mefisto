#!/usr/bin/env bash
# Demuestra la trazabilidad entre los siete hooks de Claude y los hechos neutrales.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
HOOKS="$REPO_ROOT/hooks/hooks.json"
CONTRACT="$REPO_ROOT/src/published/hooks/interactive-hooks.json"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq no instalado"; exit 0; }

echo "[pre] hooks de Claude y contrato"
if jq empty "$HOOKS" && jq empty "$CONTRACT"; then pass "ambos documentos son JSON validos"; else fail "algún documento no es JSON valido"; fi
hook_count=$(jq '[.hooks[][].hooks[]?.command] | length' "$HOOKS")
contract_count=$(jq '.bindings | length' "$CONTRACT")
[ "$hook_count" = "7" ] && [ "$contract_count" = "7" ] && pass "hay siete hooks y el contrato tiene siete hechos" || fail "conteos hooks=$hook_count contrato=$contract_count"

trace() {
    local id="$1" filter="$2"
    hooks=$(jq -r "$filter" "$HOOKS")
    neutral=$(jq -r --arg id "$id" '[.bindings[] | select(.id == $id)] | length' "$CONTRACT")
    if [ "$hooks" = "1" ] && [ "$neutral" = "1" ]; then pass "$id traza un hook"; else fail "$id: hooks=$hooks neutral=$neutral"; fi
}

trace record-active-release '[.hooks.SessionStart[].hooks[] | select(.args[1] == "record-active-release")] | length'
trace append-session '[.hooks.SessionStart[].hooks[] | select(.args[1] == "append-session")] | length'
trace append-session-model '[.hooks.Stop[].hooks[] | select(.args[1] == "append-session-model")] | length'
trace remind-field-notes '[.hooks.Stop[].hooks[] | select(.args[1] == "remind-field-notes")] | length'
trace append-file-change '[.hooks.PostToolUse[] | select(.matcher == "Write|Edit") | .hooks[] | select(.args[1] == "append-file-change")] | length'
trace append-dotnet-test-result '[.hooks.PostToolUse[] | select(.matcher == "Bash") | .hooks[] | select(.args[1] == "append-dotnet-test-result")] | length'
trace append-terraform-result '[.hooks.PostToolUse[] | select(.matcher == "Bash") | .hooks[] | select(.args[1] == "append-terraform-result")] | length'

ids=$(jq -r '[.bindings[].id] | sort | join(" ")' "$CONTRACT")
model_binding=$(jq -r '[.bindings[] | select(.id == "append-session-model" and .signal == "session.model-observed" and .action == "append-session-model")] | length' "$CONTRACT")
[ "$model_binding" = "1" ] && pass "append-session-model declara el hecho posterior neutral" || fail "append-session-model no esta declarado exactamente una vez"

expected='append-dotnet-test-result append-file-change append-session append-session-model append-terraform-result record-active-release remind-field-notes'
[ "$ids" = "$expected" ] && pass "no hay bindings huerfanos" || fail "bindings inesperados: $ids"
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
