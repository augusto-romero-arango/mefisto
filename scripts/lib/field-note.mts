// Entrega de una field note por PR desde un worktree aislado del checkout principal.
//
// La usan `scripts/field-note.mts` (repo consumidor) y `src/internal/scripts/mefisto-field-note.mts`
// (repo de Mefisto). Cada uno decide el orden de sus pasos y como resuelve el PR.

import { mkdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CliError, capture, commandExists } from './cli.mts'
import type { CommandResult } from './cli.mts'

/** Lo que el script toca fuera de si mismo; los tests lo sustituyen. */
export interface Tools {
  run(command: string, args: string[], cwd: string): CommandResult
  has(command: string): boolean
  out(text: string): void
  err(text: string): void
}

export const SYSTEM_TOOLS: Tools = {
  run: (command, args, cwd) => capture(command, args, { cwd }),
  has: (command) => commandExists(command),
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
}

/** Corre `body` y traduce un `CliError` a su mensaje en stderr y su codigo de salida. */
export function exitCodeOf(tools: Tools, body: () => number): number {
  try {
    return body()
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) tools.err(`${error.message}\n`)
    return error.exitCode
  }
}

/** Lee pares `--flag valor`. Con `-h` lanza el uso con codigo 0; ante un error, el error seguido del uso. */
export function parseFlags(argv: string[], flags: readonly string[], usage: string): Map<string, string> {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? ''
    if (flag === '-h' || flag === '--help') throw new CliError(usage, 0)
    if (!flags.includes(flag)) throw new CliError(`ERROR: argumento desconocido '${flag}'\n${usage}`)
    const value = argv[i + 1]
    if (value === undefined) throw new CliError(`ERROR: ${flag} requiere un valor\n${usage}`)
    values.set(flag, value)
  }
  return values
}

// El valor compone una ruta y un nombre de rama: fuera de este alfabeto podria escapar del
// directorio de field notes o colarse como argumento de git o gh.
export function validateSlug(value: string, label: string, max: number): void {
  if (value.startsWith('-')) throw new CliError(`ERROR: ${label} '${value}' no puede empezar con '-'`)
  if (/[^A-Za-z0-9_-]/.test(value)) {
    throw new CliError(
      `ERROR: ${label} '${value}' es invalido: solo se permiten letras, digitos, '-' y '_'`,
    )
  }
  if (value.length > max) throw new CliError(`ERROR: ${label} '${value}' supera ${max} caracteres`)
}

export function validateTimestamp(value: string): void {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$/.test(value)) {
    throw new CliError(
      `ERROR: --timestamp '${value}' es invalido: se espera el formato YYYY-MM-DD-HHMM`,
    )
  }
}

export function requireCommands(tools: Tools, commands: readonly string[]): void {
  for (const command of commands) {
    if (!tools.has(command)) throw new CliError(`ERROR: '${command}' no esta disponible en PATH`)
  }
}

