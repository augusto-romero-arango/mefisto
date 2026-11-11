#!/usr/bin/env bash
# mefisto-tooling-pipeline.sh -- Pipeline INTERNO de tooling para el repo de Mefisto
#
# Implementacion CANONICA (MEF-ADR-0049 decision 2, issue #869). El shim de
# compatibilidad .claude/scripts/mefisto-tooling-pipeline.sh reenvia aqui via
# `exec` (plantilla documentada en src/internal/scripts/README.md); invocar
# por cualquiera de las dos rutas es equivalente.
#
# Uso:
#   src/internal/scripts/mefisto-tooling-pipeline.sh 42
#   src/internal/scripts/mefisto-tooling-pipeline.sh --issue 42
#   src/internal/scripts/mefisto-tooling-pipeline.sh 42 --from-stage 2
#   src/internal/scripts/mefisto-tooling-pipeline.sh 42 --models 'reviewer=<modelo>,writer=<modelo>'  # Modelo por stage (experimentos)
#   src/internal/scripts/mefisto-tooling-pipeline.sh 42 --variant experimento-a  # Corrida paralela del mismo issue (sin PR, rama local)
#   MEFISTO_AGENT_TIMEOUT_SECONDS=<s> src/internal/scripts/mefisto-tooling-pipeline.sh 42  # Timeout de watchdog por stage (default 1800; entero > 0, issue #946)
#   MEFISTO_HOLD_MAX_SECONDS=<s> / MEFISTO_HOLD_PROBE_SECONDS=<s> src/internal/scripts/mefisto-tooling-pipeline.sh 42  # Techo (default 21600 = 6h) y cadencia de sondeo (default 300) de la espera ante RATE_LIMIT/PROVIDER_UNAVAILABLE (issue #967)
#
# Ciclo: Issue (en repo Mefisto) -> Worktree -> Writer -> Reviewer -> Sync main -> PR -> Cleanup
#
# ALCANCE: solo modifica archivos del propio plugin (commands/, agents/, scripts/,
# hooks/, docs/, .claude-plugin/, .claude/{commands,agents,scripts}/,
# src/{internal,published,runtime}/, dist/ y gobierno).
# No corre dotnet ni terraform. No usa .claude/harness.config.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/_mefisto-common.sh"
assert_in_mefisto || exit 1
ensure_githooks_installed

# Frontera explicita con el nucleo comun (MEF-ADR-0053): el pipeline conserva
# scope, prompts, worktrees y entrega internos; runtime, modelos y ejecucion
# viven solo en src/runtime/. Las capacidades de generacion siguen siendo
# internas y no se cargan para ejecutar stages.
RUNTIME_DIR="$(cd "$SCRIPT_DIR/../../runtime" && pwd)"
RUNTIME_LIB_DIR="$RUNTIME_DIR/lib"
RUN_AGENT_BIN_DEFAULT="$RUNTIME_DIR/mefisto-run-agent.sh"
# Cuando lo invoca el batch aislado, MEFISTO_LAUNCH_ROOT conserva la raiz que
# posee estado y configuracion local; el codigo ejecutable sigue viniendo del
# snapshot. La corrida unitaria no fija esa variable y conserva el contrato
# previo. MEFISTO_MODELS_FILE sigue siendo el override explicito del launcher.
INTERNAL_MODELS_FILE="${MEFISTO_MODELS_FILE:-${MEFISTO_LAUNCH_ROOT:-$MEFISTO_REPO_ROOT}/.mefisto/models.json}"
source "$RUNTIME_LIB_DIR/mefisto-runtime.sh"
source "$RUNTIME_LIB_DIR/mefisto-models.sh"
source "$SCRIPT_DIR/lib/frontmatter.sh"

# Version y SHA del propio plugin que corre esta corrida (issue #662),
# calculados UNA sola vez aqui -- ANTES de crear el worktree del issue. En una
# corrida batch, el cwd es la raiz ejecutable aislada y por eso el SHA identifica
# exactamente la maquinaria del eslabon, no el HEAD mutable del launcher. El
# trap de aborto solo interpola las variables ya resueltas, nunca recalcula.
HARNESS_VERSION="$(get_harness_version)"
HARNESS_VERSION_JSON="null"
[ -n "$HARNESS_VERSION" ] && HARNESS_VERSION_JSON="\"$HARNESS_VERSION\""
HARNESS_SHA="$(get_harness_sha)"
HARNESS_SHA_JSON="null"
[ -n "$HARNESS_SHA" ] && HARNESS_SHA_JSON="\"$HARNESS_SHA\""

# --- Colores ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# --- Logging ---
# Estado neutral a runtime (MEF-ADR-0049, issue #869): la base ya no es la
# ruta legacy bajo .claude/ a secas -- MEFISTO_STATE_DIR (exportada por
# mefisto-state.sh, sourceada arriba via _mefisto-common.sh) resuelve
# ".mefisto/pipeline", el mismo canonico que mefisto_state_path usa para el
# caso sin <root> explicito.
PIPELINE_DIR="$MEFISTO_STATE_DIR"
LOG_DIR="$PIPELINE_DIR/logs"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/mefisto-tooling-pipeline-$TIMESTAMP.log"

# --- Runtime activo (issue #867/#910) --------------------------------------
#
# MEFISTO_RUNTIME viaja como variable de entorno desde la directiva
# {{mefisto:run}} de cada comando ("MEFISTO_RUNTIME=<runtime> ./.claude/scripts/...").
# MEFISTO_RUNTIME_JSON se completa mas abajo, tras resolver el runtime
# (mefisto_resolve_runtime, en la verificacion de dependencias) -- "null" aqui
# es solo un placeholder para que abort() no reviente bajo `set -u` si un
# aborto de parseo de argumentos ocurre ANTES de esa resolucion.
MEFISTO_RUNTIME_JSON="null"

# Lineas de log que abort() reemite al fallar (issue #379): la causa real de un
# fallo externo (gh, git...) vive en el log del pipeline, no en el mensaje de
# abort, y sin esto solo se llega a ella abriendo un segundo archivo.
TAIL_LOG_LINES=20

# --- Tracking de estado ---
AGENT_WR_DUR="" AGENT_WR_RES="pending"
AGENT_RV_DUR="" AGENT_RV_RES="pending"
# Metricas por stage (issue #426): JSON compacto de compute_stage_metrics,
# cosechado en los mismos puntos donde ya se cosecha AGENT_*_DUR.
AGENT_WR_METRICS_JSON=""
AGENT_RV_METRICS_JSON=""
# Segundos en espera (hold, issue #967) por stage -- 0 si el stage nunca
# entro en hold. Se cosecha en los mismos puntos que AGENT_*_DUR (CA-6).
AGENT_WR_HOLD_SECONDS=0
AGENT_RV_HOLD_SECONDS=0
# Si el stage reanudo al menos una sesion truncada tras un hold (issue #968,
# CA-6) -- se cosecha en los mismos puntos que AGENT_*_HOLD_SECONDS y viaja
# al cuerpo del PR, que es el resumen del stage que SOBREVIVE al worktree.
AGENT_WR_RESUMED=false
AGENT_RV_RESUMED=false
PIPELINE_PR=""
PIPELINE_ERROR=""
LAST_AGENT_DURATION=0
LAST_AGENT_METRICS_JSON=""
LAST_AGENT_HOLD_SECONDS=0
LAST_AGENT_RESUMED=false
CURRENT_STAGE="setup"

_strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }
_log_file()   { echo -e "$1" | _strip_ansi >> "${LOG_FILE_ABS:-$LOG_FILE}"; }

# _tail_log_for_abort <log_file> <n>
#
# Emite por stdout las ultimas <n> lineas de <log_file> sin codigos ANSI, bajo
# un encabezado explicito. Usado por abort() para que la causa real de un
# fallo externo (gh, git, dotnet...) viaje al log del batch sin que el humano
# tenga que abrir un segundo archivo (issue #379). Tolera log ausente, vacio o
# con menos de <n> lineas -- en esos casos no imprime nada y no falla. Nunca
# reentra a abort/warn si el propio tail falla.
#
# Emite por stdout a proposito: el stream lo elige quien llama, porque abort()
# no usa el mismo en los tres pipelines (el interno manda todo a stderr, los
# publicados a stdout). Asi el cuerpo de esta funcion es identico en las tres
# copias sin desalinear el stream de ninguna.
_tail_log_for_abort() {
    local log_file="$1" n="$2"
    [ -s "$log_file" ] || return 0
    local tail_lines
    tail_lines="$(tail -n "$n" "$log_file" 2>/dev/null | _strip_ansi)" || return 0
    [ -n "$tail_lines" ] || return 0
    echo -e "${YELLOW}Ultimas $n lineas del log:${NC}"
    echo "$tail_lines"
}

log()     { local m="${BLUE}[$(date +%H:%M:%S)]${NC} $1"; echo -e "$m"; _log_file "$m"; }
success() { local m="${GREEN}${BOLD}v${NC} $1"; echo -e "$m"; _log_file "$m"; }
warn()    { local m="${YELLOW}!${NC} $1"; echo -e "$m"; _log_file "$m"; }
header()  { local m="\n${CYAN}${BOLD}-- $1 --${NC}"; echo -e "$m"; _log_file "$m"; }
abort() {
    # El tail se captura ANTES de que este mismo abort escriba su linea de ERROR
    # al log: si se leyera despues, las dos ultimas lineas del tail serian un eco
    # del mensaje que se acaba de imprimir -- ruido que ademas se come dos lineas
    # del contexto real que se quiere mostrar (issue #379).
    local log_tail
    log_tail="$(_tail_log_for_abort "${LOG_FILE_ABS:-$LOG_FILE}" "$TAIL_LOG_LINES")" || log_tail=""
    PIPELINE_ERROR="$(echo "$1" | sed 's/"/\\"/g' | tr '\n' ' ')"
    # '|| true': abort() corre tambien ANTES de que exista $LOG_DIR -- los
    # abortos de parseo de argumentos (--variant mal formado, issue #711;
    # "Argumento no reconocido"; "Falta el numero de issue") caen todos ahi.
    # Sin esta guarda, el tee falla, errexit mata el proceso en esta linea
    # (abort() es el comando final de un '||', asi que NO hereda la exencion
    # de errexit) y el humano solo ve "tee: ... No such file or directory":
    # el motivo real del aborto nunca llega a stderr.
    echo -e "\n${RED}${BOLD}x ERROR: $1${NC}" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null || true
    echo -e "${RED}${BOLD}x ERROR: $1${NC}" >&2
    echo -e "${YELLOW}Revisa el log: ${LOG_FILE_ABS:-$LOG_FILE}${NC}" >&2
    if [ -n "$log_tail" ]; then echo "$log_tail" >&2; fi
    if [ -n "${WORKTREE_PATH:-}" ] && [ -d "$WORKTREE_PATH" ]; then
        echo -e "${YELLOW}El worktree queda en: $WORKTREE_PATH${NC}" >&2
    fi
    if [ -n "${PIPELINE_DIR_ABS:-}" ]; then
        update_status "$CURRENT_STAGE" "failed"
        # CA-3 (issue #426): agents.<agente>.metrics de los stages ya
        # cerrados en esta corrida -- los fallos son los casos mas caros de
        # entender y hasta este issue quedaban sin ninguna cifra por agente.
        local abort_agents_json
        abort_agents_json=$(build_agents_history_json "${AGENT_WR_DUR:-}" "${AGENT_WR_METRICS_JSON:-}" "${AGENT_RV_DUR:-}" "${AGENT_RV_METRICS_JSON:-}" 2>/dev/null) \
            || abort_agents_json="{\"writer\":{\"duration\":${AGENT_WR_DUR:-null}},\"reviewer\":{\"duration\":${AGENT_RV_DUR:-null}}}"
        echo "{\"issue\":\"${ISSUE_NUM:-}\",\"title\":\"$(echo "${ISSUE_TITLE:-}" | sed 's/"/\\"/g')\",\"pipeline\":\"mefisto-tooling\",\"variant\":${VARIANT_LABEL_JSON:-null},\"runtime\":${MEFISTO_RUNTIME_JSON:-null},\"harness_version\":${HARNESS_VERSION_JSON:-null},\"harness_sha\":${HARNESS_SHA_JSON:-null},\"started\":\"${TIMESTAMP:-}\",\"finished\":\"$(date +%Y-%m-%dT%H:%M:%S)\",\"state\":\"failed\",\"stage\":\"$CURRENT_STAGE\",\"agents\":$abort_agents_json,\"error\":\"$PIPELINE_ERROR\"}" \
            >> "$PIPELINE_DIR_ABS/pipeline-history.jsonl" 2>/dev/null || true
    fi
    exit 1
}

