#!/usr/bin/env bash
# iac-pipeline.sh -- Pipeline IaC automatizado
#
# Uso:
#   ./scripts/iac-pipeline.sh 42
#   ./scripts/iac-pipeline.sh 42 --env dev
#   ./scripts/iac-pipeline.sh 42 --from-stage 2  # Retomar desde Stage 2 (revision estatica)
#   MEFISTO_HOLD_MAX_SECONDS=<s> / MEFISTO_HOLD_PROBE_SECONDS=<s> ./scripts/iac-pipeline.sh 42  # Techo (default 21600 = 6h) y cadencia de sondeo (default 300) de la espera ante RATE_LIMIT/PROVIDER_UNAVAILABLE (issue #971, MEF-ADR-0051)
#
# Ciclo: Issue -> Worktree -> Write (HCL) -> Review (revision estatica) -> PR -> Cleanup
#
# El pipeline local NUNCA ejecuta 'terraform plan' ni 'terraform apply' (MEF-ADR-0021, MEF-ADR-0022,
# issue #199): Stage 1 (infra-writer) escribe el HCL y Stage 2 (infra-reviewer) hace revision
# estatica (fmt -check + init -backend=false + validate), sin credenciales de Azure. El PR
# resultante NO lleva 'Closes #N': el plan real corre en el PR (workflow infra-cd.yml, #197) y
# el apply real en el merge a main; el cierre del issue lo hace ese workflow de CI tras un
# apply exitoso (MEF-ADR-0022).

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"

# La clausura publicada conserva src/runtime junto a este script (issue #1624,
# mismo molde que tooling-pipeline.sh). Solo estas dos librerias son contrato
# del pipeline; el runner carga su adaptador aparte.
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
    echo "ERROR: scripts/iac-pipeline.sh es del plugin publicado y solo aplica al consumidor." >&2
    echo "Estas en el repo de Mefisto, que no tiene infraestructura Terraform/Azure." >&2
    echo "Para mejorar el plugin usa /mefisto-tooling." >&2
    exit 1
fi
unset _REPO_TOP

load_harness_config || exit 1

# Identidad de distribucion (issue #1626, mismo patron que tooling-pipeline.sh):
# se revalida contra el runtime resuelto mas abajo, antes de crear evidencia
# durable. Este primer calculo es el valor de arranque, por si el pipeline
# muere antes de resolver el runtime.
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
# Estado operativo publicado (MEF-ADR-0053 seccion 4): este pipeline escribe
# exclusivamente bajo el root canonico que resuelve mefisto_state_path(); el
# fallback legacy de solo lectura, para work-status-collect.sh, vive en
# _pipeline-common.sh (issue #1626, mismo patron que tooling-pipeline.sh).
PIPELINE_DIR="$(dirname "$(mefisto_state_path '.state')")"
LOG_DIR="$(dirname "$(mefisto_state_path 'logs/.state')")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/iac-pipeline-$TIMESTAMP.log"

# --- Exclusion de escritura propia del pipeline (issue #1626, mismo patron ---
# que tooling-pipeline.sh) ----------------------------------------------------
# .mefisto/pipeline/ es evidencia operacional canonica; nunca se versiona ni
# debe colarse en los commits/diff de infra/ que arma este pipeline.
PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')

# --- Tracking de estado ---
AGENT_WR_DUR="" AGENT_WR_RES="pending"
AGENT_RV_DUR="" AGENT_RV_RES="pending"
PIPELINE_ERROR=""
LAST_AGENT_DURATION=0
CURRENT_STAGE="setup"
HOLD_CAUSE_JSON="null" HOLD_NEXT_PROBE_JSON="null" HOLD_CEILING_JSON="null" HOLD_TOTAL=0

_strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }
_log_file()   { echo -e "$1" | _strip_ansi >> "${LOG_FILE_ABS:-$LOG_FILE}"; }

