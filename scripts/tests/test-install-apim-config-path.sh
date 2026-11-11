#!/usr/bin/env bash
# test-install-apim-config-path.sh -- Contrato de ruta efectiva para el flip de
# tenancy de /install-apim (#1504, MEF-ADR-0053).
#
# Aqui solo se ejecutan los bloques bash del comando; lo que se verifica leyendo
# su texto esta en install-apim-config-path.test.mts.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
COMMAND="$REPO_ROOT/commands/install-apim.md"
PASS=0
FAIL=0

pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
mkdir -p "$HOME"

extract_bash_after_heading() {
    local heading="$1"
    awk -v heading="$heading" '
        $0 == heading { found=1; next }
        found && /^```bash$/ { inside=1; next }
        found && /^```$/ && inside { exit }
        inside { print }
    ' "$COMMAND"
}

FLIP_BLOCK="$(extract_bash_after_heading '#### 9.2 Flip del token')"
COMMIT_BLOCK="$(extract_bash_after_heading '### 10. Commitear la migracion de tenancy')"
STAGE_BLOCK="$(awk '/^if \[ "\$TENANCY_TOKEN_FLIPPED" = true \]; then$/,/^fi$/' <<< "$COMMIT_BLOCK")"

write_config() {
    local path="$1" strategy="$2" extra="$3"
    mkdir -p "$(dirname "$path")"
    jq -n --arg strategy "$strategy" --arg extra "$extra" \
        '{projectName:"Ejemplo", namespacePrefix:"Ejemplo", solutionFile:"Ejemplo.slnx", domainLabels:["ventas"], boundedContext:{name:"Principal", domains:["ventas"]}, tenancy:{strategy:$strategy, extra:$extra}}' > "$path"
}

prepare_repo() {
    local repo="$1"
    mkdir -p "$repo/.mefisto/pipeline"
    git -C "$repo" init -q
    printf '%s\n' "$REPO_ROOT" > "$repo/.mefisto/pipeline/.plugin-root"
}

