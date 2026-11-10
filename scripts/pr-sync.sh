#!/usr/bin/env bash
# pr-sync.sh — Sincroniza ramas de PRs abiertos con main
#
# Uso:
#   ./scripts/pr-sync.sh 40 41 42               # sincronizar PRs en orden
#   ./scripts/pr-sync.sh 40 41 42 --merge       # sincronizar y mergear cada uno
#   ./scripts/pr-sync.sh --all                   # todos los PRs abiertos
#   ./scripts/pr-sync.sh --all --merge           # sincronizar y mergear todos
#
# Compatible con bash 3.2+ (macOS nativo)

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"

# La clausura publicada conserva src/runtime junto a este script. Solo estas
# dos librerias son contrato del pipeline; el runner carga su adaptador aparte
# (mismo patron que tooling-pipeline.sh y tdd-pipeline.sh).
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

load_harness_config || exit 1

# ─── Colores ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Logging ─────────────────────────────────────────────────────────────────
# LOG_DIR_ABS/LOG_FILE_ABS se resuelven en "Inicializar log", tras los guards,
# porque mefisto_state_path crea el directorio al invocarse.
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

_strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }
_log_file()   { echo -e "$1" | _strip_ansi >> "$LOG_FILE_ABS"; }

log()     { local m="${BLUE}[$(date +%H:%M:%S)]${NC} $1"; echo -e "$m"; _log_file "$m"; }
success() { local m="${GREEN}${BOLD}✓${NC} $1"; echo -e "$m"; _log_file "$m"; }
warn()    { local m="${YELLOW}⚠${NC} $1"; echo -e "$m"; _log_file "$m"; }
header()  { local m="\n${CYAN}${BOLD}── $1 ──${NC}"; echo -e "$m"; _log_file "$m"; }

# ─── Status tracker (compatible bash 3.2, sin declare -A) ────────────────────
PR_STATUS_NUMS=()
PR_STATUS_VALUES=()
PR_STATUS_BRANCHES=()

set_status() {
    local pr="$1" val="$2"
    local i
    for i in "${!PR_STATUS_NUMS[@]}"; do
        if [ "${PR_STATUS_NUMS[$i]}" = "$pr" ]; then
            PR_STATUS_VALUES[$i]="$val"
            return
        fi
    done
    PR_STATUS_NUMS+=("$pr")
    PR_STATUS_VALUES+=("$val")
}

get_status() {
    local pr="$1" i
    for i in "${!PR_STATUS_NUMS[@]}"; do
        if [ "${PR_STATUS_NUMS[$i]}" = "$pr" ]; then
            echo "${PR_STATUS_VALUES[$i]}"
            return
        fi
    done
    echo "desconocido"
}

set_branch() {
    local pr="$1" branch="$2"
    local i
    for i in "${!PR_STATUS_NUMS[@]}"; do
        if [ "${PR_STATUS_NUMS[$i]}" = "$pr" ]; then
            PR_STATUS_BRANCHES[$i]="$branch"
            return
        fi
    done
    # Si no existe, crear entrada
    PR_STATUS_NUMS+=("$pr")
    PR_STATUS_VALUES+=("pendiente")
    PR_STATUS_BRANCHES+=("$branch")
}

get_branch() {
    local pr="$1" i
    for i in "${!PR_STATUS_NUMS[@]}"; do
        if [ "${PR_STATUS_NUMS[$i]}" = "$pr" ]; then
            echo "${PR_STATUS_BRANCHES[$i]:-"(no disponible)"}"
            return
        fi
    done
    echo "(no disponible)"
}

# ─── Abort de PR individual (no detiene el loop) ─────────────────────────────
CURRENT_WORKTREE=""
HAVE_ERRORS=false

# ─── Status estructurado por PR (visibilidad en vivo, issue #1601) ──────────
#
# CURRENT_PR_STATUS/CURRENT_PR_STAGE/CURRENT_PR_TITLE son variables de
# contexto que el loop principal fija por cada PR en curso: run_agent() no
# recibe el numero de PR como argumento (su firma no cambia, la reutilizan
# los tests con awk), asi que necesita este contexto para saber a que archivo
# de status escribir durante un ciclo de hold.
CURRENT_PR_STATUS=""
CURRENT_PR_STAGE=""
CURRENT_PR_TITLE=""
HOLD_CAUSE_JSON="null"
HOLD_NEXT_PROBE_JSON="null"
HOLD_CEILING_JSON="null"
HOLD_TOTAL=0

# write_pr_status_file <pr> <stage> <state> [last_error]
#
# Escribe pipeline-status-pr-sync-<pr>.json bajo el root canonico
# .mefisto/pipeline (MEF-ADR-0053 seccion 4), con el mismo esquema y nombres
# de campo que update_status() de tooling-pipeline.sh. "issue" lleva el
# numero de PR (string): junto con pipeline:"pr-sync" forma la clave de
# deduplicacion (pipeline, issue, variant) de #1597; "pr" repite el mismo
# valor para que un consumidor de esa clave no tenga que adivinar la
# semantica de "issue" en este pipeline. DISTINTA de set_status: ese tracker
# en memoria (arriba) solo alimenta la tabla del resumen final y no se toca
# aqui. Sin entrada en pipeline-history.jsonl -- el alcance es visibilidad en
# vivo (issue #1586, CA-4 corregido).
write_pr_status_file() {
    local pr="$1" stage="$2" state="$3" last_error="${4:-}"
    local status_path
    status_path="$(mefisto_state_path "pipeline-status-pr-sync-${pr}.json")"

    # "started" se preserva del primer estado escrito para este PR (running,
    # stage sync): las transiciones posteriores leen el archivo existente en
    # vez de recalcularlo.
    local started=""
    if [ -f "$status_path" ]; then
        started="$(jq -r '.started // empty' "$status_path" 2>/dev/null || true)"
    fi
    [ -n "$started" ] || started="$(date +%Y-%m-%dT%H:%M:%S)"

    jq -n \
        --arg issue "$pr" \
        --arg pr "$pr" \
        --arg title "${CURRENT_PR_TITLE:-}" \
        --arg runtime "${MEFISTO_RUNTIME_RESUELTO:-}" \
        --arg started "$started" \
        --arg stage "$stage" \
        --arg state "$state" \
        --arg updated "$(date +%Y-%m-%dT%H:%M:%S)" \
        --arg log "${LOG_FILE_ABS:-}" \
        --arg last_error "$last_error" \
        --argjson hold_cause "${HOLD_CAUSE_JSON:-null}" \
        --argjson hold_next_probe "${HOLD_NEXT_PROBE_JSON:-null}" \
        --argjson hold_ceiling "${HOLD_CEILING_JSON:-null}" \
        --argjson hold_accumulated "${HOLD_TOTAL:-0}" \
        '{
            issue: $issue,
            pr: $pr,
            title: $title,
            pipeline: "pr-sync",
            variant: null,
            runtime: (if $runtime == "" then null else $runtime end),
            started: $started,
            stage: $stage,
            state: $state,
            updated: $updated,
            log: $log,
            last_error: (if $last_error == "" then null else $last_error end),
            hold: {cause: $hold_cause, next_probe: $hold_next_probe, ceiling_seconds: $hold_ceiling, accumulated_seconds: $hold_accumulated}
        }' > "$status_path"
}

