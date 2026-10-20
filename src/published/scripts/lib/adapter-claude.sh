#!/usr/bin/env bash
# Funciones del renderizador Claude Code. Solo imprimen stdout; el generador
# publica el staging completo de forma atomica.

published_claude_error() { printf '%s: %s: %s\n' "$1" "$2" "$3" >&2; return 1; }
published_claude_model() { case "$1" in fast) printf haiku ;; balanced) printf sonnet ;; deep) printf opus ;; *) return 1 ;; esac; }
published_claude_capability_tools() { case "$1" in read) printf 'Read, Glob, Grep' ;; edit) printf 'Edit, Write' ;; shell) printf Bash ;; web) printf 'WebFetch, WebSearch' ;; skill) printf Skill ;; task) printf Task ;; ask) printf AskUserQuestion ;; *) return 1 ;; esac; }
published_claude_mcp_tools() { case "$1" in microsoft-learn) printf 'mcp__microsoft-learn__*, mcp__plugin_mefisto_microsoft-learn__*' ;; terraform) printf 'mcp__terraform__*, mcp__plugin_terraform_terraform__*' ;; *) return 1 ;; esac; }

published_claude_tools() {
    local rel="$1" instance="$2" item mapped output='' capabilities mcp
    capabilities="$(printf '%s' "$instance" | jq -r '.capabilities[]?')" || { published_claude_error "$rel" capabilities 'no se pudieron leer'; return 1; }
    while IFS= read -r item; do
        [ -z "$item" ] && continue
        if ! mapped="$(published_claude_capability_tools "$item")"; then published_claude_error "$rel" capabilities "capacidad '$item' sin mapping Claude"; return 1; fi
        [ -z "$output" ] || output="$output, "; output="$output$mapped"
    done <<< "$capabilities"
    mcp="$(printf '%s' "$instance" | jq -r '.mcp[]?')" || { published_claude_error "$rel" mcp 'no se pudo leer'; return 1; }
    while IFS= read -r item; do
        [ -z "$item" ] && continue
        if ! mapped="$(published_claude_mcp_tools "$item")"; then published_claude_error "$rel" mcp "servidor MCP '$item' sin matcher Claude"; return 1; fi
        [ -z "$output" ] || output="$output, "; output="$output$mapped"
    done <<< "$mcp"
    printf '%s' "$output"
}

published_claude_validate_skills() {
    local rel="$1" instance="$2" repo_root="$3" skill skills
    skills="$(printf '%s' "$instance" | jq -r '.skills[]?')" || { published_claude_error "$rel" skills 'no se pudieron leer'; return 1; }
    while IFS= read -r skill; do
        [ -z "$skill" ] && continue
        [ -f "$repo_root/skills/$skill/SKILL.md" ] || { published_claude_error "$rel" skills "Skill publicado '$skill' no resuelve"; return 1; }
    done <<< "$skills"
}

published_claude_needs_package_root() {
    case "$1" in *'{{mefisto:run '*|*'{{mefisto:package-root}}'*|*'{{mefisto:skill-root '*|*'{{mefisto:command-doc '*) return 0 ;; *) return 1 ;; esac
}

published_claude_lifecycle_launcher_preamble() {
    cat <<'EOF'
```bash
mefisto_lifecycle_data_root() {
    if [ -n "${XDG_DATA_HOME:-}" ]; then printf '%s/mefisto\n' "$XDG_DATA_HOME"
    elif [ "$(uname -s)" = Darwin ]; then printf '%s/Library/Application Support/mefisto\n' "$HOME"
    else printf '%s/.local/share/mefisto\n' "$HOME"; fi
}
mefisto_lifecycle_config_root() {
    if [ "${OPENCODE_CONFIG_DIR+x}" = x ]; then
        [ -n "$OPENCODE_CONFIG_DIR" ] || return 1
        printf '%s\n' "$OPENCODE_CONFIG_DIR"
    else
        printf '%s/opencode\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
    fi
}
MEFISTO_LIFECYCLE_LAUNCHER="$(mefisto_lifecycle_data_root)/active/bin/mefisto-opencode"
MEFISTO_LIFECYCLE_CONFIG_ROOT="$(mefisto_lifecycle_config_root)" || {
    printf '%s\n' 'Estado OpenCode: unavailable (OPENCODE_CONFIG_DIR esta definido pero vacio).' >&2
    MEFISTO_LIFECYCLE_CONFIG_ROOT='unavailable'
}
if [ ! -f "$MEFISTO_LIFECYCLE_LAUNCHER" ] || [ -L "$MEFISTO_LIFECYCLE_LAUNCHER" ] || [ ! -x "$MEFISTO_LIFECYCLE_LAUNCHER" ]; then
    printf 'Estado OpenCode: unavailable (no hay launcher estable disponible). Raiz efectiva: %s\n' "$MEFISTO_LIFECYCLE_CONFIG_ROOT" >&2
fi
export MEFISTO_LIFECYCLE_LAUNCHER MEFISTO_LIFECYCLE_CONFIG_ROOT
```
EOF
}

