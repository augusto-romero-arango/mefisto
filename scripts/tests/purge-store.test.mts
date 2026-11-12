import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { Output } from '../lib/azure-cli.mts'
import { captureAsync, matchFunctionApps, parseConnection, purgeStore } from '../purge-store.mts'
import {
  BASE_CONFIG,
  DIST_SCRIPTS,
  FakeCli,
  REPO_ROOT,
  SCRIPTS,
  assertDistributed,
  codeLines,
  option,
  runScript,
  sandbox,
  starts,
  writeConfig,
} from './azure-cli-sandbox.mts'
import type { Call, Respond, Sandbox } from './azure-cli-sandbox.mts'

const SCRIPT = join(SCRIPTS, 'purge-store.mts')
const COMMAND_SOURCE = join(REPO_ROOT, 'src', 'published', 'commands', 'purge-store.md')
const PASSWORD = 'cl4ve=no-se-imprime'
const SECRET = `Host=pg-prueba.postgres.database.azure.com;Database=prueba;Username=admin;Password=${PASSWORD};SSL Mode=Require`
const USAGE = [
  'Uso: purge-store --domain <dominio> [--env dev] [--dry-run]',
  'Ejemplo: purge-store --domain calculo-horas --dry-run',
]

let box: Sandbox
let consumer = ''
let configPath = ''

before(() => {
  box = sandbox('purge')
  consumer = box.repo('consumidor')
  configPath = writeConfig(consumer, {
    ...BASE_CONFIG,
    domainLabels: ['calculo-horas', 'turnos'],
    boundedContext: { name: 'Principal', domains: ['calculo-horas', 'turnos'] },
  })
})

after(() => {
  box.remove()
})

/** El Azure y el Postgres de mentira contra los que corre un caso. */
interface World {
  session: boolean
  groups: string[]
  postgres: string
  keyVault: string
  functionApps: string[]
  worker: string
  revision: string
  /** Respuesta de cada endpoint de IP publica; sin entrada, curl falla. */
  ips: Record<string, string>
  secret: string
  schemaExists: boolean
  /** Filas por tabla; una tabla ausente no figura. */
  tables: Record<string, string>
  readModelTables: string
  /** Codigo de salida forzado para la llamada que cumpla el predicado. */
  failing: (call: Call) => number | undefined
}

function world(overrides: Partial<World> = {}): World {
  return {
    session: true,
    groups: ['rg-prueba-dev'],
    postgres: 'psql-prueba-dev',
    keyVault: 'kv-prueba-dev',
    functionApps: ['func-calculo-horas-dev', 'func-turnos-dev'],
    worker: '',
    revision: '',
    ips: { 'https://ifconfig.me/ip': '203.0.113.7\n' },
    secret: SECRET,
    schemaExists: true,
    tables: { mt_streams: '42', mt_event_progression: '3' },
    readModelTables: '5',
    failing: () => undefined,
    ...overrides,
  }
}

