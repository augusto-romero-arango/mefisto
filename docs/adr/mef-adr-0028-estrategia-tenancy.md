# MEF-ADR-0028: Estrategia de tenancy — mono-tenant transitorio en greenfield y resolver real basado en TenantContext

- **Fecha**: 2026-07-19
- **Estado**: aceptado
- **Aplica a**: doctrina de tenancy del marco; gobierna al `domain-scaffolder` (registro del `ITenantContext` en el `Program.cs` que genera, ramificado por etapa), a `/onboard` (diagnostico informativo y escritura opt-in del token de deteccion) y a la familia `/install-workos` (issue #339, implementado)/`/install-apim` (issue #340, implementado: ejecuta la migracion automatizada (a)->(b) que fija la seccion 4, introducida por la enmienda del issue #337 y actualizada por la enmienda del issue #802 al patron `AsyncLocal` + middleware -- reescritura del paso pendiente en el issue #803)/`/install-auth` (issue #342, implementado: orquesta a los dos anteriores con un gate humano en medio). Cross-referencia MEF-ADR-0003 (stack ES Marten+Wolverine), MEF-ADR-0021 (infraestructura base), MEF-ADR-0023 (Bounded Context/topologia de ASB) y MEF-ADR-0032 (identidad y autenticacion en el borde WorkOS+APIM, fuente del insight de normalizacion de claims que habilita la seccion 4).

## Contexto

Un dominio scaffoldeado con los building blocks `Cosmos.Event*` actuales nace roto si su `Program.cs`
no registra un `ITenantContext`: en el consumidor Bitakora.ControlAsistencia, el upgrade de
`Cosmos.EventSourcing.CritterStack` `0.1.9 -> 2.1.0` dejo de auto-registrarlo y **toda** activacion de
funcion fallo con `InvalidOperationException: Unable to resolve service for type ...` sobre el
contrato de tenancy de `Cosmos.MultiTenancy` (el que en 3.1.0 es `ITenantContext`, MEF-ADR-0003) -> HTTP 500, detectado solo post-deploy por smoke tests (refs
consumidor: #207 upgrade, #219 fix).

Verificado decompilando (`ilspycmd`) los ensamblados de los paquetes `Cosmos.MultiTenancy*` 2.1.0
(paquetes privados del marco, sin documentacion publica -- la unica fuente verificable es el propio
ensamblado); el contrato se muestra en su forma vigente de 3.1.0, que lo renombra a `ITenantContext` y
le suma `OrganizationMembershipId` (delta de API medido en MEF-ADR-0003, issue #2394):

- **`Cosmos.MultiTenancy`** (namespace `Cosmos.MultiTenancy`) define el contrato, sin implementacion:

  ```csharp
  public interface ITenantContext
  {
      string TenantId { get; }
      string UserId { get; }
      string OrganizationMembershipId { get; }
  }
  ```

- **`Cosmos.MultiTenancy.AspNetCore`** aporta `TrustedHeadersTenantResolver` (lee `X-Tenant-Id`/
  `X-User-Id` de `IHttpContextAccessor`, lanza `InvalidOperationException` si el header falta) y la
  extension `AgregarTenantResolverConHeadersConfiables()` que registra
  `services.AddScoped<ITenantContext, TrustedHeadersTenantResolver>()`.
- **`Cosmos.MultiTenancy.CritterStack`** aporta `ProxyTenantResolver` (delega en
  `WolverineMessageContextTenantResolver` cuando corre dentro de un handler de Wolverine sin
  `HttpContext`, o en `TrustedHeadersTenantResolver` cuando si lo hay -- el hibrido HTTP + daemon de
  Wolverine) y la extension `AgregarTenantResolverHibrido()` que registra
  `services.AddScoped<ITenantContext, ProxyTenantResolver>()`. **Ambos exigen que el header o el
  `IMessageContext.TenantId` esten presentes**: si faltan, lanzan `InvalidOperationException` en vez
  de degradar a un default. Esa eleccion de rama, segun el hallazgo posterior del issue #802 (mas abajo
  en esta misma seccion), se toma **una sola vez, en el constructor** de `ProxyTenantResolver` -- no
  por-request -- lo que lo vuelve inservible para HTTP en Azure Functions isolated worker.

`Cosmos.EventSourcing.CritterStack` 3.1.0 depende transitivamente de `Cosmos.MultiTenancy` 3.1.0 (su
`.nuspec` declara `<dependency id="Cosmos.MultiTenancy" version="3.1.0" .../>`), asi que el contrato
`ITenantContext` ya esta disponible en el `.csproj` que genera `domain-scaffolder` sin agregar
ninguna referencia nueva -- lo que falta es **registrar una implementacion**.

Un proyecto recien scaffoldeado (greenfield) todavia no tiene autenticacion instalada: no existe
ningun `HttpContext` con headers confiables ni ningun `IMessageContext` con `TenantId` propagado. Si
el scaffold registrara `AgregarTenantResolverHibrido()` (o `AgregarTenantResolverConHeadersConfiables()`)
por defecto, la primera invocacion sin esos headers lanzaria la misma `InvalidOperationException` que
motivo este ADR -- solo que ahora por diseno, no por omision. El marco necesita una tercera opcion,
distinta de las dos que ya proveen los paquetes `Cosmos.MultiTenancy.*`: un resolver de **valores
fijos** que nunca lanza, para el escenario greenfield sin autenticacion.

### Hallazgo posterior: `ProxyTenantResolver` probado roto en Azure Functions isolated worker para HTTP (issue #802)

El incidente que motiva la enmienda del issue #802 ocurrio en el mismo consumidor,
Bitakora.ControlAsistencia, tras mergear su PR #545 (`/install-apim` completo, ejecutando la migracion
automatica de la seccion 4 vigente en ese momento): smoke tests en rojo masivo (Colaboradores 88/154;
Sedes en proporcion similar), `POST` respondiendo `409` con codigos `Guid.CreateVersion7()` frescos y
`GET` respondiendo `500`, **con los fixtures enviando `X-Tenant-Id: tenant-smoke`/`X-User-Id` correctos**
(issue consumidor #538).

Decompilando (`ilspycmd`) `Cosmos.MultiTenancy.CritterStack`/`Cosmos.MultiTenancy.AspNetCore` 2.3.0 se
confirmo la causa raiz: `ProxyTenantResolver` decide la rama HTTP/Wolverine **en su constructor**, no
por-request. En Azure Functions isolated worker, la cadena `FunctionEndpoint -> ICommandRouter ->
ITenantContext` se resuelve **antes** de que el `HttpContext` quede adjunto al scope de DI de la
invocacion (`IHttpContextAccessor.HttpContext` es null en ese instante), y Wolverine ademas genera sus
handlers en un `IServiceScope` propio, hijo de la raiz (`JasperFx LazyServiceLocationFrame`) -- ni
siquiera comparte el scope donde el framework de Functions si adjunta el `HttpContext`. El resultado:
**toda** request HTTP cae en la rama de Wolverine, aunque los headers `X-Tenant-Id`/`X-User-Id` esten
presentes.

Es ademas un catch-22 estructural para HTTP, no solo un problema de orden de resolucion:
`WolverineCommandRouter.InvokeAsync` invoca `TenancyDelivery.Build(tenantContext)` para **construir**
el envelope inicial del comando -- el `IMessageContext` no puede tener `TenantId` todavia en ese punto,
asi que ni siquiera esperar a que el pipeline avance un paso mas resolveria el problema: el resolver
debe conocer el tenant *antes* de que exista ningun envelope o `IMessageContext` del que leerlo.

Reproducido con `curl` contra dev: `POST /api/sedes` con headers correctos y un codigo
`Guid.CreateVersion7()` fresco -> `409` con el mensaje de `WolverineMessageContextTenantResolver`;
`GET /api/sedes/fichas/NO-EXISTE` -> `500`. Hotfix real: PR consumidor #546, que porto a
Bitakora.ControlAsistencia el patron de referencia de Cosmos.ControlPlane
(`src/Cosmos.ControlPlane.TenantResolver/`, ver seccion 4).

## Decision

### 1. Modelo de dos etapas

El `ITenantContext` de un dominio del marco vive en una de dos etapas, nunca en ambas a la vez:

- **(a) Mono-tenant transitorio (greenfield, sin autenticacion instalada)**: un resolver propio del
  dominio, de valores fijos, que implementa `Cosmos.MultiTenancy.ITenantContext` sin depender de
  `HttpContext` ni de `IMessageContext`. Es el que fija este ADR y el que genera `domain-scaffolder`
  por defecto.
- **(b) Resolver real basado en `TenantContext` de autenticacion**: cuando el proyecto instala una
  autenticacion que produce un `TenantContext` (tipicamente header-based via
  `Cosmos.MultiTenancy.AspNetCore.AgregarTenantResolverConHeadersConfiables()`, o -- para el camino de
  referencia del marco, WorkOS+APIM -- la biblioteca `AsyncLocal` + middleware que fija la seccion 4 de
  este ADR, que resuelve identidad tanto en requests HTTP como dentro de handlers de Wolverine sin
  depender de que el `HttpContext` este adjunto al scope de DI), se registra ese resolver real en su
  lugar.

**La etapa (a) es transitoria, no un estado permanente ni "el escenario de siempre".** Un dominio pasa
de (a) a (b) en el momento en que instala autenticacion fuerte que genera un `TenantContext`; a partir
de ahi, dejar el default mono-tenant seria incorrecto (todo tenant colapsaria a `*DEFAULT*` pese a que
la autenticacion ya sabe distinguir tenants reales).

### 2. Forma del resolver mono-tenant transitorio (etapa a)

```csharp
namespace <RootNamespace>.{PascalCase}.Infraestructura;

public class TenantResolverMonoTenantPorDefecto : ITenantContext
{
    public string TenantId => JasperFx.StorageConstants.DefaultTenantId;
    public string UserId => "usuario-no-autenticado";
    public string OrganizationMembershipId => "membresia-no-autenticada";
}
```

- **`TenantId`**: se fija a `JasperFx.StorageConstants.DefaultTenantId`, la constante que el propio
  Marten usa cuando ninguna tenencia explicita se especifica -- "If no explicit tenancy is specified,
  either via policies, mappings, scoped sessions or overloads, Marten will default to
  `StorageConstants.DefaultTenantId` with a constant value of `*DEFAULT*`" [1]. `JasperFx` (paquete
  publico, `DefaultTenantId = "*DEFAULT*"` verificado decompilando `JasperFx.dll` 2.18.1 [2]) ya es
  dependencia transitiva del scaffold via `Marten` 9.23.0 <- `Cosmos.EventSourcing.CritterStack`
  3.1.0: no agrega ninguna referencia nueva al `.csproj`. Usar el mismo default de Marten evita
  introducir un segundo tenant id inventado que solo confundiria en el event store.
- **`OrganizationMembershipId`**: se fija a la constante `"membresia-no-autenticada"`, por la misma razon que `UserId`: en greenfield no hay membresia que resolver. CritterStack 3.1.0 lee la propiedad en cada append (`UnitOfWorkMiddleware.Before()`) y en cada mensaje publicado, asi que el resolver de la etapa (a) debe devolver un valor, nunca lanzar.
- **`UserId`**: se fija al valor descriptivo `"usuario-no-autenticado"` -- no una persona real, sino
  una marca explicita en la metadata de eventos de que el evento se origino sin autenticacion. Encaja
  con que en greenfield, por definicion, aun no hay usuario autenticado que resolver.
- **Registro** (`Program.cs`, MEF-ADR-0021): `builder.Services.AddScoped<ITenantContext,
  TenantResolverMonoTenantPorDefecto>();`, mismo lifetime (`Scoped`) que usan
  `AgregarTenantResolverConHeadersConfiables()`/`AgregarTenantResolverHibrido()` para su propia
  implementacion -- consistente con el resto del contrato `ITenantContext`, sin fijar un lifetime
  distinto para el caso transitorio.
- El resolver **no** usa `AgregarTenantResolverHibrido()` ni `ProxyTenantResolver`/
  `TrustedHeadersTenantResolver`: esos mecanismos exigen headers/`IMessageContext.TenantId` y lanzan
  `InvalidOperationException` si faltan -- exactamente lo que rompe el escenario greenfield sin
  autenticacion que este ADR resuelve.
- El archivo lleva un `// TODO(tenancy etapa b)` explicito: cuando el proyecto instale autenticacion
  que produzca un `TenantContext`, reemplazar este resolver por el real de la etapa (b); no dejar el
  default mono-tenant una vez que exista esa autenticacion.

### 3. Deteccion de la etapa vigente: token declarativo `tenancy.strategy` (issue #323)

La eleccion entre (a) y (b) no se sondea en codigo: un grep del harness (agentes/scripts/commands/ADRs)
confirmo cero referencias a `MultiTenancy`/`TenantResolver`/`TenantContext`, asi que no hay ninguna señal
fiable que un agente pueda inspeccionar para inferir si el proyecto ya instalo autenticacion fuerte. La
etapa vigente se **declara**, en un token opcional de nivel superior en `.claude/harness.config.json`:

```json
"tenancy": { "strategy": "mono-tenant-transitorio" }
```

- `strategy`: `"mono-tenant-transitorio"` (etapa a, el default de este ADR) | `"multi-tenant-header"`
  (etapa b).
- **Ausente equivale a `"mono-tenant-transitorio"`** (etapa a): retrocompatible con todo consumidor
  existente y con el greenfield que aun no declara el campo.

**`/onboard`** reporta el valor de este token de forma puramente informativa -- ausente o con cualquiera
de los dos valores validos nunca es `FALTA`, solo `OK`/`NO VERIFICADO` (un greenfield legitimo vive en
etapa (a) por defecto, no es un estado incompleto) -- y gana un paso **opt-in** (tercero, junto a labels
y CI) que pregunta al usuario la estrategia vigente y **escribe/actualiza** `tenancy.strategy` en el
config, solo tras confirmacion explicita: `/onboard` no sondea codigo ni infiere la etapa por su cuenta.

**`domain-scaffolder`** lee `tenancy.strategy` inline con `scripts/json-value.mts` en su Paso 0 (mismo patron ya usado para
`serviceBus.external`, MEF-ADR-0024) y rama la generacion del `ITenantContext` que registra en
`Infraestructura/ComposicionServicios{Dominio}.cs`:

- **Etapa (a)** (ausente o `"mono-tenant-transitorio"`): genera `TenantResolverMonoTenantPorDefecto.cs`
  y su registro, exactamente como fija la seccion 2 de este ADR -- sin cambios.
- **Etapa (b)** (`"multi-tenant-header"`): en vez del default transitorio, referencia la biblioteca
  scaffoldeada `src/{RootNamespace}.TenantResolver/` (seccion 4: `TenantExecutionContext` +
  `TenantContextMiddleware` + las dos extensiones). **Si ya existe** en el repo consumidor (instalada por
  `/install-apim` sobre el BC, o por un dominio previo del mismo BC), el scaffold agrega el
  `ProjectReference` a `src/{RootNamespace}.TenantResolver/{RootNamespace}.TenantResolver.csproj` en el
  `.csproj` del dominio, invoca `services.AgregarTenantResolver...()` en
  `ComposicionServicios{Dominio}.cs` y agrega `builder.UsarTenantContextMiddleware()` en `Program.cs`
  -- sobre el `FunctionsApplicationBuilder` que devuelve `FunctionsApplication.CreateBuilder(args)` y
  antes de `builder.Build()`, no sobre ningun `app`: en el modelo isolated worker el middleware se
  registra en el `IFunctionsWorkerApplicationBuilder` [3], y el `Program.cs` que genera
  `domain-scaffolder` (MEF-ADR-0021) no expone ninguna otra variable --, exactamente como fija la
  seccion 4. **Si la
  biblioteca todavia no existe** (dominio scaffoldeado antes de instalar auth, o BC sin WorkOS+APIM
  todavia), el scaffold **degrada a "proponer"**: mantiene intacto el registro de
  `TenantResolverMonoTenantPorDefecto` de la etapa (a) (el contrato sigue registrado, el test de
  composicion de MEF-ADR-0029 sigue en verde) y agrega un `// TODO(tenancy etapa b)` que apunta a
  `/install-apim`/seccion 4 como el paso que crea la biblioteca y migra el registro. **La
  re-confirmacion por decompilacion del paquete que fijaba esta seccion ya no aplica**: la biblioteca es
  codigo propio del consumidor, generado por el harness -- no un paquete NuGet de terceros cuya firma
  haya que re-verificar version a version --; lo unico que el scaffold verifica es que el directorio
  `src/{RootNamespace}.TenantResolver/` exista en el repo. El `// TODO(tenancy claims)` de mapping de
  claims que esta seccion documentaba para el auto-cableo generico **no aplica a este patron**: la
  seccion 4 fija que `TenantContextMiddleware` ya sabe leer los headers canonicos `X-Tenant-Id`/
  `X-User-Id` (HTTP) y las `ApplicationProperties` `tenant-id`/`user_id` (Service Bus) sin parsing
  adicional por dominio, igual que ya explicaba MEF-ADR-0032 seccion 5 para el patron previo. En
  cualquiera de las dos ramas (referenciar la biblioteca o fallback a "proponer") el `ITenantContext`
  debe quedar **registrado y construible**: el test de composicion del contenedor (MEF-ADR-0029) resuelve
  los tres routers, que dependen de `ITenantContext` en su constructor, y es un gate duro del scaffold --
  si el fallback deja el contrato sin registrar, ese test revienta (reintroduciendo el incidente #318).
  El fallback registra el resolver transitorio de la etapa (a) como placeholder para no romperlo.

**Limite manual, salvo el camino automatizado de la seccion 4**: pasar un dominio ya scaffoldeado de
(a) a (b) sigue siendo manual para cualquier autenticacion fuera del camino WorkOS+APIM -- actualizar
el token y volver a correr `/scaffold` no re-scaffoldea dominios existentes. El
`// TODO(tenancy etapa b)` que deja `TenantResolverMonoTenantPorDefecto.cs` (seccion 2) sigue siendo el
recordatorio en el codigo generado para ese caso manual. Cuando la autenticacion instalada es WorkOS
AuthKit + Azure API Management (MEF-ADR-0032), la seccion 4 de este ADR fija esa instalacion como la
transicion (a)->(b) concreta, ejecutada por `/install-apim` -- deja de ser manual **en ese camino
especifico**.

### 4. Transicion automatizada (a)->(b) via WorkOS+APIM: biblioteca `AsyncLocal` + middleware (issue #337, enmendada issue #802)

MEF-ADR-0032 (identidad y autenticacion en el borde) fija WorkOS AuthKit + Azure API Management como
el patron de referencia del marco para instalar autenticacion real sobre un BC, y en su seccion 4/5
establece que la politica global de APIM normaliza los claims del JWT a los headers canonicos
`X-Tenant-Id`/`X-User-Id` **antes** de que el request llegue a cualquier Function App -- ese mapping
vive una sola vez, en la politica del gateway, no repetido por dominio. Ese insight sigue vigente y
sigue siendo lo que vuelve automatizable, especificamente para ese camino, la transicion (a)->(b) que
el resto de esta seccion deja manual; lo que enmienda el issue #802 es **como** se consume ese header
dentro de cada dominio -- ya no via `Cosmos.MultiTenancy.CritterStack.AgregarTenantResolverHibrido()`,
probado roto en Azure Functions isolated worker (ver "Contexto", hallazgo del issue #802), sino via una
biblioteca propia scaffoldeada por dominio consumidor.

- **La transicion concreta**: instalar WorkOS+APIM (MEF-ADR-0032) **es** la transicion (a)->(b)
  concreta del BC. La ejecuta el skill `/install-apim` (issue #340, implementado -- `commands/install-apim.md`;
  invocable directo o, orquestado por `/install-auth` (issue #342, implementado -- `commands/install-auth.md`)
  junto a `/install-workos`). En ese camino especifico, la transicion **deja de ser manual**. La
  reescritura del paso de migracion del resolver al patron de esta enmienda es alcance del issue #803:
  hasta que ese issue se implemente, este ADR fija la doctrina objetivo por delante del codigo del skill.
- **La biblioteca `src/{RootNamespace}.TenantResolver/`**: se scaffoldea en el repo consumidor -- no se
  empaqueta como NuGet (decision de la sesion de planeacion del issue #802), igual que el hotfix real
  del consumidor (PR #546), que porto el codigo de referencia de Cosmos.ControlPlane
  (`src/Cosmos.ControlPlane.TenantResolver/`) con sus tests. Componentes:
  - **`TenantExecutionContext : ITenantContext`**: singleton **sin estado de instancia** -- respalda
    `TenantId`/`UserId` en campos `AsyncLocal<string>` **estaticos**, no en campos de instancia, porque
    `AsyncLocal` fluye con la cadena logica de ejecucion asincrona, no con el `IServiceScope` de DI: a
    diferencia de `ProxyTenantResolver`, no importa que Wolverine construya sus handlers en un
    `IServiceScope` propio (`JasperFx LazyServiceLocationFrame`) -- el valor sigue disponible porque
    viaja con el `async`/`await` del request, no con el contenedor. Los getters **fallan ruidosamente**
    (lanzan si se leen antes de que el middleware los puebla) en vez de degradar en silencio a un
    default -- mismo principio de fail-fast que ya fijaba este ADR para `ProxyTenantResolver`/
    `TrustedHeadersTenantResolver` en "Contexto". `OrganizationMembershipId` es estricto igual que `TenantId`/`UserId`: lanza si nadie lo poblo, porque CritterStack 3.1.0 lo lee en cada append (`UnitOfWorkMiddleware.Before()`) y cada mensaje publicado. Expone `SetDerivedIdentity(tenantId, userId, organizationMembershipId)` -- el tercer parametro es obligatorio -- para
    triggers sin identidad del gateway (p. ej. un timer trigger, o un Service Bus trigger de un evento
    interno sin claim de usuario): el propio handler deriva y fija la identidad antes de que el codigo
    de negocio la lea.
  - **`TenantContextMiddleware : IFunctionsWorkerMiddleware`**: puebla el `AsyncLocal` al inicio de
    **cada** invocacion, antes de que se ejecute la funcion -- y por tanto antes de que se construya
    ninguna de las dependencias que el codigo de la funcion resuelve, porque el activador de la funcion
    corre en el ultimo middleware del pipeline del worker (`FunctionExecutionMiddleware` [3]) --
    exactamente lo que resuelve el catch-22 documentado en "Contexto": para requests HTTP, lee los
    headers `X-Tenant-Id`/`X-User-Id`/`X-Organization-Membership-Id` de `FunctionContext.GetHttpContext()`;
    para triggers de Service Bus, lee las `ApplicationProperties` `tenant-id`/`user_id`/
    `organization_membership_id` del mensaje via
    `BindInputAsync<ServiceBusReceivedMessage>()`. Al correr como middleware del *worker* (no del
    request pipeline de ASP.NET Core), se ejecuta antes de que `FunctionEndpoint -> ICommandRouter ->
    ITenantContext` resuelva nada -- el `AsyncLocal` ya tiene el valor correcto para cuando cualquier
    router lo lee, incluido dentro de `TenancyDelivery.Build(tenantContext)`.
  - **Dos extensiones**: `AgregarTenantResolver...()` (seam de composicion, registra
    `TenantExecutionContext` como `ITenantContext` -- singleton, no scoped: el estado real vive en el
    `AsyncLocal`, no en el ciclo de vida de DI) y `UsarTenantContextMiddleware()` (extension sobre
    `IFunctionsWorkerApplicationBuilder`, azucar sobre `UseMiddleware<TenantContextMiddleware>()` [3],
    invocada desde `Program.cs` sobre el `FunctionsApplicationBuilder` antes de `builder.Build()`).
  - **Tests**: cruce de scope async (verifica que el valor puesto por el middleware sigue visible tras
    cruzar `await`s reales del pipeline de Wolverine/Functions, incluido dentro del `IServiceScope` hijo
    que crea Wolverine) y fallo ruidoso (verifica que los getters lanzan si se leen sin que el middleware
    los haya poblado antes).
- **Que automatiza `/install-apim`** (issue #803, reescritura del paso 9): al instalar el modulo APIM,
  el skill ejecuta, sin intervencion humana adicional:
  1. **Flip del token**: `tenancy.strategy` en `.claude/harness.config.json` pasa de
     `"mono-tenant-transitorio"` a `"multi-tenant-header"` (o se agrega, si estaba ausente).
  2. **Scaffold de la biblioteca** `src/{RootNamespace}.TenantResolver/` (si no existe ya en el BC).
  3. **Migracion del resolver en todos los dominios ya scaffoldeados** del BC: cada
     `Infraestructura/ComposicionServicios{Dominio}.cs` que registraba
     `services.AddScoped<ITenantContext, TenantResolverMonoTenantPorDefecto>()` (seccion 2)
     pasa a invocar `services.AgregarTenantResolver...()` (bullet anterior), cada `.csproj` de dominio
     suma el `ProjectReference` a la biblioteca y cada `Program.cs` agrega
     `builder.UsarTenantContextMiddleware()` antes de `builder.Build()`; se elimina el archivo
     `TenantResolverMonoTenantPorDefecto.cs`
     junto con su `// TODO(tenancy etapa b)` de cada dominio migrado -- no uno a la vez via `/scaffold`,
     sino en un solo paso sobre todos los dominios existentes del BC.
- **Sin mapping por dominio**: a diferencia del auto-cableo generico que describe la seccion 3 (donde
  el `// TODO(tenancy claims)` queda project-specific porque ningun paquete del marco sabe de donde
  sale cada claim), la migracion via `/install-apim` **no requiere ese mapping por dominio**:
  MEF-ADR-0032 seccion 4 ya fija, en la politica global de APIM, el mapping `user_email -> X-User-Id`
  / `tenant_id -> X-Tenant-Id` con anti-spoofing (`exists-action="override"`) -- un unico lugar,
  compartido por todos los dominios del BC. El `// TODO(tenancy claims)` que dejaria un auto-cableo
  generico queda **resuelto por construccion**: `TenantContextMiddleware` ya lee exactamente esos dos
  headers canonicos, y `/install-apim` no necesita generar ni proponer ningun snippet de parsing de
  claims especifico del proyecto.
- **El gate no se relaja, y por que MEF-ADR-0029 no atrapo este fallo**: el test de composicion del
  contenedor DI (MEF-ADR-0029) sigue siendo un gate duro despues de la migracion -- resuelve los tres
  routers (`ICommandRouter`, `IPrivateEventSender`, `IPrivateEventRouter`), que dependen de
  `ITenantContext` en su constructor, y debe seguir en verde en cada dominio migrado. `/install-apim`
  migra el resolver de forma que el contrato quede **registrado y construible** en el mismo commit, sin
  ninguna ventana donde el contenedor quede sin `ITenantContext` resuelto. **MEF-ADR-0029 no atrapo el
  fallo de `ProxyTenantResolver`** (issue #802) porque es un gate de **composicion** (¿el grafo de DI
  construye? ¿los tres routers resuelven sin excepcion?), no un gate de **comportamiento en runtime**:
  en el test de composicion, `IHttpContextAccessor` esta registrado y `ProxyTenantResolver` se
  construye sin lanzar -- no hay ninguna request HTTP real en vuelo cuya ausencia de `HttpContext` en
  construccion pudiera manifestar el bug. El fallo solo aparece cuando el proceso completo del host
  recibe una request HTTP real y `IHttpContextAccessor.HttpContext` sigue siendo null en el instante
  exacto en que el contenedor construye `ProxyTenantResolver` -- exactamente la clase de fallo (arranque
  real del host, timing de request) que MEF-ADR-0029 ("Consecuencias", "Negativas") ya documenta como
  **fuera** de su alcance ("no cubre el arranque real del host... eso lo sigue cubriendo exclusivamente
  el smoke test post-deploy"). El gate se mantiene igual a proposito: extenderlo para simular un
  `HttpContext` real reintroduciria el Alt 1 que MEF-ADR-0029 ya descarto (levantar el proceso real del
  host, sin equivalente a `WebApplicationFactory` en Azure Functions isolated worker) -- el patron
  `AsyncLocal` + middleware de esta enmienda cierra el fallo por diseno (no depende de si `HttpContext`
  esta adjunto en construccion), sin exigirle a MEF-ADR-0029 un alcance que su propio ADR ya declino
  cubrir. El levantamiento del limite "(a)->(b) manual" que fija esta seccion aplica **unicamente** al
  camino WorkOS+APIM: un BC que instale cualquier otra autenticacion (Entra External ID, un IdP propio,
  etc.) sigue sujeto al limite manual descrito arriba.

## Alternativas consideradas

### Alt 1: no registrar ningun `ITenantContext` por defecto, documentar que el consumidor debe hacerlo

**Descartada**: es el estado actual que origino el incidente en Bitakora.ControlAsistencia -- un
dominio scaffoldeado nace roto (`InvalidOperationException` en la primera invocacion, HTTP 500) y el
problema solo se detecta post-deploy via smoke tests. El scaffold debe producir un proyecto que
arranca, no uno que exige un paso manual documentado en otro lado para no romperse.

### Alt 2: registrar `AgregarTenantResolverHibrido()` (`ProxyTenantResolver`) por defecto en el scaffold, o cablearlo en la transicion (a)->(b)

**Descartada, primero por diseno y ahora ademas por evidencia**: en greenfield sin autenticacion,
`ProxyTenantResolver` exige un `HttpContext` con headers confiables o un `IMessageContext.TenantId`
propagado -- ninguno de los dos existe en un dominio recien scaffoldeado, asi que cablearlo por defecto
reintroduciria la misma clase de fallo que origino este ADR. La enmienda del issue #802 confirma ademas
que el problema no se limita al caso greenfield: `ProxyTenantResolver` decide la rama HTTP/Wolverine
**en su constructor**, y en Azure Functions isolated worker esa decision ocurre antes de que el
`HttpContext` quede adjunto al scope de la invocacion (ver "Contexto", hallazgo del issue #802) -- roto
**incluso con autenticacion instalada y headers presentes**. Es la causa real del incidente en
Bitakora.ControlAsistencia (2026-09-01, tras el PR consumidor #545): smoke tests en rojo masivo, `POST`
respondiendo `409` falsos y `GET` respondiendo `500`, con `X-Tenant-Id`/`X-User-Id` correctos en cada
request. Descartado tambien como mecanismo de la transicion (a)->(b) (seccion 4), reemplazado por la
biblioteca `AsyncLocal` + middleware.

### Alt 3: un solo resolver "inteligente" que intente headers/`TenantContext` y caiga a mono-tenant si no los encuentra

**Descartada**: mezclaria las dos etapas en una sola implementacion con logica condicional oculta,
contra el principio de este ADR de que la eleccion entre (a) y (b) sea explicita y visible en el
`Program.cs` (una linea de registro, un tipo concreto). Ademas oscureceria el momento exacto en que un
proyecto matura de (a) a (b), que es precisamente lo que el token declarativo `tenancy.strategy`
(seccion 3) permite detectar sin ambiguedad.

## Consecuencias

### Positivas

- **Un dominio recien scaffoldeado arranca sin `InvalidOperationException` de `ITenantContext`**: CA-2
  del issue #318 queda satisfecho por construccion.
- **La eleccion de etapa queda explicita y visible**: una unica linea de registro en `Program.cs` y un
  tipo concreto en `Infraestructura/`, sin logica condicional oculta.
- **Reusa el mismo default de tenant que ya usa Marten** (`*DEFAULT*`) en vez de inventar un segundo
  valor, evitando confusion en el event store.
- **El camino WorkOS+APIM (MEF-ADR-0032) cierra el riesgo de bug silencioso de la seccion "Negativas"
  para ese caso**: `/install-apim` (seccion 4) automatiza el flip del token y la migracion del resolver
  de todos los dominios ya scaffoldeados en un solo paso, sin dejar una ventana donde un humano deba
  recordar declarar el cambio.

### Negativas

- **El default mono-tenant es un estado que hay que recordar reemplazar, fuera del camino
  WorkOS+APIM**: si un proyecto instala una autenticacion distinta de WorkOS+APIM (MEF-ADR-0032) y
  nadie actualiza `tenancy.strategy` (y vuelve a scaffoldear o migra a mano el dominio), el dominio
  sigue funcionando (no rompe) pero **todo** evento se atribuye a `*DEFAULT*`/`"usuario-no-autenticado"`
  aunque ya haya usuarios/tenants reales identificables -- un bug silencioso de negocio, no un crash. El
  `// TODO(tenancy etapa b)` y el diagnostico informativo de `/onboard` (seccion 3) mitigan esto, pero
  no lo hacen imposible en ese camino manual: pasar de (a) a (b) sigue exigiendo que un humano declare
  el cambio. Cuando el proyecto instala WorkOS+APIM, la seccion 4 elimina esta consecuencia:
  `/install-apim` ejecuta la migracion completa (token + resolver de todos los dominios) por
  construccion, sin depender de que un humano recuerde el paso manual.

## Referencias

- **[1]** "Multi-Tenancy" -- Marten docs (martendb.io). "If no explicit tenancy is specified, either
  via policies, mappings, scoped sessions or overloads, Marten will default to
  `StorageConstants.DefaultTenantId` with a constant value of `*DEFAULT*`."
  https://martendb.io/documents/multi-tenancy.html
- **[2]** `JasperFx.StorageConstants` -- codigo fuente publico de JasperFx (github.com/JasperFx/jasperfx,
  `src/JasperFx/StorageConstants.cs`): `public const string DefaultTenantId = "*DEFAULT*";`. Verificado
  ademas decompilando con `ilspycmd` el ensamblado `JasperFx.dll` 2.18.1 (version resuelta
  transitivamente por `Marten` 9.12.0, dependencia de `Cosmos.EventSourcing.CritterStack` 2.1.0).
- **[3]** `MiddlewareWorkerApplicationBuilderExtensions.UseMiddleware<T>` e `IFunctionsWorkerMiddleware`
  -- Microsoft Learn (.NET API docs, `Microsoft.Azure.Functions.Worker.Core`):
  `public static IFunctionsWorkerApplicationBuilder UseMiddleware<T>(this IFunctionsWorkerApplicationBuilder builder) where T : class, IFunctionsWorkerMiddleware`.
  El middleware del worker se registra sobre el builder (el `FunctionsApplicationBuilder` que devuelve
  `FunctionsApplication.CreateBuilder(args)` lo implementa), antes de `Build()`; el activador de la
  funcion corre en el ultimo middleware del pipeline (`FunctionExecutionMiddleware`), de modo que todo
  middleware registrado antes se ejecuta antes de que se construyan las dependencias de la funcion.
  https://learn.microsoft.com/dotnet/api/microsoft.extensions.hosting.middlewareworkerapplicationbuilderextensions.usemiddleware
  y https://learn.microsoft.com/azure/azure-functions/dotnet-isolated-process-guide#middleware
- `Cosmos.MultiTenancy` / `Cosmos.MultiTenancy.AspNetCore` / `Cosmos.MultiTenancy.CritterStack` 2.1.0:
  paquetes privados del marco sin documentacion publica; el contrato `ITenantContext` y las
  implementaciones `TrustedHeadersTenantResolver`/`ProxyTenantResolver`/
  `WolverineMessageContextTenantResolver` citados en este ADR se verificaron decompilando con
  `ilspycmd` los ensamblados de la version 2.1.0 (misma version que fija MEF-ADR-0003/issue #312 para
  el resto del stack `Cosmos.Event*`). El renombre a `ITenantContext` y la propiedad
  `OrganizationMembershipId` de la version 3.1.0 vigente se midieron por diff de API publica en
  MEF-ADR-0003 (issue #2394).
- MEF-ADR-0003 (stack ES Marten+Wolverine): fija Marten como event store del marco; este ADR reusa su
  constante de tenant por defecto.
- MEF-ADR-0021 (infraestructura base): el registro del resolver vive en el `Program.cs` que genera
  `domain-scaffolder` como parte del scaffold de cada dominio.
- MEF-ADR-0023 (Bounded Context, topologia de ASB): contexto organizativo del scaffolding de dominios
  al que este ADR aplica.
- MEF-ADR-0032 (identidad y autenticacion en el borde, WorkOS AuthKit + Azure API Management): fija el
  patron que la seccion 4 de este ADR adopta como transicion (a)->(b) automatizada; su seccion 4/5 es
  la fuente del insight de normalizacion de claims en el borde.
- MEF-ADR-0029 (test de composicion del contenedor DI): gate duro que la seccion 4 de este ADR confirma
  que sigue vigente tras la migracion automatizada; la enmienda del issue #802 documenta ademas por que
  no atrapo el fallo de `ProxyTenantResolver`, sin relajarlo.
- Bitakora.ControlAsistencia issues #207 (upgrade `Cosmos.EventSourcing.CritterStack` 0.1.9 -> 2.1.0)
  y #219 (fix del incidente): origen real del vacio que este ADR cierra.
- issue #337 (enmienda original de la seccion 4) e issue #340 (`/install-apim`, implementado --
  `commands/install-apim.md`): origen y consumidor concreto de la seccion 4.
- `Cosmos.MultiTenancy.CritterStack`/`Cosmos.MultiTenancy.AspNetCore` 2.3.0: version decompilada para
  el hallazgo del issue #802 (ver "Contexto") -- confirma que `ProxyTenantResolver` decide la rama
  HTTP/Wolverine en su constructor, no por-request; supera la verificacion previa de la version 2.1.0
  citada en la creacion de este ADR.
- Bitakora.ControlAsistencia issue #538 (incidente real: smoke tests en rojo tras `/install-apim`) y
  PRs #545 (instalacion completa que expuso el bug) / #546 (hotfix, porta a Bitakora.ControlAsistencia
  el patron `AsyncLocal` + middleware de Cosmos.ControlPlane): origen real de la enmienda del issue #802.
- `Cosmos-SincoERP/Cosmos.ControlPlane`, `src/Cosmos.ControlPlane.TenantResolver/`: implementacion de
  referencia del patron `AsyncLocal` + middleware que adopta la enmienda del issue #802.
- issue #802 (esta enmienda): reemplaza el mecanismo de la transicion (a)->(b) de la seccion 4 por la
  biblioteca `AsyncLocal` + middleware, documenta el incidente Bitakora.ControlAsistencia como evidencia
  y explica por que MEF-ADR-0029 no atrapa este fallo. Bloquea al issue #803 (reescritura del paso 9 de
  `/install-apim`) y al issue #804 (rama etapa (b) y fallback CA-7 de `domain-scaffolder`).

## Control de cambios

- 2026-07-19: creacion como `aceptado` (issue #318). Fija el modelo de dos etapas de tenancy (mono-tenant
  transitorio en greenfield / resolver real basado en `TenantContext`) y la forma concreta del resolver
  de la etapa (a) que `domain-scaffolder` registra por defecto. Bloquea al issue #323 (deteccion de la
  etapa vigente en `onboard`/`scaffold`).
- 2026-07-19: enmienda (issue #323). Operacionaliza la deteccion de la etapa vigente: token declarativo
  `tenancy.strategy` (opcional, ausente = etapa a) en `harness.config.json`, reportado informativamente
  por `/onboard` (nunca `FALTA`) y escrito bajo confirmacion en un tercer paso opt-in. `domain-scaffolder`
  lee el token inline con `jq` en su Paso 0 y rama el `ITenantResolver` que registra: etapa (a) sin
  cambios, etapa (b) auto-cablea `AgregarTenantResolverHibrido()` (`Cosmos.MultiTenancy.CritterStack`),
  sujeto a re-verificar tipo/firma contra la version vigente del paquete y a degradar a "proponer" si el
  resolver no resulta generico para el proyecto, dejando un `// TODO(tenancy claims)` para el mapping
  claims -> `TenantContext` (siempre project-specific).
- 2026-07-22: enmienda (issue #337). Fija la seccion 4, "Transicion automatizada (a)->(b) via
  WorkOS+APIM": instalar WorkOS+APIM (MEF-ADR-0032) es la transicion (a)->(b) concreta, ejecutada por
  el futuro skill `/install-apim` (via `/install-auth`), que automatiza el flip de `tenancy.strategy`,
  la migracion del resolver de todos los dominios ya scaffoldeados
  (`TenantResolverMonoTenantPorDefecto` -> `AgregarTenantResolverHibrido()`, removiendo el archivo
  transitorio y su `// TODO(tenancy etapa b)`) y no requiere mapping de claims por dominio (resuelto
  por construccion via la normalizacion de claims en la politica global de APIM, MEF-ADR-0032 seccion
  4/5); el test de composicion (MEF-ADR-0029) sigue siendo gate duro. El limite "(a)->(b) manual" de
  la seccion 3 se acota explicitamente al camino WorkOS+APIM: para cualquier otra autenticacion, sigue
  siendo manual. Se ajustan en el cuerpo el parrafo "Limite deliberado" (seccion 3) y la consecuencia
  negativa del bug silencioso, sin marcarlos obsoletos.
- 2026-07-22: implementacion (issue #340). El skill `/install-apim` (`commands/install-apim.md`) ejecuta
  la transicion automatizada (a)->(b) que fija la seccion 4: invoca `apim-gateway-scaffolder` (#335) para
  el modulo APIM, luego el flip de `tenancy.strategy` y la migracion del resolver de todos los dominios
  ya scaffoldeados del BC, gateada en cada dominio por el test de composicion (MEF-ADR-0029). Se
  actualizan en el cuerpo ("Aplica a", seccion 4, Referencias) las menciones a `/install-apim` de "aun no
  implementado" a implementado, sin marcarlas obsoletas -- ninguna decision de este ADR cambia.
- 2026-07-22: implementacion (issue #342). El skill `/install-auth` (`commands/install-auth.md`) orquesta
  `/install-workos` y `/install-apim` (la transicion (a)->(b) de la seccion 4) en el orden correcto, con
  un gate humano en medio que verifica que `WORKOS_CLIENT_ID`/`WORKOS_API_KEY` existen antes de arrancar
  la migracion de tenancy. Se actualizan en el cuerpo ("Aplica a", seccion 4) las menciones a
  `/install-auth` de "aun no implementado"/"a futuro" a implementado, sin marcarlas obsoletas -- ninguna
  decision de este ADR cambia.
- 2026-09-01: enmienda (issue #802). Reemplaza el mecanismo de la transicion (a)->(b) de la seccion 4:
  ya no cablea `Cosmos.MultiTenancy.CritterStack.AgregarTenantResolverHibrido()` (`ProxyTenantResolver`),
  probado roto en Azure Functions isolated worker -- decide la rama HTTP/Wolverine en su constructor,
  antes de que `HttpContext` quede adjunto al scope de la invocacion, y arrastra un catch-22 estructural
  para HTTP (`WolverineCommandRouter.InvokeAsync` construye el envelope inicial via
  `TenancyDelivery.Build(tenantResolver)` antes de que exista ningun `IMessageContext` del que leer
  `TenantId`). El nuevo mecanismo: una biblioteca scaffoldeada por dominio consumidor,
  `src/{RootNamespace}.TenantResolver/` (`TenantExecutionContext : ITenantResolver` respaldado por
  `AsyncLocal` estatico con getters de fallo ruidoso y `SetDerivedIdentity()`, `TenantContextMiddleware :
  IFunctionsWorkerMiddleware` que puebla el contexto al inicio de cada invocacion via headers HTTP o
  `ApplicationProperties` de Service Bus, y dos extensiones de composicion), fiel al patron de referencia
  ya validado en produccion en Cosmos.ControlPlane (`src/Cosmos.ControlPlane.TenantResolver/`). Documenta
  el incidente real en Bitakora.ControlAsistencia (2026-09-01, tras el PR consumidor #545) como evidencia
  en "Contexto", y explica por que el gate de composicion del contenedor (MEF-ADR-0029) no atrapo este
  fallo -- es un gate de composicion (el grafo de DI construye), no de comportamiento en runtime bajo una
  request HTTP real -- sin relajarlo. La seccion 3 (rama etapa (b) de `domain-scaffolder`) queda
  alineada: referencia la biblioteca si ya existe en el repo consumidor, degrada a "proponer" con un
  placeholder construible si no; la re-confirmacion por decompilacion del paquete que fijaba la version
  anterior de esta seccion deja de aplicar (la biblioteca es codigo propio del harness, no un paquete
  NuGet de terceros); el cableado concreto queda fijado como `ProjectReference` a la biblioteca +
  `services.AgregarTenantResolver...()` en `ComposicionServicios{Dominio}.cs` +
  `builder.UsarTenantContextMiddleware()` en `Program.cs`, sobre el `FunctionsApplicationBuilder` y antes
  de `builder.Build()` (referencia [3]: en el modelo isolated worker el middleware se registra en el
  `IFunctionsWorkerApplicationBuilder`, no en un `app` de ASP.NET Core). Alt 2 pasa de alternativa
  descartada por diseno (greenfield sin headers) a ademas
  descartada por evidencia (rota incluso con autenticacion instalada y headers presentes). Elimina del
  cuerpo la prescripcion de `AgregarTenantResolverHibrido()` en las secciones 3 y 4 (no la marca
  obsoleta; el rastro queda en este control de cambios). Bloquea al issue #803 (reescritura del paso 9 de
  `/install-apim`, que hasta que ese issue se implemente sigue ejecutando el mecanismo anterior) y al
  issue #804 (rama etapa (b) y fallback CA-7 de `domain-scaffolder`).
  Se alinea ademas la seccion 5 de MEF-ADR-0032, que describia la etapa (b) de este ADR como cableada con
  el hibrido -- descripcion que la enmienda vuelve falsa --, sin cambiar ninguna decision de ese ADR.
- 2026-10-13: enmendado (issue #2399) para alinear la doctrina con `Cosmos.MultiTenancy` 3.1.0 (issue #2394): `ITenantResolver` pasa a `ITenantContext` en todo el cuerpo y la seccion 4 fija la semantica de `OrganizationMembershipId` (getter estricto, `SetDerivedIdentity` de tres parametros, constante `"membresia-no-autenticada"` en la etapa (a) y su motivo).
- 2026-11-12: la seccion de `domain-scaffolder` cita `scripts/json-value.mts` como lector inline de `tenancy.strategy` en lugar de `jq`, que los bloques de bash del markdown ya no usan (MEF-ADR-0057, decision 9). Sin cambio de doctrina.
