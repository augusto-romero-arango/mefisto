# Ejemplos de comentarios

Mal y bien con codigo del marco, por lenguaje. El criterio es el de
[SKILL.md](SKILL.md) y MEF-ADR-0044: se queda lo que quien lee el codigo no veria en el, en una
frase si se puede.

## C#

### Narracion del codigo (se borra)

```csharp
// Mal
// Incrementa el contador de intentos en uno.
intentos++;

// Marca el turno como cerrado.
estado = EstadoTurno.Cerrado;
```

```csharp
// Bien
intentos++;
estado = EstadoTurno.Cerrado;
```

### Rationale obvio por el nombre (se borra)

```csharp
// Mal
// Validamos que el turno exista antes de cerrarlo, porque no tiene sentido
// cerrar algo que no existe.
if (turno is null)
{
    throw new TurnoInexistenteException(turnoId);
}
```

```csharp
// Bien
if (turno is null)
{
    throw new TurnoInexistenteException(turnoId);
}
```

### Provenance y cita de ADR sola (se borra)

El origen del codigo vive en el commit y en el PR. Una cita sola dice de donde vino la
decision, no que restriccion rige hoy.

```csharp
// Mal
// HU-42
// MEF-ADR-0028
public class TenantResolverHibrido : ITenantContext
{
    ...
}
```

```csharp
// Bien
public class TenantResolverHibrido : ITenantContext
{
    ...
}
```

### Precision que la firma no da (se queda, en una frase)

El significado de `null` y si un limite es inclusivo o exclusivo no se leen en el tipo. Una
unidad que cabe en el nombre va en el nombre (ver el ejemplo siguiente).

```csharp
// Mal
public DateTimeOffset? Hasta { get; init; }
```

```csharp
// Bien
// null = vigencia sin fin; el limite es exclusivo.
public DateTimeOffset? Hasta { get; init; }
```

### Si el comentario es mas preciso que el nombre, se acorta el nombre

```csharp
// Mal
// Segundos que dura el token antes de expirar, sin contar el refresco.
public int Duracion { get; init; }
```

```csharp
// Bien
public int DuracionTokenSegundos { get; init; }
```

### Falta un porque (hallazgo de revision)

Quien revise marca tambien la falta: sin la frase, la proxima edicion "simplifica" el orden.

```csharp
// Mal
await guardarEventos();
await publicarEnBus();
```

```csharp
// Bien
// Primero persistir: si el bus falla, el reintento republica desde el store; al reves se perderia el evento.
await guardarEventos();
await publicarEnBus();
```

### Restriccion no obvia, blindada (se queda tal cual)

Comentario junto al test de composicion del contenedor DI que documenta el limite de
`ValidateOnBuild` (MEF-ADR-0029). Es blindado: no se borra ni se acorta (MEF-ADR-0044
seccion 4).

```csharp
// Limite conocido (MEF-ADR-0029): ValidateOnBuild NO valida open generics ni el interior de
// registros por factory-lambda (AddScoped(sp => ...)), de los que Wolverine/Marten registran
// muchos -- cubre los registros por tipo mapeado (los routers de abajo). Por eso los tres
// routers se resuelven explicitamente: es el complemento que ejercita tambien lo que
// ValidateOnBuild no puede validar de forma estatica.
public class ComposicionContenedorTests
{
    ...
}
```

### Guardrail de scaffolder (se queda tal cual)

Texto que emite `agents/projections-scaffolder.md`. Parece un `using` redundante, y borrarlo
rompe la compilacion con `CS1061`.

```csharp
using Microsoft.Extensions.DependencyInjection;
// 'using OpenTelemetry;' NO es opcional ni redundante con los dos de abajo: ConfigureResource y
// WithTracing son extension methods de OpenTelemetryBuilderSdkExtensions, que vive en el namespace
// raiz OpenTelemetry (no en OpenTelemetry.Trace). Sin esta linea, ambas llamadas fallan con CS1061.
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
```

## HCL

### Un porque de topologia (se queda)

