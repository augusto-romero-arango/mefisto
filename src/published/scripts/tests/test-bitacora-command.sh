#!/usr/bin/env bash
# Contrato del comando bitacora neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/bitacora.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/bitacora.md"
MIRROR="$REPO_ROOT/commands/bitacora.md"
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
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "bitacora" and .profile == "fast" and .arguments == "[YYYY-MM-DD]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:launch-agent historiador ' 'delegacion puntual a historiador'
contains "$body" 'unicamente las field notes del dia <fecha>' 'mensaje con filtro de fecha'
contains "$body" '{{mefisto:command-doc merge}}' 'lee command-doc merge'
contains "$body" 'gh pr view <num> --json number,state,headRefName,files' 'verifica el PR con gh pr view'
contains "$body" 'docs/bitacora/' 'exige archivos bajo docs/bitacora/'
contains "$body" 'mensaje final' 'PR tomado del mensaje final'
contains "$body" 'No pidas ninguna confirmacion adicional' 'sin confirmacion antes de mergear'
contains "$body" 'gh pr merge' 'regla de no merges manuales'
contains "$body" 'No diagnostiques errores de `pr-sync.sh`' 'regla de no diagnosticar pr-sync'
for forbidden in 'claude --agent' '.plugin-root' 'plugins/cache' 'commands/merge.md' 'CLAUDE_' '.claude/' 'PLUGIN_ROOT'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done
order_ok=1; prev=0
for marker in '{{mefisto:assert-consumer-repo}}' '{{mefisto:launch-agent historiador ' 'gh pr view <num>' '{{mefisto:command-doc merge}}'; do
    n="$(line_of "$SOURCE" "$marker")"
    if [ -z "$n" ] || [ "$n" -le "$prev" ]; then order_ok=0; printf '    orden: %s -> %s\n' "$marker" "${n:-ausente}"; fi
    prev="${n:-$prev}"
done
[ "$order_ok" -eq 1 ] && pass 'orden: guard -> historiador -> verificacion del PR -> merge' || fail 'orden de pasos invalido'

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
contains "$claude_body" 'mefisto:historiador' 'Claude delega en mefisto:historiador'
contains "$claude_body" '"${MEFISTO_PACKAGE_ROOT}/commands/merge.md"' 'Claude lee merge'
[ -f "$REPO_ROOT/dist/claude/commands/merge.md" ] && pass 'existe dist/claude/commands/merge.md' || fail 'falta dist/claude/commands/merge.md'
for forbidden in 'plugins/cache' 'claude --agent'; do absent "$claude_body" "$forbidden" "claude sin token de runtime: $forbidden"; done
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
if grep -qF 'commands/bitacora.md' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json"; then pass 'inventario de dist/claude lo incluye'; else fail 'inventario de dist/claude no lo incluye'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
