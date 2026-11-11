#!/usr/bin/env bash
# test-harness-version.sh -- Tests de get_harness_version/get_harness_sha y su
# cableado en el pipeline INTERNO mefisto-tooling-pipeline.sh (issue #662).
#
# Contexto: el pipeline interno tenia el mismo gap que los publicados (issue
# #660) -- pipeline-history.jsonl no registraba con que version del harness
# corrio. En el repo de Mefisto ademas de "harness_version" (que solo cambia
# en /mefisto-release) hace falta "harness_sha" (HEAD de la raiz ejecutable al
# arrancar): entre release y release entran decenas de PRs, y es justo lo que
# el plan de velocidad interno (#645-#648) quiere comparar entre si. Este
# issue agrega:
#
#   - get_harness_version/get_harness_sha (.claude/scripts/_mefisto-common.sh):
#     imprimen el '.version' de .claude-plugin/plugin.json (jq con fallback
#     sed) y el SHA corto de HEAD respectivamente. Ambos degradan a cadena
#     vacia sin abortar, siempre retornan 0.
#   - HARNESS_VERSION/HARNESS_VERSION_JSON y HARNESS_SHA/HARNESS_SHA_JSON
#     calculados UNA vez en el prologo de mefisto-tooling-pipeline.sh (antes
#     de crear el worktree, sobre la raiz ejecutable), interpolados como
#     "harness_version"/"harness_sha" en las 2 escrituras de
#     pipeline-history.jsonl (feliz + aborto).
#
# Casos cubiertos:
#   [pre] get_harness_version y get_harness_sha estan definidas en
#         .claude/scripts/_mefisto-common.sh.
#   [A] get_harness_version con jq: plugin.json con version valida -> la
#       imprime tal cual.
#   [B] get_harness_version con jq: plugin.json sin campo 'version' -> cadena
#       vacia.
#   [C] get_harness_version sin jq en PATH: fallback con sed extrae la misma
#       version.
#   [D] get_harness_version con plugin.json ausente -> cadena vacia, exit 0.
#   [E] get_harness_version: smoke test contra el plugin.json REAL del repo
#       (con y sin jq).
#   [F] get_harness_sha dentro de un repo git -> coincide con
#       'git rev-parse --short HEAD'.
#   [G] get_harness_sha fuera de un repo git -> cadena vacia, exit 0.
#   [H] get_harness_sha sin 'git' en PATH -> cadena vacia, exit 0.
#   [I] cableado: HARNESS_VERSION y HARNESS_SHA se calculan UNA sola vez en
#       el prologo de mefisto-tooling-pipeline.sh, antes de la definicion de
#       abort() (no dentro de ella).
#   [J] cableado: "harness_version" y "harness_sha" aparecen en las 2
#       escrituras de pipeline-history.jsonl (feliz + aborto).
#   [L] un caller con 'set -euo pipefail' (como el pipeline) sobrevive al peor
#       caso -- plugin.json ausente Y 'git' fuera del PATH --: ambas variables
#       quedan vacias, ambos literales JSON en null, y el prologo sigue vivo
#       en vez de morir antes del primer stage.
#   [M] las 2 lineas de historial que emite el pipeline, ejecutadas de verdad,
#       producen JSON valido con harness_version/harness_sha como string
#       cuando el helper resolvio, y como null JSON (no la cadena "null")
#       cuando degrado.
#
# Uso: .claude/scripts/tests/test-harness-version.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre: las funciones existen --------

echo "[pre] get_harness_version y get_harness_sha estan definidas en _mefisto-common.sh"
if declare -F get_harness_version >/dev/null; then
    pass "get_harness_version definida"
else
    fail "get_harness_version NO definida"
fi
if declare -F get_harness_sha >/dev/null; then
    pass "get_harness_sha definida"
else
    fail "get_harness_sha NO definida"
fi

# -------- Fixture: copia de _mefisto-common.sh + plugin.json de prueba --------
#
# FIXTURE/.claude/scripts/_mefisto-common.sh (copia) +
# FIXTURE/.claude-plugin/plugin.json -- misma forma relativa que el plugin
# real (.claude/scripts/ dos niveles bajo la raiz, .claude-plugin/ hermano de
# .claude/).

