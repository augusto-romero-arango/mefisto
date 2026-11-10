#!/usr/bin/env bash
# scaffold-pipeline.sh - Pipeline standalone para crear un nuevo dominio
#
# Uso:
#   ./scripts/scaffold-pipeline.sh 42                          # issue (extrae dominio del body)
#   ./scripts/scaffold-pipeline.sh 42 --domain calculo-horas   # issue + dominio explicito
#   ./scripts/scaffold-pipeline.sh --domain calculo-horas       # sin issue (solo scaffold + PR)
#   ./scripts/scaffold-pipeline.sh --help
#   MEFISTO_HOLD_MAX_SECONDS=<s> / MEFISTO_HOLD_PROBE_SECONDS=<s> ./scripts/scaffold-pipeline.sh --domain calculo-horas  # Techo (default 21600 = 6h) y cadencia de sondeo (default 300) de la espera ante RATE_LIMIT/PROVIDER_UNAVAILABLE (issue #971, MEF-ADR-0051)
#
# Ciclo: Issue -> Worktree -> Label -> domain-scaffolder -> PR -> Cleanup

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"

# La clausura publicada conserva src/runtime junto a este script (issue #1644,
# mismo molde que iac-pipeline.sh/tooling-pipeline.sh). Solo estas dos
# librerias son contrato del pipeline; el runner carga su adaptador aparte.
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
    echo "ERROR: scripts/scaffold-pipeline.sh es del plugin publicado y solo aplica al consumidor." >&2
    echo "Estas en el repo de Mefisto, que no crea dominios de negocio." >&2
    echo "Para mejorar el plugin usa /mefisto-tooling." >&2
    exit 1
fi
unset _REPO_TOP

load_harness_config || exit 1

# --- Colores ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# --- Logging ---
REPO_ROOT="$(git rev-parse --show-toplevel)"
# Estado operativo exclusivamente bajo el root canonico que resuelve
# mefisto_state_path() (MEF-ADR-0053 seccion 4); rutas absolutas.
LOG_DIR="$(dirname "$(mefisto_state_path 'logs/.state')")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
# Sufijo de PID ademas del TIMESTAMP: dos pipelines lanzados en paralelo en el
# mismo segundo (scaffold de varios dominios a la vez, issue #234) no deben
# compartir LOG_FILE. DOMAIN_NAME aun no se conoce en este punto del script.
LOG_FILE="$LOG_DIR/scaffold-$TIMESTAMP-$$.log"
EVENTS_LOG="$(mefisto_state_path 'events.log')"
HISTORY_FILE="$(mefisto_state_path 'pipeline-history.jsonl')"
PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')

mkdir -p "$LOG_DIR"
touch "$EVENTS_LOG"

log()     { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; echo "[$(date +%H:%M:%S)] $1" >> "$LOG_FILE"; }
success() { echo -e "${GREEN}${BOLD}✓${NC} $1"; echo "OK $1" >> "$LOG_FILE"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; echo "WARN $1" >> "$LOG_FILE"; }
header()  { echo -e "\n${CYAN}${BOLD}-- $1 --${NC}"; echo "-- $1 --" >> "$LOG_FILE"; }
abort()   { echo -e "\n${RED}${BOLD}x $1${NC}" >&2; echo "ABORT $1" >> "$LOG_FILE"; exit 1; }

PIPELINE_TMP_DIR="$(mktemp -d -t mefisto-scaffold)" || abort "No se pudo crear el directorio temporal del pipeline"

# --- Cleanup on error ---
WORKTREE_PATH=""
cleanup_on_error() {
    rm -rf "$PIPELINE_TMP_DIR" 2>/dev/null || true
    if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
        warn "Error detectado. El worktree queda disponible para inspeccion: $WORKTREE_PATH"
    fi
}
trap cleanup_on_error ERR
# abort() sale con exit 1 sin disparar ERR: el directorio temporal del runner
# se limpia en cualquier salida, no solo ante error.
trap 'rm -rf "$PIPELINE_TMP_DIR" 2>/dev/null || true' EXIT

