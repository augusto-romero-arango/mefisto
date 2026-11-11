import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture, commandExists } from '../lib/cli.mts'
import {
  azurermBackendLines,
  composeTfstateResourceGroupName,
  composeTfstateStorageAccountBase,
  genStorageSuffix,
  readBackendResourceGroupName,
  readBackendStorageAccountName,
  tfstateStorageAppSlug,
  truncateStorageBase,
} from '../lib/tfstate-naming.mts'

const BASH_LIBRARY = join(dirname(fileURLToPath(import.meta.url)), '..', '_pipeline-common.sh')
const STORAGE_NAME = /^[a-z0-9]{3,24}$/

let tmp = ''

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mefisto tfstate '))
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function terraformDir(name: string, files: Record<string, string> = {}): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
  return dir
}

const BACKEND_COMPLETO = `terraform {
  backend "azurerm" {
    resource_group_name  = "rg-cosmos-cplane-tfstate"
    storage_account_name = "stcplanetfstatedev18ecba"
    container_name       = "tfstate"
    key                  = "dev.tfstate"
  }
}
`
const BACKEND_CON_VARIABLES = `terraform {
  backend "azurerm" {
    resource_group_name  = var.tfstate_rg
    storage_account_name = var.tfstate_storage
  }
}
`

test('[1] truncateStorageBase respeta el limite de 24 con 6 de sufijo', () => {
  assert.equal(truncateStorageBase('stmcptfstatedev', 24, 6), 'stmcptfstatedev')

  const truncated = truncateStorageBase('abcdefghij0123456789abcd', 24, 6)
  assert.equal(truncated, 'abcdefghij01234567')
  assert.ok(truncated.length + 6 <= 24)

  assert.equal(truncateStorageBase('abcdefghijklmnopqr', 24, 6), 'abcdefghijklmnopqr')
  assert.equal(truncateStorageBase('abcdefghijklmnopqrs', 24, 6), 'abcdefghijklmnopqr')
  assert.equal(truncateStorageBase('abcdefghij0123456789abcd').length, 18)
})

test('[1] truncateStorageBase da base vacia si el sufijo no deja espacio', () => {
  assert.equal(truncateStorageBase('abcdefgh', 24, 30), '')
  assert.equal(truncateStorageBase('abcdefgh', 24, 24), '')
})

test('[2] genStorageSuffix genera un sufijo [a-z0-9] del largo pedido', () => {
  const suffix = genStorageSuffix(6)
  assert.match(suffix, /^[a-z0-9]{6}$/)
  assert.match(genStorageSuffix(), /^[a-z0-9]{6}$/)
  assert.equal(genStorageSuffix(4).length, 4)
  assert.equal(genStorageSuffix(0), '')
  assert.notEqual(genStorageSuffix(6), genStorageSuffix(6))
  assert.match(`abcdefghijklmnopqr${suffix}`, STORAGE_NAME)
})

test('[2] genStorageSuffix usa hexadecimal hasta 64 caracteres y el alfabeto completo despues', () => {
  assert.match(genStorageSuffix(64), /^[0-9a-f]{64}$/)
  const long = genStorageSuffix(400)
  assert.match(long, /^[a-z0-9]{400}$/)
  assert.match(long, /[g-z]/)
})

test('[3] readBackendStorageAccountName reusa el nombre escrito en backend.tf', () => {
  const dir = terraformDir('conbackend', {
    'backend.tf': `terraform {
  backend "azurerm" {
    resource_group_name  = "rg-foo-tfstate"
    storage_account_name = "stmcptfstatedevab12cd"
    container_name       = "tfstate"
    key                  = "dev.tfstate"
  }
}
`,
  })
  assert.equal(readBackendStorageAccountName(dir), 'stmcptfstatedevab12cd')
})

