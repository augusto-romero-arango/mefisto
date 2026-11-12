// Orden de lanzamiento de los issues 'estado:listo' abiertos del repo de Mefisto, o de
// refinamiento de sus 'estado:borrador'. Solo lectura. El algoritmo esta en
// `scripts/lib/next-order.mts`, compartido con `scripts/next-order.mts`.
//
// Uso: node src/internal/scripts/mefisto-next-order.mts [--refinement] [--json]
//
//   --refinement  Ordena los borradores; la ultima linea es 'Siguiente a refinar: #N'.
//   --json        Un objeto JSON en stdout: mode, items[] (position, number, hasDepsSection,
//                 after[], title), blocked[] (number, by, reason y pr si reason es 'pr'),
//                 inPr[] (number, title, pr), cycles[][] y launch.
//
// Lo que no comparte con el publicado: aqui todo es 'tipo:tooling' y no existe un comando
// paralelo, asi que la salida no lleva tipo, infra ni lote paralelo y la linea de lanzamiento es
// siempre '/mefisto-sequential'; un PR delata su issue por la rama 'worktree-mefisto-issue-<n>-'.
//
// Exit: 0 con al menos un issue en el orden, 1 si quedo vacio, 2 si falla 'gh issue list' o hay
// un argumento desconocido.

import { CliError, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import {
  blockedJson,
  computeOrder,
  emit,
  ghCli,
  loadUniverse,
  outcomeOf,
  renderJson,
  renderText,
} from '../../../scripts/lib/next-order.mts'
import type { Gh, Mode, Order, Outcome } from '../../../scripts/lib/next-order.mts'

const LAUNCH_COMMAND = '/mefisto-sequential'

export interface Options {
  mode: Mode
  json: boolean
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { mode: 'launch', json: false }
  for (const arg of argv) {
    if (arg === '--refinement') options.mode = 'refinement'
    else if (arg === '--json') options.json = true
    else {
      throw new CliError(
        `ERROR: argumento desconocido: ${arg}.\nUso: src/internal/scripts/mefisto-next-order.mts [--refinement] [--json]`,
        2,
      )
    }
  }
  return options
}

function launchLine(order: Order): string {
  if (order.items.length === 0) return `${LAUNCH_COMMAND} (sin issues lanzables)`
  return `${LAUNCH_COMMAND} ${order.items.map((item) => item.issue.number).join(' ')}`
}

function toJson(order: Order): unknown {
  return {
    mode: order.mode,
    items: order.items.map((item, index) => ({
      position: index + 1,
      number: item.issue.number,
      hasDepsSection: item.hasDepsSection,
      after: item.after,
      title: item.issue.title,
    })),
    blocked: blockedJson(order),
    inPr: order.inPr.map(({ issue, pr }) => ({ number: issue.number, title: issue.title, pr })),
    cycles: order.cycles,
    launch: order.mode === 'launch' && order.items.length > 0 ? launchLine(order) : null,
  }
}

export function mefistoNextOrder(argv: string[], gh: Gh): Outcome {
  const options = parseArgs(argv)
  const universe = loadUniverse({
    mode: options.mode,
    gh,
    issueFields: 'number,title,body',
    prBranchPrefixes: ['worktree-mefisto-issue-'],
  })
  const order = computeOrder(universe, gh)
  const stdout = options.json
    ? renderJson(toJson(order))
    : renderText(order, { itemTag: () => '', launchTail: (launchable) => [launchLine(launchable)] })
  return outcomeOf(order, stdout, universe.warnings)
}

if (isEntryPoint(import.meta.url)) runMain(() => emit(mefistoNextOrder(process.argv.slice(2), ghCli)))
