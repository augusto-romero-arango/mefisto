#!/usr/bin/env bash
# test-smoke-test-writer-instructions-contract.sh -- Neutraliza la lectura
# del contrato consumidor en smoke-test-writer (#1431, MEF-ADR-0053 seccion
# 4).
#
# Demuestra que la resolucion de RootNamespace en la salida generada
# Claude del stage 2b procede exclusivamente del archivo efectivo
# de instrucciones: canonico, fallback legacy, coexistencia (prevalece
# canonico, sin mezcla) y ausencia (aborta con el diagnostico de onboarding)
# -- sin nombrar la ruta legacy en la fuente neutral ni duplicar la politica
# de precedencia -- y que, al perder su ultimo nombre de runtime, el agente
# sale de la excepcion transitoria `legacy` del validador publicado.

set -uo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
SOURCE_AGENT="$REPO_ROOT/src/published/agents/smoke-test-writer.md"
CLAUDE_AGENT="$REPO_ROOT/agents/smoke-test-writer.md"
VALIDATOR="$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

extract_bash_block() {
    local file="$1" target="$2"
    awk -v target="$target" '
        /^```bash$/ { n++; if (n == target) { inside=1; next } }
        /^```$/ { if (inside) { inside=0; exit } }
        inside { print }
    ' "$file"
}

echo "[1] La fuente neutral usa instructions-path y no nombra la ruta legacy ni duplica la politica de precedencia"
if grep -Fq '{{mefisto:instructions-path}}' "$SOURCE_AGENT"; then
    pass "la fuente neutral usa {{mefisto:instructions-path}}"
else
    fail "la fuente neutral no usa {{mefisto:instructions-path}}"
fi
if grep -Eq 'CLAUDE\.md|archivo de instrucciones raiz' "$SOURCE_AGENT"; then
    fail "la fuente neutral nombra la ruta legacy o una lectura directa del archivo raiz"
else
    pass "la fuente neutral no nombra la ruta legacy directamente"
fi
if grep -Eiq 'canonico primero|fallback legacy' "$SOURCE_AGENT"; then
    fail "la fuente neutral duplica la politica de precedencia canonico-first"
else
    pass "la fuente neutral no duplica la politica de precedencia"
fi

echo "[2] La salida generada resuelve RootNamespace desde el archivo efectivo (canonico/fallback/coexistencia/ausencia)"

runtime=Claude; agent_file="$CLAUDE_AGENT"
script="$(extract_bash_block "$agent_file" 2)"
if [ -z "$script" ]; then
    fail "$runtime: no se pudo extraer el bloque de resolucion de instrucciones"
    echo; echo "Resumen: $PASS pass, $FAIL fail"; exit 1
fi
if grep -Fq '/mefisto:onboard' "$agent_file"; then
    pass "$runtime: el diagnostico de ausencia total remite a onboard"
else
    fail "$runtime: no remite a onboard cuando falta el contrato efectivo"
fi

resolve() {
    local root="$1"
    (cd "$root" && bash -c "$script"$'\n''printf "%s\n" "$MEFISTO_INSTRUCTIONS_PATH"')
}

CANON="$WORK/$runtime-canonico"; mkdir -p "$CANON"
printf 'RootNamespace: Bitakora.ControlAsistencia\n' > "$CANON/AGENTS.md"
out="$(resolve "$CANON" 2>"$WORK/$runtime-canonico.err")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && [ ! -s "$WORK/$runtime-canonico.err" ]; then
    pass "$runtime: solo canonico resuelve sin aviso"
else
    fail "$runtime: canonico no resolvio como se esperaba (out='$out', err='$(cat "$WORK/$runtime-canonico.err")')"
fi

LEGACY="$WORK/$runtime-legacy"; mkdir -p "$LEGACY"
printf 'RootNamespace: Bitakora.ControlAsistencia\n' > "$LEGACY/CLAUDE.md"
out="$(resolve "$LEGACY" 2>"$WORK/$runtime-legacy.err")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = 'CLAUDE.md' ] && [ ! -s "$WORK/$runtime-legacy.err" ]; then
    pass "$runtime: solo legacy resuelve como fallback de lectura"
else
    fail "$runtime: legacy no resolvio como fallback (out='$out', err='$(cat "$WORK/$runtime-legacy.err")')"
fi

BOTH="$WORK/$runtime-ambos"; mkdir -p "$BOTH"
printf 'RootNamespace: Bitakora.ControlAsistencia\n' > "$BOTH/AGENTS.md"
printf 'RootNamespace: Legacy.Divergente\n' > "$BOTH/CLAUDE.md"
out="$(resolve "$BOTH" 2>"$WORK/$runtime-ambos.err")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && grep -qF 'se ignora el legacy' "$WORK/$runtime-ambos.err"; then
    pass "$runtime: coexistencia usa solo el canonico y deja visible que ignora el legacy"
else
    fail "$runtime: coexistencia no eligio exclusivamente el canonico (out='$out', err='$(cat "$WORK/$runtime-ambos.err")')"
fi

MISSING="$WORK/$runtime-ausente"; mkdir -p "$MISSING"
out="$(resolve "$MISSING" 2>"$WORK/$runtime-ausente.err")"; rc=$?
if [ "$rc" -ne 0 ] && [ -z "$out" ] && grep -qF '/mefisto:onboard' "$WORK/$runtime-ausente.err"; then
    pass "$runtime: la ausencia de ambos aborta antes de editar, con diagnostico de onboarding"
else
    fail "$runtime: la ausencia no aborto con el diagnostico esperado (rc=$rc, out='$out', err='$(cat "$WORK/$runtime-ausente.err")')"
fi

echo "[3] smoke-test-writer salio de la excepcion transitoria legacy del validador"

FRONTMATTER="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE_AGENT")"
BODY="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE_AGENT")"

build_probe() {
    local injected="$1" out="$2"
    {
        printf -- '---\n%s\n---\n\n' "$FRONTMATTER"
        printf '%s\n' "$BODY"
        printf '\n%s\n' "$injected"
    } > "$out"
}

# Ambas fixtures usan vocabulario que la excepcion `legacy` toleraba: una
# referencia a Claude Code y el lexico de marketplace (#1430).
for probe in "Claude Code:Este agente asume que corre dentro de Claude Code." "marketplace:Se instala desde el marketplace del plugin."; do
    label="${probe%%:*}"; injected="${probe#*:}"
    mkdir -p "$WORK/probe-${label// /-}"
    probe_file="$WORK/probe-${label// /-}/smoke-test-writer.md"
    build_probe "$injected" "$probe_file"
    out="$(bash "$VALIDATOR" "$probe_file" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF 'referencia un runtime'; then
        pass "vocabulario nuevo de $label se rechaza (ya no aplica la excepcion legacy)"
    else
        fail "vocabulario nuevo de $label no fue rechazado (rc=$rc, out='$out')"
    fi
done

echo
echo "Resumen: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
