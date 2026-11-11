#!/usr/bin/env bash
# herdr-pipeline.sh --- Interfaz herdr de los pipelines publicados (issue #690)
#
# Uso (misma superficie de modos que launch-pipeline.sh):
#   herdr-pipeline.sh 42                          # issue unico (enruta por label)
#   herdr-pipeline.sh 42 --from-stage 3           # retomar desde Stage 3
#   herdr-pipeline.sh --pipeline tooling 42       # forzar pipeline
#   herdr-pipeline.sh --tooling 42                # tooling explicito
#   herdr-pipeline.sh --infra 42                  # IaC explicito
#   herdr-pipeline.sh --scaffold 42 --domain x    # scaffold de dominio
#   herdr-pipeline.sh --batch 42 43 44            # secuencial
#   herdr-pipeline.sh --parallel 42 43            # paralelo: un pane apilado por issue
#   herdr-pipeline.sh --collapse-panes            # poda paneles libres sobrantes sin despachar
#   herdr-pipeline.sh --refresh-agents             # refresca agentes interactivos sin despachar
#
# Esta interfaz trabaja DENTRO del workspace herdr actual: reutiliza (o crea
# con `herdr pane split`) un pane de ejecucion al lado del pane que
# despacha, corre el sub-pipeline en background con su
# reporte a un log, y muestra en el pane el visor en vivo (stream-watch.sh)
# que sigue al agente en curso -- saltando solo de stream en stream a lo
# largo de la secuencia de agentes del issue, siempre en el MISMO pane. Al
# terminar (o si el pipeline muere antes de escribir traza: DoR invalido,
# worktree fallido...) el pane muestra el reporte final.
#
# Concurrencia: si el pane de ejecucion sigue ocupado con otra corrida, se
# abre un pane adicional; los panes libres se reutilizan en despachos
# posteriores. La deteccion de "libre" es del lado de herdr: un shell
# interactivo sin comando
# en foreground (`herdr pane process-info`: foreground_process_group_id ==
# shell_pid). Cada visor filtra por sus issues (--issues de stream-watch.sh)
# para que dos corridas concurrentes no se crucen.
#
# Modo paralelo (issue #705): un pane por issue, apilados en la columna del
# pane de ejecucion -- el primer issue reutiliza/crea el pane de la derecha
# (acquire_report_pane, que ademas colapsa los libres sobrantes) y los demas
# son splits hacia abajo con alturas parejas (stack_split_ratio). Cada pane
# corre el runner con el visor de SU issue y un arranque escalonado
# (PARALLEL_STAGGER) que espera DENTRO del pane, no en quien despacha. Un
# lote con dos o mas issues tipo:projection se rechaza: comparten los
# archivos del worker de proyecciones (MEF-ADR-0034) y en modo pane no hay
# scheduler que los serialice (usa /sequential o parallel-pipeline.sh, cuyo
# scheduler si serializa).
#
# Confirmacion de arranque (issue #1563): tras teclear el runner en un pane,
# quien despacha espera el marcador herdr-dispatch-<token>.started (bajo el
# estado del pipeline) hasta HERDR_DISPATCH_CONFIRM_TIMEOUT segundos (default
# 15). Sin confirmacion, el despacho de un issue reintenta UNA vez en un pane
# nuevo y, si tampoco confirma, falla nombrando ambos panes; --parallel falla
# nombrando el issue y su pane, sin reintento. Al agotar el plazo el
# despachador reclama el marcador (creacion exclusiva): un runner que arranque
# tarde en el pane sospechoso lo encuentra ya reclamado y aborta sin lanzar
# nada, asi el reintento nunca duplica una corrida (MEF-ADR-0017).
#
# Este script requiere correr dentro de un pane herdr (HERDR_ENV=1): la
# autodeteccion vive en launch-pipeline.sh, que delega aqui cuando aplica y
# corre desacoplado cuando no. Fuera de herdr, usa launch-pipeline.sh directo.

set -euo pipefail

# --- Funciones compartidas (resolve_pipeline) ---
source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"

# La clausura publicada distribuye los adaptadores de runtime junto al pipeline.
# El runtime resuelto forma parte de la identidad del pool de panes: nunca se
# infiere de un default concreto en esta capa neutral.
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
    echo "ERROR: scripts/herdr-pipeline.sh es del plugin publicado y solo aplica al consumidor." >&2
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

# PROJECT_ROOT: repo objetivo del consumidor (git toplevel del cwd del usuario).
PROJECT_ROOT="$_REPO_TOP"
LOG_DIR_ABS="$(dirname "$(mefisto_state_path 'logs/.state')")"
# CAFF: prefijo "caffeinate -i" (o vacio fuera de macOS), calculado UNA vez
# por corrida y antepuesto al lanzamiento en background del sub-pipeline
# dentro de cmd_pane_runner -- issue #800. Evita que el Mac entre en
# suspension idle mientras el pane de ejecucion corre.
CAFF="$(caffeinate_prefix)"
# Registro canonico de panes de ejecucion: una linea "<pane_id> <runtime>".
# Se asigna mediante mefisto_state_path solo despues de resolver el runtime;
# el ledger legacy .claude/pipeline no se lee ni se modifica.
PANES_STATE=""
HERDR_RUNTIME=""
# Segundos entre arranques de los issues de un lote --parallel: varios
# `claude -p` arrancando a la vez compiten por la API. La espera corre DENTRO
# de cada pane (--delay del runner), asi el despacho devuelve el control de
# inmediato.
PARALLEL_STAGGER=30
# Confirmacion de arranque tras teclear el comando en un pane (issue #1563):
# `herdr pane run` devuelve 0 en cuanto el texto se tecleo, no cuando el shell
# lo ejecuto -- un pane reutilizado puede haber quedado en un modo de terminal
# invalido (bracketed paste sin cerrar del ocupante anterior, visto en la
# certificacion v0.38.2: la linea entera se interpreto como "bad pattern" y
# --_pane-runner jamas arranco). cmd_pane_runner escribe un marcador de
# arranque ANTES de lanzar el sub-pipeline; quien despacha lo espera hasta
# este timeout (configurable) antes de anunciar exito.
HERDR_DISPATCH_CONFIRM_TIMEOUT="${HERDR_DISPATCH_CONFIRM_TIMEOUT:-15}"
# Contador de despachos de ESTA corrida: junto al timestamp y el PID arma un
# token unico por marcador (dos despachos en el mismo segundo no colisionan).
DISPATCH_TOKEN_SEQ=0

