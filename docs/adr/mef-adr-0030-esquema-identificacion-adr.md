# MEF-ADR-0030: Esquema de identificacion de ADRs con prefijo por proyecto

- **Fecha**: 2026-07-19
- **Estado**: aceptado
- **Aplica a**: identificacion (ID, nombre de archivo, citas en prosa) de todos los ADRs del marco (`docs/adr/`); guia de adopcion opcional para los ADRs del proyecto consumidor.

## Contexto

Existen dos juegos de ADRs que conviven en un mismo ecosistema de trabajo: los del marco (viven en el plugin Mefisto, `docs/adr/`) y los del proyecto consumidor (`docs/adr/` del consumidor, doctrina especifica de su dominio o configuracion). Antes de este ADR, ambos juegos se numeraban igual, sin prefijo: `ADR-0001`, `ADR-0002`, etc.

Esa numeracion identica colisiona: `ADR-0006` es "Convenciones de nombramiento para funciones Azure" en el marco, pero puede ser un tema completamente distinto en el ADR-0006 de un consumidor concreto. Un agente que cita "ADR-0006" en prosa, sin desambiguar de cual juego habla, produce una referencia ambigua -- degrada a los ADRs como fuente unica de verdad, porque el lector (humano o agente) no puede resolver la cita sin contexto adicional.

El harness ya resolvia parcialmente el problema **por ruta**: `agents/planner.md` (seccion "Localizar los ADRs del marco") resuelve los ADRs del marco desde `$PLUGIN_ROOT`, nunca por ruta relativa, y `agents/reviewer.md` advierte explicitamente contra usar `docs/adr/...` relativo (que resolveria contra el repo equivocado si `cwd` es el consumidor). Lo que faltaba era un **esquema de identificacion** inequivoco tambien en prosa: un ID que por si mismo declare a que juego de ADRs pertenece, sin depender de que quien lo lea sepa resolver la ruta.

## Decision

### 1. Prefijo corto de proyecto + `-ADR-` + numero de 4 digitos

El ID de un ADR pasa a ser `<codigo-corto-de-proyecto>-ADR-NNNN`. El codigo corto es un identificador breve (2-4 letras, memorable) que declara a que juego de ADRs pertenece el documento.

### 2. El marco (Mefisto) usa el prefijo `MEF-`

Todos los ADRs de este repo se identifican como `MEF-ADR-NNNN`. Este mismo documento es el primero en usarlo end-to-end: `MEF-ADR-0030`.

### 3. Mefisto migra la totalidad de su juego existente

