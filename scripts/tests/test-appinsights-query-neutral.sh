#!/usr/bin/env bash
# test-appinsights-query-neutral.sh -- appinsights-query.sh neutral a runtime (issue #1666).
#
# Cubre: (a) sin .mefisto/appinsights.env sale != 0 listando las cinco claves;
# (b) exceptions usa APPINSIGHTS_APP/RG del consumidor; (c) custom audita en
# .mefisto/pipeline/kql-audit.log sin crear archivos junto al script;
# (d) plan-sites/plan-metrics solo invocan az de lectura y rechazan ids mal
# formados; (e) la copia en dist/claude/scripts/ funciona igual;
# (a2/b0) aviso de solo lectura ante un scripts/.env legacy del consumidor
# (issue #2386), con el script ejecutado desde fuera del repo como en una instalacion real.
#
# Uso: scripts/tests/test-appinsights-query-neutral.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
AZ_LOG="$TMP/az.log"
cat > "$STUB_BIN/az" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$AZ_LOG"
case "$1 $2" in
    "account show") echo '{}' ;;
    "monitor app-insights") echo '{"tables":[{"columns":[{"name":"c"}],"rows":[["v"]]}]}' ;;
    "appservice plan") echo 3 ;;
    "monitor metrics") echo '{"value":[]}' ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/az"
export AZ_LOG
unset MEFISTO_STATE_DIR MEFISTO_LEGACY_STATE_DIR

make_repo() {
    local dir="$1" src_dir="$2"
    mkdir -p "$dir/scripts"
    git -C "$dir" init -q
    cp "$src_dir/appinsights-query.sh" "$src_dir/_pipeline-common.sh" "$dir/scripts/"
    chmod +x "$dir/scripts/appinsights-query.sh"
}

run() { (cd "$1" && shift && PATH="$STUB_BIN:$PATH" bash scripts/appinsights-query.sh "$@" 2>&1); }
# El plugin instalado vive fuera del repo del consumidor: su scripts/ no es el del consumidor.
run_from() { local repo="$1" script="$2"; shift 2; (cd "$repo" && PATH="$STUB_BIN:$PATH" bash "$script" "$@" 2>&1); }

REPO="$TMP/consumer"
make_repo "$REPO" "$REPO_ROOT/scripts"

echo "[a] sin env"
out=$(run "$REPO" exceptions); rc=$?
[ "$rc" -ne 0 ] && pass "sale != 0" || fail "salio 0 sin env"
missing=0
for k in APPINSIGHTS_APP APPINSIGHTS_RG SERVICEBUS_NAMESPACE SERVICEBUS_RG FUNCTIONAPP_NAMES; do
    echo "$out" | grep -q "$k" || missing=1
done
[ "$missing" -eq 0 ] && pass "mensaje lista las cinco claves" || fail "faltan claves en el mensaje"
echo "$out" | grep -q ".mefisto/appinsights.env" && pass "cita la ruta exacta" || fail "no cita la ruta"
echo "$out" | grep -q "template" && fail "cita un template" || pass "sin citar templates"