FIXTURE="$TMP/fixture"
mkdir -p "$FIXTURE/.claude/scripts" "$FIXTURE/.claude-plugin" "$FIXTURE/src/internal/scripts/lib" "$FIXTURE/src/runtime/lib"
cp "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh" "$FIXTURE/src/internal/scripts/lib/_mefisto-common.sh"
cp "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" "$FIXTURE/.claude/scripts/_mefisto-common.sh"
cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FIXTURE/src/internal/scripts/lib/mefisto-state.sh"
cp "$REPO_ROOT/src/runtime/lib/mefisto-process.sh" "$FIXTURE/src/runtime/lib/mefisto-process.sh"

# -------- Bloque A: con jq, version valida --------

echo ""
echo "[A] get_harness_version con jq: plugin.json con version valida -> la imprime tal cual"

cat > "$FIXTURE/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "9.9.9"
}
EOF

if command -v jq >/dev/null 2>&1; then
    A_OUT=$(bash -c "source '$FIXTURE/.claude/scripts/_mefisto-common.sh'; get_harness_version")
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
echo "[B] get_harness_version con jq: plugin.json sin campo 'version' -> cadena vacia"

cat > "$FIXTURE/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto"
}
EOF

if command -v jq >/dev/null 2>&1; then
    B_OUT=$(bash -c "source '$FIXTURE/.claude/scripts/_mefisto-common.sh'; get_harness_version")
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
echo "[C] get_harness_version sin jq en PATH: el fallback con sed extrae la misma version"

cat > "$FIXTURE/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "1.2.3",
  "description": "algo con la palabra version adentro"
}
EOF

# PATH hermetico: solo los binarios que el fallback con sed (y git, para los
# bloques de get_harness_sha) necesitan, enlazados uno a uno. Un PATH del
# estilo "$BIN_SIN_JQ:/bin:/usr/bin" NO oculta jq -- en macOS vive en
# /usr/bin/jq --, y con jq resolviendo estos bloques verificarian la rama de
# jq creyendo verificar la de sed.
BIN_SIN_JQ="$TMP/bin-sin-jq"
mkdir -p "$BIN_SIN_JQ"
for bin in bash sh sed head cat dirname basename grep tr wc date mkdir rm git; do
    origen=$(command -v "$bin" 2>/dev/null) && ln -sf "$origen" "$BIN_SIN_JQ/$bin"
done
if env PATH="$BIN_SIN_JQ" sh -c 'command -v jq' >/dev/null 2>&1; then
    fail "C-0: el PATH sandbox no logro ocultar jq; C-1 y E-2 no probarian el fallback"
fi
C_OUT=$(env PATH="$BIN_SIN_JQ" bash -c "source '$FIXTURE/.claude/scripts/_mefisto-common.sh'; get_harness_version")
C_RC=$?
if [ "$C_RC" -eq 0 ] && [ "$C_OUT" = "1.2.3" ]; then
    pass "C-1: fallback con sed sin jq -> '1.2.3'"
else
    fail "C-1: se esperaba exit 0 y '1.2.3', se obtuvo rc=$C_RC salida='$C_OUT'"
fi

# -------- Bloque D: plugin.json ausente --------

echo ""
echo "[D] get_harness_version con plugin.json ausente -> cadena vacia, exit 0, nunca aborta"

rm -f "$FIXTURE/.claude-plugin/plugin.json"
D_OUT=$(bash -c "source '$FIXTURE/.claude/scripts/_mefisto-common.sh'; get_harness_version")
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

    E2_OUT=$(env PATH="$BIN_SIN_JQ" bash -c "source '$REPO_ROOT/.claude/scripts/_mefisto-common.sh'; get_harness_version")
    if [ "$E2_OUT" = "$REAL_VERSION" ]; then
        pass "E-2: sin jq, el fallback con sed tambien coincide ($REAL_VERSION)"
    else
        fail "E-2: se esperaba '$REAL_VERSION' via sed, se obtuvo '$E2_OUT'"
    fi
else
    echo "  SKIP: no se pudo leer la version real (jq ausente o plugin.json sin 'version')"
fi

# -------- Bloque F: get_harness_sha dentro de un repo git --------

echo ""
echo "[F] get_harness_sha dentro de un repo git -> coincide con 'git rev-parse --short HEAD'"

