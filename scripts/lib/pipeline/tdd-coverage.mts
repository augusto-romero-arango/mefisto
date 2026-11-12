// Coverage gate del pipeline TDD (Stage 4, MEF-ADR-0014): instrumentacion con dotnet-coverage,
// recoleccion corriendo solo los proyectos `*.Tests`, lectura del XML cobertura y textos de la
// tabla y del patch spec de remediacion.
//
// Corrido como `node tdd-coverage.mts run-tests <worktree> <prefijo>` es el comando que envuelve
// `dotnet-coverage collect`: corre `dotnet test --no-build` en cada proyecto y termina con el
// primer fallo real.

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'

import { isEntryPoint, spawnTarget } from '../cli.mts'
import type { PipelineLog } from './pipeline-log.mts'
import { testProjects } from './test-results.mts'

export const COVERAGE_THRESHOLD = 95
/** Segundos que puede tomar una medicion completa: build, instrumentacion y recoleccion. */
export const COVERAGE_MEASURE_SECONDS = 600

export const COVERAGE_TABLE_HEADER = '| Archivo | Cobertura | Umbral | Estado |\n|---|---|---|---|'

// --- XML -------------------------------------------------------------------------

export interface XmlElement {
  name: string
  attributes: Map<string, string>
  children: XmlElement[]
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  return text.replace(/&([^;&<]*);|&/g, (match, name: string | undefined) => {
    if (name === undefined) throw new Error('XML: & suelto')
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    const entity = ENTITIES[name]
    if (entity === undefined) throw new Error(`XML: entidad desconocida ${match}`)
    return entity
  })
}

const NAME = '[A-Za-z_:][-A-Za-z0-9_:.]*'
const ATTRIBUTE = new RegExp(`\\s+(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y')
const TAG_END = /\s*(\/?)>/y
const TAG_NAME = new RegExp(NAME, 'y')

/** Elemento raiz de un XML; lanza si el documento esta mal formado, como ElementTree. */
export function parseXml(text: string): XmlElement {
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let index = 0
  const expect = (pattern: RegExp): RegExpExecArray => {
    pattern.lastIndex = index
    const match = pattern.exec(text)
    if (match === null) throw new Error(`XML mal formado en ${index}`)
    index = pattern.lastIndex
    return match
  }
  const skipTo = (marker: string): void => {
    const end = text.indexOf(marker, index)
    if (end === -1) throw new Error('XML sin cerrar')
    index = end + marker.length
  }
  while (index < text.length) {
    const open = text.indexOf('<', index)
    if (open === -1) {
      if (text.slice(index).trim().length > 0 && stack.length === 0) throw new Error('XML: texto fuera de la raiz')
      if (stack.length === 0) decodeEntities(text.slice(index))
      break
    }
    const between = text.slice(index, open)
    if (stack.length === 0 && between.trim().length > 0) throw new Error('XML: texto fuera de la raiz')
    decodeEntities(between)
    index = open
    if (text.startsWith('<!--', index)) {
      skipTo('-->')
    } else if (text.startsWith('<![CDATA[', index)) {
      if (stack.length === 0) throw new Error('XML: CDATA fuera de la raiz')
      skipTo(']]>')
    } else if (text.startsWith('<?', index)) {
      skipTo('?>')
    } else if (text.startsWith('<!', index)) {
      if (root !== null || stack.length > 0) throw new Error('XML: declaracion fuera de lugar')
      skipTo('>')
    } else if (text.startsWith('</', index)) {
      index += 2
      const name = expect(TAG_NAME)[0]
      expect(/\s*>/y)
      const current = stack.pop()
      if (current === undefined || current.name !== name) throw new Error(`XML: cierre inesperado </${name}>`)
    } else {
      index += 1
      const name = expect(TAG_NAME)[0]
      const element: XmlElement = { name, attributes: new Map(), children: [] }
      for (;;) {
        ATTRIBUTE.lastIndex = index
        const attribute = ATTRIBUTE.exec(text)
        if (attribute === null) break
        index = ATTRIBUTE.lastIndex
        const key = attribute[1] ?? ''
        if (element.attributes.has(key)) throw new Error(`XML: atributo repetido ${key}`)
        element.attributes.set(key, decodeEntities(attribute[2] ?? attribute[3] ?? '').replace(/[\t\n\r]/g, ' '))
      }
      const selfClosing = expect(TAG_END)[1] === '/'
      const parent = stack.at(-1)
      if (parent !== undefined) parent.children.push(element)
      else if (root === null) root = element
      else throw new Error('XML: mas de una raiz')
      if (!selfClosing) stack.push(element)
    }
  }
  if (root === null || stack.length > 0) throw new Error('XML incompleto')
  return root
}

/** Descendientes llamados `name`, en orden de documento y sin incluir a `element`: el `.//name` de ElementTree. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = []
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) found.push(child)
      walk(child)
    }
  }
  walk(element)
  return found
}

