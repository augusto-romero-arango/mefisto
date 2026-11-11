import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { bootstrapBackend } from '../bootstrap-backend.mts'
import { Output } from '../lib/azure-cli.mts'
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
  writeFile,
} from './azure-cli-sandbox.mts'
import type { Call, Respond, Sandbox } from './azure-cli-sandbox.mts'

const SCRIPT = join(SCRIPTS, 'bootstrap-backend.mts')
const SUBSCRIPTION = 'suscripcion-ficticia'
const USAGE = [
  'Uso: bootstrap-backend --subscription <id> [--env <dev|staging|prod>] [--location <region>]',
  '',
  '  --subscription <id>   Suscripcion de Azure (requerido; tambien se admite como',
  '                        primer argumento posicional).',
  '  --env <env>           Ambiente: dev | staging | prod. Default: dev.',
  '  --location <region>   Region de Azure (ej: eastus2). Si se omite, se lee',
  "                        'azureLocation' de harness.config.json.",
  '',
  'Ejemplo: bootstrap-backend --subscription 50fc1901-9723-4971-9d63-b3f1a015e8b8 --env dev',
]

let box: Sandbox
let repos = 0

before(() => {
  box = sandbox('bootstrap')
})

after(() => {
  box.remove()
})

function consumer(config: object = { ...BASE_CONFIG, azureLocation: 'eastus2' }, legacy = false): string {
  const repo = box.repo(`consumidor-${++repos}`)
  writeConfig(repo, config, legacy)
  return repo
}

const CAF_CONFIG = {
  ...BASE_CONFIG,
  azureLocation: 'eastus2',
  azureRegionShort: 'eus2',
  infraResourceGroupPrefix: 'rg-ca',
}

/** El Azure de mentira: que existe ya y que responde `check-name` para cada nombre. */
interface World {
  accountSet: boolean
  accountInGroup: string
  available: (name: string) => string
  groupExists: boolean
  storageExists: boolean
  containerExists: boolean
  failing: (call: Call) => number | undefined
}

function world(overrides: Partial<World> = {}): World {
  return {
    accountSet: true,
    accountInGroup: '',
    available: () => 'true',
    groupExists: false,
    storageExists: false,
    containerExists: false,
    failing: () => undefined,
    ...overrides,
  }
}

function respond(state: World): Respond {
  return (call) => {
    const forced = state.failing(call)
    if (forced !== undefined) return { status: forced, stderr: 'fallo forzado\n' }
    if (starts(call, 'az', 'account', 'set')) return { status: state.accountSet ? 0 : 1 }
    if (starts(call, 'az', 'storage', 'account', 'list')) return { stdout: `${state.accountInGroup}\n` }
    if (starts(call, 'az', 'storage', 'account', 'check-name')) {
      return { stdout: `${state.available(option(call, '--name'))}\n` }
    }
    if (starts(call, 'az', 'group', 'exists')) return { stdout: `${state.groupExists}\n` }
    if (starts(call, 'az', 'storage', 'account', 'show')) return { status: state.storageExists ? 0 : 3 }
    if (starts(call, 'az', 'storage', 'container', 'exists')) return { stdout: `${state.containerExists}\n` }
    return undefined
  }
}

interface Result {
  status: number
  out: string
  stdout: string
  stderr: string
  cli: FakeCli
}

function bootstrap(argv: string[], cwd: string, state: World = world(), suffixes = ['abc123']): Result {
  const cli = new FakeCli(respond(state))
  const output = new Output()
  let next = 0
  const status = bootstrapBackend(argv, {
    cwd,
    program: 'bootstrap-backend',
    run: cli.run,
    storageSuffix: (length) => {
      assert.equal(length, 6)
      return suffixes[next++ % suffixes.length] ?? ''
    },
    output,
  })
  return { status, out: output.all, stdout: output.stdout, stderr: output.stderr, cli }
}

/** Como el stub del test original: Azure no responde, asi que el script no pasa del resumen. */
function summary(argv: string[], cwd: string): Result {
  return bootstrap(argv, cwd, world({ failing: () => 1 }))
}

const backendTf = (repo: string, environment = 'dev'): string =>
  join(repo, 'infra', 'environments', environment, 'backend.tf')

