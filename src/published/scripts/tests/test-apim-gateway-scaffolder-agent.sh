#!/usr/bin/env bash
# Contrato del agente apim-gateway-scaffolder neutral y su proyeccion publicada
# (issue #1656: migracion desde agents/apim-gateway-scaffolder.md hand-escrito Claude-only).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/apim-gateway-scaffolder.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/apim-gateway-scaffolder.md"
MIRROR="$REPO_ROOT/agents/apim-gateway-scaffolder.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] (a) metadata y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "apim-gateway-scaffolder" and .mode == "all" and .profile == "balanced" and .capabilities == ["read","edit","shell","web"] and (has("mcp") | not)' >/dev/null; then
    pass 'metadata declara agent/apim-gateway-scaffolder/all/balanced/read-edit-shell-web sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:instructions-path}}' 'cita Verificacion de fuentes via instructions-path'
contains "$body" 'https://api.workos.com/user_management/<client_id>/.well-known/openid-configuration' 'Paso 0.3 apunta al discovery doc'
contains "$body" 'NO VERIFICADO -- reconfirmar antes de aplicar' 'se conserva la marca NO VERIFICADO'

echo '[fuente] (b) ausencia de curl y de tokens de runtime'
for pattern in 'curl' 'export MEFISTO_INSTRUCTIONS_PATH' '.claude' 'claude --agent' 'AGENTS.md' 'CLAUDE.md'; do
    absent "$body" "$pattern" "fuente no contiene '$pattern'"
done

echo '[salidas] adaptador y capacidad web'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'name: "apim-gateway-scaffolder"' 'Claude expone el id del agente'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced como sonnet'
contains "$claude_body" 'WebFetch' 'Claude emite WebFetch'
contains "$claude_body" 'WebSearch' 'Claude emite WebSearch'
absent "$claude_body" 'curl -' 'claude_body no invoca curl'
absent "$claude_body" 'claude --agent' 'claude_body no invoca el CLI de un runtime'

echo '[mirror] agents/apim-gateway-scaffolder.md pasa a generado'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/apim-gateway-scaffolder.md. No editar a mano. -->' 'mirror conserva marcador generado'
if jq -e '.assets[] | select(.destination == "agents/apim-gateway-scaffolder.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then
    pass 'claude inventaria el agente'
else
    fail 'claude no inventaria el agente'
fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

echo '[org-membership] header X-Organization-Membership-Id (issue #2397)'
contains "$body" '<set-header name="X-Organization-Membership-Id" exists-action="override">' 'politica emite set-header X-Organization-Membership-Id con override'
contains "$body" '${var.claim_organization_membership_id}' 'politica usa el claim de la variable'
contains "$body" 'variable "claim_organization_membership_id"' 'declara la variable claim_organization_membership_id'
contains "$body" 'default     = "organization_membership_id"' 'default organization_membership_id'
contains "$body" 'los tres `<set-header>`' 'nota B10 habla de tres set-header'
contains "$body" 'variable "apim_claim_organization_membership_id"' 'apim.tf del entorno declara apim_claim_organization_membership_id'
contains "$body" 'claim_organization_membership_id = var.apim_claim_organization_membership_id' 'apim.tf cablea la variable al modulo'

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