Los 27 ADRs previos (`ADR-0001`..`ADR-0027`) pasan a `MEF-ADR-0001`..`MEF-ADR-0027`, sin excepciones y en una sola migracion (issue #322):

- **Archivo**: `docs/adr/NNNN-slug.md` -> `docs/adr/mef-adr-NNNN-slug.md`. El prefijo va en minuscula en el nombre de archivo, para respetar la convencion de nombres de archivo ya vigente en el repo (kebab-case).
- **ID canonico**: en el titulo del documento, en el indice tematico de `CLAUDE.md` y en toda cita en prosa (propia o cruzada entre ADRs), el ID va en mayuscula: `MEF-ADR-NNNN`.
- Los ADRs nuevos que se creen de aqui en adelante (`MEF-ADR-0028`, `MEF-ADR-0029`, ...) nacen ya con el prefijo; no hay periodo de transicion con IDs sin prefijar.

### 4. Adopcion opcional para el proyecto consumidor

Un consumidor **no esta obligado** a migrar sus propios ADRs a este esquema. Dos caminos validos, ambos sin conflicto con el marco:

- **Adoptar un prefijo propio**: el proyecto elige su propio codigo corto (p. ej. `CA-ADR-` para Control de Asistencias, `CPC-ADR-` para Cosmos ControlPlane) y lo aplica a sus propios ADRs, con la misma convencion de archivo/ID que fija este ADR.
- **Quedarse sin prefijo**: un consumidor con ADRs legados puede seguir citandolos como `ADR-XXXX` a secas. El prefijo del marco (`MEF-ADR-`) ya alcanza para desambiguar en cualquier conversacion donde participen ambos juegos, porque `ADR-XXXX` (sin prefijo) nunca coincide textualmente con `MEF-ADR-XXXX`.

El arreglo del indice tematico de un consumidor concreto (si decide adoptar su propio prefijo) es tarea del lado consumidor; este ADR solo fija el esquema y su caracter opt-in, no ejecuta la migracion por el consumidor.

## Alternativas consideradas

### Alt 1: rangos numericos reservados por proyecto

Asignar un rango de numeros exclusivo a cada proyecto (p. ej. `0001-0999` para el marco, `1000-1999` para el primer consumidor, etc.) en vez de un prefijo textual.

**Descartada**: exige coordinacion centralizada de rangos entre todos los consumidores presentes y futuros -- no escala a un numero desconocido de proyectos, y el numero por si solo sigue sin declarar el proyecto al leerlo aislado (hay que memorizar la tabla de rangos). Un prefijo textual es autocontenido: el ID mismo dice a que proyecto pertenece.

### Alt 2: mover los ADRs del consumidor a una ruta distinta (`docs/adr-proyecto/`) en vez de prefijo

El harness ya tiene una convencion de guard que menciona una ruta alterna para ADRs del consumidor (`scripts/lib/pipeline/consumer-scope.mts`); se considero apoyarse solo en la ruta para desambiguar, sin tocar el ID.

**Descartada**: resuelve la colision de archivos en disco, pero no la colision en **prosa** -- un agente que cita "ADR-0006" en una respuesta sigue sin declarar de cual juego habla, que es el sintoma que origino este ADR. El prefijo resuelve ambos ejes (archivo y prosa) con un solo cambio; la ruta por si sola solo resuelve uno.

### Alt 3: migracion obligatoria para todo consumidor existente

Forzar a todo consumidor a renombrar sus ADRs con su propio prefijo en el mismo ciclo que este ADR.

**Descartada**: rompe referencias vigentes en consumidores ya en produccion sin beneficio inmediato para ellos, y exige coordinacion cross-repo que el marco no puede imponer unilateralmente. El opt-in (decision #4) logra el mismo desambiguado donde importa (evitar colision `ADR-NNNN` marco vs consumidor) sin costo obligatorio para quien no lo necesita.

## Consecuencias

### Positivas

- **Cita inequivoca en prosa**: `MEF-ADR-0006` y el `ADR-0006` (o `CA-ADR-0006`) de un consumidor nunca coinciden textualmente, incluso citados fuera de contexto.
- **Sin coordinacion centralizada de numeros**: cada proyecto numera su propio juego desde `0001` de forma independiente; el prefijo, no el numero, es lo que desambigua.
- **No rompe legados**: un consumidor que no migre sigue funcionando exactamente igual (`ADR-XXXX` a secas); el esquema nuevo solo desambigua contra el marco, no exige nada del lado consumidor.
- **Consistente con el trabajo por ruta ya existente**: complementa (no reemplaza) la resolucion via `$PLUGIN_ROOT` de `agents/planner.md` y la advertencia de `agents/reviewer.md` contra rutas relativas.

### Negativas

- **Costo unico de migracion**: 27 archivos renombrados y del orden de mil ocurrencias de `ADR-NNNN` actualizadas en un solo PR (issue #322) -- una migracion grande que no pasa la revision de complejidad estandar de un turno de pipeline; el usuario acepto el trade-off a conciencia para no fragmentar el esquema de identificacion a mitad de camino.
- **Divergencia de convencion visible**: a partir de ahora, el filename usa prefijo en minuscula (`mef-adr-0001-...md`) mientras el ID canonico en prosa usa mayuscula (`MEF-ADR-0001`) -- una asimetria deliberada (decision #3) que hay que recordar al crear un ADR nuevo.
- **Adopcion opcional deja heterogeneidad entre consumidores**: unos citaran `ADR-XXXX`, otros `<PREFIJO>-ADR-XXXX` -- aceptado porque el objetivo de este ADR es desambiguar contra el marco, no unificar la convencion de todos los consumidores entre si.

## Referencias

- issue #322: origen de este ADR y de la migracion completa del juego de ADRs del marco al esquema `MEF-ADR-`.
- issue #318 y #319: coordinacion de numeracion -- ambos crean, en paralelo, `MEF-ADR-0028` y `MEF-ADR-0029` ya prefijados siguiendo este esquema; este ADR no los renombra.
- MEF-ADR-0007 (gestion de proyecto con GitHub Issues): antecedente del sistema de gestion documental del marco sobre el que este ADR desambigua identificacion.
- `agents/planner.md`, seccion "Localizar los ADRs del marco": resolucion de rutas de ADR del marco via `$PLUGIN_ROOT`, complementaria a este esquema.
- `agents/reviewer.md`: advertencia contra abrir ADRs del marco por ruta relativa `docs/adr/...`.

## Control de cambios

- 2026-07-19: creacion como `aceptado` (issue #322). Fija el esquema de identificacion de ADRs con prefijo por proyecto (`MEF-ADR-` para el marco) y la migracion completa de los 27 ADRs previos del marco a ese esquema.
- 2026-11-12: la alternativa 2 cita `scripts/lib/pipeline/consumer-scope.mts` en lugar de `scripts/_pipeline-common.sh`, que se borra con el port a TypeScript (MEF-ADR-0057). Sin cambio de doctrina.
