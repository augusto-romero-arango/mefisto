// purge-store.mts -- purga determinista del store de un dominio en dev (issue #725).
//
// Mitad determinista del mecanismo de purga de MEF-ADR-0036 seccion 5: las guardas viven en
// codigo, no en el juicio de un LLM. La mitad agentica (diagnostico, confirmacion humana,
// validacion) es el skill /purge-store.
//
// Sin tokens propios en harness.config.json: el secreto de conexion es siempre
// 'marten-connection' (MEF-ADR-0025), el schema es el dominio en snake_case
// (MEF-ADR-0003/MEF-ADR-0034) y el servidor Postgres, el Key Vault, el Container App del worker
// y la Function App del dominio se descubren por tipo con 'az resource list', sea el naming CAF
// (MEF-ADR-0045) o el legacy.
//
// Uso:
//   scripts/purge-store.sh --domain <dominio> [--env dev] [--dry-run]
//
//   <dominio>    dominio a purgar, en kebab o PascalCase; debe estar declarado en domainLabels
//                del contrato canonico .mefisto/harness.config.json, con fallback
//                legacy solo de lectura en .claude/harness.config.json
//   --env       ambiente objetivo. Unico valor aceptado: 'dev' (default); cualquier otro
//                aborta antes de tocar Azure (guarda anti-prod, CA-1).
//   --dry-run    reporta que se perderia (streams, tablas de read model, checkpoints del
//                daemon) sin ejecutar ningun paso destructivo.
//
// Requiere: az cli con sesion activa (az login), psql, curl.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Output, chomp, consumerRoot, exitWith, lines, words } from './lib/azure-cli.mts'
import { CliError, commandExists, isEntryPoint, spawnTarget } from './lib/cli.mts'
import type { CommandOptions, CommandResult } from './lib/cli.mts'
import { loadHarnessConfig } from './lib/harness-config.mts'

export interface PurgeDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Nombre del script en la linea de uso. */
  program: string
  /** Sufijo del nombre de la regla de firewall temporal. */
  pid: number
  hasCommand: (command: string) => boolean
  run: (command: string, args: string[], options?: CommandOptions) => CommandResult | Promise<CommandResult>
  /** Codigo de salida que pide una senal ya recibida (130 por INT, 143 por TERM), o `null`. */
  interrupted: () => number | null
  output: Output
}

interface Options {
  domain: string
  environment: string
  dryRun: boolean
  help: boolean
}

export interface Connection {
  host: string
  port: string
  database: string
  user: string
  password: string
  sslMode: string
}

const IP_ENDPOINTS = ['https://ifconfig.me/ip', 'https://api.ipify.org']
const IPV4 = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/

function usage(program: string): string[] {
  return [
    `Uso: ${program} --domain <dominio> [--env dev] [--dry-run]`,
    `Ejemplo: ${program} --domain calculo-horas --dry-run`,
  ]
}

function parseArgs(argv: string[], program: string): Options {
  const options: Options = { domain: '', environment: 'dev', dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--domain':
      case '--env':
        // Sin valor detras, el script en bash terminaba en 1 sin mensaje.
        if (i + 1 >= argv.length) exitWith(1)
        if (arg === '--domain') options.domain = argv[i + 1] ?? ''
        else options.environment = argv[i + 1] ?? ''
        i++
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '-h':
      case '--help':
        return { ...options, help: true }
      default:
        throw new CliError([`ERROR: argumento desconocido '${arg}'`, ...usage(program)].join('\n'))
    }
  }
  return options
}

function flatten(name: string): string {
  return name.toLowerCase().replaceAll('-', '')
}

/**
 * Function Apps de `all` (una por linea) que son del dominio: las del prefijo CAF `func-{dominio}-`
 * o, si no hay ninguna, las del patron laxo del naming legacy.
 */
export function matchFunctionApps(all: string, domain: string): string[] {
  const names = lines(all)
  const select = (pattern: string): string[] => {
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch {
      return []
    }
    return names.filter((name) => regex.test(name))
  }
  const exact = select(`^func-${domain}-`)
  return exact.length > 0 ? exact : select(`(^|-)${domain}(-|$)`)
}

/** Trocea el formato Npgsql (`Host=...;Database=...;Username=...;Password=...;SSL Mode=...`). */
export function parseConnection(secret: string): Connection {
  const connection: Connection = {
    host: '',
    port: '',
    database: '',
    user: '',
    password: '',
    sslMode: 'require',
  }
  for (const part of secret.split(';')) {
    if (part.length === 0) continue
    const cut = part.indexOf('=')
    const key = cut === -1 ? part : part.slice(0, cut)
    const value = cut === -1 ? part : part.slice(cut + 1)
    switch (key.toLowerCase()) {
      case 'host':
        connection.host = value
        break
      case 'port':
        connection.port = value
        break
      case 'database':
        connection.database = value
        break
      case 'username':
        connection.user = value
        break
      case 'password':
        connection.password = value
        break
      case 'ssl mode':
        connection.sslMode = value.toLowerCase()
        break
    }
  }
  return connection
}

