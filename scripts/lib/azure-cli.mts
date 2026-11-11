// Piezas comunes de los scripts del consumidor que operan Azure y GitHub por CLI: guard de repo
// consumidor, salida inyectable y lectura de lo que imprimen `az`, `gh` y `psql`.

import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CliError, repoRoot } from './cli.mts'
import type { CommandOptions, CommandResult } from './cli.mts'

export type Run = (command: string, args: string[], options?: CommandOptions) => CommandResult

/** Con `live` escribe en el proceso; sin el acumula en `stdout`, `stderr` y, en orden, `all`. */
export class Output {
  stdout = ''
  stderr = ''
  all = ''
  readonly live: boolean

  constructor(live = false) {
    this.live = live
  }

  out(line: string): void {
    this.writeOut(`${line}\n`)
  }

  err(line: string): void {
    this.writeErr(`${line}\n`)
  }

  writeOut(text: string): void {
    if (text.length === 0) return
    if (this.live) process.stdout.write(text)
    else {
      this.stdout += text
      this.all += text
    }
  }

  writeErr(text: string): void {
    if (text.length === 0) return
    if (this.live) process.stderr.write(text)
    else {
      this.stderr += text
      this.all += text
    }
  }
}

/** Raiz real del repo consumidor de `cwd`; fuera de git aborta, y en el repo de Mefisto, con `refusal`. */
export function consumerRoot(cwd: string, refusal: string[]): string {
  const root = repoRoot(cwd)
  if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
  if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) throw new CliError(refusal.join('\n'))
  return realpathSync.native(resolve(root))
}

/** Termina con `status` sin mensaje, como `set -e` ante un comando que falla. */
export function exitWith(status: number | null): never {
  throw new CliError('', status ?? 1)
}

/** Imprime el `CliError` que lance `body` y devuelve su codigo de salida. */
export function exitCodeOf(output: Output, body: () => number): number {
  try {
    return body()
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) output.err(error.message)
    return error.exitCode
  }
}

/** Lo que deja `$(...)` de bash: la salida sin sus saltos de linea finales. */
export function chomp(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '')
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Palabras de una expansion sin comillas de bash. */
export function words(text: string): string[] {
  return text.split(/[ \t\r\n]+/).filter((word) => word.length > 0)
}

/** `jq -r '<ruta> // empty'`: vacio si el valor falta, es `null` o `false`, o la ruta no aplica. */
export function rawField(value: unknown, ...path: string[]): string {
  let current: unknown = value
  for (const key of path) {
    if (current === null || current === undefined) return ''
    if (typeof current !== 'object' || Array.isArray(current)) return ''
    current = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : null
  }
  if (current === null || current === undefined || current === false) return ''
  return typeof current === 'string' ? current : JSON.stringify(current, null, 2)
}

/** `null` si `text` no es un unico valor JSON. */
export function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return null
  }
}
