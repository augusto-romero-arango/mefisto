// Valida fuentes neutrales publicadas; no consulta ni importa politicas internas.
// Uso: validate-published-artifacts.sh [archivo...]
// Cada rechazo de artefacto imprime "<archivo>: <campo|body>: <motivo>".

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { isEntryPoint } from '../../../scripts/lib/cli.mts'
import {
  JqError,
  add,
  alt,
  dump,
  equals,
  get,
  isObject,
  iterate,
  parseStream,
  unique,
} from '../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../scripts/lib/jq-values.mts'
import { validateSchema } from './lib/published-schema.mts'
import {
  byteCompare,
  chomp,
  closingIndex,
  extractFrontmatter,
  isFile,
  listPublishedSources,
  parseSingleJson,
  relativeToRepo,
  sourceLines,
} from './lib/published-source.mts'

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

export interface ValidationResult {
  status: number
  stdout: string
  stderr: string
}

interface Context {
  repoRoot: string
  schema: Json
  /** Ids delimitados por `|`, con la forma que consulta la validacion del cuerpo. */
  availableSkills: string
  availableCommands: string
}

/** Texto con que `jq -r` imprime un valor. */
function raw(value: Json): string {
  return typeof value === 'string' ? value : dump(value)
}

/** `.<key>` como lo lee jq: `undefined` donde abortaria por indexar algo que no es objeto. */
function field(instance: Json, key: string): Json | undefined {
  try {
    return get(instance, key)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return undefined
  }
}

/** `[.<key>[]?]`, o `null` donde jq abortaria. */
function items(instance: Json, key: string): Json[] | null {
  const value = field(instance, key)
  if (value === undefined) return null
  return typeof value === 'object' && value !== null ? iterate(value) : []
}

/** Texto de `jq -r '.<key> // empty'`. */
function optional(instance: Json, key: string): string {
  const value = alt(field(instance, key) ?? null, null)
  return value === null ? '' : chomp(raw(value))
}

const SPACE = ' \\t\\n\\v\\f\\r'
const METADATA = new RegExp(`(^|[^A-Za-z0-9_-])(model|tools|allowed-tools|permission)[${SPACE}]*:`)
const RUNTIME = new RegExp(
  `claude|\\.claude|marketplace|(^|[/${SPACE}.])cache([/${SPACE}]|$)|${METADATA.source}`,
)
const LEGACY_IDS = new Set([
  'test-writer',
  'reviewer',
  'projection-test-writer',
  'projection-implementer',
  'domain-scaffolder',
  'projections-scaffolder',
  'historiador',
])
const SCAFFOLDER_IDS = new Set([
  'domain-scaffolder',
  'mcp-scaffolder',
  'projections-scaffolder',
  'apim-gateway-scaffolder',
  'workos-identity-scaffolder',
  'infra-base-scaffolder',
])

const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!-]/g

