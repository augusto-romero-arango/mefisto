#!/usr/bin/env bash
# Contrato del comando fix-review neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/fix-review.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/fix-review.md"
MIRROR="$REPO_ROOT/commands/fix-review.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
# Posicion de la primera aparicion de un literal; vacio si no esta.
pos() { local pre="${1%%"$2"*}"; [ "$pre" = "$1" ] && echo -1 || echo "${#pre}"; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "fix-review" and .profile == "deep" and .arguments == "<numero-de-PR>" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
for forbidden in 'EnterPlanMode' 'ExitPlanMode' 'Co-Authored-By' 'Claude Opus' 'Claude' '.claude/' 'CLAUDE_' '.plugin-root' 'plugins/cache' 'model:' 'tools:' 'allowed-tools:' 'permission:' '`Read`' '`Edit`' '`Write`'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done
contains "$body" 'Uso: {{mefisto:command fix-review}} <numero-de-PR>' 'uso vacio via directiva command'
contains "$body" '{{mefisto:package-root}}/agents/<id>.md' 'agentes del harness desde package-root'
contains "$body" '{{mefisto:package-root}}/docs/adr/mef-adr-0019-*.md' 'ADR-0019 desde package-root'
contains "$body" '{{mefisto:config-path}}' 'repoSlug desde config-path'
contains "$body" 'augusto-romero-arango/mefisto' 'default de repoSlug como el planner'
contains "$body" '**No avances a la Fase 3 sin aprobacion del plan.**' 'regla de gate del plan literal'
contains "$body" 'aprobacion explicita' 'aprobacion explicita exigida'
contains "$body" 'in_reply_to' 'respuestas via in_reply_to'
contains "$body" 'NO uses el sub-endpoint `/replies`' 'nunca /replies'
contains "$body" 'Nunca auto-resuelvas comentarios' 'regla: nunca auto-resolver'
contains "$body" 'aborta la Fase 5.4' 'guard de no main en 5.4'
contains "$body" 'docs/convenciones-pr-<numero-de-PR>' 'guard cambia de main a rama docs'
contains "$body" 'La field note siempre se genera' 'regla: field note siempre'
contains "$body" 'mismo idioma del comentario original' 'regla: idioma del comentario'
absent "$body" 'Modelo local' 'sin rama modelo local'
for section in 'Comentarios a corregir' 'Comentarios a explicar' 'Comentarios ya resueltos' 'Comentarios a investigar' 'Orden de ejecucion' '## Verificacion' '## Contexto'; do contains "$body" "$section" "plan conserva seccion: $section"; done

echo '[orden]'
prev=-1; ok=1
for marker in '{{mefisto:assert-consumer-repo}}' '## Fase 1: Triaje' '## Fase 2: Plan' 'No avances a la Fase 3 sin aprobacion del plan' 'dotnet build' 'Haz push a la rama del PR' 'Espera aprobacion del usuario antes de publicar' '## Fase 5: Mejora continua' '### 5.5 Field note'; do
    p="$(pos "$body" "$marker")"
    if [ "$p" -le "$prev" ]; then ok=0; fail "orden roto en: $marker"; fi
    prev="$p"
done
[ "$ok" = 1 ] && pass 'guard -> triaje -> plan -> build/test -> push -> respuestas -> mejora -> field note'

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "opus"' 'Claude materializa el perfil deep'
contains "$claude_body" '${MEFISTO_PACKAGE_ROOT}/agents/' 'Claude lee agentes desde MEFISTO_PACKAGE_ROOT'
contains "$claude_body" 'repoSlug' 'Claude lee repoSlug'
absent "$claude_body" 'plugins/cache' 'salida Claude sin cache de plugins'
contains "$claude_body" 'Nunca auto-resuelvas comentarios' 'Claude conserva las reglas'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/fix-review.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
