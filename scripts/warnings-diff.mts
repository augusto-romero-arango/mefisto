// warnings-diff.mts -- Detecta los warnings NUEVOS que introduce el arbol de
// trabajo respecto al commit base (MEF-ADR-0056).
//
// Uso:
//   scripts/warnings-diff.sh --toolchain <t> [--base <sha>] [--path <dir>]
//
//   --toolchain  Obligatorio. 'shell' (shellcheck), 'dotnet' (dotnet build)
//                y 'terraform' (terraform validate).
//   --base       Commit base. Default: git merge-base HEAD origin/main.
//   --path       Acota el analisis a un subdirectorio relativo a la raiz del repo.
//                Obligatorio con terraform: es el directorio del entorno.
//
// Lado "antes": worktree temporal en --base (se elimina siempre al salir).
// Lado "despues": el arbol de trabajo actual (incluye .sh nuevos sin commitear).
// Cache de la base: <raiz>/.mefisto/pipeline/warnings-baseline/
//   <toolchain>-<sha>-<path-slug>.txt
// Comparacion: multiconjunto de claves '<toolchain>|<archivo>|<codigo>|<mensaje>'
// (sin linea ni columna). Las supresiones anadidas (lineas '+' de git diff
// <base>) cuentan como warning nuevo con codigo SUPPRESSION.
//
// Extensibilidad: registrar una toolchain es agregar una entrada a TOOLCHAINS con
// `keys` (corre la herramienta en un lado y devuelve sus claves normalizadas) y
// `suppressions` (regex evaluados contra '<archivo>:<linea anadida>', para que una
// toolchain acote un patron a un archivo sin que el nucleo lo sepa). Con
// WARNINGS_DIFF_FIXTURE_DIR, cada toolchain lee la salida cruda de <dir>/<lado>.out
// (base.out / current.out) en vez de ejecutar la herramienta (y no se usa worktree
// ni cache).
//
// Salida: 'NEW <toolchain> <archivo> <codigo> <mensaje>' por warning nuevo y
// una linea final 'warnings nuevos: <N>'.
//
// Toolchain dotnet: cada lado corre 'dotnet build <objetivo> -nologo
// --no-incremental -tl:off -fl "-flp:logfile=<f>;warningsonly"'. Ambas opciones
// son obligatorias: un build incremental no vuelve a emitir los warnings de los
// proyectos ya compilados (la base y el arbol actual no serian comparables), y
// la consola duplica cada warning aun con -clp:NoSummary, mientras el file
// logger 'warningsonly' lo escribe una sola vez. Si un lado no compila, sale
// con 1: nunca se inventa una baseline. Con WARNINGS_DIFF_FIXTURE_DIR, <lado>.root
// (opcional) da la raiz absoluta a relativizar y <lado>.exitcode (opcional) simula
// el exit code del build.
//
// Toolchain terraform: --path es obligatorio (directorio del entorno, p. ej.
// infra/environments/dev). En cada lado corre, dentro de --path, 'terraform init
// -backend=false -input=false' y 'terraform validate -json' (nunca plan:
// MEF-ADR-0021/0022). Cuenta los diagnosticos severity=warning; la clave es
// 'terraform|<range.filename o ->|<summary>|<detail>' (Terraform no emite codigo,
// summary ocupa su lugar). Si un lado trae valid=false sale con 1 y lista los
// errores. TF_PLUGIN_CACHE_DIR se respeta; si no, apunta a
// <raiz>/.mefisto/pipeline/terraform-plugin-cache (evita descargar los providers
// dos veces). Terraform no tiene mecanismo nativo para suprimir warnings de
// validate y el marco no usa tflint: no hay patrones de supresion.
//
// Consola del build (dotnet): cada lado deja la salida de 'dotnet build'
// (stdout+stderr) en <raiz>/.mefisto/pipeline/logs/warnings-diff-dotnet-<lado>.log
// (<lado> = base o current; misma raiz que la cache; se sobreescribe en cada
// corrida). Los warnings se siguen leyendo del file logger 'warningsonly'. Si un
// lado no compila, tras el ERROR se imprimen por stderr hasta 20 lineas con
// ': error ' del log (o sus ultimas 20 si no hay ninguna) y la ruta del log.
// Con WARNINGS_DIFF_FIXTURE_DIR, <lado>.console (opcional) simula esa consola y
// no se escribe nada en .mefisto/pipeline/logs/.
//
// Tiempos (toda toolchain): antes de la salida, por stderr, una linea
// 'warnings-diff: base <N>s (cache|build), actual <N>s' para ver que fase fue
// lenta. Stdout y los exit codes no cambian.
//
// Exit codes: 0 sin warnings nuevos; 1 error; 2 hay warnings nuevos.

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

