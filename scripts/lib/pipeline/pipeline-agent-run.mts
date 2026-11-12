// Invocacion de un agente desde un pipeline: lanza el runner neutral como proceso y aplica la
// politica comun de reintentos, espera (hold) y reanudacion de sesion (MEF-ADR-0051). Es la
// maquina de decisiones de `run_agent` de los pipelines bash; lo que cambia entre ellos (nombres
// de archivo, textos, metricas, que cuenta como trabajo) llega por parametros y por `onEvent`.

import type { ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { join } from 'node:path'

import { launch } from '../cli.mts'
import {
  agentEventsCompletedSuccessfully,
  agentEventsDenials,
  agentEventsResetsAt,
  agentEventsSessionId,
} from './agent-events.mts'
import { agentFailureIsHoldable, classifyNeutralAgentFailure } from './agent-failures.mts'
import { agentHoldWait, holdLimits } from './agent-hold.mts'
import type { HoldState } from './pipeline-status.mts'
import { utcIsoSeconds } from './pipeline-status.mts'
import { deriveStageLogFromStream } from './stage-metrics.mts'

/** System prompt de toda invocacion desatendida; se escribe con un salto final. */
export const NON_INTERACTIVE_SYSTEM_PROMPT =
  'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.'

/** Prompt de la sonda que reanuda la sesion truncada de un stage con resumen. */
export const RESUME_STAGE_PROMPT = 'Continue the same stage and complete its summary.'

/** Ejecutable del runner y los argumentos que van antes de los de cada invocacion. */
export interface RunnerCommand {
  command: string
  args: string[]
}

export type RunnerResolution = { runner: RunnerCommand; path: string } | { error: string; path: string }

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const NODE_MODULE = /\.(mts|mjs|js)$/

/**
 * Runner neutral de `runtimeDir` (`mefisto-run-agent.mts`, lanzado con este mismo Node), o el
 * que indique `MEFISTO_RUN_AGENT_BIN`: un ejecutable, o un modulo de Node, que tambien se lanza
 * con Node porque en Windows no hay otra forma de ejecutarlo.
 */
export function resolveRunnerCommand(env: NodeJS.ProcessEnv, runtimeDir: string): RunnerResolution {
  const override = env.MEFISTO_RUN_AGENT_BIN ?? ''
  const path = override.length > 0 ? override : join(runtimeDir, 'mefisto-run-agent.mts')
  const error = `No es ejecutable el runner neutral: ${path}`
  if (!isFile(path)) return { error, path }
  if (override.length === 0 || NODE_MODULE.test(path)) return { runner: { command: process.execPath, args: [path] }, path }
  return isExecutable(path) ? { runner: { command: path, args: [] }, path } : { error, path }
}

/** Corre el runner con `args`, deja su salida en `outputFile` y devuelve su codigo de salida. */
export type LaunchRunner = (args: string[], outputFile: string) => Promise<number>

export interface RunnerProcessOptions {
  runner: RunnerCommand
  env: NodeJS.ProcessEnv
  cwd?: string
  /** Recibe el proceso mientras corre y `null` al terminar, para poder matarlo ante una senal. */
  onChild?: (child: ChildProcess | null) => void
  /** `true` agrega la salida al archivo en vez de reemplazarlo. */
  appendOutput?: boolean
}

/**
 * `LaunchRunner` sobre un proceso hijo real. Un proceso que muere por una senal devuelve 128 mas
 * su numero, y uno que no arranca, 127: los codigos que veria un shell.
 */
export function runnerProcess(options: RunnerProcessOptions): LaunchRunner {
  return (args, outputFile) =>
    new Promise<number>((resolve) => {
      let output: number
      try {
        output = openSync(outputFile, options.appendOutput === true ? 'a' : 'w')
      } catch {
        resolve(1)
        return
      }
      const done = (code: number): void => {
        options.onChild?.(null)
        closeSync(output)
        resolve(code)
      }
      const child = launch(options.runner.command, [...options.runner.args, ...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', output, output],
      })
      options.onChild?.(child)
      let settled = false
      child.once('error', () => {
        if (settled) return
        settled = true
        done(127)
      })
      child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        done(code ?? 128 + (signal === null ? 0 : (osConstants.signals[signal] ?? 0)))
      })
    })
}

