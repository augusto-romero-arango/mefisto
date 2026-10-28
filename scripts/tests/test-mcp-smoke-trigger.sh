#!/usr/bin/env bash
# test-mcp-smoke-trigger.sh — Tests del disparo del Stage 2b (smoke-test-writer)
# de scripts/tdd-pipeline.sh ante tools MCP nuevas o modificadas (issue #791) y
# del anclaje a src/ + señal de anomalía de deteccion (issue #1562), y del
# listado de smokes existentes que invocan las tools modificadas (issue #2473).
#
# Valida:
#   A) Deteccion de SMOKE_FILES: un *Tool.cs bajo src/{NS}.Mcp.{Proposito}/
#      dispara el Stage 2b tanto en la rama write-side (IS_PROJECTION=false)
#      como en la read-side (IS_PROJECTION=true) -- la deteccion MCP es
#      ortogonal al tipo write-side/read-side del issue (CA-1).
#   B) Negativo: un *Tool.cs FUERA de src/*.Mcp.*/ no dispara por el patron MCP
#      (CA-2). Los patrones vigentes (Function/, Obtener/Listar read-side)
#      siguen intactos -- cubiertos en detalle por test-projection-branch.sh;
#      aqui solo se verifica que sumar la alternativa MCP no los rompe (CA-4).
#   C) Resolucion de SMOKE_TEST_PROJECT: para un archivo MCP cae en
#      tests/{NS}.Mcp.{Proposito}.SmokeTests, via el mismo mecanismo que la
#      resolucion por dominio -- sin rama de resolucion aparte (CA-2).
#   CA-1) SMOKE_FILES solo contiene rutas bajo src/: un match de tests/ (aunque
#      contenga "Function/") no entra, aun mezclado con un match real de src/.
#   CA-2) Un diff cuyo UNICO match de Function/ esta bajo tests/ (reproduccion
#      exacta del caso de la certificacion v0.38.2) deja SMOKE_FILES vacio, asi
#      que Stage 2b toma la rama "No se detectaron Function Apps ni tools MCP
#      modificadas", no la de "Proyecto SmokeTests no existe".
#   CA-3) Un match de src/ cuya forma no es src/<ns>.<Dominio>/... (el sed no
#      transforma la ruta) se detecta como anomalia (SMOKE_DOMAIN == la ruta
#      original, o el resultado contiene '/'), la señal que dispara warn +
#      evento SMOKE_ANOMALY + nota en el PR mientras AGENT_ST_RES se mantiene
#      en "skipped".
#   CA-4) Un dominio bien formado (el sed SI transforma la ruta) nunca se marca
#      como anomalia, aunque el proyecto SmokeTests no exista -- conserva el
#      skip normal.
#   D) Coherencia entre este test y scripts/tdd-pipeline.sh (deteccion de
#      drift, mismo criterio que test-projection-branch.sh Escenario E).
#
# Uso: scripts/tests/test-mcp-smoke-trigger.sh
# Exit code: 0 si todos los escenarios pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TDD_SCRIPT="$REPO_ROOT/scripts/tdd-pipeline.sh"

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

# Reproduccion de la deteccion de SMOKE_FILES, la resolucion de
# SMOKE_TEST_PROJECT y la deteccion de IS_MCP_SMOKE de scripts/tdd-pipeline.sh
# (Stage 2b, issues #791 y #1562). Cualquier cambio aqui debe acompanarse de un
# cambio en el script real (Escenario D).
detect_smoke_files() {
    local is_projection="$1" diff_files="$2" ns="$3"
    local mcp_pattern="^src/${ns}\.Mcp\.[^/]+/.*Tool\.cs\$"
    if [ "$is_projection" = true ]; then
        echo "$diff_files" | grep -E "^src/.*Function/|^src/.*/(Obtener|Listar)[A-Za-z0-9]*/FunctionEndpoint\.cs\$|${mcp_pattern}" || true
    else
        echo "$diff_files" | grep -E "^src/.*Function/|${mcp_pattern}" || true
    fi
}

