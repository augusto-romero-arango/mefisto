#!/usr/bin/env bash
# Contrato del comando install-auth neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/install-auth.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/install-auth.md"
MIRROR="$REPO_ROOT/commands/install-auth.md"
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
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "install-auth" and .profile == "balanced" and .arguments == "--identity-domain <Dominio> --domain <Dominio> [--domain <Dominio2> ...] [--env <env>] [--cors-origin <origin> ...]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:command-doc install-workos}}' 'lee command-doc install-workos'
contains "$body" '{{mefisto:command-doc install-apim}}' 'lee command-doc install-apim'
for cmd in install-workos install-apim infra-base scaffold; do contains "$body" "{{mefisto:command $cmd}}" "remite a $cmd via command"; done
contains "$body" '{{mefisto:package-root}}/agents/domain-scaffolder.md' 'domain-scaffolder por package-root'
for forbidden in '.plugin-root' 'plugins/cache' 'commands/install-workos.md' 'commands/install-apim.md' '.claude/' 'CLAUDE_' 'PLUGIN_ROOT'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done
order_ok=1; prev=0
for marker in '{{mefisto:assert-consumer-repo}}' 'FALTA la infraestructura base' 'FALTA: es la primera instalacion del gateway APIM' '¿Continuar? (s/n)' 'git switch -c "install-auth/' '### 5. Etapa 1' 'gh variable list' '### 7. Etapa 2' 'gh pr create'; do
    n="$(line_of "$SOURCE" "$marker")"
    if [ -z "$n" ] || [ "$n" -le "$prev" ]; then order_ok=0; printf '    orden: %s -> %s\n' "$marker" "${n:-ausente}"; fi
    prev="${n:-$prev}"
done
[ "$order_ok" -eq 1 ] && pass 'orden: guard -> prerequisitos -> CORS -> confirmacion -> rama -> etapa 1 -> gate -> etapa 2 -> PR' || fail 'orden de pasos invalido'
for marker in 'verbo QUERY' 'App Insights' 'codigo de exito documentado' 'headers de identidad'; do absent "$body" "$marker" "sin copia del checklist post-deploy: $marker"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced'
contains "$claude_body" '"${MEFISTO_PACKAGE_ROOT}/commands/install-workos.md"' 'Claude lee install-workos'
contains "$claude_body" '"${MEFISTO_PACKAGE_ROOT}/commands/install-apim.md"' 'Claude lee install-apim'
for id in install-workos install-apim; do
    [ -f "$REPO_ROOT/dist/claude/commands/$id.md" ] && pass "existe dist/claude/commands/$id.md" || fail "falta dist/claude/commands/$id.md"
done
absent "$claude_body" 'plugins/cache' 'claude sin token de runtime: plugins/cache'
contains "$claude_body" '/mefisto:install-workos' 'Claude resuelve command install-workos'
contains "$claude_body" '/mefisto:install-apim' 'Claude resuelve command install-apim'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
if grep -qF 'commands/install-auth.md' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json"; then pass 'inventario de dist/claude lo incluye'; else fail 'inventario de dist/claude no lo incluye'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
