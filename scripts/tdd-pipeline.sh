#!/usr/bin/env bash
# tdd-pipeline.sh — Pipeline TDD automatizado
#
# Uso:
#   ./scripts/tdd-pipeline.sh 42
#   ./scripts/tdd-pipeline.sh --issue 42
#   ./scripts/tdd-pipeline.sh --file "docs/Historias de usuario/HU-25.md"
#   ./scripts/tdd-pipeline.sh 42 --from-stage 2   # Retomar desde Stage 2
#   ./scripts/tdd-pipeline.sh 42 --from-stage 3   # Retomar desde Stage 3
#   ./scripts/tdd-pipeline.sh 42 --from-stage 4   # Retomar desde Stage 4 (coverage gate)
#   ./scripts/tdd-pipeline.sh 42 --models 'reviewer=opus,test-writer=sonnet'  # Modelo por stage (experimentos)
#     El valor es pass-through: debe ser valido para el RUNTIME ACTIVO (alias como 'opus' bajo
#     Claude Code; 'provider/model' bajo OpenCode). Sin --models manda el perfil neutral del
#     agente (fast|balanced|deep), que cada adaptador traduce (issue #1362, MEF-ADR-0049).
#   ./scripts/tdd-pipeline.sh 42 --variant experimento-a  # Corrida paralela del mismo issue (sin PR, rama local)
#   MEFISTO_HOLD_MAX_SECONDS=<s> / MEFISTO_HOLD_PROBE_SECONDS=<s> ./scripts/tdd-pipeline.sh 42  # Techo (default 21600 = 6h) y cadencia de sondeo (default 300) de la espera ante RATE_LIMIT/PROVIDER_UNAVAILABLE (issue #971, MEF-ADR-0051)
#
# Ciclo completo: Issue → Worktree → Test Writer → Implementer → Reviewer → Sync main → Coverage Gate → PR → Cleanup
#
# Observabilidad (issue #1363, MEF-ADR-0050): este pipeline nunca parchea
# .claude/settings.json del worktree. El events.log del PIPELINE recibe
# [tool]/[stage] (y [archivo] cuando el runner lo sintetiza) exclusivamente
# via --events-log del runner neutral. Las lineas [test]/[terraform]/[archivo]
# que emiten los hooks PUBLICADOS del plugin (hooks/hooks.json, PostToolUse en
# Claude, sintesis por plugin en OpenCode) quedan en
# <worktree>/.mefisto/pipeline/events.log -- el events.log DEL WORKTREE, no el
# de este pipeline -- en ambos runtimes.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"

# El layout fuente conserva el runner neutral junto al pipeline. El empaquetado
# de esta clausura publicada se completa en #1365; esta frontera no conoce los
# detalles de ningun runtime.
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
    echo "ERROR: scripts/tdd-pipeline.sh es del plugin publicado y solo aplica al consumidor." >&2
    echo "Estas en el repo de Mefisto, que no es un proyecto .NET con TDD de dominio." >&2
    echo "Para mejorar el plugin usa /mefisto-tooling." >&2
    exit 1
fi
unset _REPO_TOP

load_harness_config || exit 1

# Identidad declarada por el paquete (issue #1363, MEF-ADR-0053 S6.5); se
# revalida contra el runtime resuelto mas abajo, antes de la primera
# escritura de status/history durable -- mismo patron de dos fases que
# tooling-pipeline.sh (l.52/l.332). Esta asignacion temprana solo cubre un
# abort() entre aqui y la resolucion del runtime, bajo 'set -u'.
HARNESS_IDENTITY_JSON="$(get_harness_identity_json)"

# ─── Colores ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Logging ─────────────────────────────────────────────────────────────────
PIPELINE_DIR="$(dirname "$(mefisto_state_path '.state')")"
LOG_DIR="$(dirname "$(mefisto_state_path 'logs/.state')")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/pipeline-$TIMESTAMP.log"

# Evidencia operacional del pipeline en el worktree: nunca es trabajo del
# agente ni entra a sus commits, aunque el consumidor no la ignore en Git.
PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')

# Lineas de log que abort() reemite al fallar (issue #379): la causa real de un
# fallo externo (gh, git, dotnet...) vive en el log del pipeline, no en el
# mensaje de abort, y sin esto solo se llega a ella abriendo un segundo archivo.
TAIL_LOG_LINES=20

# ─── Tracking de estado enriquecido ──────────────────────────────────────────
AGENT_TW_DUR="" AGENT_TW_RES="pending"
AGENT_IM_DUR="" AGENT_IM_RES="pending"
AGENT_ST_DUR="" AGENT_ST_RES="pending"   # smoke-test-writer
AGENT_RV_DUR="" AGENT_RV_RES="pending"
AGENT_CG_DUR="" AGENT_CG_RES="pending"   # coverage-gate
# Metricas por stage (issue #646): JSON compacto de compute_stage_metrics,
# cosechado POR STAGE (no por nombre de agente) al cierre de cada run_agent --
# el stage "merge" reusa el nombre de agente "implementer" y con un case por
# agente pisaria las metricas del implementer de Stage 2 (mismo motivo que el
# interno #426 en mefisto-tooling-pipeline.sh).
AGENT_TW_METRICS_JSON=""
AGENT_IM_METRICS_JSON=""
AGENT_ST_METRICS_JSON=""
AGENT_RV_METRICS_JSON=""
LAST_AGENT_METRICS_JSON=""
# Stage 0 (scaffold) y los dos sub-stages de remediacion del coverage gate
# (Stage 4) conservan duracion y metricas propias porque no participan de las
# politicas de hold, reanudacion ni retry de run_agent.
AGENT_SCAFFOLD_DUR="" AGENT_SCAFFOLD_METRICS_JSON=""
AGENT_PATCH_TW_DUR="" AGENT_PATCH_TW_METRICS_JSON=""
AGENT_PATCH_IM_DUR="" AGENT_PATCH_IM_METRICS_JSON=""
COV_PATCH_APPLIED=false
COV_GAPS_REMAINING=0
COV_TABLE=""
# Se inicializa aqui ademas de en el Stage 4 porque la construccion del cuerpo
# del PR la lee para decidir si emite la nota de "sin clasificar" (issue #586),
# y ese bloque corre tambien en las rutas donde el Stage 4 no se ejecuto
# (refactor puro, --from-stage 5): sin este default, `set -u` la volaria.
NOT_EVALUATED_FILES=""
# Ruta que dispara la nota de anomalia de deteccion del Stage 2b (issue
# #1562): un match de src/ que el sed de derivacion de dominio no supo
# transformar. Se inicializa aqui (y no solo en Stage 2b) porque la
# construccion del cuerpo del PR la lee incluso cuando Stage 2b no corrio
# (refactor puro, --from-stage 3): sin este default, `set -u` la volaria.
SMOKE_ANOMALY_PATH=""
# Smokes existentes que invocan tools MCP modificadas (issue #2473): lista
# "<nombre>\t<ruta>" y seccion informativa del PR. Inicializadas aqui por la
# misma razon que SMOKE_ANOMALY_PATH (`set -u` cuando Stage 2b no corre).
SMOKE_INVOKERS=""
SMOKE_UNCHANGED_SECTION=""
PIPELINE_TESTS=""
PIPELINE_PR=""
HAS_BLOCKAGE=false
PIPELINE_ERROR=""
LAST_AGENT_DURATION=0
CURRENT_STAGE="setup"
# Hold estructurado en el status (issue #1600, molde tooling-pipeline.sh l.96):
# run_agent fija estas variables antes de cada espera (agent_hold_wait) y las
# limpia al salir del bucle de reintentos, antes de publicar exito o fallo.
# Fuera de una espera los tres primeros van en null; accumulated_seconds
# conserva el total esperado.
HOLD_CAUSE_JSON="null" HOLD_NEXT_PROBE_JSON="null" HOLD_CEILING_JSON="null" HOLD_TOTAL=0
IS_REFACTOR=false
REFACTOR_JUSTIFICATION=""
BASELINE_TEST_COUNT="?"
REMOVED_TESTS=0
# Señal de fase roja no aplicable (issue #585): gemela de refactor-signal.md,
# pero solo honrada en la ruta read-side (STAGE1_AGENT=projection-test-writer).
IS_NO_RED_SIGNAL=false
IS_SMOKE_ONLY=false
SMOKE_ONLY_FILES=""
NO_RED_JUSTIFICATION=""
# Rama read-side (issue #371): tipo:projection despacha projection-test-writer/
# projection-implementer en vez de test-writer/implementer. reviewer y
# smoke-test-writer se mantienen (ya son read-side-aware via skills: projections).
IS_PROJECTION=false
STAGE1_AGENT="test-writer"
STAGE2_AGENT="implementer"
STAGE1_LABEL="Test Writer"
STAGE2_LABEL="Implementer"

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
success() { local m="${GREEN}${BOLD}✓${NC} $1"; echo -e "$m"; _log_file "$m"; }
warn()    { local m="${YELLOW}⚠${NC} $1"; echo -e "$m"; _log_file "$m"; }
header()  { local m="\n${CYAN}${BOLD}── $1 ──${NC}"; echo -e "$m"; _log_file "$m"; }
abort() {
    # $2 (opcional): estado final a registrar en status/historial -- default
    # "failed". CA-2/CA-3 (issue #1561): un issue incompleto detectado en
    # Gate 2 detiene el pipeline igual que un fallo real, pero debe quedar
    # "blocked" -- distinguible de "failed" en el status y en el historial
    # de metricas (nota tecnica del issue: "no usar abort a secas si marca
    # el stage como failed").
    local abort_state="${2:-failed}"
    # El tail se captura ANTES de que este mismo abort escriba su linea de ERROR
    # al log: si se leyera despues, las dos ultimas lineas del tail serian un eco
    # del mensaje que se acaba de imprimir -- ruido que ademas se come dos lineas
    # del contexto real que se quiere mostrar (issue #379).
    local log_tail
    log_tail="$(_tail_log_for_abort "${LOG_FILE_ABS:-$LOG_FILE}" "$TAIL_LOG_LINES")" || log_tail=""
    PIPELINE_ERROR="$(printf '%s' "$1" | tr '\n' ' ')"
    echo -e "\n${RED}${BOLD}✗ ERROR: $1${NC}" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}"
    echo -e "${YELLOW}Revisa el log: ${LOG_FILE_ABS:-$LOG_FILE}${NC}"
    if [ -n "$log_tail" ]; then echo "$log_tail"; fi
    if [ -n "${WORKTREE_PATH:-}" ] && [ -d "$WORKTREE_PATH" ]; then
        echo -e "${YELLOW}El worktree queda en: $WORKTREE_PATH${NC}"
        echo -e "${YELLOW}Para inspeccionar: cd $WORKTREE_PATH${NC}"
    fi
    if [ -n "${PIPELINE_DIR_ABS:-}" ]; then
        update_status "$CURRENT_STAGE" "$abort_state"
        # CA-3 (issue #646): agents.<clave>.metrics de los stages que ya
        # cerraron en esta corrida -- un fallo a mitad de pipeline es el caso
        # mas caro de diagnosticar, y hasta este issue la linea de fallo no
        # llevaba ni "agents".
        local abort_agent_args=(
            "test-writer" "$STAGE1_AGENT" "${AGENT_TW_DUR:-}" "${AGENT_TW_METRICS_JSON:-}"
            "implementer" "$STAGE2_AGENT" "${AGENT_IM_DUR:-}" "${AGENT_IM_METRICS_JSON:-}"
            "reviewer" "reviewer" "${AGENT_RV_DUR:-}" "${AGENT_RV_METRICS_JSON:-}"
        )
        [ -n "${AGENT_SCAFFOLD_METRICS_JSON:-}" ] && abort_agent_args+=("scaffolder" "domain-scaffolder" "${AGENT_SCAFFOLD_DUR:-}" "$AGENT_SCAFFOLD_METRICS_JSON")
        [ -n "${AGENT_ST_METRICS_JSON:-}" ] && abort_agent_args+=("smoke-test-writer" "smoke-test-writer" "${AGENT_ST_DUR:-}" "$AGENT_ST_METRICS_JSON")
        [ -n "${AGENT_PATCH_TW_METRICS_JSON:-}" ] && abort_agent_args+=("patch-test-writer" "$STAGE1_AGENT" "${AGENT_PATCH_TW_DUR:-}" "$AGENT_PATCH_TW_METRICS_JSON")
        [ -n "${AGENT_PATCH_IM_METRICS_JSON:-}" ] && abort_agent_args+=("patch-implementer" "$STAGE2_AGENT" "${AGENT_PATCH_IM_DUR:-}" "$AGENT_PATCH_IM_METRICS_JSON")
        local abort_agents_json
        abort_agents_json=$(build_agents_history_json "${abort_agent_args[@]}" 2>/dev/null) || abort_agents_json=""
        [ -n "$abort_agents_json" ] || abort_agents_json="null"
        # M4: Registrar falla en historial para analisis de patrones. Identidad
        # y runtime via jq -cn, no interpolacion de cadenas (CA-1, issue #1363,
        # MEF-ADR-0053 S6.5) -- mismo patron que tooling-pipeline.sh
        # record_failed_history (l.104-110).
        jq -cn --arg issue "${ISSUE_NUM:-}" --arg title "${ISSUE_TITLE:-}" --argjson variant "${VARIANT_LABEL_JSON:-null}" \
            --argjson identity "$HARNESS_IDENTITY_JSON" --arg runtime "${MEFISTO_RUNTIME_RESUELTO:-}" \
            --arg started "${TIMESTAMP:-}" --arg finished "$(date +%Y-%m-%dT%H:%M:%S)" \
            --arg stage "$CURRENT_STAGE" --arg error "$PIPELINE_ERROR" --argjson agents "$abort_agents_json" \
            --arg state "$abort_state" --arg log "${LOG_FILE_ABS:-}" \
            '{issue:$issue,title:$title,pipeline:"tdd",variant:$variant,identity:$identity,runtime:(if $runtime == "" then null else $runtime end),started:$started,finished:$finished,state:$state,stage:$stage,agents:$agents,error:$error,log:(if $log == "" then null else $log end)}' \
            >> "$HISTORY_FILE" 2>/dev/null || true
    fi
    exit 1
}

