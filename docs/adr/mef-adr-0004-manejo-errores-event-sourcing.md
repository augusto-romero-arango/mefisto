# MEF-ADR-0004: Manejo de errores en event sourcing - eventos de fallo vs excepciones

## Estado

Aceptado

## Contexto

En un sistema event-driven con event sourcing, los errores pueden ocurrir en multiples
capas: validacion de entrada, precondiciones de orquestacion, reglas de negocio del
aggregate, y fallos de infraestructura. Cada capa tiene diferentes necesidades de
retroalimentacion y diferentes consumidores del error.

Adicionalmente, el sistema tiene dos tiempos distintos. El procesamiento primario que el
cliente solicita puede completar durante la invocacion HTTP: el endpoint espera
`ICommandRouter.InvokeAsync(comando)` y el `UnitOfWorkMiddleware` hace el append y
`SaveChangesAsync` antes de que el router retorne. Las proyecciones `Async` de Marten y
los efectos que cruzan Service Bus son posteriores y eventuales; no vuelven asincrono el
commit durable del write-side. Los handlers que reaccionan a eventos de ServiceBus tienen
consumidores downstream que esperan una respuesta (de exito o de fallo) para continuar sus
propios flujos.

La decision de como manejar errores en cada capa impacta el diseno de aggregates, handlers,
tests y la comunicacion entre dominios.

## Decision

### Principio general

El tipo de trigger (HTTP o ServiceBus) determina el mecanismo de error. El aggregate
nunca lanza excepciones para logica de negocio — emite eventos de fallo.

### Capa por capa

**1. Validacion de entrada (endpoint HTTP)**

Responsabilidad del `IRequestValidator`. Retorna 400 BadRequest si el body esta vacio,
malformado o no cumple las reglas de FluentValidation. No es excepcional, es esperado.

**2. Precondiciones de orquestacion (CommandHandler)**

El handler verifica precondiciones segun la intencion del comando. Cuando la precondicion no
se cumple y el trigger es HTTP, lanza una excepcion **tipada de precondicion** —
scaffoldeada en el consumidor, nunca la `InvalidOperationException` generica de .NET, que
esta doctrina reserva exclusivamente a los fallos de infraestructura de la seccion 5:

- `PrecondicionComandoException` (`abstract`): base comun. El endpoint HTTP solo conoce esta
  clase (ver "Respuestas HTTP").
- `RecursoYaExisteException` (deriva de la base): el handler la lanza cuando el stream que el
  comando pretende crear ya existe.
- `RecursoNoEncontradoException` (deriva de la base): el handler la lanza cuando el stream que
  el comando pretende modificar no existe.

El mensaje de la excepcion sigue el patron `.resx` per-handler de MEF-ADR-0009 sin cambios:
`throw new RecursoYaExisteException(Mensajes.TurnoYaExiste)`.

Por tipo de comando:

- **Crear (stream nuevo)**: verifica que el aggregate no exista. Si ya existe:
  - HTTP → lanza `RecursoYaExisteException` (feedback inmediato al cliente, ver "Respuestas HTTP")
  - ServiceBus → retorna silenciosamente (idempotencia)
- **Modificar (stream existente)**: verifica que el aggregate exista. Si no existe:
  - HTTP → lanza `RecursoNoEncontradoException`
  - ServiceBus → emite evento de fallo (alguien downstream espera respuesta)
- **Upsert**: maneja ambos casos sin error (idempotencia natural)

#### Estado ya alcanzado: no-op exitoso

Cuando la identidad y el alcance que requiere el comando existen, y la intencion del comando
ya esta satisfecha en el estado vigente, la operacion es un **no-op exitoso**. No es una
precondicion ausente ni una regla de negocio violada: simplemente no hay un hecho nuevo que
registrar. El aggregate retorna normalmente **antes** de agregar eventos a
`_uncommittedEvents`; el handler termina normalmente y no persiste ni publica nada nuevo. El
endpoint retorna el codigo de exito contractual del comando, incluido el que corresponda a
PUT o DELETE.

"Ya ausente" solo es un no-op si el contrato reconoce la identidad o el alcance y puede saber
que la intencion ya se cumple. Una identidad nunca conocida o un stream padre inexistente no
califican: conservan la precondicion explicita de recurso no encontrado.

