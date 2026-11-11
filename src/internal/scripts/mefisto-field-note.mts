// Entrega una field note de un agente interno por un PR contra la rama predeterminada de Mefisto.
//
// Uso: node src/internal/scripts/mefisto-field-note.mts --agent <nombre>
//        --timestamp <YYYY-MM-DD-HHMM> --session-id <id-seguro>   (el Markdown llega por stdin)
//
// Repetir la invocacion con los mismos flags reanuda la entrega: reutiliza la rama, el worktree, el
// commit y el PR que ya existan. Sale con 0 si el PR quedo creado, reutilizado, reabierto o ya
// mergeado, y con 1 ante cualquier fallo.

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CliError, isEntryPoint } from '../../../scripts/lib/cli.mts'
import {
  FieldNoteDelivery,
  SYSTEM_TOOLS,
  exitCodeOf,
  isMerged,
  parseFlags,
  parsePrList,
  prField,
  requireCommands,
  trimTrailingNewlines,
  validateSlug,
  validateTimestamp,
} from '../../../scripts/lib/field-note.mts'
import type { CommandOutput, PullRequest, Tools } from '../../../scripts/lib/field-note.mts'
import { assertInMefisto, ensureGithooksInstalled } from './lib/mefisto-repo.mts'
import type { MefistoRepo } from './lib/mefisto-repo.mts'

const USAGE = `Uso: mefisto-field-note.sh --agent <nombre> --timestamp <YYYY-MM-DD-HHMM> --session-id <id-seguro>

Recibe el contenido Markdown de la field note por stdin. Crea (o recupera, si
ya existe de una entrega anterior de la misma sesion) un worktree temporal
aislado del checkout principal y en el commitea, empuja y abre/reabre/reusa
el PR de docs/bitacora/field-notes/<timestamp>-<agente>.md contra la rama
predeterminada del repo.`

const FLAGS = ['--agent', '--timestamp', '--session-id']

export interface DeliverOptions {
  cwd?: string
  tools?: Tools
  readStdin?: () => Buffer
  resolveRepo?: (cwd: string) => MefistoRepo
}

function readStdin(): Buffer {
  try {
    return readFileSync(0)
  } catch {
    return Buffer.alloc(0)
  }
}

/**
 * El PR creado mas recientemente; a igual fecha, el de mayor numero. `gh pr list` no documenta su
 * orden, y sin esto una reentrega abierta podria quedar detras del PR mergeado de la misma rama.
 */
export function latestPr(prs: PullRequest[]): PullRequest | undefined {
  const createdAt = (pr: PullRequest): string => (typeof pr.createdAt === 'string' ? pr.createdAt : '')
  const number = (pr: PullRequest): number => (typeof pr.number === 'number' ? pr.number : -Infinity)
  let latest: PullRequest | undefined
  for (const pr of prs) {
    if (latest === undefined) {
      latest = pr
      continue
    }
    const [a, b] = [createdAt(pr), createdAt(latest)]
    if (a > b || (a === b && number(pr) >= number(latest))) latest = pr
  }
  return latest
}