# --- Help ---
show_help() {
    cat <<EOF

${CYAN}${BOLD}scaffold-pipeline.sh${NC} - Pipeline para crear un nuevo dominio

${BOLD}Uso:${NC}
  ./scripts/scaffold-pipeline.sh 42                          Issue (extrae dominio del body)
  ./scripts/scaffold-pipeline.sh 42 --domain calculo-horas   Issue + dominio explicito
  ./scripts/scaffold-pipeline.sh --domain calculo-horas       Sin issue (solo scaffold + PR)

${BOLD}El issue debe contener en el body:${NC}
  Dominio: nombre-en-kebab

${BOLD}El script:${NC}
  1. Crea el label dom:X y lo asigna al issue
  2. Crea un worktree aislado
  3. Invoca el agente domain-scaffolder
  4. Crea un PR con "Closes #N"
  5. Limpia el worktree

EOF
}

# --- Parsear argumentos ---
ISSUE_NUM=""
DOMAIN_NAME=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            show_help
            exit 0
            ;;
        --domain)
            [ $# -lt 2 ] && abort "Falta el nombre del dominio para --domain"
            DOMAIN_NAME="$2"
            shift 2
            ;;
        --domain=*)
            DOMAIN_NAME="${1#*=}"
            shift
            ;;
        [0-9]*)
            ISSUE_NUM="$1"
            shift
            ;;
        *)
            abort "Argumento desconocido: $1. Usa --help para ver el uso."
            ;;
    esac
done

# --- Verificar dependencias ---
for cmd in gh git jq; do
    command -v "$cmd" &>/dev/null || abort "$cmd no esta instalado"
done
[ -x "${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}" ] \
    || abort "No es ejecutable el runner neutral: ${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}"
RUN_AGENT_BIN="${MEFISTO_RUN_AGENT_BIN:-$RUN_AGENT_BIN_DEFAULT}"
if ! mefisto_resolve_runtime >/dev/null; then
    abort "No se pudo resolver el runtime activo: ${MEFISTO_RUNTIME_ERROR:-motivo desconocido}"
fi
MEFISTO_RUNTIME_RESUELTO="$MEFISTO_RESOLVED_RUNTIME"
MEFISTO_RUNTIME_JSON="\"$MEFISTO_RUNTIME_RESUELTO\""
if ! runtime_cli_available "$MEFISTO_RUNTIME_RESUELTO"; then
    abort "Falta el CLI del runtime resuelto ('$MEFISTO_RUNTIME_RESUELTO')"
fi

# --- Obtener contexto del issue ---
ISSUE_TITLE=""
ISSUE_BODY=""
REPO_SLUG=""

REPO_SLUG=$(git -C "$REPO_ROOT" remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')

if [ -n "$ISSUE_NUM" ]; then
    header "Descargando issue #$ISSUE_NUM"

    ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --json number,title,body,state --repo "$REPO_SLUG" 2>>"$LOG_FILE") \
        || abort "No se pudo obtener el issue #$ISSUE_NUM"

    ISSUE_STATE=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")
    [ "$ISSUE_STATE" = "OPEN" ] || abort "El issue #$ISSUE_NUM no esta abierto (estado: $ISSUE_STATE)"

    ISSUE_TITLE=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])")
    ISSUE_BODY=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['body'])")

    log "Issue: #$ISSUE_NUM - $ISSUE_TITLE"

    # Extraer dominio del body si no fue dado explicitamente
    if [ -z "$DOMAIN_NAME" ]; then
        DOMAIN_NAME=$(echo "$ISSUE_BODY" | sed -n 's/.*[Dd]ominio:[[:space:]]*\([a-zA-Z][a-zA-Z0-9-]*\).*/\1/p' | head -1 || true)
        if [ -n "$DOMAIN_NAME" ]; then
            log "Dominio extraido del issue: $DOMAIN_NAME"
        fi
    fi
fi

