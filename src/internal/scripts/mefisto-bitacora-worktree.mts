// Aisla en un worktree la integracion de la bitacora interna: el checkout principal, que
// comparten varias sesiones, nunca cambia de rama, de HEAD ni de status.
//
// Uso:
//   node src/internal/scripts/mefisto-bitacora-worktree.mts prepare --fecha <YYYY-MM-DD>
//       Crea o reutiliza el worktree de la rama docs/bitacora-hasta-<fecha> desde origin/main,
//       bajo .mefisto/pipeline/summaries/, e imprime su ruta absoluta (unica linea de stdout).
//   node src/internal/scripts/mefisto-bitacora-worktree.mts deliver --worktree <ruta>
//       Valida que solo cambian rutas bajo docs/bitacora/, commitea, empuja, crea o reutiliza
//       el PR contra main, imprime "PR #<n>" y elimina el worktree solo si quedo limpio.
//       Reintentar es idempotente.
//
// Sale con 0 en exito y con 1 en cualquier fallo; el mensaje indica como recuperarse.

import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { CliError, capture, commandExists, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { assertInMefisto } from './lib/mefisto-repo.mts'
import { Output, chomp, runGh } from './lib/mefisto-script-io.mts'
import type { Gh } from './lib/mefisto-script-io.mts'

const BASE_BRANCH = 'main'
const ALLOWED_PREFIX = 'docs/bitacora/'
const BRANCH_PREFIX = 'docs/bitacora-hasta-'
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const USAGE = [
  'Uso:',
  '  mefisto-bitacora-worktree.sh prepare --fecha <YYYY-MM-DD>',
  '  mefisto-bitacora-worktree.sh deliver --worktree <ruta>',
].join('\n')

export interface BitacoraContext {
  /** Raiz del checkout principal de Mefisto. */
  root: string
  /** `owner/repo` del remoto. */
  repoSlug: string
  gh: Gh
  output: Output
}

type PullRequest = Record<string, unknown>

function git(dir: string, args: string[]): CommandResult {
  return capture('git', ['-C', dir, ...args])
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function summariesDir(root: string): string {
  return join(root, '.mefisto', 'pipeline', 'summaries')
}

function worktreeOfBranch(root: string, branch: string): string {
  let worktree = ''
  for (const line of git(root, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length)
    else if (line.startsWith('branch ') && line.split(/[ \t]+/)[1] === `refs/heads/${branch}`) return worktree
  }
  return ''
}

// Orden de jq entre valores escalares: null, false, true, numeros, cadenas.
function jqRank(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (value === false) return 1
  if (value === true) return 2
  if (typeof value === 'number') return 3
  return 4
}

function jqCompare(a: unknown, b: unknown): number {
  const rank = jqRank(a) - jqRank(b)
  if (rank !== 0) return rank
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  return 0
}

function creationKey(pr: PullRequest): unknown {
  const { createdAt } = pr
  return createdAt === null || createdAt === undefined || createdAt === false ? '' : createdAt
}

/** Los PRs de la salida JSON de `gh pr list`, o `null` si no es una lista de objetos. */
export function parsePullRequests(json: string): PullRequest[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const prs: PullRequest[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    prs.push(item as PullRequest)
  }
  return prs
}

/** El PR mas reciente: por fecha de creacion y, a igualdad, por numero. */
export function latestPullRequest(prs: PullRequest[]): PullRequest | null {
  const sorted = [...prs].sort(
    (a, b) => jqCompare(creationKey(a), creationKey(b)) || jqCompare(a.number, b.number),
  )
  return sorted.at(-1) ?? null
}

export function isMerged(pr: PullRequest): boolean {
  const { mergedAt } = pr
  return pr.state === 'MERGED' || !(mergedAt === null || mergedAt === undefined || mergedAt === false || mergedAt === '')
}

function prList(context: BitacoraContext, branch: string, fields: string): CommandResult {
  return context.gh([
    'pr', 'list', '--head', branch, '--base', BASE_BRANCH, '--repo', context.repoSlug,
    '--state', 'all', '--json', fields,
  ])
}

// La salida de git va a stderr: stdout queda solo para la ruta del worktree o el 'PR #<n>'.
function gitToStderr(output: Output, dir: string, args: string[]): boolean {
  const result = git(dir, args)
  output.writeErr(result.stdout + result.stderr)
  return result.status === 0
}

function refreshRemoteBranch(root: string, branch: string): boolean {
  const remoteRef = `refs/remotes/origin/${branch}`
  if (git(root, ['fetch', 'origin', `refs/heads/${branch}:${remoteRef}`]).status === 0) return true
  git(root, ['update-ref', '-d', remoteRef])
  return false
}

export function prepare(context: BitacoraContext, fecha: string): number {
  const { root, output } = context
  const branch = `${BRANCH_PREFIX}${fecha}`
  const worktree = join(summariesDir(root), `bitacora-${fecha}`)
  const retry = `'prepare --fecha ${fecha}'`

  if (!gitToStderr(output, root, ['fetch', 'origin', BASE_BRANCH])) {
    output.err(`ERROR: 'git fetch origin ${BASE_BRANCH}' fallo; verifica red y credenciales y reintenta ${retry}.`)
    return 1
  }

  const head = git(root, ['symbolic-ref', '-q', '--short', 'HEAD'])
  output.writeErr(head.stderr)
  if (chomp(head.stdout) === branch) {
    output.err(
      `ERROR: la rama '${branch}' esta checkouteada en el checkout principal; muevelo a su rama de trabajo habitual y reintenta.`,
    )
    return 1
  }

  let existing = worktreeOfBranch(root, branch)
  if (existing.length > 0 && !isDirectory(existing)) {
    gitToStderr(output, root, ['worktree', 'prune'])
    existing = ''
  }
  if (existing.length > 0) {
    output.err(`Worktree existente reutilizado: ${existing}`)
    output.out(existing)
    return 0
  }

  mkdirSync(summariesDir(root), { recursive: true })

  const hasLocal = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
  const hasRemote = refreshRemoteBranch(root, branch)

  // Rama ya entregada: si su PR mas reciente esta mergeado, el worktree nace de origin/main
  // para no heredar los commits que el squash ya integro.
  if (hasLocal || hasRemote) {
    const list = prList(context, branch, 'number,state,mergedAt,createdAt')
    output.writeErr(list.stderr)
    if (list.status !== 0) {
      output.err(
        `ERROR: 'gh pr list' fallo al consultar el PR de '${branch}'; revisa 'gh auth status' y reintenta ${retry}.`,
      )
      return 1
    }
    const latest = latestPullRequest(parsePullRequests(list.stdout) ?? [])
    if (latest !== null && isMerged(latest)) {
      output.err(`El PR mas reciente de '${branch}' ya se mergeo; se recrea la rama desde origin/${BASE_BRANCH}.`)
      if (!gitToStderr(output, root, ['worktree', 'add', '-B', branch, worktree, `origin/${BASE_BRANCH}`])) {
        output.err(`ERROR: 'git worktree add -B' fallo desde origin/${BASE_BRANCH}; reintenta ${retry}.`)
        return 1
      }
      output.out(realpathSync.native(worktree))
      return 0
    }
  }

  if (hasLocal) {
    if (!gitToStderr(output, root, ['worktree', 'add', worktree, branch])) {
      output.err(
        `ERROR: 'git worktree add' fallo sobre la rama local '${branch}'; revisa 'git worktree list', corre 'git worktree prune' y reintenta.`,
      )
      return 1
    }
  } else if (hasRemote) {
    if (!gitToStderr(output, root, ['worktree', 'add', '-b', branch, worktree, `origin/${branch}`])) {
      output.err(`ERROR: 'git worktree add' fallo desde origin/${branch}; reintenta.`)
      return 1
    }
  } else if (!gitToStderr(output, root, ['worktree', 'add', '-b', branch, worktree, `origin/${BASE_BRANCH}`])) {
    output.err(`ERROR: 'git worktree add' fallo desde origin/${BASE_BRANCH}; reintenta ${retry}.`)
    return 1
  }
  output.out(realpathSync.native(worktree))
  return 0
}

function scalar(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
}

// Tras una entrega exitosa el worktree ya no existe, pero su ruta canonica identifica la rama.
function deliveredPullRequest(context: BitacoraContext, worktree: string): { branch: string; number: string } | null {
  const name = basename(worktree)
  const fecha = name.startsWith('bitacora-') ? name.slice('bitacora-'.length) : name
  if (!DATE.test(fecha)) return null
  const branch = `${BRANCH_PREFIX}${fecha}`
  const prs = parsePullRequests(prList(context, branch, 'number,state,createdAt').stdout)
  if (prs === null) return null
  const latest = latestPullRequest(prs.filter((pr) => pr.state !== 'CLOSED'))
  if (latest === null || latest.number === null || latest.number === undefined || latest.number === false) {
    return null
  }
  return { branch, number: scalar(latest.number) }
}

function changedPathsOutsideScope(worktree: string): string[] {
  const listings = [
    git(worktree, ['diff', '--cached', '--name-only', '--no-renames']),
    git(worktree, ['diff', '--name-only', '--no-renames']),
    git(worktree, ['ls-files', '-o', '--exclude-standard']),
  ]
  const paths = new Set(listings.flatMap((listing) => listing.stdout.split('\n')))
  return [...paths].filter((path) => path.length > 0 && !path.startsWith(ALLOWED_PREFIX)).sort()
}

export function deliver(context: BitacoraContext, worktreeArg: string): number {
  const { root, output } = context
  let checkpoint = 'inicio'
  const recoveryAbort = (step: string, action: string): number => {
    output.err(`ERROR: fallo en el paso '${step}' de la entrega de la bitacora`)
    output.err(`Ultimo checkpoint confirmado: ${checkpoint}`)
    output.err(`Accion de recuperacion: ${action}`)
    return 1
  }

  if (!isDirectory(worktreeArg)) {
    const delivered = deliveredPullRequest(context, worktreeArg)
    if (delivered !== null) {
      output.err(`El worktree '${worktreeArg}' ya no existe; la rama '${delivered.branch}' ya fue entregada.`)
      output.out(`PR #${delivered.number}`)
      return 0
    }
    output.err(`ERROR: el worktree '${worktreeArg}' no existe; corre 'prepare' de nuevo.`)
    return 1
  }
  const worktree = realpathSync.native(worktreeArg)
  if (worktree === realpathSync.native(root)) {
    output.err('ERROR: --worktree apunta al checkout principal; la entrega solo opera en un worktree aislado.')
    return 1
  }
  const head = git(worktree, ['symbolic-ref', '-q', '--short', 'HEAD'])
  output.writeErr(head.stderr)
  const branch = chomp(head.stdout)
  if (!branch.startsWith(BRANCH_PREFIX)) {
    output.err(`ERROR: la rama del worktree ('${branch}') no es docs/bitacora-hasta-<fecha>.`)
    return 1
  }
  const fecha = branch.slice(BRANCH_PREFIX.length)

  const others = changedPathsOutsideScope(worktree)
  if (others.length > 0) {
    output.err(`ERROR: el worktree contiene cambios fuera de '${ALLOWED_PREFIX}':`)
    output.err(others.join('\n'))
    return 1
  }

  const passthrough = (result: CommandResult): boolean => {
    output.writeOut(result.stdout)
    output.writeErr(result.stderr)
    return result.status === 0
  }

  if (!passthrough(git(worktree, ['add', '-A', '--', ALLOWED_PREFIX]))) {
    return recoveryAbort('commit', `'git add' fallo en '${worktree}'; revisa 'git -C ${worktree} status' y reintenta.`)
  }

  if (git(worktree, ['diff', '--cached', '--quiet']).status !== 0) {
    if (!passthrough(git(worktree, ['commit', '-q', '-m', `docs(bitacora): entradas hasta el ${fecha}`]))) {
      return recoveryAbort(
        'commit',
        `'git commit' fallo en '${worktree}'; los cambios siguen staged; revisa 'git -C ${worktree} status' y reintenta.`,
      )
    }
  } else if (git(worktree, ['merge-base', '--is-ancestor', 'HEAD', `origin/${BASE_BRANCH}`]).status === 0) {
    output.err(`ERROR: no hay cambios que entregar en '${worktree}' (HEAD ya esta en origin/${BASE_BRANCH}).`)
    return 1
  } else {
    output.err('Commit existente reutilizado (sin cambios nuevos)')
  }
  const commit = git(worktree, ['rev-parse', 'HEAD'])
  output.writeErr(commit.stderr)
  checkpoint = 'commit'

  refreshRemoteBranch(root, branch)
  if (!gitToStderr(output, worktree, ['push', '-q', '--force-with-lease', '-u', 'origin', branch])) {
    return recoveryAbort(
      'push',
      `'git push' de '${branch}' fallo; el commit ${chomp(commit.stdout)} sigue en '${worktree}'. Revisa red/permisos y reintenta 'deliver --worktree ${worktree}'.`,
    )
  }
  checkpoint = 'push'

  const list = prList(context, branch, 'number,url,state,mergedAt,createdAt')
  output.writeErr(list.stderr)
  if (list.status !== 0) {
    return recoveryAbort('consulta-pr', "'gh pr list' fallo; revisa 'gh auth status' y reintenta.")
  }
  const previous = latestPullRequest(parsePullRequests(list.stdout) ?? [])
  // Un PR mergeado nunca se reutiliza: esta entrega va en un PR nuevo.
  const reusable = previous !== null && !isMerged(previous) ? previous : null

  let number: string
  if (reusable !== null) {
    const url = scalar(reusable.url)
    number = scalar(reusable.number)
    if (reusable.state === 'CLOSED') {
      const reopen = context.gh(['pr', 'reopen', '--repo', context.repoSlug, url])
      output.writeErr(reopen.stdout + reopen.stderr)
      if (reopen.status !== 0) {
        return recoveryAbort(
          'reapertura-pr',
          `El PR ${url} esta cerrado sin merge y 'gh pr reopen' fallo; reabrelo a mano y reintenta.`,
        )
      }
    }
    output.err(`PR existente reutilizado: ${url}`)
  } else {
    const subject = previous !== null && scalar(previous.state).length > 0 ? 'reentrega de entradas' : 'entradas'
    const create = context.gh([
      'pr', 'create', '--repo', context.repoSlug, '--base', BASE_BRANCH, '--head', branch,
      '--title', `docs(bitacora): ${subject} hasta el ${fecha}`,
      '--body', `Pone al dia la bitacora del harness (entrega aislada en worktree, hasta el ${fecha}).`,
    ])
    output.writeErr(create.stderr)
    if (create.status !== 0) {
      return recoveryAbort(
        'creacion-pr',
        `'gh pr create' fallo; la rama '${branch}' ya esta empujada. Reintenta 'deliver --worktree ${worktree}'.`,
      )
    }
    const url = chomp(create.stdout)
    number = url.slice(url.lastIndexOf('/') + 1)
  }
  checkpoint = 'pr'

  const status = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'])
  output.writeErr(status.stderr)
  if (chomp(status.stdout).length === 0) {
    git(root, ['worktree', 'remove', worktree])
  } else {
    output.err(`AVISO: el worktree '${worktree}' conserva cambios sin commitear; no se elimina.`)
  }

  output.out(`PR #${number}`)
  return 0
}

export interface Invocation {
  command: 'prepare' | 'deliver' | 'help'
  fecha: string
  worktree: string
}

/** Valida los argumentos; lanza `CliError` con el mensaje y el uso cuando no sirven. */
export function parseArguments(argv: string[]): Invocation {
  const command = argv[0] ?? ''
  const invocation: Invocation = { command: 'help', fecha: '', worktree: '' }
  if (command === '-h' || command === '--help') return invocation
  if (command !== 'prepare' && command !== 'deliver') {
    throw new CliError(`ERROR: subcomando '${command}' desconocido (prepare|deliver)\n${USAGE}`)
  }
  invocation.command = command

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fecha' || arg === '--worktree') {
      const value = argv[++i]
      if (value === undefined) throw new CliError(`ERROR: ${arg} requiere un valor`)
      if (arg === '--fecha') invocation.fecha = value
      else invocation.worktree = value
    } else if (arg === '-h' || arg === '--help') {
      return { command: 'help', fecha: '', worktree: '' }
    } else {
      throw new CliError(`ERROR: argumento desconocido '${arg}'\n${USAGE}`)
    }
  }

  if (command === 'prepare') {
    if (!DATE.test(invocation.fecha)) {
      throw new CliError('ERROR: --fecha es obligatoria y debe tener el formato YYYY-MM-DD')
    }
  } else if (invocation.worktree.length === 0) {
    throw new CliError('ERROR: --worktree es obligatorio')
  }
  return invocation
}

function main(argv: string[]): number {
  const invocation = parseArguments(argv)
  if (invocation.command === 'help') {
    console.error(USAGE)
    return 0
  }
  for (const dependency of ['git', 'gh']) {
    if (!commandExists(dependency)) throw new CliError(`ERROR: '${dependency}' no esta disponible en PATH`)
  }
  const repo = assertInMefisto()
  const context: BitacoraContext = {
    root: repo.root,
    repoSlug: repo.repoSlug,
    gh: runGh,
    output: new Output(true),
  }
  return invocation.command === 'prepare'
    ? prepare(context, invocation.fecha)
    : deliver(context, invocation.worktree)
}

if (isEntryPoint(import.meta.url)) runMain(() => main(process.argv.slice(2)))