update_status() {
    local stage="$1" state="$2"
    CURRENT_STAGE="$stage"
    local wr_dur="null" rv_dur="null"
    [ -n "$AGENT_WR_DUR" ] && wr_dur="$AGENT_WR_DUR"
    [ -n "$AGENT_RV_DUR" ] && rv_dur="$AGENT_RV_DUR"
    local pr_val="null" error_val="null"
    [ -n "$PIPELINE_PR" ]    && pr_val="\"$PIPELINE_PR\""
    [ -n "$PIPELINE_ERROR" ] && error_val="\"$PIPELINE_ERROR\""
    cat > "$PIPELINE_DIR_ABS/$STATUS_FILENAME" <<EOJSON
{
  "issue": "${ISSUE_NUM:-null}",
  "title": "$(echo "${ISSUE_TITLE:-}" | sed 's/"/\\"/g')",
  "pipeline": "mefisto-tooling",
  "variant": ${VARIANT_LABEL_JSON:-null},
  "runtime": ${MEFISTO_RUNTIME_JSON:-null},
  "started": "$TIMESTAMP",
  "stage": "$stage",
  "state": "$state",
  "updated": "$(date +%Y-%m-%dT%H:%M:%S)",
  "worktree": "${WORKTREE_PATH:-}",
  "log": "${LOG_FILE_ABS:-$LOG_FILE}",
  "agents": {
    "writer":   {"duration": $wr_dur, "result": "$AGENT_WR_RES"},
    "reviewer": {"duration": $rv_dur, "result": "$AGENT_RV_RES"}
  },
  "pr": $pr_val,
  "last_error": $error_val
}
EOJSON
}

# --- Parsear argumentos ---
ISSUE_NUM=""
FROM_STAGE=1
STATUS_FILENAME="pipeline-status-mefisto-tooling.json"
MODELS_SPEC=""  # --models 'agente=modelo[,agente=modelo...]' (issue #709)
VARIANT_LABEL=""  # --variant <label>: corrida paralela del mismo issue, sin PR (issue #711)

if [ $# -eq 0 ]; then
    echo "Uso: $0 [--issue NUM | NUM] [--from-stage N] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]"
    exit 1
fi

POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue)
            [ $# -lt 2 ] && abort "Falta el numero de issue"
            ISSUE_NUM="$2"
            shift 2
            ;;
        --from-stage)
            [ $# -lt 2 ] && abort "Falta el numero de stage"
            FROM_STAGE="$2"
            shift 2
            ;;
        --status-file)
            [ $# -lt 2 ] && abort "Falta el nombre del archivo de status"
            STATUS_FILENAME="$2"
            shift 2
            ;;
        --models)
            [ $# -lt 2 ] && abort "Falta el valor de --models"
            MODELS_SPEC="$2"
            shift 2
            ;;
        --variant)
            [ $# -lt 2 ] && abort "Falta el valor de --variant"
            VARIANT_LABEL="$2"
            shift 2
            ;;
        [0-9]*)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
        *)
            abort "Argumento no reconocido: $1"
            ;;
    esac
done

if [ ${#POSITIONAL_ARGS[@]} -gt 0 ] && [ -z "$ISSUE_NUM" ]; then
    ISSUE_NUM="${POSITIONAL_ARGS[0]}"
fi

[ -z "$ISSUE_NUM" ] && abort "Falta el numero de issue"

# --- Resolver --variant (issue #711) --------------------------------------
# Se valida ANTES de crear el worktree (CA-1) y antes de derivar cualquier
# nombre de archivo de la corrida (CA-2), mismo criterio que --models: un
# label malformado debe abortar temprano, y el sufijo tiene que estar puesto
# ya en el primer archivo que se escribe. Mas abajo, en modo variante se
# suprimen push, creacion de PR y comentario al issue (CA-3).
VARIANT_LABEL_JSON="null"
ISSUE_LOG_TAG="$ISSUE_NUM"
if [ -n "$VARIANT_LABEL" ]; then
    validate_variant_label "$VARIANT_LABEL" \
        || abort "--variant mal formado: ${MEFISTO_VARIANT_LABEL_ERROR:-label invalido}"
    VARIANT_LABEL_JSON="\"$VARIANT_LABEL\""
    ISSUE_LOG_TAG="${ISSUE_NUM}-${VARIANT_LABEL}"
    # El log del pipeline tambien lleva el sufijo, no solo los de stage: dos
    # variantes lanzadas en el MISMO segundo comparten $TIMESTAMP y, sin el
    # label, escribirian las dos al mismo archivo -- log entrelazado, y el
    # tail de abort() mostrando lineas de la otra corrida.
    LOG_FILE="$LOG_DIR/mefisto-tooling-pipeline-${TIMESTAMP}-${VARIANT_LABEL}.log"
fi

if [ "$STATUS_FILENAME" = "pipeline-status-mefisto-tooling.json" ]; then
    STATUS_FILENAME="pipeline-status-mefisto-tooling-${ISSUE_NUM}.json"
    [ -n "$VARIANT_LABEL" ] && STATUS_FILENAME="pipeline-status-mefisto-tooling-${ISSUE_NUM}-${VARIANT_LABEL}.json"
fi

if ! [[ "$FROM_STAGE" =~ ^[1-2]$ ]]; then
    abort "--from-stage debe ser 1 o 2 (recibido: $FROM_STAGE)"
fi

# --- Resolver MEFISTO_AGENT_TIMEOUT_SECONDS (issue #946) --------------------
# Se valida ANTES de crear el worktree, mismo criterio que --variant/--models
# mas abajo: un valor invalido no debe dejar un worktree a medias. Misma
# validacion que --timeout hace en mefisto-run-agent.sh (entero > 0) -- si se
# dejara pasar hasta ahi, el abort_usage de ese script ocurriria con el
# worktree ya creado.
MEFISTO_AGENT_TIMEOUT_SECONDS="${MEFISTO_AGENT_TIMEOUT_SECONDS:-1800}"
case "$MEFISTO_AGENT_TIMEOUT_SECONDS" in
    ''|*[!0-9]*) abort "MEFISTO_AGENT_TIMEOUT_SECONDS '$MEFISTO_AGENT_TIMEOUT_SECONDS' no es un entero" ;;
esac
[ "$MEFISTO_AGENT_TIMEOUT_SECONDS" -gt 0 ] \
    || abort "MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0 (recibido: $MEFISTO_AGENT_TIMEOUT_SECONDS)"

# --- Verificar dependencias ---
for cmd in gh git jq; do
    command -v "$cmd" &>/dev/null || abort "Falta comando requerido: $cmd"
done

# --- Resolver runtime activo (MEF-ADR-0049, issue #910) ---------------------
# ANTES de crear el worktree: un runtime no resoluble no debe dejar un
# worktree a medias, mismo criterio que --variant/--models mas abajo.
# mefisto_resolve_runtime prioriza MEFISTO_RUNTIME (entorno, lo antepone el
# comando generado por la directiva {{mefisto:run}}) sobre la autodeteccion;
# este pipeline no expone un flag --runtime propio.
if ! MEFISTO_RUNTIME_RESUELTO="$(mefisto_resolve_runtime)"; then
    abort "No se pudo resolver el runtime activo: $MEFISTO_RUNTIME_ERROR"
fi
command -v "$MEFISTO_RUNTIME_RESUELTO" &>/dev/null \
    || abort "Falta el CLI del runtime resuelto ('$MEFISTO_RUNTIME_RESUELTO'). Fija MEFISTO_RUNTIME con un runtime instalado."
MEFISTO_RUNTIME_JSON="\"$MEFISTO_RUNTIME_RESUELTO\""

# --- Preparar directorio de pipeline ---
mkdir -p "$LOG_DIR"
mkdir -p "$PIPELINE_DIR/metrics"
echo "Pipeline mefisto-tooling iniciado: $TIMESTAMP" > "$LOG_FILE"

PIPELINE_DIR_ABS="$(realpath "$PIPELINE_DIR")"
LOG_DIR_ABS="$(realpath "$LOG_DIR")"
LOG_FILE_ABS="$(realpath "$LOG_FILE")"
EVENTS_LOG_ABS="$PIPELINE_DIR_ABS/events.log"
touch "$EVENTS_LOG_ABS"

echo "=== SESSION MEFISTO-TOOLING $TIMESTAMP issue:$ISSUE_NUM from-stage:$FROM_STAGE ===" >> "$EVENTS_LOG_ABS"
echo "[$(date +%H:%M:%S)] RUNTIME: $MEFISTO_RUNTIME_RESUELTO" >> "$EVENTS_LOG_ABS"

# --- Resolver --models (issue #709) --------------------------------------
# Se valida ANTES de crear el worktree: un --models malformado debe abortar
# temprano, no a mitad de Stage 1 con un worktree ya en disco.
parse_stage_models "$MODELS_SPEC" \
    || abort "--models mal formado: ${MEFISTO_STAGE_MODELS_ERROR:-formato invalido}"
if [ -n "$MEFISTO_STAGE_MODELS" ]; then
    STAGE_MODELS_LOG="$(format_stage_models_for_log)"
    log "Modelos por stage (--models): $STAGE_MODELS_LOG"
    echo "[$(date +%H:%M:%S)] MODELS: $STAGE_MODELS_LOG" >> "$EVENTS_LOG_ABS"
fi

# --- Resolver el modelo de cada stage (MEF-ADR-0049 decision 4, issue #910) --
# Se resuelve aqui, ANTES de crear el worktree, por el mismo motivo que
# --models justo arriba: un mapping local invalido (.mefisto/models.json) o un
# adaptador sin tabla debe abortar temprano, no a mitad de Stage 1 con un
# worktree ya en disco.
#
# Perfil por rol: balanced para escritura, deep para revision -- mismo criterio
# de siempre (issue #710), ahora expresado como perfil logico en vez de un
# modelo fijo. Los defaults por alias de modelo ya no viven en este pipeline:
# quien quiera pinnear un modelo usa --models (por corrida) o .mefisto/models.json
# (por maquina). El stage de resolucion de conflictos corre como
# `run_agent "merge" "writer"`, asi que reusa el modelo del writer.
MODEL_WRITER=""
MODEL_REVIEWER=""

# resolve_pipeline_stage_model <clave-de-stage> <agent-id-neutral> <perfil>
#
# Deja el modelo resuelto en MEFISTO_STAGE_MODEL_RESUELTO (cadena vacia =
# heredar el modelo activo del CLI; run_agent omite --model por completo en ese
# caso). Precedencia: override --models por clave EXACTA de stage
# (resolve_stage_model, issue #709) y, sin match, mefisto_resolve_model
# (mapping local -> tabla del adaptador -> heredar).
MEFISTO_STAGE_MODEL_RESUELTO=""
resolve_pipeline_stage_model() {
    local stage_key="$1" agent_id="$2" profile="$3"

    MEFISTO_STAGE_MODEL_RESUELTO="$(resolve_stage_model "$stage_key" "")"
    if [ -n "$MEFISTO_STAGE_MODEL_RESUELTO" ]; then
        # Constancia del override que SI hizo match: el mapa que se loguea
        # arriba no dice cuales claves aplicaron, y una clave con typo
        # ('revieweer=<modelo>') no sobreescribe nada -- sin esta linea el
        # experimento correria con el modelo por defecto y el reporte se lo
        # atribuiria al override.
        echo "[$(date +%H:%M:%S)] MODELS: $stage_key -> $MEFISTO_STAGE_MODEL_RESUELTO (override --models)" >> "$EVENTS_LOG_ABS"
        return 0
    fi

    # Redirect simple (>), NUNCA "$(...)": una sustitucion de comando forkea un
    # subshell y MEFISTO_MODELS_ERROR, asignada DENTRO de mefisto_resolve_model,
    # se perderia al volver -- el abort quedaria sin motivo (la propia libreria
    # advierte de esta trampa, ver lib/mefisto-models.sh).
    local out_file
    out_file="$(mktemp)"
    if ! mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile" "" "$INTERNAL_MODELS_FILE" > "$out_file"; then
        rm -f "$out_file"
        abort "No se pudo resolver el modelo de $agent_id (perfil $profile): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"
    fi
    MEFISTO_STAGE_MODEL_RESUELTO="$(cat "$out_file")"
    rm -f "$out_file"
    echo "[$(date +%H:%M:%S)] MODELS: $stage_key -> ${MEFISTO_STAGE_MODEL_RESUELTO:-<heredado>} (perfil $profile)" >> "$EVENTS_LOG_ABS"
}

resolve_pipeline_stage_model "writer" "mefisto-writer" "balanced"
MODEL_WRITER="$MEFISTO_STAGE_MODEL_RESUELTO"
resolve_pipeline_stage_model "reviewer" "mefisto-reviewer" "deep"
MODEL_REVIEWER="$MEFISTO_STAGE_MODEL_RESUELTO"

# --- Resolver el effort de cada agente (issue #2499) ----------------------
# Mismo momento y criterio que el modelo: ANTES del worktree. El nivel de
# fabrica se lee del campo `effort` de la fuente neutral del agente, junto al
# codigo que se ejecuta (en un batch aislado, el snapshot). El stage merge
# reusa el effort del writer; reintentos y reanudacion reenvian el mismo.
EFFORT_WRITER=""
EFFORT_REVIEWER=""

# resolve_pipeline_stage_effort <clave-de-stage> <agent-id-neutral>
# Deja el nativo en MEFISTO_STAGE_EFFORT_RESUELTO (vacio = heredar).
MEFISTO_STAGE_EFFORT_RESUELTO=""
resolve_pipeline_stage_effort() {
    local stage_key="$1" agent_id="$2"
    local agent_file="$SCRIPT_DIR/../agents/$agent_id.md" level=""

    level="$(extract_frontmatter "$agent_file" 2>/dev/null | jq -r '.effort // empty' 2>/dev/null)" || level=""
    if [ -z "$level" ]; then
        MEFISTO_EFFORTS_ERROR="la fuente $agent_file no declara 'effort' o es ilegible"
        abort "No se pudo resolver el effort de $agent_id: MEFISTO_EFFORTS_ERROR=$MEFISTO_EFFORTS_ERROR"
    fi

    # Redirect a archivo, nunca "$(...)": MEFISTO_EFFORTS_ERROR se perderia en
    # el subshell (misma trampa que resolve_pipeline_stage_model).
    local out_file
    out_file="$(mktemp)"
    if ! mefisto_resolve_effort "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$level" "$INTERNAL_MODELS_FILE" > "$out_file"; then
        rm -f "$out_file"
        abort "No se pudo resolver el effort de $agent_id (nivel $level): MEFISTO_EFFORTS_ERROR=${MEFISTO_EFFORTS_ERROR:-motivo desconocido}"
    fi
    MEFISTO_STAGE_EFFORT_RESUELTO="$(cat "$out_file")"
    rm -f "$out_file"
    echo "[$(date +%H:%M:%S)] EFFORTS: $stage_key -> ${MEFISTO_STAGE_EFFORT_RESUELTO:-<heredado>} (nivel $level)" >> "$EVENTS_LOG_ABS"
}

resolve_pipeline_stage_effort "writer" "mefisto-writer"
EFFORT_WRITER="$MEFISTO_STAGE_EFFORT_RESUELTO"
resolve_pipeline_stage_effort "reviewer" "mefisto-reviewer"
EFFORT_REVIEWER="$MEFISTO_STAGE_EFFORT_RESUELTO"

# --- Anunciar el modo variante (issue #711) -------------------------------
# El label ya se valido y ya derivo los nombres de archivo arriba, junto al
# parseo de argumentos; aqui solo se anuncia, que es lo primero que se puede
# hacer una vez existen el log del pipeline y events.log.
if [ -n "$VARIANT_LABEL" ]; then
    log "Modo variante: '$VARIANT_LABEL' -- sin push, sin PR, sin comentario al issue (CA-3); rama queda local"
    echo "[$(date +%H:%M:%S)] VARIANT: $VARIANT_LABEL" >> "$EVENTS_LOG_ABS"
fi

# --- Obtener issue ---
header "Preparando contexto"

log "Descargando issue #$ISSUE_NUM del repo de Mefisto..."
ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --json number,title,body,state,labels 2>>"${LOG_FILE_ABS:-$LOG_FILE}") \
    || abort "No se pudo obtener el issue #$ISSUE_NUM (debe existir en este repo)"