GIT_FIXTURE="$TMP/git-fixture"
mkdir -p "$GIT_FIXTURE"
git -C "$GIT_FIXTURE" init -q
git -C "$GIT_FIXTURE" -c user.email="test@example.com" -c user.name="Test" commit --allow-empty -q -m "commit inicial"
EXPECTED_SHA=$(git -C "$GIT_FIXTURE" rev-parse --short HEAD)

F_OUT=$(cd "$GIT_FIXTURE" && bash -c "source '$REPO_ROOT/.claude/scripts/_mefisto-common.sh'; get_harness_sha")
F_RC=$?
if [ "$F_RC" -eq 0 ] && [ "$F_OUT" = "$EXPECTED_SHA" ]; then
    pass "F-1: get_harness_sha coincide con el SHA corto de HEAD ($EXPECTED_SHA)"
else
    fail "F-1: se esperaba '$EXPECTED_SHA' rc=0, se obtuvo rc=$F_RC salida='$F_OUT'"
fi

# -------- Bloque G: get_harness_sha fuera de un repo git --------

echo ""
echo "[G] get_harness_sha fuera de un repo git -> cadena vacia, exit 0, nunca aborta"

NO_GIT_DIR="$TMP/no-git-dir"
mkdir -p "$NO_GIT_DIR"
G_OUT=$(cd "$NO_GIT_DIR" && bash -c "source '$REPO_ROOT/.claude/scripts/_mefisto-common.sh'; get_harness_sha")
G_RC=$?
if [ "$G_RC" -eq 0 ] && [ "$G_OUT" = "" ]; then
    pass "G-1: fuera de un repo git -> exit 0 y cadena vacia"
else
    fail "G-1: se esperaba exit 0 y vacio, se obtuvo rc=$G_RC salida='$G_OUT'"
fi

# -------- Bloque H: get_harness_sha sin 'git' en PATH --------

echo ""
echo "[H] get_harness_sha sin 'git' en PATH -> cadena vacia, exit 0, nunca aborta"

BIN_SIN_GIT="$TMP/bin-sin-git"
mkdir -p "$BIN_SIN_GIT"
for bin in bash sh sed head cat dirname basename grep tr wc date mkdir rm; do
    origen=$(command -v "$bin" 2>/dev/null) && ln -sf "$origen" "$BIN_SIN_GIT/$bin"
done
if env PATH="$BIN_SIN_GIT" sh -c 'command -v git' >/dev/null 2>&1; then
    fail "H-0: el PATH sandbox no logro ocultar git; H-1 no probaria la degradacion"
else
    H_OUT=$(cd "$GIT_FIXTURE" && env PATH="$BIN_SIN_GIT" bash -c "source '$REPO_ROOT/.claude/scripts/_mefisto-common.sh'; get_harness_sha")
    H_RC=$?
    if [ "$H_RC" -eq 0 ] && [ "$H_OUT" = "" ]; then
        pass "H-1: sin 'git' en PATH -> exit 0 y cadena vacia"
    else
        fail "H-1: se esperaba exit 0 y vacio, se obtuvo rc=$H_RC salida='$H_OUT'"
    fi
fi

# -------- Bloque I: HARNESS_VERSION/HARNESS_SHA se calculan UNA vez en el prologo --------

echo ""
echo "[I] HARNESS_VERSION y HARNESS_SHA se calculan UNA vez en el prologo, no dentro de abort()"

PIPE_PATH="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"
abort_line=$(grep -n '^abort() {' "$PIPE_PATH" | head -n1 | cut -d: -f1)

for var_assign in 'HARNESS_VERSION="\$(get_harness_version)"' 'HARNESS_SHA="\$(get_harness_sha)"'; do
    occurrences=$(grep -c -- "$var_assign" "$PIPE_PATH")
    if [ "$occurrences" = "1" ]; then
        pass "I-1 ($var_assign): se asigna exactamente una vez"
    else
        fail "I-1 ($var_assign): se esperaba 1 asignacion, se encontraron $occurrences"
    fi

    assign_line=$(grep -n -- "$var_assign" "$PIPE_PATH" | head -n1 | cut -d: -f1)
    if [ -n "$assign_line" ] && [ -n "$abort_line" ] && [ "$assign_line" -lt "$abort_line" ]; then
        pass "I-2 ($var_assign): la asignacion vive antes de la definicion de abort()"
    else
        fail "I-2 ($var_assign): la asignacion (linea $assign_line) no antecede a abort() (linea $abort_line)"
    fi
