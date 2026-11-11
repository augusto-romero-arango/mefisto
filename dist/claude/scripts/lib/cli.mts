// Utilidades comunes de los scripts: punto de entrada, procesos y mensajes.

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** `true` si el modulo con esta `import.meta.url` es el que Node esta ejecutando. */
export function isEntryPoint(metaUrl: string): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  // Node carga el punto de entrada por su ruta real.
  try {
    return pathToFileURL(realpathSync(entry)).href === metaUrl
  } catch {
    return false
  }
}

export interface CommandResult {
  /** Codigo de salida; `null` si el proceso no arranco o murio por una senal. */
  status: number | null
  stdout: string
  stderr: string
}

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
}

/** Corre un programa con lista de argumentos, sin shell, y captura su salida. */
export function capture(command: string, args: string[], options: CommandOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Salida de `git` sin el salto final, o `null` si falla. */
export function gitOutput(args: string[], cwd?: string): string | null {
  const result = capture('git', args, cwd === undefined ? {} : { cwd })
  return result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : null
}

/** Raiz del repo git que contiene `cwd`, o `null` si no hay repo. */
export function repoRoot(cwd: string = process.cwd()): string | null {
  const root = gitOutput(['rev-parse', '--show-toplevel'], cwd)
  return root === null || root.length === 0 ? null : root
}

/** `true` si `command` resuelve a un ejecutable del PATH (como `command -v`). */
export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const extensions =
    process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : ['']
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(dir, command + extension)
      if (existsSync(candidate) && statSync(candidate).isFile()) return true
    }
  }
  return false
}

const ESC = '\u001b['
export const COLOR = {
  red: `${ESC}0;31m`,
  green: `${ESC}0;32m`,
  yellow: `${ESC}1;33m`,
  blue: `${ESC}0;34m`,
  cyan: `${ESC}0;36m`,
  bold: `${ESC}1m`,
  reset: `${ESC}0m`,
} as const

/** Error cuyo mensaje ya esta listo para el usuario; el script lo imprime y termina en `exitCode`. */
export class CliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/** Ejecuta `main` y traduce un `CliError` a su mensaje en stderr y su codigo de salida. */
export function runMain(main: () => number | void): void {
  try {
    process.exitCode = main() ?? 0
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) console.error(error.message)
    process.exitCode = error.exitCode
  }
}
