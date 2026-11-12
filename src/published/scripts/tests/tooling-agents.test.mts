// Corte vertical de los agentes neutrales del pipeline de tooling: contrato de la fuente,
// snapshots de la proyeccion Claude, espejos raiz y clausura de tooling inventariada.

import { appendFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  INVENTORY_FILE,
  absent,
  agent,
  check,
  checkInto,
  closureAssets,
  contains,
  distributionIsCurrent,
  generateInto,
  generatedMarker,
  isRegularFile,
  metadataMatches,
  readInventory,
  readOrEmpty,
  regularFilesUnder,
  sameBytes,
  sha256Of,
  sourceValidates,
} from './agent-contract-kit.mts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tooling-agents')
const WRITER = agent('tooling-writer')
const REVIEWER = agent('tooling-reviewer')
const AGENTS = [WRITER, REVIEWER]
const SOURCES = AGENTS.map((each) => each.sourcePath)
const TOOLS = 'tools: "Read, Glob, Grep, Edit, Write, Bash, Skill"'
// La clausura sale de TOOLING_CLOSURE_ASSETS: nunca una segunda autoridad manual sobre su tamano
// o su contenido.
const CLOSURE = closureAssets()
const WORK = mkdtempSync(join(tmpdir(), 'mefisto tooling agents '))
const GENERATED = await generateInto(WORK, SOURCES)

after(() => {
  rmSync(WORK, { recursive: true, force: true })
})

const inWork = (relative: string): string => join(WORK, ...relative.split('/'))
const snapshot = (id: string): string => join(FIXTURES, `expected-claude-${id}.md`)

describe('[fuentes] contrato neutral y responsabilidades', () => {
  for (const each of AGENTS) {
    const { id } = each
    check(`${id} valida`, () => sourceValidates(repoPath(each.sourcePath)), `${id} no valida`)
    check(
      `${id} declara solo el contrato neutral esperado`,
      () =>
        metadataMatches(each.metadata, {
          equal: {
            kind: 'agent',
            id,
            mode: 'all',
            profile: each === REVIEWER ? 'deep' : 'balanced',
            capabilities: ['read', 'edit', 'shell', 'skill'],
            skills: ['code-comments'],
          },
          keys: ['capabilities', 'description', 'effort', 'id', 'kind', 'mode', 'profile', 'skills'],
        }),
      `${id} no declara el contrato neutral esperado`,
    )
    contains(each.body, '{{mefisto:assert-consumer-repo}}', `${id} conserva el guard`)
    contains(each.body, 'archivo de summary', `${id} declara el summary entregado`)
    for (const token of ['.claude/', '.mefisto/', 'Claude', 'model:', 'tools:', 'permission:']) {
      absent(each.body, token, `${id} no fija token de runtime o ruta de estado: ${token}`)
    }
  }
  const writer = WRITER.source
  const reviewer = REVIEWER.source
  contains(writer, 'scope exacto recibido', 'writer respeta el scope recibido')
  contains(writer, 'patrones existentes', 'writer lee patrones antes de editar')
  contains(writer, 'comandos de verificacion permitidos', 'writer limita sus verificaciones')
  contains(writer, 'no hagas preguntas', 'writer opera sin interaccion')
  contains(
    writer,
    'logica de dominio, artefactos de Mefisto o rutas fuera del scope',
    'writer bloquea trabajo ajeno al tooling permitido',
  )
  contains(writer, '## Implementado', 'writer declara Implementado')
  contains(writer, '## Verificacion', 'writer declara Verificacion')
  contains(writer, '## Pendiente/bloqueos', 'writer declara Pendiente/bloqueos')
  contains(
    reviewer,
    'Audita el diff contra el issue y las directivas efectivas',
    'reviewer audita issue y directivas',
  )
  contains(reviewer, 'Corrige directamente', 'reviewer corrige directamente')
  contains(reviewer, 'fuera de scope sin ampliar la tarea', 'reviewer contiene cambios fuera de scope')
  contains(reviewer, 'Verifica las correcciones', 'reviewer verifica sus correcciones')
  contains(reviewer, '## Resultado', 'reviewer declara Resultado')
  contains(reviewer, '## Correcciones', 'reviewer declara Correcciones')
  contains(reviewer, '## Verificacion', 'reviewer declara Verificacion')
  for (const role of [writer, reviewer]) {
    contains(role, 'Nunca hagas push ni abras un pull request', 'el agente no publica rama ni PR')
  }
})