import { CliError, commandExists, isEntryPoint } from './lib/cli.mts'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Archivo que recibe stdout y stderr juntos, en el orden en que se emiten. */
  outputFile?: string
}

export interface RunResult {
  /** Codigo de salida; `null` si el proceso no arranco o murio por una senal. */
  status: number | null
  stdout: string
  signal: NodeJS.Signals | null
}

export interface DiffDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  hasCommand: (command: string) => boolean
  run: (command: string, args: string[], options?: RunOptions) => RunResult
  out: (text: string) => void
  err: (text: string) => void
  /** Milisegundos desde la epoca. */
  now: () => number
}

type Side = 'base' | 'current'

interface Context {
  deps: DiffDeps
  repoRoot: string
  /** Subdirectorio relativo a la raiz, o vacio. */
  scopePath: string
  tmpWork: string
  /** Valor de WARNINGS_DIFF_FIXTURE_DIR, o vacio. */
  fixtureDir: string
}

interface Toolchain {
  /** Claves del lado `side`, sin ordenar; lanza `CliError` si la herramienta falla. */
  keys: (context: Context, root: string, side: Side) => string[]
  suppressions: RegExp[]
}

const USAGE = 'Uso: scripts/warnings-diff.sh --toolchain <t> [--base <sha>] [--path <dir>]'
const WINDOWS = process.platform === 'win32'
// Clase [[:space:]] de POSIX en la locale C.
const SPACE = '[ \\t\\n\\v\\f\\r]'

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

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

function chomp(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '')
}

/** Lineas de `text`; la ultima cuenta aunque no termine en salto. */
function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function firstLine(path: string): string {
  return (linesOf(readOrEmpty(path))[0] ?? '').replace(/\r$/, '')
}

/** Corre una herramienta; si una senal la mato, aborta con el codigo que daria el shell. */
function runTool(context: Context, command: string, args: string[], options: RunOptions = {}): RunResult {
  const result = context.deps.run(command, args, options)
  if (result.signal !== null) throw new CliError('', 128 + (constants.signals[result.signal] ?? 0))
  return result
}

function git(context: Context, args: string[]): RunResult {
  return runTool(context, 'git', ['-C', context.repoRoot, ...args])
}

function requireTool(context: Context, tool: string): void {
  if (!context.deps.hasCommand(tool)) throw new CliError(`ERROR: ${tool} no esta instalado`)
}

// -------- Toolchain: shell --------

/** `a.sh:2:1: warning: msg [SC2034]` -> `shell|a.sh|SC2034|msg`. */
export function parseShell(raw: string): string[] {
  const keys: string[] = []
  for (const line of linesOf(raw)) {
    const match = /^(?:\.\/)?([^:]+):[0-9]+:[0-9]+: (?:warning|error): (.*) \[(SC[0-9]+)\]$/s.exec(
      line.replace(/\r$/, ''),
    )
    if (match !== null) keys.push(`shell|${match[1]}|${match[3]}|${match[2]}`)
  }
  return keys
}

