#!/usr/bin/env bash
# Verifica que la clausura publicada permite arrancar TDD desde un consumidor.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

SCANNER="$WORK/scan-closure.py"
cat > "$SCANNER" <<'PY'
import pathlib
import posixpath
import re
import sys

generator = pathlib.Path(sys.argv[1]).read_text()
pipeline_path = pathlib.Path(sys.argv[2])

array = re.search(r'^TOOLING_CLOSURE_ASSETS=\(\n(.*?)^\)', generator, re.M | re.S)
if not array:
    print('no se pudo leer TOOLING_CLOSURE_ASSETS del generador')
    raise SystemExit(2)
declared = {
    match.group(1)
    for match in re.finditer(r"^\s*'([^'|]+)\|(?:0644|0755)'\s*$", array.group(1), re.M)
}

bases = {
    'SCRIPT_DIR': 'scripts',
    'RUNTIME_DIR': 'src/runtime',
    'RUNTIME_LIB_DIR': 'src/runtime/lib',
}
references = set()
for raw_line in pipeline_path.read_text().splitlines():
    line = raw_line.lstrip()
    if not line or line.startswith('#'):
        continue
    if line.startswith('source ') and 'dirname ' in line:
        match = re.search(r'\)["\']?/([A-Za-z0-9_./-]+\.(?:sh|jq))', line)
        if match:
            references.add(posixpath.normpath('scripts/' + match.group(1)))
    for match in re.finditer(r'\$\{?(SCRIPT_DIR|RUNTIME_DIR|RUNTIME_LIB_DIR)\}?/([A-Za-z0-9_./-]+\.(?:sh|jq))', line):
        references.add(posixpath.normpath(bases[match.group(1)] + '/' + match.group(2)))

missing = sorted(reference for reference in references if reference not in declared)
if missing:
    print('\n'.join(missing))
    raise SystemExit(1)
if len(references) < 4:
    print(f'el barrido solo reconocio {len(references)} dependencias; se esperaban al menos 4')
    raise SystemExit(2)
print(len(references))
PY

assert_dependency_closure() {
    local pipeline="$1" output rc=0
    output="$(python3 "$SCANNER" "$REPO_ROOT/src/published/scripts/generate-published-adapters.sh" "$pipeline")" || rc=$?
    if [ "$rc" -eq 0 ]; then
        pass "${pipeline##*/} solo referencia dependencias declaradas en la clausura ($output verificadas)"
    else
        fail "${pipeline##*/} referencia assets fuera de TOOLING_CLOSURE_ASSETS: $output"
    fi
}

echo '[pre] sintaxis y dependencias de clausura'
if bash -n "$REPO_ROOT/dist/claude/scripts/tdd-pipeline.sh"; then
    pass 'la copia publicada de TDD tiene sintaxis Bash valida'
else
    fail 'la copia publicada de TDD tiene sintaxis Bash invalida'
fi
assert_dependency_closure "$REPO_ROOT/scripts/tdd-pipeline.sh"
assert_dependency_closure "$REPO_ROOT/scripts/tooling-pipeline.sh"

CONSUMER="$WORK/consumidor"
mkdir -p "$CONSUMER/.mefisto"
git -C "$CONSUMER" init -q
cat > "$CONSUMER/.mefisto/harness.config.json" <<'EOF'
{
  "projectName": "Consumidor",
  "namespacePrefix": "Consumidor",
  "solutionFile": "Consumidor.sln",
  "domainLabels": ["ventas"],
  "boundedContext": {"name": "Ventas", "domains": ["ventas"]}
}
EOF
OUTPUT="$(cd "$CONSUMER" && "$REPO_ROOT/dist/claude/scripts/tdd-pipeline.sh" 2>&1)"; RC=$?
if [ "$RC" -eq 1 ] && printf '%s\n' "$OUTPUT" | grep -Fq 'Uso:'; then
    pass 'TDD publicado arranca desde dist/claude y llega al uso sin argumentos'
else
    fail "TDD publicado no llego al uso desde la clausura (exit $RC)"
fi

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
exit "$FAIL"