run_flip() {
    local repo="$1" output="$2"
    (cd "$repo" && MEFISTO_PACKAGE_ROOT="$REPO_ROOT" bash -c "$FLIP_BLOCK
$STAGE_BLOCK") >"$output" 2>&1
}

canonical_is_staged() {
    local repo="$1"
    git -C "$repo" diff --cached --name-only --diff-filter=A | grep -Fxq '.mefisto/harness.config.json'
}

assert_valid_flip() {
    local label="$1" repo="$2" output="$3"
    if jq -e '.tenancy.strategy == "multi-tenant-header" and .tenancy.extra == "preservar"' "$repo/.mefisto/harness.config.json" >/dev/null \
        && jq empty "$repo/.mefisto/harness.config.json" >/dev/null \
        && grep -Fq 'escrito en' "$output"; then
        pass "$label escribe el flip canónico, preserva tenancy y deja JSON valido"
    else
        fail "$label no materializo el flip canónico correctamente: $(cat "$output")"
    fi
}

echo '[1] Canónico en etapa (a)'
CANON="$WORK/canonico"
prepare_repo "$CANON"
write_config "$CANON/.mefisto/harness.config.json" 'mono-tenant-transitorio' 'preservar'
if run_flip "$CANON" "$WORK/canonico.out"; then
    assert_valid_flip 'canónico etapa (a)' "$CANON" "$WORK/canonico.out"
    if canonical_is_staged "$CANON"; then
        pass 'canónico etapa (a) agrega al índice el config efectivamente escrito'
    else
        fail 'canónico etapa (a) no agregó al índice el config efectivamente escrito'
    fi
else
    fail "canónico etapa (a) abortó: $(cat "$WORK/canonico.out")"
fi

echo '[2] Canónico ya en etapa (b)'
ALREADY="$WORK/ya-b"
prepare_repo "$ALREADY"
write_config "$ALREADY/.mefisto/harness.config.json" 'multi-tenant-header' 'preservar'
BEFORE="$(cksum "$ALREADY/.mefisto/harness.config.json")"
if run_flip "$ALREADY" "$WORK/ya-b.out" && [ "$BEFORE" = "$(cksum "$ALREADY/.mefisto/harness.config.json")" ] \
    && grep -Fq 'ya esta en etapa (b)' "$WORK/ya-b.out" \
    && ! canonical_is_staged "$ALREADY"; then
    pass 'canónico etapa (b) no toca el archivo'
else
    fail "canónico etapa (b) modificó o no reportó el archivo: $(cat "$WORK/ya-b.out")"
fi

echo '[3] Ambos configs divergentes'
BOTH="$WORK/ambos"
prepare_repo "$BOTH"
write_config "$BOTH/.mefisto/harness.config.json" 'mono-tenant-transitorio' 'preservar'
write_config "$BOTH/.claude/harness.config.json" 'multi-tenant-header' 'legacy'
LEGACY_BEFORE="$(cksum "$BOTH/.claude/harness.config.json")"
if run_flip "$BOTH" "$WORK/ambos.out"; then
    assert_valid_flip 'coexistencia divergente' "$BOTH" "$WORK/ambos.out"
    if [ "$LEGACY_BEFORE" = "$(cksum "$BOTH/.claude/harness.config.json")" ] \
        && grep -Fq 'se ignora el legacy' "$WORK/ambos.out" \
        && canonical_is_staged "$BOTH" \
        && ! git -C "$BOTH" diff --cached --name-only | grep -Fxq '.claude/harness.config.json'; then
        pass 'coexistencia lee, escribe y agrega solo el canónico; legacy intacto'
    else
        fail "coexistencia no preservó el legacy o no emitió aviso: $(cat "$WORK/ambos.out")"
    fi
else
    fail "coexistencia abortó: $(cat "$WORK/ambos.out")"
fi

echo '[4] Solo legacy y ausencia bloquean antes de escribir'
LEGACY="$WORK/legacy"
prepare_repo "$LEGACY"
write_config "$LEGACY/.claude/harness.config.json" 'mono-tenant-transitorio' 'legacy'
LEGACY_BEFORE="$(cksum "$LEGACY/.claude/harness.config.json")"
if ! run_flip "$LEGACY" "$WORK/legacy.out" \
    && [ "$LEGACY_BEFORE" = "$(cksum "$LEGACY/.claude/harness.config.json")" ] \
    && grep -Fq 'Migra primero el config a' "$WORK/legacy.out"; then
    pass 'solo legacy rechaza la escritura con instrucción de migración'
else
    fail "solo legacy no bloqueó correctamente: $(cat "$WORK/legacy.out")"
fi

write_config "$LEGACY/.claude/harness.config.json" 'multi-tenant-header' 'legacy'
LEGACY_BEFORE="$(cksum "$LEGACY/.claude/harness.config.json")"
if ! run_flip "$LEGACY" "$WORK/legacy-b.out" \
    && [ "$LEGACY_BEFORE" = "$(cksum "$LEGACY/.claude/harness.config.json")" ] \
    && grep -Fq 'Migra primero el config a' "$WORK/legacy-b.out"; then
    pass 'solo legacy en etapa (b) también bloquea antes del 9.3'
else
    fail "solo legacy en etapa (b) no bloqueó correctamente: $(cat "$WORK/legacy-b.out")"
fi

MISSING="$WORK/ausente"
prepare_repo "$MISSING"
if ! run_flip "$MISSING" "$WORK/ausente.out" \
    && grep -Fq 'no se encontro el config canonico requerido' "$WORK/ausente.out"; then
    pass 'ausencia de ambos configs aborta'
else
    fail "ausencia no bloqueó correctamente: $(cat "$WORK/ausente.out")"
fi

echo '----------------------------------------'
echo "  Resumen: $PASS pass, $FAIL fail"
echo '----------------------------------------'
[ "$FAIL" -eq 0 ]
