#!/usr/bin/env bash
# Contrato del comando bug neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/bug.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/bug.md"
MIRROR="$REPO_ROOT/commands/bug.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "bug" and .profile == "fast" and .arguments == "[--tooling|--deployed] <descripcion del sintoma>" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:launch-agent tooling-investigator ' 'delegacion puntual a tooling-investigator'
contains "$body" '{{mefisto:launch-agent bug-investigator ' 'delegacion puntual a bug-investigator'
contains "$body" '{{mefisto:run azure-account-info.sh 2>&1}}' 'valida sesion con azure-account-info.sh'
contains "$body" '.mefisto/appinsights.env' 'valida appinsights.env'
contains "$body" 'Uso: {{mefisto:command bug}}' 'uso vacio con command bug'
contains "$body" '`.claude/`, `.mefisto/`' 'indicadores de tooling conservan .claude/ y suman .mefisto/'
contains "$body" '--tooling' 'flag --tooling'
contains "$body" '--deployed' 'flag --deployed'
contains "$body" 'No investigues nada tu mismo' 'regla no investigar'
contains "$body" 'No modifiques codigo' 'regla no modificar codigo'
absent "$body" 'claude --agent' 'fuente sin claude --agent'
absent "$body" 'az ' 'fuente sin az directo'
for forbidden in '.plugin-root' 'plugins/cache' 'PLUGIN_SCRIPTS' 'CLAUDE_'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" "MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.sh\" 2>&1" "claude invoca azure-account-info.sh"
absent "$claude_body" '{{mefisto:' "claude sin directivas sin resolver"
absent "$claude_body" 'claude --agent' "claude sin claude --agent"
absent "$claude_body" 'az ' "claude sin az directo"
absent "$claude_body" 'PLUGIN_SCRIPTS' "claude sin PLUGIN_SCRIPTS"
absent "$claude_body" 'plugins/cache' "claude sin plugins/cache"
contains "$claude_body" 'tooling-investigator' "claude delega en tooling-investigator"
contains "$claude_body" 'bug-investigator' "claude delega en bug-investigator"
# (d) la validacion Azure precede a la delegacion en bug-investigator.
after_header="${claude_body#*Si entorno desplegado}"
before_deleg="${after_header%%Si ambas validaciones pasan*}"
contains "$before_deleg" 'azure-account-info.sh' "claude valida Azure antes de delegar a bug-investigator"
tooling_section="${claude_body#*Si tooling}"
tooling_section="${tooling_section%%Si entorno desplegado*}"
absent "$tooling_section" 'azure-account-info.sh' "claude: la ruta tooling no exige Azure"
contains "$claude_body" 'model: "haiku"' 'Claude materializa el perfil fast'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" 'GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/bug.md' 'mirror conserva marcador generado'
if jq -e '.. | strings | select(. == "commands/bug.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then pass 'inventario de dist/claude lo incluye'; else fail 'inventario de dist/claude no lo incluye'; fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
