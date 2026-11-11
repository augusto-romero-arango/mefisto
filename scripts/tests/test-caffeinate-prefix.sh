#!/usr/bin/env bash
# test-caffeinate-prefix.sh -- caffeinate_prefix y su aplicacion en los runners (issue #800).
#
# Los pipelines largos corren minutos u horas, desacoplados o en un pane de
# Herdr; si el Mac entra en suspension idle, las sesiones de claude se congelan sin aviso.
# Los runners anteponen "caffeinate -i" al lanzamiento del sub-pipeline, y el
# prefijo tiene que ser un no-op exacto donde el binario no existe (Linux/CI).
#
# Valida:
#   [A] CA-1/CA-5: caffeinate_prefix esta definida en scripts/_pipeline-common.sh
#       y en su espejo .claude/scripts/_mefisto-common.sh; devuelve
#       "caffeinate -i" cuando el binario esta en PATH y cadena VACIA cuando no
#       (el caso Linux/CI se fuerza con PATH="", sin desinstalar nada).
#   [B] CA-2/CA-4: en launch-pipeline.sh y mefisto-launch-pipeline.sh, el unico
#       lanzamiento desacoplado (nohup ... bash -c) antepone $CAFF al sub-pipeline.
#   [C] CA-3/CA-4: en herdr-pipeline.sh y mefisto-herdr-pipeline.sh el lanzamiento
#       en background del sub-pipeline esta prefijado con $CAFF, y los cuatro
#       runners calculan CAFF una sola vez por corrida (no por lanzamiento).
#
# Uso: scripts/tests/test-caffeinate-prefix.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
cat > "$STUB_DIR/caffeinate" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$STUB_DIR/caffeinate"

# -------- Bloque A: el helper y su no-op --------

echo "[A] caffeinate_prefix: prefijo con el binario en PATH, vacio sin el (CA-1, CA-5)"

COMMONS=(
    "scripts/_pipeline-common.sh"
    ".claude/scripts/_mefisto-common.sh"
)

for common in "${COMMONS[@]}"; do
    path="$REPO_ROOT/$common"

    if bash -c 'set +u; source "$1" >/dev/null 2>&1; declare -F caffeinate_prefix >/dev/null' _ "$path"; then
        pass "$common: caffeinate_prefix definida"
    else
        fail "$common: caffeinate_prefix NO definida"
        continue
    fi

    # PATH con el stub por delante: el resultado no depende de que la maquina
    # sea macOS, solo de que el binario sea resoluble.
    con_binario=$(bash -c 'set +u; source "$1" >/dev/null 2>&1; PATH="$2:$PATH"; caffeinate_prefix' _ "$path" "$STUB_DIR")
    if [ "$con_binario" = "caffeinate -i" ]; then
        pass "$common: con caffeinate en PATH devuelve 'caffeinate -i'"
    else
        fail "$common: con caffeinate en PATH devolvio '$con_binario' (esperado 'caffeinate -i')"
    fi

    # PATH="" tras el source: 'command -v' es builtin, asi que la busqueda
    # falla igual que en un Linux sin caffeinate instalado.
    sin_binario=$(bash -c 'set +u; source "$1" >/dev/null 2>&1; PATH=""; caffeinate_prefix' _ "$path")
    if [ -z "$sin_binario" ]; then
        pass "$common: sin caffeinate en PATH devuelve cadena vacia (no-op)"
    else
        fail "$common: sin caffeinate en PATH devolvio '$sin_binario' (esperado vacio)"
    fi
done

# -------- Bloque B: lanzamiento desacoplado de los despachadores --------

echo ""
echo "[B] desacoplado: el string de bash -c que lanza el sub-pipeline lleva \$CAFF (CA-2, CA-4)"

LAUNCH_RUNNERS=(
    "scripts/launch-pipeline.sh"
    "src/internal/scripts/mefisto-launch-pipeline.sh"
)

for runner in "${LAUNCH_RUNNERS[@]}"; do
    path="$REPO_ROOT/$runner"
    # El comando viaja en una linea propia del lado publicado y en la misma
    # linea que `bash -c` del interno: se mira el bloque nohup completo.
    lanzamiento=$(awk '/nohup env /{p=1} p{print} p && /<\/dev\/null &\)/{p=0}' "$path")
    if [ -n "$lanzamiento" ]; then
        pass "$runner: lanzamiento desacoplado (nohup) detectado"
    else
        fail "$runner: no se detecto el lanzamiento desacoplado (nohup env ... </dev/null &)"
        continue
    fi
    if [ "$(grep -c 'nohup env ' "$path")" -eq 1 ]; then
        pass "$runner: un unico punto de lanzamiento desacoplado"
    else
        fail "$runner: mas de un 'nohup env' -- todos deben pasar por launch_detached"
    fi
    if printf '%s' "$lanzamiento" | grep -qF 'bash -c' && printf '%s' "$lanzamiento" | grep -qE '"[^"]*\$CAFF [^"]*"'; then
        pass "$runner: el sub-pipeline desacoplado arranca prefijado con \$CAFF"
    else
        fail "$runner: el lanzamiento desacoplado NO esta prefijado con \$CAFF:"
        printf '%s\n' "$lanzamiento" | sed 's/^/    /'
    fi
done

# -------- Bloque C: lanzamiento en background de los runners herdr --------

echo ""
echo "[C] herdr: el lanzamiento en background lleva \$CAFF; CAFF se calcula una vez (CA-3, CA-4)"

HERDR_RUNNERS=(
    "scripts/herdr-pipeline.sh"
    "src/internal/scripts/mefisto-herdr-pipeline.sh"
)

for runner in "${HERDR_RUNNERS[@]}"; do
    path="$REPO_ROOT/$runner"
    if grep -qE '^[[:space:]]*\$CAFF env .*"\$@" >"\$report_log" 2>&1 &' "$path"; then
        pass "$runner: el sub-pipeline en background arranca prefijado con \$CAFF"
    else
        fail "$runner: el lanzamiento en background NO esta prefijado con \$CAFF"
    fi
done

for runner in "${LAUNCH_RUNNERS[@]}" "${HERDR_RUNNERS[@]}"; do
    path="$REPO_ROOT/$runner"
    veces=$(grep -c 'CAFF="\$(caffeinate_prefix)"' "$path")
    if [ "$veces" -eq 1 ]; then
        pass "$runner: CAFF se calcula una sola vez por corrida"
    else
        fail "$runner: CAFF se calcula $veces veces (esperado 1)"
    fi
done

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
