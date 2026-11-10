#!/usr/bin/env bash
# tooling-pipeline.sh -- Pipeline para tareas de tooling (no-TDD)
#
# Uso:
#   ./scripts/tooling-pipeline.sh 42
#   ./scripts/tooling-pipeline.sh --issue 42
#   ./scripts/tooling-pipeline.sh 42 --from-stage 2   # Retomar desde Stage 2
#   ./scripts/tooling-pipeline.sh 42 --models 'reviewer=modelo profundo,writer=modelo balanceado'
#   ./scripts/tooling-pipeline.sh 42 --variant experimento-a  # Corrida paralela del mismo issue (sin PR, rama local)
#   MEFISTO_HOLD_MAX_SECONDS=<s> / MEFISTO_HOLD_PROBE_SECONDS=<s> ./scripts/tooling-pipeline.sh 42  # Techo (default 21600 = 6h) y cadencia de sondeo (default 300) de la espera ante RATE_LIMIT/PROVIDER_UNAVAILABLE (issue #971, MEF-ADR-0051)
#
# Ciclo: Issue -> Worktree -> Writer -> Reviewer -> Sync main -> PR -> Cleanup
#
# A diferencia del pipeline TDD, este no tiene fases roja/verde.
# Los gates son: compilacion (Stage 1) y compilacion + tests existentes (Stage 2).

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"

# La clausura publicada conserva src/runtime junto a este script. Solo estas
# dos librerias son contrato del pipeline; el runner carga su adaptador aparte.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_DIR="$(cd "$SCRIPT_DIR/../src/runtime" 2>/dev/null && pwd -P)" \
    || { echo "ERROR: no se encontro src/runtime junto al paquete publicado" >&2; exit 1; }
RUNTIME_LIB_DIR="$RUNTIME_DIR/lib"
RUN_AGENT_BIN_DEFAULT="$RUNTIME_DIR/mefisto-run-agent.sh"
[ -f "$RUNTIME_LIB_DIR/mefisto-runtime.sh" ] \
    || { echo "ERROR: no se encontro mefisto-runtime.sh en la clausura publicada" >&2; exit 1; }
[ -f "$RUNTIME_LIB_DIR/mefisto-models.sh" ] \
    || { echo "ERROR: no se encontro mefisto-models.sh en la clausura publicada" >&2; exit 1; }
source "$RUNTIME_LIB_DIR/mefisto-runtime.sh"
source "$RUNTIME_LIB_DIR/mefisto-models.sh"

# Guard defensivo: este pipeline es del lado publicado y solo aplica al consumidor.
# Si detectamos .claude-plugin/plugin.json en la raiz, estamos en el repo de Mefisto.
_REPO_TOP=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git" >&2
    exit 1
}
if [ -f "$_REPO_TOP/.claude-plugin/plugin.json" ]; then
    echo "ERROR: scripts/tooling-pipeline.sh es del plugin publicado y solo aplica al consumidor." >&2
    echo "Estas en el repo de Mefisto. Para mejorar el plugin, usa .claude/scripts/mefisto-tooling-pipeline.sh." >&2
    exit 1
fi
unset _REPO_TOP

load_harness_config || exit 1

MEFISTO_DRAFTS_SLUG=$(jq -r '.repoSlug // empty' "${HARNESS_CONFIG_PATH:-}" 2>/dev/null || true)
[ -n "$MEFISTO_DRAFTS_SLUG" ] || MEFISTO_DRAFTS_SLUG="augusto-romero-arango/mefisto"

# Identidad declarada por el paquete; se revalida contra el runtime resuelto
# antes de crear evidencia durable.
HARNESS_IDENTITY_JSON="$(get_harness_identity_json)"

# --- Colores ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# --- Logging ---
PIPELINE_DIR="$(dirname "$(mefisto_state_path '.state')")"
LOG_DIR="$(dirname "$(mefisto_state_path 'logs/.state')")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/tooling-pipeline-$TIMESTAMP.log"

# Lineas de log que abort() reemite al fallar (issue #379): la causa real de un
# fallo externo (gh, git, dotnet...) vive en el log del pipeline, no en el
# mensaje de abort, y sin esto solo se llega a ella abriendo un segundo archivo.
TAIL_LOG_LINES=20

# --- Deteccion de trabajo del agente (issue #568) ---
# Pathspec de exclusion que comparten los tres puntos que preguntan "hay trabajo
# en el worktree?" (gate del writer, auto_commit_if_needed y la recuperacion de
# run_agent). Se detecta por EXCLUSION -- todo menos lo que escribe el propio
# pipeline -- en vez de listar a mano las rutas de escritura permitidas: esa
# allowlist se desincronizo de la que declara el skill (commands/tooling.md) y
# dejaba huerfano el trabajo que caia fuera (docs/adr/, CLAUDE.md, ...). Mismo
# patron que scaffold-pipeline.sh:301. Una sola definicion para que no vuelva a
# haber varias listas divergiendo entre si. Lo excluido lo escribe el pipeline:
#   .mefisto/pipeline/     evidencia operacional canonica; nunca se versiona.
PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')

# --- Tracking de estado ---
AGENT_WR_DUR="" AGENT_WR_RES="pending"
AGENT_RV_DUR="" AGENT_RV_RES="pending"
AGENT_WR_METRICS="null" AGENT_RV_METRICS="null"
PIPELINE_TESTS=""
PIPELINE_PR=""
PIPELINE_ERROR=""
LAST_AGENT_DURATION=0
LAST_AGENT_DENIALS=0
CURRENT_STAGE="setup"
HOLD_CAUSE_JSON="null" HOLD_NEXT_PROBE_JSON="null" HOLD_CEILING_JSON="null" HOLD_TOTAL=0
PIPELINE_TMP_DIR=""
PIPELINE_ABORTING=false

cleanup_pipeline_temporaries() {
    [ -z "$PIPELINE_TMP_DIR" ] || rm -rf "$PIPELINE_TMP_DIR" 2>/dev/null || true
}

record_failed_history() {
    [ -n "${HISTORY_FILE:-}" ] || return 0
    jq -cn --arg issue "${ISSUE_NUM:-}" --arg title "${ISSUE_TITLE:-}" --argjson variant "${VARIANT_LABEL_JSON:-null}" \
        --argjson identity "$HARNESS_IDENTITY_JSON" --arg runtime "${MEFISTO_RUNTIME_RESUELTO:-}" --arg started "${TIMESTAMP:-}" --arg finished "$(date +%Y-%m-%dT%H:%M:%S)" \
        --arg stage "$CURRENT_STAGE" --arg error "$PIPELINE_ERROR" --argjson writer "$AGENT_WR_METRICS" --argjson reviewer "$AGENT_RV_METRICS" --arg log "${LOG_FILE_ABS:-}" \
        '{issue:$issue,title:$title,pipeline:"tooling",variant:$variant,identity:$identity,runtime:(if $runtime == "" then null else $runtime end),started:$started,finished:$finished,state:"failed",stage:$stage,error:$error,agents:{writer:{metrics:$writer},reviewer:{metrics:$reviewer}},log:(if $log == "" then null else $log end)}' \
        >> "$HISTORY_FILE" 2>/dev/null || true
}

