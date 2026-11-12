// Invocacion de un agente del pipeline interno de tooling: lanza el runner neutral como proceso
// y aplica la politica propia de este pipeline. Un PROVIDER_UNAVAILABLE se reintenta con espera
// corta y worktree restaurado; un RATE_LIMIT, o un PROVIDER_UNAVAILABLE que agoto esos reintentos,
// espera (hold) con su propio techo y reanuda la sesion truncada cuando el runtime lo soporta
// (MEF-ADR-0051). Un fallo que deja trabajo confiable no aborta el stage.

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Run } from '../../../../scripts/lib/azure-cli.mts'
import { COLOR } from '../../../../scripts/lib/cli.mts'
import { appendEventsLine, clockTime } from '../../../../scripts/lib/pipeline/agent-log.mts'
import { agentFailureIsHoldable } from '../../../../scripts/lib/pipeline/agent-failures.mts'
import { holdLimits, planHold } from '../../../../scripts/lib/pipeline/agent-hold.mts'
import type { LaunchRunner } from '../../../../scripts/lib/pipeline/pipeline-agent-run.mts'
import type { Abort, PipelineLog } from '../../../../scripts/lib/pipeline/pipeline-log.mts'
import { lastLines } from '../../../../scripts/lib/pipeline/pipeline-log.mts'
import { agentEventsResetsAt, agentEventsSessionId } from './mefisto-agent-events.mts'
import {
  agentFailureIsRetryable,
  agentFailureIsUnrecoverable,
  agentWorkIsTrustworthy,
  classifyAgentFailure,
} from './mefisto-agent-failures.mts'
import { computeStageMetrics, deriveStageLogFromStream } from './mefisto-stage-metrics.mts'
import { resumePrompt } from './mefisto-tooling-texts.mts'

export type AgentRole = 'writer' | 'reviewer'

export interface ToolingAgentContext {
  runtime: string
  worktree: string
  /** Commit de entrada al pipeline; vacio cuenta como `HEAD`. */
  snapshot: string
  logDir: string
  pipelineDir: string
  eventsLog: string
  timestamp: string
  /** Issue, con el sufijo de la variante si la hay. */
  issueLogTag: string
  systemFile: string
  timeout: string
  model: (role: AgentRole) => string
  effort: (role: AgentRole) => string
  /** Para los reintentos y la espera: `MEFISTO_AGENT_*` y `MEFISTO_HOLD_*`. */
  env: NodeJS.ProcessEnv
  log: PipelineLog
  /** Pantalla, para las ultimas lineas del log del agente que fallo. */
  out: (text: string) => void
  abort: Abort
  /** El stage entra a correr: marca el rol y reescribe el status. */
  onStart: (stage: string, agent: string) => void
  /** El stage fallo sin trabajo confiable: deja duracion, resultado y metricas antes del aborto. */
  onFailed: (stage: string, agent: string, seconds: number, metrics: string) => void
  launchRunner: LaunchRunner
  supportsResume: () => boolean | Promise<boolean>
  run: Run
  now: () => Date
  sleep: (seconds: number) => Promise<void>
}

export interface ToolingAgentOutcome {
  /** Segundos de reloj del stage, intentos y esperas incluidos. */
  seconds: number
  metrics: string
  holdSeconds: number
  resumed: boolean
}

