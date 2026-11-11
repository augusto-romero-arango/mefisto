// Provisiona el esquema de labels del proyecto en GitHub: borra 8 de los 9 labels default,
// recrea "bug" con el esquema del harness y crea el resto del esquema dimensional.
//
// Los labels de dominio (dom:*) salen de `domainLabels` del contrato canonico
// `.mefisto/harness.config.json` (`.claude/harness.config.json` solo como fallback de lectura,
// MEF-ADR-0053 decision 4).
//
// Uso: node scripts/setup-github-labels.mts
// Prerequisito: gh auth login

import { CliError, capture, isEntryPoint } from './lib/cli.mts'
import type { CommandOptions, CommandResult } from './lib/cli.mts'
import { consumerRepoRoot } from './lib/consumer-guard.mts'
import { loadHarnessConfig } from './lib/harness-config.mts'

export interface LabelsDeps {
  cwd: string
  run: (command: string, args: string[], options?: CommandOptions) => CommandResult
  out: (line: string) => void
  err: (line: string) => void
}

export const DEFAULT_LABELS = [
  'documentation',
  'duplicate',
  'enhancement',
  'good first issue',
  'help wanted',
  'invalid',
  'question',
  'wontfix',
]

interface Label {
  name: string
  color: string
  description: string
}

interface Section {
  heading: string
  labels: Label[]
}

/** Secciones del esquema, en el orden en que se crean. */
export function labelSections(domainLabels: string[]): Section[] {
  const blue = (name: string, description: string): Label => ({ name, color: '0052CC', description })
  return [
    {
      heading: 'Creando labels de tipo (azul)...',
      labels: [
        blue('tipo:feature', 'Funcionalidad nueva de dominio'),
        blue('tipo:infra', 'Infraestructura Azure / Terraform'),
        blue('tipo:refactor', 'Reestructuracion sin comportamiento nuevo'),
        blue('tipo:tooling', 'Mejoras a pipeline, agentes o scripts'),
        blue('tipo:projection', 'Proyeccion Marten y query read-side'),
      ],
    },
    {
      heading: 'Creando labels de origen (naranja)...',
      labels: [
        {
          name: 'bug',
          color: 'D93F0B',
          description: 'Correccion de defecto — siempre acompanado de un tipo: que indica el pipeline',
        },
      ],
    },
    {
      heading: 'Creando labels de dominio (verde) desde harness.config.json...',
      labels: domainLabels
        .join(' ')
        .split(/[ \t\n]+/)
        .filter((domain) => domain.length > 0)
        .map((domain) => ({ name: `dom:${domain}`, color: '0E8A16', description: `Dominio ${domain}` })),
    },
    {
      heading: 'Creando labels de estado (amarillo/rojo)...',
      labels: [
        {
          name: 'estado:borrador',
          color: 'FBCA04',
          description: 'Idea capturada - requiere refinamiento antes del pipeline',
        },
        { name: 'estado:listo', color: 'B60205', description: 'Refinado y listo para pipeline TDD o IaC' },
      ],
    },
    {
      heading: 'Creando labels especiales...',
      labels: [
        { name: 'bloqueado', color: 'D93F0B', description: 'Depende de otro issue aun no cerrado' },
        {
          name: 'warning',
          color: 'E4E669',
          description: 'Warning nuevo que el pipeline no pudo remediar (MEF-ADR-0056)',
        },
      ],
    },
  ]
}

function relay(text: string, sink: (line: string) => void): void {
  if (text.length > 0) sink(text.replace(/\r?\n$/, ''))
}

function run(deps: LabelsDeps): number {
  consumerRepoRoot(deps.cwd, [
    'ERROR: scripts/setup-github-labels.sh es del plugin publicado y solo aplica al consumidor.',
    'Los labels de Mefisto se configuran manualmente o con un script interno.',
  ])
  const config = loadHarnessConfig(undefined, { cwd: deps.cwd, warn: deps.err })
  const gh = (args: string[]): CommandResult => deps.run('gh', args, { cwd: deps.cwd })
  /** Codigo de salida con el que termina el script, o `null` si `gh` termino bien. */
  const failure = (result: CommandResult): number | null => {
    relay(result.stdout, deps.out)
    if (result.status === null) {
      deps.err('gh: command not found')
      return 127
    }
    relay(result.stderr, deps.err)
    return result.status === 0 ? null : result.status
  }

  deps.out('Eliminando labels default de GitHub...')
  for (const label of DEFAULT_LABELS) {
    const deleted = gh(['label', 'delete', label, '--yes'])
    relay(deleted.stdout, deps.out)
    deps.out(deleted.status === 0 ? `  - eliminado: ${label}` : `  - no encontrado (ok): ${label}`)
  }

  for (const section of labelSections(config.domainLabels)) {
    deps.out('')
    deps.out(section.heading)
    for (const label of section.labels) {
      const exit = failure(
        gh([
          'label',
          'create',
          label.name,
          '--color',
          label.color,
          '--description',
          label.description,
          '--force',
        ]),
      )
      if (exit !== null) return exit
    }
  }

  deps.out('')
  deps.out('Listo. Labels actuales:')
  return failure(gh(['label', 'list'])) ?? 0
}

export function setupGithubLabels(deps: LabelsDeps): number {
  try {
    return run(deps)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deps.err(error.message)
    return error.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = setupGithubLabels({
    cwd: process.cwd(),
    run: capture,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
