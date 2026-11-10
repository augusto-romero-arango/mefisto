#!/usr/bin/env bash
# Contrato del agente bug-investigator neutral y su proyeccion publicada (issue #1667).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/bug-investigator.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/bug-investigator.md"
MIRROR="$REPO_ROOT/agents/bug-investigator.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[a] metadata, perfil y capacidad web'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "bug-investigator" and .mode == "all" and .profile == "deep" and .capabilities == ["read","edit","shell","web"] and (has("mcp") | not)' >/dev/null; then
    pass 'metadata agent/bug-investigator/all/deep/read-edit-shell-web sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:instructions-path}}' 'lee instrucciones via instructions-path'
contains "$body" '{{mefisto:config-path}}' 'lee el config via config-path'
contains "$body" 'docs/bitacora/field-notes/' 'conserva la restriccion de escritura'
contains "$body" 'plan-sites' 'usa plan-sites'
contains "$body" 'plan-metrics' 'usa plan-metrics'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'name: "bug-investigator"' 'Claude expone el id'
contains "$claude_body" 'model: "opus"' 'Claude materializa deep como opus'
contains "$claude_body" 'WebSearch' 'Claude emite WebSearch'
contains "$claude_body" 'WebFetch' 'Claude emite WebFetch'

echo '[b] invocaciones de appinsights-query.sh'
total="$(printf '%s\n' "$claude_body" | grep -c 'appinsights-query\.sh')"
good="$(printf '%s\n' "$claude_body" | grep -c "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh\"")"
if [ "$total" -gt 0 ] && [ "$total" -eq "$good" ]; then pass "claude: $good invocaciones via MEFISTO_PACKAGE_ROOT con su runtime"; else fail "claude: $good de $total invocaciones bien formadas"; fi

echo '[c] ausencia de acoplamientos'
for var in body claude_body; do
    text="${!var}"
    if printf '%s\n' "$text" | grep -Eq '(^|[[:space:]=])/tmp/'; then fail "$var con /tmp/"; else pass "$var sin /tmp/"; fi
    absent "$text" './scripts/' "$var sin ./scripts/"
    if printf '%s\n' "$text" | grep -Eq '(^|[^A-Za-z])az [a-z]'; then fail "$var con az directo"; else pass "$var sin az directo"; fi
done
absent "$body" 'CLAUDE.md' 'la fuente sin CLAUDE.md'
absent "$body" 'curl ' 'la fuente sin curl'
absent "$body" 'MEFISTO_RUNTIME=claude' 'la fuente sin runtime claude'
absent "$body" '{{mefisto:state-path tmp}}/../' 'sin escape del state-path'
contains "$body" '{{mefisto:state-path tmp}}/publish' 'publish bajo state-path tmp'
contains "$body" '{{mefisto:state-path tmp}}/decompiled-vieja' 'decompilado bajo state-path tmp'

echo '[d] mirror e inventario'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror identico a dist/claude'; else fail 'mirror diverge'; fi
if jq -e '.assets[] | select(.destination == "agents/bug-investigator.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then
    pass 'claude inventaria el agente'
else
    fail 'claude no inventaria el agente'
fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check al dia'; else fail '--check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
