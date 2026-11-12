// Contrato del agente planner neutral y su proyeccion publicada (issue #1640).

import { describe, test } from 'node:test'

import { matchingLines, repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  generatedMarker,
  isRegularFile,
  metadataMatches,
  readInventory,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('planner')
const { body, claude: claudeBody } = AGENT
const FIELD_NOTE_SOURCE = repoPath('scripts/field-note.mts')
const FIELD_NOTE_CLAUDE = repoPath('dist/claude/scripts/field-note.mts')

describe('[fuente] contrato neutral, perfil, skill y mcp', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata declara agent/planner/all/deep/skills-projections/mcp-microsoft-learn',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: {
          kind: 'agent',
          id: 'planner',
          mode: 'all',
          profile: 'deep',
          skills: ['projections'],
          mcp: ['microsoft-learn'],
        },
        capabilities: ['read', 'edit', 'shell'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:package-root}}/docs/adr/', 'resuelve ADRs via package-root')
  contains(body, '{{mefisto:skill-root projections}}', 'resuelve recursos de Nivel 3 del Skill via skill-root')
  contains(body, '{{mefisto:config-path}}', 'lee el config efectivo via config-path')
  contains(body, '{{mefisto:state-path summaries}}', 'redacta los borradores bajo state-path summaries')
  contains(body, '{{mefisto:run field-note.mts', 'el cierre delega en field-note.mts via directiva run')
  absent(body, '/tmp/planner-', 'fuente no escribe borradores en /tmp')
  absent(body, '.plugin-root', 'fuente no resuelve .plugin-root')
  absent(body, 'plugins/cache', 'fuente no busca el cache del marketplace')
  absent(body, '.claude/', 'fuente no referencia rutas .claude/')
  absent(body, 'CLAUDE_', 'fuente no referencia variables CLAUDE_*')
  absent(body, 'PLUGIN_ROOT', 'fuente no reconstruye PLUGIN_ROOT a mano')
})

describe('[fuente] guardas de inventario de eventos (#2058)', () => {
  contains(body, '## Guardas de inventario de eventos: agregar un evento', 'seccion de guardas de inventario presente')
  contains(body, 'agrega un evento persistido o de bus', 'la seccion declara su activacion')
  contains(body, '**Lista exacta / conteo**', 'clasifica lista exacta/conteo')
  contains(body, '**Tabla evento->topic**', 'clasifica tabla evento->topic')
  contains(body, 'eliminar `<Test>`', 'instruye eliminar la guarda cuando existe la derivada')
  contains(body, 'reemplazar `<Test>` por la guarda derivada', 'instruye reemplazar cuando no existe la derivada')
  contains(body, 'RegistraTodosLosEventosPersistidos', 'referencia el patron del domain-scaffolder')
  contains(body, '(typeof(Evento), "topic")', 'exige el par exacto tipo-topic')
  contains(body, 'tests de dominio Given/When/Then', 'excluye los tests de dominio')
  contains(body, '- [ ] **Guardas de inventario de eventos**', 'checklist pre-listo incluye el item')
})

describe('[fuente] decisiones cerradas (#2147)', () => {
  check(
    'metadata declara la capacidad web',
    () => metadataMatches(AGENT.metadata, { capabilities: ['web'] }),
    'metadata sin capacidad web',
  )
  contains(body, '- [ ] **Decisiones cerradas**', 'checklist pre-listo incluye Decisiones cerradas')
  contains(body, '{{mefisto:state-path sandbox}}', 'pruebas de concepto bajo state-path sandbox')
})

describe('[fuente] preguntas nativas (#2137)', () => {
  check(
    'metadata declara la capacidad ask',
    () => metadataMatches(AGENT.metadata, { capabilities: ['ask'] }),
    'metadata sin capacidad ask',
  )
  contains(body, '## Preguntas al usuario', 'seccion de preguntas al usuario presente')
  contains(body, '(Recomendado)', 'la recomendada primero con (Recomendado)')
  contains(body, 'pregunta en texto con las mismas reglas', 'fallback en texto sin la herramienta')
  contains(body, '¿Paso #N "<título>" a estado:listo?', 'la pregunta de listo nombra el issue')
  absent(body, 'AskUserQuestion', 'la fuente no nombra AskUserQuestion')
  contains(claudeBody, 'AskUserQuestion', 'el adaptador Claude incluye AskUserQuestion')
})

describe('[salidas] adaptador y mirror', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  contains(claudeBody, 'name: "planner"', 'Claude expone el id del agente')
  contains(claudeBody, 'model: "opus"', 'Claude materializa el perfil deep como opus')
  contains(claudeBody, 'skills: ["projections"]', 'Claude declara el Skill projections')
  contains(claudeBody, 'mcp__plugin_mefisto_microsoft-learn__*', 'Claude declara el matcher MCP scoped de microsoft-learn (plugin bundleado)')

  // El preambulo compartido que fija MEFISTO_PACKAGE_ROOT y MEFISTO_CONFIG_PATH si nombra
  // `.plugin-root` y el config legacy; lo que se exige es que el cuerpo propio del planner no
  // reimplemente esa resolucion.
  absent(claudeBody, '/tmp/planner-', 'salida claude_body no escribe borradores en /tmp')
  absent(claudeBody, 'plugins/cache', 'salida claude_body no busca el cache del marketplace')
  absent(claudeBody, 'CONFIG="$REPO_ROOT', 'el cuerpo propio no reconstruye la ruta del config a mano (CONFIG=$REPO_ROOT/...)')
})