describe('[salidas] snapshots y capacidades derivadas', () => {
  for (const { id, claude: rendered, claudePath } of AGENTS) {
    check(
      `claude/${id} coincide con el snapshot`,
      () => sameBytes(snapshot(id), repoPath(claudePath)),
      `claude/${id} difiere del snapshot`,
    )
    contains(rendered, 'Antes de continuar, aborta si existe', `claude/${id} traduce el guard`)
    absent(rendered, '{{mefisto:', `claude/${id} no conserva directivas`)
    check(`claude/${id} omite MCP`, () => !/[Mm][Cc][Pp]/.test(rendered))
    contains(rendered, 'skills: ["code-comments"]', `claude/${id} conserva skills`)
  }
  contains(WRITER.claude, 'name: "tooling-writer"', 'Claude expone el id del writer')
  contains(REVIEWER.claude, 'name: "tooling-reviewer"', 'Claude expone el id del reviewer')
  contains(WRITER.claude, TOOLS, 'Claude writer deriva read/edit/shell/skill')
  contains(REVIEWER.claude, TOOLS, 'Claude reviewer deriva read/edit/shell/skill')
  contains(WRITER.claude, 'model: "sonnet"', 'Claude materializa perfil balanced')
  contains(REVIEWER.claude, 'model: "opus"', 'Claude materializa perfil deep')
})

describe('[marketplace] raiz Claude instalada y mirrors generados', () => {
  check(
    'el marketplace instala la raiz Claude actual',
    () => {
      const { plugins } = JSON.parse(readOrEmpty(repoPath('.claude-plugin/marketplace.json'))) as {
        plugins?: { name?: string; source?: string }[]
      }
      return plugins?.length === 1 && plugins[0]?.name === 'mefisto' && plugins[0]?.source === './'
    },
    'el marketplace no instala la raiz Claude actual',
  )
  for (const { id, mirror, mirrorPath, claudePath } of AGENTS) {
    check(
      `la raiz instalada descubre ${id}`,
      () => isRegularFile(repoPath(mirrorPath)),
      `falta ${id} en la raiz instalada`,
    )
    check(
      `mirror raiz de ${id} coincide byte a byte`,
      () => sameBytes(repoPath(mirrorPath), repoPath(claudePath)),
      `mirror raiz de ${id} diverge de Claude`,
    )
    contains(mirror, generatedMarker(id), `mirror raiz de ${id} conserva marcador generado`)
    contains(mirror, TOOLS, `mirror raiz de ${id} expone solo tools Claude`)
    if (id === 'tooling-writer') {
      contains(mirror, 'model: "sonnet"', 'mirror raiz del writer conserva perfil balanced')
    } else {
      contains(mirror, 'model: "opus"', 'mirror raiz del reviewer materializa perfil deep')
    }
    for (const forbidden of ['MCP', 'WebFetch', 'WebSearch', 'Task']) {
      absent(mirror, forbidden, `mirror raiz de ${id} omite ${forbidden}`)
    }
  }
})

describe('[clausura] TOOLING_CLOSURE_ASSETS declara los scripts que arrancan TDD publicado', () => {
  check(
    `se derivaron ${CLOSURE.length} assets de clausura`,
    () => CLOSURE.length > 0,
    'no se pudo derivar TOOLING_CLOSURE_ASSETS',
  )
  for (const required of ['scripts/tdd-pipeline.mts', 'src/runtime/lib/mefisto-process.mts']) {
    check(
      `la clausura declara ${required}`,
      () => CLOSURE.some((asset) => asset.source === required),
      `la clausura no declara ${required}`,
    )
  }
})

