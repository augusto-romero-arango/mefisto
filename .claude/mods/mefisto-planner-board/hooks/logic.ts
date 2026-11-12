import type { BoardItem, BoardList, IssueCard, OpenIssueBrief } from '../types'

export const NEXT_ORDER = 'src/internal/scripts/mefisto-next-order.mts'
/** Filas fijas de la lista: la banda no cambia de alto con la cantidad de issues. */
export const LIST_ROWS = 5

type NextOrderJson = {
  items?: { number: number; title: string; after?: number[]; hasDepsSection?: boolean }[]
  blocked?: unknown[]
  cycles?: unknown[]
  launch?: string | null
}

/** Exit 0 (hay orden) y 1 (vacio) traen JSON valido; 2 es un fallo de gh o de argumentos. */
export function parseNextOrder(exitCode: number, stdout: string, stderr: string): BoardList {
  if (exitCode !== 0 && exitCode !== 1) {
    return { items: [], blockedCount: 0, cycleCount: 0, launch: null, error: firstLine(stderr) || `exit ${exitCode}` }
  }
  let json: NextOrderJson
  try {
    json = JSON.parse(stdout)
  } catch {
    return { items: [], blockedCount: 0, cycleCount: 0, launch: null, error: 'salida de next-order no es JSON' }
  }
  const items: BoardItem[] = (json.items ?? []).map(i => ({
    number: i.number,
    title: i.title,
    after: i.after ?? [],
    hasDepsSection: i.hasDepsSection !== false,
  }))
  return {
    items,
    blockedCount: (json.blocked ?? []).length,
    cycleCount: (json.cycles ?? []).length,
    launch: json.launch ?? null,
    error: null,
  }
}

type OpenIssue = { number: number; title?: string; updatedAt?: string; labels?: { name: string }[] }

export function parseOpenIssues(stdout: string): OpenIssue[] | null {
  try {
    const list = JSON.parse(stdout)
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

/** Cambia cuando entra, sale o se edita un issue abierto (labels o body actualizan updatedAt). */
export function signatureOf(issues: OpenIssue[]): string {
  return issues
    .map(i => `${i.number}:${i.updatedAt ?? ''}:${(i.labels ?? []).map(l => l.name).sort().join(',')}`)
    .sort()
    .join('|')
}

export type Arrival = { number: number; title: string; kind: 'borrador' | 'listo' }

/** Issues abiertos nuevos con estado borrador o listo. Sin conocidos previos (primer refresco) no hay avisos. */
export function arrivals(issues: OpenIssue[], known: number[]): Arrival[] {
  if (known.length === 0) return []
  const seen = new Set(known)
  const out: Arrival[] = []
  for (const i of issues) {
    if (seen.has(i.number)) continue
    const names = (i.labels ?? []).map(l => l.name)
    const kind = names.includes('estado:borrador') ? 'borrador' : names.includes('estado:listo') ? 'listo' : null
    if (kind) out.push({ number: i.number, title: i.title ?? '', kind })
  }
  return out
}

/** De que depende el issue (`tras #A #B`), o vacio si no depende de nada abierto. */
export function reasonOf(item: BoardItem): string {
  return item.after.length > 0 ? `tras ${item.after.map(n => `#${n}`).join(' ')}` : ''
}

/** Ancho comun de la columna de numeros (#801 y #1981 alineados). */
export function numberWidth(items: BoardItem[]): number {
  return Math.max(4, ...items.map(i => String(i.number).length + 1))
}

export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, Math.max(1, max - 1))}…` : one
}

export function clockOf(ms: number): string {
  if (ms === 0) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
}

const REFINE = /\brefin\w*\s+(?:el\s+)?(?:borrador\s+)?#(\d+)/i

/** `refina #801`, `Refina el borrador #801`, `refinemos #801`: el issue a refinar, o null. */
export function refineTargetOf(prompt: string): number | null {
  const m = REFINE.exec(prompt)
  return m ? Number(m[1]) : null
}

/** El tema de una exploracion: la primera linea con contenido del mensaje, recortada. */
export function topicOf(prompt: string): string {
  const line = prompt.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return clip(line.replace(/^quiero explorar:\s*/i, ''), 160)
}

// Un comando cuenta solo donde se ejecuta: al inicio (tras ; && || | ( then do o un salto de linea), con
// asignaciones de entorno delante, y fuera de heredocs. Un texto que lo nombra (git show, grep, echo) no cuenta.
const AT_COMMAND = String.raw`(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`

function withoutHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<heredoc')
}

const runs = (command: string, pattern: string) => new RegExp(`${AT_COMMAND}${pattern}`).exec(withoutHeredocs(command))

/** Un cambio de issues hecho por el planner (crear, editar, cerrar, reabrir): sus listas pueden haber cambiado. */
export function isIssueChange(command: string): boolean {
  return runs(command, String.raw`gh\s+issue\s+(create|edit|close|reopen)\b`) !== null
}

export function isIssueCreate(command: string): boolean {
  return runs(command, String.raw`gh\s+issue\s+create\b`) !== null
}

/** `gh issue edit 801 ... --add-label estado:listo`: el issue que pasa a listo, o null. */
export function issueMarkedListo(command: string): number | null {
  const m = runs(command, String.raw`gh\s+issue\s+edit\s+#?(\d+)\b[^\n;&|]*--add-label[=\s]+["']?[^"'\s]*estado:listo`)
  return m ? Number(m[1]) : null
}

/** `gh issue close 801 ...`: el issue que se cierra, o null. */
export function issueClosed(command: string): number | null {
  const m = runs(command, String.raw`gh\s+issue\s+close\s+#?(\d+)\b`)
  return m ? Number(m[1]) : null
}

/** Tiempo maximo que un issue en transicion se oculta de la lista de borradores. */
export const PENDING_TTL_MS = 60_000

/** La lista sin los issues dados (quita optimista: nunca reordena, solo saca). */
export function withoutItems(list: BoardList | null, numbers: Iterable<number>): BoardList | null {
  if (!list) return list
  const hidden = new Set(numbers)
  if (hidden.size === 0) return list
  return { ...list, items: list.items.filter(i => !hidden.has(i.number)) }
}

/**
 * Transiciones pendientes tras un refresco: un issue sale del conjunto cuando la lista fresca ya no lo trae
 * como borrador o cuando vence su plazo. Mapa numero -> instante de vencimiento (ms). `freshDrafts` null (next-order
 * fallo) no confirma nada: solo vence por plazo.
 */
export function settlePending(pending: ReadonlyMap<number, number>, freshDrafts: number[] | null, nowMs: number): Map<number, number> {
  const fresh = freshDrafts && new Set(freshDrafts)
  const out = new Map<number, number>()
  for (const [n, untilMs] of pending) if (untilMs > nowMs && (!fresh || fresh.has(n))) out.set(n, untilMs)
  return out
}

/** El cierre del planner: ejecuta mefisto-field-note.mts (leerlo con git show o grep no cierra nada). */
export function isPlannerClosing(command: string): boolean {
  return runs(command, String.raw`(?:node\s+)?\S*mefisto-field-note\.mts\b`) !== null
}

/** Numero del issue que `gh issue create` imprime como URL. */
export function createdIssueOf(output: string): number | null {
  const m = /\/issues\/(\d+)/.exec(output)
  return m ? Number(m[1]) : null
}

export function createdText(created: number[]): string {
  return created.length > 0 ? `creó ${created.map(n => `#${n}`).join(' ')}` : ''
}

/** Issues por pagina, igual en las dos listas. */
export function pageSizeOf(_tab: 'borrador' | 'listo'): number {
  return LIST_ROWS
}

/** Pagina valida (0-based) para una lista de `total` items; vuelve a 0 si la lista se achico. */
export function pageOf(page: number, total: number, size: number): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / size))
  return { page: page >= 0 && page < pages ? page : 0, pages }
}

