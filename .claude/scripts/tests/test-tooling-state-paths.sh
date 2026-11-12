#!/usr/bin/env bash
# test-tooling-state-paths.sh -- Tests del traslado de mefisto-tooling-pipeline.sh
# y _mefisto-common.sh al layout canonico, con rutas de estado neutrales
# (MEF-ADR-0049, issue #869).
#
# Cubre:
#   [pre] La politica interna y el nucleo comun existen con sintaxis
#         bash valida; los shims de .claude/scripts/ tambien (CA-1). Las rutas
#         de estado de una corrida real las prueba mefisto-tooling-pipeline.test.mts.
#   [A]   Los shims son EXACTAMENTE la plantilla documentada en
#         src/internal/scripts/README.md: exec de 3 lineas para el pipeline,
#         source de una linea para la lib (CA-1).
#   [I]   El lanzador herdr resuelve logs/ con mefisto_state_path, de modo
#         que el traslado del pipeline no lo deja vigilando archivos que ya
#         nadie escribe (CA-3). El lanzador desacoplado lo cubre
#         .claude/scripts/tests/mefisto-launch-pipeline.test.mts.
#   [K]   MEFISTO_AGENT_TIMEOUT_SECONDS viaja hasta el eslabon (issue #946,
#         CA-3): mefisto-herdr-pipeline.sh no filtra el entorno del pipeline
#         de tooling mas alla de las HERDR_*, asi que la variable llega
#         heredada sin que ningun eslabon la reenvie a mano. Guarda estatica
#         -- sin fixture, siempre corre. Que el batch la herede lo prueba
#         mefisto-batch-pipeline.test.mts con una corrida real.
#
# Uso: .claude/scripts/tests/test-tooling-state-paths.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

CANON_PIPE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"
CANON_LIB="$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"
SHIM_PIPE="$REPO_ROOT/.claude/scripts/mefisto-tooling-pipeline.sh"
SHIM_LIB="$REPO_ROOT/.claude/scripts/_mefisto-common.sh"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre --------

echo "[pre] Canonicos y shims existen, con sintaxis bash valida"
for f in "$CANON_PIPE" "$CANON_LIB" "$SHIM_PIPE" "$SHIM_LIB"; do
    if [ -f "$f" ]; then
        pass "$(basename "$(dirname "$f")")/$(basename "$f"): presente"
    else
        fail "$f: ausente"
        echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
        exit 1
    fi
    if bash -n "$f" 2>/dev/null; then
        pass "$(basename "$f") ($f): sintaxis bash valida"
    else
        fail "$(basename "$f") ($f): sintaxis bash invalida"
    fi
done

# -------- Bloque A: los shims son la plantilla exacta --------

echo ""
echo "[A] Los shims siguen la plantilla documentada (CA-1)"

if [ -x "$SHIM_PIPE" ]; then pass "el shim del pipeline tiene bit de ejecucion"; else fail "el shim del pipeline no es ejecutable"; fi

EXPECTED_EXEC_SHIM='exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"'
if grep -qF "$EXPECTED_EXEC_SHIM" "$SHIM_PIPE"; then
    pass "el shim del pipeline usa 'exec' con la forma documentada"
else
    fail "el shim del pipeline no coincide con la plantilla de exec de src/internal/scripts/README.md"
fi
if [ "$(grep -cv '^\s*#' "$SHIM_PIPE" | grep -cv '^\s*$')" -le 2 ]; then
    pass "el shim del pipeline no tiene logica propia (solo shebang + exec)"
else
    fail "el shim del pipeline tiene mas codigo del esperado"
fi

if grep -q '^source ' "$SHIM_LIB"; then
    pass "el shim de la lib usa 'source' (no 'exec': se sourcea, no se ejecuta)"
else
    fail "el shim de la lib no usa 'source'"
fi
if grep -qF 'src/internal/scripts/lib/_mefisto-common.sh' "$SHIM_LIB"; then
    pass "el shim de la lib apunta al canonico en src/internal/scripts/lib/"
else
    fail "el shim de la lib no referencia la ruta canonica"
fi
if grep -q 'BASH_SOURCE\[0\]' "$SHIM_LIB"; then
    pass "el shim de la lib resuelve via BASH_SOURCE (correcto para un archivo sourceado, no ejecutado)"
