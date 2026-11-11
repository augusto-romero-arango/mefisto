#!/usr/bin/env bash
# mefisto-launch-pipeline.sh -- Lanzador de los pipelines INTERNOS de Mefisto
#
# Implementacion CANONICA (MEF-ADR-0049 decision 2, issue #871). El shim de
# compatibilidad .claude/scripts/mefisto-launch-pipeline.sh reenvia aqui via
# `exec` (plantilla documentada en src/internal/scripts/README.md); invocar
# por cualquiera de las dos rutas es equivalente.
#
# Uso:
#   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42
#   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42 --from-stage 2   # retomar
#   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42 --models 'writer=<modelo>'  # experimentos, ver src/runtime/contract/models.example.json (#1072)
#   src/internal/scripts/mefisto-launch-pipeline.sh --tooling 42 --variant experimento-a  # corrida paralela del mismo issue (sin PR, rama local)
#   src/internal/scripts/mefisto-launch-pipeline.sh --batch 42 43 44   # secuencial
#
# Dos modos de UI (MEF-ADR-0057 decision 5), elegidos en este orden:
#   1. Desacoplado: MEFISTO_UI=mod, o MEFISTO_UI sin definir con
#      MEFISTO_RUNTIME=claude. El pipeline corre con nohup y lo sigue la cinta
#      de la sesion que lo lanzo (mod mefisto-divine-wager, MEF-ADR-0055).
#   2. Herdr: MEFISTO_UI=herdr, o la sesion corre dentro de un pane herdr
#      (HERDR_ENV=1, HERDR_PANE_ID y `herdr` en PATH). Delega en
#      mefisto-herdr-pipeline.sh, que aborta si no hay contexto herdr.
#   3. En cualquier otro caso, desacoplado sin cinta: el seguimiento es el
#      report log y el visor en otra terminal.
# Un MEFISTO_UI distinto de mod|herdr aborta. --help no depende del modo.
#
# En modo desacoplado el script imprime la ruta del report log y la linea que
# abre el visor en vivo en otra terminal:
#   ./.claude/scripts/mefisto-stream-watch.sh --issues 42
#
# --from-stage N (issue #449, en cualquier posicion de los argumentos) se
# propaga a mefisto-tooling-pipeline.sh para retomar una corrida caida. Solo
# valido en --tooling (un unico issue): --batch lo rechaza, porque un unico
# --from-stage sobre varios issues seria ambiguo. El wrapper NO valida el
# rango -- eso lo hace mefisto-tooling-pipeline.sh (1-2), que aborta con
# mensaje claro si esta fuera de rango.
#
# --models 'agente=modelo[,...]' (issue #709, en cualquier posicion) se
# propaga igual que --from-stage, solo valido con --tooling: experimentos A/B
# de desempeno del harness, contraparte interna de launch-pipeline.sh --tooling
# --models (issue #708, lado publicado). El wrapper NO valida el formato --eso
# lo hace parse_stage_models en mefisto-tooling-pipeline.sh, ANTES de crear el
# worktree. Los ids concretos de cada runtime no viven en este script: ver
# src/runtime/contract/models.example.json (issue #1072) para la forma que deben
# tener, o el mapping local .mefisto/models.json una vez poblado.
#
# --variant <label> (issue #711, en cualquier posicion) se propaga igual que
# --models, solo valido con --tooling: corridas paralelas del MISMO issue
# (contraparte interna de launch-pipeline.sh --tooling --variant, issue #710,
# lado publicado). El wrapper NO valida el formato del label -- eso lo hace
# validate_variant_label en mefisto-tooling-pipeline.sh, ANTES de crear el
# worktree. --batch lo rechaza (seria ambiguo sobre varios issues).
#
# Solo se ejecuta dentro del repo de Mefisto (assert_in_mefisto en _mefisto-common.sh).

set -euo pipefail

# --- Funciones compartidas ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/_mefisto-common.sh"
assert_in_mefisto || exit 1

# --- Colores ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_ROOT="$MEFISTO_REPO_ROOT"
# Siempre por mefisto_state_path (issue #869): una ruta compuesta a mano con el
# prefijo legacy apunta a un archivo que el pipeline ya no escribe.
EVENTS_LOG="$(mefisto_state_path "events.log")"
# CAFF: prefijo "caffeinate -i" (o vacio fuera de macOS), calculado UNA vez
# por corrida y antepuesto al lanzamiento de cada sub-pipeline interno --
# issue #800. Evita que el Mac entre en suspension idle durante la corrida.
CAFF="$(caffeinate_prefix)"

