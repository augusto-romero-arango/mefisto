// Contrato del agente infra-base-scaffolder neutral y su proyeccion publicada (issue #1649), con
// el gate greenfield y el workflow nuget-audit.yml que el agente embebe ejecutados con bash.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { resolveCommand } from '../../../../scripts/lib/cli.mts'
import { NO_BASH, runBashBlock, writeTree } from '../../../../scripts/tests/markdown-bash.mts'
import {
  assertContains,
  fencedBlocks,
  fromLine,
  lineOf,
  linesOf,
  repoPath,
} from '../../../../scripts/tests/text-contract.mts'
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

describe('[d] nuget-audit.yml: gate greenfield y decision del Paso 2b.1, ejecutados con bash', { skip: NO_BASH }, () => {
  const gate = fencedBlocks(fromLine(AGENT.source, /^\*\*Gate greenfield de la auditoria NuGet/), 'bash')[0] ?? ''
  const decide = fencedBlocks(fromLine(AGENT.source, /^## Paso 2b.1/), 'bash')[0] ?? ''
  let work = ''

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto nuget gate ')))
    writeTree(join(work, 'green'))
    writeTree(join(work, 'cd'), { '.github/workflows/infra-cd.yml': '' })
    writeTree(join(work, 'env'), { 'infra/environments/dev/main.tf': '' })
    writeTree(join(work, 'idem'), { '.github/workflows/nuget-audit.yml': '' })
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  const runGate = (name: string): string => runBashBlock(gate, join(work, name)).output
  const runDecide = (name: string, value: 'si' | 'no'): string =>
    runBashBlock(decide.replace('<si|no>', value), join(work, name)).output

  test('gate: repo vacio es greenfield', () => {
    assertContains(runGate('green'), 'NUGET_AUDIT_GREENFIELD=si')
  })

  test('gate: infra-cd.yml o environments/*/main.tf previos marcan ya inicializado', () => {
    assertContains(runGate('cd'), 'NUGET_AUDIT_GREENFIELD=no')
    assertContains(runGate('env'), 'NUGET_AUDIT_GREENFIELD=no')
  })

  test('reejecucion sobre consumidor inicializado sin nuget-audit.yml no lo agrega', () => {
    assertContains(runDecide('cd', 'no'), 'ya inicializado al comenzar')
    assert.equal(existsSync(join(work, 'cd', '.github', 'workflows', 'nuget-audit.yml')), false)
  })

  test('idempotencia: nuget-audit.yml existente no se sobrescribe', () => {
    assertContains(runDecide('idem', 'si'), 'no se sobrescribe')
  })

  test('greenfield prepara .github/workflows', () => {
    runDecide('green', 'si')
    assert.ok(existsSync(join(work, 'green', '.github', 'workflows')))
  })
})

// El paso del workflow corre en ubuntu-latest con jq; aqui se ejecuta con un `dotnet` falso.
const NO_AUDIT_SHELL =
  NO_BASH ||
  (process.platform === 'win32' && 'el workflow corre en ubuntu-latest') ||
  (resolveCommand('jq') === null && 'requiere jq')

describe('[d] nuget-audit.yml: el paso de auditoria, ejecutado con un dotnet falso', { skip: NO_AUDIT_SHELL }, () => {
  const workflow = fencedBlocks(fromLine(AGENT.source, /^## Paso 2b.1/), 'yaml')[0] ?? ''
  const runLines = linesOf(workflow)
  const runAt = runLines.indexOf('        run: |')
  const audit = runLines
    .slice(runAt + 1)
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
  const STUB = `#!/usr/bin/env bash
case "$STUB_MODE" in
    fail) echo boom >&2; exit 1 ;;
    garbage) echo 'no-json'; exit 0 ;;
    clean) echo '{"version":1,"projects":[{"path":"x","frameworks":[{"framework":"net10.0","topLevelPackages":[{"id":"A","resolvedVersion":"1.0.0"}]}]}]}' ;;
    vuln) echo '{"version":1,"projects":[{"path":"x","frameworks":[{"framework":"net10.0","topLevelPackages":[{"id":"Marten","resolvedVersion":"9.12.0","vulnerabilities":[{"severity":"High","advisoryurl":"https://github.com/advisories/GHSA-x"}]}],"transitivePackages":[{"id":"Otel|<b>","resolvedVersion":"1.14.0","vulnerabilities":[{"severity":"Moderate","advisoryurl":"https://github.com/advisories/GHSA-y"}]}]}]}]}' ;;
esac
`
  let work = ''
  let bin = ''

  before(() => {
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto nuget audit ')))
    bin = join(work, 'bin')
    writeTree(bin, { dotnet: STUB })
    chmodSync(join(bin, 'dotnet'), 0o755)
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  /** Resumen del job y codigo de salida del paso. */
  function runAudit(mode: string, withSolution: boolean): { summary: string; status: number | null } {
    const dir = writeTree(join(work, `run-${mode}-${withSolution ? 'si' : 'no'}`), {
      'AGENTS.md': '- **SolutionFile**: App.slnx\n',
      ...(withSolution ? { 'App.slnx': '' } : {}),
    })
    const summary = join(dir, 'summary.md')
    const result = runBashBlock(`PATH="${bin}:$PATH"\n${audit}`, dir, {
      STUB_MODE: mode,
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: summary,
    })
    return { summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '', status: result.status }
  }

  test('se extrae el run: del paso de auditoria', () => {
    assert.ok(runAt !== -1 && audit.includes('dotnet package list'))
  })

  test('un resultado vulnerable lista directos y transitivos saneados y termina en success', () => {
    const { summary, status } = runAudit('vuln', true)
    assertContains(summary, 'Marten | 9.12.0 | High | https://github.com/advisories/GHSA-x')
    assertContains(summary, '1.14.0 | Moderate')
    assert.ok(!summary.includes('<b>'), 'datos del escaneo sin sanear')
    assert.equal(status, 0)
  })

  test('un resultado limpio se informa y termina en success', () => {
    const { summary, status } = runAudit('clean', true)
    assertContains(summary, 'Sin advisories')
    assert.equal(status, 0)
  })

  test('una falla de dotnet es no verificable, no se confunde con limpio y no bloquea', () => {
    const { summary, status } = runAudit('fail', true)
    assertContains(summary, 'no verificada')
    assert.ok(!summary.includes('Sin advisories'))
    assert.equal(status, 0)
  })

  test('un parseo fallido es no verificable', () => {
    assertContains(runAudit('garbage', true).summary, 'no verificada')
  })

  test('sin solucion es no verificable y no bloquea', () => {
    const { summary, status } = runAudit('clean', false)
    assertContains(summary, 'no verificada')
    assert.equal(status, 0)
  })
})
