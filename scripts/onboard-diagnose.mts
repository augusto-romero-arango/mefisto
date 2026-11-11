// onboard-diagnose.mts -- diagnostico de onboarding del consumidor (issue #443).
//
// Reporta, sin tocar nada, el checklist de /onboard: config (con la version minima de Claude
// Code, MEF-ADR-0055, la de Node, MEF-ADR-0057, y la activacion de Mefisto por repositorio,
// MEF-ADR-0053), directivas canonicas en AGENTS.md y su puente CLAUDE.md, estructura de
// carpetas, labels de GitHub, CI hacia Azure, secretos que alimentan la siembra en Key Vault,
// el registro secrets[], la bifurcacion de dos caminos de auth (tenancy.strategy) y el worker de
// proyecciones. Las provisiones opt-in viven en commands/onboard.md e invocan otros scripts bajo
// confirmacion del usuario: este script nunca escribe ni ejecuta ninguno de ellos.
//
// Vive en disco y no incrustado en el comando porque Claude Code expande la sintaxis posicional
// de shell ($1, $*, $@) que encuentra en el texto de un slash command antes de entregarlo.
//
// Uso: onboard-diagnose.mts (cwd = raiz del repo consumidor)
// Sale en 0 si el diagnostico corrio, sin importar cuantos FALTA o NO VERIFICADO reporte (es
// informativo, nunca bloqueante); en 1 solo si el repo es Mefisto o no hay repo git.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkConsumerDirectives as checkDirectives,
  resolveOnboardRuntime as resolveRuntime,
} from './lib/consumer-directives.mts'
import { CliError, capture, commandExists, gitOutput, isEntryPoint, repoRoot } from './lib/cli.mts'
export { contractSectionHasToken, hasContractHeading } from './lib/consumer-directives.mts'
import { loadHarnessConfig, resolveHarnessConfigPath } from './lib/harness-config.mts'
import {
  committedActivation,
  enabledAtUserLevel,
  isDirectory,
  isFile,
  isObject,
  mefistoMarketplace,
  parseJson,
  readJsonFile,
} from './lib/plugin-scopes.mts'
import type { ClaudeConfig, Json, Run } from './lib/plugin-scopes.mts'

export interface OnboardDeps extends ClaudeConfig {
  cwd: string
  /** Carpeta de este script, dentro del paquete instalado. */
  scriptDir: string
  hasCommand: (command: string) => boolean
  /** Corre `gh`, `az`, `claude` y `node`. */
  run: Run
  out: (line: string) => void
}

export const CLAUDE_MIN_VERSION = '2.1.287'
export const NODE_MIN_VERSION = '22.18.0'

const SPACE = '[ \\t\\n\\v\\f\\r]'
const RULE = '===================================================================='

function chomp(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '')
}

function lines(text: string): string[] {
  return chomp(text).split(/\r?\n/)
}

/** Lo que imprime `jq -r '<ruta> // empty'`. */
function rawOrEmpty(value: Json | undefined): string {
  if (value === undefined || value === null || value === false) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** Palabras de una lista separada por espacios, como las reparte `read -ra`. */
function words(list: string): string[] {
  return (list.split('\n')[0] ?? '').split(/[ \t]+/).filter((word) => word.length > 0)
}

/** Checklist del reporte: cuenta cada fila por estado y la imprime con el formato fijo. */
export class Checklist {
  ok = 0
  falta = 0
  nv = 0
  readonly out: (line: string) => void

  constructor(out: (line: string) => void) {
    this.out = out
  }

  /** Un estado distinto de OK, INFO y FALTA cuenta y se imprime como `NO VERIFICADO`. */
  row(state: string, item: string): void {
    let label = state
    if (state === 'OK') this.ok++
    else if (state === 'FALTA') this.falta++
    else if (state !== 'INFO') {
      this.nv++
      label = 'NO VERIFICADO'
    }
    this.out(`  [${label.padEnd(13)}] ${item}`)
  }
}

/**
 * `true` si `name` es la primera columna de alguna linea de la salida de `gh secret list`. Que
 * el texto aparezca en otra columna, o como parte de otro nombre, no cuenta.
 */
export function secretPresent(secretsList: string, name: string): boolean {
  return secretsList.split('\n').some((line) => (line.trim().split(/[ \t]+/)[0] ?? '') === name)
}

function gitIgnores(repo: string, path: string): boolean {
  return capture('git', ['-C', repo, 'check-ignore', '-q', '--', path]).status === 0
}

/**
 * `true` si git ignora `.mefisto/pipeline/` sin ignorar el config vecino: un ignore amplio de
 * `.mefisto/` completo no se acepta.
 */
export function mefistoPipelineIgnored(repo = '.'): boolean {
  return (
    gitIgnores(repo, '.mefisto/pipeline/.onboard-probe') && !gitIgnores(repo, '.mefisto/harness.config.json')
  )
}

/**
 * Runtime activo: MEFISTO_RUNTIME (lo fija la directiva del adaptador) o el unico adaptador
 * disponible. Si no se puede resolver cae en `claude`, que conserva la verificacion estricta.
 */
export function resolveOnboardRuntime(
  deps: Pick<OnboardDeps, 'env' | 'scriptDir' | 'hasCommand'>,
): string {
  return resolveRuntime(deps.env, deps.scriptDir, deps.hasCommand)
}

function firstSemver(raw: string): string | null {
  return /[0-9]+\.[0-9]+\.[0-9]+/.exec(raw)?.[0] ?? null
}

export type VersionCheck = 'cumple' | 'menor' | 'sin-version'

/** Compara el primer semver de `raw` (p. ej. "2.1.287 (Claude Code)") contra `minimum`. */
export function versionMeets(raw: string, minimum: string): VersionCheck {
  const version = firstSemver(raw)
  if (version === null) return 'sin-version'
  const found = version.split('.').map(Number)
  const required = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const [a, b] = [found[i] ?? 0, required[i] ?? 0]
    if (a !== b) return a > b ? 'cumple' : 'menor'
  }
  return 'cumple'
}

