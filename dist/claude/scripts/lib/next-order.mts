// Orden topologico de los issues abiertos de un repo segun sus '## Dependencias'.
//
// Lo comparten `scripts/next-order.mts` (repo consumidor) y
// `src/internal/scripts/mefisto-next-order.mts` (repo de Mefisto). Cada uno aporta lo que difiere:
// sus flags, las ramas que delatan un PR y la forma de su salida.
//
// Universo: los issues abiertos 'estado:listo' (lanzamiento) o 'estado:borrador' (refinamiento).
// El label 'bloqueado' no filtra nada y nunca se muta. Una dependencia fuera del universo esta
// satisfecha si esta CLOSED o MERGED y, en refinamiento, tambien si es un 'estado:listo' abierto.
//
// Cada issue del universo termina en exactamente uno de estos casos, y todos se reportan:
//   - En PR (solo lanzamiento): un PR abierto lo lista en `closingIssuesReferences` o sale de una
//     rama suya; con varios gana el de menor numero. Quien depende de el queda bloqueado con
//     reason 'pr'.
//   - Bloqueo externo: declara una dependencia abierta que no esta en el universo.
//   - Ciclo: depende directa o indirectamente de si mismo.
//   - Bloqueo indirecto: alguna de sus dependencias del universo quedo fuera del orden.
//   - Lanzable: entra al orden por Kahn; entre los disponibles gana el menor numero en
//     lanzamiento y el mayor en refinamiento.

import { CliError, capture } from './cli.mts'
import type { CommandResult } from './cli.mts'
import { forwardDependencies, hasDependenciesSection } from './issue-dependencies.mts'

export type Mode = 'launch' | 'refinement'

/** Corre `gh` con esos argumentos; los tests lo sustituyen por fixtures. */
export type Gh = (args: string[]) => CommandResult

export const ghCli: Gh = (args) => capture('gh', args)

// Con el universo truncado el orden saldria bien calculado sobre un grafo incompleto.
const ISSUE_LIMIT = 200

export interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
}

export interface UniverseQuery {
  mode: Mode
  gh: Gh
  /** Campos de `gh issue list --json`. */
  issueFields: string
  /** Un PR abierto cubre el issue N si su rama empieza con `<prefijo>N-`. */
  prBranchPrefixes: string[]
}

export interface Universe {
  mode: Mode
  label: string
  /** Por numero ascendente. */
  issues: Issue[]
  /** Numeros 'estado:listo' abiertos; solo en refinamiento. */
  listo: Set<string>
  /** Numero de issue -> su PR abierto de menor numero; solo en lanzamiento. */
  prByIssue: Map<string, number>
  /** Avisos para stderr. */
  warnings: string[]
}

export type BlockReason = 'external' | 'indirect' | 'pr'

export interface Blocked {
  number: number
  /** La dependencia tal como esta escrita en el body. */
  by: string
  reason: BlockReason
  pr?: number
}

export interface OrderItem {
  issue: Issue
  /** Dependencias del universo, ascendentes. */
  after: number[]
  hasDepsSection: boolean
}

export interface IssueInPr {
  issue: Issue
  pr: number
}

export interface Order {
  mode: Mode
  label: string
  items: OrderItem[]
  blocked: Blocked[]
  inPr: IssueInPr[]
  cycles: number[][]
}

