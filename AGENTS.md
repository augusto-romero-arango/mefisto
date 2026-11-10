# AGENTS.md — mefisto

Harness opinionado para agentes de codigo (nombre interno: `mefisto`, repo: `augusto-romero-arango/mefisto`, antes `eda-evsourcing-azure-harness`): orquesta el desarrollo asistido de aplicaciones .NET 10 serverless en Azure con Event Driven Architecture y Event Sourcing. Claude Code se conserva como runtime compatible detras de un adaptador; OpenCode es el runtime del dogfooding interno (MEF-ADR-0049).

## Principios de respuesta

- Comunícate siempre en **español**.
- **Cita fuentes verificables** al afirmar una best practice o recomendación técnica — documentación oficial, libro, RFC, ADR del harness o del proyecto consumidor. Si es conocimiento general sin fuente, dilo explícitamente.

## Qué es este repo

Empaqueta skills, agentes, pipelines bash, ADRs y hooks (ver `ls` en la raíz del repo para el
layout exacto) con doctrina neutral a runtime (MEF-ADR-0049); el adaptador `.claude/` distribuye
ese contenido como **Claude Code Plugin** (ver `.claude-plugin/plugin.json`). Además incluye:

- Un **servidor MCP bundleado** en `.mcp.json` en la raíz del plugin (`mcpServers.microsoft-learn`, endpoint HTTP remoto de Microsoft Learn, sin autenticación — ningún secreto viaja en la configuración, MEF-ADR-0025): lo usa el `planner` para verificar documentación oficial de Azure/.NET/C# al redactar issues

Está pensado para instalarse vía marketplace en cualquier proyecto que adopte el marco (EDA + Event Sourcing + Azure Functions + Marten + Wolverine + Postgres).

## Stack tecnológico del marco

- **Runtime**: .NET 10, C#, Azure Functions isolated worker
- **Persistencia**: PostgreSQL + Marten (event store)
- **Mediación de comandos**: Wolverine en modo serverless
- **Mensajería entre dominios**: Azure Service Bus (topic por evento — ver MEF-ADR-0001)
- **Testing**: xUnit v3 + `Cosmos.EventSourcing.Testing.Utilities` (DSL Given/When/Then/And — ver MEF-ADR-0002)
- **IaC**: Terraform
- **CI/CD**: GitHub Actions

## Contrato con el proyecto consumidor

Esquema completo de `.claude/harness.config.json`, las secciones obligatorias `Tokens del harness`
y `Verificación de fuentes` en el `AGENTS.md` del consumidor, el puente mínimo `CLAUDE.md` con
`@AGENTS.md` y la estructura de carpetas esperada: ver skill interno
`harness-config-contract` (`.claude/skills/harness-config-contract/SKILL.md`).

## Catálogo de skills