function respond(state: World): Respond {
  const sql = (call: Call): string => call.args.at(-1) ?? ''
  return (call) => {
    const forced = state.failing(call)
    if (forced !== undefined) return { status: forced, stderr: 'fallo forzado\n' }
    if (call.command === 'curl') {
      const body = state.ips[call.args.at(-1) ?? '']
      return body === undefined ? { status: 22 } : { stdout: body }
    }
    if (call.command === 'psql') {
      if (sql(call).includes('information_schema.schemata'))
        return { stdout: state.schemaExists ? '1\n' : '\n' }
      if (sql(call).includes('to_regclass')) {
        const table = Object.keys(state.tables).find((name) => sql(call).includes(`"${name}"`))
        return { stdout: table === undefined ? 'f\n' : 't\n' }
      }
      if (sql(call).includes('information_schema.tables')) return { stdout: `${state.readModelTables}\n` }
      if (sql(call).startsWith('SELECT count(*)')) {
        const table = Object.keys(state.tables).find((name) => sql(call).includes(`"${name}"`))
        return { stdout: `${state.tables[table ?? ''] ?? ''}\n` }
      }
      if (sql(call).startsWith('DROP SCHEMA'))
        return { stdout: 'DROP SCHEMA\n', stderr: 'NOTICE: drop cascades\n' }
      return { status: 1 }
    }
    if (starts(call, 'az', 'account', 'show')) return { status: state.session ? 0 : 1 }
    if (starts(call, 'az', 'group', 'show')) {
      return { status: state.groups.includes(option(call, '--name')) ? 0 : 3 }
    }
    if (starts(call, 'az', 'resource', 'list')) {
      const names: Record<string, string> = {
        'Microsoft.DBforPostgreSQL/flexibleServers': state.postgres,
        'Microsoft.KeyVault/vaults': state.keyVault,
        'Microsoft.Web/sites': state.functionApps.join('\n'),
        'Microsoft.App/containerApps': state.worker,
      }
      return { stdout: `${names[option(call, '--resource-type')] ?? ''}\n` }
    }
    if (starts(call, 'az', 'containerapp', 'revision', 'list')) return { stdout: `${state.revision}\n` }
    if (starts(call, 'az', 'keyvault', 'secret', 'show')) return { stdout: `${state.secret}\n` }
    return undefined
  }
}

interface Result {
  status: number
  stdout: string
  stderr: string
  cli: FakeCli
}

interface RunOptions {
  cwd?: string
  missing?: string[]
  /** Codigo de la senal que llega justo despues de la llamada que cumpla el predicado. */
  signalAfter?: (call: Call) => number | undefined
}

async function purge(argv: string[], state: World = world(), options: RunOptions = {}): Promise<Result> {
  const cli = new FakeCli(respond(state))
  const output = new Output()
  let signal: number | null = null
  const status = await purgeStore(argv, {
    cwd: options.cwd ?? consumer,
    env: { PATH: 'ruta-de-prueba' },
    program: 'purge-store',
    pid: 4321,
    hasCommand: (command) => !(options.missing ?? []).includes(command),
    run: (command, args, runOptions) => {
      const result = cli.run(command, args, runOptions)
      signal ??= options.signalAfter?.(cli.calls.at(-1) as Call) ?? null
      return Promise.resolve(result)
    },
    interrupted: () => signal,
    output,
  })
  return { status, stdout: output.stdout, stderr: output.stderr, cli }
}

const isDrop = (call: Call): boolean =>
  call.command === 'psql' && (call.args.at(-1) ?? '').startsWith('DROP SCHEMA')
const FIREWALL_CREATE = 'az postgres flexible-server firewall-rule create'
const FIREWALL_DELETE =
  'az postgres flexible-server firewall-rule delete --resource-group rg-prueba-dev --name psql-prueba-dev --rule-name purge-store-temp-4321 --yes'

/** Las llamadas que cambian algo, en orden y resumidas. */
function effects(cli: FakeCli): string[] {
  return cli.log.flatMap((line) => {
    if (line.startsWith(FIREWALL_CREATE)) return ['abre firewall']
    if (line.startsWith('az postgres flexible-server firewall-rule delete')) return ['cierra firewall']
    if (line.includes('DROP SCHEMA')) return ['drop']
    if (line.startsWith('az containerapp revision restart')) return ['reinicia worker']
    if (line.startsWith('az functionapp restart')) return ['reinicia function app']
    return []
  })
}

