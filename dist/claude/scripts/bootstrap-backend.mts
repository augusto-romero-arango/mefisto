// bootstrap-backend.mts -- Crea el backend remoto de Terraform en Azure (tfstate).
//
// Crea de forma idempotente el Resource Group, la Storage Account y el container del estado de
// Terraform, y escribe infra/environments/<env>/backend.tf con el bloque backend "azurerm"
// resuelto. Es el prerequisito del pipeline IaC (/infra); no crea planes ni Function Apps.
//
// Naming del RG y la Storage Account (MEF-ADR-0045):
// - Con 'azureRegionShort' en harness.config.json: forma CAF sin sufijo aleatorio,
//   "rg-tfstate-{app}-{env}-{region}-{seq}" y "sttfstate{app}{env}{region}{seq}". Ante una
//   colision se incrementa 'resourceSequence'; nunca se vuelve a un sufijo aleatorio.
// - Sin el (retrocompatible): el RG es "{infraResourceGroupPrefix}-tfstate" y
//   'terraformStateStorage' es el nombre base, al que se anexa un sufijo aleatorio.
//
// El nombre ya escrito en backend.tf manda sobre las dos formas, y despues la cuenta ya creada
// en el RG del tfstate: una segunda corrida reusa esos nombres en vez de recalcularlos.
//
// Uso:
//   ./scripts/bootstrap-backend.sh --subscription <id>
//   ./scripts/bootstrap-backend.sh --subscription <id> --env dev
//   ./scripts/bootstrap-backend.sh <id> --env staging --location westeurope

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Output, chomp, consumerRoot, exitCodeOf, exitWith, parseJson, rawField } from './lib/azure-cli.mts'
import type { Run } from './lib/azure-cli.mts'
import { CliError, capture, isEntryPoint } from './lib/cli.mts'
import type { CommandResult } from './lib/cli.mts'
import { loadHarnessConfig } from './lib/harness-config.mts'
import {
  azurermBackendLines,
  composeTfstateResourceGroupName,
  composeTfstateStorageAccountBase,
  genStorageSuffix,
  readBackendResourceGroupName,
  readBackendStorageAccountName,
  tfstateStorageAppSlug,
  truncateStorageBase,
} from './lib/tfstate-naming.mts'

export interface BootstrapDeps {
  cwd: string
  /** Nombre del script en la linea de uso. */
  program: string
  run: Run
  /** Sufijo aleatorio de unicidad de la Storage Account en el naming legacy. */
  storageSuffix: (length: number) => string
  output: Output
}

interface Options {
  subscriptionId: string
  environment: string
  location: string
  help: boolean
}

const CONTAINER = 'tfstate'
const STORAGE_SUFFIX_LEN = 6
const STORAGE_MAX_LEN = 24

function usage(program: string): string[] {
  return [
    `Uso: ${program} --subscription <id> [--env <dev|staging|prod>] [--location <region>]`,
    '',
    '  --subscription <id>   Suscripcion de Azure (requerido; tambien se admite como',
    '                        primer argumento posicional).',
    '  --env <env>           Ambiente: dev | staging | prod. Default: dev.',
    '  --location <region>   Region de Azure (ej: eastus2). Si se omite, se lee',
    "                        'azureLocation' de harness.config.json.",
    '',
    `Ejemplo: ${program} --subscription 50fc1901-9723-4971-9d63-b3f1a015e8b8 --env dev`,
  ]
}

function parseArgs(argv: string[], program: string): Options {
  const options: Options = { subscriptionId: '', environment: 'dev', location: '', help: false }
  const withUsage = (message: string): CliError => new CliError([message, ...usage(program)].join('\n'))
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--subscription' || arg === '--env' || arg === '--location') {
      const value = argv[i + 1] ?? ''
      if (value.length === 0) throw new CliError(`ERROR: ${arg} requiere un valor`)
      if (arg === '--subscription') options.subscriptionId = value
      else if (arg === '--env') options.environment = value
      else options.location = value
      i++
    } else if (arg === '-h' || arg === '--help') {
      return { ...options, help: true }
    } else if (arg.startsWith('--')) {
      throw withUsage(`ERROR: opcion desconocida '${arg}'`)
    } else if (options.subscriptionId.length === 0) {
      options.subscriptionId = arg
    } else {
      throw withUsage(`ERROR: argumento inesperado '${arg}'`)
    }
  }
  return options
}

function isTrue(value: string): boolean {
  return value === 'true' || value === 'True'
}

function backendBlock(resourceGroup: string, storage: string, key: string): string[] {
  return [
    'terraform {',
    '  backend "azurerm" {',
    `    resource_group_name  = "${resourceGroup}"`,
    `    storage_account_name = "${storage}"`,
    `    container_name       = "${CONTAINER}"`,
    `    key                  = "${key}"`,
    '    use_azuread_auth     = true',
    '  }',
    '}',
  ]
}