// --- Lectura de la cobertura ------------------------------------------------------

/**
 * Ultimo segmento de una ruta. Acepta `\` ademas de `/`: dotnet-coverage escribe rutas de
 * Windows en el XML cuando corre ahi.
 */
function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

const PY_FLOAT = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/

/** `float()` de Python sobre un atributo; lanza ante un texto que Python rechaza. */
function pythonFloat(text: string): number {
  const trimmed = text.trim()
  if (PY_FLOAT.test(trimmed)) return Number(trimmed.replaceAll('_', ''))
  const special = /^([+-]?)(nan|inf|infinity)$/i.exec(trimmed)
  if (special === null) throw new Error(`float invalido: ${text}`)
  if (special[2]?.toLowerCase() === 'nan') return Number.NaN
  return special[1] === '-' ? -Infinity : Infinity
}

/** `round(value, 1)` de Python, con su desempate al par, impreso como lo imprime Python. */
export function pythonRound1(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  let rounded = Number(value.toFixed(1))
  // Un empate exacto (x.x5 representable) va al par; `toFixed` lo sube siempre.
  if (Number.isInteger(value * 4) && !Number.isInteger(value * 2)) {
    const floor = Math.floor(value * 10)
    rounded = (floor % 2 === 0 ? floor : floor + 1) / 10
  }
  const text = String(rounded)
  return /^-?\d+$/.test(text) ? `${text}.0` : text
}

/** `<ruta>|<porcentaje>` o `<ruta>|N/A` de un archivo de logica. */
export interface FileCoverage {
  path: string
  /** Porcentaje como lo imprime Python (`83.3`, `100.0`), o `N/A` si el XML no trae el archivo. */
  percent: string
}

/**
 * Cobertura de lineas de cada archivo de logica segun el XML, buscado por nombre de archivo.
 * Un XML ilegible no da nada; un `line-rate` invalido corta la lista donde aparece.
 */
export function extractFileCoverage(xml: string, logicFiles: readonly string[]): FileCoverage[] {
  const wanted = new Map<string, string>()
  for (const line of logicFiles) {
    const path = line.trim()
    if (path.length > 0) wanted.set(posix.basename(path), path)
  }
  let root: XmlElement
  try {
    root = parseXml(xml)
  } catch {
    return []
  }
  const found: FileCoverage[] = []
  try {
    for (const pkg of descendants(root, 'package')) {
      for (const cls of descendants(pkg, 'class')) {
        const name = fileName(cls.attributes.get('filename') ?? '')
        const path = wanted.get(name)
        if (path === undefined) continue
        found.push({ path, percent: pythonRound1(pythonFloat(cls.attributes.get('line-rate') ?? '0') * 100) })
        wanted.delete(name)
      }
    }
  } catch {
    return found
  }
  for (const path of wanted.values()) found.push({ path, percent: 'N/A' })
  return found
}

function pythonInt(text: string): number {
  const trimmed = text.trim()
  if (!/^[+-]?\d+(?:_\d+)*$/.test(trimmed)) throw new Error(`int invalido: ${text}`)
  return Number(trimmed.replaceAll('_', ''))
}

