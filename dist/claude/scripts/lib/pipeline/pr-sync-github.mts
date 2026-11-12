// Lo que `pr-sync` hace en GitHub despues de sincronizar un PR: mergearlo con reintentos y quitar
// el label `bloqueado` a los issues que solo esperaban a los que ese PR cierra.

import type { Run } from '../azure-cli.mts'
import type { CommandOptions, CommandResult } from '../cli.mts'
import { dump } from '../jq-values.mts'
import type { Json } from '../jq-values.mts'
import { appendText } from './pipeline-log.mts'
import type { LoggedRun, PipelineLog } from './pipeline-log.mts'

export interface PrSyncGithubTools {
  /** `gh`, sin shell. */
  run: Run
  runLogged: LoggedRun
  options: CommandOptions
  log: PipelineLog
  /** Log de la corrida: recibe la salida de `gh pr merge` y de `gh issue edit`. */
  logFile: string
  sleep: (seconds: number) => Promise<void>
}

function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

/** `$(cmd 2>/dev/null || echo "<fallback>")`: si falla, lo que alcanzo a imprimir seguido del fallback. */
export function orEcho(result: CommandResult, fallback: string): string {
  return chomp(result.stdout + (result.status === 0 ? '' : `${fallback}\n`))
}

/** `jq -r '<campo> // "<fallback>"'` sobre `text`, o `fallback` si `text` no es JSON. */
export function rawFieldOr(text: string, field: string, fallback: string): string {
  let value: Json
  try {
    value = JSON.parse(text) as Json
  } catch {
    return fallback
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback
  const picked = value[field]
  if (picked === undefined || picked === null || picked === false) return fallback
  return typeof picked === 'string' ? picked : dump(picked, 2)
}

const MERGE_METHODS_FILTER = `(if .allow_merge_commit then "merge " else "" end)
            + (if .allow_squash_merge then "squash " else "" end)
            + (if .allow_rebase_merge then "rebase" else "" end)`

/**
 * Flag de `gh pr merge` para los metodos que el repo permite, con preferencia merge, squash,
 * rebase. Sin ninguno conocido queda `--merge`.
 */
export function mergeFlag(methods: string): string {
  if (methods.includes('merge')) return '--merge'
  if (methods.includes('squash')) return '--squash'
  if (methods.includes('rebase')) return '--rebase'
  return '--merge'
}

/** Rechazos de GitHub que reintentar no resuelve. */
const NOT_RETRYABLE = /not allowed|not mergeable|required|not authorized|changes requested|conflict/i
const MAX_MERGE_ATTEMPTS = 5

/**
 * Mergea el PR cuando GitHub lo reporta mergeable, con hasta cinco consultas separadas por
 * esperas de 3, 6, 12 y 24 s. `true` si el PR termina mergeado, aunque `gh pr merge` falle despues.
 */
export async function mergePrWithRetry(pr: string, tools: PrSyncGithubTools): Promise<boolean> {
  const { log } = tools
  const gh = (args: string[]): CommandResult => tools.run('gh', args, tools.options)
  const flag = mergeFlag(chomp(gh(['api', 'repos/{owner}/{repo}', '--jq', MERGE_METHODS_FILTER]).stdout))
  log.log(`Método de merge permitido por el repo: ${flag.slice(2)}`)

  let waitSeconds = 3
  let status = ''
  let mergeAttempted = false
  let mergeFailure = ''
  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
    // Un PR cerrado informa UNKNOWN como mergeStateStatus: el `state` evita confundirlo con un merge pendiente.
    const view = orEcho(gh(['pr', 'view', pr, '--json', 'state,mergeStateStatus']), '{"state":"UNKNOWN","mergeStateStatus":"UNKNOWN"}')
    const prState = rawFieldOr(view, 'state', 'UNKNOWN')
    status = rawFieldOr(view, 'mergeStateStatus', 'UNKNOWN')
    mergeAttempted = false
    mergeFailure = ''

    if (prState === 'MERGED') return true

    if (status === 'CLEAN' || status === 'UNSTABLE' || status === 'HAS_HOOKS') {
      mergeAttempted = true
      const merge = gh(['pr', 'merge', pr, flag, '--delete-branch'])
      const mergeOut = chomp(merge.stdout + merge.stderr)
      appendText(tools.logFile, `${mergeOut}\n`)
      if (merge.status === 0) return true
      const mergedState = orEcho(gh(['pr', 'view', pr, '--json', 'state', '-q', '.state']), 'UNKNOWN')
      if (mergedState === 'MERGED') {
        log.warn(`PR #${pr}: el merge se completó, pero gh pr merge falló después: ${mergeOut}`)
        return true
      }
      if (NOT_RETRYABLE.test(mergeOut)) {
        log.warn(`PR #${pr}: GitHub rechazó el merge y no es reintentable → ${mergeOut}`)
        return false
      }
      mergeFailure = mergeOut.split('\n').find((line) => /[^ \t]/.test(line)) ?? '(sin salida)'
    }

    if (attempt < MAX_MERGE_ATTEMPTS) {
      if (mergeAttempted) {
        log.log(`gh pr merge falló: ${mergeFailure}. Reintentando en ${waitSeconds}s... (${attempt}/${MAX_MERGE_ATTEMPTS})`)
      } else {
        log.log(
          `GitHub aún no reporta PR #${pr} como mergeable (estado: ${status}). Reintentando en ${waitSeconds}s... (${attempt}/${MAX_MERGE_ATTEMPTS})`,
        )
      }
      await tools.sleep(waitSeconds)
      waitSeconds *= 2
    }
  }

  if (mergeAttempted) {
    log.warn(`PR #${pr}: gh pr merge falló tras ${MAX_MERGE_ATTEMPTS} intentos: ${mergeFailure}`)
  } else {
    log.warn(`PR #${pr} no fue mergeable después de ${MAX_MERGE_ATTEMPTS} intentos (último estado: ${status})`)
  }
  return false
}