log()     { local m="${BLUE}[$(date +%H:%M:%S)]${NC} $1"; echo -e "$m"; _log_file "$m"; }
success() { local m="${GREEN}${BOLD}v${NC} $1"; echo -e "$m"; _log_file "$m"; }
warn()    { local m="${YELLOW}!${NC} $1"; echo -e "$m"; _log_file "$m"; }
header()  { local m="\n${CYAN}${BOLD}-- $1 --${NC}"; echo -e "$m"; _log_file "$m"; }
abort() {
    PIPELINE_ERROR="$(echo "$1" | sed 's/"/\\"/g' | tr '\n' ' ')"
    echo -e "\n${RED}${BOLD}x ERROR: $1${NC}" | tee -a "${LOG_FILE_ABS:-$LOG_FILE}"
    echo -e "${YELLOW}Revisa el log: ${LOG_FILE_ABS:-$LOG_FILE}${NC}"
    if [ -n "${WORKTREE_PATH:-}" ] && [ -d "$WORKTREE_PATH" ]; then
        echo -e "${YELLOW}El worktree queda en: $WORKTREE_PATH${NC}"
        echo -e "${YELLOW}Para inspeccionar: cd $WORKTREE_PATH${NC}"
    fi
    if [ -n "${PIPELINE_DIR_ABS:-}" ]; then
        update_status "$CURRENT_STAGE" "failed"
        local log_json="null"
        [ -n "${LOG_FILE_ABS:-}" ] && log_json="$(jq -nc --arg l "$LOG_FILE_ABS" '$l' 2>/dev/null)" || log_json="null"
        echo "{\"issue\":\"${ISSUE_NUM:-}\",\"title\":\"$(echo "${ISSUE_TITLE:-}" | sed 's/"/\\"/g')\",\"pipeline\":\"infra\",\"identity\":${HARNESS_IDENTITY_JSON:-null},\"runtime\":${MEFISTO_RUNTIME_JSON:-null},\"environment\":\"${ENVIRONMENT:-}\",\"started\":\"${TIMESTAMP:-}\",\"finished\":\"$(date +%Y-%m-%dT%H:%M:%S)\",\"state\":\"failed\",\"stage\":\"$CURRENT_STAGE\",\"error\":\"$PIPELINE_ERROR\",\"log\":$log_json}" \
            >> "${HISTORY_FILE:-$PIPELINE_DIR_ABS/pipeline-history.jsonl}" 2>/dev/null || true
    fi
    exit 1
}

update_status() {
    local stage="$1" state="$2"
    CURRENT_STAGE="$stage"
    local wr_dur="null" rv_dur="null"
    [ -n "$AGENT_WR_DUR" ] && wr_dur="$AGENT_WR_DUR"
    [ -n "$AGENT_RV_DUR" ] && rv_dur="$AGENT_RV_DUR"
    local error_val="null"
    [ -n "$PIPELINE_ERROR" ] && error_val="\"$PIPELINE_ERROR\""
    cat > "$(mefisto_state_path "$STATUS_FILENAME")" <<EOJSON
{
  "issue": "${ISSUE_NUM:-null}",
  "title": "$(echo "${ISSUE_TITLE:-}" | sed 's/"/\\"/g')",
  "environment": "${ENVIRONMENT:-?}",
  "pipeline": "infra",
  "identity": $HARNESS_IDENTITY_JSON,
  "runtime": ${MEFISTO_RUNTIME_JSON:-null},
  "started": "$TIMESTAMP",
  "stage": "$stage",
  "state": "$state",
  "updated": "$(date +%Y-%m-%dT%H:%M:%S)",
  "worktree": "${WORKTREE_PATH:-}",
  "log": "${LOG_FILE_ABS:-$LOG_FILE}",
  "agents": {
    "infra-writer":   {"duration": $wr_dur, "result": "$AGENT_WR_RES"},
    "infra-reviewer": {"duration": $rv_dur, "result": "$AGENT_RV_RES"}
  },
  "last_error": $error_val
  ,"hold": {"cause": $HOLD_CAUSE_JSON, "next_probe": $HOLD_NEXT_PROBE_JSON, "ceiling_seconds": $HOLD_CEILING_JSON, "accumulated_seconds": $HOLD_TOTAL}
}
EOJSON
}

# --- Parsear argumentos ---
ISSUE_NUM=""
ENVIRONMENT="dev"
FROM_STAGE=1
STATUS_FILENAME=""  # Se asigna despues del parseo (necesita ISSUE_NUM); override con --status-file

