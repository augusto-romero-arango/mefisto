#!/usr/bin/env bash
# Contrato del agente workos-identity-scaffolder neutral y su proyeccion publicada
# (issue #1654: migracion desde agents/workos-identity-scaffolder.md hand-escrito Claude-only).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/workos-identity-scaffolder.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/workos-identity-scaffolder.md"
MIRROR="$REPO_ROOT/agents/workos-identity-scaffolder.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] (a) metadata y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "workos-identity-scaffolder" and .mode == "all" and .profile == "balanced" and .capabilities == ["read","edit","shell"] and (has("mcp") | not)' >/dev/null; then
    pass 'metadata declara agent/workos-identity-scaffolder/all/balanced/read-edit-shell sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:instructions-path}}' 'lee RootNamespace via instructions-path'

echo '[fuente] (b) ausencia de curl y de tokens de runtime'
for pattern in 'curl' 'export MEFISTO_INSTRUCTIONS_PATH' '.claude' 'claude --agent' 'AGENTS.md' 'CLAUDE.md'; do
    absent "$body" "$pattern" "fuente no contiene '$pattern'"
done

echo '[c] Paso 0.5 usa dotnet package search'
search='dotnet package search WorkOS.net --exact-match --format json --source https://api.nuget.org/v3/index.json'
contains "$body" "$search" 'Paso 0.5 usa dotnet package search'
contains "$body" '5.5.0' 'se conserva la version fijada 5.5.0'
contains "$body" 'NO VERIFICADO contra NuGet en esta corrida' 'se conserva la marca NO VERIFICADO'

echo '[salida] adaptador'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'name: "workos-identity-scaffolder"' 'Claude expone el id del agente'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced como sonnet'
contains "$claude_body" "$search" 'claude_body conserva dotnet package search'
absent "$claude_body" 'claude --agent' 'claude_body no invoca el CLI de un runtime'

echo '[mirror] agents/workos-identity-scaffolder.md pasa a generado'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/workos-identity-scaffolder.md. No editar a mano. -->' 'mirror conserva marcador generado'
if jq -e '.assets[] | select(.destination == "agents/workos-identity-scaffolder.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then
    pass 'claude inventaria el agente'
else
    fail 'claude no inventaria el agente'
fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
