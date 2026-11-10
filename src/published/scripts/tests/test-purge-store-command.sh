#!/usr/bin/env bash
# Contrato del comando purge-store neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/purge-store.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/purge-store.md"
MIRROR="$REPO_ROOT/commands/purge-store.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
# Posicion (offset) de la primera aparicion de un literal; vacio si no esta.
pos() { local pre="${1%%"$2"*}"; [ "$pre" = "$1" ] && echo -1 || echo "${#pre}"; }
ordered() {
    local text="$1" label="$2"; shift 2
    local prev=-1 cur ok=1
    for needle in "$@"; do
        cur="$(pos "$text" "$needle")"
        if [ "$cur" -le "$prev" ]; then ok=0; break; fi
        prev="$cur"
    done
    [ "$ok" -eq 1 ] && pass "$label" || fail "$label"
}

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "purge-store" and .profile == "balanced" and .arguments == "<dominio> [--env <env>]" and (has("agent") | not) and (has("capabilities") | not)' >/dev/null; then pass 'metadata neutral correcta'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:config-path}}' 'lee domainLabels desde config-path'
contains "$body" 'domainLabels' 'menciona domainLabels'
contains "$body" '{{mefisto:run appinsights-query.sh custom "' 'fuente usa appinsights-query.sh custom'
contains "$body" '{{mefisto:run purge-store.sh --domain "$DOMINIO_KEBAB" --env "$ENV" --dry-run}}' 'fuente usa purge-store.sh --dry-run'
contains "$body" '{{mefisto:run purge-store.sh --domain "$DOMINIO_KEBAB" --env "$ENV"}}' 'fuente usa purge-store.sh de purga'
contains "$body" '{{mefisto:run azure-account-info.sh' 'fuente valida sesion con azure-account-info.sh'
contains "$body" '.mefisto/appinsights.env' 'fuente cita .mefisto/appinsights.env'
contains "$body" 'gh run rerun "$RUN_ID" --failed' 'conserva rerun --failed'
contains "$body" 'ATTEMPT_PREVIO' 'espera el intento nuevo'
contains "$body" 'Veredicto' 'veredicto explicito'
contains "$body" 'sin purga' 'sin sintoma, sin purga'
absent "$body" 'az ' 'fuente sin az directo'
absent "$body" 'scripts/.env' 'fuente sin scripts/.env'
for forbidden in '.plugin-root' 'plugins/cache' 'PLUGIN_SCRIPTS' 'CLAUDE_'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done

echo '[salida] adaptador'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.sh\" --domain \"\$DOMINIO_KEBAB\" --env \"\$ENV\" --dry-run" 'claude invoca purge-store.sh --dry-run'
contains "$claude_body" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.sh\" --domain \"\$DOMINIO_KEBAB\" --env \"\$ENV\"" 'claude invoca purge-store.sh'
contains "$claude_body" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh\" custom" 'claude invoca appinsights-query.sh'
contains "$claude_body" "\"\${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.sh\"" 'claude invoca azure-account-info.sh'
absent "$claude_body" '{{mefisto:' 'claude sin directivas sin resolver'
absent "$claude_body" 'az ' 'claude sin az directo'
for forbidden in 'PLUGIN_SCRIPTS' 'plugins/cache' 'scripts/.env'; do absent "$claude_body" "$forbidden" "claude sin $forbidden"; done
# Orden: evidencia -> dry-run -> confirmacion -> purga -> rerun/veredicto.
ordered "$claude_body" 'claude respeta el orden evidencia -> dry-run -> confirmacion -> purga -> rerun' \
    'appinsights-query.sh' '--dry-run' 'Continuar con la purga' '--env "$ENV"
```' 'gh run rerun'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced'

echo '[assets] purge-store.sh distribuido'
SRC_SH="$REPO_ROOT/scripts/purge-store.sh"
dist_sh="$REPO_ROOT/dist/claude/scripts/purge-store.sh"
if [ -f "$dist_sh" ] && cmp -s "$SRC_SH" "$dist_sh"; then pass "dist/claude/scripts/purge-store.sh identico"; else fail "dist/claude/scripts/purge-store.sh ausente o distinto"; fi
[ -x "$dist_sh" ] && pass "dist/claude purge-store.sh ejecutable" || fail "dist/claude purge-store.sh no ejecutable"
[ -f "$REPO_ROOT/dist/claude/scripts/_pipeline-common.sh" ] && pass "dist/claude trae _pipeline-common.sh hermano" || fail "dist/claude sin _pipeline-common.sh"
if jq -e '.assets[] | select(.destination == "scripts/purge-store.sh")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then pass "inventario de dist/claude incluye purge-store.sh"; else fail "inventario de dist/claude sin purge-store.sh"; fi
if jq -e '.. | strings | select(. == "commands/purge-store.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then pass "inventario de dist/claude incluye el comando"; else fail "inventario de dist/claude sin el comando"; fi
# Resuelve _pipeline-common.sh desde dist/: el script sale por uso, no por fuente ausente.
out="$(bash "$REPO_ROOT/dist/claude/scripts/purge-store.sh" --help 2>&1 < /dev/null || true)"
case "$out" in *"_pipeline-common.sh: No such file"*) fail 'dist resuelve _pipeline-common.sh' ;; *) pass 'dist resuelve _pipeline-common.sh' ;; esac

echo '[mirror]'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" 'GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/purge-store.md' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