if [ $# -eq 0 ]; then
    echo "Uso: $0 <issue-num> [--env <dev|staging|prod>] [--from-stage N] [--status-file NOMBRE]"
    exit 1
fi

POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)
            [ $# -lt 2 ] && abort "Falta el nombre del ambiente"
            ENVIRONMENT="$2"
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

# Si no se paso --status-file, usar convención normalizada con ISSUE_NUM
if [ -z "$STATUS_FILENAME" ]; then
    STATUS_FILENAME="pipeline-status-infra-${ISSUE_NUM}.json"
fi

if ! [[ "$FROM_STAGE" =~ ^[1-2]$ ]]; then
    abort "--from-stage debe ser 1 o 2"
fi

# Verificar que el directorio del ambiente existe
INFRA_ENV_DIR="infra/environments/$ENVIRONMENT"
[ -d "$INFRA_ENV_DIR" ] || abort "No existe el directorio de ambiente: $INFRA_ENV_DIR"

# --- Verificar dependencias ---
# NUNCA se requiere 'az' ni sesion de Azure (MEF-ADR-0021/MEF-ADR-0022, issue #199): el pipeline local
# solo escribe y revisa HCL de forma estatica (fmt/init -backend=false/validate); no hay plan
# ni apply local que autenticar contra Azure.
for cmd in gh git jq terraform; do
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
echo "Pipeline IaC iniciado: $TIMESTAMP" > "$LOG_FILE"

PIPELINE_DIR_ABS="$(dirname "$(mefisto_state_path '.state')")"
LOG_DIR_ABS="$(dirname "$(mefisto_state_path 'logs/.state')")"
LOG_FILE_ABS="$(mefisto_state_path "logs/$(basename "$LOG_FILE")")"
LOG_FILE="$LOG_FILE_ABS"
EVENTS_LOG_ABS="$(mefisto_state_path 'events.log')"
HISTORY_FILE="$(mefisto_state_path 'pipeline-history.jsonl')"
PIPELINE_TMP_DIR="$(mktemp -d -t mefisto-iac)" || abort "No se pudo crear el directorio temporal del pipeline"
[ -d "$PIPELINE_TMP_DIR" ] || abort "No se pudo crear el directorio temporal del pipeline"

echo "=== SESSION IAC $TIMESTAMP issue:$ISSUE_NUM env:$ENVIRONMENT from-stage:$FROM_STAGE runtime:$MEFISTO_RUNTIME_RESUELTO ===" >> "$EVENTS_LOG_ABS"

# --- Resolver modelos neutrales (issue #1624) ------------------------------
# El override publico gana por clave exacta (mapping opcional del consumidor);
# sin override el adaptador decide su default por perfil, o se hereda. Mismo
# helper que resolve_tooling_model de tooling-pipeline.sh, sin --models (el
# pipeline IaC nunca lo soporto tampoco del lado Claude).
CONSUMER_MODELS_FILE="$(git rev-parse --show-toplevel)/.mefisto/models.json"
RESOLVED_INFRA_MODEL=""
resolve_infra_model() {
    local agent_id="$1" profile="$2" output
    output="$(mktemp)"
    if ! mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile" "" "$CONSUMER_MODELS_FILE" > "$output"; then
        rm -f "$output"
        abort "No se pudo resolver el modelo de $agent_id (perfil $profile): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"
    fi
    RESOLVED_INFRA_MODEL="$(cat "$output")"; rm -f "$output"
    echo "[$(date +%H:%M:%S)] MODELS: $agent_id runtime=$MEFISTO_RUNTIME_RESUELTO perfil=$profile solicitado=<automatico> resuelto='${RESOLVED_INFRA_MODEL:-<heredado>}'" >> "$EVENTS_LOG_ABS"
}
resolve_infra_model infra-writer balanced
MODEL_WRITER="$RESOLVED_INFRA_MODEL"
resolve_infra_model infra-reviewer deep
MODEL_REVIEWER="$RESOLVED_INFRA_MODEL"
# Effort por agente (issue #2500): nivel de fabrica + mapping del consumidor,
# resuelto antes de crear el worktree; vacio = heredar (sin --effort).
resolve_pipeline_agent_effort infra-writer infra-writer \
    || abort "No se pudo resolver el effort de infra-writer: MEFISTO_EFFORTS_ERROR=${PIPELINE_EFFORT_ERROR:-motivo desconocido}"
EFFORT_WRITER="$RESOLVED_PIPELINE_EFFORT"
resolve_pipeline_agent_effort infra-reviewer infra-reviewer \
    || abort "No se pudo resolver el effort de infra-reviewer: MEFISTO_EFFORTS_ERROR=${PIPELINE_EFFORT_ERROR:-motivo desconocido}"
EFFORT_REVIEWER="$RESOLVED_PIPELINE_EFFORT"

# --- Obtener issue ---
header "Preparando contexto"

log "Descargando issue #$ISSUE_NUM..."
ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --json number,title,body,state,labels 2>>"$LOG_FILE") \
    || abort "No se pudo obtener el issue #$ISSUE_NUM"
ISSUE_STATE=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])" 2>/dev/null || echo "UNKNOWN")
if [ "$ISSUE_STATE" != "OPEN" ]; then
    abort "El issue #$ISSUE_NUM esta $ISSUE_STATE -- una corrida solo procesa issues abiertos.
El cierre de un issue de infra lo hace el workflow de CI (infra-cd.yml) tras un 'terraform
apply' exitoso en main (MEF-ADR-0022), no este pipeline. Si necesitas reescribir/revisar la infra
de un issue ya cerrado, reabrelo primero."
fi
ISSUE_TITLE=$(echo "$ISSUE_JSON" | grep -o '"title":"[^"]*"' | sed 's/"title":"//;s/"//')
ISSUE_BODY=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['body'])" 2>/dev/null \
    || echo "$ISSUE_JSON" | sed 's/.*"body":"//;s/","[^"]*":".*//;s/\\n/\n/g;s/\\r//g')
ISSUE_CONTEXT="# Issue #$ISSUE_NUM: $ISSUE_TITLE

$ISSUE_BODY"
log "Issue: $ISSUE_TITLE"