export interface Check {
  state: string
  detail: string
}

/**
 * Version minima de Claude Code para el plugin publicado (MEF-ADR-0055): hooks.json lleva la
 * clave "modules". Bajo otro runtime es informativa (MEF-ADR-0050/0053).
 */
export function checkClaudeVersion(runtime: string, versionOutput: string): Check {
  if (runtime !== 'claude') {
    return {
      state: 'INFO',
      detail: `version minima de Claude Code ${CLAUDE_MIN_VERSION}: no aplica bajo el runtime ${runtime}`,
    }
  }
  const version = firstSemver(versionOutput)
  switch (versionMeets(versionOutput, CLAUDE_MIN_VERSION)) {
    case 'cumple':
      return { state: 'OK', detail: `Claude Code ${version} >= ${CLAUDE_MIN_VERSION}` }
    case 'menor':
      return {
        state: 'FALTA',
        detail: `Claude Code ${version} < ${CLAUDE_MIN_VERSION} (los mods de hooks/hooks.json requieren >= ${CLAUDE_MIN_VERSION})`,
      }
    default:
      return {
        state: 'NV',
        detail:
          'no se pudo determinar la version de Claude Code (claude no esta en el PATH o su salida no trae version)',
      }
  }
}

/** Node minimo para los scripts TypeScript del plugin (MEF-ADR-0057 decision 9). */
export function checkNodeVersion(versionOutput: string): Check {
  const version = firstSemver(versionOutput)
  switch (versionMeets(versionOutput, NODE_MIN_VERSION)) {
    case 'cumple':
      return { state: 'OK', detail: `Node ${version} >= ${NODE_MIN_VERSION}` }
    case 'menor':
      return {
        state: 'FALTA',
        detail: `Node ${version} < ${NODE_MIN_VERSION}: los hooks de Mefisto no corren`,
      }
    default:
      return {
        state: 'FALTA',
        detail: 'node no esta en el PATH o su salida no trae version: los hooks de Mefisto no corren',
      }
  }
}

export interface RepoActivation extends Check {
  /** Vacio si Mefisto no se carga ya en todos los repos. */
  userLevelDetail: string
}

/**
 * Mefisto se instala por usuario e inerte y cada consumidor lo activa con su
 * `.claude/settings.json` commiteado (MEF-ADR-0053 decision 2).
 */
export function checkRepoActivation(
  runtime: string,
  top: string,
  pluginRoot: string,
  config: ClaudeConfig,
): RepoActivation {
  if (runtime !== 'claude') {
    return {
      state: 'INFO',
      detail: `activacion por repositorio: sin verificacion para el runtime ${runtime}`,
      userLevelDetail: '',
    }
  }
  const marketplace = mefistoMarketplace(config, pluginRoot)
  const id = `mefisto@${marketplace}`
  const userLevelDetail = enabledAtUserLevel(config, marketplace)
    ? `${id} esta habilitado a nivel usuario: se carga en todos tus repos; /mefisto:upgrade ofrece deshabilitarlo a ese nivel`
    : ''
  if (committedActivation(marketplace, top)) {
    return {
      state: 'OK',
      detail: `.claude/settings.json commiteado habilita ${id} (repo y worktrees)`,
      userLevelDetail,
    }
  }
  return {
    state: 'FALTA',
    detail: `.claude/settings.json commiteado no habilita ${id}: sin el, Mefisto no se carga en este repo cuando esta deshabilitado a nivel usuario`,
    userLevelDetail,
  }
}

export interface AppinsightsEnv extends Check {
  /** Vacio salvo que falte FUNCTIONAPP_NAMES. */
  info: string
}

