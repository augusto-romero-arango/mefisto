#!/usr/bin/env bash
# adapter-claude.sh -- Traduce un artefacto neutral (frontmatter JSON + body,
# ver src/internal/contract/README.md) al formato que Claude Code consume:
# frontmatter YAML en bloque con escalares JSON-quoted (MEF-ADR-0049 CA-6),
# con `model` derivado de `profile` via la tabla fija de este adaptador
# (issue #857) pero sin flow mappings (issue #862). Issue #854.
#
# Se `source`a desde generate-internal-adapters.sh. Ninguna funcion de aqui
# escribe en disco: todas imprimen a stdout el contenido completo del archivo
# de salida, o fallan (return 1, mensaje ya impreso en stderr) sin imprimir
# nada por stdout.

# Wrapper temporal para la generacion de frontmatter. La tabla vive en el
# adaptador de ejecucion comun; se retira al migrar el generador.
adapter_claude_default_model() {
    local runtime_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../runtime/lib/runtime-claude.sh"
    source "$runtime_lib"
    runtime_claude_default_model "$1"
}

# adapter_claude_default_effort <effort> -- nivel nativo desde la tabla fija del
# adaptador de ejecucion comun (issue #2497); sin tabla duplicada aqui.
adapter_claude_default_effort() {
    local runtime_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../runtime/lib/runtime-claude.sh"
    source "$runtime_lib"
    runtime_claude_default_effort "$1"
}

# claude_map_capability_tools <capacidad> -- imprime la lista de tools de
# Claude Code que corresponde a una capacidad neutral (CA-2):
#   read->Read, Glob, Grep | edit->Edit, Write | shell->Bash |
#   web->WebFetch, WebSearch | skill->Skill | task->Task |
#   ask->AskUserQuestion
# `mcp` (y cualquier valor no listado) no tiene mapeo Claude definido todavia
# (issue #862): retorna 1 sin imprimir nada: el llamador decide el mensaje.
claude_map_capability_tools() {
    case "$1" in
        read) printf '%s' "Read, Glob, Grep" ;;
        edit) printf '%s' "Edit, Write" ;;
        shell) printf '%s' "Bash" ;;
        web) printf '%s' "WebFetch, WebSearch" ;;
        skill) printf '%s' "Skill" ;;
        task) printf '%s' "Task" ;;
        ask) printf '%s' "AskUserQuestion" ;;
        *) return 1 ;;
    esac
}

# claude_tools_string <rel_source> <capabilities_json> -- imprime el string
# "Tool1, Tool2, ..." que resulta de mapear cada capacidad del array JSON
# recibido (en el orden en que aparece en la fuente) y concatenar sus tools.
# Aborta (return 1, mensaje en stderr citando rel_source) si alguna capacidad
# no tiene mapeo Claude -- CA-2: "capacidad mcp sin mapeo Claude definido".
claude_tools_string() {
    local rel_source="$1" capabilities_json="$2"
    local cap mapped out=""
    while IFS= read -r cap; do
        [ -n "$cap" ] || continue
        if ! mapped="$(claude_map_capability_tools "$cap")"; then
            echo "$rel_source: capacidad $cap sin mapeo Claude definido" >&2
            return 1
        fi
        if [ -z "$out" ]; then
            out="$mapped"
        else
            out="$out, $mapped"
        fi
    done < <(printf '%s' "$capabilities_json" | jq -r '.[]')
    printf '%s' "$out"
}

# claude_translate_body <rel_source> <body> -- imprime el body con las
# directivas neutrales (CA-3) traducidas a su forma Claude Code:
#   {{mefisto:launch-agent <id>}}   -> bloque ```bash / claude --agent <id> "$ARGUMENTS" / ```
#                                      (solo cuando la directiva ocupa toda la linea)
#   {{mefisto:run <script> <args>}} -> MEFISTO_RUNTIME=claude ./.claude/scripts/<script> <args>
#   {{mefisto:command-path <id>}}   -> .claude/commands/<id>.md
# Las ultimas dos se traducen en el lugar exacto de la linea donde aparecen,
# preservando el texto que las rodea (permite anidarlas dentro de un comando
# mas largo, p. ej. `cat "{{mefisto:command-path <id>}}"`). Cualquier otra
# directiva "{{mefisto:...}}" aborta (return 1, mensaje en stderr citando
# rel_source y la linea) sin imprimir nada mas.
claude_translate_body() {
    local rel_source="$1" body="$2" line
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^[[:space:]]*\{\{mefisto:launch-agent[[:space:]]+([A-Za-z0-9_-]+)\}\}[[:space:]]*$ ]]; then
            printf '```bash\nclaude --agent %s "$ARGUMENTS"\n```\n' "${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^(.*)\{\{mefisto:run[[:space:]]+([^[:space:]]+)[[:space:]]*([^}]*)\}\}(.*)$ ]]; then
            local prefix="${BASH_REMATCH[1]}" script="${BASH_REMATCH[2]}" args suffix="${BASH_REMATCH[4]}"
            args="$(printf '%s' "${BASH_REMATCH[3]}" | sed -E 's/[[:space:]]+$//')"
            if [ -n "$args" ]; then
                printf '%sMEFISTO_RUNTIME=claude ./.claude/scripts/%s %s%s\n' "$prefix" "$script" "$args" "$suffix"
            else
                printf '%sMEFISTO_RUNTIME=claude ./.claude/scripts/%s%s\n' "$prefix" "$script" "$suffix"
            fi
        elif [[ "$line" =~ ^(.*)\{\{mefisto:command-path[[:space:]]+([A-Za-z0-9_-]+)\}\}(.*)$ ]]; then
            printf '%s.claude/commands/%s.md%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
        elif [[ "$line" == *"{{mefisto:"* ]]; then
            echo "$rel_source: directiva de body desconocida: '$line'" >&2
            return 1
        else
            printf '%s\n' "$line"
        fi
    done <<< "$body"
    return 0
}

