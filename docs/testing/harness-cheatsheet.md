# Cheatsheet: `Cosmos.EventSourcing.Testing.Utilities`

Referencia rapida del harness de testing de command handlers. Todas las firmas y comportamientos de este documento se verificaron contra la fuente del package (ver "Fuentes"). Version verificada: `2.1.0` (issue #312, 2026-07-18).

> **Regla de uso**: si dudas si el harness soporta algo, **consulta este archivo antes de rumiar**. Si el archivo no cubre la duda, ve a la fuente. Ver politica anti-rumination en `agents/test-writer.md`.

---

## Fuentes canonicas

- **Package NuGet**: `Cosmos.EventSourcing.Testing.Utilities` (referenciado en los `.csproj` de `tests/`)
- **Archivos fuente** (consultar para aclarar cualquier duda):
  - `CommandHandlerTestBase.cs` - define `Given`, `When*`, `Then*`, `And<>`, propiedades heredadas
  - `CommandHandlerAsyncTest.cs` - base asincrona, expone `WhenAsync`
  - `CommandHandlerTest.cs` - base sincrona, expone `When`
  - `TestStore.cs` - fake in-memory del event store, reconstruye aggregates por reflection
  - `TestPrivateEventSender.cs`, `TestPublicEventSender.cs` - fakes de envio de eventos
- **Localizar la fuente del package en NuGet cache**:
  ```bash
  dotnet nuget locals global-packages --list
  # luego:
  ls "$(dotnet nuget locals global-packages --list | awk -F': ' '{print $2}')/cosmos.eventsourcing.testing.utilities"
  ```
  El package shipea compilado (DLL). Si necesitas leer `.cs`, busca el monorepo `Cosmos.BuildingBlocks` en local o descompila con `ilspycmd`.

---

## Clases base (heredar segun el tipo de handler)

| Clase base | Handler soportado | Metodo de ejecucion |
|---|---|---|
| `CommandHandlerAsyncTest<TCommand>` | `ICommandHandlerAsync<TCommand>` | `await WhenAsync(cmd)` |
| `CommandHandlerAsyncTest<TCommand, TResult>` | `ICommandHandlerAsync<TCommand, TResult>` | `var r = await WhenAsync(cmd)` |
| `CommandHandlerTest<TCommand>` | `ICommandHandler<TCommand>` | `When(cmd)` |
| `CommandHandlerTest<TCommand, TResult>` | `ICommandHandler<TCommand, TResult>` | `var r = When(cmd)` |

Las cuatro variantes heredan de `CommandHandlerTestBase`, asi que exponen el mismo DSL de `Given` / `Then` / `And`.

Propiedades heredadas de `CommandHandlerTestBase`:

| Miembro | Tipo | Nota |
|---|---|---|
| `GuidAggregateId` | `Guid` | UUID v7 generado por test (`CommandHandlerTestBase.cs:15`) |
| `AggregateId` | `string` | `GuidAggregateId.ToString()` - stream ID **por defecto** del DSL (`CommandHandlerTestBase.cs:20`) |
| `EventStore` | `TestStore` | Fake in-memory del event store (`CommandHandlerTestBase.cs:25`) |
| `PrivateEventSender` | `TestPrivateEventSender` | Fake de `IPrivateEventSender` (`CommandHandlerTestBase.cs:30`) |
| `PublicEventSender` | `TestPublicEventSender` | Fake de `IPublicEventSender` (`CommandHandlerTestBase.cs:35`) |

---

## DSL: firmas y comportamientos

### `Given` - pre-cargar eventos historicos

Firmas:

```csharp
protected void Given(string aggregateId, params object[] events);         // CommandHandlerTestBase.cs:40 - stream explicito (compuesto o externo)
protected void Given(params object[] events);                             // CommandHandlerTestBase.cs:48 - stream por defecto (AggregateId)
```

Comportamiento:

- Los eventos se guardan en `_previousEvents[aggregateId]` del `TestStore` (`TestStore.cs:110-111`). No pasan por `Apply`; se guardan como objetos crudos.
- Acepta eventos **de tipos distintos mezclados** en una sola llamada (es `params object[]`, no generic restringido).
- Si el aggregate tiene stream ID compuesto (calculado desde el payload), usa la variante con `aggregateId` explicito.

Ejemplos:

```csharp
// Stream por defecto (aggregate usa GuidAggregateId como Id)
Given(new TurnoCreado(GuidAggregateId, "Turno Manana", ...));

// Multiples eventos de tipos distintos, en una sola llamada
Given(
    new TurnoDiarioAsignado(GuidAggregateId, empleadoId, fecha, ...),
    new MarcacionAdicionada(GuidAggregateId, horaEntrada, TipoMarcacion.Entrada),
    new MarcacionAdicionada(GuidAggregateId, horaSalida, TipoMarcacion.Salida));

// Stream explicito (aggregate con identidad compuesta)
var streamId = $"{empleadoId}:{fecha:yyyy-MM-dd}";
Given(streamId, new ControlDiarioAbierto(empleadoId, fecha, ...));
```

### `When` / `WhenAsync` - ejecutar el comando

Firmas:

```csharp
// Sincrono: CommandHandlerTest.cs:17 y :35
protected void When(TCommand command);
protected TResult When(TCommand command);                                 // variante con resultado

// Asincrono: CommandHandlerAsyncTest.cs:17 y :36
protected Task WhenAsync(TCommand command);
protected Task<TResult> WhenAsync(TCommand command);                      // variante con resultado
```

Comportamiento:

- Ambos invocan el handler y luego llaman `EventStore.SaveChanges()`, que mueve los `UncommittedEvents` de cada `AggregateRoot` a `_newEvents` y limpia la lista de aggregates cargados (`TestStore.cs:39-48`).
- `WhenAsync` propaga `TestContext.Current.CancellationToken` al handler (`CommandHandlerAsyncTest.cs:19`). No necesitas pasarlo.
- El test debe sobrescribir `protected abstract ... Handler { get; }` inyectando las fakes (`EventStore`, `PrivateEventSender`, `PublicEventSender`).

### `Then` - verificar eventos emitidos al stream

Cuatro overloads:

```csharp
// CommandHandlerTestBase.cs:58 - stream por defecto, opciones por defecto
protected void Then(params object[] expectedEvents);

// CommandHandlerTestBase.cs:66 - stream por defecto, opciones personalizadas
protected void Then(
    Func<EquivalencyOptions<object>, EquivalencyOptions<object>> options,
    params object[] expectedEvents);

// CommandHandlerTestBase.cs:76 - stream explicito, opciones por defecto (IDIOMATICO para composite ids)
protected void Then(string aggregateId, params object[] expectedEvents);

// CommandHandlerTestBase.cs:87 - stream explicito, opciones personalizadas
protected void Then(
    string aggregateId,
    Func<EquivalencyOptions<object>, EquivalencyOptions<object>> options,
    params object[] expectedEvents);
```

Comportamiento (`CommandHandlerTestBase.cs:92-112`):

- Lee `EventStore.GetNewEvents(aggregateId)` y verifica **count exacto**: `newEvents.Count.Should().Be(expectedEvents.Length);` (`CommandHandlerTestBase.cs:94`).
- Para cada evento, valida tipo exacto (`BeOfType`) y equivalencia estructural (`BeEquivalentTo`).
- Tolera eventos vacios (records sin propiedades): atrapa `InvalidOperationException` con mensaje "No members were found for comparison." y la ignora (`CommandHandlerTestBase.cs:103-110`).
- El orden de `expectedEvents` **si importa** (compara por indice).

Ejemplos:

```csharp
// Un evento, stream por defecto
Then(new MarcacionRegistrada(GuidAggregateId, fechaHora, TipoMarcacion.Entrada));

// Varios eventos en una sola llamada (count exacto, orden exacto)
Then(
    new MarcacionRegistrada(GuidAggregateId, fecha1, TipoMarcacion.Entrada),
    new MarcacionRegistrada(GuidAggregateId, fecha2, TipoMarcacion.Salida));

// Stream explicito (composite id) - IDIOMATICO: overload de dos argumentos
Then(streamId, new ControlDiarioCerrado(empleadoId, fecha, ...));

// Con opciones personalizadas (ignorar campos, tolerar precision de tiempo, etc.)
Then(
    opt => opt.Excluding(e => ((dynamic)e).Timestamp),
    new EventoConTimestamp(GuidAggregateId, ...));

// Stream explicito + opciones personalizadas (los dos a la vez)
Then(streamId,
    opt => opt.Excluding(e => ((dynamic)e).Timestamp),
    new EventoConTimestamp(...));
```

### `ThenIsPublishedPrivately` - verificar publicacion privada

Firmas (verificadas decompilando `Cosmos.EventSourcing.Testing.Utilities.dll` 2.1.0 con `ilspycmd` -- el package solo shipea binario, sin `.cs` publico ni PDB con lineas de fuente):

```csharp
public void ThenIsPublishedPrivately(params IPrivateEvent[] expectedEvents);
public void ThenIsPublishedPrivately(PublishOptions expectedOptions, params IPrivateEvent[] expectedEvents);
```

**Cambio de firma en 2.0.0 (issue #312):** hasta `1.3.0` la segunda variante era `ThenIsPublishedPrivately(string groupId, ...)` y consultaba `PrivateEventSender.GetEventsByGroupId(groupId)`. Desde `2.0.0` recibe un `PublishOptions expectedOptions` (record con `GroupId` y `Headers`, de `Cosmos.EventDriven.Abstractions`) y verifica contra la propiedad `PrivateEventSender.PublishedWithOptions` -- una lista de tuplas `(PublishOptions Options, IReadOnlyList<IPrivateEvent> Events)`. El assert exige `PublishedWithOptions.Count == 1` ("se espera exactamente una publicación con opciones de sobre") y compara `expectedOptions.GroupId`/`Headers` exactos ademas de los eventos -- si tu handler llama `PublishAsync(options, ...)` mas de una vez con opciones distintas, este assert falla. La variante sin argumentos sigue usando `PrivateEventSender.Events` globales, sin cambios.

### `ThenIsPublishedPublicly` - verificar publicacion publica

Firmas (verificadas decompilando `Cosmos.EventSourcing.Testing.Utilities.dll` 2.1.0 con `ilspycmd`):

```csharp
public void ThenIsPublishedPublicly(params IPublicEvent[] expectedEvents);
public void ThenIsPublishedPublicly(PublishOptions expectedOptions, params IPublicEvent[] expectedEvents);
```

Mismo cambio de firma que `ThenIsPublishedPrivately` (ver arriba): `string groupId` (hasta 1.3.0) -> `PublishOptions expectedOptions` (desde 2.0.0), verificado contra `PublicEventSender.PublishedWithOptions`.

Ambas familias (`ThenIsPublishedPrivately`/`ThenIsPublishedPublicly`) delegan en `AssertEvents` (`CommandHandlerTestBase.cs:142-173`), que tiene **dos comportamientos distintos segun el count de `expectedEvents`**:

| Count de `expectedEvents` | Comportamiento | Linea |
|---|---|---|
| `== 1` | **Subset check**: busca el primer evento de ese tipo en la lista publicada, verifica equivalencia. NO valida que sea el unico publicado. | `CommandHandlerTestBase.cs:146-153` |
| `>= 2` | **Count exacto + orden exacto**: valida `newEvents.Count == expectedEvents.Length` y recorre por indice. | `CommandHandlerTestBase.cs:155-172` |

Esta asimetria **no es un error** - esta diseñada para que tests unicos permitan coexistencia de otros eventos publicados, pero que tests multi-evento verifiquen la sinfonia completa. En la practica: **si tu handler publica N eventos, tu aserciom debe listar los N**, no solo el que te interesa.

Ejemplos:

```csharp
// Subset check (un solo evento esperado)
ThenIsPublishedPublicly(new PagoProcesado(pagoId, monto));

// Count + orden exactos (dos o mas eventos esperados)
ThenIsPublishedPublicly(
    new TurnoDiarioProgramado(..., fecha1, ...),
    new TurnoDiarioProgramado(..., fecha2, ...),
    new ProgramacionSolicitudCerrada(solicitudId));

// Verificar que NADA se publico privadamente (expected vacio → count debe ser 0)
ThenIsPublishedPrivately();
```

> **Gotcha historica**: llamar `ThenIsPublishedPublicly` dos veces seguidas (una por evento) **no es equivalente** a una sola llamada con ambos. La primera pasa (subset con 1), la segunda tambien pasa (subset con 1), y el test dice verde aunque falte la validacion de count total. Por eso el test-writer exige "una sola llamada con todos los eventos".

### `And<TAggregateRoot, TResult>` - verificar estado del aggregate reconstruido

Firmas (`CommandHandlerTestBase.cs:184,201`):

```csharp
// Stream por defecto
public void And<TAggregateRoot, TResult>(
    Func<TAggregateRoot, TResult> contextFunc,
    TResult expectedValue,
    Func<EquivalencyOptions<TResult>, EquivalencyOptions<TResult>>? options = null)
    where TAggregateRoot : AggregateRoot, new();

// Stream explicito
public void And<TAggregateRoot, TResult>(
    string aggregateId,
    Func<TAggregateRoot, TResult> contextFunc,
    TResult expectedValue,
    Func<EquivalencyOptions<TResult>, EquivalencyOptions<TResult>>? options = null)
    where TAggregateRoot : AggregateRoot, new();
```

Comportamiento (`CommandHandlerTestBase.cs:200-210`):

- Reconstruye el aggregate via `TestStore.GetAggregateRoot<T>(aggregateId)` (`TestStore.cs:116-133`): crea instancia con `Activator.CreateInstance(nonPublic: true)` y aplica todos los eventos (`_previousEvents` + `_newEvents`) via reflection sobre metodos `Apply(TEvento)`.
- Invoca el selector `contextFunc(aggregate)` y compara con `expectedValue` usando `BeEquivalentTo`.
- `BeEquivalentTo` compara listas elemento a elemento y records por equality estructural - sirve para colecciones, VOs complejos, o propiedades simples.
- Si el aggregate no existe (ningun evento pre-cargado o emitido), lanza `ArgumentNullException` (`CommandHandlerTestBase.cs:207`).

Ejemplos:

```csharp
// Propiedad simple
And<EmpleadoAggregateRoot, string>(e => e.Nombre, "Luis Augusto");

// Propiedad de coleccion (count)
And<TurnoAggregateRoot, int>(t => t.Marcaciones.Count, 2);

// Lista completa (compara elemento a elemento, records por equality)
And<TurnoAggregateRoot, List<Marcacion>>(
    t => t.Marcaciones.ToList(),
    new List<Marcacion> {
        new(hora1, TipoMarcacion.Entrada),
        new(hora2, TipoMarcacion.Salida)
    });

// Value object
And<ContratoAggregateRoot, TipoContrato>(c => c.Tipo, TipoContrato.IndefinidoTiempoCompleto);

// Nullable
And<SolicitudAggregateRoot, DateTime?>(s => s.FechaAprobacion, null);

// Stream explicito (composite id)
And<ControlDiarioAggregateRoot, string>(streamId, c => c.Id, streamId);
And<ControlDiarioAggregateRoot, DateOnly>(streamId, c => c.Fecha, fecha);

// Con opciones de equivalencia (ignorar un campo)
And<TurnoAggregateRoot, Turno>(
    t => t.Snapshot(),
    expected,
    opt => opt.Excluding(x => x.FechaActualizacion));
```

---

## Capacidades del `TestStore` relevantes para tests

- **`ExistsAsync<T>(streamId)` retorna `true` con solo eventos pre-cargados via `Given`** (`TestStore.cs:61-64`). No hace falta llamar `GetAggregateRootAsync` primero. Basta que `_newEvents[id]` o `_previousEvents[id]` tenga al menos un evento.
- **Reconstruccion de cualquier aggregate por reflection** (`TestStore.cs:135-159`): crea la instancia con `Activator.CreateInstance(typeof(T), nonPublic: true)` y busca metodos `Apply(TEvento)` (publicos o privados) por reflection. Esto significa que para "pre-cargar un aggregate externo que el handler consulta con `GetAggregateRootAsync`", basta con `Given(streamIdDelExterno, eventoDeCreacion)`. No necesitas fakes adicionales ni wrappers de `IEventStore`.
- **`SaveChanges` drena aggregates cargados** (`TestStore.cs:39-48`): despues de `When*`, los `UncommittedEvents` del aggregate se copian a `_newEvents` y el aggregate se remueve de `_aggregateRoots`. La reconstruccion posterior en `And<>` usa SIEMPRE el camino `GetAggregateRoot` (ver arriba) - aplica eventos desde cero.
- **`GetNewEvents(aggregateId)` no es destructivo** (`TestStore.cs:113-114`): devuelve la lista almacenada pero no la vacia. Multiples llamadas a `Then` sobre el mismo stream ven la misma lista - y por eso fallan, porque `Then` valida count exacto.

---

## Dudas frecuentes resueltas

- **¿`Given(params object[])` acepta eventos de tipos distintos mezclados?**
  Si. Es `params object[]`, no hay restriccion generica. Se pueden mezclar `TurnoDiarioAsignado + MarcacionAdicionada + MarcacionAdicionada` en una sola llamada. Fuente: `CommandHandlerTestBase.cs:40,48`.

- **¿`Then` y `ThenIsPublishedPublicly` toleran multiples llamadas separadas (una por evento)?**
  No, debe ser **una sola llamada con todos los eventos**. `Then` valida count exacto (`CommandHandlerTestBase.cs:94`): dos llamadas hacen que la segunda vea la lista completa y falle. `ThenIsPublishedPublicly` con un solo evento pasa el subset check pero deja de validar el total (ver "Gotcha historica" arriba).

- **¿`And<T, List<X>>(...)` compara listas elemento a elemento?**
  Si. `BeEquivalentTo` de AwesomeAssertions compara colecciones elemento a elemento y records por equality estructural. Fuente: `CommandHandlerTestBase.cs:209` + documentacion de `BeEquivalentTo`.

- **¿Puedo pasar opciones personalizadas (`EquivalencyOptions`) a `And<>`?**
  Si, como tercer parametro opcional. Firma: `Func<EquivalencyOptions<TResult>, EquivalencyOptions<TResult>>?`. Fuente: `CommandHandlerTestBase.cs:185,203`.

- **¿`ThenIsPublishedPublicly(single)` vs `ThenIsPublishedPublicly(multi)` se comportan igual?**
  No. Con un solo evento hace **subset check** (el evento existe en la lista, permite mas eventos). Con dos o mas hace **count exacto + orden exacto**. Fuente: `CommandHandlerTestBase.cs:146-172`. Lo mismo aplica a `ThenIsPublishedPrivately`.

- **¿`Then` tambien tiene subset check con un solo evento?**
  No. `Then` siempre es count exacto (`CommandHandlerTestBase.cs:94`). Solo la familia `ThenIsPublished*` tiene el branching subset/multi.

- **¿`ExistsAsync` en el handler retorna `true` con eventos pre-cargados via `Given`?**
  Si, sin necesidad de llamar `GetAggregateRootAsync` primero. Fuente: `TestStore.cs:61-64`.

- **¿Como pre-cargar un aggregate externo que el handler consulta con `GetAggregateRootAsync<OtroAggregate>(otroId)`?**
  Usa `Given(otroId.ToString(), new OtroAggregateCreado(...))`. El `TestStore` reconstruye cualquier aggregate por reflection - no necesitas fakes ni wrappers de `IEventStore`. Fuente: `TestStore.cs:116-159`.

- **¿Que pasa si el aggregate tiene stream ID compuesto (ej. `EmpleadoId:Fecha`)?**
  Usa los overloads con `aggregateId` explicito: `Given(streamId, evento)`, `Then(streamId, evento)` (overload de dos argumentos, `CommandHandlerTestBase.cs:76`), `And<T, R>(streamId, selector, valor)`. Los overloads implicitos usan `AggregateId` (el GUID del harness), que no coincide con el stream calculado desde el payload. No uses `Then(streamId, null, evento)` - la sobrecarga de dos argumentos ya aplica opciones por defecto y es el patron idiomatico en el proyecto.

- **¿Puedo sobrescribir los fakes `EventStore`/`PrivateEventSender`/`PublicEventSender`?**
  No debes. Son `protected readonly` e instanciados en la clase base (`CommandHandlerTestBase.cs:25-35`). Inyectalos tal cual en el `Handler` del test. Nunca crees clases que implementen `IEventStore` en tests - el unico valido es el heredado.

- **¿Que reemplazo a `ThenIsPublishedPrivately(string groupId, ...)`/`ThenIsPublishedPublicly(string groupId, ...)` desde que el paquete subio a 2.0.0/2.1.0 (issue #312)?**
  `ThenIsPublishedPrivately(PublishOptions expectedOptions, ...)`/`ThenIsPublishedPublicly(PublishOptions expectedOptions, ...)`. `PublishOptions` es un record de `Cosmos.EventDriven.Abstractions` con `GroupId` y `Headers`; constrúyelo inline: `new PublishOptions { GroupId = AggregateId }`. El fake ya no expone `GetEventsByGroupId(groupId)` - expone `PublishedWithOptions`, una lista de tuplas `(PublishOptions Options, IReadOnlyList<T> Events)` que el assert exige tenga exactamente un elemento.

- **¿`When`/`WhenAsync` llama `SaveChanges`?**
  Si, despues de invocar el handler (`CommandHandlerAsyncTest.cs:20` y `CommandHandlerTest.cs:20`). Por eso en `Then` ya ves los eventos persistidos.

- **¿Puedo pasar `CancellationToken` a `WhenAsync`?**
  No es necesario. `WhenAsync` toma `TestContext.Current.CancellationToken` automaticamente (`CommandHandlerAsyncTest.cs:19`).

- **¿Hay limite a cuantos eventos puede recibir `Given`, `Then`, etc?**
  No. Son `params object[]`. Pasa los que necesites en una sola llamada.

---

## Atajos de navegacion

```bash
# Localizar el package en NuGet cache
ls "$(dotnet nuget locals global-packages --list | awk -F': ' '{print $2}')/cosmos.eventsourcing.testing.utilities"

# Buscar la firma exacta de un metodo en este cheatsheet
grep -n "protected void Given"          docs/testing/harness-cheatsheet.md
grep -n "protected void Then"           docs/testing/harness-cheatsheet.md
grep -n "ThenIsPublishedPublicly"       docs/testing/harness-cheatsheet.md
grep -n "public void And"               docs/testing/harness-cheatsheet.md

# Ejemplos reales en el codigo del proyecto
find tests -name '*HandlerTests.cs' | head -3
```

---

## Contrato de actualizacion

- Si el package `Cosmos.EventSourcing.Testing.Utilities` sube de version mayor y cambia una firma, **actualiza este archivo en el mismo commit**.
- Si detectas un comportamiento no documentado (ej. al leer la fuente), agregalo a "Dudas frecuentes resueltas" con cita de linea.
- No duplicar info que ya vive en `agents/test-writer.md` (proceso, convenciones de tests, escenarios obligatorios). Este archivo se limita al DSL del harness y su comportamiento.