fail_pr() {
    local pr="$1" msg="$2"
    echo -e "\n${RED}${BOLD}✗ PR #$pr: $msg${NC}" | tee -a "$LOG_FILE_ABS"
    set_status "$pr" "ERROR: $msg"
    write_pr_status_file "$pr" "${CURRENT_PR_STAGE:-sync}" "failed" "$msg"
    HAVE_ERRORS=true

    # Limpiar worktree si existe
    if [ -n "${CURRENT_WORKTREE:-}" ] && [ -d "${CURRENT_WORKTREE:-}" ]; then
        warn "Worktree temporal queda en: $CURRENT_WORKTREE (para inspección)"
        git worktree remove --force "$CURRENT_WORKTREE" >>"$LOG_FILE_ABS" 2>&1 || true
    fi
    CURRENT_WORKTREE=""
}

# ─── Parsear argumentos ───────────────────────────────────────────────────────
PR_NUMS=()
DO_MERGE=false
DO_ALL=false

if [ $# -eq 0 ]; then
    echo "Uso: $0 [PR_NUM...] [--all] [--merge]"
    echo "  PR_NUM...   Números de PRs a sincronizar (en orden)"
    echo "  --all       Sincronizar todos los PRs abiertos"
    echo "  --merge     Mergear a main después de sincronizar"
    exit 1
fi

while [ $# -gt 0 ]; do
    case "$1" in
        --merge) DO_MERGE=true; shift ;;
        --all)   DO_ALL=true; shift ;;
        [0-9]*)  PR_NUMS+=("$1"); shift ;;
        *)
            echo "Argumento desconocido: $1"
            exit 1
            ;;
    esac
done

# ─── Verificar que estamos en el repo correcto ────────────────────────────────
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) \
    || { echo "No estás en un repositorio git"; exit 1; }

# Guard defensivo: este script es del lado publicado y solo aplica al consumidor.
# Para mergear PRs del repo de Mefisto, usa /mefisto-merge.
if [ -f "$REPO_ROOT/.claude-plugin/plugin.json" ]; then
    echo "ERROR: scripts/pr-sync.sh es del plugin publicado y solo aplica al consumidor." >&2
    echo "Estás en el repo de Mefisto. Para mergear PRs del plugin, usa /mefisto-merge." >&2
    exit 1
fi

cd "$REPO_ROOT"

# ─── Inicializar log ──────────────────────────────────────────────────────────
# Estado operativo canonico (MEF-ADR-0053 seccion 4, mismo patron que
# tdd-pipeline.sh): solo se escribe bajo .mefisto/pipeline. pr-sync no lee
# estado previo, asi que no usa mefisto_state_read_paths.
LOG_DIR_ABS="$(dirname "$(mefisto_state_path 'logs/.state')")"
LOG_FILE_ABS="$LOG_DIR_ABS/pr-sync-$TIMESTAMP.log"
touch "$LOG_FILE_ABS"

# events.log es el mismo archivo canonico que work-status-collect.sh lee para reportar
# "EN ESPERA": run_agent() deja ahi la linea "[hold] ..." de MEF-ADR-0051
# seccion 3 (agent_hold_wait), compartido con tdd-pipeline.sh/tooling-pipeline.sh
# si corren en el mismo repo. Atribuir esas horas a un issue en el reporte de
# batch-pipeline.sh queda fuera de alcance (issue #1586): pr-sync solo conoce
# el PR, no el issue que lo origino.
EVENTS_LOG_ABS="$(mefisto_state_path 'events.log')"

# ─── Trap de cierre: marca failed si el PR en curso queda running/hold ──────
# Cubre interrupciones (Ctrl-C, kill, timeout externo) que nunca pasan por
# fail_pr(): sin este trap, work-status-collect.sh seguiria mostrando ese PR "en
# progreso" o "en espera" para siempre (issue #1601, CA-4). Solo toca el PR
# EN CURSO (CURRENT_PR_STATUS) -- los PRs ya cerrados (completed/failed) o
# nunca alcanzados no se tocan.
pr_sync_exit_trap() {
    local rc=$?
    if [ -n "${CURRENT_PR_STATUS:-}" ]; then
        local status_path
        status_path="$(mefisto_state_path "pipeline-status-pr-sync-${CURRENT_PR_STATUS}.json" 2>/dev/null || true)"
        if [ -n "$status_path" ] && [ -f "$status_path" ] \
            && jq -e '.state == "running" or .state == "hold"' "$status_path" >/dev/null 2>&1; then
            write_pr_status_file "$CURRENT_PR_STATUS" "${CURRENT_PR_STAGE:-sync}" "failed" "pr-sync interrumpido"
        fi
    fi
    exit "$rc"
}
# INT/TERM salen con su codigo convencional (130/143) y delegan en el trap de
# EXIT: dentro de un trap de senal, $? es el del ultimo comando, no la senal,
# y un Ctrl-C podria terminar con exit 0.
trap pr_sync_exit_trap EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