ISSUE_STATE=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])" 2>/dev/null || echo "UNKNOWN")
if [ "$ISSUE_STATE" != "OPEN" ]; then
    abort "El issue #$ISSUE_NUM esta $ISSUE_STATE -- solo se procesan issues abiertos."
fi
ISSUE_TITLE=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])" 2>/dev/null \
    || echo "$ISSUE_JSON" | grep -o '"title":"[^"]*"' | sed 's/"title":"//;s/"//')
ISSUE_BODY=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['body'])" 2>/dev/null \
    || echo "$ISSUE_JSON" | sed 's/.*"body":"//;s/","[^"]*":".*//;s/\\n/\n/g;s/\\r//g')
ISSUE_PR_REFERENCE="Closes"
ISSUE_COMPLETION_NOTE=""
if echo "$ISSUE_JSON" | python3 -c "import sys,json; print(any(label['name'] == 'cierre:manual' for label in json.load(sys.stdin).get('labels', [])))" 2>/dev/null | grep -qx "True"; then
    ISSUE_PR_REFERENCE="Refs"
    ISSUE_COMPLETION_NOTE=" Este PR no cierra el issue (label cierre:manual)."
fi
ISSUE_CONTEXT="# Issue #$ISSUE_NUM: $ISSUE_TITLE

$ISSUE_BODY"
log "Issue: $ISSUE_TITLE"

echo "$ISSUE_CONTEXT" > "$PIPELINE_DIR/mefisto-tooling-input.md"

# --- Preparar worktree ---
header "Preparando worktree"

REPO_ROOT="${MEFISTO_LAUNCH_ROOT:-$MEFISTO_REPO_ROOT}"
CURRENT_BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)

SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | tr -s '-' | cut -c1-40 | sed 's/-$//')
BRANCH_NAME="worktree-mefisto-issue-${ISSUE_NUM}-${SLUG}"
# Modo variante (CA-2): worktree y rama llevan el sufijo -<label>, para que N
# corridas simultaneas del mismo issue coexistan sin colision de paths ni ramas.
[ -n "$VARIANT_LABEL" ] && BRANCH_NAME="${BRANCH_NAME}-${VARIANT_LABEL}"
# Dentro del repo, bajo .mefisto/worktrees/ (ignorado por Git), como las sesiones
# directas: no ensucia el directorio de trabajo y mefisto-worktree.sh clean lo ve.
WORKTREE_PATH="${REPO_ROOT}/.mefisto/worktrees/${BRANCH_NAME}"

if [ "$FROM_STAGE" -gt 1 ]; then
    [ -d "$WORKTREE_PATH" ] || abort "No existe el worktree en $WORKTREE_PATH. No se puede retomar desde Stage $FROM_STAGE."
    log "Retomando desde Stage $FROM_STAGE -- worktree existente: $WORKTREE_PATH"
    SNAPSHOT_COMMIT=$(git -C "$WORKTREE_PATH" merge-base HEAD main)
    log "Snapshot detectado: $SNAPSHOT_COMMIT"
else
    # El worktree se ramifica SIEMPRE desde origin/main actualizado, sea cual sea
    # la rama del cwd. El guard queda solo como contexto informativo en el log.
    if [ "$CURRENT_BRANCH" != "main" ] && [ "$CURRENT_BRANCH" != "master" ]; then
        warn "cwd en rama '$CURRENT_BRANCH' (no main/master): el worktree se creara igual desde origin/main"
    fi

    log "Actualizando origin/main..."
    git -C "$REPO_ROOT" fetch origin main >>"$LOG_FILE" 2>&1 || abort "No se pudo hacer fetch de origin/main"

    if [ -d "$WORKTREE_PATH" ]; then
        warn "El worktree ya existe: $WORKTREE_PATH -- limpiando para reiniciar..."
        git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 || true
        git -C "$REPO_ROOT" branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
    fi
    if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
        warn "La rama $BRANCH_NAME ya existe sin worktree -- eliminandola..."
        git -C "$REPO_ROOT" branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
    fi

    log "Creando worktree: $WORKTREE_PATH (base: origin/main)"
    mkdir -p "$(dirname "$WORKTREE_PATH")" || abort "No se pudo crear $(dirname "$WORKTREE_PATH")"
    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" origin/main >>"$LOG_FILE" 2>&1 \
        || abort "No se pudo crear el worktree desde origin/main"

    success "Worktree creado: $WORKTREE_PATH"

    mkdir -p "$WORKTREE_PATH/.mefisto/pipeline/summaries"

    # .claude/settings.json (issue #523) ya viaja VERSIONADO con el worktree,
    # checked out desde origin/main: el pipeline no lo inyecta ni lo revierte.
    #
    # El pipeline del consumidor (scripts/tooling-pipeline.sh) si lo hace --
    # copia el settings.json del repo base sustituyendo la ruta relativa de
    # events.log por la absoluta de la corrida, y lo revierte con
    # `git checkout --` antes de cada commit para no ensuciar el PR. Ese par
    # inyeccion/reversion aqui seria activamente daniino:
    #
    #   1. La copia vendria de $REPO_ROOT (el arbol de trabajo del clon
    #      principal, que puede estar sucio o en otra rama), pisando con el
    #      un archivo que el worktree ya tiene correcto desde origin/main.
    #   2. `git checkout -- .claude/settings.json` revierte cualquier edicion
    #      NO comiteada del archivo. Ahora que esta versionado, un issue que
    #      anada un hook nuevo perderia el trabajo del writer en silencio --
    #      y el bloque ECONOMIA DE TURNOS le pide justamente no re-inspeccionar
    #      el arbol, asi que nadie se enteraria hasta ver el PR vacio.
    #   3. La sustitucion no cambia nada: el unico hook de Mefisto
    #      (mefisto-scope-hook.mts) no escribe a events.log.
    #
    # Si algun dia un hook interno necesita la ruta absoluta del events.log
    # centralizado, hay que resolverlo sin `git checkout --` sobre un archivo
    # que el writer puede estar editando legitimamente (p. ej. leyendo una
    # variable de entorno especifica de runtime desde el propio hook).

    update_status "setup" "running"

    SNAPSHOT_COMMIT=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
    log "Snapshot: $SNAPSHOT_COMMIT"
fi

# --- Funcion auxiliar: recolectar resumen de agente ---
collect_summary() {
    local stage="$1" agent="$2"
    local f
    f=$(mefisto_state_path "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH")
    if [ -f "$f" ]; then cat "$f"; else echo "_(El agente no genero resumen)_"; fi
}

# runtime_supports_resume <runtime-id> (issue #968, CA-4 caso b)
#
# 0 si el adaptador de <runtime-id> expone runtime_<id>_supports_resume y esa
# funcion retorna 0; 1 en cualquier otro caso -- adaptador inexistente,
# funcion ausente, o funcion que responde "no". Esa es la degradacion segura
# que pide MEF-ADR-0050: un runtime sin soporte de reanudacion degrada la
# operacion (stage desde cero), nunca la rompe.
#
# El adaptador se DESCUBRE, no se enumera: la ruta sale de
# $MEFISTO_RUNTIME_LIB_DIR (el mismo seam overridable que usa
# mefisto_resolve_runtime en mefisto-runtime.sh), asi que un runtime nuevo
# queda cubierto con solo aportar su lib -- este pipeline nunca nombra
# `runtime-claude.sh` (MEF-ADR-0049: ningun pipeline nombra un runtime concreto; MEF-ADR-0050: el conjunto de runtimes
# soportados es abierto).
#
# La carga va en un SUBSHELL a proposito: lo unico que este pipeline necesita
# del adaptador es esta capability, y sourcearlo en su propio namespace
# importaria tambien runtime_<id>_build_cmd/_translate -- que son
# competencia exclusiva de mefisto-run-agent.sh, un proceso aparte (#910).
runtime_supports_resume() {
    local runtime="$1"
    local lib="${MEFISTO_RUNTIME_LIB_DIR:-${RUNTIME_LIB_DIR:-$SCRIPT_DIR/../../runtime/lib}}/runtime-${runtime}.sh"
    [ -f "$lib" ] || return 1
    (
        # shellcheck source=/dev/null
        source "$lib" >/dev/null 2>&1 || exit 1
        fn="runtime_${runtime}_supports_resume"
        command -v "$fn" >/dev/null 2>&1 || exit 1
        "$fn"
    )
}

# La seleccion ya ocurrio antes de crear el worktree. Estos helpers solo hacen
# visible esa evidencia y nunca participan en el argv ni en el desenlace.
log_agent_model_invocation() {
    local agent="$1" model="$2"
    log "Invocando $agent (modelo: ${model:-<heredado>})..."
}

log_effective_stage_model() {
    local stage="$1" agent="$2" declared_model="$3" metrics_json="$4"
    [ -z "$declared_model" ] || return 0

    local effective_model
    effective_model=$(printf '%s' "$metrics_json" | jq -r 'if . != null and .model != null then .model else empty end' 2>/dev/null || true)
    [ -n "$effective_model" ] && log "MODELS: stage $stage/$agent -> $effective_model (efectivo)"
    return 0
}

