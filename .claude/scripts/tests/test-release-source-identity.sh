#!/usr/bin/env bash
# test-release-source-identity.sh -- Identidad fuente en prepare (#1132).
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
    : > "$TEST_REPO/docs/adr/INDICE-TEMATICO.md"
    cat > "$TEST_REPO/src/internal/scripts/mefisto-neutrality-gate.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat > "$TEST_REPO/src/published/scripts/generate-published-adapters.sh" <<'EOF'
#!/usr/bin/env bash
printf 'generator\n' >> "${EVENTS:?}"
mkdir -p "$TEST_REPO/dist/claude"
if [ "${GENERATOR_RC:-0}" -ne 0 ]; then
    printf 'parcial\n' > "$TEST_REPO/dist/claude/mefisto-manifest.json"
    exit "$GENERATOR_RC"
fi
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
  'rev-parse -q') exit 1 ;;
  'status --porcelain') ;;
  'tag -l') printf 'v1.2.2\n' ;;
  'ls-remote --tags') exit 1 ;;
  'show-ref --verify') exit 1 ;;
  'fetch origin'|'switch -c'|'add CHANGELOG.md'|'add -A'|'commit -m'|'push -u') ;;
  'diff --cached') exit 1 ;;
  'reset --hard')
    cp "$TEST_REPO/plugin.before" "$TEST_REPO/.claude-plugin/plugin.json"
    cp "$TEST_REPO/identity.before" "$TEST_REPO/src/published/release-identity.json"
    ;;
  'clean -fd') rm -f "$TEST_REPO/mefisto-manifest.json"; rm -rf "$TEST_REPO/dist/claude" ;;
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
    unset GENERATOR_RC
}

run_prepare() {
    (cd "$TEST_REPO" && PATH="$BIN:$PATH" MEFISTO_REPO_SLUG=owner/mefisto "$RELEASE" patch "$@") \
        > "$TEST_REPO/out" 2>&1
}

printf '[A] Prepare-only materializa una identidad unica\n'
setup prepare-only; run_prepare --prepare-only; rc=$?
[ "$rc" -eq 0 ] && pass 'prepare-only termina tras crear el PR falso' || fail 'prepare-only deberia terminar correctamente'
jq -e --arg commit "$SOURCE" '. == {schemaVersion:1,version:"1.2.3",commit:$commit}' "$TEST_REPO/src/published/release-identity.json" >/dev/null \
    && pass 'fuente neutral conserva version y SOURCE_COMMIT' || fail 'fuente neutral invalida'
jq -e --arg commit "$SOURCE" '. == {schemaVersion:1,runtime:"claude",version:"1.2.3",commit:$commit}' "$TEST_REPO/mefisto-manifest.json" >/dev/null \
    && cmp -s "$TEST_REPO/mefisto-manifest.json" "$TEST_REPO/dist/claude/mefisto-manifest.json" \
    && pass 'mirror raiz y salida Claude son semantica y byte-identicos' || fail 'manifiestos Claude divergentes'
assert_order "$TEST_REPO" 'git rev-parse --verify origin/main^{commit}' 'git switch -c release/v1.2.3 origin/main' 'captura SOURCE_COMMIT antes de crear la rama'
assert_order "$TEST_REPO" 'git rev-parse HEAD' 'generator' 'verifica la base antes de generar metadata'
assert_event "$TEST_REPO" 'git add CHANGELOG.md docs/adr/INDICE-TEMATICO.md .claude-plugin/plugin.json src/published/release-identity.json mefisto-manifest.json dist/claude/mefisto-manifest.json dist/claude/.mefisto-generated-assets.json' 'stagea explicitamente toda la metadata'
grep -qF "$SOURCE" "$TEST_REPO/pr-body" && grep -qF '1.2.3' "$TEST_REPO/pr-body" \
    && pass 'body del PR informa version y commit fuente' || fail 'body del PR omite identidad'
assert_no_event "$TEST_REPO" 'git tag -a' 'prepare-only no crea tags'
PREPARE_ONLY_IDENTITY="$(jq -c . "$TEST_REPO/src/published/release-identity.json")"

printf '[B] Prepare normal produce la misma metadata\n'
setup prepare-normal; run_prepare; rc=$?
[ "$rc" -ne 0 ] && assert_event "$TEST_REPO" 'gh pr merge 42 --squash --delete-branch' 'prepare normal alcanza el encadenamiento falso' || fail 'prepare normal debio detenerse en el merge falso'
[ "$(jq -c . "$TEST_REPO/src/published/release-identity.json")" = "$PREPARE_ONLY_IDENTITY" ] \
    && pass 'prepare normal y prepare-only producen igual identidad' || fail 'las modalidades producen metadata distinta'
assert_no_event "$TEST_REPO" 'git tag -a' 'el fallo de merge no publica tags'

printf '[C] Fallos previos a metadata y limpieza de generacion\n'
setup invalid-sha; SOURCE_SHA=corto; export SOURCE_SHA; run_prepare --prepare-only; rc=$?
[ "$rc" -ne 0 ] && assert_no_event "$TEST_REPO" 'git switch -c' 'SHA invalido aborta antes de crear rama' || fail 'SHA invalido deberia abortar'
assert_no_event "$TEST_REPO" 'generator' 'SHA invalido no toca metadata'

setup wrong-base; BRANCH_HEAD=cccccccccccccccccccccccccccccccccccccccc; export BRANCH_HEAD; run_prepare --prepare-only; rc=$?
[ "$rc" -ne 0 ] && assert_no_event "$TEST_REPO" 'generator' 'rama creada desde otra ref aborta antes de metadata' || fail 'base divergente deberia abortar'
assert_event "$TEST_REPO" 'git branch -D release/v1.2.3' 'descarta la rama de base divergente'

setup generator-fails; GENERATOR_RC=7; export GENERATOR_RC; run_prepare --prepare-only; rc=$?
[ "$rc" -ne 0 ] && pass 'fallo del generador aborta' || fail 'fallo del generador deberia abortar'
assert_order "$TEST_REPO" 'generator' 'git reset --hard' 'limpia despues del fallo del generador'
assert_event "$TEST_REPO" 'git clean -fd -- mefisto-manifest.json dist/claude' 'elimina salidas no trackeadas al descartar'
[ ! -e "$TEST_REPO/mefisto-manifest.json" ] && [ ! -e "$TEST_REPO/dist/claude" ] \
    && cmp -s "$TEST_REPO/identity.before" "$TEST_REPO/src/published/release-identity.json" \
    && cmp -s "$TEST_REPO/plugin.before" "$TEST_REPO/.claude-plugin/plugin.json" \
    && pass 'fallo no deja metadata parcial' || fail 'fallo dejo salida parcial'
assert_no_event "$TEST_REPO" 'gh pr create' 'fallo del generador no crea PR'

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
exit "$FAIL"
