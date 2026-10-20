---
description: "Genera el proyecto de un servidor MCP (RootNamespace.Mcp.Proposito) delegando en mcp-scaffolder: identidad, OAuth app-side, Terraform, deploy y SmokeTests."
argument-hint: "<proposito>"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/scaffold-mcp.md. No editar a mano. -->
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
```

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Lanza el agente `mcp-scaffolder`, que genera el proyecto de un servidor MCP (Model Context Protocol) `<RootNamespace>.Mcp.{Proposito}` para el Bounded Context del consumidor -- fases 1, 2, 3 e identidad/OAuth app-side (issues #768/#769/#770/#819): proyecto del servidor, el propagador de identidad tenant/usuario, los componentes OAuth app-side de defensa en profundidad (PRM, validador de token, middleware), tool de ejemplo, endpoints de gate, unit tests base, el Terraform del servidor, el workflow de deploy y la suite SmokeTests e2e con su reusable de CI (MEF-ADR-0047/MEF-ADR-0048). Comunicate en **espanol**.

## Pre-condicion 1: cwd != Mefisto

El guard de consumidor de arriba aborta si el cwd es el repo de Mefisto: este skill es del paquete publicado y solo aplica al repo consumidor. Mefisto no expone servidores MCP sobre si mismo.

## Pre-condicion 2: argumento `<proposito>` (opcional)

`$ARGUMENTS` puede traer el proposito de un servidor adicional (una palabra o frase corta, ej. `auditoria`). Uso, que debes mostrar si el usuario pide ayuda:

```
Uso: /mefisto:scaffold-mcp [<proposito>]

Ejemplos:
  /mefisto:scaffold-mcp              (servidor General del BC)
  /mefisto:scaffold-mcp auditoria    (servidor adicional)

Sin argumento se genera el servidor General del BC (<RootNamespace>.Mcp.General, ruta
/mcp-general): el servidor unico con el que empieza todo BC. Con argumento se genera un
servidor adicional, nombrado por su razon de existir (ej. "auditoria"); solo se crea por
necesidad demostrada (MEF-ADR-0047 decision 2). El nombre queda fijado en la ruta publica y en
la audiencia OAuth, asi que elegirlo bien evita reconectar clientes. Se normaliza a
PascalCase: "auditoria-fiscal" -> "AuditoriaFiscal".
```

- Si `$ARGUMENTS` esta vacio, usa `PROPOSITO_PASCAL=General` y marca `ES_GENERAL=1`.
- Si trae argumento, normaliza `<proposito>` a PascalCase (separa por espacios/guiones, mayuscula inicial de cada palabra, sin separadores) y guardalo como `PROPOSITO_PASCAL`.

No hay ningun caso especial en la mecanica posterior: `General` se trata como cualquier otro proposito.


## Pre-condicion 3: config y tokens del harness

El config se lee desde `${MEFISTO_CONFIG_PATH}` (contrato canonico `.mefisto/harness.config.json`, MEF-ADR-0053, decision 4). Nunca copies, migres ni escribas ese archivo.

```bash
ROOT_NAMESPACE=$(jq -r '.namespacePrefix // ""' "${MEFISTO_CONFIG_PATH}")
SOLUTION_FILE=$(jq -r '.solutionFile // ""' "${MEFISTO_CONFIG_PATH}")

if [ -z "$ROOT_NAMESPACE" ] || [ -z "$SOLUTION_FILE" ]; then
    echo "ERROR: faltan 'namespacePrefix' y/o 'solutionFile' en .mefisto/harness.config.json."
    exit 1
fi
```

Si falta cualquiera de los dos, detente con el mensaje de arriba. Con `ROOT_NAMESPACE` y `PROPOSITO_PASCAL`, el proyecto a generar sera `${ROOT_NAMESPACE}.Mcp.${PROPOSITO_PASCAL}`.

Si invocaste sin argumento (`PROPOSITO_PASCAL=General`) y ya existe `src/${ROOT_NAMESPACE}.Mcp.General/`, detente sin sobrescribir:

```bash
if [ "${ES_GENERAL:-0}" = "1" ] && [ -d "src/${ROOT_NAMESPACE}.Mcp.General" ]; then
    echo "El servidor General del BC ya existe (src/${ROOT_NAMESPACE}.Mcp.General/). Para crear un servidor adicional pasa un proposito: /mefisto:scaffold-mcp <proposito> (MEF-ADR-0047 decision 2)."
    exit 1
