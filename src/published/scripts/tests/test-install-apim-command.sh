#!/usr/bin/env bash
# Contrato del comando install-apim neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/install-apim.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/install-apim.md"
MIRROR="$REPO_ROOT/commands/install-apim.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "install-apim" and .profile == "balanced" and .arguments == "--domain <Dominio> [--domain <Dominio2> ...] [--env <env>] [--cors-origin <origin> ...] [--authorization-server-url <url>]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin agent ni capabilities'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:launch-agent apim-gateway-scaffolder ' 'delegacion puntual a apim-gateway-scaffolder'
contains "$body" 'Servidores MCP a exponer:' 'el mensaje conserva los servidores MCP'
contains "$body" 'authorization_server_url' 'el mensaje conserva authorization_server_url'
contains "$body" '"{{mefisto:package-root}}/scripts/_pipeline-common.sh"' 'source de _pipeline-common.sh desde el paquete activo'
contains "$body" '{{mefisto:instructions-path}}' 'RootNamespace se lee de instructions-path'
for cmd in install-workos scaffold scaffold-mcp infra-base onboard; do contains "$body" "{{mefisto:command $cmd}}" "remite a $cmd via command"; done
contains "$body" '{{mefisto:package-root}}/agents/domain-scaffolder.md' 'molde de agente por package-root'
contains "$body" 'ya en etapa (b)' 'flip idempotente'
contains "$body" 'ERROR: el config efectivo todavía es legacy' 'error si el config efectivo es legacy'
for forbidden in 'claude --agent' '.claude/' 'CLAUDE_' '.plugin-root' 'plugins/cache' 'PLUGIN_SCRIPTS' 'PLUGIN_ROOT' 'CLAUDE.md' 'export MEFISTO_INSTRUCTIONS_PATH'; do absent "$body" "$forbidden" "fuente sin token prohibido: $forbidden"; done
order_ok=1; prev=0
for marker in '{{mefisto:assert-consumer-repo}}' '¿Continuar? (s/n)' 'git switch -c "install-apim/' '{{mefisto:launch-agent' 'source "$COMMON"' 'git commit -m "tenancy(a->b)' 'gh pr create'; do
    n="$(line_of "$SOURCE" "$marker")"
    if [ -z "$n" ] || [ "$n" -le "$prev" ]; then order_ok=0; printf '    orden: %s -> %s\n' "$marker" "${n:-ausente}"; fi
    prev="${n:-$prev}"
done
[ "$order_ok" -eq 1 ] && pass 'orden: guard -> confirmacion -> rama -> agente -> flip -> commit -> PR' || fail 'orden de pasos invalido'

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced'
contains "$claude_body" 'agente `mefisto:apim-gateway-scaffolder`' 'Claude delega en mefisto:apim-gateway-scaffolder'
contains "$claude_body" 'source "$COMMON"' 'Claude sourcea _pipeline-common.sh'
contains "$claude_body" 'COMMON="${MEFISTO_PACKAGE_ROOT}/scripts/_pipeline-common.sh"' 'Claude sourcea desde MEFISTO_PACKAGE_ROOT'
for forbidden in 'claude --agent' 'plugins/cache' 'PLUGIN_SCRIPTS'; do absent "$claude_body" "$forbidden" "claude sin token de runtime: $forbidden"; done
contains "$claude_body" '/mefisto:install-workos' 'Claude resuelve command install-workos'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
if grep -qF 'commands/install-apim.md' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json"; then pass 'inventario de dist/claude lo incluye'; else fail 'inventario de dist/claude no lo incluye'; fi

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

n="$(grep -cF 'export MEFISTO_INSTRUCTIONS_PATH' "$CLAUDE")"
[ "$n" -eq 1 ] && pass 'claude resuelve instrucciones solo en el preambulo generado' || fail "claude resuelve instrucciones $n veces"

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

if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
