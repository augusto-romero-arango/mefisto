// Salida de un pipeline: mensajes a pantalla con color, su copia sin color en el archivo de log,
// el aborto con la cola del log y los comandos cuya salida va al log.
//
// Los mensajes se imprimen literales. El bash los pasaba por `echo -e`, que interpretaba las
// barras invertidas del propio mensaje: aqui una ruta de Windows quedaria irreconocible.

import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readFileSync, statSync } from 'node:fs'

import type { Run } from '../azure-cli.mts'
import { COLOR, spawnTarget } from '../cli.mts'
import type { CommandOptions } from '../cli.mts'
import { clockTime } from './agent-log.mts'
import { PipelineAbort } from './pipeline-exit.mts'

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** Marcas de cada tipo de mensaje; cambian entre pipelines. */
export interface LogGlyphs {
  success: string
  warn: string
  error: string
  /** Trazo a los lados de un encabezado. */
  rule: string
}

export const ASCII_GLYPHS: LogGlyphs = { success: 'v', warn: '!', error: 'x', rule: '--' }

export interface PipelineLogOptions {
  /** Archivo de log vigente; un pipeline lo cambia al fijar su ruta definitiva. */
  logFile: () => string
  /** Pantalla. */
  out: (text: string) => void
  now?: () => Date
  glyphs?: LogGlyphs
  /** Linea que va al archivo por cada mensaje; por defecto, la de pantalla sin color. */
  fileLine?: (kind: LogKind, message: string, clock: string) => string
}

export type LogKind = 'log' | 'success' | 'warn' | 'header'

export interface PipelineLog {
  readonly glyphs: LogGlyphs
  log(message: string): void
  success(message: string): void
  warn(message: string): void
  header(title: string): void
  /** Texto a pantalla, sin copia en el archivo. */
  print(text: string): void
  /** Texto tal cual al archivo, sin pasar por pantalla. No poder escribirlo no detiene al pipeline. */
  append(text: string): void
  logFile(): string
}

/** Agrega `text` a `file`; `false` si no se pudo escribir. */
export function appendText(file: string, text: string): boolean {
  try {
    appendFileSync(file, text)
    return true
  } catch {
    return false
  }
}

export function createPipelineLog(options: PipelineLogOptions): PipelineLog {
  const glyphs = options.glyphs ?? ASCII_GLYPHS
  const now = options.now ?? ((): Date => new Date())
  const append = (text: string): void => void appendText(options.logFile(), text)
  const emit = (kind: LogKind, message: string, render: (clock: string) => string): void => {
    const clock = clockTime(now())
    const line = render(clock)
    options.out(`${line}\n`)
    append(`${options.fileLine?.(kind, message, clock) ?? stripAnsi(line)}\n`)
  }
  return {
    glyphs,
    log: (message) => emit('log', message, (clock) => `${COLOR.blue}[${clock}]${COLOR.reset} ${message}`),
    success: (message) => emit('success', message, () => `${COLOR.green}${COLOR.bold}${glyphs.success}${COLOR.reset} ${message}`),
    warn: (message) => emit('warn', message, () => `${COLOR.yellow}${glyphs.warn}${COLOR.reset} ${message}`),
    header: (title) =>
      emit('header', title, () => `\n${COLOR.cyan}${COLOR.bold}${glyphs.rule} ${title} ${glyphs.rule}${COLOR.reset}`),
    print: (text) => options.out(text),
    append,
    logFile: options.logFile,
  }
}

/** Ultimas `count` lineas de `text`, como `tail -n`: el salto final no cuenta como linea. */
export function lastLines(text: string, count: number): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count).join('\n')
}

/**
 * Las ultimas `count` lineas de `logFile` sin color, bajo su encabezado y sin salto final, para
 * que la causa de un fallo externo viaje junto al aborto. Vacio si el log falta o esta vacio.
 */
