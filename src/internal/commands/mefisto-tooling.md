---
{
  "kind": "command",
  "id": "mefisto-tooling",
  "description": "Lanza el pipeline INTERNO de tooling para un issue del repo de Mefisto.",
  "profile": "fast",
  "arguments": "<numero-de-issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]"
}
---

Lanza el pipeline INTERNO de tooling para un issue del repo de Mefisto. Comunicate en **espanol**.

**Alcance**: este skill solo opera dentro del repo del propio plugin Mefisto. Modifica archivos del harness (skills, agentes, scripts, hooks, ADRs, metadata del plugin). NO toca codigo de aplicacion ni archivos del consumidor.

## Entrada

El numero de issue esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto-tooling <numero-de-issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]`

`$ARGUMENTS` puede incluir opcionalmente el flag `--models 'agente=modelo[,agente=modelo...]'` (issue #709, experimentos A/B de desempeno del harness): asigna el modelo de un stage puntual del pipeline mefisto-tooling. La clave es el nombre de agente que recibe `runAgent` en `mefisto-tooling-pipeline.mts`: hoy `reviewer` (Stage 2) y `writer` -- que cubre **dos** stages, el Stage 1 y la etapa de merge, porque ambos invocan `run_agent` con ese mismo nombre. Un stage sin entrada en el mapa usa su default de siempre. Escribe el mapa **sin espacios** alrededor de las comas ni de los `=`: `$ARGUMENTS` se reenvia sin comillas en el paso 3, y un espacio lo partiria en dos argumentos. Ejemplo: `/mefisto-tooling 42 --models reviewer=<modelo>,writer=<modelo>` -- la forma del mapping local esta en `src/runtime/contract/models.example.json`; los ids concretos pertenecen al adaptador de cada runtime.

`$ARGUMENTS` tambien puede incluir opcionalmente el flag `--variant <label>` (issue #711, segunda pieza del mecanismo de experimentos: correr el MISMO issue N veces en paralelo para comparar calidad/velocidad/costo). `<label>` es un slug de minusculas, digitos y guiones (`[a-z0-9-]`, hasta 40 caracteres); un label invalido aborta el pipeline antes de crear el worktree. En modo variante, worktree/rama/nombres de log llevan el sufijo `-<label>` (dos corridas simultaneas del mismo issue sin este sufijo colisionarian), y el pipeline **no hace push, no abre PR y no muta el issue** (ni comentarios, ni labels, ni transiciones) -- la rama queda local, y el resumen final explica como promoverla a mano si esa variante gana la comparacion. Se combina con `--models` para comparar modelo por variante (una variante sin `--models` es la corrida de control). Ejemplo de dos variantes paralelas:

```
/mefisto-tooling 42 --variant a --models writer=<modelo-a>
/mefisto-tooling 42 --variant b --models writer=<modelo-b>
```

El timeout de watchdog por stage (`--timeout` de `mefisto-run-agent.mts`) es configurable con la variable de entorno `MEFISTO_AGENT_TIMEOUT_SECONDS` (default 1800; entero > 0, issue #946), util para issues con stages legitimamente largos.

Extrae `ISSUE_NUM` como el primer token numerico de `$ARGUMENTS` y usalo en los pasos 1, 2 y 2.5 de abajo (esos `gh issue view`/`gh issue edit` no entienden `--models` ni `--variant`; sin ninguno de los dos, `ISSUE_NUM` es simplemente `$ARGUMENTS` completo). `$ARGUMENTS` completo, con `--models`/`--variant` incluidos si vinieron, se reenvia intacto a `mefisto-launch-pipeline.mts --tooling` en el paso 3.

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Si trabajas en un proyecto consumidor, usa /tooling en su lugar."
    exit 1
}
```

### 1. Validar el issue

```bash
gh issue view $ISSUE_NUM --json number,title,state,labels -q '"#\(.number): \(.title) [\(.state)] labels: \([.labels[].name] | join(", "))"'
```

