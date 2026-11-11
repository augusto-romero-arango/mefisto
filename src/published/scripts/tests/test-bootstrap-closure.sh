#!/usr/bin/env bash
# Verifica la clausura distribuida de los scripts de bootstrap greenfield.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
DIST="$REPO_ROOT/dist/claude/scripts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# bootstrap-backend y setup-github-ci: scripts/tests/{bootstrap-backend,setup-github-ci}.test.mts.
SCRIPTS=(azure-account-info setup-github-labels)

# Stubs az/gh: registran cada invocacion; el modo de az lo decide AZ_MODE.
STUBS="$WORK/stubs"; mkdir -p "$STUBS"
cat > "$STUBS/az" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "${STUB_LOG:-/dev/null}"
if [ "${1:-}" = "account" ] && [ "${2:-}" = "show" ] && [ "${AZ_MODE:-ok}" = "ok" ]; then
    echo '{"id":"sub-1","name":"Sub Uno","tenantId":"ten-1","user":{"name":"a@b.co","type":"user"},"secret":"x"}'
    exit 0
fi
echo "ERROR: Please run 'az login' to setup account." >&2
exit 1
STUB
cat > "$STUBS/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "${STUB_LOG:-/dev/null}"
exit 1
STUB
chmod +x "$STUBS/az" "$STUBS/gh"

CONSUMER="$WORK/consumer"; mkdir -p "$CONSUMER"
git -C "$CONSUMER" init -q
PLUGIN="$WORK/plugin"; mkdir -p "$PLUGIN/.claude-plugin"
git -C "$PLUGIN" init -q
echo '{}' > "$PLUGIN/.claude-plugin/plugin.json"

for name in "${SCRIPTS[@]}"; do
    f="$DIST/$name.sh"; src="$REPO_ROOT/scripts/$name.sh"
    echo "== $name"
    if [ -f "$f" ] && [ -x "$f" ] && cmp -s "$f" "$src"; then
        pass "$name: existe, ejecutable e identico a scripts/"
    else
        fail "$name: falta, no es ejecutable o difiere de scripts/"
        continue
    fi

    out=$(cd "$CONSUMER" && PATH="$STUBS:$PATH" AZ_MODE=none STUB_LOG=/dev/null bash "$f" --help </dev/null 2>&1) || true
    # Salida esperada: el error del cargador de config de _pipeline-common.sh
    # (prueba que lo resolvio desde dist/) o, en azure-account-info, el de az login.
    if [ "$name" = "azure-account-info" ]; then expected="Ejecuta 'az login' y reintenta"; else expected="no se encontro el config canonico"; fi
    if printf '%s' "$out" | grep -q 'No such file'; then
        fail "$name: dependencia no resuelta ($(printf '%s' "$out" | grep -m1 'No such file'))"
    elif printf '%s' "$out" | grep -qF "$expected"; then
        pass "$name: resuelve sus dependencias desde dist/ con la salida esperada"
    else
        fail "$name: salida inesperada: $(printf '%s' "$out" | head -2)"
    fi

    out=$(cd "$PLUGIN" && PATH="$STUBS:$PATH" bash "$f" </dev/null 2>&1); rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'solo aplica al consumidor'; then
        pass "$name: guard de consumidor aborta en el repo de Mefisto"
    else
        fail "$name: guard de consumidor no aborto (rc=$rc)"
    fi
done

echo "== azure-account-info (d)"
AZI="$DIST/azure-account-info.sh"
LOG="$WORK/az.log"; : > "$LOG"
out=$(cd "$CONSUMER" && PATH="$STUBS:$PATH" AZ_MODE=ok STUB_LOG="$LOG" bash "$AZI" 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e 'keys == ["subscriptionId","subscriptionName","tenantId","user"] and .subscriptionId=="sub-1" and .tenantId=="ten-1" and .user=="a@b.co"' >/dev/null 2>&1; then
    pass "con sesion emite JSON con las cuatro claves"
else
    fail "JSON con sesion invalido (rc=$rc): $out"
fi
if [ -s "$LOG" ] && ! grep -qv '^account show' "$LOG"; then
    pass "solo se invoco 'az account show'"
else
    fail "az invocado con otros comandos: $(cat "$LOG")"
fi
out=$(cd "$CONSUMER" && PATH="$STUBS:$PATH" AZ_MODE=none STUB_LOG=/dev/null bash "$AZI" 2>"$WORK/err"); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$out" ] && grep -qF "ERROR: no hay sesion de Azure activa. Ejecuta 'az login' y reintenta." "$WORK/err"; then
    pass "sin sesion sale != 0 con mensaje de az login y sin stdout"
else
    fail "sin sesion: rc=$rc stdout='$out'"
fi

printf '\nPASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