| Situacion | Tratamiento |
|---|---|
| Cambio necesario | Aplica la doctrina vigente y emite el hecho correspondiente. |
| Estado ya alcanzado (identidad/alcance existente + intencion satisfecha) | Exito contractual sin excepcion, evento persistido ni publicacion nueva. |
| Identidad o stream requerido inexistente | Tratamiento `404 NotFound` vigente para HTTP; evento de fallo para ServiceBus cuando corresponda. |
| POST de creacion sobre stream existente | Tratamiento `409 Conflict` vigente para HTTP; retorno silencioso para ServiceBus. |
| Regla de negocio real | Evento de fallo vigente del aggregate. |

El mecanismo canonico es el retorno normal del metodo del aggregate antes de agregar eventos,
seguido de la finalizacion normal del handler. No se exige `SinCambios`, `Result<T>` ni ningun
tipo nuevo entre aggregate, handler y endpoint. Los tests del harness validan este camino con
`Then()` o `Then(streamId)` sin eventos esperados, que exige count exacto cero, y con los
asserts vacios de publicacion, que validan que no se publico nada.

RFC 9110 define la idempotencia por la igualdad del efecto pretendido en el servidor y aclara
que las respuestas de solicitudes identicas pueden diferir (seccion 9.2.2). Sus secciones
9.3.4 (PUT) y 9.3.5 (DELETE) no imponen una respuesta unica para este caso. Elegir exito
estable para el no-op es una convencion deliberada de Mefisto, orientada a no generar ruido al
cliente; no es una obligacion del RFC.

**3. Reglas de negocio (AggregateRoot)**

El aggregate **emite eventos de fallo** en `_uncommittedEvents` cuando una regla de
negocio se viola. Nunca lanza excepciones para logica de dominio. Los eventos de fallo
se persisten en el stream del aggregate y se publican como cualquier otro evento.

Esto permite que:
- Los consumidores downstream reaccionen al fallo (compensacion, notificacion, retry)
- La historia del aggregate quede completa (auditoria)
- Los eventos compensatorios futuros no se bloqueen

**4. Metodos Apply() del aggregate**

Los metodos `Apply(TEvent)` que reconstruyen estado desde el event store **nunca lanzan
excepciones**. Si un Apply lanza una excepcion al encontrar un evento "invalido", el
aggregate queda permanentemente roto: nunca llegara al evento compensatorio que lo corrige.

**5. Fallos de infraestructura**

Excepciones naturales del runtime (red, DB, ServiceBus). El retry y dead letter de Azure
Functions los manejan automaticamente. No se capturan en el handler.

En endpoints de ServiceBus el fallo del handler se abandona (`AbandonMessageAsync`) y lo
reintenta el bus hasta `max_delivery_count`, donde la plataforma lo mueve al DLQ con razon
`MaxDeliveryCountExceeded`. El dead letter explicito queda solo para el mensaje ilegible
(cuerpo no deserializable o, en fan-in, `Subject` desconocido), con el tipo de la excepcion
como `DeadLetterReason`. El lock perdido solo registra un warning. La etapa decide la
liquidacion, no el tipo de la excepcion.

### Respuestas HTTP

El criterio de exito es decidible: **al responder, termino y quedo durable el cambio
primario que solicito el endpoint?** Si si, el endpoint devuelve el codigo de exito
sincrono que corresponde a la operacion. La materializacion posterior de una proyeccion
`Async` o la publicacion y consumo downstream por Service Bus no cambia esa respuesta: son
efectos posteriores al commit del write-side. Si no, porque el endpoint solo publico o
encolo trabajo cuyo cambio primario ocurrira despues, devuelve `202 Accepted` y documenta
explicitamente cual procesamiento queda pendiente.

| Operacion completada y durable antes de responder | Respuesta | Condicion adicional |
| --- | --- | --- |
| `POST` crea una entidad | `201 Created` | Incluye `Location` hacia la URI canonica de lectura cuando existe. Una proyeccion `Async` puede hacer que esa URI responda temporalmente `404`; los tests del read-side deben tolerar esa ventana mediante polling. |
| `PUT` reemplaza una representacion existente | `204 No Content` | Este es el caso canonico del marco: reemplazar un slot existente. |
| `PUT` crea una representacion antes inexistente | `201 Created` | RFC 9110 §9.3.4 exige informar la creacion. |
| `DELETE` ejecutado o no-op por estado ya alcanzado | `204 No Content` | El no-op exige identidad y alcance reconocidos, segun la seccion 2. |
| Accion `POST` sin representacion de respuesta | `204 No Content` | El cambio primario ya quedo durable. |
| Accion que devuelve una representacion | `200 OK` | La representacion forma parte de la respuesta. |
| Procesamiento primario diferido | `202 Accepted` | El issue justifica que trabajo queda pendiente y por que no completo antes de responder. |

