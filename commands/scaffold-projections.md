---
description: "Genera el worker de proyecciones, ReadModels, el config-test base y el workflow de deploy delegando en projections-scaffolder, solo si projections.enabled esta habilitado."
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/scaffold-projections.md. No editar a mano. -->
```bash
mefisto_claude_root=''
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
            printf '%s\n' 'ERROR Claude: metadata del marker canonico invalida; reabra o reinstale el plugin.' >&2; exit 1
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
                printf '%s\n' 'ERROR Claude: metadata del marker Claude invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
            if [ "$mefisto_claude_cursor" = / ]; then break; fi
            mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"
        done
    fi
fi
if [ -z "$mefisto_claude_root" ]; then
    printf '%s\n' 'ERROR Claude: no se encontro una raiz Claude valida; reabra o reinstale el plugin.' >&2
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
```

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Genera el worker de proyecciones `<RootNamespace>.Projections` (daemon asincronico `HotCold` de Marten, seam de observabilidad `ConfiguracionObservabilidadProjections` con el sampler que descarta el polling del daemon, MEF-ADR-0038), la biblioteca `<RootNamespace>.ReadModels`, el config-test base `<RootNamespace>.Projections.Tests`, el workflow de deploy `deploy-projections.yml` y el `.dockerignore` del build context delegando en el agente `projections-scaffolder`, al estilo de `infra-base-scaffolder`. **Alcance acotado (fase 1, issue #367 + fase 2, issue #375 + fase 3, issue #453 + fase 4, issue #457 + fase 5, issue #458 + fase 6, issue #513 + fase 7, issue #552)**: el registro del store de cada dominio lo hace `domain-scaffolder` (issue #370); ninguna proyeccion ni read model concreto se genera aqui (issues `tipo:projection`). Comunicate en **espanol**.

## Pre-condicion: token `projections.enabled` (CA-1)

El worker solo se genera si el BC declaro explicitamente que adopta proyecciones. El token vive en el contrato canonico `.mefisto/harness.config.json` bajo `projections.enabled` y se lee desde `${MEFISTO_CONFIG_PATH}` (MEF-ADR-0053, decision 4). El mecanismo de deteccion lo fija MEF-ADR-0034 (seccion 8); su contrato formal completo lo fija el issue #369. Este comando consume el token en la forma minima que necesita (no pasa por `load_harness_config`, que requiere `boundedContext` obligatorio y otros campos que aqui no hacen falta).

```bash
node "${MEFISTO_PACKAGE_ROOT}/scripts/json-value.mts" get "${MEFISTO_CONFIG_PATH}" projections.enabled 2>/dev/null
```

Sin `--default` ni `--or-empty`: los dos tratan `false` igual que un valor ausente y confundirian `deshabilitado` con `ausente`.

- Si imprime `true`, el gate pasa: continua.
- Si imprime `null` o nada, el token esta **ausente**.
- Si imprime cualquier otro valor (por ejemplo `false`), el token esta **deshabilitado** (`projections.enabled = <valor>`).

En ambos casos de fallo, muestra este mensaje (con `ausente` o `deshabilitado` segun corresponda), detente y no lances ningun agente:

```
ERROR: el token 'projections.enabled' esta <ausente | deshabilitado (projections.enabled = <valor>)> en .mefisto/harness.config.json.

Este BC no declaro que adopta el worker de proyecciones (MEF-ADR-0034).
Para habilitarlo, agrega en .mefisto/harness.config.json:

  "projections": { "enabled": true }

(el contrato formal del token, incluida la validacion y el reporte de /mefisto:onboard,
lo fija el issue #369).
```

## Proceso

### 1. Informar que se va a generar

```
Se va a generar el worker de proyecciones y su andamiaje read-side (fase 1,
issue #367 + fase 2, issue #375 + fase 3, issue #453 + fase 4, issue #457 +
fase 5, issue #458 + fase 6, issue #513):

  src/<RootNamespace>.Projections/
    <RootNamespace>.Projections.csproj  (SDK Microsoft.NET.Sdk.Worker)
    Program.cs                          (arma el host, invoca los seams, nada mas)
    Infraestructura/ConfiguracionMartenProjections.cs  (seam base, sin dominios todavia)
    Infraestructura/ConfiguracionObservabilidadProjections.cs  (seam de observabilidad:
                                          service.name obligatorio, AddSource
                                          Marten/Npgsql/propia, UseAzureMonitorExporter
                                          con EnableTraceBasedLogsSampler = false
                                          y el SetSampler posterior a ese exporter)
    Infraestructura/SamplerQueDescartaPollingDelDaemon.cs  (filtro del span de polling
                                          del daemon HotCold, MEF-ADR-0038: envuelve
                                          ParentBasedSampler(TraceIdRatioBasedSampler(
                                          TELEMETRY_SAMPLING_RATIO, default 1.0)))
    Dockerfile                          (imagen sobre runtime, sin ingress)
    {Dominio}/                          (carpeta vacia por dominio ya registrado en el
                                          worker, si aplica -- ahi vive la clase de
                                          proyeccion companion de cada dominio)

  src/<RootNamespace>.ReadModels/       (biblioteca vacia, sin PackageReference a Marten;
                                          una carpeta por dominio ya registrado en el
                                          worker, si aplica -- solo read models planos)

  tests/<RootNamespace>.Projections.Tests/
    Infraestructura/AssertsProyecciones.cs   (helper AssertOpcionesDeEvento)
    ConfiguracionMartenProjectionsTests.cs   (config-test base, sin dominios todavia)
    ConfiguracionObservabilidadProjectionsTests.cs  (guardrails del sampler efectivo:
                                          tipo y Description del sampler que llega al
                                          TracerProvider, cascada daemon -> hijo Npgsql
                                          y nombre del span contra el OtelPrefix de Marten)

  .github/workflows/deploy-projections.yml
                                        (build + test, imagen al ACR del BC y
                                          az containerapp update; solo si el
                                          archivo no existe todavia. Requiere que
                                          infra/environments/dev/variables.tf ya
                                          exista, de donde salen los nombres del
                                          resource group y del Container App: si
                                          falta, el agente lo reporta pendiente y
                                          hay que correr /mefisto:infra-base primero)

  .dockerignore                         (en la RAIZ del repo, que es el build context del
                                          Dockerfile: filtra bin/obj de todos los proyectos,
                                          settings locales, tfstate/tfvars, .terraform y
                                          node_modules -- Docker no lee .gitignore. Gate
                                          propio, independiente del Dockerfile: un repo que
                                          ya tenia Dockerfile tambien lo recibe. Solo si no
                                          existe todavia)

  <SolutionFile>: se agregan los tres proyectos nuevos
  global.json: se verifica/crea la seccion "test"

Este agente NO registra ningun store de dominio (eso lo hace domain-scaffolder,
issue #370) NI escribe ninguna proyeccion o read model concreto (issues
tipo:projection). Es idempotente: re-ejecutar no duplica ni pisa contenido
existente.
```

### 2. Lanzar el agente

Solo despues de que el gate del token haya pasado:

invoca la tool `Task` con el agente `mefisto:projections-scaffolder` y este mensaje: Genera el worker de proyecciones. Espera su resultado final y continua con el paso siguiente del comando.

### 3. Tras terminar

Recuerda al usuario el resto de la cadena de issues relacionados:

```
Worker de proyecciones, ReadModels y config-test base generados. Siguiente:
  1. domain-scaffolder (issue #370) registra el named store de cada dominio que
     adopte proyecciones dentro del seam ConfiguracionMartenProjections (no
     crea carpetas: las de los dominios ya existentes las dejo este scaffold,
     en ReadModels y en la raiz del worker).
  2. projection-test-writer/projection-implementer (issue #365) agregan sobre
     Projections.Tests las guardas por dominio (partial + ciclo de vida Async),
     reutilizando el helper AssertOpcionesDeEvento para la guarda barata de metadata (subconjunto de la
     compatibilidad; la completa la verifica el reviewer bajo gate, MEF-ADR-0034 seccion 6).
  3. Los modulos Terraform del Container App (container-registry,
     container-app-environment, container-app) son opt-in y los genera
     infra-base-scaffolder (via /mefisto:infra-base) cuando corra de nuevo con el token ya habilitado
     (issue #368, MEF-ADR-0034 seccion 8).
  4. deploy-projections.yml solo publica la imagen despues de que infra-cd.yml
     haya sembrado los secretos del Key Vault al menos una vez (MEF-ADR-0034
     seccion 8, documentado en la cabecera del propio workflow). Si el agente lo
     reporto pendiente por falta de infra/environments/dev/variables.tf, corre
     /mefisto:infra-base y vuelve a lanzar este skill: es idempotente.
```

## Reglas

- **No generes nada tu mismo.** Solo valida la pre-condicion del token, informa y delega en el agente.
- El agente nunca registra un store de dominio, un read model concreto ni toca Azure Service Bus (MEF-ADR-0034 seccion 4): esa es responsabilidad de `domain-scaffolder`/`projection-implementer` de cada dominio, no de este comando.
- El agente es idempotente: no sobrescribe `Program.cs`, el seam de composicion, el config-test base ni el `.dockerignore` de la raiz si ya existen (pueden llevar registros o guardas de dominio agregados por `domain-scaffolder`/`projection-test-writer`, o exclusiones que el consumidor sumo a mano).