describe('region efectiva', () => {
  test('un consumidor canonico sin --location usa azureLocation', () => {
    const result = summary(
      ['--subscription', SUBSCRIPTION],
      consumer({ ...BASE_CONFIG, azureLocation: 'westeurope' }),
    )
    assert.match(result.stdout, /\n {2}Region: {10}westeurope\n/)
  })

  test('con los dos configs avisa y usa solo el canonico', () => {
    const repo = consumer({ ...BASE_CONFIG, azureLocation: 'eastus2' })
    writeConfig(repo, { ...BASE_CONFIG, azureLocation: 'centralus' }, true)
    const result = summary(['--subscription', SUBSCRIPTION], repo)
    assert.match(result.stdout, /\n {2}Region: {10}eastus2\n/)
    assert.doesNotMatch(result.out, /Region: {10}centralus/)
    assert.ok(
      result.stderr.includes(
        `AVISO: se usara el config canonico ${join(repo, '.mefisto', 'harness.config.json')}; se ignora el legacy ${join(repo, '.claude', 'harness.config.json')}.`,
      ),
    )
  })

  test('un consumidor legacy lee azureLocation de su fallback', () => {
    const result = summary(
      ['--subscription', SUBSCRIPTION],
      consumer({ ...BASE_CONFIG, azureLocation: 'uksouth' }, true),
    )
    assert.match(result.stdout, /\n {2}Region: {10}uksouth\n/)
  })

  test('--location prevalece sobre el config', () => {
    const repo = consumer({ ...BASE_CONFIG, azureLocation: 'westeurope' })
    const result = summary(['--subscription', SUBSCRIPTION, '--location', 'northeurope'], repo)
    assert.match(result.stdout, /\n {2}Region: {10}northeurope\n/)
  })

  test('sin flag ni campo aborta sin nombrar la ruta legacy', () => {
    const repo = consumer(BASE_CONFIG)
    const result = summary(['--subscription', SUBSCRIPTION], repo)
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: no se especifico la region de Azure.\n' +
        '  Pasa --location <region> (ej: --location eastus2) o agrega el campo\n' +
        `  opcional "azureLocation" a ${join(repo, '.mefisto', 'harness.config.json')}.\n`,
    )
    assert.ok(!result.out.includes(join('.claude', 'harness.config.json')))
    assert.deepEqual(result.cli.calls, [])
  })

  test('el script no nombra el config legacy y lee azureLocation de la ruta efectiva', () => {
    const source = readFileSync(SCRIPT, 'utf8')
    assert.doesNotMatch(source, /\.claude[/\\'"]/)
    assert.ok(codeLines(SCRIPT).some((line) => line.includes('readFileSync(config.configPath')))
  })
})

describe('argumentos', () => {
  const repo = (): string => consumer()

  test('la suscripcion tambien se admite como primer argumento posicional', () => {
    const result = summary(['sub-posicional', '--env', 'staging'], repo())
    assert.match(result.stdout, /\n {2}Ambiente: {8}staging\n {2}Suscripcion: {5}sub-posicional\n/)
  })

  test('--help imprime el uso por stderr y termina en 0', () => {
    const result = summary(['--help'], repo())
    assert.equal(result.status, 0)
    assert.deepEqual(result.stderr.trimEnd().split('\n'), USAGE)
    assert.equal(result.stdout, '')
  })

  test('rechaza opciones desconocidas, argumentos sobrantes y opciones sin valor', () => {
    const cases: [string[], string[]][] = [
      [
        ['--subscription', 's', '--rapido'],
        ["ERROR: opcion desconocida '--rapido'", ...USAGE],
      ],
      [
        ['s', 'otro'],
        ["ERROR: argumento inesperado 'otro'", ...USAGE],
      ],
      [['--subscription'], ['ERROR: --subscription requiere un valor']],
      [['s', '--env'], ['ERROR: --env requiere un valor']],
      [['s', '--location', ''], ['ERROR: --location requiere un valor']],
      [['s', '--env', 'qa'], ["ERROR: --env invalido 'qa' (usa dev | staging | prod)"]],
      [[], ['ERROR: falta la suscripcion de Azure.', ...USAGE]],
    ]
    for (const [argv, expected] of cases) {
      const result = summary(argv, repo())
      assert.equal(result.status, 1, argv.join(' '))
      assert.deepEqual(result.stderr.trimEnd().split('\n'), expected)
      assert.deepEqual(result.cli.calls, [])
    }
  })

  test('sin infraResourceGroupPrefix o terraformStateStorage aborta citando el config', () => {
    for (const field of ['infraResourceGroupPrefix', 'terraformStateStorage']) {
      const repoPath = consumer({ ...BASE_CONFIG, azureLocation: 'eastus2', [field]: '' })
      const result = summary([SUBSCRIPTION], repoPath)
      assert.equal(result.status, 1)
      assert.equal(
        result.stderr,
        `ERROR: '${field}' no esta definido en ${join(repoPath, '.mefisto', 'harness.config.json')}.\n`,
      )
    }
  })

  test('el config se carga antes de mirar los argumentos', () => {
    const result = summary(['--help'], box.repo('sin-config'))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: no se encontro el config canonico requerido /)
  })

  test('en el repo de Mefisto se niega sin llamar a nada', () => {
    const result = summary([SUBSCRIPTION], REPO_ROOT)
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: scripts/bootstrap-backend.sh es del plugin publicado y solo aplica al consumidor.\n' +
        'Mefisto no se despliega a Azure ni tiene backend de Terraform.\n' +
        'Para mejorar el plugin usa /mefisto-tooling.\n',
    )
    assert.deepEqual(result.cli.calls, [])
  })

  test('si no se puede fijar la suscripcion aborta tras el resumen', () => {
    const result = bootstrap([SUBSCRIPTION], repo(), world({ accountSet: false }))
    assert.equal(result.status, 1)
    assert.match(result.stdout, /\nFijando la suscripcion activa\.\.\.\n$/)
    assert.equal(
      result.stderr,
      `ERROR: no se pudo fijar la suscripcion '${SUBSCRIPTION}'.\n` +
        "  Verifica que 'az login' este hecho y que la suscripcion exista.\n",
    )
    assert.deepEqual(result.cli.log, [`az account set --subscription ${SUBSCRIPTION}`])
  })
})

