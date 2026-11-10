#!/usr/bin/env bash
# mefisto-tmux-pipeline.sh -- Wrapper tmux para los pipelines INTERNOS de Mefisto
#
# Implementacion CANONICA (MEF-ADR-0049 decision 2, issue #871). El shim de
# compatibilidad .claude/scripts/mefisto-tmux-pipeline.sh reenvia aqui via
# `exec` (plantilla documentada en src/internal/scripts/README.md); invocar
# por cualquiera de las dos rutas es equivalente.
#
# Uso:
#   src/internal/scripts/mefisto-tmux-pipeline.sh --tooling 42
#   src/internal/scripts/mefisto-tmux-pipeline.sh --tooling 42 --verbose
#   src/internal/scripts/mefisto-tmux-pipeline.sh --tooling 42 --from-stage 2   # retomar
#   src/internal/scripts/mefisto-tmux-pipeline.sh --tooling 42 --models 'writer=<modelo>'  # experimentos, ver src/runtime/contract/models.example.json (#1072)
#   src/internal/scripts/mefisto-tmux-pipeline.sh --tooling 42 --variant experimento-a  # corrida paralela del mismo issue (sin PR, rama local)
#   src/internal/scripts/mefisto-tmux-pipeline.sh --batch 42 43 44   # secuencial
#   src/internal/scripts/mefisto-tmux-pipeline.sh --batch 42 43 44 --verbose
#   src/internal/scripts/mefisto-tmux-pipeline.sh --attach            # reconectar
#   src/internal/scripts/mefisto-tmux-pipeline.sh --attach mefisto-tooling-42
#
# --verbose (issue #435, en cualquier posicion de los argumentos) suma un
# tercer pane con el visor en vivo mefisto-stream-watch.sh (#434, #878). Es
# opt-in: sin el flag, la sesion queda byte por byte igual que siempre (dos
# paneles). El visor todavia vive en .claude/scripts/ (su porte a este layout
# canonico es un issue aparte, no #871: solo el lanzador se traslada aqui) --
# el pane invoca esa ruta explicita, y sigue siendo el mismo binario que se
# puede lanzar a mano en cualquier momento sobre una corrida en curso, con o
# sin este flag, corriendo en otra terminal:
#   ./.claude/scripts/mefisto-stream-watch.sh
#
# Caveat del arranque con --verbose: el visor descubre el *.events.jsonl mas
# reciente entre los directorios de logs que resuelve mefisto_state_read_paths
# (canonico ".mefisto/pipeline/logs/" primero, legacy despues) y el pane se
# abre ANTES de que el pipeline haya escrito el suyo (la traza del stage 1
# nace recien cuando arranca el agente, tras crear el worktree y validar el
# DoR). Hasta entonces el visor muestra la traza de la corrida ANTERIOR -- su
# encabezado dice a que issue y stage pertenece -- y salta sola a la nueva en
# cuanto empieza a crecer.
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
# de desempeno del harness, contraparte interna de tmux-pipeline.sh --tooling
# --models (issue #708, lado publicado). El wrapper NO valida el formato --eso
# lo hace parse_stage_models en mefisto-tooling-pipeline.sh, ANTES de crear el
# worktree. Los ids concretos de cada runtime no viven en este script: ver
# src/runtime/contract/models.example.json (issue #1072) para la forma que deben
# tener, o el mapping local .mefisto/models.json una vez poblado.
#
# --variant <label> (issue #711, en cualquier posicion) se propaga igual que
# --models, solo valido con --tooling: corridas paralelas del MISMO issue
# (contraparte interna de tmux-pipeline.sh --tooling --variant, issue #710,
# lado publicado). Ademas del reenvio, suma el sufijo -<label> al nombre de la
# sesion tmux -- sin el, dos variantes del mismo issue colisionarian de
# sesion. El wrapper NO valida el formato del label -- eso lo hace
# validate_variant_label en mefisto-tooling-pipeline.sh, ANTES de crear el
# worktree. --batch lo rechaza (seria ambiguo sobre varios issues).
#
# Ante una sesion tmux existente (viva por una corrida en curso, o "muerta" --
# remain-on-exit deja el pane abierto tras un crash aunque el proceso ya
# termino), ambos modos ofrecen reusar (attach), reemplazar (kill-session y
# arrancar limpio) o abortar -- ver --if-exists mas abajo.
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
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_ROOT="$MEFISTO_REPO_ROOT"
# El events.log de la corrida se resuelve con mefisto_state_path (issue #869):
# ".mefisto/pipeline/events.log" canonico, nunca una ruta compuesta a mano con
# el prefijo legacy previo a la migracion -- ese hardcodeo era el bug que
# dejaba al pane monitor tail-eando un archivo vacio toda la corrida, sin una
# sola linea y sin error visible.
EVENTS_LOG="$(mefisto_state_path "events.log")"
# CAFF: prefijo "caffeinate -i" (o vacio fuera de macOS), calculado UNA vez
# por corrida y antepuesto al send-keys que lanza cada sub-pipeline interno --
# issue #800. Evita que el Mac entre en suspension idle durante la corrida.
CAFF="$(caffeinate_prefix)"

