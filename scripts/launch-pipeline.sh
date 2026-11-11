#!/usr/bin/env bash
# launch-pipeline.sh --- Despachador de los pipelines publicados
#
# Uso:
#   ./scripts/launch-pipeline.sh 42                        # issue unico (enruta por label)
#   ./scripts/launch-pipeline.sh --pipeline tooling 42     # forzar pipeline tooling
#   ./scripts/launch-pipeline.sh --batch 42 43 44          # secuencial (enruta por label)
#   ./scripts/launch-pipeline.sh --parallel 42 43 44       # paralelo (enruta por label)
#   ./scripts/launch-pipeline.sh --parallel 42 43 --max-parallel 2
#   ./scripts/launch-pipeline.sh 42 --from-stage 3         # retomar issue #42 desde Stage 3
#
# Enrutamiento automatico: sin --pipeline, cada issue se enruta segun su label tipo:*
#
# Dos modos de UI (MEFISTO_UI): 'mod', desacoplado y default (el sub-pipeline
# corre con nohup; lo sigue la consola fausto-blood-pact o stream-watch.sh), y
# 'herdr', que delega en herdr-pipeline.sh (un pane por corrida).
# Los scripts subyacentes (tdd-pipeline.sh, batch-pipeline.sh, parallel-pipeline.sh)
# no se modifican y siguen funcionando independientemente.

set -euo pipefail

# --- Funciones compartidas ---
source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"

# La clausura publicada distribuye los adaptadores de runtime junto al pipeline
# (mismo bloque que herdr-pipeline.sh, issue #1593). Este bloque solo CARGA el
# adaptador: la resolucion (mefisto_resolve_runtime) ocurre en main(), despues
# del punto de delegacion a Herdr.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_LIB_DIR="${MEFISTO_RUNTIME_LIB_DIR:-$(cd "$SCRIPT_DIR/../src/runtime/lib" 2>/dev/null && pwd -P)}"
[ -d "$RUNTIME_LIB_DIR" ] \
    || { echo "ERROR: no se encontro src/runtime/lib junto al paquete publicado" >&2; exit 1; }
[ -f "$RUNTIME_LIB_DIR/mefisto-runtime.sh" ] \
    || { echo "ERROR: no se encontro mefisto-runtime.sh en la clausura publicada" >&2; exit 1; }
source "$RUNTIME_LIB_DIR/mefisto-runtime.sh"

# Guard defensivo: este pipeline es del lado publicado y solo aplica al consumidor.
# Si detectamos .claude-plugin/plugin.json en la raiz, estamos en el repo de Mefisto.
_REPO_TOP=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git" >&2
    exit 1
}
if [ -f "$_REPO_TOP/.claude-plugin/plugin.json" ]; then
    echo "ERROR: scripts/launch-pipeline.sh es del plugin publicado y solo aplica al consumidor." >&2
    echo "Estas en el repo de Mefisto. Para trabajar issues del plugin usa los skills internos /mefisto-tooling o /mefisto-sequential." >&2
    exit 1
fi

# --- Colores ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Runtime activo, resuelto una vez en main() y propagado a cada sub-pipeline.
RESOLVED_RUNTIME=""

# SCRIPT_DIR es la ubicacion del plugin; PROJECT_ROOT, el repo objetivo del
# consumidor (git toplevel del cwd), donde quedan los logs y el estado.
PROJECT_ROOT="$_REPO_TOP"
# Prefijo "caffeinate -i" (o vacio fuera de macOS), calculado una vez por
# corrida: evita la suspension idle del Mac mientras corre el sub-pipeline.
CAFF="$(caffeinate_prefix)"

# Ruta absoluta del sub-script dentro del plugin: el sub-pipeline corre con
# cwd en el repo del consumidor.
plugin_script() {
    echo "$SCRIPT_DIR/$(basename "$1")"
}

