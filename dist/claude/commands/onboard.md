---
description: "Diagnostica el onboarding del consumidor (config, directivas, labels, CI, auth, proyecciones) y ofrece provisiones opt-in."
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/onboard.md. No editar a mano. -->
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
if [ "${mefisto_claude_loaded#/}" != "$mefisto_claude_loaded" ]; then
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

Diagnostica el onboarding del consumidor: valida el `harness.config.json` efectivo, las directivas canónicas, los labels y el CI, y reporta un checklist de que esta listo y que falta. Presenta ademas la **bifurcacion de dos caminos de auth** (MEF-ADR-0028 + enmienda #337): (A) crecer -- autenticacion orquestada desde el inicio, etapa `multi-tenant-header` -- vs (B) POC -- sin autenticacion, etapa `mono-tenant-transitorio`, el default. Es un **doctor**: por defecto solo diagnostica (no crea ni modifica nada). Como excepciones **opt-in**, si lo confirmas explicitamente puede migrar conservadoramente las directivas contractuales, provisionar los labels faltantes (el script subyacente es destructivo: borra los labels default de GitHub), configurar el CI hacia Azure (crea recursos reales en Azure -- app de Entra, role assignments y federated credential, por OIDC; ver MEF-ADR-0022), escribir/actualizar la estrategia de tenancy vigente (`tenancy.strategy`, MEF-ADR-0028) que materializa el camino elegido, y encadenar `/mefisto:scaffold-projections` (MEF-ADR-0034, issue #369) cuando el BC declara `projections.enabled: true` pero el worker de proyecciones todavia no existe. Comunicate en **espanol**.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Que verifica

`/mefisto:onboard` es el primer corte del onboarding automatizado (el "doctor" diagnostico). Reporta, sin tocar nada:

1. **Configuracion** (`.mefisto/harness.config.json`, con fallback legacy de solo lectura): existencia, parseo con `jq`, campos requeridos (`projectName`, `namespacePrefix`, `solutionFile`, `boundedContext`) y formato de `terraformStateStorage`. La validacion la hace `load_harness_config` del plugin, que es la **unica fuente de verdad** de las reglas del tfstate (`^[a-z0-9]{3,24}$`) y del BC (`name` 1-63 chars; `domains` subconjunto de `domainLabels`). Con el config válido, valida también el **`repoSlug` efectivo** (MEF-ADR-0053 decisión 4, issue #2353): el declarado o, si falta, el default `augusto-romero-arango/mefisto`, destino de los drafts cross-repo y de las releases que busca `/mefisto:upgrade`. Reporta `FALTA` (con la acción de corregirlo o borrarlo) si coincide con el `origin` del propio consumidor, atajo local sin red, o si el manifiesto `plugin.json` del plugin en ese repo no existe o no declara `name: mefisto`; `OK` si lo declara, y `NO VERIFICADO` si `gh` no está instalado, no está autenticado o no hay red. Incluye además la **versión mínima exigida por el adaptador Claude** (MEF-ADR-0055): 2.1.287, la que publicó los mods que declara `hooks/hooks.json`. Reporta `OK` si la versión instalada la cumple, `FALTA` si es menor (con la acción de actualizar) y `NO VERIFICADO` si no se puede leer la versión; bajo cualquier otro runtime es informativa (`INFO`), MEF-ADR-0050/0053. Reporta también la **activación por repositorio** del runtime activo (MEF-ADR-0053 decisión 2): `OK` si los archivos de proyecto commiteados activan Mefisto, `FALTA` si no (con la provisión opt-in del paso 8), y una fila `INFO` si Mefisto todavía se carga en todos los repos desde un nivel global (`/mefisto:upgrade` ofrece retirarlo).
2. **Directivas canónicas del consumidor** (MEF-ADR-0049/0050/0053): comprueba independientemente que `AGENTS.md` tenga las secciones obligatorias "Tokens del harness" y "Verificación de fuentes", con los 5 tokens dentro de la primera (`RootNamespace`, `SolutionFile`, `ProjectDisplayName`, `BoundedContext`, `BoundedContextDomains`), y, según el runtime, el puente `CLAUDE.md`. `AGENTS.md` es la fuente canónica para todos los runtimes; `CLAUDE.md` con una línea independiente exacta `@AGENTS.md` es un **requisito del adaptador Claude** (el diagnóstico lo reporta `FALTA` solo bajo ese runtime) y **informativo bajo OpenCode**, donde no bloquea (MEF-ADR-0050/0053). Si conserva cualquiera de las dos secciones contractuales, reporta `FALTA` y pide limpiarlas manualmente, sin tocar el archivo. Un `CLAUDE.md` legacy legible sigue visible como fallback de migración, pero bajo el adaptador Claude nunca deja el proyecto canónicamente listo. Un archivo existente no legible reporta `NO VERIFICADO`.
3. **Estructura de carpetas esperada** (contrato del harness, punto 3): reporta de forma **informativa** (no bloqueante) la presencia de `src/`, `tests/` e `infra/environments/`. No la marca como `FALTA` cuando falta: un greenfield legitimo aun no tiene estas carpetas antes del primer `/mefisto:scaffold` o `/mefisto:infra-base`, y tratarla como bloqueante daria un falso negativo.
4. **Labels de GitHub** (MEF-ADR-0007): que existan `tipo:*`, `estado:borrador`, `estado:listo`, `dom:<x>` por cada `domainLabels`, mas `bug`, `bloqueado` y `warning`.

   > **Presupuesto de nombres para el scaffold (issue #245, informativo, no verificado aqui):** cada `domainLabels` termina, al scaffoldear, en el nombre de una Function App `func-{kebab}-{prefix_func}`. El limite real es 60 caracteres (`Microsoft.Web/sites`, naming rules de Azure: https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules#microsoftweb), asi que el presupuesto para el `kebab` del dominio es `60 - 5 ("func-") - 1 ("-") - len(prefix_func)` caracteres. `/mefisto:onboard` no lo valida (`prefix_func` vive en `infra/environments/dev/variables.tf`, fuera de `harness.config.json`); la Validacion 1 del Paso 0 de `domain-scaffolder` lo hace al momento de scaffoldear cada dominio.
5. **CI hacia Azure** (MEF-ADR-0022): que exista la aplicacion de Entra / Service Principal y los secrets OIDC del repo. Tolerante: si no hay `az` o sesion, reporta `NO VERIFICADO` en vez de fallar.
6. **Secretos que alimentan la siembra en CI** (MEF-ADR-0025, informativo): que existan en GitHub `TF_VAR_POSTGRESQL_ADMIN_PASSWORD` y un `SB_EXTERNAL_<ALIAS>_CONNECTION_STRING` por cada alias de `serviceBus.external[]`. Son los **inputs** que `infra-cd.yml` usa para sembrar el Key Vault del BC en un step posterior al `apply`; ya no hay siembra manual del admin ni verificacion del data plane del vault (MEF-ADR-0025 decision #6/#10). Reusa la misma lectura de `gh secret list` del punto 5; si falta, reporta `NO VERIFICADO` sin bloquear (un greenfield legitimo aun no tiene Postgres provisionado ni alias externos declarados).
7. **Registro `secrets[]`** (issue #256, informativo): cuantas entradas hay registradas (las siembra el step data-driven de `infra-cd.yml`, sin ninguna linea hardcodeada por secreto) y, para cada entrada con `source.type: "github-secret"`, si el GitHub secret que referencia existe en el repo. La **forma** del array (`name` unico, `source.type` en {`output`, `github-secret`, `composite`}, `source.value` no vacio) ya la valida `load_harness_config` como parte del punto 1 (`Configuracion`): un `secrets[]` mal formado hace que esa seccion reporte `FALTA`, con el mensaje exacto que emite la funcion. Ausente por completo, reporta `NO VERIFICADO` sin bloquear (normal antes del primer `/mefisto:infra-base`).
8. **Bifurcacion de dos caminos de auth** (`tenancy.strategy`, MEF-ADR-0028 + enmienda #337, MEF-ADR-0032, issue #323 + #341, informativo): que camino declaro el proyecto, mapeado 1:1 a las dos etapas de tenancy de MEF-ADR-0028 -- **(A) crecer**: autenticacion orquestada desde el inicio (`multi-tenant-header`, etapa b, ya existe o se planea una autenticacion que produce un `TenantContext`) o **(B) POC**: sin autenticacion (`mono-tenant-transitorio`, etapa a, greenfield, el default). No se sondea en codigo (no hay señal fiable: el harness no referencia ningun tipo `Cosmos.MultiTenancy.*`/autenticacion); es un token **declarado** por el humano. Ausente equivale al camino (B) POC/etapa (a) por defecto, asi que nunca reporta `FALTA` -- solo `OK` (valor reconocido, cualquiera de los dos caminos) o `NO VERIFICADO` (ausente, o con un valor no reconocido).
9. **Worker de proyecciones** (`projections.enabled`, MEF-ADR-0034, issue #369, informativo): si el BC declaro que adopta proyecciones y, si lo declaro, si el worker `<RootNamespace>.Projections` ya existe. Usa `HARNESS_PROJECTIONS_ENABLED` (`load_harness_config`) y consulta el token original en el config efectivo para conservar su presencia: `false` explícito reporta **`OK`** como opt-out válido; ausente o `null` conserva `NO VERIFICADO` informativo. Nunca sondea codigo mas alla de la existencia del csproj. Si esta en `true` y el worker ya existe, reporta `OK`; si esta en `true` pero el worker no existe todavia, reporta `NO VERIFICADO` y habilita el paso opt-in 7 (encadenar `/mefisto:scaffold-projections`).
10. **Configuracion de App Insights** (`.mefisto/appinsights.env`, MEF-ADR-0053, issue #2384; en la seccion "Estado operativo de Mefisto"): el archivo que lee `appinsights-query.sh` y que requieren `/mefisto:bug` (ruta desplegada), `/mefisto:health-check` y `/mefisto:purge-store`. Se parsea linea a linea (nunca con `source`). `OK` si declara `APPINSIGHTS_APP`, `APPINSIGHTS_RG`, `SERVICEBUS_NAMESPACE` y `SERVICEBUS_RG` con valor; `FALTA` si falta (y existe `infra/environments/`) o si le faltan claves (las lista), con la accion de crearlo con las cinco claves (o la provision opt-in del paso 9); `NO VERIFICADO` si falta y no hay `infra/environments/` (greenfield). `FUNCTIONAPP_NAMES` ausente o vacio no es `FALTA`: se reporta una fila `INFO` porque `function-errors` no funcionara.

La provision de **`.mefisto/appinsights.env`** (paso 9, descubre los nombres con `az` y escribe solo ese archivo, sin sobrescribir uno existente) tambien es opt-in, bajo su propia confirmacion explicita.

La migración de **directivas** (paso 3), la provision de **labels** (paso 4), la del **CI** hacia Azure (paso 5), la escritura de la **estrategia de tenancy** (paso 6, la bifurcacion de caminos de auth) y encadenar **`/mefisto:scaffold-projections`** (paso 7, cuando el worker de proyecciones falta) las ofrece `/mefisto:onboard` como pasos **opt-in**, bajo confirmacion explicita e independiente. La migración de directivas nunca mueve ni elimina doctrina legacy; el script de labels es destructivo (borra los labels default de GitHub); el de CI crea recursos reales en Azure (app de Entra, role assignments, federated credential -- OIDC, MEF-ADR-0022); el de tenancy escribe el config declarado; y el de proyecciones genera codigo nuevo (invoca al agente `projections-scaffolder`). El diagnostico en si sigue siendo de solo lectura: sin confirmacion no se crea, borra, escribe, genera ni provisiona nada.

Al cerrar el reporte, `/mefisto:onboard` imprime un bloque **"Proximos pasos"**: deriva del mismo diagnostico ya hecho (sin re-verificar nada) la migración de directivas, siempre en este orden y mostrando solo las acciones aplicables: completar `AGENTS.md`, dejar el puente `CLAUDE.md` -> `@AGENTS.md`, y, por separado, limpiar manualmente las secciones contractuales legacy duplicadas; después enumera configuración, labels, CI, infraestructura, secretos, auth y proyecciones según corresponda. Es **puramente informativo**: no ejecuta `gh`/`az`, no provisiona ni copia, borra o reescribe doctrina.

## Proceso

### 1. Ejecutar el diagnostico

Corre este bloque tal cual. Invoca `onboard-diagnose.sh` del paquete activo: ese script trae el checklist completo de 9 secciones.

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-diagnose.sh" 2>&1
```

### 2. Presentar el resultado

Muestra al usuario la salida del checklist tal como la imprimio el bloque (el formato ya esta consolidado), **incluyendo el cierre "Proximos pasos" y el puntero al quickstart greenfield** -- ese bloque ya decidio el siguiente comando exacto a partir del mismo diagnostico, no lo repitas ni lo reformules. Luego, en una o dos lineas, resume el estado (cuantos `FALTA`/`NO VERIFICADO` hay, o que quedo LISTO) sin duplicar el contenido de "Proximos pasos".

No reinterpretes ni recalcules el checklist ni el bloque "Proximos pasos": el bloque bash ya hizo el diagnostico y ya derivo el siguiente paso.

### 3. Migración opt-in de directivas canónicas

Ofrece este paso **solo** cuando el diagnóstico reportó que falta `AGENTS.md` o, bajo el adaptador Claude, el puente exacto `@AGENTS.md` en `CLAUDE.md` (bajo OpenCode el puente es informativo: si solo falta el puente, ofrece el paso únicamente cuando el usuario indique que el equipo también usa Claude). Muestra primero el plan que produce `--preview`: crear `AGENTS.md` solamente si está ausente, crear o añadir el puente sin mover ni borrar texto existente, y cualquier aviso de doctrina legacy duplicada. Si `AGENTS.md` existe pero está incompleto, explica que no se fusiona por heurística y que debe completarse manualmente.

Antes de previsualizar, pregunta si el equipo **también usa Claude**: si responde que sí, ofrece `--with-claude-bridge` (crea o completa el puente `CLAUDE.md` -> `@AGENTS.md` aun bajo OpenCode) y agrega ese flag tanto a la previsualización (`MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-migrate-directives.sh" --preview --with-claude-bridge`) como a la aplicación (`MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-migrate-directives.sh" --apply --with-claude-bridge`), para que el plan confirmado sea el que se aplica. Sin esa respuesta, no lo agregues.

Advierte que, aunque la migración es conservadora, escribe archivos del consumidor. Presenta primero el plan real con este bloque, sin aplicar cambios:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-migrate-directives.sh" --preview
```

Si la previsualización aborta por un preflight fallido -- incluido un `AGENTS.md` existente pero incompleto -- muestra sus instrucciones manuales y no ofrezcas aplicar. Si imprime el plan, pregunta si desea aplicar **ese plan exacto**. Sin un `si` explícito, no ejecutes ninguna escritura. Solo tras ese `si`, ejecuta `MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-migrate-directives.sh" --apply`. El script hace su preflight y es idempotente; no reimplementes su plantilla ni sus validaciones. Si informa secciones legacy en `CLAUDE.md`, deja visible que deben retirarse manualmente antes de que el contrato sea completamente canónico.

### 4. Provision opt-in de los labels faltantes

Este paso solo escribe bajo confirmacion explicita del usuario. El diagnostico (pasos 1-2) nunca crea ni borra labels.

Aplica este paso **solo si** la seccion "Labels de GitHub" del diagnostico reporto `[FALTA] faltan labels: ...`. Si los labels salieron `OK`, no hay nada que provisionar -- omite el paso. Si salieron `NO VERIFICADO` (gh sin autenticar o sin repo), no se puede saber que falta: pide al usuario `gh auth login` y que vuelva a correr `/mefisto:onboard`; no intentes provisionar a ciegas.

1. **Advierte que es destructivo y pide confirmacion.** `scripts/setup-github-labels.sh` **borra 8 de los 9 labels default de GitHub** (documentation, duplicate, enhancement, good first issue, help wanted, invalid, question, wontfix) y re-crea `bug` con el esquema del harness, antes de crear el resto del esquema. Dilo explicitamente y pregunta, p. ej.: "Faltan estos labels: <lista>. ¿Quieres que los provisione ahora? Esto **borra los labels default de GitHub** y recrea el esquema del harness. [si/no]".
2. **No ejecutes nada sin un "si" explicito.** Si el usuario no confirma (o prefiere hacerlo a mano), no corras el script: recuerdale el comando de las "Acciones sugeridas" y termina. El comportamiento por defecto de `/mefisto:onboard` es solo diagnostico.
3. **Solo si el usuario confirma**, corre la provision:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/setup-github-labels.sh" 2>&1
```

Si el script sale con error, la causa tipica es `gh` sin autenticar o sin permiso de escritura sobre el repo: corre `gh auth login` (o pide acceso de escritura) y reintenta. El script es idempotente -- crea cada label con `--force` y tolera los labels default ya borrados --, asi que reintentarlo es seguro. En caso de exito, sugiere volver a correr /mefisto:onboard para ver el diagnostico en verde.

4. **Reporta el resultado al usuario** tal como lo imprimio el bloque. Si fallo, no abortes ni reescribas el resto del flujo: el diagnostico (pasos 1-2) ya se mostro y sus otras secciones (config, CI) son independientes de los labels. En ambos casos sugiere volver a correr `/mefisto:onboard` para confirmar el estado real tras la provision.

### 5. Provision opt-in del CI hacia Azure

Esta provision solo se ejecuta bajo confirmacion explicita del usuario, porque `scripts/setup-github-ci.sh` **crea recursos reales en Azure** (la aplicacion de Entra + Service Principal, tres role assignments y dos federated credentials OIDC). El diagnostico (pasos 1-2) nunca crea recursos en Azure.

Aplica este paso **solo si** la seccion "CI hacia Azure" del diagnostico reporto `FALTA` -- ya sea la app de Entra (`aplicacion de Entra "..." no encontrada`) o los secrets OIDC (`faltan secrets OIDC: ...`). Ambos los resuelve `setup-github-ci.sh`: es **idempotente** (si la app/SP/federated credential ya existen, los reutiliza) y siempre re-imprime los 3 secrets OIDC al final, asi que tambien sirve cuando solo faltan los secrets en GitHub. Si la seccion salio `OK`, no hay nada que provisionar -- omite el paso. Si salio `NO VERIFICADO` (sin `az`, sin sesion de Azure, o `githubServicePrincipalName` ausente en el config), **no provisiones a ciegas**: pide al usuario instalar Azure CLI / correr `az login` / completar el config segun corresponda, y que vuelva a correr `/mefisto:onboard`.

1. **Valida prerequisitos y reune los datos (CA-3).** Antes de ofrecer nada, confirma que se puede: `az` instalado y con **sesion activa** (`az account show`). El `<subscription-id>` **no esta en el config**: pideselo al usuario. El `<owner/repo>` el script lo auto-resuelve (via `gh` o el remote `origin`); ofrece pasarlo solo si la resolucion falla. Si falta `az`, la sesion o el subscription-id, **reportalo claro y no invoques el script** (en vez de dejarlo fallar opaco).
2. **Advierte que crea recursos reales en Azure y pide confirmacion (CA-2).** Antes de ejecutar nada, dilo explicitamente y pregunta, p. ej.: "Esto configura el CI hacia Azure: crea la app de Entra + Service Principal (sin secret), le asigna `Contributor` y `Role Based Access Control Administrator` (con condicion anti-escalacion) a nivel suscripcion y `Storage Blob Data Contributor` sobre el tfstate, y anade dos federated credentials OIDC (rama `main` y `pull_request`). **Crea recursos reales en Azure.** Recuerda que debe correr **despues** de `bootstrap-backend.sh` (resuelve el nombre real del tfstate del backend ya creado). ¿Quieres que lo configure ahora? [si/no]".
3. **No ejecutes nada sin un "si" explicito (CA-4).** Si el usuario no confirma (o prefiere hacerlo a mano), no corras el script: recuerdale el comando de las "Acciones sugeridas" y termina. El comportamiento por defecto de `/mefisto:onboard` es solo diagnostico: una corrida sin confirmar **no crea ningun recurso en Azure ni copia secrets**.
4. **Solo si el usuario confirma**, valida los prerequisitos del punto 1 (`az` instalado, `az account show` con sesion, subscription-id provisto; si falta alguno, reportalo y no invoques nada). Si el backend del tfstate aun no existe, corre primero `bootstrap-backend.sh` (mismo consentimiento; crea el Resource Group, la Storage Account y el container del tfstate):

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/bootstrap-backend.sh" --subscription <subscription-id>
```

Despues, sustituyendo `<subscription-id>` por el que dio el usuario:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/setup-github-ci.sh" <subscription-id>
```

Con `<owner/repo>` como segundo argumento (solo si la auto-resolucion fallo): `MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/setup-github-ci.sh" <subscription-id> <owner/repo>`. El script crea la app de Entra + Service Principal SIN secret, los role assignments y las federated credentials OIDC (MEF-ADR-0022). Si falla, las causas tipicas son: `bootstrap-backend.sh` aun no corrio (no se resuelve la Storage del tfstate); sin permisos de gestion de aplicaciones en Microsoft Entra (pide a un admin que lo provisione); no se pudo resolver el slug owner/repo (reintenta pasandolo).

5. **Reporta el resultado al usuario (CA-5)** tal como lo imprimio el bloque. Si la provision fue exitosa, **recuerdale explicitamente que el script imprime 3 secrets OIDC** (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) que debe **pegar a mano** en GitHub (Settings > Secrets and variables > Actions), porque ni el script ni `/mefisto:onboard` los suben; no hay client secret que expire (OIDC, MEF-ADR-0022). Si fallo, no abortes ni reescribas el resto del flujo: el diagnostico (pasos 1-2) y las otras provisiones (labels) son independientes. En ambos casos sugiere volver a correr `/mefisto:onboard` para confirmar el estado real tras la provision.

**Caveat: idempotencia parcial de la condicion ABAC.** `az role assignment create` no actualiza la condicion de una asignacion que ya exista con el mismo principal/rol/alcance. La asignacion de `Role Based Access Control Administrator` con la condicion anti-escalacion la introdujo el issue #195; en un onboarding limpio se crea de una vez **con** la condicion. Pero si el SP ya tuviera esa asignacion **sin** la condicion --creada fuera de este script (p. ej. a mano), o si una version futura del script cambia la expresion de la condicion-- re-correr el script aqui **no** se la aplica ni actualiza. El SP quedaria con ese rol sin la restriccion anti-escalacion, aunque `/mefisto:onboard` reporte el CI en verde. Ver el diagnostico y la remediacion completa en docs/guia-del-consumidor.md, seccion "Primeros pasos con el harness (greenfield)", subseccion "5. Bootstrap de infraestructura", paso 2. El arreglo del script (deteccion y recreacion automatica) queda diferido a un issue aparte.

### 6. Bifurcacion de auth: provision opt-in de la estrategia de tenancy (crecer vs POC)

Esta escritura opt-in de `/mefisto:onboard` toca el config declarado en vez de recursos externos -- no requiere `gh` ni `az`. El diagnostico (pasos 1-2) nunca escribe este token; solo lo reporta.

`/mefisto:onboard` **no sondea codigo** para inferir el camino de auth vigente (MEF-ADR-0028): no hay señal fiable (un grep del harness confirmo cero referencias a `MultiTenancy`/`TenantResolver`/`TenantContext` en agentes/scripts/commands/ADRs). El camino lo declara el humano; este paso solo lo pregunta como una bifurcacion explicita de dos caminos (CA-1) y, si se confirma, escribe la etapa de tenancy que lo materializa.

Ofrece este paso siempre (a diferencia de labels/CI, no depende de que el diagnostico haya reportado `FALTA` -- la seccion de tenancy nunca lo reporta). Si el usuario no tiene interes en tocar la estrategia de tenancy ahora, omite el paso sin insistir.

1. **Presenta la bifurcacion de dos caminos y pregunta cual aplica (CA-1).** Independientemente de lo que reporto el diagnostico (punto 8), presenta al usuario los dos caminos -- mapeados 1:1 a las dos etapas de MEF-ADR-0028 -- y pregunta cual elige, p. ej.: "Tu proyecto puede seguir uno de dos caminos de auth: **(A) crecer** -- va a madurar mas alla de esto y necesita autenticacion orquestada desde el inicio (WorkOS AuthKit + Azure API Management, MEF-ADR-0032; etapa `multi-tenant-header`) -- o **(B) POC** -- no va a madurar mas alla de una prueba de concepto y no necesita autenticacion (etapa `mono-tenant-transitorio`, el default). ¿Cual de los dos elegis? [A/B]".
   - Si responde **(B) POC** (o no sabe / prefiere decidir despues): el camino vigente es (a), `mono-tenant-transitorio`. Si el token ya esta ausente o ya vale eso, no hay nada que escribir (CA-2) -- informa y termina el paso sin tocar el archivo.
   - Si responde **(A) crecer**: el camino vigente es (b), `multi-tenant-header`.
2. **No escribas nada sin confirmar el valor exacto (mismo patron que las provisiones anteriores).** Muestra el valor que vas a escribir/actualizar y la ruta efectiva que resolvió el harness, y pide confirmacion explicita, p. ej.: "Voy a escribir `tenancy.strategy = \"multi-tenant-header\"` en el config canónico `.mefisto/harness.config.json`. ¿Confirmas? [si/no]". Si el usuario no confirma, no toques el archivo: recuerdale que puede editarlo a mano y termina el paso. El comportamiento por defecto de `/mefisto:onboard` sigue siendo solo diagnostico.
3. **Solo si el usuario confirma**, escribe/actualiza el campo con `jq`, preservando el resto del archivo:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ERROR: no estas en un repositorio git"; exit 1; }
COMMON="${MEFISTO_PACKAGE_ROOT}/scripts/_pipeline-common.sh"
if [ ! -f "$COMMON" ]; then
  echo "ERROR: no se hallo _pipeline-common.sh en el paquete activo ($COMMON)."
  exit 1
fi
source "$COMMON"
CONFIG=$(resolve_harness_config_path write "$REPO_ROOT") || exit 1
ESTRATEGIA="<mono-tenant-transitorio|multi-tenant-header>"  # la que confirmo el usuario en el paso 2

if ! load_harness_config >/dev/null; then
  echo "ERROR: el config efectivo no es válido. Corrígelo antes de escribir $CONFIG."
elif [ "$HARNESS_CONFIG_PATH" != "$CONFIG" ]; then
  echo "ERROR: el config efectivo todavía es legacy ($HARNESS_CONFIG_PATH)."
  echo "       Migra primero el config a $CONFIG; los escritores nuevos no modifican la ruta legacy."
elif ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq no esta instalado. Requerido para escribir $CONFIG."
else
  TMP=$(mktemp)
  if jq --arg s "$ESTRATEGIA" '.tenancy = ((.tenancy // {}) + {strategy: $s})' "$CONFIG" > "$TMP" && mv "$TMP" "$CONFIG"; then
    echo "OK: tenancy.strategy = \"$ESTRATEGIA\" escrito en $CONFIG."
  else
    rm -f "$TMP"
    echo "ERROR: no se pudo escribir $CONFIG (revisa que sea JSON valido)."
  fi
fi
```

4. **Reporta el resultado al usuario.** Si escribio el token, recuerdale que `domain-scaffolder` (Paso 0) solo lo lee en el **proximo** dominio que scaffoldee -- no re-scaffoldea dominios ya existentes. Si el proyecto tiene dominios en etapa (a) y acaba de declarar la etapa (b), reemplazar el `ITenantContext` de esos dominios existentes sigue siendo manual (ver el `// TODO(tenancy etapa b)` que `domain-scaffolder` deja en `TenantResolverMonoTenantPorDefecto.cs`, MEF-ADR-0028). Si el camino elegido fue **(A) crecer**, suma el puntero al orquestador (CA-3): tras `/mefisto:infra-base` y `/mefisto:scaffold <dominio>`, el siguiente paso es correr `/mefisto:install-auth` para instalar WorkOS+APIM (MEF-ADR-0032, issue #342) -- encadena `/mefisto:install-workos` y `/mefisto:install-apim` con el gate humano en medio, sin que tengas que conocer el orden ni invocar cada skill de capa por separado.

### 7. Worker de proyecciones: provision opt-in encadenando `/mefisto:scaffold-projections`

Esta escritura opt-in es la unica que genera codigo nuevo -- invoca al agente `projections-scaffolder` -- en vez de tocar el config o recursos externos. El diagnostico (pasos 1-2) nunca genera el worker; solo reporta si falta (CA-3).

Aplica este paso **solo si** la seccion "Worker de proyecciones" del diagnostico reporto `projections.enabled=true, pero el worker ... no existe todavia` (issue #369). Si `projections.enabled` no esta en `true`, o el worker ya existe, no hay nada que ofrecer -- omite el paso sin insistir.

1. **Pide confirmacion explicita (CA-4).** El BC ya declaro que adopta proyecciones (el token esta en `true`); este paso solo pregunta si generar el worker ahora, p. ej.: "El BC declara `projections.enabled: true` pero el worker de proyecciones (`<RootNamespace>.Projections`) todavia no existe. ¿Quieres que corra `/mefisto:scaffold-projections` ahora para generarlo (MEF-ADR-0034)? [si/no]".
2. **No ejecutes nada sin un "si" explicito.** Si el usuario no confirma (o prefiere hacerlo despues), no invoques nada: recuerdale que puede correr `/mefisto:scaffold-projections` el mismo cuando quiera, y termina el paso. El comportamiento por defecto de `/mefisto:onboard` sigue siendo solo diagnostico.
3. **Solo si el usuario confirma**, encadena `/mefisto:scaffold-projections` leyendo integramente su `Proceso` -- mismo patron que `/mefisto:install-auth` encadena `/mefisto:install-workos`/`/mefisto:install-apim`: nunca reimplementes la logica del skill ni la del agente `projections-scaffolder`. Lee `"${MEFISTO_PACKAGE_ROOT}/commands/scaffold-projections.md"` (el documento del comando `/mefisto:scaffold-projections` de la distribucion activa) sin transcribirlo aca.

Ejecuta sus pre-condiciones (token `projections.enabled`, cwd de consumidor) y su `Proceso` completo tal cual -- incluida su propia idempotencia interna: si el worker ya existiera (condicion de carrera improbable entre el diagnostico y este paso), `projections-scaffolder` lo reporta el mismo sin duplicar nada.

4. **Reporta el resultado al usuario** tal como lo reporto `/mefisto:scaffold-projections` (su seccion "3. Tras terminar", incluida la cadena de issues relacionados que recuerda: `domain-scaffolder` para registrar el store de cada dominio, y los modulos Terraform del Container App si `/mefisto:infra-base` no corrio todavia con el token habilitado). Si `/mefisto:scaffold-projections` aborto (p. ej. el token resulto deshabilitado entre el diagnostico y este paso), propala su mensaje sin reinterpretarlo.

### 8. Activación opt-in de Mefisto en este repo

Aplica este paso **solo si** la sección de activación por repositorio reportó `FALTA`. Mefisto se instala por usuario pero se activa solo en los repos que lo habilitan con archivos de proyecto commiteados (MEF-ADR-0053 decisión 2); una sola provisión escribe la activación de ambos runtimes, para equipos que usan los dos. Los worktrees de pipeline nacen de `origin/main`, así que los archivos deben quedar commiteados.

1. Previsualiza el cambio:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-activate-repo.sh" --preview
```

2. Muestra el plan y pregunta si desea aplicarlo. Sin un `si` explícito, no escribas nada.
3. Solo tras el `si`:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-activate-repo.sh" --apply
```

4. Recuerda que debe commitear los archivos que el script nombra y llevarlos a `main`. El script solo fusiona las claves de habilitación y escribe el cargador si falta o está desactualizado; no toca nada más ni commitea.

### 9. Provision opt-in de `.mefisto/appinsights.env`

Aplica este paso **solo si** el punto 10 del diagnostico reporto `FALTA` para `.mefisto/appinsights.env` (no existe o le faltan claves). Con `NO VERIFICADO` (greenfield sin `infra/environments/`) u `OK`, omitelo. Descubre los nombres con `az` (sesion activa) en el resource group del entorno, sin pedirselos al usuario (MEF-ADR-0045); escribe solo `.mefisto/appinsights.env` (MEF-ADR-0053) y nunca sobrescribe uno existente.

1. Muestra primero el plan, sin escribir nada (entorno `dev` por defecto; `--env <env>` lo cambia):

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-provision-appinsights.sh" --preview
```

2. Si aborta por ambiguedad (mas de un App Insights o namespace), muestra los candidatos, pregunta cual usar y repite el preview con `--appinsights-app <nombre>` / `--servicebus-namespace <nombre>`. Si aborta por otra causa (sin `az`, sin sesion, sin resource group, sin App Insights o Service Bus), muestra la causa y no ofrezcas aplicar.
3. Si imprime las cinco claves, pregunta si desea aplicar **ese contenido exacto**. Sin un `si` explicito, no ejecutes ninguna escritura.
4. Solo tras el `si`, ejecuta `MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/onboard-provision-appinsights.sh" --apply` con los mismos flags del preview. Si el archivo ya existe, el script se niega: indica editarlo o borrarlo a mano.
5. Recuerda que el archivo solo contiene nombres de recursos (sin secretos) y debe commitearse.

## Reglas

- **Diagnostico de solo lectura por defecto.** El diagnostico (pasos 1-2) no ejecuta `gh label create`, `az ... create`, ni escribe archivos o recursos. Las **unicas** acciones de escritura permitidas son las **provisiones opt-in** -- migrar directivas (paso 3), labels (paso 4, el script borra los labels default de GitHub), CI hacia Azure (paso 5, el script crea app de Entra, role assignments y federated credential OIDC), la estrategia de tenancy (paso 6, escribe `tenancy.strategy` en el config declarado) encadenar `/mefisto:scaffold-projections` (paso 7, genera el worker de proyecciones invocando al agente `projections-scaffolder`) habilitar Mefisto en la configuración de proyecto (paso 8) y crear `.mefisto/appinsights.env` (paso 9, escribe solo ese archivo y nunca sobrescribe uno existente) -- y solo tras la confirmacion explicita del usuario **para cada una**: nunca las ejecutes sin un "si". Sin confirmacion, una corrida de `/mefisto:onboard` no crea, borra, escribe, genera ni provisiona nada.
- **No abortes ante un fallo parcial.** Cada seccion del diagnostico es independiente: si `gh` o `az` no estan disponibles, reporta `NO VERIFICADO` y continua con el resto.
- **No dupliques la validacion del config.** El formato de `terraformStateStorage` y los campos requeridos los valida `load_harness_config` (issue #78); este skill solo reporta su resultado.
- **La estructura de carpetas es informativa, nunca `FALTA`.** Un greenfield legitimo aun no tiene `src/`, `tests/` ni `infra/environments/` antes del primer `/mefisto:scaffold` o `/mefisto:infra-base`; marcarla como bloqueante daria un falso negativo (issue #212).
- **Los secretos que alimentan la siembra en Key Vault (MEF-ADR-0025) son informativos, nunca `FALTA`.** La siembra en el Key Vault del BC la hace CI (`infra-cd.yml`) tras el `apply`; ningun humano custodia secretos en su data plane. El diagnostico solo reporta si los GitHub secrets que la alimentan (`TF_VAR_POSTGRESQL_ADMIN_PASSWORD`, `SB_EXTERNAL_<ALIAS>_CONNECTION_STRING` por alias) existen -- un greenfield legitimo aun no los tiene antes de provisionar Postgres o declarar `serviceBus.external[]` (issue #232).
- **El registro `secrets[]` (issue #256) tambien es informativo, nunca `FALTA` por si solo.** Su **forma** (`name`/`source.type`/`source.value`) ya la valida `load_harness_config` como parte de la seccion "Configuracion" (punto 1) -- un `secrets[]` mal formado hace que ESA seccion reporte `FALTA`, no esta. Esta seccion solo cuenta las entradas registradas y, para las de tipo `github-secret`, si el GitHub secret que referencian existe -- lo mismo que ya hacia para `serviceBus.external[]`, generalizado a cualquier entrada.
- **La bifurcacion de dos caminos de auth (`tenancy.strategy`, MEF-ADR-0028, issue #323, issue #341) es informativa, nunca `FALTA`.** Mapeada 1:1 a las dos etapas de tenancy -- (A) crecer = etapa b `multi-tenant-header`, (B) POC = etapa a `mono-tenant-transitorio`. Ausente equivale al camino (B) POC por defecto (retrocompatible); no hay señal de codigo fiable para inferir el camino, asi que `/mefisto:onboard` nunca lo sondea -- solo reporta el valor declarado (o su ausencia) y ofrece el paso opt-in 6 para escribirlo bajo confirmacion. `/mefisto:onboard` no absorbe la orquestacion de auth (eso vive en `/mefisto:install-auth`): solo presenta la bifurcacion, la registra y apunta al orquestador en "Proximos pasos".
- **El worker de proyecciones (`projections.enabled`, MEF-ADR-0034, issue #369) es informativo, nunca `FALTA`.** Es un token opt-in: `false` explícito es un opt-out válido y se reporta `OK`; ausente o `null` se mantienen como `NO VERIFICADO` informativo. Solo cuando esta en `true` y el worker todavia no existe se ofrece el paso opt-in 7 (encadenar `/mefisto:scaffold-projections`) -- `/mefisto:onboard` no genera codigo por si mismo, delega en el skill/agente.
- **El bloque de cierre "Proximos pasos" es puramente informativo (issue #222).** Solo lee las mismas variables que ya acumulo el diagnostico (`N_FALTA`, `N_NV`, y los flags `PA_*` por seccion, incluyendo `PA_AUTH_PATH` -- issue #341 -- y `PA_PROJECTIONS_MISSING` -- issue #369) para imprimir el comando exacto a correr a continuacion (incluido el puntero a `/mefisto:install-auth` cuando el camino declarado es (A) crecer, y el puntero a `/mefisto:scaffold-projections` cuando el worker de proyecciones falta) y el puntero al quickstart greenfield; nunca ejecuta `gh`/`az` ni escribe nada. No reemplaza ni condiciona las provisiones opt-in (pasos 3 a 9), que siguen requiriendo confirmacion explicita para cada una.
- Si `$ARGUMENTS` trae algo, ignoralo: `/mefisto:onboard` no toma argumentos.
