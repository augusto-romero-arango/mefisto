#!/usr/bin/env bash
# _pipeline-common.sh --- Funciones compartidas entre scripts de pipeline
#
# Uso: source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"
#
# No invocar directamente (prefijo _ = sourceable).

# Estado operativo publicado (MEF-ADR-0053): los escritores usan exclusivamente
# .mefisto/pipeline; .claude/pipeline permanece solo como fallback de lectura.
# Los overrides se respetan para fixtures y worktrees de callers futuros.
_mefisto_state_root="$(git rev-parse --show-toplevel 2>/dev/null)" || _mefisto_state_root="$(pwd)"
: "${MEFISTO_STATE_DIR:=$_mefisto_state_root/.mefisto/pipeline}"
: "${MEFISTO_LEGACY_STATE_DIR:=$_mefisto_state_root/.claude/pipeline}"
export MEFISTO_STATE_DIR MEFISTO_LEGACY_STATE_DIR
unset _mefisto_state_root

# Raiz de la release que corre este pipeline (MEF-ADR-0053 decision 2): el
# adaptador de runtime la entrega a cada agente para que cargue esta version
# y no dependa de que Mefisto este instalado o habilitado en el worktree.
: "${MEFISTO_AGENT_PACKAGE_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
export MEFISTO_AGENT_PACKAGE_ROOT

# mefisto_state_path <rel> [root]
# Imprime la ruta canonica de escritura y crea solo su directorio padre.
mefisto_state_path() {
    local rel="$1" root="${2:-}" base full
    if [ -n "$root" ]; then
        base="$root/.mefisto/pipeline"
    else
        base="$MEFISTO_STATE_DIR"
    fi
    full="$base/$rel"
    mkdir -p "$(dirname "$full")" || return 1
    printf '%s\n' "$full"
}

# mefisto_state_read_paths <rel> [root]
# Imprime las rutas existentes, canonica primero y legacy despues, sin migrarlas.
mefisto_state_read_paths() {
    local rel="$1" root="${2:-}" canonical_base legacy_base
    if [ -n "$root" ]; then
        canonical_base="$root/.mefisto/pipeline"
        legacy_base="$root/.claude/pipeline"
    else
        canonical_base="$MEFISTO_STATE_DIR"
        legacy_base="$MEFISTO_LEGACY_STATE_DIR"
    fi
    [ -e "$canonical_base/$rel" ] && printf '%s\n' "$canonical_base/$rel"
    [ -e "$legacy_base/$rel" ] && printf '%s\n' "$legacy_base/$rel"
    return 0
}

# mefisto_state_read_first <rel> [root]
mefisto_state_read_first() {
    local rel="$1" root="${2:-}" first
    first=$(mefisto_state_read_paths "$rel" "$root" | head -n1)
    [ -n "$first" ] || return 1
    printf '%s\n' "$first"
}

# resolve_harness_config_path <read|write> [repo_root]
#
# Resuelve la ubicacion neutral del config del consumidor. stdout queda reservado
# exclusivamente para la ruta absoluta; todos los diagnosticos van a stderr.
# En lectura conserva el fallback legacy de MEF-ADR-0053; en escritura devuelve
# siempre la ubicacion canonica y no migra archivos por su cuenta.
resolve_harness_config_path() {
    local mode="$1" repo_root="${2:-}" canonical legacy

    case "$mode" in
        read|write) ;;
        *)
            echo "ERROR: modo invalido '$mode'; use read o write." >&2
            return 1
            ;;
    esac

    if [ -z "$repo_root" ]; then
        repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
            echo "ERROR: no se pudo resolver la raiz del repositorio Git para harness.config.json." >&2
            return 1
        }
    fi
    if [ ! -d "$repo_root" ]; then
        echo "ERROR: la raiz de repositorio no existe: $repo_root" >&2
        return 1
    fi
    repo_root=$(cd "$repo_root" && pwd -P) || return 1
    canonical="$repo_root/.mefisto/harness.config.json"
    legacy="$repo_root/.claude/harness.config.json"

    if [ "$mode" = "write" ]; then
        printf '%s\n' "$canonical"
        return 0
    fi
    if [ -f "$canonical" ]; then
        if [ -f "$legacy" ]; then
            echo "AVISO: se usara el config canonico $canonical; se ignora el legacy $legacy. Migra o elimina conscientemente el archivo legacy para evitar divergencias." >&2
        fi
        printf '%s\n' "$canonical"
        return 0
    fi
    if [ -f "$legacy" ]; then
        printf '%s\n' "$legacy"
        return 0
    fi

    echo "ERROR: no se encontro el config canonico requerido $canonical." >&2
    echo "  Se acepta solo para lectura el fallback legacy $legacy." >&2
    return 1
}