function shellKeys(context: Context, root: string, side: Side): string[] {
  if (context.fixtureDir.length > 0) return parseShell(readOrEmpty(join(context.fixtureDir, `${side}.out`)))
  requireTool(context, 'shellcheck')
  const scope = context.scopePath.length > 0 ? context.scopePath : '.'
  const listed = runTool(
    context,
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', scope],
    { cwd: root },
  ).stdout
  const scripts = [...new Set(linesOf(listed).filter((file) => file.endsWith('.sh')))].sort()
  let raw = ''
  for (const file of scripts) {
    if (!isFile(join(root, file))) continue
    // El exit 1 de la herramienta con hallazgos no es un fallo.
    raw += runTool(context, 'shellcheck', ['-S', 'warning', '-f', 'gcc', file], { cwd: root }).stdout
  }
  return parseShell(raw)
}

// -------- Toolchain: dotnet --------

/** Variantes de `root` que MSBuild puede anteponer a una ruta, cada una con su separador. */
function rootPrefixes(root: string): string[] {
  if (root.length === 0) return []
  const trimmed = root.replace(WINDOWS ? /[\\/]$/ : /\/$/, '')
  if (!WINDOWS) return [`${trimmed}/`]
  return [...new Set([trimmed, normalize(trimmed)])].flatMap((base) => [`${base}\\`, `${base}/`])
}

const NODE_PREFIX = new RegExp(`^${SPACE}*[0-9]+(?::[0-9]+)?>(.*)$`, 's')
// Ubicacion canonica de MSBuild: (l), (l,c), (l-l), (l,c-c) o (l,c,l,c).
const WITH_LOCATION = new RegExp(
  `^(.*)\\([0-9]+(?:[,-][0-9]+)*\\)${SPACE}*: warning ([A-Za-z]+[0-9]+): (.*)$`,
  's',
)
const WITHOUT_LOCATION = new RegExp(
  `^(.*[^ \\t\\n\\v\\f\\r])${SPACE}*: warning ([A-Za-z]+[0-9]+): (.*)$`,
  's',
)

/**
 * Claves `dotnet|<archivo>|<codigo>|<mensaje>` del log `warningsonly`. `root` y `physRoot`
 * son la raiz logica y la fisica del lado: el worktree temporal vive bajo el directorio
 * temporal y en macOS /var es un symlink a /private/var.
 */
export function parseDotnet(raw: string, root: string, physRoot: string = root): string[] {
  const prefixes = [...(physRoot !== root ? rootPrefixes(physRoot) : []), ...rootPrefixes(root)]
  const keys: string[] = []
  for (const rawLine of linesOf(raw)) {
    let line = rawLine.replace(/\r$/, '')
    line = NODE_PREFIX.exec(line)?.[1] ?? line
    for (const prefix of prefixes) line = line.split(prefix).join('')
    if (/ \[[^\]]*\]$/.test(line)) line = line.slice(0, line.lastIndexOf(' ['))
    const match = WITH_LOCATION.exec(line) ?? WITHOUT_LOCATION.exec(line)
    if (match !== null) keys.push(`dotnet|${match[1]}|${match[2]}|${match[3]}`)
  }
  return keys
}

// Causa de un build fallido: hasta 20 lineas con ': error ' de la consola (sin
// repetidas; MSBuild repite cada error en su resumen) o, si no hay ninguna, sus
// ultimas 20 lineas, y la ruta del log completo.
function printBuildFailureExcerpt(deps: DiffDeps, log: string): void {
  const text = readOrEmpty(log)
  if (text.length === 0) {
    deps.err(`(la consola del build esta vacia) log: ${log}\n`)
    return
  }
  const lines = linesOf(text)
  const errors = [...new Set(lines.filter((line) => line.includes(': error ')))]
  if (errors.length > 0) {
    deps.err(errors.slice(0, 20).map((line) => `${line}\n`).join(''))
  } else {
    deps.err(lines.slice(-20).join('\n') + (text.endsWith('\n') ? '\n' : ''))
  }
  deps.err(`log completo del build: ${log}\n`)
}

