# MEF-ADR-0022: Autenticacion de CI hacia Azure por OIDC (Workload Identity Federation)

- **Fecha**: 2026-06-26 (reformado 2026-07-08)
- **Estado**: aceptado
- **Aplica a**: pipeline de CI/CD del proyecto consumidor (GitHub Actions), `scripts/setup-github-ci.mts`, el workflow de deploy que emite `domain-scaffolder` (Paso 5), el workflow de CI de Terraform (`infra-cd.yml`) que emite `infra-base-scaffolder`, `scripts/iac-pipeline.mts` (que deja de aplicar localmente) y el bootstrap de infraestructura documentado en el README.

## Contexto

El marco despliega cada Function App (cada dominio) a Azure desde un workflow de GitHub Actions (`.github/workflows/deploy-<dominio>.yml`) que el `domain-scaffolder` genera (Paso 5). Ese workflow se autentica contra Azure con la action `azure/login` antes de publicar con `Azure/functions-action`.

Hasta ahora **las dos mitades del contrato de secrets no coincidian** (origen: issue #97, primer greenfield real del harness):

- El workflow de deploy esperaba **un** secret JSON `AZURE_CREDENTIALS` (`azure/login` con `creds:`).
- `scripts/setup-github-ci.mts` emitia **cuatro** secrets separados (`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`), generados con `az ad sp create-for-rbac`.

Ningun secret coincidia con el otro, asi que `azure/login` no recibia credenciales validas y el deploy fallaba en el paso de autenticacion. No habia ningun ADR que fijara el modo de autenticacion de CI, asi que cada mitad habia evolucionado por su cuenta.

Habia que elegir **una** via para alinear ambos lados. El espacio de soluciones tiene dos caminos validos:

1. **Secret de cliente**: emitir el JSON unico `AZURE_CREDENTIALS` (formato `clientId`/`clientSecret`/`tenantId`/`subscriptionId`) y consumirlo con `creds:`.
2. **OIDC (OpenID Connect / Workload Identity Federation)**: un Service Principal **sin secret** con un *federated credential* que confia en los tokens efimeros que GitHub emite por workflow; `azure/login` recibe `client-id`/`tenant-id`/`subscription-id` y obtiene un token de acceso de corta vida por intercambio.

**Reforma (issue #196): el `apply` de infraestructura tambien vive en CI.** Hasta aqui este ADR solo cubria la autenticacion del **deploy de codigo** (`deploy-<dominio>.yml`). El `terraform apply` de infraestructura (`scripts/iac-pipeline.mts` Stage 3, agente `infra-applier`) seguia siendo **100% local**: corria con las credenciales de Azure del desarrollador que ejecuta Mefisto, exigiendole permisos elevados sobre la suscripcion (Contributor + `roleAssignments/write` + acceso a los secretos custodiados) en su propia maquina -- exactamente el perfil de riesgo que OIDC ya evitaba para el deploy de codigo desde el issue #97. Este ADR se reforma para cerrar esa asimetria: el `apply` de infra pasa a ejecutarse tambien en CI, bajo la misma identidad federada.

## Decision

**El CI del marco se autentica hacia Azure por OIDC (Workload Identity Federation). El Service Principal de CI no tiene secret. El `apply` de infraestructura ocurre en CI, bajo esta misma identidad federada -- nunca localmente.**

Concretamente:

- `scripts/setup-github-ci.mts` crea la aplicacion de Microsoft Entra + su Service Principal **sin** credencial de password, le asigna los roles de la seccion "Roles del Service Principal de CI" (a nivel de suscripcion y sobre la Storage del tfstate) y le anade los **federated credentials** de la seccion "El subject del federated credential".
- El workflow de deploy declara `permissions: id-token: write` (y `contents: read` para `actions/checkout`) en el job `deploy`, y usa `azure/login` con los inputs separados `client-id` / `tenant-id` / `subscription-id`, NO `creds:`.
- El workflow de CI de Terraform (`infra-cd.yml`, emitido por `infra-base-scaffolder`, MEF-ADR-0021) usa la misma identidad: `azure/login` con los mismos tres inputs, sin `creds:` ni secret adicional.
- Los unicos secrets de GitHub que autentican `azure/login` son **tres**: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. **Ninguno es un secret de password.** (Un cuarto secret, `TF_VAR_POSTGRESQL_ADMIN_PASSWORD`, alimenta una variable Terraform del `apply` -- no la autenticacion OIDC; ver "Fuente de las variables Terraform requeridas por `infra-cd.yml`" mas abajo y MEF-ADR-0025.)

### Fuente de las variables Terraform requeridas por `infra-cd.yml`

`infra/environments/<env>/variables.tf` (esqueleto emitido por `infra-base-scaffolder`, MEF-ADR-0021) declara variables sin default que `-input=false` no puede pedir de forma interactiva. El `env` del workflow las resuelve asi:

- **`subscription_id` no es una variable Terraform de este entorno.** El provider `azurerm` la resuelve nativamente de la variable de entorno `ARM_SUBSCRIPTION_ID` -- ya declarada en el `env` del workflow para el propio `azure/login` -- sin necesidad de una variable Terraform ni un `-var` adicional (HashiCorp, documentacion del provider `azurerm`: `subscription_id` "can also be sourced from the `ARM_SUBSCRIPTION_ID` Environment Variable" [11]).
- **`alert_email`** (no sensible) se inyecta como `TF_VAR_alert_email` desde una GitHub Actions **variable** (`vars.ALERT_EMAIL`) [12].
- **`postgresql_admin_password`** (sensible) se inyecta como `TF_VAR_postgresql_admin_password` desde un GitHub Actions **secret** (`secrets.TF_VAR_POSTGRESQL_ADMIN_PASSWORD`) [13]. Ninguno de los dos viaja por un `terraform.tfvars` commiteado (MEF-ADR-0025 decision #1); `infra-base-scaffolder` genera un `.gitignore` en el entorno para blindar ese archivo si el consumidor lo usa localmente para overridear defaults no sensibles.
- Ambos -- la GitHub variable `ALERT_EMAIL` y el GitHub secret `TF_VAR_POSTGRESQL_ADMIN_PASSWORD` -- los crea **manualmente el admin del repo** (`setup-github-ci.mts` no los toca: son datos de dominio del BC, no credenciales de la identidad de CI). El output del `infra-base-scaffolder` (Paso 5) y el README documentan el paso.

### El apply de infraestructura ocurre en CI, nunca localmente

El desarrollador que usa Mefisto **escribe y revisa** el HCL (revision estatica: `fmt`/`init -backend=false`/`validate`); nunca ejecuta `terraform plan` ni `terraform apply` en su maquina, ni necesita permisos de Azure ni custodia secretos. El `plan` y el `apply` reales -- los unicos pasos que leen el tfstate/escriben recursos y requieren acceso a los secretos custodiados (Key Vault, tfstate) -- los ejecuta el Service Principal de CI, por OIDC, dentro de GitHub Actions (el `plan` al abrir el PR, el `apply` al mergear a `main`). **Tres perfiles de acceso, no dos (MEF-ADR-0025 decision #10):** este "cero permisos" describe el perfil (a) -- el desarrollador en su flujo *ongoing*. Hay otros dos perfiles que si manejan permisos elevados de Azure, ninguno cubierto por esta doctrina: (b) el **bootstrap** (`scripts/bootstrap-backend.mts` crea el tfstate y `scripts/setup-github-ci.mts` crea el SP y sus federated credentials), una operacion privilegiada de una sola vez que ejecuta un admin para habilitar la CI; y (c) la **siembra de secretos** de Key Vault (MEF-ADR-0025 decision #6), ahora una accion **automatica de CI** dentro del propio job `apply` (habilitada por el rol de datos M1; ver la seccion "Rol de datos de Key Vault para el propio SP de CI" mas abajo) -- se repite en cada `apply` que crea un secreto nuevo y con cada `serviceBus.external[]` que el BC declare (MEF-ADR-0024 decision #4), pero ya no es un privilegio manual de infra/admin. Ver MEF-ADR-0025 decision #10 para el detalle de los tres perfiles.

**Modelo plan-en-PR / apply-en-merge-a-main**, siguiendo la guia de automatizacion de HashiCorp para Terraform con GitHub Actions [8]:

| Evento | Job | Que hace |
|---|---|---|
| `pull_request` sobre `infra/**` | `plan` | `terraform init` + `terraform plan`; publica el resumen del plan (comentario o check del PR). No aplica. |
| `push` a `main` sobre `infra/**` (tras mergear el PR) | `apply` | `terraform init` + `terraform apply`. |

El pipeline local (`scripts/iac-pipeline.mts`) deja de tener un Stage que aplica y tampoco corre `terraform plan`: sus Stages 1 (`infra-writer`) y 2 (`infra-reviewer`, revision estatica: `fmt -check` + `init -backend=false` + `validate`) siguen corriendo localmente contra el worktree, pero el resultado es un PR con el HCL revisado, nunca un `terraform plan` ni un `terraform apply` ejecutados por el desarrollador. El `plan` real corre en el job `plan` de `infra-cd.yml` al abrir el PR. El agente `infra-applier` (que invocaba `terraform apply` con las credenciales locales) se retira y el propio pipeline se reimplementa para este modelo en el issue #199; este ADR fija el criterio, no el mecanismo de script.

### Roles del Service Principal de CI

La asignacion de roles a nivel de **suscripcion** (mismo scope que ya tenia `Contributor`) se amplia para soportar el `apply` de infraestructura completo:

| Rol | Scope | Motivo |
|---|---|---|
| `Contributor` | Suscripcion | Deploy de Functions e infraestructura (ya asignado, sin cambios). |
| `Role Based Access Control Administrator` (con condicion anti-escalacion) | Suscripcion | Los scaffolders de MEF-ADR-0025 emiten `azurerm_role_assignment` (Key Vault Secrets User para las Function Apps, roles de datos de Storage, y -- M1, issue #229 -- Key Vault Secrets Officer para el propio SP de CI sobre el vault del BC); `Contributor` **excluye explicitamente** `Microsoft.Authorization/roleAssignments/write` [9], asi que sin este rol el `apply` de CI falla al crear esos role assignments. |
| `Storage Blob Data Contributor` | Storage Account del tfstate | El `apply` **escribe** el state y toma el lease/lock del blob; con el backend keyless de AAD (MEF-ADR-0025) necesita lectura y escritura por AAD, no solo lectura. Reemplaza a `Storage Blob Data Reader`. |

**Por que `Role Based Access Control Administrator` y no `User Access Administrator`.** Microsoft Learn documenta `Role Based Access Control Administrator` como el rol de **menor privilegio** para delegar la gestion de asignaciones de rol, frente a `User Access Administrator`, que ademas puede reclamar el rol de administrador de acceso para si mismo y gestionar cualquier aspecto del control de acceso [10]. El SP de CI solo necesita crear role assignments (Key Vault Secrets User, roles de datos de Storage) sobre recursos que el propio `apply` acaba de crear; no necesita el resto de capacidades de `User Access Administrator`.

**La condicion anti-escalacion es un detalle de implementacion (issue #195, RBAC del SP).** Este ADR fija que el rol se asigna **con una condicion** que excluye que el SP pueda asignar roles privilegiados (`Owner`, `User Access Administrator`, el propio `Role Based Access Control Administrator`) a si mismo o a otro principal -- el patron estandar para evitar que un rol de administracion de roles se convierta en una via de escalacion a `Owner`. La plantilla concreta de la condicion (sintaxis ABAC) la escribe #195.

**Por que scope de suscripcion y no del resource group del BC.** `scripts/setup-github-ci.mts` corre en el **bootstrap**, antes de que exista el Resource Group del BC -- ese RG lo crea el propio `terraform apply`, como el modulo `resource-group` de MEF-ADR-0021. Acotar la asignacion al RG introduce un problema de huevo y gallina: el permiso se necesitaria antes de que el recurso al que se acotaria exista. Resolverlo sacaria la creacion del RG fuera de Terraform, lo que rompe la decision de MEF-ADR-0021 de que la infraestructura base provisiona el RG como un modulo mas. Dada la arquitectura actual, el menor privilegio **viable** es scope de suscripcion + condicion anti-escalacion, no scope de RG.

### Rol de datos de Key Vault para el propio SP de CI (M1, siembra de secretos)

Un Key Vault con `rbac_authorization_enabled = true` (MEF-ADR-0025) exige un rol de **datos** para leer o escribir secretos por el data plane, **independiente** del control plane: ni siquiera `Owner` de la suscripcion tiene acceso de datos sin un role assignment explicito sobre el vault [14][15]. Esa brecha es la causa raiz del reporte de campo que origino esta reforma (issue #229): un admin, siendo Owner, chocaba con `ForbiddenByRbac` al intentar sembrar un secreto a mano.

La reforma de MEF-ADR-0025 (decision #6) traslada la siembra de **todos** los secretos del BC a un step de `infra-cd.yml` que corre **despues** del `apply`, bajo la misma identidad de CI. Para habilitarlo, el propio `apply` -- bajo el `Role Based Access Control Administrator` que ya tiene el SP -- crea un `azurerm_role_assignment` de **`Key Vault Secrets Officer`** para **si mismo** (`principal_id` = la identidad del SP que corre el `apply`), con `scope` = el Key Vault del BC. Es el mismo patron que ya usan los scaffolders para asignarle `Key Vault Secrets User` a la managed identity de cada Function App; aqui el principal es el propio SP de CI, no una managed identity de un recurso.

**Por que la condicion anti-escalacion (issue #195) lo permite.** La condicion solo bloquea que el SP se auto-asigne (o asigne a otro principal) los roles privilegiados `Owner`, `User Access Administrator` o el propio `Role Based Access Control Administrator`. `Key Vault Secrets Officer` es un rol de **datos** de Key Vault -- no aparece en esa lista y no delega gestion de acceso -- asi que la condicion lo permite sin ajustes.

**Por que no lo asigna `setup-github-ci.mts`.** El script corre en el bootstrap, antes de que el Key Vault del BC exista (lo crea el propio `apply`, modulo `key-vault` de MEF-ADR-0021): no hay recurso sobre el cual acotar el `scope` todavia. Asignarlo en el `apply` sigue el mismo patron de huevo-y-gallina que ya resuelve el scope de suscripcion del `Role Based Access Control Administrator` (seccion anterior): el permiso que falta lo crea el propio proceso que ya tiene el rol de administracion de roles necesario. `setup-github-ci.mts` **no se modifica** para este rol de datos.

**Propagacion de RBAC.** Un role assignment de Azure puede tardar uno o dos minutos en propagarse antes de que las llamadas de datos lo respeten [15]; el step de siembra que corre en la misma ejecucion del `apply` necesita reintentar la primera llamada a `az keyvault secret set` si la propagacion aun no completo. El mecanismo concreto de retry lo implementa el issue #231 (hijo de #229); este ADR fija el rol y el scope, no el detalle del retry.

### El subject del federated credential

El *subject* del federated credential debe coincidir **exacto** con el claim que GitHub pone en el OIDC token; el matching de patrones no esta soportado para ramas/tags [3]. El SP de CI necesita **dos** federated credentials, uno por cada evento que dispara un job que se autentica contra Azure:

| Workflow / job | Evento | Subject |
|---|---|---|
| `deploy-<dominio>.yml` (deploy de codigo) y `infra-cd.yml` job `apply` | `push: branches: [main]` (jobs no atados a un GitHub Environment) | `repo:<owner/repo>:ref:refs/heads/main` |
| `infra-cd.yml` job `plan` | `pull_request` sobre `infra/**` | `repo:<owner/repo>:pull_request` |

El subject de un evento `pull_request` **no** lleva el ref de la rama ni matchea por patrones [3][4]: es un valor fijo por repositorio, distinto del subject de push a `main`. Por eso el `apply` (que corre en push a `main`) reutiliza el federated credential ya existente, pero el `plan` (que corre en `pull_request`) necesita uno **adicional** con ese subject; sin el, `azure/login` en el job `plan` falla con "no matching federated identity record" aunque el `apply` funcione. La forma `...:environment:<Name>` [2][4] sigue fuera del workflow que emite el marco (ningun job del marco esta atado a un GitHub Environment). Si un consumidor cambia el trigger de deploy a otra rama, tag o un Environment, debe anadir el federated credential correspondiente; el script lo documenta en su salida y el scaffolder en la nota del Paso 5.

### Cierre del issue de infra: al aplicar en CI, no al mergear el PR

El flujo preview -> apply del pipeline IaC (issue #96) ya establecia que el issue de infraestructura representa **"infra aplicada"**, no "infra previsualizada" ni "infra mergeada": con `--skip-apply` el PR de preview no lleva `Closes #N` y el issue se cierra recien cuando el `apply` posterior corre exitosamente. Migrar el `apply` a CI **no cambia ese criterio**, solo cambia **quien** ejecuta el cierre: el PR del pipeline IaC tampoco lleva `Closes #N` (el HCL puede necesitar ajustes en revision antes de aplicarse), y es el job `apply` de `infra-cd.yml` -- o el pipeline que lo orquesta -- quien cierra el issue tras un `terraform apply` exitoso en `main`. El mecanismo concreto (`gh issue close` desde el workflow, con que credencial de GitHub) lo materializan #197/#199; este ADR fija el criterio de cierre.

### Orden: infra antes que deploy de codigo

El deploy de codigo de un dominio (`deploy-<dominio>.yml`) no debe ejecutarse antes de que su Function App exista o este actualizada por el `apply` de infra: es una dependencia fisica, no puede publicarse codigo a una Function App inexistente. Con el `apply` migrado a CI, ambos workflows (`infra-cd.yml` y `deploy-<dominio>.yml`) pueden correr en el mismo evento (`push` a `main`), asi que el orden entre ellos deja de estar garantizado por el orden manual del desarrollador (bootstrap -> `/infra` -> `/scaffold` -> deploy) y pasa a depender de como CI encadena los workflows. Este ADR fija el **principio**; el **mecanismo** concreto (p. ej. encadenar `deploy-<dominio>.yml` tras `infra-cd.yml` via `workflow_run` cuando el push toco `infra/**`, conservando el disparo directo por `src/**` para cambios de solo codigo) lo decide el issue #197. En greenfield, mientras ese mecanismo no exista, el orden lo sigue garantizando el flujo manual documentado en el README (bootstrap -> infra-base -> primer `/infra` -> `/scaffold` + deploy).

### Por que OIDC y no el secret de cliente

- **No hay secret que expire.** Un client secret de `az ad sp create-for-rbac` caduca (el harness lo fijaba en 1 ano). En un harness usado en multiples greenfield, eso es una bomba de tiempo: el deploy funciona y, al ano, falla en silencio con un error de autenticacion que nadie anticipa. OIDC usa tokens efimeros emitidos por GitHub en cada corrida; no hay nada que rotar.
- **Es la guia vigente de Azure y GitHub.** Azure documenta OIDC como el camino recomendado para `azure/login` desde GitHub Actions [1][5], y marca explicitamente el flujo de Service Principal + secret como **deprecado** [6]. `az ad sp create-for-rbac --sdk-auth` (el comando que producia el JSON `AZURE_CREDENTIALS`) tambien esta deprecado.
- **Superficie de credenciales mas pequena.** No se almacena ningun secreto de larga vida en GitHub; un secret filtrado de los repositorios deja de ser un vector.
- **El harness ya estaba a un paso.** El issue #90 subio el workflow a `azure/login@v3`, la version nativa de OIDC. Adoptar OIDC cierra el contrato en su forma moderna en vez de revivir el JSON deprecado.

### Frontera de alcance: autenticacion runtime cross-BC

Este ADR cubre la autenticacion de **CI/deploy** hacia Azure (OIDC / Workload Identity Federation). La autenticacion **runtime entre bounded contexts** — como un consumidor externo se autentica y autoriza contra el namespace de integracion del productor — **queda fuera de alcance** y es trabajo diferido. La seguridad inter-BC se logra primariamente por **topologia** (namespaces separados, MEF-ADR-0023); el RBAC least-privilege por entidad es una **recomendacion diferida** que se decidira al materializar la integracion cross-BC, no doctrina firme de este ADR.

## Alternativas consideradas

### Alt 1: alinear con el secret de cliente (`AZURE_CREDENTIALS`)

Hacer que `setup-github-ci.mts` emita el JSON unico y dejar el workflow con `creds:`. Era el cambio mas corto (el workflow ya usaba `AZURE_CREDENTIALS`; el resumen del scaffolder ya lo nombraba) y es universalmente valido para cualquier trigger sin acoplarse al subject del federated credential.

**Descartado** por el secret que expira (footgun operativo silencioso para un harness greenfield) y porque el camino de password esta deprecado por Azure [6]. La robustez de OIDC frente al failure mode "el CI muere al ano" pesa mas que la simplicidad de no depender del subject.

### Alt 2: managed identity con federated credential

Usar una user-assigned managed identity en vez de una app de Entra [1][5].

**Descartado**: una managed identity vive como recurso de Azure (necesita un resource group, ciclo de vida en Terraform) y aporta poco frente a la app de Entra para el caso "GitHub Actions deplega a una suscripcion". La app + SP es el patron documentado por defecto para GitHub→Azure y es lo que el script ya gestionaba.

### Alt 3: mantener el apply local, con elevacion temporal (PIM / Just-In-Time)

Para la decision de **donde** corre el `apply` (issue #196): usar Privileged Identity Management (PIM) de Microsoft Entra para que el desarrollador active los roles elevados (`Contributor`, `Role Based Access Control Administrator`) solo durante la ventana del `apply`, en vez de correrlo en CI.

**Descartado**: PIM requiere licenciamiento Entra ID P2, que el harness no puede asumir disponible en toda suscripcion consumidora. Ademas la credencial elevada sigue viajando por la maquina del desarrollador durante la ventana activa (superficie de robo de token/sesion), y el audit trail de un `apply` en CI (log del workflow, revision del PR que lo precede) es mas fuerte y uniforme que el de una sesion interactiva local. Migrar el `apply` a CI resuelve el mismo problema de exposicion sin depender de una feature de licenciamiento opcional.

## Consecuencias

### Positivas

- **Ambas mitades del contrato coinciden**: el script emite exactamente los tres secrets que el workflow consume (cierra #97).
- **Sin secret que rote ni expire**: elimina el modo de falla "el deploy muere al ano".
- **Alineado con la guia vigente de Azure/GitHub** [1][5] y sin depender de comandos/flujos deprecados [6].
- **Menos secrets** (3 en vez de 4) y ninguno sensible de larga vida.
- **Ningun desarrollador custodia credenciales elevadas de Azure en su maquina**: el `apply` de infra -- el unico paso que necesita escribir recursos y leer/escribir secretos -- corre en CI bajo la identidad federada; el humano solo escribe y revisa el HCL (revision estatica), sin correr `terraform plan` ni `apply` localmente (issue #196).
- **Ningun humano necesita un rol de datos de Key Vault**: el rol M1 (`Key Vault Secrets Officer` para el propio SP de CI) habilita que la siembra de secretos tambien corra en CI (MEF-ADR-0025 decision #6); elimina el footgun `ForbiddenByRbac` que un admin, aun siendo Owner, enfrentaba al intentar sembrar a mano (issue #229).

### Negativas

- **Acoplamiento al subject**: el federated credential confia en `ref:refs/heads/main`. Si el consumidor despliega desde otro ref o detras de un Environment sin anadir el credential correspondiente, `azure/login` falla con un error de "no matching federated identity record". Mitigado: el marco controla el trigger generado (`branches: [main]`), el script imprime el subject configurado y advierte el caso, y la nota del Paso 5 del scaffolder lo documenta.
- **Permisos de Graph para el setup**: crear la app, el SP y el federated credential requiere permisos de gestion de aplicaciones en Microsoft Entra (comparables a los que ya exigia `az ad sp create-for-rbac`). No cambia el perfil del operador que corria el script.
- **Resolucion del slug del repo**: el script necesita el `owner/repo` para el subject. Se resuelve via `gh repo view` o el remote `origin`, con override por argumento; si no hay remote de GitHub ni `gh` autenticado, aborta pidiendo el slug.
- **Mayor superficie de IAM en el SP de CI**: `Role Based Access Control Administrator` a nivel de suscripcion es mas privilegio que `Contributor` + `Storage Blob Data Reader` del estado anterior. Mitigado por la condicion anti-escalacion (issue #195) que impide que el SP se otorgue a si mismo -- o a otro principal -- roles de administracion (`Owner`, `User Access Administrator`, el propio `Role Based Access Control Administrator`).
- **Dos federated credentials en vez de uno**: el SP debe mantener el subject de `pull_request` (plan) ademas del de `ref:refs/heads/main` (deploy y apply); un tercer trigger nuevo (otro evento o rama) exigiria un tercer credential, mismo patron que la nota ya existente sobre acoplamiento al subject.

## Referencias

- **[1]** "Use the Azure Login action with OpenID Connect" — prerrequisitos de OIDC (app de Entra o managed identity, role assignment, federated credential). https://learn.microsoft.com/azure/developer/github/connect-from-azure-openid-connect
- **[2]** "Deploy to Azure App Service by using GitHub Actions — Manually set up a GitHub Actions workflow (OpenID Connect)" — `az ad app create` / `az ad sp create` / role assignment / `az ad app federated-credential create` con `subject: repo:organization/repository:ref:refs/heads/main`. https://learn.microsoft.com/azure/app-service/deploy-github-actions#manually-set-up-a-github-actions-workflow
- **[3]** "Configure an app to trust an external identity provider" — formato del subject (`ref`, `environment`, `pull_request`); el matching de patrones no esta soportado para ramas/tags. https://learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust#configure-a-federated-identity-credential-on-an-app
- **[4]** "az ad app federated-credential" — `issuer`, `subject`, `audiences` (`api://AzureADTokenExchange`). https://learn.microsoft.com/cli/azure/ad/app/federated-credential
- **[5]** "Deploy Bicep files by using GitHub Actions — Generate deployment credentials (OpenID Connect)". https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-github-actions#generate-deployment-credentials
- **[6]** Azure Verified Modules, "Bicep Contribution Flow — Configure a deployment identity": OIDC como opcion recomendada y "Option 2 [Deprecated]: Configure Service Principal + Secret". https://azure.github.io/Azure-Verified-Modules/contributing/bicep/bicep-contribution-flow/#2-configure-a-deployment-identity-in-azure
- **[7]** GitHub, "Azure Login action — Login with OpenID Connect (OIDC) (recommended)". https://github.com/Azure/login#login-with-openid-connect-oidc-recommended
- **[8]** HashiCorp, "Automate Terraform with GitHub Actions" — modelo plan-en-pull-request / apply-en-merge-a-main. https://developer.hashicorp.com/terraform/tutorials/automation/github-actions
- **[9]** Microsoft Learn, "Azure built-in roles — Contributor" — el rol excluye explicitamente `Microsoft.Authorization/*/Delete`, `Microsoft.Authorization/*/Write` (con las excepciones puntuales que lista la definicion) y `Microsoft.Authorization/elevateAccess/Action`. https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/general#contributor
- **[10]** Microsoft Learn, "Azure built-in roles — Identity" / "Delegate Azure access management to others" — `Role Based Access Control Administrator` como delegacion de menor privilegio que `User Access Administrator` para gestionar asignaciones de rol. https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/identity#role-based-access-control-administrator
- **[11]** HashiCorp, "Terraform Registry — azurerm provider, Argument Reference" — `subscription_id` "can also be sourced from the `ARM_SUBSCRIPTION_ID` Environment Variable". https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs#argument-reference
- **[12]** GitHub Docs, "Store information in variables" — variables de repositorio/entorno accesibles en workflows via el contexto `vars`. https://docs.github.com/en/actions/learn-github-actions/variables
- **[13]** GitHub Docs, "Using secrets in GitHub Actions" — secrets de repositorio cifrados, accesibles via el contexto `secrets` en `env:`. https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions
- **[14]** Microsoft Learn, "Azure role-based access control (Azure RBAC) vs. access policies (legacy)" — Azure RBAC opera sobre el control plane y el data plane por separado; el rol de administracion (`Owner`/`User Access Administrator`) del control plane no implica acceso de datos sobre un Key Vault con RBAC habilitado. Fundamento del rol M1. https://learn.microsoft.com/azure/key-vault/general/rbac-access-policy
- **[15]** Microsoft Learn, "Provide access to Key Vault keys, certificates, and secrets with Azure role-based access control" — asignar un rol de datos (p. ej. `Key Vault Secrets Officer`) es requisito para operar el data plane de un vault con RBAC. https://learn.microsoft.com/azure/key-vault/general/rbac-guide — y "Quickstart: Create an Azure key vault and a secret using Bicep" — "Role assignments might take a minute or two to propagate" (fundamento del retry de la propagacion de RBAC intra-corrida). https://learn.microsoft.com/azure/key-vault/secrets/quick-create-bicep
- MEF-ADR-0023: Bounded Context, namespace interno de Azure Service Bus y frontera publico/privado — recoge el eje runtime-cross-BC (diferido) que este ADR explicitamente no cubre.
- MEF-ADR-0024: Modelo de eventos de bus (privado propio, publico via backbone compartido, integracion externa diferida) — reencuadra el namespace de integracion citado en la seccion anterior como el transporte del caso diferido de integracion verdaderamente externa, no como el default del evento publico.
- MEF-ADR-0021 (infraestructura base): reformado junto con este ADR (issue #196); el `infra-base-scaffolder` emite el workflow `infra-cd.yml` que se autentica con la identidad y los roles que este ADR fija.
- MEF-ADR-0025 (custodia de secretos): reformado junto con este ADR (issue #196); el backend keyless (`use_azuread_auth`) del tfstate es el mecanismo que hace posible que ni el `plan` ni el `apply` de CI dependan de una access key.

## Control de cambios

- 2026-07-01: enmendado (issue #167, barrido de coherencia hacia MEF-ADR-0024) para actualizar la referencia a MEF-ADR-0023 y anadir remision a MEF-ADR-0024. La seccion "Frontera de alcance: autenticacion runtime cross-BC" no cambia: sigue describiendo el caso diferido de integracion verdaderamente externa (MEF-ADR-0024 decision #5), vigente.
- 2026-07-06: reformado (issue #196, ancla doctrinal de la oleada de apply-en-CI, junto con MEF-ADR-0021 y MEF-ADR-0025) para fijar que el `apply` de infraestructura ocurre en CI bajo identidad federada, nunca localmente (modelo plan-en-PR / apply-en-merge-a-main). Se amplian los roles del SP (`Role Based Access Control Administrator` con condicion anti-escalacion a nivel suscripcion; `Storage Blob Data Contributor` en vez de `Storage Blob Data Reader` sobre el tfstate) y se anade el federated credential de subject `pull_request` junto al de `ref:refs/heads/main`. Se fija que el issue de infra se cierra al completar el `apply` de CI, no al mergear el PR (continuidad de la doctrina de #96), y el principio de que el deploy de codigo no debe correr antes que el `apply` de infra. Se elimina del cuerpo la afirmacion de que el subject `pull_request` "queda fuera del workflow que emite el marco" (seccion "El subject del federated credential") y la asignacion de solo `Storage Blob Data Reader` sobre el tfstate; el mecanismo concreto (workflow `infra-cd.yml`, reimplementacion de `iac-pipeline.sh`/`infra-applier`, plantilla ABAC de la condicion anti-escalacion) lo materializan los issues #197, #198, #195, #199 y #200.
- 2026-07-06: corregido para eliminar del cuerpo la descripcion residual de un `terraform plan` local del desarrollador ("planifica y revisa el HCL/plan"; "Stage 2 `infra-reviewer`, plan"), inconsistente con la decision de la oleada de #196 (`plan` solo en CI, cero permisos de Azure para el desarrollador en el flujo ongoing) y con la implementacion ya mergeada de #199. Se aclara que el pipeline local hace solo revision estatica y que el `plan` real corre en CI (job `plan` de `infra-cd.yml`) al abrir el PR, y se explicita la excepcion del bootstrap (el "cero permisos" aplica al flujo ongoing; el bootstrap inicial de backend + SP es una operacion privilegiada de una sola vez).
- 2026-07-06: enmendado (issue #208) para fijar la fuente de las variables Terraform requeridas por `infra-cd.yml` sin default (`alert_email`, `postgresql_admin_password`), que el `env` del workflow dejaba sin resolver y hacia fallar `plan`/`apply` con "No value for required variable". Se agrega la seccion "Fuente de las variables Terraform requeridas por `infra-cd.yml`": `subscription_id` deja de ser una variable Terraform (el provider `azurerm` la resuelve nativamente de `ARM_SUBSCRIPTION_ID`, ya presente en el `env`); `alert_email` se inyecta como `TF_VAR_alert_email` desde una GitHub variable; `postgresql_admin_password` como `TF_VAR_postgresql_admin_password` desde un GitHub secret -- ambos creados manualmente por el admin del repo, nunca por `terraform.tfvars` commiteado (MEF-ADR-0025). Se corrige la afirmacion "los unicos secrets de GitHub son tres" para acotarla a los que autentican `azure/login` (OIDC); el cuarto secret (`TF_VAR_POSTGRESQL_ADMIN_PASSWORD`) alimenta una variable Terraform, no la autenticacion.
- 2026-07-06: enmendado (issue #211) para dejar de enmarcar el bootstrap como la unica excepcion al "cero permisos" del flujo ongoing del desarrollador (seccion "El apply de infraestructura ocurre en CI, nunca localmente"): se nombra un tercer perfil, la siembra/custodia recurrente de secretos de Key Vault, y se remite a MEF-ADR-0025 decision #10 para el detalle de los tres perfiles de acceso del marco.
- 2026-07-08: reformado (issue #229, ancla doctrinal, junto con MEF-ADR-0025) para fijar el mecanismo M1: el `apply` de CI, bajo su `Role Based Access Control Administrator`, crea un `azurerm_role_assignment` de `Key Vault Secrets Officer` para el propio SP de CI, scope = el Key Vault del BC -- habilita el step de siembra de secretos post-apply que ordena la reforma de MEF-ADR-0025 (decision #6). Se agrega la seccion "Rol de datos de Key Vault para el propio SP de CI (M1, siembra de secretos)": justifica por que la condicion anti-escalacion lo permite (es un rol de datos, no de administracion de roles) y por que `setup-github-ci.sh` no lo asigna (el vault no existe en el bootstrap). Se actualiza la mencion del perfil (c) (MEF-ADR-0025 decision #10): deja de ser un privilegio manual de infra/admin y pasa a ser una accion automatica de CI. Origen: reporte de campo de un consumidor que, aun siendo Owner de la suscripcion, chocaba con `ForbiddenByRbac` al sembrar a mano un Key Vault con RBAC habilitado sin rol de datos asignado.
- 2026-07-08: corregido (issue #242) para renombrar en el cuerpo (seccion "Rol de datos de Key Vault para el propio SP de CI") el argumento `enable_rbac_authorization = true` a `rbac_authorization_enabled = true`, coherente con el rename que `infra-base-scaffolder` aplico al modulo `key-vault`: el nombre viejo esta deprecado en el provider `azurerm` (~> 4.0) y se remueve en v5.0. Cambio puramente sintactico; ninguna decision de este ADR se modifica (la doctrina de RBAC habilitado sin access policies queda intacta). La mencion del nombre viejo en la entrada de change-log de MEF-ADR-0025 (2026-07-08, #229) se conserva como registro historico del reporte de campo.
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts` que los reemplazaban y su invocacion con `node`. Sin cambio de doctrina.