# Este bloque se emite dentro del artefacto Claude, no en la fuente neutral. No
# carga codigo desde el candidato: valida primero la metadata de distribucion.
published_claude_package_root_preamble() {
    cat <<'EOF'
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
EOF
}

# Reemplaza de derecha a izquierda para conservar texto circundante y permitir
# varias directivas inline en una misma linea.
published_claude_translate_body() {
    local rel="$1" input="$2" line original translated prefix suffix script args
    while IFS= read -r line || [ -n "$line" ]; do
        original="$line"
        while [[ "$line" == *'{{mefisto:'* ]]; do
            translated=''
            if [[ "$line" =~ ^(.*)\{\{mefisto:run[[:space:]]+([^[:space:]]+)[[:space:]]+([^}]*)\}\}(.*)$ ]]; then
                prefix="${BASH_REMATCH[1]}"; script="${BASH_REMATCH[2]}"; args="${BASH_REMATCH[3]}"; suffix="${BASH_REMATCH[4]}"
                args="$(printf '%s' "$args" | sed -E 's/[[:space:]]+$//')"
                translated="${prefix}MEFISTO_RUNTIME=claude \"\${MEFISTO_PACKAGE_ROOT}/scripts/${script}\" ${args}${suffix}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:loaded-root\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}"'${CLAUDE_PLUGIN_ROOT}'"${BASH_REMATCH[2]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:lifecycle-launcher\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}$(published_claude_lifecycle_launcher_preamble)${BASH_REMATCH[2]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:package-root\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}\${MEFISTO_PACKAGE_ROOT}${BASH_REMATCH[2]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:skill-root[[:space:]]+([a-z0-9]+(-[a-z0-9]+)*)\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}\"\${MEFISTO_PACKAGE_ROOT}/skills/${BASH_REMATCH[2]}\"${BASH_REMATCH[4]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:command-doc[[:space:]]+([a-z0-9]+(-[a-z0-9]+)*)\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}\"\${MEFISTO_PACKAGE_ROOT}/commands/${BASH_REMATCH[2]}.md\"${BASH_REMATCH[4]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:config-path\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}\${MEFISTO_CONFIG_PATH}${BASH_REMATCH[2]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:instructions-path\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}\${MEFISTO_INSTRUCTIONS_PATH}${BASH_REMATCH[2]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:state-path[[:space:]]+([A-Za-z0-9][A-Za-z0-9._/-]*)\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}.mefisto/pipeline/${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:command[[:space:]]+([a-z0-9-]+)\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}/mefisto:${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:launch-agent[[:space:]]+([a-z0-9-]+)[[:space:]]+([^{}]+)\}\}(.*)$ ]]; then
                args="$(printf '%s' "${BASH_REMATCH[3]}" | sed -E 's/[[:space:]]+$//')"
                translated="${BASH_REMATCH[1]}invoca la tool \`Task\` con el agente \`mefisto:${BASH_REMATCH[2]}\` y este mensaje: ${args}. Espera su resultado final y continua con el paso siguiente del comando.${BASH_REMATCH[4]}"
            elif [[ "$line" =~ ^(.*)\{\{mefisto:assert-consumer-repo\}\}(.*)$ ]]; then
                translated="${BASH_REMATCH[1]}Antes de continuar, aborta si existe \`src/internal/scripts/generate-internal-adapters.sh\`: ese directorio es el repositorio de Mefisto, no un consumidor.${BASH_REMATCH[2]}"
            else
                published_claude_error "$rel" body "directiva sin mapping Claude: '$original'"; return 1
            fi
            line="$translated"
        done
        printf '%s\n' "$line"
    done <<< "$input"
}