describe('guardas previas a Azure', () => {
  test('un entorno distinto de dev aborta sin llamar a nada', async () => {
    for (const environment of ['prod', 'staging', 'DEV', '']) {
      const result = await purge(['--domain', 'turnos', '--env', environment])
      assert.equal(result.status, 1)
      assert.deepEqual(result.stderr.split('\n').slice(0, 3), [
        'ERROR: guarda anti-prod (CA-1, MEF-ADR-0036 seccion 5): este script solo opera',
        `  sobre el entorno 'dev'. Recibido: '${environment}'.`,
        '  Purgar cualquier otro entorno esta deliberadamente fuera de alcance de este script.',
      ])
      assert.deepEqual(result.cli.calls, [])
    }
  })

  test('en el repo de Mefisto se niega sin llamar a nada', async () => {
    const result = await purge(['--domain', 'turnos'], world(), { cwd: REPO_ROOT })
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: scripts/purge-store.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Mefisto no tiene harness.config.json ni un store desplegado que purgar.\n',
    )
    assert.deepEqual(result.cli.calls, [])
  })

  test('sin --domain, con un argumento desconocido o con --help imprime el uso', async () => {
    const missing = await purge([])
    assert.equal(missing.status, 1)
    assert.deepEqual(missing.stderr.trimEnd().split('\n'), ['ERROR: falta --domain <dominio>.', ...USAGE])

    const unknown = await purge(['--domain', 'turnos', '--force'])
    assert.equal(unknown.status, 1)
    assert.deepEqual(unknown.stderr.trimEnd().split('\n'), [
      "ERROR: argumento desconocido '--force'",
      ...USAGE,
    ])

    const help = await purge(['--help'])
    assert.equal(help.status, 0)
    assert.deepEqual(help.stderr.trimEnd().split('\n'), USAGE)
    assert.equal(help.stdout, '')

    for (const result of [missing, unknown, help]) assert.deepEqual(result.cli.calls, [])
  })

  test('--domain o --env sin valor terminan en 1 sin mensaje', async () => {
    for (const argv of [['--domain'], ['--domain', 'turnos', '--env']]) {
      const result = await purge(argv)
      assert.equal(result.status, 1)
      assert.equal(result.stderr + result.stdout, '')
      assert.deepEqual(result.cli.calls, [])
    }
  })

  test('sin az, psql o curl nombra el binario que falta', async () => {
    for (const bin of ['az', 'psql', 'curl']) {
      const result = await purge(['--domain', 'turnos'], world(), { missing: [bin] })
      assert.equal(result.status, 1)
      assert.equal(result.stderr, `ERROR: '${bin}' no esta instalado o no esta en el PATH (requerido).\n`)
      assert.deepEqual(result.cli.calls, [])
    }
  })

  test('sin sesion de az pide az login', async () => {
    const result = await purge(['--domain', 'turnos'], world({ session: false }))
    assert.equal(result.status, 1)
    assert.equal(result.stderr, "ERROR: no hay sesion activa de Azure CLI. Ejecuta 'az login' primero.\n")
    assert.deepEqual(result.cli.log, ['az account show'])
  })
})

