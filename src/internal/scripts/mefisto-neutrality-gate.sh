#!/usr/bin/env bash
# mefisto-neutrality-gate.sh -- Gate de conformidad de neutralidad de runtime
# (MEF-ADR-0049, issue #911, hijo 1 de 3 de #873). Detecta fugas de un runtime
# concreto fuera de las piezas explicitamente autorizadas a nombrarlo, y
# verifica que los adaptadores generados (.claude/{agents,commands}/) esten al
# dia.
#
# Uso: mefisto-neutrality-gate.sh [--root <dir>] [--allowlist <file>]
#   Sin --root: escanea el repo donde vive este propio script (tres niveles
#   arriba de src/internal/scripts/).
#   --root <dir>: escanea <dir> en su lugar -- permite invocar el gate desde
#   el checkout principal contra un worktree de otro issue (MEF-ADR-0019
#   seccion E: el gate se carga desde el checkout principal, pero opera sobre
#   el arbol que se le indique).
#   --allowlist <file>: usa esa allowlist en vez de la que acompana a este
#   script (ver mas abajo; pensado para los tests, que construyen arboles de
#   fixture con su propia allowlist).
#
# Alcance del escaneo (MEF-ADR-0019): solo el lado interno --
# src/internal/**, .claude/**, AGENTS.md. El
# arbol publicado (scripts/, commands/, agents/, hooks/, skills/, docs/,
# CHANGELOG.md, changelog.d/, CLAUDE.md, README.md, .gitignore,
# .claude-plugin/, .mcp.json) queda fuera y asi lo declara
# src/internal/contract/neutrality-allowlist.json (seccion "scope_excluded",
# solo documental: la exclusion real la aplica el filtro de universo de
# archivos de mas abajo).
#
# Cuatro reglas sobre el universo de archivos VERSIONADOS (`git ls-files`,
# nunca el working tree sucio -- un borrador a medio escribir no debe hacer
# fallar el gate):
#   R1 - alias/ids de modelo de proveedor (haiku/sonnet/opus/fable,
#        claude-*/gpt-*, prefijos openai//anthropic/), el campo `model` en
#        frontmatter, y nombres crudos de tools o claves de permiso de un
#        runtime citados como valor JSON -- solo dentro de src/internal/**
#        (MEF-ADR-0049: la fuente neutral no nombra ningun runtime; los
#        adaptadores generados si, y viven fuera de ese prefijo).
#   R2 - invocaciones directas `claude -p`/`claude --agent`,
#        sobre TODO el universo de archivos (codigo y comentarios).
#   R3 - `.claude/pipeline`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR` dentro
#        de src/internal/** y de los scripts canonicos de .claude/scripts/
#        (issue #856/#873 CA-4: la resolucion de rutas es siempre relativa a
#        BASH_SOURCE, nunca a esas variables).
#   R4 - todo .claude/scripts/*.sh de nivel superior (no sus tests/) es, o
#        bien un shim byte-a-byte identico a la plantilla de
#        src/internal/scripts/README.md (o su variante de una linea para
#        _mefisto-common.sh), o bien esta listado en "not_migrated" de la
#        allowlist.
#
# Mas dos verificaciones estructurales (no un grep de texto):
#   adapters-check           - `src/internal/scripts/generate-internal-adapters.sh
#        --check` (el del propio --root) no reporta divergencias.
#   published-adapters-check - `src/published/scripts/generate-published-adapters.sh
#        --check` (el del propio --root, si existe) no reporta divergencias.
#
# Alcance de las dos verificaciones estructurales: las reglas de texto R1-R4
# siguen siendo solo del lado interno (src/internal/**, .claude/**,
# AGENTS.md); adapters-check y published-adapters-check entre las dos cubren
# ambos generadores -- el interno (src/internal/{agents,commands}/*.md ->
# .claude/) y el publicado (src/published/** -> dist/claude/), asi que un
# `main` con cualquiera de las dos salidas desactualizada respecto a su
# fuente lo detecta este mismo gate (issue #1496).
#
# Cada violacion imprime una linea `<ruta>:<linea>: <regla>` (R1-R4) o
# `<ruta>: <estado>: adapters-check` / `<ruta>: <estado>: published-adapters-check`
# (reemitiendo tal cual lo que el --check correspondiente ya reporta). Exit 1
# si hubo alguna, 0 si no.
#
# Rendimiento (CA-3): la lista de archivos se construye UNA vez y cada regla
# de texto (R1-R3) lanza un unico `grep -nHE` sobre su subconjunto -- nunca un
# bucle por archivo y por regla. La allowlist se aplica DESPUES, como filtro
# sobre las lineas ya encontradas (tipicamente pocas), no como precondicion
# de cada grep.
#
# La allowlist declarativa (src/internal/contract/neutrality-allowlist.json)
# se lee relativa a ESTE script (../contract/), nunca a --root: la allowlist
# es parte del gate, y MEF-ADR-0019 seccion E exige que el PR bajo revision no
# pueda alterar el gate que lo juzga -- si se leyera del worktree, un writer
# podria exonerarse a si mismo anadiendo una entrada en su propio PR.
# Registrar una excepcion nueva y usarla son por tanto dos PRs (el de registro
# primero), igual que con is_path_in_mefisto_scope. Toda entrada exige
# `motivo` no vacio (CA-1); si falta alguno, el gate aborta antes de escanear
# nada.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq no esta instalado (MEF-ADR-0049 CA-6: bash + jq + grep)" >&2
    exit 1
