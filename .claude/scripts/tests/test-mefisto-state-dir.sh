#!/usr/bin/env bash
# test-mefisto-state-dir.sh -- Tests de src/internal/scripts/lib/mefisto-state.sh
# (issue #856, MEF-ADR-0049 CA-3).
#
# Cubre la resolucion unica del estado interno de Mefisto: canonico
# ".mefisto/pipeline" con fallback de LECTURA a ".claude/pipeline", sin
# migracion automatica.
#
#   [pre] El helper existe, tiene sintaxis bash valida y no usa arrays
#         asociativos (bash 3.2, macOS -- ver mefisto-stream-watch.sh).
#   [defaults] Sin overrides ni <root>, MEFISTO_STATE_DIR/MEFISTO_LEGACY_STATE_DIR
#              resuelven contra la raiz del repo temporal (git rev-parse).
#   [A] Solo canonico existe -> mefisto_state_read_paths devuelve una sola linea.
#   [B] Solo legacy existe -> una sola linea, la legacy.
#   [C] Ambos existen -> dos lineas, canonico primero (CA-3).
#   [D] Ninguno existe -> lista vacia; mefisto_state_read_first sale con exit
#       distinto de cero.
#   [E] MEFISTO_STATE_DIR externo -> se respeta (no se pisa); tanto
#       mefisto_state_path como mefisto_state_read_paths, sin <root>, resuelven
#       contra el.
#   [F] <rel> con subdirectorio (logs/x.log, summaries/stage-1-writer.md) --
#       mefisto_state_path crea el directorio padre.
#   [G] Directorio padre no creable -> mefisto_state_path falla, en vez de
#       devolver una ruta inservible con exit 0.
#   [CA-2/CA-4] El helper nunca escribe en legacy ni copia/renombra/borra nada
#       alli -- checksum del arbol legacy antes/despues de resolver y escribir
#       en canonico.
#
# Corre en un repo temporal (git init), sin tocar el repo real. Cada llamada
# al helper se hace en un bash 3.2 real (/bin/bash en macOS, verificado contra
# este entorno) con MEFISTO_STATE_DIR/MEFISTO_LEGACY_STATE_DIR sin heredar del
# proceso que corre este test (env -u), salvo en [E] que los fija a proposito.
#
# Uso: .claude/scripts/tests/test-mefisto-state-dir.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB="$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[pre] El helper existe y tiene sintaxis valida"
if [ -f "$LIB" ]; then
    pass "mefisto-state.sh presente en src/internal/scripts/lib/"
else
    fail "mefisto-state.sh no existe en src/internal/scripts/lib/"
    echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
    exit 1
fi

if bash -n "$LIB" 2>/dev/null; then
    pass "sintaxis bash valida"
else
    fail "sintaxis bash invalida"
fi

# Se juzga sobre CODIGO, no sobre comentarios: el propio archivo documenta en
# prosa que evita 'declare -A', y un grep crudo leeria esa explicacion como la
# infraccion que describe.
if grep -v '^[[:space:]]*#' "$LIB" | grep -q "declare -A"; then
    fail "usa 'declare -A' (arrays asociativos): rompe en bash 3.2"
else
    pass "no usa 'declare -A' (compatible bash 3.2)"
fi

# -------- Fixtures: repo temporal + runner que ejecuta funciones sueltas --------

# `pwd -P` resuelve simlinks (macOS: /tmp -> /private/tmp) -- sin esto,
# git rev-parse --show-toplevel (que SI resuelve simlinks) devuelve una ruta
# distinta a la que arma mktemp, y toda comparacion de ruta esperada falla por
# un prefijo /private/ que no tiene nada que ver con el helper bajo prueba.
TMPDIR_ROOT=$(cd "$(mktemp -d)" && pwd -P)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

(cd "$TMPDIR_ROOT" && git init -q)