published_claude_render() {
    local source="$1" marker="$2" repo_root="$3" rel fm instance kind raw_body translated preamble='' tools profile model model_line='' agent
    rel="${source#"$repo_root"/}"
    fm="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$source")" || { published_claude_error "$rel" frontmatter 'no se pudo extraer'; return 1; }
    instance="$(printf '%s\n' "$fm" | jq -c '.' 2>/dev/null)" || { published_claude_error "$rel" frontmatter 'no es JSON valido'; return 1; }
    kind="$(printf '%s' "$instance" | jq -r '.kind')"
    raw_body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$source")" || { published_claude_error "$rel" body 'no se pudo extraer'; return 1; }
    translated="$(published_claude_translate_body "$rel" "$raw_body")" || return 1
    if published_claude_needs_package_root "$raw_body"; then preamble="$(published_claude_package_root_preamble)"; fi
    local needs_config=0 needs_instructions=0
    published_effective_contract_needs_config "$raw_body" && needs_config=1
    published_effective_contract_needs_instructions "$raw_body" && needs_instructions=1
    if [ "$needs_config" -eq 1 ] || [ "$needs_instructions" -eq 1 ]; then
        [ -z "$preamble" ] || preamble="$preamble"$'\n'
        preamble="$preamble$(published_effective_contract_preamble "$needs_config" "$needs_instructions")"
    fi
    tools="$(published_claude_tools "$rel" "$instance")" || return 1
    published_claude_validate_skills "$rel" "$instance" "$repo_root" || return 1
    profile="$(printf '%s' "$instance" | jq -r '.profile // empty')"
    if [ -n "$profile" ]; then
        model="$(published_claude_model "$profile")" || { published_claude_error "$rel" profile "perfil '$profile' sin mapping Claude"; return 1; }
        [ -z "$model" ] || model_line="model: $(printf '%s' "$model" | jq -Rr '@json')"
    fi
    printf '%s\n' '---'
    if [ "$kind" = agent ]; then
        printf 'name: %s\ndescription: %s\n' "$(printf '%s' "$instance" | jq -r '.id | @json')" "$(printf '%s' "$instance" | jq -r '.description | @json')"
        [ -z "$tools" ] || printf 'tools: %s\n' "$(printf '%s' "$tools" | jq -Rr '@json')"
        [ "$(printf '%s' "$instance" | jq '.skills // [] | length')" -eq 0 ] || printf 'skills: %s\n' "$(printf '%s' "$instance" | jq -c '.skills')"
    else
        printf 'description: %s\n' "$(printf '%s' "$instance" | jq -r '.description | @json')"
        [ "$(printf '%s' "$instance" | jq -r '.arguments != null')" = true ] && printf 'argument-hint: %s\n' "$(printf '%s' "$instance" | jq -r '.arguments | @json')"
        [ -z "$tools" ] || printf 'allowed-tools: %s\n' "$(printf '%s' "$tools" | jq -Rr '@json')"
    fi
    [ -z "$model_line" ] || printf '%s\n' "$model_line"
    printf '%s\n%s\n' '---' "$marker"
    [ -z "$preamble" ] || printf '%s\n' "$preamble"
    if [ "$kind" = command ]; then
        agent="$(printf '%s' "$instance" | jq -r '.agent // empty')"
        [ -z "$agent" ] || printf '%s\n' "Delega este comando completo: invoca la tool \`Task\` con el agente \`mefisto:${agent}\` y \$ARGUMENTS como mensaje, junto con las instrucciones que siguen; no las ejecutes tu mismo. Espera su resultado final y devuelvelo."
    fi
    printf '%s\n' "$translated"
}
