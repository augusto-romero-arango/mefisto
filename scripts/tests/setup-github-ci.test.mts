import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { Output } from '../lib/azure-cli.mts'
import { repoSlugFromRemote, resolveBackendPair, setupGithubCi } from '../setup-github-ci.mts'
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
  writeConfig,
  writeFile,
} from './azure-cli-sandbox.mts'
import type { Call, Respond, Sandbox } from './azure-cli-sandbox.mts'

const SCRIPT = join(SCRIPTS, 'setup-github-ci.mts')
const ISSUER = 'https://token.actions.githubusercontent.com'
const AUDIENCE = 'api://AzureADTokenExchange'
const CAF_RG = 'rg-tfstate-mefisto-certification-dev-eus2-001'
const CAF_STORAGE = 'sttfstatemefisdeveus2001'
const CONFIG = {
  projectName: 'Certificacion',
  namespacePrefix: 'Certificacion',
  solutionFile: 'Certificacion.slnx',
  githubServicePrincipalName: 'github-certificacion-ci',
  domainLabels: ['certificacion'],
  boundedContext: { name: 'Certificacion', domains: ['certificacion'] },
}

let box: Sandbox
let repos = 0

before(() => {
  box = sandbox('setup ci')
})

after(() => {
  box.remove()
})

function backend(resourceGroup: string, storage: string): string {
  return `terraform {
  backend "azurerm" {
    resource_group_name  = "${resourceGroup}"
    storage_account_name = "${storage}"
  }
}
`
}

/** Consumidor legacy (config en `.claude/`) con los `.tf` dados bajo `infra/environments/`. */
function consumer(
  files: Record<string, string> = { 'dev/backend.tf': backend(CAF_RG, CAF_STORAGE) },
): string {
  const repo = box.repo(`consumidor-${++repos}`)
  writeConfig(repo, CONFIG, true)
  for (const [file, content] of Object.entries(files)) {
    writeFile(join(repo, 'infra', 'environments', ...file.split('/')), content)
  }
  return repo
}

interface Credential {
  name: string
  issuer: string
  subject: string
  description: string
  audiences: string[]
}

function credential(name: string, subject: string, audiences: string[] = [AUDIENCE]): Credential {
  return { name, issuer: ISSUER, subject, description: 'fixture', audiences }
}

/** El GitHub y el Azure de mentira; `credentials` es el estado de las federated credentials. */
interface World {
  ghSlug: string
  metadata: string
  apiFails: boolean
  origin: string
  appId: string
  spExists: boolean
  credentials: Credential[]
  failing: (call: Call) => number | undefined
}

function world(overrides: Partial<World> = {}): World {
  return {
    ghSlug: 'acme/certificacion',
    metadata: '{"full_name":"acme/certificacion","owner":{"id":101},"id":202}',
    apiFails: false,
    origin: 'https://github.com/acme/certificacion.git',
    appId: 'app-existing',
    spExists: true,
    credentials: [],
    failing: () => undefined,
    ...overrides,
  }
}

function respond(state: World): Respond {
  return (call) => {
    const forced = state.failing(call)
    if (forced !== undefined) return { status: forced, stderr: 'fallo forzado\n' }
    if (starts(call, 'gh', 'repo'))
      return state.ghSlug.length > 0 ? { stdout: `${state.ghSlug}\n` } : { status: 1 }
    if (starts(call, 'gh', 'api')) return state.apiFails ? { status: 1 } : { stdout: `${state.metadata}\n` }
    if (call.command === 'gh') return { status: 1 }
    if (starts(call, 'git', 'remote'))
      return state.origin.length > 0 ? { stdout: `${state.origin}\n` } : { status: 2 }
    if (starts(call, 'az', 'ad', 'app', 'list')) return { stdout: `${state.appId}\n` }
    if (starts(call, 'az', 'ad', 'app', 'create')) return { stdout: 'app-created\n' }
    if (starts(call, 'az', 'ad', 'sp', 'show')) {
      if (!state.spExists) return { status: 3 }
      return call.args.includes('--query') ? { stdout: 'sp-object-existing\n' } : undefined
    }
    if (starts(call, 'az', 'ad', 'sp', 'create')) {
      state.spExists = true
      return undefined
    }
    if (starts(call, 'az', 'account', 'show')) return { stdout: 'tenant-existing\n' }
    if (starts(call, 'az', 'role', 'definition', 'list')) {
      const ids: Record<string, string> = { Owner: 'owner-id', 'User Access Administrator': 'uaa-id' }
      return { stdout: `${ids[option(call, '--name')] ?? 'rbac-id'}\n` }
    }
    if (starts(call, 'az', 'ad', 'app', 'federated-credential')) {
      const action = call.args[3]
      if (action === 'list') return { stdout: `${JSON.stringify(state.credentials)}\n` }
      const parameters = option(call, '--parameters')
      if (parameters.length === 0) return { status: 2 }
      const item = JSON.parse(parameters) as Credential
      if (action === 'create') state.credentials.push(item)
      else if (action === 'update') {
        state.credentials = state.credentials.map((current) => (current.name === item.name ? item : current))
      } else return { status: 2 }
    }
    return undefined
  }
}

