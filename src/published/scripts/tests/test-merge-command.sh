#!/usr/bin/env bash
# Contrato del comando merge neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/merge.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/merge.md"
MIRROR="$REPO_ROOT/commands/merge.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "merge" and .profile == "fast" and .arguments == "<numero-de-PR> [<numero-de-PR> ...] | --all" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:run pr-sync.sh <PRs> --merge}}' 'invoca pr-sync.sh con lista de PRs'
contains "$body" '{{mefisto:run pr-sync.sh --all --merge}}' 'invoca pr-sync.sh con --all'
contains "$body" '{{mefisto:run herdr-pipeline.sh --collapse-panes}}' 'colapsa paneles Herdr via directiva run'
contains "$body" 'HERDR_ENV=1' 'colapso de paneles condicionado a HERDR_ENV=1'
contains "$body" '{{mefisto:state-path logs}}' 'apunta al log via state-path'
contains "$body" 'pr-sync-<ts>.log' 'nombre de log con timestamp fuera de la directiva'
contains "$body" '{{mefisto:command merge}}' 'mensaje de reintento via directiva command'
contains "$body" 'CLOSED' 'descarta PRs CLOSED'
contains "$body" 'MERGED' 'descarta PRs MERGED'
contains "$body" 'No pidas confirmacion adicional' 'resumen sin pedir confirmacion extra'
contains "$body" 'Es best-effort' 'paso de Herdr es best-effort'
contains "$body" 'Nunca hagas merges manuales' 'regla: nunca merges manuales'
contains "$body" 'No diagnostiques errores del script' 'regla: no diagnosticar'
contains "$body" 'No reintentes automaticamente' 'regla: no reintentar'
contains "$body" 'No instales dependencias' 'regla: no instalar dependencias'
contains "$body" 'No toques PRs que no esten en la lista final' 'regla: no tocar PRs fuera de la lista'
for forbidden in 'Claude' '.claude/' 'cache' 'model:' 'tools:' 'allowed-tools:' 'permission:' '.plugin-root' 'CLAUDE_'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh" <PRs> --merge' 'Claude invoca pr-sync.sh con lista de PRs y fija su runtime'
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh" --all --merge' 'Claude invoca pr-sync.sh con --all y fija su runtime'
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
# La invocacion propia del comando (las lineas que llaman a pr-sync.sh /
# herdr-pipeline.sh) no debe reimplementar el lookup manual legacy que traia
# el comando Claude-only: eso es lo que la directiva {{mefisto:run}} sustituye.
# El preambulo compartido de resolucion de MEFISTO_PACKAGE_ROOT (identico en
# todo comando ya migrado, p.ej. tooling.md) sigue citando el marcador
# canonico Claude como fallback de lectura y queda fuera de este chequeo.
claude_invocations="$(printf '%s\n' "$claude_body" | grep -E 'scripts/(pr-sync|herdr-pipeline)\.sh"')"
for forbidden_path in '.claude/pipeline/.plugin-root' 'plugins/cache'; do
    absent "$claude_invocations" "$forbidden_path" "invocacion Claude no reimplementa el lookup legacy ($forbidden_path)"
done
absent "$claude_body" 'plugins/cache' 'salida Claude completa sin cache de plugins'
contains "$claude_body" 'paneles_herdr_cerrados=${CLOSED:-0}' 'Claude conserva el colapso Herdr best-effort'

contains "$claude_body" 'Nunca hagas merges manuales' 'Claude conserva las reglas'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/merge.md. No editar a mano. -->' 'mirror conserva marcador generado'
if [ -x "$REPO_ROOT/dist/claude/scripts/pr-sync.sh" ]; then pass 'pr-sync.sh empaquetado en dist/claude/scripts'; else fail 'falta dist/claude/scripts/pr-sync.sh'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
