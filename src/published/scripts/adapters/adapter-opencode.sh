#!/usr/bin/env bash
# Renderizador OpenCode de artefactos publicados neutrales. Se invoca mediante
# generate-published-adapters.sh; no escribe fuera de stdout.
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MAPPING="$SCRIPT_DIR/../../contract/opencode-permissions.json"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
SKILLS_ROOT="$REPO_ROOT/skills"
HOOKS_CONTRACT="$REPO_ROOT/src/published/hooks/interactive-hooks.json"
HOOKS_VALIDATOR="$REPO_ROOT/src/published/scripts/validate-interactive-hooks.sh"
MCP_REGISTRY="$REPO_ROOT/src/published/contract/mcp-servers.json"
MCP_VALIDATOR="$REPO_ROOT/src/published/scripts/validate-published-mcp.sh"
source "$SCRIPT_DIR/../lib/effective-contract.sh" || { printf '%s\n' "ERROR: falta src/published/scripts/lib/effective-contract.sh; sin esa biblioteca las rutas efectivas del contrato consumidor no se resolverian." >&2; exit 1; }

error() { printf '%s\n' "$1" >&2; return 1; }
frontmatter() { awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$1"; }
body() { awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$1"; }
needs_package_root() { case "$1" in *'{{mefisto:run '*|*'{{mefisto:package-root}}'*|*'{{mefisto:skill-root '*|*'{{mefisto:command-doc '*) return 0 ;; *) return 1 ;; esac; }

package_root_preamble() {
    cat <<'EOF'
```bash
# Cada llamada bash que use ${MEFISTO_PACKAGE_ROOT} debe incluir este bloque antes de sus comandos: no se asume estado de shell persistente entre llamadas.
if [ -n "${XDG_DATA_HOME:-}" ]; then mefisto_opencode_launcher="$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
elif [ "${OSTYPE%%[0-9.]*}" = darwin ]; then mefisto_opencode_launcher="$HOME/Library/Application Support/mefisto/active/bin/mefisto-opencode"
else mefisto_opencode_launcher="$HOME/.local/share/mefisto/active/bin/mefisto-opencode"; fi
if [ ! -f "$mefisto_opencode_launcher" ] || [ -L "$mefisto_opencode_launcher" ] || [ ! -x "$mefisto_opencode_launcher" ]; then
    printf '%s\n' 'ERROR OpenCode: no hay una release activa valida; instale o active la release OpenCode.' >&2; exit 1
fi
MEFISTO_PACKAGE_ROOT="$("$mefisto_opencode_launcher" package-root)" || {
    printf '%s\n' 'ERROR OpenCode: no se pudo resolver la release activa; instale o active la release OpenCode.' >&2; exit 1;
}
case "$MEFISTO_PACKAGE_ROOT" in
    /*) ;;
    *) printf '%s\n' 'ERROR OpenCode: la release activa no devolvio una raiz absoluta; reinstale o active la release OpenCode.' >&2; exit 1 ;;
esac
MEFISTO_PACKAGE_ROOT="$(cd -P "$MEFISTO_PACKAGE_ROOT" 2>/dev/null && printf '%s\n' "$PWD")" || {
    printf '%s\n' 'ERROR OpenCode: la release activa no existe; reinstale o active la release OpenCode.' >&2; exit 1;
}
export MEFISTO_PACKAGE_ROOT
```
EOF
}

