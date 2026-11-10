#!/usr/bin/env bash
# Contrato del comando infra-base neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/infra-base.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/infra-base.md"
MIRROR="$REPO_ROOT/commands/infra-base.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "infra-base" and .profile == "fast" and .arguments == "[dev|staging|prod]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
launch_line="$(grep -nF '{{mefisto:launch-agent' "$SOURCE" | head -1 | cut -d: -f1)"
[ -n "$guard_line" ] && [ -n "$launch_line" ] && [ "$guard_line" -lt "$launch_line" ] && pass 'guard precede la delegacion' || fail 'guard no precede la delegacion'
contains "$body" '{{mefisto:launch-agent infra-base-scaffolder ' 'delegacion puntual a infra-base-scaffolder'
launch="$(grep -F '{{mefisto:launch-agent' "$SOURCE")"
contains "$launch" 'Ambiente: <env>' 'el mensaje lleva el ambiente resuelto'
absent "$launch" '$ARGUMENTS' 'el mensaje no usa $ARGUMENTS crudo'
contains "$body" 'dev`/`staging`/`prod' 'valida dev/staging/prod'
contains "$body" 'usa `dev`' 'ambiente por defecto dev'
contains "$body" 'ALERT_EMAIL' 'recordatorio ALERT_EMAIL'
contains "$body" 'TF_VAR_POSTGRESQL_ADMIN_PASSWORD' 'recordatorio password PostgreSQL'
contains "$body" 'postgresql_region_short' 'recordatorio defaults regionales'
contains "$body" '{{mefisto:package-root}}/scripts/bootstrap-backend.sh' 'cita bootstrap-backend.sh del paquete'
contains "$body" '{{mefisto:package-root}}/scripts/setup-github-ci.sh' 'cita setup-github-ci.sh del paquete'
contains "$body" '{{mefisto:command infra}}' 'referencia infra'
contains "$body" '{{mefisto:command scaffold}}' 'referencia scaffold'
contains "$body" 'No generes la infraestructura tu mismo' 'regla: no generar'
contains "$body" 'nunca corre `terraform plan`/`apply`' 'regla: nunca plan/apply'
contains "$body" 'idempotente' 'regla: idempotente'
for forbidden in 'claude --agent' 'Claude' '.claude/' '.plugin-root' 'CLAUDE_' 'plugins/cache' 'model:' 'allowed-tools:'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
contains "$claude_body" 'agente `mefisto:infra-base-scaffolder`' 'Claude delega con la tool Task'
contains "$claude_body" '/mefisto:infra' 'Claude resuelve command infra'
contains "$claude_body" '/mefisto:scaffold' 'Claude resuelve command scaffold'
absent "$claude_body" 'claude --agent' 'salida Claude sin claude --agent'
absent "$claude_body" 'plugins/cache' 'salida Claude sin cache de plugins'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/infra-base.md. No editar a mano. -->' 'mirror conserva marcador generado'
if jq -e '.assets[] | select(.destination == "commands/infra-base.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then pass 'inventariado en dist/claude'; else fail 'ausente del inventario de dist/claude'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
