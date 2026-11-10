#!/usr/bin/env bash
# adapter-opencode.sh -- Traduce un artefacto neutral (frontmatter JSON +
# body, ver src/internal/contract/README.md) al formato que OpenCode 1.18.29
# consume: `description`, `mode`, `permission` (agente); `description`,
# `agent`, `subtask` (comando). Omite `model` para que los artefactos
# interactivos hereden la configuracion OpenCode del usuario; la tabla de
# perfiles de este adaptador solo aplica a pipelines headless. Sin `tools` --
# OpenCode no tiene un equivalente declarativo de
# restriccion de tools mas alla de `permission` (issue #862, que si define la
# emision de ese bloque). Issue #854.
#
# Se `source`a desde generate-internal-adapters.sh. Ninguna funcion de aqui
# escribe en disco: todas imprimen a stdout el contenido completo del archivo
# de salida, o fallan (return 1, mensaje ya impreso en stderr) sin imprimir
# nada por stdout.

# Wrapper temporal para la generacion de frontmatter. La tabla vive en el
# adaptador de ejecucion comun; se retira al migrar el generador.
adapter_opencode_default_model() {
    local runtime_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../runtime/lib/runtime-opencode.sh"
    source "$runtime_lib"
    runtime_opencode_default_model "$1"
}

# Traduccion de nivel neutral a variant nativo (issue #2505): la tabla vive en
# el adaptador de ejecucion comun y aqui solo se delega, mismo patron que
# adapter_opencode_default_model.
adapter_opencode_default_effort() {
    local runtime_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../runtime/lib/runtime-opencode.sh"
    source "$runtime_lib"
    runtime_opencode_default_effort "$1"
}

# OPENCODE_EFFORTS_PLUGIN_RELPATH -- ruta (relativa a la raiz de salida) del
# plugin de efforts de los agentes internos (issue #2505).
OPENCODE_EFFORTS_PLUGIN_RELPATH=".opencode/plugins/mefisto-efforts.js"

# opencode_render_efforts_plugin <marker_line> <agents_json> -- imprime el
# plugin de hook `config` que aplica el effort de fabrica de los agentes
# internos en conversaciones (issue #2505). <agents_json> es un array
# [{id, profile, effort}] ya ordenado por id; la tabla de nativos por defecto se
# obtiene de adapter_opencode_default_effort. Sin lectura de
# .mefisto/models.json en generacion: el plugin la lee en runtime, asi
# --check sigue siendo determinista. No comparte codigo con el plugin
# publicado (MEF-ADR-0019).
opencode_render_efforts_plugin() {
    local marker_line="$1" agents="$2" natives='{}' level native
    for level in quick light standard thorough exhaustive; do
        native="$(adapter_opencode_default_effort "$level")" || return 1
        natives="$(jq -c --arg level "$level" --arg native "$native" '. + {($level): $native}' <<< "$natives")" || return 1
    done
    printf '%s\n' "$marker_line"
    cat <<EOF
import { readFileSync } from "node:fs";
import { join } from "node:path";
const agents = $agents;
const natives = $natives;
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const pick = (object, key) => (isObject(object) && owns(object, key) ? object[key] : undefined);
const log = async (client, event, agent) => {
  try { await client?.app?.log?.({ body: { service: "mefisto", level: "warn", message: event, extra: { event, agent } } }); } catch { /* failure: continue */ }
};
const validTextMap = (value) => value === undefined || (isObject(value) && Object.values(value).every(isText));
const loadSection = (root) => {
  let text;
  try { text = readFileSync(join(root, ".mefisto", "models.json"), "utf8"); } catch (error) { return error?.code === "ENOENT" ? {} : null; }
  try {
    const mapping = JSON.parse(text);
    if (!isObject(mapping)) return null;
    const section = mapping.opencode === undefined ? {} : mapping.opencode;
    if (!isObject(section)) return null;
    const efforts = section.efforts;
    if (!validTextMap(section.profiles) || !validTextMap(section.agents)) return null;
    if (efforts !== undefined && (!isObject(efforts) || !validTextMap(efforts.agents) || !validTextMap(efforts.levels))) return null;
    return section;
  } catch { return null; }
};

export default async function mefistoInternalEfforts({ client, worktree, directory } = {}) {
  return {
    config: async (config) => {
      try {
        if (!isObject(config)) throw new Error("invalid_config");
        const section = loadSection(worktree || directory || process.cwd());
        if (section === null) { await log(client, "efforts_mapping_invalid"); return; }
        if (config.agent !== undefined && !isObject(config.agent)) throw new Error("invalid_agent");
        for (const { id, profile, effort } of agents) {
          const model = pick(section.agents, id) ?? pick(section.profiles, profile);
          if (model === undefined) continue;
          const level = pick(section.efforts?.agents, id) ?? effort;
          if (!owns(natives, level)) { await log(client, "efforts_level_invalid", id); continue; }
          const variant = pick(section.efforts?.levels, level) ?? natives[level];
          const actual = pick(config.agent, id);
          if (isObject(actual) && (actual.model !== undefined || actual.variant !== undefined)) { await log(client, "efforts_config_conflict", id); continue; }
          if (config.agent === undefined) config.agent = {};
          config.agent[id] = { ...(isObject(actual) ? actual : {}), model, variant };
        }
      } catch { await log(client, "efforts_config_hook_failed"); }
    },
  };
}
EOF
}