header "pr-sync — Sincronización de PRs con main"
log "Log: $LOG_FILE_ABS"

# ─── Verificar dependencias ───────────────────────────────────────────────────
MISSING_DEPS=""
for dep in gh git dotnet; do
    if ! command -v "$dep" >/dev/null 2>&1; then
        MISSING_DEPS="$MISSING_DEPS $dep"
    fi
done
if [ -n "$MISSING_DEPS" ]; then
    echo -e "${RED}${BOLD}✗ Dependencias faltantes:${MISSING_DEPS}${NC}"
    exit 1
fi

# El runner neutral reemplaza la exigencia de un CLI concreto (MEF-ADR-0049/0050):
# la frontera es src/runtime/mefisto-run-agent.sh, resuelto igual que en
# tooling-pipeline.sh/tdd-pipeline.sh, y el runtime activo detras de el.
RUN_AGENT_BIN="${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}"
if [ ! -x "$RUN_AGENT_BIN" ]; then
    echo -e "${RED}${BOLD}✗ No es ejecutable el runner neutral: $RUN_AGENT_BIN${NC}"
    exit 1
fi
if ! mefisto_resolve_runtime >/dev/null; then
    echo -e "${RED}${BOLD}✗ No se pudo resolver el runtime activo: ${MEFISTO_RUNTIME_ERROR:-motivo desconocido}${NC}"
    exit 1
fi
MEFISTO_RUNTIME_RESUELTO="$MEFISTO_RESOLVED_RUNTIME"

# Modelo neutral del implementer (perfil 'balanced', declarado por
# src/published/agents/implementer.md): el mapping opcional del consumidor gana
# sobre el default del adaptador; vacio = heredar (sin --model, mismo criterio
# que resolve_tooling_model en tooling-pipeline.sh).
CONSUMER_MODELS_FILE="$REPO_ROOT/.mefisto/models.json"
IMPLEMENTER_MODEL_FILE="$(mktemp)"
if ! mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "implementer" "balanced" "" "$CONSUMER_MODELS_FILE" > "$IMPLEMENTER_MODEL_FILE"; then
    rm -f "$IMPLEMENTER_MODEL_FILE"
    echo -e "${RED}${BOLD}✗ No se pudo resolver el modelo de implementer (perfil balanced): ${MEFISTO_MODELS_ERROR:-motivo desconocido}${NC}"
    exit 1
fi
IMPLEMENTER_MODEL="$(cat "$IMPLEMENTER_MODEL_FILE")"; rm -f "$IMPLEMENTER_MODEL_FILE"

# Effort neutral del implementer (issue #2500), en el mismo punto que su modelo
# y antes del bucle de PRs; sirve a merge y fix. Vacio = heredar (sin --effort).
if ! resolve_pipeline_agent_effort implementer implementer; then
    echo -e "${RED}${BOLD}✗ No se pudo resolver el effort de implementer: ${PIPELINE_EFFORT_ERROR:-motivo desconocido} (MEFISTO_EFFORTS_ERROR)${NC}"
    exit 1
fi
IMPLEMENTER_EFFORT="$RESOLVED_PIPELINE_EFFORT"

