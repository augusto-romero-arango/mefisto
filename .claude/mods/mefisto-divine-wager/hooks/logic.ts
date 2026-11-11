import type { BitacoraNote, BitacoraPr, BatchIssue, BatchRun, ChangelogSummary, Historian, Hold, IssueStats, MergePr, MergeRun, OpenPr, BlockedItem, LogLine, Release, ReleaseIssue, ReleaseStep, RunAgent, PipelineRun, ReadyItem, ReadyList } from '../types'

export const STATE_DIR = '.mefisto/pipeline'
export const LOG_DIR = `${STATE_DIR}/logs`
export const HISTORY = `${STATE_DIR}/pipeline-history.jsonl`
export const EVENTS_LOG = `${STATE_DIR}/events.log`

export const BATCH_STATUS = `${STATE_DIR}/pipeline-status-mefisto-batch.json`
/** Senal de parada suave del batch (la misma que escribe /mefisto-batch-stop). */
export const BATCH_STOP = `${STATE_DIR}/batch-stop`

export const statusPath = (issue: string) =>
  `${STATE_DIR}/pipeline-status-mefisto-tooling-${issue}.json`

// El wrapper cuenta solo donde se ejecuta: al inicio de un comando (tras ; && || | ( then do o un salto de
// linea), con asignaciones de entorno delante. Un texto que lo nombra (un heredoc, un grep, un echo) no lanza nada.
const AT_COMMAND = String.raw`(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`
const WRAPPER = String.raw`\S*mefisto-launch-pipeline\.sh`
const LAUNCH = new RegExp(`${AT_COMMAND}${WRAPPER}\\s+--tooling\\s+#?(\\d+)`)

const RELEASE_RUN = new RegExp(`${AT_COMMAND}\\S*mefisto-release\\.sh\\b`)

/** El comando ejecuta el script de /mefisto-release (no basta con nombrarlo en un texto). */
export function isReleaseRun(command: string): boolean {
  return RELEASE_RUN.test(withoutHeredocs(command))
}

/** El mensaje que lanza /mefisto-release (con o sin argumentos). */
export const isReleasePrompt = (text: string) => /^\/mefisto-release(\s|$)/.test(text.trim())

/** El comando sin el cuerpo de sus heredocs, que es texto y no se ejecuta. */
export function withoutHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<heredoc')
}

export function toolingIssueOf(command: string): string | null {
  return LAUNCH.exec(withoutHeredocs(command))?.[1] ?? null
}

// Cada issue es un argumento completo: el `2` de un `2>&1` posterior no es un issue.
const BATCH_LAUNCH = new RegExp(`${AT_COMMAND}${WRAPPER}\\s+--batch((?:\\s+#?\\d+(?=\\s|$|[;&|)]))+)`)

/** Los issues de un `mefisto-launch-pipeline.sh --batch N M ...` (lo que corre /mefisto-sequential), en orden. */
export function batchIssuesOf(command: string): string[] | null {
  const m = BATCH_LAUNCH.exec(withoutHeredocs(command))
  return m?.[1] ? (m[1].match(/\d+/g) ?? []) : null
}

export function stampToMs(stamp: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!m) return 0
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = m.slice(1).map(Number)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

type StatusFile = {
  issue: string
  title?: string
  stage?: string
  state?: string
  started?: string
  agents?: Record<string, RunAgent>
  pr?: string | null
  last_error?: string | null
}

export function runFromStatus(raw: string, prev: PipelineRun | null): PipelineRun | null {
  let s: StatusFile
  try {
    s = JSON.parse(raw)
  } catch {
    return prev
  }
  const state = s.state === 'failed' ? 'failed' : s.state === 'completed' ? 'completed' : 'running'
  return {
    issue: String(s.issue),
    title: s.title ?? prev?.title ?? '',
    stage: s.stage ?? 'setup',
    state,
    startedMs: s.started ? stampToMs(s.started) : (prev?.startedMs ?? 0),
    finishedMs: state === 'running' ? null : (prev?.finishedMs ?? Date.now()),
    agents: s.agents ?? {},
    pr: s.pr ?? null,
    lastError: s.last_error ?? null,
    eventsFile: prev?.eventsFile ?? null,
  }
}

type HistoryEntry = {
  issue: string
  title?: string
  pipeline?: string
  started?: string
  finished?: string
  state?: string
  stage?: string | null
  pr?: string | null
  error?: string | null
}

/** La ultima linea del historial de esta corrida: mismo issue, arrancada en o despues de `sinceMs`. */
export function finishedFromHistory(tail: string, issue: string, sinceMs: number): HistoryEntry | null {
  const lines = tail.split('\n').filter(Boolean).reverse()
  for (const line of lines) {
    let h: HistoryEntry
    try {
      h = JSON.parse(line)
    } catch {
      continue
    }
    if (h.pipeline !== 'mefisto-tooling' || String(h.issue) !== issue) continue
    if (h.started && stampToMs(h.started) + 1000 < sinceMs) return null
    return h
  }
  return null
}

const EVENTS = /^mefisto-tooling-stage-(\d+|merge)-([a-z-]+?)-(\d{8}-\d{6})-issue-(\d+)(?:-[^.]+)?(?:\.attempt-\d+)?\.events\.jsonl$/

