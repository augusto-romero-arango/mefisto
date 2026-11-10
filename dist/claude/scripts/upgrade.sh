#!/usr/bin/env bash
# upgrade.sh -- operacion neutral de actualizacion de Mefisto (issue #1678, MEF-ADR-0050/0053).
#
# Despacha por el runtime activo (MEFISTO_RUNTIME o mefisto_resolve_runtime). Hoy el unico
# runtime con adaptador es claude: delega en update-plugin.sh, autoridad de ese lado.
#
# Uso:
#   scripts/upgrade.sh --status                   JSON versionado (schemaVersion 3) con la version
#                                                 instalada en disco; es local, no informa si hay
#                                                 una version mas nueva publicada
#   scripts/upgrade.sh                            actualiza
#   scripts/upgrade.sh --prune --only <v>[,<v>...] [--loaded <v>]
#                                                 poda la lista confirmada en el comando
#   scripts/upgrade.sh --disable-user             retira Mefisto del nivel que lo carga en todos los
#                                                 repos (solo tras confirmar); exige la activacion
#                                                 commiteada del repo
#
# Nunca borra nada fuera de --prune. Refrescar panes, el mensaje de reload y la
# confirmacion de poda son responsabilidad del comando, no de este script.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
    echo "Uso: $0 --status | --prune --only <v>[,<v>...] [--loaded <version>] | --disable-user" >&2
}

_guard_consumidor() {
    local repo_top
    repo_top=$(git rev-parse --show-toplevel 2>/dev/null) || {
        echo "ERROR: no estas en un repositorio git" >&2
        return 1
    }
    if [ -f "$repo_top/.claude-plugin/plugin.json" ]; then
        echo "ERROR: /mefisto:upgrade no aplica al repo de Mefisto." >&2
        echo "       scripts/upgrade.sh es del plugin publicado y solo aplica al consumidor." >&2
        echo "       Mefisto se actualiza a si mismo por su propio flujo de release (/mefisto-release)." >&2
        return 1
    fi
}

_resolver_runtime() {
    local lib="$SCRIPT_DIR/../src/runtime/lib/mefisto-runtime.sh"
    if [ -n "${MEFISTO_RUNTIME:-}" ]; then
        RUNTIME="$MEFISTO_RUNTIME"
    elif [ -f "$lib" ]; then
        # shellcheck disable=SC1090
        source "$lib"
        RUNTIME=$(mefisto_resolve_runtime) || {
            echo "ERROR: ${MEFISTO_RUNTIME_ERROR:-no se pudo resolver el runtime}" >&2
            return 1
        }
    else
        echo "ERROR: fija MEFISTO_RUNTIME." >&2
        return 1
    fi
    case "$RUNTIME" in
        claude) ;;
        *) echo "ERROR: runtime '$RUNTIME' no soportado por upgrade (solo claude)." >&2; return 1 ;;
    esac
}

# Version instalada en disco (la que cargara la proxima sesion), no la de la sesion viva.
_installed_claude() {
    local root
    root=$(cat .claude/pipeline/.plugin-root 2>/dev/null) || root=""
    [ -n "$root" ] && basename "${root%/}"
}

cmd_status() {
    command -v jq >/dev/null 2>&1 || { echo "ERROR: jq es requerido para --status." >&2; return 1; }
    local installed
    installed=$(_installed_claude)
    jq -cn --arg rt "$RUNTIME" --arg installed "$installed" '
        {schemaVersion: 3, runtime: $rt,
         installedVersion: (if $installed == "" then null else $installed end)}'
}

# Version cargada segun MEFISTO_LOADED_ROOT (ruta de la version viva, sustituida por el
# comando). Valida: ruta absoluta existente, plugin.json con name mefisto y version igual
# al nombre del directorio. Vacia, sin sustituir o invalida: imprime nada.
_loaded_from_root() {
    local root="${MEFISTO_LOADED_ROOT:-}" manifest name ver
    [ -n "$root" ] || return 0
    case "$root" in *'${'*|*/..|*/../*) return 0 ;; /*) ;; *) return 0 ;; esac
    root="${root%/}"
    manifest="$root/.claude-plugin/plugin.json"
    [ -d "$root" ] && [ -f "$manifest" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0
    name=$(jq -r '.name // empty' "$manifest" 2>/dev/null)
    ver=$(jq -r '.version // empty' "$manifest" 2>/dev/null)
    [ "$name" = mefisto ] && [ -n "$ver" ] && [ "$ver" = "$(basename "$root")" ] || return 0
    printf '%s\n' "$ver"
}

_update_claude() {
    local update="$SCRIPT_DIR/update-plugin.sh" args=() loaded
    [ -f "$update" ] || { echo "ERROR: no se hallo update-plugin.sh junto a upgrade.sh." >&2; return 1; }
    loaded="$LOADED_OVERRIDE"
    [ -n "$loaded" ] || loaded=$(_loaded_from_root)
    if [ "$MODE" = prune ]; then
        args=(--prune)
        [ "$ONLY_GIVEN" = false ] || args+=(--only "$ONLY")
    fi
    [ -z "$loaded" ] || args+=(--loaded "$loaded")
    bash "$update" ${args[@]+"${args[@]}"}
}

# Solo se ejecuta tras la confirmacion del comando; update-plugin.sh exige la activacion
# commiteada del repo para no dejarlo sin Mefisto.
_disable_user() {
    [ -f "$SCRIPT_DIR/update-plugin.sh" ] || { echo "ERROR: no se hallo update-plugin.sh junto a upgrade.sh." >&2; return 1; }
    bash "$SCRIPT_DIR/update-plugin.sh" --disable-user
}

main() {
    MODE=update; LOADED_OVERRIDE=""; ONLY=""; ONLY_GIVEN=false
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --status) MODE=status; shift ;;
            --prune) MODE=prune; shift ;;
            --disable-user) MODE=disable-user; shift ;;
            --loaded)
                [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "ERROR: --loaded requiere una version." >&2; return 1; }
                LOADED_OVERRIDE="$2"; shift 2 ;;
            --only)
                [ "$#" -ge 2 ] || { echo "ERROR: --only requiere una lista de versiones." >&2; return 1; }
                ONLY="$2"; ONLY_GIVEN=true; shift 2 ;;
            -h|--help) usage; return 0 ;;
            *) echo "ERROR: argumento desconocido '$1'" >&2; usage; return 1 ;;
        esac
    done

    _guard_consumidor || return 1
    _resolver_runtime || return 1

    case "$MODE" in
        status) cmd_status ;;
        disable-user) _disable_user ;;
        *) _update_claude ;;
    esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
    exit $?
fi
