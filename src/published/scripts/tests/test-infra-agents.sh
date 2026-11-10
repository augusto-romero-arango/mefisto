#!/usr/bin/env bash
# Verifica el corte vertical neutral de infra-writer/infra-reviewer (issue #1625):
# metadata/perfiles, allowlist MCP de Claude, ausencia de tokens de runtime en
# la fuente y paridad byte a byte de los mirrors raiz Claude.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
frontmatter() { awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$1"; }
body() { awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$1"; }

echo '[a] metadata y perfiles de la fuente neutral'
for spec in 'infra-writer|balanced' 'infra-reviewer|deep'; do
    agent="${spec%%|*}"; expected_profile="${spec##*|}"
    source="$REPO_ROOT/src/published/agents/$agent.md"
    if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$source" >/dev/null; then pass "$agent valida contra el contrato"; else fail "$agent no valida contra el contrato"; fi
    metadata="$(frontmatter "$source")"
    if printf '%s' "$metadata" | jq -e --arg id "$agent" --arg profile "$expected_profile" \
        '.kind == "agent" and .id == $id and .mode == "all" and .profile == $profile and .capabilities == ["read", "edit", "shell", "skill"] and .skills == ["code-comments"]' >/dev/null; then
        pass "$agent declara kind/id/mode/profile/capabilities esperados"
    else
        fail "$agent no declara kind/id/mode/profile/capabilities esperados"
    fi
done
writer_mcp="$(frontmatter "$REPO_ROOT/src/published/agents/infra-writer.md" | jq -c '.mcp // []')"
reviewer_mcp="$(frontmatter "$REPO_ROOT/src/published/agents/infra-reviewer.md" | jq -c '.mcp // []')"
[ "$writer_mcp" = '["terraform"]' ] && pass 'infra-writer declara mcp: ["terraform"]' || fail "infra-writer declaro mcp inesperado: $writer_mcp"
[ "$reviewer_mcp" = '[]' ] && pass 'infra-reviewer no declara mcp' || fail "infra-reviewer declaro mcp inesperado: $reviewer_mcp"

echo '[d] ausencia de tokens de runtime en la fuente neutral'
for agent in infra-writer infra-reviewer; do
    agent_body="$(body "$REPO_ROOT/src/published/agents/$agent.md")"
    contains "$agent_body" '{{mefisto:assert-consumer-repo}}' "$agent conserva el guard"
    for token in '.claude' 'claude' 'marketplace' 'cache' 'model:' 'tools:' 'permission:' 'allowed-tools:'; do
        absent "$(printf '%s' "$agent_body" | tr '[:upper:]' '[:lower:]')" "$token" "$agent no menciona token de runtime: $token"
    done
done

echo '[integracion] generacion de las dos salidas y check limpio'
if "$GENERATOR" --out "$WORK" \
    "$REPO_ROOT/src/published/agents/infra-writer.md" \
    "$REPO_ROOT/src/published/agents/infra-reviewer.md" >/dev/null; then
    pass 'el generador procesa ambos agentes en conjunto'
else
    fail 'el generador no proceso ambos agentes en conjunto'
fi

echo '[b] allowlist MCP de Claude'
claude_writer="$(< "$WORK/dist/claude/agents/infra-writer.md")"
claude_reviewer="$(< "$WORK/dist/claude/agents/infra-reviewer.md")"
contains "$claude_writer" 'mcp__terraform__*' 'Claude writer expone el matcher corto de terraform'
contains "$claude_writer" 'mcp__plugin_terraform_terraform__*' 'Claude writer expone el matcher scoped del plugin terraform'
contains "$claude_writer" 'model: "sonnet"' 'Claude writer materializa perfil balanced'
contains "$claude_reviewer" 'model: "opus"' 'Claude reviewer materializa perfil deep'
absent "$claude_reviewer" 'mcp__' 'Claude reviewer no expone ningun matcher MCP'

echo '[e] mirrors identicos'
for agent in infra-writer infra-reviewer; do
    if cmp -s "$WORK/agents/$agent.md" "$WORK/dist/claude/agents/$agent.md"; then
        pass "integracion publica el mirror raiz de $agent"
    else
        fail "integracion no publica el mirror raiz de $agent"
    fi
    if cmp -s "$REPO_ROOT/agents/$agent.md" "$REPO_ROOT/dist/claude/agents/$agent.md"; then
        pass "el mirror raiz versionado de $agent coincide con dist/claude"
    else
        fail "el mirror raiz versionado de $agent diverge de dist/claude"
    fi
done

echo '[inventario] la distribucion registra los dos agentes'
inventory="$WORK/dist/claude/.mefisto-generated-assets.json"
for agent in infra-writer infra-reviewer; do
    if jq -e --arg id "src/published/agents/$agent.md" 'any(.assets[]; .id == $id)' "$inventory" >/dev/null; then
        pass "claude inventaria $agent"
    else
        fail "claude no inventaria $agent"
    fi
done

if "$GENERATOR" --check --out "$WORK" \
    "$REPO_ROOT/src/published/agents/infra-writer.md" \
    "$REPO_ROOT/src/published/agents/infra-reviewer.md" >/dev/null; then
    pass 'check aislado no detecta divergencias, huerfanos ni copias manuales'
else
    fail 'check aislado detecto divergencias, huerfanos o copias manuales'
fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
