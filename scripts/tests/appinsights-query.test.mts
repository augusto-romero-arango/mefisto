import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  appinsightsQuery,
  formatTable,
  functionAppState,
  functionsReport,
  guardCustomQuery,
  parseEnvFile,
  peekReport,
  queryTable,
} from '../appinsights-query.mts'
import { Output } from '../lib/azure-cli.mts'
import { COLOR } from '../lib/cli.mts'
import {
  DIST_SCRIPTS,
  FakeCli,
  REPO_ROOT,
  SCRIPTS,
  assertDistributed,
  option,
  runScript,
  sandbox,
  starts,
  writeFile,
} from './azure-cli-sandbox.mts'
import type { Call, Respond, Sandbox } from './azure-cli-sandbox.mts'

const SCRIPT = join(SCRIPTS, 'appinsights-query.mts')
const PLAN =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Web/serverfarms/plan1'
const ENV_KEYS = [
  'APPINSIGHTS_APP',
  'APPINSIGHTS_RG',
  'SERVICEBUS_NAMESPACE',
  'SERVICEBUS_RG',
  'FUNCTIONAPP_NAMES',
]
const FULL_ENV = `APPINSIGHTS_APP=app-consumidor
APPINSIGHTS_RG=rg-consumidor
SERVICEBUS_NAMESPACE=sb
SERVICEBUS_RG=rg-sb
FUNCTIONAPP_NAMES=fa1
`
const ROWS =
  '{"tables":[{"columns":[{"name":"type"},{"name":"count_"}],"name":"PrimaryResult","rows":[["System.TimeoutException",13],["System.NullReferenceException",2]]}]}'
const NOW = new Date(2026, 0, 2, 3, 4, 5)

let box: Sandbox
let repos = 0

before(() => {
  box = sandbox('appinsights')
})

after(() => {
  box.remove()
})

function consumer(envFile: string | null = FULL_ENV): string {
  const repo = box.repo(`consumidor-${++repos}`)
  if (envFile !== null) writeFile(join(repo, '.mefisto', 'appinsights.env'), envFile)
  return repo
}