Si el issue no existe o esta cerrado (`CLOSED`), informa y detente.

### 2. Validar que es una tarea de tooling

Extrae labels del issue:

```bash
gh issue view $ISSUE_NUM --json labels -q '[.labels[].name] | join(",")'
```

Verifica que tenga el label `tipo:tooling`. Si no lo tiene, advierte al usuario:

```
Este issue no tiene el label tipo:tooling.
Mefisto solo procesa issues de tooling con este pipeline.
Continuar de todos modos? (s/n)
```

### 2.5. Verificar label bloqueado

Si el issue tiene el label `bloqueado`, lee la seccion `## Dependencias` del body y extrae todos los numeros de issue/PR referenciados (patron `#NNN`).

Para cada referencia, consulta su estado:

```bash
gh issue view <num> --json state -q '.state'
gh pr view <num> --json state -q '.state'
```

- Si **todas** las dependencias estan cerradas (`CLOSED`) o mergeadas (`MERGED`): quita el label y continua:

```bash
gh issue edit $ISSUE_NUM --remove-label "bloqueado"
```

- Si **alguna** dependencia sigue abierta: muestra cuales y **detente**:

```
El issue #$ISSUE_NUM esta bloqueado. Dependencias abiertas:
  - #42: [titulo] (OPEN)

Resuelve estas dependencias antes de lanzar el pipeline.
```

**Excepcion en modo variante**: si `$ARGUMENTS` trae `--variant`, **NO** ejecutes ese `gh issue edit`. Una corrida de variante no muta el issue -- ni comentarios, ni labels, ni transiciones: solo produce una rama local para comparar. Informa que el label `bloqueado` queda puesto (lo quitara la corrida normal que abra el PR) y sigue al paso 3.

### 3. Mostrar info y lanzar

Muestra una linea con el issue:

```
#18: Refactorizar pipeline tooling para soportar X
Tipo: tooling | Estado: listo | Repo: mefisto
```

Luego lanza el pipeline interno:

```bash
{{mefisto:run mefisto-launch-pipeline.mts --tooling $ARGUMENTS}}
```

### 4. Instrucciones de seguimiento

Seguimiento segun runtime (MEF-ADR-0050, issue #2284): si el runtime activo tiene cinta de sesion (el mod, MEF-ADR-0055), el script corre desacoplado, sin pane, y el avance lo sigue la cinta de esta misma sesion; en el resto de runtimes, dentro de herdr, el seguimiento es el pane a la derecha del pane que despacha, con logs y resumen. Un `MEFISTO_UI=herdr|mod` explicito siempre gana; cualquier otro valor aborta el lanzamiento.

Si la salida del script dice `corriendo en el pane` (interfaz herdr, `mefisto-herdr-pipeline.mts`), el pipeline queda corriendo en un pane de este mismo workspace con el visor en vivo del agente. En ese caso responde con:

```
Pipeline mefisto-tooling corriendo en un pane de este workspace (visor en vivo del agente).
```

Si la salida del script dice `sin pane: lo sigue el mod mefisto-divine-wager` (modo desacoplado, MEF-ADR-0055: lo eligio el runtime activo o un `MEFISTO_UI=mod` explicito), no hay pane. Responde con:

```
Pipeline mefisto-tooling corriendo sin pane: lo sigue el monitor de esta sesion.
La linea sobre el prompt muestra el avance; al terminar, 1 mergea, 2 abre el PR, 3 abre el monitor, 4 lo cierra.
Sin el monitor, el visor se abre en otra terminal: node src/internal/scripts/mefisto-stream-watch.mts --issues <numero>
```

Si vino `--variant <label>`, el titulo del pane en herdr lleva la variante (`mefisto-tooling #<numero> (<label>)`).

## Reglas

- **No esperes a que termine.** El script corre en background (desacoplado o en un pane herdr). Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo lanza el script.
- **Si el cwd no es Mefisto, aborta**. Los skills publicados (`/tooling`) son para el consumidor.
