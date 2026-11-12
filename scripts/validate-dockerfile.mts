// Validacion opcional y no bloqueante del Dockerfile del worker de proyecciones (issue #1652).
//
// Alcance acotado (MEF-ADR-0031): solo ejecuta `docker info` y
// `docker build -f <ruta> -t projections-worker-check <raiz-del-repo>`; nunca push, run ni otros
// subcomandos. La ruta debe ser relativa, sin `..` y quedar bajo `src/` del toplevel del
// consumidor tambien tras resolver symlinks.
//
// Uso: node scripts/validate-dockerfile.mts <ruta-relativa-al-Dockerfile>

import { spawnSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import { CliError, capture, commandExists, isEntryPoint, spawnTarget } from './lib/cli.mts'
import type { CommandOptions, CommandResult } from './lib/cli.mts'
import { consumerRepoRoot } from './lib/consumer-guard.mts'
import { statePath } from './lib/state.mts'

export interface DockerfileDeps {
  cwd: string
  hasCommand: (command: string) => boolean
  run: (command: string, args: string[], options?: CommandOptions) => CommandResult
  /** Corre el programa con stdout y stderr hacia el archivo `log` y devuelve su codigo de salida. */
  runToLog: (command: string, args: string[], log: string, cwd: string) => number
  out: (line: string) => void
  err: (line: string) => void
}

export const USAGE = 'Uso: validate-dockerfile.mts <ruta-relativa-al-Dockerfile> (bajo src/)'
const LOG_TAIL_LINES = 20

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Aborta si `dockerfile` no es un archivo bajo `src/` de `root`, tambien tras resolver enlaces. */
export function assertDockerfileUnderSrc(root: string, dockerfile: string): void {
  if (dockerfile.startsWith('/')) {
    throw new CliError(`ERROR: la ruta debe ser relativa al repo, no absoluta: ${dockerfile}`)
  }
  if (!dockerfile.startsWith('src/')) {
    throw new CliError(`ERROR: la ruta debe estar bajo src/: ${dockerfile}`)
  }
  if (dockerfile.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new CliError(`ERROR: la ruta no admite segmentos '..', '.' ni vacios: ${dockerfile}`)
  }
  const path = join(root, dockerfile)
  if (!isFile(path)) throw new CliError(`ERROR: no existe el Dockerfile: ${dockerfile}`)
  const physical = lstatSync(path).isSymbolicLink()
    ? null
    : join(realpathSync.native(dirname(path)), basename(path))
  if (physical === null || !physical.startsWith(join(root, 'src') + sep)) {
    throw new CliError(`ERROR: el Dockerfile resuelto queda fuera de src/ del repo: ${dockerfile}`)
  }
}

function tail(path: string, count: number): string[] {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count)
}

function run(argv: string[], deps: DockerfileDeps): number {
  const top = consumerRepoRoot(deps.cwd, [
    'ERROR: scripts/validate-dockerfile.mts es del plugin publicado y solo aplica al consumidor.',
  ])
  const [dockerfile] = argv
  if (argv.length !== 1 || dockerfile === undefined || dockerfile === '') throw new CliError(USAGE)

  const root = realpathSync.native(top)
  assertDockerfileUnderSrc(root, dockerfile)

  if (!deps.hasCommand('docker') || deps.run('docker', ['info'], { cwd: root }).status !== 0) {
    deps.out('docker no disponible: validacion del Dockerfile pendiente manual')
    return 0
  }

  let log: string
  try {
    log = statePath('logs/projections-docker-build.log', root)
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
  const status = deps.runToLog(
    'docker',
    ['build', '-f', dockerfile, '-t', 'projections-worker-check', root],
    log,
    root,
  )
  deps.out(`docker build exit=${status}`)
  for (const line of tail(log, LOG_TAIL_LINES)) deps.out(line)
  return 0
}

export function validateDockerfile(argv: string[], deps: DockerfileDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deps.err(error.message)
    return error.exitCode
  }
}

function runToLog(command: string, args: string[], log: string, cwd: string): number {
  const fd = openSync(log, 'w')
  try {
    const target = spawnTarget(command, args)
    const result = spawnSync(target.command, target.args, {
      cwd,
      stdio: ['inherit', fd, fd],
      windowsVerbatimArguments: target.verbatim,
    })
    if (result.status !== null) return result.status
    // Convencion de shell: 127 si no arranco, 128 + la senal si murio por una.
    return result.signal === null ? 127 : 128 + constants.signals[result.signal]
  } finally {
    closeSync(fd)
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = validateDockerfile(process.argv.slice(2), {
    cwd: process.cwd(),
    hasCommand: commandExists,
    run: capture,
    runToLog,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
