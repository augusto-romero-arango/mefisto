# Guía del consumidor

Manual operativo para adoptar Mefisto en un proyecto: instalación, configuración, primeros pasos y uso. Movido desde el [README](../README.md).

## Stack supuesto en el consumidor

- .NET 10 + Azure Functions isolated worker
- Marten (event store) + Wolverine (mediador) sobre PostgreSQL
- Azure Service Bus (topic por evento)
- xUnit v3 + `Cosmos.EventSourcing.Testing.Utilities`
- Terraform para IaC
- GitHub Actions para CI/CD

Si tu proyecto no encaja con este stack, este harness no es para ti.

## Instalación

**Requisito de versión:** el plugin requiere Claude Code >= 2.1.287, la versión que publicó los mods: `hooks/hooks.json` declara la clave `modules`, y una versión anterior podría rechazar el archivo entero y dejarte sin `.plugin-root`, `sessions.jsonl` ni el recordatorio de field notes (MEF-ADR-0055). `/mefisto:onboard` lo verifica (`claude update` para actualizar).

### 1. Configurar `.claude/settings.json` del repo consumidor

Crea (o extiende) `.claude/settings.json` en la raíz del repo consumidor con tres bloques — el marketplace, la habilitación del plugin y los permisos recomendados:

```json
{
  "extraKnownMarketplaces": {
    "augusto-romero-arango-harness": {
      "source": {
        "source": "github",
        "repo": "augusto-romero-arango/mefisto"
      }
    }
  },
  "enabledPlugins": {
    "mefisto@augusto-romero-arango-harness": true
  },
  "permissions": {
    "allow": [
      "Bash(dotnet:*)",
      "Bash(git:*)",
      "Bash(gh:*)",
      "Bash(terraform:*)",
      "Bash(az:*)"
    ],
    "deny": [
      "Bash(terraform destroy:*)",
      "Bash(az group delete:*)",
      "Bash(git push --force:*)"
    ]
  }
}
```