finalize_pipeline_exit() {
    local exit_code=$? status_file
    trap - EXIT
    set +e

    # Un abort que no alcanzo a completar su propia escritura conserva su error;
    # cualquier otro cierre no controlado recibe un diagnostico generico.
    status_file="${MEFISTO_STATE_DIR:-}/${STATUS_FILENAME:-}"
    if [ "$exit_code" -ne 0 ] && [ -n "${STATUS_FILENAME:-}" ] \
       && [ -n "${PIPELINE_DIR_ABS:-}" ] && [ -f "$status_file" ] \
       && jq -e '.state == "running" or .state == "hold"' "$status_file" >/dev/null 2>&1; then
        if [ "$PIPELINE_ABORTING" != true ]; then
            PIPELINE_ERROR="Terminacion no controlada (exit code: $exit_code)"
        fi
        update_status "$CURRENT_STAGE" "failed" >/dev/null 2>&1 || true
        record_failed_history
    fi

    cleanup_pipeline_temporaries
    exit "$exit_code"
}
trap finalize_pipeline_exit EXIT

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
    PIPELINE_ABORTING=true
    log_tail="$(_tail_log_for_abort "${LOG_FILE_ABS:-$LOG_FILE}" "$TAIL_LOG_LINES")" || log_tail=""
    PIPELINE_ERROR="$(echo "$1" | sed 's/"/\\"/g' | tr '\n' ' ')"
    echo -e "\n${RED}${BOLD}x ERROR: $1${NC}" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}"
    echo -e "${YELLOW}Revisa el log: ${LOG_FILE_ABS:-$LOG_FILE}${NC}"
    if [ -n "$log_tail" ]; then echo "$log_tail"; fi
    if [ -n "${WORKTREE_PATH:-}" ] && [ -d "$WORKTREE_PATH" ]; then
        echo -e "${YELLOW}El worktree queda en: $WORKTREE_PATH${NC}"
        echo -e "${YELLOW}Para inspeccionar: cd $WORKTREE_PATH${NC}"
    fi
    if [ -n "${PIPELINE_DIR_ABS:-}" ]; then
        update_status "$CURRENT_STAGE" "failed"
        record_failed_history
    fi
    exit 1
}

update_status() {
    local stage="$1" state="$2"
    CURRENT_STAGE="$stage"
    local wr_dur="null" rv_dur="null"
    [ -n "$AGENT_WR_DUR" ] && wr_dur="$AGENT_WR_DUR"
    [ -n "$AGENT_RV_DUR" ] && rv_dur="$AGENT_RV_DUR"
    local tests_val pr_val="null" error_val="null"
    tests_val="$(tests_json_value "${PIPELINE_TESTS:-}")"
    [ -n "$PIPELINE_PR" ]    && pr_val="\"$PIPELINE_PR\""
    [ -n "$PIPELINE_ERROR" ] && error_val="\"$PIPELINE_ERROR\""
    cat > "$(mefisto_state_path "$STATUS_FILENAME")" <<EOJSON
{
  "issue": "${ISSUE_NUM:-null}",
  "title": "$(echo "${ISSUE_TITLE:-}" | sed 's/"/\\"/g')",
  "pipeline": "tooling",
  "variant": ${VARIANT_LABEL_JSON:-null},
  "identity": $HARNESS_IDENTITY_JSON,
  "runtime": ${MEFISTO_RUNTIME_JSON:-null},
  "started": "$TIMESTAMP",
  "stage": "$stage",
  "state": "$state",
  "updated": "$(date +%Y-%m-%dT%H:%M:%S)",
  "worktree": "${WORKTREE_PATH:-}",
  "log": "${LOG_FILE_ABS:-$LOG_FILE}",
  "agents": {
    "writer":   {"agent": "tooling-writer", "profile": "balanced", "requested_model": ${MODEL_WRITER_JSON:-null}, "inherited": ${MODEL_WRITER_INHERITED:-true}, "duration": $wr_dur, "result": "$AGENT_WR_RES", "metrics": $AGENT_WR_METRICS},
    "reviewer": {"agent": "tooling-reviewer", "profile": "deep", "requested_model": ${MODEL_REVIEWER_JSON:-null}, "inherited": ${MODEL_REVIEWER_INHERITED:-true}, "duration": $rv_dur, "result": "$AGENT_RV_RES", "metrics": $AGENT_RV_METRICS}
  },
  "tests": $tests_val,
  "pr": $pr_val,
  "last_error": $error_val
  ,"hold": {"cause": $HOLD_CAUSE_JSON, "next_probe": $HOLD_NEXT_PROBE_JSON, "ceiling_seconds": $HOLD_CEILING_JSON, "accumulated_seconds": $HOLD_TOTAL}
}
EOJSON
}

# extract_test_count y run_tests_projects viven en _pipeline-common.sh
# (consolidadas desde tdd-pipeline.sh y tooling-pipeline.sh, issue #305).
# Los call sites de este archivo pasan "$WORKTREE_PATH" como primer argumento.

# --- Parsear argumentos ---
ISSUE_NUM=""
FROM_STAGE=1
STATUS_FILENAME="pipeline-status-tooling.json"  # Nombre del archivo de status (parametrizable para paralelismo)
MODELS_SPEC=""  # --models 'agente=modelo[,agente=modelo...]' (issue #708)
VARIANT_LABEL=""  # --variant <label>: corrida paralela del mismo issue, sin PR (issue #710)

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

# --- Resolver --variant (issue #710) --------------------------------------
# Se valida ANTES de crear el worktree (CA-1) y antes de derivar cualquier
# nombre de archivo de la corrida (CA-2), mismo criterio que --models: un label
# malformado debe abortar temprano, y el sufijo tiene que estar puesto ya en el
# primer archivo que se escribe. Mas abajo, en modo variante se suprimen push,
# creacion de PR y comentario al issue (CA-3).
VARIANT_LABEL_JSON="null"
ISSUE_LOG_TAG="$ISSUE_NUM"
if [ -n "$VARIANT_LABEL" ]; then
    validate_variant_label "$VARIANT_LABEL" \
        || abort "--variant mal formado: ${PIPELINE_VARIANT_LABEL_ERROR:-label invalido}"
    VARIANT_LABEL_JSON="\"$VARIANT_LABEL\""
    ISSUE_LOG_TAG="${ISSUE_NUM}-${VARIANT_LABEL}"
    # El log del pipeline tambien lleva el sufijo, no solo los de stage: dos
    # variantes lanzadas en el MISMO segundo comparten $TIMESTAMP y, sin el
    # label, escribirian las dos al mismo archivo -- log entrelazado, y el tail
    # de abort() mostrando lineas de la otra corrida.
    LOG_FILE="$LOG_DIR/tooling-pipeline-${TIMESTAMP}-${VARIANT_LABEL}.log"
