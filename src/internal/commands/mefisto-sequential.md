---
{
  "kind": "command",
  "id": "mefisto-sequential",
  "description": "Lanza el pipeline INTERNO secuencial para varios issues del repo de Mefisto, dentro de una sesion tmux.",
  "profile": "fast",
  "arguments": "<issue1> <issue2> ..."
}
---

Lanza el pipeline INTERNO secuencial para varios issues del repo de Mefisto, dentro de una sesion tmux. Comunicate en **espanol**.

**Alcance**: este skill solo opera dentro del repo del propio plugin Mefisto. Modifica archivos del harness (skills, agentes, scripts, hooks, ADRs, metadata del plugin). NO toca codigo de aplicacion ni archivos del consumidor.

En Mefisto solo existe el pipeline de tooling, asi que **no se expone** `--pipeline tdd|tooling`.

El timeout de watchdog por stage es configurable con la variable de entorno `MEFISTO_AGENT_TIMEOUT_SECONDS` (default 1800; entero > 0, issue #946), heredada por cada eslabon del batch.

## Entrada

Los numeros de issues estan en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto-sequential <issue1> <issue2> ...`

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Si trabajas en un proyecto consumidor, usa /sequential en su lugar."
    exit 1
}
```

### 1. Validar cada issue

Para cada numero en `$ARGUMENTS`, ejecuta:

```bash
gh issue view <num> --json number,title,state,labels -q '"#\(.number): \(.title) [\(.state)] labels: \([.labels[].name] | join(", "))"'
```

Reglas de exclusion/abortar:

- Si el issue **no existe**: informalo y excluyelo de la lista.
- Si el issue esta `CLOSED`: informalo y excluyelo de la lista.
- Si el issue **no tiene** el label `estado:listo` (por ejemplo, esta en `estado:borrador`):
  informalo y **excluyelo automaticamente**, sin preguntar `s/n` (decision de este skill,
  issue #466). `estado:listo` es criterio **Obligatorio** del Definition of Ready para todo
  `tipo:` en MEF-ADR-0011, y el primer criterio de la validacion programatica que el
  `/implement` publicado ya aplica: un draft no lo cumple por definicion -- sus criterios de
  aceptacion son todavia preguntas abiertas. A diferencia de `tipo:tooling` (una senal blanda
  que un humano puede decidir ignorar a sabiendas), aqui el batch arranca **headless** en tmux
  sin nadie supervisando la ejecucion, asi que una confirmacion `s/n` en el momento de invocar
  el skill no cubre el riesgo: el default es excluir siempre.
- Si el issue **no tiene** el label `tipo:tooling`: advierte y pregunta `s/n`. Si la respuesta es `n` (o no hay confirmacion), excluyelo de la lista.

### 1.5. Validar dependencias del batch (con resolucion intra-batch)

Para **cada issue que sobreviva al paso 1** -- el label `bloqueado` ya **no** es condicion
de entrada a este analisis (issue #466: una dependencia sin ese label no puede seguir
ignorandose en silencio) -- lee la seccion `## Dependencias` del body y extrae **solo** los
numeros precedidos por un marcador forward canonico (`Depende de #NNN` / `Bloqueado por
#NNN`, case-insensitive, en la misma linea). Ignora referencias inversas (`Consumido por
#NNN`, `Bloquea #NNN` / `Bloquea a #NNN`), notas libres (`... se traslada a #NNN`,
`Relacionado con #NNN`) y prosa: no son dependencias forward de este issue. El label
`bloqueado` conserva su rol, pero solo como **salida**: se quita de los issues que lo
llevaban puesto cuando sus dependencias abiertas quedan resueltas por el orden del batch
(ver regla de decision mas abajo); un issue que nunca lo tuvo no lo gana por este analisis.

La idea clave (issue #47): una dependencia abierta **no siempre** es un bloqueo. Como la
cadena hace `pipeline -> PR -> merge -> sync verificado -> siguiente` (ver paso 5 e issue
#46), si la dependencia es **otro issue del mismo batch que se procesa antes en el orden**,
quedara resuelta **durante** la ejecucion. Por eso clasificamos cada dependencia abierta:

- **(a) Satisfactible por el batch**: la dependencia es otro issue del batch y aparece
  **antes** en el orden. No es un bloqueo: el orden + el sync verificado (#46) garantizan
  que ya estara mergeada cuando arranque este eslabon.
- **(b) Bloqueo real**: la dependencia esta **fuera del batch** (y no esta `CLOSED`/`MERGED`),
  o esta **dentro del batch pero despues** en el orden (mal ordenada). En ambos casos el
  batch no la puede resolver por si mismo.

Las dependencias ya `CLOSED`/`MERGED` siguen siendo el caso ortogonal de siempre: estan
satisfechas y no cuentan como bloqueo (no importa si estaban o no en el batch).

**Regla de decision**:

- Si **todas** las dependencias abiertas de un issue son de tipo (a) (o ya estan cerradas):
  el batch **se puede lanzar** y el issue se procesa en su posicion. Si el issue **llevaba
  puesto** el label `bloqueado`, se lo quita al validar (decision CA-5: el orden + el sync de
  #46 garantizan su resolucion, asi que mantener el label seria mentir sobre el estado); si
  nunca lo tuvo, no hay nada que mutar.
- Si existe **al menos una** dependencia de tipo (b): **aborta** y no lances el batch,
  mostrando cual es y por que. Si la causa es una dependencia intra-batch mal ordenada,
  sugiere el reordenamiento concreto (ej. "mueve #44 antes de #43").

Para clasificar, necesitas la **lista ordenada** de issues que sobrevivieron al paso 1
(en el mismo orden de `$ARGUMENTS`). Invoca el validador del batch pasando esa lista como
argumentos, respetando el orden del batch:

```bash
{{mefisto:run mefisto-validate-batch-deps.sh <issue1> <issue2> ...}}
```

El script interpreta el batch completo (no un issue a la vez) y termina con uno de tres
exit codes:

- **`0`**: el batch se puede lanzar. Ya quito el label `bloqueado` de los issues que lo
  llevaban puesto y cuyas dependencias abiertas resuelve el propio orden del batch (regla de
  decision de arriba), y reporta en una linea informativa las dependencias tipo (a) de los
  issues que **no** llevaban el label -- no hay label que quitarles, pero conviene ver que la
  validacion si leyo su body. Continua al paso 2.
- **`1`**: hay al menos un bloqueo real -- aborta, no se muto ningun label. Muestra el
  mensaje del script (incluye el reordenamiento concreto si la causa es una dependencia
  intra-batch mal ordenada, ej. "Mueve #44 antes de #43") y detente.
- **`2`**: se invoco sin argumentos -- no se valido nada. No interpretes esto como un OK
  vacio; vuelve a invocar con la lista de issues.

Ejemplos canonicos (issue #47):

- `/mefisto-sequential 44 43 45` (43 y 45 dependen de 44) -> **lanza**: 44 va antes que sus
  dependientes, asi que ambas dependencias son de tipo (a). Se les quita `bloqueado` a #43 y #45.
- `/mefisto-sequential 43 44` (43 depende de 44) -> **aborta**: 44 esta en el batch pero
  **despues** de #43 (tipo b). Mensaje: "Mueve #44 antes de #43".
- `/mefisto-sequential 43` (43 depende de 44, que no esta en el batch y sigue OPEN) ->
  **aborta**: bloqueo real fuera del batch.

### 2. Comprobar que queda al menos un issue valido

Si despues de filtrar la lista queda vacia, responde:

```
No quedo ningun issue valido para procesar. Aborto.
```

y detente.

### 3. Mostrar resumen y lanzar

Muestra la lista de issues que se procesaran en orden:

```
Secuencial --- N issues:
  1. #42: [titulo]
  2. #60: [titulo]
  3. #44: [titulo]
```

Luego lanza el motor secuencial dentro de tmux y verifica que el launcher haya terminado con exito:

```bash
{{mefisto:run mefisto-tmux-pipeline.sh --batch <issue1> <issue2> ...}}
```

### 4. Instrucciones de conexion (solo tras lanzamiento exitoso)

Si el launcher aborta, no anuncies que el batch esta corriendo ni muestres instrucciones de
conexion. Corrige primero el error reportado y relanzalo.

Seguimiento segun runtime (MEF-ADR-0050, issue #2284): si el runtime activo tiene cinta de sesion (el mod, MEF-ADR-0055), el script corre desacoplado, sin pane ni sesion tmux, y el avance lo sigue la cinta de esta misma sesion; en el resto de runtimes el seguimiento es el pane a la derecha del pane que despacha, con logs y resumen. Un `MEFISTO_UI=tmux|herdr|mod` explicito siempre gana.

Si la salida del script dice `sin pane: lo sigue el mod mefisto-divine-wager` (modo desacoplado, MEF-ADR-0055: lo eligio el runtime activo o un `MEFISTO_UI=mod` explicito), no hay pane ni sesion que adjuntar. Responde con:

```
Batch secuencial mefisto corriendo sin pane: lo sigue el monitor de esta sesion.
Los issues se procesaran en orden: pipeline -> PR -> merge -> sync verificado -> siguiente.
Para frenarlo sin violencia: /mefisto-batch-stop (termina el eslabon en curso y aplaza el resto).
```

Dentro de herdr (`HERDR_ENV=1` en el entorno), el script delega en la interfaz herdr (`mefisto-herdr-pipeline.sh`) y no hay nada que adjuntar: el batch queda corriendo en un pane de este mismo workspace con el visor en vivo, que salta solo de issue en issue. En ese caso responde con:

```
Batch secuencial mefisto corriendo en un pane de este workspace (visor en vivo del agente).
Los issues se procesaran en orden: pipeline -> PR -> merge -> sync verificado -> siguiente.
Para frenarlo sin violencia: /mefisto-batch-stop (termina el eslabon en curso y aplaza el resto).
```

Fuera de herdr responde con:

```
Batch secuencial mefisto lanzado en tmux. Para monitorear:
  tmux -CC attach -t mefisto-batch-<timestamp>

Los issues se procesaran en orden: pipeline -> PR -> merge -> sync verificado -> siguiente.
Para frenarlo sin violencia: /mefisto-batch-stop (termina el eslabon en curso y aplaza el resto).
```

### 5. Sincronizacion verificada entre eslabones (fail-loud)

El motor (`mefisto-batch-pipeline.sh`) procesa los issues en orden
`pipeline -> PR -> merge -> sync -> siguiente`. Para que una cadena con dependencias
funcione (ej. #44 depende de #43), cada eslabon debe construirse sobre el merge del
anterior. El batch lo garantiza asi:

- **La base real de cada eslabon es `origin/main`.** El worktree del tooling-pipeline se
  crea **siempre** desde `origin/main` actualizado, sea cual sea la rama activa del repo
   principal (issue #66, `mefisto-tooling-pipeline.sh:269`). Ese invariante no depende de
   en que rama estes.
- **Los ejecutables tambien quedan fijados.** Antes de cada eslabon, el batch crea un
  worktree detached temporal en el SHA de `origin/main` que acaba de verificar y ejecuta
  desde esa raiz el pipeline, prompts, librerias y runner. Writer y reviewer usan el mismo
  snapshot; tras el merge/sync verificado, el siguiente eslabon crea uno nuevo. Estado,
  logs, senal de parada y mapping local de modelos siguen en el checkout lanzador (issue
  #1107). Si no puede crear el snapshot, aborta antes de iniciar el issue y lo limpia al
  cerrar el batch, sin tocar HEAD ni cambios locales del checkout principal.
- **Prevalidacion sincronica de la rama base.** Antes de crear, reutilizar o despachar un
  pane, el launcher del batch aplica el mismo gate que conserva el motor como defensa. Si
  estas fuera de main/master con el arbol **limpio**, se recupera a `main` (o `master` si
  `main` no existe) y ejecuta `git pull --ff-only`. Si hay cambios staged, modificados o
  sin trackear, aborta sin stash, reset ni switch forzado: conserva el trabajo y requiere
  resolucion humana antes de relanzar. La razon es higienica, no de correccion: el batch
  tambien mantiene la base **local** al dia entre eslabones.
- **Sync verificado tras cada merge.** Despues de mergear el PR de un eslabon, el motor
  hace `git fetch origin main` y **confirma** que el commit de merge del PR llego a
  `origin/main`; aparte, fast-forwardea main **local** a `origin/main` operando sobre esa
  rama **por nombre**, nunca sobre el `HEAD` del momento (issue #566).
- **Fail-loud donde importa.** Si el commit de merge no se confirma en `origin/main` y aun
  quedan issues por procesar, el motor **aborta la cadena**: el siguiente worktree naceria
  de una base desactualizada. Solo en el ultimo eslabon (sin un siguiente que dependa de
  el) degrada a warning.
- **Un main local atrasado ya no mata la cadena.** Si el merge si esta en `origin/main` y
  lo unico que fallo fue dejar main **local** sincronizado -- tipicamente porque otra
  sesion cambio la rama activa del repo principal mientras el batch corria, una carrera
  real que `/mefisto-plan` y `/mefisto-bitacora` disparan de rutina --, el motor degrada a
  warning, nombra la rama que encontro y **continua**: el siguiente worktree nace igual de
  `origin/main`, que ya esta al dia. El batch termina en exito y te recuerda al cierre
  ponerte al dia con `git switch main && git pull --ff-only` (issue #566).

Esto reemplaza el viejo `git pull origin main` best-effort, que silenciaba el fallo con
un warning `(continuando)` y dejaba que la cadena siguiera sobre un main potencialmente
atrasado; a diferencia de aquel, el esquema actual distingue cual paso del sync es critico
para la cadena y cual solo es comodidad para el humano.

### 6. Parada suave de la cadena (issue #966)

Una cadena larga no hace falta matarla a mano. `/mefisto-batch-stop` escribe la senal
`.mefisto/pipeline/batch-stop`, que el motor consulta **despues del sync verificado de cada
eslabon** -- el unico punto seguro de la cadena: ahi el PR del eslabon en curso ya esta
mergeado y `origin/main` ya lo incluye. El eslabon en curso se completa entero (pipeline,
PR, merge, sync) y los restantes quedan `aplazado` en el resumen final, con la linea lista
para relanzarlos en el mismo orden. No es un fallo: el exit code es 0 y no dispara
`--stop-on-error`. La senal se consume al detenerse, asi que no afecta la corrida siguiente.

### 7. Salto por dependencia no satisfecha (issue #2478)

El paso 1.5 valida las dependencias una sola vez, antes de arrancar, y da por satisfecha toda
dependencia que esta antes en el batch. Si ese eslabon falla y el batch sigue, el motor
revisa `## Dependencias` del issue **antes de cada eslabon** (sin leer ni mutar el label
`bloqueado`). Una dependencia esta satisfecha si quedo `completado` en este batch o esta
`CLOSED` (issue) / `MERGED` (PR) en GitHub. Si no, el eslabon no se lanza (ni snapshot ni
pipeline) y queda `saltado: depende de #N (<motivo>)`, con motivo `fallido en este batch`,
el estado de GitHub (`OPEN`) o `no consultable`. El salto cuenta en `Fallidos` pero no
marca el batch como fallido ni dispara `--stop-on-error`; la cascada sale sola y los
independientes siguen. El resumen colorea `saltado` en amarillo y cierra con
`Relanza tras resolver sus dependencias: /mefisto-sequential <nums>`.

## Reglas

- **No esperes a que termine.** El script corre en background dentro de tmux. Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo valida y delega al wrapper tmux.
- En Mefisto siempre se usa el pipeline de tooling. No expongas `--pipeline tdd|tooling` ni aceptes ese flag.
- Si tmux no esta instalado, el wrapper lo detecta y aborta.
- **Si el cwd no es Mefisto, aborta**. Los skills publicados (`/sequential`) son para el consumidor.