done

# -------- Bloque J: los campos viajan en las 2 escrituras (feliz + aborto) --------

echo ""
echo "[J] \"harness_version\" y \"harness_sha\" aparecen en las 2 escrituras de pipeline-history.jsonl"

for field in harness_version harness_sha; do
    field_count=$(grep -c "\\\\\"$field\\\\\"" "$PIPE_PATH")
    if [ "$field_count" = "2" ]; then
        pass "J-1 ($field): aparece en las 2 escrituras (feliz + aborto)"
    else
        fail "J-1 ($field): se esperaban 2 apariciones, se encontraron $field_count"
    fi
done

# -------- Bloque L: un caller con 'set -euo pipefail' no muere --------
#
# El pipeline corre con 'set -euo pipefail' y toma ambos valores por
# sustitucion de comando en su prologo. "Nunca aborta" no es una propiedad de
# cada funcion aislada sino de esa combinacion, y aqui hay dos piezas que
# pueden romperla: un paso interno del helper que se escape con estado != 0, y
# el idioma '[ -n "$X" ] && VAR=...' que deriva el literal JSON (una lista &&
# cuyo lado izquierdo falla justo en el caso degradado). Cualquiera de las dos
# mataria la corrida ANTES del primer stage, y ningun otro bloque lo caza:
# [D]/[G]/[H] prueban las funciones sueltas, sin errexit y sin el idioma.
# Se reproduce el prologo real sobre el peor caso: fixture SIN plugin.json
# (lo borro el bloque D) y PATH sin 'git'.

echo ""
echo "[L] caller con 'set -euo pipefail' sobrevive a plugin.json ausente y sin git"