# ENV_PREFIX: asignaciones "VAR=valor " antepuestas al comando del sub-pipeline
# (issue #871, CA-2). MEFISTO_RUNTIME selecciona el runtime activo (issue #867,
# resuelto rio abajo por mefisto-tooling-pipeline.sh/mefisto-batch-pipeline.sh)
# y MEFISTO_MODELS_FILE apunta al mapping de modelos cuando el caller ya lo
# fijo. Solo se agregan si estan fijadas -- un valor vacio cambiaria el
# comportamiento (autodeteccion) respecto de no fijarlo. printf %q escapa el
# valor como DATO: el string lo re-parsea `bash -c` (CA-4).
ENV_PREFIX=""
[ -n "${MEFISTO_RUNTIME:-}" ] && ENV_PREFIX="${ENV_PREFIX}MEFISTO_RUNTIME=$(printf '%q' "$MEFISTO_RUNTIME") "
[ -n "${MEFISTO_MODELS_FILE:-}" ] && ENV_PREFIX="${ENV_PREFIX}MEFISTO_MODELS_FILE=$(printf '%q' "$MEFISTO_MODELS_FILE") "

# La ruta de los sub-pipelines viaja escapada con printf %q (CA-4): se deriva
# de SCRIPT_DIR, y un checkout bajo un directorio con espacios partiria el
# comando de `bash -c` en dos argumentos.
TOOLING_SCRIPT_Q="$(printf '%q' "$SCRIPT_DIR/mefisto-tooling-pipeline.sh")"
BATCH_SCRIPT_Q="$(printf '%q' "$SCRIPT_DIR/mefisto-batch-pipeline.sh")"

VALID_UI_MODES="Modos validos: 'mod' (desacoplado, el default) y 'herdr' (panes, dentro de herdr)."

log()     { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
success() { echo -e "${GREEN}${BOLD}v${NC} $1"; }
# La usa ensure_repo_on_base_branch de _mefisto-common.sh.
warn()    { echo -e "${YELLOW}!${NC} $1"; }
abort()   { echo -e "\n${RED}${BOLD}x $1${NC}" >&2; exit 1; }

ensure_events_log() {
    mkdir -p "$(dirname "$EVENTS_LOG")"
    touch "$EVENTS_LOG"
}

# Extrae --from-stage N, --models X y --variant X de "$@" (en
# cualquier posicion) y los consume: ninguno debe propagarse posicionalmente
# al pipeline (CA-2 de #435, extendido por #449) -- critico en --batch, que
# trata el resto como la lista de issues.
#
# Deja: FROM_STAGE_EXTRA ("--from-stage N" o vacio), MODELS_EXTRA ("--models
# 'agente=modelo[,...]'" o vacio -- issue #709), VARIANT_EXTRA ("--variant
# 'label'" o vacio -- issue #711) y el resto de argumentos, en orden, en el
# array global REMAINING_ARGS.
REMAINING_ARGS=()
FROM_STAGE_EXTRA=""
MODELS_EXTRA=""
VARIANT_EXTRA=""
extract_wrapper_flags() {
    REMAINING_ARGS=()
    FROM_STAGE_EXTRA=""
    MODELS_EXTRA=""
    VARIANT_EXTRA=""
    local -a args=("$@")
    local i=0
    while [ "$i" -lt "${#args[@]}" ]; do
        case "${args[$i]}" in
            --from-stage)
                i=$((i + 1))
                local value="${args[$i]:-}"
                [ -n "$value" ] || abort "Falta el valor de --from-stage"
                [[ "$value" =~ ^[0-9]+$ ]] || abort "--from-stage debe ser un numero entero (recibido: '$value')"
                FROM_STAGE_EXTRA="--from-stage $value"
                ;;
            --models)
                # Comillas simples: el valor puede traer '[' / ']' de un id de
                # modelo con corchetes, que el shell de `bash -c` tomaria como
                # glob sin ellas.
                i=$((i + 1))
                local models_value="${args[$i]:-}"
                [ -n "$models_value" ] || abort "Falta el valor de --models"
                MODELS_EXTRA="--models '$models_value'"
                ;;
            --variant)
                i=$((i + 1))
                local variant_value="${args[$i]:-}"
                [ -n "$variant_value" ] || abort "Falta el valor de --variant"
                VARIANT_EXTRA="--variant '$variant_value'"
                ;;
            *)
                REMAINING_ARGS+=("${args[$i]}")
                ;;
        esac
        i=$((i + 1))
    done
}