test('[3] readBackendStorageAccountName da vacio sin backend literal', () => {
  assert.equal(readBackendStorageAccountName(terraformDir('vacio')), '')
  assert.equal(readBackendStorageAccountName(join(tmp, 'no-existe')), '')
  assert.equal(
    readBackendStorageAccountName(
      terraformDir('sinbackend', { 'main.tf': 'resource "azurerm_storage_account" "x" { name = "stno" }\n' }),
    ),
    '',
  )
  assert.equal(readBackendStorageAccountName(terraformDir('novar', { 'backend.tf': BACKEND_CON_VARIABLES })), '')
})

test('[3] readBackendStorageAccountName encuentra el backend en cualquier .tf', () => {
  const dir = terraformDir('otrotf', {
    'main.tf': 'resource "azurerm_storage_account" "x" {\n  storage_account_name = "stnoeselbackend"\n}\n',
    'providers.tf': 'terraform {\n  backend "azurerm" {\n    storage_account_name = "stotrotfstatedevxyz789"\n  }\n}\n',
  })
  assert.equal(readBackendStorageAccountName(dir), 'stotrotfstatedevxyz789')
})

test('[4] readBackendResourceGroupName reusa el RG escrito en backend.tf', () => {
  assert.equal(
    readBackendResourceGroupName(terraformDir('rg-conbackend', { 'backend.tf': BACKEND_COMPLETO })),
    'rg-cosmos-cplane-tfstate',
  )
  assert.equal(readBackendResourceGroupName(terraformDir('rg-vacio')), '')
  assert.equal(readBackendResourceGroupName(join(tmp, 'rg-no-existe')), '')
  assert.equal(readBackendResourceGroupName(terraformDir('rg-novar', { 'backend.tf': BACKEND_CON_VARIABLES })), '')
})

test('los lectores de backend aceptan finales de linea de Windows', () => {
  const dir = terraformDir('crlf', { 'backend.tf': BACKEND_COMPLETO.replaceAll('\n', '\r\n') })
  assert.equal(readBackendStorageAccountName(dir), 'stcplanetfstatedev18ecba')
  assert.equal(readBackendResourceGroupName(dir), 'rg-cosmos-cplane-tfstate')
})

test('[5] composeTfstateResourceGroupName: forma CAF con region, legacy sin ella', () => {
  assert.equal(
    composeTfstateResourceGroupName('rg-cosmos-cplane', 'dev', 'eus2', '001'),
    'rg-tfstate-cosmos-cplane-dev-eus2-001',
  )
  assert.equal(composeTfstateResourceGroupName('rg-cosmos-cplane', 'dev', '', '001'), 'rg-cosmos-cplane-tfstate')
})

test('[6] composeTfstateStorageAccountBase: forma CAF con region, legacy sin ella', () => {
  assert.equal(
    composeTfstateStorageAccountBase('rg-cosmos-cplane', 'dev', '', '001', 'stmcptfstatedev', 24),
    'stmcptfstatedev',
  )

  const short = composeTfstateStorageAccountBase('rg-mcp', 'dev', 'eus2', '001', 'irrelevante', 24)
  assert.equal(short, 'sttfstatemcpdeveus2001')
  assert.ok(short.length <= 24)

  const truncated = composeTfstateStorageAccountBase('rg-cosmos-cplane', 'dev', 'eus2', '001', 'irrelevante', 24)
  assert.equal(truncated, 'sttfstatecosmodeveus2001')
  assert.equal(truncated.length, 24)
  assert.equal(composeTfstateStorageAccountBase('rg-cosmos-cplane', 'dev', 'eus2', '001', 'irrelevante'), truncated)

  assert.match(composeTfstateStorageAccountBase('rg-mi_proyecto-x', 'dev', 'eus2', '001', 'irrelevante', 24), /^[a-z0-9]+$/)
})

test('[7] tfstateStorageAppSlug normaliza {app} al charset de Storage', () => {
  assert.equal(tfstateStorageAppSlug('rg-cosmos-cplane'), 'cosmoscplane')
  assert.equal(tfstateStorageAppSlug('rg-mi_proyecto-x'), 'miproyectox')
  assert.equal(tfstateStorageAppSlug('proyecto-rg-x'), 'proyectorgx')
  assert.ok(
    composeTfstateStorageAccountBase('rg-mcp', 'dev', 'eus2', '001', 'irrelevante', 24).includes(
      tfstateStorageAppSlug('rg-mcp'),
    ),
  )
})

