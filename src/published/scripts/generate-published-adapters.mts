// Orquesta los adaptadores publicados desde src/published/{agents,commands}. No conoce formatos
// de runtime: cada adapters/adapter-<runtime>.mts declara su raiz y renderiza sus archivos
// (interfaz en lib/published-adapter.mts).
//
// Uso: generate-published-adapters.sh [--check] [--out <raiz>] [archivo...]
// Sin archivos valida y procesa src/published/{agents,commands}/*.md en orden por bytes. --out es
// la raiz que contiene dist/ (principalmente para tests). --check nunca crea --out y lista
// <ruta>: faltante|distinta|huerfana|sin marcador|modo divergente|inventario inconsistente|enlace
// simbolico.
//
// Las raices de adaptadores distintos no pueden coincidir ni anidarse. El motor escribe en cada
// una `.mefisto-generated-assets.json`, inventario versionado (schemaVersion 1) de sus salidas
// Markdown y sus assets; no es el manifest de releases. El inventario atribuye cada copia a su
// fuente sin insertar un marcador que rompa un shebang o un programa jq.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CliError, isEntryPoint } from '../../../scripts/lib/cli.mts'
import { dump, isObject, iterate, parseStream, sortBy } from '../../../scripts/lib/jq-values.mts'
import type { Json } from '../../../scripts/lib/jq-values.mts'
import type { AdapterModule, PublishedAdapter } from './lib/published-adapter.mts'
import {
  byteCompare,
  chomp,
  filesAndLinksUnder,
  isFile,
  isInside,
  isSymlink,
  listPublishedSources,
  toPosix,
} from './lib/published-source.mts'
import { validatePublishedArtifacts } from './validate-published-artifacts.mts'

const SCRIPT_DIR = import.meta.dirname
export const REPO_ROOT = join(SCRIPT_DIR, '..', '..', '..')
// El marcador nombra el comando que regenera, no este modulo.
const MARKER_SCRIPT = 'src/published/scripts/generate-published-adapters.sh'
const INVENTORY = '.mefisto-generated-assets.json'
// Windows no tiene bits de permiso que comparar ni que fijar.
const HAS_MODES = process.platform !== 'win32'