print_usage() {
    echo "Uso: $0 --tooling <issue> [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>]"
    echo "     $0 --batch <issue1> <issue2> ..."
    echo ""
    echo "  Modo de UI (MEFISTO_UI). $VALID_UI_MODES"
    echo "              Sin MEFISTO_UI: desacoplado con MEFISTO_RUNTIME=claude; si no,"
    echo "              herdr dentro de un pane herdr; si no, desacoplado."
    echo "              En modo desacoplado el script imprime la ruta del report log"
    echo "              y la linea que abre el visor en vivo en otra terminal:"
    echo "                ./.claude/scripts/mefisto-stream-watch.sh --issues <issue>"
    echo ""
    echo "  --from-stage N  (issue #449) Retoma una corrida caida desde el Stage N."
    echo "                  Solo valido con --tooling (un unico issue); --batch lo"
    echo "                  rechaza porque seria ambiguo sobre varios issues. El"
    echo "                  rango (1-2) lo valida mefisto-tooling-pipeline.sh, no"
    echo "                  este wrapper."
    echo ""
    echo "  --models 'agente=modelo[,...]'  (issue #709, experimentos A/B de"
    echo "                  desempeno del harness) Sobreescribe el modelo de un"
    echo "                  stage puntual de mefisto-tooling-pipeline.sh. La clave"
    echo "                  es el nombre de agente que recibe run_agent(): hoy"
    echo "                  'reviewer' (Stage 2) y 'writer' -- que cubre DOS stages,"
    echo "                  el Stage 1 y la etapa de merge, ambos invocados con ese"
    echo "                  mismo nombre. Solo valido con --tooling; --batch lo"
    echo "                  rechaza por la misma ambiguedad que --from-stage. Un"
    echo "                  --models malformado aborta ANTES de crear el worktree."
    echo "                  Ejemplo: --models writer=<modelo>,reviewer=<modelo> -- ver"
    echo "                  src/runtime/contract/models.example.json (issue #1072) para la"
    echo "                  forma de los ids por runtime."
    echo ""
    echo "  --variant <label>  (issue #711, corridas paralelas del mismo issue)"
    echo "                  Corre el MISMO issue en un worktree/rama propios"
    echo "                  (sufijo -<label>), sin push, sin PR y sin mutar el"
    echo "                  issue -- la rama queda local, para comparar contra otra"
    echo "                  variante. Se combina con --models para comparar modelo"
    echo "                  por variante (una variante sin --models es la corrida"
    echo "                  de control). Solo valido con --tooling; --batch lo"
    echo "                  rechaza (seria ambiguo sobre varios issues). Un label"
    echo "                  invalido aborta ANTES de crear el worktree."
}

# launch_detached <report_log> <comando>
#
# Corre <comando> con nohup, sin las variables HERDR_* ni MEFISTO_UI, para que
# sobreviva al cierre de la sesion que lo lanzo y ningun descendiente abra
# panes en el workspace del humano.
launch_detached() {
    local report_log="$1" pipeline_cmd="$2"

    local env_unset=(-u HERDR_ENV -u MEFISTO_UI)
    local v
    while IFS='=' read -r v _; do
        case "$v" in
            HERDR_*) env_unset+=(-u "$v") ;;
        esac
    done < <(env)

    (cd "$PROJECT_ROOT" && nohup env "${env_unset[@]}" bash -c "${ENV_PREFIX}$CAFF $pipeline_cmd" \
        >"$report_log" 2>&1 </dev/null &)
}

# report_detached <titulo> <report_log> <issues_csv>
report_detached() {
    local title="$1" report_log="$2" issues_csv="$3"
    if [ "$FOLLOWED_BY_MOD" = true ]; then
        success "$title (sin pane: lo sigue el mod mefisto-divine-wager)"
    else
        success "$title (sin pane)"
    fi
    log "Reporte: $report_log"
    log "Visor en otra terminal: ./.claude/scripts/mefisto-stream-watch.sh --issues $issues_csv"
}

