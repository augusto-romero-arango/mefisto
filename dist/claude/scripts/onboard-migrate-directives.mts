// Migracion conservadora de directivas (issue #1080).
//
// Uso: node scripts/onboard-migrate-directives.mts --preview | --apply [--with-claude-bridge]
// (cwd = raiz del consumidor). El puente CLAUDE.md solo se crea o completa bajo el runtime
// "claude" o con --with-claude-bridge (MEF-ADR-0050/0053).

import { randomBytes } from 'node:crypto'
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, commandExists, isEntryPoint } from './lib/cli.mts'
import { checkConsumerDirectives, resolveOnboardRuntime } from './lib/consumer-directives.mts'
import { consumerRepoRoot } from './lib/consumer-guard.mts'
import { loadHarnessConfig } from './lib/harness-config.mts'
import type { HarnessConfig } from './lib/harness-config.mts'

export interface MigrateDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Carpeta de este script: de ella cuelga `../src/runtime/lib` para descubrir el runtime. */
  scriptDir: string
  hasCommand: (command: string) => boolean
  out: (line: string) => void
  err: (line: string) => void
}

export const USAGE = 'Uso: onboard-migrate-directives.sh --preview | --apply [--with-claude-bridge]'

interface Options {
  mode: '--preview' | '--apply'
  withClaudeBridge: boolean
}

function parseArgs(argv: string[]): Options {
  let mode: Options['mode'] | null = null
  let withClaudeBridge = false
  let usageError = false
  for (const arg of argv) {
    if (arg === '--with-claude-bridge') withClaudeBridge = true
    else if ((arg === '--preview' || arg === '--apply') && mode === null) mode = arg
    else usageError = true
  }
  if (usageError) throw new CliError(USAGE, 2)
  return { mode: mode ?? '--preview', withClaudeBridge }
}

