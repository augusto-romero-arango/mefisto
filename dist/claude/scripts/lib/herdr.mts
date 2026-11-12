// Lo comun a las interfaces herdr de los pipelines (`herdr-pipeline.mts` y
// `mefisto-herdr-pipeline.mts`): lectura de las respuestas de la CLI de herdr, pool de panes de
// ejecucion, ocupacion de un pane, marcadores de despacho, linea que se teclea en un pane y el
// runner que corre dentro de el.
//
// Ocupacion (MEF-ADR-0057): Windows no tiene grupos de foreground, asi que la marca el runner. Un
// pane esta ocupado si su registro nombra un PID vivo. Sin eso, en POSIX decide herdr
// (`foreground_process_group_id == shell_pid`); en Windows un pane liberado por su runner esta
// libre y uno sin registro cuenta como ocupado.

import type { ChildProcess, StdioOptions } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { chomp, parseJson, rawField } from './azure-cli.mts'
import type { Run } from './azure-cli.mts'
import { COLOR, launch as launchProcess, repoRoot } from './cli.mts'
import { launcherStatePath, LauncherExit } from './launcher.mts'
import { PIPELINE_SIGNALS } from './pipeline/pipeline-exit.mts'
import type { SignalSource } from './pipeline/pipeline-exit.mts'
import { runStamp } from './pipeline/pipeline-status.mts'

const { red: RED, yellow: YELLOW, cyan: CYAN, green: GREEN, bold: BOLD, reset: NC } = COLOR

export type Abort = (message: string) => never

/** Valor de `jq -r '<ruta> // empty'` sobre la respuesta JSON de herdr. */
export function herdrField(text: string, ...path: string[]): string {
  return rawField(parseJson(text)?.value, ...path)
}

/** Salida combinada de un comando, como la deja `$(... 2>&1)`. */
export function combinedOutput(result: { stdout: string; stderr: string }): string {
  return chomp(result.stdout + result.stderr)
}

export interface ProcessInfo {
  shellPid: string
  foregroundGroup: string
}

/** `herdr pane process-info`; `null` si la consulta falla. */
export function paneProcessInfo(run: Run, pane: string): ProcessInfo | null {
  const result = run('herdr', ['pane', 'process-info', '--pane', pane])
  if (result.status !== 0) return null
  return {
    shellPid: herdrField(result.stdout, 'result', 'process_info', 'shell_pid'),
    foregroundGroup: herdrField(result.stdout, 'result', 'process_info', 'foreground_process_group_id'),
  }
}

/** El shell del pane esta en su prompt: el es su propio grupo de foreground (solo POSIX). */
export function shellInForeground(info: ProcessInfo | null): boolean {
  return info !== null && info.shellPid !== '' && info.foregroundGroup === info.shellPid
}

export function paneExists(run: Run, pane: string): boolean {
  return run('herdr', ['pane', 'get', pane]).status === 0
}

// --- Ocupacion de un pane ---

export interface PaneOccupancy {
  pane: string
  /** PID del proceso que ocupa el pane; `null` cuando su runner ya lo libero. */
  pid: number | null
  token: string
  title: string
  at: string
}

/** Registro de ocupacion de `pane` bajo el estado del pipeline. */
export function occupancyPath(stateDir: string, pane: string): string {
  return join(stateDir, 'herdr-panes', `${pane.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)
}

export function readOccupancy(path: string): PaneOccupancy | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const pid = record.pid
  return {
    pane: typeof record.pane === 'string' ? record.pane : '',
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
    token: typeof record.token === 'string' ? record.token : '',
    title: typeof record.title === 'string' ? record.title : '',
    at: typeof record.at === 'string' ? record.at : '',
  }
}

function writeOccupancy(path: string, record: PaneOccupancy): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record)}\n`)
}

export function markPaneOccupied(path: string, record: Omit<PaneOccupancy, 'at'>, now: Date = new Date()): void {
  writeOccupancy(path, { ...record, at: now.toISOString() })
}

/** Libera el pane si el registro sigue siendo de `token`: otro despacho pudo tomarlo despues. */
export function releasePane(path: string, token: string, now: Date = new Date()): void {
  const current = readOccupancy(path)
  if (current !== null && current.token !== token) return
  try {
    writeOccupancy(path, { pane: current?.pane ?? '', pid: null, token, title: current?.title ?? '', at: now.toISOString() })
  } catch {
    // Sin poder anotarlo, el PID muerto del registro termina liberando el pane.
  }
}

