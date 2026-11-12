// Pipeline hijo falso de los orquestadores. Su rol es el nombre con que se copio (`tooling-pipeline`,
// `tdd-pipeline` o `pr-sync`); anota cada invocacion y sigue el guion de `ORQUESTADOR_GUION` para
// su primer argumento (issue o PR).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

interface Paso {
  /** Codigo de salida; por defecto 0. */
  exit?: number
  /** Salida; por defecto la linea del PR creado (`issue + 1000`), o nada en pr-sync. */
  output?: string
  /** Escribe la senal de parada suave en la raiz del consumidor. */
  signal?: boolean
  /** Lineas que agrega al events.log canonico y al legacy. */
  events?: string[]
  legacyEvents?: string[]
  /** Contenido del status por issue (`--status-file`). */
  status?: unknown
  /** Milisegundos que tarda antes de salir. */
  sleepMs?: number
}

interface Guion {
  calls: string
  pipeline?: Record<string, Paso>
  prSync?: Record<string, Paso>
}

const role = basename(process.argv[1] ?? '').replace(/\.mts$/, '')
const args = process.argv.slice(2)
const guion = JSON.parse(readFileSync(process.env.ORQUESTADOR_GUION ?? '', 'utf8')) as Guion
appendFileSync(guion.calls, `${role} ${args.join(' ')}\n`)

const key = args[0] ?? ''
const paso: Paso = (role === 'pr-sync' ? guion.prSync : guion.pipeline)?.[key] ?? {}
const appendLines = (file: string, lines: string[]): void => {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, lines.map((line) => `${line}\n`).join(''))
}
if (paso.events !== undefined) appendLines(join(process.env.MEFISTO_STATE_DIR ?? '', 'events.log'), paso.events)
if (paso.legacyEvents !== undefined) appendLines(join(process.env.MEFISTO_LEGACY_STATE_DIR ?? '', 'events.log'), paso.legacyEvents)
const statusIndex = args.indexOf('--status-file')
if (paso.status !== undefined && statusIndex !== -1) {
  writeFileSync(join(process.env.MEFISTO_STATE_DIR ?? '', args[statusIndex + 1] ?? ''), JSON.stringify(paso.status))
}
if (paso.signal === true) {
  mkdirSync('pipeline-state', { recursive: true })
  writeFileSync(join('pipeline-state', 'batch-stop'), '')
}
if (paso.sleepMs !== undefined) await new Promise((done) => setTimeout(done, paso.sleepMs))
const pr = Number(key) + 1000
process.stdout.write(paso.output ?? (role === 'pr-sync' ? '' : `PR creado: https://github.com/acme/consumidor/pull/${pr}\n`))
process.exitCode = paso.exit ?? 0