# Los mensajes de progreso van a stderr: varios helpers de este script
# devuelven su resultado por stdout (acquire_report_pane) y un log colado ahi
# corromperia el valor capturado.
log()     { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1" >&2; }
success() { echo -e "${GREEN}${BOLD}v${NC} $1" >&2; }
warn()    { echo -e "${YELLOW}!${NC} $1" >&2; }
abort()   { echo -e "\n${RED}${BOLD}x $1${NC}" >&2; exit 1; }

# Normaliza la ruta de sub-script devuelta por resolve_pipeline a una ruta
# absoluta dentro del plugin (mismo criterio que launch-pipeline.sh).
plugin_script() {
    echo "$SCRIPT_DIR/$(basename "$1")"
}

# --- Guard de contexto herdr ---
require_herdr_context() {
    command -v herdr &>/dev/null \
        || abort "herdr no esta instalado (https://herdr.dev). Fuera de herdr usa: launch-pipeline.sh"
    [ "${HERDR_ENV:-}" = "1" ] \
        || abort "No estas dentro de un pane de herdr (HERDR_ENV != 1). Fuera de herdr usa: launch-pipeline.sh"
    [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_WORKSPACE_ID:-}" ] \
        || abort "Faltan HERDR_PANE_ID/HERDR_WORKSPACE_ID en el entorno (los inyecta herdr en cada pane)."
    command -v jq &>/dev/null \
        || abort "La interfaz herdr requiere jq para leer las respuestas del socket API. Instala jq (brew install jq) o usa MEFISTO_UI=mod."
    resolve_report_runtime
}

# resolve_report_runtime -- resuelve una vez el runtime del despacho antes de
# tocar el ledger o la API de panes. Se invoca desde require_herdr_context(),
# que es el unico gate de todos los modos que despachan.
resolve_report_runtime() {
    if ! mefisto_resolve_runtime >/dev/null; then
        abort "No se pudo resolver el runtime activo: ${MEFISTO_RUNTIME_ERROR:-motivo desconocido}"
    fi
    HERDR_RUNTIME="$MEFISTO_RESOLVED_RUNTIME"
    PANES_STATE="$(mefisto_state_path "herdr-report-panes.txt")" \
        || abort "No se pudo preparar el pool canonico de panes Herdr."
}

# --- Helpers de panes ---

# pane_exists <pane_id> -- 0 si el pane sigue vivo en el servidor.
pane_exists() {
    herdr pane get "$1" >/dev/null 2>&1
}

# pane_is_free <pane_id>
#
# 0 si el pane esta en su prompt interactivo, sin comando en foreground: el
# process-info de herdr reporta el shell mismo como grupo de foreground
# (foreground_process_group_id == shell_pid). Cualquier fallo de consulta se
# trata como "no libre" (conservador: nunca se teclea sobre una corrida).
pane_is_free() {
    local id="$1"
    local info fg sh
    info=$(herdr pane process-info --pane "$id" 2>/dev/null) || return 1
    fg=$(echo "$info" | jq -r '.result.process_info.foreground_process_group_id // empty' 2>/dev/null)
    sh=$(echo "$info" | jq -r '.result.process_info.shell_pid // empty' 2>/dev/null)
    [ -n "$fg" ] && [ -n "$sh" ] && [ "$fg" = "$sh" ]
}

# prune_report_panes
#
# Poda compartida por acquire_report_pane y --collapse-panes (issue #799):
# recorre PANES_STATE, quita los panes que ya no existen (cerrados a mano) y
# CIERRA los panes libres sobrantes de corridas concurrentes ya terminadas
# del MISMO workspace y runtime, dejando vivo el primero que encuentra libre
# (no lo cierra: queda disponible para reutilizar). Nunca toca panes ocupados
# ni de otro workspace/runtime. Las entradas de panes muertos se eliminan sin
# importar su runtime. Imprime por stdout dos
# lineas: el pane_id libre que quedo vivo (vacio si no habia ninguno) y la
# cantidad de panes cerrados.
prune_report_panes() {
    mkdir -p "$(dirname "$PANES_STATE")"
    touch "$PANES_STATE"

    local kept="" chosen="" line id pane_runtime closed=0
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
            *' '*)
                id="${line%% *}"
                pane_runtime="${line#* }"
                ;;
            *)
                # Una entrada sin runtime no tiene identidad segura: se poda
                # sin consultar ni cerrar su pane. El pool legacy ni se abre.
                continue ;;
        esac
        # El ledger canonico conserva exclusivamente el formato contractual
        # "<pane_id> <runtime>". Una fila corrupta tampoco autoriza acciones
        # sobre panes porque su identidad no es confiable.
        case "$id" in ''|*[[:space:]]*) continue ;; esac
        case "$pane_runtime" in ''|*[!a-z0-9_]*) continue ;; esac
        pane_exists "$id" || continue
        case "$id" in
            "$HERDR_WORKSPACE_ID:"*) ;;
            *)
                kept="${kept}${line}
"
                continue ;;
        esac
        if [ "$pane_runtime" != "$HERDR_RUNTIME" ]; then
            kept="${kept}${line}
"
            continue
        fi
        if pane_is_free "$id"; then
            if [ -z "$chosen" ]; then
                chosen="$id"
                kept="${kept}${line}
"
            elif herdr pane close "$id" >/dev/null 2>&1; then
                log "Pane sobrante de una corrida terminada cerrado: $id"
                closed=$((closed + 1))
            else
                kept="${kept}${line}
"
            fi
        else
            kept="${kept}${line}
"
        fi
    done < "$PANES_STATE"
    printf '%s' "$kept" > "$PANES_STATE"

    printf '%s\n%s\n' "$chosen" "$closed"
}

