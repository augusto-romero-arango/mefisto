// worktree-clean.mts -- Limpia los worktrees mergeados o abandonados del repo del consumidor
//
// Uso:
//   node scripts/worktree-clean.mts
//
// Recorre `git worktree list --porcelain` (menos el principal) y elimina el worktree
// y su rama local cuando:
//   - la rama esta mergeada en origin/main habiendo tenido commits propios, o
//   - su upstream esta [gone], o
//   - es una rama de pipeline (worktree-issue-N-, infra-issue-N-, scaffold-issue-N-)
//     sin commits fuera de origin/main y con el issue #N cerrado (sin gh, se conserva).
// Conserva, con aviso: cambios sin commitear, rama no mergeada y HEAD desacoplado.
// Solo usa `git worktree remove` y `git branch -D`; nunca mata procesos.

import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { capture, commandExists, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions, CommandResult } from './lib/cli.mts'

export interface CleanDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  hasCommand: (command: string) => boolean
  run: (command: string, args: string[], options?: CommandOptions) => CommandResult
  /** `git fetch --prune origin` en `mainRoot`, con toda su salida a stderr; `true` si termino bien. */
  fetch: (mainRoot: string) => boolean
  out: (line: string) => void
  err: (line: string) => void
}

const PIPELINE_BRANCH = /^(?:worktree|infra|scaffold)-issue-([0-9]+)-/

function chomp(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function samePath(a: string, realB: string): boolean {
  try {
    return realpathSync.native(a) === realB
  } catch {
    return a === realB
  }
}

// Rama de pipeline sin commits propios y con el issue #N cerrado. Sin gh, o si gh
// falla, se conserva.
function pipelineBranchAbandoned(deps: CleanDeps, mainRoot: string, base: string, branch: string): boolean {
  const issue = PIPELINE_BRANCH.exec(branch)?.[1]
  if (issue === undefined) return false
  const ahead = deps.run('git', [
    '-C',
    mainRoot,
    'rev-list',
    '--count',
    `origin/${base}..refs/heads/${branch}`,
  ])
  if (chomp(ahead.stdout) !== '0') return false
  if (!deps.hasCommand('gh')) return false
  const state = deps.run('gh', ['issue', 'view', issue, '--json', 'state', '-q', '.state'], {
    cwd: mainRoot,
  })
  return state.status === 0 && chomp(state.stdout) === 'CLOSED'
}

// Rama mergeada: punta en origin/main habiendo tenido commits propios (una rama
// recien creada tambien es ancestro y no debe borrarse), upstream [gone] o rama
// de pipeline abandonada.
function branchIsMerged(deps: CleanDeps, mainRoot: string, base: string, branch: string): boolean {
  const ref = `refs/heads/${branch}`
  const reflog = deps.run('git', ['-C', mainRoot, 'reflog', 'show', ref]).stdout
  const entries = reflog.split('\n').length - 1
  if (
    entries > 1 &&
    deps.run('git', ['-C', mainRoot, 'merge-base', '--is-ancestor', ref, `origin/${base}`]).status === 0
  ) {
    return true
  }
  const track = deps.run('git', ['-C', mainRoot, 'for-each-ref', '--format=%(upstream:track)', ref])
  if (chomp(track.stdout) === '[gone]') return true
  return pipelineBranchAbandoned(deps, mainRoot, base, branch)
}

export function cleanWorktrees(deps: CleanDeps): number {
  const configured = deps.env.BASE_BRANCH ?? ''
  const base = configured.length > 0 ? configured : 'main'
  const common = deps.run('git', ['rev-parse', '--git-common-dir'], { cwd: deps.cwd })
  if (common.status !== 0) {
    deps.err('ERROR: no estas dentro de un repositorio git')
    return 1
  }
  const mainRoot = dirname(realpathSync.native(resolve(deps.cwd, chomp(common.stdout))))

  // Sin refspec: con 'origin main', --prune solo poda origin/main y una rama
  // mergeada por squash nunca quedaria con upstream [gone].
  if (!deps.fetch(mainRoot)) {
    deps.err("ERROR: 'git fetch --prune origin' fallo; verifica la red y las credenciales")
    return 1
  }
  deps.run('git', ['-C', mainRoot, 'worktree', 'prune'])

  const listed = deps.run('git', ['-C', mainRoot, 'worktree', 'list', '--porcelain']).stdout
  const dirs = listed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))

  let removed = 0
  let kept = 0
  for (const dir of dirs) {
    if (samePath(dir, mainRoot) || !isDirectory(dir)) continue
    const head = deps.run('git', ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD'])
    const branch = head.status === 0 ? chomp(head.stdout) : ''
    if (branch.length === 0) {
      deps.err(`AVISO: '${dir}' sin rama (HEAD desacoplado); se conserva`)
      kept++
      continue
    }
    if (!branchIsMerged(deps, mainRoot, base, branch)) {
      deps.out(`Conservado (rama '${branch}' aun no mergeada en origin/${base}): ${dir}`)
      kept++
      continue
    }
    const status = chomp(
      deps.run('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all']).stdout,
    )
    if (status.length > 0) {
      deps.err(`AVISO: '${dir}' (rama '${branch}' mergeada) tiene cambios sin commitear; se conserva:`)
      deps.err(status)
      kept++
      continue
    }
    if (deps.run('git', ['-C', mainRoot, 'worktree', 'remove', dir]).status !== 0) {
      deps.err(`AVISO: no se pudo eliminar el worktree '${dir}'; se conserva`)
      kept++
      continue
    }
    deps.run('git', ['-C', mainRoot, 'branch', '-D', branch])
    deps.out(`Eliminado: ${dir} (rama '${branch}')`)
    removed++
  }
  deps.out(`Limpieza: ${removed} eliminados, ${kept} conservados`)
  return 0
}

function fetchToStderr(mainRoot: string): boolean {
  const result = spawnSync('git', ['-C', mainRoot, 'fetch', '--prune', 'origin'], {
    stdio: ['inherit', 2, 'inherit'],
  })
  return result.status === 0
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = cleanWorktrees({
    cwd: process.cwd(),
    env: process.env,
    hasCommand: commandExists,
    run: capture,
    fetch: fetchToStderr,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