export type Entry = { name: string; mtimeMs: number }

export function pickEventsFile(entries: Entry[], issue: string, sinceMs: number): string | null {
  let best: Entry | null = null
  for (const entry of entries) {
    const m = EVENTS.exec(entry.name)
    if (!m || m[4] !== issue) continue
    if (stampToMs(m[3] ?? '') + 1000 < sinceMs) continue
    if (!best || entry.mtimeMs > best.mtimeMs) best = entry
  }
  return best?.name ?? null
}

export function agentOfEventsFile(name: string): string {
  return EVENTS.exec(name)?.[2] ?? ''
}

export const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const WORKTREE = /\S*\/worktree-[^/\s]+\//g

export const relative = (text: string) => text.replace(WORKTREE, '')

const clock = (ts: unknown) => {
  if (typeof ts !== 'string') return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Filtro del visor (mefisto-stream-watch.sh) portado: una linea por evento relevante del contrato run-events v1. */
export function parseEvent(raw: string): LogLine | null {
  let ev: Record<string, any>
  try {
    ev = JSON.parse(raw)
  } catch {
    return null
  }
  const ts = clock(ev.ts)
  switch (ev.type) {
    case 'run.started':
      return { ts, kind: 'start', text: `${ev.agent ?? 'agente'} · ${ev.model ?? ''}`.trim() }
    case 'message':
      if (ev.role !== 'assistant' || typeof ev.text !== 'string' || ev.text.trim() === '') return null
      return { ts, kind: 'text', text: clip(ev.text, 400) }
    case 'tool.started':
      return { ts, kind: 'tool', text: clip(`${ev.tool ?? '?'} ${relative(String(ev.input_summary ?? ''))}`, 400) }
    case 'tool.completed':
      return ev.ok === false ? { ts, kind: 'fail', text: `${ev.tool ?? '?'} falló` } : null
    case 'run.completed': {
      const cost = typeof ev.estimated_cost_usd === 'number' ? ` · $${ev.estimated_cost_usd.toFixed(2)}` : ''
      const turns = typeof ev.turns === 'number' ? ` · ${ev.turns} turnos` : ''
      return { ts, kind: ev.status === 'success' ? 'done' : 'fail', text: `${ev.status ?? 'fin'}${turns}${cost}` }
    }
    case 'run.failed':
      return { ts, kind: 'fail', text: clip(String(ev.error ?? 'fallo'), 400) }
    default:
      return null
  }
}

export type Step = { name: string; mark: 'done' | 'current' | 'failed' | 'pending' }

const STAGES = [
  { id: 'setup', name: 'setup' },
  { id: '1-writer', name: 'writer' },
  { id: '2-reviewer', name: 'reviewer' },
  { id: 'done', name: 'done' },
]

export function steps(run: PipelineRun): Step[] {
  const stage = run.stage === 'merge-writer' ? '2-reviewer' : run.stage
  const at = Math.max(0, STAGES.findIndex(s => s.id === stage))
  return STAGES.map((s, i) => {
    if (run.state === 'completed') return { name: s.name, mark: 'done' }
    if (i < at) return { name: s.name, mark: 'done' }
    if (i === at) return { name: s.name, mark: run.state === 'failed' ? 'failed' : 'current' }
    return { name: s.name, mark: 'pending' }
  })
}

export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}

export function prNumber(pr: string | null): string | null {
  return pr ? (/(\d+)\/?$/.exec(pr)?.[1] ?? null) : null
}

export type MascotPose = { role: 'desarrollador' | 'revisor'; state: string }

const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit)\b/

/** El rol sale del stage y la pose del ultimo evento: herramienta trabaja, texto piensa, edicion del reviewer corrige. */
export function mascotPose(run: PipelineRun, last: LogLine | undefined): MascotPose {
  if (run.state === 'completed') return { role: 'revisor', state: 'aprobado' }
  if (run.state === 'failed') return { role: 'desarrollador', state: 'error' }
  const role = run.stage === '2-reviewer' ? 'revisor' : 'desarrollador'
  if (!last || last.kind !== 'tool') return { role, state: 'pensando' }
  if (role === 'revisor' && EDITS.test(last.text)) return { role, state: 'corrigiendo' }
  return { role, state: 'trabajando' }
}

type Grid = readonly string[]

/** Columnas con algun pixel visible en cualquiera de los cuadros: recorta el margen sin que la mascota salte. */
export function usedColumns(grids: readonly Grid[]): { from: number; to: number } {
  let from = Infinity
  let to = -1
  for (const g of grids) {
    for (const row of g) {
      for (let x = 0; x < row.length; x++) {
        const c = row[x]
        if (c !== '.' && c !== ' ') {
          from = Math.min(from, x)
          to = Math.max(to, x)
        }
      }
    }
  }
  return to < 0 ? { from: 0, to: 0 } : { from, to }
}

export function cropGrid(grid: Grid, cols: { from: number; to: number }): Grid {
  return grid.map(row => row.slice(cols.from, cols.to + 1).padEnd(cols.to - cols.from + 1, '.'))
}

export const NEXT_ORDER = './.claude/scripts/mefisto-next-order.sh'
export const PLANNER_AGENT = 'mefisto-planner'
/** Filas fijas de la lista de listos: la banda no cambia de alto con la cantidad de issues. */
export const READY_ROWS = 5