El no-op de un `PUT` o `DELETE` definido en la seccion 2 devuelve el mismo codigo contractual
de la tabla que la operacion que si produjo un cambio. Que no exista un evento nuevo no lo
convierte en procesamiento diferido ni justifica responder `202 Accepted`.

Los errores y precondiciones conservan su mapeo:

- 400 BadRequest — validacion de estructura (IRequestValidator)
- 404 NotFound — el handler lanzo `RecursoNoEncontradoException`
- 409 Conflict — el handler lanzo `RecursoYaExisteException`

El endpoint captura `PrecondicionComandoException` (la base) y mapea por tipo concreto al
codigo HTTP correspondiente. **Toda otra excepcion no capturada sube** y el runtime la
traduce a `500 Internal Server Error` — incluida `InvalidOperationException`, que ya no es
un tipo que el endpoint reconozca. El mapeo es **exhaustivo sobre las derivadas que el
consumidor declara**: si agrega una derivada nueva, extiende el mapeo explicitamente en vez
de apoyarse en un codigo por defecto — una derivada que el endpoint no reconoce se relanza y
termina en `500`, nunca en un `409`/`404` adivinado.

Esta distincion es la leccion del incidente #802 (documentado en MEF-ADR-0028): el
`ProxyTenantResolver` de `Cosmos.MultiTenancy.CritterStack`, cableado en un consumidor,
resultaba inservible para HTTP en Azure Functions isolated worker y lanzaba
`InvalidOperationException` desde `WolverineMessageContextTenantResolver` — un fallo de
**infraestructura** (el resolver de tenant no podia resolver el tenant), no un dato de
negocio. Como el catch anterior atrapaba `InvalidOperationException` a secas, ese fallo de
infraestructura se traducia al mismo `409 Conflict` que una colision real de datos,
indistinguible para quien diagnostica. El mismo catch amplio agravaba un segundo defecto:
`Mensajes.TurnoNoEncontrado` lanzaba tambien `InvalidOperationException`, asi que el caso
"no encontrado" respondia `409` en vez del `404` que esta misma seccion ya prescribia. Separar la jerarquia por tipo — y
dejar que cualquier excepcion fuera de ella suba como `500` — hace que un fallo de
infraestructura nunca se disfrace de conflicto de negocio.

### No se adopta Result Pattern

No es necesario entre Handler y Endpoint porque el endpoint elige la respuesta HTTP conforme
al contrato de la operacion una vez que el router retorna; no necesita que el handler devuelva
un resultado para decidir si el cambio primario quedo durable. El `IRequestValidator` ya
resuelve la validacion con una tupla simple. Las excepciones tipadas de precondicion (seccion
2) no reabren esta decision: siguen siendo *excepciones*, no un tipo de retorno `Result<T>` —
el handler declina lanzando, el endpoint traduce por tipo en el catch; no se introduce un
canal de retorno adicional entre ambos.

### Regimen de migracion

