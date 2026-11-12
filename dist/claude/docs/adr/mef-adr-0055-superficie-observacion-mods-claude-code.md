# MEF-ADR-0055: Superficie de observacion de pipelines como mod de Claude Code

- **Fecha**: 2026-10-08
- **Estado**: aceptado
- **Aplica a**: la consola de operacion `mefisto-divine-wager` (lado interno de MEF-ADR-0019) y el tablero del planner en sus dos lados, interno y publicado (decision 8), con los nombres de la decision 9. La consola publicada `fausto-blood-pact` (decision 10) tambien aplica. La paridad de experiencia entre pares (decision 11) aplica a ambos lados. Los issues que genera el reviewer quedan para enmiendas posteriores. Se apoya en MEF-ADR-0049 (adaptadores por runtime) y en MEF-ADR-0050 (neutralidad de toda operacion), y reserva el identificador `0055` (MEF-ADR-0030).

## Contexto

En herdr, la fila de trabajo tiene hoy tres panes: planner, ejecucion (la sesion donde se teclea `/mefisto-tooling`) y logs. `mefisto-herdr-pipeline.mts` crea el pane de logs (`dispatch_to_pane` + `cmd_pane_runner`) con el `tail -f` del report y `mefisto-stream-watch.mts`. Es un pane externo: no ofrece acciones (mergear el PR, cerrar) y obliga a cambiar de pane para ver el avance.

