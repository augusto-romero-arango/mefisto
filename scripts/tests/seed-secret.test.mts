import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CommandResult } from '../lib/cli.mts'
import { findDomainKebab, flatten, secretListed, seedSecret } from '../seed-secret.mts'
import {
  CANONICAL_CONFIG,
  LEGACY_CONFIG,
  PLUGIN_MANIFEST,
  configJson,
  initRepo,
  pathIn,
  sink,
} from './consumer-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'seed-secret.mts')
const COMMAND = join(HERE, '..', '..', 'commands', 'seed-secret.md')
const PROGRAM = 'scripts/seed-secret.mts'
const USAGE = [
  `Uso: ${PROGRAM} <nombre> --domain <dominio> (--from-output <output> | --from-github-secret <NOMBRE>) [--env <env>]`,
  `Ejemplo: ${PROGRAM} stripe-api-key --domain facturacion --from-github-secret STRIPE_API_KEY`,
].join('\n')
const DOMAIN_TF = 'infra/environments/dev/dominio-facturacion.tf'
const HCL = 'module "function_app_facturacion" {\n  app_settings = {}\n}\n'
const FROM_OUTPUT = ['stripe-api-key', '--domain', 'facturacion', '--from-output', 'stripe_api_key']

let work = ''
let sequence = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto seed secret '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function config(project: string): string {
  return configJson({
    projectName: project,
    domainLabels: ['facturacion'],
    boundedContext: { name: 'Principal', domains: ['facturacion'] },
  })
}

function makeConsumer(files: Record<string, string>): string {
  return initRepo(join(work, `consumidor-${++sequence}`), { [DOMAIN_TF]: HCL, ...files })
}

interface Run {
  status: number
  out: string[]
  err: string[]
  calls: string[][]
}

/** `gh`: `null` si no esta instalado; si no, lo que responde `gh secret list`. */
function run(repo: string, argv: string[], gh: CommandResult | null = null): Run {
  const output = sink()
  const calls: string[][] = []
  const status = seedSecret(argv, {
    cwd: repo,
    program: PROGRAM,
    hasCommand: (command) => command === 'gh' && gh !== null,
    run: (command, args) => {
      calls.push([command, ...args])
      return gh ?? { status: null, stdout: '', stderr: '' }
    },
    ...output.io,
  })
  return { status, out: output.out, err: output.err, calls }
}

function firstSecret(repo: string, rel: string): unknown {
  return (JSON.parse(readFileSync(pathIn(repo, rel), 'utf8')) as { secrets?: unknown[] }).secrets?.[0]
}

describe('ruta del config', () => {
  test('[1] consumidor canonico: registra y anuncia la ruta escrita', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    const path = pathIn(repo, CANONICAL_CONFIG)
    const result = run(repo, FROM_OUTPUT)
    assert.equal(result.status, 0)
    assert.deepEqual(result.out.slice(0, 2), [
      `OK: 'stripe-api-key' registrado en ${path} > secrets[] (source: output:stripe_api_key).`,
      `Registro: ${path}`,
    ])
    assert.deepEqual(firstSecret(repo, CANONICAL_CONFIG), {
      name: 'stripe-api-key',
      source: { type: 'output', value: 'stripe_api_key' },
    })
  })

  test('[2] con los dos configs escribe solo el canonico', () => {
    const legacy = config('legacy')
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical'), [LEGACY_CONFIG]: legacy })
    const result = run(repo, FROM_OUTPUT)
    assert.equal(result.status, 0)
    assert.equal(readFileSync(pathIn(repo, LEGACY_CONFIG), 'utf8'), legacy)
    assert.deepEqual(firstSecret(repo, CANONICAL_CONFIG), {
      name: 'stripe-api-key',
      source: { type: 'output', value: 'stripe_api_key' },
    })
    assert.ok(result.out.includes(`Registro: ${pathIn(repo, CANONICAL_CONFIG)}`))
    assert.match(result.err[0] ?? '', /^AVISO: se usara el config canonico /)
  })

  test('[3] consumidor solo legacy: aborta sin mutar ni migrar', () => {
    const legacy = config('legacy')
    const repo = makeConsumer({ [LEGACY_CONFIG]: legacy })
    const result = run(repo, FROM_OUTPUT)
    assert.equal(result.status, 1)
    assert.equal(existsSync(pathIn(repo, CANONICAL_CONFIG)), false)
    assert.equal(readFileSync(pathIn(repo, LEGACY_CONFIG), 'utf8'), legacy)
    assert.deepEqual(result.out, [])
    const [error] = result.err.slice(-1)
    assert.match(error ?? '', /^ERROR: solo existe el config legacy /)
    assert.match(
      error ?? '',
      /\n {2}Migra conscientemente el archivo completo a .* antes de registrar secretos\.\n/,
    )
    assert.ok(
      error?.endsWith(
        "ERROR: no se pudo registrar 'stripe-api-key' en secrets[] del contrato canonico .mefisto/harness.config.json; revisa el diagnostico anterior.",
      ),
    )
  })

  test('[4] ni el script ni el comando presentan el config legacy como destino', () => {
    assert.equal(readFileSync(SCRIPT, 'utf8').includes('.claude/harness.config.json'), false)
    assert.equal(readFileSync(COMMAND, 'utf8').includes('.claude/harness.config.json'), false)
  })
})

