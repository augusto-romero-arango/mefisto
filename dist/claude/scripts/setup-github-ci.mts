// Configura la autenticacion de GitHub Actions hacia Azure para que CI aplique infraestructura
// y despliegue codigo (MEF-ADR-0022). Usa OIDC (Workload Identity Federation): crea el Service
// Principal sin secret y le anade los federated credentials que confian en los tokens que GitHub
// emite para la rama main (deploy/apply) y para pull_request (plan). Asigna a nivel suscripcion
// Contributor y Role Based Access Control Administrator con condicion anti-escalacion
// (MEF-ADR-0025), y Storage Blob Data Contributor sobre la Storage del tfstate.
//
// Uso: ./scripts/setup-github-ci.sh <subscription-id> [<owner/repo>]
// Ejemplo: ./scripts/setup-github-ci.sh 50fc1901-9723-4971-9d63-b3f1a015e8b8 acme/mi-proyecto
//
// El slug owner/repo (subject de los federated credentials) se resuelve con 'gh repo view' o el
// remote 'origin'; el 2do argumento lo fuerza. La pareja de Resource Group y Storage Account
// del tfstate sale de backend.tf: correr despues de bootstrap-backend.sh.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Output, chomp, consumerRoot, exitCodeOf, exitWith, parseJson, rawField } from './lib/azure-cli.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, capture, isEntryPoint } from './lib/cli.mts'
import type { CommandResult } from './lib/cli.mts'
import { loadHarnessConfig } from './lib/harness-config.mts'
import {
  azurermBackendLines,
  readBackendResourceGroupName,
  readBackendStorageAccountName,
} from './lib/tfstate-naming.mts'

export interface SetupCiDeps {
  cwd: string
  /** Nombre del script en la linea de uso. */
  program: string
  run: Run
  output: Output
}

export interface BackendPair {
  resourceGroup: string
  storage: string
}

const ISSUER = 'https://token.actions.githubusercontent.com'
const AUDIENCE = 'api://AzureADTokenExchange'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * La pareja durable del backend, leida de `infra/environments/<ambiente>/` bajo `cwd`. Solo se
 * acepta un par completo del mismo directorio: leer cada valor de uno distinto mezclaria
 * ambientes, y `backend.tf` es el registro que `terraform init` consume (MEF-ADR-0045).
 */
export function resolveBackendPair(cwd: string): BackendPair {
  const environments = join(cwd, 'infra', 'environments')
  let names: string[] = []
  try {
    names = readdirSync(environments)
      .filter((name) => !name.startsWith('.'))
      .sort()
  } catch {
    // Sin carpeta de ambientes no hay candidatos.
  }

  const pairs: (BackendPair & { dir: string })[] = []
  const problems: string[] = []
  for (const name of names) {
    const path = join(environments, name)
    if (!isDirectory(path)) continue
    const dir = `infra/environments/${name}`
    const backends = azurermBackendLines(path).reduce((total, file) => total + file.count, 0)
    if (backends === 0) {
      problems.push(`${dir}: no contiene un bloque backend azurerm`)
      continue
    }
    if (backends !== 1) {
      problems.push(`${dir}: contiene ${backends} bloques backend azurerm`)
      continue
    }
    const resourceGroup = readBackendResourceGroupName(path)
    const storage = readBackendStorageAccountName(path)
    if (resourceGroup.length === 0 || storage.length === 0) {
      problems.push(`${dir}: resource_group_name y storage_account_name deben ser literales y completos`)
      continue
    }
    pairs.push({ dir, resourceGroup, storage })
  }

  const [pair] = pairs
  if (problems.length === 0 && pairs.length === 1 && pair !== undefined) {
    return { resourceGroup: pair.resourceGroup, storage: pair.storage }
  }
  const message = ['ERROR: no se pudo resolver una unica pareja completa del backend Terraform.']
  if (pairs.length > 0) {
    message.push('  Candidatos completos:')
    for (const candidate of pairs) {
      message.push(`  - ${candidate.dir}|${candidate.resourceGroup}|${candidate.storage}`)
    }
  }
  if (problems.length > 0) {
    message.push('  Candidatos problematicos:', ...problems.map((problem) => `  - ${problem}`))
  }
  if (pairs.length === 0 && problems.length === 0) {
    message.push('  No se encontro un backend azurerm bajo infra/environments/*/.')
  }
  message.push(
    '  Ejecuta scripts/bootstrap-backend.sh para un ambiente o corrige el backend antes de reintentar.',
  )
  throw new CliError(message.join('\n'))
}