# --- Funcion auxiliar para invocar agentes ---
run_agent() {
    local stage="$1"
    local agent="$2"
    local prompt="$3"
    local log_base="$LOG_DIR_ABS/mefisto-tooling-stage-${stage}-${agent}-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}"
    local log_stage="${log_base}.log"
    local stream_file="${log_base}.stream.jsonl"
    local stderr_file="${log_base}.stderr.log"
    # JSONL neutral (issue #910): lo escribe mefisto-run-agent.sh directo, un
    # nivel por debajo de este pipeline. Las funciones de clasificacion de
    # lib/_mefisto-common.sh leen SOLO este archivo -- la traza cruda
    # ($stream_file) se conserva aparte, solo para diagnostico, y ningun gate
    # la parsea.
    local events_file="${log_base}.events.jsonl"
    # Prompt del stage, en archivo (CA-1): mefisto-run-agent.sh recibe
    # --prompt-file, nunca el texto inline -- a diferencia de la vieja
    # invocacion directa del CLI del runtime con el prompt inline.
    local prompt_file="$PIPELINE_DIR_ABS/prompts/mefisto-tooling-stage-${stage}-${agent}-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}.prompt.md"
    mkdir -p "$(dirname "$prompt_file")"
    printf '%s' "$prompt" > "$prompt_file"

    local start_ts
    start_ts=$(date +%s)

    echo "[$(date +%H:%M:%S)] === MEFISTO-TOOLING STAGE $stage: $agent ===" >> "$EVENTS_LOG_ABS"
    case "$agent" in
        writer)   AGENT_WR_RES="running" ;;
        reviewer) AGENT_RV_RES="running" ;;
    esac

    # Id de agente neutral + modelo, ambos ya resueltos ANTES de crear el
    # worktree (CA-2, resolve_pipeline_stage_model): aqui solo se selecciona
    # por rol. El stage de resolucion de conflictos corre como
    # `run_agent "merge" "writer"` y por eso cae en la rama de escritura --
    # mismo agente, modelo y effort que el writer de Stage 1.
    local MEFISTO_AGENT_ID AGENT_MODEL AGENT_EFFORT
    case "$agent" in
        reviewer) MEFISTO_AGENT_ID="mefisto-reviewer"; AGENT_MODEL="$MODEL_REVIEWER"; AGENT_EFFORT="$EFFORT_REVIEWER" ;;
        *)        MEFISTO_AGENT_ID="mefisto-writer";   AGENT_MODEL="$MODEL_WRITER";   AGENT_EFFORT="$EFFORT_WRITER" ;;
    esac
    update_status "$stage-$agent" "running"
    log_agent_model_invocation "$agent" "$AGENT_MODEL"

    # Ya validado (entero > 0) y con su default aplicado ANTES de crear el
    # worktree -- ver el bloque MEFISTO_AGENT_TIMEOUT_SECONDS mas arriba.
    local AGENT_TIMEOUT_SECONDS="$MEFISTO_AGENT_TIMEOUT_SECONDS"

    # --- Reintento ante fallo transitorio del servidor (issue #534) ---
    # Ambos parametros son overridables por entorno para que los tests puedan
    # ejercer el bucle sin esperar 120s reales.
    local MAX_ATTEMPTS="${MEFISTO_AGENT_MAX_ATTEMPTS:-3}"
    local RETRY_BACKOFF_SECONDS="${MEFISTO_AGENT_RETRY_BACKOFF_SECONDS:-120}"

    # --- Espera (hold) ante RATE_LIMIT/PROVIDER_UNAVAILABLE persistente
    # (issue #967) ---
    # Segunda politica del mismo bucle: cuando el reintento corto de arriba no
    # aplica (RATE_LIMIT, que #965 deja fuera de agent_failure_is_retryable
    # desde el primer fallo) o se agota sin resolver (PROVIDER_UNAVAILABLE
    # persistente), el stage no aborta -- se sienta a esperar. El propio
    # reintento es la sonda: si la causa sigue vigente, el intento siguiente
    # muere en segundos con la misma senal y se vuelve a esperar (decision de
    # diseno de #967: evita construir un mecanismo de sondeo separado por
    # runtime). Overridables por entorno, igual que MAX_ATTEMPTS/
    # RETRY_BACKOFF_SECONDS, para que los tests ejerzan el bucle sin esperar
    # horas reales.
    local HOLD_MAX_SECONDS="${MEFISTO_HOLD_MAX_SECONDS:-21600}"
    local HOLD_PROBE_SECONDS="${MEFISTO_HOLD_PROBE_SECONDS:-300}"
    # Margen fijo sobre `resets_at` (issue #965): el runtime informa el
    # instante exacto en que se levanta el limite, pero despertar justo en el
    # segundo cero puede ganarle por poco a una ventana todavia cerrada.
    local HOLD_RESET_MARGIN_SECONDS=60
    # CA-4: contadores PROPIOS, independientes de $attempt/$MAX_ATTEMPTS -- el
    # hold es una politica distinta sobre una causa distinta, y no debe
    # consumir el presupuesto de reintentos de #534.
    #
    # Son dos medidas distintas a proposito: HOLD_TOTAL_SECONDS suma solo las
    # siestas (es "cuanto se estuvo esperando", lo que reporta CA-6) y
    # HOLD_ELAPSED_SECONDS es el reloj desde que empezo la espera (es contra
    # lo que se mide el techo de CA-2).
    local HOLD_TOTAL_SECONDS=0
    local HOLD_ELAPSED_SECONDS=0
    local HOLD_STARTED_TS=""

    # CA-4: estado del worktree AL ENTRAR al stage, para poder restaurarlo
    # entre reintentos. No sirve $SNAPSHOT_COMMIT: ese es el commit de entrada
    # al PIPELINE, y en stage 2 resetear ahi borraria el commit del writer.
    #
    # Solo se restaura si el worktree entraba LIMPIO. El pipeline tolera que
    # el writer deje trabajo sin commitear (ver HAS_UNSTAGED tras stage 1), y
    # en ese caso un reset --hard destruiria trabajo legitimo: ante la duda no
    # se toca nada y se reintenta sobre el estado actual.
    local ENTRY_COMMIT="" ENTRY_CLEAN=false
    ENTRY_COMMIT=$(git -C "$WORKTREE_PATH" rev-parse HEAD 2>/dev/null || echo "")
    if [ -z "$(git -C "$WORKTREE_PATH" status --porcelain 2>/dev/null)" ]; then
        ENTRY_CLEAN=true
    fi

    # Ruta del runner comun, overridable por entorno para fixtures sin proveedor.
    local RUN_AGENT_BIN="${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}"

    # --- Reanudacion de sesion tras un hold (issue #968) ---
    # SUMMARY_FILE se computa UNA vez aqui (mismo archivo que collect_summary
    # y que el bloque final de este stage ya leian por separado): CA-4 caso
    # (c) necesita comprobar su existencia DENTRO del bucle, en cada ciclo de
    # hold, no solo al final.
    local SUMMARY_FILE
    SUMMARY_FILE=$(mefisto_state_path "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH")
    # RESUME_SESSION_ID no vacio = el PROXIMO intento reanuda esa sesion en
    # vez de arrancar una nueva (CA-3). RESUME_DEGRADED=true es permanente
    # para el resto de esta invocacion de run_agent: una vez que el caso (c)
    # degrada, no se vuelve a intentar reanudar en este mismo stage.
    # RESUMED_ANY deja constancia (CA-6) de que hubo al menos una reanudacion,
    # para el log de cierre del stage.
    local RESUME_SESSION_ID="" RESUME_DEGRADED=false RESUMED_ANY=false
    local RESUME_PROMPT_FILE="$PIPELINE_DIR_ABS/prompts/mefisto-tooling-stage-${stage}-${agent}-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}.resume-prompt.md"

    local RUN_EXIT=0 TIMED_OUT=false failure_type="" metrics_json="" elapsed=0
    local attempt=1
    while :; do
        local attempt_start_ts
        attempt_start_ts=$(date +%s)

        # attempt_used_resume (issue #968): refleja si ESTE intento arranca
        # reanudando una sesion -- capturado ANTES de invocar, para que el
        # caso (c) de CA-4 (mas abajo, tras el fallo) sepa si el fallo que
        # acaba de ocurrir fue de un intento resumido o de uno nuevo. Cuando
        # hay reanudacion, el prompt que se envia es el mensaje corto de
        # continuacion (RESUME_PROMPT_FILE), NUNCA el prompt completo del
        # stage: reenviarlo entero arriesga que el agente reinicie su
        # analisis desde cero (notas tecnicas de #968).
        local attempt_used_resume=false attempt_prompt_file="$prompt_file"
        if [ -n "$RESUME_SESSION_ID" ]; then
            attempt_used_resume=true
            attempt_prompt_file="$RESUME_PROMPT_FILE"
        fi

        local RUN_AGENT_ARGS=(
            --runtime "$MEFISTO_RUNTIME_RESUELTO"
            --agent "$MEFISTO_AGENT_ID"
            --cwd "$WORKTREE_PATH"
            --prompt-file "$attempt_prompt_file"
            --system-file "$SCRIPT_DIR/../prompts/noninteractive-system.md"
            --event-log "$events_file"
            --raw-log "$stream_file"
            --stderr-log "$stderr_file"
            --events-log "$EVENTS_LOG_ABS"
            --timeout "$AGENT_TIMEOUT_SECONDS"
        )
        [ -n "$AGENT_MODEL" ] && RUN_AGENT_ARGS+=(--model "$AGENT_MODEL")
        [ -n "$AGENT_EFFORT" ] && RUN_AGENT_ARGS+=(--effort "$AGENT_EFFORT")
        [ -n "$RESUME_SESSION_ID" ] && RUN_AGENT_ARGS+=(--resume-session "$RESUME_SESSION_ID")

        # Diagnostico propio del runner (uso invalido, avisos best-effort de
        # --events-log): archivo dedicado junto al resto de artefactos del
        # intento, sin depender de LOG_FILE_ABS -- run_agent no lo necesita
        # para nada mas.
        #
        # A diferencia del viejo run_agent_with_watchdog (que SIEMPRE
        # retornaba 0 -- su ultimo comando era un `echo` del exit code
        # capturado), mefisto-run-agent.sh es un proceso real cuyo propio
        # exit code ES el desenlace (CA-5 de #858): bajo `set -e`, invocarlo
        # como sentencia simple mataria el pipeline entero en el primer
        # intento fallido, sin pasar nunca por classify_agent_failure ni por
        # abort(). El if/else evita justamente eso.
        if "$RUN_AGENT_BIN" "${RUN_AGENT_ARGS[@]}" >>"${log_base}.runner.log" 2>&1; then
            RUN_EXIT=0
        else
            RUN_EXIT=$?
        fi
        elapsed=$(( $(date +%s) - attempt_start_ts ))

        # $log_stage se deriva del JSONL neutral que el runner ya escribio en
        # $events_file (texto del asistente + una linea por tool call + la
        # linea de error del terminal) mas el contenido de $stderr_file, con
        # el mismo nombre de archivo de siempre. La traza cruda ($stream_file)
        # se conserva solo para diagnostico -- ningun gate la parsea.
        derive_stage_log_from_stream "$events_file" "$stderr_file" "$log_stage"

        # CA-1 (issue #426, reescrita sobre el JSONL neutral en el issue
        # #907): metricas por stage derivadas de $events_file, no de la traza
        # cruda -- compute_stage_metrics ya no interpreta el vocabulario de
        # ningun runtime concreto. Se escriben SIEMPRE (stage exitoso o
        # fallido) -- un fallo de instrumentacion (jq ausente, archivo vacio,
        # sin evento terminal) degrada a "null" y nunca aborta el pipeline.
        metrics_json=$(compute_stage_metrics "$events_file")
        echo "$metrics_json" > "$PIPELINE_DIR_ABS/metrics/mefisto-tooling-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}-stage-${stage}-${agent}.json" 2>/dev/null || true

        # CA-3: el runner ya distingue el timeout (exit 124, MEF-ADR-0031 --
        # el terminal neutral, nunca el exit code a secas) de cualquier otro
        # desenlace -- ya no hace falta un archivo de senal propio en este
        # nivel: el watchdog vive dentro de mefisto-run-agent.sh.
        TIMED_OUT=false
        [ "$RUN_EXIT" -eq 124 ] && TIMED_OUT=true

        failure_type=""
        if [ "$RUN_EXIT" -ne 0 ]; then
            failure_type=$(classify_agent_failure "$TIMED_OUT" "$RUN_EXIT" "$elapsed" "$events_file")
        fi

        # Salida normal: exito.
        [ -z "$failure_type" ] && break

        if agent_failure_is_retryable "$failure_type" && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
            # CA-6 (#534): el reintento deja rastro. Sin esta linea un
            # post-mortem no puede distinguir "salio a la primera" de "salio
            # al tercer intento".
            warn "$agent: $failure_type -- reintentando ($((attempt + 1))/$MAX_ATTEMPTS) tras ${RETRY_BACKOFF_SECONDS}s"
            echo "[$(date +%H:%M:%S)] REINTENTO $agent: $failure_type (intento $attempt/$MAX_ATTEMPTS, espera ${RETRY_BACKOFF_SECONDS}s)" >> "$EVENTS_LOG_ABS"

            # El log y la traza del intento fallido se preservan aparte: el
            # siguiente intento sobrescribe los nombres canonicos, y sin esta
            # copia la evidencia del fallo que motivo el reintento se perderia.
            cp -f "$log_stage" "${log_base}.attempt-${attempt}.log" 2>/dev/null || true
            cp -f "$stream_file" "${log_base}.attempt-${attempt}.stream.jsonl" 2>/dev/null || true
            cp -f "$events_file" "${log_base}.attempt-${attempt}.events.jsonl" 2>/dev/null || true

            if [ "$ENTRY_CLEAN" = true ] && [ -n "$ENTRY_COMMIT" ]; then
                # CA-5 (#534): `clean -fd` va sin -x a proposito --
                # .mefisto/pipeline/ esta gitignored y sus summaries deben
                # sobrevivir al reintento.
                git -C "$WORKTREE_PATH" reset --hard "$ENTRY_COMMIT" >/dev/null 2>&1 || true
                git -C "$WORKTREE_PATH" clean -fd >/dev/null 2>&1 || true
                log "Worktree restaurado a ${ENTRY_COMMIT:0:8} para el reintento"
            else
                log "El worktree ya tenia cambios al entrar al stage: NO se restaura (se reintenta sobre el estado actual)"
            fi

            sleep "$RETRY_BACKOFF_SECONDS"
            attempt=$((attempt + 1))
        elif agent_failure_is_holdable "$failure_type"; then
            # CA-1/CA-2 (issue #967): RATE_LIMIT desde el primer fallo (nunca
            # paso por la rama de arriba) y PROVIDER_UNAVAILABLE una vez
            # agotado su presupuesto de reintento corto entran aqui en vez de
            # abortar. $attempt/$MAX_ATTEMPTS quedan intactos a proposito
            # (CA-4): son dos presupuestos sobre dos causas distintas.
            [ -z "$HOLD_STARTED_TS" ] && HOLD_STARTED_TS=$(date +%s)
            local now_epoch
            now_epoch=$(date +%s)

            # CA-2: el techo se mide en RELOJ desde que arranco la espera, no
            # sumando solo las siestas. Cada sonda que falla consume tiempo
            # real -- un PROVIDER_UNAVAILABLE puede tardar minutos en morir --
            # y contar unicamente los `sleep` dejaria el techo efectivo muy
            # por encima de HOLD_MAX_SECONDS, que es justo lo que CA-2
            # prohibe ("un proveedor caido 12h no puede dejar el pane
            # esperando en silencio para siempre"). Es ademas la unica medida
            # coherente con el "(techo HH:MM)" que se imprime mas abajo.
            HOLD_ELAPSED_SECONDS=$(( now_epoch - HOLD_STARTED_TS ))
            local hold_remaining=$(( HOLD_MAX_SECONDS - HOLD_ELAPSED_SECONDS ))
            if [ "$hold_remaining" -le 0 ]; then
                # CA-2: techo agotado -- se rompe SIN dormir de nuevo. El
                # bloque de abajo (agent_work_is_trustworthy / abort) hereda
                # los dos contadores y nombra cuanto se espero.
                break
            fi

            # CA-1: si el terminal trajo `resets_at`, dormir hasta esa hora
            # (mas el margen) en vez de sondear a ciegas. El sondeo cada
            # HOLD_PROBE_SECONDS es el piso garantizado -- corre cuando
            # `resets_at` falta (runtime o adaptador que no lo informa).
            local resets_at hold_sleep
            resets_at=$(agent_events_resets_at "$events_file")
            hold_sleep="$HOLD_PROBE_SECONDS"
            if [ -n "$resets_at" ]; then
                local resets_epoch
                resets_epoch=$(iso8601_to_epoch "$resets_at" 2>/dev/null || echo "")
                if [ -n "$resets_epoch" ]; then
                    hold_sleep=$(( resets_epoch + HOLD_RESET_MARGIN_SECONDS - now_epoch ))
                    [ "$hold_sleep" -lt 1 ] && hold_sleep=1
                fi
            fi
            [ "$hold_sleep" -gt "$hold_remaining" ] && hold_sleep="$hold_remaining"

            # CA-3: rastro por ciclo de espera, formato fijo para que un
            # post-mortem distinga un hold en curso de un pipeline colgado.
            local hold_family="${failure_type%% *}"
            local next_probe_hms deadline_hm hold_deadline_epoch next_probe_epoch
            hold_deadline_epoch=$(( HOLD_STARTED_TS + HOLD_MAX_SECONDS ))
            next_probe_epoch=$(( now_epoch + hold_sleep ))
            next_probe_hms=$(date -r "$next_probe_epoch" +%H:%M:%S 2>/dev/null || date -d "@$next_probe_epoch" +%H:%M:%S 2>/dev/null || echo "??:??:??")
            deadline_hm=$(date -r "$hold_deadline_epoch" +%H:%M 2>/dev/null || date -d "@$hold_deadline_epoch" +%H:%M 2>/dev/null || echo "??:??")

            warn "$agent: $failure_type -- en espera (hold), proxima sonda a las $next_probe_hms"
            echo "[$(date +%H:%M:%S)][hold] $hold_family: esperando, proxima sonda $next_probe_hms (techo $deadline_hm)" >> "$EVENTS_LOG_ABS"

            # --- Reanudacion de sesion para el proximo intento (issue #968, CA-3/CA-4) ---
            # Degrada a "stage desde cero" (deja RESUME_SESSION_ID vacio) en
            # EXACTAMENTE tres casos -- fuera de ellos, el comportamiento es
            # el mismo de antes de este issue. Cada caso deja un aviso
            # explicito que nombra el motivo (CA-4).
            if [ "$RESUME_DEGRADED" = false ]; then
                if [ "$attempt_used_resume" = true ] && [ ! -s "$SUMMARY_FILE" ]; then
                    # Caso (c): la sesion reanudada volvio a morir a mitad de
                    # vuelo sin dejar el resumen del stage -- degradado de
                    # forma PERMANENTE para el resto de esta corrida: insistir
                    # con un id que ya murio dos veces sin evidencia de avance
                    # no tiene respaldo, y --resume-session/--fork-session NO
                    # se usan para bifurcar a un id nuevo (notas tecnicas de
                    # #968: reusar el id original es lo que da trazabilidad).
                    warn "$agent: la sesion reanudada ($RESUME_SESSION_ID) volvio a morir sin dejar el resumen del stage -- se degrada a stage desde cero"
                    echo "[$(date +%H:%M:%S)][hold][resume] $agent: sesion $RESUME_SESSION_ID murio de nuevo sin resumen -- degradado a stage desde cero (CA-4c)" >> "$EVENTS_LOG_ABS"
                    RESUME_DEGRADED=true
                    RESUME_SESSION_ID=""
                elif [ -z "$RESUME_SESSION_ID" ]; then
                    local candidate_session_id
                    candidate_session_id=$(agent_events_session_id "$events_file")
                    if [ -z "$candidate_session_id" ]; then
                        # Caso (a): el terminal del intento muerto no trajo session_id.
                        warn "$agent: el intento fallido no dejo session_id en el terminal -- se reintenta sin reanudar"
                        echo "[$(date +%H:%M:%S)][hold][resume] $agent: sin session_id en el terminal -- reintento sin reanudar (CA-4a)" >> "$EVENTS_LOG_ABS"
                    elif ! runtime_supports_resume "$MEFISTO_RUNTIME_RESUELTO"; then
                        # Caso (b): el adaptador del runtime activo no soporta reanudacion.
                        warn "$agent: el runtime '$MEFISTO_RUNTIME_RESUELTO' no soporta reanudacion -- se reintenta sin reanudar"
                        echo "[$(date +%H:%M:%S)][hold][resume] $agent: runtime '$MEFISTO_RUNTIME_RESUELTO' sin soporte de reanudacion -- reintento sin reanudar (CA-4b)" >> "$EVENTS_LOG_ABS"
                    else
                        RESUME_SESSION_ID="$candidate_session_id"
                        RESUMED_ANY=true
                        local RESUME_PROMPT_TEXT="Tu sesion anterior en este mismo stage (stage ${stage}, agente ${agent}) se corto por un limite de uso del proveedor -- el pipeline ya espero (hold) a que se restableciera. Estas reanudando esa MISMA sesion: tu memoria de trabajo, lo que ya leiste y lo que ya escribiste sigue disponible.

