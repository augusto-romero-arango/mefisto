// Lo comun a los dos lanzadores de pipelines (`launch-pipeline.mts` y
// `mefisto-launch-pipeline.mts`): eleccion del modo de UI, entorno del pipeline desacoplado,
// lanzamiento sin terminal y delegacion en el script de herdr.

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, utimesSync, writeSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'

import { launch } from './cli.mts'

export const VALID_UI_MODES = "Modos validos: 'mod' (desacoplado, el default) y 'herdr' (panes, dentro de herdr)."

export const RETIRED_FLAGS_MESSAGE =
  '--attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5).'

export function hasRetiredFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--attach' || arg === '--if-exists')
}

/** `MEFISTO_UI` vacio o sin definir cuenta como no fijado, igual que `${MEFISTO_UI:-}`. */
export function uiMode(env: NodeJS.ProcessEnv): string {
  return env.MEFISTO_UI ?? ''
}

export function isValidUiMode(env: NodeJS.ProcessEnv): boolean {
  return ['', 'mod', 'herdr'].includes(uiMode(env))
}

/**
 * Con el runtime claude y sin `MEFISTO_UI`, la cinta de la propia sesion es el visor y no se
 * abre pane (MEF-ADR-0055); `MEFISTO_UI=mod` tambien lo pide.
 */
export function usesDetachedUi(env: NodeJS.ProcessEnv): boolean {
  const ui = uiMode(env)
  return ui === 'mod' || (ui === '' && (env.MEFISTO_RUNTIME ?? '') === 'claude')
}

/** La invocacion corre dentro de un pane herdr con el binario en el PATH. */
export function insideHerdr(env: NodeJS.ProcessEnv, hasCommand: (command: string) => boolean): boolean {
  return env.HERDR_ENV === '1' && (env.HERDR_PANE_ID ?? '') !== '' && hasCommand('herdr')
}

/** Entorno del pipeline desacoplado: sin `HERDR_*` (no abre panes) ni `MEFISTO_UI`. */
export function detachedEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === 'MEFISTO_UI' || key.startsWith('HERDR_')) continue
    result[key] = value
  }
  return { ...result, ...extra }
}

export interface PipelineCommand {
  command: string
  args: string[]
  /** El pipeline aun no tiene `.mts` y corre con su `.sh`. */
  viaBash: boolean
}

/**
 * Comando que corre el pipeline `name` de `scriptsDir`: `node <name>.mts` si existe, y si no
 * `bash <name>.sh`. `prefix` (p. ej. `caffeinate -i`) se antepone tal cual.
 */
export function pipelineCommand(
  scriptsDir: string,
  name: string,
  args: readonly string[],
  prefix: readonly string[] = [],
  nodePath: string = process.execPath,
): PipelineCommand {
  const mts = join(scriptsDir, `${name}.mts`)
  const viaBash = !existsSync(mts)
  const [command, ...rest] = viaBash
    ? [...prefix, 'bash', join(scriptsDir, `${name}.sh`), ...args]
    : [...prefix, nodePath, mts, ...args]
  return { command: command ?? '', args: rest, viaBash }
}

export interface DetachedLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Recibe stdout y stderr del pipeline; se trunca al lanzar. */
  reportLog: string
}

/** Lanza el pipeline y devuelve su PID, o `undefined` si no arranco. */
export type LaunchDetached = (spec: DetachedLaunch) => number | undefined

/**
 * Lanza el pipeline como proceso desacoplado que sobrevive al lanzador: sesion propia (POSIX),
 * consola propia oculta (Windows), sin entrada y con la salida en `reportLog`. Un fallo al
 * arrancar se anota en `reportLog`, como lo dejaba `nohup`.
 */
export function launchDetached(spec: DetachedLaunch): number | undefined {
  const fd = openSync(spec.reportLog, 'w')
  try {
    const child = launch(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', fd, fd],
      detached: true,
    })
    child.on('error', (error) => {
      const out = openSync(spec.reportLog, 'a')
      try {
        writeSync(out, `${spec.command}: ${error.message}\n`)
      } finally {
        closeSync(out)
      }
    })
    child.unref()
    return child.pid
  } finally {
    closeSync(fd)
  }
}

export interface DelegateOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Corre un script bash con la terminal heredada y devuelve su codigo de salida. */
export type RunDelegate = (script: string, args: readonly string[], options: DelegateOptions) => number

export const runDelegate: RunDelegate = (script, args, options) => {
  const result = spawnSync('bash', [script, ...args], { cwd: options.cwd, env: options.env, stdio: 'inherit' })
  if (result.status !== null) return result.status
  const signal = result.signal === null ? undefined : constants.signals[result.signal]
  return signal === undefined ? 1 : 128 + signal
}

/**
 * Ruta de escritura del estado de la corrida: `MEFISTO_STATE_DIR` o `<root>/.mefisto/pipeline`.
 * Crea solo el directorio padre, como `mefisto_state_path`.
 */
export function launcherStatePath(rel: string, root: string, env: NodeJS.ProcessEnv): string {
  const base = (env.MEFISTO_STATE_DIR ?? '') !== '' ? (env.MEFISTO_STATE_DIR as string) : join(root, '.mefisto', 'pipeline')
  const full = join(base, rel)
  mkdirSync(dirname(full), { recursive: true })
  return full
}

/** Como `touch`: crea el archivo si falta y le pone la hora actual. */
export function touch(path: string, now: Date = new Date()): void {
  closeSync(openSync(path, 'a'))
  utimesSync(path, now, now)
}

/** Corta la ejecucion del lanzador con un codigo de salida; el mensaje ya se imprimio. */
export class LauncherExit extends Error {
  readonly code: number

  constructor(code: number) {
    super(`exit ${code}`)
    this.name = 'LauncherExit'
    this.code = code
  }
}
