// Renderizador Claude Code de las fuentes publicadas: devuelve el archivo completo o lanza
// `AdapterError`, nunca una salida parcial.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JqError, alt, dump, get, iterate, length, parseStream } from '../../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../../scripts/lib/jq-values.mts'
import { defaultEffort, defaultModel } from '../../../runtime/lib/runtime-claude.mts'
import { effectiveContractPreamble, needsConfigPath, needsInstructionsPath } from './effective-contract.mts'
import { AdapterError } from './published-adapter.mts'
import { chomp, closingIndex, isFile, relativeToRepo, sourceLines } from './published-source.mts'

const CAPABILITY_TOOLS: Record<string, string> = {
  read: 'Read, Glob, Grep',
  edit: 'Edit, Write',
  shell: 'Bash',
  web: 'WebFetch, WebSearch',
  skill: 'Skill',
  task: 'Task',
  ask: 'AskUserQuestion',
}

const MCP_TOOLS: Record<string, string> = {
  'microsoft-learn': 'mcp__microsoft-learn__*, mcp__plugin_mefisto_microsoft-learn__*',
  terraform: 'mcp__terraform__*, mcp__plugin_terraform_terraform__*',
}

const lookup = (table: Record<string, string>, key: string): string | null =>
  Object.hasOwn(table, key) ? (table[key] ?? null) : null

// Las tablas son las del adaptador de ejecucion.
export const claudeModel = (profile: string): string | null => defaultModel(profile)
export const claudeEffort = (level: string): string | null => defaultEffort(level)

function fail(rel: string, field: string, message: string): never {
  throw new AdapterError(`${rel}: ${field}: ${message}`)
}

/** Texto con que `jq -r` imprime un valor. */
function raw(value: Json): string {
  return typeof value === 'string' ? value : dump(value)
}

/** Lineas no vacias de `jq -r '.<key>[]?'`. */
function listed(rel: string, instance: Json, key: string, unreadable: string): string[] {
  let values: Json[]
  try {
    const field = get(instance, key)
    values = typeof field === 'object' && field !== null ? iterate(field) : []
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return fail(rel, key, unreadable)
  }
  return values.flatMap((value) => raw(value).split('\n')).filter((line) => line.length > 0)
}

export function claudeTools(rel: string, instance: Json): string {
  const tools: string[] = []
  for (const capability of listed(rel, instance, 'capabilities', 'no se pudieron leer')) {
    tools.push(
      lookup(CAPABILITY_TOOLS, capability) ??
        fail(rel, 'capabilities', `capacidad '${capability}' sin mapping Claude`),
    )
  }
  for (const server of listed(rel, instance, 'mcp', 'no se pudo leer')) {
    tools.push(lookup(MCP_TOOLS, server) ?? fail(rel, 'mcp', `servidor MCP '${server}' sin matcher Claude`))
  }
  return tools.join(', ')
}

function validateSkills(rel: string, instance: Json, repoRoot: string): void {
  for (const skill of listed(rel, instance, 'skills', 'no se pudieron leer')) {
    if (!isFile(join(repoRoot, 'skills', skill, 'SKILL.md'))) {
      fail(rel, 'skills', `Skill publicado '${skill}' no resuelve`)
    }
  }
}

export function needsPackageRoot(body: string): boolean {
  return [
    '{{mefisto:run ',
    '{{mefisto:package-root}}',
    '{{mefisto:skill-root ',
    '{{mefisto:command-doc ',
  ].some((directive) => body.includes(directive))
}