# --- Gate de dependencias bloqueadas ---
# Defensa en profundidad del semaforo que gestiona el planner (MEF-ADR-0007):
# solo se inspeccionan dependencias si el issue trae el label, para conservar el
# camino habitual sin consultas adicionales.
ISSUE_HAS_BLOCKED_LABEL=$(echo "$ISSUE_JSON" | python3 -c '
import json, sys
labels = json.load(sys.stdin).get("labels") or []
print("true" if any((label.get("name") if isinstance(label, dict) else label) == "bloqueado" for label in labels) else "false")
' 2>/dev/null || echo "false")

if [ "$ISSUE_HAS_BLOCKED_LABEL" = true ]; then
    DEPENDENCY_REFS=()
    while IFS= read -r dependency; do
        [ -n "$dependency" ] && DEPENDENCY_REFS+=("$dependency")
    done < <(printf '%s\n' "$ISSUE_BODY" | python3 -c '
import re, sys
body = sys.stdin.read()
section = re.search(r"(?ms)^## Dependencias[^\n]*\n(.*?)(?=^## |\Z)", body)
seen = set()
if section:
    for number in re.findall(r"#([0-9]+)", section.group(1)):
        if number not in seen:
            print(number)
            seen.add(number)
')

    PENDING_DEPENDENCIES=()
    # Bash 3.2 (el /bin/bash nativo de macOS) aborta bajo set -u al expandir un
    # array vacio. La seccion puede no contener referencias y eso equivale a que
    # no quedan dependencias pendientes, no a un fallo del pipeline.
    if [ ${#DEPENDENCY_REFS[@]} -gt 0 ]; then
        for dependency in "${DEPENDENCY_REFS[@]}"; do
            # Una referencia puede apuntar a issue o PR. Conservamos el orden del
            # contrato de /implement: issue primero y PR como fallback.
            DEPENDENCY_JSON=$(gh issue view "$dependency" --json state,title 2>/dev/null \
                || gh pr view "$dependency" --json state,title 2>/dev/null \
                || echo '{"state":"UNKNOWN","title":"titulo no disponible"}')
            DEPENDENCY_STATE=$(echo "$DEPENDENCY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", "UNKNOWN"))' 2>/dev/null || echo "UNKNOWN")
            DEPENDENCY_TITLE=$(echo "$DEPENDENCY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("title", "titulo no disponible"))' 2>/dev/null || echo "titulo no disponible")

            if [ "$DEPENDENCY_STATE" != "CLOSED" ] && [ "$DEPENDENCY_STATE" != "MERGED" ]; then
                PENDING_DEPENDENCIES+=("  - #$dependency: $DEPENDENCY_TITLE ($DEPENDENCY_STATE)")
            fi
        done
    fi

    if [ ${#PENDING_DEPENDENCIES[@]} -gt 0 ]; then
        abort "El issue #$ISSUE_NUM esta bloqueado. Dependencias abiertas:
$(printf '%s\n' "${PENDING_DEPENDENCIES[@]}")

Resuelve estas dependencias antes de lanzar el pipeline."
    fi

    gh issue edit "$ISSUE_NUM" --remove-label "bloqueado" >>"$LOG_FILE" 2>&1 \
        || abort "No se pudo quitar el label 'bloqueado' del issue #$ISSUE_NUM"
    success "Dependencias resueltas: se quito el label 'bloqueado' del issue #$ISSUE_NUM"
fi

echo "$ISSUE_CONTEXT" > "$PIPELINE_TMP_DIR/infra-input.md"

# --- Preparar worktree ---
header "Preparando worktree"

REPO_ROOT=$(git rev-parse --show-toplevel)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | tr -s '-' | cut -c1-40 | sed 's/-$//')
BRANCH_NAME="infra-issue-${ISSUE_NUM}-${SLUG}"
WORKTREE_PATH="${REPO_ROOT}/.mefisto/pipeline/worktrees/${BRANCH_NAME}"

# Retomar: si el worktree solo existe en la ruta anterior (al lado del repo), usarlo.
LEGACY_WORKTREE_PATH="${REPO_ROOT}/../${BRANCH_NAME}"
if [ "$FROM_STAGE" -gt 1 ] && [ ! -d "$WORKTREE_PATH" ] && [ -d "$LEGACY_WORKTREE_PATH" ]; then
    log "Worktree no encontrado en la ruta nueva; usando el de la ruta anterior: $LEGACY_WORKTREE_PATH"
    WORKTREE_PATH="$LEGACY_WORKTREE_PATH"
fi

# Ruta absoluta al directorio del ambiente dentro del worktree
INFRA_ENV_DIR_ABS_WT="$WORKTREE_PATH/$INFRA_ENV_DIR"

if [ "$FROM_STAGE" -gt 1 ]; then
    [ -d "$WORKTREE_PATH" ] || abort "No existe el worktree en $WORKTREE_PATH. No se puede retomar desde Stage $FROM_STAGE."
    log "Retomando desde Stage $FROM_STAGE -- worktree existente: $WORKTREE_PATH"
    SNAPSHOT_COMMIT=$(git -C "$WORKTREE_PATH" merge-base HEAD main)
    log "Snapshot detectado: $SNAPSHOT_COMMIT"
    INFRA_ENV_DIR_ABS="$(realpath "$INFRA_ENV_DIR_ABS_WT")"
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

    # --- Copiar y commitear backend.tf del working tree al worktree (issue #86) ---
    # bootstrap-backend.sh escribe infra/environments/<env>/backend.tf en el working
    # tree del consumidor, pero este worktree se ramifica SIEMPRE desde origin/main,
    # donde ese backend.tf puede no estar versionado aun (flujo greenfield). Sin esta
    # copia, el terraform init/validate del reviewer correria sin el backend remoto
    # configurado en el HCL versionado -- y CI (que aplica sobre este mismo HCL, MEF-ADR-0022)
    # se quedaria sin backend.tf en su checkout. Copiamos el backend.tf y lo commiteamos
    # en la rama del worktree para que viaje en el PR del pipeline y se versione en main
    # via merge (sin push directo a main). El reviewer sigue corriendo con
    # 'init -backend=false' (revision estatica, sin credenciales de Azure); el backend
    # remoto que este archivo declara lo usa CI, no el pipeline local.
    BACKEND_SRC="$REPO_ROOT/$INFRA_ENV_DIR/backend.tf"
    if [ -f "$BACKEND_SRC" ]; then
        log "Copiando backend.tf del working tree al worktree..."
        mkdir -p "$INFRA_ENV_DIR_ABS_WT"
        cp "$BACKEND_SRC" "$INFRA_ENV_DIR_ABS_WT/backend.tf"
        # Si el backend.tf ya estaba identico en origin/main (no-greenfield), la copia
        # es un no-op en el diff y no hay nada que commitear.
        if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- "$INFRA_ENV_DIR/backend.tf")" ]; then
            git -C "$WORKTREE_PATH" add "$INFRA_ENV_DIR/backend.tf"
            git -C "$WORKTREE_PATH" commit -m "infra($ENVIRONMENT): incluir backend.tf generado por bootstrap"
        else
            log "backend.tf ya estaba versionado e identico en origin/main -- sin cambios que commitear"
        fi
    else
        warn "No existe $INFRA_ENV_DIR/backend.tf en el working tree -- el pipeline continua sin abortar; si necesitas backend remoto, ejecuta primero bootstrap-backend.sh"
    fi

    INFRA_ENV_DIR_ABS="$(realpath "$INFRA_ENV_DIR_ABS_WT")"

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

# --- Funcion auxiliar para invocar agentes ---
# Frontera neutral publicada (issue #1624, mismo molde que run_agent de
# tooling-pipeline.sh): el runner (mefisto-run-agent.sh) es autoridad de
# watchdog, argv y terminal; este nivel conserva exclusivamente la politica
# de hold/retry de MEF-ADR-0051 sobre el JSONL neutral -- ahora leida de
# error.kind, nunca de un CLI concreto.
run_agent() {
    local stage="$1"
    local agent="$2"
    local prompt="$3"
    local log_base="$LOG_DIR_ABS/iac-stage-${stage}-${agent}-${TIMESTAMP}-issue-${ISSUE_NUM}"
    local log_stage="${log_base}.log"
    local prompt_file="$PIPELINE_TMP_DIR/${stage}-${agent}.prompt.md"
    local system_file="$PIPELINE_TMP_DIR/${stage}-${agent}.system.md"
    local runner_file="$PIPELINE_TMP_DIR/${stage}-${agent}.runner.log"
    printf '%s' "$prompt" > "$prompt_file"
    printf '%s\n' 'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.' > "$system_file"

    echo "[$(date +%H:%M:%S)] === IAC STAGE $stage: $agent ===" >> "$EVENTS_LOG_ABS"
    case "$agent" in
        infra-writer)   AGENT_WR_RES="running" ;;
        infra-reviewer) AGENT_RV_RES="running" ;;
    esac

    local model="" effort=""
    case "$agent" in
        infra-writer)   model="$MODEL_WRITER"; effort="$EFFORT_WRITER" ;;
        infra-reviewer) model="$MODEL_REVIEWER"; effort="$EFFORT_REVIEWER" ;;
    esac

    update_status "$stage-$agent" "running"
    log "Invocando $agent (modelo: ${model:-<heredado>})..."

    local AGENT_TIMEOUT_SECONDS=1800
    local start_ts run_exit=0 elapsed=0 failure_type="" hold_started="" hold_total=0
    local resume_session="" resume_degraded=false attempt=0
    local summary_file
    summary_file="$(mefisto_state_path "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH")"
    start_ts=$(date +%s)
    while :; do
        attempt=$((attempt + 1))
        local events_file="${log_base}-attempt-${attempt}.events.jsonl"
        local attempt_prompt="$prompt_file" attempt_resume=false
        if [ -n "$resume_session" ]; then
            attempt_resume=true
            attempt_prompt="$PIPELINE_TMP_DIR/${stage}-${agent}-resume-${attempt}.prompt.md"
            printf '%s\n' "Continue the same stage and complete its summary." > "$attempt_prompt"
        fi
        local args=(--runtime "$MEFISTO_RUNTIME_RESUELTO" --agent "$agent" --cwd "$WORKTREE_PATH" --prompt-file "$attempt_prompt" --system-file "$system_file" --event-log "$events_file" --events-log "$EVENTS_LOG_ABS" --redact-observability --timeout "$AGENT_TIMEOUT_SECONDS")
        [ -n "$model" ] && args+=(--model "$model")
        [ -n "$effort" ] && args+=(--effort "$effort")
        [ -n "$resume_session" ] && args+=(--resume-session "$resume_session")
        if "$RUN_AGENT_BIN" "${args[@]}" >"$runner_file" 2>&1; then run_exit=0; else run_exit=$?; fi
        [ "$attempt_prompt" = "$prompt_file" ] || rm -f "$attempt_prompt"
        elapsed=$(( $(date +%s) - start_ts ))
        derive_stage_log_from_stream "$events_file" "" "$log_stage"

        if [ "$run_exit" -eq 0 ] && agent_events_completed_successfully "$events_file"; then
            failure_type=""
            break
        fi

        failure_type="$(classify_neutral_agent_failure "$run_exit" "$events_file")"
        log "$agent fallo tras ${elapsed}s -- tipo: $failure_type"
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

        local resets slept
        resets="$(agent_events_resets_at "$events_file")"
        if ! slept=$(agent_hold_wait "$EVENTS_LOG_ABS" "$failure_type" "$hold_started" "$resets"); then
            warn "$agent: techo de espera (hold) agotado -- ultima senal: $failure_type"
            break
        fi
        hold_total=$((hold_total + slept))
        HOLD_TOTAL="$hold_total"

        # Reanudacion de sesion (MEF-ADR-0051): mientras resume_degraded siga
        # en false, la siguiente sonda continua la sesion truncada via el
        # session_id del JSONL neutral en vez de reenviar el prompt entero.
        # Si esa sonda tambien termina sin dejar el resumen del stage, se
        # degrada PERMANENTEMENTE a inicio limpio (nunca se vuelve a intentar
        # reanudar en este mismo run_agent).
        if [ "$attempt_resume" = true ] && [ ! -s "$summary_file" ]; then
            warn "$agent: la sesion reanudada termino sin resumen; se degrada permanentemente a inicio limpio"
            echo "[$(date +%H:%M:%S)][hold][resume] $agent: sesion reanudada murio de nuevo sin resumen -- degradado a stage desde cero" >> "$EVENTS_LOG_ABS"
            resume_degraded=true; resume_session=""
        elif [ "$resume_degraded" = false ]; then
            resume_session="$(agent_events_session_id "$events_file")"
            if [ -z "$resume_session" ]; then
                warn "$agent: terminal sin session_id; la sonda inicia de cero"
            elif ! runtime_supports_resume "$MEFISTO_RUNTIME_RESUELTO"; then
                warn "$agent: runtime sin capacidad de reanudacion; la sonda inicia de cero"
                resume_session=""
            else
                warn "$agent: $failure_type -- en espera (hold), reanudando sesion truncada..."
            fi
        fi
    done

    HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL="$hold_total"

    if [ -n "$failure_type" ]; then
        case "$agent" in
            infra-writer)   AGENT_WR_DUR=$elapsed; AGENT_WR_RES="failed" ;;
            infra-reviewer) AGENT_RV_DUR=$elapsed; AGENT_RV_RES="failed" ;;
        esac
        update_status "$stage-$agent" "failed"
        echo -e "\n${RED}-- Ultimas lineas del log de $agent:${NC}"
        tail -20 "$log_stage"
        abort "$agent fallo ($failure_type). Log completo: $log_stage"
    fi

    LAST_AGENT_DURATION=$((elapsed - hold_total))
    log "$agent completado en ${LAST_AGENT_DURATION}s"
}