# ENV_PREFIX: asignaciones de entorno "VAR=valor " que el pane de ejecucion
# necesita heredar del proceso que arranca la sesion tmux (issue #871, CA-2):
# el pane nace en un shell nuevo que NO hereda el entorno del wrapper.
# MEFISTO_RUNTIME selecciona el runtime activo (issue #867, resuelto rio abajo
# por mefisto-tooling-pipeline.sh/mefisto-batch-pipeline.sh) y
# MEFISTO_MODELS_FILE apunta al mapping de modelos cuando el caller ya lo fijo
# (tests, o un mapping fuera del default ".mefisto/models.json"). Solo se
# agregan si estan fijadas -- un valor vacio en el pane cambiaria el
# comportamiento (autodeteccion) respecto de no fijarlo. printf %q escapa el
# valor como DATO, nunca se re-emite tal cual (CA-4: sobrevive un id de
# runtime u orden con espacios/comillas).
ENV_PREFIX=""
[ -n "${MEFISTO_RUNTIME:-}" ] && ENV_PREFIX="${ENV_PREFIX}MEFISTO_RUNTIME=$(printf '%q' "$MEFISTO_RUNTIME") "
[ -n "${MEFISTO_MODELS_FILE:-}" ] && ENV_PREFIX="${ENV_PREFIX}MEFISTO_MODELS_FILE=$(printf '%q' "$MEFISTO_MODELS_FILE") "

# El pane re-parsea con un shell el string que le llega por send-keys, asi que
# la ruta de los sub-pipelines viaja escapada con printf %q, no cruda (CA-4).
# Hasta el traslado a src/internal/scripts/ (issue #871) era la literal
# relativa "./.claude/scripts/...", inmune a espacios por construccion; ahora
# se deriva de SCRIPT_DIR, y un checkout bajo un directorio con espacios --
# "~/Mis Repos/mefisto" -- partiria el comando en dos argumentos y el pane
# moriria con "command not found", sin que nada mas lo advierta.
TOOLING_SCRIPT_Q="$(printf '%q' "$SCRIPT_DIR/mefisto-tooling-pipeline.sh")"
BATCH_SCRIPT_Q="$(printf '%q' "$SCRIPT_DIR/mefisto-batch-pipeline.sh")"

log()     { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
success() { echo -e "${GREEN}${BOLD}v${NC} $1"; }
warn()    { echo -e "${YELLOW}!${NC} $1"; }
abort()   { echo -e "\n${RED}${BOLD}x $1${NC}" >&2; exit 1; }

check_tmux() {
    command -v tmux &>/dev/null || abort "tmux no esta instalado. Instala con: brew install tmux"
}

ensure_events_log() {
    mkdir -p "$(dirname "$EVENTS_LOG")"
    touch "$EVENTS_LOG"
}

safe_session_name() { echo "$1" | tr ' /:' '-' | tr -cd 'a-zA-Z0-9-'; }
session_exists()    { tmux has-session -t "$1" 2>/dev/null; }
inside_tmux()       { [ -n "${TMUX:-}" ]; }

# should_delegate_to_herdr <args...>
#
# 0 si esta invocacion debe correr por la interfaz herdr (porte interno del
# issue #690): estamos dentro de un pane herdr (HERDR_ENV=1 + HERDR_PANE_ID
# inyectado), el binario esta en PATH, y el modo pedido tiene equivalente
# herdr -- --attach y --help son tmux-especificos. MEFISTO_UI=tmux es el
# escape hatch para forzar tmux desde dentro de herdr.
should_delegate_to_herdr() {
    [ "${MEFISTO_UI:-}" = "tmux" ] && return 1
    [ "${HERDR_ENV:-}" = "1" ] || return 1
    [ -n "${HERDR_PANE_ID:-}" ] || return 1
    command -v herdr &>/dev/null || return 1
    local a
    for a in "$@"; do
        case "$a" in
            --attach|--help|-h) return 1 ;;
        esac
    done
    return 0
}

