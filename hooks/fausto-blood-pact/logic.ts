import type { Role } from '../sprites'
import { padEnd, reasonOf, typeBadge } from '../logic'
import type { BitacoraNote, BitacoraPr, BoardItem, BoardList, InPrItem, Historian, PactMerge, PactMergePr, PipelineKind, PaneLine, PipelineResult, PipelineRun, RunStep } from '../types'

export const NEXT_ORDER_FILE = 'scripts/next-order.mts'
export const PLANNER_AGENT = 'mefisto:planner'
export const PAGE_ROWS = 5

export function nextOrderPath(root: string): string {
  return `${root.replace(/\/+$/, '')}/${NEXT_ORDER_FILE}`
}

type NextOrderJson = {
  items?: { number: number; title: string; tipo?: string | null; after?: number[]; hasDepsSection?: boolean }[]
  blocked?: unknown[]
  inPr?: { number: number; title: string; tipo?: string | null; pr: number }[]
  cycles?: unknown[]
  launch?: string | null
  infra?: number[]
  parallel?: { issues?: number[]; launch?: string | null } | null
}

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
}

/** Exit 0 (hay orden) y 1 (vacio) traen JSON valido; 2 u otro es un fallo. */
export function parseNextOrder(exitCode: number, stdout: string, stderr: string): BoardList {
  const failed = (error: string): BoardList => ({ items: [], blockedCount: 0, cycleCount: 0, launch: null, infra: [], parallel: null, error })
  if (exitCode !== 0 && exitCode !== 1) return failed(firstLine(stderr) || `exit ${exitCode}`)
  let json: NextOrderJson
  try {
    json = JSON.parse(stdout)
  } catch {
    return failed('salida de next-order no es JSON')
  }
  const items: BoardItem[] = (json.items ?? []).map(i => ({
    number: i.number,
    title: i.title,
    tipo: i.tipo ?? null,
    after: i.after ?? [],
    hasDepsSection: i.hasDepsSection !== false,
  }))
  const inPr: InPrItem[] = (Array.isArray(json.inPr) ? json.inPr : []).map(i => ({
    number: i.number,
    title: i.title,
    tipo: i.tipo ?? null,
    pr: i.pr,
  }))
  return {
    items,
    inPr,
    blockedCount: (json.blocked ?? []).length,
    cycleCount: (json.cycles ?? []).length,
    launch: json.launch ?? null,
    infra: json.infra ?? [],
    parallel: json.parallel ? { issues: json.parallel.issues ?? [], launch: json.parallel.launch ?? null } : null,
    error: null,
  }
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, Math.max(1, max - 1))}…` : one
}

/** Pagina vigente (acotada) y total de paginas; siempre al menos una. */
export function pageOf(page: number, total: number, size: number): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / size))
  return { page: Math.min(Math.max(0, page), pages - 1), pages }
}

/** Partes de una fila como en fausto-board: letra de tipo con color, etiqueta `#N titulo` (sin tecla ni posicion) y `tras #M`. */
export function rowParts(
  item: BoardItem,
  numWidth: number,
  titleMax: number,
): { letter: string; color: string; label: string; after: string } {
  const badge = typeBadge(item.tipo)
  return {
    letter: badge.letter,
    color: badge.color,
    label: rowText(item, numWidth, titleMax),
    after: reasonOf(item),
  }
}

/** Fila de un issue en PR: letra de tipo con color y `#N titulo… · PR #X` (sin tecla, toda atenuada en la consola). */
export function inPrRowParts(item: InPrItem, numWidth: number, titleMax: number): { letter: string; color: string; label: string } {
  const badge = typeBadge(item.tipo)
  const suffix = ` · PR #${item.pr}`
  return {
    letter: badge.letter,
    color: badge.color,
    label: `${padEnd(`#${item.number}`, numWidth)} ${clip(item.title, Math.max(1, titleMax - suffix.length))}${suffix}`,
  }
}

export type BoardRow = { kind: 'launch'; item: BoardItem } | { kind: 'inpr'; item: InPrItem }

/** Filas de la lista: primero los lanzables y despues los issues en PR, en el orden en que llegan. */
export function boardRowsOf(list: BoardList | null): BoardRow[] {
  if (!list) return []
  return [
    ...list.items.map((item): BoardRow => ({ kind: 'launch', item })),
    ...(list.inPr ?? []).map((item): BoardRow => ({ kind: 'inpr', item })),
  ]
}

/** Cabecera de la lista: `listos N` (solo lanzables) y, con issues en PR, `· en PR M`. */
export function listosTextOf(list: BoardList): string {
  const m = list.inPr?.length ?? 0
  return `listos ${list.items.length}${m > 0 ? ` · en PR ${m}` : ''}`
}

/** Etiqueta del boton: `#issue titulo`; la tecla la dibuja el boton y el tipo va en su letra. */
export function rowText(item: BoardItem, numWidth: number, titleMax: number): string {
  return `${padEnd(`#${item.number}`, numWidth)} ${clip(item.title, titleMax)}`
}

/** Pie sin las teclas `1`/`4` (la consola las pinta como botones): solo infra y ciclos, que condicionan el lanzamiento. */
export function footerRestOf(list: BoardList, afterButtons: boolean): string {
  const rest = [
    list.infra.length > 0 ? `infra: ${list.infra.map(n => `#${n}`).join(' ')}` : '',
    list.cycleCount > 0 ? `${list.cycleCount} en ciclo` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return rest && afterButtons ? ` · ${rest}` : rest
}

/** Cantidad de issues de una linea de lanzamiento (`/mefisto:sequential 7 8` -> 2). */
export function launchCountOf(line: string | null): number {
  return (line ?? '').split(/\s+/).filter(t => /^\d+$/.test(t)).length
}

export function isMefistoManifest(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { name?: unknown }).name === 'mefisto'
  } catch {
    return false
  }
}

export function transcriptPathOf(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

/** La ultima fila `agent-setting` del transcript de la sesion, o null. */
export function agentSettingOf(transcript: string): string | null {
  let found: string | null = null
  for (const line of transcript.split('\n')) {
    if (!line.includes('"agent-setting"')) continue
    try {
      const row = JSON.parse(line)
      if (row.type === 'agent-setting' && typeof row.agentSetting === 'string') found = row.agentSetting
    } catch {
      continue
    }
  }
  return found
}

/** El `--agent` de una linea de comando de Claude Code (`--agent x` o `--agent=x`), o null. */
export function agentFlagOf(cmdline: string): string | null {
  const m = /(?:^|\s)--agent(?:=|\s+)(\S+)/.exec(cmdline)
  return m ? (m[1] ?? null) : null
}

// ---- Incremento 2: seguimiento de corridas (MEF-ADR-0055 decision 1: lector puro) ----

export const RUNS_POLL_MS = 5_000
export const STATUS_FILE_RE = /^pipeline-status-(tdd|tooling|infra)-(\d+)(?:-(.+))?\.json$/
export const HISTORY_FILE = 'pipeline-history.jsonl'
export const DISMISSED_STORE_KEY = 'fausto-blood-pact.dismissed'
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000

/** Directorio de estado del checkout principal: el padre de `--git-common-dir`, nunca el worktree. */
export function stateDirOf(gitCommonDir: string, cwd: string): string {
  const abs = gitCommonDir.startsWith('/') ? gitCommonDir : `${cwd.replace(/\/+$/, '')}/${gitCommonDir}`
  const common = abs.replace(/\/+$/, '').replace(/\/\.git$/, '')
  return `${common}/.mefisto/pipeline`
}

/** Raiz del repo (checkout principal) a partir del directorio de estado. */
export function repoRootOf(stateDir: string): string {
  return stateDir.replace(/\/\.mefisto\/pipeline$/, '')
}

type StatusJson = {
  issue?: string | number | null
  pipeline?: string
  variant?: string | null
  started?: string
  updated?: string
  stage?: string
  state?: string
  hold?: { next_probe?: string | null } | null
  agents?: Record<string, { result?: string | null; duration?: number | null } | null> | null
  log?: string | null
  title?: string | null
  last_error?: string | null
}

/** Parseo de un status; null si no es de un pipeline conocido o no es JSON valido. */
export function parseStatus(fileName: string, raw: string): PipelineRun | null {
  const m = STATUS_FILE_RE.exec(fileName)
  if (!m) return null
  let json: StatusJson
  try {
    json = JSON.parse(raw) as StatusJson
  } catch {
    return null
  }
  const issue = Number(json.issue ?? m[2])
  if (!Number.isFinite(issue)) return null
  return {
    issue,
    pipeline: m[1] as PipelineKind,
    variant: json.variant ?? m[3] ?? null,
    started: json.started ?? '',
    updated: json.updated ?? '',
    stage: json.stage ?? '',
    state: json.state ?? '',
    nextProbe: json.hold?.next_probe ?? null,
    agents: stepsOfAgents(json.agents),
    title: typeof json.title === 'string' ? json.title : '',
    log: typeof json.log === 'string' && json.log !== '' ? json.log : null,
    ...(typeof json.last_error === 'string' && json.last_error !== '' ? { lastError: json.last_error } : {}),
  }
}

/** Pasos de `status.agents` en su orden; un `result` desconocido o vacio es `pending`. */
export function stepsOfAgents(agents: StatusJson['agents']): RunStep[] {
  if (!agents || typeof agents !== 'object') return []
  return Object.entries(agents).map(([name, v]) => {
    const r = v?.result
    const result: RunStep['result'] = r === 'passed' || r === 'running' || r === 'failed' ? r : 'pending'
    const d = v?.duration
    return typeof d === 'number' && d > 0 ? { name, result, duration: d } : { name, result }
  })
}

export const isActive = (r: PipelineRun) => r.state === 'running' || r.state === 'hold'
export const isFailure = (r: PipelineRun) => r.state === 'failed' || r.state === 'blocked' || r.state === 'gaps'

/** Agente en curso: `<n>-<agente>` -> agente; `setup`/`scaffold` y cualquier otro stage, tal cual. */
export function agentOf(stage: string): string {
  const m = /^\d+-(.+)$/.exec(stage)
  return m ? (m[1] as string) : stage
}

/** Hora local HH:MM de un timestamp ISO (`next_probe` viaja en UTC con `Z`); el texto original si no se puede leer. */
export function clockOf(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Minutos enteros desde `started` (`YYYYMMDD-HHMMSS` de los pipelines o ISO, hora local) hasta `nowMs`; null si no parsea. */
export function minutesSince(started: string, nowMs: number): number | null {
  const ms = Date.parse(/^\d{8}-\d{6}$/.test(started)
    ? `${started.slice(0, 4)}-${started.slice(4, 6)}-${started.slice(6, 8)}T${started.slice(9, 11)}:${started.slice(11, 13)}:${started.slice(13, 15)}`
    : started)
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((nowMs - ms) / 60_000))
}

/** `#N pipeline agente Mm`; en `hold`, `rate limit · sonda HH:MM` en lugar del agente. */
export function runLine(run: PipelineRun, nowMs: number): string {
  const what = run.state === 'hold' ? `rate limit · sonda ${run.nextProbe ? clockOf(run.nextProbe) : '?'}` : agentOf(run.stage)
  const mins = minutesSince(run.started, nowMs)
  return `#${run.issue} ${run.pipeline}${run.variant ? `/${run.variant}` : ''} ${what}${mins === null ? '' : ` ${mins}m`}`
}

export function runKey(repo: string, run: PipelineRun): string {
  return [repo, run.pipeline, run.issue, run.variant ?? '', run.started].join('|')
}

/** Clave de descarte (repo + pipeline + issue + variante + started). */
export const dismissKey = runKey

export type HistoryEntry = { issue: string; pipeline: string; variant: string | null; started: string; pr: string | null; title?: string }

export function parseHistory(raw: string): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      out.push({
        issue: String(j.issue ?? ''),
        pipeline: String(j.pipeline ?? ''),
        variant: typeof j.variant === 'string' ? j.variant : null,
        started: String(j.started ?? ''),
        pr: typeof j.pr === 'string' || typeof j.pr === 'number' ? String(j.pr) : null,
        title: typeof j.title === 'string' ? j.title : '',
      })
    } catch {
      continue
    }
  }
  return out
}

