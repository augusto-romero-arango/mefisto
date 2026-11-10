#!/usr/bin/env bash
# test-claude-activation.sh -- Activacion de Mefisto por repositorio en Claude Code
# (MEF-ADR-0053 decision 2, issue #2261).
#
#   A-1: _activacion_commiteada lee el .claude/settings.json de HEAD, no el disco.
#   A-2: _habilitado_en_usuario: solo un false explicito lo deshabilita.
#   A-3: update-plugin.sh --disable-user se niega sin activacion commiteada, deshabilita
#        con ella (via 'claude plugin disable --scope user') y es idempotente.
#   A-4: el modo actualizar reporta MIGRACION PENDIENTE / AVISO segun el estado.
#   A-5: onboard-activate-repo.sh fusiona sin pisar otras claves; --preview no escribe.
#   A-6: _check_repo_activation de onboard-diagnose.sh: OK / FALTA / INFO.
#   A-7: _mefisto_marketplace deriva el nombre de la raiz del cache o de known_marketplaces.json
#        con el slug actual o el previo al rename; _fuente_marketplace cae al slug actual.
#
# Nunca toca la configuracion real: CLAUDE_CONFIG_DIR y MEFISTO_CACHE_ROOT apuntan a
# temporales y 'claude' es un stub antepuesto al PATH.
#
# Uso: scripts/tests/test-claude-activation.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
assert_igual() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (esperado: '$1' / obtenido: '$2')"; fi; }
assert_contiene() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3 (no contiene '$2')" ;; esac; }
assert_no_contiene() { case "$1" in *"$2"*) fail "$3 (contiene '$2')" ;; *) pass "$3" ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MKT="mkt-act"
export CLAUDE_CONFIG_DIR="$TMP/config"
mkdir -p "$CLAUDE_CONFIG_DIR"
CACHE="$TMP/cache"
mkdir -p "$CACHE/$MKT/mefisto/0.50.0"
STUB="$TMP/stub"
mkdir -p "$STUB"
LOG="$TMP/claude.log"
cat > "$STUB/claude" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$ACT_LOG"
if [ "$1 $2" = "plugin disable" ]; then
    f="$CLAUDE_CONFIG_DIR/settings.json"
    [ -f "$f" ] || echo '{}' > "$f"
    jq --arg id "$3" '.enabledPlugins[$id] = false' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
fi
exit 0
EOF
chmod +x "$STUB/claude"
export ACT_LOG="$LOG"

nuevo_consumidor() {
    local dir="$TMP/consumer-$1"
    rm -rf "$dir"; mkdir -p "$dir/.claude/pipeline"
    git -C "$dir" init -q .
    git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
    printf '%s' "$CACHE/$MKT/mefisto/0.50.0" > "$dir/.claude/pipeline/.plugin-root"
    printf '%s\n' "$dir"
}
commitear_settings() {
    printf '%s\n' "$2" > "$1/.claude/settings.json"
    git -C "$1" add .claude/settings.json
    git -C "$1" -c user.email=t@t -c user.name=t commit -q -m settings
}
usuario() { printf '%s\n' "$1" > "$CLAUDE_CONFIG_DIR/settings.json"; }

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/_plugin-scopes.sh"

echo "[A-1] _activacion_commiteada lee HEAD"
C1=$(nuevo_consumidor a1)
printf '{"enabledPlugins":{"mefisto@%s":true}}\n' "$MKT" > "$C1/.claude/settings.json"
_activacion_commiteada "$MKT" "$C1" && fail "A-1: sin commitear no cuenta" || pass "A-1: sin commitear no cuenta"
commitear_settings "$C1" "{\"enabledPlugins\":{\"mefisto@$MKT\":true}}"
_activacion_commiteada "$MKT" "$C1" && pass "A-1: commiteado en true cuenta" || fail "A-1: commiteado en true cuenta"
commitear_settings "$C1" "{\"enabledPlugins\":{\"mefisto@otro\":true}}"
_activacion_commiteada "$MKT" "$C1" && fail "A-1: otro marketplace no cuenta" || pass "A-1: otro marketplace no cuenta"

