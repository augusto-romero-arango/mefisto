#!/usr/bin/env bash
# test-domain-scaffolder-config-contract.sh -- Neutraliza las lecturas del
# contrato consumidor en domain-scaffolder (#1408, MEF-ADR-0053 seccion 4).
#
# Demuestra que la resolucion de alias de serviceBus.external (backbone
# compartido, MEF-ADR-0024) y de tenancy.strategy (MEF-ADR-0028) en la
# salida generada Claude procede exclusivamente del config
# efectivo: canonico, fallback legacy, coexistencia (prevalece canonico,
# sin mezcla) y ausencia (aborta con diagnostico).
#
# Aqui solo se ejecutan el preambulo y las lecturas del config del agente generado; lo
# que se verifica leyendo el texto esta en domain-scaffolder-config-contract.test.mts.

set -uo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
export MEFISTO_PACKAGE_ROOT="$REPO_ROOT"
CLAUDE_AGENT="$REPO_ROOT/agents/domain-scaffolder.md"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# Bloque del preambulo que resuelve el config efectivo. Desde #2411 la salida
# generada lo precede con el bloque de la raiz del paquete, ajeno a este contrato.
extract_preamble() {
    awk '/^```bash$/{inside=1; buf=""; next}
         /^```$/{if (inside && buf ~ /MEFISTO_CONFIG_PATH=/) { printf "%s", buf; exit } inside=0; next}
         inside{buf = buf $0 "\n"}' "$1"
}
extract_jq_lines() { grep -E 'json-value\.mts" (each|get) "\$\{MEFISTO_CONFIG_PATH\}" (serviceBus\.external|tenancy\.strategy) ' "$1"; }

runtime=Claude; agent_file="$CLAUDE_AGENT"
echo "[1] Los alias de serviceBus.external y tenancy.strategy proceden del config seleccionado (canonico/fallback/coexistencia/ausencia)"

preamble="$(extract_preamble "$agent_file")"
jq_lines="$(extract_jq_lines "$agent_file")"
if [ -z "$preamble" ] || [ -z "$jq_lines" ]; then
    fail "$runtime: no se pudo extraer preambulo o comandos jq del agente generado"
    echo; echo "Resumen: $PASS pass, $FAIL fail"; exit 1
fi
script="$preamble"$'\n'"$jq_lines"

run_scenario() {
    local root="$1"
    (cd "$root" && bash -c "$script")
}

CANON="$WORK/$runtime-canonico"; mkdir -p "$CANON/.mefisto"
cat > "$CANON/.mefisto/harness.config.json" <<'EOF'
{"serviceBus":{"external":[{"alias":"canonico-alias","alcance":"compartido"}]},"tenancy":{"strategy":"multi-tenant-header"}}
EOF
printf '# AGENTS\n' > "$CANON/AGENTS.md"
out="$(run_scenario "$CANON" 2>"$WORK/$runtime-canonico.err")"
if [ "$out" = $'canonico-alias\nmulti-tenant-header' ] && [ ! -s "$WORK/$runtime-canonico.err" ]; then
    pass "$runtime: config canonico resuelve alias y tenancy sin aviso"
else
    fail "$runtime: config canonico no resolvio como se esperaba (out='$out', err='$(cat "$WORK/$runtime-canonico.err")')"
fi

LEGACY="$WORK/$runtime-legacy"; mkdir -p "$LEGACY/.claude"
cat > "$LEGACY/.claude/harness.config.json" <<'EOF'
{"serviceBus":{"external":[{"alias":"legacy-alias","alcance":"compartido"}]},"tenancy":{"strategy":"mono-tenant-transitorio"}}
EOF
printf '# AGENTS\n' > "$LEGACY/AGENTS.md"
out="$(run_scenario "$LEGACY" 2>"$WORK/$runtime-legacy.err")"
if [ "$out" = $'legacy-alias\nmono-tenant-transitorio' ] && [ ! -s "$WORK/$runtime-legacy.err" ]; then
    pass "$runtime: config legacy resuelve como fallback de lectura"
else
    fail "$runtime: config legacy no resolvio como fallback (out='$out', err='$(cat "$WORK/$runtime-legacy.err")')"
fi

BOTH="$WORK/$runtime-ambos"; mkdir -p "$BOTH/.mefisto" "$BOTH/.claude"
cat > "$BOTH/.mefisto/harness.config.json" <<'EOF'
{"serviceBus":{"external":[{"alias":"canonico-alias","alcance":"compartido"}]},"tenancy":{"strategy":"multi-tenant-header"}}
EOF
cat > "$BOTH/.claude/harness.config.json" <<'EOF'
{"serviceBus":{"external":[{"alias":"legacy-alias","alcance":"compartido"}]},"tenancy":{"strategy":"mono-tenant-transitorio"}}
EOF
printf '# AGENTS\n' > "$BOTH/AGENTS.md"
out="$(run_scenario "$BOTH" 2>"$WORK/$runtime-ambos.err")"
if [ "$out" = $'canonico-alias\nmulti-tenant-header' ] && grep -qF 'se ignora el legacy' "$WORK/$runtime-ambos.err"; then
    pass "$runtime: coexistencia usa solo el canonico y deja visible que ignora el legacy"
else
    fail "$runtime: coexistencia no eligio exclusivamente el canonico (out='$out', err='$(cat "$WORK/$runtime-ambos.err")')"
fi

MISSING="$WORK/$runtime-ausente"; mkdir -p "$MISSING"
out="$(run_scenario "$MISSING" 2>"$WORK/$runtime-ausente.err")"; rc=$?
if [ "$rc" -ne 0 ] && [ -z "$out" ]; then
    pass "$runtime: la ausencia de ambos configs aborta antes de resolver alias o tenancy"
else
    fail "$runtime: la ausencia de config no aborto como se esperaba (rc=$rc, out='$out')"
fi

echo
echo "Resumen: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