# claude_render <rel_source> <instance_json> <marker_line> <body> -- imprime
# el archivo Claude Code completo (frontmatter + marcador + body traducido)
# para un agente o comando. Retorna 1 sin imprimir nada si la traduccion del
# body o el mapeo de alguna capacidad fallan (el motivo ya se imprimio en
# stderr desde la funcion que lo detecto).
claude_render() {
    local rel_source="$1" instance_json="$2" marker_line="$3" body="$4"
    local kind translated_body
    kind="$(printf '%s' "$instance_json" | jq -r '.kind')"

    translated_body="$(claude_translate_body "$rel_source" "$body")" || return 1

    local has_capabilities
    has_capabilities="$(printf '%s' "$instance_json" | jq -r 'if (.capabilities != null and (.capabilities | length) > 0) then "1" else "0" end')"

    local tools_q=""
    if [ "$has_capabilities" = "1" ]; then
        local tools_str
        tools_str="$(claude_tools_string "$rel_source" "$(printf '%s' "$instance_json" | jq -c '.capabilities')")" || return 1
        tools_q="$(printf '%s' "$tools_str" | jq -Rr '@json')"
    fi

    # `model` (issue #857): solo si la fuente declara `profile`, y solo la
    # tabla fija del adaptador (adapter_claude_default_model) -- nunca el
    # mapping local de .mefisto/models.json, que es estado de maquina y
    # romperia el determinismo de esta salida versionada entre maquinas.
    local model_q=""
    local has_profile
    has_profile="$(printf '%s' "$instance_json" | jq -r 'if (.profile != null) then "1" else "0" end')"
    if [ "$has_profile" = "1" ]; then
        local profile model
        profile="$(printf '%s' "$instance_json" | jq -r '.profile')"
        model="$(adapter_claude_default_model "$profile")"
        [ -n "$model" ] && model_q="$(printf '%s' "$model" | jq -Rr '@json')"
    fi

    local effort_q=""
    if [ "$kind" = "agent" ]; then
        local effort native_effort
        effort="$(printf '%s' "$instance_json" | jq -r '.effort // empty')"
        if [ -n "$effort" ]; then
            if ! native_effort="$(adapter_claude_default_effort "$effort")"; then
                echo "$rel_source: effort $effort sin traduccion Claude definida" >&2
                return 1
            fi
            effort_q="$(printf '%s' "$native_effort" | jq -Rr '@json')"
        fi
    fi

    local fm_lines=()
    if [ "$kind" = "agent" ]; then
        fm_lines+=("name: $(printf '%s' "$instance_json" | jq -r '.id | @json')")
        fm_lines+=("description: $(printf '%s' "$instance_json" | jq -r '.description | @json')")
        [ -n "$model_q" ] && fm_lines+=("model: $model_q")
        [ -n "$effort_q" ] && fm_lines+=("effort: $effort_q")
        [ -n "$tools_q" ] && fm_lines+=("tools: $tools_q")
        local has_skills
        has_skills="$(printf '%s' "$instance_json" | jq -r 'if (.skills != null and (.skills | length) > 0) then "1" else "0" end')"
        [ "$has_skills" = "1" ] && fm_lines+=("skills: $(printf '%s' "$instance_json" | jq -c '.skills')")
    else
        fm_lines+=("description: $(printf '%s' "$instance_json" | jq -r '.description | @json')")
        [ -n "$model_q" ] && fm_lines+=("model: $model_q")
        local has_arguments
        has_arguments="$(printf '%s' "$instance_json" | jq -r 'if (.arguments != null) then "1" else "0" end')"
        [ "$has_arguments" = "1" ] && fm_lines+=("argument-hint: $(printf '%s' "$instance_json" | jq -r '.arguments | @json')")
        [ -n "$tools_q" ] && fm_lines+=("allowed-tools: $tools_q")
    fi

    printf '%s\n' "---"
    printf '%s\n' "${fm_lines[@]}"
    printf '%s\n' "---"
    printf '%s\n' "$marker_line"
    printf '%s\n' "$translated_body"
}
