// Apertura de un proyecto Mefisto en herdr (issue #691).
//
// Uso: <plugin>/scripts/herdr-workspace.sh [ruta-al-repo]
//
// Crea (o enfoca, si ya existe) el workspace herdr del repo (default: el repo git del cwd) con
// una fila por runtime: pane "planner [<kind>]" con el agente de Knowledge Crunching
// (`--agent mefisto:planner` en un consumidor, `--agent mefisto-planner` en el repo de Mefisto)
// y pane "ejecucion [<kind>]" para despachar issues.
//
// Filas (issue #958, MEF-ADR-0049/0050): en Mefisto, una por cada kind de MEFISTO_RUNTIMES (o
// MEFISTO_RUNTIME, o `claude`); en un consumidor, solo `claude`. Al crear el workspace todos los
// `down` salen del pane raiz antes de cualquier `right` y recorren la lista al reves: herdr
// inserta cada pane justo debajo de la raiz. Con tres o mas filas las inferiores pueden quedar
// anidadas; es un limite aceptado. Cada pane lleva `--env MEFISTO_RUNTIME=<kind>` y
// MEFISTO_MODELS_FILE si esta definida; nunca se fija provider, modelo ni credenciales.
//
// Adopcion (issue #2493): un workspace con el label del repo sin panes de rol de Mefisto se
// adopta montando todas las filas debajo de su pane raiz, que queda intacto. Con varios
// workspaces del mismo label se prefiere el primero con panes de rol.
//
// Los agentes se lanzan con `herdr agent start` bajo nombres unicos por workspace
// (`<rol>-<slug>-<kind>`). Si un lanzamiento falla, el pane queda con su shell y se avisa.
//
// Idempotencia: un consumidor normalizado solo se enfoca; un layout legacy se normaliza por label
// y converge en una invocacion posterior. En Mefisto, una fila con label `planner [<kind>]` no
// se toca y las faltantes se agregan con `down` desde el planner de la ultima fila existente.

import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { chomp, parseJson } from './lib/azure-cli.mts'
import type { Run } from './lib/azure-cli.mts'
import { capture, CliError, COLOR, commandExists, isEntryPoint } from './lib/cli.mts'
import { combinedOutput, herdrField, paneProcessInfo, shellInForeground } from './lib/herdr.mts'
import { LauncherExit } from './lib/launcher.mts'
import { clockTime } from './lib/pipeline/agent-log.mts'

const { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, bold: BOLD, reset: NC } = COLOR

export interface HerdrWorkspaceDeps {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  out: (text: string) => void
  err: (text: string) => void
  /** `herdr` y `git`. */
  run: Run
  hasCommand: (command: string) => boolean
  now: () => Date
  sleep: (seconds: number) => Promise<void>
  platform: NodeJS.Platform
}

/**
 * Slug del label para el nombre de agente: minusculas, todo lo que no sea [a-z0-9] colapsa a
 * '-', sin guiones en los extremos y con un tope de `max` caracteres.
 */
export function workspaceSlug(label: string, max = 20): string {
  return label
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
    .slice(0, max)
    .replace(/-$/, '')
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24
  for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1
  return crc >>> 0
})

/** CRC de `cksum` (POSIX): CRC-32 sin reflejar, con la longitud al final y complementado. */
export function cksum(text: string): number {
  let crc = 0
  const add = (byte: number): void => {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0
  }
  const bytes = Buffer.from(text, 'utf8')
  for (const byte of bytes) add(byte)
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) add(length & 0xff)
  return ~crc >>> 0
}

/**
 * Nombre de agente herdr para `rol` ("planner" o "ejecucion"). Con `kind` el slug deja espacio
 * para el prefijo mas largo ("ejecucion-") y "-<kind>" dentro de los 32 caracteres de herdr. Si el
 * slug completo no cabe, se recorta 5 caracteres mas y se le agregan 4 hex del `cksum` del label,
 * para que dos labels con prefijo comun no choquen (issue #2502).
 */
