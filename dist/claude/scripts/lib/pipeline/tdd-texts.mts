// Textos del pipeline TDD: prompts de cada stage, cuerpo del PR y sus secciones, nombres de rama
// y marcas de los mensajes. Son doctrina: los agentes y los revisores leen estos textos byte a
// byte, asi que un cambio aqui es un cambio de contrato.

import type { LogGlyphs } from './pipeline-log.mts'
import { formatMinutes } from './pipeline-pr.mts'
import type { WorktreeTexts } from './pipeline-worktree.mts'

export const TDD_GLYPHS: LogGlyphs = { success: '✓', warn: '⚠', error: '✗', rule: '──' }

export const TDD_WORKTREE_TEXTS: Partial<WorktreeTexts> = {
  offMainBranch: (branch) => `cwd en rama '${branch}' (no main/master): el worktree se creará igual desde origin/main`,
  alreadyExists: (path) => `El worktree ya existe: ${path} — limpiando para reiniciar...`,
  orphanBranch: (branch) => `La rama ${branch} ya existe sin worktree — eliminándola...`,
  resuming: (path, fromStage) => `Retomando desde Stage ${fromStage} — worktree existente: ${path}`,
}

export const NO_PUSH_RULE =
  "PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

const SONNET_COST =
  'Cada turno tuyo cuesta ~5-6 s de reloj (turno sonnet) -- el trabajo que ese turno manda a hacer es barato en comparacion: en el diagnostico Fase 0, dotnet (build/test) ocupo solo ~11% del wall total de una corrida, frente a ~86% de tiempo de API (turnos). Lo caro es el turno, no la herramienta. Con eso en mente:'
const OPUS_COST =
  'Cada turno tuyo cuesta ~8 s de reloj (turno opus) -- el trabajo que ese turno manda a hacer es barato en comparacion: en el diagnostico Fase 0, dotnet (build/test) ocupo solo ~11% del wall total de una corrida, frente a ~86% de tiempo de API (turnos). Lo caro es el turno, no la herramienta. Con eso en mente:'
const GROUP_CALLS =
  '- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una.'
const NO_REINSPECT =
  "- No re-inspecciones el arbol con 'git status' ni 'git diff' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion."
const SONNET_CLOSE =
  'Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~5-6 s, y solo vale la pena si te ahorra un error que costaria mas.'
const OPUS_CLOSE =
  'Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~8 s, y solo vale la pena si te ahorra un error que costaria mas.'

const header = (projectName: string): string => `Estás en el directorio raíz del proyecto ${projectName}.`

export interface Stage1PromptInput {
  projectName: string
  issueContext: string
  stage1Agent: string
}

export function stage1Prompt(input: Stage1PromptInput): string {
  return [
    header(input.projectName),
    '',
    'Contexto de la historia de usuario a implementar:',
    '',
    input.issueContext,
    '',
    `Tu tarea: escribe los tests unitarios para esta HU y crea los stubs mínimos de compilación. Sigue todas las instrucciones de tu rol de ${input.stage1Agent}.`,
    '',
    'ECONOMIA DE TURNOS:',
    SONNET_COST,
    GROUP_CALLS,
    "- Tu verificacion propia es 'dotnet build', UNA vez, cuando creas que terminaste -- no la repitas despues de cada archivo que escribas. No corras 'dotnet test' salvo donde tu rol lo pida explicitamente (el carril de señal de refactor puro, para confirmar el baseline verde): en el carril normal tus tests fallan por definicion, y confirmar esa fase roja no es trabajo tuyo -- apenas termines este stage, el pipeline compila (Gate 1a) y corre toda la suite para confirmarla (Gate 1b).",
    NO_REINSPECT,
    SONNET_CLOSE,
    '',
    NO_PUSH_RULE,
  ].join('\n')
}

export interface Stage2PromptInput {
  projectName: string
  issueContext: string
  stage1Agent: string
  stage2Agent: string
  stage1Files: string
  blockageReport: string
}