log()     { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
success() { echo -e "${GREEN}${BOLD}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
abort()   { echo -e "\n${RED}${BOLD}✗ $1${NC}" >&2; exit 1; }

# inside_herdr -- 0 si esta invocacion corre dentro de un pane herdr
# (HERDR_ENV=1 + HERDR_PANE_ID inyectados) con el binario en PATH.
inside_herdr() {
    [ "${HERDR_ENV:-}" = "1" ] || return 1
    [ -n "${HERDR_PANE_ID:-}" ] || return 1
    command -v herdr &>/dev/null
}

# uses_detached_ui
#
# El modo desacoplado se elige por el runtime ya resuelto (MEFISTO_RUNTIME, que
# el comando antepone siempre): con el runtime claude y sin MEFISTO_UI
# explicito, la cinta de la propia sesion (fausto-blood-pact, MEF-ADR-0055) es
# el visor y no se abre pane. MEFISTO_UI=mod tambien lo pide; MEFISTO_UI=herdr
# explicito siempre gana.
uses_detached_ui() {
    [ "${MEFISTO_UI:-}" = "mod" ] && return 0
    [ -z "${MEFISTO_UI:-}" ] && [ "${MEFISTO_RUNTIME:-}" = "claude" ] && return 0
    return 1
}

# should_delegate_to_herdr
#
# 0 si la corrida va por la interfaz herdr; 1 si va desacoplada. Aborta con un
# MEFISTO_UI que no sea 'mod' ni 'herdr', y con MEFISTO_UI=herdr fuera de herdr.
should_delegate_to_herdr() {
    case "${MEFISTO_UI:-}" in
        ""|mod|herdr) ;;
        *) abort "MEFISTO_UI='${MEFISTO_UI}' no es un modo valido. Modos validos: 'mod' (desacoplado, el default) y 'herdr' (panes, dentro de herdr)." ;;
    esac
    uses_detached_ui && return 1
    inside_herdr && return 0
    [ "${MEFISTO_UI:-}" = "herdr" ] \
        && abort "MEFISTO_UI=herdr requiere correr dentro de un pane de herdr (HERDR_ENV=1, HERDR_PANE_ID y herdr en PATH). Fuera de herdr usa MEFISTO_UI=mod (desacoplado, el default)."
    return 1
}

# launch_detached <nombre-log> <issues-csv> <script> <args...>
#
# Lanza el sub-pipeline con nohup, sin pane, y sin las variables HERDR_* (para
# que el sub-pipeline no abra panes por su cuenta). Los args viajan dentro del
# string de `bash -c`, que los re-parsea. Status y log quedan bajo el estado
# del proyecto, donde la consola fausto-blood-pact ya los sigue; <issues-csv>
# (vacio si la corrida no tiene issue) filtra el visor que se sugiere.
launch_detached() {
    local name="$1" issues_csv="$2" script="$3"
    shift 3
    # El visor y la consola leen events.log: debe existir antes de la primera linea.
    touch "$(mefisto_state_path 'events.log')"
    local logs_dir report_log
    logs_dir="$(mefisto_state_path "logs")"
    mkdir -p "$logs_dir"
    report_log="$logs_dir/$name-run-$(date +%Y%m%d-%H%M%S).report.log"

    local env_unset=(-u HERDR_ENV -u MEFISTO_UI)
    local v
    while IFS='=' read -r v _; do
        case "$v" in
            HERDR_*) env_unset+=(-u "$v") ;;
        esac
    done < <(env)

    (cd "$PROJECT_ROOT" && nohup env "${env_unset[@]}" bash -c \
        "MEFISTO_RUNTIME=$(printf '%q' "$RESOLVED_RUNTIME") $CAFF '$script' $*" \
        >"$report_log" 2>&1 </dev/null &)

    if [ "$RESOLVED_RUNTIME" = "claude" ]; then
        success "Pipeline $name iniciado (sin pane: lo sigue la consola de Fausto, fausto-blood-pact)"
    else
        success "Pipeline $name iniciado (sin pane)"
    fi
    log "Log: $report_log"
    local watch="'$SCRIPT_DIR/stream-watch.sh'"
    [ -n "$issues_csv" ] && watch="$watch --issues $issues_csv"
    log "Visor en otra terminal: $watch"
}