# assert_pane_ownership
#
# Issue #2285 (contraparte de #2284): HERDR_PANE_ID puede ser heredado y ajeno
# (un daemon o un proceso lanzado desde otro pane lo arrastra). Antes de
# cualquier herdr pane split/run/close se exige que este proceso descienda del
# shell_pid que herdr reporta para ese pane; si no, aborta sin tocar ningun pane.
assert_pane_ownership() {
    [ -n "${HERDR_PANE_OWNERSHIP_OK:-}" ] && return 0
    local info shell_pid pid
    info=$(herdr pane process-info --pane "$HERDR_PANE_ID" 2>/dev/null) || info=""
    shell_pid=$(echo "$info" | jq -r '.result.process_info.shell_pid // empty' 2>/dev/null)
    pid=$$
    local depth=0
    while [ -n "$shell_pid" ] && [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$depth" -lt 64 ]; do
        [ "$pid" = "$shell_pid" ] && { HERDR_PANE_OWNERSHIP_OK=1; return 0; }
        pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        depth=$((depth + 1))
    done
    abort "HERDR_PANE_ID=$HERDR_PANE_ID es heredado y no es el pane de esta sesion (este proceso no desciende de su shell): no se abre ningun pane. Usa MEFISTO_UI=mod, o lanza desde el pane herdr propio."
}

# split_new_report_pane
#
# Crea un pane de ejecucion NUEVO (split a la derecha del pane que despacha,
# sin robar el foco) y lo registra en PANES_STATE. Compartido por
# acquire_report_pane (cuando no hay ninguno libre) y por dispatch_to_pane
# cuando el reintento de arranque (CA-3, issue #1563) exige un pane que NUNCA
# se tecleo antes -- nunca el pane sospechoso de un arranque no confirmado.
split_new_report_pane() {
    assert_pane_ownership
    local resp chosen
    resp=$(herdr pane split --pane "$HERDR_PANE_ID" --direction right --cwd "$PROJECT_ROOT" --no-focus 2>&1) \
        || abort "No se pudo crear el pane de ejecucion (herdr pane split): $resp"
    chosen=$(echo "$resp" | jq -r '.result.pane.pane_id // empty' 2>/dev/null)
    [ -n "$chosen" ] || abort "herdr pane split no devolvio pane_id. Respuesta: $resp"
    echo "$chosen $HERDR_RUNTIME" >> "$PANES_STATE"
    echo "$chosen"
}

# acquire_report_pane
#
# Imprime por stdout el pane_id donde correr el proximo pipeline: el primer
# pane registrado que siga vivo, pertenezca a ESTE workspace y este libre (via
# prune_report_panes, que de paso cierra los libres sobrantes); o uno nuevo
# (split_new_report_pane). El layout colapsa naturalmente de vuelta a UN solo
# pane de seguimiento, y despachar un issue nuevo "reemplaza" al pane del que
# termino en vez de acumular ventanas (el reporte de cada corrida pasada sigue
# en su .report.log).
acquire_report_pane() {
    assert_pane_ownership
    local result chosen
    result=$(prune_report_panes)
    chosen=$(printf '%s' "$result" | sed -n '1p')

    if [ -z "$chosen" ]; then
        chosen=$(split_new_report_pane)
        log "Pane de ejecucion nuevo: $chosen"
    else
        log "Reusando el pane de ejecucion libre: $chosen"
    fi

    echo "$chosen"
}

# next_dispatch_token
#
# Token unico por despacho (timestamp + PID de este proceso + contador
# incremental de la corrida): dos despachos en el mismo segundo no producen el
# mismo nombre de marcador, y un marcador de una corrida vieja jamas confirma
# un arranque nuevo (issue #1563).
next_dispatch_token() {
    DISPATCH_TOKEN_SEQ=$((DISPATCH_TOKEN_SEQ + 1))
    printf '%s-%s-%s\n' "$(date +%s)" "$$" "$DISPATCH_TOKEN_SEQ"
}

# dispatch_marker_path <token>
#
# Ruta del marcador de arranque bajo el estado canonico del pipeline (issue
# #1563, CA-1): cmd_pane_runner lo escribe ANTES de lanzar el sub-pipeline;
# quien despacha solo lo lee, nunca lo crea.
dispatch_marker_path() {
    mefisto_state_path "herdr-dispatch-$1.started"
}

# wait_for_dispatch_marker <marker> <timeout_s>
#
# 0 si <marker> aparece antes de agotar <timeout_s> segundos (CA-2); 1 si se
# agota el plazo. Sondeo de 1s: el marcador es un archivo vacio, no hace falta
# mas resolucion que la de notar a tiempo un pane atascado.
wait_for_dispatch_marker() {
    local marker="$1" timeout="$2" waited=0
    while [ ! -f "$marker" ]; do
        [ "$waited" -lt "$timeout" ] || return 1
        sleep 1
        waited=$((waited + 1))
    done
    return 0
}

# claim_dispatch_marker <marker>
#
# Reclama <marker> con creacion exclusiva (noclobber, O_EXCL) una vez agotado
# el plazo. 0 si el despachador lo creo: el runner de ese pane, si llegara a
# arrancar tarde, lo encontrara ya ocupado y abortara sin lanzar nada. 1 si el
# archivo ya existia: el runner SI arranco (justo en el borde del plazo) y se
# trata como confirmado -- nunca se reintenta sobre un runner vivo, para no
# duplicar la corrida del mismo issue (MEF-ADR-0017).
claim_dispatch_marker() {
    ( set -C; printf 'abandonado\n' > "$1" ) 2>/dev/null
}

# stack_split_ratio <total> <k>
#
# Ratio del k-esimo split (1-indexado) al apilar <total> panes de alturas
# parejas en una columna partiendo siempre el pane inferior: 1/(total-k+1).
# En herdr el ratio de un split es la fraccion que conserva el pane ORIGINAL
# (el nodo `first` del arbol BSP, el de arriba en un split down; verificado
# en split_at/split_rect de src/layout.rs de herdr 0.8.2), asi que el pane
# que queda arriba conserva 1/total y el resto se sigue partiendo parejo.
# herdr acota el ratio a [0.1, 0.9] (valid_split_ratio): con 10+ issues los
# primeros panes quedan algo mas altos que 1/total -- cosmetico, sin manejo
# especial. Pura (sin herdr, sin estado) para poder testearla sola.
stack_split_ratio() {
    local total="$1" k="$2"
    awk -v t="$total" -v k="$k" 'BEGIN { printf "%.4f", 1 / (t - k + 1) }'
}

# build_pane_runner_cmdline <titulo> <issues_csv> <delay_s> <started_marker> <cmd> [args...]
#
# Imprime por stdout la linea que un pane debe ejecutar para correr el runner
# interno (--_pane-runner) con <cmd args...>. Todo argumento va quoteado con
# printf %q: el pane run literalmente escribe la linea en el shell del pane.
# <started_marker> vacio omite el flag --started-marker; cuando se pasa, es la
# ruta que cmd_pane_runner escribe antes de lanzar el sub-pipeline (issue
# #1563, CA-1).
build_pane_runner_cmdline() {
    local title="$1" issues_csv="$2" delay="$3" started_marker="$4"
    shift 4

    local cmdline
    cmdline="cd $(printf '%q' "$PROJECT_ROOT") && MEFISTO_RUNTIME=$(printf '%q' "$HERDR_RUNTIME") $(printf '%q' "$SCRIPT_DIR/herdr-pipeline.sh") --_pane-runner --title $(printf '%q' "$title")"
    if [ -n "$issues_csv" ]; then
        cmdline="$cmdline --issues $(printf '%q' "$issues_csv")"
    fi
    if [ "$delay" -gt 0 ]; then
        cmdline="$cmdline --delay $delay"
    fi
    if [ -n "$started_marker" ]; then
        cmdline="$cmdline --started-marker $(printf '%q' "$started_marker")"
    fi
    cmdline="$cmdline --"
    local a
    for a in "$@"; do
        cmdline="$cmdline $(printf '%q' "$a")"
    done
    echo "$cmdline"
}

# dispatch_to_pane <titulo> <issues_csv> <cmd> [args...]
#
# Consigue un pane libre y le teclea (herdr pane run) la invocacion del
# runner interno (--_pane-runner), que corre <cmd args...> en background con
# su reporte a un log y muestra el visor en primer plano.
#
# Confirmacion de arranque (issue #1563, CA-2/CA-3/CA-4): `herdr pane run`
# devolviendo 0 solo confirma que el texto se tecleo, nunca que el shell del
# pane lo ejecuto. Se espera el marcador de cmd_pane_runner hasta
# HERDR_DISPATCH_CONFIRM_TIMEOUT; si no aparece, se reintenta UNA vez en un
# pane nuevo (split, jamas el sospechoso) y si tampoco confirma se falla
# visible nombrando ambos panes -- ninguno de los dos se cierra solo (podrian
# tener salida util para diagnostico).
dispatch_to_pane() {
    local title="$1" issues_csv="$2"
    shift 2

    local pane token marker cmdline
    pane=$(acquire_report_pane)
    token=$(next_dispatch_token)
    marker=$(dispatch_marker_path "$token")
    rm -f "$marker"
    cmdline=$(build_pane_runner_cmdline "$title" "$issues_csv" 0 "$marker" "$@")

    herdr pane run "$pane" "$cmdline" >/dev/null 2>&1 \
        || abort "No se pudo lanzar el pipeline en el pane $pane (herdr pane run fallo)."

    if wait_for_dispatch_marker "$marker" "$HERDR_DISPATCH_CONFIRM_TIMEOUT" \
        || ! claim_dispatch_marker "$marker"; then
        success "Pipeline '$title' corriendo en el pane $pane de este workspace."
        log "El pane muestra el visor en vivo del agente; el reporte completo queda en $LOG_DIR_ABS/."
        log "No hay sesion que adjuntar: el pane ya esta visible en el workspace (barra lateral de herdr)."
        return 0
    fi

    warn "El pane $pane no confirmo el arranque en ${HERDR_DISPATCH_CONFIRM_TIMEOUT}s (marcador ausente): puede tener el shell en un estado invalido. Reintentando en un pane nuevo, sin volver a escribir en $pane."

    local retry_pane retry_token retry_marker retry_cmdline
    retry_pane=$(split_new_report_pane)
    retry_token=$(next_dispatch_token)
    retry_marker=$(dispatch_marker_path "$retry_token")
    rm -f "$retry_marker"
    retry_cmdline=$(build_pane_runner_cmdline "$title" "$issues_csv" 0 "$retry_marker" "$@")

    herdr pane run "$retry_pane" "$retry_cmdline" >/dev/null 2>&1 \
        || abort "No se pudo lanzar el pipeline en el pane de reintento $retry_pane (herdr pane run fallo). Pane sospechoso original: $pane."

    if wait_for_dispatch_marker "$retry_marker" "$HERDR_DISPATCH_CONFIRM_TIMEOUT" \
        || ! claim_dispatch_marker "$retry_marker"; then
        success "Pipeline '$title' corriendo en el pane $retry_pane de este workspace (reintento tras un arranque no confirmado en $pane)."
        log "El pane muestra el visor en vivo del agente; el reporte completo queda en $LOG_DIR_ABS/."
        log "No hay sesion que adjuntar: el pane ya esta visible en el workspace (barra lateral de herdr)."
        return 0
    fi

    abort "Ni el pane $pane ni el reintento $retry_pane confirmaron el arranque de '$title' en ${HERDR_DISPATCH_CONFIRM_TIMEOUT}s. Cierra ambos paneles (alguno de los dos shells puede seguir en un estado invalido) y relanza el pipeline a mano."
}

# --- Runner interno (corre DENTRO del pane de ejecucion) ---
#
# herdr-pipeline.sh --_pane-runner --title <t> [--issues <csv>] [--delay <s>]
#                    [--started-marker <path>] -- <cmd> [args...]
#
# 0. Si recibio --started-marker, lo crea en exclusiva de inmediato -- ANTES de
#    cualquier otro paso, incluido el --delay del escalonado -- para que
#    confirme que el shell del pane ejecuto esta linea (issue #1563, CA-1);
#    quien despacha lo espera con un timeout corto e independiente del
#    escalonado de lotes --parallel.
# 1. Renombra el pane con el titulo de la corrida (visible en el borde/sidebar).
#    Con --delay (lotes --parallel) espera esos segundos, visible en el pane,
#    antes de lanzar: el escalonado no bloquea a quien despacha.
# 2. Lanza <cmd> en background con stdout+stderr al reporte (.report.log).
# 3. Muestra el visor en vivo filtrado a los issues de ESTA corrida y a
#    streams nacidos despues de ahora (--newer-than): sin traza previa ajena.
# 4. Cuando el pipeline termina, corta el visor e imprime el reporte final
#    (completo si es corto, la cola si es largo). Si el pipeline murio antes
#    de escribir traza alguna, ese reporte es lo primero util que se ve.
# 5. Renombra el pane a "[ok] ..."/"[fallo] ..." y devuelve el exit code del
#    pipeline; el shell del pane queda en su prompt, listo para reutilizarse.
cmd_pane_runner() {
    local title="" issues_csv="" delay=0 started_marker=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --title)
                [ $# -lt 2 ] && abort "Falta el valor de --title"
                title="$2"; shift 2 ;;
            --issues)
                [ $# -lt 2 ] && abort "Falta el valor de --issues"
                issues_csv="$2"; shift 2 ;;
            --delay)
                [ $# -lt 2 ] && abort "Falta el valor de --delay"
                [[ "$2" =~ ^[0-9]+$ ]] || abort "--delay debe ser un entero de segundos (recibido: '$2')"
                delay="$2"; shift 2 ;;
            --started-marker)
                [ $# -lt 2 ] && abort "Falta el valor de --started-marker"
                started_marker="$2"; shift 2 ;;
            --)
                shift; break ;;
            *)
                abort "Argumento no reconocido para --_pane-runner: $1" ;;
        esac
    done
    [ -n "$title" ] || abort "--_pane-runner requiere --title"
    [ $# -gt 0 ] || abort "--_pane-runner requiere un comando tras --"

    # Paso 0: confirmar el arranque antes que nada mas (issue #1563, CA-1).
    # Creacion exclusiva: si el archivo ya existe, el despachador lo reclamo
    # al agotar el plazo y ya reintento en otro pane -- arrancar aqui
    # duplicaria la corrida (MEF-ADR-0017).
    if [ -n "$started_marker" ]; then
        mkdir -p "$(dirname "$started_marker")" 2>/dev/null || true
        if ! ( set -C; : > "$started_marker" ) 2>/dev/null; then
            abort "Este pane arranco despues del plazo de confirmacion ($started_marker ya reclamado por el despachador): no se lanza nada para no duplicar la corrida. Cierra este pane."
        fi
    fi

    mkdir -p "$LOG_DIR_ABS"
    local ts report_log
    ts=$(date +%Y%m%d-%H%M%S)
    report_log="$LOG_DIR_ABS/herdr-run-$ts-$$.report.log"

    if [ -n "${HERDR_PANE_ID:-}" ]; then
        herdr pane rename "$HERDR_PANE_ID" "$title" >/dev/null 2>&1 || true
    fi

    # Reemplazo natural del pane reutilizado: limpia pantalla y scrollback de
    # la corrida anterior antes del banner (2J pantalla, 3J scrollback, H
    # cursor a origen). El reporte de la corrida vieja sigue en su .report.log.
    printf '\033[2J\033[3J\033[H'

    echo -e "${CYAN}${BOLD}=== $title ===${NC}"
    echo -e "${CYAN}Comando: $*${NC}"
    echo -e "${CYAN}Reporte: $report_log${NC}"
    echo ""

    # Arranque escalonado de los lotes --parallel. Espera ANTES de start_epoch
    # para que el visor (--newer-than) siga viendo el stream propio.
    if [ "$delay" -gt 0 ]; then
        echo -e "${YELLOW}Arranque escalonado: esperando ${delay}s antes de lanzar...${NC}"
        sleep "$delay"
    fi

    local start_epoch
    start_epoch=$(date +%s)

    # El pipeline y TODOS sus descendientes (agentes claude -p, gates que
    # corren los tests del repo) arrancan con las variables HERDR_* removidas:
    # con HERDR_ENV=1 heredado del pane, cualquier invocacion de
    # launch-pipeline.sh a lo largo de la corrida (p. ej. las fixtures de
    # test-launch-preparse.sh) autodetectaria herdr y crearia panes REALES en
    # el workspace del humano (visto en vivo: explosion de panes "[fallo]").
    # El runner conserva su propio entorno -- el rename final usa
    # HERDR_PANE_ID -- solo el hijo corre aislado. El array arranca con un
    # -u fijo para nunca expandirse vacio (bash 3.2 revienta con "unbound
    # variable" al expandir un array vacio bajo `set -u`).
    local env_unset=(-u HERDR_ENV)
    local v
    while IFS='=' read -r v _; do
        case "$v" in
            HERDR_*) env_unset+=(-u "$v") ;;
        esac
    done < <(env)

    # $CAFF se expande sin comillas a proposito (0 o 2 palabras, "caffeinate -i"):
    # aplica el prefijo sin duplicar el lanzamiento en una rama if/else por cada
    # valor posible (issue #800). caffeinate exec-a el comando en su lugar (ver
    # caffeinate_prefix), asi que $! sigue siendo el PID del pipeline: el trap,
    # el wait y el rc de abajo conservan su semantica.
    # shellcheck disable=SC2086
    $CAFF env "${env_unset[@]}" "$@" >"$report_log" 2>&1 &
    local pipe_pid=$!

    local viewer_pid=""
    if [ -n "$issues_csv" ]; then
        "$SCRIPT_DIR/stream-watch.sh" --issues "$issues_csv" --newer-than "$start_epoch" &
    else
        "$SCRIPT_DIR/stream-watch.sh" --newer-than "$start_epoch" &
    fi
    viewer_pid=$!

    # Ctrl+C en el pane ya llega a pipeline y visor (comparten el grupo de
    # foreground); el trap solo asegura la limpieza y deja constancia.
    trap '
        kill '"$pipe_pid"' 2>/dev/null || true
        kill '"$viewer_pid"' 2>/dev/null || true
        [ -n "${HERDR_PANE_ID:-}" ] && herdr pane rename "$HERDR_PANE_ID" "[cortado] '"$title"'" >/dev/null 2>&1 || true
        echo ""
        echo "Corrida interrumpida. Reporte parcial: '"$report_log"'"
        exit 130
    ' INT TERM

    local rc=0
    wait "$pipe_pid" || rc=$?
    trap - INT TERM

    kill "$viewer_pid" 2>/dev/null || true
    wait "$viewer_pid" 2>/dev/null || true

    echo ""
    if [ "$rc" -eq 0 ]; then
        echo -e "${GREEN}${BOLD}=== $title: pipeline terminado OK ===${NC}"
    else
        echo -e "${RED}${BOLD}=== $title: pipeline FALLO (exit $rc) ===${NC}"
    fi
    echo ""

    if [ -f "$report_log" ]; then
        local total_lines
        total_lines=$(wc -l < "$report_log" | tr -d ' ')
        if [ "$total_lines" -le 60 ]; then
            cat "$report_log"
        else
            echo -e "${YELLOW}(ultimas 40 lineas del reporte; completo en $report_log)${NC}"
            echo ""
            tail -n 40 "$report_log"
        fi
    else
        echo "(el pipeline no llego a escribir reporte)"
    fi

    if [ -n "${HERDR_PANE_ID:-}" ]; then
        if [ "$rc" -eq 0 ]; then
            herdr pane rename "$HERDR_PANE_ID" "[ok] $title" >/dev/null 2>&1 || true
        else
            herdr pane rename "$HERDR_PANE_ID" "[fallo] $title" >/dev/null 2>&1 || true
        fi
    fi

    return "$rc"
}