/** `owner/repo` de la URL https o ssh de un remote de GitHub. */
export function repoSlugFromRemote(url: string): string {
  return url.replace(/^(https:\/\/[^/]+\/|git@[^:]+:)/, '').replace(/\.git$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function run(argv: string[], deps: SetupCiDeps): number {
  const { output } = deps
  consumerRoot(deps.cwd, [
    'ERROR: scripts/setup-github-ci.sh es del plugin publicado y solo aplica al consumidor.',
    'Mefisto no se despliega a Azure ni necesita Service Principal.',
  ])
  const config = loadHarnessConfig(undefined, { cwd: deps.cwd, warn: (message) => output.err(message) })

  const subscriptionId = argv[0] ?? ''
  if (subscriptionId.length === 0) {
    output.out(`Uso: ${deps.program} <subscription-id> [<owner/repo>]`)
    output.out(`Ejemplo: ${deps.program} 50fc1901-9723-4971-9d63-b3f1a015e8b8 acme/mi-proyecto`)
    return 1
  }
  const spName = config.spName
  const scope = `/subscriptions/${subscriptionId}`

  const backend = resolveBackendPair(deps.cwd)

  const call = (command: string, args: string[]): CommandResult => deps.run(command, args, { cwd: deps.cwd })
  /** `$(cmd 2>/dev/null) || var=""`. */
  const quiet = (command: string, args: string[]): string => {
    const result = call(command, args)
    return result.status === 0 ? chomp(result.stdout) : ''
  }
  /** `$(az ...)`: su fallo termina el script con el codigo de `az`. */
  const azValue = (args: string[]): string => {
    const result = call('az', args)
    output.writeErr(result.stderr)
    if (result.status !== 0) exitWith(result.status)
    return chomp(result.stdout)
  }
  const az = (args: string[]): void => {
    const result = call('az', args)
    output.writeOut(result.stdout)
    output.writeErr(result.stderr)
    if (result.status !== 0) exitWith(result.status)
  }

  // Precedencia del slug: argumento, 'gh repo view' y, si gh no esta autenticado, el remote origin.
  let repoSlug = argv[1] ?? ''
  if (repoSlug.length === 0)
    repoSlug = quiet('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
  if (repoSlug.length === 0) repoSlug = repoSlugFromRemote(quiet('git', ['remote', 'get-url', 'origin']))
  if (repoSlug.length === 0 || repoSlug === 'None') {
    throw new CliError(
      [
        'ERROR: no se pudo resolver el slug owner/repo del repositorio.',
        `Pasalo como 2do argumento (${deps.program} ${subscriptionId} <owner/repo>) o configura un`,
        "remote 'origin' de GitHub / autentica 'gh', y reintenta.",
      ].join('\n'),
    )
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoSlug)) {
    throw new CliError(`ERROR: el repositorio debe tener el formato owner/repo; se recibio '${repoSlug}'.`)
  }

  const metadata = call('gh', ['api', `repos/${repoSlug}`])
  if (metadata.status !== 0) {
    throw new CliError(
      [
        `ERROR: no se pudo consultar la metadata de GitHub para '${repoSlug}'.`,
        "  Autentica 'gh' con acceso al repositorio o verifica el argumento owner/repo antes de reintentar.",
      ].join('\n'),
    )
  }
  const repository = parseJson(metadata.stdout)?.value
  const metadataSlug = rawField(repository, 'full_name')
  const ownerId = rawField(repository, 'owner', 'id')
  const repositoryId = rawField(repository, 'id')
  if (metadataSlug !== repoSlug) {
    throw new CliError(
      [
        `ERROR: GitHub devolvio metadata de '${metadataSlug.length > 0 ? metadataSlug : 'un repositorio desconocido'}', no de '${repoSlug}'.`,
        '  Verifica el argumento owner/repo, el remote origin y la autenticacion de gh antes de reintentar.',
      ].join('\n'),
    )
  }
  if (!/^[1-9][0-9]*$/.test(ownerId) || !/^[1-9][0-9]*$/.test(repositoryId)) {
    throw new CliError(
      [
        `ERROR: la metadata de GitHub para '${repoSlug}' no contiene IDs inmutables validos de owner y repositorio.`,
        `  Verifica que 'gh api repos/${repoSlug}' pueda leer .owner.id e .id antes de reintentar.`,
      ].join('\n'),
    )
  }

  // El subject inmutable intercala los IDs en el componente del repositorio:
  // `repo:<owner>@<owner_id>/<repo>@<repository_id>:<contexto>`.
  // Fuentes: https://docs.github.com/en/actions/reference/security/oidc y
  // https://learn.microsoft.com/entra/workload-id/workload-identities-github-immutable-subjects
  const slash = metadataSlug.indexOf('/')
  const immutableRepository = `${metadataSlug.slice(0, slash)}@${ownerId}/${metadataSlug.slice(slash + 1)}@${repositoryId}`
  const subjectMain = `repo:${immutableRepository}:ref:refs/heads/main`
  const subjectPr = `repo:${immutableRepository}:pull_request`

  output.out('Fijando la suscripcion activa...')
  const selected = call('az', ['account', 'set', '--subscription', subscriptionId])
  output.writeOut(selected.stdout)
  output.writeErr(selected.stderr)
  if (selected.status !== 0) {
    throw new CliError(
      [
        `ERROR: no se pudo fijar la suscripcion '${subscriptionId}'.`,
        "  Verifica que 'az login' este hecho y que la suscripcion exista.",
      ].join('\n'),
    )
  }

  output.out(`=== Setup CI para ${config.projectName} ===`)
  output.out(`Repositorio GitHub: ${repoSlug}`)
  output.out('')

  output.out(`Resolviendo aplicacion de Entra '${spName}'...`)
  let appId = quiet('az', [
    'ad',
    'app',
    'list',
    '--display-name',
    spName,
    '--query',
    '[0].appId',
    '-o',
    'tsv',
  ])
  if (appId.length === 0 || appId === 'None') {
    output.out(`Creando aplicacion '${spName}'...`)
    appId = azValue(['ad', 'app', 'create', '--display-name', spName, '--query', 'appId', '-o', 'tsv'])
  } else {
    output.out(`La aplicacion ya existe (appId ${appId}); se reutiliza.`)
  }

  if (call('az', ['ad', 'sp', 'show', '--id', appId]).status !== 0) {
    output.out(`Creando service principal para appId ${appId}...`)
    az(['ad', 'sp', 'create', '--id', appId, '-o', 'none'])
  }
  const spObjectId = azValue(['ad', 'sp', 'show', '--id', appId, '--query', 'id', '-o', 'tsv'])
  const tenantId = azValue(['account', 'show', '--query', 'tenantId', '-o', 'tsv'])

  // Asignar por object-id y principal-type evita el race de replicacion del SP recien creado
  // en Microsoft Graph.
  const assignRole = (role: string, roleScope: string, extra: string[] = []): void => {
    az([
      'role',
      'assignment',
      'create',
      '--assignee-object-id',
      spObjectId,
      '--assignee-principal-type',
      'ServicePrincipal',
      '--role',
      role,
      '--scope',
      roleScope,
      ...extra,
      '-o',
      'none',
    ])
  }

  output.out(`Asignando Contributor en ${scope}...`)
  assignRole('Contributor', scope)

  // Contributor excluye 'Microsoft.Authorization/roleAssignments/write', asi que sin este rol
  // el apply de CI falla al crear los role assignments de los scaffolders (MEF-ADR-0025). Es
  // el rol de menor privilegio para delegarlos, y la condicion ABAC impide que el SP asigne
  // Owner, User Access Administrator o este mismo rol.
  // Fuentes: learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-overview
  // y learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-examples
  // Los IDs se resuelven por nombre: los GUIDs no coinciden entre nubes.
  const roleDefinitionId = (name: string): string => {
    const result = call('az', [
      'role',
      'definition',
      'list',
      '--name',
      name,
      '--query',
      '[0].name',
      '-o',
      'tsv',
    ])
    if (result.status !== 0) exitWith(result.status)
    return chomp(result.stdout)
  }
  const ownerRoleId = roleDefinitionId('Owner')
  const userAccessAdminRoleId = roleDefinitionId('User Access Administrator')
  const rbacAdminRoleId = roleDefinitionId('Role Based Access Control Administrator')
  if (ownerRoleId.length === 0 || userAccessAdminRoleId.length === 0 || rbacAdminRoleId.length === 0) {
    throw new CliError(
      [
        'ERROR: no se pudieron resolver los IDs de los roles integrados Owner,',
        "  'User Access Administrator' y/o 'Role Based Access Control Administrator'.",
      ].join('\n'),
    )
  }

  const forbidden = `{${ownerRoleId}, ${rbacAdminRoleId}, ${userAccessAdminRoleId}}`
  const antiEscalation = `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAllValues:GuidNotEquals ${forbidden})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAllValues:GuidNotEquals ${forbidden}))`

  output.out(
    `Asignando Role Based Access Control Administrator (con condicion anti-escalacion) en ${scope}...`,
  )
  assignRole('Role Based Access Control Administrator', scope, [
    '--condition',
    antiEscalation,
    '--condition-version',
    '2.0',
  ])

  // Con el backend keyless por AAD el apply escribe el state y toma su lock: lectura no basta.
  output.out(`Asignando Storage Blob Data Contributor en ${backend.storage}...`)
  assignRole(
    'Storage Blob Data Contributor',
    `${scope}/resourceGroups/${backend.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${backend.storage}`,
  )

  // El subject debe coincidir exacto con el claim del token: no hay patrones para ramas ni tags
  // (MEF-ADR-0022). 'ref:refs/heads/main' lo usan el deploy y el job 'apply'; 'pull_request',
  // el job 'plan', cuyo subject no lleva el ref de la rama.
  // Fuentes: learn.microsoft.com/azure/app-service/deploy-github-actions y
  // learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust.
  const ensureFederatedCredential = (name: string, subject: string, description: string): void => {
    const listed = call('az', ['ad', 'app', 'federated-credential', 'list', '--id', appId, '-o', 'json'])
    output.writeErr(listed.stderr)
    if (listed.status !== 0) {
      throw new CliError(
        `ERROR: no se pudieron inspeccionar las federated credentials de la aplicacion '${appId}'.`,
      )
    }
    const parsed = parseJson(listed.stdout)?.value
    if (!Array.isArray(parsed)) {
      throw new CliError(`ERROR: Azure devolvio una lista invalida de federated credentials para '${appId}'.`)
    }
    const credentials = (parsed as unknown[]).filter(isRecord)
    const managed = credentials.filter((credential) => credential.name === name)
    if (managed.length > 1) {
      throw new CliError(
        `ERROR: Azure devolvio mas de una federated credential con el nombre administrado '${name}'.`,
      )
    }
    const [current] = managed
    if (current !== undefined) {
      const audiences = current.audiences
      const effective =
        current.subject === subject &&
        current.issuer === ISSUER &&
        Array.isArray(audiences) &&
        audiences.length === 1 &&
        audiences[0] === AUDIENCE
      if (effective) {
        output.out(`Federated credential administrada '${name}' ya existe; se reutiliza.`)
        return
      }
    }
    // En una sola linea: un argumento con saltos no sobrevive a `az.cmd` en Windows.
    const parameters = JSON.stringify({ name, issuer: ISSUER, subject, description, audiences: [AUDIENCE] })
    if (current !== undefined) {
      output.out(
        `Reconciliando federated credential administrada '${name}' al subject, issuer y audience efectivos...`,
      )
      az([
        'ad',
        'app',
        'federated-credential',
        'update',
        '--id',
        appId,
        '--federated-credential-id',
        name,
        '--parameters',
        parameters,
        '-o',
        'none',
      ])
      return
    }
    if (credentials.some((credential) => credential.issuer === ISSUER && credential.subject === subject)) {
      throw new CliError(
        [
          `ERROR: una federated credential ajena ya usa el subject efectivo de '${name}'.`,
          `  Renombrala al nombre administrado '${name}' o retirala antes de reintentar; no se modifico automaticamente.`,
        ].join('\n'),
      )
    }
    output.out(`Creando federated credential administrada '${name}' para el subject efectivo...`)
    az([
      'ad',
      'app',
      'federated-credential',
      'create',
      '--id',
      appId,
      '--parameters',
      parameters,
      '-o',
      'none',
    ])
  }

  ensureFederatedCredential(
    'github-actions-deploy-main',
    subjectMain,
    `GitHub Actions OIDC: deploy de codigo y apply de infra de ${config.projectName} desde la rama main`,
  )
  ensureFederatedCredential(
    'github-actions-plan-pr',
    subjectPr,
    `GitHub Actions OIDC: terraform plan de ${config.projectName} en pull requests`,
  )

  for (const line of [
    '',
    `=== Roles asignados al Service Principal (${spName}) ===`,
    '',
    `  Contributor                              -> ${scope}`,
    `  Role Based Access Control Administrator  -> ${scope}`,
    '    (con condicion anti-escalacion: no puede asignar Owner, User Access',
    '    Administrator ni Role Based Access Control Administrator)',
    `  Storage Blob Data Contributor            -> Storage Account del tfstate (${backend.storage})`,
    '',
    '=== Configura estos secrets en GitHub ===',
    'Settings > Secrets and variables > Actions > New repository secret',
    '',
    `  AZURE_CLIENT_ID       = ${appId}`,
    `  AZURE_TENANT_ID       = ${tenantId}`,
    `  AZURE_SUBSCRIPTION_ID = ${subscriptionId}`,
    '',
    'Autenticacion por OIDC (Workload Identity Federation): NO hay client secret que',
    "copiar ni que expire. Los workflows ya declaran 'permissions: id-token: write'",
    'y se loguean con azure/login pasando esos tres valores (sin AZURE_CREDENTIALS).',
    '',
    '=== Federated credentials (subjects OIDC) ===',
    '',
    `  ${subjectMain}`,
    '    (deploy de codigo y apply de infra: push a main)',
    `  ${subjectPr}`,
    '    (terraform plan de infra: pull_request)',
    '',
    'Si despliegas desde otra rama, tag o un GitHub Environment, anade otro federated',
    'credential con el subject correspondiente (ver MEF-ADR-0022).',
    '',
    '=== Por que el SP necesita estos permisos ===',
    '',
    'El apply de infraestructura ocurre en CI bajo esta identidad federada, nunca',
    'localmente (MEF-ADR-0022). El SP necesita:',
    '  - Contributor: aplicar infra (Function Apps, Storage, etc.) y desplegar codigo.',
    '  - Role Based Access Control Administrator: crear los role assignments que',
    '    emiten los scaffolders (Key Vault Secrets User, roles de datos de Storage;',
    '    MEF-ADR-0025) -- Contributor los excluye explicitamente.',
    '  - Storage Blob Data Contributor: escribir el tfstate y tomar su lock por AAD',
    '    (backend keyless, MEF-ADR-0025).',
    "  - Federated credential 'pull_request': autenticar el 'terraform plan' que",
    '    corre en cada PR sobre infra/** (modelo plan-en-PR / apply-en-merge-a-main).',
    '',
    'Listo.',
  ]) {
    output.out(line)
  }
  return 0
}

export function setupGithubCi(argv: string[], deps: SetupCiDeps): number {
  return exitCodeOf(deps.output, () => run(argv, deps))
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = setupGithubCi(process.argv.slice(2), {
    cwd: process.cwd(),
    program: fileURLToPath(import.meta.url),
    run: capture,
    output: new Output(true),
  })
}