/** Numero de PR de la ultima entrada del historial para ese issue, pipeline y `started`; null si no hay. */
export function prOf(entries: HistoryEntry[], run: PipelineRun): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as HistoryEntry
    if (e.issue === String(run.issue) && e.pipeline === run.pipeline && e.started === run.started) {
      const m = e.pr ? /(\d+)\s*$/.exec(e.pr) : null
      return m ? (m[1] as string) : null
    }
  }
  return null
}

export type RunsView = { runs: PipelineRun[]; results: PipelineResult[]; seen: Record<string, PipelineRun> }

/**
 * Une el status actual con lo que la sesion vio activo: un status de fallo es `✗ <stage>`;
 * una corrida vista activa cuyo status desaparecio es `✓ PR #X` (el exito se reconoce por la desaparicion).
 */
export function reconcile(
  repo: string,
  statuses: PipelineRun[],
  seen: Record<string, PipelineRun>,
  history: HistoryEntry[],
  dismissed: ReadonlySet<string>,
  carried: PipelineResult[] = [],
): RunsView {
  const present = new Set(statuses.map(r => runKey(repo, r)))
  const results: PipelineResult[] = carried.filter(r => !present.has(r.key))
  const nextSeen: Record<string, PipelineRun> = {}
  for (const [key, run] of Object.entries(seen)) {
    if (present.has(key)) continue
    const pr = prOf(history, run)
    results.push({ key, issue: run.issue, pipeline: run.pipeline, ok: true, text: pr ? `✓ PR #${pr}` : '✓ completado' })
  }
  const runs: PipelineRun[] = []
  for (const run of statuses) {
    const key = runKey(repo, run)
    if (isActive(run)) {
      runs.push(run)
      nextSeen[key] = run
    } else if (isFailure(run)) {
      results.push({ key, issue: run.issue, pipeline: run.pipeline, ok: false, text: `✗ ${run.stage}` })
    }
  }
  runs.sort((a, b) => a.started.localeCompare(b.started) || a.issue - b.issue)
  return { runs, results: results.filter(r => !dismissed.has(r.key)), seen: nextSeen }
}

/** Linea de un resultado: `#N pipeline ✗ stage` o `#N pipeline ✓ PR #X`. */
export function resultLine(r: PipelineResult): string {
  return `#${r.issue} ${r.pipeline} ${r.text}`
}

export type BandView = 'runs' | 'ready-with-results' | 'ready'

/** Las corridas toman la banda solo con al menos una activa; sin activas se ven los listos (y los resultados al pie). */
export function bandViewOf(runs: readonly PipelineRun[], results: readonly PipelineResult[]): BandView {
  if (runs.some(isActive)) return 'runs'
  return results.length > 0 ? 'ready-with-results' : 'ready'
}

/** Texto de un resultado en el pie: `✓#N PR #X` o `✗#M <stage>`. */
export function resultFooterItem(r: PipelineResult): string {
  const m = /^([✓✗])\s*(.*)$/u.exec(r.text)
  return m ? `${m[1]}#${r.issue}${m[2] ? ` ${m[2]}` : ''}` : `#${r.issue} ${r.text}`
}

/** `resultados: ✓#N PR #X · ✗#M stage` recortado a `max` columnas; lo que no cabe se resume en `+N`. */
export function resultsFooterText(results: readonly PipelineResult[], max: number): string {
  const head = 'resultados: '
  const items = results.map(resultFooterItem)
  for (let shown = items.length; shown >= 1; shown -= 1) {
    const hidden = items.length - shown
    const text = `${head}${items.slice(0, shown).join(' · ')}${hidden > 0 ? ` +${hidden}` : ''}`
    if (text.length <= max) return text
  }
  return clip(`${head}${items[0] ?? ''}${items.length > 1 ? ` +${items.length - 1}` : ''}`, max)
}

/** Descarta de `dismissed` las claves del repo sin status vivo y con mas de un dia (gracia para otros panes). */
export function pruneDismissed(dismissed: string[], repo: string, liveKeys: ReadonlySet<string>, nowMs: number): string[] {
  return dismissed.filter(key => {
    if (!key.startsWith(`${repo}|`) || liveKeys.has(key)) return true
    const mins = minutesSince(key.split('|')[4] ?? '', nowMs)
    return mins === null || mins * 60_000 < PRUNE_GRACE_MS
  })
}

// ---- Incremento 3: lanzar trabajo (el comando se escribe en el prompt, nunca se envia) ----

export const SEQUENTIAL_COMMAND = '/mefisto:sequential'
export const PARALLEL_COMMAND = '/mefisto:parallel'
export const ROW_KEYS = ['5', '6', '7', '8', '9'] as const
export const CANCEL = 'Cancelar'
export const INFRA_FIRST = 'Infra primero'
export const WITHOUT_INFRA = 'Seguir sin infra'
export const WITH_MERGE = 'Con merge'
export const ONLY_PR = 'Solo PR'

export type LaunchKind = 'sequential' | 'parallel'
export type LaunchOption = { label: string; text: string | null }
export type LaunchPlan =
  | { kind: 'fill'; text: string }
  | { kind: 'ask'; question: string; options: LaunchOption[] }
  | { kind: 'none'; message: string }

/** Flags de next-order que fijan las lineas de lanzamiento que la consola escribe. */
export const NEXT_ORDER_ARGS = ['--json', '--launch-command', SEQUENTIAL_COMMAND, '--parallel-command', PARALLEL_COMMAND]

/** La linea de la tecla (`1` sequential, `4` parallel) tal como la entrego next-order; null si no hay. */
export function launchLineOf(list: BoardList, kind: LaunchKind): string | null {
  return kind === 'sequential' ? list.launch : (list.parallel?.launch ?? null)
}

/** `1`/`4`: escribe la linea; con infra lanzable ofrece desarrollarla antes (sin exigirlo). */
export function planLaunch(list: BoardList, kind: LaunchKind): LaunchPlan {
  const line = launchLineOf(list, kind)
  if (!line) return { kind: 'none', message: `No hay linea de ${kind} para lanzar.` }
  const first = list.infra[0]
  if (first === undefined) return { kind: 'fill', text: line }
  return {
    kind: 'ask',
    question: `Hay ${list.infra.length} issue(s) de infra lanzables (${list.infra.map(n => `#${n}`).join(' ')}). ¿Desarrollarlos antes?`,
    options: [
      { label: INFRA_FIRST, text: `/mefisto:infra ${first}` },
      { label: WITHOUT_INFRA, text: line },
      { label: CANCEL, text: null },
    ],
  }
}

/** `5`-`9` y `lanzar <n>`: opciones segun el `tipo` del issue; sin tipo lanzable no hay dialogo. */
export function planIssue(item: BoardItem): LaunchPlan {
  const n = item.number
  const options = (pr: LaunchOption[]): LaunchPlan => ({
    kind: 'ask',
    question: `¿Cómo desarrollar #${n}?`,
    options: [...pr, { label: CANCEL, text: null }],
  })
  switch (item.tipo) {
    case 'feature':
    case 'refactor':
    case 'projection':
      return options([
        { label: WITH_MERGE, text: `${SEQUENTIAL_COMMAND} ${n}` },
        { label: ONLY_PR, text: `/mefisto:implement ${n}` },
      ])
    case 'tooling':
      return options([
        { label: WITH_MERGE, text: `${SEQUENTIAL_COMMAND} ${n}` },
        { label: ONLY_PR, text: `/mefisto:tooling ${n}` },
      ])
    case 'infra':
      return options([{ label: ONLY_PR, text: `/mefisto:infra ${n}` }])
    default:
      return { kind: 'none', message: `#${n} no tiene un tipo lanzable.` }
  }
}

/** Texto a escribir segun la respuesta del dialogo: comparacion exacta; cierre o texto libre no escriben nada. */
export function answerText(options: LaunchOption[], answer: unknown): string | null {
  if (typeof answer !== 'string') return null
  return options.find(o => o.label === answer)?.text ?? null
}

export type LaunchTarget = { kind: 'launch'; launch: LaunchKind } | { kind: 'issue'; issue: number } | { kind: 'invalid'; message: string }