fi

# Si no se paso --status-file, usar pipeline-status-tooling-{issue}.json para soportar paralelismo
# (o pipeline-status-tooling-{issue}-{variant}.json en modo --variant, CA-2: dos
# variantes del mismo issue corriendo a la vez no deben pisarse el status).
if [ "$STATUS_FILENAME" = "pipeline-status-tooling.json" ]; then
    STATUS_FILENAME="pipeline-status-tooling-${ISSUE_NUM}.json"
    [ -n "$VARIANT_LABEL" ] && STATUS_FILENAME="pipeline-status-tooling-${ISSUE_NUM}-${VARIANT_LABEL}.json"
fi

if ! [[ "$FROM_STAGE" =~ ^[1-2]$ ]]; then
    abort "--from-stage debe ser 1 o 2 (recibido: $FROM_STAGE)"
fi

# --- Resolver frontera neutral antes de crear el worktree -------------------
MEFISTO_AGENT_TIMEOUT_SECONDS="${MEFISTO_AGENT_TIMEOUT_SECONDS:-1800}"
case "$MEFISTO_AGENT_TIMEOUT_SECONDS" in ''|*[!0-9]*) abort "MEFISTO_AGENT_TIMEOUT_SECONDS '$MEFISTO_AGENT_TIMEOUT_SECONDS' no es un entero" ;; esac
[ "$MEFISTO_AGENT_TIMEOUT_SECONDS" -gt 0 ] || abort "MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0"
for cmd in gh git jq dotnet; do
    command -v "$cmd" &>/dev/null || abort "Falta comando requerido: $cmd"
done
[ -x "${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}" ] \
    || abort "No es ejecutable el runner neutral: ${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}"
RUN_AGENT_BIN="${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}"
if ! mefisto_resolve_runtime >/dev/null; then
    abort "No se pudo resolver el runtime activo: ${MEFISTO_RUNTIME_ERROR:-motivo desconocido}"
fi
MEFISTO_RUNTIME_RESUELTO="$MEFISTO_RESOLVED_RUNTIME"
MEFISTO_RUNTIME_JSON="\"$MEFISTO_RUNTIME_RESUELTO\""
HARNESS_IDENTITY_JSON="$(get_harness_identity_json "$MEFISTO_RUNTIME_RESUELTO")"
if ! runtime_cli_available "$MEFISTO_RUNTIME_RESUELTO"; then
    abort "Falta el CLI del runtime resuelto ('$MEFISTO_RUNTIME_RESUELTO')"
fi

# --- Preparar directorio de pipeline ---
mkdir -p "$LOG_DIR"
echo "Pipeline tooling iniciado: $TIMESTAMP" > "$LOG_FILE"

PIPELINE_DIR_ABS="$(dirname "$(mefisto_state_path '.state')")"
LOG_DIR_ABS="$(dirname "$(mefisto_state_path 'logs/.state')")"
LOG_FILE_ABS="$(mefisto_state_path "logs/$(basename "$LOG_FILE")")"
LOG_FILE="$LOG_FILE_ABS"
EVENTS_LOG_ABS="$(mefisto_state_path 'events.log')"
HISTORY_FILE="$(mefisto_state_path 'pipeline-history.jsonl')"
PIPELINE_TMP_DIR="$(mktemp -d -t mefisto-tooling)" || abort "No se pudo crear el directorio temporal del pipeline"
[ -d "$PIPELINE_TMP_DIR" ] || abort "No se pudo crear el directorio temporal del pipeline"

echo "=== SESSION TOOLING $TIMESTAMP issue:$ISSUE_NUM from-stage:$FROM_STAGE ===" >> "$EVENTS_LOG_ABS"
if [ "$(printf '%s' "$HARNESS_IDENTITY_JSON" | jq -r '.identity_state')" != "complete" ]; then
    warn "Identidad de distribucion degradada: metadata ausente o invalida; version/commit se registran como null"
fi

# --- Resolver --models (issue #708) --------------------------------------
# Se valida ANTES de crear el worktree (CA-1): un --models malformado debe
# abortar temprano, no a mitad de Stage 1 con un worktree ya en disco.
parse_stage_models "$MODELS_SPEC" \
    || abort "--models mal formado: ${PIPELINE_STAGE_MODELS_ERROR:-formato invalido}"
if [ -n "$PIPELINE_STAGE_MODELS" ]; then
    STAGE_MODELS_LOG="$(format_stage_models_for_log)"
    log "Modelos por stage (--models): $STAGE_MODELS_LOG"
    echo "[$(date +%H:%M:%S)] MODELS: $STAGE_MODELS_LOG" >> "$EVENTS_LOG_ABS"
fi

# Modelos neutrales: el override publico gana por clave exacta; sin override
# el mapping opcional del consumidor y el adaptador deciden, o se hereda.
CONSUMER_MODELS_FILE="$(git rev-parse --show-toplevel)/.mefisto/models.json"
RESOLVED_TOOLING_MODEL=""
resolve_tooling_model() {
    local key="$1" agent_id="$2" profile="$3" explicit=""
    explicit="$(resolve_stage_model "$key" "")"
    if [ -n "$explicit" ]; then
        RESOLVED_TOOLING_MODEL="$explicit"
        echo "[$(date +%H:%M:%S)] MODELS: $key runtime=$MEFISTO_RUNTIME_RESUELTO perfil=$profile solicitado='$explicit' resuelto='$RESOLVED_TOOLING_MODEL' (override --models)" >> "$EVENTS_LOG_ABS"
        return 0
    fi
    local output
    output="$(mktemp)"
    if ! mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile" "" "$CONSUMER_MODELS_FILE" > "$output"; then
        rm -f "$output"
        abort "No se pudo resolver el modelo de $agent_id (perfil $profile): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"
    fi
    RESOLVED_TOOLING_MODEL="$(cat "$output")"; rm -f "$output"
    echo "[$(date +%H:%M:%S)] MODELS: $key runtime=$MEFISTO_RUNTIME_RESUELTO perfil=$profile solicitado=<automatico> resuelto='${RESOLVED_TOOLING_MODEL:-<heredado>}'" >> "$EVENTS_LOG_ABS"
}
resolve_tooling_model writer tooling-writer balanced
MODEL_WRITER="$RESOLVED_TOOLING_MODEL"
resolve_tooling_model reviewer tooling-reviewer deep
MODEL_REVIEWER="$RESOLVED_TOOLING_MODEL"
# Effort por agente (issue #2500): nivel de fabrica + mapping del consumidor,
# resuelto antes de crear el worktree; vacio = heredar (sin --effort).
resolve_pipeline_agent_effort writer tooling-writer \
    || abort "No se pudo resolver el effort de tooling-writer: ${PIPELINE_EFFORT_ERROR:-motivo desconocido} (MEFISTO_EFFORTS_ERROR)"