# bash 3.2 real (macOS): verificado en este entorno que /bin/bash es 3.2.57,
# distinto del bash de PATH si hay uno mas nuevo instalado (p. ej. homebrew).
BASH_BIN="/bin/bash"
[ -x "$BASH_BIN" ] || BASH_BIN="bash"

RUNNER="$TMPDIR_ROOT/.runner.sh"
cat > "$RUNNER" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
if [ -n "${STATE_TEST_CD:-}" ]; then
    cd "$STATE_TEST_CD" || exit 1
fi
source "$STATE_TEST_LIB"
"$@"
EOF
chmod +x "$RUNNER"

# call <cd-dir-o-vacio> <funcion-o-comando> <args...>
# Corre <funcion-o-comando> en bash 3.2 real, tras sourcear el helper, sin
# heredar MEFISTO_STATE_DIR/MEFISTO_LEGACY_STATE_DIR del proceso que corre
# este test.
call() {
    local cd_dir="$1"; shift
    env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
        STATE_TEST_LIB="$LIB" STATE_TEST_CD="$cd_dir" \
        "$BASH_BIN" "$RUNNER" "$@"
}

# call_with_state_dir <cd-dir> <MEFISTO_STATE_DIR-externo> <funcion> <args...>
# Variante de call() para [E]: fija MEFISTO_STATE_DIR ANTES de sourcear el
# helper, para verificar que lo respeta en vez de pisarlo.
call_with_state_dir() {
    local cd_dir="$1" state_dir="$2"; shift 2
    env -u MEFISTO_LEGACY_STATE_DIR \
        STATE_TEST_LIB="$LIB" STATE_TEST_CD="$cd_dir" MEFISTO_STATE_DIR="$state_dir" \
        "$BASH_BIN" "$RUNNER" "$@"
}

echo ""
echo "[defaults] Sin overrides, MEFISTO_STATE_DIR/MEFISTO_LEGACY_STATE_DIR resuelven contra la raiz del repo temporal"
GOT_STATE_DIR=$(call "$TMPDIR_ROOT" printenv MEFISTO_STATE_DIR)
GOT_LEGACY_DIR=$(call "$TMPDIR_ROOT" printenv MEFISTO_LEGACY_STATE_DIR)
if [ "$GOT_STATE_DIR" = "$TMPDIR_ROOT/.mefisto/pipeline" ]; then
    pass "MEFISTO_STATE_DIR default = <repo>/.mefisto/pipeline"
else
    fail "MEFISTO_STATE_DIR = '$GOT_STATE_DIR' (esperaba '$TMPDIR_ROOT/.mefisto/pipeline')"
fi
if [ "$GOT_LEGACY_DIR" = "$TMPDIR_ROOT/.claude/pipeline" ]; then
    pass "MEFISTO_LEGACY_STATE_DIR default = <repo>/.claude/pipeline"
else
    fail "MEFISTO_LEGACY_STATE_DIR = '$GOT_LEGACY_DIR' (esperaba '$TMPDIR_ROOT/.claude/pipeline')"
fi

echo ""
echo "[A] Solo canonico existe -> una sola linea"
ROOT_A="$TMPDIR_ROOT/case-a"
mkdir -p "$ROOT_A/.mefisto/pipeline/logs"
echo "x" > "$ROOT_A/.mefisto/pipeline/logs/x.log"
OUT=$(call "" mefisto_state_read_paths "logs/x.log" "$ROOT_A")
EXPECTED="$ROOT_A/.mefisto/pipeline/logs/x.log"
if [ "$OUT" = "$EXPECTED" ]; then
    pass "solo canonico -> devuelve unicamente la ruta canonica"
else
    fail "solo canonico -> '$OUT' (esperaba '$EXPECTED')"
fi

echo ""
echo "[B] Solo legacy existe -> una sola linea, la legacy"
ROOT_B="$TMPDIR_ROOT/case-b"
mkdir -p "$ROOT_B/.claude/pipeline/logs"
echo "y" > "$ROOT_B/.claude/pipeline/logs/x.log"
OUT=$(call "" mefisto_state_read_paths "logs/x.log" "$ROOT_B")
EXPECTED="$ROOT_B/.claude/pipeline/logs/x.log"
if [ "$OUT" = "$EXPECTED" ]; then
    pass "solo legacy -> devuelve unicamente la ruta legacy"