describe('dominio y descubrimiento de recursos', () => {
  test('un dominio no declarado aborta citando el config efectivo y los declarados', async () => {
    const result = await purge(['--domain', 'nominas'])
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      `ERROR: el dominio 'nominas' no esta declarado en domainLabels de ${configPath}.\n` +
        '  Dominios declarados: calculo-horas turnos\n',
    )
    assert.deepEqual(result.cli.log, ['az account show'])
  })

  test('acepta PascalCase y usa la forma declarada en domainLabels para el schema', async () => {
    const result = await purge(['--domain', 'CalculoHoras', '--dry-run'])
    assert.equal(result.status, 0)
    assert.match(
      result.stdout,
      /=== DRY RUN: dominio 'calculo-horas' \(schema "calculo_horas"\) en rg-prueba-dev ===/,
    )
    assert.match(result.stdout, /Function App: func-calculo-horas-dev\n/)
  })

  test('con azureRegionShort prueba primero el resource group CAF y despues el legacy', async () => {
    const caf = box.repo('caf')
    writeConfig(caf, { ...BASE_CONFIG, azureRegionShort: 'eus2', resourceSequence: '002' })
    const found = await purge(
      ['--domain', 'prueba', '--dry-run'],
      world({ groups: ['rg-prueba-dev-eus2-002'], functionApps: ['func-prueba-dev'] }),
      { cwd: caf },
    )
    assert.equal(found.status, 0)
    assert.match(found.stdout, /^Resource group: rg-prueba-dev-eus2-002\n/)

    const none = await purge(['--domain', 'prueba'], world({ groups: [] }), { cwd: caf })
    assert.equal(none.status, 1)
    assert.deepEqual(none.cli.log.slice(1), [
      'az group show --name rg-prueba-dev-eus2-002',
      'az group show --name rg-prueba-dev',
    ])
    assert.equal(
      none.stderr,
      "ERROR: no se encontro el resource group de 'dev' (probado 'rg-prueba-dev'\n" +
        '  y su variante con sufijo de region/secuencia en la suscripcion activa).\n' +
        "  Verifica 'az account show' y que la infraestructura de dev ya este desplegada.\n",
    )
  })

  test('sin azureRegionShort solo prueba el resource group legacy', async () => {
    const result = await purge(['--domain', 'turnos'], world({ groups: [] }))
    assert.equal(result.status, 1)
    assert.deepEqual(result.cli.log.slice(1), ['az group show --name rg-prueba-dev'])
    assert.match(result.stderr, /\n {2}en la suscripcion activa\)\.\n/)
  })

  test('lista los recursos que no encontro y no abre el firewall', async () => {
    const result = await purge(
      ['--domain', 'turnos'],
      world({ postgres: '', keyVault: '', functionApps: [] }),
    )
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      "ERROR: no se encontraron los siguientes recursos en el resource group 'rg-prueba-dev':\n" +
        '  - servidor PostgreSQL (Microsoft.DBforPostgreSQL/flexibleServers)\n' +
        '  - Key Vault (Microsoft.KeyVault/vaults)\n' +
        "  - Function App del dominio 'turnos' (Microsoft.Web/sites)\n",
    )
    assert.deepEqual(effects(result.cli), [])
    assert.equal(result.cli.count('curl'), 0)
  })

  test('con projections.enabled exige el worker y su revision activa antes de purgar', async () => {
    const projections = box.repo('proyecciones')
    writeConfig(projections, { ...BASE_CONFIG, projections: { enabled: true } })
    const apps = { functionApps: ['func-prueba-dev'] }

    const noWorker = await purge(['--domain', 'prueba'], world(apps), { cwd: projections })
    assert.equal(noWorker.status, 1)
    assert.match(
      noWorker.stderr,
      / {2}- Container App del worker de proyecciones \(Microsoft\.App\/containerApps, projections\.enabled=true\)\n$/,
    )

    const noRevision = await purge(['--domain', 'prueba'], world({ ...apps, worker: 'ca-projections-dev' }), {
      cwd: projections,
    })
    assert.equal(noRevision.status, 1)
    assert.match(
      noRevision.stderr,
      / {2}- revision activa de 'ca-projections-dev' \(revisa 'az extension add --name containerapp' y tus permisos sobre el Container App\)\n$/,
    )
    for (const result of [noWorker, noRevision]) assert.deepEqual(effects(result.cli), [])
  })

  test('sin projections.enabled no busca el worker', async () => {
    const result = await purge(['--domain', 'turnos', '--dry-run'], world({ worker: 'ca-projections-dev' }))
    assert.equal(result.cli.count('Microsoft.App/containerApps'), 0)
    assert.doesNotMatch(result.stdout, /Worker:/)
  })

  test('un dominio que matchea mas de una Function App aborta antes del firewall', async () => {
    const result = await purge(
      ['--domain', 'turnos'],
      world({ functionApps: ['app-turnos-dev', 'legacy-turnos'] }),
    )
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      "ERROR: el dominio 'turnos' matchea mas de una Function App en 'rg-prueba-dev':\n" +
        '  - app-turnos-dev\n' +
        '  - legacy-turnos\n' +
        '  Ambiguo: este script reiniciaria la equivocada. Renombra o desambigua antes de purgar.\n',
    )
    assert.deepEqual(effects(result.cli), [])
  })

  test('matchFunctionApps prefiere el prefijo func-{dominio}- y cae al patron laxo', () => {
    const all = 'func-calculo-horas-dev\nfunc-horas-dev\nhoras-legacy\nfunc-otro-dev'
    assert.deepEqual(matchFunctionApps(all, 'horas'), ['func-horas-dev'])
    assert.deepEqual(matchFunctionApps('func-calculo-horas-dev\nhoras-legacy', 'horas'), [
      'func-calculo-horas-dev',
      'horas-legacy',
    ])
    assert.deepEqual(matchFunctionApps('fa-horas\r\nfa-horasextra', 'horas'), ['fa-horas'])
    assert.deepEqual(matchFunctionApps('', 'horas'), [])
    assert.deepEqual(matchFunctionApps('func-x-dev', '('), [])
  })
})

