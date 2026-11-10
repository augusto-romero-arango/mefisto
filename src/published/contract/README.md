# Contrato de artefactos publicados (`src/published/contract/`)

Las fuentes de `src/published/{agents,commands}/` describen capacidades sobre
un proyecto consumidor, nunca sobre el repositorio de Mefisto (MEF-ADR-0019 y
MEF-ADR-0053). Cada archivo se llama `<id>.md`, contiene frontmatter JSON entre
`---` y un body Markdown. El `id` es kebab-case sin `mefisto-`, `mefisto:` ni
separadores de runtime. `$ARGUMENTS` es el único placeholder de argumentos.

## Frontmatter

`published-artifact.schema.json` es la única declaración de campos. Todos los
objetos rechazan propiedades adicionales.

| Campo | Agente | Comando | Claude Code |
|---|---|---|---|
| `kind` | requerido | requerido | selecciona tipo de salida; no se emite |
| `id` | requerido | requerido | nombre de archivo/ruta; no se emite |
| `description` | requerido | requerido | `description` |
| `mode` | requerido | no | campo del contrato que el adaptador no traduce; no se emite |
| `profile` | sí | sí | `model` resuelto por tabla del adaptador |
| `effort` | requerido | no (rechazado) | `effort` nativo por tabla del adaptador (`quick`->`low`, `light`->`medium`, `standard`->`high`, `thorough`->`xhigh`, `exhaustive`->`max`), justo después de `model` |
| `capabilities` (`read`, `edit`, `shell`, `web`, `skill`, `task`, `ask`) | sí | sí | `tools`/`allowed-tools` generados (`ask` -> `AskUserQuestion`) |
| `skills` | sí | sí | `skills` con ids fuente, sin prefijo |
| `mcp` | sí | sí | matcher scoped por id lógico |
| `agent` | no | sí | delegación al agente generado |
| `arguments` | no | sí | `argument-hint` |

### Effort en conversaciones

En Claude Code la conversacion usa el `effort` de fabrica del frontmatter. El
ajuste local de `.mefisto/models.json` rige solo en pipelines;
`CLAUDE_CODE_EFFORT_LEVEL` es la unica via en conversaciones y es global.

Las capacidades son intenciones cerradas: `read`, `edit`, `shell`, `web`,
`skill`, `task`. Este es el mapping que los adaptadores deben materializar;
cualquier tool o permiso no derivado queda denegado:

| Capacidad | Claude Code (`tools`/`allowed-tools`) |
|---|---|
| `read` | `Read`, `Glob`, `Grep` |
| `edit` | `Edit`, `Write` |
| `shell` | `Bash` |
| `web` | `WebFetch`, `WebSearch` |
| `skill` | `Skill` |
| `task` | `Task` |

El mapping solo concede permisos sobre el consumidor. `edit` queda sujeto al
scope/gate del pipeline consumidor correspondiente: no sourcea ni replica como
autoridad `is_path_in_mefisto_scope`.

`mcp` no es una tool ni un permiso de runtime: es una lista de ids lógicos
kebab-case. `mcp-servers.json` es la autoridad neutral de esos ids y de su
provisioning; `published-artifact.schema.json` debe conservar exactamente el
mismo enum y orden. El registro inicial distingue `microsoft-learn` como
`bundled` (HTTP remoto HTTPS, sin autenticación) de `terraform` como
`external` (sin transporte, URL ni autenticación): Mefisto no distribuye ni
custodia Terraform. Agregar otro id requiere actualizar el registro, el
contrato y los mappings de todos los adaptadores. Si un runtime carece del
mapping de un id declarado, su validación/generación aborta; nunca concede MCP
genérico.

El registro no admite headers, environment, OAuth, tokens, secretos ni otras
credenciales. Para cada entrada `bundled`,
`validate-published-mcp.sh` deriva en memoria la proyección Claude
(`remote-http` a `type: http`) y exige que `.mcp.json` sea idéntico, sin
servidores externos ni claves adicionales. `.mcp.json` sigue versionado como
adaptador Claude, no como autoridad conceptual.

| Provisioning neutral | Claude Code |
|---|---|
| `microsoft-learn` / `bundled` | `.mcp.json`, HTTP remoto sin autenticación |
| `terraform` / `external` | instalación externa al plugin |

