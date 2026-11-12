// Ejecuta con bash los bloques de bash del markdown de comandos y agentes, como hace Claude Code
// (en Windows, con el Git Bash de Git for Windows, MEF-ADR-0057 decision 9).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

import { resolveCommand } from '../lib/cli.mts'
import { findGitBash } from '../lib/git-bash.mts'
import { fencedBlocks, linesOf } from './text-contract.mts'

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

/** El bash que usaria Claude Code, o `null` si no hay. */
export const BASH: string | null =
  process.platform === 'win32' ? findGitBash({ env: process.env, isFile }) : resolveCommand('bash')

/** Motivo de `skip` para los tests que necesitan bash. */
export const NO_BASH: string | false = BASH === null ? 'requiere bash (Git Bash en Windows)' : false

/**
 * Primer bloque ```` ```bash ```` despues del encabezado; `prefix` acepta un encabezado que
 * empieza por el texto dado. Vacio si no hay encabezado o bloque.
 */
export function bashBlockAfterHeading(markdown: string, heading: string, prefix = false): string {
  const lines = linesOf(markdown)
  const at = lines.findIndex((line) => (prefix ? line.startsWith(heading) : line === heading))
  return at === -1 ? '' : (fencedBlocks(lines.slice(at + 1).join('\n'), 'bash')[0] ?? '')
}

/** Crea `dir` con los archivos dados (rutas relativas con `/`) y lo devuelve. */
export function writeTree(dir: string, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

/** Ruta con `/`, que Git Bash y Node aceptan por igual. */
export function forwardSlashes(path: string): string {
  return path.replaceAll('\\', '/')
}

export interface BashRun {
  status: number | null
  /** stdout y stderr intercalados, como `>file 2>&1`. */
  output: string
}

export interface BashStreams {
  status: number | null
  stdout: string
  stderr: string
}

/** Como `runBashBlock`, pero con stdout y stderr por separado. */
export function runBashStreams(script: string, cwd: string, env: Record<string, string> = {}): BashStreams {
  if (BASH === null) throw new Error('no hay bash')
  const base: NodeJS.ProcessEnv = { ...process.env }
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  base[pathKey] = [dirname(process.execPath), base[pathKey] ?? ''].join(delimiter)
  const result = spawnSync(BASH, ['-c', script], { cwd, env: { ...base, ...env }, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Corre `script` con `bash -c` en `cwd`, con `node` en el PATH y las variables de `env` encima. */
export function runBashBlock(script: string, cwd: string, env: Record<string, string> = {}): BashRun {
  const result = runBashStreams(`exec 2>&1\n${script}`, cwd, env)
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}