// Variables de shell que cada artefacto puede nombrar en sus bloques de codigo, ademas de $ARGUMENTS.
const PLACEHOLDERS_BY_ID: Record<string, (RegExp | string)[]> = {
  'domain-scaffolder': [
    /^\$(1|2|3|AJENOS|AVISOS|CONCLUSION|FA|HOST|WF|PUBLISH|RUNS|RUN_STATUS|CSPROJ|ESPERA|EVENTO|RUN_CONCLUSION|RUN_EVENTO|RUN_RAMA|RUN_REPO|GITHUB_OUTPUT|INTENTOS|INTRUSOS|JOB_STATUS|PENDIENTES|PR_NUM|REPO|REPO_ROOT|RUN|RUN_ID|SECONDS|SHA|TIMEOUT|archivo|destino|f|i|paquete|presupuesto|proj|temporal|version_esperada)$/,
    '${PR_NUM}',
    '${REPO}',
    '${RUN_SHA}',
    '${TIMEOUT}',
    '${archivo}',
  ],
  'projection-test-writer': ['$PLUGIN_ROOT', '$HOME', '$2'],
  reviewer: ['$PLUGIN_ROOT', '$HOME'],
  'batch-stop': ['$REPO_ROOT'],
  'scaffold-mcp': [/^\$(\{)?(ROOT_NAMESPACE|SOLUTION_FILE|VERSION|PROPOSITO_PASCAL)(\})?$/],
  draft: ['$REPO_SLUG'],
  'eraser-diagram': ['${ERASER_API_TOKEN}'],
  'purge-store': [
    /^\$(0|ATTEMPT_AHORA|ATTEMPT_PREVIO|CONFIG|DOMAIN_EVENTS_DIR|DOMINIO|DOMINIO_FLAT|DOMINIO_KEBAB|ENV|ESTADO|RUN_ID|flat|i)$/,
    '${DOMINIO_KEBAB}',
  ],
  planner: [
    /^\$(SESSION_ID|INITIAL_HEAD_SHA|INITIAL_DEFAULT_BRANCH|INITIAL_STATUS|HARNESS_REPO_SLUG|CLOSING_TIMESTAMP|GLOSSARY_PATH|FIELD_NOTE_LOCAL|GLOSSARY_LOCAL|FIELD_NOTE_GLOSSARY_ARGS)$/,
    '${SESSION_ID}',
  ],
  'tooling-investigator': ['$CONFIG', '$HARNESS_REPO_SLUG'],
  'projections-scaffolder': [
    /^\$(APP|BASE|CSPROJ|ESPERADA|GITHUB_OUTPUT|IMAGEN|INICIO|INTRUSOS|LISTA|LOGIN_SERVER|PLACEHOLDER|PROJ|PROVISION|REPO_ROOT|REV|RUNNING|SEAM|SOURCE_REVISION_ID|SECONDS|ULTIMA|destino|domainEventsCsproj|dominio|i|nombre|seam)$/,
  ],
  'infra-base-scaffolder': [
    /^\$(1|2|3|ALL_SECRETS|APPS|APP_NAME|BRANCH|CONFIG|COUNT|ERR|GITHUB_STEP_SUMMARY|NUGET_AUDIT_GREENFIELD|OUT|ROWS|RUNNER_TEMP|SOLUTION|GITHUB_WORKSPACE|ISSUE_NUM|KEY_VAULT_NAME|NAME|NS|PROJECTIONS_ENABLED|PROVIDERS_TF|PR_NUM|RESOURCE_GROUP|TYPE|VALUE|VALUE_REF|attempt|delay|f|i|id|k|max_attempts|name|p|severity|url|value|version)$/,
    /^\$\{(APP_ID|PR_NUM|TF_VAR_postgresql_admin_password|delay|environment|project_short|topic_name)\}$/,
  ],
  'workos-identity-scaffolder': [/^\$(COMPOSICION|CSPROJ|IDENTITY_DIR|PROGRAM_CS|PROYECTO)$/],
  'apim-gateway-scaffolder': [/^\$(MCP_TF|PROVIDERS_TF|WORKFLOW)$/, '${ENV}', '${origin}'],
  'mcp-scaffolder': [
    /^\$(APP_NAME|BASE|CONFIG|EVENTO|FA_MODULE|FIXTURES|GITHUB_ENV|GITHUB_OUTPUT|PRIMER_DOMINIO_KEBAB|PROJ|PR_NUM|REPO_ROOT|REPO|RESOURCE_GROUP|RUN_CONCLUSION|RUN_EVENTO|RUN_RAMA|RUN_REPO|SECONDS|TENANCY_STRATEGY|VARS|WORKFLOW|azure_region_short|body|code|dominio_kebab|dominio_pascal|dominio_snake|espera|expected_sha|i|key|mcp_id|nombre|presupuesto|proj|proposito_kebab|tiene_region_seq|timeout_peticion|ultimo_cuerpo)$/,
    /^\$\{(APP_NAME|PR_NUM|REPO|RUN_SHA|app_name|azure_region_short|body|code|dominio_kebab|espera|expected_sha|intentos|i|project|proposito_kebab|region_seq_suffix|resource_sequence|startup_logs_url|transcurrido|ultimo_cuerpo)\}$/,
  ],
  historiador: [
    /^\$(0|BRANCH|DIAS_PENDIENTES|FECHA|HISTORIAL|HISTORIAL_CANONICO|f)$/,
    '${FECHA}',
    '${FECHA_MAS_RECIENTE}',
  ],
  'install-apim': [
    /^\$(CONFIG|CONFIG_SCRIPT|CORS_JSON|ESTRATEGIA|HARNESS_CONFIG_PATH|REPO_ROOT|ROOT_NAMESPACE|TENANCY_TOKEN_FLIPPED|TMP|s)$/,
    '${ENV}',
    '${ROOT_NAMESPACE}',
  ],
  onboard: [/^\$(CONFIG|CONFIG_SCRIPT|ESTRATEGIA|HARNESS_CONFIG_PATH|REPO_ROOT|TMP|s)$/],
  'install-auth': [
    '${ENV}',
    '${#CORS_ORIGINS[@]}',
    '$?',
    /^\$(GH_VAR_RC|GH_SECRET_RC|WORKOS_CLIENT_ID|WORKOS_API_KEY_PRESENTE)$/,
  ],
}
const SCAFFOLDER_PLACEHOLDER = /^\$(SCAFFOLD_BASE|HARNESS_REPO_SLUG|HARNESS_VERSION)$/

