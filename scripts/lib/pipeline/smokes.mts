// Smoke tests del consumidor: carril "solo smoke" (issue #2357) y smokes existentes que invocan
// una tool MCP o una ruta HTTP que el issue modifico (issues #2473 y #2480).
//
// Gemela de `detect_smoke_only`, `smoke_tool_name`, `list_smokes_invoking_tools` y
// `list_smokes_invoking_routes` de `_pipeline-common.sh`: mientras tengan llamadores en bash, un
// cambio va en los dos lados.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { capture } from '../cli.mts'
import type { Run } from '../azure-cli.mts'
import { compare } from '../jq-values.mts'

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

export interface ChangedFile {
  kind: 'smoke' | 'docs' | 'otro'
  path: string
}

export interface SmokeDetection {
  /** Hay al menos un archivo de un proyecto `*.SmokeTests` y el resto cae ahi, en `docs/` o en `pipeline-state/`. */
  smokeOnly: boolean
  files: ChangedFile[]
}

/**
 * Clasifica lo que cambio desde `snapshot`: los commits y, salvo con `committedOnly`, tambien lo
 * que esta sin commitear y los archivos nuevos. Los proyectos `*.SmokeTests` corren post-deploy
 * (MEF-ADR-0013), asi que un issue que solo los toca nunca queda en rojo en el gate local.
 */
export function detectSmokeOnly(
  worktree: string,
  snapshot: string,
  namespacePrefix: string,
  committedOnly = false,
  run: Run = capture,
): SmokeDetection {
  const listed = (...args: string[]): string[] => {
    const result = run('git', ['-C', worktree, ...args])
    return result.status === 0 ? result.stdout.split('\n') : []
  }
  const changed = listed('diff', '--name-only', `${snapshot}..HEAD`)
  if (!committedOnly) {
    changed.push(...listed('diff', '--name-only', 'HEAD'), ...listed('ls-files', '--others', '--exclude-standard'))
  }
  const smokeProject = `tests/${namespacePrefix}.`
  const files = [...new Set(changed)]
    .filter((path) => path.length > 0)
    .sort(byBytes)
    .map((path): ChangedFile => {
      if (path.startsWith(smokeProject) && path.includes('.SmokeTests/', smokeProject.length)) return { kind: 'smoke', path }
      return { kind: path.startsWith('docs/') || path.startsWith('pipeline-state/') ? 'docs' : 'otro', path }
    })
  const smokeOnly = files.some((file) => file.kind === 'smoke') && !files.some((file) => file.kind === 'otro')
  return { smokeOnly, files }
}

/** `<clase>: <ruta>` por linea, como lo imprime bash. */
export function changedFilesText(files: readonly ChangedFile[]): string {
  return files.map((file) => `${file.kind}: ${file.path}\n`).join('')
}

function readFile(file: string): Buffer | null {
  try {
    return statSync(file).isFile() ? readFileSync(file) : null
  } catch {
    return null
  }
}

// `[[:space:]]` de POSIX dentro de una linea.
const SPACE = '[ \\t\\v\\f\\r]'
const NAME_CONSTANT = new RegExp(`^[^\\n]*NombreTool${SPACE}*=${SPACE}*"([^"]*)"`)
const TRIGGER_NAME = new RegExp(`^[^\\n]*McpToolTrigger\\(${SPACE}*"([^"]*)"`)

/**
 * Nombre MCP de la tool de `file`: el literal de `NombreTool = "<nombre>"` (convencion de
 * `/scaffold-mcp`) o, si no esta, el primero de `[McpToolTrigger("<nombre>"`. `null` si no lo extrae.
 */
export function smokeToolName(file: string): string | null {
  const lines = readFile(file)?.toString('utf8').split('\n')
  if (lines === undefined) return null
  for (const pattern of [NAME_CONSTANT, TRIGGER_NAME]) {
    for (const line of lines) {
      const name = pattern.exec(line)?.[1]
      if (name === undefined) continue
      if (name.length > 0) return name
      break
    }
  }
  return null
}

export interface SmokeInvoker {
  /** Nombre de la tool o plantilla de la ruta. */
  target: string
  /** Archivo del smoke, relativo al worktree y con `/`. */
  file: string
}

/** `<nombre o ruta>\t<archivo>` por linea, como lo imprime bash. */
export function smokeInvokersText(invokers: readonly SmokeInvoker[]): string {
  return invokers.map((invoker) => `${invoker.target}\t${invoker.file}\n`).join('')
}

/** Archivos regulares `*.cs` bajo `dir`, como rutas relativas con `/`; no sigue enlaces. */
function sourceFiles(dir: string, prefix = ''): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
    return entry.isFile() && entry.name.endsWith('.cs') ? [`${prefix}${entry.name}`] : []
  })
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Smokes de `project` (carpeta `*.SmokeTests` relativa al worktree) que contienen el literal
 * `"<nombre>"` de alguna tool de `toolFiles`. Avisa por `warn` de cada tool sin nombre extraible.
 */