/** Todos los archivos del repo, sin `.git`, con su contenido. */
function tree(repo: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[relative(repo, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(repo)
  return files
}

/** `az` que responde `response` a la consulta KQL y exito sin salida a lo demas. */
function answering(response: string, status = 0): Respond {
  return (call) =>
    starts(call, 'az', 'monitor', 'app-insights', 'query') ? { status, stdout: `${response}\n` } : undefined
}

interface Result {
  status: number
  out: string
  stdout: string
  stderr: string
  cli: FakeCli
}

function query(
  argv: string[],
  cwd: string,
  respond: Respond = answering(ROWS),
  env: NodeJS.ProcessEnv = {},
): Result {
  const cli = new FakeCli(respond)
  const output = new Output()
  const status = appinsightsQuery(argv, { cwd, env, run: cli.run, now: () => NOW, output })
  return { status, out: output.all, stdout: output.stdout, stderr: output.stderr, cli }
}

const kql = (result: Result): string[] =>
  result.cli.calls.filter((call) => call.args[2] === 'query').map((call) => option(call, '--analytics-query'))

describe('configuracion del consumidor', () => {
  test('sin .mefisto/appinsights.env sale en 1 listando las cinco claves', () => {
    const repo = consumer(null)
    const result = query(['exceptions'], repo)
    assert.equal(result.status, 1)
    for (const key of ENV_KEYS) assert.ok(result.stdout.includes(`    ${key}=<`), key)
    assert.equal(
      result.stderr,
      `${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} No se encontro ${join(repo, '.mefisto', 'appinsights.env')}\n`,
    )
    assert.doesNotMatch(result.out, /template/)
    assert.deepEqual(result.cli.calls, [])
  })

  test('un scripts/.env legacy con APPINSIGHTS_APP se avisa sin tocar el arbol', () => {
    const repo = consumer(null)
    writeFile(join(repo, 'scripts', '.env'), 'OTRA=1\n')
    const unrelated = query(['exceptions'], repo)
    assert.equal(unrelated.status, 1)
    assert.doesNotMatch(unrelated.out, /legacy/)

    writeFile(join(repo, 'scripts', '.env'), 'APPINSIGHTS_APP=app-legacy\n')
    const before = tree(repo)
    const noticed = query(['exceptions'], repo)
    assert.equal(noticed.status, 1)
    assert.ok(
      noticed.stdout.endsWith(
        '\n' +
          `${COLOR.yellow}!${COLOR.reset} Se encontro una configuracion legacy en ${join(repo, 'scripts', '.env')} (ya no se lee desde 0.40.0).\n` +
          '  Muevela con (el script no la mueve ni la copia por ti):\n' +
          '    mkdir -p .mefisto && mv scripts/.env .mefisto/appinsights.env\n',
      ),
    )
    assert.match(noticed.stdout, /APPINSIGHTS_RG/)
    assert.deepEqual(tree(repo), before)

    rmSync(join(repo, 'scripts', '.env'))
    assert.doesNotMatch(query(['exceptions'], repo).out, /legacy/)
  })

  test('con el env presente no hay aviso aunque exista scripts/.env', () => {
    const repo = consumer()
    writeFile(join(repo, 'scripts', '.env'), 'APPINSIGHTS_APP=app-legacy\n')
    const result = query(['exceptions'], repo)
    assert.equal(result.status, 0)
    assert.doesNotMatch(result.out, /legacy/)
  })

  test('exceptions consulta el App Insights y el resource group del consumidor, en JSON', () => {
    const result = query(['exceptions'], consumer())
    assert.equal(result.status, 0)
    assert.deepEqual(result.cli.log, [
      'az account show',
      'az monitor app-insights query --app app-consumidor --resource-group rg-consumidor --analytics-query exceptions | where timestamp > ago(24h) | summarize count() by type, outerMessage | order by count_ desc | take 20 --output json',
    ])
    assert.ok(!readFileSync(SCRIPT, 'utf8').includes("'table'"))
  })

  test('una clave que el archivo no declara se toma del entorno', () => {
    const repo = consumer('APPINSIGHTS_APP=app-archivo\n')
    const fromEnv = query(['exceptions'], repo, answering(ROWS), {
      APPINSIGHTS_APP: 'app-entorno',
      APPINSIGHTS_RG: 'rg-entorno',
    })
    assert.equal(fromEnv.status, 0)
    assert.match(fromEnv.cli.log[1] ?? '', /--app app-archivo --resource-group rg-entorno /)

    const missing = query(['exceptions'], repo)
    assert.equal(missing.status, 1)
    assert.ok(
      missing.stderr.endsWith(
        `Variable APPINSIGHTS_RG no definida en ${join(repo, '.mefisto', 'appinsights.env')}\n`,
      ),
    )
  })

  test('sin sesion de az pide az login antes de mirar el comando', () => {
    const result = query([], consumer(), () => ({ status: 1 }))
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      `${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} No hay sesion activa de Azure CLI. Ejecuta 'az login' primero.\n`,
    )
    assert.equal(result.stdout, '')
  })

  test('parseEnvFile lee asignaciones con comillas, export y comentarios, sin ejecutar nada', () => {
    assert.deepEqual(
      parseEnvFile(
        [
          '# comentario',
          'A=uno',
          'export B="dos tres"',
          "C='cuatro # no es comentario'",
          'D=cinco # comentario',
          'E=',
          '  F=seis\r',
          'G="con \\"comillas\\" y \\\\ barra"',
          'no es una asignacion',
          'H=$(touch no-se-ejecuta)',
        ].join('\n'),
      ),
      {
        A: 'uno',
        B: 'dos tres',
        C: 'cuatro # no es comentario',
        D: 'cinco',
        E: '',
        F: 'seis',
        G: 'con "comillas" y \\ barra',
        H: '$(touch',
      },
    )
  })
})

describe('resultado de una consulta', () => {
  test('cero filas es un resultado vacio distinguible, con exit 0', () => {
    const empty =
      '{"tables":[{"columns":[{"name":"type"},{"name":"count_"}],"name":"PrimaryResult","rows":[]}]}'
    const result = query(
      ['custom', "exceptions | where timestamp > ago(1h) | where type == 'NoExisteEsteTipo'"],
      consumer(),
      answering(empty),
    )
    assert.equal(result.status, 0)
    assert.match(
      result.stdout,
      /Resultado vacio: 0 filas en la ventana consultada \(no hay evidencia, no es una averia\)\n$/,
    )
    assert.doesNotMatch(result.out, /Consulta completada/)
  })

  test('una respuesta que no es JSON o no trae columnas y filas es una averia', () => {
    const cases = [
      'esto no es JSON valido',
      '{"tables":[{"columns":[{"name":"type"}],"rows":"no-es-un-array"}]}',
      '{"tables":[{"name":"PrimaryResult","rows":[["System.TimeoutException",13]]}]}',
      '{"tables":[]}',
      '[]',
    ]
    for (const response of cases) {
      const result = query(['exceptions'], consumer(), answering(response))
      assert.equal(result.status, 1, response)
      assert.equal(
        result.stderr,
        `${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} La respuesta de az no tiene la forma esperada (.tables[0].columns / .tables[0].rows)\n${response}\n`,
      )
      assert.doesNotMatch(result.out, /Resultado vacio/)
    }
  })

  test('si az falla reporta la consulta fallida con su salida', () => {
    const result = query(['exceptions'], consumer(), (call) =>
      call.args[2] === 'query'
        ? { status: 2, stdout: '', stderr: 'ERROR: The Application Insights app was not found\n' }
        : undefined,
    )
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      `${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} Fallo la consulta KQL\nERROR: The Application Insights app was not found\n`,
    )
  })

  test('un aviso de az por stderr rompe la lectura, como con 2>&1', () => {
    const result = query(['exceptions'], consumer(), (call) =>
      call.args[2] === 'query'
        ? { stdout: `${ROWS}\n`, stderr: 'WARNING: extension desactualizada\n' }
        : undefined,
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no tiene la forma esperada/)
  })

  test('con filas imprime una tabla alineada y el conteo real', () => {
    const result = query(['exceptions'], consumer())
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      `${COLOR.blue}[03:04:05]${COLOR.reset} Top 20 excepciones agrupadas por tipo y mensaje (ultimas 24h)\n` +
        'type                           count_\n' +
        'System.TimeoutException        13\n' +
        'System.NullReferenceException  2\n' +
        `${COLOR.green}${COLOR.bold}ok${COLOR.reset} Consulta completada (2 filas)\n`,
    )
    assert.ok(!result.out.includes('{"tables"'))
  })

  test('una columna dynamic se serializa en vez de romper la fila', () => {
    const dynamic =
      '{"tables":[{"columns":[{"name":"type"},{"name":"details"}],"name":"PrimaryResult","rows":[["System.TimeoutException",[{"message":"Npgsql timeout","parsedStack":"at Marten"}]]]}]}'
    const result = query(['exceptions'], consumer(), answering(dynamic))
    assert.equal(result.status, 0)
    assert.ok(
      result.stdout.includes(
        '\ntype                     details\n' +
          'System.TimeoutException  [{"message":"Npgsql timeout","parsedStack":"at Marten"}]\n',
      ),
    )
  })

  test('una celda vacia mantiene alineada la columna siguiente', () => {
    const emptyCell =
      '{"tables":[{"columns":[{"name":"aaa"},{"name":"bbb"},{"name":"ccc"}],"name":"PrimaryResult","rows":[["x1",null,"z1"],["x2","","z2"]]}]}'
    const result = query(['exceptions'], consumer(), answering(emptyCell))
    assert.equal(result.status, 0)
    assert.match(result.stdout, /\naaa {2}bbb {2}ccc\nx1 {3}- {4}z1\nx2 {3}- {4}z2\n/)
  })

  test('queryTable escapa tabuladores y saltos, y deja en claro numeros y booleanos', () => {
    assert.deepEqual(
      queryTable(
        '{"tables":[{"columns":[{"name":"a"},{"name":null},{}],"rows":[["x\\ty\\nz",1.5,true],[false,0,"c:\\\\d"]]}]}',
      ),
      [
        ['a', '', ''],
        ['x\\ty\\nz', '1.5', 'true'],
        ['false', '0', 'c:\\\\d'],
      ],
    )
    assert.equal(queryTable('{"tables":[{"columns":[],"rows":["no es fila"]}]}'), null)
    assert.equal(queryTable('null'), null)
  })

  test('formatTable no rellena la ultima celda de cada fila', () => {
    assert.deepEqual(formatTable([['a', 'bb', 'c'], ['dddd', 'e'], ['f']]), ['a     bb  c', 'dddd  e', 'f'])
    assert.deepEqual(formatTable([]), [])
  })

  test('el script solo invoca az: ni jq ni column', () => {
    const result = query(['health-summary'], consumer())
    assert.equal(result.status, 0)
    assert.ok(result.cli.calls.every((call) => call.command === 'az'))
    assert.equal(kql(result).length, 3)
  })
})