EFFORT_WRITER="$RESOLVED_PIPELINE_EFFORT"
resolve_pipeline_agent_effort reviewer tooling-reviewer \
    || abort "No se pudo resolver el effort de tooling-reviewer: ${PIPELINE_EFFORT_ERROR:-motivo desconocido} (MEFISTO_EFFORTS_ERROR)"
EFFORT_REVIEWER="$RESOLVED_PIPELINE_EFFORT"
MODEL_WRITER_JSON="null"; MODEL_WRITER_INHERITED=true
MODEL_REVIEWER_JSON="null"; MODEL_REVIEWER_INHERITED=true
if [ -n "$MODEL_WRITER" ]; then MODEL_WRITER_JSON="$(printf '%s' "$MODEL_WRITER" | jq -Rr '@json')"; MODEL_WRITER_INHERITED=false; fi
if [ -n "$MODEL_REVIEWER" ]; then MODEL_REVIEWER_JSON="$(printf '%s' "$MODEL_REVIEWER" | jq -Rr '@json')"; MODEL_REVIEWER_INHERITED=false; fi

# --- Anunciar el modo variante (issue #710) -------------------------------
# El label ya se valido y ya derivo los nombres de archivo arriba, junto al
# parseo de argumentos; aqui solo se anuncia, que es lo primero que se puede
# hacer una vez existen el log del pipeline y events.log.
if [ -n "$VARIANT_LABEL" ]; then
    log "Modo variante: '$VARIANT_LABEL' -- sin push, sin PR, sin comentario al issue (CA-3); rama queda local"
    echo "[$(date +%H:%M:%S)] VARIANT: $VARIANT_LABEL" >> "$EVENTS_LOG_ABS"
fi

# --- Obtener issue ---
header "Preparando contexto"

log "Descargando issue #$ISSUE_NUM..."
ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --json number,title,body,state 2>>"${LOG_FILE_ABS:-$LOG_FILE}") \
    || abort "No se pudo obtener el issue #$ISSUE_NUM"
ISSUE_STATE=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])" 2>/dev/null || echo "UNKNOWN")
if [ "$ISSUE_STATE" != "OPEN" ]; then
    abort "El issue #$ISSUE_NUM esta $ISSUE_STATE -- solo se procesan issues abiertos."
fi
ISSUE_TITLE=$(echo "$ISSUE_JSON" | grep -o '"title":"[^"]*"' | sed 's/"title":"//;s/"//')
ISSUE_BODY=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['body'])" 2>/dev/null \
    || echo "$ISSUE_JSON" | sed 's/.*"body":"//;s/","[^"]*":".*//;s/\\n/\n/g;s/\\r//g')
ISSUE_CONTEXT="# Issue #$ISSUE_NUM: $ISSUE_TITLE

$ISSUE_BODY"
log "Issue: $ISSUE_TITLE"

# --- Preparar worktree ---
header "Preparando worktree"

REPO_ROOT=$(git rev-parse --show-toplevel)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | tr -s '-' | cut -c1-40 | sed 's/-$//')
BRANCH_NAME="worktree-issue-${ISSUE_NUM}-${SLUG}"
# Modo variante (CA-2): worktree y rama llevan el sufijo -<label>, para que N
# corridas simultaneas del mismo issue coexistan sin colision de paths ni ramas.
[ -n "$VARIANT_LABEL" ] && BRANCH_NAME="${BRANCH_NAME}-${VARIANT_LABEL}"
WORKTREE_PATH="${REPO_ROOT}/.mefisto/pipeline/worktrees/${BRANCH_NAME}"

# Retomar: si el worktree solo existe en la ruta anterior (al lado del repo), usarlo.
LEGACY_WORKTREE_PATH="${REPO_ROOT}/../${BRANCH_NAME}"
if [ "$FROM_STAGE" -gt 1 ] && [ ! -d "$WORKTREE_PATH" ] && [ -d "$LEGACY_WORKTREE_PATH" ]; then
    log "Worktree no encontrado en la ruta nueva; usando el de la ruta anterior: $LEGACY_WORKTREE_PATH"
    WORKTREE_PATH="$LEGACY_WORKTREE_PATH"
fi

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
    git fetch origin main >>"$LOG_FILE" 2>&1 || abort "No se pudo hacer fetch de origin/main"

    # Idempotencia: si el worktree ya existe, limpiarlo
    if [ -d "$WORKTREE_PATH" ]; then
        warn "El worktree ya existe: $WORKTREE_PATH -- limpiando para reiniciar..."
        git worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 || true
        git branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
    fi
    if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
        warn "La rama $BRANCH_NAME ya existe sin worktree -- eliminandola..."
        git branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
    fi

    log "Creando worktree: $WORKTREE_PATH (base: origin/main)"
    mkdir -p "$(dirname "$WORKTREE_PATH")"
    git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" origin/main >>"$LOG_FILE" 2>&1 \
        || abort "No se pudo crear el worktree desde origin/main"

    success "Worktree creado: $WORKTREE_PATH"

    mefisto_state_path 'summaries/.state' "$WORKTREE_PATH" >/dev/null

    update_status "setup" "running"

    SNAPSHOT_COMMIT=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
    log "Snapshot: $SNAPSHOT_COMMIT"
fi

# --- Funcion auxiliar: recolectar resumen de agente ---
collect_summary() {
    local stage="$1" agent="$2"
    local f
    f="$(mefisto_state_path "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH")"
    if [ -f "$f" ]; then cat "$f"; else echo "_(El agente no genero resumen)_"; fi
}

# --- Funcion auxiliar: auto-commit de seguridad ---
auto_commit_if_needed() {
    local phase="$1"
    local msg="$2"

    # Commitea todo menos lo que escribe el propio pipeline (issue #568, ver
    # PIPELINE_OWN_WRITES) y menos pipeline-state/, la senal transitoria que nunca
    # se versiona (MEF-ADR-0017): normalmente esta gitignored en el consumidor
    # greenfield, pero se excluye igual por si ese .gitignore no existe.
    # La exclusion va en el guard *y* en el add (mismo criterio que
    # scaffold-pipeline.sh:301) para que "la unica suciedad es estado runtime" no
    # intente un commit vacio. El 'git checkout' de arriba ya restaura
    # settings.json cuando esta versionada; excluirla ademas del add cubre el caso
    # en que no lo este -- ahi el checkout no puede revertirla y este 'add -A'
    # colaria al PR del consumidor la copia con la ruta absoluta del events.log.
    if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- . "${PIPELINE_OWN_WRITES[@]}" ':!pipeline-state')" ]; then
        log "Haciendo commit automatico (fase $phase)..."
        git -C "$WORKTREE_PATH" add -A -- . "${PIPELINE_OWN_WRITES[@]}" ':!pipeline-state' \
            >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || true
        git -C "$WORKTREE_PATH" commit -m "$msg" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || true
    fi
}