function wholeNumber(value: string | undefined, fallback: number): number {
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : fallback
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stats = statSync(path)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

function copyIfPresent(from: string, to: string): void {
  try {
    copyFileSync(from, to)
  } catch {
    // Sin el archivo del intento no hay evidencia que preservar.
  }
}

/** `Xm Ys`. */
function minutes(seconds: number): string {
  return `${Math.trunc(seconds / 60)}m ${seconds % 60}s`
}

/** Modelo efectivo que reporto el terminal, o vacio si no lo trajo. */
export function effectiveModel(metrics: string): string {
  try {
    const parsed: unknown = JSON.parse(metrics)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
    const model = (parsed as Record<string, unknown>).model
    if (model === null || model === undefined) return ''
    return typeof model === 'string' ? model : JSON.stringify(model)
  } catch {
    return ''
  }
}

/** Invoca el agente de `stage` y devuelve lo que costo; aborta si falla sin dejar trabajo confiable. */
export async function runToolingAgent(
  ctx: ToolingAgentContext,
  stage: string,
  agent: string,
  prompt: string,
): Promise<ToolingAgentOutcome> {
  const { log, env } = ctx
  const epoch = (): number => Math.floor(ctx.now().getTime() / 1000)
  const event = (text: string): void => appendEventsLine(ctx.eventsLog, `[${clockTime(ctx.now())}]${text}`)
  const name = `mefisto-tooling-stage-${stage}-${agent}-${ctx.timestamp}-issue-${ctx.issueLogTag}`
  const logBase = join(ctx.logDir, name)
  const logStage = `${logBase}.log`
  const streamFile = `${logBase}.stream.jsonl`
  const stderrFile = `${logBase}.stderr.log`
  const eventsFile = `${logBase}.events.jsonl`
  const promptFile = join(ctx.pipelineDir, 'prompts', `${name}.prompt.md`)
  const resumePromptFile = join(ctx.pipelineDir, 'prompts', `${name}.resume-prompt.md`)
  const metricsFile = join(
    ctx.pipelineDir,
    'metrics',
    `mefisto-tooling-${ctx.timestamp}-issue-${ctx.issueLogTag}-stage-${stage}-${agent}.json`,
  )
  const summaryFile = join(ctx.worktree, '.mefisto', 'pipeline', 'summaries', `stage-${stage}-${agent}.md`)
  mkdirSync(dirname(promptFile), { recursive: true })
  mkdirSync(dirname(summaryFile), { recursive: true })
  writeFileSync(promptFile, prompt)

  const start = epoch()
  event(` === MEFISTO-TOOLING STAGE ${stage}: ${agent} ===`)

  // El stage de resolucion de conflictos corre como writer: mismo agente, modelo y effort.
  const role: AgentRole = agent === 'reviewer' ? 'reviewer' : 'writer'
  const agentId = role === 'reviewer' ? 'mefisto-reviewer' : 'mefisto-writer'
  const model = ctx.model(role)
  const effort = ctx.effort(role)
  ctx.onStart(stage, agent)
  log.log(`Invocando ${agent} (modelo: ${model.length > 0 ? model : '<heredado>'})...`)

  const maxAttempts = wholeNumber(env.MEFISTO_AGENT_MAX_ATTEMPTS, 3)
  const backoff = wholeNumber(env.MEFISTO_AGENT_RETRY_BACKOFF_SECONDS, 120)
  const limits = holdLimits(env)
  // Dos medidas a proposito: lo dormido es lo que se reporta; el reloj desde el inicio de la
  // espera es contra lo que se mide el techo.
  let holdTotal = 0
  let holdElapsed = 0
  let holdStarted: number | null = null

  // Solo se restaura un worktree que entraba limpio: el writer puede dejar trabajo sin commitear.
  const git = (args: string[]): { status: number | null; stdout: string } => ctx.run('git', ['-C', ctx.worktree, ...args])
  const head = git(['rev-parse', 'HEAD'])
  const entryCommit = head.status === 0 ? head.stdout.replace(/\n+$/, '') : ''
  const entryClean = git(['status', '--porcelain']).stdout.replace(/\n+$/, '').length === 0

  let resumeSession = ''
  let resumeDegraded = false
  let resumedAny = false

  let runExit = 0
  let timedOut = false
  let failureType = ''
  let metrics = ''
  let elapsed = 0
  let attempt = 1
  for (;;) {
    const attemptStart = epoch()
    const attemptResumed = resumeSession.length > 0
    const args = [
      '--runtime',
      ctx.runtime,
      '--agent',
      agentId,
      '--cwd',
      ctx.worktree,
      '--prompt-file',
      attemptResumed ? resumePromptFile : promptFile,
      '--system-file',
      ctx.systemFile,
      '--event-log',
      eventsFile,
      '--raw-log',
      streamFile,
      '--stderr-log',
      stderrFile,
      '--events-log',
      ctx.eventsLog,
      '--timeout',
      ctx.timeout,
    ]
    if (model.length > 0) args.push('--model', model)
    if (effort.length > 0) args.push('--effort', effort)
    if (attemptResumed) args.push('--resume-session', resumeSession)

    runExit = await ctx.launchRunner(args, `${logBase}.runner.log`)
    elapsed = epoch() - attemptStart

    deriveStageLogFromStream(eventsFile, stderrFile, logStage)
    metrics = computeStageMetrics(eventsFile)
    try {
      writeFileSync(metricsFile, `${metrics}\n`)
    } catch {
      // Las metricas son observabilidad: no poder escribirlas no detiene al stage.
    }

    // El runner distingue el timeout de su watchdog con el codigo 124.
    timedOut = runExit === 124
    failureType = runExit === 0 ? '' : classifyAgentFailure(timedOut, runExit, elapsed, eventsFile)
    if (failureType.length === 0) break

    if (agentFailureIsRetryable(failureType) && attempt < maxAttempts) {
      log.warn(`${agent}: ${failureType} -- reintentando (${attempt + 1}/${maxAttempts}) tras ${backoff}s`)
      event(` REINTENTO ${agent}: ${failureType} (intento ${attempt}/${maxAttempts}, espera ${backoff}s)`)
      // El intento siguiente sobrescribe los nombres canonicos: la evidencia de este se guarda aparte.
      copyIfPresent(logStage, `${logBase}.attempt-${attempt}.log`)
      copyIfPresent(streamFile, `${logBase}.attempt-${attempt}.stream.jsonl`)
      copyIfPresent(eventsFile, `${logBase}.attempt-${attempt}.events.jsonl`)
      if (entryClean && entryCommit.length > 0) {
        // Sin `-x`: los resumenes bajo `.mefisto/pipeline/` estan ignorados y deben sobrevivir.
        git(['reset', '--hard', entryCommit])
        git(['clean', '-fd'])
        log.log(`Worktree restaurado a ${entryCommit.slice(0, 8)} para el reintento`)
      } else {
        log.log('El worktree ya tenia cambios al entrar al stage: NO se restaura (se reintenta sobre el estado actual)')
      }
      await ctx.sleep(backoff)
      attempt++
      continue
    }
    if (!agentFailureIsHoldable(failureType)) break

    // La espera no consume el presupuesto de reintentos ni restaura el worktree: la reanudacion
    // se apoya en el trabajo que dejo el stage truncado.
    holdStarted ??= epoch()
    const now = ctx.now()
    holdElapsed = epoch() - holdStarted
    const resetsAt = agentEventsResetsAt(eventsFile)
    const plan = planHold({
      failureType,
      holdStarted,
      ...(resetsAt.length > 0 ? { resetsAt } : {}),
      now,
      limits,
    })
    if (plan === null) break
    const nextProbe = clockTime(new Date((Math.floor(now.getTime() / 1000) + plan.sleepSeconds) * 1000))
    log.warn(`${agent}: ${failureType} -- en espera (hold), proxima sonda a las ${nextProbe}`)
    appendEventsLine(ctx.eventsLog, plan.line)

    if (!resumeDegraded) {
      if (attemptResumed && !isNonEmptyFile(summaryFile)) {
        // Una sesion que murio dos veces sin evidencia de avance no se reanuda mas en este stage.
        log.warn(
          `${agent}: la sesion reanudada (${resumeSession}) volvio a morir sin dejar el resumen del stage -- se degrada a stage desde cero`,
        )
        event(`[hold][resume] ${agent}: sesion ${resumeSession} murio de nuevo sin resumen -- degradado a stage desde cero (CA-4c)`)
        resumeDegraded = true
        resumeSession = ''
      } else if (resumeSession.length === 0) {
        const candidate = agentEventsSessionId(eventsFile)
        if (candidate.length === 0) {
          log.warn(`${agent}: el intento fallido no dejo session_id en el terminal -- se reintenta sin reanudar`)
          event(`[hold][resume] ${agent}: sin session_id en el terminal -- reintento sin reanudar (CA-4a)`)
        } else if (!(await ctx.supportsResume())) {
          log.warn(`${agent}: el runtime '${ctx.runtime}' no soporta reanudacion -- se reintenta sin reanudar`)
          event(`[hold][resume] ${agent}: runtime '${ctx.runtime}' sin soporte de reanudacion -- reintento sin reanudar (CA-4b)`)
        } else {
          resumeSession = candidate
          resumedAny = true
          writeFileSync(resumePromptFile, resumePrompt(stage, agent))
          log.log(`${agent}: reanudando sesion ${resumeSession} en el proximo intento (hold)`)
          event(`[hold][resume] ${agent}: reanudando sesion ${resumeSession}`)
        }
      }
    }

    await ctx.sleep(plan.sleepSeconds)
    holdTotal += plan.sleepSeconds
  }

  if (model.length === 0) {
    const effective = effectiveModel(metrics)
    if (effective.length > 0) log.log(`MODELS: stage ${stage}/${agent} -> ${effective} (efectivo)`)
  }

  const total = epoch() - start
  if (failureType.length > 0) {
    log.log(`${agent} fallo despues de ${elapsed}s -- tipo: ${failureType}`)
    event(` FALLO ${agent}: ${failureType}`)
    if (holdTotal > 0) {
      log.log(`${agent}: techo de espera (hold) agotado tras ${minutes(holdElapsed)} -- ultima senal: ${failureType}`)
    }
    // Un timeout o un corte a mitad de respuesta nunca se recupera por el trabajo que dejo.
    const unrecoverable = agentFailureIsUnrecoverable(timedOut, runExit, eventsFile)
    const base = ctx.snapshot.length > 0 ? ctx.snapshot : 'HEAD'
    if (agentWorkIsTrustworthy(ctx.worktree, base, unrecoverable, summaryFile, ctx.run)) {
      log.warn(`${agent}: CLI retorno error (${failureType}) pero hay trabajo util -- continuando`)
      event(` RECUPERADO ${agent}: trabajo util detectado`)
    } else {
      ctx.onFailed(stage, agent, total, metrics)
      ctx.out(`\n${COLOR.red}-- Ultimas lineas del log de ${agent}:${COLOR.reset}\n`)
      let stageLog = ''
      try {
        stageLog = readFileSync(logStage, 'utf8')
      } catch {
        stageLog = ''
      }
      const tail = lastLines(stageLog, 20)
      if (tail.length > 0) ctx.out(`${tail}\n`)
      if (holdTotal > 0) {
        ctx.abort(
          `${agent}: techo de espera agotado tras ${minutes(holdElapsed)} (limite ${limits.maxSeconds}s) -- ultima senal: ${failureType}. Log completo: ${logStage}`,
        )
      }
      ctx.abort(`${agent} fallo (${failureType}). Log completo: ${logStage}`)
    }
  }

  if (holdTotal > 0) {
    log.log(`${agent} completado en ${total}s (incluye ${minutes(holdTotal)} en espera/hold)`)
  } else if (attempt > 1) {
    log.log(`${agent} completado en ${total}s (intento ${attempt}/${maxAttempts}; ${elapsed}s el ultimo)`)
  } else {
    log.log(`${agent} completado en ${total}s`)
  }
  if (resumedAny) {
    log.log(`${agent}: la corrida reanudo al menos una sesion truncada por espera (hold, issue #968)`)
    event(`[hold][resume] ${agent}: stage completado tras reanudar sesion`)
  }
  return { seconds: total, metrics, holdSeconds: holdTotal, resumed: resumedAny }
}