function run(argv: string[], deps: BootstrapDeps): number {
  const { output } = deps
  consumerRoot(deps.cwd, [
    'ERROR: scripts/bootstrap-backend.sh es del plugin publicado y solo aplica al consumidor.',
    'Mefisto no se despliega a Azure ni tiene backend de Terraform.',
    'Para mejorar el plugin usa /mefisto-tooling.',
  ])
  const config = loadHarnessConfig(undefined, { cwd: deps.cwd, warn: (message) => output.err(message) })

  const options = parseArgs(argv, deps.program)
  if (options.help) {
    for (const line of usage(deps.program)) output.err(line)
    return 0
  }
  const { environment, subscriptionId } = options
  if (!['dev', 'staging', 'prod'].includes(environment)) {
    throw new CliError(`ERROR: --env invalido '${environment}' (usa dev | staging | prod)`)
  }
  if (subscriptionId.length === 0) {
    throw new CliError(['ERROR: falta la suscripcion de Azure.', ...usage(deps.program)].join('\n'))
  }

  let location = options.location
  if (location.length === 0) {
    const content = readFileSync(config.configPath, 'utf8').replace(/^﻿/, '')
    location = chomp(rawField(parseJson(content)?.value, 'azureLocation'))
  }
  if (location.length === 0) {
    throw new CliError(
      [
        'ERROR: no se especifico la region de Azure.',
        '  Pasa --location <region> (ej: --location eastus2) o agrega el campo',
        `  opcional "azureLocation" a ${config.configPath}.`,
      ].join('\n'),
    )
  }
  if (config.rgPrefix.length === 0) {
    throw new CliError(`ERROR: 'infraResourceGroupPrefix' no esta definido en ${config.configPath}.`)
  }
  if (config.tfstateStorage.length === 0) {
    throw new CliError(`ERROR: 'terraformStateStorage' no esta definido en ${config.configPath}.`)
  }

  const { rgPrefix, tfstateStorage, azureRegionShort: region, resourceSequence: sequence } = config
  const caf = region.length > 0
  const envDir = `infra/environments/${environment}`
  const envPath = join(deps.cwd, 'infra', 'environments', environment)
  const backendKey = `${environment}.tfstate`

  // El backend.tf ya versionado manda sobre cualquier formula de naming.
  const rgFromBackend = readBackendResourceGroupName(envPath)
  const rg =
    rgFromBackend.length > 0
      ? rgFromBackend
      : composeTfstateResourceGroupName(rgPrefix, environment, region, sequence)

  const legacyBase = truncateStorageBase(tfstateStorage, STORAGE_MAX_LEN, STORAGE_SUFFIX_LEN)
  if (!caf && legacyBase !== tfstateStorage) {
    output.err(
      `AVISO: 'terraformStateStorage' ('${tfstateStorage}', ${[...tfstateStorage].length} chars) no deja espacio para el sufijo de ${STORAGE_SUFFIX_LEN} chars dentro del limite de ${STORAGE_MAX_LEN}; se trunca la base a '${legacyBase}'.`,
    )
  }

  const storageBase = composeTfstateStorageAccountBase(
    rgPrefix,
    environment,
    region,
    sequence,
    legacyBase,
    STORAGE_MAX_LEN,
  )
  if (caf) {
    if (!storageBase.includes(tfstateStorageAppSlug(rgPrefix))) {
      output.err(
        `AVISO: 'infraResourceGroupPrefix' ('${rgPrefix}') no deja espacio para el patron CAF del tfstate ('sttfstate{app}${environment}${region}${sequence}') dentro del limite de ${STORAGE_MAX_LEN} chars; se trunca la porcion de proyecto (resultado: '${storageBase}').`,
      )
    }
    // Los componentes fijos del patron no se truncan nunca (MEF-ADR-0045 seccion 4): un env,
    // region o seq largos desbordan el limite por si solos.
    if (!storageBase.split('\n').some((line) => /^[a-z0-9]{3,24}$/.test(line))) {
      throw new CliError(
        [
          `ERROR: el nombre CAF de la Storage Account del tfstate ('${storageBase}', ${[...storageBase].length} chars) no cumple el naming de Azure Storage (3-24 chars, solo minusculas y digitos).`,
          `  Los componentes fijos del patron ('sttfstate' + env '${environment}' + azureRegionShort '${region}' + resourceSequence '${sequence}') ya no dejan espacio para {app}.`,
          `  Acorta 'azureRegionShort' o 'resourceSequence' en ${config.configPath}, o usa un nombre de ambiente mas corto (MEF-ADR-0045 seccion 4).`,
        ].join('\n'),
      )
    }
  }

  output.out(`=== Bootstrap del backend de Terraform para ${config.projectName} ===`)
  output.out(`  Ambiente:        ${environment}`)
  output.out(`  Suscripcion:     ${subscriptionId}`)
  output.out(`  Region:          ${location}`)
  if (caf) {
    output.out(
      `  Naming CAF:      activo (azureRegionShort='${region}', resourceSequence='${sequence}', MEF-ADR-0045)`,
    )
  } else {
    output.out(
      `  Naming CAF:      inactivo (falta 'azureRegionShort' en ${config.configPath}; naming legacy retrocompatible, MEF-ADR-0045)`,
    )
  }
  output.out(`  Resource Group:  ${rg}`)
  output.out(caf ? `  Storage:         ${storageBase}` : `  Storage (base):  ${storageBase}`)
  output.out(`  Container:       ${CONTAINER}`)
  output.out('')

  const call = (args: string[]): CommandResult => deps.run('az', args, { cwd: deps.cwd })
  const passthrough = (result: CommandResult): CommandResult => {
    output.writeOut(result.stdout)
    output.writeErr(result.stderr)
    return result
  }
  /** `az` sin capturar: su fallo termina el script con su codigo. */
  const az = (args: string[]): void => {
    const result = passthrough(call(args))
    if (result.status !== 0) exitWith(result.status)
  }
  /** `$(az ... 2>/dev/null) || var=""`. */
  const quiet = (args: string[]): string => {
    const result = call(args)
    return result.status === 0 ? chomp(result.stdout) : ''
  }

  output.out('Fijando la suscripcion activa...')
  if (passthrough(call(['account', 'set', '--subscription', subscriptionId])).status !== 0) {
    throw new CliError(
      [
        `ERROR: no se pudo fijar la suscripcion '${subscriptionId}'.`,
        "  Verifica que 'az login' este hecho y que la suscripcion exista.",
      ].join('\n'),
    )
  }

  const nameAvailable = (name: string): string =>
    quiet(['storage', 'account', 'check-name', '--name', name, '--query', 'nameAvailable', '-o', 'tsv'])
  const inconclusive = (name: string): void => {
    output.err(
      `AVISO: 'az storage account check-name' no fue concluyente para '${name}'; se usara de todas formas (si colisiona, el create fallara de forma explicita).`,
    )
  }

  // Precedencia: el nombre ya declarado en backend.tf, la cuenta ya creada en el RG del tfstate
  // (corrida previa interrumpida antes de escribir backend.tf) y, por ultimo, un nombre nuevo.
  const resolveStorage = (): string => {
    const fromBackend = readBackendStorageAccountName(envPath)
    if (fromBackend.length > 0) return fromBackend

    const existing = quiet([
      'storage',
      'account',
      'list',
      '--resource-group',
      rg,
      '--query',
      `[?starts_with(name, '${storageBase}')].name | [0]`,
      '-o',
      'tsv',
    ])
    if (existing.length > 0 && existing !== 'None') return existing

    if (caf) {
      const available = nameAvailable(storageBase)
      if (available === 'false' || available === 'False') {
        throw new CliError(
          [
            `ERROR: el nombre '${storageBase}' de Storage Account ya esta tomado en Azure (colision global).`,
            `  Incrementa 'resourceSequence' en ${config.configPath} (actual: '${sequence}') y reintenta -- MEF-ADR-0045 seccion 2 prohibe volver a un sufijo aleatorio.`,
          ].join('\n'),
        )
      }
      if (!isTrue(available)) inconclusive(storageBase)
      return storageBase
    }

    for (let attempt = 1; attempt <= 10; attempt++) {
      const candidate = `${storageBase}${deps.storageSuffix(STORAGE_SUFFIX_LEN)}`
      const available = nameAvailable(candidate)
      if (available === 'false' || available === 'False') continue
      if (!isTrue(available)) inconclusive(candidate)
      return candidate
    }
    throw new CliError(
      'ERROR: no se pudo resolver un nombre globalmente unico para la Storage Account tras 10 intentos con sufijo aleatorio.',
    )
  }

  output.out(`Resolviendo el nombre de la Storage Account (base '${storageBase}')...`)
  const storage = resolveStorage()
  output.out(`  Storage Account: ${storage}`)
  output.out('')

  if (isTrue(quiet(['group', 'exists', '--name', rg]))) {
    output.out(`Resource Group '${rg}' ya existe. Omitiendo.`)
  } else {
    output.out(`Creando Resource Group '${rg}' en ${location}...`)
    az(['group', 'create', '--name', rg, '--location', location, '-o', 'none'])
  }

  const shown = call(['storage', 'account', 'show', '--name', storage, '--resource-group', rg, '-o', 'none'])
  output.writeOut(shown.stdout)
  if (shown.status === 0) {
    output.out(`Storage Account '${storage}' ya existe. Omitiendo creacion.`)
  } else {
    output.out(`Creando Storage Account '${storage}'...`)
    az([
      'storage',
      'account',
      'create',
      '--name',
      storage,
      '--resource-group',
      rg,
      '--location',
      location,
      '--sku',
      'Standard_LRS',
      '--kind',
      'StorageV2',
      '--min-tls-version',
      'TLS1_2',
      '--https-only',
      'true',
      '--allow-blob-public-access',
      'false',
      '-o',
      'none',
    ])
  }

  // Fija el estado deseado aunque la cuenta ya existiera.
  output.out('Asegurando versioning y soft-delete de blobs...')
  az([
    'storage',
    'account',
    'blob-service-properties',
    'update',
    '--account-name',
    storage,
    '--resource-group',
    rg,
    '--enable-versioning',
    'true',
    '--enable-delete-retention',
    'true',
    '--delete-retention-days',
    '7',
    '-o',
    'none',
  ])

  const containerArgs = ['--name', CONTAINER, '--account-name', storage, '--auth-mode', 'login']
  if (isTrue(quiet(['storage', 'container', 'exists', ...containerArgs, '--query', 'exists', '-o', 'tsv']))) {
    output.out(`Container '${CONTAINER}' ya existe. Omitiendo.`)
  } else {
    output.out(`Creando container '${CONTAINER}' (auth-mode login)...`)
    if (passthrough(call(['storage', 'container', 'create', ...containerArgs, '-o', 'none'])).status !== 0) {
      throw new CliError(
        [
          `ERROR: no se pudo crear el container '${CONTAINER}'.`,
          "  Con --auth-mode login necesitas el rol 'Storage Blob Data Contributor'",
          '  sobre la Storage Account. Tras asignarlo, la propagacion RBAC puede',
          '  tardar unos minutos; re-ejecuta este script (es idempotente).',
        ].join('\n'),
      )
    }
  }

  mkdirSync(envPath, { recursive: true })
  const backendFile = `${envDir}/backend.tf`
  const block = backendBlock(rg, storage, backendKey)

  // Con un backend "azurerm" en otro .tf del ambiente no se escribe backend.tf: Terraform falla
  // con dos backends.
  const elsewhere = azurermBackendLines(envPath).filter(
    (file) => file.count > 0 && file.file !== 'backend.tf',
  )
  if (elsewhere.length > 0) {
    output.err('AVISO: ya existe un bloque backend "azurerm" en:')
    for (const file of elsewhere) output.err(`  - ${envDir}/${file.file}`)
    output.err(`  No se escribe ${backendFile} para no duplicar la definicion del backend.`)
  } else {
    const content = [
      '# Generado por scripts/bootstrap-backend.sh -- no editar a mano.',
      `# Backend remoto del estado de Terraform para el ambiente '${environment}'.`,
      "# 'use_azuread_auth = true': acceso keyless por AAD/RBAC, nunca por access key",
      '# (MEF-ADR-0025, MEF-ADR-0022; developer.hashicorp.com/terraform/language/backend/azurerm).',
      ...block,
    ]
    writeFileSync(join(envPath, 'backend.tf'), `${content.join('\n')}\n`)
    output.out(`Escrito ${backendFile}.`)
  }

  output.out('')
  output.out('=== Backend listo. Bloque backend "azurerm" resultante: ===')
  for (const line of block) output.out(line)
  for (const line of [
    '',
    'El backend es keyless (AAD/RBAC, MEF-ADR-0025): ningun access key se emite ni se',
    "persiste para el tfstate. El principal que hace 'terraform apply' en CI",
    "requiere el rol 'Storage Blob Data Contributor' (lectura+escritura, no solo",
    'lectura) sobre esta Storage Account -- lo asigna scripts/setup-github-ci.sh',
    '(issue #195), no este script.',
    '',
    `Siguiente paso: el pipeline IaC ejecuta 'terraform init' en ${envDir}`,
    'y reutiliza este backend. Lanzalo con /infra o scripts/iac-pipeline.sh.',
    'Listo.',
  ]) {
    output.out(line)
  }
  return 0
}

export function bootstrapBackend(argv: string[], deps: BootstrapDeps): number {
  return exitCodeOf(deps.output, () => run(argv, deps))
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = bootstrapBackend(process.argv.slice(2), {
    cwd: process.cwd(),
    program: fileURLToPath(import.meta.url),
    run: capture,
    storageSuffix: genStorageSuffix,
    output: new Output(true),
  })
}