# --- Validar que hay nombre de dominio ---
if [ -z "$DOMAIN_NAME" ]; then
    abort "No se pudo determinar el nombre del dominio. Usa --domain <nombre> o incluye 'Dominio: nombre' en el body del issue."
fi

# Normalizar dominio a kebab-case (acepta PascalCase, camelCase, snake_case)
DOMAIN_NAME=$(echo "$DOMAIN_NAME" \
    | sed 's/_/-/g' \
    | sed 's/\([a-z0-9]\)\([A-Z]\)/\1-\2/g' \
    | tr '[:upper:]' '[:lower:]')

# Validar formato kebab-case
if ! echo "$DOMAIN_NAME" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
    abort "El nombre del dominio no se pudo normalizar a kebab-case. Recibido: $DOMAIN_NAME"
fi

# Derivar PascalCase
PASCAL_CASE=$(echo "$DOMAIN_NAME" | awk -F'-' '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1' OFS='')

log "Dominio: $DOMAIN_NAME (PascalCase: $PASCAL_CASE)"

# Verificar que el dominio no existe ya
if [ -d "$REPO_ROOT/src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE" ]; then
    abort "El dominio ya existe: src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE"
fi

# --- Crear label dom:X ---
header "Configurando label"

gh label create "dom:$DOMAIN_NAME" --color "0E8A16" --description "Dominio $PASCAL_CASE" --force --repo "$REPO_SLUG" >>"$LOG_FILE" 2>&1 \
    || warn "No se pudo crear el label dom:$DOMAIN_NAME (puede que ya exista)"
success "Label dom:$DOMAIN_NAME listo"

if [ -n "$ISSUE_NUM" ]; then
    gh issue edit "$ISSUE_NUM" --add-label "dom:$DOMAIN_NAME" --repo "$REPO_SLUG" >>"$LOG_FILE" 2>&1 \
        || warn "No se pudo asignar el label al issue #$ISSUE_NUM"
    log "Label asignado al issue #$ISSUE_NUM"
fi

# --- Preparar worktree ---
header "Preparando worktree"

CURRENT_BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)

# El worktree se ramifica SIEMPRE desde origin/main actualizado, sea cual sea
# la rama del cwd. El guard queda solo como contexto informativo en el log.
if [ "$CURRENT_BRANCH" != "main" ] && [ "$CURRENT_BRANCH" != "master" ]; then
    warn "cwd en rama '$CURRENT_BRANCH' (no main/master): el worktree se creara igual desde origin/main"
fi

log "Actualizando origin/main..."
git -C "$REPO_ROOT" fetch origin main >>"$LOG_FILE" 2>&1 \
    || abort "No se pudo hacer fetch de origin/main"

if [ -n "$ISSUE_NUM" ]; then
    BRANCH_NAME="scaffold-issue-${ISSUE_NUM}-${DOMAIN_NAME}"
else
    BRANCH_NAME="scaffold-${DOMAIN_NAME}"
fi
WORKTREE_PATH="${REPO_ROOT}/.mefisto/pipeline/worktrees/${BRANCH_NAME}"

# Idempotencia: limpiar worktree/rama existente
if [ -d "$WORKTREE_PATH" ]; then
    warn "El worktree ya existe: $WORKTREE_PATH -- limpiando para reiniciar..."
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 || true
    git -C "$REPO_ROOT" branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
fi
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
    warn "La rama $BRANCH_NAME ya existe sin worktree -- eliminandola..."
    git -C "$REPO_ROOT" branch -D "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 || true
fi

mkdir -p "$(dirname "$WORKTREE_PATH")"
# Effort neutral por agente (issue #2500): nivel de fabrica + mapping opcional
# del consumidor, resuelto antes de crear el worktree; vacio = heredar.
CONSUMER_MODELS_FILE="$REPO_ROOT/.mefisto/models.json"
resolve_pipeline_agent_effort domain-scaffolder domain-scaffolder \
    || abort "No se pudo resolver el effort de domain-scaffolder: MEFISTO_EFFORTS_ERROR=${PIPELINE_EFFORT_ERROR:-motivo desconocido}"
