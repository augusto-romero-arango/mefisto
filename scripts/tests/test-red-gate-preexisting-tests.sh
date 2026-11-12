#!/usr/bin/env bash
# test-red-gate-preexisting-tests.sh -- detect_preexisting_red_tests (issue #1937).
# Cubre: preexistente no modificado en rojo (se reporta), test nuevo en rojo (no),
# preexistente modificado por el test-writer (no) y salida no parseable (degrada, rc 2).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../_pipeline-common.sh
source "$REPO_ROOT/scripts/_pipeline-common.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
W="$TMP/wt"; mkdir -p "$W/tests/X.Dom.Tests"
git -C "$W" init -q -b main
git -C "$W" config user.email t@t; git -C "$W" config user.name t
cat > "$W/tests/X.Dom.Tests/PinTests.cs" <<'CS'
public class PinTests
{
    [Fact]
    public void Pin_NoTocado()
    {
        Assert.Equal(28, Catalogo.Count);
    }

    [Fact]
    public void Pin_Modificado()
    {
        Assert.Equal(28, Catalogo.Count);
    }
}
CS
git -C "$W" add -A; git -C "$W" commit -qm base
SNAP=$(git -C "$W" rev-parse HEAD)
# El test-writer modifica un pin y agrega un test nuevo.
sed -i.bak 's/Pin_Modificado()/Pin_Modificado()/; /Pin_Modificado/,/^    }/ s/28/29/' "$W/tests/X.Dom.Tests/PinTests.cs"; rm -f "$W/tests/X.Dom.Tests/PinTests.cs.bak"
cat >> "$W/tests/X.Dom.Tests/PinTests.cs" <<'CS'
public class NuevosTests
{
    [Fact]
    public void Nuevo_Rojo()
    {
        Assert.True(false);
    }
}
CS

OUT=$'  failed X.Dom.Tests.PinTests.Pin_NoTocado (12ms)\n    Assert.Equal() Failure\n  failed X.Dom.Tests.PinTests.Pin_Modificado (3ms)\n  failed X.Dom.Tests.NuevosTests.Nuevo_Rojo (1ms)\nTest run summary: Failed!\n'
RES=$(detect_preexisting_red_tests "$W" "$SNAP" "$OUT"); rc=$?
[ "$rc" -eq 0 ] && ok "analisis exitoso (rc 0)" || bad "rc=$rc"
echo "$RES" | grep -q '^Pin_NoTocado'$'\t''tests/X.Dom.Tests/PinTests.cs$' && ok "preexistente no modificado se reporta" || bad "no reporto Pin_NoTocado: $RES"
echo "$RES" | grep -q 'Nuevo_Rojo' && bad "test nuevo reportado" || ok "test nuevo no se reporta"
echo "$RES" | grep -q 'Pin_Modificado' && bad "modificado reportado" || ok "preexistente modificado no se reporta"

RES=$(detect_preexisting_red_tests "$W" "$SNAP" "basura sin formato"); rc=$?
[ "$rc" -eq 2 ] && [ -z "$RES" ] && ok "salida no parseable degrada (rc 2)" || bad "no parseable: rc=$rc"
RES=$(detect_preexisting_red_tests "$W" "deadbeef" "$OUT"); rc=$?
[ "$rc" -eq 2 ] && ok "snapshot invalido degrada (rc 2)" || bad "snapshot invalido: rc=$rc"

echo "Resultado: $PASS pass, $FAIL fail"; [ "$FAIL" -eq 0 ]
