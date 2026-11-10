#!/usr/bin/env bash
# _plugin-scopes.sh -- scopes de instalacion de mefisto que aplican al proyecto activo
# (issue #2130). Sourceado por update-plugin.sh y upgrade.sh; no se ejecuta directo.
#
# Precedencia de Claude Code cuando el mismo plugin esta en varios scopes:
# local > project > user (https://code.claude.com/docs/en/discover-plugins,
# "Choose an install scope"). Actualizar solo 'user' deja vieja la instalacion que
# la sesion realmente carga. 'managed' queda fuera: no lo controla el usuario.
#
# Todas las funciones degradan en silencio: sin jq o sin salida JSON valida del CLI,
# _scopes_aplicables devuelve 'user' (comportamiento previo) y _instalacion_efectiva
# no devuelve nada.

# Slug del repo de Mefisto y el previo al rename (#2349): GitHub redirige el viejo, y los
# consumidores lo conservan en known_marketplaces.json y en su extraKnownMarketplaces.
MEFISTO_SLUG_PUBLICADO="augusto-romero-arango/mefisto"
MEFISTO_SLUG_PREVIO="augusto-romero-arango/eda-evsourcing-azure-harness"

# JSON de 'claude plugin list --json' (vacio si no hay jq, el CLI falla o no es un array).
_plugin_list_json() {
    local out
    command -v jq >/dev/null 2>&1 || return 0
    out=$(claude plugin list --json 2>/dev/null) || return 0
    printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1 || return 0
    printf '%s' "$out"
}

