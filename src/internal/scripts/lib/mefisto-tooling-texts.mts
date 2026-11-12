// Textos del pipeline interno de tooling: prompts de cada stage, del intento de correccion de
// neutralidad, de la reanudacion tras una espera y de la resolucion de conflictos, y el cuerpo del
// PR. Son doctrina: los fija byte a byte `fixtures/mefisto-tooling-pipeline/`.

import { formatMinutes } from '../../../../scripts/lib/pipeline/pipeline-pr.mts'

/**
 * Doctrina de neutralidad de runtime, una sola vez para los dos prompts. No nombra ninguno de los
 * literales que persiguen las reglas del gate: este archivo vive bajo su alcance.
 */
export const NEUTRALITY_RUNTIME_BLOCK = `NEUTRALIDAD DE RUNTIME:
Un gate de cierre de stage (reglas R1-R3 de src/internal/scripts/mefisto-neutrality-gate.mts) escanea src/internal/** y los scripts de nivel superior de .claude/scripts/ con grep sobre texto crudo: mencionar un literal prohibido en un comentario, un string o en prosa cuenta igual que usarlo, incluso cuando la frase lo niega o lo desaconseja. Una sola fuga aborta la corrida entera al cierre del stage y se pierde todo el trabajo hecho hasta ahi, asi que revisa el texto que escribes antes de darlo por cerrado. La lista exacta de literales por regla esta en la cabecera de ese script -- R1: alias/ids de modelo y claves de permiso crudas de un runtime concreto; R2: invocaciones directas del CLI de un runtime concreto; R3: rutas y variables de entorno propias de un runtime concreto. Los pocos archivos que hoy los nombran pasan por una excepcion nominal en src/internal/contract/neutrality-allowlist.json, con un motivo que justifica por que esa mencion es correcta y permanente en ese archivo puntual; su fraseo no es un patron replicable en un archivo nuevo. Para referirte a cualquiera de esos conceptos en prosa neutral, cita MEF-ADR-0050 (nunca con variables de entorno ni rutas de un runtime concreto). No resuelvas una fuga anadiendo una excepcion nueva a esa allowlist: registrar una excepcion nueva y usarla son dos PRs distintos, y este no es el de registro (MEF-ADR-0019 seccion E).`

/**
 * Reemplaza cada aparicion literal de `placeholder`, como `${prompt//\$X/$X}` de bash: sin
 * interpretar `$` en el valor y sobre lo ya reemplazado antes.
 */
function substitute(template: string, placeholder: string, value: string): string {
  return template.split(placeholder).join(value)
}

export interface Stage1PromptInput {
  projectName: string
  issue: string
  issueContext: string
  /** Presupuesto del stage en segundos, como lo recibio el pipeline. */
  timeout: string
}

