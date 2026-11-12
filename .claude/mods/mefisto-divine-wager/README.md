# mefisto-divine-wager

Consola de operacion de Mefisto (MEF-ADR-0055): un mod de Claude Code para toda sesion interactiva que no sea la
del planner. Lista los listos y los lanza, sigue `/mefisto-tooling` y `/mefisto-sequential`, y ofrece PRs, bitacora
y release. Solo lee `.mefisto/pipeline/`, `gh` y el repo; sus acciones delegan en los skills internos existentes.
Su par en la sesion del planner es `mefisto-planner-board`.

El nombre viene del *Prolog im Himmel* del *Fausto* de Goethe: la apuesta que Mefisto le hace a Dios de que puede
con Fausto. En este repo se le da a Mefisto lo que necesita para ganarla (MEF-ADR-0055, decision 9).

## Cargarlo

Una sola vez por checkout. Los mods se instalan en alcance `local` (`.claude/settings.local.json`, no
versionado) desde el marketplace de carpeta `.claude/mods/`:

```bash
claude plugin marketplace add ./.claude/mods --scope local
claude plugin install mefisto-divine-wager@mefisto-mods --scope local
claude plugin install mefisto-planner-board@mefisto-mods --scope local
```

Desde ahi cargan solos en toda sesion de este checkout, sin `--plugin-dir`, y se leen de la carpeta: un cambio
se aplica con `/reload-plugins`. Los worktrees de los pipelines no tienen `settings.local.json`, asi que sus
sesiones `-p` no los cargan. Para probar una copia suelta: `claude --plugin-dir .claude/mods/<mod>`.

## Uso

- En reposo, en toda sesion interactiva que no sea la del planner, la banda lista los `estado:listo` en el
  orden de `mefisto-next-order.mts` (se refresca cada minuto y al cerrar una corrida). Con el prompt vacio,
  `1` escribe la linea de `/mefisto-sequential` con todos y `5`-`9` toma un solo issue: el dialogo nativo,
  junto al prompt, pregunta si va con merge (`/mefisto-sequential`) o solo PR (`/mefisto-tooling`). El comando
  queda en el prompt sin Enter para ajustarlo antes de lanzar; `0` pagina. Los bloqueados se ven al final, sin tecla.
  `2` (`PRs N`, los abiertos sin borradores) abre el dialogo nativo para mergear: todos (`--all`) o varios de los
  mas recientes, y otros numeros en la opcion de texto; al aceptar ejecuta `/mefisto-merge` de una vez.
  `3` (`bitácora N`: field notes en `docs/bitacora/field-notes/` mas las de PRs sin mergear) pide integrarlas y le
  encarga a Claude mergear esos PRs, poner `main` al dia y correr `/mefisto-bitacora`. `4` (`release N`: issues con
  fragmentos en `changelog.d/`) ofrece `/mefisto-release` con el bump que sugiere SemVer (`minor` si hay `added`)
  o solo preparar el PR, y lo ejecuta al aceptar. `PRs` incluye los de field notes, como `--all`.
  `/mefisto-divine-wager refresh` la actualiza a mano.
- `/clear`, `/resume` y `/branch` reinician el estado de la sesion: la banda vuelve sola a reposo en menos de un
  segundo con los listos, `PRs N`, `bitácora N` y `release N` recargados en el acto, sin esperar al siguiente minuto.
  La rearma el poll de cada segundo al ver los atoms en blanco: `session.start` no se repite en esos casos y el
  engine no entrega eventos `classic.*` (`classic.SessionStart` incluido) a un plugin de tier user. Una corrida o
  un sequential en curso no se conserva: se reengancha con `/mefisto-divine-wager <issue>` o `batch <issues>`.
- `/mefisto-sequential` (`--batch`) corre desacoplado y la banda lo sigue desde
  `pipeline-status-mefisto-batch.json`: avance `N/M`, la cola (`✓` mergeado, `●` en curso, `✗` fallido, `⏸`
  aplazado) y el issue en curso con su mascota, pasos y ultimas lineas. `1` detiene tras el issue en curso
  (confirma en el dialogo nativo junto al prompt; escribe la misma senal que `/mefisto-batch-stop`), `2` abre el PR del issue en curso o del
  ultimo mergeado, `3` el log (acumula todos los issues). Al terminar: resumen (mergeados, fallidos, aplazados,
  espera por rate limit), los PRs de cada issue y `4` cierra. Un toast avisa cada merge. Bajo la cola, la tabla
  lista los terminados (duracion y costo) y, mientras corre, una fila `●` del issue en curso (titulo, `PR #N` o `…`,
  tiempo desde su inicio con el reloj de la cabecera, congelado mientras espera su merge, y costo `…`); el `total` cuenta esa fila y suma su tiempo.
  `/mefisto-divine-wager batch <issues>` reengancha un sequential ya lanzado.