export interface AgentRunRequest {
  /** Runtime ya resuelto (`--runtime`). */
  runtime: string
  /** Id del agente para el runner (`--agent`). */
  agentId: string
  /** Directorio de trabajo del agente (`--cwd`). */
  worktree: string
  prompt: string
  /** Archivo temporal del prompt; se escribe aqui y lo borra quien limpia los temporales. */
  promptFile: string
  systemFile: string
  /** Texto de la sonda que reanuda una sesion; se escribe con un salto final. */
  resumePrompt?: string
  /** Archivo temporal del prompt de reanudacion de un intento; se borra al volver el runner. */
  resumePromptFile: (attempt: number) => string
  /** JSONL neutral de cada intento (`--event-log`). */
  eventsFile: (attempt: number) => string
  /** Log legible que se deriva del JSONL tras cada intento; sin el no se deriva nada. */
  stageLog?: (attempt: number) => string
  /** Archivo que recibe la salida del propio runner en cada intento. */
  runnerOutput: (attempt: number) => string
  /**
   * Argumentos del runner que van tras `--event-log` y antes del modelo: `--events-log`,
   * `--redact-observability`, `--timeout`. Cada pipeline decide cuales pasa.
   */
  extraArgs?: string[]
  /** Vacio hereda el modelo (no se pasa `--model`). */
  model: string
  /** Vacio hereda el effort (no se pasa `--effort`). */
  effort: string
  /** events.log de la corrida, donde se anuncia cada espera. */
  eventsLog: string
}

export interface AgentRunPolicy {
  /**
   * Reintento unico desde cero cuando el terminal trae denegaciones de permisos y el intento no
   * dejo trabajo, incluso si el runtime declaro exito. Sin el, las denegaciones no se miran.
   */
  denialRetry?: { hasWork: () => boolean }
  /**
   * `true` si la sesion reanudada dejo la evidencia de haber cumplido (el resumen del stage). Si
   * una sonda reanudada termina sin ella, la reanudacion se abandona para el resto de la
   * invocacion. Sin esta funcion nunca se abandona.
   */
  resumeEvidence?: () => boolean
  /** Si el runtime sabe reanudar una sesion; solo se consulta cuando hay `session_id`. */
  supportsResume: () => boolean | Promise<boolean>
}

/** Lo que ocurre durante la invocacion; cada pipeline lo traduce a sus mensajes, status y metricas. */
export type AgentRunEvent =
  /** Un intento termino y su log ya se derivo; aun no se decidio nada sobre el. */
  | { kind: 'attempt'; attempt: number; eventsFile: string; exitCode: number; elapsedSeconds: number; attemptSeconds: number; resumed: boolean }
  | { kind: 'denial-retry'; denials: number }
  /** Intento fallido ya clasificado, antes de saber si amerita espera. */
  | { kind: 'failure'; failureType: string; elapsedSeconds: number; attemptSeconds: number }
  /** Empieza una espera: el status debe pasar a `hold`. */
  | { kind: 'hold'; hold: HoldState }
  /** El techo de la espera se agoto; la invocacion termina con el ultimo fallo. */
  | { kind: 'hold-ceiling'; failureType: string }
  | { kind: 'hold-waited'; failureType: string; sleptSeconds: number; holdSeconds: number }
  /** La sonda reanudada termino sin evidencia: en adelante se arranca de cero. */
  | { kind: 'resume-degraded' }
  | { kind: 'resume-no-session' }
  | { kind: 'resume-unsupported' }
  /** La proxima sonda reanuda `sessionId`. */
  | { kind: 'resume'; failureType: string; sessionId: string }

export interface AgentRunDeps {
  launchRunner: LaunchRunner
  onEvent?: (event: AgentRunEvent) => void
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Espera de un hold; por defecto duerme de verdad. */
  sleep?: (seconds: number) => Promise<void>
}

export interface AgentRunOutcome {
  /** Etiqueta del fallo con que termino la invocacion; vacia si termino bien. */
  failureType: string
  /** Segundos de reloj desde el primer intento, esperas incluidas. */
  elapsedSeconds: number
  /** Segundos que tomo el ultimo intento. */
  attemptSeconds: number
  /** Segundos pasados en espera (hold). */
  holdSeconds: number
  attempts: number
  /** JSONL del ultimo intento. */
  eventsFile: string
  /** Denegaciones de permisos del ultimo intento. */
  denials: number
}

/**
 * Invoca al agente hasta que termina bien, falla sin remedio o se agota el techo de espera.
 * El runner decide timeout, argv y terminal; aqui solo vive la politica: un reintento por
 * denegaciones sin trabajo, espera ante limite de uso o proveedor caido, y reanudacion de la
 * sesion truncada mientras el runtime la soporte y siga dejando evidencia.
 */
