# MEF-ADR-0053: Distribucion multi-runtime de Mefisto para consumidores

- **Fecha**: 2026-09-07
- **Estado**: aceptado
- **Aplica a**: la arquitectura publicada de Mefisto que se distribuye a proyectos consumidores: fuente neutral, distribucion generada, activacion por repositorio, identidad de release y contrato canonico de consumidor. Resuelve el diferido de MEF-ADR-0049 sobre el layout `dist/`. No reemplaza la separacion publicado/interno de MEF-ADR-0019, la arquitectura interna de MEF-ADR-0049 ni el principio transversal de MEF-ADR-0050.

**Issues bloqueados por este ADR**: #1043, #1047, #1049, #1050, #1051 y #1057; y, transitivamente, el rollout #1044-#1066.

## Contexto

El rollout interno de MEF-ADR-0049 ya resolvio `MEFISTO_RUNTIME`, el runner neutral y la fuente neutral interna con su generador. El artefacto publicado, en cambio, sigue siendo exclusivamente un Claude Code Plugin: el marketplace apunta a la raiz del checkout, `plugin.json` porta su version y los comandos/pipelines publicados conocen `CLAUDE_PLUGIN_ROOT`, el cache de marketplace, `CLAUDE.md` y `.claude/*`.

Ese acoplamiento impide que el lado publicado sea neutral: sumar el adaptador de otro runtime exigiria reescribir comandos y pipelines en vez de generar una distribucion mas. Un consumidor necesita ademas una instalacion por usuario que solo se active en los repositorios que adoptan el marco, y un contrato de proyecto cuyas rutas no lleven el nombre de un runtime.

### Alcance

Este ADR fija la arquitectura de fuente, distribucion, contrato consumidor, versionado y certificacion del lado publicado. Decide **que** se genera, como se activa Mefisto en un repositorio, como se identifica una release y que evidencia debe existir antes de migrar el catalogo.

### Que queda fuera

- No crea `src/published/`, `src/runtime/`, `dist/` ni adaptadores publicados. MEF-ADR-0019.E obliga primero a registrar sus rutas en los gates; #1043 es ese PR y no puede poblarlas.
- No migra ningun comando distinto del corte vertical `/mefisto:tooling`, ni borra contratos legacy ni modifica credenciales de runtime.

## Decision

### 1. Fuente publicada neutral, nucleo mecanico acotado y distribuciones generadas (CA-1)

- `src/published/` sera la fuente neutral y de autoria manual de los artefactos **publicados**: comandos, agentes, Agent Skills, scripts, permisos, hooks, MCP y su doctrina de consumidor.
- `src/runtime/` sera un nucleo comun limitado a la mecanica de runner y eventos: contrato de ejecucion, traduccion de eventos, telemetria neutral y utilidades que no expresen doctrina ni scope de ningun lado.
- `dist/<runtime>/` sera la raiz generada, reproducible y no editable a mano de la distribucion de cada runtime con adaptador. Hoy el unico adaptador es el de Claude Code y la unica raiz generada es `dist/claude/`: Claude recibira ahi el artefacto apto para marketplace. La produce `src/published/scripts/generate-published-adapters.sh`, que no conoce formatos de runtime: cada `adapter-<runtime>.sh` declara su raiz y renderiza sus propios archivos.

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

`<raiz>` es la raiz fisica de la release que contiene el pipeline en curso
(`MEFISTO_AGENT_PACKAGE_ROOT`, que exporta cada pipeline publicado). Asi
el agente de un worktree hermano carga exactamente la version del pipeline, este
o no Mefisto habilitado o registrado para esa ruta. Los pipelines internos no la
exportan: cargan los adaptadores de proyecto del propio repositorio.

Verificado el 2026-10-10 contra Claude Code 2.1.296:

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

Los secrets/auth stores del runtime quedan fuera de toda inspeccion de Mefisto,
conforme a MEF-ADR-0025.

### 3. Una release, una identidad y commit fuente (CA-3, enmendado por #1126)

Cada release publica **una sola** version SemVer `<semver>` y el tag Git
`v<semver>` para todos los adaptadores. El destino Claude del release es
`dist/claude/`: cuando exista esa salida, la entrada `mefisto` de
`.claude-plugin/marketplace.json` dejara de apuntar a la raiz del repo y
apuntara a esa raiz generada, cuyo `plugin.json` llevara el mismo `<semver>`.
Una version no se reedita: el tag y el contenido de la distribucion son
inmutables.

