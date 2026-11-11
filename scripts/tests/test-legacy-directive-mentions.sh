#!/usr/bin/env bash
# test-legacy-directive-mentions.sh -- Anti-regresion de prosa (#1536): ningun
# agente/skill publicado debe presentar `CLAUDE.md` como el archivo efectivo
# de directivas del consumidor (MEF-ADR-0049 decision 3: `AGENTS.md` es la
# fuente neutral; `CLAUDE.md` es a lo sumo un puente/fallback legacy).
#
# Grep puro, sin ejecutar ningun bloque bash de los agentes. Lista de archivos
# cerrada a proposito (los seis de la tabla del issue): un barrido global sobre
# todo agents/*.md marcaria en falso los bloques `MEFISTO_INSTRUCTIONS_PATH`
# de agentes ya migrados, que contienen `if [ -f "CLAUDE.md" ]` legitimos.
# tooling-investigator migro a la fuente neutral (#1668): se verifica su
# fuente, porque el mirror generado lleva ese mismo preambulo legitimo.
# historiador migro igual (#1671): tambien se verifica su fuente.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TOOLING_INVESTIGATOR="$REPO_ROOT/src/published/agents/tooling-investigator.md"
PLANNER="$REPO_ROOT/agents/planner.md"
HISTORIADOR="$REPO_ROOT/src/published/agents/historiador.md"
FIX_REVIEW="$REPO_ROOT/commands/fix-review.md"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "[1] Ninguna linea de CLAUDE.md sin calificar en los artefactos"
for f in "$TOOLING_INVESTIGATOR" "$PLANNER" "$HISTORIADOR" "$FIX_REVIEW"; do
    name="$(basename "$f")"
    OFFENDING=$(grep -n 'CLAUDE\.md' "$f" | grep -v -i 'legacy\|fallback\|@AGENTS')
    if [ -z "$OFFENDING" ]; then
        pass "$name no presenta CLAUDE.md como el archivo efectivo de directivas"
    else
        fail "$name tiene linea(s) sin calificar:"
        echo "$OFFENDING" | sed 's/^/    /'
    fi
done

echo "[3] planner.md nombra el indice tematico del plugin (INDICE-TEMATICO.md) al menos dos veces"
COUNT=$(grep -c 'INDICE-TEMATICO\.md' "$PLANNER")
if [ "$COUNT" -ge 2 ]; then
    pass "planner.md nombra INDICE-TEMATICO.md $COUNT veces"
else
    fail "planner.md nombra INDICE-TEMATICO.md solo $COUNT vez/veces (se esperaban >= 2)"
fi

echo "[4] fix-review.md remite a mef-adr-0019 en la(s) linea(s) del routing cross-repo"
ROUTING_LINES=$(grep -n -i 'Routing cross-repo: solo drafts' "$FIX_REVIEW")
if [ -z "$ROUTING_LINES" ]; then
    fail "fix-review.md no cita la seccion \"Routing cross-repo: solo drafts\" en ninguna linea"
else
    SIN_ADR=$(echo "$ROUTING_LINES" | grep -v -i 'mef-adr-0019')
    if [ -z "$SIN_ADR" ]; then
        pass "fix-review.md nombra mef-adr-0019 en todas sus lineas de routing cross-repo"
    else
        fail "fix-review.md tiene linea(s) de routing sin remitir a mef-adr-0019:"
        echo "$SIN_ADR" | sed 's/^/    /'
    fi
fi

echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
