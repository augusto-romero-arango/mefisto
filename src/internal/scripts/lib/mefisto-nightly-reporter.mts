// Reporter de `node --test` para la nightly: escribe una linea por archivo de test
// (orden, ruta relativa al directorio de trabajo, PASS/FAIL/CANCELLED), el results.tsv que lee
// mefisto-nightly-report.mts.
//
// Uso: node --test --test-reporter=spec --test-reporter-destination=stdout \
//        --test-reporter=./src/internal/scripts/lib/mefisto-nightly-reporter.mts \
//        --test-reporter-destination=<dir>/results.tsv <globs>
//
// Escribe al terminar la corrida: si el job se corta por timeout no queda archivo, y el reporte
// lo dice.

import { relative, sep } from 'node:path'
import type { TestEvent } from 'node:test/reporters'

export type FileState = 'PASS' | 'FAIL' | 'CANCELLED'

const RANK: Record<FileState, number> = { PASS: 0, CANCELLED: 1, FAIL: 2 }

/** Archivo y estado que aporta un evento; `null` si no cuenta. */
export function eventState(event: TestEvent): { file: string; state: FileState } | null {
  if (event.type !== 'test:pass' && event.type !== 'test:fail') return null
  const { file, nesting } = event.data
  // Los de primer nivel ya resumen a sus subtests; un archivo que no carga llega como uno mas.
  if (nesting !== 0 || file === undefined) return null
  if (event.type === 'test:pass') return { file, state: 'PASS' }
  // Un `todo` que falla no falla la corrida.
  if (event.data.todo !== undefined && event.data.todo !== false) return null
  const failureType = (event.data.details.error as { failureType?: unknown }).failureType
  return { file, state: failureType === 'cancelledByParent' ? 'CANCELLED' : 'FAIL' }
}

/** Acumula en `states` el estado de cada archivo: FAIL pesa mas que CANCELLED y este que PASS. */
export function record(states: Map<string, FileState>, event: TestEvent): void {
  const result = eventState(event)
  if (result === null) return
  const previous = states.get(result.file)
  if (previous === undefined || RANK[result.state] > RANK[previous]) states.set(result.file, result.state)
}

/** Lineas `orden<TAB>ruta<TAB>estado`, ordenadas por ruta con '/' como separador. */
export function resultsTsv(states: Map<string, FileState>, cwd: string): string {
  const rows = [...states].map(([file, state]) => [relative(cwd, file).split(sep).join('/'), state] as const)
  rows.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return rows.map(([path, state], index) => `${index + 1}\t${path}\t${state}\n`).join('')
}

export default async function* nightlyReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const states = new Map<string, FileState>()
  for await (const event of source) record(states, event)
  yield resultsTsv(states, process.cwd())
}
