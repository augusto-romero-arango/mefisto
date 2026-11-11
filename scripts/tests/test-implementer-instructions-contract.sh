#!/usr/bin/env bash
# test-implementer-instructions-contract.sh -- Lectura del contrato consumidor
# en implementer (#1430, MEF-ADR-0053 seccion 4).
#
# Ejecuta el preludio de la salida generada Claude del stage verde write-side y
# demuestra que RootNamespace procede exclusivamente del archivo efectivo de
# instrucciones: canonico, fallback legacy, coexistencia (prevalece canonico,
# sin mezcla) y ausencia (aborta con el diagnostico de onboarding).
#
# Lo que se verifica leyendo el texto de la fuente y del agente generado esta en
# agent-instructions-contract.test.mts.

set -uo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
CLAUDE_AGENT="$REPO_ROOT/agents/implementer.md"
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

echo
echo "Resumen: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