describe('firewall temporal', () => {
  test('descarta una respuesta que no es IPv4 y usa el siguiente endpoint', async () => {
    const result = await purge(
      ['--domain', 'turnos', '--dry-run'],
      world({
        ips: { 'https://ifconfig.me/ip': '<html>error</html>', 'https://api.ipify.org': ' 198.51.100.9 \n' },
      }),
    )
    assert.equal(result.status, 0)
    assert.deepEqual(
      result.cli.log.filter((line) => line.startsWith('curl')),
      ['curl -fsS --max-time 10 https://ifconfig.me/ip', 'curl -fsS --max-time 10 https://api.ipify.org'],
    )
    assert.ok(
      result.cli.log.includes(
        `${FIREWALL_CREATE} --resource-group rg-prueba-dev --name psql-prueba-dev --rule-name purge-store-temp-4321 --start-ip-address 198.51.100.9 --end-ip-address 198.51.100.9`,
      ),
    )
  })

  test('sin IPv4 del operador aborta sin abrir el firewall', async () => {
    const result = await purge(
      ['--domain', 'turnos'],
      world({ ips: { 'https://api.ipify.org': '2001:db8::1' } }),
    )
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: no se pudo determinar la IPv4 publica del operador (necesaria para la regla de firewall temporal).\n',
    )
    assert.deepEqual(effects(result.cli), [])
  })

  test('si la regla no se pudo crear termina con el codigo de az sin leer el secreto ni borrarla', async () => {
    const result = await purge(
      ['--domain', 'turnos'],
      world({
        failing: (call) => (starts(call, 'az', 'postgres') && call.args.includes('create') ? 4 : undefined),
      }),
    )
    assert.equal(result.status, 4)
    assert.equal(result.stderr, 'fallo forzado\n')
    assert.deepEqual(effects(result.cli), ['abre firewall'])
    assert.equal(result.cli.count('keyvault'), 0)
  })

  test('un secreto sin los cuatro campos aborta y cierra la regla', async () => {
    const result = await purge(['--domain', 'turnos'], world({ secret: 'Host=h;Database=d;Username=u' }))
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      "ERROR: no se pudo parsear el secreto 'marten-connection' (formato esperado:\n" +
        '  Host=...;Database=...;Username=...;Password=...;SSL Mode=...).\n',
    )
    assert.deepEqual(effects(result.cli), ['abre firewall', 'cierra firewall'])
    assert.ok(result.cli.calls.every((call) => call.command !== 'psql'))
    assert.equal(result.cli.log.at(-1), FIREWALL_DELETE)
  })
})