interface Result {
  status: number
  out: string
  stdout: string
  stderr: string
  cli: FakeCli
  state: World
}

function setup(argv: string[], state: World = world(), cwd: string = consumer(), runs = 1): Result {
  const cli = new FakeCli(respond(state))
  const output = new Output()
  let status = 0
  for (let i = 0; i < runs && status === 0; i++) {
    status = setupGithubCi(argv, { cwd, program: 'setup-github-ci', run: cli.run, output })
  }
  return { status, out: output.all, stdout: output.stdout, stderr: output.stderr, cli, state }
}

const CREATE = 'az ad app federated-credential create'
const UPDATE = 'az ad app federated-credential update'
const logged = (result: Result, fragment: string): boolean => result.cli.count(fragment) > 0

describe('subject inmutable', () => {
  test('la creacion limpia resuelve el slug sola y crea las dos credenciales administradas', () => {
    const result = setup(['subscription-test'])
    assert.equal(result.status, 0)
    assert.ok(logged(result, 'gh api repos/acme/certificacion'))
    assert.ok(logged(result, 'repo:acme@101/certificacion@202:ref:refs/heads/main'))
    assert.ok(logged(result, 'repo:acme@101/certificacion@202:pull_request'))
    assert.equal(result.cli.count(CREATE), 2)
    assert.ok(!logged(result, 'credential reset'))
    assert.deepEqual(
      result.state.credentials.map((item) => [item.name, item.issuer, item.audiences]),
      [
        ['github-actions-deploy-main', ISSUER, [AUDIENCE]],
        ['github-actions-plan-pr', ISSUER, [AUDIENCE]],
      ],
    )
  })

  test('el argumento explicito consulta y valida ese mismo slug', () => {
    const result = setup(
      ['subscription-test', 'acme/explicito'],
      world({ metadata: '{"full_name":"acme/explicito","owner":{"id":303},"id":404}' }),
    )
    assert.equal(result.status, 0)
    assert.ok(logged(result, 'gh api repos/acme/explicito'))
    assert.ok(logged(result, 'repo:acme@303/explicito@404:pull_request'))
    assert.ok(!logged(result, 'gh repo view'))
  })

  test('sin gh autenticado toma el slug del remote origin', () => {
    const result = setup(
      ['subscription-test'],
      world({ ghSlug: '', origin: 'git@github.com:acme/certificacion.git' }),
    )
    assert.equal(result.status, 0)
    assert.ok(logged(result, 'gh api repos/acme/certificacion'))
  })

  test('repoSlugFromRemote entiende https y ssh', () => {
    assert.equal(repoSlugFromRemote('https://github.com/acme/repo.git'), 'acme/repo')
    assert.equal(repoSlugFromRemote('git@github.com:acme/repo.git'), 'acme/repo')
    assert.equal(repoSlugFromRemote('https://github.com/acme/repo'), 'acme/repo')
    assert.equal(repoSlugFromRemote(''), '')
  })

  test('sin slug resoluble o con uno mal formado aborta antes de Azure', () => {
    const none = setup(['subscription-test'], world({ ghSlug: '', origin: '' }))
    assert.equal(none.status, 1)
    assert.equal(
      none.stderr,
      'ERROR: no se pudo resolver el slug owner/repo del repositorio.\n' +
        'Pasalo como 2do argumento (setup-github-ci subscription-test <owner/repo>) o configura un\n' +
        "remote 'origin' de GitHub / autentica 'gh', y reintenta.\n",
    )
    const malformed = setup(['subscription-test', 'solo-repo'])
    assert.equal(malformed.status, 1)
    assert.equal(
      malformed.stderr,
      "ERROR: el repositorio debe tener el formato owner/repo; se recibio 'solo-repo'.\n",
    )
    for (const result of [none, malformed]) assert.ok(!logged(result, 'az '))
  })
})

