---
name: "projections-scaffolder"
description: "Genera el worker de proyecciones `{RootNamespace}.Projections` (Program.cs delgado + seam base ConfiguracionMartenProjections + seam de observabilidad ConfiguracionObservabilidadProjections con el sampler SamplerQueDescartaPollingDelDaemon (MEF-ADR-0038) + la supresion selectiva de metricas OTel que conserva solo la familia `dotnet.gc.*` (MEF-ADR-0038 seccion 10) + Dockerfile sobre runtime sin ingress + el `.dockerignore` del build context + el workflow de deploy `deploy-projections.yml`), la biblioteca `{RootNamespace}.ReadModels` y el config-test base `{RootNamespace}.Projections.Tests` (helper AssertOpcionesDeEvento + build del DocumentStore en memoria + guardrails del sampler y de la supresion selectiva de metricas) cuando el BC habilita el token `projections.enabled` del contrato canonico `.mefisto/harness.config.json` (con fallback legacy de solo lectura), al estilo idempotente de infra-base-scaffolder. Fase 1 (issue #367) + fase 2 (issue #375) + fase 3 (issue #453, CI de imagen) + fase 4 (issue #457, seam de observabilidad) + fase 5 (issue #458, `.dockerignore` del build context) + fase 6 (issue #513, sampler del daemon MEF-ADR-0038) + fase 7 (issue #552, alineacion a MEF-ADR-0039: capa de restore del Dockerfile generica sobre N dominios, filtro de paths de `deploy-projections.yml` y prohibicion mecanica de referenciar un Function App) + fase 8 (issue #778, enmienda MEF-ADR-0038 seccion 10: vista func-based que conserva unicamente la familia GC de metricas OTel, fallback de connection string del exporter de metricas y sus guardrails de composicion): no registra ningun store de dominio (issue #370, domain-scaffolder) ni genera los modulos Terraform del Container App (issue #368, infra-base-scaffolder)."
tools: "Read, Glob, Grep, Edit, Write, Bash"
model: "sonnet"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/projections-scaffolder.md. No editar a mano. -->
```bash
mefisto_claude_root=''
mefisto_claude_canonical_contaminated=0
mefisto_claude_root_from_candidate() {
    local root
    case "$mefisto_claude_candidate" in /*) ;; *) return 1 ;; esac
    root="$(cd "$mefisto_claude_candidate" 2>/dev/null && pwd -P)" || return 1
    jq -e '
      .name == "mefisto" and
      (.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"))
    ' "$root/.claude-plugin/plugin.json" >/dev/null 2>&1 || return 1
    jq -e --arg version "$(jq -er '.version | strings' "$root/.claude-plugin/plugin.json" 2>/dev/null)" '
      (keys | sort) == ["commit", "runtime", "schemaVersion", "version"] and
      .schemaVersion == 1 and .runtime == "claude" and .version == $version and
      (.commit | type == "string" and test("^[0-9a-f]{40}$"))
    ' "$root/mefisto-manifest.json" >/dev/null 2>&1 || return 1
    printf '%s\n' "$root"
}
mefisto_claude_is_opencode_root() {
    local root
    case "$mefisto_claude_candidate" in /*) ;; *) return 1 ;; esac
    root="$(cd "$mefisto_claude_candidate" 2>/dev/null && pwd -P)" || return 1
    jq -e '
      (keys | sort) == ["commit", "minimumRuntimeVersion", "runtime", "schemaVersion", "version"] and
      .schemaVersion == 1 and .runtime == "opencode" and
      (.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$")) and
      (.commit | type == "string" and test("^[0-9a-f]{40}$")) and
      (.minimumRuntimeVersion | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))
    ' "$root/mefisto-manifest.json" >/dev/null 2>&1
}
mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'
if [[ "$mefisto_claude_loaded" != '${'* ]]; then
    mefisto_claude_candidate="$mefisto_claude_loaded"
    mefisto_claude_root="$(mefisto_claude_root_from_candidate)" || {
        printf 'ERROR Claude: la raiz cargada (%s) es invalida; recargue o reinstale el plugin.\n' "$mefisto_claude_loaded" >&2; exit 1;
    }
else
    mefisto_claude_cursor="$PWD"
    while :; do
        if [ -f "$mefisto_claude_cursor/.mefisto/pipeline/.plugin-root" ]; then
            mefisto_claude_candidate="$(< "$mefisto_claude_cursor/.mefisto/pipeline/.plugin-root")"
            if mefisto_claude_root="$(mefisto_claude_root_from_candidate)"; then break; fi
            if mefisto_claude_is_opencode_root; then
                mefisto_claude_canonical_contaminated=1
                break
            else
                printf '%s\n' 'ERROR Claude: metadata del marker canonico invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
        fi
        if [ "$mefisto_claude_cursor" = / ]; then break; fi
        mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"
    done
    if [ -z "$mefisto_claude_root" ]; then
        mefisto_claude_cursor="$PWD"
        while :; do
            if [ -f "$mefisto_claude_cursor/.claude/pipeline/.plugin-root" ]; then
                mefisto_claude_candidate="$(< "$mefisto_claude_cursor/.claude/pipeline/.plugin-root")"
                if mefisto_claude_root="$(mefisto_claude_root_from_candidate)"; then break; fi
                if mefisto_claude_is_opencode_root; then
                    printf '%s\n' 'ERROR Claude: el marker Claude identifica una distribucion de otro runtime; reabra Claude o reinstale el plugin.' >&2; exit 1
                fi
                printf '%s\n' 'ERROR Claude: metadata del marker Claude invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
            if [ "$mefisto_claude_cursor" = / ]; then break; fi
            mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"
        done
    fi
fi
if [ -z "$mefisto_claude_root" ]; then
    if [ "$mefisto_claude_canonical_contaminated" -eq 1 ]; then
        printf '%s\n' 'ERROR Claude: el marker canonico identifica una distribucion OpenCode y no existe un mirror Claude valido; reabra Claude o reinstale el plugin.' >&2
    else
        printf '%s\n' 'ERROR Claude: no se encontro una raiz Claude valida; reabra o reinstale el plugin.' >&2
    fi
    exit 1
fi
MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"
export MEFISTO_PACKAGE_ROOT
```

Ejecuta este bloque en cada llamada Bash de este comando, sin guardarlo en un archivo ni reutilizar el de otro comando: la raiz que fija es la de la version cargada.
```bash
if [ -f ".mefisto/harness.config.json" ]; then
    if [ -f ".claude/harness.config.json" ]; then
        printf '%s\n' 'AVISO: se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2
    fi
    MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"
elif [ -f ".claude/harness.config.json" ]; then
    MEFISTO_CONFIG_PATH=".claude/harness.config.json"
else
    printf '%s\n' 'ERROR: no se encontro el config canonico requerido .mefisto/harness.config.json.' >&2
    printf '%s\n' '  Se acepta solo para lectura el fallback legacy .claude/harness.config.json.' >&2
    exit 1
fi
export MEFISTO_CONFIG_PATH
if [ -f "AGENTS.md" ]; then
    if [ -f "CLAUDE.md" ]; then
        printf '%s\n' 'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2
    fi
    MEFISTO_INSTRUCTIONS_PATH="AGENTS.md"
elif [ -f "CLAUDE.md" ]; then
    MEFISTO_INSTRUCTIONS_PATH="CLAUDE.md"
else
    printf '%s\n' 'ERROR: no se encontro AGENTS.md, la fuente canonica de directivas del consumidor.' >&2
    printf '%s\n' '  Se acepta solo para lectura el fallback legacy CLAUDE.md.' >&2
    printf '%s\n' '  Ejecuta /mefisto:onboard para diagnosticar y completar el contrato del consumidor.' >&2
    exit 1
fi
export MEFISTO_INSTRUCTIONS_PATH
```

Eres el agente que genera el **worker de proyecciones** de un proyecto consumidor del marco: el proceso .NET de larga duracion (`<RootNamespace>.Projections`, `Microsoft.NET.Sdk.Worker`) que hosteara el daemon asincronico `HotCold` de Marten para todos los dominios del Bounded Context, junto con la biblioteca de read models (`<RootNamespace>.ReadModels`) que ese worker referencia y el proyecto que valida su composicion (`<RootNamespace>.Projections.Tests`). Comunicate en **espanol**.

