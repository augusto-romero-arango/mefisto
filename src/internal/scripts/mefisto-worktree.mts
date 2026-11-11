// Worktree propio para las sesiones de trabajo directo: ninguna edita ni commitea en el
// checkout principal, asi su HEAD compartido nunca se mueve.
//
// Uso:
//   node src/internal/scripts/mefisto-worktree.mts new <slug>
//       crea (o reutiliza) .mefisto/worktrees/<slug> en la rama <slug> desde origin/main e
//       imprime su ruta absoluta en stdout
//   node src/internal/scripts/mefisto-worktree.mts clean
//       recorre todos los worktrees del repo (tambien los antiguos al lado del repo) y
//       elimina los de rama mergeada con status limpio y las raices de batch cuyo proceso
//       ya no existe
//
// Sale con 0 en exito y con 1 en cualquier fallo.

import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CliError, capture, commandExists, gitOutput, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { ensureGithooksInstalled } from './lib/mefisto-repo.mts'
import { Output, chomp } from './lib/mefisto-script-io.mts'

const BASE_BRANCH = 'main'
const USAGE = ['Uso: mefisto-worktree.sh new <slug>', '     mefisto-worktree.sh clean'].join('\n')
const PIPELINE_BRANCH = /^worktree-mefisto-issue-([0-9]+)-/
const EXECUTION_ROOT_PREFIX = 'mefisto-batch-execution-'

export interface WorktreeContext {
  /** Raiz del checkout principal. */
  mainRoot: string
  output: Output
  /** Estado de un issue segun `gh`, o `null` si `gh` no esta o falla. */
  issueState: (issue: string) => string | null
  isProcessAlive: (pid: number) => boolean
}

function git(root: string, args: string[]): CommandResult {
  return capture('git', ['-C', root, ...args])
}