describe('metadata de GitHub', () => {
  test('una metadata ajena, sin IDs validos o inaccesible aborta antes de cualquier efecto en Azure', () => {
    const foreign = setup(
      ['subscription-test', 'acme/certificacion'],
      world({ metadata: '{"full_name":"acme/otro","owner":{"id":101},"id":202}' }),
    )
    assert.notEqual(foreign.status, 0)
    assert.match(
      foreign.out,
      /ERROR: GitHub devolvio metadata de 'acme\/otro', no de 'acme\/certificacion'\./,
    )

    const withoutIds = setup(
      ['subscription-test', 'acme/certificacion'],
      world({ metadata: '{"full_name":"acme/certificacion","owner":{"id":0},"id":202}' }),
    )
    assert.notEqual(withoutIds.status, 0)
    assert.match(withoutIds.out, /no contiene IDs inmutables validos de owner y repositorio/)

    const unavailable = setup(['subscription-test', 'acme/certificacion'], world({ apiFails: true }))
    assert.notEqual(unavailable.status, 0)
    assert.match(unavailable.out, /Autentica 'gh' con acceso al repositorio/)

    for (const result of [foreign, withoutIds, unavailable]) assert.ok(!logged(result, 'az '))
  })

  test('una respuesta que no es JSON se reporta como repositorio desconocido', () => {
    const result = setup(['subscription-test', 'acme/certificacion'], world({ metadata: 'no es json' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /metadata de 'un repositorio desconocido', no de 'acme\/certificacion'/)
  })
})

describe('federated credentials', () => {
  test('reconcilia solo los nombres administrados y preserva las credenciales ajenas', () => {
    const result = setup(
      ['subscription-test', 'acme/certificacion'],
      world({
        credentials: [
          credential('github-actions-deploy-main', 'repo:acme/certificacion:ref:refs/heads/main'),
          credential('github-actions-plan-pr', 'repo:acme/certificacion:pull_request'),
          credential('credencial-ajena', 'repo:otra/identidad:pull_request'),
        ],
      }),
    )
    assert.equal(result.status, 0)
    assert.equal(result.cli.count(UPDATE), 2)
    assert.equal(result.cli.count(CREATE), 0)
    assert.deepEqual(
      result.state.credentials.map((item) => [item.name, item.subject]),
      [
        ['github-actions-deploy-main', 'repo:acme@101/certificacion@202:ref:refs/heads/main'],
        ['github-actions-plan-pr', 'repo:acme@101/certificacion@202:pull_request'],
        ['credencial-ajena', 'repo:otra/identidad:pull_request'],
      ],
    )
    assert.ok(
      logged(
        result,
        `${UPDATE} --id app-existing --federated-credential-id github-actions-deploy-main --parameters {"name":"github-actions-deploy-main"`,
      ),
    )
  })

  test('repara issuer y audience del nombre administrado aunque el subject ya coincida', () => {
    const result = setup(
      ['subscription-test', 'acme/certificacion'],
      world({
        credentials: [
          credential('github-actions-deploy-main', 'repo:acme@101/certificacion@202:ref:refs/heads/main', [
            'audience-incorrecta',
          ]),
        ],
      }),
    )
    assert.equal(result.status, 0)
    assert.equal(result.cli.count(UPDATE), 1)
    assert.deepEqual(
      result.state.credentials.map((item) => item.audiences),
      [[AUDIENCE], [AUDIENCE]],
    )
  })

  test('una segunda ejecucion deja exactamente dos credenciales administradas', () => {
    const result = setup(['subscription-test', 'acme/certificacion'], world(), consumer(), 2)
    assert.equal(result.status, 0)
    assert.equal(result.cli.count(CREATE), 2)
    assert.equal(result.cli.count(UPDATE), 0)
    assert.equal(result.state.credentials.filter((item) => item.name.startsWith('github-actions-')).length, 2)
    assert.match(
      result.stdout,
      /Federated credential administrada 'github-actions-deploy-main' ya existe; se reutiliza\.\n/,
    )
  })

  test('no toca una credencial ajena que ya usa el subject efectivo', () => {
    const result = setup(
      ['subscription-test', 'acme/certificacion'],
      world({ credentials: [credential('ajena', 'repo:acme@101/certificacion@202:ref:refs/heads/main')] }),
    )
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      "ERROR: una federated credential ajena ya usa el subject efectivo de 'github-actions-deploy-main'.\n" +
        "  Renombrala al nombre administrado 'github-actions-deploy-main' o retirala antes de reintentar; no se modifico automaticamente.\n",
    )
    assert.equal(result.cli.count(CREATE) + result.cli.count(UPDATE), 0)
  })

  test('una lista ilegible o un nombre administrado repetido abortan', () => {
    const unreadable = setup(
      ['subscription-test', 'acme/certificacion'],
      world({
        failing: (call) =>
          call.args[3] === 'list' && call.args[2] === 'federated-credential' ? 1 : undefined,
      }),
    )
    assert.equal(unreadable.status, 1)
    assert.match(
      unreadable.stderr,
      /ERROR: no se pudieron inspeccionar las federated credentials de la aplicacion 'app-existing'\.\n$/,
    )

    const name = 'github-actions-deploy-main'
    const repeated = setup(
      ['subscription-test', 'acme/certificacion'],
      world({ credentials: [credential(name, 'a'), credential(name, 'b')] }),
    )
    assert.equal(repeated.status, 1)
    assert.equal(
      repeated.stderr,
      `ERROR: Azure devolvio mas de una federated credential con el nombre administrado '${name}'.\n`,
    )
  })
})

describe('pareja del tfstate y roles', () => {
  test('conserva la pareja durable del backend CAF y asigna los tres roles', () => {
    const result = setup(['subscription-test', 'acme/certificacion'])
    assert.equal(result.status, 0)
    assert.ok(
      logged(
        result,
        `--scope /subscriptions/subscription-test/resourceGroups/${CAF_RG}/providers/Microsoft.Storage/storageAccounts/${CAF_STORAGE}`,
      ),
    )
    assert.equal(result.cli.count('az role assignment create'), 3)
    assert.equal(result.cli.count('Storage Blob Data Contributor'), 1)
    assert.ok(!logged(result, 'az ad app create'))
    assert.ok(!logged(result, 'az ad sp create'))
    assert.deepEqual(
      result.cli.log
        .filter((line) => line.startsWith('az role assignment create'))
        .map((line) => line.split(' --scope ')[0]),
      ['Contributor', 'Role Based Access Control Administrator', 'Storage Blob Data Contributor'].map(
        (role) =>
          `az role assignment create --assignee-object-id sp-object-existing --assignee-principal-type ServicePrincipal --role ${role}`,
      ),
    )
  })

  test('la condicion anti-escalacion excluye Owner, RBAC Admin y User Access Administrator', () => {
    const result = setup(['subscription-test', 'acme/certificacion'])
    const rbac = result.cli.calls.find((call) => call.args.includes('--condition'))
    assert.ok(rbac !== undefined)
    assert.equal(
      option(rbac, '--condition'),
      "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAllValues:GuidNotEquals {owner-id, rbac-id, uaa-id})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAllValues:GuidNotEquals {owner-id, rbac-id, uaa-id}))",
    )
    assert.equal(option(rbac, '--condition-version'), '2.0')
    assert.equal(option(rbac, '--scope'), '/subscriptions/subscription-test')
  })

  test('el backend legacy conserva ambos literales', () => {
    const repo = consumer({
      'dev/backend.tf': backend('rg-certificacion-tfstate-legacy', 'stlegacycertificacion001'),
    })
    const result = setup(['subscription-test', 'acme/certificacion'], world(), repo)
    assert.equal(result.status, 0)
    assert.ok(
      logged(
        result,
        '/resourceGroups/rg-certificacion-tfstate-legacy/providers/Microsoft.Storage/storageAccounts/stlegacycertificacion001',
      ),
    )
  })

  test('los backends invalidos fallan antes de GitHub y de Azure', () => {
    const cases: [Record<string, string>, string][] = [
      [
        {
          'dev/backend.tf':
            'terraform {\n  backend "azurerm" {\n    resource_group_name  = var.tfstate_rg\n    storage_account_name = "stvalidcertificacion001"\n  }\n}\n',
        },
        'infra/environments/dev: resource_group_name y storage_account_name deben ser literales y completos',
      ],
      [
        { 'dev/versions.tf': 'terraform { required_version = ">= 1.9" }\n' },
        'infra/environments/dev: no contiene un bloque backend azurerm',
      ],
      [
        {
          'dev/backend.tf':
            'terraform {\n  backend "azurerm" {\n    resource_group_name = "rg-tfstate-incompleto"\n  }\n}\n',
        },
        'infra/environments/dev: resource_group_name y storage_account_name deben ser literales y completos',
      ],
      [
        {
          'dev/backend.tf': backend('rg-tfstate-dev', 'sttfstatecertdev001'),
          'dev/main.tf': backend('rg-tfstate-dev', 'sttfstatecertdev001'),
        },
        'infra/environments/dev: contiene 2 bloques backend azurerm',
      ],
    ]
    for (const [files, problem] of cases) {
      const result = setup(['subscription-test', 'acme/certificacion'], world(), consumer(files))
      assert.equal(result.status, 1)
      assert.deepEqual(result.cli.calls, [])
      assert.equal(
        result.stderr,
        'ERROR: no se pudo resolver una unica pareja completa del backend Terraform.\n' +
          '  Candidatos problematicos:\n' +
          `  - ${problem}\n` +
          '  Ejecuta scripts/bootstrap-backend.mts para un ambiente o corrige el backend antes de reintentar.\n',
      )
    }
  })

  test('dos ambientes completos son ambiguos y se listan', () => {
    const repo = consumer({
      'dev/backend.tf': backend('rg-tfstate-dev', 'sttfstatecertdev001'),
      'prod/backend.tf': backend('rg-tfstate-prod', 'sttfstatecertprod001'),
    })
    const result = setup(['subscription-test', 'acme/certificacion'], world(), repo)
    assert.equal(result.status, 1)
    assert.deepEqual(result.cli.calls, [])
    assert.equal(
      result.stderr,
      'ERROR: no se pudo resolver una unica pareja completa del backend Terraform.\n' +
        '  Candidatos completos:\n' +
        '  - infra/environments/dev|rg-tfstate-dev|sttfstatecertdev001\n' +
        '  - infra/environments/prod|rg-tfstate-prod|sttfstatecertprod001\n' +
        '  Ejecuta scripts/bootstrap-backend.mts para un ambiente o corrige el backend antes de reintentar.\n',
    )
  })

  test('sin ambientes informa que no hay backend', () => {
    const repo = consumer({})
    assert.throws(
      () => resolveBackendPair(repo),
      /\n {2}No se encontro un backend azurerm bajo infra\/environments\/\*\/\.\n/,
    )
    writeFile(join(repo, 'infra', 'environments', 'notas.txt'), 'no es un ambiente\n')
    assert.throws(() => resolveBackendPair(repo), /No se encontro un backend azurerm/)
  })

  test('resolveBackendPair devuelve la pareja del unico ambiente completo', () => {
    assert.deepEqual(resolveBackendPair(consumer()), { resourceGroup: CAF_RG, storage: CAF_STORAGE })
  })
})

describe('aplicacion y service principal', () => {
  test('sin aplicacion previa la crea junto con su service principal', () => {
    for (const listed of ['', 'None']) {
      const result = setup(
        ['subscription-test', 'acme/certificacion'],
        world({ appId: listed, spExists: false }),
      )
      assert.equal(result.status, 0)
      assert.ok(
        logged(result, 'az ad app create --display-name github-certificacion-ci --query appId -o tsv'),
      )
      assert.ok(logged(result, 'az ad sp create --id app-created -o none'))
      assert.match(
        result.stdout,
        /Creando aplicacion 'github-certificacion-ci'\.\.\.\nCreando service principal para appId app-created\.\.\.\n/,
      )
      assert.match(
        result.stdout,
        /\n {2}AZURE_CLIENT_ID {7}= app-created\n {2}AZURE_TENANT_ID {7}= tenant-existing\n {2}AZURE_SUBSCRIPTION_ID = subscription-test\n/,
      )
    }
  })

  test('si no se puede fijar la suscripcion aborta sin crear nada', () => {
    const result = setup(
      ['subscription-test', 'acme/certificacion'],
      world({ failing: (call) => (starts(call, 'az', 'account', 'set') ? 1 : undefined) }),
    )
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'fallo forzado\n' +
        "ERROR: no se pudo fijar la suscripcion 'subscription-test'.\n" +
        "  Verifica que 'az login' este hecho y que la suscripcion exista.\n",
    )
    assert.deepEqual(
      result.cli.log.filter((line) => line.startsWith('az')),
      ['az account set --subscription subscription-test'],
    )
  })

  test('un fallo de az al asignar un rol termina con su codigo', () => {
    const result = setup(
      ['subscription-test', 'acme/certificacion'],
      world({ failing: (call) => (starts(call, 'az', 'role', 'assignment') ? 7 : undefined) }),
    )
    assert.equal(result.status, 7)
    assert.equal(result.cli.count('az role assignment create'), 1)
    assert.equal(result.cli.count('federated-credential'), 0)
  })

  test('si az no resuelve los roles integrados aborta antes de asignar el segundo rol', () => {
    const silent = setup(
      ['subscription-test', 'acme/certificacion'],
      world({ failing: (call) => (starts(call, 'az', 'role', 'definition') ? 6 : undefined) }),
    )
    assert.equal(silent.status, 6)
    assert.equal(silent.stderr, '')

    const cli = new FakeCli()
    const state = world()
    cli.respond = (call) =>
      starts(call, 'az', 'role', 'definition') ? { stdout: '\n' } : respond(state)(call)
    const output = new Output()
    const status = setupGithubCi(['subscription-test', 'acme/certificacion'], {
      cwd: consumer(),
      program: 'setup-github-ci',
      run: cli.run,
      output,
    })
    assert.equal(status, 1)
    assert.equal(
      output.stderr,
      'ERROR: no se pudieron resolver los IDs de los roles integrados Owner,\n' +
        "  'User Access Administrator' y/o 'Role Based Access Control Administrator'.\n",
    )
    assert.equal(cli.count('az role assignment create'), 1)
  })
})