test('[8] si los componentes fijos desbordan el limite se sacrifica {app} y el nombre queda invalido', () => {
  const name = composeTfstateStorageAccountBase('rg-cplane', 'production', 'westeurope', '001', 'irrelevante', 24)
  assert.equal(name, 'sttfstateproductionwesteurope001')
  assert.doesNotMatch(name, STORAGE_NAME)
  assert.equal(name.includes('cplane'), false)
})

const NO_BASH = process.platform === 'win32' || !commandExists('bash')

test('azurermBackendLines cuenta las declaraciones de backend azurerm de cada .tf', () => {
  const dir = terraformDir('lineas', {
    'backend.tf': BACKEND_CON_VARIABLES,
    'main.tf': 'terraform {\n  backend\t"azurerm" {}\n}\n# backend "azurerm" comentado\n',
    'versions.tf': 'terraform { required_version = ">= 1.9" }\n',
    '.oculto.tf': BACKEND_CON_VARIABLES,
    'notas.txt': 'backend "azurerm"\n',
  })
  mkdirSync(join(dir, 'modulo.tf'))
  assert.deepEqual(azurermBackendLines(dir), [
    { file: 'backend.tf', count: 1 },
    { file: 'main.tf', count: 2 },
    { file: 'versions.tf', count: 0 },
  ])
  assert.deepEqual(azurermBackendLines(join(tmp, 'no-existe')), [])
})