// Se emite dentro del artefacto Claude, no en la fuente neutral. No carga codigo desde el
// candidato: valida primero la metadata de distribucion.
const PACKAGE_ROOT_PREAMBLE = [
  '```bash',
  "mefisto_claude_root=''",
  'mefisto_claude_root_from_candidate() {',
  '    local root',
  // Una raiz de Windows llega como `C:\...`; `pwd -P` la devuelve en la forma que entiende el shell.
  '    case "$mefisto_claude_candidate" in /*|[A-Za-z]:[\\\\/]*) ;; *) return 1 ;; esac',
  '    root="$(cd "$mefisto_claude_candidate" 2>/dev/null && pwd -P)" || return 1',
  '    node "$root/scripts/verify-package-root.mts" "$root" >/dev/null 2>&1 || return 1',
  '    printf \'%s\\n\' "$root"',
  '}',
  "mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'",
  'if [[ "$mefisto_claude_loaded" != \'${\'* ]]; then',
  '    mefisto_claude_candidate="$mefisto_claude_loaded"',
  '    mefisto_claude_root="$(mefisto_claude_root_from_candidate)" || {',
  '        printf \'ERROR Claude: la raiz cargada (%s) es invalida; recargue o reinstale el plugin.\\n\' "$mefisto_claude_loaded" >&2; exit 1;',
  '    }',
  'else',
  '    mefisto_claude_cursor="$PWD"',
  '    while :; do',
  '        if [ -f "$mefisto_claude_cursor/.mefisto/pipeline/.plugin-root" ]; then',
  '            mefisto_claude_candidate="$(< "$mefisto_claude_cursor/.mefisto/pipeline/.plugin-root")"',
  '            if mefisto_claude_root="$(mefisto_claude_root_from_candidate)"; then break; fi',
  "            printf '%s\\n' 'ERROR Claude: metadata del marker canonico invalida; reabra o reinstale el plugin.' >&2; exit 1",
  '        fi',
  '        if [ "$mefisto_claude_cursor" = / ]; then break; fi',
  '        mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"',
  '    done',
  '    if [ -z "$mefisto_claude_root" ]; then',
  '        mefisto_claude_cursor="$PWD"',
  '        while :; do',
  '            if [ -f "$mefisto_claude_cursor/.claude/pipeline/.plugin-root" ]; then',
  '                mefisto_claude_candidate="$(< "$mefisto_claude_cursor/.claude/pipeline/.plugin-root")"',
  '                if mefisto_claude_root="$(mefisto_claude_root_from_candidate)"; then break; fi',
  "                printf '%s\\n' 'ERROR Claude: metadata del marker Claude invalida; reabra o reinstale el plugin.' >&2; exit 1",
  '            fi',
  '            if [ "$mefisto_claude_cursor" = / ]; then break; fi',
  '            mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"',
  '        done',
  '    fi',
  'fi',
  'if [ -z "$mefisto_claude_root" ]; then',
  "    printf '%s\\n' 'ERROR Claude: no se encontro una raiz Claude valida; reabra o reinstale el plugin.' >&2",
  '    exit 1',
  'fi',
  'MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"',
  'export MEFISTO_PACKAGE_ROOT',
  '```',
  '',
  'Ejecuta este bloque en cada llamada Bash de este comando, sin guardarlo en un archivo ni reutilizar el de otro comando: la raiz que fija es la de la version cargada.',
]

/** Bloque que fija `MEFISTO_PACKAGE_ROOT` y su regla de uso, sin salto final. */
export function packageRootPreamble(): string {
  return PACKAGE_ROOT_PREAMBLE.join('\n')
}

const SPACE = '[ \\t\\n\\v\\f\\r]'
const NOT_SPACE = '[^ \\t\\n\\v\\f\\r]'
const TRAILING_SPACE = /[ \t\n\v\f\r]+$/

interface Directive {
  pattern: RegExp
  render: (groups: string[]) => string
}

// El prefijo codicioso `(.*)` hace que cada patron tome la ultima directiva de su tipo en la linea.
function directive(body: string, render: (groups: string[]) => string): Directive {
  return { pattern: new RegExp(`^(.*)\\{\\{mefisto:${body}\\}\\}(.*)$`, 's'), render }
}

const ID = '[a-z0-9]+(?:-[a-z0-9]+)*'

const DIRECTIVES: Directive[] = [
  directive(`run${SPACE}+(${NOT_SPACE}+)${SPACE}+([^}]*)`, ([prefix, script, args, suffix]) => {
    const trimmed = (args ?? '').replace(TRAILING_SPACE, '')
    return `${prefix}MEFISTO_RUNTIME=claude node "\${MEFISTO_PACKAGE_ROOT}/scripts/${script}" ${trimmed}${suffix}`
  }),
  directive('loaded-root', ([prefix, suffix]) => `${prefix}\${CLAUDE_PLUGIN_ROOT}${suffix}`),
  directive('package-root', ([prefix, suffix]) => `${prefix}\${MEFISTO_PACKAGE_ROOT}${suffix}`),
  directive(
    `skill-root${SPACE}+(${ID})`,
    ([prefix, skill, suffix]) => `${prefix}"\${MEFISTO_PACKAGE_ROOT}/skills/${skill}"${suffix}`,
  ),
  directive(
    `command-doc${SPACE}+(${ID})`,
    ([prefix, command, suffix]) => `${prefix}"\${MEFISTO_PACKAGE_ROOT}/commands/${command}.md"${suffix}`,
  ),
  directive('config-path', ([prefix, suffix]) => `${prefix}\${MEFISTO_CONFIG_PATH}${suffix}`),
  directive('instructions-path', ([prefix, suffix]) => `${prefix}\${MEFISTO_INSTRUCTIONS_PATH}${suffix}`),
  directive(
    `state-path${SPACE}+([A-Za-z0-9][A-Za-z0-9._/-]*)`,
    ([prefix, path, suffix]) => `${prefix}.mefisto/pipeline/${path}${suffix}`,
  ),
  directive(
    `command${SPACE}+([a-z0-9-]+)`,
    ([prefix, command, suffix]) => `${prefix}/mefisto:${command}${suffix}`,
  ),
  directive(`launch-agent${SPACE}+([a-z0-9-]+)${SPACE}+([^{}]+)`, ([prefix, agent, message, suffix]) => {
    const trimmed = (message ?? '').replace(TRAILING_SPACE, '')
    return `${prefix}invoca la tool \`Task\` con el agente \`mefisto:${agent}\` y este mensaje: ${trimmed}. Espera su resultado final y continua con el paso siguiente del comando.${suffix}`
  }),
  directive(
    'assert-consumer-repo',
    ([prefix, suffix]) =>
      `${prefix}Antes de continuar, aborta si existe \`src/internal/scripts/generate-internal-adapters.mts\`: ese directorio es el repositorio de Mefisto, no un consumidor.${suffix}`,
  ),
]