# OPENCODE_PERMISSIONS_MAPPING -- ruta al mapping declarativo capacidad ->
# permiso (issue #862), resuelta relativa a este propio archivo (mismo patron
# BASH_SOURCE que mefisto-state.sh usa desde _mefisto-common.sh) para que
# resuelva sea cual sea el cwd desde el que corra el generador.
OPENCODE_PERMISSIONS_MAPPING="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../contract/opencode-permissions.json"

# opencode_capability_known <capacidad> -- 0 si <capacidad> tiene mapeo a
# `permission` de OpenCode, 1 en cualquier otro caso, incluida `mcp` -- CA-5:
# sin mapeo definido todavia (mismo criterio que claude_map_capability_tools
# con `mcp` en adapter-claude.sh, aqui sin degradar nunca a un permiso
# inventado). El vocabulario NO se repite aqui: sale de las claves del propio
# mapping (`capability_scalar` + `capability_map`), que es la fuente de
# verdad; duplicarlo en un `case` dejaria que agregar una capacidad al JSON
# siguiera abortando en silencio por este lado.
opencode_capability_known() {
    jq -e --arg cap "$1" '
        ((.capability_scalar | keys_unsorted) + (.capability_map | keys_unsorted) + [.capability_question.capability])
        | index($cap) != null
    ' "$OPENCODE_PERMISSIONS_MAPPING" >/dev/null 2>&1
}