type NextOrderJson = {
  items?: { number: number; title: string; after?: number[] }[]
  blocked?: { number?: number; by?: number }[]
  cycles?: unknown[]
  launch?: string | null
}

/** Exit 0 (hay orden) y 1 (vacio) traen JSON valido; 2 es un fallo de gh o de argumentos. */
export function parseNextOrder(exitCode: number, stdout: string, stderr: string, titles: Record<number, string> = {}): ReadyList {
  const empty = { items: [], blocked: [], cycleCount: 0, launch: null }
  if (exitCode !== 0 && exitCode !== 1) {
    return { ...empty, error: stderr.split('\n').find(l => l.trim() !== '')?.trim() || `exit ${exitCode}` }
  }
  let json: NextOrderJson
  try {
    json = JSON.parse(stdout)
  } catch {
    return { ...empty, error: 'salida de next-order no es JSON' }
  }
  return {
    items: (json.items ?? []).map(i => ({ number: i.number, title: i.title, after: i.after ?? [] })),
    blocked: blockedOf(json.blocked ?? [], titles),
    cycleCount: (json.cycles ?? []).length,
    launch: json.launch ?? null,
    error: null,
  }
}

/** next-order da una fila por par issue-dependencia: se agrupan por issue para contar issues, no pares. */
function blockedOf(rows: { number?: number; by?: number }[], titles: Record<number, string>): BlockedItem[] {
  const out: BlockedItem[] = []
  for (const r of rows) {
    if (typeof r.number !== 'number') continue
    const item = out.find(b => b.number === r.number) ?? out[out.push({ number: r.number, title: titles[r.number] ?? '', by: [] }) - 1]
    if (item && typeof r.by === 'number' && !item.by.includes(r.by)) item.by.push(r.by)
  }
  return out
}

export type ReadyRow = { number: number; title: string; reason: string; isLaunchable: boolean }

/**
 * Todos los estado:listo de la banda: primero los lanzables en el orden de next-order y al final los bloqueados,
 * visibles para armar un sequential a mano pero atenuados y sin tecla.
 */
export function readyRows(list: ReadyList): ReadyRow[] {
  return [
    ...list.items.map(i => ({ number: i.number, title: i.title, reason: reasonOf(i), isLaunchable: true })),
    ...list.blocked.map(b => ({ number: b.number, title: b.title, reason: '', isLaunchable: false })),
  ]
}

/** Titulos de los estado:listo abiertos (`gh issue list --json number,title`): next-order no los da para los bloqueados. */
export function titlesOf(stdout: string): Record<number, string> {
  try {
    const rows = JSON.parse(stdout) as { number: number; title: string }[]
    return Object.fromEntries(rows.map(r => [r.number, r.title]))
  } catch {
    return {}
  }
}

/** Todo se lanza por /mefisto-sequential, aunque sea un solo issue: la cadena mergea y sincroniza main. */
export const sequentialOf = (issue: number) => `/mefisto-sequential ${issue}`

/** Un solo issue sin merge automatico: /mefisto-tooling deja el PR abierto para revisarlo. */
export const toolingOf = (issue: number) => `/mefisto-tooling ${issue}`

export function reasonOf(item: ReadyItem): string {
  return item.after.length > 0 ? `tras ${item.after.map(n => `#${n}`).join(' ')}` : ''
}

export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** Titulo recortado con `…` a `width` columnas y rellenado a ese ancho (vacio si no hay titulo o no hay espacio). */
export function fitTitle(title: string | null | undefined, width: number): string {
  if (width <= 0) return ''
  const t = (title ?? '').trim()
  return padEnd(t.length > width ? `${t.slice(0, width - 1)}…` : t, width)
}

/** Ancho de la columna de titulo del resumen: lo que sobra de la banda tras marca, issue, PR, tiempo y costo; 0 si no cabe un titulo legible. */
export function summaryTitleWidth(inner: number): number {
  const w = Math.min(60, inner - 38)
  return w < 8 ? 0 : w
}

/** Pagina valida (0-based) para una lista de `total` items; vuelve a 0 si la lista se achico. */
export function pageOf(page: number, total: number, size: number): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / size))
  return { page: page >= 0 && page < pages ? page : 0, pages }
}

/** El `--agent` de una linea de comando de Claude Code (`--agent x` o `--agent=x`), o null. */
export function agentFlagOf(cmdline: string): string | null {
  const m = /(?:^|\s)--agent(?:=|\s+)(\S+)/.exec(cmdline)
  return m ? (m[1] ?? null) : null
}

/**
 * Mefisto en espera, sobre la cara 'normal': boca plana corrida a un lado y un reloj de arena a la izquierda.
 * Mientras Claude trabaja en la sesion, en cada tick los ojos miran de un lado al otro y la arena cambia de
 * mitad; en reposo mira al frente con la arena arriba.
 */
const HOURGLASS = [
  ['YYYY', 'gyyg', '.yg.', 'g..g', 'g..g', 'YYYY'],
  ['YYYY', 'g..g', '.gg.', 'g..g', 'gyyg', 'YYYY'],
] as const