export function agentNameForRole(rol: string, label: string, kind: string): string {
  let max = kind !== '' ? 32 - 10 - 1 - kind.length : 20
  if (max < 1) max = 1
  if (kind !== '') {
    const full = workspaceSlug(label, 1000)
    if (full.length > max) {
      const short = Math.max(max - 5, 1)
      const hash = (cksum(label) % 65536).toString(16).padStart(4, '0')
      return `${rol}-${workspaceSlug(label, short)}-${hash}-${kind}`
    }
  }
  return `${rol}-${workspaceSlug(label, max)}${kind !== '' ? `-${kind}` : ''}`
}

/** Planner interno en el repo de Mefisto; el publicado en un consumidor. */
export function plannerAgentForRepo(root: string): string {
  return existsSync(join(root, '.claude-plugin', 'plugin.json')) ? 'mefisto-planner' : 'mefisto:planner'
}

/** Kinds de las filas: en Mefisto, la lista configurada sin vacios ni duplicados; si no, `claude`. */
export function runtimesForRepo(plannerAgent: string, env: NodeJS.ProcessEnv): string[] {
  if (plannerAgent !== 'mefisto-planner') return ['claude']
  const configured =
    env.MEFISTO_RUNTIMES !== undefined ? env.MEFISTO_RUNTIMES : (env.MEFISTO_RUNTIME ?? '') !== '' ? (env.MEFISTO_RUNTIME as string) : 'claude'
  const seen: string[] = []
  for (const value of configured.split(',').map((part) => part.trim())) {
    if (value !== '' && !seen.includes(value)) seen.push(value)
  }
  return seen
}

interface PaneEntry {
  paneId: string
  label: string
}

function panesOf(json: string): PaneEntry[] | null {
  const value = parseJson(json)?.value
  if (typeof value !== 'object' || value === null) return null
  const panes = (value as { result?: { panes?: unknown } }).result?.panes
  if (panes === undefined || panes === null) return []
  if (!Array.isArray(panes)) return null
  return panes.map((pane) => {
    const entry = (typeof pane === 'object' && pane !== null ? pane : {}) as Record<string, unknown>
    return {
      paneId: typeof entry.pane_id === 'string' ? entry.pane_id : '',
      label: typeof entry.label === 'string' ? entry.label : '',
    }
  })
}

const ROLE_LABEL = /^(planner|ejecucion)( \[[^\]]+\])?$/