describe('naming legacy', () => {
  test('crea el backend con el nombre base mas un sufijo y escribe backend.tf', () => {
    const repo = consumer()
    const result = bootstrap(['--subscription', SUBSCRIPTION], repo)
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(result.cli.log, [
      `az account set --subscription ${SUBSCRIPTION}`,
      "az storage account list --resource-group rg-prueba-tfstate --query [?starts_with(name, 'stpruebatfstate')].name | [0] -o tsv",
      'az storage account check-name --name stpruebatfstateabc123 --query nameAvailable -o tsv',
      'az group exists --name rg-prueba-tfstate',
      'az group create --name rg-prueba-tfstate --location eastus2 -o none',
      'az storage account show --name stpruebatfstateabc123 --resource-group rg-prueba-tfstate -o none',
      'az storage account create --name stpruebatfstateabc123 --resource-group rg-prueba-tfstate --location eastus2 --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false -o none',
      'az storage account blob-service-properties update --account-name stpruebatfstateabc123 --resource-group rg-prueba-tfstate --enable-versioning true --enable-delete-retention true --delete-retention-days 7 -o none',
      'az storage container exists --name tfstate --account-name stpruebatfstateabc123 --auth-mode login --query exists -o tsv',
      'az storage container create --name tfstate --account-name stpruebatfstateabc123 --auth-mode login -o none',
    ])
    const block = [
      'terraform {',
      '  backend "azurerm" {',
      '    resource_group_name  = "rg-prueba-tfstate"',
      '    storage_account_name = "stpruebatfstateabc123"',
      '    container_name       = "tfstate"',
      '    key                  = "dev.tfstate"',
      '    use_azuread_auth     = true',
      '  }',
      '}',
    ]
    assert.equal(
      readFileSync(backendTf(repo), 'utf8'),
      [
        '# Generado por scripts/bootstrap-backend.sh -- no editar a mano.',
        "# Backend remoto del estado de Terraform para el ambiente 'dev'.",
        "# 'use_azuread_auth = true': acceso keyless por AAD/RBAC, nunca por access key",
        '# (MEF-ADR-0025, MEF-ADR-0022; developer.hashicorp.com/terraform/language/backend/azurerm).',
        ...block,
        '',
      ].join('\n'),
    )
    assert.equal(
      result.stdout,
      [
        '=== Bootstrap del backend de Terraform para Prueba ===',
        '  Ambiente:        dev',
        `  Suscripcion:     ${SUBSCRIPTION}`,
        '  Region:          eastus2',
        `  Naming CAF:      inactivo (falta 'azureRegionShort' en ${join(repo, '.mefisto', 'harness.config.json')}; naming legacy retrocompatible, MEF-ADR-0045)`,
        '  Resource Group:  rg-prueba-tfstate',
        '  Storage (base):  stpruebatfstate',
        '  Container:       tfstate',
        '',
        'Fijando la suscripcion activa...',
        "Resolviendo el nombre de la Storage Account (base 'stpruebatfstate')...",
        '  Storage Account: stpruebatfstateabc123',
        '',
        "Creando Resource Group 'rg-prueba-tfstate' en eastus2...",
        "Creando Storage Account 'stpruebatfstateabc123'...",
        'Asegurando versioning y soft-delete de blobs...',
        "Creando container 'tfstate' (auth-mode login)...",
        'Escrito infra/environments/dev/backend.tf.',
        '',
        '=== Backend listo. Bloque backend "azurerm" resultante: ===',
        ...block,
        '',
        'El backend es keyless (AAD/RBAC, MEF-ADR-0025): ningun access key se emite ni se',
        "persiste para el tfstate. El principal que hace 'terraform apply' en CI",
        "requiere el rol 'Storage Blob Data Contributor' (lectura+escritura, no solo",
        'lectura) sobre esta Storage Account -- lo asigna scripts/setup-github-ci.sh',
        '(issue #195), no este script.',
        '',
        "Siguiente paso: el pipeline IaC ejecuta 'terraform init' en infra/environments/dev",
        'y reutiliza este backend. Lanzalo con /infra o scripts/iac-pipeline.sh.',
        'Listo.',
        '',
      ].join('\n'),
    )
  })

  test('una segunda corrida reusa los nombres de backend.tf y no recrea nada', () => {
    const repo = consumer()
    assert.equal(bootstrap([SUBSCRIPTION], repo).status, 0)
    const before = readFileSync(backendTf(repo), 'utf8')
    const again = bootstrap(
      [SUBSCRIPTION],
      repo,
      world({ groupExists: true, storageExists: true, containerExists: true }),
      ['otro99'],
    )
    assert.equal(again.status, 0)
    assert.equal(readFileSync(backendTf(repo), 'utf8'), before)
    assert.equal(again.cli.count('check-name'), 0)
    assert.equal(again.cli.count(' create '), 0)
    assert.equal(again.cli.count('blob-service-properties update'), 1)
    assert.match(
      again.stdout,
      /Resource Group 'rg-prueba-tfstate' ya existe\. Omitiendo\.\nStorage Account 'stpruebatfstateabc123' ya existe\. Omitiendo creacion\.\nAsegurando versioning y soft-delete de blobs\.\.\.\nContainer 'tfstate' ya existe\. Omitiendo\.\n/,
    )
  })

  test('reusa la cuenta ya creada en el RG si backend.tf aun no existe', () => {
    const result = bootstrap([SUBSCRIPTION], consumer(), world({ accountInGroup: 'stpruebatfstatezz9911' }))
    assert.equal(result.status, 0)
    assert.equal(result.cli.count('check-name'), 0)
    assert.match(result.stdout, /\n {2}Storage Account: stpruebatfstatezz9911\n/)
  })

  test('si el nombre esta tomado reintenta con otro sufijo', () => {
    const result = bootstrap(
      [SUBSCRIPTION],
      consumer(),
      world({ available: (name) => (name.endsWith('tomado') ? 'False' : 'True') }),
      ['tomado', 'libre1'],
    )
    assert.equal(result.status, 0)
    assert.equal(result.cli.count('check-name'), 2)
    assert.match(result.stdout, /\n {2}Storage Account: stpruebatfstatelibre1\n/)
  })

  test('tras diez nombres tomados aborta', () => {
    const result = bootstrap([SUBSCRIPTION], consumer(), world({ available: () => 'false' }))
    assert.equal(result.status, 1)
    assert.equal(result.cli.count('check-name'), 10)
    assert.equal(
      result.stderr,
      'ERROR: no se pudo resolver un nombre globalmente unico para la Storage Account tras 10 intentos con sufijo aleatorio.\n',
    )
    assert.equal(result.cli.count('az group'), 0)
  })

  test('un check-name no concluyente avisa y sigue con ese nombre', () => {
    const result = bootstrap([SUBSCRIPTION], consumer(), world({ available: () => '' }))
    assert.equal(result.status, 0)
    assert.equal(
      result.stderr,
      "AVISO: 'az storage account check-name' no fue concluyente para 'stpruebatfstateabc123'; se usara de todas formas (si colisiona, el create fallara de forma explicita).\n",
    )
  })

  test('avisa cuando la base no deja espacio para el sufijo y la trunca', () => {
    const repo = consumer({
      ...BASE_CONFIG,
      azureLocation: 'eastus2',
      terraformStateStorage: 'stpruebatfstatedevlargo',
    })
    const result = summary([SUBSCRIPTION], repo)
    assert.match(
      result.stderr,
      /^AVISO: 'terraformStateStorage' \('stpruebatfstatedevlargo', 23 chars\) no deja espacio para el sufijo de 6 chars dentro del limite de 24; se trunca la base a 'stpruebatfstatedev'\.\n/,
    )
    assert.match(result.stdout, /\n {2}Storage \(base\): {2}stpruebatfstatedev\n/)
  })
})

