// Versionado y publicacion del plugin Mefisto, segun SemVer y Keep a Changelog.
//
// Uso:
//   node src/internal/scripts/mefisto-release.mts {patch|minor|major} [--prepare-only]
//   node src/internal/scripts/mefisto-release.mts
//
// La fase sale de comparar la version de plugin.json con el ultimo tag vX.Y.Z:
//   prepare (son iguales): crea la rama release/vX.Y.Z desde origin/main, corre el gate de
//     neutralidad, consolida changelog.d/, mueve [Unreleased] a [X.Y.Z], escribe la identidad y
//     los manifiestos, commitea, empuja y abre el PR. Por defecto remata: mergea el PR,
//     sincroniza main y sigue con publish; con --prepare-only se detiene tras crear el PR.
//   publish (plugin.json va por delante): exige main limpio y al dia con origin/main, valida la
//     identidad que dejo prepare, crea y empuja el tag anotado y publica el GitHub Release con
//     las notas de [X.Y.Z].
//
// Sale con 0 en exito y con 1 en cualquier precondicion incumplida.

import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { COLOR, CliError, capture, commandExists, isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import type { CommandOptions, CommandResult } from '../../../scripts/lib/cli.mts'
import {
  UNRELEASED_BLOCK,
  consolidateAdrIndexFragments,
  consolidateChangelogFragments,
  neutralityRemedy,
  readText,
} from './lib/mefisto-release-lib.mts'
import { assertInMefisto } from './lib/mefisto-repo.mts'
import type { MefistoRepo } from './lib/mefisto-repo.mts'
import { Output, chomp } from './lib/mefisto-script-io.mts'

// El nombre con que lo invocan los comandos: el shim que reenvia aqui.
const SCRIPT_NAME = 'mefisto-release.sh'
const RETRIES = 3
const RETRY_WAIT_MS = 2000
const FULL_SHA = /^[0-9a-f]{40}$/
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const CATEGORY_ORDER = ['Added', 'Changed', 'Fixed', 'Removed']
const ROOT_MANIFEST = 'mefisto-manifest.json'
const DIST_MANIFEST = 'dist/claude/mefisto-manifest.json'
/** Lo unico que un commit de release puede tocar, ademas de borrar fragmentos de changelog.d/. */
const MECHANICAL_PATHS = [
  'CHANGELOG.md',
  'docs/adr/INDICE-TEMATICO.md',
  '.claude-plugin/plugin.json',
  'src/published/release-identity.json',
  ROOT_MANIFEST,
  DIST_MANIFEST,
  'dist/claude/.mefisto-generated-assets.json',
]

export type Bump = 'patch' | 'minor' | 'major'

export interface ReleaseDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  output: Output
  /** Lanza `git`, `gh` y los generadores; un test lo sustituye. */
  run: (command: string, args: string[], options: CommandOptions) => CommandResult
  locate: (cwd: string) => MefistoRepo
  commandExists: (command: string) => boolean
  sleep: (ms: number) => void
  now: () => Date
}

interface Session {
  deps: ReleaseDeps
  root: string
  env: NodeJS.ProcessEnv
  repoUrl: string
  pluginJson: string
  changelog: string
  generator: string
  identity: string
  manifest: string
  distManifest: string
}

function abort(message: string): never {
  throw new CliError(`${COLOR.red}${COLOR.bold}x ERROR:${COLOR.reset} ${message}`)
}

function isBump(value: string): value is Bump {
  return value === 'patch' || value === 'minor' || value === 'major'
}

export function parseReleaseArgs(args: string[]): { bump: Bump | null; prepareOnly: boolean } {
  let bump: Bump | null = null
  let prepareOnly = false
  for (const arg of args) {
    if (isBump(arg)) {
      if (bump !== null) {
        abort(`Solo se admite una magnitud de bump (patch|minor|major); recibido tambien '${arg}'.`)
      }
      bump = arg
    } else if (arg === '--prepare-only') {
      prepareOnly = true
    } else {
      abort(`Argumento invalido: '${arg}'. Esperado patch|minor|major [--prepare-only].`)
    }
  }
  return { bump, prepareOnly }
}

export function bumpVersion(current: string, part: Bump): string {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(current)
  if (match === null) abort(`La version actual no es SemVer X.Y.Z: ${current}`)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function versionCharOrder(char: string | undefined): number {
  if (char === undefined || isDigit(char)) return 0
  if (/[A-Za-z]/.test(char)) return char.charCodeAt(0)
  return char === '~' ? -1 : char.charCodeAt(0) + 256
}

/** Orden de `sort -V`, sin su trato especial de las extensiones de archivo. */
export function compareVersions(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const difference = versionCharOrder(a[i]) - versionCharOrder(b[j])
      if (difference !== 0) return difference
      i++
      j++
    }
    while (a[i] === '0') i++
    while (b[j] === '0') j++
    let firstDifference = 0
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (firstDifference === 0) firstDifference = a.charCodeAt(i) - b.charCodeAt(j)
      i++
      j++
    }
    if (isDigit(a[i])) return 1
    if (isDigit(b[j])) return -1
    if (firstDifference !== 0) return firstDifference
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/** Cuerpo de `[Unreleased]` sin espacio final, o vacio si la seccion falta o esta en blanco. */
export function unreleasedBody(changelog: string): string {
  return (UNRELEASED_BLOCK.exec(changelog)?.[2] ?? '').trimEnd()
}