fi
```

## Proceso

### 1. Informar que se va a generar

```bash
VERSION=$(jq -r '.version' "${MEFISTO_PACKAGE_ROOT}/mefisto-manifest.json" 2>/dev/null)
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
    VERSION_LABEL="version desconocida"
else
    VERSION_LABEL="v${VERSION}"
fi
```

Este paso es informativo: si el manifiesto falta, `jq` falla o el valor es nulo, `VERSION_LABEL` queda en "version desconocida" y el skill **continua** -- nunca aborta por esto.

Si `ES_GENERAL=1`, antes del bloque siguiente anade la linea: "Sin proposito: se genera el servidor MCP General del BC".

```
Se va a generar el servidor MCP <RootNamespace>.Mcp.{Proposito} con mefisto <VERSION_LABEL> (fases 1, 2, 3 e identidad/OAuth app-side, issues #768/#769/#770/#819):

  src/<RootNamespace>.Mcp.{Proposito}/
    <RootNamespace>.Mcp.{Proposito}.csproj  (cero ProjectReference, cliente HTTP puro)
    host.json                                (extensions.mcp: serverName/instructions)
    Program.cs                               (invoca los seams; cablea el propagador de identidad
                                               siempre, y los componentes OAuth app-side solo si
                                               tenancy.strategy = multi-tenant-header)
    Infraestructura/
      RespuestaJson.cs, ConfiguracionClientesHttp.cs, {Dominio}Api.cs, FiltroDeNombre.cs,
      ConfiguracionObservabilidadMcp.cs
      IdentidadTenant.cs, ConfiguracionIdentidadTenant.cs, PropagadorIdentidadTenantHandler.cs
                                              (propagador de identidad tenant/usuario, siempre
                                               generado, MEF-ADR-0047 decision 6)
      ValidadorTokenAuthKit.cs, AutorizacionMcpMiddleware.cs
                                              (componentes OAuth app-side de defensa en profundidad,
                                               MEF-ADR-0047 decision 7; siempre se generan, pero solo
                                               se cablean en Program.cs si tenancy.strategy =
                                               multi-tenant-header -- en mono-tenant-transitorio
                                               quedan como propuesta, CA-2 de #819)
      ArgumentosCrudosMcpMiddleware.cs        (restaura el texto original de los argumentos string
                                               coercionados a fecha/GUID por la extension MCP;
                                               siempre generado y siempre cableado, sin importar
                                               tenancy.strategy, Azure/azure-functions-mcp-extension#129)
      SesionUsuario.cs, DerivadorIdentidadTenantMcp.cs, IdentidadTenantMcpMiddleware.cs,
      IdentidadTenantMcpMensajes.resx
                                              (identidad derivada del token: org_id -> tenant,
                                               sub -> usuario, rechazo .resx si el Bearer no es
                                               validable; solo con multi-tenant-header, que suma
                                               la ProjectReference a <RootNamespace>.TenantResolver,
                                               MEF-ADR-0047 decisiones 3/6/7, #1934)
    MetadataRecursoProtegido/MetadataRecursoProtegidoFunction.cs
                                              (PRM RFC 9728 anonimo, MEF-ADR-0032 seccion 9)
    VersionCheck.cs / ReadyCheck.cs          (endpoints de gate, MEF-ADR-0048 seccion 3)
    Ejemplo/                                 (tool de ejemplo con el patron completo)
    Sesion/ObtenerSesionTool.cs              (tool obtener_sesion: origen sesion | tenant_fijo;
                                              solo con multi-tenant-header, #1934)
    README.md                                (onboarding del servidor)

  tests/<RootNamespace>.Mcp.{Proposito}.Tests/
    ComposicionDelServidorTests.cs           (nivel 2 de la piramide, MEF-ADR-0048 seccion 1)
    Ejemplo/EjemploListarToolTests.cs         (nivel 1: remodelado con handler falso)
    Infraestructura/PropagadorIdentidadTenantHandlerTests.cs
                                              (headers canonicos en cada request saliente, #819)
    Infraestructura/ValidadorTokenAuthKitTests.cs
                                              (nunca lanza, degrada a "no valido", #819)
    Infraestructura/ArgumentosCrudosMcpMiddlewareTests.cs
                                              (nucleo RestaurarTextoOriginal, nivel 1 sin host)
    Infraestructura/IdentidadTenantMcpMiddlewareTests.cs, Sesion/ObtenerSesionToolTests.cs
                                              (solo multi-tenant-header: el middleware publica
                                               identidad ambiente y sesion sin sembrar el contexto,
                                               rechazos, obtener_sesion en ambos origenes, #1934)

  tests/<RootNamespace>.Mcp.{Proposito}.SmokeTests/
    Fixtures/McpFixture.cs                   (sesion MCP real con ModelContextProtocol.Core)
    Handshake/ ComposicionDelHost/ Ejemplo/ Seguridad/
                                             (nivel 3: las cinco verificaciones canonicas de
                                              MEF-ADR-0048 seccion 2 -- handshake, tools/list
                                              vivo, tool call, error path del .resx, 401 sin key;
                                              con multi-tenant-header suma Identidad/: obtener_sesion
                                              sin Bearer responde origen tenant_fijo, #1934)

  infra/environments/dev/mcp-{proposito-kebab}.tf
    Storage + App Service Plan + Function App dedicados (modulos base del consumidor), con las
    app settings Api__{Dominio}__BaseUrl de los dominios ya scaffoldeados, la identidad interina
    Identidad__TenantIdInterino/Identidad__UserIdInterino (siempre) y Mcp__ResourceUri/
    Mcp__AuthorizationServer (siempre, pero sembrados con un placeholder PENDIENTE-... hasta que
    corras /mefisto:install-apim)
  infra/modules/function-app/main.tf: se agrega el output default_hostname si falta

  .github/workflows/deploy-mcp-{proposito-kebab}.yml
    encadenado por workflow_run tras el apply de infra (MEF-ADR-0022), con el job
    smoke-tests encadenado tras el deploy
  .github/workflows/smoke-tests-mcp.yml
    reusable compartido por los servidores MCP del BC: warmup version+ready, OIDC y la
    key mcp_extension listada en runtime (MEF-ADR-0048 seccion 4)

  <SolutionFile>: se agregan los tres proyectos nuevos
  global.json: se verifica/crea la seccion "test" (xunit v3 mtp-v2)

La suite SmokeTests compila en el CI de PRs pero solo se ejecuta contra el entorno desplegado
(el sufijo .SmokeTests queda fuera del glob tests/*.Tests/). Es idempotente: re-ejecutar no
duplica ni pisa contenido existente.

La lista canonica y autoritativa de artefactos es el parrafo **Alcance** de
`agents/mcp-scaffolder.md`: ante cualquier discrepancia con este resumen, manda el agente.
```

### 2. Lanzar el agente

Solo despues de que el guard y las pre-condiciones hayan pasado:

invoca la tool `Task` con el agente `mefisto:mcp-scaffolder` y este mensaje: Genera el servidor MCP de proposito <PROPOSITO_PASCAL> (el proposito ya normalizado a PascalCase, por ejemplo General o AuditoriaFiscal). Espera su resultado final y continua con el paso siguiente del comando.

### 3. Tras terminar

Responde con:

```
Servidor MCP <RootNamespace>.Mcp.{Proposito} generado. Siguiente:
  1. Reemplaza la tool 'Ejemplo/' por las tools reales de tu BC (lenguaje ubicuo, MEF-ADR-0040)
     y actualiza con ellas los asserts pinneados de la suite SmokeTests.
  2. Revisa y aplica el Terraform generado con /mefisto:infra (el deploy del codigo se encadena solo).
  3. La suite SmokeTests corre por primera vez en el job 'smoke-tests' de ese primer deploy:
     el scaffold solo la compila (todavia no hay servidor desplegado contra el cual correrla).
  4. Onboarding de un cliente MCP: ver el README.md generado en el proyecto del servidor.
```

## Reglas

- **No generes nada tu mismo.** Solo valida las pre-condiciones, informa y lanza el agente.
- El agente es idempotente: no sobrescribe ningun artefacto ya generado (Program.cs, los seams, la tool de ejemplo si ya fue reemplazada, el README) -- ver `mcp-scaffolder.md`.
- Sin argumento el proposito es siempre `General`; nunca inventes otro nombre.