describe('[integracion] generacion de las dos salidas y check limpio', () => {
  check(
    'el generador procesa ambos agentes en conjunto',
    () => GENERATED.status === 0,
    'el generador no proceso ambos agentes en conjunto',
  )
  // El inventario de la distribucion es la unica autoridad sobre lo generado: en disco deben
  // estar exactamente sus destinos, mas el propio inventario.
  const inventory = readInventory(inWork(`dist/claude/${INVENTORY_FILE}`))
  const expectedFiles = [...inventory.assets.map((asset) => asset.destination ?? ''), INVENTORY_FILE].sort()
  const actualFiles = regularFilesUnder(inWork('dist/claude'))
  check(
    'claude genera exactamente sus assets inventariados, su inventario y los dos agentes bajo prueba',
    () => isDeepStrictEqual(expectedFiles, actualFiles),
    `claude difiere entre disco e inventario: solo en el inventario [${expectedFiles
      .filter((file) => !actualFiles.includes(file))
      .join(' ')}], solo en disco [${actualFiles.filter((file) => !expectedFiles.includes(file)).join(' ')}]`,
  )
  check(
    'claude inventaria con schemaVersion 1',
    () => inventory.schemaVersion === 1,
    'claude no inventaria con schemaVersion 1',
  )
  const inventoried = inventory.assets.filter((asset) => asset.adapter === 'tooling-closure')
  check(
    `claude inventaria la clausura completa derivada de TOOLING_CLOSURE_ASSETS (${CLOSURE.length} assets)`,
    () =>
      isDeepStrictEqual(
        inventoried.map((asset) => `${asset.source}|${asset.mode}`).sort(),
        CLOSURE.map((asset) => `${asset.source}|${asset.mode}`).sort(),
      ),
    'claude no inventaria la clausura derivada de TOOLING_CLOSURE_ASSETS',
  )
  for (const { source, mode } of CLOSURE) {
    check(
      `claude inventaria ${source} con source/destination/mode/sha256`,
      () => {
        const sha = sha256Of(inWork(`dist/claude/${source}`))
        return inventoried.some(
          (asset) =>
            asset.source === source && asset.destination === source && asset.mode === mode && asset.sha256 === sha,
        )
      },
      `claude no inventaria ${source} con source/destination/mode/sha256`,
    )
  }
  // Lo que no es clausura se afirma como conjunto: solo el manifiesto.
  const extra = inventory.assets
    .filter(
      (asset) =>
        asset.adapter !== 'tooling-closure' &&
        asset.adapter !== 'tooling-knowledge' &&
        !(asset.source ?? '').startsWith('src/published/agents/'),
    )
    .map((asset) => `${asset.id} ${asset.destination}`)
    .sort()
    .join('\n')
  check(
    'Claude inventaria el manifiesto fuera de las clausuras compartidas',
    () => extra === 'mefisto-manifest mefisto-manifest.json',
    `Claude inventaria assets inesperados fuera de las clausuras: ${extra}`,
  )
  check(
    'Claude no recibe Skills adaptados ni internos',
    () => !existsSync(inWork('dist/claude/skills')),
    'Claude recibio un arbol de Skills adaptado',
  )
  for (const { id } of AGENTS) {
    check(
      `integracion claude/${id} coincide con el snapshot`,
      () => sameBytes(snapshot(id), inWork(`dist/claude/agents/${id}.md`)),
      `integracion claude/${id} difiere del snapshot`,
    )
  }
  for (const { id } of AGENTS) {
    check(
      `integracion publica el mirror raiz de ${id}`,
      () => sameBytes(inWork(`agents/${id}.md`), inWork(`dist/claude/agents/${id}.md`)),
      `integracion no publica el mirror raiz de ${id}`,
    )
  }
  check(
    'check aislado no detecta divergencias, huerfanos ni copias manuales',
    async () => (await checkInto(WORK, SOURCES)).status === 0,
    'check aislado detecto divergencias, huerfanos o copias manuales',
  )
})

describe('[integridad] ausencia y divergencia de cada artefacto Claude', () => {
  /** Diagnostico de `--check` tras alterar el artefacto generado, que se restaura al terminar. */
  async function diagnosticAfter(artifact: string, alter: (path: string) => void): Promise<string> {
    const path = inWork(artifact)
    const backup = inWork(`backup-${artifact.replaceAll('/', '-')}`)
    copyFileSync(path, backup)
    try {
      alter(path)
      return (await checkInto(WORK, SOURCES)).output
    } finally {
      copyFileSync(backup, path)
    }
  }

  for (const artifact of [
    'agents/tooling-writer.md',
    'agents/tooling-reviewer.md',
    'dist/claude/agents/tooling-writer.md',
    'dist/claude/agents/tooling-reviewer.md',
  ]) {
    check(
      `${artifact} ausente falla con diagnostico accionable`,
      async () => (await diagnosticAfter(artifact, (path) => rmSync(path))).includes(`${artifact}: faltante`),
      `${artifact} ausente no produce diagnostico accionable`,
    )
    check(
      `${artifact} divergente falla con diagnostico accionable`,
      async () =>
        (await diagnosticAfter(artifact, (path) => appendFileSync(path, '\ndivergencia\n'))).includes(
          `${artifact}: distinta`,
        ),
      `${artifact} divergente no produce diagnostico accionable`,
    )
  }
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