cmd_tooling_detached() {
    extract_wrapper_flags "$@"
    # Guarda de bash 3.2 (macOS): "${arr[@]}" con un array vacio revienta con
    # "unbound variable" bajo `set -u`.
    if [ ${#REMAINING_ARGS[@]} -gt 0 ]; then
        set -- "${REMAINING_ARGS[@]}"
    else
        set --
    fi
    [ $# -lt 1 ] && abort "Falta el numero de issue. Uso: --tooling <issue> [--from-stage N]"
    local issue="$1"

    ensure_events_log
    local logs_dir report_log
    logs_dir="$(mefisto_state_path "logs")"
    mkdir -p "$logs_dir"
    report_log="$logs_dir/mefisto-tooling-run-$(date +%Y%m%d-%H%M%S)-issue-$issue.report.log"

    local pipeline_cmd="$TOOLING_SCRIPT_Q $issue"
    [ -n "$FROM_STAGE_EXTRA" ] && pipeline_cmd="$pipeline_cmd $FROM_STAGE_EXTRA"
    [ -n "$MODELS_EXTRA" ] && pipeline_cmd="$pipeline_cmd $MODELS_EXTRA"
    [ -n "$VARIANT_EXTRA" ] && pipeline_cmd="$pipeline_cmd $VARIANT_EXTRA"

    launch_detached "$report_log" "$pipeline_cmd"
    report_detached "Pipeline mefisto-tooling iniciado para issue #$issue" "$report_log" "$issue"
}

# Las validaciones de flags ya las hizo preflight_batch_start.
cmd_batch_detached() {
    extract_wrapper_flags "$@"
    local issues=()
    [ ${#REMAINING_ARGS[@]} -gt 0 ] && issues=("${REMAINING_ARGS[@]}")
    [ ${#issues[@]} -gt 0 ] || abort "Debes especificar al menos un issue. Uso: --batch 42 43 44"
    # Los issues viajan dentro del string de `bash -c`: solo se aceptan numeros.
    local n
    for n in "${issues[@]}"; do
        [[ "$n" =~ ^[0-9]+$ ]] || abort "Issue invalido para --batch: '$n' (solo numeros)."
    done

    ensure_events_log
    local logs_dir report_log
    logs_dir="$(mefisto_state_path "logs")"
    mkdir -p "$logs_dir"
    report_log="$logs_dir/mefisto-batch-run-$(date +%Y%m%d-%H%M%S).report.log"

    launch_detached "$report_log" "$BATCH_SCRIPT_Q ${issues[*]}"
    report_detached "Batch pipeline interno iniciado: issues ${issues[*]}" "$report_log" "$(IFS=','; echo "${issues[*]}")"
}

# Valida el modo batch y adelanta su gate de rama al limite sincronico del
# launcher. Debe correr antes de delegar a herdr o lanzar nada; el motor repite
# el mismo helper como defensa ante invocacion directa y carreras posteriores.
preflight_batch_start() {
    extract_wrapper_flags "$@"
    local issues=()
    [ ${#REMAINING_ARGS[@]} -gt 0 ] && issues=("${REMAINING_ARGS[@]}")
    [ ${#issues[@]} -gt 0 ] || abort "Debes especificar al menos un issue. Uso: --batch 42 43 44"
    [ -z "$FROM_STAGE_EXTRA" ] || abort "--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --from-stage N para un unico issue."
    [ -z "$MODELS_EXTRA" ] || abort "--models no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --models 'agente=modelo' para un unico issue."
    [ -z "$VARIANT_EXTRA" ] || abort "--variant no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --variant <label> para un unico issue."
    ensure_repo_on_base_branch
}

# 0 si la cinta de la sesion sigue la corrida (issue #2284): MEFISTO_UI=mod, o
# MEFISTO_UI sin definir con el runtime claude, que el comando antepone siempre.
uses_detached_ui() {
    [ "${MEFISTO_UI:-}" = "mod" ] && return 0
    [ -z "${MEFISTO_UI:-}" ] && [ "${MEFISTO_RUNTIME:-}" = "claude" ] && return 0
    return 1
}

# 0 si esta invocacion corre por la interfaz herdr: MEFISTO_UI=herdr la fuerza
# (mefisto-herdr-pipeline.sh aborta sin contexto herdr); sin MEFISTO_UI basta
# estar dentro de un pane herdr con el binario en PATH.
should_delegate_to_herdr() {
    [ "${MEFISTO_UI:-}" = "herdr" ] && return 0
    [ "${HERDR_ENV:-}" = "1" ] || return 1
    [ -n "${HERDR_PANE_ID:-}" ] || return 1
    command -v herdr &>/dev/null
}

# --- Dispatcher ---
if [ $# -eq 0 ]; then
    print_usage
    exit 1
fi

case "$1" in
    --help|-h)
        print_usage
        exit 0
        ;;
esac

for arg in "$@"; do
    case "$arg" in
        --attach|--if-exists)
            abort "--attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5)."
            ;;
    esac
done

case "${MEFISTO_UI:-}" in
    ""|mod|herdr) ;;
    *) abort "MEFISTO_UI='$MEFISTO_UI' no es un modo valido. $VALID_UI_MODES" ;;
esac

case "$1" in
    --tooling) ;;
    --batch)   preflight_batch_start "${@:2}" ;;
    *)         abort "Argumento no reconocido: $1" ;;
esac

FOLLOWED_BY_MOD=false
if uses_detached_ui; then
    FOLLOWED_BY_MOD=true
elif should_delegate_to_herdr; then
    exec "$SCRIPT_DIR/mefisto-herdr-pipeline.sh" "$@"
fi

mode="$1"
shift
case "$mode" in
    --tooling) cmd_tooling_detached "$@" ;;
    --batch)   cmd_batch_detached "$@" ;;
esac
