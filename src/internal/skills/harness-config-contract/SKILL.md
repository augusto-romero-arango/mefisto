---
name: harness-config-contract
description: "Contrato que el harness Mefisto impone al repo consumidor: esquema completo de `.mefisto/harness.config.json`, las secciones obligatorias de `AGENTS.md` (Tokens del harness, Verificación de fuentes), el puente mínimo de `CLAUDE.md` y la estructura de carpetas esperada (src/, tests/, infra/, docs/). Usar cuando se haga onboarding, scaffolding (dominio, infra base, MCP, proyecciones), validacion de config, o cualquier tarea que lea o escriba `harness.config.json` o dependa de la estructura de carpetas del consumidor."
---

# Contrato con el proyecto consumidor

El plugin asume que el repo consumidor cumple lo siguiente:

## 1. Archivo `.mefisto/harness.config.json`

Los lectores resuelven el archivo canonico `.mefisto/harness.config.json` y aceptan `.claude/harness.config.json` solo como fallback de lectura indefinido (MEF-ADR-0053, decision 4).
Los escritores (`/onboard` paso 6, `/seed-secret` y `upsertHarnessSecret` de `scripts/lib/harness-config.mts`) escriben solo el canonico y rechazan un consumidor solo legacy, pidiendo migrar conscientemente el archivo completo.

El resolver ejecutable de referencia es `resolveHarnessConfigPath` de `scripts/lib/harness-config.mts`; `loadHarnessConfig` lo usa y devuelve la ruta efectiva en `configPath`. Un bloque de bash obtiene la ruta con `scripts/harness-config-path.mts` (`read`, `write` o `valid`). Para prompts, reutiliza la misma precedencia inline del Paso 0 de `agents/infra-base-scaffolder.md`, sin reinventarla.

Tokens operativos consumidos por los scripts del harness. Estructura:

```json
{
  "projectName": "<nombre legible del proyecto>",
  "namespacePrefix": "<prefijo de namespace .NET>",
  "solutionFile": "<nombre>.slnx",
  "infraResourceGroupPrefix": "rg-<proyecto>",
  "terraformStateStorage": "<storage account del tfstate>",
  "githubServicePrincipalName": "github-<proyecto>-ci",
  "appInsightsApp": "<app-insights-component>",
  "domainLabels": ["<dominio1>", "<dominio2>", "..."],
  "boundedContext": {
    "name": "<NombreDelBC>",
    "domains": ["<dominio1>", "<dominio2>", "..."]
  },
  "serviceBus": {
    "internal": { "secretName": "<nombre del secreto KV de la cadena interna>" },
    "external": [
      { "alias": "COSMOS", "alcance": "compartido", "secretName": "<nombre del secreto KV>" }
    ]
  },
  "tenancy": { "strategy": "mono-tenant-transitorio" },
  "projections": { "enabled": true },
  "azureRegionShort": "eus2",
  "resourceSequence": "001",
  "secrets": [
    {
      "name": "<nombre del secreto en Key Vault>",
      "source": { "type": "output", "value": "<nombre del output de terraform>" }
    },
    {
      "name": "<nombre del secreto en Key Vault>",
      "source": { "type": "github-secret", "value": "<NOMBRE_DEL_GITHUB_SECRET>" }
    }
  ]
}
```

Los scripts del harness consumen estos tokens (validación y variables derivadas viven en `scripts/`).

Notas sobre campos concretos:

- **`boundedContext`** (**obligatorio**, MEF-ADR-0023): declara el Bounded Context del proyecto. Subfields:
  - **`name`**: nombre del BC; puede coincidir o no con `projectName`.
  - **`domains`**: dominios del BC; subconjunto de `domainLabels`.