export async function herdrWorkspace(deps: HerdrWorkspaceDeps): Promise<number> {
  const { run, env } = deps
  const outLine = (line: string): void => deps.out(`${line}\n`)
  const log = (msg: string): void => outLine(`${BLUE}[${clockTime(deps.now())}]${NC} ${msg}`)
  const success = (msg: string): void => outLine(`${GREEN}${BOLD}v${NC} ${msg}`)
  const warn = (msg: string): void => outLine(`${YELLOW}!${NC} ${msg}`)
  const abort = (msg: string): never => {
    deps.err(`\n${RED}${BOLD}x ${msg}${NC}\n`)
    throw new LauncherExit(1)
  }
  const herdr = (...args: string[]) => run('herdr', args)
  const modelsEnv = (): string[] =>
    (env.MEFISTO_MODELS_FILE ?? '') !== '' ? ['--env', `MEFISTO_MODELS_FILE=${env.MEFISTO_MODELS_FILE}`] : []
  const rowEnv = (kind: string): string[] => ['--env', `MEFISTO_RUNTIME=${kind}`, ...modelsEnv()]

  const split = (from: string, direction: string, cwd: string, extra: string[]): { pane: string; response: string } => {
    const result = herdr('pane', 'split', '--pane', from, '--direction', direction, '--cwd', cwd, '--no-focus', ...extra)
    return {
      pane: result.status === 0 ? herdrField(result.stdout, 'result', 'pane', 'pane_id') : '',
      response: combinedOutput(result),
    }
  }

  const paneList = (ws: string): string | null => {
    const result = herdr('pane', 'list', '--workspace', ws)
    return result.status === 0 ? result.stdout : null
  }

  const paneLabelLookup = (ws: string, label: string): string =>
    (panesOf(paneList(ws) ?? '') ?? []).find((pane) => pane.label === label)?.paneId ?? ''

  const paneLabelIds = (json: string, label: string): string[] =>
    (panesOf(json) ?? []).filter((pane) => pane.label === label).map((pane) => pane.paneId)

  const lastRuntimePlannerLookup = (ws: string): string =>
    (panesOf(paneList(ws) ?? '') ?? []).filter((pane) => pane.label.startsWith('planner [')).at(-1)?.paneId ?? ''

  // En Windows no hay grupo de foreground: un pane recien creado esta listo cuando herdr ya
  // reporta su shell.
  const shellReady = (pane: string): boolean => {
    const info = paneProcessInfo(run, pane)
    return deps.platform === 'win32' ? info !== null && info.shellPid !== '' : shellInForeground(info)
  }

  const waitForFreeShell = async (pane: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (shellReady(pane)) return true
      await deps.sleep(0.5)
    }
    return false
  }

  // Como `echo "$err" | head -c 200` dentro de `$(...)`.
  const detail = (text: string): string => chomp(Buffer.from(`${text}\n`, 'utf8').subarray(0, 200).toString('utf8'))

  const startAgentInPane = async (name: string, pane: string, agentArg: string, kind = 'claude'): Promise<void> => {
    if (!(await waitForFreeShell(pane))) {
      warn(`El shell del pane ${pane} no llego a su prompt; lanza el agente a mano ahi.`)
      return
    }
    const described = agentArg !== '' ? ` (${kind} --agent ${agentArg})` : ''
    const rawPause = env.MEFISTO_AGENT_START_RETRY_PAUSE ?? ''
    const pause = rawPause === '' ? 3 : Number(rawPause)
    let rc = 0
    let err = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      const args = ['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '90000']
      if (agentArg !== '') args.push('--', '--agent', agentArg)
      const result = run('herdr', args)
      rc = result.status ?? 1
      err = chomp(result.stderr)
      if (rc === 0) {
        success(`Agente '${name}' corriendo en el pane ${pane}${described}`)
        return
      }
      await deps.sleep(Number.isFinite(pause) ? pause : 3)
      if (herdr('agent', 'get', name).status === 0) {
        success(`Agente '${name}' corriendo en el pane ${pane} (levanto tras el primer intento)${described}`)
        return
      }
      if (attempt === 1) {
        warn(`herdr agent start fallo para '${name}' (rc=${rc}); reintentando una vez...${err !== '' ? ` Detalle: ${detail(err)}` : ''}`)
      }
    }
    warn(`No se pudo lanzar '${name}' en el pane ${pane} tras 2 intentos (rc=${rc}).${err !== '' ? ` Detalle: ${detail(err)}` : ''}`)
    warn(`El pane quedo con su shell: lanza ahi '${kind}${agentArg !== '' ? ` --agent ${agentArg}` : ''}' a mano.`)
  }

  const normalizeConsumerClaudeRow = (ws: string, label: string): boolean => {
    const panesJson = paneList(ws) ?? ''
    const legacyPlanner = paneLabelIds(panesJson, 'planner')
    const canonicalPlanner = paneLabelIds(panesJson, 'planner [claude]')
    const legacyExecution = paneLabelIds(panesJson, 'ejecucion')
    const canonicalExecution = paneLabelIds(panesJson, 'ejecucion [claude]')
    const [lp, cp, le, ce] = [legacyPlanner.length, canonicalPlanner.length, legacyExecution.length, canonicalExecution.length]
    if (lp > 1 || cp > 1 || le > 1 || ce > 1 || (lp > 0 && cp > 0) || (le > 0 && ce > 0)) {
      warn(
        `El workspace '${label}' (${ws}) tiene labels Claude duplicados o ambiguos; revisa los panes 'planner'/'planner [claude]' y 'ejecucion'/'ejecucion [claude]' manualmente. Se enfoco sin modificar el layout.`,
      )
      return false
    }
    if (lp === 0 && cp === 0) {
      warn(
        `El workspace '${label}' (${ws}) no contiene 'planner' ni 'planner [claude]'; se enfoco sin reconstruir panes. Renombra el planner correcto a 'planner [claude]' para normalizarlo.`,
      )
      return false
    }
    let renamed = 0
    let failed = 0
    const rename = (pane: string, to: string): void => {
      if (herdr('pane', 'rename', pane, to).status === 0) renamed++
      else failed++
    }
    if (lp === 1) rename(legacyPlanner[0] as string, 'planner [claude]')
    // Por rol: termina una migracion cuyo rename del planner persistio y el de ejecucion fallo.
    if (le === 1) rename(legacyExecution[0] as string, 'ejecucion [claude]')
    if (failed > 0) {
      warn(
        `El workspace '${label}' (${ws}) no pudo normalizar ${failed} label(s); vuelve a ejecutar el script o renombra los panes legacy manualmente. No se reconstruyo el layout.`,
      )
    } else if (renamed > 0) {
      success(`Workspace '${label}' (${ws}) normalizado a la fila Claude explicita; no se reiniciaron agentes ni se modifico el cwd.`)
    }
    return failed === 0 && renamed === 0 && cp === 1 && ce === 1
  }

  const mountRuntimeRow = async (
    repoRoot: string,
    basePane: string,
    label: string,
    plannerAgent: string,
    kind: string,
  ): Promise<string> => {
    log(`Montando la fila de '${kind}' en el workspace '${label}' ...`)
    const planner = split(basePane, 'down', repoRoot, rowEnv(kind))
    if (planner.pane === '') {
      warn(`No se pudo crear el pane del planner de la fila '${kind}': ${planner.response}`)
      return ''
    }
    const execution = split(planner.pane, 'right', repoRoot, rowEnv(kind)).pane
    if (execution === '') {
      warn(`No se pudo crear el pane de ejecucion de la fila '${kind}' (split fallo): la fila queda con el pane del planner.`)
    }
    herdr('pane', 'rename', planner.pane, `planner [${kind}]`)
    if (execution !== '') herdr('pane', 'rename', execution, `ejecucion [${kind}]`)
    await startAgentInPane(agentNameForRole('planner', label, kind), planner.pane, plannerAgent, kind)
    if (execution !== '') await startAgentInPane(agentNameForRole('ejecucion', label, kind), execution, '', kind)
    outLine('')
    success(`Fila de '${kind}' lista en '${label}': planner (${planner.pane}) + ejecucion (${execution || 'no creado'}).`)
    log('Desde el pane de ejecucion despacha issues con /mefisto-tooling, /mefisto-sequential, etc.')
    return planner.pane
  }

  /**
   * Monta las filas desde `base`: primero los `down` en orden inverso, despues todos los `right`
   * y al final labels y agentes. Sin adopcion, `base` es la raiz recien creada y pasa a ser el
   * planner de la primera fila; adoptando, `base` no se toca. Devuelve cuantas filas tienen planner.
   */
  const mountRowsFromBase = async (
    repoRoot: string,
    label: string,
    plannerAgent: string,
    base: string,
    adopt: boolean,
    runtimes: string[],
  ): Promise<number> => {
    const planners: string[] = runtimes.map(() => '')
    const executions: string[] = runtimes.map(() => '')
    if (!adopt) planners[0] = base
    for (let i = runtimes.length - 1; i >= (adopt ? 0 : 1); i--) {
      const kind = runtimes[i] as string
      const planner = split(base, 'down', repoRoot, rowEnv(kind))
      if (planner.pane === '') warn(`No se pudo crear el planner de la fila '${kind}': ${planner.response}`)
      planners[i] = planner.pane
    }
    for (const [i, kind] of runtimes.entries()) {
      const pane = planners[i] as string
      if (pane === '') continue
      const execution = split(pane, 'right', repoRoot, rowEnv(kind)).pane
      if (execution === '') warn(`No se pudo crear el pane de ejecucion de la fila '${kind}'.`)
      executions[i] = execution
    }
    let mounted = 0
    for (const [i, kind] of runtimes.entries()) {
      const pane = planners[i] as string
      if (pane === '') continue
      mounted++
      const execution = executions[i] as string
      herdr('pane', 'rename', pane, `planner [${kind}]`)
      if (execution !== '') herdr('pane', 'rename', execution, `ejecucion [${kind}]`)
      await startAgentInPane(agentNameForRole('planner', label, kind), pane, plannerAgent, kind)
      if (execution !== '') await startAgentInPane(agentNameForRole('ejecucion', label, kind), execution, '', kind)
    }
    return mounted
  }

  const mountRuntimeRows = async (repoRoot: string, label: string, plannerAgent: string, runtimes: string[]): Promise<void> => {
    log(`Creando el workspace '${label}' para ${repoRoot} ...`)
    const created = herdr('workspace', 'create', '--cwd', repoRoot, '--label', label, ...rowEnv(runtimes[0] as string))
    const response = combinedOutput(created)
    if (created.status !== 0) abort(`No se pudo crear el workspace: ${response}`)
    const ws = herdrField(created.stdout, 'result', 'workspace', 'workspace_id')
    const root = herdrField(created.stdout, 'result', 'root_pane', 'pane_id')
    if (ws === '' || root === '') abort(`herdr workspace create no devolvio ids. Respuesta: ${response}`)
    await mountRowsFromBase(repoRoot, label, plannerAgent, root, false, runtimes)
    outLine('')
    success(`Workspace '${label}' listo (${ws}): ${runtimes.length} fila(s) de runtime.`)
  }

  // Ante una lista ilegible se responde que si: adoptar monta filas nuevas.
  const workspaceHasMefistoPanes = (ws: string): boolean => {
    const json = paneList(ws)
    if (json === null) return true
    const panes = panesOf(json)
    if (panes === null) return true
    return panes.some((pane) => ROLE_LABEL.test(pane.label))
  }

  const adoptWorkspaceRows = async (
    repoRoot: string,
    label: string,
    plannerAgent: string,
    ws: string,
    runtimes: string[],
  ): Promise<void> => {
    const root = (panesOf(paneList(ws) ?? '') ?? [])[0]?.paneId ?? ''
    herdr('workspace', 'focus', ws)
    if (root === '') {
      warn(`El workspace '${label}' (${ws}) no lista ningun pane desde el cual montar las filas; se enfoco sin modificar el layout.`)
      return
    }
    const mounted = await mountRowsFromBase(repoRoot, label, plannerAgent, root, true, runtimes)
    outLine('')
    if (mounted === 0) {
      warn(
        `Workspace '${label}' (${ws}) no tenia panes de Mefisto y no se pudo montar ninguna fila debajo del pane raiz; vuelve a ejecutar el script.`,
      )
      return
    }
    success(`Workspace '${label}' (${ws}) no tenia panes de Mefisto: se montaron ${mounted} fila(s) debajo del pane raiz.`)
  }

  try {
    const target = deps.argv[0] ?? '.'
    if (!deps.hasCommand('herdr')) abort('herdr no esta instalado (https://herdr.dev).')
    if (herdr('status', 'server').status !== 0) abort("El servidor de herdr no responde. Corre 'herdr' para arrancarlo.")

    const toplevel = run('git', ['-C', target, 'rev-parse', '--show-toplevel'], { cwd: deps.cwd })
    if (toplevel.status !== 0) abort(`'${target}' no esta dentro de un repositorio git.`)
    const repoRoot = resolve(chomp(toplevel.stdout))

    const plannerAgent = plannerAgentForRepo(repoRoot)
    if (
      plannerAgent === 'mefisto:planner' &&
      !existsSync(join(repoRoot, '.mefisto', 'harness.config.json')) &&
      !existsSync(join(repoRoot, '.claude', 'harness.config.json'))
    ) {
      warn(
        'El repo no tiene .mefisto/harness.config.json ni el fallback legacy .claude/harness.config.json: parece no estar onboardeado a Mefisto (/onboard).',
      )
      warn('El workspace se abre igual; completa el onboarding antes de ejecutar pipelines que requieran configuracion.')
    }

    const label = basename(repoRoot)
    const listed = herdr('workspace', 'list')
    const listedValue = listed.status === 0 ? parseJson(listed.stdout)?.value : undefined
    const workspaces = (listedValue as { result?: { workspaces?: unknown } } | undefined)?.result?.workspaces
    const candidates = (Array.isArray(workspaces) ? workspaces : [])
      .filter((ws): ws is Record<string, unknown> => typeof ws === 'object' && ws !== null && ws.label === label)
      .map((ws) => (typeof ws.workspace_id === 'string' ? ws.workspace_id : ''))
      .filter((id) => id !== '')
    let existing = ''
    const firstCandidate = candidates[0] ?? ''
    for (const candidate of candidates) {
      if (workspaceHasMefistoPanes(candidate)) {
        existing = candidate
        break
      }
    }

    const runtimes = runtimesForRepo(plannerAgent, env)
    if (runtimes.length === 0) abort('La lista de runtimes quedo vacia.')

    if (existing === '' && firstCandidate !== '') {
      await adoptWorkspaceRows(repoRoot, label, plannerAgent, firstCandidate, runtimes)
      return 0
    }
    if (existing === '') {
      await mountRuntimeRows(repoRoot, label, plannerAgent, runtimes)
      return 0
    }

    const ws = existing
    if (plannerAgent !== 'mefisto-planner' && !normalizeConsumerClaudeRow(ws, label)) {
      herdr('workspace', 'focus', ws)
      success(`El workspace '${label}' quedo enfocado; completa o reintenta la normalizacion de la fila.`)
      return 0
    }

    herdr('workspace', 'focus', ws)
    const rowPanes = runtimes.map((kind) => paneLabelLookup(ws, `planner [${kind}]`))
    let lastExisting = rowPanes.filter((pane) => pane !== '').at(-1) ?? ''
    if (lastExisting === '') lastExisting = lastRuntimePlannerLookup(ws)
    if (lastExisting === '') {
      warn(
        `El workspace '${label}' (${ws}) no contiene ningun planner de runtime desde el cual montar las filas faltantes; se enfoco sin modificar el layout.`,
      )
      return 0
    }

    let mounted = 0
    for (const [i, kind] of runtimes.entries()) {
      if (rowPanes[i] !== '') continue
      const planner = await mountRuntimeRow(repoRoot, lastExisting, label, plannerAgent, kind)
      if (planner !== '') {
        lastExisting = planner
        mounted++
      }
    }
    if (mounted > 0) success(`Workspace '${label}' enfocado; se montaron ${mounted} fila(s) faltante(s).`)
    else success(`El workspace '${label}' ya tiene todas las filas pedidas (${ws}): enfocado sin duplicar panes ni agentes.`)
    return 0
  } catch (error) {
    if (error instanceof LauncherExit) return error.code
    if (error instanceof CliError) {
      if (error.message.length > 0) deps.err(`${error.message}\n`)
      return error.exitCode
    }
    throw error
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await herdrWorkspace({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
    sleep: (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)),
    platform: process.platform,
  })
}