# --- Modo SINGLE (un issue) ---
cmd_single() {
    local issue="$1"
    local extra_args="${2:-}"
    local pipeline_override="${3:-}"

    # Resolver pipeline por label o override
    local resolved
    resolved=$(resolve_pipeline "$issue" "$pipeline_override")
    if [[ "$resolved" == SKIP:* ]]; then
        local reason="${resolved#SKIP:}"
        abort "Issue #$issue no se puede enrutar a un pipeline ($reason)."
    fi
    resolved="$(plugin_script "$resolved")"

    local pipeline_name
    pipeline_name=$(basename "$resolved" .sh)
    launch_detached "$pipeline_name-issue-$issue" "$issue" "$resolved" "$issue $extra_args"
}

# --- Modo BATCH (secuencial) ---
cmd_batch() {
    local pipeline_override=""
    local issues=()

    # Parsear --pipeline de los args
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --pipeline)
                pipeline_override="$2"
                shift 2
                ;;
            *)
                issues+=("$1")
                shift
                ;;
        esac
    done

    if [ ${#issues[@]} -eq 0 ]; then
        abort "Debes especificar al menos un issue. Uso: --batch 42 43 44"
    fi

    # Los issues viajan dentro del string de `bash -c`: solo numeros.
    local n
    for n in "${issues[@]}"; do
        [[ "$n" =~ ^[0-9]+$ ]] || abort "Issue invalido para --batch: '$n' (solo numeros)."
    done
    [[ -z "$pipeline_override" || "$pipeline_override" =~ ^[a-z-]+$ ]] || abort "Valor invalido para --pipeline: '$pipeline_override'."

    local pipeline_flag=""
    [ -n "$pipeline_override" ] && pipeline_flag="--pipeline $pipeline_override"
    local issues_csv
    issues_csv=$(IFS=','; echo "${issues[*]}")
    launch_detached "batch" "$issues_csv" "$SCRIPT_DIR/batch-pipeline.sh" "$pipeline_flag ${issues[*]}"
}

# --- Modo PARALELO ---
#
# Sin panes, parallel-pipeline.sh es el scheduler: serializa tipo:projection,
# respeta --max-parallel y escalona los arranques (issue #2448).
cmd_parallel() {
    local max_parallel=""
    local pipeline_override=""
    local issues=()

    # Parsear args
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --max-parallel)
                max_parallel="$2"
                shift 2
                ;;
            --max-parallel=*)
                max_parallel="${1#*=}"
                shift
                ;;
            --pipeline)
                pipeline_override="$2"
                shift 2
                ;;
            *)
                issues+=("$1")
                shift
                ;;
        esac
    done

    if [ ${#issues[@]} -eq 0 ]; then
        abort "Debes especificar al menos un issue. Uso: --parallel 42 43 44"
    fi

    # Issues y flags viajan dentro del string de `bash -c` (idem cmd_batch).
    local n
    for n in "${issues[@]}"; do
        [[ "$n" =~ ^[0-9]+$ ]] || abort "Issue invalido para --parallel: '$n' (solo numeros)."
    done
    [[ -z "$pipeline_override" || "$pipeline_override" =~ ^[a-z-]+$ ]] || abort "Valor invalido para --pipeline: '$pipeline_override'."
    [[ -z "$max_parallel" || "$max_parallel" =~ ^[0-9]+$ ]] || abort "Valor invalido para --max-parallel: '$max_parallel'."

    local detached_args=""
    [ -n "$pipeline_override" ] && detached_args="--pipeline $pipeline_override "
    [ -n "$max_parallel" ] && detached_args="${detached_args}--max-parallel $max_parallel "
    local issues_csv
    issues_csv=$(IFS=','; echo "${issues[*]}")
    launch_detached "parallel" "$issues_csv" "$SCRIPT_DIR/parallel-pipeline.sh" "${detached_args}${issues[*]}"
}

# --- Modo TOOLING (un issue, pipeline sin TDD) ---
#
# extra_args es lo que se propaga al sub-script ("--from-stage N", "--models
# '...'" y/o "--variant '<label>'", compuestos en main()): tooling-pipeline.sh
# los valida antes de crear el worktree.
cmd_tooling() {
    local issue="$1"
    local extra_args="${2:-}"
    launch_detached "tooling-issue-$issue" "$issue" "$SCRIPT_DIR/tooling-pipeline.sh" "$issue $extra_args"
}

# --- Modo INFRA (un issue, pipeline IaC) ---
cmd_infra() {
    local issue="$1"
    # iac-pipeline.sh acepta --from-stage (rango 1-2 validado por el sub-script).
    local extra_args="${2:-}"
    launch_detached "infra-issue-$issue" "$issue" "$SCRIPT_DIR/iac-pipeline.sh" "$issue $extra_args"
}

# --- Modo SCAFFOLD (un dominio) ---
cmd_scaffold() {
    local issue=""
    local domain=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --domain)
                domain="$2"
                shift 2
                ;;
            --domain=*)
                domain="${1#*=}"
                shift
                ;;
            [0-9]*)
                issue="$1"
                shift
                ;;
            *)
                abort "Argumento desconocido para --scaffold: $1"
                ;;
        esac
    done

    [ -n "$domain" ] || abort "Falta --domain para --scaffold. Uso: --scaffold [issue] --domain nombre"

    # Normalizar dominio a kebab-case (acepta PascalCase, camelCase, snake_case)
    domain=$(echo "$domain" \
        | sed 's/_/-/g' \
        | sed 's/\([a-z0-9]\)\([A-Z]\)/\1-\2/g' \
        | tr '[:upper:]' '[:lower:]')

    local pipeline_args=""
    [ -n "$issue" ] && pipeline_args="$issue "
    pipeline_args="${pipeline_args}--domain $domain"

    launch_detached "scaffold-$domain" "$issue" "$SCRIPT_DIR/scaffold-pipeline.sh" "$pipeline_args"
}

