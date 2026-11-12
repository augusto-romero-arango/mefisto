# MEF-ADR-0045: Estandar de nombramiento de recursos Azure (patron CAF + region + secuencia)

- **Fecha**: 2026-08-27
- **Estado**: aceptado
- **Aplica a**: el patron de nombramiento que los agentes scaffolders del marco (`infra-base-scaffolder`, `domain-scaffolder`, `apim-gateway-scaffolder`, `projections-scaffolder`) y `scripts/bootstrap-backend.sh` deben seguir al generar HCL **nuevo** para recursos Azure del consumidor, y los tokens `azureRegionShort`/`resourceSequence` de `harness.config.json` que ese patron consume. No renombra ningun recurso ya desplegado (seccion 3) ni modifica por si mismo ningun scaffolder -- la alineacion de cada uno queda en issues dependientes que este ADR bloquea (ver "Consecuencias").

## Contexto

La suscripcion Azure Cosmos sigue el estandar de nombramiento del Cloud Adoption Framework (CAF) de Microsoft: `{abrev-tipo}-[{uso}-]{app}-{env}-{region}-{seq}` (ej. `kv-asis-dev-eus2-001`, `pip-vm-appl-dev-eus2-001`), y sin guiones para storage/ACR (`stfrontappldeveus2001`, `crappldeveus2001`). Los Resource Groups canonicos de la suscripcion (`rg-appl-dev-eus2-001`, `rg-asis-dev-eus2-001`, `rg-cont-dev-eus2-001`, `rg-impu-dev-eus2-001`, `rg-terc-dev-eus2-001`) cumplen el patron.

Mefisto no lo sigue. Evidencia relevada el 2026-08-27 sobre los recursos que `infra-base-scaffolder` genera para el Bounded Context ControlPlane del propio Mefisto:

- **Resource Groups sin region ni secuencia**: `rg-cosmos-cplane-dev`, `rg-cosmos-cplane-tfstate` (vs. el patron `rg-cplane-dev-eus2-001` que exige la suscripcion).
- **Sufijos random en vez de secuencia**: el Key Vault sale como `kv-cplane-8iiups` -- ni siquiera lleva `env`, y el sufijo es un `random_string` de Terraform, no una secuencia determinista.
- **Prefijos inventados**: el namespace de Service Bus interno del BC usa `sbint-`, que no existe en el catalogo de abreviaturas del CAF; el Container Registry (opt-in del worker de proyecciones) usa `acr`, cuando la abreviatura del CAF es `cr`.
- **Abreviaturas de tipo ausentes**: el Log Analytics workspace sale como `cosmos-cplane-dev-logs` (falta `log-`), Application Insights como `...-ai` (falta `appi-`), el Action Group de costos como `...-cost-alerts` (falta `ag-`).

(`rg-mcperp-dev` tambien rompe el estandar de la suscripcion, pero no es un recurso de Mefisto -- fuera de alcance de este ADR.)

Este ADR crea la **fuente unica** del estandar -- el patron, la tabla de abreviaturas adoptadas, la politica de unicidad, el alcance "solo greenfield" y los limites de naming por tipo -- y el token de configuracion (`azureRegionShort`/`resourceSequence`) que los scaffolders consumiran. La correccion es **solo hacia el futuro**: ningun recurso ya desplegado se renombra (seccion 3).

### Deslinde con MEF-ADR-0006

