// Corte vertical de los agentes neutrales del pipeline TDD: contrato de la fuente, proyeccion
// Claude, rutas de estado y conocimiento que cada agente abre desde la release activa, incluida la
// resolucion ejecutable del preambulo de la raiz del paquete.

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { NO_BASH, runBashStreams } from '../../../../scripts/tests/markdown-bash.mts'
import {
  REPO_ROOT,
  fencedBlocks,
  linesOf,
  matchingLines,
  repoPath,
} from '../../../../scripts/tests/text-contract.mts'
import { packageRootPreamble, translateBody } from '../lib/adapter-claude.mts'
import {
  effectiveContractPreamble,
  needsConfigPath,
  needsInstructionsPath,
} from '../lib/effective-contract.mts'
import { chomp } from '../lib/published-source.mts'
import {
  GUARD,
  agent,
  bodyLines,
  check,
  distributionIsCurrent,
  generatedMarker,
  isRegularFile,
  metadataMatches,
  readInventory,
  repoText,
  sameBytes,
  sha256Of,
  sourceValidates,
} from './agent-contract-kit.mts'
import type { Agent } from './agent-contract-kit.mts'

const WORK = mkdtempSync(join(tmpdir(), 'mefisto tdd agents '))

after(() => {
  rmSync(WORK, { recursive: true, force: true })
})

interface TddAgent {
  id: string
  description: string
  profile: 'balanced' | 'deep'
  /** `null` si la fuente no declara Skills. */
  skills: string[] | null
  /** Preambulos que la proyeccion Claude antepone al cuerpo. */
  preambles: 'raiz' | 'raiz-y-contrato'
}

// La lista es el unico punto que los siguientes cortes de la serie deben ampliar.
const AGENTS: TddAgent[] = [
  {
    id: 'test-writer',
    description: 'Escribe tests ES (fase roja TDD) con DSL Given/When/Then y stubs minimos de compilacion.',
    profile: 'balanced',
    skills: ['code-comments'],
    preambles: 'raiz-y-contrato',
  },
  {
    id: 'implementer',
    description:
      'Implementa logica de negocio (fase verde TDD) con event sourcing. AggregateRoots, CommandHandlers, Service Bus.',
    profile: 'balanced',
    skills: ['code-comments'],
    preambles: 'raiz-y-contrato',
  },
  {
    id: 'reviewer',
    description:
      'Revisa y refactoriza el código producido en las fases roja y verde del pipeline ES (fase refactor). Verifica patrones de event sourcing y mantiene todos los tests pasando.',
    profile: 'deep',
    skills: ['projections', 'code-comments'],
    preambles: 'raiz',
  },
  {
    id: 'smoke-test-writer',
    description:
      'Escribe smoke tests black-box contra el entorno dev desplegado. Asume que el proyecto SmokeTests ya existe.',
    profile: 'balanced',
    skills: ['projections', 'code-comments'],
    preambles: 'raiz-y-contrato',
  },
  {
    id: 'projection-test-writer',
    description:
      'Escribe tests read-side (fase roja TDD) de proyecciones Marten -- unit tests de Create/Apply/ShouldDelete, config-test del worker y composicion de la Function GET. Nunca implementa.',
    profile: 'balanced',
    skills: ['projections', 'code-comments'],
    preambles: 'raiz-y-contrato',
  },
  {
    id: 'projection-implementer',
    description:
      'Implementa proyecciones Marten (read models), el seam de registro read-side (Configurar{Dominio}) y las Functions HTTP GET de consulta. Nunca modifica tests.',
    profile: 'balanced',
    skills: ['projections', 'code-comments'],
    preambles: 'raiz-y-contrato',
  },
  {
    id: 'domain-scaffolder',
    description: 'Crea el scaffold completo para un nuevo dominio (Function App, tests, Terraform, GitHub Actions).',
    profile: 'balanced',
    skills: null,
    preambles: 'raiz-y-contrato',
  },
]