# --- STAGE 1: infra-writer (escribir HCL) ---
if [ "$FROM_STAGE" -le 1 ]; then
    header "Stage 1: infra-writer (escribir HCL)"

    STAGE1_PROMPT="Estas en el directorio raiz del proyecto ${HARNESS_PROJECT_NAME}.

Contexto del issue de infraestructura a implementar:

$ISSUE_CONTEXT

Ambiente target: $ENVIRONMENT
Directorio del ambiente: $INFRA_ENV_DIR_ABS
Directorio relativo del ambiente: $INFRA_ENV_DIR
Commit base: $SNAPSHOT_COMMIT

Tu tarea: escribe o modifica los archivos Terraform necesarios para implementar este issue en el ambiente '$ENVIRONMENT'. Sigue todas las instrucciones de tu rol de infra-writer.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

    run_agent "1" "infra-writer" "$STAGE1_PROMPT"

    AGENT_WR_DUR=$LAST_AGENT_DURATION
    AGENT_WR_RES="passed"

    # Gate 1: el HCL debe ser valido
    log "Gate: verificando terraform validate..."
    (cd "$INFRA_ENV_DIR_ABS" && terraform init -backend=false -input=false >>"$LOG_FILE_ABS" 2>&1) \
        || abort "Stage 1 fallido: terraform init fallo"
    (cd "$INFRA_ENV_DIR_ABS" && terraform validate >>"$LOG_FILE_ABS" 2>&1) \
        || abort "Stage 1 fallido: terraform validate fallo. Revisa el log."
    success "Gate 1: HCL valido"

    # Auto-commit si hay cambios
    if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- infra/ "${PIPELINE_OWN_WRITES[@]}")" ]; then
        log "Commiteando cambios de HCL..."
        git -C "$WORKTREE_PATH" add infra/
        git -C "$WORKTREE_PATH" commit -m "infra($ENVIRONMENT): escritura HCL issue #${ISSUE_NUM}"
    fi

    update_status "1-infra-writer" "passed"