export function stage2Prompt(input: Stage2PromptInput): string {
  return [
    header(input.projectName),
    '',
    'Contexto de la historia de usuario:',
    '',
    input.issueContext,
    '',
    `El ${input.stage1Agent} creó/modificó los siguientes archivos:`,
    input.stage1Files,
    '',
    `Tu tarea: implementa la lógica de negocio para hacer pasar todos los tests. Sigue todas las instrucciones de tu rol de ${input.stage2Agent}.`,
    '',
    `Si detectas un bloqueo que no puedes resolver, escribe el reporte en: ${input.blockageReport}`,
    '',
    'ECONOMIA DE TURNOS:',
    SONNET_COST,
    GROUP_CALLS,
    '- Corre la suite para confirmar la fase verde (la esencia de tu stage: implementar y verlos pasar) cuando creas que terminaste -- no la repitas despues de cada metodo o clase que implementes. Apenas termines este stage, el pipeline vuelve a correr toda la suite para confirmarlo (Gate 2): tu corrida es para saber que tu implementacion esta en verde, no la ultima palabra antes de cerrar.',
    NO_REINSPECT,
    SONNET_CLOSE,
    '',
    NO_PUSH_RULE,
  ].join('\n')
}

/** Stage 2 de un issue de solo smoke tests: solo entregables no-codigo. */
export function stage2SmokeOnlyPrompt(input: Omit<Stage2PromptInput, 'stage2Agent' | 'blockageReport'>): string {
  return [
    header(input.projectName),
    '',
    'Contexto de la historia de usuario:',
    '',
    input.issueContext,
    '',
    `Este issue es de SOLO SMOKE TESTS (modo documental): los smoke tests ya están escritos por el ${input.stage1Agent} y no hay código de producción que implementar. NO toques src/ ni tests/. Tu única tarea es resolver los entregables no-código de los criterios de aceptación (ADR en docs/, filas en AGENTS.md o CLAUDE.md). Si no hay ninguno, termina sin cambios.`,
    '',
    `Archivos del ${input.stage1Agent}:`,
    input.stage1Files,
    '',
    NO_PUSH_RULE,
  ].join('\n')
}

export interface Stage2bPromptInput {
  projectName: string
  issueContext: string
  stage2Agent: string
  /** `las siguientes tools de un servidor MCP` o `los siguientes endpoints`. */
  filesDescription: string
  smokeFiles: string
  /** Bloque de smokes existentes que invocan lo modificado; empieza y termina con salto. */
  invokersBlock: string
  taskLine: string
}

export function stage2bPrompt(input: Stage2bPromptInput): string {
  return [
    header(input.projectName),
    '',
    'Contexto de la historia de usuario:',
    '',
    input.issueContext,
    '',
    `El ${input.stage2Agent} creó/modificó ${input.filesDescription}:`,
    input.smokeFiles,
    input.invokersBlock,
    input.taskLine,
    'IMPORTANTE: Solo escribe y compila. NO ejecutes los tests (el entorno dev puede no tener este código desplegado aún).',
    "Usa 'dotnet build' para verificar compilación, pero NO uses 'dotnet test'.",
    '',
    'Sigue todas las instrucciones de tu rol de smoke-test-writer.',
    '',
    'ECONOMIA DE TURNOS:',
    SONNET_COST,
    GROUP_CALLS,
    "- Corre 'dotnet build' del proyecto de smoke tests UNA vez, cuando creas que terminaste de escribirlos -- no lo repitas despues de cada test que agregues. Apenas termines este stage, el pipeline vuelve a compilar ese mismo proyecto para confirmarlo: tu build es para saber que tu trabajo compila, no la ultima palabra antes de cerrar.",
    NO_REINSPECT,
    SONNET_CLOSE,
    '',
    NO_PUSH_RULE,
  ].join('\n')
}

export interface SmokeStageTexts {
  filesDescription: string
  taskLine: string
  commitSubject: string
}

