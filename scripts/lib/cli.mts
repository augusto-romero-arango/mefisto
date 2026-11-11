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

const BATCH_FILE = /\.(cmd|bat)$/i
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  // Fuera de `process.env`, las claves de Windows conservan su grafia (`Path`, `PathExt`).
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/** Ruta del archivo al que resuelve `command` en el PATH (como `command -v`), o `null`. */
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const extensions =
    platform === 'win32' ? ['', ...(envValue(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';')] : ['']
  const isFile = (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isFile()
  const firstMatch = (base: string): string | null =>
    extensions.map((extension) => base + extension).find(isFile) ?? null
  if (/[\\/]/.test(command)) return firstMatch(command)
  for (const dir of (envValue(env, 'PATH') ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const match = firstMatch(join(dir, command))
    if (match !== null) return match
  }
  return null
}

/**
 * Argumento listo para una linea de `cmd.exe` que invoca un `.cmd` o `.bat`. Lleva dos niveles
 * de escape porque el archivo vuelve a interpretar la linea al reenviar `%*`. Un argumento con
 * un par de `%` no sobrevive: dentro del archivo se expande como variable.
 */
export function escapeBatchArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

interface SpawnTarget {
  command: string
  args: string[]
  verbatim: boolean
}

// Un `.cmd` o `.bat` (en Windows, `az` lo es) no se puede lanzar sin `cmd.exe`.
export function spawnTarget(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== 'win32') return { command, args, verbatim: false }
  const resolved = resolveCommand(command, env, platform)
  if (resolved === null || !BATCH_FILE.test(resolved)) return { command, args, verbatim: false }
  const line = [resolved.replace(CMD_META, '^$1'), ...args.map(escapeBatchArgument)].join(' ')
  return {
    command: envValue(env, 'ComSpec') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  }
}

/** Corre un programa con lista de argumentos, sin shell, y captura su salida. */
export function capture(command: string, args: string[], options: CommandOptions = {}): CommandResult {
  const target = spawnTarget(command, args, options.env ?? process.env)
  const result = spawnSync(target.command, target.args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsVerbatimArguments: target.verbatim,
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
  return resolveCommand(command, env) !== null
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
