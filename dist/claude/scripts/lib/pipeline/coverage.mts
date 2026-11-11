// Clasificacion de un archivo `.cs` del PR para el coverage gate (MEF-ADR-0014).
//
// Gemela de `coverage_classify_file` de `_pipeline-common.sh`: mientras tenga llamadores en bash,
// un cambio va en los dos lados.

import { readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/** `logic` exige 95% de cobertura de lineas, `excluded` no se mide y `not_evaluated` queda para revision humana. */
export type CoverageClass = 'logic' | 'excluded' | 'not_evaluated'

// `[[:space:]]` de POSIX y la `\w` de grep en un locale UTF-8; las de JavaScript difieren.
const SPACE = '[ \\t\\n\\v\\f\\r]'
const WORD = '[\\p{L}\\p{N}_]'

// Sin logica de negocio: arranque, textos, marcadores y listas declarativas de tipos persistidos.
const BOILERPLATE = /^(HealthCheck\.cs|Program\.cs|.*Mensajes\.cs|.*AssemblyMarker\.cs|ConfiguracionSerializacion.*\.cs|IdentidadEventos.*\.cs|.*\.resx)$/s
const WIRING = /^(RequestValidator|ServiceBusDeserializador)\.cs$/
const INFRA_SEGMENT = /(^|\/)Infraestructura(\/|$)/m
const QUERY_FOLDER = /^(Obtener|Listar)[A-Za-z0-9]*$/m
const LOGIC = /^(.*(CommandHandler|AggregateRoot|Validator|Projection|EventHandler|Tool)|FunctionEndpoint)\.cs$/s
const EVENT_FOLDER = /\/Eventos\/|\/Entities\/|\.DomainEvents$|\.DomainEvents\//m
const FACTORY = /static[^\n]*Crear\(/
const SKIPPED_LINE = new RegExp(`^(${SPACE}*//|${SPACE}*$|using |namespace )`)
const RECORD_DECL = new RegExp(
  `public${SPACE}+(sealed${SPACE}+|partial${SPACE}+)*record${SPACE}+${WORD}+\\([^()]*\\)[^;{]*[;{]`,
  'gu',
)
const TYPE_DECL = new RegExp(`(class|record|struct|interface|enum)${SPACE}+${WORD}+`, 'gu')

/** Contenido del archivo, o `null` si no es un archivo legible. */
function readSource(file: string): string | null {
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

/** `true` si todos los tipos que declara `source` son records sin cuerpo (`public sealed record X(...);`). */
function onlyPureRecords(source: string): boolean {
  const lines = source.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const flat = `${lines.filter((line) => !SKIPPED_LINE.test(line)).join(' ')} `
  const records = flat.match(RECORD_DECL) ?? []
  // Un record puro junto a una clase con metodos no cuenta: nadie mediria esa clase.
  return records.length > 0 && records.filter((record) => record.endsWith(';')).length === (flat.match(TYPE_DECL) ?? []).length
}

/**
 * Clase de `filepath` (relativa al worktree, con `/`) para el coverage gate. Lee el archivo de
 * `worktree` en las reglas que dependen del contenido: factory `Crear()` y records DTO.
 * `isProjection` habilita el carve-out del `FunctionEndpoint.cs` de una query GET.
 */
export function coverageClassifyFile(filepath: string, worktree: string, isProjection = false): CoverageClass {
  const basename = posix.basename(filepath)
  const dirname = posix.dirname(filepath)

  if (BOILERPLATE.test(basename)) return 'excluded'
  if (dirname.includes('/Infraestructura/') && WIRING.test(basename)) return 'excluded'
  // El cliente HTTP tipado de un servidor MCP vive directo en Infraestructura/, sin subcarpeta.
  if (INFRA_SEGMENT.test(dirname) && basename.endsWith('Api.cs')) return 'excluded'

  // Una query GET delgada se cubre por composicion y smoke tests; con sufijo Function es un comando.
  const queryFolder = posix.basename(dirname)
  if (
    isProjection &&
    basename === 'FunctionEndpoint.cs' &&
    !queryFolder.endsWith('Function') &&
    QUERY_FOLDER.test(queryFolder)
  ) {
    return 'excluded'
  }

  if (LOGIC.test(basename)) return 'logic'

  const source = readSource(join(worktree, filepath))
  if (source === null) return 'not_evaluated'
  const inFactoryFolder = EVENT_FOLDER.test(dirname) || dirname.includes('/ValueObjects/')
  if (inFactoryFolder && source.split('\n').some((line) => FACTORY.test(line))) return 'logic'
  return onlyPureRecords(source) ? 'excluded' : 'not_evaluated'
}