/** Cuerpo de la seccion `[version]`, apto como notas de release, o `null` si no existe. */
export function versionSection(changelog: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const section = new RegExp(
    `^##\\s*\\[${escaped}\\][^\\n]*\\n(.*?)(?=^##\\s*\\[|^\\[Unreleased\\]:|(?![\\s\\S]))`,
    'ms',
  )
  return section.exec(changelog)?.[1]?.trim() ?? null
}

/**
 * Una linea por categoria con su numero de entradas de primer nivel. Su tamano no crece con las
 * notas: el body de un PR admite 65536 caracteres y una seccion del CHANGELOG los supera.
 */
export function summarizeVersionSection(notes: string): string {
  // Una linea `- ...` dentro de un bloque cercado es parte de un snippet, no una entrada.
  const kept: string[] = []
  let fenced = false
  for (const line of notes.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    else if (!fenced) kept.push(line)
  }

  const counts = new Map<string, number>()
  const subsection = /^###\s*([\p{L}\p{N}_]+)[^\n]*\n(.*?)(?=^###\s|(?![\s\S]))/gmsu
  for (const match of kept.join('\n').matchAll(subsection)) {
    const name = match[1] ?? ''
    const entries = (match[2] ?? '').match(/^-\s/gm)?.length ?? 0
    counts.set(name, (counts.get(name) ?? 0) + entries)
  }

  const names = [
    ...CATEGORY_ORDER.filter((name) => counts.has(name)),
    ...[...counts.keys()].filter((name) => !CATEGORY_ORDER.includes(name)),
  ]
  return names.map((name) => `- **${name}**: ${counts.get(name)} entrada(s)`).join('\n')
}

export interface ChangelogRelease {
  newVersion: string
  prevVersion: string
  date: string
  repoUrl: string
}

/**
 * Mueve `[Unreleased]` a `[newVersion] - date` y actualiza los links de comparacion del pie.
 * Devuelve `null` si la seccion falta o esta vacia.
 */