/** Como `kill -0`: el proceso existe aunque no se le puedan mandar senales. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface PaneFreedomOptions {
  run: Run
  stateDir: string
  platform: NodeJS.Platform
  isAlive?: (pid: number) => boolean
}

/**
 * Un pane esta libre si nadie lo ocupa: su registro no nombra un PID vivo y, en POSIX, herdr ve
 * el shell en foreground. En Windows no hay grupos de foreground: un pane que Mefisto nunca marco
 * puede estar corriendo cualquier cosa, y se trata como ocupado.
 */
export function paneIsFree(pane: string, options: PaneFreedomOptions): boolean {
  const record = readOccupancy(occupancyPath(options.stateDir, pane))
  if (record !== null && record.pid !== null && (options.isAlive ?? pidAlive)(record.pid)) return false
  if (options.platform !== 'win32') return shellInForeground(paneProcessInfo(options.run, pane))
  return record !== null
}

// --- Pertenencia del pane que despacha ---

export type ParentOf = (pid: number) => number | null

function parsePid(text: string): number | null {
  const value = text.trim()
  return /^[0-9]+$/.test(value) ? Number(value) : null
}

/** Padre de un proceso con `ps -o ppid= -p <pid>`. */
export function posixParentOf(run: Run): ParentOf {
  return (pid) => {
    const result = run('ps', ['-o', 'ppid=', '-p', String(pid)])
    return result.status === 0 ? parsePid(result.stdout) : null
  }
}

const WINDOWS_PROCESS_TABLE =
  "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + ' ' + [string]$_.ParentProcessId }"

/** Padre de un proceso en Windows: una sola consulta a `Win32_Process`, cacheada. */
export function windowsParentOf(run: Run): ParentOf {
  let table: Map<number, number> | null = null
  return (pid) => {
    if (table === null) {
      table = new Map()
      const encoded = Buffer.from(WINDOWS_PROCESS_TABLE, 'utf16le').toString('base64')
      const result = run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
      if (result.status === 0) {
        for (const line of result.stdout.split(/\r?\n/)) {
          const [child, parent] = line.trim().split(/\s+/)
          const childPid = parsePid(child ?? '')
          const parentPid = parsePid(parent ?? '')
          if (childPid !== null && parentPid !== null) table.set(childPid, parentPid)
        }
      }
    }
    return table.get(pid) ?? null
  }
}

export function defaultParentOf(run: Run, platform: NodeJS.Platform): ParentOf {
  return platform === 'win32' ? windowsParentOf(run) : posixParentOf(run)
}

/** `true` si `pid` desciende del shell que herdr reporta para `pane`; ante la duda, `false`. */
export function descendsFromPaneShell(run: Run, pane: string, pid: number, parentOf: ParentOf): boolean {
  const shellPid = paneProcessInfo(run, pane)?.shellPid ?? ''
  let current: number | null = pid
  for (let depth = 0; shellPid !== '' && current !== null && current > 1 && depth < 64; depth++) {
    if (String(current) === shellPid) return true
    current = parentOf(current)
  }
  return false
}

// --- Pool de panes de ejecucion ---

export interface PanePool {
  /** `herdr-report-panes.txt`: una linea `<pane_id> <runtime>` por pane. */
  file: string
  workspace: string
  runtime: string
  /** Descarta filas con un id o un runtime que no pueden ser de Mefisto (lado publicado). */
  strictRows: boolean
}

export interface PruneOutcome {
  /** Pane libre que quedo vivo para reutilizarlo, o vacio. */
  chosen: string
  closed: number
}

/**
 * Quita del pool los panes que ya no existen y cierra los libres sobrantes del mismo workspace y
 * runtime, dejando vivo el primero libre. Nunca toca panes ocupados ni de otro workspace o runtime.
 */