/** Rangos `- Lx` o `- Lx-Ly` de lineas consecutivas, en el orden del XML. */
export function uncoveredRanges(lines: readonly number[]): string[] {
  const ranges: string[] = []
  let start = lines[0]
  let end = lines[0]
  if (start === undefined || end === undefined) return ranges
  const close = (): void => void ranges.push(start === end ? `- L${start}` : `- L${start}-L${end}`)
  for (const line of lines.slice(1)) {
    if (line === end + 1) end = line
    else {
      close()
      start = line
      end = line
    }
  }
  close()
  return ranges
}

/** Lo que el patch spec dice de un archivo con brecha; `failed` si el XML no se pudo leer entero. */
export interface UncoveredReport {
  text: string
  failed: boolean
}

/** Lineas sin cubrir de `target` (por nombre de archivo) en cada paquete que lo trae. */
export function uncoveredReport(xml: string, target: string): UncoveredReport {
  const name = posix.basename(target)
  let text = ''
  try {
    const root = parseXml(xml)
    for (const pkg of descendants(root, 'package')) {
      for (const cls of descendants(pkg, 'class')) {
        if (fileName(cls.attributes.get('filename') ?? '') !== name) continue
        const uncovered = descendants(cls, 'line')
          .filter((line) => (line.attributes.get('hits') ?? '0') === '0')
          .map((line) => pythonInt(line.attributes.get('number') ?? '0'))
        text +=
          uncovered.length > 0
            ? `Lineas no cubiertas:\n${uncoveredRanges(uncovered).join('\n')}\n`
            : 'No se detectaron lineas sin cubrir en el XML (posible error de instrumentacion)\n'
        break
      }
    }
  } catch {
    return { text, failed: true }
  }
  return { text, failed: false }
}

/** Patch spec que recibe el test-writer de remediacion. */
export function coveragePatchSpec(xml: string | null, gaps: readonly FileCoverage[]): string {
  let spec =
    '## Coverage Patch Spec\n\nArchivos con cobertura insuficiente detectados en Stage 4.\nEl test-writer debe agregar tests para cubrir los metodos/lineas listados.\n\n'
  for (const gap of gaps) {
    spec += `### ${gap.path} (${gap.percent}% - requiere ${COVERAGE_THRESHOLD}%)\n\n`
    const report = xml === null ? { text: '', failed: true } : uncoveredReport(xml, gap.path)
    spec += report.text
    if (report.failed) spec += '_(no se pudieron extraer lineas no cubiertas)_\n'
    spec += '\n'
  }
  return spec
}

export interface CoverageEvaluation {
  /** Filas de los archivos de logica, sin encabezado. */
  rows: string[]
  gaps: FileCoverage[]
}

/** Filas de la tabla para los archivos de logica medidos y las brechas bajo el umbral. */
export function evaluateCoverage(data: readonly FileCoverage[]): CoverageEvaluation {
  const rows: string[] = []
  const gaps: FileCoverage[] = []
  for (const file of data) {
    const name = posix.basename(file.path)
    if (file.percent === 'N/A') {
      rows.push(`| ${name} | N/A | ${COVERAGE_THRESHOLD}% | sin datos |`)
      continue
    }
    const whole = Number.parseInt(file.percent.replace(/\..*$/, ''), 10)
    if (whole >= COVERAGE_THRESHOLD) rows.push(`| ${name} | ${file.percent}% | ${COVERAGE_THRESHOLD}% | ok |`)
    else {
      rows.push(`| ${name} | ${file.percent}% | ${COVERAGE_THRESHOLD}% | gap |`)
      gaps.push(file)
    }
  }
  return { rows, gaps }
}

/** Filas de los archivos excluidos y de los que ninguna regla clasifico. */
export function classificationRows(excluded: readonly string[], notEvaluated: readonly string[]): string[] {
  return [
    ...excluded.filter((file) => file.length > 0).map((file) => `| ${posix.basename(file)} | - | excluido | - |`),
    ...notEvaluated.filter((file) => file.length > 0).map((file) => `| ${posix.basename(file)} | - | sin clasificar | ⚠ revisar |`),
  ]
}

