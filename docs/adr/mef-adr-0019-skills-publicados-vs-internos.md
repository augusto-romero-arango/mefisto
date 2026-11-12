# MEF-ADR-0019: Separacion fisica de skills publicados (consumidor) vs internos (Mefisto)

- **Fecha**: 2026-05-15
- **Estado**: aceptado
- **Aplica a**: estructura del repo del plugin, skills, agentes, pipelines, hooks.

## Contexto

Antes de la separacion del repo, los skills del harness (`/tooling`, `/draft`, `/bug`, etc.) coexistian con el codigo de la aplicacion en un solo repositorio. Tras extraer el harness a `eda-evsourcing-azure-harness` y publicarlo como Claude Code Plugin (`mefisto`), aparecieron dos contextos de trabajo distintos:

1. **Proyecto consumidor**: el plugin se instala via marketplace. Los skills publicados (`/tooling`, `/implement`, ...) modifican archivos del consumidor.
2. **Repo del propio plugin**: para evolucionar el harness (anadir skills, refactorizar pipelines, crear ADRs) se necesitan operaciones equivalentes pero contra archivos del propio plugin.

Sin barrera explicita, el mismo `/tooling` podia:

- Modificar archivos del consumidor si se invocaba en su repo.
- Modificar archivos del plugin si se invocaba en el repo del plugin.

Eso permitia errores cruzados (un agente del consumidor tocando `commands/`, `agents/` o `.claude-plugin/` por accidente) y mezclaba la conversacion: "estoy mejorando mi proyecto" vs "estoy mejorando el harness".

## Decision

Separar fisicamente los dos sets:

### A. Lado publicado (distribuido via marketplace)

Permanece en el top-level del repo del plugin:

- `commands/` -- skills publicados (slash commands).
- `skills/` -- Agent Skills publicados (MEF-ADR-0033).
- `agents/` -- agentes publicados.
- `scripts/` -- pipelines bash publicados.
- `hooks/hooks.json` -- hooks publicados.

Los skills publicados:

- Solo operan sobre archivos del consumidor (workflows en `.github/`, fixtures de `tests/`, `.claude/harness.config.json`, `.claude/settings.json`, `pipeline-state/`, scripts ad-hoc del consumidor).
- Tienen un **guard defensivo** al inicio que aborta si detectan `.claude-plugin/plugin.json` en el cwd (i.e., si por error alguien los invoca dentro del repo de Mefisto).
- El pipeline `scripts/tooling-pipeline.mts` aplica un **gate de scope** (`validate_consumer_scope_changes`) que rechaza el PR si el agente toca `commands/`, `skills/`, `agents/`, `hooks/`, `.claude-plugin/` o `docs/adr/` (rutas reservadas al plugin). El blocklist enumera rutas explicitamente (`is_path_in_consumer_blocklist`), asi que **cada tipo de artefacto nuevo del plugin hay que registrarlo a mano** -- omitirlo abre un hueco silencioso en esta frontera. En que PR va ese registro: seccion E.
- Los pipelines de orquestacion (`parallel-pipeline.mts`, `batch-pipeline.mts`, `pr-sync.mts`) abortan si se invocan dentro del repo de Mefisto.

### B. Lado interno (NO distribuido)

Vive en `.claude/` del repo del propio plugin:

- `.claude/commands/` -- skills internos con prefijo `mefisto-` (`/mefisto-tooling`, `/mefisto-plan`, `/mefisto-bug`, `/mefisto-fix-review`, `/mefisto-merge`).
- `.claude/skills/` -- Agent Skills internos (MEF-ADR-0033).
- `.claude/agents/` -- agentes internos (`mefisto-investigator`, `mefisto-planner`).
- `src/internal/scripts/` -- pipelines internos (`mefisto-tooling-pipeline.mts`, `mefisto-launch-pipeline.mts`), que se invocan con `node` desde ahi (MEF-ADR-0049 decision 2); `.claude/scripts/` guarda el hook de scope del adaptador y los tests internos.

Los skills internos:

- Solo operan sobre archivos del propio plugin (`commands/`, `skills/`, `agents/`, `scripts/`, `hooks/`, `docs/`, `.claude-plugin/`, `.claude/{commands,skills,agents,scripts}/`, gobierno del repo). La allowlist tambien enumera rutas explicitamente (`is_path_in_mefisto_scope`), asi que un artefacto nuevo no registrado hace que el pipeline interno rechace su propio PR. En que PR va ese registro: seccion E.
- Tienen un **guard inverso**: abortan si NO detectan `.claude-plugin/plugin.json` (i.e., si alguien los invoca fuera del repo de Mefisto).
- Claude Code los carga automaticamente cuando se abre el repo de Mefisto, **sin necesidad de instalar el plugin sobre si mismo**. Esto se basa en que `.claude/commands/` y `.claude/agents/` son convenciones de configuracion por-repo del propio Claude Code, separadas del plugin distribuido.

### C. Routing cross-repo: solo drafts

La unica operacion permitida desde el consumidor hacia el repo de Mefisto es **crear un draft** (`estado:borrador`). El refinamiento, desglose, oleadas, backlog, analisis y limpieza de issues del plugin se hacen exclusivamente con `/mefisto-plan` dentro del repo del plugin.

- `agents/tooling-investigator.md` y `agents/planner.md` (publicados) implementan esta restriccion: si la causa raiz vive en el plugin, abren un draft con `gh -R augusto-romero-arango/mefisto ...` y detienen el flujo.
- El slug del repo de Mefisto se lee del campo `repoSlug` en `.claude/harness.config.json` (opcional; se lee inline con `jq`, no se exporta como `HARNESS_*`); default: `augusto-romero-arango/mefisto`. Esto soporta forks.

### D. Grupos de trabajo homogeneos

Los pipelines de orquestacion (`/parallel`, `/sequential`, `scripts/batch-pipeline.mts`) consultan cada issue con `gh issue view N` sin `-R`. Issues de otros repos retornan `UNKNOWN` y se descartan automaticamente. No se admiten flags `-R` ni grupos mixtos.

### E. Secuencia de registro de rutas nuevas en los gates

Los dos gates de scope (`is_path_in_consumer_blocklist` en el lado publicado, `is_path_in_mefisto_scope` en el lado interno; ambos enumeran rutas explicitamente, secciones A y B arriba) comparten una mecanica que la doctrina previa no explicitaba: **cuando** hay que registrar una ruta nueva, no solo que hay que hacerlo.

**Regla**: registrar una ruta o tipo de artefacto nuevo en los gates y usar esa ruta son dos PRs distintos. El de registro va primero, y no crea ningun archivo bajo la ruta que registra.

**Causa.** El gate se carga desde la ubicacion del propio script, no desde el worktree del PR. En el pipeline interno esa ubicacion es el checkout principal del repo, que esta en `main`: `src/internal/scripts/mefisto-tooling-pipeline.mts` importa `lib/mefisto-scope-gate.mts` relativo a su propio archivo antes de crear el worktree. El gate evaluado es entonces el que existia *antes* del PR, nunca la copia que el propio PR pueda llevar. Un PR que intenta registrar una ruta y poblarla al mismo tiempo se autobloquea: corre contra el gate viejo, que todavia no la conoce.

**Esto no es un defecto a corregir, es una propiedad de seguridad deliberada.** Si el gate leyera la copia del worktree en vez de la de `main`, cualquier writer podria anadirse a si mismo una entrada como `*) return 0 ;;` en la allowlist o el blocklist dentro de su propio PR y anular el scope por completo, sin que ninguna revision previa lo detuviera. Cargar el gate desde fuera del worktree fuerza a que el registro de una ruta nueva pase por su propio PR -- con su propia revision -- antes de que exista contenido bajo esa ruta.