describe('dry-run', () => {
  test('reporta lo que se perderia sin ningun paso destructivo', async () => {
    const result = await purge(['--domain', 'turnos', '--dry-run'])
    assert.equal(result.status, 0)
    assert.equal(
      result.stdout,
      [
        'Resource group: rg-prueba-dev',
        'Postgres: psql-prueba-dev | Key Vault: kv-prueba-dev | Function App: func-turnos-dev',
        'Abriendo regla de firewall temporal para 203.0.113.7...',
        '',
        `=== DRY RUN: dominio 'turnos' (schema "turnos") en rg-prueba-dev ===`,
        '  streams (mt_streams):                          42',
        '  tablas de read model (mt_doc_%):               5',
        '  checkpoints del daemon (mt_event_progression): 3',
        '',
        `Nada se purgo. Sin --dry-run, este comando ejecuta 'DROP SCHEMA "turnos" CASCADE'`,
        'y reinicia el Function App del dominio.',
        '',
      ].join('\n'),
    )
    assert.equal(result.stderr, '')
    assert.deepEqual(effects(result.cli), ['abre firewall', 'cierra firewall'])
  })

  test('una tabla ausente se reporta sin abortar', async () => {
    const result = await purge(['--domain', 'turnos', '--dry-run'], world({ tables: { mt_streams: '7' } }))
    assert.equal(result.status, 0)
    assert.match(result.stdout, /streams \(mt_streams\): +7\n/)
    assert.match(result.stdout, /checkpoints del daemon \(mt_event_progression\): n\/a \(tabla ausente\)\n/)
    assert.equal(result.cli.count('SELECT count(*) FROM "turnos"."mt_event_progression"'), 0)
  })

  test('con worker de proyecciones lo nombra entre lo que se reiniciaria', async () => {
    const projections = box.repo('proyecciones-dry')
    writeConfig(projections, { ...BASE_CONFIG, projections: { enabled: true } })
    const result = await purge(
      ['--domain', 'prueba', '--dry-run'],
      world({
        functionApps: ['func-prueba-dev'],
        worker: 'ca-projections-dev',
        revision: 'ca-projections-dev--r1',
      }),
      { cwd: projections },
    )
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Function App: func-prueba-dev \| Worker: ca-projections-dev\n/)
    assert.match(result.stdout, /y reinicia el Function App del dominio y el worker de proyecciones\.\n$/)
    assert.deepEqual(effects(result.cli), ['abre firewall', 'cierra firewall'])
  })

  test('si el schema no existe no hay nada que purgar', async () => {
    for (const argv of [
      ['--domain', 'turnos', '--dry-run'],
      ['--domain', 'turnos'],
    ]) {
      const result = await purge(argv, world({ schemaExists: false }))
      assert.equal(result.status, 0)
      assert.match(result.stdout, /\nEl schema 'turnos' no existe en prueba: no hay nada que purgar\.\n$/)
      assert.deepEqual(effects(result.cli), ['abre firewall', 'cierra firewall'])
    }
  })
})