Claude Code publico los **mods** en v2.1.287 (2026-10-01): plugins de *function hooks* cuyo `hooks/hooks.json` declara un modulo ES que exporta `register(on)`. El modulo dibuja un Pane o una banda sobre el prompt (`AbovePrompt`) con Box/Text/Button, lee archivos (`$.fs`), sigue streams (`$.process.spawn`), ejecuta comandos (`$.process.run`) y lanza slash commands (`$.command.run`). Fuentes: [overview](https://code.claude.com/docs/en/plugins/mods/overview), [reference](https://code.claude.com/docs/en/plugins/mods/reference) y los tipos que el engine instala junto a cada mod. La API esta marcada *early access*.

Un spike del 2026-10-08 sobre `/mefisto-tooling 1982` dejo validados cuatro puntos:

- La deteccion del lanzamiento: un hook `tool.call` sobre `Bash` reconoce el comando del skill sin tocarlo.
- El seguimiento de stages leyendo `pipeline-status-mefisto-tooling-<n>.json`.
- El cierre con PR leido de `pipeline-history.jsonl`.
- El merge lanzado desde un boton que encadena `/mefisto-merge`.

Tambien dejo tres restricciones del engine:

- Un pane que se abre sin que la persona lo pida espera 144 columnas.
- Las teclas de un pane solo responden con foco (`ctrl+x tab` o un clic), salvo un digito en la banda con el prompt vacio.
- Un hot-reload del modulo mata los procesos que el modulo lanzo.

### Alcance

Este ADR fija cuatro cosas: la regla de diseno de los mods del propio Mefisto, su ubicacion, el modo de lanzamiento sin pane que los acompana y como encajan con el principio de neutralidad.

### Que queda fuera de este ADR

- Una superficie equivalente para otro runtime.

## Decision

### 1. Un mod es un lector puro del contrato de estado

Un mod del propio Mefisto **no contiene logica de pipeline**. Lee unicamente el estado que los pipelines ya escriben bajo `.mefisto/pipeline/`:

| Que lee | Para que |
|---|---|
| `pipeline-status-mefisto-tooling-<n>[-variant].json` | Stage, estado, agentes y PR |
| `pipeline-history.jsonl` | Cierre de la corrida: el status se borra al terminar bien |
| `logs/mefisto-tooling-stage-<s>-<agent>-<ts>-issue-<n>*.events.jsonl` | Live log, segun el contrato `src/runtime/contract/run-events.schema.json` |

Si un dato no esta en esos archivos, se agrega al contrato en el pipeline, no se infiere en el mod. Asi la operacion sigue siendo neutral (MEF-ADR-0050): los pipelines no saben que existe el mod.

### 2. Las acciones delegan en skills existentes

Toda accion con efecto sale del mod hacia un skill o comando que ya existe. Nunca se reimplementa:

- **Mergear** confirma con `$.ui.ask` y encola `/mefisto-merge <pr>` con `$.command.run`. Reutiliza squash, borrado de rama y `--reconcile-pr`.
- **Ver PR** ejecuta `gh pr view <pr> --web`.
- **Cerrar** solo oculta la corrida en la consola y la olvida, sin tocar PR ni issue.
- **Cierre automatico**: con la corrida terminada, el mod consulta el estado del PR (`gh pr view`, cada 15 s) y, cuando queda `MERGED`, se cierra solo. Da igual si el merge vino del boton, de `/mefisto-merge` tecleado o de GitHub.

`$.command.run` espera a que la sesion quede libre; el mod lo anuncia con un toast.

### 3. Interaccion por defecto: banda con digitos

Las acciones viven en la banda sobre el prompt (`AbovePrompt`), con hotkeys numericos: `1` mergear, `2` ver PR, `3` log, `4` cerrar. Un digito con el prompt vacio presiona el boton de la banda sin enfocar nada, y es la unica forma que da el engine para pulsar un boton sin foco.

El pane de detalle (stages y live log) es secundario. `/mefisto-divine-wager` lo abre ya enfocado, porque abierto por la persona se coloca a cualquier ancho. Cada accion tiene ademas un subcomando (`/mefisto-divine-wager merge|close`) por si las teclas no responden.

### 4. Ubicacion: una por lado

Un mod es un artefacto **exclusivo del adaptador Claude**, igual que `mefisto-scope-hook.mts` (MEF-ADR-0049 decision 2). Tiene dos ubicaciones, una por lado de MEF-ADR-0019:

- **Interno**: `.claude/mods/<mod>/`, cargado desde un marketplace de carpeta en alcance `local` (detalle abajo).
- **Publicado**: bajo `hooks/` del plugin `mefisto` (modulos, tipos y tsconfig). El `hooks/hooks.json` publicado es salida del generador del adaptador Claude (MEF-ADR-0049), y ese generador emite tambien `modules`. `hooks/*` ya esta cubierto por los gates de scope de ambos lados (MEF-ADR-0019).

Del lado interno, el mod vive en `.claude/mods/<mod>/` con la forma de plugin de mods:

- `.claude-plugin/plugin.json`
- `hooks/hooks.json` con `modules`
- `hooks/register.tsx`
- `types/index.d.ts`
- `hooks/*.test.ts`

La ruta queda registrada en `is_path_in_mefisto_scope` antes de poblarla (MEF-ADR-0019 seccion E). Los tipos que el engine regenera en `.claude-plugin/types/` no se versionan. Se cargan desde el marketplace de carpeta `.claude/mods/.claude-plugin/marketplace.json` (`mefisto-mods`), instalado una vez por checkout en alcance `local` (`claude plugin marketplace add ./.claude/mods --scope local` y `claude plugin install <mod>@mefisto-mods --scope local`). Esa configuracion vive en `.claude/settings.local.json`, que no se versiona y no existe en los worktrees de los pipelines, por lo que las sesiones `-p` de los agentes nunca cargan los mods. Un marketplace de carpeta se lee desde la propia carpeta: un cambio se aplica con `/reload-plugins`. `--plugin-dir` queda para probar una copia suelta.

### 5. Encaje con la neutralidad

El mod es una superficie de **observacion**, no una operacion. MEF-ADR-0050 exige que toda operacion nazca neutral, y aqui la operacion (el pipeline, el merge) sigue neutral e intacta. Sin el mod (`claude -p`, VS Code o una politica administrada que lo bloquee), la observacion es el pane de herdr o el visor `stream-watch` en otra terminal, sin un comando de dashboard equivalente. El mod nunca es requisito de un pipeline.

### 6. Modo de lanzamiento sin pane: `MEFISTO_UI=mod`

Con `MEFISTO_UI=mod`, `mefisto-launch-pipeline.mts --tooling` no abre pane herdr. Corre el pipeline desacoplado (proceso en su propia sesion que sobrevive al lanzador, `launchDetached` de `scripts/lib/launcher.mts`) y escribe su salida en `logs/mefisto-tooling-run-<ts>-issue-<n>.report.log`. El modo se evalua antes de la autodeteccion herdr. Fuera de herdr y sin `MEFISTO_UI` el wrapper tambien corre desacoplado, e imprime la ruta del reporte y la linea que abre el visor (`mefisto-stream-watch.mts --issues <n>`). `MEFISTO_UI` solo admite `mod` y `herdr` (MEF-ADR-0057 decision 5).

El hijo arranca sin `HERDR_*` ni `MEFISTO_UI`, para que los gates que corren tests del repo no hereden el modo, y conserva `MEFISTO_RUNTIME`. La corrida sobrevive al cierre de la sesion de Claude Code, y otra sesion con el mod la retoma desde los archivos.

En el lado interno el modo sin pane lo decide el runtime resuelto, igual que en el publicado: el adaptador Claude renderiza el lanzamiento con `MEFISTO_RUNTIME=claude`, y sin `MEFISTO_UI` el wrapper corre desacoplado (#2284). El mod solo observa el lanzamiento y no modifica el comando del skill: `/mefisto-tooling` no cambia, y un `MEFISTO_UI` explicito sigue ganando. Con el modo activo, la fila de herdr baja de tres panes a dos: planner y ejecucion.

En el lado publicado el modo lo decide el runtime resuelto (#2285): con el runtime claude y sin `MEFISTO_UI`, o con `MEFISTO_UI=mod`, `launch-pipeline.mts` corre desacoplado y la consola `fausto-blood-pact` sigue la corrida. Incluye `--parallel`: delega en `parallel-pipeline.mts` (con `--pipeline` y `--max-parallel` si vienen), cuyo scheduler serializa los `tipo:projection` (MEF-ADR-0034), por lo que un lote con dos o mas ya no aborta; el report queda en `logs/parallel-run-<ts>.report.log`. Ese scheduler espera 30 s entre lanzamientos (`--stagger <s>`, `0` lo apaga). Un `MEFISTO_UI=herdr` explicito conserva los panes, y ahi el abort de proyecciones se mantiene.

### 7. Requisitos de construccion

- Las funciones que reciben `$` se declaran en el nivel superior del modulo. `claude plugin validate` rechaza pasar `$` a closures.
- El estado que dibuja va en `$.state` (atoms), no en variables del modulo, porque sobrevive al hot-reload. En `session.start` se reabre cualquier seguimiento de proceso.
- Antes de commitear, el mod pasa `claude plugin validate`, `claude plugin test` y `tsc` con el tsconfig del header de tipos.
- Version minima: Claude Code 2.1.287, tambien para el plugin `mefisto` publicado; `/onboard` verifica esa version en el consumidor (#2083).

### 8. Tablero del planner

La sesion del planner tiene su propio mod, que muestra que se esta haciendo y que sigue. Es un unico tablero con una version por lado, y estas son las diferencias:

| | Interno | Publicado |
|---|---|---|
| Agente | `mefisto-planner` | `mefisto:planner` |
| Cierre | `mefisto-field-note.mts` | `field-note.mts` |
| Script de orden | `src/internal/scripts/mefisto-next-order.mts` | `next-order.mts`, ubicado desde la raiz del plugin |
| Lanzar trabajo | el planner no lanza | el planner no lanza |

La raiz del plugin publicado la resuelve el propio tablero; el ADR no fija el mecanismo.

**Los dos tableros son independientes en codigo.** No comparten codigo y no hay obligacion de sincronizarlos: un fix o una mejora en uno no se replica en el otro. La tabla anterior recoge diferencias de mecanica, no de experiencia: la experiencia sigue la referencia de la decision 11. Ninguna cabecera de copia hermana los vincula y ningun cambio de un lado toca los archivos del otro. El interno solo sirvio de punto de partida del port. Es lo opuesto a la regla de tres de `next-order.mts` (MEF-ADR-0018), que obliga a mantener sincronizadas sus copias; esa regla no aplica entre los dos tableros.

- **Activacion**: solo en una sesion interactiva cuyo proceso es el agente del planner (`claude --agent <agente>`). El mod lo
  lee de la linea de comando de su proceso padre (`ps`) y, como respaldo, de la fila `agent-setting` del
  transcript de la sesion. Los eventos clasicos (`SessionStart` con `agent_type`) no llegan a un modulo cargado
  con `--plugin-dir`, verificado el 2026-10-08. Un planner lanzado como subagente o con `-p` no dibuja ni
  consulta nada.
- **Foco** (dos estados, del lenguaje real de uso):
  - *refinar #N* empieza con un mensaje que pide refinar #N y termina cuando #N recibe `estado:listo`.
  - *explorar* es cualquier otra conversacion desde reposo, con la primera linea del mensaje como tema.
  - Ambos terminan tambien con el cierre del planner (ver tabla). Los borradores creados en el
    foco se anotan como su resultado, pero nunca lo cierran.
- **Orden**: las listas vienen del script de orden de la tabla con `--json`, y el orden de refinamiento de
  `--refinement`. Ninguno de los dos tableros calcula dependencias (decision 1).
- **El planner no lanza trabajo**: la lista de listos es solo lectura, sin acciones. Lanzar el pipeline de tooling o la cadena secuencial no es tarea del planner; esa superficie se resolvera aparte.
- **Alto fijo**: la lista ocupa siempre las mismas filas y pagina con `0`, asi que la banda no cambia de alto
  con la cantidad de issues.

### 9. Nombres: dos superficies, un par por lado

Los nombres siguen el *Fausto* de Goethe: Fausto decide y Mefisto ejecuta. Lo publicado es la superficie del
humano que opera el plugin, Fausto, y lleva el prefijo `fausto-`; lo interno lleva el prefijo `mefisto-` de
MEF-ADR-0019, porque en este repo se construyen los poderes de Mefisto. Los sustantivos van en ingles. El comando que registra cada mod es su propio nombre, asi que el par interno y el publicado
nunca colisionan aunque ambos carguen en el repo de Mefisto.

| Superficie | Sesion donde aparece | Interno (mod · comando) | Publicado (modulo · comando) |
|---|---|---|---|
| Tablero del planner | la del planner | `mefisto-planner-board` · `/mefisto-planner-board` | `fausto-board` en `hooks/` · `/fausto-board` |
| Consola de operacion | toda sesion interactiva que no es la del planner | `mefisto-divine-wager` · `/mefisto-divine-wager` | `fausto-blood-pact` · `/fausto-blood-pact` |

- **El tablero del planner** solo aplica a la sesion del planner: no es un "board" generico. El planner es Fausto
  (su mascota lo dibuja), asi que el publicado es `fausto-board` sin repetir `planner`.
- **La consola interna es la apuesta divina** (*Prolog im Himmel*): Mefisto apuesta contra Dios que puede con Fausto,
  y en este repo se le da lo que necesita para ganarla. **La publicada es el pacto de sangre** (*Studierzimmer*):
  donde se cumplen los deseos de Fausto.
- **La consola** dejo de ser un monitor: lista y lanza los listos, sigue `/mefisto-tooling` y `/mefisto-sequential`,
  y ofrece PRs, bitacora y release. Es el hub de operacion del plugin en la sesion de ejecucion.
- **El tablero publicado no se registra ni se activa en el repo de Mefisto** (manifiesto `.claude-plugin/plugin.json`
  con `name: mefisto` en la raiz): ahi su `next-order.mts` se niega a correr y el tablero es el interno.

### 10. Consola publicada `fausto-blood-pact`

La consola de operacion del lado publicado se construye por incrementos y se rige por estas reglas:

- **Activacion**: solo en sesiones interactivas del consumidor que no son la del planner (`claude --agent mefisto:planner`). Nunca en el repo de Mefisto ni en sesiones `-p`.
- **Ubicacion**: modulo propio en `hooks/fausto-blood-pact/`. Claude Code admite una sola entrada en `modules` por plugin (`claude plugin validate` rechaza una segunda) y un solo `session.start` sin matcher, asi que el `hooks/hooks.json` que genera el adaptador Claude (decision 4) carga el punto de entrada `hooks/index.tsx`, que solo compone el tablero (`hooks/register.tsx`) y la consola; la consola registra su `session.start` con el matcher `{ isInteractive: true }`.
- **Decisiones que aplican**: la 1 (lector puro del contrato de estado) y la 2 (las acciones delegan en skills publicados existentes). Opera solo sobre archivos del consumidor (MEF-ADR-0019) y es observacion; la operacion sigue neutral (MEF-ADR-0050).
- **Independencia**: es independiente en codigo de `mefisto-divine-wager`: no lo comparten ni hay obligacion de sincronizarlos, igual que los dos tableros (decision 8). Su experiencia toma como referencia la de `mefisto-divine-wager` (decision 11).
- **Regla incremental**: cada capacidad se construye en su propio issue. Se mergea, se publica y se verifica en un consumidor antes de abrir la siguiente; lo que falle se itera con issues nuevos.
- **Catalogo de capacidades**: vive en `hooks/fausto-blood-pact/README.md`, no en este ADR, para no enmendarlo en cada incremento.

### 11. Experiencia de referencia entre pares

Los mods de ambos lados no comparten codigo (MEF-ADR-0019), pero no deben divergir en experiencia. Los pares son:

| Superficie | Interno | Publicado |
|---|---|---|
| Tablero del planner | `mefisto-planner-board` | `fausto-board` |
| Consola de operacion | `mefisto-divine-wager` | `fausto-blood-pact` |

- **Referencia**: al construir o cambiar en un mod una capacidad que su par ya tiene, el comportamiento visual y funcional del par es la referencia en cada dimension de la experiencia:
  - **Ubicacion**: donde viven los menus y las acciones (cabecera, pie, menu de arriba a la derecha) y en que orden.
  - **Lo que ve el usuario**: informacion, conteos, estados y textos de la banda y del pane.
  - **Como se pide input**: tecla en la banda, dialogo nativo para confirmar, subcomando como respaldo.
  - **Teclas**: los digitos y lo que hace cada uno.
  - **Mascota**: rol y pose por momento, y su animacion.

  Apartarse de la referencia es una decision explicita del issue, no un descuido.
- **Estudiar el par antes de proponer**: quien disena un cambio a un mod (el planner al refinar o una sesion de trabajo directo) lee primero como lo resuelve su par -- su README y la parte de su `register.tsx` que hace lo mismo -- y propone sobre ese patron. Una divergencia se decide con el usuario y queda escrita en el issue.
- **Referencia, no sincronizacion**: un cambio en un mod no obliga a cambiar su par ni a abrir un issue espejo. Las capacidades exclusivas de un lado no tienen par: historiador y release en el interno, issues del reviewer en el publicado.
- **Identidad visual por lado**: Mefisto es rojo en lo publicado (paleta de `hooks/sprites.ts`) y blanco perla con cuernos dorados en lo interno (paleta de los mods de `.claude/mods/`). Fausto viste la tunica del color del Mefisto de su lado: roja en lo publicado y blanco perla con ribete dorado en lo interno (`T` y `d` de la paleta de cada lado).

## Consecuencias

- La sesion de ejecucion muestra el avance y ofrece el merge sin cambiar de pane, y la fila de herdr baja de tres panes a dos.
- Una corrida lanzada con el mod no tiene pane donde mirar su stdout. Su reporte queda en `logs/mefisto-tooling-run-*.report.log`, y la corrida no pierde ningun archivo de estado.
- Un cambio en el formato del status, del historial o de los nombres de los `events.jsonl` puede romper el mod en silencio. Quien cambie ese contrato debe correr los tests del mod.
- La API *early access* puede cambiar entre releases: ante una actualizacion de Claude Code, se revalida con `claude plugin validate`.

## Control de cambios

- 2026-11-10: decision 2: el hook de scope del adaptador Claude pasa a llamarse `mefisto-scope-hook.mts` al portarse a TypeScript (MEF-ADR-0057).
- 2026-11-10: decision 5 y decision 6: sale tmux, que no existe en Windows nativo (MEF-ADR-0057 decision 5). Sin el mod la observacion es el pane de herdr o el visor `stream-watch` en otra terminal, y los lanzadores pasan a llamarse `launch-pipeline.sh` y `mefisto-launch-pipeline.sh`.
- 2026-11-10: "Que queda fuera de este ADR", decision 4, decision 5 y decision 6: sale OpenCode, que deja de ser runtime soportado (MEF-ADR-0057 decision 7); sin el mod la observacion es el pane de herdr o la sesion tmux.
- 2026-11-10: decision 6: en el lado interno el modo sin pane lo decide el runtime resuelto (`MEFISTO_RUNTIME=claude` sin `MEFISTO_UI`, #2284) y el hook `tool.call` del mod solo observa el lanzamiento, sin reescribir el comando; evita que el clasificador de auto mode quede sin veredicto (issue #2506).
- 2026-10-16: decision 6 cubre los dos lados: el modo sin pane del consumidor lo decide el runtime resuelto e incluye `--parallel` (delega en `parallel-pipeline.sh`, con escalonado `--stagger`); se retira de "Aplica a" y de "Que queda fuera" el modo sin pane en el consumidor (issue #2448).
- 2026-10-14: "Que queda fuera de este ADR": se retira el punto de la lista de issues que el reviewer creaba por tests ajustados; el pipeline TDD ya no crea ese issue y la senal pasa a una seccion del body del PR (issue #2438).
- 2026-10-11: decision 11: la referencia del par se precisa por dimension de experiencia (ubicacion, lo que ve el usuario, como se pide input, teclas, mascota) y se anade el deber de estudiar el par antes de proponer (issue #2322).
- 2026-10-09: decision 11 nueva (experiencia de referencia entre pares: referencia y no sincronizacion, identidad visual por lado); decision 8: los tableros son independientes en codigo y la tabla de diferencias es de mecanica, no de experiencia; decision 10 remite a la 11 (issue #2192).
- 2026-10-09: decision 10 (ubicacion): la consola no es una segunda entrada de `modules` -- el runtime la rechaza --; un punto de entrada `hooks/index.tsx` compone tablero y consola (issue #2180).
- 2026-10-09: decision 10 nueva (consola publicada `fausto-blood-pact`: activacion, ubicacion, independencia y regla incremental); "Aplica a" y "Que queda fuera de este ADR" la incluyen; decision 9 retira "nombre reservado: no existe todavia" (issue #2179).
- 2026-10-09: decision 1, decision 5 y Consecuencias: se retira el skill interno de dashboard como segundo lector de los archivos de estado; sin el mod la observacion es el pane de herdr, la sesion tmux o el panel de logs de OpenCode (issue #2161).
- 2026-10-09: decision 9 (nombres): nombres desde el *Fausto*; `mefisto-console` pasa a `mefisto-divine-wager`, el tablero publicado `planner-board` pasa a `fausto-board` y se reserva `fausto-blood-pact` para la consola publicada.
- 2026-10-09: decision 9 (nombres): `mefisto-monitor` pasa a `mefisto-console`, consola de operacion; los tableros del planner registran `/mefisto-planner-board` (interno) y `/planner-board` (publicado) en vez de `/mefisto-board`; el publicado no se activa en el repo de Mefisto.
- 2026-10-08: generalizacion al tablero del planner publicado: aplica a ambos lados, decision 4 con dos ubicaciones, decision 8 con tabla de diferencias por lado y tableros independientes, version minima 2.1.287 del plugin publicado.
- 2026-10-08: decision 8 (tablero del planner) y orden de refinamiento en `mefisto-next-order.sh`.
- 2026-10-08: version inicial.
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts`, y el modo desacoplado deja de describirse con `nohup`: el lanzador en TypeScript arranca el pipeline en su propia sesion (`launchDetached`).
