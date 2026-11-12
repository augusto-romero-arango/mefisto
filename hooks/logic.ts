import type { BoardItem, BoardList } from './types'

export const NEXT_ORDER_FILE = 'scripts/next-order.mts'

/** Ruta de next-order.mts bajo la raiz del plugin (`root` sin barra final). */
export function nextOrderPath(root: string): string {
  return `${root.replace(/\/+$/, '')}/${NEXT_ORDER_FILE}`
}

const TYPE_LETTERS: Record<string, { letter: string; color: string }> = {
  feature: { letter: 'F', color: 'success' },
  refactor: { letter: 'R', color: 'warning' },
  projection: { letter: 'P', color: 'cyan' },
  tooling: { letter: 'T', color: 'magenta' },
  infra: { letter: 'I', color: 'blue' },
}

/** Letra y color del tipo (`tipo` de next-order --json); `?` gris si falta o es desconocido. */
export function typeBadge(tipo: string | null | undefined): { letter: string; color: string } {
  return (tipo ? TYPE_LETTERS[tipo] : undefined) ?? { letter: '?', color: 'gray' }
}
/** Filas fijas de la lista: la banda no cambia de alto con la cantidad de issues. */
export const LIST_ROWS = 5

type NextOrderJson = {
  items?: { number: number; title: string; tipo?: string | null; after?: number[]; hasDepsSection?: boolean }[]
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
    tipo: i.tipo ?? null,
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
export function numberWidth(items: { number: number }[]): number {
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
  return clip(line.replace(/^quiero explorar:\s*/i, ''), 70)
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

/** Cuanto tiempo se oculta un issue en transicion si ningun refresco confirma el cambio. */
export const PENDING_TTL_MS = 60_000

/** Transiciones pendientes: numero de issue -> instante (ms) en que se registro. */
export type Pending = ReadonlyMap<number, number>

export function addPending(pending: Pending, issue: number, nowMs: number): Pending {
  return new Map(pending).set(issue, nowMs)
}

/** Quita un issue de la lista de borradores sin reordenar ni tocar el resto. */
export function dropIssue(list: BoardList | null, issue: number): BoardList | null {
  if (!list || !list.items.some(i => i.number === issue)) return list
  return { ...list, items: list.items.filter(i => i.number !== issue) }
}

/**
 * Aplica las transiciones pendientes a una lista recien refrescada: filtra los pendientes vigentes y devuelve
 * las que siguen pendientes (salen si el refresco ya no los trae como borrador, o al pasar PENDING_TTL_MS).
 * Una lista con error de next-order no confirma nada: sus pendientes solo vencen por plazo.
 */
export function applyPending(list: BoardList, pending: Pending, nowMs: number): { list: BoardList; pending: Pending } {
  const present = new Set(list.items.map(i => i.number))
  const kept = new Map<number, number>()
  for (const [n, since] of pending) {
    if (nowMs - since < PENDING_TTL_MS && (list.error !== null || present.has(n))) kept.set(n, since)
  }
  const items = kept.size > 0 ? list.items.filter(i => !kept.has(i.number)) : list.items
  return { list: items === list.items ? list : { ...list, items }, pending: kept }
}

/** El cierre del planner: ejecuta field-note.mts, con ruta sin comillas o entre comillas (puede tener espacios). */
export function isPlannerClosing(command: string): boolean {
  return runs(command, String.raw`(?:node\s+)?(?:\S*/|"(?:[^"]*/)?|'(?:[^']*/)?)?field-note\.mts\b`) !== null
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
 * `claude --agent mefisto:planner` deja en el transcript de la sesion filas
 * `{"type":"agent-setting","agentSetting":"mefisto:planner"}`; manda la ultima. Un planner lanzado como
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

/**
 * El manifiesto `.claude-plugin/plugin.json` en la raiz del repo es el del propio plugin Mefisto: ahi el tablero
 * es el mod interno (`.claude/mods/mefisto-planner-board`) y el publicado no aplica (su next-order.mts es solo del
 * consumidor).
 */
export function isMefistoManifest(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { name?: unknown }).name === 'mefisto'
  } catch {
    return false
  }
}

// Una exploracion que ya creo borradores muestra la lista de borradores como cuerpo de la banda.
export function showsDraftList(focus: { kind: 'explorar' | 'refinar'; created: number[] } | null | undefined): boolean {
  return focus?.kind === 'explorar' && focus.created.length > 0
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function semverOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  try {
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' && SEMVER.test(version) ? version : null
  } catch {
    return null
  }
}

/** `v<version>` del release cargado: la de `mefisto-manifest.json` si es SemVer valida, si no la de `plugin.json`, si no `null`. */
export function versionLabel(manifestRaw: string | null | undefined, pluginRaw: string | null | undefined): string | null {
  const version = semverOf(manifestRaw) ?? semverOf(pluginRaw)
  return version === null ? null : `v${version}`
}

/** Rearme tras /clear, /resume o /branch: el modulo quiere el mod activo (elegible y no apagado) pero el atom quedo en blanco. */
export function shouldRearm(s: { isEligible: boolean; isWanted: boolean; isActive: boolean }): boolean {
  return s.isEligible && s.isWanted && !s.isActive
}
