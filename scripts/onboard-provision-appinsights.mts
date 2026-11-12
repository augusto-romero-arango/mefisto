// Provision de `.mefisto/appinsights.env` (issue #2387).
//
// Descubre con `az` (sesion activa) los nombres de App Insights, Service Bus y Function Apps del
// resource group del entorno y escribe las cinco claves que lee appinsights-query.mts
// (MEF-ADR-0053). El descubrimiento es por tipo de recurso dentro del RG, agnostico a naming CAF
// o legacy (MEF-ADR-0045), igual que purge-store.mts.
//
// Uso: node scripts/onboard-provision-appinsights.mts [--preview | --apply] [--env <env>]
//          [--appinsights-app <nombre>] [--servicebus-namespace <nombre>]
// (cwd = raiz del consumidor). --preview es el modo por defecto y no escribe.
// --apply nunca sobrescribe un .mefisto/appinsights.env existente.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CliError, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions, CommandResult } from './lib/cli.mts'
import { consumerRepoRoot } from './lib/consumer-guard.mts'
import { loadHarnessConfig } from './lib/harness-config.mts'
import type { HarnessConfig } from './lib/harness-config.mts'

export interface ProvisionDeps {
  cwd: string
  hasCommand: (command: string) => boolean
  run: (command: string, args: string[], options?: CommandOptions) => CommandResult
  out: (line: string) => void
  err: (line: string) => void
}

export const USAGE =
  'Uso: onboard-provision-appinsights.mts [--preview | --apply] [--env <env>] [--appinsights-app <nombre>] [--servicebus-namespace <nombre>]'

type Mode = '--preview' | '--apply'

interface Options {
  mode: Mode
  environment: string
  appInsights: string
  serviceBus: string
  help: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: '--preview',
    environment: 'dev',
    appInsights: '',
    serviceBus: '',
    help: false,
  }
  let mode: Mode | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--preview':
      case '--apply':
        if (mode !== null && mode !== arg) throw new CliError(USAGE, 2)
        mode = arg
        break
      case '--env':
      case '--appinsights-app':
      case '--servicebus-namespace':
        if (value === undefined) throw new CliError(USAGE, 2)
        if (arg === '--env') options.environment = value
        else if (arg === '--appinsights-app') options.appInsights = value
        else options.serviceBus = value
        i++
        break
      case '-h':
      case '--help':
        return { ...options, help: true }
      default:
        throw new CliError(`ERROR: argumento desconocido '${arg}'\n${USAGE}`, 2)
    }
  }
  if (options.environment === '') throw new CliError('ERROR: --env requiere un valor.', 2)
  return { ...options, mode: mode ?? '--preview' }
}

/** Nombres que imprime `az ... -o tsv`, uno por linea, sin vacios y ordenados. */
export function resourceNames(tsv: string): string[] {
  return tsv
    .split(/\r?\n/)
    .filter((name) => name.length > 0)
    .sort()
}

/** El candidato unico o el que nombra `flag`; aborta si no hay ninguno, si sobran o si no esta. */
export function pick(
  label: string,
  flag: string,
  candidates: string[],
  flagName: string,
  resourceGroup: string,
): string {
  const listed = candidates.map((candidate) => `  - ${candidate}`)
  const [only] = candidates
  if (only === undefined) {
    throw new CliError(
      `ERROR: no se encontro ningun ${label} en el resource group '${resourceGroup}'; no se escribio nada.`,
    )
  }
  if (flag !== '') {
    if (candidates.includes(flag)) return flag
    throw new CliError(
      [
        `ERROR: ${flagName} '${flag}' no esta entre los candidatos de ${label} en '${resourceGroup}':`,
        ...listed,
      ].join('\n'),
    )
  }
  if (candidates.length > 1) {
    throw new CliError(
      [
        `ERROR: hay ${candidates.length} candidatos de ${label} en '${resourceGroup}'; indica uno con ${flagName} <nombre>:`,
        ...listed,
      ].join('\n'),
    )
  }
  return only
}

/** Lineas de `.mefisto/appinsights.env`: la cabecera y las cinco claves. */
export function appinsightsEnvLines(
  appInsights: string,
  serviceBus: string,
  resourceGroup: string,
  functionApps: string[],
): string[] {
  return [
    '# Nombres de recursos Azure para appinsights-query.mts (solo nombres, sin secretos). Generado por /onboard (issue #2387).',
    `APPINSIGHTS_APP=${appInsights}`,
    `APPINSIGHTS_RG=${resourceGroup}`,
    `SERVICEBUS_NAMESPACE=${serviceBus}`,
    `SERVICEBUS_RG=${resourceGroup}`,
    `FUNCTIONAPP_NAMES=${functionApps.join(',')}`,
  ]
}

