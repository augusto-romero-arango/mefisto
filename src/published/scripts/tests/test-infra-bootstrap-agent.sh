#!/usr/bin/env bash
# Contrato del agente infra-bootstrap neutral y sus dos proyecciones publicadas.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/infra-bootstrap.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/infra-bootstrap.md"
OPENCODE="$REPO_ROOT/dist/opencode/agents/infra-bootstrap.md"
MIRROR="$REPO_ROOT/agents/infra-bootstrap.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "infra-bootstrap" and .mode == "all" and .profile == "fast" and .capabilities == ["shell"] and (keys | sort) == ["capabilities", "description", "effort", "id", "kind", "mode", "profile"]' >/dev/null; then
    pass 'metadata declara agent/infra-bootstrap/all/fast/shell sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:run azure-account-info.sh 2>&1}}' 'directiva azure-account-info.sh'
contains "$body" '{{mefisto:run bootstrap-backend.sh --subscription <id> --env <env>}}' 'directiva bootstrap-backend.sh'
contains "$body" '{{mefisto:run setup-github-labels.sh 2>&1}}' 'directiva setup-github-labels.sh'
contains "$body" '{{mefisto:run setup-github-ci.sh <id>}}' 'directiva setup-github-ci.sh'
contains "$body" '{{mefisto:run tmux-pipeline.sh --infra <issue>}}' 'directiva tmux-pipeline.sh --infra'
contains "$body" '{{mefisto:command infra-base}}' 'paso 6 remite a infra-base'
absent "$body" "work-status" "no remite a work-status"
contains "$body" 'az account set --subscription <id>' 'indica cambiar de suscripcion fuera del chat'
contains "$body" 'az login' 'indica az login ante fallo'
contains "$body" 'Nunca le pidas que escriba el id de suscripción' 'no pide el id al usuario'
contains "$body" 'Application Administrator' 'conserva advertencia de privilegios Entra'
contains "$body" 'Role Based Access Control Administrator' 'conserva advertencia de privilegios de suscripcion'
contains "$body" 'Solo detente si' 'conserva solo-detente-si-exit-distinto-de-0'
contains "$body" 'idempotente' 'conserva idempotencia por paso'
contains "$body" 'tmux -CC attach -t infra-<N>' 'instrucciones de conexion tmux'
for secret in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do
    contains "$body" "$secret" "reporta secret $secret"
done

echo '[fuente] sin acoplamientos'
for forbidden in 'PLUGIN_ROOT' '.plugin-root' 'plugins/cache' 'PLUGIN_SCRIPTS' 'az account show' 'iac-pipeline.sh' 'Claude' 'OpenCode' '.claude/pipeline' '.opencode/' 'model:' 'tools:' 'CLAUDE_'; do
    absent "$body" "$forbidden" "fuente sin: $forbidden"
done

echo '[fuente] orden de pasos'
order_ok=1; prev=0
for marker in '### 1. ' '### 2. ' 'azure-account-info.sh' 'bootstrap-backend.sh --subscription' 'setup-github-labels.sh 2>&1}}' 'setup-github-ci.sh <id>}}' '### 6. ' 'tmux-pipeline.sh --infra' '### 8. '; do
    line="$(printf '%s\n' "$body" | grep -nF -- "$marker" | head -1 | cut -d: -f1)"
    if [ -z "$line" ] || [ "$line" -le "$prev" ]; then order_ok=0; break; fi
    prev="$line"
done
if [ "$order_ok" = 1 ]; then pass 'orden backend -> labels -> CI -> base -> pipeline'; else fail 'orden de pasos incorrecto'; fi

echo '[salidas] adaptadores y mirror'
for file in "$CLAUDE" "$OPENCODE"; do [ -f "$file" ] && pass "existe ${file#"$REPO_ROOT/"}" || fail "falta ${file#"$REPO_ROOT/"}"; done
claude_body="$(< "$CLAUDE")"
opencode_body="$(< "$OPENCODE")"
for form in 'azure-account-info.sh" 2>&1' 'bootstrap-backend.sh" --subscription <id> --env <env>' 'setup-github-labels.sh" 2>&1' 'setup-github-ci.sh" <id>' 'tmux-pipeline.sh" --infra <issue>'; do
    contains "$claude_body" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/$form" "Claude invoca $form con su runtime"
    contains "$opencode_body" "MEFISTO_RUNTIME=opencode \"\${MEFISTO_PACKAGE_ROOT}/scripts/$form" "OpenCode invoca $form con su runtime"
done
absent "$claude_body" 'MEFISTO_RUNTIME=opencode' 'Claude no fija el runtime OpenCode'
absent "$opencode_body" 'MEFISTO_RUNTIME=claude' 'OpenCode no fija el runtime Claude'
for out in "$claude_body" "$opencode_body"; do
    absent "$out" 'az account show' 'salida sin az directo'
    absent "$out" 'iac-pipeline.sh' 'salida sin iac-pipeline.sh directo'
    absent "$out" 'PLUGIN_SCRIPTS' 'salida sin PLUGIN_SCRIPTS'
    absent "$out" 'plugins/cache' 'salida sin cache de plugins'
    absent "$out" '{{mefisto:' 'salida sin directivas sin resolver'
done
absent "$opencode_body" '.claude/pipeline/.plugin-root' 'salida OpenCode sin marcador Claude'
contains "$claude_body" 'name: "infra-bootstrap"' 'Claude expone el id del agente'
contains "$claude_body" 'tools: "Bash"' 'Claude deriva solo la capacidad shell'
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
absent "$opencode_body" 'model:' 'OpenCode no emite model'
contains "$opencode_body" 'mode: "all"' 'OpenCode conserva mode all'
contains "$opencode_body" '"bash":{"*":"deny"' 'OpenCode mantiene shell deny por defecto'
absent "$opencode_body" '"az *"' 'OpenCode no habilita az'
case "$claude_body" in *[Mm][Cc][Pp]*) fail 'Claude omite MCP' ;; *) pass 'Claude omite MCP' ;; esac

if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/infra-bootstrap.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
