#!/usr/bin/env bash
# Valida fuentes neutrales publicadas; no consulta ni importa politicas internas.
# Uso: validate-published-artifacts.sh [archivo...]
# Cada rechazo de artefacto imprime "<archivo>: <campo|body>: <motivo>".
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/src/published/contract"
SCHEMA_FILE="$CONTRACT_DIR/published-artifact.schema.json"
JSONSCHEMA_LITE="$SCRIPT_DIR/lib/jsonschema-lite.jq"

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq no esta instalado" >&2; exit 1; }
for required in "$SCHEMA_FILE" "$JSONSCHEMA_LITE"; do [ -f "$required" ] || { echo "ERROR: no existe '$required'" >&2; exit 1; }; done

extract_frontmatter() {
    awk '
        NR == 1 {
            if ($0 != "---") { invalid_start=1; next }
            opened=1
            next
        }
        invalid_start { next }
        opened && $0 == "---" { closed=1; exit }
        opened { print }
        END {
            if (invalid_start) exit 1
            if (!closed) exit 2
        }
    ' "$1"
}
body_lines() { awk 'NR==1 { next } $0 == "---" && !seen { seen=1; next } seen { print NR ":" $0 }' "$1"; }

validate_file() {
    local file="$1" rel="${1#"$REPO_ROOT"/}" basename_no_ext frontmatter rc instance_json schema_json errors status=0 id skill skill_file declared_skills available_skills available_commands command_file artifact_kind body_validation has_guard=0 agent agent_file command_mcp agent_mcp
    [ -f "$file" ] || { echo "$rel: archivo: no existe o no es un archivo regular"; return 1; }
    basename_no_ext="$(basename "$file" .md)"
    frontmatter="$(extract_frontmatter "$file")"; rc=$?
    [ "$rc" -eq 0 ] || { [ "$rc" -eq 1 ] && echo "$rel: frontmatter: ausente (se esperaba un bloque '---' JSON al inicio del archivo)" || echo "$rel: frontmatter: sin delimitador de cierre"; return 1; }
    [ -n "$frontmatter" ] || { echo "$rel: frontmatter: bloque vacio (se esperaba un objeto JSON)"; return 1; }
    instance_json="$(printf '%s\n' "$frontmatter" | jq -c '.' 2>/dev/null)" || { echo "$rel: frontmatter: no es JSON valido"; return 1; }
    schema_json="$(cat "$SCHEMA_FILE")"
    errors="$(jq -n --argjson schema "$schema_json" --argjson instance "$instance_json" -f "$JSONSCHEMA_LITE" 2>&1)" || { echo "$rel: schema: el validador jq fallo: $errors"; return 1; }
    if [ "$(printf '%s' "$errors" | jq 'length')" -gt 0 ]; then printf '%s' "$errors" | jq -r --arg rel "$rel" '.[] | "\($rel): \(.)"'; status=1; fi
    id="$(printf '%s' "$instance_json" | jq -r 'if (.id? | type) == "string" then .id else empty end')"
    [ -z "$id" ] || [ "$id" = "$basename_no_ext" ] || { echo "$rel: id: '$id' distinto del nombre de archivo '$basename_no_ext'"; status=1; }
    if [ "$(printf '%s' "$instance_json" | jq '[.mcp[]?] | length')" -ne "$(printf '%s' "$instance_json" | jq '[.mcp[]?] | unique | length')" ]; then
        echo "$rel: mcp: referencias MCP duplicadas"
        status=1
    fi
    while IFS= read -r skill; do
        [ -z "$skill" ] || [ -f "$REPO_ROOT/skills/$skill/SKILL.md" ] || { echo "$rel: skills: '$skill' no resuelve a un Skill publicado real"; status=1; }
    done <<EOF
$(printf '%s' "$instance_json" | jq -r '.skills[]?')
EOF
    declared_skills="|$(printf '%s' "$instance_json" | jq -r '.skills[]?' | tr '\n' '|')"
    available_skills='|'
    for skill_file in "$REPO_ROOT"/skills/*/SKILL.md; do
        [ -f "$skill_file" ] || continue
        available_skills="${available_skills}$(basename "$(dirname "$skill_file")")|"
    done
    # Una sola pasada interpreta todas las reglas del cuerpo. Las excepciones se
    # seleccionan por artefacto, no por línea, para evitar procesos por hallazgo.
    artifact_kind="$(printf '%s' "$instance_json" | jq -r '.kind // empty')"
    available_commands='|'
    for command_file in "$REPO_ROOT"/src/published/commands/*.md; do
        [ -f "$command_file" ] || continue
        command_file="${command_file##*/}"; available_commands="${available_commands}${command_file%.md}|"
    done
    body_validation="$(awk -v id="$id" -v kind="$artifact_kind" -v rel="$rel" -v declared_skills="$declared_skills" -v available_skills="$available_skills" -v available_commands="$available_commands" '
        function allowed_placeholder(value) {
            if (value == "$ARGUMENTS") return 1
            if (id == "domain-scaffolder" && value ~ /^\$(1|2|3|AJENOS|CSPROJ|ESPERA|EVENTO|RUN_CONCLUSION|RUN_EVENTO|RUN_RAMA|RUN_REPO|GITHUB_OUTPUT|INTENTOS|INTRUSOS|JOB_STATUS|PENDIENTES|PR_NUM|REPO|REPO_ROOT|RUN|RUN_ID|SECONDS|SHA|TIMEOUT|archivo|destino|f|i|paquete|presupuesto|proj|temporal|version_esperada)$/) return 1
            if (id == "domain-scaffolder" && (value == "${PR_NUM}" || value == "${REPO}" || value == "${RUN_SHA}" || value == "${TIMEOUT}" || value == "${archivo}")) return 1
            if (id == "projection-test-writer" && (value == "$PLUGIN_ROOT" || value == "$HOME" || value == "$2")) return 1
            if (id == "reviewer" && (value == "$PLUGIN_ROOT" || value == "$HOME")) return 1
            if (id == "runtimes" && (value == "$MEFISTO_LIFECYCLE_LAUNCHER" || value == "$MEFISTO_LIFECYCLE_CONFIG_ROOT")) return 1
            if (id == "batch-stop" && value == "$REPO_ROOT") return 1
            if (id == "scaffold-mcp" && value ~ /^\$(\{)?(ROOT_NAMESPACE|SOLUTION_FILE|VERSION|PROPOSITO_PASCAL)(\})?$/) return 1
            if (id == "draft" && value == "$REPO_SLUG") return 1
            if (id == "eraser-diagram" && value == "${ERASER_API_TOKEN}") return 1
            if (id == "purge-store" && value ~ /^\$(0|ATTEMPT_AHORA|ATTEMPT_PREVIO|CONFIG|DOMAIN_EVENTS_DIR|DOMINIO|DOMINIO_FLAT|DOMINIO_KEBAB|ENV|ESTADO|RUN_ID|flat|i)$/) return 1
            if (id == "purge-store" && value == "${DOMINIO_KEBAB}") return 1
            if (id == "planner" && value ~ /^\$(SESSION_ID|INITIAL_HEAD_SHA|INITIAL_DEFAULT_BRANCH|INITIAL_STATUS|HARNESS_REPO_SLUG|CLOSING_TIMESTAMP|GLOSSARY_PATH|FIELD_NOTE_LOCAL|GLOSSARY_LOCAL|FIELD_NOTE_GLOSSARY_ARGS)$/) return 1
            if (id == "planner" && value == "${SESSION_ID}") return 1
            if ((id == "domain-scaffolder" || id == "mcp-scaffolder" || id == "projections-scaffolder" || id == "apim-gateway-scaffolder" || id == "workos-identity-scaffolder" || id == "infra-base-scaffolder") && value ~ /^\$(SCAFFOLD_BASE|HARNESS_REPO_SLUG|HARNESS_VERSION)$/) return 1
            if (id == "tooling-investigator" && (value == "$CONFIG" || value == "$HARNESS_REPO_SLUG")) return 1
            if (id == "projections-scaffolder" && value ~ /^\$(BASE|CSPROJ|ESPERADA|GITHUB_OUTPUT|IMAGEN|IMAGEN_ACTIVA|INTRUSOS|LISTA|LOGIN_SERVER|PLACEHOLDER|PROJ|PROVISION|REPO_ROOT|RUNNING|SEAM|SOURCE_REVISION_ID|ULTIMA|destino|domainEventsCsproj|dominio|i|nombre|seam)$/) return 1
            if (id == "infra-base-scaffolder" && value ~ /^\$(1|2|3|ALL_SECRETS|APPS|APP_NAME|BRANCH|CONFIG|COUNT|ERR|GITHUB_STEP_SUMMARY|NUGET_AUDIT_GREENFIELD|OUT|ROWS|RUNNER_TEMP|SOLUTION|GITHUB_WORKSPACE|ISSUE_NUM|KEY_VAULT_NAME|NAME|NS|PROJECTIONS_ENABLED|PROVIDERS_TF|PR_NUM|RESOURCE_GROUP|TYPE|VALUE|VALUE_REF|attempt|delay|f|i|id|k|max_attempts|name|p|severity|url|value|version)$/) return 1
            if (id == "infra-base-scaffolder" && value ~ /^\$\{(APP_ID|PR_NUM|TF_VAR_postgresql_admin_password|delay|environment|project_short|topic_name)\}$/) return 1
            if (id == "workos-identity-scaffolder" && value ~ /^\$(COMPOSICION|CSPROJ|IDENTITY_DIR|PROGRAM_CS|PROYECTO)$/) return 1
            if (id == "apim-gateway-scaffolder" && value ~ /^\$(MCP_TF|PROVIDERS_TF|WORKFLOW)$/) return 1
            if (id == "mcp-scaffolder" && value ~ /^\$(APP_NAME|BASE|CONFIG|EVENTO|FA_MODULE|FIXTURES|GITHUB_ENV|GITHUB_OUTPUT|PRIMER_DOMINIO_KEBAB|PROJ|PR_NUM|REPO_ROOT|REPO|RESOURCE_GROUP|RUN_CONCLUSION|RUN_EVENTO|RUN_RAMA|RUN_REPO|SECONDS|TENANCY_STRATEGY|VARS|WORKFLOW|azure_region_short|body|code|dominio_kebab|dominio_pascal|dominio_snake|espera|expected_sha|i|key|mcp_id|nombre|presupuesto|proj|proposito_kebab|tiene_region_seq|timeout_peticion|ultimo_cuerpo)$/) return 1
            if (id == "mcp-scaffolder" && value ~ /^\$\{(APP_NAME|PR_NUM|REPO|RUN_SHA|app_name|azure_region_short|body|code|dominio_kebab|espera|expected_sha|intentos|i|project|proposito_kebab|region_seq_suffix|resource_sequence|startup_logs_url|transcurrido|ultimo_cuerpo)\}$/) return 1
            if (id == "historiador" && value ~ /^\$(0|BRANCH|DIAS_PENDIENTES|FECHA|HISTORIAL|HISTORIAL_CANONICO|f)$/) return 1
            if (id == "historiador" && (value == "${FECHA}" || value == "${FECHA_MAS_RECIENTE}")) return 1
            if (id == "install-apim" && value ~ /^\$(COMMON|CONFIG|CORS_JSON|ESTRATEGIA|HARNESS_CONFIG_PATH|REPO_ROOT|ROOT_NAMESPACE|TENANCY_TOKEN_FLIPPED|TMP|s)$/) return 1
            if (id == "install-apim" && (value == "${ENV}" || value == "${ROOT_NAMESPACE}")) return 1
            if (id == "onboard" && value ~ /^\$(COMMON|CONFIG|ESTRATEGIA|HARNESS_CONFIG_PATH|REPO_ROOT|TMP|s)$/) return 1
            if (id == "install-auth" && (value == "${ENV}" || value == "${#CORS_ORIGINS[@]}" || value == "$?")) return 1
            if (id == "install-auth" && value ~ /^\$(GH_VAR_RC|GH_SECRET_RC|WORKOS_CLIENT_ID|WORKOS_API_KEY_PRESENTE)$/) return 1
            if (id == "apim-gateway-scaffolder" && (value == "${ENV}" || value == "${origin}")) return 1
            return 0
        }
        function valid_directive(value) {
            return value ~ /^\{\{mefisto:command [a-z0-9]+(-[a-z0-9]+)*\}\}$/ || value ~ /^\{\{mefisto:launch-agent [a-z0-9]+(-[a-z0-9]+)*[ ]+[^{} ][^{}]*\}\}$/ || value ~ /^\{\{mefisto:run [a-z0-9][a-z0-9._\/-]* [^{}]+\}\}$/ || value ~ /^\{\{mefisto:state-path [A-Za-z0-9][A-Za-z0-9._\/-]*\}\}$/
        }
        NR == 1 { next }
        $0 == "---" && !body { body=1; next }
        !body { next }
        {
            line=NR; text=$0; lower=tolower(text); runtime_text=lower
            legacy=(id == "test-writer" || id == "reviewer" || id == "projection-test-writer" || id == "projection-implementer" || id == "domain-scaffolder" || id == "projections-scaffolder" || id == "historiador")
            runtime_pattern="claude|opencode|\\.claude|\\.opencode|marketplace|(^|[/[:space:].])cache([/[:space:]]|$)|(^|[^[:alnum:]_-])(model|tools|allowed-tools|permission)[[:space:]]*:"
            if (id == "domain-scaffolder") sub(/azure functions core tools:/, "azure functions core tools", runtime_text)
            if (id == "eraser-diagram") sub(/cache hit/, "hit", lower)
            if (id == "onboard") { gsub(/claude\.md|adaptador claude|usa claude|with-claude-bridge|bajo opencode/, "", lower) }
            if (id == "bug") sub(/`\.claude\/`, /, "", lower)
            if ((id == "runtimes" && lower ~ /\.claude|\.opencode|marketplace|(^|[\/[:space:].])cache([\/[:space:]]|$)|(^|[^[:alnum:]_-])(model|tools|allowed-tools|permission)[[:space:]]*:/) || (legacy && runtime_text ~ /opencode|\.opencode|(^|[^[:alnum:]_-])(model|tools|allowed-tools|permission)[[:space:]]*:/) || (!legacy && id != "runtimes" && lower ~ runtime_pattern)) {
                print rel ": body: linea " line " referencia un runtime, CLI, cache, directorio o metadata propia de runtime"
            }
            rest=text
            while (match(rest, /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!-]/)) {
                placeholder=substr(rest, RSTART, RLENGTH)
                if (!allowed_placeholder(placeholder)) print rel ": body: linea " line " placeholder no permitido: " placeholder " (solo se admite $ARGUMENTS)"
                rest=substr(rest, RSTART + RLENGTH)
            }
            if (index(text, "{{mefisto:") > 0) {
                markers=0; rest=text
                while ((position=index(rest, "{{mefisto:")) > 0) { markers++; rest=substr(rest, position + 10) }
                directives=0; rest=text
                while (match(rest, /\{\{mefisto:[^}]*\}\}/)) {
                    directives++
                    rest=substr(rest, RSTART + RLENGTH)
                }
                if (markers != directives || text ~ /\{\{mefisto:[^{}]*\}\}\}/) print rel ": body: linea " line " directiva mefisto mal formada"
                rest=text
                while (match(rest, /\{\{mefisto:[^}]*\}\}/)) {
                    directive=substr(rest, RSTART, RLENGTH)
                    if (directive == "{{mefisto:assert-consumer-repo}}") guard=1
                    else if (directive == "{{mefisto:package-root}}" || directive == "{{mefisto:config-path}}" || directive == "{{mefisto:instructions-path}}" || directive == "{{mefisto:lifecycle-launcher}}" || directive == "{{mefisto:loaded-root}}") {}
                    else if (directive ~ /^\{\{mefisto:command-doc /) {
                        if (directive !~ /^\{\{mefisto:command-doc [a-z0-9]+(-[a-z0-9]+)*\}\}$/) print rel ": body: linea " line " directiva mefisto mal formada: " directive
                        else {
                            cdoc=directive
                            sub(/^\{\{mefisto:command-doc /, "", cdoc)
                            sub(/\}\}$/, "", cdoc)
                            if (index(available_commands, "|" cdoc "|") == 0) print rel ": body: linea " line " directiva command-doc " cdoc " no resuelve a src/published/commands/" cdoc ".md"
                            if (kind == "command" && cdoc == id) print rel ": body: linea " line " directiva command-doc " cdoc " referencia al propio comando"
                        }
                    }
                    else if (directive ~ /^\{\{mefisto:skill-root /) {
                        if (directive !~ /^\{\{mefisto:skill-root [a-z0-9]+(-[a-z0-9]+)*\}\}$/ || directive ~ /^\{\{mefisto:skill-root mefisto-/) print rel ": body: linea " line " directiva mefisto mal formada: " directive
                        else {
                            skill=directive
                            sub(/^\{\{mefisto:skill-root /, "", skill)
                            sub(/\}\}$/, "", skill)
                            if (index(declared_skills, "|" skill "|") == 0) print rel ": body: linea " line " directiva skill-root " skill " no esta declarada en skills"
                            if (index(available_skills, "|" skill "|") == 0) print rel ": body: linea " line " directiva skill-root " skill " no resuelve a skills/" skill "/SKILL.md"
                        }
                    }
                    else if (directive ~ /^\{\{mefisto:(launch-agent|command|run|state-path) /) {
                        if (!valid_directive(directive) || directive ~ /(^|\/)\.\.([\/[:space:]]|\}\})/ || directive ~ /^\{\{mefisto:(launch-agent|command) mefisto-/) print rel ": body: linea " line " directiva mefisto mal formada: " directive
                    } else print rel ": body: linea " line " directiva mefisto desconocida: " directive
                    rest=substr(rest, RSTART + RLENGTH)
                }
            }
        }
        END { if (guard) print "__MEFISTO_GUARD__" }
    ' "$file")"
    case "$body_validation" in *"$rel: "*) printf '%s\n' "$body_validation" | grep -v '^__MEFISTO_GUARD__$'; status=1 ;; esac
    case "$body_validation" in *'__MEFISTO_GUARD__'*) has_guard=1 ;; esac
    [ "$has_guard" -eq 1 ] || { echo "$rel: body: falta {{mefisto:assert-consumer-repo}}"; status=1; }
    local launch_ids launch_id declared_agent
    launch_ids="$(body_lines "$file" | cut -d: -f2- | grep -Eo '\{\{mefisto:launch-agent [a-z0-9]+(-[a-z0-9]+)*[ ]+[^{} ]' | sed -E 's/^\{\{mefisto:launch-agent ([a-z0-9-]+).*/\1/' | sort -u)"
    declared_agent="$(printf '%s' "$instance_json" | jq -r '.agent // empty')"
    if [ -n "$launch_ids" ]; then
        if [ -n "$declared_agent" ]; then
            echo "$rel: body: un comando con agent no puede usar launch-agent (delegacion completa y puntual son excluyentes)"
            status=1
        fi
        while IFS= read -r launch_id; do
            [ -f "$REPO_ROOT/src/published/agents/$launch_id.md" ] || { echo "$rel: body: launch-agent '$launch_id' no existe en src/published/agents"; status=1; }
        done <<< "$launch_ids"
    fi
    if [[ "$rel" = src/published/commands/*.md ]] && [ "$(printf '%s' "$instance_json" | jq -r '.kind')" = command ] && [ "$(printf '%s' "$instance_json" | jq '[.mcp[]?] | length')" -gt 0 ]; then
        agent="$declared_agent"
        [ -n "$agent" ] || agent="$(printf '%s' "$launch_ids" | paste -sd' ' -)"
        if [ -z "$agent" ]; then
            echo "$rel: mcp: el comando declara MCP pero no delega a un agente neutral"
            status=1
        else
            agent_mcp='[]'; local missing=0 a f one
            for a in $agent; do
                f="$REPO_ROOT/src/published/agents/$a.md"
                if [ ! -f "$f" ]; then
                    echo "$rel: mcp: el agente delegado '$a' no existe en src/published/agents"
                    status=1; missing=1
                else
                    one="$(extract_frontmatter "$f" | jq -c '.mcp // []' 2>/dev/null)" || one='[]'
                    agent_mcp="$(jq -cn --argjson x "$agent_mcp" --argjson y "$one" '$x + $y | unique')"
                fi
            done
            if [ "$missing" -eq 0 ]; then
                command_mcp="$(printf '%s' "$instance_json" | jq -c '.mcp // []')"
                if ! jq -en --argjson command "$command_mcp" --argjson agent "$agent_mcp" '$command - $agent | length == 0' >/dev/null; then
                    echo "$rel: mcp: los agentes delegados '$agent' no declaran todos los ids requeridos por el comando"
                    status=1
                fi
            fi
        fi
    fi
    return "$status"
}

FILES=("$@")
if [ "$#" -eq 0 ]; then FILES=(); while IFS= read -r f; do [ -n "$f" ] && FILES+=("$f"); done < <(find "$REPO_ROOT/src/published/agents" "$REPO_ROOT/src/published/commands" -name '*.md' 2>/dev/null | sort); fi
STATUS=0
for f in ${FILES[@]+"${FILES[@]}"}; do validate_file "$f" || STATUS=1; done
exit "$STATUS"