else
    fail "solo legacy -> '$OUT' (esperaba '$EXPECTED')"
fi

echo ""
echo "[C] Ambos existen -> dos lineas, canonico primero"
ROOT_C="$TMPDIR_ROOT/case-c"
mkdir -p "$ROOT_C/.mefisto/pipeline/logs" "$ROOT_C/.claude/pipeline/logs"
echo "canon" > "$ROOT_C/.mefisto/pipeline/logs/x.log"
echo "legacy" > "$ROOT_C/.claude/pipeline/logs/x.log"
OUT=$(call "" mefisto_state_read_paths "logs/x.log" "$ROOT_C")
EXPECTED="$ROOT_C/.mefisto/pipeline/logs/x.log"$'\n'"$ROOT_C/.claude/pipeline/logs/x.log"
if [ "$OUT" = "$EXPECTED" ]; then
    pass "ambos -> canonico primero, legacy despues"
else
    fail "ambos -> '$OUT' (esperaba '$EXPECTED')"
fi

echo ""
echo "[D] Ninguno existe -> lista vacia; mefisto_state_read_first falla"
ROOT_D="$TMPDIR_ROOT/case-d"
mkdir -p "$ROOT_D"
OUT=$(call "" mefisto_state_read_paths "logs/nope.log" "$ROOT_D")
if [ -z "$OUT" ]; then
    pass "ninguno existe -> mefisto_state_read_paths no imprime nada"
else
    fail "ninguno existe -> imprimio '$OUT' (esperaba vacio)"
fi

call "" mefisto_state_read_first "logs/nope.log" "$ROOT_D" >/dev/null
RC=$?
if [ "$RC" -ne 0 ]; then
    pass "mefisto_state_read_first sin nada -> exit distinto de 0"
else
    fail "mefisto_state_read_first sin nada -> exit 0 (deberia fallar)"
fi

echo ""
echo "[E] MEFISTO_STATE_DIR externo: se respeta y mefisto_state_path sin <root> resuelve contra el"
CUSTOM_STATE_DIR="$TMPDIR_ROOT/custom-state"
GOT=$(call_with_state_dir "$TMPDIR_ROOT" "$CUSTOM_STATE_DIR" printenv MEFISTO_STATE_DIR)
if [ "$GOT" = "$CUSTOM_STATE_DIR" ]; then
    pass "MEFISTO_STATE_DIR externo no se pisa al sourcear el helper"
else
    fail "MEFISTO_STATE_DIR externo quedo en '$GOT' (esperaba '$CUSTOM_STATE_DIR')"
fi

CANON_PATH=$(call_with_state_dir "$TMPDIR_ROOT" "$CUSTOM_STATE_DIR" mefisto_state_path "foo/bar.txt")
if [ "$CANON_PATH" = "$CUSTOM_STATE_DIR/foo/bar.txt" ] && [ -d "$CUSTOM_STATE_DIR/foo" ]; then
    pass "mefisto_state_path sin <root> resuelve contra el MEFISTO_STATE_DIR externo"
else
    fail "mefisto_state_path sin <root> dio '$CANON_PATH' o no creo el directorio padre"
fi

# La LECTURA tambien tiene que honrar el override, no solo la escritura: es la
# combinacion que va a usar cualquier caller migrado (#861 en adelante) que
# apunte el estado a otro directorio y despues lo lea.
echo "escrito" > "$CUSTOM_STATE_DIR/foo/bar.txt"
OUT=$(call_with_state_dir "$TMPDIR_ROOT" "$CUSTOM_STATE_DIR" mefisto_state_read_paths "foo/bar.txt")
if [ "$OUT" = "$CUSTOM_STATE_DIR/foo/bar.txt" ]; then
    pass "mefisto_state_read_paths resuelve la canonica contra el MEFISTO_STATE_DIR externo"