describe('argumentos y guard', () => {
  test('sin suscripcion imprime el uso por stdout y termina en 1', () => {
    const result = setup([])
    assert.equal(result.status, 1)
    assert.equal(
      result.stdout,
      'Uso: setup-github-ci <subscription-id> [<owner/repo>]\n' +
        'Ejemplo: setup-github-ci 50fc1901-9723-4971-9d63-b3f1a015e8b8 acme/mi-proyecto\n',
    )
    assert.deepEqual(result.cli.calls, [])
  })

  test('el config se carga antes de mirar los argumentos', () => {
    const empty = box.repo('sin-config')
    const result = setup(['--help'], world(), empty)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: no se encontro el config canonico requerido /)
  })

  test('en el repo de Mefisto se niega sin llamar a nada', () => {
    const result = setup(['subscription-test'], world(), REPO_ROOT)
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: scripts/setup-github-ci.mts es del plugin publicado y solo aplica al consumidor.\n' +
        'Mefisto no se despliega a Azure ni necesita Service Principal.\n',
    )
    assert.deepEqual(result.cli.calls, [])
  })
})

describe('distribucion', () => {
  test('dist/claude trae el shim y el script identicos a scripts/, y los inventaria', () => {
    assertDistributed(['setup-github-ci.mts', 'setup-github-ci.mts', 'lib/azure-cli.mts'])
  })

  test('la copia de dist resuelve sus modulos: llega hasta el cargador del config', () => {
    const result = runScript(
      join(DIST_SCRIPTS, 'setup-github-ci.mts'),
      ['--help'],
      box.repo('dist'),
      box.work,
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no se encontro el config canonico/)
  })

  test('la copia de dist aborta en un repo con plugin.json', () => {
    const result = runScript(
      join(DIST_SCRIPTS, 'setup-github-ci.mts'),
      [],
      box.pluginRepo('plugin'),
      box.work,
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /solo aplica al consumidor/)
  })

  test('el script de scripts/ termina en 1 en el repo de Mefisto', () => {
    const result = runScript(SCRIPT, ['subscription-test'], REPO_ROOT, box.work)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })
})