resolve_smoke_domain() {
    local first_file="$1" ns="$2"
    echo "$first_file" | sed "s|src/${ns}\.\([^/]*\)/.*|\1|"
}

resolve_smoke_test_project() {
    local smoke_files="$1" ns="$2"
    local first_file domain
    first_file=$(echo "$smoke_files" | head -1)
    domain=$(resolve_smoke_domain "$first_file" "$ns")
    echo "tests/${ns}.${domain}.SmokeTests"
}

is_mcp_smoke() {
    local smoke_files="$1" ns="$2"
    local mcp_pattern="^src/${ns}\.Mcp\.[^/]+/.*Tool\.cs\$"
    echo "$smoke_files" | head -1 | grep -qE "$mcp_pattern" && echo true || echo false
}

# Reproduccion de la validacion de anomalia (issue #1562): si el sed de
# resolve_smoke_domain no transformo la ruta, SMOKE_DOMAIN queda identico al
# primer match crudo -- esa igualdad es la senal de anomalia.
is_smoke_anomaly() {
    local smoke_files="$1" ns="$2"
    local first_file domain
    first_file=$(echo "$smoke_files" | head -1)
    domain=$(resolve_smoke_domain "$first_file" "$ns")
    if [ "$domain" = "$first_file" ] || [[ "$domain" == */* ]]; then echo true; else echo false; fi
}

# ─── Escenario A: *Tool.cs bajo src/{NS}.Mcp.{Proposito}/ dispara Stage 2b ──
echo "Escenario A: tool MCP nueva/modificada dispara SMOKE_FILES"
DIFF_MCP=$'src/Foo.Bar.Mcp.Consultas/X/ListarXTool.cs\nsrc/Foo.Bar.Mcp.Consultas/Infraestructura/XApi.cs'

SMOKE_A1=$(detect_smoke_files false "$DIFF_MCP" "$NS")
assert_eq "A1: write-side (sin tipo:projection) detecta la tool MCP" "true" \
    "$(echo "$SMOKE_A1" | grep -qF 'ListarXTool.cs' && echo true || echo false)"

SMOKE_A2=$(detect_smoke_files true "$DIFF_MCP" "$NS")
assert_eq "A2: read-side (tipo:projection) tambien detecta la tool MCP" "true" \
    "$(echo "$SMOKE_A2" | grep -qF 'ListarXTool.cs' && echo true || echo false)"

assert_eq "A3: no incluye el archivo de infraestructura (no es *Tool.cs)" "false" \
    "$(echo "$SMOKE_A1" | grep -qF 'XApi.cs' && echo true || echo false)"

# ─── Escenario B: *Tool.cs fuera de src/*.Mcp.*/ no dispara por el patron MCP ─
echo "Escenario B: Tool.cs fuera de un servidor MCP no dispara (CA-2)"
DIFF_NO_MCP="src/Foo.Bar/CatalogoTurnos/CatalogoTurnosTool.cs"
SMOKE_B1=$(detect_smoke_files false "$DIFF_NO_MCP" "$NS")
assert_eq "B1: *Tool.cs fuera de .Mcp. no aparece en SMOKE_FILES" "" "$SMOKE_B1"

# Los patrones vigentes (Function/, Obtener/Listar read-side) siguen intactos
# -- cubiertos en detalle por test-projection-branch.sh; aqui solo se verifica
# que sumar la alternativa MCP no los rompe.
DIFF_FEATURE="src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs"
SMOKE_B2=$(detect_smoke_files false "$DIFF_FEATURE" "$NS")
assert_eq "B2: patron Function/ (write-side) sigue intacto" "true" \
    "$(echo "$SMOKE_B2" | grep -qF 'CrearTurnoFunction/FunctionEndpoint.cs' && echo true || echo false)"

DIFF_PROJECTION="src/Foo.Bar/ObtenerTurno/FunctionEndpoint.cs"
SMOKE_B3=$(detect_smoke_files true "$DIFF_PROJECTION" "$NS")
assert_eq "B3: patron read-side Obtener/Listar sigue intacto" "true" \
    "$(echo "$SMOKE_B3" | grep -qF 'ObtenerTurno/FunctionEndpoint.cs' && echo true || echo false)"

# ─── Escenario C: resolucion de SMOKE_TEST_PROJECT para un archivo MCP ──────
echo "Escenario C: SMOKE_TEST_PROJECT resuelve al proyecto del servidor MCP"
PROJECT_C1=$(resolve_smoke_test_project "$SMOKE_A1" "$NS")
assert_eq "C1: src/Foo.Bar.Mcp.Consultas/... -> tests/Foo.Bar.Mcp.Consultas.SmokeTests" \
    "tests/Foo.Bar.Mcp.Consultas.SmokeTests" "$PROJECT_C1"

assert_eq "C2: IS_MCP_SMOKE=true para el archivo de Escenario A" "true" "$(is_mcp_smoke "$SMOKE_A1" "$NS")"
assert_eq "C3: IS_MCP_SMOKE=false para el archivo de dominio (Escenario B2)" "false" "$(is_mcp_smoke "$SMOKE_B2" "$NS")"

# ─── Escenario CA-1: SMOKE_FILES solo contiene rutas bajo src/ ──────────────
echo "Escenario CA-1: un match de tests/ no entra a SMOKE_FILES aunque contenga Function/"
DIFF_MIXTO=$'src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs\ntests/Foo.Bar.SmokeTests/CrearTurnoFunction/CrearTurnoSmokeTests.cs'
SMOKE_CA1=$(detect_smoke_files false "$DIFF_MIXTO" "$NS")
assert_eq "CA1-1: incluye el match real de src/" "true" \
    "$(echo "$SMOKE_CA1" | grep -qF 'src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs' && echo true || echo false)"
assert_eq "CA1-2: excluye el match de tests/ (aunque contenga 'Function/')" "false" \
    "$(echo "$SMOKE_CA1" | grep -qF 'tests/Foo.Bar.SmokeTests' && echo true || echo false)"

# ─── Escenario CA-2: unico match de Function/ bajo tests/ (certificacion v0.38.2) ─
echo "Escenario CA-2: unico match bajo tests/ salta por 'no detectadas', no por 'proyecto no existe'"
DIFF_SOLO_TESTS="tests/Foo.Bar.RegistrarSolicitudCertificacion.SmokeTests/RegistrarSolicitudCertificacionFunction/RegistrarSolicitudCertificacionSmokeTests.cs"
SMOKE_CA2=$(detect_smoke_files false "$DIFF_SOLO_TESTS" "$NS")
assert_eq "CA2: SMOKE_FILES queda vacio -> Stage 2b toma la rama 'no se detectaron Function Apps'" "" "$SMOKE_CA2"

# ─── Escenario CA-3: match de src/ que no permite derivar un SMOKE_DOMAIN valido ─
echo "Escenario CA-3: match de src/ sin la forma src/<ns>.<Dominio>/... se marca como anomalia"
DIFF_ANOMALIA="src/${NS}/SharedFunction/FunctionEndpoint.cs"
SMOKE_CA3=$(detect_smoke_files false "$DIFF_ANOMALIA" "$NS")
assert_eq "CA3-1: el match SI entra a SMOKE_FILES (esta bajo src/)" "true" \
    "$(echo "$SMOKE_CA3" | grep -qF "$DIFF_ANOMALIA" && echo true || echo false)"
assert_eq "CA3-2: is_smoke_anomaly detecta que el sed no transformo la ruta" "true" \
    "$(is_smoke_anomaly "$SMOKE_CA3" "$NS")"

DIFF_ANIDADO="src/Legacy/src/${NS}.Turnos/CrearTurnoFunction/FunctionEndpoint.cs"
SMOKE_CA3B=$(detect_smoke_files false "$DIFF_ANIDADO" "$NS")
assert_eq "CA3-3: is_smoke_anomaly detecta un SMOKE_DOMAIN derivado que contiene '/'" "true" \
    "$(is_smoke_anomaly "$SMOKE_CA3B" "$NS")"

# ─── Escenario CA-4: dominio bien formado nunca es anomalia (conserva el skip normal) ─
echo "Escenario CA-4: dominio valido sin proyecto SmokeTests conserva el skip normal (sin SMOKE_ANOMALY)"
DIFF_DOMINIO_VALIDO="src/${NS}.Turnos/CrearTurnoFunction/FunctionEndpoint.cs"
SMOKE_CA4=$(detect_smoke_files false "$DIFF_DOMINIO_VALIDO" "$NS")
assert_eq "CA4-1: is_smoke_anomaly=false para un dominio bien formado" "false" \
    "$(is_smoke_anomaly "$SMOKE_CA4" "$NS")"
PROJECT_CA4=$(resolve_smoke_test_project "$SMOKE_CA4" "$NS")
assert_eq "CA4-2: SMOKE_TEST_PROJECT resuelve a tests/{NS}.Turnos.SmokeTests (el skip, si el dir no existe, sigue siendo el normal)" \
    "tests/${NS}.Turnos.SmokeTests" "$PROJECT_CA4"

# ─── Escenario D: coherencia con el script real ─────────────────────────────
echo "Escenario D: coherencia entre este test y scripts/tdd-pipeline.sh"

assert_script_contains() {
    local name="$1" needle="$2"
    if grep -qF -- "$needle" "$TDD_SCRIPT"; then
        echo "  PASS: $name"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $name"
        echo "    cadena ausente en $TDD_SCRIPT: $needle"
        FAIL=$((FAIL + 1))
    fi
}

assert_script_contains "D1: MCP_TOOL_PATTERN anclado a src/ (issue #1562)" \
    'MCP_TOOL_PATTERN="^src/${HARNESS_NAMESPACE_PREFIX}\.Mcp\.[^/]+/.*Tool\.cs$"'
assert_script_contains "D2: SMOKE_FILES write-side anclado a src/ + alternativa MCP" \
    'grep -E "^src/.*Function/|${MCP_TOOL_PATTERN}"'
assert_script_contains "D3: SMOKE_FILES read-side anclado a src/ + alternativas MCP/Obtener-Listar" \
    'grep -E "^src/.*Function/|^src/.*/(Obtener|Listar)[A-Za-z0-9]*/FunctionEndpoint\.cs$|${MCP_TOOL_PATTERN}"'
assert_script_contains "D4: deteccion de IS_MCP_SMOKE sobre el primer match (FIRST_SMOKE_FILE)" \
    'echo "$FIRST_SMOKE_FILE" | grep -qE "$MCP_TOOL_PATTERN" && IS_MCP_SMOKE=true'
assert_script_contains "D5: el prompt del caso MCP remite a MEF-ADR-0048 y no a Functions HTTP" \
    'MEF-ADR-0048), no la de Functions HTTP.'
assert_script_contains "D6: validacion de anomalia comparando SMOKE_DOMAIN con la ruta original" \
    'if [ "$SMOKE_DOMAIN" = "$FIRST_SMOKE_FILE" ] || [[ "$SMOKE_DOMAIN" == */* ]]; then'
assert_script_contains "D7: evento SMOKE_ANOMALY escrito en events.log" \
    'echo "[$(date +%H:%M:%S)] SMOKE_ANOMALY: $FIRST_SMOKE_FILE" >> "$EVENTS_LOG_ABS"'
assert_script_contains "D8: la nota de anomalia en el PR nombra la ruta" \
    'Un match bajo \`src/\` no permitio derivar el proyecto de smoke tests: \`$SMOKE_ANOMALY_PATH\`.'

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
assert_script_contains "E6: el prompt MCP incluye la lista bajo su titulo" \
    'Smokes existentes que invocan las tools modificadas'
assert_script_contains "E7: seccion informativa del PR" \
    '## Smokes que invocan tools modificadas sin cambios'

echo
echo "─── Resumen ───"
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