// Clausura ejecutable del primer corte publicado de tooling (MEF-ADR-0053), como `ruta|modo`. Es
// una frontera de producto plana y ordenada a proposito: no se amplia con globs, que expondrian
// pipelines, fixtures o adaptadores de prueba que todavia no pertenecen a una release.
export const TOOLING_CLOSURE_ASSETS: readonly string[] = [
  'scripts/_pipeline-common.sh|0755',
  'scripts/lib/cli.mts|0644',
  'scripts/lib/state.mts|0644',
  'scripts/lib/field-note.mts|0644',
  'scripts/lib/harness-config.mts|0644',
  'scripts/lib/tfstate-naming.mts|0644',
  'scripts/lib/azure-cli.mts|0644',
  'scripts/lib/pipeline/agent-log.mts|0644',
  'scripts/lib/pipeline/stage-models.mts|0644',
  'scripts/lib/pipeline/agent-runtime.mts|0644',
  'scripts/lib/pipeline/agent-events.mts|0644',
  'scripts/lib/pipeline/agent-failures.mts|0644',
  'scripts/lib/pipeline/agent-hold.mts|0644',
  'scripts/launch-pipeline.sh|0755',
  'scripts/herdr-workspace.sh|0755',
  'scripts/herdr-pipeline.sh|0755',
  'scripts/stream-watch.sh|0755',
  'scripts/stream-watch.mts|0644',
  'scripts/lib/stream-watch.mts|0644',
  'scripts/tooling-pipeline.sh|0755',
  'scripts/tooling-pipeline.mts|0644',
  'scripts/tdd-pipeline.sh|0755',
  'scripts/tdd-pipeline.mts|0644',
  'scripts/pr-sync.sh|0755',
  'scripts/pr-sync.mts|0644',
  'scripts/lib/pipeline/pr-sync-github.mts|0644',
  'scripts/worktree-clean.sh|0755',
  'scripts/worktree-clean.mts|0644',
  'scripts/work-status-collect.sh|0755',
  'scripts/work-status-collect.mts|0644',
  'scripts/lib/work-status-hold.mts|0644',
  'scripts/lib/jq-values.mts|0644',
  'scripts/lib/pipeline/consumer-scope.mts|0644',
  'scripts/lib/pipeline/harness-identity.mts|0644',
  'scripts/lib/pipeline/pipeline-resolution.mts|0644',
  'scripts/lib/pipeline/pull-requests.mts|0644',
  'scripts/lib/pipeline/variant.mts|0644',
  'scripts/lib/pipeline/caffeinate.mts|0644',
  'scripts/batch-pipeline.sh|0755',
  'scripts/parallel-pipeline.sh|0755',
  'scripts/iac-pipeline.sh|0755',
  'scripts/scaffold-pipeline.sh|0755',
  'scripts/field-note.sh|0755',
  'scripts/field-note.mts|0644',
  'scripts/register-harness-secret.sh|0755',
  'scripts/register-harness-secret.mts|0644',
  'scripts/lib/consumer-guard.mts|0644',
  'scripts/seed-secret.sh|0755',
  'scripts/seed-secret.mts|0644',
  'scripts/next-order.sh|0755',
  'scripts/next-order.mts|0644',
  'scripts/lib/next-order.mts|0644',
  'scripts/lib/issue-dependencies.mts|0644',
  'scripts/warnings-diff.sh|0755',
  'scripts/warnings-diff.mts|0644',
  'scripts/metrics-report.sh|0755',
  'scripts/metrics-report.mts|0644',
  'scripts/lib/metrics-report.mts|0644',
  'scripts/lib/jq-literals.mts|0644',
  'scripts/lib/pipeline/coverage.mts|0644',
  'scripts/lib/pipeline/red-tests.mts|0644',
  'scripts/lib/pipeline/run-history.mts|0644',
  'scripts/lib/pipeline/smokes.mts|0644',
  'scripts/lib/pipeline/stage-metrics.mts|0644',
  'scripts/lib/pipeline/test-results.mts|0644',
  'scripts/lib/pipeline/warning-remnants.mts|0644',
  'scripts/lib/pipeline/pipeline-exit.mts|0644',
  'scripts/lib/pipeline/pipeline-log.mts|0644',
  'scripts/lib/pipeline/pipeline-status.mts|0644',
  'scripts/lib/pipeline/pipeline-agent-run.mts|0644',
  'scripts/lib/pipeline/pipeline-worktree.mts|0644',
  'scripts/lib/pipeline/pipeline-pr.mts|0644',
  'scripts/lib/pipeline/tdd-texts.mts|0644',
  'scripts/lib/pipeline/tdd-gates.mts|0644',
  'scripts/lib/pipeline/tdd-coverage.mts|0644',
  'scripts/validate-dockerfile.sh|0755',
  'scripts/validate-dockerfile.mts|0644',
  'scripts/azure-account-info.sh|0755',
  'scripts/azure-account-info.mts|0644',
  'scripts/bootstrap-backend.sh|0755',
  'scripts/bootstrap-backend.mts|0644',
  'scripts/setup-github-ci.sh|0755',
  'scripts/setup-github-ci.mts|0644',
  'scripts/setup-github-labels.sh|0755',
  'scripts/setup-github-labels.mts|0644',
  'scripts/appinsights-query.sh|0755',
  'scripts/appinsights-query.mts|0644',
  'scripts/purge-store.sh|0755',
  'scripts/purge-store.mts|0644',
  'scripts/onboard-diagnose.sh|0755',
  'scripts/onboard-diagnose.mts|0644',
  'scripts/onboard-migrate-directives.sh|0755',
  'scripts/onboard-migrate-directives.mts|0644',
  'scripts/lib/consumer-directives.mts|0644',
  'scripts/onboard-provision-appinsights.sh|0755',
  'scripts/onboard-provision-appinsights.mts|0644',
  'scripts/onboard-activate-repo.sh|0755',
  'scripts/onboard-activate-repo.mts|0644',
  'scripts/lib/plugin-scopes.mts|0644',
  'scripts/update-plugin.sh|0755',
  'scripts/update-plugin.mts|0644',
  'scripts/upgrade.sh|0755',
  'scripts/upgrade.mts|0644',
  'scripts/json-value.mts|0644',
  'scripts/verify-package-root.mts|0644',
  'scripts/lib/json-value.mts|0644',
  'scripts/lib/package-reference-pin.mts|0644',
  'src/runtime/mefisto-run-agent.sh|0755',
  'src/runtime/mefisto-run-agent.mts|0644',
  'src/runtime/lib/mefisto-runtime.sh|0755',
  'src/runtime/lib/mefisto-runtime.mts|0644',
  'src/runtime/lib/mefisto-models.sh|0644',
  'src/runtime/lib/mefisto-models.mts|0644',
  'src/runtime/lib/mefisto-process.sh|0755',
  'src/runtime/lib/mefisto-process.mts|0644',
  'src/runtime/lib/runtime-claude.sh|0755',
  'src/runtime/lib/runtime-claude.mts|0644',
  'src/runtime/lib/runtime-claude.jq|0644',
  'src/runtime/contract/models.validate.jq|0644',
]

