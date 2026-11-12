// Valida las dependencias intra-batch antes de lanzar un batch secuencial (paso 1.5 de
// mefisto-sequential) y reconcilia los labels 'bloqueado' tras el merge de un PR.
//
// Uso:
//   node src/internal/scripts/mefisto-validate-batch-deps.mts <issue1> <issue2> ...
//       (el orden de los argumentos es el orden del batch)
//   node src/internal/scripts/mefisto-validate-batch-deps.mts --reconcile-pr <pr>
//
// Sale con 0 si la validacion o la reconciliacion terminan bien (incluido el PR sin
// 'Closes'), 1 ante un bloqueo real del batch o un fallo operativo de la reconciliacion, y 2
// si la invocacion es invalida: no se valido nada.
//
// De cada issue del batch, lleve o no el label 'bloqueado', se leen las dependencias forward
// de su seccion '## Dependencias'. Cada dependencia abierta se clasifica:
//   (a) satisfactible: esta en el batch y antes en el orden. No bloquea; si el issue llevaba
//       'bloqueado' se le quita, y si no, se informa que el orden la resuelve.
//   (b) bloqueo real: esta fuera del batch, o dentro pero despues. Aborta el batch entero sin
//       mutar ningun label.
// Una dependencia CLOSED o MERGED ya esta satisfecha.