describe('purga', () => {
  test('ejecuta drop, reinicios y cierre del firewall en ese orden', async () => {
    const projections = box.repo('proyecciones-purga')
    writeConfig(projections, { ...BASE_CONFIG, projections: { enabled: true } })
    const result = await purge(
      ['--domain', 'prueba'],
      world({
        functionApps: ['func-prueba-dev'],
        worker: 'ca-projections-dev',
        revision: 'ca-projections-dev--r1',
      }),
      { cwd: projections },
    )
    assert.equal(result.status, 0)
    assert.deepEqual(effects(result.cli), [
      'abre firewall',
      'drop',
      'reinicia worker',
      'reinicia function app',
      'cierra firewall',
    ])
    const conninfo = 'host=pg-prueba.postgres.database.azure.com dbname=prueba user=admin sslmode=require'
    assert.deepEqual(result.cli.log.slice(-5), [
      `psql ${conninfo} -tAc SELECT 1 FROM information_schema.schemata WHERE schema_name = 'prueba'`,
      `psql ${conninfo} -v ON_ERROR_STOP=1 -c DROP SCHEMA "prueba" CASCADE;`,
      'az containerapp revision restart --name ca-projections-dev --resource-group rg-prueba-dev --revision ca-projections-dev--r1',
      'az functionapp restart --name func-prueba-dev --resource-group rg-prueba-dev',
      FIREWALL_DELETE,
    ])
    assert.equal(
      result.stdout.split('\n').slice(3).join('\n'),
      [
        'Purgando schema "prueba" (DROP SCHEMA ... CASCADE)...',
        'DROP SCHEMA',
        'Reiniciando worker de proyecciones (ca-projections-dev, revision ca-projections-dev--r1)...',
        'Reiniciando Function App del dominio (func-prueba-dev)...',
        '',
        'OK: schema "prueba" purgado. AutoCreateSchemaObjects lo recreara limpio en la',
        '  primera escritura tras el reinicio (MEF-ADR-0034).',
        '',
      ].join('\n'),
    )
    assert.equal(result.stderr, 'NOTICE: drop cascades\n')
  })

  test('sin worker solo reinicia la Function App', async () => {
    const result = await purge(['--domain', 'turnos'])
    assert.equal(result.status, 0)
    assert.deepEqual(effects(result.cli), [
      'abre firewall',
      'drop',
      'reinicia function app',
      'cierra firewall',
    ])
  })

  test('la clave viaja solo en el entorno de psql', async () => {
    const result = await purge(['--domain', 'turnos'])
    for (const call of result.cli.calls) {
      assert.ok(!call.args.join(' ').includes(PASSWORD), call.args.join(' '))
      if (call.command === 'psql') {
        assert.equal(call.env?.PGPASSWORD, PASSWORD)
        assert.equal(call.env?.PATH, 'ruta-de-prueba')
      } else {
        assert.equal(call.env, undefined)
      }
    }
    assert.ok(!(result.stdout + result.stderr).includes(PASSWORD))
  })

  test('si el drop falla termina con su codigo, sin reinicios y cerrando el firewall', async () => {
    const result = await purge(
      ['--domain', 'turnos'],
      world({ failing: (call) => (isDrop(call) ? 3 : undefined) }),
    )
    assert.equal(result.status, 3)
    assert.deepEqual(effects(result.cli), ['abre firewall', 'drop', 'cierra firewall'])
    assert.doesNotMatch(result.stdout, /OK: schema/)
  })

  test('si un reinicio falla termina con su codigo y cierra el firewall', async () => {
    const result = await purge(
      ['--domain', 'turnos'],
      world({ failing: (call) => (starts(call, 'az', 'functionapp', 'restart') ? 5 : undefined) }),
    )
    assert.equal(result.status, 5)
    assert.deepEqual(effects(result.cli), [
      'abre firewall',
      'drop',
      'reinicia function app',
      'cierra firewall',
    ])
    assert.doesNotMatch(result.stdout, /OK: schema/)
  })

  test('una senal durante el drop termina en 130 o 143, sin reinicios y cerrando el firewall', async () => {
    for (const code of [130, 143]) {
      const result = await purge(['--domain', 'turnos'], world(), {
        signalAfter: (call) => (isDrop(call) ? code : undefined),
      })
      assert.equal(result.status, code)
      assert.deepEqual(effects(result.cli), ['abre firewall', 'drop', 'cierra firewall'])
      assert.equal(result.cli.log.at(-1), FIREWALL_DELETE)
    }
  })

  test('una senal antes de abrir el firewall termina sin tocar nada', async () => {
    const result = await purge(['--domain', 'turnos'], world(), {
      signalAfter: (call) => (call.command === 'curl' ? 130 : undefined),
    })
    assert.equal(result.status, 130)
    assert.deepEqual(effects(result.cli), [])
  })
})