SCAFFOLD_AGENT_EFFORT="$RESOLVED_PIPELINE_EFFORT"

log "Creando worktree: $WORKTREE_PATH (base: origin/main)"
git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" origin/main >>"$LOG_FILE" 2>&1 \
    || abort "No se pudo crear el worktree desde origin/main"

success "Worktree creado: $WORKTREE_PATH"

# --- Resolver modelo neutral (issue #1644) ---------------------------------
# El override publico gana por clave exacta (mapping opcional del consumidor);
# sin override el adaptador decide su default por perfil, o se hereda. Mismo
# helper que iac-pipeline.sh/tooling-pipeline.sh, sin --models (este pipeline
# nunca lo soporto tampoco del lado Claude).
_SCAFFOLD_MODEL_OUTPUT="$(mktemp)"
if ! mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "domain-scaffolder" "balanced" "" "$CONSUMER_MODELS_FILE" > "$_SCAFFOLD_MODEL_OUTPUT"; then
    rm -f "$_SCAFFOLD_MODEL_OUTPUT"
    abort "No se pudo resolver el modelo de domain-scaffolder (perfil balanced): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"
fi
SCAFFOLD_AGENT_MODEL="$(cat "$_SCAFFOLD_MODEL_OUTPUT")"; rm -f "$_SCAFFOLD_MODEL_OUTPUT"
echo "[$(date +%H:%M:%S)] MODELS: domain-scaffolder runtime=$MEFISTO_RUNTIME_RESUELTO perfil=balanced solicitado=<automatico> resuelto='${SCAFFOLD_AGENT_MODEL:-<heredado>}'" >> "$EVENTS_LOG"

# --- Invocar domain-scaffolder ---
header "Invocando domain-scaffolder (modelo: ${SCAFFOLD_AGENT_MODEL:-<heredado>})..."

SCAFFOLD_PROMPT="Crea el scaffold para el dominio '$DOMAIN_NAME'. El usuario ya confirmo la creacion -- omite la confirmacion del Paso 0 y procede directamente a crear el proyecto.

PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."
SCAFFOLD_TIMEOUT=1800

echo "[$(date +%H:%M:%S)] === SCAFFOLD: domain-scaffolder para '$DOMAIN_NAME' ===" >> "$EVENTS_LOG"