else
    fail "el shim de la lib no usa BASH_SOURCE -- '\$0' resolveria mal cuando se sourcea"
fi

# -------- Bloque K: la variable de timeout viaja heredada hasta el eslabon --------

echo ""
echo "[K] MEFISTO_AGENT_TIMEOUT_SECONDS se hereda en herdr sin reenvio explicito (issue #946, CA-3)"

# CA-3 se cumple hoy por OMISION: ningun eslabon menciona la variable, y por
# eso mismo un grep de presencia no la puede acreditar. Lo que hay que fijar
# es la propiedad que la sostiene -- que el lanzador no PODE el entorno del
# hijo. Es fragil de la forma que una guarda estatica ataja bien: el filtro de
# mefisto-herdr-pipeline.sh (env_unset) ya existe y es un denylist, asi que
# ampliarlo una linea de mas apagaria en silencio todo override de timeout de
# una corrida en herdr -- sin error visible, solo stages volviendo al default
# de 1800s.

CANON_HERDR="$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh"

HERDR_UNSET_ARMS=$(grep -cE 'env_unset\+=' "$CANON_HERDR")
HERDR_UNSET_NON_HERDR=$(grep -E 'env_unset\+=' "$CANON_HERDR" | grep -cvE '^[[:space:]]*HERDR_\*\)' || true)
if [ "$HERDR_UNSET_ARMS" -ge 1 ] && [ "$HERDR_UNSET_NON_HERDR" -eq 0 ]; then
    pass "K-2: el unico filtro de mefisto-herdr-pipeline.sh es la rama HERDR_* ($HERDR_UNSET_ARMS acumulacion(es) de env_unset)"
else
    fail "K-2: mefisto-herdr-pipeline.sh acumula env_unset fuera de la rama HERDR_* ($HERDR_UNSET_NON_HERDR linea(s)): un denylist mas ancho puede tragarse MEFISTO_AGENT_TIMEOUT_SECONDS"
fi

K3_HITS=$(grep -lE -- '-u "?MEFISTO_' "$CANON_HERDR" 2>/dev/null || true)
if [ -z "$K3_HITS" ]; then
    pass "K-3: el lanzador herdr no desregistra ninguna MEFISTO_* del entorno del hijo"
else
    fail "K-3: el lanzador herdr desregistra alguna MEFISTO_* del entorno del hijo: $K3_HITS"
fi

# -------- Bloque I: los lanzadores siguen viendo la corrida --------

echo ""
echo "[I] el lanzador herdr resuelve el estado de la corrida con mefisto_state_path (CA-3)"

# El traslado del pipeline mueve events.log y logs/ a .mefisto/pipeline/. Los
# lanzadores que en ese momento vivian en .claude/scripts/ los componian a
# mano contra .claude/pipeline/, asi que -- sin cambiar una linea de su codigo
# -- pasaban a vigilar archivos que ya nadie escribe: un events.log vacio toda
# la corrida, y el pane de reporte de herdr apuntando a un directorio de logs
# muerto. Ninguno de los dos falla ni avisa; simplemente no muestra nada. El
# porte del lanzador se cerro en #871 y el de herdr en #872 (ambos ya
# canonicos en src/internal/scripts/). Esto solo fija que la resolucion no
# vuelva a quedarse atras.
HERDR_LAUNCHER="$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh"

if grep -qF 'LOG_DIR_ABS="$(mefisto_state_path "logs")"' "$HERDR_LAUNCHER"; then
    pass "I-2: herdr busca los logs de la corrida donde el pipeline los deja"
else
    fail "I-2: mefisto-herdr-pipeline.sh no resuelve logs/ con mefisto_state_path"
fi
for launcher in "$HERDR_LAUNCHER"; do
    name=$(basename "$launcher")
    # Solo lineas de CODIGO: los comentarios si pueden nombrar la ruta legacy al
    # explicar por que se dejo de usar.
    legacy_refs=$(grep -vE '^\s*#' "$launcher" | grep -c '\.claude/pipeline' || true)
    if [ "$legacy_refs" -eq 0 ]; then
        pass "I-3: $name no compone ninguna ruta .claude/pipeline en codigo"
    else
        fail "I-3: $name todavia compone $legacy_refs ruta(s) .claude/pipeline en codigo"
    fi
done

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
