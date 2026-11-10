#!/usr/bin/env bash
# Resolucion comun de modelos. El caller entrega tanto el override como el
# mapping: este nucleo no conoce estado, cwd, Git ni stages (MEF-ADR-0019).

_mefisto_models_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${MEFISTO_RUNTIME_LIB_DIR:=$_mefisto_models_lib_dir}"
: "${MEFISTO_MODELS_VALIDATOR:=$_mefisto_models_lib_dir/../contract/models.validate.jq}"
export MEFISTO_RUNTIME_LIB_DIR
unset _mefisto_models_lib_dir

MEFISTO_MODELS_ERROR=""
MEFISTO_RESOLVED_MODEL=""

_mefisto_models_validate_mapping() {
    local file="$1" errors
    [ -n "$file" ] || return 0
    [ -f "$file" ] || return 0

    if [ ! -s "$file" ]; then
        return 0
    fi
    if [ ! -f "$MEFISTO_MODELS_VALIDATOR" ]; then
        MEFISTO_MODELS_ERROR="$MEFISTO_MODELS_VALIDATOR: no existe el validador del mapping de modelos"
        return 1
    fi
    # jq acepta por defecto un stream de varios documentos; el contrato es un
    # unico objeto JSON. Se separa este chequeo del validador de forma para que
    # el programa dedicado siga operando sobre la raiz del mapping.
    if ! jq -e -s 'length == 1' "$file" >/dev/null 2>&1; then
        MEFISTO_MODELS_ERROR="$file: no es JSON valido"
        return 1
    fi
    if ! errors="$(jq -r -f "$MEFISTO_MODELS_VALIDATOR" "$file" 2>/dev/null)"; then
        MEFISTO_MODELS_ERROR="$file: no es JSON valido"
        return 1
    fi
    if [ -n "$errors" ]; then
        errors="${errors//$'\n'/; }"
        MEFISTO_MODELS_ERROR="$file: $errors"
        return 1
    fi
}

_mefisto_models_lookup() {
    local file="$1" runtime="$2" agent_id="$3" profile="$4" model
    [ -n "$file" ] && [ -s "$file" ] && [ -f "$file" ] || return 0
    model="$(jq -r --arg runtime "$runtime" --arg agent "$agent_id" \
        '.[$runtime].agents[$agent] // empty' "$file" 2>/dev/null)"
    if [ -z "$model" ]; then
        model="$(jq -r --arg runtime "$runtime" --arg profile "$profile" \
            '.[$runtime].profiles[$profile] // empty' "$file" 2>/dev/null)"
    fi
    printf '%s' "$model"
}

# mefisto_resolve_model <runtime> <agent-id> <profile> [explicit-model] [mapping-file]
#
# Fija MEFISTO_RESOLVED_MODEL y conserva MEFISTO_MODELS_ERROR en el shell
# caller. Tambien imprime el resultado para conservar compatibilidad con
# callers que ya lo redirigian a un archivo.
_mefisto_models_resolve() {
    local runtime="${1:-}" agent_id="${2:-}" profile="${3:-}"
    local explicit_model="${4:-}" mapping_file="${5:-}" adapter fn model=""
    MEFISTO_MODELS_ERROR=""
    MEFISTO_RESOLVED_MODEL=""

    case "$profile" in
        fast|balanced|deep) ;;
        *) MEFISTO_MODELS_ERROR="profile: '$profile' no esta en el vocabulario fast|balanced|deep"; return 1 ;;
    esac
    case "$runtime" in
        ''|*[!a-z0-9_]*) MEFISTO_MODELS_ERROR="runtime invalido: '$runtime'"; return 1 ;;
    esac

    adapter="$MEFISTO_RUNTIME_LIB_DIR/runtime-$runtime.sh"
    if [ ! -f "$adapter" ]; then
        MEFISTO_MODELS_ERROR="runtime '$runtime' no tiene adaptador ($adapter)"
        return 1
    fi
    # Una resolucion anterior puede haber dejado la funcion de otro archivo
    # runtime-<id>.sh con el mismo id. El adaptador que se acaba de localizar
    # es la unica autoridad de esta invocacion: si no declara default, hereda.
    fn="runtime_${runtime}_default_model"
    unset -f "$fn" 2>/dev/null || true
    if ! source "$adapter"; then
        MEFISTO_MODELS_ERROR="runtime '$runtime': no se pudo cargar el adaptador ($adapter)"
        return 1
    fi

    if [ -n "$explicit_model" ]; then
        model="$explicit_model"
    else
        _mefisto_models_validate_mapping "$mapping_file" || return 1
        model="$(_mefisto_models_lookup "$mapping_file" "$runtime" "$agent_id" "$profile")"
        if [ -z "$model" ]; then
            if declare -F "$fn" >/dev/null 2>&1; then
                model="$($fn "$profile")" || {
                    MEFISTO_MODELS_ERROR="$fn: no acepta el perfil '$profile'"
                    return 1
                }
            fi
        fi
    fi

    MEFISTO_RESOLVED_MODEL="$model"
    printf '%s\n' "$MEFISTO_RESOLVED_MODEL"
}