export function stage1Prompt(input: Stage1PromptInput): string {
  const template = `Estas en el directorio raiz del repo de Mefisto (${input.projectName}), un Claude Code Plugin para proyectos .NET serverless en Azure.

Contexto de la tarea de tooling a implementar:

$ISSUE_CONTEXT

Tu tarea: implementa lo descrito en el issue. Esto es una tarea de TOOLING sobre el propio plugin Mefisto: skills (en commands/), agentes (en agents/), pipelines en TypeScript (en scripts/), hooks (en hooks/), ADRs (en docs/adr/), metadata del plugin (.claude-plugin/), o equivalentes internos en .claude/{commands,agents,scripts}/.

ALCANCE DE ESCRITURA PERMITIDO:
- commands/        (skills publicados)
- agents/          (agentes publicados)
- scripts/         (pipelines publicados, .mts)
- hooks/           (hooks publicados)
- docs/            (ADRs, testing, field-notes, cheatsheets)
- .claude-plugin/  (plugin.json, marketplace.json)
- .claude/commands/, .claude/agents/, .claude/scripts/  (skills, agentes, hook de scope y tests INTERNOS de Mefisto; los pipelines internos viven en src/internal/scripts/)
- .claude/mods/  (mods de Claude Code del propio Mefisto, MEF-ADR-0055)
- .claude/settings.json  (hooks del pipeline interno; entrada EXACTA, no toda .claude/)
- src/internal/  (layout interno de runtime/proveedor neutral, MEF-ADR-0049; src/ fuera de internal/ sigue fuera de scope)
- src/published/, src/runtime/, dist/  (layout publicado multi-runtime de MEF-ADR-0053; registrado antes de poblarlo)
- AGENTS.md  (doctrina canonica neutral; entrada EXACTA de la raiz, MEF-ADR-0049)
- changelog.d/  (fragmentos de CHANGELOG e indice de ADRs, ver instruccion 5 abajo)
- README.md, CHANGELOG.md, CLAUDE.md, .gitignore, .gitattributes, LICENSE, NOTICE  (gobierno del repo)

Si el issue requiere escribir en una ruta o tipo de artefacto que NO esta en el listado anterior, verifica antes la allowlist autoritativa: la funcion isPathInMefistoScope de src/internal/scripts/lib/mefisto-scope.mts, tal como esta en main. Es la que el gate del pipeline evalua, y el listado de arriba puede quedarse corto frente a ella. Si la ruta tampoco esta ahi, NO intentes crear archivos en ella aunque el issue lo describa: primero hace falta un PR que la registre en los gates de scope/changelog (ver MEF-ADR-0019, seccion E -- registrar una ruta y usarla son dos PRs distintos, el de registro va primero y no crea archivos bajo la ruta que registra). Reporta ese bloqueo en tu resumen de stage 1 para que el PR de registro se abra antes de continuar con este issue.

NO MODIFIQUES NADA FUERA DE ESE SCOPE. Mefisto no tiene tests/ ni infra/; src/ fuera de internal/, published/ y runtime/ sigue fuera de scope.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). No hay un humano al otro lado.
- Nadie puede aprobar, confirmar ni responder preguntas.
- DEBES usar las herramientas Write y Edit directamente.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Tienes permisos completos (bypassPermissions activo).
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~13 s de reloj (el 96,6% del tiempo de una corrida es el modelo escribiendo tokens, no las herramientas ejecutandose). El presupuesto completo del stage es ${input.timeout} s. Lo caro suele ser el turno, pero los tests tambien consumen ese presupuesto. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una: hoy el 82% de los turnos del pipeline gasta una sola tool call, y cada una de esas cadenas paga 13 s por eslabon.
- Al cerrar, corre UNA vez node --test scripts/tests/guards.test.mts y los tests de scripts/tests/, src/published/scripts/tests/ y .claude/scripts/tests/ cuyo nombre o contenido mencione los archivos que tocaste (busca con grep -l). No corras la suite completa dentro de este stage: el presupuesto (${input.timeout} s) no la cubre. La regresion completa la corre la nightly.
- No re-inspecciones el arbol con 'git status' ni 'git diff' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
- No verifiques el scope de un archivo antes de escribirlo (ni con 'git status' ni releyendo isPathInMefistoScope): un hook PostToolUse te avisa EN EL INSTANTE, gratis, si un Edit/Write cae fuera de la allowlist -- no hay motivo para inspeccionar preventivamente algo que el hook ya te va a decir si sale mal. Eso no reemplaza los gates finales (validateMefistoScopeChanges y mefisto-neutrality-gate.mts siguen corriendo al cierre del stage): el hook es aviso temprano, no el juez.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~13 s, y solo vale la pena si te ahorra un error que costaria mas.

${NEUTRALITY_RUNTIME_BLOCK}

Instrucciones:
1. Lee los archivos existentes relevantes antes de escribir nuevos.
2. Reutiliza patrones y convenciones del repo (mira archivos similares).
3. Haz commits frecuentes con mensajes descriptivos en espanol.
4. Si modificaste un skill o agente publicado, considera si necesitas tambien la version interna (con prefijo mefisto-).
5. Anota el cambio como FRAGMENTO en changelog.d/ (issue #380): NUNCA edites CHANGELOG.md ni la tabla "Indice tematico" de CLAUDE.md directamente -- son archivos-indice compartidos que /mefisto-release consolida en su propia rama de release, no cada PR (editarlos por-issue es exactamente la contencion que este mecanismo elimina). En su lugar:
   - Crea 'changelog.d/${input.issue}.<categoria>.md' con una o mas lineas '- texto de la entrada' en estilo Keep a Changelog, donde <categoria> es 'added' (funcionalidad nueva), 'changed' (cambio de comportamiento), 'fixed' (bug) o 'removed' (eliminacion).
   - Si el issue anade o enmienda un ADR (docs/adr/), crea ademas 'changelog.d/${input.issue}.adr-index.md' con la fila '| <Tema del ADR> | MEF-ADR-XXXX |' lista para insertarse en la tabla de indice de CLAUDE.md.
   - Ve changelog.d/README.md para el formato completo y ejemplos.
   Excepcion: si el cambio toca exclusivamente bitacora (docs/bitacora/**) u otros archivos de gobierno no notables (README.md, CLAUDE.md, .gitignore), omite el fragmento. Un gate del pipeline aborta el PR si un cambio notable llega sin fragmento en changelog.d/.
6. Al terminar, escribe un resumen de lo que hiciste en .mefisto/pipeline/summaries/stage-1-writer.md`
  return substitute(template, '$ISSUE_CONTEXT', input.issueContext)
}

