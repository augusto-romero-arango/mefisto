---
description: "Registra un secreto nuevo post-greenfield y cablea su referencia Key Vault versionless en la Function App de un dominio."
argument-hint: "<nombre> --domain <Dominio> (--from-output <output> | --from-github-secret <NOMBRE>) [--env <env>]"
model: "sonnet"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/seed-secret.md. No editar a mano. -->
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

Registra un secreto nuevo post-greenfield en `harness.config.json > secrets[]` (registro declarativo que itera el step de siembra data-driven de `infra-cd.yml`, issue #256) y cablea su referencia `@Microsoft.KeyVault(...)` versionless + el rol `Key Vault Secrets User` en la Function App del dominio que lo consume. **No** toca el `Key Vault Secrets Officer` del SP de CI (MEF-ADR-0022, mecanismo M1): ese rol de escritura ya se auto-asigna el propio `apply`; este skill solo agrega -- o verifica que ya exista -- el rol de lectura de la app. Ningun valor de secreto viaja en claro (MEF-ADR-0025): este skill solo referencia nombres de GitHub secrets o de `terraform output`. Comunicate en **espanol**.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Entrada

`$ARGUMENTS`:

```
<nombre> --domain <Dominio> (--from-output <output-de-terraform> | --from-github-secret <NOMBRE_DEL_GITHUB_SECRET>) [--env <env>]
```

- **`<nombre>`**: nombre del secreto en el Key Vault del BC (kebab-case recomendado, ej. `stripe-api-key`).
- **`--domain <Dominio>`**: el dominio consumidor que va a leer el secreto. Acepta kebab o PascalCase (`facturacion` o `Facturacion`); **debe existir ya** -- `/mefisto:seed-secret` nunca crea un dominio, solo cablea en uno que `/mefisto:scaffold` ya genero.
- **`--from-output <output>`** o **`--from-github-secret <NOMBRE>`**: exactamente uno de los dos (D2, fijado por el mantenedor -- fuente explicita, sin heuristica por nombre). El primero para un valor derivable de un `terraform output` del entorno (p. ej. otro secreto de un modulo ya provisionado); el segundo para un valor que **no** es derivable (una API key de un proveedor externo, otra credencial que solo un admin conoce).
- **`--env <env>`** (opcional): ambiente Terraform, default `dev`.

Si falta `<nombre>` o `--domain`, o si faltan ambos flags de fuente (o vienen los dos a la vez), responde con el uso exacto (arriba) y detente sin ejecutar nada.

## Proceso

### 1. Parsear `$ARGUMENTS`

Extrae `NOMBRE`, `DOMINIO`, `ENV` (default `dev`), y exactamente uno de `FROM_OUTPUT`/`FROM_GITHUB_SECRET`. Si el parseo falla o falta algo requerido, responde con el uso y detente.

### 2. Confirmar con el usuario

Muestra exactamente lo que se va a hacer y pide confirmacion explicita -- este skill escribe en `harness.config.json` y en un archivo Terraform del consumidor:

```
Se va a sembrar el secreto "<nombre>" (fuente: <output <x> | github-secret <NAME>>):

  - Registro:  .mefisto/harness.config.json > secrets[] (agrega o actualiza la entrada, idempotente)
  - Cableado:  infra/environments/<env>/dominio-<kebab-del-dominio>.tf
               app setting <APP_SETTING_KEY> -> referencia @Microsoft.KeyVault(...) versionless
               Rol "Key Vault Secrets User": se verifica que ya lo emita domain-scaffolder
               (nunca se duplica; nunca se toca el rol del SP de CI)

El apply real -- el que siembra el VALOR del secreto en el Key Vault -- corre en CI al mergear
el PR (MEF-ADR-0022); este skill nunca ve ni escribe el valor.

¿Continuar? (s/n)
```

Si dice no, detente sin escribir nada.

### 3. Rama de trabajo

Nunca trabajes contra `main` directo. Si la rama activa es `main`, crea una rama nueva antes de escribir nada:

```bash
git rev-parse --abbrev-ref HEAD
# si es main/master:
git switch -c seed-secret/<nombre-en-kebab>
```

(Si te invoco desde una rama ya creada por otro flujo, commitea ahi sin crear otra.)

### 4. Registrar el secreto y resolver el dominio

Invoca el script del plugin una sola vez (nunca `./scripts/...`: los scripts del harness no viven en el repo
consumidor), con el flag de fuente recibido en `$ARGUMENTS`. Captura stdout y stderr juntos (`2>&1`),
muestralos y extrae de la linea `Registro: <ruta>` la ruta `<REGISTRO_PATH>`. Esa linea es la unica
fuente de verdad de la ruta que el script escribio:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/seed-secret.sh" <nombre> --domain <Dominio> --env <env> <flag-de-fuente> <valor> 2>&1
```

Donde `<flag-de-fuente> <valor>` es `--from-output <output>` o `--from-github-secret <NOMBRE>`. Si el script sale con codigo distinto de cero, muestra la salida y detente. Si la salida no trae ninguna linea `Registro: `, informa `ERROR: el script no informo la ruta de registro.` y detente.

El script:

1. Valida que exista `infra/environments/<env>/dominio-<kebab>.tf` para el dominio (la fuente de verdad de que el dominio ya esta scaffoldeado); si no lo encuentra, aborta con un mensaje claro.
2. Registra/actualiza, de forma idempotente, la entrada en el contrato canonico `.mefisto/harness.config.json > secrets[]`.
3. Si la fuente es `--from-github-secret`, valida (con `gh secret list`) si ese GitHub secret ya existe en el repo y, si no, imprime un recordatorio -- no bloquea, porque crear el secret puede ser un paso posterior de un admin.
4. Imprime el `APP_SETTING_KEY` derivado, la referencia `@Microsoft.KeyVault(...)` completa, y la ruta del archivo Terraform del dominio (`DOMAIN_TF_FILE`) donde cablear.

Si el script termina con error (incluido config solo legacy, JSON invalido, dominio no encontrado o flags invalidos), muestra el mensaje tal cual y **detente sin editar ningun otro archivo**.

### 5. Cablear la referencia en el archivo Terraform del dominio

Lee `DOMAIN_TF_FILE` (el que imprimio el script del paso 4). Dentro del bloque `module "function_app_<dominio>"`, en su mapa `app_settings = { ... }` (mismo patron que `${MEFISTO_PACKAGE_ROOT}/agents/domain-scaffolder.md`, ej. `SERVICE_BUS_CONNECTION_INTERNO`, `MartenConnectionString`):

- **Si ya existe** una linea con la clave `<APP_SETTING_KEY>` o una referencia `@Microsoft.KeyVault(...secrets/<nombre>)`, **no la dupliques**: reporta que ya estaba cableado y continua al paso 6.
- **Si no existe**, agrega una linea nueva dentro del mapa, alineada con el mismo estilo de las lineas vecinas (el operador `=` alineado si el resto del bloque lo esta), inmediatamente antes del `}` de cierre del mapa:

  ```hcl
  <APP_SETTING_KEY> = "@Microsoft.KeyVault(SecretUri=${module.key_vault.uri}secrets/<nombre>)"
  ```

### 6. Verificar (nunca duplicar) el rol `Key Vault Secrets User`

Busca en el mismo archivo un `azurerm_role_assignment` con `role_definition_name = "Key Vault Secrets User"` y `scope = module.key_vault.id` para la managed identity de este dominio (recurso `function_app_<dominio>_kv_secrets_user`, patron fijado en el agente `domain-scaffolder`).

- **Si ya existe** (es el caso normal: `domain-scaffolder` lo emite siempre al crear un dominio, y ese rol de datos cubre **todos** los secretos del Key Vault, no solo los que existian al momento de scaffoldear), no hagas nada -- reportalo como verificado.
- **Si por alguna razon falta** (un dominio scaffoldeado antes de que este role assignment formara parte del patron), agregalo con el mismo bloque HCL que emite el agente `domain-scaffolder`.

**Nunca** toques ni agregues un `azurerm_role_assignment` de `Key Vault Secrets Officer`: ese rol es exclusivo del SP de CI (mecanismo M1, MEF-ADR-0022) y ya se auto-asigna en el `main.tf` del entorno -- fuera del alcance de este skill.

### 7. Formatear y validar (si `terraform` esta instalado)

```bash
terraform -chdir=infra/environments/<env> fmt -recursive ../..
terraform -chdir=infra/environments/<env> init -backend=false
terraform -chdir=infra/environments/<env> validate
```

Si `terraform validate` falla, corrige el HCL insertado y vuelve a validar. Si `terraform` no esta instalado, avisa y deja el formateo/validacion como paso manual pendiente -- no es motivo para detenerte. **Nunca** ejecutes `terraform plan` ni `terraform apply`: el `apply` real (el que siembra el valor del secreto) corre en CI al mergear el PR (MEF-ADR-0021, MEF-ADR-0022).

### 8. Commitear

```bash
git add "<REGISTRO_PATH>" "infra/environments/<env>/dominio-<kebab>.tf"
git commit -m "seed-secret(<nombre>): registrar y cablear en <dominio>"
```

### 9. Reportar

Resumen claro:

- **Registro**: entrada nueva o actualizada en `<REGISTRO_PATH> > secrets[]` (`name`, `source.type`, `source.value`).
- **Cableado**: app setting agregado, o ya presente (sin duplicar).
- **Rol `Key Vault Secrets User`**: verificado, o agregado si faltaba.
- Si la fuente es `--from-github-secret` y el script reporto que el GitHub secret **no** existe: recuerda explicitamente crearlo (*Settings > Secrets and variables > Actions*) **antes** del proximo `apply` que deba sembrar este secreto -- si no, ese `apply` fallara al no encontrar el valor.
- **Siguiente paso**: `git push -u origin <rama>` + `gh pr create` apuntando a `main`. El `plan` corre en el PR y el `apply` real -- el que siembra el valor en el Key Vault, iterando el `secrets[]` ya actualizado -- lo ejecuta `infra-cd.yml` en CI al mergear (MEF-ADR-0022), nunca localmente.

## Reglas

- **Nunca crees el dominio.** Si `--domain` no existe (el script lo valida contra `infra/environments/<env>/dominio-*.tf`), detente e indica al usuario que corra `/mefisto:scaffold <dominio>` primero.
- **Nunca dupliques** un app setting, una referencia `@Microsoft.KeyVault(...)` o un `azurerm_role_assignment` ya presentes -- verifica antes de escribir (idempotencia, CA-5/CA-6).
- **Nunca toques** el `Key Vault Secrets Officer` del SP de CI (MEF-ADR-0022, mecanismo M1): este skill solo agrega o verifica el rol de **lectura** (`Key Vault Secrets User`) de la Function App consumidora, nunca el rol de **escritura** del SP.
- **Ningun valor de secreto viaja en claro** (MEF-ADR-0025). Este skill solo maneja **nombres** -- el nombre del secreto en Key Vault, el nombre de un GitHub secret, el nombre de un `terraform output` --; nunca pidas ni escribas el valor real de un secreto.
- **Nunca ejecutes** `terraform plan` ni `terraform apply`: solo `fmt`, `init -backend=false` y `validate`. El `apply` real ocurre en CI al mergear el PR.
- **Nunca trabajes contra `main` directo**: crea una rama antes de editar si hace falta (Paso 3).
- **Nunca crees un `azurerm_key_vault_secret`** ni materialices el valor de un secreto en Terraform (MEF-ADR-0025 decision #6): la siembra del valor es siempre un step de CI via `az keyvault secret set`, nunca Terraform.
- Si `$ARGUMENTS` no trae `<nombre>`, `--domain`, o exactamente uno de los dos flags de fuente, responde con el uso exacto y detente -- no adivines valores faltantes.