/** Lo que cambia del Stage 2b entre tools MCP y endpoints HTTP. */
export function smokeStageTexts(isMcp: boolean, issue: string): SmokeStageTexts {
  const hu = issue.length > 0 ? issue : '?'
  if (isMcp) {
    return {
      filesDescription: 'las siguientes tools de un servidor MCP',
      taskLine:
        'Tu tarea: extiende la suite SmokeTests del servidor MCP (pin de catálogo, pin de schema, tool call real) para las tools nuevas o modificadas -- sigue la doctrina de extensión de servidores MCP de tu rol (MEF-ADR-0048), no la de Functions HTTP.',
      commitSubject: `test(hu-${hu}): smoke tests para tools MCP`,
    }
  }
  return {
    filesDescription: 'los siguientes endpoints',
    taskLine: 'Tu tarea: escribe smoke tests para los endpoints nuevos o modificados.',
    commitSubject: `test(hu-${hu}): smoke tests para endpoints`,
  }
}

/**
 * Bloque del prompt del Stage 2b con los smokes existentes que invocan lo modificado. `listing`
 * trae una linea `- <ruta> (tool: <nombre>)` o `- <ruta> (ruta: <plantilla>)` por smoke; vacio si
 * no se encontro ninguno.
 */
export function invokersBlock(isMcp: boolean, listing: string, smokeProject: string): string {
  if (isMcp) {
    if (listing.length > 0) {
      return `\nSmokes existentes que invocan las tools modificadas:\n${listing}\n\nRevisa cada uno de esos archivos, incluidos los Arrange de otras clases que invocan la tool, y alinealo al contrato nuevo (inputSchema, eco y campos de la respuesta). Revisa tambien en la propia clase de la tool los asserts que el cambio contradice.\n`
    }
    return `\nSmokes existentes que invocan las tools modificadas: ninguno encontrado por el pipeline (sin coincidencias del literal de la tool en ${smokeProject}). Revisa igualmente en la propia clase de la tool los asserts que el cambio contradice.\n`
  }
  if (listing.length > 0) {
    return `\nSmokes existentes que invocan los endpoints modificados (en cualquier proyecto SmokeTests, tambien de otros dominios o de la suite MCP):\n${listing}\n\nRevisa cada uno de esos archivos, incluidos los Arrange que invocan el endpoint, y alinealo al contrato nuevo (payload, status de exito, forma de la respuesta). La lista no distingue metodo HTTP: es para revisar, no un gate.\n`
  }
  return '\nSmokes existentes que invocan los endpoints modificados: ninguno encontrado por el pipeline (sin coincidencias de la ruta en tests/*.SmokeTests). Si el contrato cambia, busca igualmente la ruta en los proyectos SmokeTests.\n'
}

export interface RefactorPromptInput {
  projectName: string
  issueContext: string
  issue: string
  justification: string
  removedTests: number
}

export function stage3RefactorPrompt(input: RefactorPromptInput): string {
  const hu = input.issue.length > 0 ? input.issue : '?'
  return [
    header(input.projectName),
    '',
    'Esta es una tarea de REFACTORING PURO. No hay fases roja ni verde previas.',
    `Justificación del refactoring: ${input.justification}`,
    '',
    'Contexto de la tarea:',
    '',
    input.issueContext,
    '',
    `Tu misión: ejecutar el refactoring descrito en el issue. Los tests existentes DEBEN seguir pasando en todo momento, salvo los tests obsoletos que la JUSTIFICACION de arriba declara explicitamente: el test-writer los señalizo pero no los toco (no edita produccion ni tests en el carril de señal) — eliminarlos o ajustarlos es tu responsabilidad como parte de este refactor. Tests declarados como eliminados en la señal: ${input.removedTests}.`,
    '',
    'Reglas:',
    '1. Corre dotnet test ANTES de empezar para confirmar el baseline verde.',
    '2. Ejecuta el refactoring en pasos pequeños y seguros. Si la JUSTIFICACION declara tests obsoletos, eliminalos o ajustalos como parte del refactor — no son una regresion.',
    '3. Después de cada cambio significativo, corre dotnet test.',
    '4. Si un cambio rompe un test que NO esta declarado como obsoleto en la JUSTIFICACION, reviértelo inmediatamente: git checkout -- <archivo>',
    '5. Al terminar, corre dotnet test una última vez para confirmar que todo sigue verde (descontando los tests obsoletos que eliminaste).',
    `6. Haz commit de tu trabajo con mensaje: refactor(hu-${hu}): [descripción]`,
    '',
    'Sigue todas las instrucciones de tu rol de reviewer.',
    '',
    'ECONOMIA DE TURNOS:',
    OPUS_COST,
    GROUP_CALLS,
    "- La Regla 3 sigue en pie: la corrida despues de cada cambio significativo es la que te dice CUAL cambio rompio un test, y es lo que hace posible el revert puntual de la Regla 4. Lo que sobra es la ronda extra 'por las dudas': la corrida de cierre de la Regla 5 se hace UNA vez, y si desde ella no volviste a tocar codigo no la repitas -- apenas termines este stage, el pipeline vuelve a correr toda la suite para confirmarlo igual (Gate 3).",
    NO_REINSPECT,
    OPUS_CLOSE,
    '',
    NO_PUSH_RULE,
  ].join('\n')
}