describe('paridad con la gemela bash', { skip: NO_BASH ? 'requiere bash' : false }, () => {
  function bash(...args: string[]): string {
    const result = capture('bash', ['-c', 'set +u; source "$1" 2>/dev/null; shift; "$@"', 'bash', BASH_LIBRARY, ...args])
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }

  test('truncate_storage_base', () => {
    const cases: [string, number, number][] = [
      ['stmcptfstatedev', 24, 6],
      ['abcdefghij0123456789abcd', 24, 6],
      ['abcdefghijklmnopqr', 24, 6],
      ['abcdefghijklmnopqrs', 24, 6],
      ['abcdefgh', 24, 30],
      ['abcdefgh', 24, 24],
      ['abcdefgh', 8, 0],
      ['', 24, 6],
    ]
    for (const [base, maxTotal, suffixLen] of cases) {
      assert.equal(
        truncateStorageBase(base, maxTotal, suffixLen),
        bash('truncate_storage_base', base, String(maxTotal), String(suffixLen)),
      )
    }
    assert.equal(truncateStorageBase('abcdefghij0123456789abcd'), bash('truncate_storage_base', 'abcdefghij0123456789abcd'))
  })

  test('gen_storage_suffix: mismo largo y mismo alfabeto', () => {
    const alphabet = (samples: string[]): string => [...new Set(samples.join(''))].sort().join('')
    for (const length of [0, 4, 6, 64, 65]) {
      const fromBash = Array.from({ length: 12 }, () => bash('gen_storage_suffix', String(length)))
      const fromTypescript = Array.from({ length: 12 }, () => genStorageSuffix(length))
      assert.deepEqual(
        fromTypescript.map((suffix) => suffix.length),
        fromBash.map((suffix) => suffix.length),
      )
      // Sin openssl la gemela usa el alfabeto completo para cualquier largo.
      if (commandExists('openssl')) {
        const hex = /^[0-9a-f]*$/
        assert.equal(hex.test(alphabet(fromTypescript)), hex.test(alphabet(fromBash)), `largo ${length}`)
      }
      assert.match(alphabet(fromTypescript), /^[a-z0-9]*$/)
      assert.match(alphabet(fromBash), /^[a-z0-9]*$/)
    }
    assert.equal(genStorageSuffix().length, bash('gen_storage_suffix').length)
  })

  test('read_backend_storage_account_name y read_backend_resource_group_name', () => {
    const dirs = [
      terraformDir('p-completo', { 'backend.tf': BACKEND_COMPLETO }),
      terraformDir('p-crlf', { 'backend.tf': BACKEND_COMPLETO.replaceAll('\n', '\r\n') }),
      terraformDir('p-variables', { 'backend.tf': BACKEND_CON_VARIABLES }),
      terraformDir('p-vacio'),
      join(tmp, 'p-no-existe'),
      terraformDir('p-sin-backend', { 'main.tf': 'storage_account_name = "stsinbackend"\nresource_group_name = "rg-x"\n' }),
      terraformDir('p-otro-tf', {
        'a.tf': 'backend "azurerm" {\n  storage_account_name = "NO-VALIDO"\n  resource_group_name = "rg con espacios"\n}\n',
        'b.tf': 'backend   "azurerm" {\n\tstorage_account_name="stsegundoarchivo"\n\tresource_group_name="rg-segundo"\n}\n',
        'c.tf': 'backend "azurerm" {\n  storage_account_name = "sttercero"\n  resource_group_name = "rg-tercero"\n}\n',
      }),
      terraformDir('p-raros', {
        '.oculto.tf': 'backend "azurerm" {\n  storage_account_name = "stoculto"\n  resource_group_name = "rg-oculto"\n}\n',
        'main.tf.bak': 'backend "azurerm" {\n  storage_account_name = "strespaldo"\n  resource_group_name = "rg-respaldo"\n}\n',
        'z.tf': [
          '# backend "azurerm" comentado tambien cuenta',
          '  storage_account_name = "stprimero" # otro = "stcomentario"',
          '  storage_account_name = "stsegundo"',
          '  resource_group_name = "rg.con_(parentesis)-ok" ',
          '',
        ].join('\n'),
      }),
      terraformDir('p-sin-comillas', {
        'backend.tf': 'backend "azurerm" {\n  storage_account_name = stsincomillas\n  resource_group_name = \'rg-simple\'\n}\n',
      }),
    ]
    mkdirSync(join(terraformDir('p-directorio'), 'backend.tf'))
    dirs.push(join(tmp, 'p-directorio'))

    for (const dir of dirs) {
      assert.equal(readBackendStorageAccountName(dir), bash('read_backend_storage_account_name', dir), dir)
      assert.equal(readBackendResourceGroupName(dir), bash('read_backend_resource_group_name', dir), dir)
    }
  })

  test('compose_tfstate_resource_group_name, tfstate_storage_app_slug y compose_tfstate_storage_account_base', () => {
    const prefixes = ['rg-cosmos-cplane', 'rg-mcp', 'rg-mi_proyecto-x', 'sinprefijo', 'rg-', 'rg-rg-doble', 'proyecto-rg-x', '']
    const environments: [string, string, string][] = [
      ['dev', 'eus2', '001'],
      ['dev', '', '001'],
      ['production', 'westeurope', '001'],
      ['qa', 'eus', ''],
    ]
    for (const prefix of prefixes) {
      assert.equal(tfstateStorageAppSlug(prefix), bash('tfstate_storage_app_slug', prefix))
      for (const [env, region, seq] of environments) {
        assert.equal(
          composeTfstateResourceGroupName(prefix, env, region, seq),
          bash('compose_tfstate_resource_group_name', prefix, env, region, seq),
        )
        assert.equal(
          composeTfstateStorageAccountBase(prefix, env, region, seq, 'stlegacy'),
          bash('compose_tfstate_storage_account_base', prefix, env, region, seq, 'stlegacy'),
        )
        assert.equal(
          composeTfstateStorageAccountBase(prefix, env, region, seq, 'stlegacy', 18),
          bash('compose_tfstate_storage_account_base', prefix, env, region, seq, 'stlegacy', '18'),
        )
      }
    }
  })
})
