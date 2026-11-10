#!/usr/bin/env bash
# Contrato del agente historiador neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/historiador.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/historiador.md"
MIRROR="$REPO_ROOT/agents/historiador.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[a] metadata y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "historiador" and .mode == "all" and .profile == "balanced" and .capabilities == ["read","edit","shell"] and (keys | sort) == ["capabilities","description","effort","id","kind","mode","profile"]' >/dev/null; then
    pass 'metadata agent/historiador/all/balanced/read+edit+shell sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:state-path pipeline-history.jsonl}}' 'historial canonico via state-path'
contains "$body" '{{mefisto:instructions-path}}' 'politica de ramas remite a instructions-path'
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "sonnet"' 'Claude materializa balanced'
contains "$claude_body" 'name: "historiador"' 'Claude expone el id'

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
contains "$body" 'HISTORIALES_LEGACY' 'legacy declarado en su propio bloque'

echo '[c] sin CLAUDE.md literal ni tokens de runtime'
absent "$body" 'CLAUDE.md' 'fuente sin CLAUDE.md literal'
for forbidden in 'model:' 'tools:' 'allowed-tools:' 'permission:' '.plugin-root' 'CLAUDE_'; do
    absent "$body" "$forbidden" "fuente sin token de runtime: $forbidden"
done

echo '[d] contrato del mensaje final'
contains "$body" 'PR #123' 'menciona el formato PR #<numero>'
contains "$body" 'debe incluir explicitamente el numero del PR' 'exige reportar el numero'
contains "$body" 'mergear el PR no es tu trabajo' 'prohibe mergear'
contains "$body" 'git push -u origin HEAD' 'conserva push'
contains "$body" 'gh pr create --base main' 'conserva gh pr create'

echo '[e] mirror'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/historiador.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