// El marketplace Claude instala hoy la raiz del checkout (`source: "./"`). Hasta que esa raiz sea
// una proyeccion autocontenida, los entrypoints y roles publicados se reflejan alli, byte a byte,
// desde la misma renderizacion Claude.
const CLAUDE_ROOT_MIRRORS: readonly string[] = [
  'src/published/commands/tooling.md|commands/tooling.md',
  'src/published/commands/draft.md|commands/draft.md',
  'src/published/commands/implement.md|commands/implement.md',
  'src/published/commands/merge.md|commands/merge.md',
  'src/published/commands/sequential.md|commands/sequential.md',
  'src/published/commands/batch-stop.md|commands/batch-stop.md',
  'src/published/commands/parallel.md|commands/parallel.md',
  'src/published/commands/infra.md|commands/infra.md',
  'src/published/commands/infra-base.md|commands/infra-base.md',
  'src/published/commands/scaffold-projections.md|commands/scaffold-projections.md',
  'src/published/commands/scaffold-mcp.md|commands/scaffold-mcp.md',
  'src/published/commands/scaffold.md|commands/scaffold.md',
  'src/published/commands/seed-secret.md|commands/seed-secret.md',
  'src/published/commands/install-workos.md|commands/install-workos.md',
  'src/published/commands/install-apim.md|commands/install-apim.md',
  'src/published/commands/install-auth.md|commands/install-auth.md',
  'src/published/commands/next-order.md|commands/next-order.md',
  'src/published/commands/upgrade.md|commands/upgrade.md',
  'src/published/commands/health-check.md|commands/health-check.md',
  'src/published/commands/purge-store.md|commands/purge-store.md',
  'src/published/commands/fix-review.md|commands/fix-review.md',
  'src/published/commands/eraser-diagram.md|commands/eraser-diagram.md',
  'src/published/commands/bug.md|commands/bug.md',
  'src/published/commands/bitacora.md|commands/bitacora.md',
  'src/published/commands/onboard.md|commands/onboard.md',
  'src/published/agents/tooling-writer.md|agents/tooling-writer.md',
  'src/published/agents/tooling-reviewer.md|agents/tooling-reviewer.md',
  'src/published/agents/test-writer.md|agents/test-writer.md',
  'src/published/agents/implementer.md|agents/implementer.md',
  'src/published/agents/reviewer.md|agents/reviewer.md',
  'src/published/agents/smoke-test-writer.md|agents/smoke-test-writer.md',
  'src/published/agents/projection-test-writer.md|agents/projection-test-writer.md',
  'src/published/agents/projection-implementer.md|agents/projection-implementer.md',
  'src/published/agents/domain-scaffolder.md|agents/domain-scaffolder.md',
  'src/published/agents/infra-writer.md|agents/infra-writer.md',
  'src/published/agents/infra-reviewer.md|agents/infra-reviewer.md',
  'src/published/agents/pr-sync.md|agents/pr-sync.md',
  'src/published/agents/infra-bootstrap.md|agents/infra-bootstrap.md',
  'src/published/agents/planner.md|agents/planner.md',
  'src/published/agents/infra-base-scaffolder.md|agents/infra-base-scaffolder.md',
  'src/published/agents/projections-scaffolder.md|agents/projections-scaffolder.md',
  'src/published/agents/workos-identity-scaffolder.md|agents/workos-identity-scaffolder.md',
  'src/published/agents/apim-gateway-scaffolder.md|agents/apim-gateway-scaffolder.md',
  'src/published/agents/mcp-scaffolder.md|agents/mcp-scaffolder.md',
  'src/published/agents/bug-investigator.md|agents/bug-investigator.md',
  'src/published/agents/tooling-investigator.md|agents/tooling-investigator.md',
  'src/published/agents/historiador.md|agents/historiador.md',
]

export interface ValidatorResult {
  status: number
  /** stdout y stderr del validador, juntos. */
  output: string
}

export interface GenerateOptions {
  check: boolean
  /** Raiz que contiene `dist/`. */
  outRoot: string
  files: readonly string[]
  repoRoot?: string
  /** Adaptadores ya cargados; sin ellos se descubren en `adapterDir`. */
  adapters?: readonly PublishedAdapter[]
  adapterDir?: string
  validate?: (files: readonly string[]) => ValidatorResult
  toolingClosure?: readonly string[]
  out?: (line: string) => void
}

interface Staged {
  content: Buffer
  mode: number
}

interface Plan {
  adapter: string
  id: string
  source: string
  destination: string
  mode: string
  sha256: string
}

function usageError(message: string): never {
  throw new CliError(`ERROR: ${message}`)
}

function safeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.endsWith('/') || /[\n\r]/.test(value)) return false
  if (sep === '\\' && value.includes('\\')) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function pathsOverlap(a: string, b: string): boolean {
  return `${a}/`.startsWith(`${b}/`) || `${b}/`.startsWith(`${a}/`)
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex')
const parseMode = (mode: string): number => Number.parseInt(mode, 8)
const fileMode = (path: string): number => statSync(path).mode & 0o7777
const markerFor = (relSource: string): string =>
  `<!-- GENERADO por ${MARKER_SCRIPT} desde ${relSource}. No editar a mano. -->`
const MARKER_PREFIX = `<!-- GENERADO por ${MARKER_SCRIPT} desde `
const MARKER_SUFFIX = '. No editar a mano. -->'

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function hasAnyGeneratedMarker(path: string): boolean {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  return text
    .split('\n')
    .some(
      (line) =>
        line.length >= MARKER_PREFIX.length + MARKER_SUFFIX.length &&
        line.startsWith(MARKER_PREFIX) &&
        line.endsWith(MARKER_SUFFIX),
    )
}

function outputPathHasSymlink(outRoot: string, relPath: string): boolean {
  let current = outRoot
  if (isSymlink(current)) return true
  for (const segment of relPath.split('/')) {
    current = join(current, segment)
    if (isSymlink(current)) return true
  }
  return false
}

/** `true` si el inventario ya publicado en `inventory` atribuye `destination` a un asset. */
function wasSupplementalAsset(inventory: string, destination: string): boolean {
  if (!isFile(inventory)) return false
  const [document] = parseStream(readFileSync(inventory, 'utf8')).values
  const assets = isObject(document) ? (document.assets ?? null) : null
  if (typeof assets !== 'object' || assets === null) return false
  for (const asset of iterate(assets)) {
    if (asset !== null && !isObject(asset)) return false
    const declared = isObject(asset) ? (asset.destination ?? null) : null
    if (declared === null || declared === false) continue
    if ((typeof declared === 'string' ? declared : dump(declared)) === destination) return true
  }
  return false
}

type SourceProblem = 'carpeta' | 'fuera' | 'ausente' | 'enlace'

/** Ruta real de una fuente declarada como relativa al repo, o por que no sirve. */
function resolveSource(repoRoot: string, source: string): { path: string } | { problem: SourceProblem } {
  const segments = source.split('/')
  let parent: string
  try {
    parent = realpathSync.native(join(repoRoot, ...segments.slice(0, -1)))
  } catch {
    return { problem: 'carpeta' }
  }
  if (!isDirectory(parent)) return { problem: 'carpeta' }
  const path = join(parent, segments.at(-1) ?? '')
  if (!isInside(repoRoot, path)) return { problem: 'fuera' }
  if (!isFile(path)) return { problem: 'ausente' }
  if (isSymlink(path)) return { problem: 'enlace' }
  return { path }
}

/** Mensaje de un fallo de adaptador, listo para stderr. */
function failureText(error: unknown): string {
  return error instanceof Error ? chomp(error.message) : String(error)
}

function attempt<T>(action: () => T, onFailure: (text: string) => never): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof CliError) throw error
    return onFailure(failureText(error))
  }
}

/** Adaptadores `adapter-*.mts` de `dir`, en orden por bytes. */
export async function loadAdapters(dir: string, repoRoot: string): Promise<PublishedAdapter[]> {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^adapter-.*\.mts$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(byteCompare)
  } catch {
    return []
  }
  const adapters: PublishedAdapter[] = []
  for (const name of names) {
    const module = (await import(pathToFileURL(join(dir, name)).href)) as Partial<AdapterModule>
    if (typeof module.createAdapter !== 'function') usageError(`adaptador no ejecutable: ${name}`)
    adapters.push(module.createAdapter({ repoRoot }))
  }
  return adapters
}

class Generation {
  readonly repoRoot: string
  readonly outRoot: string
  readonly adapters: readonly PublishedAdapter[]
  readonly roots: string[] = []
  readonly staged = new Map<string, Staged>()
  readonly generated: string[] = []
  readonly generatedSet = new Set<string>()
  readonly assetPlans: Plan[] = []
  readonly renderedPlans: Plan[] = []

  constructor(repoRoot: string, outRoot: string, adapters: readonly PublishedAdapter[]) {
    this.repoRoot = repoRoot
    this.outRoot = outRoot
    this.adapters = adapters
  }

  private stage(relPath: string, content: Buffer, mode: number): void {
    this.staged.set(relPath, { content, mode })
    this.generated.push(relPath)
    this.generatedSet.add(relPath)
  }