describe('parseConnection', () => {
  test('lee el formato Npgsql sin distinguir mayusculas en las claves', () => {
    assert.deepEqual(
      parseConnection('HOST=h;port=6432;Database=d;UserName=u;Password=p=1;;SSL Mode=VerifyFull'),
      {
        host: 'h',
        port: '6432',
        database: 'd',
        user: 'u',
        password: 'p=1',
        sslMode: 'verifyfull',
      },
    )
  })

  test('sin SSL Mode usa require y deja vacio lo que falta', () => {
    assert.deepEqual(parseConnection('Host=h; Database=d'), {
      host: 'h',
      port: '',
      database: '',
      user: '',
      password: '',
      sslMode: 'require',
    })
  })

  test('el puerto se anexa al conninfo solo si viene en el secreto', async () => {
    const result = await purge(
      ['--domain', 'turnos', '--dry-run'],
      world({ secret: 'Host=h;Port=6432;Database=d;Username=u;Password=p' }),
    )
    assert.ok(
      result.cli.log.some((line) =>
        line.startsWith('psql host=h dbname=d user=u sslmode=require port=6432 '),
      ),
    )
  })
})

describe('ruta del config', () => {
  test('un consumidor legacy se lee desde su fallback y el error de dominio lo cita', async () => {
    const legacy = box.repo('legacy')
    const legacyPath = writeConfig(legacy, BASE_CONFIG, true)
    const result = await purge(['--domain', 'nominas'], world(), { cwd: legacy })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(`domainLabels de ${legacyPath}.\n`))
  })

  test('el script no nombra el config legacy en su codigo y lo califica en su prosa', () => {
    const code = codeLines(SCRIPT).join('\n')
    assert.doesNotMatch(code, /\.claude[/\\'"]/)
    assert.doesNotMatch(code, /\.(mefisto|claude)\/harness\.config\.json/)
    const source = readFileSync(SCRIPT, 'utf8')
    assert.ok(source.includes('fallback'))
    assert.ok(source.includes('legacy solo de lectura en .claude/harness.config.json'))
  })

  test('el comando no lee el config con jq por una ruta fija', () => {
    assert.doesNotMatch(
      readFileSync(COMMAND_SOURCE, 'utf8'),
      /(jq|json-value\.mts"?)\s.*\.(mefisto|claude)\/harness\.config\.json/,
    )
  })
})

describe('distribucion', () => {
  test('dist/claude trae el shim y el script identicos a scripts/, y los inventaria', () => {
    assertDistributed(['purge-store.mts', 'purge-store.mts'])
  })

  test('la copia de dist resuelve sus modulos y sale por uso', () => {
    const result = runScript(join(DIST_SCRIPTS, 'purge-store.mts'), ['--help'], consumer, box.work)
    assert.equal(result.status, 0)
    assert.match(result.stderr, /^Uso: .*purge-store\.mts --domain <dominio> \[--env dev\] \[--dry-run\]\n/)
  })
})

describe('linea de comando', () => {
  test('en el repo de Mefisto termina en 1 con el guard por stderr', () => {
    const result = runScript(SCRIPT, [], REPO_ROOT, box.work)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })

  test('fuera de un repo git termina en 1', () => {
    const outside = join(box.work, 'sin repo')
    mkdirSync(outside)
    const result = runScript(SCRIPT, ['--domain', 'turnos'], outside, box.work)
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'ERROR: no estas en un repositorio git')
  })

  test('captureAsync devuelve codigo, stdout y stderr, y null si el programa no existe', async () => {
    const ran = await captureAsync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(process.env.PRUEBA ?? ""); process.stderr.write("aviso"); process.exit(3)',
      ],
      { env: { ...process.env, PRUEBA: 'valor' } },
    )
    assert.deepEqual(ran, { status: 3, stdout: 'valor', stderr: 'aviso' })
    const absent = await captureAsync(join(box.work, 'no-existe'), [])
    assert.equal(absent.status, null)
  })
})