function allowedPlaceholder(id: string, value: string): boolean {
  if (value === '$ARGUMENTS') return true
  if (SCAFFOLDER_IDS.has(id) && SCAFFOLDER_PLACEHOLDER.test(value)) return true
  const rules = Object.hasOwn(PLACEHOLDERS_BY_ID, id) ? (PLACEHOLDERS_BY_ID[id] ?? []) : []
  return rules.some((rule) => (typeof rule === 'string' ? rule === value : rule.test(value)))
}

const ID = '[a-z0-9]+(-[a-z0-9]+)*'
const DIRECTIVE = /\{\{mefisto:[^}]*\}\}/g
const EXTRA_BRACE = /\{\{mefisto:[^{}]*\}\}\}/
const COMMAND_DOC = new RegExp(`^\\{\\{mefisto:command-doc ${ID}\\}\\}$`)
const SKILL_ROOT = new RegExp(`^\\{\\{mefisto:skill-root ${ID}\\}\\}$`)
const VALID_DIRECTIVES = [
  new RegExp(`^\\{\\{mefisto:command ${ID}\\}\\}$`),
  new RegExp(`^\\{\\{mefisto:launch-agent ${ID}[ ]+[^{} ][^{}]*\\}\\}$`),
  /^\{\{mefisto:run [a-z0-9][a-z0-9._/-]* [^{}]+\}\}$/,
  /^\{\{mefisto:state-path [A-Za-z0-9][A-Za-z0-9._/-]*\}\}$/,
]
const PARENT_SEGMENT = new RegExp(`(^|/)\\.\\.([/${SPACE}]|\\}\\})`)
const ARGUMENT_DIRECTIVE = /^\{\{mefisto:(launch-agent|command|run|state-path) /
const INTERNAL_TARGET = /^\{\{mefisto:(launch-agent|command) mefisto-/
const FREE_DIRECTIVES = new Set([
  '{{mefisto:package-root}}',
  '{{mefisto:config-path}}',
  '{{mefisto:instructions-path}}',
  '{{mefisto:loaded-root}}',
])
const LAUNCH_AGENT = new RegExp(`\\{\\{mefisto:launch-agent (${ID}) +[^{} ]`, 'g')
// Diagnostico de un frontmatter que no trae exactamente un valor JSON.
const NOT_ONE_VALUE = 'jq: invalid JSON text passed to --argjson'
const GUARD = '{{mefisto:assert-consumer-repo}}'
const GUARD_TOKEN = '__MEFISTO_GUARD__'

const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase())

function countOf(text: string, needle: string): number {
  let count = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++
  return count
}

interface Artifact {
  rel: string
  id: string
  kind: string
  /** Skills declarados, delimitados por `|`. */
  declaredSkills: string
}

interface BodyReport {
  violations: string[]
  hasGuard: boolean
}

function mentionsRuntime(id: string, text: string): boolean {
  const lower = asciiLower(text)
  if (LEGACY_IDS.has(id)) {
    const metadata =
      id === 'domain-scaffolder'
        ? lower.replace('azure functions core tools:', 'azure functions core tools')
        : lower
    return METADATA.test(metadata)
  }
  let scanned = lower
  if (id === 'eraser-diagram') scanned = scanned.replace('cache hit', 'hit')
  if (id === 'onboard') {
    scanned = scanned.replace(/claude\.md|adaptador claude|usa claude|with-claude-bridge/g, '')
  }
  if (id === 'bug') scanned = scanned.replace('`.claude/`, ', '')
  return RUNTIME.test(scanned)
}

function directiveViolation(directive: string, artifact: Artifact, context: Context): string[] {
  if (FREE_DIRECTIVES.has(directive)) return []
  const malformed = ` directiva mefisto mal formada: ${directive}`
  if (directive.startsWith('{{mefisto:command-doc ')) {
    if (!COMMAND_DOC.test(directive)) return [malformed]
    const command = directive.slice('{{mefisto:command-doc '.length, -2)
    const found: string[] = []
    if (!context.availableCommands.includes(`|${command}|`)) {
      found.push(` directiva command-doc ${command} no resuelve a src/published/commands/${command}.md`)
    }
    if (artifact.kind === 'command' && command === artifact.id) {
      found.push(` directiva command-doc ${command} referencia al propio comando`)
    }
    return found
  }
  if (directive.startsWith('{{mefisto:skill-root ')) {
    if (!SKILL_ROOT.test(directive) || directive.startsWith('{{mefisto:skill-root mefisto-')) {
      return [malformed]
    }
    const skill = directive.slice('{{mefisto:skill-root '.length, -2)
    const found: string[] = []
    if (!artifact.declaredSkills.includes(`|${skill}|`)) {
      found.push(` directiva skill-root ${skill} no esta declarada en skills`)
    }
    if (!context.availableSkills.includes(`|${skill}|`)) {
      found.push(` directiva skill-root ${skill} no resuelve a skills/${skill}/SKILL.md`)
    }
    return found
  }
  if (ARGUMENT_DIRECTIVE.test(directive)) {
    const valid = VALID_DIRECTIVES.some((pattern) => pattern.test(directive))
    return !valid || PARENT_SEGMENT.test(directive) || INTERNAL_TARGET.test(directive) ? [malformed] : []
  }
  return [` directiva mefisto desconocida: ${directive}`]
}

function validateBody(lines: readonly string[], artifact: Artifact, context: Context): BodyReport {
  const violations: string[] = []
  let guard = false
  const start = closingIndex(lines)
  for (let index = start + 1; start !== -1 && index < lines.length; index++) {
    const text = lines[index] ?? ''
    const at = `${artifact.rel}: body: linea ${index + 1}`
    if (mentionsRuntime(artifact.id, text)) {
      violations.push(`${at} referencia un runtime, CLI, cache, directorio o metadata propia de runtime`)
    }
    for (const [placeholder] of text.matchAll(PLACEHOLDER)) {
      if (!allowedPlaceholder(artifact.id, placeholder)) {
        violations.push(`${at} placeholder no permitido: ${placeholder} (solo se admite $ARGUMENTS)`)
      }
    }
    if (!text.includes('{{mefisto:')) continue
    const directives = [...text.matchAll(DIRECTIVE)].map(([directive]) => directive)
    if (countOf(text, '{{mefisto:') !== directives.length || EXTRA_BRACE.test(text)) {
      violations.push(`${at} directiva mefisto mal formada`)
    }
    for (const directive of directives) {
      if (directive === GUARD) guard = true
      else violations.push(...directiveViolation(directive, artifact, context).map((message) => at + message))
    }
  }
  // Un hallazgo que cite el centinela interno del guard tambien lo da por presente.
  return { violations, hasGuard: guard || violations.some((line) => line.includes(GUARD_TOKEN)) }
}

function launchedAgents(lines: readonly string[]): string[] {
  const start = closingIndex(lines)
  const ids = new Set<string>()
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    for (const match of line.matchAll(LAUNCH_AGENT)) ids.add(match[1] ?? '')
  }
  return [...ids].sort(byteCompare)
}

/** `.mcp // []` del agente publicado en `file`; `[]` si su frontmatter no se puede leer. */
function agentMcp(file: string): Json {
  const frontmatter = extractFrontmatter(sourceLines(readFileSync(file, 'utf8')))
  if (frontmatter.status !== 'ok') return []
  const parsed = parseSingleJson(frontmatter.text)
  if (parsed === null) return []
  return alt(field(parsed.value, 'mcp') ?? [], [])
}

function mcpDelegation(rel: string, instance: Json, delegates: string, repoRoot: string): string[] {
  if (delegates === '') return [`${rel}: mcp: el comando declara MCP pero no delega a un agente neutral`]
  const found: string[] = []
  let declared: Json = []
  let broken = false
  for (const agent of delegates.split(/[ \t\n]+/).filter((name) => name.length > 0)) {
    const file = join(repoRoot, 'src', 'published', 'agents', `${agent}.md`)
    if (!isFile(file)) {
      found.push(`${rel}: mcp: el agente delegado '${agent}' no existe en src/published/agents`)
      continue
    }
    try {
      const sum = add(declared, agentMcp(file))
      if (!Array.isArray(sum)) throw new JqError('la suma de mcp no es un arreglo')
      declared = unique(sum)
    } catch (error) {
      if (!(error instanceof JqError)) throw error
      broken = true
    }
  }
  if (found.length > 0) return found
  const required = alt(field(instance, 'mcp') ?? null, [])
  const covered =
    !broken &&
    Array.isArray(required) &&
    Array.isArray(declared) &&
    required.every((id) => declared.some((candidate: Json) => equals(candidate, id)))
  return covered
    ? []
    : [
        `${rel}: mcp: los agentes delegados '${delegates}' no declaran todos los ids requeridos por el comando`,
      ]
}

function validateFile(file: string, context: Context, out: (line: string) => void): boolean {
  const rel = relativeToRepo(context.repoRoot, file)
  if (!isFile(file)) {
    out(`${rel}: archivo: no existe o no es un archivo regular`)
    return false
  }
  const name = basename(file)
  const nameWithoutExtension = name.endsWith('.md') && name !== '.md' ? name.slice(0, -3) : name
  const lines = sourceLines(readFileSync(file, 'utf8'))
  const frontmatter = extractFrontmatter(lines)
  if (frontmatter.status === 'ausente') {
    out(`${rel}: frontmatter: ausente (se esperaba un bloque '---' JSON al inicio del archivo)`)
    return false
  }
  if (frontmatter.status === 'sin-cierre') {
    out(`${rel}: frontmatter: sin delimitador de cierre`)
    return false
  }
  if (frontmatter.text === '') {
    out(`${rel}: frontmatter: bloque vacio (se esperaba un objeto JSON)`)
    return false
  }
  const parsed = parseStream(frontmatter.text)
  if (!parsed.clean) {
    out(`${rel}: frontmatter: no es JSON valido`)
    return false
  }
  const [instance] = parsed.values
  if (parsed.values.length !== 1 || instance === undefined) {
    out(`${rel}: schema: el validador jq fallo: ${NOT_ONE_VALUE}`)
    return false
  }
  let ok = true
  const report = (line: string): void => {
    out(line)
    ok = false
  }

  let errors: string[]
  try {
    errors = validateSchema(context.schema, instance)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    out(`${rel}: schema: el validador jq fallo: jq: error (at <unknown>): ${error.message}`)
    return false
  }
  for (const error of errors) report(`${rel}: ${error}`)

  const declaredId = isObject(instance) ? instance.id : undefined
  const id = typeof declaredId === 'string' ? chomp(declaredId) : ''
  if (id !== '' && id !== nameWithoutExtension) {
    report(`${rel}: id: '${id}' distinto del nombre de archivo '${nameWithoutExtension}'`)
  }
  const mcp = items(instance, 'mcp')
  if (mcp !== null && unique(mcp).length !== mcp.length) report(`${rel}: mcp: referencias MCP duplicadas`)

  const skills = (items(instance, 'skills') ?? []).flatMap((skill) => raw(skill).split('\n'))
  for (const skill of skills) {
    if (skill !== '' && !isFile(join(context.repoRoot, 'skills', skill, 'SKILL.md'))) {
      report(`${rel}: skills: '${skill}' no resuelve a un Skill publicado real`)
    }
  }

  const artifact: Artifact = {
    rel,
    id,
    kind: optional(instance, 'kind'),
    declaredSkills: `|${skills.map((skill) => `${skill}|`).join('')}`,
  }
  const body = validateBody(lines, artifact, context)
  for (const violation of body.violations) report(violation)
  if (!body.hasGuard) report(`${rel}: body: falta ${GUARD}`)

  const launched = launchedAgents(lines)
  const declaredAgent = optional(instance, 'agent')
  if (launched.length > 0 && declaredAgent !== '') {
    report(
      `${rel}: body: un comando con agent no puede usar launch-agent (delegacion completa y puntual son excluyentes)`,
    )
  }
  for (const agent of launched) {
    if (!isFile(join(context.repoRoot, 'src', 'published', 'agents', `${agent}.md`))) {
      report(`${rel}: body: launch-agent '${agent}' no existe en src/published/agents`)
    }
  }

  const isCommandSource = rel.startsWith('src/published/commands/') && rel.endsWith('.md')
  const kind = field(instance, 'kind')
  if (isCommandSource && kind === 'command' && mcp !== null && mcp.length > 0) {
    const delegates = declaredAgent !== '' ? declaredAgent : launched.join(' ')
    for (const line of mcpDelegation(rel, instance, delegates, context.repoRoot)) report(line)
  }
  return ok
}

function visibleNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

const delimited = (ids: string[]): string => `|${ids.map((id) => `${id}|`).join('')}`

/** Valida `files`, o todas las fuentes publicadas de `repoRoot` si no se pasa ninguno. */
export function validatePublishedArtifacts(
  files: readonly string[],
  repoRoot: string = REPO_ROOT,
): ValidationResult {
  const schemaFile = join(repoRoot, 'src', 'published', 'contract', 'published-artifact.schema.json')
  if (!isFile(schemaFile)) return { status: 1, stdout: '', stderr: `ERROR: no existe '${schemaFile}'\n` }
  const schema = parseSingleJson(readFileSync(schemaFile, 'utf8'))
  const skillsDir = join(repoRoot, 'skills')
  const commandsDir = join(repoRoot, 'src', 'published', 'commands')
  const context: Context = {
    repoRoot,
    schema: schema === null ? null : schema.value,
    availableSkills: delimited(
      visibleNames(skillsDir).filter((name) => isFile(join(skillsDir, name, 'SKILL.md'))),
    ),
    availableCommands: delimited(
      visibleNames(commandsDir)
        .filter((name) => name.endsWith('.md') && isFile(join(commandsDir, name)))
        .map((name) => name.slice(0, -3)),
    ),
  }
  const targets = files.length > 0 ? files : listPublishedSources(repoRoot, false)
  const lines: string[] = []
  let status = 0
  for (const file of targets) {
    if (!validateFile(file, context, (line) => lines.push(line))) status = 1
  }
  return { status, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' }
}

function main(argv: string[]): number {
  const result = validatePublishedArtifacts(argv)
  process.stderr.write(result.stderr)
  process.stdout.write(result.stdout)
  return result.status
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2))
