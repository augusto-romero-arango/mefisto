// appinsights-query.mts - Consultas KQL predefinidas contra Application Insights
//
// Uso:
//   node scripts/appinsights-query.mts exceptions
//   node scripts/appinsights-query.mts dead-letters
//   node scripts/appinsights-query.mts function-errors
//   node scripts/appinsights-query.mts traces --filter "NullReferenceException"
//   node scripts/appinsights-query.mts health-summary
//   node scripts/appinsights-query.mts exceptions --hours 48
//
// Requiere: az cli con sesion activa (az login)
// Configuracion: <raiz del consumidor>/.mefisto/appinsights.env (solo nombres de recursos, sin
//   secretos, versionable): APPINSIGHTS_APP, APPINSIGHTS_RG, SERVICEBUS_NAMESPACE,
//   SERVICEBUS_RG, FUNCTIONAPP_NAMES. Se lee como asignaciones CLAVE=valor; no se ejecuta.
// Auditoria de 'custom': .mefisto/pipeline/kql-audit.log (MEF-ADR-0053).

import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  Output,
  chomp,
  consumerRoot,
  exitCodeOf,
  exitWith,
  lines,
  parseJson,
  words,
} from './lib/azure-cli.mts'
import type { Run } from './lib/azure-cli.mts'
import { COLOR, capture, isEntryPoint } from './lib/cli.mts'
import type { CommandResult } from './lib/cli.mts'
import { statePath } from './lib/state.mts'

export interface QueryDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  run: Run
  now: () => Date
  output: Output
}

const MAX_ROWS = 50
const PLAN_ID =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/serverfarms\/[^/]+$/i

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function envValue(rest: string): string {
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1)
    return end === -1 ? rest.slice(1) : rest.slice(1, end)
  }
  if (!rest.startsWith('"')) return /^[^ \t]*/.exec(rest)?.[0] ?? ''
  let value = ''
  for (let i = 1; i < rest.length; i++) {
    const char = rest[i] ?? ''
    if (char === '"') break
    const next = rest[i + 1]
    if (char === '\\' && next !== undefined && '"\\$`'.includes(next)) {
      value += next
      i++
    } else {
      value += char
    }
  }
  return value
}

/**
 * Asignaciones `CLAVE=valor` de un archivo de entorno: con `export` opcional, comillas simples
 * o dobles y comentarios. No expande variables ni ejecuta nada.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of lines(text)) {
    const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match === null) continue
    values[match[1] ?? ''] = envValue(match[2] ?? '')
  }
  return values
}

/** Los guardrails de una query ad-hoc: ventana de 1h si no trae `ago(` y `take 20` si no trae `take`. */
export function guardCustomQuery(query: string): string {
  let guarded = query
  if (!/ago\(/i.test(guarded)) {
    guarded = guarded.includes('|')
      ? chomp(
          lines(guarded)
            .map((line) => line.replace('|', '| where timestamp > ago(1h) |'))
            .join('\n'),
        )
      : `${guarded} | where timestamp > ago(1h)`
  }
  return /take/i.test(guarded) ? guarded : `${guarded} | take 20`
}

function tsvEscape(cell: string): string {
  return cell.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
}

function scalarText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Las filas de la tabla de una respuesta de `az monitor app-insights query`, encabezado
 * incluido, o `null` si no trae `.tables[0].columns` y `.tables[0].rows` como arrays. Una celda
 * vacia queda como `-` y una columna `dynamic` (objeto o array), como su JSON.
 */
export function queryTable(response: string): string[][] | null {
  const root = parseJson(response)?.value
  if (!isRecord(root) || !Array.isArray(root.tables)) return null
  const table: unknown = root.tables[0]
  if (!isRecord(table) || !Array.isArray(table.rows) || !Array.isArray(table.columns)) return null
  const header = (table.columns as unknown[]).map((column) => {
    const name = isRecord(column) ? column.name : null
    return name === null || name === undefined ? '' : tsvEscape(scalarText(name))
  })
  const rows: string[][] = []
  for (const row of table.rows as unknown[]) {
    if (!Array.isArray(row) && !isRecord(row)) return null
    rows.push(
      Object.values(row as object).map((cell: unknown) =>
        cell === null || cell === '' ? '-' : tsvEscape(scalarText(cell)),
      ),
    )
  }
  return [header, ...rows]
}

/** Columnas alineadas a dos espacios, como `column -t`; la ultima celda de cada fila no se rellena. */
export function formatTable(rows: string[][]): string[] {
  const width = (cell: string): number => [...cell].length
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, width(cell))
    })
  }
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : cell + ' '.repeat((widths[index] ?? 0) - width(cell) + 2),
      )
      .join(''),
  )
}

