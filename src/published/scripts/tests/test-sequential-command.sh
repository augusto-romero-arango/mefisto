#!/usr/bin/env bash
# Contrato del comando sequential neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/sequential.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/sequential.md"
MIRROR="$REPO_ROOT/commands/sequential.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "sequential" and .profile == "fast" and .arguments == "<issue1> <issue2> ... [--pipeline tdd|tooling]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
operation_line="$(awk '/gh issue view/ { print NR; exit }' "$SOURCE")"
[ -n "$guard_line" ] && [ -n "$operation_line" ] && [ "$guard_line" -lt "$operation_line" ] && pass 'guard precede cualquier operacion' || fail 'guard no precede las operaciones'
contains "$body" '{{mefisto:run launch-pipeline.sh --batch $ARGUMENTS}}' 'despacho neutral exacto'
[ "$(grep -cF '{{mefisto:run launch-pipeline.sh --batch $ARGUMENTS}}' "$SOURCE")" -eq 1 ] && pass 'existe un unico despacho' || fail 'el despacho no es unico'
contains "$body" 'gh issue view' 'valida issues antes de lanzar'
contains "$body" 'esta cerrado, informalo y excluyelo' 'excluye issues inexistentes o cerrados'
contains "$body" 'Si no queda ningun issue valido, detente' 'se detiene sin issues validos'
contains "$body" 'pipeline resuelto' 'resumen numerado con el pipeline resuelto'
contains "$body" 'pasando `--pipeline` si el usuario lo proporciono' 'pasa --pipeline al wrapper'
contains "$body" 'Herdr' 'documenta despacho Herdr'
contains "$body" 'Secuencial corriendo sin pane.' 'documenta el seguimiento desacoplado fuera de Herdr'
contains "$body" 'stream-watch.sh' 'remite al visor en otra terminal'
absent "$body" "work-status" "no remite a work-status"
contains "$body" '{{mefisto:command batch-stop}}' 'referencia batch-stop via directiva command'
contains "$body" 'No esperes a que termine' 'regla: no esperar'
contains "$body" 'No implementes nada tu mismo' 'regla: no implementar'
contains "$body" '{{mefisto:package-root}}/scripts/batch-pipeline.sh' 'regla --stop-on-error apunta a batch-pipeline.sh via package-root'
contains "$body" 'launch-pipeline.sh` no lo soporta' 'regla --stop-on-error explica la limitacion de launch-pipeline.sh'
for forbidden in 'Claude' '.claude/' 'cache' 'model:' 'tools:' 'allowed-tools:' 'permission:' '.plugin-root' 'CLAUDE_' 'plugins/cache'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" --batch $ARGUMENTS' 'Claude invoca launch-pipeline.sh --batch y fija su runtime'
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
absent "$claude_body" "work-status" "no remite a work-status"
contains "$claude_body" '/mefisto:batch-stop' 'Claude resuelve la directiva command a /mefisto:batch-stop'
# La invocacion propia del comando (la linea que lanza launch-pipeline.sh) no
# debe reimplementar el lookup manual legacy que traia el comando Claude-only:
# eso es lo que la directiva {{mefisto:run}} sustituye. El preambulo
# compartido de resolucion de MEFISTO_PACKAGE_ROOT (identico en todo comando
# ya migrado, p.ej. tooling.md) sigue citando el marcador canonico Claude como
# fallback de lectura y queda fuera de este chequeo.
claude_invocation="$(printf '%s\n' "$claude_body" | grep -F 'scripts/launch-pipeline.sh" --batch')"
for forbidden_path in '.claude/pipeline/.plugin-root' 'plugins/cache'; do
    absent "$claude_invocation" "$forbidden_path" "invocacion Claude no reimplementa el lookup legacy ($forbidden_path)"
done
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/sequential.md. No editar a mano. -->' 'mirror conserva marcador generado'
if [ -x "$REPO_ROOT/dist/claude/scripts/batch-pipeline.sh" ]; then pass 'batch-pipeline.sh empaquetado en dist/claude/scripts'; else fail 'falta dist/claude/scripts/batch-pipeline.sh'; fi
if cmp -s "$REPO_ROOT/scripts/batch-pipeline.sh" "$REPO_ROOT/dist/claude/scripts/batch-pipeline.sh"; then pass 'batch-pipeline.sh identico en dist/claude/scripts'; else fail 'dist/claude/scripts/batch-pipeline.sh diverge de la fuente'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
