# fausto-blood-pact

Consola de operación publicada de Mefisto (MEF-ADR-0055). Módulo del plugin independiente del tablero `fausto-board`: Claude Code carga un solo módulo por plugin, así que `hooks/hooks.json` apunta a `hooks/index.tsx`, que solo compone ambos `register`.

## Activación

Se activa sola en una sesión **interactiva** del proyecto consumidor. No se activa ni registra `/fausto-blood-pact` en:

- una sesión `claude --agent mefisto:planner` (ahí vive `fausto-board`),
- una sesión no interactiva (`-p`),
- el repo de Mefisto (manifiesto `name: mefisto`).

La cinta de merge sigue la llamada Bash a `pr-sync.sh` con `tool.call`, no `prompt.submit`/`turn.complete` ni `classic.*`: los dos primeros sin matcher los registra el tablero y el engine rechaza el módulo si se registran dos veces (#2294), y el plugin carga en tier user, que no recibe `classic.*` (#2302).

Comandos: `/fausto-blood-pact on` | `off` | `refresh` | `ocultar`. `on`/`off` sobreviven a `/clear`: un vigilante de un segundo (`$.clock.every`, armado una vez en `session.start`) compara la intención guardada en variables del módulo con el atom y reactiva la banda si la consola es elegible y no está apagada, porque `/clear` reinicia el estado sin disparar `session.start` y el engine no entrega `classic.*` a un plugin de tier user. El render no escribe estado (el engine lo rechaza); el vigilante corre desde el reloj y pide `ui.invalidate('ui.render')` tras rearmar.

Si al arrancar no se puede leer la línea de comando de Claude Code y el transcript aún no existe, la consola arranca y reintenta la detección del planner en cada refresco; si resulta ser el planner, se apaga.

## Capacidad vigente (incremento 1)

Una banda sobre el prompt cuya primera línea (en todas las vistas, a todo el ancho de la banda y por encima de la mascota; en reposo comparte línea con el menú `2: PRs N` / `3: bitácora N`) es `mefisto · listos N` (`mefisto` en el color `claude`, el resto atenuado) seguida del estado de la vista (`· corridas N activas`, `· sequential N/M …`, `· merge N/M …`), con los issues listos (`estado:listo`) en el orden de `scripts/next-order.sh --json`: número de orden, `#issue`, `tipo` y título. Alto fijo (5 filas), paginada con `0`; se refresca cada minuto y con `refresh`. Los issues con PR abierto (`inPr[]` de `next-order.sh --json`) van después de los lanzables, en el mismo orden, como `T #N título… · PR #X`: sin dígito de tecla, toda la fila atenuada (la letra de tipo conserva su color) y cuentan en la paginación `0`; `listos N` cuenta solo los lanzables y, con issues en PR, suma `· en PR M` atenuado. Con un script viejo sin `inPr` se ve como antes. No hay acciones nuevas: mergear sigue por `2: PRs N`. Al pie solo quedan `infra: #N` y `N en ciclo`, que condicionan el lanzamiento. Si `next-order.sh` falla muestra el error sin romper la sesión.

Es solo lectura: no hay teclas ni botones que lancen trabajo, y el orden se lee del script, nunca se calcula aquí.

Estado en `PluginState['mefisto']` con claves de prefijo `pact` (`pactIsActive`, `pactList`, `pactPage`) para no chocar con `fausto-board`.

## Capacidad vigente (incremento 2): seguir corridas

Las corridas toman la banda solo mientras haya al menos una activa (`running` o `hold`): muestra las del repo (todas, no solo las lanzadas por la sesión), una línea por corrida. Sin activas se ven los listos con todas sus teclas, y los resultados sin ocultar quedan en una línea al pie: `resultados: ✓#N PR #X · ✗#M <stage> · ocultar` (recortada al ancho, con `+N`; en reposo `ocultar` no tiene tecla y solo se hace clic; en la vista de corridas sigue `4: ocultar`).

- Lee solo de `.mefisto/pipeline/` (la ruta legada `.claude/pipeline/` se ignora, MEF-ADR-0053) `pipeline-status-{tdd,tooling,infra}-<n>[-<variante>].json` del checkout principal (`git rev-parse --git-common-dir`, aunque la sesión esté en un worktree). `running`: `#N pipeline agente Mm`; `hold`: `rate limit · sonda HH:MM`.
- Resultados: `✗ <stage>` para `failed`/`blocked`/`gaps`; `✓ PR #X` cuando desaparece el status de una corrida que la sesión vio activa (PR leído de `pipeline-history.jsonl`).
- Ocultar: tecla `4` (solo en la vista de corridas), clic en `ocultar` en reposo, o `/fausto-blood-pact ocultar` (`descartar` sigue como alias del comando). No toca `.mefisto/pipeline/`: se guarda en `$.store` con clave repo + pipeline + issue + variante + `started`, y no reaparece en otros panes ni sesiones. Las claves de status inexistente y de más de un día se podan.
- Alto fijo de 5 filas, paginado con `0`. Con alguna corrida activa se refrescan cada 5 s; sin corridas activas, al ritmo de los listos (cada minuto).

## Capacidad vigente (incremento 3): lanzar trabajo

Con la lista de listos visible y el prompt vacío (con la banda mostrando corridas las teclas no actúan), la consola **escribe el comando en el prompt sin enviarlo**; la persona lo revisa y lo envía. Las líneas se leen de `next-order.sh --json --launch-command "/mefisto:sequential" --parallel-command "/mefisto:parallel"`, nunca se calculan aquí.

- `1`: línea de `/mefisto:sequential` (sin infra). `4`: línea del lote `/mefisto:parallel` (`p` ya no actúa). `1` y `4` solo escriben el comando en el prompt; nunca lo envían. Con la línea en `null` la tecla no se muestra ni actúa.
- Con `tipo:infra` listos, `1` y `4` abren un diálogo (`$.ui.ask`): "Infra primero" (`/mefisto:infra <primer infra>`), "Seguir sin infra" o "Cancelar". Cerrar el diálogo o un texto libre no escriben nada.
- `5`-`9`: el issue de esa fila (prefijo `5:`…`9:`) con diálogo por `tipo`: `feature`/`refactor`/`projection` -> "Con merge" (`/mefisto:sequential <n>`) o "Solo PR" (`/mefisto:implement <n>`); `tooling` -> "Con merge" o "Solo PR" (`/mefisto:tooling <n>`); `infra` -> solo "Solo PR" (`/mefisto:infra <n>`). Sin tipo lanzable, un toast lo avisa.
- Pie: última línea de la banda, fuera de la columna de la lista, bajo la mascota y a todo el ancho: `1: sequential N · 4: parallel M` (N y M, los issues de cada línea) a la izquierda, `0: página 1/2 ▸` a la derecha, más `infra: #N` y `N en ciclo` si aplican.
- `/fausto-blood-pact lanzar [sequential|parallel|<n>]`: lo mismo sin teclas; sin argumento equivale a `1`.

Fuera de alcance: lanzar sin pasar por el prompt y mergear PRs.

## Capacidad vigente (incremento 4): la mascota

A la izquierda de la banda, Mefisto (rojo, de `hooks/sprites.ts`; código propio, nada se importa de `.claude/mods/`) dibujado con `Raster`, recortado a un ancho común a todos sus cuadros para que no salte. Las filas de listos y corridas descuentan esa columna. Si el engine no ofrece `Raster`, queda el hueco y la banda sigue.

- **Reposo** (listos, sin corridas): de frente y quieto.
- **Claude trabaja en la sesión**: mira de lado a lado y voltea un reloj de arena a un cuadro por segundo (`waitingFace`).
- **Con corridas**: la mascota de la corrida activa con `updated` más reciente. Rol por agente del `stage`: `test-writer`/`smoke-test-writer`/`coverage-gate` -> tester; `implementer`/`writer`/`setup`/`scaffold` -> desarrollador; `reviewer`/`infra-reviewer` -> revisor; `infra-writer` -> infraestructura.
- **Pose** por el último evento del último intento (`.mefisto/pipeline/logs/<prefijo>stage-<stage>-<started>-issue-<n>[-<variante>]-attempt-<k>.events.jsonl`; prefijo `""` en tdd, `tooling-`, `iac-`): `tool.started` -> trabajando (desplegando en infra); `message` del assistant o sin eventos -> pensando; edición (`Edit`/`Write`/`MultiEdit`) del revisor -> corrigiendo. En `hold` rige la misma regla.
- **Solo resultados**: `✓` -> revisor aprobado (infra: arriba); `✗` -> desarrollador error (infra: caído).

Bajo la mascota, centrada y atenuada, va la versión del release cargado (`v0.46.0`), igual que en `fausto-board`: sale de `mefisto-manifest.json` en la raíz del plugin y, si falta o no es SemVer válida, de `.claude-plugin/plugin.json`; se lee al activar y en `refresh`, y si ninguna se lee no se muestra nada (la banda no cambia de alto).

Anima solo mientras hay corrida activa o Claude trabaja. Es lectura pura de status y `events.jsonl`. Los pasos y las últimas líneas del agente llegan con la vista de corrida (ver incremento 7).

## Capacidad vigente (incremento 5): mergear el PR de una corrida terminada

Con la banda en corridas y al menos un `✓ PR #X`, el pie suma `1: mergear · 2: ver PR` a `4: ocultar` y `0` página. Sin `✓` con PR (o solo `✗`) las teclas no se muestran ni actúan.

- `1`: con un solo `✓`, confirma con `$.ui.ask` ("Mergear #X" / "Cancelar") y ejecuta `/mefisto:merge <pr>` con `$.command.run`, anunciado con un toast. Con varios, selección múltiple: "Todos" y hasta 3 PRs más recientes (los demás números, en la opción de texto). Se pasan solo los números de los `✓`, nunca `--all`. Cancelar o no elegir no ejecuta nada. La confirmación del diálogo es la única.
- `2`: `gh pr view <pr> --web`; con varios `✓`, pregunta cuál.
- Mientras haya `✓` con PR, se consulta su estado cada 15 s; al quedar `MERGED` la línea desaparece sola (se guarda en `$.store`, no toca `.mefisto/pipeline/`). En infra el toast avisa que el issue se cierra al terminar el `apply` de CI (MEF-ADR-0022).
- `/fausto-blood-pact merge [<pr>...]` y `/fausto-blood-pact pr [<pr>]`: lo mismo sin teclas.

Fuera de alcance: mergear PRs que la sesión no vio terminar y resolver comentarios de review.

## Capacidad vigente (incremento 6): mergear PRs abiertos desde el reposo

En reposo (listos visibles), si hay PRs abiertos, la primera línea suma, a la derecha, `2: PRs N` (`gh pr list --state open`, sin borradores; incluye los de field notes `docs/planner-field-notes-*`, que además suman en la bitácora, incremento 9; se refresca con los listos y tras cada merge). Sin PRs abiertos el botón no aparece.

- `2`: con un solo PR, `$.ui.ask` con `#N título` y "Cancelar"; con varios, selección múltiple: "Todos" y los 3 más recientes (otros números, en la opción de texto). Ejecuta `/mefisto:merge` con `$.command.run`, anunciado con un toast. "Todos" ejecuta `/mefisto:merge --all` (`pr-sync.sh --all` toma todo PR abierto, borradores incluidos). Cancelar o no elegir no ejecuta nada.
- `/fausto-blood-pact prs`: lo mismo sin teclas.

## Capacidad vigente (incremento 7): seguir un sequential como lote

Con `pipeline-status-batch.json` (lo escribe `batch-pipeline.sh`, #2202) en `state: running`, **el lote ocupa la banda**. Lectura pura del archivo; la consola nunca lo modifica.

- Lote en curso (#2350, igual que la cinta interna): cabecera `mefisto · sequential M/N <MM:SS|H:MM:SS>` (M = mergeados + fallidos; tiempo atenuado desde `started`; con parada pedida, `· se detiene tras #N` en warning) con las acciones arriba a la derecha (`1: detener`, `2: ver PR #X`, `3: log` atenuado mientras corre); sin fila de acciones al pie. Junto a la mascota, con `marginTop=1`: la cola en una línea separada por ` ─ ` (`✓` success, `●` warning con su paso, `✗` error, `⏸` y `○` atenuados), `#N título` atenuado, la espera por rate limit en warning si el eslabón está en `hold` (`en espera por rate limit · próxima sonda HH:MM`; si no, una fila en blanco) y las últimas 3 líneas con hora (`HH:MM:SS texto`; se descartan separadores y líneas sin hora; color: inicio `claude`, éxito `success` —también `<agente> completado en Ns`—, fallo `error`). Sin issue en curso: `preparando el primer issue…`. No hay fila de pasos del agente en el lote; la corrida suelta la conserva. La mascota sigue la regla del incremento 4.
- `1`: `$.ui.ask` ("Detener tras el actual" / "Seguir"); al aceptar escribe la señal vacía `pipeline-state/batch-stop` en la raíz del checkout principal (`git rev-parse --git-common-dir`), la misma de `/mefisto:batch-stop` (MEF-ADR-0017); nunca mata un proceso. Con `stop_requested` la tecla no se ofrece.
- `2`: `gh pr view --web` del PR del eslabón en curso o, si aún no tiene, del último `mergeado`. Sin PR no se muestra.
- Cada issue que pasa a `mergeado` dispara un toast. Con el lote en `completed`/`failed`/`stopped` la banda muestra el resumen (mergeados, fallidos, aplazados, saltados, espera por rate limit) con el PR de cada issue; `4` lo cierra (ocultado persistente en `$.store`, clave repo + `started`, sin tocar el archivo).
- `/fausto-blood-pact detener` equivale a `1`; sin lote en curso, lo dice.

### Vista de corrida con pasos y últimas líneas (#2320)

Con una corrida activa (la del eslabón en curso del lote, o la única corrida suelta sin resultados pendientes) la banda copia la experiencia de la cinta interna:

- Primera línea, a todo el ancho: `mefisto · sequential 0/1 · #853 projection-implementer 3m` en el lote y `mefisto · #853 projection-implementer 3m` en una corrida suelta. Las teclas no cambian (`1: detener`, `2: ver PR`, `4: cerrar`, según la vista).
- Fila de pasos, de `status.agents` en su orden, separados por ` ─ `: `✓` passed (success), `●` running (warning), `✗` failed (error), `○` pending (atenuado); se recorta al ancho.
- Título del issue y las 3 últimas líneas útiles, atenuadas: cola del log del pipeline (`status.log`, sin ANSI) y el último evento del agente activo (`HH:MM:SS <Tool>`, o `success · N turnos · $X` al cerrar). Los `events.jsonl` publicados van redactados (MEF-ADR-0053), así que no traen mensajes. Se calculan en el sondeo de 5 s (cola del archivo, `tail -c`) y se guardan en el atom `pactBandLines`; el render no escribe. El seguimiento continuo con `tail -F` es del pane de log (ver abajo).
- La mascota decide su rol por sufijo del agente (el prefijo `<n>-` del stage se ignora): `*test-writer` y `*coverage-gate` tester, `*reviewer` revisor, `*infra-writer` infraestructura, el resto desarrollador.
- Arranque inmediato: un `tool.call` Bash cuyo comando invoca `batch-`, `launch-`, `tdd-`, `tooling-` o `iac-pipeline.sh` arma el sondeo de corridas cada 5 s durante 2 minutos aunque aún no haya status, y llama a `refreshRuns` al volver la llamada (mismo matcher `Bash` que ya usa la cinta de merge).

### Pane de log (#2321)

`3: log` en la vista de corrida y en la del lote (atenuada mientras la corrida corre) abre un pane enfocado, como la cinta interna; pulsar `3` otra vez, `c` o `/fausto-blood-pact log` lo abre o cierra. Lectura pura de `.mefisto/pipeline/`.

- **Cabecera:** `mefisto · #N <pipeline>` (en el lote, `mefisto · sequential N/M · #N <pipeline>`) con el tiempo a la derecha, el título del issue y la fila de pasos con la duración de cada paso terminado (`agents.<x>.duration`). Con PR: `✓ PR #X creado`, `m: Mergear #X` (pasa por `mergePrs`, que confirma), `v: Ver en GitHub` y `c: Cerrar log`. Si falló: `✗ falló en <stage>: <last_error>` y `c`. Mientras corre: `c: Cerrar log` y la ayuda `3 en la banda también lo cierra · ctrl+x tab enfoca · esc vuelve al prompt`.
- **Cuerpo:** dos `tail -n 40 -F` (`$.process.spawn`) mezclados en orden de llegada en un atom de hasta 400 líneas; se muestran las últimas que caben. Los pipelines publicados corren con `--redact-observability` (MEF-ADR-0053, no se toca), así que el `events.jsonl` solo trae nombre de herramienta, hora, fallos y cierre; el resto sale del log del pipeline.
  - Eventos del agente: el `events.jsonl` del intento vigente del stage activo (`parseEvent`): `── agente · modelo ──`, `HH:MM:SS <Tool>`, `tool.completed` con `ok:false` y `run.failed` en rojo, y `success · N turnos · $X`. Al cambiar de stage o de intento sigue el archivo nuevo.
  - Log del pipeline: el `log` del status de la corrida o, en el lote, el de `pipeline-status-batch.json` (acumula todos los issues), sin ANSI y atenuado. Cada eslabón del lote empieza con `══ #N ══`.
- **Cierre:** al cerrar el pane, o al irse la vista (`4: cerrar`, `ocultar` o una corrida que cierra sola), se cierra el pane y se cancelan los dos `tail` por su stream (nunca por patrón).

## Capacidad vigente (incremento 8): la cinta de merge en vivo

Cuando el agente lanza `pr-sync.sh <PRs> --merge` (o `--all --merge`) tras un `/mefisto:merge` escrito a mano, o la cinta ya arrancó con la tecla `3`, la `1` o `/fausto-blood-pact merge`, la banda pasa a la cinta de merge mientras `pr-sync.sh` trabaja. La detección es la función pura `mergeRunArgsOf`, que lee solo los tokens tras `pr-sync.sh` (hasta `;`, `&&`, `||` o `|`) y exige `--merge`; una cinta ya arrancada por teclas se adopta, no se duplica. Con `--all`, la lista sale de `gh pr list --state open` al arrancar.

- Cabecera `merge N/M · Mm` (N cuenta los mergeados), una fila por PR (`· #12 título` pendiente, `✓` mergeado, `✗ no mergeado`) y la mascota en pose `cosiendo` (sprite `merge`), a un cuadro por segundo.
- `pr-sync.sh` corre en una sola llamada Bash, así que el avance sale del sondeo: cada 5 s `gh pr view <n> --json state` de los pendientes; un `MERGED` pasa a `✓`.
- Al volver la llamada a `pr-sync.sh` (también si falla o se deniega) se hace un último sondeo; lo que siga pendiente queda `✗ no mergeado`, la mascota pasa a `listo` y un toast resume `N mergeados · M fallidos`. Red de seguridad: una cinta arrancada por teclas que no ve su `pr-sync.sh` en 60 s la cierra el reloj de 1 s.
- La cinta terminada se oculta sola a los 15 s (se calcula al dibujar con `now - finishedMs`, sin escribir estado desde el render); `4: cerrar` la oculta antes.
- Precedencia de la banda: lote de `sequential`, cinta de merge, corridas y reposo. El estado vive en `$.state` (atom `pactMerge`); no lee ni escribe `.mefisto/pipeline/`.

## Capacidad vigente (incremento 9): la bitácora

En reposo, arriba a la derecha y junto a `2: PRs N`, aparece `3: bitácora N`. N suma los `.md` de `docs/bitacora/field-notes/` (sin bajar a `procesadas/`) y los PRs abiertos de rama `docs/planner-field-notes-*`. Con N = 0 o con el historiador escribiendo, el botón se oculta. `2: PRs N` también cuenta y lista esos PRs ("Todos" es `--all`, que los mergea), así que un PR de field notes suma en los dos botones. El conteo se refresca al ritmo de los listos.

- `3`: `$.ui.ask` "¿Integrar la bitácora? X field notes en main y Y en PRs sin mergear" con `Mergear sus Y PRs e integrar` (o `Integrar` si Y = 0) y `Cancelar`. Al aceptar envía como prompt del usuario (`$.prompt.submit({ asUser: true })`): `Integra la bitacora: mergea los PRs de field notes #… con /mefisto:merge, pon el checkout en main al dia (git switch main && git pull --ff-only) y luego corre /mefisto:bitacora.` No se modifica `/mefisto:bitacora`.
- Detección del historiador: se sondea `$.agent.list()` buscando un agente activo cuyo tipo cumpla `/(^|:)historiador$/` (el nombre lleva el prefijo del plugin).
- La cinta: cabecera `· historiador escribiendo la bitácora k/n mm:ss` en `warning`, mascota historiador (diablito con pluma, poses `escribiendo` y `listo` en `hooks/sprites.ts`) y la lista de field notes (de `docs/bitacora/field-notes/` más las de los PRs de field notes vía `gh pr view --json files`): primero las pendientes `●`, luego las procesadas `✓`. Una nota pasa a procesada al aparecer su nombre en `docs/bitacora/field-notes/procesadas/`, revisado cada 3 s.
- Al terminar: si queda abierto un PR que solo toca `docs/bitacora/` y no es de rama de field notes, la cabecera muestra `· bitácora escrita · PR #N` y arriba a la derecha `1: mergear · 2: ver PR · 3: cerrar PR` (`mergear` va por `/mefisto:merge N`; `cerrar PR` pide confirmación y borra la rama). Si no queda PR (el skill ya lo mergeó), la cinta se va sola a los 8 s; si el PR se mergea o cierra por fuera, en el siguiente chequeo.
- Precedencia de la banda: lote de `sequential`, cinta de merge, cinta del historiador, corridas y reposo. Estado en `$.state` (atoms `pactFieldNotes` y `pactHistorian`); lectura pura de `docs/bitacora/`.

## Capacidad vigente (#2332): vista del sequential terminado igual a la cinta interna

Con el lote terminado (MEF-ADR-0055 decisión 11, referencia `mefisto-divine-wager`):

- Cabecera `mefisto · sequential M/N · <estado> <MM:SS|H:MM:SS>` (M = mergeados + fallidos; estado `terminado`/`detenido`/`con fallos`; sin `listos N` ni `batch`) con las acciones arriba a la derecha en el orden `2: ver PR #X`, `3: log`, `4: cerrar`. No hay fila de acciones al pie ni paginación `0`.
- Junto a la mascota: la cola `✓ #853 ─ ✗ #854 ─ ⏸ #855`, el resumen `✓ N mergeados · ✗ N fallidos · ⏸ N aplazados · espera Xm` y, si hay un fallido, `#N <motivo>` en rojo.
- Tabla de cierre a todo el ancho: una fila por issue mergeado o fallido (marca, `#N`, título, `PR #X`/`sin PR`, duración y costo) y una fila `total` con más de un issue.
- Duración y costo salen de `pipeline-history.jsonl` del consumidor (pipelines `tdd`, `tooling`, `iac`; `started`→`finished` y suma de `agents.*.metrics.estimated_cost_usd`), solo con entradas posteriores al inicio del lote; sin entrada la celda muestra `…` y el historial se relee como mucho cada 5 s.

## Capacidad vigente (#2361): tabla y tiempo del issue en curso

Con el lote en curso (paridad con `mefisto-divine-wager`, MEF-ADR-0055 decisión 11), debajo del bloque mascota + columna y a todo el ancho aparece la misma tabla del cierre:

- Una fila por issue terminado (duración y costo de `batchStatsAtom`, que ahora se lee también mientras corre) y una fila `●` (warning) del issue en curso: `#N`, título, `PR #X` o `…`, tiempo desde el `started` de su corrida (`MM:SS` o `H:MM:SS`, mismo reloj que la cabecera, sigue contando durante una espera por rate limit) y `…` de costo.
- La fila `total` aparece con más de una fila: cuenta la en curso y suma su tiempo, pero en costo suma solo los terminados.
- Sin corrida del issue en curso todavía no hay fila `●`. Si su corrida termina y el issue espera su merge, la fila sigue con el tiempo congelado (como la cinta interna); al quedar mergeado o fallido pasa a la forma de terminado, sin duplicarse. La vista del lote terminado (#2332) no cambia.

## Capacidad vigente (#2449): lote parallel con una banda por desarrollo

Un lote `/mefisto:parallel` se ve en la banda de la sesión que lo lanzó. El disparador es `pipeline-status-parallel.json` (#2447) en `state: running`; el módulo solo lo lee, nunca lo escribe. Precedencia de la banda: lote sequential en curso, lote parallel en curso, cinta de merge, cinta del historiador, corridas y reposo (con un sequential y un parallel a la vez gana el sequential).

- **Cabecera única**: `mefisto · parallel M/N <MM:SS|H:MM:SS>` (M = terminados + fallidos, tiempo desde `started`); con la parada pedida agrega `· se detiene: no lanza mas` en warning.
- **Acciones** (una sola vez, arriba a la derecha): `1: detener` (solo con issues `pendiente` y sin parada pedida; `$.ui.ask` y escribe `pipeline-state/batch-stop` en la raíz del checkout principal, la misma señal de `/mefisto:batch-stop`; ningún proceso se mata), `2: ver PR` (con más de un PR pregunta cuál) y `3: log` (con más de una corrida en curso pregunta de cuál y abre el pane de log de esa corrida, #2321). `/fausto-blood-pact detener` también detiene el parallel.
- **Cola**: `✓ #a ─ ● #b ─ ○ #c ─ ✗ #d` con las marcas y colores del sequential.
- **Una banda por corrida en curso**: cada issue `en-curso` repite la vista de corrida del sequential: su mascota (rol por el sufijo del agente y pose por su último evento), la fila de pasos, `#N título` y sus últimas 3 líneas útiles con hora; en `hold`, la espera por rate limit va en warning. Se calculan en el sondeo de 5 s (el render no escribe estado). Hasta 3 bandas por página en el orden de `issues[]`; con más, `0: página k/n ▸` pagina. Pendientes y terminados no tienen banda.
- **Tabla**: debajo, a todo el ancho, la de #2361: una fila por terminado o fallido (duración y costo de `pipeline-history.jsonl`), una fila `●` por cada issue en curso con su tiempo y `…` de costo, y `total` con más de una fila.

Estado en `pactParallel`, `pactParallelStats`, `pactParallelBands` y `pactParallelPage`. El par interno `mefisto-divine-wager` no tiene parallel.

## Capacidad vigente (#2450): lote parallel terminado y merge de sus PRs

Con `pipeline-status-parallel.json` en `completed`, `stopped` o `failed` y sin ocultar, la banda muestra el lote cerrado con la misma vista que el sequential terminado (#2332). Precedencia entre cerrados: gana el lote de `started` más reciente.

- **Cabecera**: `mefisto · parallel M/N · <terminado|detenido|con fallos> <MM:SS|H:MM:SS>` (el tiempo va del `started` al último `finished`); acciones arriba a la derecha: `1: mergear`, `2: ver PR`, `3: log`, `4: cerrar`.
- **Junto a la mascota**: la cola final, el resumen `✓ N con PR · ✗ N fallidos · ⏸ N aplazados · ⤼ N saltados` (omite lo que está en cero) y, si hay fallido, `#N <motivo>` en rojo.
- **Tabla de cierre** a todo el ancho: una fila por terminado o fallido (marca, `#N`, título, `PR #X`/`sin PR`, duración, costo) y `total` con más de una fila.
- **`1: mergear`**: reusa el flujo de las corridas terminadas (`mergePrs`). Con un solo PR confirma con `$.ui.ask`; con varios, selección múltiple con "Todos" y los 3 más recientes (otros números en la opción de texto). Ejecuta `/mefisto:merge <prs>` con `$.command.run` con solo los PRs del lote, nunca `--all`. Mientras el merge corre, la cinta de merge toma la banda como en las corridas terminadas y, al cerrarse, vuelve la vista del lote. Un sondeo de 15 s marca los PRs `MERGED` y dejan de ofrecerse; sin PRs abiertos la tecla no aparece.
- **`4: cerrar`**: ocultado persistente en `$.store` con clave repo + `started`; el archivo de estado no se toca y un lote nuevo (otro `started`) vuelve a mostrarse.

Estado adicional en `pactParallelMerged`.
