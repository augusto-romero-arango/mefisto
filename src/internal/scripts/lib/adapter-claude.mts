// Traduce un artefacto neutral (frontmatter JSON + body, ver src/internal/contract/README.md)
// al formato de Claude Code: frontmatter YAML en bloque con escalares entre comillas JSON.
// Nada de aqui escribe en disco.

import { jqJson, jqRaw } from './jq-json.mts'
import type { Json, JsonObject } from './jq-json.mts'

/** Motivo ya redactado por el que un artefacto no se puede traducir. */
export class AdapterError extends Error {}

// Gemelas de `runtime_claude_default_model` y `runtime_claude_default_effort` de
// src/runtime/lib/runtime-claude.sh. Tabla fija y no .mefisto/models.json, que es estado de
// maquina y volveria no determinista una salida versionada.
const DEFAULT_MODELS = new Map([
  ['fast', 'haiku'],
  ['balanced', 'sonnet'],
  ['deep', 'opus'],
])
const DEFAULT_EFFORTS = new Map([
  ['quick', 'low'],
  ['light', 'medium'],
  ['standard', 'high'],
  ['thorough', 'xhigh'],
  ['exhaustive', 'max'],
])

/** Modelo nativo de un perfil, o '' si el perfil no tiene uno. */
export function claudeDefaultModel(profile: string): string {
  return DEFAULT_MODELS.get(profile) ?? ''
}

/** Nivel nativo de un effort neutral, o `null` si no tiene traduccion. */
export function claudeDefaultEffort(effort: string): string | null {
  return DEFAULT_EFFORTS.get(effort) ?? null
}

// `mcp` no tiene mapeo todavia: declararla aborta la generacion.
const CAPABILITY_TOOLS = new Map([
  ['read', 'Read, Glob, Grep'],
  ['edit', 'Edit, Write'],
  ['shell', 'Bash'],
  ['web', 'WebFetch, WebSearch'],
  ['skill', 'Skill'],
  ['task', 'Task'],
  ['ask', 'AskUserQuestion'],
])

/** "Tool1, Tool2, ..." para las capacidades recibidas, en su orden. */
export function claudeToolsString(relSource: string, capabilities: string[]): string {
  const tools: string[] = []
  for (const capability of capabilities) {
    if (capability.length === 0) continue
    const mapped = CAPABILITY_TOOLS.get(capability)
    if (mapped === undefined) {
      throw new AdapterError(`${relSource}: capacidad ${capability} sin mapeo Claude definido`)
    }
    tools.push(mapped)
  }
  return tools.join(', ')
}

// Clases explicitas y no `\s`: los espacios que cuentan son los ASCII de [[:space:]] en LC_ALL=C.
const LAUNCH_AGENT =
  /^[ \t\n\v\f\r]*\{\{mefisto:launch-agent[ \t\n\v\f\r]+([A-Za-z0-9_-]+)\}\}[ \t\n\v\f\r]*$/
const RUN = /^(.*)\{\{mefisto:run[ \t\n\v\f\r]+([^ \t\n\v\f\r]+)[ \t\n\v\f\r]*([^}]*)\}\}(.*)$/s
const COMMAND_PATH = /^(.*)\{\{mefisto:command-path[ \t\n\v\f\r]+([A-Za-z0-9_-]+)\}\}(.*)$/s

/**
 * Body con las directivas neutrales en su forma Claude Code:
 *   {{mefisto:launch-agent <id>}}   -> bloque bash con `claude --agent <id> "$ARGUMENTS"`
 *                                      (solo si la directiva ocupa toda la linea)
 *   {{mefisto:run <script> <args>}} -> MEFISTO_RUNTIME=claude ./.claude/scripts/<script> <args>
 *   {{mefisto:command-path <id>}}   -> .claude/commands/<id>.md
 * Las dos ultimas se traducen en su sitio y conservan el resto de la linea. Con varias en una
 * misma linea solo se traduce la ultima.
 */
export function claudeTranslateBody(relSource: string, body: string): string {
  let out = ''
  for (const line of body.split('\n')) {
    const launch = LAUNCH_AGENT.exec(line)
    const run = launch === null ? RUN.exec(line) : null
    const commandPath = launch === null && run === null ? COMMAND_PATH.exec(line) : null
    if (launch !== null) {
      out += `\`\`\`bash\nclaude --agent ${launch[1]} "$ARGUMENTS"\n\`\`\`\n`
    } else if (run !== null) {
      const args = (run[3] ?? '').replace(/[ \t\n\v\f\r]+$/, '')
      const invocation = args.length > 0 ? `${run[2]} ${args}` : `${run[2]}`
      out += `${run[1]}MEFISTO_RUNTIME=claude ./.claude/scripts/${invocation}${run[4]}\n`
    } else if (commandPath !== null) {
      out += `${commandPath[1]}.claude/commands/${commandPath[2]}.md${commandPath[3]}\n`
    } else if (line.includes('{{mefisto:')) {
      throw new AdapterError(`${relSource}: directiva de body desconocida: '${line}'`)
    } else {
      out += `${line}\n`
    }
  }
  return out
}

function nonEmptyList(value: Json | undefined): value is Json[] {
  return Array.isArray(value) && value.length > 0
}

/** Archivo Claude Code completo (frontmatter, marcador y body traducido) de un agente o comando. */
export function claudeRender(
  relSource: string,
  instance: JsonObject,
  markerLine: string,
  body: string,
): string {
  const kind = jqRaw(instance.kind ?? null)
  const translated = claudeTranslateBody(relSource, body).replace(/\n+$/, '')

  const capabilities = instance.capabilities
  const tools = nonEmptyList(capabilities)
    ? jqJson(claudeToolsString(relSource, capabilities.map(jqRaw)))
    : ''

  const profile = instance.profile ?? null
  const model = profile === null ? '' : claudeDefaultModel(jqRaw(profile))

  let effort = ''
  if (kind === 'agent') {
    const neutral = instance.effort ?? null
    const name = neutral === null || neutral === false ? '' : jqRaw(neutral)
    if (name.length > 0) {
      const native = claudeDefaultEffort(name)
      if (native === null) {
        throw new AdapterError(`${relSource}: effort ${name} sin traduccion Claude definida`)
      }
      effort = jqJson(native)
    }
  }

  const frontmatter: string[] = []
  const description = `description: ${jqJson(instance.description ?? null)}`
  if (kind === 'agent') {
    frontmatter.push(`name: ${jqJson(instance.id ?? null)}`, description)
    if (model.length > 0) frontmatter.push(`model: ${jqJson(model)}`)
    if (effort.length > 0) frontmatter.push(`effort: ${effort}`)
    if (tools.length > 0) frontmatter.push(`tools: ${tools}`)
    if (nonEmptyList(instance.skills)) frontmatter.push(`skills: ${jqJson(instance.skills)}`)
  } else {
    frontmatter.push(description)
    if (model.length > 0) frontmatter.push(`model: ${jqJson(model)}`)
    const hint = instance.arguments ?? null
    if (hint !== null) frontmatter.push(`argument-hint: ${jqJson(hint)}`)
    if (tools.length > 0) frontmatter.push(`allowed-tools: ${tools}`)
  }

  return ['---', ...frontmatter, '---', markerLine, translated, ''].join('\n')
}