**Precedente canonico** (issue #360 -> #364, MEF-ADR-0033): el PR #376 (commit `7b2c5b1`) registro `skills/*` y `.claude/skills/*` en ambos gates sin crear ningun archivo bajo esas rutas -- el unico archivo nuevo del PR fue el propio ADR MEF-ADR-0033. El PR #385 (commit `ac52351`), que resolvio el issue #364, creo `skills/projections/SKILL.md` despues, cuando `main` ya conocia la ruta. Dos PRs, ningun bloqueo.

**Contraejemplo** (issue #380): al intentar registrar `changelog.d/` y usarla en el mismo PR, `is_path_in_mefisto_scope` rechazo `changelog.d/380.added.md` porque `main` todavia no conocia la ruta. El PR #399 (commit `a9f514b`) la registro primero. El mismo issue volvio a fallar despues por el gate de CHANGELOG, que exigia una entrada en `[Unreleased]` -- justo lo que el fragmento reemplaza; el PR #401 (commit `c947844`) introdujo `changelog_fragment_added` como alternativa aceptada. Solo con ambos gates enterados en `main`, el PR #403 pudo cerrar #380.

La regla aplica por igual a los dos lados, aunque el gate quede fuera del alcance del PR por caminos distintos. Del lado interno, la allowlist (`is_path_in_mefisto_scope`, `src/internal/scripts/lib/mefisto-scope.mts`) se carga desde el checkout principal del repo -- que esta en `main` -- porque el pipeline se invoca ahi y crea el worktree como directorio aparte. Del lado publicado, el pipeline corre desde el plugin instalado (`commands/tooling.md` resuelve `PLUGIN_ROOT` bajo `~/.claude/plugins/cache/`) y lee su blocklist (`is_path_in_consumer_blocklist`, `scripts/lib/pipeline/consumer-scope.mts`) de esa copia, nunca del repo del consumidor: registrar una ruta nueva ahi es un PR de este repo, y solo alcanza al consumidor con la siguiente version del plugin. En los dos casos vale la misma invariante -- **el PR bajo revision no puede alterar el gate que lo juzga** -- y de ella se deriva la regla.

## Skills sin equivalente interno

Mefisto es un harness, no un producto. Estos skills publicados **no tienen version interna** porque no aplican conceptualmente al harness:

- `/implement` (TDD .NET de dominio).
- `/infra` (Terraform/Azure).
- `/scaffold` (crear nuevo dominio).
- `/health-check` (App Insights).
- `/show-flow`, `/eraser-diagram` (flujos EDA y diagramas).

Aun asi, todos llevan guard defensivo "cwd != Mefisto" para evitar invocaciones erroneas.

## Alternativas consideradas

### Alt 1: Un solo skill `/tooling` context-aware

Detectar el modo (`plugin` vs `consumer`) en el script via marcadores fisicos y bifurcar comportamiento.

**Descartado**: el usuario manifesto explicitamente que el lado publicado **no debe poder modificar el plugin**, ni siquiera con context-awareness, para reducir el riesgo de cruces y para que los dos sets puedan **diverger libremente** con el tiempo. Un skill unico forzaria a mantener ambas variantes en el mismo archivo, frenando la divergencia.

### Alt 2: Flag explicito `--target plugin|consumer`

Un solo `/tooling` con flag obligatorio que declare la intencion.

**Descartado**: agrega friccion al uso comun (90% del tiempo el usuario sabe en que repo esta), y no resuelve el problema de fondo (los skills del consumidor deberian NO poder modificar el plugin bajo ninguna circunstancia).

### Alt 3: Dos paquetes de plugin separados (`mefisto-core` + `mefisto-dev`)

Pros: separacion fisica dura. Contras: dos artefactos a publicar y mantener, dependencias circulares.

**Descartado**: la separacion via `.claude/` interna ya es suficiente (no se publica, fisicamente separada) sin requerir un segundo paquete.

## Consecuencias

### Positivas

- **Imposible cruzar el limite por accidente**: los skills publicados nunca tocan el plugin (gate de scope + guard defensivo); los skills internos nunca tocan el consumidor (guard inverso + scope hardcoded).
- **Divergencia libre**: los dos sets pueden evolucionar en direcciones distintas. El interno puede simplificarse (sin App Insights, sin Terraform, sin `dom:`), el publicado puede enriquecerse para el consumidor.
- **UX clara**: prefijo `mefisto-` en pantalla declara explicitamente "esto es para evolucionar Mefisto". El desarrollador del harness ve solo `/mefisto-*` (no se expone a `/implement`, `/infra` que no aplican).
- **Routing cross-repo preserva contexto**: cuando un consumidor descubre un bug del harness, el draft se crea en el repo correcto con la URL de las field notes locales como puente.

### Negativas

- **Duplicacion inicial**: los pipelines y agentes empezaran muy parecidos (mefisto-tooling-pipeline.mts es ~85% identico a tooling-pipeline.mts). Aceptado deliberadamente; refactorizar a un common compartido solo cuando la duplicacion duela en la practica (regla de tres -- MEF-ADR-0018).
- **Guard defensivo en cada skill**: cada `.md` lleva un bloque de pre-condicion. Un developer puede olvidarlo al anadir un skill nuevo. Mitigacion: test de guards (`scripts/tests/`) que itera sobre todos los skills publicados y verifica que abortan al invocarse en Mefisto.
- **Fork del repo de Mefisto**: el slug hardcodeado en el routing del publicado queda incorrecto para forks. Mitigado con el campo opcional `repoSlug` en `.claude/harness.config.json` (default: `augusto-romero-arango/mefisto`).
- **Documentacion adicional**: este ADR + secciones nuevas en CLAUDE.md y README.md son necesarias para que un nuevo developer entienda los dos sets.

## Referencias

- Conversacion de diseno y plan detallado: `~/.claude/plans/me-qued-con-una-quiet-bunny.md` (commits del 2026-05-15).
- MEF-ADR-0018 (heuristicas de evolucion y reuso): justifica posponer el refactor a un common compartido entre lado publicado e interno.
- MEF-ADR-0007 (gestion de proyecto con GitHub Issues): los labels `tipo:tooling` y `estado:borrador|listo` se aplican igual en ambos repos.
- MEF-ADR-0011 (Definition of Ready por tipo de issue): el DoR del harness es una version simplificada del DoR del consumidor (sin "Modelo de eventos", sin `dom:`).
- MEF-ADR-0033 (adopcion de Agent Skills): extiende esta misma separacion publicado/interno a un tercer tipo de artefacto (`skills/` y `.claude/skills/`) y registra ambas rutas en los gates de scope.

## Control de cambios

- 2026-05-15: creacion como `aceptado`.
- 2026-07-26: enmienda por MEF-ADR-0033 (issue #360). Se agrega el tercer tipo de artefacto a los dos lados de la separacion (`skills/` publicado, `.claude/skills/` interno) y se registra en los gates de scope: `skills/*` en el blocklist publicado (`is_path_in_consumer_blocklist`), `skills/*` y `.claude/skills/*` en la allowlist interna (`is_path_in_mefisto_scope`), con cobertura en `scripts/tests/test-guards.sh`. Se explicita que ambos gates enumeran rutas de forma explicita, por lo que todo tipo de artefacto nuevo debe registrarse a mano.
- 2026-07-26: enmienda por issue #406, a raiz de los dos bloqueos consecutivos del issue #380 (PRs #399 y #401). Se agrega la seccion E ("Secuencia de registro de rutas nuevas en los gates"): registrar una ruta y usarla son dos PRs distintos porque los pipelines cargan su gate con `source` desde `main`, no desde el worktree -- se documenta esa mecanica como propiedad de seguridad deliberada (no un defecto) y se cita el precedente canonico #360/PR #376 -> #364/PR #385 frente al contraejemplo #380. Las secciones A y B remiten a E para la secuencia, y la regla queda propagada al prompt del writer del pipeline interno y al resumen de la separacion publicado/interno en CLAUDE.md.
- 2026-10-12: enmienda por issue #2349. El repo se renombra en GitHub a `augusto-romero-arango/mefisto` y el default de `repoSlug` (secciones C y Consecuencias) pasa a ese slug. El nombre previo (`eda-evsourcing-azure-harness`) sigue resolviendo por la redireccion de GitHub; el marketplace (`augusto-romero-arango-harness`) y el id del plugin no cambian.
- 2026-11-10: seccion B: el lanzador interno pasa a llamarse `mefisto-launch-pipeline.sh` (antes `mefisto-tmux-pipeline.sh`). Sale tmux, que no existe en Windows nativo (MEF-ADR-0057 decision 5).
- 2026-11-12: las librerias bash `_pipeline-common.sh` y `_mefisto-common.sh` se borran (port a TypeScript, MEF-ADR-0057): la seccion B deja de listar `_mefisto-common.sh` y la seccion E cita los modulos que hoy cargan cada gate (`mefisto-scope.mts`, `mefisto-scope-gate.mts` y `consumer-scope.mts`). Sin cambio de doctrina.
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts`, y los pipelines internos figuran en `src/internal/scripts/`, desde donde se invocan con `node` (MEF-ADR-0049 decision 2).
