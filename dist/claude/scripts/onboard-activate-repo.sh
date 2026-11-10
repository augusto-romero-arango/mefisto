#!/usr/bin/env bash
# onboard-activate-repo.sh -- habilita Mefisto en el repositorio consumidor
# (MEF-ADR-0053 decision 2, issue #2261). Provision opt-in de /onboard.
#
# Mefisto se instala por usuario e inerte; .claude/settings.json, commiteado, es lo
# que lo activa en el repo y en sus worktrees. El script fusiona
# extraKnownMarketplaces y enabledPlugins sin tocar el resto de claves.
# No commitea.
#
# Uso: scripts/onboard-activate-repo.sh --preview | --apply   (cwd = raiz del consumidor)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_plugin-scopes.sh"

main() {
    local modo="${1:-}" top mkt fuente archivo actual nuevo
    top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ERROR: no estas en un repositorio git" >&2; return 1; }
    if [ -f "$top/.claude-plugin/plugin.json" ]; then
        echo "ERROR: /onboard no aplica al repo de Mefisto." >&2
        echo "       scripts/onboard-activate-repo.sh es del plugin publicado y solo aplica al consumidor." >&2
        return 1
    fi
    case "$modo" in
        --preview|--apply) ;;
        *) echo "Uso: $0 --preview | --apply" >&2; return 1 ;;
    esac
    command -v jq >/dev/null 2>&1 || { echo "ERROR: jq es requerido." >&2; return 1; }

    mkt=$(_mefisto_marketplace "$SCRIPT_DIR/..")
    fuente=$(_fuente_marketplace "$mkt")
    archivo="$top/.claude/settings.json"
    if [ -f "$archivo" ]; then
        actual=$(cat "$archivo")
        printf '%s' "$actual" | jq -e 'type == "object"' >/dev/null 2>&1 || {
            echo "ERROR: $archivo no es un objeto JSON valido; corrigelo a mano." >&2
            return 1
        }
    else
        actual='{}'
    fi
    nuevo=$(printf '%s' "$actual" | jq --arg m "$mkt" --argjson f "$fuente" '
        .extraKnownMarketplaces[$m] = (.extraKnownMarketplaces[$m] // {source: $f})
        | .enabledPlugins["mefisto@" + $m] = true')
    if [ "$(printf '%s' "$actual" | jq -S .)" = "$(printf '%s' "$nuevo" | jq -S .)" ]; then
        echo "OK: el repo ya habilita Mefisto (.claude/settings.json); no hay nada que escribir."
        return 0
    fi
    if [ "$modo" = --preview ]; then
        echo "Plan:"
        echo "  - escribir .claude/settings.json con este contenido (resto de claves intacto):"
        printf '%s\n' "$nuevo" | sed 's/^/      /'
        return 0
    fi
    mkdir -p "$top/.claude"
    printf '%s\n' "$nuevo" > "$archivo" || { echo "ERROR: no se pudo escribir $archivo." >&2; return 1; }
    echo "OK: .claude/settings.json habilita mefisto@$mkt."
    echo "Commitea el archivo y llevalo a main: los worktrees de pipeline nacen de origin/main."
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
    exit $?
fi