export interface Outcome {
  /** 0 con al menos un issue en el orden; 1 si quedo vacio. */
  status: number
  stdout: string
  warnings: string[]
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArray(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function listIssues(gh: Gh, label: string, fields: string): unknown[] {
  const result = gh(['issue', 'list', '--label', label, '--state', 'open', '--limit', String(ISSUE_LIMIT), '--json', fields])
  if (result.status !== 0) throw new CliError(`ERROR: fallo 'gh issue list --label ${label} --state open'.`, 2)
  return parseArray(result.stdout)
}

function toIssue(raw: unknown): Issue | null {
  if (!isObject(raw) || typeof raw.number !== 'number') return null
  const labels = Array.isArray(raw.labels) ? raw.labels : []
  return {
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    labels: labels.flatMap((label) => (isObject(label) && typeof label.name === 'string' ? [label.name] : [])),
  }
}

function coversIssue(pr: JsonObject, issue: number, branchPrefixes: string[]): boolean {
  const closing = Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences : []
  if (closing.some((reference) => isObject(reference) && reference.number === issue)) return true
  const branch = typeof pr.headRefName === 'string' ? pr.headRefName : ''
  return branchPrefixes.some((prefix) => branch.startsWith(`${prefix}${issue}-`))
}

function openPrByIssue(query: UniverseQuery, issues: Issue[], warnings: string[]): Map<string, number> {
  const byIssue = new Map<string, number>()
  const result = query.gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,closingIssuesReferences'])
  if (result.status !== 0) {
    warnings.push('ADVERTENCIA: no se pudo consultar PRs abiertos; el orden no excluye issues en PR')
    return byIssue
  }
  const prs = parseArray(result.stdout).filter(isObject)
  for (const issue of issues) {
    const numbers = prs
      .filter((pr) => coversIssue(pr, issue.number, query.prBranchPrefixes))
      .flatMap((pr) => (typeof pr.number === 'number' ? [pr.number] : []))
    if (numbers.length > 0) byIssue.set(String(issue.number), Math.min(...numbers))
  }
  return byIssue
}

/** Consulta el universo del modo. Lanza `CliError` (exit 2) si `gh issue list` falla. */
export function loadUniverse(query: UniverseQuery): Universe {
  const { mode, gh } = query
  const label = mode === 'refinement' ? 'estado:borrador' : 'estado:listo'
  const listed = listIssues(gh, label, query.issueFields)
  const listo = new Set<string>()
  if (mode === 'refinement') {
    for (const entry of listIssues(gh, 'estado:listo', 'number')) {
      if (isObject(entry) && typeof entry.number === 'number') listo.add(String(entry.number))
    }
  }
  const warnings: string[] = []
  if (listed.length >= ISSUE_LIMIT) {
    warnings.push(
      `ADVERTENCIA: 'gh issue list' devolvio ${listed.length} issues (--limit ${ISSUE_LIMIT}):`,
      'el universo puede estar truncado y el orden calculado sobre un grafo incompleto.',
    )
  }
  const issues = listed.flatMap((raw) => toIssue(raw) ?? []).sort((a, b) => a.number - b.number)
  const prByIssue = mode === 'launch' ? openPrByIssue(query, issues, warnings) : new Map<string, number>()
  return { mode, label, issues, listo, prByIssue, warnings }
}

// Una dependencia puede ser un PR: si `gh issue view` falla se pregunta por el PR.
function dependencyState(gh: Gh, dependency: string): string {
  for (const kind of ['issue', 'pr']) {
    const result = gh([kind, 'view', dependency, '--json', 'state', '-q', '.state'])
    if (result.status === 0) return result.stdout.replace(/[\r\n]+$/, '')
  }
  return ''
}

interface Node {
  issue: Issue
  /** Dependencias abiertas dentro del universo. */
  deps: string[]
  hasDepsSection: boolean
  /** Ya se sabe que no puede entrar al orden. */
  excluded: boolean
  resolved: boolean
  indegree: number
}

/** Clasifica cada issue del universo. Solo consulta `gh` por las dependencias de fuera. */
export function computeOrder(universe: Universe, gh: Gh): Order {
  const { mode, label, issues, listo, prByIssue } = universe
  const members = new Set(issues.map((issue) => String(issue.number)))
  const inPr: IssueInPr[] = []
  const blocked: Blocked[] = []
  const nodes: Node[] = []

  for (const issue of issues) {
    const number = issue.number
    const ownPr = prByIssue.get(String(number))
    if (ownPr !== undefined) {
      inPr.push({ issue, pr: ownPr })
      continue
    }
    const deps: string[] = []
    let excluded = false
    for (const dependency of forwardDependencies(issue.body)) {
      if (dependency === String(number)) continue
      const dependencyPr = prByIssue.get(dependency)
      if (dependencyPr !== undefined) {
        excluded = true
        blocked.push({ number, by: dependency, reason: 'pr', pr: dependencyPr })
        continue
      }
      if (members.has(dependency)) {
        deps.push(dependency)
        continue
      }
      if (listo.has(dependency)) continue
      const state = dependencyState(gh, dependency)
      if (state === 'CLOSED' || state === 'MERGED') continue
      excluded = true
      blocked.push({ number, by: dependency, reason: 'external' })
    }
    nodes.push({
      issue,
      deps,
      hasDepsSection: hasDependenciesSection(issue.body),
      excluded,
      resolved: false,
      indegree: deps.length,
    })
  }

  const nodeOf = new Map(nodes.map((node) => [String(node.issue.number), node]))

  // Un nodo excluido nunca se elige ni descuenta a sus dependientes, que por eso quedan sin
  // resolver y se reportan como bloqueo indirecto.
  const ordered: Node[] = []
  for (;;) {
    let best: Node | undefined
    for (const node of nodes) {
      if (node.resolved || node.excluded || node.indegree !== 0) continue
      const wins =
        best === undefined ||
        (mode === 'refinement' ? node.issue.number > best.issue.number : node.issue.number < best.issue.number)
      if (wins) best = node
    }
    if (best === undefined) break
    best.resolved = true
    ordered.push(best)
    const chosen = String(best.issue.number)
    for (const node of nodes) {
      if (!node.resolved && node.deps.includes(chosen)) node.indegree--
    }
  }

  // DFS sobre lo que quedo sin resolver: al reencontrar un nodo de la pila actual, el tramo de la
  // pila desde ese nodo es el ciclo. Quien solo depende de un ciclo queda antes en la pila y no
  // entra en el.
  const cycles: number[][] = []
  const visiting = new Set<Node>()
  const visited = new Set<Node>()
  const stack: Node[] = []
  const visit = (node: Node): void => {
    visiting.add(node)
    stack.push(node)
    for (const dependency of node.deps) {
      const next = nodeOf.get(dependency)
      if (next === undefined || next.resolved) continue
      if (visiting.has(next)) cycles.push(stack.slice(stack.indexOf(next)).map((member) => member.issue.number))
      else if (!visited.has(next)) visit(next)
    }
    visiting.delete(node)
    visited.add(node)
    stack.pop()
  }
  for (const node of nodes) {
    if (!node.resolved && !visited.has(node)) visit(node)
  }

  const inCycle = new Set(cycles.flat())
  for (const node of nodes) {
    if (node.resolved || node.excluded || inCycle.has(node.issue.number)) continue
    for (const dependency of node.deps) {
      if (nodeOf.get(dependency)?.resolved !== false) continue
      blocked.push({ number: node.issue.number, by: dependency, reason: 'indirect' })
    }
  }

  const items = ordered.map((node) => ({
    issue: node.issue,
    after: node.deps.map(Number).sort((a, b) => a - b),
    hasDepsSection: node.hasDepsSection,
  }))
  return { mode, label, items, blocked, inPr, cycles }
}

function blockedLine(entry: Blocked, label: string): string {
  const head = `#${entry.number} bloqueado por #${entry.by}`
  if (entry.reason === 'pr') return `${head}: espera el merge del PR #${entry.pr}`
  if (entry.reason === 'indirect') return `${head}: excluido del orden`
  return `${head}: fuera de ${label}, estado OPEN`
}

/** Cabecera del reporte: ciclos, issues en PR y bloqueos, o la linea que dice que no hay. */
export function headerLines(order: Order): string[] {
  const lines = [
    ...order.cycles.map((cycle) => `ciclo: ${[...cycle, ...cycle.slice(0, 1)].map((n) => `#${n}`).join(' -> ')}`),
    ...order.inPr.map((entry) => `#${entry.issue.number} en PR #${entry.pr}: pendiente de merge`),
    ...order.blocked.map((entry) => blockedLine(entry, order.label)),
  ]
  return lines.length > 0 ? lines : ['Sin ciclos ni bloqueos externos.']
}

export interface TextShape {
  /** Texto entre el numero y el titulo en cada linea del orden. */
  itemTag: (issue: Issue) => string
  /** Lineas finales en lanzamiento, tambien con el orden vacio. */
  launchTail: (order: Order) => string[]
}

export function renderText(order: Order, shape: TextShape): string {
  const lines = [...headerLines(order), '']
  order.items.forEach((item, index) => {
    const reason =
      item.after.length === 0 ? 'sin dependencias abiertas' : `tras ${item.after.map((n) => `#${n}`).join(', ')}`
    lines.push(`${index + 1}. #${item.issue.number} ${shape.itemTag(item.issue)}${item.issue.title} -- ${reason}`)
  })
  if (order.mode === 'refinement') {
    const first = order.items[0]
    lines.push(`Siguiente a refinar: ${first === undefined ? '(sin borradores refinables)' : `#${first.issue.number}`}`)
  } else {
    lines.push(...shape.launchTail(order))
  }
  return `${lines.join('\n')}\n`
}

export function blockedJson(order: Order): JsonObject[] {
  return order.blocked.map((entry) => ({
    number: entry.number,
    by: Number(entry.by),
    reason: entry.reason,
    ...(entry.pr === undefined ? {} : { pr: entry.pr }),
  }))
}

/** El formato que imprimia `jq`: indentado a dos espacios y con salto final. */
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function outcomeOf(order: Order, stdout: string, warnings: string[]): Outcome {
  return { status: order.items.length > 0 ? 0 : 1, stdout, warnings }
}

/** Imprime el resultado y devuelve su codigo de salida. */
export function emit(outcome: Outcome): number {
  for (const warning of outcome.warnings) console.error(warning)
  process.stdout.write(outcome.stdout)
  return outcome.status
}