describe('comandos KQL', () => {
  test('--hours cambia la ventana y --filter escapa las comillas simples', () => {
    const result = query(['traces', '--filter', "O'Brien", '--hours', '48'], consumer())
    assert.equal(result.status, 0)
    assert.deepEqual(kql(result), [
      "traces | where timestamp > ago(48h) | where message has 'O\\'Brien' | project timestamp, message, severityLevel, operation_Name | order by timestamp desc | take 50",
    ])
    assert.match(result.stdout, /Traces filtradas por 'O'Brien' \(ultimas 48h\)\n/)
  })

  test('traces sin filtro, dead-letters y function-errors usan sus queries', () => {
    const repo = consumer()
    assert.deepEqual(kql(query(['traces'], repo)), [
      'traces | where timestamp > ago(24h) | project timestamp, message, severityLevel, operation_Name | order by timestamp desc | take 50',
    ])
    assert.deepEqual(kql(query(['dead-letters'], repo)), [
      "traces | where timestamp > ago(24h) | where message has 'dead' or message has 'deadletter' or message has 'Dead' | project timestamp, message, operation_Name | order by timestamp desc | take 50",
    ])
    assert.deepEqual(kql(query(['function-errors'], repo)), [
      'requests | where timestamp > ago(24h) | where success == false | summarize failedCount=count() by name, resultCode | order by failedCount desc | take 50',
    ])
  })

  test('health-summary encadena sus tres consultas con sus titulos', () => {
    const result = query(['health-summary', '--hours', '6'], consumer())
    assert.equal(result.status, 0)
    assert.deepEqual(kql(result), [
      'exceptions | where timestamp > ago(6h) | summarize totalExceptions=count(), distinctTypes=dcount(type) | project totalExceptions, distinctTypes',
      'requests | where timestamp > ago(6h) | summarize totalRequests=count(), failedRequests=countif(success == false), availabilityPct=round(100.0 * countif(success == true) / count(), 2)',
      'exceptions | where timestamp > ago(6h) | summarize count() by type | order by count_ desc | take 5',
    ])
    const titles = result.stdout.split('\n').filter((line) => line.includes('---'))
    assert.deepEqual(
      titles,
      ['Excepciones', 'Requests fallidas', 'Top 5 errores'].map(
        (title) => `${COLOR.cyan}${COLOR.bold}--- ${title} ---${COLOR.reset}`,
      ),
    )
    assert.ok(
      result.stdout.endsWith(`${COLOR.green}${COLOR.bold}ok${COLOR.reset} Health summary completado\n`),
    )
  })

  test('sin comando imprime la ayuda con los comandos de plan y termina en 1', () => {
    const result = query([], consumer())
    assert.equal(result.status, 1)
    assert.ok(
      result.stdout.startsWith(
        `${COLOR.cyan}${COLOR.bold}appinsights-query.mts${COLOR.reset} - Consultas KQL contra App Insights\n\nComandos KQL (App Insights):\n`,
      ),
    )
    assert.match(result.stdout, /\n {2}plan-sites PLAN_ID /)
    assert.match(result.stdout, /\n {2}plan-metrics PLAN_ID /)
    assert.equal(result.stdout.split('\n').length, 26)
  })

  test('rechaza opciones sin valor, opciones desconocidas y comandos desconocidos', () => {
    const repo = consumer()
    const cases: [string[], string][] = [
      [['exceptions', '--hours'], '--hours requiere un valor numerico'],
      [['exceptions', '--metric'], '--metric requiere una lista de metricas'],
      [['traces', '--filter', ''], '--filter requiere un valor de texto'],
      [['exceptions', '--rapido'], 'Opcion desconocida: --rapido'],
      [['exceptions', 'sobrante'], 'Opcion desconocida: sobrante'],
      [['borrar-todo'], 'Comando desconocido: borrar-todo'],
    ]
    for (const [argv, message] of cases) {
      const result = query(argv, repo)
      assert.equal(result.status, 1, argv.join(' '))
      assert.equal(result.stderr, `${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} ${message}\n`)
      assert.deepEqual(result.cli.log, ['az account show'])
    }
    assert.equal(
      query(['borrar-todo'], repo).stdout,
      'Ejecuta sin argumentos para ver los comandos disponibles.\n',
    )
  })
})

describe('custom', () => {
  test('audita la query en .mefisto/pipeline/kql-audit.log sin crear nada mas', () => {
    const repo = consumer()
    const before = Object.keys(tree(repo))
    const result = query(['custom', 'exceptions | take 3'], repo)
    assert.equal(result.status, 0)
    const audit = join('.mefisto', 'pipeline', 'kql-audit.log')
    assert.deepEqual(Object.keys(tree(repo)).sort(), [...before, audit].sort())
    assert.equal(
      readFileSync(join(repo, audit), 'utf8'),
      '[2026-01-02 03:04:05] QUERY: exceptions | where timestamp > ago(1h) | take 3\n',
    )
    assert.deepEqual(kql(result), ['exceptions | where timestamp > ago(1h) | take 3'])
    assert.match(result.stdout, /Query ad-hoc \(ultimas 1h\)\n/)
    assert.equal(
      result.stderr,
      `${COLOR.yellow}ADVERTENCIA: query ad-hoc. Daily cap: 0.5GB. Respeta el daily cap configurado por el proyecto consumidor (ver su ADR de control de costos de App Insights).${COLOR.reset}\n`,
    )

    query(['custom', 'requests'], repo)
    assert.equal(readFileSync(join(repo, audit), 'utf8').split('\n').length, 3)
  })

  test('MEFISTO_STATE_DIR redirige la auditoria', () => {
    const repo = consumer()
    const stateDir = join(box.work, 'estado', 'pipeline')
    query(['custom', 'exceptions | take 1'], repo, answering(ROWS), { MEFISTO_STATE_DIR: stateDir })
    assert.ok(existsSync(join(stateDir, 'kql-audit.log')))
    assert.ok(!existsSync(join(repo, '.mefisto', 'pipeline')))
  })

  test('sin query termina en 1 con el ejemplo y sin auditar', () => {
    const repo = consumer()
    for (const argv of [['custom'], ['custom', '--hours', '2']]) {
      const result = query(argv, repo)
      assert.equal(result.status, 1)
      assert.equal(
        result.stderr,
        `${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} El comando 'custom' requiere una query KQL como argumento\n`,
      )
      assert.equal(
        result.stdout,
        '  Ejemplo: node scripts/appinsights-query.mts custom "exceptions | where type has \'NullRef\' | take 5"\n',
      )
    }
    assert.ok(!existsSync(join(repo, '.mefisto', 'pipeline')))
  })

  test('guardCustomQuery inyecta la ventana y el take solo si faltan', () => {
    assert.equal(guardCustomQuery('exceptions'), 'exceptions | where timestamp > ago(1h) | take 20')
    assert.equal(
      guardCustomQuery('exceptions | where type has "x"'),
      'exceptions | where timestamp > ago(1h) | where type has "x" | take 20',
    )
    assert.equal(
      guardCustomQuery('exceptions | where timestamp > AGO(2d) | TAKE 5'),
      'exceptions | where timestamp > AGO(2d) | TAKE 5',
    )
    assert.equal(
      guardCustomQuery('exceptions\n| where a | project b\n| take 1'),
      'exceptions\n| where timestamp > ago(1h) | where a | project b\n| where timestamp > ago(1h) | take 1',
    )
  })
})

describe('App Service Plan', () => {
  test('plan-sites y plan-metrics solo invocan az de lectura', () => {
    const repo = consumer()
    const respond: Respond = (call) => {
      if (starts(call, 'az', 'appservice', 'plan')) return { stdout: '3\n' }
      if (starts(call, 'az', 'monitor', 'metrics')) return { stdout: '{"value":[]}\n' }
      return undefined
    }
    const sites = query(['plan-sites', PLAN], repo, respond)
    assert.equal(sites.status, 0)
    assert.equal(sites.stdout, '3\n')
    assert.deepEqual(sites.cli.log, [
      'az account show',
      `az appservice plan show --ids ${PLAN} --query numberOfSites --output tsv`,
    ])

    const metrics = query(['plan-metrics', PLAN, '--hours', '6'], repo, respond)
    assert.equal(metrics.status, 0)
    assert.equal(metrics.stdout, '{"value":[]}\n')
    assert.deepEqual(metrics.cli.calls[1]?.args, [
      'monitor',
      'metrics',
      'list',
      '--resource',
      PLAN,
      '--metric',
      'CpuPercentage MemoryPercentage',
      '--offset',
      '6h',
      '--interval',
      'PT1H',
      '--output',
      'json',
    ])
    assert.equal(
      option(
        query(['plan-metrics', PLAN, '--metric', 'CpuPercentage'], repo, respond).cli.calls[1] as Call,
        '--metric',
      ),
      'CpuPercentage',
    )
  })

  test('rechaza ids ausentes o mal formados sin invocar az sobre el plan', () => {
    const repo = consumer()
    const cases: [string[], string][] = [
      [['plan-sites', 'no-es-un-id'], 'PLAN_ID mal formado: no-es-un-id'],
      [['plan-metrics', '/subscriptions/x/mal'], 'PLAN_ID mal formado: /subscriptions/x/mal'],
      [['plan-sites'], "'plan-sites' requiere el resource id ARM del App Service Plan"],
      [['plan-metrics', '--hours', '3'], "'plan-metrics' requiere el resource id ARM del App Service Plan"],
    ]
    for (const [argv, message] of cases) {
      const result = query(argv, repo)
      assert.equal(result.status, 1, argv.join(' '))
      assert.ok(result.stderr.startsWith(`${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} ${message}\n`))
      assert.deepEqual(result.cli.log, ['az account show'])
    }
    assert.ok(
      query(['plan-sites', 'x'], repo).stderr.endsWith(
        '  Forma esperada: /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Web/serverfarms/<plan>\n',
      ),
    )
  })

  test('plan-metrics exige horas enteras y positivas, y propaga el codigo de az', () => {
    const repo = consumer()
    for (const hours of ['0', 'seis', '1.5']) {
      const result = query(['plan-metrics', PLAN, '--hours', hours], repo)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /--hours debe ser un entero positivo\n$/)
      assert.deepEqual(result.cli.log, ['az account show'])
    }
    const failed = query(['plan-sites', PLAN], repo, (call) =>
      starts(call, 'az', 'appservice') ? { status: 3, stderr: 'no autorizado\n' } : undefined,
    )
    assert.equal(failed.status, 3)
    assert.equal(failed.stderr, 'no autorizado\n')
  })
})