Continua exactamente donde quedaste. No reinicies tu analisis desde cero, no releas archivos que ya revisaste ni repitas ediciones ya hechas.

Termina tu contrato del stage, incluido dejar escrito (o completar si quedo a medias) el resumen en .mefisto/pipeline/summaries/stage-${stage}-${agent}.md. Si ese archivo ya existe completo, dejalo como esta; si no, escribelo ahora y agrega una linea que diga que esta sesion se reanudo tras una espera por limite de uso del proveedor.

CONTEXTO DE EJECUCION (sigue vigente): modo no-interactivo, sin humano al otro lado. PROHIBIDO hacer 'git push' o 'gh pr create': eso sigue siendo responsabilidad exclusiva del pipeline."
                        printf '%s' "$RESUME_PROMPT_TEXT" > "$RESUME_PROMPT_FILE"
                        log "$agent: reanudando sesion $RESUME_SESSION_ID en el proximo intento (hold)"
                        echo "[$(date +%H:%M:%S)][hold][resume] $agent: reanudando sesion $RESUME_SESSION_ID" >> "$EVENTS_LOG_ABS"
                    fi
                fi
            fi

            # CA-5: a diferencia del reintento corto de arriba, el hold NUNCA
            # restaura el worktree a $ENTRY_COMMIT -- la reanudacion de sesion
            # de arriba se apoya justamente en el trabajo que dejo el stage
            # truncado, y aunque no se pueda reanudar (CA-4) el reintento
            # sigue corriendo sobre ese mismo estado, nunca uno restaurado.
            sleep "$hold_sleep"
            HOLD_TOTAL_SECONDS=$(( HOLD_TOTAL_SECONDS + hold_sleep ))
        else
            break
        fi
    done

    # El terminal neutral puede revelar el modelo efectivo incluso cuando el
    # stage fallo. La observacion es best-effort y no cambia ese desenlace.
    log_effective_stage_model "$stage" "$agent" "$AGENT_MODEL" "$metrics_json"

    # El wall-clock del stage incluye todos los intentos y sus esperas: es lo
    # que de verdad costo, y es lo que se reporta al historial.
    local total_elapsed=$(( $(date +%s) - start_ts ))

    if [ -n "$failure_type" ]; then
        log "$agent fallo despues de ${elapsed}s -- tipo: $failure_type"
        echo "[$(date +%H:%M:%S)] FALLO $agent: $failure_type" >> "$EVENTS_LOG_ABS"
        # CA-2 (#967): si el fallo llega tras agotar el techo de espera, se
        # nombra cuanto se espero -- distingue este aborto de uno ordinario
        # sin obligar a bucear en events.log.
        [ "$HOLD_TOTAL_SECONDS" -gt 0 ] \
            && log "$agent: techo de espera (hold) agotado tras $((HOLD_ELAPSED_SECONDS / 60))m $((HOLD_ELAPSED_SECONDS % 60))s -- ultima senal: $failure_type"

        # CA-4: un TIMEOUT o un corte de stream a mitad de respuesta nunca es
        # recuperable via has_work -- el incidente de #416 fue justo esto (el
        # reviewer murio con "API Error: Connection closed mid-response" y el
        # pipeline abrio igual el PR con una revision truncada a mitad de frase).
        # PR #446: la traza entra como cuarto argumento -- un `result` de
        # exito en ella exime al stage de esa regla (la muerte fue posterior al
        # trabajo), sin saltarse los gates de agent_work_is_trustworthy.
        local UNRECOVERABLE=false
        if agent_failure_is_unrecoverable "$TIMED_OUT" "$RUN_EXIT" "$events_file"; then
            UNRECOVERABLE=true
        fi

        # CA-5: para el resto de fallos, has_work exige ademas que el resumen
        # de stage exista y no este vacio -- evidencia de que el agente llego
        # al final de su contrato (ver agent_work_is_trustworthy). SUMMARY_FILE
        # ya se calculo antes del bucle de reintento (issue #968: el caso (c)
        # de la reanudacion de sesion necesita comprobarla dentro del hold).

        if agent_work_is_trustworthy "$WORKTREE_PATH" "${SNAPSHOT_COMMIT:-HEAD}" "$UNRECOVERABLE" "$SUMMARY_FILE"; then
            warn "$agent: CLI retorno error ($failure_type) pero hay trabajo util -- continuando"
            echo "[$(date +%H:%M:%S)] RECUPERADO $agent: trabajo util detectado" >> "$EVENTS_LOG_ABS"
        else
            case "$agent" in
                writer)   AGENT_WR_DUR=$total_elapsed; AGENT_WR_RES="failed" ;;
                reviewer) AGENT_RV_DUR=$total_elapsed; AGENT_RV_RES="failed" ;;
            esac
            # Las metricas se cosechan por STAGE, no por agente: el stage de
            # resolucion de conflictos corre como `run_agent "merge" "writer"`,
            # asi que un case por "$agent" haria que un merge fallido pisara
            # las metricas del writer de stage 1 y el historial reportara,
            # bajo agents.writer.metrics, los turnos y tokens de otro stage.
            # Las del merge no se pierden: quedan en su propio archivo
            # metrics/...-stage-merge-writer.json (CA-1).
            case "$stage" in
                1) AGENT_WR_METRICS_JSON="$metrics_json" ;;
                2) AGENT_RV_METRICS_JSON="$metrics_json" ;;
            esac
            update_status "$stage-$agent" "failed"
            echo -e "\n${RED}-- Ultimas lineas del log de $agent:${NC}"
            tail -20 "$log_stage"
            # CA-2 (#967): mensaje de aborto especifico cuando la causa fue el
            # techo de espera agotado -- nombra cuanto espero y la ultima
            # senal, en vez del mensaje generico de cualquier otro fallo.
            if [ "$HOLD_TOTAL_SECONDS" -gt 0 ]; then
                abort "$agent: techo de espera agotado tras $((HOLD_ELAPSED_SECONDS / 60))m $((HOLD_ELAPSED_SECONDS % 60))s (limite ${HOLD_MAX_SECONDS}s) -- ultima senal: $failure_type. Log completo: $log_stage"
            else
                abort "$agent fallo ($failure_type). Log completo: $log_stage"
            fi
        fi
    fi

    LAST_AGENT_DURATION=$total_elapsed
    LAST_AGENT_METRICS_JSON="$metrics_json"
    LAST_AGENT_HOLD_SECONDS=$HOLD_TOTAL_SECONDS
    LAST_AGENT_RESUMED=$RESUMED_ANY
    if [ "$HOLD_TOTAL_SECONDS" -gt 0 ]; then
        # CA-6: un stage que se recupera tras esperar termina como exito
        # normal -- esta linea es la unica diferencia visible, y es lo que
        # distingue una corrida lenta por hold de una corrida lenta a secas.
        log "$agent completado en ${total_elapsed}s (incluye $((HOLD_TOTAL_SECONDS / 60))m $((HOLD_TOTAL_SECONDS % 60))s en espera/hold)"
    elif [ "$attempt" -gt 1 ]; then
        log "$agent completado en ${total_elapsed}s (intento $attempt/$MAX_ATTEMPTS; ${elapsed}s el ultimo)"
    else
        log "$agent completado en ${total_elapsed}s"
    fi

    # CA-6 (issue #968): rastro explicito de que este stage reanudo al menos
    # una sesion truncada -- para que un post-mortem lo distinga de un stage
    # que solo espero (hold) sin reanudar (los tres casos de degradacion de
    # CA-4, o un hold que se resolvio al primer intento sin fallar de nuevo).
    if [ "$RESUMED_ANY" = true ]; then
        log "$agent: la corrida reanudo al menos una sesion truncada por espera (hold, issue #968)"
        echo "[$(date +%H:%M:%S)][hold][resume] $agent: stage completado tras reanudar sesion" >> "$EVENTS_LOG_ABS"
    fi
}