echo "[A-2] _habilitado_en_usuario"
rm -f "$CLAUDE_CONFIG_DIR/settings.json"
_habilitado_en_usuario "$MKT" && pass "A-2: sin settings de usuario -> habilitado" || fail "A-2: sin settings -> habilitado"
usuario '{"enabledPlugins":{}}'
_habilitado_en_usuario "$MKT" && pass "A-2: sin la clave -> habilitado" || fail "A-2: sin la clave -> habilitado"
usuario "{\"enabledPlugins\":{\"mefisto@$MKT\":false}}"
_habilitado_en_usuario "$MKT" && fail "A-2: false explicito -> deshabilitado" || pass "A-2: false explicito -> deshabilitado"

echo "[A-3] update-plugin.sh --disable-user"
run_update() {
    ( cd "$1" && shift && PATH="$STUB:$PATH" MEFISTO_CACHE_ROOT="$CACHE" bash "$REPO_ROOT/scripts/update-plugin.sh" "$@" ) 2>&1
}
C3=$(nuevo_consumidor a3)
usuario "{\"enabledPlugins\":{\"mefisto@$MKT\":true}}"
: > "$LOG"
OUT=$(run_update "$C3" --disable-user); RC=$?
assert_igual "1" "$RC" "A-3: sin activacion commiteada -> exit 1"
assert_contiene "$OUT" "no se deshabilito nada" "A-3: explica que no toco nada"
assert_no_contiene "$(cat "$LOG")" "plugin disable" "A-3: no llama a claude plugin disable"

commitear_settings "$C3" "{\"enabledPlugins\":{\"mefisto@$MKT\":true}}"
: > "$LOG"
OUT=$(run_update "$C3" --disable-user); RC=$?
assert_igual "0" "$RC" "A-3: con activacion commiteada -> exit 0"
assert_contiene "$(cat "$LOG")" "plugin disable mefisto@$MKT --scope user" "A-3: deshabilita a scope user"
assert_igual "false" "$(jq -r --arg id "mefisto@$MKT" '.enabledPlugins[$id]' "$CLAUDE_CONFIG_DIR/settings.json")" "A-3: el nivel usuario queda en false"

: > "$LOG"
OUT=$(run_update "$C3" --disable-user); RC=$?
assert_igual "0" "$RC" "A-3: idempotente -> exit 0"
assert_contiene "$OUT" "ya esta deshabilitado" "A-3: idempotente informa"
assert_no_contiene "$(cat "$LOG")" "plugin disable" "A-3: idempotente no vuelve a llamar al CLI"

OUT=$(run_update "$C3" --disable-user --prune); RC=$?
assert_igual "1" "$RC" "A-3: --disable-user no se combina con otros argumentos"

echo "[A-4] modo actualizar: reporte de activacion"
C4=$(nuevo_consumidor a4)
commitear_settings "$C4" "{\"enabledPlugins\":{\"mefisto@$MKT\":true}}"
usuario "{\"enabledPlugins\":{\"mefisto@$MKT\":true}}"
OUT=$(run_update "$C4")
assert_contiene "$OUT" "MIGRACION PENDIENTE" "A-4: repo activo + usuario habilitado -> migracion pendiente"
usuario "{\"enabledPlugins\":{\"mefisto@$MKT\":false}}"
OUT=$(run_update "$C4")
assert_no_contiene "$OUT" "MIGRACION PENDIENTE" "A-4: ya migrado -> sin migracion pendiente"
assert_contiene "$OUT" "Nivel usuario ($CLAUDE_CONFIG_DIR/settings.json): deshabilitado" "A-4: reporta nivel usuario deshabilitado"
C4B=$(nuevo_consumidor a4b)
OUT=$(run_update "$C4B")
assert_contiene "$OUT" "AVISO: este repo no habilita Mefisto" "A-4: repo sin activacion -> aviso"