/** Argumento de `/fausto-blood-pact lanzar`: vacio o `sequential` -> 1, `parallel` -> 4, `<n>` -> ese issue si es lanzable. */
export function parseLaunchArg(arg: string, list: BoardList): LaunchTarget {
  const a = arg.trim()
  if (a === '' || a === 'sequential') return { kind: 'launch', launch: 'sequential' }
  if (a === 'parallel') return { kind: 'launch', launch: 'parallel' }
  if (/^\d+$/.test(a)) {
    const n = Number(a)
    return list.items.some(i => i.number === n)
      ? { kind: 'issue', issue: n }
      : { kind: 'invalid', message: `#${n} no está entre los lanzables.` }
  }
  return { kind: 'invalid', message: 'Uso: /fausto-blood-pact lanzar [sequential|parallel|<n>]' }
}

// ---- Incremento 4: la mascota (MEF-ADR-0055 decision 10/11; lector puro: pose del status y de los events.jsonl) ----

export type MascotPose = { role: Role; state: string }
export type LastEvent = { kind: 'tool' | 'text'; tool: string }

/** Rol de la mascota segun el sufijo del agente (el prefijo `<n>-` del stage se ignora); sin agente conocido, desarrollador. */
export function roleOfAgent(agent: string): Role {
  const name = agentOf(agent)
  if (/(^|-)(test-writer|coverage-gate)$/.test(name)) return 'tester'
  if (/(^|-)reviewer$/.test(name)) return 'revisor'
  if (/(^|-)infra-writer$/.test(name)) return 'infraestructura'
  return 'desarrollador'
}

/** La corrida activa con `updated` mas reciente (a igualdad, la de `started` mas reciente); null sin corridas activas. */
export function activeRunOf(runs: readonly PipelineRun[]): PipelineRun | null {
  let best: PipelineRun | null = null
  for (const r of runs) {
    if (!isActive(r)) continue
    if (!best || r.updated.localeCompare(best.updated) > 0 || (r.updated === best.updated && r.started.localeCompare(best.started) > 0)) best = r
  }
  return best
}

export const LOGS_DIR = 'logs'

/** Prefijo del `log_base` por pipeline: "" en tdd, `tooling-` e `iac-`. */
export function logPrefixOf(pipeline: PipelineKind): string {
  return pipeline === 'tooling' ? 'tooling-' : pipeline === 'infra' ? 'iac-' : ''
}

/** `<prefijo>stage-<stage>-<started>-issue-<n>[-<variante>]`: lo que precede a `-attempt-<k>.events.jsonl`. */
export function eventsLogBase(run: PipelineRun): string {
  return `${logPrefixOf(run.pipeline)}stage-${run.stage}-${run.started}-issue-${run.issue}${run.variant ? `-${run.variant}` : ''}`
}

/** Nombre del `events.jsonl` del intento mas alto de la corrida entre los nombres del directorio de logs; null si no hay. */
export function eventsFileOf(run: PipelineRun, names: readonly string[]): string | null {
  const base = `${eventsLogBase(run)}-attempt-`
  let best: string | null = null
  let bestAttempt = -1
  for (const raw of names) {
    const name = raw.trim()
    if (!name.startsWith(base)) continue
    const m = /^(\d+)\.events\.jsonl$/.exec(name.slice(base.length))
    if (!m) continue
    const attempt = Number(m[1])
    if (attempt > bestAttempt) {
      bestAttempt = attempt
      best = name
    }
  }
  return best
}

/** Ultimo evento relevante del `events.jsonl` (run-events v1): `tool.started` o `message` del assistant con texto; null si no hay. */
export function lastEventOf(raw: string): LastEvent | null {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (ev.type === 'tool.started') return { kind: 'tool', tool: typeof ev.tool === 'string' ? ev.tool : '' }
    if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.text === 'string' && ev.text.trim() !== '') return { kind: 'text', tool: '' }
  }
  return null
}

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/

/** Pose de la corrida activa: herramienta trabaja (o despliega), texto o sin eventos piensa, edicion del revisor corrige. */
export function poseOfRun(run: PipelineRun, last: LastEvent | null): MascotPose {
  const role = roleOfAgent(agentOf(run.stage))
  if (role === 'infraestructura') return { role, state: 'desplegando' }
  if (last?.kind !== 'tool') return { role, state: 'pensando' }
  if (role === 'revisor' && EDIT_TOOLS.test(last.tool)) return { role, state: 'corrigiendo' }
  return { role, state: 'trabajando' }
}

/** Pose con solo resultados: `✓` revisor aprobado (infra arriba), `✗` desarrollador error (infra caido); null sin resultados. */
export function poseOfResults(results: readonly PipelineResult[]): MascotPose | null {
  const r = results[results.length - 1]
  if (!r) return null
  const isInfra = r.pipeline === 'infra'
  if (r.ok) return isInfra ? { role: 'infraestructura', state: 'arriba' } : { role: 'revisor', state: 'aprobado' }
  return isInfra ? { role: 'infraestructura', state: 'caido' } : { role: 'desarrollador', state: 'error' }
}

// ---- Incremento 5: mergear / ver el PR de una corrida terminada ----
export const PR_CHECK_MS = 15_000
export const MERGE_ALL = 'Todos'
export const MERGE_CANCEL = 'Cancelar'
const MERGE_MAX_OPTIONS = 3

export type ResultPr = { pr: string; issue: number; pipeline: PipelineKind; key: string }

/** Numero de PR de un resultado `✓ PR #X`; null si es `✗` o `✓ completado`. */
export function prOfResult(r: PipelineResult): string | null {
  return r.ok ? (/^✓ PR #(\d+)/.exec(r.text)?.[1] ?? null) : null
}

/** PRs de los `✓` visibles, sin repetir, del mas reciente (numero mayor) al mas antiguo. */
export function resultPrs(results: PipelineResult[]): ResultPr[] {
  const found = new Map<string, ResultPr>()
  for (const r of results) {
    const pr = prOfResult(r)
    if (pr && !found.has(pr)) found.set(pr, { pr, issue: r.issue, pipeline: r.pipeline, key: r.key })
  }
  return [...found.values()].sort((a, b) => Number(b.pr) - Number(a.pr))
}

const prLabel = (p: ResultPr) => `#${p.pr} · #${p.issue} ${p.pipeline}`

/** Opciones del dialogo de merge: con un PR, ese y cancelar; con varios, "Todos" y hasta 3 PRs mas recientes. */
export function mergeOptions(prs: ResultPr[]): string[] {
  if (prs.length === 1 && prs[0]) return [`Mergear #${prs[0].pr}`, MERGE_CANCEL]
  return [MERGE_ALL, ...prs.slice(0, MERGE_MAX_OPTIONS).map(prLabel)]
}

/** Opciones de "cual PR ver": hasta 3 PRs mas recientes; los demas numeros van en la opcion de texto. */
export function viewOptions(prs: ResultPr[]): string[] {
  return prs.slice(0, MERGE_MAX_OPTIONS).map(prLabel)
}

/**
 * Argumentos de /mefisto:merge a partir de la respuesta (opciones marcadas unidas por ", " y/o texto libre):
 * solo numeros de PRs `✓` conocidos, nunca `--all`. Null si no queda ninguno (cancelar o nada elegido).
 */
export function mergeArgsOf(answer: string | null, options: string[], prs: ResultPr[]): string | null {
  return argsOfAnswer(answer, options, prs.map(p => p.pr))
}

/** Comun a ambos dialogos de merge: un solo numero exige su opcion; "Todos" pasa `allArg` si lo hay, o todos los listados; si no, elegidos + texto libre. */
function argsOfAnswer(answer: string | null, options: string[], numbersListed: string[], allArg: string | null = null): string | null {
  if (answer === null) return null
  if (numbersListed.length === 1) return answer === options[0] && numbersListed[0] ? numbersListed[0] : null
  if (answer.includes(MERGE_ALL)) return allArg ?? numbersListed.join(' ')
  const known = new Set(numbersListed)
  let rest = answer
  const numbers: string[] = []
  for (const option of options) {
    if (option === MERGE_ALL || !rest.includes(option)) continue
    rest = rest.replace(option, '')
    const n = /^#(\d+)/.exec(option)?.[1]
    if (n) numbers.push(n)
  }
  numbers.push(...(rest.match(/\d+/g) ?? []))
  const picked = [...new Set(numbers)].filter(n => known.has(n))
  return picked.length > 0 ? picked.join(' ') : null
}

/** El PR que eligio la persona para verlo: un numero de la respuesta que sea de un `✓`. */
export function viewPrOf(answer: string | null, prs: ResultPr[]): string | null {
  if (answer === null) return null
  const known = new Set(prs.map(p => p.pr))
  const n = (/#(\d+)/.exec(answer)?.[1] ?? /\d+/.exec(answer)?.[0]) ?? null
  return n && known.has(n) ? n : null
}

/** Numeros de PR de un argumento de comando (`merge 12 13`, `#12`); invalid = los que no son de un `✓`. */
export function parsePrArgs(arg: string, prs: ResultPr[]): { prs: string[]; invalid: string[] } {
  const known = new Set(prs.map(p => p.pr))
  const given = [...new Set((arg.match(/\d+/g) ?? []))]
  return { prs: given.filter(n => known.has(n)), invalid: given.filter(n => !known.has(n)) }
}

/** Toast del merge: en infra el issue lo cierra el job `apply` de CI tras el merge (MEF-ADR-0022). */
export function mergeToast(args: string, prs: ResultPr[]): string {
  const nums = args.split(' ')
  const hasInfra = prs.some(p => nums.includes(p.pr) && p.pipeline === 'infra')
  return `/mefisto:merge ${args} en cola${hasInfra ? ' · el issue de infra se cierra cuando termine el apply de CI' : ''}`
}

// ---- Incremento 6: mergear PRs abiertos desde el reposo (decision 11: referencia de experiencia) ----
export const OPEN_PRS_ARGS = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,isDraft,headRefName']

export type OpenPr = { number: string; title: string; isFieldNote: boolean }

/** Rama de los PRs de field notes del planner: `docs/planner-field-notes-*`. */
export const isFieldNoteBranch = (branch: string): boolean => /^docs\/planner-field-notes-/.test(branch)

/** PRs abiertos que no son borradores (field notes marcadas con `isFieldNote`); el mas reciente (numero mayor) primero. Vacio si no es JSON. */
export function parseOpenPrs(raw: string): OpenPr[] {
  let rows: unknown
  try {
    rows = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: OpenPr[] = []
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r.number !== 'number' || r.isDraft === true) continue
    out.push({
      number: String(r.number),
      title: typeof r.title === 'string' ? r.title : '',
      isFieldNote: typeof r.headRefName === 'string' && isFieldNoteBranch(r.headRefName),
    })
  }
  return out.sort((a, b) => Number(b.number) - Number(a.number))
}

const openPrLabel = (p: OpenPr) => `#${p.number} ${clip(p.title, 60)}`.trim()

/** Opciones del dialogo: con un PR, ese y cancelar; con varios, "Todos" y los 3 mas recientes. */
export function openPrOptions(prs: OpenPr[]): string[] {
  if (prs.length === 1 && prs[0]) return [openPrLabel(prs[0]), MERGE_CANCEL]
  return [MERGE_ALL, ...prs.slice(0, MERGE_MAX_OPTIONS).map(openPrLabel)]
}

/** Argumentos de /mefisto:merge: "Todos" es `--all`; si no, los elegidos y los del texto libre. */
export function openPrArgsOf(answer: string | null, options: string[], prs: OpenPr[]): string | null {
  return argsOfAnswer(answer, options, prs.map(p => p.number), '--all')
}

// ---- Incremento 7: seguir un sequential como lote (MEF-ADR-0055 decision 10/11; #2202 escribe el status) ----
export const BATCH_STATUS_FILE = 'pipeline-status-batch.json'
/** Senal de parada suave (MEF-ADR-0017), relativa a la raiz del checkout principal. */
export const BATCH_STOP_FILE = 'pipeline-state/batch-stop'
export const BATCH_STOP_ANSWER = 'Detener tras el actual'
export const BATCH_KEEP_ANSWER = 'Seguir'

export type BatchIssueStatus = 'pendiente' | 'en-curso' | 'mergeado' | 'fallido' | 'aplazado' | 'saltado'
export type BatchState = 'running' | 'completed' | 'failed' | 'stopped'
export type BatchIssue = { issue: number; status: BatchIssueStatus; pr: string | null; detail: string }
export type BatchStatus = {
  pipeline: string
  started: string
  state: BatchState
  current: number | null
  stopRequested: boolean
  holdSeconds: number
  issues: BatchIssue[]
  /** Ruta del log del lote (`log` del status), que acumula todos los issues. */
  log?: string
}

const BATCH_ISSUE_STATUSES: readonly string[] = ['pendiente', 'en-curso', 'mergeado', 'fallido', 'aplazado', 'saltado']
const BATCH_STATES: readonly string[] = ['running', 'completed', 'failed', 'stopped']

export function batchStatusPath(stateDir: string): string {
  return `${stateDir.replace(/\/+$/, '')}/${BATCH_STATUS_FILE}`
}

/** Ruta de la senal de parada: la raiz del checkout principal (donde `batch-pipeline.mts` lee su cwd), nunca el worktree. */
export function batchStopPath(repoRoot: string): string {
  return `${repoRoot.replace(/\/+$/, '')}/${BATCH_STOP_FILE}`
}

function prNumberOf(value: unknown): string | null {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  return /(\d+)\s*$/.exec(value)?.[1] ?? null
}

/** Parseo de `pipeline-status-batch.json`; null si no es JSON valido o no trae un `state` conocido. */
export function parseBatchStatus(raw: string): BatchStatus | null {
  let json: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    json = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof json.state !== 'string' || !BATCH_STATES.includes(json.state)) return null
  const issues: BatchIssue[] = []
  for (const row of Array.isArray(json.issues) ? (json.issues as Record<string, unknown>[]) : []) {
    const issue = Number(row?.issue)
    if (!Number.isFinite(issue)) continue
    const status = typeof row.status === 'string' && BATCH_ISSUE_STATUSES.includes(row.status) ? (row.status as BatchIssueStatus) : 'pendiente'
    issues.push({ issue, status, pr: prNumberOf(row.pr), detail: typeof row.detail === 'string' ? row.detail : '' })
  }
  const current = Number(json.current)
  return {
    pipeline: typeof json.pipeline === 'string' ? json.pipeline : 'sequential',
    started: typeof json.started === 'string' ? json.started : '',
    state: json.state as BatchState,
    current: json.current !== null && json.current !== undefined && json.current !== '' && Number.isFinite(current) ? current : null,
    stopRequested: json.stop_requested === true,
    holdSeconds: typeof json.hold_seconds === 'number' && json.hold_seconds > 0 ? json.hold_seconds : 0,
    issues,
    ...(typeof json.log === 'string' && json.log !== '' ? { log: json.log } : {}),
  }
}

