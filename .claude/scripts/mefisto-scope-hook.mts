// Hook PostToolUse (matcher Edit|Write) del adaptador Claude para el repo de Mefisto.
//
// Avisa en el instante en que un Edit/Write cae fuera del scope del plugin. Es feedback
// temprano: el juez sigue siendo `validate_mefisto_scope_changes` al final de cada stage.
//
// PostToolUse + exit 2: la herramienta ya corrio, asi que el mensaje pide revertir.
// El gate final juzga sobre `git diff` y `git status`, que no listan archivos ignorados: una
// ruta ignorada por git tampoco avisa aqui.
// Ante entrada ilegible, archivo fuera del repo o fallo propio termina en 0.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isEntryPoint } from '../../scripts/lib/cli.mts'
import { SCOPE_SUMMARY, isPathInMefistoScope } from '../../src/internal/scripts/lib/mefisto-scope.mts'

export function editedPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const toolInput = (input as Record<string, unknown>).tool_input
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const { file_path: filePath, path } = toolInput as Record<string, unknown>
  for (const candidate of [filePath, path]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

// Ruta real del ancestro que existe mas lo que falte: git y la herramienta pueden nombrar la
// misma carpeta por alias distintos (enlaces simbolicos, nombres cortos de Windows). Solo la
// variante nativa de realpath expande los nombres cortos.
function canonical(path: string): string {
  const rest: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/** Ruta relativa a la raiz con `/`, o `null` si el archivo queda fuera del repo. */
export function relativeToRoot(root: string, filePath: string): string | null {
  const absolute = resolve(root, filePath)
  const rel = relative(canonical(root), join(canonical(dirname(absolute)), basename(absolute)))
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

export function outOfScopeMessage(relPath: string): string {
  return [
    `FUERA DE SCOPE: '${relPath}' no esta en la allowlist interna de Mefisto (isPathInMefistoScope: src/internal/scripts/lib/mefisto-scope.mts). El gate final del stage (validate_mefisto_scope_changes) va a rechazar este cambio.`,
    `Este aviso llega DESPUES de la escritura (hook PostToolUse): el archivo ya existe en el arbol, asi que revierte lo que acabas de hacer -- borralo si lo creaste, o 'git checkout -- ${relPath}' si ya existia.`,
    `Rutas permitidas: ${SCOPE_SUMMARY}`,
    'Si esta ruta deberia estar permitida, MEF-ADR-0019 seccion E exige registrarla PRIMERO en un PR aparte (is_path_in_mefisto_scope + is_path_in_consumer_blocklist) antes de poblarla: no la crees en este PR.',
  ].join('\n')
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function isIgnoredByGit(root: string, relPath: string): boolean {
  return gitOutput(root, ['check-ignore', '-q', '--', relPath]) !== null
}

/** Devuelve el aviso a imprimir, o `null` si no hay nada que avisar. */
export function scopeWarning(cwd: string, stdin: string): string | null {
  let input: unknown
  try {
    input = JSON.parse(stdin)
  } catch {
    return null
  }
  const filePath = editedPath(input)
  if (filePath === null) return null
  const root = gitOutput(cwd, ['rev-parse', '--show-toplevel'])
  if (root === null || root.length === 0) return null
  const relPath = relativeToRoot(root, filePath)
  if (relPath === null || isPathInMefistoScope(relPath)) return null
  if (isIgnoredByGit(root, relPath)) return null
  return outOfScopeMessage(relPath)
}

function main(): number {
  try {
    const warning = scopeWarning(process.cwd(), readFileSync(0, 'utf8'))
    if (warning === null) return 0
    console.error(warning)
    return 2
  } catch {
    return 0
  }
}

if (isEntryPoint(import.meta.url)) process.exitCode = main()
