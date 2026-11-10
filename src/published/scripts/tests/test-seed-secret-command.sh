#!/usr/bin/env bash
# Contrato del comando seed-secret neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/seed-secret.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/seed-secret.md"
MIRROR="$REPO_ROOT/commands/seed-secret.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "seed-secret" and .profile == "balanced" and .arguments == "<nombre> --domain <Dominio> (--from-output <output> | --from-github-secret <NOMBRE>) [--env <env>]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:run seed-secret.sh <nombre> --domain <Dominio> --env <env> <flag-de-fuente> <valor>}}' 'invocacion neutral del script'
contains "$body" 'Registro: <ruta>' 'extrae la linea Registro'
contains "$body" '{{mefisto:command scaffold}}' 'remite a scaffold via directiva command'
contains "$body" '{{mefisto:package-root}}/agents/domain-scaffolder.md' 'molde del HCL via package-root'
contains "$body" '¿Continuar? (s/n)' 'pide confirmacion explicita'
contains "$body" 'git switch -c seed-secret/' 'crea rama si se esta en main'
contains "$body" 'detente sin editar ningun otro archivo' 'se detiene si el script falla'
contains "$body" 'init -backend=false' 'solo init -backend=false'
contains "$body" 'Key Vault Secrets User' 'verifica Secrets User'
contains "$body" 'Nunca toques' 'regla: nunca Secrets Officer'
contains "$body" 'Nunca ejecutes' 'regla: nunca plan/apply'
contains "$body" 'azurerm_key_vault_secret' 'regla: nunca azurerm_key_vault_secret'
contains "$body" 'Nunca crees el dominio' 'regla: nunca crear dominio'
for forbidden in '.claude/' 'CLAUDE_' '.plugin-root' 'plugins/cache' 'PLUGIN_SCRIPTS' 'PLUGIN_ROOT'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
confirm_line="$(grep -nF '¿Continuar? (s/n)' "$SOURCE" | cut -d: -f1)"
run_line="$(grep -nF '{{mefisto:run seed-secret.sh' "$SOURCE" | cut -d: -f1)"
edit_line="$(grep -nF 'git add' "$SOURCE" | cut -d: -f1)"
[ -n "$guard_line" ] && [ -n "$confirm_line" ] && [ "$guard_line" -lt "$confirm_line" ] && pass 'guard precede la confirmacion' || fail 'guard no precede la confirmacion'
[ -n "$confirm_line" ] && [ -n "$run_line" ] && [ "$confirm_line" -lt "$run_line" ] && [ "$run_line" -lt "$edit_line" ] && pass 'confirmacion precede a cualquier escritura' || fail 'confirmacion no precede las escrituras'

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/seed-secret.sh"' 'Claude invoca seed-secret.sh con su runtime'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced'
absent "$claude_body" 'plugins/cache' 'Claude sin plugins/cache'
claude_invocation="$(printf '%s\n' "$claude_body" | grep -F 'scripts/seed-secret.sh"')"
absent "$claude_invocation" '.plugin-root' 'invocacion Claude sin lookup legacy .plugin-root'
absent "$claude_invocation" 'PLUGIN_SCRIPTS' 'invocacion Claude sin PLUGIN_SCRIPTS'
contains "$claude_body" '/mefisto:scaffold' 'Claude resuelve command scaffold'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/seed-secret.md. No editar a mano. -->' 'mirror conserva marcador generado'
guard_l="$(grep -nF 'aborta si existe `src/internal/scripts/generate-internal-adapters.sh`' "$CLAUDE" | head -1 | cut -d: -f1)"
run_l="$(grep -nF 'scripts/seed-secret.sh' "$CLAUDE" | head -1 | cut -d: -f1)"
conf_l="$(grep -nF '¿Continuar? (s/n)' "$CLAUDE" | head -1 | cut -d: -f1)"
[ -n "$guard_l" ] && [ -n "$conf_l" ] && [ "$guard_l" -lt "$conf_l" ] && pass "guard antes de la confirmacion en ${CLAUDE#"$REPO_ROOT/"}" || fail "guard no precede la confirmacion en ${CLAUDE#"$REPO_ROOT/"}"
[ -n "$conf_l" ] && [ -n "$run_l" ] && [ "$conf_l" -lt "$run_l" ] && pass "confirmacion antes del script en ${CLAUDE#"$REPO_ROOT/"}" || fail "confirmacion no precede al script en ${CLAUDE#"$REPO_ROOT/"}"

echo '[assets] seed-secret.sh empaquetado'
dist="$REPO_ROOT/dist/claude/scripts/seed-secret.sh"
if [ -x "$dist" ]; then pass "seed-secret.sh ejecutable en dist/claude"; else fail "falta seed-secret.sh ejecutable en dist/claude"; fi
if cmp -s "$REPO_ROOT/scripts/seed-secret.sh" "$dist"; then pass "dist/claude identico a la fuente"; else fail "dist/claude diverge de la fuente"; fi
if jq -e '.assets[] | select(.destination == "scripts/seed-secret.sh")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then pass "inventario de dist/claude lo incluye"; else fail "inventario de dist/claude no lo incluye"; fi
[ -f "$REPO_ROOT/dist/claude/scripts/_pipeline-common.sh" ] && pass '_pipeline-common.sh hermano presente' || fail '_pipeline-common.sh hermano ausente'
smoke_dir="$(mktemp -d)"; git -C "$smoke_dir" init -q
smoke="$(cd "$smoke_dir" && bash "$REPO_ROOT/dist/claude/scripts/seed-secret.sh" 2>&1)"; smoke_rc=$?
rm -rf "$smoke_dir"
case "$smoke" in
    *"No such file"*|*"command not found"*|*"unbound variable"*) fail 'seed-secret.sh distribuido no resuelve _pipeline-common.sh'; printf '%s\n' "$smoke" | head -3 ;;
    *"Uso: "*) [ "$smoke_rc" -eq 1 ] && pass 'seed-secret.sh distribuido resuelve _pipeline-common.sh y responde el uso fuera del checkout' || fail "seed-secret.sh distribuido: rc inesperado $smoke_rc" ;;
    *) fail 'seed-secret.sh distribuido no imprimio el uso esperado'; printf '%s\n' "$smoke" | head -3 ;;
esac
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
