// Worktree de una corrida: nombre de rama, creacion desde `origin/main`, reanudacion, deteccion
// del trabajo que dejo un agente, commit de seguridad y borrado al cerrar. Los textos de cada
// paso son parametros: cambian de un pipeline a otro.

import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { Run } from '../azure-cli.mts'
import type { Abort, LoggedRun, PipelineLog } from './pipeline-log.mts'

/**
 * Pathspec que excluye lo que escribe el propio pipeline en el worktree: el estado operativo, que
 * nunca se versiona. El trabajo del agente se detecta por exclusion, sin una lista de rutas
 * permitidas que mantener.
 */
export const PIPELINE_OWN_WRITES: readonly string[] = [':!.mefisto/pipeline']

/**
 * Slug del titulo de un issue para el nombre de su rama: minusculas, espacios como guiones, solo
 * `[a-z0-9-]`, sin guiones repetidos, 40 caracteres como maximo y sin guion final.
 */
export function issueSlug(title: string): string {
  return title
    .split('\n')
    .map((line) =>
      line
        .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
        .replaceAll(' ', '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .slice(0, 40)
        .replace(/-$/, ''),
    )
    .join('\n')
}

/** `worktree-issue-<num>-<slug>[-<variante>]`. */
export function issueBranchName(issue: string, slug: string, variant = ''): string {
  const branch = `worktree-issue-${issue}-${slug}`
  return variant.length > 0 ? `${branch}-${variant}` : branch
}

/** Worktree de `branch` bajo el estado del repo. */
export function pipelineWorktreePath(repoRoot: string, branch: string): string {
  return join(repoRoot, '.mefisto', 'pipeline', 'worktrees', branch)
}

/** Ubicacion anterior, al lado del repo: solo se usa para retomar una corrida vieja. */
export function legacyWorktreePath(repoRoot: string, branch: string): string {
  return resolve(repoRoot, '..', branch)
}

function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export interface WorktreeTools {
  run: Run
  runLogged: LoggedRun
  log: PipelineLog
  abort: Abort
  /** Directorio del repo principal desde el que corre el pipeline. */
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface WorktreeTexts {
  offMainBranch: (branch: string) => string
  fetching: string
  fetchFailed: string
  alreadyExists: (path: string) => string
  orphanBranch: (branch: string) => string
  creating: (path: string) => string
  createFailed: string
  created: (path: string) => string
  usingLegacy: (path: string) => string
  missing: (path: string, fromStage: string) => string
  resuming: (path: string, fromStage: string) => string
}

/** Textos del pipeline de tooling, en ASCII. */
export const WORKTREE_TEXTS: WorktreeTexts = {
  offMainBranch: (branch) => `cwd en rama '${branch}' (no main/master): el worktree se creara igual desde origin/main`,
  fetching: 'Actualizando origin/main...',
  fetchFailed: 'No se pudo hacer fetch de origin/main',
  alreadyExists: (path) => `El worktree ya existe: ${path} -- limpiando para reiniciar...`,
  orphanBranch: (branch) => `La rama ${branch} ya existe sin worktree -- eliminandola...`,
  creating: (path) => `Creando worktree: ${path} (base: origin/main)`,
  createFailed: 'No se pudo crear el worktree desde origin/main',
  created: (path) => `Worktree creado: ${path}`,
  usingLegacy: (path) => `Worktree no encontrado en la ruta nueva; usando el de la ruta anterior: ${path}`,
  missing: (path, fromStage) => `No existe el worktree en ${path}. No se puede retomar desde Stage ${fromStage}.`,
  resuming: (path, fromStage) => `Retomando desde Stage ${fromStage} -- worktree existente: ${path}`,
}

export interface WorktreeRequest {
  repoRoot: string
  branch: string
  /** Rama del directorio desde el que se lanzo el pipeline; solo informa. */
  currentBranch: string
  texts?: Partial<WorktreeTexts>
  /** Donde crear el worktree; por defecto, `pipelineWorktreePath`. */
  path?: string
  /** Corre tras limpiar la corrida anterior y antes de anunciar la creacion; puede abortar. */
  beforeCreate?: () => void
}

/**
 * Crea el worktree de `branch` desde `origin/main` recien traido, sea cual sea la rama del
 * directorio actual. Un worktree o una rama de una corrida anterior se eliminan antes. Aborta si
 * no puede traer `origin/main` o crear el worktree. Devuelve su ruta.
 */
export function createWorktree(request: WorktreeRequest, tools: WorktreeTools): string {
  const texts = { ...WORKTREE_TEXTS, ...request.texts }
  const { log, run, runLogged } = tools
  const options = { cwd: tools.cwd, ...(tools.env === undefined ? {} : { env: tools.env }) }
  const logged = (args: string[]): number | null => runLogged('git', args, log.logFile(), options)
  const path = request.path ?? pipelineWorktreePath(request.repoRoot, request.branch)

  if (request.currentBranch !== 'main' && request.currentBranch !== 'master') {
    log.warn(texts.offMainBranch(request.currentBranch))
  }
  log.log(texts.fetching)
  if (logged(['fetch', 'origin', 'main']) !== 0) tools.abort(texts.fetchFailed)

  if (isDirectory(path)) {
    log.warn(texts.alreadyExists(path))
    logged(['worktree', 'remove', '--force', path])
    logged(['branch', '-D', request.branch])
  }
  if (run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${request.branch}`], options).status === 0) {
    log.warn(texts.orphanBranch(request.branch))
    logged(['branch', '-D', request.branch])
  }

  request.beforeCreate?.()
  log.log(texts.creating(path))
  mkdirSync(dirname(path), { recursive: true })
  if (logged(['worktree', 'add', path, '-b', request.branch, 'origin/main']) !== 0) tools.abort(texts.createFailed)
  log.success(texts.created(path))
  return path
}

export interface ResumeRequest {
  repoRoot: string
  branch: string
  /** Stage desde el que se retoma, para los mensajes. */
  fromStage: string
  texts?: Partial<WorktreeTexts>
}

/**
 * Worktree ya existente de `branch`, para retomar una corrida: el del estado del repo o, si solo
 * existe ese, el de la ubicacion anterior. Aborta si no hay ninguno.
 */
export function resumeWorktree(request: ResumeRequest, tools: Pick<WorktreeTools, 'log' | 'abort'>): string {
  const texts = { ...WORKTREE_TEXTS, ...request.texts }
  let path = pipelineWorktreePath(request.repoRoot, request.branch)
  const legacy = legacyWorktreePath(request.repoRoot, request.branch)
  if (!isDirectory(path) && isDirectory(legacy)) {
    tools.log.log(texts.usingLegacy(legacy))
    path = legacy
  }
  if (!isDirectory(path)) tools.abort(texts.missing(path, request.fromStage))
  tools.log.log(texts.resuming(path, request.fromStage))
  return path
}

/** Borra el worktree al cerrar la corrida, desde la raiz del repo; `false` si git no pudo. */
export function removeWorktree(repoRoot: string, path: string, tools: Pick<WorktreeTools, 'runLogged' | 'log' | 'env'>): boolean {
  const options = { cwd: repoRoot, ...(tools.env === undefined ? {} : { env: tools.env }) }
  return tools.runLogged('git', ['worktree', 'remove', '--force', path], tools.log.logFile(), options) === 0
}

export interface GitQuery {
  run: Run
  env?: NodeJS.ProcessEnv
}

function git(query: GitQuery, worktree: string, args: string[]): { status: number | null; stdout: string } {
  return query.run('git', ['-C', worktree, ...args], query.env === undefined ? {} : { env: query.env })
}

/** `true` si `git status` reporta algo bajo `pathspec` (por defecto, todo menos lo del pipeline). */
export function hasPendingChanges(
  query: GitQuery,
  worktree: string,
  pathspec: readonly string[] = ['.', ...PIPELINE_OWN_WRITES],
): boolean {
  return chomp(git(query, worktree, ['status', '--porcelain', '--', ...pathspec]).stdout).length > 0
}

/** `true` si lo commiteado difiere entre `from` y `to`; un git que falla cuenta como diferencia. */
export function hasCommittedChanges(query: GitQuery, worktree: string, from: string, to = 'HEAD', pathspec: readonly string[] = []): boolean {
  const scope = pathspec.length > 0 ? ['--', ...pathspec] : []
  return git(query, worktree, ['diff', '--quiet', from, to, ...scope]).status !== 0
}

/** Rutas commiteadas desde `base` que casan con `pathspec`, una por linea. */
export function changedPaths(query: GitQuery, worktree: string, base: string, pathspec: readonly string[]): string {
  return chomp(git(query, worktree, ['diff', '--name-only', `${base}..HEAD`, '--', ...pathspec]).stdout)
}

export interface AutoCommitRequest {
  worktree: string
  message: string
  /** Lo que cuenta como trabajo sin commitear y lo que entra al commit. */
  pathspec: readonly string[]
  /** `git add -A`: tambien registra los borrados. */
  addAll?: boolean
  /** Corre cuando hay algo que commitear, antes de hacerlo. */
  onPending?: () => void
  /** Si `git add` falla no intenta el commit (`commitStatus` queda `null`). */
  stopOnAddFailure?: boolean
}

export interface AutoCommitResult {
  addStatus: number | null
  commitStatus: number | null
}

/**
 * Commit de seguridad de lo que el agente dejo sin commitear bajo `pathspec`. Devuelve `null` si
 * no habia nada, o los codigos de `git add` y `git commit`: cada pipeline decide si un fallo aborta.
 */
export function autoCommitIfNeeded(
  request: AutoCommitRequest,
  tools: Pick<WorktreeTools, 'run' | 'runLogged' | 'log' | 'env'>,
): AutoCommitResult | null {
  const query: GitQuery = { run: tools.run, ...(tools.env === undefined ? {} : { env: tools.env }) }
  if (!hasPendingChanges(query, request.worktree, request.pathspec)) return null
  request.onPending?.()
  const options = tools.env === undefined ? {} : { env: tools.env }
  const logged = (args: string[]): number | null =>
    tools.runLogged('git', ['-C', request.worktree, ...args], tools.log.logFile(), options)
  const addStatus = logged(['add', ...(request.addAll === true ? ['-A'] : []), '--', ...request.pathspec])
  if (addStatus !== 0 && request.stopOnAddFailure === true) return { addStatus, commitStatus: null }
  const commitStatus = logged(['commit', '-m', request.message])
  return { addStatus, commitStatus }
}