/** Quita los saltos de linea finales, como hace `$(cat)`. */
export function trimTrailingNewlines(content: Buffer): Buffer {
  let end = content.length
  while (end > 0 && content[end - 1] === 0x0a) end--
  return content.subarray(0, end)
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export type PullRequest = Record<string, unknown>

/** PRs de la salida de `gh pr list --json`; una salida que no es una lista cuenta como vacia. */
export function parsePrList(json: string): PullRequest[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((pr: unknown) =>
    typeof pr === 'object' && pr !== null && !Array.isArray(pr) ? (pr as PullRequest) : {},
  )
}

/** Campo de un PR como texto; lo ausente y `null` son la cadena `null`. */
export function prField(pr: PullRequest, key: string): string {
  const value = pr[key]
  if (value === undefined || value === null) return 'null'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function isMerged(pr: PullRequest): boolean {
  const mergedAt = prField(pr, 'mergedAt')
  return prField(pr, 'state') === 'MERGED' || (mergedAt.length > 0 && mergedAt !== 'null')
}

export type Checkpoint = 'inicio' | 'worktree' | 'commit' | 'push' | 'pr'

export interface DeliveryOptions {
  tools: Tools
  /** Carpeta desde la que se invoco el script. */
  cwd: string
  /** Raiz del checkout principal. */
  root: string
  sessionId: string
  docBranch: string
  /** Flags que identifican la sesion, como se le nombran a quien reintenta. */
  retryFlags: string
  /** Criterio de aceptacion con que el script nombra el invariante del checkout principal. */
  invariant: string
  /** Lo que se violaria al reanudar en el checkout principal, en palabras del script. */
  isolation: string
}

/** Lo que dejo una entrega anterior de la misma sesion. */
export interface PreviousDelivery {
  /** Worktree ya registrado para la rama documental, o vacio. */
  worktree: string
  localBranch: boolean
  remoteBranch: boolean
}

export interface CommitOptions {
  /** Ruta de la field note dentro del repo. */
  rel: string
  message: string
  /** Como se nombra la nota al decir que ya esta en la rama base. */
  noteInBase: string
  /** Complemento de "el contenido" en los mensajes de amend; puede ir vacio. */
  subject: string
  /** Que sigue staged si el commit falla. */
  staged: string
}

export interface CommandOutput {
  ok: boolean
  status: number | null
  /** stdout sin los saltos de linea finales. */
  value: string
}

interface CheckoutState {
  ref: string
  sha: string
  status: string
}

const NEWLINE = Buffer.from('\n')

export class FieldNoteDelivery {
  readonly tools: Tools
  readonly cwd: string
  readonly root: string
  readonly sessionId: string
  readonly docBranch: string
  readonly retryFlags: string
  readonly invariant: string
  readonly isolation: string
  defaultBranch = ''
  worktreeDir = ''
  commitSha = ''
  /** Ultimo paso confirmado; el mensaje de un aborto lo cita. */
  checkpoint: Checkpoint = 'inicio'
  private worktreeRegistered = false
  private initial: CheckoutState = { ref: '', sha: '', status: '' }

  constructor(options: DeliveryOptions) {
    this.tools = options.tools
    this.cwd = options.cwd
    this.root = options.root
    this.sessionId = options.sessionId
    this.docBranch = options.docBranch
    this.retryFlags = options.retryFlags
    this.invariant = options.invariant
    this.isolation = options.isolation
  }

  say(line: string): void {
    this.tools.out(`${line}\n`)
  }

  /** Corre el comando y deja pasar su salida. */
  show(command: string, args: string[]): boolean {
    const result = this.tools.run(command, args, this.cwd)
    if (result.stdout.length > 0) this.tools.out(result.stdout)
    if (result.stderr.length > 0) this.tools.err(result.stderr)
    return result.status === 0
  }

  /** Captura stdout como valor; stderr pasa, para que un aviso del comando no contamine el valor. */
  read(command: string, args: string[]): CommandOutput {
    const result = this.tools.run(command, args, this.cwd)
    if (result.stderr.length > 0) this.tools.err(result.stderr)
    return output(result)
  }

  quiet(command: string, args: string[]): CommandOutput {
    return output(this.tools.run(command, args, this.cwd))
  }

  /** Aborta nombrando el paso que fallo, el ultimo checkpoint confirmado y como recuperarse. */
  abort(step: string, action: string): never {
    throw new CliError(
      [
        `ERROR: fallo en el paso '${step}' de la entrega de la field note (sesion '${this.sessionId}')`,
        `Ultimo checkpoint confirmado: ${this.checkpoint}`,
        `Accion de recuperacion: ${action}`,
      ].join('\n'),
    )
  }

  /**
   * Corre `body` y, termine como termine, limpia el worktree y exige que ref, SHA y status del
   * checkout principal sean los del arranque; si cambiaron, el codigo de salida es 1.
   */
  run(body: () => void): number {
    const git = ['-C', this.root]
    const ref = this.read('git', [...git, 'symbolic-ref', '-q', '--short', 'HEAD']).value
    const sha = this.read('git', [...git, 'rev-parse', 'HEAD'])
    if (!sha.ok) throw new CliError('ERROR: no se pudo resolver HEAD del checkout principal')
    const status = this.read('git', [...git, 'status', '--porcelain=v1', '--untracked-files=all']).value
    this.initial = { ref, sha: sha.value, status }

    let exitCode = 0
    try {
      body()
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      if (error.message.length > 0) this.tools.err(`${error.message}\n`)
      exitCode = error.exitCode
    } finally {
      this.cleanupWorktree()
      if (!this.checkoutUnchanged()) exitCode = 1
    }
    return exitCode
  }

  // Un worktree con cambios sin commitear se conserva: puede ser la unica copia de la nota.
  private cleanupWorktree(): void {
    const dir = this.worktreeDir
    if (dir.length === 0 || !isDirectory(dir)) return
    if (!this.worktreeRegistered) {
      try {
        rmdirSync(dir)
      } catch {
        // Solo se borra si quedo vacio.
      }
      return
    }
    const status = this.quiet('git', ['-C', dir, 'status', '--porcelain=v1', '--untracked-files=all']).value
    if (status.length === 0) {
      this.quiet('git', ['-C', this.root, 'worktree', 'remove', dir])
    } else {
      this.tools.err(
        `AVISO: el worktree '${dir}' conserva cambios sin commitear; no se elimina. Status:\n${status}\n`,
      )
    }
  }

  private checkoutUnchanged(): boolean {
    const git = ['-C', this.root]
    const before = this.initial
    const now: CheckoutState = {
      ref: this.read('git', [...git, 'symbolic-ref', '-q', '--short', 'HEAD']).value,
      sha: this.quiet('git', [...git, 'rev-parse', 'HEAD']).value,
      status: this.quiet('git', [...git, 'status', '--porcelain=v1', '--untracked-files=all']).value,
    }
    if (now.ref === before.ref && now.sha === before.sha && now.status === before.status) return true
    this.tools.err(
      [
        `ERROR: el checkout principal cambio durante la entrega de la field note (invariante ${this.invariant} violado)`,
        `  ref:    inicial='${before.ref}' actual='${now.ref}'`,
        `  sha:    inicial='${before.sha}' actual='${now.sha}'`,
        `  status: inicial='${before.status}' actual='${now.status}'`,
        '',
      ].join('\n'),
    )
    return false
  }

  /** Trae la rama base y busca la rama documental de esta sesion: en un worktree, local o en origin. */
  locatePrevious(): PreviousDelivery {
    const { root, docBranch, defaultBranch } = this
    const git = ['-C', root]
    if (!this.show('git', [...git, 'fetch', 'origin', defaultBranch])) {
      this.abort(
        'worktree',
        `'git fetch origin ${defaultBranch}' fallo; verifica conectividad de red y credenciales de git, luego reintenta con los mismos ${this.retryFlags}.`,
      )
    }

    // `git worktree list` cuenta el checkout principal como un worktree mas: sin este corte la
    // entrega se reanudaria, y commitearia, dentro de el.
    if (this.initial.ref.length > 0 && this.initial.ref === docBranch) {
      this.abort(
        'worktree',
        `La rama documental '${docBranch}' esta checkouteada en el CHECKOUT PRINCIPAL ('${root}'); reanudar ahi violaria ${this.isolation}. Cambia ese checkout a su rama de trabajo habitual ('git -C ${root} switch <rama>', preservando lo que tengas sin commitear) y reintenta con los mismos ${this.retryFlags}.`,
      )
    }

    let worktree = worktreePathOf(
      this.read('git', [...git, 'worktree', 'list', '--porcelain']).value,
      docBranch,
    )
    if (worktree.length > 0 && !isDirectory(worktree)) {
      this.quiet('git', [...git, 'worktree', 'prune'])
      worktree = ''
    }
    const localBranch = this.show('git', [...git, 'show-ref', '--verify', '--quiet', `refs/heads/${docBranch}`])
    // Con refspec explicito: sin el, el fetch solo actualiza FETCH_HEAD y `origin/<rama>` no resuelve.
    const remoteBranch = this.quiet('git', [
      ...git,
      'fetch',
      'origin',
      `refs/heads/${docBranch}:refs/remotes/origin/${docBranch}`,
    ]).ok
    return { worktree, localBranch, remoteBranch }
  }

  /** Reutiliza el worktree de la sesion o monta uno nuevo en la carpeta que entrega `makeTempDir`. */
  mountWorktree(previous: PreviousDelivery, makeTempDir: () => string): void {
    const { root, docBranch, defaultBranch } = this
    if (previous.worktree.length > 0) {
      this.worktreeDir = previous.worktree
      this.say(`Worktree existente de una entrega previa de esta sesion reutilizado: ${this.worktreeDir}`)
    } else {
      try {
        this.worktreeDir = makeTempDir()
      } catch {
        throw new CliError('ERROR: no se pudo crear el directorio temporal del worktree')
      }
      const dir = this.worktreeDir
      let args: string[]
      let action: string
      if (previous.localBranch) {
        args = [dir, docBranch]
        action = `La rama '${docBranch}' ya existe localmente pero 'git worktree add' fallo; revisa 'git -C ${root} worktree list' y 'git -C ${root} branch -vv', corre 'git -C ${root} worktree prune' si hay entradas huerfanas y reintenta con los mismos flags.`
      } else if (previous.remoteBranch) {
        args = ['-b', docBranch, dir, `origin/${docBranch}`]
        action = `La rama '${docBranch}' existe en origin pero no localmente y 'git worktree add' fallo; verifica conectividad de red y reintenta con los mismos flags.`
      } else {
        args = ['-b', docBranch, dir, `origin/${defaultBranch}`]
        action = `Esta es la primera entrega de la sesion y 'git worktree add' fallo; revisa que 'origin/${defaultBranch}' exista (git -C ${root} fetch origin ${defaultBranch}) y reintenta.`
      }
      if (!this.show('git', ['-C', root, 'worktree', 'add', ...args])) this.abort('worktree', action)
    }
    this.worktreeRegistered = true
    this.checkpoint = 'worktree'
  }

  /** Escribe `content` mas un salto de linea en `rel`, dentro del worktree. */
  writeFile(rel: string, content: Buffer): void {
    const dir = this.worktreeDir
    const path = join(dir, ...rel.split('/'))
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      this.abort(
        'worktree',
        `No se pudo crear el directorio de '${rel}' dentro de '${dir}'; revisa permisos de disco y reintenta.`,
      )
    }
    try {
      writeFileSync(path, Buffer.concat([content, NEWLINE]))
    } catch {
      this.abort(
        'worktree',
        `No se pudo escribir '${dir}/${rel}'; revisa espacio/permisos de disco y reintenta.`,
      )
    }
  }

  /** `what` nombra lo que se agrega: "de la field note", "del glosario". */
  stage(rel: string, what: string): void {
    const dir = this.worktreeDir
    if (!this.show('git', ['-C', dir, 'add', '--', rel])) {
      this.abort(
        'worktree',
        `'git add' ${what} fallo en '${dir}'; revisa 'git -C ${dir} status' y reintenta.`,
      )
    }
  }

  /**
   * Lineas del status del worktree que no son el alta o la modificacion staged de `expected`.
   * Compara la linea entera: un rename hacia la ruta o una ruta que la contenga no se confunden con ella.
   */
  unexpectedChanges(expected: string[]): string[] {
    const status = this.read('git', [
      '-C',
      this.worktreeDir,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]).value
    const allowed = new Set(expected.flatMap((rel) => [`A  ${rel}`, `M  ${rel}`]))
    return status.split('\n').filter((line) => line.length > 0 && !allowed.has(line))
  }

  /** Crea el commit, reutiliza el que ya existe o lo actualiza con `--amend`. */
  commit(options: CommitOptions): void {
    const dir = this.worktreeDir
    const git = ['-C', dir]
    const headHasNote = this.quiet('git', [...git, 'cat-file', '-e', `HEAD:${options.rel}`]).ok
    // Si HEAD es todavia la punta de la rama base (entrega previa ya mergeada, rama borrada en
    // origin), la nota que trae no es un commit de esta sesion: un amend reescribiria uno ajeno.
    const headIsBase = this.quiet('git', [
      ...git,
      'merge-base',
      '--is-ancestor',
      'HEAD',
      `origin/${this.defaultBranch}`,
    ]).ok

    if (this.show('git', [...git, 'diff', '--cached', '--quiet'])) {
      if (headHasNote && headIsBase) {
        this.say(
          `Commit ya existente reutilizado: ${options.noteInBase} ya esta en '${this.defaultBranch}' con este mismo contenido (entrega previa ya mergeada)`,
        )
      } else if (headHasNote) {
        this.say('Commit ya existente de esta sesion reutilizado (contenido identico, no se creo uno nuevo)')
      } else {
        this.abort(
          'commit',
          `El worktree en '${dir}' quedo sin cambios staged pero HEAD tampoco tiene '${options.rel}' -- estado inconsistente. Inspecciona 'git -C ${dir} log --oneline' y 'git -C ${dir} status' a mano antes de reintentar.`,
        )
      }
    } else if (headHasNote && !headIsBase) {
      if (!this.show('git', [...git, 'commit', '--amend', '--no-edit'])) {
        this.abort(
          'commit',
          `'git commit --amend' fallo en '${dir}' al actualizar el contenido${options.subject} de una entrega previa; revisa 'git -C ${dir} status' (el commit anterior sigue intacto) y reintenta.`,
        )
      }
      this.say(
        `Commit existente de esta sesion actualizado via --amend (el contenido${options.subject} cambio respecto al intento anterior)`,
      )
    } else if (!this.show('git', [...git, 'commit', '-m', options.message])) {
      this.abort(
        'commit',
        `'git commit' del worktree documental fallo en '${dir}'; revisa 'git -C ${dir} status' (${options.staged}) y reintenta.`,
      )
    }
    this.commitSha = this.read('git', [...git, 'rev-parse', 'HEAD']).value
    this.checkpoint = 'commit'
  }

  // `--force-with-lease` no hace nada si origin ya tiene este commit y hace falta tras un amend.
  // La rama documental solo la empuja esta sesion.
  push(): void {
    const dir = this.worktreeDir
    if (!this.show('git', ['-C', dir, 'push', '--force-with-lease', '-u', 'origin', this.docBranch])) {
      this.abort(
        'push',
        `'git push --force-with-lease' de '${this.docBranch}' fallo; el commit ${this.commitSha} sigue disponible localmente en '${dir}' (o reanudable con los mismos ${this.retryFlags}). Revisa conectividad de red, permisos del remoto y reintenta.`,
      )
    }
    this.checkpoint = 'push'
  }
}

function output(result: CommandResult): CommandOutput {
  return {
    ok: result.status === 0,
    status: result.status,
    value: result.stdout.replace(/[\r\n]+$/, ''),
  }
}

/** Ruta del worktree que tiene `branch`, segun `git worktree list --porcelain`; vacio si ninguno. */
export function worktreePathOf(porcelain: string, branch: string): string {
  const wanted = `refs/heads/${branch}`
  let current = ''
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (line.startsWith('branch ') && line.split(/\s+/)[1] === wanted) return current
  }
  return ''
}