- Mientras `/mefisto-bitacora` corre al subagente `mefisto-historiador`, la banda de espera muestra al historiador
  escribiendo (`historiador escribiendo la bitácora N/M MM:SS`) y la cinta de sus field notes: al arrancar toma las
  de `docs/bitacora/field-notes/` y las de los PRs de field notes sin mergear (la misma fuente que `bitácora N`), y
  cada una pasa de `●` pendiente a `✓` procesada cuando aparece en `procesadas/`, en el checkout o en el worktree
  del historiador (`.mefisto/pipeline/summaries/bitacora-<fecha>/`, de `mefisto-bitacora-worktree.mts`). Al terminar,
  `bitácora escrita`; si su PR quedo abierto, la banda lo ofrece: `1` mergea (`/mefisto-merge N`, con su cinta),
  `2` lo abre en GitHub y `3` lo cierra sin mergear y borra la rama (confirma en el dialogo nativo). Si el PR ya
  no esta abierto (el skill lo mergeo), la cinta se limpia sola a los pocos segundos.
- Mientras corre `/mefisto-release` (lanzado con `4` o escrito a mano), la banda muestra un cohete: en reposo sobre
  su plataforma mientras se prepara y despegando con llama mientras corre `mefisto-release.mts`. Al lado va la cinta
  del release:
  - **Encabezado:** `release vX.Y.Z` con la version destino, calculada como `bump_version` del script a partir de
    `.claude-plugin/plugin.json` y del bump pedido.
  - **Lista:** la foto de `changelog.d/` (sin `README.md`) al arrancar, agrupada por issue, como
    `● #N título · added/changed`. Los titulos salen de `gh issue view`, en paralelo.
  - **Checklist de fases:** en una linea debajo, `rama → consolidar → PR → merge → tag → GitHub Release`.
    `--prepare-only` se detiene en el PR, y sin bump (la fase publish) solo quedan tag y release.

  Las fases se detectan por sondeo cada 5 s, no por la salida del Bash, que llega entera al terminar:

  | Fase | Se da por hecha cuando |
  | --- | --- |
  | rama | `git ls-remote --heads origin release/vX.Y.Z` devuelve la rama |
  | consolidar | la rama remota ya no tiene esos fragmentos; toda la lista pasa a `✓` |
  | PR | `gh pr list --head <rama>` encuentra el PR |
  | merge | ese PR esta `MERGED` |
  | tag | `git ls-remote --tags origin vX.Y.Z` devuelve el tag |
  | GitHub Release | `gh release view vX.Y.Z` lo encuentra publicado |

  Una fase observada da por hechas las anteriores: la rama se borra al mergear, y un sondeo puede saltarse una
  fase rapida. Los nombres de la rama y del tag son los de `RELEASE_BRANCH` y `NEW_TAG` en `mefisto-release.mts`.
  Al cerrar el turno que corrio el script:
  - **Exito:** muestra `release vX.Y.Z publicado` (o `PR #N listo` con `--prepare-only`), y `2` abre la GitHub
    Release o el PR durante 15 segundos.
  - **Fallo:** si faltaron fases, la fase en curso queda con `✗` y el encabezado dice `falló en <fase>`.
- Mientras corre `/mefisto-merge` (lanzado con `2`, con `1` desde la corrida o escrito a mano), la banda de espera
  muestra la cinta: el hilo de la rama y el de `main` bajan y se cierran como una cremallera, `cosiendo N PRs MM:SS` y una
  linea `● #N título` por PR pendiente (con `--all`, todos los abiertos). Un PR sale de la lista al
  quedar mergeado: lo dice la salida del Bash (`gh pr merge N` con exit 0, o el aviso de `gh`) y, como respaldo,
  `gh pr view N --json state` cada 5 s; si su merge falla queda con `✗`. Al terminar el turno lo que siga pendiente
  cuenta como fallido, la cremallera queda cerrada y la cabecera dice `N mergeados` (y los fallidos); se limpia sola
  a los pocos segundos.
- Las cintas terminadas de release, merge y bitácora vencen al dibujar, sin depender del temporizador: si un
  hot-reload del mod mata el `clock.after` que las limpiaba, la banda vuelve igual a reposo y el siguiente hook que
  escribe estado (`session.start`, `prompt.submit`, `tool.call`) borra la cinta vencida. La de bitácora con un PR
  abierto no vence: espera a que lo mergees, lo veas o lo cierres.
- Si un agente espera por rate limit (la ultima linea de `events.log` es un `[hold]`), la banda de la corrida y la
  del sequential lo dicen: `en espera por RATE_LIMIT · próxima sonda HH:MM · techo HH:MM`.
- Durante la corrida la misma banda muestra la mascota del agente activo (animada), issue, stage, tiempo, los
  pasos y las ultimas lineas del agente; `3` abre el log completo. Al terminar, con el prompt
  vacio: `1` mergea el PR (confirma y encola `/mefisto-merge`), `2` lo abre en GitHub, `3` abre el log y
  `4` cierra la corrida y vuelve a los listos.
- Cuando el PR queda mergeado (desde la banda, `/mefisto-merge` o GitHub), la corrida se cierra sola.
- `/mefisto-divine-wager [issue|batch <issues>|merge|close|refresh]` abre el log enfocado, sigue una corrida o un
  sequential, o ejecuta la accion.
- Dentro del log: `m` mergea, `v` abre el PR, `c` cierra; `ctrl+x tab` lo enfoca y `esc` vuelve al prompt.

## Verificar un cambio

```bash
claude plugin validate .claude/mods/mefisto-divine-wager
claude plugin test .claude/mods/mefisto-divine-wager
```