# --- Funcion auxiliar: auto-commit de seguridad (solo paths del scope de Mefisto) ---
auto_commit_if_needed() {
    local phase="$1"
    local msg="$2"

    # changelog.d/ va en la lista (issue #380): desde el gate de fragmentos, el
    # fragmento es lo UNICO que acredita el cambio notable, y el gate lo da por
    # bueno viendolo tambien en el working tree. Si el auto-commit no lo stagea,
    # el gate pasa pero el fragmento no entra al PR y /mefisto-release no tiene
    # nada que consolidar: la anotacion se perderia en silencio.
    #
    # .claude/settings.json va en la lista (issue #523): sin ella, un writer
    # que cree o edite el archivo de hooks confiando en el auto-commit (en vez
    # de comitearlo el mismo) lo dejaria sin stagear -- `git push` solo manda
    # commits, asi que el archivo nunca llegaria al PR. El pipeline ya no
    # inyecta ni revierte este archivo (ver el bloque de creacion del
    # worktree), asi que lo unico que puede aparecer aqui es una edicion
    # legitima del agente.
    # src/internal/ y AGENTS.md se registraron en #852 (MEF-ADR-0049); src/published/,
    # src/runtime/ y dist/ se registran en #1043 (MEF-ADR-0053). Todas estas
    # entradas respetan la secuencia de MEF-ADR-0019 seccion E; ver
    # is_path_in_mefisto_scope (_mefisto-common.sh) para el detalle.
    # LICENSE y NOTICE (entradas EXACTAS de la raiz) se registraron en #2230
    local paths="commands/ agents/ scripts/ hooks/ docs/ .claude-plugin/ .claude/commands/ .claude/agents/ .claude/scripts/ .claude/mods/ .claude/settings.json changelog.d/ src/internal/ src/published/ src/runtime/ dist/ AGENTS.md README.md CHANGELOG.md CLAUDE.md .gitignore .gitattributes LICENSE NOTICE"

    if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- $paths 2>/dev/null)" ]; then
        log "Haciendo commit automatico (fase $phase)..."
        for dir in $paths; do
            git -C "$WORKTREE_PATH" add "$dir" 2>/dev/null || true
        done
        git -C "$WORKTREE_PATH" commit -m "$msg" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || true
    fi
}

# --- Funcion auxiliar: gate de neutralidad de runtime (MEF-ADR-0049, issue #914) ---
# Se invoca tras el gate de scope y antes de auto_commit_if_needed, misma
# degradacion que ese gate (CA-1): aborta el stage con la lista de violaciones
# "<ruta>:<linea>: <regla>" que ya imprime el propio mefisto-neutrality-gate.sh
# y el comando de retoma --from-stage. Se carga SIEMPRE desde $SCRIPT_DIR (el
# checkout principal, nunca el worktree -- MEF-ADR-0019 seccion E: el PR bajo
# revision no puede alterar el gate que lo juzga) y escanea el arbol del
# worktree via --root. Una corrida limpia no imprime mas que la linea de exito.
#
# Antes de abortar (issue #1473), el mismo rol recibe la salida cruda del gate
# mas su remedio por regla y tiene EXACTAMENTE un intento acotado de corregir
# la fuga (run_agent "<stage>-fix" <rol> ...) -- sin variable de entorno ni
# flag que amplie ese numero: las fugas reales de #1416/#1439 eran una linea de
# prosa cuyo arreglo cuesta un turno de agente, y abortar la corrida entera de
# una perdia todo el trabajo del stage. Si el intento no la elimina, se aborta
# exactamente como antes de este issue.
run_neutrality_gate() {
    local stage="$1" role="$2"
    local out

    # El gate escanea git ls-files (universo VERSIONADO -- CA-3/CA-1 de
    # mefisto-neutrality-gate.sh, issue #911), a diferencia de
    # validate_mefisto_scope_changes (que ya lee tambien el working tree sucio
    # con `git status --untracked-files=all`, y ya se corrio en verde justo
    # antes que esta funcion). Un archivo nuevo del writer/reviewer que aun no
    # este ni siquiera staged seria invisible para `git ls-files` y el gate
    # pasaria en falso a pesar de la fuga -- `git add -A` staguea (sin
    # commitear) el mismo universo que el gate de scope ya valido como
    # permitido, para que ambos vean el mismo estado. auto_commit_if_needed,
    # justo despues, sigue siendo quien decide si hay algo que commitear.
    git -C "$WORKTREE_PATH" add -A >/dev/null 2>&1 || true

    if out="$("$SCRIPT_DIR/mefisto-neutrality-gate.sh" --root "$WORKTREE_PATH" 2>&1)"; then
        success "Gate de neutralidad: sin fugas"
        return 0
    fi
    # Remedio por regla (issue #1469): mefisto_neutrality_remedy antepone
    # "reformula la mencion" como primera opcion para R1-R3, y solo nombra la
    # allowlist como ultimo recurso -- sustituye la vieja linea unica de "dos
    # PRs" que se ofrecia siempre, incluso cuando la fuga era una mencion de
    # coste cero en prosa.
    local remedy
    remedy="$(echo "$out" | mefisto_neutrality_remedy)"

    local leak_count
    leak_count=$(printf '%s\n' "$out" | awk 'NF{c++} END{print c+0}')
    warn "$role: $leak_count violacion(es) de neutralidad -- intento de correccion"
    echo "[$(date +%H:%M:%S)] [neutralidad][fix] $role: $leak_count violacion(es), intento de correccion" >> "$EVENTS_LOG_ABS"

    local FIX_PROMPT="Estas en el worktree de un stage de tooling del repo de Mefisto (${MEFISTO_PROJECT_NAME}) ya en curso (issue #$ISSUE_NUM).

El gate de neutralidad de runtime (MEF-ADR-0049) encontro la(s) siguiente(s) fuga(s) al cierre de este stage, en el trabajo que acabas de dejar:

$out

Remedio por regla:
$remedy

Tu tarea: corrige EXACTAMENTE esas lineas, y solo esas. No reformules nada que el gate no haya senalado, no toques src/internal/contract/neutrality-allowlist.json (registrar una excepcion ahi es un PR previo y distinto, ver MEF-ADR-0019 seccion E) y no cambies ninguna regla del propio gate. Cuando termines, deja la correccion comiteada con un mensaje descriptivo.

Este es el UNICO intento de correccion: si el gate sigue en rojo despues de ti, el stage aborta y se pierde todo el trabajo de la corrida. Relee lo que escribas antes de cerrarlo.

$NEUTRALITY_RUNTIME_BLOCK

CONTEXTO DE EJECUCION: modo no-interactivo, sin humano al otro lado. Nadie puede aprobar, confirmar ni responder preguntas. PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso sigue siendo responsabilidad exclusiva del pipeline, nunca tuya."

    # CA-3: LAST_AGENT_* deben seguir reflejando la corrida PRINCIPAL de este
    # rol -- la que el bloque de Stage 1/2 lee justo despues de este gate --,
    # asi que se guardan antes del intento y se restauran despues: un segundo
    # run_agent (el del intento) las pisaria si no.
    local SAVED_LAST_AGENT_DURATION="$LAST_AGENT_DURATION"
    local SAVED_LAST_AGENT_METRICS_JSON="$LAST_AGENT_METRICS_JSON"
    local SAVED_LAST_AGENT_HOLD_SECONDS="$LAST_AGENT_HOLD_SECONDS"
    local SAVED_LAST_AGENT_RESUMED="$LAST_AGENT_RESUMED"

    local fix_start_ts fix_elapsed
    fix_start_ts=$(date +%s)
    run_agent "${stage}-fix" "$role" "$FIX_PROMPT"
    fix_elapsed=$(( $(date +%s) - fix_start_ts ))
    echo "[$(date +%H:%M:%S)] [neutralidad][fix] $role: ${fix_elapsed}s" >> "$EVENTS_LOG_ABS"

    LAST_AGENT_DURATION="$SAVED_LAST_AGENT_DURATION"
    LAST_AGENT_METRICS_JSON="$SAVED_LAST_AGENT_METRICS_JSON"
    LAST_AGENT_HOLD_SECONDS="$SAVED_LAST_AGENT_HOLD_SECONDS"
    LAST_AGENT_RESUMED="$SAVED_LAST_AGENT_RESUMED"

    # CA-2: mismo orden que el cierre normal del stage -- scope primero, gate
    # despues (con el mismo `git add -A` previo).
    if ! validate_mefisto_scope_changes "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"; then
        abort "Stage $stage fallido: el intento de correccion de neutralidad ($role) toco archivos fuera del scope de Mefisto."
    fi

    git -C "$WORKTREE_PATH" add -A >/dev/null 2>&1 || true

    if out="$("$SCRIPT_DIR/mefisto-neutrality-gate.sh" --root "$WORKTREE_PATH" 2>&1)"; then
        success "$role: fuga de neutralidad corregida"
        echo "[$(date +%H:%M:%S)] [neutralidad][fix] $role: corregido" >> "$EVENTS_LOG_ABS"
        return 0
    fi

    remedy="$(echo "$out" | mefisto_neutrality_remedy)"
    echo "[$(date +%H:%M:%S)] [neutralidad][fix] $role: persiste" >> "$EVENTS_LOG_ABS"
    abort "El intento de correccion de neutralidad ya fallo -- la fuga persiste. Stage $stage fallido: el $role dejo fuga(s) de neutralidad de runtime (MEF-ADR-0049):
$out
$remedy
Corrige las fugas en el worktree ($WORKTREE_PATH) y retoma con:
  ./.claude/scripts/mefisto-tooling-pipeline.sh $ISSUE_NUM --from-stage $stage${VARIANT_LABEL:+ --variant $VARIANT_LABEL}"
}