permission_json() {
    local rel="$1" capabilities="$2" mode="$3" native_skills="$4" validation status payload
    [ -f "$MAPPING" ] || { error "$rel: capabilities: no existe el mapping de permisos OpenCode"; return 1; }
    # Una sola pasada jq valida a la vez la completitud del mapping y que cada
    # capacidad solicitada tenga contraparte OpenCode (evita un jq por capacidad).
    validation="$(jq -r --argjson capabilities "$capabilities" '
      . as $m |
      ([$m.always_deny[], "external_directory", "question", $m.capability_scalar[][], $m.capability_map[].keys[]] | unique) as $mapped |
      (($m.supported_permissions | length) == 17 and
       ($m.supported_permissions | unique | length) == 17 and
       ($m.supported_permissions | all(. as $key | $mapped | index($key) != null)) and
       ($mapped | all(. as $key | $m.supported_permissions | index($key) != null))) as $mapping_ok |
      (($m.capability_scalar | keys) + ($m.capability_map | keys) + [$m.capability_question.capability]) as $known |
      ($capabilities | map(select(. as $cap | ($known | index($cap)) == null)) | .[0]) as $unknown |
      if ($mapping_ok | not) then "mapping\u001f"
      elif ($unknown != null) then "capability\u001f\($unknown)"
      else "ok\u001f" end
    ' "$MAPPING" 2>/dev/null)" || { error "$rel: capabilities: mapping OpenCode incompleto o invalido"; return 1; }
    IFS=$'\x1f' read -r status payload <<< "$validation"
    case "$status" in
        mapping) error "$rel: capabilities: mapping OpenCode incompleto o invalido"; return 1 ;;
        capability) error "$rel: capabilities: capacidad '$payload' sin mapping OpenCode"; return 1 ;;
        ok) ;;
        *) error "$rel: capabilities: validacion OpenCode no representable"; return 1 ;;
    esac
    jq -cn --slurpfile mapping "$MAPPING" --argjson capabilities "$capabilities" --argjson native_skills "$native_skills" --arg mode "$mode" '
      ($mapping[0]) as $m |
      ($m.external_directory) as $ext |
      {external_directory: (if ($capabilities | any(. as $c | $ext.scoped_to | index($c) != null))
                            then ({"*": $ext.catch_all} + reduce ($ext.allow[]) as $path ({}; . + {($path): "allow"}))
                            else "deny" end)} +
      (reduce ($m.always_deny[]) as $key ({}; . + {($key): "deny"})) +
      {question: (if ($capabilities | index($m.capability_question.capability)) and ($m.capability_question.modes | index($mode)) then $m.capability_question.value else ($m.question[$mode] // "deny") end)} +
      (reduce ($m.capability_scalar | to_entries[]) as $entry ({};
        . + (reduce ($entry.value[]) as $key ({};
          . + {($key): (if $capabilities | index($entry.key) then "allow" else "deny" end)})))) +
       (reduce ($m.capability_map | to_entries[]) as $entry ({};
         ($entry.value) as $spec |
         . + (reduce ($spec.keys[]) as $key ({};
           . + {($key): (if $capabilities | index($entry.key)
                          then ({"*": $spec.catch_all} + reduce ($spec.rules + (if $entry.key == "shell" then [$m.release_readonly_guard.bash_write_commands[] as $cmd | $m.release_readonly_guard.path_markers[] as $mk | {pattern: ($cmd + $mk + "*"), value: "deny"}] else [] end))[] as $rule ({}; . + {($rule.pattern): $rule.value}))
                          else {"*": "deny"} end)})))) +
       (if ($capabilities | index("skill")) and ($native_skills | length > 0)
        then {skill: ({"*": "deny"} + reduce $native_skills[] as $skill ({}; . + {($skill): "allow"}))}
        else {} end)'
}

# OpenCode controla las tools MCP por agente con el prefijo del servidor. La
# fuente conserva ids logicos y el registro determina la politica cerrada.
# La validacion global del registro (esquema, transporte, autenticacion) ya
# corre una vez en las operaciones assets/render-asset antes de publicar; aqui
# solo se reafirman en una unica pasada jq las invariantes locales que
# permission_json/render necesitan por fuente: sin duplicados en el registro,
# todo id de registro con mapping OpenCode, todo id solicitado presente y sin
# duplicados en lo solicitado.
mcp_tools_json() {
    local rel="$1" requested="$2" mapping result status payload
    mapping='{"microsoft-learn":"microsoft-learn_*","terraform":"terraform_*"}'
    result="$(jq -nr --slurpfile registry "$MCP_REGISTRY" --argjson requested "$requested" --argjson mapping "$mapping" '
      ($registry[0]) as $r |
      ($r.servers | map(.id)) as $ids |
      ($ids | map(. as $id |
          if (($ids | map(select(. == $id)) | length) > 1) then {type: "dup_registry", id: $id}
          elif ($mapping[$id] == null) then {type: "no_mapping", id: $id}
          else null end)
        | map(select(. != null)) | .[0]) as $problem |
      ($requested | map(select(. as $req | ($ids | index($req)) == null)) | .[0]) as $absent |
      (($requested | length) != ($requested | unique | length)) as $dup_requested |
      if ($problem != null) then "\($problem.type)\u001f\($problem.id)"
      elif ($absent != null) then "absent\u001f\($absent)"
      elif $dup_requested then "dup_requested\u001f"
      else "ok\u001f" + (reduce $r.servers[] as $server ({}; . + {($mapping[$server.id]): (($requested | index($server.id)) != null)}) | tojson)
      end
    ' 2>/dev/null)" || { error "$rel: mcp: no se pudo leer el registro MCP"; return 1; }
    IFS=$'\x1f' read -r status payload <<< "$result"
    case "$status" in
        dup_registry) error "$rel: mcp: id MCP '$payload' duplicado en el registro"; return 1 ;;
        no_mapping) error "$rel: mcp: id MCP '$payload' sin mapping OpenCode"; return 1 ;;
        absent) error "$rel: mcp: id MCP '$payload' ausente del registro"; return 1 ;;
        dup_requested) error "$rel: mcp: referencia MCP duplicada"; return 1 ;;
        ok) printf '%s' "$payload" ;;
        *) error "$rel: mcp: resultado OpenCode no representable"; return 1 ;;
    esac
}

