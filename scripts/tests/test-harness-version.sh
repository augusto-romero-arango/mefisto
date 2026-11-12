#!/usr/bin/env bash
# test-harness-version.sh -- Tests de get_harness_version y de los contratos
# de identidad/version en los pipelines publicados (issues #660, #1198, #1363).
#
# Contexto: pipeline-history.jsonl no registraba con que version del plugin
# corrio cada pipeline -- el unico rastro de version (.claude/pipeline/.plugin-root)
# es un snapshot que el hook SessionStart sobreescribe en cada arranque, y no
# permite reconstruir la version de corridas historicas. Este issue agrega:
#
#   - get_harness_version (scripts/_pipeline-common.sh): imprime el '.version'
#     de .claude-plugin/plugin.json, ubicado relativo al propio script (via
#     _pc_script_dir) y no al cwd del pipeline. Con jq, lee '.version'; sin
#     jq, degrada a extraccion con sed; si nada funciona o el archivo no
#     existe, imprime cadena vacia. Nunca aborta, siempre retorna 0.
#   - TDD (y tooling e IaC, en sus .mts) inicializan
#     HARNESS_IDENTITY_JSON desde el paquete y
#     lo revalidan una unica vez contra el runtime activo antes de producir
#     evidencia durable (issue #1363 neutraliza a TDD sobre el mismo patron de
#     tooling, #1198; issue #1626 suma a IaC al mismo contrato). Sus
#     escrituras feliz y de aborto incluyen el objeto identity (version,
#     commit y estado) y el runtime, sin el campo plano harness_version.
#
# Las pruebas de get_harness_version usan un fixture propio (copia de
# _pipeline-common.sh + un .claude-plugin/plugin.json de prueba en un dir
# temporal) para poder variar el contenido/ausencia de plugin.json sin tocar
# el plugin.json real del repo -- _pc_script_dir resuelve SIEMPRE relativo al
# BASH_SOURCE del archivo sourceado, así que sourcear la copia en el fixture
# hace que get_harness_version mire el plugin.json del fixture.
#
# Casos cubiertos:
#   [pre] get_harness_version esta definida en scripts/_pipeline-common.sh.
#   [A] con jq: plugin.json con version valida -> la imprime tal cual.
#   [B] con jq: plugin.json sin campo 'version' -> cadena vacia (CA-1).
#   [C] sin jq en PATH: fallback con sed extrae la misma version (CA-1).
#   [D] plugin.json ausente: cadena vacia, exit 0, nunca aborta (CA-1).
#   [E] smoke test contra el plugin.json REAL del repo (con y sin jq).
#   [F] cableado: TDD revalida HARNESS_IDENTITY_JSON una unica
#       vez contra el runtime activo, antes de producir evidencia durable
#       (issue #1363 CA-1; CA-2 del #1198; issue #1626 CA-3 suma a IaC).
#   [G] cableado: TDD persiste el objeto identity en los
#       historiales feliz y de aborto, sin el campo plano harness_version
#       (issue #1363 CA-1; CA-3 del #1198; issue #1626 CA-3 suma a IaC).
#   [H] un caller con 'set -euo pipefail' (como los tres pipelines) sobrevive
#       a plugin.json ausente: HARNESS_VERSION queda vacia y el script sigue
#       corriendo, en vez de morir en el prologo (CA-1).
#
# Uso: scripts/tests/test-harness-version.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre: la funcion existe --------

echo "[pre] get_harness_version esta definida en scripts/_pipeline-common.sh"
if declare -F get_harness_version >/dev/null; then
    pass "get_harness_version definida"
else
    fail "get_harness_version NO definida"
fi

# -------- Fixture: copia de _pipeline-common.sh + plugin.json de prueba --------
#
# FIXTURE/scripts/_pipeline-common.sh (copia) + FIXTURE/.claude-plugin/plugin.json
# -- misma forma relativa que el plugin real (scripts/ y .claude-plugin/ hermanos).

