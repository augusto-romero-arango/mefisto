#!/usr/bin/env bash
# validate-dockerfile.sh (issue #1652): validacion de ruta, subcomandos docker acotados y log bajo .mefisto.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

CONSUMER="$TMP/consumer"; mkdir -p "$CONSUMER/src/App" "$TMP/bin"
git -C "$CONSUMER" init -q
printf 'FROM scratch\n' > "$CONSUMER/src/App/Dockerfile"
mkdir -p "$TMP/fuera"; printf 'FROM scratch\n' > "$TMP/fuera/Dockerfile"
ln -s "$TMP/fuera" "$CONSUMER/src/Escape"
ln -s "$TMP/fuera/Dockerfile" "$CONSUMER/src/App/Enlace.Dockerfile"
STUB_LOG="$TMP/docker-calls.log"
cat > "$TMP/bin/docker" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$STUB_LOG"
case "\$1" in
    info) [ "\${STUB_DAEMON:-up}" = up ] && exit 0 || exit 1 ;;
    build) echo "build-output"; exit "\${STUB_BUILD_RC:-0}" ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/docker"

run() { # script args...
    local script="$1"; shift
    (cd "$CONSUMER" && PATH="$TMP/bin:$PATH" bash "$script" "$@" 2>&1)
}

check_script() {
    local label="$1" script="$2"
    echo "[$label]"
    for bad in "/abs/Dockerfile" "src/../Dockerfile" "infra/Dockerfile" "src/App/../../x/Dockerfile" "Dockerfile" "src/Escape/Dockerfile" "src/App/Enlace.Dockerfile"; do
        : > "$STUB_LOG"
        if run "$script" "$bad" >/dev/null; then fail "acepta ruta invalida '$bad'"; else pass "rechaza '$bad'"; fi
        [ ! -s "$STUB_LOG" ] && pass "sin docker para '$bad'" || fail "invoco docker para '$bad'"
    done
    : > "$STUB_LOG"
    out="$(run "$script" src/App/Dockerfile)"; rc=$?
    [ "$rc" -eq 0 ] && pass 'ruta valida sale 0' || fail "ruta valida sale $rc"
    calls="$(cat "$STUB_LOG")"
    [ "$(printf '%s\n' "$calls" | sed -n 1p)" = "info" ] && pass 'primero docker info' || fail 'no invoca docker info primero'
    printf '%s\n' "$calls" | sed -n 2p | grep -q '^build -f src/App/Dockerfile ' && pass 'docker build -f <ruta>' || fail 'build mal formado'
    [ "$(printf '%s\n' "$calls" | wc -l | tr -d ' ')" = 2 ] && pass 'solo info y build' || fail 'subcomandos extra'
    printf '%s' "$calls" | grep -qE 'push|run' && fail 'usa push/run' || pass 'sin push ni run'
    [ -f "$CONSUMER/.mefisto/pipeline/logs/projections-docker-build.log" ] && pass 'log bajo .mefisto/pipeline/logs/' || fail 'log ausente'
    case "$out" in *"docker build exit=0"*) pass 'reporta exit code' ;; *) fail 'no reporta exit code' ;; esac
    out="$(STUB_BUILD_RC=3 run "$script" src/App/Dockerfile)"
    case "$out" in *"docker build exit=3"*) pass 'reporta build fallido (exit 3)' ;; *) fail 'no reporta exit 3' ;; esac
    out="$(STUB_DAEMON=down run "$script" src/App/Dockerfile)"; rc=$?
    [ "$rc" -eq 0 ] && pass 'sin daemon sale 0' || fail "sin daemon sale $rc"
    case "$out" in *"no disponible"*) pass 'sin daemon imprime no disponible' ;; *) fail 'falta no disponible' ;; esac
}

[ -x "$REPO_ROOT/scripts/validate-dockerfile.sh" ] && pass 'script ejecutable' || fail 'script no ejecutable'
check_script 'scripts/' "$REPO_ROOT/scripts/validate-dockerfile.sh"
if [ -f "$REPO_ROOT/dist/claude/scripts/validate-dockerfile.sh" ]; then
    check_script 'dist/claude/scripts/' "$REPO_ROOT/dist/claude/scripts/validate-dockerfile.sh"
else
    fail 'falta dist/claude/scripts/validate-dockerfile.sh'
fi

echo '[guard] rechaza el repo de Mefisto'
if (cd "$REPO_ROOT" && PATH="$TMP/bin:$PATH" bash scripts/validate-dockerfile.sh src/x/Dockerfile >/dev/null 2>&1); then fail 'corre en Mefisto'; else pass 'guard de consumidor'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
