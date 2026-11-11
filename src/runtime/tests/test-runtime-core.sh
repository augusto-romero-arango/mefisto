#!/usr/bin/env bash
# Resolucion de runtime y adaptador fake en bash. El runner y las gemelas TypeScript se prueban
# en los *.test.mts de esta carpeta.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RESOLVER="$ROOT/src/runtime/lib/mefisto-runtime.sh"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Discovery abierto: los ids salen de archivos y la disponibilidad de probes.
LIBS="$TMP/libs"; mkdir -p "$LIBS"
cat > "$LIBS/runtime-alpha.sh" <<'EOF'
runtime_alpha_is_available() { [ "${ALPHA_AVAILABLE:-}" = 1 ]; }
EOF
cat > "$LIBS/runtime-beta.sh" <<'EOF'
runtime_beta_is_available() { [ "${BETA_AVAILABLE:-}" = 1 ]; }
EOF
unset MEFISTO_RUNTIME
MEFISTO_RUNTIME_LIB_DIR="$LIBS"; source "$RESOLVER"
if mefisto_resolve_runtime "" >/dev/null; then fail "cero disponibles debe fallar"; else case "$MEFISTO_RUNTIME_ERROR" in *alpha*beta*MEFISTO_RUNTIME*) pass ;; *) fail "cero no lista ids y accion" ;; esac; fi
ALPHA_AVAILABLE=1
mefisto_resolve_runtime "" >/dev/null && [ "$MEFISTO_RESOLVED_RUNTIME" = alpha ] && pass || fail "probe unico"
BETA_AVAILABLE=1
if mefisto_resolve_runtime "" >/dev/null; then fail "varios disponibles debe fallar"; else case "$MEFISTO_RUNTIME_ERROR" in *alpha*beta*desambiguar*) pass ;; *) fail "varios no lista ids" ;; esac; fi
unset ALPHA_AVAILABLE BETA_AVAILABLE
MEFISTO_RUNTIME=beta; mefisto_resolve_runtime alpha >/dev/null && [ "$MEFISTO_RESOLVED_RUNTIME" = alpha ] && pass || fail "explicito gana"
mefisto_resolve_runtime "" >/dev/null && [ "$MEFISTO_RESOLVED_RUNTIME" = beta ] && pass || fail "entorno gana"
unset MEFISTO_RUNTIME MEFISTO_RUNTIME_LIB_DIR

# El fake modela la capacidad opcional de refresh de forma conservadora: sin
# variable no soporta el contrato; un valor explicito se reenvia sin alterar.
source "$ROOT/src/runtime/lib/runtime-fake.sh"
unset MEFISTO_FAKE_INTERACTIVE_REFRESH
if runtime_fake_interactive_refresh > "$TMP/fake-refresh-absent" 2>/dev/null; then
    fail "fake refresh ausente debe retornar 1"
elif [ -s "$TMP/fake-refresh-absent" ]; then
    fail "fake refresh ausente no debe imprimir"
else
    pass
fi
MEFISTO_FAKE_INTERACTIVE_REFRESH='prompt /fake-refresh'
printf '%s\n' 'prompt /fake-refresh' > "$TMP/fake-refresh-expected"
if runtime_fake_interactive_refresh > "$TMP/fake-refresh-actual" \
    && cmp -s "$TMP/fake-refresh-expected" "$TMP/fake-refresh-actual"; then
    pass
else
    fail "fake refresh explicito debe reenviar el valor literal"
fi
unset MEFISTO_FAKE_INTERACTIVE_REFRESH

# Un runtime explicito sin adaptador falla, y el fake resuelve contra la libreria real.
MEFISTO_RUNTIME_LIB_DIR="$LIBS"
if mefisto_resolve_runtime bogus >/dev/null; then fail "explicito sin adaptador debe fallar"; else case "$MEFISTO_RUNTIME_ERROR" in *bogus*"$LIBS/runtime-bogus.sh"*) pass ;; *) fail "sin adaptador no cita runtime y ruta" ;; esac; fi
MEFISTO_RUNTIME_LIB_DIR="$ROOT/src/runtime/lib"
mefisto_resolve_runtime fake >/dev/null && [ "$MEFISTO_RESOLVED_RUNTIME" = fake ] && pass || fail "fake contra la libreria real"
unset MEFISTO_RUNTIME_LIB_DIR

echo "RESULTADO runtime comun: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