# Extrae --verbose, --from-stage N e --if-exists X de "$@" (en cualquier
# posicion) y los consume: ninguno debe propagarse posicionalmente al
# pipeline invocado por send-keys (CA-2 de #435, extendido por #449) --
# critico en cmd_batch, que parsea issues_str posicionalmente. Un segundo
# while/case en paralelo sobre "$@" crudo repetiria ese riesgo por cada flag
# nuevo; de ahi que --from-stage e --if-exists se sumen a ESTE unico pre-parseo
# en vez de abrir el suyo.
#
# Deja: VERBOSE (booleano `true`/`false`, la convencion del resto de los
# pipelines), FROM_STAGE_EXTRA ("--from-stage N" listo para el send-keys, o
# vacio), MODELS_EXTRA ("--models 'agente=modelo[,...]'" listo para el
# send-keys, o vacio -- issue #709), SESSION_IF_EXISTS (reuse|replace|abort, o
# vacio) y el resto de argumentos, en orden, en el array global REMAINING_ARGS.
#
# --from-stage, --models e --if-exists consumen DOS posiciones (el flag y su
# valor), a diferencia de --verbose -- por eso el for-in simple del helper
# original se vuelve un while indexado, que si puede "mirar hacia adelante".
#
# Se llamaba extract_verbose_flag cuando #435 lo introdujo; #449 lo renombro al
# sumarle dos flags mas, para que el nombre no mienta sobre lo que consume.
VERBOSE=false
REMAINING_ARGS=()
FROM_STAGE_EXTRA=""
MODELS_EXTRA=""
VARIANT_EXTRA=""
VARIANT_LABEL_RAW=""
SESSION_IF_EXISTS=""
extract_wrapper_flags() {
    VERBOSE=false
    REMAINING_ARGS=()
    FROM_STAGE_EXTRA=""
    MODELS_EXTRA=""
    VARIANT_EXTRA=""
    VARIANT_LABEL_RAW=""
    SESSION_IF_EXISTS=""
    local -a args=("$@")
    local i=0
    while [ "$i" -lt "${#args[@]}" ]; do
        case "${args[$i]}" in
            --verbose)
                VERBOSE=true
                ;;
            --from-stage)
                i=$((i + 1))
                local value="${args[$i]:-}"
                [ -n "$value" ] || abort "Falta el valor de --from-stage"
                [[ "$value" =~ ^[0-9]+$ ]] || abort "--from-stage debe ser un numero entero (recibido: '$value')"
                FROM_STAGE_EXTRA="--from-stage $value"
                ;;
            --models)
                # Sin pre-parsear aqui, --models caeria en REMAINING_ARGS y
                # cmd_tooling/cmd_batch lo interpretarian posicionalmente (issue
                # #709, mismo defecto que motivo el pre-parseo de --from-stage).
                # Comillas simples: el valor puede traer '[' / ']' de un id de
                # modelo completo con corchetes (formato habitual de version
                # de modelo) que el shell del send-keys de tmux tomaria como
                # glob sin ellas.
                i=$((i + 1))
                local models_value="${args[$i]:-}"
                [ -n "$models_value" ] || abort "Falta el valor de --models"
                MODELS_EXTRA="--models '$models_value'"
                ;;
            --variant)
                # Mismo criterio que --models: sin pre-parsear aqui, --variant
                # caeria en REMAINING_ARGS y cmd_tooling lo interpretaria
                # posicionalmente (issue #711). Comillas simples por el mismo
                # motivo que --models -- send-keys re-parsea con un shell.
                i=$((i + 1))
                local variant_value="${args[$i]:-}"
                [ -n "$variant_value" ] || abort "Falta el valor de --variant"
                VARIANT_EXTRA="--variant '$variant_value'"
                VARIANT_LABEL_RAW="$variant_value"
                ;;
            --if-exists)
                i=$((i + 1))
                local exists_value="${args[$i]:-}"
                [ -n "$exists_value" ] || abort "Falta el valor de --if-exists (reuse|replace|abort)"
                case "$exists_value" in
                    reuse|replace|abort) SESSION_IF_EXISTS="$exists_value" ;;
                    *) abort "--if-exists debe ser reuse, replace o abort (recibido: '$exists_value')" ;;
                esac
                ;;
            *)
                REMAINING_ARGS+=("${args[$i]}")
                ;;
        esac
        i=$((i + 1))
    done
}

