#!/usr/bin/env bash
# test-release-neutrality-rollback.sh -- Rollback del gate de neutralidad en
# la fase prepare de mefisto-release.sh cuando el gate sale en rojo (#1495).
#
# Ejercita el bloque ~486-512 de mefisto-release.sh (sin cambios en este
# issue): con el gate en rojo, la rama de release recien creada se deshace
# (git switch a la rama original + git branch -D) y aborta ANTES de
# consolidar changelog.d/ o tocar cualquier metadata -- no llega a
# generator/git add/git commit/git push/gh pr create. Con el gate en verde
# (control positivo), el mismo fixture alcanza gh pr create, igual que [A] de
# test-release-source-identity.sh -- demuestra que el escenario negativo
# falla por el gate, no por el fixture.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd -P)"
RELEASE="$REPO_ROOT/src/internal/scripts/mefisto-release.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
assert_event() { grep -qF "$2" "$1/events" && pass "$3" || fail "$3"; }
assert_no_event() { ! grep -qF "$2" "$1/events" && pass "$3" || fail "$3"; }
assert_order() {
    local first second
    first="$(grep -nF "$2" "$1/events" | cut -d: -f1 | tail -n1)"
    second="$(grep -nF "$3" "$1/events" | cut -d: -f1 | head -n1)"
    [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ] \
        && pass "$4" || fail "$4"
}

SOURCE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
setup() {
    local name="$1"
    TEST_REPO="$WORK/$name"; BIN="$TEST_REPO/bin"
    mkdir -p "$BIN" "$TEST_REPO/.claude-plugin" "$TEST_REPO/src/published/scripts" \
        "$TEST_REPO/src/internal/scripts" "$TEST_REPO/docs/adr"
    printf '%s\n' '{"name":"mefisto","version":"1.2.2"}' > "$TEST_REPO/.claude-plugin/plugin.json"
    printf '%s\n' '{"schemaVersion":1,"version":"1.2.2","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' > "$TEST_REPO/src/published/release-identity.json"
    cp "$TEST_REPO/.claude-plugin/plugin.json" "$TEST_REPO/plugin.before"
    cp "$TEST_REPO/src/published/release-identity.json" "$TEST_REPO/identity.before"
    cat > "$TEST_REPO/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

### Changed
- Cambio de prueba.

## [1.2.2] - 2026-09-01

[Unreleased]: https://example.invalid/compare/v1.2.2...HEAD
EOF
    cp "$TEST_REPO/CHANGELOG.md" "$TEST_REPO/changelog.before"
    : > "$TEST_REPO/docs/adr/INDICE-TEMATICO.md"

    # Stub del gate de neutralidad parametrizado por GATE_RC/GATE_OUT -- a
    # diferencia del `exit 0` fijo de test-release-source-identity.sh, permite
    # ejercitar tanto el camino feliz (control positivo) como el rollback en
    # rojo con el mismo fixture.
    cat > "$TEST_REPO/src/internal/scripts/mefisto-neutrality-gate.sh" <<'EOF'
#!/usr/bin/env bash
if [ -n "${GATE_OUT:-}" ]; then
    printf '%s\n' "$GATE_OUT"
fi
exit "${GATE_RC:-0}"
EOF
    cat > "$TEST_REPO/src/published/scripts/generate-published-adapters.sh" <<'EOF'
#!/usr/bin/env bash
printf 'generator\n' >> "${EVENTS:?}"
mkdir -p "$TEST_REPO/dist/claude"
cp "$TEST_REPO/mefisto-manifest.json" "$TEST_REPO/dist/claude/mefisto-manifest.json"
printf '%s\n' '{"schemaVersion":1,"assets":[]}' > "$TEST_REPO/dist/claude/.mefisto-generated-assets.json"
EOF
    chmod +x "$TEST_REPO/src/internal/scripts/mefisto-neutrality-gate.sh" \
        "$TEST_REPO/src/published/scripts/generate-published-adapters.sh"

    cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "${EVENTS:?}"
case "$1 ${2:-}" in
  'rev-parse --show-toplevel') printf '%s\n' "$TEST_REPO" ;;
  'rev-parse --abbrev-ref') printf 'topic/anterior\n' ;;
  'rev-parse --verify') printf '%s\n' "${SOURCE_SHA:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}" ;;
  'rev-parse origin/main') printf '%s\n' "${ORIGIN_SHA:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}" ;;
  'rev-parse HEAD') printf '%s\n' "${BRANCH_HEAD:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}" ;;
  'status --porcelain') ;;
  'tag -l') printf 'v1.2.2\n' ;;
  'ls-remote --tags') exit 1 ;;
  'rev-parse -q') exit 1 ;;
  'show-ref --verify') exit 1 ;;
  'fetch origin'|'switch -c'|'add CHANGELOG.md'|'add -A'|'commit -m'|'push -u') ;;
  'diff --cached') exit 1 ;;
  'switch topic/anterior'|'branch -D') ;;
  *) printf 'git falso no esperaba: %s\n' "$*" >&2; exit 64 ;;
esac
EOF
    cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = pr ] && [ "${2:-}" = checks ]; then case " $* " in *" --json "*) echo '[{"name":"tests","state":"SUCCESS"}]';; esac; exit 0; fi
