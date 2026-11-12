// Piezas comunes de los orquestadores con cola (`batch-pipeline.mts` y `parallel-pipeline.mts`):
// clausura del runtime, senal de parada suave, lanzamiento de los pipelines hijos y formato de
// sus resumenes.

import type { ChildProcess, StdioOptions } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'

import { COLOR, launch } from '../cli.mts'
import { toNumber } from '../jq-values.mts'
import type { LogGlyphs } from './pipeline-log.mts'

export const ORCHESTRATOR_GLYPHS: LogGlyphs = { success: '✓', warn: '⚠', error: '✗', rule: '──' }

/**
 * Senal de parada suave (MEF-ADR-0017): archivo de mera presencia, relativo a la raiz del
 * checkout, que `/batch-stop` escribe y el orquestador consume al detenerse.
 */
export const BATCH_STOP_SIGNAL = 'pipeline-state/batch-stop'

export function batchStopPath(root: string): string {
  return join(root, 'pipeline-state', 'batch-stop')
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `touch`: crea el archivo vacio si falta, sin truncarlo si existe. */
export function touch(file: string): void {
  appendFileSync(file, '')
}

/** Lineas de `file` como las cuenta `wc -l` (saltos de linea); 0 si no se puede leer. */
export function lineCount(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').length - 1
  } catch {
    return 0
  }
}

/** Reescribe `file` entero via un temporal; un fallo deja el archivo anterior sin avisar. */
export function writeAtomic(file: string, text: string): void {
  try {
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  } catch {
    // El estado del lote es informativo: no poder escribirlo no detiene la cola.
  }
}

/** `tonumber? // .` de jq. */
export function numberOrText(text: string): number | string {
  try {
    return toNumber(text)
  } catch {
    return text
  }
}

/** `printf '%-Ns'` de bash, que mide el ancho en bytes. */
export function padBytes(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - Buffer.byteLength(text)))
}

const PR_URL = /https:\/\/github\.com\/[^/\n]+\/[^/\n]+\/pull\/[0-9]+/

/** Primera URL de PR de GitHub en `text`, o vacia. */
export function firstPullRequestUrl(text: string): string {
  return PR_URL.exec(text)?.[0] ?? ''
}

/**
 * Comando de un pipeline hijo cuya ruta publica es `script` (`x-pipeline.sh`): su `x.mts` con
 * Node si existe; si no, el script tal cual, que requiere bash y no corre en Windows.
 */
export function childCommand(script: string): { command: string; args: string[] } {
  const typescript = script.replace(/\.sh$/, '.mts')
  if (typescript !== script && existsSync(typescript)) return { command: process.execPath, args: [typescript] }
  return { command: script, args: [] }
}

/** Codigo con que `wait` reporta a un hijo: el suyo, o 128 mas el numero de la senal que lo mato. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  const number = signal === null ? undefined : constants.signals[signal]
  return number === undefined ? 1 : 128 + number
}

export interface ChildRun {
  child: ChildProcess
  /** Codigo de salida al cerrarse el hijo y su salida. */
  done: Promise<number>
  /** `true` mientras el proceso no ha terminado (`kill -0`). */
  alive: () => boolean
}

export interface ChildOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: StdioOptions
  detached?: boolean
  /** Recibe el mensaje si el hijo no se pudo lanzar. */
  onLaunchError?: (message: string) => void
}

/** Lanza el pipeline hijo `script` con `args`, sin shell. */
export function launchChild(script: string, args: string[], options: ChildOptions): ChildRun {
  const target = childCommand(script)
  const child = launch(target.command, [...target.args, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
    ...(options.detached === true ? { detached: true } : {}),
  })
  let running = true
  const done = new Promise<number>((resolve) => {
    let settled = false
    const settle = (code: number): void => {
      running = false
      if (settled) return
      settled = true
      resolve(code)
    }
    child.on('exit', () => {
      running = false
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      options.onLaunchError?.(`${script}: ${error.message}`)
      settle(error.code === 'EACCES' ? 126 : 127)
    })
    child.on('close', (code, signal) => settle(exitStatus(code, signal)))
  })
  return { child, done, alive: () => running }
}

/**
 * Corre `script` con su salida estandar y de error copiadas a `onOutput` y anexadas a `logFile`,
 * como `script 2>&1 | tee -a logFile`. Devuelve su codigo de salida.
 */
export function runTeed(
  script: string,
  args: string[],
  logFile: string,
  options: Omit<ChildOptions, 'stdio'> & { onOutput: (text: string) => void },
): Promise<number> {
  const run = launchChild(script, args, {
    ...options,
    stdio: ['inherit', 'pipe', 'pipe'],
    onLaunchError: (message) => {
      options.onOutput(`${message}\n`)
      appendFileSync(logFile, `${message}\n`)
    },
  })
  const copy = (text: string): void => {
    options.onOutput(text)
    appendFileSync(logFile, text)
  }
  for (const stream of [run.child.stdout, run.child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', copy)
  }
  return run.done
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * La clausura publicada conserva `src/runtime` junto a `scripts/`. Devuelve el mensaje de error
 * para stderr, o `null` si esta completa.
 */
export function runtimeClosureError(scriptsDir: string): string | null {
  const runtimeDir = join(scriptsDir, '..', 'src', 'runtime')
  if (!isDirectory(runtimeDir)) return 'ERROR: no se encontro src/runtime junto al paquete publicado\n'
  if (!isFile(join(runtimeDir, 'lib', 'mefisto-runtime.mts'))) {
    return 'ERROR: no se encontro mefisto-runtime.mts en la clausura publicada\n'
  }
  return null
}

/** `✗ Dependencias faltantes: gh dotnet`, o `null` si estan todas. */
export function missingCommandsLine(commands: readonly string[], hasCommand: (command: string) => boolean): string | null {
  const missing = commands.filter((command) => !hasCommand(command))
  if (missing.length === 0) return null
  return `${COLOR.red}${COLOR.bold}✗ Dependencias faltantes:${missing.map((command) => ` ${command}`).join('')}${COLOR.reset}\n`
}

export const REQUIRED_COMMANDS: readonly string[] = ['gh', 'git', 'dotnet']