export function rewriteChangelogForRelease(changelog: string, release: ChangelogRelease): string | null {
  const { newVersion, prevVersion, date, repoUrl } = release
  const block = UNRELEASED_BLOCK.exec(changelog)
  if (block === null) return null
  const header = block[1] ?? ''
  const body = block[2] ?? ''
  if (body.trim().length === 0) return null

  let text =
    changelog.slice(0, block.index) +
    `${header}\n## [${newVersion}] - ${date}\n${body.endsWith('\n') ? body : `${body}\n`}` +
    changelog.slice(block.index + block[0].length)

  const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${newVersion}...HEAD`
  const versionLink = `[${newVersion}]: ${repoUrl}/compare/v${prevVersion}...v${newVersion}`
  if (/^\[Unreleased\]:[^\n]*$/m.test(text)) {
    text = text.replace(/^\[Unreleased\]:[^\n]*$/m, () => unreleasedLink)
  } else {
    if (!text.endsWith('\n')) text += '\n'
    text += `${unreleasedLink}\n`
  }
  return text.replace(/^(\[Unreleased\]:[^\n]*\n)/m, (line) => `${line}${versionLink}\n`)
}

export interface PrBodyInput {
  newVersion: string
  prevVersion: string
  bump: Bump
  releaseBranch: string
  releaseDate: string
  sourceCommit: string
  repoUrl: string
  /** Notas de la seccion `[newVersion]`; al body solo llega su resumen por categorias. */
  notes: string
}

export function releasePrBody(input: PrBodyInput): string {
  const { newVersion, prevVersion, bump, releaseBranch, releaseDate, sourceCommit, repoUrl } = input
  const newTag = `v${newVersion}`
  const summary =
    summarizeVersionSection(input.notes) ||
    `- Sin subsecciones \`### Categoria\` en \`[${newVersion}]\`; ver las notas completas.`
  return `## Resumen

PR de release ${newTag} (${bump}: ${prevVersion} -> ${newVersion}).

- Consolida los fragmentos de \`changelog.d/\` (CHANGELOG e indice de ADRs de \`docs/adr/INDICE-TEMATICO.md\`) y los borra.
- Mueve \`[Unreleased]\` a \`[${newVersion}] - ${releaseDate}\` en \`CHANGELOG.md\`.
- Bumpea \`.claude-plugin/plugin.json\` a ${newVersion}.
- Persiste la identidad fuente \`${sourceCommit}\` y regenera los manifiestos Claude.
- Actualiza links de comparacion al pie del CHANGELOG.

## Categorias del release

${summary}

Notas completas: [\`CHANGELOG.md\`](${repoUrl}/blob/${releaseBranch}/CHANGELOG.md) en esta rama (\`${releaseBranch}\`).

## Siguiente paso

Por defecto (issue #759) el propio \`/mefisto-release ${bump}\` remata solo: mergea este PR (squash + delete-branch), sincroniza \`main\` y publica el tag ${newTag} con su GitHub Release.

Si se invoco con \`--prepare-only\`, el remate es manual:

1. \`/mefisto-merge <pr>\` para mergear este PR a \`main\`.
2. \`git switch main && git pull --ff-only\` para sincronizar local.
3. \`/mefisto-release\` (sin argumentos) para crear el tag ${newTag} y el GitHub Release.
`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** Texto de un valor JSON como lo imprime `jq -r`. */
function rawText(value: unknown): string {
  if (value === undefined) return 'null'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Texto de un valor JSON como lo imprime `jq -r '... // empty'`. */
function orEmpty(value: unknown): string {
  return value === undefined || value === null || value === false ? '' : rawText(value)
}

export interface ReleaseIdentity {
  schemaVersion: 1
  version: string
  commit: string
}

export function isValidReleaseIdentity(value: unknown): value is ReleaseIdentity {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(',') === 'commit,schemaVersion,version' &&
    value.schemaVersion === 1 &&
    typeof value.version === 'string' &&
    SEMVER.test(value.version) &&
    typeof value.commit === 'string' &&
    FULL_SHA.test(value.commit)
  )
}

/** `true` si un `git diff --name-status` solo trae cambios mecanicos de release. */
export function isMechanicalDelta(nameStatus: string): boolean {
  for (const line of nameStatus.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const status = line.slice(0, tab)
    const path = line.slice(tab + 1)
    if (path.length === 0 || MECHANICAL_PATHS.includes(path)) continue
    const isFragment = path.startsWith('changelog.d/') && path.endsWith('.md') && path !== 'changelog.d/README.md'
    if (!isFragment || status !== 'D') return false
  }
  return true
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
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

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

// Escribe en un temporal y renombra: el destino nunca queda con JSON truncado.
function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, content)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function clock(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function logInfo(s: Session, message: string): void {
  s.deps.output.out(`${COLOR.cyan}[${clock(s.deps.now())}]${COLOR.reset} ${message}`)
}

function logSuccess(s: Session, message: string): void {
  s.deps.output.out(`${COLOR.green}${COLOR.bold}v${COLOR.reset} ${message}`)
}

function logWarn(s: Session, message: string): void {
  s.deps.output.err(`${COLOR.yellow}!${COLOR.reset} ${message}`)
}

function logError(s: Session, message: string): void {
  s.deps.output.err(`${COLOR.red}${COLOR.bold}x ERROR:${COLOR.reset} ${message}`)
}

function heading(s: Session, title: string): void {
  s.deps.output.out(`${COLOR.cyan}${COLOR.bold}=== ${title} ===${COLOR.reset}`)
}

function run(s: Session, command: string, args: string[]): CommandResult {
  return s.deps.run(command, args, { cwd: s.root, env: s.env })
}

/** Corre sin mostrar nada, como con `>/dev/null 2>&1`. */
function quiet(s: Session, command: string, args: string[]): boolean {
  return run(s, command, args).status === 0
}

/** Corre dejando pasar stdout y stderr a la terminal. */
function shown(s: Session, command: string, args: string[]): CommandResult {
  const result = run(s, command, args)
  s.deps.output.writeOut(result.stdout)
  s.deps.output.writeErr(result.stderr)
  return result
}

/** Corre capturando stdout y dejando pasar stderr, como `$(...)`. */
function captured(s: Session, command: string, args: string[]): CommandResult {
  const result = run(s, command, args)
  s.deps.output.writeErr(result.stderr)
  return result
}

// El fallo de un comando sin guarda propia termina el script con su codigo, sin mensaje.
function orExit(result: CommandResult): CommandResult {
  if (result.status !== 0) throw new CliError('', result.status ?? 1)
  return result
}

function requireCleanTree(s: Session): void {
  if (chomp(captured(s, 'git', ['status', '--porcelain']).stdout).length > 0) {
    abort('Hay cambios sin commitear. Limpia el working tree antes de continuar.')
  }
}

function requireGhAuth(s: Session): void {
  if (!quiet(s, 'gh', ['auth', 'status'])) {
    abort("gh no esta autenticado. Ejecuta 'gh auth login' y reintenta.")
  }
}

function tagExistsLocal(s: Session, tag: string): boolean {
  return quiet(s, 'git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
}

function tagExistsRemote(s: Session, tag: string): boolean {
  return quiet(s, 'git', ['ls-remote', '--tags', '--exit-code', 'origin', tag])
}

function releaseExists(s: Session, tag: string): boolean {
  return quiet(s, 'gh', ['release', 'view', tag])
}

function pluginVersion(s: Session): string {
  const manifest = parseJson(readFileSync(s.pluginJson, 'utf8'))
  return isRecord(manifest) ? rawText(manifest.version) : ''
}

function latestTagVersion(s: Session): string {
  const tags = orExit(captured(s, 'git', ['tag', '-l', 'v[0-9]*.[0-9]*.[0-9]*'])).stdout
  const versions = tags
    .split('\n')
    .filter((tag) => tag.length > 0)
    .map((tag) => tag.replace(/^v/, ''))
  return versions.sort(compareVersions).at(-1) ?? ''
}

function changelogText(s: Session): string {
  try {
    return readText(s.changelog)
  } catch {
    return ''
  }
}

// `reset --hard` no borra archivos sin trackear: el manifiesto de raiz y dist/claude que un
// generador fallido pudo crear se limpian aparte.
function discardReleaseBranch(s: Session, originalBranch: string, releaseBranch: string): void {
  quiet(s, 'git', ['reset', '--hard'])
  quiet(s, 'git', ['clean', '-fd', '--', ROOT_MANIFEST, 'dist/claude'])
  quiet(s, 'git', ['switch', originalBranch])
  quiet(s, 'git', ['branch', '-D', releaseBranch])
}

function rewriteChangelog(s: Session, release: ChangelogRelease): boolean {
  const rewritten = rewriteChangelogForRelease(changelogText(s), release)
  if (rewritten === null) return false
  writeAtomic(s.changelog, rewritten)
  return true
}

function prepareMetadata(s: Session, version: string, sourceCommit: string): boolean {
  try {
    writeAtomic(s.identity, `${JSON.stringify({ schemaVersion: 1, version, commit: sourceCommit })}\n`)
    // El manifiesto de raiz y el de dist/claude se comparan por bytes: los dos salen de la identidad.
    const identity = parseJson(readFileSync(s.identity, 'utf8'))
    const manifest = {
      schemaVersion: field(identity, 'schemaVersion') ?? null,
      runtime: 'claude',
      version: field(identity, 'version') ?? null,
      commit: field(identity, 'commit') ?? null,
    }
    writeAtomic(s.manifest, `${JSON.stringify(manifest)}\n`)
    const plugin = parseJson(readFileSync(s.pluginJson, 'utf8'))
    if (!isRecord(plugin)) return false
    writeAtomic(s.pluginJson, `${JSON.stringify({ ...plugin, version }, null, 2)}\n`)
  } catch {
    return false
  }
  if (shown(s, 'bash', [s.generator]).status !== 0) return false
  return sameBytes(s.manifest, s.distManifest)
}

function prepare(s: Session, args: string[], currentVersion: string, lastTagVersion: string): number {
  const { output } = s.deps
  output.out('')
  heading(s, 'Fase prepare')

  const { bump, prepareOnly } = parseReleaseArgs(args)
  if (bump === null) {
    output.err(`Uso: ${SCRIPT_NAME} {patch|minor|major} [--prepare-only]`)
    output.err('')
    output.err(`plugin.json.version (${currentVersion}) ya coincide con el ultimo tag (v${lastTagVersion}).`)
    output.err('Necesitas indicar la magnitud del bump para preparar el PR de release.')
    return 1
  }

  const newVersion = bumpVersion(currentVersion, bump)
  const newTag = `v${newVersion}`
  const prevVersion = currentVersion
  const releaseBranch = `release/${newTag}`
  const releaseDate = s.deps.now().toISOString().slice(0, 10)

  logInfo(s, `Bump: ${prevVersion} -> ${newVersion} (${bump})`)
  logInfo(s, `Rama de release: ${releaseBranch}`)
  logInfo(s, `Fecha (UTC): ${releaseDate}`)

  // El gate y el generador siguen en bash hasta su propio port: se lanzan como procesos externos.
  if (!s.deps.commandExists('bash')) abort('Falta comando requerido: bash')
  requireCleanTree(s)
  requireGhAuth(s)
  if (tagExistsLocal(s, newTag) || tagExistsRemote(s, newTag)) {
    abort(`Ya existe el tag ${newTag}. Aborta para no pisar historia.`)
  }
  if (releaseExists(s, newTag)) abort(`Ya existe un GitHub Release ${newTag}. Aborta.`)
  if (shown(s, 'git', ['show-ref', '--verify', '--quiet', `refs/heads/${releaseBranch}`]).status === 0) {
    abort(`Ya existe localmente la rama ${releaseBranch}. Borrala o renombra antes de continuar.`)
  }

  const currentBranch = chomp(orExit(captured(s, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout)
  logInfo(s, `Rama actual: ${currentBranch}`)

  logInfo(s, 'Actualizando refs desde origin...')
  if (shown(s, 'git', ['fetch', 'origin', '--tags', '--quiet']).status !== 0) {
    abort('No se pudo hacer fetch desde origin')
  }

  // La identidad de una release es el commit que alimenta el squash, no el que resulta del
  // merge: se captura una vez, desde la misma ref que crea la rama, antes de tocar metadata.
  const source = captured(s, 'git', ['rev-parse', '--verify', 'origin/main^{commit}'])
  if (source.status !== 0) abort('No se pudo resolver origin/main como commit fuente')
  const sourceCommit = chomp(source.stdout)
  if (!FULL_SHA.test(sourceCommit)) {
    abort('origin/main no resolvio un SHA completo y valido; no se modifico metadata')
  }
  if (chomp(captured(s, 'git', ['rev-parse', 'origin/main']).stdout) !== sourceCommit) {
    abort('origin/main divergio al capturar el commit fuente; reintenta antes de modificar metadata')
  }
  logInfo(s, `Commit fuente capturado: ${sourceCommit}`)

  logInfo(s, `Creando rama ${releaseBranch} desde origin/main...`)
  if (!quiet(s, 'git', ['switch', '-c', releaseBranch, 'origin/main'])) {
    abort(`No se pudo crear la rama ${releaseBranch} (verifica que origin/main existe)`)
  }
  if (chomp(captured(s, 'git', ['rev-parse', 'HEAD']).stdout) !== sourceCommit) {
    discardReleaseBranch(s, currentBranch, releaseBranch)
    abort(
      `La rama ${releaseBranch} no se creo exactamente desde el commit fuente ${sourceCommit}; no se modifico metadata`,
    )
  }

  logInfo(s, 'Verificando neutralidad de runtime (MEF-ADR-0049)...')
  const gate = run(s, 'bash', [join(s.root, 'src', 'internal', 'scripts', 'mefisto-neutrality-gate.sh')])
  if (gate.status === 0) {
    logSuccess(s, 'Gate de neutralidad: sin fugas')
  } else {
    // La rama aun no tiene commits propios: se deshace para que el reintento no tropiece con ella.
    if (quiet(s, 'git', ['switch', currentBranch])) quiet(s, 'git', ['branch', '-D', releaseBranch])
    const gateOutput = chomp(gate.stdout + gate.stderr)
    abort(
      [
        'Fuga(s) de neutralidad de runtime (MEF-ADR-0049) en origin/main:',
        gateOutput,
        neutralityRemedy(gateOutput),
        `Una release no se publica con fugas: corrigelas en main via PR de issue (el pipeline de tooling corre este mismo gate) y reintenta '/mefisto-release ${bump}'. La rama ${releaseBranch} se deshizo (no tenia commits propios); estas de vuelta en ${currentBranch}.`,
      ].join('\n'),
    )
  }

  // Se consolida ya en la rama de release, para leer los fragmentos mergeados en origin/main y
  // no los del working tree previo.
  logInfo(s, 'Consolidando fragmentos de changelog.d/...')
  const changelogError = consolidateChangelogFragments(s.root)
  if (changelogError !== null) {
    output.err(changelogError)
    abort(
      'Fallo al consolidar los fragmentos de CHANGELOG (changelog.d/): revisa el nombre de cada fragmento (<issue>.<categoria>.md)',
    )
  }
  const adrIndexError = consolidateAdrIndexFragments(s.root)
  if (adrIndexError !== null) {
    output.err(adrIndexError)
    abort('Fallo al consolidar los fragmentos del indice de ADRs (changelog.d/*.adr-index.md)')
  }

  if (unreleasedBody(changelogText(s)).trim().length === 0) {
    abort(
      'La seccion [Unreleased] del CHANGELOG esta vacia (ni fragmentos en changelog.d/ ni entradas previas). Agrega notas antes de hacer release.',
    )
  }

  logInfo(s, 'Reescribiendo CHANGELOG.md...')
  if (
    !rewriteChangelog(s, { newVersion, prevVersion, date: releaseDate, repoUrl: s.repoUrl }) ||
    !prepareMetadata(s, newVersion, sourceCommit)
  ) {
    discardReleaseBranch(s, currentBranch, releaseBranch)
    abort(
      `Fallo al generar la identidad o los manifiestos de release; la rama ${releaseBranch} se descarto sin salida parcial`,
    )
  }

  orExit(shown(s, 'git', ['add', ...MECHANICAL_PATHS]))
  // git no versiona directorios: sin fragmentos ni README la carpeta no existe y el pathspec fallaria.
  if (isDirectory(join(s.root, 'changelog.d'))) orExit(shown(s, 'git', ['add', '-A', 'changelog.d/']))
  if (shown(s, 'git', ['diff', '--cached', '--quiet']).status === 0) {
    abort('No se produjeron cambios mecanicos de release (algo va mal)')
  }

  const commitMessage = `chore(release): ${newTag}`
  logInfo(s, `Commiteando: ${commitMessage}`)
  orExit(captured(s, 'git', ['commit', '-m', commitMessage]))

  logInfo(s, `Pusheando rama ${releaseBranch}...`)
  if (!quiet(s, 'git', ['push', '-u', 'origin', releaseBranch])) {
    abort(`No se pudo pushear la rama ${releaseBranch}`)
  }

  const notes = versionSection(changelogText(s), newVersion)
  if (notes === null) abort(`No se pudieron extraer las notas de [${newVersion}] del CHANGELOG`)
  const body = releasePrBody({
    newVersion,
    prevVersion,
    bump,
    releaseBranch,
    releaseDate,
    sourceCommit,
    repoUrl: s.repoUrl,
    notes,
  })

  logInfo(s, 'Creando PR contra main...')
  const bodyDir = mkdtempSync(join(tmpdir(), 'mefisto-release-'))
  let created: CommandResult
  try {
    const bodyFile = join(bodyDir, 'pr-body.md')
    writeFileSync(bodyFile, body)
    created = captured(s, 'gh', [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      releaseBranch,
      '--title',
      commitMessage,
      '--body-file',
      bodyFile,
    ])
  } finally {
    rmSync(bodyDir, { recursive: true, force: true })
  }
  if (created.status !== 0) abort('No se pudo crear el PR')
  const prUrl = chomp(created.stdout)

  logSuccess(s, `PR de release creado: ${prUrl}`)
  const prNumber = prUrl
    .split('\n')
    .map((line) => /[0-9]+$/.exec(line)?.[0] ?? '')
    .filter((number) => number.length > 0)
    .join('\n')
  if (prNumber.length === 0) {
    abort(
      `No se pudo extraer el numero del PR de la salida de gh: '${prUrl}'. El PR quedo creado; retoma con /mefisto-merge <pr>, luego git switch main && git pull --ff-only, luego /mefisto-release (sin argumentos).`,
    )
  }

  output.out('')
  heading(s, 'Resumen prepare')
  output.out(`  Version:  ${prevVersion} -> ${newVersion} (${bump})`)
  output.out(`  Rama:     ${releaseBranch}`)
  output.out(`  PR:       ${prUrl}`)

  if (prepareOnly) {
    output.out('')
    output.out('Siguiente paso (--prepare-only):')
    output.out(`  /mefisto-merge ${prNumber}`)
    output.out('  git switch main && git pull --ff-only')
    output.out('  /mefisto-release   # (sin argumentos) para publicar el tag y el release')
    return 0
  }

  // Cada eslabon del remate aborta diciendo que quedo hecho y el paso manual que falta.
  output.out('')
  heading(s, 'Encadenando merge + sync + publish')

  logInfo(s, `Mergeando PR #${prNumber} (squash + delete-branch)...`)
  if (shown(s, 'gh', ['pr', 'merge', prNumber, '--squash', '--delete-branch']).status !== 0) {
    abort(
      `Fallo el merge del PR #${prNumber}. Hecho: PR ${prUrl} creado (sigue abierto). Paso manual: /mefisto-merge ${prNumber}; luego git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
  }

  logInfo(s, `Confirmando estado MERGED y commit de merge del PR #${prNumber}...`)
  let mergeSha = ''
  let prState = ''
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const pr = parseJson(run(s, 'gh', ['pr', 'view', prNumber, '--json', 'state,mergeCommit']).stdout)
    prState = orEmpty(field(pr, 'state'))
    mergeSha = orEmpty(field(field(pr, 'mergeCommit'), 'oid'))
    if (prState === 'MERGED' && mergeSha.length > 0) break
    s.deps.sleep(RETRY_WAIT_MS)
  }
  if (prState !== 'MERGED' || mergeSha.length === 0) {
    abort(
      `No se pudo confirmar el estado MERGED del PR #${prNumber} tras reintentos. Hecho: merge disparado contra GitHub. Paso manual: verifica 'gh pr view ${prNumber}'; luego git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
  }
  logSuccess(s, `PR #${prNumber} MERGED (commit ${mergeSha}).`)

  logInfo(s, 'Sincronizando origin/main...')
  if (shown(s, 'git', ['fetch', 'origin', 'main', '--quiet']).status !== 0) {
    abort(
      `git fetch origin main fallo. Hecho: PR #${prNumber} mergeado (commit ${mergeSha}). Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
  }

  let present = false
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (quiet(s, 'git', ['merge-base', '--is-ancestor', mergeSha, 'origin/main'])) {
      present = true
      break
    }
    s.deps.sleep(RETRY_WAIT_MS)
    shown(s, 'git', ['fetch', 'origin', 'main', '--quiet'])
  }
  if (!present) {
    abort(
      `El commit de merge ${mergeSha} no aparece como ancestro de origin/main tras reintentos. Hecho: PR #${prNumber} mergeado. Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
  }

  logInfo(s, 'Sincronizando main local (switch + merge --ff-only)...')
  if (!quiet(s, 'git', ['switch', 'main'])) {
    abort(
      `No se pudo hacer 'git switch main'. Hecho: merge #${prNumber} confirmado en origin/main (${mergeSha}). Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos).`,
    )
  }
  if (!quiet(s, 'git', ['merge', '--ff-only', 'origin/main'])) {
    abort(
      `'git merge --ff-only origin/main' fallo. Hecho: merge #${prNumber} confirmado en origin/main (${mergeSha}), ya en rama main. Paso manual: git merge --ff-only origin/main; luego /mefisto-release (sin argumentos).`,
    )
  }
  logSuccess(s, `main sincronizado con origin/main (${mergeSha}).`)

  output.out('')
  logInfo(s, `Encadenando fase publish (re-invocando ${SCRIPT_NAME} sin argumentos)...`)
  if (release([], { ...s.deps, cwd: s.root }) !== 0) {
    abort(
      `La fase publish fallo. Hecho: PR #${prNumber} mergeado y main sincronizado (commit ${mergeSha}). Paso manual: resuelve la precondicion reportada arriba y reintenta con '/mefisto-release' (sin argumentos).`,
    )
  }
  return 0
}

function isClaudeManifest(path: string, version: string, commit: string): boolean {
  let manifest: unknown
  try {
    manifest = parseJson(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  return (
    isRecord(manifest) &&
    Object.keys(manifest).length === 4 &&
    manifest.schemaVersion === 1 &&
    manifest.runtime === 'claude' &&
    manifest.version === version &&
    manifest.commit === commit
  )
}

function recoveryInstructions(version: string, tag: string): string {
  return String.raw`Recuperacion (ejecuta el bloque completo desde la raiz del repo):
  recovery_notes=$(mktemp)
  trap 'rm -f "$recovery_notes"' EXIT
  python3 -c 'import re,sys; text=open(sys.argv[1], encoding="utf-8").read(); match=re.search(r"(?ms)^##\s*\[" + re.escape(sys.argv[2]) + r"\][^\n]*\n(.*?)(?=^##\s*\[|^\[Unreleased\]:|\Z)", text); print(match.group(1).strip()) if match else sys.exit(1)' CHANGELOG.md "${version}" > "$recovery_notes"
  gh release create "${tag}" --title "${tag}" --notes-file "$recovery_notes"`
}

function publish(s: Session, args: string[], currentVersion: string, lastTagVersion: string): number {
  const { output } = s.deps
  output.out('')
  heading(s, 'Fase publish')

  const [ignored] = args
  if (ignored !== undefined) {
    logWarn(s, `Argumento '${ignored}' ignorado en fase publish (plugin.json ya esta bumpeado).`)
  }

  const newVersion = currentVersion
  const newTag = `v${newVersion}`
  const prevVersion = lastTagVersion
  logInfo(s, `Tag a crear: ${newTag} (publicando ${prevVersion} -> ${newVersion})`)

  requireGhAuth(s)
  const currentBranch = chomp(orExit(captured(s, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout)
  if (currentBranch !== 'main') {
    abort(`Debes estar en 'main' para publicar el release (rama actual: ${currentBranch}).`)
  }
  requireCleanTree(s)

  logInfo(s, 'Actualizando refs de origin...')
  if (shown(s, 'git', ['fetch', 'origin', 'main', '--tags', '--quiet']).status !== 0) {
    abort('No se pudo hacer fetch de origin')
  }

  const behind = Number(chomp(orExit(captured(s, 'git', ['rev-list', '--count', 'HEAD..origin/main'])).stdout))
  const ahead = Number(chomp(orExit(captured(s, 'git', ['rev-list', '--count', 'origin/main..HEAD'])).stdout))
  if (behind > 0) {
    abort(
      `main local esta ${behind} commit(s) detras de origin/main. Ejecuta 'git pull --ff-only' y reintenta.`,
    )
  }
  if (ahead > 0) {
    abort(
      `main local tiene ${ahead} commit(s) que no estan en origin/main. Pushea o resetea antes de publicar.`,
    )
  }

  const head = captured(s, 'git', ['rev-parse', 'HEAD'])
  if (head.status !== 0) abort('No se pudo resolver HEAD para validar publish')
  const originMain = captured(s, 'git', ['rev-parse', 'origin/main'])
  if (originMain.status !== 0) abort('No se pudo resolver origin/main para validar publish')
  if (chomp(head.stdout) !== chomp(originMain.stdout)) {
    abort('HEAD no coincide exactamente con origin/main; sincroniza main y reintenta antes de crear el tag')
  }

  // Publish no recalcula la identidad: comprueba la que dejo prepare, su padre directo tras el
  // squash y sus proyecciones publicadas.
  let identity: unknown
  try {
    identity = parseJson(readFileSync(s.identity, 'utf8'))
  } catch {
    identity = undefined
  }
  if (!isValidReleaseIdentity(identity)) {
    abort(
      'release-identity.json es invalido; regenera la metadata con /mefisto-release <bump> antes de publicar',
    )
  }
  const sourceCommit = identity.commit
  const headParent = captured(s, 'git', ['rev-parse', 'HEAD^'])
  if (headParent.status !== 0) {
    abort('HEAD no tiene padre directo para validar el commit fuente; regenera la metadata')
  }
  if (chomp(headParent.stdout) !== sourceCommit) {
    abort(
      'El padre directo de HEAD no coincide con el commit fuente de release-identity.json; la release debe mergearse por squash y regenerarse',
    )
  }
  if (identity.version !== newVersion) {
    abort(`release-identity.json reporta ${identity.version}, no ${newVersion}; regenera la metadata`)
  }

  for (const [path, relative] of [
    [s.manifest, ROOT_MANIFEST],
    [s.distManifest, DIST_MANIFEST],
  ] as const) {
    if (!isClaudeManifest(path, newVersion, sourceCommit)) {
      abort(`El manifiesto Claude ${relative} no coincide con release-identity.json; regenera la metadata`)
    }
  }
  if (!sameBytes(s.manifest, s.distManifest)) {
    abort('Los manifiestos Claude de raiz y dist/claude difieren por bytes; regenera la metadata')
  }
  const delta = captured(s, 'git', ['diff', '--name-status', `${sourceCommit}..HEAD`])
  if (delta.status !== 0 || !isMechanicalDelta(delta.stdout)) {
    abort(
      `El delta ${sourceCommit}..HEAD contiene rutas ajenas a la allowlist mecanica de release; regenera la metadata en un squash limpio`,
    )
  }

  const mainPlugin = orExit(captured(s, 'git', ['show', 'origin/main:.claude-plugin/plugin.json'])).stdout
  const mainPluginVersion = rawText(field(parseJson(mainPlugin), 'version'))
  if (mainPluginVersion !== newVersion) {
    abort(
      `plugin.json en origin/main reporta ${mainPluginVersion}, no ${newVersion}. El PR de release aun no esta mergeado.`,
    )
  }

  if (tagExistsLocal(s, newTag)) abort(`Ya existe el tag local ${newTag}. Aborta.`)
  if (tagExistsRemote(s, newTag)) abort(`Ya existe el tag remoto ${newTag}. Aborta.`)
  if (releaseExists(s, newTag)) abort(`Ya existe un GitHub Release ${newTag}. Aborta.`)

  // Aqui las notas van integras: el body de un release admite 125000 caracteres, casi el doble
  // que el de un PR (https://github.com/cli/cli/issues/7705).
  const notes = versionSection(changelogText(s), newVersion)
  if (notes === null) {
    abort(`No se encontro la seccion [${newVersion}] en el CHANGELOG. Faltan notas en main?`)
  }

  // Sin manejadores de senal: uno correria tarde, con el script ya en el tag; la accion por
  // defecto mata el proceso en el acto y una interrupcion nunca llega a crearlo.
  const notesDir = mkdtempSync(join(tmpdir(), 'mefisto-release-'))
  try {
    const notesFile = join(notesDir, 'notes.md')
    writeFileSync(notesFile, `${notes}\n`)

    logInfo(s, `Creando tag anotado ${newTag}...`)
    if (shown(s, 'git', ['tag', '-a', newTag, '-m', `Release ${newTag}`]).status !== 0) {
      abort(`No se pudo crear el tag ${newTag}`)
    }

    logInfo(s, `Pusheando tag ${newTag}...`)
    if (!quiet(s, 'git', ['push', 'origin', newTag])) {
      quiet(s, 'git', ['tag', '-d', newTag])
      abort(`No se pudo pushear el tag ${newTag} (tag local revertido)`)
    }

    logInfo(s, `Creando GitHub Release ${newTag}...`)
    const created = captured(s, 'gh', ['release', 'create', newTag, '--title', newTag, '--notes-file', notesFile])
    if (created.status !== 0) {
      logError(
        s,
        `No se pudo crear el GitHub Release ${newTag}. El tag ya esta pusheado; no reedites la version ni el tag.`,
      )
      output.err(recoveryInstructions(newVersion, newTag))
      return 1
    }
    const releaseUrl = chomp(created.stdout)

    logSuccess(s, `GitHub Release publicado: ${releaseUrl}`)
    output.out('')
    heading(s, 'Resumen publish')
    output.out(`  v${prevVersion} -> v${newVersion}`)
    output.out(`  Tag:     ${newTag}`)
    output.out(`  Release: ${releaseUrl}`)
    return 0
  } finally {
    rmSync(notesDir, { recursive: true, force: true })
  }
}

function runRelease(args: string[], deps: ReleaseDeps): number {
  const repo = deps.locate(deps.cwd)
  const { root } = repo
  const s: Session = {
    deps,
    root,
    env: {
      ...deps.env,
      MEFISTO_REPO_ROOT: root,
      MEFISTO_PROJECT_NAME: repo.projectName,
      MEFISTO_REPO_SLUG: repo.repoSlug,
    },
    repoUrl: '',
    pluginJson: join(root, '.claude-plugin', 'plugin.json'),
    changelog: join(root, 'CHANGELOG.md'),
    generator: join(root, 'src', 'published', 'scripts', 'generate-published-adapters.sh'),
    identity: join(root, 'src', 'published', 'release-identity.json'),
    manifest: join(root, ROOT_MANIFEST),
    distManifest: join(root, 'dist', 'claude', 'mefisto-manifest.json'),
  }

  for (const command of ['git', 'gh']) {
    if (!deps.commandExists(command)) abort(`Falta comando requerido: ${command}`)
  }
  if (!isFile(s.pluginJson)) abort(`No existe ${s.pluginJson}`)
  if (!isFile(s.changelog)) abort(`No existe ${s.changelog}`)
  if (!isFile(s.generator)) abort(`No existe o no es ejecutable el generador publicado: ${s.generator}`)

  let repoSlug = repo.repoSlug
  if (repoSlug.length === 0) {
    repoSlug = chomp(run(s, 'gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).stdout)
  }
  if (repoSlug.length === 0) abort('No se pudo determinar el repo slug (gh repo view fallo)')
  s.repoUrl = `https://github.com/${repoSlug}`

  const currentVersion = pluginVersion(s)
  const lastTagVersion = latestTagVersion(s)
  if (currentVersion.length === 0) abort('No se pudo leer .claude-plugin/plugin.json (.version)')
  if (lastTagVersion.length === 0) {
    abort('El repo no tiene tags vX.Y.Z previos. Crea al menos uno manualmente antes de usar este skill.')
  }
  logInfo(s, `Version en plugin.json: ${currentVersion}`)
  logInfo(s, `Ultimo tag SemVer:      v${lastTagVersion}`)

  if (currentVersion === lastTagVersion) return prepare(s, args, currentVersion, lastTagVersion)
  if (compareVersions(currentVersion, lastTagVersion) > 0) {
    return publish(s, args, currentVersion, lastTagVersion)
  }
  abort(
    `Inconsistencia: plugin.json.version (${currentVersion}) es menor que el ultimo tag (v${lastTagVersion}).`,
  )
}

/** Corre el release; los fallos previstos salen por `deps.output` y devuelven su codigo de salida. */
export function release(args: string[], deps: ReleaseDeps): number {
  try {
    return runRelease(args, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.message.length > 0) deps.output.err(error.message)
    return error.exitCode
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function main(argv: string[]): number {
  return release(argv, {
    cwd: process.cwd(),
    env: process.env,
    output: new Output(true),
    run: capture,
    locate: assertInMefisto,
    commandExists,
    sleep: sleepSync,
    now: () => new Date(),
  })
}

if (isEntryPoint(import.meta.url)) runMain(() => main(process.argv.slice(2)))