Modulo `service-bus` de `agents/infra-base-scaffolder.md`. La topologia de enrutamiento vive en
los comentarios HCL (MEF-ADR-0027), asi que el comentario es blindado y ademas lleva el porque que
el recurso no muestra: sin el, un productor que deja la clave solo en el body nunca entrega.

```hcl
# Bien
resource "azurerm_servicebus_subscription_rule" "correlation_filters" {
  for_each = {
    for k, v in local.subscriptions_map : k => v
    if v.correlation_filter != null
  }
  name            = "correlation-filter"
  subscription_id = azurerm_servicebus_subscription.subs[each.key].id
  filter_type     = "CorrelationFilter"

  # El filtro no evalua el body: el productor estampa la clave de enrutamiento como application
  # property al publicar (MEF-ADR-0027).
  correlation_filter {
    properties = each.value.correlation_filter
  }
}
```

### Narracion del recurso (se borra)

```hcl
# Mal
# Crea el resource group para el dominio.
resource "azurerm_resource_group" "dominio" {
  name     = "rg-${var.dominio}-${var.entorno}"
  location = var.location
}
```

```hcl
# Bien
resource "azurerm_resource_group" "dominio" {
  name     = "rg-${var.dominio}-${var.entorno}"
  location = var.location
}
```

## bash

### Narracion de pasos (se borra) y un porque que la linea no dice (se queda)

```bash
# Mal
# Entra al directorio del repo.
cd "$REPO_ROOT"
# Borra el archivo temporal.
rm -f "$TMP"
```

```bash
# Bien
cd "$REPO_ROOT"
rm -f "$TMP"
```

```bash
# Bien: el porque no se lee en la linea
# set -e no ve el fallo dentro de un pipe sin pipefail; sin esta linea el script seguiria con un
# listado vacio.
set -o pipefail
```

### Comentario largo que se acorta (se queda lo no obvio)

Basado en `scripts/setup-github-ci.sh`. El porque se queda y la URL tambien, porque el
comportamiento de la API externa sorprende; la lista de que workflow usa cada credencial se lee
en las llamadas de abajo.

```bash
# Mal
# 5. Federated credentials para GitHub Actions OIDC. Ahora creamos las dos credenciales que
#    necesita el SP de CI. Primero la de main, que usan el deploy y el apply, y despues la de
#    pull_request, que usa el plan. El subject debe coincidir EXACTO con el claim que GitHub
#    pone en el token; el matching de patrones no esta soportado para ramas/tags.
ensure_federated_credential() {
```

```bash
# Bien
# El subject debe coincidir exacto con el claim del token de GitHub: no admite patrones para
# ramas ni tags. https://learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust
ensure_federated_credential() {
```

## API externa no obvia, con URL

Lo que la documentacion dice de un uso normal no se cita en el codigo; el comportamiento que
sorprende si, con su URL. Si no se abrio la documentacion, se dice "sin verificar".

```csharp
// Mal
// Llama a la API de Service Bus para obtener el mensaje.
var mensaje = await receptor.ReceiveMessageAsync(timeout);
```

```csharp
// Bien
// Devuelve null si vence el timeout, no lanza: no tratar null como error.
// https://learn.microsoft.com/dotnet/api/azure.messaging.servicebus.servicebusreceiver.receivemessageasync
var mensaje = await receptor.ReceiveMessageAsync(timeout);
```

El "comentario gemelo" del wildcard de OpenTelemetry (MEF-ADR-0034 seccion 10) es el mismo caso
sin URL: cita el archivo fuente que lo verifico. Es blindado, se queda tal cual.

```csharp
// El "*" va SIN punto delante: OpenTelemetry ancla el patron escapado, asi que "X.*" queda como
// ^X\..*$ y EXCLUYE la fuente nombrada exactamente "X". Sin error ni warning, los spans de esa
// fuente nunca llegan a Application Insights. Verificado contra OpenTelemetry 1.13.1 en
// src/OpenTelemetry/Internal/WildcardHelper.cs. NO agregar el punto por simetria con los
// AddSource de arriba.
tracing.AddSource("MiDominio*")
```