La identidad se persiste en `src/published/release-identity.json` (`version` y
`commit`). Cada distribucion la incluye en `mefisto-manifest.json` y el runtime
la expone, sin secretos, como `runtime`, `version` SemVer y `commit`. El campo
`commit` es el **commit fuente**: un SHA Git completo de 40 caracteres
hexadecimales de `origin/main` desde el que `/mefisto-release` crea la rama de
preparacion. Se resuelve y captura inmediatamente despues de actualizar
`origin/main`; la rama nace exactamente en ese SHA, antes de consolidar
fragmentos, modificar `CHANGELOG.md`, cambiar la version o generar metadata.
Responde a «¿de que snapshot funcional se construyo la distribucion?»,
mientras el tag/version responde «¿que release mecanico la publico?»; son
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

Los pipelines leen la identidad exclusivamente del `mefisto-manifest.json` de la
distribucion que los ejecuta y validan el `runtime` esperado. Si el manifiesto
falta o es invalido, la identidad queda en `null` con una degradacion visible
(`metadata_missing` o `metadata_invalid`); no se consulta Git, red, caches
arbitrarios, tokens, auth stores, API keys ni configuracion de proveedor para
inferirla.

Los tags historicos sin manifiesto Claude permanecen `metadata_missing`: no se
reedita una version ni un tag existente. La primera release posterior a la
implementacion operativa de este contrato lo establece; una instalacion previa
sin manifiesto se reporta como degradacion, nunca recibe una identidad inventada.

### 4. Contrato canonico de consumidor con lectura legacy indefinida (CA-4)

El contrato neutral de un consumidor es:

- `AGENTS.md` para directivas.
- `.mefisto/harness.config.json` para configuracion del harness.
- `.mefisto/pipeline/` para estado, logs, metricas y summaries propios del pipeline.

Todo escritor nuevo escribe solo esas ubicaciones canonicas. Los lectores conservan indefinidamente fallback a `CLAUDE.md` y `.claude/*` -- incluidos `.claude/harness.config.json` y `.claude/pipeline/` -- cuando el equivalente canonico no existe. No hay migracion destructiva ni fecha de retiro del fallback.

#### Enmienda transitoria: mirror de identidad de release del adaptador Claude (#1099)

La regla de escritura solo canonica tiene una unica excepcion, transitoria y estrecha: `record-active-release` del adaptador publicado Claude puede, ademas de escribir obligatoria y primariamente `canonical-state`/`release-identity`, reflejar la misma identidad de la distribucion ya cargada observada desde `CLAUDE_PLUGIN_ROOT` en `.claude/pipeline/.plugin-root` y limpiar `.claude/pipeline/.plugin-root.previous`. No resuelve independientemente el mirror ni usa la version mas reciente del cache: esta puede no ser la version que la sesion mantiene cargada. El marker no contiene credenciales ni configuracion del proveedor.

Ningun otro binding recibe permiso para escribir rutas legacy. En particular, `sessions.jsonl` y `events.log` se escriben exclusivamente bajo `.mefisto/pipeline/`. Si el mirror falla, el adaptador informa la degradacion aplicable pero no invalida la sesion; el destino canonico permanece el contrato primario. La capacidad `legacy-release-marker` pertenece solo al adaptador Claude publicado: no se propaga al adaptador de ningun otro runtime ni a hooks internos, conforme a MEF-ADR-0019 y MEF-ADR-0050.

El mirror solo se retira mediante un issue posterior, tras comprobar un inventario verificable sin lectores de `.claude/pipeline/.plugin-root` ni `.claude/pipeline/.plugin-root.previous`. El cierre de #1054 no satisface ese gate ni autoriza el retiro implicito.

El puente minimo de un consumidor con Claude Code es un `CLAUDE.md` con `@AGENTS.md`; no duplica la doctrina. Las señales neutrales ya definidas bajo `pipeline-state/` no se absorben en `.mefisto/pipeline/`: permanecen gobernadas por MEF-ADR-0017 y su semantica transitoria no cambia.

### 6. Rollout corte-vertical-primero y gate reproducible (CA-6)

El primer unico flujo publicado a migrar es `/mefisto:tooling`. Antes de migrar el resto del catalogo debe superar una certificacion reproducible que registre evidencia de:

