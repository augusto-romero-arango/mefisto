// Repo git temporal con remoto bare, y `gh`, gate y generador simulados, para los tests del release.

import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { COLOR, capture } from '../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../scripts/lib/cli.mts'
import { git, gitOk, isolateGitConfig, writeFiles } from '../../../scripts/tests/field-note-sandbox.mts'
import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import { release } from '../../../src/internal/scripts/mefisto-release.mts'
import type { ReleaseDeps } from '../../../src/internal/scripts/mefisto-release.mts'

export const ORIGINAL_BRANCH = 'topic/anterior'
export const RELEASE_BRANCH = 'release/v1.2.3'
export const PR_URL = 'https://example.invalid/pull/42'
export const RELEASE_URL = 'https://example.invalid/releases/v1.2.3'
export const GENERATED_ASSETS = '{"schemaVersion":1,"assets":[]}\n'
export const ABORT = `${COLOR.red}${COLOR.bold}x ERROR:${COLOR.reset} `
const OLD_COMMIT = 'a'.repeat(40)

export const BASE_CHANGELOG = `# Changelog

## [Unreleased]

### Changed
- Cambio de prueba.

## [1.2.2] - 2026-09-01

[Unreleased]: https://example.invalid/compare/v1.2.2...HEAD
`

/** El CHANGELOG base tras consolidar `changelog.d/` y preparar la 1.2.3. */
export const RELEASED_CHANGELOG = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-11-11

### Changed

- Cambio de prueba.

### Added

- Entrada del fragmento.

## [1.2.2] - 2026-09-01