fi

# --- STAGE 2: infra-reviewer (revision estatica) ---
header "Stage 2: infra-reviewer (revision estatica)"

DIFF_CONTEXT=$(git -C "$WORKTREE_PATH" diff main...HEAD -- infra/ 2>/dev/null | head -200 || echo "(sin diff disponible)")

STAGE2_PROMPT="Estas en el directorio raiz del proyecto ${HARNESS_PROJECT_NAME}.

Contexto del issue:

$ISSUE_CONTEXT

Ambiente target: $ENVIRONMENT
Directorio del ambiente: $INFRA_ENV_DIR_ABS
Directorio relativo del ambiente: $INFRA_ENV_DIR
Commit base: $SNAPSHOT_COMMIT

Diff de archivos .tf modificados en esta rama:
$DIFF_CONTEXT

Tu tarea: revisa el HCL producido por infra-writer, corrige problemas de seguridad o calidad, y ejecuta la revision estatica ('terraform fmt -check', 'terraform init -backend=false' y 'terraform validate') en '$INFRA_ENV_DIR_ABS'. NUNCA ejecutes 'terraform plan' ni 'terraform apply': no hay credenciales de Azure disponibles en este flujo local. Sigue todas las instrucciones de tu rol de infra-reviewer.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."

run_agent "2" "infra-reviewer" "$STAGE2_PROMPT"