function dotnetKeys(context: Context, root: string, side: Side): string[] {
  const { fixtureDir, deps } = context
  let parseRoot = root
  let physRoot = root
  try {
    physRoot = realpathSync.native(root)
  } catch {
    // Sin raiz fisica se relativiza solo con la logica.
  }
  let raw: string
  let failed = false
  let consoleLog: string
  if (fixtureDir.length > 0) {
    const rootFile = join(fixtureDir, `${side}.root`)
    if (isFile(rootFile)) {
      parseRoot = firstLine(rootFile)
      physRoot = parseRoot
    }
    raw = readOrEmpty(join(fixtureDir, `${side}.out`))
    const exitCode = join(fixtureDir, `${side}.exitcode`)
    if (isFile(exitCode)) failed = (Number.parseInt(firstLine(exitCode), 10) || 0) !== 0
    consoleLog = join(fixtureDir, `${side}.console`)
  } else {
    requireTool(context, 'dotnet')
    const log = join(context.tmpWork, `build-${side}.log`)
    consoleLog = join(context.repoRoot, '.mefisto', 'pipeline', 'logs', `warnings-diff-dotnet-${side}.log`)
    try {
      mkdirSync(dirname(consoleLog), { recursive: true })
    } catch {
      consoleLog = join(context.tmpWork, `console-${side}.log`)
    }
    const target = context.scopePath.length > 0 ? join(root, context.scopePath) : root
    const build = runTool(
      context,
      'dotnet',
      ['build', target, '-nologo', '--no-incremental', '-tl:off', '-fl', `-flp:logfile=${log};warningsonly`],
      { cwd: root, outputFile: consoleLog },
    )
    failed = build.status !== 0
    raw = readOrEmpty(log)
  }
  if (failed) {
    deps.err(
      side === 'base'
        ? 'ERROR: la base no compila\n'
        : 'ERROR: el arbol actual no compila: corrige los errores antes de medir warnings\n',
    )
    printBuildFailureExcerpt(deps, consoleLog)
    throw new CliError('')
  }
  return parseDotnet(raw, parseRoot, physRoot)
}

// -------- Toolchain: terraform --------

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Operador `//` de jq: `fallback` si `value` es null o false. */
function orElse(value: unknown, fallback: string): unknown {
  return value === undefined || value === null || value === false ? fallback : value
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null')
}

function diagnostics(document: unknown, severity: string): Json[] {
  const list = isObject(document) ? document.diagnostics : undefined
  const items: unknown[] = Array.isArray(list) ? list : isObject(list) ? Object.values(list) : []
  return items.filter((item): item is Json => isObject(item) && item.severity === severity)
}

function filename(diagnostic: Json): unknown {
  return orElse(isObject(diagnostic.range) ? diagnostic.range.filename : undefined, '-')
}

