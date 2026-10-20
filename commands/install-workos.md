---
description: "Guia el dashboard de WorkOS AuthKit y cablea el adapter de identidad y la custodia de la API key."
argument-hint: "--domain <Dominio> [--env <env>]"
model: "sonnet"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/install-workos.md. No editar a mano. -->
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

Guia al operador por la capa de **identidad** de la autenticacion en el borde (MEF-ADR-0032): lo que **no es automatizable** (crear la cuenta/proyecto de WorkOS AuthKit y parametrizarlo en su dashboard) y cablea lo que **si** lo es (el codigo del adapter, via el agente `workos-identity-scaffolder`, y la custodia de la API key, via el comando `/mefisto:seed-secret`). Es el long-pole humano del onboarding de auth: produce el `client_id` y la API key que el futuro `/mefisto:install-apim` (issue #340) va a consumir. Comunicate en **espanol**.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Entrada

`$ARGUMENTS`:

```
--domain <Dominio> [--env <env>]
```

- **`--domain <Dominio>`** (obligatorio): el dominio **ya scaffoldeado** (`/mefisto:scaffold`) que va a orquestar el aprovisionamiento de organizaciones/usuarios/membresias contra WorkOS (típicamente el dominio de `UserManagement`/`ControlPlane` del BC). Acepta kebab o PascalCase.
- **`--env <env>`** (opcional, default `dev`): ambiente Terraform, usado solo por el paso de custodia del secreto (`/mefisto:seed-secret`).

Si falta `--domain`, responde con el uso exacto y detente sin ejecutar nada.

## Nombres fijos de este comando (no configurables)

| Artefacto | Nombre | Por que |
|---|---|---|
| Secreto en Key Vault del BC | `workos-api-key` | Custodiado por `/mefisto:seed-secret` (MEF-ADR-0025). |
| GitHub **secret** (API key de negocio) | `WORKOS_API_KEY` | CA-3: nunca viaja en claro; solo se verifica su existencia. |
| GitHub **variable** (client_id de login) | `WORKOS_CLIENT_ID` | CA-3: no es secreto (MEF-ADR-0032 seccion 6/7) -- se puede registrar. Es el mismo nombre que va a consumir el futuro `/mefisto:install-apim` (ver `${MEFISTO_PACKAGE_ROOT}/agents/apim-gateway-scaffolder.md`, `vars.WORKOS_CLIENT_ID`). |
| App setting que lee `Program.cs` | `WORKOS_API_KEY` | Se pasa explicito al agente de identidad (nunca su default `WorkOsApiKey`) para que coincida con el `APP_SETTING_KEY` que `seed-secret.sh` deriva del nombre del secreto de Key Vault (`tr '[:lower:]-' '[:upper:]_'` sobre `workos-api-key` -> `WORKOS_API_KEY`). Sin este alineamiento, el adapter generado leeria una variable de entorno que Terraform nunca cablea. |

## Proceso

### 1. Parsear `$ARGUMENTS`

Extrae `DOMINIO` y `ENV` (default `dev`). Si falta `--domain`, responde con el uso exacto (arriba) y detente.

### 2. Verificar que el dominio ya existe

```bash
test -f "infra/environments/<env>/dominio-<kebab-del-dominio>.tf" || {
  echo "FALTA: el dominio <dominio> no esta scaffoldeado todavia. Corre /mefisto:scaffold <dominio> primero."
  exit 1
}
```

Si falta, detente e indica el comando -- no tiene sentido guiar el dashboard de WorkOS todavia si el destino del adapter no existe.

### 3. Confirmar con el usuario

Muestra exactamente lo que va a pasar y pide confirmacion explicita -- este comando escribe codigo C#, un `.csproj`, Terraform del dominio, `harness.config.json`, y puede registrar una GitHub variable:

```
Se va a instalar WorkOS AuthKit para el dominio "<Dominio>" (env: <env>):

  1. Guia del dashboard de WorkOS (paso manual tuyo -- este comando no crea la cuenta ni el proyecto).
  2. Registro/verificacion de WORKOS_CLIENT_ID (GitHub variable) y WORKOS_API_KEY (GitHub secret,
     solo se verifica su existencia -- nunca se pide ni se maneja su valor).
  3. Generacion del adapter WorkOS en el dominio (agente workos-identity-scaffolder, issue #338).
  4. Custodia de la API key en Key Vault (comando /mefisto:seed-secret): registro en harness.config.json
     y cableado del app setting + rol de lectura en el Terraform del dominio.

El apply real (el que siembra el VALOR del secreto en el Key Vault) corre en CI al mergear el PR
(MEF-ADR-0022); este comando nunca ve ni escribe ese valor.

¿Continuar? (s/n)
```

Si dice no, detente sin escribir nada.

### 4. Rama de trabajo unica

Los pasos 8 y 9 (agente de identidad, `/mefisto:seed-secret`) commitean cada uno por su cuenta si te invocan desde `main`, pero cada uno en una rama **distinta** si no coordinas una compartida. Crea la rama **antes** de invocarlos, para que ambos la reusen (los dos respetan "si ya estoy en una rama no-main, commiteo ahi sin crear otra"):

```bash
git rev-parse --abbrev-ref HEAD
# si es main/master:
git switch -c install-workos/<dominio-kebab>
```

### 5. Guia del dashboard de WorkOS (paso humano, no automatizable)

Presenta este checklist al usuario tal cual -- **vos nunca creas la cuenta ni el proyecto**, solo lo guias. Fuentes: MEF-ADR-0032 (referencias [1]/[2]) y la documentacion vigente de WorkOS Docs verificada para este comando.

```
Guia del dashboard de WorkOS AuthKit (https://dashboard.workos.com):

  a. Cuenta/workspace: si todavia no existe, crea una cuenta en WorkOS. Cada workspace nace con
     dos entornos totalmente aislados -- Staging y Production -- con credenciales propias por
     entorno (API keys, client_id, organizaciones, usuarios, redirects: nada se comparte ni se
     migra automaticamente entre ambos). Decide contra cual entorno vas a trabajar ahora.
     Fuente: WorkOS Docs, "Staging vs. production environments"
     (https://workos.com/docs/authkit/environments).

  b. Habilitar AuthKit: es la solucion de autenticacion hospedada de WorkOS (MEF-ADR-0032 [1]).
     Fuente: WorkOS Docs, "AuthKit" (https://workos.com/docs/authkit).

  c. Obtener credenciales: en el dashboard, pestaña "API Keys" (barra lateral) -- copia el
     Client ID y la Secret Key (API key). Recorda la separacion de MEF-ADR-0032 seccion 6: si tu
     proyecto de NEGOCIO (el que usa el SDK WorkOS.net desde el backend) es distinto del proyecto
     de LOGIN (el que valida la politica del gateway APIM), no mezcles sus credenciales.

  d. Redirect URIs: pestaña "Redirects" -- agrega el/los callback del flujo de login
     (MEF-ADR-0032 [2], intercambio de codigo por un User). Sin wildcards de subdominio ni query
     parameters en Production (Staging si los tolera).
     Fuente: WorkOS Docs, "User Management" (https://workos.com/docs/user-management).

  e. Rol "admin": pestaña "Roles" (seccion de autorizacion). WorkOS NO trae un rol admin por
     defecto -- el unico rol sembrado es "member" (asignado automaticamente a toda membresia
     nueva). CRITICO: el adapter que genera el agente de identidad (paso 8 de este comando) fija
     el slug "admin" al crear membresias (WorkOsIdentityProvider.CreateMembershipAsync); si el
     rol con ese slug exacto no existe en tu proyecto WorkOS, cada alta de membresia va a fallar
     en runtime. Crealo antes de continuar.
     Fuente: WorkOS Docs, "Roles and Permissions"
     (https://workos.com/docs/user-management/roles-and-permissions).

  f. Separacion de credenciales (MEF-ADR-0032 seccion 6, seccion D del issue #335 que la origino):
     documenta para vos mismo cual client_id/API key corresponde a cada proyecto (login vs
     negocio) antes de pegarlos en cualquier lado -- este comando no puede detectar el error si los
     invertis.

  g. JWT Template (claim organization_membership_id): este claim NO es uno de los claims por
     defecto de AuthKit; la politica del gateway APIM lo propaga como X-Organization-Membership-Id
     y CritterStack 3.x lo exige. En el dashboard, del entorno que usas, crea un JWT Template con:
         { "organization_membership_id": "{{ organization_membership.id }}" }
     El claim se agrega "alongside the default claims". Limite: el template renderizado no puede
     superar 3072 bytes. Despues decodifica un token real y confirma el nombre del claim (B10).
     Fuentes: WorkOS Docs, "AuthKit + FGA" (https://workos.com/docs/fga/authkit-integration) y
     "Token claims" (https://workos.com/docs/authkit/connect/token-claims).
```

Estas URLs y roles/labels de UI son correctos al momento de escribir este comando; si el dashboard de WorkOS cambio de UI, reconcilia contra la doc vigente antes de asumir un paso obsoleto (regla de "Verificacion de fuentes" de `AGENTS.md`).

### 6. Registrar/verificar `WORKOS_CLIENT_ID` (GitHub variable -- no es secreto)

El `client_id` de login **no es sensible** (MEF-ADR-0032 seccion 7: "puede viajar como variable no sensible"), asi que este paso si puede pedirlo y registrarlo -- a diferencia del paso 7.

```bash
gh variable list --json name,value -q '.[] | select(.name=="WORKOS_CLIENT_ID") | .value' 2>/dev/null
```

- Si la salida ya trae un valor, repórtalo (`WORKOS_CLIENT_ID ya registrado: <valor>`) y pregunta si coincide con el proyecto de login que acaba de configurar en el paso 5. Si el usuario confirma que es otro, pide el nuevo valor y sobreescribe (`gh variable set WORKOS_CLIENT_ID --body "<valor>"`); si coincide, no hagas nada (idempotente).
- Si no existe, pide el `client_id` (paso 5.c) y registralo:

```bash
gh variable set WORKOS_CLIENT_ID --body "<client_id pegado por el usuario>"
```

Si `gh` no esta autenticado o falla, repórtalo como `NO VERIFICADO` y continua -- no bloquees el resto del comando por esto.

### 7. Verificar `WORKOS_API_KEY` (GitHub secret -- nunca en claro)

**Nunca** pidas ni imprimas el valor de la API key. Solo verifica que el secret ya exista:

```bash
gh secret list --json name -q '.[] | select(.name=="WORKOS_API_KEY") | .name' 2>/dev/null
```

- Si aparece, reportalo como presente.
- Si no aparece, no lo crees vos: instruye al usuario a correrlo el mismo, fuera de este chat (para que el valor nunca pase por la conversacion):

```
gh secret set WORKOS_API_KEY
```

  (el comando pide el valor por stdin/prompt interactivo). Anota esto como pendiente en el reporte final -- no bloquea el resto del comando: el paso 9 (`/mefisto:seed-secret`) ya tolera un GitHub secret ausente y solo lo recuerda, sin fallar.
- Si `gh secret list` falla (sin sesion), repórtalo como `NO VERIFICADO` y continua.

### 8. Invocar el agente de identidad (issue #338)

invoca la tool `Task` con el agente `mefisto:workos-identity-scaffolder` y este mensaje: Instala el adapter WorkOS en el dominio <Dominio>. App setting de la API key: WORKOS_API_KEY (fijo, no uses el default WorkOsApiKey). Espera su resultado final y continua con el paso siguiente del comando.

Espera el resultado del agente; luego continua con el paso 9 en esta misma sesion.

El agente es idempotente (verifica que exista antes de escribir) y esta gateado por compilacion (MEF-ADR-0032/#338 CA-5): si `dotnet build` no pasa (sin `dotnet`, sin red, o el SDK no compila), **degrada a "proponer"** -- deja el puerto/adapter/`PackageReference` sin commitear y sin cablear `SetApiKey`/`AddSingleton`. Registra el resultado (instalado y commiteado, u degradado a propuesta) para el reporte final y el paso 10.

### 9. Custodiar la API key con `/mefisto:seed-secret` (CA-5)

Reusa el comando existente en vez de reimplementar su logica de cableado Terraform. Lee `"${MEFISTO_PACKAGE_ROOT}/commands/seed-secret.md"` (el documento del comando `/mefisto:seed-secret` de la distribucion activa) y ejecuta sus pasos de cableado (5 en adelante) sin transcribirlos aca, con estos argumentos exactos: `workos-api-key --domain <Dominio> --env <env> --from-github-secret WORKOS_API_KEY`. La rama ya la creaste en el paso 4, asi que no ejecutes el paso de rama de `/mefisto:seed-secret`.

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/seed-secret.sh" workos-api-key --domain <Dominio> --env <env> --from-github-secret WORKOS_API_KEY
```

Sigue exactamente el resto del Proceso de ese documento (pasos 5 en adelante; el paso 4 es la invocacion de `seed-secret.sh` que ya corriste arriba, no la repitas) sobre la salida del script: cablear el app setting en el archivo Terraform del dominio, verificar (nunca duplicar) el rol `Key Vault Secrets User`, formatear/validar con `terraform` y commitear. **No** repitas el paso de confirmacion de `/mefisto:seed-secret` (ya confirmaste todo en el paso 3) ni su "Siguiente paso" de push+PR (lo hace este comando una sola vez, en el paso 10).

### 10. Push + PR unico (solo si no quedo nada sin commitear)

- **Si el paso 8 termino "instalado" (build verde y commiteado) y el paso 9 commiteo su cableado**: hace un unico push + PR para toda la rama.

  ```bash
  git push -u origin install-workos/<dominio-kebab>
  gh pr create --title "feat(identity): instalar WorkOS en <dominio>" --body "Genera el adapter WorkOS (agente workos-identity-scaffolder) y custodia workos-api-key via /mefisto:seed-secret. Si este comando lo disparo un issue concreto, agrega aca 'Closes #<numero>'."
  ```

  Si algun scaffolder reporto una seccion `## Warnings remanentes` (MEF-ADR-0056), copiala tal cual al body del PR (anadela al final del `--body`).

- **Si el paso 8 degrado a "proponer"** (sin build verde): **no hagas push todavia**. El working tree tiene el adapter propuesto sin commitear junto al commit ya hecho por el paso 9 (si corrio). Detente aca y deja claro en el reporte que falta reconciliar el adapter contra el SDK, correr `dotnet build` hasta que pase, commitear, y **recien entonces** `git push` + `gh pr create` -- nunca un PR con el dominio sin compilar.

### 11. Reportar

Resumen claro y en orden:

- **Dashboard de WorkOS** (paso 5): recordatorio de que es responsabilidad del usuario -- este comando no puede verificarlo.
- **`WORKOS_CLIENT_ID`**: registrado, ya existia (coincidente), actualizado, o `NO VERIFICADO`.
- **`WORKOS_API_KEY`**: presente, o pendiente (con el comando exacto `gh secret set WORKOS_API_KEY` para que el usuario lo corra el mismo).
- **Adapter WorkOS** (paso 8): instalado y commiteado, o degradado a "proponer" (con el motivo).
- **Custodia del secreto** (paso 9): registro en `secrets[]`, cableado del app setting, rol `Key Vault Secrets User` verificado/agregado.
- **Siguiente paso**: push + PR (si todo quedo verde) o la lista de reconciliacion pendiente (si el paso 8 degrado).

## Reglas

- **Nunca crees la cuenta ni el proyecto de WorkOS por el usuario.** El paso 5 es una guia, no una automatizacion -- no hay API/CLI de WorkOS para provisionar el workspace en si.
- **Nunca pidas, imprimas ni manejes el valor de `WORKOS_API_KEY`.** Solo se verifica su existencia (paso 7); si falta, el usuario lo crea el mismo con `gh secret set WORKOS_API_KEY` fuera de este chat.
- **`WORKOS_CLIENT_ID` si se puede pedir y registrar**: no es un secreto (MEF-ADR-0032 seccion 7). Aun asi, nunca lo confundas con la API key ni lo guardes como GitHub secret.
- **Nunca dupliques** un `PackageReference`, un app setting, una referencia `@Microsoft.KeyVault(...)` o un `azurerm_role_assignment` ya presentes -- los pasos 8 y 9 ya son idempotentes por si mismos, no reimplementes esa logica aca.
- **Nunca ejecutes `terraform plan` ni `terraform apply`.** El `apply` real corre en CI al mergear el PR (MEF-ADR-0022); este comando (via `/mefisto:seed-secret`) solo llega hasta `fmt`/`validate`.
- **Nunca commitees un dominio que no compila.** Si el paso 8 degrado a "proponer", no hagas push (paso 10) hasta que el usuario reconcilie el adapter y `dotnet build` quede verde.
- **Nunca crees el dominio destino.** Si `--domain` no esta scaffoldeado (paso 2), detente e indica `/mefisto:scaffold <dominio>`.
- **Nunca trabajes contra `main` directo.** Crea la rama compartida del paso 4 antes de invocar el agente o `/mefisto:seed-secret`.
- Si `$ARGUMENTS` no trae `--domain`, responde con el uso exacto y detente -- no adivines el dominio.