Un comando que declara `mcp` debe delegar en un agente neutral existente cuyo
`mcp` sea un superconjunto; el validador rechaza la ausencia de agente o
cualquier subconjunto incumplido. Para un id `external` el adaptador emite el
matcher igual que para uno `bundled`: Mefisto no instala binarios, plugins ni
credenciales.

Toda referencia `skills` debe resolver a un `skills/<id>/SKILL.md` publicado,
ser única y conservar el id lógico sin prefijo. Claude Code materializa esos
ids directamente en el frontmatter de los agentes; en un comando la declaración
se valida y habilita la directiva `skill-root`, sin emitirse.

| Referencia neutral | Claude Code |
|---|---|
| `skills: ["x"]` | frontmatter `skills: ["x"]` |

Las referencias `agent`, igual que los argumentos `<id>` de las directivas,
también conservan ids fuente sin prefijo. El prefijo adaptado no pertenece a la
fuente.

## Layout de Skills empaquetados

Los Skills publicados son fuente de solo lectura bajo `skills/<id>/`: `SKILL.md`
es Nivel 2 y sus recursos relativos son Nivel 3 (MEF-ADR-0033). El adaptador
Claude no los transforma ni los copia: el plugin los distribuye desde esa misma
ruta con su id lógico, y `skill-root` resuelve a `skills/<id>/` bajo
`MEFISTO_PACKAGE_ROOT`.

## Directivas del body

Todo artefacto incluye `{{mefisto:assert-consumer-repo}}`, que aborta si el cwd
es el repositorio de Mefisto. Cualquier directiva `{{mefisto:...}}` no listada
o mal formada se rechaza.

| Directiva | Claude Code |
|---|---|
| `{{mefisto:assert-consumer-repo}}` | guard generado que aborta en el repo de Mefisto |
| `{{mefisto:launch-agent <id> <mensaje>}}` | instrucción de invocar la tool `Task` con el agente `mefisto:<id>` y el mensaje dado |
| `{{mefisto:run <script> <args>}}` | `MEFISTO_RUNTIME=claude` + script bajo `MEFISTO_PACKAGE_ROOT` + argumentos |
| `{{mefisto:package-root}}` | `MEFISTO_PACKAGE_ROOT` |
| `{{mefisto:skill-root <id>}}` | raíz de `skills/<id>/` bajo `MEFISTO_PACKAGE_ROOT` |
| `{{mefisto:command-doc <id>}}` | ruta de `commands/<id>.md` bajo `MEFISTO_PACKAGE_ROOT` |
| `{{mefisto:config-path}}` | `MEFISTO_CONFIG_PATH` (ruta efectiva de lectura) |
| `{{mefisto:instructions-path}}` | `MEFISTO_INSTRUCTIONS_PATH` (ruta efectiva de lectura) |
| `{{mefisto:state-path <rel>}}` | `.mefisto/pipeline/<rel>` del consumidor |
| `{{mefisto:command <id>}}` | `/mefisto:<id>` |

### Delegación en agentes

Hay dos formas, excluyentes dentro de un mismo comando:

1. **Delegación de comando completo**: el frontmatter `agent: <id>`. En Claude
   Code el body queda precedido por la instrucción de invocar `Task` con
   `mefisto:<id>`, pasándole `$ARGUMENTS` y las instrucciones del body, sin que
   la sesión primaria las ejecute.
2. **Delegación puntual**: `{{mefisto:launch-agent <id> <mensaje>}}` en el body.
   El mensaje es obligatorio, texto libre en una línea (sin `{` ni `}`), y puede
   citar variables que el comando ya resolvió. El adaptador lo traduce a la
   invocación de la tool de subagentes sobre el agente generado de su
   distribución; el agente devuelve su resultado final y el comando continúa
   con el paso siguiente. Nunca delega el comando completo, así que los
   pasos propios del comando conservan su política de permisos (MEF-ADR-0031).

Un body puede tener varias delegaciones puntuales (alternativas o sucesivas). Un
comando que declara `agent` no puede además usar `launch-agent`. El validador
rechaza `launch-agent` sin mensaje, con un id inexistente en
`src/published/agents/` o junto a `agent`; la regla de MCP considera la unión de
los `mcp` de todos los agentes delegados. `command-doc` compone comandos por
lectura del body, por eso la delegación puntual, expresada en el body, es la
forma que sobrevive a esa composición.

Decisión sobre la capacidad `task`: el comando no la declara; la sesión primaria
del usuario ya dispone de la tool de subagentes y `allowed-tools` solo
preaprueba, no restringe su disponibilidad.