describe('Service Bus', () => {
  const serviceBus = (overrides: Record<string, { status?: number; stdout?: string }> = {}): Respond => {
    return (call) => {
      if (!starts(call, 'az', 'servicebus')) return undefined
      const topic = option(call, '--topic-name')
      const key = [call.args[2] === 'subscription' ? call.args[3] : 'topics', topic, option(call, '--name')]
        .filter((part) => part !== undefined && part.length > 0)
        .join(' ')
      const defaults: Record<string, { status?: number; stdout?: string }> = {
        topics: { stdout: 'pedidos\npagos\n' },
        'list pedidos': { stdout: 'facturacion\nauditoria\n' },
        'list pagos': { status: 1 },
        'show pedidos facturacion': { stdout: '4\n' },
        'show pedidos auditoria': { stdout: '0\n' },
      }
      return { ...defaults, ...overrides }[key] ?? { status: 1 }
    }
  }

  test('servicebus-dlq cuenta los dead letters por subscription y sigue ante un topic ilegible', () => {
    const result = query(['servicebus-dlq'], consumer(), serviceBus())
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      [
        `${COLOR.blue}[03:04:05]${COLOR.reset} Conteo de dead letters en Service Bus namespace: sb`,
        `${COLOR.red}${COLOR.bold}DLQ${COLOR.reset} pedidos/facturacion: ${COLOR.red}4${COLOR.reset} mensajes`,
        `${COLOR.green}ok${COLOR.reset}  pedidos/auditoria: 0 mensajes`,
        `${COLOR.yellow}!${COLOR.reset} Fallo al listar subscriptions del topic pagos`,
        `${COLOR.green}${COLOR.bold}ok${COLOR.reset} Consulta de dead letters completada`,
        '',
      ].join('\n'),
    )
    assert.equal(
      result.cli.log[1],
      'az servicebus topic list --namespace-name sb --resource-group rg-sb --query [].name -o tsv',
    )
    assert.ok(
      result.cli.log.includes(
        'az servicebus topic subscription show --namespace-name sb --resource-group rg-sb --topic-name pedidos --name facturacion --query countDetails.deadLetterMessageCount -o tsv',
      ),
    )
  })

  test('una subscription ilegible o un conteo no numerico no detienen el recorrido', () => {
    const result = query(
      ['servicebus-dlq'],
      consumer(),
      serviceBus({
        'show pedidos facturacion': { status: 1 },
        'show pedidos auditoria': { stdout: 'None\n' },
      }),
    )
    assert.equal(result.status, 0)
    assert.ok(
      result.stdout.includes(
        `${COLOR.yellow}!${COLOR.reset} Fallo al consultar subscription pedidos/facturacion\n`,
      ),
    )
    assert.ok(result.stdout.includes(`${COLOR.green}ok${COLOR.reset}  pedidos/auditoria: None mensajes\n`))
  })

  test('sin topics avisa y termina bien; si listar falla, aborta', () => {
    const none = query(['servicebus-dlq'], consumer(), serviceBus({ topics: { stdout: '\n' } }))
    assert.equal(none.status, 0)
    assert.ok(
      none.stdout.includes(`${COLOR.yellow}!${COLOR.reset} No se encontraron topics en el namespace sb\n`),
    )

    const failed = query(
      ['servicebus-dlq'],
      consumer(),
      serviceBus({ topics: { status: 1, stdout: 'namespace no encontrado\n' } }),
    )
    assert.equal(failed.status, 1)
    assert.equal(
      failed.stderr,
      `${COLOR.red}${COLOR.bold}ERROR:${COLOR.reset} Fallo al listar topics de Service Bus\nnamespace no encontrado\n`,
    )
  })

  test('sin SERVICEBUS_NAMESPACE o SERVICEBUS_RG explica que clave agregar', () => {
    for (const [key, content] of [
      ['SERVICEBUS_NAMESPACE', 'SERVICEBUS_RG=rg-sb\n'],
      ['SERVICEBUS_RG', 'SERVICEBUS_NAMESPACE=sb\n'],
    ] as const) {
      const repo = consumer(content)
      const envFile = join(repo, '.mefisto', 'appinsights.env')
      for (const command of ['servicebus-dlq', 'servicebus-dlq-peek']) {
        const result = query([command], repo)
        assert.equal(result.status, 1)
        assert.ok(result.stderr.endsWith(`Variable ${key} no definida en ${envFile}\n`))
        assert.equal(result.stdout, `  Agrega ${key} al archivo ${envFile}\n`)
      }
    }
  })

  test('servicebus-dlq-peek muestra hasta cinco mensajes por DLQ sin consumirlos', () => {
    const messages = JSON.stringify([
      {
        body: 'x'.repeat(205),
        deadLetterReason: 'MaxDeliveryCountExceeded',
        applicationProperties: { intento: 3, origen: 'api' },
      },
      { body: { id: 7 } },
    ])
    const result = query(
      ['servicebus-dlq-peek'],
      consumer(),
      serviceBus({ 'receive pedidos': { stdout: `${messages}\n` } }),
    )
    assert.equal(result.status, 0)
    assert.deepEqual(result.stdout.split('\n').slice(1, 9), [
      '',
      `${COLOR.cyan}${COLOR.bold}--- pedidos/facturacion/$deadletterqueue ---${COLOR.reset}`,
      '  [1] reason=MaxDeliveryCountExceeded',
      '      props={"intento": 3, "origen": "api"}',
      `      body=${'x'.repeat(200)}...`,
      '  [2] reason=(sin razon)',
      '      body={"id": 7}',
      '',
    ])
    assert.ok(
      result.cli.log.includes(
        'az servicebus topic subscription receive --namespace-name sb --resource-group rg-sb --topic-name pedidos --subscription-name facturacion --is-dead-letter-queue true --peek-lock --max-messages 5 --output json',
      ),
    )
  })

  test('peekReport distingue vacio, mensajes y una salida que no es una lista de mensajes', () => {
    for (const empty of ['[]', '{}', 'null', '7', 'no es json', '""'])
      assert.deepEqual(peekReport(empty), ['  (vacio)'])
    assert.deepEqual(peekReport('[{"body":null,"deadLetterReason":null,"applicationProperties":{}}]'), [
      '  [1] reason=None',
      '      body=null',
    ])
    assert.deepEqual(peekReport('[{}]'), ['  [1] reason=(sin razon)', '      body=(sin body)'])
    assert.deepEqual(peekReport('{"error":"x"}'), ['{"error":"x"}'])
    assert.deepEqual(peekReport('[{"body":"a"},"suelto"]'), [
      '  [1] reason=(sin razon)',
      '      body=a',
      '[{"body":"a"},"suelto"]',
    ])
  })
})

