#!/usr/bin/env bash
# validate-internal-artifacts.sh -- Valida agentes/comandos de
# src/internal/{agents,commands}/*.md contra el contrato neutral (MEF-ADR-0049
# CA-6, issue #853).
#
# Extrae el bloque JSON de frontmatter de cada archivo, lo parsea con jq y lo
# valida contra internal-artifact.schema.json mediante el subconjunto de JSON
# Schema que implementa lib/jsonschema-lite.jq. El schema es la unica
# declaracion de campos: este script no duplica la lista de campos validos,
# solo orquesta la extraccion y los tres chequeos que el schema no puede
# expresar porque no dependen solo del frontmatter:
#   - frontmatter ausente, sin cierre o no-JSON (estructura del archivo);
#   - `id` comparado contra el nombre del archivo;
#   - neutralidad del body (CA-1: no nombra un runtime concreto).
#
# Uso: validate-internal-artifacts.sh [archivo...]
#   Sin argumentos: valida todo src/internal/{agents,commands}/*.md (orden
#   determinista, LC_ALL=C).
# Exit code: 0 si todos los archivos son validos, 1 si alguno se rechaza.
# Cada rechazo imprime una linea "<archivo>: <campo>: <motivo>".

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/src/internal/contract"
SCHEMA_FILE="$CONTRACT_DIR/internal-artifact.schema.json"
JSONSCHEMA_LITE="$SCRIPT_DIR/lib/jsonschema-lite.jq"
FRONTMATTER_LIB="$SCRIPT_DIR/lib/frontmatter.sh"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq no esta instalado (MEF-ADR-0049 CA-6: bash + jq, sin validador externo)" >&2
    exit 1
fi

for required in "$SCHEMA_FILE" "$JSONSCHEMA_LITE" "$FRONTMATTER_LIB"; do
    if [ ! -f "$required" ]; then
        echo "ERROR: no existe '$required'" >&2
        exit 1
    fi
done

# La regla de corte del bloque '---' vive en lib/frontmatter.sh y se consume
# por `source` desde aqui y desde generate-internal-adapters.sh (#854): una
# sola implementacion, porque una copia por consumidor es exactamente la
# divergencia que la fuente neutral existe para evitar (ver README.md, "Regla
# de extraccion del frontmatter").
source "$FRONTMATTER_LIB"

# body_runtime_references <archivo> -- imprime el numero de linea (relativo al
# archivo) de cada linea del body que nombra un runtime concreto. CA-1: la
# fuente neutral describe intenciones, nunca `claude` ni sus
# directorios; esas referencias las introduce el generador (#854) o el
# adaptador. Sin este chequeo, la mitad de CA-1 quedaria documentada pero no
# verificada, justo cuando #865-#867 migraron los artefactos reales.
#
# Dos excepciones literales (issue #866, CA-2/CA-3): `.claude-plugin/` es el
# manifiesto fisico del Claude Code Plugin, identico e indispensable en
# cualquier runtime -- no un nombre de runtime, y el "guard inverso" que abre
# todo comando lo cita tal cual. `.claude/scripts/` es la superficie estable
# de invocacion de los pipelines internos (ver README.md, "Directivas de
# body"): el propio adaptador emite ese mismo prefijo,
# asi que citarlo en prosa no filtra ninguna decision especifica de runtime.
# Ninguna otra forma de "claude" (bare, la ruta de estado legacy
# previa a la migracion, `.claude/agents`, `.claude/commands`, etc.) entra en
# esta excepcion.
body_runtime_references() {
    awk '
        NR==1 && $0 != "---" { exit }
        NR>1 && $0 == "---" && !seen { seen=1; next }
        seen {
            line = $0
            gsub(/\.claude-plugin/, "", line)
            gsub(/\.claude\/scripts/, "", line)
            if (tolower(line) ~ /claude/) print NR
        }
    ' "$1"
}

