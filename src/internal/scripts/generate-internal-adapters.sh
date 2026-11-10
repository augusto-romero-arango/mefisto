#!/usr/bin/env bash
# generate-internal-adapters.sh -- Genera los adaptadores .claude/ y
# .opencode/ a partir de la fuente neutral src/internal/{agents,commands}/*.md
# (MEF-ADR-0049 CA-2/CA-3/CA-6, issue #854). Valida primero con
# validate-internal-artifacts.sh (#853): si algun artefacto de origen falla,
# aborta sin escribir nada (CA-1).
#
# Uso:
#   generate-internal-adapters.sh [--check] [--out <dir>] [archivo...]
#
#   Sin archivos: procesa (valida y genera) todo
#   src/internal/{agents,commands}/*.md, en el mismo orden determinista
#   (LC_ALL=C, `find | sort`) que validate-internal-artifacts.sh usa por
#   defecto.
#   Con archivos: procesa exactamente esos, en el orden recibido -- uso
#   principal: tests (mismo patron de argumentos que
#   validate-internal-artifacts.sh).
#
#   --out <dir>   Raiz alternativa donde leer/escribir los adaptadores
#                 generados (".claude/{agents,commands}" y
#                 ".opencode/{agents,commands}" bajo <dir>) en vez de la raiz
#                 del repo. Uso principal: tests -- nunca escriben en el
#                 .claude/ ni .opencode/ reales del repo.
#   --check       No escribe nada: genera en un directorio temporal y compara
#                 contra lo ya versionado bajo la raiz de salida. Exit 1 y una
#                 linea "<ruta>: faltante|distinta|huerfana|sin marcador" por
#                 divergencia; exit 0 si todo coincide. Todo archivo .md bajo
#                 .claude/{agents,commands} u .opencode/{agents,commands} debe
#                 llevar el marcador de generado -- no queda ningun adaptador
#                 de autoria manual bajo esas rutas (issue #913).
#
# Agent Skills internos (issue #1685, MEF-ADR-0033/0049): la fuente canonica es
# src/internal/skills/<id>/ (SKILL.md con frontmatter YAML portable + recursos
# de Nivel 3). Se genera unicamente .claude/skills/<id>/, con el marcador de
# generado tras el frontmatter de SKILL.md; OpenCode descubre ese mismo
# directorio (verificado, ver src/internal/contract/README.md), asi que NO se
# emite .opencode/skills/: duplicarlo cargaria el Skill dos veces. --check
# aplica las mismas reglas faltante/distinta/huerfana/sin marcador.
#
# Agent Skills publicados proyectados (issue #2529, MEF-ADR-0019/0049): el
# generador proyecta tambien, a .claude/skills/<id>/ y con el mismo tratamiento,
# los Skills publicados de skills/<id>/ cuyo id esta en PUBLISHED_PROJECTED_SKILLS
# (hoy solo `code-comments`): el plugin no se instala sobre si mismo, asi que
# ningun runtime los carga aqui sin esa proyeccion, y la fuente sigue siendo una
# sola. El resto (p. ej. `projections`) no se proyecta. Un id presente a la vez
# en src/internal/skills/ y en esa lista aborta con un error que nombra el id.
#
# Plugin de efforts (issue #2505): ademas se genera
# .opencode/plugins/mefisto-efforts.js, un unico archivo con {id, profile,
# effort} de cada agente fuente y la tabla de nativos por defecto, que aplica
# el effort de fabrica en conversaciones (hook `config`). Solo se emite si hay
# al menos un agente entre las fuentes procesadas. --check lo cubre igual:
# faltante/distinta/huerfana/sin marcador.
#
# Exit code: 0 si genero (o, con --check, verifico) sin divergencias; 1 si la
# validacion previa fallo, si algun archivo tiene una directiva de body
# desconocida o una capacidad sin mapeo Claude, o si --check encontro
# divergencias (incluida la ausencia del marcador de generado).
#
# Determinismo (CA-4): LC_ALL=C, archivos procesados en el orden recibido (o
# el de un `find | sort` determinista si no se pasan explicitos), marcador de
# generado sin timestamp ni hash -- dos corridas consecutivas con la misma
# entrada producen bytes identicos.
#
# Portabilidad (CA-6): bash 3.2 aborta con "unbound variable" al expandir un
# array vacio como "${a[@]}" bajo `set -u` (bash 4.4 lo arreglo, pero macOS
# sigue trayendo 3.2.57 -- MEF-ADR-0049, Consecuencias). Por eso todo recorrido
# de FILES/GENERATED_RELPATHS usa ${a[@]+"${a[@]}"}: la fuente neutral ya esta
# poblada (#865, #866, #867), pero el caso vacio sigue siendo alcanzable -- los tests
# corren el generador contra un --out y un arbol de fuentes propios.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
VALIDATOR="$SCRIPT_DIR/validate-internal-artifacts.sh"
MARKER_SOURCE_SCRIPT="src/internal/scripts/generate-internal-adapters.sh"
PUBLISHED_PROJECTED_SKILLS="code-comments"

