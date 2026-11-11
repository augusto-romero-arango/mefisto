---
description: "Escribe la senal de parada suave del batch interno de Mefisto: termina el eslabon en curso (pipeline, PR, merge, sync verificado) y no arranca los siguientes."
model: "haiku"
---
<!-- GENERADO por src/internal/scripts/generate-internal-adapters.sh desde src/internal/commands/mefisto-batch-stop.md. No editar a mano. -->

Escribe la senal de parada suave del batch interno de Mefisto. Comunicate en **espanol**.

**Alcance**: este skill solo opera dentro del repo del propio plugin Mefisto.

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    exit 1
}
```

### 1. Detectar si hay un batch corriendo

Criterio elegido (el mas simple de los disponibles): el proceso real del motor,
`mefisto-batch-pipeline.sh`. El log activo no sirve aqui: un archivo de log en
`.mefisto/pipeline/logs/` no distingue por si solo una corrida activa de una ya
terminada sin volver a parsear su contenido.

```bash
pgrep -f "[m]efisto-batch-pipeline\.sh" >/dev/null 2>&1
```

Dos detalles del patron, ambos deliberados:

- `[m]efisto` en vez de `mefisto`: el patron viaja en la linea de comandos del
  propio shell que corre este `pgrep`, y `pgrep -f` la mira igual que cualquier
  otra. Con la clase de un solo caracter, el texto literal del patron
  (`[m]efisto...`) ya no encaja con la expresion, asi que la deteccion no puede
  auto-cumplirse: sin batch corriendo, el exit es 1.
- El criterio es **por maquina**, no por checkout: si el batch corre en otro
  clon de Mefisto, aqui tambien da positivo y la senal se escribe en ESTE
  repo, donde nadie la va a consumir hasta la proxima corrida local (que se
  detendra de entrada, con todos sus issues `aplazado`, y la consumira). Es el
  precio de no inventar estado nuevo; invoca este comando desde el checkout
  donde lanzaste el batch.

- Si **no** hay ningun proceso: responde y detente sin escribir nada:
  ```
  No hay ningun batch interno corriendo ahora mismo. No se escribio ninguna senal.
  ```
- Si **si** hay uno: continua al paso 2.

### 2. Escribir la senal

```bash
mkdir -p "$REPO_ROOT/.mefisto/pipeline"
touch "$REPO_ROOT/.mefisto/pipeline/batch-stop"
```

### 3. Confirmar

Responde:

```
Senal de parada escrita. El batch terminara el eslabon en curso (pipeline -> PR -> merge -> sync verificado) y no arrancara los siguientes: quedaran "aplazado" en el resumen final, con la linea lista para relanzarlos en el mismo orden.
```

## Reglas

- No pidas confirmacion adicional: el usuario ya la dio al escribir `/mefisto-batch-stop` explicitamente.
- No mates ningun proceso ni pane: la senal es cooperativa, el propio motor la consulta.
- No la escribas si no detectaste ningun batch corriendo (paso 1): dejarla puesta sin necesidad envenenaria la proxima corrida.
- La senal se autoconsume: el propio motor la borra al detenerse. Este comando nunca la borra por su cuenta.