printf 'gh %s\n' "$*" >> "${EVENTS:?}"
case "$1 ${2:-}" in
  'repo view') printf 'owner/mefisto\n' ;;
  'auth status') ;;
  'release view') exit 1 ;;
  'pr create')
    while [ "$#" -gt 0 ]; do
        if [ "$1" = '--body-file' ]; then cp "$2" "$TEST_REPO/pr-body"; break; fi
        shift
    done
    printf 'https://example.invalid/pull/42\n'
    ;;
  'pr merge') exit 9 ;;
  *) printf 'gh falso no esperaba: %s\n' "$*" >&2; exit 64 ;;
esac
EOF
    chmod +x "$BIN/git" "$BIN/gh"
    EVENTS="$TEST_REPO/events"; : > "$EVENTS"
    export TEST_REPO EVENTS SOURCE_SHA="$SOURCE" ORIGIN_SHA="$SOURCE" BRANCH_HEAD="$SOURCE"
    unset GATE_RC GATE_OUT
}

run_prepare() {
    (cd "$TEST_REPO" && PATH="$BIN:$PATH" MEFISTO_REPO_SLUG=owner/mefisto "$RELEASE" patch "$@") \
        > "$TEST_REPO/out" 2>&1
}

GATE_LINE='.claude/agents/fx-agent.md: distinta: adapters-check'

printf '[A] Gate de neutralidad en rojo: rollback de la rama y aborto\n'
setup rollback; GATE_RC=1; GATE_OUT="$GATE_LINE"; export GATE_RC GATE_OUT
run_prepare --prepare-only; rc=$?
[ "$rc" -ne 0 ] && pass 'CA-1: gate en rojo aborta la fase prepare' || fail 'CA-1: gate en rojo deberia abortar'
assert_event "$TEST_REPO" 'git switch -c release/v1.2.3 origin/main' 'CA-1: crea la rama de release'
assert_event "$TEST_REPO" 'git switch topic/anterior' 'CA-1: vuelve a la rama original'
assert_event "$TEST_REPO" 'git branch -D release/v1.2.3' 'CA-1: borra la rama de release'
assert_order "$TEST_REPO" 'git switch -c release/v1.2.3 origin/main' 'git switch topic/anterior' 'CA-1: vuelve a la rama original tras crear la de release'
assert_order "$TEST_REPO" 'git switch topic/anterior' 'git branch -D release/v1.2.3' 'CA-1: borra la rama de release luego de restaurar la original'

printf '[A2] Sin efectos posteriores al rollback (CA-2)\n'
assert_no_event "$TEST_REPO" 'generator' 'CA-2: no genera metadata tras el gate en rojo'
assert_no_event "$TEST_REPO" 'git add' 'CA-2: no stagea nada tras el gate en rojo'
assert_no_event "$TEST_REPO" 'git commit' 'CA-2: no commitea nada tras el gate en rojo'
assert_no_event "$TEST_REPO" 'git push' 'CA-2: no pushea nada tras el gate en rojo'
assert_no_event "$TEST_REPO" 'gh pr create' 'CA-2: no crea PR tras el gate en rojo'
cmp -s "$TEST_REPO/changelog.before" "$TEST_REPO/CHANGELOG.md" \
    && pass 'CA-2: CHANGELOG.md queda byte-identico' || fail 'CA-2: CHANGELOG.md se modifico pese al rollback'
cmp -s "$TEST_REPO/plugin.before" "$TEST_REPO/.claude-plugin/plugin.json" \
    && pass 'CA-2: plugin.json queda byte-identico' || fail 'CA-2: plugin.json se modifico pese al rollback'
cmp -s "$TEST_REPO/identity.before" "$TEST_REPO/src/published/release-identity.json" \
    && pass 'CA-2: release-identity.json queda byte-identico' || fail 'CA-2: release-identity.json se modifico pese al rollback'

printf '[A3] El mensaje de aborto compone la salida del gate con el remedio real (CA-3)\n'
grep -qF "$GATE_LINE" "$TEST_REPO/out" \
    && pass 'CA-3: incluye la linea cruda del gate' || fail 'CA-3: falta la linea del gate'
# La linea de remedio se afirma por su encabezado de regla, no por su prosa
# (de eso se ocupa test-neutrality-remedy.sh): basta con que sea la de
# adapters-check y no la generica de regla no reconocida.
grep -qE '^adapters-check: ' "$TEST_REPO/out" \
    && ! grep -qF 'adapters-check: regla no reconocida' "$TEST_REPO/out" \
    && pass 'CA-3: incluye el remedio real de adapters-check' || fail 'CA-3: falta el remedio de adapters-check'
grep -qF '/mefisto-release patch' "$TEST_REPO/out" \
    && pass 'CA-3: incluye el comando de reintento' || fail 'CA-3: falta el comando de reintento'
grep -qF 'release/v1.2.3' "$TEST_REPO/out" \
    && pass 'CA-3: nombra la rama de release deshecha' || fail 'CA-3: falta el nombre de la rama de release'
grep -qF 'topic/anterior' "$TEST_REPO/out" \
    && pass 'CA-3: nombra la rama original restaurada' || fail 'CA-3: falta el nombre de la rama original'

printf '[B] Control positivo: gate en verde alcanza gh pr create (CA-4)\n'
setup control-positivo; GATE_RC=0; export GATE_RC; unset GATE_OUT
run_prepare --prepare-only; rc=$?
[ "$rc" -eq 0 ] && pass 'CA-4: gate en verde no interfiere con prepare-only' || fail 'CA-4: gate en verde deberia terminar en 0'
assert_event "$TEST_REPO" 'gh pr create' 'CA-4: alcanza la creacion del PR falso'
assert_no_event "$TEST_REPO" 'git branch -D release/v1.2.3' 'CA-4: gate en verde no deshace la rama de release'

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
exit "$FAIL"