describe('function-status', () => {
  const functions: Respond = (call) => {
    if (starts(call, 'az', 'functionapp', 'show')) {
      const name = option(call, '--name')
      if (name === 'fa-caida') return { status: 1, stdout: 'ResourceNotFound\n' }
      return { stdout: `${JSON.stringify({ state: name === 'fa-parada' ? 'Stopped' : 'Running' })}\n` }
    }
    if (starts(call, 'az', 'functionapp', 'function', 'list')) {
      return {
        stdout: `${JSON.stringify([
          { name: 'fa1/RegistrarTurno', isDisabled: false },
          { name: 'fa1/Reprocesar', isDisabled: true },
        ])}\n`,
      }
    }
    return undefined
  }

  test('reporta estado y funciones de cada Function App y sigue ante una ilegible', () => {
    const repo = consumer('APPINSIGHTS_RG=rg-consumidor\nFUNCTIONAPP_NAMES="fa1, fa-parada ,fa-caida,"\n')
    const result = query(['function-status'], repo, functions)
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      [
        `${COLOR.blue}[03:04:05]${COLOR.reset} Estado de Azure Functions`,
        '',
        `${COLOR.cyan}${COLOR.bold}--- fa1 ---${COLOR.reset}`,
        `  Estado: ${COLOR.green}${COLOR.bold}Running${COLOR.reset}`,
        '  Funciones registradas: 2',
        '    - RegistrarTurno (ok)',
        '    - Reprocesar (DISABLED)',
        '',
        `${COLOR.cyan}${COLOR.bold}--- fa-parada ---${COLOR.reset}`,
        `  Estado: ${COLOR.red}${COLOR.bold}Stopped${COLOR.reset}`,
        '  Funciones registradas: 2',
        '    - RegistrarTurno (ok)',
        '    - Reprocesar (DISABLED)',
        '',
        `${COLOR.cyan}${COLOR.bold}--- fa-caida ---${COLOR.reset}`,
        `${COLOR.yellow}!${COLOR.reset} Fallo al consultar Function App fa-caida`,
        `${COLOR.green}${COLOR.bold}ok${COLOR.reset} Consulta de estado de Functions completada`,
        '',
      ].join('\n'),
    )
    assert.equal(result.stderr, 'ResourceNotFound\n')
    assert.equal(
      result.cli.log[1],
      'az functionapp show --name fa1 --resource-group rg-consumidor --query {state:state, defaultHostName:defaultHostName, kind:kind} --output json',
    )
  })

  test('sin FUNCTIONAPP_NAMES o APPINSIGHTS_RG explica que clave agregar', () => {
    const noNames = query(['function-status'], consumer('APPINSIGHTS_RG=rg\n'))
    assert.equal(noNames.status, 1)
    assert.match(noNames.stderr, /Variable FUNCTIONAPP_NAMES no definida en /)
    const noGroup = query(['function-status'], consumer('FUNCTIONAPP_NAMES=fa1\n'))
    assert.equal(noGroup.status, 1)
    assert.match(
      noGroup.stderr,
      /Variable APPINSIGHTS_RG no definida en .* \(usada como resource group de las Function Apps\)\n$/,
    )
    assert.match(noGroup.stdout, /^ {2}Agrega APPINSIGHTS_RG al archivo /)
  })

  test('functionAppState y functionsReport toleran salidas ilegibles', () => {
    assert.equal(functionAppState('{"state":"Running"}'), 'Running')
    assert.equal(functionAppState('{"state":null}'), 'None')
    assert.equal(functionAppState('{}'), 'unknown')
    assert.equal(functionAppState('no es json'), 'unknown')
    assert.equal(functionAppState('[]'), 'unknown')
    assert.deepEqual(functionsReport('[]'), { count: 0, report: [] })
    assert.deepEqual(functionsReport('no es json'), { count: 0, report: [] })
    assert.deepEqual(functionsReport('[{"isDisabled":1},{"name":null}]'), {
      count: 2,
      report: ['    - ? (DISABLED)', '[{"isDisabled":1},{"name":null}]'],
    })
  })
})