update_status() {
    local stage="$1" state="$2"
    CURRENT_STAGE="$stage"
    local tw_dur="null" im_dur="null" st_dur="null" rv_dur="null" cg_dur="null"
    [ -n "$AGENT_TW_DUR" ] && tw_dur="$AGENT_TW_DUR"
    [ -n "$AGENT_IM_DUR" ] && im_dur="$AGENT_IM_DUR"
    [ -n "$AGENT_ST_DUR" ] && st_dur="$AGENT_ST_DUR"
    [ -n "$AGENT_RV_DUR" ] && rv_dur="$AGENT_RV_DUR"
    [ -n "$AGENT_CG_DUR" ] && cg_dur="$AGENT_CG_DUR"
    local tests_val pr_val="null" error_val="null"
    tests_val="$(tests_json_value "${PIPELINE_TESTS:-}")"
    [ -n "$PIPELINE_PR" ]    && pr_val="\"$PIPELINE_PR\""
    [ -n "$PIPELINE_ERROR" ] && error_val="$(jq -cn --arg error "$PIPELINE_ERROR" '$error')"
    cat > "$(mefisto_state_path "$STATUS_FILENAME")" <<EOJSON
{
  "issue": "${ISSUE_NUM:-null}",
  "title": "$(echo "${ISSUE_TITLE:-}" | sed 's/"/\\"/g')",
  "pipeline": "tdd",
  "variant": ${VARIANT_LABEL_JSON:-null},
  "identity": ${HARNESS_IDENTITY_JSON:-null},
  "runtime": ${MEFISTO_RUNTIME_JSON:-null},
  "started": "$TIMESTAMP",
  "stage": "$stage",
  "state": "$state",
  "updated": "$(date +%Y-%m-%dT%H:%M:%S)",
  "worktree": "${WORKTREE_PATH:-}",
  "log": "${LOG_FILE_ABS:-$LOG_FILE}",
  "agents": {
    "test-writer":       {"duration": $tw_dur, "result": "$AGENT_TW_RES"},
    "implementer":       {"duration": $im_dur, "result": "$AGENT_IM_RES"},
    "smoke-test-writer": {"duration": $st_dur, "result": "$AGENT_ST_RES"},
    "reviewer":          {"duration": $rv_dur, "result": "$AGENT_RV_RES"},
    "coverage-gate":     {"duration": $cg_dur, "result": "$AGENT_CG_RES"}
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

# ─── Parsear argumentos ───────────────────────────────────────────────────────
ISSUE_NUM=""
INPUT_FILE=""
FROM_STAGE=1        # Por defecto, empezar desde Stage 1
STATUS_FILENAME=""  # Se asigna despues del parseo (necesita ISSUE_NUM); override con --status-file
SCAFFOLD_DOMAIN=""  # Nombre del dominio a scaffoldear antes de Stage 1 (kebab-case)
MODELS_SPEC=""  # --models 'agente=modelo[,agente=modelo...]' (issue #712, reusa el parser de #708); valor pass-through, valido para el runtime activo (issue #1362)
VARIANT_LABEL=""  # --variant <label>: corrida paralela del mismo issue, sin PR (issue #713, helper de #710)

if [ $# -eq 0 ]; then
    echo "Uso: $0 [--issue NUM | --file PATH | NUM] [--from-stage N] [--status-file NOMBRE] [--scaffold-domain KEBAB] [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]"
    exit 1
fi

# Parsear todos los argumentos
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue)
            [ $# -lt 2 ] && abort "Falta el número de issue"
            ISSUE_NUM="$2"
            shift 2
            ;;
        --file)
            [ $# -lt 2 ] && abort "Falta la ruta del archivo"
            INPUT_FILE="$2"
            shift 2
            ;;
        --from-stage)
            [ $# -lt 2 ] && abort "Falta el número de stage"
            FROM_STAGE="$2"
            shift 2
            ;;
        --status-file)
            [ $# -lt 2 ] && abort "Falta el nombre del archivo de status"
            STATUS_FILENAME="$2"
            shift 2
            ;;
        --scaffold-domain)
            [ $# -lt 2 ] && abort "Falta el nombre del dominio para --scaffold-domain"
            SCAFFOLD_DOMAIN="$2"
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

# Procesar argumento posicional (número de issue)
if [ ${#POSITIONAL_ARGS[@]} -gt 0 ] && [ -z "$ISSUE_NUM" ]; then
    ISSUE_NUM="${POSITIONAL_ARGS[0]}"
fi

# [Cambio 3] Validar --from-stage
if ! [[ "$FROM_STAGE" =~ ^[1-4]$ ]]; then
    abort "--from-stage debe ser 1, 2, 3 o 4 (recibido: $FROM_STAGE)"
fi

# --- Resolver --variant (issue #713, helper de #710) -------------------------
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
    LOG_FILE="$LOG_DIR/pipeline-${TIMESTAMP}-${VARIANT_LABEL}.log"
fi

# Si no se paso --status-file, usar convención normalizada con ISSUE_NUM
# (o pipeline-status-tdd-{issue}-{variant}.json en modo --variant, CA-2: dos
# variantes del mismo issue corriendo a la vez no deben pisarse el status).
if [ -z "$STATUS_FILENAME" ] && [ -n "$ISSUE_NUM" ]; then
    STATUS_FILENAME="pipeline-status-tdd-${ISSUE_NUM}.json"
    [ -n "$VARIANT_LABEL" ] && STATUS_FILENAME="pipeline-status-tdd-${ISSUE_NUM}-${VARIANT_LABEL}.json"
elif [ -z "$STATUS_FILENAME" ]; then
    STATUS_FILENAME="pipeline-status-tdd.json"
fi

# ─── Verificar dependencias ───────────────────────────────────────────────────
for cmd in gh git dotnet jq; do
    command -v "$cmd" &>/dev/null || abort "Falta comando requerido: $cmd"
done

# ─── Preparar directorio de pipeline ─────────────────────────────────────────
# Todas las escrituras de estado usan la raiz canonica; los helpers crean los
# directorios padre necesarios sin migrar ni tocar el estado legacy.
PIPELINE_DIR_ABS="$(dirname "$(mefisto_state_path '.state')")"
LOG_DIR_ABS="$(dirname "$(mefisto_state_path 'logs/.state')")"
LOG_FILE_ABS="$(mefisto_state_path "logs/$(basename "$LOG_FILE")")"
LOG_FILE="$LOG_FILE_ABS"
EVENTS_LOG_ABS="$(mefisto_state_path 'events.log')"
HISTORY_FILE="$(mefisto_state_path 'pipeline-history.jsonl')"
echo "Pipeline iniciado: $TIMESTAMP" > "$LOG_FILE_ABS"

# Separador de sesión en events.log
echo "─── SESSION $TIMESTAMP issue:${ISSUE_NUM:-file} from-stage:$FROM_STAGE ───" >> "$EVENTS_LOG_ABS"

# ─── Resolver --models (issue #712, parser de #708) ─────────────────────────
# Se valida ANTES de crear el worktree (CA-1): un --models malformado debe
# abortar temprano, no a mitad de Stage 1 con un worktree ya en disco.
parse_stage_models "$MODELS_SPEC" \
    || abort "--models mal formado: ${PIPELINE_STAGE_MODELS_ERROR:-formato invalido}"
if [ -n "$PIPELINE_STAGE_MODELS" ]; then
    STAGE_MODELS_LOG="$(format_stage_models_for_log)"
    log "Modelos por stage (--models): $STAGE_MODELS_LOG"
    echo "[$(date +%H:%M:%S)] MODELS: $STAGE_MODELS_LOG" >> "$EVENTS_LOG_ABS"
fi

# La frontera neutral se resuelve antes de crear el worktree: un runtime o
# runner invalido no debe dejar evidencia ni ramas transitorias en disco.
MEFISTO_AGENT_TIMEOUT_SECONDS="${MEFISTO_AGENT_TIMEOUT_SECONDS:-1800}"
case "$MEFISTO_AGENT_TIMEOUT_SECONDS" in ''|*[!0-9]*) abort "MEFISTO_AGENT_TIMEOUT_SECONDS '$MEFISTO_AGENT_TIMEOUT_SECONDS' no es un entero" ;; esac
[ "$MEFISTO_AGENT_TIMEOUT_SECONDS" -gt 0 ] || abort "MEFISTO_AGENT_TIMEOUT_SECONDS debe ser mayor que 0"
RUN_AGENT_BIN="${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}"
[ -x "$RUN_AGENT_BIN" ] || abort "No es ejecutable el runner neutral: $RUN_AGENT_BIN"
if ! mefisto_resolve_runtime >/dev/null; then
    abort "No se pudo resolver el runtime activo: ${MEFISTO_RUNTIME_ERROR:-motivo desconocido}"
fi
MEFISTO_RUNTIME_RESUELTO="$MEFISTO_RESOLVED_RUNTIME"
MEFISTO_RUNTIME_JSON="\"$MEFISTO_RUNTIME_RESUELTO\""
# Segunda fase de la identidad (issue #1363): revalidada contra el runtime ya
# resuelto, antes de la primera escritura de status/history durable. Mismo
# texto de degradacion que tooling-pipeline.sh l.352.
HARNESS_IDENTITY_JSON="$(get_harness_identity_json "$MEFISTO_RUNTIME_RESUELTO")"
if ! runtime_cli_available "$MEFISTO_RUNTIME_RESUELTO"; then
    abort "Falta el CLI del runtime resuelto ('$MEFISTO_RUNTIME_RESUELTO')"
fi
if [ "$(printf '%s' "$HARNESS_IDENTITY_JSON" | jq -r '.identity_state')" != "complete" ]; then
    warn "Identidad de distribucion degradada: metadata ausente o invalida; version/commit se registran como null"
fi

# --- Modelos neutrales por perfil (issue #1362, MEF-ADR-0049 decision 4) -----
# El override publico (--models) gana por clave exacta; sin override el
# mapping opcional del consumidor y el adaptador del runtime activo deciden, o
# se hereda -- misma precedencia que tooling-pipeline.sh (resolve_tooling_model,
# l.370-390), generalizada a la tabla de 7 agentes de este pipeline. Se calcula
# antes del worktree (CA-1): un mapping malformado o un runtime sin adaptador
# debe abortar temprano, no a mitad de un stage con un worktree ya en disco.
CONSUMER_MODELS_FILE="$(git rev-parse --show-toplevel)/.mefisto/models.json"

# _tdd_agent_profile <agent_id>
#
# Tabla agente -> perfil de los stages TDD (CA-1): unico punto que decide el
# perfil neutral de cada agente del pipeline. Imprime el perfil por stdout y
# retorna 0; un agente fuera de la tabla retorna 1 sin imprimir nada -- el
# caller debe abortar, nunca heredar en silencio.
_tdd_agent_profile() {
    case "$1" in
        test-writer|projection-test-writer|implementer|projection-implementer|smoke-test-writer|domain-scaffolder)
            printf 'balanced' ;;
        reviewer)
            printf 'deep' ;;
        *)
            return 1 ;;
    esac
}

# resolve_tdd_model <clave> <agent_id> <perfil>
#
# Plantilla: resolve_tooling_model (scripts/tooling-pipeline.sh l.370-390).
# El override de <clave> gana (o, si no hay, el de <agent_id> -- la cadena
# fina que usan los sub-stages de remediacion, patch-test-writer/patch-
# implementer -> $STAGE1_AGENT/$STAGE2_AGENT, CA-2: sin esa caida un
# experimento '--models test-writer=X' correria el Stage 1 con X y la
# remediacion con el default, dos modelos para el mismo rol en una corrida).
# Sin override, mefisto_resolve_model decide con el mapping opcional del
# consumidor y el adaptador del runtime activo. Dos efectos de lado antes de
# retornar (CA-3): fija RESOLVED_TDD_MODEL (vacio = heredar, solo cuando ni el
# mapping ni el adaptador fijan modelo para ese perfil) y escribe la evidencia
# en events.log. Aborta si la resolucion del adaptador falla -- nunca deja
# pasar un modelo indefinido en silencio (CA-1).
RESOLVED_TDD_MODEL=""
resolve_tdd_model() {
    local key="$1" agent_id="$2" profile="$3" explicit=""
    explicit="$(resolve_stage_model "$key" "$(resolve_stage_model "$agent_id" "")")"
    if [ -n "$explicit" ]; then
        RESOLVED_TDD_MODEL="$explicit"
        echo "[$(date +%H:%M:%S)] MODELS: $key runtime=$MEFISTO_RUNTIME_RESUELTO perfil=$profile solicitado='$explicit' resuelto='$RESOLVED_TDD_MODEL' (override --models)" >> "$EVENTS_LOG_ABS"
        return 0
    fi
    local output
    output="$(mktemp)"
    if ! mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile" "" "$CONSUMER_MODELS_FILE" > "$output"; then
        rm -f "$output"
        abort "No se pudo resolver el modelo de $agent_id (perfil $profile): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"
    fi
    RESOLVED_TDD_MODEL="$(cat "$output")"; rm -f "$output"
    echo "[$(date +%H:%M:%S)] MODELS: $key runtime=$MEFISTO_RUNTIME_RESUELTO perfil=$profile solicitado=<automatico> resuelto='${RESOLVED_TDD_MODEL:-<heredado>}'" >> "$EVENTS_LOG_ABS"
}

# --- Anunciar el modo variante (issue #713) -------------------------------
# El label ya se valido y ya derivo los nombres de archivo arriba, junto al
# parseo de argumentos; aqui solo se anuncia, que es lo primero que se puede
# hacer una vez existen el log del pipeline y events.log.
if [ -n "$VARIANT_LABEL" ]; then
    log "Modo variante: '$VARIANT_LABEL' -- sin push, sin PR, sin comentario al issue (CA-3); rama queda local"
    echo "[$(date +%H:%M:%S)] VARIANT: $VARIANT_LABEL" >> "$EVENTS_LOG_ABS"
fi

PIPELINE_TMP_DIR="$(mktemp -d -t mefisto-tdd)" || abort "No se pudo crear el directorio temporal del pipeline"
[ -d "$PIPELINE_TMP_DIR" ] || abort "No se pudo crear el directorio temporal del pipeline"
trap 'rm -rf "${PIPELINE_TMP_DIR:-}"' EXIT

# ─── Invocacion neutral unica para stages sin politicas de run_agent ──────────
# Debe declararse antes de Stage 0: Bash solo conoce una funcion despues de
# evaluar su definicion, y el scaffold se ejecuta durante el flujo superior.
# invoke_agent_once <agent_id> <prompt_file> <events_file> <log_file> [model]
invoke_agent_once() {
    local agent="$1" prompt_file="$2" events_file="$3" log_file="$4" model="${5:-}"
    local system_file="$PIPELINE_TMP_DIR/noninteractive.system.md"
    local runner_file="${events_file%.events.jsonl}.runner.log" start_ts run_exit=0
    [ -f "$system_file" ] || printf '%s\n' 'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.' > "$system_file"
    start_ts=$(date +%s)
    local args=(--runtime "$MEFISTO_RUNTIME_RESUELTO" --agent "$agent" --cwd "$WORKTREE_PATH" --prompt-file "$prompt_file" --system-file "$system_file" --event-log "$events_file" --events-log "$EVENTS_LOG_ABS" --redact-observability --timeout "$MEFISTO_AGENT_TIMEOUT_SECONDS")
    [ -n "$model" ] && args+=(--model "$model")
    if "$RUN_AGENT_BIN" "${args[@]}" >"$runner_file" 2>&1; then run_exit=0; else run_exit=$?; fi
    derive_stage_log_from_stream "$events_file" "" "$log_file"
    LAST_AGENT_METRICS_JSON=$(compute_stage_metrics "$events_file")
    LAST_AGENT_DURATION=$(( $(date +%s) - start_ts ))
    return "$run_exit"
}

# ─── Obtener contexto del issue/HU ───────────────────────────────────────────
header "Preparando contexto"

ISSUE_CONTEXT=""
ISSUE_TITLE=""

if [ -n "$ISSUE_NUM" ]; then
    log "Descargando issue #$ISSUE_NUM..."
    ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --json number,title,body,state,labels 2>>"${LOG_FILE_ABS:-$LOG_FILE}") \
        || abort "No se pudo obtener el issue #$ISSUE_NUM"
    ISSUE_STATE=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])" 2>/dev/null || echo "UNKNOWN")
    if [ "$ISSUE_STATE" != "OPEN" ]; then
        abort "El issue #$ISSUE_NUM está $ISSUE_STATE — solo se procesan issues abiertos."
    fi
    ISSUE_TITLE=$(echo "$ISSUE_JSON" | grep -o '"title":"[^"]*"' | sed 's/"title":"//;s/"//')
    ISSUE_BODY=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['body'])" 2>/dev/null \
        || echo "$ISSUE_JSON" | sed 's/.*"body":"//;s/","[^"]*":".*//;s/\\n/\n/g;s/\\r//g')
    ISSUE_CONTEXT="# Issue #$ISSUE_NUM: $ISSUE_TITLE

$ISSUE_BODY"
    log "Issue: $ISSUE_TITLE"

    # Rama read-side (issue #371, CA-4): la deteccion usa el label tipo:projection
    # del issue, con el mismo criterio de match exacto sobre el NOMBRE del label que
    # _resolve_from_labels en _pipeline-common.sh (grep -x, no substring). Se extrae
    # con python3 desde el JSON ya descargado -- sin segunda llamada a gh y sin
    # depender de que gh serialice sin espacios: un grep sobre el JSON crudo se
    # rompe en silencio si el formato cambia y despacharia los agentes write-side
    # sobre un issue read-side, sin error visible en un pipeline headless.
    ISSUE_LABELS=$(echo "$ISSUE_JSON" \
        | python3 -c "import sys,json; print('\n'.join(l['name'] for l in json.load(sys.stdin).get('labels') or []))" 2>/dev/null \
        || echo "")
    if echo "$ISSUE_LABELS" | grep -qx 'tipo:projection'; then
        IS_PROJECTION=true
        STAGE1_AGENT="projection-test-writer"
        STAGE2_AGENT="projection-implementer"
        STAGE1_LABEL="Projection Test Writer"
        STAGE2_LABEL="Projection Implementer"
        log "Label tipo:projection detectado — despachando trio read-side ($STAGE1_AGENT / $STAGE2_AGENT)"
    fi

elif [ -n "$INPUT_FILE" ]; then
    [ -f "$INPUT_FILE" ] || abort "Archivo no encontrado: $INPUT_FILE"
    ISSUE_TITLE=$(basename "$INPUT_FILE" .md)
    ISSUE_CONTEXT=$(cat "$INPUT_FILE")
    log "Archivo: $INPUT_FILE"
fi

# Guardar contexto para referencia
echo "$ISSUE_CONTEXT" > "$(mefisto_state_path 'input.md')"

# ─── Preparar worktree ───────────────────────────────────────────────────────
header "Preparando worktree"

REPO_ROOT=$(git rev-parse --show-toplevel)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Generar slug para el nombre del worktree
if [ -n "$ISSUE_NUM" ]; then
    SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | tr ' áéíóúàèìòùäëïöü' ' aeiouaeiouaeiou' | sed 's/[^a-z0-9 ]//g' | tr -s ' ' '-' | cut -c1-40 | sed 's/-$//')
    BRANCH_NAME="worktree-issue-${ISSUE_NUM}-${SLUG}"
else
    SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-zA-Z0-9]/-/g' | tr -s '-' | cut -c1-40 | sed 's/-$//')
    BRANCH_NAME="worktree-tdd-${SLUG}"
fi
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
    # ── Modo retomar: el worktree ya debe existir ──
    [ -d "$WORKTREE_PATH" ] || abort "No existe el worktree en $WORKTREE_PATH. No se puede retomar desde Stage $FROM_STAGE."
    log "Retomando desde Stage $FROM_STAGE — worktree existente: $WORKTREE_PATH"
    # [Cambio 4] Eliminado código muerto: solo usar merge-base
    SNAPSHOT_COMMIT=$(git -C "$WORKTREE_PATH" merge-base HEAD main)
    log "Snapshot detectado: $SNAPSHOT_COMMIT"
else
    # ── Modo normal: crear worktree nuevo ──
    # El worktree se ramifica SIEMPRE desde origin/main actualizado, sea cual sea
    # la rama del cwd. El guard queda solo como contexto informativo en el log.
    if [ "$CURRENT_BRANCH" != "main" ] && [ "$CURRENT_BRANCH" != "master" ]; then
        warn "cwd en rama '$CURRENT_BRANCH' (no main/master): el worktree se creará igual desde origin/main"
    fi

    log "Actualizando origin/main..."
    git fetch origin main >>"$LOG_FILE" 2>&1 || abort "No se pudo hacer fetch de origin/main"

    # [Cambio 8] Idempotencia: si el worktree ya existe, limpiarlo
    if [ -d "$WORKTREE_PATH" ]; then
        warn "El worktree ya existe: $WORKTREE_PATH — limpiando para reiniciar..."
        git worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 || true
        git branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
    fi
    # También limpiar rama huérfana sin worktree
    if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
        warn "La rama $BRANCH_NAME ya existe sin worktree — eliminándola..."
        git branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
    fi

    log "Creando worktree: $WORKTREE_PATH (base: origin/main)"
    mkdir -p "$(dirname "$WORKTREE_PATH")"
    git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" origin/main >>"$LOG_FILE" 2>&1 \
        || abort "No se pudo crear el worktree desde origin/main"

    success "Worktree creado: $WORKTREE_PATH"

    update_status "setup" "running"

    SNAPSHOT_COMMIT=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
    log "Snapshot: $SNAPSHOT_COMMIT"

    # --- Stage 0: Scaffold de dominio nuevo (solo en modo normal, no en --from-stage) ---
    if [ -n "$SCAFFOLD_DOMAIN" ]; then
        header "Stage 0: Scaffold del dominio '$SCAFFOLD_DOMAIN'"
        update_status "scaffold" "running"

        LOG_SCAFFOLD="$LOG_DIR_ABS/stage-0-scaffold-${TIMESTAMP}.log"
        EVENTS_SCAFFOLD="${LOG_SCAFFOLD%.log}.events.jsonl"
        SCAFFOLD_PROMPT_FILE="$PIPELINE_TMP_DIR/0-domain-scaffolder.prompt.md"
        echo "[$(date +%H:%M:%S)] === STAGE 0: domain-scaffolder ===" >> "$EVENTS_LOG_ABS"

        SCAFFOLD_PROMPT="Crea el scaffold para el dominio '$SCAFFOLD_DOMAIN'. El usuario ya confirmo la creacion — omite la confirmacion del Paso 0 y procede directamente a crear el proyecto.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."
        printf '%s' "$SCAFFOLD_PROMPT" > "$SCAFFOLD_PROMPT_FILE"
        resolve_tdd_model "domain-scaffolder" "domain-scaffolder" "$(_tdd_agent_profile "domain-scaffolder")"
        log "Invocando domain-scaffolder (modelo: ${RESOLVED_TDD_MODEL:-<heredado>})..."
        SCAFFOLD_EXIT=0
        invoke_agent_once "domain-scaffolder" "$SCAFFOLD_PROMPT_FILE" "$EVENTS_SCAFFOLD" "$LOG_SCAFFOLD" "$RESOLVED_TDD_MODEL" || SCAFFOLD_EXIT=$?
        SCAFFOLD_ELAPSED=$LAST_AGENT_DURATION
        AGENT_SCAFFOLD_DUR=$SCAFFOLD_ELAPSED
        # CA-2 (issue #1363): enriquecida con pipeline/issue/variant/stage/
        # agent/profile/runtime/modelo/identidad -- misma forma que las
        # metricas de run_agent.
        AGENT_SCAFFOLD_METRICS_JSON="$(enrich_stage_metrics "tdd" "$EVENTS_SCAFFOLD" "$LAST_AGENT_METRICS_JSON" "${ISSUE_NUM:-}" "${VARIANT_LABEL_JSON:-null}" "0" "domain-scaffolder" "$(_tdd_agent_profile "domain-scaffolder")" "$HARNESS_IDENTITY_JSON")"
        # CA-3/CA-5 (issue #646): metricas del scaffold, cosechadas al cierre
        # del stage y respaldadas en disco ANTES de decidir si se aborta.
        echo "$AGENT_SCAFFOLD_METRICS_JSON" > "$(mefisto_state_path "metrics/tdd-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}-stage-0-domain-scaffolder.json")" 2>/dev/null || true

        if [ "$SCAFFOLD_EXIT" -ne 0 ] || ! agent_events_completed_successfully "$EVENTS_SCAFFOLD"; then
            echo "[$(date +%H:%M:%S)] FALLO domain-scaffolder (${SCAFFOLD_ELAPSED}s, exit $SCAFFOLD_EXIT)" >> "$EVENTS_LOG_ABS"
            abort "El scaffold del dominio '$SCAFFOLD_DOMAIN' fallo despues de ${SCAFFOLD_ELAPSED}s. Revisa: $LOG_SCAFFOLD"
        fi

        # Verificar que el proyecto fue creado
        PASCAL_CASE=$(echo "$SCAFFOLD_DOMAIN" | awk -F'-' '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1' OFS='')
        if [ ! -d "$WORKTREE_PATH/src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE" ]; then
            abort "El scaffold no creo src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE — revisa: $LOG_SCAFFOLD"
        fi

        echo "[$(date +%H:%M:%S)] OK domain-scaffolder (${SCAFFOLD_ELAPSED}s)" >> "$EVENTS_LOG_ABS"
        success "Scaffold del dominio '$SCAFFOLD_DOMAIN' completado en ${SCAFFOLD_ELAPSED}s"
        update_status "scaffold" "completed"

        # Actualizar snapshot: los diffs de Stage 1-3 solo muestran la implementacion, no el scaffold
        SNAPSHOT_COMMIT=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
        log "Snapshot actualizado post-scaffold: $SNAPSHOT_COMMIT"
    fi
