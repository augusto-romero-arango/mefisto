import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { CommandResult } from '../lib/cli.mts'
import { USAGE, provisionAppinsights } from '../onboard-provision-appinsights.mts'
import { CANONICAL_CONFIG, PLUGIN_MANIFEST, configJson, initRepo, pathIn, sink } from './consumer-sandbox.mts'

const ENV_FILE = '.mefisto/appinsights.env'

/** Lo que responde el `az` falso; cada lista va en el orden en que `az` la devolveria. */
interface Azure {
  installed: boolean
  login: boolean
  resourceGroup: string
  appInsights: string[]
  serviceBus: string[]
  functionApps: string[]
}

const AZURE: Azure = {
  installed: true,
  login: true,
  resourceGroup: 'rg-proy-dev',
  appInsights: ['appi-proy'],
  serviceBus: ['sb-proy'],
  functionApps: ['func-ventas-x', 'func-cobros-x'],
}

let work = ''
let sequence = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto appinsights '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function makeRepo(extra: Record<string, unknown> = {}): string {
  return initRepo(join(work, `repo-${++sequence}`), { [CANONICAL_CONFIG]: configJson(extra) })
}

function fakeAz(azure: Azure, args: string[]): CommandResult {
  const done = (ok: boolean, stdout = ''): CommandResult => ({ status: ok ? 0 : 1, stdout, stderr: '' })
  const [group, verb] = args
  if (group === 'account' && verb === 'show') return done(azure.login)
  if (group === 'group' && verb === 'show') return done(args[3] === azure.resourceGroup)
  if (group === 'resource' && verb === 'list') {
    const type = args[args.indexOf('--resource-type') + 1]
    const names =
      type === 'Microsoft.Insights/components'
        ? azure.appInsights
        : type === 'Microsoft.ServiceBus/namespaces'
          ? azure.serviceBus
          : type === 'Microsoft.Web/sites'
            ? azure.functionApps
            : []
    return done(true, names.map((name) => `${name}\n`).join(''))
  }
  return done(false)
}

interface Run {
  status: number
  out: string[]
  err: string[]
  calls: string[][]
}

function run(repo: string, argv: string[], azure: Partial<Azure> = {}): Run {
  const output = sink()
  const calls: string[][] = []
  const effective = { ...AZURE, ...azure }
  const status = provisionAppinsights(argv, {
    cwd: repo,
    hasCommand: (command) => command === 'az' && effective.installed,
    run: (command, args) => {
      assert.equal(command, 'az')
      calls.push(args)
      return fakeAz(effective, args)
    },
    ...output.io,
  })
  return { status, out: output.out, err: output.err, calls }
}

describe('[P-1] preview', () => {
  for (const argv of [['--preview'], []]) {
    test(`'${argv.join(' ')}' imprime las cinco claves ordenadas y no escribe`, () => {
      const repo = makeRepo()
      const result = run(repo, argv)
      assert.equal(result.status, 0)
      assert.deepEqual(result.err, [])
      assert.deepEqual(result.out, [
        'Resource group: rg-proy-dev',
        'Contenido de .mefisto/appinsights.env:',
        'APPINSIGHTS_APP=appi-proy',
        'APPINSIGHTS_RG=rg-proy-dev',
        'SERVICEBUS_NAMESPACE=sb-proy',
        'SERVICEBUS_RG=rg-proy-dev',
        'FUNCTIONAPP_NAMES=func-cobros-x,func-ventas-x',
        'Previsualizacion: no se escribio ningun archivo. Usa --apply solo tras la confirmacion explicita de /onboard.',
      ])
      assert.equal(existsSync(pathIn(repo, ENV_FILE)), false)
    })
  }

  test('descubre por tipo de recurso dentro del resource group', () => {
    const result = run(makeRepo(), [])
    assert.deepEqual(result.calls.at(-1), [
      'resource',
      'list',
      '--resource-group',
      'rg-proy-dev',
      '--resource-type',
      'Microsoft.Web/sites',
      '--query',
      "[?kind && contains(kind, 'functionapp')].name",
      '-o',
      'tsv',
    ])
  })
})

