#!/usr/bin/env bash
# Consolidacion del historial del agente historiador: ejecuta el bloque de shell que publica
# la proyeccion Claude. El resto del contrato del agente esta en historiador-agent.test.mts.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
CLAUDE="$REPO_ROOT/dist/claude/agents/historiador.md"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
claude_body="$(< "$CLAUDE")"

echo '[b] consolidacion del historial'
extract_block() {
    printf '%s\n' "$1" | awk '/^HISTORIAL_CANONICO=/ { on=1 } on { print } on && /^done \| awk/ { exit }'
}
run_case() {
    local dir; dir="$(mktemp -d)"
    mkdir -p "$dir/.mefisto/pipeline" "$dir/.claude/pipeline"
    [ "$1" = 1 ] && printf '{"n":"canon"}\n{"n":"dup"}\n' > "$dir/.mefisto/pipeline/pipeline-history.jsonl"
    [ "$2" = 1 ] && printf '{"n":"legacy-nuevo"}\n{"n":"dup"}\n' > "$dir/.claude/pipeline/pipeline-history.jsonl"
    [ "$3" = 1 ] && printf '{"n":"legacy-viejo"}\n{"n":"dup"}\n' > "$dir/.claude/pipeline/history.jsonl"
    (cd "$dir" && bash -c "$block") 2>/dev/null
    rm -rf "$dir"
}
block="$(extract_block "$claude_body")"
if [ -n "$block" ]; then
    out="$(run_case 1 1 1)"
    for row in canon legacy-nuevo legacy-viejo; do contains "$out" "\"$row\"" "consolida fila $row"; done
    [ "$(printf '%s\n' "$out" | grep -c '"dup"')" = 1 ] && pass 'fila identica contada una vez' || fail 'fila identica duplicada'
    out="$(run_case 1 0 0)"; contains "$out" '"canon"' 'solo canonico: se lee'
    out="$(run_case 0 1 0)"; contains "$out" '"legacy-nuevo"' 'solo legacy pipeline-history: se lee'
    out="$(run_case 0 0 1)"; contains "$out" '"legacy-viejo"' 'solo legacy history: se lee'
else
    fail 'bloque de consolidacion no encontrado'
fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
