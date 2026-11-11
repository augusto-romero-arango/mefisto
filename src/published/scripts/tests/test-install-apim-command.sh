#!/usr/bin/env bash
# Bloques bash del comando install-apim publicado, ejecutados tal como salen en
# dist/claude: el flip de tenancy del paso 9.2 y la deteccion de servidores MCP
# del paso 2b. Lo que se verifica leyendo el texto del comando esta en
# install-apim-command.test.mts.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
CLAUDE="$REPO_ROOT/dist/claude/commands/install-apim.md"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo '[paso 9.2] flip de tenancy ejecutado sobre el _pipeline-common.sh distribuido'
FLIP="$(awk '
    $0 == "#### 9.2 Flip del token" { found=1; next }
    found && /^```bash$/ { inside=1; next }
    found && /^```$/ && inside { exit }
    inside { print }
' "$CLAUDE")"
if [ -z "$FLIP" ]; then
    fail 'no se pudo extraer el bloque del paso 9.2'
else
    export MEFISTO_PACKAGE_ROOT="$REPO_ROOT/dist/claude"
    mk_repo() {
        local repo="$1"
        mkdir -p "$repo"; git -C "$repo" init -q
    }
    cfg() {
        jq -n --arg s "$2" '{projectName:"Ejemplo", namespacePrefix:"Ejemplo", solutionFile:"Ejemplo.slnx", domainLabels:["ventas"], boundedContext:{name:"Principal", domains:["ventas"]}, tenancy:{strategy:$s, extra:"keep"}}' > "$1"
    }
    run_flip() { (cd "$1" && bash -c "$FLIP") >"$2" 2>&1; }

    R1="$WORK/canonico"; mk_repo "$R1"; mkdir -p "$R1/.mefisto"; cfg "$R1/.mefisto/harness.config.json" mono-tenant-transitorio
    if run_flip "$R1" "$WORK/r1.out" && jq -e '.tenancy.strategy == "multi-tenant-header" and .tenancy.extra == "keep" and .projectName == "Ejemplo"' "$R1/.mefisto/harness.config.json" >/dev/null; then pass 'voltea tenancy.strategy en el canonico y preserva los demas campos'; else fail "no volteo el canonico: $(cat "$WORK/r1.out")"; fi
    before="$(cat "$R1/.mefisto/harness.config.json")"
    if run_flip "$R1" "$WORK/r1b.out" && grep -qF 'ya esta en etapa (b)' "$WORK/r1b.out" && [ "$before" = "$(cat "$R1/.mefisto/harness.config.json")" ]; then pass 'segunda corrida es idempotente'; else fail "no es idempotente: $(cat "$WORK/r1b.out")"; fi

    R2="$WORK/legacy"; mk_repo "$R2"; mkdir -p "$R2/.claude"; cfg "$R2/.claude/harness.config.json" mono-tenant-transitorio
    before="$(cat "$R2/.claude/harness.config.json")"
    if run_flip "$R2" "$WORK/r2.out"; then fail 'no aborto con solo el legacy'; elif grep -qF 'todavía es legacy' "$WORK/r2.out" && [ "$before" = "$(cat "$R2/.claude/harness.config.json")" ] && [ ! -e "$R2/.mefisto/harness.config.json" ]; then pass 'aborta con solo el legacy sin modificarlo ni crear el canonico'; else fail "manejo incorrecto del legacy: $(cat "$WORK/r2.out")"; fi
fi

echo '[paso 2b] deteccion de servidores MCP desde instructions-path'
MCP_BLOCK="$(awk '
    index($0, "### 2b. Detectar los servidores MCP del BC") == 1 { found=1; next }
    found && /^```bash$/ { inside=1; next }
    found && /^```$/ && inside { exit }
    inside { print }
' "$CLAUDE")"
R3="$WORK/mcp"; mkdir -p "$R3/src/Ejemplo.Principal.Mcp.Reportes"
printf 'RootNamespace: Ejemplo.Principal\n' > "$R3/AGENTS.md"
out="$(cd "$R3" && MEFISTO_INSTRUCTIONS_PATH=AGENTS.md bash -c "$MCP_BLOCK"$'\n''printf "%s|%s" "$ROOT_NAMESPACE" "$SERVIDORES_MCP"' 2>&1)"
[ "$out" = 'Ejemplo.Principal|Reportes' ] && pass 'detecta los servidores MCP con el RootNamespace de instructions-path' || fail "deteccion MCP inesperada: $out"

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
