#!/usr/bin/env bash
# test-mcp-smoke-trigger.sh — Tests de list_smokes_invoking_tools de
# _pipeline-common.sh: los smokes existentes que invocan una tool MCP modificada
# (issue #2473). La deteccion del Stage 2b del pipeline TDD (issues #791 y
# #1562) y su cableado los cubre scripts/tests/tdd-pipeline-gates.test.mts.
#
# Uso: scripts/tests/test-mcp-smoke-trigger.sh
# Exit code: 0 si todos los escenarios pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  PASS: $name"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $name"
        echo "    esperado: $expected"
        echo "    obtenido: $actual"
        FAIL=$((FAIL + 1))
    fi
}

NS="Foo.Bar"

# ─── Escenario E (issue #2473): helper list_smokes_invoking_tools ───────────
echo "Escenario E: smokes existentes que invocan una tool modificada (reproduce #1245)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/_pipeline-common.sh"
FX=$(mktemp -d)
trap 'rm -rf "$FX"' EXIT
MCP_SRC="src/${NS}.Mcp.Asistente"
MCP_SMK="tests/${NS}.Mcp.Asistente.SmokeTests"
mkdir -p "$FX/$MCP_SRC" "$FX/$MCP_SMK/CrearPlantillaSemanal" "$FX/$MCP_SMK/AsignarTurnoADia" "$FX/$MCP_SMK/BuscarPlantillas" "$FX/$MCP_SMK/Otra"
cat > "$FX/$MCP_SRC/CrearPlantillaSemanalTool.cs" <<'CS'
internal const string NombreTool = "crear_plantilla_semanal";
CS
cat > "$FX/$MCP_SRC/SinNombreTool.cs" <<'CS'
[McpToolTrigger("x", "desc")]
CS
echo 'public class Nada {}' > "$FX/$MCP_SRC/SinNadaTool.cs"
echo 'CallToolAsync("crear_plantilla_semanal", a);' > "$FX/$MCP_SMK/CrearPlantillaSemanal/CrearSmokeTests.cs"
echo 'CallToolAsync("crear_plantilla_semanal", a);' > "$FX/$MCP_SMK/AsignarTurnoADia/AsignarSmokeTests.cs"
echo 'CallToolAsync("crear_plantilla_semanal", a);' > "$FX/$MCP_SMK/BuscarPlantillas/BuscarSmokeTests.cs"
echo 'CallToolAsync("otra_tool", a);' > "$FX/$MCP_SMK/Otra/OtraSmokeTests.cs"
echo 'CallToolAsync("x", a);' > "$FX/$MCP_SMK/Otra/XSmokeTests.cs"

E1=$(list_smokes_invoking_tools "$FX" "$MCP_SMK" "$MCP_SRC/CrearPlantillaSemanalTool.cs" 2>/dev/null)
assert_eq "E1: lista las tres clases que invocan la tool" "3" "$(printf '%s\n' "$E1" | grep -c '^crear_plantilla_semanal'$'\t')"
assert_eq "E2: no lista la clase que no la invoca" "false" \
    "$(printf '%s\n' "$E1" | grep -qF 'OtraSmokeTests.cs' && echo true || echo false)"
assert_eq "E3: formato <nombre><TAB><ruta> relativa al worktree" "true" \
    "$(printf '%s\n' "$E1" | grep -qF "crear_plantilla_semanal"$'\t'"$MCP_SMK/AsignarTurnoADia/AsignarSmokeTests.cs" && echo true || echo false)"
E4=$(list_smokes_invoking_tools "$FX" "$MCP_SMK" "$MCP_SRC/SinNombreTool.cs" 2>/dev/null)
assert_eq "E4: sin NombreTool se resuelve por McpToolTrigger" "x"$'\t'"$MCP_SMK/Otra/XSmokeTests.cs" "$E4"
E5_ERR=$(list_smokes_invoking_tools "$FX" "$MCP_SMK" "$MCP_SRC/SinNadaTool.cs" 2>&1 >/dev/null)
assert_eq "E5: sin nombre extraible emite warn con la ruta" "true" \
    "$(printf '%s' "$E5_ERR" | grep -qF "$MCP_SRC/SinNadaTool.cs" && echo true || echo false)"
E5_OUT=$(list_smokes_invoking_tools "$FX" "$MCP_SMK" "$MCP_SRC/SinNadaTool.cs" 2>/dev/null)
assert_eq "E5b: y no lista nada" "" "$E5_OUT"

echo
echo "─── Resumen ───"
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