/** `.boundedContext.domains | join(", ")` de jq, o `null` donde jq falla. */
export function boundedContextDomains(configPath: string): string | null {
  let root: unknown
  try {
    root = JSON.parse(readFileSync(configPath, 'utf8').replace(/^﻿/, '')) as unknown
  } catch {
    return null
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return null
  const context = (root as Record<string, unknown>).boundedContext
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return null
  const domains = (context as Record<string, unknown>).domains
  if (typeof domains !== 'object' || domains === null) return null
  const parts: string[] = []
  for (const domain of Object.values(domains) as unknown[]) {
    if (domain === null) parts.push('')
    else if (typeof domain === 'string') parts.push(domain)
    else if (typeof domain === 'object') return null
    else parts.push(JSON.stringify(domain))
  }
  return parts.join(', ')
}

/** Contenido del `AGENTS.md` nuevo: las dos secciones contractuales con los tokens del config. */
export function agentsContent(config: HarnessConfig, domains: string): string {
  return `### Tokens del harness

- **RootNamespace**: ${config.namespacePrefix}
- **SolutionFile**: ${config.solutionFile}
- **ProjectDisplayName**: ${config.projectName}
- **BoundedContext**: ${config.bcName}
- **BoundedContextDomains**: ${domains}

### Verificación de fuentes (obligatorio para agentes)

Antes de proponer o aplicar un ajuste técnico, verifica el enfoque contra la
**documentación oficial y vigente** de las tecnologías del stack (.NET, Azure
Functions, Marten, Wolverine, Azure Service Bus, Terraform, …). No te apoyes en
conocimiento memorizado: puede estar desactualizado. Al afirmar una best practice
o recomendación, **cita la fuente** (URL oficial, versión del paquete, ADR). Si un
dato no pudiste verificarlo contra la fuente, decláralo como *no verificado* en
tu propuesta en vez de darlo por cierto.
`
}

function can(path: string, mode: number): boolean {
  try {
    accessSync(path, mode)
    return true
  } catch {
    return false
  }
}

/** Corre `action`; cualquier fallo aborta con `message`. */
function step<T>(message: string, action: () => T): T {
  try {
    return action()
  } catch {
    throw new CliError(message)
  }
}

/** Archivo vacio de nombre impredecible junto a los destinos, para reemplazarlos con un rename. */
function createTemporary(root: string, prefix: string): string {
  const path = join(root, `${prefix}${randomBytes(3).toString('hex')}`)
  closeSync(openSync(path, 'wx', 0o600))
  return path
}

function run(argv: string[], deps: MigrateDeps): number {
  const options = parseArgs(argv)
  const root = consumerRepoRoot(deps.cwd, [
    'ERROR: /onboard no aplica al repo de Mefisto.',
    '       scripts/onboard-migrate-directives.sh es del plugin publicado y solo aplica al consumidor.',
  ])

  let config: HarnessConfig
  try {
    config = loadHarnessConfig(undefined, { cwd: deps.cwd, warn: deps.err })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(
      `${error.message}\nERROR: no se modifico ninguna directiva porque el config efectivo no es valido.`,
    )
  }

  const agents = join(root, 'AGENTS.md')
  const claude = join(root, 'CLAUDE.md')
  const domains = boundedContextDomains(config.configPath)
  if (domains === null) {
    throw new CliError(
      `ERROR: no se pudieron derivar los dominios desde ${config.configPath}; no se modificó nada.`,
    )
  }

  const runtime = resolveOnboardRuntime(deps.env, deps.scriptDir, deps.hasCommand)
  const bridgeEnabled = runtime === 'claude' || options.withClaudeBridge

  // Rechazar enlaces evita que una operacion publicada escape del consumidor.
  for (const destination of bridgeEnabled ? [agents, claude] : [agents]) {
    const name = basename(destination)
    if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new CliError(
        [
          `ERROR: ${name} es un enlace simbólico; no se siguen destinos fuera del consumidor.`,
          '       Reemplázalo conscientemente por un archivo regular y reintenta; no se modificó nada.',
        ].join('\n'),
      )
    }
    if (existsSync(destination) && !statSync(destination).isFile()) {
      throw new CliError(`ERROR: ${name} existe pero no es un archivo regular; no se modificó nada.`)
    }
  }

  // Preflight completo: ningun destino se toca antes de poder ejecutar todas las acciones
  // deterministas. Un AGENTS existente e incompleto no se fusiona.
  const check = checkConsumerDirectives(agents, claude, runtime)
  let createAgents = false
  let createClaude = false
  let addImport = false
  if (existsSync(agents)) {
    if (!can(agents, constants.R_OK)) {
      throw new CliError('ERROR: AGENTS.md existe pero no es legible; no se modifico nada.')
    }
    if (check.agentsState !== 'OK') {
      throw new CliError(
        [
          'ERROR: AGENTS.md existe pero esta incompleto; no se fusiona por heurística.',
          '       Complétalo manualmente con "Tokens del harness" y "Verificación de fuentes", y reintenta.',
        ].join('\n'),
      )
    }
  } else {
    if (!can(root, constants.W_OK)) {
      throw new CliError('ERROR: no hay permiso para crear AGENTS.md; no se modifico nada.')
    }
    createAgents = true
  }

  if (bridgeEnabled && existsSync(claude)) {
    if (!can(claude, constants.R_OK)) {
      throw new CliError('ERROR: CLAUDE.md existe pero no es legible; no se modifico nada.')
    }
    if (!check.bridgeHasImport) {
      if (!can(claude, constants.W_OK)) {
        throw new CliError('ERROR: CLAUDE.md no es escribible; no se modifico nada.')
      }
      addImport = true
    }
  } else if (bridgeEnabled) {
    if (!can(root, constants.W_OK)) {
      throw new CliError('ERROR: no hay permiso para crear CLAUDE.md; no se modifico nada.')
    }
    createClaude = true
  }

  deps.out('Plan de migración de directivas:')
  deps.out(
    createAgents
      ? `  - Crear AGENTS.md con las dos secciones contractuales y tokens derivados de ${config.configPath}.`
      : '  - Conservar AGENTS.md completo sin cambios.',
  )
  if (!bridgeEnabled) {
    deps.out(
      '  - Omitido (opcional): puente CLAUDE.md; solo lo requiere Claude Code. Usa --with-claude-bridge para crearlo o completarlo.',
    )
  } else if (createClaude) {
    deps.out('  - Crear CLAUDE.md con el puente mínimo @AGENTS.md.')
  } else if (addImport) {
    deps.out('  - Añadir una línea @AGENTS.md a CLAUDE.md, preservando todo su contenido.')
  } else {
    deps.out('  - Conservar CLAUDE.md: ya contiene el puente exacto.')
  }
  if (check.bridgeHasLegacy) {
    deps.out(
      '  - AVISO: CLAUDE.md conserva secciones contractuales legacy duplicadas; retíralas manualmente.',
    )
  }

  if (options.mode === '--preview') {
    deps.out(
      'Previsualización: no se escribió ningún archivo. Usa --apply solo tras la confirmación explícita de /onboard.',
    )
    return 0
  }

  const temporaries: string[] = []
  try {
    let agentsTemporary: string | null = null
    let claudeTemporary: string | null = null

    if (createAgents) {
      const temporary = step('ERROR: no se pudo preparar AGENTS.md; no se modificó nada.', () =>
        createTemporary(root, '.onboard-agents.'),
      )
      temporaries.push(temporary)
      step('ERROR: no se pudo preparar AGENTS.md; no se modificó ningún destino.', () =>
        writeFileSync(temporary, agentsContent(config, domains)),
      )
      step('ERROR: no se pudieron preparar los permisos de AGENTS.md; no se modificó ningún destino.', () =>
        chmodSync(temporary, 0o644),
      )
      agentsTemporary = temporary
    }

    if (createClaude || addImport) {
      const temporary = step('ERROR: no se pudo preparar CLAUDE.md; no se modificó ningún destino.', () =>
        createTemporary(root, '.onboard-claude.'),
      )
      temporaries.push(temporary)
      if (addImport) {
        step('ERROR: no se pudo copiar CLAUDE.md; no se modificó ningún destino.', () => {
          copyFileSync(claude, temporary)
          chmodSync(temporary, statSync(claude).mode & 0o7777)
        })
      } else {
        step('ERROR: no se pudieron preparar los permisos de CLAUDE.md; no se modificó ningún destino.', () =>
          chmodSync(temporary, 0o644),
        )
      }
      step('ERROR: no se pudo preparar el puente CLAUDE.md; no se modificó ningún destino.', () => {
        // La linea en blanco separa el import del contenido propio, termine o no en salto.
        appendFileSync(temporary, statSync(temporary).size > 0 ? '\n@AGENTS.md\n' : '@AGENTS.md\n')
      })
      claudeTemporary = temporary
    }

    if (agentsTemporary !== null) {
      const temporary = agentsTemporary
      step('ERROR: no se pudo crear AGENTS.md; no se modificó ningún destino.', () =>
        renameSync(temporary, agents),
      )
    }
    if (claudeTemporary !== null) {
      try {
        renameSync(claudeTemporary, claude)
      } catch {
        if (createAgents) rmSync(agents, { force: true })
        throw new CliError('ERROR: no se pudo actualizar CLAUDE.md; se revirtió la creación de AGENTS.md.')
      }
    }
  } finally {
    for (const temporary of temporaries) rmSync(temporary, { force: true })
  }

  deps.out('OK: migración conservadora aplicada.')
  if (check.bridgeHasLegacy) {
    deps.out(
      'AVISO: las secciones contractuales legacy de CLAUDE.md siguen allí y deben retirarse manualmente.',
    )
  }
  return 0
}

export function migrateDirectives(argv: string[], deps: MigrateDeps): number {
  try {
    return run(argv, deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deps.err(error.message)
    return error.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = migrateDirectives(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    scriptDir: dirname(fileURLToPath(import.meta.url)),
    hasCommand: commandExists,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
