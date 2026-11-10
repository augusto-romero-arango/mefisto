#!/usr/bin/env bash
# Contrato del agente pr-sync neutral y sus dos proyecciones publicadas.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/pr-sync.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/pr-sync.md"
OPENCODE="$REPO_ROOT/dist/opencode/agents/pr-sync.md"
MIRROR="$REPO_ROOT/agents/pr-sync.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "pr-sync" and .mode == "all" and .profile == "balanced" and .capabilities == ["shell"] and (keys | sort) == ["capabilities", "description", "effort", "id", "kind", "mode", "profile"]' >/dev/null; then
    pass 'metadata declara agent/pr-sync/all/balanced/shell sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:run pr-sync.sh <PRs>}}' 'invoca pr-sync.sh sin merge'
contains "$body" '{{mefisto:run pr-sync.sh <PRs> --merge}}' 'invoca pr-sync.sh con merge y lista de PRs'
contains "$body" '{{mefisto:run pr-sync.sh --all}}' 'invoca pr-sync.sh con --all sin merge'
contains "$body" '{{mefisto:run pr-sync.sh --all --merge}}' 'invoca pr-sync.sh con --all y merge'
contains "$body" '{{mefisto:run pr-sync.sh <num>}}' 'reintento de un PR puntual via directiva run'
contains "$body" '{{mefisto:state-path logs}}' 'apunta al log via state-path'
contains "$body" 'pr-sync-<ts>.log' 'nombre de log con timestamp fuera de la directiva'
contains "$body" '{{mefisto:command merge}}' 'recomienda /mefisto:merge para el flujo con validaciones'
absent "$body" "work-status" "no remite a work-status"
contains "$body" 'NUNCA instales software' 'regla: nunca instalar software'
contains "$body" 'NUNCA ejecutes comandos git/gh por tu cuenta' 'regla: nunca compensar con git/gh manuales'
contains "$body" 'NUNCA diagnostiques ni arregles problemas del script' 'regla: nunca diagnosticar el script'
contains "$body" 'listar PRs' 'flujo: listar PRs'
contains "$body" 'confirma el orden' 'flujo: confirmar el orden'
contains "$body" 'reportar resultado' 'flujo: reportar resultado'
contains "$body" 'sincronizados' 'reporta PRs sincronizados'
contains "$body" 'mergeados' 'reporta PRs mergeados'
contains "$body" 'al día' 'reporta PRs al dia'
contains "$body" 'no lo inspecciones tú' 'worktree temporal queda como sugerencia al usuario, no como comando propio'
absent "$body" './scripts/' 'fuente no referencia ./scripts/ con ruta relativa'
for forbidden in 'Claude' 'OpenCode' '.claude/' '.opencode/' 'cache' 'model:' 'tools:' 'allowed-tools:' 'permission:' '.plugin-root' 'CLAUDE_'; do
    absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"
done

echo '[salidas] adaptadores y mirror'
for file in "$CLAUDE" "$OPENCODE"; do [ -f "$file" ] && pass "existe ${file#"$REPO_ROOT/"}" || fail "falta ${file#"$REPO_ROOT/"}"; done
claude_body="$(< "$CLAUDE")"
opencode_body="$(< "$OPENCODE")"
for form in '<PRs>' '<PRs> --merge' '--all' '--all --merge' '<num>'; do
    contains "$claude_body" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh\" $form" "Claude invoca pr-sync.sh $form con su runtime"
    contains "$opencode_body" "MEFISTO_RUNTIME=opencode \"\${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh\" $form" "OpenCode invoca pr-sync.sh $form con su runtime"
done
absent "$claude_body" 'MEFISTO_RUNTIME=opencode' 'Claude no fija el runtime OpenCode'
absent "$opencode_body" 'MEFISTO_RUNTIME=claude' 'OpenCode no fija el runtime Claude'
contains "$claude_body" 'name: "pr-sync"' 'Claude expone el id del agente'
contains "$claude_body" 'tools: "Bash"' 'Claude deriva solo la capacidad shell'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced'
absent "$opencode_body" 'model:' 'OpenCode no emite model'
contains "$opencode_body" 'mode: "all"' 'OpenCode conserva mode all'
contains "$opencode_body" '"bash":{"*":"deny"' 'OpenCode mantiene shell deny por defecto salvo reglas explicitas'
contains "$opencode_body" '"skill":"deny"' 'OpenCode no habilita Skills para este agente'
case "$claude_body" in *[Mm][Cc][Pp]*) fail 'Claude omite MCP' ;; *) pass 'Claude omite MCP' ;; esac

# El preambulo compartido de resolucion de MEFISTO_PACKAGE_ROOT (identico en
# todo artefacto ya migrado, p.ej. merge.md) cita el marcador canonico Claude
# como fallback de lectura legado y queda fuera de este chequeo; solo se
# exige que las invocaciones propias de pr-sync.sh no lo reimplementen y que
# la salida OpenCode completa no lo mencione.
claude_invocations="$(printf '%s\n' "$claude_body" | grep -F 'scripts/pr-sync.sh"')"
opencode_invocations="$(printf '%s\n' "$opencode_body" | grep -F 'scripts/pr-sync.sh"')"
for forbidden_path in './scripts/pr-sync.sh' '.claude/pipeline/.plugin-root' 'plugins/cache'; do
    absent "$claude_invocations" "$forbidden_path" "invocacion Claude no reimplementa el lookup legacy ($forbidden_path)"
    absent "$opencode_invocations" "$forbidden_path" "invocacion OpenCode no reimplementa el lookup legacy ($forbidden_path)"
done
absent "$opencode_body" '.claude/pipeline/.plugin-root' 'salida OpenCode completa sin marcador Claude'
absent "$claude_body" 'plugins/cache' 'salida Claude completa sin cache de plugins'
absent "$opencode_body" 'plugins/cache' 'salida OpenCode completa sin cache de plugins'
absent "$claude_body" './scripts/pr-sync.sh' 'salida Claude completa sin ruta relativa rota'
absent "$opencode_body" './scripts/pr-sync.sh' 'salida OpenCode completa sin ruta relativa rota'

if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/pr-sync.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