export interface Stage2PromptInput {
  projectName: string
  issueContext: string
  snapshot: string
  writerHead: string
  diffStat: string
  diffNameStatus: string
  timeout: string
}

export function stage2Prompt(input: Stage2PromptInput): string {
  const template = `Estas en el directorio raiz del repo de Mefisto (${input.projectName}).

Contexto de la tarea:

$ISSUE_CONTEXT

Cambios del writer:

Commit base: ${input.snapshot}
HEAD del writer: ${input.writerHead}

Resumen (git diff --stat=120 ${input.snapshot}..HEAD):

$DIFF_STAT

Rutas cambiadas (git diff --name-status ${input.snapshot}..HEAD):

$DIFF_NAME_STATUS

Tu tarea: revisa la calidad de los cambios producidos por el writer.

ALCANCE DE ESCRITURA PERMITIDO (igual al del writer):
commands/, agents/, scripts/, hooks/, docs/, .claude-plugin/,
.claude/commands/, .claude/agents/, .claude/scripts/, .claude/mods/, .claude/settings.json,
src/internal/, src/published/, src/runtime/, dist/,
AGENTS.md, changelog.d/, README.md, CHANGELOG.md, CLAUDE.md, .gitignore, .gitattributes, LICENSE, NOTICE.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). DEBES usar Write/Edit directamente.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Tienes permisos completos (bypassPermissions activo).
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~13 s de reloj (el 96,6% del tiempo de una corrida es el modelo escribiendo tokens, no las herramientas ejecutandose). El presupuesto completo del stage es ${input.timeout} s. Lo caro suele ser el turno, pero los tests tambien consumen ese presupuesto. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una: hoy el 82% de los turnos del pipeline gasta una sola tool call, y cada una de esas cadenas paga 13 s por eslabon.
- Al cerrar, corre UNA vez node --test scripts/tests/guards.test.mts y los tests de scripts/tests/, src/published/scripts/tests/ y .claude/scripts/tests/ cuyo nombre o contenido mencione los archivos que tocaste (busca con grep -l). No corras la suite completa dentro de este stage: el presupuesto (${input.timeout} s) no la cubre. La regresion completa la corre la nightly.
- Ya tienes el commit base, el HEAD del writer, el --stat y las rutas cambiadas aqui arriba: para ver el diff de una ruta puntual pidelo bajo demanda con 'git diff ${input.snapshot}..HEAD -- <ruta>' (o 'git show <sha>' para inspeccionar un commit), agrupando varias rutas en el mismo turno si necesitas mas de una. No re-inspecciones el arbol con 'git status' para confirmar algo que acabas de escribir -- Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
- No verifiques el scope de un archivo antes de escribirlo: un hook PostToolUse te avisa EN EL INSTANTE, gratis, si un Edit/Write cae fuera de la allowlist -- no hay motivo para inspeccionar preventivamente algo que el hook ya te va a decir si sale mal. Eso no reemplaza los gates finales (validateMefistoScopeChanges y mefisto-neutrality-gate.mts siguen corriendo al cierre del stage): el hook es aviso temprano, no el juez.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~13 s, y solo vale la pena si te ahorra un error que costaria mas.

${NEUTRALITY_RUNTIME_BLOCK}

Instrucciones:
1. Verifica que los cambios cumplen con lo pedido en el issue.
2. Revisa coherencia con las convenciones del proyecto (AGENTS.md, ADRs).
3. Revisa que los skills/agentes/pipelines modificados sigan los patrones del resto.
4. Corrige problemas que encuentres directamente (no solo los reportes).
5. Haz commit de tus correcciones con mensajes descriptivos.
6. Verifica que el diff del writer no introduce los literales que describe el bloque NEUTRALIDAD DE RUNTIME bajo src/internal/** ni en los scripts de nivel superior de .claude/scripts/; si aparecen, reformulalos tu mismo en esta misma revision -- nunca los reportes sin corregir ni propongas ampliar la allowlist.
7. Al terminar, escribe un resumen en .mefisto/pipeline/summaries/stage-2-reviewer.md`
  const withContext = substitute(template, '$ISSUE_CONTEXT', input.issueContext)
  return substitute(substitute(withContext, '$DIFF_STAT', input.diffStat), '$DIFF_NAME_STATUS', input.diffNameStatus)
}

export function mergePrompt(conflictFiles: string): string {
  return `Hay conflictos de merge con main en los siguientes archivos:
${conflictFiles}

Resuelve los conflictos manteniendo tanto la funcionalidad nueva como la existente.
Despues de resolver cada archivo, haz git add. Cuando todos esten resueltos, haz git commit.
PROHIBIDO hacer 'git push' o 'gh pr create': eso es responsabilidad exclusiva del pipeline, nunca tuya.`
}