- **`extraKnownMarketplaces`** registra el marketplace que aloja a Mefisto (el repo de GitHub). El esquema del bloque `source` usa la clave `source` (no `type`) con valor `"github"` — ver issue #75. Si tu repo todavía declara `"repo": "augusto-romero-arango/eda-evsourcing-azure-harness"` (el nombre del repo antes del issue #2349), sigue funcionando porque GitHub redirige el nombre viejo; para actualizarlo edita solo ese `repo` y Claude Code vuelve a traer el marketplace desde la fuente nueva ([doc de marketplaces](https://code.claude.com/docs/en/plugins/host-marketplace)). No uses `claude plugin marketplace remove`: desinstala los plugins de ese marketplace. El nombre del marketplace (`augusto-romero-arango-harness`) no cambia.
- **`enabledPlugins`** es **lo que activa Mefisto en este repo**: Mefisto se instala por usuario pero deshabilitado a ese nivel, y la precedencia proyecto > usuario de Claude Code lo habilita solo donde este archivo lo declara (MEF-ADR-0053, decisión 2). Al estar en el `settings.json` versionado, cualquiera que clone el repo arranca con Mefisto habilitado, y los worktrees de pipeline (que nacen de `origin/main`) también. Por eso debe quedar **commiteado**: un `settings.local.json` no viaja. La clave es `<plugin.name>@<marketplace.name>` = `mefisto@augusto-romero-arango-harness` (verificado contra `.claude-plugin/plugin.json` y `.claude-plugin/marketplace.json`). El `/plugin install` interactivo del paso 2 habilita el plugin en tu instalación local pero **no deja artefacto en el repo**, así que sin esta clave la habilitación no es reproducible.
- **`permissions`** es un **punto de partida ajustable** (sintaxis `Bash(<cmd>:*)` de Claude Code; ver la [doc de settings](https://code.claude.com/docs/en/settings)). El `allow` evita la fricción de aprobar uno a uno los `dotnet`/`git`/`gh`/`terraform`/`az` que disparan los pipelines; el `deny` es una red de seguridad contra comandos destructivos (`terraform destroy`, `az group delete`, `git push --force`). Endurécelo o relájalo según la política de tu equipo — el `deny` tiene prioridad sobre el `allow`.

Si Mefisto ya carga en tu sesión y el diagnóstico de `/mefisto:onboard` reporta que el repo no lo habilita, el mismo comando ofrece escribir los dos primeros bloques: muestra el plan y, solo con tu `si`, fusiona `extraKnownMarketplaces` y `enabledPlugins` en `.claude/settings.json` sin tocar el resto de claves. No commitea: commitea el archivo y llévalo a `main`.

### 2. Instalar el plugin una vez por usuario, deshabilitado

Registra el marketplace desde una sesión de Claude Code y, desde una terminal, instala y deshabilita a nivel usuario (el flag `--scope` solo existe en el CLI):

```
/plugin marketplace add augusto-romero-arango-harness
claude plugin install mefisto@augusto-romero-arango-harness --scope user
claude plugin disable mefisto@augusto-romero-arango-harness --scope user
```

> **Por qué instalado pero deshabilitado.** La instalación descarga Mefisto una sola vez a tu máquina, y `/mefisto:upgrade` la actualiza para todos tus repos. Deshabilitarlo a nivel usuario evita que se cargue en repos que no lo usan: un repo ajeno no recibe comandos, agentes, hooks ni la carpeta `.mefisto/`. El `.claude/settings.json` commiteado del paso 1 lo vuelve a habilitar solo en el consumidor. `claude plugin install` reescribe el nivel usuario a habilitado, por eso el `disable` va siempre después; `claude plugin update` lo conserva deshabilitado.

> **Los pipelines no dependen de este paso.** `/infra`, `/implement`, `/scaffold` y los demás corren sus agentes en un git worktree propio (`.mefisto/pipeline/worktrees/<rama>`, dentro del estado ignorado por Git) y les entregan con `--plugin-dir` la raíz de la versión que ejecuta el pipeline. El agente carga esa versión exacta aunque Mefisto no esté habilitado ni registrado para la ruta del worktree.

> **Si ya tenías Mefisto habilitado a nivel usuario**, corre `/mefisto:upgrade` en un repo consumidor: detecta la migración pendiente y, con tu confirmación, lo deshabilita a ese nivel. Se niega si el repo no lo habilita en su `.claude/settings.json` commiteado, para no dejarlo sin Mefisto.

### 3. Configurar el consumidor

Crea `.mefisto/harness.config.json` en la raíz del proyecto consumidor. Agrega exactamente `.mefisto/pipeline/` a tu `.gitignore` — nunca ignores `.mefisto/` completo: `.mefisto/harness.config.json` debe versionarse (misma regla que valida `/mefisto:onboard`, ver `scripts/onboard-diagnose.mts`):

```json
{
  "projectName": "MiProyecto",
  "namespacePrefix": "MiOrg.MiProyecto",
  "solutionFile": "MiProyecto.slnx",
  "infraResourceGroupPrefix": "rg-miproyecto",
  "terraformStateStorage": "stmiproyectotfstatedev",
  "githubServicePrincipalName": "github-miproyecto-ci",
  "appInsightsApp": "appi-miproyecto-dev-eus2-001",
  "azureLocation": "eastus2",
  "domainLabels": ["dominio1", "dominio2"],
  "boundedContext": {
    "name": "Principal",
    "domains": ["dominio1", "dominio2"]
  },
  "tenancy": { "strategy": "mono-tenant-transitorio" },
  "projections": { "enabled": true },
  "azureRegionShort": "eus2",
  "resourceSequence": "001",
  "secrets": [
    {
      "name": "stripe-api-key",
      "source": { "type": "github-secret", "value": "STRIPE_API_KEY" }
    }
  ]
}
```

**Campo `terraformStateStorage` (nombre BASE, solo naming legacy)**: el nombre de una Storage Account es un endpoint DNS público (`*.blob.core.windows.net`) y por tanto **único en todo Azure**, no solo en tu suscripción. Sin `azureRegionShort` declarado (naming legacy, retrocompatible), `scripts/bootstrap-backend.mts` trata este campo como un nombre **base**: le anexa un sufijo aleatorio de 6 caracteres para garantizar unicidad global (mismo patrón `random_string` que el scaffolder usa en las Storage de dominio) y valida la disponibilidad con `az storage account check-name` antes de crear. El nombre **final** (con sufijo) es el que queda en `infra/environments/<env>/backend.tf`, así que `terraform init` usa exactamente la cuenta creada. Declara la base sin sufijo (ej. `stmiproyectotfstatedev`, 22 chars). **Restricción de Azure**: el nombre de una Storage Account debe tener **3-24 caracteres, solo minúsculas y dígitos** ([Microsoft Learn — reglas de nombres de recursos, `Microsoft.Storage`](https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules#microsoftstorage)). El patrón sugerido `st<proyecto>tfstate<env>` deja ~12 caracteres para `<proyecto>` (`st`=2, `tfstate`=7, `dev`=3), así que **para nombres largos abrevia el prefijo del proyecto**: p. ej. `micontrolplane` produce `stmicontrolplanetfstatedev` = **26 chars (inválido)**; abreviado a `mcp` queda `stmcptfstatedev` = 15 chars (válido). `loadHarnessConfig` (`scripts/lib/harness-config.mts`) valida este formato (`^[a-z0-9]{3,24}$`) al cargar el config (issue #78) y aborta temprano si no cumple, en vez de fallar tarde en el `apply`. Si la base **válida** más el sufijo de unicidad no cabe en 24 caracteres, `bootstrap-backend.mts` trunca la base y avisa. Las corridas posteriores reutilizan la cuenta ya creada (idempotente; ancla el nombre en el `backend.tf` versionado y en la cuenta existente del Resource Group del tfstate), no generan un sufijo nuevo.

**Con `azureRegionShort` declarado (naming CAF, MEF-ADR-0045, issue #732)**: `bootstrap-backend.mts` deja de leer `terraformStateStorage` para nombrar el backend nuevo — deriva el Resource Group y la Storage Account únicamente de `infraResourceGroupPrefix` + `env` + `azureRegionShort` + `resourceSequence`, sin sufijo aleatorio (unicidad estructural, MEF-ADR-0045 sección 2): RG `rg-tfstate-{app}-{env}-{region}-{seq}` y Storage `sttfstate{app}{env}{region}{seq}` (sin guiones; `{app}` se trunca si no cabe en 24 chars, preservando el prefijo). Ante colisión real, el fallback es incrementar `resourceSequence` en el config, nunca un sufijo random. `terraformStateStorage` sigue siendo obligatorio en el schema (retrocompatibilidad con el naming legacy), pero su contenido queda sin efecto en este modo. Un backend **ya creado** con el naming legacy (`backend.tf` versionado con el nombre viejo) sigue funcionando sin cambios aunque declares `azureRegionShort` después — ningún recurso desplegado se renombra (MEF-ADR-0045 sección 3, "solo greenfield").

**Campo opcional `azureLocation`**: la región de Azure (ej. `"eastus2"`, `"westeurope"`) donde `scripts/bootstrap-backend.mts` crea el backend de Terraform (Resource Group, Storage Account y container del tfstate). Si lo declaras, el bootstrap lo usa por defecto sin tener que pasar `--location` en cada corrida; el flag `--location` siempre lo sobrescribe. Si no lo declaras y tampoco pasas `--location`, el bootstrap aborta pidiéndote uno de los dos. Es **opcional**, así que añadirlo no es un cambio incompatible del schema (no es MAJOR).

> **`azureLocation` (backend del tfstate) ≠ región de PostgreSQL.** `azureLocation` solo fija dónde vive el backend del `tfstate` (Resource Group, Storage Account, container); **no** es la región del PostgreSQL Flexible Server que `/infra-base` provisiona como event store de Marten (MEF-ADR-0003, MEF-ADR-0021). Esa región se fija con el default versionado `postgresql_location` en `infra/environments/<env>/variables.tf` y **puede —y a veces debe— diferir** de `azureLocation`: en el primer greenfield real (`Bitakora.ControlAsistencia`), `eastus2` —válido para el backend del tfstate— devolvió `LocationIsOfferRestricted` al crear el PostgreSQL Flexible Server, y se resolvió usando `centralus`. Para que CI conserve el cambio, edita y versiona también el default `postgresql_region_short` con la abreviatura de la región real; por ejemplo:
>
> ```hcl
> variable "postgresql_location" {
>   default = "centralus"
> }
>
> variable "postgresql_region_short" {
>   default = "cus"
> }
> ```
>
> No derives `cus` desde `centralus`: decláralo según la convención regional del consumidor (MEF-ADR-0045). Este cambio no altera `location` ni `azure_region_short`, que siguen describiendo los recursos primarios ya ubicados en `eastus2`. `terraform.tfvars` permanece ignorado exclusivamente para overrides locales no versionados y no es una fuente de configuración de runners limpios; nunca guardes allí `postgresql_admin_password` ni otro secreto. Ese error depende de tu **suscripción/oferta** (la región figura como soportada en la [lista oficial de regiones de Postgres](https://learn.microsoft.com/azure/postgresql/overview#azure-regions), pero la oferta no está habilitada para tu suscripción ahí), no es una indisponibilidad global de la región — por eso no hay una región "apta" universal y conviene verificar la tuya **antes del primer `terraform apply`**, no descubrir la restricción en el apply:
>
> ```bash
> az postgres flexible-server list-skus --location <region> -o table
> ```
>
> Si lista SKUs (entre ellas `Standard_B1ms`, la SKU de cómputo que usa el módulo `postgresql` — `list-skus` y `--sku-name` la nombran así, con el tier `Burstable` como parámetro aparte; el provider `azurerm` la declara en `sku_name` como `B_Standard_B1ms`, anteponiendo el tier, que es el valor que figura en la tabla de módulos del MEF-ADR-0021), la región sirve para tu suscripción; si sale vacío o falla, elige otra (p. ej. `centralus`). El comando es la referencia oficial de Azure CLI ([`az postgres flexible-server list-skus`](https://learn.microsoft.com/cli/azure/postgres/flexible-server)). Ver MEF-ADR-0021, sección "Región de PostgreSQL Flexible Server".

**Campo `boundedContext`** (**obligatorio**, MEF-ADR-0023): declara el Bounded Context del proyecto. Un BC es un grupo de dominios relacionados que comparte un resource group de Azure y dos namespaces de Azure Service Bus (interno e integración). `loadHarnessConfig` valida los dos subfields y exporta `HARNESS_BC_NAME` y `HARNESS_BC_DOMAINS`:

- **`name`**: nombre del BC, 1-63 caracteres alfanuméricos y guiones. Puede coincidir o no con `projectName` (ej: "Principal", "Admin", "Core").
- **`domains`**: array de dominios del BC, no vacío. Cada elemento debe estar en `domainLabels`. Los dominios del BC son un subconjunto de todos los dominios del proyecto (en proyectos con un solo BC, el subconjunto es igual a `domainLabels`).

El resource group del BC se forma como `infraResourceGroupPrefix`+`-`+`name` (ej: `rg-miproyecto-principal`). El context map (registro de BCs externos) es trabajo diferido; hoy el BC solo se nombra a sí mismo.

> **Proyectos existentes (que vienen de una versión sin este campo)**: si `boundedContext` no está en tu config, `loadHarnessConfig` aborta con un mensaje accionable que muestra el shape exacto a añadir y un ejemplo con tus `domainLabels` actuales. Corre `/mefisto:onboard` para obtener el diagnóstico, o lee la sección **"Migración para consumidores existentes"** al final de este documento.

**Campo opcional `repoSlug`**: el slug `owner/repo` del repositorio de Mefisto al que se enrutan los **drafts cross-repo** (`estado:borrador`) que crean el `planner` y el `tooling-investigator` cuando detectan que un problema descubierto en tu proyecto pertenece al harness. Sirve para redirigir esos drafts a **tu fork** de Mefisto en vez del repo upstream. Si no lo declaras, el default es `augusto-romero-arango/mefisto`. Si lo declaraste con el nombre previo del repo (`augusto-romero-arango/eda-evsourcing-azure-harness`), los drafts siguen llegando por la redirección de GitHub, pero conviene actualizarlo. No se exporta como variable `HARNESS_*`: se lee directo donde se necesita (`scripts/lib/pipeline/consumer-scope.mts`, `agents/planner.md`, `agents/tooling-investigator.md`). Es **opcional** (añadirlo no es MAJOR).

**Campo opcional `tenancy`** (MEF-ADR-0028, issue #323): declara la etapa vigente del `ITenantResolver` del BC. Único subfield, `strategy`, con dos valores válidos:

- **`"mono-tenant-transitorio"`** (etapa a): greenfield sin autenticación instalada. Es el default de `domain-scaffolder` (issue #318) y el valor asumido si el campo está **ausente** (retrocompatible con todo consumidor existente).
- **`"multi-tenant-header"`** (etapa b): el proyecto ya instaló una autenticación que produce un `TenantContext` (header-based o el híbrido HTTP+Wolverine de `Cosmos.MultiTenancy.CritterStack`).

`domain-scaffolder` lee este campo inline con `scripts/json-value.mts` en su Paso 0 (mismo patrón que `serviceBus.external`) para elegir el `ITenantResolver` que registra en el `Program.cs` del dominio que scaffoldea: en etapa (a) genera el resolver mono-tenant transitorio (sin cambios respecto a #318); en etapa (b) auto-cablea el resolver híbrido genérico de `Cosmos.MultiTenancy.CritterStack`, dejando un `// TODO(tenancy claims)` para el mapping claims → `TenantContext` (siempre project-specific). `/onboard` reporta el valor de forma informativa (ausente o cualquiera de los dos valores nunca es `FALTA`) y ofrece un paso opt-in que pregunta la estrategia vigente y escribe/actualiza el campo, solo bajo confirmación explícita -- `/onboard` no sondea código para inferir la etapa. Es **opcional** (añadirlo no es MAJOR). Ver MEF-ADR-0028 para el modelo completo de dos etapas.

**Campo opcional `projections`** (MEF-ADR-0034, issue #369): declara si el Bounded Context adopta el worker de proyecciones (`<RootNamespace>.Projections`, el daemon asíncrono `HotCold` de Marten que materializa los read models). Único subfield, `enabled` (booleano):

- **Ausente, `null`, `false`, o cualquier valor/tipo distinto del booleano `true`** equivale a **deshabilitado** -- retrocompatible: sin este campo, ningún generador del harness cambia su salida.
- **`true`**: el BC adopta proyecciones. Habilita, de forma opt-in: los 3 módulos Terraform del Container App sin ingress que suma `infra-base-scaffolder` (`container-registry`, `container-app-environment`, `container-app`, ver "Bootstrap de infraestructura" paso 3 y MEF-ADR-0034 sección 8) y el worker en sí, que genera `/scaffold-projections` (agente `projections-scaffolder`).

`loadHarnessConfig` expone la variable derivada `HARNESS_PROJECTIONS_ENABLED` (nunca aborta la carga por este campo, issue #369); `infra-base-scaffolder` y `/scaffold-projections`/`projections-scaffolder` hoy lo consumen inline con `scripts/json-value.mts` (mismo patrón minimalista que `tenancy.strategy`). `domain-scaffolder` no lee el token: detecta el worker ya generado y, si está, registra en él el named store del dominio nuevo (issue #370, MEF-ADR-0034 sección 2) — un dominio scaffoldeado en un BC sin worker sale exactamente igual que antes. `/onboard` reporta el estado -- habilitado y si el worker ya existe -- de forma informativa (nunca `FALTA` si está deshabilitado) y, cuando el token está en `true` pero el worker todavía no existe, ofrece encadenar `/scaffold-projections` bajo confirmación explícita. Es **opcional** (añadirlo no es MAJOR). Ver MEF-ADR-0034 para la doctrina completa del worker.

**Campos opcionales `azureRegionShort`/`resourceSequence`** (MEF-ADR-0045, issue #729): componentes `{region}`/`{seq}` del estándar de nombramiento de recursos Azure que los scaffolders del harness aplican al generar Terraform **nuevo** — patrón CAF `{abrev-tipo}-[{uso}-]{app}-{env}-{region}-{seq}` (ej. `kv-miproyecto-dev-eus2-001`), con la tabla completa de abreviaturas adoptadas y la política de unicidad (sin sufijos random; ante colisión real se incrementa `{seq}`) en MEF-ADR-0045. `azureRegionShort` es un string libre (ej. `"eus2"` para East US 2 — el CAF no publica una tabla oficial de abreviaturas de región) que declaras vos, no derivado de `azureLocation`. `resourceSequence` es la secuencia zero-padded (default `"001"`). Ambos son **opcionales y retrocompatibles**: ausentes, los scaffolders conservan el comportamiento actual (sin `{region}`/`{seq}` en el nombre) y `loadHarnessConfig` los expone igual, con sus defaults (`""` y `"001"`), sin abortar nunca la carga — `HARNESS_AZURE_REGION_SHORT`/`HARNESS_RESOURCE_SEQUENCE`. Cuando `/onboard` incorpore el reporte de estos tokens (issue dependiente), debe tratarlos de forma informativa, nunca como `FALTA`, igual que `tenancy`/`projections`. La corrección aplica **solo hacia adelante**: ningún recurso ya desplegado se renombra (MEF-ADR-0045 sección 3).

**Campo opcional `secrets`** (issue #256): registro **declarativo** de todo secreto del BC que el step de siembra de `infra-cd.yml` itera en runtime, sin ninguna línea hardcodeada por secreto. Cada entrada declara:

- **`name`**: el nombre del secreto en el Key Vault del BC.
- **`source.type`**: de dónde CI toma el valor a sembrar -- `output` (un único `terraform output`, derivable) o `github-secret` (un único GitHub secret, no derivable; lo crea manualmente un admin). Un tercer valor, `composite` (fórmula fija reservada para `marten-connection`, el único secreto compuesto de varios outputs + un GitHub secret), lo escribe **únicamente** `infra-base-scaffolder` -- nunca lo emite `/seed-secret`.
- **`source.value`**: el nombre del output de Terraform o del GitHub secret, según `source.type`.

`infra-base-scaffolder` registra idempotentemente los secretos **fijos** del BC (el interno de ASB, `app-insights-connection`, `marten-connection` y uno por cada alias de `serviceBus.external[]`) la primera vez que genera `infra-cd.yml` (ver "Bootstrap de infraestructura", paso 3). Para sembrar un secreto **nuevo** después del greenfield -- p. ej. la API key de un proveedor externo --, usa el skill `/seed-secret` (ver catálogo de skills), que registra la entrada y cablea la referencia en la Function App del dominio que la consume. `loadHarnessConfig` valida la forma del array (`name` único, `source.type` en el vocabulario de arriba, `source.value` no vacío); es **opcional** (añadirlo no es MAJOR).

Añade estas dos secciones a `AGENTS.md` raíz del consumidor. Es la fuente canónica de doctrina neutral a runtime; los agentes y skills del harness resuelven allí los tokens:

```markdown
### Tokens del harness

- **RootNamespace**: MiOrg.MiProyecto
- **SolutionFile**: MiProyecto.slnx
- **ProjectDisplayName**: MiProyecto
- **BoundedContext**: Principal  (nombre del BC; corresponde a `boundedContext.name` en harness.config.json)
- **BoundedContextDomains**: dominio1, dominio2  (lista separada por comas; corresponde a `boundedContext.domains`)
```

`BoundedContext` es el nombre del Bounded Context: grupo de dominios relacionados que comparte resource group y namespaces de Azure Service Bus (MEF-ADR-0023).

Añade también, verbatim, la sección "Verificación de fuentes" al mismo `AGENTS.md` — propaga al consumidor el principio de verificación de fuentes del propio harness, para que aplique aunque el usuario nunca invoque los skills/agentes de Mefisto:

```markdown
### Verificación de fuentes (obligatorio para agentes)

Antes de proponer o aplicar un ajuste técnico, verifica el enfoque contra la
**documentación oficial y vigente** de las tecnologías del stack (.NET, Azure
Functions, Marten, Wolverine, Azure Service Bus, Terraform, …). No te apoyes en
conocimiento memorizado: puede estar desactualizado. Al afirmar una best practice
o recomendación, **cita la fuente** (URL oficial, versión del paquete, ADR). Si un
dato no pudiste verificarlo contra la fuente, decláralo como *no verificado* en
tu propuesta en vez de darlo por cierto.
```

Para Claude Code, crea o conserva `CLAUDE.md` como puente mínimo con esta línea independiente:

```markdown
@AGENTS.md
```

Puedes añadir allí directivas realmente específicas de Claude Code, pero no dupliques las dos secciones neutrales. Las convenciones adicionales del proyecto pueden vivir opcionalmente en `AGENTS.md`; `/onboard` no inventa ni valida un formato para ellas.

### 4. Verificar instalación

El objetivo es confirmar que el plugin quedó **instalado y habilitado**, no que existan pipelines corridos (que en un proyecto recién creado todavía no hay). Dos checks que funcionan en greenfield, sin depender de artefactos de runtime (`.claude/pipeline/`):

1. **El plugin aparece instalado.** Lista los plugins instalados sin abrir el gestor:

   ```
   /plugin list
   ```

   Debe aparecer `mefisto@augusto-romero-arango-harness` (con `/plugin list --enabled` ves solo los habilitados). Como alternativa, `/plugin` abre el gestor: en la pestaña **Installed** el plugin aparece con los componentes que aporta (skills, agentes, hooks). Ver la [doc oficial de plugins](https://code.claude.com/docs/en/discover-plugins#manage-installed-plugins).

2. **Los skills `/mefisto:*` están disponibles.** Corre:

   ```
   /help
   ```

   y verifica que los comandos del namespace del plugin aparecen en el catálogo (p. ej. `/mefisto:draft`, `/mefisto:implement`, `/mefisto:onboard`). Que `/help` liste los skills bajo el namespace del plugin es la señal documentada de que el plugin cargó (ver la [guía oficial de plugins](https://code.claude.com/docs/en/plugins), sección «Test your plugin»).

El criterio de éxito es **"los comandos `/mefisto:*` aparecen disponibles"**, no "responden sin datos".

> **En un proyecto greenfield es esperable que los skills de runtime no muestren nada — y eso NO indica un fallo de instalación.** Los skills de runtime leen el estado de los pipelines (aún sin pipelines corridos). Que no haya nada que mostrar solo significa que todavía no has corrido pipelines: la instalación se verifica con los dos checks de arriba, no con que haya datos de pipelines.

Para un diagnóstico del onboarding (¿está bien formado el `harness.config.json`?, ¿existen los labels?, ¿está configurado el CI?), corre el doctor de onboarding (por defecto solo diagnostica):

```
/mefisto:onboard
```

Imprime un checklist con estado por ítem (OK / FALTA / NO VERIFICADO) y, para cada FALTA, el comando que lo resuelve. Por defecto no crea ni modifica nada; como excepciones opt-in, cada una solo tras tu confirmación explícita, puede migrar las directivas contractuales a `AGENTS.md`, provisionar los labels faltantes, configurar el CI hacia Azure (OIDC, MEF-ADR-0022), escribir `tenancy.strategy`, encadenar `/mefisto:scaffold-projections`, habilitar Mefisto en el repo y crear `.mefisto/appinsights.env`.

## Primeros pasos con el harness (greenfield)

Esta es la ruta de arranque para un proyecto **nuevo** (sin código ni infraestructura aún), en orden. Asume que ya completaste la sección **Instalación**.

> **¿Prefieres la versión corta primero?** [`docs/greenfield-quickstart.md`](greenfield-quickstart.md) narra este mismo camino en 10 pasos y el modelo de dos roles (admin/infra vs dev ongoing) — léelo si quieres el mapa antes del detalle exhaustivo de abajo.

### 1. Habilitar el plugin en el repo y verificar

Commitea el `.claude/settings.json` con `extraKnownMarketplaces` y `enabledPlugins` (sección Instalación, paso 1) e instala Mefisto una vez por usuario, deshabilitado (paso 2). Reinicia la sesión de Claude Code en la raíz del repo consumidor para que lo cargue.

Comprueba que el plugin cargó (mismo criterio que "Verificar instalación", paso 4 de la sección Instalación):

```
/plugin list
```

`mefisto@augusto-romero-arango-harness` debe aparecer habilitado en este repo, y `/help` debe listar los skills `/mefisto:*`. En un repo ajeno debe aparecer deshabilitado. En este punto greenfield aún no hay pipelines, así que no hay estado de pipelines que mostrar: eso es esperable y no indica un fallo de instalación.

> **Los worktrees de los pipelines.** Los pipelines (`/infra`, `/implement`, `/scaffold`) corren sus agentes en un **git worktree** propio (`.mefisto/pipeline/worktrees/<rama>`) con `claude -p ... --agent <nombre> --plugin-dir <raíz>`, donde `<raíz>` es la versión de Mefisto que ejecuta el pipeline. Por eso el agente se encuentra aunque Mefisto no esté habilitado ni registrado para esa ruta. Antes de esa entrega, un plugin sin cargar en el worktree abortaba con `agent '<nombre>' not found`.

### 2. Crear `.mefisto/harness.config.json`

Crea el archivo de configuración en la raíz del consumidor (sección Instalación, paso 3). Para el bootstrap de infra conviene declarar también el campo opcional `azureLocation` con tu región de Azure (ej. `"eastus2"`), así no tienes que pasar `--location` en cada corrida. Añade además las secciones "Tokens del harness" y "Verificación de fuentes" a tu `AGENTS.md` raíz y el puente `CLAUDE.md` con `@AGENTS.md`.

Cuando lo tengas, corre `/mefisto:onboard` para verificar de un vistazo que el config está bien formado y qué te falta (labels, CI). Por defecto solo diagnostica; bajo tu confirmación explícita puede además provisionar los **labels** faltantes (el script subyacente es destructivo) y configurar el **CI** hacia Azure (crea recursos reales en Azure vía OIDC; debe correr **después** de `bootstrap-backend.mts`, ver paso 5). También puedes correr `setup-github-labels.mts` / `setup-github-ci.mts` a mano si prefieres.

### 3. Entender el modelo de ejecución (importante)

**Los scripts del harness NO viven en tu repo.** El plugin se instala en el cache del marketplace (`~/.claude/plugins/cache/.../mefisto/.../`, read-only). Por eso **nunca** invocas `./scripts/...` desde el consumidor: esa ruta resolvería contra `<tu-repo>/scripts/...` (inexistente). Los skills y agentes localizan el script por **ruta absoluta al plugin** pero operan sobre tu repo (`cwd = consumidor`, vía `git rev-parse --show-toplevel` y `loadHarnessConfig`).

El patrón canónico para resolver la raíz del plugin es:

```bash
PLUGIN_ROOT=$(cat .mefisto/pipeline/.plugin-root 2>/dev/null)
[ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT=$(cat .claude/pipeline/.plugin-root 2>/dev/null)
[ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT=$(ls -d "$HOME"/.claude/plugins/cache/*/mefisto/*/ 2>/dev/null | sort -V | tail -1)
PLUGIN_SCRIPTS="${PLUGIN_ROOT%/}/scripts"
node "$PLUGIN_SCRIPTS/<script>.mts" <args>
```

`.mefisto/pipeline/.plugin-root` es el marker canónico que escribe el hook `SessionStart` al abrir la sesión (persiste `${CLAUDE_PLUGIN_ROOT}`). Durante la transición, el hook refleja exactamente la misma identidad en `.claude/pipeline/.plugin-root`; se lee solo como fallback de compatibilidad. El fallback final localiza el plugin por glob sobre el cache tomando la versión más reciente. Normalmente **no necesitas correr esto a mano**: lo hacen los skills (`/infra`, etc.) y los agentes (`infra-bootstrap`, `planner`) por ti.

### 4. Bootstrap del repo del consumidor (labels y CI)

Antes del primer `/draft` o `/implement`, tu repo necesita dos prerequisitos operativos que el harness **no** crea solo: el esquema de **labels** de GitHub y la **autenticación de CI** hacia Azure. Ambos se provisionan con scripts del plugin, así que se invocan **plugin-relative** (nunca `./scripts/...` desde tu repo —los scripts del harness no viven en él, ver paso 3): resuelve `$PLUGIN_SCRIPTS` y llama al script por ruta absoluta. Los dos llevan el guard defensivo de MEF-ADR-0019 y **abortan si se corren dentro del repo de Mefisto** (solo aplican al consumidor).

Para verificar de un vistazo qué falta (labels ausentes, CI sin configurar) antes y después de este paso, corre el doctor de onboarding `/mefisto:onboard` (por defecto solo diagnostica; bajo tu confirmación puede provisionar los labels faltantes y configurar el CI hacia Azure —este último, después del bootstrap del backend del paso 5).

**a. Labels de GitHub** — `setup-github-labels.mts`. El `planner`, `/draft` y los pipelines exigen los labels dimensionales `tipo:*`, `dom:*` y `estado:{borrador|listo}` como prerequisito operativo (**MEF-ADR-0007**); sin ellos el primer `/draft` falla al etiquetar. El script **borra 8 de los 9 labels default de GitHub** (`documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`) y **recrea `bug`** con el esquema del harness, además de crear el resto del esquema, incluyendo un `dom:<x>` por cada entrada de `domainLabels` en `.mefisto/harness.config.json`. **Prerequisitos**: `gh auth login` y el campo `domainLabels` ya declarado en el config (paso 2).

```bash
PLUGIN_ROOT=$(cat .mefisto/pipeline/.plugin-root 2>/dev/null)
[ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT=$(cat .claude/pipeline/.plugin-root 2>/dev/null)
[ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT=$(ls -d "$HOME"/.claude/plugins/cache/*/mefisto/*/ 2>/dev/null | sort -V | tail -1)
PLUGIN_SCRIPTS="${PLUGIN_ROOT%/}/scripts"
node "$PLUGIN_SCRIPTS/setup-github-labels.mts"
```

**b. CI hacia Azure** — `setup-github-ci.mts <subscription-id>`. Configura, vía OIDC, la autenticación de GitHub Actions hacia Azure (**MEF-ADR-0022**). **Prerequisitos**: `gh auth login`, `az login` y el `<subscription-id>` de Azure. Como **resuelve el nombre real de la Storage Account del tfstate** (con el sufijo de unicidad que le puso el bootstrap) para asignar el rol de acceso, **depende del backend del tfstate y debe ejecutarse DESPUÉS de crearlo**: la descripción completa (roles asignados, federated credentials) y la invocación viven en el paso 5 (Bootstrap de infraestructura, sub-paso 2), no aquí.

### 5. Bootstrap de infraestructura

El backend remoto de Terraform (donde vive el `tfstate`) es prerequisito de todo lo demás. El orden es:

1. **Crear el backend del tfstate** con `bootstrap-backend.mts` (idempotente; crea Resource Group y Storage Account endurecida y container `tfstate`, y escribe `infra/environments/<env>/backend.tf` con el nombre final resuelto). El naming sigue dos formas según si declaraste `azureRegionShort` (MEF-ADR-0045, issue #732, ver la nota de `terraformStateStorage` arriba): sin declarar, `rg-<proyecto>-tfstate` y Storage con **sufijo de unicidad global** sobre el nombre base de `terraformStateStorage` (legacy, retrocompatible); declarado, `rg-tfstate-<proyecto>-<env>-<region>-<seq>` y Storage `sttfstate<proyecto><env><region><seq>` sin sufijo aleatorio (forma CAF):

   ```bash
   PLUGIN_ROOT=$(cat .mefisto/pipeline/.plugin-root 2>/dev/null)
   [ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT=$(cat .claude/pipeline/.plugin-root 2>/dev/null)
   [ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT=$(ls -d "$HOME"/.claude/plugins/cache/*/mefisto/*/ 2>/dev/null | sort -V | tail -1)
   PLUGIN_SCRIPTS="${PLUGIN_ROOT%/}/scripts"
   node "$PLUGIN_SCRIPTS/bootstrap-backend.mts" --subscription <subscription-id> --env dev
   ```

   (Pasa `--location <region>` si no declaraste `azureLocation` en el config.) También puedes dejar que lo orqueste el agente `infra-bootstrap`, que encadena este paso con el primer `/infra`.

   > **Primera corrida: rol de datos requerido.** La primera vez que corres `bootstrap-backend.mts`, el paso que crea el container `tfstate` usa `--auth-mode login` (acceso por AAD, sin access key): tu identidad de Azure (`az login`) necesita el rol de datos **`Storage Blob Data Contributor`** sobre la Storage Account del tfstate, además de los permisos de control plane para crearla. Si eres `Owner` de la suscripción/resource group ya lo tienes implícito; si solo eres `Contributor` (que no otorga acceso a datos de blobs), asígnatelo tú mismo o pide que te lo asignen antes de correr el script. Si falta, el script aborta con un mensaje que nombra el rol; es idempotente, así que basta reintentar tras la propagación RBAC (unos minutos).

   > **Nota**: el script escribe `backend.tf` en tu working tree. El pipeline IaC (`/infra`) ramifica su worktree desde `origin/main`, así que **automatiza** que ese `backend.tf` llegue al worktree: lo copia del working tree al worktree y lo commitea en la rama del pipeline, de modo que viaja en el PR y se versiona en `main` vía merge. No necesitas commitearlo ni subirlo a `main` a mano antes del primer `/infra` (el `terraform init` del reviewer ya encuentra el backend remoto y no cae a estado local).

2. **Configurar la autenticación de CI hacia Azure** con `setup-github-ci.mts`. Usa **OIDC** (Workload Identity Federation, ver **MEF-ADR-0022**): crea el Service Principal de GitHub Actions **sin secret** y le asigna, a nivel suscripción, `Contributor` (deploy de Functions e infraestructura) y `Role Based Access Control Administrator` con una condición ABAC anti-escalación (para que el `apply` de CI pueda crear los role assignments que emiten los scaffolders — **MEF-ADR-0025** — sin poder auto-asignarse `Owner`, `User Access Administrator` ni el propio rol); y sobre el tfstate ya creado, `Storage Blob Data Contributor` (lectura+escritura por AAD, backend keyless) — resuelve el nombre **final** de la Storage Account —con el sufijo que le puso el bootstrap— leyéndolo del `backend.tf` recién escrito, así que la asignación de rol apunta a la cuenta real, no al nombre base del config. Le añade además **dos federated credentials**: uno que confía en la rama `main` del repo (deploy de código y `apply` de infra) y otro en el evento `pull_request` (el `terraform plan` que corre en cada PR). Por eso corre **después** del paso 1:

   > **Idempotencia parcial de la condición ABAC.** `az role assignment create` es idempotente (no falla si la asignación ya existe), pero **no actualiza la condición** de una asignación que ya exista con el mismo principal/rol/alcance. La asignación de `Role Based Access Control Administrator` con la condición anti-escalación la introdujo el issue #195 (antes, el script solo asignaba `Contributor` y lectura del tfstate), así que en un onboarding limpio se crea de una vez **con** la condición. El caso a vigilar: si el SP ya tuviera una asignación de `Role Based Access Control Administrator` **sin** esa condición —creada fuera de este script (p. ej. a mano), o si una versión futura del script cambia la expresión de la condición—, re-correr `setup-github-ci.mts` detecta la asignación existente y la deja tal cual: **no** le aplica ni actualiza la condición, y el SP queda con el rol sin la restricción anti-escalación. **Diagnóstico**: `az role assignment list --assignee <appId> --query "[?roleDefinitionName=='Role Based Access Control Administrator'].condition"` — si sale vacío, borra la asignación (`az role assignment delete`) y vuelve a correr el script para que la recree **con** la condición. El arreglo del script (detectar y recrear automáticamente) queda diferido a un issue aparte.

   ```bash
   node "$PLUGIN_SCRIPTS/setup-github-ci.mts" <subscription-id>
   ```

   El slug `owner/repo` (subject del federated credential) se resuelve automáticamente vía `gh` o el remote `origin`; pásalo como 2º argumento si necesitas forzarlo. Copia los **tres** secrets que imprime —`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`— a *Settings > Secrets and variables > Actions* de tu repo. **No hay client secret que expire**: el workflow de deploy del scaffolder se autentica con `azure/login` por OIDC (declara `permissions: id-token: write`), no con el JSON único `AZURE_CREDENTIALS`.

3. **Generar la infraestructura base** con `/infra-base` (agente `infra-base-scaffolder`). Es el eslabón entre el backend y el primer `/infra`: escribe los 8 módulos Terraform base (`resource-group`, `monitoring`, `postgresql`, `service-bus`, `service-plan`, `storage`, `function-app`, `key-vault`) y el esqueleto del entorno (`main.tf`, `variables.tf`, `providers.tf`, `outputs.tf`) — **sin** `backend.tf` (ese lo escribió el paso 1). Si el BC declara `projections.enabled` en `harness.config.json`, suma además 3 módulos **opt-in** para el worker de proyecciones (`container-registry`, `container-app-environment`, `container-app` — Container App sin ingress) y su cableado al Key Vault por identidad administrada; sin ese token la salida no cambia. Es idempotente: si ya existen archivos, los respeta. Ver **MEF-ADR-0021** y **MEF-ADR-0034**.

   ```
   /mefisto:infra-base dev
   ```

   `variables.tf` declara dos variables requeridas sin default -- `alert_email` y `postgresql_admin_password` -- que **nunca** van en un `terraform.tfvars` commiteado (MEF-ADR-0025): `infra-cd.yml` las alimenta como `TF_VAR_alert_email`/`TF_VAR_postgresql_admin_password` desde una GitHub **variable** (`ALERT_EMAIL`) y un GitHub **secret** (`TF_VAR_POSTGRESQL_ADMIN_PASSWORD`) que **crea manualmente el admin del repo** en *Settings > Secrets and variables > Actions* (pestañas *Variables* y *Secrets* respectivamente) -- `setup-github-ci.mts` no los toca. Usa como valor del secret el **mismo** password que CI reutiliza, dentro del mismo `apply`, para sembrar `marten-connection` en el Key Vault (ver paso 5), para no manejar dos valores. `subscription_id` ya no es una variable de este entorno: el provider `azurerm` la resuelve nativamente de `ARM_SUBSCRIPTION_ID` (secret ya copiado en el paso 2). El scaffolder también genera un `.gitignore` en el entorno que excluye `terraform.tfvars`, reservado para overrides locales no versionados. Si PostgreSQL vive fuera de la región primaria, versiona juntos los defaults `postgresql_location`/`postgresql_region_short` en `variables.tf` (ejemplo: `centralus`/`cus`) para que CI reciba la región y el nombre CAF reales. Sin esta base, `/infra` y `/scaffold` asumen módulos que no existirían y fallarían.

   > **Valida `postgresql_location` antes del primer `terraform apply`.** No tiene por qué coincidir con `azureLocation` (que es solo la región del backend del tfstate). Algunas regiones devuelven `LocationIsOfferRestricted` al crear el PostgreSQL Flexible Server según tu suscripción —`eastus2` lo hizo en el primer greenfield real, resuelto con `centralus`—. Si eliges otra región, cambia y versiona juntos en `variables.tf` los defaults `postgresql_location = "centralus"` y `postgresql_region_short = "cus"`; la segunda es la abreviatura explícita del componente CAF, no una derivación del harness. No cambies `location` ni `azure_region_short`, que siguen siendo los valores de los recursos primarios en `eastus2`. `terraform.tfvars` ignorado queda solo para pruebas locales no reproducibles en CI. Verifica la tuya con `az postgres flexible-server list-skus --location <region> -o table` (debe listar `Standard_B1ms`); ver la nota del campo `azureLocation` (sección "Configurar el consumidor") y MEF-ADR-0021.

4. **Primer `/infra`**: lanza el pipeline IaC para tu primer issue `tipo:infra`. El pipeline escribe y revisa el HCL de forma **estática** (sin `terraform plan` ni `apply` local, sin credenciales de Azure) y abre un PR:

   ```
   /mefisto:infra <numero-de-issue>
   ```

   > **El apply es de CI, no local (MEF-ADR-0021, MEF-ADR-0022).** En el flujo *ongoing* el desarrollador que usa Mefisto no aplica ni planifica local: no necesita `az login` con permisos elevados de Azure ni acceso al tfstate. `/infra` solo escribe/revisa el HCL y abre el PR (que **no** lleva `Closes #N`). El `terraform plan` real se publica como comentario del PR y el `terraform apply` real corre al mergearlo a `main`, ambos en CI (workflow `Infra CD`); ese workflow cierra el issue cuando el apply termina exitosamente. El bootstrap inicial (backend + CI, pasos 1-2) sí es una operación privilegiada de una sola vez que corre un admin con permisos de Azure.

5. **GitHub secrets que alimentan la siembra de secretos en CI** -- ya no hay ninguna acción manual sobre el Key Vault (**MEF-ADR-0025** decisión #10, perfil (c) reformado). Tras el `apply` que corre en CI al mergear el PR del paso 4, el mismo job itera `harness.config.json > secrets[]` y siembra con `az keyvault secret set` **todos** los secretos del BC -- Terraform nunca escribe su valor (MEF-ADR-0025 decisión #6) --, habilitado por el rol de datos `Key Vault Secrets Officer` que el propio `apply` se autoasigna sobre el vault (mecanismo M1, **MEF-ADR-0022**). Ningún humano necesita un rol de datos de Key Vault. `/infra-base` ya registró en `secrets[]`, de forma idempotente, los secretos fijos del BC (ver campo `secrets` en "Configurar el consumidor"); el step de siembra es **data-driven**: no tiene ninguna línea hardcodeada por secreto, así que agregar uno nuevo después del greenfield (`/seed-secret`, ver catálogo de skills) nunca exige editar `infra-cd.yml` a mano.

   Lo único que le queda al admin del repo es crear, en *Settings > Secrets and variables > Actions*, los GitHub secrets que alimentan los valores que CI no puede derivar de `terraform output`:

   | Secreto de Key Vault | GitHub secret que lo alimenta | Cuándo crearlo |
   |---|---|---|
   | `marten-connection` | `TF_VAR_POSTGRESQL_ADMIN_PASSWORD` | ya lo creaste en el paso 3 -- el mismo valor sirve para crear el servidor PostgreSQL y para componer este secreto |
   | cada `serviceBus.external[].secretName` con `alcance: "compartido"` | `SB_EXTERNAL_<ALIAS>_CONNECTION_STRING` (uno por alias, MEF-ADR-0024 decisión #4) | antes del primer `apply` que declare ese alias, con el valor que provee el equipo de infra dueño del backbone compartido |
   | cada secreto nuevo con `source.type: "github-secret"` (`/seed-secret --from-github-secret`) | el nombre que declares en `source.value` | antes del primer `apply` que lo siembre |

   `serviceBus.internal.secretName` y `app-insights-connection` no requieren ningún GitHub secret: CI los deriva directamente de `terraform output` (`service_bus_interno_connection_string` y `app_insights_connection_string`, respectivamente); lo mismo aplica a cualquier secreto nuevo registrado con `source.type: "output"`.

### 6. Scaffold del primer dominio y primer ciclo TDD

Con el backend listo, crea el scaffold de tu primer dominio y arranca el ciclo TDD:

```
/mefisto:scaffold <dominio>      # estructura src/ + tests/ + módulos de infra del dominio
/mefisto:draft "primera capacidad del dominio"   # captura la idea como issue borrador
# el planner refina el issue a estado:listo
/mefisto:implement <issue>       # pipeline TDD: test-writer (rojo) -> implementer (verde) -> reviewer -> PR
```

Si tu dominio necesita un secreto nuevo (una API key de un proveedor externo, otra cadena de conexión, etc.), registra y cablea la referencia con:

```
/mefisto:seed-secret <nombre> --domain <Dominio> (--from-output <output-de-terraform> | --from-github-secret <NOMBRE_DEL_GITHUB_SECRET>)
```

### 7. Qué corre dónde

| Acción | `cwd` | Dónde vive el binario/artefacto |
|---|---|---|
| Skills (`/infra`, `/implement`, `/scaffold`, ...) | tu repo consumidor | definición en el plugin (cache del marketplace) |
| `bootstrap-backend.mts`, `setup-github-ci.mts`, `iac-pipeline.mts`, `tdd-pipeline.mts`, ... | operan sobre tu repo consumidor | binario en el plugin; se resuelven vía `$PLUGIN_SCRIPTS` |
| `terraform plan` (en cada PR) / `terraform apply` (al mergear a `main`) | **runner de GitHub Actions**, nunca tu máquina | workflow `.github/workflows/infra-cd.yml` (lo genera `/infra-base`; MEF-ADR-0021, MEF-ADR-0022) |
| ADRs del marco (`docs/adr/`) | — | en el plugin; los agentes los leen vía `$PLUGIN_ROOT/docs/adr/` |
| `.mefisto/harness.config.json`, `AGENTS.md`, `CLAUDE.md` (puente), `src/`, `tests/`, `infra/` | tu repo consumidor | **tu repo** (los crea/edita el harness operando sobre el consumidor) |
| `infra/environments/<env>/backend.tf` | tu repo consumidor | **tu repo** (lo escribe `bootstrap-backend.mts` en runtime) |

Regla mnemónica: **los binarios viven en el plugin; los archivos del proyecto viven en tu repo.** Nunca edites archivos dentro del cache del plugin ni invoques sus scripts con rutas relativas. Y desde la reforma de la oleada "apply en CI" (MEF-ADR-0021, MEF-ADR-0022): **el plan/apply de infraestructura vive en CI, nunca en tu máquina** — la única excepción es el bootstrap inicial (backend + CI, sección "Bootstrap de infraestructura" arriba), una operación privilegiada de una sola vez que corre un admin con permisos de Azure. La siembra de los secretos de Key Vault (mismo paso 5) **ya no** es un tercer perfil manual recurrente: es un step automático dentro del mismo `apply` de CI, habilitado por el rol de datos que el propio `apply` se autoasigna sobre el vault (mecanismo M1, MEF-ADR-0022) — ningún humano necesita un rol de datos de Key Vault. Los perfiles de acceso **humanos** del marco quedan en dos (el tercer perfil de la decisión #10, la siembra, ya no lo ejecuta una persona sino CI): (a) desarrollador ongoing, cero credenciales de Azure, y (b) bootstrap, privilegiado y de una sola vez.

## Uso

Los skills aparecen con el namespace del plugin: `/mefisto:implement <issue>`, `/mefisto:scaffold <dominio>`, etc.

Flujo típico:

```
/draft "registrar marcaciones biométricas"     # captura idea como issue borrador
# planner refina el issue a estado:listo
/implement <issue>                              # pipeline TDD
# pr-sync mergea el PR
```
