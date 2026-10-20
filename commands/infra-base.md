---
description: "Genera la infraestructura base del consumidor (modulos Terraform + esqueleto del entorno + infra-cd.yml) delegando en infra-base-scaffolder."
argument-hint: "[dev|staging|prod]"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/infra-base.md. No editar a mano. -->
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

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Genera la infraestructura base del consumidor (8 modulos Terraform + esqueleto del entorno con outputs + el workflow de CI `infra-cd.yml`) delegando en el agente `infra-base-scaffolder`. Es el eslabon greenfield entre `bootstrap-backend.sh` (crea el `tfstate`) y el primer `/mefisto:infra`, que solo escribe y revisa el HCL: el `apply` real lo ejecuta CI al mergear el PR (MEF-ADR-0021, MEF-ADR-0022). El contrato de configuracion es `.mefisto/harness.config.json` (MEF-ADR-0053); un config legado solo se acepta como fallback de **lectura** cuando el canonico no existe, sin copiarlo ni migrarlo. Si el BC declara `projections.enabled` en el config efectivo, el mismo agente suma los 3 modulos **opt-in** del worker de proyecciones (`container-registry`, `container-app-environment`, `container-app`) y su wiring en el entorno (MEF-ADR-0034); sin ese token no genera ninguno. Comunicate en **espanol**.

## Entrada

`$ARGUMENTS` (opcional): el ambiente -- `dev` (default), `staging` o `prod`.

## Proceso

### 1. Resolver el ambiente

Si `$ARGUMENTS` esta vacio, usa `dev`. Si trae un valor, validalo (`dev`/`staging`/`prod`); si no coincide, informa el error y detente. Desde aqui trabaja solo con el ambiente ya resuelto (`<env>`), nunca con `$ARGUMENTS` crudo.

### 2. Informar que se va a generar

```
Se va a generar la infraestructura base del consumidor (ambiente: <env>):

  - infra/modules/{resource-group, monitoring, postgresql, service-bus,
                   service-plan, storage, function-app}/main.tf
  - infra/environments/<env>/{main, variables, providers, outputs}.tf
    (NO se genera backend.tf: lo escribe bootstrap-backend.sh)
  - .github/workflows/infra-cd.yml (si no existe aun): plan en cada PR sobre
    infra/**, apply al mergear a main, autenticado por OIDC (MEF-ADR-0022)

El generador es idempotente: si ya existen archivos, los respeta y solo crea lo que falta.
```

### 3. Lanzar el agente

Sustituye `<env>` por el ambiente ya resuelto y validado en el paso 1:

invoca la tool `Task` con el agente `mefisto:infra-base-scaffolder` y este mensaje: Genera la infraestructura base. Ambiente: <env>. Espera su resultado final y continua con el paso siguiente del comando.

### 4. Tras terminar

Recuerda al usuario el orden del flujo greenfield:

```
Infraestructura base generada. Siguiente:
  1. Si el backend del tfstate aun no existe, un administrador ejecuta una sola vez
     ${MEFISTO_PACKAGE_ROOT}/scripts/bootstrap-backend.sh y luego
     ${MEFISTO_PACKAGE_ROOT}/scripts/setup-github-ci.sh. Son operaciones privilegiadas
     de una sola vez (MEF-ADR-0022); este comando no las ejecuta.
  2. Crea la GitHub variable ALERT_EMAIL y el GitHub secret
     TF_VAR_POSTGRESQL_ADMIN_PASSWORD (Settings > Secrets and variables > Actions;
     setup-github-ci.sh no los crea) -- infra-cd.yml los inyecta como
     TF_VAR_alert_email/TF_VAR_postgresql_admin_password, nunca via terraform.tfvars
     commiteado (MEF-ADR-0025). subscription_id ya no es una variable: se resuelve de
     ARM_SUBSCRIPTION_ID. Revisa tambien los defaults derivados en variables.tf
     (project, project_short, postgresql_location, postgresql_region_short).
     Si PostgreSQL debe ir a otra region por oferta, versiona juntos sus dos defaults no
     sensibles en infra/environments/<env>/variables.tf, para que CI los reciba. Por ejemplo:
     `variable "postgresql_location" { default = "centralus" }` y
     `variable "postgresql_region_short" { default = "cus" }`. No derives la abreviatura:
     declarala segun la convencion regional del consumidor (MEF-ADR-0045). No cambies
     `location` ni `azure_region_short`: siguen describiendo los recursos primarios en eastus2.
     terraform.tfvars permanece ignorado y solo sirve para overrides locales no versionados;
     nunca guardes alli postgresql_admin_password ni otro secreto.
  3. Primer /mefisto:infra: escribe y revisa el HCL, abre un PR. El apply real
     ocurre en CI al mergear a main (workflow Infra CD), nunca en local.
  4. /mefisto:scaffold <dominio> agrega su service-plan/storage/function-app a este entorno.
```

## Reglas

- **No generes la infraestructura tu mismo.** Solo valida el ambiente, informa y delega en el agente.
- El agente nunca corre `terraform plan`/`apply`: solo `fmt`, `init -backend=false` y `validate`. El plan real corre en CI al abrir el PR y el apply real al mergearlo a `main` (workflow `infra-cd.yml`, MEF-ADR-0021, MEF-ADR-0022).
- El agente es idempotente: no sobrescribe archivos `.tf` ni el workflow `infra-cd.yml` existentes (MEF-ADR-0021).
- Este comando no ejecuta `bootstrap-backend.sh` ni `setup-github-ci.sh`: solo los cita en el recordatorio.