/** Claves `terraform|<archivo o ->|<summary>|<detail>` de la salida de `terraform validate -json`. */
export function parseTerraform(raw: string): string[] {
  let document: unknown
  try {
    document = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  // '|' separa los campos de la salida: se neutraliza en archivo y summary.
  return diagnostics(document, 'warning').map((diagnostic) =>
    [
      'terraform',
      text(filename(diagnostic)).replaceAll('|', '/'),
      text(orElse(diagnostic.summary, '-')).replaceAll('|', '/'),
      text(orElse(diagnostic.detail, '')),
    ]
      .map((field) => field.replace(/[\r\n]+/g, ' '))
      .join('|'),
  )
}

function terraformKeys(context: Context, root: string, side: Side): string[] {
  const { deps, fixtureDir } = context
  let raw: string
  if (fixtureDir.length > 0) {
    raw = readOrEmpty(join(fixtureDir, `${side}.out`))
  } else {
    requireTool(context, 'terraform')
    const configured = deps.env.TF_PLUGIN_CACHE_DIR ?? ''
    const pluginCache =
      configured.length > 0
        ? configured
        : join(context.repoRoot, '.mefisto', 'pipeline', 'terraform-plugin-cache')
    try {
      mkdirSync(pluginCache, { recursive: true })
    } catch {
      // Terraform reporta un cache inutilizable en su propio init.
    }
    const env = { ...deps.env, TF_PLUGIN_CACHE_DIR: pluginCache }
    const dir = join(root, context.scopePath)
    if (!isDirectory(dir)) {
      throw new CliError(`ERROR: --path no existe en el lado ${side}: ${context.scopePath}`)
    }
    const initLog = join(context.tmpWork, `tf-init-${side}.log`)
    const init = runTool(context, 'terraform', ['init', '-backend=false', '-input=false'], {
      cwd: dir,
      env,
      outputFile: initLog,
    })
    if (init.status !== 0) {
      deps.err(`ERROR: terraform init fallo en el lado ${side}:\n`)
      deps.err(readOrEmpty(initLog))
      throw new CliError('')
    }
    // validate sale con 1 si el HCL es invalido, pero igual emite el JSON.
    raw = runTool(context, 'terraform', ['validate', '-json', '-no-color'], { cwd: dir, env }).stdout
  }
  let document: unknown
  try {
    document = JSON.parse(raw) as unknown
  } catch {
    document = undefined
  }
  if (!isObject(document) || document.valid === undefined || document.valid === null) {
    throw new CliError(`ERROR: terraform validate no devolvio JSON valido en el lado ${side}`)
  }
  if (document.valid !== true && document.valid !== 'true') {
    deps.err(
      `ERROR: terraform validate reporta valid=false en el lado ${side}; corrige el HCL antes de medir warnings:\n`,
    )
    for (const error of diagnostics(document, 'error')) {
      const fields = [filename(error), error.summary ?? null, orElse(error.detail, '')].map(text)
      deps.err(`  error: ${fields.join(': ').replaceAll('\n', ' ')}\n`)
    }
    throw new CliError('')
  }
  return parseTerraform(raw)
}

// -------- Registro de toolchains --------

const TOOLCHAINS = new Map<string, Toolchain>([
  [
    'shell',
    {
      keys: shellKeys,
      suppressions: [new RegExp(`shellcheck${SPACE}+disable=`), /(?:^|\/)\.shellcheckrc:disable=/],
    },
  ],
  [
    'dotnet',
    {
      keys: dotnetKeys,
      suppressions: [
        new RegExp(`#pragma${SPACE}+warning${SPACE}+disable`),
        /SuppressMessage/,
        /<NoWarn>/,
        /<WarningLevel>/,
        new RegExp(`dotnet_diagnostic\\.[^.]+\\.severity${SPACE}*=${SPACE}*(?:none|silent|suggestion)`),
      ],
    },
  ],
  ['terraform', { keys: terraformKeys, suppressions: [] }],
])

// -------- Nucleo --------

/** Orden por bytes (el de `LC_ALL=C sort`), que es el de las caches ya escritas en disco. */
export function sortKeys(keys: string[]): string[] {
  return keys
    .map((key) => ({ key, bytes: Buffer.from(key) }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
    .map((entry) => entry.key)
}

/** Diferencia de multiconjuntos: lo que `current` trae de mas respecto a `base`, en el orden de `current`. */
export function newKeys(base: string[], current: string[]): string[] {
  const pending = new Map<string, number>()
  for (const key of base) pending.set(key, (pending.get(key) ?? 0) + 1)
  return current.filter((key) => {
    const count = pending.get(key) ?? 0
    if (count === 0) return true
    pending.set(key, count - 1)
    return false
  })
}

/** Lineas anadidas por el diff contra la base, como pares [archivo, linea]. */
export function addedLines(diff: string): Array<[string, string]> {
  const added: Array<[string, string]> = []
  let inHunk = false
  let file = ''
  for (const line of linesOf(diff)) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      file = ''
    } else if (line.startsWith('@@')) {
      inHunk = true
    } else if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4)
      file = target === '/dev/null' ? '' : target.replace(/^b\//, '')
    } else if (inHunk && line.startsWith('+') && file.length > 0) {
      added.push([file, line.slice(1)])
    }
  }
  return added
}

