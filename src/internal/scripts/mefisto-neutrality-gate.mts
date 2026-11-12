// Gate de conformidad de neutralidad de runtime (MEF-ADR-0049). Detecta fugas de un runtime
// concreto fuera de las piezas autorizadas a nombrarlo y verifica que los adaptadores generados
// esten al dia.
//
// Uso: node src/internal/scripts/mefisto-neutrality-gate.mts [--root <dir>] [--allowlist <file>]
//   Sin --root escanea el repo donde vive este script. Con --root escanea ese arbol: el gate se
//   carga desde el checkout principal y opera sobre el worktree de otro issue (MEF-ADR-0019
//   seccion E).
//   --allowlist usa esa allowlist en vez de la que acompana al script; es para los tests.
//
// Alcance (MEF-ADR-0019): solo el lado interno -- src/internal/**, .claude/** y AGENTS.md. El
// arbol publicado queda fuera; neutrality-allowlist.json lo documenta en "scope_excluded", pero
// la exclusion real es el filtro de archivos de aqui.
//
// Tres reglas sobre los archivos VERSIONADOS (`git ls-files`, nunca el working tree sucio:
// un borrador a medio escribir no debe hacer fallar el gate):
//   R1 - alias e ids de modelo de proveedor (haiku/sonnet/opus/fable, claude-*/gpt-*, prefijos
//        openai//anthropic/), el campo `model` en frontmatter, y nombres crudos de tools o
//        claves de permiso de un runtime citados como valor JSON. Solo en src/internal/**: la
//        fuente neutral no nombra ningun runtime; los adaptadores generados si, y viven fuera.
//   R2 - invocaciones directas `claude -p` y `claude --agent`, en todo el universo.
//   R3 - `.claude/pipeline`, `CLAUDE_PLUGIN_ROOT` y `CLAUDE_PROJECT_DIR` en src/internal/** y
//        en .claude/scripts/: las rutas se resuelven desde el propio script, nunca desde esas
//        variables.
//
// Y dos verificaciones estructurales, sobre los generadores del propio --root (el arbol bajo
// revision):
//   adapters-check           - generate-internal-adapters --check no reporta divergencias.
//   published-adapters-check - generate-published-adapters --check, si existe, tampoco.
//
// Cada violacion es una linea "<ruta>:<linea>: <regla>" (R1-R3), o "<ruta>: <estado>:
// adapters-check" y "<ruta>: <estado>: published-adapters-check", que reemiten lo que reporta
// el --check correspondiente. Sale con 1 si hubo alguna y con 0 si no.
//
// La allowlist (src/internal/contract/neutrality-allowlist.json) se lee relativa a ESTE script
// y nunca a --root: es parte del gate, y el PR bajo revision no puede alterar el gate que lo
// juzga. Registrar una excepcion y usarla son por eso dos PRs, el de registro primero. Toda
// entrada exige `motivo` no vacio; si falta alguno, el gate aborta antes de escanear.

import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, capture, commandExists, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

const USAGE = 'node mefisto-neutrality-gate.mts [--root <dir>] [--allowlist <file>]'

// El borde izquierdo de `claude-...` excluye el `.`: sin el, ".claude-plugin" (el manifiesto del
// plugin, citado en casi todo archivo interno) contaria como id de modelo. `"model" :` es la
// forma JSON porque el frontmatter de la fuente neutral es JSON.
const R1 = new RegExp(
  [
    '(^|[^A-Za-z0-9_.-])(haiku|sonnet|opus|fable)([^A-Za-z0-9_.-]|$)',
    '(^|[^.A-Za-z0-9_-])claude-[a-z0-9][A-Za-z0-9._-]*',
    'gpt-[0-9a-z][A-Za-z0-9._-]*',
    'openai/',
    'anthropic/',
    '"model"[ \\t\\n\\v\\f\\r]*:',
    '"(Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|Skill|Task)"',
    '"(permission|external_directory|doom_loop|todowrite|webfetch|websearch|lsp)"',
  ].join('|'),
)
// Borde tras `-p`: sin el, una palabra que empiece por `-p` contaria como invocacion.
const R2 = /claude -p([^A-Za-z0-9_-]|$)|claude --agent/
const R3 = /\.claude\/pipeline|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR/

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