published_opencode_translate_body() {
    local rel="$1" input="$2" line original prefix suffix script args translated
    while IFS= read -r line || [ -n "$line" ]; do
        original="$line"
        if [[ "$line" =~ ^[[:space:]]*\{\{mefisto:assert-consumer-repo\}\}[[:space:]]*$ ]]; then
            printf '%s\n' 'Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.'
        else
            # Se reemplaza de derecha a izquierda para admitir varias
            # directivas inline sin perder el texto que las rodea.
            while [[ "$line" == *'{{mefisto:'* ]]; do
                translated=""
                if [[ "$line" =~ ^(.*)\{\{mefisto:run[[:space:]]+([^[:space:]]+)[[:space:]]+([^}]*)\}\}(.*)$ ]]; then
                    prefix="${BASH_REMATCH[1]}"; script="${BASH_REMATCH[2]}"; args="${BASH_REMATCH[3]}"; suffix="${BASH_REMATCH[4]}"
                    args="$(printf '%s' "$args" | sed -E 's/[[:space:]]+$//')"
                    translated="${prefix}MEFISTO_RUNTIME=opencode "'"${MEFISTO_PACKAGE_ROOT}'"/scripts/${script}\" ${args}${suffix}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:package-root\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}"'${MEFISTO_PACKAGE_ROOT}'"${BASH_REMATCH[2]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:skill-root[[:space:]]+([a-z0-9]+(-[a-z0-9]+)*)\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}\"\${MEFISTO_PACKAGE_ROOT}/skills/mefisto-${BASH_REMATCH[2]}\"${BASH_REMATCH[4]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:command-doc[[:space:]]+([a-z0-9]+(-[a-z0-9]+)*)\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}\"\${MEFISTO_PACKAGE_ROOT}/commands/mefisto:${BASH_REMATCH[2]}.md\"${BASH_REMATCH[4]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:loaded-root\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:lifecycle-launcher\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}$(lifecycle_launcher_preamble)${BASH_REMATCH[2]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:config-path\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}"'${MEFISTO_CONFIG_PATH}'"${BASH_REMATCH[2]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:instructions-path\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}"'${MEFISTO_INSTRUCTIONS_PATH}'"${BASH_REMATCH[2]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:state-path[[:space:]]+([A-Za-z0-9][A-Za-z0-9._/-]*)\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}.mefisto/pipeline/${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:command[[:space:]]+([a-z0-9-]+)\}\}(.*)$ ]]; then
                    translated="${BASH_REMATCH[1]}/mefisto:${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
                elif [[ "$line" =~ ^(.*)\{\{mefisto:launch-agent[[:space:]]+([a-z0-9-]+)[[:space:]]+([^{}]+)\}\}(.*)$ ]]; then
                    args="$(printf '%s' "${BASH_REMATCH[3]}" | sed -E 's/[[:space:]]+$//')"
                    translated="${BASH_REMATCH[1]}invoca la tool \`task\` con el agente \`${BASH_REMATCH[2]}\` y este mensaje: ${args}. Espera su resultado final y continua con el paso siguiente del comando.${BASH_REMATCH[4]}"
                else
                    error "$rel: body: directiva sin mapping OpenCode: '$original'"
                    return 1
                fi
                line="$translated"
            done
            printf '%s\n' "$line"
        fi
    done <<< "$input"
}

lifecycle_launcher_preamble() {
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

# OpenCode descubre Skills por directorio. La fuente permanece nativa para
# Claude; este borde adapta a la vez el directorio y el campo name (ADR-0050).
# Una sola pasada awk extrae name+description (evita un awk por campo). Emite
# ademas cuantas veces aparecio cada clave para que el llamador conserve el
# diagnostico propio de cada una en vez de colapsarlas en un unico mensaje.
skill_frontmatter_pair() {
    local key1="$1" key2="$2" source="$3"
    awk -v key1="$key1" -v key2="$key2" '
        NR == 1 { if ($0 != "---") exit 1; next }
        $0 == "---" { closed=1; exit }
        $0 ~ "^" key1 ":[[:space:]]*" {
            found1++
            value1=$0
            sub("^" key1 ":[[:space:]]*", "", value1)
            sub(/[[:space:]]+$/, "", value1)
        }
        $0 ~ "^" key2 ":[[:space:]]*" {
            found2++
            value2=$0
            sub("^" key2 ":[[:space:]]*", "", value2)
            sub(/[[:space:]]+$/, "", value2)
        }
        END {
            if (!closed) exit 1
            printf "%d\x1f%d\x1f%s\x1f%s\n", found1 + 0, found2 + 0, value1, value2
        }
    ' "$source"
}

skill_frontmatter_decode() {
    local raw="$1"
    case "$raw" in
        \"*\") printf '%s' "$raw" | jq -Rer 'fromjson | strings' ;;
        \'*\') printf '%s' "$raw" | sed "s/^'//; s/'$//; s/''/'/g" ;;
        \"*|*\"|\'*|*\') return 1 ;;
        *) printf '%s' "$raw" ;;
    esac
}