export interface ReviewerPromptInput {
  projectName: string
  issueContext: string
  snapshot: string
  writerHead: string
  diffStat: string
  diffNameStatus: string
  /** Justificacion de la senal no-red, o `null` si no se senalizo. */
  noRedJustification: string | null
  stage1Agent: string
  smokeOnly: boolean
}

export function stage3ReviewerPrompt(input: ReviewerPromptInput): string {
  const { snapshot } = input
  let prompt = [
    header(input.projectName),
    '',
    'Contexto de la historia de usuario:',
    '',
    input.issueContext,
    '',
    'Cambios de las fases roja y verde:',
    '',
    `Commit base: ${snapshot}`,
    `HEAD del test-writer: ${input.writerHead}`,
    '',
    `Resumen (git diff --stat=120 ${snapshot}..HEAD):`,
    '',
    input.diffStat,
    '',
    `Rutas cambiadas (git diff --name-status ${snapshot}..HEAD):`,
    '',
    input.diffNameStatus,
    '',
    'Tu tarea: revisa la calidad del código, refactoriza si es necesario, y verifica que los criterios de aceptación estén bien cubiertos.',
    'Si las rutas cambiadas incluyen smoke tests (archivos en *SmokeTests/), revísalos también: verifica que cubran los escenarios principales del endpoint (camino feliz, validación, duplicados) y que sigan las convenciones del proyecto.',
    'Sigue todas las instrucciones de tu rol de reviewer.',
    '',
    'ECONOMIA DE TURNOS:',
    OPUS_COST,
    GROUP_CALLS,
    `- Ya tienes el commit base, el HEAD del test-writer, el --stat y las rutas cambiadas aqui arriba: para ver el diff de una ruta puntual pidelo bajo demanda con 'git diff ${snapshot}..HEAD -- <ruta>' (o 'git show <sha>' para inspeccionar un commit), agrupando varias rutas en el mismo turno si necesitas mas de una. Esto NO alcanza a las consultas acotadas que tu rol usa como disparador de gate ('git diff main...HEAD -- <ruta>'): esas corren contra main y filtran por ruta, y lo de arriba no las reemplaza.`,
    "- Manten el protocolo de correccion de tu rol -- 'dotnet test' despues de cada cambio, revertir con 'git checkout -- <archivo>' si rompe: esa corrida es la que te dice CUAL cambio rompio, y agrupar varias correcciones te obliga a bisecar despues, que sale mas caro que los turnos que ahorra. Lo que sobra es la ronda extra 'por las dudas': si desde tu ultima corrida verde no tocaste codigo, no la repitas antes de cerrar -- apenas termines este stage, el pipeline vuelve a correr toda la suite igual (Gate 3).",
    "- No re-inspecciones el arbol con 'git status' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.",
    OPUS_CLOSE,
    '',
    NO_PUSH_RULE,
  ].join('\n')
  if (input.noRedJustification !== null) {
    prompt += `\n\nNota: el ${input.stage1Agent} señalizo que la fase roja del Stage 1 era estructuralmente inalcanzable (unica capa de test posible: composicion/config-test). Justificación: ${input.noRedJustification}`
  }
  if (input.smokeOnly) {
    prompt +=
      '\n\nNota: este issue es de SOLO SMOKE TESTS (corren post-deploy, MEF-ADR-0013). No hay implementación que revisar en src/: revisa la calidad de los smoke tests y de los entregables documentales (docs/), sin tocar src/.'
  }
  return prompt
}