MEFISTO_EFFORTS_ERROR=""
MEFISTO_RESOLVED_EFFORT=""

_mefisto_effort_valid_level() {
    case "$1" in
        quick|light|standard|thorough|exhaustive) return 0 ;;
        *) return 1 ;;
    esac
}

# mefisto_resolve_effort <runtime> <agent-id> <nivel-fabrica> [mapping-file]
#
# Fija MEFISTO_RESOLVED_EFFORT y MEFISTO_EFFORTS_ERROR en el shell caller;
# capturar con redirect a archivo, no con $(...).
mefisto_resolve_effort() {
    local runtime="${1:-}" agent_id="${2:-}" level="${3:-}" mapping_file="${4:-}"
    local adapter fn native="" override=""
    MEFISTO_EFFORTS_ERROR=""
    MEFISTO_RESOLVED_EFFORT=""

    if ! _mefisto_effort_valid_level "$level"; then
        MEFISTO_EFFORTS_ERROR="nivel de fabrica: '$level' no esta en el vocabulario quick|light|standard|thorough|exhaustive"
        return 1
    fi
    case "$runtime" in
        ''|*[!a-z0-9_]*) MEFISTO_EFFORTS_ERROR="runtime invalido: '$runtime'"; return 1 ;;
    esac
    adapter="$MEFISTO_RUNTIME_LIB_DIR/runtime-$runtime.sh"
    if [ ! -f "$adapter" ]; then
        MEFISTO_EFFORTS_ERROR="runtime '$runtime' no tiene adaptador ($adapter)"
        return 1
    fi
    fn="runtime_${runtime}_default_effort"
    unset -f "$fn" 2>/dev/null || true
    if ! source "$adapter"; then
        MEFISTO_EFFORTS_ERROR="runtime '$runtime': no se pudo cargar el adaptador ($adapter)"
        return 1
    fi

    if ! _mefisto_models_validate_mapping "$mapping_file"; then
        MEFISTO_EFFORTS_ERROR="$MEFISTO_MODELS_ERROR"
        return 1
    fi
    if [ -n "$mapping_file" ] && [ -f "$mapping_file" ] && [ -s "$mapping_file" ]; then
        override="$(jq -r --arg runtime "$runtime" --arg agent "$agent_id" \
            '.[$runtime].efforts.agents[$agent] // empty' "$mapping_file" 2>/dev/null)"
        [ -n "$override" ] && level="$override"
        native="$(jq -r --arg runtime "$runtime" --arg level "$level" \
            '.[$runtime].efforts.levels[$level] // empty' "$mapping_file" 2>/dev/null)"
    fi
    if [ -z "$native" ] && declare -F "$fn" >/dev/null 2>&1; then
        native="$($fn "$level")" || {
            MEFISTO_EFFORTS_ERROR="$fn: no acepta el nivel '$level'"
            return 1
        }
    fi

    MEFISTO_RESOLVED_EFFORT="$native"
    printf '%s\n' "$MEFISTO_RESOLVED_EFFORT"
}

mefisto_resolve_model() {
    _mefisto_models_resolve "$@"
}