- **`serviceBus`** (opcional, MEF-ADR-0024): registro de los Azure Service Bus que el BC toca. `internal.secretName` (obligatorio si se declara `serviceBus`) nombra el secreto de Key Vault del ASB propio del BC; `external` lista los ASB compartidos/externos que consume o publica. Ningún secreto viaja en claro (MEF-ADR-0025).
- **`tenancy`** (opcional, MEF-ADR-0028): declara la etapa vigente del `ITenantResolver` del BC. `strategy` es `"mono-tenant-transitorio"` (etapa a, greenfield sin autenticación instalada) o `"multi-tenant-header"` (etapa b, ya existe una autenticación que produce un `TenantContext`). **Ausente equivale a `"mono-tenant-transitorio"`** (retrocompatible). Lo consume `domain-scaffolder` inline con `scripts/json-value.mts` en su Paso 0 (mismo patrón que `serviceBus.external`) para elegir el resolver que registra en el `Program.cs` generado; `/onboard` lo reporta de forma informativa (nunca `FALTA`) y puede escribirlo/actualizarlo en un paso opt-in bajo confirmación explícita.
- **`secrets`** (opcional, issue #256): registro declarativo de todo secreto del BC que el step de siembra de `infra-cd.yml` itera en runtime (data-driven, sin líneas hardcodeadas por secreto). Cada entrada declara `name` (el secreto en Key Vault) y `source.type`/`source.value` — de dónde CI toma el valor a sembrar: `output` (un único `terraform output`, derivable) o `github-secret` (un único GitHub secret, no derivable). El tipo `composite` (fórmula fija reservada para `marten-connection`, el único secreto compuesto de varios outputs + un GitHub secret) lo escribe únicamente `infra-base-scaffolder`; el skill `/seed-secret` (que registra secretos nuevos post-greenfield) solo emite `output`/`github-secret`. `infra-base-scaffolder` registra idempotentemente los secretos fijos del BC (interno de ASB, `app-insights-connection`, `marten-connection`, uno por alias de `serviceBus.external[]`) la primera vez que genera `infra-cd.yml`.
- **`projections`** (opcional, MEF-ADR-0034, issue #369): declara si el BC adopta el worker de proyecciones (`{RootNamespace}.Projections`, daemon `HotCold` de Marten). Único subfield, `enabled` (booleano). **Ausente, `null`, `false`, o cualquier valor/tipo distinto del booleano `true` equivale a deshabilitado** (retrocompatible: sin este campo, la salida del harness no cambia). `loadHarnessConfig` lo carga y `harnessConfigEnv` lo expone como `HARNESS_PROJECTIONS_ENABLED` (nunca aborta la carga por este campo). Lo consumen inline `infra-base-scaffolder` (los 3 módulos Terraform opt-in del Container App, MEF-ADR-0034 sección 8) y `/scaffold-projections`/`projections-scaffolder` (el worker en sí); `domain-scaffolder` no lee el token sino su consecuencia — si el worker ya existe en el repo, registra el named store del dominio nuevo en él (Paso 3b, issue #370); `/onboard` lo reporta de forma informativa (nunca `FALTA` si está deshabilitado) y, si está habilitado pero el worker todavía no existe, ofrece encadenar `/scaffold-projections` bajo confirmación explícita.
- **`azureRegionShort`** (opcional, MEF-ADR-0045, issue #729): abreviatura de la región Azure (ej. `"eus2"` para East US 2) que el estándar de nombramiento de recursos usa como componente `{region}` del patrón CAF `{abrev-tipo}-[{uso}-]{app}-{env}-{region}-{seq}`. String libre (el CAF no publica una tabla oficial de abreviaturas de región) declarado por el consumidor, no derivado de `azureLocation`. **Ausente**: retrocompatible — los scaffolders conservan el comportamiento actual (sin `{region}` en el nombre). `loadHarnessConfig` lo carga y `harnessConfigEnv` lo expone como `HARNESS_AZURE_REGION_SHORT` (nunca aborta la carga por este campo). Primer consumidor (issue #732): `scripts/bootstrap-backend.mts`, que con el token declarado nombra el backend del tfstate como `rg-tfstate-{app}-{env}-{region}-{seq}` + `sttfstate{app}{env}{region}{seq}` (sin sufijo aleatorio) e **ignora el contenido de `terraformStateStorage`**, que solo sigue rigiendo el naming legacy; un backend ya escrito en `backend.tf` se reusa tal cual (solo greenfield, MEF-ADR-0045 sección 3). El reporte del token en `/onboard` — informativo, nunca `FALTA`, igual que `tenancy`/`projections` — queda para el issue dependiente que alinea los scaffolders (MEF-ADR-0045 sección 5).
- **`resourceSequence`** (opcional, MEF-ADR-0045, issue #729): secuencia `{seq}` del mismo patrón, string zero-padded (ej. `"001"`). **Ausente**: default `"001"`, expuesto por `harnessConfigEnv` como `HARNESS_RESOURCE_SEQUENCE`.
- **`terraformStateStorage`** es el nombre **base** de la Storage Account del tfstate. Debe cumplir el naming de Azure Storage (3-24 caracteres, solo minúsculas y dígitos — [reglas de nombres de recursos, `Microsoft.Storage`](https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules#microsoftstorage)); para nombres largos abrevia el prefijo. Detalle en README §3.
- **`repoSlug`** (opcional): slug `owner/repo` del fork de Mefisto al que se enrutan los drafts cross-repo (`estado:borrador`). Default: `augusto-romero-arango/mefisto`.
- **`azureLocation`** (opcional): región de Azure por defecto para `bootstrap-backend.mts`.

## 2. Secciones "Tokens del harness" y "Verificación de fuentes" en `AGENTS.md` raíz del consumidor

`AGENTS.md` es la fuente canónica y neutral a runtime de las directivas del consumidor (MEF-ADR-0049, decisión 3; MEF-ADR-0053, decisión 4). Debe contener estas dos secciones obligatorias. La sección de tokens es necesaria porque los agentes/skills del harness no pueden hacer sustitución de variables. Los placeholders `<RootNamespace>`, `<SolutionFile>`, `<ProjectDisplayName>`, `<BoundedContext>` y `<BoundedContextDomains>` se resuelven leyendo el `AGENTS.md` del proyecto. Ejemplo mínimo:

```markdown
### Tokens del harness

- **RootNamespace**: MiProyecto.Nombre
- **SolutionFile**: MiProyecto.slnx
- **ProjectDisplayName**: MiProyecto
- **BoundedContext**: Principal  (nombre del BC; corresponde a `boundedContext.name` en harness.config.json)
- **BoundedContextDomains**: dominio1, dominio2  (lista separada por comas; corresponde a `boundedContext.domains`)
```

`BoundedContext` es el nombre del Bounded Context declarado en `harness.config.json` (MEF-ADR-0023); puede coincidir o no con `ProjectDisplayName`.

Además de "Tokens del harness", el `AGENTS.md` mínimo del consumidor debe incluir la siguiente sección, verbatim, propagando al consumidor el principio de verificación de fuentes del propio harness (ver "Principios de respuesta" en el `AGENTS.md` raíz de este repo):

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

`CLAUDE.md` no duplica estas secciones: es únicamente el puente para Claude Code y puede sumar directivas realmente específicas de ese runtime cuando existan. Su forma mínima es:

```markdown
@AGENTS.md
```

Cuando `AGENTS.md` todavía no existe, un `CLAUDE.md` legacy que contiene estas secciones sigue siendo legible como fallback indefinido. Para migrarlo sin perder directivas exclusivas de Claude Code:

1. mueve las dos secciones obligatorias a `AGENTS.md`;
2. elimina esas copias de `CLAUDE.md` y añade `@AGENTS.md` como línea independiente;
3. conserva en `CLAUDE.md` solo las directivas realmente específicas de Claude Code, si las hay.

Así ambos runtimes consumen la doctrina neutral desde la fuente canónica sin duplicarla. Las convenciones adicionales del proyecto pueden vivir en `AGENTS.md`, pero son opcionales: `/onboard` no debe inventar ni validar un formato para ellas.

## 3. Estructura de carpetas esperada

- `src/<RootNamespace>.{Dominio}/` — Function App por dominio
- `src/<RootNamespace>.{Dominio}.DomainEvents/` — eventos persistidos del dominio en el event store, uno por dominio (MEF-ADR-0039)
- `src/<RootNamespace>.PublicEvents/` — eventos que salen del BC, uno por Bounded Context (MEF-ADR-0039)
- `src/<RootNamespace>.PrivateEvents/` — eventos del bus interno del BC, uno por Bounded Context (MEF-ADR-0039)
- Los tres ensamblados de eventos de arriba son **tres islas**: cada uno con cero `ProjectReference` (MEF-ADR-0039 decision 2); el Function App del dominio referencia los tres, el worker de proyecciones solo `{Dominio}.DomainEvents` + `ReadModels`
- `tests/<RootNamespace>.{Dominio}.Tests/` — tests unitarios ES por dominio
- `tests/<RootNamespace>.{Dominio}.SmokeTests/` — smoke tests black-box (opcional)
- `tests/<RootNamespace>.PublicEvents.Tests/` — tests del ensamblado `PublicEvents`, uno por BC (MEF-ADR-0039)
- `tests/<RootNamespace>.PrivateEvents.Tests/` — tests del ensamblado `PrivateEvents`, uno por BC (MEF-ADR-0039)
- `infra/environments/{env}/` — Terraform por ambiente
- `.mefisto/pipeline/` — ubicacion canonica del estado runtime de los pipelines (la crea el harness en primer arranque y nunca viaja en un commit del consumidor); incluye `sessions.jsonl`, un log append-only que el hook publicado `SessionStart` anota con `session_id`/`transcript_path`/`cwd`/`source`/`timestamp`/`harness_version` en **cada** arranque de sesion sobre el repo — las headless que corren los stages y tambien las interactivas, con `source` distinguiendo `startup`/`resume`/`clear`/`compact` y `harness_version` tomando la identidad de la distribucion cargada (`null` cuando no esta disponible) —, para correlacionar un stage con su transcript completo y con la version de Mefisto que lo ejecuto
- `pipeline/` bajo el directorio de adaptador de Claude Code — exclusivamente el mirror transitorio del marcador de release autorizado por MEF-ADR-0053, decision 4, enmienda #1099: el hook publicado `SessionStart` mantiene `.plugin-root`; `/upgrade` escribe `.plugin-root.previous` con la version cargada y el mismo hook lo limpia en el siguiente arranque. No es destino de logs ni de otro estado runtime.
- `docs/bitacora/field-notes/` — output de los agentes investigadores
- `docs/ddd/ubiquitous-language.yaml` — glosario de lenguaje ubicuo (terminos, actores, preguntas abiertas), custodiado por el `planner` (MEF-ADR-0040)
