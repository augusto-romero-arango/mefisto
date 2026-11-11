// Cuerpo markdown del issue de la nightly: enlace al run, SHA evaluado, conteo PASS/FAIL
// total y por carril, y rutas con FAIL.
//
// Uso: node src/internal/scripts/mefisto-nightly-report.mts <log-dir> <run-url> <sha>
//
// Lee los results.tsv que deja `mefisto-test-suite.sh --log-dir`, uno por carril
// (<log-dir>/<carril>/results.tsv; columnas orden, ruta, estado, ...). Las entradas CANCELLED
// no cuentan como PASS ni FAIL. Sale 0 tambien cuando no hay ningun results.tsv. No invoca
// gh: publica el workflow.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

import { CliError, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'

export interface LaneResults {
  pass: number
  fail: number
  cancelled: number
  failedPaths: string[]
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Todos los `results.tsv` bajo `logDir`, ordenados por ruta. */
export function findResultFiles(logDir: string): string[] {
  if (!isDirectory(logDir)) return []
  const found: string[] = []
  const visit = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name === 'results.tsv') found.push(path)
    }
  }
  visit(logDir)
  // Orden de bytes sobre la ruta con '/', igual en todas las plataformas.
  const key = (path: string): Buffer => Buffer.from(path.split(sep).join('/'))
  return found.sort((a, b) => Buffer.compare(key(a), key(b)))
}

export function parseResults(text: string): LaneResults {
  const results: LaneResults = { pass: 0, fail: 0, cancelled: 0, failedPaths: [] }
  // Como `read` de bash con IFS de tabulador: una linea sin salto final no cuenta, y los
  // tabuladores seguidos o iniciales no dejan campos vacios.
  const lines = text.split('\n').slice(0, -1)
  for (const line of lines) {
    const fields = line.replace(/^\t+/, '').split(/\t+/)
    const [order = '', path = '', state = ''] = fields
    if (order.length === 0) continue
    if (state === 'PASS') results.pass++
    else if (state === 'CANCELLED') results.cancelled++
    else if (state === 'FAIL') {
      results.fail++
      results.failedPaths.push(path)
    }
  }
  return results
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function buildReport(logDir: string, runUrl: string, sha: string): string {
  const lines = ['## Nightly roja', '', `- Run: ${runUrl}`, `- SHA evaluado: \`${sha}\``, '']
  const files = findResultFiles(logDir)
  if (files.length === 0) {
    lines.push(
      'La suite no produjo resultados (timeout o fallo del runner): no se encontro ningun `results.tsv` en el artefacto `test-suite-logs`.',
      'Revisa el log del run para ver en que paso fallo.',
    )
    return `${lines.join('\n')}\n`
  }

  const total = { pass: 0, fail: 0, cancelled: 0 }
  const laneRows: string[] = []
  const failRows: string[] = []
  for (const file of files) {
    const lane = basename(dirname(file))
    const results = parseResults(readText(file))
    total.pass += results.pass
    total.fail += results.fail
    total.cancelled += results.cancelled
    laneRows.push(`| ${lane} | ${results.pass} | ${results.fail} |`)
    for (const path of results.failedPaths) failRows.push(`- \`${path}\` (carril \`${lane}\`)`)
  }

  lines.push('### Conteo', '', `Total: PASS=${total.pass} FAIL=${total.fail}`)
  if (total.cancelled > 0) {
    lines.push(
      '',
      `CANCELLED=${total.cancelled}: entradas interrumpidas o que no llegaron a correr (timeout o cancelacion del job).`,
    )
  }
  lines.push('', '| Carril | PASS | FAIL |', '|---|---|---|', ...laneRows, '', '### Rutas con FAIL', '')
  if (failRows.length > 0) lines.push(...failRows)
  else lines.push('(ninguna: todos los tests registrados pasaron; el rojo viene de otro paso del job)')
  return `${lines.join('\n')}\n`
}

function main(argv: string[]): number {
  const [logDir, runUrl, sha] = argv
  if (argv.length !== 3 || logDir === undefined || runUrl === undefined || sha === undefined) {
    throw new CliError(`Uso: ${process.argv[1] ?? 'mefisto-nightly-report.mts'} <log-dir> <run-url> <sha>`, 2)
  }
  process.stdout.write(buildReport(logDir, runUrl, sha))
  return 0
}

if (isEntryPoint(import.meta.url)) runMain(() => main(process.argv.slice(2)))
