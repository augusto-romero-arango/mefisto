#!/usr/bin/env bash
# Contrato del comando scaffold-mcp neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/scaffold-mcp.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/scaffold-mcp.md"
MIRROR="$REPO_ROOT/commands/scaffold-mcp.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "scaffold-mcp" and .profile == "fast" and .arguments == "<proposito>" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:config-path}}' 'lee el config desde config-path'
contains "$body" '{{mefisto:launch-agent mcp-scaffolder ' 'delegacion puntual a mcp-scaffolder'
contains "$(grep -F '{{mefisto:launch-agent' "$SOURCE")" 'PascalCase' 'el mensaje lleva el proposito en PascalCase'
contains "$body" '{{mefisto:package-root}}/mefisto-manifest.json' 'version desde el manifiesto neutral'
contains "$body" 'version desconocida' 'version informativa con fallback'
absent "$body" '.claude-plugin/plugin.json' 'sin plugin.json de runtime'
contains "$body" '{{mefisto:command install-apim}}' 'referencia install-apim'
contains "$body" 'Se va a generar el servidor MCP' 'aviso de lo que se genera'
contains "$body" 'No generes nada tu mismo' 'regla: no generar'
contains "$body" 'idempotente' 'regla: idempotente'
contains "$body" 'Uso: {{mefisto:command scaffold-mcp}} [<proposito>]' 'proposito opcional en la ayuda'
contains "$body" 'PROPOSITO_PASCAL=General' 'sin argumento usa General'
contains "$body" 'servidor MCP General del BC' 'resumen previo informa el servidor General'
contains "$body" 'Mcp.General/' 'detecta Mcp.General existente'
contains "$body" 'pasa un proposito' 'mensaje de parada indica pasar un proposito'
absent "$body" 'Consultas/Comandos' 'ayuda sin particion Consultas/Comandos'
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
usage_line="$(grep -nF 'Uso:' "$SOURCE" | head -1 | cut -d: -f1)"
config_line="$(grep -nF 'namespacePrefix' "$SOURCE" | head -1 | cut -d: -f1)"
launch_line="$(grep -nF '{{mefisto:launch-agent' "$SOURCE" | head -1 | cut -d: -f1)"
[ -n "$guard_line" ] && [ -n "$usage_line" ] && [ -n "$config_line" ] && [ -n "$launch_line" ] && [ "$guard_line" -lt "$usage_line" ] && [ "$usage_line" -lt "$config_line" ] && [ "$config_line" -lt "$launch_line" ] && pass 'guard y pre-condiciones preceden la delegacion' || fail 'guard/pre-condiciones no preceden la delegacion'
for forbidden in 'claude --agent' 'Claude' '.claude/' '.claude-plugin/' '.plugin-root' 'CLAUDE_' 'plugins/cache' 'model:' 'allowed-tools:'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
contains "$claude_body" 'agente `mefisto:mcp-scaffolder`' 'Claude delega con la tool Task'
contains "$claude_body" '/mefisto:install-apim' 'Claude resuelve command install-apim'
absent "$claude_body" 'claude --agent' 'salida Claude sin claude --agent'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/scaffold-mcp.md. No editar a mano. -->' 'mirror conserva marcador generado'
if jq -e '.assets[] | select(.destination == "commands/scaffold-mcp.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then pass 'inventariado en dist/claude'; else fail 'ausente del inventario de dist/claude'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