# --- Bloque compartido: doctrina de neutralidad de runtime (issue #1468) ---
# Se define UNA sola vez y se interpola sin cambios en STAGE1_PROMPT y
# STAGE2_PROMPT para que no diverja entre los dos prompts. Este archivo vive
# bajo src/internal/scripts/, sujeto a las mismas reglas R1-R3 que describe
# -- por eso el bloque no nombra ninguno de los literales que persigue cada
# regla, solo los describe por categoria y remite a la cabecera del gate y a
# MEF-ADR-0050. No contiene "$", asi que se interpola por expansion normal de
# variable (a diferencia de $ISSUE_CONTEXT, que usa sustitucion tardia).
NEUTRALITY_RUNTIME_BLOCK="NEUTRALIDAD DE RUNTIME:
Un gate de cierre de stage (reglas R1-R3 de src/internal/scripts/mefisto-neutrality-gate.sh) escanea src/internal/** y los scripts de nivel superior de .claude/scripts/ con grep sobre texto crudo: mencionar un literal prohibido en un comentario, un string o en prosa cuenta igual que usarlo, incluso cuando la frase lo niega o lo desaconseja. Una sola fuga aborta la corrida entera al cierre del stage y se pierde todo el trabajo hecho hasta ahi, asi que revisa el texto que escribes antes de darlo por cerrado. La lista exacta de literales por regla esta en la cabecera de ese script -- R1: alias/ids de modelo y claves de permiso crudas de un runtime concreto; R2: invocaciones directas del CLI de un runtime concreto; R3: rutas y variables de entorno propias de un runtime concreto. Los pocos archivos que hoy los nombran pasan por una excepcion nominal en src/internal/contract/neutrality-allowlist.json, con un motivo que justifica por que esa mencion es correcta y permanente en ese archivo puntual; su fraseo no es un patron replicable en un archivo nuevo. Para referirte a cualquiera de esos conceptos en prosa neutral, cita MEF-ADR-0050 (nunca con variables de entorno ni rutas de un runtime concreto). No resuelvas una fuga anadiendo una excepcion nueva a esa allowlist: registrar una excepcion nueva y usarla son dos PRs distintos, y este no es el de registro (MEF-ADR-0019 seccion E)."

# --- STAGE 1: Writer (implementacion) ---
if [ "$FROM_STAGE" -le 1 ]; then
    header "Stage 1: Writer (implementacion)"

    STAGE1_PROMPT="Estas en el directorio raiz del repo de Mefisto (${MEFISTO_PROJECT_NAME}), un Claude Code Plugin para proyectos .NET serverless en Azure.

Contexto de la tarea de tooling a implementar:

\$ISSUE_CONTEXT

Tu tarea: implementa lo descrito en el issue. Esto es una tarea de TOOLING sobre el propio plugin Mefisto: skills (en commands/), agentes (en agents/), pipelines bash (en scripts/), hooks (en hooks/), ADRs (en docs/adr/), metadata del plugin (.claude-plugin/), o equivalentes internos en .claude/{commands,agents,scripts}/.

ALCANCE DE ESCRITURA PERMITIDO:
- commands/        (skills publicados)
- agents/          (agentes publicados)
- scripts/         (pipelines bash publicados)
- hooks/           (hooks publicados)
- docs/            (ADRs, testing, field-notes, cheatsheets)
- .claude-plugin/  (plugin.json, marketplace.json)
- .claude/commands/, .claude/agents/, .claude/scripts/  (skills/agentes/pipelines INTERNOS de Mefisto)
- .claude/mods/  (mods de Claude Code del propio Mefisto, MEF-ADR-0055)
- .claude/settings.json  (hooks del pipeline interno; entrada EXACTA, no toda .claude/)
- src/internal/  (layout interno de runtime/proveedor neutral, MEF-ADR-0049; src/ fuera de internal/ sigue fuera de scope)
- src/published/, src/runtime/, dist/  (layout publicado multi-runtime de MEF-ADR-0053; registrado antes de poblarlo)
- AGENTS.md  (doctrina canonica neutral; entrada EXACTA de la raiz, MEF-ADR-0049)
- changelog.d/  (fragmentos de CHANGELOG e indice de ADRs, ver instruccion 5 abajo)
- README.md, CHANGELOG.md, CLAUDE.md, .gitignore, .gitattributes, LICENSE, NOTICE  (gobierno del repo)

Si el issue requiere escribir en una ruta o tipo de artefacto que NO esta en el listado anterior, verifica antes la allowlist autoritativa: la funcion is_path_in_mefisto_scope de src/internal/scripts/lib/_mefisto-common.sh, tal como esta en main (.claude/scripts/_mefisto-common.sh es solo el shim que la sourcea). Es la que el gate del pipeline evalua, y el listado de arriba puede quedarse corto frente a ella. Si la ruta tampoco esta ahi, NO intentes crear archivos en ella aunque el issue lo describa: primero hace falta un PR que la registre en los gates de scope/changelog (ver MEF-ADR-0019, seccion E -- registrar una ruta y usarla son dos PRs distintos, el de registro va primero y no crea archivos bajo la ruta que registra). Reporta ese bloqueo en tu resumen de stage 1 para que el PR de registro se abra antes de continuar con este issue.

NO MODIFIQUES NADA FUERA DE ESE SCOPE. Mefisto no tiene tests/ ni infra/; src/ fuera de internal/, published/ y runtime/ sigue fuera de scope.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). No hay un humano al otro lado.
- Nadie puede aprobar, confirmar ni responder preguntas.
- DEBES usar las herramientas Write y Edit directamente.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Tienes permisos completos (bypassPermissions activo).
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~13 s de reloj (el 96,6% del tiempo de una corrida es el modelo escribiendo tokens, no las herramientas ejecutandose). El presupuesto completo del stage es ${MEFISTO_AGENT_TIMEOUT_SECONDS} s. Lo caro suele ser el turno, pero los tests tambien consumen ese presupuesto. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una: hoy el 82% de los turnos del pipeline gasta una sola tool call, y cada una de esas cadenas paga 13 s por eslabon.
- Al cerrar, corre UNA vez scripts/tests/test-guards.sh y los tests de scripts/tests/, src/published/scripts/tests/ y .claude/scripts/tests/ cuyo nombre o contenido mencione los archivos que tocaste (busca con grep -l). scripts/tests/<x>.sh puede ser un shim de src/published/scripts/tests/<x>.sh: corre un solo archivo por suite (el shim si existe, o el de src/published/ directo si no), sin duplicarla. No corras la suite completa dentro de este stage: el presupuesto (${MEFISTO_AGENT_TIMEOUT_SECONDS} s) no la cubre. Si alguien fuera de este stage necesita la regresion completa, el destino es .claude/scripts/mefisto-test-suite.sh, no un bucle propio.
- No re-inspecciones el arbol con 'git status' ni 'git diff' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
- No verifiques el scope de un archivo antes de escribirlo (ni con 'git status' ni releyendo is_path_in_mefisto_scope): un hook PostToolUse te avisa EN EL INSTANTE, gratis, si un Edit/Write cae fuera de la allowlist -- no hay motivo para inspeccionar preventivamente algo que el hook ya te va a decir si sale mal. Eso no reemplaza los gates finales (validate_mefisto_scope_changes y mefisto-neutrality-gate.sh siguen corriendo al cierre del stage): el hook es aviso temprano, no el juez.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~13 s, y solo vale la pena si te ahorra un error que costaria mas.

${NEUTRALITY_RUNTIME_BLOCK}

Instrucciones:
1. Lee los archivos existentes relevantes antes de escribir nuevos.
2. Reutiliza patrones y convenciones del repo (mira archivos similares).
3. Haz commits frecuentes con mensajes descriptivos en espanol.
4. Si modificaste un skill o agente publicado, considera si necesitas tambien la version interna (con prefijo mefisto-).
5. Anota el cambio como FRAGMENTO en changelog.d/ (issue #380): NUNCA edites CHANGELOG.md ni la tabla \"Indice tematico\" de CLAUDE.md directamente -- son archivos-indice compartidos que /mefisto-release consolida en su propia rama de release, no cada PR (editarlos por-issue es exactamente la contencion que este mecanismo elimina). En su lugar:
   - Crea 'changelog.d/${ISSUE_NUM}.<categoria>.md' con una o mas lineas '- texto de la entrada' en estilo Keep a Changelog, donde <categoria> es 'added' (funcionalidad nueva), 'changed' (cambio de comportamiento), 'fixed' (bug) o 'removed' (eliminacion).
   - Si el issue anade o enmienda un ADR (docs/adr/), crea ademas 'changelog.d/${ISSUE_NUM}.adr-index.md' con la fila '| <Tema del ADR> | MEF-ADR-XXXX |' lista para insertarse en la tabla de indice de CLAUDE.md.
   - Ve changelog.d/README.md para el formato completo y ejemplos.
   Excepcion: si el cambio toca exclusivamente bitacora (docs/bitacora/**) u otros archivos de gobierno no notables (README.md, CLAUDE.md, .gitignore), omite el fragmento. Un gate del pipeline aborta el PR si un cambio notable llega sin fragmento en changelog.d/.
6. Al terminar, escribe un resumen de lo que hiciste en .mefisto/pipeline/summaries/stage-1-writer.md"

    # Sustituir $ISSUE_CONTEXT manualmente (evita expansion temprana en la heredoc)
    STAGE1_PROMPT="${STAGE1_PROMPT//\$ISSUE_CONTEXT/$ISSUE_CONTEXT}"

    run_agent "1" "writer" "$STAGE1_PROMPT"

    # Validar que genero cambios reales
    HAS_COMMITS=false
    HAS_UNSTAGED=false
    if ! git -C "$WORKTREE_PATH" diff --quiet "$SNAPSHOT_COMMIT" HEAD 2>/dev/null; then
        HAS_COMMITS=true
    fi
    if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- commands/ agents/ scripts/ hooks/ docs/ .claude-plugin/ .claude/commands/ .claude/agents/ .claude/scripts/ .claude/settings.json changelog.d/ src/internal/ src/published/ src/runtime/ dist/ AGENTS.md README.md CHANGELOG.md CLAUDE.md .gitignore .gitattributes LICENSE NOTICE 2>/dev/null)" ]; then
        HAS_UNSTAGED=true
    fi
    if [ "$HAS_COMMITS" = false ] && [ "$HAS_UNSTAGED" = false ]; then
        abort "El writer no genero ningun cambio. Revisa el log: $LOG_DIR_ABS/mefisto-tooling-stage-1-writer-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}.log"
    fi

    # Gate de scope: rechazar cambios fuera del alcance del repo de Mefisto
    if ! validate_mefisto_scope_changes "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"; then
        abort "Stage 1 fallido: el writer toco archivos fuera del scope de Mefisto."
    fi

    run_neutrality_gate 1 writer

    auto_commit_if_needed "writer" "mefisto-tooling(#${ISSUE_NUM}): implementacion"

    AGENT_WR_DUR=$LAST_AGENT_DURATION
    AGENT_WR_METRICS_JSON=$LAST_AGENT_METRICS_JSON
    AGENT_WR_HOLD_SECONDS=$LAST_AGENT_HOLD_SECONDS
    AGENT_WR_RESUMED=$LAST_AGENT_RESUMED
    AGENT_WR_RES="passed"
    update_status "1-writer" "passed"
    success "Stage 1 completado"
fi

# --- STAGE 2: Reviewer (revision) ---
if [ "$FROM_STAGE" -le 2 ]; then
    header "Stage 2: Reviewer (revision)"

    # Contexto acotado del reviewer (issue #1449): en vez del diff completo
    # (podia superar ARG_MAX y desperdiciar contexto, ver #1407/#1447), se le
    # pasan solo los SHA, el --stat y las rutas cambiadas. El diff completo
    # sigue disponible en el worktree; el reviewer lo pide por archivo cuando
    # lo necesita.
    WRITER_HEAD_SHA=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
    DIFF_STAT=$(git -C "$WORKTREE_PATH" diff --stat=120 "$SNAPSHOT_COMMIT"..HEAD)
    DIFF_NAME_STATUS=$(git -C "$WORKTREE_PATH" diff --name-status "$SNAPSHOT_COMMIT"..HEAD)

    STAGE2_PROMPT="Estas en el directorio raiz del repo de Mefisto (${MEFISTO_PROJECT_NAME}).

Contexto de la tarea:

\$ISSUE_CONTEXT

Cambios del writer:

Commit base: ${SNAPSHOT_COMMIT}
HEAD del writer: ${WRITER_HEAD_SHA}

Resumen (git diff --stat=120 ${SNAPSHOT_COMMIT}..HEAD):

\$DIFF_STAT

Rutas cambiadas (git diff --name-status ${SNAPSHOT_COMMIT}..HEAD):

\$DIFF_NAME_STATUS

Tu tarea: revisa la calidad de los cambios producidos por el writer.

ALCANCE DE ESCRITURA PERMITIDO (igual al del writer):
commands/, agents/, scripts/, hooks/, docs/, .claude-plugin/,
.claude/commands/, .claude/agents/, .claude/scripts/, .claude/mods/, .claude/settings.json,
src/internal/, src/published/, src/runtime/, dist/,
AGENTS.md, changelog.d/, README.md, CHANGELOG.md, CLAUDE.md, .gitignore, .gitattributes, LICENSE, NOTICE.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). DEBES usar Write/Edit directamente.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Tienes permisos completos (bypassPermissions activo).
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~13 s de reloj (el 96,6% del tiempo de una corrida es el modelo escribiendo tokens, no las herramientas ejecutandose). El presupuesto completo del stage es ${MEFISTO_AGENT_TIMEOUT_SECONDS} s. Lo caro suele ser el turno, pero los tests tambien consumen ese presupuesto. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una: hoy el 82% de los turnos del pipeline gasta una sola tool call, y cada una de esas cadenas paga 13 s por eslabon.
- Al cerrar, corre UNA vez scripts/tests/test-guards.sh y los tests de scripts/tests/, src/published/scripts/tests/ y .claude/scripts/tests/ cuyo nombre o contenido mencione los archivos que tocaste (busca con grep -l). scripts/tests/<x>.sh puede ser un shim de src/published/scripts/tests/<x>.sh: corre un solo archivo por suite (el shim si existe, o el de src/published/ directo si no), sin duplicarla. No corras la suite completa dentro de este stage: el presupuesto (${MEFISTO_AGENT_TIMEOUT_SECONDS} s) no la cubre. Si alguien fuera de este stage necesita la regresion completa, el destino es .claude/scripts/mefisto-test-suite.sh, no un bucle propio.
- Ya tienes el commit base, el HEAD del writer, el --stat y las rutas cambiadas aqui arriba: para ver el diff de una ruta puntual pidelo bajo demanda con 'git diff ${SNAPSHOT_COMMIT}..HEAD -- <ruta>' (o 'git show <sha>' para inspeccionar un commit), agrupando varias rutas en el mismo turno si necesitas mas de una. No re-inspecciones el arbol con 'git status' para confirmar algo que acabas de escribir -- Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
- No verifiques el scope de un archivo antes de escribirlo: un hook PostToolUse te avisa EN EL INSTANTE, gratis, si un Edit/Write cae fuera de la allowlist -- no hay motivo para inspeccionar preventivamente algo que el hook ya te va a decir si sale mal. Eso no reemplaza los gates finales (validate_mefisto_scope_changes y mefisto-neutrality-gate.sh siguen corriendo al cierre del stage): el hook es aviso temprano, no el juez.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~13 s, y solo vale la pena si te ahorra un error que costaria mas.

${NEUTRALITY_RUNTIME_BLOCK}

Instrucciones:
1. Verifica que los cambios cumplen con lo pedido en el issue.
2. Revisa coherencia con las convenciones del proyecto (AGENTS.md, ADRs).
3. Revisa que los skills/agentes/pipelines modificados sigan los patrones del resto.
4. Corrige problemas que encuentres directamente (no solo los reportes).
5. Haz commit de tus correcciones con mensajes descriptivos.
6. Verifica que el diff del writer no introduce los literales que describe el bloque NEUTRALIDAD DE RUNTIME bajo src/internal/** ni en los scripts de nivel superior de .claude/scripts/; si aparecen, reformulalos tu mismo en esta misma revision -- nunca los reportes sin corregir ni propongas ampliar la allowlist.
7. Al terminar, escribe un resumen en .mefisto/pipeline/summaries/stage-2-reviewer.md"

    STAGE2_PROMPT="${STAGE2_PROMPT//\$ISSUE_CONTEXT/$ISSUE_CONTEXT}"
    STAGE2_PROMPT="${STAGE2_PROMPT//\$DIFF_STAT/$DIFF_STAT}"
    STAGE2_PROMPT="${STAGE2_PROMPT//\$DIFF_NAME_STATUS/$DIFF_NAME_STATUS}"

    run_agent "2" "reviewer" "$STAGE2_PROMPT"

    # Re-validar scope despues del reviewer
    if ! validate_mefisto_scope_changes "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"; then
        abort "Stage 2 fallido: el reviewer toco archivos fuera del scope de Mefisto."
    fi

    run_neutrality_gate 2 reviewer

    auto_commit_if_needed "reviewer" "mefisto-tooling(#${ISSUE_NUM}): revision y correcciones"

    AGENT_RV_DUR=$LAST_AGENT_DURATION
    AGENT_RV_METRICS_JSON=$LAST_AGENT_METRICS_JSON
    AGENT_RV_HOLD_SECONDS=$LAST_AGENT_HOLD_SECONDS
    AGENT_RV_RESUMED=$LAST_AGENT_RESUMED
    AGENT_RV_RES="passed"
    update_status "2-reviewer" "passed"
    success "Stage 2 completado"
fi

# --- Verificar que hay commits ---
COMMITS_LIST=$(git -C "$WORKTREE_PATH" log "${SNAPSHOT_COMMIT}..HEAD" --oneline)
if [ -z "$COMMITS_LIST" ]; then
    abort "No hay commits en la rama $BRANCH_NAME."
fi

# --- Gate de fragmentos de CHANGELOG (changelog.d/, issue #380) ---
# Reemplaza el gate cinturon+tirantes sobre CHANGELOG.md (issue #70) que exigia
# editar directamente '## [Unreleased]': esa edicion por-PR era el punto de
# contencion (varios PRs tocando las mismas pocas lineas de un archivo-indice
# compartido) que este mecanismo elimina. Ahora el gate exige un FRAGMENTO
# propio en changelog.d/ -- CHANGELOG.md y el indice de ADRs de CLAUDE.md dejan
# de ser rutas editadas por-issue; los consolida /mefisto-release en su propia
# rama de release. Si todas las rutas tocadas son exentas (bitacora / gobierno
# no notable) no se exige fragmento y el gate pasa. Corre tras el reviewer
# (Stage 2) y antes de crear el PR.
header "Verificando fragmento de CHANGELOG (changelog.d/)"

if changelog_fragment_added "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"; then
    success "El PR anota su cambio como fragmento en changelog.d/"
elif ! changes_require_changelog "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"; then
    success "Cambio exento (solo bitacora/gobierno no notable): no se exige fragmento"
else
    abort "Cambio notable sin fragmento en changelog.d/.
El writer debio crear 'changelog.d/${ISSUE_NUM}.<categoria>.md' (added/changed/fixed/removed)
-- ver changelog.d/README.md para el formato. NUNCA se edita CHANGELOG.md directamente.
Crea el fragmento en el worktree ($WORKTREE_PATH) y retoma con:
  ./.claude/scripts/mefisto-tooling-pipeline.sh $ISSUE_NUM --from-stage 2${VARIANT_LABEL:+ --variant $VARIANT_LABEL}"
fi

# --- Sincronizar con main ---
header "Sincronizando con main"

log "Actualizando main desde origin..."
git -C "$WORKTREE_PATH" fetch origin main >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
    || abort "No se pudo hacer fetch de origin/main"

BEHIND_COUNT=$(git -C "$WORKTREE_PATH" rev-list HEAD..origin/main --count)
if [ "$BEHIND_COUNT" -eq 0 ]; then
    log "La rama ya esta al dia con main"
else
    log "main tiene $BEHIND_COUNT commit(s) nuevos. Haciendo merge..."

    if git -C "$WORKTREE_PATH" merge origin/main --no-edit >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1; then
        success "Merge automatico exitoso"
    else
        warn "Merge con conflictos. Resolviendo..."

        CONFLICT_FILES=$(git -C "$WORKTREE_PATH" diff --name-only --diff-filter=U)

        MERGE_PROMPT="Hay conflictos de merge con main en los siguientes archivos:
$CONFLICT_FILES

Resuelve los conflictos manteniendo tanto la funcionalidad nueva como la existente.
Despues de resolver cada archivo, haz git add. Cuando todos esten resueltos, haz git commit.
PROHIBIDO hacer 'git push' o 'gh pr create': eso es responsabilidad exclusiva del pipeline, nunca tuya."

        run_agent "merge" "writer" "$MERGE_PROMPT"

        REMAINING_CONFLICTS=$(git -C "$WORKTREE_PATH" diff --name-only --diff-filter=U 2>/dev/null || true)
        if [ -n "$REMAINING_CONFLICTS" ]; then
            abort "Aun quedan conflictos: $REMAINING_CONFLICTS. Revisa manualmente: cd $WORKTREE_PATH"
        fi
        success "Conflictos resueltos"
    fi
fi

# --- Crear PR (en modo variante: NO -- CA-3) ---
if [ -n "$VARIANT_LABEL" ]; then
    header "Modo variante: sin PR"
    warn "Variante '$VARIANT_LABEL': se omiten push, creacion de PR y comentario al issue (CA-3)."
    log "La rama '$BRANCH_NAME' queda LOCAL -- no se publica a origin."
    PR_URL=""
else
    header "Creando PR"

    log "Haciendo push de la rama..."
    git -C "$WORKTREE_PATH" push -u origin "$BRANCH_NAME" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
        || abort "No se pudo hacer push de la rama $BRANCH_NAME"

    log "Verificando si ya existe un PR abierto para la rama..."
    EXISTING_PR_URL=$(find_open_pr_for_branch "$BRANCH_NAME")

    RUN_METRICS_TABLE=$(render_run_metrics_table \
        "Writer" "${AGENT_WR_DUR:-}" "${AGENT_WR_METRICS_JSON:-}" \
        "Reviewer" "${AGENT_RV_DUR:-}" "${AGENT_RV_METRICS_JSON:-}")

    if [ -n "$EXISTING_PR_URL" ]; then
        PR_URL="$EXISTING_PR_URL"
        success "PR existente reutilizado: $PR_URL"
        RUN_METRICS_COMMENT=$(cat <<EOF
## Metricas de la corrida

Actualizado: $(date '+%Y-%m-%d %H:%M:%S %Z')

$RUN_METRICS_TABLE
EOF
)
        gh pr comment "$PR_URL" \
            --body "$RUN_METRICS_COMMENT" \
            >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || warn "No se pudo publicar las metricas en el PR reutilizado: $PR_URL"
    else
        if [ "$ISSUE_PR_REFERENCE" = "Refs" ]; then
            warn "El issue #$ISSUE_NUM tiene el label cierre:manual: el PR usara Refs y no cerrara el issue."
        fi
        log "Creando PR..."

        WR_SUMMARY=$(collect_summary "1" "writer")
        RV_SUMMARY=$(collect_summary "2" "reviewer")

        _fmt_dur() { local s="${1:-0}"; echo "$((s/60))m $((s%60))s"; }
        WR_DUR_FMT=$(_fmt_dur "${AGENT_WR_DUR:-0}")
        RV_DUR_FMT=$(_fmt_dur "${AGENT_RV_DUR:-0}")
        # CA-6 (#967): cuanto de esa duracion fue espera (hold), no trabajo,
        # y CA-6 (#968): si esa espera termino REANUDANDO la sesion truncada
        # en vez de repetir el stage desde cero. events.log registra las dos
        # cosas, pero muere con el worktree: el cuerpo del PR es el unico
        # resumen del stage que le queda a un post-mortem para distinguir un
        # stage limpio de uno esperado/reanudado.
        _hold_note() {
            local secs="${1:-0}" resumed="${2:-false}" parts=""
            [ "$secs" -gt 0 ] && parts="incluye $(_fmt_dur "$secs") en espera/hold"
            if [ "$resumed" = true ]; then
                [ -n "$parts" ] && parts="$parts; "
                parts="${parts}reanudo la sesion truncada"
            fi
            # `return 0` explicito: sin el, un stage SIN nota (el caso comun)
            # dejaria el ultimo `[ -n ... ]` en falso y la asignacion
            # `WR_HOLD_NOTE=$(_hold_note ...)` heredaria ese exit != 0 --
            # bajo `set -e` eso mata el pipeline justo antes de crear el PR.
            [ -n "$parts" ] && echo " ($parts)"
            return 0
        }
        WR_HOLD_NOTE=$(_hold_note "${AGENT_WR_HOLD_SECONDS:-0}" "${AGENT_WR_RESUMED:-false}")
        RV_HOLD_NOTE=$(_hold_note "${AGENT_RV_HOLD_SECONDS:-0}" "${AGENT_RV_RESUMED:-false}")

        PR_URL=$(gh pr create \
            --title "$ISSUE_TITLE" \
            --body "$(cat <<EOF
## Resumen

Pipeline mefisto-tooling completado:
- Writer: implementacion de la tarea
- Reviewer: revision de calidad

## Decisiones del pipeline

<details>
<summary>Writer -- ${WR_DUR_FMT}${WR_HOLD_NOTE}</summary>

${WR_SUMMARY}

</details>

<details>
<summary>Reviewer -- ${RV_DUR_FMT}${RV_HOLD_NOTE}</summary>

${RV_SUMMARY}

</details>

## Commits

$COMMITS_LIST

## Metricas de la corrida

$RUN_METRICS_TABLE

$ISSUE_PR_REFERENCE #$ISSUE_NUM
EOF
)" \
            --base main \
            --head "$BRANCH_NAME" \
            2>>"${LOG_FILE_ABS:-$LOG_FILE}") \
            || abort "No se pudo crear el PR"

        success "PR creado: $PR_URL"
    fi

    gh issue comment "$ISSUE_NUM" \
        --body "Pipeline mefisto-tooling completado. PR: $PR_URL$ISSUE_COMPLETION_NOTE" \
        >>"$LOG_FILE" 2>&1 || warn "No se pudo comentar en el issue #$ISSUE_NUM"
fi

PIPELINE_PR="$PR_URL"
update_status "done" "completed"

# Historial
# CA-2 (issue #426): agents.<agente>.metrics se agrega sin tocar "duration"
# -- si build_agents_history_json fallara por cualquier motivo, el fallback
# reproduce exactamente el formato plano que ya escribia esta linea (CA-5).
COMPLETED_AGENTS_JSON=$(build_agents_history_json "${AGENT_WR_DUR:-}" "${AGENT_WR_METRICS_JSON:-}" "${AGENT_RV_DUR:-}" "${AGENT_RV_METRICS_JSON:-}" 2>/dev/null) \
    || COMPLETED_AGENTS_JSON="{\"writer\":{\"duration\":${AGENT_WR_DUR:-null}},\"reviewer\":{\"duration\":${AGENT_RV_DUR:-null}}}"
PR_JSON="null"
[ -n "$PR_URL" ] && PR_JSON="\"$PR_URL\""
echo "{\"issue\":\"$ISSUE_NUM\",\"title\":\"$(echo "$ISSUE_TITLE" | sed 's/"/\\"/g')\",\"pipeline\":\"mefisto-tooling\",\"variant\":${VARIANT_LABEL_JSON:-null},\"runtime\":${MEFISTO_RUNTIME_JSON:-null},\"harness_version\":${HARNESS_VERSION_JSON:-null},\"harness_sha\":${HARNESS_SHA_JSON:-null},\"started\":\"$TIMESTAMP\",\"finished\":\"$(date +%Y-%m-%dT%H:%M:%S)\",\"state\":\"completed\",\"agents\":$COMPLETED_AGENTS_JSON,\"pr\":$PR_JSON}" \
    >> "$PIPELINE_DIR_ABS/pipeline-history.jsonl"

rm -f "$PIPELINE_DIR_ABS/$STATUS_FILENAME"

# --- Cleanup ---
header "Cleanup"

log "Eliminando worktree..."
cd "$REPO_ROOT"
git -C "$WORKTREE_PATH" checkout -- .claude/ 2>/dev/null || true
git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 \
    || warn "No se pudo eliminar el worktree. Eliminalo manualmente: git worktree remove --force $WORKTREE_PATH"

WORKTREE_PATH=""

success "Worktree eliminado"

echo ""
TOTAL_COMMITS=$(echo "$COMMITS_LIST" | wc -l | tr -d ' ')
if [ -n "$VARIANT_LABEL" ]; then
    echo -e "${CYAN}${BOLD}=== Pipeline mefisto-tooling (variante '$VARIANT_LABEL') completado ===${NC}"
    echo ""
    echo -e "  Commits: $TOTAL_COMMITS"
    echo -e "  Rama:    $BRANCH_NAME"
    echo -e "  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)"
    echo -e "  Log:     $LOG_FILE"
    echo ""
    echo -e "${YELLOW}Si esta variante gana la comparacion, promuevela a mano:${NC}"
    echo -e "${YELLOW}  git -C $REPO_ROOT push -u origin $BRANCH_NAME${NC}"
    echo -e "${YELLOW}  gh pr create --base main --head $BRANCH_NAME --title \"$ISSUE_TITLE\" --body \"$ISSUE_PR_REFERENCE #$ISSUE_NUM\"${NC}"
    echo -e "${YELLOW}O relanza el pipeline sin --variant para que una corrida normal abra el PR.${NC}"
else
    echo -e "${CYAN}${BOLD}=== Pipeline mefisto-tooling completado ===${NC}"
    echo ""
    echo -e "  Commits: $TOTAL_COMMITS"
    echo -e "  Rama:    $BRANCH_NAME"
    echo -e "  PR:      $PR_URL"
    echo -e "  Log:     $LOG_FILE"
fi
echo ""