// La salida de git va a stderr: stdout queda solo para la ruta del worktree.
function gitToStderr(context: WorktreeContext, args: string[]): boolean {
  const result = git(context.mainRoot, args)
  context.output.writeErr(result.stdout + result.stderr)
  return result.status === 0
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function realPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function samePath(a: string, b: string): boolean {
  return realPath(a) === realPath(b)
}

function worktreeDirs(mainRoot: string): string[] {
  return git(mainRoot, ['worktree', 'list', '--porcelain'])
    .stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

export function worktreeBase(mainRoot: string): string {
  return join(mainRoot, '.mefisto', 'worktrees')
}

export function commandNew(context: WorktreeContext, slug: string): number {
  const { mainRoot, output } = context
  if (slug.length === 0) {
    output.err("ERROR: 'new' requiere un <slug>")
    output.err(USAGE)
    return 1
  }
  if (slug.startsWith('-')) {
    output.err(`ERROR: slug '${slug}' no puede empezar con '-'`)
    return 1
  }
  if (/[^A-Za-z0-9_-]/.test(slug)) {
    output.err(`ERROR: slug '${slug}' es invalido: solo se permiten letras, digitos, '-' y '_'`)
    return 1
  }

  const base = worktreeBase(mainRoot)
  const worktree = join(base, slug)

  const hooksNotice = ensureGithooksInstalled(mainRoot)
  if (hooksNotice !== null) output.err(hooksNotice)

  if (worktreeDirs(mainRoot).some((dir) => samePath(dir, worktree)) && isDirectory(worktree)) {
    output.out(worktree)
    return 0
  }

  if (!gitToStderr(context, ['fetch', 'origin', BASE_BRANCH])) {
    output.err(`ERROR: 'git fetch origin ${BASE_BRANCH}' fallo; verifica la red y las credenciales`)
    return 1
  }

  git(mainRoot, ['worktree', 'prune'])
  try {
    mkdirSync(base, { recursive: true })
  } catch {
    output.err(`ERROR: no se pudo crear '${base}'`)
    return 1
  }

  if (git(mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${slug}`]).status === 0) {
    if (!gitToStderr(context, ['worktree', 'add', worktree, slug])) {
      output.err(
        `ERROR: la rama '${slug}' existe pero 'git worktree add' fallo (puede estar checkouteada en otro worktree)`,
      )
      return 1
    }
  } else if (
    !gitToStderr(context, ['worktree', 'add', '--no-track', '-b', slug, worktree, `origin/${BASE_BRANCH}`])
  ) {
    output.err(`ERROR: 'git worktree add' fallo; revisa que 'origin/${BASE_BRANCH}' exista`)
    return 1
  }
  output.out(worktree)
  return 0
}

// Rama de una corrida del pipeline que aborto sin trabajo propio: sin commits fuera de
// origin/main y con su issue cerrado. El reflog no la distingue de una rama recien creada.
function pipelineBranchAbandoned(context: WorktreeContext, branch: string): boolean {
  const issue = PIPELINE_BRANCH.exec(branch)?.[1]
  if (issue === undefined) return false
  const ahead = git(context.mainRoot, ['rev-list', '--count', `origin/${BASE_BRANCH}..refs/heads/${branch}`])
  if (chomp(ahead.stdout) !== '0') return false
  return context.issueState(issue) === 'CLOSED'
}

/**
 * Una rama cuenta como mergeada si su punta esta en origin/main habiendo tenido commits
 * propios (una recien creada tambien es ancestro de origin/main y no debe borrarse), si su
 * upstream desaparecio del remoto (rama borrada al mergear por squash), o si es una rama de
 * pipeline abandonada.
 */
export function branchIsMerged(context: WorktreeContext, branch: string): boolean {
  const { mainRoot } = context
  const ref = `refs/heads/${branch}`
  const reflogEntries = git(mainRoot, ['reflog', 'show', ref]).stdout.split('\n').length - 1
  if (
    reflogEntries > 1 &&
    git(mainRoot, ['merge-base', '--is-ancestor', ref, `origin/${BASE_BRANCH}`]).status === 0
  ) {
    return true
  }
  const track = chomp(git(mainRoot, ['for-each-ref', '--format=%(upstream:track)', ref]).stdout)
  if (track === '[gone]') return true
  return pipelineBranchAbandoned(context, branch)
}

/** Raiz de ejecucion del batch (mefisto-batch-execution-<ts>-<pid>) cuyo proceso ya no existe. */
export function isOrphanExecutionRoot(context: WorktreeContext, dir: string): boolean {
  const name = basename(dir)
  if (!name.startsWith(EXECUTION_ROOT_PREFIX)) return false
  const pid = name.slice(name.lastIndexOf('-') + 1)
  if (!/^[0-9]+$/.test(pid)) return false
  return !context.isProcessAlive(Number(pid))
}

/** Como `kill -0`: cualquier fallo de la senal, tambien el de permisos, cuenta como proceso inexistente. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function commandClean(context: WorktreeContext): number {
  const { mainRoot, output } = context
  // Sin refspec: con 'origin main', --prune solo poda origin/main y una rama mergeada por
  // squash nunca quedaria con upstream [gone].
  if (!gitToStderr(context, ['fetch', '--prune', 'origin'])) {
    output.err("ERROR: 'git fetch --prune origin' fallo; verifica la red y las credenciales")
    return 1
  }
  git(mainRoot, ['worktree', 'prune'])

  let removed = 0
  let kept = 0
  for (const dir of worktreeDirs(mainRoot)) {
    if (samePath(dir, mainRoot)) continue
    if (!isDirectory(dir)) continue
    const branch = chomp(git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']).stdout)
    if (branch.length === 0) {
      if (
        isOrphanExecutionRoot(context, dir) &&
        git(mainRoot, ['worktree', 'remove', '--force', dir]).status === 0
      ) {
        output.out(`Eliminado: ${dir} (raiz de batch sin proceso vivo)`)
        removed++
        continue
      }
      output.err(`AVISO: '${dir}' sin rama (HEAD desacoplado); se conserva`)
      kept++
      continue
    }
    if (!branchIsMerged(context, branch)) {
      output.out(`Conservado (rama '${branch}' aun no mergeada en origin/${BASE_BRANCH}): ${dir}`)
      kept++
      continue
    }
    const status = chomp(git(dir, ['status', '--porcelain=v1', '--untracked-files=all']).stdout)
    if (status.length > 0) {
      output.err(`AVISO: '${dir}' (rama '${branch}' mergeada) tiene cambios sin commitear; se conserva:`)
      output.err(status)
      kept++
      continue
    }
    if (git(mainRoot, ['worktree', 'remove', dir]).status !== 0) {
      output.err(`AVISO: no se pudo eliminar el worktree '${dir}'; se conserva`)
      kept++
      continue
    }
    git(mainRoot, ['branch', '-D', branch])
    output.out(`Eliminado: ${dir} (rama '${branch}')`)
    removed++
  }
  output.out(`Limpieza: ${removed} eliminados, ${kept} conservados`)
  return 0
}

/** Raiz del checkout principal del repo que contiene `cwd`, aunque `cwd` sea un worktree. */
export function mainRootOf(cwd: string = process.cwd()): string | null {
  const commonDir = gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  return commonDir === null ? null : resolve(dirname(commonDir))
}

function ghIssueState(mainRoot: string, issue: string): string | null {
  if (!commandExists('gh')) return null
  const result = capture('gh', ['issue', 'view', issue, '--json', 'state', '-q', '.state'], { cwd: mainRoot })
  return result.status === 0 ? chomp(result.stdout) : null
}

function main(argv: string[]): number {
  if (!commandExists('git')) throw new CliError("ERROR: 'git' no esta disponible en PATH")
  const mainRoot = mainRootOf()
  if (mainRoot === null) throw new CliError('ERROR: no se esta dentro de un repositorio git')
  const output = new Output(true)
  const context: WorktreeContext = {
    mainRoot,
    output,
    issueState: (issue) => ghIssueState(mainRoot, issue),
    isProcessAlive,
  }
  switch (argv[0]) {
    case 'new':
      return commandNew(context, argv[1] ?? '')
    case 'clean':
      return commandClean(context)
    case '-h':
    case '--help':
      output.err(USAGE)
      return 0
    default:
      output.err(USAGE)
      return 1
  }
}

if (isEntryPoint(import.meta.url)) runMain(() => main(process.argv.slice(2)))