# ─── Resolver lista de PRs (compatible bash 3.2, sin mapfile) ─────────────────
if [ "$DO_ALL" = true ]; then
    log "Obteniendo todos los PRs abiertos..."
    PR_NUMS=()
    while IFS= read -r num; do
        [ -n "$num" ] && PR_NUMS+=("$num")
    done < <(gh pr list --state open --json number -q '.[].number' | sort -n)
    if [ ${#PR_NUMS[@]} -eq 0 ]; then
        log "No hay PRs abiertos."
        exit 0
    fi
fi

if [ ${#PR_NUMS[@]} -eq 0 ]; then
    echo -e "${RED}${BOLD}✗ No se especificaron PRs. Usa --all o proporciona números de PR.${NC}"
    exit 1
fi

log "PRs a procesar (en orden): ${PR_NUMS[*]}"
if [ "$DO_MERGE" = true ]; then
    warn "Modo --merge activado: cada PR será mergeado a main después de sincronizar"
fi

# ─── Función: invocar agente ──────────────────────────────────────────────────
#
# Aplica la politica de hold de MEF-ADR-0051 (issue #1586): un fallo que
# classify_neutral_agent_failure clasifica como RATE_LIMIT*/PROVIDER_UNAVAILABLE*
# (agent_failure_is_holdable) no retorna fallo de inmediato -- espera con
# agent_hold_wait (honra resets_at, MEFISTO_HOLD_PROBE_SECONDS,
# MEFISTO_HOLD_MAX_SECONDS) y reintenta, reanudando con --resume-session cuando
# el terminal trajo session_id y el runtime activo soporta reanudacion
# (runtime_supports_resume). Al agotarse el techo de espera, o ante cualquier
# otro fallo (TIMEOUT/STREAM_CUT/KILLED/PROTOCOL_INVALID/API_ERROR_CLIENT/
# CLI_ERROR, ninguno holdable), retorna != 0 sin esperar y el caller conserva
# su fail_pr actual.
#
# pr-sync no tiene resumen de stage (MEF-ADR-0051 seccion 2, enmendada): el
# trabajo de una sesion reanudada se acepta o rechaza con las postcondiciones
# que el caller YA verifica despues de esta funcion (sin archivos en conflicto
# para merge-pr, validate_tests para fix-pr) -- evidencia mas fuerte que un
# resumen, asi que aqui no se agrega ningun chequeo nuevo.
run_agent() {
    local label="$1"
    local agent="$2"
    local prompt="$3"
    local worktree="$4"
    local log_base="$LOG_DIR_ABS/pr-sync-${label}-${TIMESTAMP}"
    local prompt_file system_file start_ts run_exit elapsed
    local failure_type="" hold_started="" resume_session="" attempt=0 hold_total=0

    # Estado de hold limpio para esta invocacion (issue #1601, CA-3): un
    # run_agent previo para el mismo PR (p.ej. merge-pr seguido de fix-pr) no
    # debe dejar cause/next_probe/ceiling filtrandose a este.
    HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL=0

    prompt_file="$(mktemp)"
    system_file="$(mktemp)"
    printf '%s' "$prompt" > "$prompt_file"
    printf '%s\n' 'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.' > "$system_file"

    while :; do
        attempt=$((attempt + 1))
        local log_file="${log_base}-attempt-${attempt}.log"
        local events_file="${log_base}-attempt-${attempt}.events.jsonl"
        local attempt_prompt="$prompt_file"
        run_exit=0

        if [ -n "$resume_session" ]; then
            attempt_prompt="$(mktemp)"
            printf '%s\n' "Continue the same stage and complete its work." > "$attempt_prompt"
        fi

        log "Invocando $agent (modelo: ${IMPLEMENTER_MODEL:-<heredado>})..."
        start_ts=$(date +%s)

        local args=(--runtime "$MEFISTO_RUNTIME_RESUELTO" --agent "$agent" --cwd "$worktree" --prompt-file "$attempt_prompt" --system-file "$system_file" --event-log "$events_file")
        [ -n "$IMPLEMENTER_MODEL" ] && args+=(--model "$IMPLEMENTER_MODEL")
        [ -n "$IMPLEMENTER_EFFORT" ] && args+=(--effort "$IMPLEMENTER_EFFORT")
        [ -n "$resume_session" ] && args+=(--resume-session "$resume_session")

        "$RUN_AGENT_BIN" "${args[@]}" >"$log_file" 2>&1 || run_exit=$?
        [ "$attempt_prompt" = "$prompt_file" ] || rm -f "$attempt_prompt"
        elapsed=$(( $(date +%s) - start_ts ))

        if [ "$run_exit" -eq 0 ] && agent_events_completed_successfully "$events_file"; then
            log "$agent completado en ${elapsed}s"
            HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL="$hold_total"
            rm -f "$prompt_file" "$system_file"
            return 0
        fi

        failure_type="$(classify_neutral_agent_failure "$run_exit" "$events_file")"
        if ! agent_failure_is_holdable "$failure_type"; then
            warn "$agent falló después de ${elapsed}s"
            echo -e "\n${RED}── Últimas líneas del log de $agent:${NC}"
            tail -20 "$log_file"
            HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL="$hold_total"
            rm -f "$prompt_file" "$system_file"
            return 1
        fi

        [ -z "$hold_started" ] && hold_started=$(date +%s)
        warn "$agent: $failure_type. Esperando (hold) antes de reintentar (MEF-ADR-0051)..."

        # Status estructurado del hold (issue #1601, CA-3): mismo molde que
        # tooling-pipeline.sh (~578-595) -- next_probe es un estimado de
        # cadencia fija, no el resets_at exacto que agent_hold_wait honra
        # internamente. Solo escribe si el loop dejo el contexto del PR
        # (CURRENT_PR_STATUS): los tests H-a..d de run_agent aislado no lo
        # fijan y no deben crear ningun archivo de status.
        HOLD_CAUSE_JSON="\"$failure_type\""
        HOLD_CEILING_JSON="${MEFISTO_HOLD_MAX_SECONDS:-21600}"
        local next_probe_epoch next_probe
        next_probe_epoch=$(( $(date +%s) + ${MEFISTO_HOLD_PROBE_SECONDS:-300} ))
        next_probe="$(date -u -r "$next_probe_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$next_probe_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
        [ -n "$next_probe" ] && HOLD_NEXT_PROBE_JSON="\"$next_probe\"" || HOLD_NEXT_PROBE_JSON="null"
        HOLD_TOTAL="$hold_total"
        [ -n "${CURRENT_PR_STATUS:-}" ] && write_pr_status_file "$CURRENT_PR_STATUS" "${CURRENT_PR_STAGE:-$label}" "hold"

        local slept resets
        resets="$(agent_events_resets_at "$events_file")"
        if ! slept=$(agent_hold_wait "$EVENTS_LOG_ABS" "$failure_type" "$hold_started" "$resets"); then
            warn "$agent: se agotó el techo de espera (MEFISTO_HOLD_MAX_SECONDS) tras ${elapsed}s en el último intento"
            echo -e "\n${RED}── Últimas líneas del log de $agent:${NC}"
            tail -20 "$log_file"
            HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL="$hold_total"
            rm -f "$prompt_file" "$system_file"
            return 1
        fi
        hold_total=$((hold_total + slept))
        HOLD_CAUSE_JSON="null"; HOLD_NEXT_PROBE_JSON="null"; HOLD_CEILING_JSON="null"; HOLD_TOTAL="$hold_total"
        log "$agent: espera de ${slept}s cumplida, reintentando..."
        [ -n "${CURRENT_PR_STATUS:-}" ] && write_pr_status_file "$CURRENT_PR_STATUS" "${CURRENT_PR_STAGE:-$label}" "running"

        resume_session="$(agent_events_session_id "$events_file")"
        if [ -z "$resume_session" ]; then
            warn "$agent: terminal sin session_id; la sonda inicia de cero"
        elif ! runtime_supports_resume "$MEFISTO_RUNTIME_RESUELTO"; then
            warn "$agent: runtime sin capacidad de reanudación; la sonda inicia de cero"
            resume_session=""
        fi
    done
}

# ─── Función: validar tests post-merge ────────────────────────────────────────
validate_tests() {
    local worktree="$1"
    local test_output


    # Build explícito: dotnet test con compilación implícita falla en worktrees
    # por FileNotFoundException en assemblies de proyecto (Contracts).
    local build_output
    build_output=$(dotnet build "$worktree/${HARNESS_SOLUTION_FILE}" 2>&1)
    local build_rc=$?
    echo "$build_output" >> "$LOG_FILE_ABS"
    if [ "$build_rc" -ne 0 ]; then
        echo "$build_output"
        return 2  # error de compilación
    fi

    # run_tests_projects (scripts/_pipeline-common.sh) corre solo los proyectos
    # *.Tests/, excluyendo *.SmokeTests/ (issue #305): los smoke tests son
    # black-box contra el entorno dev desplegado y abortarian aqui con 401 /
    # "ServiceBus no configurado" porque este gate corre local, sin credenciales
    # de entorno (MEF-ADR-0013 — siguen cubiertos post-deploy por smoke-tests-dominio.yml).
    #
    # Contrato de run_tests_projects: 0 = todos pasan, 8 = ningun proyecto tenia
    # tests para ejecutar, otro codigo = fallo real de tests (el build explicito
    # previo ya descarto el error de compilación).
    local test_rc=0
    test_output=$(run_tests_projects "$worktree" --no-build 2>&1) || test_rc=$?
    echo "$test_output" >> "$LOG_FILE_ABS"

    case "$test_rc" in
        0) ;;  # todo bien, continuar
        8)
            echo "$test_output"
            return 3  # no se ejecutaron tests
            ;;
        *)
            echo "$test_output"
            return 1  # tests fallidos
            ;;
    esac

    echo "$test_output"
    return 0
}

# ─── Función: mergear PR con retry (P2) ──────────────────────────────────────
merge_pr_with_retry() {
    local pr_num="$1"
    local max_retries=5
    local wait_seconds=3
    local attempt

    # Detectar el método de merge permitido por el repositorio. `gh pr merge`
    # exige exactamente uno de --merge/--squash/--rebase en modo no interactivo;
    # hardcodear --merge rompe en repos que prohíben merge commits (p. ej. con
    # `required_linear_history` o `allow_merge_commit=false`), devolviendo
    # "Merge commits are not allowed on this repository". Preferencia:
    # merge > squash > rebase, cayendo al primer método que el repo permita.
    local merge_flag methods
    methods=$(gh api "repos/{owner}/{repo}" \
        --jq '(if .allow_merge_commit then "merge " else "" end)
            + (if .allow_squash_merge then "squash " else "" end)
            + (if .allow_rebase_merge then "rebase" else "" end)' 2>/dev/null || echo "")
    case "$methods" in
        *merge*)  merge_flag="--merge" ;;
        *squash*) merge_flag="--squash" ;;
        *rebase*) merge_flag="--rebase" ;;
        *)        merge_flag="--merge" ;;  # fallback: comportamiento previo
    esac
    log "Método de merge permitido por el repo: ${merge_flag#--}"

    for attempt in $(seq 1 "$max_retries"); do
        # Un PR cerrado informa UNKNOWN como mergeStateStatus. Consultar ambos
        # campos evita confundir ese estado con un merge pendiente.
        local pr_view pr_state status merge_attempted merge_failure
        pr_view=$(gh pr view "$pr_num" --json state,mergeStateStatus 2>/dev/null || echo '{"state":"UNKNOWN","mergeStateStatus":"UNKNOWN"}')
        pr_state=$(printf '%s' "$pr_view" | jq -r '.state // "UNKNOWN"' 2>/dev/null || echo "UNKNOWN")
        status=$(printf '%s' "$pr_view" | jq -r '.mergeStateStatus // "UNKNOWN"' 2>/dev/null || echo "UNKNOWN")
        merge_attempted=false
        merge_failure=""

        if [ "$pr_state" = "MERGED" ]; then
            return 0
        fi

        if [ "$status" = "CLEAN" ] || [ "$status" = "UNSTABLE" ] || [ "$status" = "HAS_HOOKS" ]; then
            local merge_out merged_state
            merge_attempted=true
            if merge_out=$(gh pr merge "$pr_num" "$merge_flag" --delete-branch 2>&1); then
                printf '%s\n' "$merge_out" >>"$LOG_FILE_ABS"
                return 0
            fi
            printf '%s\n' "$merge_out" >>"$LOG_FILE_ABS"
            merged_state=$(gh pr view "$pr_num" --json state -q '.state' 2>/dev/null || echo "UNKNOWN")
            if [ "$merged_state" = "MERGED" ]; then
                warn "PR #$pr_num: el merge se completó, pero gh pr merge falló después: $merge_out"
                return 0
            fi
            # Rechazos que NO se resuelven reintentando (método no permitido,
            # checks/reviews requeridos, conflictos): abortar con la causa real
            # en lugar de reportar falsamente "aún no mergeable".
            if printf '%s' "$merge_out" | grep -qiE "not allowed|not mergeable|required|not authorized|changes requested|conflict"; then
                warn "PR #$pr_num: GitHub rechazó el merge y no es reintentable → $merge_out"
                return 1
            fi
            merge_failure=$(printf '%s\n' "$merge_out" | awk 'NF { print; exit }')
            [ -n "$merge_failure" ] || merge_failure="(sin salida)"
        fi

        if [ "$attempt" -lt "$max_retries" ]; then
            if [ "$merge_attempted" = true ]; then
                log "gh pr merge falló: $merge_failure. Reintentando en ${wait_seconds}s... ($attempt/$max_retries)"
            else
                log "GitHub aún no reporta PR #$pr_num como mergeable (estado: $status). Reintentando en ${wait_seconds}s... ($attempt/$max_retries)"
            fi
            sleep "$wait_seconds"
            wait_seconds=$((wait_seconds * 2))
        fi
    done

    if [ "$merge_attempted" = true ]; then
        warn "PR #$pr_num: gh pr merge falló tras $max_retries intentos: $merge_failure"
    else
        warn "PR #$pr_num no fue mergeable después de $max_retries intentos (último estado: $status)"
    fi
    return 1
}

