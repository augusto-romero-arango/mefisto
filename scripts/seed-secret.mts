// Registra un secreto nuevo post-greenfield (issue #256).
//
// Agrega o actualiza, de forma idempotente, una entrada en `.mefisto/harness.config.json` >
// secrets[] (que el step de siembra data-driven de infra-cd.yml itera en runtime --
// agents/infra-base-scaffolder.md, Paso 2b) y localiza el archivo Terraform del dominio
// consumidor (infra/environments/<env>/dominio-{kebab}.tf, la fuente de verdad que ya genero
// domain-scaffolder). No edita HCL: imprime el app setting y la referencia
// @Microsoft.KeyVault(...) a cablear, para que el skill commands/seed-secret.md los inserte de
// forma idempotente.
//
// Uso:
//   node scripts/seed-secret.mts <nombre> --domain <dominio> \
//       (--from-output <output-de-terraform> | --from-github-secret <NOMBRE_GITHUB_SECRET>) \
//       [--env <env>]
//
//   <nombre>              nombre del secreto en el Key Vault del BC (kebab-case recomendado)
//   --domain <dominio>    dominio consumidor; acepta kebab o PascalCase (calculo-horas o CalculoHoras)
//   --from-output         un 'terraform output' derivable (source.type=output, D2)
//   --from-github-secret  un GitHub secret no derivable (source.type=github-secret, D2)
//   --env <env>           ambiente Terraform (default: dev)

import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions, CommandResult } from './lib/cli.mts'
import { consumerRepoRoot } from './lib/consumer-guard.mts'
import { loadHarnessConfig, upsertHarnessSecret } from './lib/harness-config.mts'

export interface SeedSecretDeps {
  cwd: string
  /** Ruta con la que se nombra el script en la linea de uso. */
  program: string
  hasCommand: (command: string) => boolean
  run: (command: string, args: string[], options?: CommandOptions) => CommandResult
  out: (line: string) => void
  err: (line: string) => void
}

interface Options {
  name: string
  domain: string
  fromOutput: string
  fromGithubSecret: string
  environment: string
}

function usage(program: string): string {
  return [
    `Uso: ${program} <nombre> --domain <dominio> (--from-output <output> | --from-github-secret <NOMBRE>) [--env <env>]`,
    `Ejemplo: ${program} stripe-api-key --domain facturacion --from-github-secret STRIPE_API_KEY`,
  ].join('\n')
}

function parseArgs(argv: string[], program: string): Options {
  const [name, ...rest] = argv
  if (name === undefined) throw new CliError(usage(program))
  const options: Options = { name, domain: '', fromOutput: '', fromGithubSecret: '', environment: 'dev' }
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (
      flag !== '--domain' &&
      flag !== '--from-output' &&
      flag !== '--from-github-secret' &&
      flag !== '--env'
    ) {
      throw new CliError(`ERROR: argumento desconocido '${flag}'\n${usage(program)}`)
    }
    // Contrato heredado: un flag sin valor al final termina en 1 sin mensaje.
    if (value === undefined) throw new CliError('')
    if (flag === '--domain') options.domain = value
    else if (flag === '--from-output') options.fromOutput = value
    else if (flag === '--from-github-secret') options.fromGithubSecret = value
    else options.environment = value
  }
  if (options.name === '') throw new CliError(`ERROR: falta <nombre> del secreto.\n${usage(program)}`)
  if (options.domain === '') throw new CliError(`ERROR: falta --domain <dominio>.\n${usage(program)}`)
  // D2 (fijado por el mantenedor): fuente explicita, sin heuristica por nombre.
  if (options.fromOutput !== '' && options.fromGithubSecret !== '') {
    throw new CliError('ERROR: pasa exactamente uno de --from-output o --from-github-secret, no ambos.')
  }
  if (options.fromOutput === '' && options.fromGithubSecret === '') {
    throw new CliError(
      'ERROR: pasa uno de --from-output <output> o --from-github-secret <NOMBRE> (D2: fuente explicita, sin heuristica por nombre).',
    )
  }
  return options
}