# Frontera neutral publicada. El runner es autoridad de watchdog, argv y
# terminal; este nivel conserva exclusivamente la politica de hold/retry.
log_agent_model_invocation() {
    local agent="$1" model="$2"
    log "Invocando $agent (modelo: ${model:-<heredado>})..."
}

run_agent() {
    local stage="$1" agent="$2" prompt="$3"
    local log_base="$LOG_DIR_ABS/tooling-stage-${stage}-${agent}-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}"
    local log_stage="${log_base}.log" events_file=""
    local prompt_file="$PIPELINE_TMP_DIR/${stage}-${agent}.prompt.md"
    local system_file="$PIPELINE_TMP_DIR/${stage}-${agent}.system.md"
    local runner_file="$PIPELINE_TMP_DIR/${stage}-${agent}.runner.log"
    printf '%s' "$prompt" > "$prompt_file"
    printf '%s\n' 'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.' > "$system_file"
    local agent_id model effort profile start_ts run_exit=0 elapsed=0 failure_type="" hold_started="" hold_total=0 resume_session="" resume_degraded=false attempt=0
    local denial_retry_used=false entry_commit summary_file
    entry_commit="$(git -C "$WORKTREE_PATH" rev-parse HEAD)"
    summary_file="$(mefisto_state_path "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH")"
    case "$agent" in reviewer) agent_id="tooling-reviewer"; profile="deep"; model="$MODEL_REVIEWER"; effort="$EFFORT_REVIEWER" ;; *) agent_id="tooling-writer"; profile="balanced"; model="$MODEL_WRITER"; effort="$EFFORT_WRITER" ;; esac
    case "$agent" in writer) AGENT_WR_RES="running" ;; reviewer) AGENT_RV_RES="running" ;; esac
    update_status "$stage-$agent" running
    log_agent_model_invocation "$agent" "$model"
    start_ts=$(date +%s)
    while :; do
        attempt=$((attempt + 1))
        events_file="${log_base}-attempt-${attempt}.events.jsonl"
        local attempt_prompt="$prompt_file" attempt_resume=false
        if [ -n "$resume_session" ]; then
            attempt_resume=true
            attempt_prompt="$PIPELINE_TMP_DIR/${stage}-${agent}-resume-${attempt}.prompt.md"
            printf '%s\n' "Continue the same stage and complete its summary." > "$attempt_prompt"
        fi
        local args=(--runtime "$MEFISTO_RUNTIME_RESUELTO" --agent "$agent_id" --cwd "$WORKTREE_PATH" --prompt-file "$attempt_prompt" --system-file "$system_file" --event-log "$events_file" --events-log "$EVENTS_LOG_ABS" --redact-observability --timeout "$MEFISTO_AGENT_TIMEOUT_SECONDS")
        [ -n "$model" ] && args+=(--model "$model")
        [ -n "$effort" ] && args+=(--effort "$effort")
        [ -n "$resume_session" ] && args+=(--resume-session "$resume_session")
        if "$RUN_AGENT_BIN" "${args[@]}" >"$runner_file" 2>&1; then run_exit=0; else run_exit=$?; fi
        [ "$attempt_prompt" = "$prompt_file" ] || rm -f "$attempt_prompt"
        elapsed=$(( $(date +%s) - start_ts ))
        derive_stage_log_from_stream "$events_file" "" "$log_stage"
        local metrics_json
        metrics_json="$(compute_stage_metrics "$events_file")"
        metrics_json="$(enrich_tooling_stage_metrics "$events_file" "$metrics_json" "$ISSUE_NUM" "${VARIANT_LABEL_JSON:-null}" "$stage" "$agent_id" "$profile" "$HARNESS_IDENTITY_JSON")"
        printf '%s\n' "$metrics_json" > "$(mefisto_state_path "metrics/tooling-stage-${stage}-${agent}-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}.json")"
        case "$agent" in writer) AGENT_WR_METRICS="$metrics_json" ;; reviewer) AGENT_RV_METRICS="$metrics_json" ;; esac
        local denials
        denials="$(agent_events_denials "$events_file")"
        case "$denials" in ''|*[!0-9]*) denials=0 ;; esac
        LAST_AGENT_DENIALS="$denials"

        # El retry publicado por permisos es unico y se decide solo con el
        # contador neutral. Aplica incluso si el CLI termino en success pero
        # sus denegaciones impidieron producir cambios.
        local attempt_has_work=false
        if ! git -C "$WORKTREE_PATH" diff --quiet "$entry_commit"..HEAD 2>/dev/null \
            || [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- . "${PIPELINE_OWN_WRITES[@]}" 2>/dev/null)" ]; then
            attempt_has_work=true
        fi
        if [ "$denials" -gt 0 ] && [ "$attempt_has_work" = false ] && [ "$denial_retry_used" = false ]; then
            denial_retry_used=true
            resume_session=""
            warn "$agent: $denials denegacion(es) neutrales sin trabajo; reintentando una vez desde cero"
            echo "[$(date +%H:%M:%S)] RETRY $agent: denials=$denials" >> "$EVENTS_LOG_ABS"
            continue
        fi

        if [ "$run_exit" -eq 0 ] && agent_events_completed_successfully "$events_file"; then
            failure_type=""
            break
        fi
        failure_type="$(classify_neutral_agent_failure "$run_exit" "$events_file")"
        if ! agent_failure_is_holdable "$failure_type"; then break; fi
        [ -z "$hold_started" ] && hold_started=$(date +%s)
        HOLD_CAUSE_JSON="\"$failure_type\""
        HOLD_CEILING_JSON="${MEFISTO_HOLD_MAX_SECONDS:-21600}"
        local next_probe_epoch next_probe
        next_probe_epoch=$(( $(date +%s) + ${MEFISTO_HOLD_PROBE_SECONDS:-300} ))
        next_probe="$(date -u -r "$next_probe_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$next_probe_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
        [ -n "$next_probe" ] && HOLD_NEXT_PROBE_JSON="\"$next_probe\"" || HOLD_NEXT_PROBE_JSON="null"
        HOLD_TOTAL="$hold_total"
        update_status "$stage-$agent" "hold"
        local slept resets
        resets="$(agent_events_resets_at "$events_file")"
        if ! slept=$(agent_hold_wait "$EVENTS_LOG_ABS" "$failure_type" "$hold_started" "$resets"); then break; fi
        hold_total=$((hold_total + slept))
        HOLD_TOTAL="$hold_total"
        if [ "$attempt_resume" = true ] && [ ! -s "$summary_file" ]; then
            warn "$agent: la sesion reanudada termino sin resumen; se degrada permanentemente a inicio limpio"
            resume_degraded=true; resume_session=""
        elif [ "$resume_degraded" = false ]; then
            resume_session="$(agent_events_session_id "$events_file")"
            if [ -z "$resume_session" ]; then warn "$agent: terminal sin session_id; la sonda inicia de cero";
            elif ! runtime_supports_resume "$MEFISTO_RUNTIME_RESUELTO"; then warn "$agent: runtime sin capacidad de reanudacion; la sonda inicia de cero"; resume_session="";
            fi
        fi
    done
    if [ -n "$failure_type" ]; then
        # Se conserva la recuperacion publicada para fallos ordinarios: solo
        # trabajo real que ademas pasa el gate de compilacion. Los desenlaces
        # incompletos del protocolo nunca entran a este atajo.
        local recoverable_work=false
        case "$failure_type" in TIMEOUT|KILLED|STREAM_CUT|PROTOCOL_INVALID) ;;
            *)
                if ! git -C "$WORKTREE_PATH" diff --quiet "$entry_commit"..HEAD 2>/dev/null \
                    || [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- . "${PIPELINE_OWN_WRITES[@]}" 2>/dev/null)" ]; then
                    if dotnet build "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1; then
                        recoverable_work=true
                    fi
                fi
                ;;
        esac
        if [ "$recoverable_work" = true ]; then
            warn "$agent: runner termino con $failure_type, pero el trabajo paso el gate de confianza"
            echo "[$(date +%H:%M:%S)] RECUPERADO $agent: trabajo util detectado" >> "$EVENTS_LOG_ABS"
            failure_type=""
        fi
    fi
    if [ -n "$failure_type" ]; then
        case "$agent" in writer) AGENT_WR_RES="failed" ;; reviewer) AGENT_RV_RES="failed" ;; esac
        update_status "$stage-$agent" failed
        case "$failure_type" in TIMEOUT|KILLED|STREAM_CUT|PROTOCOL_INVALID) abort "$agent fallo ($failure_type); se descarta trabajo parcial" ;; esac
        abort "$agent fallo ($failure_type). Log completo: $log_stage"
    fi
    HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL="$hold_total"
    LAST_AGENT_DURATION=$((elapsed - hold_total)); log "$agent completado en ${LAST_AGENT_DURATION}s"
}

