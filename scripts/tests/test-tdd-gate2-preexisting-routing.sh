#!/usr/bin/env bash
# test-tdd-gate2-preexisting-routing.sh -- Helpers de _pipeline-common.sh del Gate 2
# determinista para rojos preexistentes y de la seccion de tests ajustados por el
# reviewer (issues #2062, #2438). Su cableado en el pipeline TDD lo cubre
# scripts/tests/tdd-pipeline.test.mts.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../_pipeline-common.sh
source "$REPO_ROOT/scripts/_pipeline-common.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
W="$TMP/wt"; mkdir -p "$W/tests/X.Tests"
git -C "$W" init -q -b main
git -C "$W" config user.email t@t; git -C "$W" config user.name t
cat > "$W/tests/X.Tests/GuardTests.cs" <<'CS'
public class GuardTests
{
    [Fact]
    public void Guarda_Inventario()
    {
        Assert.Equal(28, Catalogo.Count);
    }
}
CS
git -C "$W" add -A; git -C "$W" commit -qm base
SNAP=$(git -C "$W" rev-parse HEAD)

echo "Gate 2: rojos"
OUT_PRE=$'  failed X.Tests.GuardTests.Guarda_Inventario (5ms)\nTest run summary: Failed!\n'
LIST=$(preexisting_red_only "$W" "$SNAP" "$OUT_PRE"); rc=$?
[ "$rc" -eq 0 ] && echo "$LIST" | grep -q '^Guarda_Inventario' && ok "solo preexistentes: continua (rc 0)" || bad "solo preexistentes rc=$rc"
OUT_NEW="$OUT_PRE"$'  failed X.Tests.NuevosTests.Nuevo_Rojo (1ms)\n'
preexisting_red_only "$W" "$SNAP" "$OUT_NEW" >/dev/null; rc=$?
[ "$rc" -eq 1 ] && ok "un rojo nuevo: aborta (rc 1)" || bad "rojo nuevo rc=$rc"
preexisting_red_only "$W" "$SNAP" "basura" >/dev/null; rc=$?
[ "$rc" -eq 2 ] && ok "analisis falla: aborta (rc 2)" || bad "basura rc=$rc"

echo "Reviewer toca tests"
BASE=$(git -C "$W" rev-parse HEAD)
list_reviewer_touched_tests "$W" "$BASE" | grep -q . && bad "sin cambios no deberia listar" || ok "sin tests tocados: lista vacia"
sed -i.bak 's/28/29/' "$W/tests/X.Tests/GuardTests.cs"; rm -f "$W/tests/X.Tests/GuardTests.cs.bak"
git -C "$W" commit -qam "reviewer ajusta guarda"
FILES=$(list_reviewer_touched_tests "$W" "$BASE")
[ "$FILES" = "tests/X.Tests/GuardTests.cs" ] && ok "tests modificados detectados por diff" || bad "files='$FILES'"

echo "Seccion del PR de tests ajustados"
[ -z "$(render_reviewer_touched_tests_section "" false)" ] && ok "sin archivos: salida vacia" || bad "sin archivos imprime"
TWO=$'tests/A.Tests/ATests.cs\ntests/B.Tests/BTests.cs'
SEC=$(render_reviewer_touched_tests_section "$TWO" false)
echo "$SEC" | grep -qF '## Tests ajustados por el reviewer' && ok "encabezado presente" || bad "encabezado"
[ "$(echo "$SEC" | grep -c '^- `')" -eq 2 ] && echo "$SEC" | grep -qF -- '- `tests/A.Tests/ATests.cs`' && ok "una linea por archivo" || bad "lineas por archivo"
echo "$SEC" | grep -qF 'destrabar' && bad "sin destrabe no debe incluir la linea extra" || ok "sin linea de destrabe"
SEC2=$(render_reviewer_touched_tests_section "$TWO" true)
echo "$SEC2" | grep -qF 'destrabar tests en rojo despues de la fase verde' && ok "blockage_resolved=true agrega la linea extra" || bad "linea de destrabe"

echo "Resultado: $PASS pass, $FAIL fail"; [ "$FAIL" -eq 0 ]