/** Valor de la ultima linea `KEY=...` de un `.env`, sin comillas; `null` si no hay o esta vacio. */
function envValue(content: string, key: string): string | null {
  const line = content
    .split('\n')
    .filter((candidate) => candidate.startsWith(`${key}=`))
    .at(-1)
  if (line === undefined) return null
  const value = line
    .slice(key.length + 1)
    .replace(/\r$/, '')
    .replace(/^"/, '')
    .replace(/"$/, '')
    .replace(/^'/, '')
    .replace(/'$/, '')
  return value.replaceAll(' ', '').length === 0 ? null : value
}

/**
 * `.mefisto/appinsights.env` lo lee appinsights-query.sh (#1701) y lo requieren /bug (ruta
 * desplegada), /health-check y /purge-store. Se lee linea a linea: nunca se ejecuta.
 */
export function checkAppinsightsEnv(root: string): AppinsightsEnv {
  const file = join(root, '.mefisto', 'appinsights.env')
  if (!isFile(file)) {
    if (isDirectory(join(root, 'infra', 'environments'))) {
      return {
        state: 'FALTA',
        detail: '.mefisto/appinsights.env no existe: /bug, /health-check y /purge-store lo requieren',
        info: '',
      }
    }
    return {
      state: 'NV',
      detail: '.mefisto/appinsights.env no existe todavia (normal en greenfield sin infra/environments/)',
      info: '',
    }
  }
  let content = ''
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    // Ilegible: todas las claves cuentan como ausentes.
  }
  const missing = ['APPINSIGHTS_APP', 'APPINSIGHTS_RG', 'SERVICEBUS_NAMESPACE', 'SERVICEBUS_RG'].filter(
    (key) => envValue(content, key) === null,
  )
  if (missing.length > 0) {
    return {
      state: 'FALTA',
      detail: `.mefisto/appinsights.env incompleto, faltan: ${missing.join(', ')}`,
      info: '',
    }
  }
  return {
    state: 'OK',
    detail:
      '.mefisto/appinsights.env declara APPINSIGHTS_APP, APPINSIGHTS_RG, SERVICEBUS_NAMESPACE y SERVICEBUS_RG',
    info:
      envValue(content, 'FUNCTIONAPP_NAMES') === null
        ? 'FUNCTIONAPP_NAMES ausente o vacio en .mefisto/appinsights.env: appinsights-query.sh function-errors no funcionara (normal antes del primer /scaffold)'
        : '',
  }
}

export interface ConsumerDirectives {
  agents: Check
  bridge: Check
  bridgeHasImport: boolean
  bridgeHasLegacy: boolean
}

/**
 * Contrato de directivas: AGENTS.md canonico y puente CLAUDE.md. El puente solo es requerido
 * bajo el runtime `claude`; con cualquier otro es informativo (MEF-ADR-0050/0053).
 */
export function checkConsumerDirectives(
  agentsMd: string,
  claudeMd: string,
  runtime = 'claude',
): ConsumerDirectives {
  const check = checkDirectives(agentsMd, claudeMd, runtime)
  return {
    agents: { state: check.agentsState, detail: check.agentsDetail },
    bridge: { state: check.bridgeState, detail: check.bridgeDetail },
    bridgeHasImport: check.bridgeHasImport,
    bridgeHasLegacy: check.bridgeHasLegacy,
  }
}

/**
 * owner/repo del remoto `origin` (HTTPS, SSH scp-like o ssh://, con o sin .git). Vacio si no hay
 * origin o no se puede derivar. Sin red.
 */
export function consumerOriginSlug(cwd: string): string {
  const url = gitOutput(['remote', 'get-url', 'origin'], cwd)
  if (url === null) return ''
  const trimmed = url.replace(/\/$/, '').replace(/\.git$/, '')
  const slug = /^.*[:/]([^/:]+\/[^/:]+)$/.exec(trimmed)?.[1] ?? trimmed
  return /^[^/]+\/[^/]+$/.test(slug) ? slug : ''
}

/** Lo que el diagnostico usa del config, con el formato de las variables HARNESS_* de bash. */
interface HarnessVars {
  valid: boolean
  configPath: string
  /** Lineas que explican por que el config no cargo. */
  errors: string[]
  bcName: string
  bcDomains: string
  tfstateStorage: string
  domainLabels: string
  spName: string
  sbExternalAliases: string
  secretsNames: string
  secretsTypes: string
  secretsValues: string
  projectionsEnabled: boolean
  namespacePrefix: string
}

function joinedLabels(value: Json | undefined): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    if (item !== null && typeof item === 'object') return ''
    parts.push(item === null ? '' : String(item))
  }
  return parts.join(' ')
}

function loadHarnessVars(cwd: string): HarnessVars {
  const vars: HarnessVars = {
    valid: false,
    configPath: '',
    errors: [],
    bcName: '',
    bcDomains: '',
    tfstateStorage: '',
    domainLabels: '',
    spName: '',
    sbExternalAliases: '',
    secretsNames: '',
    secretsTypes: '',
    secretsValues: '',
    projectionsEnabled: false,
    namespacePrefix: '',
  }
  const warnings: string[] = []
  try {
    const config = loadHarnessConfig(undefined, { cwd, warn: (message) => warnings.push(message) })
    return {
      valid: true,
      configPath: config.configPath,
      errors: [],
      bcName: config.bcName,
      bcDomains: config.bcDomains.join(' '),
      tfstateStorage: config.tfstateStorage,
      domainLabels: config.domainLabels.join(' '),
      spName: config.spName,
      sbExternalAliases: config.sbExternal.map((entry) => entry.alias).join(' '),
      secretsNames: config.secrets.map((entry) => entry.name).join(' '),
      secretsTypes: config.secrets.map((entry) => entry.type).join(' '),
      secretsValues: config.secrets.map((entry) => entry.value).join(' '),
      projectionsEnabled: config.projectionsEnabled,
      namespacePrefix: config.namespacePrefix,
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    vars.errors = [...warnings, ...error.message.split('\n')]
  }
  // Un config que parsea pero no valida aun alimenta las secciones de labels y de CI.
  try {
    const root = readJsonFile(resolveHarnessConfigPath('read', undefined, { cwd }))
    if (isObject(root)) {
      vars.domainLabels = joinedLabels(root.domainLabels)
      vars.spName = chomp(rawOrEmpty(root.githubServicePrincipalName))
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error
  }
  return vars
}

const SLUG_ACTION = (config: string): string =>
  `  - Corrige repoSlug en ${config} con el slug owner/repo del fork de Mefisto, o borralo para usar el default augusto-romero-arango/mefisto.\n`

/**
 * Valida el repoSlug efectivo (el del config o el default): atajo local contra el origin del
 * consumidor y, si no coincide, verificacion via gh de que `.claude-plugin/plugin.json` del repo
 * tenga name == mefisto. Devuelve la accion sugerida, o vacio.
 */
function checkRepoSlug(config: string, list: Checklist, deps: OnboardDeps): string {
  const root = readJsonFile(config)
  let slug = isObject(root) ? chomp(rawOrEmpty(root.repoSlug)) : ''
  let origin = 'declarado en el config'
  if (slug.length === 0) {
    slug = 'augusto-romero-arango/mefisto'
    origin = 'default, el config no declara repoSlug'
  }

  const originSlug = consumerOriginSlug(deps.cwd)
  if (originSlug.length > 0 && originSlug.toLowerCase() === slug.toLowerCase()) {
    list.row(
      'FALTA',
      `repoSlug '${slug}' apunta al propio consumidor: los drafts cross-repo irian a este repo (${origin})`,
    )
    return SLUG_ACTION(config)
  }

  if (!deps.hasCommand('gh')) {
    list.row('NV', `repoSlug '${slug}' (${origin}) no verificado: gh no esta instalado`)
    return ''
  }
  const result = deps.run('gh', [
    'api',
    `repos/${slug}/contents/.claude-plugin/plugin.json`,
    '-H',
    'Accept: application/vnd.github.raw+json',
  ])
  if (result.status !== 0) {
    if (/404|not found/i.test(result.stderr)) {
      list.row(
        'FALTA',
        `repoSlug '${slug}' (${origin}) no apunta a un repo de Mefisto: el repo no existe o no tiene .claude-plugin/plugin.json`,
      )
      return SLUG_ACTION(config)
    }
    const reason = result.stderr.split('\n').find((line) => !new RegExp(`^${SPACE}*$`).test(line)) ?? ''
    list.row(
      'NV',
      `repoSlug '${slug}' (${origin}) no verificado: gh no pudo consultar el repo (${reason.replaceAll('\r', '') || 'sin detalle'}); revisa 'gh auth status' y la red`,
    )
    return ''
  }
  const manifest = parseJson(result.stdout)
  const name = isObject(manifest) ? chomp(rawOrEmpty(manifest.name)) : ''
  if (name === 'mefisto') {
    list.row('OK', `repoSlug '${slug}' apunta a un repo de Mefisto (${origin})`)
    return ''
  }
  list.row(
    'FALTA',
    `repoSlug '${slug}' (${origin}) no apunta a un repo de Mefisto: plugin.json tiene name '${name || '<ilegible>'}', distinto de 'mefisto'`,
  )
  return SLUG_ACTION(config)
}

function versionOutput(deps: OnboardDeps, command: string): string {
  if (!deps.hasCommand(command)) return ''
  const result = deps.run(command, ['--version'])
  return result.status === 0 ? result.stdout : ''
}

export function onboardDiagnose(deps: OnboardDeps): number {
  const { out } = deps
  const list = new Checklist(out)
  const pluginRoot = join(deps.scriptDir, '..')
  const script = (name: string): string => join(deps.scriptDir, name)
  let actions = ''
  let directiveActions = ''
  // Lo que cada seccion deja anotado para el cierre "Proximos pasos", sin volver a diagnosticar.
  const next = {
    configFalta: false,
    agentsFalta: false,
    agentsNv: false,
    claudeImportFalta: false,
    claudeLegacyDuplicated: false,
    claudeNv: false,
    claudeOptional: false,
    claudeLegacyInfo: false,
    repoActivationFalta: false,
    labelsFalta: false,
    ciFalta: false,
    infraBaseMissing: false,
    authPath: false,
    projectionsMissing: false,
    appinsightsEnvFalta: false,
  }

  const top = repoRoot(deps.cwd)
  if (top === null) {
    out('ERROR: no estas en un repositorio git')
    return 1
  }
  if (isFile(join(top, '.claude-plugin', 'plugin.json'))) {
    // La primera linea es la que /onboard le pide al modelo reconocer.
    out('ERROR: /onboard no aplica al repo de Mefisto.')
    out('       scripts/onboard-diagnose.sh es del plugin publicado y solo aplica al consumidor.')
    return 1
  }

  out(RULE)
  out('  /onboard - diagnostico del harness (solo lectura)')
  out(RULE)
  out('')

  out('Configuracion (harness.config.json efectivo):')
  const vars = loadHarnessVars(deps.cwd)
  const config = vars.configPath
  if (vars.valid) {
    list.row('OK', `config efectivo ${config} existe y parsea con jq`)
    list.row('OK', 'campos requeridos presentes (projectName, namespacePrefix, solutionFile)')
    list.row('OK', `boundedContext declarado: name='${vars.bcName}' domains='${vars.bcDomains}'`)
    if (vars.tfstateStorage.length > 0) {
      list.row('OK', `terraformStateStorage valido: ${vars.tfstateStorage}`)
    } else {
      list.row('OK', 'terraformStateStorage vacio (consumidor sin IaC; valido)')
    }
    actions += checkRepoSlug(config, list, deps)
  } else {
    list.row('FALTA', 'configuracion invalida o incompleta')
    next.configFalta = true
    for (const line of vars.errors) {
      if (line.length > 0) out(`                  ${line}`)
    }
    actions +=
      '  - Corrige el config canonico .mefisto/harness.config.json (o el fallback legacy efectivo que muestra el error) segun el detalle de arriba (README, seccion "Configurar el consumidor").\n'
  }

  out('')
  out(`Version de Claude Code (minima ${CLAUDE_MIN_VERSION}):`)
  const runtime = resolveOnboardRuntime(deps)
  const claudeVersion = checkClaudeVersion(runtime, runtime === 'claude' ? versionOutput(deps, 'claude') : '')
  list.row(claudeVersion.state, claudeVersion.detail)
  if (claudeVersion.state === 'FALTA') {
    actions += `  - Actualiza Claude Code a ${CLAUDE_MIN_VERSION} o superior (\`claude update\`).\n`
  }

  out('')
  out(`Version de Node (minima ${NODE_MIN_VERSION}):`)
  const nodeVersion = checkNodeVersion(versionOutput(deps, 'node'))
  list.row(nodeVersion.state, nodeVersion.detail)
  if (nodeVersion.state === 'FALTA') {
    actions += `  - Instala Node ${NODE_MIN_VERSION} o superior (https://nodejs.org/en/download): los hooks de Mefisto lo requieren.\n`
  }

  out('')
  out('Activacion de Mefisto (por repositorio):')
  const activation = checkRepoActivation(runtime, top, pluginRoot, deps)
  list.row(activation.state, activation.detail)
  if (activation.userLevelDetail.length > 0) list.row('INFO', activation.userLevelDetail)
  if (activation.state === 'FALTA') {
    next.repoActivationFalta = true
    actions += `  - Habilita Mefisto en este repo: "${script('onboard-activate-repo.sh')}" --apply (o confirma el paso opt-in) y commitea los archivos que escribe.\n`
  }

  out('')
  out('Directivas del consumidor (AGENTS.md canónico y puente CLAUDE.md):')
  const claudeMd = join(deps.cwd, 'CLAUDE.md')
  const directives = checkConsumerDirectives(join(deps.cwd, 'AGENTS.md'), claudeMd, runtime)
  const legacyAction =
    '  - Limpia manualmente de CLAUDE.md las secciones contractuales legacy "Tokens del harness" y/o "Verificación de fuentes" que aún conserve; el diagnóstico no copia, borra ni reescribe doctrina.\n'
  list.row(directives.agents.state, directives.agents.detail)
  if (directives.agents.state === 'FALTA') {
    next.agentsFalta = true
    directiveActions +=
      '  - Completa primero AGENTS.md: debe contener "Tokens del harness", "Verificación de fuentes" y los 5 tokens obligatorios dentro de la sección de tokens. Es la fuente canónica para todos los runtimes.\n'
  } else if (directives.agents.state === 'NV') {
    next.agentsNv = true
    directiveActions +=
      '  - Restaura permiso de lectura sobre AGENTS.md y vuelve a ejecutar /onboard para verificar la fuente canónica.\n'
  }
  list.row(directives.bridge.state, directives.bridge.detail)
  if (runtime !== 'claude') {
    if (!existsSync(claudeMd) || !directives.bridgeHasImport) next.claudeOptional = true
    if (directives.bridgeHasLegacy) {
      next.claudeLegacyInfo = true
      directiveActions += legacyAction
    }
  } else if (directives.bridge.state === 'NV') {
    next.claudeNv = true
    directiveActions +=
      '  - Restaura permiso de lectura sobre CLAUDE.md y vuelve a ejecutar /onboard para verificar el puente @AGENTS.md.\n'
  } else {
    if (!directives.bridgeHasImport) {
      next.claudeImportFalta = true
      directiveActions +=
        '  - Deja CLAUDE.md como puente hacia AGENTS.md con una linea independiente @AGENTS.md.\n'
    }
    if (directives.bridgeHasLegacy) {
      next.claudeLegacyDuplicated = true
      directiveActions += legacyAction
    }
  }

  out('')
  out('Estructura de carpetas esperada (informativo, no bloqueante):')
  for (const dir of ['src', 'tests', 'infra/environments']) {
    if (isDirectory(join(deps.cwd, ...dir.split('/')))) {
      list.row('OK', `${dir}/ existe`)
    } else {
      list.row(
        'NV',
        `${dir}/ no existe todavia (normal en greenfield antes del primer /scaffold o /infra-base; no bloqueante)`,
      )
      if (dir === 'infra/environments') next.infraBaseMissing = true
    }
  }

  out('')
  out('Estado operativo de Mefisto (MEF-ADR-0053):')
  if (mefistoPipelineIgnored(top)) {
    list.row('OK', '.mefisto/pipeline/ esta excluido por .gitignore')
  } else {
    list.row('FALTA', '.mefisto/pipeline/ no esta excluido por .gitignore')
    // Comportamiento heredado: el `\n` sale literal y la accion siguiente queda en la misma linea.
    actions +=
      "  - Agrega exactamente '.mefisto/pipeline/' a .gitignore. No ignores '.mefisto/' completo: .mefisto/harness.config.json debe versionarse.\\n"
  }
  const appinsights = checkAppinsightsEnv(top)
  if (appinsights.state === 'OK') {
    list.row('OK', appinsights.detail)
    if (appinsights.info.length > 0) list.row('INFO', appinsights.info)
  } else if (appinsights.state === 'FALTA') {
    list.row('FALTA', appinsights.detail)
    // Comportamiento heredado: esta falta no agrega accion sugerida; el paso sale en el cierre.
    next.appinsightsEnvFalta = true
  } else {
    list.row('NV', appinsights.detail)
  }

  out('')
  out('Labels de GitHub (esquema del harness - MEF-ADR-0007):')
  const labels = deps.run('gh', ['label', 'list', '--json', 'name', '-q', '.[].name'])
  if (labels.status !== 0) {
    list.row('NV', 'no se pudieron listar los labels (gh no autenticado / sin repo / version antigua)')
    actions += '  - Autentica gh ("gh auth login") y reintenta para diagnosticar los labels.\n'
  } else {
    const existing = lines(labels.stdout)
    let missing = ''
    for (const label of [
      'tipo:feature',
      'tipo:infra',
      'tipo:refactor',
      'tipo:tooling',
      'tipo:projection',
      'estado:borrador',
      'estado:listo',
      'bug',
      'bloqueado',
      'warning',
    ]) {
      if (!existing.includes(label)) missing += ` ${label}`
    }
    for (const domain of vars.domainLabels.split(/\s+/).filter((label) => label.length > 0)) {
      if (!existing.includes(`dom:${domain}`)) missing += ` dom:${domain}`
    }
    if (missing.length === 0) {
      list.row('OK', 'esquema completo (tipo:*, estado:*, dom:*, bug, bloqueado, warning)')
    } else {
      list.row('FALTA', `faltan labels:${missing}`)
      next.labelsFalta = true
      actions += `  - Faltan labels del esquema. /onboard puede crearlos en el paso de provision opt-in (te lo ofrece tras el diagnostico, bajo confirmacion: el script borra los labels default de GitHub y recrea el esquema). O ejecutalo tu mismo: "${script('setup-github-labels.sh')}".\n`
    }
    if (vars.domainLabels.length === 0) {
      out('                  (dom:* no verificado - domainLabels vacio o config no cargada)')
    }
  }

  out('')
  out('CI hacia Azure (OIDC / Service Principal - MEF-ADR-0022):')
  if (!deps.hasCommand('az')) {
    list.row('NV', 'Service Principal de CI (Azure CLI no instalado)')
    actions += '  - Instala Azure CLI y ejecuta "az login" para verificar el Service Principal del CI.\n'
  } else if (deps.run('az', ['account', 'show']).status !== 0) {
    list.row('NV', 'Service Principal de CI (sin sesion de Azure)')
    actions += '  - Ejecuta "az login" para que /onboard pueda verificar el Service Principal del CI.\n'
  } else if (vars.spName.length === 0) {
    list.row('NV', 'Service Principal de CI (githubServicePrincipalName ausente en el config)')
  } else {
    const appId = chomp(
      deps.run('az', ['ad', 'app', 'list', '--display-name', vars.spName, '--query', '[0].appId', '-o', 'tsv'])
        .stdout,
    )
    if (appId.length > 0 && appId !== 'None') {
      list.row('OK', `aplicacion de Entra "${vars.spName}" existe`)
    } else {
      list.row('FALTA', `aplicacion de Entra "${vars.spName}" no encontrada`)
      next.ciFalta = true
      actions += `  - Falta la app de Entra del CI. /onboard puede configurarlo en el paso de provision opt-in (te lo ofrece tras el diagnostico, bajo confirmacion: crea recursos reales en Azure -- app de Entra, role assignments y federated credential OIDC, MEF-ADR-0022 -- y debe correr DESPUES de bootstrap-backend.sh). O ejecutalo tu mismo: "${script('setup-github-ci.sh')} <subscription-id>".\n`
    }
  }

  // Lectura tolerante: listar los secrets requiere permisos de admin del repo.
  const secretsResult = deps.run('gh', ['secret', 'list'])
  const secretsListed = secretsResult.status === 0
  const secrets = chomp(secretsResult.stdout)
  if (!secretsListed) {
    list.row('NV', 'secrets OIDC en GitHub (no se pudieron listar; requiere permisos de admin del repo)')
  } else {
    let missing = ''
    for (const secret of ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID']) {
      if (!secretPresent(secrets, secret)) missing += ` ${secret}`
    }
    if (missing.length === 0) {
      list.row('OK', 'secrets OIDC presentes (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID)')
    } else {
      list.row('FALTA', `faltan secrets OIDC:${missing}`)
      next.ciFalta = true
      actions += `  - Copia los tres secrets OIDC (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID) que imprime "${script('setup-github-ci.sh')} <subscription-id>" a Settings > Secrets and variables > Actions. El script (y el paso de provision opt-in de /onboard) NO los sube: pegalos a mano. No hay client secret que expire (OIDC, MEF-ADR-0022).\n`
    }
  }

  out('')
  out('Secretos que alimentan la siembra en Key Vault (MEF-ADR-0025 -- la siembra la hace CI tras el apply):')
  if (!secretsListed) {
    list.row('NV', 'no se pudieron listar los secrets (mismo motivo que la seccion anterior)')
  } else {
    if (secretPresent(secrets, 'TF_VAR_POSTGRESQL_ADMIN_PASSWORD')) {
      list.row(
        'OK',
        'TF_VAR_POSTGRESQL_ADMIN_PASSWORD presente (alimenta marten-connection, MEF-ADR-0025 decision #9)',
      )
    } else {
      list.row(
        'NV',
        'TF_VAR_POSTGRESQL_ADMIN_PASSWORD no encontrado (crealo cuando provisiones Postgres -- MEF-ADR-0025 decision #9)',
      )
    }
    for (const alias of vars.sbExternalAliases.split(/\s+/).filter((word) => word.length > 0)) {
      const secret = `SB_EXTERNAL_${alias}_CONNECTION_STRING`
      if (secretPresent(secrets, secret)) {
        list.row('OK', `${secret} presente`)
      } else {
        list.row(
          'NV',
          `${secret} no encontrado (uno por alias de serviceBus.external[] -- MEF-ADR-0025 decision #10)`,
        )
      }
    }
  }

  const root = vars.valid ? readJsonFile(config) : undefined

  out('')
  out('Registro harness.config.json > secrets[] (siembra data-driven -- MEF-ADR-0025, issue #256):')
  if (vars.valid && isObject(root) && Object.hasOwn(root, 'secrets')) {
    const names = words(vars.secretsNames)
    const types = words(vars.secretsTypes)
    const values = words(vars.secretsValues)
    list.row('OK', `secrets[] registra ${names.length} entrada(s)`)
    if (!secretsListed) {
      list.row(
        'NV',
        'no se pudo verificar la existencia de los GitHub secrets que referencian (mismo motivo que la seccion CI)',
      )
    } else {
      names.forEach((name, index) => {
        if (types[index] !== 'github-secret') return
        const value = values[index] ?? ''
        if (secretPresent(secrets, value)) {
          list.row('OK', `secrets[].name='${name}': GitHub secret '${value}' presente`)
        } else {
          list.row(
            'NV',
            `secrets[].name='${name}': GitHub secret '${value}' no encontrado (crealo antes del proximo apply que lo siembre)`,
          )
        }
      })
    }
  } else if (vars.valid) {
    list.row('NV', 'secrets[] no declarado todavia (normal antes del primer /infra-base)')
  } else {
    list.row(
      'NV',
      'secrets[] no verificado porque el config efectivo no pudo cargarse (revisa la seccion Configuracion)',
    )
  }

  out('')
  out('Bifurcacion de dos caminos de auth -- (A) crecer / (B) POC (tenancy.strategy, MEF-ADR-0028):')
  if (vars.valid) {
    const tenancy = isObject(root) ? root.tenancy : undefined
    const strategy = isObject(tenancy) ? chomp(rawOrEmpty(tenancy.strategy)) : ''
    if (strategy.length === 0) {
      list.row(
        'NV',
        'tenancy.strategy ausente -- camino (B) POC por defecto (etapa a, mono-tenant-transitorio, valido, no bloqueante)',
      )
    } else if (strategy === 'mono-tenant-transitorio') {
      list.row('OK', 'tenancy.strategy = mono-tenant-transitorio -- camino (B) POC: sin autenticacion (etapa a)')
    } else if (strategy === 'multi-tenant-header') {
      list.row(
        'OK',
        'tenancy.strategy = multi-tenant-header -- camino (A) crecer: autenticacion orquestada desde el inicio (etapa b)',
      )
      next.authPath = true
    } else {
      list.row(
        'NV',
        `tenancy.strategy tiene un valor no reconocido: '${strategy}' (esperado mono-tenant-transitorio | multi-tenant-header)`,
      )
    }
  } else {
    list.row(
      'NV',
      'tenancy.strategy no verificado porque el config efectivo no pudo cargarse (revisa la seccion Configuracion)',
    )
  }

  out('')
  out('Worker de proyecciones (projections.enabled, MEF-ADR-0034):')
  const prefix = vars.namespacePrefix
  if (!vars.valid) {
    list.row(
      'NV',
      'projections.enabled no verificado porque el config efectivo no pudo cargarse (revisa la seccion Configuracion)',
    )
  } else if (prefix.length === 0) {
    list.row(
      'NV',
      "projections.enabled no verificado: falta 'namespacePrefix' para derivar la ruta del worker (revisa la seccion Configuracion)",
    )
  } else {
    const projections = isObject(root) ? root.projections : undefined
    const declared = isObject(projections) && Object.hasOwn(projections, 'enabled')
    const enabled = declared ? projections.enabled : undefined
    if (enabled === false || enabled === 'false') {
      list.row('OK', 'projections.enabled=false -- opt-out explicito de proyecciones (valido)')
    } else if (enabled === undefined || enabled === null || enabled === 'null') {
      list.row('NV', 'projections.enabled ausente -- BC no declara proyecciones (opt-in, valido, no bloqueante)')
    } else if (!vars.projectionsEnabled) {
      list.row(
        'NV',
        'projections.enabled no es el booleano true ni false (opt-in no verificable, valido, no bloqueante)',
      )
    } else if (isFile(join(deps.cwd, 'src', `${prefix}.Projections`, `${prefix}.Projections.csproj`))) {
      list.row('OK', `projections.enabled=true -- worker ${prefix}.Projections presente`)
    } else {
      list.row(
        'NV',
        `projections.enabled=true, pero el worker ${prefix}.Projections no existe todavia (corre /scaffold-projections)`,
      )
      next.projectionsMissing = true
    }
  }

  out('')
  if (directiveActions.length + actions.length > 0) {
    out(
      'Acciones sugeridas (el diagnostico no ejecuta ninguna; los labels faltantes y el CI los pueden provisionar los pasos opt-in, bajo tu confirmacion):',
    )
    out(directiveActions + actions)
  }
  out(RULE)
  out(`  Resumen: ${list.ok} OK | ${list.falta} FALTA | ${list.nv} NO VERIFICADO`)
  if (list.falta === 0 && list.nv === 0) {
    out('  Estado: LISTO - el harness esta configurado.')
  } else if (list.falta === 0) {
    out('  Estado: LISTO con salvedades - revisa los NO VERIFICADO.')
  } else {
    out('  Estado: INCOMPLETO - resuelve los FALTA antes de usar los pipelines.')
  }
  out(RULE)
  out('')
  out('Proximos pasos (informativo -- no ejecuta nada; los comandos abajo son los que tu corres o confirmas):')
  let steps = 0
  const step = (first: string, ...rest: string[]): void => {
    steps++
    out(`  ${steps}. ${first}`)
    for (const line of rest) out(`     ${line}`)
  }
  if (next.agentsNv) {
    step('Restaura permiso de lectura sobre AGENTS.md y repite /onboard para verificar la fuente canónica.')
  }
  if (next.claudeNv) {
    step('Restaura permiso de lectura sobre CLAUDE.md y repite /onboard para verificar el puente @AGENTS.md.')
  }
  if (next.claudeLegacyInfo) {
    step('Limpia manualmente de CLAUDE.md las secciones contractuales legacy duplicadas (detalle arriba).')
  }
  if (next.claudeOptional) {
    step(
      'Opcional: el puente CLAUDE.md -> @AGENTS.md solo lo requiere Claude Code; si tu equipo tambien lo usa, crealo.',
    )
  }
  const infraBaseStep = (): void => step('Genera la infraestructura base: /mefisto:infra-base dev')
  const projectionsStep = (): void =>
    step(
      'El BC declara projections.enabled=true pero el worker de proyecciones no existe:',
      'corre /scaffold-projections para generarlo (MEF-ADR-0034), o confirma el paso opt-in que',
      'te ofrece este mismo /onboard.',
    )
  if (list.falta === 0) {
    if (next.infraBaseMissing) {
      infraBaseStep()
    } else {
      step(
        'El harness esta configurado: arranca (o continua) el dominio con /mefisto:scaffold <dominio>,',
        'luego /mefisto:draft y /mefisto:implement para tu primer ciclo TDD.',
      )
      step(
        'Recordatorio recurrente: la siembra de secretos en Key Vault la hace CI (infra-cd.yml),',
        'iterando harness.config.json > secrets[] -- MEF-ADR-0025, issue #256. Tu unica accion manual',
        'es crear/verificar los GitHub secrets que alimentan cada entrada github-secret',
        '(TF_VAR_POSTGRESQL_ADMIN_PASSWORD, un SB_EXTERNAL_<ALIAS>_CONNECTION_STRING por alias, o el',
        'que declares con /seed-secret) en Settings > Secrets and variables > Actions.',
      )
    }
    if (next.authPath) {
      step(
        'Camino auth elegido (tenancy.strategy = multi-tenant-header, MEF-ADR-0028): tras',
        '/mefisto:infra-base y /mefisto:scaffold <dominio>, corre /install-auth para instalar WorkOS+APIM',
        '(MEF-ADR-0032): encadena /install-workos y /install-apim con el gate humano en medio.',
      )
    }
    if (next.projectionsMissing) projectionsStep()
  } else {
    if (next.repoActivationFalta) {
      step(
        `Habilita Mefisto en este repo: "${script('onboard-activate-repo.sh')}" --apply`,
        '(o confirma el paso opt-in) y commitea los archivos que escribe.',
      )
    }
    if (next.agentsFalta) {
      step(
        'Completa AGENTS.md como fuente canónica: las secciones "Tokens del harness" y "Verificación de fuentes" (detalle arriba).',
      )
    }
    if (next.claudeImportFalta) {
      step('Deja CLAUDE.md como puente hacia AGENTS.md con una linea independiente @AGENTS.md.')
    }
    if (next.claudeLegacyDuplicated) {
      step('Limpia manualmente de CLAUDE.md las secciones contractuales legacy duplicadas (detalle arriba).')
    }
    if (next.appinsightsEnvFalta) {
      step(
        'Crea .mefisto/appinsights.env con las cinco claves (solo nombres, sin secretos): APPINSIGHTS_APP,',
        'APPINSIGHTS_RG, SERVICEBUS_NAMESPACE, SERVICEBUS_RG y FUNCTIONAPP_NAMES (coma). /bug, /health-check y /purge-store lo requieren.',
        'Provision opt-in desde /onboard (paso "Provision opt-in de .mefisto/appinsights.env"): descubre los nombres con az.',
      )
    }
    if (next.configFalta) {
      step('Corrige el config efectivo indicado arriba (canonico .mefisto/harness.config.json o fallback legacy).')
    }
    if (next.labelsFalta) {
      step(
        `Provisiona los labels de GitHub: "${script('setup-github-labels.sh')}"`,
        '(o confirma el paso opt-in que te ofrece este mismo /onboard).',
      )
    }
    if (next.ciFalta) {
      step(
        `Configura el CI hacia Azure: "${script('setup-github-ci.sh')} <subscription-id>"`,
        '(o confirma el paso opt-in). Corre DESPUES de "bootstrap-backend.sh" (MEF-ADR-0022).',
      )
    }
    if (next.infraBaseMissing) infraBaseStep()
    if (next.authPath) {
      step(
        'Camino auth elegido (tenancy.strategy = multi-tenant-header, MEF-ADR-0028): una vez',
        'resueltos los FALTA de arriba, con infra base y al menos un dominio scaffoldeado, corre',
        '/install-auth para instalar WorkOS+APIM (MEF-ADR-0032): encadena /install-workos y',
        '/install-apim con el gate humano en medio.',
      )
    }
    if (next.projectionsMissing) projectionsStep()
    if (steps === 0) {
      out('  Resuelve primero los "NO VERIFICADO" de arriba (instala/autentica lo que falte) para que')
      out('  /onboard pueda indicarte el siguiente comando exacto.')
    }
  }
  out('')
  let quickstart = 'https://github.com/augusto-romero-arango/mefisto/blob/main/docs/greenfield-quickstart.md'
  const manifest = readJsonFile(join(pluginRoot, '.claude-plugin', 'plugin.json'))
  const homepage = isObject(manifest) ? chomp(rawOrEmpty(manifest.homepage)) : ''
  if (homepage.length > 0) quickstart = `${homepage.replace(/\/$/, '')}/blob/main/docs/greenfield-quickstart.md`
  out('Guia narrativa completa del arranque greenfield (10 pasos, roles admin/infra vs dev ongoing):')
  out(`  ${quickstart}`)
  out(RULE)
  return 0
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = onboardDiagnose({
    cwd: process.cwd(),
    env: process.env,
    home: homedir(),
    scriptDir: dirname(fileURLToPath(import.meta.url)),
    hasCommand: commandExists,
    run: (command, args) => capture(command, args),
    out: (line) => console.log(line),
  })
}
