---
{
  "kind": "command",
  "id": "tooling",
  "description": "Lanza el pipeline de tooling del consumidor para un issue de GitHub.",
  "profile": "fast",
  "arguments": "<issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]"
}
---

{{mefisto:assert-consumer-repo}}

Lanza el pipeline de tooling para un issue de GitHub. Comunicate en **espanol**.

**Alcance**: este comando solo lanza tareas de tooling del proyecto consumidor. No implementa logica de dominio ni cambia el plugin Mefisto. Si la causa pertenece a Mefisto, crea o enruta un draft en su repositorio y detiene esta ejecucion.

## Entrada

El numero de issue y los flags estan en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, no contiene un token compuesto solo por digitos, incluye un flag sin valor o presenta argumentos mal formados, muestra el motivo y responde con este uso accionable: `Uso: /mefisto:tooling <numero-de-issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]`.

Extrae `ISSUE_NUM` como el primer token numerico de `$ARGUMENTS`. Reenvia `$ARGUMENTS` intacto al wrapper: el parser definitivo y la validacion de formato pertenecen al wrapper y al pipeline, sin mantener una segunda gramatica shell aqui.

`--models` acepta un mapa opaco para las claves de stage `writer` y `reviewer`; no alteres sus valores ni publiques aliases de proveedor. Un stage omitido conserva su default y `writer` cubre tanto escritura como merge porque ambos stages usan esa clave.

`--variant <label>` recibe un slug de minusculas, digitos y guiones (`[a-z0-9-]`, maximo 40 caracteres). Conserva el aislamiento mediante el sufijo `-<label>` en worktree, rama, logs y pane o sesion. Una variante no hace push, no abre PR ni muta el issue (comentarios, labels o transiciones); deja la rama local para compararla. No intentes validar otra vez estas gramaticas: reenvia ambos flags intactos.

## Proceso

### 1. Validar el issue

Consulta el issue con `gh issue view ISSUE_NUM --json number,title,state,labels,body`. Muestra titulo, estado y labels. Si no es consultable, no existe o esta cerrado (`CLOSED`), informa el motivo y detente.

### 2. Validar el tipo y los bloqueos

Verifica el label `tipo:tooling`. Si falta, explica que la logica de dominio se lanza con el comando de implementacion y pide confirmacion explicita antes de continuar. Si no se confirma, detente.

Si lleva el label `bloqueado`, lee solo la seccion `## Dependencias` del body, hasta el siguiente encabezado de nivel dos, y considera exclusivamente las lineas canonicas `Depende de #N` o `Bloqueado por #N` (tambien si llevan marcador de lista). Ignora cualquier otro `#N`. Si no hay una dependencia canonica consultable, conserva el label, muestra el bloqueo y detente.

Para cada numero, intenta primero `gh pr view` y, si no corresponde a un PR, `gh issue view`, consultando titulo y estado. Una dependencia `OPEN` o no consultable es un bloqueo visible: muestra su numero, titulo si pudo consultarse y estado o error de consulta, y detente; nunca supongas que un fallo significa cierre.

Solo cuando todas las dependencias canonicas declaradas cerraron (`CLOSED`) o se integraron (`MERGED`), retira el label `bloqueado` y continua. Con `--variant`, nunca mutas labels: informa que el label permanece y continua solo si todas las dependencias cerraron.

### 3. Lanzar

Muestra la informacion validada del issue y ejecuta exactamente:

```bash
{{mefisto:run launch-pipeline.mts --tooling $ARGUMENTS}}
```

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre pane: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr, informa que el pipeline queda corriendo en un pane de este workspace con el visor en vivo. Fuera de Herdr tambien corre desacoplado, sin consola que lo siga (la salida del wrapper dice `sin pane` sin nombrar la consola): entrega la ruta del log y la linea de `stream-watch.mts` que imprime el wrapper para abrir el visor en otra terminal.

## Reglas

- **No esperes a que termine.** Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo valida y lanza el wrapper.
- `MEFISTO_UI` admite `mod` (desacoplado) y `herdr` (panes, solo dentro de Herdr); con cualquier otro valor el wrapper aborta y muestra el error.