else
    fail "mefisto_state_read_paths con override dio '$OUT' (esperaba '$CUSTOM_STATE_DIR/foo/bar.txt')"
fi

echo ""
echo "[F] <rel> con subdirectorio -> mefisto_state_path crea el directorio padre"
ROOT_F="$TMPDIR_ROOT/case-f"
mkdir -p "$ROOT_F"
PATH_LOGS=$(call "" mefisto_state_path "logs/x.log" "$ROOT_F")
PATH_SUMMARY=$(call "" mefisto_state_path "summaries/stage-1-writer.md" "$ROOT_F")
if [ "$PATH_LOGS" = "$ROOT_F/.mefisto/pipeline/logs/x.log" ] && [ -d "$ROOT_F/.mefisto/pipeline/logs" ]; then
    pass "logs/x.log -> ruta correcta y directorio padre creado"
else
    fail "logs/x.log -> ruta '$PATH_LOGS' o directorio padre ausente"
fi
if [ "$PATH_SUMMARY" = "$ROOT_F/.mefisto/pipeline/summaries/stage-1-writer.md" ] && [ -d "$ROOT_F/.mefisto/pipeline/summaries" ]; then
    pass "summaries/stage-1-writer.md -> ruta correcta y directorio padre creado"
else
    fail "summaries/stage-1-writer.md -> ruta '$PATH_SUMMARY' o directorio padre ausente"
fi

echo ""
echo "[G] mkdir imposible -> mefisto_state_path falla en vez de devolver una ruta inservible"
ROOT_G="$TMPDIR_ROOT/case-g"
mkdir -p "$ROOT_G/.mefisto/pipeline"
# Un archivo regular donde deberia ir el directorio "logs/": mkdir -p no puede
# crearlo, y devolver la ruta con exit 0 dejaria al caller escribiendo a ciegas.
echo "soy un archivo, no un directorio" > "$ROOT_G/.mefisto/pipeline/logs"
call "" mefisto_state_path "logs/x.log" "$ROOT_G" >/dev/null 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
    pass "mefisto_state_path con directorio padre no creable -> exit distinto de 0"
else
    fail "mefisto_state_path con directorio padre no creable -> exit 0 (deberia fallar)"
fi

echo ""
echo "[CA-2/CA-4] Nunca escribe en legacy; nunca copia/renombra/borra nada alli"
ROOT_CA4="$TMPDIR_ROOT/case-ca4"
mkdir -p "$ROOT_CA4/.claude/pipeline/logs"
echo "contenido legacy" > "$ROOT_CA4/.claude/pipeline/logs/events.log"
CHECKSUM_BEFORE=$(find "$ROOT_CA4/.claude/pipeline" -type f -print0 | xargs -0 shasum | sort)

CANON_PATH=$(call "" mefisto_state_path "logs/events.log" "$ROOT_CA4")
echo "contenido canonico" > "$CANON_PATH"
call "" mefisto_state_read_paths "logs/events.log" "$ROOT_CA4" >/dev/null

CHECKSUM_AFTER=$(find "$ROOT_CA4/.claude/pipeline" -type f -print0 | xargs -0 shasum | sort)

if [ "$CHECKSUM_BEFORE" = "$CHECKSUM_AFTER" ]; then
    pass "el arbol legacy no cambio (checksum identico antes/despues de resolver y escribir en canonico)"
else
    fail "el arbol legacy cambio: el helper toco algo bajo .claude/pipeline"
fi

if [ "$CANON_PATH" = "$ROOT_CA4/.mefisto/pipeline/logs/events.log" ] && [ -f "$CANON_PATH" ]; then
    pass "la escritura cayo en el canonico, no en legacy, aunque legacy ya existia"
else
    fail "mefisto_state_path no resolvio/escribio en el canonico esperado"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