export const isBatchRunning = (b: BatchStatus) => b.state === 'running'

/** Pose del lote sin corrida activa, como la cinta interna: terminado es el revisor aprobado; el desarrollador no tiene `aprobado`. */
export function poseOfBatch(b: { state: BatchState }): MascotPose {
  if (b.state === 'failed') return { role: 'desarrollador', state: 'error' }
  if (b.state === 'completed') return { role: 'revisor', state: 'aprobado' }
  return { role: 'desarrollador', state: 'pensando' }
}

export type BatchCounts = { merged: number; failed: number; deferred: number; skipped: number; total: number }

export function batchCounts(b: BatchStatus): BatchCounts {
  const count = (s: BatchIssueStatus) => b.issues.filter(i => i.status === s).length
  return { merged: count('mergeado'), failed: count('fallido'), deferred: count('aplazado'), skipped: count('saltado'), total: b.issues.length }
}

/** Marca de la cola: `✓` mergeado, `●` en curso, `✗` fallido, `⏸` aplazado, `-` saltado, `·` pendiente. */
export function batchMark(status: BatchIssueStatus): string {
  switch (status) {
    case 'mergeado':
      return '✓'
    case 'en-curso':
      return '●'
    case 'fallido':
      return '✗'
    case 'aplazado':
      return '⏸'
    case 'saltado':
      return '-'
    default:
      return '·'
  }
}

/** Cola en una linea, separada por ` ─ `: `✓ #12 ─ ● #13 reviewer ─ ⏸ #14`; el issue en curso lleva su paso si se conoce. */
export function batchQueueText(b: BatchStatus, step?: string | null): string {
  return batchQueueMarks(b, step).map((m, n) => `${n > 0 ? ' \u2500 ' : ''}${m.text}`).join('')
}

/** Marcas de la cola con color (undefined = atenuado): `✓` success, `●` warning, `✗` error, `⏸` y `○` atenuados. */
export function batchQueueMarks(b: BatchStatus, step?: string | null): { text: string; color: string | undefined }[] {
  const cur = batchCurrentOf(b)
  return b.issues.map(i => {
    const color = i.status === 'mergeado' ? 'success' : i.status === 'en-curso' ? 'warning' : i.status === 'fallido' ? 'error' : undefined
    const mark = i.status === 'pendiente' ? '\u25cb' : batchMark(i.status)
    const withStep = step && cur && cur.issue === i.issue && i.status === 'en-curso' ? ` ${step}` : ''
    return { text: `${mark} #${i.issue}${withStep}`, color }
  })
}

/** Cabecera del lote en curso: `sequential M/N` (M = mergeados + fallidos), tiempo `MM:SS` desde `started` y, con parada pedida, `se detiene tras #N`. */
export function batchRunningHeader(b: BatchStatus, nowMs: number): { progress: string; time: string; stopNote: string } {
  const c = batchCounts(b)
  const parsed = stampToMs(b.started) || Date.parse(b.started)
  const startedMs = Number.isNaN(parsed) ? 0 : parsed
  return {
    progress: `sequential ${c.merged + c.failed}/${c.total}`,
    time: startedMs > 0 ? elapsedText(nowMs - startedMs) : '',
    stopNote: b.stopRequested ? `se detiene tras #${b.current ?? batchCurrentOf(b)?.issue ?? '\u2026'}` : '',
  }
}

/** El eslabon en curso: `current` del status o, si no, el primero `en-curso`; null si no hay. */
export function batchCurrentOf(b: BatchStatus): BatchIssue | null {
  return b.issues.find(i => i.issue === b.current) ?? b.issues.find(i => i.status === 'en-curso') ?? null
}

/** PR del eslabon en curso o, si aun no tiene, el del ultimo `mergeado` con PR; null sin PR. */
export function batchPrOf(b: BatchStatus): string | null {
  const current = batchCurrentOf(b)
  if (current?.pr) return current.pr
  for (let i = b.issues.length - 1; i >= 0; i -= 1) {
    const row = b.issues[i] as BatchIssue
    if (row.status === 'mergeado' && row.pr) return row.pr
  }
  return null
}

/** Corrida suelta del eslabon en curso (su propio status), para pipeline, agente, tiempo y mascota. */
export function batchRunOf(b: BatchStatus, runs: readonly PipelineRun[]): PipelineRun | null {
  const current = batchCurrentOf(b)
  if (!current) return null
  return runs.filter(r => r.issue === current.issue && isActive(r)).sort((a, c) => c.updated.localeCompare(a.updated))[0] ?? null
}

/** Espera por rate limit en curso del eslabon: `en espera por rate limit · próxima sonda HH:MM`; vacio si no esta en `hold`. */
export function batchHoldLine(run: PipelineRun | null): string {
  if (!run || run.state !== 'hold') return ''
  return `en espera por rate limit · próxima sonda ${run.nextProbe ? clockOf(run.nextProbe) : '?'}`
}

/** Minutos de espera por rate limit acumulados, como `Mm`; vacio sin espera. */
export function holdText(holdSeconds: number): string {
  return holdSeconds > 0 ? `${Math.max(1, Math.round(holdSeconds / 60))}m` : ''
}

export type IssueStats = { durationMs: number; costUsd: number | null; title: string | null; finishedMs: number }

/** `YYYYMMDD-HHMMSS` a milisegundos locales; 0 si no tiene ese formato. */
export function stampToMs(stamp: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!m) return 0
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = m.slice(1).map(Number)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/** Pipelines publicados que escriben el historial de un issue del lote. */
export const BATCH_HISTORY_PIPELINES = ['tdd', 'tooling', 'iac']