describe('cableado', () => {
  test('imprime el app setting y el role assignment del dominio, en kebab o PascalCase', () => {
    const repo = makeConsumer({
      [CANONICAL_CONFIG]: configJson(),
      'infra/environments/dev/dominio-calculo-horas.tf': HCL,
      'src/Empresa.Proyecto.CalculoHoras/Program.cs': '',
    })
    for (const domain of ['calculo-horas', 'CalculoHoras']) {
      const result = run(repo, ['stripe-api-key', '--domain', domain, '--from-output', 'salida'])
      assert.equal(result.status, 0)
      assert.deepEqual(result.err, [])
      assert.deepEqual(result.out.slice(2), [
        '',
        'Cableado pendiente en infra/environments/dev/dominio-calculo-horas.tf (module "function_app_*" > app_settings):',
        '  STRIPE_API_KEY = "@Microsoft.KeyVault(SecretUri=${module.key_vault.uri}secrets/stripe-api-key)"',
        '',
        'Rol de lectura (Key Vault Secrets User) de la managed identity de este dominio:',
        '  ya lo emite domain-scaffolder al crear el dominio (azurerm_role_assignment',
        '  function_app_calculo_horas_kv_secrets_user, scope = module.key_vault.id) -- cubre',
        '  TODOS los secretos del vault, incluido este (CA-6: no dupliques ese role assignment).',
        '  Verifica que el bloque exista en infra/environments/dev/dominio-calculo-horas.tf; si por alguna razon faltara, agregalo',
        '  (ver agents/domain-scaffolder.md).',
      ])
    }
  })

  test('sin la carpeta del dominio en src/ advierte y continua', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    const result = run(repo, FROM_OUTPUT)
    assert.equal(result.status, 0)
    assert.deepEqual(result.err, [
      `ADVERTENCIA: se encontro ${DOMAIN_TF} pero no src/Empresa.Proyecto.<Dominio>/ correspondiente.`,
      '             continua igual: el archivo Terraform es la fuente de verdad para el cableado.',
    ])
  })

  test('un dominio sin archivo Terraform en el ambiente aborta sin registrar', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    for (const [argv, dir] of [
      [['s', '--domain', 'nada', '--from-output', 'o'], 'dev'],
      [['s', '--domain', 'facturacion', '--from-output', 'o', '--env', 'prod'], 'prod'],
    ] as const) {
      const result = run(repo, [...argv])
      assert.equal(result.status, 1)
      assert.match(
        result.err[0] ?? '',
        new RegExp(`^ERROR: no se encontro infra/environments/${dir}/dominio-\\*\\.tf para el dominio `),
      )
    }
    assert.equal(firstSecret(repo, CANONICAL_CONFIG), undefined)
  })
})

