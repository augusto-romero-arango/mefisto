# MEF-ADR-0036: Identidad del evento persistido en el event store

- **Fecha**: 2026-07-31
- **Estado**: aceptado
- **Aplica a**: doctrina de identidad de todo evento que Marten persiste en `mt_events` -- que columna decide la lectura, de donde sale el alias en este marco, que se debe y que se proscribe registrar, donde vive esa lista y quien la registra, los dos guardrails que la protegen, y el protocolo para mover o renombrar un evento persistido. Autoridad citada por el issue hermano #475 (scaffold del write-side que aterriza `IdentidadEventos{Dominio}.cs`) y #476 (ciclo de vida en `implementer`/`test-writer`/`reviewer`/`planner`), ninguno de los cuales puede implementarse antes de que este ADR exista. Cross-referencia MEF-ADR-0005 (contrato de bus: naming, versionado aditivo, regla `V2` -- sujeto distinto de la identidad en el store, ver seccion 1), MEF-ADR-0012 (frontera de serializacion event store vs bus -- vecino, no solapado, ver seccion 6), MEF-ADR-0029 (test de composicion del contenedor DI, precedente directo del guardrail sin base de datos de la seccion 4), MEF-ADR-0030 (esquema de identificacion de ADRs, fija el numero `MEF-ADR-0036`) y MEF-ADR-0034 secciones 2, 5 y 6 (worker de proyecciones: registro read-side, hoy no escribible, y el gate de compatibilidad de configuracion Marten write-side/read-side que ya opera en `agents/reviewer.md`, issue #447/PR #477 -- ver seccion 6).

## Contexto

