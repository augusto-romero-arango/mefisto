// Contrato del agente infra-base-scaffolder neutral y su proyeccion publicada (issue #1649).
// La ejecucion del gate greenfield y del workflow nuget-audit.yml que el agente embebe la cubre
// test-infra-base-scaffolder-agent.sh.

import { describe } from 'node:test'

import { fencedBlocks, fromLine, lineOf, repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  generatedMarker,
  inventoriesDestination,
  isRegularFile,
  metadataMatches,
  readInventory,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('infra-base-scaffolder')
const { body, claude: claudeBody } = AGENT

describe('[fuente] (a) metadata y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata declara agent/infra-base-scaffolder/all/balanced/read-edit-shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'infra-base-scaffolder',
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
  contains(body, '{{mefisto:instructions-path}}', 'lee RootNamespace via instructions-path')
  contains(body, '{{mefisto:command onboard}}', 'remite al diagnostico via command onboard')
  contains(
    body,
    '{{mefisto:run register-harness-secret.sh',
    'Paso 2b.0 delega en register-harness-secret.sh via run',
  )
})

describe('[fuente] (b) ausencia de acoplamientos de runtime', () => {
  for (const pattern of [
    'source "$',
    'source "${',
    '_pipeline-common.sh',
    '.plugin-root',
    'plugins/cache',
    'PLUGIN_ROOT',
    'export MEFISTO_INSTRUCTIONS_PATH',
    '.claude/harness.config.json',
    'upsert_harness_secret',
  ]) {
    absent(body, pattern, `fuente no contiene '${pattern}'`)
  }
})

describe('[salidas] adaptador y mirror', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  contains(claudeBody, 'name: "infra-base-scaffolder"', 'Claude expone el id del agente')
  contains(claudeBody, 'model: "sonnet"', 'Claude materializa el perfil balanced como sonnet')
  absent(claudeBody, 'source "${PLUGIN_ROOT', 'claude_body no hace source del script comun')
  absent(claudeBody, '_pipeline-common.sh', 'claude_body no referencia _pipeline-common.sh')
  absent(claudeBody, 'CONFIG="$REPO_ROOT', 'claude_body no reconstruye la ruta del config a mano')
})

describe('[c] Paso 2b.0 invoca el script distribuido con el runtime de su adaptador', () => {
  contains(
    claudeBody,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/register-harness-secret.sh" "marten-connection" "composite" "marten-connection"',
    'Claude registra marten-connection como composite',
  )
  contains(
    claudeBody,
    '"app-insights-connection" "output" "app_insights_connection_string"',
    'se conserva app-insights-connection como output',
  )
  contains(
    claudeBody,
    '"github-secret" "SB_EXTERNAL_COSMOS_CONNECTION_STRING"',
    'se conserva el registro por alias external como github-secret',
  )
})

describe('[d] nuget-audit.yml (issue #1760): gate greenfield y workflow generado', () => {
  contains(body, 'NUGET_AUDIT_GREENFIELD=si', 'Paso 0 calcula el gate greenfield')
  const gateLine = lineOf(AGENT.source, /NUGET_AUDIT_GREENFIELD=si$/)
  const firstWrite = lineOf(AGENT.source, /^## Paso 1 - Generar/)
  check(
    'el gate se calcula antes de escribir el esqueleto',
    () => gateLine > 0 && firstWrite > 0 && gateLine < firstWrite,
    'el gate no precede a la escritura',
  )
  contains(body, 'nunca sobrescribas', 'nunca sobrescribe nuget-audit.yml')
  contains(body, 'ya inicializado al comenzar', 'omite la auditoria en consumidores ya inicializados')
  contains(
    body,
    'dotnet package list --project "$SOLUTION" --vulnerable --include-transitive --format json --output-version 1',
    'usa dotnet package list sobre la solucion',
  )
  absent(body, '--no-restore --vulnerable', 'no usa --no-restore en la auditoria')
  contains(
    body,
    'NUGET_AUDIT_GREENFIELD=<si|no>',
    'Paso 2b.1 sustituye el valor literal del gate (el shell no persiste)',
  )

  // El punto de `2b.1` es comodin, como en el patron de awk del que viene.
  const workflow = fencedBlocks(fromLine(AGENT.source, /^## Paso 2b.1/), 'yaml')[0] ?? ''
  contains(workflow, 'pull_request:', 'workflow usa pull_request')
  absent(workflow, 'paths', 'workflow sin filtros de rutas')
  absent(workflow, 'id-token', 'workflow sin OIDC')
  absent(workflow, 'secrets.', 'workflow sin secretos')
  contains(workflow, "dotnet-version: '10.0.x'", 'workflow usa SDK .NET 10')
})

describe('[mirror] agents/infra-base-scaffolder.md pasa a generado', () => {
  check(
    'mirror Claude coincide byte a byte',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror Claude diverge',
  )
  contains(AGENT.mirror, generatedMarker(AGENT.id), 'mirror conserva marcador generado')
  check(
    'claude inventaria el agente',
    () => inventoriesDestination(readInventory(), AGENT.mirrorPath),
    'claude no inventaria el agente',
  )
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