# Ayuda del wrapper (CA-6). Es la misma que ya se imprimia al invocar sin
# argumentos, extraida a una funcion para que --help/-h la muestre en vez de
# caer en "Argumento no reconocido" (mismo patron que cmd_help del wrapper
# publicado, scripts/tmux-pipeline.sh).
print_usage() {
    echo "Uso: $0 --tooling <issue> [--verbose] [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>] [--if-exists reuse|replace|abort]"
    echo "     $0 --batch <issue1> <issue2> ... [--verbose] [--if-exists reuse|replace|abort]"
    echo "     $0 --attach [sesion]"
    echo ""
    echo "  --verbose   Suma un pane con el visor en vivo (mefisto-stream-watch.sh,"
    echo "              issue #434). Opt-in: sin el flag la sesion no cambia."
    echo "              Al abrirse muestra la traza de la corrida ANTERIOR (con su"
    echo "              encabezado de issue/stage) hasta que la nueva empieza a"
    echo "              escribirse, y salta sola a ella."
    echo "              Para lanzamientos unitarios lo reenvia el skill interno"
    echo "              /mefisto-tooling-verbose <issue> (issue #533), que delega"
    echo "              en /mefisto-tooling y solo suma este flag. /mefisto-tooling"
    echo "              y /mefisto-sequential NO lo reenvian: para un lote hay que"
    echo "              invocar el script a mano (no hay variante verbose de lote"
    echo "              a proposito -- el visor salta solo al stream mas reciente)."
    echo "              El visor tambien se puede lanzar suelto, en cualquier"
    echo "              momento y sin este flag, sobre una corrida ya en curso:"
    echo "                ./.claude/scripts/mefisto-stream-watch.sh"
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
    echo "                  Corre el MISMO issue en un worktree/rama/sesion propios"
    echo "                  (sufijo -<label>), sin push, sin PR y sin mutar el"
    echo "                  issue -- la rama queda local, para comparar contra otra"
    echo "                  variante. Se combina con --models para comparar modelo"
    echo "                  por variante (una variante sin --models es la corrida"
    echo "                  de control). Solo valido con --tooling; --batch lo"
    echo "                  rechaza (seria ambiguo sobre varios issues). Un label"
    echo "                  invalido aborta ANTES de crear el worktree."
    echo ""
    echo "  --if-exists reuse|replace|abort  (issue #449) Decide que hacer si ya"
    echo "                  existe una sesion con ese nombre, sin preguntar (util"
    echo "                  sin terminal interactiva). Sin este flag y con TTY se"
    echo "                  pregunta; sin TTY el default es seguro: reusar si la"
    echo "                  sesion sigue viva, reemplazar si ya esta terminada"
    echo "                  (remain-on-exit la deja abierta tras un crash)."
}

print_connect_hint() {
    local session="$1"
    echo ""
    echo -e "${CYAN}${BOLD}Sesion tmux lista: $session${NC}"
    echo ""
    echo -e "  ${BOLD}En iTerm2 (recomendado):${NC}"
    echo -e "    tmux -CC attach -t $session"
    echo ""
    echo -e "  ${BOLD}En terminal estandar:${NC}"
    echo -e "    tmux attach -t $session"
    echo ""
}

# session_is_alive <session>
#
# Retorna 0 (verdadero) si al menos un pane de la sesion sigue con su proceso
# vivo. Retorna 1 (falso) si TODOS los panes estan "dead" -- remain-on-exit
# los mantiene abiertos tras terminar, asi que un pane muerto no es una
# corrida en curso. Si no se puede consultar tmux se asume viva (conservador).
session_is_alive() {
    local session="$1"
    local dead_flags
    dead_flags=$(tmux list-panes -s -t "$session" -F '#{pane_dead}' 2>/dev/null)
    [ -n "$dead_flags" ] || return 0
    echo "$dead_flags" | grep -q '^0$'
}

