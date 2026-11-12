---
{
  "kind": "command",
  "id": "parallel",
  "description": "Lanza pipelines en paralelo para multiples issues, sin panes en Claude Code o cada uno en su propio pane.",
  "profile": "fast",
  "arguments": "<issue1> <issue2> ... [--pipeline tdd|tooling]"
}
---

{{mefisto:assert-consumer-repo}}

Lanza pipelines en paralelo para multiples issues. Con el runtime que trae su propia cinta de seguimiento (consola `fausto-blood-pact`) y sin la interfaz fijada, corren sin panes y se siguen desde esta sesion; en el resto, dentro de Herdr cada issue corre en su propio pane apilado en el workspace actual y fuera de Herdr corren sin panes, con el visor en otra terminal (MEF-ADR-0055 decision 6). Los PRs se crean pero NO se mergean automaticamente. Comunicate en **espanol**.

**Grupos homogeneos**: todos los issues del grupo deben pertenecer al repo activo. El script subyacente (`parallel-pipeline.mts`) consulta cada issue con `gh issue view N` sin `-R`, asi que issues de otros repos se descartan automaticamente como UNKNOWN. No uses flags `-R` con este comando.

## Entrada

Los numeros de issues estan en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:parallel <issue1> <issue2> <issue3> ... [--pipeline tdd|tooling]`

## Proceso

### 1. Validar los issues

Para cada numero en los argumentos (excluyendo flags como `--pipeline`):

```bash
gh issue view <num> --json number,title,state,labels -q '"#\(.number): \(.title) [\(.state)] [\(.labels | map(.name) | join(", "))]"'
```

Si algun issue no existe o esta cerrado, informalo y excluyelo de la lista. Si no queda ningun issue valido, detente.

### 2. Mostrar resumen y lanzar

Muestra la lista de issues que se procesaran:

```
Paralelo — 3 issues:
  #42: Implementar calculo de horas extras nocturnas
  #43: Agregar validacion de jornada maxima
  #44: Calcular recargos dominicales
```

Si el grupo trae mas de un issue `tipo:projection`, avisa desde este resumen que {{mefisto:command sequential}} es el camino natural para un lote de puras proyecciones.

Luego lanza, pasando `--pipeline` si el usuario lo proporciono:

```bash
{{mefisto:run launch-pipeline.mts --parallel $ARGUMENTS}}
```

Cada pipeline conserva sus logs por issue en `{{mefisto:state-path logs}}`; el visor en vivo consume `{{mefisto:state-path events.log}}`.

### 3. Instrucciones de seguimiento

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre panes: delega en `parallel-pipeline.mts` desacoplado (escalonado de 30s entre issues, `tipo:projection` serializados) y la corrida se sigue en la banda de la consola `fausto-blood-pact` de esta sesion; el report queda en `{{mefisto:state-path logs}}/parallel-run-<timestamp>.report.log`. Lo reconoces porque la salida del wrapper dice `sin pane: lo sigue la consola de Fausto`. En ese caso responde con:

```
Pipeline paralelo corriendo sin panes: lo sigues en la banda de fausto-blood-pact.
Los PRs NO se mergean automaticamente.
```

En el resto de los runtimes (MEF-ADR-0050), o con la interfaz fijada por el usuario:

Dentro de Herdr (`HERDR_ENV=1` en el entorno), el wrapper delega en la interfaz Herdr: cada issue queda corriendo en su propio pane apilado de este workspace, con el visor en vivo de su agente y arranques escalonados de 30s. En ese caso responde con:

```
Pipeline paralelo corriendo: un pane apilado por issue en este workspace.
Los PRs NO se mergean automaticamente.
```

Fuera de Herdr el wrapper tambien delega en `parallel-pipeline.mts` desacoplado, sin consola que lo siga: su salida dice `sin pane` sin nombrar la consola, e imprime la ruta del report y la linea del visor. En ese caso responde con:

```
Pipeline paralelo corriendo sin panes. Para monitorear, en otra terminal:
  <linea de stream-watch.mts que imprimio el wrapper>
Los PRs NO se mergean automaticamente.
```

## Reglas

- **No esperes a que termine.** Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo lanza el wrapper.
- Los PRs creados no se mergean. Recuerdale al usuario que puede usar {{mefisto:command merge}} despues.
- Si el usuario pasa `--pipeline tdd|tooling`, pasalo tal cual al wrapper.
- **Issues `tipo:projection`: nunca deben correr dos a la vez.** Todas las proyecciones del BC comparten los archivos del worker de proyecciones (MEF-ADR-0034). En el modo pane (Herdr) un lote con dos o mas aborta con mensaje, antes de crear panes; en el modo sin panes no aborta porque el scheduler los serializa. Para el modo pane: el camino es {{mefisto:command sequential}}, o `node {{mefisto:package-root}}/scripts/parallel-pipeline.mts` directo (su scheduler si los serializa dentro del lote sin frenar al resto).
- `--max-parallel N`: en el modo sin panes, pasalo tal cual al wrapper (llega a `parallel-pipeline.mts`) y {{mefisto:command batch-stop}} detiene la cola. En el modo pane, lanza `node {{mefisto:package-root}}/scripts/parallel-pipeline.mts` directo para limitar la concurrencia: el modo pane lanza todos los issues de entrada y no tiene cola que retener.