  declareRoots(): void {
    for (const adapter of this.adapters) {
      const root = attempt(
        () => adapter.root(),
        () => usageError(`${adapter.name} no pudo declarar su raiz`),
      )
      if (!safeRelativePath(root)) usageError(`${adapter.name} declaro una raiz insegura`)
      if (!root.startsWith('dist/')) usageError(`${adapter.name} debe declarar una raiz dist/<runtime>`)
      if (this.roots.some((registered) => pathsOverlap(root, registered))) {
        usageError(`${adapter.name} declaro una raiz duplicada o anidada: ${root}`)
      }
      this.roots.push(root)
    }
  }

  renderSources(files: readonly string[]): void {
    for (const file of files) {
      const absolute = resolve(file)
      let dir: string
      try {
        dir = realpathSync.native(dirname(absolute))
      } catch {
        usageError('fuente inaccesible')
      }
      const source = join(dir, basename(absolute))
      if (!isInside(this.repoRoot, source)) usageError('fuente fuera del repositorio')
      const relSource = toPosix(relative(this.repoRoot, source))
      const marker = markerFor(relSource)
      this.adapters.forEach((adapter, index) => {
        const relPath = attempt(
          () => adapter.path(relSource),
          () => usageError(`${adapter.name} no pudo calcular la ruta de ${relSource}`),
        )
        if (!safeRelativePath(relPath)) {
          usageError(`${adapter.name} devolvio una ruta insegura para ${relSource}`)
        }
        const destination = `${this.roots[index]}/${relPath}`
        if (this.generatedSet.has(destination)) {
          usageError(`${adapter.name} produjo una ruta duplicada: ${destination}`)
        }
        const rendered = attempt(
          () => adapter.render(source, marker),
          (text) => {
            const failure = `ERROR: ${adapter.name} no pudo renderizar '${relSource}'; no se escribio nada`
            throw new CliError(text === '' ? failure : `${text}\n${failure}`)
          },
        )
        if (!rendered.split('\n').includes(marker)) {
          usageError(`${adapter.name} no escribio el marcador estable para ${relSource}`)
        }
        const content = Buffer.from(rendered)
        this.renderedPlans.push({
          adapter: adapter.name,
          id: relSource,
          source: relSource,
          destination,
          mode: '0644',
          sha256: sha256(content),
        })
        this.stage(destination, content, 0o644)
      })
    }
  }

  // No son una tercera fuente: reutilizan la salida ya renderizada por Claude. Quedan fuera de
  // dist/ porque el marketplace aun apunta a `./`.
  mirrors(): { generated: string; destination: string }[] {
    return CLAUDE_ROOT_MIRRORS.map((declared) => {
      const [source = '', destination = ''] = declared.split('|')
      return { generated: `dist/claude/${source.slice('src/published/'.length)}`, destination }
    })
  }

  stageMirrors(): void {
    for (const mirror of this.mirrors()) {
      if (!safeRelativePath(mirror.destination)) {
        usageError(`mirror Claude declaro un destino inseguro: ${mirror.destination}`)
      }
      const rendered = this.staged.get(mirror.generated)
      if (rendered === undefined) continue
      if (pathsOverlap(mirror.destination, 'dist')) {
        usageError(`mirror Claude colisiona con dist/: ${mirror.destination}`)
      }
      this.stage(mirror.destination, rendered.content, 0o644)
    }
  }

  private planAsset(plan: Plan, content: Buffer): void {
    this.assetPlans.push(plan)
    this.stage(plan.destination, content, parseMode(plan.mode))
  }