# prompt_session_conflict <session> <alive:true|false>
#
# Pregunta interactivamente que hacer ante una sesion existente. El default
# (Enter sin escribir nada) depende de si la sesion esta viva o muerta: reusar
# (attach) si esta viva, reemplazar si esta muerta. Solo se llama con
# stdin/stdout en TTY.
prompt_session_conflict() {
    local session="$1" alive="$2"
    local default_action="replace" default_label="reemplazar"
    local estado="terminada"
    if [ "$alive" = true ]; then
        default_action="reuse"
        default_label="reusar (attach)"
        estado="activa"
    fi
    echo "" >&2
    warn "Ya existe una sesion '$session' ($estado)." >&2
    echo -e "  ${BOLD}[r]${NC}eusar   -- attach a la sesion existente" >&2
    echo -e "  ${BOLD}[e]${NC}liminar -- kill-session y arrancar limpio" >&2
    echo -e "  ${BOLD}[a]${NC}bortar" >&2
    # `|| true`: sin el, un EOF (Ctrl+D) hace fallar a read y, bajo `set -e`,
    # mata el subshell de la sustitucion de comandos -- el script moriria sin
    # mensaje. Con el, un EOF cae en el default igual que un Enter vacio.
    local answer=""
    read -r -p "Elegi una opcion [r/e/a] (Enter = $default_label): " answer || true
    case "$answer" in
        r|R) echo "reuse" ;;
        e|E) echo "replace" ;;
        a|A) echo "abort" ;;
        *)   echo "$default_action" ;;
    esac
}

# handle_session_conflict <session>
#
# Si la sesion NO existe, no hace nada (retorna 0: el llamador crea una
# nueva). Si existe, resuelve la accion (reuse/replace/abort) por flag
# explicito (--if-exists, global SESSION_IF_EXISTS), por prompt interactivo
# (default segun liveness), o por el default seguro sin TTY (nunca destruir
# una corrida viva). Solo retorna (0) cuando el llamador debe proceder a
# crear la sesion.
handle_session_conflict() {
    local session="$1"
    session_exists "$session" || return 0

    local alive=false
    session_is_alive "$session" && alive=true

    local action="$SESSION_IF_EXISTS"
    if [ -z "$action" ]; then
        if [ -t 0 ] && [ -t 1 ]; then
            action=$(prompt_session_conflict "$session" "$alive")
        elif [ "$alive" = true ]; then
            action="reuse"
        else
            action="replace"
        fi
    fi

    case "$action" in
        reuse)
            if [ -t 1 ]; then
                # Ya dentro de tmux, `attach` falla ("sessions should be nested
                # with care, unset $TMUX to force"): switch-client es el comando
                # que mueve el cliente actual a otra sesion (man tmux,
                # switch-client).
                if inside_tmux; then
                    log "Reusando la sesion '$session' (switch-client)..."
                    exec tmux switch-client -t "$session"
                fi
                log "Reusando la sesion '$session' (attach)..."
                exec tmux attach -t "$session"
            fi
            warn "Ya existe una sesion '$session'."
            print_connect_hint "$session"
            exit 0
            ;;
        replace)
            log "Sesion '$session' se reemplaza ($([ "$alive" = true ] && echo "estaba activa" || echo "estaba terminada"))..."
            tmux kill-session -t "$session" 2>/dev/null || true
            return 0
            ;;
        abort)
            abort "Sesion '$session' ya existe. Usa --if-exists reuse (attach), --if-exists replace (recrear), o gestionala a mano: tmux attach -t $session / tmux kill-session -t $session"
            ;;
        *)
            abort "Valor invalido para --if-exists: '$action' (valores validos: reuse, replace, abort)"
            ;;
    esac
}

cmd_attach() {
    local target="${1:-}"
    check_tmux
    if [ -n "$target" ]; then
        if ! session_exists "$target"; then
            echo -e "${YELLOW}Sesion '$target' no existe. Sesiones disponibles:${NC}"
            tmux ls 2>/dev/null || echo "  (ninguna)"
            exit 1
        fi
        exec tmux attach -t "$target"
    else
        tmux ls &>/dev/null || abort "No hay sesiones tmux activas."
        exec tmux attach
    fi
}

