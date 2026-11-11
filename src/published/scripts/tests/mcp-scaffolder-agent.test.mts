// Contrato del agente mcp-scaffolder neutral y su proyeccion publicada (issue #1661).

import { describe } from 'node:test'

import { repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  inventoriesDestination,
  isRegularFile,
  metadataMatches,
  readInventory,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('mcp-scaffolder')
const { body, claude: claudeBody } = AGENT

describe('[a] metadata y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata agent/mcp-scaffolder/all/balanced/read-edit-shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'mcp-scaffolder',
          mode: 'all',
          profile: 'balanced',
          capabilities: ['read', 'edit', 'shell'],
        },
        without: ['mcp'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:config-path}}', 'lee el config via config-path')
  contains(body, '{{mefisto:instructions-path}}', 'lee los tokens via instructions-path')
  contains(body, '{{mefisto:command onboard}}', 'remite al contrato via command onboard')
})

describe('[b] ausencia de acoplamientos', () => {
  absent(body, '.claude/harness.config.json', 'sin config legacy')
  absent(body, 'export MEFISTO_INSTRUCTIONS_PATH', 'sin export de instrucciones')
  absent(body, 'claude --agent', 'sin invocacion directa del CLI')
  absent(body, 'CLAUDE.md', 'sin resolucion manual de directivas')
})

describe('[salidas]', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  contains(claudeBody, 'name: "mcp-scaffolder"', 'Claude expone el id')
  contains(claudeBody, 'model: "sonnet"', 'Claude materializa balanced como sonnet')
  absent(
    claudeBody,
    'export MEFISTO_INSTRUCTIONS_PATH="AGENTS.md"',
    'claude_body sin resolucion manual fija',
  )
})

describe('[identidad] identidad derivada del token (issue #1934)', () => {
  contains(body, 'internal async Task Ejecutar(', 'CA-1/2: IdentidadTenantMcpMiddleware con nucleo testeable')
  contains(body, 'tool.TryGetHttpTransport(out var transporte)', 'CA-1: lee el Bearer del transporte de ToolInvocationContext')
  contains(body, 'DerivadorIdentidadTenantMcp', 'CA-1: derivador org_id/sub')
  contains(body, 'builder.UseMiddleware<IdentidadTenantMcpMiddleware>();', 'CA-1: Program.cs registra el middleware de identidad')
  contains(body, 'despues de AutorizacionMcpMiddleware', 'CA-1: orden tras AutorizacionMcpMiddleware')
  contains(body, '<ProjectReference Include="..\\<RootNamespace>.TenantResolver\\', 'CA-1: ProjectReference a TenantResolver')
  contains(body, 'public async Task<ClaimsPrincipal?> ValidarAsync(', 'CA-1: validador expone el ClaimsPrincipal')
  contains(body, 'TenantExecutionContext.SetDerivedIdentity(', 'CA-2: publica identidad ambiente')
  contains(body, 'items[SesionUsuario.ClaveEnContexto]', 'CA-2: publica la sesion')
  contains(body, 'ErrorTokenSinOrganizacionOUsuario', 'CA-2: rechazo con mensaje resx')
  contains(body, 'Fallback explicito del camino SIN Bearer', 'CA-3: fallback explicito')
  absent(body, 'TODO(tenancy etapa b', 'CA-3: sin TODO de identidad derivada')
  absent(body, 'llegan a este worker SIN header Authorization', 'CA-3: ya no afirma que el Authorization nunca llega')
  contains(body, 'internal const string NombreTool = "obtener_sesion";', 'CA-4: tool obtener_sesion')
  contains(body, '"tenant_fijo"', 'CA-4: origen tenant_fijo')
  contains(body, 'Ejecutar_PublicaIdentidadAmbienteYSesion_CuandoElBearerEsValido', 'CA-5: test del middleware publica identidad y sesion')
  contains(body, 'Ejecutar_Rechaza_CuandoElTokenNoTraeOrgIdOSub', 'CA-5: rechazo sin org_id/sub')
  contains(body, 'principal.FindFirst("organization_membership_id")', '#2398 CA-1: derivador lee organization_membership_id')
  contains(body, 'string.IsNullOrWhiteSpace(membership)', '#2398 CA-1: membership requerida')
  absent(body, 'es extension local del consumidor.', '#2398 CA-1: membership ya no es extension local')
  contains(body, 'derivada.Identidad.OrganizationMembershipId);', '#2398 CA-2: SetDerivedIdentity de tres argumentos')
  contains(body, 'SetDerivedIdentity(null, null, null);', '#2398 CA-2: limpieza con tres null')
  absent(body, 'SetDerivedIdentity(null, null);', '#2398 CA-2: sin firma de dos argumentos')
  contains(body, 'TryAddWithoutValidation("X-Organization-Membership-Id"', '#2398 CA-3: propagador agrega X-Organization-Membership-Id')
  contains(body, 'faltan los claims org_id, sub u organization_membership_id', '#2398 CA-4: error nombra los tres claims')
  contains(body, 'Identidad__OrganizationMembershipIdInterino = "mcp-sin-membership-autenticada"', '#2398: Terraform declara la membership interina del camino sin Bearer')
  contains(body, 'ObtenerSesionTool.NombreTool', 'CA-5: composicion pinnea obtener_sesion')
  contains(body, 'ObtenerSesion_Responde_TenantFijo_CuandoSeInvocaConSystemKeySinBearer', 'CA-6: smoke obtener_sesion')
})

describe('[c] guia de onboarding', () => {
  contains(body, 'az functionapp keys list', 'la guia de onboarding conserva az functionapp keys list')
})

describe('[d] mirror', () => {
  check(
    'mirror identico a dist/claude',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror diverge',
  )
  check(
    'claude inventaria el agente',
    () => inventoriesDestination(readInventory(), AGENT.mirrorPath),
    'claude no inventaria el agente',
  )
  check('generate-published-adapters --check al dia', distributionIsCurrent, '--check detecto divergencias')
})