fi

# La doctrina de agentes anterior a #1387 todavia intenta escribir summaries
# en el estado legacy. Ambos directorios deben existir tambien al reanudar un
# worktree; el pipeline solo escribe en el canonico y conserva el otro como
# destino transitorio de esos agentes.
mefisto_state_path 'summaries/.state' "$WORKTREE_PATH" >/dev/null
legacy_summary_dir="$WORKTREE_PATH/$(basename "$(dirname "$MEFISTO_LEGACY_STATE_DIR")")/$(basename "$MEFISTO_LEGACY_STATE_DIR")/summaries"
mkdir -p "$legacy_summary_dir"

# Detectar señal de refactoring pre-existente (worktree previo con --from-stage)
# Ubicacion: pipeline-state/ en la raiz del worktree (NO .claude/) — el runtime
# de Claude Code intercepta escrituras a .claude/** en worktrees aun con
# bypassPermissions, lo que dejaba al agente sin forma de senalizar refactor puro.
# Decision documentada en docs/adr/mef-adr-0017-archivo-senal-refactor-fuera-de-claude.md.
REFACTOR_SIGNAL_PATH="$WORKTREE_PATH/pipeline-state/refactor-signal.md"
# Compatibilidad: aceptar la ubicacion legacy si existe (worktrees previos)
LEGACY_REFACTOR_SIGNAL_PATH="$WORKTREE_PATH/.claude/pipeline/refactor-signal.md"
if [ ! -f "$REFACTOR_SIGNAL_PATH" ] && [ -f "$LEGACY_REFACTOR_SIGNAL_PATH" ]; then
    REFACTOR_SIGNAL_PATH="$LEGACY_REFACTOR_SIGNAL_PATH"
fi
if [ -f "$REFACTOR_SIGNAL_PATH" ]; then
    IS_REFACTOR=true
    REFACTOR_JUSTIFICATION=$(grep "^JUSTIFICATION=" "$REFACTOR_SIGNAL_PATH" | cut -d= -f2- || echo "no especificada")
    log "Señal de refactoring detectada (pre-existente): $REFACTOR_JUSTIFICATION"
fi

# Detectar señal de fase roja no aplicable pre-existente (worktree previo con
# --from-stage). Gemela de la deteccion de refactor-signal.md de arriba (issue
# #585), pero solo se honra en la ruta read-side (STAGE1_AGENT=projection-test-writer)
# — en la ruta write-side el rojo siempre es alcanzable, asi que la señal se
# ignora aunque el archivo exista. Sin ubicacion legacy: nace directo en
# pipeline-state/ (MEF-ADR-0017).
NO_RED_SIGNAL_PATH="$WORKTREE_PATH/pipeline-state/no-red-signal.md"
if [ "$STAGE1_AGENT" = "projection-test-writer" ] && [ -f "$NO_RED_SIGNAL_PATH" ]; then
    IS_NO_RED_SIGNAL=true
    NO_RED_JUSTIFICATION=$(grep "^JUSTIFICATION=" "$NO_RED_SIGNAL_PATH" | cut -d= -f2- || echo "no especificada")
    log "Señal de fase roja no aplicable detectada (pre-existente): $NO_RED_JUSTIFICATION"
fi

# Asegurar que el directorio pipeline-state/ existe en el worktree para que
# test-writer/projection-test-writer puedan escribir refactor-signal.md /
# no-red-signal.md sin restricciones.
mkdir -p "$WORKTREE_PATH/pipeline-state"

# ─── Función auxiliar para recolectar resumen de agente ─────────────────────
collect_summary() {
    local stage="$1" agent="$2"
    local f
    f="$(mefisto_state_read_first "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH" 2>/dev/null || true)"
    if [ -f "$f" ]; then cat "$f"; else echo "_(El agente no generó resumen)_"; fi
}

# ─── Frontera neutral para los stages TDD ────────────────────────────────────
run_agent() {
    local stage="$1" agent="$2" prompt="$3"
    local log_base="$LOG_DIR_ABS/stage-${stage}-${agent}-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}"
    local log_stage="${log_base}.log" events_file=""
    local prompt_file="$PIPELINE_TMP_DIR/${stage}-${agent}.prompt.md"
    local system_file="$PIPELINE_TMP_DIR/${stage}-${agent}.system.md"
    local runner_file="$PIPELINE_TMP_DIR/${stage}-${agent}.runner.log"
    local start_ts run_exit=0 elapsed=0 failure_type="" hold_started="" hold_total=0 resume_session="" resume_degraded=false attempt=0 denial_retry_used=false
    local entry_commit summary_file legacy_summary_file summary_path metrics_json="null"
    summary_path="$(mefisto_state_path "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH")"
    prompt="$prompt

Al cerrar este stage, deja tu resumen en: $summary_path"
    printf '%s' "$prompt" > "$prompt_file"
    printf '%s\n' 'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.' > "$system_file"
    entry_commit="$(git -C "$WORKTREE_PATH" rev-parse HEAD)"
    summary_file="$summary_path"
    # En --from-stage puede quedar el resumen de una corrida anterior. No puede
    # contar como evidencia de que una sonda reanudada de ESTA invocacion llego
    # al final de su contrato.
    rm -f "$summary_file"
    legacy_summary_file="$(mefisto_state_read_first "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH" 2>/dev/null || true)"
    [ -z "$legacy_summary_file" ] || rm -f "$legacy_summary_file"
    echo "[$(date +%H:%M:%S)] === STAGE $stage: $agent ===" >> "$EVENTS_LOG_ABS"
    case "$agent" in test-writer|projection-test-writer) AGENT_TW_RES="running" ;; implementer|projection-implementer) AGENT_IM_RES="running" ;; reviewer) AGENT_RV_RES="running" ;; esac
    local AGENT_MODEL_OVERRIDE agent_profile
    agent_profile="$(_tdd_agent_profile "$agent")" || abort "Agente '$agent' fuera de la tabla de perfiles TDD (CA-1, issue #1362)"
    resolve_tdd_model "$agent" "$agent" "$agent_profile"
    AGENT_MODEL_OVERRIDE="$RESOLVED_TDD_MODEL"
    update_status "$stage-$agent" "running"
    log "Invocando $agent (modelo: ${AGENT_MODEL_OVERRIDE:-<heredado>})..."
    start_ts=$(date +%s)
    while :; do
        attempt=$((attempt + 1))
        events_file="${log_base}-attempt-${attempt}.events.jsonl"
        local attempt_prompt="$prompt_file" attempt_resume=false
        if [ -n "$resume_session" ]; then
            attempt_resume=true
            attempt_prompt="$PIPELINE_TMP_DIR/${stage}-${agent}-resume-${attempt}.prompt.md"
            printf '%s\n' 'Continue the same stage and complete its summary.' > "$attempt_prompt"
        fi
        local args=(--runtime "$MEFISTO_RUNTIME_RESUELTO" --agent "$agent" --cwd "$WORKTREE_PATH" --prompt-file "$attempt_prompt" --system-file "$system_file" --event-log "$events_file" --events-log "$EVENTS_LOG_ABS" --redact-observability --timeout "$MEFISTO_AGENT_TIMEOUT_SECONDS")
        [ -n "$AGENT_MODEL_OVERRIDE" ] && args+=(--model "$AGENT_MODEL_OVERRIDE")
        [ -n "$resume_session" ] && args+=(--resume-session "$resume_session")
        if "$RUN_AGENT_BIN" "${args[@]}" >"$runner_file" 2>&1; then run_exit=0; else run_exit=$?; fi
        [ "$attempt_prompt" = "$prompt_file" ] || rm -f "$attempt_prompt"
        elapsed=$(( $(date +%s) - start_ts ))
        derive_stage_log_from_stream "$events_file" "" "$log_stage"
        metrics_json="$(compute_stage_metrics "$events_file")"
        # CA-2 (issue #1363): enriquecida con pipeline/issue/variant/stage/
        # agent/profile/runtime/modelo/identidad -- cruce con metrics-report.sh
        # y la estimacion de costos (MEF-ADR-0054).
        metrics_json="$(enrich_stage_metrics "tdd" "$events_file" "$metrics_json" "${ISSUE_NUM:-}" "${VARIANT_LABEL_JSON:-null}" "$stage" "$agent" "$agent_profile" "$HARNESS_IDENTITY_JSON")"
        echo "$metrics_json" > "$(mefisto_state_path "metrics/tdd-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}-stage-${stage}-${agent}.json")" 2>/dev/null || true
        local denials attempt_has_work=false
        denials="$(agent_events_denials "$events_file")"
        case "$denials" in ''|*[!0-9]*) denials=0 ;; esac
        if ! git -C "$WORKTREE_PATH" diff --quiet "$entry_commit"..HEAD -- . "${PIPELINE_OWN_WRITES[@]}" 2>/dev/null \
            || [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- tests/ src/ "${PIPELINE_OWN_WRITES[@]}" 2>/dev/null)" ]; then attempt_has_work=true; fi
        if [ "$denials" -gt 0 ] && [ "$attempt_has_work" = false ] && [ "$denial_retry_used" = false ]; then
            denial_retry_used=true
            resume_session=""
            warn "$agent: $denials denegacion(es) neutrales sin trabajo; reintentando una vez desde cero"
            echo "[$(date +%H:%M:%S)] RETRY $agent: denials=$denials" >> "$EVENTS_LOG_ABS"
            continue
        fi
        if [ "$run_exit" -eq 0 ] && agent_events_completed_successfully "$events_file"; then failure_type=""; break; fi
        failure_type="$(classify_neutral_agent_failure "$run_exit" "$events_file")"
        log "$agent falló después de ${elapsed}s — tipo: $failure_type"
        echo "[$(date +%H:%M:%S)] FALLO $agent: $failure_type" >> "$EVENTS_LOG_ABS"
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
        local slept
        if ! slept=$(agent_hold_wait "$EVENTS_LOG_ABS" "$failure_type" "$hold_started" "$(agent_events_resets_at "$events_file")"); then break; fi
        hold_total=$((hold_total + slept))
        HOLD_TOTAL="$hold_total"
        summary_file="$(mefisto_state_read_first "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH" 2>/dev/null || true)"
        if [ "$attempt_resume" = true ] && [ ! -s "$summary_file" ]; then
            warn "$agent: la sesion reanudada termino sin resumen; se degrada permanentemente a inicio limpio"
            resume_degraded=true
            resume_session=""
        elif [ "$resume_degraded" = false ]; then
            resume_session="$(agent_events_session_id "$events_file")"
            if [ -z "$resume_session" ]; then
                warn "$agent: terminal sin session_id; la sonda inicia de cero"
            elif ! runtime_supports_resume "$MEFISTO_RUNTIME_RESUELTO"; then
                warn "$agent: runtime sin capacidad de reanudacion; la sonda inicia de cero"
                resume_session=""
            fi
        fi
    done
    HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL="$hold_total"
    if [ -n "$failure_type" ]; then
        local recoverable_work=false
        case "$failure_type" in TIMEOUT|KILLED|STREAM_CUT|PROTOCOL_INVALID) ;; *)
            if ! git -C "$WORKTREE_PATH" diff --quiet "$entry_commit"..HEAD -- . "${PIPELINE_OWN_WRITES[@]}" 2>/dev/null \
                || [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- tests/ src/ "${PIPELINE_OWN_WRITES[@]}" 2>/dev/null)" ]; then
                case "$stage" in 1) dotnet build "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 && recoverable_work=true ;; 2|3|merge) local test_rc=0; run_tests_projects "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || test_rc=$?; [ "$test_rc" -eq 0 ] && recoverable_work=true ;; esac
            fi ;; esac
        if [ "$recoverable_work" = true ]; then
            warn "$agent: runner retorno $failure_type pero hay trabajo util completado — continuando"
            echo "[$(date +%H:%M:%S)] RECUPERADO $agent: trabajo util detectado post-$failure_type, continuando" >> "$EVENTS_LOG_ABS"
            failure_type=""
        else
            case "$agent" in test-writer|projection-test-writer) AGENT_TW_DUR=$elapsed; AGENT_TW_RES="failed" ;; implementer|projection-implementer) AGENT_IM_DUR=$elapsed; AGENT_IM_RES="failed" ;; smoke-test-writer) AGENT_ST_DUR=$elapsed; AGENT_ST_RES="failed" ;; reviewer) AGENT_RV_DUR=$elapsed; AGENT_RV_RES="failed" ;; esac
            case "$stage" in 1) AGENT_TW_METRICS_JSON="$metrics_json" ;; 2) AGENT_IM_METRICS_JSON="$metrics_json" ;; 2b) AGENT_ST_METRICS_JSON="$metrics_json" ;; 3) AGENT_RV_METRICS_JSON="$metrics_json" ;; esac
            update_status "$stage-$agent" "failed"
            case "$failure_type" in TIMEOUT|KILLED|STREAM_CUT|PROTOCOL_INVALID) abort "$agent falló ($failure_type); se descarta trabajo parcial" ;; esac
            abort "$agent falló ($failure_type). Log completo: $log_stage"
        fi
    fi
    case "$stage" in 1) AGENT_TW_METRICS_JSON="$metrics_json" ;; 2) AGENT_IM_METRICS_JSON="$metrics_json" ;; 2b) AGENT_ST_METRICS_JSON="$metrics_json" ;; 3) AGENT_RV_METRICS_JSON="$metrics_json" ;; esac
    LAST_AGENT_DURATION=$((elapsed - hold_total)); LAST_AGENT_METRICS_JSON="$metrics_json"
    log "$agent completado en ${LAST_AGENT_DURATION}s"
}

# ─── Función auxiliar: auto-commit de seguridad ──────────────────────────────
# Solo commitea cambios en tests/ y src/ (ignora .claude/, bin/, obj/, etc.)
auto_commit_if_needed() {
    local phase="$1"     # "roja", "verde", "refactor"
    local msg="$2"       # mensaje de commit

    # Revisar si hay cambios en tests/ o src/ específicamente
    if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- tests/ src/)" ]; then
        log "El agente no commitió cambios en tests/src. Haciendo commit automático (fase $phase)..."
        git -C "$WORKTREE_PATH" add tests/ src/ >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1
        git -C "$WORKTREE_PATH" commit -m "$msg" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || true
    fi
}

# ─── STAGE 1: Test Writer (fase roja) ────────────────────────────────────────
if [ "$FROM_STAGE" -le 1 ]; then
    header "Stage 1: $STAGE1_LABEL (fase roja)"

    STAGE1_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Contexto de la historia de usuario a implementar:

$ISSUE_CONTEXT