cmd_tooling() {
    extract_wrapper_flags "$@"
    # Guarda de bash 3.2 (macOS): "${arr[@]}" con un array vacio revienta con
    # "unbound variable" bajo `set -u` -- de ahi el chequeo de longitud previo
    # en vez de expandir REMAINING_ARGS directo cuando podria estar vacio.
    if [ ${#REMAINING_ARGS[@]} -gt 0 ]; then
        set -- "${REMAINING_ARGS[@]}"
    else
        set --
    fi
    [ $# -lt 1 ] && abort "Falta el numero de issue. Uso: --tooling <issue> [--verbose] [--from-stage N]"
    local issue="$1"
    local session
    session=$(safe_session_name "mefisto-tooling-$issue")
    # Modo variante (CA-2): la sesion tmux tambien lleva el sufijo -<label>,
    # para que dos variantes del mismo issue no colisionen de sesion.
    [ -n "$VARIANT_LABEL_RAW" ] && session=$(safe_session_name "mefisto-tooling-$issue-$VARIANT_LABEL_RAW")

    check_tmux
    ensure_events_log
    handle_session_conflict "$session"

    log "Creando sesion tmux '$session' para mefisto-tooling issue #$issue..."

    # Captura el pane_id del shell creado por new-session (formato %N).
    # Usar pane_id en vez de "$session:main.X" evita depender de pane-base-index,
    # que en muchas configuraciones (incluida la de macOS por defecto al usar
    # iTerm2) es 1 en vez de 0 y rompe la indexacion implicita.
    local tail_pane script_pane watch_pane
    tmux new-session -d -s "$session" -n "main" -c "$PROJECT_ROOT"
    tail_pane=$(tmux list-panes -t "$session:main" -F '#{pane_id}' | head -n1)
    tmux set-option -t "$session" remain-on-exit on
    tmux send-keys -t "$tail_pane" "tail -f '$EVENTS_LOG'" Enter

    # El split -v (issue #435) se hace ANTES del -h, mientras tail_pane todavia
    # ocupa toda la ventana: asi el visor queda a lo ancho completo (abajo),
    # y tail_pane conserva el ancho completo para partirse en tail/script (arriba).
    if [ "$VERBOSE" = true ]; then
        watch_pane=$(tmux split-window -v -t "$tail_pane" -c "$PROJECT_ROOT" -P -F '#{pane_id}')
        tmux send-keys -t "$watch_pane" "./.claude/scripts/mefisto-stream-watch.sh" Enter
    fi

    script_pane=$(tmux split-window -h -t "$tail_pane" -c "$PROJECT_ROOT" -P -F '#{pane_id}')
    local pipeline_cmd="$TOOLING_SCRIPT_Q $issue"
    [ -n "$FROM_STAGE_EXTRA" ] && pipeline_cmd="$pipeline_cmd $FROM_STAGE_EXTRA"
    [ -n "$MODELS_EXTRA" ] && pipeline_cmd="$pipeline_cmd $MODELS_EXTRA"
    [ -n "$VARIANT_EXTRA" ] && pipeline_cmd="$pipeline_cmd $VARIANT_EXTRA"
    tmux send-keys -t "$script_pane" "${ENV_PREFIX}$CAFF $pipeline_cmd" Enter

    # even-horizontal deshace el split -v de arriba (lo aplana a 3 columnas):
    # solo se aplica sin --verbose, donde nunca hubo split -v que preservar.
    if [ "$VERBOSE" != true ]; then
        tmux select-layout -t "$session:main" even-horizontal
    fi

    success "Pipeline mefisto-tooling iniciado para issue #$issue"
    print_connect_hint "$session"
}

# cmd_tooling_detached <issue> [flags...]
#
# MEFISTO_UI=mod (MEF-ADR-0055): la sesion de Claude Code que lanzo el skill
# muestra el avance en su mod mefisto-divine-wager, asi que no se abre ni sesion tmux
# ni pane herdr. El pipeline corre desacoplado (nohup) para sobrevivir al cierre
# de esa sesion, con el mismo string de comando que el pane tmux re-parsea y
# sin las variables HERDR_* (mismo aislamiento que cmd_pane_runner del lado
# herdr). --verbose no aplica: el mod ya es el visor.
cmd_tooling_detached() {
    extract_wrapper_flags "$@"
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

    local env_unset=(-u HERDR_ENV -u MEFISTO_UI)
    local v
    while IFS='=' read -r v _; do
        case "$v" in
            HERDR_*) env_unset+=(-u "$v") ;;
        esac
    done < <(env)

    (cd "$PROJECT_ROOT" && nohup env "${env_unset[@]}" bash -c "${ENV_PREFIX}$CAFF $pipeline_cmd" \
        >"$report_log" 2>&1 </dev/null &)

    success "Pipeline mefisto-tooling iniciado para issue #$issue (sin pane: lo sigue el mod mefisto-divine-wager)"
    log "Reporte: $report_log"
}

# cmd_batch_detached <issue>...
#
# MEFISTO_UI=mod (MEF-ADR-0055), mismo criterio que cmd_tooling_detached: el
# batch corre desacoplado (nohup), sin sesion tmux ni pane herdr, y el mod
# mefisto-divine-wager lo sigue desde pipeline-status-mefisto-batch.json y el status
# de cada eslabon. Las validaciones de flags ya las hizo preflight_batch_start.
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

    local env_unset=(-u HERDR_ENV -u MEFISTO_UI)
    local v
    while IFS='=' read -r v _; do
        case "$v" in
            HERDR_*) env_unset+=(-u "$v") ;;
        esac
    done < <(env)

    (cd "$PROJECT_ROOT" && nohup env "${env_unset[@]}" bash -c "${ENV_PREFIX}$CAFF $BATCH_SCRIPT_Q ${issues[*]}" \
        >"$report_log" 2>&1 </dev/null &)

    success "Batch pipeline interno iniciado: issues ${issues[*]} (sin pane: lo sigue el mod mefisto-divine-wager)"
    log "Reporte: $report_log"
}

