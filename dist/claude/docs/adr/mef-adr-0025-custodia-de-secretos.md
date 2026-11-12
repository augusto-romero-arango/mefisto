# MEF-ADR-0025: Custodia de secretos (ningun secreto ni key en texto plano en app settings)

- **Fecha**: 2026-07-01 (reformado 2026-07-08)
- **Estado**: aceptado
- **Aplica a**: doctrina de manejo de secretos del marco; gobierno de los agentes `infra-base-scaffolder`, `domain-scaffolder`, `implementer` e `infra-writer`, y del backend remoto del tfstate (`scripts/bootstrap-backend.mts`). Generaliza MEF-ADR-0024 (decision #6) y reencuadra el modulo Key Vault de MEF-ADR-0021.

## Contexto

MEF-ADR-0024 decision #6 introdujo la custodia de secretos en **Azure Key Vault**, pero acotada a las **cadenas de conexion de Azure Service Bus**. La auditoria posterior a la implementacion de MEF-ADR-0024 encontro que otros secretos del harness siguen viajando en **texto plano** en los app settings de la Function App:

- El **password de PostgreSQL** embebido en `MartenConnectionString` (`...Password=${var.postgresql_admin_password}...`), generado por `domain-scaffolder`.
- La **access key de la Storage Account** del host de Functions (`AzureWebJobsStorage`), pasada como argumento nativo al recurso Function App.
- La **connection string de Application Insights** (que incluye la instrumentation key), como app setting literal.

El riesgo: cualquiera con lectura del recurso Function App -- o del estado de Terraform, donde el valor tambien se materializa -- ve secretos en claro. Es superficie de rotacion y de fuga.

El principio que faltaba enunciar de forma general (MEF-ADR-0024 lo aplico solo a un caso): **los app settings no deben contener ningun secreto ni key en texto plano**. Todo secreto se custodia fuera del app setting -- en Key Vault, referenciado -- o se accede por **identidad administrada** cuando el runtime lo exige. Las cadenas de ASB de MEF-ADR-0024 son una **instancia** de este principio, no su alcance total.

## Decision

### 1. Principio general: ningun secreto ni key en texto plano

Un app setting nunca contiene el **valor** de un secreto (cadena de conexion con password, access key, instrumentation key, token de API, etc.). Lleva una **referencia** `@Microsoft.KeyVault(...)`, o el secreto se resuelve por **identidad administrada**. El principio aplica por igual al valor en el recurso desplegado y al **estado de Terraform**: Terraform no materializa el valor de ningun secreto.

### 2. Mecanismo por defecto: referencia a Key Vault

Igual que MEF-ADR-0024 decision #6: el secreto vive en el Key Vault del BC y el app setting lleva `@Microsoft.KeyVault(SecretUri=...)` **versionless** (toma la ultima version al rotar). El **valor** lo siembra CI en un step del workflow (`az keyvault secret set`) que corre tras el `apply`, nunca Terraform (decision #6); el harness provisiona (a) la referencia en app settings y (b) el rol **Key Vault Secrets User** de la managed identity de la Function App.

### 3. Mecanismo alterno: identidad administrada donde el runtime lo exige

`AzureWebJobsStorage` (el storage del host de Azure Functions) **no** puede ir por referencia de Key Vault: el runtime necesita el storage al arrancar, **antes** de que se resuelvan las referencias `@Microsoft.KeyVault(...)`. La ruta soportada por Azure es la **conexion por identidad administrada** (`storage_uses_managed_identity = true` + rol de datos de Storage a la managed identity de la Function App). No es un secreto custodiado: es acceso identity-based, coherente con MEF-ADR-0022 (OIDC) y con el norte de MEF-ADR-0024 Alt 4.

### 4. Clasificacion de los secretos actuales y su custodia

| Secreto | Custodia | Estado |
|---|---|---|
| Cadenas de ASB (interno propio, backbone compartido, externo) | referencia Key Vault | ya implementado (MEF-ADR-0024 decision #6) |
| Password de PostgreSQL (`MartenConnectionString`) | referencia Key Vault | a implementar |
| Connection string de Application Insights (instrumentation key) | referencia Key Vault | a implementar |
| Access key de Storage / `AzureWebJobsStorage` | identidad administrada | a implementar |

### 5. El Key Vault del BC es un almacen general de secretos

El modulo Key Vault que introdujo la implementacion de MEF-ADR-0024 deja de ser "custodia de cadenas de ASB" y pasa a ser el **almacen general de secretos del BC**: cualquier secreto que emerja (cadenas, keys, tokens, credenciales) se custodia ahi. Es el vehiculo por defecto del principio de la decision #1.

### 6. Propiedad del valor

El valor de **todos** los secretos del BC -- el interno de ASB, `marten-connection`, `app-insights-connection` y cada `serviceBus.external[]` con `alcance == "compartido"` -- lo siembra **CI**, en un step del workflow (`az keyvault secret set`) que corre **despues** del `apply`, nunca un admin a mano y nunca Terraform en el state (la decision #1 no cambia: el valor sigue sin materializarse en el tfstate). El SP de CI resuelve cada valor de `terraform output` cuando es derivable, o de un GitHub secret (`TF_VAR_POSTGRESQL_ADMIN_PASSWORD` para `marten-connection`; uno por alias para cada `serviceBus.external[]` compartido) cuando no lo es -- ver el inventario de la decision #10.

**Registro declarativo del mecanismo (issue #256).** El step de siembra es **data-driven**: no enumera secretos por su nombre -- itera en runtime `harness.config.json > secrets[]`, un array donde cada entrada declara su `name` (el secreto en el Key Vault) y su `source` (`output` para un `terraform output` derivable, `github-secret` para un GitHub secret no derivable, o `composite` -- vocabulario cerrado, reservado a la formula fija de `marten-connection`). `infra-base-scaffolder` registra ahi, de forma idempotente, los cuatro secretos fijos de esta decision (interno de ASB, `marten-connection`, `app-insights-connection`, uno por alias de `serviceBus.external[]`); el skill `/seed-secret` registra los que se agreguen despues del greenfield. Como el workflow se genera una sola vez y no se reescribe (MEF-ADR-0021 CA-7), este registro es lo que le permite seguir sembrando secretos nuevos sin que nadie edite `infra-cd.yml` a mano.

El harness provisiona la referencia, el RBAC de lectura de la managed identity de cada Function App (`Key Vault Secrets User`) **y** el rol de datos que habilita al propio SP de CI a escribir el secreto (`Key Vault Secrets Officer`, mecanismo M1, ver MEF-ADR-0022): ningun humano necesita un rol de datos sobre el Key Vault para que el marco funcione.

### 7. El desarrollador no custodia secretos de Azure en local

Consecuencia directa de la reforma de MEF-ADR-0022 (issue #196): el `plan` y el `apply` de infraestructura -- los unicos pasos que leen el tfstate/escriben recursos y requieren acceso a los secretos custodiados (Key Vault del BC, tfstate) -- ocurren en CI, bajo la identidad federada del Service Principal (OIDC/WIF). El desarrollador que corre el pipeline IaC local (`iac-pipeline.mts`, stages de escritura y revision estatica: `fmt`/`init -backend=false`/`validate`) nunca necesita **ninguna** credencial de Azure en su maquina ni custodia ningun secreto: no corre `terraform plan` ni `apply` localmente y ni siquiera accede al tfstate (el `plan` real corre en CI, en el PR). **Perfiles distintos del desarrollador ongoing (decision #10):** este "cero credenciales" describe el perfil (a), el del desarrollador. El bootstrap inicial (`scripts/bootstrap-backend.mts`, `scripts/setup-github-ci.mts`) es el perfil (b) -- una operacion privilegiada de una sola vez que ejecuta un admin con permisos de Azure --, y la siembra de los valores de Key Vault (decision #6) es el perfil (c) -- una accion **automatica de CI**, dentro del mismo job `apply`, ya no un privilegio manual de infra/admin. Ver decision #10 para el detalle de los tres perfiles de acceso del marco.

### 8. Backend del tfstate keyless (AAD)

El bloque `backend "azurerm"` que genera `scripts/bootstrap-backend.mts` usa `use_azuread_auth = true` en vez de una `access_key` o SAS token. Tanto el `terraform plan` de CI (en el PR) como el `terraform apply` de CI acceden al state por AAD/RBAC -- nunca por una key en texto plano que viajaria en `backend.tf`, en variables de entorno o en un secret de GitHub. El SP de CI recibe `Storage Blob Data Contributor` sobre la cuenta del tfstate (MEF-ADR-0022, necesario para escribir el state y tomar el lease del blob durante el `plan`/`apply`). El desarrollador **no accede al tfstate**: su revision local es estatica (`init -backend=false`), asi que no necesita ningun rol de datos de Storage sobre su propia identidad de Azure AD. Es el cierre coherente del principio de la decision #1 (ningun secreto ni key en texto plano) aplicado al propio backend de Terraform, y del espiritu identity-based de MEF-ADR-0022.

### 9. Fuente del `postgresql_admin_password` para el `apply` de CI: GitHub secret, nunca `terraform.tfvars`

`infra/environments/<env>/variables.tf` (esqueleto de `infra-base-scaffolder`, MEF-ADR-0021) declara `postgresql_admin_password` como variable requerida y sensible, sin default. Aplicando el principio de la decision #1 al `apply` de CI: su valor lo alimenta `infra-cd.yml` como `TF_VAR_postgresql_admin_password` desde un **GitHub Actions secret** (`secrets.TF_VAR_POSTGRESQL_ADMIN_PASSWORD`, MEF-ADR-0022), **nunca** un `terraform.tfvars` commiteado en el repo. El secret lo crea **manualmente el admin del repo** -- `scripts/setup-github-ci.mts` no lo toca, porque generar la credencial de la base de datos es un concern distinto de provisionar la identidad de CI (ciclos de vida separados). `infra-base-scaffolder` genera ademas un `.gitignore` en el entorno que excluye `terraform.tfvars` (y variantes `*.auto.tfvars`), para que un consumidor que lo use localmente para overridear defaults no sensibles no commitee el password por habito.

**Un solo valor, un solo punto de entrada humano.** El admin crea el password una sola vez, en el GitHub secret `TF_VAR_POSTGRESQL_ADMIN_PASSWORD`. CI reutiliza ese **mismo** valor para dos fines dentro del mismo `apply`: crear el servidor PostgreSQL (`TF_VAR_postgresql_admin_password`) y, en el step de siembra posterior, componer y sembrar el secreto `marten-connection` del Key Vault del BC (decision #6, `az keyvault secret set`, usado por la Function App via referencia versionless). Ya no hay un segundo *handoff* administrativo entre un password generado y un admin que lo vuelve a teclear para sembrar el Key Vault: CI lee el mismo GitHub secret para ambos usos.

### 10. Tres perfiles de acceso a Azure del marco

La doctrina de "cero permisos"/"cero credenciales" (decision #7, MEF-ADR-0022) describe el flujo *ongoing* del desarrollador que usa Mefisto; no agota los perfiles de acceso a Azure del marco. Son **tres**, con alcance y cadencia distintos:

| Perfil | Quien | Cuando | Que hace | Cadencia |
|---|---|---|---|---|
| (a) Desarrollador ongoing | cualquier dev que usa Mefisto | cada `/infra`, `/scaffold`, cada PR | escribe y revisa HCL de forma estatica; nunca corre `plan`/`apply` local; cero credenciales de Azure (decision #7) | continua, sin privilegio |
| (b) Bootstrap | admin | antes de que exista el backend del tfstate y el SP de CI | `bootstrap-backend.mts` + `setup-github-ci.mts`, con permisos elevados de Azure/Entra en su propia maquina (MEF-ADR-0022) | una sola vez |
| (c) Siembra de secretos de Key Vault | **CI** (el propio SP, en un step del job `apply` de `infra-cd.yml`) | dentro del mismo `apply` que crea o rota un secreto (el primero los siembra todos, derivables y no derivables), y con cada alias nuevo en `serviceBus.external` | `az keyvault secret set` en un step del workflow, posterior al `apply` (decision #6); nunca lo hace un admin a mano ni Terraform en el state | automatica, dentro de cada `apply` que toque secretos |

El perfil (c) ya no es un privilegio manual de infra/admin: es una accion automatica de CI, habilitada por el rol de datos `Key Vault Secrets Officer` que el propio `apply` asigna al SP de CI sobre el vault (mecanismo M1, ver MEF-ADR-0022). **Ningun humano necesita un rol de datos de Key Vault**: la unica accion manual que le queda al admin es crear los GitHub secrets que alimentan la siembra -- `TF_VAR_POSTGRESQL_ADMIN_PASSWORD` (decision #9) y uno por cada alias de `serviceBus.external[]` -- nunca sembrar el valor el mismo. El caso `ForbiddenByRbac` del reporte de campo que origino esta reforma (issue #229: un admin, aun siendo Owner de la suscripcion, no podia sembrar porque el control plane no otorga acceso de datos sobre un vault con RBAC habilitado) desaparece por construccion.

**Inventario de la siembra (perfil c):**

| Secreto | Quien siembra | Derivable de `terraform output` | Como se obtiene el valor |
|---|---|---|---|
| `serviceBus.internal.secretName` | CI | si | `terraform output -raw service_bus_interno_connection_string` |
| `app-insights-connection` | CI | si | `terraform output -raw app_insights_connection_string` |
| `marten-connection` | CI | **no** | `postgresql_fqdn` + `postgresql_database_name` + `postgresql_administrator_login` (outputs) + `TF_VAR_POSTGRESQL_ADMIN_PASSWORD` (GitHub secret, decision #9) -- ese password es un **input** del admin, nunca un output del state |
| cada `serviceBus.external[].secretName` con `alcance == "compartido"` | CI | **no** | un GitHub secret por alias, creado manualmente por el admin con el valor que provee el equipo de infra que administra el backbone compartido (MEF-ADR-0024 decision #4); registrado como entrada `github-secret` de `harness.config.json > secrets[]` (issue #256) |
| cualquier secreto nuevo registrado con `/seed-secret --from-github-secret` | CI | **no** | un GitHub secret creado manualmente por quien opera `/seed-secret`, registrado como entrada `github-secret` de `secrets[]` |

`marten-connection` y cada `serviceBus.external[]` comparten la misma razon estructural para no ser derivables: ninguno de los dos valores vive en el state de este Bounded Context -- el primero porque su password es un input del admin, no un output; el segundo porque el ASB que lo emite lo administra otro equipo, fuera de este state. En ambos casos CI sigue siendo quien ejecuta el `az keyvault secret set`; lo unico que cambia frente a los derivables es la fuente del valor (un GitHub secret en vez de un `terraform output`). Desde el issue #256, el step de siembra ya no distingue estos casos por codigo hardcodeado: itera `secrets[]` y resuelve cada `source.type` con la misma logica generica, sea el secreto fijo del BC o uno agregado despues con `/seed-secret`.

## Alternativas consideradas

### Alt 1: dejar los secretos no-ASB en texto plano

**Descartada**: es el estado tras MEF-ADR-0024. Deja el password de Postgres, la access key de Storage y la connection string de App Insights en claro en app settings y en el state. Contradice la intencion de custodia y es una brecha de seguridad real.

### Alt 2: Key Vault para todo, incluido `AzureWebJobsStorage`

**Descartada**: el runtime de Azure Functions requiere el storage del host **al arrancar**, antes de resolver referencias de Key Vault; una referencia `@Microsoft.KeyVault(...)` para `AzureWebJobsStorage` no resuelve de forma fiable en el arranque. La ruta soportada es identidad administrada.

### Alt 3: identidad administrada para todo (ASB incluido) ahora

**Diferida**: el paquete `Cosmos.EventDriven.CritterStack.AzureServiceBus` no soporta wiring por identidad para la publicacion de Wolverine (MEF-ADR-0024 Alt 4). Se aplica identidad administrada **donde ya es viable** (Storage) y referencia de Key Vault **donde no** (ASB, Postgres, App Insights). La migracion de esos a identidad queda como trabajo diferido.

## Consecuencias

### Positivas

- **App settings sin secretos en claro**: ni en el recurso desplegado ni en el state de Terraform.
- **Almacen unico**: el Key Vault del BC concentra todos los secretos; base para secretos futuros (API keys de terceros, etc.) sin decidir de nuevo el mecanismo.
- **Alineado con best-practice de Azure**: referencias de Key Vault para app settings; identidad administrada para el storage del host.
- **Ningun secreto de Azure en la maquina del desarrollador**: el `apply` (unico paso que escribe secretos/RBAC) ocurre en CI (MEF-ADR-0022); el backend del tfstate es keyless (AAD) para el `plan` y el `apply` de CI, y el desarrollador no accede al tfstate en local (su revision es estatica).
- **Ningun humano necesita un rol de datos de Key Vault**: la siembra del valor de cada secreto tambien ocurre en CI (decision #6); el footgun `ForbiddenByRbac` que un admin enfrentaba al intentar sembrar a mano un vault con RBAC habilitado (issue #229) desaparece por construccion.

### Negativas

- **Mas RBAC y referencias que provisionar**: cada secreto suma una referencia y, donde aplique, un role assignment de datos.
- **Un GitHub secret por cada `serviceBus.external[]` compartido (o cualquier secreto nuevo con `source.type: "github-secret"`)**: cada uno exige que un admin (o quien opere `/seed-secret`) cree su GitHub secret -- desde el issue #256 es la **unica** accion manual que le queda en todo el ciclo de vida del secreto, porque registrar la entrada en `secrets[]` lo hace el scaffolder o `/seed-secret`, nunca un edit a mano de `infra-cd.yml`.
- **Postgres y App Insights siguen siendo secretos**: se mantiene la deuda de rotacion (mitigada por Key Vault) hasta que existan alternativas identity-based para ellos.

### Enmiendas que este ADR ordena

Al implementar estas enmiendas, el contenido superado se **elimina del cuerpo** del ADR/agente afectado; no se marca como "obsoleto". El registro del cambio vive solo en el control de cambios del ADR correspondiente (convencion del proyecto).

- **MEF-ADR-0024 decision #6**: generalizar. La custodia en Key Vault no es exclusiva de las cadenas de ASB; remite a este ADR como doctrina general. Incluir explicitamente la cadena del ASB **propio (interno)** en la custodia (ya implementada por el contrato del registro `serviceBus` y el modulo Key Vault; el cuerpo de #6 la omitia al nombrar solo "backbone y externo").
- **MEF-ADR-0021** (infraestructura base): el modulo Key Vault es el **almacen general de secretos del BC**, no "custodia de cadenas de ASB". Reencuadrar su descripcion.
- **`agents/domain-scaffolder.md`**: `MartenConnectionString` por referencia de Key Vault; connection string de App Insights por referencia de Key Vault; Storage por identidad administrada (`storage_uses_managed_identity` + rol de datos de Storage a la managed identity). El bloque `app_settings` no contiene ningun secreto literal.
- **`agents/infra-base-scaffolder.md`**: el modulo `function-app` soporta storage por identidad; el modulo `key-vault` reencuadrado como almacen general; role assignment de datos de Storage a la managed identity.
- **`agents/implementer.md`**: cualquier secreto nuevo que un flujo introduzca va por Key Vault (o identidad administrada); nunca texto plano en app settings.

Enmiendas que ordena la reforma de la decision #6/#10 (issue #229), materializadas en sus hijos:

- **`agents/infra-base-scaffolder.md`** (issue #231): el `infra-cd.yml` que emite gana un step post-`apply` que siembra TODOS los secretos del BC (`az keyvault secret set`), y el modulo/entorno gana el `azurerm_role_assignment` de `Key Vault Secrets Officer` para el propio SP de CI (mecanismo M1, MEF-ADR-0022). Se elimina la regla que prohibe a CI sembrar secretos (regla actual: "el valor lo coloca infra/admin de forma administrativa, fuera de Terraform").
- **`/onboard`** (issue #232): deja de listar la siembra manual del Key Vault en su checklist; documenta en su lugar la creacion de los GitHub secrets (`TF_VAR_POSTGRESQL_ADMIN_PASSWORD` + uno por alias de `serviceBus.external[]`).
- **`README.md`** paso 5 (issue #233): deja de instruir "Sembrar los secretos de Key Vault" a mano; el paso se reduce a crear los GitHub secrets que alimentan la siembra en CI.

Enmiendas que ordena el registro declarativo `secrets[]` (issue #256):

- **`agents/infra-base-scaffolder.md`**: el step de siembra deja de tener una linea `az keyvault secret set` hardcodeada por secreto -- itera `harness.config.json > secrets[]` en runtime (`output`/`github-secret`/`composite`). El propio agente registra ahi, idempotentemente, los cuatro secretos fijos de la decision #10 antes de generar (o si ya existe, sin regenerar) `infra-cd.yml`.
- **`commands/seed-secret.md`** (nuevo): skill que registra un secreto nuevo post-greenfield en `secrets[]` y cablea su referencia `@Microsoft.KeyVault(...)` + rol `Key Vault Secrets User` en la Function App del dominio que lo consume.
- **`README.md`**: se elimina el "Caveat de evolvabilidad" del paso 5 -- agregar un alias nuevo a `serviceBus.external[]`, o cualquier secreto nuevo, ya no exige editar `infra-cd.yml` a mano.

### Trabajo diferido

- **Migracion de ASB, Postgres y App Insights a identidad administrada**: cuando exista soporte viable (para ASB, ver MEF-ADR-0024 Alt 4; para Postgres, autenticacion por Entra ID / token). Entonces esos dejarian de ser secretos custodiados.
- **Rotacion automatizada** de los secretos de Key Vault: fuera de alcance de este ADR.

## Referencias

- MEF-ADR-0024 (modelo de eventos de bus) decision #6: la custodia de cadenas de ASB es una instancia de esta doctrina; este ADR la generaliza e incluye la cadena interna.
- MEF-ADR-0021 (infraestructura base): reencuadra el modulo Key Vault como almacen general de secretos del BC. Tambien materializa la decision #9 (issue #208): `infra-base-scaffolder` genera el `.gitignore` del entorno y omite `variable "subscription_id"`, coherente con la reduccion de superficie de variables requeridas.
- MEF-ADR-0022 (autenticacion de CI hacia Azure por OIDC): mismo espiritu identity-based; el storage por identidad administrada de la decision #3 se alinea con el. Reformado junto con este ADR (issue #196) para fijar que el `apply` de infraestructura ocurre en CI, nunca localmente -- el hecho que permite que el desarrollador nunca custodie secretos de Azure en su maquina (decision #7). Reformado tambien en el issue #208 (seccion "Fuente de las variables Terraform requeridas por `infra-cd.yml`"), que esta decision #9 complementa desde el angulo de custodia. Reformado tambien en el issue #211 para remitir a la decision #10 de este ADR (tres perfiles de acceso) en vez de enmarcar el bootstrap como la unica excepcion al "cero permisos". Reformado tambien en el issue #229 (junto con este ADR) para fijar el rol de datos M1 (`Key Vault Secrets Officer` para el propio SP de CI sobre el vault) que habilita la siembra de secretos en CI.
- MEF-ADR-0024 (modelo de eventos de bus) decision #4: la decision #10 de este ADR (siembra de `serviceBus.external[]` compartido) se apoya en que el backbone compartido lo administra el equipo de infra, fuera del state de este Bounded Context.
- MEF-ADR-0020 (hosting: un App Service Plan por Function App): el `AzureWebJobsStorage` afectado por la decision #3 es el storage del host de cada Function App.
- "Use Key Vault references for App Service and Azure Functions". https://learn.microsoft.com/azure/app-service/app-service-key-vault-references
- "Connect to host storage with an identity" (Azure Functions). https://learn.microsoft.com/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity
- "Configure managed identities for App Service and Azure Functions". https://learn.microsoft.com/azure/app-service/overview-managed-identity
- "Backend Type: azurerm" (Terraform, HashiCorp): `use_azuread_auth`, autenticacion del backend del tfstate por Microsoft Entra ID en vez de access key -- mecanismo de la decision #8. https://developer.hashicorp.com/terraform/language/backend/azurerm
- GitHub Docs, "Using secrets in GitHub Actions" — mecanismo de la decision #9 para `TF_VAR_POSTGRESQL_ADMIN_PASSWORD`. https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions
- "Azure role-based access control (Azure RBAC) vs. access policies (legacy)" — Azure RBAC opera sobre el control plane y el data plane por separado; ser `Owner`/`User Access Administrator` del control plane no implica acceso de datos sobre un Key Vault con RBAC habilitado. Fundamento del `ForbiddenByRbac` que origino la reforma de la decision #6 (issue #229). https://learn.microsoft.com/azure/key-vault/general/rbac-access-policy
- "Provide access to Key Vault keys, certificates, and secrets with Azure role-based access control" — asignar un rol de datos (p. ej. `Key Vault Secrets Officer`) es requisito para operar el data plane de un vault con RBAC; mecanismo M1 de MEF-ADR-0022. https://learn.microsoft.com/azure/key-vault/general/rbac-guide

## Control de cambios

- 2026-07-01: creacion como `propuesta` (nace de la auditoria de secretos posterior a la implementacion de MEF-ADR-0024: el password de Postgres, la access key de Storage y la connection string de App Insights quedaban en texto plano en app settings; se generaliza el principio de custodia mas alla de las cadenas de ASB).
- 2026-07-01: `aceptado` tras la revision con el usuario.
- 2026-07-06: reformado (issue #196, ancla doctrinal de la oleada de apply-en-CI, junto con MEF-ADR-0021 y MEF-ADR-0022) para fijar que el desarrollador no custodia secretos de Azure en local (decision #7, consecuencia de que el `apply` migra a CI) y que el backend del tfstate es keyless via `use_azuread_auth` (decision #8), coherente con el principio de la decision #1 aplicado al propio backend de Terraform.
- 2026-07-06: corregido para eliminar del cuerpo la descripcion residual de un `terraform plan` local del desarrollador con acceso de solo lectura al tfstate y un rol de datos de Storage sobre su propia identidad (decisiones #7 y #8), inconsistente con la decision de la oleada de #196 (`plan` solo en CI, cero permisos de Azure para el desarrollador en el flujo ongoing) y con la implementacion ya mergeada de #199. Se registra que la revision local es estatica (`init -backend=false`), el desarrollador no accede al tfstate, el `plan` real corre en CI (en el PR), y se explicita la excepcion del bootstrap (operacion privilegiada de una sola vez).
- 2026-07-06: enmendado (issue #208) para fijar la decision #9 (fuente del `postgresql_admin_password` para el `apply` de CI): un GitHub secret (`TF_VAR_POSTGRESQL_ADMIN_PASSWORD`) creado manualmente por el admin, nunca un `terraform.tfvars` commiteado -- cierra el vacio que dejaba `infra-cd.yml` sin fuente para esta variable requerida. Se documenta que el mismo valor sirve para sembrar despues el secreto `marten-connection` del Key Vault (decision #6), y que `infra-base-scaffolder` genera el `.gitignore` del entorno como blindaje adicional.
- 2026-07-06: enmendado (issue #211) para nombrar el tercer perfil de acceso -- siembra/custodia de secretos de Key Vault, privilegio de infra/admin **recurrente**, distinto del bootstrap de una sola vez -- que la doctrina previa (decision #7) no nombraba explicitamente. Se agrega la decision #10 (tres perfiles de acceso; inventario de la siembra: que/quien/cuando/por que `marten-connection` y cada `serviceBus.external[]` compartido no son derivables de `terraform output`) y se ajusta la decision #7 para dejar de enmarcar el bootstrap como la unica excepcion al "cero credenciales".
- 2026-07-08: reformado (issue #229, ancla doctrinal, junto con MEF-ADR-0022) para invertir las decisiones #2, #6 y #10 perfil (c): el valor de TODOS los secretos del BC (interno de ASB, `marten-connection`, `app-insights-connection`, cada `serviceBus.external[]` compartido) lo siembra CI en un step del workflow tras el `apply`, nunca un admin a mano ni Terraform en el state. El perfil (c) deja de ser un privilegio manual de infra/admin recurrente y pasa a ser una accion automatica de CI, habilitada por el rol de datos `Key Vault Secrets Officer` que el propio `apply` asigna al SP de CI sobre el vault (mecanismo M1, ver MEF-ADR-0022). La unica accion manual que le queda al admin es crear los GitHub secrets que alimentan la siembra (`TF_VAR_POSTGRESQL_ADMIN_PASSWORD` + uno por alias de `serviceBus.external[]`). Origen: reporte de campo de un consumidor que, aun siendo Owner de la suscripcion, chocaba con `ForbiddenByRbac` al intentar sembrar a mano un Key Vault con `enable_rbac_authorization = true` sin rol de datos asignado. El mecanismo concreto lo materializan los issues #231 (siembra en CI + M1), #232 (`/onboard`) y #233 (README paso 5), hijos de este issue.
- 2026-07-10: enmendado (issue #256) para reformar la decision #6 (mecanismo) y el inventario de la decision #10: el step de siembra deja de tener una linea hardcodeada por secreto y pasa a iterar en runtime el registro declarativo `harness.config.json > secrets[]` (`name` + `source.type` en {`output`, `github-secret`, `composite`}), poblado idempotentemente por `infra-base-scaffolder` para los cuatro secretos fijos del BC. Se corrige la "Negativa" que describia el agregar un alias de `serviceBus.external[]` como una edicion manual de `infra-cd.yml`: desde este registro, la unica accion manual restante es crear el GitHub secret. Origen: el "Caveat de evolvabilidad" documentado en `README.md`/`agents/infra-base-scaffolder.md` desde el issue #231 -- agregar cualquier secreto nuevo despues del greenfield exigia editar a mano el workflow ya generado. Se agrega el skill `commands/seed-secret.md`, que registra secretos nuevos en `secrets[]` y cablea su referencia + rol de lectura en la Function App del dominio consumidor.
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts` que los reemplazaban y su invocacion con `node`. Sin cambio de doctrina.