# physical_root ya viene resuelto por skill (una sola vez desde validate_skills)
# para no forzar un fork cd+pwd por archivo. dirname/basename se resuelven con
# expansion de parametros, y el grep de enlaces corre una sola vez por Skill
# (con -H para distinguir archivo) en vez de un fork de grep por archivo.
validate_skill_links_batch() {
    local skill_root="$1" physical_root="$2" files=() f line source target target_dir target_file physical_target_dir raw_dir
    local last_source=$'\x01' last_raw_dir=$'\x01' last_physical_target_dir='' sep=':]('
    while IFS= read -r f; do files+=("$f"); done < <(find "$skill_root" -type f | LC_ALL=C sort)
    [ "${#files[@]}" -gt 0 ] || return 0
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        # grep -H imprime "<archivo>:](<destino>"; se corta por la primera
        # ocurrencia de ":](" y no por el primer ':', que puede venir en la
        # ruta absoluta del propio repo.
        source="${line%%"$sep"*}"
        target="${line#*"$sep"}"
        case "$target" in ''|*'://'*|mailto:*|/*|\#*) continue ;; esac
        if [ "$source" != "$last_source" ]; then
            target_dir="${source%/*}"
            [ "$target_dir" != "$source" ] || target_dir="."
            last_source="$source"
        fi
        target_file="$target_dir/$target"
        [ -e "$target_file" ] && [ ! -L "$target_file" ] || { error "$source: links: enlace local no resoluble: $target"; return 1; }
        # Memoiza la resolucion fisica por directorio crudo: varios enlaces de
        # un mismo archivo (o directorio) comparten el mismo fork cd+pwd -P.
        raw_dir="${target_file%/*}"
        if [ "$raw_dir" = "$last_raw_dir" ]; then
            physical_target_dir="$last_physical_target_dir"
        else
            physical_target_dir="$(cd "$raw_dir" 2>/dev/null && pwd -P)" || return 1
            last_raw_dir="$raw_dir"
            last_physical_target_dir="$physical_target_dir"
        fi
        case "$physical_target_dir/${target_file##*/}" in "$physical_root"/*) ;; *) error "$source: links: enlace local fuera del Skill: $target"; return 1 ;; esac
    done < <(grep -HoE '\]\([^ )#]+' "${files[@]}" 2>/dev/null || true)
}