/** Forma comparable de un dominio: acepta kebab o PascalCase. */
export function flatten(domain: string): string {
  return domain.toLowerCase().replaceAll('-', '')
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

/** Kebab del primer `dominio-<kebab>.tf` de `dir` que corresponde a `domain`, o `null`. */
export function findDomainKebab(dir: string, domain: string): string | null {
  const wanted = flatten(domain)
  for (const name of entries(dir)) {
    const kebab = /^dominio-(.*)\.tf$/s.exec(name)?.[1]
    if (kebab === undefined || flatten(kebab) !== wanted) continue
    if (statSync(join(dir, name), { throwIfNoEntry: false })?.isFile() === true) return kebab
  }
  return null
}

function hasDomainSource(srcDir: string, namespacePrefix: string, domain: string): boolean {
  const prefix = `${namespacePrefix}.`
  const wanted = flatten(domain)
  return entries(srcDir).some(
    (name) =>
      name.startsWith(prefix) &&
      flatten(name.slice(prefix.length)) === wanted &&
      statSync(join(srcDir, name), { throwIfNoEntry: false })?.isDirectory() === true,
  )
}

/** `true` si `name` es la primera columna de alguna linea de `gh secret list`. */
export function secretListed(listing: string, name: string): boolean {
  return listing.split('\n').some((line) => line.trim().split(/[ \t]+/)[0] === name)
}

function run(argv: string[], deps: SeedSecretDeps): number {
  consumerRepoRoot(deps.cwd, [
    'ERROR: scripts/seed-secret.mts es del plugin publicado y solo aplica al consumidor.',
    'Mefisto no tiene harness.config.json ni dominios de negocio que sembrar.',
  ])
  const options = parseArgs(argv, deps.program)
  const config = loadHarnessConfig(undefined, { cwd: deps.cwd, warn: deps.err })

  // La fuente de verdad es el archivo Terraform que ya genero domain-scaffolder (issue #234):
  // este script nunca crea un dominio, solo cablea un secreto en uno que ya existe.
  const environmentDir = `infra/environments/${options.environment}`
  const kebab = findDomainKebab(join(deps.cwd, 'infra', 'environments', options.environment), options.domain)
  if (kebab === null) {
    throw new CliError(
      [
        `ERROR: no se encontro ${environmentDir}/dominio-*.tf para el dominio '${options.domain}'.`,
        `       Verifica que el dominio ya este scaffoldeado (/scaffold ${options.domain}) antes de sembrar un secreto en el.`,
      ].join('\n'),
    )
  }
  const terraformFile = `${environmentDir}/dominio-${kebab}.tf`

  if (!hasDomainSource(join(deps.cwd, 'src'), config.namespacePrefix, options.domain)) {
    deps.err(
      `ADVERTENCIA: se encontro ${terraformFile} pero no src/${config.namespacePrefix}.<Dominio>/ correspondiente.`,
    )
    deps.err('             continua igual: el archivo Terraform es la fuente de verdad para el cableado.')
  }

  const sourceType = options.fromOutput !== '' ? 'output' : 'github-secret'
  const sourceValue = options.fromOutput !== '' ? options.fromOutput : options.fromGithubSecret
  try {
    upsertHarnessSecret(options.name, sourceType, sourceValue, undefined, { cwd: deps.cwd })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(
      `${error.message}\nERROR: no se pudo registrar '${options.name}' en secrets[] del contrato canonico .mefisto/harness.config.json; revisa el diagnostico anterior.`,
    )
  }
  deps.out(
    `OK: '${options.name}' registrado en ${config.configPath} > secrets[] (source: ${sourceType}:${sourceValue}).`,
  )
  deps.out(`Registro: ${config.configPath}`)

  if (sourceType === 'github-secret') {
    const listing = deps.hasCommand('gh') ? deps.run('gh', ['secret', 'list'], { cwd: deps.cwd }) : null
    if (listing === null || listing.status !== 0) {
      deps.out("RECORDATORIO: no se pudo verificar con 'gh secret list' (sin gh instalado o sin sesion).")
      deps.out(
        `              Confirma manualmente que el GitHub secret '${sourceValue}' existe antes del proximo apply.`,
      )
    } else if (secretListed(listing.stdout, sourceValue)) {
      deps.out(`OK: el GitHub secret '${sourceValue}' ya existe en el repo.`)
    } else {
      deps.out(
        `RECORDATORIO: crea el GitHub secret '${sourceValue}' (Settings > Secrets and variables > Actions)`,
      )
      deps.out(
        `              antes del proximo apply que deba sembrar '${options.name}' -- si no, ese apply fallara`,
      )
      deps.out('              al no encontrar el valor (ver agents/infra-base-scaffolder.md, Paso 2b).')
    }
  }

  // El skill (Read + Edit) inserta esto de forma idempotente (CA-6: nunca duplica un app setting
  // ni un role assignment ya presente).
  const appSettingKey = options.name.toUpperCase().replaceAll('-', '_')
  deps.out('')
  deps.out(`Cableado pendiente en ${terraformFile} (module "function_app_*" > app_settings):`)
  deps.out(
    `  ${appSettingKey} = "@Microsoft.KeyVault(SecretUri=\${module.key_vault.uri}secrets/${options.name})"`,
  )
  deps.out('')
  deps.out('Rol de lectura (Key Vault Secrets User) de la managed identity de este dominio:')
  deps.out('  ya lo emite domain-scaffolder al crear el dominio (azurerm_role_assignment')
  deps.out(
    `  function_app_${kebab.replaceAll('-', '_')}_kv_secrets_user, scope = module.key_vault.id) -- cubre`,
  )
  deps.out('  TODOS los secretos del vault, incluido este (CA-6: no dupliques ese role assignment).')
  deps.out(`  Verifica que el bloque exista en ${terraformFile}; si por alguna razon faltara, agregalo`)
  deps.out('  (ver agents/domain-scaffolder.md).')
  return 0
}

export function seedSecret(argv: string[], deps: SeedSecretDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) deps.err(error.message)
    return error.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = seedSecret(process.argv.slice(2), {
    cwd: process.cwd(),
    program: `node ${join(dirname(fileURLToPath(import.meta.url)), 'seed-secret.mts')}`,
    hasCommand: commandExists,
    run: capture,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
