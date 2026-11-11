#!/usr/bin/env bash
# test-mcp-scaffolder-instructions-path.sh -- Contrato de instrucciones efectivo
# de mcp-scaffolder (#1507, MEF-ADR-0053 decision 4).
#
# Aqui solo se ejecuta el preludio renderizado; lo que se verifica leyendo el texto
# del agente esta en mcp-scaffolder-instructions-path.test.mts.

set -uo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
AGENT="$REPO_ROOT/agents/mcp-scaffolder.md"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

extract_instructions_block() {
    awk '
        /^```bash$/ { inside=1; block=""; next }
        /^```$/ {
            if (inside && block ~ /MEFISTO_INSTRUCTIONS_PATH/) { print block; exit }
            inside=0; next
        }
        inside { block = block $0 "\n" }
    ' "$AGENT"
}

SCRIPT="$(extract_instructions_block)"
if [ -z "$SCRIPT" ]; then
    fail "no encontro el preludio de instrucciones"
    echo; echo "Resumen: $PASS pass, $FAIL fail"; exit 1
fi

resolve() {
    local root="$1"
    mkdir -p "$root/.mefisto"; printf '{}\n' > "$root/.mefisto/harness.config.json"
    (cd "$root" && bash -c "$SCRIPT"$'\n''printf "%s\n" "$MEFISTO_INSTRUCTIONS_PATH"')
}

tokens() {
    local path="$1"
    grep -E '^(RootNamespace|SolutionFile|ProjectDisplayName|BoundedContext):' "$path" | tr '\n' '|'
}

write_tokens() {
    local path="$1" prefix="$2"
    cat > "$path" <<EOF
RootNamespace: $prefix.Namespace
SolutionFile: $prefix.slnx
ProjectDisplayName: $prefix Display
BoundedContext: $prefix Context
EOF
}

echo "[1] Consumidor canonico"
CANON="$WORK/canonico"; mkdir -p "$CANON"
write_tokens "$CANON/AGENTS.md" Canonico
out="$(resolve "$CANON" 2>"$WORK/canonico.err")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && [ "$(tokens "$CANON/$out")" = 'RootNamespace: Canonico.Namespace|SolutionFile: Canonico.slnx|ProjectDisplayName: Canonico Display|BoundedContext: Canonico Context|' ] && [ ! -s "$WORK/canonico.err" ]; then
    pass "resuelve los cuatro tokens desde AGENTS.md sin detenerse"
else
    fail "el consumidor canonico no resolvio AGENTS.md (out='$out', err='$(cat "$WORK/canonico.err")')"
fi

echo "[2] Consumidor canonico con puente minimo"
BRIDGE="$WORK/puente"; mkdir -p "$BRIDGE"
write_tokens "$BRIDGE/AGENTS.md" Puente
printf '@AGENTS.md\n' > "$BRIDGE/CLAUDE.md"
out="$(resolve "$BRIDGE" 2>"$WORK/puente.err")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && [ "$(tokens "$BRIDGE/$out")" = 'RootNamespace: Puente.Namespace|SolutionFile: Puente.slnx|ProjectDisplayName: Puente Display|BoundedContext: Puente Context|' ] && grep -Fqx 'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' "$WORK/puente.err"; then
    pass "el puente minimo no impide resolver los cuatro tokens canonicos"
else
    fail "el consumidor con puente minimo no resolvio AGENTS.md (out='$out', err='$(cat "$WORK/puente.err")')"
fi

echo "[3] Consumidor solo legacy"
LEGACY="$WORK/legacy"; mkdir -p "$LEGACY"
write_tokens "$LEGACY/CLAUDE.md" Legacy
out="$(resolve "$LEGACY" 2>"$WORK/legacy.err")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = 'CLAUDE.md' ] && [ "$(tokens "$LEGACY/$out")" = 'RootNamespace: Legacy.Namespace|SolutionFile: Legacy.slnx|ProjectDisplayName: Legacy Display|BoundedContext: Legacy Context|' ] && [ ! -s "$WORK/legacy.err" ]; then
    pass "el fallback legacy conserva los cuatro tokens"
else
    fail "el fallback legacy no resolvio como se esperaba (out='$out', err='$(cat "$WORK/legacy.err")')"
fi

echo "[4] Coexistencia divergente"
BOTH="$WORK/ambos"; mkdir -p "$BOTH"
write_tokens "$BOTH/AGENTS.md" Canonico
write_tokens "$BOTH/CLAUDE.md" Legacy
out="$(resolve "$BOTH" 2>"$WORK/ambos.err")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && [ "$(tokens "$BOTH/$out")" = 'RootNamespace: Canonico.Namespace|SolutionFile: Canonico.slnx|ProjectDisplayName: Canonico Display|BoundedContext: Canonico Context|' ] && grep -Fqx 'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' "$WORK/ambos.err"; then
    pass "AGENTS.md prevalece y emite el AVISO literal"
else
    fail "la coexistencia no uso exclusivamente AGENTS.md (out='$out', err='$(cat "$WORK/ambos.err")')"
fi

echo "[5] Ausencia"
MISSING="$WORK/ausente"; mkdir -p "$MISSING"
out="$(resolve "$MISSING" 2>"$WORK/ausente.err")"; rc=$?
if [ "$rc" -ne 0 ] && [ -z "$out" ] && grep -Fqx 'ERROR: no se encontro AGENTS.md, la fuente canonica de directivas del consumidor.' "$WORK/ausente.err" && grep -Fqx '  Ejecuta /mefisto:onboard para diagnosticar y completar el contrato del consumidor.' "$WORK/ausente.err"; then
    pass "la ausencia aborta con el diagnostico de onboarding"
else
    fail "la ausencia no aborto con el diagnostico esperado (rc=$rc, out='$out', err='$(cat "$WORK/ausente.err")')"
fi

echo
echo "Resumen: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
