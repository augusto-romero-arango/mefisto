#!/usr/bin/env bash
# Contrato del comando onboard neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/onboard.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/onboard.md"
MIRROR="$REPO_ROOT/commands/onboard.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }

echo '[a] metadata y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "onboard" and .profile == "fast" and (keys | sort) == ["description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin arguments, agent ni capabilities'; else fail 'metadata neutral invalida'; fi
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'

echo '[b] invocaciones de scripts'
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
guards="$(grep -cF '{{mefisto:assert-consumer-repo}}' "$SOURCE")"
[ "$guards" -eq 1 ] && pass 'guard de consumidor una sola vez' || fail "guard de consumidor aparece $guards veces"
for s in onboard-diagnose.sh onboard-migrate-directives.sh setup-github-labels.sh setup-github-ci.sh bootstrap-backend.sh; do
    contains "$claude_body" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/$s\"" "claude invoca $s"
done
contains "$claude_body" 'onboard-migrate-directives.sh" --preview' 'claude usa --preview'
contains "$claude_body" 'onboard-migrate-directives.sh" --apply' 'claude usa --apply'

echo '[c] command-doc de scaffold-projections'
contains "$body" '{{mefisto:command-doc scaffold-projections}}' 'fuente lee command-doc'
contains "$claude_body" '"${MEFISTO_PACKAGE_ROOT}/commands/scaffold-projections.md"' 'Claude lee scaffold-projections'
for cmd in install-auth scaffold-projections infra-base scaffold; do contains "$body" "{{mefisto:command $cmd}}" "remite a $cmd via command"; done

echo '[d] ausencia de tokens de runtime'
for forbidden in '.plugin-root' 'plugins/cache' 'PLUGIN_SCRIPTS' 'PLUGIN_ROOT' 'commands/scaffold-projections.md' 'CLAUDE_' '.claude/'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done
for forbidden in 'plugins/cache' 'PLUGIN_SCRIPTS'; do absent "$claude_body" "$forbidden" "claude sin $forbidden"; done

echo '[e] cada provision despues de su confirmacion'
check_order() {
    local q r nq nr
    q="$1"; r="$2"
    nq="$(line_of "$SOURCE" "$q")"; nr="$(line_of "$SOURCE" "$r")"
    if [ -n "$nq" ] && [ -n "$nr" ] && [ "$nq" -le "$nr" ]; then pass "confirmacion antes de: $r"; else fail "orden invalido: '$q' (${nq:-ausente}) vs '$r' (${nr:-ausente})"; fi
}
check_order 'pregunta si desea aplicar' 'onboard-migrate-directives.sh --apply}}'
check_order '¿Quieres que los provisione ahora?' 'setup-github-labels.sh 2>&1}}'
check_order '¿Quieres que lo configure ahora? [si/no]' 'bootstrap-backend.sh --subscription'
check_order '¿Quieres que lo configure ahora? [si/no]' 'setup-github-ci.sh <subscription-id>}}'
check_order '¿Confirmas? [si/no]' 'ESTRATEGIA="<'
check_order '¿Quieres que corra' 'command-doc scaffold-projections}}'
check_order 'pregunta si desea aplicar **ese contenido exacto**' 'onboard-provision-appinsights.sh --apply}}'
check_order 'onboard-provision-appinsights.sh --preview}}' 'onboard-provision-appinsights.sh --apply}}'
contains "$body" 'Provision opt-in de `.mefisto/appinsights.env`' 'paso de provision de appinsights.env'
contains "$body" 'FALTA` para `.mefisto/appinsights.env`' 'el paso solo se ofrece ante FALTA'
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-provision-appinsights.sh"' 'claude invoca onboard-provision-appinsights.sh'

echo '[f] mirror y salidas'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
if grep -qF 'commands/onboard.md' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json"; then pass 'inventario de dist/claude lo incluye'; else fail 'inventario de dist/claude no lo incluye'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
