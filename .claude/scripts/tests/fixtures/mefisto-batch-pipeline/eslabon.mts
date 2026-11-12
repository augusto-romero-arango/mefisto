// Hijo falso del batch interno. Se copia al repo de prueba como `mefisto-tooling-pipeline.mts` y como
// `mefisto-validate-batch-deps.mts`; anota cada invocacion en el archivo de llamadas y sigue el
// guion de `MEFISTO_BATCH_GUION` para su primer argumento (issue) o para el PR que reconcilia.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

interface Paso {
  /** Codigo de salida; por defecto 0. */
  exit?: number
  /** Salida estandar; por defecto la linea del PR creado (`issue + 1000`), o la de la reconciliacion. */
  output?: string
  stderr?: string
  /** Lineas que agrega al events.log del lanzador tras su cabecera de sesion. */
  events?: string[]
  /** Escribe la senal de parada suave. */
  signal?: boolean
  /** Entre writer y reviewer cambia la rama del lanzador y deja cambios sin commitear. */
  mutateLauncher?: boolean
}

interface Guion {
  calls: string
  pipeline?: Record<string, Paso>
  reconcile?: Record<string, Paso>
}

const role = basename(process.argv[1] ?? '').replace(/\.mts$/, '')
const args = process.argv.slice(2)
const guion = JSON.parse(readFileSync(process.env.MEFISTO_BATCH_GUION ?? '', 'utf8')) as Guion
const reconciling = role === 'mefisto-validate-batch-deps'
const key = (reconciling ? args[1] : args[0]) ?? ''
const paso: Paso = (reconciling ? guion.reconcile : guion.pipeline)?.[key] ?? {}

const scriptDir = dirname(process.argv[1] ?? '')
const snapshotRoot = join(scriptDir, '..', '..', '..')
const launchRoot = process.env.MEFISTO_LAUNCH_ROOT ?? ''
const stateDir = process.env.MEFISTO_STATE_DIR ?? ''
const git = (cwd: string, ...gitArgs: string[]): string =>
  spawnSync('git', gitArgs, { cwd, encoding: 'utf8' }).stdout.replace(/\n+$/, '')
const marker = (): string => (existsSync(join(snapshotRoot, 'marker.txt')) ? readFileSync(join(snapshotRoot, 'marker.txt'), 'utf8').trim() : '')

const markers = [marker()]
if (paso.mutateLauncher === true) {
  git(launchRoot, 'switch', '-q', 'docs/concurrent')
  appendFileSync(join(launchRoot, 'marker.txt'), 'modificado\n')
  writeFileSync(join(launchRoot, 'staged.txt'), 'staged\n')
  git(launchRoot, 'add', 'staged.txt')
  writeFileSync(join(launchRoot, 'untracked.txt'), 'untracked\n')
}
markers.push(marker())

appendFileSync(
  guion.calls,
  `${JSON.stringify({
    role,
    args,
    runtime: process.env.MEFISTO_RUNTIME ?? null,
    timeout: process.env.MEFISTO_AGENT_TIMEOUT_SECONDS ?? null,
    launchRoot,
    toplevel: git(scriptDir, 'rev-parse', '--show-toplevel'),
    cwd: process.cwd(),
    markers,
  })}\n`,
)

if (!reconciling) {
  mkdirSync(stateDir, { recursive: true })
  const lines = [`=== SESSION MEFISTO-TOOLING 20260101-000000 issue:${key} from-stage:1 ===`, ...(paso.events ?? [])]
  appendFileSync(join(stateDir, 'events.log'), lines.map((line) => `${line}\n`).join(''))
}
if (paso.signal === true) writeFileSync(join(stateDir, 'batch-stop'), '')
if (paso.stderr !== undefined) process.stderr.write(paso.stderr)
const defaultOutput = reconciling ? `reconciliado PR #${key}\n` : `v PR creado: https://github.com/acme/mefisto/pull/${Number(key) + 1000}\n`
process.stdout.write(paso.output ?? defaultOutput)
process.exitCode = paso.exit ?? 0