Esta doctrina rige el codigo **nuevo**: todo command handler y endpoint que se escriba o
reescriba a partir de esta enmienda lanza/captura las excepciones tipadas de la seccion 2 y
elige el status de exito con la tabla anterior.
La regla de estado ya alcanzado aplica a todo PUT o DELETE **nuevo**. Cambiar un endpoint
preexistente —su status o su comportamiento ante un estado ya alcanzado— requiere un issue de
refactor propio con inventario de los endpoints afectados y aviso a sus clientes o consumidores
integrados antes de cambiar el contrato; nunca se migra de oficio en un PR no relacionado.
Los handlers, endpoints y tests **preexistentes** que lanzan/capturan
`InvalidOperationException` no se migran de oficio — sus suites siguen en verde porque su
codigo sigue lanzando el tipo generico, y cada consumidor decide su propio ritmo de
migracion (mismo precedente de MEF-ADR-0043 seccion 7, "Aplicabilidad: solo endpoints
nuevos").

## Consecuencias

**Positivas**

- Los aggregates son autonomos en su manejo de errores: evaluan reglas y emiten el evento
  correspondiente (exito o fallo) sin depender de capas externas.
- Los eventos de fallo viajan por los mismos canales que los de exito, habilitando
  compensacion, monitoreo y auditoria.
- Los Apply() son seguros: reconstruir un aggregate nunca falla, incluso si el stream
  contiene eventos que representan errores de negocio.
- La heuristica es clara: el tipo de trigger determina el mecanismo.
- La capa 2 declina con excepciones tipadas por resultado (`RecursoYaExisteException` /
  `RecursoNoEncontradoException`), nunca con la excepcion generica que la seccion 5 reserva a
  fallos de infraestructura — un endpoint que captura solo la base `PrecondicionComandoException`
  nunca enmascara un fallo ajeno a la precondicion como si fuera un conflicto de negocio (ver
  incidente #802 en "Respuestas HTTP").

**Negativas**

- El aggregate tiene mas responsabilidad: debe modelar explicitamente los caminos de fallo
  como eventos, lo que aumenta la cantidad de tipos de evento.
- Los tests son mas complejos: deben cubrir eventos de fallo, aggregate no encontrado, y
  aggregate ya existente, ademas del camino feliz.
- La capa 2 requiere que el consumidor scaffoldee y mantenga la jerarquia de tres tipos
  (`PrecondicionComandoException` + 2 derivadas): boilerplate pequeno pero adicional al
  patron `.resx` de MEF-ADR-0009.

## Referencias

- Oskar Dudycz — "Should you throw an exception when rebuilding state from events?"
- Szymon Kulec — "Event sourcing and failure handling"
- Andrzej Sliwa — "Event Sourced Aggregates and Error/Exception flows"
- Oskar Dudycz — "Saga and Process Manager - distributed processes in practice"
- Issue #802 / MEF-ADR-0028 (incidente Bitakora.ControlAsistencia, 2026-09-01): el
  `ProxyTenantResolver` inservible para HTTP en el worker aislado motivo la enmienda de la
  capa 2 hacia excepciones tipadas; MEF-ADR-0028 es la fuente de verdad del incidente.
- MEF-ADR-0043 seccion 7 ("Aplicabilidad: solo endpoints nuevos"): precedente del regimen de
  migracion que adopta la seccion "Regimen de migracion" de esta enmienda.
- MEF-ADR-0009 (patron de mensajes `.resx` per-aggregate): el mensaje de las excepciones
  tipadas de la capa 2 sigue su convencion sin cambio de doctrina propia.
- RFC 9110, "HTTP Semantics" — IETF: §9.2.2 define idempotencia y permite que las respuestas
  difieran; §§9.3.3 (POST), 9.3.4 (PUT) y 9.3.5 (DELETE) fijan la semantica de los metodos;
  §§15.3.1 (`200 OK`), 15.3.2 (`201 Created`), 15.3.3 (`202 Accepted`) y 15.3.5
  (`204 No Content`) fijan los codigos de exito.
  https://www.rfc-editor.org/rfc/rfc9110.html
- `Cosmos.EventSourcing.CritterStack` 2.3.1, inspeccionado por decompilacion: la invocacion
  `ICommandRouter.InvokeAsync` completa el handler y el middleware transaccional de Marten
  (append y `SaveChangesAsync`) antes de retornar al endpoint.
- Evidencia de campo,
  [Bitakora.ControlAsistencia#620](https://github.com/augusto-romero-arango/Bitakora.ControlAsistencia/issues/620)
  (2026-09-05): 29 endpoints de comando respondian `AcceptedResult` pese a confirmar la
  transaccion antes de responder; sus smoke tests consecutivos POST+POST y POST+DELETE
  observan esa durabilidad inmediata.
- MEF-ADR-0034, seccion 3: una proyeccion `Async` se materializa fuera de la transaccion del
  write-side; su consistencia eventual no cambia el commit primario.
- `docs/testing/harness-cheatsheet.md` (DSL `Then` y asserts de publicacion vacios): confirma
  que los asserts sin eventos validan exactamente la ausencia de persistencia y publicacion.
- Issue #849: fija el codigo de exito contractual que tambien retorna el no-op.
- Issue #1003: propagara esta convencion a PUT/DELETE en MEF-ADR-0043 y a sus agentes/tests.
- Regla del experto, 2026-09-05: "Es idempotente quitar algo que ya no existe y le generamos
  ruido al cliente innecesario". Descubierta al refinar
  [Bitakora.ControlAsistencia#622](https://github.com/augusto-romero-arango/Bitakora.ControlAsistencia/issues/622);
  el inventario de campo encontro exito sin evento en `AsignarSede`, `409` en
  `RetirarEtiqueta`, `RetirarCentroDeCostos` y `RetirarTurno`, y `404` en
  `RetirarDispositivo`.

## Control de cambios

- 2026-10-28: enmienda (issue #2470). La capa 5 deja de autorizar el dead letter explicito ante
  cualquier fallo en endpoints de ServiceBus: el fallo del handler se abandona y lo reintenta el
  bus hasta `max_delivery_count`; el dead letter explicito queda solo para el mensaje ilegible.
  Rige codigo nuevo, sin migracion de oficio de las bases ya scaffoldeadas.
- 2026-09-07: enmienda (issue #850). La seccion 2 clasifica estado ya alcanzado -- identidad y
  alcance existentes con la intencion ya satisfecha -- como no-op exitoso: el aggregate retorna
  antes de agregar eventos y el handler finaliza sin persistir ni publicar; el endpoint responde
  el codigo de exito contractual. Fija la frontera frente a cambio necesario, identidad/stream
  inexistente, POST de creacion sobre stream existente y regla de negocio real; no exige
  `SinCambios`, `Result<T>` ni otro protocolo de retorno. Cita RFC 9110 §§9.2.2, 9.3.4 y 9.3.5:
  el exito estable es convencion de Mefisto, no mandato del estandar. Aplica a PUT/DELETE nuevos;
  cualquier endpoint existente requiere refactor con inventario y aviso a consumidores. Origen:
  regla del experto del 2026-09-05 y divergencia descubierta en Bitakora.ControlAsistencia al
  refinar #622. Depende de #849 y bloquea #1003.
- 2026-09-07: enmienda (issue #849). Corrige el falso `202 Accepted` universal: el criterio
  de exito pregunta si el cambio primario solicitado quedo durable antes de responder, no si
  existen proyecciones `Async` o efectos posteriores por Service Bus. Agrega la tabla de
  respuestas sincronas (`201 Created` con `Location` para creacion, `204 No Content` para
  reemplazo, delete o accion sin representacion, `200 OK` para accion que la devuelve), el
  caso `PUT` que crea una representacion inexistente (`201`), y restringe `202` al
  procesamiento primario diferido con justificacion explicita. Conserva 400/404/409/500 y la
  decision de no usar `Result<T>` por su razon real. La migracion rige endpoints nuevos;
  cambiar statuses existentes exige un issue de refactor con inventario y aviso a clientes.
  Cita RFC 9110 §§9.3.3, 9.3.4, 9.3.5, 15.3.1, 15.3.2, 15.3.3 y 15.3.5, la decompilacion de
  `Cosmos.EventSourcing.CritterStack` 2.3.1 y la evidencia de campo de
  Bitakora.ControlAsistencia#620.
- 2026-09-01: enmienda (issue #805). La seccion 2 ("Precondiciones de orquestacion")
  reemplaza `InvalidOperationException` generica por la jerarquia tipada
  `PrecondicionComandoException` (base abstracta, scaffoldeada en el consumidor) con
  derivadas `RecursoYaExisteException` (409) y `RecursoNoEncontradoException` (404); la
  seccion "Respuestas HTTP" fija que el endpoint captura solo la base y mapea por tipo
  concreto, y que toda otra excepcion — incluida `InvalidOperationException` de
  infraestructura — sube como 500. Motivado por el incidente de Bitakora.ControlAsistencia
  (#802, 2026-09-01, documentado en MEF-ADR-0028): el `ProxyTenantResolver` del paquete
  `Cosmos.MultiTenancy.CritterStack` lanzaba `InvalidOperationException` desde la
  infraestructura de tenancy, y el catch amplio anterior la traducia al mismo 409 que una
  colision real de datos, alargando el diagnostico; el mismo catch respondia 409 tambien al
  caso "no encontrado" porque `Mensajes.TurnoNoEncontrado` usaba el mismo tipo generico,
  contradiciendo el 404 que esta seccion ya prescribia. Fija el regimen de migracion
  (precedente MEF-ADR-0043 seccion 7): la doctrina rige codigo nuevo, sin migracion de oficio
  de handlers/endpoints/tests preexistentes. La ubicacion de archivo de los tres tipos en el
  consumidor queda fuera de este ADR — la fija el issue dependiente #806 sobre
  `agents/implementer.md`. Ripples de una linea de ejemplo en MEF-ADR-0016 y MEF-ADR-0009,
  sin cambio de doctrina propia en ninguno de los dos.