L_OUT=$(env PATH="$BIN_SIN_GIT" bash -c "
set -euo pipefail
source '$FIXTURE/.claude/scripts/_mefisto-common.sh'
HARNESS_VERSION=\"\$(get_harness_version)\"
HARNESS_VERSION_JSON=null
[ -n \"\$HARNESS_VERSION\" ] && HARNESS_VERSION_JSON=\"\\\"\$HARNESS_VERSION\\\"\"
HARNESS_SHA=\"\$(get_harness_sha)\"
HARNESS_SHA_JSON=null
[ -n \"\$HARNESS_SHA\" ] && HARNESS_SHA_JSON=\"\\\"\$HARNESS_SHA\\\"\"
echo \"SIGUE-VIVO:\$HARNESS_VERSION_JSON:\$HARNESS_SHA_JSON\"
" 2>/dev/null)
L_RC=$?
if [ "$L_RC" -eq 0 ] && [ "$L_OUT" = "SIGUE-VIVO:null:null" ]; then
    pass "L-1: el prologo bajo errexit sobrevive y deja ambos literales en null"
else
    fail "L-1: se esperaba rc=0 y 'SIGUE-VIVO:null:null', se obtuvo rc=$L_RC salida='$L_OUT'"
fi

# -------- Bloque M: las 2 lineas de historial emiten JSON valido --------
#
# [J] es textual: verifica que el nombre del campo aparece en las 2
# escrituras, no que la linea resultante parsee. Una coma de menos o una
# comilla desbalanceada en la interpolacion pasaria [J] y rompería TODAS las
# entradas del historial -- y el fallo solo se veria en la siguiente corrida
# real. Aqui se extraen las 2 lineas 'echo' del pipeline, se ejecutan de
# verdad con las variables que el pipeline tendria en ese punto, y se valida
# la salida con jq. Ademas se cubre lo que ningun grep puede distinguir: que
# el caso degradado produzca null JSON y no la cadena "null".

echo ""
echo "[M] las 2 lineas de historial del pipeline emiten JSON valido con ambos campos"

if command -v jq >/dev/null 2>&1; then
    # Las 2 unicas lineas que abren una entrada de historial; en orden de
    # aparicion: primero la del trap de aborto, despues la del camino feliz.
    # Se les quita la barra de continuacion final para poder ejecutarlas
    # sueltas (en el pipeline siguen con el '>> ...' de la linea siguiente).
    ABORT_ECHO=$(grep -F 'echo "{\"issue\"' "$PIPE_PATH" | sed -n '1p' | sed 's/[[:space:]]*\\$//')
    HAPPY_ECHO=$(grep -F 'echo "{\"issue\"' "$PIPE_PATH" | sed -n '2p' | sed 's/[[:space:]]*\\$//')

    # emitir_linea <linea_echo> <harness_version_json> <harness_sha_json>
    #
    # Arma un script con el prologo de variables que el pipeline tendria vivas
    # en ese punto y le anexa la linea 'echo' extraida, para ejecutarla sin
    # reescribirla (si se transcribiera a mano, el test verificaria una copia
    # y no el codigo que corre en produccion).
    emitir_linea() {
        local echo_line="$1" hv_json="$2" hs_json="$3"
        local runner="$TMP/history-line.sh"
        {
            echo 'set -euo pipefail'
            echo 'ISSUE_NUM=662'
            echo 'ISSUE_TITLE='"'"'titulo con "comillas" adentro'"'"''
            echo 'TIMESTAMP=20260816-101010'
            echo 'CURRENT_STAGE=writer'
            echo 'PIPELINE_ERROR='"'"'fallo de prueba'"'"''
            echo 'PR_URL=https://example.test/pr/1'
            # PR_JSON (issue #711): la linea 'feliz' ya no interpola PR_URL
            # directo -- lo hace via PR_JSON (null si el modo variante omitio
            # el PR). Sin declararla aqui, la linea extraida referencia una
            # variable sin `set` bajo `set -euo pipefail` y el runner aborta
            # antes de llegar al echo.
            echo 'PR_JSON="\"https://example.test/pr/1\""'
            echo 'abort_agents_json='"'"'{"writer":{"duration":600}}'"'"''
            echo 'COMPLETED_AGENTS_JSON='"'"'{"writer":{"duration":600}}'"'"''
            # Entrecomillado simple a proposito: el valor de estas variables
            # ES el literal JSON, comillas incluidas ("0.25.0" con comillas
            # para un string, null pelado para el degradado) -- tal como las
            # deja el prologo del pipeline. Sin las comillas simples el shell
            # del runner se las comeria al asignar y el campo saldria como el
            # numero invalido 0.25.0 en vez de un string.
            echo "HARNESS_VERSION_JSON='$hv_json'"
            echo "HARNESS_SHA_JSON='$hs_json'"
            echo "$echo_line"
        } > "$runner"
        bash "$runner"
    }

    for caso in aborto feliz; do
        if [ "$caso" = "aborto" ]; then
            ECHO_LINE="$ABORT_ECHO"; ESTADO="failed"
        else
            ECHO_LINE="$HAPPY_ECHO"; ESTADO="completed"
        fi

        if [ -z "$ECHO_LINE" ]; then
            fail "M-0 ($caso): no se pudo extraer la linea 'echo' del historial del pipeline"
            continue
        fi

        M_SET=$(emitir_linea "$ECHO_LINE" '"0.25.0"' '"abc1234"')
        if echo "$M_SET" | jq -e --arg estado "$ESTADO" \
            '.harness_version == "0.25.0" and .harness_sha == "abc1234"
             and .issue == "662" and .state == $estado
             and (.title | test("comillas"))' >/dev/null 2>&1; then
            pass "M-1 ($caso): JSON valido con ambos campos como string, sin romper los previos"
        else
            fail "M-1 ($caso): la linea emitida no parsea o pierde campos: $M_SET"
        fi

        M_NULL=$(emitir_linea "$ECHO_LINE" 'null' 'null')
        if echo "$M_NULL" | jq -e \
            '.harness_version == null and .harness_sha == null
             and (has("harness_version") and has("harness_sha"))' >/dev/null 2>&1; then
            pass "M-2 ($caso): helper degradado -> null JSON (no la cadena \"null\")"
        else
            fail "M-2 ($caso): se esperaba null JSON en ambos campos: $M_NULL"
        fi
    done
else
    echo "  SKIP: el bloque M valida la salida con jq, no disponible en este entorno"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
