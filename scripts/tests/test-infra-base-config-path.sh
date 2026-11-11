#!/usr/bin/env bash
# test-infra-base-config-path.sh -- Instrucciones efectivas de /infra-base (#1517, MEF-ADR-0053).
#
# Ejecuta el resolver de instrucciones del prompt de infra-base-scaffolder: canonico,
# legacy, coexistencia (prevalece canonico) y ausencia. Los contratos de config,
# naming y PostgreSQL que se verifican leyendo el texto estan en
# infra-base-config-path.test.mts.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT="$REPO_ROOT/agents/infra-base-scaffolder.md"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

extract_instructions_resolver() {
    awk '
        /^if \[ -f "AGENTS\.md" \]; then$/ { inside=1 }
        inside { print }
        inside && /^export MEFISTO_INSTRUCTIONS_PATH$/ { exit }
    ' "$AGENT"
}

echo "[1] Instrucciones efectivas para RootNamespace"
INSTRUCTIONS_RESOLVER=$(extract_instructions_resolver)
if [ -z "$INSTRUCTIONS_RESOLVER" ]; then
    fail "no se pudo extraer el resolver de instrucciones del agente"
else
    resolve_instructions() {
        local root="$1"
        (cd "$root" && bash -c "$INSTRUCTIONS_RESOLVER"$'\n''root_namespace=$(awk -F '\''[:][[:space:]]*'\'' '\''$1 == "RootNamespace" { print $2; exit }'\'' "$MEFISTO_INSTRUCTIONS_PATH"); printf "%s|%s.Projections\\n" "$MEFISTO_INSTRUCTIONS_PATH" "$root_namespace"')
    }

    INSTRUCTIONS_CANONICAL="$TMP_DIR/instructions-canonical"
    mkdir -p "$INSTRUCTIONS_CANONICAL"
    printf '## Tokens del harness\nRootNamespace: Canonical\n' > "$INSTRUCTIONS_CANONICAL/AGENTS.md"
    printf '@AGENTS.md\n' > "$INSTRUCTIONS_CANONICAL/CLAUDE.md"
    out=$(resolve_instructions "$INSTRUCTIONS_CANONICAL" 2>"$TMP_DIR/instructions-canonical.err"); rc=$?
    if [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md|Canonical.Projections' ] && grep -Fq 'se ignora el legacy CLAUDE.md' "$TMP_DIR/instructions-canonical.err"; then
        pass "canonico resuelve desde AGENTS.md el service.name de la alerta y conserva visible el aviso"
    else
        fail "canonico no resolvio AGENTS.md con aviso (rc=$rc, out='$out', err='$(cat "$TMP_DIR/instructions-canonical.err")')"
    fi

    INSTRUCTIONS_LEGACY="$TMP_DIR/instructions-legacy"
    mkdir -p "$INSTRUCTIONS_LEGACY"
    printf '## Tokens del harness\nRootNamespace: Legacy\n' > "$INSTRUCTIONS_LEGACY/CLAUDE.md"
    out=$(resolve_instructions "$INSTRUCTIONS_LEGACY" 2>"$TMP_DIR/instructions-legacy.err"); rc=$?
    if [ "$rc" -eq 0 ] && [ "$out" = 'CLAUDE.md|Legacy.Projections' ] && [ ! -s "$TMP_DIR/instructions-legacy.err" ]; then
        pass "solo legacy resuelve el service.name desde CLAUDE.md como fallback de lectura"
    else
        fail "legacy no resolvio como fallback (rc=$rc, out='$out', err='$(cat "$TMP_DIR/instructions-legacy.err")')"
    fi

    INSTRUCTIONS_BOTH="$TMP_DIR/instructions-both"
    mkdir -p "$INSTRUCTIONS_BOTH"
    printf '## Tokens del harness\nRootNamespace: Canonical\n' > "$INSTRUCTIONS_BOTH/AGENTS.md"
    printf '## Tokens del harness\nRootNamespace: Legacy\n' > "$INSTRUCTIONS_BOTH/CLAUDE.md"
    out=$(resolve_instructions "$INSTRUCTIONS_BOTH" 2>"$TMP_DIR/instructions-both.err"); rc=$?
    if [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md|Canonical.Projections' ] && grep -Fq 'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md.' "$TMP_DIR/instructions-both.err"; then
        pass "coexistencia usa el RootNamespace canonico para la alerta y avisa que ignora el legacy"
    else
        fail "coexistencia no preservo la precedencia canonica (rc=$rc, out='$out', err='$(cat "$TMP_DIR/instructions-both.err")')"
    fi

    INSTRUCTIONS_MISSING="$TMP_DIR/instructions-missing"
    mkdir -p "$INSTRUCTIONS_MISSING"
    out=$(resolve_instructions "$INSTRUCTIONS_MISSING" 2>"$TMP_DIR/instructions-missing.err"); rc=$?
    if [ "$rc" -ne 0 ] && [ -z "$out" ] && grep -Fq '/mefisto:onboard' "$TMP_DIR/instructions-missing.err"; then
        pass "ausencia de instrucciones aborta y remite a onboard"
    else
        fail "ausencia de instrucciones no aborto como corresponde (rc=$rc, out='$out', err='$(cat "$TMP_DIR/instructions-missing.err")')"
    fi
fi

echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