# opencode_permission_json <rel_source> <capabilities_json> <mode> -- imprime
# el objeto JSON compacto (orden de claves preservado, sin jq -S -- MEF-ADR-0049
# CA-6, issue #862 notas tecnicas) del bloque `permission` para un agente:
# valor explicito en las 17 claves del vocabulario de OpenCode 1.18.29
# (CA-1), derivado de <capabilities_json> (array neutral, puede llegar
# null/vacio -- capabilities: [] o ausente da un permiso cerrado por
# completo) y de <mode> (solo afecta `question`: allow en primary, deny en
# cualquier otro valor). Aborta (return 1, mensaje en stderr citando
# rel_source) si <capabilities_json> declara una capacidad sin mapeo OpenCode
# (CA-5): "<rel_source>: capacidad <x> sin mapeo OpenCode" -- sin imprimir
# nada por stdout. Aborta igual, con el mismo contrato, si el mapping
# declarativo no esta en su ruta (mismo criterio que el chequeo de libs
# requeridas de generate-internal-adapters.sh: mejor un motivo legible que un
# error crudo de jq).
opencode_permission_json() {
    local rel_source="$1" capabilities_json="${2:-[]}" mode="$3" skills_json="${4:-[]}"
    [ "$capabilities_json" = "null" ] && capabilities_json="[]"
    [ "$skills_json" = "null" ] && skills_json="[]"

    if [ ! -f "$OPENCODE_PERMISSIONS_MAPPING" ]; then
        echo "$rel_source: no existe el mapping de permisos '$OPENCODE_PERMISSIONS_MAPPING'" >&2
        return 1
    fi

    local cap
    while IFS= read -r cap; do
        [ -n "$cap" ] || continue
        if ! opencode_capability_known "$cap"; then
            echo "$rel_source: capacidad $cap sin mapeo OpenCode" >&2
            return 1
        fi
    done < <(printf '%s' "$capabilities_json" | jq -r '.[]')

    jq -c -n \
        --slurpfile mapping_arr "$OPENCODE_PERMISSIONS_MAPPING" \
        --argjson capabilities "$capabilities_json" \
        --argjson skills "$skills_json" \
        --arg mode "$mode" '
        ($mapping_arr[0]) as $m
        | (reduce ($m.always_deny[]) as $k ({}; . + {($k): "deny"}))
        + {"question": (if ($capabilities | index($m.capability_question.capability)) and ($m.capability_question.modes | index($mode))
                        then $m.capability_question.value else ($m.question[$mode] // "deny") end)}
        + (reduce ($m.capability_scalar | to_entries[]) as $e (
             {};
             . + (reduce ($e.value[]) as $k (
                    {};
                    . + {($k): (if ($capabilities | index($e.key)) then "allow" else "deny" end)}
                 ))
           ))
        + (reduce ($m.capability_map | to_entries[]) as $e (
             {};
             ($e.value) as $spec
             | (if ($capabilities | index($e.key))
                then ({"*": $spec.catch_all} + (reduce ($spec.rules[]) as $r ({}; . + {($r.pattern): $r.value})))
                else {"*": "deny"}
                end) as $obj
             | . + (reduce ($spec.keys[]) as $k ({}; . + {($k): $obj}))
           ))
        + (if ($capabilities | index("skill")) and ($skills | length > 0)
           then {"skill": ({"*": "deny"} + (reduce $skills[] as $s ({}; . + {($s): "allow"})))}
           else {} end)
        '
}

# opencode_translate_body <rel_source> <body> -- imprime el body con las
# directivas neutrales (CA-3) traducidas a su forma OpenCode:
#   {{mefisto:launch-agent <id>}}   -> "Actua como `<id>` con este mensaje inicial: $ARGUMENTS"
#                                      (solo cuando la directiva ocupa toda la linea)
#   {{mefisto:run <script> <args>}} -> MEFISTO_RUNTIME=opencode ./.claude/scripts/<script> <args>
#   {{mefisto:command-path <id>}}   -> .opencode/commands/<id>.md
# Las ultimas dos se traducen en el lugar exacto de la linea donde aparecen,
# preservando el texto que las rodea. Cualquier otra directiva
# "{{mefisto:...}}" aborta (return 1, mensaje en stderr citando rel_source y
# la linea) sin imprimir nada mas.
opencode_translate_body() {
    local rel_source="$1" body="$2" line
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^[[:space:]]*\{\{mefisto:launch-agent[[:space:]]+([A-Za-z0-9_-]+)\}\}[[:space:]]*$ ]]; then
            printf 'Actua como `%s` con este mensaje inicial: $ARGUMENTS\n' "${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^(.*)\{\{mefisto:run[[:space:]]+([^[:space:]]+)[[:space:]]*([^}]*)\}\}(.*)$ ]]; then
            local prefix="${BASH_REMATCH[1]}" script="${BASH_REMATCH[2]}" args suffix="${BASH_REMATCH[4]}"
            args="$(printf '%s' "${BASH_REMATCH[3]}" | sed -E 's/[[:space:]]+$//')"
            if [ -n "$args" ]; then
                printf '%sMEFISTO_RUNTIME=opencode ./.claude/scripts/%s %s%s\n' "$prefix" "$script" "$args" "$suffix"
            else
                printf '%sMEFISTO_RUNTIME=opencode ./.claude/scripts/%s%s\n' "$prefix" "$script" "$suffix"
            fi
        elif [[ "$line" =~ ^(.*)\{\{mefisto:command-path[[:space:]]+([A-Za-z0-9_-]+)\}\}(.*)$ ]]; then
            printf '%s.opencode/commands/%s.md%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
        elif [[ "$line" == *"{{mefisto:"* ]]; then
            echo "$rel_source: directiva de body desconocida: '$line'" >&2
            return 1
        else
            printf '%s\n' "$line"
        fi
    done <<< "$body"
    return 0
}

# opencode_extract_launch_agent_id <body> -- imprime el <id> de la primera
# directiva {{mefisto:launch-agent <id>}} que ocupe una linea completa del
# body, o nada si no hay ninguna. Usado para poblar el `agent` de un comando
# OpenCode cuando la fuente no declaro su propio campo `agent` (CA-3b) pero si
# usa la directiva (CA-3).
opencode_extract_launch_agent_id() {
    local body="$1" line
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^[[:space:]]*\{\{mefisto:launch-agent[[:space:]]+([A-Za-z0-9_-]+)\}\}[[:space:]]*$ ]]; then
            printf '%s' "${BASH_REMATCH[1]}"
            return 0
        fi
    done <<< "$body"
}

