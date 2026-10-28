#!/usr/bin/env bash
# test-http-smoke-consumers.sh — helper list_smokes_invoking_routes (issue #2480).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0; FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS+1)); }
ko() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

eval "$(sed -n '/^list_smokes_invoking_routes()/,/^}$/p' "$REPO_ROOT/scripts/_pipeline-common.sh")"

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/src/N.Programacion/F/AgregarFranja" "$W/src/N.Colab/F/Listar" "$W/src/N.Colab/F/Bus" \
  "$W/tests/N.Programacion.SmokeTests" "$W/tests/N.Mcp.X.SmokeTests" "$W/tests/N.Otro.SmokeTests"
cat > "$W/src/N.Programacion/F/AgregarFranja/FunctionEndpoint.cs" <<'CS'
[Function("A")] public Task R([HttpTrigger(AuthorizationLevel.Function, "post", Route = "programacion/turnos/{id}:agregar-franja")] HttpRequest r) => null;
CS
cat > "$W/src/N.Colab/F/Listar/FunctionEndpoint.cs" <<'CS'
[Function("L")] public Task R([HttpTrigger(AuthorizationLevel.Function, "get", Route = "colaboradores")] HttpRequest r) => null;
CS
cat > "$W/src/N.Colab/F/Bus/FunctionEndpoint.cs" <<'CS'
[Function("B")] public Task R([ServiceBusTrigger("t", "s")] string m) => null;
CS
cat > "$W/tests/N.Otro.SmokeTests/Literal.cs" <<'CS'
await c.PostAsJsonAsync($"/api/programacion/turnos/{id}:agregar-franja", b);
await c.GetAsync("/api/Colaboradores");
CS
cat > "$W/tests/N.Mcp.X.SmokeTests/Mcp.cs" <<'CS'
await c.PostAsJsonAsync("/api/programacion/turnos/abc:agregar-franja", b);
CS
cat > "$W/tests/N.Programacion.SmokeTests/Compuesta.cs" <<'CS'
private const string RutaTurnos = "/api/programacion/turnos";
await c.PostAsJsonAsync($"{RutaTurnos}/{turnoId}:agregar-franja", b);
CS
cat > "$W/tests/N.Programacion.SmokeTests/Otra.cs" <<'CS'
await c.GetAsync($"/api/programacion/turnos/{id}");
CS

OUT=$(list_smokes_invoking_routes "$W" src/N.Programacion/F/AgregarFranja/FunctionEndpoint.cs src/N.Colab/F/Listar/FunctionEndpoint.cs src/N.Colab/F/Bus/FunctionEndpoint.cs)
R1='programacion/turnos/{id}:agregar-franja'
for f in tests/N.Otro.SmokeTests/Literal.cs tests/N.Mcp.X.SmokeTests/Mcp.cs tests/N.Programacion.SmokeTests/Compuesta.cs; do
    printf '%s\n' "$OUT" | grep -qxF "$R1"$'\t'"$f" && ok "lista $f" || ko "lista $f"
done
printf '%s\n' "$OUT" | grep -qxF "colaboradores"$'\t'"tests/N.Otro.SmokeTests/Literal.cs" && ok "mayusculas distintas" || ko "mayusculas distintas"
printf '%s\n' "$OUT" | grep -q "Otra.cs" && ko "ruta {id} no se lista" || ok "ruta {id} no se lista"
[ "$(printf '%s\n' "$OUT" | grep -c .)" = 4 ] && ok "total 4 lineas" || ko "total 4 lineas"
[ -z "$(list_smokes_invoking_routes "$W" src/N.Colab/F/Bus/FunctionEndpoint.cs)" ] && ok "sin Route no aporta" || ko "sin Route no aporta"

echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