/** Aviso de tests bloqueados que se agrega al prompt del reviewer. */
export function blockagePromptNote(report: string): string {
  return `\n\nATENCION: hay tests bloqueados tras la fase verde (reportados por el implementer o detectados por el pipeline como tests preexistentes que la implementacion volvio rojos). Lee el reporte en ${report} y sigue las instrucciones de tu seccion 2b para intentar resolverlos.`
}

export function mergePrompt(input: { projectName: string; conflictFiles: string }): string {
  return [
    header(input.projectName),
    '',
    'Hay conflictos de merge con la rama main en los siguientes archivos:',
    input.conflictFiles,
    '',
    'Resuelve los conflictos manteniendo tanto la funcionalidad nueva (de esta rama) como la existente (de main).',
    'Después de resolver cada archivo, haz git add del archivo.',
    'Cuando todos estén resueltos, haz git commit para completar el merge.',
    'NO elimines código de ninguna de las dos ramas — integra ambos cambios.',
    "PROHIBIDO hacer 'git push' o 'gh pr create': eso es responsabilidad exclusiva del pipeline, nunca tuya.",
  ].join('\n')
}

export function scaffoldPrompt(domain: string): string {
  return `Crea el scaffold para el dominio '${domain}'. El usuario ya confirmo la creacion — omite la confirmacion del Paso 0 y procede directamente a crear el proyecto.\n\n${NO_PUSH_RULE}`
}

export function patchTestWriterPrompt(input: { projectName: string; patchSpec: string; patchSpecContent: string; issue: string }): string {
  const hu = input.issue.length > 0 ? input.issue : '?'
  return [
    `Estas en el directorio raiz del proyecto ${input.projectName}.`,
    '',
    'El pipeline detecto brechas de cobertura en la implementacion existente. Tu tarea es agregar tests adicionales para cubrir los metodos y lineas que no estan siendo ejecutados por los tests existentes.',
    '',
    `La especificacion de remediacion esta en: ${input.patchSpec}`,
    '',
    input.patchSpecContent,
    '',
    'IMPORTANTE:',
    '- Lee los archivos de produccion listados para entender que hacen los metodos/branches no cubiertos',
    '- Escribe tests que ejerciten esos paths especificos',
    '- Dado que la implementacion ya existe, los tests nuevos probablemente PASARAN directamente',
    '- Sigue las mismas convenciones de testing del proyecto (Given/When/Then, AwesomeAssertions)',
    `- Haz commit con mensaje: test(hu-${hu}): tests de cobertura para brechas detectadas`,
    `- ${NO_PUSH_RULE}`,
  ].join('\n')
}

export function patchImplementerPrompt(input: { projectName: string; stage1Agent: string }): string {
  return [
    `Estas en el directorio raiz del proyecto ${input.projectName}.`,
    '',
    `El coverage gate detecto brechas de cobertura y el ${input.stage1Agent} agrego tests adicionales, pero no compilan.`,
    'Tu tarea: haz que SOLO los tests nuevos de cobertura compilen y pasen. No modifiques la logica de negocio existente.',
    '',
    'Pista: revisa los ultimos archivos de test creados/modificados y corrige errores de compilacion.',
    '',
    NO_PUSH_RULE,
  ].join('\n')
}

// --- Nombres ----------------------------------------------------------------------

const ACCENTS: Readonly<Record<string, string>> = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u',
  à: 'a', è: 'e', ì: 'i', ò: 'o', ù: 'u',
  ä: 'a', ë: 'e', ï: 'i', ö: 'o', ü: 'u',
}

function lowerChar(char: string): string {
  const lower = char.toLowerCase()
  return [...lower].length === 1 ? lower : char
}

/**
 * Slug del titulo de un issue: minusculas, vocales acentuadas a su base, solo `[a-z0-9 ]`, los
 * espacios como un guion, 40 caracteres y sin guion final. A diferencia del de tooling, borra los
 * guiones del titulo.
 */