interface Allowlist {
  /** Patrones `path` de las excepciones, con las reglas que cubre cada uno. */
  exceptions: { path: string; rules: unknown[] }[]
}

function entriesOf(section: unknown): unknown[] | null {
  if (section === undefined || section === null || section === false) return []
  if (Array.isArray(section)) return section
  return typeof section === 'object' ? Object.values(section) : null
}

function hasMotivo(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const motivo = (entry as Record<string, unknown>).motivo
  return typeof motivo === 'string' && motivo.length > 0
}

/** Lee la allowlist; lanza `CliError` si no es JSON valido o alguna entrada no trae `motivo`. */
export function loadAllowlist(file: string): Allowlist {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    parsed = null
  }
  if (parsed === null || parsed === false) throw new CliError(`ERROR: '${file}' no es JSON valido`)

  const sections =
    typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  const scopeExcluded = sections === null ? null : entriesOf(sections.scope_excluded)
  const exceptions = sections === null ? null : entriesOf(sections.exceptions)
  if (scopeExcluded === null || exceptions === null || ![...scopeExcluded, ...exceptions].every(hasMotivo)) {
    throw new CliError(`ERROR: '${file}' tiene al menos una entrada sin 'motivo' no vacio (CA-1)`)
  }

  const paths = (entries: unknown[]): { path: string; rules: unknown[] }[] =>
    entries.flatMap((entry) => {
      const { path, rules } = entry as Record<string, unknown>
      return typeof path === 'string' ? [{ path, rules: Array.isArray(rules) ? rules : [] }] : []
    })
  return { exceptions: paths(exceptions) }
}

/**
 * Traduce un patron de `case` a expresion regular: `*` cruza `/`, por eso "dir/**" y "dir/*"
 * son equivalentes y conviven en la allowlist por legibilidad.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? ''
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '\\' && index + 1 < pattern.length) {
      index++
      source += (pattern[index] ?? '').replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
    } else if (char === '[') {
      const negated = pattern[index + 1] === '!' || pattern[index + 1] === '^'
      const first = index + (negated ? 2 : 1)
      // Un `]` justo al abrir la clase es un miembro, no el cierre.
      const close = pattern.indexOf(']', first + 1)
      if (close === -1) {
        source += '\\['
        continue
      }
      const members = pattern.slice(first, close).replace(/[\\\]^]/g, '\\$&')
      source += `[${negated ? '^' : ''}${members}]`
      index = close
    } else source += char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 's')
}

function patternsFor(allowlist: Allowlist, rule: string): RegExp[] {
  return allowlist.exceptions
    .filter((entry) => entry.rules.includes(rule) || entry.rules.includes('ALL'))
    .map((entry) => globToRegExp(entry.path))
}

// Lineas como las ve `grep -I` bajo LC_ALL=C: un archivo con un byte nulo es binario y se salta;
// latin1 conserva cada byte como un caracter.
function textLines(path: string): string[] {
  let content: Buffer
  try {
    content = readFileSync(path)
  } catch {
    return []
  }
  if (content.includes(0)) return []
  const lines = content.toString('latin1').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function textRule(
  rule: string,
  regex: RegExp,
  files: string[],
  root: string,
  allowlist: Allowlist,
): string[] {
  const allowed = patternsFor(allowlist, rule)
  const violations: string[] = []
  for (const file of files) {
    const hits: number[] = []
    for (const [index, line] of textLines(`${root}/${file}`).entries()) {
      if (regex.test(line)) hits.push(index + 1)
    }
    if (hits.length === 0 || allowed.some((pattern) => pattern.test(file))) continue
    for (const line of hits) violations.push(`${file}:${line}: ${rule}`)
  }
  return violations
}

interface GeneratorCheck {
  status: number
  stdout: string
  stderr: string
}

/** Corre `--check` del generador `<script>.mts` de `root`, o `null` si no existe. */
function runGeneratorCheck(root: string, script: string): GeneratorCheck | null {
  const module = `${root}/${script}.mts`
  if (!isFile(module)) return null
  const result = capture(process.execPath, [module, '--check'], { cwd: root, env: { ...process.env, LC_ALL: 'C' } })
  return { status: result.status ?? 127, stdout: result.stdout, stderr: result.stderr }
}

