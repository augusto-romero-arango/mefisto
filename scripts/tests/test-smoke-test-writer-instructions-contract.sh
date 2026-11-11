#!/usr/bin/env bash
# test-smoke-test-writer-instructions-contract.sh -- Lectura del contrato consumidor
# en smoke-test-writer (#1431, MEF-ADR-0053 seccion 4).
#
# Ejecuta el preludio de la salida generada Claude del stage 2b y
# demuestra que RootNamespace procede exclusivamente del archivo efectivo de
# instrucciones: canonico, fallback legacy, coexistencia (prevalece canonico,
# sin mezcla) y ausencia (aborta con el diagnostico de onboarding).
# Ademas, al perder su ultimo nombre de runtime, el agente sale de la excepcion
# transitoria `legacy` del validador publicado.
#
# Lo que se verifica leyendo el texto de la fuente y del agente generado esta en
# agent-instructions-contract.test.mts.

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

echo "[1] La salida generada resuelve RootNamespace desde el archivo efectivo (canonico/fallback/coexistencia/ausencia)"

runtime=Claude; agent_file="$CLAUDE_AGENT"
script="$(extract_bash_block "$agent_file" 2)"
if [ -z "$script" ]; then
    fail "$runtime: no se pudo extraer el bloque de resolucion de instrucciones"
    echo; echo "Resumen: $PASS pass, $FAIL fail"; exit 1
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

echo "[2] smoke-test-writer salio de la excepcion transitoria legacy del validador"

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