Verificación empírica (CA-6, #1687): pendiente. Requiere una sesión interactiva
real de cada runtime con un comando fixture de delegación puntual; no se pudo
ejecutar en el pipeline no interactivo. Hasta registrar fecha y versión de cada
runtime, la devolución del resultado al comando no está certificada.

Los adaptadores materializan comandos como `/mefisto:<id>`. El body no puede
nombrar CLIs, variables, cachés, directorios ni metadata de un runtime. Tampoco
admite placeholders distintos de `$ARGUMENTS`.

`skill-root` acepta exclusivamente un id kebab-case lógico, sin prefijo de
runtime. El id debe existir bajo `skills/<id>/SKILL.md` y estar declarado en
`skills` por ese mismo artefacto; por tanto expresa una dependencia ya cargada,
no un inventario alternativo. `command-doc` acepta exclusivamente un id kebab-case lógico de un comando
publicado (`src/published/commands/<id>.md`), sin prefijo de runtime, y un
comando no puede referirse a sí mismo. La ruta apunta al comando **generado de
la distribución activa**, que ya trae sus directivas traducidas para esa
sesión. Su uso previsto es la composición por lectura (leer la doctrina de otro
comando en lugar de duplicarla), no su ejecución.

Cuando un body usa `run`, `package-root`, `skill-root` o
`command-doc`, el adaptador antepone un bloque Bash
que valida y exporta una única raíz física sin barra final:
`MEFISTO_PACKAGE_ROOT`. Claude valida la distribución cargada desde su variable
de runtime o los markers canónico/legacy del consumidor. Esta mecánica es
exclusiva de cada salida: la fuente neutral y sus callers no conocen variables
ni layouts de runtime.

Cada invocación traducida de `{{mefisto:run <script> <args>}}` fija además,
como asignación en línea inmediatamente antes del script, `MEFISTO_RUNTIME=<id
del adaptador>` (`claude` en el adaptador de Claude Code). El adaptador impone
su propio runtime sobre cualquier valor que ya traiga el entorno: es la misma
garantía de `mefisto_resolve_runtime` (MEF-ADR-0050) que evita que un pipeline
lanzado desde un runtime corra sus scripts bajo el identificador de otro cuando
la máquina tiene más de uno instalado y el entorno no fija la variable.

`config-path` e `instructions-path` no traducen a una ruta canónica literal:
resuelven la ruta efectiva de lectura del contrato consumidor descrita en
MEF-ADR-0053 sección 4 (canónica primero, fallback legacy de lectura
únicamente si la canónica falta, aborto con diagnóstico si no existe ninguna).
Cuando un body usa una o ambas directivas, el adaptador antepone un único
bloque Bash adicional -- independiente del de `package-root` -- que resuelve
cada ruta usada exactamente una vez y exporta `MEFISTO_CONFIG_PATH` y/o
`MEFISTO_INSTRUCTIONS_PATH`; cada aparición inline de la directiva se traduce
a la variable ya resuelta, de modo que varios usos en el mismo body comparten
esa única inicialización. Si existen ambas variantes de una misma ruta, el
bloque generado elige la canónica, informa por stderr que ignora la legacy y
nunca combina contenido de las dos. Para `config-path`, la precedencia y el
texto de los diagnósticos coinciden con `resolve_harness_config_path read` de
`scripts/_pipeline-common.sh` -- con las rutas expresadas relativas a la raíz
del consumidor, donde el resolver las interpola absolutas; para `instructions-path`, el mismo mecanismo
aplica sobre las directivas del consumidor y el diagnóstico de ausencia total
apunta a `{{mefisto:command onboard}}`. Los nombres de archivo legacy
concretos sólo existen dentro de ese bloque generado, nunca en la fuente
neutral ni en este contrato.

## Validación

```bash
src/published/scripts/validate-published-artifacts.sh [archivo...]
```

Sin argumentos valida `src/published/{agents,commands}/*.md`. Cada rechazo usa
`<archivo>: <campo|body>: <motivo>`. El script requiere Bash 3.2 y `jq`; los
fixtures y su prueba están en este contrato y en
`scripts/tests/test-published-artifact-contract.sh`.

```bash
src/published/scripts/validate-published-mcp.sh
```

El segundo validador comprueba el schema del registro, sus reglas cruzadas, la
sincronía del enum MCP y la proyección `.mcp.json`; tampoco realiza llamadas de
red.