# run_scaffold_agent <prompt>
#
# Frontera neutral publicada (issue #1644, mismo molde que run_agent de
# iac-pipeline.sh/tooling-pipeline.sh): el runner (mefisto-run-agent.sh) es
# autoridad de watchdog, argv y terminal; esta funcion conserva exclusivamente
# la politica de hold/retry de MEF-ADR-0051 sobre el JSONL neutral. A
# diferencia de esos dos pipelines, aqui no hay stages: una sola invocacion.
run_scaffold_agent() {
    local prompt="$1"
    local log_base="$LOG_DIR/scaffold-agent-$TIMESTAMP-$DOMAIN_NAME-$$"
    local prompt_file="$PIPELINE_TMP_DIR/scaffold.prompt.md"
    local system_file="$PIPELINE_TMP_DIR/scaffold.system.md"
    local runner_file="$PIPELINE_TMP_DIR/scaffold.runner.log"
    printf '%s' "$prompt" > "$prompt_file"
    printf '%s\n' 'You are running in non-interactive print mode. There is no human to approve anything. Use editing tools directly; never ask for permission. Do not push or create pull requests.' > "$system_file"

    local start_ts run_exit=0 elapsed=0 failure_type="" hold_started="" hold_total=0
    local resume_session="" resume_degraded=false attempt=0

    start_ts=$(date +%s)
    while :; do
        attempt=$((attempt + 1))
        local events_file="${log_base}-attempt-${attempt}.events.jsonl"
        SCAFFOLD_LOG="${log_base}-attempt-${attempt}.log"
        local attempt_prompt="$prompt_file" attempt_resume=false
        if [ -n "$resume_session" ]; then
            attempt_resume=true
            attempt_prompt="$PIPELINE_TMP_DIR/scaffold-resume-${attempt}.prompt.md"
            printf '%s\n' "Continue the same task and complete it." > "$attempt_prompt"
        fi
        local args=(--runtime "$MEFISTO_RUNTIME_RESUELTO" --agent domain-scaffolder --cwd "$WORKTREE_PATH" --prompt-file "$attempt_prompt" --system-file "$system_file" --event-log "$events_file" --events-log "$EVENTS_LOG" --redact-observability --timeout "$SCAFFOLD_TIMEOUT")
        [ -n "$SCAFFOLD_AGENT_MODEL" ] && args+=(--model "$SCAFFOLD_AGENT_MODEL")
        [ -n "$SCAFFOLD_AGENT_EFFORT" ] && args+=(--effort "$SCAFFOLD_AGENT_EFFORT")
        [ -n "$resume_session" ] && args+=(--resume-session "$resume_session")
        if "$RUN_AGENT_BIN" "${args[@]}" >"$runner_file" 2>&1; then run_exit=0; else run_exit=$?; fi
        [ "$attempt_prompt" = "$prompt_file" ] || rm -f "$attempt_prompt"
        elapsed=$(( $(date +%s) - start_ts ))
        derive_stage_log_from_stream "$events_file" "" "$SCAFFOLD_LOG"

        if [ "$run_exit" -eq 0 ] && agent_events_completed_successfully "$events_file"; then
            failure_type=""
            break
        fi

        failure_type="$(classify_neutral_agent_failure "$run_exit" "$events_file")"
        echo "[$(date +%H:%M:%S)] FALLO domain-scaffolder: $failure_type" >> "$EVENTS_LOG"
        if ! agent_failure_is_holdable "$failure_type"; then break; fi

        [ -z "$hold_started" ] && hold_started=$(date +%s)
        local resets slept
        resets="$(agent_events_resets_at "$events_file")"
        if ! slept=$(agent_hold_wait "$EVENTS_LOG" "$failure_type" "$hold_started" "$resets"); then
            warn "domain-scaffolder: techo de espera (hold) agotado -- ultima senal: $failure_type"
            break
        fi
        hold_total=$((hold_total + slept))
        warn "domain-scaffolder: $failure_type -- en espera (hold), reintentando..."

        # Reanudacion de sesion (MEF-ADR-0051): mientras resume_degraded siga
        # en false, la siguiente sonda continua la sesion truncada via el
        # session_id del JSONL neutral en vez de reenviar el prompt entero.
        if [ "$attempt_resume" = true ] && [ ! -d "$WORKTREE_PATH/src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE" ]; then
            warn "domain-scaffolder: la sesion reanudada termino sin crear el proyecto; se degrada permanentemente a inicio limpio"
            resume_degraded=true; resume_session=""
        elif [ "$resume_degraded" = false ]; then
            resume_session="$(agent_events_session_id "$events_file")"
            if [ -z "$resume_session" ]; then
                warn "domain-scaffolder: terminal sin session_id; la sonda inicia de cero"
            elif ! runtime_supports_resume "$MEFISTO_RUNTIME_RESUELTO"; then
                warn "domain-scaffolder: runtime sin capacidad de reanudacion; la sonda inicia de cero"
                resume_session=""
            fi
        fi
    done

    if [ -n "$failure_type" ]; then
        abort "El scaffold del dominio '$DOMAIN_NAME' fallo despues de ${elapsed}s ($failure_type). Revisa: $SCAFFOLD_LOG"
    fi

    scaffold_elapsed=$((elapsed - hold_total))
}

scaffold_elapsed=0
run_scaffold_agent "$SCAFFOLD_PROMPT"

# Verificar que el proyecto fue creado
if [ ! -d "$WORKTREE_PATH/src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE" ]; then
    abort "El scaffold no creo src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE -- revisa: $SCAFFOLD_LOG"
fi