export function listSmokesInvokingTools(
  worktree: string,
  project: string,
  toolFiles: readonly string[],
  warn: (message: string) => void = (message) => console.error(`warn: ${message}`),
): SmokeInvoker[] {
  const invokers: SmokeInvoker[] = []
  for (const tool of toolFiles) {
    if (tool.length === 0) continue
    const name = smokeToolName(join(worktree, tool))
    if (name === null) {
      const reason =
        readFile(join(worktree, tool)) === null
          ? 'el archivo no existe en el worktree (tool borrada o renombrada)'
          : 'sin NombreTool ni McpToolTrigger'
      warn(`No se pudo extraer el nombre de la tool MCP de '${tool}' (${reason})`)
      continue
    }
    const root = join(worktree, project)
    if (!isDirectory(root)) continue
    const literal = Buffer.from(`"${name}"`)
    const hits = sourceFiles(root)
      .filter((file) => readFile(join(root, file))?.includes(literal) === true)
      .map((file) => `${project}/${file}`)
      .sort(byBytes)
    invokers.push(...hits.map((file) => ({ target: name, file })))
  }
  return invokers
}

// La `\w` y el `\b` de Python sobre texto Unicode.
const WORD = '[\\p{L}\\p{N}_]'
const HTTP_TRIGGER = /\[\s*HttpTrigger\((.*?)\)\s*\]/gs
const ROUTE = /Route\s*=\s*"([^"]*)"/
const STRING_BODY = '((?:[^"\\\\]|\\\\[^\\n])*)'
const CONSTANT = new RegExp(`(?<!${WORD})const\\s+string\\s+(${WORD}+)\\s*=\\s*\\$?"${STRING_BODY}"\\s*;`, 'gu')
const LITERAL = new RegExp(`\\$?"${STRING_BODY}"`, 'g')
const PLACEHOLDER = new RegExp(`\\{(${WORD}+)\\}`, 'gu')

/** Texto del archivo con los saltos de linea normalizados a `\n`, o `null` si no se puede leer. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
  } catch {
    return null
  }
}

/** Plantillas `Route = "..."` de los `HttpTrigger` de `files`, sin repetir y en orden. */
function triggerRoutes(worktree: string, files: readonly string[]): string[] {
  const routes: string[] = []
  for (const file of files) {
    const text = readText(join(worktree, file))
    if (text === null) continue
    for (const trigger of text.matchAll(HTTP_TRIGGER)) {
      const route = ROUTE.exec(trigger[1] ?? '')?.[1]
      if (route !== undefined && !routes.includes(route)) routes.push(route)
    }
  }
  return routes
}

/** Cada `{param}` casa un segmento sin `/`, `?` ni `:`; la ruta termina ahi o sigue con `?`. */
function routePattern(template: string): RegExp {
  const body = template
    .replace(/^\/+|\/+$/g, '')
    .split(/(\{[^}]*\})/)
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith('{') ? '[^/?:"]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^/api/${body}(?:\\?[^\\n]*)?(?=\\n?$)`, 'iu')
}

/** Entradas visibles de `dir`; vacio si no es un directorio legible. */
function visibleEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

/** Los `*.cs` bajo `dir` a cualquier profundidad, sin entradas ocultas y siguiendo enlaces a carpetas. */
function globSources(dir: string, prefix: string, ancestors: readonly string[]): string[] {
  let real: string
  try {
    real = realpathSync.native(dir)
  } catch {
    return []
  }
  // Un enlace a una carpeta que contiene a esta no se recorre: no terminaria.
  if (ancestors.includes(real) || !isDirectory(dir)) return []
  return visibleEntries(dir).flatMap((name) => [
    ...(name.endsWith('.cs') ? [`${prefix}${name}`] : []),
    ...globSources(join(dir, name), `${prefix}${name}/`, [...ancestors, real]),
  ])
}

/**
 * Smokes de `tests/*.SmokeTests/` que invocan la ruta de un `HttpTrigger` de `endpointFiles`. En
 * cada smoke resuelve las referencias `{Constante}` a `const string` del mismo archivo y compara,
 * sin distinguir mayusculas, cada literal que empieza por `/api/`. No distingue metodo HTTP.
 */
export function listSmokesInvokingRoutes(worktree: string, endpointFiles: readonly string[]): SmokeInvoker[] {
  const tests = join(worktree, 'tests')
  if (!isDirectory(tests)) return []
  const patterns = triggerRoutes(worktree, endpointFiles).map((route) => ({ route, pattern: routePattern(route) }))
  if (patterns.length === 0) return []

  const smokes = visibleEntries(tests)
    .filter((name) => name.endsWith('.SmokeTests'))
    .flatMap((name) => globSources(join(tests, name), `tests/${name}/`, []))
    .sort(compare)
  const invokers: SmokeInvoker[] = []
  for (const file of smokes) {
    const source = readText(join(worktree, file))
    if (source === null) continue
    const constants = new Map<string, string>()
    for (const constant of source.matchAll(CONSTANT)) constants.set(constant[1] ?? '', constant[2] ?? '')
    const hit = new Set<string>()
    for (const match of source.matchAll(LITERAL)) {
      let literal = match[1] ?? ''
      // Una constante puede componerse de otra: hasta tres niveles.
      for (let pass = 0; pass < 3; pass++) {
        const resolved = literal.replace(PLACEHOLDER, (reference, name: string) => constants.get(name) ?? reference)
        if (resolved === literal) break
        literal = resolved
      }
      if (!literal.toLowerCase().startsWith('/api/')) continue
      for (const { route, pattern } of patterns) if (pattern.test(literal)) hit.add(route)
    }
    invokers.push(...[...hit].sort(compare).map((route) => ({ target: route, file })))
  }
  return invokers
}