export function waitingFace(base: Grid, tick: number | null): Grid {
  const eyes =
    tick === null ? ['.....rrEErrEErr.tt', '.....rrEErrEErr..t']
    : tick % 2 === 0 ? ['.....rEErrEErrr.tt', '.....rEErrEErrr..t']
    : ['.....rrrEErrEEr.tt', '.....rrrEErrEEr..t']
  const glass = HOURGLASS[tick !== null && tick % 2 === 1 ? 1 : 0]
  return base.map((row, y) => {
    let out = row
    if (y === 6 || y === 7) out = eyes[y - 6] ?? out
    if (y === 9) out = '......rrrrMMMr..t.'
    const g = y >= 6 ? glass[y - 6] : undefined
    if (g) out = [...out].map((c, x) => (x < g.length && g[x] !== '.' ? g[x] : c)).join('')
    return out
  })
}

type BatchStatusFile = {
  started?: string
  state?: string
  current?: string | null
  stop_requested?: boolean
  hold_seconds?: number
  issues?: { issue: string; status: string; pr: string | null }[]
}

/** El estado publicado del batch; un archivo de un batch anterior (arrancado antes de `sinceMs`) se ignora. */
export function batchFromStatus(raw: string, prev: BatchRun, sinceMs: number): BatchRun {
  let s: BatchStatusFile
  try {
    s = JSON.parse(raw)
  } catch {
    return prev
  }
  const startedMs = s.started ? stampToMs(s.started) : 0
  if (startedMs + 1000 < sinceMs) return prev
  const state = s.state === 'completed' || s.state === 'failed' || s.state === 'stopped' ? s.state : 'running'
  return {
    issues: (s.issues ?? []).map(i => ({ issue: String(i.issue), status: i.status ?? '', pr: i.pr ?? null })),
    state,
    current: s.current ? String(s.current) : null,
    stopRequested: s.stop_requested === true || prev.stopRequested,
    holdSeconds: s.hold_seconds ?? 0,
    startedMs: startedMs || prev.startedMs,
    finishedMs: state === 'running' ? null : (prev.finishedMs ?? Date.now()),
    stats: prev.stats ?? {},
  }
}

export type IssueMark = 'done' | 'current' | 'failed' | 'deferred' | 'pending'

export function issueMark(status: string): IssueMark {
  if (status.startsWith('completado')) return 'done'
  if (status.startsWith('ERROR')) return 'failed'
  if (status.startsWith('aplazado')) return 'deferred'
  if (status.startsWith('en curso')) return 'current'
  return 'pending'
}

export function batchCounts(issues: BatchIssue[]) {
  const marks = issues.map(i => issueMark(i.status))
  return {
    total: issues.length,
    done: marks.filter(m => m === 'done').length,
    failed: marks.filter(m => m === 'failed').length,
    deferred: marks.filter(m => m === 'deferred').length,
  }
}

/** Los issues que pasaron a mergeados entre dos lecturas: un toast por cada uno. */
export function newlyMerged(prev: BatchIssue[], next: BatchIssue[]): BatchIssue[] {
  return next.filter(i => issueMark(i.status) === 'done' && issueMark(prev.find(p => p.issue === i.issue)?.status ?? '') !== 'done')
}

/** El PR para abrir: el del issue en curso si ya lo tiene, o el del ultimo mergeado. */
export function batchPr(batch: BatchRun): string | null {
  const current = batch.issues.find(i => i.issue === batch.current)
  if (current?.pr) return current.pr
  return [...batch.issues].reverse().find(i => i.pr)?.pr ?? null
}

/** Resumen del cierre: mergeados, fallidos, aplazados y la espera por rate limit si la hubo. */
export function batchSummary(batch: BatchRun): string {
  const c = batchCounts(batch.issues)
  const hold = batch.holdSeconds > 0 ? `espera ${Math.round(batch.holdSeconds / 60)}m` : ''
  return [
    `✓ ${c.done} mergeados`,
    c.failed > 0 ? `✗ ${c.failed} fallidos` : '',
    c.deferred > 0 ? `⏸ ${c.deferred} aplazados` : '',
    hold,
  ].filter(Boolean).join(' · ')
}

type StatsEntry = {
  issue?: string
  pipeline?: string
  started?: string
  finished?: string
  title?: string
  agents?: Record<string, { metrics?: { estimated_cost_usd?: number | null } }>
}

/**
 * Duracion y costo de las corridas de tooling de estos issues, desde el final del historial: la ultima de cada
 * issue arrancada en o despues de `sinceMs`. El costo suma el estimado de cada agente (null si ninguno lo da).
 */