FIXTURE="$TMP/fixture"
mkdir -p "$FIXTURE/scripts" "$FIXTURE/.claude-plugin"
cp "$REPO_ROOT/scripts/_pipeline-common.sh" "$FIXTURE/scripts/_pipeline-common.sh"

# -------- Bloque A: con jq, version valida --------

echo ""
echo "[A] con jq: plugin.json con version valida -> la imprime tal cual"

cat > "$FIXTURE/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "9.9.9"
}
EOF

if command -v jq >/dev/null 2>&1; then
    A_OUT=$(bash -c "source '$FIXTURE/scripts/_pipeline-common.sh'; get_harness_version")
    A_RC=$?
    if [ "$A_RC" -eq 0 ] && [ "$A_OUT" = "9.9.9" ]; then
        pass "A-1: version leida via jq"
    else
        fail "A-1: se esperaba '9.9.9' rc=0, se obtuvo rc=$A_RC salida='$A_OUT'"
    fi
else
    echo "  SKIP: jq no disponible en este entorno"
fi

# -------- Bloque B: con jq, sin campo 'version' --------

echo ""
echo "[B] con jq: plugin.json sin campo 'version' -> cadena vacia (CA-1)"

cat > "$FIXTURE/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto"
}
EOF

if command -v jq >/dev/null 2>&1; then
    B_OUT=$(bash -c "source '$FIXTURE/scripts/_pipeline-common.sh'; get_harness_version")
    B_RC=$?
    if [ "$B_RC" -eq 0 ] && [ "$B_OUT" = "" ]; then
        pass "B-1: sin campo 'version' -> exit 0 y cadena vacia"
    else
        fail "B-1: se esperaba exit 0 y vacio, se obtuvo rc=$B_RC salida='$B_OUT'"
    fi
else
    echo "  SKIP: jq no disponible en este entorno"
fi

# -------- Bloque C: sin jq en PATH, fallback con sed --------

echo ""
echo "[C] sin jq en PATH: el fallback con sed extrae la misma version (CA-1)"

cat > "$FIXTURE/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "1.2.3",
  "description": "algo con la palabra version adentro"
}
EOF

# PATH hermetico: solo los binarios que el fallback con sed necesita,
# enlazados uno a uno. Un PATH del estilo "$BIN_SIN_JQ:/bin:/usr/bin" NO
# oculta jq -- en macOS vive en /usr/bin/jq --, y con jq resolviendo estos dos
# bloques verificaban la rama de jq creyendo verificar la de sed.
BIN_SIN_JQ="$TMP/bin-sin-jq"
mkdir -p "$BIN_SIN_JQ"
for bin in bash sh sed head cat dirname basename grep tr wc date mkdir rm; do
    origen=$(command -v "$bin" 2>/dev/null) && ln -sf "$origen" "$BIN_SIN_JQ/$bin"
done
if env PATH="$BIN_SIN_JQ" sh -c 'command -v jq' >/dev/null 2>&1; then
    fail "C-0: el PATH sandbox no logro ocultar jq; C-1 y E-2 no probarian el fallback"
fi
C_OUT=$(env PATH="$BIN_SIN_JQ" bash -c "source '$FIXTURE/scripts/_pipeline-common.sh'; get_harness_version")
C_RC=$?
if [ "$C_RC" -eq 0 ] && [ "$C_OUT" = "1.2.3" ]; then
    pass "C-1: fallback con sed sin jq -> '1.2.3'"
else
    fail "C-1: se esperaba exit 0 y '1.2.3', se obtuvo rc=$C_RC salida='$C_OUT'"
fi

# -------- Bloque D: plugin.json ausente --------

echo ""
echo "[D] plugin.json ausente -> cadena vacia, exit 0, nunca aborta (CA-1)"

