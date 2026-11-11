// Genera el adaptador Claude Code de los hooks interactivos publicados.
// Uso: generate-claude-hooks.sh [--check] [--out <raiz>]

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CliError, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import { JqError, dump, equals, get, iterate, parseStream, sortBy } from '../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../scripts/lib/jq-values.mts'
import { keysOf } from './lib/published-schema.mts'
import { isFile } from './lib/published-source.mts'
import { validateInteractiveHooks } from './validate-interactive-hooks.mts'

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const HOOKS_SCRIPT = '${CLAUDE_PLUGIN_ROOT}/scripts/interactive-hooks.mts'
const SESSION_START = ['record-active-release', 'append-session']
const STOP = ['append-session-model', 'remind-field-notes']
const FILE_CHANGE = ['append-file-change']
const SHELL = ['append-dotnet-test-result', 'append-terraform-result']
const BINDINGS = [...SESSION_START, ...STOP, ...FILE_CHANGE, ...SHELL]

function usageError(message: string): never {
  throw new CliError(`ERROR: ${message}`)
}

// Forma exec de Claude Code: sin shell intermedio, igual en macOS, Linux y Windows. El binding
// viaja como argumento del unico script que implementa los siete (MEF-ADR-0057 decision 3).
const hooksOf = (bindings: string[]): Json =>
  bindings.map((binding) => ({ type: 'command', command: 'node', args: [HOOKS_SCRIPT, binding] }))

export function renderClaudeHooks(): Json {
  return {
    hooks: {
      SessionStart: [{ hooks: hooksOf(SESSION_START) }],
      Stop: [{ hooks: hooksOf(STOP) }],
      PostToolUse: [
        { matcher: 'Write|Edit', hooks: hooksOf(FILE_CHANGE) },
        { matcher: 'Bash', hooks: hooksOf(SHELL) },
      ],
    },
    modules: ['./index.tsx'],
  }
}

const isList = (value: Json, size: number): value is Json[] => Array.isArray(value) && value.length === size

function topology(rendered: Json): boolean {
  const hooks = get(rendered, 'hooks')
  const groups = (event: string): Json[] => {
    const value = get(hooks, event)
    return Array.isArray(value) ? value : []
  }
  const single = (event: string): boolean =>
    isList(get(hooks, event), 1) &&
    equals(keysOf(groups(event)[0] ?? null), ['hooks']) &&
    isList(get(groups(event)[0] ?? null, 'hooks'), 2)
  const postToolUse = groups('PostToolUse')
  const all = ['SessionStart', 'Stop', 'PostToolUse'].flatMap((event) =>
    groups(event).flatMap((group) => iterate(get(group, 'hooks'))),
  )
  return (
    equals(keysOf(rendered), ['hooks', 'modules']) &&
    equals(get(rendered, 'modules'), ['./index.tsx']) &&
    equals(keysOf(hooks), ['PostToolUse', 'SessionStart', 'Stop']) &&
    single('SessionStart') &&
    single('Stop') &&
    isList(get(hooks, 'PostToolUse'), 2) &&
    postToolUse.every((group) => equals(keysOf(group), ['hooks', 'matcher'])) &&
    equals(
      postToolUse.map((group) => get(group, 'matcher')),
      ['Write|Edit', 'Bash'],
    ) &&
    postToolUse.every((group) => Array.isArray(get(group, 'hooks'))) &&
    postToolUse.flatMap((group) => iterate(get(group, 'hooks'))).length === 3 &&
    all.every((hook) => {
      const args = get(hook, 'args')
      return (
        equals(keysOf(hook), ['args', 'command', 'type']) &&
        get(hook, 'type') === 'command' &&
        get(hook, 'command') === 'node' &&
        isList(args, 2) &&
        args[0] === HOOKS_SCRIPT
      )
    }) &&
    equals(
      all.map((hook) => (get(hook, 'args') as Json[])[1] ?? null),
      BINDINGS,
    )
  )
}

/** `true` si `rendered` tiene la topologia de hooks que Claude Code debe recibir. */
export function hasHooksTopology(rendered: Json): boolean {
  try {
    return topology(rendered)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return false
  }
}

export interface HooksOptions {
  check: boolean
  outRoot: string
  repoRoot?: string
  render?: () => Json
  out?: (line: string) => void
}

function contractBindings(contractFile: string): string {
  try {
    const [contract] = parseStream(readFileSync(contractFile, 'utf8')).values
    const ids = iterate(get(contract ?? null, 'bindings')).map((binding) => get(binding, 'id'))
    return sortBy(ids, (id) => id)
      .map((id) => (typeof id === 'string' ? id : id === null ? '' : dump(id)))
      .join(' ')
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return ''
  }
}

export function generateClaudeHooks(options: HooksOptions): number {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const out = options.out ?? ((line: string) => console.log(line))
  const contractFile = join(repoRoot, 'src', 'published', 'hooks', 'interactive-hooks.json')

  // La validacion ocurre antes de preparar temporales o inspeccionar la salida.
  const validation = validateInteractiveHooks([contractFile], repoRoot)
  if (validation.status !== 0) throw new CliError(validation.errors.join('\n'))
  // El descriptor validado es neutral; esto evita omitir bindings en silencio al materializar
  // sus dos hechos de sesion en los eventos Claude.
  if (contractBindings(contractFile) !== [...BINDINGS].sort().join(' ')) {
    usageError('el contrato no contiene el conjunto exacto de siete bindings publicados')
  }

  const rendered = (options.render ?? renderClaudeHooks)()
  if (!hasHooksTopology(rendered)) {
    usageError('el adaptador Claude renderizado no cumple la estructura de hooks')
  }
  const content = `${dump(rendered, 2)}\n`

  const destination = join(options.outRoot, 'hooks', 'hooks.json')
  if (options.check) {
    if (!isFile(destination)) {
      out('hooks/hooks.json: faltante')
      return 1
    }
    if (!readFileSync(destination).equals(Buffer.from(content))) {
      out('hooks/hooks.json: distinta')
      return 1
    }
    return 0
  }

  const hooksDir = join(options.outRoot, 'hooks')
  try {
    mkdirSync(hooksDir, { recursive: true })
  } catch {
    usageError('no se pudo preparar hooks/')
  }
  let staging = ''
  try {
    staging = mkdtempSync(join(hooksDir, '.hooks.json.'))
    const staged = join(staging, 'hooks.json')
    writeFileSync(staged, content)
    renameSync(staged, destination)
  } catch {
    usageError('no se pudo publicar hooks/hooks.json')
  } finally {
    if (staging !== '') rmSync(staging, { recursive: true, force: true })
  }
  return 0
}

export function main(argv: string[]): number {
  const options: HooksOptions = { check: false, outRoot: REPO_ROOT }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg === '--check') options.check = true
    else if (arg === '--out') {
      const root = argv[++index]
      if (root === undefined) usageError('--out requiere una raiz')
      options.outRoot = root
    } else if (arg.startsWith('--')) usageError(`opcion desconocida: ${arg}`)
    else usageError(`argumento inesperado: ${arg}`)
  }
  return generateClaudeHooks(options)
}

if (isEntryPoint(import.meta.url)) runMain(() => main(process.argv.slice(2)))