function run(argv: string[], deps: ProvisionDeps): number {
  const options = parseArgs(argv)
  if (options.help) {
    deps.err(USAGE)
    return 0
  }
  const root = consumerRepoRoot(deps.cwd, [
    'ERROR: scripts/onboard-provision-appinsights.mts es del plugin publicado y solo aplica al consumidor.',
  ])

  const target = join(root, '.mefisto', 'appinsights.env')
  if (options.mode === '--apply' && existsSync(target)) {
    throw new CliError(
      [
        'ERROR: .mefisto/appinsights.env ya existe; no se sobrescribe.',
        '       Editalo o borralo a mano y reintenta.',
      ].join('\n'),
    )
  }

  const az = (args: string[]): CommandResult => deps.run('az', args, { cwd: deps.cwd })
  if (!deps.hasCommand('az')) {
    throw new CliError("ERROR: 'az' no esta instalado o no esta en el PATH (requerido); no se escribio nada.")
  }
  if (az(['account', 'show']).status !== 0) {
    throw new CliError(
      "ERROR: no hay sesion activa de Azure CLI. Ejecuta 'az login' primero; no se escribio nada.",
    )
  }

  let config: HarnessConfig
  try {
    config = loadHarnessConfig(undefined, { cwd: deps.cwd, warn: deps.err })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(`${error.message}\nERROR: el config efectivo no es valido; no se escribio nada.`)
  }

  // Misma resolucion que resolve_resource_group de purge-store.mts (duplicada a proposito, dos
  // usos: Rule of Three no alcanzada, MEF-ADR-0018).
  const plain = `${config.rgPrefix}-${options.environment}`
  const candidates =
    config.azureRegionShort === ''
      ? [plain]
      : [`${plain}-${config.azureRegionShort}-${config.resourceSequence}`, plain]
  const resourceGroup = candidates.find(
    (candidate) => az(['group', 'show', '--name', candidate]).status === 0,
  )
  if (resourceGroup === undefined) {
    const variant = config.azureRegionShort === '' ? '' : 'y su variante con sufijo de region/secuencia '
    throw new CliError(
      [
        `ERROR: no se encontro el resource group de '${options.environment}' (probado '${plain}'`,
        `  ${variant}en la suscripcion activa); no se escribio nada.`,
      ].join('\n'),
    )
  }

  const listByType = (type: string, query: string): string[] =>
    resourceNames(
      az([
        'resource',
        'list',
        '--resource-group',
        resourceGroup,
        '--resource-type',
        type,
        '--query',
        query,
        '-o',
        'tsv',
      ]).stdout,
    )
  const appInsightsCandidates = listByType('Microsoft.Insights/components', '[].name')
  const serviceBusCandidates = listByType('Microsoft.ServiceBus/namespaces', '[].name')
  const functionApps = listByType('Microsoft.Web/sites', "[?kind && contains(kind, 'functionapp')].name")

  const appInsights = pick(
    'App Insights',
    options.appInsights,
    appInsightsCandidates,
    '--appinsights-app',
    resourceGroup,
  )
  const serviceBus = pick(
    'namespace de Service Bus',
    options.serviceBus,
    serviceBusCandidates,
    '--servicebus-namespace',
    resourceGroup,
  )
  const lines = appinsightsEnvLines(appInsights, serviceBus, resourceGroup, functionApps)

  if (functionApps.length === 0) {
    deps.err(
      `AVISO: no hay Function Apps en '${resourceGroup}'; FUNCTIONAPP_NAMES queda vacio (function-errors no funcionara hasta el primer /scaffold).`,
    )
  }

  deps.out(`Resource group: ${resourceGroup}`)
  deps.out('Contenido de .mefisto/appinsights.env:')
  for (const line of lines) if (!line.startsWith('#')) deps.out(line)

  if (options.mode === '--preview') {
    deps.out(
      'Previsualizacion: no se escribio ningun archivo. Usa --apply solo tras la confirmacion explicita de /onboard.',
    )
    return 0
  }

  try {
    mkdirSync(join(root, '.mefisto'), { recursive: true })
  } catch {
    throw new CliError('ERROR: no se pudo crear .mefisto/.')
  }
  try {
    // `wx` falla si el archivo aparecio despues de la comprobacion inicial.
    writeFileSync(target, `${lines.join('\n')}\n`, { flag: 'wx' })
  } catch {
    throw new CliError(
      'ERROR: no se pudo crear .mefisto/appinsights.env (ya existe o no es escribible); no se sobrescribe.',
    )
  }
  deps.out(
    'OK: .mefisto/appinsights.env creado. Commitealo: contiene solo nombres de recursos, sin secretos.',
  )
  return 0
}

export function provisionAppinsights(argv: string[], deps: ProvisionDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deps.err(error.message)
    return error.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = provisionAppinsights(process.argv.slice(2), {
    cwd: process.cwd(),
    hasCommand: commandExists,
    run: capture,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