validate_skills() {
    local skill skill_id source_name description adapted entry invalid_entry physical_root pair
    local name_found description_found name_raw description_raw
    [ -d "$SKILLS_ROOT" ] && [ ! -L "$SKILLS_ROOT" ] || { error 'skills: la raiz publicada no existe o es un symlink'; return 1; }
    while IFS= read -r skill; do
        [ ! -L "$skill" ] || { error "${skill#"$REPO_ROOT/"}: skill no puede ser symlink"; return 1; }
        skill_id="${skill##*/}"
        case "$skill_id" in *[!a-z0-9-]*|''|-*|*--*|*-) error "$skill_id: id de Skill invalido"; return 1 ;; esac
        [ -f "$skill/SKILL.md" ] && [ ! -L "$skill/SKILL.md" ] || { error "skills/$skill_id: falta SKILL.md regular"; return 1; }
        # La asignacion previa al read captura el exit code real de awk: un
        # read sobre "$(cmd)" en linea perderia el fallo de cmd (siempre 0).
        pair="$(skill_frontmatter_pair name description "$skill/SKILL.md")" || { error "skills/$skill_id/SKILL.md: frontmatter o name invalido"; return 1; }
        IFS=$'\x1f' read -r name_found description_found name_raw description_raw <<< "$pair"
        [ "$name_found" = 1 ] || { error "skills/$skill_id/SKILL.md: frontmatter o name invalido"; return 1; }
        source_name="$(skill_frontmatter_decode "$name_raw")" || { error "skills/$skill_id/SKILL.md: frontmatter o name invalido"; return 1; }
        [ "$source_name" = "$skill_id" ] || { error "skills/$skill_id/SKILL.md: name debe coincidir con el directorio"; return 1; }
        adapted="mefisto-$skill_id"
        [ "${#adapted}" -le 64 ] || { error "skills/$skill_id: nombre OpenCode supera 64 caracteres"; return 1; }
        [ "$description_found" = 1 ] || { error "skills/$skill_id/SKILL.md: falta description valida"; return 1; }
        description="$(skill_frontmatter_decode "$description_raw")" || { error "skills/$skill_id/SKILL.md: falta description valida"; return 1; }
        [ "${#description}" -ge 1 ] && [ "${#description}" -le 1024 ] || { error "skills/$skill_id/SKILL.md: description debe tener entre 1 y 1024 caracteres"; return 1; }
        # physical_root se resuelve una vez por Skill (no por archivo): evita
        # repetir el fork cd+pwd -P por cada recurso al validar sus enlaces.
        physical_root="$(cd "$skill" && pwd -P)" || { error "skills/$skill_id: no se pudo resolver la raiz fisica"; return 1; }
        validate_skill_links_batch "$skill" "$physical_root" || return 1
    done < <(find "$SKILLS_ROOT" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)
    for entry in "$SKILLS_ROOT"/*; do
        [ -e "$entry" ] || continue
        [ -d "$entry" ] || { error "${entry#"$REPO_ROOT/"}: un Skill debe ser un directorio"; return 1; }
    done
    if find "$SKILLS_ROOT" -type l -print -quit | grep -q .; then error 'skills: no se admiten symlinks en la fuente'; return 1; fi
    invalid_entry="$(find "$SKILLS_ROOT" ! -type f ! -type d -print -quit)"
    [ -z "$invalid_entry" ] || { error "${invalid_entry#"$REPO_ROOT/"}: recurso de Skill no regular"; return 1; }
}

# Las referencias siguen siendo ids neutrales en la fuente. La existencia se
# comprueba contra el mismo arbol que el adaptador empaqueta como Skills nativos.
native_skills() {
    local rel="$1" skills_json="$2" skill adapted seen='|' output=''
    validate_skills || return 1
    while IFS= read -r skill; do
        case "$skill" in
            mefisto-*) error "$rel: skills: la referencia '$skill' ya tiene prefijo OpenCode"; return 1 ;;
            *[!a-z0-9-]*|''|-*|*--*|*-) error "$rel: skills: referencia no representable '$skill'"; return 1 ;;
        esac
        case "$seen" in *"|$skill|"*) error "$rel: skills: referencia duplicada '$skill'"; return 1 ;; esac
        [ -f "$SKILLS_ROOT/$skill/SKILL.md" ] || { error "$rel: skills: Skill publicado '$skill' no existe en el inventario OpenCode"; return 1; }
        seen="$seen$skill|"
        adapted="mefisto-$skill"
        [ -z "$output" ] || output="$output,"
        output="$output\"$adapted\""
    done < <(printf '%s' "$skills_json" | jq -r '.[]?')
    printf '[%s]' "$output"
}

skill_preamble() {
    local native_skills="$1" names
    names="$(printf '%s' "$native_skills" | jq -r 'map("`\(.)`") | join(", ")')"
    printf 'Antes de ejecutar este body, usa la tool nativa `skill` para cargar, en este orden: %s. Si una carga es denegada o falla, detén la ejecución.\n' "$names"
}

skill_assets() {
    local source skill_id relative adapted asset_id
    validate_skills || return 1
    while IFS= read -r source; do
        relative="${source#"$SKILLS_ROOT"/}"
        skill_id="${relative%%/*}"
        relative="${relative#*/}"
        adapted="mefisto-$skill_id"
        asset_id="skills/$skill_id/$relative"
        jq -cn --arg id "$asset_id" --arg source "skills/$skill_id/$relative" --arg destination "skills/$adapted/$relative" --arg mode 0644 '{id: $id, source: $source, destination: $destination, mode: $mode}'
    done < <(find "$SKILLS_ROOT" -type f | LC_ALL=C sort) | jq -s .
}

render_skill_asset() {
    local asset_id="$1" source="$2" skill_id adapted
    case "$asset_id" in skills/*/SKILL.md) ;; *) cat "$source"; return ;; esac
    skill_id="${asset_id#skills/}"; skill_id="${skill_id%%/*}"; adapted="mefisto-$skill_id"
    awk -v name="$adapted" 'NR == 1 { print; next } $0 == "---" && !closed { closed=1; print; next } !closed && $0 ~ /^name:[[:space:]]*/ { print "name: " name; next } { print }' "$source"
}

