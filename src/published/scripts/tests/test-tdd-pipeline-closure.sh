#!/usr/bin/env bash
# Verifica que la clausura publicada permite arrancar TDD desde un consumidor: ejecuta el
# pipeline de dist/claude. Que los pipelines solo referencien assets declarados en la clausura
# esta en tdd-pipeline-closure.test.mts.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo '[pre] sintaxis'
if bash -n "$REPO_ROOT/dist/claude/scripts/tdd-pipeline.sh"; then
    pass 'la copia publicada de TDD tiene sintaxis Bash valida'
else
    fail 'la copia publicada de TDD tiene sintaxis Bash invalida'
fi

CONSUMER="$WORK/consumidor"
mkdir -p "$CONSUMER/.mefisto"
git -C "$CONSUMER" init -q
cat > "$CONSUMER/.mefisto/harness.config.json" <<'JSON'
{
  "projectName": "Consumidor",
  "namespacePrefix": "Consumidor",
  "solutionFile": "Consumidor.sln",
  "domainLabels": ["ventas"],
  "boundedContext": {"name": "Ventas", "domains": ["ventas"]}
}
JSON
OUTPUT="$(cd "$CONSUMER" && "$REPO_ROOT/dist/claude/scripts/tdd-pipeline.sh" 2>&1)"; RC=$?
if [ "$RC" -eq 1 ] && printf '%s\n' "$OUTPUT" | grep -Fq 'Uso:'; then
    pass 'TDD publicado arranca desde dist/claude y llega al uso sin argumentos'
else
    fail "TDD publicado no llego al uso desde la clausura (exit $RC)"
fi

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
exit "$FAIL"