fi
if ! command -v git >/dev/null 2>&1; then
    echo "ERROR: git no esta instalado" >&2
    exit 1
fi

ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ALLOWLIST_FILE="$SCRIPT_DIR/../contract/neutrality-allowlist.json"
while [ $# -gt 0 ]; do
    case "$1" in
        --root)
            if [ $# -lt 2 ]; then
                echo "ERROR: --root requiere un directorio" >&2
                exit 1
            fi
            ROOT="$2"
            shift 2
            ;;
        --allowlist)
            if [ $# -lt 2 ]; then
                echo "ERROR: --allowlist requiere un archivo" >&2
                exit 1
            fi
            ALLOWLIST_FILE="$2"
            shift 2
            ;;
        *)
            echo "ERROR: argumento desconocido: $1 (uso: mefisto-neutrality-gate.sh [--root <dir>] [--allowlist <file>])" >&2
            exit 1
            ;;
    esac
done

if [ ! -d "$ROOT" ]; then
    echo "ERROR: --root '$ROOT' no existe o no es un directorio" >&2
    exit 1
fi
ROOT="$(cd "$ROOT" && pwd)"
if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: --root '$ROOT' no es un repositorio git (el universo de archivos sale de git ls-files)" >&2
    exit 1
fi

if [ ! -f "$ALLOWLIST_FILE" ]; then
    echo "ERROR: no existe la allowlist '$ALLOWLIST_FILE'" >&2
    exit 1
fi
# Absoluta ANTES del `cd "$ROOT"` de mas abajo: un --allowlist relativo se
# resuelve respecto al cwd del invocante, no respecto al arbol escaneado.
ALLOWLIST_FILE="$(cd "$(dirname "$ALLOWLIST_FILE")" && pwd)/$(basename "$ALLOWLIST_FILE")"
if ! jq -e '.' "$ALLOWLIST_FILE" >/dev/null 2>&1; then
    echo "ERROR: '$ALLOWLIST_FILE' no es JSON valido" >&2
    exit 1
fi