// --- Medicion ----------------------------------------------------------------------

export interface CoverageStepOptions {
  logFile: string
  /** Milisegundos que le quedan a la medicion. */
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/** Corre un paso de la medicion con su salida al log; `timedOut` si se agoto el tiempo y se mato. */
export type CoverageRun = (command: string, args: string[], options: CoverageStepOptions) => { status: number | null; timedOut: boolean }

export const runCoverageStep: CoverageRun = (command, args, options) => {
  let log: number
  try {
    log = openSync(options.logFile, 'a')
  } catch {
    return { status: 1, timedOut: false }
  }
  try {
    const target = spawnTarget(command, args, options.env ?? process.env)
    const result = spawnSync(target.command, target.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', log, log],
      timeout: Math.max(1, options.timeoutMs),
      killSignal: 'SIGKILL',
      windowsHide: true,
      windowsVerbatimArguments: target.verbatim,
    })
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
    return { status: result.status, timedOut: code === 'ETIMEDOUT' }
  } finally {
    closeSync(log)
  }
}

export interface MeasureTools {
  run: CoverageRun
  log: PipelineLog
  env?: NodeJS.ProcessEnv
  /** Milisegundos actuales; inyectable en los tests. */
  clock?: () => number
}

export interface Measurement {
  /** 0 medido, 1 fallo la instrumentacion, 3 fallaron los tests, 137 se agoto el tiempo. */
  exit: number
  timedOut: boolean
}

export const COVERAGE_XML = 'coverage.cobertura.xml'
export const COVERAGE_RC = 'coverage-collect.rc'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  } catch {
    return []
  }
}

/** DLLs del prefijo bajo `tests/<prefijo>.*.Tests/bin/Debug/net10.0/`, en orden de bytes. */
export function instrumentableDlls(worktree: string, namespacePrefix: string): string[] {
  const head = `${namespacePrefix}.`
  const matches = (name: string, tail: string): boolean => name.startsWith(head) && name.endsWith(tail) && name.length >= head.length + tail.length
  return testProjects(worktree, namespacePrefix).flatMap((project) => {
    const bin = join(project, 'bin', 'Debug', 'net10.0')
    return listNames(bin)
      .filter((name) => matches(name, '.dll'))
      .map((name) => join(bin, name))
      .filter(isFile)
  })
}

/**
 * Compila, instrumenta las DLLs del prefijo (no las de tests ni repetidas) y recolecta cobertura
 * corriendo los `*.Tests`. Deja `coverage.cobertura.xml` y `coverage-collect.rc` en el worktree.
 * Todo el proceso tiene `COVERAGE_MEASURE_SECONDS`; al agotarse se mata el paso en curso.
 */