export function tddIssueSlug(title: string): string {
  return title
    .split('\n')
    .map((line) =>
      [...line]
        .map((char) => {
          const lower = lowerChar(char)
          return ACCENTS[lower] ?? lower
        })
        .join('')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/ +/g, '-')
        .slice(0, 40)
        .replace(/-$/, ''),
    )
    .join('\n')
}

/** Slug del nombre de un archivo de HU: cada caracter que no es alfanumerico ASCII, un guion. */
export function tddFileSlug(title: string): string {
  return title
    .split('\n')
    .map((line) =>
      [...line]
        .map(lowerChar)
        .join('')
        .replace(/[^a-zA-Z0-9]/gu, '-')
        .replace(/-+/g, '-')
        .slice(0, 40)
        .replace(/-$/, ''),
    )
    .join('\n')
}

/** `kebab-case` a `PascalCase`, como el nombre del proyecto del dominio. */
export function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('')
}

// --- Cuerpo del PR --------------------------------------------------------------

export interface PullRequestBodyInput {
  summary: string
  stage1Label: string
  stage1Seconds: number | null
  stage1Summary: string
  /** Seccion del implementer, con su salto final, o vacia. */
  implementerSection: string
  /** Seccion del smoke-test-writer o de validacion post-deploy, con su salto final, o vacia. */
  smokeSection: string
  reviewerSeconds: number | null
  reviewerSummary: string
  /** Secciones opcionales ya armadas, en orden, entre el reviewer y los commits. */
  extraSections: string
  commits: string
  metricsTable: string
  closesLine: string
}

/** Detalle plegable de un agente en el cuerpo del PR, con su salto final. */
export function agentDetails(title: string, seconds: number | null, summary: string): string {
  return `<details>\n<summary>${title} — ${formatMinutes(seconds)}</summary>\n\n${summary}\n\n</details>\n`
}

export function pullRequestBody(input: PullRequestBodyInput): string {
  const body = [
    '## Resumen',
    '',
    input.summary,
    '',
    '## Decisiones del pipeline',
    '',
    agentDetails(`${input.stage1Label} (fase roja)`, input.stage1Seconds, input.stage1Summary),
    `${input.implementerSection}${input.smokeSection}${agentDetails('Reviewer (fase refactor)', input.reviewerSeconds, input.reviewerSummary)}`,
    `${input.extraSections}## Commits`,
    '',
    input.commits,
    '',
    '## Metricas de la corrida',
    '',
    input.metricsTable,
    '',
    input.closesLine,
  ].join('\n')
  return body.replace(/\n+$/, '')
}

export interface PrSummaryInput {
  refactor: boolean
  smokeOnly: boolean
  justification: string
  baselineTests: string
  smokeWritten: boolean
  noRedJustification: string | null
}

export function prSummary(input: PrSummaryInput): string {
  if (input.refactor) {
    return `Pipeline TDD completado (refactoring puro):\n- Análisis: no se requieren tests nuevos\n- Justificación: ${input.justification}\n- Baseline: ${input.baselineTests} tests pasando\n- Refactoring ejecutado manteniendo todos los tests verdes`
  }
  if (input.smokeOnly) {
    return 'Pipeline TDD completado (solo smoke):\n- Smoke tests escritos en Stage 1 (corren post-deploy, MEF-ADR-0013)\n- Stage 2 en modo documental: solo entregables no-código\n- Fase refactor: revisión de calidad'
  }
  let summary = input.smokeWritten
    ? 'Pipeline TDD completado:\n- Fase roja: tests escritos con stubs\n- Fase verde: implementación completa\n- Smoke tests: escritos para endpoints detectados\n- Fase refactor: revisión de calidad'
    : 'Pipeline TDD completado:\n- Fase roja: tests escritos con stubs\n- Fase verde: implementación completa\n- Fase refactor: revisión de calidad'
  if (input.noRedJustification !== null) summary += `\n- Fase roja no aplicable: ${input.noRedJustification}`
  return summary
}