echo "[$(date +%H:%M:%S)] OK domain-scaffolder (${scaffold_elapsed}s)" >> "$EVENTS_LOG"
success "Scaffold completado en ${scaffold_elapsed}s"

# --- Commit defensivo ---

# El Paso 8 del agente (git add + commit) es no determinista por ser un LLM:
# si dejo cambios sin commitear, los commiteamos aqui para que el PR nunca
# falle con "No commits between main and ...".
# El pathspec excluye el estado propio del pipeline (PIPELINE_OWN_WRITES, mismo
# patron que tooling-pipeline.sh) y, solo como defensa ante estado legacy, el
# arbol `.claude/`. Nombrar como exclusion una hija ignorada hace que `git add`
# falle aun cuando se excluya; la raiz del arbol evita ese falso error. Va en el
# guard *y* en el add para que "la unica suciedad es estado runtime" no intente
# un commit vacio.
if [ -n "$(git -C "$WORKTREE_PATH" status --porcelain -- . "${PIPELINE_OWN_WRITES[@]}" ':!.claude/')" ]; then
    warn "El agente dejo cambios sin commitear; commiteando defensivamente."
    git -C "$WORKTREE_PATH" add -A -- . "${PIPELINE_OWN_WRITES[@]}" ':!.claude/' >>"$LOG_FILE" 2>&1 \
        || abort "Fallo el 'git add -A' del commit defensivo del scaffold"
    git -C "$WORKTREE_PATH" commit -m "scaffold($DOMAIN_NAME): nuevo dominio $PASCAL_CASE" \
        >>"$LOG_FILE" 2>&1 || abort "Fallo el commit defensivo del scaffold"
fi

# Red de seguridad final antes del push: si tras el agente + commit defensivo
# no hay ningun commit por delante de origin/main, no hay nada que pushear.
if [ -z "$(git -C "$WORKTREE_PATH" log --oneline origin/main..HEAD 2>/dev/null)" ]; then
    abort "El scaffold no genero ningun commit sobre origin/main; nada que pushear. Revisa: $SCAFFOLD_LOG"
fi

# --- Gate de integridad textual ---
# Evalua el rango ya consolidado por el agente y el commit defensivo. No corrige
# los archivos: el diagnostico identifica el generador que debe repararse.
header "Verificando integridad textual"
if ! git -C "$WORKTREE_PATH" diff --check origin/main...HEAD >>"$LOG_FILE" 2>&1; then
    abort "El scaffold contiene errores de whitespace detectados por 'git diff --check'. Corrige el output del generador sin normalizarlo automaticamente y revisa el diagnostico en: $LOG_FILE"
fi
success "Integridad textual verificada"

# --- Gate de pines OpenTelemetry ---
# El agente puede omitir su propio Paso 7 aunque termine exitosamente. Esta frontera
# determinista valida el resultado consolidado antes de publicar la rama o crear el PR.
OTEL_PIN_CANONICO="1.15.3"
FUNCTION_APP_CSPROJ="$WORKTREE_PATH/src/${HARNESS_NAMESPACE_PREFIX}.${PASCAL_CASE}/${HARNESS_NAMESPACE_PREFIX}.${PASCAL_CASE}.csproj"
DOMAIN_TESTS_CSPROJ="$WORKTREE_PATH/tests/${HARNESS_NAMESPACE_PREFIX}.${PASCAL_CASE}.Tests/${HARNESS_NAMESPACE_PREFIX}.${PASCAL_CASE}.Tests.csproj"

