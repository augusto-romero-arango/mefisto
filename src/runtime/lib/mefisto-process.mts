// Ejecucion vigilada de un proceso de agente: sin shell, con stdout y stderr a archivo, sin
// terminal de control, y con un watchdog que corta por timeout, reanuda al grupo si queda
// detenido y lo termina a pedido.
//
// Gemela de `run_agent_with_watchdog` (`mefisto-process.sh`), que aun cargan los pipelines en
// bash: un cambio va en los dos lados.

import { appendFileSync, closeSync, openSync } from 'node:fs'
import { constants } from 'node:os'

import { capture, launch } from '../../../scripts/lib/cli.mts'

export interface TreeCommand {
  command: string
  args: string[]
}

/**
 * Comando que mata el arbol del proceso `pid` donde no hay grupos de procesos POSIX, o `null` si
 * la plataforma los tiene. Siempre por PID concreto, nunca por nombre.
 */
export function treeKillCommand(pid: number, platform: NodeJS.Platform = process.platform): TreeCommand | null {
  return platform === 'win32' ? { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] } : null
}

/** Codigo de salida como lo informa un shell: el del proceso, o 128 mas el numero de la senal. */
export function shellExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  const number = signal === null ? undefined : constants.signals[signal]
  return number === undefined ? 1 : 128 + number
}

/** Rebanada del watchdog en segundos: entero >= 1; un valor invalido cae a 5 y el 0 sube a 1. */
export function watchdogPollSeconds(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return 5
  return Math.max(1, Number(raw))
}

/** Cuantos procesos del grupo `pgid` estan detenidos, a partir de `ps -eo pid=,pgid=,stat=`. */
export function countStopped(psOutput: string, pgid: number): number {
  let stopped = 0
  for (const line of psOutput.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[1] === String(pgid) && /^[Tt]/.test(fields[2] ?? '')) stopped++
  }
  return stopped
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/** Arbol de procesos de un hijo lanzado aqui: su grupo en POSIX, su descendencia en Windows. */
export interface ProcessTree {
  alive(): boolean
  /** Pide terminar: SIGTERM y SIGCONT al grupo; en Windows no hay terminacion amable y mata. */
  terminate(): void
  kill(): void
  /** Procesos detenidos del grupo; siempre 0 en Windows. */
  stoppedCount(): number
  resume(): void
}

export function processTree(pid: number, platform: NodeJS.Platform = process.platform): ProcessTree {
  const killCommand = treeKillCommand(pid, platform)
  if (killCommand !== null) {
    const kill = (): void => {
      capture(killCommand.command, killCommand.args)
    }
    return {
      alive: () => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      },
      terminate: kill,
      kill,
      stoppedCount: () => 0,
      resume: () => {},
    }
  }
  return {
    alive: () => signalGroup(pid, 0),
    terminate: () => {
      signalGroup(pid, 'SIGTERM')
      // Un grupo detenido no atiende SIGTERM hasta reanudarse.
      signalGroup(pid, 'SIGCONT')
    },
    kill: () => {
      signalGroup(pid, 'SIGKILL')
    },
    stoppedCount: () => countStopped(capture('ps', ['-eo', 'pid=,pgid=,stat=']).stdout, pid),
    resume: () => {
      signalGroup(pid, 'SIGCONT')
    },
  }
}

export interface WatchdogRun {
  /** argv completo; el primer elemento se resuelve en el PATH de `env`. */
  argv: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutSeconds: number
  stdoutFile: string
  stderrFile: string
  /** Lineas de diagnostico del watchdog (`TIMEOUT`, `STOPPED`, `TERMINATE`), en texto plano. */
  eventsLog: string
  label: string
  /** Archivo regular que se conecta a la entrada estandar; sin el, la entrada queda cerrada. */
  stdinFile?: string
  pollSeconds?: number
  /** Se consulta en cada rebanada: `true` pide terminar al proceso sin que cuente como timeout. */
  terminateRequested?: () => boolean
  /** Recibe el arbol del hijo apenas arranca, para que el llamador lo pueda matar al salir. */
  onStart?: (tree: ProcessTree) => void
  platform?: NodeJS.Platform
}

export interface WatchdogResult {
  exitCode: number
  /** El watchdog mato al proceso por agotar `timeoutSeconds`. */
  timedOut: boolean
}