export interface NeutralityFixPromptInput {
  projectName: string
  issue: string
  /** Salida cruda del gate. */
  gateOutput: string
  remedy: string
}

export function neutralityFixPrompt(input: NeutralityFixPromptInput): string {
  return `Estas en el worktree de un stage de tooling del repo de Mefisto (${input.projectName}) ya en curso (issue #${input.issue}).

El gate de neutralidad de runtime (MEF-ADR-0049) encontro la(s) siguiente(s) fuga(s) al cierre de este stage, en el trabajo que acabas de dejar:

${input.gateOutput}

Remedio por regla:
${input.remedy}

Tu tarea: corrige EXACTAMENTE esas lineas, y solo esas. No reformules nada que el gate no haya senalado, no toques src/internal/contract/neutrality-allowlist.json (registrar una excepcion ahi es un PR previo y distinto, ver MEF-ADR-0019 seccion E) y no cambies ninguna regla del propio gate. Cuando termines, deja la correccion comiteada con un mensaje descriptivo.

Este es el UNICO intento de correccion: si el gate sigue en rojo despues de ti, el stage aborta y se pierde todo el trabajo de la corrida. Relee lo que escribas antes de cerrarlo.

${NEUTRALITY_RUNTIME_BLOCK}

CONTEXTO DE EJECUCION: modo no-interactivo, sin humano al otro lado. Nadie puede aprobar, confirmar ni responder preguntas. PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso sigue siendo responsabilidad exclusiva del pipeline, nunca tuya.`
}

/** Mensaje de continuacion para la sesion que se reanuda tras una espera, en vez del prompt completo. */
export function resumePrompt(stage: string, agent: string): string {
  return `Tu sesion anterior en este mismo stage (stage ${stage}, agente ${agent}) se corto por un limite de uso del proveedor -- el pipeline ya espero (hold) a que se restableciera. Estas reanudando esa MISMA sesion: tu memoria de trabajo, lo que ya leiste y lo que ya escribiste sigue disponible.

Continua exactamente donde quedaste. No reinicies tu analisis desde cero, no releas archivos que ya revisaste ni repitas ediciones ya hechas.

Termina tu contrato del stage, incluido dejar escrito (o completar si quedo a medias) el resumen en .mefisto/pipeline/summaries/stage-${stage}-${agent}.md. Si ese archivo ya existe completo, dejalo como esta; si no, escribelo ahora y agrega una linea que diga que esta sesion se reanudo tras una espera por limite de uso del proveedor.

CONTEXTO DE EJECUCION (sigue vigente): modo no-interactivo, sin humano al otro lado. PROHIBIDO hacer 'git push' o 'gh pr create': eso sigue siendo responsabilidad exclusiva del pipeline.`

}

/**
 * Nota que acompana la duracion de un stage en el cuerpo del PR: cuanto fue espera y si se
 * reanudo la sesion truncada. Vacia si no hubo ninguna de las dos.
 */
export function holdNote(holdSeconds: number, resumed: boolean): string {
  const parts: string[] = []
  if (holdSeconds > 0) parts.push(`incluye ${formatMinutes(holdSeconds)} en espera/hold`)
  if (resumed) parts.push('reanudo la sesion truncada')
  return parts.length > 0 ? ` (${parts.join('; ')})` : ''
}

export interface StageSummary {
  /** Segundos del stage; vacio si no corrio en esta invocacion. */
  seconds: string
  holdSeconds: number
  resumed: boolean
  summary: string
}

export interface PullRequestBodyInput {
  writer: StageSummary
  reviewer: StageSummary
  /** `git log --oneline` de la rama. */
  commits: string
  metricsTable: string
  /** `Closes`, o `Refs` si el issue se cierra a mano. */
  reference: string
  issue: string
}

function details(label: string, stage: StageSummary): string {
  return `<details>\n<summary>${label} -- ${formatMinutes(stage.seconds)}${holdNote(stage.holdSeconds, stage.resumed)}</summary>\n\n${stage.summary}\n\n</details>`
}

export function pullRequestBody(input: PullRequestBodyInput): string {
  return [
    '## Resumen',
    '',
    'Pipeline mefisto-tooling completado:',
    '- Writer: implementacion de la tarea',
    '- Reviewer: revision de calidad',
    '',
    '## Decisiones del pipeline',
    '',
    details('Writer', input.writer),
    '',
    details('Reviewer', input.reviewer),
    '',
    '## Commits',
    '',
    input.commits,
    '',
    '## Metricas de la corrida',
    '',
    input.metricsTable,
    '',
    `${input.reference} #${input.issue}`,
  ]
    .join('\n')
    .replace(/\n+$/, '')
}
