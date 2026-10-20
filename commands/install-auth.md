---
description: "Orquesta el camino completo de auth: install-workos, gate humano de credenciales e install-apim."
argument-hint: "--identity-domain <Dominio> --domain <Dominio> [--domain <Dominio2> ...] [--env <env>] [--cors-origin <origin> ...]"
model: "sonnet"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/install-auth.md. No editar a mano. -->
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

Orquesta el **camino completo de auth** (MEF-ADR-0032, MEF-ADR-0028 seccion 4): encadena `/mefisto:install-workos` (issue #339) -> **gate humano** -> `/mefisto:install-apim` (issue #340) en el orden correcto, para que el usuario no tenga que conocer ese orden ni como se combinan los dos skills de capa. Es un runner guiado por etapas, **stateless**: no reimplementa la logica de ninguno de los dos skills, los invoca leyendo integramente su `Proceso` y delegando en su propia idempotencia -- si una etapa ya estaba hecha, el propio sub-skill invocado lo reporta y este orquestador continua. Comunicate en **espanol**.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Entrada

`$ARGUMENTS`:

```
--identity-domain <Dominio> --domain <Dominio> [--domain <Dominio2> ...] [--env <env>] [--cors-origin <origin> ...]
```

- **`--identity-domain <Dominio>`** (obligatorio): el dominio **ya scaffoldeado** que va a orquestar el aprovisionamiento de organizaciones/usuarios/membresias contra WorkOS. Se pasa tal cual como `--domain` de la **etapa 1** (`/mefisto:install-workos`).
- **`--domain <Dominio>`** (obligatorio, repetible): uno o mas dominios **ya scaffoldeados** a exponer detras del gateway APIM. Se pasan tal cual como `--domain` de la **etapa 2** (`/mefisto:install-apim`). Puede repetir el mismo valor de `--identity-domain` si ese dominio tambien expone endpoints HTTP de negocio detras del gateway (caso comun) -- no hay conflicto en pasarlo dos veces, con flags distintos.
- **`--env <env>`** (opcional, default `dev`): ambiente Terraform, pasado a ambas etapas.
- **`--cors-origin <origin>`** (repetible): pasado tal cual a la etapa 2. **Obligatorio solo** si es la primera instalacion del gateway en este entorno (mismo criterio que `/mefisto:install-apim`, ver etapa 2 abajo).

Si falta `--identity-domain` o al menos un `--domain`, responde con el uso exacto y detente sin ejecutar nada.

## Proceso

### 1. Parsear `$ARGUMENTS`

Extrae `IDENTITY_DOMINIO`, la lista de `DOMINIOS` (uno o mas `--domain`), `ENV` (default `dev`) y la lista de `CORS_ORIGINS`. Si falta `--identity-domain` o no hay ningun `--domain`, responde con el uso exacto y detente.

### 2. Verificar prerequisitos (CA-1)

APIM se monta delante de Function Apps existentes, asi que no tiene sentido arrancar sin infraestructura base ni dominios. Todo dominio scaffoldeado por `domain-scaffolder` **garantiza** al menos los endpoints HTTP `health`/`version` (`${MEFISTO_PACKAGE_ROOT}/agents/domain-scaffolder.md`, Paso 1 puntos 12-13 -- "este archivo garantiza que la Function App siempre tenga al menos un trigger"), asi que verificar que exista al menos un dominio scaffoldeado ya cubre el requisito "dominio con HTTP":

```bash
test -f "infra/environments/${ENV}/main.tf" && test -d infra/modules/resource-group || {
  echo "FALTA la infraestructura base: corre /mefisto:infra-base antes de /mefisto:install-auth."
  exit 1
}

ls infra/environments/"${ENV}"/dominio-*.tf >/dev/null 2>&1 || {
  echo "FALTA: ningun dominio esta scaffoldeado todavia en el entorno ${ENV}. Corre /mefisto:scaffold <dominio> primero."
  exit 1
}

test -f "infra/environments/${ENV}/dominio-<kebab-de-identity-domain>.tf" || {
  echo "FALTA: el dominio de identidad <identity-domain> no esta scaffoldeado todavia. Corre /mefisto:scaffold <identity-domain> primero."
  exit 1
}
```

Si cualquiera de los tres falta, detente con el mensaje -- no continues con el resto del proceso. (Los `--domain` de la etapa 2 que no esten scaffoldeados **no** se validan aca: el agente `apim-gateway-scaffolder` que invoca esa etapa ya los omite y los reporta sin abortar el resto del batch.)

**Fail-fast de `--cors-origin` (primera instalacion del gateway).** La etapa 2 (`/mefisto:install-apim`, su Paso 5) aborta si es la primera instalacion del gateway en este entorno (`apim.tf` ausente) y no recibio ningun `--cors-origin`. Pero para entonces la **etapa 1 completa** ya corrio (walkthrough manual del dashboard de WorkOS + custodia del secreto + commits), asi que el usuario habria hecho todo ese trabajo para chocar contra un flag faltante que pertenece conceptualmente al borde. Como el orquestador ya tiene aca toda la informacion para detectarlo, chequealo **antes** de invocar nada (mismo criterio que `/mefisto:install-apim`, no una reimplementacion de su logica):

```bash
if [ ! -f "infra/environments/${ENV}/apim.tf" ] && [ "${#CORS_ORIGINS[@]}" -eq 0 ]; then
  echo "FALTA: es la primera instalacion del gateway APIM en el entorno ${ENV} y no pasaste ningun --cors-origin."
  echo "       --cors-origin es obligatorio la primera vez (mismo criterio que /mefisto:install-apim). Reintenta con:"
  echo "       /mefisto:install-auth --identity-domain <Dominio> --domain <Dominio> --cors-origin <origin-del-SPA>"
  exit 1
fi
```

Si el gateway ya existe (`apim.tf` presente), este chequeo es un no-op -- un `--cors-origin` nuevo sobre un gateway ya instalado se maneja fuera de este skill (ver etapa 2).

### 3. Confirmar con el usuario

Muestra exactamente lo que va a pasar (las dos etapas completas + el gate humano) y pide confirmacion explicita -- a partir de aca este skill escribe codigo C#, Terraform, GitHub variables/secrets, y **reescribe codigo C# existente** en todos los dominios del BC (la migracion de tenancy de la etapa 2):

```
Se va a instalar el camino completo de auth (WorkOS + APIM, MEF-ADR-0032) para el entorno "<env>":

  Etapa 1 (/mefisto:install-workos, dominio de identidad "<identity-domain>"):
    1. Guia del dashboard de WorkOS (paso manual tuyo).
    2. Registro/verificacion de WORKOS_CLIENT_ID (GitHub variable) y WORKOS_API_KEY (GitHub secret,
       solo se verifica su existencia).
    3. Generacion del adapter WorkOS en "<identity-domain>" (agente workos-identity-scaffolder).
    4. Custodia de la API key en Key Vault (/mefisto:seed-secret).

  GATE HUMANO: no arranca la etapa 2 hasta verificar que WORKOS_CLIENT_ID y WORKOS_API_KEY
  existen en el repo (evita el fallo tipico de aplicar APIM sin las credenciales de WorkOS
  registradas).

  Etapa 2 (/mefisto:install-apim, dominios: <lista de --domain>):
    5. Modulos Terraform api-management/apim-function-api (agente apim-gateway-scaffolder), aditivo
       por dominio.
    6. Cableado de TF_VAR_workos_client_id (y TF_VAR_cors_allowed_origins la primera vez) en infra-cd.yml.
    7. TRANSICION DE TENANCY (a)->(b) (MEF-ADR-0028 seccion 4, enmendada por el issue #802): flip de
       tenancy.strategy + scaffold de la biblioteca src/<RootNamespace>.TenantResolver/ (patron
       AsyncLocal + middleware) + migracion del ITenantContext de TODOS los dominios ya
       scaffoldeados del BC a esa biblioteca.

El apply real (el que provisiona recursos en Azure y siembra el Key Vault) corre en CI al mergear
el PR (MEF-ADR-0022); este skill nunca ejecuta terraform plan/apply. El checklist post-deploy queda
pendiente para despues de ese apply.

¿Continuar? (s/n)
```

Si dice no, detente sin escribir nada. Ninguno de los dos sub-skills vuelve a pedir esta confirmacion: se la das una sola vez aca.

### 4. Rama de trabajo unica

Ambas etapas commitean cada una por su cuenta si las invocas desde `main`, pero en ramas **distintas** si no coordinas una compartida (cada una crea su propia rama por defecto: `install-workos/<dominio-kebab>`, `install-apim/<env>`). Crea la rama **antes** de invocar nada, para que ambas la reusen (las dos respetan "si ya estoy en una rama no-main, commiteo ahi sin crear otra" en su propio paso de rama):

```bash
git rev-parse --abbrev-ref HEAD
# si es main/master:
git switch -c "install-auth/${ENV}"
```

### 5. Etapa 1 -- invocar `/mefisto:install-workos` (CA-2)

Lee `"${MEFISTO_PACKAGE_ROOT}/commands/install-workos.md"` (el documento del comando `/mefisto:install-workos` de la distribucion activa) sin transcribirlo aca.

Ejecuta integramente su `Proceso` con `--domain <identity-domain> --env <env>`, con estas dos excepciones:

- **Omite su Paso 3** (confirmacion): ya la diste en el Paso 3 de este orquestador.
- **Omite su Paso 10** (push + PR): este orquestador hace un unico push + PR al final (Paso 8), cubriendo ambas etapas.

Su Paso 4 (crear rama) corre tal cual, pero como ya estas en `install-auth/<env>` (no `main`), su propia condicion "si ya estoy en una rama no-main, no creo otra" lo vuelve un no-op -- no hace falta omitirlo activamente.

Corre el resto de sus pasos tal cual (guia del dashboard de WorkOS, registro/verificacion de `WORKOS_CLIENT_ID`, verificacion de `WORKOS_API_KEY`, invocacion del agente `workos-identity-scaffolder`, custodia via `/mefisto:seed-secret`) -- incluida su propia idempotencia interna (CA-4): si `WORKOS_CLIENT_ID` ya estaba registrado, el adapter ya estaba instalado, o el secreto ya estaba custodiado, `/mefisto:install-workos` lo reporta el mismo sin duplicar nada. No vuelvas a verificar vos esas condiciones antes de invocarlo -- ese es exactamente el trabajo que delegas.

Guarda su reporte final (Paso 11 de `/mefisto:install-workos`) para consolidarlo en el reporte de este skill (Paso 10).

### 6. Gate humano -- verificar credenciales de WorkOS antes de la etapa 2 (CA-3)

**No invoques `/mefisto:install-apim` sin este chequeo.** Es el gate que evita el fallo tipico de aplicar APIM sin el `client_id`/API key de WorkOS registrados:

```bash
WORKOS_CLIENT_ID=$(gh variable list --json name,value -q '.[] | select(.name=="WORKOS_CLIENT_ID") | .value' 2>/dev/null)
GH_VAR_RC=$?
WORKOS_API_KEY_PRESENTE=$(gh secret list --json name -q '.[] | select(.name=="WORKOS_API_KEY") | .name' 2>/dev/null)
GH_SECRET_RC=$?
```

- Si `gh` falla en cualquiera de las dos consultas (`GH_VAR_RC`/`GH_SECRET_RC` distinto de 0 -- sin sesion, sin permisos): **detente**. A diferencia de otras verificaciones tolerantes del harness (que degradan a `NO VERIFICADO` y continuan), este es el gate humano explicito del CA-3 -- no se puede continuar a ciegas sin saber si las credenciales existen. Pide al usuario `gh auth login` y reintentar `/mefisto:install-auth`.
- Si `WORKOS_CLIENT_ID` esta vacio **o** `WORKOS_API_KEY_PRESENTE` esta vacio: **detente**. No invoques la etapa 2. Reporta exactamente que falta y como completarlo:
  - Si falta `WORKOS_CLIENT_ID`: la guia del dashboard de WorkOS (Paso 5 de `/mefisto:install-workos`, ya corrida en la etapa 1) no llego a registrarlo -- revisa el reporte de la etapa 1 o corre `/mefisto:install-auth` de nuevo tras completarla.
  - Si falta `WORKOS_API_KEY`: el usuario todavia no corrio `gh secret set WORKOS_API_KEY` (paso manual, MEF-ADR-0025 -- nunca lo automatiza este skill). Indicaselo y detente.
- Si ambos existen: reporta el gate como verificado y continua a la etapa 2.

### 7. Etapa 2 -- invocar `/mefisto:install-apim` (CA-2)

Lee `"${MEFISTO_PACKAGE_ROOT}/commands/install-apim.md"` (el documento del comando `/mefisto:install-apim` de la distribucion activa) sin transcribirlo aca.

Ejecuta integramente su `Proceso` desde su **Paso 5 en adelante** con `--domain <lista de --domain> --env <env> [--cors-origin <origin> ...]` -- sus Pasos 1 (parseo), 2 (prerequisitos) y 4 (rama) ya quedan cubiertos por los Pasos 1, 2 y 4 de este orquestador, y su Paso 3 (confirmacion) ya la diste en el Paso 3 de este orquestador. **Omite su Paso 11** (push + PR): este orquestador hace el unico push + PR al final (Paso 8).

Corre el resto tal cual (resolucion de primera instalacion, `WORKOS_CLIENT_ID`, `CORS_ALLOWED_ORIGINS`, agente `apim-gateway-scaffolder`, transicion de tenancy (a)->(b) con el gate de MEF-ADR-0029 por dominio, commit de la migracion) -- incluida su propia idempotencia interna (CA-4): si el gateway ya existia, la biblioteca `src/<RootNamespace>.TenantResolver/` ya estaba scaffoldeada, algun dominio ya estaba migrado a `services.AgregarTenantResolverAsyncLocal()`, o el token de tenancy ya estaba en etapa (b), `/mefisto:install-apim` lo reporta el mismo sin duplicar nada.

Guarda su reporte final (Paso 13 de `/mefisto:install-apim`, incluido el checklist post-deploy de su Paso 12) para consolidarlo en el reporte de este skill (Paso 9/10).

### 8. Push + PR unico (CA-5, solo si nada quedo roto)

- **Si la etapa 1 no degrado** (adapter instalado y commiteado, o ya estaba -- nunca "propuesto sin commitear") **y la etapa 2 no dejo ningun `--domain` omitido ni ningun dominio degradado** en la migracion de tenancy:

  ```bash
  git push -u origin "install-auth/${ENV}"
  gh pr create --title "feat(auth): instalar WorkOS + APIM (camino completo, MEF-ADR-0032)" --body "Instala el camino completo de auth: adapter WorkOS en <identity-domain> (/mefisto:install-workos, #339) y gateway APIM + transicion de tenancy (a)->(b) para <dominios> (/mefisto:install-apim, #340), MEF-ADR-0028 seccion 4. Si este skill lo disparo un issue concreto, agrega aca 'Closes #<numero>'."
  ```

  Si algun scaffolder reporto una seccion `## Warnings remanentes` (MEF-ADR-0056), copiala tal cual al body del PR (anadela al final del `--body`).

  Si no hay ningun commit nuevo en la rama (ambas etapas ya estaban completamente hechas de una corrida anterior y no escribieron nada), **no crees un PR vacio**: repórtalo como "todo ya estaba instalado, nada para commitear" en el Paso 10.

- **Si alguna etapa quedo degradada** (adapter de la etapa 1 sin build verde, o algun `--domain`/dominio de tenancy de la etapa 2 sin reconciliar): **no hagas push todavia**. Detente y deja explicito en el reporte (Paso 10) que falta reconciliar antes de push + PR -- nunca un PR con algo sin construir.

### 9. Emitir el checklist post-deploy (CA-5, delegado de `/mefisto:install-apim`)

Presenta **tal cual** el checklist que la etapa 2 ya emitio en su Paso 12 (guardado en el Paso 7 de este orquestador), aclarando unicamente que corre **despues** de que CI aplique el PR (MEF-ADR-0022). Todas sus verificaciones viajan dentro de ese bloque; no las reinterpretes ni las resumas.

### 10. Reportar

Resumen claro y en orden, consolidando lo que reporto cada etapa (no reinterpretes sus resultados, propalos):

- **Etapa 1 (`/mefisto:install-workos`)**: dashboard de WorkOS (recordatorio de responsabilidad del usuario), `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, adapter (instalado / ya existia / degradado a "proponer"), custodia del secreto.
- **Gate humano (Paso 6)**: verificado, o detenido con el motivo exacto (que credencial falta y como completarla).
- **Etapa 2 (`/mefisto:install-apim`)**: prerequisitos, `WORKOS_CLIENT_ID`/`CORS_ALLOWED_ORIGINS`, agente `apim-gateway-scaffolder` (modulos, dominios agregados/omitidos), migracion de tenancy (token flip, dominios migrados/ya migrados/degradados/resolver custom).
- **Siguiente paso**: push + PR (si todo quedo verde), la lista de reconciliacion pendiente (si alguna etapa degrado), o "nada para commitear" (si todo ya estaba instalado).
- **Checklist post-deploy** (Paso 9): recordatorio de correrlo tras el `apply` de CI.

## Reglas

- **Nunca reimplementes la logica de `/mefisto:install-workos` ni de `/mefisto:install-apim`.** Este skill delega leyendo integramente su `Proceso` -- nunca duplica sus chequeos de idempotencia, sus nombres fijos, su HCL/C# generado, ni su checklist post-deploy. Ese checklist en particular **nunca se transcribe en este archivo**: una copia aca es una segunda fuente que divergira la proxima vez que `/mefisto:install-apim` cambie la suya -- el criterio del codigo de exito del POST autenticado es justamente el que ya se desfaso una vez asi.
- **Nunca saltees el gate humano del Paso 6.** No invoques la etapa 2 sin verificar que `WORKOS_CLIENT_ID` y `WORKOS_API_KEY` existen en el repo -- ese chequeo es el que evita el fallo tipico de aplicar APIM sin las credenciales de WorkOS registradas.
- **Nunca asumas las credenciales del gate si `gh` falla.** A diferencia de otras verificaciones tolerantes del harness, este gate es bloqueante: sin poder confirmar `WORKOS_CLIENT_ID`/`WORKOS_API_KEY`, deten el flujo antes de la etapa 2 en vez de continuar a ciegas.
- **Nunca pidas ni imprimas el valor de `WORKOS_API_KEY`** ni de ningun otro secreto -- ni este skill ni las etapas que invoca lo hacen; solo se verifica su existencia.
- **Nunca hagas push si alguna etapa quedo degradada** (adapter sin build verde en la etapa 1, o algun `--domain`/dominio de tenancy sin reconciliar en la etapa 2) -- deja la reconciliacion pendiente explicita en el reporte, igual que hace cada sub-skill por su cuenta.
- **Nunca crees un PR vacio.** Si ninguna etapa genero un commit nuevo (todo ya estaba instalado de una corrida anterior), repórtalo como tal en vez de forzar push + PR.
- **Nunca trabajes contra `main` directo.** Crea la rama compartida del Paso 4 antes de invocar cualquiera de las dos etapas.
- **Nunca ejecutes `terraform plan` ni `terraform apply`.** El `apply` real corre en CI al mergear el PR (MEF-ADR-0022); ni este skill ni las etapas que invoca llegan mas alla de `fmt`/`validate`.
- **Nunca crees los dominios destino.** Si `--identity-domain` o algun `--domain` no esta scaffoldeado, indica `/mefisto:scaffold <dominio>` en el reporte -- nunca lo crees vos (el Paso 2 ya detiene el flujo si falta el dominio de identidad o si no hay ningun dominio scaffoldeado en el entorno).
- Si `$ARGUMENTS` no trae `--identity-domain` o al menos un `--domain`, responde con el uso exacto y detente -- no adivines dominios.