MEF-ADR-0006 fija convenciones de nombramiento **logico** -- el nombre de la Function (`HttpTrigger`, el metodo C#) y la ruta HTTP que expone, no el nombre del recurso ARM `Microsoft.Web/sites` que la hospeda. Este ADR gobierna exclusivamente el segundo: el nombre del recurso Azure en si. Los dos conviven sin solaparse -- una Function App llamada `func-billing-cplane-dev-eus2-001` (este ADR) sigue exponiendo rutas y nombres de metodo segun MEF-ADR-0006.

## Decision

### 1. Patron CAF adoptado, con la tabla de abreviaturas

Dos formulas, segun si el tipo de recurso admite guiones:

- **Con guiones** (la mayoria de los tipos): `{abrev-tipo}-[{uso}-]{app}-{env}-{region}-{seq}`
- **Sin guiones** (Storage Account, Azure Container Registry -- ninguno de los dos permite `-` en su charset): `{abrev-tipo}{uso}{app}{env}{region}{seq}`

Componentes:

- **`{abrev-tipo}`**: la abreviatura de la tabla de abajo.
- **`{uso}`** (opcional): rol o subordinado del recurso dentro de `{app}`. Para las Function Apps del marco, el dominio cumple ese rol (MEF-ADR-0020, un App Service Plan por dominio): `func-billing-cplane-dev-eus2-001` (`uso` = `billing`).
- **`{app}`**: nombre corto del proyecto/Bounded Context (`boundedContext.name`, abreviado si hace falta -- seccion 4).
- **`{env}`**: el ambiente (`dev`, `prod`, ...) -- sin cambio, ya vigente en el harness.
- **`{region}`**: el token nuevo `azureRegionShort` (seccion 5).
- **`{seq}`**: secuencia zero-padded, token nuevo `resourceSequence` (seccion 5), default `"001"`.

Tabla de abreviaturas adoptadas -- fuente: CAF, "Abbreviation recommendations for Azure resources" [1], verificada el 2026-08-27:

| Recurso | Abreviatura | Ejemplo |
|---|---|---|
| Resource group | `rg-` | `rg-cplane-dev-eus2-001` |
| Key Vault | `kv-` | `kv-cplane-dev-eus2-001` |
| PostgreSQL flexible server | `pgsql-` | `pgsql-cplane-dev-eus2-001` |
| Service Bus namespace | `sbns-` | `sbns-interno-cplane-dev-eus2-001` |
| Storage account (sin guiones) | `st` | `stcplanedeveus2001` |
| Azure Container Registry (sin guiones) | `cr` | `crcplanedeveus2001` |
| Application Insights | `appi-` | `appi-cplane-dev-eus2-001` |
| Log Analytics workspace | `log-` | `log-cplane-dev-eus2-001` |
| Azure Monitor action group | `ag-` | `ag-cplane-dev-eus2-001` |
| App Service plan | `asp-` | `asp-billing-cplane-dev-eus2-001` |
| Function App | `func-` | `func-billing-cplane-dev-eus2-001` |
| API Management (instancia) | `apim-` | `apim-cplane-dev-eus2-001` |
| Container App | `ca-` | `ca-projections-cplane-dev-eus2-001` |
| Container Apps environment | `cae-` | `cae-cplane-dev-eus2-001` |
| Managed identity | `id-` | `id-cplane-dev-eus2-001` |

**Dos correcciones respecto al borrador del issue #729**: la tabla oficial del CAF [1] usa `pgsql` para "PostgreSQL flexible server" y `sbns` para "Service Bus namespace" -- no `psql`/`sb`. Este ADR adopta las formas oficiales verificadas contra la fuente, no las del borrador del issue. Insumo para el issue dependiente que alinea `infra-base-scaffolder`: hoy ese agente emite `psql-` (coincide con el borrador, no con el CAF), `sbint-` (no coincide con ninguno de los dos) y `acr` para el Container Registry (el CAF dice `cr`); la alineacion corrige las tres formas junto con el resto de la superficie listada en "Consecuencias".

### 2. Unicidad global sin sufijos random

Ningun nombre lleva un sufijo aleatorio (`random_string` o equivalente). Para los tipos con scope global -- Key Vault, Storage Account, Azure Container Registry, Service Bus namespace, API Management --, la combinacion `{app}-{env}-{region}-{seq}` (o su forma sin guiones) ya provee unicidad determinista: dos BCs, ambientes o regiones distintos nunca comparten los cuatro componentes a la vez, y una segunda instancia del mismo BC/ambiente/region usa `{seq}` siguiente.

Ante una colision real (el nombre, siendo globalmente unico, ya esta tomado en Azure por otro tenant), el **fallback documentado es incrementar `{seq}`** (`...-002`, `...-003`, ...), nunca reintroducir un sufijo random. Esto hace el nombre resultante predecible antes de correr `terraform apply` -- una propiedad que un sufijo random destruye.

### 3. Alcance "solo greenfield"

Los scaffolders aplican este estandar **exclusivamente al generar archivos Terraform nuevos**. Si el entorno del consumidor ya tiene el recurso desplegado con el nombre previo (no conforme), **no se renombra nada**: renombrar un recurso Azure en Terraform es destroy/create -- para un recurso con estado (PostgreSQL, Storage con datos, Key Vault con secretos) implica perdida de datos o un downtime que ningun cambio de naming por si solo justifica. Los recursos `rg-cosmos-cplane-dev`/`rg-cosmos-cplane-tfstate` y todo lo que contienen (evidencia de la seccion "Contexto") se quedan como estan; solo un BC nuevo, o un recurso nuevo dentro de un BC existente, nace con el patron de este ADR.

### 4. Limites de naming por tipo y regla de truncado

| Recurso | Limite | Charset | Fuente |
|---|---|---|---|
| Key Vault | 3-24 | Alfanumericos y guiones; empieza con letra, termina alfanumerico, sin guiones consecutivos | [2] |
| Storage account | 3-24, sin guiones | Solo minusculas y digitos | [3] |
| Azure Container Registry | 5-50, sin guiones | Solo alfanumericos | [2] |
| Service Bus namespace | 6-50 | Alfanumericos y guiones; empieza con letra, termina alfanumerico | [2] |
| PostgreSQL flexible server | 3-63 | Alfanumericos y guiones (sin guiones consecutivos al inicio) | [4] |

**Regla de truncado**: cuando `{app}` y/o `{uso}` no caben dentro del limite del tipo, se truncan **ellos** -- nunca `{abrev-tipo}`, `{env}`, `{region}` o `{seq}`, que son de longitud fija y ya minimos. Se preserva el prefijo (los primeros N caracteres) sobre el sufijo, el mismo criterio que ya aplica `truncateStorageBase()` (`scripts/lib/tfstate-naming.mts`, en uso por `bootstrap-backend` desde antes de este ADR). Ejemplo del propio issue #729: `st{dominio}{app}{env}{region}{seq}` puede superar los 24 chars de Storage -- la alineacion de `domain-scaffolder` (issue dependiente) trunca `{dominio}`/`{app}` con ese mismo criterio antes de tocar cualquier otro componente.

Key Vault sigue siendo, como ya documenta `agents/infra-base-scaffolder.md`, el limite mas estrecho: `kv-` (3) + `{app}` + `-` (1) + `{env}` + `-` (1) + `{region}` + `-` (1) + `{seq}` (3) deja poco margen para `{app}`, y es el primer tipo donde la regla de truncado entra en juego en la practica.

### 5. Tokens del contrato: `azureRegionShort` y `resourceSequence`

**`azureRegionShort`** (nuevo, opcional): la abreviatura de region que el patron usa como `{region}`. El CAF no publica una tabla oficial de abreviaturas de region -- a diferencia de la de tipos de recurso [1], "Define your naming convention" [5] solo recomienda incluir la region como componente del nombre, sin fijar su forma corta. Por eso este token es un **string libre que el consumidor declara** (ej. `"eus2"` para East US 2), igual a la convencion ya vigente en la suscripcion Cosmos, en vez de derivarse por lookup de `azureLocation` (ver "Alt 2" abajo).

**Ausente**: retrocompatible -- los scaffolders conservan el comportamiento actual (sin `{region}` en el nombre). Mismo patron ya establecido por `tenancy` (MEF-ADR-0028) y `projections` (MEF-ADR-0034): un campo opcional ausente nunca aborta la carga del config. Cuando `/onboard` incorpore el reporte de estos dos tokens -- todavia no lo hace, queda para el issue dependiente que alinea los scaffolders --, debe tratarlos de forma **informativa**: `OK` si estan declarados, `NO VERIFICADO` si faltan, nunca `FALTA`, igual que las secciones de `tenancy.strategy` y `projections.enabled`.

**`resourceSequence`** (nuevo, opcional): la secuencia `{seq}`, un string zero-padded (ej. `"001"`). **Ausente**: default `"001"`.

Ejemplo de `harness.config.json` con los tokens nuevos:

```json
{
  "azureRegionShort": "eus2",
  "resourceSequence": "001"
}
```

### 6. `loadHarnessConfig` expone las variables derivadas

`scripts/lib/harness-config.mts` > `loadHarnessConfig()` devuelve `azureRegionShort` y `resourceSequence`, y `harnessConfigEnv()` los exporta como:

- `HARNESS_AZURE_REGION_SHORT`: el valor de `azureRegionShort`, o cadena vacia si el campo esta ausente.
- `HARNESS_RESOURCE_SEQUENCE`: el valor de `resourceSequence`, o `"001"` si el campo esta ausente o vacio.

Ninguna de las dos aborta la carga por ausencia del campo -- mismo patron retrocompatible que `HARNESS_PROJECTIONS_ENABLED` (issue #369, MEF-ADR-0034): un token opt-in cuya ausencia es un estado valido y esperado en todo consumidor existente, no un error.

## Alternativas consideradas

### Alt 1: mantener sufijos random para la unicidad global

El scaffolder ya usa `random_string` (Key Vault, Storage) para garantizar unicidad global sin pensar en colisiones.

**Descartada** (seccion 2): un sufijo random hace el nombre final impredecible antes de aplicar -- rompe la referencia cruzada legible entre el nombre declarado en el plan y el recurso real, y es syntacticamente indistinguible de la causa raiz que origina este ADR (`kv-cplane-8iiups`). `{app}-{env}-{region}-{seq}` ya es suficientemente unico en la practica (un BC, un ambiente y una region rara vez repiten los tres a la vez), y el fallback de `{seq}` cubre el caso residual sin sacrificar predictibilidad.

### Alt 2: derivar `{region}` automaticamente de `azureLocation`

`azureLocation` (ya en el contrato) es el nombre largo de la region que usa Azure CLI/Terraform (ej. `"eastus2"`); se considero derivar `azureRegionShort` automaticamente de ese valor via una tabla de mapeo interna del harness.

**Descartada** (seccion 5): exigiria mantener esa tabla actualizada a medida que Azure agrega regiones nuevas -- una fuente de deuda que el propio CAF evita al no publicar una tabla oficial de abreviaturas de region. Dejar que el consumidor declare el string corto directamente es mas simple y evita que el harness le imponga una abreviatura que no coincide con la que ya usa en su propia suscripcion (como el caso real de Cosmos, `eus2`).

### Alt 3: aplicar el renombrado retroactivamente a los recursos ya desplegados

Renombrar `rg-cosmos-cplane-dev`, `kv-cplane-8iiups` y el resto de la superficie deviada de la suscripcion Cosmos para que cumplan el estandar desde ya.

**Descartada** (seccion 3): un renombrado de recurso Azure via Terraform es destroy/create. Para PostgreSQL (event store de Marten) o Storage con blobs implicaria perdida de datos o downtime no planificado, sin ningun beneficio funcional -- el nombre de un recurso ya desplegado no afecta su comportamiento. El costo de migrar solo se justificaria junto a una razon operativa independiente (p. ej. una migracion de suscripcion), no como efecto secundario de fijar un estandar de nombramiento.

## Consecuencias

### Positivas

- **Fuente unica y citable**: cualquier agente que genere HCL nuevo tiene un patron y una tabla de abreviaturas verificados contra la fuente oficial, en vez de inventar prefijos (`sbint-`) o omitirlos por completo (issue #729, evidencia de "Contexto").
- **Nombres predecibles antes de aplicar**: sin sufijos random, el nombre final de un recurso es legible desde el propio codigo Terraform, sin tener que correr `plan`/`apply` para saberlo.
- **Retrocompatible**: los dos tokens nuevos son opcionales; ningun consumidor existente rompe por la ausencia de `azureRegionShort`/`resourceSequence` (seccion 5), y ningun recurso ya desplegado se toca (seccion 3).
- **Limites documentados de una vez**: la tabla de la seccion 4 evita que cada scaffolder re-derive por separado los limites de Key Vault/Storage/ACR/Service Bus/PostgreSQL, con el riesgo de que diverjan entre si.

### Negativas

- **Heterogeneidad temporal**: hasta que cierren los issues de alineacion (`infra-base-scaffolder`, `domain-scaffolder`, `apim-gateway-scaffolder`, `scripts/bootstrap-backend.sh`, todos bloqueados por este ADR), el marco sigue generando nombres no conformes -- este ADR fija el estandar, no lo aplica todavia.
- **Consumidores sin `azureRegionShort` declarado siguen sin `{region}`** en los nombres que generen mientras tanto, hasta que lo agreguen a su config.
- **Divergencia deliberada del borrador del issue en dos abreviaturas** (`pgsql`/`sbns` en vez de `psql`/`sb`, seccion 1): correcta contra la fuente oficial, pero exige que la alineacion de `infra-base-scaffolder` corrija tambien las formas que el scaffolder actual ya emite (`psql-`, `sbint-`, `acr`), no solo agregar `{env}`/`{region}`/`{seq}`.
- **El reporte de los dos tokens en `/onboard` queda pendiente** (seccion 5): este ADR fija que debe ser informativo (nunca `FALTA`), pero no lo implementa -- `scripts/onboard-diagnose.sh` no conoce todavia `azureRegionShort`/`resourceSequence`, asi que hasta el issue dependiente el diagnostico simplemente no los menciona.
- **Recursos ya desplegados quedan permanentemente fuera del estandar** (seccion 3): `rg-cosmos-cplane-dev`/`rg-cosmos-cplane-tfstate` y su contenido no se alinean nunca por este ADR; una futura migracion de suscripcion o un proyecto nuevo greenfield son los unicos caminos donde el estandar aplica de punta a punta.

## Referencias

- **[1]** Microsoft Learn, Cloud Adoption Framework -- "Abbreviation recommendations for Azure resources": tabla completa de abreviaturas por tipo de recurso, fuente de la tabla de la seccion 1. Verificada el 2026-08-27. https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations
- **[2]** Microsoft Learn -- "Naming rules and restrictions for Azure resources" (`Microsoft.KeyVault`, `Microsoft.ServiceBus`, `Microsoft.ContainerRegistry`): limites de longitud y charset de la seccion 4. Verificada el 2026-08-27. https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules
- **[3]** Microsoft Learn -- reglas de nombres de recursos, `Microsoft.Storage` (ya citada por README.md seccion 3): 3-24 caracteres, solo minusculas y digitos. https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules#microsoftstorage
- **[4]** `agents/infra-base-scaffolder.md` (limites de PostgreSQL Flexible Server ya documentados ahi, 3-63 chars) y Microsoft Learn, plantilla ARM `Microsoft.DBforPostgreSQL/flexibleServers` (`name`: min 3, max 63, patron `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*`). Verificada el 2026-08-27. https://learn.microsoft.com/azure/templates/microsoft.dbforpostgresql/flexibleservers
- **[5]** Microsoft Learn, Cloud Adoption Framework -- "Define your naming convention": formula general `{recurso}{workload}{environment}{region}{instancia}`, componentes de naming y ejemplos por tipo. Fuente de la seccion 1 (orden de componentes) y de la seccion 5 (ausencia de tabla oficial de abreviaturas de region). Verificada el 2026-08-27. https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming
- MEF-ADR-0006 (convenciones de nombramiento de Functions/rutas HTTP): deslinde de alcance, seccion "Contexto". No se enmienda.
- MEF-ADR-0020 (un App Service Plan por dominio): fundamenta que `{uso}` = dominio para Function Apps, seccion 1. No se enmienda.
- MEF-ADR-0021 (infraestructura base): los 8 modulos que `infra-base-scaffolder` genera son la superficie principal que un issue dependiente alinea contra este ADR. Se cita, no se enmienda aqui.
- MEF-ADR-0028 (estrategia de tenancy) y MEF-ADR-0034 (worker de proyecciones): antecedentes del patron retrocompatible "campo opcional ausente nunca aborta la carga" que siguen `azureRegionShort`/`resourceSequence` (seccion 5-6).
- MEF-ADR-0030 (esquema de identificacion de ADRs): fija el numero `MEF-ADR-0045` para este documento.
- Issue #729: origen de este ADR y de la evidencia relevada sobre la suscripcion Azure Cosmos.

## Control de cambios

- 2026-08-27: creacion como `aceptado` (issue #729). Fija el patron `{abrev-tipo}-[{uso}-]{app}-{env}-{region}-{seq}` (y su forma sin guiones para Storage/ACR) con la tabla de abreviaturas adoptadas verificada contra el CAF; la politica de unicidad global sin sufijos random (fallback: incrementar `{seq}`); el alcance "solo greenfield" (ningun recurso desplegado se renombra); los limites de naming por tipo y la regla de truncado que prioriza `{app}`/`{uso}`; y los tokens nuevos `azureRegionShort`/`resourceSequence` del contrato, expuestos por `load_harness_config` como `HARNESS_AZURE_REGION_SHORT`/`HARNESS_RESOURCE_SEQUENCE`, ambos retrocompatibles. Corrige dos abreviaturas del borrador del issue (`pgsql`/`sbns` en vez de `psql`/`sb`) contra la fuente oficial del CAF. No modifica ningun scaffolder ni `bootstrap-backend.sh` -- la alineacion de cada uno queda en issues dependientes que este ADR bloquea.
- 2026-11-12: las secciones 4 y 6 y la referencia [3] citan `scripts/lib/tfstate-naming.mts` y `scripts/lib/harness-config.mts` en lugar de `scripts/_pipeline-common.sh`, que se borra con el port a TypeScript (MEF-ADR-0057). Sin cambio de doctrina.