  // Los assets se enumeran despues de los Markdown para rechazar cualquier colision contra sus
  // salidas antes de publicar una sola raiz real.
  renderAdapterAssets(): void {
    this.adapters.forEach((adapter, index) => {
      // Un adaptador sin `assets` conserva su conducta: solo renderiza Markdown.
      if (adapter.assets === undefined) return
      const name = adapter.name
      let declared: unknown
      try {
        declared = adapter.assets()
      } catch (error) {
        const text = failureText(error)
        // Rechazar la enumeracion sin diagnostico equivale a no declarar assets.
        if (text === '') return
        throw new CliError(`ERROR: ${name} no pudo enumerar assets suplementarios\n${text}`)
      }
      const fields = ['destination', 'id', 'mode', 'source']
      const valid =
        Array.isArray(declared) &&
        declared.every(
          (asset: unknown) =>
            typeof asset === 'object' &&
            asset !== null &&
            !Array.isArray(asset) &&
            Object.keys(asset).sort().join('|') === fields.join('|') &&
            Object.values(asset).every((value) => typeof value === 'string'),
        )
      if (!valid) usageError(`${name} declaro assets suplementarios invalidos`)
      for (const asset of declared as Record<string, string>[]) {
        const { id = '', source = '', destination: relDestination = '', mode = '' } = asset
        const label = `${name} asset '${id}'`
        if (!safeRelativePath(id)) usageError(`${label} declaro un id inseguro`)
        if (!safeRelativePath(source)) usageError(`${label} declaro una fuente insegura`)
        if (!safeRelativePath(relDestination)) usageError(`${label} declaro un destino inseguro`)
        if (mode !== '0644' && mode !== '0755') usageError(`${label} declaro un modo desconocido: ${mode}`)
        const resolved = resolveSource(this.repoRoot, source)
        if ('problem' in resolved) {
          usageError(
            {
              carpeta: `${label} declaro una fuente ausente: ${source}`,
              fuera: `${label} declaro una fuente fuera del repositorio: ${source}`,
              ausente: `${label} declaro una fuente ausente: ${source}`,
              enlace: `${label} declaro una fuente fuera del repositorio mediante symlink: ${source}`,
            }[resolved.problem],
          )
        }
        const destination = `${this.roots[index]}/${relDestination}`
        if (pathsOverlap(destination, `${this.roots[index]}/${INVENTORY}`)) {
          usageError(`${label} colisiona con el inventario del motor: ${destination}`)
        }
        for (const plan of this.assetPlans) {
          if (plan.adapter === name && plan.id === id) usageError(`${label} repite un id`)
          if (pathsOverlap(plan.destination, destination)) {
            usageError(`${label} colisiona en destino con otro asset: ${destination}`)
          }
        }
        if (this.generated.some((path) => pathsOverlap(path, destination))) {
          usageError(`${label} colisiona con salida agent/command: ${destination}`)
        }
        const rendered = attempt(
          () => {
            if (adapter.renderAsset === undefined) throw new Error('')
            return adapter.renderAsset(id, resolved.path)
          },
          (text) => {
            const failure = `ERROR: ${name} no pudo renderizar el asset '${id}'; no se escribio nada`
            throw new CliError(text === '' ? failure : `${text}\n${failure}`)
          },
        )
        const content = Buffer.from(rendered)
        this.planAsset({ adapter: name, id, source, destination, mode, sha256: sha256(content) }, content)
      }
    })
  }

  // La clausura estatica se proyecta en CADA raiz con el layout relativo del checkout, para que
  // el runner y los pipelines se resuelvan igual desde la raiz de cualquier paquete.
  projectStaticAssets(collection: string, declaredAssets: readonly string[]): void {
    const resolved: Staged[] = []
    for (const root of this.roots) {
      declaredAssets.forEach((declared, index) => {
        const [source = ''] = declared.split('|')
        const mode = declared.slice(declared.lastIndexOf('|') + 1)
        if (!safeRelativePath(source)) usageError(`${collection} declaro una fuente insegura: ${source}`)
        if (mode !== '0644' && mode !== '0755') {
          usageError(`${collection} declaro un modo desconocido: ${mode}`)
        }
        // La fuente no depende de la raiz: se lee en la primera y se reutiliza en las demas.
        if (resolved[index] === undefined) {
          const location = resolveSource(this.repoRoot, source)
          if ('problem' in location) {
            usageError(
              {
                carpeta: `${collection} declaro una fuente ausente: ${source}`,
                fuera: `${collection} declaro una fuente fuera del repositorio: ${source}`,
                ausente: `${collection} declaro una fuente ausente o no regular: ${source}`,
                enlace: `${collection} declaro una fuente mediante symlink: ${source}`,
              }[location.problem],
            )
          }
          resolved[index] = { content: readFileSync(location.path), mode: parseMode(mode) }
        }
        const content = resolved[index].content
        const destination = `${root}/${source}`
        if (pathsOverlap(destination, `${root}/${INVENTORY}`)) {
          usageError(`${collection} colisiona con el inventario del motor: ${destination}`)
        }
        if (this.assetPlans.some((plan) => pathsOverlap(plan.destination, destination))) {
          usageError(`${collection} colisiona en destino: ${destination}`)
        }
        if (this.generated.some((path) => pathsOverlap(path, destination))) {
          usageError(`${collection} colisiona con salida agent/command: ${destination}`)
        }
        this.planAsset(
          {
            adapter: collection,
            id: `${collection}/${source}`,
            source,
            destination,
            mode,
            sha256: sha256(content),
          },
          content,
        )
      })
    }
  }