validate_interactive_hooks() {
    [ -x "$HOOKS_VALIDATOR" ] || { error 'interactive-hooks: falta validador ejecutable'; return 1; }
    "$HOOKS_VALIDATOR" "$HOOKS_CONTRACT" || return 1
    jq -e '[.bindings[] | {id,signal,action,destinations,persistedFields,delivery}] | length == 7 and ([.[].id] | sort) == ["append-dotnet-test-result","append-file-change","append-session","append-session-model","append-terraform-result","record-active-release","remind-field-notes"] and all(.[]; .delivery == {mode:"sync",failure:"continue",timeoutSeconds:null})' "$HOOKS_CONTRACT" >/dev/null || { error 'interactive-hooks: bindings o delivery no representables'; return 1; }
}

render_observability_plugin() {
    validate_interactive_hooks || return 1
    cat <<'EOF'
// GENERADO por src/published/scripts/adapters/adapter-opencode.sh desde src/published/hooks/interactive-hooks.json. No editar a mano.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootOf = (context) => {
  const candidate = [context?.worktree, context?.directory].find((value) => typeof value === "string" && value.length > 0);
  return candidate && path.isAbsolute(candidate) ? candidate : null;
};
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const clock = () => new Date().toISOString().slice(11, 19);
const pipeline = (root) => root && path.join(root, ".mefisto", "pipeline");
const diagnostic = async (client, message) => { try { await client?.app?.log?.({ body: { service: "mefisto", level: "warn", message } }); } catch { /* failure: continue */ } };
const safe = async (client, failure, work) => { try { await work(); } catch { await diagnostic(client, failure); } };
const releaseRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const identity = async (client) => {
  try {
    const manifest = JSON.parse(await readFile(path.join(releaseRoot, "mefisto-manifest.json"), "utf8"));
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    if (manifest?.schemaVersion === 1 && manifest.runtime === "opencode" && semver.test(manifest.version) && /^[0-9a-f]{40}$/.test(manifest.commit)) return manifest;
  } catch { /* diagnosticado abajo */ }
  await diagnostic(client, "Mefisto: manifiesto de release ausente o malformado.");
  return { version: null, commit: null };
};
const append = async (root, file, line) => { const state = pipeline(root); if (!state) return; await mkdir(state, { recursive: true }); await appendFile(path.join(state, file), `${JSON.stringify(line)}\n`, "utf8"); };
const sessionID = (input) => input?.sessionID ?? input?.properties?.info?.id;
const toolName = (input) => String(input?.tool ?? input?.toolName ?? "").toLowerCase();
const args = (input) => input?.args && typeof input.args === "object" ? input.args : {};
const successful = (output) => Number.isInteger(output?.metadata?.exitCode) && output.metadata.exitCode === 0;
const modelComponent = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\/\u0000-\u001f\u007f]/.test(value);

export default async function mefistoObservability(context) {
  const root = rootOf(context);
  const release = await identity(context.client);
  const observations = new Set();
  const changed = new Set();
  const reminded = new Set();
  const reminder = "[recordatorio] Si esta sesion tuvo descubrimientos de dominio, decisiones o alternativas descartadas, considera escribir field notes en docs/bitacora/field-notes/ antes de continuar.";
  return {
    event: async ({ event } = {}) => safe(context.client, "Mefisto: no se pudo registrar el inicio de sesion.", async () => {
      if (event?.type === "session.idle") {
        const idle = sessionID(event) ?? event?.properties?.sessionID;
        if (typeof idle === "string" && changed.has(idle) && !reminded.has(idle)) {
          reminded.add(idle);
          try { await context.client?.app?.log?.({ body: { service: "mefisto", level: "info", message: reminder } }); } catch { /* failure: continue */ }
        }
        return;
      }
      if (event?.type !== "session.created") return;
      const id = sessionID(event);
      if (typeof id !== "string" || id.length === 0 || !root) { await diagnostic(context.client, "Mefisto: payload de session.created no representable."); return; }
      const state = pipeline(root); await mkdir(state, { recursive: true });
      await writeFile(path.join(state, ".plugin-root"), releaseRoot, "utf8");
      await append(root, "sessions.jsonl", { record_type: "session.started", session_id: id, transcript_path: null, cwd: root, source: null, timestamp: now(), runtime: "opencode", model: null, harness_version: release.version, harness_commit: release.commit });
    }),
    "chat.params": async (input) => safe(context.client, "Mefisto: no se pudo registrar la observacion de modelo.", async () => {
      const id = sessionID(input); const model = input?.model;
      if (!root || typeof id !== "string" || id.length === 0 || !modelComponent(model?.providerID) || !modelComponent(model?.id)) { await diagnostic(context.client, "Mefisto: payload de chat.params no representable."); return; }
      const value = `${model.providerID}/${model.id}`; const key = JSON.stringify([id, value]);
      if (observations.has(key)) return;
      observations.add(key);
      try {
        const text = await readFile(path.join(pipeline(root), "sessions.jsonl"), "utf8").catch((error) => { if (error?.code === "ENOENT") return ""; throw error; });
        const exists = text.split("\n").some((line) => { try { const item = JSON.parse(line); return item.record_type === "session.model-observed" && item.session_id === id && item.model === value; } catch { return false; } });
        if (!exists) await append(root, "sessions.jsonl", { record_type: "session.model-observed", session_id: id, timestamp: now(), runtime: "opencode", model: value, harness_version: release.version, harness_commit: release.commit });
      } catch (error) { observations.delete(key); throw error; }
    }),
    "tool.execute.after": async (input, output) => safe(context.client, "Mefisto: no se pudo registrar el resumen de herramienta.", async () => {
      if (!root) return; const tool = toolName(input); const inputArgs = args(input);
      if (["write", "edit", "patch"].includes(tool)) { if (typeof input?.sessionID === "string" && input.sessionID.length > 0) changed.add(input.sessionID); const candidate = inputArgs.filePath ?? inputArgs.file_path ?? inputArgs.path; const file = typeof candidate === "string" && candidate.length > 0 ? candidate : "(desconocido)"; await append(root, "events.log", { time: clock(), family: "archivo", file_path: file }); return; }
      if (!["bash", "shell"].includes(tool)) return;
      const command = typeof inputArgs.command === "string" ? inputArgs.command : "";
      if (/^\s*dotnet\s+test(?:\s|$)/.test(command)) { await append(root, "events.log", { time: clock(), family: "test", result: successful(output) ? "PASS" : "FAIL" }); return; }
      const match = /^\s*terraform\s+(plan|apply|init|validate)(?:\s|$)/.exec(command);
      if (match) await append(root, "events.log", { time: clock(), family: "terraform", terraform_subcommand: match[1], result: successful(output) ? "OK" : "ERROR" });
    }),
  };
}
EOF
}