// Agente, summary de su etapa y si reporta bloqueo (exige al menos una mencion) o no (ninguna).
const STATE_AGENTS: [id: string, summary: string, reportsBlockage: boolean][] = [
  ['test-writer', 'stage-1-test-writer', false],
  ['implementer', 'stage-2-implementer', true],
  ['reviewer', 'stage-3-reviewer', true],
  ['smoke-test-writer', 'stage-2b-smoke-test-writer', false],
  ['projection-test-writer', 'stage-1-projection-test-writer', false],
  ['projection-implementer', 'stage-2-projection-implementer', false],
]

const BLOCKAGE_REF = '{{mefisto:state-path blockage-report.md}}'

/** `ok` o la condicion incumplida; no depende de un conteo exacto. */
function blockageVerdict(text: string, reports: boolean): string {
  const mentions = matchingLines(text, BLOCKAGE_REF).length
  if (reports) {
    return mentions >= 1 ? 'ok' : 'reporta bloqueo pero no menciona la ruta neutral (0 menciones)'
  }
  return mentions === 0 ? 'ok' : `no reporta bloqueo pero menciona la ruta neutral (${mentions} menciones)`
}

// Lineas que el adaptador pone o traduce por su cuenta: el guard y el marcador de generado.
const ADAPTER_LINES = [
  /\{\{mefisto:assert-consumer-repo\}\}/,
  // El punto de `.sh` es comodin, como en el patron de awk del que viene.
  /Antes de continuar, aborta si existe `src\/internal\/scripts\/generate-internal-adapters.mts`/,
  /^<!-- GENERADO por /,
  /^Antes de ejecutar este body, usa la tool nativa `skill` para cargar, en este orden: /,
]

function ownBodyLines(text: string): string[] {
  return bodyLines(text).filter((line) => !ADAPTER_LINES.some((pattern) => pattern.test(line)))
}

const lined = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('')

/** Cuerpo que el adaptador Claude debe publicar para `published`: preambulos y cuerpo traducido. */
function expectedBody(published: Agent, preambles: TddAgent['preambles']): string {
  const raw = chomp(lined(ownBodyLines(published.source)))
  const parts = [packageRootPreamble()]
  if (preambles === 'raiz-y-contrato') {
    const [config, instructions] = [needsConfigPath(raw), needsInstructionsPath(raw)]
    if (config || instructions) parts.push(effectiveContractPreamble(config, instructions))
  }
  parts.push(translateBody(published.sourcePath, raw))
  return lined(parts)
}

