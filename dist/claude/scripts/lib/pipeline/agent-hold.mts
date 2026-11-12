// Espera (hold) ante un limite de uso o una caida del proveedor, reanudacion de la sesion
// truncada y contabilidad de lo esperado (MEF-ADR-0051). La linea de anuncio es contrato:
// "[HH:MM:SS][hold] <FAMILIA>: esperando, proxima sonda HH:MM:SS (techo HH:MM)".

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { epochAt, holdLineWindow, holdRecentlyActive, lastHoldLine } from '../work-status-hold.mts'
import { appendEventsLine, clockMinutes, clockTime } from './agent-log.mts'

const DEFAULT_MAX_SECONDS = 21_600
const DEFAULT_PROBE_SECONDS = 300
/** Margen sobre `resets_at` antes de volver a sondear. */
const RESET_MARGIN_SECONDS = 60

export interface HoldLimits {
  /** Techo de la espera, en reloj de pared desde que empezo. */
  maxSeconds: number
  /** Cadencia de sondeo cuando el terminal no dice cuando se levanta el limite. */
  probeSeconds: number
}

function wholeSeconds(value: string | undefined, fallback: number): number {
  return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : fallback
}

/** Limites de `MEFISTO_HOLD_MAX_SECONDS` (6 h) y `MEFISTO_HOLD_PROBE_SECONDS` (5 min). */
export function holdLimits(env: NodeJS.ProcessEnv = process.env): HoldLimits {
  return {
    maxSeconds: wholeSeconds(env.MEFISTO_HOLD_MAX_SECONDS, DEFAULT_MAX_SECONDS),
    probeSeconds: wholeSeconds(env.MEFISTO_HOLD_PROBE_SECONDS, DEFAULT_PROBE_SECONDS),
  }
}

const RESETS_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/

/** Epoch en segundos de un `resets_at` (`YYYY-MM-DDTHH:MM:SSZ`, en UTC), o `null` si no tiene esa forma. */
export function resetsAtEpoch(resetsAt: string): number | null {
  const match = RESETS_AT.exec(resetsAt)
  if (match === null) return null
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000
}

export interface HoldPlanInput {
  /** Etiqueta del fallo; su primera palabra es la familia que nombra el anuncio. */
  failureType: string
  /** Epoch en segundos en que empezo la espera. */
  holdStarted: number
  resetsAt?: string
  now: Date
  limits: HoldLimits
}

export interface HoldPlan {
  sleepSeconds: number
  /** Anuncio para events.log, sin salto final. */
  line: string
}

/**
 * Cuanto dormir antes de la proxima sonda y el anuncio que lo deja escrito, o `null` si el techo
 * ya se agoto. Con `resetsAt` espera hasta ese instante mas el margen; nunca pasa del techo.
 */
export function planHold(input: HoldPlanInput): HoldPlan | null {
  const { holdStarted, limits, now } = input
  const nowEpoch = Math.floor(now.getTime() / 1000)
  const remaining = limits.maxSeconds - (nowEpoch - holdStarted)
  if (remaining <= 0) return null
  const resetsEpoch = resetsAtEpoch(input.resetsAt ?? '')
  const wanted = resetsEpoch === null ? limits.probeSeconds : Math.max(1, resetsEpoch + RESET_MARGIN_SECONDS - nowEpoch)
  const sleepSeconds = Math.min(wanted, remaining)
  const [family = ''] = input.failureType.split(' ')
  const nextProbe = new Date((nowEpoch + sleepSeconds) * 1000)
  const deadline = new Date((holdStarted + limits.maxSeconds) * 1000)
  return {
    sleepSeconds,
    line: `[${clockTime(now)}][hold] ${family}: esperando, proxima sonda ${clockTime(nextProbe)} (techo ${clockMinutes(deadline)})`,
  }
}

// Un temporizador de Node no admite mas de 2^31-1 ms.
const MAX_TIMER_MS = 2_147_483_647

async function sleepSeconds(seconds: number): Promise<void> {
  for (let left = seconds * 1000; left > 0; left -= MAX_TIMER_MS) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(left, MAX_TIMER_MS))
    })
  }
}

export interface HoldWaitInput {
  eventsLog: string
  failureType: string
  /** Epoch en segundos en que empezo la espera. */
  holdStarted: number
  /** `resets_at` del terminal, si lo trajo. */
  resetsAt?: string
  env?: NodeJS.ProcessEnv
  now?: () => Date
  sleep?: (seconds: number) => Promise<void>
}

/**
 * Sondea y espera una vez: anota el ciclo en `eventsLog`, duerme y devuelve los segundos
 * dormidos. `null`, sin anotar ni dormir, si el techo ya se agoto.
 */
export async function agentHoldWait(input: HoldWaitInput): Promise<number | null> {
  const plan = planHold({
    failureType: input.failureType,
    holdStarted: input.holdStarted,
    resetsAt: input.resetsAt,
    now: (input.now ?? (() => new Date()))(),
    limits: holdLimits(input.env),
  })
  if (plan === null) return null
  appendEventsLine(input.eventsLog, plan.line)
  await (input.sleep ?? sleepSeconds)(plan.sleepSeconds)
  return plan.sleepSeconds
}

/**
 * Nombre de la carpeta en que Claude Code guarda los transcripts de un directorio: su ruta real
 * con los separadores y los puntos vueltos `-`.
 */
export function transcriptStoreSlug(realDir: string, platform: NodeJS.Platform = process.platform): string {
  return realDir.replace(platform === 'win32' ? /[\\/:.]/g : /[/.]/g, '-')
}

export interface TranscriptStoreOptions {
  env?: NodeJS.ProcessEnv
  /** Home del usuario; por defecto `os.homedir()`. */
  home?: string
}