validate_published_mcp() {
    local registry="${1:-$MCP_REGISTRY}"
    [ -x "$MCP_VALIDATOR" ] || { error 'mcp: falta validador publicado ejecutable'; return 1; }
    "$MCP_VALIDATOR" --registry "$registry" || return 1
}

render_mcp_plugin() {
    local source="$1" bundled
    validate_published_mcp "$source" || return 1
    bundled="$(jq -c '[.servers[] | select(.provisioning == "bundled") | {key: .id, value: {type: "remote", url: .url, enabled: true, oauth: false}}] | from_entries' "$source")" || return 1
    cat <<EOF
// GENERADO por src/published/scripts/adapters/adapter-opencode.sh desde src/published/contract/mcp-servers.json. No editar a mano.
const bundled = $bundled;
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const identical = (actual, expected) => actual && typeof actual === "object" && !Array.isArray(actual) &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.keys(expected).every((key) => actual[key] === expected[key]);
const log = async (client, event, server) => {
  try { await client?.app?.log?.({ body: { service: "mefisto", level: "warn", message: event, extra: { event, server } } }); } catch { /* failure: continue */ }
};

export default async function mefistoMcp({ client } = {}) {
  return {
    config: async (config) => {
      try {
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid_config");
        if (config.mcp === undefined) config.mcp = {};
        if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) throw new Error("invalid_mcp");
        for (const [server, expected] of Object.entries(bundled)) {
          if (!owns(config.mcp, server)) { config.mcp[server] = { ...expected }; continue; }
          if (!identical(config.mcp[server], expected)) await log(client, "mcp_config_conflict", server);
        }
      } catch { await log(client, "mcp_config_hook_failed", "microsoft-learn"); }
    },
  };
}
EOF
}
published_opencode_effort() {
    case "$1" in
        quick) printf '%s' "low" ;;
        light) printf '%s' "medium" ;;
        standard) printf '%s' "high" ;;
        thorough) printf '%s' "xhigh" ;;
        exhaustive) printf '%s' "max" ;;
        *) return 1 ;;
    esac
}