# --- Mostrar ayuda ---
cmd_help() {
    cat <<EOF

${CYAN}${BOLD}launch-pipeline.sh${NC} --- Despachador de los pipelines publicados

${BOLD}Uso:${NC}
  ./scripts/launch-pipeline.sh 42                                   Issue unico (enruta por label)
  ./scripts/launch-pipeline.sh 42 --from-stage 3                    Retomar issue #42 desde Stage 3
  ./scripts/launch-pipeline.sh --pipeline tooling 42                Forzar pipeline tooling
  ./scripts/launch-pipeline.sh --tooling 42                         Issue de tooling (override explicito)
  ./scripts/launch-pipeline.sh --tooling 42 --models 'reviewer=opus,writer=sonnet'  Modelo por stage (experimentos)
  ./scripts/launch-pipeline.sh 42 --models 'reviewer=opus,test-writer=sonnet'      Idem, enrutando por label a tdd-pipeline.sh
  ./scripts/launch-pipeline.sh --tooling 42 --variant experimento-a                Corrida paralela del mismo issue (sin PR, rama local)
  ./scripts/launch-pipeline.sh 42 --variant a --models 'test-writer=sonnet'       Idem, enrutando por label a tdd-pipeline.sh
  ./scripts/launch-pipeline.sh 42 --variant a                                     Dos variantes del mismo issue
  ./scripts/launch-pipeline.sh 42 --variant b                                     (lanzar ambos comandos, cada uno arranca en background)
  ./scripts/launch-pipeline.sh --infra 42                           Issue de infraestructura (IaC)
  ./scripts/launch-pipeline.sh --scaffold 42 --domain nombre        Scaffold de dominio
  ./scripts/launch-pipeline.sh --scaffold --domain nombre           Scaffold sin issue
  ./scripts/launch-pipeline.sh --batch 42 43 44                     Secuencial (enruta por label)
  ./scripts/launch-pipeline.sh --batch --pipeline tooling 42 43     Secuencial forzando tooling
  ./scripts/launch-pipeline.sh --parallel 42 43 44                  Paralelo (enruta por label)
  ./scripts/launch-pipeline.sh --parallel --pipeline tdd 42 43      Paralelo forzando tdd

${BOLD}Modos de UI (MEFISTO_UI):${NC}
  mod    Desacoplado, el default: el sub-pipeline corre en background con
         nohup, sin pane. Con el runtime claude lo sigue la consola
         fausto-blood-pact de la sesion; en cualquier caso se imprime la ruta
         del report log y la linea de stream-watch.sh para abrir el visor en
         otra terminal.
  herdr  Panes: delega en herdr-pipeline.sh. Solo dentro de un pane herdr
         (HERDR_ENV=1, HERDR_PANE_ID y herdr en PATH); fuera de herdr aborta.
  Sin MEFISTO_UI: desacoplado con el runtime claude; con otro runtime, herdr
  si la invocacion corre dentro de un pane herdr y desacoplado si no.
  Cualquier otro valor de MEFISTO_UI aborta.

${BOLD}Retomar una corrida caida (--from-stage):${NC}
  Valido en los modos de un unico issue: <issue> suelto, --tooling y --infra.
  Se rechaza (mensaje explicito, nunca silencio) en --batch, --parallel, varios
  issues sueltos --- un unico --from-stage sobre un lote seria ambiguo --- y en
  --scaffold, que no tiene stages retomables. El despachador NO valida el
  rango: lo valida el sub-script destino (tdd-pipeline.sh acepta 1-4;
  tooling-pipeline.sh e iac-pipeline.sh, 1-2), para no desincronizarse con el
  la primera vez que un pipeline sume una fase.

${BOLD}Modelo por stage (--models, experimentos A/B de desempeno):${NC}
  Valido con --tooling y con el enrutamiento automatico de un unico issue
  (sea por label o por '--pipeline tdd|tooling <issue>' -- ambos overrides de
  resolve_pipeline() resuelven siempre a tdd-pipeline.sh o tooling-pipeline.sh):
  --models 'agente=modelo[,agente=modelo...]' sobreescribe el modelo de un
  stage puntual. La clave es el nombre de agente que recibe run_agent() en el
  sub-script destino:
    tooling-pipeline.sh: 'writer' (cubre Stage 1 y la etapa de merge, ambos
      invocados con ese mismo nombre) y 'reviewer' (Stage 2).
    tdd-pipeline.sh: 'test-writer'/'projection-test-writer' (Stage 1),
      'implementer'/'projection-implementer' (Stage 2, y la etapa de merge que
      SIEMPRE usa la clave 'implementer'), 'smoke-test-writer' (Stage 2b) y
      'reviewer' (Stage 3). Los dos sub-stages de remediacion del coverage gate
      (Stage 4) no pasan por run_agent, pero honran el mismo mapa con una clave
      fina propia -- 'patch-test-writer'/'patch-implementer' -- que, si no esta
      en el mapa, cae a la del agente que realmente relanzan (el del Stage 1 y
      el del Stage 2): asi '--models test-writer=X' cubre tambien su
      remediacion, y la clave fina existe solo para diferenciarla a proposito.
      El scaffold de dominio (Stage 0, domain-scaffolder) queda fuera del mapa
      -- no es un stage TDD.
  Sin entrada en el mapa, el stage usa su default de siempre (el frontmatter
  'model:' del agente en tdd-pipeline.sh; sonnet/opus hardcodeado en
  tooling-pipeline.sh). Se rechaza (mensaje explicito, nunca silencio) en
  --infra, --scaffold, --batch y --parallel, porque sus sub-scripts no
  implementan el flag o serian ambiguos sobre varios issues. Un --models
  malformado aborta ANTES de crear el worktree. En modo herdr, esta
  invocacion delega en herdr-pipeline.sh, que reenvia --models con la misma
  superficie.

${BOLD}Corridas paralelas del mismo issue (--variant <label>):${NC}
  Valido con --tooling y con el enrutamiento automatico de un unico issue (sea
  por label o por '--pipeline tdd|tooling <issue>' -- issue #713: tdd-pipeline.sh
  y tooling-pipeline.sh ya implementan el flag). Se rechaza (mensaje explicito,
  nunca silencio) en --infra, --scaffold, --batch, --parallel y varios issues
  sueltos -- serian ambiguos sobre un lote, o el sub-script destino
  (iac-pipeline.sh/scaffold-pipeline.sh) no implementa el flag. Corre el MISMO
  issue N veces en paralelo, cada corrida en su propio worktree y rama con el
  sufijo -<label> (slug [a-z0-9-], hasta 40 caracteres): dos corridas
  simultaneas del mismo issue sin --variant colisionarian worktree y rama.
  En modo variante el pipeline NO hace push, NO abre PR y NO comenta el issue
  -- la rama queda LOCAL. Se combina con --models para comparar modelo por
  variante (una variante sin --models es la corrida de control):
    launch-pipeline.sh --tooling 42 --variant a --models 'writer=sonnet'
    launch-pipeline.sh --tooling 42 --variant b --models 'writer=opus'
    launch-pipeline.sh 42 --variant a --models 'test-writer=sonnet'    (issue TDD)
    launch-pipeline.sh 42 --variant b --models 'test-writer=opus'
  Si una variante gana la comparacion, se promueve a mano (push + gh pr create
  sobre esa rama) o relanzando el pipeline sin --variant.

${BOLD}Runtime (MEF-ADR-0049/0050):${NC}
  Los modos que lanzan un sub-pipeline (issue suelto, --tooling, --infra,
  --scaffold, --batch y --parallel) resuelven el runtime activo una sola
  vez y lo propagan al sub-pipeline como MEFISTO_RUNTIME=<resuelto>. Sin
  runtime resoluble abortan con 'No se pudo resolver el runtime activo:
  <motivo>' sin lanzar nada. Queda exento --help.

${BOLD}Enrutamiento automatico:${NC}
  Sin --pipeline ni --tooling/--infra, el pipeline se determina por el label tipo:* del issue:
    tipo:feature|refactor|projection -> tdd-pipeline.sh
    tipo:tooling                     -> tooling-pipeline.sh
    tipo:infra                       -> SKIP (usar --infra explicitamente)

  Con --parallel, el modo desacoplado delega en parallel-pipeline.sh, cuyo
  scheduler serializa los issues tipo:projection del lote (comparten los
  archivos del worker de proyecciones del BC, MEF-ADR-0034) y respeta
  --max-parallel. En modo herdr no hay scheduler entre panes: un lote con dos
  o mas tipo:projection se rechaza con mensaje explicito; para correrlos
  igual, usa /sequential o parallel-pipeline.sh directo.

EOF
}