export function issueStatsFromHistory(tail: string, issues: string[], sinceMs: number): Record<string, IssueStats> {
  const out: Record<string, IssueStats> = {}
  for (const line of tail.split('\n')) {
    let h: StatsEntry
    try {
      h = JSON.parse(line)
    } catch {
      continue
    }
    const issue = String(h.issue ?? '')
    if (h.pipeline !== 'mefisto-tooling' || !issues.includes(issue) || !h.started || !h.finished) continue
    const startedMs = stampToMs(h.started)
    const finishedMs = new Date(h.finished).getTime()
    if (startedMs + 1000 < sinceMs || Number.isNaN(finishedMs)) continue
    const costs = Object.values(h.agents ?? {})
      .map(a => a.metrics?.estimated_cost_usd)
      .filter((c): c is number => typeof c === 'number')
    out[issue] = {
      durationMs: Math.max(0, finishedMs - startedMs),
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
      title: typeof h.title === 'string' && h.title !== '' ? h.title : null,
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
    costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    title: null,
  }
}

/** Fila `●` del issue en curso: mismas columnas que los terminados; costo `…` (solo se conoce al escribirse el historial). */
export function currentRowParts(
  issue: string,
  title: string | null | undefined,
  pr: string | null,
  elapsedMs: number,
  titleW: number,
): { head: string; tail: string } {
  const head = `● ${padEnd(`#${issue}`, 7)} ${titleW > 0 ? `${fitTitle(title, titleW)} ` : ''}${padEnd(pr ? `PR #${pr}` : '…', 10)} `
  return { head, tail: `${padEnd(elapsed(elapsedMs), 8)} …` }
}

/** Fila `total` con el issue en curso: cuenta todas las filas, suma su tiempo y, en costo, solo los terminados. */
export function totalRowText(done: IssueStats[], currentMs: number | null, titleW: number): string {
  const total = statsTotal(done)
  const count = done.length + (currentMs === null ? 0 : 1)
  const duration = total.durationMs + (currentMs ?? 0)
  return `  total ${padEnd(String(count), 12 + (titleW > 0 ? titleW + 1 : 0))} ${padEnd(elapsed(duration), 8)} ${fmtCost(total.costUsd)}`
}

/**
 * PRs abiertos (`gh pr list --json number,title,isDraft,headRefName`) sin los borradores, el mas reciente primero.
 * Los de field notes (rama `docs/<agente>-field-note-<sesion>` de mefisto-field-note.sh) se marcan aparte.
 */
export function parseOpenPrs(stdout: string): OpenPr[] | null {
  try {
    const rows = JSON.parse(stdout) as { number: number; title: string; isDraft?: boolean; headRefName?: string }[]
    return rows
      .filter(r => !r.isDraft)
      .map(r => ({ number: r.number, title: r.title, isFieldNote: /-field-note-/.test(r.headRefName ?? '') }))
      .sort((a, b) => b.number - a.number)
  } catch {
    return null
  }
}

export const MERGE_ALL = 'Todos (--all)'

/** Opciones del dialogo de merge (2-4): todos y los PRs mas recientes; con uno solo, ese y cancelar. */
export function mergeOptions(prs: OpenPr[]): string[] {
  const label = (p: OpenPr) => clip(`#${p.number} ${p.title}`, 60)
  if (prs.length === 1 && prs[0]) return [label(prs[0]), 'Cancelar']
  return [MERGE_ALL, ...prs.slice(0, 3).map(label)]
}

/**
 * Los argumentos de /mefisto-merge que salen de la respuesta (las opciones marcadas, unidas por ", "): --all si
 * se eligio todos; de cada opcion solo su #N (el titulo puede traer fechas); del texto libre, sus numeros.
 * Null si no queda ningun PR.
 */
export function mergeArgsOf(answer: string, options: string[]): string | null {
  if (answer.includes(MERGE_ALL)) return '--all'
  let rest = answer
  const numbers: string[] = []
  for (const option of options) {
    if (!rest.includes(option)) continue
    rest = rest.replace(option, '')
    const n = /^#(\d+)/.exec(option)?.[1]
    if (n) numbers.push(n)
  }
  numbers.push(...(rest.match(/\d+/g) ?? []))
  const unique = [...new Set(numbers)]
  return unique.length > 0 ? unique.join(' ') : null
}

/** Field notes en `docs/bitacora/field-notes/` sin procesar (las de `procesadas/` quedan fuera del listado). */
export function fieldNotesIn(names: string[]): number {
  return names.filter(n => n.endsWith('.md')).length
}

/** Resumen de `changelog.d/`: issues con fragmentos (sin README) y entradas por categoria de Keep a Changelog. */
export function changelogOf(names: string[]): ChangelogSummary {
  const fragments = names.filter(n => n !== 'README.md' && n.endsWith('.md'))
  const by = (cat: string) => fragments.filter(n => n.endsWith(`.${cat}.md`)).length
  return {
    issues: new Set(fragments.map(n => n.split('.')[0])).size,
    added: by('added'),
    changed: by('changed'),
    fixed: by('fixed'),
    removed: by('removed'),
  }
}

/** SemVer: algo agregado pide minor; solo cambios, arreglos o retiros, patch. El recomendado va primero. */
export function releaseOptions(summary: ChangelogSummary): string[] {
  const bump = summary.added > 0 ? 'minor' : 'patch'
  const other = bump === 'minor' ? 'patch' : 'minor'
  return [`${bump} (recomendado)`, other, `Solo preparar el PR (${bump} --prepare-only)`]
}

/** Los argumentos de /mefisto-release de la opcion elegida, o null. */
export function releaseArgsOf(answer: string): string | null {
  const bump = /\b(major|minor|patch)\b/.exec(answer)?.[1]
  if (!bump) return null
  return answer.includes('--prepare-only') ? `${bump} --prepare-only` : bump
}

export const RELEASE_STEPS: readonly ReleaseStep[] = ['rama', 'consolidar', 'pr', 'merge', 'tag', 'release']
const RELEASE_STEP_LABEL: Record<ReleaseStep, string> = {
  rama: 'rama', consolidar: 'consolidar', pr: 'PR', merge: 'merge', tag: 'tag', release: 'GitHub Release',
}
const KEEP_CATEGORIES = ['added', 'changed', 'fixed', 'removed']

/** El bump y el modo de un /mefisto-release o de su script, leidos de sus argumentos. Sin bump es la fase publish. */
export function releaseInvocationOf(text: string): { bump: 'major' | 'minor' | 'patch' | null; prepareOnly: boolean } {
  const args = withoutHeredocs(text).replace(/^[\s\S]*?(?:\/mefisto-release|mefisto-release\.sh)\b/, '')
  const bump = /^[^;&|\n]*?\b(major|minor|patch)\b/.exec(args)?.[1] as 'major' | 'minor' | 'patch' | undefined
  return { bump: bump ?? null, prepareOnly: /^[^;&|\n]*--prepare-only\b/.test(args) }
}

/** Mismo calculo que bump_version de mefisto-release.sh. */
export function bumpVersion(current: string, part: 'major' | 'minor' | 'patch'): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim())
  if (!m) return null
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** Nombres de mefisto-release.sh: RELEASE_BRANCH="release/${NEW_TAG}" y NEW_TAG="v${NEW_VERSION}". */
export const releaseTagOf = (version: string) => `v${version}`
export const releaseBranchOf = (version: string) => `release/${releaseTagOf(version)}`