describe('guard y distribucion', () => {
  test('en el repo de Mefisto se niega sin llamar a nada', () => {
    const result = query(['exceptions'], REPO_ROOT)
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: scripts/appinsights-query.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Mefisto no tiene entorno desplegado ni App Insights.\n',
    )
    assert.deepEqual(result.cli.calls, [])
  })

  test('dist/claude trae el shim y el script identicos a scripts/, y los inventaria', () => {
    assertDistributed(['appinsights-query.mts', 'appinsights-query.mts', 'lib/state.mts'])
  })

  test('la copia de dist, ejecutada desde fuera del repo del consumidor, avisa del env que falta y del legacy', () => {
    const repo = consumer(null)
    mkdirSync(join(repo, 'scripts'))
    writeFile(join(repo, 'scripts', '.env'), 'APPINSIGHTS_APP=app-legacy\n')
    const before = tree(repo)
    for (const script of [SCRIPT, join(DIST_SCRIPTS, 'appinsights-query.mts')]) {
      const result = runScript(script, ['exceptions'], repo, box.work)
      assert.equal(result.status, 1)
      assert.ok(result.stderr.includes(`No se encontro ${join(repo, '.mefisto', 'appinsights.env')}`))
      assert.ok(result.stdout.includes(`configuracion legacy en ${join(repo, 'scripts', '.env')} `))
      assert.ok(result.stdout.includes('mkdir -p .mefisto && mv scripts/.env .mefisto/appinsights.env'))
    }
    assert.deepEqual(tree(repo), before)
  })

  test('el script de scripts/ termina en 1 en el repo de Mefisto', () => {
    const result = runScript(SCRIPT, [], REPO_ROOT, box.work)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })
})
