// Orden de lanzamiento de los issues 'estado:listo' abiertos del repo consumidor, o de
// refinamiento de sus 'estado:borrador'. Solo lectura. El algoritmo esta en `lib/next-order.mts`.
//
// Uso: node scripts/next-order.mts [--refinement] [--json] [--launch-command "<texto>"]
//                                  [--parallel-command "<texto>"]
//
//   --refinement        Ordena los borradores; la ultima linea es 'Siguiente a refinar: #N'.
//   --json              Un objeto JSON en stdout: mode, items[] (position, number, title, tipo,
//                       after[], hasDepsSection), blocked[] (number, by, reason y pr si reason es
//                       'pr'), inPr[] (number, title, tipo, pr), cycles[][], launch, infra[] y
//                       parallel ({ issues, launch }, null en --refinement).
//   --launch-command    Comando de la linea de lanzamiento; por defecto '/mefisto:sequential'.
//   --parallel-command  Comando del lote paralelo; por defecto '/mefisto:parallel'.
//
// Los comandos llegan por flag porque su namespace lo decide el adaptador de cada runtime
// (MEF-ADR-0050), no este script.
//
// La linea de lanzamiento excluye los 'tipo:infra' y los issues sin tipo, que los motores de batch
// saltan; `items` los conserva. El lote paralelo son los lanzables sin dependencias abiertas en el
// universo, tampoco infra ni sin tipo, con a lo sumo un 'tipo:projection' (MEF-ADR-0034); su linea
// solo sale con dos o mas issues.
//
// Exit: 0 con al menos un issue en el orden, 1 si quedo vacio o si el repo no es un consumidor,
// 2 si falla 'gh issue list' o los argumentos son invalidos.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CliError, isEntryPoint, repoRoot, runMain } from './lib/cli.mts'
import {
  blockedJson,
  computeOrder,
  emit,
  ghCli,
  loadUniverse,
  outcomeOf,
  renderJson,
  renderText,
} from './lib/next-order.mts'
import type { Gh, Issue, Mode, Order, Outcome } from './lib/next-order.mts'

const USAGE =
  'Uso: scripts/next-order.sh [--refinement] [--json] [--launch-command "<texto>"] [--parallel-command "<texto>"]'

export interface Options {
  mode: Mode
  json: boolean
  launchCommand: string
  parallelCommand: string
}

function usageError(message: string): CliError {
  return new CliError(`${message}\n${USAGE}`, 2)
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: 'launch',
    json: false,
    launchCommand: '/mefisto:sequential',
    parallelCommand: '/mefisto:parallel',
  }
  const commandValue = (flag: string, value: string | undefined, emptyLine: string): string => {
    if (value === undefined) throw usageError(`ERROR: ${flag} requiere un argumento.`)
    if (value.length === 0) throw usageError(`ERROR: ${flag} no admite texto vacio (${emptyLine} quedaria sin comando).`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--refinement') options.mode = 'refinement'
    else if (arg === '--json') options.json = true
    else if (arg === '--launch-command') options.launchCommand = commandValue(arg, argv[++i], 'la ultima linea')
    else if (arg === '--parallel-command') options.parallelCommand = commandValue(arg, argv[++i], 'la linea del lote')
    else throw usageError(`ERROR: argumento desconocido: ${arg}.`)
  }
  return options
}

function assertInConsumer(cwd: string): void {
  const root = repoRoot(cwd)
  if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
  if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
    throw new CliError(
      [
        'ERROR: scripts/next-order.sh es del plugin publicado y solo aplica al consumidor.',
        'Estas en el repo de Mefisto. Usa src/internal/scripts/mefisto-next-order.sh en su lugar.',
      ].join('\n'),
    )
  }
}

function tipoLabel(issue: Issue): string | undefined {
  return issue.labels.find((label) => label.startsWith('tipo:'))
}

/** El label 'tipo:*' sin prefijo, o `null` si no tiene. */
export function tipoOf(issue: Issue): string | null {
  const tipo = (tipoLabel(issue) ?? '').slice('tipo:'.length)
  return tipo.length > 0 ? tipo : null
}

interface Batches {
  /** Lo que va a la linea de lanzamiento. */
  launch: number[]
  infra: number[]
  parallel: number[]
}

function batchesOf(order: Order): Batches {
  const batches: Batches = { launch: [], infra: [], parallel: [] }
  let hasProjection = false
  for (const item of order.items) {
    const tipo = tipoOf(item.issue)
    if (tipo === null) continue
    if (tipo === 'infra') {
      batches.infra.push(item.issue.number)
      continue
    }
    batches.launch.push(item.issue.number)
    if (item.after.length > 0) continue
    if (tipo === 'projection') {
      if (hasProjection) continue
      hasProjection = true
    }
    batches.parallel.push(item.issue.number)
  }
  return batches
}

function commandLine(command: string, numbers: number[]): string {
  return `${command} ${numbers.join(' ')}`
}

function launchTail(order: Order, options: Options): string[] {
  if (order.items.length === 0) return [`${options.launchCommand} (sin issues lanzables)`]
  const { launch, infra, parallel } = batchesOf(order)
  const lines: string[] = []
  if (infra.length > 0) {
    // /mefisto:infra recibe un solo issue: una invocacion por numero.
    const hint = infra.map((n) => `/mefisto:infra #${n}`).join(' | ')
    lines.push(`Infra lanzable (desarrollala antes, sin exigirlo): ${hint}`)
  }
  lines.push(
    launch.length > 0
      ? commandLine(options.launchCommand, launch)
      : `Sin issues para ${options.launchCommand}: los lanzables son solo infra o sin tipo.`,
  )
  if (parallel.length >= 2) lines.push(commandLine(options.parallelCommand, parallel))
  return lines
}

function toJson(order: Order, options: Options): unknown {
  const launching = order.mode === 'launch'
  const { launch, infra, parallel } = batchesOf(order)
  return {
    mode: order.mode,
    items: order.items.map((item, index) => ({
      position: index + 1,
      number: item.issue.number,
      title: item.issue.title,
      tipo: tipoOf(item.issue),
      after: item.after,
      hasDepsSection: item.hasDepsSection,
    })),
    blocked: blockedJson(order),
    inPr: order.inPr.map(({ issue, pr }) => ({ number: issue.number, title: issue.title, tipo: tipoOf(issue), pr })),
    cycles: order.cycles,
    launch: launching && launch.length > 0 ? commandLine(options.launchCommand, launch) : null,
    infra: launching ? infra : [],
    parallel: launching
      ? { issues: parallel, launch: parallel.length >= 2 ? commandLine(options.parallelCommand, parallel) : null }
      : null,
  }
}

export interface Io {
  gh: Gh
  cwd: string
}

export function nextOrder(argv: string[], io: Io): Outcome {
  assertInConsumer(io.cwd)
  const options = parseArgs(argv)
  const universe = loadUniverse({
    mode: options.mode,
    gh: io.gh,
    issueFields: 'number,title,body,labels',
    prBranchPrefixes: ['worktree-issue-', 'infra-issue-'],
  })
  const order = computeOrder(universe, io.gh)
  const stdout = options.json
    ? renderJson(toJson(order, options))
    : renderText(order, {
        itemTag: (issue) => `[${tipoLabel(issue) ?? 'tipo:desconocido'}] `,
        launchTail: (launchable) => launchTail(launchable, options),
      })
  return outcomeOf(order, stdout, universe.warnings)
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => emit(nextOrder(process.argv.slice(2), { gh: ghCli, cwd: process.cwd() })))
}