export function deliver(argv: string[], options: DeliverOptions = {}): number {
  const tools = options.tools ?? SYSTEM_TOOLS
  const cwd = options.cwd ?? process.cwd()

  return exitCodeOf(tools, () => {
    const flags = parseFlags(argv, FLAGS, USAGE)
    const agent = flags.get('--agent') ?? ''
    const timestamp = flags.get('--timestamp') ?? ''
    const sessionId = flags.get('--session-id') ?? ''
    if (agent.length === 0 || timestamp.length === 0 || sessionId.length === 0) {
      throw new CliError(`ERROR: --agent, --timestamp y --session-id son obligatorios\n${USAGE}`)
    }
    validateSlug(agent, '--agent', 60)
    validateSlug(sessionId, '--session-id', 120)
    validateTimestamp(timestamp)
    requireCommands(tools, ['git', 'gh'])

    const repo = (options.resolveRepo ?? assertInMefisto)(cwd)
    const root = repo.root
    const notice = ensureGithooksInstalled(root)
    if (notice !== null) tools.err(`${notice}\n`)
    if (repo.repoSlug.length === 0) {
      throw new CliError(
        "ERROR: no se pudo resolver el repo remoto (gh repo view --json nameWithOwner); revisa 'gh auth status'",
      )
    }
    const slug = repo.repoSlug

    const note = trimTrailingNewlines((options.readStdin ?? readStdin)())
    if (note.length === 0) {
      throw new CliError('ERROR: no se recibio contenido por stdin para la field note')
    }

    const noteRel = `docs/bitacora/field-notes/${timestamp}-${agent}.md`
    const docBranch = `docs/${agent}-field-note-${sessionId}`
    const delivery = new FieldNoteDelivery({
      tools,
      cwd,
      root,
      sessionId,
      docBranch,
      retryFlags: '--agent/--timestamp/--session-id',
      invariant: 'CA-4',
      isolation: 'el aislamiento del checkout principal',
    })

    return delivery.run(() => {
      // El slug va posicional: `gh repo view` no acepta --repo.
      const branch = delivery.read('gh', ['repo', 'view', slug, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
      if (!branch.ok || branch.value.length === 0 || branch.value === 'null') {
        throw new CliError(
          `ERROR: no se pudo resolver la rama predeterminada del repo via 'gh repo view' (rc=${branch.status ?? 127}); revisa 'gh auth status', o si el argv de 'gh repo view' es valido (no acepta --repo, el slug va posicional)`,
        )
      }
      const defaultBranch = branch.value
      delivery.defaultBranch = defaultBranch

      const previous = delivery.locatePrevious()
      if (!previous.remoteBranch) {
        // Una tracking ref que sobrevivio al borrado de la rama remota seria el valor implicito del
        // lease del push y daria un falso "stale info". Se borra solo la de esta sesion.
        if (!delivery.show('git', ['-C', root, 'update-ref', '-d', `refs/remotes/origin/${docBranch}`])) {
          delivery.abort(
            'worktree',
            `No se pudo eliminar la referencia remota local obsoleta de '${docBranch}'; inspecciona 'git -C ${root} show-ref refs/remotes/origin/${docBranch}' y reintenta.`,
          )
        }
      }

      const summaries = join(root, '.mefisto', 'pipeline', 'summaries')
      try {
        mkdirSync(summaries, { recursive: true })
      } catch {
        // Si no se pudo crear, falla el directorio temporal de abajo, con su mensaje.
      }
      delivery.mountWorktree(previous, () => mkdtempSync(join(summaries, `field-note-${sessionId}.`)))
      const worktree = delivery.worktreeDir

      delivery.writeFile(noteRel, note)
      delivery.stage(noteRel, 'del worktree documental')
      const unexpected = delivery.unexpectedChanges([noteRel])
      if (unexpected.length > 0) {
        throw new CliError(
          [`ERROR: el worktree documental contiene cambios fuera de '${noteRel}':`, ...unexpected].join('\n'),
        )
      }

      delivery.commit({
        rel: noteRel,
        message: `docs(bitacora): agregar field note de ${agent}`,
        noteInBase: `'${noteRel}'`,
        subject: ' de la field note',
        staged: 'la field note sigue staged',
      })
      const commit = delivery.commitSha

      // La consulta va antes del push: si el PR anterior se mergeo y este commit ya esta en la
      // base, no hay nada que publicar; si trae contenido nuevo, es una reentrega con PR propio.
      const list = delivery.read('gh', [
        'pr',
        'list',
        '--head',
        docBranch,
        '--base',
        defaultBranch,
        '--repo',
        slug,
        '--state',
        'all',
        '--json',
        'number,url,state,mergedAt,createdAt',
      ])
      if (!list.ok) {
        delivery.abort(
          'consulta-pr',
          `'gh pr list' fallo para '${docBranch}'; el commit ${commit} sigue disponible localmente. Revisa 'gh auth status' y reintenta con los mismos flags.`,
        )
      }

      const pr = latestPr(parsePrList(list.value))
      let prUrl = ''
      let redelivery = false
      let alreadyDelivered = false
      if (pr !== undefined) {
        prUrl = prField(pr, 'url')
        if (isMerged(pr)) {
          if (delivery.show('git', ['-C', worktree, 'merge-base', '--is-ancestor', commit, `origin/${defaultBranch}`])) {
            alreadyDelivered = true
            delivery.say(`PR ya mergeado: la field note de esta sesion ya fue entregada (${prUrl})`)
          } else {
            redelivery = true
          }
        }
      }

      if (!alreadyDelivered) {
        delivery.push()
        const create = (title: string, body: string): CommandOutput =>
          delivery.read('gh', ['pr', 'create', '--repo', slug, '--base', defaultBranch, '--head', docBranch, '--title', title, '--body', body])

        if (redelivery) {
          const created = create(
            `docs(bitacora): reentrega de field note de ${agent} ${timestamp}`,
            `Reentrega aislada de la field note de la sesion ${agent} ${sessionId} tras el merge del PR anterior.`,
          )
          if (!created.ok) {
            delivery.abort(
              'creacion-pr',
              `'gh pr create' de reentrega fallo; la rama '${docBranch}' con el commit ${commit} ya esta empujada a origin. Revisa 'gh auth status' y reintenta con los mismos flags.`,
            )
          }
          prUrl = created.value
          delivery.say('PR de reentrega creado tras el merge del PR anterior')
        } else if (pr === undefined) {
          const created = create(
            `docs(bitacora): field note de ${agent} ${timestamp}`,
            `Entrega aislada de la field note de la sesion ${agent} ${sessionId}.`,
          )
          if (!created.ok) {
            delivery.abort(
              'creacion-pr',
              `'gh pr create' fallo; la rama '${docBranch}' con el commit ${commit} ya esta empujada a origin. Revisa 'gh auth status' y reintenta con los mismos flags -- la proxima corrida encontrara la rama ya lista y solo reintentara el PR.`,
            )
          }
          prUrl = created.value
          delivery.say(`PR creado (no existia ninguno para '${docBranch}')`)
        } else if (prField(pr, 'state') === 'OPEN') {
          delivery.say("PR ya existente reutilizado (no se llamo a 'gh pr create')")
        } else {
          if (!delivery.show('gh', ['pr', 'reopen', '--repo', slug, prUrl])) {
            delivery.abort(
              'reapertura-pr',
              `El PR ${prUrl} de '${docBranch}' esta cerrado sin merge y 'gh pr reopen' fallo; la rama y el commit ${commit} siguen intactos en origin. Reabrelo a mano en GitHub, o revisa 'gh auth status' y reintenta.`,
            )
          }
          delivery.say(`PR cerrado sin merge fue reabierto: ${prUrl}`)
        }
      }
      delivery.checkpoint = 'pr'

      delivery.say(`Field note: ${noteRel}`)
      delivery.say(`Rama: ${docBranch}`)
      delivery.say(`Commit: ${commit}`)
      delivery.say(`PR: ${prUrl}`)
    })
  })
}

if (isEntryPoint(import.meta.url)) process.exitCode = deliver(process.argv.slice(2))