# --- Entrypoint ---
main() {
    if [ $# -eq 0 ]; then
        cmd_help
        exit 0
    fi

    local arg
    for arg in "$@"; do
        case "$arg" in
            --help|-h) cmd_help; exit 0 ;;
        esac
    done
    for arg in "$@"; do
        case "$arg" in
            --attach|--if-exists) abort "--attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5)." ;;
        esac
    done

    if should_delegate_to_herdr; then
        exec "$SCRIPT_DIR/herdr-pipeline.sh" "$@"
    fi

    # Pre-parsear --scaffold-domain, --pipeline, --from-stage, --models y
    # --variant antes del dispatch de modo. Se sacan de filtered_args: si
    # quedaran, "253 --from-stage 4" se veria como 3 argumentos posicionales y
    # el caso [0-9]* (mas abajo) desviaria a cmd_parallel (issue #449).
    local scaffold_extra=""
    local pipeline_override=""
    local from_stage_extra=""
    local models_extra=""
    local variant_extra=""
    local filtered_args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --scaffold-domain)
                [ $# -lt 2 ] && abort "Falta el nombre del dominio para --scaffold-domain"
                scaffold_extra="--scaffold-domain $2"
                shift 2
                ;;
            --pipeline)
                [ $# -lt 2 ] && abort "Falta el valor de --pipeline"
                pipeline_override="$2"
                shift 2
                ;;
            --from-stage)
                [ $# -lt 2 ] && abort "Falta el valor de --from-stage"
                [[ "$2" =~ ^[0-9]+$ ]] || abort "--from-stage debe ser un numero entero (recibido: '$2')"
                from_stage_extra="--from-stage $2"
                shift 2
                ;;
            --models)
                # Las comillas simples protegen el valor (puede traer '[' / ']'
                # de un id de modelo completo, p. ej. claude-opus-5[1m]) de que
                # el shell de `bash -c` que lo re-parsea lo tome como un glob.
                [ $# -lt 2 ] && abort "Falta el valor de --models"
                models_extra="--models '$2'"
                shift 2
                ;;
            --variant)
                [ $# -lt 2 ] && abort "Falta el valor de --variant"
                variant_extra="--variant '$2'"
                shift 2
                ;;
            *)
                filtered_args+=("$1")
                shift
                ;;
        esac
    done
    # Guarda de bash 3.2 (macOS): "${arr[@]}" con un array vacio revienta con
    # "unbound variable" bajo `set -u`. Sin ella, invocar solo flags
    # ("--from-stage 4" sin numero de issue) moria con un error interno de bash
    # en vez de con el mensaje de uso.
    if [ ${#filtered_args[@]} -gt 0 ]; then
        set -- "${filtered_args[@]}"
    else
        abort "Faltan argumentos posicionales (numero de issue o modo). Corre '$0 --help' para ver el uso."
    fi

    # El runtime se resuelve una vez y se propaga al sub-pipeline, para que
    # no autodetecte por su cuenta un runtime distinto del que lanzo este comando.
    mefisto_resolve_runtime >/dev/null \
        || abort "No se pudo resolver el runtime activo: ${MEFISTO_RUNTIME_ERROR:-motivo desconocido}"
    RESOLVED_RUNTIME="$MEFISTO_RESOLVED_RUNTIME"

    case "$1" in
        --tooling)
            shift
            if [ $# -eq 0 ]; then
                abort "Debes especificar un issue. Uso: --tooling 42"
            fi
            # Compone from_stage_extra + models_extra + variant_extra sin arrays
            # (bash 3.2 de macOS revienta con "unbound variable" al expandir un
            # array vacio bajo `set -u`) -- mismo patron que combined_extra mas
            # abajo.
            local tooling_extra="$from_stage_extra"
            if [ -n "$models_extra" ]; then
                if [ -n "$tooling_extra" ]; then
                    tooling_extra="$tooling_extra $models_extra"
                else
                    tooling_extra="$models_extra"
                fi
            fi
            if [ -n "$variant_extra" ]; then
                if [ -n "$tooling_extra" ]; then
                    tooling_extra="$tooling_extra $variant_extra"
                else
                    tooling_extra="$variant_extra"
                fi
            fi
            cmd_tooling "$1" "$tooling_extra"
            ;;
        --infra)
            shift
            if [ $# -eq 0 ]; then
                abort "Debes especificar un issue. Uso: --infra 42"
            fi
            # iac-pipeline.sh no implementa --models ni --variant: rechazar en
            # vez de tragarselo en silencio.
            [ -n "$models_extra" ] && abort "--models todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling o un issue TDD: launch-pipeline.sh --tooling <issue> --models 'agente=modelo'"
            [ -n "$variant_extra" ] && abort "--variant todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling: launch-pipeline.sh --tooling <issue> --variant <label>"
            cmd_infra "$1" "$from_stage_extra"
            ;;
        --scaffold)
            shift
            # scaffold-pipeline.sh no tiene stages retomables ni implementa
            # --models/--variant: rechazar en vez de tragarselo en silencio.
            [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con --scaffold (scaffold-pipeline.sh no tiene stages retomables)."
            [ -n "$models_extra" ] && abort "--models no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag)."
            [ -n "$variant_extra" ] && abort "--variant no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag)."
            cmd_scaffold "$@"
            ;;
        --batch)
            shift
            if [ $# -eq 0 ]; then
                abort "Debes especificar al menos un issue. Uso: --batch 42 43 44"
            fi
            # --from-stage, --models y --variant sobre un lote de issues son
            # ambiguos: rechazar es la opcion segura.
            [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh <issue> --from-stage N"
            [ -n "$models_extra" ] && abort "--models no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh --tooling <issue> --models 'agente=modelo'"
            [ -n "$variant_extra" ] && abort "--variant no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh --tooling <issue> --variant <label>"
            if [ -n "$pipeline_override" ]; then
                cmd_batch --pipeline "$pipeline_override" "$@"
            else
                cmd_batch "$@"
            fi
            ;;
        --parallel)
            shift
            if [ $# -eq 0 ]; then
                abort "Debes especificar al menos un issue. Uso: --parallel 42 43 44"
            fi
            [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh <issue> --from-stage N"
            [ -n "$models_extra" ] && abort "--models no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh --tooling <issue> --models 'agente=modelo'"
            [ -n "$variant_extra" ] && abort "--variant no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue: launch-pipeline.sh --tooling <issue> --variant <label>"
            if [ -n "$pipeline_override" ]; then
                cmd_parallel --pipeline "$pipeline_override" "$@"
            else
                cmd_parallel "$@"
            fi
            ;;
        [0-9]*)
            if [ $# -gt 1 ]; then
                # Multiples issues sin modo especificado: idem --batch/--parallel.
                [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con multiples issues (se interpretaria como --parallel). Especifica un unico issue: launch-pipeline.sh <issue> --from-stage N"
                [ -n "$models_extra" ] && abort "--models no es valido con multiples issues (se interpretaria como --parallel). Usa: launch-pipeline.sh --tooling <issue> --models 'agente=modelo'"
                [ -n "$variant_extra" ] && abort "--variant no es valido con multiples issues (se interpretaria como --parallel). Usa: launch-pipeline.sh --tooling <issue> --variant <label>"
                warn "Multiples issues sin modo especificado. Usando --parallel."
                if [ -n "$pipeline_override" ]; then
                    cmd_parallel --pipeline "$pipeline_override" "$@"
                else
                    cmd_parallel "$@"
                fi
            else
                # El enrutamiento automatico resuelve a tdd-pipeline.sh o
                # tooling-pipeline.sh (tipo:infra retorna SKIP antes de llegar a
                # un sub-script), y ambos implementan --models y --variant.
                # Compone los extras sin arrays (bash 3.2 de macOS revienta con
                # "unbound variable" al expandir un array vacio bajo `set -u`).
                local combined_extra="$scaffold_extra"
                if [ -n "$from_stage_extra" ]; then
                    if [ -n "$combined_extra" ]; then
                        combined_extra="$combined_extra $from_stage_extra"
                    else
                        combined_extra="$from_stage_extra"
                    fi
                fi
                if [ -n "$models_extra" ]; then
                    if [ -n "$combined_extra" ]; then
                        combined_extra="$combined_extra $models_extra"
                    else
                        combined_extra="$models_extra"
                    fi
                fi
                if [ -n "$variant_extra" ]; then
                    if [ -n "$combined_extra" ]; then
                        combined_extra="$combined_extra $variant_extra"
                    else
                        combined_extra="$variant_extra"
                    fi
                fi
                cmd_single "$1" "$combined_extra" "$pipeline_override"
            fi
            ;;
        *)
            echo -e "${RED}Argumento desconocido: $1${NC}"
            cmd_help
            exit 1
            ;;
    esac
}

main "$@"