/**
 * Version destino y fases que recorre la corrida: con bump prepara desde la version de plugin.json; sin bump
 * plugin.json ya trae la version a publicar y solo quedan tag y release; --prepare-only se detiene en el PR.
 */
export function releasePlan(current: string | null, invocation: { bump: 'major' | 'minor' | 'patch' | null; prepareOnly: boolean }) {
  if (!current) return { version: null, steps: [...RELEASE_STEPS] }
  if (!invocation.bump) return { version: current.trim(), steps: RELEASE_STEPS.slice(4) }
  const version = bumpVersion(current, invocation.bump)
  return { version, steps: invocation.prepareOnly ? RELEASE_STEPS.slice(0, 3) : [...RELEASE_STEPS] }
}

/** Los issues con fragmentos en changelog.d/ (sin README.md), en orden numerico, con sus categorias Keep a Changelog. */
export function releaseIssuesOf(names: string[]): ReleaseIssue[] {
  const by = new Map<string, string[]>()
  for (const name of names) {
    const [, issue, category] = /^(\d+)\.([a-z-]+)\.md$/.exec(name) ?? []
    if (!issue || !category) continue
    const categories = by.get(issue) ?? []
    if (KEEP_CATEGORIES.includes(category) && !categories.includes(category)) categories.push(category)
    by.set(issue, categories)
  }
  return [...by.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([issue, categories]) => ({ issue, title: '', categories: KEEP_CATEGORIES.filter(c => categories.includes(c)) }))
}

/** Los fragmentos de la foto ya no estan en la rama de release: la consolidacion los volco a CHANGELOG.md. */
export function isConsolidated(snapshot: readonly string[], remote: readonly string[]): boolean {
  return snapshot.length > 0 && snapshot.every(name => !remote.includes(name))
}

/**
 * Las fases son monotonas y en orden: observar una implica las anteriores (la rama se borra al mergear, y un
 * sondeo puede saltarse una fase rapida). Devuelve el mismo objeto si nada avanzo.
 */
export function withObservedSteps(release: Release, observed: readonly ReleaseStep[]): Release {
  const last = Math.max(-1, ...observed.map(step => release.steps.indexOf(step)))
  const done = release.steps.slice(0, Math.max(last + 1, release.done.length))
  return done.length === release.done.length ? release : { ...release, done }
}

/** La fase en curso: la primera de esta corrida que no se observo; null si todas estan hechas. */
export function currentReleaseStep(release: Release): ReleaseStep | null {
  return release.steps.find(step => !release.done.includes(step)) ?? null
}

/** El checklist de fases en una linea: ✓ hechas, ● la en curso, ✗ la que fallo, sin marca las que faltan. */
export function releaseChecklist(release: Release): { step: ReleaseStep; label: string; mark: '✓' | '●' | '✗' | '·' }[] {
  const current = release.finishedMs ? null : currentReleaseStep(release)
  return release.steps.map(step => ({
    step,
    label: RELEASE_STEP_LABEL[step],
    mark: release.done.includes(step) ? '✓' : release.failed === step ? '✗' : step === current ? '●' : '·',
  }))
}

/** El encabezado de la cinta: version y estado, o la fase que fallo. */
export function releaseHeader(release: Release, elapsedText: string): string {
  const name = release.version ? `release ${releaseTagOf(release.version)}` : 'release'
  if (release.failed) return `${name} falló en ${RELEASE_STEP_LABEL[release.failed]}`
  if (release.finishedMs) {
    const last = release.steps[release.steps.length - 1]
    if (last === 'pr' && release.pr) return `${name} · PR #${release.pr} listo`
    return `${name} publicado`
  }
  return `${name} ${release.phase === 'despegando' ? 'despegando' : 'en preparación'} ${elapsedText}`.trimEnd()
}