check_legacy() {
    local repo="$1" src_dir="$2" label="$3" plugin before after
    echo "[a2] aviso legacy ($label)"
    plugin="$TMP/plugin-$label"
    mkdir -p "$plugin"
    cp "$src_dir/appinsights-query.sh" "$src_dir/_pipeline-common.sh" "$plugin/"
    echo "OTRA=1" > "$repo/scripts/.env"
    out=$(run_from "$repo" "$plugin/appinsights-query.sh" exceptions); rc=$?
    [ "$rc" -ne 0 ] && ! echo "$out" | grep -q "legacy" && pass "CA-3 .env ajeno sin aviso" || fail "CA-3 .env ajeno"
    echo "APPINSIGHTS_APP=app-legacy" > "$repo/scripts/.env"
    before=$(cd "$repo" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
    out=$(run_from "$repo" "$plugin/appinsights-query.sh" exceptions); rc=$?
    after=$(cd "$repo" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
    [ "$rc" -ne 0 ] && echo "$out" | grep -qF "$repo/scripts/.env" \
        && echo "$out" | grep -qF "mkdir -p .mefisto && mv scripts/.env .mefisto/appinsights.env" \
        && echo "$out" | grep -q "APPINSIGHTS_RG" \
        && pass "CA-1 avisa con la ruta del legacy y el comando" || fail "CA-1 sin aviso legacy"
    [ "$before" = "$after" ] && pass "CA-2 arbol intacto" || fail "CA-2 el arbol cambio"
    rm -f "$repo/scripts/.env"
    out=$(run_from "$repo" "$plugin/appinsights-query.sh" exceptions)
    echo "$out" | grep -q "legacy" && fail "CA-3 aviso sin scripts/.env" || pass "CA-3 sin scripts/.env sin aviso"
}
check_legacy "$REPO" "$REPO_ROOT/scripts" "fuente"
if [ -f "$REPO_ROOT/dist/claude/scripts/appinsights-query.sh" ]; then
    check_legacy "$REPO" "$REPO_ROOT/dist/claude/scripts" "dist-claude"
fi

mkdir -p "$REPO/.mefisto"
cat > "$REPO/.mefisto/appinsights.env" <<'EOF'
APPINSIGHTS_APP=app-consumidor
APPINSIGHTS_RG=rg-consumidor
SERVICEBUS_NAMESPACE=sb
SERVICEBUS_RG=rg-sb
FUNCTIONAPP_NAMES=fa1
EOF
BEFORE=$(ls -A "$REPO/scripts" | sort | tr '\n' ' ')

echo "[b0] CA-4 con env presente no hay aviso aunque exista scripts/.env"
echo "APPINSIGHTS_APP=app-legacy" > "$REPO/scripts/.env"
out=$(run "$REPO" exceptions); rc=$?
[ "$rc" -eq 0 ] && ! echo "$out" | grep -q "legacy" && pass "CA-4 sin aviso" || fail "CA-4 cambio el comportamiento"
rm -f "$REPO/scripts/.env"

echo "[b] exceptions"
: > "$AZ_LOG"
run "$REPO" exceptions >/dev/null; rc=$?
[ "$rc" -eq 0 ] && pass "exit 0" || fail "exit $rc"
grep -q "monitor app-insights query" "$AZ_LOG" && grep -q -- "--app app-consumidor" "$AZ_LOG" \
    && grep -q -- "--resource-group rg-consumidor" "$AZ_LOG" \
    && pass "usa app/rg del consumidor" || fail "no uso app/rg del consumidor"

echo "[c] custom audita"
run "$REPO" custom "exceptions | take 3" >/dev/null
AUDIT="$REPO/.mefisto/pipeline/kql-audit.log"
[ -f "$AUDIT" ] && [ "$(wc -l < "$AUDIT")" -eq 1 ] && pass "una linea en kql-audit.log" || fail "auditoria ausente o sin 1 linea"
AFTER=$(ls -A "$REPO/scripts" | sort | tr '\n' ' ')
[ "$BEFORE" = "$AFTER" ] && pass "sin archivos nuevos junto al script" || fail "aparecieron archivos junto al script"

PLAN="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Web/serverfarms/plan1"
check_plans() {
    local repo="$1"
    : > "$AZ_LOG"
    run "$repo" plan-sites "$PLAN" >/dev/null; rc=$?
    [ "$rc" -eq 0 ] && grep -q "appservice plan show" "$AZ_LOG" && pass "plan-sites usa plan show" || fail "plan-sites fallo"
    : > "$AZ_LOG"
    run "$repo" plan-metrics "$PLAN" --hours 6 >/dev/null; rc=$?
    [ "$rc" -eq 0 ] && grep -q "monitor metrics list" "$AZ_LOG" \
        && grep -q "CpuPercentage MemoryPercentage" "$AZ_LOG" && grep -q "6h" "$AZ_LOG" \
        && pass "plan-metrics usa metrics list con defaults y --hours" || fail "plan-metrics fallo"
    : > "$AZ_LOG"
    run "$repo" plan-sites "no-es-un-id" >/dev/null; rc1=$?
    run "$repo" plan-metrics "/subscriptions/x/mal" >/dev/null; rc2=$?
    [ "$rc1" -ne 0 ] && [ "$rc2" -ne 0 ] && pass "rechaza ids mal formados" || fail "acepto id mal formado"
    grep -qE "^(appservice plan show|monitor metrics list)" "$AZ_LOG" && fail "az de plan invocado con id malo" || pass "sin invocar az con id malo"
    grep -vE "^(account show|appservice plan show|monitor metrics list)" "$AZ_LOG" | grep -q . \
        && fail "az invocado fuera de lectura de plan" || pass "solo az de lectura"
}

echo "[d] plan-sites / plan-metrics"
check_plans "$REPO"
help_out=$(run "$REPO")
echo "$help_out" | grep -q "plan-sites" && echo "$help_out" | grep -q "plan-metrics" \
    && pass "aparecen en el help" || fail "no aparecen en el help"

echo "[e] copia de dist/claude/scripts"
if [ -f "$REPO_ROOT/dist/claude/scripts/appinsights-query.sh" ]; then
    REPO2="$TMP/consumer-dist"
    make_repo "$REPO2" "$REPO_ROOT/dist/claude/scripts"
    mkdir -p "$REPO2/.mefisto"
    cp "$REPO/.mefisto/appinsights.env" "$REPO2/.mefisto/"
    : > "$AZ_LOG"
    run "$REPO2" exceptions >/dev/null; rc=$?
    [ "$rc" -eq 0 ] && grep -q -- "--app app-consumidor" "$AZ_LOG" && pass "exceptions en dist" || fail "exceptions fallo en dist"
    run "$REPO2" custom "exceptions | take 1" >/dev/null
    [ -f "$REPO2/.mefisto/pipeline/kql-audit.log" ] && pass "auditoria en dist" || fail "sin auditoria en dist"
    check_plans "$REPO2"
else
    fail "falta dist/claude/scripts/appinsights-query.sh"
fi

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
