import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

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
  assert.equal(truncateStorageBase('abcdefgh', 8, 0), 'abcdefgh')
  assert.equal(truncateStorageBase('', 24, 6), '')
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

test('los lectores de backend toman el primer valor valido de los .tf visibles, solo entre comillas dobles', () => {
  const otherTf = terraformDir('otro-tf', {
    'a.tf': 'backend "azurerm" {\n  storage_account_name = "NO-VALIDO"\n  resource_group_name = "rg con espacios"\n}\n',
    'b.tf': 'backend   "azurerm" {\n\tstorage_account_name="stsegundoarchivo"\n\tresource_group_name="rg-segundo"\n}\n',
    'c.tf': 'backend "azurerm" {\n  storage_account_name = "sttercero"\n  resource_group_name = "rg-tercero"\n}\n',
  })
  assert.equal(readBackendStorageAccountName(otherTf), 'stsegundoarchivo')
  assert.equal(readBackendResourceGroupName(otherTf), 'rg-segundo')

  const unusual = terraformDir('raros', {
    '.oculto.tf': 'backend "azurerm" {\n  storage_account_name = "stoculto"\n  resource_group_name = "rg-oculto"\n}\n',
    'main.tf.bak': 'backend "azurerm" {\n  storage_account_name = "strespaldo"\n  resource_group_name = "rg-respaldo"\n}\n',
    'z.tf': [
      '# backend "azurerm" comentado tambien cuenta',
      '  storage_account_name = "stprimero" # otro = "stcomentario"',
      '  storage_account_name = "stsegundo"',
      '  resource_group_name = "rg.con_(parentesis)-ok" ',
      '',
    ].join('\n'),
  })
  // Toma el ultimo literal de la primera linea, aunque este en un comentario.
  assert.equal(readBackendStorageAccountName(unusual), 'stcomentario')
  assert.equal(readBackendResourceGroupName(unusual), 'rg.con_(parentesis)-ok')

  const unquoted = terraformDir('sin-comillas', {
    'backend.tf': 'backend "azurerm" {\n  storage_account_name = stsincomillas\n  resource_group_name = \'rg-simple\'\n}\n',
  })
  const withoutBackend = terraformDir('sin-backend', { 'main.tf': 'storage_account_name = "stsinbackend"\nresource_group_name = "rg-x"\n' })
  mkdirSync(join(terraformDir('directorio'), 'backend.tf'))
  for (const dir of [unquoted, withoutBackend, join(tmp, 'directorio')]) {
    assert.equal(readBackendStorageAccountName(dir), '', dir)
    assert.equal(readBackendResourceGroupName(dir), '', dir)
  }
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

test('prefijos sin {app}, con rg- repetido o sin rg-, y entornos sin secuencia', () => {
  const cases: [prefix: string, slug: string, rg: string, base: string, base18: string][] = [
    ['rg-', '', 'rg-tfstate--dev-eus2-001', 'sttfstatedeveus2001', 'sttfstatedeveus2001'],
    ['', '', 'rg-tfstate--dev-eus2-001', 'sttfstatedeveus2001', 'sttfstatedeveus2001'],
    ['rg-rg-doble', 'rgdoble', 'rg-tfstate-rg-doble-dev-eus2-001', 'sttfstatergdobdeveus2001', 'sttfstatedeveus2001'],
    ['sinprefijo', 'sinprefijo', 'rg-tfstate-sinprefijo-dev-eus2-001', 'sttfstatesinprdeveus2001', 'sttfstatedeveus2001'],
  ]
  for (const [prefix, slug, rg, base, base18] of cases) {
    assert.equal(tfstateStorageAppSlug(prefix), slug, prefix)
    assert.equal(composeTfstateResourceGroupName(prefix, 'dev', 'eus2', '001'), rg, prefix)
    assert.equal(composeTfstateStorageAccountBase(prefix, 'dev', 'eus2', '001', 'stlegacy'), base, prefix)
    assert.equal(composeTfstateStorageAccountBase(prefix, 'dev', 'eus2', '001', 'stlegacy', 18), base18, prefix)
  }
  assert.equal(composeTfstateResourceGroupName('rg-mcp', 'qa', 'eus', ''), 'rg-tfstate-mcp-qa-eus-')
  assert.equal(composeTfstateStorageAccountBase('rg-mcp', 'qa', 'eus', '', 'stlegacy'), 'sttfstatemcpqaeus')
  assert.equal(composeTfstateStorageAccountBase('rg-mcp', 'dev', '', '001', 'stlegacy', 18), 'stlegacy')
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