render_efforts_plugin() {
    local agents natives level native
    agents="$(
        for file in "$REPO_ROOT"/src/published/agents/*.md; do
            frontmatter "$file" | jq -c '{id, profile, effort}' || exit 1
        done | jq -s -c 'sort_by(.id)'
    )" || return 1
    natives='{}'
    for level in quick light standard thorough exhaustive; do
        native="$(published_opencode_effort "$level")" || return 1
        natives="$(jq -c --arg level "$level" --arg native "$native" '. + {($level): $native}' <<< "$natives")" || return 1
    done
    cat <<EOF
// GENERADO por src/published/scripts/adapters/adapter-opencode.sh desde src/published/agents/*.md. No editar a mano.
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

export default async function mefistoEfforts({ client, worktree, directory } = {}) {
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
render() {
    local source="$1" marker="$2" rel fm instance kind raw_body translated preamble='' mode permissions tools agent native_skills='[]'
    local description_json capabilities_json mcp_json skills_json
    rel="${source#*/src/published/}"
    rel="src/published/$rel"
    fm="$(frontmatter "$source")" || { error "$rel: frontmatter: no se pudo extraer"; return 1; }
    instance="$(printf '%s\n' "$fm" | jq -c '.')" || { error "$rel: frontmatter: no es JSON valido"; return 1; }
    # Una sola pasada jq deriva todos los campos escalares/array del
    # frontmatter (evita releer "$instance" con un jq por campo).
    IFS=$'\x1f' read -r kind description_json mode agent capabilities_json mcp_json skills_json <<< "$(
        printf '%s' "$instance" | jq -r '
          [ .kind,
            (.description | @json),
            (.mode // ""),
            (.agent // ""),
            (.capabilities // [] | tostring),
            (.mcp // [] | tostring),
            (.skills // [] | tostring)
          ] | join("\u001f")
        '
    )"
    raw_body="$(body "$source")" || { error "$rel: body: no se pudo extraer"; return 1; }
    native_skills="$(native_skills "$rel" "$skills_json")" || return 1
    if [ "$native_skills" != '[]' ]; then
        preamble="$(skill_preamble "$native_skills")"
    fi
    translated="$(published_opencode_translate_body "$rel" "$raw_body")" || return 1
    if needs_package_root "$raw_body"; then
        [ -z "$preamble" ] || preamble="$preamble"$'\n'
        preamble="$preamble$(package_root_preamble)"
    fi
    local needs_config=0 needs_instructions=0
    published_effective_contract_needs_config "$raw_body" && needs_config=1
    published_effective_contract_needs_instructions "$raw_body" && needs_instructions=1
    if [ "$needs_config" -eq 1 ] || [ "$needs_instructions" -eq 1 ]; then
        [ -z "$preamble" ] || preamble="$preamble"$'\n'
        preamble="$preamble$(published_effective_contract_preamble "$needs_config" "$needs_instructions")"
    fi
    printf '%s\n' '---'
    printf 'description: %s\n' "$description_json"
    if [ "$kind" = agent ]; then
        case "$native_skills" in
            '[]') ;;
            *) case "$capabilities_json" in
                   *'"skill"'*) ;;
                   *) error "$rel: skills: requiere la capacidad 'skill' para un agente OpenCode"; return 1 ;;
               esac ;;
        esac
        permissions="$(permission_json "$rel" "$capabilities_json" "$mode" "$native_skills")" || return 1
        tools="$(mcp_tools_json "$rel" "$mcp_json")" || return 1
        printf 'mode: %s\npermission: %s\ntools: %s\n' "$(printf '%s' "$mode" | jq -Rr '@json')" "$permissions" "$tools"
    else
        [ -z "$agent" ] || printf 'agent: %s\nsubtask: true\n' "$(printf '%s' "$agent" | jq -Rr '@json')"
    fi
    printf '%s\n%s\n' '---' "$marker"
    [ -z "$preamble" ] || printf '%s\n' "$preamble"
    printf '%s\n' "$translated"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    case "${1:-}" in
        root) printf '%s\n' 'dist/opencode' ;;
        path)
            case "${2:-}" in src/published/agents/*.md) printf 'agents/%s\n' "$(basename "$2")" ;; src/published/commands/*.md) printf 'commands/mefisto:%s\n' "$(basename "$2")" ;; *) error "$2: path: fuente publicada desconocida" ;; esac ;;
        render) [ "$#" -eq 3 ] || error 'render: se esperaban fuente y marcador'; render "$2" "$3" ;;
        assets) validate_interactive_hooks && validate_published_mcp && { skill_assets | jq '. + [{id:"interactive-observability",source:"src/published/hooks/interactive-hooks.json",destination:"plugins/mefisto-observability.js",mode:"0644"},{id:"mcp-config",source:"src/published/contract/mcp-servers.json",destination:"plugins/mefisto-mcp.js",mode:"0644"},{id:"efforts-config",source:"src/published/contract/published-artifact.schema.json",destination:"plugins/mefisto-efforts.js",mode:"0644"}]'; } ;;
        render-asset)
            [ "$#" -eq 3 ] || error 'render-asset: se esperaban id y fuente'
            case "$2" in interactive-observability) render_observability_plugin ;; mcp-config) render_mcp_plugin "$3" ;; efforts-config) render_efforts_plugin ;; *) render_skill_asset "$2" "$3" ;; esac ;;
        *) error 'uso: adapter-opencode.sh root|path|render|assets|render-asset' ;;
    esac
fi
