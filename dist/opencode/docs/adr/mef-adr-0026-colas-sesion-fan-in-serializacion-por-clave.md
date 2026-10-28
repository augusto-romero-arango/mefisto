# MEF-ADR-0026: Colas de Service Bus con sesion para fan-in y serializacion por clave de agregado

- **Fecha**: 2026-07-15
- **Estado**: aceptado
- **Aplica a**: doctrina de mensajeria del marco; complementa MEF-ADR-0001 (no lo reemplaza) con la primitiva de fan-in; cross-referencia MEF-ADR-0001, MEF-ADR-0006, MEF-ADR-0023 y MEF-ADR-0024 (el `groupId` de `IPrivateEventSender` como mecanismo del `SessionId`); referencia ademas MEF-ADR-0004 (manejo de errores). Gobierno futuro de `infra-base-scaffolder`/`infra-writer`/`infra-reviewer` (issue #270) e `implementer`/`domain-scaffolder` (issues #271, #272).

## Contexto

MEF-ADR-0001 modela un topic de Service Bus por tipo de evento: la topologia es **fan-out** por diseno — un evento publicado puede tener N subscriptions independientes, cada una con su propio cursor de lectura. Esa topologia asume que cada subscription reacciona de forma aislada, sin estado compartido con las demas.

Esa asuncion se rompe cuando varios eventos — del mismo tipo o de tipos distintos, del mismo productor o de productores distintos — deben converger en una **decision sobre el mismo aggregate** (el caso tipico de una saga o process manager). Si cada subscription tiene su propia Function procesando en paralelo, dos o mas instancias pueden intentar escribir sobre el mismo stream de Marten al mismo tiempo. Marten usa concurrencia optimista (version del stream); la segunda escritura concurrente lanza una excepcion de conflicto de version que hoy no tiene a donde ir: no es una regla de negocio violada (MEF-ADR-0004 la modelaria como evento de fallo), es un choque de infraestructura entre dos ejecuciones concurrentes del mismo handler. El resultado tipico es un dead-letter ciego — el mensaje muere en la subscription sin que nada en el dominio explique por que.

El harness no tenia, hasta ahora, una primitiva para esto. La solucion idiomatica de Azure Service Bus combina dos mecanismos que ya existen en la plataforma pero que el marco nunca habia enseñado a los agentes:

- **Auto-forwarding**: encadena una subscription (o queue) a otra entidad del mismo namespace [1].
- **Message sessions**: agrupa mensajes relacionados bajo un `SessionId` y garantiza entrega serializada dentro de esa sesion [2]. Azure Functions expone esto nativamente en el trigger de Service Bus via `IsSessionsEnabled` [4].

Lo que faltaba no era el mecanismo (documentado en la plataforma) sino la **doctrina**: cuando un agente debe decidir topic simple (fan-out, MEF-ADR-0001) vs queue con sesion (fan-in), y por que — no solo como cablear cada uno.

## Decision

### 1. Fan-out (topic) sigue siendo el default; fan-in (queue con sesion) es la excepcion deliberada

MEF-ADR-0001 no cambia: todo evento se publica a un topic por tipo de evento, y esa sigue siendo la topologia por defecto. **Topic vs queue nunca es una decision del productor** — el productor siempre publica a topics (MEF-ADR-0001, MEF-ADR-0023); el queue con sesion, cuando aplica, es una construccion exclusivamente del **lado consumidor**, downstream del topic via auto-forward.

La excepcion aplica cuando se cumplen **ambas** condiciones:

1. Varios eventos (mismo tipo o tipos distintos, mismo productor o productores distintos) deben converger en una decision sobre el **mismo aggregate**.
2. Consumirlos con subscriptions independientes permitiria que dos o mas ejecuciones concurrentes escriban sobre el mismo stream de Marten al mismo tiempo (la clase de error que describe la seccion "Contexto").

Si solo se cumple la condicion 1 pero no la 2 (eventos que convergen en una decision, pero sin escritura concurrente sobre el mismo stream — por ejemplo, una agregacion de solo lectura), el topic + subscription simple de MEF-ADR-0001 sigue siendo suficiente. La excepcion de este ADR es para **serializar escritura concurrente por clave de aggregate**, no un patron general de "varios eventos, una Function".

### 2. Topologia: subscriptions sin sesion, forward a un unico queue con sesion

```
Topic-evento-A --> Subscription-A (sin sesion) --forward--> Queue-fan-in (requires_session = true)
Topic-evento-B --> Subscription-B (sin sesion) --forward--/
```

- Las subscriptions **fuente** del forward **nunca** llevan sesion habilitada. Es una restriccion dura de la plataforma: una entidad con sesion habilitada no puede ser fuente de auto-forward — Service Bus rechaza configurar `ForwardTo` sobre una entidad session-enabled [1].
- El queue **destino** es el unico que declara `requires_session = true`.
- El `SessionId` lo fija el **productor**, al publicar, como el `groupId` de `IPrivateEventSender` (MEF-ADR-0024): a nivel de protocolo AMQP ese `groupId` viaja como la propiedad `group-id`, que Service Bus expone como `SessionId` [6]. El valor debe ser la clave del aggregate destino. Un mensaje forwardeado **conserva su `SessionId`** a traves de la cadena [1].
- Un mensaje **sin** `SessionId` que llega a un destino con sesion habilitada se dead-lettera en la entidad **fuente** (no en el destino): la entidad session-enabled solo acepta mensajes con `SessionId` [1]. Esto hace el `groupId` una invariante dura del productor cuando el destino final es un queue con sesion (issue #272 la documenta en la guia del productor).
- El queue de fan-in vive en el **namespace interno del BC** (MEF-ADR-0023), como cualquier entidad de consumo privada. No hay cambio a la topologia de namespaces: el queue es una entidad mas dentro del namespace que ya existe.
- Varias subscriptions (una por topic de origen) pueden forward al **mismo** queue de fan-in — es justamente el mecanismo de convergencia.

### 3. Consumo: Function en modo sesion

El consumidor es una Azure Function con `[ServiceBusTrigger("<queue>", Connection=..., IsSessionsEnabled = true)]` sobre el queue (no sobre una subscription). El runtime de Functions procesa las sesiones en paralelo entre si, pero **serialmente dentro de cada sesion** — `maxConcurrentSessions` (default 8 en el modelo isolated worker con la extension `Microsoft.Azure.Functions.Worker.Extensions.ServiceBus` 5.x) [5] acota cuantas sesiones distintas se procesan a la vez, sin romper el orden garantizado dentro de cada una. Esa serializacion por sesion es lo que elimina la escritura concurrente sobre el mismo stream de Marten: dos mensajes con el mismo `SessionId` (misma clave de aggregate) nunca se procesan al mismo tiempo, sin importar cuantos topics de origen convergieron en el queue.

El detalle de scaffolding de este endpoint (trigger de queue en modo sesion, `switch` por `message.Subject` cuando convergen varios tipos de evento) es trabajo del issue #271; este ADR fija la doctrina, no el codigo generado.

### 4. Invariante de naming: el queue kebab-case es el nombre de la Function que lo consume, con desviacion documentada de MEF-ADR-0006

MEF-ADR-0006 nombra las Functions de Service Bus con el patron `{Accion}Cuando{Evento}` porque asume un **estimulo unico** — el nombre debe decir a que evento reacciona. Ese patron no aplica a una Function de fan-in: no hay un unico estimulo, convergen N eventos (potencialmente de N tipos) sobre la misma decision. Exigir `{Accion}Cuando{Evento}` aqui obligaria a elegir arbitrariamente uno de los N eventos convergentes, lo cual es enganoso — sugeriria que la Function solo reacciona a ese evento.

La convencion para Functions de fan-in es distinta y mas simple: **el nombre del queue en kebab-case es el nombre de la Function que lo consume**, y ese nombre describe la **decision o convergencia** que la Function resuelve (no un evento puntual). Ejemplo: un queue `consolidar-cierre-turno` lo consume una Function `ConsolidarCierreTurno`. Las subscriptions que hacen forward hacia ese queue siguen, sin cambio, el naming de MEF-ADR-0001 (`{consumidor}-escucha-{productor}`) — la desviacion aplica solo al nombre de la Function de fan-in, no a las subscriptions fuente.

### 5. Efecto sobre el manejo de errores (MEF-ADR-0004)

La serializacion por sesion **elimina una clase de error**: la carrera de concurrencia optimista de Marten entre ejecuciones paralelas del mismo handler sobre el mismo stream, que el reintento del bus (abandono hasta `max_delivery_count`) solo mitiga como red de seguridad, sin serializar. No cambia la doctrina de MEF-ADR-0004 sobre eventos de fallo vs excepciones: las reglas de negocio del aggregate se siguen modelando con eventos de fallo, nunca excepciones (MEF-ADR-0004, capa 3). Lo que este ADR resuelve es un fallo de **infraestructura de concurrencia**, no una regla de negocio — la clase de error que MEF-ADR-0004 encuadra en su capa 5 ("fallos de infraestructura"), no en la capa 3.

## Alternativas consideradas

### Alt 1: filtro SQL a una subscription unica, sin queue

Usar una unica subscription (sin forward) con un filtro SQL amplio que capture todos los eventos relevantes al aggregate.

**Descartada**: una subscription no serializa nada — sigue permitiendo que Azure Functions escale el consumo de esa subscription en paralelo. El problema no es "cuantas subscriptions" sino "cuantas ejecuciones concurrentes sobre el mismo stream", y eso solo lo resuelve el modo sesion.

### Alt 2: lock pesimista a nivel de aggregate (advisory lock de Postgres u otro mecanismo externo)

Serializar en la capa de aplicacion con un lock explicito sobre la clave del aggregate antes de escribir en Marten.

**Descartada (deferida)**: introduce una dependencia de infraestructura adicional (el mecanismo de lock) fuera de Azure Service Bus, y compite con una capacidad que la plataforma de mensajeria ya resuelve de forma nativa y gratuita para el modelo serverless (el trigger de Functions ya bloquea la sesion mientras la ejecucion esta en curso). No hay caso hoy que justifique el costo operativo adicional.

### Alt 3: forward directo sin sesion, con "reintento hasta que gane" en el handler

Dejar el forward simple (sin sesion) y que el handler capture la excepcion de concurrencia de Marten y reintente hasta que su escritura sea la que prevalece.

**Descartada**: el reintento en el handler no serializa el orden de llegada — dos ejecuciones concurrentes siguen compitiendo, y el resultado final depende de una carrera no determinista en vez de reflejar el orden real de los eventos. La sesion resuelve esto en el transporte, antes de que el handler siquiera se ejecute.

## Consecuencias

### Positivas

- **Complementa sin reemplazar**: MEF-ADR-0001 (fan-out por default) y MEF-ADR-0023 (namespace interno del BC) quedan intactos; el queue con sesion es una entidad de consumo mas dentro de la topologia ya existente.
- **Elimina una clase de error real**: la carrera de concurrencia optimista de Marten entre ejecuciones paralelas deja de ser posible quirurgicamente — la garantiza el transporte, no un workaround de aplicacion.
- **Mecanismo nativo, sin dependencias nuevas**: sesiones de Service Bus y `IsSessionsEnabled` en el trigger de Functions son capacidades de plataforma ya soportadas [1][2][4][5]; no se agrega infraestructura fuera de Azure Service Bus.
- **Doctrina de decision, no solo mecanismo**: los agentes tienen ahora un criterio de dos condiciones (seccion "Decision" #1) para elegir topic simple vs queue con sesion, en vez de aplicar el patron de fan-in por costumbre o por instinto.

### Negativas

- **Nueva excepcion a MEF-ADR-0006**: el naming de Functions de fan-in se desvia del patron `{Accion}Cuando{Evento}`, lo que exige que los agentes reconozcan explicitamente cuando aplica una convencion u otra.
- **Nueva superficie de fallo a monitorear**: `SessionLockLost` — si el procesamiento dentro de una sesion tarda mas que el lock y este no se renueva a tiempo, el receptor debe volver a aceptar la sesion [3]. No es un caso nuevo de la doctrina de MEF-ADR-0004 (sigue siendo capa 5, fallo de infraestructura), pero es una superficie a vigilar en operacion.
- **Trabajo diferido en tres frentes**: este ADR fija la doctrina; la generacion de infraestructura (queue + forward en Terraform), el scaffolding del endpoint consumidor y la documentacion de la invariante `groupId` en la guia del productor quedan en issues separados (ver "Trabajo diferido").

### Trabajo diferido

- **Infraestructura** (issue #270): extender el modulo `service-bus` de `infra-base-scaffolder` (y `infra-writer`/`infra-reviewer`) para declarar queues con `requires_session` y subscriptions con `forward_to`, validando la restriccion de la seccion "Decision" #2 (fuente sin sesion, destino con sesion).
- **Endpoint consumidor** (issue #271): scaffolding del trigger de queue en modo sesion (`IsSessionsEnabled = true`) y el `switch` por `message.Subject` cuando convergen varios tipos de evento en el mismo queue.
- **Guia del productor** (issue #272): documentar en `agents/implementer.md` la invariante dura "`requires_session` en el destino implica `groupId` en el productor", incluyendo el caso de un mensaje sin `groupId` que se dead-lettera en la fuente.

## Referencias

- **[1]** "Chaining Service Bus entities with autoforwarding" — Microsoft Learn. Restriccion verificada: "A session-enabled queue or subscription can't be the source of autoforwarding [...] Autoforwarding into a session-enabled destination is supported [...] A forwarded message keeps its session ID [...] A forwarded message that has no session ID is dead-lettered on the source entity". https://learn.microsoft.com/azure/service-bus-messaging/service-bus-auto-forwarding#autoforwarding-considerations
- **[2]** "Message sessions" — Microsoft Learn. El `SessionId` lo fija el emisor; a nivel de protocolo AMQP 1.0 mapea a la propiedad `group-id`. https://learn.microsoft.com/azure/service-bus-messaging/message-sessions
- **[3]** "Service Bus messaging exceptions (.NET)" — Microsoft Learn. `SessionLockLost`: el lock de la sesion expira si el procesamiento tarda mas que la duracion del lock sin renovarse; el receptor debe volver a aceptar la sesion. https://learn.microsoft.com/azure/service-bus-messaging/service-bus-messaging-exceptions-latest#servicebusexception
- **[4]** "Azure Service Bus trigger for Azure Functions (C#)" — Microsoft Learn. Propiedad `IsSessionsEnabled` del trigger: `true` si se conecta a un queue o subscription session-aware. https://learn.microsoft.com/azure/azure-functions/functions-bindings-service-bus-trigger#attributes
- **[5]** "Azure Service Bus bindings for Azure Functions" — Microsoft Learn. `maxConcurrentSessions` en `host.json`: numero maximo de sesiones que se procesan concurrentemente por instancia escalada; el orden dentro de cada sesion se preserva. Default `8` en el modelo isolated worker con la extension 5.x (el valor `2000` es el default del modelo legacy in-process/Functions 2.x, tab "Functions 2.x+"). https://learn.microsoft.com/azure/azure-functions/functions-bindings-service-bus?pivots=programming-language-csharp#hostjson-settings
- **[6]** "AMQP 1.0 in Azure Service Bus and Event Hubs protocol guide" — Microsoft Learn. Tabla de mapeo AMQP: `group-id` -> API `SessionId`. https://learn.microsoft.com/azure/service-bus-messaging/service-bus-amqp-protocol-guide#basic-amqp-scenarios
- MEF-ADR-0001 (Service Bus: un topic por tipo de evento): MEF-ADR-0026 no reemplaza el fan-out por default; anade la primitiva de fan-in como excepcion deliberada, consumida exclusivamente del lado consumidor.
- MEF-ADR-0004 (manejo de errores en event sourcing): MEF-ADR-0026 elimina una clase de error de la capa 5 (fallos de infraestructura) de MEF-ADR-0004 — la carrera de concurrencia optimista de Marten — sin alterar la doctrina de eventos de fallo vs excepciones de sus capas 2-4.
- MEF-ADR-0006 (convenciones de nombramiento de Functions Azure): MEF-ADR-0026 documenta una excepcion al patron `{Accion}Cuando{Evento}` para Functions de fan-in, con la invariante "queue kebab-case = nombre de la Function".
- MEF-ADR-0023 (Bounded Context, namespace interno de ASB): el queue de fan-in vive en el namespace interno del BC, sin cambio a la doctrina de namespaces.
- MEF-ADR-0024 (modelo de eventos de bus, privado/publico): el `groupId` de `IPrivateEventSender` es el mecanismo por el que el productor fija el `SessionId` que la sesion del queue destino exige.

## Control de cambios

- 2026-07-15: creacion como `aceptado` (issue #269, draft cross-repo del consumidor `Cosmos-SincoERP/Cosmos.ControlPlane`, @luisfelipediaz). Fija la doctrina fundacional de colas de Service Bus con sesion para fan-in y serializacion por clave de aggregate. Es el issue fundacional de un epico de 4: bloquea a los issues #270 (infraestructura), #271 (endpoint consumidor) y #272 (invariante `groupId` en la guia del productor).
- 2026-07-15: correccion factual (revision del issue #271): el default de `maxConcurrentSessions` en el modelo isolated worker con la extension `Microsoft.Azure.Functions.Worker.Extensions.ServiceBus` 5.x es `8`, no `2000` (ese es el default del modelo legacy in-process/Functions 2.x); verificado contra la tab "Extension 5.x+" de la doc oficial de host.json settings (referencia [5]). Sin cambio a la doctrina de la seccion "Decision".
- 2026-10-28: enmienda (issue #2470). La seccion 5 deja de afirmar el "dead-letter ciego" de la carrera de concurrencia: el fallo del handler se abandona y el bus lo reintenta (MEF-ADR-0004 capa 5). La Alt 3 sigue vigente: el reintento es red de seguridad, no el mecanismo de serializacion. `ServiceBusSessionEndpointBase` reemplaza `DespacharPorSubject` por `Interpretar`.
