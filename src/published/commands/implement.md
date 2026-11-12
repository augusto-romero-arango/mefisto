---
{
  "kind": "command",
  "id": "implement",
  "description": "Lanza el pipeline TDD del consumidor para un issue de GitHub.",
  "profile": "fast",
  "arguments": "<issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]"
}
---

{{mefisto:assert-consumer-repo}}

Lanza el pipeline TDD para un issue de GitHub. Comunicate en **espanol**.

**Alcance**: este comando solo lanza trabajo TDD del proyecto consumidor. No cambia el plugin Mefisto. Si la causa pertenece a Mefisto, crea o enruta un draft en su repositorio y detiene esta ejecucion.

## Entrada

El numero de issue y los flags estan en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, no contiene un token compuesto solo por digitos, incluye un flag sin valor o presenta argumentos mal formados, muestra el motivo y responde con este uso accionable: `Uso: /mefisto:implement <numero-de-issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]`.

Extrae `ISSUE_NUM` como el primer token numerico de `$ARGUMENTS`. Reenvia `$ARGUMENTS` intacto al wrapper: el parser definitivo y la validacion de formato pertenecen al wrapper y al pipeline, sin mantener una segunda gramatica shell aqui.

`--models` acepta un mapa opaco para los stages TDD; no alteres sus valores ni publiques aliases de proveedor. Un stage omitido conserva su default.

`--variant <label>` recibe un slug de minusculas, digitos y guiones (`[a-z0-9-]`, maximo 40 caracteres). Conserva el aislamiento mediante el sufijo `-<label>` en worktree, rama, logs y pane o sesion. Una variante no hace push, no abre PR ni muta el issue (comentarios, labels o transiciones); deja la rama local para compararla. No intentes validar otra vez estas gramaticas: reenvia ambos flags intactos.

## Proceso

### 1. Validar el issue y su tipo

Consulta el issue con `gh issue view ISSUE_NUM --json number,title,state,labels,body`. Muestra titulo, estado y labels. Si no es consultable, no existe o esta cerrado (`CLOSED`), informa el motivo y detente.

Cuenta todos los labels `tipo:*` y exige exactamente uno, que debe ser `tipo:feature`, `tipo:refactor` o `tipo:projection`. Si el unico tipo es `tipo:tooling`, informa que debe lanzarse con {{mefisto:command tooling}} y detente. Si falta el tipo, hay mas de uno o el unico tipo no es compatible, muestra los labels detectados y detente.

### 2. Validar Definition of Ready

Lee la seccion `Validacion en \`/implement\`` de `{{mefisto:package-root}}/docs/adr/mef-adr-0011-definition-of-ready.md`. Aplica todos los criterios vigentes que enumera esa seccion usando los labels y body ya consultados; no memorices una cantidad fija ni dupliques su doctrina aqui. Acumula todos los fallos antes de reportarlos.

Si uno o mas criterios fallan, muestra la lista completa de lo que falta, sugiere `planner refinar` para completarlos y detente. Si todos pasan, continua.

### 3. Verificar label bloqueado

Si lleva el label `bloqueado`, lee solo la seccion `## Dependencias` del body, hasta el siguiente encabezado de nivel dos, y considera exclusivamente lineas completas que sigan el patron canonico `Depende de #N` o `Bloqueado por #N`, con un marcador de lista `-` o `*` opcional. Ignora cualquier otro `#N`, incluidas las lineas `Bloquea #N` y las referencias informativas.

Para cada numero, consulta primero titulo y estado con `gh pr view`. Solo si GitHub confirma que el numero no corresponde a un PR, consulta `gh issue view`; cualquier otro fallo de la consulta del PR es no consultable y bloquea. Si no hay una dependencia canonica consultable, o una dependencia esta `OPEN` o no es consultable, conserva el label, muestra el bloqueo visible y detente; nunca supongas que un fallo significa cierre.

Solo cuando todas las dependencias canonicas declaradas cerraron (`CLOSED`) o se integraron (`MERGED`), retira el label `bloqueado` y continua. Con `--variant`, nunca mutas labels: informa que el label permanece y continua solo si todas las dependencias cerraron.

### 4. Detectar dominio(s) y necesidad de scaffold

Obtiene todos los labels `dom:*` del issue y `namespacePrefix` desde `{{mefisto:config-path}}`. Si la configuracion no es consultable o `namespacePrefix` falta o esta vacio, informa el error y detente. Conserva `namespacePrefix` literalmente; para cada label convierte solo el nombre del dominio de kebab-case a PascalCase y comprueba `src/<namespacePrefix>.{DominioPascalCase}/`.

La necesidad de scaffold se deriva solo del alcance declarado: lee la seccion cuyo encabezado empieza con `## Impacto`, hasta el siguiente encabezado de nivel dos. Si esa seccion no existe o no menciona `src/<namespacePrefix>.{DominioPascalCase}/`, no preguntes por ese dominio. Si la menciona y el directorio no existe, es candidato a scaffold.

Si no hay candidatos, continua al lanzamiento sin scaffold. Para cada candidato, explica que el scaffold se hara dentro del worktree del issue y que el mismo PR incluira:

- Function App: `src/<namespacePrefix>.{DominioPascalCase}/`.
- Tests: `tests/<namespacePrefix>.{DominioPascalCase}.Tests/`.
- Terraform: `infra/environments/dev/dominio-{dominio-kebab}.tf` (storage + Function App).
- Workflow: `.github/workflows/deploy-{dominio-kebab}.yml`.

Luego pregunta exactamente estas tres opciones:

1. Scaffoldear el dominio antes de lanzar el pipeline.
2. Continuar sin scaffold y dejar que Stage 1 falle de forma visible si realmente necesita el directorio.
3. Abortar sin lanzar el pipeline.

La opcion 3 detiene la ejecucion. La opcion 2 no agrega scaffold.

Si mas de un dominio recibe opcion 1, no lances el pipeline: informa que solo se admite un scaffold por invocacion, pide scaffoldear los adicionales por separado y volver a ejecutar el comando. Nunca autorices mas de un scaffold por invocacion.

### 5. Lanzar

Muestra la informacion validada del issue. Sin scaffold confirmado ejecuta exactamente:

```bash
{{mefisto:run launch-pipeline.mts $ARGUMENTS}}
```

Con un unico scaffold confirmado, ejecuta la forma equivalente agregando el dominio kebab-case confirmado:

```bash
{{mefisto:run launch-pipeline.mts $ARGUMENTS --scaffold-domain <dominio-kebab-confirmado>}}
```

En ambas rutas reenvia los argumentos intactos y deja al wrapper la validacion definitiva. Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre pane: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr, informa que el pipeline queda corriendo en un pane de este workspace con el visor en vivo. Fuera de Herdr tambien corre desacoplado, sin consola que lo siga (la salida del wrapper dice `sin pane` sin nombrar la consola): entrega la ruta del log y la linea de `stream-watch.mts` que imprime el wrapper para abrir el visor en otra terminal.

## Reglas

- **No esperes a que termine.** Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo valida y lanza el wrapper.
- **Nunca crees un dominio sin confirmacion explicita.** El scaffold implica infraestructura del consumidor.
- `MEFISTO_UI` admite `mod` (desacoplado) y `herdr` (panes, solo dentro de Herdr); con cualquier otro valor el wrapper aborta y muestra el error.