- instalacion real de la version/tag publicada;
- descubrimiento de comandos, agentes, Skills, scripts, permisos, hooks y MCP;
- una ejecucion headless de `/mefisto:tooling` hasta un PR real y un smoke interactivo de la misma version que ejerza sus hooks; ambas modalidades deben producir observabilidad correlacionable;
- logs, metricas y sesiones que identifiquen `runtime`, `modelo`, `version` y el `commit fuente`, sin secretos ni inputs sensibles.

La presencia de archivos generados no satisface este gate: la evidencia debe ser ejecutable y repetible, en coherencia con MEF-ADR-0031. Si una variante falla o degrada, el rollout se detiene en el corte vertical; no se migra el resto del catalogo para ocultar la incompatibilidad entre volumen de adaptaciones.

### 7. Raiz del paquete en los artefactos Claude

En los artefactos Claude, la raiz del paquete (`MEFISTO_PACKAGE_ROOT`) es la sustitucion de contenido de `${CLAUDE_PLUGIN_ROOT}`: Claude Code reemplaza ese texto, al cargar el comando o agente, por la ruta de la version cargada ([Plugins reference, Environment variables](https://code.claude.com/docs/en/plugins-reference)); la variable no existe en el entorno de Bash. El preambulo parte de `mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'`. Si hubo sustitucion (el valor ya no empieza con `${`) es el unico candidato y, si no es una ruta absoluta que valida (`plugin.json` y `mefisto-manifest.json` de runtime `claude`), el bloque aborta sin caer a los markers, porque caer ejecutaria en silencio otra version. Los markers (`.mefisto/pipeline/.plugin-root` y el mirror legado) son solo fallback cuando no hubo sustitucion (p. ej. un artefacto leido como archivo). Cada artefacto con preambulo indica ejecutarlo en cada llamada Bash, sin guardarlo ni reutilizar el de otro comando.

## Alternativas consideradas

### Alt a: mantener el artefacto publicado escrito a mano para Claude Code

**Descartada**: conserva los acoplamientos publicados a un runtime concreto y convierte en reescritura la incorporacion de cualquier otro adaptador.

### Alt b: un repositorio o release por adaptador, con versiones independientes

**Descartada**: impide atribuir una misma entrega a un unico snapshot y hace inevitable la deriva de versiones/commits entre adaptadores que la identidad unica de la decision 3 evita.

### Alt d: generar una taxonomia de eventos por runtime

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
- El mismo SemVer/tag permite atribuir una divergencia a un adaptador y no a versiones distintas.
- El `commit fuente` permite atribuir la distribucion a un snapshot
  funcional sin volver circular la metadata del release.
- El contrato canonico deja de llevar el nombre de un runtime sin romper consumidores legacy.
- La certificacion valida la experiencia operativa completa y no solo la generacion de archivos.

### Negativas

- Cada repositorio consumidor debe commitear su activacion; sin ella, Mefisto no se carga ahi aunque este instalado.

## Referencias

- MEF-ADR-0017: `pipeline-state/` conserva sus señales neutrales fuera de `.mefisto/pipeline/`.
- MEF-ADR-0018: solo se extrae mecanica estable; doctrina y orquestacion permanecen separadas.
- MEF-ADR-0019: separacion publicado/interno y secuencia obligatoria registrar rutas antes de poblarlas.
- MEF-ADR-0025: el runtime custodia sus credenciales; Mefisto no las lee ni distribuye.
- MEF-ADR-0030: esquema de identificadores y reserva de `MEF-ADR-0053`.
- MEF-ADR-0031: gates sustentados por evidencia reproducible, no por archivos presentes.
- MEF-ADR-0033: Agent Skills y frontmatter portable como parte de la distribucion.
- MEF-ADR-0049: arquitectura neutral interna cuyo diferido publicado queda resuelto aqui.
- MEF-ADR-0050: neutralidad de toda operacion y namespace `/mefisto:*`.
- MEF-ADR-0057, decision 7: Claude Code es el unico runtime con adaptador; se conservan la fuente neutral y su generador para que sumar otro siga siendo un adaptador.
- Git: [`git-commit-tree`](https://git-scm.com/docs/git-commit-tree), modelo de
  creacion de commits desde tree y padres que fundamenta la imposibilidad de un
  SHA autorreferencial y la verificacion de la relacion padre/tag.
- Claude Code Docs: [Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins), [Memory](https://docs.claude.com/en/docs/claude-code/memory), [Plugin loading](https://code.claude.com/docs/en/plugins/loading) (`--plugin-dir`/`CLAUDE_CODE_PLUGIN_DIRS` y su precedencia sobre la copia instalada) y [Settings](https://code.claude.com/docs/en/settings) (precedencia local > proyecto > usuario de `enabledPlugins`).
- Issue #1042: origen de este ADR.

## Control de cambios

- 2026-09-07: creacion como `aceptado` (issue #1042). Resuelve los diferidos publicados de MEF-ADR-0049: fuente neutral `src/published/`, nucleo exclusivo de runner/eventos `src/runtime/` y distribuciones generadas `dist/{claude,opencode}/`, sin poblar rutas antes de #1043; instalacion OpenCode global, versionada, inmutable y reversible con puntero activo atomico; un SemVer/tag para ambos adaptadores y diagnostico visible de deriva; contrato consumidor `AGENTS.md`/`.mefisto` con lectura legacy indefinida; paridad distribuible sin degradacion silenciosa; y corte vertical `/mefisto:tooling` certificado hasta PR antes de migrar el catalogo restante.
- 2026-09-08: enmienda la decision 2 (issue #1091). Fija el proyector global por enlaces a `active`, la version minima OpenCode 1.18.29 y la preservacion no destructiva de configuracion ajena; registra degradaciones de capacidades que el release aun no contiene.
- 2026-09-08: enmienda la decision 4 (issue #1099). Autoriza exclusivamente a `record-active-release` del adaptador publicado Claude a mantener temporalmente el mirror `.claude/pipeline/.plugin-root` y limpiar `.plugin-root.previous`, siempre junto a la escritura canonica primaria; reserva su retiro a un issue posterior con inventario verificable de lectores legacy eliminado.
- 2026-09-08: enmienda la decision 3 (issue #1126). Define `commit` como el commit fuente de `origin/main` capturado antes de la preparacion mecanica, no como el commit etiquetado; exige que el commit squash del tag tenga ese SHA como padre unico, limita su delta a metadata mecanica y fija manifests comparables sin diagnostico externo. Descarta SHA autorreferencial, solo SemVer, cache, Git o red del consumidor y hash de contenido renombrado como commit. Follow-ups separados: #1135 (registro de raiz transitoria), #1131 (manifiesto Claude), #1134 (alineacion OpenCode), #1132 (release) y la futura raiz Claude autocontenida.
- 2026-10-10: enmienda la decision 2 (issue #2261). Separa archivos por usuario de activacion por repositorio: Claude queda instalado a scope `user` pero deshabilitado a ese nivel y se habilita en el `.claude/settings.json` commiteado del consumidor; OpenCode deja la proyeccion global en `<config>` y se activa con un cargador de proyecto; los agentes de pipeline reciben la raiz de su release (`--plugin-dir` / `OPENCODE_CONFIG_DIR`). Evidencia verificada contra Claude Code 2.1.296 y OpenCode 1.18.34.
- 2026-10-10: completa la enmienda de la decision 2 (issue #2261) para OpenCode: fija el cargador de proyecto, sus condiciones de inhibicion y la proyeccion global como modo opt-in que `/mefisto:upgrade` solo refresca si existe. Verificado contra OpenCode 1.18.34: con el cargador, los 22 agentes resueltos y los 26 comandos coinciden con los de `OPENCODE_CONFIG_DIR=<release>`, salvo el orden no determinista de las reglas de Skills.
- 2026-10-20: agrega la decision 7 (issue #2462). En los artefactos Claude la raiz del paquete es la sustitucion de contenido de `${CLAUDE_PLUGIN_ROOT}` (la version cargada); una raiz sustituida e invalida aborta sin caer a los markers, que quedan solo como fallback cuando no hay sustitucion. Retira la rama por variable de entorno, que no existe en Bash.
- 2026-11-10: enmienda por el retiro de OpenCode como runtime soportado (MEF-ADR-0057, decision 7). Salen del cuerpo el almacen de releases y el cargador de proyecto de OpenCode, el tarball como asset de release, la proyeccion global, el diagnostico de deriva entre instalaciones, la decision 5, las evidencias de la decision 6 que exigian dos runtimes y la alternativa c, porque su objeto dejo de existir; permanecen la fuente `src/published/` con la distribucion generada `dist/claude/`, la activacion por repositorio, la identidad de release con su commit fuente y las decisiones 4 y 7.
- 2026-11-12: la seccion de activacion deja de atribuir `MEFISTO_AGENT_PACKAGE_ROOT` a `scripts/_pipeline-common.sh`, que se borra con el port a TypeScript (MEF-ADR-0057): la exporta cada pipeline publicado. Sin cambio de doctrina.