describe('[P-2] apply', () => {
  test('crea el archivo con la cabecera y las cinco claves, y no lo sobrescribe', () => {
    const repo = makeRepo()
    const first = run(repo, ['--apply'])
    assert.equal(first.status, 0)
    assert.equal(
      first.out.at(-1),
      'OK: .mefisto/appinsights.env creado. Commitealo: contiene solo nombres de recursos, sin secretos.',
    )
    const content = readFileSync(pathIn(repo, ENV_FILE), 'utf8')
    assert.equal(
      content,
      [
        '# Nombres de recursos Azure para appinsights-query.sh (solo nombres, sin secretos). Generado por /onboard (issue #2387).',
        'APPINSIGHTS_APP=appi-proy',
        'APPINSIGHTS_RG=rg-proy-dev',
        'SERVICEBUS_NAMESPACE=sb-proy',
        'SERVICEBUS_RG=rg-proy-dev',
        'FUNCTIONAPP_NAMES=func-cobros-x,func-ventas-x',
        '',
      ].join('\n'),
    )

    const second = run(repo, ['--apply'], { appInsights: ['otro'] })
    assert.equal(second.status, 1)
    assert.deepEqual(second.err, [
      [
        'ERROR: .mefisto/appinsights.env ya existe; no se sobrescribe.',
        '       Editalo o borralo a mano y reintenta.',
      ].join('\n'),
    ])
    assert.deepEqual(second.calls, [])
    assert.equal(readFileSync(pathIn(repo, ENV_FILE), 'utf8'), content)
  })
})

describe('[P-3] fallas sin escribir', () => {
  const failures: [string, Partial<Azure>, string[], RegExp][] = [
    ['sin sesion de az', { login: false }, ['--apply'], /no hay sesion activa de Azure CLI/],
    [
      'sin resource group',
      { resourceGroup: 'otro' },
      ['--apply'],
      /no se encontro el resource group de 'dev'/,
    ],
    ['cero App Insights', { appInsights: [] }, ['--apply'], /ningun App Insights en el resource group/],
    ['cero namespaces', { serviceBus: [] }, ['--apply'], /ningun namespace de Service Bus/],
    [
      'ambiguedad de App Insights lista candidatos',
      { appInsights: ['appi-b', 'appi-a'] },
      ['--apply'],
      /hay 2 candidatos de App Insights en 'rg-proy-dev'; indica uno con --appinsights-app <nombre>:\n {2}- appi-a\n {2}- appi-b$/,
    ],
    [
      'ambiguedad de namespace lista candidatos',
      { serviceBus: ['sb-a', 'sb-b'] },
      ['--apply'],
      /indica uno con --servicebus-namespace <nombre>:\n {2}- sb-a\n {2}- sb-b$/,
    ],
    [
      'flag fuera de candidatos',
      { appInsights: ['appi-a', 'appi-b'] },
      ['--apply', '--appinsights-app', 'appi-z'],
      /--appinsights-app 'appi-z' no esta entre los candidatos de App Insights en 'rg-proy-dev':\n {2}- appi-a\n {2}- appi-b$/,
    ],
    [
      'sin az en el PATH',
      { installed: false },
      ['--apply'],
      /^ERROR: 'az' no esta instalado o no esta en el PATH/,
    ],
  ]

  for (const [name, azure, argv, pattern] of failures) {
    test(name, () => {
      const repo = makeRepo()
      const result = run(repo, argv, azure)
      assert.equal(result.status, 1)
      assert.equal(result.err.length, 1)
      assert.match(result.err[0] ?? '', pattern)
      assert.match(result.err[0] ?? '', /^ERROR: /)
      assert.equal(existsSync(pathIn(repo, ENV_FILE)), false)
    })
  }

  test('un config invalido aborta con el diagnostico del cargador y sin escribir', () => {
    const repo = initRepo(join(work, 'config invalido'), { [CANONICAL_CONFIG]: '{' })
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 1)
    assert.match(
      result.err[0] ?? '',
      /no es parseable\.\nERROR: el config efectivo no es valido; no se escribio nada\.$/,
    )
    assert.equal(existsSync(pathIn(repo, ENV_FILE)), false)
  })
})

