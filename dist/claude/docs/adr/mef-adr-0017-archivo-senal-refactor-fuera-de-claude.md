# MEF-ADR-0017: El archivo señal de refactor puro vive fuera de `.claude/`

## Estado

Aceptado

## Contexto

El pipeline TDD (`scripts/tdd-pipeline.mts`) soporta un flujo de "refactoring puro"
donde el `test-writer` decide que la tarea no requiere tests nuevos y senaliza al
pipeline para saltar Stages 2 y 2b y verificar baseline verde. El contrato de la
senal hasta ahora era:

- El agente escribe `.claude/pipeline/refactor-signal.md` con `REFACTOR_ONLY=true`
  y una `JUSTIFICATION=<razon>`.
- El script detecta el archivo y rama `IS_REFACTOR=true`.

El bug original (issue #150) descubrio que el runtime de Claude Code **intercepta
toda escritura bajo `.claude/**`** dentro del worktree donde corre el agente, aun
cuando:

- `--permission-mode bypassPermissions` esta activo en la invocacion.
- `Write(.claude/pipeline/**)` esta en el `allow` de `settings.json`.
- El `--append-system-prompt` declara explicitamente "MUST use Write/Edit tools
  at any path including `.claude/`".

La interceptacion no es declarativa (no aparece en `settings.json`) sino del
runtime mismo. El agente lo evidencio en su log:

> El directorio `.claude/` esta bloqueado para escritura en el contexto de
> worktree. No hay archivos nuevos que crear para esta tarea.

Resultado practico: un refactor puro (issue #128) se identifico correctamente
pero el pipeline aborto en el gate post-Stage-1 con "El test-writer no genero
ningun archivo. Verifica que la definicion del agente existe", un mensaje
enganoso que culpaba al agente cuando el problema era de tooling.

Verificamos en esta sesion (issue #150) que el bloqueo persiste: tanto los tools
`Write`/`Edit` como redirecciones de Bash (`echo > .claude/...`) son rechazadas;
solo operaciones del SO via paths absolutos (`mv`, `cp`) lo evaden. La proteccion
parece ser una salvaguarda del runtime para impedir que un agente modifique su
propia configuracion (`.claude/agents/`, `.claude/settings.json`) durante una
ejecucion no supervisada.

## Decision

Movemos el archivo senal a `pipeline-state/refactor-signal.md` en la raiz del
worktree, fuera de `.claude/`.

- **Path nuevo**: `pipeline-state/refactor-signal.md`
- **Path legacy** (compatibilidad transicional): `.claude/pipeline/refactor-signal.md`
  — el script lo lee si existe, pero los agentes ya no lo escriben.
- **Gitignore**: `pipeline-state/` se ignora en `.gitignore`. La senal es estado
  transitorio del pipeline, no debe versionarse.
- **No se commitea la senal**: el pipeline la lee del filesystem. La instruccion
  previa de `git add` + `git commit` se elimino del agente `test-writer` porque
  era ruido innecesario y, en el worktree, podia generar commits vacios.
- **Alcance del carril (issue #294)**: el carril de señal cubre tambien refactors
  a nivel de firma de tipo (quitar una interfaz marker, quitar un parametro de
  constructor, mover un tipo entre proyectos) que ademas eliminan tests obsoletos
  como consecuencia directa del cambio de firma — casos donde no existe un estado
  rojo que compile y el carril TDD normal es imposible. Borrar o ajustar esos
  tests no descalifica el carril de señal.
- **Campo `REMOVED_TESTS` (issue #294)**: la señal declara `REMOVED_TESTS=<n>`
  (entero >= 0, default `0` si el campo no existe — compatibilidad con señales
  viejas). El test-writer nunca elimina esos tests el mismo: los enumera en
  `JUSTIFICATION` y el reviewer (Stage 3) ejecuta la eliminacion como parte del
  refactor. El gate "no deben perderse tests" calcula
  `allowed_min = BASELINE_TEST_COUNT - REMOVED_TESTS` y aborta solo si el
  conteo posterior cae por debajo de ese minimo — tolera exactamente la caida
  declarada y mantiene el backstop contra caidas no declaradas.

### Cambios concretos

- `scripts/tdd-pipeline.mts`:
  - `REFACTOR_SIGNAL_PATH` apunta a `$WORKTREE_PATH/pipeline-state/refactor-signal.md`.
  - `LEGACY_REFACTOR_SIGNAL_PATH` apunta a la ubicacion vieja como fallback.
  - El script crea `pipeline-state/` con `mkdir -p` antes del Stage 1.
  - El gate post-Stage-1 detecta la senal **antes** de abortar y, si no hay
    senal pero el log evidencia razonamiento de refactor (heuristica grep:
    `refactor.*pur|REFACTOR_ONLY|refactor-signal|refactoring puro`), aborta con
    un mensaje que apunta al bloqueo de escritura, no a la definicion del agente.
  - (issue #294) parsea `REMOVED_TESTS` de la señal con el mismo patron que
    `JUSTIFICATION`; el gate "no deben perderse tests" post-Stage-3 compara el
    conteo posterior contra `allowed_min = BASELINE_TEST_COUNT - REMOVED_TESTS`
    en vez de contra `BASELINE_TEST_COUNT` directo.
  - (issue #294) el prompt del reviewer en modo refactor aclara que los tests
    declarados como obsoletos en la señal deben eliminarse o ajustarse como
    parte del refactor, no protegerse como si su perdida fuera una regresion.
- `agents/test-writer.md` seccion 2: instrucciones nuevas de path y se elimina
  el paso de commit.
  - (issue #294) se agrega el caso mandatorio de refactor a nivel de firma que
    elimina tests obsoletos, y el campo `REMOVED_TESTS` en la plantilla de la
    señal; se aclara que el test-writer nunca toca produccion ni tests en este
    carril, ni siquiera para eliminar los que quedan obsoletos.
- `.gitignore`: se anade `pipeline-state/`.

## Consecuencias

### Positivas

- El flujo de refactor puro funciona end-to-end sin depender de un permiso que
  el runtime ignora.
- El mensaje de error del gate ahora distingue tres escenarios (refactor
  detectado, refactor probable pero senal ausente, agente no produjo nada),
  guiando mejor al humano que diagnostica.
- `pipeline-state/` es un buen punto de extension futuro para otras senales o
  metadata del pipeline que necesiten vivir fuera de `.claude/`.

### Negativas

- Se introduce una segunda ubicacion para "estado del pipeline" (`.claude/pipeline/`
  para summaries y logs, `pipeline-state/` para senales del agente). Mitigacion:
  documentado aqui y en `test-writer.md`.
- El path `pipeline-state/` esta en la raiz del worktree, mas visible para quien
  inspecciona el directorio. Mitigacion: gitignored y de nombre auto-explicativo.

### Trade-off considerado

**Alternativa A**: dejar el path legacy y agregar al script un fallback que
verifique el log del agente (heuristica) cuando no hay senal. Descartada porque
sigue siendo fragil — depende de que el agente produzca un texto especifico, lo
cual no es contractual.

**Alternativa B**: usar `/tmp/<pipeline-id>/refactor-signal.md`. Descartada
porque `/tmp` no es parte del worktree y complica el debugging post-mortem (al
inspeccionar el worktree fallido, la senal esta en otro filesystem).

**Alternativa elegida**: `pipeline-state/` en la raiz del worktree. Es simple,
auditable (el archivo queda donde se inspecciona el worktree) y no requiere
parchear el runtime ni heuristicas fragiles.

## Referencias

- Issue #150: "Reparar pipeline TDD para que el flujo de refactor puro funcione end-to-end"
- Issue #128: caso original que destapo el bug (refactor puro de
  `FranjaTemporal.DuracionEnHorasDecimales`).
- Log del agente test-writer del issue #128:
  `.claude/pipeline/logs/stage-1-test-writer-20260423-091111-issue-128.log` linea 48.
- MEF-ADR-0011: Definition of Ready (contexto del pipeline TDD).
- MEF-ADR-0014: Coverage gate del pipeline TDD.
- Issue #294: "Extender el carril de señal de refactor del pipeline TDD para
  refactors a nivel de firma que eliminan tests obsoletos".

## Control de cambios

- 2026-07-15: enmendado (issue #294) para ampliar el alcance del carril de
  señal a refactors a nivel de firma de tipo que eliminan tests obsoletos como
  consecuencia directa del cambio de firma, y agregar el campo `REMOVED_TESTS`
  a la señal y al gate "no deben perderse tests" de `tdd-pipeline.sh`. La
  ubicacion del archivo señal (`pipeline-state/`, fuera de `.claude/`) y la
  razon original de la decision (interceptacion de escrituras del runtime) no
  cambian.
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts` que los reemplazaban y su invocacion con `node`. Sin cambio de doctrina.