const TERMINATE_GRACE_SECONDS = 10

function clock(): string {
  const now = new Date()
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`
}

/** Corre `argv` hasta que termine o lo corte el watchdog. */
export function runWithWatchdog(run: WatchdogRun): Promise<WatchdogResult> {
  const platform = run.platform ?? process.platform
  const pollSeconds = run.pollSeconds ?? watchdogPollSeconds(process.env.MEFISTO_WATCHDOG_POLL_S)
  const log = (message: string): void => {
    try {
      appendFileSync(run.eventsLog, `[${clock()}] ${message}\n`)
    } catch {
      // El diagnostico del watchdog nunca decide el desenlace.
    }
  }

  return new Promise((resolve) => {
    const [command = '', ...args] = run.argv
    const stdin = run.stdinFile === undefined ? null : openSync(run.stdinFile, 'r')
    const stdout = openSync(run.stdoutFile, 'w')
    const stderr = openSync(run.stderrFile, 'w')
    const closeAll = (): void => {
      for (const fd of [stdin, stdout, stderr]) if (fd !== null) closeSync(fd)
    }

    let settled = false
    let timedOut = false
    let forced = false
    let wake: (() => void) | null = null
    let timer: NodeJS.Timeout | null = null
    const settle = (exitCode: number): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      wake?.()
      resolve({ exitCode, timedOut })
    }
    /** Duerme `ms`; devuelve `false` si el proceso termino antes. */
    const sleep = (ms: number): Promise<boolean> =>
      new Promise((done) => {
        if (settled) {
          done(false)
          return
        }
        wake = () => done(false)
        timer = setTimeout(() => {
          wake = null
          done(true)
        }, ms)
      })

    // Sesion propia en POSIX: sin terminal de control no hay SIGTTIN ni SIGTTOU, y el hijo es
    // lider del grupo que el watchdog senala. En Windows el arbol se mata por PID.
    const child = launch(command, args, {
      cwd: run.cwd,
      env: run.env,
      stdio: [stdin ?? 'ignore', stdout, stderr],
      detached: platform !== 'win32',
    })
    closeAll()

    child.once('error', (error) => {
      try {
        appendFileSync(run.stderrFile, `no se pudo ejecutar '${command}': ${error.message}\n`)
      } catch {
        // Sin stderr donde dejarlo, el codigo 127 ya dice que no arranco.
      }
      settle(127)
    })
    child.once('exit', (code, signal) => {
      // En Windows un arbol matado a la fuerza sale con 1; se informa como SIGKILL.
      settle(forced && platform === 'win32' ? 137 : shellExitCode(code, signal))
    })

    const pid = child.pid
    if (pid === undefined) return
    const tree = processTree(pid, platform)
    run.onStart?.(tree)

    const watchdog = async (): Promise<void> => {
      const startedAt = Date.now()
      let elapsed = 0
      while (elapsed < run.timeoutSeconds) {
        const slice = Math.min(pollSeconds, run.timeoutSeconds - elapsed)
        if (!(await sleep(slice * 1000))) return
        elapsed += slice

        if (run.terminateRequested?.() === true) {
          // La linea va antes de las senales: el proceso puede morir en el acto.
          log(`TERMINATE: ${run.label} -- SIGTERM al grupo por solicitud`)
          forced = true
          tree.terminate()
          for (let waited = 0; waited < TERMINATE_GRACE_SECONDS && tree.alive(); waited++) {
            if (!(await sleep(1000))) return
          }
          if (tree.alive()) tree.kill()
          return
        }

        const stopped = tree.stoppedCount()
        if (stopped > 0) {
          log(`STOPPED: ${run.label} tenia ${stopped} proceso(s) detenido(s) -- SIGCONT enviado`)
          tree.resume()
        }
      }
      // Un temporizador puede dispararse antes de tiempo: el timeout exige el reloj de pared.
      for (let left = run.timeoutSeconds * 1000 - (Date.now() - startedAt); left > 0; ) {
        if (!(await sleep(left))) return
        left = run.timeoutSeconds * 1000 - (Date.now() - startedAt)
      }
      if (settled) return
      timedOut = true
      forced = true
      tree.kill()
      log(`TIMEOUT: ${run.label} supero ${run.timeoutSeconds}s`)
    }
    void watchdog()
  })
}