for required in "$VALIDATOR" "$LIB_DIR/frontmatter.sh" "$LIB_DIR/adapter-claude.sh" "$LIB_DIR/adapter-opencode.sh"; do
    if [ ! -f "$required" ]; then
        echo "ERROR: no existe '$required'" >&2
        exit 1
    fi
done

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq no esta instalado (MEF-ADR-0049 CA-6: bash + jq, sin generador externo)" >&2
    exit 1
fi

source "$LIB_DIR/frontmatter.sh"
source "$LIB_DIR/adapter-claude.sh"
source "$LIB_DIR/adapter-opencode.sh"

CHECK_MODE=0
OUT_ROOT="$REPO_ROOT"
FILES=()
while [ $# -gt 0 ]; do
    case "$1" in
        --check)
            CHECK_MODE=1
            shift
            ;;
        --out)
            if [ $# -lt 2 ]; then
                echo "ERROR: --out requiere un directorio" >&2
                exit 1
            fi
            OUT_ROOT="$2"
            shift 2
            ;;
        *)
            FILES+=("$1")
            shift
            ;;
    esac
done

# --- CA-1: validar primero, sin escribir nada si falla -----------------------
if [ ${#FILES[@]} -eq 0 ]; then
    VALIDATE_OUT="$("$VALIDATOR" 2>&1)"
    VALIDATE_RC=$?
else
    VALIDATE_OUT="$("$VALIDATOR" "${FILES[@]}" 2>&1)"
    VALIDATE_RC=$?
fi
if [ "$VALIDATE_RC" -ne 0 ]; then
    [ -n "$VALIDATE_OUT" ] && printf '%s\n' "$VALIDATE_OUT" >&2
    echo "ERROR: validacion previa (validate-internal-artifacts.sh) fallo; no se genero nada" >&2
    exit 1
fi

# Sin archivos explicitos: el mismo scan por defecto que el validador.
if [ ${#FILES[@]} -eq 0 ]; then
    while IFS= read -r f; do
        [ -n "$f" ] && FILES+=("$f")
    done < <(find "$REPO_ROOT/src/internal/agents" "$REPO_ROOT/src/internal/commands" -name '*.md' 2>/dev/null | sort)
    while IFS= read -r f; do
        [ -n "$f" ] && FILES+=("$f")
    done < <(find "$REPO_ROOT/src/internal/skills" -type f 2>/dev/null | sort)
    for pub_id in $PUBLISHED_PROJECTED_SKILLS; do
        if [ ! -d "$REPO_ROOT/skills/$pub_id" ]; then
            echo "ERROR: skills/$pub_id/ no existe pero esta en PUBLISHED_PROJECTED_SKILLS" >&2
            exit 1
        fi
        while IFS= read -r f; do
            [ -n "$f" ] && FILES+=("$f")
        done < <(find "$REPO_ROOT/skills/$pub_id" -type f 2>/dev/null | sort)
    done
fi

# CA-5: con --check no se escribe nada, ni siquiera el directorio de salida
# -- si no existe, todas las salidas se reportan como "faltante".
if [ "$CHECK_MODE" -eq 0 ]; then
    mkdir -p "$OUT_ROOT"
fi
if [ -d "$OUT_ROOT" ]; then
    OUT_ROOT="$(cd "$OUT_ROOT" && pwd)"
fi

# --- Generar en un directorio temporal: nunca se escribe directo en destino -
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

GEN_STATUS=0
GENERATED_RELPATHS=()
AGENTS_EFFORT_JSON="[]"
EFFORTS_MARKER_LINE="// GENERADO por $MARKER_SOURCE_SCRIPT desde src/internal/agents/*.md. No editar a mano."

# skill_rel_parts <ruta> -- imprime "<id>/<ruta-relativa-en-el-skill>" si la
# ruta cae bajo src/internal/skills/<id>/ o bajo skills/<id>/ con <id> en
# PUBLISHED_PROJECTED_SKILLS, o nada. Acotado a esas raices para que un `skills/`
# en otra parte de la ruta no desvie un agente o comando.
skill_rel_parts() {
    local pub_id
    case "$1" in
        src/internal/skills/*/*|*/src/internal/skills/*/*) printf '%s' "${1##*src/internal/skills/}"; return ;;
    esac
    for pub_id in $PUBLISHED_PROJECTED_SKILLS; do
        case "$1" in
            skills/"$pub_id"/*|*/skills/"$pub_id"/*) printf '%s/%s' "$pub_id" "${1##*skills/"$pub_id"/}"; return ;;
        esac
    done
}

# skill_is_internal <ruta> -- 0 si la ruta cae bajo src/internal/skills/.
skill_is_internal() {
    case "$1" in
        src/internal/skills/*|*/src/internal/skills/*) return 0 ;;
    esac
    return 1
}

INTERNAL_SKILL_IDS=" "
PUBLISHED_SKILL_IDS=" "

for file in ${FILES[@]+"${FILES[@]}"}; do
    rel_source="${file#"$REPO_ROOT"/}"

    skill_part="$(skill_rel_parts "$file")"
    if [ -n "$skill_part" ]; then
        skill_id="${skill_part%%/*}"
        if skill_is_internal "$file"; then
            INTERNAL_SKILL_IDS="$INTERNAL_SKILL_IDS$skill_id "
        else
            PUBLISHED_SKILL_IDS="$PUBLISHED_SKILL_IDS$skill_id "
        fi
        skill_relpath=".claude/skills/$skill_part"
        mkdir -p "$(dirname "$STAGE_DIR/$skill_relpath")"
        if [ "${skill_part##*/}" = "SKILL.md" ]; then
            skill_fm="$(extract_frontmatter "$file")"
            if [ -z "$skill_fm" ]; then
                echo "ERROR: $rel_source: no se pudo extraer el frontmatter (deberia haber pasado la validacion previa)" >&2
                GEN_STATUS=1
                continue
            fi
            {
                printf '%s\n' "---"
                printf '%s\n' "$skill_fm"
                printf '%s\n' "---"
                printf '%s\n' "<!-- GENERADO por $MARKER_SOURCE_SCRIPT desde $rel_source. No editar a mano. -->"
                printf '%s\n' "$(extract_body "$file")"
            } > "$STAGE_DIR/$skill_relpath"
        else
            cp "$file" "$STAGE_DIR/$skill_relpath"
        fi
        GENERATED_RELPATHS+=("$skill_relpath")
        continue
    fi

    # Skill publicado fuera de la allowlist: no se proyecta.
    case "$file" in
        skills/*/*|*/skills/*/*) continue ;;
    esac

    fm="$(extract_frontmatter "$file")"
    if [ -z "$fm" ]; then
        echo "ERROR: $rel_source: no se pudo extraer el frontmatter (deberia haber pasado la validacion previa)" >&2
        GEN_STATUS=1
        continue
    fi
    instance_json="$(printf '%s\n' "$fm" | jq -c '.' 2>/dev/null)"
    if [ -z "$instance_json" ]; then
        echo "ERROR: $rel_source: frontmatter no es JSON valido (deberia haber pasado la validacion previa)" >&2
        GEN_STATUS=1
        continue
    fi
    body="$(extract_body "$file")"
    id="$(printf '%s' "$instance_json" | jq -r '.id')"
    kind="$(printf '%s' "$instance_json" | jq -r '.kind')"
    marker_line="<!-- GENERADO por $MARKER_SOURCE_SCRIPT desde $rel_source. No editar a mano. -->"

    claude_out="$(claude_render "$rel_source" "$instance_json" "$marker_line" "$body")"
    if [ $? -ne 0 ]; then
        GEN_STATUS=1
        continue
    fi
    opencode_out="$(opencode_render "$rel_source" "$instance_json" "$marker_line" "$body")"
    if [ $? -ne 0 ]; then
        GEN_STATUS=1
        continue
    fi

    claude_relpath=".claude/${kind}s/${id}.md"
    opencode_relpath=".opencode/${kind}s/${id}.md"

    mkdir -p "$(dirname "$STAGE_DIR/$claude_relpath")"
    printf '%s\n' "$claude_out" > "$STAGE_DIR/$claude_relpath"
    GENERATED_RELPATHS+=("$claude_relpath")

    mkdir -p "$(dirname "$STAGE_DIR/$opencode_relpath")"
    printf '%s\n' "$opencode_out" > "$STAGE_DIR/$opencode_relpath"
    GENERATED_RELPATHS+=("$opencode_relpath")

    if [ "$kind" = "agent" ]; then
        AGENTS_EFFORT_JSON="$(printf '%s' "$instance_json" | jq -c --argjson acc "$AGENTS_EFFORT_JSON" '$acc + [{id, profile, effort}]')"
    fi
done

for pub_id in $PUBLISHED_PROJECTED_SKILLS; do
    case "$INTERNAL_SKILL_IDS" in
        *" $pub_id "*)
            case "$PUBLISHED_SKILL_IDS" in
                *" $pub_id "*)
                    echo "ERROR: el id de Skill '$pub_id' existe en src/internal/skills/ y en la lista de Skills publicados proyectados (skills/$pub_id/); renombra uno o quita el duplicado" >&2
                    GEN_STATUS=1
                    ;;
            esac
            ;;
    esac
done

if [ "$GEN_STATUS" -eq 0 ] && [ "$AGENTS_EFFORT_JSON" != "[]" ]; then
    AGENTS_EFFORT_JSON="$(printf '%s' "$AGENTS_EFFORT_JSON" | jq -c 'sort_by(.id)')"
    mkdir -p "$(dirname "$STAGE_DIR/$OPENCODE_EFFORTS_PLUGIN_RELPATH")"
    if effort_plugin_out="$(opencode_render_efforts_plugin "$EFFORTS_MARKER_LINE" "$AGENTS_EFFORT_JSON")"; then
        printf '%s\n' "$effort_plugin_out" > "$STAGE_DIR/$OPENCODE_EFFORTS_PLUGIN_RELPATH"
        GENERATED_RELPATHS+=("$OPENCODE_EFFORTS_PLUGIN_RELPATH")
    else
        echo "ERROR: no se pudo generar $OPENCODE_EFFORTS_PLUGIN_RELPATH" >&2
        GEN_STATUS=1
    fi
fi

if [ "$GEN_STATUS" -ne 0 ]; then
    echo "ERROR: la generacion aborto; no se escribio nada" >&2
    exit 1
fi

# path_in_generated_list <ruta> -- 0 si <ruta> esta entre lo generado en esta
# corrida (relativa a OUT_ROOT, mismo formato que GENERATED_RELPATHS).
path_in_generated_list() {
    local needle="$1" candidate
    for candidate in ${GENERATED_RELPATHS[@]+"${GENERATED_RELPATHS[@]}"}; do
        [ "$candidate" = "$needle" ] && return 0
    done
    return 1
}

if [ "$CHECK_MODE" -eq 1 ]; then
    DIVERGENCE=0

    for relpath in ${GENERATED_RELPATHS[@]+"${GENERATED_RELPATHS[@]}"}; do
        staged="$STAGE_DIR/$relpath"
        existing="$OUT_ROOT/$relpath"
        if [ ! -f "$existing" ]; then
            echo "$relpath: faltante"
            DIVERGENCE=1
        elif ! cmp -s "$staged" "$existing"; then
            echo "$relpath: distinta"
            DIVERGENCE=1
        fi
    done

    while IFS= read -r existing_file; do
        [ -n "$existing_file" ] || continue
        rel="${existing_file#"$OUT_ROOT"/}"
        body_first_line="$(extract_body "$existing_file" 2>/dev/null | head -n1)"
        case "$body_first_line" in
            "<!-- GENERADO por $MARKER_SOURCE_SCRIPT desde "*)
                if ! path_in_generated_list "$rel"; then
                    echo "$rel: huerfana"
                    DIVERGENCE=1
                fi
                ;;
            *)
                echo "$rel: sin marcador"
                DIVERGENCE=1
                ;;
        esac
    done < <(find "$OUT_ROOT/.claude/agents" "$OUT_ROOT/.claude/commands" "$OUT_ROOT/.opencode/agents" "$OUT_ROOT/.opencode/commands" -name '*.md' 2>/dev/null | sort)

    # Plugins (issue #2505): todo archivo bajo .opencode/plugins exige el
    # marcador de generado y debe estar entre lo generado.
    while IFS= read -r existing_file; do
        [ -n "$existing_file" ] || continue
        rel="${existing_file#"$OUT_ROOT"/}"
        if [ "$(head -n1 "$existing_file")" != "$EFFORTS_MARKER_LINE" ]; then
            echo "$rel: sin marcador"
            DIVERGENCE=1
        elif ! path_in_generated_list "$rel"; then
            echo "$rel: huerfana"
            DIVERGENCE=1
        fi
    done < <(find "$OUT_ROOT/.opencode/plugins" -type f 2>/dev/null | sort)

    # Skills (issue #1685): SKILL.md exige marcador; todo archivo bajo
    # .claude/skills debe estar ademas entre lo generado.
    while IFS= read -r existing_file; do
        [ -n "$existing_file" ] || continue
        rel="${existing_file#"$OUT_ROOT"/}"
        if [ "${rel##*/}" = "SKILL.md" ]; then
            body_first_line="$(extract_body "$existing_file" 2>/dev/null | head -n1)"
            case "$body_first_line" in
                "<!-- GENERADO por $MARKER_SOURCE_SCRIPT desde "*) ;;
                *) echo "$rel: sin marcador"; DIVERGENCE=1; continue ;;
            esac
        fi
        if ! path_in_generated_list "$rel"; then
            echo "$rel: huerfana"
            DIVERGENCE=1
        fi
    done < <(find "$OUT_ROOT/.claude/skills" -type f 2>/dev/null | sort)

    exit $DIVERGENCE
fi

for relpath in ${GENERATED_RELPATHS[@]+"${GENERATED_RELPATHS[@]}"}; do
    dest="$OUT_ROOT/$relpath"
    mkdir -p "$(dirname "$dest")"
    cp "$STAGE_DIR/$relpath" "$dest"
done

exit 0