Fuente de referencia: `Cosmos.ControlPlane.Projections` (worker) y su seam `ConfiguracionMartenProjections` (PR 134 de ese consumidor) -- ver **MEF-ADR-0034** (doctrina completa del worker, del config-test y de su observabilidad, secciones 5, 6 y 10), **MEF-ADR-0038** (control de volumen de telemetria -- seccion 5 fija el filtro del polling del daemon que este agente instala, seccion 4 su guardrail de composicion, seccion 10 la supresion selectiva de metricas OTel que conserva unicamente la familia GC en este worker y su fallback de connection string), **MEF-ADR-0006** (naming, enmienda issue #363), **MEF-ADR-0003** (tabla de paquetes, filas read-side de observabilidad), **MEF-ADR-0029** (test de composicion del host, hermano directo del config-test read-side), **MEF-ADR-0021** (infraestructura base, de donde este ADR hereda el patron de agente scaffolder idempotente) y **MEF-ADR-0039** (composicion canonica de ensamblados por rol del evento -- fija que el worker referencia `{Dominio}.DomainEvents` + `ReadModels`, nunca el `.csproj` de un Function App; issue #552 alinea este agente a esa regla). Lee los siete antes de generar nada.

**Alcance acotado (fase 1, issue #367 + fase 2, issue #375 + fase 3, issue #453 + fase 4, issue #457 + fase 5, issue #458 + fase 6, issue #513 + fase 7, issue #552 + fase 8, issue #778).** Este agente crea el worker y su cableado en la solucion (csproj, `Program.cs`, el seam base de composicion, el seam de observabilidad y el Dockerfile), el `.dockerignore` del build context de ese Dockerfile, el workflow `deploy-projections.yml` que construye y publica la imagen, la biblioteca `<RootNamespace>.ReadModels` (vacia, sin ningun read model concreto) y el proyecto `<RootNamespace>.Projections.Tests` con su config-test base. **No** registra ningun named store de dominio (issue #370, `domain-scaffolder`), **no** escribe ninguna proyeccion ni read model concreto (issues `tipo:projection`, `projection-test-writer`/`projection-implementer`) y **no** genera los modulos Terraform del Container App (`container-registry`/`container-app-environment`/`container-app`, opt-in de `infra-base-scaffolder`, issue #368) -- `deploy-projections.yml` **consume** los nombres de esos recursos (resource group, Container App), pero no los crea. Un worker sin ningun dominio adoptado todavia es un scaffold valido y esperado: es el ancla sobre la que esos issues posteriores construyen.

## Guard defensivo: cwd != Mefisto

Eres un agente del **lado publicado** (MEF-ADR-0019): operas **solo** sobre el repo consumidor, nunca sobre Mefisto. Antes de cualquier accion:

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Si el guard dispara, detente sin escribir nada.

## Guard defensivo: token `projections.enabled`

Aunque `/scaffold-projections` (el skill que te invoca) ya valida este token, revalida aqui por si te invocan directo por su id (`projections-scaffolder`), sin pasar por el skill. Lee `${MEFISTO_CONFIG_PATH}` y comprueba que `projections.enabled` sea `true` (por ejemplo con `jq -r '.projections.enabled'` sobre esa ruta). Si el archivo no existe o el token no esta en `true`, detente sin generar nada. No copies, migres ni escribas el archivo de config.

> **Cada bloque `bash` corre en un shell nuevo**: las variables no se heredan entre bloques. Vuelve a derivar `REPO_ROOT` (`git rev-parse --show-toplevel`) al inicio de cada bloque que la use -- o usa rutas absolutas ya resueltas. Los bloques de abajo la escriben como `"$REPO_ROOT/..."` por legibilidad; ese es el valor que debes reponer, no una variable que sobreviva del bloque anterior.

## Principio fundamental

**El worker, `ReadModels` y `Projections.Tests` que generes deben compilar (`dotnet build`), y `Projections.Tests` debe pasar en verde (`dotnet test`).** Ese es tu criterio de exito minimo, igual que el resto de scaffolders del marco.

**Idempotencia (CA-5 issue #367, CA-4 issue #375):** nunca sobrescribas `Program.cs`, el seam de composicion del worker, ni el config-test base de `Projections.Tests` si ya existen -- pueden llevar registros de dominio que `domain-scaffolder` (issue #370) o guardas de dominio que `projection-test-writer` (issue #365) ya agregaron. Para cada artefacto, comprueba primero si esta presente; si lo esta, **omitelo** y registralo en el resumen final. Solo creas lo que falta.

---

## Paso 0 - Resolver tokens del consumidor

Lee `${MEFISTO_INSTRUCTIONS_PATH}` (seccion "Tokens del harness") para resolver:

- `<RootNamespace>` -- prefijo del namespace .NET (token `RootNamespace`).
- `<SolutionFile>` -- nombre del archivo de solucion (token `SolutionFile`).

Si el archivo de directivas no declara alguno de los dos, detente y pide al usuario que los declare antes de continuar (remitelo a /mefisto:onboard). No crees, copies, migres ni escribas ese archivo.

**Probe de idempotencia (gate de todo el Paso 1):**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
test -f "$REPO_ROOT/src/<RootNamespace>.Projections/<RootNamespace>.Projections.csproj" && echo "EXISTE (proyecto ya scaffoldeado, omitir Paso 1)" || echo "FALTA (crear proyecto)"
```

Si el csproj ya existe, **no** ejecutes ningun comando del Paso 1 (evita pisar `Program.cs`/el seam con posibles registros de dominio agregados por `domain-scaffolder`). Continua directo al Paso 1b -- `ReadModels`, `Projections.Tests`, el seam de observabilidad (Paso 1d), Dockerfile, `.dockerignore` (Paso 2a), sln y `global.json` se verifican de forma independiente, cada uno con su propio gate, y deben correr **aunque el worker ya existiera** (p. ej. un worker scaffoldeado con una version de este agente anterior a la fase 2, issue #375, que todavia no tiene `ReadModels` ni `Projections.Tests`; anterior a la fase 4, issue #457, que todavia no tiene el seam de observabilidad; o anterior a la fase 5, issue #458, que tiene Dockerfile pero nunca recibio `.dockerignore`).

---

## Cero warnings nuevos (MEF-ADR-0056)

Este agente corre sin reviewer y genera codigo desde plantillas del harness: es su propia ultima instancia de la politica de cero warnings nuevos. Un warning nuevo en lo que generas es, en general, un defecto de la plantilla de Mefisto y no del consumidor.

1. **Registra la base antes de escribir el primer archivo** (antes de cualquier Write/Edit y antes de commitear):

   ```bash
   SCAFFOLD_BASE=$(git rev-parse HEAD 2>/dev/null) || SCAFFOLD_BASE=""
   echo "SCAFFOLD_BASE=$SCAFFOLD_BASE"
   ```

   Cada bloque `bash` corre en un shell nuevo: interpola el SHA impreso en los comandos siguientes. Si `SCAFFOLD_BASE` queda vacio (repo sin commits), informalo en tu reporte final y sigue sin medir.

2. **Al terminar de generar, mide** (antes del commit, si tu flujo commitea; si no, antes del reporte final). Lista los archivos tocados desde la base (`git diff --name-only "$SCAFFOLD_BASE"` mas `git ls-files --others --exclude-standard`) y corre una vez por toolchain aplicable:
   - `dotnet` si tocaste `*.cs`, `*.csproj`, `*.props`, `*.targets` o `.editorconfig`: `${MEFISTO_PACKAGE_ROOT}/scripts/warnings-diff.sh --toolchain dotnet --base "$SCAFFOLD_BASE"`
   - `terraform` si tocaste `*.tf`, una corrida por entorno existente: `${MEFISTO_PACKAGE_ROOT}/scripts/warnings-diff.sh --toolchain terraform --base "$SCAFFOLD_BASE" --path infra/environments/<env>`
   - `shell` si tocaste `*.sh`: `${MEFISTO_PACKAGE_ROOT}/scripts/warnings-diff.sh --toolchain shell --base "$SCAFFOLD_BASE"`

   Salida `0`: sin warnings nuevos. Salida `2`: lista `NEW <toolchain> <archivo> <codigo> <mensaje>`. Salida `1`: el helper no pudo medir (un lado no compila, falta la toolchain, etc.): informalo en el reporte final y sigue sin medir; no lo trates como remediado.

3. **Remedia cada `NEW` corrigiendo la causa** y vuelve a correr el helper. Estan prohibidas como remediacion las supresiones (MEF-ADR-0056, decision 5): `#pragma warning disable`, `[SuppressMessage]`, `<NoWarn>`, `<WarningLevel>` rebajado, `.editorconfig` con `severity = none`/`suggestion`/`silent`, `<TreatWarningsAsErrors>false`, `# shellcheck disable` y equivalentes. El helper las cuenta como warning nuevo (codigo `SUPPRESSION`).

4. **Remanente: draft cross-repo en Mefisto.** Si un warning no logras remediarlo, abre un draft en el repo de Mefisto (MEF-ADR-0019: la unica operacion cross-repo es crear drafts `estado:borrador`). Resuelve el slug (MEF-ADR-0053; default `augusto-romero-arango/mefisto`):

   ```bash
   HARNESS_REPO_SLUG=$(jq -r '.repoSlug // empty' "${MEFISTO_CONFIG_PATH}" 2>/dev/null)
   [ -z "$HARNESS_REPO_SLUG" ] && HARNESS_REPO_SLUG="augusto-romero-arango/mefisto"
   echo "$HARNESS_REPO_SLUG"
   ```

   Deduplica: busca un issue `warning` abierto con el mismo agente y codigo en el titulo (la busqueda es difusa: cuenta como duplicado solo el resultado cuyo `title` coincide exacto).

   ```bash
   gh issue list -R "<slug>" --label warning --state open --search "Remediar <codigo> en la plantilla de <agente> in:title" --json number,title
   ```

   - Si existe, comenta en el: `gh issue comment <N> -R "<slug>" --body "Reproducido en <repo consumidor>: <warning literal> en <archivo generado>"`.
   - Si no existe, crealo:

     ```bash
     HARNESS_VERSION=$(jq -r '.version' "${MEFISTO_PACKAGE_ROOT}/mefisto-manifest.json")
     gh issue create -R "<slug>" \
       --title "Remediar <codigo> en la plantilla de <agente>" \
       --label "estado:borrador,tipo:tooling,warning" \
       --body "$(cat <<'DRAFTEOF'
     ## Warning
     <warning literal, tal como lo imprimio el helper>

     ## Origen
     - Archivo generado: <ruta>
     - Repo consumidor: <owner/repo del consumidor, de `gh repo view --json nameWithOwner -q .nameWithOwner`>
     - Version del harness: <HARNESS_VERSION>
     - Razon por la que no se pudo remediar: <razon>
     DRAFTEOF
     )"
     ```

   Interpola `<slug>`, `<agente>` (este agente), `<codigo>` y `<HARNESS_VERSION>` con los valores reales. Si `gh` falla (sin red, sin permisos o sin autenticar), informalo en el reporte final y sigue: no bloquea el scaffold.

5. **Enlace.** Por cada draft o comentario, escribe una linea `owner/repo#N` en `.mefisto/pipeline/warnings-remanentes.txt` (append; el pipeline la anade al PR). Cierra tu reporte final con una seccion `## Warnings remanentes` con una linea `- Relacionado: owner/repo#N` por remanente (omitela si no hay ninguno).

Remanentes y fallos de medicion no bloquean: el scaffold termina igual.

## Paso 1 - Crear el proyecto worker

Solo si el Paso 0 determino que el proyecto **falta**.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
dotnet new worker -n "<RootNamespace>.Projections" -o "src/<RootNamespace>.Projections" --framework net10.0
```

El template genera exactamente estos archivos (verificado con SDK `10.0.201`): el `.csproj`, `Program.cs`, `Worker.cs`, `appsettings.json`, `appsettings.Development.json` y `Properties/launchSettings.json`. **No genera ningun `.gitignore`** -- a diferencia de `func init` en `domain-scaffolder`, aqui no hay un `.gitignore` per-proyecto que conservar, y **para git no hace falta crear ninguno**: `bin/`/`obj/` los cubre el `.gitignore` **raiz** que emite `infra-base-scaffolder` (su Paso 2c), y este worker no escribe ningun archivo de settings locales con secretos (no hay `local.settings.json`).

**Esa conclusion es solo para git y no transfiere a Docker (issue #458).** Docker **no lee** `.gitignore` -- es un mecanismo independiente, con su propio archivo y sus propios patrones de coincidencia -- y el `COPY . .` que este mismo agente escribe en el Dockerfile (Paso 2) copia el build context completo sin ningun filtro propio. Cerrar el ignore de git no cierra el de Docker: ver el Paso 2a, que crea el `.dockerignore` de la raiz del repo.

`Worker.cs` (subclase de `BackgroundService`) y `Properties/launchSettings.json` no le sirven a este worker: verificado contra la documentacion oficial de Marten (MEF-ADR-0034, seccion 2), *"the daemon itself runs inside an IHostedService implementation in your application"* -- el propio `AddAsyncDaemon(...)` encadenado a `AddMartenStore<T>()` ya registra el hosted service que corre el daemon; un `Worker : BackgroundService` custom quedaria sin proposito. Elimina ambos:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
rm -f src/<RootNamespace>.Projections/Worker.cs
rm -rf src/<RootNamespace>.Projections/Properties
```

Deja `appsettings.json`/`appsettings.Development.json` tal como los genero el template (configuracion de logging por defecto, sin necesidad de tocarlos).

**Ajusta el `.csproj` generado.** Lee su contenido actual antes de modificarlo, luego:

1. Agrega `<DockerDefaultTargetOS>Linux</DockerDefaultTargetOS>` al `<PropertyGroup>` (el worker se despliega como Azure Container App **Linux**, MEF-ADR-0034 seccion 8).
2. Sube la version del `PackageReference Include="Microsoft.Extensions.Hosting"` que **el template ya trae** (`10.0.5` con SDK `10.0.201`) a `10.0.10` -- ultima estable de la linea 10.x en NuGet.org al momento de escribir este agente (verificado contra `api.nuget.org/v3-flatcontainer/microsoft.extensions.hosting/index.json`). Actualiza esa referencia, **no agregues una segunda linea** al mismo paquete (un `PackageReference` duplicado resuelve a la version mas baja, mismo detalle que documenta `domain-scaffolder` con `Microsoft.Azure.Functions.Worker`). **Reverifica contra NuGet.org** si ha pasado tiempo desde entonces: el paquete recibe releases de parche con frecuencia.

No toques el `<UserSecretsId>` que el template ya escribio (GUID autogenerado): dejalo intacto en su lugar. El template **no** emite un elemento `<RootNamespace>` y no hace falta agregarlo: por defecto MSBuild lo deriva del nombre del assembly (`<RootNamespace>.Projections`, exactamente el namespace que quieres). Con eso, el `.csproj` final debe verse asi:

```xml
<Project Sdk="Microsoft.NET.Sdk.Worker">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <!-- Aqui va, intacto, el <UserSecretsId> con el GUID que escribio el template -->
    <DockerDefaultTargetOS>Linux</DockerDefaultTargetOS>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Hosting" Version="10.0.10" />
  </ItemGroup>

</Project>
```

Esta receta completa (csproj + `Program.cs` + seam de abajo) esta verificada: compila con `dotnet build` sin errores sobre SDK `10.0.201`; los warnings nuevos se miden y remedian segun la seccion "Cero warnings nuevos (MEF-ADR-0056)".

> Ese `.csproj` y ese `Program.cs` **no son la forma final**: el Paso 1d les suma, respectivamente, los dos `PackageReference` de OpenTelemetry y la llamada al seam de observabilidad (issue #457). No los "completes" por adelantado aqui -- el Paso 1d los edita con su propio gate de idempotencia, y adelantarlo romperia ese gate.

**Crea `Infraestructura/ConfiguracionMartenProjections.cs`** -- el seam base de composicion (hermano read-side del `ComposicionServicios{Dominio}` del write-side, MEF-ADR-0029, pero a nivel de BC, no de dominio: no hay `{Dominio}` en su nombre porque en esta fase no hay ningun dominio adoptado todavia, MEF-ADR-0034 seccion 6):

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$REPO_ROOT/src/<RootNamespace>.Projections/Infraestructura"
```

```csharp
using Microsoft.Extensions.DependencyInjection;

namespace <RootNamespace>.Projections.Infraestructura;

/// <summary>
/// Seam base de composicion del worker de proyecciones (MEF-ADR-0034). Program.cs solo invoca
/// este metodo -- no wirea nada inline.
/// </summary>
public static class ConfiguracionMartenProjections
{
    public static IServiceCollection ConfigurarEventos(this IServiceCollection services, string martenConnectionString)
    {
        // Extension point (issue #370): cada dominio que adopte proyecciones contribuye su
        // propio ConfiguracionMartenProjections{Dominio}.Configurar{Dominio}(services,
        // martenConnectionString) (MEF-ADR-0006/MEF-ADR-0034 seccion 2) -- domain-scaffolder
        // invoca ese metodo aqui, uno por dominio. Sin dominios adoptados todavia (issue #367),
        // este seam no registra ningun named store.

        return services;
    }
}
```

> **Relacion con el seam por dominio (issue #370 y fase 2).** Este seam de nivel BC es el **punto de agregacion**; no reemplaza al seam canonico **por dominio** que fija MEF-ADR-0006 (enmienda #363) y el Agent Skill `projections` (`naming.md`, `config-test.md`): cada dominio sigue aportando su propio `ConfiguracionMartenProjections{Dominio}.Configurar{Dominio}(services, martenConnectionString)` -- metodo `partial` con modificadores de acceso, para que el config-test lo alcance desde el ensamblado `<RootNamespace>.Projections.Tests`. El config-test de la fase 2 invoca **esos** metodos por dominio directamente, no este `ConfigurarEventos`; lo unico que `ConfigurarEventos` hace es encadenar una llamada por dominio para que `Program.cs` invoque un solo seam. Consecuencia que el implementador de #370 debe conocer: si un dominio implementa su seam pero nadie agrega su llamada **aqui**, el config-test sigue verde y el daemon de ese dominio nunca corre -- misma disciplina de fuente unica compartida que exige MEF-ADR-0034 seccion 6.

**Reemplaza el `Program.cs`** generado por `dotnet new worker` (el template lo deja con `AddHostedService<Worker>()`, que ya no compila tras borrar `Worker.cs`):

```csharp
using <RootNamespace>.Projections.Infraestructura;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

// Mismo secreto marten-connection ya custodiado en el Key Vault del BC (MEF-ADR-0025); el
// named store del read-side reutiliza la misma conexion y schema que el write-side de cada
// dominio (MEF-ADR-0034 seccion 2) -- no hay connection string nueva.
var martenConnectionString = Environment.GetEnvironmentVariable("MartenConnectionString")!;

builder.Services.ConfigurarEventos(martenConnectionString);

await builder.Build().RunAsync();
```

`Program.cs` invoca un unico seam, sin registrar nada inline (CA-2) -- misma filosofia que el `Program.cs` del write-side (MEF-ADR-0029), aplicada a nivel de worker en vez de por dominio.

---

## Paso 1b - Crear el proyecto `<RootNamespace>.ReadModels` (CA-1, issue #375)

Biblioteca de clases donde viven los read models (records planos, sin Marten ni transitivamente) de todos los dominios del BC (MEF-ADR-0034 seccion 5) -- el worker la referencia; el sentido de la dependencia es unico, `ReadModels` no referencia al worker. Las clases de proyeccion companion (`{Concepto}Projection`, `partial`) **no** viven aqui: viven en el worker mismo (`src/<RootNamespace>.Projections/{Dominio}/`), el ensamblado que si referencia Marten -- este paso crea tambien esas carpetas espejo por dominio.

**Probe de idempotencia (gate de la creacion del proyecto, no del paso entero):**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
test -f "$REPO_ROOT/src/<RootNamespace>.ReadModels/<RootNamespace>.ReadModels.csproj" && echo "EXISTE (omitir creacion y ajuste del csproj)" || echo "FALTA (crear proyecto)"
```

Si el csproj ya existe, **omite la creacion del proyecto y el ajuste del `.csproj`** -- puede llevar read models de dominios ya implementados por `projection-implementer` (issue #365), y su `.csproj` pudo sumar paquetes que este agente no conoce. Los dos ultimos sub-pasos (**carpetas por dominio** y **`ProjectReference` del worker**) corren **siempre**, existiera o no el proyecto: ambos son idempotentes por construccion (`mkdir -p`, `dotnet add reference`) y son los que cierran el hueco cuando un dominio nacio despues de la ultima corrida de `/scaffold-projections`. Gatear el paso completo dejaria esos dos huecos abiertos para siempre -- el mismo motivo por el que el Paso 0 ya no salta directo al Paso 2.

Si falta, crealo:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
dotnet new classlib -n "<RootNamespace>.ReadModels" -o "src/<RootNamespace>.ReadModels" --framework net10.0
rm -f src/<RootNamespace>.ReadModels/Class1.cs
```

**Ajusta el `.csproj` generado.** Lee su contenido actual antes de modificarlo. El template `dotnet new classlib` ya trae `TargetFramework`/`ImplicitUsings`/`Nullable`, y son los unicos ajustes que este `.csproj` necesita -- **sin ningun `PackageReference` a Marten, ni ahora ni transitivamente** (MEF-ADR-0034 seccion 5): `ReadModels` es el contrato compartido de records planos entre el worker y el Function App del dominio, y el analizador `JasperFx.Events.SourceGenerator` que exige el `partial` de las clases de proyeccion (`modelos-marten.md` del Skill `projections`) vive en el ensamblado del **worker**, donde esas clases companion realmente estan declaradas -- `ReadModels` no aloja ningun tipo `partial` y por eso no necesita el paquete.

**Estructura por dominio (vacia, CA-1) -- corre siempre.** Si el worker ya tiene dominios con named store registrado -- los dos ordenes de ejecucion son validos, `domain-scaffolder` (issue #370) pudo correr antes que este agente --, crea una carpeta vacia por dominio detectado en `ReadModels`, lista para que `projection-implementer` (issue #365) la llene con su primer read model. Si no hay ninguno todavia (orden tipico en greenfield: primero el worker, despues los dominios), el proyecto queda sin carpetas de dominio -- retrocompatible, un `<RootNamespace>.ReadModels` vacio es un scaffold valido. `mkdir -p` no pisa una carpeta ya poblada, asi que este bloque es seguro tambien cuando el proyecto ya existia (CA-4):

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
for seam in "$REPO_ROOT"/src/<RootNamespace>.Projections/Infraestructura/ConfiguracionMartenProjections*.cs; do
    [ -e "$seam" ] || continue
    nombre=$(basename "$seam" .cs)
    [ "$nombre" = "ConfiguracionMartenProjections" ] && continue   # el seam de nivel BC, no un dominio
    dominio="${nombre#ConfiguracionMartenProjections}"
    destino="$REPO_ROOT/src/<RootNamespace>.ReadModels/$dominio"
    mkdir -p "$destino"
    # .gitkeep solo mientras la carpeta este vacia: git no versiona directorios vacios, y una
    # carpeta ya poblada por projection-implementer no lo necesita.
    if [ -z "$(ls -A "$destino")" ]; then
        touch "$destino/.gitkeep"
        echo "Carpeta creada para dominio detectado: $dominio"
    else
        echo "Carpeta ya poblada para dominio: $dominio (omitida)"
    fi
done
```

**Estructura por dominio en el worker (vacia) -- corre siempre.** Mismo criterio y misma lista de dominios detectados que el bloque anterior, pero espejando la carpeta en la **raiz del worker** (`src/<RootNamespace>.Projections/{Dominio}/`, MEF-ADR-0034 seccion 5) en vez de en `ReadModels`: ahi es donde `projection-implementer` (issue #365) escribira la clase de proyeccion companion (`{Concepto}Projection.cs`) de cada dominio. `mkdir -p` no pisa una carpeta ya poblada, asi que este bloque es seguro tambien cuando el worker ya existia:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
for seam in "$REPO_ROOT"/src/<RootNamespace>.Projections/Infraestructura/ConfiguracionMartenProjections*.cs; do
    [ -e "$seam" ] || continue
    nombre=$(basename "$seam" .cs)
    [ "$nombre" = "ConfiguracionMartenProjections" ] && continue   # el seam de nivel BC, no un dominio
    dominio="${nombre#ConfiguracionMartenProjections}"
    destino="$REPO_ROOT/src/<RootNamespace>.Projections/$dominio"
    mkdir -p "$destino"
    if [ -z "$(ls -A "$destino")" ]; then
        touch "$destino/.gitkeep"
        echo "Carpeta creada en el worker para dominio detectado: $dominio"
    else
        echo "Carpeta ya poblada en el worker para dominio: $dominio (omitida)"
    fi
done
```

**Referenciar `ReadModels` desde el worker -- corre siempre.** El worker referencia la biblioteca de read models (MEF-ADR-0034 seccion 5); wireala ahora para que ningun issue posterior tenga que tocar el `.csproj` del worker solo para agregar esta referencia:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
dotnet add "$REPO_ROOT/src/<RootNamespace>.Projections/<RootNamespace>.Projections.csproj" reference "$REPO_ROOT/src/<RootNamespace>.ReadModels/<RootNamespace>.ReadModels.csproj"
```

`dotnet add reference` es idempotente por si mismo -- si la referencia ya esta, no la duplica (CA-4): seguro invocarlo siempre, sin gate previo.

**Referenciar cada `{Dominio}.DomainEvents` desde el worker -- corre siempre (CA-3, issue #552).** MEF-ADR-0039 decision 2 fija que el worker referencia `{Dominio}.DomainEvents` de cada dominio que proyecta, nunca el `.csproj` de un Function App -- `domain-scaffolder` (issue #548) ya cablea esta referencia en su propio Paso 3b, pero solo cuando el worker **ya existe** en el momento en que ese agente corre; si el worker todavia no existia (un dominio se registro antes de que `/scaffold-projections` lo creara, o el dominio se registro con una version de `domain-scaffolder` anterior al issue #548), ese paso se omite por completo y la referencia queda pendiente para siempre a menos que algo la cierre despues. Este bucle cierra ese hueco -- misma familia que los dos bucles de carpetas de arriba, mismo criterio de deteccion (`ConfiguracionMartenProjections{Dominio}.cs`, excluyendo el seam de nivel BC) -- y corre siempre, no solo la primera vez que este agente crea el worker:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
for seam in "$REPO_ROOT"/src/<RootNamespace>.Projections/Infraestructura/ConfiguracionMartenProjections*.cs; do
    [ -e "$seam" ] || continue
    nombre=$(basename "$seam" .cs)
    [ "$nombre" = "ConfiguracionMartenProjections" ] && continue   # el seam de nivel BC, no un dominio
    dominio="${nombre#ConfiguracionMartenProjections}"
    domainEventsCsproj="$REPO_ROOT/src/<RootNamespace>.$dominio.DomainEvents/<RootNamespace>.$dominio.DomainEvents.csproj"
    if [ -f "$domainEventsCsproj" ]; then
        dotnet add "$REPO_ROOT/src/<RootNamespace>.Projections/<RootNamespace>.Projections.csproj" reference "$domainEventsCsproj"
        echo "ProjectReference verificada/agregada: $dominio.DomainEvents"
    else
        echo "Dominio detectado ($dominio) sin {Dominio}.DomainEvents todavia -- referencia pendiente, se cierra en la proxima corrida de este agente o de domain-scaffolder."
    fi
done
```

`dotnet add reference` es idempotente (mismo argumento que el bloque anterior); el `[ -f ... ]` previo evita invocarlo contra un `.csproj` que todavia no existe -- caso defensivo (crear ese proyecto es alcance de `domain-scaffolder`, no de este agente).

---

## Paso 1c - Crear el proyecto `<RootNamespace>.Projections.Tests` (CA-2, issue #375)

El config-test del worker (MEF-ADR-0034 seccion 6, hermano read-side de `ComposicionContenedorTests`/MEF-ADR-0029): construye el `IServiceCollection` invocando el seam de composicion con una cadena de conexion dummy, sin Postgres real (Marten 7+ no fuerza IO sincronico al bootstrapear el `IHost`, `config-test.md` del Skill `projections`).

**Probe de idempotencia (un gate por artefacto, CA-4):**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
BASE="$REPO_ROOT/tests/<RootNamespace>.Projections.Tests"
test -f "$BASE/<RootNamespace>.Projections.Tests.csproj"      && echo "csproj: EXISTE (omitir creacion y ajuste)"  || echo "csproj: FALTA"
test -f "$BASE/Infraestructura/AssertsProyecciones.cs"        && echo "helper: EXISTE (omitir)"                    || echo "helper: FALTA"
test -f "$BASE/ConfiguracionMartenProjectionsTests.cs"        && echo "config-test: EXISTE (omitir)"               || echo "config-test: FALTA"
```

Cada uno de los tres se evalua por separado, como fija el "Principio fundamental": el config-test base pudo crecer con guardas de dominio de `projection-test-writer` (issue #365) que **nunca** debes pisar, pero eso no debe impedir que crees el helper si falta (p. ej. un proyecto scaffoldeado con una version de este agente anterior a la fase 2). **Caveat**: si el `.csproj` ya existia y vas a escribir el helper, leelo primero y confirma que declare `AwesomeAssertions` y `Marten` -- si falta alguno, agregalo antes de escribir el archivo, o rompes un build que hasta ahora estaba verde.

Si el csproj falta, crealo:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
dotnet new xunit -n "<RootNamespace>.Projections.Tests" --framework net10.0 -o "tests/<RootNamespace>.Projections.Tests"
rm -f tests/<RootNamespace>.Projections.Tests/UnitTest1.cs
```

**Ajusta el `.csproj` generado** (mismo patron que el `SmokeTests` de `domain-scaffolder` -- **no** el patron ES de `Cosmos.EventSourcing.Testing.Utilities`: este proyecto no testea command handlers contra el event store, MEF-ADR-0002; testea configuracion Marten y, mas adelante, funciones puras evento -> vista, issue #365). Lee su contenido actual, elimina los paquetes que trae el template (`coverlet.collector`, `Microsoft.NET.Test.Sdk`, `xunit`, `xunit.runner.visualstudio`) y deja:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="AwesomeAssertions" Version="9.5.0" />
    <PackageReference Include="Marten" Version="9.23.0" />
    <PackageReference Include="xunit.v3.mtp-v2" Version="3.2.2" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\..\src\<RootNamespace>.Projections\<RootNamespace>.Projections.csproj" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

</Project>
```

`<OutputType>Exe</OutputType>` (xunit v3 con mtp-v2 lo exige) y el global `<Using Include="Xunit" />` son el mismo requisito que ya fija `domain-scaffolder` para sus proyectos de tests. La `PackageReference` a `Marten` es explicita (CA-2): a esta altura el `.csproj` del worker **todavia no tiene** el paquete `Marten` (lo agrega recien `domain-scaffolder`, Paso 3b, cuando el primer dominio registra su named store) -- el helper `AssertOpcionesDeEvento` del punto 1 (tipado sobre `IDocumentStore`) lo necesita ya. El `ProjectReference` al worker no lo usa todavia el config-test base (punto 2), pero es la misma razon del Paso 1b para el `ProjectReference` inverso: sin el, `projection-test-writer` (issue #365) tendria que editar este `.csproj` solo para invocar `ConfiguracionMartenProjections{Dominio}.Configurar{Dominio}` -- tipos que viven en `<RootNamespace>.Projections.Infraestructura` -- la primera vez que un dominio adopte proyecciones.

> **Pines exactos sin comodin, `AwesomeAssertions` y `xunit.v3.mtp-v2` (issue #605)**: mismo comodin problematico que fija `domain-scaffolder` en sus bloques de `Tests`/`SmokeTests` -- un comodin resuelve "la ultima version que matchea al momento del restore", asi que el resultado del build depende del dia y la hora, no del commit (incidente que lo evidencio: ola `10.0.11` de `Microsoft.Extensions.*` con un eslabon todavia no publicado, detalle en la nota del bloque de `SmokeTests` de `domain-scaffolder`). `AwesomeAssertions` queda en `9.5.0` y `xunit.v3.mtp-v2` en `3.2.2` -- las mismas versiones que fijan los bloques de `SmokeTests` y `Tests` de `domain-scaffolder` (CA-3: ningun `.csproj` del repo consumidor **declara** dos versiones distintas del mismo paquete de test). El alcance de esa consistencia son las referencias declaradas: en `{Dominio}.Tests`/`PublicEvents.Tests`/`PrivateEvents.Tests`, `AwesomeAssertions` no se declara -- llega transitiva via `Cosmos.EventSourcing.Testing.Utilities` 3.1.0, que hoy la trae en `9.5.0` (nuspec del paquete, api.nuget.org, reverificado en #2394); no "alinees" ese proyecto agregandole una referencia directa: aunque hoy coinciden, son grafos de proyectos distintos y NuGet los resuelve por separado, asi que un bump futuro de cualquiera de los dos no arrastra al otro. Ambas versiones verificadas contra `api.nuget.org/v3-flatcontainer/<paquete>/index.json` al momento de este cambio (hoy son ademas las ultimas estables absolutas de cada paquete); revalidalas contra la fuente, subiendo dentro de la misma linea mayor -- cruzar un major se decide en su propio issue. **Repos ya scaffoldeados con el comodin**: la idempotencia de este agente no reescribe un `Projections.Tests.csproj` existente -- edita a mano estas dos lineas.

**1. Crear el helper reutilizable `AssertOpcionesDeEvento`** (CA-2) -- extension method sobre `IDocumentStore` que encapsula la guarda 3 de `config-test.md` (replica exacta de `Events.MetadataConfig` contra el write-side): cada dominio que `projection-test-writer` (issue #365) cubra invoca este helper sobre su propio named store resuelto, en vez de repetir las tres aserciones en cada test.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$REPO_ROOT/tests/<RootNamespace>.Projections.Tests/Infraestructura"
```

```csharp
using AwesomeAssertions;
using Marten;

namespace <RootNamespace>.Projections.Tests.Infraestructura;

/// <summary>
/// Helper reutilizable del config-test del worker (MEF-ADR-0034 seccion 6, guarda 3): verifica que
/// el named store resuelto replique exactamente la configuracion de metadata de evento que exige el
/// write-side de ese mismo dominio (MEF-ADR-0034 seccion 7). Invocar sobre cada named store que
/// projection-test-writer (issue #365) resuelva del contenedor: store.AssertOpcionesDeEvento().
/// </summary>
public static class AssertsProyecciones
{
    public static void AssertOpcionesDeEvento(this IDocumentStore store)
    {
        var metadata = store.Options.Events.MetadataConfig;

        metadata.CorrelationIdEnabled.Should().BeTrue();
        metadata.CausationIdEnabled.Should().BeTrue();
        metadata.HeadersEnabled.Should().BeTrue();
    }
}
```

**Verificado por lectura del codigo fuente de `JasperFx/marten`** (`src/Marten/DocumentStore.cs`, `src/Marten/IReadOnlyStoreOptions.cs`, `src/Marten/Events/EventGraph.cs`): `IDocumentStore.Options` retorna `IReadOnlyStoreOptions`; `IReadOnlyStoreOptions.Events` retorna `IReadOnlyEventStoreOptions`; `IReadOnlyEventStoreOptions.MetadataConfig` retorna `IReadonlyMetadataConfig` -- la cadena completa `store.Options.Events.MetadataConfig` es de solo lectura y alcanzable sin downcast, incluso resolviendo el marker `I{Dominio}ProjectionStore : IDocumentStore` desde DI. **No verificado**: que `IReadonlyMetadataConfig` exponga exactamente `CorrelationIdEnabled`/`CausationIdEnabled`/`HeadersEnabled` como propiedades booleanas de lectura (simetria esperada con la clase mutable `MetadataConfig` que ya usa `domain-scaffolder`, pero no confirmado leyendo esa interfaz puntual) -- `projection-test-writer` (issue #365) debe reverificarlo con un build real la primera vez que invoque este helper contra un named store concreto, mismo principio de verificacion graduada que este agente aplica al resto de la superficie de Marten. **La guarda 2 (ciclo de vida `Async`) ya no exige esa reverificacion**: MEF-ADR-0034 seccion 6 cerro su superficie por ejecucion propia (issue #496) -- `store.Options.Events.Projections()` devuelve los elementos registrados, con `.Name` y `.Lifecycle`, y `.Name` es el nombre del **read model**, no el de la clase de proyeccion.

**2. Crear el config-test base** (CA-2, CA-5). **Importante**: este test **nunca** invoca el seam de nivel BC (`ConfigurarEventos`) -- `config-test.md` fija que el config-test invoca **directamente** el `Configurar{Dominio}` de cada dominio (`ConfiguracionMartenProjectionsVentas.ConfigurarVentas(services, ...)` en su ejemplo), nunca el agregador; `ConfigurarEventos`/`Program.cs` son wiring puro para el host, excluidos de medicion (MEF-ADR-0014, MEF-ADR-0034 seccion 9) y no la superficie que este test ejercita. Sin ningun dominio registrado todavia (este agente no crea ninguno), no hay ningun `Configurar{Dominio}` que invocar: el config-test base se limita a construir un `IServiceCollection` vacio y probar que el `ServiceProvider` se construye -- la semilla sobre la que `projection-test-writer` (issue #365) agrega, **dentro de este mismo metodo o en uno hermano**, una llamada directa `ConfiguracionMartenProjections{Dominio}.Configurar{Dominio}(services, ConnectionStringDummy);` por cada dominio que adopte proyecciones, antes de construir el provider, seguida de la resolucion y aserciones de guarda 1/2 sobre ese named store.

```csharp
using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;

namespace <RootNamespace>.Projections.Tests;

public class ConfiguracionMartenProjectionsTests
{
    private const string ConnectionStringDummy = "Host=localhost;Database=dummy";

    // Cada dominio que projection-test-writer (issue #365) cubra agrega aqui su propia llamada
    // directa -- ConfiguracionMartenProjections{Dominio}.Configurar{Dominio}(services,
    // ConnectionStringDummy) -- antes de construir el provider (ver config-test.md). Nunca a
    // traves de ConfigurarEventos: ese seam es wiring puro para Program.cs, no la superficie que
    // este test ejercita.
    [Fact]
    public void ServiceCollection_DebeConstruirElServiceProvider_SinNingunDominioRegistradoTodavia()
    {
        var services = new ServiceCollection();
        services.AddLogging();

        using var provider = services.BuildServiceProvider();

        provider.Should().NotBeNull();
    }
}
```

No abre ninguna conexion real: Marten 7+ no inicializa el `DocumentStore` durante el bootstrapping del `IHost` (MEF-ADR-0034 seccion 6, referencia [4]). Es deliberadamente trivial mientras no exista ningun dominio: prueba que el proyecto de tests compila, resuelve `Marten`/`AwesomeAssertions`/`xunit.v3.mtp-v2` y construye un `ServiceProvider` sin Postgres real -- la plomeria que `projection-test-writer` (issue #365) reutiliza en cuanto el primer dominio registre su named store.

---

## Paso 1d - Crear el seam de observabilidad (CA-1..CA-5, issue #457; extendido por issue #778, metricas MEF-ADR-0038 seccion 10)

Seam hermano directo de `ConfiguracionMartenProjections` (Paso 1, MEF-ADR-0029): `Program.cs` invoca ambos, nunca wirea OpenTelemetry inline. Ver la doctrina completa en **MEF-ADR-0034 seccion 10** -- el worker no tiene `UseFunctionsWorkerDefaults()` (no es una Function App), asi que nada fija su `service.name` por convencion; sin este seam, OpenTelemetry cae al default `unknown_service:dotnet` (el `ENTRYPOINT` del Dockerfile es `dotnet <RootNamespace>.Projections.dll`) -- defecto ya medido en produccion por el consumidor Bitakora.ControlAsistencia (issues #250/#263) al copiar el seam del write-side tal cual. Y el worker corre **sin ingress** (Paso 2): las trazas que este seam exporta son la **unica** observabilidad posible.

**Probe de idempotencia (CA-4) -- un gate por artefacto, como en los Pasos 1b/1c; corre siempre, aunque el Paso 0 haya determinado que el worker ya existia:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
PROJ="$REPO_ROOT/src/<RootNamespace>.Projections"
test -f "$PROJ/Infraestructura/ConfiguracionObservabilidadProjections.cs" && echo "seam: EXISTE (omitir, NO sobrescribir)"      || echo "seam: FALTA (crear)"
grep -q 'Include="OpenTelemetry.Extensions.Hosting"' "$PROJ/<RootNamespace>.Projections.csproj" 2>/dev/null     && echo "paquete hosting: EXISTE (omitir)"   || echo "paquete hosting: FALTA (agregar)"
grep -q 'Include="Azure.Monitor.OpenTelemetry.Exporter"' "$PROJ/<RootNamespace>.Projections.csproj" 2>/dev/null && echo "paquete exporter: EXISTE (omitir)"  || echo "paquete exporter: FALTA (agregar)"
grep -q 'ConfigurarObservabilidad' "$PROJ/Program.cs" 2>/dev/null                                              && echo "wiring Program.cs: EXISTE (omitir)" || echo "wiring Program.cs: FALTA (agregar)"
test -f "$PROJ/Infraestructura/SamplerQueDescartaPollingDelDaemon.cs" && echo "sampler wrapper: EXISTE (omitir, NO sobrescribir)" || echo "sampler wrapper: FALTA (crear)"
test -f "$REPO_ROOT/tests/<RootNamespace>.Projections.Tests/ConfiguracionObservabilidadProjectionsTests.cs" && echo "config-test observabilidad: EXISTE (omitir, NO sobrescribir)" || echo "config-test observabilidad: FALTA (crear)"
grep -q 'Include="OpenTelemetry.Exporter.InMemory"' "$REPO_ROOT/tests/<RootNamespace>.Projections.Tests/<RootNamespace>.Projections.Tests.csproj" 2>/dev/null && echo "paquete InMemory (tests): EXISTE (omitir)" || echo "paquete InMemory (tests): FALTA (agregar)"
```

Los siete se evaluan **por separado**, mismo criterio que el "Principio fundamental" y los Pasos 1b/1c: el seam y el sampler wrapper son los dos artefactos que **nunca** se sobrescriben (pueden llevar ajustes agregados despues -- p. ej. un consumidor que extienda el wrapper con un segundo span a descartar), pero eso no debe impedir que cierres los demas si faltan. El caso no es hipotetico: un consumidor que escribio el seam **a mano** (Bitakora.ControlAsistencia, issues #250/#263) lo tiene presente con sus paquetes ya puestos -- omitir todo ahi es correcto --, mientras que una corrida anterior interrumpida a mitad de este paso puede dejar el seam escrito y el `.csproj` sin los paquetes, o el seam y el wrapper escritos sin su config-test: gatear los siete sobre la existencia del seam dejaria esos huecos sin forma de repararse volviendo a correr el agente. Los puntos 1, 1b y 3 son aditivos por construccion (solo agregan lo que falta, nunca reescriben), igual que el `dotnet add reference`/`mkdir -p` que el Paso 1b invoca sin gate previo.

**Hueco conocido: seam preexistente sin la supresion selectiva de metricas (issue #778).** Un consumidor cuyo seam se escribio antes de este cambio (a mano, o por una version anterior de este agente) reporta `seam: EXISTE` y por lo tanto **no** recibe el `.WithMetrics(...)` ni el `PostConfigure<AzureMonitorExporterOptions>` del punto 2 -- pero si recibe el config-test del punto 4 si ese archivo falta, y entonces los guardrails (e)/(f) nacen en **rojo** contra un seam que no tiene lo que verifican. No es un falso positivo del test: es exactamente la regresion que el guardrail existe para detectar. Detectalo con este probe adicional y reportalo:

```bash
SEAM="$PROJ/Infraestructura/ConfiguracionObservabilidadProjections.cs"
test -f "$SEAM" && { grep -q 'WithMetrics' "$SEAM" && grep -q 'PostConfigure<AzureMonitorExporterOptions>' "$SEAM" \
  && echo "metricas en el seam: PRESENTES" || echo "metricas en el seam: AUSENTES (seam preexistente -- reponer aditivamente)"; }
```

Si sale **AUSENTES**, repon los dos bloques del punto 2 (la vista func-based con su `EsMetricaDeGC` y el `PostConfigure`) **de forma aditiva** sobre el seam existente, y solo esos dos: insertar bloques que faltan no es "sobrescribir el seam" (regla absoluta 1) -- lo prohibido es reescribir el archivo o tocar lo que el consumidor ya ajusto ahi (su `AddSource`, su ratio, su wrapper de sampler). Reportalo explicitamente en el resumen del Paso 5 como reposicion sobre un seam preexistente, no como creacion.

**1. Sumar los dos paquetes al `.csproj` del worker (CA-2)** -- solo los que el probe reporto como **FALTA**. Lee `src/<RootNamespace>.Projections/<RootNamespace>.Projections.csproj` antes de editarlo -- si el worker ya existia de una corrida anterior a este issue, este `.csproj` no los tiene todavia; si el worker se acaba de crear en el Paso 1, tampoco (ese paso no los agrega). En ambos casos, agrega estas dos lineas nuevas al `<ItemGroup>` de `PackageReference` **sin duplicar ninguna referencia existente** (un `PackageReference` duplicado resuelve a la version mas baja, mismo detalle que documenta el Paso 1 punto 2):

```xml
    <!-- Observabilidad read-side (issue #457): SOLO estos dos paquetes; se descartan
         Microsoft.Azure.Functions.Worker.OpenTelemetry (el worker no es Functions,
         UseFunctionsWorkerDefaults() no aplica) y Azure.Monitor.OpenTelemetry.AspNetCore
         (el worker no es ASP.NET Core y no recibe requests). -->
    <PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.17.0" />
    <PackageReference Include="Azure.Monitor.OpenTelemetry.Exporter" Version="1.8.3" />
```

Versiones verificadas contra NuGet.org al momento de escribir este agente (`api.nuget.org/v3-flatcontainer/opentelemetry.extensions.hosting/index.json` y `.../azure.monitor.opentelemetry.exporter/index.json`: `1.17.0` y `1.8.3` son las ultimas estables de cada paquete, sin ningun `-rc`/`-beta` posterior) -- **no** son las mismas que fija el write-side en MEF-ADR-0003 (`1.15.3`/`1.8.2`: el primer valor satisface el minimo que exige el segundo y evita la linea vulnerable de `OpenTelemetry.Api`; `Microsoft.Azure.Functions.Worker.OpenTelemetry` por si solo permitiria 1.13.1): este pin es independiente porque el worker no usa el paquete de Functions. **Reverifica contra NuGet.org** si ha pasado tiempo desde entonces.

**1b. Sumar `OpenTelemetry.Exporter.InMemory` al `.csproj` de `Projections.Tests` (MEF-ADR-0038 seccion 10, issue #778)** -- solo si el probe lo reporto como **FALTA**. Lee `tests/<RootNamespace>.Projections.Tests/<RootNamespace>.Projections.Tests.csproj` antes de editarlo y agrega esta linea al `<ItemGroup>` de `PackageReference` (Paso 1c) sin duplicar ninguna referencia existente:

```xml
<PackageReference Include="OpenTelemetry.Exporter.InMemory" Version="1.17.0" />
```

**Criterio de version: alinear con el core que ya resuelve esta receta, no la ultima absoluta del paquete** -- mismo criterio que ancla el exporter de test del write-side a su propio core (`domain-scaffolder`, Paso 2 nota de lockstep): `OpenTelemetry.Extensions.Hosting` queda pinneado en `1.17.0` (punto 1 de arriba), y `1.17.0` es tambien una version publicada de `OpenTelemetry.Exporter.InMemory` (verifica contra `api.nuget.org/v3-flatcontainer/opentelemetry.exporter.inmemory/index.json` antes de usar este pin si ha pasado tiempo desde este cambio). Habilita `AddInMemoryExporter`/`ConfigureOpenTelemetryMeterProvider`/`MeterProvider`/`Metric` (namespace `OpenTelemetry.Metrics`), que usan los guardrails de la supresion selectiva de metricas del punto 4 mas abajo. Un mismatch de linea entre este exporter de test y el core de produccion es la misma familia de riesgo que ya documenta la nota de lockstep del write-side.

**2. Crear `Infraestructura/ConfiguracionObservabilidadProjections.cs` (CA-1, CA-5)** -- solo si el probe lo reporto como **FALTA**; si EXISTE, no lo toques (regla absoluta 1) y salta al punto 3:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$REPO_ROOT/src/<RootNamespace>.Projections/Infraestructura"
```

```csharp
using System.Globalization;
using System.Reflection;
using Azure.Monitor.OpenTelemetry.Exporter;
using Microsoft.Extensions.DependencyInjection;
// 'using OpenTelemetry;' NO es opcional ni redundante con los dos de abajo: ConfigureResource y
// WithTracing son extension methods de OpenTelemetryBuilderSdkExtensions, que vive en el namespace
// raiz OpenTelemetry (no en OpenTelemetry.Trace). Sin esta linea, ambas llamadas fallan con CS1061.
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace <RootNamespace>.Projections.Infraestructura;

/// <summary>
/// Seam de observabilidad del worker (MEF-ADR-0034 seccion 10): las trazas exportadas son la
/// unica observabilidad posible (el worker corre sin ingress). Program.cs solo invoca este
/// metodo -- no wirea OpenTelemetry inline (MEF-ADR-0029).
/// </summary>
public static class ConfiguracionObservabilidadProjections
{
    // Contrato literal de MEF-ADR-0038 seccion 10: la UNICA familia de metricas que este worker
    // conserva -- lista cerrada, no un wildcard, porque a diferencia del write-side (que descarta
    // TODO por "*", domain-scaffolder) este proceso 24/7 sin ingress necesita el proxy de memory
    // leak que solo esa familia provee. Revalidar estos 3 nombres si sube
    // la version pinneada de OpenTelemetry.Extensions.Hosting (punto 1 de este paso): un rename del
    // runtime no se cuela en silencio porque el guardrail de composicion (punto 4) ancla los mismos
    // 3 literales por [Theory].
    private static bool EsMetricaDeGC(string nombreInstrumento) =>
        nombreInstrumento is "dotnet.gc.collections"
            or "dotnet.gc.last_collection.heap.size"
            or "dotnet.gc.last_collection.heap.fragmentation.size";

    public static IServiceCollection ConfigurarObservabilidad(this IServiceCollection services)
    {
        var ensamblado = Assembly.GetExecutingAssembly();

        // El SHA horneado en el Dockerfile (ARG SOURCE_REVISION_ID -> -p:SourceRevisionId= del
        // 'dotnet publish', issue #462, MEF-ADR-0031 seccion 5) llega aqui via
        // AssemblyInformationalVersionAttribute como "{Version}+{SourceRevisionId}" -- mismo
        // mecanismo de horneado que el write-side y mismo patron de extraccion que ya usa
        // '/api/version' (VersionCheck.cs, domain-scaffolder). Se extrae la subcadena posterior
        // al '+', NO el valor completo: asi 'service.version' queda byte a byte igual al tag con
        // el que deploy-projections.yml publica la imagen en el ACR (projections:{github.sha},
        // Paso 2b) y una traza se correlaciona con la imagen desplegada sin traducir nada.
        var informationalVersion = ensamblado
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;

        // Sin el separador '+' no hay SHA que extraer: es el build local sin '--build-arg' (el
        // target de MSBuild que concatena el sufijo se salta por completo cuando SourceRevisionId
        // esta vacio, sin dejar un '+' colgante). Unica diferencia deliberada frente a
        // '/api/version', que en ese caso devuelve 'sha: null': aqui se degrada a la version
        // desnuda ("1.0.0") y no a null, porque un serviceVersion null OMITE el atributo del
        // recurso y la telemetria no distinguiria "el seam no corrio" de "el SHA no se horneo".
        // Ese valor desnudo es el modo de falla a vigilar (verificacion del Paso 2b).
        var indiceSeparador = informationalVersion?.IndexOf('+') ?? -1;
        var serviceVersion = indiceSeparador >= 0
            ? informationalVersion![(indiceSeparador + 1)..]
            : informationalVersion;

        // Ratio de sampling (MEF-ADR-0038 seccion 1): politica de costos del CONSUMIDOR, nunca del
        // marco -- el marco solo garantiza el wiring de abajo (orden frente al exporter, seccion 3)
        // y el filtro estructural del polling del daemon (seccion 5), que corren aparte del ratio.
        // Default 1.0 (sin descarte por ratio; el filtro de la seccion 5 sigue activo igual) cuando
        // TELEMETRY_SAMPLING_RATIO no esta declarada: un default fraccionario fue deliberadamente
        // descartado para greenfield porque vuelve ambiguo "el wiring esta roto" frente a "mala
        // suerte de muestreo" justo en la primera integracion, el momento en que mas se necesita
        // diagnosticar.
        var samplingRatio = double.TryParse(
            Environment.GetEnvironmentVariable("TELEMETRY_SAMPLING_RATIO"),
            NumberStyles.Float,
            CultureInfo.InvariantCulture,
            out var ratioConfigurado)
            ? ratioConfigurado
            : 1.0;

        services.AddOpenTelemetry()
            // Assembly.GetExecutingAssembly() es correcto AQUI porque este seam vive en el
            // ensamblado del propio worker (<RootNamespace>.Projections) -- resuelve el
            // service.name a ese mismo nombre. Moverlo a una biblioteca compartida cambiaria el
            // valor en silencio (issue #457).
            .ConfigureResource(r => r.AddService(ensamblado.GetName().Name!, serviceVersion: serviceVersion))
            // Supresion selectiva de metricas (MEF-ADR-0038 seccion 10, issue #778): UNA unica
            // vista func-based, nunca un par de dos AddView por patron -- las vistas de
            // MeterProviderBuilder hacen fan-out, no first-match-wins (doc oficial de
            // customizacion del SDK de OpenTelemetry .NET), asi que un AddView("*", Drop) mas un
            // AddView("dotnet.gc.*", null) produciria dos metric streams para el mismo
            // instrumento GC en vez de conservarlo. null conserva el instrumento con su
            // configuracion por defecto; MetricStreamConfiguration.Drop lo descarta. Va ANTES del
            // primer .WithTracing(...) -- a diferencia del SetSampler de mas abajo, AddView
            // ACUMULA sobre el MeterProviderBuilder, asi que su posicion frente al MetricReader
            // que UseAzureMonitorExporter() agrega despues no es un invariante funcional; lo que
            // si hay que respetar es no insertarlo entre UseAzureMonitorExporter(...) y el
            // segundo .WithTracing(...) de abajo (parte visualmente el par exporter -> sampler que
            // hace legible ese orden critico).
            .WithMetrics(metrics => metrics
                .AddView(instrument => EsMetricaDeGC(instrument.Name)
                    ? null
                    : MetricStreamConfiguration.Drop))
            .WithTracing(tracing => tracing
                .AddSource("Marten")
                // A diferencia del write-side (domain-scaffolder), este worker SI registra
                // Npgsql: el daemon de proyecciones poolea Postgres de forma sostenida, y esas
                // dependencias son la senal principal de su salud. No es una inconsistencia por
                // corregir (issue #457).
                .AddSource("Npgsql")
                // El "*" va SIN punto delante (issue #460, mismo patron que domain-scaffolder):
                // "X.*" ancla como ^X\..*$ y excluye una ActivitySource nombrada exactamente "X"
                // -- justo el nombre idiomatico (Assembly.GetName().Name); "X*" ancla como ^X.*$
                // y captura tanto "X" como "X.Hija".
                .AddSource("<RootNamespace>.Projections*"))
            // MEF-ADR-0038 seccion 9 (issue #680): default true del exporter instala
            // LogFilteringProcessor, que descarta todo LogRecord salvo que SpanId == default ||
            // TraceFlags == Recorded -- el HighWaterAgent emite sus LogError DENTRO del span de
            // polling que el sampler de abajo ya descarta, asi que esos logs de error nunca
            // llegaban a exceptions (medido: 35/35 perdidos, Bitakora.ControlAsistencia). Mecanismo
            // del marco, no opt-in (regla absoluta 10) -- NUNCA quites este flip.
            .UseAzureMonitorExporter(o => o.EnableTraceBasedLogsSampler = false)
            // MEF-ADR-0038 seccion 3/5 -- SEGUNDO .WithTracing(...), SIEMPRE despues de
            // UseAzureMonitorExporter(): ese exporter (Azure.Monitor.OpenTelemetry.Exporter 1.8.x)
            // llama internamente SetSampler(new RateLimitedSampler(5.0)) sobre el mismo builder, y
            // SetSampler no acumula -- la ultima llamada gana. Un SetSampler encadenado ANTES del
            // exporter (el orden que parece natural leyendo de arriba a abajo) queda pisado sin
            // ningun aviso: ni en build, ni en tests, ni en logs de arranque (mismo defecto medido
            // en el write-side, issue #308 del consumidor Bitakora.ControlAsistencia). NO fusiones
            // este bloque con el .WithTracing(...) de arriba: "limpiar" juntando ambos en una sola
            // llamada reintroduce el defecto sin ningun error de compilacion. Este orden NO es
            // contrato publico del paquete exporter -- es un detalle de implementacion no
            // documentado, observado por decompilacion en la version pinneada (1.8.x). La garantia
            // de que sigue vigente en cada build NO es este comentario -- es el guardrail de
            // composicion (ConfiguracionObservabilidadProjectionsTests, Paso 1d punto 4,
            // MEF-ADR-0038 seccion 4).
            //
            // SamplerQueDescartaPollingDelDaemon (Paso 1d punto 2b) es el sampler MAS EXTERNO, y
            // envuelve ParentBasedSampler(TraceIdRatioBasedSampler(ratio)) como su interno
            // (MEF-ADR-0034 seccion 10 punto 4 / MEF-ADR-0038 seccion 5): el filtro por nombre se
            // evalua para CADA span (root e hijos, es el unico Sampler que TracerProviderSdk
            // invoca); cuando el nombre no coincide con el span del daemon, delega al
            // ParentBasedSampler interno, que es quien hace que el Drop del span raiz del daemon se
            // propague al hijo Npgsql sin que este se instancie. NO inviertas el anidamiento
            // (ParentBasedSampler afuera, el filtro adentro): con el filtro como rootSampler solo
            // se lo consulta para spans sin padre, asi que dejaria pasar cualquier polling del
            // daemon que alguna version futura de Marten emita colgado de otro span (ver el
            // comentario del wrapper mismo).
            .WithTracing(tracing => tracing
                .SetSampler(new SamplerQueDescartaPollingDelDaemon(
                    new ParentBasedSampler(new TraceIdRatioBasedSampler(samplingRatio)))));

        // Fallback de connection string del exporter de metricas (MEF-ADR-0038 seccion 10, issue
        // #778): a diferencia del pipeline de trazas/logs (seccion 9, resuelto lazily via
        // IConfiguration cuando el TracerProvider/LoggerProvider se usan), el metric reader de
        // Azure.Monitor.OpenTelemetry.Exporter construye su exporter de forma SINCRONICA al
        // resolver el MeterProvider -- y lanza si no hay connection string disponible en ese
        // momento, incluso con TODO el trafico de metricas en Drop (la vista de arriba filtra que
        // se exporta, no si el exporter se construye; asimetria trace/metric verificada por
        // decompilacion, evidencia (d) de #764). PostConfigure corre despues de cualquier
        // Configure/binding real -- incluida la resolucion via IConfiguration que el
        // Host.CreateApplicationBuilder del Paso 1a puebla desde las variables de entorno (mismo
        // overload con callback de UseAzureMonitorExporter de arriba, que NO registra
        // DefaultAzureMonitorExporterOptions) -- asi que nunca pisa una connection string real ya
        // resuelta: solo cubre el hueco cuando esa resolucion todavia no ocurrio (greenfield sin
        // App Insights desplegado todavia, o arranque en frio con la referencia de Key Vault sin
        // resolver) o dentro del guardrail de composicion de ConfiguracionObservabilidadProjectionsTests
        // (Paso 1d punto 4), que construye el contenedor sin un host real detras.
        services.PostConfigure<AzureMonitorExporterOptions>(opciones =>
        {
            if (string.IsNullOrEmpty(opciones.ConnectionString))
                opciones.ConnectionString = "InstrumentationKey=00000000-0000-0000-0000-000000000000";
        });

        // El exporter resuelve APPLICATIONINSIGHTS_CONNECTION_STRING sin que este seam la lea ni
        // la reciba como parametro (MEF-ADR-0025). Bajo el overload de opciones de arriba llega por
        // IConfiguration -- que Host.CreateApplicationBuilder (Paso 1a) puebla desde las variables
        // de entorno --, y ese es el UNICO camino: un host sin ese proveedor apaga la exportacion
        // entera en silencio (MEF-ADR-0038 seccion 9).

        // Frontera mecanismo/valor de MEF-ADR-0038 seccion 1: el marco ya garantiza arriba el
        // MECANISMO completo (orden frente al exporter + filtro del polling del daemon + flip del
        // sampler de logs + supresion selectiva de metricas que conserva solo la familia GC, sin
        // que ningun consumidor tenga que pedirlo). Lo que queda como VALOR
        // del consumidor son dos ejes ya independientes entre si: el ratio de trazas
        // (TELEMETRY_SAMPLING_RATIO) y el nivel de ILogger, unico control de volumen de logs desde
        // que ese flip los desacoplo del muestreo (seccion 9). Este worker corre 24/7 (min_replicas >= 1, MEF-ADR-0034
        // seccion 8) a diferencia de las Function Apps del write-side, que escalan a demanda --
        // mayor volumen sostenido de telemetria, de ahi que el filtro estructural de arriba no sea
        // opcional aqui.

        return services;
    }
}
```

Los ocho `using` del bloque anterior son los que este seam necesita, y ninguno esta ahi por accidente -- resueltos por lectura de fuente contra el tag `core-1.17.0` de `open-telemetry/opentelemetry-dotnet`, la version del core que arrastra `OpenTelemetry.Extensions.Hosting` 1.17.0 (MEF-ADR-0034 referencia [18]): `System.Globalization` es de `NumberStyles`/`CultureInfo` (**no** lo cubre `ImplicitUsings`; issue #513, lectura de `TELEMETRY_SAMPLING_RATIO`, mismo `using` que ya agrega `domain-scaffolder` para el mismo parseo en el write-side), `Assembly` es de `System.Reflection` (tampoco cubierto), `AddOpenTelemetry()` es de `Microsoft.Extensions.DependencyInjection` (`OpenTelemetryServicesExtensions`), **`ConfigureResource`/`WithTracing` son de `OpenTelemetry`** (`OpenTelemetryBuilderSdkExtensions.cs`, `namespace OpenTelemetry;`), `AddService` es de `OpenTelemetry.Resources` (`ResourceBuilderExtensions`), `AddSource` es metodo de instancia de `TracerProviderBuilder` (`OpenTelemetry.Trace`), `UseAzureMonitorExporter()` es de `Azure.Monitor.OpenTelemetry.Exporter` y **`AddView`/`MetricStreamConfiguration` son de `OpenTelemetry.Metrics`** (issue #778, MEF-ADR-0038 seccion 10: `MeterProviderBuilderExtensions.AddView(Func<Instrument, MetricStreamConfiguration?>)` vive en ese namespace, hermano de `TracerProviderBuilder` en `OpenTelemetry.Trace`). **`WithMetrics` NO es de `OpenTelemetry.Metrics`**: vive en el mismo `OpenTelemetry` (`OpenTelemetryBuilderSdkExtensions.cs`) que `ConfigureResource`/`WithTracing` -- de ahi el modo de falla asimetrico si alguien "limpia" el `using OpenTelemetry.Metrics;` nuevo por parecer implicito en `.WithMetrics(...)`: la llamada externa sigue compilando y solo revientan `AddView`/`MetricStreamConfiguration` dentro del callback (CS1061/CS0246). El `Instrument` del lambda de `AddView` tampoco pide un `using` noveno (`System.Diagnostics.Metrics`): el parametro va implicitamente tipado, y un parametro de lambda inferido no exige que su tipo este en scope -- **no** agregues ese `using` "por completitud" al seam (si lo haces, queda sin usar; el que si lo necesita es el config-test del punto 4, que instancia un `Meter` explicito). `OpenTelemetry.Trace` se conserva -- igual que en el `ComposicionServicios{PascalCase}` del write-side -- porque es el namespace de `SetSampler`/`ParentBasedSampler`/`TraceIdRatioBasedSampler`, el sampler que este seam instala de verdad ahora (MEF-ADR-0038 seccion 5) y ya no solo un punto de extension documentado en un comentario. **No "limpies" `using OpenTelemetry;` por parecer redundante con los dos hijos**: sin el, `ConfigureResource` y `WithTracing` fallan con CS1061 y el seam no compila. `AssemblyInformationalVersionAttribute` (issue #462, lectura del `serviceVersion`) no agrega un `using` noveno: vive en el mismo `System.Reflection` que `Assembly`, igual que en `VersionCheck.cs` del write-side (`domain-scaffolder.md`). `SamplerQueDescartaPollingDelDaemon` (Paso 1d punto 2b) tampoco agrega ningun `using` nuevo: vive en el mismo namespace `<RootNamespace>.Projections.Infraestructura` que este seam. `AzureMonitorExporterOptions` (el fallback de connection string de arriba) no agrega un `using` mas alla: vive en el mismo `Azure.Monitor.OpenTelemetry.Exporter` que `UseAzureMonitorExporter()`.

**El overload con callback de `UseAzureMonitorExporter` no es intercambiable con el sin argumentos** (MEF-ADR-0038 seccion 9, verificado por lectura de fuente y ejecucion propia contra la version pinneada 1.8.3): el overload **sin** argumentos registra por dentro `DefaultAzureMonitorExporterOptions`; el overload con callback -- el que este seam usa para el flip -- **no**. Dos consecuencias que hay que respetar al tocar este seam o el `Program.cs` del Paso 1a: (1) bajo este overload la connection string llega unicamente por `IConfiguration[APPLICATIONINSIGHTS_CONNECTION_STRING]` (el exporter conserva `AddOptions<AzureMonitorExporterOptions>().Configure<IConfiguration>(...)`), y el `Program.cs` del Paso 1a la provee porque arma el host con `Host.CreateApplicationBuilder(args)`, que incluye el proveedor de variables de entorno -- **NUNCA** cambies ese host por uno que no lo incluya, ni "arregles" la telemetria pasandole la connection string al seam (MEF-ADR-0025, regla absoluta 10); (2) la seccion `AzureMonitorExporter` de `appsettings.json` deja de bindearse, lo que ademas impide que un consumidor re-habilite el flip por configuracion -- efecto deseado aqui, no defecto (el flip es mecanismo del marco).

**Metricas del read-side (MEF-ADR-0038 seccion 10, issue #764/#778):** la vista func-based unica de arriba es el mecanismo que fija la seccion 10 para **este** proceso, y su asimetria frente al write-side es deliberada, no una inconsistencia por alinear: `domain-scaffolder` descarta TODO por `AddView(instrumentName: "*", MetricStreamConfiguration.Drop)` porque ninguna metrica de capacidad de una Function App aporta una senal que `requests`/`dependencies` no cubran ya; aqui el ADR **si** fija una lista cerrada de 3 nombres, porque el worker corre sin ingress -- nunca emite `requests`, y un memory leak no tiene ninguna otra senal del marco que lo revele. Esa lista cerrada es la unica excepcion del marco a la regla de "no decidir que metrica sirve por catalogo mantenido a mano" (seccion 1), y esta acotada por el ADR, no por este agente: **nunca** la amplies con otra familia (`kestrel.*`, `*.cpu.time`, `http.*`) ni la conviertas en configurable por el consumidor. Tampoco reemplaces la vista unica por un par `AddView("*", Drop)` + `AddView("dotnet.gc.*", null)`: la documentacion oficial de OpenTelemetry .NET es explicita en que las vistas hacen fan-out, no *first-match-wins* -- un instrumento GC que matchee ambas produciria dos metric streams (uno dropeado, otro conservado), que es justo la fuga que la seccion 10 proscribe. La supervivencia de esta vista frente a `UseAzureMonitorExporter()` (que cablea su propio `MetricReader` sobre el mismo `MeterProviderBuilder`) NO es contrato del paquete exporter -- la sostienen los guardrails (e)/(f) del config-test (punto 4), no la sola lectura del codigo.

**Lo que no debes afirmar del resultado (gate abierto del ADR):** ni en el codigo generado ni en el reporte al usuario digas que con esta vista "solo salen las 3 metricas GC" o que "nada mas se exporta". La vista gobierna los instrumentos que pasan por el `MeterProviderBuilder`, no necesariamente el latido que el propio exporter emite sobre si mismo (`_APPRESOURCEPREVIEW_`), que MEF-ADR-0038 seccion 10 deja explicitamente como **gate abierto de medicion** -- cerrarlo exige telemetria real post-deploy (KQL contra Application Insights), no lectura de codigo ni un test contra un `ServiceProvider` en memoria. Formula el resultado como lo que el guardrail verifica de verdad: la vista conserva la familia GC y descarta cualquier otro instrumento que pase por ella.

**2b. Crear `Infraestructura/SamplerQueDescartaPollingDelDaemon.cs` (issue #513, MEF-ADR-0038 seccion 5)** -- solo si el probe lo reporto como **FALTA**; si EXISTE, no lo toques (regla absoluta 1, mismo trato que el seam) y salta al punto 3:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$REPO_ROOT/src/<RootNamespace>.Projections/Infraestructura"
```

```csharp
using OpenTelemetry.Trace;

namespace <RootNamespace>.Projections.Infraestructura;

/// <summary>
/// Sampler que descarta en origen el span de polling del daemon HotCold de Marten (MEF-ADR-0038
/// seccion 5) y delega todo lo demas al sampler interno. NUNCA expone el sampler delegado por
/// getter (MEF-ADR-0012): compone su Description a partir de la del delegado, al estilo de
/// OpenTelemetry.Trace.ParentBasedSampler ("ParentBased{" + rootSampler.Description + "}").
/// </summary>
public sealed class SamplerQueDescartaPollingDelDaemon : Sampler
{
    // "marten.daemon.highwatermark": OtelPrefix por defecto de Marten ("marten") + el sufijo que
    // concatena HighWaterAgent. Verificado por lectura de fuente de JasperFx/jasperfx:
    // - src/JasperFx.Events/Daemon/HighWater/HighWaterAgent.cs:
    //   '_spanName = $"{_settings.OtelPrefix}.daemon.highwatermark";'
    // - src/JasperFx.Events/Projections/ProjectionGraph.cs (de donde ProjectionOptions hereda
    //   DaemonSettings.OtelPrefix) y Marten/Events/Projections/ProjectionOptions.cs:
    //   'internal ProjectionOptions(StoreOptions options): base(options.EventGraph, "marten")'
    // -- el prefijo "marten" esta hardcodeado ahi, no es parametrizable desde StoreOptions.
    // Es el span medido en el 95% del volumen read-side del consumidor Bitakora.ControlAsistencia
    // (68.977 de 72.242 spans/dia, issue #308, MEF-ADR-0038 "Evidencia de campo"). Publico -- no
    // 'internal' mas InternalsVisibleTo, que el .csproj generado de Projections.Tests no declara --
    // porque el guardrail (c) del config-test (Paso 1d punto 4) lo compara EN VIVO, desde el otro
    // ensamblado, contra 'new StoreOptions().Projections.OtelPrefix': si una version futura de
    // Marten renombra el prefijo, ese guardrail rompe en vez de dejarlo pasar en silencio (riesgo
    // ya aceptado en las Consecuencias negativas de MEF-ADR-0038).
    public const string SpanPollingDaemon = "marten.daemon.highwatermark";

    private readonly Sampler _interno;

    // Un solo parametro (el sampler interno), no dos: el nombre del span filtrado es la constante
    // de arriba, no un valor que el llamador elija -- parametrizarlo abstraeria un mecanismo con un
    // unico sitio de uso (MEF-ADR-0018) y dejaria el filtro configurable-a-medio-camino, con el
    // literal del wiring y la constante pudiendo divergir. Misma forma que el consumidor de
    // referencia (Bitakora.ControlAsistencia, PR #311).
    public SamplerQueDescartaPollingDelDaemon(Sampler interno)
    {
        _interno = interno;

        // Una sola capa alrededor de la Description del delegado, al estilo de la propia
        // OpenTelemetry (ParentBasedSampler produce "ParentBased{<Description del root>}"):
        // MEF-ADR-0038 seccion 4 lee esta cadena publica como oraculo del sampler efectivo, y
        // MEF-ADR-0012 prohibe exponer el delegado por getter solo para que un test lo afirme.
        Description = $"{nameof(SamplerQueDescartaPollingDelDaemon)}{{{interno.Description}}}";
    }

    public override SamplingResult ShouldSample(in SamplingParameters samplingParameters)
    {
        return samplingParameters.Name == SpanPollingDaemon
            ? new SamplingResult(SamplingDecision.Drop)
            : _interno.ShouldSample(in samplingParameters);
    }
}
```

**Por que el filtro va AFUERA y `ParentBasedSampler` ADENTRO (CA-2), no al reves.** `TracerProviderSdk` invoca un unico `Sampler` -- el que quede instalado por el ultimo `SetSampler` (seccion 3) -- para CADA span, root o hijo (verificado por lectura de fuente de `opentelemetry-dotnet` tag `core-1.17.0`, `TracerProviderSdk.ComputeActivitySamplingResult`/`PropagateOrIgnoreData`). Con `SamplerQueDescartaPollingDelDaemon` como el sampler mas externo:

1. **Span raiz del daemon** (nombre coincide): retorna `Drop` directo, sin consultar el interno. `PropagateOrIgnoreData` lo clasifica como raiz -> `ActivitySamplingResult.PropagationData`: el `Activity` **si se instancia** (para que el hijo pueda enlazarse a su TraceId), pero queda sin grabar -- `IsAllDataRequested` en `false`, nunca llega a ningun processor/exporter (`TracerProviderSdk` solo invoca `Processor.OnEnd` cuando `IsAllDataRequested` es `true`).
2. **Hijo Npgsql de ese mismo span** (nombre no coincide): el filtro delega al `ParentBasedSampler` interno. Ese sampler ve que el padre (el span del daemon) quedo sin la bandera `Recorded` (por el `Drop` del punto 1) y que el padre es local -- despacha a su `localParentNotSampled` (default `AlwaysOffSampler`) -> `Drop` de nuevo. Esta vez `PropagateOrIgnoreData` NO lo trata como raiz (tiene padre) ni el padre es remoto -> `ActivitySamplingResult.None`: el `Activity` del hijo **nunca se instancia** (`ActivitySource.StartActivity` retorna `null`). Esta es la verificacion que MEF-ADR-0038 seccion 5 cita ("el hijo Npgsql ni siquiera se instancia") y la razon de que `ParentBasedSampler` "no sea un envoltorio decorativo": un `Sampler` plano (p. ej. `TraceIdRatioBasedSampler` solo, sin `ParentBasedSampler`) no consulta la decision del padre en absoluto -- cada span, hijo o no, tira sus propios dados sobre su TraceId, y el hijo se instanciaria igual aunque el padre haya sido descartado.
3. **Span de proyeccion real** (nombre no coincide, sin padre): el filtro delega al `ParentBasedSampler` interno, que -- sin padre -- despacha a su `rootSampler` (`TraceIdRatioBasedSampler(ratio)`), y samplea segun el ratio configurado.

Invertir el anidamiento (un `ParentBasedSampler` externo con el filtro como su `rootSampler`) resuelve los casos 1/2 igual de bien **hoy** -- `ParentBasedSampler` ya cae en `AlwaysOffSampler` para cualquier hijo de un padre no sampleado, sin que el filtro necesite ver ese hijo --, pero no es la forma que fija la doctrina ni la que corre verificada en produccion: **MEF-ADR-0034 seccion 10 punto 4** la enuncia explicitamente (*"instala por defecto un sampler que envuelve `ParentBasedSampler(TraceIdRatioBasedSampler(ratio))`, descartando antes por nombre el span de polling del daemon"*), y es el anidamiento del consumidor de referencia (Bitakora.ControlAsistencia, PR #311). Tampoco es equivalente en el margen: como `rootSampler`, el filtro solo se consulta para spans **sin padre**, asi que un span de polling del daemon colgado de otro span -- hoy no ocurre, pero ningun contrato publico de Marten lo garantiza -- pasaria sin que el filtro lo vea. Manten un unico anidamiento valido para este agente: el filtro afuera. El guardrail (a) del config-test (Paso 1d punto 4) lo fija por dos vias, el tipo del sampler efectivo (`BeOfType<SamplerQueDescartaPollingDelDaemon>`) y el literal exacto de `Description`.

---

**3. Invocar el seam desde `Program.cs` (CA-3).** Lee `src/<RootNamespace>.Projections/Program.cs`: si la linea `builder.Services.ConfigurarEventos(martenConnectionString);` esta presente sin encadenar `ConfigurarObservabilidad()` antes, reemplazala por:

```csharp
builder.Services
    .ConfigurarObservabilidad()
    .ConfigurarEventos(martenConnectionString);
```

Si `Program.cs` ya invoca `ConfigurarObservabilidad` (re-ejecucion tras un Paso 1d anterior que no llego a completarse, por ejemplo), no lo dupliques. Si la linea esperada no aparece exactamente igual porque `Program.cs` diverge del template (edicion manual posterior), lee el archivo completo y decide el punto de insercion: siempre antes de `ConfigurarEventos`, nunca despues -- registrar la telemetria primero deja capturado cualquier fallo de arranque de los seams que corren despues. No necesita ningun `using` nuevo: `ConfiguracionObservabilidadProjections` vive en el mismo namespace `<RootNamespace>.Projections.Infraestructura` que `Program.cs` ya importa.

---

**4. Crear el config-test de observabilidad (issue #513, CA-5 -- guardrail de MEF-ADR-0038 seccion 4; extendido por issue #778 -- guardrail de la seccion 10)** -- solo si el probe lo reporto como **FALTA**; si EXISTE, no lo toques (regla absoluta 1) y continua al Paso 2. Va en `tests/<RootNamespace>.Projections.Tests/ConfiguracionObservabilidadProjectionsTests.cs`: la **raiz** del proyecto de tests, hermano directo de `ConfiguracionMartenProjectionsTests.cs` (Paso 1c) -- no dentro de ese mismo archivo: ese config-test nunca invoca `ConfigurarObservabilidad` (construye su `IServiceCollection` invocando directamente los `Configurar{Dominio}` de cada dominio, `config-test.md`), asi que la unica forma de ejercitar el seam de observabilidad es un archivo propio:

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Reflection;
using AwesomeAssertions;
using Azure.Monitor.OpenTelemetry.Exporter;
using <RootNamespace>.Projections.Infraestructura;
using Marten;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

namespace <RootNamespace>.Projections.Tests;

/// <summary>
/// Guardrails deterministas del sampler de observabilidad (MEF-ADR-0038 seccion 4/5/9) y de la
/// supresion selectiva de metricas (MEF-ADR-0038 seccion 10, issue #778): construir el grafo real
/// y verificarlo, no confiar en revision visual del codigo -- mismo principio que
/// ComposicionContenedorTests del write-side (MEF-ADR-0029/domain-scaffolder).
/// </summary>
public class ConfiguracionObservabilidadProjectionsTests
{
    // Reflection sobre TracerProviderSdk.Sampler (propiedad INTERNA del SDK de OpenTelemetry,
    // MEF-ADR-0038 seccion 4): no hay API publica que la exponga directamente. Mensaje accionable
    // si la propiedad desaparece o cambia de nombre en un upgrade de paquete.
    private static Sampler ObtenerSamplerEfectivo(TracerProvider tracerProvider)
    {
        var propiedadSampler = tracerProvider.GetType()
            .GetProperty("Sampler", BindingFlags.Instance | BindingFlags.NonPublic);

        propiedadSampler.Should().NotBeNull(
            "TracerProviderSdk.Sampler deberia existir como propiedad interna del SDK de " +
            "OpenTelemetry (MEF-ADR-0038 seccion 4, verificado contra la version pinneada por " +
            "este agente); si un upgrade de paquete la renombro o la elimino, reverifica contra " +
            "la nueva version antes de asumir que el sampler configurado sigue vigente");

        return (Sampler)propiedadSampler!.GetValue(tracerProvider)!;
    }

    private static ServiceProvider ConstruirProveedor()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.ConfigurarObservabilidad();

        return services.BuildServiceProvider();
    }

    // Guardrail (a), parte 1 (CA-5): el sampler efectivo instalado en el TracerProvider es el del
    // marco, no el RateLimitedSampler interno que UseAzureMonitorExporter() instala si el orden de
    // la seccion 3 se rompe. La asercion POSITIVA va primero -- es la que sostiene el guardrail: el
    // nombre del sampler interno del exporter es un detalle de otro paquete, y si una version
    // futura lo renombra, un NotBe aislado pasaria en verde con la regresion de orden puesta
    // (leccion del review de la propagacion al write-side, issue #511/PR #519).
    [Fact]
    public async Task ConfigurarObservabilidad_ElSamplerEfectivoNoEsElDelExporterDeAzureMonitor()
    {
        await using var proveedor = ConstruirProveedor();

        var tracerProvider = proveedor.GetRequiredService<TracerProvider>();
        var samplerEfectivo = ObtenerSamplerEfectivo(tracerProvider);

        samplerEfectivo.Should().BeOfType<SamplerQueDescartaPollingDelDaemon>(
            "el worker instala SamplerQueDescartaPollingDelDaemon en un segundo .WithTracing(...) " +
            "posterior a UseAzureMonitorExporter() (MEF-ADR-0038 seccion 3/5); cualquier otro tipo " +
            "aqui significa que el sampler del marco no llego al TracerProvider");

        samplerEfectivo.GetType().FullName.Should().NotBe(
            "Azure.Monitor.OpenTelemetry.Exporter.Internals.RateLimitedSampler",
            "UseAzureMonitorExporter() instala este sampler internamente si el SetSampler del " +
            "worker quedo encadenado ANTES del exporter (MEF-ADR-0038 seccion 3) -- verlo aqui " +
            "significa que la regresion de orden ya ocurrio, en silencio para build, tests y logs " +
            "de arranque");
    }

    // Guardrail (a), parte 2 (CA-5): el borde critico es el DEFAULT -- este test no declara
    // TELEMETRY_SAMPLING_RATIO, el camino que corre para cualquier consumidor nuevo. Description
    // compuesta por lectura de fuente de opentelemetry-dotnet tag core-1.17.0 (la version del core
    // que arrastra OpenTelemetry.Extensions.Hosting 1.17.0, Paso 1d punto 1): ParentBasedSampler
    // compone "ParentBased{<Description del root>}", TraceIdRatioBasedSampler formatea el ratio con
    // "F6" en InvariantCulture, y SamplerQueDescartaPollingDelDaemon envuelve esa cadena con su
    // propio nombre (ver su ctor, Paso 1d punto 2b). Un literal plano, no interpolado: es el valor
    // real esperado, y verlo completo en el codigo del test es justo lo que permite compararlo con
    // el de la falla. Si no coincide -- o tras subir esa version --, lee la Description real del
    // mensaje de falla y CORRIGE el literal; nunca borres ni relajes la asercion.
    [Fact]
    public async Task ConfigurarObservabilidad_ElRatioDefaultLlegaAlSamplerEfectivo()
    {
        await using var proveedor = ConstruirProveedor();

        var tracerProvider = proveedor.GetRequiredService<TracerProvider>();
        var samplerEfectivo = ObtenerSamplerEfectivo(tracerProvider);

        samplerEfectivo.Description.Should().Be(
            "SamplerQueDescartaPollingDelDaemon{ParentBased{TraceIdRatioBasedSampler{1.000000}}}");
    }

    // Guardrail (d) (CA-2, issue #680): el borde critico es EnableTraceBasedLogsSampler, no el
    // Sampler de trazas -- MEF-ADR-0038 seccion 9 (verificado por lectura de fuente contra
    // Azure.Monitor.OpenTelemetry.Exporter 1.8.3, la version pinneada en el punto 1 de este mismo
    // paso): el default true del exporter instala LogFilteringProcessor, que descarta todo
    // LogRecord salvo que SpanId == default || TraceFlags == Recorded -- justo lo que suprime los
    // LogError del daemon emitidos bajo el span de polling que SamplerQueDescartaPollingDelDaemon
    // ya descarta (0% de los 35 errores de "high water statistics" llegaron a exceptions en la
    // medicion de campo, Bitakora.ControlAsistencia). Se verifica el valor RESUELTO de
    // AzureMonitorExporterOptions -- lo que el exporter realmente usa -- nunca el texto del seam:
    // si el flip del punto 2 desaparece, este guardrail cae en rojo aunque el archivo compile.
    [Fact]
    public async Task ConfigurarObservabilidad_DeshabilitaElSamplerDeLogsBasadoEnTrazas()
    {
        await using var proveedor = ConstruirProveedor();

        var opciones = proveedor.GetRequiredService<IOptions<AzureMonitorExporterOptions>>().Value;

        opciones.EnableTraceBasedLogsSampler.Should().BeFalse(
            "MEF-ADR-0038 seccion 9: el default true de Azure.Monitor.OpenTelemetry.Exporter " +
            "instala LogFilteringProcessor, que descarta los LogError del daemon emitidos bajo " +
            "el span de polling que SamplerQueDescartaPollingDelDaemon ya descarta");
    }

    // Guardrail (c) (CA-5): el nombre del span filtrado se compara EN VIVO contra
    // StoreOptions().Projections.OtelPrefix -- nunca contra un literal "marten" hardcodeado en el
    // test -- para que un rename futuro del prefijo de Marten rompa este guardrail en vez de dejarlo
    // pasar en silencio (Consecuencias negativas de MEF-ADR-0038: "el filtro por nombre de span es
    // fragil a un rename... exige reverificar el nombre exacto al subir la version pinneada de
    // Marten").
    [Fact]
    public void SamplerQueDescartaPollingDelDaemon_ElSpanFiltradoCoincideConElOtelPrefixDeMarten()
    {
        var otelPrefixEsperado = new StoreOptions().Projections.OtelPrefix;

        SamplerQueDescartaPollingDelDaemon.SpanPollingDaemon.Should()
            .Be($"{otelPrefixEsperado}.daemon.highwatermark");
    }

    // Colector minimo para el guardrail (b): un BaseProcessor<Activity> ya es parte del paquete
    // OpenTelemetry (transitivo via OpenTelemetry.Extensions.Hosting, Paso 1d punto 1) -- no agrega
    // ningun PackageReference nuevo al proyecto de tests.
    private sealed class ColectorDeActividadesEnMemoria(List<Activity> destino) : BaseProcessor<Activity>
    {
        public override void OnEnd(Activity data) => destino.Add(data);
    }

    // Fuentes propias de este test, prefijadas con el nombre de la clase -- NO los literales
    // "Marten"/"Npgsql" que el seam registra: xUnit corre clases de test distintas del mismo
    // ensamblado en paralelo, y un ActivitySource con el nombre real de la libreria haria que este
    // colector recogiera tambien los spans que otra clase genere contra Marten (test acoplado a
    // vecinos, no hermetico). El sampler decide por el NOMBRE DE LA ACTIVIDAD, nunca por el de su
    // fuente, asi que el prefijo no debilita nada de lo que este guardrail verifica -- mismo criterio
    // que el consumidor de referencia (PR #311).
    private const string FuenteMarten = nameof(ConfiguracionObservabilidadProjectionsTests) + ".Marten";
    private const string FuenteNpgsql = nameof(ConfiguracionObservabilidadProjectionsTests) + ".Npgsql";

    // Guardrail (b) (CA-5): verificacion de cascada real contra el SDK de OpenTelemetry, no contra
    // Sampler.ShouldSample() aislado (eso no ejercitaria TracerProviderSdk.ComputeActivitySamplingResult/
    // PropagateOrIgnoreData, que es donde vive la cascada que MEF-ADR-0038 seccion 5 exige). Replica
    // el MISMO sampler que instala ConfigurarObservabilidad (ratio 1.0, el default sin declarar
    // TELEMETRY_SAMPLING_RATIO) contra dos ActivitySource reales.
    [Fact]
    public void SamplerQueDescartaPollingDelDaemon_DescartaElSpanDelDaemonYNoInstanciaElHijoNpgsql_PeroConservaLaProyeccionReal()
    {
        var actividadesExportadas = new List<Activity>();

        using var tracerProvider = Sdk.CreateTracerProviderBuilder()
            .AddSource(FuenteMarten)
            .AddSource(FuenteNpgsql)
            .SetSampler(new SamplerQueDescartaPollingDelDaemon(
                new ParentBasedSampler(new TraceIdRatioBasedSampler(1.0))))
            .AddProcessor(new ColectorDeActividadesEnMemoria(actividadesExportadas))
            .Build();

        using var origenMarten = new ActivitySource(FuenteMarten);
        using var origenNpgsql = new ActivitySource(FuenteNpgsql);

        using (var actividadDaemon = origenMarten.StartActivity(SamplerQueDescartaPollingDelDaemon.SpanPollingDaemon))
        {
            // El span raiz SI se instancia (ActivitySamplingResult.PropagationData: preserva el
            // TraceId para que el hijo pueda enlazarse), pero queda sin grabar -- nunca llega al
            // colector (ver la asercion final).
            actividadDaemon.Should().NotBeNull();

            using var actividadNpgsqlHija = origenNpgsql.StartActivity("consulta-highwatermark");

            // La asercion central de MEF-ADR-0038 seccion 5: sin ParentBasedSampler como interno,
            // este hijo se instanciaria igual (un Sampler plano no consulta la decision del padre).
            // Es null porque el padre quedo Drop y el hijo es local/no-remoto
            // (TracerProviderSdk.PropagateOrIgnoreData: raiz o padre remoto -> PropagationData;
            // cualquier otro caso -> None).
            actividadNpgsqlHija.Should().BeNull();
        }

        using (var actividadProyeccionReal = origenMarten.StartActivity("marten.OtraProyeccion.0"))
        {
            actividadProyeccionReal.Should().NotBeNull();
        }

        actividadesExportadas.Should().NotContain(
            a => a.OperationName == SamplerQueDescartaPollingDelDaemon.SpanPollingDaemon,
            "el span de polling del daemon nunca deberia llegar al exporter (MEF-ADR-0038 seccion 5)");
        actividadesExportadas.Should().Contain(
            a => a.OperationName == "marten.OtraProyeccion.0",
            "un span de proyeccion real, con ratio 1.0, debe sobrevivir intacto");
    }

    // Guardrail (e) (MEF-ADR-0038 seccion 10, evidencia (e) de #764, CA-3 issue #778): verifica el
    // CONTENEDOR EFECTIVO, no la sola lectura del Paso 1d punto 2 -- mismo principio que los
    // guardrails de arriba. No reusa ConstruirProveedor(): necesita enganchar un segundo
    // MetricReader de solo-test ANTES de construir el ServiceProvider, via
    // ConfigureOpenTelemetryMeterProvider (se engancha al MeterProviderBuilder que el seam ya
    // compuso -- las vistas de un MeterProviderBuilder son globales al provider y aplican a todos
    // sus readers por igual, asi que el InMemoryExporter observa exactamente el mismo resultado de
    // filtrado que veria el reader real de Azure Monitor). El instrumento es ARBITRARIO, nunca una
    // familia real con nombre: prueba que la vista descarta cualquier instrumento fuera de la
    // familia GC, no solo los que el marco conoce hoy. El reader exporta por intervalo, no en cada
    // medida: sin ForceFlush() sobre el MeterProvider resuelto, la asercion fallaria por
    // temporizacion, no por la doctrina.
    [Fact]
    public async Task ConfigurarObservabilidad_SuprimeUnInstrumentoArbitrarioSinTumbarElTracing()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.ConfigurarObservabilidad();

        using var meterArbitrario = new Meter($"{nameof(ConfiguracionObservabilidadProjectionsTests)}.MeterArbitrarioDeGuardrail");
        var metricasExportadas = new List<Metric>();
        services.ConfigureOpenTelemetryMeterProvider(builder => builder
            .AddMeter(meterArbitrario.Name)
            .AddInMemoryExporter(metricasExportadas));

        await using var proveedor = services.BuildServiceProvider();

        meterArbitrario.CreateCounter<long>("contador-arbitrario-de-guardrail").Add(1);
        proveedor.GetRequiredService<MeterProvider>().ForceFlush();

        metricasExportadas.Should().BeEmpty(
            "la vista func-based (MEF-ADR-0038 seccion 10) debe descartar cualquier instrumento " +
            "fuera de la familia dotnet.gc.*, incluido uno que el worker nunca declaro");

        proveedor.GetRequiredService<TracerProvider>().Should().NotBeNull(
            "la supresion de metricas no debe afectar la resolucion del TracerProvider -- son " +
            "providers independientes en la misma composicion de OpenTelemetry");
    }

    // Guardrail (f) (MEF-ADR-0038 seccion 10, evidencia (e) de #764, CA-3 issue #778): prueba mas
    // fuerte que verificar la familia GC aislada del guardrail (e) -- un instrumento arbitrario
    // CONVIVE en la misma composicion con uno de los 3 nombres GC del contrato, y solo el GC
    // sobrevive. Ancla los 3 nombres literales (a diferencia del guardrail (e), que usa uno
    // arbitrario) porque son, a diferencia de cualquier otro instrumento, el CONTRATO EXACTO que
    // la seccion 10 del ADR fija -- una lista cerrada, no un wildcard: si un upgrade de paquete
    // renombra alguno, este guardrail cae en rojo en vez de dejarlo pasar en silencio.
    [Theory]
    [InlineData("dotnet.gc.collections")]
    [InlineData("dotnet.gc.last_collection.heap.size")]
    [InlineData("dotnet.gc.last_collection.heap.fragmentation.size")]
    public async Task ConfigurarObservabilidad_ConservaSoloLaFamiliaGCCuandoConviveConUnInstrumentoArbitrario(string nombreInstrumentoGC)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.ConfigurarObservabilidad();

        using var meter = new Meter($"{nameof(ConfiguracionObservabilidadProjectionsTests)}.MeterDeSelectividad");
        var metricasExportadas = new List<Metric>();
        services.ConfigureOpenTelemetryMeterProvider(builder => builder
            .AddMeter(meter.Name)
            .AddInMemoryExporter(metricasExportadas));

        await using var proveedor = services.BuildServiceProvider();

        meter.CreateCounter<long>(nombreInstrumentoGC).Add(1);
        meter.CreateCounter<long>("contador-arbitrario-de-guardrail").Add(1);
        proveedor.GetRequiredService<MeterProvider>().ForceFlush();

        metricasExportadas.Should().ContainSingle(m => m.Name == nombreInstrumentoGC,
            "la familia GC (MEF-ADR-0038 seccion 10) debe sobrevivir intacta, sin importar que " +
            "otro instrumento arbitrario conviva en la misma composicion");
        metricasExportadas.Should().NotContain(m => m.Name == "contador-arbitrario-de-guardrail",
            "el instrumento arbitrario debe seguir descartado aunque conviva con uno de la " +
            "familia GC en la misma medicion -- prueba mas fuerte que verificarlos por separado");
    }
}
```

`StoreOptions` (guardrail c) resuelve desde el `PackageReference` a `Marten` que el `.csproj` de `Projections.Tests` ya declara (Paso 1c); los `using` de la primera mitad de este archivo no requieren ningun paquete nuevo -- `Sdk`/`BaseProcessor<Activity>` viven en el namespace raiz `OpenTelemetry`, `TracerProvider`/`Sampler`/`ParentBasedSampler`/`TraceIdRatioBasedSampler`/`SamplingResult`/`SamplingParameters`/`SamplingDecision` en `OpenTelemetry.Trace` (verificado por lectura de fuente del mismo tag `core-1.17.0` que ya cita este agente), y ambos paquetes llegan transitivamente via el `ProjectReference` de `Projections.Tests` al worker (Paso 1c). Los dos `using` del guardrail (d) tampoco agregan paquete: `AzureMonitorExporterOptions` viene de `Azure.Monitor.OpenTelemetry.Exporter` (el `PackageReference` del punto 1, transitivo por el mismo `ProjectReference`) e `IOptions<T>` de `Microsoft.Extensions.Options`, que ya llega con `Microsoft.Extensions.DependencyInjection`. **No los "limpies"**: sin ellos el archivo no compila (`CS0246`/`CS0305`), mismo modo de falla que el `using OpenTelemetry;` del seam. Los guardrails (e)/(f), en cambio, **si** necesitan un paquete nuevo: `System.Diagnostics.Metrics` (`Meter`) llega con el SDK base, pero `AddInMemoryExporter`/`Metric` (`OpenTelemetry.Metrics`) exigen el `PackageReference OpenTelemetry.Exporter.InMemory` que el Paso 1d punto 1b agrega al `.csproj` de este mismo proyecto -- sin el, `CS0246` en `Metric`/`AddInMemoryExporter`.

---

Esta receta completa (los dos `PackageReference` nuevos + el seam + el sampler wrapper + la linea nueva de `Program.cs` + el config-test de observabilidad) tiene cada API resuelta contra su namespace por **lectura de fuente** del tag `core-1.17.0` de `open-telemetry/opentelemetry-dotnet` (ver la nota de los `using` arriba), y su gemela del write-side -- misma cadena `AddOpenTelemetry()...WithTracing(...).UseAzureMonitorExporter()` -- compila y exporta en produccion (MEF-ADR-0003, verificado por el consumidor Cosmos.ControlPlane). Aun asi, **el `dotnet build`/`dotnet test` del Paso 4 es el que lo confirma en el repo concreto**: si el build falla, el sospechoso numero uno es un `using` faltante o "limpiado" del bloque de arriba, no la version de los paquetes; si el que falla es alguno de los siete guardrails de este punto, aplica el mismo runbook que ya fijo la propagacion al write-side (issue #511/PR #519, `domain-scaffolder.md`): un guardrail de tipo/orden en rojo (parte 1 de guardrail a) senala una regresion real de codigo, nunca del test; un guardrail de `Description` en rojo (parte 2 de guardrail a) con un ratio distinto de `1.000000` en la `Description` real no es un literal desactualizado: es que el entorno del build **si** declara `TELEMETRY_SAMPLING_RATIO`, y ese guardrail verifica justo el camino default (MEF-ADR-0038 seccion 4) -- corre `dotnet test` con la variable sin declarar, nunca ajustes el literal a un ratio de entorno; el mismo en rojo mientras la `Description` real siga con la forma esperada y el ratio en `1.000000` es un literal desactualizado frente a la version del SDK instalada -- copia el valor real al literal; un guardrail (b)/(c) en rojo con el mensaje de falla senalando un span o prefijo distinto al esperado es un cambio real de Marten o de OpenTelemetry que hay que reverificar, nunca silenciar relajando la asercion; y un guardrail (d) en rojo (`EnableTraceBasedLogsSampler` distinto de `false`, issue #680, MEF-ADR-0038 seccion 9) senala que el flip del punto 2 desaparecio o se reescribio -- repon `o.EnableTraceBasedLogsSampler = false` en `UseAzureMonitorExporter(...)`, nunca relajes la asercion ni lo conviertas en condicional.

Si el que falla es uno de los dos guardrails de la supresion selectiva de metricas (MEF-ADR-0038 seccion 10, issue #778), la accion tampoco es la misma en cada caso:

- Guardrail (e) (`...SuprimeUnInstrumentoArbitrarioSinTumbarElTracing`) en rojo por `metricasExportadas.Should().BeEmpty(...)`: la vista func-based del Paso 1d punto 2 (`.AddView(instrument => EsMetricaDeGC(...) ? null : MetricStreamConfiguration.Drop)`) desaparecio, quedo detras de un `AddMeter(...)` que restringe el alcance, o se le sumo un segundo `AddView` mas especifico (fan-out, seccion 10 del ADR: las vistas no son *first-match-wins*). Repon la vista unica en el codigo de produccion -- nunca reduzcas el guardrail a una lista de familias conocidas ni le agregues un `Timeout`/reintento.
- El mismo guardrail (e) en rojo por `proveedor.GetRequiredService<TracerProvider>()`: la supresion de metricas rompio la resolucion del tracing -- revisa que el `.WithMetrics(...)` nuevo no haya reemplazado (en vez de sumarse a) la cadena `.WithTracing(...)`/`UseAzureMonitorExporter()` existente del mismo `AddOpenTelemetry()`.
- Guardrail (f) (`...ConservaSoloLaFamiliaGCCuandoConviveConUnInstrumentoArbitrario`) en rojo porque el nombre GC del `[Theory]` tambien desaparecio del `InMemoryExporter`: `EsMetricaDeGC` dejo de reconocer alguno de los 3 literales -- reverifica los 3 nombres contra la version instalada de `OpenTelemetry.Extensions.Hosting` antes de tocar el literal del test; si el nombre real cambio, actualiza `EsMetricaDeGC` (produccion) y el `[InlineData]` correspondiente (test) juntos, nunca solo uno de los dos.
- El mismo guardrail (f) en rojo porque el instrumento arbitrario **si** aparece: el par de dos `AddView` volvio (fan-out), o el predicado de `EsMetricaDeGC` se invirtio (conserva todo salvo GC). Repon la vista unica func-based, nunca relajes la asercion `NotContain`.
- Error de compilacion (`CS0246`) en `MetricStreamConfiguration`, `ConfigureOpenTelemetryMeterProvider`, `AddInMemoryExporter`, `Metric` o `Meter`: falta el `using OpenTelemetry.Metrics;`/`using System.Diagnostics.Metrics;` (produccion o test) o el `PackageReference OpenTelemetry.Exporter.InMemory` en el `.csproj` de `Projections.Tests` (Paso 1d punto 1b).
- Si `dotnet test` falla con `InvalidOperationException` al resolver `MeterProvider` (solo los guardrails (e)/(f) lo resuelven -- los cuatro anteriores piden `TracerProvider`, que si se construye sin connection string, de ahi que esta regresion se vea unicamente en los dos nuevos): el fallback `PostConfigure<AzureMonitorExporterOptions>` del Paso 1d punto 2 desaparecio -- sin connection string real ni dummy, el metric reader revienta de forma sincronica al construirse (MEF-ADR-0038 seccion 10, asimetria frente al `TracerProvider`). Repon el `PostConfigure`, nunca le pases la connection string real al seam (MEF-ADR-0025, regla absoluta 10).

---

## Paso 2 - Generar el Dockerfile (CA-3)

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
test -f "$REPO_ROOT/src/<RootNamespace>.Projections/Dockerfile" && echo "EXISTE (omitir)" || echo "FALTA (crear)"
```

Si falta, crea `src/<RootNamespace>.Projections/Dockerfile`. Sigue el patron oficial de contenedorizacion de un Worker Service .NET (Microsoft Learn, "Worker Services - .NET" -- imagen `base` sobre `dotnet/runtime` **sin** ASP.NET, imagen `build` sobre `dotnet/sdk`, etapas `publish`/`final`), adaptado al layout multi-proyecto de este repo (build context = raiz del repo, no la carpeta del proyecto):

```dockerfile
# syntax=docker/dockerfile:1

# Build context: raiz del repo -> docker build -f src/<RootNamespace>.Projections/Dockerfile -t <tag> .
# Imagen base sobre runtime (no aspnet): el worker no sirve HTTP, solo hostea el daemon
# asincronico de Marten. Sin bloque EXPOSE: el Container App corre sin ingress (MEF-ADR-0034
# seccion 8) -- nadie le hace requests HTTP/TCP.

FROM mcr.microsoft.com/dotnet/runtime:10.0 AS base
WORKDIR /app

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
# Capa de restore GENERICA sobre N dominios, presentes y futuros, sin editar jamas este
# Dockerfile (CA-1, issue #552). El worker referencia <RootNamespace>.ReadModels (Paso 1b) y, por
# cada dominio adoptado, <RootNamespace>.{Dominio}.DomainEvents (MEF-ADR-0039 decision 2, cableado
# por domain-scaffolder issue #548 y por el bucle cierra-huecos del Paso 1b de este agente) --
# nunca el .csproj de un Function App (decision 4, verificado en el Paso 4). Enumerar cada .csproj
# a mano (como antes de este issue) rompe el build en cuanto el primer dominio registra su named
# store: el 'dotnet restore' de abajo no puede resolver un ProjectReference cuyo .csproj todavia
# no llego a esta capa.
#
# COPY --parents (sintaxis docker/dockerfile:1, "Minimum Dockerfile version: 1.20" segun
# docs.docker.com/reference/dockerfile/#copy---parents) preserva la carpeta de CADA .csproj que
# matchea el patron, que es justo lo que el restore necesita: los <ProjectReference> del worker son
# rutas RELATIVAS (..\<RootNamespace>.{Dominio}.DomainEvents\...), asi que cada .csproj tiene que
# aterrizar bajo su propia carpeta. Un COPY con wildcard SIN --parents APLANA el destino -- la doc
# oficial lo ilustra: "COPY ./x/a.txt ./y/a.txt /no_parents/" deja "/no_parents/a.txt" -- y ademas
# advierte que ante una colision de nombres "[Buildkit] will silently overwrite the target file at
# the destination". Con el destino aplanado, ni la ruta del propio Projections.csproj del restore
# de abajo ni las rutas relativas de sus referencias existirian: el build muere aqui.
#
# El patron "src/<RootNamespace>.*/*.csproj" matchea TODO proyecto de primer nivel bajo src/
# (Projections, ReadModels, cada {Dominio}.DomainEvents, y tambien PublicEvents/PrivateEvents/cada
# Function App de dominio) -- deliberadamente mas ancho que "solo lo que el worker referencia". Es
# la unica forma de que esta capa nunca falle con CERO dominios adoptados todavia (orden greenfield
# tipico: el worker nace antes que los dominios, Paso 0): un patron acotado a "*.DomainEvents"
# matchea cero archivos en ese caso, y un COPY cuyo wildcard no matchea nada aborta el build con
# "COPY failed: no source files were specified" (comportamiento verificado -- ver
# github.com/dotnet/dotnet-docker/issues/750). El patron de arriba, en cambio, siempre matchea al
# menos Projections.csproj y ReadModels.csproj (creados en el Paso 1/1b, prerequisito de este Paso
# 2), asi que nunca revienta por ausencia de dominios. Los .csproj de mas que entran a esta capa
# (Function Apps, PublicEvents, PrivateEvents) quedan copiados sin uso: 'dotnet restore' solo
# resuelve lo que <RootNamespace>.Projections.csproj referencia de verdad, y ningun
# <ProjectReference> nuevo se agrega por este COPY -- MEF-ADR-0039 decision 4 se afirma sobre el
# contenido del .csproj (verificado mecanicamente en el Paso 4), no sobre que archivos entran a la
# capa de build de Docker.
COPY --parents src/<RootNamespace>.*/*.csproj ./
RUN dotnet restore "src/<RootNamespace>.Projections/<RootNamespace>.Projections.csproj"
COPY . .
WORKDIR "/src/src/<RootNamespace>.Projections"
RUN dotnet build "<RootNamespace>.Projections.csproj" -c Release -o /app/build

FROM build AS publish
# SHA horneado en el ensamblado (issue #462, MEF-ADR-0031 extendido al read-side): declarado en la
# etapa 'publish', NO en 'build' (arriba) -- un ARG antes del 'dotnet restore'/'dotnet build'
# invalidaria esa capa en cada commit (ver la nota de cache mas abajo); aqui, lo mas tarde posible,
# solo afecta esta etapa. Default vacio: un 'docker build' local sin '--build-arg' no rompe -- el
# target de MSBuild que concatena '+SourceRevisionId' se salta por completo cuando la propiedad
# esta vacia (verificado por lectura de fuente del target 'AddSourceRevisionToInformationalVersion',
# misma cita que MEF-ADR-0031), asi que no queda un '+' colgante en InformationalVersion.
ARG SOURCE_REVISION_ID=
RUN dotnet publish "<RootNamespace>.Projections.csproj" -c Release -o /app/publish -p:SourceRevisionId=$SOURCE_REVISION_ID

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "<RootNamespace>.Projections.dll"]
```

**Prerequisito del `COPY --parents`: BuildKit + frontend `docker/dockerfile:1` (issue #552).** La directiva `# syntax=docker/dockerfile:1` de la **primera linea** no es decorativa y no es opcional: `--parents` exige la version 1.20 o superior del frontend de Dockerfile (*"Minimum Dockerfile version: 1.20"*, [referencia oficial de `COPY --parents`](https://docs.docker.com/reference/dockerfile/#copy---parents)), y el tag flotante `1` resuelve siempre la ultima 1.x estable, asi que la satisface. Dos consecuencias que hay que respetar al transcribir el archivo: la directiva debe ir **antes de cualquier comentario, linea en blanco o instruccion** -- una directiva de parser que aparece despues de un comentario se degrada a comentario ordinario, en silencio, y el `--parents` deja de existir; y solo **BuildKit** la lee (el builder por defecto desde Docker Engine 23.0 y el que usa `docker/build-push-action`), de modo que un build forzado al builder clasico con `DOCKER_BUILDKIT=0` muere con `Unknown flag: parents`. Si la validacion opcional del Paso 4 falla asi en la maquina del consumidor, el sospechoso es el builder, no el Dockerfile.

**Acoplamiento entre este Dockerfile y el `rollForward` de `global.json` (issue #452):** `mcr.microsoft.com/dotnet/sdk:10.0` es un tag **flotante** -- sirve la ultima feature band y patch que Microsoft publique para la linea `10.0`, y avanza de banda sin que nadie mueva un digest aqui (hoy resuelve a `10.0.302`, banda `3xx`). Por eso el `global.json` del Paso 3 fija `rollForward` en `latestFeature` y no en `latestPatch`: `latestPatch` solo acepta un SDK que coincida en major, minor **y feature band** ([tabla de `rollForward`, Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/global-json#rollforward)), asi que en cuanto el tag sirva una banda distinta a la de `version` el SDK queda rechazado y la imagen no se puede construir. **Mientras la etapa `build` use un tag flotante, `rollForward` no puede ser mas estricto que `latestFeature`** sin quedar incompatible por construccion. Volver a `latestPatch` solo tendria sentido si esta imagen pasara a pinear una version exacta -- `dotnet/sdk` publica `10.0` o versiones completas como `10.0.302`, no tags de banda tipo `10.0.2xx` (verificado contra `mcr.microsoft.com/v2/dotnet/sdk/tags/list`) -- y ese pin habria que subirlo a mano en cada parche.

Nota tambien **donde** se manifiesta el fallo si el pin queda mal calibrado, porque no es donde uno lo buscaria: el `RUN dotnet restore` de la etapa `build` corre **antes** del `COPY . .`, asi que `global.json` todavia no esta en el build context y el restore resuelve el SDK sin ver el pin -- pasa sin problema. El `RUN dotnet build` posterior ya corre con `global.json` presente, y es ahi donde revienta (exit code 155, *"Install the [x.y.znn] .NET SDK or update [/src/global.json] to match an installed SDK"*). Ese orden de capas es deliberado -- preserva el cache del restore cuando solo cambia un `.cs` -- pero tiene el efecto colateral de enmascarar un pin roto hasta la capa del build.

**`ARG SOURCE_REVISION_ID` y el circuito del SHA (issue #462, MEF-ADR-0031 seccion read-side).** Este `ARG` es la pieza 1 de 3 del circuito completo: la pieza 2 (`--build-arg` en `docker build`) la genera el Paso 2b de este mismo agente; la pieza 3 (`serviceVersion` del `AddService(...)`) ya la crea el Paso 1d de arriba, leyendo el resultado de esta pieza por reflexion. Las tres deben coexistir para que `service.version` identifique una revision real -- ver la verificacion de punta a punta al final del Paso 2b.

---

## Paso 2a - Crear el `.dockerignore` del build context (CA-1..CA-5, issue #458)

El `COPY . .` del Dockerfile (Paso 2) usa como build context la **raiz del repo completa**, y hoy no la filtra: copia `bin/`/`obj/` de todos los proyectos, `.terraform/`, `node_modules/` si el consumidor lo tiene, y archivos con credenciales locales (`local.settings.json`, `*.tfstate`, `*.tfvars`) que MEF-ADR-0025 blinda del repositorio pero no del build context -- una via de fuga paralela que ese ADR no contempla. Docker **no lee `.gitignore`** (la correccion del Paso 1 de arriba, mas arriba en este mismo archivo): sin este `.dockerignore` propio, nada excluye esos archivos de la capa del builder.

**Gate independiente del Paso 2 (CA-1).** Este archivo vive en la **raiz del repo**, no en `src/<RootNamespace>.Projections/`, y su probe de idempotencia es propio -- **no** un sub-paso anidado bajo el gate del Dockerfile. Corre siempre, incluso cuando el Paso 2 reporto "EXISTE (omitir)": un consumidor con Dockerfile ya scaffoldeado por una version de este agente anterior a este issue nunca recibio `.dockerignore`, y anidar este paso bajo ese gate se lo negaria para siempre -- mismo defecto que el Paso 0 ya evita para `ReadModels`/`Projections.Tests`/el seam de observabilidad (ver la nota de ese paso, *"Gatear el paso completo dejaria esos dos huecos abiertos para siempre"*).

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
test -f "$REPO_ROOT/.dockerignore" && echo "EXISTE (omitir, NO sobrescribir)" || echo "FALTA (crear)"
```

Si existe, **no lo toques** -- puede llevar exclusiones que el consumidor agrego a mano -- y registralo como omitido en el reporte final (Paso 6).

**Si falta, crealo en la raiz del repo** (no junto al Dockerfile: Docker prioriza un `Dockerfile.dockerignore` especifico sobre el de la raiz cuando ambos existen, y elegir la raiz cubre tambien builds ad-hoc fuera de este workflow -- el caveat de precedencia queda documentado en el propio archivo generado, mas abajo). **Contenido byte-fijo (CA-2) -- transcribelo literal, sin normalizar espacios, orden ni comentarios**, misma regla que el `.gitignore` raiz de `infra-base-scaffolder` (su regla final 12, issue #241).

**Unica sustitucion permitida:** las dos apariciones de `<RootNamespace>` viven en los **comentarios** de cabecera (las rutas `src/<RootNamespace>.Projections/Dockerfile` y `src/<RootNamespace>.Projections/Dockerfile.dockerignore`) y las resuelves con el token del consumidor, igual que en el resto de este agente -- no dejes el placeholder literal en el archivo generado. **Ninguna linea de patron depende de ningun token**: la lista de exclusiones sale identica en todo consumidor, y ahi "byte-fijo" es absoluto.

```dockerignore
# .dockerignore del build context del worker de proyecciones. Vive en la RAIZ del repo
# porque la raiz es el build context (docker build -f src/<RootNamespace>.Projections/Dockerfile .).
#
# Docker NO lee .gitignore: este archivo es independiente, y sus patrones NO son los de git.
# Un patron sin '**/' solo casa en la RAIZ del contexto -- y en este layout no hay ningun
# bin/ ni obj/ en la raiz (viven bajo src/ y tests/), asi que 'bin/' a secas no excluiria nada.
#
# Precedencia: si alguien crea src/<RootNamespace>.Projections/Dockerfile.dockerignore,
# ESTE archivo deja de aplicar EN SILENCIO (Docker prefiere el especifico del Dockerfile).
#
# Exclusiones explicitas, nunca allowlist: el build necesita global.json (SDK de la etapa
# 'build', issue #452) y los .csproj/.cs de Projections y ReadModels.

# Metadatos de git y CI (el SHA entra por --build-arg SOURCE_REVISION_ID, no por .git/)
.git/
.gitignore
.github/

# Build output .NET -- eje de CORRECCION: el COPY . . va despues del dotnet restore y un
# obj/project.assets.json del host sobrescribe el que el contenedor acaba de generar.
**/bin/
**/obj/

# Secretos y estado local (MEF-ADR-0025): nunca en la capa del builder.
**/local.settings.json
**/appsettings.local.json
**/*.tfstate
**/*.tfstate.*
**/*.tfvars
**/*.tfvars.json

# Estado y herramientas que el build no necesita. node_modules/ y .idea/ no los crea el
# marco: son lineas inertes si el consumidor no los tiene, y ahorran cientos de MB si si.
**/.terraform/
**/node_modules/
.claude/
pipeline-state/
docs/
infra/

# Artefactos de IDE, logs y resultados de test
**/.vs/
**/.vscode/
**/.idea/
**/*.user
**/*.log
**/[Tt]est[Rr]esult*/
**/*.trx
**/*.coverage
**/coverage/
```

**Por que el prefijo `**/` no es cosmetico (CA-3).** Los patrones de `.dockerignore` no son los de `.gitignore`: un patron sin `**/` solo casa en la **raiz** del build context (verificado por ejecucion, Docker 28.5.1: un contexto de prueba con `src/App/bin/leak.txt` y `src/App/obj/leak.txt` deja **entrar** ambos archivos con `bin/`+`obj/` a secas, y los **excluye** con `**/bin/`+`**/obj/`). En este layout no hay ningun `bin/`/`obj/`/`local.settings.json`/`*.tfstate`/`.terraform/`/`node_modules/` en la raiz -- viven todos bajo `src/`, `tests/` o `infra/` -- por eso esas lineas llevan `**/`. Solo las rutas que si existen en la raiz (`.git/`, `.github/`, `.claude/`, `pipeline-state/`, `docs/`, `infra/`) van sin prefijo. Si al mantener este agente agregas una linea nueva, verificala con un `docker build` real antes de darla por buena: una linea sin `**/` que "deberia" excluir algo bajo `src/`/`tests/` es inerte -- el build sigue pasando y nadie lo nota.

---

## Paso 2b - Generar el workflow de deploy del worker (`deploy-projections.yml`, issue #453)

MEF-ADR-0034 seccion 8 da por sentado el pipeline de CI que construye la imagen del worker, la publica en el Container Registry del BC y actualiza el Container App -- lo nombra responsable de crear la revision nueva por publicacion y le asigna un analogo exacto en el write-side (*"Es el analogo read-side del step 'Reciclar las Function Apps'"*) -- pero ningun agente lo generaba todavia. Este paso lo cierra: mismo principio que ya rige el resto del marco (el agente que scaffoldea un artefacto es dueno de su deploy, `domain-scaffolder` con `deploy-{kebab}.yml` en el Paso 5 de ese agente) aplicado al Dockerfile que este agente acaba de generar en el Paso 2.

**Probe de idempotencia (CA-1): nunca sobrescribas este workflow si ya existe** -- mismo patron "solo si no existe" que `infra-cd.yml`/`smoke-tests*.yml` (puede llevar personalizaciones del consumidor):

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
test -f "$REPO_ROOT/.github/workflows/deploy-projections.yml" && echo "EXISTE (omitir, no sobrescribir)" || echo "FALTA (crear)"
```

Si existe, omite el resto de este paso y registralo como omitido en el reporte final (Paso 6).

**Resolver el resource group y el nombre del Container App (nombres deterministicos, se hornean una sola vez en este archivo).** El resource group y el Container App del worker tienen nombre deterministico (`rg-{prefix}` y `ca-projections-{prefix_func}`, esqueleto del entorno de `infra-base-scaffolder`, Paso 2.3/2.3b): se resuelven una sola vez, al generar este workflow, con el mismo mecanismo que ya usa `domain-scaffolder` (su Validacion 1) para hornear `func-{kebab}-{prefix_func}` en `deploy-{kebab}.yml`. Lee `infra/environments/dev/variables.tf` y toma los valores efectivos (`default`) de `project`, `project_short`, `environment` y -- si ese archivo las declara -- `azure_region_short`/`resource_sequence` -- **no** los recalcules desde `harness.config.json`: `project_short` pudo ajustarse a mano ahi (nota de limites de Azure de `infra-base-scaffolder`, Key Vault 3-24 chars), y `variables.tf` es la fuente de verdad una vez que ese agente ya corrio. Deriva **replicando los locals de ese mismo archivo** (patron CAF de MEF-ADR-0045, issue #730):

- `region_seq` = `-{azure_region_short}-{resource_sequence}` si `azure_region_short` tiene valor; **cadena vacia** si esta vacio o si el `variables.tf` es anterior al issue #730 y no declara esas dos variables (entonces las formas de abajo colapsan a `{project}-{environment}`/`{project_short}-{environment}`, como antes de ese issue)
- `prefix` = `{project}-{environment}{region_seq}` -> resource group `rg-{prefix}`
- `prefix_func` = `{project_short}-{environment}{region_seq}` -> Container App `ca-projections-{prefix_func}`

**Nunca** compongas estos dos nombres ignorando los locals reales del archivo. El nombre que hornees tiene que coincidir **literalmente** con el que el `main.tf` del entorno le pasa a cada modulo; si no, el `az containerapp update` del deploy falla con un error de recurso inexistente sobre un Container App que si existe, con otro nombre -- y el fallo aparece recien en el primer deploy del worker, no al generar este archivo.

Si `infra/environments/dev/variables.tf` **no existe todavia** (este agente puede correr antes que `infra-base-scaffolder` con el token ya habilitado -- ver el "Siguiente paso" del Paso 6), omite **solo este paso** y sigue con el Paso 3: no hay como resolver los nombres reales del resource group ni del Container App, pero el resto del scaffold (solucion, `global.json`, build, tests, commit) no depende de ellos y debe completarse igual. Informa que hace falta correr `/infra-base` primero (con `projections.enabled: true`) y registralo como **pendiente** en el reporte final -- **no** inventes un nombre ni dejes un placeholder sin resolver en un archivo que despues nadie vuelve a tocar (CA-1 solo permite generarlo una vez).

Con `rg-{prefix}` y `ca-projections-{prefix_func}` ya resueltos, crea `.github/workflows/deploy-projections.yml` con el siguiente contenido, sustituyendo tambien `<RootNamespace>` y `<SolutionFile>` (Paso 0):

```yaml
name: Deploy Projections Worker

# Deploy del worker de proyecciones (<RootNamespace>.Projections, MEF-ADR-0034): construye la
# imagen, la publica en el Container Registry del BC y actualiza el Container App a la revision
# nueva. Analogo read-side de deploy-{kebab}.yml (domain-scaffolder) -- MEF-ADR-0034 seccion 8 da
# por sentado este pipeline; lo genera projections-scaffolder desde el issue #453.
#
# Restricciones operativas (MEF-ADR-0034 seccion 8) -- NO impuestas por un workflow_run como en
# deploy-{kebab}.yml/infra-cd.yml (ver la nota "Sin encadenar tras Infra CD" mas abajo):
#   1. Debe correr DESPUES de que 'infra-cd.yml' haya sembrado 'marten-connection' y
#      'app-insights-connection' en el Key Vault del BC al menos una vez (esa siembra corre en un
#      step posterior al 'terraform apply', nunca antes) -- si no, la revision nueva de este
#      workflow arranca con la Key Vault reference todavia sin resolver.
#   2. Ante una ROTACION posterior de esos secretos, sembrar el valor nuevo NO propaga a una
#      revision ya corriendo (Microsoft Learn, "Manage secrets in Azure Container Apps": "Changing
#      a secret value doesn't automatically propagate to running revisions. You must create a new
#      revision or restart the existing one"). Publicar una imagen nueva por este workflow crea esa
#      revision nueva y resuelve el secreto rotado; si no hay imagen nueva que publicar todavia,
#      forzar 'az containerapp revision restart' a mano.
#
# Rollback: re-publicar el tag anterior -- 'az containerapp update --image <repo>:<sha-anterior>'.
# NUNCA tocar HCL para esto: tras el issue #456 (lifecycle.ignore_changes sobre
# template[0].container[0].image en el modulo container-app), Terraform ya no gobierna la imagen
# del Container App. 'az containerapp revision activate' NO sirve aqui: revision_mode = "Single"
# (MEF-ADR-0034 seccion 8) permite una unica revision activa a la vez -- las anteriores se
# desaprovisionan solas, no queda ninguna revision inactiva que "activar".

on:
  push:
    branches: [main]
    paths:
      - 'src/<RootNamespace>.Projections/**'
      - 'src/<RootNamespace>.ReadModels/**'
      # {Dominio}.DomainEvents (issue #552, MEF-ADR-0039 decision 2): el worker referencia el
      # DomainEvents de cada dominio que proyecta (Paso 1b de este agente / Paso 3b de
      # domain-scaffolder, issue #548) -- un cambio en un evento persistido debe redesplegar esta
      # imagen igual que un cambio en el propio worker. El '*' de en medio NO cruza '/' (verificado
      # contra la cheat sheet de patrones de paths de GitHub Actions,
      # docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions): el patron
      # cubre cada <RootNamespace>.{Dominio}.DomainEvents/ presente y futuro sin enumerar
      # dominios, sin colar accidentalmente ningun otro directorio de src/.
      - 'src/<RootNamespace>.*.DomainEvents/**'
      # global.json (issue #452/#454): el Dockerfile fija el SDK de la etapa 'build' sobre un tag
      # flotante (mcr.microsoft.com/dotnet/sdk:10.0, ver la nota del Paso 2 de este agente); el
      # 'rollForward' de este archivo decide si ese SDK resuelve o revienta el build de la imagen.
      - 'global.json'
      # Este propio workflow (issue #454): sin incluirse a si mismo, ni el commit que lo crea ni
      # un ajuste posterior al pipeline disparan solos -- hay que lanzarlos a mano.
      - '.github/workflows/deploy-projections.yml'
      # Exclusiones deliberadas -- no las agregues buscando simetria con deploy-{kebab}.yml:
      # - <SolutionFile>: el Dockerfile compila el .csproj del worker directo (dotnet build/publish
      #   "<RootNamespace>.Projections.csproj"), nunca la solucion completa; un cambio al .slnx por
      #   OTRO dominio no altera esta imagen.
      # - tests/<RootNamespace>.Projections.Tests/**: un cambio de tests no altera la imagen que se
      #   publica, y cada publicacion ya reinicia el daemon (revision nueva) sin importar si algo
      #   cambio en el config-test.
      # - infra/environments/<env>/**: tras ceder la imagen a CI (issue #456), Terraform ya no
      #   gobierna la imagen del Container App -- un cambio de infra no implica imagen nueva, y
      #   viceversa.
      # - src/<RootNamespace>.PublicEvents/** y src/<RootNamespace>.PrivateEvents/** (issue #552,
      #   MEF-ADR-0039 decision 2): el worker NUNCA referencia estos dos ensamblados -- tres islas,
      #   solo el Function App de cada dominio los referencia (MEF-ADR-0039 secciones 2 y 4).
      #   Agregarlos aqui redesplegaria el worker por un cambio que no le afecta.
  workflow_dispatch:

# Piso para los jobs que no declaran los suyos. Los permisos de un job reemplazan por completo
# a los del workflow (GitHub Docs, "Assigning permissions to jobs"), asi que las concesiones
# del job publish (id-token: write) siguen vigentes.
permissions:
  contents: read

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: '10.0.x'

      - name: Restore
        run: dotnet restore <SolutionFile>

      - name: Build
        run: dotnet build <SolutionFile> --no-restore --configuration Release

      - name: Test
        # 'dotnet test --project <ruta>', nunca una ruta posicional: con la seccion 'test' de
        # global.json ("runner": "Microsoft.Testing.Platform") el CLI corre en modo MTP, cuya
        # sinopsis solo admite --project/--solution/--test-modules -- una ruta posicional se
        # reenvia a la app de test y aborta antes de correr un solo test ([dotnet test with
        # MTP](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp), issue #253).
        # Sin --ignore-exit-code 8 (a diferencia del loop de deploy-{kebab}.yml, que recorre
        # proyectos que pueden estar vacios): este proyecto siempre trae al menos el config-test
        # base, asi que un exit 8 ("cero tests") aqui es una senal real, no ruido a silenciar.
        run: dotnet test --project tests/<RootNamespace>.Projections.Tests/ --no-build --configuration Release

  publish:
    needs: build-and-test
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # requerido para el login OIDC de azure/login (sin secret) - MEF-ADR-0022
      contents: read    # requerido por actions/checkout cuando se declara 'permissions'
    steps:
      - uses: actions/checkout@v7

      - name: Azure Authentication
        uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Instalar la extension containerapp del Azure CLI
        # 'az containerapp' vive en una extension que el runner de GitHub NO trae preinstalada
        # (Microsoft Learn, "Tutorial: Build and deploy your app to Azure Container Apps": "install
        # or update the Azure Container Apps extension for the CLI"). Instalarla explicitamente
        # evita depender del dynamic install del CLI, cuyo default es 'yes_prompt' -- un prompt
        # que en un runner sin TTY no es un mecanismo sobre el que quieras apoyar el deploy.
        run: az extension add --name containerapp --upgrade

      - name: Resolver el Container Registry
        id: acr
        run: |
          # El nombre del registry se resuelve en runtime con 'az acr list' sobre el resource
          # group (deterministico), no se hornea aqui: los entornos anteriores al issue #730 lo
          # tienen con sufijo aleatorio y los nuevos con el patron CAF de MEF-ADR-0045, y este
          # paso funciona igual en los dos -- nunca 'terraform output' (este workflow no ejecuta
          # Terraform, MEF-ADR-0022).
          set -euo pipefail
          LOGIN_SERVER=$(az acr list --resource-group rg-{prefix} --query "[0].loginServer" -o tsv)
          if [ -z "$LOGIN_SERVER" ]; then
            echo "No se encontro ningun Container Registry en el resource group rg-{prefix}." >&2
            exit 1
          fi
          echo "login_server=$LOGIN_SERVER" >> "$GITHUB_OUTPUT"

      - name: Login al Container Registry
        run: az acr login --name "$(cut -d. -f1 <<< '${{ steps.acr.outputs.login_server }}')"

      - name: Build de la imagen
        # Build context = raiz del repo (no la carpeta del proyecto): el Dockerfile del worker
        # necesita ver tambien src/<RootNamespace>.ReadModels/ y cada
        # src/<RootNamespace>.{Dominio}.DomainEvents/ para resolver sus ProjectReference (Paso 1b
        # de este agente / Paso 3b de domain-scaffolder, MEF-ADR-0039).
        #
        # --build-arg SOURCE_REVISION_ID (issue #462, MEF-ADR-0031 seccion read-side): reutiliza el
        # MISMO '${{ github.sha }}' con el que esta misma imagen ya se taggea abajo -- por
        # construccion, el tag del ACR y el 'service.version' que reporta la telemetria (Paso 1d)
        # quedan identicos, sin tabla de traduccion. Es 'github.sha' A SECAS, NO la expresion
        # '${{ github.event.workflow_run.head_sha || github.sha }}' que hornea deploy-{kebab}.yml
        # (domain-scaffolder, MEF-ADR-0031): este workflow no se encadena por 'workflow_run' (nota
        # "Sin encadenar tras Infra CD" mas abajo) -- su trigger es 'push'/'workflow_dispatch' --,
        # asi que 'github.event.workflow_run.head_sha' seria siempre nulo aqui y esa expresion mas
        # larga solo sugeriria un encadenamiento que no existe.
        run: |
          docker build \
            -f src/<RootNamespace>.Projections/Dockerfile \
            -t "${{ steps.acr.outputs.login_server }}/projections:${{ github.sha }}" \
            --build-arg SOURCE_REVISION_ID=${{ github.sha }} \
            .

      - name: Publicar la imagen
        # Tag por SHA del commit, nunca solo 'latest': es lo unico que garantiza una revision
        # nueva del Container App en cada publicacion (revision-scope change) -- y una revision
        # nueva es lo unico que hace que el contenedor relea un secreto rotado (ver cabecera).
        run: docker push "${{ steps.acr.outputs.login_server }}/projections:${{ github.sha }}"

      - name: Actualizar la revision del Container App
        run: |
          az containerapp update \
            --name ca-projections-{prefix_func} \
            --resource-group rg-{prefix} \
            --image "${{ steps.acr.outputs.login_server }}/projections:${{ github.sha }}"

      - name: Esperar la revision lista con la imagen del SHA publicado
        # Poll acotado (issue #2474, MEF-ADR-0031 seccion 5): en modo Single la revision vieja
        # sigue activa hasta que la nueva esta lista, y 'properties.template.containers[0].image'
        # del Container App devuelve lo que 'update' acaba de escribir, no lo que corre. Exito
        # solo si latestReadyRevisionName == latestRevisionName y la imagen de esa revision es
        # exactamente la del SHA. 120 intentos x 5 s = 10 min.
        run: |
          set -euo pipefail
          ESPERADA="${{ steps.acr.outputs.login_server }}/projections:${{ github.sha }}"
          PLACEHOLDER="mcr.microsoft.com/k8se/quickstart:latest"
          for i in $(seq 1 120); do
            ULTIMA=$(az containerapp show \
              --name ca-projections-{prefix_func} \
              --resource-group rg-{prefix} \
              --query "properties.latestRevisionName" -o tsv)
            LISTA=$(az containerapp show \
              --name ca-projections-{prefix_func} \
              --resource-group rg-{prefix} \
              --query "properties.latestReadyRevisionName" -o tsv)
            if [ -n "$ULTIMA" ]; then
              IMAGEN=$(az containerapp revision show \
                --name ca-projections-{prefix_func} \
                --resource-group rg-{prefix} \
                --revision "$ULTIMA" \
                --query "properties.template.containers[0].image" -o tsv)
              PROVISION=$(az containerapp revision show \
                --name ca-projections-{prefix_func} \
                --resource-group rg-{prefix} \
                --revision "$ULTIMA" \
                --query "properties.provisioningState" -o tsv)
              RUNNING=$(az containerapp revision show \
                --name ca-projections-{prefix_func} \
                --resource-group rg-{prefix} \
                --revision "$ULTIMA" \
                --query "properties.runningState" -o tsv)
              if [ "$PROVISION" = "Failed" ] || [ "$RUNNING" = "Failed" ]; then
                echo "::error::La revision $ULTIMA fallo (provisioningState=$PROVISION, runningState=$RUNNING)."
                exit 1
              fi
              if [ "$IMAGEN" = "$PLACEHOLDER" ]; then
                echo "::error::La revision $ULTIMA sigue en el placeholder tras 'az containerapp update' -- la publicacion no tomo efecto."
                exit 1
              fi
              if [ "$LISTA" = "$ULTIMA" ] && [ "$IMAGEN" = "$ESPERADA" ]; then
                echo "Revision lista $ULTIMA con la imagen $IMAGEN (intento $i)."
                exit 0
              fi
              echo "Intento $i/120: ultima=$ULTIMA lista=${LISTA:-<ninguna>} imagen=$IMAGEN"
            fi
            sleep 5
          done
          echo "::error::Tras 10 min la revision lista no corre la imagen $ESPERADA."
          exit 1
```

> **Autenticacion por OIDC, sin decision pendiente (MEF-ADR-0022).** El job `publish` se autentica con `azure/login` por OpenID Connect -- `permissions: id-token: write` + `client-id`/`tenant-id`/`subscription-id` desde `secrets.AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID` --, **nunca** con el JSON unico `AZURE_CREDENTIALS`. Es el mismo mecanismo que ya emiten los otros cuatro workflows del marco (`domain-scaffolder`, `infra-base-scaffolder`): no hay nada que decidir ni que propagar aqui, sigue una convencion ya establecida.
>
> **Sin encadenar tras `Infra CD` (a diferencia de `deploy-{kebab}.yml`).** `deploy-{kebab}.yml` se encadena tras `infra-cd.yml` via `workflow_run` porque el `apply` de infra puede crear o reemplazar la Function App en cualquier push a `main`, y el codigo nunca debe desplegarse antes de que esa Function App exista. Este workflow no lo necesita: el Container App ya existe desde el primer `apply` que habilito `projections.enabled` (con la imagen placeholder), y el `lifecycle.ignore_changes` del issue #456 hace que un `apply` normal ya no toque su imagen -- no hay ninguna carrera de "el recurso todavia no existe" que un `workflow_run` deba prevenir. El caso residual -- un `apply` que **recree** el Container App (ver el corolario del mismo `ignore_changes`, `infra-base-scaffolder.md`) y lo deje otra vez con el placeholder -- no lo detecta ningun trigger automatico de este workflow: lo cubre `workflow_dispatch` manual, documentado en la cabecera. Si ese caso llegara a ser frecuente en la practica, encadenar por `workflow_run` es una mejora de un issue propio, no algo que este paso deba resolver por adelantado.
>
> **Por que `az acr login` funciona con solo `Contributor` de suscripcion, sin ningun rol de ACR adicional.** El modulo `container-registry` deja `admin_enabled = false` (`infra-base-scaffolder.md`, Paso 1.9.1): la autenticacion es siempre por Microsoft Entra RBAC. Verificado contra Microsoft Learn ("Azure built-in roles for Containers" -- `AcrPull`/`AcrPush`): en el modo por defecto del registry ("RBAC Registry Permissions", el que usa este modulo -- sin ABAC de repositorio), `AcrPull`/`AcrPush` estan definidos como `Actions` de ARM (`Microsoft.ContainerRegistry/registries/{pull,push}/...`), **no** como `DataActions` -- a diferencia del patron de Storage de este mismo marco (`storage_uses_managed_identity`, MEF-ADR-0025), donde `Contributor` si necesita un rol de datos aparte. El SP de CI ya tiene `Contributor` a nivel de suscripcion (`scripts/setup-github-ci.sh`, citado en MEF-ADR-0022/MEF-ADR-0034), y `Contributor` no excluye esas dos acciones en su `NotActions` -- por eso `az acr login`/`docker push` funcionan sin otorgarle ningun rol de ACR adicional a ese SP. No confundir con el rol `AcrPull` que si se le otorga, aparte, a la identidad `UserAssigned` del propio Container App (`infra-base-scaffolder.md`, Paso 2.3b): ese es para que el **Container App** pueda pullear su imagen, un principal distinto del SP de CI que la publica.
>
> **Para quien mantenga este agente -- el filtro de `paths` cubre las dependencias de build, no solo el codigo (mismo principio que `deploy-{kebab}.yml`, issue #454).** Transcribe las rutas y sus comentarios tal cual, incluida la del propio workflow (un filtro de `paths` que no se incluye a si mismo no reacciona ni al commit que lo crea).
>
> **Repos con `deploy-projections.yml` ya generado antes del fix del issue #552**: la idempotencia de este paso (CA-1, "nunca sobrescribir") significa que un workflow ya scaffoldeado se queda **sin** la linea `src/<RootNamespace>.*.DomainEvents/**` para siempre -- este agente no lo reescribe solo. Aplica el mismo parche a mano: agrega esa linea (con su comentario) al bloque `paths` existente, justo despues de `src/<RootNamespace>.ReadModels/**` -- el mismo punto donde este agente la genera hoy.
>
> **Repos con `deploy-projections.yml` ya generado antes del issue #2474**: la idempotencia (CA-1 del issue #453) no regenera el archivo, asi que su ultimo paso sigue siendo "Verificar que la revision activa dejo el placeholder" (lectura unica que no prueba que el worker nuevo corra). Reemplazalo a mano por el paso "Esperar la revision lista con la imagen del SHA publicado" de arriba: poll de 120 intentos de 5 s sobre `latestRevisionName`/`latestReadyRevisionName` (`az containerapp show`) y la imagen de esa revision (`az containerapp revision show`), que solo termina en exito con `latestReadyRevisionName == latestRevisionName` y la imagen exacta `<login_server>/projections:${{ github.sha }}`. El job conserva el nombre `publish`.
>
> **Acoplamiento con la guarda "Esperar deploys ajenos" del smoke (issue #604, MEF-ADR-0031 seccion 4).** Este workflow se llama `Deploy Projections Worker`, asi que matchea el prefijo `Deploy ` con el que la guarda de `smoke-tests-dominio.yml` (`domain-scaffolder`, Paso 6.1) busca los deploys de Function App en vuelo del mismo commit -- pero no despliega ninguna Function App (Container App sin ingress, MEF-ADR-0034) y sus jobs son `build-and-test`/`publish`, ninguno llamado `deploy`. Porque esa guarda **falla** en vez de degradar en silencio cuando un run `Deploy *` no expone un job `deploy`, excluye este workflow por su `path` exacto (`.github/workflows/deploy-projections.yml`). Dos consecuencias para quien mantenga este agente: (a) si renombras el archivo generado, mueve tambien ese literal en el Paso 6.1 de `domain-scaffolder.md` -- el bloque `[H]` de `scripts/tests/test-guards.sh` falla si la correspondencia se rompe; (b) si algun issue futuro le agrega a este workflow un job de smoke que invoque `./.github/workflows/smoke-tests-dominio.yml` (la tercera clase de invocador de MEF-ADR-0031 seccion 4, hoy solo presente como personalizacion del consumidor de origen), ese job debe conceder `permissions: {contents: read, actions: read}` **a nivel de job** -- sin `actions: read` el run muere en `startup_failure` sin annotation visible, y a nivel de workflow alteraria los permisos de `publish` (`id-token: write`).
>
> **Nombres horneados una sola vez (`rg-{prefix}`, `ca-projections-{prefix_func}`).** Igual que `func-{kebab}-{prefix_func}` en `deploy-{kebab}.yml`, estos dos nombres se resuelven al generar el archivo y quedan literales en el; no se recalculan en runtime ni se leen de un output de Terraform (este workflow no ejecuta Terraform). Si el consumidor cambia `project`/`project_short`/`environment`/`azure_region_short`/`resource_sequence` en `variables.tf` **despues** de que este workflow ya se genero, tiene que editarlo a mano -- la idempotencia de CA-1 (nunca sobrescribir) no lo regenera solo, mismo limite ya aceptado para `deploy-{kebab}.yml`.

> **Verificacion de punta a punta del circuito del SHA (CA-4, issue #462).** Las tres piezas (Dockerfile `ARG SOURCE_REVISION_ID` del Paso 2, `--build-arg` de este paso, y `serviceVersion` del seam de observabilidad del Paso 1d) solo se confirman juntas -- ninguna prueba unitaria las cubre, porque el valor nace en CI y termina en Application Insights. Para verificar tras un deploy real:
>
> 1. Toma el SHA del commit que disparo el run de `publish` (`git rev-parse HEAD` en ese commit, o el mismo valor que ya aparece en el tag de la imagen publicada -- `az acr repository show-tags --name <registry> --repository projections --orderby time_desc --top 1`).
> 2. Consulta ese valor en Application Insights. El atributo de recurso `service.version` **no** se lee como una dimension cualquiera: el exporter lo mapea a la propiedad **Application Version**, columna `application_Version` de las tablas de Logs (Microsoft Learn, "Create and configure Application Insights resources", seccion *Version and release tracking*: para instrumentacion basada en OpenTelemetry esa propiedad se fija *"by using resource attributes"*; la nota equivalente de la configuracion del agente de Java nombra la columna destino, `application_Version`). KQL:
>
>    ```kusto
>    dependencies
>    | where timestamp > ago(30m)
>    | where cloud_RoleName == "<RootNamespace>.Projections"
>    | distinct application_Version
>    ```
>
>    (`traces` sirve igual: la propiedad es del recurso, no del tipo de telemetria. `cloud_RoleName` es el `service.name` que fija el mismo seam, MEF-ADR-0034 seccion 10.)
> 3. Compara: el valor debe ser **exactamente** el SHA del paso 1 -- la misma cadena que el tag de la imagen, sin prefijo de version, porque el seam extrae la subcadena posterior al `+` (Paso 1d). Si coinciden, el circuito esta cerrado de punta a punta.
>
> **Modo de falla a vigilar:** si `application_Version` trae la version desnuda (`1.0.0` -- con pinta de semver en vez de 40 digitos hex), el `--build-arg` no esta llegando al `dotnet publish`: `InformationalVersion` se quedo sin sufijo `+{SHA}` y el seam degrada a esa version por diseno. Revisa, en este orden, que este paso pase `--build-arg SOURCE_REVISION_ID=${{ github.sha }}`, que el Dockerfile declare el `ARG` en la etapa `publish` (Paso 2) y que el seam (Paso 1d) siga extrayendo el `AssemblyInformationalVersionAttribute` sin haber sido editado a mano. Es el unico modo de falla silencioso posible del circuito: o el SHA aparece completo, o aparece la version desnuda -- nunca un valor a medias (el target de MSBuild no deja un `+` colgante con `SourceRevisionId` vacio, ver la nota del Paso 2). Y si la columna viene **vacia o ausente** el sospechoso no es el `--build-arg` sino el seam: no corrio (`Program.cs` sin `ConfigurarObservabilidad()`, Paso 1d punto 3) o alguien le paso `serviceVersion: null`, que omite el atributo del recurso.

---

## Paso 3 - Agregar a la solucion y verificar `global.json` (CA-3, CA-4)

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
dotnet sln <SolutionFile> add "src/<RootNamespace>.Projections/"
dotnet sln <SolutionFile> add "src/<RootNamespace>.ReadModels/"
dotnet sln <SolutionFile> add "tests/<RootNamespace>.Projections.Tests/"
```

`dotnet sln add` es idempotente por si mismo: si el proyecto ya esta referenciado, no duplica la entrada (CA-5 issue #367 / CA-4 issue #375) -- seguro invocarlo siempre, sin gate previo, para los tres proyectos.

**Verificar `global.json`:** mismo requisito que `domain-scaffolder` (.NET 10 + xunit v3 mtp-v2 exige la seccion `test` para que `dotnet test` funcione en todo el repo, incluido `<RootNamespace>.Projections.Tests`). Lee `global.json` en `$REPO_ROOT`. Si no existe, crealo. Si existe, verifica que contenga la seccion `test` sin tocar el resto de sus propiedades:

```json
{
    "sdk": {
        "version": "10.0.300",
        "rollForward": "latestFeature"
    },
    "test": {
        "runner": "Microsoft.Testing.Platform"
    }
}
```

---

## Paso 4 - Verificar

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
dotnet build "src/<RootNamespace>.ReadModels/<RootNamespace>.ReadModels.csproj"
dotnet build "src/<RootNamespace>.Projections/<RootNamespace>.Projections.csproj"
dotnet test --project "tests/<RootNamespace>.Projections.Tests/"
```

`--project` no es opcional: con la seccion `test` de `global.json` el CLI corre en modo MTP, que solo admite `--project`/`--solution`/`--test-modules` -- una ruta posicional se reenvia a la app de test y aborta sin correr nada (issue #253; `domain-scaffolder` invoca este mismo proyecto igual, en su Paso 3b punto 6). Es la forma que tambien debe llevar el step `Test` del workflow del Paso 2b.

Si algun build falla, lee el error, corrige y vuelve a intentar. Si `dotnet test` falla, corrige el config-test base antes de continuar -- CA-5 exige que `Projections.Tests` pase en verde con el seam base, sin ninguna proyeccion de dominio todavia. **No hagas commit hasta que los tres pasen.**

**Verificacion mecanica de MEF-ADR-0039 decision 4 (CA-4, issue #552) -- obligatoria, no opcional (a diferencia de la validacion de Docker de abajo).** Tras el Paso 1b, **toda** `ProjectReference` del `.csproj` del worker debe resolver a un `*.DomainEvents.csproj` o a `ReadModels.csproj` (decision 2) -- ninguna al `.csproj` de un Function App (`src/<RootNamespace>.{Dominio}/<RootNamespace>.{Dominio}.csproj`). Es **el mismo comando** que corre `domain-scaffolder` en su Paso 3b punto 4 (issue #548): transcribelo igual, no lo reescribas -- las dos verificaciones de la misma regla del ADR deben tener una sola forma, y esta ya trae resueltos los tres detalles que se listan debajo.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
CSPROJ="$REPO_ROOT/src/<RootNamespace>.Projections/<RootNamespace>.Projections.csproj"
if [ ! -f "$CSPROJ" ]; then
  echo "ERROR: no existe $CSPROJ -- detente aqui, no hagas commit, informa al usuario"
else
  INTRUSOS=$(grep -o '<ProjectReference[^>]*Include="[^"]*"' "$CSPROJ" \
    | grep -v -e '\.DomainEvents\.csproj"$' -e 'ReadModels\.csproj"$')
  if [ -n "$INTRUSOS" ]; then
    echo "VIOLACION MEF-ADR-0039 decision 4 -- referencias no permitidas en el worker:"
    echo "$INTRUSOS"
    echo "detente aqui, no hagas commit, informa al usuario"
  else
    echo "OK: el worker solo referencia *.DomainEvents.csproj y ReadModels.csproj"
  fi
fi
```

Es la materializacion, del lado de este agente, de la prohibicion mecanicamente verificable que fija MEF-ADR-0039 seccion 10 punto 2 ("ningun `.csproj` de `<RootNamespace>.Projections` contiene una `<ProjectReference>` hacia el `.csproj` de ningun `<RootNamespace>.{Dominio}`"). **Se afirma como allowlist, no como blacklist**: prohibir por nombre los Function Apps conocidos dejaria pasar en silencio una referencia a `PublicEvents`/`PrivateEvents`, que la decision 2 tambien prohibe en el read-side (tres islas). Si esto dispara, la causa mas probable es una edicion manual posterior o un agente distinto de este que agrego la referencia por error: **nunca** la "arregles" quitando el assert -- el objetivo es que la referencia prohibida no exista, no que la verificacion pase.

Tres detalles del comando que no debes simplificar al transcribirlo (los mismos que documenta `domain-scaffolder`): el `test -f` previo esta porque un `grep` sobre un archivo inexistente sale con codigo 2, y la forma corta `grep ... && echo VIOLACION || echo OK` imprimiria "OK" en ese caso -- un falso verde justo antes del commit; el filtro **ancla en el sufijo `.csproj"$`** y nunca compara el nombre del proyecto de forma exacta, porque el valor de `Include` es una ruta **relativa** cuyo separador depende de quien la escribio (las plantillas de este marco usan `\`, p. ej. `..\<RootNamespace>.ReadModels\<RootNamespace>.ReadModels.csproj`) -- un `basename` o un `case` contra el nombre pelado no recorta un separador `\`, marcaria como intrusa la referencia legitima a `ReadModels` y detendria al agente sin commit por un falso positivo; y el comando es line-based: si algun `ProjectReference` quedo partido en varias lineas (`dotnet add reference` nunca lo hace, pero una edicion a mano si), reformatealo a una sola linea antes de correrlo.

Valida tambien el Dockerfile (opcional, no bloqueante) con el script distribuido, que solo actua si `docker` esta instalado **y su daemon responde**, escribe su log bajo el estado del pipeline del repo activo y reporta el exit code del build:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/validate-dockerfile.sh" src/<RootNamespace>.Projections/Dockerfile
```

Si `docker` no esta disponible, informa al usuario y deja esta validacion como pendiente manual explicito (nunca la reportes como exitosa). La primera corrida descarga las imagenes `dotnet/sdk:10.0` y `dotnet/runtime:10.0` (varios cientos de MB): si tarda o falla por red, tratala igual que "no disponible" -- no bloquea el commit.

Ese `docker build` ya corre con el `.dockerignore` del Paso 2a en efecto, y es la **unica** verificacion real de que ninguna de sus lineas excluye algo que el build si necesita (`global.json`, los `.csproj` que la capa de restore resuelve -- `Projections`, `ReadModels` y cada `{Dominio}.DomainEvents` adoptado, issue #552 -- y los `.cs` de esos proyectos). Si falla con un archivo o proyecto no encontrado, el sospechoso es una exclusion de mas del Paso 2a, no el Dockerfile: revisa el `.dockerignore` antes de tocar nada de la etapa `build`.

---

## Paso 5 - Commit

Nunca trabajes contra `main` directo. Si la rama activa es `main`, crea una rama nueva primero:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
git rev-parse --abbrev-ref HEAD
# si es main/master:
git switch -c projections/scaffold-worker
git add "src/<RootNamespace>.Projections/" "src/<RootNamespace>.ReadModels/" "tests/<RootNamespace>.Projections.Tests/" "<SolutionFile>"
[ -f global.json ] && git add global.json
[ -f .dockerignore ] && git add .dockerignore
[ -f .github/workflows/deploy-projections.yml ] && git add .github/workflows/deploy-projections.yml
git commit -m "scaffold(projections): generar el worker de proyecciones, ReadModels y el config-test base (Program.cs + seam base + seam de observabilidad + Dockerfile + .dockerignore + AssertOpcionesDeEvento + deploy-projections.yml)"
```

(Si te invoco desde un pipeline que ya creo un worktree y rama, commitea en esa rama sin crear otra.)

---

## Paso 6 - Reportar

Imprime un resumen claro:

- **Proyecto worker**: creado u omitido (ya existia, csproj respetado).
- **`Program.cs`** y **`Infraestructura/ConfiguracionMartenProjections.cs`**: creados u omitidos.
- **`Infraestructura/ConfiguracionObservabilidadProjections.cs`** (issue #457, sampler MEF-ADR-0038 issue #513, supresion selectiva de metricas MEF-ADR-0038 seccion 10 issue #778): creado, omitido (ya existia con la supresion de metricas puesta -- nunca sobrescrito) o **omitido con reposicion aditiva de los dos bloques de metricas** (seam preexistente que no los tenia, Paso 1d "Hueco conocido"). Al reportarlo, describe lo que la vista hace -- conserva la familia GC y descarta cualquier otro instrumento que pase por ella -- y **nunca** afirmes que "nada mas se exporta": `_APPRESOURCEPREVIEW_` sigue siendo gate abierto de medicion en MEF-ADR-0038 seccion 10. Reporta los demas artefactos del Paso 1d **por separado**, con su propio gate cada uno: los dos `PackageReference` (`OpenTelemetry.Extensions.Hosting` 1.17.0, `Azure.Monitor.OpenTelemetry.Exporter` 1.8.3) agregados al `.csproj` del worker o ya presentes, el `PackageReference OpenTelemetry.Exporter.InMemory` 1.17.0 agregado al `.csproj` de `Projections.Tests` o ya presente (Paso 1d punto 1b), la linea de `Program.cs` (`.ConfigurarObservabilidad()`) agregada o ya presente, **`Infraestructura/SamplerQueDescartaPollingDelDaemon.cs`** creado u omitido (ya existia -- nunca sobrescrito) y **`ConfiguracionObservabilidadProjectionsTests.cs`** creado u omitido (ya existia -- nunca sobrescrito, incluye ahora los guardrails (e)/(f) de la supresion selectiva de metricas). Si el seam existia pero tuviste que cerrar alguno de los demas, dilo explicitamente: es la senal de una corrida anterior interrumpida.
- **Proyecto `<RootNamespace>.ReadModels`**: creado u omitido (ya existia), sin ningun `PackageReference` a Marten; carpetas de dominio creadas en `ReadModels` (lista de dominios detectados) o ninguna (sin dominios registrados todavia); carpetas espejo creadas en la raiz del worker para esos mismos dominios (o ninguna); `ProjectReference` del worker hacia `ReadModels` verificada.
- **Proyecto `<RootNamespace>.Projections.Tests`**: creado u omitido (ya existia); helper `AssertOpcionesDeEvento` y config-test base creados u omitidos.
- **`Dockerfile`**: creado u omitido. Si se creo, la capa de restore usa `COPY --parents` sobre `src/<RootNamespace>.*/*.csproj` (Paso 2, issue #552) -- generica sobre N dominios presentes y futuros, sin enumerar ningun dominio por nombre.
- **`.dockerignore`** (Paso 2a, issue #458): creado u omitido (ya existia -- nunca sobrescrito). Se reporta con gate propio, independiente del Dockerfile: si el Dockerfile ya existia (Paso 2 omitido) pero el `.dockerignore` faltaba, dilo explicitamente -- es el consumidor al que este issue esta cerrandole el hueco. Verificado **sin cambios** frente al issue #552: sus exclusiones explicitas (bin/obj, secretos, IDE) ya admiten los `{Dominio}.DomainEvents` nuevos sin ningun ajuste (CA-5).
- **Referencias del worker a `{Dominio}.DomainEvents`** (CA-3, issue #552): lista de dominios cuya `ProjectReference` se verifico o agrego, y de dominios detectados sin `{Dominio}.DomainEvents` todavia (pendiente, se cierra en una proxima corrida de este agente o de `domain-scaffolder`).
- **Verificacion de MEF-ADR-0039 decision 4** (CA-4, issue #552, Paso 4): resultado de la verificacion mecanica de que ninguna `ProjectReference` del worker resuelve a un Function App.
- **`.github/workflows/deploy-projections.yml`** (issue #453): creado u omitido (ya existia); si se creo, su filtro `paths` incluye `src/<RootNamespace>.*.DomainEvents/**` (issue #552) -- si se omitio por preexistencia, recuerda la nota de parche manual del Paso 2b; si se omitio por falta de `infra/environments/dev/variables.tf`, reportalo como **pendiente** e indica que hace falta correr `/infra-base` primero.
- **`<SolutionFile>`**: los tres proyectos agregados (o ya estaban).
- **`global.json`**: seccion `test` creada, ya presente, o archivo creado desde cero.
- Resultado de `dotnet build` de los tres proyectos, de `dotnet test` sobre `Projections.Tests` (y de `docker build`, si corriste la validacion).
- **Siguiente paso**: `domain-scaffolder` (issue #370) registra el named store de cada dominio que adopte proyecciones, agregando su seam `ConfiguracionMartenProjections{Dominio}` y la llamada correspondiente dentro de `ConfiguracionMartenProjections.ConfigurarEventos`. Las carpetas por dominio (en `ReadModels` y en la raiz del worker) las crea este agente para los dominios que ya existan; un dominio que nazca **despues** no las recibe -- las crea `projection-implementer` al escribir su primer archivo, o este agente si vuelve a correr. `projection-test-writer`/`projection-implementer` (issue #365) agregan sobre `Projections.Tests` las guardas 1 y 2 de `config-test.md` por cada dominio (la guarda 3 ya la cubre el helper `AssertOpcionesDeEvento` que dejaste). Los modulos Terraform del Container App (`container-registry`/`container-app-environment`/`container-app`) son opt-in de `infra-base-scaffolder` (issue #368, MEF-ADR-0034 seccion 8) -- vuelve a correrlo con el token ya habilitado para generarlos; si `deploy-projections.yml` quedo pendiente por esa misma razon, vuelve a correr este agente despues.

## Reglas absolutas

1. **NUNCA** sobrescribas `Program.cs`, `Infraestructura/ConfiguracionMartenProjections.cs`, `Infraestructura/ConfiguracionObservabilidadProjections.cs`, `Infraestructura/SamplerQueDescartaPollingDelDaemon.cs`, el config-test base de `Projections.Tests` ni `ConfiguracionObservabilidadProjectionsTests.cs` si ya existen (CA-5 issue #367, CA-4 issue #375, CA-4 issue #457, issue #513): pueden llevar registros de dominio agregados por `domain-scaffolder`, guardas agregadas por `projection-test-writer` o ajustes de observabilidad agregados a mano. Omitelos y reportalo. **"No sobrescribir" no es "no tocar nunca"**: esta regla prohibe reescribir el archivo o pisar lo que ya hay, no las inserciones **aditivas** que la receta enumera una por una -- la linea `.ConfigurarObservabilidad()` de `Program.cs` (Paso 1d punto 3) y la reposicion de los dos bloques de metricas sobre un seam preexistente que no los tiene (Paso 1d, "Hueco conocido", issue #778) son las unicas dos, y ambas se reportan como tales. Cualquier otra edicion sobre estos archivos si esta prohibida.
2. **NUNCA** registres un named store de dominio (`AddMartenStore<I{Dominio}ProjectionStore>`) ni ningun tipo de read model o clase de proyeccion concreta (CA-6): eso es alcance exclusivo de `domain-scaffolder` (issue #370) y de `projection-implementer` (issue #365). Las carpetas de dominio que crees en `ReadModels` y en la raiz del worker quedan vacias (solo un `.gitkeep`).
3. **NUNCA** wirees Azure Service Bus, Wolverine, `IPrivateEventSender`/`IPublicEventSender` en este worker (MEF-ADR-0034 seccion 4): el daemon lee eventos directo de Postgres, no consume mensajes de ningun bus.
4. **NUNCA** agregues al helper `AssertOpcionesDeEvento` ni al config-test base ninguna asercion sobre un dominio concreto (guardas 1 y 2 de `config-test.md`): esas dependen de un named store real y son alcance de `projection-test-writer` (issue #365), no de este scaffold base.
5. **NUNCA** generes ni edites ningun archivo Terraform: los 3 modulos opt-in del Container App (MEF-ADR-0034 seccion 8) son alcance de `infra-base-scaffolder` (issue #368), no de este agente.
6. **NUNCA** agregues un bloque `EXPOSE` al Dockerfile ni ninguna configuracion de ingress: el Container App corre sin ingress (MEF-ADR-0034 seccion 8).
7. **NO** termines sin que `dotnet build` de los tres proyectos y `dotnet test` de `Projections.Tests` pasen.
8. **NUNCA** sobrescribas `.github/workflows/deploy-projections.yml` si ya existe (CA-1 issue #453): mismo patron de idempotencia que `infra-cd.yml`/`smoke-tests*.yml`. Omitelo y reportalo.
9. **NUNCA** hagas que ese workflow ejecute Terraform (`terraform output`, `terraform apply`, etc.) ni encadenes su trigger tras `Infra CD` con `workflow_run` (decision tomada al refinar el issue #453, ver la nota "Sin encadenar tras `Infra CD`" del Paso 2b): el `ignore_changes` del issue #456 ya evita que un `apply` normal revierta la imagen, y el caso residual (un `apply` que recree el Container App) se cubre documentandolo en la cabecera, no encadenando el workflow.
10. El sampler de `ConfiguracionObservabilidadProjections` es **MECANISMO del marco, no opt-in** (MEF-ADR-0038 secciones 1 y 5 y MEF-ADR-0034 seccion 10 punto 4 -- invierten parcialmente la regla anterior de este agente, que prohibia instalar cualquier sampler, CA-5 issue #457): `SetSampler(new SamplerQueDescartaPollingDelDaemon(new ParentBasedSampler(new TraceIdRatioBasedSampler(ratio))))`, siempre en el segundo `.WithTracing(...)` posterior a `UseAzureMonitorExporter()` (Paso 1d puntos 2/2b). **NUNCA** quites el filtro del daemon (`SamplerQueDescartaPollingDelDaemon`) ni inviertas su anidamiento: el filtro por nombre debe ser el sampler MAS EXTERNO, con `ParentBasedSampler(TraceIdRatioBasedSampler(ratio))` como su interno -- invertirlo no rompe el build, pero si rompe el guardrail (a) del config-test de observabilidad (Paso 1d punto 4), que fija tanto el tipo del sampler efectivo como el literal exacto de su `Description`. **NUNCA** quites el flip `EnableTraceBasedLogsSampler = false` de `UseAzureMonitorExporter(...)` (Paso 1d punto 2, MEF-ADR-0038 seccion 9, issue #680) ni lo conviertas en opcion del consumidor (variable de entorno, parametro del seam, etc.): es mecanismo del marco exactamente igual que el filtro del daemon de arriba -- sin el, `LogFilteringProcessor` descarta los `LogError` que el daemon emite dentro del span de polling que el sampler de trazas ya descarta (medido: 35/35 perdidos, Bitakora.ControlAsistencia). Quitarlo no rompe el build, pero si rompe el guardrail (d) del config-test de observabilidad (Paso 1d punto 4). Lo unico que sigue siendo **VALOR del consumidor** son dos ejes ahora independientes: el ratio de trazas (`TELEMETRY_SAMPLING_RATIO`, default `1.0`) y el nivel de `ILogger` (filtering estandar de .NET, `appsettings.json`), que a partir de este flip es el unico control de volumen de logs que le queda al consumidor. **NUNCA** hagas que el seam lea o reciba `APPLICATIONINSIGHTS_CONNECTION_STRING`: la resuelve el propio exporter -- bajo el overload de opciones, via la `IConfiguration` que el `Host.CreateApplicationBuilder` del Paso 1a puebla desde las variables de entorno (MEF-ADR-0025, MEF-ADR-0038 seccion 9). La supresion selectiva de metricas (`EsMetricaDeGC` + `.WithMetrics(...)`, Paso 1d punto 2, MEF-ADR-0038 seccion 10) es **MECANISMO del marco, no opt-in**, misma categoria que el sampler del daemon y el flip de logs de arriba: **NUNCA** reemplaces la unica vista func-based por un par de dos `AddView` (fan-out, no *first-match-wins* -- rompe el guardrail (e)/(f) del config-test de observabilidad, Paso 1d punto 4) ni conviertas la familia GC en una lista configurable por el consumidor (variable de entorno, parametro del seam): la seccion 10 del ADR fija una lista cerrada de 3 nombres, no una politica de costos que el consumidor decida. **NUNCA** quites el fallback `PostConfigure<AzureMonitorExporterOptions>` (Paso 1d punto 2) ni lo condiciones a un ambiente: a diferencia del `TracerProvider`, el metric reader de `Azure.Monitor.OpenTelemetry.Exporter` construye su exporter de forma sincronica al resolver el `MeterProvider` y lanza sin connection string disponible, incluso con todo el trafico de metricas en `Drop`.
11. **NUNCA** sobrescribas el `.dockerignore` de la raiz del repo consumidor si ya existe (CA-5 issue #458, Paso 2a): puede llevar exclusiones que el consumidor agrego a mano. Omitelo y reportalo. Su contenido es byte-fijo -- transcribelo literal, sin normalizar espacios, orden ni comentarios (mismo criterio que la regla final 12 de `infra-base-scaffolder` para el `.gitignore` raiz), sustituyendo unicamente el `<RootNamespace>` de sus dos comentarios de cabecera. **NUNCA** anides este paso bajo el gate del Dockerfile (Paso 2): su probe de idempotencia es independiente y corre siempre, exista o no el Dockerfile todavia. **NUNCA** excluyas ahi `src/`, `tests/` ni ningun `.csproj`/`.cs` (decision del issue #458: se excluyen artefactos, nunca proyectos -- el worker puede llegar a referenciar el assembly de un dominio, MEF-ADR-0034 seccion 5), ni conviertas la lista en una allowlist (`*` + reinclusiones): un `Directory.Build.props`/`nuget.config` que un scaffolder futuro emita en la raiz romperia el build en silencio.
12. **NUNCA** enumeres un dominio por nombre en la capa de restore del Dockerfile (`COPY --parents`, Paso 2, CA-1 issue #552): el patron `src/<RootNamespace>.*/*.csproj` debe seguir siendo generico -- nunca edites el Dockerfile cuando nace o se agrega un dominio nuevo. Esa evolucion la cierran los bucles idempotentes del Paso 1b (CA-3), nunca este archivo. **NUNCA** quites la directiva `# syntax=docker/dockerfile:1` de la primera linea ni la muevas debajo de un comentario o de una linea en blanco: sin ella el frontend no expone `--parents`, y degradada a comentario el fallo no se ve hasta el `docker build`.
13. **NUNCA** dejes pasar sin commit una `ProjectReference` del worker hacia un Function App (Paso 4, CA-4, issue #552, MEF-ADR-0039 decision 4 / seccion 10): si la verificacion mecanica falla, detente e informa -- no la "arregles" quitando el assert ni edites el `.csproj` para silenciarla.
