#!/usr/bin/env bash
# Contrato del agente projections-scaffolder neutral y su proyeccion publicada (issue #1652).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/projections-scaffolder.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/projections-scaffolder.md"
MIRROR="$REPO_ROOT/agents/projections-scaffolder.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[a] metadata y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "projections-scaffolder" and .mode == "all" and .profile == "balanced" and .capabilities == ["read","edit","shell"] and (has("mcp") | not)' >/dev/null; then
    pass 'metadata agent/projections-scaffolder/all/balanced/read-edit-shell sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:config-path}}' 'lee projections.enabled via config-path'
contains "$body" '{{mefisto:instructions-path}}' 'lee RootNamespace via instructions-path'
contains "$body" '{{mefisto:run validate-dockerfile.sh src/<RootNamespace>.Projections/Dockerfile}}' 'valida el Dockerfile via run'

echo '[b] ausencia de acoplamientos'
absent "$body" '.claude/harness.config.json' 'sin config legacy'
absent "$body" 'export MEFISTO_INSTRUCTIONS_PATH' 'sin export de instrucciones'
absent "$body" 'claude --agent' 'sin invocacion directa del CLI'
absent "$body" '/tmp/' 'sin /tmp'
if printf '%s\n' "$body" | grep -E '^[[:space:]]*rm ' | grep -q '\$REPO_ROOT'; then fail 'un rm usa $REPO_ROOT'; else pass 'ningun rm usa $REPO_ROOT'; fi

echo '[salidas]'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'name: "projections-scaffolder"' 'Claude expone el id'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa balanced como sonnet'
absent "$claude_body" '/tmp/' 'Claude sin /tmp'

echo '[c] validacion del Dockerfile por script distribuido'
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/validate-dockerfile.sh"' 'Claude invoca el script con su runtime'
absent "$claude_body" 'docker info' 'claude_body no ejecuta docker info directo'
absent "$claude_body" 'docker build -f "src/' 'claude_body no ejecuta el docker build de validacion directo'

echo '[d] mirror'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror identico a dist/claude'; else fail 'mirror diverge'; fi
inventory="$REPO_ROOT/dist/claude/.mefisto-generated-assets.json"
if jq -e '.assets[] | select(.destination == "agents/projections-scaffolder.md")' "$inventory" >/dev/null 2>&1 \
   && jq -e '.assets[] | select(.destination == "scripts/validate-dockerfile.sh")' "$inventory" >/dev/null 2>&1; then
    pass 'claude inventaria agente y script'
else
    fail 'claude no inventaria agente y script'
fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check al dia'; else fail '--check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
