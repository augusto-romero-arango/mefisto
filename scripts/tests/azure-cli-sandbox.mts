// Arnes de los tests de los scripts que operan Azure y GitHub por CLI: repos consumidores
// temporales y un `run` falso que registra cada invocacion. Ningun test llama a un CLI real.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CommandOptions, CommandResult } from '../lib/cli.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')
export const SCRIPTS = join(REPO_ROOT, 'scripts')
export const DIST_SCRIPTS = join(REPO_ROOT, 'dist', 'claude', 'scripts')

export interface Call {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv | undefined
}

export type Respond = (call: Call) => Partial<CommandResult> | undefined

/** `run` falso: responde lo que diga `respond` (por defecto, exito sin salida) y anota la llamada. */
export class FakeCli {
  readonly calls: Call[] = []
  respond: Respond

  constructor(respond: Respond = () => undefined) {
    this.respond = respond
  }

  run = (command: string, args: string[], options?: CommandOptions): CommandResult => {
    const call: Call = { command, args, env: options?.env }
    this.calls.push(call)
    return { status: 0, stdout: '', stderr: '', ...this.respond(call) }
  }

  /** Cada llamada como una linea `comando arg arg`. */
  get log(): string[] {
    return this.calls.map((call) => [call.command, ...call.args].join(' '))
  }

  count(fragment: string): number {
    return this.log.filter((line) => line.includes(fragment)).length
  }
}

/** Valor del argumento que sigue a `flag`, o vacio. */
export function option(call: Call, flag: string): string {
  const index = call.args.indexOf(flag)
  return index === -1 ? '' : (call.args[index + 1] ?? '')
}

export function starts(call: Call, command: string, ...args: string[]): boolean {
  return call.command === command && args.every((arg, index) => call.args[index] === arg)
}

export interface Sandbox {
  /** Carpeta temporal, por su ruta real. */
  work: string
  /** Repo git vacio bajo `work`. */
  repo: (name: string) => string
  /** Repo git con `.claude-plugin/plugin.json`, como el de Mefisto. */
  pluginRepo: (name: string) => string
  remove: () => void
}

export function sandbox(label: string): Sandbox {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), `mefisto ${label} `)))
  const repo = (name: string): string => {
    const dir = join(work, name)
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '--quiet', dir])
    return dir
  }
  return {
    work,
    repo,
    pluginRepo: (name) => {
      const dir = repo(name)
      mkdirSync(join(dir, '.claude-plugin'))
      writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{}\n')
      return dir
    },
    remove: () => rmSync(work, { recursive: true, force: true }),
  }
}

export const BASE_CONFIG = {
  projectName: 'Prueba',
  namespacePrefix: 'Prueba.Backend',
  solutionFile: 'Prueba.slnx',
  infraResourceGroupPrefix: 'rg-prueba',
  terraformStateStorage: 'stpruebatfstate',
  githubServicePrincipalName: 'github-prueba-ci',
  appInsightsApp: 'appi-prueba',
  domainLabels: ['prueba'],
  boundedContext: { name: 'Principal', domains: ['prueba'] },
}

/** Escribe `harness.config.json` en `.mefisto/` (o en `.claude/` con `legacy`) y devuelve su ruta. */
export function writeConfig(repo: string, config: object, legacy = false): string {
  const dir = join(repo, legacy ? '.claude' : '.mefisto')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'harness.config.json')
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Lineas de codigo de un script, sin las de comentario. */
export function codeLines(script: string): string[] {
  return readFileSync(script, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
}

function sameFile(left: string, right: string): boolean {
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

/**
 * Falla si alguno de `files` (relativos a `scripts/`) no esta en `dist/claude/scripts` identico
 * e inventariado, o si un shim `.sh` perdio su bit de ejecucion.
 */
export function assertDistributed(files: string[]): void {
  const inventory = JSON.parse(
    readFileSync(join(REPO_ROOT, 'dist', 'claude', '.mefisto-generated-assets.json'), 'utf8'),
  ) as { assets: { destination: string }[] }
  const destinations = inventory.assets.map((asset) => asset.destination)
  for (const file of files) {
    const copy = join(DIST_SCRIPTS, ...file.split('/'))
    assert.ok(sameFile(copy, join(SCRIPTS, ...file.split('/'))), `${file}: falta en dist o difiere`)
    assert.ok(destinations.includes(`scripts/${file}`), `${file}: fuera del inventario`)
    if (file.endsWith('.sh') && process.platform !== 'win32') {
      assert.notEqual(statSync(copy).mode & 0o111, 0, `${file}: sin bit de ejecucion`)
    }
  }
}

export interface Spawned {
  status: number | null
  stdout: string
  stderr: string
}

/** Corre un `.mts` con Node desde `cwd`, sin buscar un repo git por encima de `ceiling`. */
export function runScript(script: string, args: string[], cwd: string, ceiling: string): Spawned {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: ceiling },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
