# MEF-ADR-0053: Distribucion multi-runtime de Mefisto para consumidores

- **Fecha**: 2026-09-07
- **Estado**: aceptado
- **Aplica a**: la arquitectura publicada de Mefisto que se distribuye a proyectos consumidores. Resuelve los tres diferidos de MEF-ADR-0049 -- layout `dist/`, distribucion para runtimes sin plugin y version activa global por usuario -- despues del cierre de su gate interno (#874 y #879). No reemplaza la separacion publicado/interno de MEF-ADR-0019, la arquitectura interna de MEF-ADR-0049 ni el principio transversal de MEF-ADR-0050.

**Issues bloqueados por este ADR**: #1043, #1047, #1049, #1050, #1051 y #1057; y, transitivamente, el rollout #1044-#1066.

## Contexto

El rollout interno de MEF-ADR-0049 ya resolvio `MEFISTO_RUNTIME`, el runner neutral y los adaptadores internos. El artefacto publicado, en cambio, sigue siendo exclusivamente un Claude Code Plugin: el marketplace apunta a la raiz del checkout, `plugin.json` porta su version y los comandos/pipelines publicados conocen `CLAUDE_PLUGIN_ROOT`, el cache de marketplace, `CLAUDE.md` y `.claude/*`.

No basta con copiar ese checkout para que OpenCode lo consuma. Un consumidor necesita una instalacion por usuario, versionada y reversible, que solo se active en los repositorios que adoptan el marco; un contrato de proyecto neutral; y paridad observable entre comandos, agentes, Skills, hooks, MCP y ejecucion interactiva/headless. Las rutas de proyecto `.opencode/` y las globales no se presumen equivalentes: la documentacion de OpenCode las documenta por tipo de capacidad.

### Alcance

Este ADR fija la arquitectura de fuente, distribucion, contrato consumidor, versionado y certificacion del lado publicado. Decide **que** se genera, donde vive una instalacion OpenCode y que evidencia debe existir antes de migrar el catalogo.

### Que queda fuera

- No crea `src/published/`, `src/runtime/`, `dist/`, instaladores, artefactos de Release ni adaptadores publicados. MEF-ADR-0019.E obliga primero a registrar sus rutas en los gates; #1043 es ese PR y no puede poblarlas.
- No migra ningun comando distinto del corte vertical `/mefisto:tooling`, ni borra contratos legacy ni modifica credenciales de runtime.

## Decision

### 1. Fuente publicada neutral, nucleo mecanico acotado y distribuciones generadas (CA-1)

- `src/published/` sera la fuente neutral y de autoria manual de los artefactos **publicados**: comandos, agentes, Agent Skills, scripts, permisos, hooks, MCP y su doctrina de consumidor.
- `src/runtime/` sera un nucleo comun limitado a la mecanica de runner y eventos: contrato de ejecucion, traduccion de eventos, telemetria neutral y utilidades que no expresen doctrina ni scope de ningun lado.
- `dist/{claude,opencode}/` seran las raices generadas, reproducibles y no editables a mano de cada distribucion. Claude recibira el artefacto apto para marketplace; OpenCode recibira el artefacto apto para la instalacion global de esta decision.

No se extraen al nucleo doctrina, agentes, skills, reglas de scope, guards, orquestacion de worktrees ni pipelines de los lados publicado e interno. Esos lados siguen fisicamente separados conforme a MEF-ADR-0019; compartir mas que runner/eventos seria una extraccion prematura bajo MEF-ADR-0018. Toda ruta nueva queda vacia hasta que #1043 registre primero `src/published/`, `src/runtime/` y `dist/` en ambos gates de scope.

### 2. Archivos por usuario, activacion por repositorio (CA-2, enmendado por #2261)

Mefisto separa **donde viven sus archivos** de **donde se activa**. Los archivos
se instalan una vez por usuario y quedan inertes; cada repositorio consumidor
decide, con un archivo commiteado, si Mefisto se carga en el. Un repositorio que
no lo declara no recibe comandos, agentes, Skills, hooks, MCP ni estado
`.mefisto/`. Los pipelines no dependen de esa activacion: entregan a cada agente
la raiz de la release que los esta ejecutando.

| | Archivos (por usuario, inertes) | Activacion (por repositorio, commiteada) | Agentes de pipeline |
|---|---|---|---|
| Claude Code | instalacion de marketplace a scope `user`, **deshabilitada** a nivel usuario (`enabledPlugins` en `false` en `~/.claude/settings.json`) | `.claude/settings.json` con `extraKnownMarketplaces` y `enabledPlugins` en `true`; la precedencia proyecto > usuario la habilita solo ahi | `--plugin-dir <raiz>` |
| OpenCode | release inmutable bajo la raiz de datos de Mefisto (tabla siguiente) | cargador commiteado en `.opencode/plugins/mefisto.js` que registra la superficie de la release activa | `OPENCODE_CONFIG_DIR=<raiz>` |

`<raiz>` es la raiz fisica de la release que contiene el pipeline en curso
(`MEFISTO_AGENT_PACKAGE_ROOT`, exportada por `scripts/_pipeline-common.sh`). Asi
el agente de un worktree hermano carga exactamente la version del pipeline, este
o no Mefisto habilitado o registrado para esa ruta. Los pipelines internos no la
exportan: cargan los adaptadores de proyecto del propio repositorio.

Verificado el 2026-10-10 contra Claude Code 2.1.296 y OpenCode 1.18.34:

- Claude con el plugin deshabilitado no carga comandos, agentes ni hooks y no
  crea `.mefisto/`; habilitado a nivel usuario, un repositorio ajeno recibia los
  27 comandos y los hooks SessionStart creaban `.mefisto/pipeline/`.
- `--plugin-dir` carga el plugin aunque este deshabilitado (`source:
  mefisto@inline`) y precede a la copia instalada: con `0.44.1` en el flag y
  `0.45.0` instalada se cargo `0.44.1`, sin duplicar agentes ni hooks.
- Al iniciar una sesion en un directorio cuyo `.claude/settings.json` habilita
  Mefisto, Claude registra por su cuenta una instalacion `project` para esa
  ruta. `claude plugin uninstall --scope project` reescribe ese
  `.claude/settings.json` a `enabledPlugins: {}`; ningun flujo lo ejecuta dentro
  de un repositorio vivo.
- `OPENCODE_CONFIG_DIR=<release>` hace que OpenCode descubra agentes, comandos,
  Skills, plugins y MCP de la release. Combinado con enlaces globales a la misma
  release, carga dos veces cada plugin.
- Un plugin de proyecto en `.opencode/plugins/` puede registrar agentes,
  comandos y MCP mediante el hook `config`; en un repositorio sin el, el agente
  no existe (`agent "planner" not found`).

#### Almacen de releases OpenCode

OpenCode se instala por usuario desde un artefacto de GitHub Release, nunca
copiando un checkout, un worktree ni configuracion de un consumidor. Cada release
descomprime en una ruta inmutable:

| Plataforma | Raiz de datos de Mefisto | Release | Puntero activo |
|---|---|---|---|
| Linux/XDG | `${XDG_DATA_HOME:-$HOME/.local/share}/mefisto` | `releases/<semver>/` | `active` |
| macOS sin `XDG_DATA_HOME` | `$HOME/Library/Application Support/mefisto` | `releases/<semver>/` | `active` |

Si `XDG_DATA_HOME` esta definido en macOS, tambien prevalece sobre el fallback. `active` es el unico puntero de version activa por usuario y se reemplaza atómicamente solo despues de validar checksum, estructura y completitud del release nuevo. La activacion conserva el puntero anterior hasta que el nuevo queda valido; el rollback es otro reemplazo atomico de `active` hacia una release inmutable ya instalada. Ni el repositorio principal ni worktrees hermanos son parte de la instalacion: ambos resuelven el mismo `active`.

Cada release tiene la forma de un directorio de configuracion de OpenCode
(`{commands,agents,skills,plugins}`), por eso sirve directamente como
`OPENCODE_CONFIG_DIR`. El cargador de proyecto (`src/published/opencode/mefisto-loader.js`,
commiteado por el consumidor como `.opencode/plugins/mefisto.js`) lee los agentes y
comandos de `active` -- su frontmatter es JSON por linea --, los registra con el hook
`config` en la misma forma que produce OpenCode al leer `<config>/agents/*.md`
(incluida la traduccion de `tools` a `permission`), agrega `active/skills` a
`skills.paths` e importa los plugins de la release. Se inhibe cuando
`OPENCODE_CONFIG_DIR` ya apunta a una release o cuando existe la proyeccion global, y
ante cualquier fallo no aporta nada en vez de romper el arranque. El adaptador de
pipelines tampoco inyecta `OPENCODE_CONFIG_DIR` si el usuario ya lo define o si la
proyeccion global existe; en esos casos el cargador del worktree activa Mefisto.

La proyeccion global por enlaces a `active` (`project`/`deactivate`,
`/mefisto:runtimes`) se conserva como modo **opt-in** que carga Mefisto en todas las
sesiones de OpenCode; `/mefisto:upgrade` solo la refresca si ya existe y ofrece
retirarla cuando el repo commitea el cargador. Fuera de ese modo, Mefisto no escribe
en la configuracion global de OpenCode (`$OPENCODE_CONFIG_DIR` o
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode`, tambien en macOS), y en ningun caso en
`opencode.json`: conserva providers, modelos, permisos y `mcp` del usuario. Los secrets/auth stores del runtime quedan fuera de estas rutas y de
toda inspeccion de Mefisto, conforme a MEF-ADR-0025.

### 3. Un release, dos adaptadores y diagnostico de deriva (CA-3, enmendado por #1126)

Cada release publica **una sola** version SemVer `<semver>` y el tag Git
`v<semver>` para Claude Code y OpenCode. El destino Claude del release es
`dist/claude/`: cuando exista esa salida, la entrada `mefisto` de
`.claude-plugin/marketplace.json` dejara de apuntar a la raiz del repo y
apuntara a esa raiz generada, cuyo `plugin.json` llevara el mismo `<semver>`.
El destino OpenCode del mismo tag es el asset de GitHub Release
`mefisto-opencode-v<semver>.tar.gz`, acompanado por
`mefisto-opencode-v<semver>.tar.gz.sha256`. Una version no se reedita: tag,
contenido de ambos adaptadores, asset y checksum son inmutables.

Cada distribucion incluye esa identidad en `mefisto-manifest.json` y el runtime
la expone, sin secretos, como `runtime`, `version` SemVer y `commit`. El campo
`commit` es el **commit fuente**: un SHA Git completo de 40 caracteres
hexadecimales de `origin/main` desde el que `/mefisto-release` crea la rama de
preparacion. Se resuelve y captura inmediatamente despues de actualizar
`origin/main`; la rama nace exactamente en ese SHA, antes de consolidar
fragmentos, modificar `CHANGELOG.md`, cambiar la version o generar metadata.
Responde a «¿de que snapshot funcional se construyeron ambos adaptadores?»,
mientras el tag/version responde «¿que release mecanico los publico?»; son
valores distintos y comparables.

El tag `v<semver>` apunta al commit squash de release posterior. Ese commit
etiquetado debe tener un primer y unico padre igual al `commit fuente` declarado.
Si `origin/main` avanza durante la preparacion, la rama queda rebasada; si el
merge no es squash y lineal; o si padre, SHA fuente o manifiestos no coinciden,
`publish` aborta antes de crear el tag y exige regenerar la preparacion desde el
`origin/main` vigente. Esta relacion es verificable localmente: el modelo de Git
crea un commit a partir de un tree y sus padres, por lo que no puede contener en
un archivo versionado el SHA del propio commit sin alterar el tree y producir
otro SHA [Git `commit-tree`].

El delta `commit fuente..commit etiquetado` queda limitado a la allowlist
mecanica de release: version y metadata generada, consolidacion de CHANGELOG e
indice ADR, y borrado de fragmentos ya consolidados. Ningun cambio ejecutable o
doctrinal nuevo puede entrar en ese delta para quedar fuera de la procedencia
declarada. El gate de release falla cerrado ante cualquier ruta fuera de esa
allowlist.

Claude y OpenCode exponen el mismo `version` y `commit fuente`, cada uno con su
propio `runtime`; OpenCode puede conservar `minimumRuntimeVersion`. Al iniciar o
inspeccionar un workspace, Mefisto lee exclusivamente esos manifiestos de las
instalaciones disponibles, valida el `runtime` esperado de cada uno y compara la
igualdad de `version` y `commit`. Si version o commit difieren, informa una
degradacion visible con ambos valores y la accion de alinear/activar la version;
no consulta Git, red, caches arbitrarios, tokens, auth stores, API keys ni
configuracion de proveedor para diagnosticarla.

Los tags historicos sin manifiesto Claude permanecen `metadata_missing`: no se
reedita una version ni un tag existente. La primera release posterior a la
implementacion operativa de este contrato lo establece; una pareja instalacion
vieja/nueva se reporta como degradacion, nunca recibe una identidad inventada.

### 4. Contrato canonico de consumidor con lectura legacy indefinida (CA-4)

El contrato neutral de un consumidor es:

- `AGENTS.md` para directivas.
- `.mefisto/harness.config.json` para configuracion del harness.
- `.mefisto/pipeline/` para estado, logs, metricas y summaries propios del pipeline.

Todo escritor nuevo escribe solo esas ubicaciones canonicas. Los lectores conservan indefinidamente fallback a `CLAUDE.md` y `.claude/*` -- incluidos `.claude/harness.config.json` y `.claude/pipeline/` -- cuando el equivalente canonico no existe. No hay migracion destructiva ni fecha de retiro del fallback.

#### Enmienda transitoria: mirror de identidad de release del adaptador Claude (#1099)

La regla de escritura solo canonica tiene una unica excepcion, transitoria y estrecha: `record-active-release` del adaptador publicado Claude puede, ademas de escribir obligatoria y primariamente `canonical-state`/`release-identity`, reflejar la misma identidad de la distribucion ya cargada observada desde `CLAUDE_PLUGIN_ROOT` en `.claude/pipeline/.plugin-root` y limpiar `.claude/pipeline/.plugin-root.previous`. No resuelve independientemente el mirror ni usa la version mas reciente del cache: esta puede no ser la version que la sesion mantiene cargada. El marker no contiene credenciales ni configuracion del proveedor.

Ningun otro binding recibe permiso para escribir rutas legacy. En particular, `sessions.jsonl` y `events.log` se escriben exclusivamente bajo `.mefisto/pipeline/`. Si el mirror falla, el adaptador informa la degradacion aplicable pero no invalida la sesion; el destino canonico permanece el contrato primario. La capacidad `legacy-release-marker` pertenece solo al adaptador Claude publicado: no se propaga a OpenCode ni a hooks internos, conforme a MEF-ADR-0019 y MEF-ADR-0050.

El mirror solo se retira mediante un issue posterior, tras comprobar un inventario verificable sin lectores de `.claude/pipeline/.plugin-root` ni `.claude/pipeline/.plugin-root.previous`. El cierre de #1054 no satisface ese gate ni autoriza el retiro implicito.

El puente minimo de un consumidor que conserva Claude Code es un `CLAUDE.md` con `@AGENTS.md`; no duplica la doctrina. Las señales neutrales ya definidas bajo `pipeline-state/` no se absorben en `.mefisto/pipeline/`: permanecen gobernadas por MEF-ADR-0017 y su semantica transitoria no cambia.

### 5. Paridad distribuible y fallos visibles (CA-5)

La distribucion tiene paridad como producto, no solo como conjunto de Markdown: comandos, agentes, Agent Skills, scripts, permisos, hooks, MCP y observabilidad -- logs, metricas, sesiones y eventos -- se adaptan o se declaran expresamente no disponibles. OpenCode expone comandos publicados como `/mefisto:*`; los Agent Skills adaptados para runtimes sin plugin usan `mefisto-`, conforme a MEF-ADR-0050 y al nombre portable de Skills.

El generador debe abortar si una capacidad requerida no tiene equivalente o no puede declararse con seguridad. Cuando una capacidad puede operar con menor funcionalidad, el adaptador la marca y reporta como degradacion visible en discovery/ejecucion. Ninguna capacidad desaparece silenciosamente. Los `SKILL.md` conservan el frontmatter portable de MEF-ADR-0033 y MEF-ADR-0050; permisos y hooks se traducen sin ampliar privilegios por omision.

### 6. Rollout corte-vertical-primero y gate reproducible (CA-6)

El primer unico flujo publicado a migrar es `/mefisto:tooling`. Antes de migrar el resto del catalogo debe superar una certificacion reproducible que registre evidencia de:

1. instalacion real de la **misma** version/tag en Claude Code y OpenCode, con checksum de artefacto OpenCode;
2. descubrimiento de comandos, agentes, Skills, scripts, permisos, hooks y MCP en ambos runtimes;
3. una ejecucion headless de `/mefisto:tooling` hasta un PR real y un smoke interactivo de la misma version que ejerza sus hooks; ambas modalidades deben producir observabilidad correlacionable;
4. Herdr con Claude en la fila superior, OpenCode en la inferior y pools de panes separados por runtime;
5. logs, metricas y sesiones que identifiquen `runtime`, `modelo`, `version` y el `commit fuente`, sin secretos ni inputs sensibles.

La presencia de archivos generados no satisface este gate: la evidencia debe ser ejecutable y repetible, en coherencia con MEF-ADR-0031. Si una variante falla o degrada, el rollout se detiene en el corte vertical; no se migra el resto del catalogo para ocultar la incompatibilidad entre volumen de adaptaciones.

### 7. Raiz del paquete en los artefactos Claude

En los artefactos Claude, la raiz del paquete (`MEFISTO_PACKAGE_ROOT`) es la sustitucion de contenido de `${CLAUDE_PLUGIN_ROOT}`: Claude Code reemplaza ese texto, al cargar el comando o agente, por la ruta de la version cargada ([Plugins reference, Environment variables](https://code.claude.com/docs/en/plugins-reference)); la variable no existe en el entorno de Bash. El preambulo parte de `mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'`. Si el valor es una ruta absoluta es el unico candidato y, si no valida (`plugin.json` y `mefisto-manifest.json` de runtime `claude`), el bloque aborta sin caer a los markers, porque caer ejecutaria en silencio otra version. Los markers (`.mefisto/pipeline/.plugin-root` y el mirror legado) son solo fallback cuando no hubo sustitucion. Cada artefacto con preambulo indica ejecutarlo en cada llamada Bash, sin guardarlo ni reutilizar el de otro comando.

## Alternativas consideradas

### Alt a: mantener distribucion solo Claude Code

**Descartada**: conserva los acoplamientos publicados y niega el runtime OpenCode ya validado internamente.

### Alt b: dos repositorios o releases con versiones independientes

**Descartada**: impide comparar una misma entrega y hace inevitable la deriva de versiones/commits que la decision 3 debe detectar.

### Alt c: copiar el checkout completo como instalacion OpenCode

**Descartada**: hace mutable la instalacion, depende del cwd y de worktrees, no da activacion atomica ni rollback y puede arrastrar estado local o secretos.

### Alt d: generar dos taxonomias de eventos

**Descartada**: duplica la mecanica que `src/runtime/` comparte legitimamente y rompe la observabilidad comparable entre runtimes.

### Alt e: migrar todo el catalogo antes del corte vertical

**Descartada**: multiplica superficie sin demostrar que una experiencia completa funciona. El gate de `/mefisto:tooling` expone antes incompatibilidades de runner, hooks, MCP y Herdr.

### Alt f: SHA autorreferencial, solo SemVer, cache/Git/red del consumidor o hash de contenido

**Descartada**: un SHA autorreferencial es imposible porque alterar el
manifiesto altera el tree que identifica el commit. Solo SemVer no prueba la
procedencia comun. El nombre de un cache, `git rev-parse` en el consumidor y una
consulta de red por tag dependen de estado externo, mutable o no disponible y
rompen el diagnostico local y sin credenciales. Un hash de contenido puede
verificar bytes, pero renombrarlo `commit` oculta que no identifica el snapshot
Git ni permite comprobar la relacion padre/tag.

## Consecuencias

### Positivas

- Mefisto solo se carga en los repositorios que lo declaran; el resto no recibe comandos, agentes, hooks ni estado `.mefisto/`.
- Una actualizacion por usuario sirve a todos los repositorios consumidores, y los agentes de pipeline corren exactamente la version del pipeline, desde checkout principal o worktree.
- Consumidores OpenCode obtienen un almacen de releases estable y reversible.
- El mismo SemVer/tag permite atribuir una divergencia a un adaptador y no a versiones distintas.
- El `commit fuente` permite atribuir ambos adaptadores al mismo snapshot
  funcional sin volver circular la metadata del release.
- El contrato canonico deja de llevar el nombre de un runtime sin romper consumidores legacy.
- La certificacion valida la experiencia operativa completa y no solo la generacion de archivos.

### Negativas

- Se mantienen dos distribuciones y dos mecanismos de activacion por repositorio que deben probarse en cada release.
- Cada repositorio consumidor debe commitear su activacion; sin ella, Mefisto no se carga ahi aunque este instalado.
- La instalacion por usuario requiere administrar almacenamiento de releases inmutables y retencion segura para rollback.

## Referencias

- MEF-ADR-0017: `pipeline-state/` conserva sus señales neutrales fuera de `.mefisto/pipeline/`.
- MEF-ADR-0018: solo se extrae mecanica estable; doctrina y orquestacion permanecen separadas.
- MEF-ADR-0019: separacion publicado/interno y secuencia obligatoria registrar rutas antes de poblarlas.
- MEF-ADR-0025: el runtime custodia sus credenciales; Mefisto no las lee ni distribuye.
- MEF-ADR-0030: esquema de identificadores y reserva de `MEF-ADR-0053`.
- MEF-ADR-0031: gates sustentados por evidencia reproducible, no por archivos presentes.
- MEF-ADR-0033: Agent Skills y frontmatter portable como parte de la distribucion.
- MEF-ADR-0049: arquitectura neutral interna cuyo diferido publicado queda resuelto aqui.
- MEF-ADR-0050: neutralidad, namespace `/mefisto:*` y prefijo `mefisto-` para Skills adaptados.
- Git: [`git-commit-tree`](https://git-scm.com/docs/git-commit-tree), modelo de
  creacion de commits desde tree y padres que fundamenta la imposibilidad de un
  SHA autorreferencial y la verificacion de la relacion padre/tag.
- OpenCode Docs: [CLI](https://opencode.ai/docs/cli/), [Config](https://opencode.ai/docs/config/), [Commands](https://opencode.ai/docs/commands/), [Agents](https://opencode.ai/docs/agents/), [Skills](https://opencode.ai/docs/skills/), [Plugins](https://opencode.ai/docs/plugins/), [Permissions](https://opencode.ai/docs/permissions/) y [MCP servers](https://opencode.ai/docs/mcp-servers/). Fuente de las rutas de configuracion, `OPENCODE_CONFIG_DIR` y el hook `config` de plugins de la decision 2; verificadas el 2026-09-08 contra OpenCode 1.18.29 (version minima soportada) y el 2026-10-10 contra 1.18.34.
- Claude Code Docs: [Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins), [Memory](https://docs.claude.com/en/docs/claude-code/memory), [Plugin loading](https://code.claude.com/docs/en/plugins/loading) (`--plugin-dir`/`CLAUDE_CODE_PLUGIN_DIRS` y su precedencia sobre la copia instalada) y [Settings](https://code.claude.com/docs/en/settings) (precedencia local > proyecto > usuario de `enabledPlugins`).
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/).
- `docs/testing/opencode-dogfooding.md`: evidencia del gate interno que habilita esta decision.
- Issue #1042: origen de este ADR.

## Control de cambios

- 2026-09-07: creacion como `aceptado` (issue #1042). Resuelve los diferidos publicados de MEF-ADR-0049: fuente neutral `src/published/`, nucleo exclusivo de runner/eventos `src/runtime/` y distribuciones generadas `dist/{claude,opencode}/`, sin poblar rutas antes de #1043; instalacion OpenCode global, versionada, inmutable y reversible con puntero activo atomico; un SemVer/tag para ambos adaptadores y diagnostico visible de deriva; contrato consumidor `AGENTS.md`/`.mefisto` con lectura legacy indefinida; paridad distribuible sin degradacion silenciosa; y corte vertical `/mefisto:tooling` certificado hasta PR antes de migrar el catalogo restante.
- 2026-09-08: enmienda la decision 2 (issue #1091). Fija el proyector global por enlaces a `active`, la version minima OpenCode 1.18.29 y la preservacion no destructiva de configuracion ajena; registra degradaciones de capacidades que el release aun no contiene.
- 2026-09-08: enmienda la decision 4 (issue #1099). Autoriza exclusivamente a `record-active-release` del adaptador publicado Claude a mantener temporalmente el mirror `.claude/pipeline/.plugin-root` y limpiar `.plugin-root.previous`, siempre junto a la escritura canonica primaria; reserva su retiro a un issue posterior con inventario verificable de lectores legacy eliminado.
- 2026-09-08: enmienda la decision 3 (issue #1126). Define `commit` como el commit fuente de `origin/main` capturado antes de la preparacion mecanica, no como el commit etiquetado; exige que el commit squash del tag tenga ese SHA como padre unico, limita su delta a metadata mecanica y fija manifests comparables sin diagnostico externo. Descarta SHA autorreferencial, solo SemVer, cache, Git o red del consumidor y hash de contenido renombrado como commit. Follow-ups separados: #1135 (registro de raiz transitoria), #1131 (manifiesto Claude), #1134 (alineacion OpenCode), #1132 (release) y la futura raiz Claude autocontenida.
- 2026-10-10: enmienda la decision 2 (issue #2261). Separa archivos por usuario de activacion por repositorio: Claude queda instalado a scope `user` pero deshabilitado a ese nivel y se habilita en el `.claude/settings.json` commiteado del consumidor; OpenCode deja la proyeccion global en `<config>` y se activa con un cargador de proyecto; los agentes de pipeline reciben la raiz de su release (`--plugin-dir` / `OPENCODE_CONFIG_DIR`). Evidencia verificada contra Claude Code 2.1.296 y OpenCode 1.18.34.
- 2026-10-10: completa la enmienda de la decision 2 (issue #2261) para OpenCode: fija el cargador de proyecto, sus condiciones de inhibicion y la proyeccion global como modo opt-in que `/mefisto:upgrade` solo refresca si existe. Verificado contra OpenCode 1.18.34: con el cargador, los 22 agentes resueltos y los 26 comandos coinciden con los de `OPENCODE_CONFIG_DIR=<release>`, salvo el orden no determinista de las reglas de Skills.
- 2026-10-20: agrega la decision 7 (issue #2462). En los artefactos Claude la raiz del paquete es la sustitucion de contenido de `${CLAUDE_PLUGIN_ROOT}` (la version cargada); una raiz sustituida e invalida aborta sin caer a los markers, que quedan solo como fallback cuando no hay sustitucion. Retira la rama por variable de entorno, que no existe en Bash.