Un consumidor del marco (Bitakora.ControlAsistencia) movio sus 5 eventos persistidos a ensamblados
nuevos -- cambio de namespace **y** de assembly -- y quedo con un defecto desplegado: los eventos ya
escritos no se pueden leer. El codigo compilo, los tests pasaron, el pipeline dio verde y el deploy
salio. El marco no dijo nada en ningun momento, y la mitigacion elegida a pulso fue **purgar la
base** -- una purga que era criterio de aceptacion del mismo issue que movia los tipos y **quedo sin
ejecutar mientras el codigo si se desplego**. Defecto armado en el entorno, esperando la primera
rehidratacion de un aggregate preexistente (consumidor #237, #277, PR #280; vecino de codigo #268).

**El vacio esta verificado, y es de doctrina, no de vocabulario.** `MapEventType` y `mt_dotnet_type`
tienen **cero** ocurrencias en `docs/adr/`, `agents/` y `skills/` antes de este ADR. `AddEventTypes` y
`EventNamingStyle` si aparecen, pero **solo como filas de una tabla de compatibilidad**: el gate del
reviewer que compara write-side y read-side (`agents/reviewer.md`, issue #447/PR #477) los lista entre
los atributos que "deben coincidir" en ambos lados, y MEF-ADR-0034 seccion 6 con su referencia [19]
registra que el paquete fija `EventNamingStyle.SmarterTypeName` como uno de los diez atributos que
decompilo. Ninguna de las dos sedes explica **que es** el alias, cual de las dos columnas de
`mt_events` decide la lectura, ni que le pasa a un evento que cambia de namespace: nombran el atributo
como algo que hay que vigilar, sin la mecanica que hace falta para razonar sobre el. Y las dos sedes
que podrian haber cubierto esa mecanica no lo hacen: **MEF-ADR-0005** gobierna el contrato de **bus**
(versionado aditivo, regla `V2`, naming del Published Language), y **MEF-ADR-0012** cubre como se
**deserializa** un evento con constructor privado, no como se **identifica** el tipo al leerlo del
store. Tampoco lo tapa `Cosmos.EventSourcing.CritterStack`: ninguno de sus metodos publicos registra
tipos de evento en nombre del consumidor (verificado por decompilacion de 2.3.1 -- cero ocurrencias de
`AddEventType`/`AddEventTypes` en todo el ensamblado).

### La mecanica que nadie documenta

Marten guarda dos identificadores por evento en `mt_events`, y **solo uno decide la lectura**:

| Columna | Que guarda |
|---|---|
| `type` | El **alias**: por convencion, una forma en snake_case derivada del nombre **simple** de la clase |
| `mt_dotnet_type` | El nombre calificado (`FullName, AssemblyName`) del tipo CLR en el momento de escribir |

Verificado por decompilacion propia (`ilspycmd`) de `Marten.dll` 9.12.0 -- la version que pinea
MEF-ADR-0003 --, tipo `Marten.Events.EventDocumentStorage`, metodos `Resolve`/`ResolveAsync`
(equivalente en el codigo fuente publico: [1]):

1. Lee primero la columna `type` (el alias) y llama `Events.EventMappingFor(alias)` -- una busqueda
   interna por **string**, no por tipo CLR.
2. **Si resuelve** (hay un tipo registrado con ese alias), Marten usa ese mapping para deserializar
   -- **sin importar lo que diga `mt_dotnet_type`** -- salvo la excepcion de la seccion "Proscripcion
   (c)" mas abajo. Un `mt_dotnet_type` desactualizado (porque el tipo se movio de namespace o de
   assembly) **se ignora por diseno** en este camino.
3. **Si no resuelve** (ningun tipo registrado tiene ese alias), Marten cae a `mt_dotnet_type`:
   `Events.TypeForDotNetName(...)` intenta `Type.GetType(assemblyQualifiedName)` sobre el nombre
   calificado guardado. Si tampoco resuelve (el tipo ya no existe con ese nombre calificado, porque
   se movio de namespace/assembly), lanza `UnknownEventTypeException`.

Esta es la asimetria que el marco debe ensenar, verificada contra la documentacion oficial de
versionado de Marten [2]:

- **Mover namespace o assembly**: el nombre **simple** de la clase no cambia, por tanto el alias
  tampoco -- basta con que el tipo este registrado (`AddEventTypes`). Cita literal: *"If you changed
  the namespace of your event class, it's enough to use the `AddEventTypes` method as it generates
  mapping based on the CLR event class name"*.
- **Renombrar la clase**: el nombre simple cambia, y con el el alias -- `AddEventTypes` ya no
  alcanza. Cita literal: *"If you change the event type class name, Marten cannot do mapping by
  convention. You need to define the custom one"* con `MapEventType`.

Dos casos con distinta gravedad, indistinguibles desde el diff de un PR (ambos se leen como "edite la
declaracion de una clase"), y hoy el marco no separa ninguno.

### Por que el marco debe opinar

**1. El marco prescribe la herramienta que crea el riesgo.** `agents/reviewer.md` manda usar
`rename_refactoring` del MCP de JetBrains para renombrar simbolos, con el argumento de que "el IDE
actualiza todas las referencias del proyecto de forma segura, incluyendo tests". Esa garantia es de
**compilacion**. Para un evento persistido, renombrar la clase (a diferencia de moverla de
namespace/assembly) es un cambio de contrato de datos que ninguna referencia del proyecto delata --
el compilador no tiene forma de saber que existen filas en Postgres con el alias viejo.

**2. El estilo que produce el alias lo fija el paquete, no el consumidor.** Verificado por
decompilacion propia de `Cosmos.EventSourcing.CritterStack` 2.3.1 (la version pinneada por el
consumidor de referencia): el metodo que cada dominio invoca del lado write,
`Commands.MartenEventStoreExtensions.AgregarConfiguracionMartenComandos`, fija
`options.Events.EventNamingStyle = EventNamingStyle.SmarterTypeName` -- **no** el default de Marten
(`ClassicTypeName`). El mismo valor lo fija tambien `Queries.MartenProjectionStoreExtensions.AgregarConfiguracionMartenConsultas`,
el gemelo read-side que MEF-ADR-0034 seccion 6 ya documenta como no invocable directamente por el
worker. Verificado tambien en 2.1.0 (mismo `set_EventNamingStyle` presente en el ensamblado). Tres
consecuencias que ninguna sede del marco recogia antes de este ADR:

- El alias vigente **no es el default de Marten**. Decompilando `JasperFx.Events.dll` 2.18.1
  (`EventTypeExtensions.GetEventTypeName`/`GetSmarterEventTypeName`, ver seccion 1 de la Decision
  para el detalle): para un tipo **no anidado** (top-level), ambos estilos producen exactamente el
  mismo alias -- sea el tipo generico o no. Divergen **unicamente** cuando el tipo esta anidado
  (`IsNested`): `ClassicTypeName` ignora la anidacion (usa solo el nombre simple de la clase interna),
  mientras que `SmarterTypeName` antepone el alias del tipo contenedor (`Externo.Interno`). Es una
  precision mas estricta que "generico o anidado diverge" -- un evento generico top-level (no
  anidado) resuelve identico bajo ambos estilos; solo la anidacion causa divergencia.
- El consumidor **no puede "no alterar `EventNamingStyle`"**, porque no lo controla: lo fija el
  paquete. La proscripcion correcta es no cambiarlo **respecto de lo que el paquete ya fija**.
- **Subir la version del paquete es un cambio potencial de identidad de todo lo ya persistido**, y
  ningun ADR lo nombraba antes de este. Es la razon de fondo del gate de compatibilidad de
  configuracion Marten write-side/read-side que `agents/reviewer.md` ya implementa (issue #447, PR
  #477): ese gate corre, entre otras condiciones, cuando el diff toca la version de
  `Cosmos.EventSourcing.CritterStack`, y su tabla ya incluye la fila `Events.EventNamingStyle`. Este
  ADR es la doctrina que explica **por que** esa fila importa; el gate mismo vive en `reviewer.md`, no
  aqui (ver seccion 6).

**3. El read-side no tiene dueno en el backlog.** El registro en el named store del worker de
proyecciones es defensa en profundidad y **no es escribible hoy**: la lista de tipos persistidos de
un dominio, si vive junto a su codigo de dominio, esta en el assembly del Function App, que el worker
no puede referenciar (MEF-ADR-0034 seccion 5 -- `<RootNamespace>.ReadModels` no lleva Marten ni
transitivamente, y las clases de proyeccion viven en el worker, no en un ensamblado del dominio). Este
ADR nombra ese hueco en vez de darlo por resuelto (seccion 6).

**4. El write-side es el expuesto.** Cada comando rehidrata su aggregate leyendo el stream completo
(`AggregateStreamAsync`, MEF-ADR-0015). El worker de proyecciones corre menos riesgo porque su daemon
filtra por tipo en SQL antes de reaplicar eventos -- una divergencia de identidad ahi se manifiesta
como una proyeccion que deja de recibir eventos, no como una excepcion de lectura del aggregate
completo.

## Decision

### 1. La identidad del evento persistido es el alias, no el nombre calificado (CA-1)

La identidad de un evento persistido en Marten es la columna `type` (el **alias**), nunca
`mt_dotnet_type` (el nombre calificado del tipo CLR). El mecanismo de resolucion (verificado en
"Contexto" contra `EventDocumentStorage.Resolve`/`ResolveAsync` de Marten 9.12.0 [1]) resuelve
primero por alias; un `mt_dotnet_type` desactualizado se ignora por diseno **siempre que el alias
resuelva y ningun tipo alternativo este registrado con ese nombre calificado obsoleto** (ver
proscripcion (c) en la seccion 2 -- esta es la unica forma de invertir esa tolerancia).

**De donde sale el alias en este marco**: no del default de Marten (`EventNamingStyle.ClassicTypeName`)
sino del que fija `Cosmos.EventSourcing.CritterStack` -- `EventNamingStyle.SmarterTypeName` --,
verificado por decompilacion propia (ver "Contexto", punto 2). Ambos estilos coinciden para
cualquier tipo **no anidado** (top-level), sea generico o no; divergen solo cuando el tipo esta
anidado, porque `SmarterTypeName` antepone el alias del contenedor y `ClassicTypeName` no. Un evento
persistido del marco casi nunca es una clase anidada, asi que la divergencia es hoy teorica -- pero
el estilo vigente sigue sin ser el que un desarrollador esperaria por default de la libreria si no
conoce este ADR.

### 2. Registro y proscripciones (CA-2)

El registro es `Events.AddEventTypes(new[] { typeof(TurnoCreado), typeof(TurnoCerrado), /* ... */ })`
**por convencion**: registrar un tipo con `AddEventTypes` no redeclara su alias -- solo hace que
Marten conozca el tipo CLR de antemano (util para proyecciones asincronas y para la migracion de
namespace/assembly de la seccion 5). El alias lo sigue calculando `EventNamingStyle` a partir del
nombre simple de la clase, exactamente igual que si el tipo nunca se hubiera registrado
explicitamente -- la unica diferencia observable es que Marten no necesita descubrirlo por reflexion
la primera vez que lo ve.

**Tres proscripciones**, verificadas por decompilacion propia de `Marten.Events.EventGraph` 9.12.0:

- **(a) No usar `MapEventType`** para el caso de mover namespace/assembly. `MapEventType(Type,
  string)` hace literalmente `EventMappingFor(eventType).EventTypeName = eventTypeName` --
  **redeclara el alias a mano**. Es la herramienta correcta para *renombrar* (seccion 5), no para
  *mover*: usarla en una migracion de namespace es forzar un alias explicito donde `AddEventTypes` ya
  lo resuelve por convencion, y aumenta el riesgo de una transcripcion manual incorrecta del alias.
- **(b) No alterar el `EventNamingStyle` respecto del valor que fija el paquete.** No "no tocar el
  default" -- el consumidor no controla el default, lo fija `Cosmos.EventSourcing.CritterStack`
  (seccion 1). La proscripcion es no cambiarlo respecto de lo que el paquete ya establece
  (`SmarterTypeName` en las versiones verificadas 2.1.0/2.3.1); hacerlo cambia el alias de todo evento
  cuya clase este anidada, con el mismo efecto que un upgrade no auditado del paquete (ver el modo de
  falla mas abajo).
- **(c) No registrar el nombre calificado antiguo** de un tipo movido -- ni con una clase shim en el
  namespace/assembly viejo, ni con `MapEventType` apuntando a el. **Motivo, verificado por
  decompilacion**: `EventGraph.TryGetRegisteredMappingForDotNetTypeName(dotnetTypeName)` busca, entre
  **todos** los tipos registrados, uno cuyo `DotNetTypeName` coincida con el string dado -- y
  `EventDocumentStorage.Resolve` invoca esa busqueda **incluso cuando el alias ya resolvio**, para
  soportar el caso legitimo de un renombrado con coexistencia de tipo viejo y nuevo bajo el mismo
  alias (seccion 5). Si el marco registra (por accidente o por un intento equivocado de "compatibilidad
  hacia atras") un tipo cuyo `DotNetTypeName` es el nombre calificado viejo, esa busqueda **encuentra
  un match** para las filas ya persistidas con ese `mt_dotnet_type` obsoleto, y Marten las deserializa
  usando el mapping viejo -- invirtiendo exactamente la tolerancia que la seccion 1 describe como
  default. Este es el unico mecanismo documentado que reactiva `mt_dotnet_type` como criterio de
  resolucion aun con el alias resuelto.

**Criterio de inclusion de la lista**: se persiste. Un evento que solo cruza un bus (Azure Service
Bus, MEF-ADR-0001/MEF-ADR-0023/MEF-ADR-0024) no entra en esta lista -- se deserializa a un tipo fijo
por endpoint/subscription y nunca pasa por el `EventGraph` de ningun `IDocumentStore`. La lista de
identidad de este ADR y la de serializacion de MEF-ADR-0012 son conjuntos que **se solapan sin
contenerse** (seccion 6).

**Modo de falla del punto 2 de "Contexto": un upgrade de `Cosmos.EventSourcing.CritterStack` puede
cambiar el `EventNamingStyle` que fija, y con el la identidad de todo lo ya persistido** -- exactamente
la misma clase de riesgo que mover un evento de namespace, pero disparada por un cambio de version del
paquete en vez de un cambio de codigo del dominio. Este ADR no crea un gate paralelo para ese caso: el
gate de compatibilidad de configuracion Marten write-side/read-side que `agents/reviewer.md` ya
implementa (issue #447/PR #477) corre precisamente cuando el diff toca la version de
`Cosmos.EventSourcing.CritterStack` o `Cosmos.EventSourcing.Abstractions`, y su tabla de atributos que
"deben coincidir" ya incluye `Events.EventNamingStyle`. Este ADR aporta la razon por la que esa fila
es critica; el gate mismo, su disparador y su procedimiento de decompilacion viven en `reviewer.md`
(ver seccion 6).

### 3. Donde vive la lista y quien la registra (CA-3)

La lista de tipos persistidos de un dominio es **una sola fuente por dominio**, declarada
explicitamente en produccion -- nunca por reflexion en el arranque del Function App (escanear un
assembly buscando "todo lo que parezca un evento" es fragil y no distingue eventos persistidos de
DTOs de bus que comparten el mismo namespace):

```csharp
// Infraestructura/IdentidadEventos{Dominio}.cs -- nombre de archivo y ensamblado
// exactos los fija el scaffold del write-side (issue #475, hermano de este ADR).
public static class IdentidadEventos{Dominio}
{
    public static void Registrar(IEventStoreOptions events)
    {
        events.AddEventTypes(new[]
        {
            typeof(TurnoCreado),
            typeof(TurnoCerrado),
            // uno por cada evento persistido de este dominio -- ver criterio de
            // inclusion de la seccion 2: "se persiste", no "cruza un bus"
        });
    }
}
```

**Todo proceso que lea esos streams registra esta lista en su propio `EventGraph`.** Cada
`IDocumentStore` -- el del Function App del write-side (MEF-ADR-0029) y el named store del worker de
proyecciones de ese mismo dominio (MEF-ADR-0034 seccion 2) -- es independiente y no hereda ningun
registro del otro: `IdentidadEventos{Dominio}.Registrar(...)` se invoca desde
`ComposicionServicios{Dominio}.cs` **y** desde `ConfiguracionMartenProjections{Dominio}.cs`. Esa
segunda invocacion es **doctrina, no algo escribible hoy**: el worker no puede referenciar el
ensamblado donde vive la lista, y no hay ensamblado compartido donde ponerla (seccion 6 (a)). El
write-side -- el lado expuesto, punto 4 de "Contexto" -- si cumple la exigencia completa desde ya. Es la
misma premisa de la que parte la doctrina de #447 en `agents/reviewer.md` (que dos procesos que leen
el mismo Postgres pueden divergir en su configuracion de Marten sin que nada lo note), resuelta aqui
por **registro explicito compartido** en vez de por vigilancia del reviewer -- las dos estrategias
conviven porque cubren superficies distintas: esta seccion fija que los tipos coincidan por
construccion (misma funcion invocada en ambos lados); el gate de #447 vigila el resto de la
configuracion de Marten que no pasa por esta funcion (seccion 6).

Este ADR **no fija** el nombre del archivo ni su ensamblado exacto mas alla del ejemplo ilustrativo de
arriba -- eso lo aterriza el issue hermano del scaffold (#475).

### 4. Forma de los dos guardrails (CA-4)

**Guardrail 1 -- derivado y auto-mantenido.** El oraculo de "que tipos deberian estar registrados" se
deriva por reflexion de los tipos que son parametro de un `public void Apply(TEvento)` de un
`AggregateRoot` del assembly del dominio -- la misma firma con la que Marten rehidrata un aggregate
(MEF-ADR-0012). No requiere un marker nuevo (`IEventoPersistido` u otro): un evento que el aggregate
ya declara consumir via `Apply` es, por construccion, un evento persistido de ese dominio. Los
eventos que solo cruzan un bus quedan fuera **por construccion**, no por un filtro adicional: llegan
por un endpoint de Service Bus, nunca por un `Apply` de un aggregate.

```csharp
var esperados = typeof(AlgunAggregateRootDelDominio).Assembly
    .GetTypes()
    .Where(t => typeof(AggregateRoot).IsAssignableFrom(t) && !t.IsAbstract)
    .SelectMany(t => t.GetMethods())
    .Where(m => m.Name == "Apply" && m.GetParameters().Length == 1)
    .Select(m => m.GetParameters()[0].ParameterType)
    .Distinct();

var registrados = store.Options.Events.AllKnownEventTypes().Select(e => e.EventType);

Assert.Equal(esperados.OrderBy(t => t.FullName), registrados.OrderBy(t => t.FullName));
```

Razon de esta forma: un oraculo **literal** (una lista de tipos escrita a mano en el test) solo se
pone rojo si alguien **recuerda** editarlo junto con el aggregate -- y ese recuerdo es justo lo que
fallo en el caso real que origina este ADR. Un oraculo derivado no depende de la memoria de nadie: se
recalcula del propio codigo del aggregate en cada corrida.

**Guardrail 2 -- alias congelado sobre el store del contenedor real, nunca sobre un `new
StoreOptions()` standalone.** Verificado por mutacion en el campo (consumidor de referencia, PR
#280): inyectar `MapEventType<T>("nombre.viejo")` en algun punto del wiring real deja **verdes** los
tests que reconstruyen un `StoreOptions()` aislado e invocan solo `IdentidadEventos{Dominio}.Registrar(...)`
sobre el -- ese test no ve el resto del wiring donde se colo el `MapEventType`. Solo se pone rojo el
test que resuelve el `IDocumentStore` **ya compuesto por el contenedor real** (el mismo que
MEF-ADR-0029 resuelve para sus tres routers):

```csharp
var store = provider.GetRequiredService<IDocumentStore>();
var alias = store.Options.Events.AllKnownEventTypes()
    .Single(e => e.EventType == typeof(TurnoCreado)).Alias;

Assert.Equal("turno_creado", alias);
```

El test standalone es decorativo: prueba que la funcion de registro, aislada, produce el alias
esperado -- pero no prueba que **el contenedor real** vaya a resolver ese mismo alias, que es la
unica pregunta que importa en produccion.

**Una guarda de lista exacta o conteo no forma parte de los guardrails del marco.** Un test que
compara `TiposPersistidos` (o los tipos del `EventGraph`) contra una lista de tipos escrita a mano, o
que fija su cantidad (p. ej. `TiposPersistidos_ContieneExactamenteLosVeinticuatroEventos`), es un
oraculo literal: no detecta un defecto, detecta un **cambio** -- falla con cada evento nuevo y obliga
a editarlo (y a renombrar el metodo si el conteo esta en el nombre). Al encontrarla en un proyecto se
**elimina** si el proyecto ya tiene el guardrail 1, o se **reemplaza por el guardrail 1** si no lo
tiene. La proteccion frente al borrado o renombre de un evento registrado la da el guardrail 2: si se
borra el tipo, el `typeof(Evento)` del test no compila; si se renombra la clase, el alias literal no
coincide. La lista exacta no agrega cobertura: borrarla junto con el tipo exige el mismo "recuerdo"
que la razon de arriba descarta como oraculo.

**Ninguno de los dos guardrails requiere Postgres.** `IReadOnlyEventStoreOptions.AllKnownEventTypes()`
(verificado en `Marten.Events`, expuesto por `IDocumentStore.Options.Events` sin cast) es calculo puro
en memoria sobre el `EventGraph` ya construido -- ningun guardrail necesita una conexion real, solo el
`IServiceProvider` compuesto (MEF-ADR-0029).

**Gotchas de superficie verificados por decompilacion propia de Marten 9.12.0:**

- `EventGraph.AllEvents()` es **`internal`** -- no compila desde el ensamblado de test. El guardrail 2
  usa `AllKnownEventTypes()` (publico, en la interfaz `IReadOnlyEventStoreOptions`), no `AllEvents()`.
- `IEventType` (namespace `JasperFx.Events`) expone `EventType` (el `Type` CLR), `DotNetTypeName`,
  `EventTypeName` y `Alias` -- **no** expone `DocumentType`. Un implementador que busque
  `.DocumentType` por analogia con otras superficies de Marten no compila.

### 5. Protocolo de refactor y la purga (CA-5)

Antes de mover o renombrar un evento persistido:

1. **Distinguir el caso**: ¿cambia solo el namespace/assembly (nombre simple de la clase igual) o
   cambia el nombre de la clase? La seccion 1 fija que solo el segundo caso cambia el alias.
2. **Preguntar si el entorno de destino ya tiene streams escritos** con ese tipo de evento. Un entorno
   sin datos reales (greenfield, o un ambiente que aun no proceso ningun comando real) no necesita
   ningun protocolo: el cambio de codigo no tiene datos historicos que reconciliar.
3. Si ya hay streams escritos, **secuencia de dos despliegues, nunca uno solo**:
   - **Despliegue 1**: agrega el registro del tipo (`AddEventTypes` para mover; `MapEventType` para
     renombrar) **sin mover ni renombrar todavia** la clase. Este despliegue no cambia ningun
     comportamiento observable -- solo prepara el `EventGraph` para reconocer el tipo bajo su forma
     futura.
   - **Despliegue 2**: mueve o renombra la clase. Como el registro del despliegue 1 ya esta en
     produccion, la primera rehidratacion despues de este segundo despliegue ya encuentra el tipo
     resuelto.
   - El registro **nunca va en el mismo despliegue** que el movimiento: si algo falla entre ambos
     pasos, un rollback del despliegue 2 deja el registro (inocuo) sin el movimiento, en vez de un
     movimiento sin registro (el defecto real de este ADR).
4. **Purgar el entorno no es una salida aceptable por defecto.** Es una perdida de todo el historial
   de eventos del entorno, con las consecuencias de negocio que eso implique (auditoria, replay,
   proyecciones que dependen de ese historial). Si se elige deliberadamente -- por ejemplo, en un
   ambiente de desarrollo temprano sin datos que importen -- **la purga pertenece al mismo despliegue
   que el movimiento**, ejecutada como parte de el, nunca como un criterio de aceptacion separado que
   pueda quedar pendiente mientras el codigo que la necesita ya salio. Es exactamente la secuencia
   invertida que origino el incidente real: el PR que movia los tipos se desplego y la purga (criterio
   de aceptacion de ese mismo PR) no se ejecuto a la par.

**Mecanismo canonico de ejecucion (issue #743).** Cuando la purga se elige deliberadamente segun el
punto 4, el mecanismo canonico para ejecutarla es el skill `/purge-store` (`commands/purge-store.md`),
nunca `psql`/`DROP` a mano ni otro script ad-hoc. El skill diagnostica con evidencia (App Insights,
smoke tests del ultimo deploy) antes de siquiera ofrecer la purga, confirma con el humano mostrando el
`--dry-run` de `scripts/purge-store.mts` (issue #725 -- la mitad determinista que ejecuta el
`DROP SCHEMA ... CASCADE` y reinicia los procesos afectados) y valida el resultado relanzando los smoke
tests que estaban en rojo. Esta doctrina **no cambia** la regla del punto 4: la purga sigue
perteneciendo al mismo despliegue que el movimiento de tipos; `/purge-store` es el **como** se ejecuta
esa purga cuando corresponde, no una excepcion a **cuando** corresponde ejecutarla.

### 6. Fronteras declaradas: que NO cierra este ADR (CA-6)

**(a) El registro read-side es defensa en profundidad, y hoy no es escribible.** La seccion 3 exige que
todo proceso que lea un stream registre los tipos en su propio `EventGraph`; del lado del worker de
proyecciones esa exigencia **no se puede cumplir hoy**. La lista vive junto al codigo de dominio -- es
decir, en el assembly del Function App --, y el worker no puede referenciarlo: MEF-ADR-0034 seccion 5
pone los read models en `<RootNamespace>.ReadModels` (una biblioteca deliberadamente sin Marten, ni
transitivamente) y las clases de proyeccion en el worker mismo, asi que **no existe ningun ensamblado
compartido donde la lista pueda vivir para que ambos lados la invoquen**. Y **ningun issue del backlog
habilita esa ruta**: el marco no tiene decidido donde viven los eventos que una proyeccion declara. Este
ADR **nombra el hueco** en vez de darlo por resuelto -- quien implemente el scaffold del write-side
(#475) o el ciclo de vida en los agentes (#476) no debe asumir que "registrar tambien en el worker" sea
una opcion disponible. Mientras el hueco siga abierto, la unica defensa del read-side es la vigilancia
de (c), que compara configuracion sin exigir un ensamblado compartido.

**(b) La lista de identidad no duplica ni reemplaza la de serializacion de MEF-ADR-0012.** Son dos
listas con dos propositos, y sus conjuntos **se solapan sin contenerse**: un evento con constructor
publico se persiste (entra en la lista de identidad) y no necesita `ConfigurarSerializacion`; un value
object con constructor privado necesita `ConfigurarSerializacion` (entra en la lista de MEF-ADR-0012) y
no es un evento, asi que nunca entra en la de identidad; un evento persistido con constructor privado
entra en las dos. Registrar un tipo con `AddEventTypes` no lo hace deserializable, y hacerlo
deserializable no lo hace identificable: **son dos preguntas distintas** -- que tipo resuelve este
alias, y como se construye una instancia de ese tipo una vez resuelto.

**(c) Frontera de autoridad frente a la doctrina de compatibilidad write-side/read-side (#447).** Este
ADR es la **autoridad de la identidad**: que es el alias, de donde sale (`EventNamingStyle`), que tipos
se registran y bajo que proscripciones. El gate condicional de `agents/reviewer.md` (issue #447/PR #477)
es la **vigilancia**: corre cuando el diff toca la version del paquete o configuracion de Marten, y
compara los atributos de los dos lados. Dos filas de su tabla caen bajo la autoridad de este ADR --
`Events.EventNamingStyle` y "Tipos de evento registrados (`AddEventTypes`)" --: **deben remitir a este
ADR en vez de re-explicar la mecanica**, y este ADR, simetricamente, no duplica el gate ni su
disparador. Ese gate se escribio antes que este ADR (PR #477), asi que hoy todavia no lo cita; la
anotacion concreta en `reviewer.md` la hace el issue #476, el que toca los agentes -- este ADR fija la
frontera, no la edita por adelantado. Consecuencia
que hay que decir en voz alta: **la segunda de esas dos filas no es satisfacible hoy**, por la razon de
(a) -- el reviewer puede detectar que los tipos registrados divergen entre el write-side y el worker,
pero el consumidor no tiene con que hacerlos converger hasta que ese hueco se cierre. Esa fila vale
entonces como **deteccion** (y como recordatorio del hueco cada vez que el gate corre), no como algo que
el consumidor pueda arreglar hoy.

**(d) La regla de "sin lista exacta" tiene un alcance acotado.** La prohibicion de la seccion 4 alcanza
solo a las guardas de lista exacta o conteo de los **tipos persistidos** (`TiposPersistidos`,
`EventGraph`). **No** alcanza a las tablas evento->topic de los tests de composicion (enrutamiento de
bus, MEF-ADR-0024 decision 7) ni a los tests de dominio Given/When/Then (MEF-ADR-0002): son oraculos de
otra pregunta (a que topic va un evento; que comportamiento produce un comando) y se mantienen. El
guardrail 2 existe solo para los eventos agregados desde que el test-writer lo genera
(`agents/test-writer.md`, seccion 6f): que un consumidor no lo tenga para eventos antiguos es una
frontera conocida, no un motivo para conservar la lista exacta.

## Alternativas consideradas

### Alt 1: upcasting como mecanismo general de migracion

**Descartada** para este problema. El upcasting de Marten resuelve cambios de **payload** (un evento
que gana/pierde/transforma campos entre versiones), no cambios de **identidad** (que tipo CLR
resuelve un alias dado). Mover o renombrar un evento no cambia su forma, cambia como se lo localiza --
un problema distinto que `AddEventTypes`/`MapEventType` resuelven directamente, sin necesidad de un
transform de upcasting.

### Alt 2: la regla `V2` de MEF-ADR-0005

**Descartada** para este problema. La regla `V2` (crear `EventoV2` y mantener ambos mientras los
consumidores migran) es la respuesta del marco a un cambio **breaking de contrato de bus** -- otros
Bounded Contexts que consumen el evento publicado necesitan una ventana de migracion. Mover o
renombrar un tipo persistido es un problema puramente **interno** al dominio que lo escribe: no hay
"consumidores externos" del alias en el event store, solo el propio `IDocumentStore` del dominio y,
cuando aplica, el named store del worker de proyecciones (mismo dominio, MEF-ADR-0034).

### Alt 3: `[TypeForwardedTo]`

**Descartada**. El atributo `[TypeForwardedTo]` de .NET reenvia referencias de tipo entre assemblies
preservando el `FullName` -- resuelve el caso de mover un tipo **de assembly** manteniendo su
namespace, pero no cubre un cambio de **namespace**, que es la mitad del caso real que origina este
ADR (el consumidor cambio ambos). Ademas, resolver `mt_dotnet_type` via `[TypeForwardedTo]` seguiria
dependiendo del camino de fallback de la seccion 1 (solo se consulta si el alias no resuelve) -- no
aporta nada que `AddEventTypes` no resuelva ya de forma mas directa para el caso que este ADR cubre.

### Alt 4: migrar `mt_dotnet_type` con una migracion SQL

**Descartada como default, valida como plan B.** Actualizar `mt_dotnet_type` de las filas existentes
con un `UPDATE` directo sobre `mt_events` es innecesario cuando el alias ya esta registrado -- la
seccion 1 establece que esa columna se ignora por diseno una vez que el alias resuelve. Reservada
unicamente para el escenario donde no se puede desplegar codigo antes de que el entorno necesite leer
esos streams (por ejemplo, una migracion de datos fuera de banda sin ventana de despliegue
disponible); en ese caso, el `UPDATE` sustituye al despliegue 1 del protocolo de la seccion 5, pero
introduce el riesgo de tocar produccion con SQL manual en vez de con el mecanismo que Marten ya provee
para este caso.

### Alt 5: mantener la lista exacta de tipos persistidos

**Descartada**. Es un detector de cambios, no de defectos: falla con cada evento nuevo y exige editarla
(y renombrar el metodo si lleva el conteo), lo que causo abortos del pipeline TDD en el consumidor de
referencia. Su unico valor -- detectar el borrado o renombre de un evento registrado -- ya lo cubre el
guardrail 2 (seccion 4).

### Alt 6: snapshot de alias congelados que solo crece

**Descartada**. Duplica el guardrail 2: un alias literal sobre el contenedor real ya congela la
identidad de cada evento, sin un artefacto adicional que mantener.

## Consecuencias

### Positivas

- **El marco deja de operar bajo un estilo de naming de eventos (`EventNamingStyle.SmarterTypeName`)
  que ninguna fuente declaraba** -- cualquier agente o desarrollador que necesite razonar sobre el
  alias de un evento persistido ahora tiene una sede unica que lo fija y lo cita.
- **La asimetria mover vs renombrar queda nombrada y con protocolo**, en vez de descubrirse en
  produccion como en el caso real: un movimiento de namespace/assembly usa `AddEventTypes` sin
  ceremonia; un renombrado usa `MapEventType` con la secuencia de dos despliegues.
- **Dos guardrails concretos y verificados por mutacion real** (derivado por reflexion sobre `Apply`;
  alias congelado sobre el contenedor real) cierran exactamente el modo de falla que produjo el
  incidente: un tipo movido sin registrar ahora se detecta en el mismo test suite, sin necesidad de
  Postgres ni de un deploy.
- **El hueco del read-side queda nombrado en vez de asumido resuelto** (seccion 6): un futuro
  implementador de #475/#476 no puede asumir que "registrar en el worker" es una opcion disponible hoy.
- **La proscripcion (c) documenta un mecanismo de Marten poco conocido**
  (`TryGetRegisteredMappingForDotNetTypeName`) que, sin este ADR, es facil de activar por accidente al
  intentar "ayudar" con una clase de compatibilidad hacia atras.

### Negativas

- **El registro explicito (`IdentidadEventos{Dominio}.cs`) es codigo adicional por dominio** que no
  existia antes de este ADR -- un archivo mas que mantener sincronizado con los aggregates del
  dominio, mitigado por el guardrail 1 (derivado, no manual).
- **El guardrail 2 exige resolver el `IDocumentStore` compuesto por el contenedor real**, no un
  `StoreOptions` standalone -- mas costoso de escribir que un test aislado, pero es exactamente la
  forma que la mutacion real (PR #280) demostro necesaria; la version barata (standalone) da falsos
  verdes.
- **El registro read-side sigue sin ser escribible** (seccion 6): este ADR nombra el hueco pero no lo
  cierra -- un dominio que agrega proyecciones queda con la misma defensa en profundidad ausente hasta
  que un issue futuro decida donde vive esa lista compartida.
- **La secuencia de dos despliegues (seccion 5) es mas lenta que un solo PR** para mover o renombrar
  un evento -- friccion aceptada deliberadamente: es el costo de no arriesgar un `UnknownEventTypeException`
  en produccion, exactamente el trade-off que el incidente real muestra que vale la pena pagar.

## Referencias

- **[1]** `Marten.Events.EventDocumentStorage.Resolve`/`ResolveAsync` -- decompilacion propia
  (`ilspycmd`) de `Marten.dll` 9.12.0 (version pinneada por MEF-ADR-0003):
  `~/.nuget/packages/marten/9.12.0/lib/net10.0/Marten.dll`. Confirma que `Resolve` lee primero la
  columna ordinal 1 (`type`, el alias) y llama `Events.EventMappingFor(alias)`; si resuelve y
  `!eventMapping.IsUpcastTarget` y la columna ordinal 2 (`mt_dotnet_type`) no es nula y difiere del
  `DotNetTypeName` del mapping resuelto, busca un mapping alternativo con
  `Events.TryGetRegisteredMappingForDotNetTypeName(mt_dotnet_type)`; si el alias no resuelve, cae a
  `eventMappingForDotNetTypeName` -> `Events.TypeForDotNetName(...)` -> `Type.GetType(assemblyQualifiedName)`
  -> `UnknownEventTypeException` si tampoco resuelve. Equivalente legible en el codigo fuente publico
  (puede haber drift de version/linea frente a `master`):
  https://github.com/JasperFx/marten/blob/master/src/Marten/Events/EventDocumentStorage.cs
- **[2]** "Event Versioning" -- Marten docs (martendb.io), secciones "Namespace Migration" y
  renombrado de tipo de evento: *"If you changed the namespace of your event class, it's enough to
  use the `AddEventTypes` method as it generates mapping based on the CLR event class name"*; *"If
  you change the event type class name, Marten cannot do mapping by convention. You need to define
  the custom one"* (con `MapEventType`, ejemplo donde el alias viejo y el nuevo tipo coexisten bajo el
  mismo `event type name`). https://martendb.io/events/versioning.html
- **[3]** `Marten.Events.EventGraph` -- decompilacion propia (`ilspycmd`) de `Marten.dll` 9.12.0:
  `AddEventType`/`AddEventTypes` invocan `EventRegistry.AddEventType`/`_events.FillDefault(eventType)`
  sin tocar `EventTypeName` (no redeclaran el alias); `MapEventType(Type, string)` ejecuta literalmente
  `EventMappingFor(eventType).EventTypeName = eventTypeName` (si redeclara el alias);
  `TryGetRegisteredMappingForDotNetTypeName(string)` itera `AllEvents()` (marcado `internal`) buscando
  un mapping cuyo `DotNetTypeName` coincida; `AllKnownEventTypes()` (publico, expuesto por la interfaz
  `IReadOnlyEventStoreOptions`) proyecta `_events` a `IReadOnlyList<IEventType>` sin tocar Postgres.
- **[4]** `Marten.Events.IEventStoreOptions` / `Marten.Events.IReadOnlyEventStoreOptions` /
  `JasperFx.Events.IEventType` -- decompilacion propia de `Marten.dll` 9.12.0 y `JasperFx.Events.dll`
  2.18.1: confirma las firmas publicas `AddEventType<TEvent>()`, `AddEventType(Type)`,
  `AddEventTypes(IEnumerable<Type>)`, `MapEventType<TEvent>(string)`, `MapEventType(Type, string)`,
  `AllKnownEventTypes(): IReadOnlyList<IEventType>`, y que `IEventType` expone `EventType`
  (`Type`), `DotNetTypeName`, `EventTypeName` y `Alias` -- no `DocumentType`. `IDocumentStore.Options`
  es `IReadOnlyStoreOptions`, cuya propiedad `Events` ya es `IReadOnlyEventStoreOptions` sin necesidad
  de cast.
- **[5]** `JasperFx.Events.EventTypeExtensions.GetEventTypeName`/`GetSmarterEventTypeName` y
  `enum EventNamingStyle` -- decompilacion propia de `JasperFx.Events.dll` 2.18.1
  (`~/.nuget/packages/jasperfx.events/2.18.1/lib/net10.0/JasperFx.Events.dll`). El enum documenta en
  su XML doc: `ClassicTypeName` = *"The default, 'classic' style ... converts just the type name in
  Pascal Case to all lower case w/ snake casing"*; `SmarterTypeName` = *"Like the classic style, but
  handles inner type names by prepending the [outer type].[inner type] to disambiguate"*;
  `FullTypeName` = nombre calificado completo. El codigo confirma que `GetSmarterEventTypeName` solo
  se aparta de `GetEventTypeName` (clasico) cuando `eventType.IsNested` es verdadero -- para un tipo no
  anidado, generico o no, ambos metodos ejecutan la misma rama (`ToTableAlias(Name)` o
  `ShortNameInCode(eventType)` segun sea generico).
- **[6]** Decompilacion propia (`ilspycmd`) de `Cosmos.EventSourcing.CritterStack` 2.3.1 contra
  `~/.nuget/packages/cosmos.eventsourcing.critterstack/2.3.1/lib/net10.0/Cosmos.EventSourcing.CritterStack.dll`,
  mismo procedimiento que documenta `agents/bug-investigator.md` y que ya registro MEF-ADR-0034
  referencia [19]: `Commands.MartenEventStoreExtensions.AgregarConfiguracionMartenComandos` fija
  `options.Events.EventNamingStyle = (EventNamingStyle)1` (`SmarterTypeName`, mapeo ordinal verificado
  contra [5]); el mismo valor lo fija `Queries.MartenProjectionStoreExtensions.AgregarConfiguracionMartenConsultas`.
  Confirmado tambien presente (`set_EventNamingStyle`) en la version 2.1.0 del mismo paquete.
- MEF-ADR-0003 (stack ES Marten+Wolverine): fija la version pinneada de Marten (9.12.0) contra la que
  se verifico el mecanismo de resolucion de esta seccion.
- MEF-ADR-0005 (naming y versionado de eventos): contrato de **bus** (naming del Published Language,
  versionado aditivo, regla `V2`) -- sujeto distinto de la identidad en el store que fija este ADR;
  gana un parrafo de referencia cruzada a este ADR (ver Control de cambios).
- MEF-ADR-0012 (encapsulamiento, frontera de serializacion event store vs bus): la lista de identidad
  de este ADR y la de serializacion de MEF-ADR-0012 son conjuntos que se solapan sin contenerse (un
  evento con constructor publico se persiste y no necesita `ConfigurarSerializacion`; un value object
  necesita `ConfigurarSerializacion` y no es un evento).
- MEF-ADR-0029 (test de composicion del contenedor DI): precedente directo del guardrail 2 (seccion
  4) -- resolver contra el `IDocumentStore` que compone el contenedor real, nunca contra un
  `StoreOptions` aislado, es la misma filosofia que ese ADR ya aplica a los tres routers del write-side.
- MEF-ADR-0030 (esquema de identificacion de ADRs): fija el nombre `MEF-ADR-0036` (numero verificado
  libre, `docs/adr/` llegaba a 0035 antes de este ADR).
- MEF-ADR-0034 secciones 2, 5 y 6: seccion 2 (named store por dominio sobre el mismo Postgres del
  write-side) es el segundo `IDocumentStore` que la seccion 3 de este ADR exige registrar; seccion 5
  (`ReadModels` sin Marten, clases de proyeccion en el worker) es la razon verificada de por que el
  registro read-side no es escribible hoy (seccion 6); seccion 6 y su referencia [19] ya documentan el
  gate de compatibilidad de configuracion Marten write-side/read-side (`agents/reviewer.md`, issue
  #447/PR #477) que este ADR complementa con la razon de fondo, sin duplicar su gate.
- `agents/reviewer.md`, seccion "Compatibilidad de configuracion Marten: write-side vs read-side"
  (issue #447/PR #477): implementa el gate condicional que verifica, entre otros atributos,
  `Events.EventNamingStyle` y los tipos registrados via `AddEventTypes` entre el write-side y el
  worker de proyecciones -- este ADR es la autoridad de esa mecanica; el gate mismo no se reexplica
  aqui.
- Bitakora.ControlAsistencia issues #237 (analisis original y decision de purgar), #277 y PR #280
  (implementacion de campo, guardrails validados por mutacion), #268 (vecino de codigo) -- origen real
  de este ADR.

## Control de cambios

- 2026-07-31: creacion como `aceptado` (issue #474). Fija que la identidad de un evento persistido en
  Marten es el alias (columna `type`), no el nombre calificado (`mt_dotnet_type`); las dos columnas de
  `mt_events` y el mecanismo de `EventDocumentStorage.Resolve` que decide cual usar; la asimetria mover
  (namespace/assembly, `AddEventTypes`) vs renombrar (clase, `MapEventType`); que el `EventNamingStyle`
  vigente (`SmarterTypeName`) lo fija `Cosmos.EventSourcing.CritterStack`, no el default de Marten, y
  que ambos estilos solo divergen para tipos anidados (no para genericos top-level, precision propia
  verificada por decompilacion); las tres proscripciones de registro (no `MapEventType` para mover, no
  alterar el `EventNamingStyle` respecto del valor del paquete, no registrar el nombre calificado
  antiguo); que la lista de identidad es una fuente por dominio que cada `IDocumentStore` (write-side y
  worker) registra independientemente; los dos guardrails (derivado por reflexion sobre `Apply`; alias
  congelado sobre el contenedor real, nunca standalone) y el protocolo de dos despliegues para mover o
  renombrar un evento con streams ya escritos, incluida la regla de que una purga deliberada pertenece
  al mismo despliegue que el movimiento. Declara que el registro read-side sigue sin ser escribible hoy
  (MEF-ADR-0034 seccion 5) y fija la frontera de autoridad frente al gate de compatibilidad Marten
  write-side/read-side que `agents/reviewer.md` ya implementa (issue #447/PR #477): este ADR gobierna
  la identidad, ese gate la vigila bajo condicion. Todos los hechos tecnicos citados se reverificaron
  en este refinamiento por decompilacion propia con `ilspycmd` contra los ensamblados publicados
  (Marten 9.12.0, JasperFx.Events 2.18.1, Cosmos.EventSourcing.CritterStack 2.1.0/2.3.1), no solo contra
  lo ya registrado en MEF-ADR-0034 referencia [19].
- 2026-08-27: enmienda (issue #743). Nombra el skill `/purge-store` (`commands/purge-store.md`) como
  mecanismo canonico de ejecucion de la purga deliberada en dev que la seccion 5 punto 4 permite:
  diagnostico con evidencia (App Insights, smoke tests del ultimo deploy) antes de ofrecer la purga,
  confirmacion humana sobre el `--dry-run` real de `scripts/purge-store.sh` (issue #725) y validacion
  final relanzando los smoke tests fallidos. La regla de que la purga pertenece al mismo despliegue que
  el movimiento de tipos queda intacta -- este skill fija el **como**, no el **cuando**.
- 2026-10-07: enmienda (issue #2059). La seccion 4 declara que una guarda de lista exacta o conteo de
  los tipos persistidos no forma parte de los guardrails del marco: se elimina si el proyecto tiene el
  guardrail 1, o se reemplaza por el. La proteccion frente a borrado o renombre la da el guardrail 2. La
  seccion 6 (d) acota el alcance (tablas evento->topic y tests de dominio quedan fuera) y declara la
  frontera del guardrail 2 en eventos antiguos. Alternativas 5 y 6 registran lo descartado.
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts` que los reemplazaban y su invocacion con `node`. Sin cambio de doctrina.