AGENT_RV_DUR=$LAST_AGENT_DURATION
AGENT_RV_RES="passed"

# Gate 2: el HCL revisado debe seguir siendo valido (CA-1: sin plan, sin tfplan)
log "Gate: verificando terraform validate tras la revision..."
(cd "$INFRA_ENV_DIR_ABS" && terraform init -backend=false -input=false >>"$LOG_FILE_ABS" 2>&1) \
    || abort "Stage 2 fallido: terraform init fallo"
(cd "$INFRA_ENV_DIR_ABS" && terraform validate >>"$LOG_FILE_ABS" 2>&1) \
    || abort "Stage 2 fallido: terraform validate fallo. Revisa el log."
success "Gate 2: HCL revisado y valido"

# Commit de correcciones del reviewer si las hubo
if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- infra/ "${PIPELINE_OWN_WRITES[@]}")" ]; then
    log "Commiteando correcciones del reviewer..."
    git -C "$WORKTREE_PATH" add infra/
    git -C "$WORKTREE_PATH" commit -m "infra($ENVIRONMENT): correcciones de revision issue #${ISSUE_NUM}"
fi

update_status "2-infra-reviewer" "passed"

REPO_SLUG="$(git -C "$WORKTREE_PATH" remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')"

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
    git -C "$WORKTREE_PATH" merge origin/main --no-edit >>"${LOG_FILE_ABS:-$LOG_FILE}" 2>&1 \
        || abort "Merge con main tiene conflictos. Resuelve manualmente en: $WORKTREE_PATH"
    success "Merge automatico exitoso"
fi

# --- Crear PR ---
header "Creando PR"

log "Haciendo push de la rama..."
git -C "$WORKTREE_PATH" push -u origin "$BRANCH_NAME" >>"$LOG_FILE_ABS" 2>&1 \
    || abort "No se pudo hacer push de la rama $BRANCH_NAME"

# Gate de PR existente (issue #378): si un agente del pipeline creo el PR el mismo (violando la
# prohibicion de push/PR de su prompt), reutilizamos su URL en vez de dejar PR_URL vacio -- el
# 'gh pr create' de abajo degrada con 'warn', asi que sin este gate el pipeline seguia pero
# reportaba 'PR: pendiente' en el issue y "" en el historial, perdiendo el rastro del PR real.
log "Verificando si ya existe un PR abierto para la rama..."
EXISTING_PR_URL=$(find_open_pr_for_branch "$BRANCH_NAME" "$REPO_SLUG")

if [ -n "$EXISTING_PR_URL" ]; then
    PR_URL="$EXISTING_PR_URL"
    success "PR existente reutilizado: $PR_URL"
else

# MEF-ADR-0022 ("Cierre del issue de infra: al aplicar en CI, no al mergear el PR"): el PR de este
# pipeline NUNCA lleva 'Closes #N'. El plan real corre en el PR (workflow infra-cd.yml, job
# 'plan', #197) y el apply real en el merge a main (job 'apply'); ese job deriva el numero de
# issue de la rama 'infra-issue-<num>-*' y cierra el issue tras un apply exitoso (#197 CA-5).
CLOSES_LINE="> **Apply pendiente en CI**: este PR no cierra el issue #$ISSUE_NUM. El \`terraform apply\` lo ejecuta el workflow **Infra CD** al mergear este PR a \`main\` (MEF-ADR-0022); el issue se cierra automaticamente cuando ese apply termine exitosamente."