# CA-1: toda entrada de scope_excluded/exceptions/not_migrated exige 'motivo'
# no vacio. Se valida ANTES de tocar ningun archivo del escaneo -- una
# allowlist mal formada no debe producir un "0 violaciones" enganoso.
MOTIVO_FALTANTE=$(jq -r '
    [(.scope_excluded // [])[], (.exceptions // [])[], (.not_migrated // [])[]]
    | map(select((.motivo // "") | (type != "string" or length == 0)))
    | length
' "$ALLOWLIST_FILE" 2>/dev/null)
if [ -z "$MOTIVO_FALTANTE" ] || [ "$MOTIVO_FALTANTE" != "0" ]; then
    echo "ERROR: '$ALLOWLIST_FILE' tiene al menos una entrada sin 'motivo' no vacio (CA-1)" >&2
    exit 1
fi

cd "$ROOT" || exit 1

# --- Universo de archivos (MEF-ADR-0019: solo lado interno) -----------------
FILES=()
while IFS= read -r f; do
    [ -n "$f" ] && FILES+=("$f")
done < <(git ls-files -- src/internal .claude AGENTS.md 2>/dev/null | sort)

# R1 sobre src/internal/** solamente; R3 sobre src/internal/** + los scripts
# canonicos de .claude/scripts/ (shims incluidos -- son quienes NO deben
# referenciar CLAUDE_PROJECT_DIR/CLAUDE_PLUGIN_ROOT).
R1_FILES=()
R3_FILES=()
for f in ${FILES[@]+"${FILES[@]}"}; do
    case "$f" in
        src/internal/*) R1_FILES+=("$f"); R3_FILES+=("$f") ;;
    esac
    case "$f" in
        .claude/scripts/*) R3_FILES+=("$f") ;;
    esac
done

VIOLATIONS=()

# get_allowlist_patterns <regla> -- imprime, uno por linea, cada patron
# `path` de .exceptions cuyo `rules` contiene <regla> o "ALL".
get_allowlist_patterns() {
    jq -r --arg rule "$1" '
        (.exceptions // [])[]
        | select((.rules // []) | index($rule) or index("ALL"))
        | .path
    ' "$ALLOWLIST_FILE" 2>/dev/null
}

# path_allowed <ruta> <patrones_separados_por_salto_de_linea>
#
# 0 si <ruta> matchea alguno de los patrones (glob de `case`, `*` incluye `/`
# -- por eso "dir/**" y "dir/*" son equivalentes aqui, ambas formas conviven
# en la allowlist por legibilidad).
path_allowed() {
    local path="$1" patterns="$2" pat
    while IFS= read -r pat; do
        [ -n "$pat" ] || continue
        case "$path" in
            $pat) return 0 ;;
        esac
    done <<< "$patterns"
    return 1
}

# run_text_rule <regla> <regex> <archivo...>
#
# CA-3: un unico `grep -nHIE` sobre todo <archivo...> (nunca un grep por
# archivo; -I salta binarios, cuya linea "Binary file ... matches" no tiene la
# forma ruta:linea:texto). Cada coincidencia se filtra contra
# get_allowlist_patterns DESPUES -- ese filtro corre sobre las (pocas) lineas
# ya encontradas, no sobre el universo de archivos completo.
run_text_rule() {
    local rule="$1" regex="$2"
    shift 2
    local rule_files=("$@")
    [ ${#rule_files[@]} -eq 0 ] && return 0

    local allow_patterns
    allow_patterns="$(get_allowlist_patterns "$rule")"

    local raw
    raw="$(grep -nHIE "$regex" -- "${rule_files[@]}" 2>/dev/null)" || true
    [ -z "$raw" ] && return 0

    local line file lineno rest
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        IFS=: read -r file lineno rest <<< "$line"
        if ! path_allowed "$file" "$allow_patterns"; then
            VIOLATIONS+=("$file:$lineno: $rule")
        fi
    done <<< "$raw"
}

# --- R1: alias/ids de modelo, `model` en frontmatter, tools/permission crudos
# `claude-[a-z0-9]...` lleva un borde izquierdo que excluye el `.`: sin el,
# ".claude-plugin" (el manifiesto fisico del plugin, citado en casi todo
# archivo interno via el "guard inverso") contaria como id de modelo -- falso
# positivo medido en la primera corrida de este gate contra el repo real. Con
# ese borde el vocabulario queda abierto a cualquier familia de ids
# `claude-*` (CA-1: `claude-[a-z0-9-]+`) sin ese choque, y sigue cazando los
# ids reales (`claude-opus-5[1m]`, `claude-haiku-4-5-20251001`).
# `"model"[[:space:]]*:` es la forma JSON porque el frontmatter de la fuente
# neutral (src/internal/{agents,commands}/*.md) es JSON, no YAML.
R1_REGEX='(^|[^A-Za-z0-9_.-])(haiku|sonnet|opus|fable)([^A-Za-z0-9_.-]|$)|(^|[^.A-Za-z0-9_-])claude-[a-z0-9][A-Za-z0-9._-]*|gpt-[0-9a-z][A-Za-z0-9._-]*|openai/|anthropic/|"model"[[:space:]]*:|"(Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|Skill|Task)"|"(permission|external_directory|doom_loop|todowrite|webfetch|websearch|lsp)"'
run_text_rule "R1" "$R1_REGEX" ${R1_FILES[@]+"${R1_FILES[@]}"}

# --- R2: invocaciones directas de CLI de un runtime concreto
# Borde final tras `-p`: sin el, una palabra que empiece por `-p` contaria
# como invocacion.
R2_REGEX='claude -p([^A-Za-z0-9_-]|$)|claude --agent'
run_text_rule "R2" "$R2_REGEX" ${FILES[@]+"${FILES[@]}"}

# --- R3: rutas/variables de un runtime concreto que rompen la resolucion neutral
R3_REGEX='\.claude/pipeline|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR'
run_text_rule "R3" "$R3_REGEX" ${R3_FILES[@]+"${R3_FILES[@]}"}

# --- R4: conformidad de shim de .claude/scripts/*.sh (nivel superior) -------
SHIM_TEMPLATE='#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/. No editar.
exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"'

MEFISTO_COMMON_SHIM_TEMPLATE='#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/lib/_mefisto-common.sh. No editar.
# `source` (no `exec`): esta lib se sourcea desde otros scripts, nunca se ejecuta sola.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/src/internal/scripts/lib/_mefisto-common.sh"'

# is_toplevel_claude_script <ruta> -- 0 si <ruta> es ".claude/scripts/*.sh" de
# NIVEL SUPERIOR (sin otra "/" tras el prefijo): excluye .claude/scripts/tests/*.
is_toplevel_claude_script() {
    local path="$1" rest
    case "$path" in
        .claude/scripts/*.sh) ;;
        *) return 1 ;;
    esac
    rest="${path#.claude/scripts/}"
    case "$rest" in
        */*) return 1 ;;
    esac
    return 0
}

NOT_MIGRATED_PATHS="$(jq -r '(.not_migrated // [])[] | .path' "$ALLOWLIST_FILE" 2>/dev/null)"

is_not_migrated() {
    local path="$1" p
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        [ "$p" = "$path" ] && return 0
    done <<< "$NOT_MIGRATED_PATHS"
    return 1
}

for f in ${FILES[@]+"${FILES[@]}"}; do
    is_toplevel_claude_script "$f" || continue
    is_not_migrated "$f" && continue

    if [ "$f" = ".claude/scripts/_mefisto-common.sh" ]; then
        expected="$MEFISTO_COMMON_SHIM_TEMPLATE"
    else
        expected="$SHIM_TEMPLATE"
    fi
    # Byte-exacto (CA-1): `cmp` contra la plantilla con su unico salto de linea
    # final. Un `[ "$(cat "$f")" = "$expected" ]` recortaria los saltos finales
    # y dejaria pasar un shim con lineas en blanco de mas o sin salto final.
    if ! printf '%s\n' "$expected" | cmp -s - "$f" 2>/dev/null; then
        VIOLATIONS+=("$f:1: R4")
    fi
done

# --- adapters-check (CA-2): estructural, no un grep de texto ----------------
# Se ejecuta el generador del propio --root: es el artefacto bajo revision,
# igual que sus adaptadores, y resuelve su REPO_ROOT desde su BASH_SOURCE, asi
# que --check compara la fuente y las salidas de ese mismo arbol. Solo un exit
# distinto de 0 anade violaciones (CA-2: un --check en 0 no anade nada): cada
# linea de stdout ("<ruta>: <estado>") se reemite tal cual con el sufijo de
# regla; el stderr del generador (p. ej. el ERROR de su validacion previa) pasa
# al stderr de este gate sin capturarse y, si con exit != 0 no hubo ninguna
# linea de divergencia, se anade una violacion generica para que ese fallo no
# quede en silencio.
ADAPTERS_SCRIPT="$ROOT/src/internal/scripts/generate-internal-adapters.sh"
if [ -f "$ADAPTERS_SCRIPT" ]; then
    ADAPTERS_OUT="$(bash "$ADAPTERS_SCRIPT" --check)"
    ADAPTERS_RC=$?
    if [ "$ADAPTERS_RC" -ne 0 ]; then
        ADAPTERS_ANY=0
        while IFS= read -r aline; do
            [ -n "$aline" ] || continue
            VIOLATIONS+=("$aline: adapters-check")
            ADAPTERS_ANY=1
        done <<< "$ADAPTERS_OUT"
        if [ "$ADAPTERS_ANY" -eq 0 ]; then
            VIOLATIONS+=("src/internal/scripts/generate-internal-adapters.sh: exit $ADAPTERS_RC sin lineas de divergencia: adapters-check")
        fi
    fi
fi

# --- published-adapters-check (issue #1496): estructural, mismo patron ------
# Mismo criterio que adapters-check pero sobre el generador PUBLICADO: se
# ejecuta el del propio --root (el artefacto bajo revision), sin --out, para
# que resuelva su REPO_ROOT/OUT_ROOT desde su propio BASH_SOURCE y compare la
# fuente publicada (src/published/, src/runtime/) y sus salidas (dist/) del
# mismo arbol. Solo un exit distinto de 0 anade violaciones; el stderr del
# generador pasa al stderr de este gate sin capturarse.
PUBLISHED_SCRIPT="$ROOT/src/published/scripts/generate-published-adapters.sh"
if [ -f "$PUBLISHED_SCRIPT" ]; then
    PUBLISHED_OUT="$(bash "$PUBLISHED_SCRIPT" --check)"
    PUBLISHED_RC=$?
    if [ "$PUBLISHED_RC" -ne 0 ]; then
        PUBLISHED_ANY=0
        while IFS= read -r pline; do
            [ -n "$pline" ] || continue
            VIOLATIONS+=("$pline: published-adapters-check")
            PUBLISHED_ANY=1
        done <<< "$PUBLISHED_OUT"
        if [ "$PUBLISHED_ANY" -eq 0 ]; then
            VIOLATIONS+=("src/published/scripts/generate-published-adapters.sh: exit $PUBLISHED_RC sin lineas de divergencia: published-adapters-check")
        fi
    fi
fi

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
    printf '%s\n' "${VIOLATIONS[@]}"
    exit 1
fi

exit 0
