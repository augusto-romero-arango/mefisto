#!/usr/bin/env bash
# Contrato del agente mcp-scaffolder neutral y su proyeccion publicada (issue #1661).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/mcp-scaffolder.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/mcp-scaffolder.md"
MIRROR="$REPO_ROOT/agents/mcp-scaffolder.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[a] metadata y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "mcp-scaffolder" and .mode == "all" and .profile == "balanced" and .capabilities == ["read","edit","shell"] and (has("mcp") | not)' >/dev/null; then
    pass 'metadata agent/mcp-scaffolder/all/balanced/read-edit-shell sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:config-path}}' 'lee el config via config-path'
contains "$body" '{{mefisto:instructions-path}}' 'lee los tokens via instructions-path'
contains "$body" '{{mefisto:command onboard}}' 'remite al contrato via command onboard'

echo '[b] ausencia de acoplamientos'
absent "$body" '.claude/harness.config.json' 'sin config legacy'
absent "$body" 'export MEFISTO_INSTRUCTIONS_PATH' 'sin export de instrucciones'
absent "$body" 'claude --agent' 'sin invocacion directa del CLI'
absent "$body" 'CLAUDE.md' 'sin resolucion manual de directivas'
echo '[salidas]'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'name: "mcp-scaffolder"' 'Claude expone el id'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa balanced como sonnet'
absent "$claude_body" 'export MEFISTO_INSTRUCTIONS_PATH="AGENTS.md"' 'claude_body sin resolucion manual fija'

echo '[identidad] identidad derivada del token (issue #1934)'
contains "$body" 'internal async Task Ejecutar(' 'CA-1/2: IdentidadTenantMcpMiddleware con nucleo testeable'
contains "$body" 'tool.TryGetHttpTransport(out var transporte)' 'CA-1: lee el Bearer del transporte de ToolInvocationContext'
contains "$body" 'DerivadorIdentidadTenantMcp' 'CA-1: derivador org_id/sub'
contains "$body" 'builder.UseMiddleware<IdentidadTenantMcpMiddleware>();' 'CA-1: Program.cs registra el middleware de identidad'
contains "$body" 'despues de AutorizacionMcpMiddleware' 'CA-1: orden tras AutorizacionMcpMiddleware'
contains "$body" '<ProjectReference Include="..\<RootNamespace>.TenantResolver\' 'CA-1: ProjectReference a TenantResolver'
contains "$body" 'public async Task<ClaimsPrincipal?> ValidarAsync(' 'CA-1: validador expone el ClaimsPrincipal'
contains "$body" 'TenantExecutionContext.SetDerivedIdentity(' 'CA-2: publica identidad ambiente'
contains "$body" 'items[SesionUsuario.ClaveEnContexto]' 'CA-2: publica la sesion'
contains "$body" 'ErrorTokenSinOrganizacionOUsuario' 'CA-2: rechazo con mensaje resx'
contains "$body" 'Fallback explicito del camino SIN Bearer' 'CA-3: fallback explicito'
absent "$body" 'TODO(tenancy etapa b' 'CA-3: sin TODO de identidad derivada'
absent "$body" 'llegan a este worker SIN header Authorization' 'CA-3: ya no afirma que el Authorization nunca llega'
contains "$body" 'internal const string NombreTool = "obtener_sesion";' 'CA-4: tool obtener_sesion'
contains "$body" '"tenant_fijo"' 'CA-4: origen tenant_fijo'
contains "$body" 'Ejecutar_PublicaIdentidadAmbienteYSesion_CuandoElBearerEsValido' 'CA-5: test del middleware publica identidad y sesion'
contains "$body" 'Ejecutar_Rechaza_CuandoElTokenNoTraeOrgIdOSub' 'CA-5: rechazo sin org_id/sub'
contains "$body" 'principal.FindFirst("organization_membership_id")' '#2398 CA-1: derivador lee organization_membership_id'
contains "$body" 'string.IsNullOrWhiteSpace(membership)' '#2398 CA-1: membership requerida'
absent "$body" 'es extension local del consumidor.' '#2398 CA-1: membership ya no es extension local'
contains "$body" 'derivada.Identidad.OrganizationMembershipId);' '#2398 CA-2: SetDerivedIdentity de tres argumentos'
contains "$body" 'SetDerivedIdentity(null, null, null);' '#2398 CA-2: limpieza con tres null'
absent "$body" 'SetDerivedIdentity(null, null);' '#2398 CA-2: sin firma de dos argumentos'
contains "$body" 'TryAddWithoutValidation("X-Organization-Membership-Id"' '#2398 CA-3: propagador agrega X-Organization-Membership-Id'
contains "$body" 'faltan los claims org_id, sub u organization_membership_id' '#2398 CA-4: error nombra los tres claims'
contains "$body" 'Identidad__OrganizationMembershipIdInterino = "mcp-sin-membership-autenticada"' '#2398: Terraform declara la membership interina del camino sin Bearer'
contains "$body" 'ObtenerSesionTool.NombreTool' 'CA-5: composicion pinnea obtener_sesion'
contains "$body" 'ObtenerSesion_Responde_TenantFijo_CuandoSeInvocaConSystemKeySinBearer' 'CA-6: smoke obtener_sesion'

echo '[c] guia de onboarding'
contains "$body" 'az functionapp keys list' 'la guia de onboarding conserva az functionapp keys list'

echo '[d] mirror'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror identico a dist/claude'; else fail 'mirror diverge'; fi
if jq -e '.assets[] | select(.destination == "agents/mcp-scaffolder.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then
    pass 'claude inventaria el agente'
else
    fail 'claude no inventaria el agente'
fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check al dia'; else fail '--check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