/** Claves SUPPRESSION de las lineas anadidas que casan con algun patron de la toolchain. */
export function suppressionKeys(
  toolchain: string,
  patterns: RegExp[],
  added: Array<[string, string]>,
): string[] {
  const keys: string[] = []
  const edges = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')
  for (const pair of added) {
    // Los tabuladores al borde de la linea no cuentan: `\tdisable=` casa con un patron anclado a `archivo:`.
    const record = pair.join('\t').replace(/^\t+/, '')
    const cut = record.indexOf('\t')
    const file = cut === -1 ? record : record.slice(0, cut)
    const line = cut === -1 ? '' : record.slice(cut).replace(/^\t+|\t+$/g, '')
    if (file.length === 0) continue
    if (patterns.some((pattern) => pattern.test(`${file}:${line}`))) {
      keys.push(`${toolchain}|${file}|SUPPRESSION|supresion anadida: ${line.replace(edges, '')}`)
    }
  }
  return keys
}

function addedSuppressions(context: Context, toolchain: string, patterns: RegExp[], baseSha: string): string[] {
  if (patterns.length === 0) return []
  const scope = context.scopePath.length > 0 ? context.scopePath : '.'
  const diff = git(context, ['diff', baseSha, '-U0', '--no-color', '--no-ext-diff', '--', scope]).stdout
  const added = addedLines(diff)
  // Archivos nuevos sin commitear: todas sus lineas son anadidas.
  const untracked = git(context, ['ls-files', '--others', '--exclude-standard', '--', scope]).stdout
  for (const file of linesOf(untracked)) {
    const path = join(context.repoRoot, file)
    if (file.length === 0 || !isFile(path)) continue
    for (const line of linesOf(readOrEmpty(path))) added.push([file, line])
  }
  return suppressionKeys(toolchain, patterns, added)
}

interface Options {
  toolchain: string
  base: string
  scopePath: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = { toolchain: '', base: '', scopePath: '' }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag !== '--toolchain' && flag !== '--base' && flag !== '--path') {
      throw new CliError(`ERROR: argumento desconocido: ${flag}\n${USAGE}`)
    }
    if (value === undefined) throw new CliError(USAGE)
    if (flag === '--toolchain') options.toolchain = value
    else if (flag === '--base') options.base = value
    else options.scopePath = value
  }
  return options
}

function pathSlug(scopePath: string): string {
  const bytes = Buffer.from(scopePath.length > 0 ? scopePath : 'all')
  return Array.from(bytes, (byte) => {
    const char = String.fromCharCode(byte)
    return /[A-Za-z0-9._-]/.test(char) ? char : '_'
  }).join('')
}