echo "[A-5] onboard-activate-repo.sh"
C5=$(nuevo_consumidor a5)
printf '{"permissions":{"allow":["Bash(git:*)"]},"enabledPlugins":{"otro@x":true}}\n' > "$C5/.claude/settings.json"
ANTES=$(cat "$C5/.claude/settings.json")
OUT=$( cd "$C5" && bash "$REPO_ROOT/scripts/onboard-activate-repo.sh" --preview 2>&1 )
assert_contiene "$OUT" "Plan:" "A-5: --preview muestra el plan"
assert_igual "$ANTES" "$(cat "$C5/.claude/settings.json")" "A-5: --preview no escribe"
OUT=$( cd "$C5" && bash "$REPO_ROOT/scripts/onboard-activate-repo.sh" --apply 2>&1 ); RC=$?
assert_igual "0" "$RC" "A-5: --apply exit 0"
MK5=$(_mefisto_marketplace "$REPO_ROOT")
assert_igual "true" "$(jq -r --arg id "mefisto@$MK5" '.enabledPlugins[$id]' "$C5/.claude/settings.json")" "A-5: habilita mefisto"
assert_igual "true" "$(jq -r '.enabledPlugins["otro@x"]' "$C5/.claude/settings.json")" "A-5: conserva otros plugins"
assert_igual "Bash(git:*)" "$(jq -r '.permissions.allow[0]' "$C5/.claude/settings.json")" "A-5: conserva permissions"
assert_igual "github" "$(jq -r --arg m "$MK5" '.extraKnownMarketplaces[$m].source.source' "$C5/.claude/settings.json")" "A-5: declara el marketplace"
OUT=$( cd "$C5" && bash "$REPO_ROOT/scripts/onboard-activate-repo.sh" --apply 2>&1 )
assert_contiene "$OUT" "no hay nada que escribir" "A-5: idempotente"

echo "[A-6] _check_repo_activation (onboard-diagnose.sh)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/onboard-diagnose.sh"
PLUGIN_ROOT="$CACHE/$MKT/mefisto/0.50.0"
C6=$(nuevo_consumidor a6)
usuario "{\"enabledPlugins\":{\"mefisto@$MKT\":false}}"
_check_repo_activation claude "$C6"
assert_igual "FALTA" "$REPO_ACTIVATION_STATE" "A-6: sin activacion commiteada -> FALTA"
commitear_settings "$C6" "{\"enabledPlugins\":{\"mefisto@$MKT\":true}}"
_check_repo_activation claude "$C6"
assert_igual "OK" "$REPO_ACTIVATION_STATE" "A-6: con activacion commiteada -> OK"
assert_igual "" "$USER_LEVEL_DETAIL" "A-6: usuario deshabilitado -> sin fila de usuario"
usuario "{\"enabledPlugins\":{\"mefisto@$MKT\":true}}"
_check_repo_activation claude "$C6"
assert_contiene "$USER_LEVEL_DETAIL" "habilitado a nivel usuario" "A-6: usuario habilitado -> fila INFO"

echo "[A-7] _mefisto_marketplace"
assert_igual "$MKT" "$(_mefisto_marketplace "$CACHE/$MKT/mefisto/0.50.0")" "A-7: deriva el nombre de la raiz del cache"
KNOWN="$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json"
mkdir -p "$(dirname "$KNOWN")"
printf '{"mkt-previo":{"source":{"source":"github","repo":"augusto-romero-arango/eda-evsourcing-azure-harness"}}}\n' > "$KNOWN"
assert_igual "mkt-previo" "$(_mefisto_marketplace "$TMP/checkout")" "A-7: reconoce el marketplace registrado con el slug previo al rename (#2349)"
printf '{"otro":{"source":{"source":"github","repo":"augusto-romero-arango/mefisto-site"}},"mkt-nuevo":{"source":{"source":"github","repo":"augusto-romero-arango/mefisto"}}}\n' > "$KNOWN"
assert_igual "mkt-nuevo" "$(_mefisto_marketplace "$TMP/checkout")" "A-7: reconoce el marketplace registrado con el slug actual"
rm -f "$KNOWN"
assert_igual "augusto-romero-arango-harness" "$(_mefisto_marketplace "$TMP/checkout")" "A-7: sin registro cae al nombre publicado"
assert_igual '{"source":"github","repo":"augusto-romero-arango/mefisto"}' "$(_fuente_marketplace augusto-romero-arango-harness)" "A-7: fuente por defecto con el slug actual"

echo ""
echo "===================================================================="
echo "  test-claude-activation.sh: $PASS pasaron, $FAIL fallaron"
echo "===================================================================="
[ "$FAIL" -eq 0 ]