type StatsEntry = {
  issue?: string
  pipeline?: string
  started?: string
  finished?: string
  title?: string
  agents?: Record<string, { metrics?: { estimated_cost_usd?: number | null } }>
}

/**
 * Duracion y costo de la ultima corrida de cada issue en el historial, arrancada en o despues de `sinceMs`.
 * El costo suma `agents.*.metrics.estimated_cost_usd` (null si ningun agente lo informa).
 */
export function issueStatsFromHistory(raw: string, issues: readonly string[], sinceMs: number): Record<string, IssueStats> {
  const out: Record<string, IssueStats> = {}
  for (const line of raw.split('\n')) {
    let h: StatsEntry
    try {
      h = JSON.parse(line)
    } catch {
      continue
    }
    const issue = String(h.issue ?? '')
    if (!BATCH_HISTORY_PIPELINES.includes(h.pipeline ?? '') || !issues.includes(issue) || !h.started || !h.finished) continue
    const startedMs = stampToMs(h.started)
    const finishedMs = new Date(h.finished).getTime()
    if (startedMs + 1000 < sinceMs || Number.isNaN(finishedMs)) continue
    const costs = Object.values(h.agents ?? {})
      .map(a => a.metrics?.estimated_cost_usd)
      .filter((c): c is number => typeof c === 'number')
    out[issue] = {
      durationMs: Math.max(0, finishedMs - startedMs),
      costUsd: costs.length > 0 ? costs.reduce((x, y) => x + y, 0) : null,
      title: typeof h.title === 'string' && h.title !== '' ? h.title : null,
      finishedMs,
    }
  }
  return out
}

/** Issues sin estadisticas o con estadisticas sin titulo: un titulo vacio en cache no se corrige solo. */
export function statsPending(issues: readonly string[], stats: Record<string, IssueStats>): string[] {
  return issues.filter(issue => !stats[issue] || stats[issue].title === null)
}

export const fmtCost = (usd: number | null) => (usd === null ? '$?' : `$${usd.toFixed(2)}`)

/** Total de lo terminado: duracion sumada y costo sumado (sin contar los que no lo informan). */
export function statsTotal(stats: IssueStats[]): IssueStats {
  const costs = stats.map(s => s.costUsd).filter((c): c is number => c !== null)
  return {
    durationMs: stats.reduce((a, s) => a + s.durationMs, 0),
    costUsd: costs.length > 0 ? costs.reduce((a, c) => a + c, 0) : null,
    title: null,
    finishedMs: 0,
  }
}

/** Titulo recortado con `...` a `width` columnas y rellenado a ese ancho (vacio si no hay titulo o espacio). */
export function fitTitle(title: string | null | undefined, width: number): string {
  if (width <= 0) return ''
  const t = (title ?? '').trim()
  return padEnd(t.length > width ? `${t.slice(0, width - 1)}…` : t, width)
}

/** Ancho de la columna de titulo de la tabla de cierre; 0 si no cabe un titulo legible. */
export function summaryTitleWidth(inner: number): number {
  const w = Math.min(60, inner - 38)
  return w < 8 ? 0 : w
}

