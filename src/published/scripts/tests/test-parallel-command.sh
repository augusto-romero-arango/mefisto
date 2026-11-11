#!/usr/bin/env bash
# Contrato del comando parallel neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/parallel.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/parallel.md"
MIRROR="$REPO_ROOT/commands/parallel.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "parallel" and .profile == "fast" and .arguments == "<issue1> <issue2> ... [--pipeline tdd|tooling]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
operation_line="$(awk '/gh issue view/ { print NR; exit }' "$SOURCE")"
[ -n "$guard_line" ] && [ -n "$operation_line" ] && [ "$guard_line" -lt "$operation_line" ] && pass 'guard precede cualquier operacion' || fail 'guard no precede las operaciones'
contains "$body" '{{mefisto:run launch-pipeline.sh --parallel $ARGUMENTS}}' 'despacho neutral exacto'
[ "$(grep -cF '{{mefisto:run launch-pipeline.sh --parallel $ARGUMENTS}}' "$SOURCE")" -eq 1 ] && pass 'existe un unico despacho' || fail 'el despacho no es unico'
contains "$body" 'gh issue view' 'valida issues antes de lanzar'
contains "$body" 'esta cerrado, informalo y excluyelo' 'excluye issues inexistentes o cerrados'
contains "$body" 'Si no queda ningun issue valido, detente' 'se detiene sin issues validos'
contains "$body" 'pasando `--pipeline` si el usuario lo proporciono' 'pasa --pipeline al wrapper'
contains "$body" 'arranques escalonados de 30s' 'documenta arranque escalonado en Herdr'
contains "$body" 'sin pane: lo sigue la consola de Fausto' 'reconoce el modo desacoplado por la salida del wrapper'
contains "$body" 'Pipeline paralelo corriendo sin panes. Para monitorear, en otra terminal:' 'documenta el seguimiento desacoplado fuera de Herdr'
contains "$body" 'stream-watch.sh' 'remite al visor en otra terminal'
contains "$body" '{{mefisto:state-path logs}}' 'documenta logs por issue'
contains "$body" '{{mefisto:state-path events.log}}' 'documenta events.log'
absent "$body" 'propio tab' 'describe correctamente panes, no tabs'
for command in merge batch-stop sequential; do contains "$body" "{{mefisto:command $command}}" "referencia $command via directiva command"; done
absent "$body" "work-status" "no remite a work-status"
contains "$body" '{{mefisto:package-root}}/scripts/parallel-pipeline.sh' 'scheduler directo usa package-root'
contains "$body" '--max-parallel' 'documenta limite de concurrencia'
contains "$body" 'tipo:projection' 'conserva serializacion de projections'
contains "$body" 'No esperes a que termine' 'regla: no esperar'
contains "$body" 'No implementes nada tu mismo' 'regla: no implementar'
contains "$body" 'NO se mergean' 'regla: PRs sin merge automatico'
for forbidden in '.claude/' 'CLAUDE_' '.plugin-root' 'plugins/cache' 'model:' 'tools:' 'allowed-tools:' 'permission:'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" --parallel $ARGUMENTS' 'Claude invoca launch-pipeline.sh --parallel y fija su runtime'
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
for command in merge batch-stop; do
    contains "$claude_body" "/mefisto:$command" "Claude resuelve $command"
done
claude_invocation="$(printf '%s\n' "$claude_body" | grep -F 'scripts/launch-pipeline.sh" --parallel')"
for forbidden_path in '.claude/pipeline/.plugin-root' 'plugins/cache'; do
    absent "$claude_invocation" "$forbidden_path" "invocacion Claude no reimplementa lookup legacy ($forbidden_path)"
done
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/parallel.md. No editar a mano. -->' 'mirror conserva marcador generado'
asset="$REPO_ROOT/dist/claude/scripts/parallel-pipeline.sh"
[ -x "$asset" ] && pass "parallel-pipeline.sh empaquetado en dist/claude/scripts" || fail "falta dist/claude/scripts/parallel-pipeline.sh"
if cmp -s "$REPO_ROOT/scripts/parallel-pipeline.sh" "$asset"; then pass "parallel-pipeline.sh identico en dist/claude/scripts"; else fail "dist/claude/scripts/parallel-pipeline.sh diverge de la fuente"; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
