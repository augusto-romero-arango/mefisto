#!/usr/bin/env bash
# Contrato del comando next-order neutral y su proyeccion publicada.
# La linea de lanzamiento es el literal /mefisto:sequential: el validador no
# admite una directiva anidada en los argumentos de `run`, y el adaptador
# materializa {{mefisto:command}} como /mefisto:<id>, asi que el literal es igual.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/next-order.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/next-order.md"
MIRROR="$REPO_ROOT/commands/next-order.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "next-order" and .profile == "fast" and (keys | sort) == ["description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin arguments, agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:run next-order.sh --launch-command "/mefisto:sequential" --parallel-command "/mefisto:parallel"}}' 'invocacion neutral del script'
contains "$body" 'El lote parallel lo calcula el script' 'delega el lote parallel al script'
contains "$body" 'ADVERTENCIA' 'conserva la advertencia de universo truncado'
contains "$body" '$ARGUMENTS' 'avisa que ignora argumentos'
contains "$body" 'solo lectura' 'regla de solo lectura'
for forbidden in '.claude/' '.plugin-root' 'plugins/cache' 'claude --agent'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" '"${MEFISTO_PACKAGE_ROOT}/scripts/next-order.sh" --launch-command "/mefisto:sequential" --parallel-command "/mefisto:parallel"' 'Claude invoca next-order.sh'
absent "$claude_body" 'claude --agent' 'sin claude --agent'
absent "$claude_body" '{{mefisto:' 'sin directivas sin resolver'
absent "$claude_body" 'plugins/cache' 'sin plugins/cache'
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" 'GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/next-order.md' 'mirror conserva marcador generado'

echo '[assets] next-order.sh empaquetado'
dist="$REPO_ROOT/dist/claude/scripts/next-order.sh"
if [ -x "$dist" ]; then pass "next-order.sh ejecutable en dist/claude"; else fail "falta next-order.sh ejecutable en dist/claude"; fi
if cmp -s "$REPO_ROOT/scripts/next-order.sh" "$dist"; then pass "dist/claude identico a la fuente"; else fail "dist/claude diverge de la fuente"; fi
if jq -e '.assets[] | select(.destination == "scripts/next-order.sh")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then pass "inventario de dist/claude lo incluye"; else fail "inventario de dist/claude no lo incluye"; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