// Los reportes de Service Bus y de Function Apps salian de python3: se conserva su formato.

/** `len()` de Python; 0 donde Python no tiene longitud. */
function pyLen(value: unknown): number {
  if (typeof value === 'string') return [...value].length
  if (Array.isArray(value)) return value.length
  return isRecord(value) ? Object.keys(value).length : 0
}

function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return Boolean(value)
}

/** `json.dumps(value, ensure_ascii=False)`: separadores `, ` y `: `. */
function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`)
    return `{${entries.join(', ')}}`
  }
  return JSON.stringify(value)
}

function pyStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return pyJson(value)
}

/** Lineas del peek de una DLQ; si `messages` no es una lista de mensajes, lo ya formateado y `messages` crudo. */
export function peekReport(messages: string): string[] {
  const parsed = parseJson(messages)?.value
  if (pyLen(parsed) === 0) return ['  (vacio)']
  if (!Array.isArray(parsed)) return [messages]
  const report: string[] = []
  for (const [index, message] of (parsed as unknown[]).entries()) {
    if (!isRecord(message)) return [...report, messages]
    const body = Object.hasOwn(message, 'body') ? message.body : '(sin body)'
    const props = Object.hasOwn(message, 'applicationProperties') ? message.applicationProperties : {}
    const reason = Object.hasOwn(message, 'deadLetterReason') ? message.deadLetterReason : '(sin razon)'
    report.push(`  [${index + 1}] reason=${pyStr(reason)}`)
    if (pyTruthy(props)) report.push(`      props=${pyJson(props)}`)
    const text = [...(typeof body === 'string' ? body : pyJson(body))]
    report.push(`      body=${text.length > 200 ? `${text.slice(0, 200).join('')}...` : text.join('')}`)
  }
  return report
}

/** Estado de una Function App segun `az functionapp show`; `unknown` si la salida no es un objeto. */
export function functionAppState(status: string): string {
  const parsed = parseJson(status)?.value
  if (!isRecord(parsed)) return 'unknown'
  return Object.hasOwn(parsed, 'state') ? pyStr(parsed.state) : 'unknown'
}

/** Conteo y lineas de las funciones registradas; ante una entrada ilegible, lo ya formateado y `functions` crudo. */
export function functionsReport(functions: string): { count: number; report: string[] } {
  const parsed = parseJson(functions)?.value
  const count = pyLen(parsed)
  if (count === 0) return { count, report: [] }
  if (!Array.isArray(parsed)) return { count, report: [functions] }
  const report: string[] = []
  for (const entry of parsed as unknown[]) {
    if (!isRecord(entry)) return { count, report: [...report, functions] }
    const name = Object.hasOwn(entry, 'name') ? entry.name : '?'
    if (typeof name !== 'string') return { count, report: [...report, functions] }
    const disabled = Object.hasOwn(entry, 'isDisabled') ? entry.isDisabled : false
    report.push(`    - ${name.split('/').at(-1) ?? ''} (${pyTruthy(disabled) ? 'DISABLED' : 'ok'})`)
  }
  return { count, report }
}

/** Campos de `IFS=',' read -ra`: una coma final no abre un campo vacio. */
function commaFields(value: string): string[] {
  const fields = (lines(value)[0] ?? '').split(',')
  if (fields.at(-1) === '') fields.pop()
  return fields
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(time: Date): string {
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

function run(argv: string[], deps: QueryDeps): number {
  const { output } = deps
  const root = consumerRoot(deps.cwd, [
    'ERROR: scripts/appinsights-query.mts es del plugin publicado y solo aplica al consumidor.',
    'Mefisto no tiene entorno desplegado ni App Insights.',
  ])

  const log = (message: string): void =>
    output.out(`${COLOR.blue}[${clock(deps.now())}]${COLOR.reset} ${message}`)
  const success = (message: string): void =>
    output.out(`${COLOR.green}${COLOR.bold}ok${COLOR.reset} ${message}`)
  const warn = (message: string): void => output.out(`${COLOR.yellow}!${COLOR.reset} ${message}`)
  const error = (message: string): void =>
    output.err(`${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} ${message}`)
  const fail = (message: string, ...hints: string[]): never => {
    error(message)
    for (const hint of hints) output.out(hint)
    return exitWith(1)
  }
  const section = (title: string): void => {
    output.out('')
    output.out(`${COLOR.cyan}${COLOR.bold}--- ${title} ---${COLOR.reset}`)
  }

  const envFile = join(root, '.mefisto', 'appinsights.env')
  if (!isFile(envFile)) {
    error(`No se encontro ${envFile}`)
    output.out('  Crea ese archivo con los nombres de recursos (sin secretos):')
    output.out('    APPINSIGHTS_APP=<nombre del App Insights>')
    output.out('    APPINSIGHTS_RG=<resource group del App Insights y las Function Apps>')
    output.out('    SERVICEBUS_NAMESPACE=<namespace de Service Bus>')
    output.out('    SERVICEBUS_RG=<resource group de Service Bus>')
    output.out('    FUNCTIONAPP_NAMES=<function apps separadas por coma>')
    const legacyEnv = join(root, 'scripts', '.env')
    if (
      isFile(legacyEnv) &&
      lines(readFileSync(legacyEnv, 'utf8')).some((line) => line.startsWith('APPINSIGHTS_APP='))
    ) {
      output.out('')
      warn(`Se encontro una configuracion legacy en ${legacyEnv} (ya no se lee desde 0.40.0).`)
      output.out('  Muevela con (el script no la mueve ni la copia por ti):')
      output.out('    mkdir -p .mefisto && mv scripts/.env .mefisto/appinsights.env')
    }
    return 1
  }
  const declared = parseEnvFile(readFileSync(envFile, 'utf8'))
  /** Lo declarado en el archivo y, si no lo declara, lo heredado del entorno. */
  const setting = (name: string): string =>
    (Object.hasOwn(declared, name) ? declared[name] : deps.env[name]) ?? ''

  const call = (args: string[]): CommandResult => deps.run('az', args, { cwd: deps.cwd })
  /** `$(az ... 2>&1)`. */
  const merged = (result: CommandResult): string => chomp(result.stdout + result.stderr)
  /** `az` sin capturar, como ultimo paso: el script termina con su codigo. */
  const passthrough = (args: string[]): number => {
    const result = call(args)
    output.writeOut(result.stdout)
    output.writeErr(result.stderr)
    return result.status ?? 1
  }

  if (call(['account', 'show']).status !== 0) {
    return fail("No hay sesion activa de Azure CLI. Ejecuta 'az login' primero.")
  }

  const command = argv[0] ?? ''
  if (command.length === 0) {
    for (const line of [
      `${COLOR.cyan}${COLOR.bold}appinsights-query.mts${COLOR.reset} - Consultas KQL contra App Insights`,
      '',
      'Comandos KQL (App Insights):',
      '  exceptions         Top 20 excepciones agrupadas por tipo y mensaje',
      '  dead-letters       Mensajes dead-lettered en traces',
      '  function-errors    Funciones con requests fallidas',
      '  traces             Traces (usar con --filter para filtrar)',
      '  health-summary     Vista rapida: excepciones + requests fallidas + disponibilidad',
      '',
      'Comandos ad-hoc:',
      '  custom "QUERY"    Query KQL ad-hoc con guardrails (take 20, ventana 1h)',
      '                     Ej: custom "exceptions | where type has \'NullRef\' | take 5"',
      '',
      'Comandos Azure Resource Manager:',
      '  servicebus-dlq     Conteo de dead letters por subscription en Service Bus',
      '  servicebus-dlq-peek  Peek a mensajes en DLQ sin consumirlos (max 5)',
      '  function-status    Estado y funciones registradas de cada Function App',
      '  plan-sites PLAN_ID Cantidad de sitios (numberOfSites) de un App Service Plan (solo lectura)',
      '  plan-metrics PLAN_ID  Metricas del plan (solo lectura; --metric, --hours)',
      '                     PLAN_ID: /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Web/serverfarms/<plan>',
      '',
      'Opciones:',
      '  --hours N          Ventana temporal en horas (default: 24, solo KQL)',
      "  --filter TEXT      Filtrar por texto (solo para 'traces')",
      "  --metric LISTA     Metricas separadas por coma (solo 'plan-metrics', default: CpuPercentage,MemoryPercentage)",
    ]) {
      output.out(line)
    }
    return 1
  }

  const rest = argv.slice(1)
  const positional = (): string => {
    const first = rest[0]
    return first !== undefined && !first.startsWith('--') ? (rest.shift() ?? '') : ''
  }
  const customArg = command === 'custom' ? positional() : ''
  const planId = command === 'plan-sites' || command === 'plan-metrics' ? positional() : ''

  let hours = '24'
  let filter = ''
  let metrics = 'CpuPercentage,MemoryPercentage'
  for (let i = 0; i < rest.length; i += 2) {
    const option = rest[i] ?? ''
    const value = rest[i + 1] ?? ''
    if (option === '--hours') {
      if (value.length === 0) return fail('--hours requiere un valor numerico')
      hours = value
    } else if (option === '--metric') {
      if (value.length === 0) return fail('--metric requiere una lista de metricas')
      metrics = value
    } else if (option === '--filter') {
      if (value.length === 0) return fail('--filter requiere un valor de texto')
      filter = value
    } else {
      return fail(`Opcion desconocida: ${option}`)
    }
  }

  const runQuery = (query: string, description: string): void => {
    const app = setting('APPINSIGHTS_APP')
    const resourceGroup = setting('APPINSIGHTS_RG')
    if (app.length === 0) fail(`Variable APPINSIGHTS_APP no definida en ${envFile}`)
    if (resourceGroup.length === 0) fail(`Variable APPINSIGHTS_RG no definida en ${envFile}`)

    log(`${description} (ultimas ${hours}h)`)

    // JSON y no table: el renderer de table de az puede no imprimir nada y salir con 0, una
    // averia indistinguible de un resultado vacio (issue #649).
    const answer = call([
      'monitor',
      'app-insights',
      'query',
      '--app',
      app,
      '--resource-group',
      resourceGroup,
      '--analytics-query',
      query,
      '--output',
      'json',
    ])
    const result = merged(answer)
    if (answer.status !== 0) {
      error('Fallo la consulta KQL')
      output.err(result)
      exitWith(1)
    }
    const table = queryTable(result)
    if (table === null) {
      error('La respuesta de az no tiene la forma esperada (.tables[0].columns / .tables[0].rows)')
      output.err(result)
      return exitWith(1)
    }
    const rowCount = table.length - 1
    if (rowCount === 0) {
      warn('Resultado vacio: 0 filas en la ventana consultada (no hay evidencia, no es una averia)')
      return
    }
    for (const line of formatTable(table)) output.out(line)
    success(`Consulta completada (${rowCount} filas)`)
  }

  const requirePlanId = (): void => {
    if (planId.length === 0) fail(`'${command}' requiere el resource id ARM del App Service Plan`)
    if (!lines(planId).some((line) => PLAN_ID.test(line))) {
      error(`PLAN_ID mal formado: ${planId}`)
      output.err(
        '  Forma esperada: /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Web/serverfarms/<plan>',
      )
      exitWith(1)
    }
  }

  /** Namespace y resource group de Service Bus, y sus topics; aborta si falta alguno. */
  const serviceBus = (title: string): { scope: string[]; topics: string[] } => {
    const namespace = setting('SERVICEBUS_NAMESPACE')
    const resourceGroup = setting('SERVICEBUS_RG')
    if (namespace.length === 0) {
      fail(
        `Variable SERVICEBUS_NAMESPACE no definida en ${envFile}`,
        `  Agrega SERVICEBUS_NAMESPACE al archivo ${envFile}`,
      )
    }
    if (resourceGroup.length === 0) {
      fail(`Variable SERVICEBUS_RG no definida en ${envFile}`, `  Agrega SERVICEBUS_RG al archivo ${envFile}`)
    }
    log(`${title} en Service Bus namespace: ${namespace}`)
    const scope = ['--namespace-name', namespace, '--resource-group', resourceGroup]
    const listed = call(['servicebus', 'topic', 'list', ...scope, '--query', '[].name', '-o', 'tsv'])
    const topics = merged(listed)
    if (listed.status !== 0) {
      error('Fallo al listar topics de Service Bus')
      output.err(topics)
      exitWith(1)
    }
    if (topics.length === 0) warn(`No se encontraron topics en el namespace ${namespace}`)
    return { scope, topics: words(topics) }
  }
  /** Subscriptions de `topic`, o `null` tras avisar de que no se pudieron listar. */
  const subscriptions = (scope: string[], topic: string): string[] | null => {
    const listed = call([
      'servicebus',
      'topic',
      'subscription',
      'list',
      ...scope,
      '--topic-name',
      topic,
      '--query',
      '[].name',
      '-o',
      'tsv',
    ])
    if (listed.status !== 0) {
      warn(`Fallo al listar subscriptions del topic ${topic}`)
      return null
    }
    return words(merged(listed))
  }

  switch (command) {
    case 'exceptions':
      runQuery(
        `exceptions | where timestamp > ago(${hours}h) | summarize count() by type, outerMessage | order by count_ desc | take 20`,
        'Top 20 excepciones agrupadas por tipo y mensaje',
      )
      return 0

    case 'dead-letters':
      runQuery(
        `traces | where timestamp > ago(${hours}h) | where message has 'dead' or message has 'deadletter' or message has 'Dead' | project timestamp, message, operation_Name | order by timestamp desc | take ${MAX_ROWS}`,
        'Mensajes dead-lettered en traces',
      )
      return 0

    case 'function-errors':
      runQuery(
        `requests | where timestamp > ago(${hours}h) | where success == false | summarize failedCount=count() by name, resultCode | order by failedCount desc | take ${MAX_ROWS}`,
        'Funciones con requests fallidas',
      )
      return 0

    case 'traces':
      if (filter.length > 0) {
        runQuery(
          `traces | where timestamp > ago(${hours}h) | where message has '${filter.replaceAll("'", "\\'")}' | project timestamp, message, severityLevel, operation_Name | order by timestamp desc | take ${MAX_ROWS}`,
          `Traces filtradas por '${filter}'`,
        )
      } else {
        runQuery(
          `traces | where timestamp > ago(${hours}h) | project timestamp, message, severityLevel, operation_Name | order by timestamp desc | take ${MAX_ROWS}`,
          'Todas las traces',
        )
      }
      return 0

    case 'health-summary':
      log(`Health summary (ultimas ${hours}h)`)
      section('Excepciones')
      runQuery(
        `exceptions | where timestamp > ago(${hours}h) | summarize totalExceptions=count(), distinctTypes=dcount(type) | project totalExceptions, distinctTypes`,
        'Resumen de excepciones',
      )
      section('Requests fallidas')
      runQuery(
        `requests | where timestamp > ago(${hours}h) | summarize totalRequests=count(), failedRequests=countif(success == false), availabilityPct=round(100.0 * countif(success == true) / count(), 2)`,
        'Resumen de requests',
      )
      section('Top 5 errores')
      runQuery(
        `exceptions | where timestamp > ago(${hours}h) | summarize count() by type | order by count_ desc | take 5`,
        'Top 5 tipos de error',
      )
      success('Health summary completado')
      return 0

    case 'servicebus-dlq': {
      const { scope, topics } = serviceBus('Conteo de dead letters')
      for (const topic of topics) {
        for (const subscription of subscriptions(scope, topic) ?? []) {
          const shown = call([
            'servicebus',
            'topic',
            'subscription',
            'show',
            ...scope,
            '--topic-name',
            topic,
            '--name',
            subscription,
            '--query',
            'countDetails.deadLetterMessageCount',
            '-o',
            'tsv',
          ])
          if (shown.status !== 0) {
            warn(`Fallo al consultar subscription ${topic}/${subscription}`)
            continue
          }
          const count = merged(shown)
          if (/^[ \t]*[+-]?[0-9]+[ \t]*$/.test(count) && Number(count) > 0) {
            output.out(
              `${COLOR.red}${COLOR.bold}DLQ${COLOR.reset} ${topic}/${subscription}: ${COLOR.red}${count}${COLOR.reset} mensajes`,
            )
          } else {
            output.out(`${COLOR.green}ok${COLOR.reset}  ${topic}/${subscription}: ${count} mensajes`)
          }
        }
      }
      success('Consulta de dead letters completada')
      return 0
    }

    case 'servicebus-dlq-peek': {
      const { scope, topics } = serviceBus('Peek a dead letters')
      for (const topic of topics) {
        for (const subscription of subscriptions(scope, topic) ?? []) {
          section(`${topic}/${subscription}/$deadletterqueue`)
          const received = call([
            'servicebus',
            'topic',
            'subscription',
            'receive',
            ...scope,
            '--topic-name',
            topic,
            '--subscription-name',
            subscription,
            '--is-dead-letter-queue',
            'true',
            '--peek-lock',
            '--max-messages',
            '5',
            '--output',
            'json',
          ])
          if (received.status !== 0) {
            warn(`Fallo al hacer peek en ${topic}/${subscription} DLQ`)
            continue
          }
          for (const line of peekReport(merged(received))) output.out(line)
        }
      }
      success('Peek de dead letters completado')
      return 0
    }

    case 'function-status': {
      const names = setting('FUNCTIONAPP_NAMES')
      const resourceGroup = setting('APPINSIGHTS_RG')
      if (names.length === 0) {
        fail(
          `Variable FUNCTIONAPP_NAMES no definida en ${envFile}`,
          `  Agrega FUNCTIONAPP_NAMES al archivo ${envFile}`,
        )
      }
      if (resourceGroup.length === 0) {
        fail(
          `Variable APPINSIGHTS_RG no definida en ${envFile} (usada como resource group de las Function Apps)`,
          `  Agrega APPINSIGHTS_RG al archivo ${envFile}`,
        )
      }
      log('Estado de Azure Functions')
      for (const field of commaFields(names)) {
        const app = words(field).join(' ')
        section(app)
        const shown = call([
          'functionapp',
          'show',
          '--name',
          app,
          '--resource-group',
          resourceGroup,
          '--query',
          '{state:state, defaultHostName:defaultHostName, kind:kind}',
          '--output',
          'json',
        ])
        if (shown.status !== 0) {
          warn(`Fallo al consultar Function App ${app}`)
          output.err(merged(shown))
          continue
        }
        const state = functionAppState(merged(shown))
        const color = state === 'Running' ? COLOR.green : COLOR.red
        output.out(`  Estado: ${color}${COLOR.bold}${state}${COLOR.reset}`)

        const listed = call([
          'functionapp',
          'function',
          'list',
          '--name',
          app,
          '--resource-group',
          resourceGroup,
          '--query',
          '[].{name:name, isDisabled:isDisabled}',
          '--output',
          'json',
        ])
        if (listed.status !== 0) {
          warn(`Fallo al listar funciones de ${app}`)
          continue
        }
        const functions = functionsReport(merged(listed))
        output.out(`  Funciones registradas: ${functions.count}`)
        for (const line of functions.report) output.out(line)
      }
      success('Consulta de estado de Functions completada')
      return 0
    }

    case 'plan-sites':
      requirePlanId()
      return passthrough([
        'appservice',
        'plan',
        'show',
        '--ids',
        planId,
        '--query',
        'numberOfSites',
        '--output',
        'tsv',
      ])

    case 'plan-metrics':
      requirePlanId()
      if (!/^[0-9]+$/.test(hours) || Number(hours) < 1) fail('--hours debe ser un entero positivo')
      return passthrough([
        'monitor',
        'metrics',
        'list',
        '--resource',
        planId,
        '--metric',
        metrics.replaceAll(',', ' '),
        '--offset',
        `${hours}h`,
        '--interval',
        'PT1H',
        '--output',
        'json',
      ])

    case 'custom': {
      if (customArg.length === 0) {
        fail(
          "El comando 'custom' requiere una query KQL como argumento",
          '  Ejemplo: node scripts/appinsights-query.mts custom "exceptions | where type has \'NullRef\' | take 5"',
        )
      }
      output.err(
        `${COLOR.yellow}ADVERTENCIA: query ad-hoc. Daily cap: 0.5GB. Respeta el daily cap configurado por el proyecto consumidor (ver su ADR de control de costos de App Insights).${COLOR.reset}`,
      )
      const query = guardCustomQuery(customArg)

      const stateDir = deps.env.MEFISTO_STATE_DIR ?? ''
      const auditLog =
        stateDir.length > 0
          ? statePath('kql-audit.log', undefined, deps.env)
          : statePath('kql-audit.log', root)
      const now = deps.now()
      const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      appendFileSync(auditLog, `[${day} ${clock(now)}] QUERY: ${query}\n`)

      // La ventana real de una query ad-hoc es de 1h, y es la que anuncia el log.
      hours = '1'
      runQuery(query, 'Query ad-hoc')
      return 0
    }

    default:
      return fail(
        `Comando desconocido: ${command}`,
        'Ejecuta sin argumentos para ver los comandos disponibles.',
      )
  }
}

export function appinsightsQuery(argv: string[], deps: QueryDeps): number {
  return exitCodeOf(deps.output, () => run(argv, deps))
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = appinsightsQuery(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    run: capture,
    now: () => new Date(),
    output: new Output(true),
  })
}