verificar_pin_otlp() {
    local paquete="$1"
    local version_esperada="$2"
    local archivo="$3"

    if [ ! -f "$archivo" ]; then
        echo "ERROR: paquete $paquete: se esperaba el pin $version_esperada en $archivo, pero el archivo no existe."
        return 1
    fi

    python3 - "$paquete" "$version_esperada" "$archivo" <<'PY'
import sys
import xml.etree.ElementTree as ET

paquete, version_esperada, archivo = sys.argv[1:]

try:
    raiz = ET.parse(archivo).getroot()
except ET.ParseError as error:
    print(
        f"ERROR: paquete {paquete}: se esperaba el pin {version_esperada} en {archivo}, "
        f"pero el XML no es valido: {error}."
    )
    raise SystemExit(1)

referencias = [
    elemento
    for elemento in raiz.iter()
    if elemento.tag.rsplit("}", 1)[-1] == "PackageReference"
    and elemento.get("Include") == paquete
]

if len(referencias) != 1:
    print(
        f"ERROR: paquete {paquete}: se esperaba exactamente una referencia con pin "
        f"{version_esperada} en {archivo}; se encontraron {len(referencias)}."
    )
    raise SystemExit(1)

version_real = referencias[0].get("Version")
if version_real != version_esperada:
    print(
        f"ERROR: paquete {paquete}: se esperaba el pin {version_esperada} en {archivo}; "
        f"se encontro {version_real or 'ningun valor'} como atributo Version."
    )
    raise SystemExit(1)
PY
}

header "Verificando pines OpenTelemetry"
if ! verificar_pin_otlp "OpenTelemetry.Extensions.Hosting" "$OTEL_PIN_CANONICO" "$FUNCTION_APP_CSPROJ" 2>&1 | tee -a "$LOG_FILE"; then
    abort "El pin de OpenTelemetry.Extensions.Hosting debe ser $OTEL_PIN_CANONICO en $FUNCTION_APP_CSPROJ. Corrige el scaffold sin normalizarlo automaticamente."
fi
if ! verificar_pin_otlp "OpenTelemetry.Exporter.InMemory" "$OTEL_PIN_CANONICO" "$DOMAIN_TESTS_CSPROJ" 2>&1 | tee -a "$LOG_FILE"; then
    abort "El pin de OpenTelemetry.Exporter.InMemory debe ser $OTEL_PIN_CANONICO en $DOMAIN_TESTS_CSPROJ. Corrige el scaffold sin normalizarlo automaticamente."
fi
success "Pines OpenTelemetry verificados"

# --- Push + Crear PR ---
header "Creando PR"

log "Haciendo push de la rama..."
git -C "$WORKTREE_PATH" push -u origin "$BRANCH_NAME" >>"$LOG_FILE" 2>&1 \
    || abort "No se pudo hacer push de la rama $BRANCH_NAME"

log "Verificando si ya existe un PR abierto para la rama..."
EXISTING_PR_URL=$(find_open_pr_for_branch "$BRANCH_NAME" "$REPO_SLUG")

if [ -n "$EXISTING_PR_URL" ]; then
    PR_URL="$EXISTING_PR_URL"
    success "PR existente reutilizado: $PR_URL"
