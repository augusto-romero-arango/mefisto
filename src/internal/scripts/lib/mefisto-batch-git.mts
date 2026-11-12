// Operaciones de git y gh del batch interno: la raiz ejecutable aislada de cada eslabon, el gate
// de dependencias y el sync verificado de main tras cada merge.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Run } from '../../../../scripts/lib/azure-cli.mts'
import { forwardDependencies } from '../../../../scripts/lib/issue-dependencies.mts'
import type { LoggedRun } from '../../../../scripts/lib/pipeline/pipeline-log.mts'
import { remediateMainAfterRescue } from './mefisto-base-branch.mts'
import { chomp } from './mefisto-script-io.mts'

export interface BatchGit {
  /** Checkout lanzador: cwd de git y gh. */
  root: string
  env: NodeJS.ProcessEnv
  run: Run
  /** Comandos cuya salida va al log del batch. */
  runLogged: LoggedRun
  logFile: string
  warn: (message: string) => void
  sleep: (seconds: number) => Promise<void>
}

const capture = (ctx: BatchGit, command: string, args: string[]): { ok: boolean; text: string } => {
  const result = ctx.run(command, args, { cwd: ctx.root, env: ctx.env })
  return { ok: result.status === 0, text: chomp(result.stdout) }
}

const logged = (ctx: BatchGit, args: string[]): boolean => ctx.runLogged('git', args, ctx.logFile, { cwd: ctx.root, env: ctx.env }) === 0

/** Prefijo que `mefisto-worktree clean` reconoce: le sigue `<ts>-<pid>` del batch. */
export const EXECUTION_ROOT_PREFIX = 'mefisto-batch-execution-'

export function executionRootPath(root: string, timestamp: string, pid: number): string {
  return join(root, '.mefisto', 'worktrees', `${EXECUTION_ROOT_PREFIX}${timestamp}-${pid}`)
}

export interface ExecutionRoot {
  path: string
  sha: string
}

/**
 * Worktree detached en el SHA recien verificado de origin/main: writer y reviewer del eslabon
 * comparten maquinaria inmutable y el siguiente recibe la que su predecesor mergeo. Devuelve
 * `null` tras avisar si no se pudo.
 */
export function materializeExecutionRoot(issue: string, path: string, ctx: BatchGit): ExecutionRoot | null {
  if (!logged(ctx, ['-C', ctx.root, 'fetch', 'origin', 'main'])) {
    ctx.warn(`snapshot: git fetch origin main fallo antes del issue #${issue}`)
    return null
  }
  const verified = capture(ctx, 'git', ['-C', ctx.root, 'rev-parse', '--verify', 'origin/main^{commit}'])
  if (!verified.ok) {
    ctx.warn(`snapshot: no se pudo resolver el commit verificado de origin/main antes del issue #${issue}`)
    return null
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // Si falta la carpeta, `git worktree add` lo dice.
  }
  if (!logged(ctx, ['-C', ctx.root, 'worktree', 'add', '--detach', path, verified.text])) {
    ctx.warn(`snapshot: no se pudo materializar la raiz aislada ${path} en ${verified.text}`)
    return null
  }
  return { path, sha: verified.text }
}

/** `git worktree remove` es la unica limpieza: nunca reset, clean ni switch sobre el lanzador. */
export function removeExecutionRoot(path: string, ctx: Pick<BatchGit, 'root' | 'env' | 'run'>): void {
  ctx.run('git', ['-C', ctx.root, 'worktree', 'remove', '--force', path], { cwd: ctx.root, env: ctx.env })
}

export interface UnmetDependency {
  dependency: string
  reason: string
}

/**
 * Primera dependencia forward de `issue` no satisfecha, o `null`. Satisfecha es `completado*` en
 * este batch, o CLOSED (issue) / MERGED (PR) en GitHub; GitHub decide antes que el motivo del
 * batch, porque un eslabon que fallo despues de mergear deja su issue cerrado.
 */
export function unmetDependency(
  issue: string,
  statusOf: (issue: string) => string,
  ctx: Pick<BatchGit, 'root' | 'env' | 'run'>,
): UnmetDependency | null {
  const gh = (args: string[]): { ok: boolean; stdout: string } => {
    const result = ctx.run('gh', args, { cwd: ctx.root, env: ctx.env })
    return { ok: result.status === 0, stdout: result.stdout }
  }
  const body = chomp(gh(['issue', 'view', issue, '--json', 'body', '-q', '.body']).stdout)
  for (const dependency of forwardDependencies(body)) {
    if (dependency === issue) continue
    const status = statusOf(dependency)
    if (status.startsWith('completado')) continue
    const asIssue = gh(['issue', 'view', dependency, '--json', 'state', '-q', '.state'])
    let stateText = asIssue.stdout
    if (!asIssue.ok) stateText += gh(['pr', 'view', dependency, '--json', 'state', '-q', '.state']).stdout
    const state = chomp(stateText)
    if (state === 'CLOSED' || state === 'MERGED') continue
    if (status.startsWith('saltado') || status.startsWith('ERROR')) return { dependency, reason: 'fallido en este batch' }
    return { dependency, reason: state.length > 0 ? state : 'no consultable' }
  }
  return null
}