Tu tarea: escribe los tests unitarios para esta HU y crea los stubs mínimos de compilación. Sigue todas las instrucciones de tu rol de $STAGE1_AGENT.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~5-6 s de reloj (turno sonnet) -- el trabajo que ese turno manda a hacer es barato en comparacion: en el diagnostico Fase 0, dotnet (build/test) ocupo solo ~11% del wall total de una corrida, frente a ~86% de tiempo de API (turnos). Lo caro es el turno, no la herramienta. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una.
- Tu verificacion propia es 'dotnet build', UNA vez, cuando creas que terminaste -- no la repitas despues de cada archivo que escribas. No corras 'dotnet test' salvo donde tu rol lo pida explicitamente (el carril de señal de refactor puro, para confirmar el baseline verde): en el carril normal tus tests fallan por definicion, y confirmar esa fase roja no es trabajo tuyo -- apenas termines este stage, el pipeline compila (Gate 1a) y corre toda la suite para confirmarla (Gate 1b).
- No re-inspecciones el arbol con 'git status' ni 'git diff' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~5-6 s, y solo vale la pena si te ahorra un error que costaria mas.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

    run_agent "1" "$STAGE1_AGENT" "$STAGE1_PROMPT"

    # Detectar señal de refactor ANTES del gate de "no genero archivos".
    # Si el agente concluyo refactoring puro, la senal es la unica evidencia
    # esperada en tests/ y src/ — abortar antes de chequearla seria un falso negativo.
    # Tambien re-evaluamos el path por si el agente uso la ubicacion legacy.
    if [ ! -f "$REFACTOR_SIGNAL_PATH" ] && [ -f "$LEGACY_REFACTOR_SIGNAL_PATH" ]; then
        REFACTOR_SIGNAL_PATH="$LEGACY_REFACTOR_SIGNAL_PATH"
    fi
    if [ -f "$REFACTOR_SIGNAL_PATH" ] && [ "$IS_REFACTOR" = false ]; then
        IS_REFACTOR=true
        REFACTOR_JUSTIFICATION=$(grep "^JUSTIFICATION=" "$REFACTOR_SIGNAL_PATH" | cut -d= -f2- || echo "no especificada")
        # REMOVED_TESTS es opcional (compatibilidad con senales viejas, issue #294): default 0.
        REMOVED_TESTS=$(grep "^REMOVED_TESTS=" "$REFACTOR_SIGNAL_PATH" | cut -d= -f2- || echo "0")
        if ! [[ "$REMOVED_TESTS" =~ ^[0-9]+$ ]]; then
            warn "REMOVED_TESTS='$REMOVED_TESTS' en la señal no es un entero valido — se usa 0"
            REMOVED_TESTS=0
        fi
        log "Señal de refactoring detectada: $REFACTOR_JUSTIFICATION (REMOVED_TESTS=$REMOVED_TESTS)"
    fi

    # Detectar señal de fase roja no aplicable recien creada por esta invocacion
    # (issue #585) — mismo motivo que el re-chequeo de refactor-signal de arriba:
    # en una corrida nueva (no --from-stage) la señal nace durante este run_agent,
    # no antes. Nunca se honra en la ruta write-side (test-writer).
    if [ "$STAGE1_AGENT" = "projection-test-writer" ] && [ -f "$NO_RED_SIGNAL_PATH" ] && [ "$IS_NO_RED_SIGNAL" = false ]; then
        IS_NO_RED_SIGNAL=true
        NO_RED_JUSTIFICATION=$(grep "^JUSTIFICATION=" "$NO_RED_SIGNAL_PATH" | cut -d= -f2- || echo "no especificada")
        log "Señal de fase roja no aplicable detectada: $NO_RED_JUSTIFICATION"
    fi

    # Validar que el agente produjo trabajo: cambios en tests/src O senal de refactor.
    # Si no hay nada, distinguir entre "agente realmente fallo" y "razono refactor pero
    # no pudo escribir la senal" (Bug 1: runtime intercepta escrituras a .claude/**).
    if [ "$IS_REFACTOR" = false ] \
       && git -C "$WORKTREE_PATH" diff --quiet "$SNAPSHOT_COMMIT" HEAD 2>/dev/null \
       && [ -z "$(git -C "$WORKTREE_PATH" status --porcelain -- tests/ src/)" ]; then
        STAGE1_LOG="$LOG_DIR_ABS/stage-1-${STAGE1_AGENT}-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}.log"
        if [ -f "$STAGE1_LOG" ] && grep -qiE "refactor.*pur|REFACTOR_ONLY|refactor-signal|refactoring puro" "$STAGE1_LOG"; then
            abort "El $STAGE1_AGENT detecto refactor puro pero no creo el archivo señal en $REFACTOR_SIGNAL_PATH (ni en la ubicacion legacy). Probable causa: el runtime intercepto la escritura. Revisa el log: $STAGE1_LOG"
        fi
        abort "El $STAGE1_AGENT no generó ningún archivo. Verifica que el agente '$STAGE1_AGENT' está disponible en el runtime activo."
    fi

    # Gate 1a: debe compilar
    log "Gate: verificando compilación..."
    dotnet build "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
        || abort "Stage 1 fallido: el proyecto no compila después del $STAGE1_AGENT. Revisa $LOG_DIR/stage-1-${STAGE1_AGENT}.log"

    # Carril solo smoke (issue #2357): deteccion determinista por diff.
    SMOKE_DETECT_OUT=""
    if [ "$IS_REFACTOR" = false ] && SMOKE_DETECT_OUT=$(detect_smoke_only "$WORKTREE_PATH" "$SNAPSHOT_COMMIT"); then
        IS_SMOKE_ONLY=true
        SMOKE_ONLY_FILES="$SMOKE_DETECT_OUT"
        log "Issue de solo smoke detectado (archivos que lo decidieron):"
        printf '%s' "$SMOKE_DETECT_OUT" | while read -r l; do log "  $l"; done
        echo "[$(date +%H:%M:%S)] SMOKE_ONLY detectado" >> "$EVENTS_LOG_ABS"
    fi

    if [ "$IS_SMOKE_ONLY" = true ]; then
        log "fase roja no aplica: solo smoke tests (corren post-deploy, MEF-ADR-0013)"
    elif [ "$IS_REFACTOR" = false ]; then
        # Gate 1b: los tests nuevos deben FALLAR (exit code != 0)
        # Exit codes de Microsoft Testing Platform: 0=pasan, 2=fallan, 8=no hay tests, 1=agregado mixto
        # Gate 1a ya verifico compilacion, asi que exit != 0 aqui significa tests fallando
        log "Gate: verificando fase roja (tests deben fallar)..."
        g1_rc=0
        TEST_OUTPUT_G1=$(run_tests_projects "$WORKTREE_PATH" --no-build 2>&1) || g1_rc=$?
        echo "$TEST_OUTPUT_G1" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
        if [ "$g1_rc" -eq 0 ]; then
            if [ "$IS_NO_RED_SIGNAL" = true ]; then
                log "fase roja no aplicable: $NO_RED_JUSTIFICATION"
            else
                if printf '%s' "$SMOKE_DETECT_OUT" | grep -q '^smoke: '; then
                    SMOKE_OTHER_LIST=$(printf '%s' "$SMOKE_DETECT_OUT" | grep '^otro: ' | sed 's/^otro: //' | paste -sd, - || true)
                else
                    SMOKE_OTHER_LIST="ninguno de los cambios cae bajo tests/*.SmokeTests/"
                fi
                abort "Stage 1 fallido: todos los tests pasan (exit code: 0). Opciones: (1) el $STAGE1_AGENT escribio implementacion real en lugar de stubs: reemplazala por stubs que hagan fallar los tests; (2) en tipo:projection, la fase roja estructuralmente inalcanzable se señaliza con pipeline-state/no-red-signal.md (JUSTIFICATION=<razon>); (3) el carril solo-smoke se detecta solo cuando todo cambio cae en tests/*.SmokeTests/, docs/ o pipeline-state/ y hay al menos un archivo smoke. Lo que impidio detectarlo: ${SMOKE_OTHER_LIST}."
            fi
        elif [ "$g1_rc" -eq 8 ]; then
            abort "Stage 1 fallido: no se encontraron tests para ejecutar (exit code: 8) — el $STAGE1_AGENT no genero tests validos"
        else
            log "Fase roja confirmada (exit code: $g1_rc)"
            # Aviso (no aborta) de tests preexistentes en rojo sin modificar (issue #1937).
            # Solo write-side; cualquier fallo del analisis degrada a warn (CA-4).
            if [ "$IS_PROJECTION" = false ]; then
                PREEXISTING_RED_WARN_PATH=$(mefisto_state_path "preexisting-red-warning.md" "$WORKTREE_PATH" 2>/dev/null) || PREEXISTING_RED_WARN_PATH=""
                [ -n "$PREEXISTING_RED_WARN_PATH" ] && rm -f "$PREEXISTING_RED_WARN_PATH"
                pre_red_rc=0
                PRE_RED_LIST=$(detect_preexisting_red_tests "$WORKTREE_PATH" "$SNAPSHOT_COMMIT" "$TEST_OUTPUT_G1" 2>/dev/null) || pre_red_rc=$?
                if [ "$pre_red_rc" -ne 0 ]; then
                    warn "No se pudo analizar si hay tests preexistentes en rojo (salida no parseable o snapshot no disponible); se continua"
                elif [ -n "$PRE_RED_LIST" ] && [ -n "$PREEXISTING_RED_WARN_PATH" ]; then
                    warn "Tests PREEXISTENTES en rojo que el $STAGE1_AGENT no modifico (no se aborta):"
                    while IFS=$'\t' read -r pr_test pr_file; do
                        [ -n "$pr_test" ] && warn "  - $pr_test ($pr_file)"
                    done <<< "$PRE_RED_LIST"
                    {
                        echo "## Tests preexistentes en rojo sin modificar"
                        echo
                        echo "Hipotesis: pin o test preexistente que quiza el test-writer debia actualizar, o stub sobre codigo existente."
                        echo
                        echo "| Test | Archivo |"
                        echo "|------|---------|"
                        while IFS=$'\t' read -r pr_test pr_file; do
                            [ -n "$pr_test" ] && echo "| \`$pr_test\` | \`$pr_file\` |"
                        done <<< "$PRE_RED_LIST"
                    } > "$PREEXISTING_RED_WARN_PATH" 2>/dev/null || warn "No se pudo escribir el aviso de tests preexistentes en rojo"
                fi
            fi
        fi
    fi

    # Auto-commit de seguridad (solo si hay cambios uncommitted en tests/ o src/)
    auto_commit_if_needed "roja" "test(hu-${ISSUE_NUM:-?}): tests fase roja"

    if [ "$IS_REFACTOR" = true ]; then
        # Baseline: verificar que todos los tests pasan antes del refactoring
        log "Gate: verificando baseline verde para refactoring..."
        baseline_rc=0
        TEST_OUTPUT_BASELINE=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || baseline_rc=$?
        echo "$TEST_OUTPUT_BASELINE" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
        if [ "$baseline_rc" -ne 0 ]; then
            abort "Refactoring señalizado pero hay tests fallando (exit code: $baseline_rc). No se puede refactorizar sobre una base roja."
        fi
        BASELINE_TEST_COUNT=$(extract_test_count "$TEST_OUTPUT_BASELINE")
        log "Baseline refactoring: $BASELINE_TEST_COUNT tests pasando"
        success "Baseline verde confirmado"
    fi

    AGENT_TW_DUR=$LAST_AGENT_DURATION
    AGENT_TW_METRICS_JSON=$LAST_AGENT_METRICS_JSON
    AGENT_TW_RES="passed"
    update_status "1-${STAGE1_AGENT}" "passed"
    if [ "$IS_SMOKE_ONLY" = true ]; then
        echo "[$(date +%H:%M:%S)] SMOKE_ONLY ${STAGE1_AGENT} passed: fase roja no aplica, solo smoke tests (corren post-deploy, MEF-ADR-0013)" >> "$EVENTS_LOG_ABS"
        success "Stage 1 completado — fase roja no aplica: solo smoke tests (corren post-deploy, MEF-ADR-0013)"
    elif [ "$IS_NO_RED_SIGNAL" = true ]; then
        success "Stage 1 completado — fase roja no aplicable (señalizada por el $STAGE1_AGENT)"
    else
        success "Stage 1 completado — fase roja confirmada"
    fi
else
    log "Saltando Stage 1 (--from-stage $FROM_STAGE)"
    if [ "$IS_REFACTOR" = false ] && SMOKE_DETECT_OUT=$(detect_smoke_only "$WORKTREE_PATH" "$SNAPSHOT_COMMIT" --committed); then
        IS_SMOKE_ONLY=true
        SMOKE_ONLY_FILES="$SMOKE_DETECT_OUT"
        log "Issue de solo smoke detectado sobre SNAPSHOT..HEAD (archivos que lo decidieron):"
        printf '%s' "$SMOKE_DETECT_OUT" | while read -r l; do log "  $l"; done
        echo "[$(date +%H:%M:%S)] SMOKE_ONLY detectado (--from-stage $FROM_STAGE)" >> "$EVENTS_LOG_ABS"
    fi
fi

# [Cambio 6] Capturar archivos y verificar que hay contenido
if [ "$IS_REFACTOR" = false ]; then
    STAGE1_FILES=$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD)
    if [ -z "$STAGE1_FILES" ]; then
        abort "No se detectaron archivos nuevos después de Stage 1. El $STAGE1_AGENT no generó ni commitió cambios válidos. Verifica el log del $STAGE1_AGENT."
    fi
    log "Archivos del $STAGE1_AGENT:"
    echo "$STAGE1_FILES" | while read -r f; do log "  + $f"; done
else
    STAGE1_FILES=""
    log "Refactoring puro: no se esperan archivos de test nuevos"
fi

# ─── STAGE 2: Implementer (fase verde) ───────────────────────────────────────
if [ "$IS_REFACTOR" = true ]; then
    log "Saltando Stage 2 (refactoring puro — no hay tests que hacer pasar)"
    AGENT_IM_RES="skipped"
    update_status "2-${STAGE2_AGENT}" "skipped"
elif [ "$FROM_STAGE" -le 2 ]; then
    header "Stage 2: $STAGE2_LABEL (fase verde)"

    BLOCKAGE_REPORT_CANONICAL="$(mefisto_state_path 'blockage-report.md' "$WORKTREE_PATH")"

    STAGE2_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Contexto de la historia de usuario:

$ISSUE_CONTEXT

El $STAGE1_AGENT creó/modificó los siguientes archivos:
$STAGE1_FILES

Tu tarea: implementa la lógica de negocio para hacer pasar todos los tests. Sigue todas las instrucciones de tu rol de $STAGE2_AGENT.

Si detectas un bloqueo que no puedes resolver, escribe el reporte en: $BLOCKAGE_REPORT_CANONICAL

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~5-6 s de reloj (turno sonnet) -- el trabajo que ese turno manda a hacer es barato en comparacion: en el diagnostico Fase 0, dotnet (build/test) ocupo solo ~11% del wall total de una corrida, frente a ~86% de tiempo de API (turnos). Lo caro es el turno, no la herramienta. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una.
- Corre la suite para confirmar la fase verde (la esencia de tu stage: implementar y verlos pasar) cuando creas que terminaste -- no la repitas despues de cada metodo o clase que implementes. Apenas termines este stage, el pipeline vuelve a correr toda la suite para confirmarlo (Gate 2): tu corrida es para saber que tu implementacion esta en verde, no la ultima palabra antes de cerrar.
- No re-inspecciones el arbol con 'git status' ni 'git diff' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~5-6 s, y solo vale la pena si te ahorra un error que costaria mas.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

    if [ "$IS_SMOKE_ONLY" = true ]; then
        STAGE2_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Contexto de la historia de usuario:

$ISSUE_CONTEXT

Este issue es de SOLO SMOKE TESTS (modo documental): los smoke tests ya están escritos por el $STAGE1_AGENT y no hay código de producción que implementar. NO toques src/ ni tests/. Tu única tarea es resolver los entregables no-código de los criterios de aceptación (ADR en docs/, filas en AGENTS.md o CLAUDE.md). Si no hay ninguno, termina sin cambios.

Archivos del $STAGE1_AGENT:
$STAGE1_FILES

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."
    fi
    STAGE2_BASE_HEAD=$(git -C "$WORKTREE_PATH" rev-parse HEAD 2>/dev/null || true)
    run_agent "2" "$STAGE2_AGENT" "$STAGE2_PROMPT"

    # Gate 2: verificar tests
    g2_rc=0
    if [ "$IS_SMOKE_ONLY" = true ]; then
        log "Gate: modo documental (solo smoke) — sin src/ ni tests/, compila, tests exit 0 u 8..."
        S2_FORBIDDEN=$( {
            git -C "$WORKTREE_PATH" diff --name-only "$STAGE2_BASE_HEAD" 2>/dev/null || true
            git -C "$WORKTREE_PATH" ls-files --others --exclude-standard 2>/dev/null || true
        } | sort -u | grep -E '^(src|tests)/' || true)
        if [ -n "$S2_FORBIDDEN" ]; then
            abort "Stage 2 fallido (solo smoke, modo documental): el $STAGE2_AGENT toco src/ o tests/: $(printf '%s' "$S2_FORBIDDEN" | paste -sd, -)"
        fi
        dotnet build "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
            || abort "Stage 2 fallido (solo smoke): el proyecto no compila despues del $STAGE2_AGENT. Revisa $LOG_DIR_ABS/stage-2-${STAGE2_AGENT}.log"
        TEST_OUTPUT_G2=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || g2_rc=$?
        [ "$g2_rc" -eq 8 ] && g2_rc=0
    else
        log "Gate: verificando fase verde..."
        TEST_OUTPUT_G2=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || g2_rc=$?
    fi
    echo "$TEST_OUTPUT_G2" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
    if [ "$g2_rc" -ne 0 ]; then
        BLOCKAGE_REPORT="$(mefisto_state_read_first 'blockage-report.md' "$WORKTREE_PATH" 2>/dev/null || true)"
        # CA-1/CA-2/CA-4 (issue #1561): el implementer escribe blockage-report.md
        # por dos motivos con doctrina opuesta (implementer.md 1b vs "Cuando
        # reportar bloqueo"). Se distinguen por un encabezado canonico exacto
        # ("## Issue incompleto", linea completa) en vez de texto libre -- un
        # grep sobre prosa seria fragil. Si aparecen los dos motivos a la vez,
        # gana "issue incompleto": el implementer no deberia haber escrito
        # codigo (nota tecnica del issue).
        if [ -f "$BLOCKAGE_REPORT" ] && grep -qx '## Issue incompleto' "$BLOCKAGE_REPORT"; then
            AGENT_IM_RES="blocked"
            abort "Stage 2 detenido: el $STAGE2_AGENT reporto issue incompleto en $BLOCKAGE_REPORT_CANONICAL. Refina el issue con el planner (completa la seccion '## ADRs aplicables') y reanuda con --from-stage 2." "blocked"
        elif [ -f "$BLOCKAGE_REPORT" ]; then
            warn "Stage 2: hay tests rojos pero el $STAGE2_AGENT reporto bloqueo — continuando al reviewer"
            echo "[$(date +%H:%M:%S)] BLOCKAGE: $STAGE2_AGENT reporto tests bloqueados, continuando" >> "$EVENTS_LOG_ABS"
            HAS_BLOCKAGE=true
        elif G2_PRE_LIST=$(preexisting_red_only "$WORKTREE_PATH" "$SNAPSHOT_COMMIT" "$TEST_OUTPUT_G2"); then
            # Issue #2062: firma "test preexistente que la implementacion volvio rojo":
            # el pipeline genera el reporte y enruta al reviewer sin depender del agente.
            mkdir -p "$(dirname "$BLOCKAGE_REPORT_CANONICAL")"
            {
                echo "## Reporte de bloqueo - generado por el pipeline"
                echo
                echo "Todos los tests en rojo existian en el snapshot y el test-writer no los modifico (pin desactualizado o guarda de inventario)."
                echo
                echo "### Tests rojos preexistentes"
                printf '%s\n' "$G2_PRE_LIST" | awk -F'\t' '{print "- `" $1 "` (" $2 ")"}'
                echo
                echo "### Salida de los tests"
                echo '```'
                printf '%s\n' "$TEST_OUTPUT_G2" | sed 's/\x1b\[[0-9;]*m//g' | tail -60
                echo '```'
            } > "$BLOCKAGE_REPORT_CANONICAL"
            warn "Stage 2: todos los tests rojos son preexistentes no modificados — reporte generado, continuando al reviewer"
            echo "[$(date +%H:%M:%S)] BLOCKAGE: pipeline detecto solo rojos preexistentes, continuando al reviewer" >> "$EVENTS_LOG_ABS"
            HAS_BLOCKAGE=true
        else
            echo "$TEST_OUTPUT_G2" | tail -20
            abort "Stage 2 fallido: no todos los tests pasan después del $STAGE2_AGENT (exit code: $g2_rc). Revisa $LOG_DIR_ABS/stage-2-${STAGE2_AGENT}.log"
        fi
    fi

    TEST_COUNT=$(extract_test_count "$TEST_OUTPUT_G2")
    PIPELINE_TESTS="$TEST_COUNT"
    log "Tests pasando: $TEST_COUNT"

    # Auto-commit de seguridad
    auto_commit_if_needed "verde" "feat(hu-${ISSUE_NUM:-?}): implementación fase verde"
    # auto_commit_if_needed solo cubre tests/ y src/; en modo documental los
    # entregables viven en docs/, AGENTS.md o CLAUDE.md (CA-3 de #2357).
    if [ "$IS_SMOKE_ONLY" = true ]; then
        for doc_path in docs AGENTS.md CLAUDE.md; do
            if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- "$doc_path" 2>/dev/null)" ]; then
                git -C "$WORKTREE_PATH" add -A -- "$doc_path" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || true
            fi
        done
        if ! git -C "$WORKTREE_PATH" diff --cached --quiet 2>/dev/null; then
            log "El $STAGE2_AGENT no commitió los entregables documentales. Haciendo commit automático (modo documental)..."
            git -C "$WORKTREE_PATH" commit -m "docs(hu-${ISSUE_NUM:-?}): entregables no-código (solo smoke)" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || true
        fi
    fi

    AGENT_IM_DUR=$LAST_AGENT_DURATION
    AGENT_IM_METRICS_JSON=$LAST_AGENT_METRICS_JSON
    if [ "$HAS_BLOCKAGE" = true ]; then
        AGENT_IM_RES="blocked"
        update_status "2-${STAGE2_AGENT}" "blocked"
        warn "Stage 2 completado con tests bloqueados — el reviewer intentara resolverlos"
    else
        AGENT_IM_RES="passed"
        update_status "2-${STAGE2_AGENT}" "passed"
        if [ "$IS_SMOKE_ONLY" = true ]; then
            success "Stage 2 completado — modo documental (solo smoke)"
        else
            success "Stage 2 completado — fase verde confirmada"
        fi
    fi
else
    log "Saltando Stage 2 (--from-stage $FROM_STAGE)"
fi