rm -f "$FIXTURE/.claude-plugin/plugin.json"
D_OUT=$(bash -c "source '$FIXTURE/scripts/_pipeline-common.sh'; get_harness_version")
D_RC=$?
if [ "$D_RC" -eq 0 ] && [ "$D_OUT" = "" ]; then
    pass "D-1: plugin.json ausente -> exit 0 y cadena vacia"
else
    fail "D-1: se esperaba exit 0 y vacio, se obtuvo rc=$D_RC salida='$D_OUT'"
fi

# -------- Bloque E: smoke test contra el plugin.json REAL del repo --------

echo ""
echo "[E] smoke test contra .claude-plugin/plugin.json real del repo"

REAL_VERSION=""
if command -v jq >/dev/null 2>&1; then
    REAL_VERSION=$(jq -r '.version // ""' "$REPO_ROOT/.claude-plugin/plugin.json" 2>/dev/null)
fi

if [ -n "$REAL_VERSION" ]; then
    E1_OUT=$(get_harness_version)
    if [ "$E1_OUT" = "$REAL_VERSION" ]; then
        pass "E-1: con jq, get_harness_version coincide con el plugin.json real ($REAL_VERSION)"
    else
        fail "E-1: se esperaba '$REAL_VERSION', se obtuvo '$E1_OUT'"
    fi

    E2_OUT=$(env PATH="$BIN_SIN_JQ" bash -c "source '$REPO_ROOT/scripts/_pipeline-common.sh'; get_harness_version")
    if [ "$E2_OUT" = "$REAL_VERSION" ]; then
        pass "E-2: sin jq, el fallback con sed tambien coincide ($REAL_VERSION)"
    else
        fail "E-2: se esperaba '$REAL_VERSION' via sed, se obtuvo '$E2_OUT'"
    fi
else
    echo "  SKIP: no se pudo leer la version real (jq ausente o plugin.json sin 'version')"
fi

# -------- Bloque F: contratos de inicializacion de identidad/version --------

echo ""
echo "[F] TDD revalida identidad neutral (issue #1363 CA-1)"

# TDD revalida su identidad exactamente una vez contra el runtime ya resuelto
# (issue #1363) y no recalcula HARNESS_VERSION. Los pipelines de tooling e
# IaC, ya en TypeScript, lo cubren en sus tests.
TDD_PATH="$REPO_ROOT/scripts/tdd-pipeline.sh"
for revalidated in "$TDD_PATH"; do
    identity_occurrences=$(grep -c 'HARNESS_IDENTITY_JSON="\$(get_harness_identity_json "\$MEFISTO_RUNTIME_RESUELTO")"' "$revalidated")
    if [ "$identity_occurrences" = "1" ]; then
        pass "F-3 ($(basename "$revalidated")): HARNESS_IDENTITY_JSON se revalida exactamente una vez contra el runtime activo"
    else
        fail "F-3 ($(basename "$revalidated")): se esperaba 1 revalidacion de identidad contra el runtime, se encontraron $identity_occurrences"
    fi
done

# -------- Bloque G: contratos de history por pipeline --------

echo ""
echo "[G] TDD escribe identity completo, sin harness_version plano (issue #1363 CA-1)"

# TDD (issue #1363): las dos
# lineas de history reciben el objeto identity via jq -cn y no reintroducen
# la clave plana harness_version.
tdd_identity_args=$(grep -c -- '--argjson identity "\$HARNESS_IDENTITY_JSON"' "$TDD_PATH")
tdd_identity_fields=$(grep -c 'identity:\$identity' "$TDD_PATH")
tdd_flat_fields=$(grep -Ec '\\"harness_version\\"|(^|[,{[:space:]])harness_version[[:space:]]*:' "$TDD_PATH")
if [ "$tdd_identity_args" = "2" ] && [ "$tdd_identity_fields" = "2" ]; then
    pass "G-4 (tdd-pipeline.sh): los historiales feliz y de aborto reciben el objeto identity"