WR_SUMMARY=$(collect_summary "1" "infra-writer")
RV_SUMMARY=$(collect_summary "2" "infra-reviewer")

_fmt_dur() { local s="${1:-0}"; echo "$((s/60))m $((s%60))s"; }
WR_DUR_FMT=$(_fmt_dur "${AGENT_WR_DUR:-0}")
RV_DUR_FMT=$(_fmt_dur "${AGENT_RV_DUR:-0}")

PR_URL=$(gh pr create \
    --title "infra($ENVIRONMENT): #$ISSUE_NUM $ISSUE_TITLE" \
    --body "$(cat <<EOF
## Infraestructura

Implementa los cambios de infraestructura del issue #$ISSUE_NUM.

- **Ambiente**: $ENVIRONMENT
- **Estado**: HCL escrito y revisado localmente (sin plan ni apply local); pendiente de aplicar por CI
- **Pipeline**: iac-pipeline.sh

## Decisiones del pipeline

<details>
<summary>infra-writer -- ${WR_DUR_FMT}</summary>

${WR_SUMMARY}

</details>

<details>
<summary>infra-reviewer -- ${RV_DUR_FMT}</summary>

${RV_SUMMARY}

</details>

$(render_warning_remnants_section "$WORKTREE_PATH")

## Cambios Terraform

$(git -C "$WORKTREE_PATH" diff main...HEAD --stat -- infra/ 2>/dev/null || echo "(ver diff del PR)")

## Commits

$COMMITS_LIST

$CLOSES_LINE
EOF
)" \
    --base main \
    --head "$BRANCH_NAME" \
    --repo "$REPO_SLUG" \
    2>>"$LOG_FILE_ABS") || warn "No se pudo crear el PR automaticamente"

[ -n "${PR_URL:-}" ] && success "PR creado: $PR_URL"

fi  # cierre del gate de PR existente

gh issue comment "$ISSUE_NUM" \
    --body "Pipeline IaC completado (HCL escrito y revisado, sin plan ni apply local). PR: ${PR_URL:-pendiente}. Infra pendiente de aplicar por CI: el workflow **Infra CD** aplica al mergear a main y cierra este issue tras un apply exitoso (MEF-ADR-0022)." \
    --repo "$REPO_SLUG" \
    >>"$LOG_FILE" 2>&1 || warn "No se pudo comentar en el issue #$ISSUE_NUM"

# --- Historial ---
echo "{\"issue\":\"$ISSUE_NUM\",\"title\":\"$(echo "$ISSUE_TITLE" | sed 's/"/\\"/g')\",\"pipeline\":\"infra\",\"identity\":${HARNESS_IDENTITY_JSON:-null},\"runtime\":${MEFISTO_RUNTIME_JSON:-null},\"environment\":\"$ENVIRONMENT\",\"started\":\"$TIMESTAMP\",\"finished\":\"$(date +%Y-%m-%dT%H:%M:%S)\",\"state\":\"completed\",\"agents\":{\"infra-writer\":{\"duration\":${AGENT_WR_DUR:-null},\"result\":\"$AGENT_WR_RES\"},\"infra-reviewer\":{\"duration\":${AGENT_RV_DUR:-null},\"result\":\"$AGENT_RV_RES\"}},\"pr\":\"${PR_URL:-}\",\"log\":\"$LOG_FILE\"}" \
    >> "$HISTORY_FILE"

update_status "completed" "completed"

# Eliminar archivo de estado individual (ya esta en el historial)
rm -f "$(mefisto_state_path "$STATUS_FILENAME")"

# --- Cleanup ---
header "Cleanup"

log "Eliminando worktree..."
cd "$REPO_ROOT"
rm -rf "$PIPELINE_TMP_DIR" 2>/dev/null || true
git worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 \
    || warn "No se pudo eliminar el worktree. Eliminalo manualmente: git worktree remove --force $WORKTREE_PATH"

WORKTREE_PATH=""

success "Worktree eliminado"

echo ""
echo -e "${CYAN}${BOLD}=== Pipeline IaC completado ===${NC}"
echo ""
echo -e "  Issue:     #$ISSUE_NUM -- $ISSUE_TITLE"
echo -e "  Ambiente:  $ENVIRONMENT"
TOTAL_COMMITS=$(echo "$COMMITS_LIST" | wc -l | tr -d ' ')
echo -e "  Commits:   $TOTAL_COMMITS"
echo -e "  Rama:      $BRANCH_NAME"
[ -n "${PR_URL:-}" ] && echo -e "  PR:        $PR_URL"
echo -e "  Log:       $LOG_FILE_ABS"
echo ""
echo -e "${YELLOW}Infra pendiente de aplicar por CI:${NC} el workflow Infra CD aplica al mergear el PR a main y cierra el issue #$ISSUE_NUM tras un apply exitoso (MEF-ADR-0022)."
echo ""
