// Nombres del backend de Terraform: lo ya escrito en `backend.tf` y la composicion del Resource
// Group y la Storage Account del tfstate (MEF-ADR-0045). Nada aqui consulta Azure.
//
// Gemela de `truncate_storage_base`, `gen_storage_suffix`, `read_backend_storage_account_name`,
// `read_backend_resource_group_name`, `compose_tfstate_resource_group_name`,
// `tfstate_storage_app_slug` y `compose_tfstate_storage_account_base` de `_pipeline-common.sh`:
// mientras tengan llamadores en bash, un cambio va en los dos lados.

import { randomBytes, randomInt } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** `base` recortada para que con un sufijo de `suffixLen` quepa en `maxTotal`; vacia si no hay espacio. */
export function truncateStorageBase(base: string, maxTotal = 24, suffixLen = 6): string {
  return base.slice(0, Math.max(maxTotal - suffixLen, 0))
}

/** Sufijo aleatorio para una Storage Account: hexadecimal hasta 64 caracteres, `[a-z0-9]` si se piden mas. */
export function genStorageSuffix(length = 6): string {
  const hex = randomBytes(32).toString('hex').slice(0, length)
  if (hex.length >= length) return hex
  let suffix = ''
  for (let i = 0; i < length; i++) suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)]
  return suffix
}

// `[[:space:]]` de POSIX; `\s` de JavaScript admite ademas espacios Unicode.
const SPACE = '[ \\t\\n\\v\\f\\r]'
const AZURERM_BACKEND = new RegExp(`backend${SPACE}*"azurerm"`)
const QUOTED_VALUE = new RegExp(`.*=${SPACE}*"([^"]+)".*`, 's')

/** Los `.tf` de `dir` que el glob `*.tf` de bash recorreria, en orden; vacio si `dir` no se puede leer. */
function terraformFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.tf') && !entry.startsWith('.'))
      .sort()
  } catch {
    return []
  }
}

/** Por cada `.tf` legible de `dir`, cuantas lineas declaran un backend azurerm. */
export function azurermBackendLines(dir: string): { file: string; count: number }[] {
  return terraformFiles(dir).flatMap((file) => {
    try {
      const lines = readFileSync(join(dir, file), 'utf8').split('\n')
      return [{ file, count: lines.filter((line) => AZURERM_BACKEND.test(line)).length }]
    } catch {
      return []
    }
  })
}

/** Valor literal de `key` en el primer `.tf` de `dir` con backend azurerm donde cumple `valid`. */
function readBackendValue(dir: string, key: string, valid: RegExp): string {
  const declaration = new RegExp(`^${SPACE}*${key}${SPACE}*=`)
  for (const name of terraformFiles(dir)) {
    let lines: string[]
    try {
      lines = readFileSync(join(dir, name), 'utf8').split('\n')
    } catch {
      continue
    }
    if (!lines.some((line) => AZURERM_BACKEND.test(line))) continue
    const value = (lines.find((line) => declaration.test(line)) ?? '').replace(QUOTED_VALUE, '$1')
    if (valid.test(value)) return value
  }
  return ''
}

/** `storage_account_name` del backend azurerm de `dir`, o vacio si no hay uno literal y valido. */
export function readBackendStorageAccountName(dir: string): string {
  return readBackendValue(dir, 'storage_account_name', /^[a-z0-9]{3,24}$/)
}

/** `resource_group_name` del backend azurerm de `dir`, o vacio si no hay uno literal. */
export function readBackendResourceGroupName(dir: string): string {
  return readBackendValue(dir, 'resource_group_name', /^[a-zA-Z0-9._()-]{1,90}$/)
}

function withoutRgPrefix(rgPrefix: string): string {
  return rgPrefix.startsWith('rg-') ? rgPrefix.slice(3) : rgPrefix
}

/** Sin `regionShort` da el nombre legacy `<rgPrefix>-tfstate`; con el, la forma CAF. */
export function composeTfstateResourceGroupName(
  rgPrefix: string,
  env: string,
  regionShort: string,
  seq: string,
): string {
  if (regionShort.length === 0) return `${rgPrefix}-tfstate`
  return `rg-tfstate-${withoutRgPrefix(rgPrefix)}-${env}-${regionShort}-${seq}`
}

/** Componente `{app}` del nombre de la Storage Account: `rgPrefix` sin `rg-`, guiones ni guiones bajos. */
export function tfstateStorageAppSlug(rgPrefix: string): string {
  return withoutRgPrefix(rgPrefix).replace(/[-_]/g, '')
}

/**
 * Sin `regionShort` devuelve `legacyBase`, que aun espera su sufijo aleatorio; con el, el nombre
 * CAF definitivo, recortando solo `{app}` para caber en `maxTotal`.
 */
export function composeTfstateStorageAccountBase(
  rgPrefix: string,
  env: string,
  regionShort: string,
  seq: string,
  legacyBase: string,
  maxTotal = 24,
): string {
  if (regionShort.length === 0) return legacyBase
  const fixedPrefix = 'sttfstate'
  const fixedSuffix = `${env}${regionShort}${seq}`
  const fixedLength = fixedPrefix.length + fixedSuffix.length
  const app = truncateStorageBase(tfstateStorageAppSlug(rgPrefix), maxTotal, fixedLength)
  return `${fixedPrefix}${app}${fixedSuffix}`
}