function translateLast(line: string): string | null {
  for (const { pattern, render } of DIRECTIVES) {
    const match = pattern.exec(line)
    if (match !== null) return render(match.slice(1))
  }
  return null
}

/** Traduce las directivas `{{mefisto:...}}` de cada linea del cuerpo, de derecha a izquierda. */
export function translateBody(rel: string, body: string): string {
  const translated = body.split('\n').map((original) => {
    let line = original
    while (line.includes('{{mefisto:')) {
      line = translateLast(line) ?? fail(rel, 'body', `directiva sin mapping Claude: '${original}'`)
    }
    return line
  })
  return chomp(translated.join('\n'))
}

function readInstance(rel: string, frontmatter: string): Json {
  const parsed = parseStream(frontmatter)
  const [instance] = parsed.values
  if (!parsed.clean || parsed.values.length !== 1 || instance === undefined) {
    return fail(rel, 'frontmatter', 'no es JSON valido')
  }
  return instance
}

function field(instance: Json, key: string): Json {
  try {
    return get(instance, key)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return null
  }
}

/** Texto de `jq -r '.<key> // empty'`. */
function optional(instance: Json, key: string): string {
  const value = alt(field(instance, key), null)
  return value === null ? '' : chomp(raw(value))
}

function isEmpty(value: Json): boolean {
  try {
    return length(value) === 0
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return false
  }
}

/** Archivo Claude completo de la fuente publicada `source`, con `marker` tras el frontmatter. */
export function renderClaude(source: string, marker: string, repoRoot: string): string {
  const rel = relativeToRepo(repoRoot, source)
  let lines: string[]
  try {
    lines = sourceLines(readFileSync(source, 'utf8'))
  } catch {
    return fail(rel, 'frontmatter', 'no se pudo extraer')
  }
  const closing = closingIndex(lines)
  const instance = readInstance(
    rel,
    chomp(lines.slice(1, closing === -1 ? lines.length : closing).join('\n')),
  )
  const kind = chomp(raw(field(instance, 'kind')))
  const body = closing === -1 ? '' : chomp(lines.slice(closing + 1).join('\n'))
  const translated = translateBody(rel, body)

  const preambles: string[] = []
  if (needsPackageRoot(body)) preambles.push(packageRootPreamble())
  const [config, instructions] = [needsConfigPath(body), needsInstructionsPath(body)]
  if (config || instructions) preambles.push(effectiveContractPreamble(config, instructions))

  const tools = claudeTools(rel, instance)
  validateSkills(rel, instance, repoRoot)
  const profile = optional(instance, 'profile')
  const model =
    profile === ''
      ? null
      : (claudeModel(profile) ?? fail(rel, 'profile', `perfil '${profile}' sin mapping Claude`))
  const level = optional(instance, 'effort')
  const effort =
    kind !== 'agent' || level === ''
      ? null
      : (claudeEffort(level) ?? fail(rel, 'effort', `nivel '${level}' sin mapping Claude`))

  const out = ['---']
  if (kind === 'agent') {
    out.push(`name: ${dump(field(instance, 'id'))}`, `description: ${dump(field(instance, 'description'))}`)
    if (tools !== '') out.push(`tools: ${dump(tools)}`)
    const skills = field(instance, 'skills')
    if (!isEmpty(alt(skills, []))) out.push(`skills: ${dump(skills)}`)
  } else {
    out.push(`description: ${dump(field(instance, 'description'))}`)
    const hint = field(instance, 'arguments')
    if (hint !== null) out.push(`argument-hint: ${dump(hint)}`)
    if (tools !== '') out.push(`allowed-tools: ${dump(tools)}`)
  }
  if (model !== null) out.push(`model: ${dump(model)}`)
  if (effort !== null) out.push(`effort: ${dump(effort)}`)
  out.push('---', marker)
  if (preambles.length > 0) out.push(preambles.join('\n'))
  const agent = kind === 'command' ? optional(instance, 'agent') : ''
  if (agent !== '') {
    out.push(
      `Delega este comando completo: invoca la tool \`Task\` con el agente \`mefisto:${agent}\` y $ARGUMENTS como mensaje, junto con las instrucciones que siguen; no las ejecutes tu mismo. Espera su resultado final y devuelvelo.`,
    )
  }
  out.push(translated)
  return `${out.join('\n')}\n`
}