# opencode_render <rel_source> <instance_json> <marker_line> <body> --
# imprime el archivo OpenCode completo (frontmatter + marcador + body
# traducido) para un agente o comando. Retorna 1 sin imprimir nada si la
# traduccion del body falla (el motivo ya se imprimio en stderr).
opencode_render() {
    local rel_source="$1" instance_json="$2" marker_line="$3" body="$4"
    local kind translated_body skill_preamble=""
    kind="$(printf '%s' "$instance_json" | jq -r '.kind')"

    translated_body="$(opencode_translate_body "$rel_source" "$body")" || return 1

    local fm_lines=()
    fm_lines+=("description: $(printf '%s' "$instance_json" | jq -r '.description | @json')")
    if [ "$kind" = "agent" ]; then
        local mode
        mode="$(printf '%s' "$instance_json" | jq -r '.mode')"
        fm_lines+=("mode: $(printf '%s' "$instance_json" | jq -r '.mode | @json')")

        local capabilities_json skills_json permission_json
        capabilities_json="$(printf '%s' "$instance_json" | jq -c '.capabilities')"
        skills_json="$(printf '%s' "$instance_json" | jq -c '.skills // []')"
        # Sin la capacidad `skill` el permiso queda cerrado y `skills` se omite
        # (comportamiento previo a #1685): no se inventa un permiso que la
        # fuente no pidio.
        if ! printf '%s' "$capabilities_json" | jq -e 'index("skill") != null' >/dev/null 2>&1; then
            skills_json="[]"
        fi
        permission_json="$(opencode_permission_json "$rel_source" "$capabilities_json" "$mode" "$skills_json")" || return 1
        fm_lines+=("permission: $permission_json")
        if [ "$skills_json" != "[]" ]; then
            skill_preamble="Antes de ejecutar este body, usa la tool nativa \`skill\` para cargar, en este orden: $(printf '%s' "$skills_json" | jq -r 'map("`\(.)`") | join(", ")'). Si una carga es denegada o falla, detén la ejecución."
        fi
    else
        local agent_id
        agent_id="$(printf '%s' "$instance_json" | jq -r 'if (.agent != null) then .agent else empty end')"
        if [ -z "$agent_id" ]; then
            agent_id="$(opencode_extract_launch_agent_id "$body")"
        fi
        if [ -n "$agent_id" ]; then
            fm_lines+=("agent: $(printf '%s' "$agent_id" | jq -Rr '@json')")
            fm_lines+=("subtask: true")
        fi
    fi

    printf '%s\n' "---"
    printf '%s\n' "${fm_lines[@]}"
    printf '%s\n' "---"
    printf '%s\n' "$marker_line"
    [ -z "$skill_preamble" ] || printf '%s\n' "$skill_preamble"
    printf '%s\n' "$translated_body"
}