describe('naming CAF', () => {
  test('con azureRegionShort compone los nombres sin sufijo aleatorio', () => {
    const repo = consumer(CAF_CONFIG)
    const result = bootstrap([SUBSCRIPTION, '--env', 'prod'], repo, world(), [])
    assert.equal(result.status, 0)
    assert.match(
      result.stdout,
      /\n {2}Naming CAF: {6}activo \(azureRegionShort='eus2', resourceSequence='001', MEF-ADR-0045\)\n {2}Resource Group: {2}rg-tfstate-ca-prod-eus2-001\n {2}Storage: {9}sttfstatecaprodeus2001\n/,
    )
    assert.ok(
      result.cli.log.includes(
        'az storage account check-name --name sttfstatecaprodeus2001 --query nameAvailable -o tsv',
      ),
    )
    const written = readFileSync(backendTf(repo, 'prod'), 'utf8')
    assert.match(written, /resource_group_name {2}= "rg-tfstate-ca-prod-eus2-001"\n/)
    assert.match(written, /storage_account_name = "sttfstatecaprodeus2001"\n/)
    assert.match(written, /key {18}= "prod\.tfstate"\n/)
    assert.match(result.stdout, /\nEscrito infra\/environments\/prod\/backend\.tf\.\n/)
  })

  test('ante una colision pide incrementar resourceSequence y no crea nada', () => {
    const repo = consumer(CAF_CONFIG)
    const result = bootstrap([SUBSCRIPTION], repo, world({ available: () => 'False' }))
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      "ERROR: el nombre 'sttfstatecadeveus2001' de Storage Account ya esta tomado en Azure (colision global).\n" +
        `  Incrementa 'resourceSequence' en ${join(repo, '.mefisto', 'harness.config.json')} (actual: '001') y reintenta -- MEF-ADR-0045 seccion 2 prohibe volver a un sufijo aleatorio.\n`,
    )
    assert.equal(result.cli.count(' create '), 0)
    assert.ok(!existsSync(backendTf(repo)))
  })

  test('avisa cuando el prefijo del proyecto se trunca', () => {
    const repo = consumer({ ...CAF_CONFIG, infraResourceGroupPrefix: 'rg-controldeasistencias' })
    const result = summary([SUBSCRIPTION], repo)
    assert.match(
      result.stderr,
      /^AVISO: 'infraResourceGroupPrefix' \('rg-controldeasistencias'\) no deja espacio para el patron CAF del tfstate \('sttfstate\{app\}deveus2001'\) dentro del limite de 24 chars; se trunca la porcion de proyecto \(resultado: 'sttfstatecontrdeveus2001'\)\.\n/,
    )
  })

  test('aborta si los componentes fijos del patron desbordan el limite', () => {
    const repo = consumer({ ...CAF_CONFIG, azureRegionShort: 'westeurope', resourceSequence: '000001' })
    const result = summary([SUBSCRIPTION, '--env', 'staging'], repo)
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /ERROR: el nombre CAF de la Storage Account del tfstate \('sttfstatestagingwesteurope000001', 32 chars\) no cumple el naming de Azure Storage \(3-24 chars, solo minusculas y digitos\)\.\n/,
    )
    assert.deepEqual(result.cli.calls, [])
  })

  test('el backend.tf ya versionado manda aunque el config gane azureRegionShort', () => {
    const repo = consumer(CAF_CONFIG)
    writeFile(
      backendTf(repo),
      'terraform {\n  backend "azurerm" {\n    resource_group_name  = "rg-prueba-tfstate"\n    storage_account_name = "stpruebatfstateabc123"\n  }\n}\n',
    )
    const result = bootstrap([SUBSCRIPTION], repo)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /\n {2}Resource Group: {2}rg-prueba-tfstate\n/)
    assert.match(result.stdout, /\n {2}Storage Account: stpruebatfstateabc123\n/)
    assert.equal(result.cli.count('check-name'), 0)
  })
})