function run(argv: string[], deps: DiffDeps): number {
  const top = deps.run('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd })
  const repoRoot = top.status === 0 ? chomp(top.stdout) : ''
  if (repoRoot.length === 0) throw new CliError('ERROR: no estas en un repositorio git')
  if (existsSync(join(repoRoot, '.claude-plugin', 'plugin.json'))) {
    throw new CliError(
      [
        'ERROR: scripts/warnings-diff.sh es del plugin publicado y solo aplica al consumidor.',
        'Estas en el repo de Mefisto.',
      ].join('\n'),
    )
  }

  const options = parseArgs(argv)
  if (options.toolchain.length === 0) throw new CliError(`ERROR: falta --toolchain\n${USAGE}`)
  const toolchain = TOOLCHAINS.get(options.toolchain)
  if (toolchain === undefined) {
    throw new CliError(`ERROR: toolchain no soportada: ${options.toolchain}\n${USAGE}`)
  }
  if (options.toolchain === 'terraform' && options.scopePath.length === 0) {
    throw new CliError(
      `ERROR: --toolchain terraform requiere --path <directorio del entorno>\n${USAGE}`,
    )
  }

  const context: Context = {
    deps,
    repoRoot,
    scopePath: options.scopePath.replace(/^\.\//, '').replace(/\/$/, ''),
    tmpWork: '',
    fixtureDir: deps.env.WARNINGS_DIFF_FIXTURE_DIR ?? '',
  }
  const live = context.fixtureDir.length === 0

  let base = options.base
  if (base.length === 0) {
    const mergeBase = git(context, ['merge-base', 'HEAD', 'origin/main'])
    if (mergeBase.status !== 0) {
      throw new CliError(
        'ERROR: no se pudo resolver la base (git merge-base HEAD origin/main); usa --base',
      )
    }
    base = chomp(mergeBase.stdout)
  }
  const verified = git(context, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  if (verified.status !== 0) throw new CliError(`ERROR: base invalida: ${base}`)
  const baseSha = chomp(verified.stdout)

  const cacheFile = join(
    repoRoot,
    '.mefisto',
    'pipeline',
    'warnings-baseline',
    `${options.toolchain}-${baseSha}-${pathSlug(context.scopePath)}.txt`,
  )
  const seconds = (): number => Math.floor(deps.now() / 1000)

  context.tmpWork = mkdtempSync(join(tmpdir(), 'warnings-diff-'))
  let worktree = ''
  try {
    const baseStart = seconds()
    let baseSource = 'build'
    let baseKeys: string[]
    if (live && isFile(cacheFile)) {
      baseKeys = linesOf(readFileSync(cacheFile, 'utf8'))
      baseSource = 'cache'
    } else {
      let baseRoot = repoRoot
      if (live) {
        worktree = mkdtempSync(join(tmpdir(), 'warnings-diff-base-'))
        if (git(context, ['worktree', 'add', '--detach', worktree, baseSha]).status !== 0) {
          throw new CliError(`ERROR: no se pudo crear el worktree temporal en ${baseSha}`)
        }
        baseRoot = worktree
      }
      baseKeys = sortKeys(toolchain.keys(context, baseRoot, 'base'))
      if (live) {
        try {
          mkdirSync(dirname(cacheFile), { recursive: true })
          writeFileSync(cacheFile, baseKeys.map((key) => `${key}\n`).join(''))
        } catch {
          // Sin cache la proxima corrida vuelve a medir la base.
        }
      }
    }

    const currentStart = seconds()
    const currentKeys = sortKeys(toolchain.keys(context, repoRoot, 'current'))
    const currentSeconds = seconds() - currentStart

    const found = [
      ...newKeys(baseKeys, currentKeys),
      ...addedSuppressions(context, options.toolchain, toolchain.suppressions, baseSha),
    ]

    deps.err(
      `warnings-diff: base ${currentStart - baseStart}s (${baseSource}), actual ${currentSeconds}s\n`,
    )
    let count = 0
    for (const key of found) {
      const [tool = '', file = '', code = '', ...message] = key.split('|')
      if (tool.length === 0) continue
      deps.out(`NEW ${tool} ${file} ${code} ${message.join('|')}\n`)
      count++
    }
    deps.out(`warnings nuevos: ${count}\n`)
    return count > 0 ? 2 : 0
  } finally {
    if (worktree.length > 0) {
      deps.run('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktree])
      deps.run('git', ['-C', repoRoot, 'worktree', 'prune'])
      rmSync(worktree, { recursive: true, force: true })
    }
    rmSync(context.tmpWork, { recursive: true, force: true })
  }
}

export function warningsDiff(argv: string[], deps: DiffDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) deps.err(`${error.message}\n`)
    return error.exitCode
  }
}

export function runProgram(command: string, args: string[], options: RunOptions = {}): RunResult {
  let output: number | null = null
  try {
    if (options.outputFile !== undefined) output = openSync(options.outputFile, 'w')
  } catch {
    return { status: 1, stdout: '', signal: null }
  }
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', output ?? 'pipe', output ?? 'ignore'],
    })
    return { status: result.status, stdout: result.stdout ?? '', signal: result.signal }
  } finally {
    if (output !== null) closeSync(output)
  }
}

if (isEntryPoint(import.meta.url)) {
  // Con un manejador, la senal no mata el proceso a mitad de una herramienta: el worktree
  // temporal se elimina antes de salir.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => process.exit(128 + constants.signals[signal]))
  }
  process.exitCode = warningsDiff(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    hasCommand: commandExists,
    run: runProgram,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    now: Date.now,
  })
}