/** Resumen de cierre con marcas: `✓ N mergeados · ✗ N fallidos · ⏸ N aplazados · espera Xm` (omite lo que esta en cero). */
export function batchSummaryMarks(b: BatchStatus): string {
  const c = batchCounts(b)
  const hold = holdText(b.holdSeconds)
  return [
    `✓ ${c.merged} mergeados`,
    c.failed > 0 ? `✗ ${c.failed} fallidos` : '',
    c.deferred > 0 ? `⏸ ${c.deferred} aplazados` : '',
    hold ? `espera ${hold}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Estado del cierre en la cabecera: `terminado`, `detenido` o `con fallos`. */
export function batchEndLabel(state: BatchState): string {
  return state === 'completed' ? 'terminado' : state === 'stopped' ? 'detenido' : 'con fallos'
}

/** Fila de la tabla de cierre (sin la marca): issue, titulo, PR, duracion y costo; `…` sin entrada de historial. */
export function closeRowText(i: BatchIssue, st: IssueStats | undefined, titleW: number): { lead: string; trail: string } {
  const lead = `${padEnd(`#${i.issue}`, 7)} ${titleW > 0 ? `${fitTitle(st?.title, titleW)} ` : ''}${padEnd(i.pr ? `PR #${i.pr}` : 'sin PR', 10)} `
  return { lead, trail: st ? `${padEnd(elapsedText(st.durationMs), 8)} ${fmtCost(st.costUsd)}` : '…' }
}

/** Fila `●` del issue en curso: `#N`, titulo, `PR #X` o `…`, tiempo desde `startedMs` y `…` de costo. */
export function runningRowText(issue: number, pr: string | null, title: string | null, startedMs: number, nowMs: number, titleW: number): { lead: string; trail: string } {
  const lead = `${padEnd(`#${issue}`, 7)} ${titleW > 0 ? `${fitTitle(title, titleW)} ` : ''}${padEnd(pr ? `PR #${pr}` : '…', 10)} `
  return { lead, trail: `${padEnd(startedMs > 0 ? elapsedText(nowMs - startedMs) : '…', 8)} …` }
}

/** Corrida de la fila `●` y, si ya termino, el instante en que se congela su tiempo. */
export type CurrentRow = { run: PipelineRun; endMs: number | null }

/**
 * Fila `●` del lote en curso: la corrida activa del eslabon; si su status ya no esta activo mientras el issue
 * espera su merge, la ultima vista, con el tiempo congelado en `nowMs` (como la cinta interna). Null sin lote en curso.
 */
export function nextCurrentRow(b: BatchStatus, live: PipelineRun | null, prev: CurrentRow | null, nowMs: number): CurrentRow | null {
  if (!isBatchRunning(b)) return null
  if (live) return { run: live, endMs: null }
  const cur = batchCurrentOf(b)
  if (!prev || !cur || prev.run.issue !== cur.issue || stampToMs(prev.run.started) < stampToMs(b.started)) return null
  return prev.endMs === null ? { run: prev.run, endMs: nowMs } : prev
}

/** Total con el issue en curso: suma su tiempo transcurrido a los terminados; el costo sigue siendo solo el de los terminados. */
export function totalWithRunning(total: IssueStats, startedMs: number, nowMs: number): IssueStats {
  return startedMs > 0 ? { ...total, durationMs: total.durationMs + Math.max(0, nowMs - startedMs) } : total
}

/** Fila `total` de la tabla de cierre, alineada con las columnas de `closeRowText`. */
export function closeTotalText(count: number, total: IssueStats, titleW: number): string {
  const titleCol = titleW > 0 ? titleW + 1 : 0
  return `  total ${padEnd(String(count), 12 + titleCol)} ${padEnd(elapsedText(total.durationMs), 8)} ${fmtCost(total.costUsd)}`
}

/** Momento de cierre del lote: el ultimo `finished` del historial entre sus issues; null sin entradas. */
export function batchEndFromStats(stats: Record<string, IssueStats>): number | null {
  const all = Object.values(stats).map(s => s.finishedMs)
  return all.length > 0 ? Math.max(...all) : null
}

/** Issues que pasaron a `mergeado` entre dos lecturas; con `prev` vacio no hay toasts (el primer vistazo no anuncia). */
export function newlyMerged(prev: readonly BatchIssue[] | null, next: readonly BatchIssue[]): BatchIssue[] {
  if (!prev) return []
  const before = new Map(prev.map(i => [i.issue, i.status]))
  return next.filter(i => i.status === 'mergeado' && before.get(i.issue) !== 'mergeado')
}

/** Clave de descarte persistente del lote: repo + `started`. */
export function batchDismissKey(repo: string, b: BatchStatus): string {
  return [repo, 'batch', b.started].join('|')
}

/** Pregunta del dialogo de parada. */
export function stopQuestion(b: BatchStatus): string {
  return `¿Detener el sequential tras ${b.current ? `#${b.current}` : 'el issue en curso'}?`
}

/** `1` se ofrece solo con el lote corriendo y sin parada pedida. */
export const canStopBatch = (b: BatchStatus | null): boolean => b !== null && isBatchRunning(b) && !b.stopRequested

// ---- Incremento 8: la cinta de merge en vivo (el estado vive en $.state; no toca `.mefisto/pipeline/`) ----
export const MERGE_POLL_MS = 5_000
export const MERGE_RIBBON_HIDE_MS = 15_000

/** Argumentos de un merge de `pr-sync.mts` (`--merge`): los numeros de PR o `--all`; null si el comando no es un merge de ese script. */
export function mergeRunArgsOf(command: string): string | null {
  const m = /pr-sync\.mts["']?(?=\s|$|[;&|])([^;&|]*)/.exec(command)
  if (!m) return null
  const tokens = (m[1] ?? '').split(/\s+/).filter(t => t !== '')
  if (!tokens.includes('--merge')) return null
  if (tokens.includes('--all')) return '--all'
  return tokens.filter(t => /^\d+$/.test(t)).join(' ')
}

/** Los PRs de la cinta: con `--all`, los abiertos que se pasen; si no, los numeros de los argumentos, con el titulo que se conozca. */
export function mergePrsOf(args: string, open: readonly OpenPr[]): PactMergePr[] {
  const pending = (num: string, title: string): PactMergePr => ({ num, title, estado: 'pendiente' })
  if (/(^|\s)--all(\s|$)/.test(args)) return open.map(p => pending(p.number, p.title))
  const nums = [...new Set(args.match(/\d+/g) ?? [])]
  return nums.map(n => pending(n, open.find(p => p.number === n)?.title ?? ''))
}

/** Pasa a `mergeado` los PRs pendientes indicados; devuelve la misma cinta si nada cambio. Un mergeado no vuelve atras. */
export function withMerged(run: PactMerge, merged: readonly string[]): PactMerge {
  if (!run.prs.some(p => p.estado === 'pendiente' && merged.includes(p.num))) return run
  return { ...run, prs: run.prs.map(p => (p.estado === 'pendiente' && merged.includes(p.num) ? { ...p, estado: 'mergeado' } : p)) }
}

/** Cierra la cinta: lo que siga pendiente queda `fallido` (`✗ no mergeado`). */
export function finishMerge(run: PactMerge, now: number): PactMerge {
  if (run.finishedMs !== null) return run
  return { ...run, prs: run.prs.map(p => (p.estado === 'pendiente' ? { ...p, estado: 'fallido' } : p)), finishedMs: now }
}

export function mergeCounts(run: PactMerge) {
  return {
    pending: run.prs.filter(p => p.estado === 'pendiente').length,
    merged: run.prs.filter(p => p.estado === 'mergeado').length,
    failed: run.prs.filter(p => p.estado === 'fallido').length,
  }
}

/** Cabecera de la cinta: `merge N/M` (N cuenta los mergeados) y, al terminar, `terminado`. */
export function mergeRibbonHeader(run: PactMerge, nowMs: number): string {
  const c = mergeCounts(run)
  const mins = Math.max(0, Math.floor(((run.finishedMs ?? nowMs) - run.startedMs) / 60_000))
  return `merge ${c.merged}/${run.prs.length} · ${mins}m${run.finishedMs === null ? '' : ' · terminado'}`
}

/** Linea de un PR: `· #12 titulo` pendiente, `✓` mergeado, `✗ ... no mergeado` fallido. */
export function mergeRibbonLine(p: PactMergePr, max: number): string {
  const mark = p.estado === 'mergeado' ? '✓' : p.estado === 'fallido' ? '✗' : '·'
  const tail = p.estado === 'fallido' ? ' · no mergeado' : ''
  const head = `${mark} #${p.num}`
  const room = max - head.length - tail.length - 1
  const title = p.title.trim() === '' || room < 2 ? '' : ` ${clip(p.title, room)}`
  return `${head}${title}${tail}`
}

/** Filas de la cinta: los pendientes primero, luego los fallidos y, al final, los mergeados. */
export function mergeRibbonRows(run: PactMerge): PactMergePr[] {
  return [
    ...run.prs.filter(p => p.estado === 'pendiente'),
    ...run.prs.filter(p => p.estado === 'fallido'),
    ...run.prs.filter(p => p.estado === 'mergeado'),
  ]
}

/** Toast de cierre: `N mergeados · M fallidos`. */
export function mergeSummaryText(run: PactMerge): string {
  const c = mergeCounts(run)
  return `${c.merged} mergeados · ${c.failed} fallidos`
}

/** Vencimiento al dibujar: una cinta terminada hace mas de 15 s se oculta; una en curso, nunca. */
export function isMergeRibbonExpired(run: PactMerge | null, nowMs: number): boolean {
  return run !== null && run.finishedMs !== null && nowMs - run.finishedMs > MERGE_RIBBON_HIDE_MS
}

/** Precedencia de la banda: el lote de sequential primero, luego la cinta de merge vigente, luego corridas y reposo. */
export function mergeRibbonShown(batch: BatchStatus | null, run: PactMerge | null, nowMs: number): PactMerge | null {
  return batch === null && run !== null && !isMergeRibbonExpired(run, nowMs) ? run : null
}

// ---- Incremento 9: la bitacora (boton `3: bitacora N` y la cinta del historiador) ----
export const HISTORIAN_DONE_MS = 8_000
export const NOTES_POLL_MS = 3_000
export const FIELD_NOTES_DIR = 'docs/bitacora/field-notes'
export const PROCESSED_NOTES_DIR = `${FIELD_NOTES_DIR}/procesadas`
export const BITACORA_PR_ARGS = ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,files']
const AGENT_ACTIVE = new Set(['pending', 'running', 'waiting'])

/** El tipo del agente lleva el prefijo del plugin (`mefisto:historiador`); se acepta con o sin el. */
export const isHistorianType = (type: string): boolean => /(^|:)historiador$/.test(type)

/** Un agente de `$.agent.list()` que aun no termina. */
export const isAgentActive = (status: string): boolean => AGENT_ACTIVE.has(status)

/** Field notes `.md` de `docs/bitacora/field-notes/` (sin bajar a `procesadas/`). */
export function fieldNotesIn(names: readonly string[]): number {
  return names.filter(n => n.endsWith('.md')).length
}

/** N de `3: bitacora N`: las field notes de main mas los PRs de field notes abiertos. */
export const bitacoraCount = (fieldNotes: number | null, prs: readonly OpenPr[]): number => (fieldNotes ?? 0) + prs.filter(p => p.isFieldNote).length

/** Pregunta del dialogo de integrar la bitacora. */
export function bitacoraQuestion(local: number, prCount: number): string {
  return `¿Integrar la bitácora? ${local} field notes en main${prCount > 0 ? ` y ${prCount} en PRs sin mergear` : ''}`
}

export const bitacoraIntegrateLabel = (prCount: number): string => (prCount > 0 ? `Mergear sus ${prCount} PRs e integrar` : 'Integrar')

/** El prompt de usuario: mergear los PRs de field notes, traer main al dia y correr /mefisto:bitacora. */
export function bitacoraPrompt(fieldNotePrs: readonly (number | string)[]): string {
  const merge = fieldNotePrs.length > 0
    ? `mergea los PRs de field notes ${fieldNotePrs.map(n => `#${n}`).join(' ')} con /mefisto:merge, `
    : ''
  return `Integra la bitacora: ${merge}pon el checkout en main al dia (git switch main && git pull --ff-only) y luego corre /mefisto:bitacora.`
}

/** Estado de la cinta del historiador; `prev` tal cual si nada cambio. */
export function historianFrom(prev: Historian | null, active: boolean, now: number): Historian | null {
  if (active) return prev && !prev.finishedMs ? prev : { startedMs: now, finishedMs: null, notes: [], pr: null }
  return prev && !prev.finishedMs ? { ...prev, finishedMs: now } : prev
}

/** Terminada hace mas de `HISTORIAN_DONE_MS` (sin PR esperando al usuario) la cinta no existe; en curso nunca vence. */
export function liveHistorian(h: Historian | null, nowMs: number): Historian | null {
  if (!h || !h.finishedMs || h.pr) return h
  return nowMs - h.finishedMs > HISTORIAN_DONE_MS ? null : h
}

const FIELD_NOTE_PATH = /^docs\/bitacora\/field-notes\/([^/]+\.md)$/

/** Field notes a integrar: las locales (`.md`) y las de las rutas de los PRs de field notes, sin repetir. */
export function fieldNoteNamesOf(local: readonly string[], prPaths: readonly string[]): string[] {
  const fromPrs = prPaths.map(p => FIELD_NOTE_PATH.exec(p)?.[1]).filter((n): n is string => !!n)
  return [...new Set([...local.filter(n => n.endsWith('.md')), ...fromPrs])].sort()
}

export const pendingNotes = (names: readonly string[]): BitacoraNote[] => names.map(name => ({ name, estado: 'pendiente' }))

/** Pasa a procesada cada nota que ya aparece en `procesadas/`; `h` tal cual si nada cambio. */
export function withProcessedNotes<T extends { notes: BitacoraNote[] }>(h: T, processed: readonly string[]): T {
  const done = new Set(processed)
  if (!h.notes.some(n => n.estado === 'pendiente' && done.has(n.name))) return h
  return { ...h, notes: h.notes.map(n => (n.estado === 'pendiente' && done.has(n.name) ? { ...n, estado: 'procesada' } : n)) }
}

/** Filas de la cinta: las pendientes `●` primero y luego las procesadas `✓`. */
export function orderedNotes(notes: readonly BitacoraNote[]): BitacoraNote[] {
  return [...notes.filter(n => n.estado === 'pendiente'), ...notes.filter(n => n.estado === 'procesada')]
}

export const noteLine = (n: BitacoraNote): string => `${n.estado === 'procesada' ? '✓' : '●'} ${n.name}`

/** `mm:ss` (o `h:mm:ss`). */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(total % 60)}` : `${p(m)}:${p(total % 60)}`
}

/** `historiador escribiendo la bitácora k/n mm:ss` (sin `k/n` mientras no se conocen las notas). */
export function historianHeader(h: Historian, nowMs: number): string {
  const done = h.notes.filter(n => n.estado === 'procesada').length
  return `historiador escribiendo la bitácora ${h.notes.length > 0 ? `${done}/${h.notes.length} ` : ''}${elapsedText(nowMs - h.startedMs)}`
}

/** El PR de bitacora abierto (`gh pr list --json number,title,headRefName,files`): solo toca `docs/bitacora/` y no es de la rama de field notes. El mas reciente. */
export function bitacoraPrOf(stdout: string): BitacoraPr | null {
  try {
    const rows = JSON.parse(stdout) as { number: number; title: string; headRefName?: string; files?: { path: string }[] }[]
    const pr = rows
      .filter(r => !isFieldNoteBranch(r.headRefName ?? ''))
      .filter(r => (r.files ?? []).length > 0 && (r.files ?? []).every(f => f.path.startsWith('docs/bitacora/')))
      .sort((a, b) => b.number - a.number)[0]
    return pr ? { number: pr.number, title: pr.title } : null
  } catch {
    return null
  }
}

// ---- Vista de corrida con pasos y ultimas lineas (#2320; lector puro de status, log del pipeline y events.jsonl) ----

export const BAND_LOG_ROWS = 3
/** Lineas que se leen del log: el filtro de la vista del lote descarta separadores y lineas sin hora. */
export const BAND_FETCH_ROWS = 12
export const LAUNCH_POLL_WINDOW_MS = 120_000
export const LOG_TAIL_BYTES = 8192

const PIPELINE_SCRIPTS = /(^|[\s/"'=])(batch|launch|tdd|tooling|iac)-pipeline\.mts(\s|$|["';|&])/

/** True si el comando Bash lanza un pipeline del consumidor (`*-pipeline.mts`). */
export function isPipelineLaunch(command: string | null | undefined): boolean {
  return typeof command === 'string' && PIPELINE_SCRIPTS.test(command)
}

export const STEP_MARKS: Record<RunStep['result'], { mark: string; color: string | undefined }> = {
  passed: { mark: '\u2713', color: 'success' },
  running: { mark: '\u25cf', color: 'warning' },
  failed: { mark: '\u2717', color: 'error' },
  pending: { mark: '\u25cb', color: undefined },
}

/** Pasos de la corrida: marca, color (undefined = atenuado) y nombre, en el orden de `status.agents`. */
export function stepsOf(run: PipelineRun): { name: string; mark: string; color: string | undefined; dim: boolean }[] {
  return (run.agents ?? []).map(s => ({ name: s.name, mark: STEP_MARKS[s.result].mark, color: STEP_MARKS[s.result].color, dim: s.result === 'pending' }))
}

/** Texto plano de la fila de pasos: `✓ test-writer ─ ● implementer`. */
export function stepsText(run: PipelineRun): string {
  return stepsOf(run).map(s => `${s.mark} ${s.name}`).join(' \u2500 ')
}

/** Cabecera de corrida suelta: `mefisto · #853 projection-implementer 3m`. */
export function runHeader(run: PipelineRun, nowMs: number): string {
  const mins = minutesSince(run.started, nowMs)
  const what = run.state === 'hold' ? `rate limit \u00b7 sonda ${run.nextProbe ? clockOf(run.nextProbe) : '?'}` : agentOf(run.stage)
  return `#${run.issue} ${what}${mins === null ? '' : ` ${mins}m`}`
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** Ultimas `max` lineas utiles del log del pipeline (sin ANSI, sin vacias ni separadores). */
export function logTailLines(raw: string, max = BAND_LOG_ROWS): string[] {
  return raw
    .split('\n')
    .map(l => l.replace(ANSI, '').replace(/\r/g, '').trim())
    .filter(l => /[\p{L}\p{N}]/u.test(l))
    .slice(-max)
}

const hms = (iso: unknown): string => {
  if (typeof iso !== 'string') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Ultimo evento del agente como linea: `HH:MM:SS <Tool>`, o `success · N turnos · $X` al cerrar; null sin eventos. */
export function eventLineOf(raw: string): string | null {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (ev.type === 'run.completed') {
      const turns = typeof ev.turns === 'number' ? ` \u00b7 ${ev.turns} turnos` : ''
      const cost = typeof ev.estimated_cost_usd === 'number' ? ` \u00b7 $${ev.estimated_cost_usd.toFixed(2)}` : ''
      return `${typeof ev.status === 'string' ? ev.status : 'completado'}${turns}${cost}`
    }
    if (ev.type === 'tool.started' && typeof ev.tool === 'string') return `${hms(ev.ts)} ${ev.tool}`.trim()
  }
  return null
}

/** Lineas de la banda: las del log del pipeline y, al final, el ultimo evento del agente; se queda con las ultimas `max`. */
export function bandLinesOf(logLines: readonly string[], eventLine: string | null, max = BAND_LOG_ROWS): string[] {
  return [...logLines, ...(eventLine ? [eventLine] : [])].slice(-max)
}

// ---- Pane de log (#2321): eventos del agente y log del pipeline mezclados en orden de llegada ----

export const PANE_MAX_LINES = 400

/** Linea de log del pipeline para el pane: sin ANSI ni retorno de carro; null si no tiene letras ni numeros. */
export function cleanLogLine(raw: string): string | null {
  const line = raw.replace(ANSI, '').replace(/\r/g, '').trim()
  return /[\p{L}\p{N}]/u.test(line) ? line : null
}

/** Una linea del `events.jsonl` (run-events v1, redactado en lo publicado: sin `message` ni `input_summary`). */
export function parseEvent(raw: string): PaneLine | null {
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const ts = hms(ev.ts)
  const tool = typeof ev.tool === 'string' ? ev.tool : '?'
  switch (ev.type) {
    case 'run.started':
      return { kind: 'start', text: `\u2500\u2500 ${`${typeof ev.agent === 'string' ? ev.agent : 'agente'} \u00b7 ${typeof ev.model === 'string' ? ev.model : ''}`.replace(/ \u00b7 $/, '')} \u2500\u2500` }
    case 'tool.started': {
      const summary = typeof ev.input_summary === 'string' && ev.input_summary !== '' ? ` ${clip(ev.input_summary, 200)}` : ''
      return { kind: 'tool', text: `${ts} ${tool}${summary}`.trim() }
    }
    case 'tool.completed':
      return ev.ok === false ? { kind: 'fail', text: `${ts} ${tool} fall\u00f3`.trim() } : null
    case 'run.completed': {
      const turns = typeof ev.turns === 'number' ? ` \u00b7 ${ev.turns} turnos` : ''
      const cost = typeof ev.estimated_cost_usd === 'number' ? ` \u00b7 $${ev.estimated_cost_usd.toFixed(2)}` : ''
      return { kind: ev.status === 'success' ? 'done' : 'fail', text: `${typeof ev.status === 'string' ? ev.status : 'fin'}${turns}${cost}` }
    }
    case 'run.failed':
      return { kind: 'fail', text: clip(typeof ev.error === 'string' ? ev.error : 'fallo', 400) }
    default:
      return null
  }
}

/** Separador de eslabon del lote. */
export const batchSeparator = (issue: number): PaneLine => ({ kind: 'start', text: `\u2550\u2550 #${issue} \u2550\u2550` })

/** Agrega al final y se queda con las ultimas `max`. */
export function mergePaneLines(list: readonly PaneLine[], added: readonly PaneLine[], max = PANE_MAX_LINES): PaneLine[] {
  return [...list, ...added].slice(-max)
}

/** Ruta absoluta de un log del status (relativa a la raiz del repo si no empieza por `/`). */
export function logPathOf(log: string, repoRoot: string): string {
  return log.startsWith('/') ? log : `${repoRoot.replace(/\/+$/, '')}/${log}`
}

/** Archivos a seguir: el `events.jsonl` del intento vigente del stage activo y el log del lote (si hay) o de la corrida. */
export function followTargetsOf(
  run: PipelineRun | null,
  batch: BatchStatus | null,
  logNames: readonly string[],
  repoRoot: string,
): { events: string | null; log: string | null } {
  const file = run ? eventsFileOf(run, logNames) : null
  const log = batch?.log ?? run?.log ?? null
  return {
    events: file ? `${repoRoot.replace(/\/+$/, '')}/.mefisto/pipeline/${LOGS_DIR}/${file}` : null,
    log: log ? logPathOf(log, repoRoot) : null,
  }
}

/** `3m` / `45s` de la duracion (segundos) de un paso terminado; vacio sin duracion. */
export function durationText(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0) return ''
  return seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds)}s`
}

/** Cabecera del pane: `mefisto \u00b7 #N pipeline`; en el lote antepone `sequential N/M \u00b7 `. */
export function paneHeaderOf(run: PipelineRun, batch: BatchStatus | null): string {
  const lead = batch ? `${batch.pipeline || 'sequential'} ${batchCounts(batch).merged}/${batch.issues.length} \u00b7 ` : ''
  return `mefisto \u00b7 ${lead}#${run.issue} ${run.pipeline}`
}

export type RecentLine = { ts: string; text: string; color: string | undefined }

/** Color por tipo, en el orden del `lineColor` interno: fallo `error`, exito `success` (`<agente> completado en Ns`), inicio `claude`. */
export function recentLineColor(text: string): string | undefined {
  if (/^(\u2717|error|fall)/i.test(text)) return 'error'
  if (/^(\u2713|ok\b|exito|\u00e9xito|aprobad|mergead)/i.test(text) || /\bcompletad[oa]\b/i.test(text)) return 'success'
  if (/^(invocando|iniciando|lanzando)\b/i.test(text)) return 'claude'
  return undefined
}

/** Ultimas `max` lineas con hora (`[11:50:53] x` o `11:50:53 x`) como `HH:MM:SS texto`; las demas (separadores, sin hora) se descartan. */
export function recentLines(lines: readonly string[], max = BAND_LOG_ROWS): RecentLine[] {
  const out: RecentLine[] = []
  for (const raw of lines) {
    const m = /^\[?(\d{2}:\d{2}:\d{2})\]?\s+(.+)$/.exec(raw.trim())
    if (!m) continue
    const text = m[2] as string
    out.push({ ts: m[1] as string, text, color: recentLineColor(text) })
  }
  return out.slice(-max)
}

// ---- Lote parallel (#2449): `pipeline-status-parallel.json` (#2447), una banda por issue en curso ----

export const PARALLEL_STATUS_FILE = 'pipeline-status-parallel.json'
export const PARALLEL_BAND_ROWS = 3
export const PARALLEL_STOP_NOTE = 'se detiene: no lanza mas'

export type ParallelIssueStatus = 'pendiente' | 'en-curso' | 'terminado' | 'fallido' | 'aplazado' | 'saltado'
export type ParallelIssue = {
  issue: number
  pipeline: string | null
  status: ParallelIssueStatus
  pr: string | null
  /** Epoch en milisegundos; 0 si el issue aun no arranca. */
  startedMs: number
  finishedMs: number
  detail: string
}
export type ParallelStatus = {
  started: string
  state: BatchState
  stopRequested: boolean
  log?: string
  issues: ParallelIssue[]
}

const PARALLEL_ISSUE_STATUSES: readonly string[] = ['pendiente', 'en-curso', 'terminado', 'fallido', 'aplazado', 'saltado']

export function parallelStatusPath(stateDir: string): string {
  return `${stateDir.replace(/\/+$/, '')}/${PARALLEL_STATUS_FILE}`
}

const epochMs = (value: unknown): number => {
  const n = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

/** Parseo de `pipeline-status-parallel.json`; null si no es JSON valido o no trae un `state` conocido. */
export function parseParallelStatus(raw: string): ParallelStatus | null {
  let json: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    json = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof json.state !== 'string' || !BATCH_STATES.includes(json.state)) return null
  const issues: ParallelIssue[] = []
  for (const row of Array.isArray(json.issues) ? (json.issues as Record<string, unknown>[]) : []) {
    const issue = Number(row?.issue)
    if (!Number.isFinite(issue)) continue
    const status = typeof row.status === 'string' && PARALLEL_ISSUE_STATUSES.includes(row.status) ? (row.status as ParallelIssueStatus) : 'pendiente'
    issues.push({
      issue,
      pipeline: typeof row.pipeline === 'string' && row.pipeline !== '' ? row.pipeline : null,
      status,
      pr: prNumberOf(row.pr),
      startedMs: epochMs(row.started),
      finishedMs: epochMs(row.finished),
      detail: typeof row.detail === 'string' ? row.detail : '',
    })
  }
  return {
    started: typeof json.started === 'string' ? json.started : '',
    state: json.state as BatchState,
    stopRequested: json.stop_requested === true,
    issues,
    ...(typeof json.log === 'string' && json.log !== '' ? { log: json.log } : {}),
  }
}

export const isParallelRunning = (p: ParallelStatus | null): p is ParallelStatus => p !== null && p.state === 'running'

export type LotView = 'sequential' | 'parallel' | 'closed-sequential' | 'closed-parallel' | null

const startedOf = (stamp: string): number => stampToMs(stamp) || Date.parse(stamp) || 0

/**
 * Precedencia de la banda: lote sequential en curso, lote parallel en curso, y entre los cerrados (sin descartar)
 * el de `started` mas reciente; null deja paso al resto de vistas.
 */
export function lotViewOf(batch: BatchStatus | null, parallel: ParallelStatus | null): LotView {
  if (batch && isBatchRunning(batch)) return 'sequential'
  if (isParallelRunning(parallel)) return 'parallel'
  if (batch && parallel) return startedOf(parallel.started) > startedOf(batch.started) ? 'closed-parallel' : 'closed-sequential'
  if (parallel) return 'closed-parallel'
  return batch ? 'closed-sequential' : null
}

export const isParallelDone = (i: ParallelIssue) => i.status === 'terminado' || i.status === 'fallido'

/** Cabecera `parallel M/N` (M = terminados + fallidos), tiempo desde `started` y la nota de parada pedida. */
export function parallelHeader(p: ParallelStatus, nowMs: number): { progress: string; time: string; stopNote: string } {
  const startedMs = stampToMs(p.started) || Date.parse(p.started) || 0
  return {
    progress: `parallel ${p.issues.filter(isParallelDone).length}/${p.issues.length}`,
    time: startedMs > 0 ? elapsedText(nowMs - startedMs) : '',
    stopNote: p.stopRequested ? PARALLEL_STOP_NOTE : '',
  }
}

/** `1: detener` solo con el lote corriendo, sin parada pedida y con issues `pendiente`. */
export const canStopParallel = (p: ParallelStatus | null): boolean =>
  isParallelRunning(p) && !p.stopRequested && p.issues.some(i => i.status === 'pendiente')

/** Cola `✓ #a ─ ● #b ─ ○ #c ─ ✗ #d` con las marcas y colores del sequential. */
export function parallelQueueMarks(p: ParallelStatus): { text: string; color: string | undefined }[] {
  return p.issues.map(i => {
    const color = i.status === 'terminado' ? 'success' : i.status === 'en-curso' ? 'warning' : i.status === 'fallido' ? 'error' : undefined
    const mark = i.status === 'terminado' ? '✓' : i.status === 'en-curso' ? '●' : i.status === 'fallido' ? '✗' : i.status === 'pendiente' ? '○' : i.status === 'aplazado' ? '⏸' : '-'
    return { text: `${mark} #${i.issue}`, color }
  })
}

/** Issues con banda propia: los `en-curso`, en el orden de `issues[]`. */
export const parallelRunning = (p: ParallelStatus): ParallelIssue[] => p.issues.filter(i => i.status === 'en-curso')

/** Pagina de bandas: hasta `size` por pagina; la pagina pedida se acota al rango. */
export function paginateBands<T>(items: readonly T[], page: number, size = PARALLEL_BAND_ROWS): { page: number; pages: number; visible: T[] } {
  const { page: p, pages } = pageOf(page, items.length, size)
  return { page: p, pages, visible: items.slice(p * size, (p + 1) * size) }
}

/** Corrida de un issue del lote: su status activo mas reciente, preferido el del mismo pipeline. */
export function parallelRunOf(i: ParallelIssue, runs: readonly PipelineRun[]): PipelineRun | null {
  const mine = runs.filter(r => r.issue === i.issue && isActive(r)).sort((a, c) => c.updated.localeCompare(a.updated))
  return mine.find(r => r.pipeline === i.pipeline) ?? mine[0] ?? null
}

/** PRs del lote, uno por issue, en el orden de `issues[]`. */
export function parallelPrs(p: ParallelStatus): { issue: number; pr: string }[] {
  return p.issues.filter(i => i.pr).map(i => ({ issue: i.issue, pr: i.pr as string }))
}

export const parallelPrLabel = (x: { issue: number; pr: string }): string => `#${x.issue} · PR #${x.pr}`

/** Elegido de un dialogo de issue (PR o log): el `#N` de la respuesta si es uno de los ofrecidos. */
export function issueFromAnswer(answer: unknown, issues: readonly number[]): number | null {
  if (typeof answer !== 'string') return null
  const n = Number(/#?(\d+)/.exec(answer)?.[1])
  return issues.includes(n) ? n : null
}

/** Pregunta del dialogo de parada del lote parallel. */
export function parallelStopQuestion(p: ParallelStatus): string {
  const n = parallelRunning(p).length
  return `¿Detener el parallel? ${n} en curso terminan y no se lanzan más`
}

export type ParallelTableRow = { key: string; mark: string; color: string | undefined; lead: string; trail: string }

/**
 * Tabla bajo las bandas: una fila por terminado o fallido (duracion y costo del historial), una fila `●` por issue
 * en curso con su tiempo y `…` de costo, y `total` con mas de una fila (el tiempo de los en curso se suma, el costo no).
 */
export function parallelTable(
  p: ParallelStatus,
  stats: Record<string, IssueStats>,
  titleOf: (issue: number) => string | null,
  nowMs: number,
  titleW: number,
): { rows: ParallelTableRow[]; total: string | null } {
  const rows: ParallelTableRow[] = []
  const done = p.issues.filter(isParallelDone)
  for (const i of done) {
    const t = closeRowText({ issue: i.issue, status: 'mergeado', pr: i.pr, detail: i.detail }, stats[String(i.issue)], titleW)
    rows.push({ key: `done-${i.issue}`, mark: i.status === 'fallido' ? '✗' : '✓', color: i.status === 'fallido' ? 'error' : 'success', ...t })
  }
  const running = parallelRunning(p)
  for (const i of running) {
    const t = runningRowText(i.issue, i.pr, titleOf(i.issue) ?? stats[String(i.issue)]?.title ?? null, i.startedMs, nowMs, titleW)
    rows.push({ key: `cur-${i.issue}`, mark: '●', color: 'warning', ...t })
  }
  if (rows.length <= 1) return { rows, total: null }
  const base = statsTotal(done.map(i => stats[String(i.issue)]).filter((s): s is IssueStats => s !== undefined))
  const extra = running.reduce((a, i) => a + (i.startedMs > 0 ? Math.max(0, nowMs - i.startedMs) : 0), 0)
  return { rows, total: closeTotalText(rows.length, { ...base, durationMs: base.durationMs + extra }, titleW) }
}

// ---- Lote parallel terminado (#2450): resumen, tabla de cierre y PRs que se ofrecen a mergear ----

export type ParallelCounts = { withPr: number; failed: number; deferred: number; skipped: number; total: number }

export function parallelCounts(p: ParallelStatus): ParallelCounts {
  const count = (s: ParallelIssueStatus) => p.issues.filter(i => i.status === s).length
  return { withPr: count('terminado'), failed: count('fallido'), deferred: count('aplazado'), skipped: count('saltado'), total: p.issues.length }
}

/** Resumen de cierre: `✓ N con PR · ✗ N fallidos · ⏸ N aplazados · ⤼ N saltados` (omite lo que esta en cero salvo los con PR). */
export function parallelSummaryMarks(p: ParallelStatus): string {
  const c = parallelCounts(p)
  return [
    `✓ ${c.withPr} con PR`,
    c.failed > 0 ? `✗ ${c.failed} fallidos` : '',
    c.deferred > 0 ? `⏸ ${c.deferred} aplazados` : '',
    c.skipped > 0 ? `⤼ ${c.skipped} saltados` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Cabecera del lote cerrado: `parallel M/N` (M = terminados + fallidos), estado y tiempo `started` -> ultimo `finished` (vacio si no se conoce). */
export function parallelClosedHeader(p: ParallelStatus): { progress: string; label: string; time: string } {
  const finished = Math.max(0, ...p.issues.map(i => i.finishedMs))
  const startedMs = startedOf(p.started)
  return {
    progress: `parallel ${p.issues.filter(isParallelDone).length}/${p.issues.length}`,
    label: batchEndLabel(p.state),
    time: startedMs > 0 && finished > startedMs ? elapsedText(finished - startedMs) : '',
  }
}

/** Primer issue fallido, para mostrar su motivo en rojo junto a la mascota. */
export const parallelFailedIssue = (p: ParallelStatus): ParallelIssue | null => p.issues.find(i => i.status === 'fallido') ?? null

/** Tabla de cierre: una fila por terminado o fallido y `total` con mas de una fila (como el sequential terminado, #2332). */
export function parallelClosedTable(
  p: ParallelStatus,
  stats: Record<string, IssueStats>,
  titleW: number,
): { rows: ParallelTableRow[]; total: string | null } {
  return parallelTable({ ...p, issues: p.issues.filter(isParallelDone) }, stats, n => stats[String(n)]?.title ?? null, 0, titleW)
}

/** Clave de ocultado persistente del lote parallel: repo + `started`. */
export function parallelDismissKey(repo: string, p: ParallelStatus): string {
  return [repo, 'parallel', p.started].join('|')
}

/** PRs del lote que se ofrecen a mergear: los `terminado` con PR que aun no estan `MERGED`, del mas reciente al mas antiguo. */
export function parallelMergeablePrs(p: ParallelStatus, merged: ReadonlySet<string>): ResultPr[] {
  return p.issues
    .filter(i => i.status === 'terminado' && i.pr !== null && !merged.has(i.pr))
    .map(i => ({ pr: i.pr as string, issue: i.issue, pipeline: (i.pipeline ?? 'tdd') as PipelineKind, key: `parallel-${i.issue}` }))
    .sort((a, b) => Number(b.pr) - Number(a.pr))
}