  // Conocimiento no ejecutable del flujo TDD. Los ADRs se descubren por convencion para que uno
  // nuevo entre en cada runtime sin una lista manual; el cheatsheet lo necesita test-writer.
  knowledgeAssets(): string[] {
    const adrDir = join(this.repoRoot, 'docs', 'adr')
    let names: string[] = []
    try {
      names = readdirSync(adrDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^mef-adr-.*\.md$/.test(entry.name))
        .map((entry) => entry.name)
        .sort(byteCompare)
    } catch {
      names = []
    }
    if (names.length === 0) usageError('tooling-knowledge no descubrio ningun docs/adr/mef-adr-*.md')
    return [...names.map((name) => `docs/adr/${name}|0644`), 'docs/testing/harness-cheatsheet.md|0644']
  }

  // Toda raiz lleva inventario, tambien la de un adaptador que no declara assets.
  stageInventories(): void {
    for (const root of this.roots) {
      const prefix = `${root}/`
      const assets = sortBy(
        [...this.assetPlans, ...this.renderedPlans]
          .filter((plan) => plan.destination.startsWith(prefix))
          .map((plan) => ({
            adapter: plan.adapter,
            id: plan.id,
            source: plan.source,
            destination: plan.destination.slice(prefix.length),
            mode: plan.mode,
            sha256: plan.sha256,
          })),
        (asset) => [asset.adapter, asset.id],
      )
      const inventory: Json = { schemaVersion: 1, assets }
      this.stage(`${root}/${INVENTORY}`, Buffer.from(`${dump(inventory)}\n`), 0o644)
    }
  }

  private divergence(relPath: string, staged: Staged, isAsset: boolean): string | null {
    const existing = join(this.outRoot, ...relPath.split('/'))
    if (outputPathHasSymlink(this.outRoot, relPath)) return 'enlace simbolico'
    if (!isFile(existing)) return 'faltante'
    const sameContent = (): boolean => readFileSync(existing).equals(staged.content)
    const sameMode = (): boolean => !HAS_MODES || fileMode(existing) === staged.mode
    if (basename(existing) === INVENTORY) {
      if (!sameContent()) return 'inventario inconsistente'
      return sameMode() ? null : 'modo divergente'
    }
    if (!isAsset && !hasAnyGeneratedMarker(existing)) return 'sin marcador'
    if (!sameContent()) return 'distinta'
    return sameMode() ? null : 'modo divergente'
  }

  check(out: (line: string) => void): number {
    let divergent = 0
    const report = (relPath: string, state: string): void => {
      out(`${relPath}: ${state}`)
      divergent = 1
    }
    const assetDestinations = new Set(this.assetPlans.map((plan) => plan.destination))
    for (const relPath of this.generated) {
      const staged = this.staged.get(relPath)
      if (staged === undefined) continue
      const state = this.divergence(relPath, staged, assetDestinations.has(relPath))
      if (state !== null) report(relPath, state)
    }
    for (const root of this.roots) {
      const rootDir = join(this.outRoot, ...root.split('/'))
      const publishedInventory = join(rootDir, INVENTORY)
      for (const existing of filesAndLinksUnder(rootDir)) {
        const relPath = `${root}/${toPosix(relative(rootDir, existing))}`
        if (this.generatedSet.has(relPath)) continue
        if (isSymlink(existing)) report(relPath, 'enlace simbolico')
        else if (hasAnyGeneratedMarker(existing)) report(relPath, 'huerfana')
        else if (wasSupplementalAsset(publishedInventory, relPath.slice(root.length + 1)))
          report(relPath, 'huerfana')
        else if (basename(existing) === INVENTORY) report(relPath, 'inventario inconsistente')
        else report(relPath, 'sin marcador')
      }
    }
    return divergent
  }