else
    CLOSES_LINE=""
    if [ -n "$ISSUE_NUM" ]; then
        CLOSES_LINE="Closes #$ISSUE_NUM"
    fi

    # Listar commits en la rama
    COMMITS_LIST=$(git -C "$WORKTREE_PATH" log --oneline main..HEAD 2>/dev/null || echo "(sin commits)")

    PR_TITLE="scaffold($DOMAIN_NAME): nuevo dominio $PASCAL_CASE"
    if [ -n "$ISSUE_NUM" ]; then
        PR_TITLE="#$ISSUE_NUM scaffold($DOMAIN_NAME): nuevo dominio $PASCAL_CASE"
    fi

    log "Creando PR..."
    PR_URL=$(gh pr create \
        --title "$PR_TITLE" \
        --body "$(cat <<EOF
## Resumen

Scaffold del dominio **$PASCAL_CASE** (\`$DOMAIN_NAME\`) creado con domain-scaffolder.

### Incluye
- Function App: \`src/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE/\`
- Tests: \`tests/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE.Tests/\`
- Smoke Tests: \`tests/${HARNESS_NAMESPACE_PREFIX}.$PASCAL_CASE.SmokeTests/\`
- Terraform: storage account + function app en \`infra/environments/dev/dominio-$DOMAIN_NAME.tf\`
- GitHub Actions: \`.github/workflows/deploy-$DOMAIN_NAME.yml\` (+ workflows \`smoke-tests-dominio.yml\` y \`smoke-tests.yml\` la primera vez en el repo)
- Smoke tests: registro del dominio en \`.github/smoke-tests/$DOMAIN_NAME.json\`

## Commits

$COMMITS_LIST

$(render_warning_remnants_section "$WORKTREE_PATH")

$CLOSES_LINE
EOF
)" \
        --base main \
        --head "$BRANCH_NAME" \
        --repo "$REPO_SLUG" \
        2>>"$LOG_FILE") \
        || abort "No se pudo crear el PR"

    success "PR creado: $PR_URL"
fi

if [ -n "$ISSUE_NUM" ]; then
    gh issue comment "$ISSUE_NUM" \
        --body "Scaffold del dominio \`$DOMAIN_NAME\` completado. PR: $PR_URL" \
        --repo "$REPO_SLUG" \
        >>"$LOG_FILE" 2>&1 || warn "No se pudo comentar en el issue #$ISSUE_NUM"
fi

# Append al historial
echo "{\"pipeline\":\"scaffold\",\"runtime\":${MEFISTO_RUNTIME_JSON:-null},\"domain\":\"$DOMAIN_NAME\",\"issue\":\"${ISSUE_NUM:-}\",\"started\":\"$TIMESTAMP\",\"finished\":\"$(date +%Y-%m-%dT%H:%M:%S)\",\"state\":\"completed\",\"duration\":$scaffold_elapsed,\"pr\":\"${PR_URL:-}\",\"log\":\"$LOG_FILE\"}" \
    >> "$HISTORY_FILE"

# --- Cleanup ---
header "Cleanup"

log "Eliminando worktree..."
cd "$REPO_ROOT"
rm -rf "$PIPELINE_TMP_DIR" 2>/dev/null || true
git worktree remove --force "$WORKTREE_PATH" >>"$LOG_FILE" 2>&1 \
    || warn "No se pudo eliminar el worktree automaticamente. Eliminalo manualmente: git worktree remove --force $WORKTREE_PATH"

WORKTREE_PATH=""
success "Worktree eliminado"

# --- Resumen final ---
echo ""
echo -e "${GREEN}${BOLD}========================================${NC}"
echo -e "${GREEN}${BOLD}  Scaffold completado exitosamente${NC}"
echo -e "${GREEN}${BOLD}========================================${NC}"
echo ""
echo -e "  Dominio:  ${BOLD}$PASCAL_CASE${NC} ($DOMAIN_NAME)"
[ -n "$ISSUE_NUM" ] && echo -e "  Issue:    ${BOLD}#$ISSUE_NUM${NC}"
echo -e "  PR:       ${BOLD}$PR_URL${NC}"
echo -e "  Duracion: ${BOLD}${scaffold_elapsed}s${NC}"
echo -e "  Log:      $LOG_FILE"
echo ""
echo -e "${YELLOW}Proximos pasos:${NC}"
echo -e "  1. Configura los secrets OIDC de Azure en GitHub con ${BOLD}setup-github-ci.sh${NC} si no existen"
echo -e "     (${BOLD}AZURE_CLIENT_ID${NC}, ${BOLD}AZURE_TENANT_ID${NC}, ${BOLD}AZURE_SUBSCRIPTION_ID${NC}; sin AZURE_CREDENTIALS, ver MEF-ADR-0022):"
echo -e "     CI los necesita para aplicar la infraestructura al mergear."
echo -e "  2. Revisar y mergear el PR: al mergear a ${BOLD}main${NC}, CI aplica la infraestructura"
echo -e "     (${BOLD}terraform apply${NC}, workflow Infra CD) y despliega el codigo. No ejecutes"
echo -e "     ${BOLD}terraform apply${NC} en local (MEF-ADR-0021, MEF-ADR-0022)."
echo -e "  3. Crear issues de implementacion y usar ${BOLD}/implement${NC}"
echo ""