export function tailLogForAbort(logFile: string, count: number): string {
  let content: string
  try {
    if (statSync(logFile).size === 0) return ''
    content = readFileSync(logFile, 'utf8')
  } catch {
    return ''
  }
  const tail = stripAnsi(lastLines(content, count)).replace(/\n+$/, '')
  if (tail.length === 0) return ''
  return `${COLOR.yellow}Ultimas ${count} lineas del log:${COLOR.reset}\n${tail}`
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export interface AbortOptions {
  log: PipelineLog
  /** Lineas del log que se reemiten con el aborto; 0 no reemite. */
  tailLines?: number
  /** Worktree de la corrida, o vacio si aun no existe. */
  worktree: () => string
  /** Corre antes de imprimir nada: el pipeline anota aqui que esta abortando. */
  onStart?: (message: string, state: string) => void
  /** Corre al final: deja el fallo en el status y en el historial. */
  record?: (message: string, state: string) => void
  /** Destino de lo que no va al log; por defecto, la pantalla del log. */
  stream?: (text: string) => void
  /** `false` imprime el error sin la linea en blanco que lo precede en el log. */
  leadingBlankLine?: boolean
  /** `false` omite la linea `Para inspeccionar: cd <worktree>`. */
  inspectHint?: boolean
  /** Error en pantalla y su anotacion en el log; por defecto, el mismo texto `x ERROR: ...` con color en los dos. */
  render?: (message: string) => { stream: string; file: string }
  /** `false` omite la ruta del log, su cola y donde queda el worktree. */
  details?: boolean
}

/** `state` es el estado final que registra el pipeline (`failed` si no se indica). */
export type Abort = (message: string, state?: string) => never

/**
 * Aborto de un pipeline: imprime el error (que tambien va al log, con color), la ruta del log,
 * su cola y donde queda el worktree; registra el fallo y lanza `PipelineAbort`.
 */
export function createAbort(options: AbortOptions): Abort {
  const { log } = options
  const stream = options.stream ?? ((text: string): void => log.print(text))
  return (message, state = 'failed') => {
    options.onStart?.(message, state)
    const details = options.details ?? true
    // La cola se lee antes de anotar el error: despues solo repetiria el mensaje recien impreso.
    const tail = details && (options.tailLines ?? 0) > 0 ? tailLogForAbort(log.logFile(), options.tailLines ?? 0) : ''
    const error = `\n${COLOR.red}${COLOR.bold}${log.glyphs.error} ERROR: ${message}${COLOR.reset}\n`
    const rendered = options.render?.(message) ?? {
      stream: options.leadingBlankLine === false ? error.slice(1) : error,
      file: error,
    }
    stream(rendered.stream)
    log.append(rendered.file)
    if (!details) {
      options.record?.(message, state)
      throw new PipelineAbort(message)
    }
    stream(`${COLOR.yellow}Revisa el log: ${log.logFile()}${COLOR.reset}\n`)
    if (tail.length > 0) stream(`${tail}\n`)
    const worktree = options.worktree()
    if (worktree.length > 0 && isDirectory(worktree)) {
      stream(`${COLOR.yellow}El worktree queda en: ${worktree}${COLOR.reset}\n`)
      if (options.inspectHint !== false) stream(`${COLOR.yellow}Para inspeccionar: cd ${worktree}${COLOR.reset}\n`)
    }
    options.record?.(message, state)
    throw new PipelineAbort(message)
  }
}

/** Corre un programa con su salida estandar y de error anexadas a `logFile`; devuelve su codigo. */
export type LoggedRun = (command: string, args: string[], logFile: string, options?: CommandOptions) => number | null

/** `LoggedRun` sobre un proceso real, sin shell: la salida llega al log en el orden en que se emite. */
export const runLogged: LoggedRun = (command, args, logFile, options = {}) => {
  let log: number
  try {
    log = openSync(logFile, 'a')
  } catch {
    return 1
  }
  try {
    const target = spawnTarget(command, args, options.env ?? process.env)
    const result = spawnSync(target.command, target.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', log, log],
      windowsHide: true,
      windowsVerbatimArguments: target.verbatim,
    })
    return result.status
  } finally {
    closeSync(log)
  }
}

/** `LoggedRun` sobre un `run` que captura: anexa la salida estandar y despues la de error. */
export function loggedThrough(run: Run): LoggedRun {
  return (command, args, logFile, options) => {
    const result = run(command, args, options)
    appendText(logFile, result.stdout + result.stderr)
    return result.status
  }
}