  private write(path: string, staged: Staged): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, staged.content)
    if (HAS_MODES) chmodSync(path, staged.mode)
  }

  publish(): void {
    const mirrors = this.mirrors().filter((mirror) => this.generatedSet.has(mirror.generated))
    // Los destinos fuera de dist/ se validan antes de reemplazar las raices: asi un destino
    // incompatible no deja dist/ actualizado y el mirror raiz sin publicar.
    for (const { destination } of mirrors) {
      if (outputPathHasSymlink(this.outRoot, destination)) {
        usageError(`mirror Claude atraviesa un enlace simbolico: ${destination}`)
      }
      const target = join(this.outRoot, ...destination.split('/'))
      if (exists(target) && !isFile(target)) {
        usageError(`mirror Claude tiene un destino no regular: ${destination}`)
      }
    }

    // Se preparan arboles completos antes de reemplazar las raices declaradas: eso elimina
    // huerfanos y archivos manuales, y escribir y luego comprobar converge al mismo arbol.
    try {
      mkdirSync(this.outRoot, { recursive: true })
    } catch {
      usageError('no se pudo crear la raiz de salida')
    }
    let publishDir: string
    try {
      publishDir = mkdtempSync(join(this.outRoot, '.published-adapters.'))
    } catch {
      usageError('no se pudo preparar la publicacion')
    }
    try {
      this.swapRoots(publishDir)
      for (const { destination } of mirrors) {
        const staged = this.staged.get(destination)
        if (staged === undefined) continue
        try {
          this.write(join(this.outRoot, ...destination.split('/')), staged)
        } catch {
          usageError(`no se pudo publicar el mirror Claude: ${destination}`)
        }
      }
    } finally {
      rmSync(publishDir, { recursive: true, force: true })
    }
  }

  private swapRoots(publishDir: string): void {
    const candidate = (index: number): string => join(publishDir, 'candidates', String(index))
    const backup = (index: number): string => join(publishDir, 'backups', String(index))
    const destination = (index: number): string => join(this.outRoot, ...(this.roots[index] ?? '').split('/'))
    try {
      mkdirSync(join(publishDir, 'backups'), { recursive: true })
      this.roots.forEach((root, index) => {
        mkdirSync(candidate(index), { recursive: true })
        for (const [relPath, staged] of this.staged) {
          if (relPath.startsWith(`${root}/`)) {
            this.write(join(candidate(index), ...relPath.slice(root.length + 1).split('/')), staged)
          }
        }
      })
    } catch {
      usageError('no se pudo preparar la publicacion')
    }

    let swapped = 0
    for (let index = 0; index < this.roots.length; index++) {
      try {
        mkdirSync(dirname(destination(index)), { recursive: true })
        if (exists(destination(index))) renameSync(destination(index), backup(index))
      } catch {
        break
      }
      try {
        renameSync(candidate(index), destination(index))
        swapped++
      } catch {
        if (exists(backup(index))) renameSync(backup(index), destination(index))
        break
      }
    }
    if (swapped === this.roots.length) return
    for (let index = swapped - 1; index >= 0; index--) {
      rmSync(destination(index), { recursive: true, force: true })
      if (exists(backup(index))) renameSync(backup(index), destination(index))
    }
    usageError('no se pudieron publicar todas las raices; se restauro la salida anterior')
  }
}

/** Genera o comprueba la distribucion publicada; devuelve el codigo de salida. */
export async function generatePublishedAdapters(options: GenerateOptions): Promise<number> {
  const repoRoot = realpathSync.native(options.repoRoot ?? REPO_ROOT)
  const validate =
    options.validate ??
    ((files: readonly string[]): ValidatorResult => {
      const result = validatePublishedArtifacts(files, repoRoot)
      return { status: result.status, output: result.stderr + result.stdout }
    })

  // La validacion es la primera operacion sobre los artefactos: ningun rechazo puede crear ni
  // modificar la salida.
  const validation = validate(options.files)
  if (validation.status !== 0) throw new CliError(chomp(validation.output))

  const files = options.files.length > 0 ? options.files : listPublishedSources(repoRoot, true)
  const adapters =
    options.adapters ?? (await loadAdapters(options.adapterDir ?? join(SCRIPT_DIR, 'adapters'), repoRoot))
  if (adapters.length === 0) {
    if (files.length === 0) return 0
    usageError('no hay adapter-<runtime>.mts registrados para renderizar fuentes explicitas')
  }

  const generation = new Generation(repoRoot, options.outRoot, adapters)
  generation.declareRoots()
  generation.renderSources(files)
  generation.stageMirrors()
  generation.renderAdapterAssets()
  const knowledge = generation.knowledgeAssets()
  generation.projectStaticAssets('tooling-closure', options.toolingClosure ?? TOOLING_CLOSURE_ASSETS)
  generation.projectStaticAssets('tooling-knowledge', knowledge)
  generation.stageInventories()

  if (options.check) return generation.check(options.out ?? ((line: string) => console.log(line)))
  generation.publish()
  return 0
}

export function parseArgs(argv: readonly string[]): Pick<GenerateOptions, 'check' | 'outRoot' | 'files'> {
  let check = false
  let outRoot = REPO_ROOT
  const files: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg === '--check') check = true
    else if (arg === '--out') {
      const root = argv[++index]
      if (root === undefined) usageError('--out requiere una raiz')
      outRoot = root
    } else if (arg.startsWith('--')) usageError(`opcion desconocida: ${arg}`)
    else files.push(arg)
  }
  return { check, outRoot, files }
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = await generatePublishedAdapters(parseArgs(process.argv.slice(2)))
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) console.error(error.message)
    process.exitCode = error.exitCode
  }
}