cmd_batch() {
    # --verbose se extrae ANTES de construir issues_str (CA-2): cmd_batch lo
    # manda sin comillas por send-keys a mefisto-batch-pipeline.sh, que lo
    # parsea posicionalmente -- un --verbose colado ahi rompe ese parseo.
    extract_wrapper_flags "$@"
    # Misma guarda de bash 3.2 que en cmd_tooling: no expandir REMAINING_ARGS
    # vacio directo, revienta con "unbound variable" bajo `set -u`.
    local issues=()
    if [ ${#REMAINING_ARGS[@]} -gt 0 ]; then
        issues=("${REMAINING_ARGS[@]}")
    fi

    if [ ${#issues[@]} -eq 0 ]; then
        abort "Debes especificar al menos un issue. Uso: --batch 42 43 44 [--verbose]"
    fi

    # --from-stage sobre un lote de issues es ambiguo (mismo criterio que
    # scripts/tmux-pipeline.sh --batch/--parallel, issue #449): rechazar es la
    # opcion segura. mefisto-batch-pipeline.sh solo acepta --stop-on-error.
    [ -n "$FROM_STAGE_EXTRA" ] && abort "--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --from-stage N para un unico issue."
    # Mismo criterio: --models por issue sobre un lote tambien seria ambiguo
    # (issue #709).
    [ -n "$MODELS_EXTRA" ] && abort "--models no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --models 'agente=modelo' para un unico issue."
    # --variant es una corrida DE UN issue, N veces: tambien seria ambiguo
    # sobre un lote de issues distintos (issue #711).
    [ -n "$VARIANT_EXTRA" ] && abort "--variant no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --variant <label> para un unico issue."

    local session
    session=$(safe_session_name "mefisto-batch-$(date +%H%M%S)")
    local issues_str="${issues[*]}"

    check_tmux
    ensure_events_log
    handle_session_conflict "$session"

    log "Creando sesion tmux '$session' para batch interno: issues ${issues_str}..."

    # Patron pane_id (no indices implicitos) para evitar el bug de pane-base-index
    # que motivo el commit 6a6b978.
    local tail_pane script_pane watch_pane
    tmux new-session -d -s "$session" -n "main" -c "$PROJECT_ROOT"
    tail_pane=$(tmux list-panes -t "$session:main" -F '#{pane_id}' | head -n1)
    tmux set-option -t "$session" remain-on-exit on
    tmux send-keys -t "$tail_pane" "tail -f '$EVENTS_LOG'" Enter

    # El split -v (issue #435) se hace ANTES del -h, mientras tail_pane todavia
    # ocupa toda la ventana: asi el visor queda a lo ancho completo (abajo),
    # y tail_pane conserva el ancho completo para partirse en tail/script (arriba).
    if [ "$VERBOSE" = true ]; then
        watch_pane=$(tmux split-window -v -t "$tail_pane" -c "$PROJECT_ROOT" -P -F '#{pane_id}')
        tmux send-keys -t "$watch_pane" "./.claude/scripts/mefisto-stream-watch.sh" Enter
    fi

    script_pane=$(tmux split-window -h -t "$tail_pane" -c "$PROJECT_ROOT" -P -F '#{pane_id}')
    tmux send-keys -t "$script_pane" "${ENV_PREFIX}$CAFF $BATCH_SCRIPT_Q $issues_str" Enter

    # even-horizontal deshace el split -v de arriba (lo aplana a 3 columnas):
    # solo se aplica sin --verbose, donde nunca hubo split -v que preservar.
    if [ "$VERBOSE" != true ]; then
        tmux select-layout -t "$session:main" even-horizontal
    fi

    success "Batch pipeline interno iniciado: issues $issues_str"
    print_connect_hint "$session"
}

# Valida el modo batch y adelanta su gate de rama al limite sincronico del
# launcher. Debe correr antes de delegar a herdr o tocar tmux; el motor repite
# el mismo helper como defensa ante invocacion directa y carreras posteriores.
preflight_batch_start() {
    extract_wrapper_flags "$@"
    local issues=()
    [ ${#REMAINING_ARGS[@]} -gt 0 ] && issues=("${REMAINING_ARGS[@]}")
    [ ${#issues[@]} -gt 0 ] || abort "Debes especificar al menos un issue. Uso: --batch 42 43 44 [--verbose]"
    [ -z "$FROM_STAGE_EXTRA" ] || abort "--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --from-stage N para un unico issue."
    [ -z "$MODELS_EXTRA" ] || abort "--models no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --models 'agente=modelo' para un unico issue."
    [ -z "$VARIANT_EXTRA" ] || abort "--variant no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --variant <label> para un unico issue."
    ensure_repo_on_base_branch
}

# --- Dispatcher ---
if [ $# -eq 0 ]; then
    print_usage
    exit 1
fi

# Autodeteccion herdr (porte interno del issue #690): dentro de un pane
# herdr, los modos con equivalente se despachan a la interfaz herdr (pane de
# ejecucion en el workspace actual, sin sesion tmux); fuera de herdr, o para
# --attach, todo sigue igual que siempre.
if [ "$1" = "--batch" ]; then
    preflight_batch_start "${@:2}"
fi

# Issue #2284: el modo desacoplado tambien se elige por el runtime ya resuelto
# (MEFISTO_RUNTIME, que el comando antepone siempre): con el runtime claude y
# sin MEFISTO_UI explicito, la cinta de la propia sesion es el visor y no se
# abre pane ni sesion tmux. Un MEFISTO_UI explicito (tmux|herdr|mod) siempre
# gana; un runtime sin cinta de sesion conserva el pane herdr / sesion tmux de siempre.
uses_detached_ui() {
    [ "${MEFISTO_UI:-}" = "mod" ] && return 0
    [ -z "${MEFISTO_UI:-}" ] && [ "${MEFISTO_RUNTIME:-}" = "claude" ] && return 0
    return 1
}

if uses_detached_ui && [ "${1:-}" = "--tooling" ]; then
    shift
    cmd_tooling_detached "$@"
    exit 0
fi

if uses_detached_ui && [ "${1:-}" = "--batch" ]; then
    shift
    cmd_batch_detached "$@"
    exit 0
fi

if should_delegate_to_herdr "$@"; then
    # mefisto-herdr-pipeline.sh ya es canonico en src/internal/scripts/
    # (issue #872): mismo criterio que TOOLING_SCRIPT_Q/BATCH_SCRIPT_Q arriba,
    # hermano de este script en SCRIPT_DIR.
    exec "$SCRIPT_DIR/mefisto-herdr-pipeline.sh" "$@"
fi

case "$1" in
    --help|-h)
        print_usage
        ;;
    --tooling)
        shift
        cmd_tooling "$@"
        ;;
    --batch)
        shift
        cmd_batch "$@"
        ;;
    --attach)
        shift
        cmd_attach "${1:-}"
        ;;
    *)
        abort "Argumento no reconocido: $1"
        ;;
esac