[Unreleased]: https://github.com/owner/mefisto/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/owner/mefisto/compare/v1.2.2...v1.2.3
`
export const RELEASE_NOTES = '### Changed\n\n- Cambio de prueba.\n\n### Added\n\n- Entrada del fragmento.\n'

export const BASE_FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': '{\n  "name": "mefisto",\n  "version": "1.2.2"\n}\n',
  'src/published/release-identity.json': `{"schemaVersion":1,"version":"1.2.2","commit":"${OLD_COMMIT}"}\n`,
  'mefisto-manifest.json': `{"schemaVersion":1,"runtime":"claude","version":"1.2.2","commit":"${OLD_COMMIT}"}\n`,
  'dist/claude/mefisto-manifest.json': `{"schemaVersion":1,"runtime":"claude","version":"1.2.2","commit":"${OLD_COMMIT}"}\n`,
  'dist/claude/.mefisto-generated-assets.json': '{"schemaVersion":1,"assets":["previo"]}\n',
  'CHANGELOG.md': BASE_CHANGELOG,
  'docs/adr/INDICE-TEMATICO.md': '# Indice\n\n| Tema | ADR |\n|---|---|\n| Topics por evento | MEF-ADR-0001 |\n',
  'changelog.d/README.md': '# doc del mecanismo\n',
  'changelog.d/10.added.md': '- Entrada del fragmento.\n',
  'changelog.d/10.adr-index.md': '| Doctrina X | MEF-ADR-0036 |\n',
  'src/published/scripts/generate-published-adapters.sh': '# sustituido por el generador simulado\n',
  'src/internal/scripts/mefisto-neutrality-gate.sh': '# sustituido por el gate simulado\n',
}

type Override = (invocation: string) => CommandResult | undefined

function done(status: number, stdout = '', stderr = ''): CommandResult {
  return { status, stdout, stderr }
}

function identify(repo: string): void {
  git(repo, 'config', 'user.email', 'test@mefisto.local')
  git(repo, 'config', 'user.name', 'Mefisto Test')
}

export class ReleaseSandbox {
  readonly dir: string
  readonly repo: string
  readonly origin: string
  /** Commit de origin/main del que parte la release. */
  readonly source: string
  /** Una linea por invocacion: `git ...`, `gh ...`, `gate` o `generator`. */
  readonly events: string[] = []
  readonly sleeps: number[] = []
  readonly output = new Output()
  /** Notas con que se creo cada GitHub Release, por tag. */
  readonly releases = new Map<string, string>()
  readonly missingCommands = new Set<string>()
  gate = { status: 0, stdout: '' }
  /** Rama y contenido de changelog.d/ en el momento en que corrio el gate. */
  gateSaw: { branch: string; fragments: string[] } | null = null
  generatorStatus = 0
  /** Si no es `null`, lo que el generador deja en dist/claude en vez de copiar el manifiesto de raiz. */
  generatorManifest: string | null = null
  generatorEnv: NodeJS.ProcessEnv | undefined
  repoSlug = 'owner/mefisto'
  ghRepoView = 'owner/mefisto'
  /** Numero de la llamada a `gh auth status` desde la que falla. */
  authFailsFrom = Number.POSITIVE_INFINITY
  prCreateStatus = 0
  prCreateOutput = `${PR_URL}\n`
  prBody: string | null = null
  mergeStatus = 0
  prState = 'MERGED'
  mergeSha = ''
  /** Cambios extra que el squash mete en main, para simular un merge que no es mecanico. */
  mutateMerge: ((clone: string) => void) | undefined
  releaseCreateStatus = 0
  private readonly overrides: Override[] = []
  private authCalls = 0
  private merges = 0

  /** Se asocia a un arbol ya creado en `dir`; `build` y `copyTo` lo crean. */
  constructor(dir: string, source: string) {
    this.dir = dir
    this.repo = join(dir, 'repo')
    this.origin = join(dir, 'origin.git')
    this.source = source
  }

  /** Repo en `ORIGINAL_BRANCH`, con `main` y el tag v1.2.2 empujados al remoto bare. */
  static build(dir: string, files: Record<string, string> = {}): ReleaseSandbox {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git')
    git(repo, 'init', '-q', '--initial-branch=main')
    identify(repo)
    writeFiles(repo, { ...BASE_FILES, ...files })
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'base')
    git(repo, 'tag', 'v1.2.2')
    // Ruta relativa: una copia del arbol sigue apuntando a su propio remoto.
    git(repo, 'remote', 'add', 'origin', '../origin.git')
    git(repo, 'push', '-q', 'origin', 'main', 'v1.2.2')
    git(repo, 'switch', '-q', '-c', ORIGINAL_BRANCH)
    return new ReleaseSandbox(dir, git(repo, 'rev-parse', 'HEAD'))
  }

  /** Copia independiente del arbol: crear cada repo con git encarece los tests. */
  copyTo(dir: string): ReleaseSandbox {
    cpSync(this.dir, dir, { recursive: true })
    const copy = new ReleaseSandbox(dir, this.source)
    copy.mergeSha = this.mergeSha
    return copy
  }

  deps(): ReleaseDeps {
    return {
      cwd: this.repo,
      env: process.env,
      output: this.output,
      run: (command, args, options) => this.dispatch(command, args, options.env),
      locate: () => ({ root: this.repo, projectName: 'mefisto', repoSlug: this.repoSlug }),
      commandExists: (command) => !this.missingCommands.has(command),
      sleep: (ms) => {
        this.sleeps.push(ms)
      },
      now: () => new Date('2026-11-11T12:00:00Z'),
    }
  }

  release(...args: string[]): number {
    return release(args, this.deps())
  }

  /** La invocacion exacta `invocation` (p. ej. `git switch main`) falla sin ejecutarse. */
  fail(invocation: string, status = 1): void {
    this.overrides.push((actual) => (actual === invocation ? done(status, '', 'fallo simulado\n') : undefined))
  }

  /** La invocacion exacta `invocation` responde `stdout` sin ejecutarse. */
  answer(invocation: string, stdout: string): void {
    this.overrides.push((actual) => (actual === invocation ? done(0, stdout) : undefined))
  }

  private dispatch(command: string, args: string[], env: NodeJS.ProcessEnv | undefined): CommandResult {
    if (command === 'bash') return this.bash(args[0] ?? '', env)
    const invocation = `${command} ${args.join(' ')}`
    this.events.push(invocation)
    for (const override of this.overrides) {
      const result = override(invocation)
      if (result !== undefined) return result
    }
    if (command === 'git') return capture('git', args, { cwd: this.repo, env })
    if (command === 'gh') return this.gh(args)
    throw new Error(`comando inesperado: ${invocation}`)
  }

  private bash(script: string, env: NodeJS.ProcessEnv | undefined): CommandResult {
    if (script === join(this.repo, 'src', 'internal', 'scripts', 'mefisto-neutrality-gate.sh')) {
      this.events.push('gate')
      const fragments = join(this.repo, 'changelog.d')
      this.gateSaw = {
        branch: git(this.repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
        fragments: existsSync(fragments) ? readdirSync(fragments).sort() : [],
      }
      return done(this.gate.status, this.gate.stdout)
    }
    if (script === join(this.repo, 'src', 'published', 'scripts', 'generate-published-adapters.sh')) {
      this.events.push('generator')
      this.generatorEnv = env
      const dist = join(this.repo, 'dist', 'claude')
      if (this.generatorStatus !== 0) {
        writeFileSync(join(dist, 'mefisto-manifest.json'), 'parcial\n')
        writeFileSync(join(dist, 'sin-trackear.txt'), 'parcial\n')
        return done(this.generatorStatus, '', 'generador roto\n')
      }
      writeFileSync(
        join(dist, 'mefisto-manifest.json'),
        this.generatorManifest ?? readFileSync(join(this.repo, 'mefisto-manifest.json')),
      )
      writeFileSync(join(dist, '.mefisto-generated-assets.json'), GENERATED_ASSETS)
      return done(0, 'generado\n')
    }
    throw new Error(`script bash inesperado: ${script}`)
  }

  private gh(args: string[]): CommandResult {
    const subcommand = `${args[0] ?? ''} ${args[1] ?? ''}`
    switch (subcommand) {
      case 'repo view':
        return done(this.ghRepoView.length > 0 ? 0 : 1, this.ghRepoView.length > 0 ? `${this.ghRepoView}\n` : '')
      case 'auth status':
        this.authCalls++
        return done(this.authCalls >= this.authFailsFrom ? 1 : 0)
      case 'release view':
        return done(this.releases.has(args[2] ?? '') ? 0 : 1)
      case 'pr create':
        if (this.prCreateStatus !== 0) return done(this.prCreateStatus, '', 'pr rechazado\n')
        this.prBody = readFileSync(args[args.indexOf('--body-file') + 1] ?? '', 'utf8')
        return done(0, this.prCreateOutput)
      case 'pr merge':
        if (this.mergeStatus !== 0) return done(this.mergeStatus, '', 'merge rechazado\n')
        this.mergeSha = this.squashMerge()
        return done(0, 'mergeado\n')
      case 'pr view':
        return done(0, JSON.stringify({ state: this.prState, mergeCommit: { oid: this.mergeSha } }))
      case 'release create':
        if (this.releaseCreateStatus !== 0) return done(this.releaseCreateStatus, '', 'HTTP 500\n')
        this.releases.set(args[2] ?? '', readFileSync(args[args.indexOf('--notes-file') + 1] ?? '', 'utf8'))
        return done(0, `${RELEASE_URL}\n`)
      default:
        throw new Error(`gh simulado no esperaba: ${args.join(' ')}`)
    }
  }

  /** Mergea la rama de release en main del remoto como un squash de GitHub y borra la rama. */
  squashMerge(): string {
    const clone = join(this.dir, `merge-${++this.merges}`)
    git(this.dir, 'clone', '-q', this.origin, clone)
    identify(clone)
    git(clone, 'merge', '-q', '--squash', `origin/${RELEASE_BRANCH}`)
    this.mutateMerge?.(clone)
    git(clone, 'add', '-A')
    git(clone, 'commit', '-q', '-m', 'chore(release): v1.2.3 (#42)')
    git(clone, 'push', '-q', 'origin', 'main', `:${RELEASE_BRANCH}`)
    const sha = git(clone, 'rev-parse', 'HEAD')
    rmSync(clone, { recursive: true, force: true })
    return sha
  }

  /** Commit extra en main del remoto, ajeno a la release. */
  pushToMain(file: string): void {
    const clone = join(this.dir, `ajeno-${++this.merges}`)
    git(this.dir, 'clone', '-q', this.origin, clone)
    identify(clone)
    writeFiles(clone, { [file]: 'ajeno\n' })
    git(clone, 'add', '-A')
    git(clone, 'commit', '-q', '-m', 'cambio ajeno')
    git(clone, 'push', '-q', 'origin', 'main')
    rmSync(clone, { recursive: true, force: true })
  }

  /** Deja la release 1.2.3 preparada con `--prepare-only`: rama empujada y PR creado. */
  prepareOnly(): void {
    if (this.release('patch', '--prepare-only') !== 0) throw new Error(this.output.stderr)
    this.forget()
  }

  /** Mergea el PR ya preparado y sincroniza main local, como `git switch main && git pull --ff-only`. */
  mergeAndSync(): void {
    this.mergeSha = this.squashMerge()
    git(this.repo, 'switch', '-q', 'main')
    git(this.repo, 'pull', '-q', '--ff-only', 'origin', 'main')
    this.forget()
  }

  private forget(): void {
    this.events.length = 0
    this.output.stdout = ''
    this.output.stderr = ''
  }

  read(file: string): string {
    return readFileSync(join(this.repo, ...file.split('/')), 'utf8')
  }

  branch(): string {
    return git(this.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  }

  hasEvent(text: string): boolean {
    return this.events.some((event) => event.includes(text))
  }

  /** `true` si la ultima aparicion de `first` precede a la primera de `second`. */
  inOrder(first: string, second: string): boolean {
    const last = this.events.findLastIndex((event) => event.includes(first))
    const next = this.events.findIndex((event) => event.includes(second))
    return last !== -1 && next !== -1 && last < next
  }

  identity(version: string): string {
    return `{"schemaVersion":1,"version":"${version}","commit":"${this.source}"}\n`
  }

  manifest(version: string): string {
    return `{"schemaVersion":1,"runtime":"claude","version":"${version}","commit":"${this.source}"}\n`
  }

  hasRemoteTag(tag: string): boolean {
    return gitOk(this.origin, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`)
  }

  assertAborted(code: number, message: string): void {
    assert.equal(code, 1, this.output.stderr)
    assert.ok(this.output.stderr.includes(`${ABORT}${message}`), this.output.stderr)
  }
}