# --- STAGE 1: Writer (implementacion) ---
if [ "$FROM_STAGE" -le 1 ]; then
    header "Stage 1: Writer (implementacion)"

    STAGE1_PROMPT="Estas en el directorio raiz del proyecto consumidor ${HARNESS_PROJECT_NAME} (un consumidor del plugin Mefisto).

Contexto de la tarea de tooling a implementar:

$ISSUE_CONTEXT

Commit base: ${SNAPSHOT_COMMIT}

Tu tarea: implementa lo descrito en el issue. Esto es una tarea de TOOLING del CONSUMIDOR (workflows de GitHub Actions, configuracion local, fixtures de test, scripts ad-hoc del consumidor), NO logica de dominio y NO modificaciones al plugin Mefisto.

ALCANCE PERMITIDO de escritura:
- .github/workflows/                         (workflows del consumidor)
- .github/dependabot.yml                     (configuracion de Dependabot del consumidor; solo este archivo)
- .mefisto/harness.config.json               (configuracion del consumidor: contrato canonico)
- .mefisto/appinsights.env                   (configuracion de telemetria del consumidor: solo nombres de recursos, sin secretos)
- .claude/harness.config.json                (solo si ya existe: fallback legacy de lectura, no lo crees)
- .claude/settings.json                      (configuracion Claude del consumidor)
- .mefisto/pipeline/                         (estado runtime canonico; .gitignored)
- pipeline-state/                            (senales del pipeline)
- scripts/                                   (scripts ad-hoc del consumidor)
- tests/                                     (SOLO fixtures, helpers, builders - NO logica de dominio)
- docs/**                                  (documentacion del consumidor, incluido docs/testing/;
  la unica exclusion documental es docs/adr/mef-adr-*, reservada al marco)

PROHIBIDO MODIFICAR (pertenece al plugin Mefisto, no a este repo):
- commands/, skills/, agents/, hooks/, .claude-plugin/, src/published/, src/runtime/, dist/
- docs/adr/mef-adr-*  (ADRs del marco; si copias uno para editarlo local, renombralo con tu propio prefijo)
- src/ (eso es para /implement, no para /tooling)

Si la tarea requiere modificar el plugin Mefisto, NO la ejecutes. En su lugar, propon crear un draft con:
  gh issue create -R ${MEFISTO_DRAFTS_SLUG} --label \"estado:borrador,tipo:tooling\" --title \"...\" --body \"...\"
Y registra esto en el resumen del stage.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). No hay un humano al otro lado.
- Nadie puede aprobar, confirmar ni responder preguntas.
- DEBES usar las herramientas Write y Edit directamente para crear y modificar archivos.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Las capacidades de edicion requeridas por el agente ya estan habilitadas.
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

Instrucciones:
1. Lee los archivos existentes relevantes antes de escribir codigo nuevo.
2. Reutiliza patrones y convenciones del proyecto (mira archivos similares).
3. Haz commits frecuentes con mensajes descriptivos en espanol.
4. Verifica que el proyecto compila con 'dotnet build' si modificaste codigo C#.
5. Comando de verificacion permitido: scripts/warnings-diff.sh del plugin (politica de cero warnings nuevos, MEF-ADR-0056); sigue la doctrina de tu agente con --base ${SNAPSHOT_COMMIT}.
6. Al terminar, escribe un resumen de lo que hiciste en .mefisto/pipeline/summaries/stage-1-writer.md"

    run_agent "1" "writer" "$STAGE1_PROMPT"

    # Validar que genero cambios reales. Cuenta como cambio cualquier cosa que el
    # writer haya dejado en el worktree y que no escriba el propio pipeline (issue
    # #568, ver PIPELINE_OWN_WRITES), en vez de la allowlist a mano que habia aqui
    # (tests/ src/ scripts/ .github/ infra/): esa lista se habia desincronizado de
    # la que declara el skill (commands/tooling.md) y el caso que disparo el issue
    # fue justamente un cambio docs-only (docs/adr/, CLAUDE.md) que no veia.
    # El caso latente de #485 (senal SOLO en pipeline-state/ gitignored) sigue
    # latente por la razon de siempre: git status no reporta rutas ignoradas.
    HAS_COMMITS=false
    HAS_UNSTAGED=false
    if ! git -C "$WORKTREE_PATH" diff --quiet "$SNAPSHOT_COMMIT" HEAD 2>/dev/null; then
        HAS_COMMITS=true
    fi
    if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- . "${PIPELINE_OWN_WRITES[@]}" 2>/dev/null)" ]; then
        HAS_UNSTAGED=true
    fi
    if [ "$HAS_COMMITS" = false ] && [ "$HAS_UNSTAGED" = false ]; then
        # El summary canonico es evidencia runtime ignorada por Git: cuando el
        # writer no deja diff, conserva el motivo estructurado que declaro sin
        # convertirlo en parte del cambio ni depender del texto libre del log.
        WRITER_BLOCKERS="$(awk '
            /^## Pendiente\/bloqueos[[:space:]]*$/ { collecting=1; next }
            collecting && /^##[[:space:]]/ { exit }
            collecting { print }
        ' "$(mefisto_state_path 'summaries/stage-1-writer.md' "$WORKTREE_PATH")" 2>/dev/null)" || WRITER_BLOCKERS=""
        if [ -n "$(printf '%s' "$WRITER_BLOCKERS" | tr -d '[:space:]')" ]; then
            echo -e "${YELLOW}Pendiente/bloqueos informado por el writer:${NC}"
            printf '%s\n' "$WRITER_BLOCKERS"
        fi
        abort "El writer no genero ningun cambio. Revisa el log: $LOG_DIR_ABS/tooling-stage-1-writer-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}.log"
    fi

    # Gate 1: debe compilar (si hay codigo C#)
    if [ -n "$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD -- '*.cs' '*.csproj' 2>/dev/null)" ] \
       || [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- '*.cs' '*.csproj' 2>/dev/null)" ]; then
        log "Gate: verificando compilacion..."
        dotnet build "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
            || abort "Stage 1 fallido: el proyecto no compila despues del writer."
        success "Gate 1: compilacion exitosa"
    else
        log "No hay cambios en C# -- saltando gate de compilacion"
    fi

    auto_commit_if_needed "writer" "tooling(#${ISSUE_NUM}): implementacion"

    # Gate de scope: rechazar si el writer toco rutas reservadas al plugin
    if ! validate_consumer_scope_changes "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"; then
        abort "Stage 1 fallido: el writer toco rutas reservadas al plugin Mefisto."
    fi

    AGENT_WR_DUR=$LAST_AGENT_DURATION
    AGENT_WR_RES="passed"
    update_status "1-writer" "passed"
    success "Stage 1 completado"
fi

# --- STAGE 2: Reviewer (revision) ---
if [ "$FROM_STAGE" -le 2 ]; then
    header "Stage 2: Reviewer (revision)"

    WRITER_HEAD_SHA=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
    DIFF_STAT=$(git -C "$WORKTREE_PATH" diff --stat=120 "$SNAPSHOT_COMMIT"..HEAD)
    DIFF_NAME_STATUS=$(git -C "$WORKTREE_PATH" diff --name-status "$SNAPSHOT_COMMIT"..HEAD)

    STAGE2_PROMPT="Estas en el directorio raiz del proyecto consumidor ${HARNESS_PROJECT_NAME}.

Contexto de la tarea:

$ISSUE_CONTEXT

Cambios del writer:

Commit base: ${SNAPSHOT_COMMIT}
HEAD del writer: ${WRITER_HEAD_SHA}

Resumen (git diff --stat=120 ${SNAPSHOT_COMMIT}..HEAD):

$DIFF_STAT

Rutas cambiadas (git diff --name-status ${SNAPSHOT_COMMIT}..HEAD):

$DIFF_NAME_STATUS

Tu tarea: revisa la calidad del codigo producido por el writer.

ALCANCE PERMITIDO de escritura (igual al del writer):
.github/workflows/, .github/dependabot.yml, .mefisto/appinsights.env, .mefisto/harness.config.json (o .claude/harness.config.json solo si ya existe, legacy), .claude/settings.json,
.mefisto/pipeline/, pipeline-state/, scripts/, tests/ (fixtures/helpers),
docs/** (incluido docs/testing/; salvo docs/adr/mef-adr-*).

PROHIBIDO: commands/, skills/, agents/, hooks/, .claude-plugin/, src/published/, src/runtime/, dist/, docs/adr/mef-adr-*, src/.

Si el writer toco rutas prohibidas, reviertelas o reporta el problema en el resumen
y NO hagas cambios extra al plugin.

CONTEXTO DE EJECUCION:
- Modo no-interactivo (print mode). No hay un humano al otro lado.
- Nadie puede aprobar, confirmar ni responder preguntas.
- DEBES usar las herramientas Write y Edit directamente para corregir problemas.
- Responder con texto pidiendo aprobacion causa un fallo del pipeline.
- Las capacidades de edicion requeridas por el agente ya estan habilitadas.
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya.

ECONOMIA DE TURNOS:
- Ya tienes el commit base, el HEAD del writer, el --stat y las rutas cambiadas aqui arriba: para ver el diff de una ruta puntual pidelo bajo demanda con 'git diff ${SNAPSHOT_COMMIT}..HEAD -- <ruta>' (o 'git show <sha>' para inspeccionar un commit), agrupando varias rutas en el mismo turno si necesitas mas de una. No re-inspecciones el arbol con 'git status' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.

Instrucciones:
1. Verifica que los cambios cumplen con lo pedido en el issue.
2. Revisa calidad: reutilizacion de patrones existentes, naming, legibilidad.
3. Si hay codigo C#, verifica que compila y que los tests existentes pasan.
4. Corrige problemas que encuentres directamente (no solo los reportes).
5. Comando de verificacion permitido: scripts/warnings-diff.sh del plugin (politica de cero warnings nuevos, MEF-ADR-0056); sigue la doctrina de tu agente con --base ${SNAPSHOT_COMMIT}.
6. Haz commit de tus correcciones con mensajes descriptivos.
7. Al terminar, escribe un resumen en .mefisto/pipeline/summaries/stage-2-reviewer.md"

    run_agent "2" "reviewer" "$STAGE2_PROMPT"

    # Gate 2: compilacion + tests existentes
    if [ -n "$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD -- '*.cs' '*.csproj' 2>/dev/null)" ]; then
        log "Gate: verificando compilacion y tests..."
        g2_rc=0
        TEST_OUTPUT_G2=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || g2_rc=$?
        echo "$TEST_OUTPUT_G2" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
        if [ "$g2_rc" -ne 0 ]; then
            echo "$TEST_OUTPUT_G2" | tail -20
            abort "Stage 2 fallido: tests fallan despues del reviewer (exit code: $g2_rc)."
        fi
        TEST_COUNT=$(extract_test_count "$TEST_OUTPUT_G2")
        PIPELINE_TESTS="$TEST_COUNT"
        log "Tests pasando: $TEST_COUNT"
        success "Gate 2: compilacion y tests OK"
    else
        log "No hay cambios en C# -- saltando gate de tests"
    fi

    auto_commit_if_needed "reviewer" "tooling(#${ISSUE_NUM}): revision y correcciones"

    # Gate de scope: rechazar si el reviewer toco rutas reservadas al plugin
    if ! validate_consumer_scope_changes "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"; then
        abort "Stage 2 fallido: el reviewer toco rutas reservadas al plugin Mefisto."
    fi

    AGENT_RV_DUR=$LAST_AGENT_DURATION
    AGENT_RV_RES="passed"
    update_status "2-reviewer" "passed"
    success "Stage 2 completado"
fi

# --- Verificar que hay commits ---
COMMITS_LIST=$(git -C "$WORKTREE_PATH" log "${SNAPSHOT_COMMIT}..HEAD" --oneline)
if [ -z "$COMMITS_LIST" ]; then
    abort "No hay commits en la rama $BRANCH_NAME."
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

    # Re-correr tests post-merge si hay C#
    if [ -n "$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD -- '*.cs' '*.csproj' 2>/dev/null)" ]; then
        log "Verificando tests despues del merge..."
        merge_rc=0
        TEST_OUTPUT_MERGE=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || merge_rc=$?
        echo "$TEST_OUTPUT_MERGE" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
        if [ "$merge_rc" -ne 0 ]; then
            abort "Tests fallan despues del merge con main (exit code: $merge_rc)."
        fi
        success "Tests pasan despues del merge"
    fi
fi

# --- Crear PR (en modo variante: NO -- CA-3) ---
REPO_SLUG_PR="$(git -C "$WORKTREE_PATH" remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')"

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
    EXISTING_PR_URL=$(find_open_pr_for_branch "$BRANCH_NAME" "$REPO_SLUG_PR")

    RUN_METRICS_TABLE=$(render_run_metrics_table \
        "Writer" "${AGENT_WR_DUR:-}" "${AGENT_WR_METRICS:-}" \
        "Reviewer" "${AGENT_RV_DUR:-}" "${AGENT_RV_METRICS:-}")

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
            --repo "$REPO_SLUG_PR" \
            >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || warn "No se pudo publicar las metricas en el PR reutilizado: $PR_URL"
    else
        log "Creando PR..."

        WR_SUMMARY=$(collect_summary "1" "writer")
        RV_SUMMARY=$(collect_summary "2" "reviewer")

        _fmt_dur() { local s="${1:-0}"; echo "$((s/60))m $((s%60))s"; }
        WR_DUR_FMT=$(_fmt_dur "${AGENT_WR_DUR:-0}")
        RV_DUR_FMT=$(_fmt_dur "${AGENT_RV_DUR:-0}")

        PR_URL=$(gh pr create \
            --title "$ISSUE_TITLE" \
            --body "$(cat <<EOF
## Resumen

Pipeline tooling completado:
- Writer: implementacion de la tarea
- Reviewer: revision de calidad

## Decisiones del pipeline

<details>
<summary>Writer -- ${WR_DUR_FMT}</summary>

${WR_SUMMARY}

</details>

<details>
<summary>Reviewer -- ${RV_DUR_FMT}</summary>

${RV_SUMMARY}

</details>

$(render_warning_remnants_section "$WORKTREE_PATH")

## Commits

$COMMITS_LIST

## Metricas de la corrida

$RUN_METRICS_TABLE

Closes #$ISSUE_NUM
EOF
)" \
            --base main \
            --head "$BRANCH_NAME" \
            --repo "$REPO_SLUG_PR" \
            2>>"${LOG_FILE_ABS:-$LOG_FILE}") \
            || abort "No se pudo crear el PR"

        success "PR creado: $PR_URL"
    fi

    gh issue comment "$ISSUE_NUM" \
        --body "Pipeline tooling completado. PR: $PR_URL" \
        --repo "$REPO_SLUG_PR" \
        >>"$LOG_FILE" 2>&1 || warn "No se pudo comentar en el issue #$ISSUE_NUM"
fi

PIPELINE_PR="$PR_URL"
update_status "done" "completed"

# Historial
PR_JSON="null"
[ -n "$PR_URL" ] && PR_JSON="\"$PR_URL\""
TESTS_JSON="$(tests_json_value "${PIPELINE_TESTS:-}")"
append_completed_history "$HISTORY_FILE" "$EVENTS_LOG_ABS" \
    jq -cn --arg issue "$ISSUE_NUM" --arg title "$ISSUE_TITLE" --argjson variant "${VARIANT_LABEL_JSON:-null}" \
    --argjson identity "$HARNESS_IDENTITY_JSON" --arg runtime "$MEFISTO_RUNTIME_RESUELTO" --arg started "$TIMESTAMP" --arg finished "$(date +%Y-%m-%dT%H:%M:%S)" \
    --argjson writer_duration "${AGENT_WR_DUR:-null}" --argjson reviewer_duration "${AGENT_RV_DUR:-null}" \
    --argjson writer_metrics "$AGENT_WR_METRICS" --argjson reviewer_metrics "$AGENT_RV_METRICS" \
    --argjson tests "$TESTS_JSON" --argjson pr "$PR_JSON" --arg log "$LOG_FILE" \
    '{issue:$issue,title:$title,pipeline:"tooling",variant:$variant,identity:$identity,runtime:$runtime,started:$started,finished:$finished,state:"completed",agents:{writer:{duration:$writer_duration,metrics:$writer_metrics},reviewer:{duration:$reviewer_duration,metrics:$reviewer_metrics}},tests:$tests,pr:$pr,log:$log}'

# Eliminar archivo de estado individual (ya esta en el historial)
rm -f "$(mefisto_state_path "$STATUS_FILENAME")"

# --- Cleanup ---
header "Cleanup"

log "Eliminando worktree..."
cd "$REPO_ROOT"
git worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 \
    || warn "No se pudo eliminar el worktree. Eliminalo manualmente: git worktree remove --force $WORKTREE_PATH"

WORKTREE_PATH=""

success "Worktree eliminado"

echo ""
TOTAL_COMMITS=$(echo "$COMMITS_LIST" | wc -l | tr -d ' ')
if [ -n "$VARIANT_LABEL" ]; then
    echo -e "${CYAN}${BOLD}=== Pipeline tooling (variante '$VARIANT_LABEL') completado ===${NC}"
    echo ""
    echo -e "  Commits: $TOTAL_COMMITS"
    echo -e "  Rama:    $BRANCH_NAME"
    echo -e "  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)"
    echo -e "  Log:     $LOG_FILE"
    echo ""
    echo -e "${YELLOW}Si esta variante gana la comparacion, promuevela a mano:${NC}"
    echo -e "${YELLOW}  git -C $REPO_ROOT push -u origin $BRANCH_NAME${NC}"
    echo -e "${YELLOW}  gh pr create --base main --head $BRANCH_NAME --title \"$ISSUE_TITLE\" --body \"Closes #$ISSUE_NUM\"${NC}"
    echo -e "${YELLOW}O relanza el pipeline sin --variant para que una corrida normal abra el PR.${NC}"
else
    echo -e "${CYAN}${BOLD}=== Pipeline tooling completado ===${NC}"
    echo ""
    echo -e "  Commits: $TOTAL_COMMITS"
    echo -e "  Rama:    $BRANCH_NAME"
    echo -e "  PR:      $PR_URL"
    echo -e "  Log:     $LOG_FILE"
fi
echo ""