# ─── STAGE 2b: Smoke Test Writer (condicional) ───────────────────────────────
# Solo se ejecuta si hay Function Apps modificadas y el proyecto SmokeTests existe.
# Rama read-side (issue #371): las Functions GET de query (Obtener{X}/Listar{X}s,
# MEF-ADR-0006) viven en una carpeta SIN sufijo "Function" -- el patron 'Function/'
# no las detecta, asi que el issue tipo:projection suma el patron de esas carpetas
# para que Stage 2b siga corriendo (CA-1: smoke-test-writer se mantiene).
# Rama MCP (issue #791, MEF-ADR-0047/MEF-ADR-0048): una tool nueva o modificada
# de un servidor MCP (src/{NS}.Mcp.{Proposito}/.../{X}Tool.cs) tampoco cae bajo
# 'Function/', asi que SMOKE_FILES suma tambien ese patron -- sin condicionar a
# IS_PROJECTION, porque una tool MCP es ortogonal al tipo write-side/read-side
# del issue. La resolucion de SMOKE_TEST_PROJECT no necesita una rama aparte:
# el mismo sed que extrae "{Dominio}" de src/{NS}.{Dominio}/... extrae
# "Mcp.{Proposito}" completo de src/{NS}.Mcp.{Proposito}/... (el punto interno
# no es separador de ruta), asi que ya cae en tests/{NS}.Mcp.{Proposito}.SmokeTests.
if [ "$IS_SMOKE_ONLY" = true ]; then
    log "Saltando Stage 2b (smoke escritos en Stage 1)"
    echo "[$(date +%H:%M:%S)] SKIP smoke-test-writer: smoke escritos en Stage 1" >> "$EVENTS_LOG_ABS"
    AGENT_ST_RES="skipped"
    update_status "2b-smoke-test-writer" "skipped"