# ─── Función: desbloquear issues dependientes tras merge ─────────────────
desbloquear_issues_dependientes() {
    local pr_num="$1"

    # Obtener body del PR para extraer "Closes #N"
    local pr_body
    pr_body=$(gh pr view "$pr_num" --json body -q '.body' 2>/dev/null || echo "")
    if [ -z "$pr_body" ]; then
        return 0
    fi

    # Extraer todos los issue numbers cerrados por este PR
    local closed_issues=()
    local match
    while IFS= read -r match; do
        [ -n "$match" ] && closed_issues+=("$match")
    done < <(echo "$pr_body" | grep -ioE 'Closes #[0-9]+' | grep -oE '[0-9]+')

    if [ ${#closed_issues[@]} -eq 0 ]; then
        return 0
    fi

    log "PR #$pr_num cierra issue(s): ${closed_issues[*]}. Buscando issues bloqueados dependientes..."

    # Obtener todos los issues abiertos con label "bloqueado"
    local bloqueados_json
    bloqueados_json=$(gh issue list --state open --label "bloqueado" --json number,body,title 2>/dev/null || echo "[]")

    if [ "$bloqueados_json" = "[]" ] || [ -z "$bloqueados_json" ]; then
        log "No hay issues con label 'bloqueado'."
        return 0
    fi

    # Para cada issue bloqueado, verificar si depende de alguno de los issues cerrados
    local bloqueado_count
    bloqueado_count=$(echo "$bloqueados_json" | jq 'length')

    local idx=0
    while [ "$idx" -lt "$bloqueado_count" ]; do
        local bloqueado_num
        bloqueado_num=$(echo "$bloqueados_json" | jq -r ".[$idx].number")
        local bloqueado_body
        bloqueado_body=$(echo "$bloqueados_json" | jq -r ".[$idx].body // \"\"")
        local bloqueado_title
        bloqueado_title=$(echo "$bloqueados_json" | jq -r ".[$idx].title // \"\"")

        # Extraer seccion ## Dependencias del body
        # Usa awk para compatibilidad con macOS (head -n -1 no funciona en BSD)
        local deps_section
        deps_section=$(echo "$bloqueado_body" | awk '/^## Dependencias/{found=1; next} /^## /{found=0} found{print}')

        # Verificar si este issue bloqueado referencia alguno de los issues cerrados
        local referencia_cerrado=false
        local closed_num
        for closed_num in "${closed_issues[@]}"; do
            if echo "$deps_section" | grep -qE "#${closed_num}([^0-9]|$)"; then
                referencia_cerrado=true
                break
            fi
        done

        if [ "$referencia_cerrado" = true ]; then
            # Extraer SOLO las dependencias forward canonicas ('Depende de' / 'Bloqueado por')
            # y SOLO si el marcador va al inicio del item (vineta opcional): 'No depende de #N'
            # o el marcador a mitad de linea no cuentan,
            # ignorando refs inversas/notas ('Consumido por', 'Bloquea'/'Bloquea a',
            # 'se traslada a', 'Relacionado con', prosa libre).
            local all_deps=()
            local dep_num
            while IFS= read -r dep_num; do
                [ -n "$dep_num" ] && all_deps+=("$dep_num")
            done < <(echo "$deps_section" \
                | grep -ioE '^[[:space:]]*([-*][[:space:]]+)?(Depende de|Bloqueado por)[[:space:]]+#[0-9]+' \
                | grep -oE '[0-9]+' | sort -u)

            # Guardia de longitud (CA-1): bajo bash 3.2 + set -u, expandir
            # "${all_deps[@]}" de un array vacio es 'unbound variable' fatal.
            # Esto ocurre cuando la seccion referencia el issue cerrado con
            # redaccion no canonica (p.ej. "Depende del write-side: #N") — pasa
            # el filtro de referencia_cerrado pero no matchea el regex forward.
            if [ ${#all_deps[@]} -eq 0 ]; then
                warn "Issue #$bloqueado_num referencia un issue recien cerrado en su sección '## Dependencias' pero sin redacción canónica parseable ('Depende de #N' / 'Bloqueado por #N'); no se pudo evaluar su desbloqueo automático."
            else
                # Verificar si TODAS las dependencias estan cerradas/mergeadas
                local todas_cerradas=true
                local dep_abierta=""
                for dep_num in "${all_deps[@]}"; do
                    local dep_state
                    # Intentar como issue primero
                    dep_state=$(gh issue view "$dep_num" --json state -q '.state' 2>/dev/null || echo "")
                    if [ "$dep_state" = "CLOSED" ]; then
                        continue
                    fi
                    # Intentar como PR
                    dep_state=$(gh pr view "$dep_num" --json state -q '.state' 2>/dev/null || echo "")
                    if [ "$dep_state" = "MERGED" ] || [ "$dep_state" = "CLOSED" ]; then
                        continue
                    fi
                    # Si llegamos aqui, la dependencia sigue abierta
                    todas_cerradas=false
                    dep_abierta="$dep_num"
                    break
                done

                if [ "$todas_cerradas" = true ]; then
                    log "Desbloqueando issue #$bloqueado_num: $bloqueado_title"
                    if gh issue edit "$bloqueado_num" --remove-label "bloqueado" >>"$LOG_FILE_ABS" 2>&1; then
                        success "Issue #$bloqueado_num desbloqueado: $bloqueado_title"
                    else
                        warn "No se pudo quitar el label 'bloqueado' del issue #$bloqueado_num"
                    fi
                else
                    log "Issue #$bloqueado_num sigue bloqueado (dependencia #$dep_abierta aun abierta)"
                fi
            fi
        fi

        idx=$((idx + 1))
    done
}

# ─── Loop principal ───────────────────────────────────────────────────────────
for PR_NUM in "${PR_NUMS[@]}"; do
    header "PR #$PR_NUM"
    CURRENT_WORKTREE=""
    CURRENT_PR_TITLE=""

    # Verificar que el PR sigue abierto (la misma consulta trae el titulo
    # para el status estructurado, CA-1: evita una segunda llamada a gh)
    PR_VIEW_JSON=$(gh pr view "$PR_NUM" --json state,title 2>/dev/null || echo '{}')
    PR_STATE=$(printf '%s' "$PR_VIEW_JSON" | jq -r '.state // "NOT_FOUND"' 2>/dev/null || echo "NOT_FOUND")
    CURRENT_PR_TITLE=$(printf '%s' "$PR_VIEW_JSON" | jq -r '.title // ""' 2>/dev/null || echo "")
    if [ "$PR_STATE" != "OPEN" ]; then
        warn "PR #$PR_NUM no está abierto (estado: $PR_STATE). Saltando."
        set_status "$PR_NUM" "omitido ($PR_STATE)"
        set_branch "$PR_NUM" "(n/a)"
        continue
    fi

    # Status estructurado en vivo (issue #1601, CA-2): los PRs omitidos arriba
    # nunca llegan aqui y no crean archivo.
    CURRENT_PR_STATUS="$PR_NUM"
    CURRENT_PR_STAGE="sync"
    write_pr_status_file "$PR_NUM" "sync" "running"

    # Obtener rama del PR
    BRANCH_NAME=$(gh pr view "$PR_NUM" --json headRefName -q '.headRefName')
    log "Rama: $BRANCH_NAME"
    set_branch "$PR_NUM" "$BRANCH_NAME"

    # Actualizar referencias remotas
    log "Actualizando referencias remotas..."
    if ! git fetch origin main >>"$LOG_FILE_ABS" 2>&1; then
        fail_pr "$PR_NUM" "No se pudo hacer fetch de origin/main"
        continue
    fi
    if ! git fetch origin "$BRANCH_NAME" >>"$LOG_FILE_ABS" 2>&1; then
        fail_pr "$PR_NUM" "No se pudo hacer fetch de origin/$BRANCH_NAME"
        continue
    fi

    # Calcular si la rama está detrás de main
    BEHIND=$(git rev-list "origin/$BRANCH_NAME..origin/main" --count)

    if [ "$BEHIND" -eq 0 ]; then
        success "PR #$PR_NUM ya está al día con main. Nada que hacer."
        set_status "$PR_NUM" "al día"

        if [ "$DO_MERGE" = true ]; then
            log "Mergeando PR #$PR_NUM a main..."
            CURRENT_PR_STAGE="merge"
            write_pr_status_file "$PR_NUM" "merge" "running"
            if merge_pr_with_retry "$PR_NUM"; then
                success "PR #$PR_NUM mergeado a main"
                set_status "$PR_NUM" "mergeado"
                write_pr_status_file "$PR_NUM" "merge" "completed"
                desbloquear_issues_dependientes "$PR_NUM" || warn "Post-merge: fallo al desbloquear issues dependientes del PR #$PR_NUM (el merge sí se completó; revisar labels 'bloqueado' manualmente)"
                git fetch origin main >>"$LOG_FILE_ABS" 2>&1 || true
            else
                fail_pr "$PR_NUM" "No se pudo mergear después de reintentos"
            fi
        else
            write_pr_status_file "$PR_NUM" "sync" "completed"
        fi
        continue
    fi

    log "main tiene $BEHIND commit(s) nuevos respecto a la rama."

    # Crear worktree temporal (realpath evita el symlink /tmp→/private/tmp en macOS
    # que confunde a dotnet con rutas duplicadas para el mismo proyecto)
    TEMP_WORKTREE="$(realpath /tmp)/pr-sync-${PR_NUM}-$(date +%s)"
    CURRENT_WORKTREE="$TEMP_WORKTREE"

    log "Creando worktree temporal en $TEMP_WORKTREE..."
    if ! git worktree add "$TEMP_WORKTREE" --detach "origin/$BRANCH_NAME" >>"$LOG_FILE_ABS" 2>&1; then
        fail_pr "$PR_NUM" "No se pudo crear el worktree temporal"
        continue
    fi

    # Establecer rama local con el nombre correcto
    if ! git -C "$TEMP_WORKTREE" checkout -B "$BRANCH_NAME" "origin/$BRANCH_NAME" >>"$LOG_FILE_ABS" 2>&1; then
        fail_pr "$PR_NUM" "No se pudo hacer checkout de la rama $BRANCH_NAME"
        continue
    fi

    # Merge de main
    log "Haciendo merge de origin/main..."
    if git -C "$TEMP_WORKTREE" merge origin/main --no-edit >>"$LOG_FILE_ABS" 2>&1; then
        success "Merge automático exitoso"
    else
        warn "Merge con conflictos. Invocando implementer para resolverlos..."

        CONFLICT_FILES=$(git -C "$TEMP_WORKTREE" diff --name-only --diff-filter=U)
        log "Archivos en conflicto: $CONFLICT_FILES"

        MERGE_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Hay conflictos de merge con la rama main en los siguientes archivos:
$CONFLICT_FILES

Resuelve los conflictos manteniendo tanto la funcionalidad nueva (de esta rama) como la existente (de main).
Después de resolver cada archivo, haz git add del archivo.
Cuando todos estén resueltos, haz git commit para completar el merge.
NO elimines código de ninguna de las dos ramas — integra ambos cambios."

        CURRENT_PR_STAGE="merge-pr${PR_NUM}"
        write_pr_status_file "$PR_NUM" "$CURRENT_PR_STAGE" "running"
        if ! run_agent "merge-pr${PR_NUM}" "implementer" "$MERGE_PROMPT" "$TEMP_WORKTREE"; then
            fail_pr "$PR_NUM" "El agente implementer falló al resolver conflictos"
            continue
        fi

        REMAINING=$(git -C "$TEMP_WORKTREE" diff --name-only --diff-filter=U 2>/dev/null || true)
        if [ -n "$REMAINING" ]; then
            fail_pr "$PR_NUM" "Aún quedan conflictos después del agente: $REMAINING"
            continue
        fi
        success "Conflictos resueltos"
    fi

    # Verificar tests post-merge (P3: validación robusta)
    log "Verificando tests después del merge..."
    TEST_EXIT=0
    TEST_OUTPUT=$(validate_tests "$TEMP_WORKTREE") || TEST_EXIT=$?

    # Reintentar si falla: solo para código 1 (tests fallidos)
    if [ "${TEST_EXIT:-0}" -eq 2 ]; then
        fail_pr "$PR_NUM" "Error de compilación post-merge"
        continue
    elif [ "${TEST_EXIT:-0}" -eq 3 ]; then
        fail_pr "$PR_NUM" "No se ejecutaron tests (posible fallo silencioso)"
        continue
    elif [ "${TEST_EXIT:-0}" -eq 1 ]; then
        warn "Tests fallan post-merge. Invocando implementer para arreglar..."

        FAILED_TESTS=$(echo "$TEST_OUTPUT" | grep -E "Failed|Con error" | head -10)
        FIX_PROMPT="Estás en el directorio raíz del proyecto ${HARNESS_PROJECT_NAME}.

Después de hacer merge con main, los siguientes tests fallan:
$FAILED_TESTS

Arregla el código en src/ para que todos los tests pasen.
NO modifiques los tests.
Cuando termines, haz commit de los cambios."

        CURRENT_PR_STAGE="fix-pr${PR_NUM}"
        write_pr_status_file "$PR_NUM" "$CURRENT_PR_STAGE" "running"
        if ! run_agent "fix-pr${PR_NUM}" "implementer" "$FIX_PROMPT" "$TEMP_WORKTREE"; then
            fail_pr "$PR_NUM" "El agente implementer falló al arreglar tests"
            continue
        fi

        TEST_EXIT2=0
        TEST_OUTPUT2=$(validate_tests "$TEMP_WORKTREE") || TEST_EXIT2=$?

        if [ "${TEST_EXIT2:-0}" -ne 0 ]; then
            fail_pr "$PR_NUM" "Tests siguen fallando después del segundo intento"
            continue
        fi
    fi

    success "Todos los tests pasan"

    # Push de la rama actualizada
    log "Haciendo push de la rama actualizada..."
    if ! git -C "$TEMP_WORKTREE" push origin "$BRANCH_NAME" --force-with-lease >>"$LOG_FILE_ABS" 2>&1; then
        fail_pr "$PR_NUM" "No se pudo hacer push de $BRANCH_NAME"
        continue
    fi
    success "Rama $BRANCH_NAME actualizada en origin"

    # Limpiar worktree temporal
    git worktree remove --force "$TEMP_WORKTREE" >>"$LOG_FILE_ABS" 2>&1 || true
    git branch -D "$BRANCH_NAME" >>"$LOG_FILE_ABS" 2>&1 || true
    CURRENT_WORKTREE=""
    success "Worktree temporal limpiado"

    set_status "$PR_NUM" "sincronizado"

    # Merge a main (si se pidió) — con retry (P2)
    if [ "$DO_MERGE" = true ]; then
        log "Mergeando PR #$PR_NUM a main..."
        CURRENT_PR_STAGE="merge"
        write_pr_status_file "$PR_NUM" "merge" "running"
        if merge_pr_with_retry "$PR_NUM"; then
            success "PR #$PR_NUM mergeado a main"
            set_status "$PR_NUM" "mergeado"
            write_pr_status_file "$PR_NUM" "merge" "completed"
            desbloquear_issues_dependientes "$PR_NUM" || warn "Post-merge: fallo al desbloquear issues dependientes del PR #$PR_NUM (el merge sí se completó; revisar labels 'bloqueado' manualmente)"
            git fetch origin main >>"$LOG_FILE_ABS" 2>&1 || true
        else
            fail_pr "$PR_NUM" "No se pudo mergear después de reintentos"
        fi
    else
        write_pr_status_file "$PR_NUM" "sync" "completed"
    fi
done

# ─── Resumen final (P6: siempre se muestra) ──────────────────────────────────
header "Resumen"
echo -e ""
printf "${BOLD}%-8s %-50s %-15s${NC}\n" "PR" "Rama" "Estado"
printf "%s\n" "─────────────────────────────────────────────────────────────────────────────"

for PR_NUM in "${PR_NUMS[@]}"; do
    BRANCH=$(get_branch "$PR_NUM")
    STATUS=$(get_status "$PR_NUM")
    if [ "$STATUS" = "mergeado" ]; then
        COLOR="$GREEN"
    elif [ "$STATUS" = "sincronizado" ] || [ "$STATUS" = "al día" ]; then
        COLOR="$BLUE"
    else
        COLOR="$YELLOW"
    fi
    printf "${COLOR}%-8s %-50s %-15s${NC}\n" "#$PR_NUM" "$BRANCH" "$STATUS"
done

echo ""
# Limpieza de worktrees abandonados: una vez, si algun merge del lote salio bien.
# Su fallo nunca cambia el exit code de pr-sync.
ANY_MERGED=false
for PR_NUM in "${PR_NUMS[@]}"; do
    [ "$(get_status "$PR_NUM")" = "mergeado" ] && ANY_MERGED=true
done
if [ "$ANY_MERGED" = true ]; then
    log "Limpiando worktrees mergeados o abandonados..."
    "$SCRIPT_DIR/worktree-clean.sh" >>"$LOG_FILE_ABS" 2>&1 \
        || warn "worktree-clean.sh fallo; la limpieza de worktrees quedo pendiente (ver $LOG_FILE_ABS)"
fi

if [ "$HAVE_ERRORS" = true ]; then
    warn "Algunos PRs tuvieron errores. Revisa el log: $LOG_FILE_ABS"
    exit 1
else
    success "pr-sync completado. Log: $LOG_FILE_ABS"
fi
