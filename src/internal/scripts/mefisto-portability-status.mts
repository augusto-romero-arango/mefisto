// Mide el avance de la portabilidad (docs/portabilidad/ESTADO.md, MEF-ADR-0057).
//
// Uso: node src/internal/scripts/mefisto-portability-status.mts [--json] [--root <dir>]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint } from '../../../scripts/lib/cli.mts'

const HISTORY_EXCLUDES = [
  ':!dist/',
  ':!docs/bitacora/',
  ':!docs/portabilidad/',
  ':!CHANGELOG.md',
  ':!changelog.d/',
]

// Archivos que pueden nombrar lo retirado: el ADR que lo retira, el indice que
// solo consolida el release, y este medidor con su test.
const ACCEPTED_FILES = new Set([
  'docs/adr/mef-adr-0057-portabilidad-typescript-node.md',
  'docs/adr/INDICE-TEMATICO.md',
  'src/internal/scripts/mefisto-portability-status.mts',
  '.claude/scripts/tests/mefisto-portability-status.test.mts',
])

const ADR_FILE = /^docs\/adr\/mef-adr-\d+-.*\.md$/
const CHANGELOG_HEADING = /^## Control de cambios\s*$/

export interface MentionMetric {
  files: string[]
  outsideExceptions: string[]
}

export interface PortabilityStatus {
  shellFiles: number
  shellLines: number
  jqFiles: number
  pythonFiles: number
  tmux: MentionMetric
  opencode: MentionMetric
  hookCommands: number
  hookCommandsNotNode: number
}

export function git(root: string, args: string[]): string[] {
  let out: string
  try {
    out = execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // `git grep` sale con 1 cuando no hay coincidencias.
    if (isExitStatus(error, 1)) return []
    throw error
  }
  return out.split('\n').filter((line) => line.length > 0)
}

function isExitStatus(error: unknown, status: number): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status
}

export function countLines(content: Buffer): number {
  let lines = 0
  for (const byte of content) if (byte === 0x0a) lines++
  return lines
}

export function trackedFiles(root: string, pattern: string): string[] {
  return git(root, ['ls-files', '--', pattern, ':!dist/'])
}

export function filesMentioning(root: string, word: string, wholeWord: boolean): string[] {
  const flags = wholeWord ? '-lIiw' : '-lIi'
  return git(root, ['grep', flags, word, '--', ...HISTORY_EXCLUDES])
}

// Cuerpo de un ADR: todo lo anterior a su seccion de control de cambios.
export function adrBody(text: string): string {
  const lines = text.split('\n')
  const cut = lines.findIndex((line) => CHANGELOG_HEADING.test(line))
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n')
}

export function mentionsOutsideExceptions(
  root: string,
  files: string[],
  word: string,
  wholeWord: boolean,
): string[] {
  const pattern = wholeWord ? new RegExp(`\\b${word}\\b`, 'i') : new RegExp(word, 'i')
  return files.filter((file) => {
    if (ACCEPTED_FILES.has(file)) return false
    if (!ADR_FILE.test(file)) return true
    return pattern.test(adrBody(readFileSync(join(root, file), 'utf8')))
  })
}

function mentionMetric(root: string, word: string, wholeWord: boolean): MentionMetric {
  const files = filesMentioning(root, word, wholeWord)
  return { files, outsideExceptions: mentionsOutsideExceptions(root, files, word, wholeWord) }
}

export function hookCommandsOf(hooksJson: unknown): string[] {
  const commands: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'command' && typeof value === 'string') commands.push(value)
        else visit(value)
      }
    }
  }
  visit(hooksJson)
  return commands
}

// `node` solo (forma exec, con `args`) o `node ...` (forma shell).
export function isNodeCommand(command: string): boolean {
  return command === 'node' || command.startsWith('node ')
}

export function collectStatus(root: string): PortabilityStatus {
  const shellFiles = trackedFiles(root, '*.sh')
  const shellLines = shellFiles.reduce(
    (total, file) => total + countLines(readFileSync(join(root, file))),
    0,
  )
  const hooksJson: unknown = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'))
  const commands = hookCommandsOf(hooksJson)
  return {
    shellFiles: shellFiles.length,
    shellLines,
    jqFiles: trackedFiles(root, '*.jq').length,
    pythonFiles: trackedFiles(root, '*.py').length,
    tmux: mentionMetric(root, 'tmux', true),
    opencode: mentionMetric(root, 'opencode', false),
    hookCommands: commands.length,
    hookCommandsNotNode: commands.filter((command) => !isNodeCommand(command)).length,
  }
}

export function isComplete(status: PortabilityStatus): boolean {
  return (
    status.shellFiles === 0 &&
    status.jqFiles === 0 &&
    status.pythonFiles === 0 &&
    status.tmux.outsideExceptions.length === 0 &&
    status.opencode.outsideExceptions.length === 0 &&
    status.hookCommandsNotNode === 0
  )
}

export function formatStatus(status: PortabilityStatus): string {
  const mention = (metric: MentionMetric): string =>
    `${metric.files.length} (${metric.outsideExceptions.length} fuera de las excepciones)`
  const rows: Array<[string, string, string]> = [
    ['M1a', 'Archivos .sh', String(status.shellFiles)],
    ['M1b', 'Lineas en .sh', String(status.shellLines)],
    ['M2', 'Archivos .jq', String(status.jqFiles)],
    ['M3', 'Archivos que mencionan tmux', mention(status.tmux)],
    ['M4', 'Archivos que mencionan OpenCode', mention(status.opencode)],
    ['M5', 'Comandos de hooks.json que no son node', `${status.hookCommandsNotNode} de ${status.hookCommands}`],
    ['M6', 'Archivos .py', String(status.pythonFiles)],
  ]
  const lines = rows.map(([id, label, value]) => `${id.padEnd(4)} ${label.padEnd(40)} ${value}`)
  for (const file of [...status.tmux.outsideExceptions, ...status.opencode.outsideExceptions]) {
    lines.push(`     fuera de las excepciones: ${file}`)
  }
  lines.push(isComplete(status) ? 'Metricas en su meta.' : 'Metricas pendientes.')
  return lines.join('\n')
}

function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function main(argv: string[]): number {
  let root = defaultRoot()
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--root') {
      const value = argv[++i]
      if (value === undefined) {
        console.error('ERROR: --root requiere un directorio')
        return 1
      }
      root = resolve(value)
    } else {
      console.error(`ERROR: argumento desconocido '${arg}'`)
      console.error('Uso: node mefisto-portability-status.mts [--json] [--root <dir>]')
      return 1
    }
  }
  const status = collectStatus(root)
  console.log(json ? JSON.stringify(status, null, 2) : formatStatus(status))
  return 0
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2))
