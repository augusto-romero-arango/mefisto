#!/usr/bin/env bash
# Contrato del comando tooling neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/tooling.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/tooling.md"
MIRROR="$REPO_ROOT/commands/tooling.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "tooling" and .profile == "fast" and .arguments == "<issue> [--models '\''agente=modelo[,agente=modelo...]'\''] [--variant <label>]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin capacidades ni runtime'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor antes del proceso'
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
operation_line="$(awk '/gh issue view/ { print NR; exit }' "$SOURCE")"
[ -n "$guard_line" ] && [ -n "$operation_line" ] && [ "$guard_line" -lt "$operation_line" ] && pass 'guard precede cualquier operacion' || fail 'guard no precede las operaciones'
contains "$body" 'primer token numerico' 'extrae el issue del primer token numerico'
contains "$body" 'no contiene un token compuesto solo por digitos' 'sin issue numerico muestra uso'
contains "$body" 'argumentos mal formados' 'flags mal formados muestran uso'
contains "$body" 'Si no es consultable' 'issue no consultable bloquea'
contains "$body" 'cerrado (`CLOSED`)' 'issue cerrado bloquea'
contains "$body" 'confirmacion explicita' 'falta tipo tooling requiere confirmacion'
contains "$body" 'Depende de #N' 'dependencias declaradas se filtran'
contains "$body" 'Bloqueado por #N' 'dependencias bloqueadas se filtran'
contains "$body" 'Ignora cualquier otro `#N`' 'ignora referencias ajenas a dependencias'
contains "$body" 'Si no hay una dependencia canonica consultable' 'label bloqueado sin dependencias no se retira'
contains "$body" 'dependencia `OPEN` o no consultable es un bloqueo visible' 'dependencia abierta o no consultable bloquea'
contains "$body" 'retira el label `bloqueado`' 'dependencias cerradas desbloquean'
contains "$body" 'Con `--variant`, nunca mutas labels' 'variante no muta labels'
contains "$body" 'claves de stage `writer` y `reviewer`' 'models conserva stages'
contains "$body" 'no hace push, no abre PR ni muta el issue' 'variante conserva aislamiento sin efectos remotos'
contains "$body" 'reenvia ambos flags intactos' 'forwarding de flags intacto'
contains "$body" '{{mefisto:run launch-pipeline.sh --tooling $ARGUMENTS}}' 'despacho neutral exacto'
[ "$(grep -cF '{{mefisto:run launch-pipeline.sh --tooling $ARGUMENTS}}' "$SOURCE")" -eq 1 ] && pass 'existe un unico despacho' || fail 'el despacho no es unico'
contains "$body" 'Herdr' 'documenta despacho Herdr'
contains "$body" 'la salida del wrapper dice `sin pane` sin nombrar la consola' 'documenta el seguimiento desacoplado fuera de Herdr'
contains "$body" 'stream-watch.sh' 'remite al visor en otra terminal'
contains "$body" '/mefisto:tooling' 'documenta el nombre canonico'
for forbidden in 'Claude' '.claude/' 'cache' 'model:' 'tools:' 'allowed-tools:' 'permission:' '/work-status'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
contains "$(< "$CLAUDE")" 'model: "haiku"' 'Claude materializa el perfil fast'
contains "$(< "$CLAUDE")" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" --tooling $ARGUMENTS' 'Claude cita package root con espacios y fija su runtime'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/tooling.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