/** Seccion de validacion pendiente de un PR de solo smoke tests; `smokePaths` son los archivos smoke. */
export function smokeOnlySection(smokePaths: readonly string[]): string {
  const list = smokePaths.map((path) => `- \`${path}\``).join('\n')
  return `## Validación pendiente post-deploy\n\nEste PR contiene solo smoke tests (\`Category=Smoke\`), que corren contra dev tras el despliegue (MEF-ADR-0013); el gate local no los ejecuta. La evidencia de los criterios de aceptación que dependen de ellos saldrá del job de smoke tras el merge: este PR **no** la presenta como verificada.\n\nArchivos smoke:\n${list}\n`
}

export function smokeAnomalySection(path: string): string {
  return `## Anomalia de deteccion (Stage 2b)\n\nUn match bajo \`src/\` no permitio derivar el proyecto de smoke tests: \`${path}\`. Revisa el patron de deteccion en \`scripts/tdd-pipeline.sh\` (Stage 2b) -- se salto con \`AGENT_ST_RES=skipped\`, igual que un dominio sin proyecto SmokeTests, pero aqui la causa es un patron no reconocido.\n`
}

/** Seccion de smokes que invocan lo modificado y no cambiaron; vacia si todos cambiaron. */
export function smokeUnchangedSection(unchanged: readonly { target: string; file: string }[]): string {
  if (unchanged.length === 0) return ''
  const list = unchanged.map((smoke) => `- \`${smoke.file}\` (invoca \`${smoke.target}\`)\n`).join('')
  return `## Smokes que invocan tools modificadas sin cambios\n\nEstos smokes invocan una tool MCP o un endpoint HTTP modificado por la HU y no cambiaron. Puede estar bien; revisa que sigan alineados con el contrato nuevo:\n\n${list}\n`
}

export interface CoverageSectionInput {
  table: string
  hasNotEvaluated: boolean
  /** Resumen de la remediacion, o vacio si no se aplico. */
  remediation: string
  gapsRemaining: number
}

/** Seccion de cobertura del PR; vacia si el gate no armo tabla. */
export function coverageSection(input: CoverageSectionInput): string {
  if (input.table.length === 0) return ''
  let section = `## Cobertura\n\n${input.table}\n`
  if (input.hasNotEvaluated) {
    section +=
      '\n> **Archivos sin clasificar** (`⚠ revisar`): ninguna regla de clasificacion los reconocio — el gate **no los midio**. No es una exclusion deliberada (a diferencia de `excluido`, donde si se decidio que no requieren cobertura): requieren revision humana para confirmar si necesitan tests.\n'
  }
  if (input.remediation.length > 0) section += `\n### Remediacion\n\n${input.remediation}\n`
  if (input.gapsRemaining > 0) {
    section += `\n> **Gaps pendientes**: ${input.gapsRemaining} archivo(s) no alcanzan el umbral de cobertura. Requiere revision humana.\n`
  }
  return section
}

export function blockageComment(report: string): string {
  return `## Tests bloqueados\n\nEste PR tiene tests en rojo que ni el implementer ni el reviewer pudieron resolver. Se requiere atencion humana.\n\n<details>\n<summary>Reporte de bloqueo</summary>\n\n${report}\n\n</details>`
}

/** Reporte que el pipeline escribe cuando todos los rojos del Gate 2 son preexistentes. */
export function preexistingBlockageReport(tests: readonly { test: string; file: string }[], outputTail: string): string {
  return [
    '## Reporte de bloqueo - generado por el pipeline',
    '',
    'Todos los tests en rojo existian en el snapshot y el test-writer no los modifico (pin desactualizado o guarda de inventario).',
    '',
    '### Tests rojos preexistentes',
    ...tests.map((red) => `- \`${red.test}\` (${red.file})`),
    '',
    '### Salida de los tests',
    '```',
    outputTail,
    '```',
    '',
  ].join('\n')
}

/** Aviso del Gate 1b sobre tests preexistentes en rojo que el test-writer no toco. */
export function preexistingRedWarning(tests: readonly { test: string; file: string }[]): string {
  return [
    '## Tests preexistentes en rojo sin modificar',
    '',
    'Hipotesis: pin o test preexistente que quiza el test-writer debia actualizar, o stub sobre codigo existente.',
    '',
    '| Test | Archivo |',
    '|------|---------|',
    ...tests.map((red) => `| \`${red.test}\` | \`${red.file}\` |`),
    '',
  ].join('\n')
}