export async function runAgentWithPolicy(
  request: AgentRunRequest,
  policy: AgentRunPolicy,
  deps: AgentRunDeps,
): Promise<AgentRunOutcome> {
  const env = deps.env ?? process.env
  const now = deps.now ?? ((): Date => new Date())
  const epoch = (): number => Math.floor(now().getTime() / 1000)
  const emit = (event: AgentRunEvent): void => deps.onEvent?.(event)

  writeFileSync(request.promptFile, request.prompt)
  writeFileSync(request.systemFile, `${NON_INTERACTIVE_SYSTEM_PROMPT}\n`)

  const start = epoch()
  let attempt = 0
  let elapsed = 0
  let lastAttemptSeconds = 0
  let failureType = ''
  let holdStarted: number | null = null
  let holdTotal = 0
  let resumeSession = ''
  let resumeDegraded = false
  let denialRetryUsed = false
  let denials = 0
  let eventsFile = ''

  for (;;) {
    attempt++
    eventsFile = request.eventsFile(attempt)
    const attemptResume = resumeSession.length > 0
    let attemptPrompt = request.promptFile
    if (attemptResume) {
      attemptPrompt = request.resumePromptFile(attempt)
      writeFileSync(attemptPrompt, `${request.resumePrompt ?? RESUME_STAGE_PROMPT}\n`)
    }
    const args = [
      '--runtime',
      request.runtime,
      '--agent',
      request.agentId,
      '--cwd',
      request.worktree,
      '--prompt-file',
      attemptPrompt,
      '--system-file',
      request.systemFile,
      '--event-log',
      eventsFile,
      ...(request.extraArgs ?? []),
    ]
    if (request.model.length > 0) args.push('--model', request.model)
    if (request.effort.length > 0) args.push('--effort', request.effort)
    if (attemptResume) args.push('--resume-session', resumeSession)

    const attemptStart = epoch()
    const exitCode = await deps.launchRunner(args, request.runnerOutput(attempt))
    if (attemptPrompt !== request.promptFile) rmSync(attemptPrompt, { force: true })
    elapsed = epoch() - start
    const attemptSeconds = epoch() - attemptStart
    lastAttemptSeconds = attemptSeconds
    const stageLog = request.stageLog?.(attempt)
    if (stageLog !== undefined) deriveStageLogFromStream(eventsFile, '', stageLog)
    emit({ kind: 'attempt', attempt, eventsFile, exitCode, elapsedSeconds: elapsed, attemptSeconds, resumed: attemptResume })

    const reported = agentEventsDenials(eventsFile)
    denials = /^[0-9]+$/.test(reported) ? Number(reported) : 0
    if (policy.denialRetry !== undefined && denials > 0 && !denialRetryUsed && !policy.denialRetry.hasWork()) {
      denialRetryUsed = true
      resumeSession = ''
      emit({ kind: 'denial-retry', denials })
      continue
    }

    if (exitCode === 0 && agentEventsCompletedSuccessfully(eventsFile)) {
      failureType = ''
      break
    }
    failureType = classifyNeutralAgentFailure(exitCode, eventsFile)
    emit({ kind: 'failure', failureType, elapsedSeconds: elapsed, attemptSeconds })
    if (!agentFailureIsHoldable(failureType)) break

    holdStarted ??= epoch()
    const limits = holdLimits(env)
    emit({
      kind: 'hold',
      hold: {
        cause: failureType,
        nextProbe: utcIsoSeconds(epoch() + limits.probeSeconds),
        ceilingSeconds: limits.maxSeconds,
        accumulatedSeconds: holdTotal,
      },
    })
    const resetsAt = agentEventsResetsAt(eventsFile)
    const slept = await agentHoldWait({
      eventsLog: request.eventsLog,
      failureType,
      holdStarted,
      ...(resetsAt.length > 0 ? { resetsAt } : {}),
      env,
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    })
    if (slept === null) {
      emit({ kind: 'hold-ceiling', failureType })
      break
    }
    holdTotal += slept
    emit({ kind: 'hold-waited', failureType, sleptSeconds: slept, holdSeconds: holdTotal })

    if (attemptResume && policy.resumeEvidence !== undefined && !policy.resumeEvidence()) {
      resumeDegraded = true
      resumeSession = ''
      emit({ kind: 'resume-degraded' })
    } else if (!resumeDegraded) {
      resumeSession = agentEventsSessionId(eventsFile)
      if (resumeSession.length === 0) {
        emit({ kind: 'resume-no-session' })
      } else if (!(await policy.supportsResume())) {
        resumeSession = ''
        emit({ kind: 'resume-unsupported' })
      } else {
        emit({ kind: 'resume', failureType, sessionId: resumeSession })
      }
    }
  }

  return {
    failureType,
    elapsedSeconds: elapsed,
    attemptSeconds: lastAttemptSeconds,
    holdSeconds: holdTotal,
    attempts: attempt,
    eventsFile,
    denials,
  }
}