describe('escritura de backend.tf', () => {
  test('con un backend azurerm en otro .tf avisa y no escribe backend.tf', () => {
    const repo = consumer()
    writeFile(
      join(repo, 'infra', 'environments', 'dev', 'main.tf'),
      'terraform {\n  backend "azurerm" {\n    resource_group_name  = "rg-prueba-tfstate"\n    storage_account_name = "stpruebatfstateabc123"\n  }\n}\n',
    )
    const result = bootstrap([SUBSCRIPTION], repo)
    assert.equal(result.status, 0)
    assert.equal(
      result.stderr,
      'AVISO: ya existe un bloque backend "azurerm" en:\n' +
        '  - infra/environments/dev/main.tf\n' +
        '  No se escribe infra/environments/dev/backend.tf para no duplicar la definicion del backend.\n',
    )
    assert.ok(!existsSync(backendTf(repo)))
    assert.doesNotMatch(result.stdout, /Escrito /)
  })

  test('si el container no se puede crear explica el rol que falta y no escribe backend.tf', () => {
    const repo = consumer()
    const result = bootstrap(
      [SUBSCRIPTION],
      repo,
      world({ failing: (call) => (starts(call, 'az', 'storage', 'container', 'create') ? 1 : undefined) }),
    )
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'fallo forzado\n' +
        "ERROR: no se pudo crear el container 'tfstate'.\n" +
        "  Con --auth-mode login necesitas el rol 'Storage Blob Data Contributor'\n" +
        '  sobre la Storage Account. Tras asignarlo, la propagacion RBAC puede\n' +
        '  tardar unos minutos; re-ejecuta este script (es idempotente).\n',
    )
    assert.ok(!existsSync(backendTf(repo)))
  })

  test('un fallo de az al crear un recurso termina con su codigo', () => {
    const repo = consumer()
    const result = bootstrap(
      [SUBSCRIPTION],
      repo,
      world({ failing: (call) => (starts(call, 'az', 'group', 'create') ? 9 : undefined) }),
    )
    assert.equal(result.status, 9)
    assert.equal(result.stderr, 'fallo forzado\n')
    assert.equal(result.cli.count('storage account create'), 0)
    assert.ok(!existsSync(backendTf(repo)))
  })
})

describe('distribucion', () => {
  test('dist/claude trae el shim y el script identicos a scripts/, y los inventaria', () => {
    assertDistributed(['bootstrap-backend.sh', 'bootstrap-backend.mts', 'lib/tfstate-naming.mts'])
  })

  test('la copia de dist resuelve sus modulos: llega hasta el cargador del config', () => {
    const result = runScript(
      join(DIST_SCRIPTS, 'bootstrap-backend.mts'),
      ['--help'],
      box.repo('dist'),
      box.work,
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no se encontro el config canonico/)
  })

  test('la copia de dist aborta en un repo con plugin.json', () => {
    const result = runScript(
      join(DIST_SCRIPTS, 'bootstrap-backend.mts'),
      [],
      box.pluginRepo('plugin'),
      box.work,
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /solo aplica al consumidor/)
  })

  test('el script de scripts/ termina en 1 en el repo de Mefisto', () => {
    const result = runScript(SCRIPT, [SUBSCRIPTION], REPO_ROOT, box.work)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })
})