async function purge(argv: string[], deps: PurgeDeps): Promise<number> {
  const { output } = deps
  consumerRoot(deps.cwd, [
    'ERROR: scripts/purge-store.sh es del plugin publicado y solo aplica al consumidor.',
    'Mefisto no tiene harness.config.json ni un store desplegado que purgar.',
  ])

  const options = parseArgs(argv, deps.program)
  if (options.help) {
    for (const line of usage(deps.program)) output.err(line)
    return 0
  }
  if (options.domain.length === 0) {
    throw new CliError(['ERROR: falta --domain <dominio>.', ...usage(deps.program)].join('\n'))
  }
  const environment = options.environment

  // Guarda anti-prod (CA-1): antes de cualquier llamada a Azure y de cargar el config.
  if (environment !== 'dev') {
    throw new CliError(
      [
        'ERROR: guarda anti-prod (CA-1, MEF-ADR-0036 seccion 5): este script solo opera',
        `  sobre el entorno 'dev'. Recibido: '${environment}'.`,
        '  Purgar cualquier otro entorno esta deliberadamente fuera de alcance de este script.',
      ].join('\n'),
    )
  }

  for (const bin of ['az', 'psql', 'curl']) {
    if (!deps.hasCommand(bin)) {
      throw new CliError(`ERROR: '${bin}' no esta instalado o no esta en el PATH (requerido).`)
    }
  }

  const run = async (command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> => {
    const result = await deps.run(
      command,
      args,
      env === undefined ? { cwd: deps.cwd } : { cwd: deps.cwd, env },
    )
    const signal = deps.interrupted()
    if (signal !== null) exitWith(signal)
    return result
  }
  /** `$(az ... 2>/dev/null) || var=""`. */
  const azValue = async (args: string[]): Promise<string> => {
    const result = await run('az', args)
    return result.status === 0 ? chomp(result.stdout) : ''
  }
  /** Comando cuyo fallo termina el script con su codigo; su stderr llega al operador. */
  const must = async (command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> => {
    const result = await run(command, args, env)
    output.writeErr(result.stderr)
    if (result.status !== 0) exitWith(result.status)
    return result
  }

  if ((await run('az', ['account', 'show'])).status !== 0) {
    throw new CliError("ERROR: no hay sesion activa de Azure CLI. Ejecuta 'az login' primero.")
  }

  const config = loadHarnessConfig(undefined, { cwd: deps.cwd, warn: (message) => output.err(message) })

  // La forma canonica del dominio es la declarada en domainLabels, nunca la que tecleo el operador.
  const labels = words(config.domainLabels.join(' '))
  const domain = labels.find((label) => flatten(label) === flatten(options.domain))
  if (domain === undefined) {
    throw new CliError(
      [
        `ERROR: el dominio '${options.domain}' no esta declarado en domainLabels de ${config.configPath}.`,
        `  Dominios declarados: ${config.domainLabels.join(' ')}`,
      ].join('\n'),
    )
  }
  const schema = domain.replaceAll('-', '_')

  // Primero el patron CAF con region y secuencia (MEF-ADR-0045), despues el legacy sin sufijo.
  const candidates = [`${config.rgPrefix}-${environment}`]
  if (config.azureRegionShort.length > 0) {
    candidates.unshift(
      `${config.rgPrefix}-${environment}-${config.azureRegionShort}-${config.resourceSequence}`,
    )
  }
  let resourceGroup: string | undefined
  for (const candidate of candidates) {
    if ((await run('az', ['group', 'show', '--name', candidate])).status === 0) {
      resourceGroup = candidate
      break
    }
  }
  if (resourceGroup === undefined) {
    const variant = config.azureRegionShort.length > 0 ? 'y su variante con sufijo de region/secuencia ' : ''
    throw new CliError(
      [
        `ERROR: no se encontro el resource group de '${environment}' (probado '${config.rgPrefix}-${environment}'`,
        `  ${variant}en la suscripcion activa).`,
        `  Verifica 'az account show' y que la infraestructura de ${environment} ya este desplegada.`,
      ].join('\n'),
    )
  }
  const rg = resourceGroup
  output.out(`Resource group: ${rg}`)

  const listByType = (type: string, query: string): Promise<string> =>
    azValue([
      'resource',
      'list',
      '--resource-group',
      rg,
      '--resource-type',
      type,
      '--query',
      query,
      '-o',
      'tsv',
    ])
  const pgServer = await listByType('Microsoft.DBforPostgreSQL/flexibleServers', '[0].name')
  const keyVault = await listByType('Microsoft.KeyVault/vaults', '[0].name')
  const functionApps = matchFunctionApps(
    await listByType('Microsoft.Web/sites', "[?kind && contains(kind, 'functionapp')].name"),
    domain,
  )
  const functionApp = functionApps[0] ?? ''

  // La revision activa se resuelve antes del DROP: descubrir despues que falta la extension
  // 'containerapp' dejaria el store purgado y el worker sin reiniciar.
  let worker = ''
  let activeRevision = ''
  if (config.projectionsEnabled) {
    worker = await listByType('Microsoft.App/containerApps', "[?contains(name, 'projections')].name | [0]")
    if (worker.length > 0) {
      activeRevision = await azValue([
        'containerapp',
        'revision',
        'list',
        '--name',
        worker,
        '--resource-group',
        rg,
        '--query',
        '[?properties.active] | [0].name',
        '-o',
        'tsv',
      ])
    }
  }

  const missing: string[] = []
  if (pgServer.length === 0) missing.push('servidor PostgreSQL (Microsoft.DBforPostgreSQL/flexibleServers)')
  if (keyVault.length === 0) missing.push('Key Vault (Microsoft.KeyVault/vaults)')
  if (functionApp.length === 0) missing.push(`Function App del dominio '${domain}' (Microsoft.Web/sites)`)
  if (config.projectionsEnabled) {
    if (worker.length === 0) {
      missing.push(
        'Container App del worker de proyecciones (Microsoft.App/containerApps, projections.enabled=true)',
      )
    } else if (activeRevision.length === 0) {
      missing.push(
        `revision activa de '${worker}' (revisa 'az extension add --name containerapp' y tus permisos sobre el Container App)`,
      )
    }
  }
  if (missing.length > 0) {
    throw new CliError(
      [
        `ERROR: no se encontraron los siguientes recursos en el resource group '${rg}':`,
        ...missing.map((resource) => `  - ${resource}`),
      ].join('\n'),
    )
  }

  // Un dominio que es sufijo de otro matchea el patron laxo: ante mas de un candidato se
  // aborta en vez de reiniciar el primero.
  if (functionApps.length > 1) {
    throw new CliError(
      [
        `ERROR: el dominio '${domain}' matchea mas de una Function App en '${rg}':`,
        ...words(functionApps.join('\n')).map((name) => `  - ${name}`),
        '  Ambiguo: este script reiniciaria la equivocada. Renombra o desambigua antes de purgar.',
      ].join('\n'),
    )
  }

  output.out(
    `Postgres: ${pgServer} | Key Vault: ${keyVault} | Function App: ${functionApp}${worker.length > 0 ? ` | Worker: ${worker}` : ''}`,
  )

  // La regla de firewall solo acepta IPv4: un cuerpo HTML de error o una IPv6 se descartan.
  let operatorIp = ''
  for (const endpoint of IP_ENDPOINTS) {
    const response = await run('curl', ['-fsS', '--max-time', '10', endpoint])
    const ip = response.status === 0 ? response.stdout.replace(/[ \t\n\v\f\r]/g, '') : ''
    if (IPV4.test(ip)) {
      operatorIp = ip
      break
    }
  }
  if (operatorIp.length === 0) {
    throw new CliError(
      'ERROR: no se pudo determinar la IPv4 publica del operador (necesaria para la regla de firewall temporal).',
    )
  }

  const ruleName = `purge-store-temp-${deps.pid}`
  const firewallRule = ['--resource-group', rg, '--name', pgServer, '--rule-name', ruleName]
  let firewallOpened = false

  try {
    try {
      output.out(`Abriendo regla de firewall temporal para ${operatorIp}...`)
      await must('az', [
        'postgres',
        'flexible-server',
        'firewall-rule',
        'create',
        ...firewallRule,
        '--start-ip-address',
        operatorIp,
        '--end-ip-address',
        operatorIp,
      ])
      firewallOpened = true

      const secret = await must('az', [
        'keyvault',
        'secret',
        'show',
        '--vault-name',
        keyVault,
        '--name',
        'marten-connection',
        '--query',
        'value',
        '-o',
        'tsv',
      ])
      const connection = parseConnection(chomp(secret.stdout))
      if (
        connection.host.length === 0 ||
        connection.database.length === 0 ||
        connection.user.length === 0 ||
        connection.password.length === 0
      ) {
        throw new CliError(
          [
            "ERROR: no se pudo parsear el secreto 'marten-connection' (formato esperado:",
            '  Host=...;Database=...;Username=...;Password=...;SSL Mode=...).',
          ].join('\n'),
        )
      }

      // La clave viaja solo en el entorno de psql: nunca en un argumento ni en la salida.
      const psqlEnv = { ...deps.env, PGPASSWORD: connection.password }
      let conninfo = `host=${connection.host} dbname=${connection.database} user=${connection.user} sslmode=${connection.sslMode}`
      if (connection.port.length > 0) conninfo += ` port=${connection.port}`
      const scalar = async (sql: string): Promise<string> =>
        chomp((await must('psql', [conninfo, '-tAc', sql], psqlEnv)).stdout)

      // Un count(*) sobre una tabla ausente aborta la consulta: se comprueba existencia primero
      // para reportar un schema a medias en vez de un error crudo de psql.
      const countRows = async (table: string): Promise<string> => {
        const exists = await run(
          'psql',
          [conninfo, '-tAc', `SELECT to_regclass('"${schema}"."${table}"') IS NOT NULL`],
          psqlEnv,
        )
        output.writeErr(exists.stderr)
        if (chomp(exists.stdout) !== 't') return 'n/a (tabla ausente)'
        return scalar(`SELECT count(*) FROM "${schema}"."${table}"`)
      }

      const schemaExists = await scalar(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = '${schema}'`,
      )
      if (schemaExists !== '1') {
        output.out(`El schema '${schema}' no existe en ${connection.database}: no hay nada que purgar.`)
        return 0
      }

      if (options.dryRun) {
        const streams = await countRows('mt_streams')
        const checkpoints = await countRows('mt_event_progression')
        const readModelTables = await scalar(
          `SELECT count(*) FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name LIKE 'mt_doc_%'`,
        )
        output.out('')
        output.out(`=== DRY RUN: dominio '${domain}' (schema "${schema}") en ${rg} ===`)
        output.out(`  streams (mt_streams):                          ${streams}`)
        output.out(`  tablas de read model (mt_doc_%):               ${readModelTables}`)
        output.out(`  checkpoints del daemon (mt_event_progression): ${checkpoints}`)
        output.out('')
        output.out(`Nada se purgo. Sin --dry-run, este comando ejecuta 'DROP SCHEMA "${schema}" CASCADE'`)
        output.out(
          `y reinicia el Function App del dominio${worker.length > 0 ? ' y el worker de proyecciones' : ''}.`,
        )
        return 0
      }

      output.out(`Purgando schema "${schema}" (DROP SCHEMA ... CASCADE)...`)
      const dropped = await must(
        'psql',
        [conninfo, '-v', 'ON_ERROR_STOP=1', '-c', `DROP SCHEMA "${schema}" CASCADE;`],
        psqlEnv,
      )
      output.writeOut(dropped.stdout)

      if (worker.length > 0) {
        output.out(`Reiniciando worker de proyecciones (${worker}, revision ${activeRevision})...`)
        await must('az', [
          'containerapp',
          'revision',
          'restart',
          '--name',
          worker,
          '--resource-group',
          rg,
          '--revision',
          activeRevision,
        ])
      }

      output.out(`Reiniciando Function App del dominio (${functionApp})...`)
      await must('az', ['functionapp', 'restart', '--name', functionApp, '--resource-group', rg])

      output.out('')
      output.out(`OK: schema "${schema}" purgado. AutoCreateSchemaObjects lo recreara limpio en la`)
      output.out('  primera escritura tras el reinicio (MEF-ADR-0034).')
      return 0
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      if (error.message.length > 0) output.err(error.message)
      return error.exitCode
    }
  } finally {
    // Tambien tras INT o TERM: una senal a mitad de la purga no deja la regla abierta (CA-4).
    if (firewallOpened) {
      await deps.run(
        'az',
        ['postgres', 'flexible-server', 'firewall-rule', 'delete', ...firewallRule, '--yes'],
        {
          cwd: deps.cwd,
        },
      )
    }
  }
}

export async function purgeStore(argv: string[], deps: PurgeDeps): Promise<number> {
  try {
    return await purge(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) deps.output.err(error.message)
    return error.exitCode
  }
}

/** Como `capture`, sin bloquear el proceso: asi una senal se atiende mientras el comando corre. */
export function captureAsync(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const target = spawnTarget(command, args, options.env ?? process.env)
  return new Promise((done) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(target.command, target.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: target.verbatim,
    })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', () => done({ status: null, stdout, stderr }))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

if (isEntryPoint(import.meta.url)) {
  // Con un manejador, la senal no mata el proceso: el comando en curso termina y despues
  // se cierra la regla de firewall.
  let signal: number | null = null
  process.on('SIGINT', () => {
    signal ??= 130
  })
  process.on('SIGTERM', () => {
    signal ??= 143
  })
  process.exitCode = await purgeStore(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    program: fileURLToPath(import.meta.url),
    pid: process.pid,
    hasCommand: commandExists,
    run: captureAsync,
    interrupted: () => signal,
    output: new Output(true),
  })
}
