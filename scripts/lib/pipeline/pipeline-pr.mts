// Lo que un pipeline hace contra GitHub al abrir y cerrar una corrida: leer el issue, publicar la
// rama, crear o comentar el PR y comentar el issue; y las piezas del cuerpo del PR que comparten
// los pipelines (resumen de cada agente, duraciones). Buscar un PR abierto vive en
// `pull-requests.mts`.

import { readFileSync, statSync } from 'node:fs'

import type { Run } from '../azure-cli.mts'
import type { CommandOptions } from '../cli.mts'
import { appendText } from './pipeline-log.mts'
import type { LoggedRun } from './pipeline-log.mts'

/** Lo que deja `$(...)` de bash: el texto sin sus saltos de linea finales. */
function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

/** `owner/repo` de la URL de un remoto de GitHub que termina en `.git`; cualquier otra URL vuelve tal cual. */
export function repoSlugFromRemoteUrl(url: string): string {
  return url
    .split('\n')
    .map((line) => line.replace(/.*github.com[:/](.*)\.git/, '$1'))
    .join('\n')
}

/** `Xm Ys`; una duracion vacia o ausente cuenta como cero. */
export function formatMinutes(seconds: number | string | null): string {
  const text = seconds === null ? '' : String(seconds)
  const total = /^-?[0-9]+$/.test(text) ? Number(text) : 0
  return `${Math.trunc(total / 60)}m ${total % 60}s`
}

export interface IssueView {
  /** `state` del issue, o `UNKNOWN` si la respuesta no es el JSON esperado. */
  state: string
  /**
   * Titulo como lo extraian los pipelines bash: el texto crudo entre comillas de `"title":"..."`,
   * sin decodificar. Un titulo con comillas queda cortado en la primera y conserva la barra de
   * su escape. `null` si la respuesta no trae ese campo.
   */
  title: string | null
  body: string
}

/** Lee lo que imprime `gh issue view --json ...,title,body,state`. */
export function parseIssueView(raw: string): IssueView {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const issue =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  const state = issue !== null && Object.hasOwn(issue, 'state') ? issue.state : undefined
  const titles = [...raw.matchAll(/"title":"[^"\n]*"/g)].map((match) => match[0].slice('"title":"'.length, -1))
  return {
    state: state === undefined ? 'UNKNOWN' : typeof state === 'string' ? state : pythonRepr(state),
    title: titles.length > 0 ? titles.join('\n') : null,
    body: issue !== null && Object.hasOwn(issue, 'body') ? chomp(pythonRepr(issue.body)) : rawBody(raw),
  }
}

// El bash imprimia estos campos con `print()` de Python.
function pythonRepr(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return JSON.stringify(value)
}

// Recorte de respaldo sobre el JSON crudo cuando no trae `body` como campo legible.
function rawBody(raw: string): string {
  return chomp(
    raw
      .split('\n')
      .map((line) =>
        line
          .replace(/.*"body":"/, '')
          .replace(/","[^"]*":".*/, '')
          .replaceAll('\\n', '\n')
          .replaceAll('\\r', ''),
      )
      .join('\n'),
  )
}

export interface GithubTools {
  run: Run
  runLogged: LoggedRun
  /** Log del pipeline, que recibe lo que `gh` y `git` escriben. */
  logFile: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

function commandOptions(tools: Pick<GithubTools, 'cwd' | 'env'>): CommandOptions {
  return {
    ...(tools.cwd === undefined ? {} : { cwd: tools.cwd }),
    ...(tools.env === undefined ? {} : { env: tools.env }),
  }
}

/**
 * Respuesta cruda de `gh issue view <issue> --json <fields>`, o `null` si `gh` falla; su salida
 * de error queda en el log.
 */
export function viewIssue(issue: string, fields: string, tools: Omit<GithubTools, 'runLogged'>): string | null {
  const result = tools.run('gh', ['issue', 'view', issue, '--json', fields], commandOptions(tools))
  appendText(tools.logFile, result.stderr)
  return result.status === 0 ? chomp(result.stdout) : null
}

/**
 * Resumen que un agente dejo en `file`, sin saltos finales, o `missing` si no lo escribio. Va
 * dentro del cuerpo del PR.
 */
export function collectSummary(file: string | null, missing = '_(El agente no genero resumen)_'): string {
  if (file !== null) {
    try {
      if (statSync(file).isFile()) return chomp(readFileSync(file, 'utf8'))
    } catch {
      // Sin archivo legible vale lo mismo que sin resumen.
    }
  }
  return missing
}

/** Bloque plegable del cuerpo del PR con el resumen de un agente y lo que tardo. */
export function summaryDetails(label: string, seconds: number | string | null, summary: string): string {
  return `<details>\n<summary>${label} -- ${formatMinutes(seconds)}</summary>\n\n${summary}\n\n</details>`
}

/** `git push -u origin <branch>` desde `worktree`; `false` si falla. */
export function pushBranch(worktree: string, branch: string, tools: GithubTools): boolean {
  const args = ['-C', worktree, 'push', '-u', 'origin', branch]
  return tools.runLogged('git', args, tools.logFile, commandOptions(tools)) === 0
}

export interface PullRequestDraft {
  title: string
  body: string
  /** Rama base; por defecto `main`. */
  base?: string
  head: string
  /** `owner/repo`. */
  repo: string
}

/** Crea el PR y devuelve su URL, o `null` si `gh` falla; su salida de error queda en el log. */
export function createPullRequest(draft: PullRequestDraft, tools: Omit<GithubTools, 'runLogged'>): string | null {
  const result = tools.run(
    'gh',
    ['pr', 'create', '--title', draft.title, '--body', draft.body, '--base', draft.base ?? 'main', '--head', draft.head, '--repo', draft.repo],
    commandOptions(tools),
  )
  appendText(tools.logFile, result.stderr)
  return result.status === 0 ? chomp(result.stdout) : null
}

/** Comenta el PR `url`; `false` si `gh` falla. */
export function commentPullRequest(url: string, body: string, repo: string, tools: GithubTools): boolean {
  const args = ['pr', 'comment', url, '--body', body, '--repo', repo]
  return tools.runLogged('gh', args, tools.logFile, commandOptions(tools)) === 0
}

/** Comenta el issue; `false` si `gh` falla. */
export function commentIssue(issue: string, body: string, repo: string, tools: GithubTools): boolean {
  const args = ['issue', 'comment', issue, '--body', body, '--repo', repo]
  return tools.runLogged('gh', args, tools.logFile, commandOptions(tools)) === 0
}

const two = (value: number): string => String(value).padStart(2, '0')

/**
 * Abreviatura de la zona horaria local, lo mas cerca posible de `date +%Z`: el nombre corto que
 * conoce el sistema (`EST`, `UTC`) o el desfase (`-05`, `+0530`). No hay tabla de abreviaturas
 * fuera de las zonas de EE. UU., asi que una zona como `CET` sale como `+01`.
 */
export function zoneAbbreviation(date: Date): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
  const offset = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name)
  if (offset === null) return name
  return `${offset[1] ?? ''}${two(Number(offset[2]))}${offset[3] ?? ''}`
}

/** `YYYY-MM-DD HH:MM:SS <zona>` en hora local. */
export function localDateTimeWithZone(date: Date): string {
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  return `${day} ${time} ${zoneAbbreviation(date)}`
}

/** Comentario que actualiza la tabla de metricas en un PR reutilizado. */
export function metricsComment(table: string, now: Date): string {
  return `## Metricas de la corrida\n\nActualizado: ${localDateTimeWithZone(now)}\n\n${table}`
}