else
    fail "G-4 (tdd-pipeline.sh): se esperaban 2 argumentos y 2 campos identity, se encontraron args=$tdd_identity_args campos=$tdd_identity_fields"
fi
if [ "$tdd_flat_fields" = "0" ]; then
    pass "G-5 (tdd-pipeline.sh): no reintroduce harness_version plano"
else
    fail "G-5 (tdd-pipeline.sh): se esperaban 0 campos harness_version planos, se encontraron $tdd_flat_fields"
fi

# El mismo error alimenta el status y el historial construido por jq. Debe
# conservarse crudo hasta entregarlo a jq para evitar una segunda capa de
# barras invertidas cuando contiene comillas.
if grep -Fq 'PIPELINE_ERROR="$(printf '\''%s'\'' "$1" | tr '\''\n'\'' '\'' '\'')"' "$TDD_PATH" \
    && grep -Fq 'error_val="$(jq -cn --arg error "$PIPELINE_ERROR" '\''$error'\'')"' "$TDD_PATH"; then
    pass "G-6 (tdd-pipeline.sh): el error queda crudo hasta su serializacion con jq"
else
    fail "G-6 (tdd-pipeline.sh): el error se preescapa o no se serializa con jq"
fi

# -------- Bloque H: un caller con 'set -euo pipefail' no muere (CA-1) --------
#
# Los tres pipelines corren con 'set -euo pipefail' y toman el valor por
# sustitucion de comando en su prologo. "Nunca aborta" no es una propiedad de
# la funcion aislada sino de esa combinacion: basta que un paso interno se
# escape con estado != 0 para que errexit mate la corrida antes del primer
# stage. Reproducimos el prologo real (asignacion + derivacion del literal
# JSON) sobre el fixture SIN plugin.json, que es el peor caso.

echo ""
echo "[H] caller con 'set -euo pipefail' sobrevive a plugin.json ausente (CA-1)"

H_OUT=$(bash -c "
set -euo pipefail
source '$FIXTURE/scripts/_pipeline-common.sh'
HARNESS_VERSION=\"\$(get_harness_version)\"
HARNESS_VERSION_JSON=null
[ -n \"\$HARNESS_VERSION\" ] && HARNESS_VERSION_JSON=\"\\\"\$HARNESS_VERSION\\\"\"
echo \"SIGUE-VIVO:\$HARNESS_VERSION_JSON\"
" 2>/dev/null)
H_RC=$?
if [ "$H_RC" -eq 0 ] && [ "$H_OUT" = "SIGUE-VIVO:null" ]; then
    pass "H-1: el prologo sobrevive y deriva harness_version=null"
else
    fail "H-1: se esperaba rc=0 y 'SIGUE-VIVO:null', se obtuvo rc=$H_RC salida='$H_OUT'"
fi

# Y el simetrico: con plugin.json presente, el literal JSON queda entrecomillado.
cat > "$FIXTURE/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "7.8.9"
}
EOF
H2_OUT=$(bash -c "
set -euo pipefail
source '$FIXTURE/scripts/_pipeline-common.sh'
HARNESS_VERSION=\"\$(get_harness_version)\"
HARNESS_VERSION_JSON=null
[ -n \"\$HARNESS_VERSION\" ] && HARNESS_VERSION_JSON=\"\\\"\$HARNESS_VERSION\\\"\"
echo \"SIGUE-VIVO:\$HARNESS_VERSION_JSON\"
" 2>/dev/null)
H2_RC=$?
if [ "$H2_RC" -eq 0 ] && [ "$H2_OUT" = 'SIGUE-VIVO:"7.8.9"' ]; then
    pass "H-2: con plugin.json, el literal JSON queda como string entrecomillado"
else
    fail "H-2: se esperaba rc=0 y 'SIGUE-VIVO:\"7.8.9\"', se obtuvo rc=$H2_RC salida='$H2_OUT'"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