elif [ "$IS_REFACTOR" != true ] && [ "$FROM_STAGE" -le 2 ]; then
    # Anclado a src/ (issue #1562): SNAPSHOT_COMMIT se toma ANTES de Stage 1,
    # asi que el diff incluye los tests que escribio el test-writer -- sin el
    # anclaje, una ruta tests/.../XFunction/... coincide con el patron
    # 'Function/' igual que su equivalente de produccion, y el sed de
    # deteccion de dominio (mas abajo) solo entiende src/<ns>.<Dominio>/...:
    # un match de tests/ le deja una ruta invalida y Stage 2b se marcaba
    # "skipped" con el mismo log que un skip legitimo (falso negativo
    # silencioso, certificacion v0.38.2).
    MCP_TOOL_PATTERN="^src/${HARNESS_NAMESPACE_PREFIX}\.Mcp\.[^/]+/.*Tool\.cs$"
    if [ "$IS_PROJECTION" = true ]; then
        SMOKE_FILES=$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD \
            | grep -E "^src/.*Function/|^src/.*/(Obtener|Listar)[A-Za-z0-9]*/FunctionEndpoint\.cs$|${MCP_TOOL_PATTERN}" || true)
    else
        SMOKE_FILES=$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD | grep -E "^src/.*Function/|${MCP_TOOL_PATTERN}" || true)
    fi

    if [ -n "$SMOKE_FILES" ]; then
        # Detectar dominio (o servidor MCP) desde los archivos modificados
        FIRST_SMOKE_FILE=$(echo "$SMOKE_FILES" | head -1)
        SMOKE_DOMAIN=$(echo "$FIRST_SMOKE_FILE" | sed "s|src/${HARNESS_NAMESPACE_PREFIX}\.\([^/]*\)/.*|\1|")
        SMOKE_TEST_PROJECT="tests/${HARNESS_NAMESPACE_PREFIX}.${SMOKE_DOMAIN}.SmokeTests"
        IS_MCP_SMOKE=false
        echo "$FIRST_SMOKE_FILE" | grep -qE "$MCP_TOOL_PATTERN" && IS_MCP_SMOKE=true

        if [ "$SMOKE_DOMAIN" = "$FIRST_SMOKE_FILE" ] || [[ "$SMOKE_DOMAIN" == */* ]]; then
            # El sed no transformo la ruta (o dejo un resultado con '/', p. ej. un
            # src/ anidado): el match de src/ no tiene la forma src/<ns>.<Dominio>/...
            # que la derivacion de dominio entiende (issue #1562, decision A). Senal visible en vez de un skip indistinguible
            # del legitimo: warn + evento SMOKE_ANOMALY + nota en el PR.
            # AGENT_ST_RES se mantiene en "skipped" para no alterar el formato
            # de metricas/historial (se descarto un resultado nuevo "anomaly").
            warn "No se pudo derivar el dominio de smoke tests desde '$FIRST_SMOKE_FILE' — revisa el patron de deteccion de Stage 2b"
            echo "[$(date +%H:%M:%S)] SMOKE_ANOMALY: $FIRST_SMOKE_FILE" >> "$EVENTS_LOG_ABS"
            SMOKE_ANOMALY_PATH="$FIRST_SMOKE_FILE"
            AGENT_ST_RES="skipped"
            update_status "2b-smoke-test-writer" "skipped"
        elif [ -d "$WORKTREE_PATH/$SMOKE_TEST_PROJECT" ]; then
            header "Stage 2b: Smoke Test Writer"

            if [ "$IS_MCP_SMOKE" = true ]; then
                SMOKE_FILES_DESC="las siguientes tools de un servidor MCP"
                SMOKE_TASK_LINE="Tu tarea: extiende la suite SmokeTests del servidor MCP (pin de catálogo, pin de schema, tool call real) para las tools nuevas o modificadas -- sigue la doctrina de extensión de servidores MCP de tu rol (MEF-ADR-0048), no la de Functions HTTP."
                SMOKE_COMMIT_SUBJECT="test(hu-${ISSUE_NUM:-?}): smoke tests para tools MCP"
            else
                SMOKE_FILES_DESC="los siguientes endpoints"
                SMOKE_TASK_LINE="Tu tarea: escribe smoke tests para los endpoints nuevos o modificados."
                SMOKE_COMMIT_SUBJECT="test(hu-${ISSUE_NUM:-?}): smoke tests para endpoints"
            fi

            SMOKE_INVOKERS_BLOCK=""
            if [ "$IS_MCP_SMOKE" = true ]; then
                SMOKE_INVOKERS=$(list_smokes_invoking_tools "$WORKTREE_PATH" "$SMOKE_TEST_PROJECT" \
                    $(echo "$SMOKE_FILES" | grep -E "$MCP_TOOL_PATTERN" || true)) || SMOKE_INVOKERS=""
                if [ -n "$SMOKE_INVOKERS" ]; then
                    SMOKE_INVOKERS_LISTING=$(printf '%s\n' "$SMOKE_INVOKERS" | awk -F'\t' '{print "- " $2 " (tool: " $1 ")"}')
                    SMOKE_INVOKERS_BLOCK="
Smokes existentes que invocan las tools modificadas:
$SMOKE_INVOKERS_LISTING

Revisa cada uno de esos archivos, incluidos los Arrange de otras clases que invocan la tool, y alinealo al contrato nuevo (inputSchema, eco y campos de la respuesta). Revisa tambien en la propia clase de la tool los asserts que el cambio contradice.
"
                else
                    SMOKE_INVOKERS_BLOCK="
Smokes existentes que invocan las tools modificadas: ninguno encontrado por el pipeline (sin coincidencias del literal de la tool en ${SMOKE_TEST_PROJECT}). Revisa igualmente en la propia clase de la tool los asserts que el cambio contradice.
"
                fi
            fi

            STAGE2B_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Contexto de la historia de usuario:

$ISSUE_CONTEXT

El $STAGE2_AGENT creó/modificó $SMOKE_FILES_DESC:
$SMOKE_FILES
$SMOKE_INVOKERS_BLOCK
$SMOKE_TASK_LINE
IMPORTANTE: Solo escribe y compila. NO ejecutes los tests (el entorno dev puede no tener este código desplegado aún).
Usa 'dotnet build' para verificar compilación, pero NO uses 'dotnet test'.

Sigue todas las instrucciones de tu rol de smoke-test-writer.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~5-6 s de reloj (turno sonnet) -- el trabajo que ese turno manda a hacer es barato en comparacion: en el diagnostico Fase 0, dotnet (build/test) ocupo solo ~11% del wall total de una corrida, frente a ~86% de tiempo de API (turnos). Lo caro es el turno, no la herramienta. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una.
- Corre 'dotnet build' del proyecto de smoke tests UNA vez, cuando creas que terminaste de escribirlos -- no lo repitas despues de cada test que agregues. Apenas termines este stage, el pipeline vuelve a compilar ese mismo proyecto para confirmarlo: tu build es para saber que tu trabajo compila, no la ultima palabra antes de cerrar.
- No re-inspecciones el arbol con 'git status' ni 'git diff' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~5-6 s, y solo vale la pena si te ahorra un error que costaria mas.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

            run_agent "2b" "smoke-test-writer" "$STAGE2B_PROMPT"

            # Gate: solo compilación del proyecto de smoke tests
            log "Gate: verificando que smoke tests compilan..."
            st_build_rc=0
            ST_BUILD_OUTPUT=$(dotnet build "$WORKTREE_PATH/$SMOKE_TEST_PROJECT" 2>&1) || st_build_rc=$?
            echo "$ST_BUILD_OUTPUT" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
            if [ "$st_build_rc" -ne 0 ]; then
                echo "$ST_BUILD_OUTPUT" | tail -20
                abort "Stage 2b fallido: smoke tests no compilan (exit code: $st_build_rc). Revisa el log."
            fi

            auto_commit_if_needed "smoke" "$SMOKE_COMMIT_SUBJECT"

            AGENT_ST_DUR=$LAST_AGENT_DURATION
            AGENT_ST_METRICS_JSON=$LAST_AGENT_METRICS_JSON
            AGENT_ST_RES="passed"
            update_status "2b-smoke-test-writer" "passed"
            success "Stage 2b completado — smoke tests escritos"
        else
            if [ "$IS_MCP_SMOKE" = true ]; then
                log "Proyecto $SMOKE_TEST_PROJECT no existe — genéralo con /scaffold-mcp; saltando smoke tests"
            else
                log "Proyecto SmokeTests no existe para $SMOKE_DOMAIN — saltando smoke tests"
            fi
            AGENT_ST_RES="skipped"
            update_status "2b-smoke-test-writer" "skipped"
        fi
    else
        log "No se detectaron Function Apps ni tools MCP modificadas — saltando smoke tests"
        AGENT_ST_RES="skipped"
        update_status "2b-smoke-test-writer" "skipped"
    fi
else
    if [ "$IS_REFACTOR" = true ]; then
        log "Saltando Stage 2b (refactoring puro)"
    else
        log "Saltando Stage 2b (--from-stage $FROM_STAGE)"
    fi
    AGENT_ST_RES="skipped"
fi

# ─── STAGE 3: Reviewer (fase refactor) ───────────────────────────────────────
if [ "$FROM_STAGE" -le 3 ]; then
    header "Stage 3: Reviewer (fase refactor)"

    if [ "$IS_REFACTOR" = true ]; then
        STAGE3_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Esta es una tarea de REFACTORING PURO. No hay fases roja ni verde previas.
Justificación del refactoring: $REFACTOR_JUSTIFICATION

Contexto de la tarea:

$ISSUE_CONTEXT

Tu misión: ejecutar el refactoring descrito en el issue. Los tests existentes DEBEN seguir pasando en todo momento, salvo los tests obsoletos que la JUSTIFICACION de arriba declara explicitamente: el test-writer los señalizo pero no los toco (no edita produccion ni tests en el carril de señal) — eliminarlos o ajustarlos es tu responsabilidad como parte de este refactor. Tests declarados como eliminados en la señal: ${REMOVED_TESTS:-0}.

Reglas:
1. Corre dotnet test ANTES de empezar para confirmar el baseline verde.
2. Ejecuta el refactoring en pasos pequeños y seguros. Si la JUSTIFICACION declara tests obsoletos, eliminalos o ajustalos como parte del refactor — no son una regresion.
3. Después de cada cambio significativo, corre dotnet test.
4. Si un cambio rompe un test que NO esta declarado como obsoleto en la JUSTIFICACION, reviértelo inmediatamente: git checkout -- <archivo>
5. Al terminar, corre dotnet test una última vez para confirmar que todo sigue verde (descontando los tests obsoletos que eliminaste).
6. Haz commit de tu trabajo con mensaje: refactor(hu-${ISSUE_NUM:-?}): [descripción]

Sigue todas las instrucciones de tu rol de reviewer.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~8 s de reloj (turno opus) -- el trabajo que ese turno manda a hacer es barato en comparacion: en el diagnostico Fase 0, dotnet (build/test) ocupo solo ~11% del wall total de una corrida, frente a ~86% de tiempo de API (turnos). Lo caro es el turno, no la herramienta. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una.
- La Regla 3 sigue en pie: la corrida despues de cada cambio significativo es la que te dice CUAL cambio rompio un test, y es lo que hace posible el revert puntual de la Regla 4. Lo que sobra es la ronda extra 'por las dudas': la corrida de cierre de la Regla 5 se hace UNA vez, y si desde ella no volviste a tocar codigo no la repitas -- apenas termines este stage, el pipeline vuelve a correr toda la suite para confirmarlo igual (Gate 3).
- No re-inspecciones el arbol con 'git status' ni 'git diff' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~8 s, y solo vale la pena si te ahorra un error que costaria mas.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."
    else
        WRITER_HEAD_SHA=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
        DIFF_STAT=$(git -C "$WORKTREE_PATH" diff --stat=120 "$SNAPSHOT_COMMIT"..HEAD)
        DIFF_NAME_STATUS=$(git -C "$WORKTREE_PATH" diff --name-status "$SNAPSHOT_COMMIT"..HEAD)

        STAGE3_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Contexto de la historia de usuario:

$ISSUE_CONTEXT

Cambios de las fases roja y verde:

Commit base: ${SNAPSHOT_COMMIT}
HEAD del test-writer: ${WRITER_HEAD_SHA}

Resumen (git diff --stat=120 ${SNAPSHOT_COMMIT}..HEAD):

$DIFF_STAT

Rutas cambiadas (git diff --name-status ${SNAPSHOT_COMMIT}..HEAD):

$DIFF_NAME_STATUS

Tu tarea: revisa la calidad del código, refactoriza si es necesario, y verifica que los criterios de aceptación estén bien cubiertos.
Si las rutas cambiadas incluyen smoke tests (archivos en *SmokeTests/), revísalos también: verifica que cubran los escenarios principales del endpoint (camino feliz, validación, duplicados) y que sigan las convenciones del proyecto.
Sigue todas las instrucciones de tu rol de reviewer.

ECONOMIA DE TURNOS:
Cada turno tuyo cuesta ~8 s de reloj (turno opus) -- el trabajo que ese turno manda a hacer es barato en comparacion: en el diagnostico Fase 0, dotnet (build/test) ocupo solo ~11% del wall total de una corrida, frente a ~86% de tiempo de API (turnos). Lo caro es el turno, no la herramienta. Con eso en mente:
- Agrupa en un mismo turno las tool calls independientes entre si (varias busquedas, varias lecturas, varias escrituras a archivos distintos). No las encadenes de a una.
- Ya tienes el commit base, el HEAD del test-writer, el --stat y las rutas cambiadas aqui arriba: para ver el diff de una ruta puntual pidelo bajo demanda con 'git diff ${SNAPSHOT_COMMIT}..HEAD -- <ruta>' (o 'git show <sha>' para inspeccionar un commit), agrupando varias rutas en el mismo turno si necesitas mas de una. Esto NO alcanza a las consultas acotadas que tu rol usa como disparador de gate ('git diff main...HEAD -- <ruta>'): esas corren contra main y filtran por ruta, y lo de arriba no las reemplaza.
- Manten el protocolo de correccion de tu rol -- 'dotnet test' despues de cada cambio, revertir con 'git checkout -- <archivo>' si rompe: esa corrida es la que te dice CUAL cambio rompio, y agrupar varias correcciones te obliga a bisecar despues, que sale mas caro que los turnos que ahorra. Lo que sobra es la ronda extra 'por las dudas': si desde tu ultima corrida verde no tocaste codigo, no la repitas antes de cerrar -- apenas termines este stage, el pipeline vuelve a correr toda la suite igual (Gate 3).
- No re-inspecciones el arbol con 'git status' para confirmar algo que acabas de escribir: Write y Edit fallan con error si no aplican, asi que el exito de la herramienta ya es la confirmacion.
Estas reglas no cubren todos los casos; ante cualquier otro, decide con el mismo criterio -- un turno extra cuesta ~8 s, y solo vale la pena si te ahorra un error que costaria mas.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

        if [ "$IS_NO_RED_SIGNAL" = true ]; then
            STAGE3_PROMPT="$STAGE3_PROMPT

Nota: el $STAGE1_AGENT señalizo que la fase roja del Stage 1 era estructuralmente inalcanzable (unica capa de test posible: composicion/config-test). Justificación: $NO_RED_JUSTIFICATION"
        fi
        if [ "$IS_SMOKE_ONLY" = true ]; then
            STAGE3_PROMPT="$STAGE3_PROMPT

Nota: este issue es de SOLO SMOKE TESTS (corren post-deploy, MEF-ADR-0013). No hay implementación que revisar en src/: revisa la calidad de los smoke tests y de los entregables documentales (docs/), sin tocar src/."
        fi
    fi

    # Agregar contexto de bloqueo al prompt si el implementer reporto tests bloqueados
    if [ "${HAS_BLOCKAGE:-false}" = true ]; then
        BLOCKAGE_REPORT="$(mefisto_state_read_first 'blockage-report.md' "$WORKTREE_PATH" 2>/dev/null || true)"
        if [ -f "$BLOCKAGE_REPORT" ]; then
            BLOCKAGE_REPORT_CANONICAL="$(mefisto_state_path 'blockage-report.md' "$WORKTREE_PATH")"
            STAGE3_PROMPT="$STAGE3_PROMPT

ATENCION: hay tests bloqueados tras la fase verde (reportados por el implementer o detectados por el pipeline como tests preexistentes que la implementacion volvio rojos). Lee el reporte en $BLOCKAGE_REPORT_CANONICAL y sigue las instrucciones de tu seccion 2b para intentar resolverlos."
        fi
    fi

    STAGE3_BASE_HEAD=$(git -C "$WORKTREE_PATH" rev-parse HEAD 2>/dev/null || true)
    run_agent "3" "reviewer" "$STAGE3_PROMPT"

    # Gate 3: tests deben seguir pasando (exit code 0 = verde)
    log "Gate: verificando que refactor no rompió tests..."
    g3_rc=0
    TEST_OUTPUT_G3=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || g3_rc=$?
    [ "$IS_SMOKE_ONLY" = true ] && [ "$g3_rc" -eq 8 ] && g3_rc=0
    echo "$TEST_OUTPUT_G3" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
    if [ "$g3_rc" -ne 0 ]; then
        BLOCKAGE_REPORT="$(mefisto_state_read_first 'blockage-report.md' "$WORKTREE_PATH" 2>/dev/null || true)"
        if [ "${HAS_BLOCKAGE:-false}" = true ] && [ -f "$BLOCKAGE_REPORT" ]; then
            warn "Stage 3: hay tests rojos pero el bloqueo persiste desde el implementer — continuando a PR"
            echo "[$(date +%H:%M:%S)] BLOCKAGE_PERSISTS: reviewer no resolvio tests bloqueados" >> "$EVENTS_LOG_ABS"
        else
            echo "$TEST_OUTPUT_G3" | tail -20
            abort "Stage 3 fallido: el reviewer rompió tests al refactorizar (exit code: $g3_rc). Revisa $LOG_DIR_ABS/stage-3-reviewer.log"
        fi
    elif [ "${HAS_BLOCKAGE:-false}" = true ]; then
        # Issue #2062: el reviewer resolvio el bloqueo; el PR no debe salir bloqueado.
        log "Stage 3: el reviewer resolvio los tests bloqueados — el PR no se marca bloqueado"
        echo "[$(date +%H:%M:%S)] BLOCKAGE_RESOLVED: reviewer resolvio tests bloqueados" >> "$EVENTS_LOG_ABS"
        HAS_BLOCKAGE=false
        BLOCKAGE_RESOLVED=true
    fi

    # Verificación adicional para refactoring: no deben perderse tests
    if [ "$IS_REFACTOR" = true ]; then
        POST_TEST_COUNT=$(extract_test_count "$TEST_OUTPUT_G3")
        log "Tests post-refactoring: $POST_TEST_COUNT (baseline: $BASELINE_TEST_COUNT, declarados como eliminados: $REMOVED_TESTS)"
        if [ "$POST_TEST_COUNT" != "?" ] && [ "$BASELINE_TEST_COUNT" != "?" ]; then
            ALLOWED_MIN_TEST_COUNT=$((BASELINE_TEST_COUNT - REMOVED_TESTS))
            if [ "$POST_TEST_COUNT" -lt "$ALLOWED_MIN_TEST_COUNT" ]; then
                abort "El refactoring perdió tests: antes=$BASELINE_TEST_COUNT, después=$POST_TEST_COUNT, declarados como eliminados=$REMOVED_TESTS (minimo permitido=$ALLOWED_MIN_TEST_COUNT)"
            fi
        fi
        PIPELINE_TESTS="$POST_TEST_COUNT"
    fi

    # Auto-commit de seguridad
    auto_commit_if_needed "refactor" "refactor(hu-${ISSUE_NUM:-?}): revisión y refactor"

    # Issue #2062: tests tocados por el reviewer (diff HEAD Stage 2 vs HEAD Stage 3)
    if [ -n "${STAGE3_BASE_HEAD:-}" ]; then
        REVIEWER_TOUCHED_TESTS=$(list_reviewer_touched_tests "$WORKTREE_PATH" "$STAGE3_BASE_HEAD" || true)
    fi

    AGENT_RV_DUR=$LAST_AGENT_DURATION
    AGENT_RV_METRICS_JSON=$LAST_AGENT_METRICS_JSON
    AGENT_RV_RES="passed"
    update_status "3-reviewer" "passed"
    success "Stage 3 completado — fase refactor confirmada"
else
    log "Saltando Stage 3 (--from-stage $FROM_STAGE)"
fi

# ─── Verificar que hay commits antes de crear PR ─────────────────────────────
COMMITS_LIST=$(git -C "$WORKTREE_PATH" log "${SNAPSHOT_COMMIT}..HEAD" --oneline)
if [ -z "$COMMITS_LIST" ]; then
    abort "No hay commits en la rama $BRANCH_NAME. Los agentes no commitieron su trabajo y el auto-commit falló."
fi

# ─── Sincronizar con main antes de crear PR ──────────────────────────────────
header "Sincronizando con main"

log "Actualizando main desde origin..."
git -C "$WORKTREE_PATH" fetch origin main >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
    || abort "No se pudo hacer fetch de origin/main"

BEHIND_COUNT=$(git -C "$WORKTREE_PATH" rev-list HEAD..origin/main --count)
if [ "$BEHIND_COUNT" -eq 0 ]; then
    log "La rama ya está al día con main"
else
    log "main tiene $BEHIND_COUNT commit(s) nuevos. Haciendo merge..."

    if git -C "$WORKTREE_PATH" merge origin/main --no-edit >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1; then
        success "Merge automático exitoso"
    else
        warn "Merge con conflictos. Invocando agente para resolverlos..."

        CONFLICT_FILES=$(git -C "$WORKTREE_PATH" diff --name-only --diff-filter=U)

        MERGE_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Hay conflictos de merge con la rama main en los siguientes archivos:
$CONFLICT_FILES

Resuelve los conflictos manteniendo tanto la funcionalidad nueva (de esta rama) como la existente (de main).
Después de resolver cada archivo, haz git add del archivo.
Cuando todos estén resueltos, haz git commit para completar el merge.
NO elimines código de ninguna de las dos ramas — integra ambos cambios.
PROHIBIDO hacer 'git push' o 'gh pr create': eso es responsabilidad exclusiva del pipeline, nunca tuya."

        run_agent "merge" "implementer" "$MERGE_PROMPT"

        # Verificar que no quedan conflictos
        REMAINING_CONFLICTS=$(git -C "$WORKTREE_PATH" diff --name-only --diff-filter=U 2>/dev/null || true)
        if [ -n "$REMAINING_CONFLICTS" ]; then
            abort "Aún quedan conflictos después del agente: $REMAINING_CONFLICTS. Revisa manualmente: cd $WORKTREE_PATH"
        fi
        success "Conflictos resueltos"
    fi

    # Re-correr tests post-merge
    log "Verificando tests después del merge..."
    merge_rc=0
    TEST_OUTPUT_MERGE=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || merge_rc=$?
    [ "$IS_SMOKE_ONLY" = true ] && [ "$merge_rc" -eq 8 ] && merge_rc=0
    echo "$TEST_OUTPUT_MERGE" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null
    if [ "$merge_rc" -ne 0 ]; then
        abort "Tests fallan después del merge con main (exit code: $merge_rc). Revisa manualmente: cd $WORKTREE_PATH"
    fi
    success "Tests pasan después del merge con main"
fi

# ─── STAGE 4: Coverage Gate ─────────────────────────────────────────────────
# Mide cobertura de lineas sobre archivos de logica del PR.
# Si hay brechas, genera patch spec y relanza test-writer (+implementer si necesario).
# Maximo 1 iteracion de remediacion.
if [ "$IS_SMOKE_ONLY" = true ]; then
    log "Saltando Stage 4 (sin cambios en src/)"
    echo "[$(date +%H:%M:%S)] SKIP coverage-gate: sin cambios en src/" >> "$EVENTS_LOG_ABS"
    AGENT_CG_RES="skipped"
    update_status "4-coverage-gate" "skipped"
elif [ "$IS_REFACTOR" != true ] && [ "$FROM_STAGE" -le 4 ]; then
    header "Stage 4: Coverage Gate"

    CG_START=$(date +%s)
    update_status "4-coverage-gate" "running"
    echo "[$(date +%H:%M:%S)] === STAGE 4: coverage-gate ===" >> "$EVENTS_LOG_ABS"
    AGENT_CG_RES="running"

    # --- 4a: Verificar que dotnet-coverage esta disponible ---
    if ! command -v dotnet-coverage &>/dev/null; then
        warn "dotnet-coverage no encontrado — saltando coverage gate"
        echo "[$(date +%H:%M:%S)] SKIP coverage-gate: dotnet-coverage no disponible" >> "$EVENTS_LOG_ABS"
        AGENT_CG_RES="skipped"
        AGENT_CG_DUR=$(( $(date +%s) - CG_START ))
        update_status "4-coverage-gate" "skipped"
    else

    # --- 4b: Identificar archivos .cs del PR (src/ solamente, excluir tests/obj/bin) ---
    PR_SRC_FILES=$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD -- 'src/*.cs' \
        | grep -v '/obj/' | grep -v '/bin/' || true)

    if [ -z "$PR_SRC_FILES" ]; then
        log "No hay archivos .cs en src/ modificados — saltando coverage gate"
        AGENT_CG_RES="skipped"
        AGENT_CG_DUR=$(( $(date +%s) - CG_START ))
        update_status "4-coverage-gate" "skipped"
    else

    log "Archivos .cs del PR:"
    echo "$PR_SRC_FILES" | while read -r f; do log "  $f"; done

    # --- 4c: Clasificar archivos ---
    # Resultado: LOGIC_FILES (requiere 95%) y EXCLUDED_FILES
    LOGIC_FILES=""
    EXCLUDED_FILES=""
    NOT_EVALUATED_FILES=""

    # La funcion de clasificacion (antes inline en este Stage) vive ahora en
    # scripts/_pipeline-common.sh como coverage_classify_file (issue #416):
    # sourceable, para poder testearla con la funcion real en vez de con una
    # reimplementacion.
    while IFS= read -r file; do
        classification=$(coverage_classify_file "$file" "$WORKTREE_PATH" "$IS_PROJECTION")
        case "$classification" in
            logic) LOGIC_FILES="${LOGIC_FILES:+$LOGIC_FILES
}$file" ;;
            excluded) EXCLUDED_FILES="${EXCLUDED_FILES:+$EXCLUDED_FILES
}$file" ;;
            not_evaluated) NOT_EVALUATED_FILES="${NOT_EVALUATED_FILES:+$NOT_EVALUATED_FILES
}$file" ;;
        esac
    done <<< "$PR_SRC_FILES"

    if [ -n "$LOGIC_FILES" ]; then
        log "Archivos de logica (requieren 95%):"
        echo "$LOGIC_FILES" | while read -r f; do log "  * $f"; done
    fi
    if [ -n "$EXCLUDED_FILES" ]; then
        log "Archivos excluidos:"
        echo "$EXCLUDED_FILES" | while read -r f; do log "  - $f"; done
    fi
    if [ -n "$NOT_EVALUATED_FILES" ]; then
        log "Archivos sin clasificar:"
        echo "$NOT_EVALUATED_FILES" | while read -r f; do log "  ? $f"; done
    fi

    # Agrega a COV_TABLE (global) las filas de EXCLUDED_FILES y
    # NOT_EVALUATED_FILES (ambas globales, newline-separated). Comparten esta
    # construccion los tres sitios del Stage 4 que arman la tabla (sin logica,
    # medicion inicial, re-medicion post-remediacion) -- issue #586: la fila de
    # "sin clasificar" lleva marcador de atencion propio en Estado en vez del
    # "-" neutro, para no leerse igual que una exclusion deliberada.
    coverage_append_classification_rows() {
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            COV_TABLE="$COV_TABLE
| $(basename "$f") | - | excluido | - |"
        done <<< "$EXCLUDED_FILES"
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            COV_TABLE="$COV_TABLE
| $(basename "$f") | - | sin clasificar | ⚠ revisar |"
        done <<< "$NOT_EVALUATED_FILES"
    }

    if [ -z "$LOGIC_FILES" ]; then
        log "No hay archivos de logica para evaluar — coverage gate pasa trivialmente"
        # Construir tabla solo con excluidos/sin-clasificar
        COV_TABLE="| Archivo | Cobertura | Umbral | Estado |
|---|---|---|---|"
        coverage_append_classification_rows

        AGENT_CG_RES="passed"
        AGENT_CG_DUR=$(( $(date +%s) - CG_START ))
        update_status "4-coverage-gate" "passed"
        success "Stage 4 completado — sin archivos de logica que evaluar"
    else

    # --- 4d: Instrumentar y recoger cobertura ---
    measure_coverage() {
        # Retorna 0 si exito, 1 si falla la instrumentacion y 3 si fallan tests.
        # Deja coverage.cobertura.xml y coverage-collect.rc en el worktree.
        log "Compilando proyecto para instrumentacion..."
        if ! dotnet build "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1; then
            warn "Build fallo antes de instrumentacion"
            return 1
        fi

        log "Instrumentando DLLs..."
        local settings_xml="$WORKTREE_PATH/dotnet-coverage.settings.xml"
        local instrumented=0
        local seen_dlls=0
        local skipped_tests=0
        local skipped_duplicates=0
        # Set de basenames ya instrumentados (compatible bash 3.2, sin declare -A).
        # Cadena con espacios como delimitadores; se consulta con [[ "$set" == *" $bn "* ]].
        local instrumented_basenames=" "
        for dll in "$WORKTREE_PATH"/tests/${HARNESS_NAMESPACE_PREFIX}.*.Tests/bin/Debug/net10.0/${HARNESS_NAMESPACE_PREFIX}.*.dll; do
            [[ ! -f "$dll" ]] && continue
            seen_dlls=$((seen_dlls + 1))
            local bn
            bn="$(basename "$dll")"
            if [[ "$bn" == *Tests.dll ]]; then
                skipped_tests=$((skipped_tests + 1))
                continue
            fi
            if [[ "$instrumented_basenames" == *" $bn "* ]]; then
                skipped_duplicates=$((skipped_duplicates + 1))
                continue
            fi
            if dotnet-coverage instrument "$dll" --settings "$settings_xml" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1; then
                instrumented=$((instrumented + 1))
                instrumented_basenames+="$bn "
            else
                warn "No se pudo instrumentar: $bn"
            fi
        done
        log "Instrumentacion: vistas=$seen_dlls, omitidas_tests=$skipped_tests, omitidas_duplicadas=$skipped_duplicates, instrumentadas=$instrumented"

        if [ "$instrumented" -eq 0 ]; then
            warn "No se instrumento ninguna DLL"
            return 1
        fi
        log "$instrumented DLL(s) instrumentada(s)"

        log "Recolectando cobertura..."
        local cov_output="$WORKTREE_PATH/coverage.cobertura.xml"
        local collect_rc=0
        rm -f "$cov_output" "$WORKTREE_PATH/coverage-collect.rc"
        dotnet-coverage collect \
            --output "$cov_output" \
            -f cobertura \
            -- bash -c '
                # Mantener alineado con _pipeline-common.sh:902: solo *.Tests/.
                for proj in "$1"/tests/'"$HARNESS_NAMESPACE_PREFIX"'.*.Tests/; do
                    [ -d "$proj" ] || continue
                    dotnet test --project "$proj" --no-build
                    test_rc=$?
                    if [ "$test_rc" -ne 0 ] && [ "$test_rc" -ne 8 ]; then
                        exit "$test_rc"
                    fi
                done
            ' _ "$WORKTREE_PATH" \
            >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || collect_rc=$?
        printf '%s\n' "$collect_rc" > "$WORKTREE_PATH/coverage-collect.rc"

        if [ "$collect_rc" -ne 0 ]; then
            warn "dotnet-coverage collect termino con exit code $collect_rc"
        fi

        if [ ! -f "$cov_output" ]; then
            warn "No se genero archivo de cobertura"
            return 1
        fi

        if [ "$collect_rc" -ne 0 ]; then
            return 3
        fi

        log "Cobertura recolectada: $cov_output"
        return 0
    }

    coverage_measurement_skip_reason() {
        local measure_exit="$1"
        local cov_output="$2"
        local collect_rc="$3"

        if [ "$measure_exit" -eq 3 ] && [ -f "$cov_output" ] \
            && [[ "$collect_rc" =~ ^[0-9]+$ ]]; then
            printf 'SKIP coverage-gate: tests fallaron bajo cobertura (exit code %s)\n' "$collect_rc"
        else
            printf 'SKIP coverage-gate: instrumentacion fallo\n'
        fi
    }

    # Extraer cobertura por archivo del XML cobertura.
    # Usa python3 para parsear XML de forma confiable.
    # Recibe: archivo cobertura XML, lista de archivos de logica (newline-separated)
    # Imprime: archivo|line_rate por cada archivo encontrado
    extract_file_coverage() {
        local cov_xml="$1"
        local logic_files="$2"
        python3 -c "
import xml.etree.ElementTree as ET
import sys, os

tree = ET.parse('$cov_xml')
root = tree.getroot()

# Archivos de logica a buscar (basenames)
logic_basenames = {}
for line in '''$logic_files'''.strip().split('\n'):
    if line.strip():
        bn = os.path.basename(line.strip())
        logic_basenames[bn] = line.strip()

# Buscar en el XML
for pkg in root.findall('.//package'):
    for cls in pkg.findall('.//class'):
        filename = cls.get('filename', '')
        bn = os.path.basename(filename)
        if bn in logic_basenames:
            line_rate = cls.get('line-rate', '0')
            pct = round(float(line_rate) * 100, 1)
            print(f'{logic_basenames[bn]}|{pct}')
            del logic_basenames[bn]

# Archivos de logica no encontrados en el reporte
for bn, fullpath in logic_basenames.items():
    print(f'{fullpath}|N/A')
" 2>>"${LOG_FILE_ABS:-$LOG_FILE}" || true
    }

    # --- 4d: Medir cobertura ---
    CG_MEASUREMENT_OK=false
    CG_MEASURE_COLLECT_RC=""
    CG_TIMEOUT_MEASURE=600  # 10 minutos para medicion

    (
        measure_coverage
    ) &
    CG_MEASURE_PID=$!
    (sleep $CG_TIMEOUT_MEASURE && kill -9 $CG_MEASURE_PID 2>/dev/null && \
        echo "[$(date +%H:%M:%S)] TIMEOUT: coverage measurement supero ${CG_TIMEOUT_MEASURE}s" >> "$EVENTS_LOG_ABS") </dev/null >/dev/null 2>&1 &
    CG_MEASURE_WATCHDOG=$!

    CG_MEASURE_EXIT=0
    wait $CG_MEASURE_PID || CG_MEASURE_EXIT=$?
    kill $CG_MEASURE_WATCHDOG 2>/dev/null || true
    wait $CG_MEASURE_WATCHDOG 2>/dev/null || true

    if [ -f "$WORKTREE_PATH/coverage-collect.rc" ]; then
        CG_MEASURE_COLLECT_RC=$(<"$WORKTREE_PATH/coverage-collect.rc")
    fi

    if [ "$CG_MEASURE_EXIT" -eq 0 ] && [ -f "$WORKTREE_PATH/coverage.cobertura.xml" ]; then
        CG_MEASUREMENT_OK=true
    fi

    if [ "$CG_MEASUREMENT_OK" = false ]; then
        CG_SKIP_REASON=$(coverage_measurement_skip_reason \
            "$CG_MEASURE_EXIT" \
            "$WORKTREE_PATH/coverage.cobertura.xml" \
            "$CG_MEASURE_COLLECT_RC")
        warn "$CG_SKIP_REASON"
        echo "[$(date +%H:%M:%S)] $CG_SKIP_REASON" >> "$EVENTS_LOG_ABS"
        AGENT_CG_RES="skipped"
        AGENT_CG_DUR=$(( $(date +%s) - CG_START ))
        update_status "4-coverage-gate" "skipped"
    else

    # --- 4e: Extraer y evaluar cobertura ---
    COVERAGE_DATA=$(extract_file_coverage "$WORKTREE_PATH/coverage.cobertura.xml" "$LOGIC_FILES")
    THRESHOLD=95

    COV_TABLE="| Archivo | Cobertura | Umbral | Estado |
|---|---|---|---|"

    GAPS=""
    GAPS_COUNT=0

    while IFS='|' read -r filepath pct; do
        [ -z "$filepath" ] && continue
        local_basename=$(basename "$filepath")
        if [ "$pct" = "N/A" ]; then
            COV_TABLE="$COV_TABLE
| $local_basename | N/A | ${THRESHOLD}% | sin datos |"
        else
            pct_int=${pct%.*}
            if [ "$pct_int" -ge "$THRESHOLD" ]; then
                COV_TABLE="$COV_TABLE
| $local_basename | ${pct}% | ${THRESHOLD}% | ok |"
            else
                COV_TABLE="$COV_TABLE
| $local_basename | ${pct}% | ${THRESHOLD}% | gap |"
                GAPS="${GAPS:+$GAPS
}$filepath|$pct"
                GAPS_COUNT=$((GAPS_COUNT + 1))
            fi
        fi
    done <<< "$COVERAGE_DATA"

    # Agregar excluidos y sin-clasificar a la tabla
    coverage_append_classification_rows

    log "Tabla de cobertura:"
    echo "$COV_TABLE" | while read -r line; do log "  $line"; done

    # --- 4f: Remediacion si hay gaps ---
    COV_REMEDIATION_SUMMARY=""
    if [ "$GAPS_COUNT" -gt 0 ]; then
        log "Detectados $GAPS_COUNT archivo(s) con cobertura insuficiente"
        echo "[$(date +%H:%M:%S)] GAPS: $GAPS_COUNT archivos bajo ${THRESHOLD}%" >> "$EVENTS_LOG_ABS"

        # Generar coverage-patch-spec.md
        PATCH_SPEC="$(mefisto_state_path 'coverage-patch-spec.md' "$WORKTREE_PATH")"

        {
            echo "## Coverage Patch Spec"
            echo ""
            echo "Archivos con cobertura insuficiente detectados en Stage 4."
            echo "El test-writer debe agregar tests para cubrir los metodos/lineas listados."
            echo ""
            while IFS='|' read -r gpath gpct; do
                [ -z "$gpath" ] && continue
                echo "### $gpath (${gpct}% - requiere ${THRESHOLD}%)"
                echo ""
                # Extraer lineas no cubiertas del XML
                python3 -c "
import xml.etree.ElementTree as ET
import os

tree = ET.parse('$WORKTREE_PATH/coverage.cobertura.xml')
root = tree.getroot()
target_bn = os.path.basename('$gpath')

for pkg in root.findall('.//package'):
    for cls in pkg.findall('.//class'):
        filename = cls.get('filename', '')
        if os.path.basename(filename) == target_bn:
            uncovered = []
            for line in cls.findall('.//line'):
                if line.get('hits', '0') == '0':
                    uncovered.append(int(line.get('number', 0)))
            if uncovered:
                # Agrupar lineas consecutivas en rangos
                ranges = []
                start = uncovered[0]
                end = uncovered[0]
                for ln in uncovered[1:]:
                    if ln == end + 1:
                        end = ln
                    else:
                        ranges.append((start, end))
                        start = ln
                        end = ln
                ranges.append((start, end))
                print('Lineas no cubiertas:')
                for s, e in ranges:
                    if s == e:
                        print(f'- L{s}')
                    else:
                        print(f'- L{s}-L{e}')
            else:
                print('No se detectaron lineas sin cubrir en el XML (posible error de instrumentacion)')
            break
" 2>>"${LOG_FILE_ABS:-$LOG_FILE}" || echo "_(no se pudieron extraer lineas no cubiertas)_"
                echo ""
            done <<< "$GAPS"
        } > "$PATCH_SPEC"

        log "Patch spec generado: $PATCH_SPEC"
        COV_PATCH_APPLIED=true

        # Relanzar test-writer con prompt de patch
        PATCH_SPEC_CONTENT=$(cat "$PATCH_SPEC")
        PATCH_TW_PROMPT="Estas en el directorio raiz del proyecto ${HARNESS_PROJECT_NAME}.

El pipeline detecto brechas de cobertura en la implementacion existente. Tu tarea es agregar tests adicionales para cubrir los metodos y lineas que no estan siendo ejecutados por los tests existentes.

La especificacion de remediacion esta en: $PATCH_SPEC

$PATCH_SPEC_CONTENT

IMPORTANTE:
- Lee los archivos de produccion listados para entender que hacen los metodos/branches no cubiertos
- Escribe tests que ejerciten esos paths especificos
- Dado que la implementacion ya existe, los tests nuevos probablemente PASARAN directamente
- Sigue las mismas convenciones de testing del proyecto (Given/When/Then, AwesomeAssertions)
- Haz commit con mensaje: test(hu-${ISSUE_NUM:-?}): tests de cobertura para brechas detectadas
- PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

        # Modelo por stage (issue #1362). Este relanzamiento no pasa por
        # run_agent, pero SI invoca al mismo agente del Stage 1: resolve_tdd_model
        # encadena la clave fina "patch-test-writer" (el stage key que ya usan
        # build_agents_history_json y las metricas de este bloque) con el
        # fallback "$STAGE1_AGENT" -- sin esa caida, un experimento
        # '--models test-writer=X' correria el Stage 1 con X y la remediacion
        # con el default, dos modelos para el mismo rol en la misma corrida.
        # El perfil sale de la MISMA tabla que el Stage 1 (_tdd_agent_profile,
        # CA-1): repetir aqui el literal del perfil dejaria la remediacion
        # corriendo con el perfil viejo el dia que la tabla cambie.
        PATCH_TW_PROFILE="$(_tdd_agent_profile "$STAGE1_AGENT")" \
            || abort "Agente '$STAGE1_AGENT' fuera de la tabla de perfiles TDD (CA-1, issue #1362)"
        resolve_tdd_model "patch-test-writer" "$STAGE1_AGENT" "$PATCH_TW_PROFILE"
        PATCH_TW_MODEL_OVERRIDE="$RESOLVED_TDD_MODEL"

        log "Invocando $STAGE1_AGENT (modelo: ${PATCH_TW_MODEL_OVERRIDE:-<heredado>})..."
        log "Relanzando $STAGE1_AGENT para remediacion..."
        LOG_CG_TW="$LOG_DIR_ABS/stage-4-${STAGE1_AGENT}-patch-${TIMESTAMP}.log"
        EVENTS_CG_TW="${LOG_CG_TW%.log}.events.jsonl"
        PATCH_TW_PROMPT_FILE="$PIPELINE_TMP_DIR/4b-${STAGE1_AGENT}.prompt.md"
        printf '%s' "$PATCH_TW_PROMPT" > "$PATCH_TW_PROMPT_FILE"
        echo "[$(date +%H:%M:%S)] REMEDIATION: relanzando $STAGE1_AGENT" >> "$EVENTS_LOG_ABS"
        CG_TW_EXIT=0
        invoke_agent_once "$STAGE1_AGENT" "$PATCH_TW_PROMPT_FILE" "$EVENTS_CG_TW" "$LOG_CG_TW" "$PATCH_TW_MODEL_OVERRIDE" || CG_TW_EXIT=$?
        AGENT_PATCH_TW_DUR=$LAST_AGENT_DURATION
        # CA-2 (issue #1363): misma forma enriquecida que Stage 1/run_agent.
        AGENT_PATCH_TW_METRICS_JSON="$(enrich_stage_metrics "tdd" "$EVENTS_CG_TW" "$LAST_AGENT_METRICS_JSON" "${ISSUE_NUM:-}" "${VARIANT_LABEL_JSON:-null}" "4b" "$STAGE1_AGENT" "$PATCH_TW_PROFILE" "$HARNESS_IDENTITY_JSON")"
        # CA-3/CA-5 (issue #646): metricas de este patch loop, cosechadas al
        # cierre del stage y respaldadas en disco antes de decidir el resultado.
        echo "$AGENT_PATCH_TW_METRICS_JSON" > "$(mefisto_state_path "metrics/tdd-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}-stage-4b-${STAGE1_AGENT}.json")" 2>/dev/null || true

        if [ "$CG_TW_EXIT" -ne 0 ] || ! agent_events_completed_successfully "$EVENTS_CG_TW"; then
            warn "$STAGE1_AGENT de remediacion fallo (exit $CG_TW_EXIT) — continuando con gaps pendientes"
            echo "[$(date +%H:%M:%S)] REMEDIATION_FAILED: $STAGE1_AGENT exit $CG_TW_EXIT" >> "$EVENTS_LOG_ABS"
            COV_REMEDIATION_SUMMARY="El $STAGE1_AGENT de remediacion fallo (exit $CG_TW_EXIT). Los gaps quedan pendientes."
        else
            # Auto-commit si necesario
            auto_commit_if_needed "cobertura" "test(hu-${ISSUE_NUM:-?}): tests de cobertura para brechas detectadas"

            # Verificar compilacion y tests
            log "Gate: verificando compilacion post-remediacion..."
            cg_build_rc=0
            dotnet build "$WORKTREE_PATH" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 || cg_build_rc=$?

            if [ "$cg_build_rc" -ne 0 ]; then
                warn "Build fallo post-remediacion — relanzando $STAGE2_AGENT..."
                echo "[$(date +%H:%M:%S)] REMEDIATION: build fallo, relanzando $STAGE2_AGENT" >> "$EVENTS_LOG_ABS"

                PATCH_IM_PROMPT="Estas en el directorio raiz del proyecto ${HARNESS_PROJECT_NAME}.

El coverage gate detecto brechas de cobertura y el $STAGE1_AGENT agrego tests adicionales, pero no compilan.
Tu tarea: haz que SOLO los tests nuevos de cobertura compilen y pasen. No modifiques la logica de negocio existente.

Pista: revisa los ultimos archivos de test creados/modificados y corrige errores de compilacion.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

                LOG_CG_IM="$LOG_DIR_ABS/stage-4-${STAGE2_AGENT}-patch-${TIMESTAMP}.log"
                EVENTS_CG_IM="${LOG_CG_IM%.log}.events.jsonl"
                PATCH_IM_PROMPT_FILE="$PIPELINE_TMP_DIR/4c-${STAGE2_AGENT}.prompt.md"
                printf '%s' "$PATCH_IM_PROMPT" > "$PATCH_IM_PROMPT_FILE"
                echo "[$(date +%H:%M:%S)] REMEDIATION: relanzando $STAGE2_AGENT" >> "$EVENTS_LOG_ABS"

                # Modelo por stage (issue #1362): misma cadena que
                # "patch-test-writer" arriba -- clave fina "patch-implementer"
                # con fallback "$STAGE2_AGENT", y el perfil tomado de la tabla
                # del agente relanzado, no de un literal repetido aqui.
                PATCH_IM_PROFILE="$(_tdd_agent_profile "$STAGE2_AGENT")" \
                    || abort "Agente '$STAGE2_AGENT' fuera de la tabla de perfiles TDD (CA-1, issue #1362)"
                resolve_tdd_model "patch-implementer" "$STAGE2_AGENT" "$PATCH_IM_PROFILE"
                PATCH_IM_MODEL_OVERRIDE="$RESOLVED_TDD_MODEL"

                log "Invocando $STAGE2_AGENT (modelo: ${PATCH_IM_MODEL_OVERRIDE:-<heredado>})..."
                CG_IM_EXIT=0
                invoke_agent_once "$STAGE2_AGENT" "$PATCH_IM_PROMPT_FILE" "$EVENTS_CG_IM" "$LOG_CG_IM" "$PATCH_IM_MODEL_OVERRIDE" || CG_IM_EXIT=$?
                AGENT_PATCH_IM_DUR=$LAST_AGENT_DURATION
                # CA-2 (issue #1363): misma forma enriquecida que Stage 2/run_agent.
                AGENT_PATCH_IM_METRICS_JSON="$(enrich_stage_metrics "tdd" "$EVENTS_CG_IM" "$LAST_AGENT_METRICS_JSON" "${ISSUE_NUM:-}" "${VARIANT_LABEL_JSON:-null}" "4c" "$STAGE2_AGENT" "$PATCH_IM_PROFILE" "$HARNESS_IDENTITY_JSON")"
                # CA-3/CA-5 (issue #646): metricas de este patch loop, cosechadas
                # al cierre del stage y respaldadas en disco.
                echo "$AGENT_PATCH_IM_METRICS_JSON" > "$(mefisto_state_path "metrics/tdd-${TIMESTAMP}-issue-${ISSUE_LOG_TAG}-stage-4c-${STAGE2_AGENT}.json")" 2>/dev/null || true

                if [ "$CG_IM_EXIT" -ne 0 ] || ! agent_events_completed_successfully "$EVENTS_CG_IM"; then
                    warn "$STAGE2_AGENT de remediacion fallo (exit $CG_IM_EXIT)"
                    echo "[$(date +%H:%M:%S)] REMEDIATION_FAILED: $STAGE2_AGENT exit $CG_IM_EXIT" >> "$EVENTS_LOG_ABS"
                fi

                auto_commit_if_needed "cobertura" "feat(hu-${ISSUE_NUM:-?}): fix compilacion tests de cobertura"
            fi

            # Gate: verificar tests verdes post-remediacion
            log "Gate: verificando tests post-remediacion..."
            cg_test_rc=0
            CG_TEST_OUTPUT=$(run_tests_projects "$WORKTREE_PATH" 2>&1) || cg_test_rc=$?
            echo "$CG_TEST_OUTPUT" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}" >/dev/null

            if [ "$cg_test_rc" -ne 0 ]; then
                warn "Tests fallan post-remediacion (exit $cg_test_rc) — continuando con gaps pendientes"
                echo "[$(date +%H:%M:%S)] REMEDIATION: tests fallan post-remediacion" >> "$EVENTS_LOG_ABS"
                COV_REMEDIATION_SUMMARY="Se agregaron tests de remediacion pero hay tests fallando (exit $cg_test_rc). Requiere atencion humana."
            else
                # Re-medir cobertura una vez (con timeout de medicion)
                log "Re-midiendo cobertura post-remediacion..."
                CG_REMEASURE_OK=false
                (measure_coverage) &
                CG_REMEASURE_PID=$!
                (sleep $CG_TIMEOUT_MEASURE && kill -9 $CG_REMEASURE_PID 2>/dev/null && \
                    echo "[$(date +%H:%M:%S)] TIMEOUT: re-medicion cobertura supero ${CG_TIMEOUT_MEASURE}s" >> "$EVENTS_LOG_ABS") </dev/null >/dev/null 2>&1 &
                CG_REMEASURE_WATCHDOG=$!
                CG_REMEASURE_EXIT=0
                wait $CG_REMEASURE_PID || CG_REMEASURE_EXIT=$?
                kill $CG_REMEASURE_WATCHDOG 2>/dev/null || true
                wait $CG_REMEASURE_WATCHDOG 2>/dev/null || true
                if [ "$CG_REMEASURE_EXIT" -eq 0 ] && [ -f "$WORKTREE_PATH/coverage.cobertura.xml" ]; then
                    CG_REMEASURE_OK=true
                fi
                if [ "$CG_REMEASURE_OK" = true ]; then
                    COVERAGE_DATA_POST=$(extract_file_coverage "$WORKTREE_PATH/coverage.cobertura.xml" "$LOGIC_FILES")

                    # Reconstruir tabla
                    COV_TABLE="| Archivo | Cobertura | Umbral | Estado |
|---|---|---|---|"
                    GAPS_COUNT=0
                    REMAINING_GAPS=""

                    while IFS='|' read -r filepath pct; do
                        [ -z "$filepath" ] && continue
                        local_basename=$(basename "$filepath")
                        if [ "$pct" = "N/A" ]; then
                            COV_TABLE="$COV_TABLE
| $local_basename | N/A | ${THRESHOLD}% | sin datos |"
                        else
                            pct_int=${pct%.*}
                            if [ "$pct_int" -ge "$THRESHOLD" ]; then
                                COV_TABLE="$COV_TABLE
| $local_basename | ${pct}% | ${THRESHOLD}% | ok |"
                            else
                                COV_TABLE="$COV_TABLE
| $local_basename | ${pct}% | ${THRESHOLD}% | gap |"
                                GAPS_COUNT=$((GAPS_COUNT + 1))
                                REMAINING_GAPS="${REMAINING_GAPS:+$REMAINING_GAPS, }$local_basename (${pct}%)"
                            fi
                        fi
                    done <<< "$COVERAGE_DATA_POST"

                    # Agregar excluidos y sin-clasificar
                    coverage_append_classification_rows

                    if [ "$GAPS_COUNT" -gt 0 ]; then
                        COV_REMEDIATION_SUMMARY="Se agregaron tests de remediacion. Gaps restantes: $REMAINING_GAPS"
                    else
                        COV_REMEDIATION_SUMMARY="Se agregaron tests de remediacion y todos los gaps fueron cerrados."
                    fi
                else
                    warn "Re-medicion de cobertura fallo — manteniendo tabla anterior"
                    COV_REMEDIATION_SUMMARY="Se agregaron tests de remediacion pero la re-medicion fallo. Gaps originales pueden persistir."
                fi
            fi
        fi

        COV_GAPS_REMAINING=$GAPS_COUNT
    else
        log "Todos los archivos de logica superan el umbral de ${THRESHOLD}%"
        COV_GAPS_REMAINING=0
    fi

    AGENT_CG_DUR=$(( $(date +%s) - CG_START ))
    if [ "$COV_GAPS_REMAINING" -gt 0 ]; then
        AGENT_CG_RES="gaps"
        update_status "4-coverage-gate" "gaps"
        warn "Stage 4 completado con $COV_GAPS_REMAINING gap(s) pendiente(s)"
    else
        AGENT_CG_RES="passed"
        update_status "4-coverage-gate" "passed"
        success "Stage 4 completado — cobertura verificada"
    fi
    echo "[$(date +%H:%M:%S)] DONE coverage-gate: ${AGENT_CG_DUR}s, result=$AGENT_CG_RES, gaps=$COV_GAPS_REMAINING" >> "$EVENTS_LOG_ABS"

    fi  # cierre de CG_MEASUREMENT_OK
    fi  # cierre de LOGIC_FILES no vacio
    fi  # cierre de PR_SRC_FILES no vacio
    fi  # cierre de dotnet-coverage disponible
else
    if [ "$IS_REFACTOR" = true ]; then
        log "Saltando Stage 4 (refactoring puro)"
    else
        log "Saltando Stage 4 (--from-stage $FROM_STAGE)"
    fi
    AGENT_CG_RES="skipped"
fi

# ─── Metricas publicables de la corrida ──────────────────────────────────────
# Una unica lista conserva alineados el PR y el historial. Solo se agregan
# etapas con duracion: una etapa omitida no debe convertirse en una fila falsa.
_tdd_add_run_metrics_stage() {
    local label="$1" duration="$2" metrics="$3" history_key="$4" agent="$5"
    [ -n "$duration" ] || return 0
    RUN_METRICS_STAGE_ARGS+=("$label" "$duration" "$metrics")
    if [ "$history_key" = "coverage-gate" ]; then
        HISTORY_COVERAGE_GATE_INCLUDED=true
    else
        HISTORY_AGENT_ARGS+=("$history_key" "$agent" "$duration" "$metrics")
    fi
}

_tdd_collect_run_metrics_stages() {
    RUN_METRICS_STAGE_ARGS=()
    HISTORY_AGENT_ARGS=()
    HISTORY_COVERAGE_GATE_INCLUDED=false

    _tdd_add_run_metrics_stage "Scaffolder" "${AGENT_SCAFFOLD_DUR:-}" "${AGENT_SCAFFOLD_METRICS_JSON:-}" "scaffolder" "domain-scaffolder"
    _tdd_add_run_metrics_stage "$STAGE1_LABEL" "${AGENT_TW_DUR:-}" "${AGENT_TW_METRICS_JSON:-}" "test-writer" "$STAGE1_AGENT"
    _tdd_add_run_metrics_stage "$STAGE2_LABEL" "${AGENT_IM_DUR:-}" "${AGENT_IM_METRICS_JSON:-}" "implementer" "$STAGE2_AGENT"
    _tdd_add_run_metrics_stage "Smoke Test Writer" "${AGENT_ST_DUR:-}" "${AGENT_ST_METRICS_JSON:-}" "smoke-test-writer" "smoke-test-writer"
    _tdd_add_run_metrics_stage "Reviewer" "${AGENT_RV_DUR:-}" "${AGENT_RV_METRICS_JSON:-}" "reviewer" "reviewer"
    _tdd_add_run_metrics_stage "Remediacion: $STAGE1_LABEL" "${AGENT_PATCH_TW_DUR:-}" "${AGENT_PATCH_TW_METRICS_JSON:-}" "patch-test-writer" "$STAGE1_AGENT"
    _tdd_add_run_metrics_stage "Remediacion: $STAGE2_LABEL" "${AGENT_PATCH_IM_DUR:-}" "${AGENT_PATCH_IM_METRICS_JSON:-}" "patch-implementer" "$STAGE2_AGENT"
    # MEF-ADR-0014: el gate es una etapa del pipeline, no un agente. Por eso su
    # fila tiene duracion pero metricas null y deja el Total marcado como parcial.
    _tdd_add_run_metrics_stage "coverage-gate" "${AGENT_CG_DUR:-}" "null" "coverage-gate" ""
}

_tdd_collect_run_metrics_stages
RUN_METRICS_TABLE=$(render_run_metrics_table "${RUN_METRICS_STAGE_ARGS[@]}")

# ─── Crear PR (en modo variante: NO -- CA-3) ─────────────────────────────────
REPO_SLUG_PR="$(git -C "$WORKTREE_PATH" remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')"

if [ -n "$VARIANT_LABEL" ]; then
    header "Modo variante: sin PR"
    warn "Variante '$VARIANT_LABEL': se omiten push, creacion de PR, nota de bloqueo y comentario al issue (CA-3)."
    log "La rama '$BRANCH_NAME' queda LOCAL -- no se publica a origin."
    # El reporte de bloqueo vive DENTRO del worktree, que el cleanup de mas
    # abajo elimina con --force: en la ruta normal sobrevive porque su contenido
    # viaja al comentario del PR, y sin PR se perderia entero. Se copia al
    # directorio canonico de estado del repo principal, con el sufijo de variante para no
    # pisar el de otra corrida, antes de que el cleanup lo borre.
    if [ "${HAS_BLOCKAGE:-false}" = true ]; then
        BLOCKAGE_REPORT="$(mefisto_state_read_first 'blockage-report.md' "$WORKTREE_PATH" 2>/dev/null || true)"
        VARIANT_BLOCKAGE_COPY="$(mefisto_state_path "blockage-report-tdd-${ISSUE_LOG_TAG}.md")"
        if [ -f "$BLOCKAGE_REPORT" ] && cp "$BLOCKAGE_REPORT" "$VARIANT_BLOCKAGE_COPY" 2>/dev/null; then
            warn "Hay tests bloqueados que ni $STAGE2_AGENT ni el reviewer resolvieron -- revisa $VARIANT_BLOCKAGE_COPY antes de promover esta variante."
        else
            warn "Hay tests bloqueados que ni $STAGE2_AGENT ni el reviewer resolvieron, y no se pudo preservar el reporte fuera del worktree -- revisa el log del reviewer antes de promover esta variante."
        fi
    fi
    PR_URL=""
else
    header "Creando PR"

    log "Haciendo push de la rama..."
    git -C "$WORKTREE_PATH" push -u origin "$BRANCH_NAME" >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
        || abort "No se pudo hacer push de la rama $BRANCH_NAME"

    log "Verificando si ya existe un PR abierto para la rama..."
    EXISTING_PR_URL=$(find_open_pr_for_branch "$BRANCH_NAME" "$REPO_SLUG_PR")

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
        CLOSES_LINE=""
        if [ -n "$ISSUE_NUM" ]; then
            CLOSES_LINE="Closes #$ISSUE_NUM"
        fi

        log "Creando PR..."

        # Recolectar resumenes de agentes
        TW_SUMMARY=$(collect_summary "1" "$STAGE1_AGENT")
        IM_SUMMARY=$(collect_summary "2" "$STAGE2_AGENT")
        ST_SUMMARY=$(collect_summary "2b" "smoke-test-writer")
        RV_SUMMARY=$(collect_summary "3" "reviewer")

        # Formatear duraciones
        _fmt_dur() { local s="${1:-0}"; echo "$((s/60))m $((s%60))s"; }
        TW_DUR_FMT=$(_fmt_dur "${AGENT_TW_DUR:-0}")
        IM_DUR_FMT=$(_fmt_dur "${AGENT_IM_DUR:-0}")
        ST_DUR_FMT=$(_fmt_dur "${AGENT_ST_DUR:-0}")
        RV_DUR_FMT=$(_fmt_dur "${AGENT_RV_DUR:-0}")
        CG_DUR_FMT=$(_fmt_dur "${AGENT_CG_DUR:-0}")

        if [ "$IS_REFACTOR" = true ]; then
            PR_BODY_SUMMARY="Pipeline TDD completado (refactoring puro):
- Análisis: no se requieren tests nuevos
- Justificación: $REFACTOR_JUSTIFICATION
- Baseline: $BASELINE_TEST_COUNT tests pasando
- Refactoring ejecutado manteniendo todos los tests verdes"
            IMPLEMENTER_SECTION=""
            SMOKE_TEST_SECTION=""
        elif [ "$IS_SMOKE_ONLY" = true ]; then
            PR_BODY_SUMMARY="Pipeline TDD completado (solo smoke):
- Smoke tests escritos en Stage 1 (corren post-deploy, MEF-ADR-0013)
- Stage 2 en modo documental: solo entregables no-código
- Fase refactor: revisión de calidad"
            IMPLEMENTER_SECTION="<details>
<summary>${STAGE2_LABEL} (modo documental) — ${IM_DUR_FMT}</summary>

${IM_SUMMARY}

</details>
"
            SMOKE_TEST_SECTION="## Validación pendiente post-deploy

Este PR contiene solo smoke tests (\`Category=Smoke\`), que corren contra dev tras el despliegue (MEF-ADR-0013); el gate local no los ejecuta. La evidencia de los criterios de aceptación que dependen de ellos saldrá del job de smoke tras el merge: este PR **no** la presenta como verificada.

Archivos smoke:
$(printf '%s' "$SMOKE_ONLY_FILES" | awk '/^smoke: /{sub(/^smoke: /,""); print "- `" $0 "`"}')
"
        else
            if [ "$AGENT_ST_RES" = "passed" ]; then
                PR_BODY_SUMMARY="Pipeline TDD completado:
- Fase roja: tests escritos con stubs
- Fase verde: implementación completa
- Smoke tests: escritos para endpoints detectados
- Fase refactor: revisión de calidad"
            else
                PR_BODY_SUMMARY="Pipeline TDD completado:
- Fase roja: tests escritos con stubs
- Fase verde: implementación completa
- Fase refactor: revisión de calidad"
            fi
            if [ "$IS_NO_RED_SIGNAL" = true ]; then
                PR_BODY_SUMMARY="$PR_BODY_SUMMARY
- Fase roja no aplicable: $NO_RED_JUSTIFICATION"
            fi
            IMPLEMENTER_SECTION="<details>
<summary>${STAGE2_LABEL} (fase verde) — ${IM_DUR_FMT}</summary>

${IM_SUMMARY}

</details>
"
            if [ "$AGENT_ST_RES" = "passed" ]; then
                SMOKE_TEST_SECTION="<details>
<summary>Smoke Test Writer — ${ST_DUR_FMT}</summary>

${ST_SUMMARY}

</details>
"
            else
                SMOKE_TEST_SECTION=""
            fi
        fi

        # Nota de anomalia de deteccion del Stage 2b (issue #1562): un match
        # bajo src/ que no permitio derivar el proyecto de smoke tests. Senal
        # visible para revision humana del patron de deteccion -- AGENT_ST_RES
        # se mantiene en "skipped" (ver Stage 2b), asi que sin esta nota la
        # anomalia quedaria indistinguible de un skip legitimo.
        SMOKE_ANOMALY_SECTION=""
        if [ -n "$SMOKE_ANOMALY_PATH" ]; then
            SMOKE_ANOMALY_SECTION="## Anomalia de deteccion (Stage 2b)

Un match bajo \`src/\` no permitio derivar el proyecto de smoke tests: \`$SMOKE_ANOMALY_PATH\`. Revisa el patron de deteccion en \`scripts/tdd-pipeline.sh\` (Stage 2b) -- se salto con \`AGENT_ST_RES=skipped\`, igual que un dominio sin proyecto SmokeTests, pero aqui la causa es un patron no reconocido.
"
        fi

        # Smokes que invocan tools MCP modificadas y no cambiaron (issue #2473).
        # Informativa: no bloquea ni cambia AGENT_ST_RES.
        SMOKE_UNCHANGED_SECTION=""
        if [ -n "$SMOKE_INVOKERS" ]; then
            SMOKE_UNCHANGED_LIST=""
            SMOKE_CHANGED_NOW=$(git -C "$WORKTREE_PATH" diff --name-only "$SNAPSHOT_COMMIT"..HEAD 2>/dev/null || true)
            while IFS=$'\t' read -r sm_tool sm_path; do
                [ -n "$sm_path" ] || continue
                if ! printf '%s\n' "$SMOKE_CHANGED_NOW" | grep -qxF -- "$sm_path"; then
                    SMOKE_UNCHANGED_LIST="${SMOKE_UNCHANGED_LIST}- \`${sm_path}\` (invoca \`${sm_tool}\`)
"
                fi
            done <<< "$SMOKE_INVOKERS"
            if [ -n "$SMOKE_UNCHANGED_LIST" ]; then
                SMOKE_UNCHANGED_SECTION="## Smokes que invocan tools modificadas sin cambios

Estos smokes invocan una tool MCP modificada por la HU y no cambiaron. Puede estar bien; revisa que sigan alineados con el contrato nuevo:

${SMOKE_UNCHANGED_LIST}
"
            fi
        fi

        # Construir seccion de cobertura para el PR
        COVERAGE_SECTION=""
        if [ -n "$COV_TABLE" ]; then
            COVERAGE_SECTION="## Cobertura

$COV_TABLE
"
            # La nota va pegada a la tabla, antes de "### Remediacion": explica un
            # marcador de la tabla, y bajo ese encabezado se leeria como parte de
            # la remediacion en vez de como una advertencia sobre la medicion.
            if [ -n "$NOT_EVALUATED_FILES" ]; then
                COVERAGE_SECTION="${COVERAGE_SECTION}
> **Archivos sin clasificar** (\`⚠ revisar\`): ninguna regla de clasificacion los reconocio — el gate **no los midio**. No es una exclusion deliberada (a diferencia de \`excluido\`, donde si se decidio que no requieren cobertura): requieren revision humana para confirmar si necesitan tests.
"
            fi
            if [ "$COV_PATCH_APPLIED" = true ] && [ -n "$COV_REMEDIATION_SUMMARY" ]; then
                COVERAGE_SECTION="${COVERAGE_SECTION}
### Remediacion

$COV_REMEDIATION_SUMMARY
"
            fi
            if [ "$COV_GAPS_REMAINING" -gt 0 ]; then
                COVERAGE_SECTION="${COVERAGE_SECTION}
> **Gaps pendientes**: $COV_GAPS_REMAINING archivo(s) no alcanzan el umbral de cobertura. Requiere revision humana.
"
            fi
        fi

        WARNING_REMNANTS_SECTION="$(render_warning_remnants_section "$WORKTREE_PATH")"
        [ -n "$WARNING_REMNANTS_SECTION" ] && WARNING_REMNANTS_SECTION="${WARNING_REMNANTS_SECTION}

"

        REVIEWER_TESTS_SECTION="$(render_reviewer_touched_tests_section "${REVIEWER_TOUCHED_TESTS:-}" "${BLOCKAGE_RESOLVED:-false}")"
        [ -n "$REVIEWER_TESTS_SECTION" ] && REVIEWER_TESTS_SECTION="${REVIEWER_TESTS_SECTION}

"

        PR_URL=$(gh pr create \
            --title "$ISSUE_TITLE" \
            --body "$(cat <<EOF
## Resumen

$PR_BODY_SUMMARY

## Decisiones del pipeline

<details>
<summary>${STAGE1_LABEL} (fase roja) — ${TW_DUR_FMT}</summary>

${TW_SUMMARY}

</details>

${IMPLEMENTER_SECTION}${SMOKE_TEST_SECTION}<details>
<summary>Reviewer (fase refactor) — ${RV_DUR_FMT}</summary>

${RV_SUMMARY}

</details>

${SMOKE_ANOMALY_SECTION}${SMOKE_UNCHANGED_SECTION}${COVERAGE_SECTION}${WARNING_REMNANTS_SECTION}${REVIEWER_TESTS_SECTION}## Commits

$COMMITS_LIST

## Metricas de la corrida

$RUN_METRICS_TABLE

$CLOSES_LINE
EOF
)" \
            --base main \
            --head "$BRANCH_NAME" \
            --repo "$REPO_SLUG_PR" \
            2>>"${LOG_FILE_ABS:-$LOG_FILE}") \
            || abort "No se pudo crear el PR"

        success "PR creado: $PR_URL"
    fi

    # Si hay bloqueo, agregar label y nota al PR
    if [ "${HAS_BLOCKAGE:-false}" = true ]; then
        PR_NUM=$(echo "$PR_URL" | grep -o '[0-9]*$')
        gh pr edit "$PR_NUM" --add-label "bloqueado" --repo "$REPO_SLUG_PR" >>"$LOG_FILE" 2>&1 \
            || warn "No se pudo agregar label 'bloqueado' al PR"
        BLOCKAGE_REPORT="$(mefisto_state_read_first 'blockage-report.md' "$WORKTREE_PATH" 2>/dev/null || true)"
        if [ -f "$BLOCKAGE_REPORT" ]; then
            BLOCKAGE_CONTENT=$(cat "$BLOCKAGE_REPORT")
            gh pr comment "$PR_NUM" \
                --body "## Tests bloqueados

Este PR tiene tests en rojo que ni el implementer ni el reviewer pudieron resolver. Se requiere atencion humana.

<details>
<summary>Reporte de bloqueo</summary>

$BLOCKAGE_CONTENT

</details>" \
                --repo "$REPO_SLUG_PR" >>"$LOG_FILE" 2>&1 \
                || warn "No se pudo comentar reporte de bloqueo en el PR"
        fi
    fi

    if [ -n "$ISSUE_NUM" ]; then
        gh issue comment "$ISSUE_NUM" \
            --body "Pipeline TDD completado. Decisiones de los agentes en el PR: $PR_URL" \
            --repo "$REPO_SLUG_PR" \
            >>"$LOG_FILE" 2>&1 || warn "No se pudo comentar en el issue #$ISSUE_NUM"
    fi
fi

PIPELINE_PR="$PR_URL"
update_status "done" "completed"

# Append al historial
#
# La lista HISTORY_AGENT_ARGS nace junto a RUN_METRICS_STAGE_ARGS: PR e
# historial enumeran exactamente las mismas etapas efectivamente corridas.
# coverage-gate conserva su forma propia (MEF-ADR-0014) y no pasa por el
# builder porque no tiene metricas de agente.
#
AGENTS_JSON="{\"test-writer\":{\"duration\":${AGENT_TW_DUR:-null}},\"implementer\":{\"duration\":${AGENT_IM_DUR:-null}},\"reviewer\":{\"duration\":${AGENT_RV_DUR:-null}},\"coverage-gate\":{\"duration\":${AGENT_CG_DUR:-null},\"result\":\"$AGENT_CG_RES\",\"gaps\":$COV_GAPS_REMAINING,\"patch_applied\":$COV_PATCH_APPLIED}}"
CORE_AGENTS_JSON=$(build_agents_history_json "${HISTORY_AGENT_ARGS[@]}" 2>/dev/null) || CORE_AGENTS_JSON=""
if [ -n "$CORE_AGENTS_JSON" ]; then
    AGENTS_JSON="$CORE_AGENTS_JSON"
    if [ "$HISTORY_COVERAGE_GATE_INCLUDED" = true ]; then
        COVERAGE_GATE_JSON="{\"coverage-gate\":{\"duration\":${AGENT_CG_DUR:-null},\"result\":\"$AGENT_CG_RES\",\"gaps\":$COV_GAPS_REMAINING,\"patch_applied\":$COV_PATCH_APPLIED}}"
        MERGED_AGENTS_JSON=$(jq -n -c --argjson a "$CORE_AGENTS_JSON" --argjson b "$COVERAGE_GATE_JSON" '$a + $b' 2>/dev/null) || MERGED_AGENTS_JSON=""
        [ -n "$MERGED_AGENTS_JSON" ] && AGENTS_JSON="$MERGED_AGENTS_JSON"
    fi
fi

PR_JSON="null"
[ -n "$PR_URL" ] && PR_JSON="\"$PR_URL\""
TESTS_JSON="$(tests_json_value "${PIPELINE_TESTS:-}")"
# Identidad y runtime via jq -cn (CA-1, issue #1363, MEF-ADR-0053 S6.5) --
# mismo patron que tooling-pipeline.sh (l.975-983).
append_completed_history "$HISTORY_FILE" "$EVENTS_LOG_ABS" \
    jq -cn --arg issue "${ISSUE_NUM:-}" --arg title "${ISSUE_TITLE:-}" --argjson variant "${VARIANT_LABEL_JSON:-null}" \
    --argjson identity "$HARNESS_IDENTITY_JSON" --arg runtime "$MEFISTO_RUNTIME_RESUELTO" --arg started "$TIMESTAMP" --arg finished "$(date +%Y-%m-%dT%H:%M:%S)" \
    --argjson agents "$AGENTS_JSON" --argjson tests "$TESTS_JSON" --argjson pr "$PR_JSON" --arg log "$LOG_FILE" \
    '{issue:$issue,title:$title,pipeline:"tdd",variant:$variant,identity:$identity,runtime:$runtime,started:$started,finished:$finished,state:"completed",agents:$agents,tests:$tests,pr:$pr,log:$log}'

# Eliminar archivo de estado individual (ya esta en el historial)
rm -f "$(mefisto_state_path "$STATUS_FILENAME")"

# ─── Cleanup ──────────────────────────────────────────────────────────────────
header "Cleanup"

log "Eliminando worktree..."
cd "$REPO_ROOT"
git worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 \
    || warn "No se pudo eliminar el worktree automáticamente. Elimínalo manualmente: git worktree remove --force $WORKTREE_PATH"

WORKTREE_PATH=""  # Marcar como eliminado para el trap de errores

success "Worktree eliminado"

# ─── Resumen final ────────────────────────────────────────────────────────────
echo ""
TOTAL_COMMITS=$(echo "$COMMITS_LIST" | wc -l | tr -d ' ')
if [ -n "$VARIANT_LABEL" ]; then
    echo -e "${CYAN}${BOLD}═══ Pipeline (variante '$VARIANT_LABEL') completado ═══${NC}"
    echo ""
    echo -e "  Commits: $TOTAL_COMMITS"
    echo -e "  Rama:    $BRANCH_NAME"
    echo -e "  Estado:  LOCAL -- sin push, sin PR, sin comentario al issue (modo variante)"
    echo -e "  Log:     $LOG_FILE"
    # Senal de calidad comparable entre variantes: sin PR, la tabla de cobertura
    # no tiene donde publicarse, y los gaps son el numero que decide cual gana.
    if [ "$AGENT_CG_RES" != "skipped" ] && [ "$AGENT_CG_RES" != "pending" ]; then
        echo -e "  Gaps:    $COV_GAPS_REMAINING (remediacion aplicada: $COV_PATCH_APPLIED) -- tabla completa en el log del coverage gate"
    fi
    echo ""
    echo -e "${YELLOW}Si esta variante gana la comparacion, promuevela a mano:${NC}"
    echo -e "${YELLOW}  git -C $REPO_ROOT push -u origin $BRANCH_NAME${NC}"
    echo -e "${YELLOW}  gh pr create --base main --head $BRANCH_NAME --title \"$ISSUE_TITLE\" --body \"Closes #$ISSUE_NUM\"${NC}"
    echo -e "${YELLOW}O relanza el pipeline sin --variant para que una corrida normal abra el PR.${NC}"
else
    echo -e "${CYAN}${BOLD}═══ Pipeline completado ═══${NC}"
    echo ""
    echo -e "  Commits: $TOTAL_COMMITS"
    echo -e "  Rama:    $BRANCH_NAME"
    echo -e "  PR:      $PR_URL"
    echo -e "  Log:     $LOG_FILE"
fi
echo ""
