#!/usr/bin/env bash
# Tests de mefisto_resolve_effort y del bloque efforts del mapping (Bash 3.2 + jq).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../lib/mefisto-models.sh"
export MEFISTO_RUNTIME_LIB_DIR="$HERE/../lib"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
check() { # desc expected actual
    if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1 (esperado '$2', obtenido '$3')"; fi
}
run() { mefisto_resolve_effort "$@" >"$TMP/out" 2>/dev/null; RC=$?; OUT="$(cat "$TMP/out")"; }

MAP="$TMP/m.json"
cat >"$MAP" <<'J'
{"opencode":{"efforts":{"agents":{"implementer":"thorough"},"levels":{"thorough":"high"}}}}
J
run opencode implementer light "$MAP"; check "override agente+traduccion parcial rc" 0 "$RC"; check "override agente+traduccion parcial" high "$OUT"
run opencode other thorough "$MAP"; check "traduccion parcial" high "$OUT"
run opencode other exhaustive "$MAP"; check "nivel no listado usa adaptador" max "$OUT"
run opencode other quick; check "default opencode" low "$OUT"
run claude other light; check "default claude light" medium "$OUT"
run claude other standard "$TMP/no-existe.json"; check "ruta inexistente" high "$OUT"
: >"$TMP/vacio.json"; run claude other thorough "$TMP/vacio.json"; check "ruta vacia" xhigh "$OUT"
run claude other exhaustive ""; check "ruta omitida" max "$OUT"
run claude other bogus; check "nivel invalido rc" 1 "$RC"
case "$MEFISTO_EFFORTS_ERROR" in *bogus*) PASS=$((PASS+1));; *) FAIL=$((FAIL+1)); echo "FAIL: error cita valor";; esac
run claude other ""; check "nivel vacio rc" 1 "$RC"

# adaptador sin default hereda aunque se haya cargado otra funcion antes
cp "$HERE/../lib/runtime-fake.sh" "$TMP/runtime-nodef.sh"
sed -i.bak '/^runtime_fake_default_effort() {/,/^}/d' "$TMP/runtime-nodef.sh"
printf '%s\n' 'runtime_nodef2_default_effort() { printf nodef; }' >"$TMP/runtime-nodef2.sh"
printf '%s\n' ':' >"$TMP/runtime-vacio.sh"
run claude a quick; check "claude previo" low "$OUT"
MEFISTO_SAVE="$MEFISTO_RUNTIME_LIB_DIR"; MEFISTO_RUNTIME_LIB_DIR="$TMP"
run nodef2 a quick; check "adaptador con default" nodef "$OUT"
cp "$TMP/runtime-vacio.sh" "$TMP/runtime-nodef2.sh"
run nodef2 a quick; check "adaptador sin default hereda" "" "$OUT"; check "adaptador sin default rc" 0 "$RC"
MEFISTO_RUNTIME_LIB_DIR="$MEFISTO_SAVE"

# fake
MEFISTO_FAKE_DEFAULT_EFFORT=zz run fake a quick; check "fake" zz "$OUT"

# mapping invalido
vr() { printf '%s' "$1" >"$TMP/v.json"; run claude a quick "$TMP/v.json"; }
vr '{"claude":{"efforts":{"levels":{"alto":"high"}}}}'; check "nivel desconocido rc" 1 "$RC"
case "$MEFISTO_EFFORTS_ERROR" in *"claude.efforts.levels.alto: nivel desconocido"*) PASS=$((PASS+1));; *) FAIL=$((FAIL+1)); echo "FAIL: msg nivel: $MEFISTO_EFFORTS_ERROR";; esac
vr '{"claude":{"efforts":{"levels":{"quick":""}}}}'; check "valor vacio rc" 1 "$RC"
vr '{"claude":{"efforts":{"agents":{"x":"alto"}}}}'; check "agente nivel invalido rc" 1 "$RC"
vr '{"claude":{"efforts":{"otro":{}}}}'; check "campo desconocido rc" 1 "$RC"
case "$MEFISTO_EFFORTS_ERROR" in *"claude.efforts.otro: campo desconocido"*) PASS=$((PASS+1));; *) FAIL=$((FAIL+1)); echo "FAIL: msg campo";; esac
vr '{"claude":{"efforts":{"agents":{"x":"deep"}}}}' ; check "perfil no es nivel" 1 "$RC"

echo "efforts: $PASS ok, $FAIL fallos"
[ "$FAIL" -eq 0 ]