export function prunePanes(
  pool: PanePool,
  run: Run,
  isFree: (pane: string) => boolean,
  log: (message: string) => void,
): PruneOutcome {
  mkdirSync(dirname(pool.file), { recursive: true })
  if (!existsSync(pool.file)) writeFileSync(pool.file, '')
  // Como `while read`, una ultima linea sin salto no se lee.
  const rows = readFileSync(pool.file, 'utf8').split('\n')
  rows.pop()
  let kept = ''
  let chosen = ''
  let closed = 0
  for (const line of rows) {
    if (line === '') continue
    const space = line.indexOf(' ')
    if (space < 0) continue
    const id = line.slice(0, space)
    const paneRuntime = line.slice(space + 1)
    if (pool.strictRows && (id === '' || /\s/.test(id) || !/^[a-z0-9_]+$/.test(paneRuntime))) continue
    if (!paneExists(run, id)) continue
    if (!id.startsWith(`${pool.workspace}:`) || paneRuntime !== pool.runtime || !isFree(id)) {
      kept += `${line}\n`
    } else if (chosen === '') {
      chosen = id
      kept += `${line}\n`
    } else if (run('herdr', ['pane', 'close', id]).status === 0) {
      log(`Pane sobrante de una corrida terminada cerrado: ${id}`)
      closed++
    } else {
      kept += `${line}\n`
    }
  }
  writeFileSync(pool.file, kept)
  return { chosen, closed }
}

export interface SplitRequest {
  from: string
  direction: 'right' | 'down'
  cwd: string
  ratio?: string
}

/** `herdr pane split ... --no-focus`; devuelve el pane nuevo o la respuesta con que fallo. */
export function splitPane(run: Run, request: SplitRequest): { pane: string; response: string; ok: boolean } {
  const args = ['pane', 'split', '--pane', request.from, '--direction', request.direction]
  if (request.ratio !== undefined) args.push('--ratio', request.ratio)
  args.push('--cwd', request.cwd, '--no-focus')
  const result = run('herdr', args)
  const response = combinedOutput(result)
  return { ok: result.status === 0, pane: herdrField(result.stdout, 'result', 'pane', 'pane_id'), response }
}

// --- Marcadores de despacho ---

/** Token unico por despacho: epoch, PID y un contador de la corrida. */
export function dispatchTokens(now: () => Date, pid: number): () => string {
  let seq = 0
  return () => {
    seq++
    return `${Math.floor(now().getTime() / 1000)}-${pid}-${seq}`
  }
}

export function dispatchMarkerPath(stateDir: string, token: string): string {
  return join(stateDir, `herdr-dispatch-${token}.started`)
}

export function dispatchSpecPath(stateDir: string, token: string): string {
  return join(stateDir, `herdr-dispatch-${token}.json`)
}

/** `true` si `marker` aparece antes de `timeout` segundos; sondea cada segundo. */
export async function waitForDispatchMarker(
  marker: string,
  timeout: number,
  sleep: (seconds: number) => Promise<void>,
): Promise<boolean> {
  for (let waited = 0; !existsSync(marker); waited++) {
    if (waited >= timeout) return false
    await sleep(1)
  }
  return true
}

/**
 * Reclama el marcador con creacion exclusiva al agotar el plazo. `false` si ya existia: el runner
 * arranco justo en el borde y no se reintenta sobre el, para no duplicar la corrida (MEF-ADR-0017).
 */
