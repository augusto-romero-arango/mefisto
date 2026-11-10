#!/usr/bin/env bash
# Contrato del comando upgrade neutral y su adaptacion publicada (#1680).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/upgrade.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/upgrade.md"
MIRROR="$REPO_ROOT/commands/upgrade.md"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
# Cuerpo propio del comando: excluye el preambulo que inyecta el adaptador.
own_body() { awk '/^Actualiza Mefisto instalado/ { p=1 } p { print }' "$1"; }

echo '[fuente] metadata'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "upgrade" and .profile == "fast" and (has("arguments") | not) and (has("agent") | not) and (has("capabilities") | not)' >/dev/null; then pass 'metadata: command/upgrade/fast sin arguments, agent ni capabilities'; else fail 'metadata invalida'; fi

echo '[salida] existencia y perfil'
name="${CLAUDE#"$REPO_ROOT/"}"
[ -f "$CLAUDE" ] && pass "existe $name" || fail "falta $name"
head -6 "$CLAUDE" | grep -q '^model: "haiku"' && pass 'perfil fast -> haiku en Claude' || fail 'perfil fast en Claude'
rendered="$(< "$CLAUDE")"; body="$(own_body "$CLAUDE")"

echo '[invocaciones]'
for arg in --status --disable-user '--prune --only <versiones-confirmadas>'; do
    contains "$rendered" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.sh\" $arg" "$name invoca upgrade.sh $arg con su runtime"
done
contains "$rendered" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.sh\" 2>&1" "$name invoca la actualizacion simple"
contains "$rendered" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/herdr-pipeline.sh\" --refresh-agents" "$name refresca agentes herdr"
contains "$body" 'HERDR_ENV=1' "$name limita el refresco a herdr"

echo '[actualizacion y consentimiento]'
contains "$body" '**no informa si existe una version mas nueva publicada**' "$name: --status es una consulta local"
contains "$body" 'nunca autoriza concluir que Mefisto esta al dia' "$name: --status no autoriza concluir que esta al dia"
contains "$body" '**exactamente una vez**' "$name actualiza una sola vez por invocacion"
contains "$body" 'Nunca respondas "ya esta al dia"' "$name no concluye al dia sin la salida del script"
contains "$body" 'exactamente `si`' "$name exige confirmacion exacta"
contains "$body" 'El update no borra nada' "$name conserva que el update no borra"
migration_line="$(printf '%s\n' "$body" | grep -n 'MIGRACION PENDIENTE' | head -1 | cut -d: -f1)"
disable_line="$(printf '%s\n' "$body" | grep -n 'upgrade.sh" --disable-user' | head -1 | cut -d: -f1)"
if [ -n "$migration_line" ] && [ -n "$disable_line" ] && [ "$migration_line" -lt "$disable_line" ]; then pass "$name precede --disable-user con su confirmacion"; else fail "$name no precede --disable-user con su confirmacion"; fi
contains "$body" 'nunca ofrezcas retirar el nivel global en ese caso' "$name no retira el nivel global si el repo no lo activa"

echo '[cierre y neutralidad]'
contains "$body" 'Recarga o reinicia la sesion de tu runtime para activar la version `<version-destino>`' "$name cierra con reload neutral"
contains "$body" 'omitido:working' "$name conserva aviso de panes"
absent "$body" '/reload-plugins' "$name sin /reload-plugins"
absent "$body" '.plugin-root' "$name sin .plugin-root"
absent "$body" 'plugins/cache' "$name sin plugins/cache"
absent "$body" 'update-plugin.sh' "$name no invoca update-plugin.sh directo"
stripped="$(printf '%s\n' "$body" | grep -v '^MEFISTO_LOADED_ROOT=')"
absent "$stripped" 'CLAUDE_' "$name sin variables CLAUDE_ salvo la raiz viva"
contains "$body" "MEFISTO_LOADED_ROOT='\${CLAUDE_PLUGIN_ROOT}'" "$name pasa la raiz viva"
absent "$body" 'solo desde Claude Code' "$name sin regla transitoria"

echo '[poda]'
prune_line="$(printf '%s\n' "$body" | grep -n 'upgrade.sh" --prune' | head -1 | cut -d: -f1)"
confirm_line="$(printf '%s\n' "$body" | grep -n 'pide confirmacion explicita' | head -1 | cut -d: -f1)"
if [ -n "$prune_line" ] && [ -n "$confirm_line" ] && [ "$confirm_line" -lt "$prune_line" ]; then pass "$name precede la poda con su confirmacion"; else fail "$name no precede la poda con su confirmacion"; fi
contains "$body" 'Nunca podes la version cargada' "$name nunca poda la version cargada"

echo '[mirror] commands/upgrade.md'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'el mirror es identico a la salida Claude'; else fail 'el mirror diverge'; fi
if "$REPO_ROOT/src/published/scripts/generate-published-adapters.sh" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi
printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