# load_harness_config [config_path]
#
# Carga la configuracion del harness desde .mefisto/harness.config.json del
# consumidor (con fallback legacy de solo lectura) y exporta las variables HARNESS_*
# al entorno. Llamar al inicio
# de cualquier script de pipeline que necesite los tokens del proyecto.
#
# Variables exportadas:
#   HARNESS_PROJECT_NAME       - Nombre legible del proyecto (ej: ControlAsistencias)
#   HARNESS_NAMESPACE_PREFIX   - Prefijo de namespace .NET (ej: Bitakora.ControlAsistencia)
#   HARNESS_SOLUTION_FILE      - Nombre del archivo .slnx (ej: ControlAsistencias.slnx)
#   HARNESS_RG_PREFIX          - Prefijo del Resource Group de Azure (ej: rg-controlasistencias)
#   HARNESS_TFSTATE_STORAGE    - Storage account para tfstate (ej: stcatfstatedev)
#   HARNESS_SP_NAME            - Service Principal de GitHub Actions (ej: github-controlasistencias-ci)
#   HARNESS_APP_INSIGHTS_APP   - Application Insights component (ej: appi-cplane-dev-eus2-001)
#   HARNESS_DOMAIN_LABELS      - Lista separada por espacios de labels dom:*
#   HARNESS_BC_NAME            - Nombre del Bounded Context (ej: Principal)
#   HARNESS_BC_DOMAINS         - Lista separada por espacios de dominios del BC (ej: "dominio1 dominio2")
#   HARNESS_SB_INTERNAL_SECRET    - Nombre del secreto de Key Vault de la cadena del ASB
#                                   propio del BC (alias reservado INTERNO). Vacio si el
#                                   config no declara serviceBus (MEF-ADR-0024, opcional).
#   HARNESS_SB_EXTERNAL_ALIASES   - Lista separada por espacios de los alias declarados en
#                                   serviceBus.external (ej: "COSMOS FACTURACION"). Vacia
#                                   si serviceBus/external esta ausente.
#   HARNESS_SB_EXTERNAL_ALCANCES  - Lista separada por espacios, MISMO ORDEN posicional
#                                   que HARNESS_SB_EXTERNAL_ALIASES, con el alcance de cada
#                                   entrada (compartido|externo).
#   HARNESS_SB_EXTERNAL_SECRETS   - Lista separada por espacios, MISMO ORDEN posicional que
#                                   HARNESS_SB_EXTERNAL_ALIASES, con el nombre del secreto de
#                                   Key Vault de cada entrada.
#   HARNESS_SECRETS_NAMES      - Lista separada por espacios de 'name' de cada entrada de
#                                 secrets[] (issue #256). Vacia si el config no declara 'secrets'.
#   HARNESS_SECRETS_TYPES      - Lista separada por espacios, MISMO ORDEN posicional que
#                                 HARNESS_SECRETS_NAMES, con 'source.type' de cada entrada
#                                 (output|github-secret|composite).
#   HARNESS_SECRETS_VALUES     - Lista separada por espacios, MISMO ORDEN posicional que
#                                 HARNESS_SECRETS_NAMES, con 'source.value' de cada entrada.
#   HARNESS_PROJECTIONS_ENABLED - "true" si projections.enabled es exactamente el booleano
#                                 true; "false" en cualquier otro caso (ausente, null, false,
#                                 o un tipo/valor invalido -- issue #369, MEF-ADR-0034). Nunca
#                                 aborta la carga: es un token opt-in, retrocompatible.
#   HARNESS_AZURE_REGION_SHORT - Valor de azureRegionShort (ej. "eus2"), componente {region}
#                                 del estandar de nombramiento de recursos (MEF-ADR-0045,
#                                 issue #729). Vacio si el campo esta ausente -- nunca aborta
#                                 la carga (token opt-in, retrocompatible).
#   HARNESS_RESOURCE_SEQUENCE  - Valor de resourceSequence (ej. "001"), componente {seq} del
#                                 mismo estandar (MEF-ADR-0045). "001" si el campo esta
#                                 ausente o vacio -- nunca aborta la carga.
#
# Campos opcionales del config (no se exportan via load_harness_config; quien
# los necesite hace jq inline sobre "$HARNESS_CONFIG_PATH", la ruta efectiva
# que esta funcion exporta: el contrato canonico, o el legacy solo como
# fallback de lectura):
#   repoSlug  - Slug owner/repo del fork de Mefisto a usar para drafts cross-repo
#               y mensajes de error. Default: augusto-romero-arango/mefisto
#
# Nota: el context map (registro de BCs externos) es trabajo diferido a futuras
# evoluciones; hoy el BC solo se nombra a si mismo via boundedContext.name y
# boundedContext.domains.
#
# serviceBus (opcional, MEF-ADR-0024 decision #1 y #6): registro de los ASB que el
# BC toca, clasificados por alcance (propio/compartido/externo), con el nombre
# del secreto de Key Vault de cada cadena (nunca la cadena en claro). El patron
# oficial del app setting de cada cadena es SERVICE_BUS_CONNECTION_<ALIAS> (con
# INTERNO como alias reservado del ASB propio del BC); la clave de broker de
# Wolverine es el mismo alias. serviceBus.external es opcional (un BC puede no
# consumir/publicar publico todavia); su ausencia no aborta la carga de config.
# El alcance verdaderamente externo se declara pero su wiring queda diferido
# (MEF-ADR-0024 decision #5, default-off).
#
# Si no existe el config file, emite mensaje claro de error y retorna 1.
load_harness_config() {
    local config
    if [ "$#" -gt 0 ]; then
        config="$1"
    else
        config=$(resolve_harness_config_path read) || return 1
    fi

    if [ ! -f "$config" ]; then
        echo "ERROR: no se encontro $config" >&2
        echo "  El harness requiere .mefisto/harness.config.json en la raiz" >&2
        echo "  del proyecto consumidor; .claude/harness.config.json solo se acepta" >&2
        echo "  como fallback de lectura para consumidores legacy." >&2
        echo "  El archivo tiene la forma:" >&2
        echo "    {" >&2
        echo "      \"projectName\": \"...\"," >&2
        echo "      \"namespacePrefix\": \"...\"," >&2
        echo "      \"solutionFile\": \"...\"," >&2
        echo "      \"infraResourceGroupPrefix\": \"...\"," >&2
        echo "      \"githubServicePrincipalName\": \"...\"," >&2
        echo "      \"appInsightsApp\": \"...\"," >&2
        echo "      \"domainLabels\": [\"...\", \"...\"]," >&2
        echo "      \"boundedContext\": { \"name\": \"<NombreBC>\", \"domains\": [\"...\"] }" >&2
        echo "    }" >&2
        return 1
    fi

    if ! command -v jq >/dev/null 2>&1; then
        echo "ERROR: jq no esta instalado. Requerido para parsear $config" >&2
        return 1
    fi

    if ! jq empty "$config" >/dev/null 2>&1; then
        echo "ERROR: el JSON de $config no es parseable." >&2
        return 1
    fi

    export HARNESS_CONFIG_PATH="$config"

    export HARNESS_PROJECT_NAME=$(jq -r '.projectName // ""' "$config")
    export HARNESS_NAMESPACE_PREFIX=$(jq -r '.namespacePrefix // ""' "$config")
    export HARNESS_SOLUTION_FILE=$(jq -r '.solutionFile // ""' "$config")
    export HARNESS_RG_PREFIX=$(jq -r '.infraResourceGroupPrefix // ""' "$config")
    export HARNESS_TFSTATE_STORAGE=$(jq -r '.terraformStateStorage // ""' "$config")
    export HARNESS_SP_NAME=$(jq -r '.githubServicePrincipalName // ""' "$config")
    export HARNESS_APP_INSIGHTS_APP=$(jq -r '.appInsightsApp // ""' "$config")
    export HARNESS_DOMAIN_LABELS=$(jq -r '.domainLabels // [] | join(" ")' "$config")
    export HARNESS_BC_NAME=$(jq -r '.boundedContext.name // ""' "$config")
    export HARNESS_BC_DOMAINS=$(jq -r '.boundedContext.domains // [] | join(" ")' "$config")

    local missing=()
    [ -z "$HARNESS_PROJECT_NAME" ]     && missing+=("projectName")
    [ -z "$HARNESS_NAMESPACE_PREFIX" ] && missing+=("namespacePrefix")
    [ -z "$HARNESS_SOLUTION_FILE" ]    && missing+=("solutionFile")

    if [ ${#missing[@]} -gt 0 ]; then
        echo "ERROR: campos obligatorios ausentes en $config: ${missing[*]}" >&2
        return 1
    fi

    # boundedContext es obligatorio (issue #131, MEF-ADR-0023).
    # Si esta ausente, emite un mensaje accionable de migracion con el shape
    # exacto a anadir y un ejemplo usando los domainLabels ya presentes.
    local bc_present
    bc_present=$(jq -r 'if has("boundedContext") then "yes" else "no" end' "$config")
    if [ "$bc_present" = "no" ]; then
        local example_domains
        example_domains=$(jq -r '.domainLabels // [] | map("\"" + . + "\"") | join(", ")' "$config")
        echo "ERROR: falta 'boundedContext' en $config (campo obligatorio, MEF-ADR-0023)." >&2
        echo "  El campo 'boundedContext' es requerido por MEF-ADR-0023 (Bounded Context)." >&2
        echo "  Anade el siguiente bloque a tu harness.config.json:" >&2
        echo "    \"boundedContext\": {" >&2
        echo "      \"name\": \"<NombreDetuBC>\",   // ej: Principal, Admin, Core" >&2
        echo "      \"domains\": [${example_domains}]" >&2
        echo "    }" >&2
        echo "  Los dominios deben ser un subconjunto de tus domainLabels existentes." >&2
        echo "  Ver /onboard para diagnostico o docs/migracion-y-versionado.md seccion 'Migracion para consumidores existentes'." >&2
        return 1
    fi

    # Validar boundedContext.name: 1-63 chars, alfanumericos y guiones.
    # Coherente con Azure resource naming conventions (compatible con nombres de RG).
    if [ -z "$HARNESS_BC_NAME" ]; then
        echo "ERROR: boundedContext.name esta vacio en $config." >&2
        echo "  Debe ser un string de 1-63 caracteres alfanumericos y guiones (ej: Principal)." >&2
        return 1
    fi
    if ! printf '%s' "$HARNESS_BC_NAME" | grep -Eq '^[a-zA-Z0-9-]{1,63}$'; then
        echo "ERROR: boundedContext.name='$HARNESS_BC_NAME' no es valido en $config." >&2
        echo "  Debe tener 1-63 caracteres alfanumericos y guiones ([a-zA-Z0-9-])." >&2
        return 1
    fi

    # Validar boundedContext.domains: array no vacio, cada elemento en domainLabels.
    local bc_domains_count
    bc_domains_count=$(jq -r '.boundedContext.domains // [] | length' "$config")
    if [ "$bc_domains_count" -eq 0 ]; then
        echo "ERROR: boundedContext.domains esta vacio en $config." >&2
        echo "  Debe contener al menos un dominio presente en domainLabels." >&2
        return 1
    fi

    # Verificar que cada dominio del BC esta en domainLabels.
    local invalid_domains=()
    while IFS= read -r domain; do
        [ -z "$domain" ] && continue
        if ! printf '%s' "$HARNESS_DOMAIN_LABELS" | tr ' ' '\n' | grep -Fqx "$domain"; then
            invalid_domains+=("$domain")
        fi
    done < <(jq -r '.boundedContext.domains[]' "$config" 2>/dev/null)

    if [ ${#invalid_domains[@]} -gt 0 ]; then
        echo "ERROR: boundedContext.domains contiene dominios no declarados en domainLabels:" >&2
        printf "  '%s' no esta en domainLabels\n" "${invalid_domains[@]}" >&2
        echo "  Los dominios del BC deben ser un subconjunto de domainLabels." >&2
        return 1
    fi

    # terraformStateStorage es opcional (consumidores sin IaC lo dejan vacio),
    # pero si tiene valor debe cumplir las reglas de nombramiento de Azure Storage
    # Account: 3-24 caracteres, solo minusculas y digitos, unico globalmente.
    # Fuente: Microsoft Learn -- "Storage account overview" (reglas de naming).
    # Validar aqui evita que un nombre invalido falle tarde, en el apply de /infra.
    if [ -n "$HARNESS_TFSTATE_STORAGE" ] && \
       ! printf '%s' "$HARNESS_TFSTATE_STORAGE" | grep -Eq '^[a-z0-9]{3,24}$'; then
        echo "ERROR: terraformStateStorage='$HARNESS_TFSTATE_STORAGE' no cumple las reglas de Azure Storage Account." >&2
        echo "  Debe tener 3-24 caracteres, solo minusculas y digitos ([a-z0-9])." >&2
        echo "  Sugerencia: abrevia el prefijo del proyecto (ej. micontrolplane -> mcp -> stmcptfstatedev)." >&2
        return 1
    fi

    # serviceBus es opcional (MEF-ADR-0024): un consumidor que aun no provisiona el
    # backbone compartido/externos, o que aun no tiene Key Vault, no declara
    # este registro. Ausente por completo -> exports vacios, sin error.
    export HARNESS_SB_INTERNAL_SECRET=""
    export HARNESS_SB_EXTERNAL_ALIASES=""
    export HARNESS_SB_EXTERNAL_ALCANCES=""
    export HARNESS_SB_EXTERNAL_SECRETS=""

    local sb_present
    sb_present=$(jq -r 'if has("serviceBus") then "yes" else "no" end' "$config")
    if [ "$sb_present" = "yes" ]; then
        HARNESS_SB_INTERNAL_SECRET=$(jq -r '.serviceBus.internal.secretName // ""' "$config")
        if [ -z "$HARNESS_SB_INTERNAL_SECRET" ]; then
            echo "ERROR: serviceBus.internal.secretName esta vacio o ausente en $config (MEF-ADR-0024)." >&2
            echo "  Si declaras 'serviceBus', el secreto de Key Vault de la cadena del ASB" >&2
            echo "  propio del BC (alias reservado INTERNO) es obligatorio. Nunca la cadena" >&2
            echo "  en claro (MEF-ADR-0024 decision #6). Anade:" >&2
            echo "    \"serviceBus\": { \"internal\": { \"secretName\": \"<nombre-secreto-kv>\" } }" >&2
            return 1
        fi
        export HARNESS_SB_INTERNAL_SECRET

        local ext_count
        ext_count=$(jq -r '.serviceBus.external // [] | length' "$config")

        local invalid_entries=() aliases=() alcances=() secrets=()
        local i entry_alias entry_alcance entry_secret entry_alias_upper is_dup existing
        for ((i = 0; i < ext_count; i++)); do
            entry_alias=$(jq -r ".serviceBus.external[$i].alias // \"\"" "$config")
            entry_alcance=$(jq -r ".serviceBus.external[$i].alcance // \"\"" "$config")
            entry_secret=$(jq -r ".serviceBus.external[$i].secretName // \"\"" "$config")

            if [ -z "$entry_alias" ]; then
                invalid_entries+=("entrada #$i: 'alias' vacio o ausente")
                continue
            fi

            entry_alias_upper=$(printf '%s' "$entry_alias" | tr '[:lower:]' '[:upper:]')
            if [ "$entry_alias_upper" = "INTERNO" ]; then
                invalid_entries+=("entrada #$i: alias '$entry_alias' es el alias reservado INTERNO (ASB propio del BC)")
                continue
            fi

            if [ "$entry_alcance" != "compartido" ] && [ "$entry_alcance" != "externo" ]; then
                invalid_entries+=("entrada #$i (alias '$entry_alias'): alcance '$entry_alcance' invalido, debe ser 'compartido' o 'externo'")
                continue
            fi

            if [ -z "$entry_secret" ]; then
                invalid_entries+=("entrada #$i (alias '$entry_alias'): 'secretName' vacio o ausente")
                continue
            fi

            is_dup="no"
            if [ ${#aliases[@]} -gt 0 ]; then
                for existing in "${aliases[@]}"; do
                    if [ "$(printf '%s' "$existing" | tr '[:lower:]' '[:upper:]')" = "$entry_alias_upper" ]; then
                        is_dup="yes"
                        break
                    fi
                done
            fi
            if [ "$is_dup" = "yes" ]; then
                invalid_entries+=("entrada #$i: alias '$entry_alias' duplicado")
                continue
            fi

            aliases+=("$entry_alias")
            alcances+=("$entry_alcance")
            secrets+=("$entry_secret")
        done

        if [ ${#invalid_entries[@]} -gt 0 ]; then
            echo "ERROR: serviceBus.external mal formado en $config (MEF-ADR-0024):" >&2
            printf '  - %s\n' "${invalid_entries[@]}" >&2
            echo "  Cada entrada requiere: 'alias' no vacio y distinto de INTERNO (reservado)," >&2
            echo "  'alcance' en {compartido, externo}, y 'secretName' no vacio (nombre del" >&2
            echo "  secreto de Key Vault; nunca la cadena en claro)." >&2
            return 1
        fi

        if [ ${#aliases[@]} -gt 0 ]; then
            HARNESS_SB_EXTERNAL_ALIASES="${aliases[*]}"
            HARNESS_SB_EXTERNAL_ALCANCES="${alcances[*]}"
            HARNESS_SB_EXTERNAL_SECRETS="${secrets[*]}"
        fi
        export HARNESS_SB_EXTERNAL_ALIASES HARNESS_SB_EXTERNAL_ALCANCES HARNESS_SB_EXTERNAL_SECRETS
    fi

    # secrets es opcional (issue #256): registro declarativo de todo secreto del BC que
    # el step de siembra data-driven de infra-cd.yml itera en runtime (agents/infra-base-scaffolder.md,
    # Paso 2b), en vez de tener una linea hardcodeada por secreto. Cada entrada declara 'name'
    # (el secreto en Key Vault) y 'source.type'/'source.value' (de donde CI toma el valor a
    # sembrar): 'output' (un unico terraform output, derivable), 'github-secret' (un unico
    # GitHub secret, no derivable) o 'composite' (formula fija reservada para marten-connection --
    # el unico secreto compuesto de varios outputs + un GitHub secret; solo infra-base-scaffolder
    # la escribe, /seed-secret nunca emite 'composite'). Ausente por completo -> exports vacios,
    # sin error (greenfield antes del primer /infra-base).
    export HARNESS_SECRETS_NAMES=""
    export HARNESS_SECRETS_TYPES=""
    export HARNESS_SECRETS_VALUES=""

    local secrets_present
    secrets_present=$(jq -r 'if has("secrets") then "yes" else "no" end' "$config")
    if [ "$secrets_present" = "yes" ]; then
        local secrets_type
        secrets_type=$(jq -r '.secrets | type' "$config")
        if [ "$secrets_type" != "array" ]; then
            echo "ERROR: 'secrets' en $config debe ser un array (issue #256)." >&2
            return 1
        fi

        local sec_count
        sec_count=$(jq -r '.secrets | length' "$config")

        local sec_invalid=() sec_names=() sec_types=() sec_values=()
        local j sec_name sec_type sec_value is_dup_sec existing_name
        for ((j = 0; j < sec_count; j++)); do
            sec_name=$(jq -r ".secrets[$j].name // \"\"" "$config")
            sec_type=$(jq -r ".secrets[$j].source.type // \"\"" "$config")
            sec_value=$(jq -r ".secrets[$j].source.value // \"\"" "$config")

            if [ -z "$sec_name" ]; then
                sec_invalid+=("entrada #$j: 'name' vacio o ausente")
                continue
            fi

            if [ "$sec_type" != "output" ] && [ "$sec_type" != "github-secret" ] && [ "$sec_type" != "composite" ]; then
                sec_invalid+=("entrada #$j (name '$sec_name'): source.type '$sec_type' invalido, debe ser 'output', 'github-secret' o 'composite'")
                continue
            fi

            if [ -z "$sec_value" ]; then
                sec_invalid+=("entrada #$j (name '$sec_name'): 'source.value' vacio o ausente")
                continue
            fi

            is_dup_sec="no"
            if [ ${#sec_names[@]} -gt 0 ]; then
                for existing_name in "${sec_names[@]}"; do
                    if [ "$existing_name" = "$sec_name" ]; then
                        is_dup_sec="yes"
                        break
                    fi
                done
            fi
            if [ "$is_dup_sec" = "yes" ]; then
                sec_invalid+=("entrada #$j: name '$sec_name' duplicado")
                continue
            fi

            sec_names+=("$sec_name")
            sec_types+=("$sec_type")
            sec_values+=("$sec_value")
        done

        if [ ${#sec_invalid[@]} -gt 0 ]; then
            echo "ERROR: 'secrets' mal formado en $config (issue #256):" >&2
            printf '  - %s\n' "${sec_invalid[@]}" >&2
            echo "  Cada entrada requiere: 'name' no vacio y unico, y 'source.type' en" >&2
            echo "  {output, github-secret, composite} con 'source.value' no vacio." >&2
            return 1
        fi

        if [ ${#sec_names[@]} -gt 0 ]; then
            HARNESS_SECRETS_NAMES="${sec_names[*]}"
            HARNESS_SECRETS_TYPES="${sec_types[*]}"
            HARNESS_SECRETS_VALUES="${sec_values[*]}"
        fi
        export HARNESS_SECRETS_NAMES HARNESS_SECRETS_TYPES HARNESS_SECRETS_VALUES
    fi

    # projections es opcional (issue #369, MEF-ADR-0034): token opt-in que declara si el BC
    # adopta el worker de proyecciones. Ausente, null, false, o cualquier valor/tipo distinto
    # del booleano true equivale a deshabilitado -- retrocompatible, nunca aborta la carga
    # (mismo criterio ya usado inline por infra-base-scaffolder/projections-scaffolder).
    # La asignacion lleva `|| true` (mismo motivo que extract_test_count) porque los 9 callers
    # reales corren bajo `set -euo pipefail`: si 'projections' no es un objeto -- el typo
    # `"projections": true` en vez de `{ "enabled": true }` --, jq no puede indexarlo y sale con
    # 5, y sin el `|| true` esa asignacion abortaria TODO el pipeline aqui, con el error de jq ya
    # tragado por el 2>/dev/null: una muerte silenciosa, y justo lo contrario del contrato
    # ("nunca aborta la carga por este campo"). Con `|| true`, proj_raw queda vacio -> "false".
    local proj_raw
    proj_raw=$(jq -r '.projections.enabled // false' "$config" 2>/dev/null) || true
    if [ "$proj_raw" = "true" ]; then
        export HARNESS_PROJECTIONS_ENABLED="true"
    else
        export HARNESS_PROJECTIONS_ENABLED="false"
    fi

    # azureRegionShort/resourceSequence son opcionales (issue #729, MEF-ADR-0045): componentes
    # {region}/{seq} del estandar de nombramiento de recursos. Mismo patron exacto que
    # projections.enabled -- declarar la local aparte y asignar con `|| true` -- para que un
    # config malformado en estos campos no aborte TODO el pipeline bajo `set -euo pipefail`.
    # Un `export VAR=$(...)` de una sola linea NO sirve como proteccion: el builtin enmascara
    # el exit code de la sustitucion (SC2155), asi que el `|| true` de esa forma es codigo
    # muerto. Ausencia o valor invalido degradan a los defaults retrocompatibles ("" y "001"),
    # nunca a un error de carga.
    local region_raw seq_raw
    region_raw=$(jq -r '.azureRegionShort // ""' "$config" 2>/dev/null) || true
    seq_raw=$(jq -r '.resourceSequence // ""' "$config" 2>/dev/null) || true
    export HARNESS_AZURE_REGION_SHORT="${region_raw:-}"
    export HARNESS_RESOURCE_SEQUENCE="${seq_raw:-001}"
}

# upsert_harness_secret <name> <source_type> <source_value> [config_path]
#
# Inserta o actualiza, de forma idempotente, una entrada de harness.config.json > secrets[]
# (issue #256): busca por 'name' (match exacto) y sobreescribe su 'source' si ya existe, o
# agrega la entrada al final del array si no. Crea el array 'secrets' si el config todavia
# no lo declara. Escribe con jq a un temporal y hace 'mv' atomico, para no dejar el config
# a medio escribir si el proceso se interrumpe. La usan infra-base-scaffolder (registro de
# los secretos fijos del BC) y scripts/seed-secret.sh (registro de secretos nuevos).
#
# <source_type> debe ser 'output', 'github-secret' o 'composite' -- no se revalida aqui
# (el caller ya restringe los valores que pasa; load_harness_config valida el resultado
# final la proxima vez que se cargue el config).
#
# Retorna 0 si escribio bien, 1 si el config no existe, es JSON invalido o jq falla.
upsert_harness_secret() {
    local name="$1"
    local source_type="$2"
    local source_value="$3"
    local config canonical legacy
    if [ "$#" -ge 4 ]; then
        config="$4"
    else
        config=$(resolve_harness_config_path write) || return 1
        canonical="$config"
        legacy="${canonical%/.mefisto/harness.config.json}/.claude/harness.config.json"
        if [ ! -f "$canonical" ] && [ -f "$legacy" ]; then
            echo "ERROR: solo existe el config legacy $legacy; no se modificara." >&2
            echo "  Migra conscientemente el archivo completo a $canonical antes de registrar secretos." >&2
            return 1
        fi
    fi

    if [ ! -f "$config" ]; then
        echo "ERROR: no se encontro $config" >&2
        return 1
    fi

    if ! command -v jq >/dev/null 2>&1; then
        echo "ERROR: jq no esta instalado. Requerido para actualizar $config" >&2
        return 1
    fi

    if ! jq empty "$config" >/dev/null 2>&1; then
        echo "ERROR: el JSON de $config no es parseable; no se modifico el archivo." >&2
        return 1
    fi

    local tmp
    tmp=$(mktemp) || return 1

    if ! jq \
        --arg name "$name" \
        --arg type "$source_type" \
        --arg value "$source_value" \
        '
        (.secrets // []) as $existing
        | .secrets = (
            if ($existing | map(.name) | index($name)) != null then
              $existing | map(if .name == $name then {name: $name, source: {type: $type, value: $value}} else . end)
            else
              $existing + [{name: $name, source: {type: $type, value: $value}}]
            end
          )
        ' "$config" > "$tmp"; then
        echo "ERROR: jq fallo al actualizar 'secrets' en $config" >&2
        rm -f "$tmp"
        return 1
    fi

    mv "$tmp" "$config"
}

# resolve_declared_agent_model <agente>
#
# Imprime el valor de la primera clave YAML `model:` del frontmatter publicado
# de agents/<agente>.md. La ruta parte de esta biblioteca distribuida, nunca del
# directorio actual del consumidor. La metadata es opcional: archivo ausente,
# frontmatter sin clave o valor vacio producen stdout vacio y retorno 0.
#
# Retiro acotado (issue #1362, CA-4): tdd-pipeline.sh fue el primero en
# dejar de usarla -- resuelve el modelo efectivo por perfil neutral con
# resolve_tdd_model/mefisto_resolve_model (MEF-ADR-0049 decision 4), pasandolo
# siempre explicito via --model en vez de dejar que el CLI adivine el
# frontmatter. iac-pipeline.sh (issue #1624) y scaffold-pipeline.sh (issue
# #1644) migraron a la misma resolucion neutral despues: ningun pipeline
# publicado consume ya este helper. Sigue viva solo porque scripts/tests/
# la ejerce directamente como unidad (test-stage-models.sh, seccion [0]);
# retirarla del todo es un issue aparte.
resolve_declared_agent_model() {
    local agent="$1" script_dir agent_file line model in_frontmatter="false"

    script_dir="$(_pc_script_dir 2>/dev/null)" || script_dir=""
    [ -n "$script_dir" ] || return 0
    agent_file="$script_dir/../agents/$agent.md"
    [ -f "$agent_file" ] || return 0

    while IFS= read -r line || [ -n "$line" ]; do
        if [ "$in_frontmatter" = "false" ]; then
            [ "$line" = "---" ] && in_frontmatter="true"
            continue
        fi
        [ "$line" = "---" ] && break
        case "$line" in
            model:|model:[[:space:]]*)
                model="${line#*:}"
                model="${model%%[[:space:]]#*}"
                model=$(printf '%s' "$model" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
                case "$model" in
                    \"*\") model="${model#\"}"; model="${model%\"}" ;;
                esac
                [ -n "$model" ] && printf '%s\n' "$model"
                return 0
                ;;
        esac
    done < "$agent_file"

    return 0
}

# --- Asignacion de modelo por stage (--models, issue #708) -------------------
#
# Mecanismo de experimentos A/B de desempeno del harness (calidad/velocidad/costo
# por modelo): permite sobreescribir, por invocacion del pipeline, el modelo que
# corre cada stage sin tocar el default hardcodeado en el `case` de run_agent().
# Requisito invariante del issue: sin el flag --models, el comportamiento es
# byte a byte el actual -- por eso resolve_stage_model() cae siempre al default
# del caller cuando no hay override, y parse_stage_models() con spec vacio deja
# PIPELINE_STAGE_MODELS vacio (ninguna resolucion encuentra match).
#
# Formato interno de PIPELINE_STAGE_MODELS: pares "agente=modelo" separados por
# salto de linea -- no un array asociativo, porque bash 3.2 (macOS, ver notas de
# bash 3.2 en tmux-pipeline.sh) no lo soporta.

# parse_stage_models <spec>
#
# Parsea el valor crudo del flag --models ('agente=modelo[,agente=modelo...]')
# y lo deja en la variable global PIPELINE_STAGE_MODELS para que
# resolve_stage_model() lo consulte. El caller debe invocarla ANTES de crear el
# worktree (CA-1): una entrada malformada debe abortar temprano, no a mitad de
# Stage 1 con un worktree ya creado.
#
# No valida el NOMBRE del modelo (alias como 'sonnet'/'opus' o un id completo
# como 'claude-opus-5[1m]' son ambos pass-through, sin allowlist propia -- los
# alias evolucionan con el CLI; ver Notas tecnicas del issue #708): solo la
# forma 'clave=valor' de cada entrada y que ninguna clave de agente se repita.
# Un modelo invalido lo delata el patron de error existente del stream
# (result.is_error, ya clasificado por run_agent()).
#
# En caso de entrada malformada, retorna 1 y deja el motivo en
# PIPELINE_STAGE_MODELS_ERROR (un mensaje de una linea, listo para pasarle a
# abort()) -- no imprime nada por si misma, para que todo pipeline que la
# invoque controle el formato exacto del error (mismo criterio que el resto de
# los helpers de este archivo, p. ej. upsert_harness_secret).
#
# Con spec vacio (flag no pasado), deja PIPELINE_STAGE_MODELS vacio y retorna 0
# sin error: es el camino "sin --models", el que debe preservar el
# comportamiento byte a byte actual.
parse_stage_models() {
    local spec="$1"
    PIPELINE_STAGE_MODELS=""
    PIPELINE_STAGE_MODELS_ERROR=""
    [ -z "$spec" ] && return 0

    local entries=() entry agent model seen=$'\n'
    IFS=',' read -ra entries <<< "$spec"
    for entry in "${entries[@]}"; do
        [ -z "$entry" ] && continue
        case "$entry" in
            *=*) ;;
            *)
                PIPELINE_STAGE_MODELS_ERROR="entrada '$entry' no tiene la forma agente=modelo"
                return 1
                ;;
        esac
        agent="${entry%%=*}"
        model="${entry#*=}"
        if [ -z "$agent" ] || [ -z "$model" ]; then
            PIPELINE_STAGE_MODELS_ERROR="entrada '$entry': agente y modelo no pueden estar vacios"
            return 1
        fi
        case "$seen" in
            *$'\n'"$agent"$'\n'*)
                PIPELINE_STAGE_MODELS_ERROR="el agente '$agent' esta repetido"
                return 1
                ;;
        esac
        seen="${seen}${agent}"$'\n'
        PIPELINE_STAGE_MODELS="${PIPELINE_STAGE_MODELS}${PIPELINE_STAGE_MODELS:+$'\n'}${agent}=${model}"
    done
    return 0
}

# resolve_stage_model <agente> <default>
#
# Imprime por stdout el modelo a usar para <agente>: el override de
# PIPELINE_STAGE_MODELS (poblado por parse_stage_models) si <agente> tiene una
# entrada de clave EXACTA en el mapa, o <default> si no hay mapa cargado o
# <agente> no aparece en el. Pura -- no valida ni aborta, ese trabajo ya lo hizo
# parse_stage_models(). Siempre retorna 0.
resolve_stage_model() {
    local agent="$1" default="$2"
    local line
    if [ -n "${PIPELINE_STAGE_MODELS:-}" ]; then
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            if [ "${line%%=*}" = "$agent" ]; then
                echo "${line#*=}"
                return 0
            fi
        done <<< "$PIPELINE_STAGE_MODELS"
    fi
    echo "$default"
    return 0
}

# format_stage_models_for_log
#
# Imprime por stdout una representacion de una linea de PIPELINE_STAGE_MODELS
# ("agente=modelo, agente=modelo") lista para log()/eventos (CA-4:
# auditabilidad del mapa de overrides aplicado). Cadena vacia si no hay mapa
# cargado (sin --models). Siempre retorna 0.
format_stage_models_for_log() {
    [ -z "${PIPELINE_STAGE_MODELS:-}" ] && return 0
    echo "$PIPELINE_STAGE_MODELS" | tr '\n' ',' | sed 's/,/, /g; s/, $//'
    return 0
}

# runtime_cli_available <runtime>
# Consulta la disponibilidad a traves del adaptador descubierto, sin que un
# pipeline tenga que conocer el nombre o el wire format de ningun runtime.
runtime_cli_available() {
    local runtime="$1" lib="${MEFISTO_RUNTIME_LIB_DIR:-}/runtime-${1}.sh" fn
    [ -f "$lib" ] || return 1
    (
        source "$lib" >/dev/null 2>&1 || exit 1
        fn="runtime_${runtime}_is_available"
        declare -F "$fn" >/dev/null 2>&1 || exit 1
        "$fn"
    )
}

# runtime_supports_resume <runtime>
runtime_supports_resume() {
    local runtime="$1" lib="${MEFISTO_RUNTIME_LIB_DIR:-}/runtime-${1}.sh" fn
    [ -f "$lib" ] || return 1
    (
        source "$lib" >/dev/null 2>&1 || exit 1
        fn="runtime_${runtime}_supports_resume"
        declare -F "$fn" >/dev/null 2>&1 || exit 1
        "$fn"
    )
}

# agent_events_value <events-jsonl> <jq-expression>
# El terminal normalizado es la unica autoridad para politica de pipeline.
agent_events_value() {
    local events="$1" expression="$2"
    [ -s "$events" ] || return 0
    jq -r -s "$expression" "$events" 2>/dev/null || true
}
agent_events_kind() { agent_events_value "$1" '[.[] | select(.type == "run.failed" or .type == "run.completed") | .error.kind // empty] | last // empty'; }
agent_events_resets_at() { agent_events_value "$1" '[.[] | select(.type == "run.failed" or .type == "run.completed") | .error.resets_at // .resets_at // empty] | last // empty'; }
agent_events_session_id() { agent_events_value "$1" '[.[] | select(.type == "run.failed" or .type == "run.completed") | .session_id // empty] | last // empty'; }
agent_events_denials() { agent_events_value "$1" '[.[] | select(.type == "run.failed" or .type == "run.completed") | .denials // 0] | last // 0'; }

agent_events_completed_successfully() {
    local events="$1"
    [ -s "$events" ] || return 1
    jq -e -s '[.[] | select(.type == "run.failed" or .type == "run.completed")] | last | .type == "run.completed" and .status == "success"' "$events" >/dev/null 2>&1
}

classify_neutral_agent_failure() {
    local run_exit="$1" events="$2" kind
    case "$run_exit" in 124) echo "TIMEOUT"; return ;; 65) echo "PROTOCOL_INVALID"; return ;; esac
    kind="$(agent_events_kind "$events")"
    case "$kind" in
        provider_unavailable) echo "PROVIDER_UNAVAILABLE" ;; rate_limit) echo "RATE_LIMIT" ;;
        timeout) echo "TIMEOUT" ;; killed) echo "KILLED" ;; stream_cut) echo "STREAM_CUT" ;;
        protocol_invalid) echo "PROTOCOL_INVALID" ;; api_error) echo "API_ERROR_CLIENT" ;;
        nonzero_exit|no_result) echo "CLI_ERROR" ;;
        *) echo "CLI_ERROR" ;;
    esac
}

# --- Modo --variant: corridas paralelas del mismo issue (issue #710) --------
#
# Segunda pieza del mecanismo de experimentos por modelo (la primera es
# --models, issue #708): correr el MISMO issue N veces en paralelo, cada
# corrida en su propio worktree/rama, para comparar calidad/velocidad/costo
# entre variantes. Sin este modo, dos corridas simultaneas del mismo issue
# colisionan porque worktree y rama derivan solo del numero de issue.
#
# validate_variant_label() es la unica pieza de este mecanismo que vive aqui:
# el resto (sufijar worktree/rama/logs con el label, suprimir push/PR/
# comentario al issue) es codigo lineal propio de tooling-pipeline.sh, sin
# logica compartida que valga la pena extraer.

# validate_variant_label <label>
#
# Valida el label de --variant (CA-1): slug de minusculas, digitos y guiones
# ([a-z0-9-]), longitud 1-40 -- el mismo tope que ya usa el slug del titulo
# del issue en tooling-pipeline.sh (`cut -c1-40`), para que
# "worktree-issue-<N>-<slug>-<label>" no dispare el nombre de rama/carpeta
# mas alla de lo practico. El caller debe invocarla ANTES de crear el
# worktree: un label malformado debe abortar temprano, igual que
# parse_stage_models con --models.
#
# Retorna 0 si valido. Retorna 1 y deja el motivo en
# PIPELINE_VARIANT_LABEL_ERROR (una linea, lista para abort()) si no --
# mismo contrato que PIPELINE_STAGE_MODELS_ERROR.
validate_variant_label() {
    local label="$1"
    PIPELINE_VARIANT_LABEL_ERROR=""

    if [ -z "$label" ]; then
        PIPELINE_VARIANT_LABEL_ERROR="el label de --variant no puede estar vacio"
        return 1
    fi
    if [ "${#label}" -gt 40 ]; then
        PIPELINE_VARIANT_LABEL_ERROR="el label de --variant '$label' supera 40 caracteres"
        return 1
    fi
    if ! printf '%s' "$label" | grep -Eq '^[a-z0-9-]+$'; then
        PIPELINE_VARIANT_LABEL_ERROR="el label de --variant '$label' es invalido: solo minusculas, digitos y guiones ([a-z0-9-])"
        return 1
    fi
    return 0
}

# --- Helpers de tests, compartidos por los gates de tdd-pipeline.sh, ---------
# --- tooling-pipeline.sh y pr-sync.sh (issue #305) ----------------------------
#
# Consolida run_tests_projects y extract_test_count, que hasta el issue #305
# vivian duplicadas byte-a-byte en tdd-pipeline.sh y tooling-pipeline.sh — y
# ausentes en pr-sync.sh, que corria `dotnet test --solution` y por tanto
# incluia los proyectos *.SmokeTests en su gate post-merge (401/ServiceBus no
# configurado en runs locales sin credenciales de entorno). Una sola
# definicion evita que un fix futuro (como #302) tenga que aplicarse mas de
# una vez.

# extract_test_count <dotnet_test_output>
#
# Extrae el conteo de tests pasando del resumen de dotnet test. Soporta
# Microsoft.Testing.Platform ("Test summary: ... succeeded: N"), MTP localizado
# ("correcto: N") y VSTest clasico ("Superado: N" / "Passed: N").
#
# Suma los N de TODAS las lineas de resumen del output combinado (una por cada
# proyecto de test que corre run_tests_projects), no solo el primero: con
# --project por proyecto el output trae una linea de resumen por cada uno.
# Sumar la suite completa evita un falso "se perdieron tests" en el gate de
# refactoring cuando un refactor mueve tests entre proyectos sin cambiar el
# total (issue #80).
#
# Contratos preservados:
#   - Sentinela "?": si no hubo ningun marcador parseable, awk imprime "?" en
#     su bloque END, no 0 — para que el gate lo trate como "no comparable" y no
#     aborte por una suma vacia interpretada como 0.
#   - Salida entera limpia: imprime un unico entero (la suma) para la comparacion
#     `-lt` de bash del gate.
#   - La asignacion lleva `|| true` para degradar a "?" si awk no esta disponible
#     o no puede procesar la salida, incluso bajo `set -euo pipefail`.
extract_test_count() {
    local count
    count=$(printf '%s\n' "$1" | awk '
        {
            line = tolower($0)
            summary = line
            while (match(line, /(correcto|correctas|passed|superado):[[:space:]]*[0-9]+/)) {
                value = substr(line, RSTART, RLENGTH)
                sub(/.*:[[:space:]]*/, "", value)
                total += value
                found = 1
                line = substr(line, RSTART + RLENGTH)
            }
            if (summary ~ /test summary:/ && match(summary, /succeeded:[[:space:]]*[0-9]+/)) {
                value = substr(summary, RSTART, RLENGTH)
                sub(/.*:[[:space:]]*/, "", value)
                total += value
                found = 1
            }
        }
        END { if (found) print total; else print "?" }
    ') || true
    echo "${count:-?}"
}

# tests_json_value <conteo>
#
# Convierte el sentinela "?" (o cualquier valor no numerico) en null antes de
# cruzar la frontera JSON. extract_test_count conserva ese sentinela porque el
# gate de refactor distingue un conteo desconocido de cero; la evidencia durable
# en cambio solo admite un entero no negativo o null.
tests_json_value() {
    local tests="${1:-}"
    if [[ "$tests" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$tests"
    else
        printf '%s\n' 'null'
    fi
}

# append_completed_history <history_file> <events_log> <comando-json...>
#
# Ejecuta el comando que produce una entrada JSONL y la agrega al historial. El
# cierre ocurre despues de crear el PR: un fallo de serializacion o escritura es
# bookkeeping no critico, por lo que deja advertencia visible y evidencia en el
# events log, pero siempre retorna 0.
append_completed_history() {
    local history_file="$1" events_log="$2"
    shift 2

    if "$@" >> "$history_file"; then
        return 0
    fi

    warn "No se pudo registrar el historial completado; el PR ya fue creado" || true
    printf '[%s] WARN: no se pudo registrar el historial completado; el PR ya fue creado\n' \
        "$(date +%H:%M:%S)" >> "$events_log" 2>/dev/null || true
    return 0
}

# run_tests_projects <worktree_path> [flags-extra-de-dotnet-test...]
#
# Ejecuta dotnet test solo sobre los proyectos *.Tests/ (unit + contratos) de
# <worktree_path>, excluyendo *.SmokeTests/. Los smoke tests son black-box
# contra el entorno dev desplegado (endpoints AuthorizationLevel.Function,
# dependencias reales de ServiceBus/Postgres); incluirlos en un gate local que
# corre sin credenciales de entorno los hace fallar con 401/404 aunque el
# codigo este bien. Los smoke tests siguen cubiertos post-deploy via
# smoke-tests-dominio.yml (MEF-ADR-0013).
#
# Imprime: stdout combinado de todos los proyectos.
# Exit code: 0 si todos pasan, primer codigo de fallo (!= 0 y != 8) si alguno
# falla, 8 si NINGUN proyecto tenia tests para ejecutar.
run_tests_projects() {
    local worktree="$1"
    shift
    local combined_output=""
    local combined_rc=0
    local any_tests_ran=false
    local proj proj_rc proj_output
    for proj in "$worktree"/tests/${HARNESS_NAMESPACE_PREFIX}.*.Tests/; do
        [ -d "$proj" ] || continue
        proj_rc=0
        proj_output=$(dotnet test --project "$proj" "$@" 2>&1) || proj_rc=$?
        combined_output+="$proj_output"$'\n'
        if [ "$proj_rc" -ne 8 ]; then
            any_tests_ran=true
        fi
        if [ "$proj_rc" -ne 0 ] && [ "$proj_rc" -ne 8 ] && [ "$combined_rc" -eq 0 ]; then
            combined_rc=$proj_rc
        fi
    done
    printf "%s" "$combined_output"
    if [ "$combined_rc" -eq 0 ] && [ "$any_tests_ran" = false ]; then
        return 8
    fi
    return $combined_rc
}

# _red_method_body <metodo>   (stdin: fuente C#)
#
# Imprime el bloque del primer metodo cuya firma contiene "<metodo>(": desde la
# linea de la firma hasta que las llaves balancean (o hasta el ';' de un cuerpo
# con '=>'). Sin coincidencia no imprime nada.
_red_method_body() {
    awk -v m="$1" '
        !found && $0 ~ ("[[:space:]]" m "[[:space:]]*\\(") { found=1; arrow=($0 ~ /=>/) }
        found && !done {
            print
            line=$0
            if (!seen && arrow && line !~ /\{/) { if (line ~ /;[[:space:]]*$/) done=1; next }
            n=gsub(/\{/,"{",line); c=gsub(/\}/,"}",line)
            depth+=n-c
            if (n>0) seen=1
            if (seen && depth<=0) done=1
        }
    '
}

# detect_preexisting_red_tests <worktree> <snapshot_commit> <test_output>
#
# Issue #1937: tras la fase roja, identifica tests en rojo que YA existian en
# <snapshot_commit> y cuyo cuerpo el test-writer NO modifico (candidatos a pin
# desactualizado, o a stub sobre codigo existente). Mecanismo:
#   1. Parsea de <test_output> las lineas de fallo de Microsoft Testing Platform
#      ("failed <Nombre> (<dur>)"); toma el ultimo segmento punteado sin parametros.
#   2. Localiza el metodo en tests/**/*.cs del arbol de <snapshot_commit>
#      (git grep, sin recompilar). Si no existe ahi, es un test nuevo: se ignora.
#   3. Compara el bloque del metodo en el snapshot contra el archivo actual; si es
#      identico, se reporta. Si cambio, o ya no esta, no se reporta.
# Imprime una linea "<test>\t<archivo>" por cada test reportado.
# Exit: 0 analisis completo (con o sin reportes); 2 salida no parseable o fallo
# del analisis. Nunca aborta: el llamador degrada a warn.
detect_preexisting_red_tests() {
    local worktree="$1" snapshot="$2" output="$3"
    local names name method hit file old new seen=" "
    names=$(printf '%s\n' "$output" | sed 's/\x1b\[[0-9;]*m//g' \
        | sed -nE 's/^[[:space:]]*(failed|✗|×)[[:space:]]+([^[:space:]]+).*/\2/p') || return 2
    [ -n "$names" ] || return 2
    git -C "$worktree" rev-parse --verify -q "${snapshot}^{commit}" >/dev/null 2>&1 || return 2
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        method="${name%%(*}"
        method="${method##*.}"
        [[ "$method" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        case "$seen" in *" $method "*) continue ;; esac
        seen+="$method "
        hit=$(git -C "$worktree" grep -l -E "[[:space:]]${method}[[:space:]]*\\(" "$snapshot" -- 'tests/*.cs' 2>/dev/null) || continue
        while IFS= read -r file; do
            [ -n "$file" ] || continue
            file="${file#"$snapshot":}"
            old=$(git -C "$worktree" show "$snapshot:$file" 2>/dev/null | _red_method_body "$method")
            [ -n "$old" ] || continue
            [ -f "$worktree/$file" ] || continue
            new=$(_red_method_body "$method" < "$worktree/$file")
            if [ "$old" = "$new" ]; then
                printf '%s\t%s\n' "$method" "$file"
                break
            fi
        done <<< "$hit"
    done <<< "$names"
    return 0
}

# preexisting_red_only <worktree> <snapshot_commit> <test_output>
#
# Issue #2062 (Gate 2): imprime la lista de detect_preexisting_red_tests solo si
# TODOS los tests en rojo de <test_output> son preexistentes no modificados.
# Exit: 0 todos preexistentes (lista en stdout); 1 hay algun rojo fuera de la
# lista; 2 el analisis fallo o la salida no es parseable.
preexisting_red_only() {
    local worktree="$1" snapshot="$2" output="$3"
    local list rc=0 names name method
    list=$(detect_preexisting_red_tests "$worktree" "$snapshot" "$output" 2>/dev/null) || rc=$?
    [ "$rc" -eq 0 ] || return 2
    [ -n "$list" ] || return 1
    names=$(printf '%s\n' "$output" | sed 's/\x1b\[[0-9;]*m//g' \
        | sed -nE 's/^[[:space:]]*(failed|✗|×)[[:space:]]+([^[:space:]]+).*/\2/p') || return 2
    [ -n "$names" ] || return 2
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        method="${name%%(*}"
        method="${method##*.}"
        printf '%s\n' "$list" | cut -f1 | grep -qxF -- "$method" || return 1
    done <<< "$names"
    printf '%s\n' "$list"
    return 0
}

# list_reviewer_touched_tests <worktree> <base_head>
#
# Issue #2062: archivos de tests/ modificados, renombrados o eliminados entre
# <base_head> (HEAD de Stage 2) y el HEAD actual (Stage 3). Un archivo por linea.
list_reviewer_touched_tests() {
    local worktree="$1" base="$2"
    git -C "$worktree" diff --name-only --diff-filter=MDR "$base" HEAD -- 'tests/' 2>/dev/null
}

# render_warning_remnants_section <worktree>
#
# Issue #2408 (MEF-ADR-0056): imprime la seccion "## Warnings remanentes" con una
# linea "- Relacionado: <ref>" por referencia distinta (orden de primera aparicion),
# leida de <worktree>/.mefisto/pipeline/warnings-remanentes.txt. Acepta "#N", "N" (se
# normaliza a "#N") y "owner/repo#N"; ignora el resto. Sin archivo o sin referencias
# no imprime nada.
render_warning_remnants_section() {
    local file="$1/.mefisto/pipeline/warnings-remanentes.txt"
    [ -f "$file" ] || return 0
    local refs
    refs=$(awk '
        {
            gsub(/\r/, ""); gsub(/^[ \t]+|[ \t]+$/, "")
            if ($0 ~ /^#[0-9]+$/) ref = $0
            else if ($0 ~ /^[0-9]+$/) ref = "#" $0
            else if ($0 ~ /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/) ref = $0
            else next
            if (!(ref in seen)) { seen[ref] = 1; print ref }
        }' "$file")
    [ -n "$refs" ] || return 0
    printf '## Warnings remanentes\n\n'
    while IFS= read -r ref; do
        printf -- '- Relacionado: %s\n' "$ref"
    done <<< "$refs"
    printf '\n'
}

# render_reviewer_touched_tests_section <files> <blockage_resolved>
#
# Issue #2438: imprime la seccion "## Tests ajustados por el reviewer" del body del PR
# con una linea "- `<ruta>`" por archivo (un archivo por linea en <files>). Si
# <blockage_resolved> es "true" agrega la linea de destrabe tras la fase verde. Sin
# archivos no imprime nada. No incluye diff ni reporte: el diff ya esta en el PR.
render_reviewer_touched_tests_section() {
    local files="${1:-}" blockage_resolved="${2:-false}" f
    local -a list=()
    while IFS= read -r f; do [ -n "$f" ] && list+=("$f"); done <<< "$files"
    [ "${#list[@]}" -gt 0 ] || return 0
    printf '## Tests ajustados por el reviewer\n\n'
    printf 'El reviewer modifico, renombro o elimino estos tests existentes en la fase refactor; se revisan en el diff del PR.\n\n'
    if [ "$blockage_resolved" = "true" ]; then
        printf 'Lo hizo al destrabar tests en rojo despues de la fase verde.\n\n'
    fi
    for f in "${list[@]}"; do
        printf -- '- `%s`\n' "$f"
    done
    printf '\n'
}

# --- Derivacion de log legible desde eventos de agente ----------------------

# derive_stage_log_from_stream <events_file> <legacy_stderr_file> <out_file>
#
# Deriva el log legible de un stage desde el JSONL neutral del runner. El segundo
# argumento conserva la firma de callers legacy: solo se anexa cuando el primer
# archivo contiene su vocabulario stream-json legado. Nunca se anexa stderr a la
# evidencia neutral, porque stderr puede contener entradas sensibles.
#
# El evento `result` con `is_error == true` tambien se deriva, prefijado con
# "API Error: <status>" cuando el CLI reporta api_error_status: en una corrida
# fallida ese texto no siempre llega por stderr, y classify_agent_failure
# (mas abajo, issue #971) clasifica fallos con `grep "API Error: 5"`/
# `"API Error: 4"` sobre <out_file> -- sin esta linea esos greps nunca
# matchean y un 5xx se clasificaria como CLI_ERROR generico en vez de
# PROVIDER_UNAVAILABLE.
#
# El nombre y la ruta de <out_file> NO cambian (sigue siendo el mismo .log de
# siempre): los greps de classify_agent_failure lo siguen leyendo sin saberlo.
#
# Tolera un stream truncado (proceso muerto a mitad de escritura, p. ej. por
# el watchdog de timeout) o vacio via `fromjson?`. Sin jq en el PATH, deja una
# nota explicita y de todos modos anexa <stderr_file>. Nunca aborta: retorna
# siempre 0.
derive_stage_log_from_stream() {
    local stream_file="$1" stderr_file="$2" out_file="$3"

    : > "$out_file" 2>/dev/null || return 0

    if [ -s "$stream_file" ]; then
        if command -v jq >/dev/null 2>&1; then
            if jq -R -s -e 'split("\n") | map(try fromjson catch empty) | any(.[]; .type == "run.started" or .type == "run.completed" or .type == "run.failed")' "$stream_file" >/dev/null 2>&1; then
                jq -R -r '
                    fromjson?
                    | select(type == "object")
                    | if .type == "tool.started" then "[tool] " + (.tool // .name // "?")
                    elif .type == "run.failed" then (.error.kind // "error")
                    elif .type == "run.completed" then (.status // "completed")
                    else empty end
                ' "$stream_file" >> "$out_file" 2>/dev/null || true
            else
                jq -R -r '
                    fromjson?
                    | select(type == "object")
                    | if .type == "assistant" then
                      (.message.content // [])[]?
                      | if .type == "text" then (.text // "")
                        elif .type == "tool_use" then "[tool] " + (.name // "?")
                        else empty end
                  elif .type == "message" then (.text // "")
                  elif .type == "tool.started" then "[tool] " + (.tool // "?")
                  elif .type == "run.failed" then ((.error.detail // .error.kind // "error") | tostring)
                  elif .type == "result" and .is_error == true then
                      (if (.api_error_status // null) != null
                         then "API Error: " + (.api_error_status | tostring) + " "
                         else "" end)
                      + ((.result // .error // .terminal_reason // .subtype // "error") | tostring)
                      else empty end
                ' "$stream_file" >> "$out_file" 2>/dev/null || true
            fi
        else
            echo "(jq no disponible: no se pudo derivar texto legible del stream crudo -- ver $stream_file)" >> "$out_file"
        fi
    fi

    # Solo los callers legacy conservan este comportamiento transitorio.
    if [ -s "$stderr_file" ] && ! jq -R -s -e 'split("\n") | map(try fromjson catch empty) | any(.[]; .type == "run.started" or .type == "run.completed" or .type == "run.failed")' "$stream_file" >/dev/null 2>&1; then
        [ -s "$out_file" ] && echo "" >> "$out_file"
        cat "$stderr_file" >> "$out_file" 2>/dev/null || true
    fi

    return 0
}

# --- Metricas por stage a partir de la traza stream-json (issue #646, porte -
# --- publicado de compute_stage_metrics/build_agents_history_json del interno
# --- #426, sobre la traza que ya captura derive_stage_log_from_stream arriba) -

# compute_stage_metrics <stream_file>
#
# Deriva las metricas de un stage a partir del stream JSON crudo que
# tdd-pipeline.sh ya captura con `claude -p --output-format stream-json
# --verbose` (issue #645): turnos, duraciones (total/API/no-API), costo
# estimado o costo legado, tokens desglosados, modelo, motivo de fin y un
# histograma de tool calls por
# nombre (count + tiempo atribuido, suma y mediana, via emparejamiento
# tool_use.id <-> tool_use_id, ambos fechados por el `timestamp` ISO-8601 de
# nivel superior de cada evento). Porte de la forma neutral del interno,
# conservando el fallback tolerante para trazas Claude previas al contrato. Los
# terminales neutrales nuevos se copian sin reinterpretarlos;
# una traza Claude previa conserva `total_cost_usd` exclusivamente como
# `cost_usd` legado, nunca como estimacion.
#
# Imprime por stdout un JSON compacto de una sola linea, o el literal "null"
# si no hay nada que derivar. Nunca aborta y siempre retorna 0 (CA-4): sin
# jq, con el stream vacio, o si el evento `result` no aparece (stage matado
# a mitad de corrida por el watchdog, sin chance de escribirlo), degrada a
# "null".
compute_stage_metrics() {
    local stream_file="$1"

    if ! command -v jq >/dev/null 2>&1; then
        echo "null"
        return 0
    fi
    if [ ! -s "$stream_file" ]; then
        echo "null"
        return 0
    fi

    # El protocolo neutral no expone texto/wire data. Su terminal contiene las
    # cifras correlacionables; esta rama se selecciona por vocabulario, nunca por
    # runtime, para no reinterpretar accidentalmente un stream nativo. Los cinco
    # contadores y estimated_cost_usd se copian tal cual: jq `//` conserva 0 y
    # solo usa el operando derecho para null o false.
    if jq -R -s -e 'split("\n") | map(try fromjson catch empty) | any(.[]; .type == "run.completed" or .type == "run.failed")' "$stream_file" >/dev/null 2>&1; then
        local neutral
        neutral=$(jq -R -s -c '
            split("\n") | map(try fromjson catch empty)
            | [.[] | select(.type == "run.completed" or .type == "run.failed")] | last as $t
            | if $t == null then null else {
                turns: ($t.turns // $t.num_turns),
                duration_ms: ($t.duration_ms // $t.duration),
                duration_api_ms: ($t.api_duration_ms // $t.duration_api_ms),
                non_api_ms: (if (($t.duration_ms // $t.duration) != null and ($t.api_duration_ms // $t.duration_api_ms) != null) then (($t.duration_ms // $t.duration) - ($t.api_duration_ms // $t.duration_api_ms)) else null end),
                estimated_cost_usd: $t.estimated_cost_usd,
                tokens: {
                  input: ($t.tokens.input // $t.usage.input_tokens),
                  output: ($t.tokens.output // $t.usage.output_tokens),
                  cache_read: ($t.tokens.cache_read // $t.usage.cache_read_input_tokens),
                  cache_write: ($t.tokens.cache_write // $t.tokens.cache_creation // $t.usage.cache_write_input_tokens // $t.usage.cache_creation_input_tokens),
                  reasoning: ($t.tokens.reasoning // $t.usage.reasoning_tokens)
                },
                model: ($t.model // $t.effective_model),
                is_error: ($t.type == "run.failed"),
                stop_reason: $t.status,
                terminal_reason: ($t.error.kind // null),
                ttft_ms: $t.ttft_ms,
                permission_denials: ($t.denials // null),
                rate_limit_events: null,
                tool_calls: []
              } end
        ' "$stream_file" 2>/dev/null) || neutral=""
        printf '%s\n' "${neutral:-null}"
        return 0
    fi

    local out
    out=$(jq -R -s -c '
        def parse_ts:
            if . == null or (type != "string") then null
            else
                ((capture("^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.(?<frac>[0-9]+))?Z$")) // null) as $c
                | if $c == null then null
                  else
                      (($c.base + "Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) as $sec
                      | $sec * 1000 + (if $c.frac then (($c.frac + "000") | .[0:3] | tonumber) else 0 end)
                  end
            end;

        def median:
            sort as $s
            | ($s | length) as $n
            | if $n == 0 then null
              elif ($n % 2) == 1 then $s[($n - 1) / 2]
              else ($s[$n / 2 - 1] + $s[$n / 2]) / 2
              end;

        (split("\n") | map(select(length > 0)) | map(try fromjson catch empty) | map(select(type == "object"))) as $events
        | ($events | map(select(.type == "result")) | last) as $result
        | if $result == null then null
          else
              ($events | map(select(.type == "system" and .subtype == "init")) | first | .model) as $model_from_init
            | ($events | map(select(.type == "assistant")) | first | .message.model) as $model_from_assistant
            | (
                [ $events[] | select(.type == "assistant") | . as $ev
                  | ($ev.message.content // [])[]?
                  | select(.type == "tool_use")
                  | {id: .id, name: .name, ts: (try ($ev.timestamp | parse_ts) catch null)}
                ]
              ) as $tool_uses
            | (
                [ $events[] | select(.type == "user") | . as $ev
                  | ($ev.message.content // [])[]?
                  | select(.type == "tool_result")
                  | {id: .tool_use_id, ts: (try ($ev.timestamp | parse_ts) catch null)}
                ]
              ) as $tool_results
            | ($tool_results | INDEX(.id)) as $results_by_id
            | (
                $tool_uses
                | group_by(.name)
                | map(
                    . as $group
                    | ($group | map(
                        . as $u
                        # `// ""` y no `[$u.id]` a secas: en jq indexar un
                        # objeto con null es un error DURO (no algo que `try`
                        # local atrape aqui), y ese error tumba la expresion
                        # entera -- un unico tool_use sin `id` dejaria el
                        # stage sin NINGUNA metrica, aunque el evento
                        # `result` viniera completo. Con la clave vacia el
                        # lookup solo devuelve null: la tool call sigue
                        # contando en `count` y las demas no se pierden.
                        | ($results_by_id[$u.id // ""]) as $r
                        | select($r != null and $u.ts != null and $r.ts != null)
                        | ($r.ts - $u.ts)
                      )) as $durations
                    | {
                        name: $group[0].name,
                        count: ($group | length),
                        duration_ms_sum: (if ($durations | length) > 0 then ($durations | add) else null end),
                        duration_ms_median: (if ($durations | length) > 0 then ($durations | median) else null end)
                      }
                  )
                | sort_by(.name)
              ) as $tool_calls
            | {
                turns: $result.num_turns,
                duration_ms: $result.duration_ms,
                duration_api_ms: $result.duration_api_ms,
                non_api_ms: (if ($result.duration_ms != null and $result.duration_api_ms != null) then ($result.duration_ms - $result.duration_api_ms) else null end),
                # total_cost_usd de Claude stream-json es un dato legado: se
                # conserva bajo cost_usd y no se rebautiza como estimacion.
                estimated_cost_usd: null,
                cost_usd: $result.total_cost_usd,
                tokens: {
                    input: $result.usage.input_tokens,
                    output: $result.usage.output_tokens,
                    cache_read: $result.usage.cache_read_input_tokens,
                    cache_write: $result.usage.cache_creation_input_tokens,
                    reasoning: $result.usage.reasoning_tokens
                },
                model: ($model_from_init // $model_from_assistant),
                is_error: $result.is_error,
                stop_reason: $result.stop_reason,
                terminal_reason: $result.terminal_reason,
                ttft_ms: $result.ttft_ms,
                permission_denials: (if ($result.permission_denials | type) == "array" then ($result.permission_denials | length) else null end),
                rate_limit_events: ($events | map(select(.type == "rate_limit_event")) | length),
                tool_calls: $tool_calls
              }
          end
    ' "$stream_file" 2>/dev/null) || out=""

    if [ -n "$out" ]; then
        echo "$out"
    else
        echo "null"
    fi
    return 0
}

# enrich_stage_metrics <pipeline> <events> <base_metrics> <issue> <variant_json>
#                       <stage> <agent> <profile> <identity_json>
#
# Agrega dimensiones de correlacion del writer headless sin cambiar las claves
# historicas que consume metrics-report.sh. Requested/effective model provienen
# exclusivamente de run.started y del unico terminal neutral, respectivamente.
# Generalizada desde enrich_tooling_stage_metrics (issue #1063) a cualquier
# pipeline publicado (issue #1363): <pipeline> viaja explicito en vez de fijo
# a "tooling", para que tdd-pipeline.sh reuse la misma forma de metricas.
enrich_stage_metrics() {
    local pipeline="$1" events_file="$2" base_metrics="$3" issue="$4" variant_json="$5"
    local stage="$6" agent="$7" profile="$8" identity_json="$9"
    jq -R -s -c \
        --arg pipeline "$pipeline" \
        --argjson metrics "${base_metrics:-null}" \
        --arg issue "$issue" --argjson variant "$variant_json" \
        --arg stage "$stage" --arg agent "$agent" --arg profile "$profile" \
        --argjson identity "$identity_json" '
        split("\n") | map(try fromjson catch empty) as $events
        | ($events | map(select(.type == "run.started")) | first) as $started
        | ($events | map(select(.type == "run.completed" or .type == "run.failed")) | last) as $terminal
        | ($metrics // {}) + {
            pipeline: $pipeline, issue: $issue, variant: $variant,
            stage: $stage, agent: $agent,
            runtime: ($terminal.runtime // $started.runtime // null),
            profile: $profile,
            requested_model: ($started.model // null),
            effective_model: ($terminal.model // null),
            inherited: (($started.model // null) == null),
            session_id: ($terminal.session_id // null),
            result: ($terminal.status // null),
            error_kind: ($terminal.error.kind // null),
            harness_version: $identity.harness_version,
            harness_commit: $identity.harness_commit,
            identity_state: $identity.identity_state
          }
    ' "$events_file" 2>/dev/null || printf '%s\n' 'null'
}

# enrich_tooling_stage_metrics <events> <base_metrics> <issue> <variant_json>
#                              <stage> <agent> <profile> <identity_json>
#
# Wrapper historico con pipeline="tooling" fijo (issue #1063): conserva su
# firma exacta -- tooling-pipeline.sh, test-stage-metrics.sh y
# test-tooling-neutral-runner.sh la invocan sin el argumento <pipeline>.
enrich_tooling_stage_metrics() {
    enrich_stage_metrics "tooling" "$@"
}

# render_run_metrics_table <etiqueta> <duracion_segundos> <metrics_json> [...]
#
# Renderiza la tabla Markdown de metricas de una corrida a partir del contrato
# normalizado producido por compute_stage_metrics. Solo presenta el modelo,
# tokens y estimated_cost_usd fijados por el terminal: no recalcula precios ni
# consulta formatos de runtimes (MEF-ADR-0050 / MEF-ADR-0054).
#
# Cada grupo representa una etapa. Un JSON nulo, invalido, campos ausentes o la
# falta de jq degradan la celda afectada a "-". La fila Total solo suma etapas
# listadas; se marca parcial si falta algun contador de tokens, duracion o costo
# necesario para formar un total completo. estimated_cost_usd: 0 es presente y
# se muestra como $0.00. Nunca aborta: la telemetria es observabilidad, no un
# gate del pipeline.
_render_run_metric_count() {
    local n="$1"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
        echo "-"
        return 0
    fi
    awk -v n="$n" 'BEGIN { if (n >= 1000000) printf "%.2fM", n/1000000; else if (n >= 1000) printf "%.1fk", n/1000; else printf "%d", n }' \
        | sed 's/\.0\([kM]\)$/\1/' || echo "-"
    return 0
}

render_run_metrics_table() {
    local label duration metrics
    local total_tokens=0 total_duration=0 total_cost="0" cost_values=0
    local tokens_complete=true duration_complete=true cost_complete=true

    echo "| Etapa | Modelo | Tokens | in/out/cache/reasoning | Tiempo | Costo estimado |"
    echo "|---|---|---:|---|---:|---:|"

    while [ "$#" -ge 3 ]; do
        label="$1"
        duration="$2"
        metrics="$3"
        shift 3

        local model="-" tokens_display="-" breakdown="-" duration_display="-" cost_display="-"
        local token_sum="" cost="" parsed="" input="" output="" cache_read="" cache_write="" reasoning=""

        if [[ "$duration" =~ ^[0-9]+$ ]]; then
            duration_display="$((duration / 60))m $((duration % 60))s"
            total_duration=$((total_duration + duration))
        else
            duration_complete=false
        fi

        if command -v jq >/dev/null 2>&1 && [ -n "$metrics" ]; then
            parsed=$(printf '%s' "$metrics" | jq -r '
                if type != "object" then empty
                else
                    def count: if type == "number" and floor == . and . >= 0 then tostring else "" end;
                    [
                        (if (.model | type) == "string" and .model != "" then .model else "-" end),
                        (.tokens.input | count),
                        (.tokens.output | count),
                        (.tokens.cache_read | count),
                        (.tokens.cache_write | count),
                        (.tokens.reasoning | count),
                        (if (.estimated_cost_usd | type) == "number" and .estimated_cost_usd >= 0 then (.estimated_cost_usd | tostring) else "" end)
                    ] | join("\u001c")
                end
            ' 2>/dev/null) || parsed=""
        fi

        if [ -n "$parsed" ]; then
            IFS=$'\034' read -r model input output cache_read cache_write reasoning cost <<< "$parsed"
            model=${model//$'\n'/ }
            model=${model//|/\\|}
            local cache=""
            if [[ "$cache_read" =~ ^[0-9]+$ ]] && [[ "$cache_write" =~ ^[0-9]+$ ]]; then
                cache=$((cache_read + cache_write))
            fi
            breakdown="$(_render_run_metric_count "$input") / $(_render_run_metric_count "$output") / $(_render_run_metric_count "$cache") / $(_render_run_metric_count "$reasoning")"
            if [[ "$input" =~ ^[0-9]+$ ]] && [[ "$output" =~ ^[0-9]+$ ]] && [[ "$cache_read" =~ ^[0-9]+$ ]] && [[ "$cache_write" =~ ^[0-9]+$ ]] && [[ "$reasoning" =~ ^[0-9]+$ ]]; then
                token_sum=$((input + output + cache_read + cache_write + reasoning))
                tokens_display=$(_render_run_metric_count "$token_sum")
                total_tokens=$((total_tokens + token_sum))
            else
                tokens_complete=false
            fi
            if [ -n "$cost" ]; then
                cost_display=$(awk -v n="$cost" 'BEGIN { printf "$%.2f", n }')
                total_cost=$(awk -v a="$total_cost" -v b="$cost" 'BEGIN { printf "%.12f", a + b }')
                cost_values=$((cost_values + 1))
            else
                cost_complete=false
            fi
        else
            tokens_complete=false
            cost_complete=false
        fi

        label=${label//$'\n'/ }
        label=${label//|/\\|}
        echo "| $label | $model | $tokens_display | $breakdown | $duration_display | $cost_display |"
    done

    [ "$#" -eq 0 ] || { tokens_complete=false; duration_complete=false; cost_complete=false; }
    local total_label="**Total**"
    [ "$tokens_complete" = true ] && [ "$duration_complete" = true ] && [ "$cost_complete" = true ] || total_label="**Total (parcial)**"
    local total_tokens_display="-" total_duration_display="-" total_cost_display="-"
    if [ "$tokens_complete" = true ]; then
        total_tokens_display="**$(awk -v n="$total_tokens" 'BEGIN { if (n >= 1000000) printf "%.2fM", n/1000000; else if (n >= 1000) printf "%.1fk", n/1000; else printf "%d", n }' | sed 's/\.0\([kM]\)$/\1/')**"
    fi
    if [ "$duration_complete" = true ]; then
        total_duration_display="**$((total_duration / 60))m $((total_duration % 60))s**"
    fi
    if [ "$cost_values" -gt 0 ]; then
        total_cost_display="**$(awk -v n="$total_cost" 'BEGIN { printf "$%.2f", n }')**"
    fi
    echo "| $total_label | - | $total_tokens_display | - | $total_duration_display | $total_cost_display |"
    return 0
}

# build_agents_history_json <key1> <agent1> <dur1> <metrics1> [<key2> <agent2> <dur2> <metrics2> ...]
#
# Construye el objeto JSON "agents" de una entrada de pipeline-history.jsonl,
# generalizado a N stages (issue #646) -- a diferencia del interno (#426,
# especifico a writer/reviewer), tdd-pipeline.sh tiene hasta 7 claves
# variables (test-writer/implementer/smoke-test-writer/reviewer/scaffolder/
# patch-test-writer/patch-implementer; coverage-gate se compone aparte, ver
# nota en tdd-pipeline.sh). Cada grupo de 4 argumentos agrega una clave
# <key1> con {duration: <dur1>, metrics: <metrics1>}: <dur1> vacio o "null"
# serializa `duration: null` (stage no corrido, CA-1: la clave sigue
# presente); <metrics1> vacio o "null" serializa `metrics: null` igual.
#
# <agent1> es el nombre REAL del agente despachado bajo esa clave (distingue
# projection-test-writer de test-writer bajo la misma clave "test-writer") y
# se inyecta como agents.<key1>.metrics.agent -- CA-1 describe el campo como
# parte del esquema de metrics, no como hermano de duration/metrics. Por eso
# solo se agrega cuando <metrics1> parseo a un objeto real: si la traza no
# trajo `result` (stage matado por el watchdog antes de escribirlo, o
# instrumentacion fallida) metrics ya es null y no hay donde anidar el campo
# -- se pierde la atribucion de agente en ese caso puntual, degradacion
# aceptable frente a inventar un objeto {agent: ...} sin el resto de las
# cifras del interno. <agent1> vacio omite el campo aunque metrics si sea un
# objeto.
#
# Con jq: una sola invocacion via --args, sin necesidad de --argjson por
# grupo (el numero de grupos varia por caller). Sin jq -- o si esa
# invocacion fallara por cualquier motivo -- degrada a un objeto plano con
# SOLO "duration" por clave (sin "metrics" ni "agent"), construido con
# bash/printf. Nunca aborta y siempre imprime un objeto JSON valido.
#
# Los argumentos van pegados a `--args` SIN el separador `--`: verificado en
# jq 1.7.1, tras `--args` todo lo que sigue entra a $ARGS.positional aunque
# empiece con guion, asi que el separador no aporta nada aqui. En cambio su
# manejo cambio entre versiones de jq (en 1.7 se consume como fin de
# opciones); un jq que lo tratara como un posicional literal "--" correria un
# lugar TODOS los grupos y produciria un objeto "agents" corrupto -- que es
# peor que no tener metricas, porque igual se escribe al historial. Sin el
# separador el resultado es el mismo en toda version que soporte `--args`.
build_agents_history_json() {
    if command -v jq >/dev/null 2>&1; then
        local built
        built=$(jq -n -c '
            def to_num: if . == "" or . == "null" then null else (try tonumber catch null) end;
            def to_json: if . == "" or . == "null" then null else (try fromjson catch null) end;
            ($ARGS.positional) as $a
            | reduce range(0; ($a | length); 4) as $i
                ({};
                 . + {
                   ($a[$i]): {
                     duration: ($a[$i + 2] | to_num),
                     metrics: (
                       ($a[$i + 3] | to_json) as $m
                       | if $m == null then null
                         elif ($a[$i + 1] // "") == "" then $m
                         else ($m + {agent: $a[$i + 1]})
                         end
                     )
                   }
                 }
                )
        ' --args "$@" 2>/dev/null) || built=""
        if [ -n "$built" ]; then
            echo "$built"
            return 0
        fi
    fi

    local out="{" first=true key dur
    while [ "$#" -ge 4 ]; do
        key="$1"
        dur="$3"
        [ -z "$dur" ] && dur="null"
        [ "$first" = true ] || out="${out},"
        out="${out}\"${key}\":{\"duration\":${dur}}"
        first=false
        shift 4
    done
    out="${out}}"
    echo "$out"
    return 0
}

# --- Clasificacion de fallos de agente y politica de espera (hold, issue #971) -
#
# Unifica la clasificacion que hasta este issue vivia inline y duplicada en
# tdd-pipeline.sh y tooling-pipeline.sh (una cadena de `grep` sobre el log
# derivado del stage), mas el reintento one-shot de API_ERROR_SERVER, en dos
# funciones compartidas. Contraparte publicada de classify_agent_failure/
# agent_failure_is_holdable (`src/internal/scripts/lib/_mefisto-common.sh`,
# issues #534/#965/#967) -- MEF-ADR-0051 fija la taxonomia y los defaults de
# la politica de espera como doctrina transversal a los dos lados de
# MEF-ADR-0019, aunque solo el interno la implementaba hasta ahora.
#
# Diferencia deliberada con el interno: el lado publicado no migra al runner
# neutral en este issue (MEF-ADR-0050 lo declara obra aparte) -- no hay
# adaptador que traduzca el payload crudo del CLI a un `error.kind` cerrado
# (`run-events.schema.json`). classify_agent_failure aqui sigue leyendo texto
# (el log derivado, y el stream crudo cuando esta capturado) en vez de un
# campo estructurado; MEF-ADR-0050 exige igual que esa lectura quede aislada
# en UNA funcion, para que una futura migracion al runner neutral tenga un
# solo punto que cambiar.

# classify_agent_failure <exit_code> <elapsed_s> <log_stage> [stream_file]
#
# Traduce el desenlace de una invocacion fallida del CLI a la etiqueta
# <failure_type> que run_agent registra en events.log. Mismas familias que el
# lado interno (`_mefisto-common.sh:classify_agent_failure`) alcanzables sin
# el vocabulario `error.kind` del contrato neutral:
#
#   TIMEOUT              - exit de señal (137 SIGKILL / 143 SIGTERM), el
#                           watchdog del stage.
#   RATE_LIMIT            - ventana de uso agotada (429). Con <stream_file>
#                           capturado (PIPELINE_CAPTURE_STREAM=true), se
#                           detecta el evento estructurado `rate_limit_event`
#                           con `rate_limit_info.status != "allowed"` (mismo
#                           criterio que runtime-claude.jq del lado interno,
#                           issue #965); sin stream, un grep conservador sobre
#                           el log exige "429" Y un indicio textual de "rate
#                           limit"/"usage limit" (case-insensitive) a la vez,
#                           igual que el fallback de runtime-opencode.jq --
#                           exigir ambos evita que un 4xx no relacionado con
#                           un "429" propio de otro significado dispare un
#                           falso positivo.
#   PROVIDER_UNAVAILABLE  - reemplazo 1:1 de la vieja etiqueta
#                           API_ERROR_SERVER: "API Error: 5" en el log
#                           (5xx/522/529 del proveedor).
#   API_ERROR_CLIENT      - "API Error: 4" en el log (4xx que no es limite de
#                           uso -- el RATE_LIMIT de arriba ya se descarto).
#   CLI_ERROR             - causa no identificada (default).
#
# El orden de los casos es significativo: TIMEOUT gana sobre cualquier otro
# sintoma, RATE_LIMIT se evalua antes que PROVIDER_UNAVAILABLE/API_ERROR_CLIENT
# (un 429 no debe caer en "API Error: 4"), y CLI_ERROR es el fallback final.
#
# <stream_file> es opcional: sin el (o vacio, inexistente, o sin jq en PATH),
# la deteccion de RATE_LIMIT degrada al grep de texto -- nunca aborta.
classify_agent_failure() {
    local exit_code="$1" elapsed="$2" log_stage="$3" stream_file="${4:-}"

    if [ "$exit_code" = "137" ] || [ "$exit_code" = "143" ]; then
        echo "TIMEOUT (signal $exit_code, ${elapsed}s)"
        return 0
    fi

    if [ -n "$stream_file" ] && [ -s "$stream_file" ] && command -v jq >/dev/null 2>&1; then
        local rejected
        rejected=$(jq -R -s '
            (split("\n") | map(select(length > 0)) | map(try fromjson catch empty)
                | map(select(type == "object"))) as $events
            | ($events | map(select(.type == "rate_limit_event"))
                | map(select((.rate_limit_info.status // "allowed") != "allowed"))
                | length) > 0
        ' "$stream_file" 2>/dev/null) || rejected="false"
        if [ "$rejected" = "true" ]; then
            echo "RATE_LIMIT (exit $exit_code)"
            return 0
        fi
    fi

    if grep -q "429" "$log_stage" 2>/dev/null && grep -qiE "rate.?limit|usage.?limit" "$log_stage" 2>/dev/null; then
        echo "RATE_LIMIT (exit $exit_code)"
        return 0
    fi

    if grep -q "API Error: 5" "$log_stage" 2>/dev/null; then
        echo "PROVIDER_UNAVAILABLE (exit $exit_code)"
        return 0
    fi

    if grep -q "API Error: 4" "$log_stage" 2>/dev/null; then
        echo "API_ERROR_CLIENT (exit $exit_code)"
        return 0
    fi

    echo "CLI_ERROR (exit $exit_code)"
    return 0
}

# agent_failure_is_holdable <failure_type>
#
# Retorna 0 si <failure_type> describe una de las dos familias que ameritan
# ESPERAR (hold) en vez de abortar de una: RATE_LIMIT (ventana de uso
# agotada) y PROVIDER_UNAVAILABLE (el proveedor caido) -- mismo criterio y
# mismos dos labels que el homologo interno
# (`_mefisto-common.sh:agent_failure_is_holdable`, issue #967). El bucle de
# run_agent la consulta tras clasificar el fallo; API_ERROR_CLIENT/CLI_ERROR/
# TIMEOUT quedan fuera a proposito y caen al aborto ordinario.
#
# La comparacion es por prefijo: classify_agent_failure adjunta el exit code
# a la etiqueta ("PROVIDER_UNAVAILABLE (exit 1)").
agent_failure_is_holdable() {
    local failure_type="${1:-}"

    case "$failure_type" in
        RATE_LIMIT*|PROVIDER_UNAVAILABLE*) return 0 ;;
        *)                                 return 1 ;;
    esac
}

# agent_hold_wait <events_log> <failure_type> <hold_started_ts>
#
# Sondea-y-espera una vez: calcula cuanto dormir dado el techo de la espera,
# deja constancia en <events_log> con el MISMO formato de linea que el lado
# interno, duerme, e imprime por stdout los segundos dormidos. Mismos
# defaults y MISMAS variables de entorno que el homologo interno
# (`_mefisto-common.sh`, issue #967) -- divergir seria doctrina duplicada
# (MEF-ADR-0051):
#
#   MEFISTO_HOLD_PROBE_SECONDS  - cadencia de sondeo (default 300s = 5 min).
#   MEFISTO_HOLD_MAX_SECONDS    - techo de la espera, medido en reloj de
#                                 pared desde <hold_started_ts> (default
#                                 21600s = 6h).
#
# Si el caller entrega `resets_at`, espera hasta ese instante mas el margen de
# 60 segundos; si falta o no se puede parsear, usa la cadencia fija.
#
# Retorna 1 SIN dormir si el techo ya se agoto (remanente <= 0) -- el caller
# rompe su bucle de espera y cae al trato ordinario de fallo. Retorna 0 tras
# dormir en cualquier otro caso.
agent_hold_wait() {
    local events_log="$1" failure_type="$2" hold_started_ts="$3" resets_at="${4:-}"
    local hold_max="${MEFISTO_HOLD_MAX_SECONDS:-21600}"
    local hold_probe="${MEFISTO_HOLD_PROBE_SECONDS:-300}"

    local now_epoch hold_elapsed hold_remaining
    now_epoch=$(date +%s)
    hold_elapsed=$(( now_epoch - hold_started_ts ))
    hold_remaining=$(( hold_max - hold_elapsed ))
    if [ "$hold_remaining" -le 0 ]; then
        return 1
    fi

    local hold_sleep="$hold_probe"
    # El terminal neutral puede anunciar cuando se abre la ventana. El parser
    # acepta las dos implementaciones date presentes en runtimes soportados.
    if [ -n "$resets_at" ]; then
        local resets_epoch
        resets_epoch=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$resets_at" +%s 2>/dev/null || date -d "$resets_at" +%s 2>/dev/null || true)
        if [ -n "$resets_epoch" ]; then
            hold_sleep=$((resets_epoch + 60 - now_epoch))
            [ "$hold_sleep" -lt 1 ] && hold_sleep=1
        fi
    fi
    [ "$hold_sleep" -gt "$hold_remaining" ] && hold_sleep="$hold_remaining"

    local hold_family="${failure_type%% *}"
    local hold_deadline_epoch=$(( hold_started_ts + hold_max ))
    local next_probe_epoch=$(( now_epoch + hold_sleep ))
    local next_probe_hms deadline_hm
    next_probe_hms=$(date -r "$next_probe_epoch" +%H:%M:%S 2>/dev/null || date -d "@$next_probe_epoch" +%H:%M:%S 2>/dev/null || echo "??:??:??")
    deadline_hm=$(date -r "$hold_deadline_epoch" +%H:%M 2>/dev/null || date -d "@$hold_deadline_epoch" +%H:%M 2>/dev/null || echo "??:??")

    echo "[$(date +%H:%M:%S)][hold] $hold_family: esperando, proxima sonda $next_probe_hms (techo $deadline_hm)" >> "$events_log"

    sleep "$hold_sleep"
    echo "$hold_sleep"
    return 0
}

# agent_session_transcript_count <dir>
#
# Imprime cuantos transcripts de sesion del CLI tiene <dir> en el store local
# (0 si no hay ninguno, si el directorio no existe o si el store cambio de
# forma). Lo consume la sonda de hold para decidir si `-c`/`--continue` tiene
# algo VALIDO que continuar (issue #972, CA-2/CA-4): compara el conteo de
# antes del intento original contra el de despues del fallo -- si NO crecio,
# el intento muerto no dejo transcript y `-c` desde ese directorio aterrizaria
# en la sesion de OTRO stage anterior del mismo worktree (tdd-pipeline.sh
# corre hasta siete agentes en secuencia sobre el mismo path) o en ninguna.
#
# Por que un conteo y no un `session_id`: el lado publicado no puede capturar
# el id de forma confiable (solo existe con PIPELINE_CAPTURE_STREAM=true,
# MEF-ADR-0051) -- pero si puede verificar la PRECONDICION de `-c`. Verificado
# a mano: cada invocacion no reanudada deja exactamente un `<session-id>.jsonl`
# en el store del directorio, y una reanudada (`-c`) reusa el mismo id y
# APENDE al mismo archivo, sin crear uno nuevo (dos sesiones + un `-c` en un
# directorio limpio dejaron 2 archivos, no 3).
#
# Es deliberadamente fail-safe y acoplada a un detalle interno de Claude Code
# (el layout `<config>/projects/<cwd-slug>/*.jsonl`, con `/` y `.` del path
# fisico mapeados a `-`): si ese layout cambia, la funcion devuelve 0, la
# sonda no reanuda y el pipeline degrada al comportamiento previo a #972
# (stage desde cero) en vez de romperse.
agent_session_transcript_count() {
    local dir="${1:-}"
    [ -n "$dir" ] || { echo 0; return 0; }

    local real_dir
    real_dir=$(cd "$dir" 2>/dev/null && pwd -P) || { echo 0; return 0; }

    local slug="${real_dir//\//-}"
    slug="${slug//./-}"
    local store="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$slug"
    [ -d "$store" ] || { echo 0; return 0; }

    # Glob con nullglob en vez de `find`: el path del store arranca con '-'
    # (el slug de una ruta absoluta), que find/bfs interpretan como flag.
    local nullglob_ya=0
    shopt -q nullglob && nullglob_ya=1
    shopt -s nullglob
    local transcripts=( "$store"/*.jsonl )
    [ "$nullglob_ya" -eq 1 ] || shopt -u nullglob

    echo "${#transcripts[@]}"
}

# agent_resume_prompt <stage> <agent>
#
# Prompt corto de continuacion para la sonda de hold que reanuda la sesion
# truncada (issue #972, CA-1) en vez de reenviar el prompt original completo
# del stage. Se envia junto con `-c`/`--continue` (continua la conversacion
# MAS RECIENTE del directorio actual, verificado en `claude --help`): cada
# stage ya hace `cd "$WORKTREE_PATH"` antes de invocar el CLI, y cada issue
# tiene su propio worktree, asi que `-c` desde ahi resuelve la sesion
# truncada de ESE stage sin necesitar `session_id` -- que del lado publicado
# solo existe con PIPELINE_CAPTURE_STREAM=true (MEF-ADR-0051). Verificado a
# mano con el CLI real (CA-4, no asumido) que "la mas reciente del directorio"
# resuelve lo esperado cuando dos sesiones distintas corrieron en secuencia en
# el mismo directorio: el `-c` posterior devolvio el `session_id` de la
# SEGUNDA, nunca el de la primera.
#
# La precondicion "hay algo de ESTE stage que continuar" NO se delega al CLI:
# la verifica el caller con agent_session_transcript_count, porque `-c`
# IGNORA EN SILENCIO `--agent` (verificado: `claude -c -p --agent <nombre
# inexistente>` no falla y responde como Claude generico, mientras que sin
# `-c` el mismo flag aborta con "not found"). Sin esa verificacion, un
# directorio sin transcript del intento muerto recibiria este prompt de
# continuacion en una sesion virgen y SIN la definicion del agente, con
# bypassPermissions activo -- peor que repetir el stage desde cero.
#
# Nunca se usa junto a --fork-session: reusar el mismo id de sesion es lo que
# mantiene un solo transcript por stage (notas tecnicas del issue).
#
# Mismo contrato de contenido que el homologo interno (RESUME_PROMPT_TEXT de
# `mefisto-tooling-pipeline.sh`, issue #968): pide continuar sin reiniciar el
# analisis y dejar (o completar) el resumen del stage -- los gates de
# confianza de cada pipeline (existencia del summary, deteccion de trabajo
# truncado) se aplican sin cambios al resultado (CA-3). Suma sobre el interno
# un parrafo de corte para el caso en que, pese al chequeo del caller, la
# sesion continuada no sea la esperada: defensa en profundidad, no el
# mecanismo principal.
agent_resume_prompt() {
    local stage="$1" agent="$2"
    cat <<RESUME_PROMPT_EOF
Tu sesion anterior en este mismo stage (stage ${stage}, agente ${agent}) se corto por un limite de uso o una caida del proveedor -- el pipeline ya espero (hold) a que se restableciera. Estas reanudando esa MISMA conversacion (--continue): tu memoria de trabajo, lo que ya leiste y lo que ya escribiste sigue disponible.

Continua exactamente donde quedaste. No reinicies tu analisis desde cero, no releas archivos que ya revisaste ni repitas ediciones ya hechas.

Termina tu contrato del stage, incluido dejar escrito (o completar si quedo a medias) el resumen en .claude/pipeline/summaries/stage-${stage}-${agent}.md. Si ese archivo ya existe completo, dejalo como esta; si no, escribelo ahora y agrega una linea que diga que esta sesion se reanudo tras una espera.

CORTE DE SEGURIDAD: si no tienes memoria de haber trabajado antes en este stage (stage ${stage}, agente ${agent}) -- es decir, si esta conversacion arranca aqui y no reconoces el trabajo previo que se describe arriba -- entonces la reanudacion aterrizo en la conversacion equivocada. En ese caso NO edites, crees ni borres ningun archivo y NO escribas el resumen del stage: responde unicamente la linea 'SIN_SESION_PREVIA' y termina. El pipeline lo detecta por la ausencia del resumen y relanza el stage completo desde cero.

CONTEXTO DE EJECUCION (sigue vigente): modo no-interactivo, sin humano al otro lado. PROHIBIDO hacer 'git push' o 'gh pr create': eso sigue siendo responsabilidad exclusiva del pipeline.
RESUME_PROMPT_EOF
}

# --- Espera (hold) vista desde los orquestadores con cola (issue #973) --------
#
# batch-pipeline.sh y parallel-pipeline.sh envuelven a tdd-pipeline.sh/
# tooling-pipeline.sh/iac-pipeline.sh, que ya implementan la politica de
# espera (agent_hold_wait, issue #971): mientras un stage esta en hold, el
# pipeline que lo contiene esta bloqueado en un sleep, sin salir con exit !=
# 0 -- por eso los dos orquestadores ya heredan gratis el CA-1/CA-5 de #973
# (una espera no incrementa FAILED, no dispara --stop-on-error y no cambia el
# exit code final).
#
# Lo que NO viene gratis son dos cosas:
#   - La VISIBILIDAD de la espera sin bloquearse: parallel-pipeline.sh corre
#     varios worktrees a la vez y necesita saber si HAY una espera activa
#     ahora mismo, para no lanzar mas issues de la cola (CA-3) y para
#     reflejarlo en su dashboard (CA-2) -- hold_recently_active/
#     format_hold_status.
#   - La CONTABILIDAD de lo esperado al cerrar un eslabon: batch-pipeline.sh
#     esta bloqueado en el `tee` del eslabon mientras este espera (la senal en
#     vivo la emite el propio eslabon, issue #971, y work-status-collect.sh la lee de
#     events.log, CA-4), asi que solo puede anotar cuanto se espero al cerrar
#     -- hold_seconds_in_range/hold_note_suffix, nota ANEXA al desenlace real,
#     nunca un fallo nuevo (CA-1).
#
# Vocabulario y mecanica deliberadamente identicos a los del homologo interno
# (`src/internal/scripts/mefisto-batch-pipeline.sh`, issue #969): la doctrina
# de MEF-ADR-0051 rige los dos lados de MEF-ADR-0019 y divergir en la frase o
# en el criterio seria duplicarla.
#
# events.log es UN SOLO archivo compartido por checkout (no por worktree):
# tdd/tooling/iac-pipeline.sh lo resuelven contra el cwd desde el que los
# lanza el orquestador (<repo>/.claude/pipeline/events.log), nunca contra el
# worktree del issue. De ahi los dos ejes de acotamiento que estas funciones
# aceptan: el numero de linea ya presente cuando arranco el consumidor (que
# descarta corridas anteriores) y, para la contabilidad por eslabon, la
# cabecera "SESSION ... issue:<N>" que abre cada corrida (la UNICA marca del
# archivo que nombra el issue). Sin el segundo eje, otra corrida del mismo
# checkout le regalaria sus esperas al eslabon en curso.

# _pc_epoch_at <YYYY-MM-DD> <HH:MM:SS>
#
# Epoch de esa fecha y hora local. BSD/macOS primero (`date -j -f`), GNU como
# fallback (`date -d`); retorna 1 sin imprimir nada si ninguna lo puede leer.
_pc_epoch_at() {
    date -j -f "%Y-%m-%d %H:%M:%S" "$1 $2" +%s 2>/dev/null \
        || date -d "$1 $2" +%s 2>/dev/null \
        || return 1
}

# hold_line_window <linea_de_hold>
#
# Traduce las dos horas que trae una linea de anuncio de hold
# ("[HH:MM:SS][hold] <FAMILIA>: esperando, proxima sonda HH:MM:SS (techo
# HH:MM)", formato fijado por agent_hold_wait) a dos epochs absolutos, y los
# imprime separados por un espacio: "<inicio> <proxima_sonda>".
#
# events.log guarda hora del dia sin fecha, asi que los epochs se
# reconstruyen contra el reloj actual con dos correcciones -- sin ellas una
# corrida que cruza medianoche y una linea vieja de OTRO dia se leen igual de
# mal:
#   1. sonda < inicio -> el ciclo cruzo medianoche: la sonda es del dia
#      siguiente al del anuncio.
#   2. inicio > ahora -> el anuncio no puede ser de hoy (una siesta empieza
#      siempre en el pasado): la linea es de ayer y se corren AMBOS epochs un
#      dia atras. Esto es lo que evita el falso positivo caro: sin la
#      correccion, un events.log cuyo ultimo hold es de ayer 18:00 con sonda
#      18:05 se leeria como espera activa hasta las 18:05 de HOY, y
#      parallel-pipeline.sh se negaria a lanzar la cola durante horas por una
#      espera que ya no existe.
#
# Retorna 1 sin imprimir nada si la linea no trae las dos horas o si `date`
# no las puede leer.
hold_line_window() {
    local line="$1"
    local start_hms probe_hms
    start_hms=$(printf '%s' "$line" | sed -nE 's/^\[([0-9]{2}:[0-9]{2}:[0-9]{2})\]\[hold\] .*/\1/p')
    probe_hms=$(printf '%s' "$line" | sed -nE 's/.*proxima sonda ([0-9]{2}:[0-9]{2}:[0-9]{2}).*/\1/p')
    [ -n "$start_hms" ] && [ -n "$probe_hms" ] || return 1

    local today start_epoch probe_epoch now_epoch
    today="$(date +%Y-%m-%d)"
    start_epoch=$(_pc_epoch_at "$today" "$start_hms") || return 1
    probe_epoch=$(_pc_epoch_at "$today" "$probe_hms") || return 1
    [ "$probe_epoch" -lt "$start_epoch" ] && probe_epoch=$(( probe_epoch + 86400 ))

    now_epoch=$(date +%s)
    if [ "$start_epoch" -gt "$now_epoch" ]; then
        start_epoch=$(( start_epoch - 86400 ))
        probe_epoch=$(( probe_epoch - 86400 ))
    fi

    echo "$start_epoch $probe_epoch"
}

# last_hold_line <events_log> [from_line]
#
# Imprime la ULTIMA linea de ANUNCIO de hold de <events_log>, considerando
# solo lo escrito despues de <from_line> (default 0 = todo el archivo). Vacio
# si no hay ninguna.
#
# Deliberadamente NO considera las lineas "[hold][resume]" (sub-eventos de la
# reanudacion de sesion DENTRO de un ciclo ya anunciado, issue #972): no
# matchean ni el `][hold] ` con espacio final ni el "esperando, proxima
# sonda" que solo escribe agent_hold_wait.
last_hold_line() {
    local events_log="$1" from_line="${2:-0}"
    [ -f "$events_log" ] || return 1

    tail -n "+$(( from_line + 1 ))" "$events_log" 2>/dev/null \
        | grep -F '][hold] ' \
        | grep -F 'esperando, proxima sonda' \
        | tail -n1
}

# hold_recently_active <events_log> [from_line]
#
# Retorna 0 si hay una espera activa AHORA MISMO en <events_log>: existe una
# linea de anuncio de hold (desde <from_line>+1) cuya proxima sonda todavia no
# llego. Retorna 1 si no hay ninguna, si la ultima ya paso su hora de sonda
# (se resolvio o se agoto el techo) o si el reloj no se pudo parsear.
#
# Nunca aborta: toda falla de parseo degrada a "no hay espera activa".
hold_recently_active() {
    local events_log="$1" from_line="${2:-0}"

    local line window probe_epoch now_epoch
    line=$(last_hold_line "$events_log" "$from_line") || return 1
    [ -n "$line" ] || return 1

    window=$(hold_line_window "$line") || return 1
    probe_epoch="${window##* }"
    now_epoch=$(date +%s)

    [ "$now_epoch" -lt "$probe_epoch" ]
}

# format_hold_status <events_log> [from_line]
#
# Si hay una espera activa, imprime la ultima linea de anuncio sin su
# timestamp ni corchetes -- p. ej. "RATE_LIMIT: esperando, proxima sonda
# 14:37:07 (techo 20:32)" -- lista para el dashboard de parallel-pipeline.sh
# (CA-2) y para work-status-collect.sh (CA-4). Sin espera activa no imprime nada y
# retorna 1.
format_hold_status() {
    local events_log="$1" from_line="${2:-0}"
    hold_recently_active "$events_log" "$from_line" || return 1

    last_hold_line "$events_log" "$from_line" | sed -E 's/^\[[0-9:]+\]\[hold\] //'
}

# fmt_hold_duration <segundos>
#
# "Xm Ys" a partir de segundos enteros. Mismo formato con el que el propio
# eslabon reporta su hold (tdd/tooling/iac-pipeline.sh, issue #971), para que
# el numero se lea igual en el log del eslabon y en el resumen del batch.
fmt_hold_duration() {
    local secs="${1:-0}"
    echo "$(( secs / 60 ))m $(( secs % 60 ))s"
}

# hold_seconds_in_range <events_log> <from_line> [<issue>]
#
# Suma los segundos en espera (hold) registrados en <events_log> desde la
# linea <from_line>+1 hasta EOF. Cada linea de anuncio trae, en su propio
# texto, la hora en que empezo esa siesta y la hora de su proxima sonda: la
# diferencia ES la duracion de ese ciclo, sin necesidad de acceso al proceso
# del sub-pipeline (que ya termino cuando el orquestador invoca esto).
#
# Con <issue> dado, solo cuentan las lineas que caen bajo una cabecera
# "... SESSION ... issue:<issue> ..." -- la unica marca de events.log que
# nombra el issue (las lineas de hold y de stage no lo llevan). Sin <issue>
# cuenta todo el rango. Una cabecera sin numero (tdd-pipeline.sh en modo
# --file imprime "issue:file") cierra la atribucion en vez de heredar la
# anterior.
#
# Imprime el total en segundos; 0 si <events_log> no existe o no hay lineas
# atribuibles en el rango. Nunca aborta.
hold_seconds_in_range() {
    local events_log="$1" from_line="$2" want_issue="${3:-}"
    [ -f "$events_log" ] || { echo 0; return 0; }

    local total=0 line window session_issue=""
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        if [[ "$line" == *"SESSION "* ]]; then
            if [[ "$line" =~ issue:([0-9]+) ]]; then
                session_issue="${BASH_REMATCH[1]}"
            else
                session_issue=""
            fi
            continue
        fi
        if [ -n "$want_issue" ] && [ "$session_issue" != "$want_issue" ]; then
            continue
        fi
        case "$line" in
            *'][hold] '*'esperando, proxima sonda'*) ;;
            *) continue ;;
        esac
        window=$(hold_line_window "$line") || continue
        total=$(( total + ${window##* } - ${window%% *} ))
    done < <(tail -n "+$(( from_line + 1 ))" "$events_log" 2>/dev/null)

    echo "$total"
}

# hold_note_suffix <segundos>
#
# " (incluye Xm Ys en espera/hold)" si <segundos> > 0, cadena vacia si no --
# mismo vocabulario que el homologo interno (issue #969) y que el reporte de
# hold del propio eslabon. Listo para concatenar al final de un mensaje de
# set_status/fail_issue sin alterar su prefijo ("completado"/"ERROR:"): CA-1
# exige que una espera nunca convierta un desenlace real en fallo ni
# viceversa, asi que esto es siempre una nota ANEXA. Retorna 0 siempre (los
# callers corren bajo `set -e` y la asignan en una substitucion).
hold_note_suffix() {
    local secs="${1:-0}"
    [ "$secs" -gt 0 ] && echo " (incluye $(fmt_hold_duration "$secs") en espera/hold)"
    return 0
}

# --- Helpers de naming de Azure Storage Account (tfstate backend) -------------
#
# El nombre de una Storage Account es un endpoint DNS publico
# (*.blob.core.windows.net) y por tanto unico en TODO Azure, no solo en la
# suscripcion. Estas funciones puras (sin 'az') resuelven el nombre dentro del
# limite de 24 chars y permiten anexar un sufijo de unicidad global, reutilizando
# el patron de 'random_string' que agents/domain-scaffolder.md (Paso 4) ya aplica
# a las Storage Accounts de dominio. bootstrap-backend.sh las compone con
# 'az storage account check-name' para resolver el nombre final.
# Fuente: Microsoft Learn -- "Storage account overview" (reglas de naming).

# truncate_storage_base <base> [max_total] [suffix_len]
#
# Echo de <base> truncada para que <base>+<sufijo de suffix_len> quepa en
# max_total caracteres (Azure: 24). Mismo calculo que el scaffolder
# (st + dominio + env + 6 chars de suffix <= 24). Pura (no consulta Azure).
#
# Si <suffix_len> supera <max_total> (posible desde el issue #732: el "sufijo"
# pasa a ser el largo de los componentes fijos del patron CAF, que crecen con
# env/region/seq) el espacio disponible se satura en 0 y el echo es vacio, en vez
# de caer en el substring negativo de bash (${base:0:-N} recorta por la derecha y
# devolveria una base MAS larga que el limite, silenciosamente invalida). Queda a
# cargo del caller validar el nombre final contra ^[a-z0-9]{3,24}$.
truncate_storage_base() {
    local base="$1"
    local max_total="${2:-24}"
    local suffix_len="${3:-6}"
    local max_base=$((max_total - suffix_len))
    if [ "$max_base" -lt 0 ]; then
        max_base=0
    fi
    if [ "${#base}" -gt "$max_base" ]; then
        printf '%s' "${base:0:$max_base}"
    else
        printf '%s' "$base"
    fi
}

# gen_storage_suffix [n]
#
# Echo de n (default 6) caracteres aleatorios [a-z0-9], validos para un nombre de
# Storage Account. Equivalente en bash al 'random_string { length = 6; special =
# false; upper = false }' del scaffolder. Usa openssl si esta disponible y cae a
# $RANDOM (builtin de bash, presente en 3.2/macOS) si no. Pura.
gen_storage_suffix() {
    local n="${1:-6}"
    local out=""
    local chars="abcdefghijklmnopqrstuvwxyz0123456789"
    local i
    if command -v openssl >/dev/null 2>&1; then
        out=$(openssl rand -hex 32 2>/dev/null) || out=""
        out="${out:0:$n}"
    fi
    if [ "${#out}" -lt "$n" ]; then
        out=""
        for ((i = 0; i < n; i++)); do
            out="${out}${chars:RANDOM % ${#chars}:1}"
        done
    fi
    printf '%s' "$out"
}

# read_backend_storage_account_name <dir>
#
# Busca en <dir>/*.tf un bloque backend "azurerm" y, si existe, echo del
# storage_account_name declarado, SOLO si es un nombre de Storage Account valido
# (^[a-z0-9]{3,24}$). Permite que bootstrap-backend.sh reuse de forma idempotente
# el nombre ya escrito en backend.tf (registro versionado: es lo que usara
# 'terraform init'). Echo vacio si no hay backend o el valor no es literal/valido.
# Pura (no consulta Azure). Siempre retorna 0.
read_backend_storage_account_name() {
    local dir="$1"
    local f name
    [ -d "$dir" ] || return 0
    for f in "$dir"/*.tf; do
        [ -f "$f" ] || continue
        grep -Eq 'backend[[:space:]]*"azurerm"' "$f" || continue
        # '|| name=""' protege a un caller con 'set -e'/'pipefail' si grep no
        # encuentra la linea (pipeline -> exit 1): el nombre queda vacio igual.
        name=$(grep -E '^[[:space:]]*storage_account_name[[:space:]]*=' "$f" \
            | head -n1 \
            | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/') || name=""
        if printf '%s' "$name" | grep -Eq '^[a-z0-9]{3,24}$'; then
            printf '%s' "$name"
            return 0
        fi
    done
    return 0
}

# read_backend_resource_group_name <dir>
#
# Gemelo de read_backend_storage_account_name: busca en <dir>/*.tf un bloque
# backend "azurerm" y, si existe, echo del resource_group_name declarado (sin
# validar charset -- el de un Resource Group es mucho mas laxo que el de Storage).
# Permite que bootstrap-backend.sh reuse el RG ya escrito en backend.tf (registro
# versionado) en vez de recomputarlo con la formula CAF vigente (MEF-ADR-0045,
# issue #732): sin este helper, un consumidor con backend viejo que despues
# declara azureRegionShort veria el script calcular un RG nuevo que no coincide
# con el ya escrito en backend.tf, rompiendo la idempotencia (CA-3). Echo vacio
# si no hay backend o el valor no es literal. Pura (no consulta Azure). Siempre
# retorna 0.
read_backend_resource_group_name() {
    local dir="$1"
    local f name
    [ -d "$dir" ] || return 0
    for f in "$dir"/*.tf; do
        [ -f "$f" ] || continue
        grep -Eq 'backend[[:space:]]*"azurerm"' "$f" || continue
        name=$(grep -E '^[[:space:]]*resource_group_name[[:space:]]*=' "$f" \
            | head -n1 \
            | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/') || name=""
        if printf '%s' "$name" | grep -Eq '^[a-zA-Z0-9._()-]{1,90}$'; then
            printf '%s' "$name"
            return 0
        fi
    done
    return 0
}

# compose_tfstate_resource_group_name <rg_prefix> <env> <region_short> <seq>
#
# Compone el nombre del Resource Group del backend de Terraform. Si
# <region_short> esta vacio, devuelve el nombre legacy "<rg_prefix>-tfstate"
# (retrocompatible -- MEF-ADR-0045 seccion 5, CA-4). Si esta declarado, devuelve
# la forma canonica CAF "rg-tfstate-{app}-{env}-{region}-{seq}" (MEF-ADR-0045
# seccion 1: abrev-tipo "rg", uso fijo "tfstate", {app} = <rg_prefix> sin el
# prefijo "rg-" que infraResourceGroupPrefix ya lleva). Pura (no consulta Azure).
compose_tfstate_resource_group_name() {
    local rg_prefix="$1" env="$2" region_short="$3" seq="$4"
    if [ -z "$region_short" ]; then
        printf '%s' "${rg_prefix}-tfstate"
    else
        printf '%s' "rg-tfstate-${rg_prefix#rg-}-${env}-${region_short}-${seq}"
    fi
}

# tfstate_storage_app_slug <rg_prefix>
#
# Echo del componente {app} del nombre sin guiones de la Storage Account del
# tfstate: <rg_prefix> sin el prefijo "rg-" que infraResourceGroupPrefix ya lleva
# y sin guiones/guiones-bajos (charset de Storage: solo minusculas y digitos,
# MEF-ADR-0045 seccion 4). Fuente unica del slug para compose_tfstate_storage_
# account_base y para el aviso de truncado de bootstrap-backend.sh -- ninguno de
# los dos lo re-deriva por su cuenta. Pura (no consulta Azure).
tfstate_storage_app_slug() {
    printf '%s' "${1#rg-}" | tr -d -- '-_'
}

# compose_tfstate_storage_account_base <rg_prefix> <env> <region_short> <seq> <legacy_base> [max_total]
#
# Compone el nombre BASE de la Storage Account del backend de Terraform. Si
# <region_short> esta vacio, devuelve <legacy_base> tal cual (retrocompatible:
# bootstrap-backend.sh sigue anexandole el sufijo aleatorio de unicidad global,
# MEF-ADR-0045 CA-4). Si esta declarado, compone la forma canonica CAF sin
# guiones "sttfstate{app}{env}{region}{seq}" (seccion 1: abrev-tipo "st", uso fijo
# "tfstate") -- este nombre YA es el candidato final, sin sufijo aleatorio
# (seccion 2: unicidad estructural via app+env+region+seq). {app} sale de
# <rg_prefix> sin el prefijo "rg-" y sin guiones/guiones-bajos (charset de Storage:
# solo minusculas y digitos), truncado con truncate_storage_base si hace falta
# para respetar <max_total> (default 24) -- regla de truncado de la seccion 4:
# se trunca {app}, nunca el resto de componentes. Pura (no consulta Azure).
compose_tfstate_storage_account_base() {
    local rg_prefix="$1" env="$2" region_short="$3" seq="$4" legacy_base="$5"
    local max_total="${6:-24}"
    if [ -z "$region_short" ]; then
        printf '%s' "$legacy_base"
        return 0
    fi
    local app fixed_prefix fixed_suffix fixed_len app_truncated
    app=$(tfstate_storage_app_slug "$rg_prefix")
    fixed_prefix="sttfstate"
    fixed_suffix="${env}${region_short}${seq}"
    fixed_len=$((${#fixed_prefix} + ${#fixed_suffix}))
    app_truncated=$(truncate_storage_base "$app" "$max_total" "$fixed_len")
    printf '%s' "${fixed_prefix}${app_truncated}${fixed_suffix}"
}

# is_path_in_consumer_blocklist <path>
#
# Retorna 0 si el path cae en una ruta RESERVADA al plugin Mefisto y por tanto
# no debe ser tocada por un pipeline publicado corriendo en el consumidor.
# Retorna 1 si el path esta fuera del blocklist (i.e. es valido para el consumidor).
#
# Blocklist (rutas que solo deben tocarse desde el repo de Mefisto):
#   commands/         Skills publicados como slash command (viven en el plugin)
#   skills/           Agent Skills publicados del plugin (MEF-ADR-0033)
#   agents/           Agentes publicados
#   hooks/            Hooks del plugin
#   .claude-plugin/   Metadata del plugin (plugin.json, marketplace.json)
#   src/published/    Fuente neutral de los artefactos publicados (MEF-ADR-0053)
#   src/runtime/      Nucleo neutral de runner y eventos publicados (MEF-ADR-0053)
#   dist/             Distribuciones generadas por runtime (MEF-ADR-0053)
#   mefisto-manifest.json  Metadata generada de la distribucion Claude mientras el
#                     marketplace apunta a ./ (MEF-ADR-0053). Entrada EXACTA de la raiz,
#                     registrada por el issue #1135 antes de que #1132 la pueble, conforme a
#                     MEF-ADR-0019 seccion E. Un pipeline publicado no puede editarla.
#   docs/adr/mef-adr-*  ADRs del marco -- MEF-ADR-0030 decision #3 fija su filename
#                     en minuscula (mef-adr-NNNN-slug.md). El resto de docs/adr/ es
#                     del consumidor: MEF-ADR-0030 descarta reubicarlo bajo
#                     docs/adr-proyecto/ u otra ruta (su Alt 2, descartada) y declara
#                     valido que un consumidor conserve docs/adr/ sin migrar (decision #4).
#
# NO incluye .claude/settings.json (issue #522): en el repo del consumidor esa
# ruta es de sus propios hooks/config, no una ruta reservada del plugin. Ese
# registro solo existe en is_path_in_mefisto_scope de .claude/scripts/_mefisto-common.sh.
#
# Mismo criterio, y por el mismo motivo, aplica a .mcp.json (issue #763): en el
# repo del consumidor esa ruta es su propia configuracion MCP de proyecto, no
# una ruta reservada del plugin. Tampoco se agrega aqui; solo esta registrada
# en is_path_in_mefisto_scope.
is_path_in_consumer_blocklist() {
    local path="$1"
    [ -z "$path" ] && return 1

    case "$path" in
        commands/*|skills/*|agents/*|hooks/*) return 0 ;;
        .claude-plugin/*|src/published/*|src/runtime/*|dist/*) return 0 ;;
        mefisto-manifest.json) return 0 ;;
        docs/adr/mef-adr-*) return 0 ;;
        *) return 1 ;;
    esac
}

# validate_consumer_scope_changes <worktree_path> <base_commit>
#
# Verifica que los archivos modificados/creados en el worktree NO caen en
# rutas reservadas al plugin (ver is_path_in_consumer_blocklist).
# Llamar despues de cada stage que invoca un agente.
#
# Retorna 0 si OK, 1 si hay violaciones (las lista en stderr).
validate_consumer_scope_changes() {
    local wt="$1"
    local base="$2"

    local changed
    changed=$(
        git -C "$wt" diff --name-only "$base..HEAD" 2>/dev/null
        git -C "$wt" status --porcelain 2>/dev/null | sed 's/^...//'
    )

    local violations=()
    while IFS= read -r path; do
        [ -z "$path" ] && continue
        if is_path_in_consumer_blocklist "$path"; then
            violations+=("$path")
        fi
    done <<< "$changed"

    if [ ${#violations[@]} -gt 0 ]; then
        local repo_slug=""
        if [ -n "${HARNESS_CONFIG_PATH:-}" ] && [ -f "$HARNESS_CONFIG_PATH" ]; then
            repo_slug=$(jq -r '.repoSlug // empty' "$HARNESS_CONFIG_PATH" 2>/dev/null)
        fi
        [ -z "$repo_slug" ] && repo_slug="augusto-romero-arango/mefisto"

        local branch
        branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)
        [ -z "$branch" ] && branch="la rama del worktree $wt"

        echo "ERROR: el agente toco rutas reservadas al plugin Mefisto:" >&2
        printf '  - %s\n' "${violations[@]}" >&2
        echo "" >&2
        echo "Las rutas commands/, skills/, agents/, hooks/, .claude-plugin/, src/published/, src/runtime/, dist/ y los archivos" >&2
        echo "docs/adr/mef-adr-* pertenecen al plugin (repo $repo_slug)." >&2
        echo "" >&2
        echo "El resto del trabajo del agente NO se perdio: ya quedo commiteado en '$branch'." >&2
        echo "Para recuperarlo, revierte ahi los archivos listados arriba y abre el PR a mano." >&2
        echo "Si necesitas modificar el plugin, abre un draft en su repo:" >&2
        echo "  gh issue create -R $repo_slug \\" >&2
        echo "    --label \"estado:borrador,tipo:tooling\" --title \"...\"" >&2
        return 1
    fi
}

# _pc_script_dir
#
# Retorna el directorio absoluto donde vive este archivo (scripts/ del plugin),
# derivado de BASH_SOURCE -- indiferente al cwd desde el que se invoque. Fuente
# unica que usa el resolver de pipelines para devolver rutas absolutas (issue
# #289): batch-pipeline.sh y parallel-pipeline.sh hacen 'cd "$REPO_ROOT"' (cwd =
# raiz del consumidor) antes de ejecutar la ruta devuelta tal cual, y el plugin
# ya no vive dentro del repo del consumidor, asi que una ruta relativa como
# "./scripts/tdd-pipeline.sh" no existe alli.
_pc_script_dir() {
    cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

# get_harness_version
#
# Imprime por stdout el '.version' de .claude-plugin/plugin.json del propio
# plugin Mefisto (issue #660), para estampar con que version corrio cada
# pipeline en pipeline-history.jsonl -- a diferencia de
# .claude/pipeline/.plugin-root (que el hook SessionStart sobreescribe en
# cada arranque de sesion), este valor se calcula una vez y viaja pegado a la
# entrada, permitiendo reconstruir la version de corridas historicas.
#
# Ubica plugin.json relativo a este mismo archivo via _pc_script_dir (el
# directorio scripts/ del plugin, sea cual sea la version del cache donde
# este instalado), no al cwd del pipeline (la raiz del consumidor).
#
# Con jq disponible, lee '.version' via jq -r. Sin jq en PATH, degrada a una
# extraccion con sed sobre la linea '"version": "X.Y.Z"' (mismo espiritu que
# compute_stage_metrics). Si plugin.json no existe, o ninguna extraccion
# produce un valor, imprime cadena vacia -- nunca aborta y siempre retorna 0.
get_harness_version() {
    # Los tres pipelines corren con `set -euo pipefail` y toman el valor por
    # sustitucion de comando en su prologo, asi que un estado != 0 que se
    # escape de aqui mataria la corrida entera antes del primer stage: ningun
    # paso de abajo puede propagarlo.
    local script_dir plugin_json
    script_dir="$(_pc_script_dir 2>/dev/null)" || script_dir=""
    plugin_json="$script_dir/../.claude-plugin/plugin.json"

    if [ ! -f "$plugin_json" ]; then
        echo ""
        return 0
    fi

    local version=""
    if command -v jq >/dev/null 2>&1; then
        version=$(jq -r '.version // ""' "$plugin_json" 2>/dev/null) || true
        [ "$version" = "null" ] && version=""
    else
        # '|| true' y no '|| version=""': con pipefail heredado del caller,
        # head -n1 cierra el pipe apenas lee la linea y sed puede morir de
        # SIGPIPE DESPUES de haber emitido la version -- reasignar ahi
        # borraria un valor ya capturado.
        version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$plugin_json" 2>/dev/null | head -n1) || true
    fi

    echo "$version"
    return 0
}

# get_harness_identity_json lee exclusivamente el manifiesto generado de la
# distribucion. Metadata ausente, invalida o incompleta produce nulls y una
# degradacion visible; nunca se infiere identidad desde Git, caches o plugin.json.
get_harness_identity_json() {
    local expected_runtime="${1:-}" script_dir manifest version commit state
    script_dir="$(_pc_script_dir 2>/dev/null)" || script_dir=""
    manifest="$script_dir/../mefisto-manifest.json"
    version=""; commit=""
    state="metadata_missing"
    if [ -e "$manifest" ]; then
        state="metadata_invalid"
    fi
    if [ -f "$manifest" ] && [ ! -L "$manifest" ] && command -v jq >/dev/null 2>&1 \
       && jq -e --arg runtime "$expected_runtime" '
            .schemaVersion == 1
            and (.runtime | type == "string" and ($runtime == "" or . == $runtime))
            and (.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.-]+)?$"))
            and (.commit | type == "string" and test("^[0-9a-f]{40}$"))
        ' "$manifest" >/dev/null 2>&1; then
        version=$(jq -r '.version' "$manifest")
        commit=$(jq -r '.commit' "$manifest")
        state="complete"
    fi
    jq -cn --arg version "$version" --arg commit "$commit" --arg state "$state" '{harness_version: (if $version == "" then null else $version end), harness_commit: (if $commit == "" then null else $commit end), identity_state: $state}'
}

# resolve_pipeline <issue_num> [override]
#
# Retorna la ruta ABSOLUTA (al plugin) del script de pipeline a usar para un
# issue dado.
# - Sin override: consulta labels del issue via gh y enruta automaticamente
# - Con override "tdd" o "tooling": retorna el pipeline forzado sin consultar labels
# - Issues tipo:feature, tipo:refactor o tipo:projection retornan tdd-pipeline.sh
#   (tipo:projection despacha a la rama read-side dentro de tdd-pipeline.sh --
#   issue #371, MEF-ADR-0034/0035)
# - Issues tipo:infra retornan "SKIP:infra"
# - Issues sin label tipo:* retornan "SKIP:no-tipo"
resolve_pipeline() {
    local issue="$1"
    local override="${2:-}"
    local sd
    sd="$(_pc_script_dir)"

    if [ -n "$override" ]; then
        case "$override" in
            tdd)     echo "$sd/tdd-pipeline.sh" ;;
            tooling) echo "$sd/tooling-pipeline.sh" ;;
            *)       echo "ERROR: override desconocido '$override'" >&2; return 1 ;;
        esac
        return
    fi

    local labels
    labels=$(gh issue view "$issue" --json labels -q '.labels[].name' 2>/dev/null)

    _resolve_from_labels "$labels"
}

# _resolve_from_labels <labels_text>
# Funcion interna: determina el pipeline (ruta absoluta) a partir de texto de
# labels (una por linea). Los sentinels SKIP:* se retornan sin alterar.
#
# tipo:projection enruta a tdd-pipeline.sh (issue #372): ese script ya trae la
# rama read-side (issue #371) que detecta el label internamente y despacha
# projection-test-writer/projection-implementer en vez de test-writer/implementer.
_resolve_from_labels() {
    local labels="$1"
    local sd
    sd="$(_pc_script_dir)"
    if echo "$labels" | grep -qE '^tipo:(feature|refactor|projection)$'; then
        echo "$sd/tdd-pipeline.sh"
    elif echo "$labels" | grep -q '^tipo:tooling$'; then
        echo "$sd/tooling-pipeline.sh"
    elif echo "$labels" | grep -q '^tipo:infra$'; then
        echo "SKIP:infra"
    else
        echo "SKIP:no-tipo"
    fi
}

# resolve_pipeline_with_state <issue_num> [override]
#
# Retorna "STATE|PIPELINE" en una sola linea (ej: "OPEN|/ruta/absoluta/al/plugin/scripts/tdd-pipeline.sh").
# Combina la consulta de estado y labels en una sola llamada a gh, reduciendo API calls.
# Es una vista de dos campos sobre resolve_issue_facts (abajo), que hace esa unica
# llamada; los llamadores que ademas necesitan saber si el issue es tipo:projection
# usan esa funcion directamente en vez de sumar una segunda consulta.
#
# El override se evalua SIEMPRE (incluso si gh falla), igual que resolve_pipeline
# (issue #291): un override invalido retorna error sin importar gh, y un override
# valido se honra aunque el estado no se haya podido verificar (queda UNKNOWN,
# nunca se finge OPEN -- los llamadores siguen pudiendo saltar issues no
# verificables).
resolve_pipeline_with_state() {
    local facts state
    facts=$(resolve_issue_facts "$@") || return 1
    state="${facts%%|*}"
    # facts = "STATE|IS_PROJECTION|PIPELINE": descarta el campo del medio.
    facts="${facts#*|}"
    echo "$state|${facts#*|}"
}

# resolve_issue_facts <issue_num> [override]
#
# Retorna "STATE|IS_PROJECTION|PIPELINE" en una sola linea (ej:
# "OPEN|false|/ruta/absoluta/al/plugin/scripts/tdd-pipeline.sh"), con
# IS_PROJECTION en "true"/"false". Misma semantica de estado y override que
# resolve_pipeline_with_state (que delega en esta funcion), sumando la deteccion de
# tipo:projection que parallel-pipeline.sh necesita para serializar (issue #372)
# SIN una segunda llamada a gh: el JSON que esta funcion ya descarga trae los
# labels, igual que la deteccion del label dentro de tdd-pipeline.sh reusa el
# JSON que el pipeline ya tenia (issue #371).
#
# Con override, IS_PROJECTION se reporta igual (sale de los labels, no del
# pipeline resuelto): forzar --pipeline no cambia que archivos del worker de
# proyecciones toca el issue, asi que la serializacion se mantiene.
resolve_issue_facts() {
    local issue="$1"
    local override="${2:-}"
    local sd
    sd="$(_pc_script_dir)"

    local state_and_labels state labels
    if state_and_labels=$(gh issue view "$issue" --json state,labels \
        -q '"\(.state)|\(.labels | map(.name) | join("\n"))"' 2>/dev/null); then
        state="${state_and_labels%%|*}"
        labels="${state_and_labels#*|}"
    else
        state="UNKNOWN"
        labels=""
    fi

    local is_projection="false"
    _is_tipo_projection_from_labels "$labels" && is_projection="true"

    if [ -n "$override" ]; then
        case "$override" in
            tdd)     echo "$state|$is_projection|$sd/tdd-pipeline.sh" ;;
            tooling) echo "$state|$is_projection|$sd/tooling-pipeline.sh" ;;
            *)       echo "ERROR: override desconocido '$override'" >&2; return 1 ;;
        esac
        return
    fi

    echo "$state|$is_projection|$(_resolve_from_labels "$labels")"
}

# --- Serializacion de issues tipo:projection dentro de un lote paralelo ------
#
# Todas las proyecciones de un mismo Bounded Context comparten los archivos del
# worker de proyecciones (Projections/Program.cs, ConfiguracionMartenProjections
# -- MEF-ADR-0034): dos issues tipo:projection corriendo a la vez en
# parallel-pipeline.sh producirian dos PRs read-side editando el mismo archivo,
# con el conflicto de merge resuelto por el segundo en llegar. El contrato de un
# solo Bounded Context por repo (MEF-ADR-0023) mas la homogeneidad de repo que
# parallel-pipeline.sh ya exige hacen innecesaria cualquier deteccion de BC: dentro
# de una misma invocacion, CUALQUIER par de issues tipo:projection es incompatible
# entre si (issue #372).

# _is_tipo_projection_from_labels <labels_text>
#
# Funcion interna pura: determina si el texto de labels (una por linea, mismo
# formato que _resolve_from_labels) incluye el label EXACTO tipo:projection (no
# un prefijo como tipo:projection-experimental). La consume resolve_issue_facts,
# que ya tiene los labels a mano; si gh no pudo resolverlos, el texto llega vacio
# y el issue simplemente no se trata como projection (mismo fallo silencioso que
# _resolve_from_labels, que cae a SKIP:no-tipo).
_is_tipo_projection_from_labels() {
    echo "$1" | grep -qx 'tipo:projection'
}

# can_launch_now <max_parallel> <running_count> <is_projection> <projection_running>
#
# Decide si un issue pendiente puede lanzarse ya, dado el estado actual del
# lote. Pura (sin gh, sin procesos, sin arrays) para poder testear las
# combinaciones sin lanzar background jobs reales -- el llamador (scheduler de
# parallel-pipeline.sh) es quien calcula running_count/projection_running
# inspeccionando sus propios PIDs.
#
#   <max_parallel>       entero; 0 = sin limite
#   <running_count>      entero; cuantos pipelines siguen vivos ahora mismo
#   <is_projection>      "true"/"false"; el pendiente evaluado es tipo:projection
#   <projection_running> "true"/"false"; ya hay un tipo:projection vivo ahora mismo
#
# Retorna 0 si puede lanzarse, 1 si debe esperar.
can_launch_now() {
    local max_parallel="$1" running="$2" is_projection="$3" projection_running="$4"
    if [ "$max_parallel" -gt 0 ] && [ "$running" -ge "$max_parallel" ]; then
        return 1
    fi
    if [ "$is_projection" = "true" ] && [ "$projection_running" = "true" ]; then
        return 1
    fi
    return 0
}

# find_open_pr_for_branch <branch_name> [repo_slug] [base_branch]
#
# Busca un PR ABIERTO existente para <branch_name> via `gh pr list --head`, para
# que el pipeline lo REUTILICE en vez de abortar cuando `gh pr create` fallaria
# con "a pull request for branch ... already exists" (issue #378 -- incidente
# del batch mefisto-batch-125628: un agente del Stage 1 crea el PR el mismo,
# violando la prohibicion de push/PR de su prompt, y el bloque "Creando PR" del
# pipeline abortaba en vez de recuperar la URL ya existente).
#
# [repo_slug] es opcional (formato owner/repo); se pasa a `gh pr list --repo`
# cuando el caller no invoca gh desde dentro del repo (p. ej. el pipeline se
# queda en REPO_ROOT y no hace cd al worktree).
#
# [base_branch] (default 'main') filtra por rama base. Es deliberado y no
# cosmetico: la unicidad que GitHub impone -- y que produce el error que este
# gate esquiva -- es por par (head, base), como lo dice el propio mensaje
# (`a pull request for branch "X" into branch "main" already exists`). Sin el
# filtro, un PR abierto de la misma rama hacia OTRA base se devolveria como si
# fuera el PR del pipeline, y el `gh pr create --base main` que si habria
# funcionado nunca correria: el pipeline reportaria una URL equivocada.
#
# Imprime la URL a stdout si existe un PR abierto, cadena vacia si no hay PR o
# si el chequeo no se pudo hacer (gh ausente o gh fallo). NUNCA aborta: es un
# chequeo defensivo antes de `gh pr create`, no una fuente de verdad -- si gh
# esta roto de verdad (auth, red), ese fallo lo reporta el `gh pr create`
# normal que sigue a continuacion.
#
# Retorna siempre 0.
find_open_pr_for_branch() {
    local branch="$1"
    local repo="${2:-}"
    local base="${3:-main}"
    [ -z "$branch" ] && { echo ""; return 0; }

    command -v gh >/dev/null 2>&1 || { echo ""; return 0; }

    local gh_args=(pr list --head "$branch" --base "$base" --state open --json url -q '.[0].url')
    [ -n "$repo" ] && gh_args+=(--repo "$repo")

    local url
    url=$(gh "${gh_args[@]}" 2>/dev/null) || url=""
    # gh 2.92 imprime cadena vacia cuando la lista viene vacia, pero `.[0].url`
    # sobre `[]` es `null` en jq: normalizamos para no depender de como cada
    # version de gh serializa ese null (un "null" con fuga aqui haria que el
    # pipeline reutilizara un PR inexistente con URL literal "null").
    [ "$url" = "null" ] && url=""
    echo "$url"
    return 0
}

# --- Clasificacion de archivos para el coverage gate (Stage 4) --------------

# coverage_classify_file <filepath> <worktree_path> [is_projection=false]
#
# Clasifica un archivo .cs del PR para el coverage gate del Stage 4 de
# scripts/tdd-pipeline.sh (MEF-ADR-0014). Extraida del cuerpo del Stage 4 para
# poder testearla con fixtures reales en vez de con una reimplementacion que
# puede divergir del script (issue #416) -- mismo motivo que can_launch_now.
#
# NO es pura: en tres ramas (eventos/Entities/DomainEvents y ValueObjects con
# factory Crear(), y la exclusion de records DTO) lee <worktree_path>/<filepath>
# del disco. Por eso recibe worktree_path/is_projection como parametros explicitos
# en vez de leer $WORKTREE_PATH/$IS_PROJECTION del entorno del caller: el
# motivo es eliminar acoplamiento oculto en un archivo que sourcean todos los
# pipelines publicados, no solo habilitar la testabilidad (un test que sourcea
# tambien podria setear esos globales antes de llamar).
#
#   <filepath>       ruta relativa del archivo dentro del worktree (ej:
#                     src/Foo.Bar/Feature/FunctionEndpoint.cs)
#   <worktree_path>   ruta absoluta del worktree del consumidor
#   [is_projection]   "true"/"false" (default "false"). Gatea el carve-out
#                     read-side de FunctionEndpoint.cs (issue #371)
#
# Imprime a stdout una de: "logic" (exige 95% de cobertura de lineas),
# "excluded" (no se mide) o "not_evaluated" (no matchea ningun patron vigente).
# El gate nunca bloquea por "not_evaluated", pero tampoco lo presenta como una
# exclusion deliberada: la tabla del PR lo reporta como "sin clasificar" con
# marcador de atencion propio, para revision humana (issue #586,
# MEF-ADR-0014). Retorna siempre 0.
coverage_classify_file() {
    local filepath="$1"
    local worktree_path="$2"
    local is_projection="${3:-false}"
    local basename
    basename=$(basename "$filepath")
    local dirname
    dirname=$(dirname "$filepath")

    # Excluidos por nombre. IdentidadEventos*.cs es el hermano exacto de
    # ConfiguracionSerializacion*.cs -- lista declarativa de tipos persistidos,
    # sin logica de negocio (MEF-ADR-0036 seccion 3) --, y su guarda real son
    # los dos guardrails de ComposicionContenedorTests sobre el store que
    # compone el contenedor real (MEF-ADR-0036 seccion 4 + MEF-ADR-0029), no
    # cobertura de lineas.
    case "$basename" in
        HealthCheck.cs|Program.cs|*Mensajes.cs|*AssemblyMarker.cs|ConfiguracionSerializacion*.cs|IdentidadEventos*.cs|*.resx)
            echo "excluded"; return ;;
    esac

    # Excluidos por directorio de infraestructura (wiring puro)
    if echo "$dirname" | grep -q '/Infraestructura/'; then
        case "$basename" in
            RequestValidator.cs|ServiceBusDeserializador.cs)
                echo "excluded"; return ;;
        esac
    fi

    # *Api.cs bajo Infraestructura/ de un servidor MCP (issue #788, MEF-ADR-0047
    # decision 3, agents/mcp-scaffolder.md artefacto 5): cliente HTTP tipado que
    # arma el request y devuelve el HttpResponseMessage crudo -- wiring puro,
    # mismo rol que RequestValidator.cs/ServiceBusDeserializador.cs arriba. El
    # check de esos dos exige un '/' DESPUES de "Infraestructura" en $dirname
    # (solo dispara con subcarpeta, ver comentario del Escenario B del test), pero
    # el layout real de mcp-scaffolder coloca *Api.cs directo en Infraestructura/
    # sin subcarpeta -- por eso este check ancla "Infraestructura" como segmento
    # completo de ruta, hoja o no, en vez de reusar el de arriba.
    if echo "$dirname" | grep -qE '(^|/)Infraestructura(/|$)'; then
        case "$basename" in
            *Api.cs)
                echo "excluded"; return ;;
        esac
    fi

    # Carve-out read-side (issue #371, MEF-ADR-0014 + MEF-ADR-0035 seccion 6):
    # el FunctionEndpoint.cs de una query GET delgada (Obtener{X}/Listar{X}s,
    # naming.md del Skill projections) no exige cobertura unitaria -- se cubre
    # por el test de composicion (MEF-ADR-0029) y los smoke tests (MEF-ADR-0013).
    # Acotado a issues tipo:projection y al naming exacto de esas carpetas (sin
    # sufijo "Function", a diferencia de un FunctionEndpoint.cs de comando) para
    # no aflojar el gate del resto: la ausencia del sufijo es parte del criterio,
    # no solo del comentario -- una carpeta `Obtener...Function` seria un comando
    # y sigue exigiendo el 95%.
    local query_dir
    query_dir=$(basename "$dirname")
    if [ "$is_projection" = true ] && [ "$basename" = "FunctionEndpoint.cs" ] \
       && [ "${query_dir%Function}" = "$query_dir" ] \
       && echo "$query_dir" | grep -qE '^(Obtener|Listar)[A-Za-z0-9]*$'; then
        echo "excluded"; return
    fi

    # Logica: patrones que requieren 95%
    # *Projection.cs (MEF-ADR-0034 seccion 9): la clase de proyeccion
    # companion lleva logica real (que evento aplica, como transforma el
    # documento) y no va gateada por is_projection -- a diferencia del
    # carve-out de arriba (que afloja), esta regla endurece el gate, y una
    # regla que endurece gateada por label dejaria sin medir una proyeccion
    # tocada por un issue tipo:feature. Patron en singular: no coincide con
    # ConfiguracionMartenProjections{Dominio}.cs (plural + sufijo dominio)
    # ni ConfiguracionMartenProjections.cs (plural) -- MEF-ADR-0006 no
    # registra otro artefacto del marco con el sufijo "Projection".
    # *EventHandler.cs (issue #590): el EventHandler directo del patron
    # 2.1.0 (`IPrivateEventHandlerAsync<TEvent>`, sin comando espejo --
    # implementer.md seccion "EventHandler — reaccionar a un evento
    # privado") es el punto de entrada de un evento del bus, con el mismo
    # peso que un CommandHandler: decide que se escribe y como se maneja el
    # fallo, y eso es logica de negocio del marco (MEF-ADR-0004). Tampoco va
    # gateado por is_projection ni por label, mismo razonamiento que
    # *Projection.cs arriba. Patron anclado al final del basename: el
    # companion {Clase}.Mensajes.cs del handler (MEF-ADR-0009) cae antes en la
    # exclusion de boilerplate de arriba y sigue sin medirse.
    # *Tool.cs (issue #788, MEF-ADR-0047 decision 4): el McpToolTrigger es el
    # punto de entrada de un servidor MCP con logica de negocio real (routing
    # de parametros, filtros de relevancia, truncado con senal), y MEF-ADR-0048
    # nivel 1 exige unit tests de esa logica -- mismo peso que un
    # CommandHandler. Tampoco va gateado por is_projection ni por label, mismo
    # razonamiento que *Projection.cs/*EventHandler.cs arriba.
    case "$basename" in
        *CommandHandler.cs|*AggregateRoot.cs|*Validator.cs|FunctionEndpoint.cs|*Projection.cs|*EventHandler.cs|*Tool.cs)
            echo "logic"; return ;;
    esac

    # Logica: Eventos con factory Crear()
    # Dos layouts conviven (MEF-ADR-0039): el historico bajo una subcarpeta
    # /Eventos/ o /Entities/ del Function App, y el vigente en la raiz -- o
    # cualquier subcarpeta -- de un proyecto *.DomainEvents, sin subcarpeta
    # Eventos/ (decision 1). El patron sobre el segmento de ruta
    # (\.DomainEvents al final de dirname, o \.DomainEvents/ seguido de mas
    # ruta) cubre ambos casos sin exigir subcarpeta.
    if echo "$dirname" | grep -qE '/Eventos/|/Entities/|\.DomainEvents$|\.DomainEvents/'; then
        if [ -f "$worktree_path/$filepath" ] && grep -q 'static.*Crear(' "$worktree_path/$filepath" 2>/dev/null; then
            echo "logic"; return
        fi
    fi

    # Logica: ValueObjects con factory Crear()
    if echo "$dirname" | grep -q '/ValueObjects/'; then
        if [ -f "$worktree_path/$filepath" ] && grep -q 'static.*Crear(' "$worktree_path/$filepath" 2>/dev/null; then
            echo "logic"; return
        fi
    fi

    # Excluir: records DTO puros del estilo canonico (MEF-ADR-0035 seccion
    # 2: 'public sealed record X(...)', companion de proyeccion aparte).
    # Sin depender del conteo de lineas -- el estilo canonico es
    # multilinea -- ni de 'public record' adyacente -- el estilo canonico
    # es 'public sealed record'. Se aplana el contenido (una sola linea) y
    # se ubica cada declaracion de record con sus modificadores opcionales
    # (sealed/partial, en cualquier combinacion); si tras cerrar la lista
    # de parametros el record termina en ';' es un DTO sin cuerpo. Si en
    # cambio abre un cuerpo '{' (metodos u otros miembros) no cuenta como
    # record puro.
    # Segunda condicion (issue #788, relaja la original "el archivo declara
    # UN solo tipo" del issue #416): TODOS los tipos declarados en el
    # archivo son records puros -- conteo de record-decls puros == total de
    # type_decls. El layout natural de un contrato upstream redeclarado
    # (MEF-ADR-0047 decision 3) es un archivo con N records puros (ej.
    # FichaColaborador + EtiquetaFicha), y todos deberian excluirse igual.
    # La proteccion que motivo la cota original se preserva: un record puro
    # junto a -- o dentro de -- una clase (o cualquier tipo) con metodos deja
    # pure_record_count < type_decls y sigue sin excluirse, evitando que se
    # etiquete "excluido" un archivo que en realidad nadie midio.
    if [ -f "$worktree_path/$filepath" ]; then
        local content
        content=$(grep -v '^\s*//' "$worktree_path/$filepath" | grep -v '^\s*$' | grep -v '^using ' | grep -v '^namespace ' || true)
        local content_flat
        content_flat=$(echo "$content" | tr '\n' ' ')
        local record_decls
        record_decls=$(echo "$content_flat" | grep -oE 'public\s+(sealed\s+|partial\s+)*record\s+\w+\([^()]*\)[^;{]*[;{]' 2>/dev/null || true)
        local type_decls
        type_decls=$(echo "$content_flat" | grep -oE '(class|record|struct|interface|enum)\s+\w+' 2>/dev/null | wc -l | tr -d ' ')
        if [ -n "$record_decls" ]; then
            # '|| true' en los dos grep de arriba y de aqui: los pipelines
            # publicados corren bajo `set -euo pipefail` y un grep sin match
            # sale con status 1 (grep -c imprime "0" pero tambien sale 1),
            # asi que sin la guarda un archivo sin records -- o con records
            # todos con cuerpo -- podria abortar a un caller que invoque la
            # funcion directamente, no dentro de una sustitucion de comando.
            local pure_record_count
            pure_record_count=$(echo "$record_decls" | grep -cE ';$' || true)
            if [ "$pure_record_count" -eq "$type_decls" ]; then
                echo "excluded"; return
            fi
        fi
    fi

    echo "not_evaluated"
}

# caffeinate_prefix
#
# Imprime por stdout "caffeinate -i" si el binario 'caffeinate' esta
# disponible en PATH (macOS), o cadena vacia en cualquier otro sistema
# (Linux/CI) -- issue #800. Antepuesto al lanzamiento de un pipeline largo
# evita que el Mac entre en suspension idle mientras corre en un pane de
# tmux/Herdr (`-i`: solo suspension idle; sin `-d` la pantalla si puede
# apagarse; `-s` se descarta porque solo aplica con AC conectado). El
# prefijo no envuelve al pipeline como proceso padre: `caffeinate <utility>`
# hace fork de un helper que sostiene la assertion y exec del utility EN SU
# LUGAR (verificado en macOS 25.4 -- `caffeinate -i /bin/sleep 25 &` deja $!
# apuntando a /bin/sleep, con un hijo 'caffeinate'). De ahi las dos
# propiedades que hacen barato el prefijo: el helper muere con el utility (sin
# huerfano ni assertion colgada) y el PID y el exit code del comando envuelto
# se conservan, asi que $!, wait, kill y el rc de los runners no cambian de
# semantica.
#
# Alcance: se calcula UNA vez por corrida y se aplica en los RUNNERS
# (tmux-pipeline.sh, herdr-pipeline.sh) sobre el lanzamiento del sub-pipeline,
# no en cada `claude -p` individual dentro de tdd/tooling/iac-pipeline.sh. Un
# pipeline invocado directo, sin pasar por un runner, queda sin envolver.
caffeinate_prefix() {
    if command -v caffeinate >/dev/null 2>&1; then
        printf '%s' "caffeinate -i"
    fi
}

# detect_smoke_only <worktree> <snapshot> [--committed]
#
# Carril "solo smoke" (issue #2357): los proyectos *.SmokeTests/ corren
# post-deploy contra dev (MEF-ADR-0013) y run_tests_projects los excluye, asi
# que un issue que solo los toca nunca queda en rojo en el gate local.
#
# Evalua el conjunto de archivos cambiados desde <snapshot>: commits
# (snapshot..HEAD) y, salvo con --committed, tambien cambios sin commitear y
# archivos nuevos. Es solo smoke cuando hay al menos un archivo bajo
# tests/${HARNESS_NAMESPACE_PREFIX}.*.SmokeTests/ y todo lo demas cae en esos
# proyectos, docs/ o pipeline-state/.
#
# Imprime una linea por archivo ("smoke: <ruta>" | "docs: <ruta>" |
# "otro: <ruta>"). Exit 0 si es solo smoke, 1 si no. Sin efectos colaterales.
detect_smoke_only() {
    local worktree="$1" snapshot="$2" mode="${3:-}"
    local files f has_smoke=false has_other=false out=""
    local prefix="${HARNESS_NAMESPACE_PREFIX:-}"
    files=$( {
        git -C "$worktree" diff --name-only "$snapshot"..HEAD 2>/dev/null || true
        if [ "$mode" != "--committed" ]; then
            git -C "$worktree" diff --name-only HEAD 2>/dev/null || true
            git -C "$worktree" ls-files --others --exclude-standard 2>/dev/null || true
        fi
    } | sort -u )
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        case "$f" in
            "tests/${prefix}."*".SmokeTests/"*) has_smoke=true; out+="smoke: $f"$'\n' ;;
            docs/*|pipeline-state/*) out+="docs: $f"$'\n' ;;
            *) has_other=true; out+="otro: $f"$'\n' ;;
        esac
    done <<< "$files"
    printf '%s' "$out"
    [ "$has_smoke" = true ] && [ "$has_other" = false ]
}

# extract_canonical_dependencies <body>
#
# Imprime, una por linea y sin repetir, las dependencias canonicas de la seccion
# '## Dependencias' del body de un issue (issue #2471): items que EMPIEZAN con
# 'Depende de #N' o 'Bloqueado por #N' (con o sin vineta, sin distinguir
# mayusculas). Ignora 'Bloquea #N', 'Relacionado: #N' y la prosa. Misma regla
# anclada que next-order.sh.
extract_canonical_dependencies() {
    printf '%s\n' "${1:-}" \
        | awk '/^##[[:space:]]*[Dd]ependencias/{f=1;next} /^##[[:space:]]/{f=0} f' \
        | { grep -ioE '^[[:space:]]*([-*][[:space:]]+)?(Depende de|Bloqueado por)[[:space:]]+#[0-9]+' || true; } \
        | { grep -oE '[0-9]+' || true; } | awk '!seen[$0]++'
}

# smoke_tool_name <archivo-Tool.cs>
#
# Imprime el nombre MCP de una tool (issue #2473): el literal de
# 'NombreTool = "<nombre>"' (convencion de /scaffold-mcp) y, si no esta, el
# primer literal de '[McpToolTrigger("<nombre>"'. Sin salida si no lo extrae.
smoke_tool_name() {
    local f="$1" n=""
    [ -f "$f" ] || return 0
    n=$(sed -n 's/.*NombreTool[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
    if [ -z "$n" ]; then
        n=$(sed -n 's/.*McpToolTrigger([[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
    fi
    [ -n "$n" ] && printf '%s\n' "$n"
    return 0
}

# list_smokes_invoking_tools <worktree> <proyecto-smoke-relativo> <Tool.cs relativo>...
#
# Una linea '<nombre><TAB><ruta relativa al worktree>' por cada .cs del proyecto
# SmokeTests que contiene el literal '"<nombre>"' de una tool modificada (issue
# #2473). Si no puede extraer el nombre de un *Tool.cs, emite un warn con la
# ruta (a stderr) y sigue. Compatible con bash 3.2.
list_smokes_invoking_tools() {
    local worktree="$1" project="$2" tool_rel name
    shift 2
    for tool_rel in "$@"; do
        [ -n "$tool_rel" ] || continue
        name=$(smoke_tool_name "$worktree/$tool_rel")
        if [ -z "$name" ]; then
            local motivo="sin NombreTool ni McpToolTrigger"
            [ -f "$worktree/$tool_rel" ] || motivo="el archivo no existe en el worktree (tool borrada o renombrada)"
            if declare -F warn >/dev/null 2>&1; then
                warn "No se pudo extraer el nombre de la tool MCP de '$tool_rel' ($motivo)" >&2
            else
                echo "warn: No se pudo extraer el nombre de la tool MCP de '$tool_rel' ($motivo)" >&2
            fi
            continue
        fi
        [ -d "$worktree/$project" ] || continue
        { grep -rlF --include='*.cs' -- "\"$name\"" "$worktree/$project" 2>/dev/null || true; } \
            | sort | while IFS= read -r hit; do
                [ -n "$hit" ] || continue
                printf '%s\t%s\n' "$name" "${hit#"$worktree"/}"
            done
    done
}

# list_smokes_invoking_routes <worktree> <FunctionEndpoint.cs relativo>...
#
# Una linea '<ruta><TAB><archivo relativo al worktree>' por cada .cs de
# tests/*.SmokeTests/ que invoca la ruta de un HttpTrigger modificado (issue
# #2480). La ruta es el 'Route = "<plantilla>"' del trigger (un archivo sin
# Route no aporta rutas). En cada smoke se resuelven en los literales las
# referencias {Constante} a 'const string' del mismo archivo; cada literal que
# empieza por /api/ se compara, sin distinguir mayusculas, contra la plantilla:
# cada {param} casa un segmento sin '/', '?' ni ':' y la ruta termina ahi o
# sigue con '?'. No distingue metodo HTTP. Requiere python3.
list_smokes_invoking_routes() {
    local worktree="$1"
    shift
    [ -d "$worktree/tests" ] || return 0
    python3 -I - "$worktree" "$@" <<'PYEOF'
import glob, os, re, sys

worktree = sys.argv[1]
routes = []
for rel in sys.argv[2:]:
    try:
        with open(os.path.join(worktree, rel), encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        continue
    for m in re.finditer(r'\[\s*HttpTrigger\((.*?)\)\s*\]', text, re.S):
        r = re.search(r'Route\s*=\s*"([^"]*)"', m.group(1))
        if r and r.group(1) not in routes:
            routes.append(r.group(1))

def to_regex(tpl):
    tpl = tpl.strip("/")
    parts = re.split(r'(\{[^}]*\})', tpl)
    body = "".join('[^/?:"]+' if p.startswith("{") else re.escape(p) for p in parts if p)
    return re.compile(r'^/api/' + body + r'(\?.*)?$', re.I)

compiled = [(r, to_regex(r)) for r in routes]
const_re = re.compile(r'\bconst\s+string\s+(\w+)\s*=\s*\$?"((?:[^"\\]|\\.)*)"\s*;')
lit_re = re.compile(r'\$?"((?:[^"\\]|\\.)*)"')

out = []
files = sorted(glob.glob(os.path.join(worktree, "tests", "*.SmokeTests", "**", "*.cs"), recursive=True))
for path in files:
    if not compiled:
        break
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            src = fh.read()
    except OSError:
        continue
    consts = {n: v for n, v in const_re.findall(src)}
    hit = set()
    for lit in lit_re.findall(src):
        for _ in range(3):
            new = re.sub(r'\{(\w+)\}', lambda m: consts.get(m.group(1), m.group(0)), lit)
            if new == lit:
                break
            lit = new
        if not lit.lower().startswith("/api/"):
            continue
        for tpl, rx in compiled:
            if rx.match(lit):
                hit.add(tpl)
    rel = os.path.relpath(path, worktree)
    for tpl in sorted(hit):
        out.append("%s\t%s" % (tpl, rel))
sys.stdout.write("".join(l + "\n" for l in out))
PYEOF
}