describe('[P-4] desambiguacion', () => {
  test('un flag valido elige el candidato y cero Function Apps solo avisa', () => {
    const repo = makeRepo()
    const result = run(repo, ['--apply', '--appinsights-app', 'appi-b'], {
      appInsights: ['appi-a', 'appi-b'],
      functionApps: [],
    })
    assert.equal(result.status, 0)
    assert.deepEqual(result.err, [
      "AVISO: no hay Function Apps en 'rg-proy-dev'; FUNCTIONAPP_NAMES queda vacio (function-errors no funcionara hasta el primer /scaffold).",
    ])
    const lines = readFileSync(pathIn(repo, ENV_FILE), 'utf8').split('\n')
    assert.ok(lines.includes('APPINSIGHTS_APP=appi-b'))
    assert.ok(lines.includes('FUNCTIONAPP_NAMES='))
  })
})

describe('[P-5] entorno y guard', () => {
  test('--env resuelve el resource group del entorno', () => {
    const result = run(makeRepo(), ['--env', 'qa'], { resourceGroup: 'rg-proy-qa' })
    assert.equal(result.status, 0)
    assert.ok(result.out.includes('APPINSIGHTS_RG=rg-proy-qa'))
  })

  test('con azureRegionShort prueba primero el nombre con region y secuencia', () => {
    const repo = makeRepo({ azureRegionShort: 'eus2' })
    const withRegion = run(repo, [], { resourceGroup: 'rg-proy-dev-eus2-001' })
    assert.equal(withRegion.out[0], 'Resource group: rg-proy-dev-eus2-001')
    assert.equal(run(repo, [], { resourceGroup: 'rg-proy-dev' }).out[0], 'Resource group: rg-proy-dev')
    assert.deepEqual(run(repo, [], { resourceGroup: 'nada' }).err, [
      [
        "ERROR: no se encontro el resource group de 'dev' (probado 'rg-proy-dev'",
        '  y su variante con sufijo de region/secuencia en la suscripcion activa); no se escribio nada.',
      ].join('\n'),
    ])
  })

  test('en el repo de Mefisto se niega sin invocar az', () => {
    const mefisto = initRepo(join(work, 'mefisto'), {
      [PLUGIN_MANIFEST]: '{}',
      [CANONICAL_CONFIG]: configJson(),
    })
    const result = run(mefisto, ['--preview'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, [
      'ERROR: scripts/onboard-provision-appinsights.sh es del plugin publicado y solo aplica al consumidor.',
    ])
    assert.deepEqual(result.calls, [])
  })
})

describe('argumentos', () => {
  test('un argumento desconocido, un flag sin valor o dos modos distintos terminan en 2 con el uso', () => {
    const repo = makeRepo()
    assert.deepEqual(run(repo, ['--zzz']).err, [`ERROR: argumento desconocido '--zzz'\n${USAGE}`])
    for (const argv of [['--zzz'], ['--env'], ['--appinsights-app'], ['--preview', '--apply']]) {
      const result = run(repo, argv)
      assert.equal(result.status, 2)
      assert.ok(result.err[0]?.endsWith(USAGE))
      assert.deepEqual(result.calls, [])
    }
    const empty = run(repo, ['--env', ''])
    assert.equal(empty.status, 2)
    assert.deepEqual(empty.err, ['ERROR: --env requiere un valor.'])
  })

  test('--help imprime el uso por stderr y termina en 0', () => {
    const result = run(makeRepo(), ['--help'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.err, [USAGE])
    assert.deepEqual(result.out, [])
  })
})