# --- Modos (misma superficie que launch-pipeline.sh) ---

cmd_single() {
    local issue="$1"
    local extra_args="${2:-}"
    local pipeline_override="${3:-}"
    # models: idem al parametro homonimo de cmd_tooling (issue #712) -- argumento
    # propio y entrecomillado, NO concatenado a extra_args, porque extra_args se
    # expande sin comillas mas abajo y un id de modelo completo como
    # 'claude-opus-5[1m]' es un patron glob valido que la pathname expansion
    # podria alterar. resolve_pipeline() solo devuelve tdd-pipeline.sh o
    # tooling-pipeline.sh aqui (los unicos overrides validos son "tdd"/"tooling";
    # tipo:infra ya aborto como SKIP arriba), y ambos implementan --models.
    local models="${4:-}"
    # variant: label crudo de --variant (issue #713), mismo criterio que
    # 'models' -- argumento propio, no concatenado a extra_args. resolve_pipeline()
    # solo devuelve tdd-pipeline.sh o tooling-pipeline.sh aqui, y desde este issue
    # ambos implementan --variant.
    local variant="${5:-}"

    local resolved
    resolved=$(resolve_pipeline "$issue" "$pipeline_override")
    if [[ "$resolved" == SKIP:* ]]; then
        local reason="${resolved#SKIP:}"
        abort "Issue #$issue no se puede enrutar a un pipeline ($reason)."
    fi
    resolved="$(plugin_script "$resolved")"

    local pipeline_name
    pipeline_name=$(basename "$resolved" .sh)
    local title="${pipeline_name%-pipeline} #$issue"
    [ -n "$variant" ] && title="${pipeline_name%-pipeline} #$issue ($variant)"

    if [ -n "$models" ] && [ -n "$variant" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$resolved" "$issue" $extra_args --models "$models" --variant "$variant"
    elif [ -n "$models" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$resolved" "$issue" $extra_args --models "$models"
    elif [ -n "$variant" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$resolved" "$issue" $extra_args --variant "$variant"
    else
        # shellcheck disable=SC2086 # extra_args es una lista de flags simples
        dispatch_to_pane "$title" "$issue" "$resolved" "$issue" $extra_args
    fi
}

cmd_tooling() {
    local issue="$1"
    local extra_args="${2:-}"
    # models: el valor crudo de --models (issue #708), como argumento propio y
    # entrecomillado -- NO concatenado a extra_args. extra_args se expande sin
    # comillas (lista de flags simples, p. ej. "--from-stage 2") y ahi un id de
    # modelo completo como 'claude-opus-5[1m]' es un patron glob valido que la
    # pathname expansion podria alterar. Como argumento propio llega intacto a
    # build_pane_runner_cmdline, que lo quotea con printf %q hacia el pane.
    local models="${3:-}"
    # variant: label crudo de --variant (issue #710), mismo criterio que
    # 'models' -- argumento propio, no concatenado a extra_args. Ademas
    # distingue el titulo del pane cuando hay variante (dos corridas del mismo
    # issue en panes separados, cada una identificable en la barra lateral).
    local variant="${4:-}"
    local title="tooling #$issue"
    [ -n "$variant" ] && title="tooling #$issue ($variant)"
    if [ -n "$models" ] && [ -n "$variant" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/tooling-pipeline.sh" "$issue" $extra_args --models "$models" --variant "$variant"
    elif [ -n "$models" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/tooling-pipeline.sh" "$issue" $extra_args --models "$models"
    elif [ -n "$variant" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/tooling-pipeline.sh" "$issue" $extra_args --variant "$variant"
    else
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/tooling-pipeline.sh" "$issue" $extra_args
    fi
}

cmd_infra() {
    local issue="$1"
    local extra_args="${2:-}"
    # shellcheck disable=SC2086
    dispatch_to_pane "infra #$issue" "$issue" "$SCRIPT_DIR/iac-pipeline.sh" "$issue" $extra_args
}

cmd_scaffold() {
    local issue=""
    local domain=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --domain)
                domain="$2"; shift 2 ;;
            --domain=*)
                domain="${1#*=}"; shift ;;
            [0-9]*)
                issue="$1"; shift ;;
            *)
                abort "Argumento desconocido para --scaffold: $1" ;;
        esac
    done

    [ -n "$domain" ] || abort "Falta --domain para --scaffold. Uso: --scaffold [issue] --domain nombre"

    # Normalizar dominio a kebab-case (acepta PascalCase, camelCase, snake_case)
    domain=$(echo "$domain" \
        | sed 's/_/-/g' \
        | sed 's/\([a-z0-9]\)\([A-Z]\)/\1-\2/g' \
        | tr '[:upper:]' '[:lower:]')

    local args=()
    [ -n "$issue" ] && args+=("$issue")
    args+=(--domain "$domain")

    dispatch_to_pane "scaffold $domain" "${issue:-}" "$SCRIPT_DIR/scaffold-pipeline.sh" "${args[@]}"
}

cmd_batch() {
    local pipeline_override=""
    local issues=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --pipeline)
                pipeline_override="$2"; shift 2 ;;
            *)
                issues+=("$1"); shift ;;
        esac
    done

    if [ ${#issues[@]} -eq 0 ]; then
        abort "Debes especificar al menos un issue. Uso: --batch 42 43 44"
    fi

    local issues_csv
    issues_csv=$(IFS=','; echo "${issues[*]}")

    local args=()
    [ -n "$pipeline_override" ] && args+=(--pipeline "$pipeline_override")
    args+=("${issues[@]}")

    dispatch_to_pane "batch ${issues_csv}" "$issues_csv" "$SCRIPT_DIR/batch-pipeline.sh" "${args[@]}"
}

# --- Modo PARALELO (issue #705): un pane apilado por issue ---
#
# El primer issue reutiliza/crea el pane de ejecucion de la derecha; los demas
# se apilan con splits hacia abajo de alturas parejas. Cada pane corre el
# runner con el visor de SU issue; el escalonado (PARALLEL_STAGGER) espera
# dentro del pane via --delay, asi este despacho retorna de inmediato.
cmd_parallel() {
    local pipeline_override=""
    local issues=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --pipeline)
                pipeline_override="$2"; shift 2 ;;
            --max-parallel)
                warn "--max-parallel no aplica en modo herdr (cada issue corre en su propio pane). Para limitar concurrencia usa parallel-pipeline.sh directo."
                shift 2 ;;
            --max-parallel=*)
                warn "--max-parallel no aplica en modo herdr (cada issue corre en su propio pane). Para limitar concurrencia usa parallel-pipeline.sh directo."
                shift ;;
            *)
                issues+=("$1"); shift ;;
        esac
    done

    if [ ${#issues[@]} -eq 0 ]; then
        abort "Debes especificar al menos un issue. Uso: --parallel 42 43 44"
    fi

    # Pre-resolver cada issue: estado + tipo:projection + pipeline en UNA sola
    # llamada gh (resolve_issue_facts). Los no OPEN o sin pipeline se saltan
    # con aviso, igual que parallel-pipeline.sh.
    local resolved_issues=()
    local resolved_pipelines=()
    local projection_count=0
    local issue facts state rest is_projection resolved
    for issue in "${issues[@]}"; do
        if ! facts=$(resolve_issue_facts "$issue" "$pipeline_override"); then
            abort "Override de pipeline invalido: '$pipeline_override' (usa tdd|tooling)."
        fi
        state="${facts%%|*}"
        rest="${facts#*|}"
        is_projection="${rest%%|*}"
        resolved="${rest#*|}"

        if [ "$state" != "OPEN" ]; then
            warn "Issue #$issue esta $state --- saltando."
            continue
        fi
        if [[ "$resolved" == SKIP:* ]]; then
            warn "Issue #$issue saltado (${resolved#SKIP:}) --- no se abre pane."
            continue
        fi

        resolved_issues+=("$issue")
        resolved_pipelines+=("$(plugin_script "$resolved")")
        if [ "$is_projection" = "true" ]; then
            projection_count=$((projection_count + 1))
        fi
    done

    if [ ${#resolved_issues[@]} -eq 0 ]; then
        abort "No hay issues validos para procesar en paralelo."
    fi

    # Gate de projections: en modo pane no hay scheduler que las serialice y
    # todas comparten los archivos del worker de proyecciones del BC
    # (MEF-ADR-0034) -- dos a la vez producirian PRs pisandose entre si.
    if [ "$projection_count" -gt 1 ]; then
        abort "$projection_count issues tipo:projection en el lote: comparten el worker de proyecciones (MEF-ADR-0034) y en modo pane no se serializan entre si. Usa /sequential, o parallel-pipeline.sh directo (su scheduler si los serializa)."
    fi

    # Pane 1: el pane de ejecucion de la derecha (reutilizado o creado; los
    # libres sobrantes se colapsan ahi mismo, asi el apilado arranca de UNO).
    local panes=() prev
    prev=$(acquire_report_pane)
    panes+=("$prev")

    # Panes 2..N: apilados hacia abajo bajo el pane anterior, registrados en
    # PANES_STATE para heredar la reutilizacion/colapso post-corrida.
    local total=${#resolved_issues[@]}
    local k ratio resp pane
    for ((k = 1; k < total; k++)); do
        ratio=$(stack_split_ratio "$total" "$k")
        resp=$(herdr pane split --pane "$prev" --direction down --ratio "$ratio" --cwd "$PROJECT_ROOT" --no-focus 2>&1) \
            || abort "No se pudo crear el pane apilado $((k + 1))/$total (herdr pane split): $resp"
        pane=$(echo "$resp" | jq -r '.result.pane.pane_id // empty' 2>/dev/null)
        [ -n "$pane" ] || abort "herdr pane split no devolvio pane_id. Respuesta: $resp"
        echo "$pane $HERDR_RUNTIME" >> "$PANES_STATE"
        panes+=("$pane")
        prev="$pane"
    done

    # Confirmacion de arranque por pane apilado (issue #1563, CA-5): los
    # panes ya son todos nuevos (recien creados arriba), asi que un arranque
    # no confirmado no tiene a donde reintentar -- se acumula y se falla
    # visible al final, nombrando cada issue con su pane.
    local i pipeline_name title delay cmdline token marker
    local failed_confirm=()
    for i in "${!resolved_issues[@]}"; do
        issue="${resolved_issues[$i]}"
        pipeline_name=$(basename "${resolved_pipelines[$i]}" .sh)
        title="${pipeline_name%-pipeline} #$issue"
        delay=$((i * PARALLEL_STAGGER))

        token=$(next_dispatch_token)
        marker=$(dispatch_marker_path "$token")
        rm -f "$marker"
        cmdline=$(build_pane_runner_cmdline "$title" "$issue" "$delay" "$marker" "${resolved_pipelines[$i]}" "$issue")
        herdr pane run "${panes[$i]}" "$cmdline" >/dev/null 2>&1 \
            || abort "No se pudo lanzar el issue #$issue en el pane ${panes[$i]} (herdr pane run fallo)."

        if wait_for_dispatch_marker "$marker" "$HERDR_DISPATCH_CONFIRM_TIMEOUT" \
            || ! claim_dispatch_marker "$marker"; then
            if [ "$delay" -gt 0 ]; then
                log "Issue #$issue -> pane ${panes[$i]} ($title, arranca en ${delay}s)"
            else
                log "Issue #$issue -> pane ${panes[$i]} ($title)"
            fi
        else
            warn "Issue #$issue: el pane ${panes[$i]} no confirmo el arranque en ${HERDR_DISPATCH_CONFIRM_TIMEOUT}s (marcador ausente). Sin reintento (ya es un pane nuevo del lote): revisa/cierra ${panes[$i]} y relanza el issue #$issue a mano."
            failed_confirm+=("#$issue en el pane ${panes[$i]}")
        fi
    done

    if [ ${#failed_confirm[@]} -gt 0 ]; then
        local IFS_saved="$IFS" joined
        IFS=', '
        joined="${failed_confirm[*]}"
        IFS="$IFS_saved"
        abort "No se confirmo el arranque de ${#failed_confirm[@]} issue(s) del lote: $joined. Cierra esos paneles y relanzalos a mano."
    fi

    success "Pipeline paralelo corriendo: $total pane(s) apilados en este workspace, uno por issue."
    log "Cada pane muestra el visor en vivo de su issue; los reportes quedan en $LOG_DIR_ABS/."
    log "Los PRs NO se mergean automaticamente: usa /merge <PR_NUM> al terminar."
}

# cmd_collapse_panes (issue #799)
#
# Poda del registro los paneles muertos y CIERRA los libres sobrantes del
# propio workspace y runtime (dejando uno vivo) sin despachar ni crear ningun pane --
# la mitad de acquire_report_pane que no crea pane nuevo, compartida via
# prune_report_panes (CA-4). Pensado para que /merge lo invoque al terminar
# un lote --parallel: deja los paneles del lote mergeado colapsados de vuelta
# a uno, igual que ocurriria al despachar el proximo issue.
#
# Imprime por stdout SOLO la cantidad de paneles cerrados (entero, "0" si no
# hubo ninguno). Seguro fuera de contexto (CA-2): sin herdr/jq instalados, sin
# HERDR_ENV=1, sin HERDR_PANE_ID/HERDR_WORKSPACE_ID, sin pool canonico previo
# es un no-op que imprime "0" y sale 0 -- nunca aborta.
cmd_collapse_panes() {
    if [ "${HERDR_ENV:-}" != "1" ] \
        || [ -z "${HERDR_PANE_ID:-}" ] || [ -z "${HERDR_WORKSPACE_ID:-}" ] \
        || ! command -v herdr &>/dev/null || ! command -v jq &>/dev/null \
        || [ ! -f "$MEFISTO_STATE_DIR/herdr-report-panes.txt" ]; then
        echo "0"
        return 0
    fi

    # Best-effort: un runtime ausente, invalido o ambiguo no permite decidir
    # que pane pertenece a esta fila, asi que no modifica nada y conserva 0.
    if ! mefisto_resolve_runtime >/dev/null; then
        echo "0"
        return 0
    fi
    HERDR_RUNTIME="$MEFISTO_RESOLVED_RUNTIME"
    PANES_STATE="$(mefisto_state_path "herdr-report-panes.txt")" || {
        echo "0"
        return 0
    }

    local result closed
    result=$(prune_report_panes)
    closed=$(printf '%s' "$result" | sed -n '2p')
    echo "${closed:-0}"
}

# cmd_refresh_agents (issues #1333, #1335)
#
# Descubre los agentes interactivos del workspace y delega la estrategia de
# refresco en su adaptador. Este modo no despacha pipelines: fuera de contexto
# es un no-op silencioso para que los invocadores best-effort no deban detectar
# previamente el entorno Herdr.
refresh_agent_name() {
    local reported_name="$1" pane_id="$2" pane_slug
    if [ -n "$reported_name" ]; then
        printf '%s\n' "$reported_name"
        return
    fi

    # Los panes sin nombre corresponden a agentes arrancados a mano. El prefijo
    # garantiza la letra inicial; el slug deja el nombre dentro de los 32
    # caracteres admitidos por herdr.
    pane_slug=$(printf '%s' "$pane_id" \
        | tr '[:upper:]' '[:lower:]' \
        | sed 's/[^a-z0-9_-]/-/g' \
        | tr -s '-' \
        | sed 's/^-//; s/-$//' \
        | cut -c1-16 \
        | sed 's/-$//')
    [ -n "$pane_slug" ] || pane_slug="pane"
    printf 'mefisto-refresh-%s\n' "$pane_slug"
}

cmd_refresh_agents() {
    if [ "${HERDR_ENV:-}" != "1" ] \
        || [ -z "${HERDR_PANE_ID:-}" ] || [ -z "${HERDR_WORKSPACE_ID:-}" ] \
        || ! command -v herdr &>/dev/null || ! command -v jq &>/dev/null; then
        return 0
    fi

    local agents pane_id agent status agent_name adapter refresh_fn strategy action payload
    local restart_name exit_timeout deadline exit_timed_out
    exit_timeout="${MEFISTO_REFRESH_EXIT_TIMEOUT:-30}"
    [[ "$exit_timeout" =~ ^[0-9]+$ ]] || exit_timeout=30
    agents=$(herdr agent list 2>/dev/null) || return 0

    while IFS=$'\t' read -r pane_id agent status agent_name; do
        [ -n "$pane_id" ] || continue

        if [ "$pane_id" = "$HERDR_PANE_ID" ]; then
            printf '%s %s %s\n' "$pane_id" "$agent" "omitido:pane-propio"
            continue
        fi
        case "$status" in
            working|blocked)
                printf '%s %s omitido:%s\n' "$pane_id" "$agent" "$status"
                continue ;;
        esac

        case "$agent" in
            ''|*[!a-z0-9_]*)
                printf '%s %s %s\n' "$pane_id" "$agent" "omitido:sin-estrategia"
                continue ;;
        esac
        adapter="$RUNTIME_LIB_DIR/runtime-${agent}.sh"
        refresh_fn="runtime_${agent}_interactive_refresh"
        if [ ! -f "$adapter" ] \
            || ! strategy=$( ( source "$adapter" \
                && declare -F "$refresh_fn" >/dev/null 2>&1 \
                && "$refresh_fn" ) 2>/dev/null ); then
            printf '%s %s %s\n' "$pane_id" "$agent" "omitido:sin-estrategia"
            continue
        fi

        action="${strategy%% *}"
        payload="${strategy#* }"
        case "$action" in
            prompt)
                if [ "$payload" = "$strategy" ] || [ -z "$payload" ]; then
                    printf '%s %s %s\n' "$pane_id" "$agent" "omitido:sin-estrategia"
                elif herdr agent prompt "$pane_id" "$payload" >/dev/null 2>&1; then
                    printf '%s %s %s\n' "$pane_id" "$agent" "reload-enviado"
                else
                    printf '%s %s %s\n' "$pane_id" "$agent" "omitido:prompt-fallo"
                fi ;;
            restart)
                if [ "$payload" = "$strategy" ] || [ -z "$payload" ]; then
                    printf '%s %s %s\n' "$pane_id" "$agent" "omitido:sin-estrategia"
                    continue
                fi
                if ! herdr agent prompt "$pane_id" "$payload" >/dev/null 2>&1; then
                    printf '%s %s %s\n' "$pane_id" "$agent" "omitido:prompt-fallo"
                    continue
                fi
                deadline=$(( $(date +%s) + exit_timeout ))
                exit_timed_out=0
                while ! pane_is_free "$pane_id"; do
                    if [ "$(date +%s)" -ge "$deadline" ]; then
                        printf '%s %s %s\n' "$pane_id" "$agent" "omitido:no-salio"
                        exit_timed_out=1
                        break
                    fi
                    sleep 0.1
                done
                [ "$exit_timed_out" -eq 0 ] || continue
                restart_name=$(refresh_agent_name "$agent_name" "$pane_id")
                if herdr agent start "$restart_name" --kind "$agent" --pane "$pane_id" >/dev/null 2>&1; then
                    printf '%s %s %s\n' "$pane_id" "$agent" "reiniciado"
                else
                    printf '%s %s %s\n' "$pane_id" "$agent" "omitido:relanzamiento-fallo"
                fi ;;
            *)
                printf '%s %s %s\n' "$pane_id" "$agent" "omitido:sin-estrategia" ;;
        esac
    done < <(printf '%s' "$agents" | jq -r \
        --arg workspace "$HERDR_WORKSPACE_ID" --arg cwd "$PROJECT_ROOT" '
            .result.agents[]
            | select(.workspace_id == $workspace and .cwd == $cwd)
            | [(.pane_id // ""), (.agent // ""), (.agent_status // ""), (.name // "")] | @tsv
        ' 2>/dev/null)
}

cmd_help() {
    cat <<EOF

${CYAN}${BOLD}herdr-pipeline.sh${NC} --- Interfaz herdr de los pipelines publicados

${BOLD}Uso (misma superficie que launch-pipeline.sh):${NC}
  herdr-pipeline.sh 42                                   Issue unico (enruta por label)
  herdr-pipeline.sh 42 --from-stage 3                    Retomar issue #42 desde Stage 3
  herdr-pipeline.sh --pipeline tooling 42                Forzar pipeline tooling
  herdr-pipeline.sh --tooling 42                         Issue de tooling
  herdr-pipeline.sh --tooling 42 --models 'reviewer=opus'  Modelo por stage (experimentos)
  herdr-pipeline.sh 42 --models 'reviewer=opus,test-writer=sonnet'  Idem, enrutando por label a tdd-pipeline.sh
  herdr-pipeline.sh --tooling 42 --variant experimento-a Corrida paralela del mismo issue (sin PR, rama local)
  herdr-pipeline.sh 42 --variant a --models 'test-writer=sonnet'  Idem, enrutando por label a tdd-pipeline.sh
  herdr-pipeline.sh --infra 42                           Issue de infraestructura (IaC)
  herdr-pipeline.sh --scaffold 42 --domain nombre        Scaffold de dominio
  herdr-pipeline.sh --batch 42 43 44                     Secuencial
  herdr-pipeline.sh --parallel 42 43                     Paralelo: un pane apilado por issue
  herdr-pipeline.sh --collapse-panes                     Poda paneles libres sobrantes sin despachar (usado por /merge)
  herdr-pipeline.sh --refresh-agents                     Refresca los agentes interactivos del workspace

${BOLD}Que hace:${NC}
  Reutiliza (o crea) un pane de ejecucion en el workspace herdr actual: el
  pipeline corre en background con su reporte a un log y el pane muestra el
  visor en vivo (stream-watch.sh) del agente en curso, un solo pane para toda
  la secuencia de agentes del issue. Si el pane sigue ocupado con otra
  corrida, se abre un pane adicional; los libres se reutilizan.

  Con --parallel, cada issue corre en su propio pane apilado bajo el pane de
  ejecucion (alturas parejas, visor por issue, arranques escalonados de 30s
  dentro de cada pane). Un lote con dos o mas issues tipo:projection se
  rechaza: usa /sequential o parallel-pipeline.sh, que si los serializa.

${BOLD}Requisitos:${NC} correr dentro de un pane herdr (HERDR_ENV=1) y jq.
  Fuera de herdr usa launch-pipeline.sh, que ademas autodetecta herdr y delega
  aqui solo cuando aplica (para correr sin panes: MEFISTO_UI=mod).

EOF
}

# --- Entrypoint ---
main() {
    if [ $# -eq 0 ]; then
        cmd_help
        exit 0
    fi

    # El runner interno se despacha antes del pre-parseo: sus argumentos
    # (--title, el comando tras --) no deben pasar por los filtros de modos.
    if [ "$1" = "--_pane-runner" ]; then
        shift
        cmd_pane_runner "$@"
        exit $?
    fi

    # --collapse-panes (issue #799) tampoco pasa por el pre-parseo: no toma
    # argumentos posicionales y el pre-parseo aborta si no queda ninguno.
    if [ "$1" = "--collapse-panes" ]; then
        shift
        cmd_collapse_panes
        exit $?
    fi

    # --refresh-agents tampoco pasa por el pre-parseo: no toma argumentos
    # posicionales y solo opera best-effort sobre panes ya existentes.
    if [ "$1" = "--refresh-agents" ]; then
        shift
        cmd_refresh_agents
        exit $?
    fi

    # Pre-parseo identico a launch-pipeline.sh: --scaffold-domain, --pipeline,
    # --from-stage, --models y --variant se extraen de cualquier posicion.
    local scaffold_extra=""
    local pipeline_override=""
    local from_stage_extra=""
    local models_spec=""
    local variant_spec=""
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
                # Sin este caso, --models caeria en filtered_args y el dispatch
                # de --tooling (que solo reenvia "$1") lo descartaria EN
                # SILENCIO: la corrida usaria los modelos default mientras el
                # operador cree que el override del experimento se aplico
                # (issue #708). A diferencia de launch-pipeline.sh, aqui el valor
                # se guarda crudo: el pane no lo re-parsea con un shell, viaja
                # como argv quoteado con printf %q.
                [ $# -lt 2 ] && abort "Falta el valor de --models"
                models_spec="$2"
                shift 2
                ;;
            --variant)
                # Mismo criterio que --models arriba: sin este caso, --variant
                # caeria en filtered_args y el dispatch de --tooling (que solo
                # reenvia "$1" + los extras conocidos) lo descartaria EN
                # SILENCIO (issue #710).
                [ $# -lt 2 ] && abort "Falta el valor de --variant"
                variant_spec="$2"
                shift 2
                ;;
            --if-exists)
                abort "--attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5). En herdr una corrida concurrente abre un pane adicional."
                ;;
            *)
                filtered_args+=("$1")
                shift
                ;;
        esac
    done
    if [ ${#filtered_args[@]} -gt 0 ]; then
        set -- "${filtered_args[@]}"
    else
        abort "Faltan argumentos posicionales (numero de issue o modo). Corre '$0 --help' para ver el uso."
    fi

    case "$1" in
        --help|-h)
            cmd_help
            ;;
        --attach)
            abort "En herdr no hay attach: los panes de ejecucion viven en el workspace del proyecto. Abrilo desde la barra lateral de herdr (o corre 'herdr' para adjuntar al servidor)."
            ;;
        --parallel)
            shift
            [ $# -eq 0 ] && abort "Debes especificar al menos un issue. Uso: --parallel 42 43 44"
            [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue."
            [ -n "$models_spec" ] && abort "--models no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'"
            [ -n "$variant_spec" ] && abort "--variant no es valido con --parallel (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --variant <label>"
            require_herdr_context
            if [ -n "$pipeline_override" ]; then
                cmd_parallel --pipeline "$pipeline_override" "$@"
            else
                cmd_parallel "$@"
            fi
            ;;
        --tooling)
            shift
            require_herdr_context
            [ $# -eq 0 ] && abort "Debes especificar un issue. Uso: --tooling 42"
            cmd_tooling "$1" "$from_stage_extra" "$models_spec" "$variant_spec"
            ;;
        --infra)
            shift
            [ -n "$models_spec" ] && abort "--models todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'"
            [ -n "$variant_spec" ] && abort "--variant todavia no es valido con --infra (iac-pipeline.sh no implementa el flag). Usalo con --tooling: herdr-pipeline.sh --tooling <issue> --variant <label>"
            require_herdr_context
            [ $# -eq 0 ] && abort "Debes especificar un issue. Uso: --infra 42"
            cmd_infra "$1" "$from_stage_extra"
            ;;
        --scaffold)
            shift
            [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con --scaffold (scaffold-pipeline.sh no tiene stages retomables)."
            [ -n "$models_spec" ] && abort "--models no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag)."
            [ -n "$variant_spec" ] && abort "--variant no es valido con --scaffold (scaffold-pipeline.sh no implementa el flag)."
            require_herdr_context
            cmd_scaffold "$@"
            ;;
        --batch)
            shift
            [ $# -eq 0 ] && abort "Debes especificar al menos un issue. Uso: --batch 42 43 44"
            [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue."
            [ -n "$models_spec" ] && abort "--models no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'"
            [ -n "$variant_spec" ] && abort "--variant no es valido con --batch (seria ambiguo sobre varios issues). Usalo con un unico issue: herdr-pipeline.sh --tooling <issue> --variant <label>"
            require_herdr_context
            if [ -n "$pipeline_override" ]; then
                cmd_batch --pipeline "$pipeline_override" "$@"
            else
                cmd_batch "$@"
            fi
            ;;
        [0-9]*)
            if [ $# -gt 1 ]; then
                [ -n "$from_stage_extra" ] && abort "--from-stage no es valido con multiples issues (se interpretaria como --parallel). Especifica un unico issue."
                [ -n "$models_spec" ] && abort "--models no es valido con multiples issues (se interpretaria como --parallel). Usa: herdr-pipeline.sh --tooling <issue> --models 'agente=modelo'"
                [ -n "$variant_spec" ] && abort "--variant no es valido con multiples issues (se interpretaria como --parallel). Usa: herdr-pipeline.sh --tooling <issue> --variant <label>"
                warn "Multiples issues sin modo especificado. Usando --parallel."
                require_herdr_context
                if [ -n "$pipeline_override" ]; then
                    cmd_parallel --pipeline "$pipeline_override" "$@"
                else
                    cmd_parallel "$@"
                fi
            else
                # El enrutamiento automatico (sin --tooling explicito) resuelve
                # a tdd-pipeline.sh o tooling-pipeline.sh (issues #712/#713:
                # ambos ya implementan --models y --variant) -- mismo criterio
                # que launch-pipeline.sh.
                require_herdr_context
                local combined_extra="$scaffold_extra"
                if [ -n "$from_stage_extra" ]; then
                    if [ -n "$combined_extra" ]; then
                        combined_extra="$combined_extra $from_stage_extra"
                    else
                        combined_extra="$from_stage_extra"
                    fi
                fi
                cmd_single "$1" "$combined_extra" "$pipeline_override" "$models_spec" "$variant_spec"
            fi
            ;;
        *)
            echo -e "${RED}Argumento desconocido: $1${NC}" >&2
            cmd_help
            exit 1
            ;;
    esac
}

main "$@"
