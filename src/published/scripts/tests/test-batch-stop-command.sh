#!/usr/bin/env bash
# Contrato del comando batch-stop neutral y su proyeccion publicada
# (issue #1596: migracion desde el formato Claude-only commands/batch-stop.md).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/batch-stop.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/batch-stop.md"
MIRROR="$REPO_ROOT/commands/batch-stop.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
# Forma previa a #2206: la raiz de la senal era --show-toplevel sin pasar por --git-common-dir.
SOLO_TOPLEVEL='REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ERROR: no estas en un repositorio git"; exit 1; }
pgrep'
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
absent_word() {
    # Verifica que <palabra> nunca aparece como token de shell independiente
    # (limites de inicio/fin de linea, espacio o separadores ; & |), a
    # diferencia de una subcadena que puede caer dentro de otra palabra
    # (p.ej. "rm" dentro de "confirmar").
    if printf '%s' "$1" | grep -Eqc "(^|[;&|[:space:]])$2([[:space:]]|\$)"; then
        fail "$3"
    else
        pass "$3"
    fi
}

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "batch-stop" and .profile == "fast" and (keys | sort) == ["description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin arguments, agent ni capabilities (CA-1)'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor antes del proceso'
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
operation_line="$(awk '/pgrep -f/ { print NR; exit }' "$SOURCE")"
[ -n "$guard_line" ] && [ -n "$operation_line" ] && [ "$guard_line" -lt "$operation_line" ] && pass 'guard precede cualquier operacion' || fail 'guard no precede las operaciones'
contains "$body" '{{mefisto:command sequential}}' 'referencia neutral a sequential'
contains "$body" '{{mefisto:command parallel}}' 'referencia neutral a parallel'
contains "$body" '{{mefisto:command batch-stop}}' 'autoreferencia neutral (confirmacion ya dada)'
contains "$body" 'pgrep -f "[s]cripts/batch-pipeline\.sh"' 'patron de deteccion sin auto-coincidencia'
contains "$body" 'pipeline-state/batch-stop' 'ruta de la senal relativa a la raiz del repo'
contains "$body" 'git -C "$REPO_ROOT" rev-parse --git-common-dir' 'la raiz de la senal sale de --git-common-dir (#2206)'
absent "$body" "$SOLO_TOPLEVEL" 'la fuente ya no escribe la senal en --show-toplevel a secas (#2206)'
for forbidden in 'Claude' '.claude/' 'cache' 'model:' 'tools:' 'allowed-tools:' 'permission:' '.claude-plugin' 'CLAUDE_' '/mefisto-batch-stop'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
content="$(< "$CLAUDE")"
contains "$content" 'pgrep -f "[s]cripts/batch-pipeline\.sh"' "claude conserva el patron de deteccion (CA-5a)"
contains "$content" 'pipeline-state/batch-stop' "claude conserva la ruta de la senal (CA-5a)"
contains "$content" 'git -C "$REPO_ROOT" rev-parse --git-common-dir' "claude usa --git-common-dir para la raiz de la senal (#2206)"
absent "$content" "$SOLO_TOPLEVEL" "claude ya no escribe la senal en --show-toplevel a secas (#2206)"
absent_word "$content" kill "claude no invoca kill (CA-5b)"
absent_word "$content" pkill "claude no invoca pkill (CA-5b)"
absent_word "$content" rm "claude no invoca rm (CA-5b)"
contains "$(< "$CLAUDE")" 'model: "haiku"' 'Claude materializa el perfil fast (CA-5c)'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/batch-stop.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
