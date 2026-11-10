#!/usr/bin/env bash
# Contrato del comando install-workos neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/install-workos.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/install-workos.md"
MIRROR="$REPO_ROOT/commands/install-workos.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "install-workos" and .profile == "balanced" and .arguments == "--domain <Dominio> [--env <env>]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:launch-agent workos-identity-scaffolder ' 'delegacion puntual al agente de identidad'
contains "$body" 'WORKOS_API_KEY (fijo' 'el mensaje fija el app setting WORKOS_API_KEY'
contains "$body" '{{mefisto:command-doc seed-secret}}' 'lee el documento de seed-secret via command-doc'
contains "$body" '{{mefisto:run seed-secret.sh workos-api-key --domain <Dominio> --env <env> --from-github-secret WORKOS_API_KEY}}' 'invocacion neutral de seed-secret.sh'
contains "$body" '{{mefisto:command seed-secret}}' 'remite a seed-secret via command'
contains "$body" '{{mefisto:command install-apim}}' 'remite a install-apim via command'
contains "$body" '{{mefisto:command scaffold}}' 'remite a scaffold via command'
contains "$body" '¿Continuar? (s/n)' 'pide confirmacion explicita'
contains "$body" 'git switch -c install-workos/' 'rama unica compartida'
contains "$body" 'gh variable set WORKOS_CLIENT_ID' 'registra WORKOS_CLIENT_ID como variable'
contains "$body" 'gh secret list' 'verifica existencia de WORKOS_API_KEY'
contains "$body" 'NO VERIFICADO' 'degrada a NO VERIFICADO'
contains "$body" 'git push -u origin install-workos/' 'push de rama unica'
contains "$body" 'Nunca pidas, imprimas ni manejes el valor de `WORKOS_API_KEY`' 'regla: nunca manejar la API key'
contains "$body" 'Nunca ejecutes `terraform plan`' 'regla: nunca plan/apply'
for forbidden in 'claude --agent' '.claude/' 'CLAUDE_' '.plugin-root' 'plugins/cache' 'PLUGIN_SCRIPTS' 'PLUGIN_ROOT' 'commands/seed-secret.md'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done
order_ok=1; prev=0
for marker in '{{mefisto:assert-consumer-repo}}' '¿Continuar? (s/n)' 'git switch -c install-workos/' '{{mefisto:launch-agent' '{{mefisto:run seed-secret.sh' 'gh pr create'; do
    n="$(line_of "$SOURCE" "$marker")"
    if [ -z "$n" ] || [ "$n" -le "$prev" ]; then order_ok=0; fi
    prev="${n:-$prev}"
done
[ "$order_ok" -eq 1 ] && pass 'orden: guard -> confirmacion -> rama -> agente -> seed-secret -> PR' || fail 'orden de pasos invalido'

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced'
contains "$claude_body" 'agente `mefisto:workos-identity-scaffolder`' 'Claude delega puntualmente en mefisto:workos-identity-scaffolder'
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/seed-secret.sh" workos-api-key' 'Claude invoca seed-secret.sh con su runtime'
contains "$claude_body" '"${MEFISTO_PACKAGE_ROOT}/commands/seed-secret.md"' 'Claude lee commands/seed-secret.md'
[ -f "$REPO_ROOT/dist/claude/commands/seed-secret.md" ] && pass 'existe la ruta leida por Claude' || fail 'falta la ruta leida por Claude'
for forbidden in 'claude --agent' 'plugins/cache' 'PLUGIN_SCRIPTS'; do absent "$claude_body" "$forbidden" "claude sin token de runtime: $forbidden"; done
contains "$claude_body" '/mefisto:install-apim' 'Claude resuelve command install-apim'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
if grep -qF 'commands/install-workos.md' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json"; then pass 'inventario de dist/claude lo incluye'; else fail 'inventario de dist/claude no lo incluye'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

echo '[jwt-template] paso 5 guia el JWT Template (issue #2397)'
contains "$body" '"organization_membership_id": "{{ organization_membership.id }}"' 'guia el JWT Template con organization_membership_id'
contains "$body" 'https://workos.com/docs/fga/authkit-integration' 'cita la doc oficial de WorkOS'
contains "$body" '3072 bytes' 'advierte el limite de 3072 bytes'

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