# validate_file <archivo> -- imprime rechazos a stdout, retorna 1 si hubo
# alguno, 0 si el archivo es valido.
validate_file() {
    local file="$1"
    local rel="${file#"$REPO_ROOT"/}"

    if [ ! -f "$file" ]; then
        echo "$rel: archivo: no existe o no es un archivo regular"
        return 1
    fi

    local basename_no_ext
    basename_no_ext="$(basename "$file" .md)"

    local frontmatter extract_rc
    frontmatter="$(extract_frontmatter "$file")"
    extract_rc=$?
    case "$extract_rc" in
        1)
            echo "$rel: frontmatter: ausente (se esperaba un bloque '---' JSON al inicio del archivo)"
            return 1
            ;;
        2)
            echo "$rel: frontmatter: sin delimitador de cierre (falta una linea '---' tras el objeto JSON)"
            return 1
            ;;
    esac
    if [ -z "$frontmatter" ]; then
        echo "$rel: frontmatter: bloque vacio (se esperaba un objeto JSON)"
        return 1
    fi

    local instance_json
    if ! instance_json="$(printf '%s\n' "$frontmatter" | jq -c '.' 2>/dev/null)"; then
        echo "$rel: frontmatter: no es JSON valido"
        return 1
    fi

    local status=0

    # El schema corre primero y es quien juzga los campos: si `id` falta, no es
    # un string o la instancia ni siquiera es un objeto, el motivo que se
    # imprime es el del schema, no un "id ausente" generico que ocultaria la
    # causa real.
    local schema_json errors
    schema_json="$(cat "$SCHEMA_FILE")"
    if ! errors="$(jq -n --argjson schema "$schema_json" --argjson instance "$instance_json" -f "$JSONSCHEMA_LITE" 2>&1)"; then
        echo "$rel: schema: el validador jq fallo: $errors"
        return 1
    fi
    if [ -n "$errors" ] && [ "$(printf '%s' "$errors" | jq 'length')" -gt 0 ]; then
        printf '%s' "$errors" | jq -r --arg rel "$rel" '.[] | "\($rel): \(.)"'
        status=1
    fi

    # Chequeo que el schema no puede expresar: el `id` depende del nombre del
    # archivo, que no viaja en la instancia.
    local id
    id="$(printf '%s' "$instance_json" | jq -r 'if (.id? | type) == "string" then .id else empty end')"
    if [ -n "$id" ] && [ "$id" != "$basename_no_ext" ]; then
        echo "$rel: id: '$id' distinto del nombre de archivo '$basename_no_ext'"
        status=1
    fi

    local line
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        echo "$rel: body: linea $line nombra un runtime concreto; la fuente neutral es agnostica (CA-1)"
        status=1
    done < <(body_runtime_references "$file")

    return $status
}

# validate_skill <archivo> -- valida el frontmatter YAML portable de un
# src/internal/skills/<id>/SKILL.md (issue #1685, MEF-ADR-0033): `name` igual
# al directorio, `description` presente, sin `allowed-tools`. Es un chequeo
# textual sobre las claves de primer nivel; el body de un Skill no pasa por la
# regla de neutralidad de agentes/comandos (documenta los adaptadores).
validate_skill() {
    local file="$1"
    local rel="${file#"$REPO_ROOT"/}"
    local dir_id
    dir_id="$(basename "$(dirname "$file")")"

    if [ ! -f "$file" ]; then
        echo "$rel: archivo: no existe o no es un archivo regular"
        return 1
    fi

    local frontmatter extract_rc
    frontmatter="$(extract_frontmatter "$file")"
    extract_rc=$?
    case "$extract_rc" in
        1) echo "$rel: frontmatter: ausente (se esperaba un bloque '---' al inicio del archivo)"; return 1 ;;
        2) echo "$rel: frontmatter: sin delimitador de cierre"; return 1 ;;
    esac

    local status=0 name_line
    name_line="$(printf '%s\n' "$frontmatter" | grep -E '^name:' | head -n1)"
    local name_val
    name_val="$(printf '%s' "${name_line#name:}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/')"
    if [ -z "$name_val" ]; then
        echo "$rel: name: ausente"
        status=1
    elif [ "$name_val" != "$dir_id" ]; then
        echo "$rel: name: '$name_val' distinto del directorio '$dir_id'"
        status=1
    fi
    if ! printf '%s\n' "$frontmatter" | grep -qE '^description:[[:space:]]*[^[:space:]]'; then
        echo "$rel: description: ausente o vacia"
        status=1
    fi
    if printf '%s\n' "$frontmatter" | grep -qE '^allowed-tools[[:space:]]*:'; then
        echo "$rel: allowed-tools: prohibido en un SKILL.md portable (MEF-ADR-0033)"
        status=1
    fi
    return $status
}

FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
    FILES=()
    while IFS= read -r f; do
        [ -n "$f" ] && FILES+=("$f")
    done < <(find "$REPO_ROOT/src/internal/agents" "$REPO_ROOT/src/internal/commands" -name '*.md' 2>/dev/null | sort)
    while IFS= read -r f; do
        [ -n "$f" ] && FILES+=("$f")
    done < <(find "$REPO_ROOT/src/internal/skills" -name 'SKILL.md' 2>/dev/null | sort)
fi

STATUS=0
if [ ${#FILES[@]} -gt 0 ]; then
    for f in "${FILES[@]}"; do
        case "$f" in
            */skills/*/SKILL.md)
                validate_skill "$f" || STATUS=1
                ;;
            */skills/*/*)
                : # recurso de Nivel 3: no lleva frontmatter propio
                ;;
            *)
                validate_file "$f" || STATUS=1
                ;;
        esac
    done
fi

exit $STATUS