// Solo un exit distinto de 0 anade violaciones: cada linea de stdout se reemite con el sufijo
// de regla y, si no hubo ninguna, una generica para que ese fallo no quede en silencio.
function structuralCheck(root: string, script: string, rule: string, stderr: string[]): string[] {
  const check = runGeneratorCheck(root, script)
  if (check === null) return []
  if (check.stderr.length > 0) stderr.push(check.stderr)
  if (check.status === 0) return []
  const lines = check.stdout.split('\n').filter((line) => line.length > 0)
  if (lines.length > 0) return lines.map((line) => `${line}: ${rule}`)
  return [`${script}.mts: exit ${check.status} sin lineas de divergencia: ${rule}`]
}

export interface GateResult {
  violations: string[]
  /** stderr de los generadores, que el gate deja pasar sin interpretar. */
  stderr: string
}

/** Escanea `root` (ya validado) con la allowlist dada. */
export function scan(root: string, allowlist: Allowlist): GateResult {
  const listed = capture('git', ['ls-files', '--', 'src/internal', '.claude', 'AGENTS.md'], {
    cwd: root,
  })
  const files = listed.stdout
    .split('\n')
    .filter((file) => file.length > 0)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const internal = files.filter((file) => file.startsWith('src/internal/'))
  const resolved = files.filter(
    (file) => file.startsWith('src/internal/') || file.startsWith('.claude/scripts/'),
  )

  const stderr: string[] = []
  const violations = [
    ...textRule('R1', R1, internal, root, allowlist),
    ...textRule('R2', R2, files, root, allowlist),
    ...textRule('R3', R3, resolved, root, allowlist),
    ...structuralCheck(root, 'src/internal/scripts/generate-internal-adapters', 'adapters-check', stderr),
    ...structuralCheck(
      root,
      'src/published/scripts/generate-published-adapters',
      'published-adapters-check',
      stderr,
    ),
  ]
  return { violations, stderr: stderr.join('') }
}

export function runGate(argv: string[]): GateResult {
  if (!commandExists('git')) throw new CliError('ERROR: git no esta instalado')

  let root = resolve(SCRIPT_DIR, '..', '..', '..')
  let allowlistFile = `${SCRIPT_DIR}/../contract/neutrality-allowlist.json`
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    const value = argv[index + 1]
    if (arg === '--root') {
      if (value === undefined) throw new CliError('ERROR: --root requiere un directorio')
      root = value
      index++
    } else if (arg === '--allowlist') {
      if (value === undefined) throw new CliError('ERROR: --allowlist requiere un archivo')
      allowlistFile = value
      index++
    } else {
      throw new CliError(`ERROR: argumento desconocido: ${arg} (uso: ${USAGE})`)
    }
  }

  if (!isDirectory(root)) {
    throw new CliError(`ERROR: --root '${root}' no existe o no es un directorio`)
  }
  root = resolve(root)
  if (capture('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']).status !== 0) {
    throw new CliError(
      `ERROR: --root '${root}' no es un repositorio git (el universo de archivos sale de git ls-files)`,
    )
  }

  if (!isFile(allowlistFile)) throw new CliError(`ERROR: no existe la allowlist '${allowlistFile}'`)
  return scan(root, loadAllowlist(resolve(allowlistFile)))
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => {
    const result = runGate(process.argv.slice(2))
    process.stderr.write(result.stderr)
    if (result.violations.length === 0) return 0
    process.stdout.write(`${result.violations.join('\n')}\n`)
    return 1
  })
}