export function measureCoverage(worktree: string, namespacePrefix: string, tools: MeasureTools): Measurement {
  const { log } = tools
  const clock = tools.clock ?? ((): number => Date.now())
  const deadline = clock() + COVERAGE_MEASURE_SECONDS * 1000
  const step = (command: string, args: string[]): { status: number; timedOut: boolean } => {
    const remaining = deadline - clock()
    if (remaining <= 0) return { status: 137, timedOut: true }
    const result = tools.run(command, args, {
      logFile: log.logFile(),
      timeoutMs: remaining,
      ...(tools.env === undefined ? {} : { env: tools.env }),
    })
    return { status: result.status ?? 127, timedOut: result.timedOut }
  }
  const killed: Measurement = { exit: 137, timedOut: true }

  log.log('Compilando proyecto para instrumentacion...')
  const build = step('dotnet', ['build', worktree])
  if (build.timedOut) return killed
  if (build.status !== 0) {
    log.warn('Build fallo antes de instrumentacion')
    return { exit: 1, timedOut: false }
  }

  log.log('Instrumentando DLLs...')
  const settings = join(worktree, 'dotnet-coverage.settings.xml')
  let instrumented = 0
  let seen = 0
  let skippedTests = 0
  let skippedDuplicates = 0
  const done = new Set<string>()
  for (const dll of instrumentableDlls(worktree, namespacePrefix)) {
    seen++
    const name = dll.slice(dll.lastIndexOf(sep) + 1)
    if (name.endsWith('Tests.dll')) {
      skippedTests++
      continue
    }
    if (done.has(name)) {
      skippedDuplicates++
      continue
    }
    const result = step('dotnet-coverage', ['instrument', dll, '--settings', settings])
    if (result.timedOut) return killed
    if (result.status === 0) {
      instrumented++
      done.add(name)
    } else log.warn(`No se pudo instrumentar: ${name}`)
  }
  log.log(`Instrumentacion: vistas=${seen}, omitidas_tests=${skippedTests}, omitidas_duplicadas=${skippedDuplicates}, instrumentadas=${instrumented}`)
  if (instrumented === 0) {
    log.warn('No se instrumento ninguna DLL')
    return { exit: 1, timedOut: false }
  }
  log.log(`${instrumented} DLL(s) instrumentada(s)`)

  log.log('Recolectando cobertura...')
  const output = join(worktree, COVERAGE_XML)
  const rcFile = join(worktree, COVERAGE_RC)
  rmSync(output, { force: true })
  rmSync(rcFile, { force: true })
  const collect = step('dotnet-coverage', [
    'collect',
    '--output',
    output,
    '-f',
    'cobertura',
    '--',
    process.execPath,
    import.meta.filename,
    'run-tests',
    worktree,
    namespacePrefix,
  ])
  if (collect.timedOut) return killed
  writeFileSync(rcFile, `${collect.status}\n`)
  if (collect.status !== 0) log.warn(`dotnet-coverage collect termino con exit code ${collect.status}`)
  if (!isFile(output)) {
    log.warn('No se genero archivo de cobertura')
    return { exit: 1, timedOut: false }
  }
  if (collect.status !== 0) return { exit: 3, timedOut: false }
  log.log(`Cobertura recolectada: ${output}`)
  return { exit: 0, timedOut: false }
}

/** Motivo del SKIP del gate: tests que fallaron bajo cobertura, o cualquier otra falla. */
export function coverageSkipReason(measureExit: number, worktree: string): string {
  const rcFile = join(worktree, COVERAGE_RC)
  const collectRc = existsSync(rcFile) ? readFileSync(rcFile, 'utf8').replace(/\n+$/, '') : ''
  if (measureExit === 3 && isFile(join(worktree, COVERAGE_XML)) && /^[0-9]+$/.test(collectRc)) {
    return `SKIP coverage-gate: tests fallaron bajo cobertura (exit code ${collectRc})`
  }
  return 'SKIP coverage-gate: instrumentacion fallo'
}

/** Corre `dotnet test` de un proyecto con la salida heredada; devuelve su codigo. */
export type RunProjectTests = (args: string[]) => number | null

function inheritedDotnet(args: string[]): number | null {
  const target = spawnTarget('dotnet', args)
  return spawnSync(target.command, target.args, { stdio: 'inherit', windowsVerbatimArguments: target.verbatim }).status
}

/**
 * Lo que corre bajo `dotnet-coverage collect`: los `*.Tests` sin compilar, nunca los
 * `*.SmokeTests` (van contra el entorno desplegado). Termina con el primer fallo real; sin tests
 * (8) sigue.
 */
export function runCoverageTests(worktree: string, namespacePrefix: string, run: RunProjectTests = inheritedDotnet): number {
  for (const project of testProjects(worktree, namespacePrefix)) {
    const code = run(['test', '--project', project + sep, '--no-build']) ?? 127
    if (code !== 0 && code !== 8) return code
  }
  return 0
}

if (isEntryPoint(import.meta.url) && process.argv[2] === 'run-tests') {
  process.exitCode = runCoverageTests(process.argv[3] ?? '', process.argv[4] ?? '')
}