/** Numeros de los `Closes #N` del body, en orden y con repeticiones, sin distinguir mayusculas. */
export function closedIssueNumbers(body: string): string[] {
  const found: string[] = []
  for (const line of body.split('\n')) {
    for (const match of line.matchAll(/Closes #([0-9]+)/gi)) found.push(match[1] ?? '')
  }
  return found
}

/**
 * Lineas de la seccion `## Dependencias` del body, sin su encabezado. Mas estricta que la de
 * `issue-dependencies.mts`: el encabezado va exacto, con un espacio y en mayuscula.
 */
export function dependencySectionLines(body: string): string[] {
  const lines: string[] = []
  let inside = false
  for (const line of body.split('\n')) {
    if (line.startsWith('## Dependencias')) {
      inside = true
      continue
    }
    if (line.startsWith('## ')) inside = false
    if (inside) lines.push(line)
  }
  return lines
}

/** `true` si alguna linea nombra `#<issue>` sin que lo siga otro digito. */
export function referencesIssue(lines: readonly string[], issue: string): boolean {
  const pattern = new RegExp(`#${issue}([^0-9]|$)`)
  return lines.some((line) => pattern.test(line))
}

const SPACE = '[ \\t\\n\\v\\f\\r]'
const FORWARD = new RegExp(`^${SPACE}*([-*]${SPACE}+)?(Depende de|Bloqueado por)${SPACE}+#([0-9]+)`, 'i')

/** Dependencias forward ('Depende de #N' / 'Bloqueado por #N' al inicio del item), sin repetir y en orden de texto. */
export function forwardDependencyNumbers(lines: readonly string[]): string[] {
  const found = new Set<string>()
  for (const line of lines) {
    const number = FORWARD.exec(line)?.[3]
    if (number !== undefined) found.add(number)
  }
  return [...found].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

function rawText(value: Json | undefined): string {
  if (value === undefined) return 'null'
  return typeof value === 'string' ? value : dump(value, 2)
}

/** `jq -r '<campo> // ""'`. */
function rawOrEmpty(value: Json | undefined): string {
  return value === undefined || value === null || value === false ? '' : rawText(value)
}

/**
 * Tras mergear `pr`, quita el label `bloqueado` a cada issue abierto que referencia en su
 * `## Dependencias` un issue que el PR cierra y cuyas dependencias forward estan todas cerradas.
 */
export function unblockDependentIssues(pr: string, tools: PrSyncGithubTools): void {
  const { log } = tools
  const gh = (args: string[]): CommandResult => tools.run('gh', args, tools.options)
  const body = orEcho(gh(['pr', 'view', pr, '--json', 'body', '-q', '.body']), '')
  if (body.length === 0) return

  const closed = closedIssueNumbers(body)
  if (closed.length === 0) return

  log.log(`PR #${pr} cierra issue(s): ${closed.join(' ')}. Buscando issues bloqueados dependientes...`)

  const blockedJson = orEcho(gh(['issue', 'list', '--state', 'open', '--label', 'bloqueado', '--json', 'number,body,title']), '[]')
  if (blockedJson === '[]' || blockedJson.length === 0) {
    log.log("No hay issues con label 'bloqueado'.")
    return
  }
  let blocked: Json
  try {
    blocked = JSON.parse(blockedJson) as Json
  } catch {
    return
  }
  if (!Array.isArray(blocked)) return

  for (const item of blocked) {
    const fields = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : {}
    const number = rawText(fields.number ?? null)
    const issueBody = rawOrEmpty(fields.body)
    const title = rawOrEmpty(fields.title)
    const section = dependencySectionLines(chomp(issueBody))
    if (!closed.some((issue) => referencesIssue(section, issue))) continue

    const deps = forwardDependencyNumbers(section)
    if (deps.length === 0) {
      log.warn(
        `Issue #${number} referencia un issue recien cerrado en su sección '## Dependencias' pero sin redacción canónica parseable ('Depende de #N' / 'Bloqueado por #N'); no se pudo evaluar su desbloqueo automático.`,
      )
      continue
    }

    let open = ''
    for (const dep of deps) {
      if (orEcho(gh(['issue', 'view', dep, '--json', 'state', '-q', '.state']), '') === 'CLOSED') continue
      const prState = orEcho(gh(['pr', 'view', dep, '--json', 'state', '-q', '.state']), '')
      if (prState === 'MERGED' || prState === 'CLOSED') continue
      open = dep
      break
    }

    if (open.length === 0) {
      log.log(`Desbloqueando issue #${number}: ${title}`)
      if (tools.runLogged('gh', ['issue', 'edit', number, '--remove-label', 'bloqueado'], tools.logFile, tools.options) === 0) {
        log.success(`Issue #${number} desbloqueado: ${title}`)
      } else {
        log.warn(`No se pudo quitar el label 'bloqueado' del issue #${number}`)
      }
    } else {
      log.log(`Issue #${number} sigue bloqueado (dependencia #${open} aun abierta)`)
    }
  }
}