/** Al terminar el turno: la fase en curso queda con ✗ si la corrida no las completo todas. */
export function finishRelease(release: Release, nowMs: number): Release {
  if (release.finishedMs) return release
  return { ...release, phase: 'reposo', finishedMs: nowMs, failed: currentReleaseStep(release) }
}

/**
 * La instruccion para integrar la bitacora. El historiador lee las field notes del checkout local, asi que antes
 * hay que mergear los PRs de field notes que esperan y traer main al dia (las de PRs ya mergeados viven en
 * origin/main hasta el pull).
 */
export function bitacoraPrompt(fieldNotePrs: number[]): string {
  const merge = fieldNotePrs.length > 0
    ? `mergea los PRs de field notes ${fieldNotePrs.map(n => `#${n}`).join(' ')} con /mefisto-merge, `
    : ''
  return `Integra la bitacora: ${merge}pon el checkout en main al dia (git switch main && git pull --ff-only) y luego corre /mefisto-bitacora.`
}

const HOLD = /^\[\d{2}:\d{2}:\d{2}\]\[hold\] (\S+): esperando, proxima sonda (\d{2}:\d{2})(?::\d{2})? \(techo (\d{2}:\d{2})\)/

/**
 * La espera en curso: la ultima linea de events.log es un `[hold]` (mefisto-tooling-pipeline.sh la escribe en
 * cada sonda; cualquier actividad posterior, incluido `[hold][resume]`, la da por terminada).
 */
export function holdOf(tail: string): Hold | null {
  const last = tail.split('\n').filter(l => l.trim() !== '').pop() ?? ''
  const m = HOLD.exec(last)
  return m ? { family: m[1] ?? '', nextProbe: m[2] ?? '', deadline: m[3] ?? '' } : null
}

export const holdText = (hold: Hold) => `en espera por ${hold.family} · próxima sonda ${hold.nextProbe} · techo ${hold.deadline}`

const AGENT_ACTIVE = new Set(['pending', 'running', 'waiting'])

/** Un agente de `$.agent.list()` que aun no termina (AgentStatus). */
export const isAgentActive = (status: string) => AGENT_ACTIVE.has(status)

/**
 * El historiador corre en primer o en segundo plano: se sigue su estado en `$.agent.list()`, no la llamada Agent,
 * que en segundo plano vuelve en cuanto arranca. Devuelve `prev` tal cual si nada cambio.
 */
export function historianFrom(prev: Historian | null, active: boolean, now: number): Historian | null {
  if (active) return prev && !prev.finishedMs ? prev : { startedMs: now, finishedMs: null, notes: [], pr: null }
  return prev && !prev.finishedMs ? { ...prev, finishedMs: now } : prev
}

/**
 * La cinta tal como se dibuja: terminada hace mas de `doneMs` no existe, aunque su atom siga ahi porque el
 * `clock.after` que la limpiaba murio con un hot-reload. En curso nunca vence, ni la que espera al usuario.
 */
export function liveTape<T extends { finishedMs: number | null }>(tape: T | null, doneMs: number, nowMs: number, isAwaitingUser = false): T | null {
  if (!tape || !tape.finishedMs || isAwaitingUser) return tape
  return nowMs - tape.finishedMs > doneMs ? null : tape
}