export interface SyncResult {
  /**
   * 0: origin/main y `mainBranch` local incluyen el merge. 1: solo fallo dejar `mainBranch` local
   * al dia (no fatal: el siguiente worktree nace de origin/main). 2: el merge no se confirmo en
   * origin/main (fatal: el siguiente eslabon naceria de una base vieja).
   */
  code: 0 | 1 | 2
  /** SHA del merge, en cuanto queda confirmado en origin/main; vacio con el codigo 2. */
  mergeSha: string
}

const ATTEMPTS = 3
const RETRY_SECONDS = 2

/**
 * Tras mergear `pr`, confirma que su commit de merge llego a origin/main y deja `mainBranch` local
 * fast-forwardeada. Opera sobre `mainBranch` por nombre, nunca sobre el HEAD del momento: otra
 * sesion pudo cambiar la rama activa del checkout mientras el batch corria.
 */
export async function syncMainAfterMerge(pr: string, mainBranch: string, ctx: BatchGit): Promise<SyncResult> {
  let mergeSha = ''
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    mergeSha = capture(ctx, 'gh', ['pr', 'view', pr, '--json', 'mergeCommit', '-q', '.mergeCommit.oid']).text
    if (mergeSha.length > 0 && mergeSha !== 'null') break
    await ctx.sleep(RETRY_SECONDS)
  }
  if (mergeSha.length === 0 || mergeSha === 'null') {
    ctx.warn(`sync: no se pudo determinar el commit de merge del PR #${pr}`)
    return { code: 2, mergeSha: '' }
  }

  if (!logged(ctx, ['fetch', 'origin', 'main'])) {
    ctx.warn('sync: git fetch origin main fallo')
    return { code: 2, mergeSha: '' }
  }

  // Lo que garantiza la cadena: el siguiente worktree nace de origin/main, no de main local.
  let present = false
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (capture(ctx, 'git', ['merge-base', '--is-ancestor', mergeSha, 'origin/main']).ok) {
      present = true
      break
    }
    await ctx.sleep(RETRY_SECONDS)
    logged(ctx, ['fetch', 'origin', 'main'])
  }
  if (!present) {
    ctx.warn(`sync: el commit de merge ${mergeSha} del PR #${pr} no aparece en origin/main`)
    return { code: 2, mergeSha: '' }
  }

  const activeBranch = (): string => capture(ctx, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).text
  const active = activeBranch()
  if (active !== mainBranch) {
    ctx.warn(
      `sync: la rama activa del repo cambio a '${active}' (se esperaba '${mainBranch}'); se actualiza '${mainBranch}' por nombre sin tocar la rama activa`,
    )
    // git rechaza este refspec solo cuando el destino es la rama activa, que aqui ya no lo es.
    if (!logged(ctx, ['fetch', 'origin', `main:${mainBranch}`])) {
      ctx.warn(`sync: no se pudo fast-forwardear '${mainBranch}' por nombre a origin/main (rama activa observada: '${activeBranch()}')`)
      return { code: 1, mergeSha }
    }
  } else if (!logged(ctx, ['merge', '--ff-only', 'origin/main'])) {
    const toplevel = capture(ctx, 'git', ['rev-parse', '--show-toplevel']).text
    const remediated = remediateMainAfterRescue(toplevel, mainBranch, 'origin/main', ctx.run)
    if (remediated === null) {
      ctx.warn(`sync: no se pudo fast-forwardear '${activeBranch()}' local a origin/main (posible divergencia local)`)
      return { code: 1, mergeSha }
    }
    ctx.warn(remediated)
  }

  if (!capture(ctx, 'git', ['merge-base', '--is-ancestor', mergeSha, mainBranch]).ok) {
    ctx.warn(`sync: el commit de merge ${mergeSha} no quedo en '${mainBranch}' tras el sync (rama activa observada: '${activeBranch()}')`)
    return { code: 1, mergeSha }
  }
  return { code: 0, mergeSha }
}