export function claimDispatchMarker(marker: string): boolean {
  try {
    writeFileSync(marker, 'abandonado\n', { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

/** Plazo de confirmacion de arranque: `HERDR_DISPATCH_CONFIRM_TIMEOUT` o 15 segundos. */
export function confirmTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.HERDR_DISPATCH_CONFIRM_TIMEOUT ?? ''
  if (raw === '') return 15
  return /^[0-9]+$/.test(raw) ? Number(raw) : 0
}

// --- Linea que se teclea en el pane ---

export class PaneLineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaneLineError'
  }
}

/**
 * Motivo por el que `arg` no se puede escribir entre comillas dobles de forma que bash, zsh,
 * PowerShell y `cmd.exe` lo lean igual, o `null` si se puede.
 */
export function paneArgumentProblem(arg: string): string | null {
  if (arg === '') return 'esta vacio (PowerShell descarta los argumentos vacios)'
  const control = /[\u0000-\u001f\u007f]/.exec(arg)
  if (control !== null) return 'contiene un caracter de control'
  const special = /["$`%!‘-‟]/.exec(arg)
  if (special !== null) return `contiene '${special[0]}'`
  if (/\\(?=[\\"$`]|$)/.test(arg)) return 'contiene una barra invertida que bash o node reinterpretarian'
  return null
}

export function quotePaneArgument(arg: string): string {
  const problem = paneArgumentProblem(arg)
  if (problem !== null) throw new PaneLineError(`'${arg}' ${problem}`)
  return `"${arg}"`
}

/**
 * Linea que se teclea en un pane para correr `script` con Node: `node "<script>" "<arg>"...`.
 * Sin `;`, `&&`, `$()`, redirecciones ni variables de entorno: lo que no viaja como argumento va
 * en el archivo de despacho.
 */
export function paneCommandLine(script: string, args: readonly string[]): string {
  return ['node', ...[script, ...args].map(quotePaneArgument)].join(' ')
}

export interface DispatchSpec {
  title: string
  issues: string
  delay: number
  startedMarker: string
  /** Pane donde se tecleo la linea; el runner registra ahi su ocupacion. */
  pane: string
  token: string
  cwd: string
  /** Variables que el runner suma a su entorno antes de lanzar el pipeline. */
  env: Record<string, string>
  command: string[]
}

export function writeDispatchSpec(path: string, spec: DispatchSpec): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`)
}

/** `null` si el archivo no existe o no tiene la forma de un despacho. */
export function readDispatchSpec(path: string): DispatchSpec | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const text = (key: string): string | null => (typeof raw[key] === 'string' ? (raw[key] as string) : null)
  const env = raw.env
  const command = raw.command
  const fields = [text('title'), text('issues'), text('startedMarker'), text('pane'), text('token'), text('cwd')]
  if (fields.some((field) => field === null)) return null
  if (typeof raw.delay !== 'number' || !Number.isInteger(raw.delay) || raw.delay < 0) return null
  if (typeof env !== 'object' || env === null || Object.values(env).some((v) => typeof v !== 'string')) return null
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string')) return null
  const [title, issues, startedMarker, pane, token, cwd] = fields as string[]
  return {
    title: title as string,
    issues: issues as string,
    delay: raw.delay,
    startedMarker: startedMarker as string,
    pane: pane as string,
    token: token as string,
    cwd: cwd as string,
    env: env as Record<string, string>,
    command: command as string[],
  }
}

// --- Despacho a un pane ---

export interface DispatcherContext {
  run: Run
  projectRoot: string
  /** `HERDR_PANE_ID`: el pane que despacha. */
  pane: string
  stateDir: string
  pool: PanePool
  /** Script que el pane corre con `--_pane-runner`. */
  runnerScript: string
  /** Variables que viajan al runner por el archivo de despacho. */
  dispatchEnv: () => Record<string, string>
  confirmTimeout: number
  pid: number
  platform: NodeJS.Platform
  now: () => Date
  sleep: (seconds: number) => Promise<void>
  /** Exige que el proceso descienda del pane que despacha; aborta si no. */
  assertOwnership: () => void
  isAlive?: (pid: number) => boolean
  log: (message: string) => void
  success: (message: string) => void
  warn: (message: string) => void
  abort: Abort
  /** Linea que describe el pane en el aviso de exito. */
  liveHint: string
  logDir: string
}

export interface PaneLaunch {
  title: string
  issues: string
  delay: number
  command: string[]
}

export type LaunchOutcome = 'confirmed' | 'unconfirmed' | 'run-failed'

export interface Dispatcher {
  isFree: (pane: string) => boolean
  prune: () => PruneOutcome
  splitNew: () => string
  acquire: () => string
  /** Teclea el runner en `pane` y espera su confirmacion de arranque. */
  startInPane: (pane: string, launch: PaneLaunch) => Promise<LaunchOutcome>
  dispatch: (title: string, issues: string, command: string[]) => Promise<void>
}

export function createDispatcher(ctx: DispatcherContext): Dispatcher {
  const nextToken = dispatchTokens(ctx.now, ctx.pid)
  const isFree = (pane: string): boolean =>
    paneIsFree(pane, {
      run: ctx.run,
      stateDir: ctx.stateDir,
      platform: ctx.platform,
      ...(ctx.isAlive === undefined ? {} : { isAlive: ctx.isAlive }),
    })
  const lineFor = (token: string): string => {
    try {
      return paneCommandLine(ctx.runnerScript, ['--_pane-runner', '--dispatch', dispatchSpecPath(ctx.stateDir, token)])
    } catch (error) {
      return ctx.abort(
        `No se puede teclear el runner en un pane: la ruta ${(error as Error).message}. Mueve el repo o el plugin a una ruta sin esos caracteres, o usa MEFISTO_UI=mod.`,
      )
    }
  }
  const prune = (): PruneOutcome => prunePanes(ctx.pool, ctx.run, isFree, ctx.log)
  const splitNew = (): string => {
    ctx.assertOwnership()
    const split = splitPane(ctx.run, { from: ctx.pane, direction: 'right', cwd: ctx.projectRoot })
    if (!split.ok) ctx.abort(`No se pudo crear el pane de ejecucion (herdr pane split): ${split.response}`)
    if (split.pane === '') ctx.abort(`herdr pane split no devolvio pane_id. Respuesta: ${split.response}`)
    writeFileSync(ctx.pool.file, `${split.pane} ${ctx.pool.runtime}\n`, { flag: 'a' })
    return split.pane
  }
  const acquire = (): string => {
    ctx.assertOwnership()
    let chosen = prune().chosen
    if (chosen === '') {
      chosen = splitNew()
      ctx.log(`Pane de ejecucion nuevo: ${chosen}`)
    } else {
      ctx.log(`Reusando el pane de ejecucion libre: ${chosen}`)
    }
    return chosen
  }
  const startInPane = async (pane: string, launch: PaneLaunch): Promise<LaunchOutcome> => {
    const token = nextToken()
    const marker = dispatchMarkerPath(ctx.stateDir, token)
    const line = lineFor(token)
    rmSync(marker, { force: true })
    writeDispatchSpec(dispatchSpecPath(ctx.stateDir, token), {
      title: launch.title,
      issues: launch.issues,
      delay: launch.delay,
      startedMarker: marker,
      pane,
      token,
      cwd: ctx.projectRoot,
      env: ctx.dispatchEnv(),
      command: launch.command,
    })
    // Reserva hasta que el runner registre su propio PID: otro despacho no debe tomar el pane.
    markPaneOccupied(occupancyPath(ctx.stateDir, pane), { pane, pid: ctx.pid, token, title: launch.title }, ctx.now())
    if (ctx.run('herdr', ['pane', 'run', pane, line]).status !== 0) return 'run-failed'
    if ((await waitForDispatchMarker(marker, ctx.confirmTimeout, ctx.sleep)) || !claimDispatchMarker(marker)) {
      return 'confirmed'
    }
    return 'unconfirmed'
  }
  const announce = (title: string, pane: string, suffix: string): void => {
    ctx.success(`Pipeline '${title}' corriendo en el pane ${pane} de este workspace${suffix}.`)
    ctx.log(`${ctx.liveHint}; el reporte completo queda en ${ctx.logDir}/.`)
    ctx.log('No hay sesion que adjuntar: el pane ya esta visible en el workspace (barra lateral de herdr).')
  }
  const dispatch = async (title: string, issues: string, command: string[]): Promise<void> => {
    lineFor('x')
    const pane = acquire()
    const launch: PaneLaunch = { title, issues, delay: 0, command }
    const first = await startInPane(pane, launch)
    if (first === 'run-failed') ctx.abort(`No se pudo lanzar el pipeline en el pane ${pane} (herdr pane run fallo).`)
    if (first === 'confirmed') return announce(title, pane, '')

    const timeout = ctx.confirmTimeout
    ctx.warn(
      `El pane ${pane} no confirmo el arranque en ${timeout}s (marcador ausente): puede tener el shell en un estado invalido. Reintentando en un pane nuevo, sin volver a escribir en ${pane}.`,
    )
    const retry = splitNew()
    const second = await startInPane(retry, launch)
    if (second === 'run-failed') {
      ctx.abort(
        `No se pudo lanzar el pipeline en el pane de reintento ${retry} (herdr pane run fallo). Pane sospechoso original: ${pane}.`,
      )
    }
    if (second === 'confirmed') return announce(title, retry, ` (reintento tras un arranque no confirmado en ${pane})`)
    ctx.abort(
      `Ni el pane ${pane} ni el reintento ${retry} confirmaron el arranque de '${title}' en ${timeout}s. Cierra ambos paneles (alguno de los dos shells puede seguir en un estado invalido) y relanza el pipeline a mano.`,
    )
  }
  return { isFree, prune, splitNew, acquire, startInPane, dispatch }
}

// --- Runner que corre dentro del pane ---

export type LaunchChild = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: StdioOptions },
) => ChildProcess

export interface PaneRunnerDeps {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  out: (text: string) => void
  err: (text: string) => void
  run: Run
  now: () => Date
  sleep: (seconds: number) => Promise<void>
  pid: number
  execPath: string
  /** Prefijo como `caffeinate -i`. */
  caffeinate: string[]
  launch?: LaunchChild
  signals?: SignalSource
  exit?: (code: number) => void
}

export interface PaneRunnerFlavor {
  /** Acepta `--delay` (arranque escalonado de un lote paralelo). */
  allowDelay: boolean
  /** Prefijo del `.report.log`. */
  reportPrefix: string
  /** Sigue en vivo el reporte en el pane y al final solo nombra su ruta. */
  followReport: boolean
  /** Visor en vivo de la corrida. */
  viewer: (issues: string, newerThan: number) => string[]
}

interface RunnerArgs {
  title: string
  issues: string
  delay: number
  startedMarker: string
  dispatch: string
  command: string[]
}

function parseRunnerArgs(argv: readonly string[], flavor: PaneRunnerFlavor, abort: Abort): RunnerArgs {
  const parsed: RunnerArgs = { title: '', issues: '', delay: 0, startedMarker: '', dispatch: '', command: [] }
  let i = 0
  const value = (flag: string): string => {
    if (i + 1 >= argv.length) abort(`Falta el valor de ${flag}`)
    const next = argv[i + 1] as string
    i += 2
    return next
  }
  while (i < argv.length) {
    const arg = argv[i] as string
    if (arg === '--title') parsed.title = value(arg)
    else if (arg === '--issues') parsed.issues = value(arg)
    else if (arg === '--delay' && flavor.allowDelay) {
      const delay = value(arg)
      if (!/^[0-9]+$/.test(delay)) abort(`--delay debe ser un entero de segundos (recibido: '${delay}')`)
      parsed.delay = Number(delay)
    } else if (arg === '--started-marker') parsed.startedMarker = value(arg)
    else if (arg === '--dispatch') parsed.dispatch = value(arg)
    else if (arg === '--') {
      parsed.command = argv.slice(i + 1)
      break
    } else abort(`Argumento no reconocido para --_pane-runner: ${arg}`)
  }
  return parsed
}

/** Comando con que el runner lanza `argv`: los `.mts` y los `.sh` con su gemela se corren con Node. */
export function runnableCommand(argv: readonly string[], execPath: string): string[] {
  const [head = '', ...rest] = argv
  if (/\.(mts|mjs|js)$/.test(head)) return [execPath, head, ...rest]
  if (head.endsWith('.sh')) {
    const twin = `${head.slice(0, -3)}.mts`
    return existsSync(twin) ? [execPath, twin, ...rest] : ['bash', head, ...rest]
  }
  return [...argv]
}

/** Las ultimas `count` lineas de `text`, como `tail -n`. */
export function tailLines(text: string, count: number): string {
  const ended = text.endsWith('\n')
  const rows = text.split('\n')
  if (ended) rows.pop()
  return rows.slice(-count).join('\n') + (ended ? '\n' : '')
}

function followFile(path: string, write: (text: string) => void): { stop: () => void } {
  const decoder = new StringDecoder('utf8')
  let offset = 0
  const drain = (): void => {
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    try {
      const buffer = Buffer.alloc(64 * 1024)
      let read = readSync(fd, buffer, 0, buffer.length, offset)
      while (read > 0) {
        offset += read
        write(decoder.write(buffer.subarray(0, read)))
        read = readSync(fd, buffer, 0, buffer.length, offset)
      }
    } finally {
      closeSync(fd)
    }
  }
  const timer = setInterval(drain, 200)
  return {
    stop: () => {
      clearInterval(timer)
      drain()
      write(decoder.end())
    },
  }
}

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise((resolveCode) => {
    if (child.exitCode !== null) return resolveCode(child.exitCode)
    child.once('exit', (code, signal) => {
      if (code !== null) return resolveCode(code)
      const numbers: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
      resolveCode(128 + (numbers[signal ?? ''] ?? 0))
    })
  })
}

/**
 * Corre dentro del pane: confirma el arranque, registra la ocupacion del pane, lanza el pipeline
 * con su reporte a un log, muestra el visor en vivo y al terminar imprime el final del reporte (o
 * su ruta) y renombra el pane `[ok]`/`[fallo]`. Devuelve el codigo del pipeline.
 */
export async function runPaneRunner(deps: PaneRunnerDeps, flavor: PaneRunnerFlavor): Promise<number> {
  const abort: Abort = (message) => {
    deps.err(`\n${RED}${BOLD}x ${message}${NC}\n`)
    throw new LauncherExit(1)
  }
  const outLine = (line: string): void => deps.out(`${line}\n`)
  const launch: LaunchChild = deps.launch ?? ((command, args, options) => launchProcess(command, args, options))
  const signals = deps.signals ?? process
  const exit = deps.exit ?? ((code: number): void => void process.exit(code))

  let args: RunnerArgs
  let spec: DispatchSpec | null = null
  try {
    args = parseRunnerArgs(deps.argv, flavor, abort)
    if (args.dispatch !== '') {
      spec = readDispatchSpec(args.dispatch)
      if (spec === null) abort(`No se pudo leer el archivo de despacho ${args.dispatch}.`)
      const loaded = spec as DispatchSpec
      args = { ...args, title: loaded.title, issues: loaded.issues, delay: loaded.delay, startedMarker: loaded.startedMarker, command: loaded.command }
      if (!flavor.allowDelay) args.delay = 0
    }
    if (args.title === '') abort('--_pane-runner requiere --title')
    if (args.command.length === 0) abort('--_pane-runner requiere un comando tras --')

    // Primero que nada: si el despachador ya reclamo el marcador, arrancar aqui duplicaria la corrida.
    if (args.startedMarker !== '') {
      try {
        mkdirSync(dirname(args.startedMarker), { recursive: true })
      } catch {
        // Sin carpeta, la creacion exclusiva de abajo falla y aborta.
      }
      try {
        closeSync(openSync(args.startedMarker, 'wx'))
      } catch {
        abort(
          `Este pane arranco despues del plazo de confirmacion (${args.startedMarker} ya reclamado por el despachador): no se lanza nada para no duplicar la corrida. Cierra este pane.`,
        )
      }
    }
  } catch (error) {
    if (error instanceof LauncherExit) return error.code
    throw error
  }
  if (spec !== null) rmSync(args.dispatch, { force: true })

  const env: NodeJS.ProcessEnv = { ...deps.env, ...(spec?.env ?? {}) }
  const cwd = spec?.cwd ?? deps.cwd
  const root = repoRoot(cwd) ?? cwd
  const logDir = dirname(launcherStatePath(join('logs', '.state'), root, env))
  const paneId = env.HERDR_PANE_ID ?? ''
  const occupiedPane = spec?.pane ?? paneId
  const token = spec?.token ?? `${Math.floor(deps.now().getTime() / 1000)}-${deps.pid}`
  const occupancy = occupiedPane === '' ? '' : occupancyPath(dirname(logDir), occupiedPane)
  if (occupancy !== '') {
    markPaneOccupied(occupancy, { pane: occupiedPane, pid: deps.pid, token, title: args.title }, deps.now())
  }
  const release = (): void => {
    if (occupancy !== '') releasePane(occupancy, token, deps.now())
  }
  const rename = (title: string): void => {
    if (paneId !== '') deps.run('herdr', ['pane', 'rename', paneId, title])
  }

  let pipeline: ChildProcess | null = null
  let viewer: ChildProcess | null = null
  let follower: { stop: () => void } | null = null
  let reportLog = ''
  let interrupted = false
  const onSignal = (): void => {
    if (interrupted) return
    interrupted = true
    pipeline?.kill()
    follower?.stop()
    follower = null
    viewer?.kill()
    rename(`[cortado] ${args.title}`)
    outLine('')
    outLine(`Corrida interrumpida. Reporte parcial: ${reportLog}`)
    release()
    exit(130)
  }
  try {
    reportLog = join(logDir, `${flavor.reportPrefix}-${runStamp(deps.now())}-${deps.pid}.report.log`)
    rename(args.title)
    deps.out('\u001b[2J\u001b[3J\u001b[H')
    outLine(`${CYAN}${BOLD}=== ${args.title} ===${NC}`)
    outLine(`${CYAN}Comando: ${args.command.join(' ')}${NC}`)
    outLine(`${CYAN}Reporte: ${reportLog}${NC}`)
    outLine('')
    if (args.delay > 0) {
      outLine(`${YELLOW}Arranque escalonado: esperando ${args.delay}s antes de lanzar...${NC}`)
      await deps.sleep(args.delay)
    }
    const startEpoch = Math.floor(deps.now().getTime() / 1000)

    // Sin HERDR_*: un lanzador invocado a lo largo de la corrida abriria panes reales.
    const childEnv: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(env)) if (!key.startsWith('HERDR_')) childEnv[key] = value
    const [command = '', ...commandArgs] = [...deps.caffeinate, ...runnableCommand(args.command, deps.execPath)]
    const report = openSync(reportLog, 'w')
    let rc: number
    try {
      for (const signal of PIPELINE_SIGNALS.filter((s) => s !== 'SIGHUP')) signals.on(signal, onSignal)
      const child = launch(command, commandArgs, { cwd, env: childEnv, stdio: ['ignore', report, report] })
      pipeline = child
      const spawnFailed = new Promise<number>((resolveCode) => {
        child.once('error', (error) => {
          try {
            writeFileSync(reportLog, `${command}: ${error.message}\n`, { flag: 'a' })
          } catch {
            // El codigo 127 basta para el banner de fallo.
          }
          resolveCode(127)
        })
      })
      if (flavor.followReport) follower = followFile(reportLog, deps.out)
      viewer = launch(deps.execPath, flavor.viewer(args.issues, startEpoch), { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
      viewer.on('error', () => {})
      rc = await Promise.race([exitCodeOf(child), spawnFailed])
    } finally {
      closeSync(report)
      for (const signal of PIPELINE_SIGNALS) signals.off(signal, onSignal)
    }
    if (interrupted) return 130

    follower?.stop()
    follower = null
    if (viewer !== null) {
      const ended = viewer.exitCode !== null || viewer.signalCode !== null ? Promise.resolve(0) : exitCodeOf(viewer)
      viewer.kill()
      await Promise.race([ended, new Promise((done) => setTimeout(done, 5000).unref())])
    }

    outLine('')
    if (rc === 0) outLine(`${GREEN}${BOLD}=== ${args.title}: pipeline terminado OK ===${NC}`)
    else outLine(`${RED}${BOLD}=== ${args.title}: pipeline FALLO (exit ${rc}) ===${NC}`)
    if (flavor.followReport) {
      outLine(`${CYAN}Reporte completo: ${reportLog}${NC}`)
      outLine('')
    } else {
      outLine('')
      if (existsSync(reportLog)) {
        const text = readFileSync(reportLog, 'utf8')
        const total = (text.match(/\n/g) ?? []).length
        if (total <= 60) deps.out(text)
        else {
          outLine(`${YELLOW}(ultimas 40 lineas del reporte; completo en ${reportLog})${NC}`)
          outLine('')
          deps.out(tailLines(text, 40))
        }
      } else {
        outLine('(el pipeline no llego a escribir reporte)')
      }
    }
    rename(rc === 0 ? `[ok] ${args.title}` : `[fallo] ${args.title}`)
    return rc
  } finally {
    follower?.stop()
    release()
  }
}

/** Raiz de estado de un repo: `MEFISTO_STATE_DIR` o `<root>/.mefisto/pipeline`, sin crearla. */
export function stateDirOf(root: string, env: NodeJS.ProcessEnv): string {
  const override = env.MEFISTO_STATE_DIR ?? ''
  return override !== '' ? override : join(root, '.mefisto', 'pipeline')
}

/** `true` si `path` es un directorio. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