/** Los argumentos del mensaje que lanza /mefisto-merge (`''` sin argumentos), o null si no es ese comando. */
export function mergePromptArgs(text: string): string | null {
  const m = /^\/mefisto-merge(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? (m[1] ?? '').trim() : null
}

/**
 * Los PRs que va a coser /mefisto-merge: con --all, todos los abiertos (los mismos que cuenta la
 * tecla 2); si no, los numeros de los argumentos, con el titulo que se conozca de los abiertos.
 */
export function mergePrsOf(args: string, open: OpenPr[]): MergePr[] {
  const pending = (num: string, title: string): MergePr => ({ num, title, estado: 'pendiente' })
  if (/(^|\s)--all(\s|$)/.test(args)) return open.map(p => pending(String(p.number), p.title))
  const nums = [...new Set(args.match(/\d+/g) ?? [])]
  return nums.map(n => pending(n, open.find(p => String(p.number) === n)?.title ?? ''))
}

const GH_MERGE = new RegExp(`${AT_COMMAND}gh\\s+pr\\s+merge\\s+#?(\\d+)`, 'g')

/** Los PRs que el comando mergea con un numero literal (`gh pr merge 12`); el bucle de /mefisto-merge usa "$pr" y no cuenta. */
export function ghMergeNumbersOf(command: string): string[] {
  return [...withoutHeredocs(command).matchAll(GH_MERGE)].map(m => m[1] ?? '').filter(Boolean)
}

/** El comando corre `gh pr merge`, con numero literal o con variable. */
export const isGhMergeRun = (command: string) => new RegExp(`${AT_COMMAND}gh\\s+pr\\s+merge\\b`).test(withoutHeredocs(command))

/**
 * Lo que un Bash termino diciendo de cada PR: el `gh pr merge N` literal sale con exit 0 (mergeado) o no (fallido,
 * si era el unico del comando); de la salida, el aviso de gh al mergear y el `Fallo al mergear #N` del bucle.
 */
export function mergeOutcomesOf(command: string, output: string, isError: boolean): { merged: string[]; failed: string[] } {
  const failed = new Set([...output.matchAll(/Fallo al mergear #(\d+)/g)].map(m => m[1] ?? ''))
  const merged = new Set([...output.matchAll(/merged pull request \S*#(\d+)/gi)].map(m => m[1] ?? ''))
  const literal = ghMergeNumbersOf(command)
  if (!isError) {
    for (const n of literal) if (!failed.has(n)) merged.add(n)
  } else if (literal.length === 1 && literal[0] && !merged.has(literal[0])) {
    failed.add(literal[0])
  }
  for (const n of merged) failed.delete(n)
  return { merged: [...merged].filter(Boolean), failed: [...failed].filter(Boolean) }
}

/** Marca los PRs; un mergeado no vuelve atras. Termina la cinta cuando no queda ninguno pendiente. */
export function withMergeOutcomes(run: MergeRun, merged: readonly string[], failed: readonly string[], now: number): MergeRun {
  let changed = false
  const prs = run.prs.map(p => {
    const estado = merged.includes(p.num) ? 'mergeado' : p.estado === 'pendiente' && failed.includes(p.num) ? 'fallido' : p.estado
    if (estado === p.estado) return p
    changed = true
    return { ...p, estado }
  })
  if (!changed) return run
  const isDone = prs.every(p => p.estado !== 'pendiente')
  return { ...run, prs, finishedMs: isDone ? (run.finishedMs ?? now) : null }
}

/** Cierre de la cinta: lo que quedo pendiente cuenta como fallido (el skill lo descarto o no llego a mergearlo). */
export function finishMerge(run: MergeRun, now: number): MergeRun {
  if (run.finishedMs) return run
  return { ...run, prs: run.prs.map(p => (p.estado === 'pendiente' ? { ...p, estado: 'fallido' } : p)), finishedMs: now }
}

export function mergeCounts(run: MergeRun) {
  return {
    pending: run.prs.filter(p => p.estado === 'pendiente').length,
    merged: run.prs.filter(p => p.estado === 'mergeado').length,
    failed: run.prs.filter(p => p.estado === 'fallido').length,
  }
}

/** La cabecera de la cinta: cosiendo mientras queden pendientes; al terminar, mergeados y fallidos. */
export function mergeHeader(run: MergeRun, elapsedText: string): string {
  const c = mergeCounts(run)
  if (!run.finishedMs) return `cosiendo ${c.pending} PR${c.pending === 1 ? '' : 's'} ${elapsedText}`
  return [`${c.merged} mergeado${c.merged === 1 ? '' : 's'}`, c.failed > 0 ? `✗ ${c.failed} fallido${c.failed === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
}

const FIELD_NOTE_PATH = /^docs\/bitacora\/field-notes\/([^/]+\.md)$/

/**
 * Las field notes que va a integrar el historiador: las de `docs/bitacora/field-notes/` (sin `procesadas/`, que el
 * listado no baja) y las de los PRs de field notes sin mergear (rutas de `gh pr view --json files`), sin repetir.
 */
export function fieldNoteNamesOf(local: readonly string[], prPaths: readonly string[]): string[] {
  const fromPrs = prPaths.map(p => FIELD_NOTE_PATH.exec(p)?.[1]).filter((n): n is string => !!n)
  return [...new Set([...local.filter(n => n.endsWith('.md')), ...fromPrs])].sort()
}

export const pendingNotes = (names: readonly string[]): BitacoraNote[] => names.map(name => ({ name, estado: 'pendiente' }))

/** Pasa a procesada cada nota que ya aparece en algun `procesadas/`; devuelve `h` tal cual si nada cambio. */
export function withProcessedNotes<T extends { notes: BitacoraNote[] }>(h: T, processed: readonly string[]): T {
  const done = new Set(processed)
  if (!h.notes.some(n => n.estado === 'pendiente' && done.has(n.name))) return h
  return { ...h, notes: h.notes.map(n => (n.estado === 'pendiente' && done.has(n.name) ? { ...n, estado: 'procesada' } : n)) }
}

/** Los `procesadas/` donde puede caer una nota: el del checkout y el de cada worktree de mefisto-bitacora-worktree.sh. */
export function processedDirsOf(summaries: readonly string[]): string[] {
  return [
    'docs/bitacora/field-notes/procesadas',
    ...summaries.filter(n => n.startsWith('bitacora-')).map(n => `.mefisto/pipeline/summaries/${n}/docs/bitacora/field-notes/procesadas`),
  ]
}

/**
 * El PR de bitacora abierto (`gh pr list --json number,title,headRefName,files`): toca solo `docs/bitacora/` y no es
 * de field notes (rama `-field-note-`, que tambien cae ahi). El mas reciente si hay varios.
 */
export function bitacoraPrOf(stdout: string): BitacoraPr | null {
  try {
    const rows = JSON.parse(stdout) as { number: number; title: string; headRefName?: string; files?: { path: string }[] }[]
    const pr = rows
      .filter(r => !/-field-note-/.test(r.headRefName ?? ''))
      .filter(r => (r.files ?? []).length > 0 && (r.files ?? []).every(f => f.path.startsWith('docs/bitacora/')))
      .sort((a, b) => b.number - a.number)[0]
    return pr ? { number: pr.number, title: pr.title } : null
  } catch {
    return null
  }
}