/**
 * Transcripts de sesion que el CLI tiene de `dir` en `<config>/projects/<slug>/*.jsonl`. Es `0`
 * ante cualquier duda (sin directorio, sin store, layout distinto): quien lo consulta no reanuda.
 */
export function agentSessionTranscriptCount(dir: string, options: TranscriptStoreOptions = {}): number {
  if (dir.length === 0) return 0
  const configDir = (options.env ?? process.env).CLAUDE_CONFIG_DIR ?? ''
  try {
    const realDir = realpathSync.native(dir)
    if (!statSync(realDir).isDirectory()) return 0
    const config = configDir.length > 0 ? configDir : join(options.home ?? homedir(), '.claude')
    return readdirSync(join(config, 'projects', transcriptStoreSlug(realDir))).filter(
      (name) => name.endsWith('.jsonl') && !name.startsWith('.'),
    ).length
  } catch {
    return 0
  }
}

/**
 * Prompt de continuacion para la sonda que reanuda la sesion truncada de un stage, en vez de
 * reenviar el prompt original. Termina en salto de linea.
 */
export function agentResumePrompt(stage: string, agent: string): string {
  return `Tu sesion anterior en este mismo stage (stage ${stage}, agente ${agent}) se corto por un limite de uso o una caida del proveedor -- el pipeline ya espero (hold) a que se restableciera. Estas reanudando esa MISMA conversacion (--continue): tu memoria de trabajo, lo que ya leiste y lo que ya escribiste sigue disponible.

Continua exactamente donde quedaste. No reinicies tu analisis desde cero, no releas archivos que ya revisaste ni repitas ediciones ya hechas.

Termina tu contrato del stage, incluido dejar escrito (o completar si quedo a medias) el resumen en .claude/pipeline/summaries/stage-${stage}-${agent}.md. Si ese archivo ya existe completo, dejalo como esta; si no, escribelo ahora y agrega una linea que diga que esta sesion se reanudo tras una espera.

CORTE DE SEGURIDAD: si no tienes memoria de haber trabajado antes en este stage (stage ${stage}, agente ${agent}) -- es decir, si esta conversacion arranca aqui y no reconoces el trabajo previo que se describe arriba -- entonces la reanudacion aterrizo en la conversacion equivocada. En ese caso NO edites, crees ni borres ningun archivo y NO escribas el resumen del stage: responde unicamente la linea 'SIN_SESION_PREVIA' y termina. El pipeline lo detecta por la ausencia del resumen y relanza el stage completo desde cero.

CONTEXTO DE EJECUCION (sigue vigente): modo no-interactivo, sin humano al otro lado. PROHIBIDO hacer 'git push' o 'gh pr create': eso sigue siendo responsabilidad exclusiva del pipeline.
`
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_TIME = /^\d{2}:\d{2}:\d{2}$/

/** Epoch en segundos de `YYYY-MM-DD` y `HH:MM:SS` en hora local, o `null` si no son una fecha y una hora. */
export function localEpochAt(date: string, time: string): number | null {
  const match = LOCAL_DATE.exec(date)
  if (match === null || !LOCAL_TIME.test(time)) return null
  const [year = 0, month = 0, day = 0] = match.slice(1).map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return epochAt(new Date(year, month - 1, day), time)
}

/**
 * Ultimo anuncio de espera sin su hora ni sus corchetes (`RATE_LIMIT: esperando, proxima sonda
 * 14:37:07 (techo 20:32)`), o `null` si no hay una espera activa.
 */
export function formatHoldStatus(eventsLog: string, now: Date, fromLine = 0): string | null {
  if (!holdRecentlyActive(eventsLog, now, fromLine)) return null
  return lastHoldLine(eventsLog, fromLine)?.replace(/^\[[0-9:]+\]\[hold\] /, '') ?? null
}

/** `Xm Ys`. */
export function fmtHoldDuration(seconds: number): string {
  return `${Math.trunc(seconds / 60)}m ${seconds % 60}s`
}

const HOLD_MARK = '][hold] '

/**
 * Segundos en espera anunciados en `eventsLog` despues de la linea `fromLine`: la suma de lo que
 * va de cada anuncio a su proxima sonda. Con `issue`, solo los anuncios bajo una cabecera
 * `SESSION ... issue:<issue>`; una cabecera sin numero cierra la atribucion.
 */
export function holdSecondsInRange(eventsLog: string, now: Date, fromLine = 0, issue: string | number = ''): number {
  let content: string
  try {
    if (!statSync(eventsLog).isFile()) return 0
    content = readFileSync(eventsLog, 'utf8')
  } catch {
    return 0
  }
  const lines = content.split('\n')
  // Una ultima linea sin salto final no cuenta.
  lines.pop()
  const wanted = String(issue)
  let total = 0
  let sessionIssue = ''
  for (const line of lines.slice(Math.max(0, fromLine))) {
    if (line.length === 0) continue
    if (line.includes('SESSION ')) {
      sessionIssue = /issue:([0-9]+)/.exec(line)?.[1] ?? ''
      continue
    }
    if (wanted.length > 0 && sessionIssue !== wanted) continue
    const mark = line.indexOf(HOLD_MARK)
    if (mark === -1 || !line.includes('esperando, proxima sonda', mark + HOLD_MARK.length)) continue
    const window = holdLineWindow(line, now)
    if (window !== null) total += window.probe - window.start
  }
  return total
}

/** ` (incluye Xm Ys en espera/hold)` para anexar a un desenlace, o cadena vacia si no se espero. */
export function holdNoteSuffix(seconds: number): string {
  return seconds > 0 ? ` (incluye ${fmtHoldDuration(seconds)} en espera/hold)` : ''
}