describe('[fuentes] contrato neutral, guard y doctrina preservada', () => {
  for (const { id, description, profile, skills, preambles } of AGENTS) {
    const published = agent(id)
    const keys = ['capabilities', 'description', 'effort', 'id', 'kind', 'mode', 'profile']
    check(`${id} valida`, () => sourceValidates(repoPath(published.sourcePath)), `${id} no valida`)
    check(
      `${id} declara el contrato neutral exacto`,
      () =>
        metadataMatches(published.metadata, {
          equal: {
            kind: 'agent',
            id,
            description,
            mode: 'all',
            profile,
            capabilities: skills === null ? ['read', 'edit', 'shell'] : ['read', 'edit', 'shell', 'skill'],
            ...(skills === null ? {} : { skills }),
          },
          without: skills === null ? ['skills'] : [],
          keys: skills === null ? keys : [...keys, 'skills'],
        }),
      `${id} no declara el contrato neutral exacto`,
    )
    check(
      `${id} inicia con el guard`,
      () => bodyLines(published.source).find((line) => /[^ \t]/.test(line)) === GUARD,
      `${id} no inicia con el guard`,
    )
    check(
      `${id} generado conserva marcador`,
      () => linesOf(published.mirror).includes(generatedMarker(id)),
      `${id} generado sin marcador`,
    )
    const projected = (): boolean => expectedBody(published, preambles) === lined(ownBodyLines(published.mirror))
    if (preambles === 'raiz') {
      check(
        `${id} conserva exactamente un preambulo y el cuerpo traducido al proyectar Claude`,
        projected,
        `${id} altera el preambulo o el cuerpo al proyectar Claude`,
      )
    } else {
      check(
        `${id} conserva exactamente ambos preambulos y el cuerpo traducido al proyectar Claude`,
        projected,
        `${id} altera alguno de los preambulos o el cuerpo al proyectar Claude`,
      )
    }
    if (id !== 'domain-scaffolder') continue

    const separators = (text: string): number => bodyLines(text).filter((line) => line === '---').length
    check(
      'domain-scaffolder conserva las cuatro lineas documentadas y los demas separadores del cuerpo',
      () => separators(published.source) >= 4 && separators(published.source) === separators(published.mirror),
      'domain-scaffolder altera los separadores del cuerpo',
    )
    const removals = matchingLines(published.source, /^[ \t\v\f\r]*rm /).map((line) => line.text)
    check(
      'domain-scaffolder normaliza las ocho eliminaciones de plantillas a rutas relativas sin comillas',
      () =>
        removals.filter((line) => line.startsWith('rm ')).length === 8 &&
        removals.every((line) => /^rm -r?f (src|tests)\/[^ "$]+$/.test(line)),
      'domain-scaffolder no conserva la forma canonica de las ocho eliminaciones de plantillas',
    )
    check(
      'domain-scaffolder no usa REPO_ROOT, comillas ni temporales al eliminar plantillas',
      () => removals.every((line) => !/\$REPO_ROOT|"|\$temporal/.test(line)),
      'domain-scaffolder conserva REPO_ROOT, comillas o temporales al eliminar plantillas',
    )
  }
})

describe('[estado] rutas neutrales de los agentes TDD', () => {
  for (const [id, stage, reportsBlockage] of STATE_AGENTS) {
    const source = repoText(`src/published/agents/${id}.md`)
    const summary = `{{mefisto:state-path summaries/${stage}.md}}`
    check(
      `${id} no conserva rutas legacy de estado`,
      () =>
        !source.includes('.claude/pipeline/summaries') &&
        !source.includes('.claude/pipeline/blockage-report') &&
        !source.includes('`.claude/pipeline/`'),
      `${id} conserva rutas legacy de estado`,
    )
    check(
      `${id} declara su summary neutral exacto`,
      () => matchingLines(source, summary).length === 1,
      `${id} no declara su summary neutral exacto`,
    )
    const verdict = blockageVerdict(source, reportsBlockage)
    check(
      `${id} declara las rutas neutrales esperadas de bloqueo`,
      () => verdict === 'ok',
      `${id} no declara las rutas neutrales esperadas de bloqueo: ${verdict}`,
    )
  }
})

describe('[estado] regresion: la asercion de bloqueo no depende de un conteo exacto', () => {
  const implementer = `${repoText('src/published/agents/implementer.md')}\n${BLOCKAGE_REF}\n`
  check(
    'implementer con una mencion extra sigue en verde',
    () => blockageVerdict(implementer, true) === 'ok',
    'implementer con una mencion extra rompe la asercion',
  )
  const silenced = lined(linesOf(implementer).filter((line) => !line.includes(BLOCKAGE_REF)))
  check(
    'implementer sin ninguna mencion da FAIL',
    () => blockageVerdict(silenced, true) !== 'ok',
    'implementer sin menciones no es detectado',
  )
  const testWriter = `${repoText('src/published/agents/test-writer.md')}\n${BLOCKAGE_REF}\n`
  check(
    'test-writer con una mencion de bloqueo da FAIL',
    () => blockageVerdict(testWriter, false) !== 'ok',
    'test-writer con una mencion de bloqueo no es detectado',
  )
})

describe('[validador] excepciones transitorias acotadas', () => {
  let fixtures = 0

  /** `true` si el validador rechaza la fuente de `id` con `extra` como unica linea de cuerpo. */
  function rejects(id: string, extra: string): boolean {
    const dir = join(WORK, `validador-${++fixtures}`)
    mkdirSync(dir)
    const fixture = join(dir, `${id}.md`)
    const frontmatter = linesOf(repoText(`src/published/agents/${id}.md`)).slice(1)
    const close = frontmatter.indexOf('---')
    writeFileSync(
      fixture,
      `---\n${lined(close === -1 ? frontmatter : frontmatter.slice(0, close))}---\n\n${GUARD}\n${extra}\n`,
    )
    return !sourceValidates(fixture)
  }

  for (const { id } of AGENTS) {
    check(
      `${id} rechaza metadata de runtime nueva`,
      () => rejects(id, 'model: runtime-inyectado'),
      `${id} no admite metadata de runtime nueva`,
    )
    check(
      `${id} rechaza placeholders arbitrarios`,
      () => rejects(id, 'Variable ajena: $TOKEN_AJENO'),
      `${id} no admite placeholders arbitrarios`,
    )
  }
  check(
    'reviewer rechaza placeholders exclusivos de test-writer',
    () => rejects('reviewer', 'Posicional ajeno: $2'),
    'reviewer no hereda placeholders exclusivos de test-writer',
  )
  check(
    'implementer rechaza referencias a un runtime concreto tras salir de la excepcion legacy (#1430)',
    () => rejects('implementer', 'Este agente corre dentro de Claude Code'),
    'implementer aun admite referencias a un runtime concreto tras salir de la excepcion legacy (#1430)',
  )
  check(
    'implementer rechaza vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1430)',
    () => rejects('implementer', 'Se instala desde el marketplace del plugin'),
    'implementer aun admite vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1430)',
  )
  check(
    'test-writer rechaza el placeholder de raiz legacy',
    () => rejects('test-writer', 'Ruta legacy: $PLUGIN_ROOT'),
    'test-writer aun admite el placeholder de raiz legacy',
  )
  check(
    'projection-implementer rechaza placeholders exclusivos de projection-test-writer',
    () => rejects('projection-implementer', 'Posicional ajeno: $2'),
    'projection-implementer no hereda placeholders exclusivos de projection-test-writer',
  )
  check(
    'smoke-test-writer rechaza placeholders de los agentes de proyeccion',
    () => rejects('smoke-test-writer', 'Ruta ajena: $PLUGIN_ROOT'),
    'smoke-test-writer no hereda placeholders de los agentes de proyeccion',
  )
  check(
    'smoke-test-writer rechaza referencias a un runtime concreto tras salir de la excepcion legacy (#1431)',
    () => rejects('smoke-test-writer', 'Este agente corre dentro de Claude Code'),
    'smoke-test-writer aun admite referencias a un runtime concreto tras salir de la excepcion legacy (#1431)',
  )
  check(
    'smoke-test-writer rechaza vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1431)',
    () => rejects('smoke-test-writer', 'Se instala desde el marketplace del plugin'),
    'smoke-test-writer aun admite vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1431)',
  )
})

describe('[salidas] proyeccion Claude', () => {
  for (const { id, profile, skills } of AGENTS) {
    const { claude, claudePath, mirrorPath } = agent(id)
    check(
      `${id} mirror Claude coincide byte a byte`,
      () => sameBytes(repoPath(claudePath), repoPath(mirrorPath)),
      `${id} mirror Claude diverge`,
    )
    check(
      `${id} no filtra directivas a la salida`,
      () => !claude.includes('{{mefisto:'),
      `${id} filtra directivas a la salida`,
    )
    if (profile === 'deep') {
      check(
        `${id} Claude materializa deep como opus`,
        () => claude.includes('model: "opus"'),
        `${id} Claude no materializa opus`,
      )
    } else {
      check(
        `${id} Claude materializa balanced como sonnet`,
        () => claude.includes('model: "sonnet"'),
        `${id} Claude no materializa sonnet`,
      )
    }
    if (skills === null) {
      check(
        `${id} Claude materializa capacidades`,
        () => claude.includes('tools: "Read, Glob, Grep, Edit, Write, Bash"'),
        `${id} Claude no materializa capacidades`,
      )
      continue
    }
    check(
      `${id} Claude materializa capacidades y Skill`,
      () => claude.includes('tools: "Read, Glob, Grep, Edit, Write, Bash, Skill"'),
      `${id} Claude no materializa Skill`,
    )
    check(
      `${id} Claude conserva skills`,
      () => claude.includes(`skills: ${JSON.stringify(skills)}`),
      `${id} Claude no conserva skills`,
    )
  }
})

const ADR = {
  testing: 'mef-adr-0002-estrategia-testing-event-sourcing.md',
  functionNaming: 'mef-adr-0006-convenciones-nombramiento-funciones-azure.md',
  testNaming: 'mef-adr-0016-convencion-naming-tests.md',
  tenancy: 'mef-adr-0028-estrategia-tenancy.md',
  hostComposition: 'mef-adr-0029-test-composicion-host.md',
  projectionsWorker: 'mef-adr-0034-worker-proyecciones-read-models.md',
  readSide: 'mef-adr-0035-doctrina-proyeccion-query-read-side.md',
  ownView: 'mef-adr-0041-forma-propia-vista-read-side.md',
}

const PACKAGE_ROOT_ASSIGNMENT = 'MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"'
// El punto de `.claude` es comodin, como en el patron de grep del que viene.
const LEGACY_RESOLVER = /PLUGIN_ROOT=|plugins\/cache|\$HOME\/.claude/
const LEGACY_RESOLVER_IN_SOURCE = /\.claude\/pipeline\/\.plugin-root|PLUGIN_ROOT=|plugins\/cache|\$HOME\/.claude/
const LEGACY_RESOLVER_OR_RUNTIME_IN_SOURCE =
  /\.claude\/pipeline\/\.plugin-root|PLUGIN_ROOT=|plugins\/cache|\$HOME\/.claude|Claude/

interface Artifact {
  /** Carpeta que contiene el artefacto, como lo nombran los mensajes. */
  label: string
  isSource: boolean
  text: string
  packageRoot: string
  skillRoot: string
}

/** Fuente neutral, espejo raiz y proyeccion Claude de un agente, en ese orden. */
function artifactsOf(id: string): Artifact[] {
  const { sourcePath, mirrorPath, claudePath } = agent(id)
  return [sourcePath, mirrorPath, claudePath].map((path) => {
    const isSource = path === sourcePath
    return {
      label: posix.basename(posix.dirname(path)),
      isSource,
      text: repoText(path),
      packageRoot: isSource ? '{{mefisto:package-root}}' : '${MEFISTO_PACKAGE_ROOT}',
      skillRoot: isSource ? '{{mefisto:skill-root projections}}' : '${MEFISTO_PACKAGE_ROOT}/skills/projections',
    }
  })
}

const allFilesUnder = (root: string, files: string[]): boolean =>
  files.every((file) => isRegularFile(join(root, ...file.split('/'))))

describe('[conocimiento] test-writer usa la release activa', () => {
  for (const { label, isSource, text, packageRoot } of artifactsOf('test-writer')) {
    check(
      `${label} test-writer resuelve ADRs y cheatsheet desde package root`,
      () =>
        [
          `${packageRoot}/docs/adr/${ADR.testing}`,
          `${packageRoot}/docs/adr/${ADR.testNaming}`,
          `${packageRoot}/docs/testing/harness-cheatsheet.md`,
        ].every((path) => text.includes(path)),
      `${label} test-writer no resuelve todo el conocimiento desde package root`,
    )
    if (!isSource) {
      check(
        `${label} cita el conocimiento con raiz que preserva espacios`,
        () =>
          matchingLines(text, PACKAGE_ROOT_ASSIGNMENT).length === 1 &&
          text.includes('cat "${MEFISTO_PACKAGE_ROOT}/docs/testing/harness-cheatsheet.md"'),
        `${label} no cita el conocimiento con raiz segura`,
      )
    }
    check(
      `${label} no conserva resolver de runtime legado`,
      () => matchingLines(text, isSource ? LEGACY_RESOLVER_IN_SOURCE : LEGACY_RESOLVER).length === 0,
      `${label} conserva resolver de runtime legado`,
    )
  }

  check(
    'claude contiene el conocimiento que test-writer abre desde package root',
    () =>
      allFilesUnder(repoPath('dist/claude'), [
        `docs/adr/${ADR.testing}`,
        `docs/adr/${ADR.testNaming}`,
        'docs/testing/harness-cheatsheet.md',
      ]),
    'claude no empaqueta todo el conocimiento requerido por test-writer',
  )
})

const SKILL_RESOURCES = ['modelos-marten.md', 'naming.md', 'read-apis.md', 'config-test.md']

/** Casos de un agente que abre ADRs y recursos del Skill `projections` desde la release activa. */
function knowledgeCases(id: string, adrs: string[], quotedPaths: boolean): void {
  for (const { label, isSource, text, packageRoot, skillRoot } of artifactsOf(id)) {
    const unquoted = text.replaceAll('"', '')
    check(
      `${label} ${id} resuelve ADRs y Skill desde la release activa`,
      () =>
        [
          ...adrs.map((adr) => `${packageRoot}/docs/adr/${adr}`),
          ...SKILL_RESOURCES.map((resource) => `${skillRoot}/${resource}`),
        ].every((path) => unquoted.includes(path)),
      `${label} ${id} no resuelve todo el conocimiento desde la release activa`,
    )
    if (!isSource && quotedPaths) {
      const quotedSkill = (resource: string): boolean => {
        const root = text.indexOf('"${MEFISTO_PACKAGE_ROOT}/skills/')
        return root !== -1 && text.includes(`"/${resource}`, root + '"${MEFISTO_PACKAGE_ROOT}/skills/'.length)
      }
      check(
        `${label} ${id} conserva rutas citables con espacios`,
        () =>
          text.includes(`"\${MEFISTO_PACKAGE_ROOT}/docs/adr/${ADR.readSide}"`) &&
          text.includes(`"\${MEFISTO_PACKAGE_ROOT}/docs/adr/${ADR.testing}"`) &&
          quotedSkill('modelos-marten.md') &&
          quotedSkill('config-test.md'),
        `${label} ${id} deja rutas sensibles a espacios sin citar`,
      )
    }
    if (!isSource) {
      check(
        `${label} ${id} conserva un solo preambulo que preserva espacios`,
        () => matchingLines(text, PACKAGE_ROOT_ASSIGNMENT).length === 1,
        `${label} ${id} no conserva el preambulo de package root`,
      )
    }
    check(
      `${label} ${id} no conserva resolucion de runtime legado`,
      () =>
        matchingLines(text, isSource ? LEGACY_RESOLVER_OR_RUNTIME_IN_SOURCE : LEGACY_RESOLVER).length === 0,
      `${label} ${id} conserva resolucion de runtime legado`,
    )
  }
}

const PROJECTION_IMPLEMENTER_ADRS = [
  ADR.readSide,
  ADR.projectionsWorker,
  ADR.functionNaming,
  ADR.ownView,
  ADR.tenancy,
  ADR.hostComposition,
]

describe('[conocimiento] reviewer usa la release activa y el Skill adaptado', () => {
  knowledgeCases('reviewer', [ADR.testNaming], false)
})

describe('[conocimiento] projection-implementer usa la release activa y el Skill adaptado', () => {
  knowledgeCases('projection-implementer', PROJECTION_IMPLEMENTER_ADRS, false)
})

describe('[conocimiento] projection-test-writer usa la release activa y el Skill adaptado', () => {
  knowledgeCases(
    'projection-test-writer',
    [ADR.readSide, ADR.projectionsWorker, ADR.functionNaming, ADR.ownView, ADR.testNaming, ADR.testing],
    true,
  )

  const skillResources = SKILL_RESOURCES.map((resource) => `skills/projections/${resource}`)
  check(
    'el paquete claude contiene el conocimiento que projection-implementer abre desde su raiz',
    () =>
      allFilesUnder(REPO_ROOT, [
        ...PROJECTION_IMPLEMENTER_ADRS.map((adr) => `docs/adr/${adr}`),
        ...skillResources,
      ]),
    'el paquete claude no contiene todo el conocimiento requerido por projection-implementer',
  )
  check(
    'el paquete claude contiene el conocimiento que reviewer abre desde su raiz',
    () => allFilesUnder(REPO_ROOT, [`docs/adr/${ADR.testNaming}`, ...skillResources]),
    'el paquete claude no contiene todo el conocimiento requerido por reviewer',
  )

  const summary = '.mefisto/pipeline/summaries/stage-2b-smoke-test-writer.md'
  check(
    'los generados conservan el summary canonico de smoke stage 2b',
    () =>
      repoText('agents/smoke-test-writer.md').includes(summary) &&
      repoText('dist/claude/agents/smoke-test-writer.md').includes(summary),
    'los generados no conservan el summary canonico de smoke stage 2b',
  )
})

describe('[inventarios] clausura publicada actualizada', () => {
  check(
    'claude conserva un inventario completo con sha256',
    () => {
      const inventory = readInventory()
      const common = 'scripts/lib/cli.mts'
      const expected = sha256Of(repoPath(common))
      return (
        inventory.schemaVersion === 1 &&
        inventory.assets.length > 0 &&
        inventory.assets.every((asset) => typeof asset.sha256 === 'string' && /^[0-9a-f]{64}$/.test(asset.sha256)) &&
        inventory.assets.some(
          (asset) => asset.source === common && asset.destination === common && asset.sha256 === expected,
        )
      )
    },
    'claude tiene un inventario incompleto o sin sha256',
  )
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})

// MEF-ADR-0031: el preambulo de la proyeccion Claude, ejecutado con bash sobre una raiz con
// espacios, resuelve la raiz efectiva y desde ella se abren los ADRs y el Skill. En Windows, Git
// Bash imprime la raiz con su propia notacion de rutas.
const NO_POSIX_BASH = NO_BASH || (process.platform === 'win32' && 'Git Bash no imprime la ruta nativa')

describe('[conocimiento] los agentes generados abren ADRs y Skill desde el package root efectivo', { skip: NO_POSIX_BASH }, () => {
  const packageRoot = join(WORK, 'paquete Claude con espacios')
  const COPIES: [source: string, destination: string][] = [
    ['.claude-plugin/plugin.json', '.claude-plugin/plugin.json'],
    ['mefisto-manifest.json', 'mefisto-manifest.json'],
    // El preambulo valida la raiz con el verificador que ella misma trae.
    ['scripts/verify-package-root.mts', 'scripts/verify-package-root.mts'],
    ['scripts/lib/cli.mts', 'scripts/lib/cli.mts'],
    ...Object.values(ADR).map((adr): [string, string] => [`dist/claude/docs/adr/${adr}`, `docs/adr/${adr}`]),
    ...SKILL_RESOURCES.map((resource): [string, string] => [
      `skills/projections/${resource}`,
      `skills/projections/${resource}`,
    ]),
  ]

  function resolvesKnowledge(id: string, adrs: string[]): void {
    const preamble = (fencedBlocks(repoText(`dist/claude/agents/${id}.md`), 'bash')[0] ?? '').replaceAll(
      '${CLAUDE_PLUGIN_ROOT}',
      `${packageRoot}/`,
    )
    const checks = [
      ...adrs.map((adr) => `test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/${adr}" || exit 1`),
      ...SKILL_RESOURCES.map((resource) => `test -f "$MEFISTO_PACKAGE_ROOT/skills/projections/${resource}" || exit 1`),
      `printf '%s\\n' "$MEFISTO_PACKAGE_ROOT"`,
    ]
    const result = runBashStreams([preamble, ...checks].join('\n'), WORK)
    assert.deepEqual(
      [result.status, result.stdout],
      [0, `${realpathSync.native(packageRoot)}\n`],
      `${id} Claude generado no resuelve su conocimiento desde el package root efectivo: ${result.stderr}`,
    )
  }

  before(() => {
    for (const [source, destination] of COPIES) {
      const target = join(packageRoot, ...destination.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(repoPath(source), target)
    }
  })

  test('reviewer Claude generado abre ADRs y Skill desde un package root con espacios', () => {
    resolvesKnowledge('reviewer', [ADR.testNaming])
  })

  test('projection-implementer Claude generado abre ADRs y Skill desde un package root con espacios', () => {
    resolvesKnowledge('projection-implementer', PROJECTION_IMPLEMENTER_ADRS)
  })

  test('projection-test-writer Claude generado abre ADRs y Skill desde un package root con espacios', () => {
    resolvesKnowledge('projection-test-writer', [
      ADR.readSide,
      ADR.projectionsWorker,
      ADR.functionNaming,
      ADR.ownView,
      ADR.testNaming,
      ADR.testing,
    ])
  })
})