describe('GitHub secret', () => {
  const argv = ['stripe', '--domain', 'facturacion', '--from-github-secret', 'STRIPE_API_KEY']
  const listing = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' })

  test('registra la fuente github-secret y confirma el secreto que ya existe', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    const result = run(repo, argv, listing('OTRO\t2026-01-01\nSTRIPE_API_KEY\t2026-01-02\n'))
    assert.equal(result.status, 0)
    assert.deepEqual(result.calls, [['gh', 'secret', 'list']])
    assert.equal(result.out[2], "OK: el GitHub secret 'STRIPE_API_KEY' ya existe en el repo.")
    assert.deepEqual(firstSecret(repo, CANONICAL_CONFIG), {
      name: 'stripe',
      source: { type: 'github-secret', value: 'STRIPE_API_KEY' },
    })
  })

  test('recuerda crear el secreto que falta', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    const result = run(repo, argv, listing('STRIPE_API_KEY_2\t2026-01-02\n'))
    assert.deepEqual(result.out.slice(2, 5), [
      "RECORDATORIO: crea el GitHub secret 'STRIPE_API_KEY' (Settings > Secrets and variables > Actions)",
      "              antes del proximo apply que deba sembrar 'stripe' -- si no, ese apply fallara",
      '              al no encontrar el valor (ver agents/infra-base-scaffolder.md, Paso 2b).',
    ])
  })

  test('sin gh o sin sesion pide confirmarlo a mano', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    for (const gh of [null, { status: 1, stdout: '', stderr: '' }]) {
      const result = run(repo, argv, gh)
      assert.equal(result.status, 0)
      assert.deepEqual(result.out.slice(2, 4), [
        "RECORDATORIO: no se pudo verificar con 'gh secret list' (sin gh instalado o sin sesion).",
        "              Confirma manualmente que el GitHub secret 'STRIPE_API_KEY' existe antes del proximo apply.",
      ])
    }
  })
})

describe('argumentos y guard', () => {
  test('sin nombre, sin dominio o con un argumento desconocido imprime el uso', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    const cases: [string[], string][] = [
      [[], USAGE],
      [['s'], `ERROR: falta --domain <dominio>.\n${USAGE}`],
      [['', '--domain', 'facturacion', '--from-output', 'o'], `ERROR: falta <nombre> del secreto.\n${USAGE}`],
      [['s', '--zzz', '1'], `ERROR: argumento desconocido '--zzz'\n${USAGE}`],
    ]
    for (const [argv, message] of cases) {
      const result = run(repo, argv)
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [message])
    }
  })

  test('exige exactamente una fuente', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    assert.deepEqual(
      run(repo, ['s', '--domain', 'facturacion', '--from-output', 'o', '--from-github-secret', 'G']).err,
      ['ERROR: pasa exactamente uno de --from-output o --from-github-secret, no ambos.'],
    )
    assert.deepEqual(run(repo, ['s', '--domain', 'facturacion']).err, [
      'ERROR: pasa uno de --from-output <output> o --from-github-secret <NOMBRE> (D2: fuente explicita, sin heuristica por nombre).',
    ])
    assert.equal(firstSecret(repo, CANONICAL_CONFIG), undefined)
  })

  test('un flag sin valor al final termina en 1 sin mensaje', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    const result = run(repo, ['s', '--domain'])
    assert.equal(result.status, 1)
    assert.deepEqual([result.out, result.err], [[], []])
  })

  test('en el repo de Mefisto se niega antes de mirar los argumentos', () => {
    const mefisto = initRepo(join(work, 'mefisto'), { [PLUGIN_MANIFEST]: '{}' })
    const result = run(mefisto, [])
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, [
      [
        'ERROR: scripts/seed-secret.mts es del plugin publicado y solo aplica al consumidor.',
        'Mefisto no tiene harness.config.json ni dominios de negocio que sembrar.',
      ].join('\n'),
    ])
  })

  test('la linea de comando nombra el script en el uso y termina en 1', () => {
    const repo = makeConsumer({ [CANONICAL_CONFIG]: config('canonical') })
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.ok(
      result.stderr.startsWith(`Uso: node ${join(HERE, '..', 'seed-secret.mts')} <nombre> --domain <dominio> `),
    )
  })
})

describe('funciones', () => {
  test('flatten iguala kebab y PascalCase', () => {
    assert.equal(flatten('calculo-horas'), flatten('CalculoHoras'))
  })

  test('findDomainKebab devuelve el kebab del archivo, o null sin carpeta o sin archivo', () => {
    const repo = makeConsumer({ 'infra/environments/dev/dominio-calculo-horas.tf': HCL })
    const dir = pathIn(repo, 'infra/environments/dev')
    assert.equal(findDomainKebab(dir, 'CalculoHoras'), 'calculo-horas')
    assert.equal(findDomainKebab(dir, 'calculo'), null)
    assert.equal(findDomainKebab(join(dir, 'no existe'), 'facturacion'), null)
  })

  test('secretListed compara solo la primera columna, completa', () => {
    const listing = 'UNO\t2026-01-01\n  DOS  hace 2 dias\n'
    assert.equal(secretListed(listing, 'UNO'), true)
    assert.equal(secretListed(listing, 'DOS'), true)
    assert.equal(secretListed(listing, 'UN'), false)
    assert.equal(secretListed(listing, '2026-01-01'), false)
  })
})