# _instalaciones_aplicables <marketplace> <json> <toplevel>: una linea por instalacion de
# mefisto@<marketplace> en scope user o en project/local con projectPath == toplevel.
# Formato: scope<TAB>version<TAB>installPath
_instalaciones_aplicables() {
    local mkt="$1" json="$2" top="$3"
    [ -n "$json" ] || return 0
    printf '%s' "$json" | jq -r --arg id "mefisto@$mkt" --arg top "$top" '
        .[] | select(.id == $id and
            (.scope == "user" or
             ((.scope == "project" or .scope == "local") and .projectPath == $top)))
        | [.scope, (.version // ""), (.installPath // "")] | @tsv' 2>/dev/null
}

# _scopes_aplicables <marketplace> <json> <toplevel>: un scope por linea; 'user' si no hay nada.
_scopes_aplicables() {
    local scopes
    scopes=$(_instalaciones_aplicables "$@" | cut -f1 | sort -u)
    if [ -z "$scopes" ]; then echo user; else printf '%s\n' "$scopes"; fi
}

# _instalacion_efectiva <marketplace> <json> <toplevel>: la de mayor precedencia
# (local > project > user), como scope<TAB>version<TAB>installPath. Vacio si no hay datos.
_instalacion_efectiva() {
    local lista s linea
    lista=$(_instalaciones_aplicables "$@")
    for s in local project user; do
        linea=$(printf '%s\n' "$lista" | awk -F'\t' -v s="$s" '$1 == s {print; exit}')
        if [ -n "$linea" ]; then printf '%s\n' "$linea"; return 0; fi
    done
}

# _actualizar_scopes <marketplace> <json> <toplevel>: 'claude plugin update' una vez por scope aplicable.
_actualizar_scopes() {
    local mkt="$1" scope
    while IFS= read -r scope; do
        [ -n "$scope" ] || continue
        echo "Actualizando el plugin mefisto@$mkt (scope $scope)..."
        if ! claude plugin update "mefisto@$mkt" --scope "$scope"; then
            echo "ERROR: 'claude plugin update mefisto@$mkt --scope $scope' fallo." >&2
            return 1
        fi
    done < <(_scopes_aplicables "$@")
}

# --- Activacion por repositorio (MEF-ADR-0053 decision 2, issue #2261) ---------------
# Los archivos de mefisto se instalan a scope user pero quedan deshabilitados a ese
# nivel; cada consumidor lo habilita en su .claude/settings.json commiteado (proyecto >
# usuario). 'claude plugin install --scope user' reescribe el nivel usuario a true
# (verificado en 2.1.296), por eso todo install va seguido de _deshabilitar_en_usuario.

# _settings_usuario: ruta del settings.json de usuario de Claude Code.
_settings_usuario() {
    printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
}

# _habilitado_en_usuario <marketplace>: 0 si el nivel usuario no lo deshabilita con un
# false explicito (sin la clave, Claude Code lo trata como habilitado).
_habilitado_en_usuario() {
    local f
    f=$(_settings_usuario)
    [ -f "$f" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0
    # Sin '//': jq trata false como ausente y lo reemplazaria por el default.
    [ "$(jq -r --arg id "mefisto@$1" '(.enabledPlugins // {})[$id] == false' "$f" 2>/dev/null)" != "true" ]
}

# _activacion_commiteada <marketplace> <toplevel>: 0 si el .claude/settings.json de HEAD
# en <toplevel> habilita mefisto@<marketplace>. Se lee lo commiteado, no el disco: los
# worktrees de pipeline nacen de origin/main y un cambio sin commitear no viaja.
_activacion_commiteada() {
    local mkt="$1" top="$2" contenido
    [ -n "$top" ] || return 1
    command -v jq >/dev/null 2>&1 || return 1
    contenido=$(git -C "$top" show HEAD:.claude/settings.json 2>/dev/null) || return 1
    [ "$(printf '%s' "$contenido" | jq -r --arg id "mefisto@$mkt" '.enabledPlugins[$id] // false' 2>/dev/null)" = "true" ]
}

# _deshabilitar_en_usuario <marketplace>: deja enabledPlugins en false a nivel usuario.
_deshabilitar_en_usuario() {
    claude plugin disable "mefisto@$1" --scope user >/dev/null 2>&1 || {
        echo "ERROR: 'claude plugin disable mefisto@$1 --scope user' fallo." >&2
        return 1
    }
    if _habilitado_en_usuario "$1"; then
        echo "ERROR: mefisto@$1 sigue habilitado a nivel usuario en $(_settings_usuario)." >&2
        return 1
    fi
}

# _reportar_activacion <marketplace> <toplevel>: diagnostico legible de la activacion.
# Imprime 'MIGRACION PENDIENTE' cuando el repo ya habilita mefisto y el nivel usuario
# todavia lo carga en todos los repos; el comando decide con el usuario si migra.
_reportar_activacion() {
    local mkt="$1" top="$2" repo=no usuario=deshabilitado
    _activacion_commiteada "$mkt" "$top" && repo=si
    _habilitado_en_usuario "$mkt" && usuario=habilitado
    echo "Activacion de Mefisto:"
    echo "  Este repo lo habilita en .claude/settings.json commiteado: $repo"
    echo "  Nivel usuario ($(_settings_usuario)): $usuario"
    if [ "$repo" = si ] && [ "$usuario" = habilitado ]; then
        echo "MIGRACION PENDIENTE: Mefisto se carga en todos tus repos. Deshabilitarlo a nivel usuario"
        echo "  lo deja activo solo en los repos que lo habilitan, como este."
    elif [ "$repo" = no ]; then
        echo "AVISO: este repo no habilita Mefisto en un .claude/settings.json commiteado."
        echo "  Agrega \"enabledPlugins\": {\"mefisto@$mkt\": true} (o corre /mefisto:onboard) y commitealo;"
        echo "  sin eso, Mefisto no se cargara aqui cuando lo deshabilites a nivel usuario."
    fi
}

# _mefisto_marketplace <raiz-del-paquete>: nombre del marketplace que provee mefisto.
# Del cache (<cache>/<mkt>/mefisto/<version>) si la raiz vive ahi; si no, el que apunta
# al repo de Mefisto en known_marketplaces.json; por ultimo el nombre publicado.
_mefisto_marketplace() {
    local root="${1%/}" padre known
    padre=$(dirname "$root")
    if [ "$(basename "$padre")" = mefisto ] && [ "$(basename "$(dirname "$(dirname "$padre")")")" = cache ]; then
        basename "$(dirname "$padre")"
        return 0
    fi
    known="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/known_marketplaces.json"
    if [ -f "$known" ] && command -v jq >/dev/null 2>&1; then
        jq -r --arg a "$MEFISTO_SLUG_PUBLICADO" --arg b "$MEFISTO_SLUG_PREVIO" \
            'to_entries[] | select(.value.source.repo == $a or .value.source.repo == $b) | .key' "$known" 2>/dev/null | head -1 | grep . && return 0
    fi
    echo augusto-romero-arango-harness
}

# _fuente_marketplace <marketplace>: objeto JSON 'source' del marketplace para
# extraKnownMarketplaces (de known_marketplaces.json; si no, el repo publicado).
_fuente_marketplace() {
    local known="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/known_marketplaces.json" src=""
    if [ -f "$known" ] && command -v jq >/dev/null 2>&1; then
        src=$(jq -c --arg m "$1" '.[$m].source // empty | select(.source == "github" or .source == "git")' "$known" 2>/dev/null)
    fi
    [ -n "$src" ] || src="{\"source\":\"github\",\"repo\":\"$MEFISTO_SLUG_PUBLICADO\"}"
    printf '%s\n' "$src"
}