| Skill | Propósito |
|---|---|
| `/onboard` | Diagnostica el onboarding del consumidor (config, labels, CI) y reporta un checklist; provisión opt-in bajo confirmación |
| `/upgrade` | Actualiza Mefisto desde el runtime activo (Claude Code u OpenCode) con `upgrade.sh`: consulta el estado del par de adaptadores; alinea automáticamente `enabled`/`stale`, ofrece habilitar `disabled` con una confirmación y deja `conflict` sin mutar; evidencia versiones e identidad, y poda solo el runtime activo bajo confirmación (nunca la versión cargada ni el par) |
| `/runtimes` | Consulta y administra la proyección de adaptadores instalados: estado, habilitación y deshabilitación sin descargar, actualizar ni seleccionar una release |
| `/draft` | Captura una idea como issue `estado:borrador` |
| `/implement` | Pipeline TDD para un issue `estado:listo` |
| `/tooling` | Pipeline de tooling (scripts, fixtures, config, agentes) |
| `/infra` | Pipeline IaC con Terraform (write → review → apply) |
| `/infra-base` | Genera la infraestructura base (8 módulos + esqueleto del entorno) en greenfield; suma los 3 módulos del worker de proyecciones si `projections.enabled` |
| `/seed-secret` | Registra y cablea un secreto nuevo post-greenfield (Key Vault + Function App de un dominio) |
| `/install-workos` | Guia el dashboard de WorkOS AuthKit (cuenta, client_id, API key, rol admin) y cablea el adapter (agente de identidad) + la custodia de la API key (`/seed-secret`) |
| `/install-apim` | Instala/actualiza el gateway APIM (agente `apim-gateway-scaffolder`), cablea `TF_VAR_workos_client_id`/`TF_VAR_cors_allowed_origins` y ejecuta la transicion a->b de tenancy (MEF-ADR-0028 seccion 4): flip de `tenancy.strategy` + scaffold de la biblioteca `src/{RootNamespace}.TenantResolver/` (patron AsyncLocal + middleware) + migracion del `ITenantResolver` de todos los dominios ya scaffoldeados a esa biblioteca; expone ademas en el mismo flip los servidores MCP ya scaffoldeados del BC (modulo `apim-mcp-api` + enrutador del PRM, gate OAuth de la variante MCP/Connect) |
| `/install-auth` | Orquesta el camino completo de auth: encadena `/install-workos` -> gate humano (verifica `WORKOS_CLIENT_ID`/`WORKOS_API_KEY` via `gh`) -> `/install-apim`, stateless (delega en la idempotencia de ambos) |
| `/parallel` | Corre varios issues en worktrees aislados |
| `/batch-stop` | Escribe la senal de parada suave (`pipeline-state/batch-stop`, MEF-ADR-0017) que detiene los orquestadores con cola -- `batch-pipeline.sh` (el motor de `/sequential`) y `parallel-pipeline.sh` invocado directo -- sin matar ningun proceso: el eslabon o los worktrees en vuelo terminan, la cola deja de lanzar issues nuevos y los no procesados quedan `aplazado`. `/parallel` en modo pane lanza todo de entrada (un pane por issue, sin cola) y no tiene nada que retener |
| `/next-order` | Calcula el orden topológico de lanzamiento de los issues `estado:listo` del consumidor y deja lista la línea de `/mefisto:sequential` |
| `/sequential` | Cadena de issues con merge automático |
| `/scaffold` | Crea el scaffold de un nuevo dominio |
| `/scaffold-mcp` | Genera el proyecto de un servidor MCP (`{RootNamespace}.Mcp.{Proposito}`): Azure Functions isolated worker sin `ProjectReference` al BC, seams de HttpClients tipados y observabilidad, el propagador de identidad tenant/usuario, los componentes OAuth app-side de defensa en profundidad (PRM, validador de token, middleware) y, con `multi-tenant-header`, la identidad derivada del token del usuario con la tool `obtener_sesion` (#1934), tool de ejemplo con el patron completo, endpoints de gate `VersionCheck`/`ReadyCheck`, unit tests base, el Terraform del servidor (Service Plan + Storage + Function App), el workflow de deploy encadenado tras el apply de infra y la suite `SmokeTests` e2e (cinco verificaciones canonicas) con el reusable `smoke-tests-mcp.yml` encadenado tras el deploy (fases 1+2+3 + identidad/OAuth app-side #819, agente `mcp-scaffolder`, MEF-ADR-0047/MEF-ADR-0048) |
| `/scaffold-projections` | Genera el worker de proyecciones (`{RootNamespace}.Projections`), `{RootNamespace}.ReadModels`, el config-test base `{RootNamespace}.Projections.Tests`, el seam de observabilidad `ConfiguracionObservabilidadProjections` (con el sampler que descarta el polling del daemon, MEF-ADR-0038), el workflow de deploy `deploy-projections.yml` y el `.dockerignore` del build context cuando el BC habilita el token `projections.enabled` (fase 1+2+3+4+5+6, agente `projections-scaffolder`) |
| `/bug` | Investiga un síntoma (bug-investigator o tooling-investigator) |
| `/fix-review` | Resuelve comentarios pendientes de un PR |
| `/health-check` | Dashboard del entorno desplegado |
| `/eraser-diagram` | Genera diagrama para Eraser |
| `/merge` | Mergea uno o varios PRs a main |
| `/bitacora` | Invoca al agente `historiador` y, si crea PR, encadena `/merge` automaticamente |
| `/purge-store` | Diagnostica con evidencia (App Insights, smoke tests), confirma y valida la purga del store de un dominio en dev (mecanismo canonico de MEF-ADR-0036 seccion 5; los pasos destructivos los ejecuta `scripts/purge-store.sh`) |

## Agent Skills disponibles

Doctrina pesada empaquetada con *progressive disclosure* (MEF-ADR-0033); no son slash commands. Un agente las precarga con el frontmatter `skills:`, o Claude las dispara solo cuando la tarea coincide con su `description`.

| Agent Skill | Doctrina que empaqueta |
|---|---|
| `projections` (`skills/projections/`) | Read-side: recetas de proyección Marten (N1/N2/N3), estilo canónico de read model, read APIs sobre `QuerySession` tenant-scoped, naming de Functions de query y config-test del worker (MEF-ADR-0035/0034/0006) |
| `comment-cleanup` (`skills/comment-cleanup/`) | Mecánica de limpieza de comentarios en `.cs`: clasificar, aplicar el umbral doble Context Delta/Decision Delta, codificar en el código, comprimir los sobrevivientes y releer (MEF-ADR-0044) |

## Agentes

El catálogo y propósito de cada agente vive en el frontmatter `description` de `agents/*.md` (listables con `ls agents/`).

## ADRs del marco

Los ADRs en `docs/adr/` son la fuente de verdad arquitectónica del harness, identificados con el prefijo `MEF-ADR-` (esquema de identificación con prefijo por proyecto, ver **MEF-ADR-0030**). Los agentes los consultan, los aplican y documentan cuando se desvían.

El proyecto consumidor puede tener sus propios ADRs adicionales (sobre dominio o configuración específica). Adoptar el mismo esquema de prefijo es **opcional**: un consumidor nuevo puede elegir su propio código corto (p. ej. `CA-ADR-` para Control de Asistencias, `CPC-ADR-` para Cosmos ControlPlane) para desambiguar sus ADRs frente a los del marco; un consumidor con ADRs legados puede quedarse citándolos como `ADR-XXXX` a secas, sin conflicto — `ADR-XXXX` nunca coincide textualmente con `MEF-ADR-XXXX`.

### Índice temático

Ver `docs/adr/INDICE-TEMATICO.md` (migrado fuera de este archivo por tamaño: era el 34% de las
directivas de la raíz). Mismo régimen de edición: `/mefisto-release` es el único que la consolida,
por fragmento en `changelog.d/<issue>.adr-index.md`.

## Convenciones del marco

### Issues (gestionados con GitHub)

- **Títulos**: `[verbo infinitivo] [qué cosa]` — sin prefijos.
- **Labels obligatorios**: `tipo:X` + `dom:X` + `estado:{borrador|listo}` (asignados por el planner).
- **Dependencias**: declaradas en sección `## Dependencias`.
- **Bloqueados**: label `bloqueado` cuando dependen de otro no cerrado.
- **Definition of Ready**: ver MEF-ADR-0011 — los skills de pipeline lo validan antes de ejecutar.

### Flujo de entrega

- **Nunca trabajar contra `main` directo.** Toda edición de archivos en este repo se hace en una rama nueva y se entrega vía Pull Request.
- **Ninguna sesión de trabajo directo edita ni commitea en el checkout principal** (issue #2108): mover su `HEAD` compartido hace que otra sesión commitee o empuje sobre una rama ajena, incluida `main`. Antes de la primera edición, si `git rev-parse --git-dir` es igual a `git rev-parse --git-common-dir` (checkout principal), crear el worktree con `src/internal/scripts/mefisto-worktree.sh new <slug>` (shim: `.claude/scripts/mefisto-worktree.sh`; hace `git fetch origin main`, crea `.mefisto/worktrees/<slug>` en la rama `<slug>` desde `origin/main`, o lo reutiliza, e imprime su ruta) y editar, commitear, empujar y abrir el PR desde ahí. Si la sesión ya está en un worktree (p. ej. lanzada con `claude -w <slug>`), seguir ahí. Nunca `git switch`/`git checkout` de rama en el checkout principal.
- En Claude Code se recomienda lanzar las sesiones de trabajo directo con `claude -w <slug>` (atajo del adaptador; el helper es la vía neutral a runtime, MEF-ADR-0050). Los pipelines internos también crean sus worktrees bajo `.mefisto/worktrees/` (issue #2336). Tras mergear el PR, limpiar con `mefisto-worktree.sh clean`: recorre todos los worktrees del repo (también los antiguos creados al lado del repo), elimina los de rama mergeada en `origin/main` con status limpio y las raíces de batch cuyo proceso ya no existe, y conserva (con aviso) los que tienen cambios sin commitear o trabajo sin mergear.
- Al terminar: `git push -u origin <rama>` + `gh pr create` apuntando a `main`.
- **Red de seguridad `pre-push`** (issue #2110): `src/internal/githooks/pre-push` (activado por `ensure_githooks_installed` vía `core.hooksPath`) desvía un push directo a `main`/`master` a una rama `rescate/<fecha>-<sha>` con su PR, anota los SHAs en `.mefisto/pipeline/rescued-main.txt` y rechaza solo ese push. Detrás está el ruleset `main` de GitHub (`.github/rulesets/main.json`): PR obligatorio, sin force-push, sin borrado y sin bypass, así que ni `git push --no-verify` llega a `main`; todo cambio entra por PR.
- **Los cambios notables se anotan como fragmento en `changelog.d/`, nunca editando `CHANGELOG.md` ni el índice temático de ADRs (`docs/adr/INDICE-TEMATICO.md`)** (issue #380). Un archivo por issue (`changelog.d/<issue>.<categoria>.md`, y `changelog.d/<issue>.adr-index.md` si el issue toca `docs/adr/`); ver `changelog.d/README.md`. Editar esos dos archivos-índice por-PR es la contención que colisionaba entre PRs paralelos: sólo `/mefisto-release` los consolida, y sólo en su rama de release.

### Mods

- **Paridad con el par** (MEF-ADR-0055 decisión 11): antes de cambiar un mod, estudia cómo lo resuelve su par del otro lado (tablero o consola, interno o publicado) y propón sobre ese patrón: ubicación de menús, lo que ve el usuario, cómo se pide input, teclas y mascota. Apartarse es una decisión explícita, no un descuido.

### Código C#

- **Caracteres prohibidos en `.cs`**: nunca `─` (U+2500) ni decorativos Unicode. Solo guión ASCII `-`.
- **Comentarios**: solo lo que no es obvio al leer el código, en una frase si se puede; default sin comentario (MEF-ADR-0044, rige también HCL, bash, TypeScript y YAML).
- **Commits**: en español, descriptivos, frecuentes.
- **Ramas de trabajo**: `worktree-issue-<num>-<slug>` (los pipelines las crean para el proyecto consumidor).
- **PRs**: deben incluir `Closes #<número>` cuando resuelven un issue.

## Notas para definir agentes y skills

Declaración de tools MCP en allowlists (incluido el prefijo scoped cuando el servidor lo provee
un plugin) y cuándo envolver doctrina extensa en un Agent Skill: ver skill interno
`agent-skill-authoring` (`.claude/skills/agent-skill-authoring/SKILL.md`).

## Dos paquetes de tooling: publicado vs interno

Mefisto mantiene **dos sets** de skills/agentes/pipelines físicamente separados (doctrina completa en MEF-ADR-0019):

- **Publicados** (`commands/`, `skills/`, `agents/`, `scripts/`, `hooks/`): se distribuyen vía marketplace y operan únicamente sobre archivos del consumidor.
- **Internos** (`.claude/commands/`, `.claude/skills/`, `.claude/agents/`, `.claude/scripts/`): no se publican; el runtime de agente activo (Claude Code u OpenCode, MEF-ADR-0049) los carga al abrir este repo. Llevan prefijo `mefisto-` y operan solo sobre archivos del propio plugin.

Toda operacion de cualquiera de los dos sets -- skill, comando, agente, pipeline, hook o Agent Skill -- nace neutral a runtime, con el conjunto de runtimes soportados abierto (MEF-ADR-0050): "soportado" significa unicamente "tiene adaptador en el repo", hoy Claude Code y OpenCode.

Dentro del lado interno, `src/internal/{agents,commands}/*.md` es la **fuente neutral** (MEF-ADR-0049): `.claude/{agents,commands}/*.md` y `.opencode/{agents,commands}/*.md` son su **salida generada** por `src/internal/scripts/generate-internal-adapters.sh` y **no se editan a mano** — se edita la fuente y se regenera (`--check` falla si divergen). Los pipelines internos viven en `src/internal/scripts/` y `.claude/scripts/` es su superficie estable con shims de tres lineas (MEF-ADR-0049 decision 2); la unica excepcion es `mefisto-scope-hook.sh`, hook `PostToolUse` del adaptador Claude, cuyo equivalente en OpenCode es la politica de permisos `edit/write/patch` generada desde `is_path_in_mefisto_scope` (deniega antes de escribir; paridad verificada por `test-scope-parity.sh`, MEF-ADR-0050). Los Agent Skills internos siguen el mismo modelo (issue #1685): la fuente canonica es `src/internal/skills/<id>/` y `generate-internal-adapters.sh` genera `.claude/skills/<id>/` con marcador (OpenCode ya descubre esa ruta, verificado en `src/internal/contract/README.md`, asi que no se emite `.opencode/skills/`); `--check` los cubre igual que a agentes y comandos.

`skills/` y `.claude/skills/` son las ubicaciones de Agent Skills (MEF-ADR-0033) y ya están registradas en los gates de scope; el primero publicado es `skills/projections/` (ver "Agent Skills disponibles"), y del lado interno están `harness-config-contract` y `agent-skill-authoring` (fuente en `src/internal/skills/`). La integridad de todo Skill nuevo (su `name` frontmatter, sus recursos de Nivel 3 y las referencias `skills:` de los agentes) la valida el bloque `[F]` de `scripts/tests/test-guards.sh`: un `skills:` mal escrito degrada en silencio, sin error visible en un pipeline headless. **Todo tipo de artefacto nuevo del plugin debe registrarse a mano** en el blocklist publicado (`is_path_in_consumer_blocklist`) y en la allowlist interna (`is_path_in_mefisto_scope`): ambos enumeran rutas explícitamente. Ese registro y el uso de la ruta son **dos PRs distintos, y el de registro va primero** — el gate que juzga un PR se carga fuera de su worktree, así que un PR que registra una ruta y la puebla a la vez se autobloquea (regla completa en MEF-ADR-0019, sección E).

La única operación cross-repo desde el consumidor hacia Mefisto es **crear drafts** (`estado:borrador`); el refinamiento y demás gestión de issues ocurre con `/mefisto-plan` dentro de este repo.

## Instalación en un proyecto

Ver `README.md`.

## Trabajar sobre el propio plugin

Si estás clonando este repo (Mefisto) para evolucionarlo, **no necesitas instalar el plugin sobre sí mismo**. El runtime de agente activo (Claude Code u OpenCode, MEF-ADR-0049) carga automáticamente los skills internos desde `.claude/commands/` y `.claude/agents/` del repo activo. Los pipelines internos viven bajo `.claude/scripts/`.

Workflow típico:

1. Captura una idea: `/mefisto-plan` (modo draft) o `gh issue create --label "estado:borrador,tipo:tooling" --title "..."`.
2. Refina: `/mefisto-plan` (modo refinar) hasta `estado:listo`.
3. Si vas a lanzar varios issues juntos, calcula el orden: `/mefisto-next-order`.
4. Implementa: `/mefisto-tooling <issue>`. El pipeline crea worktree, ejecuta writer+reviewer, valida scope y abre PR. Para seguir la corrida en vivo con el visor abierto en un tercer pane, usa `/mefisto-tooling-verbose <issue>` en su lugar (delega integramente en `/mefisto-tooling`, solo lanza con `--verbose`).
5. Revisa: comentarios del PR → `/mefisto-fix-review <pr>`.
6. Mergea: `/mefisto-merge <pr>` (squash + delete-branch, sin `pr-sync.sh`).
7. Pon al dia la bitacora: `/mefisto-bitacora` (invoca al agente `mefisto-historiador`, verifica el PR resultante y sugiere `/mefisto-merge <N>` o `gh pr close <N>`; no lo mergea).