import { CliError, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import { dependenciesSection, forwardDependencies } from '../../../scripts/lib/issue-dependencies.mts'
import { Output, chomp, runGh } from './lib/mefisto-script-io.mts'
import type { Gh } from './lib/mefisto-script-io.mts'

const SCRIPT = 'src/internal/scripts/mefisto-validate-batch-deps.mts'
const CLOSES = /Closes[ \t\v\f\r]+#([0-9]+)/gi

/** Posicion 1-based de un issue en el batch; 0 si no esta. */
export function positionInBatch(batch: string[], target: string): number {
  return batch.indexOf(target) + 1
}

/** Issues que el body de un PR cierra con 'Closes #N', sin repetir y en orden de texto. */
export function closedIssues(prBody: string): string[] {
  const numbers = new Set<string>()
  for (const line of prBody.split('\n')) {
    for (const match of line.matchAll(CLOSES)) {
      if (match[1] !== undefined) numbers.add(match[1])
    }
  }
  return [...numbers].sort()
}

// Una dependencia puede ser un issue o un PR; vacio si `gh` no resuelve ninguno de los dos.
function dependencyState(gh: Gh, dep: string): string {
  const issue = gh(['issue', 'view', dep, '--json', 'state', '-q', '.state'])
  if (issue.status === 0) return chomp(issue.stdout)
  const pr = gh(['pr', 'view', dep, '--json', 'state', '-q', '.state'])
  return chomp(issue.stdout + pr.stdout)
}

function removeBlockedLabel(gh: Gh, output: Output, issue: string): boolean {
  const edit = gh(['issue', 'edit', issue, '--remove-label', 'bloqueado'])
  output.writeOut(edit.stdout)
  output.writeErr(edit.stderr)
  return edit.status === 0
}

export function reconcilePr(pr: string, gh: Gh, output: Output): number {
  const prState = gh(['pr', 'view', pr, '--json', 'state', '-q', '.state'])
  if (prState.status !== 0) {
    output.err(`ERROR: no se pudo consultar el PR #${pr}. Verifica que exista y que gh tenga acceso.`)
    return 1
  }
  const state = chomp(prState.stdout)
  if (state !== 'MERGED') {
    output.err(
      `ERROR: el PR #${pr} no está MERGED (estado: ${state}). La reconciliación solo corre después del merge.`,
    )
    return 1
  }
  const prBody = gh(['pr', 'view', pr, '--json', 'body', '-q', '.body'])
  if (prBody.status !== 0) {
    output.err(`ERROR: no se pudo leer el body del PR #${pr}.`)
    return 1
  }

  const closed = closedIssues(chomp(prBody.stdout))
  if (closed.length === 0) {
    output.out(`PR #${pr} no declara cierres 'Closes #N'; no hay nada que reconciliar.`)
    return 0
  }

  const blockedList = gh([
    'issue', 'list', '--state', 'open', '--label', 'bloqueado', '--json', 'number', '-q', '.[].number',
  ])
  if (blockedList.status !== 0) {
    output.err("ERROR: no se pudieron listar los issues abiertos con label 'bloqueado'.")
    return 1
  }

  let hadError = 0
  for (const blocked of words(blockedList.stdout)) {
    const issueBody = gh(['issue', 'view', blocked, '--json', 'body', '-q', '.body'])
    if (issueBody.status !== 0) {
      output.err(`ERROR: no se pudo leer el body del issue bloqueado #${blocked}.`)
      hadError = 1
      continue
    }
    const body = chomp(issueBody.stdout)
    const deps = forwardDependencies(body)
    if (!closed.some((number) => deps.includes(number))) {
      const section = dependenciesSection(body)
      const loose = closed.find((number) => {
        const mention = new RegExp(`#${number}([^0-9]|$)`)
        return section.some((line) => mention.test(line))
      })
      if (loose !== undefined) {
        output.err(
          `WARNING: issue #${blocked} referencia el issue recién cerrado #${loose} en '## Dependencias' sin redacción canónica parseable ('Depende de #N' / 'Bloqueado por #N'); no se pudo evaluar su desbloqueo automático.`,
        )
      }
      continue
    }

    // Solo se desbloquea con todas las dependencias forward satisfechas; una consulta
    // fallida conserva el label y deja evidencia.
    let unblock = true
    for (const dep of deps) {
      const depState = dependencyState(gh, dep)
      if (depState === 'CLOSED' || depState === 'MERGED') continue
      unblock = false
      if (depState === 'OPEN') {
        output.err(`Issue #${blocked} sigue bloqueado: la dependencia #${dep} está OPEN.`)
      } else {
        output.err(
          `ERROR: issue #${blocked} conserva 'bloqueado': no se pudo determinar el estado de la dependencia #${dep}.`,
        )
        hadError = 1
      }
      break
    }
    if (!unblock) continue
    if (removeBlockedLabel(gh, output, blocked)) {
      output.out(`Quitado 'bloqueado' de #${blocked}: todas sus dependencias forward están CLOSED/MERGED.`)
    } else {
      output.err(`ERROR: no se pudo quitar 'bloqueado' de #${blocked}.`)
      hadError = 1
    }
  }
  return hadError
}

function words(text: string): string[] {
  return text.split(/[ \t\n]+/).filter((word) => word.length > 0)
}

export function validateBatch(args: string[], gh: Gh, output: Output): number {
  const batch = words(args.join(' '))
  let abortMessages = ''
  let orderMessages = ''
  const labelsToClear: string[] = []

  for (const issue of batch) {
    const issuePosition = positionInBatch(batch, issue)

    // El label no filtra la entrada al analisis: solo dice si hay que quitarlo al final.
    const labels = gh(['issue', 'view', issue, '--json', 'labels', '-q', '[.labels[].name] | join(",")'])
    output.writeErr(labels.stderr)
    const hasLabel = `,${chomp(labels.stdout)},`.includes(',bloqueado,')

    const body = gh(['issue', 'view', issue, '--json', 'body', '-q', '.body'])
    output.writeErr(body.stderr)

    let realBlocks = ''
    let solvedByOrder = ''
    for (const dep of forwardDependencies(body.stdout)) {
      if (dep === issue) continue
      const depState = dependencyState(gh, dep)
      if (depState === 'CLOSED' || depState === 'MERGED') continue
      const depPosition = positionInBatch(batch, dep)
      if (depPosition === 0) {
        realBlocks += `\n  - #${dep} esta fuera del batch y no esta CLOSED/MERGED (bloqueo real).`
      } else if (depPosition < issuePosition) {
        solvedByOrder += ` #${dep}`
      } else {
        realBlocks += `\n  - #${dep} esta en el batch pero DESPUES de #${issue} (mal ordenada). Mueve #${dep} antes de #${issue}.`
      }
    }

    if (realBlocks.length > 0) {
      abortMessages += `\n#${issue} no se puede lanzar:${realBlocks}`
    } else if (hasLabel) {
      labelsToClear.push(issue)
    } else if (solvedByOrder.length > 0) {
      // Sin esta linea, un exit 0 no se distingue de no haber leido el body del issue.
      orderMessages += `\n#${issue}: dependencias abiertas${solvedByOrder} satisfechas por el orden del batch (no tenia label 'bloqueado' que quitar).`
    }
  }

  if (abortMessages.length > 0) {
    output.out('ABORTAR el batch. Bloqueos reales detectados:')
    output.out(abortMessages)
    output.out('')
    output.out('Reordena el batch (dependencias antes que sus dependientes) o cierra las')
    output.out('dependencias externas antes de relanzar.')
    return 1
  }

  if (orderMessages.length > 0) {
    output.out("Dependencias resueltas por el orden del batch (issues sin label 'bloqueado'):")
    output.out(orderMessages)
  }

  // Los labels se mutan solo si todo el batch paso la validacion.
  for (const issue of labelsToClear) {
    removeBlockedLabel(gh, output, issue)
    output.out(`Quitado 'bloqueado' de #${issue}: sus dependencias abiertas se resuelven por el`)
    output.out('orden del batch + sync verificado (#46); las cerradas ya estan satisfechas.')
  }
  output.out('Validacion 1.5 OK: el batch se puede lanzar.')
  return 0
}

export function run(argv: string[], gh: Gh, output: Output): number {
  // --reconcile-pr va antes de la guarda posicional: no es un issue del batch.
  if (argv[0] === '--reconcile-pr') {
    const pr = argv[1]
    if (argv.length !== 2 || pr === undefined || !/^[0-9]+$/.test(pr)) {
      throw new CliError(`ERROR: uso: ${SCRIPT} --reconcile-pr <pr>`, 2)
    }
    return reconcilePr(pr, gh, output)
  }
  if (argv.length === 0) {
    throw new CliError(
      [
        'ERROR: se invoco sin issues. No se valido NADA (no interpretes esto como OK).',
        `Uso: ${SCRIPT} <issue1> <issue2> ...`,
      ].join('\n'),
      2,
    )
  }
  return validateBatch(argv, gh, output)
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => run(process.argv.slice(2), runGh, new Output(true)))
}