describe('[cierre] invocacion de field-note.mts', () => {
  contains(claudeBody, '"${MEFISTO_PACKAGE_ROOT}/scripts/field-note.mts"', 'Claude invoca field-note.mts via MEFISTO_PACKAGE_ROOT')
  contains(claudeBody, 'MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/field-note.mts"', 'Claude fija su propio runtime al invocar field-note.mts')
  contains(claudeBody, '--session-id "$SESSION_ID" --timestamp "$CLOSING_TIMESTAMP" --field-note "$FIELD_NOTE_LOCAL"', 'Claude conserva los flags obligatorios del cierre')
})

describe('[scripts/field-note.mts] paridad de la clausura de tooling', () => {
  check(
    'dist/claude/scripts/field-note.mts es identico a scripts/field-note.mts',
    () => isRegularFile(FIELD_NOTE_CLAUDE) && sameBytes(FIELD_NOTE_SOURCE, FIELD_NOTE_CLAUDE),
    'dist/claude/scripts/field-note.mts diverge de scripts/field-note.mts',
  )
  check(
    'claude/.mefisto-generated-assets.json lista scripts/field-note.mts',
    () => readInventory().assets.some((asset) => asset.destination === 'scripts/field-note.mts'),
    'claude/.mefisto-generated-assets.json no lista scripts/field-note.mts',
  )
})

describe('[fuente] confirmacion antes de estado:listo (#2111)', () => {
  absent(body, '--label "estado:listo"', 'ningun gh issue create usa --label "estado:listo"')
  absent(body, 'puede salir directamente como `estado:listo`', 'desglosar no ofrece salir directo como listo')
  contains(body, '**espera la respuesta**', 'refinar espera la respuesta antes del label listo')
  contains(body, 'sin cambiar el label', 'refinar guarda el cuerpo sin cambiar el label')
  contains(body, 'Una única confirmación pasa a listo', 'una unica confirmacion cubre refinado y creados')
  contains(body, 'sin volver a preguntar', 'excepcion de pedido explicito en el mismo turno')
})

describe('[fuente] regla de ## Dependencias sin negaciones (#2129)', () => {
  contains(body, '### Regla de `## Dependencias`', 'la regla de Dependencias existe')
  contains(body, 'todos los templates (dominio, infraestructura, proyección, MCP)', 'la regla aplica a todos los templates')
  contains(body, '`- Depende de #N`', 'marcador Depende de')
  contains(body, '`- Bloqueado por #N`', 'marcador Bloqueado por')
  contains(body, '`- Bloquea #N`', 'marcador Bloquea')
  contains(body, '`- Relacionado: #N`', 'marcador Relacionado')
  contains(body, '`Ninguna - ...`', 'linea Ninguna')
  contains(body, 'Nunca declares una dependencia en negativo ("No depende de #N", "Ya no depende de #N")', 'prohibe la negacion')
  contains(body, 'borra la línea', 'la dependencia caducada se borra')
  contains(body, '`gh issue comment`', 'la explicacion va en comentario')
  contains(body, 'cumpliendo la "Regla de `## Dependencias`"', 'desglosar referencia la regla')
  contains(body, 'borra las dependencias negadas', 'refinar paso 8 borra negaciones')
})

describe('[precedente primero] seccion, regla primera vez, checklist y templates (#2443)', () => {
  for (const [name, text] of [
    ['SOURCE_TEXT', AGENT.source],
    ['CLAUDE_TEXT', claudeBody],
  ] as const) {
    contains(text, '## Precedente primero: investigar antes de recomendar', `${name} tiene la seccion Precedente primero`)
    contains(text, 'sería la primera vez que el proyecto hace algo de ese estilo', `${name} conserva la regla de primera vez`)
    contains(text, '- [ ] **Consistencia con precedentes**', `${name} checklist incluye Consistencia con precedentes`)
    const templates = matchingLines(text, /^Precedentes: /).length
    check(
      `${name} tiene Precedentes: en los templates de dominio, proyeccion y MCP`,
      () => templates >= 3,
      `${name} sin Precedentes: en los tres templates (${templates})`,
    )
    contains(text, '(Obligatoria cuando el issue sugiere una forma de implementacion; ver', `${name} template de dominio con Investigacion obligatoria`)
  }
})

describe('[mirror] agents/planner.md pasa a generado', () => {
  check(
    'mirror Claude coincide byte a byte',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror Claude diverge',
  )
  contains(AGENT.mirror, generatedMarker(AGENT.id), 'mirror conserva marcador generado')
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