/** Ruta del transcript de una sesion: ~/.claude/projects/<cwd con lo no alfanumerico como '-'>/<id>.jsonl. */
export function transcriptPathOf(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

/**
 * `claude --agent mefisto-planner` deja en el transcript de la sesion filas
 * `{"type":"agent-setting","agentSetting":"mefisto-planner"}`; manda la ultima. Un planner lanzado como
 * subagente escribe en el transcript del subagente, nunca en el de la sesion que lo lanzo.
 */
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

export type MascotState = 'planeando' | 'pensando' | 'listo'

/** Siempre la mascota del planner: trabajando con herramientas planea, sin ellas piensa y al cerrar un foco queda lista. */
export function mascotPose(isWorking: boolean, stepsInTurn: number, hasFlash: boolean): MascotState {
  if (isWorking) return stepsInTurn > 0 ? 'planeando' : 'pensando'
  if (hasFlash) return 'listo'
  return 'planeando'
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

// Misma regla que scripts/lib/issue-dependencies.mts: solo 'Depende de #N' / 'Bloqueado por #N' al inicio
// del item de '## Dependencias', y solo el primer numero de la linea.
const DEPS_HEADER = /^##\s*dependencias/i
const FORWARD_DEP = /^\s*(?:[-*]\s+)?(?:depende de|bloqueado por)\s+#(\d+)/i

export function dependenciesOf(body: string): { deps: number[]; hasSection: boolean } {
  const deps = new Set<number>()
  let inSection = false
  let hasSection = false
  for (const line of body.split('\n')) {
    if (DEPS_HEADER.test(line)) {
      inSection = hasSection = true
      continue
    }
    if (/^##\s/.test(line)) inSection = false
    const m = inSection ? FORWARD_DEP.exec(line) : null
    if (m) deps.add(Number(m[1]))
  }
  return { deps: [...deps].sort((a, b) => a - b), hasSection }
}

/** La salida de `gh issue view N --json number,title,labels,body`, o null si no es JSON. */
export function parseIssueCard(stdout: string): IssueCard | null {
  try {
    const i = JSON.parse(stdout)
    if (typeof i?.number !== 'number') return null
    const { deps, hasSection } = dependenciesOf(i.body ?? '')
    const labels = (i.labels ?? []).map((l: { name: string }) => l.name)
    return { number: i.number, title: i.title ?? '', labels, deps, hasDepsSection: hasSection }
  } catch {
    return null
  }
}

export function briefsOf(issues: OpenIssue[]): OpenIssueBrief[] {
  return issues.map(i => ({ number: i.number, title: i.title ?? '', labels: (i.labels ?? []).map(l => l.name) }))
}

const LABEL_ORDER = ['tipo:', 'dom:', 'estado:']

/** tipo, dom y estado primero; el resto despues, en orden alfabetico. */
export function labelsText(labels: string[]): string {
  const rank = (l: string) => {
    const i = LABEL_ORDER.findIndex(p => l.startsWith(p))
    return i === -1 ? LABEL_ORDER.length : i
  }
  return [...labels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join(' · ')
}

/** Una dependencia cerrada esta cumplida; una abierta dice en que estado va. */
export function depsText(card: IssueCard, open: OpenIssueBrief[]): string {
  if (!card.hasDepsSection) return 'sin sección ## Dependencias'
  if (card.deps.length === 0) return 'no depende de nada'
  const byNumber = new Map(open.map(i => [i.number, i]))
  const parts = card.deps.map(n => {
    const dep = byNumber.get(n)
    if (!dep) return `#${n} ✓`
    const estado = dep.labels.find(l => l.startsWith('estado:'))
    return `#${n} ${estado ? estado.slice('estado:'.length) : 'abierto'}`
  })
  return `depende de ${parts.join(' · ')}`
}

/** Los issues de las listas de next-order que van tras #N. */
export function blockedBy(issue: number, lists: (BoardList | null)[]): number[] {
  const out = new Set<number>()
  for (const l of lists) for (const i of l?.items ?? []) if (i.after.includes(issue)) out.add(i.number)
  return [...out].sort((a, b) => a - b)
}

export function blocksText(blocked: number[]): string {
  return blocked.length > 0 ? `bloquea ${blocked.map(n => `#${n}`).join(' ')}` : 'no bloquea a nadie'
}

/** Ficha corta de un borrador creado en la sesion: `#N titulo · tipo:x`. */
export function createdCardText(n: number, open: OpenIssueBrief[], max: number): string {
  const issue = open.find(i => i.number === n)
  if (!issue) return `#${n}`
  const tipo = issue.labels.find(l => l.startsWith('tipo:'))
  const tail = tipo ? ` · ${tipo}` : ''
  return `#${n} ${clip(issue.title, Math.max(10, max - String(n).length - 2 - tail.length))}${tail}`
}

export function minutesSince(startedMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startedMs) / 60_000))
}

// En una exploracion con borradores creados el cuerpo de la banda es la lista de borradores (#2217).
export function showsDraftList(focus: { kind: string; created: number[] } | null): boolean {
  return focus?.kind === 'explorar' && focus.created.length > 0
}