/** Carpeta temporal de un archivo de tests, con git aislado de la config del usuario. */
export class Workspace {
  readonly dir: string
  private readonly restoreGitConfig: () => void
  private count = 0
  private base: ReleaseSandbox | undefined
  private preparedBase: ReleaseSandbox | undefined
  private syncedBase: ReleaseSandbox | undefined

  constructor(prefix: string) {
    this.dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
    this.restoreGitConfig = isolateGitConfig(this.dir)
  }

  private next(): string {
    return join(this.dir, `caso-${++this.count}`)
  }

  /** Repo listo para la fase prepare; `files` sustituye o agrega archivos del commit base. */
  sandbox(files?: Record<string, string>): ReleaseSandbox {
    if (files !== undefined) return ReleaseSandbox.build(this.next(), files)
    this.base ??= ReleaseSandbox.build(this.next())
    return this.base.copyTo(this.next())
  }

  /** Repo con la release ya preparada y su PR sin mergear. */
  prepared(): ReleaseSandbox {
    if (this.preparedBase === undefined) {
      this.preparedBase = this.sandbox()
      this.preparedBase.prepareOnly()
    }
    return this.preparedBase.copyTo(this.next())
  }

  /** Repo listo para la fase publish: release preparada, PR mergeado y main sincronizado. */
  synced(): ReleaseSandbox {
    if (this.syncedBase === undefined) {
      this.syncedBase = this.prepared()
      this.syncedBase.mergeAndSync()
    }
    return this.syncedBase.copyTo(this.next())
  }

  dispose(): void {
    this.restoreGitConfig()
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Commit al que apunta `tag` en el remoto. */
export function remoteTag(sb: ReleaseSandbox, tag: string): string {
  return git(sb.origin, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`)
}
