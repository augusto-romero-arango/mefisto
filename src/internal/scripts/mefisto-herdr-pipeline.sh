#!/usr/bin/env bash
# mefisto-herdr-pipeline.sh --- Interfaz herdr de los pipelines INTERNOS de
# Mefisto (porte del publicado scripts/herdr-pipeline.sh, issue #690)
#
# Implementacion CANONICA (MEF-ADR-0049 decision 2, issue #872). El shim de
# compatibilidad .claude/scripts/mefisto-herdr-pipeline.sh reenvia aqui via
# `exec` (plantilla documentada en src/internal/scripts/README.md); invocar
# por cualquiera de las dos rutas es equivalente.
#
# Uso (misma superficie de modos que mefisto-launch-pipeline.sh):
#   src/internal/scripts/mefisto-herdr-pipeline.sh --tooling 42 [--from-stage N]
#   src/internal/scripts/mefisto-herdr-pipeline.sh --tooling 42 --models 'reviewer=<modelo>'
#   src/internal/scripts/mefisto-herdr-pipeline.sh --tooling 42 --variant experimento-a
#   src/internal/scripts/mefisto-herdr-pipeline.sh --batch 42 43 44
#
# Esta interfaz trabaja DENTRO del workspace herdr actual: reutiliza (o crea
# con `herdr pane split`) un pane de ejecucion al lado del pane que despacha,
# corre el sub-pipeline en background con su reporte a un log, y muestra en
# el mismo pane -- intercalados -- el visor en vivo (mefisto-stream-watch.sh,
# #434 -- su neutralizacion de fuente de datos fue #878, su traslado de
# ubicacion no es parte de ningun issue: sigue en .claude/scripts/) que sigue
# al agente en curso, y un `tail -f` del .report.log que muestra en vivo los
# hitos del propio pipeline -- creacion/merge de PR, resumen final -- que el
# visor no cubre (issue #926). Un solo pane para toda la secuencia de agentes
# del issue Y sus hitos de entrega. Al terminar, el pane muestra solo el
# banner final y la ruta del .report.log completo: ya se vio todo en vivo.
#
# Una corrida concurrente abre un pane adicional y los panes libres
# se reutilizan, con la misma deteccion que el publicado (`herdr pane
# process-info`: foreground_process_group_id == shell_pid).
#
# Confirmacion de arranque (issue #1563, porte #1571): tras teclear el runner
# en un pane, quien despacha espera el marcador herdr-dispatch-<token>.started
# (bajo el estado del pipeline) hasta HERDR_DISPATCH_CONFIRM_TIMEOUT segundos
# (default 15) antes de anunciar exito -- `herdr pane run` devolver 0 solo
# confirma que el texto se tecleo, nunca que el shell lo ejecuto (certificacion
# v0.38.2 del publicado: un pane reutilizado con bracketed paste sin cerrar
# hizo que la linea entera se interpretara como "bad pattern" y --_pane-runner
# jamas arrancara, reportado igual como lanzado). Sin confirmacion, el
# despacho reintenta UNA vez en un pane NUEVO (nunca el sospechoso) y, si
# tampoco confirma, falla nombrando ambos paneles. Al agotar el plazo el
# despachador reclama el marcador (creacion exclusiva): un runner que arranque
# tarde en el pane sospechoso lo encuentra ya reclamado y aborta sin lanzar
# nada, asi el reintento nunca duplica una corrida (MEF-ADR-0017). El interno
# no tiene modo paralelo (solo --tooling y --batch, ambos via
# dispatch_to_pane): un unico punto de despacho cubre el mecanismo completo.
#
# Requiere correr dentro de un pane herdr (HERDR_ENV=1): la autodeteccion
# vive en mefisto-launch-pipeline.sh, que delega aqui cuando aplica y corre
# desacoplado cuando no.
#
# Solo se ejecuta dentro del repo de Mefisto (assert_in_mefisto).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/_mefisto-common.sh"
assert_in_mefisto || exit 1

# Runtime activo (MEF-ADR-0049, issue #928): el pool de panes de reporte usa
# el runtime como parte de su clave -- dos filas de runtime del mismo
# workspace ya no pueden compartir ni robarse panes libres entre si. Mismo
# resolutor canonico que mefisto-tooling-pipeline.sh (mefisto_resolve_runtime,
# nunca un default literal en esta capa neutral).
# Discovery comun; este lanzador conserva solo la orquestacion interna de panes.
source "$(cd "$SCRIPT_DIR/../../runtime/lib" && pwd)/mefisto-runtime.sh"

# --- Colores ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_ROOT="$MEFISTO_REPO_ROOT"
# Estado neutral a runtime (MEF-ADR-0049, issue #872): logs y el registro de
# panes resuelven contra MEFISTO_STATE_DIR (".mefisto/pipeline/", exportada
# por mefisto-state.sh via _mefisto-common.sh), el mismo canonico que usa
# mefisto-tooling-pipeline.sh/mefisto-batch-pipeline.sh para escribir --
# nunca una ruta compuesta a mano con el prefijo legacy previo a la migracion.
LOG_DIR_ABS="$(mefisto_state_path "logs")"
# CAFF: prefijo "caffeinate -i" (o vacio fuera de macOS), calculado UNA vez
# por corrida y antepuesto al lanzamiento en background del sub-pipeline
# interno dentro de cmd_pane_runner -- issue #800. Evita que el Mac entre en
# suspension idle mientras el pane de ejecucion corre.
CAFF="$(caffeinate_prefix)"
# Registro de panes de ejecucion creados por esta interfaz (uno por linea,
# ids publicos de herdr como "w1:p3"). Vive junto al resto del estado runtime,
# donde lo deja mefisto_state_path (.mefisto/pipeline/, issue #869).
PANES_STATE="$(mefisto_state_path "herdr-report-panes.txt")"
# Runtime resuelto de ESTA corrida (issue #1571): lo cachea resolve_report_runtime,
# invocada por dispatch_to_pane en su propio shell, para que split_new_report_pane
# (el reintento de dispatch_to_pane, CA-3) pueda crear un pane nuevo del MISMO
# runtime sin volver a resolverlo.
HERDR_RUNTIME=""
# Confirmacion de arranque tras teclear el comando en un pane (issue #1563,
# porte #1571): `herdr pane run` devuelve 0 en cuanto el texto se tecleo, no
# cuando el shell del pane lo ejecuto -- un pane reutilizado puede haber
# quedado en un modo de terminal invalido (bracketed paste sin cerrar del
# ocupante anterior, certificacion v0.38.2 del publicado: la linea entera se
# interpreto como "bad pattern" y --_pane-runner jamas arranco).
# cmd_pane_runner escribe un marcador de arranque ANTES de lanzar el
# sub-pipeline; quien despacha lo espera hasta este timeout (configurable)
# antes de anunciar exito.
HERDR_DISPATCH_CONFIRM_TIMEOUT="${HERDR_DISPATCH_CONFIRM_TIMEOUT:-15}"
# Contador de despachos de ESTA corrida: junto al timestamp y el PID arma un
# token unico por marcador (dos despachos en el mismo segundo no colisionan).
DISPATCH_TOKEN_SEQ=0
# ENV_PREFIX: mismo criterio que mefisto-launch-pipeline.sh (issue #871, CA-2).
# El pane que corre --_pane-runner nace de un shell YA VIVO del workspace
# herdr (`herdr pane run` solo teclea una linea ahi): no hereda el entorno
# del proceso que despacha. MEFISTO_RUNTIME/MEFISTO_MODELS_FILE viajan como
# asignaciones de entorno antepuestas a la invocacion (dispatch_to_pane), para
# que lleguen al sub-pipeline canonico que corre dentro de cmd_pane_runner.
# Solo se agregan si estan fijadas -- un valor vacio en el pane cambiaria el
# comportamiento (autodeteccion) respecto de no fijarlo. printf %q escapa el
# valor como DATO, nunca se re-emite tal cual (CA-4: sobrevive un id de
# runtime u orden con espacios/comillas).
ENV_PREFIX=""
[ -n "${MEFISTO_RUNTIME:-}" ] && ENV_PREFIX="${ENV_PREFIX}MEFISTO_RUNTIME=$(printf '%q' "$MEFISTO_RUNTIME") "
[ -n "${MEFISTO_MODELS_FILE:-}" ] && ENV_PREFIX="${ENV_PREFIX}MEFISTO_MODELS_FILE=$(printf '%q' "$MEFISTO_MODELS_FILE") "

# Los mensajes de progreso van a stderr: acquire_report_pane devuelve su
# resultado por stdout y un log colado ahi corromperia el valor capturado.
log()     { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1" >&2; }
success() { echo -e "${GREEN}${BOLD}v${NC} $1" >&2; }
warn()    { echo -e "${YELLOW}!${NC} $1" >&2; }
abort()   { echo -e "\n${RED}${BOLD}x $1${NC}" >&2; exit 1; }

# --- Guard de contexto herdr ---
require_herdr_context() {
    command -v herdr &>/dev/null \
        || abort "herdr no esta instalado (https://herdr.dev). Fuera de herdr lanza con mefisto-launch-pipeline.sh sin MEFISTO_UI=herdr (modo desacoplado)."
    [ "${HERDR_ENV:-}" = "1" ] \
        || abort "No estas dentro de un pane de herdr (HERDR_ENV != 1). Fuera de herdr lanza con mefisto-launch-pipeline.sh sin MEFISTO_UI=herdr (modo desacoplado)."
    [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_WORKSPACE_ID:-}" ] \
        || abort "Faltan HERDR_PANE_ID/HERDR_WORKSPACE_ID en el entorno (los inyecta herdr en cada pane)."
    command -v jq &>/dev/null \
        || abort "La interfaz herdr requiere jq para leer las respuestas del socket API. Instala jq o usa MEFISTO_UI=mod."
}

# assert_pane_ownership
#
# Issue #2284: HERDR_PANE_ID puede ser heredado y ajeno (un daemon o un proceso
# lanzado desde otro pane lo arrastra). Antes de cualquier herdr pane
# split/run/close se exige que este proceso descienda del shell_pid que herdr
# reporta para ese pane; si no, aborta sin tocar ningun pane.
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

# --- Helpers de panes (mismo contrato que scripts/herdr-pipeline.sh) ---

pane_exists() {
    herdr pane get "$1" >/dev/null 2>&1
}

# pane_is_free <pane_id>
#
# 0 si el pane esta en su prompt interactivo, sin comando en foreground.
# Cualquier fallo de consulta se trata como "no libre" (conservador: nunca
# se teclea sobre una corrida).
pane_is_free() {
    local id="$1"
    local info fg sh
    info=$(herdr pane process-info --pane "$id" 2>/dev/null) || return 1
    fg=$(echo "$info" | jq -r '.result.process_info.foreground_process_group_id // empty' 2>/dev/null)
    sh=$(echo "$info" | jq -r '.result.process_info.shell_pid // empty' 2>/dev/null)
    [ -n "$fg" ] && [ -n "$sh" ] && [ "$fg" = "$sh" ]
}

# resolve_report_runtime
#
# Resuelve una vez por corrida el runtime activo y lo cachea en HERDR_RUNTIME
# (issue #1571): acquire_report_pane la invoca antes de tocar el pool; el
# reintento de dispatch_to_pane (split_new_report_pane, CA-3) reutiliza el
# valor ya cacheado sin resolver de nuevo.
#
# Misma forma que mefisto-tooling-pipeline.sh, con una vuelta extra en el
# camino de error: $(...) corre en un subshell, asi que la asignacion a
# MEFISTO_RUNTIME_ERROR que el resolutor hace al fallar se pierde al salir.
# Repetir la llamada en ESTE shell -- solo cuando ya se sabe que fallo -- fija
# el motivo aqui, para que abort() muestre la causa y no un texto vacio. El
# camino feliz resuelve una sola vez.
resolve_report_runtime() {
    [ -n "$HERDR_RUNTIME" ] && return 0

    local runtime
    if ! runtime=$(mefisto_resolve_runtime); then
        mefisto_resolve_runtime >/dev/null 2>&1 || true
        abort "No se pudo resolver el runtime activo: $MEFISTO_RUNTIME_ERROR"
    fi
    HERDR_RUNTIME="$runtime"
}

# split_new_report_pane
#
# Crea un pane de ejecucion NUEVO (split a la derecha del pane que despacha,
# sin robar el foco) y lo registra en PANES_STATE con el runtime ya resuelto
# por resolve_report_runtime. Compartido por acquire_report_pane (cuando no
# hay ninguno libre) y por dispatch_to_pane cuando el reintento de arranque
# (CA-3, issue #1563/#1571) exige un pane que NUNCA se tecleo antes -- nunca
# el pane sospechoso de un arranque no confirmado.
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
# pane registrado que siga vivo, pertenezca a ESTE workspace, sea del MISMO
# runtime que esta corrida y este libre; o uno nuevo (split_new_report_pane).
# De paso poda del registro los panes que ya no existen y CIERRA los panes
# libres sobrantes -- del mismo runtime, de corridas concurrentes ya
# terminadas: cada fila de runtime (MEF-ADR-0049, issue #928) colapsa de
# vuelta a UN solo pane de seguimiento propio, sin tocar ni cerrar los panes
# libres de la otra fila (el reporte de cada corrida pasada sigue en su
# .report.log).
#
# El pool guarda una linea "<pane_id> <runtime>" por pane (issue #928 CA-2):
# el runtime de ESTA corrida se resuelve ANTES de tocar el archivo (CA-1) --
# una resolucion fallida (p. ej. ambos CLIs instalados sin MEFISTO_RUNTIME)
# aborta sin ningun herdr pane split/run/close y sin modificar el pool. Las
# lineas legacy sin clave (anteriores a este issue) se descartan del registro
# al primer barrido, sin cerrar su pane -- costo unico de migracion, conservador
# (CA-5): no hay forma de saber a que runtime pertenecian.
acquire_report_pane() {
    assert_pane_ownership
    resolve_report_runtime
    local runtime="$HERDR_RUNTIME"

    mkdir -p "$(dirname "$PANES_STATE")"
    touch "$PANES_STATE"

    local kept="" chosen="" line id pane_runtime
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
            *' '*)
                id="${line%% *}"
                pane_runtime="${line#* }"
                ;;
            *)
                continue ;;
        esac
        pane_exists "$id" || continue
        case "$id" in
            "$HERDR_WORKSPACE_ID:"*) ;;
            *)
                kept="${kept}${line}
"
                continue ;;
        esac
        if [ "$pane_runtime" != "$runtime" ]; then
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
# un arranque nuevo (issue #1563, porte #1571).
next_dispatch_token() {
    DISPATCH_TOKEN_SEQ=$((DISPATCH_TOKEN_SEQ + 1))
    printf '%s-%s-%s\n' "$(date +%s)" "$$" "$DISPATCH_TOKEN_SEQ"
}

# dispatch_marker_path <token>
#
# Ruta del marcador de arranque bajo el estado canonico del pipeline (issue
# #1563, porte #1571, CA-1): cmd_pane_runner lo escribe ANTES de lanzar el
# sub-pipeline; quien despacha solo lo lee, nunca lo crea.
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

# build_pane_runner_cmdline <titulo> <issues_csv> <started_marker> <cmd> [args...]
#
# Imprime por stdout la linea que el pane debe ejecutar para correr el runner
# interno (--_pane-runner) con <cmd args...>. Todo argumento va quoteado con
# printf %q: el pane run literalmente escribe la linea en el shell del pane.
# <started_marker> es la ruta que cmd_pane_runner escribe antes de lanzar el
# sub-pipeline (issue #1563, porte #1571, CA-1).
build_pane_runner_cmdline() {
    local title="$1" issues_csv="$2" started_marker="$3"
    shift 3

    local cmdline
    cmdline="cd $(printf '%q' "$PROJECT_ROOT") && ${ENV_PREFIX}$(printf '%q' "$SCRIPT_DIR/mefisto-herdr-pipeline.sh") --_pane-runner --title $(printf '%q' "$title")"
    if [ -n "$issues_csv" ]; then
        cmdline="$cmdline --issues $(printf '%q' "$issues_csv")"
    fi
    cmdline="$cmdline --started-marker $(printf '%q' "$started_marker") --"
    local a
    for a in "$@"; do
        cmdline="$cmdline $(printf '%q' "$a")"
    done
    echo "$cmdline"
}

# dispatch_to_pane <titulo> <issues_csv> <cmd> [args...]
#
# Consigue un pane libre y le teclea (herdr pane run) la invocacion del
# runner interno (--_pane-runner), que corre <cmd args...> en background.
#
# Confirmacion de arranque (issue #1563, porte #1571, CA-2/CA-3/CA-4): `herdr
# pane run` devolviendo 0 solo confirma que el texto se tecleo, nunca que el
# shell del pane lo ejecuto. Se espera el marcador de cmd_pane_runner hasta
# HERDR_DISPATCH_CONFIRM_TIMEOUT; si no aparece, se reintenta UNA vez en un
# pane nuevo (split, jamas el sospechoso) y si tampoco confirma se falla
# visible nombrando ambos panes -- ninguno de los dos se cierra solo (podrian
# tener salida util para diagnostico).
dispatch_to_pane() {
    local title="$1" issues_csv="$2"
    shift 2

    # Resolver el runtime en ESTE shell (no dentro de $(acquire_report_pane),
    # cuyo subshell pierde la cache al salir): el reintento de CA-3 registra su
    # pane nuevo con HERDR_RUNTIME y, sin esto, lo anotaria sin runtime.
    resolve_report_runtime

    local pane token marker cmdline
    pane=$(acquire_report_pane)
    token=$(next_dispatch_token)
    marker=$(dispatch_marker_path "$token")
    rm -f "$marker"
    cmdline=$(build_pane_runner_cmdline "$title" "$issues_csv" "$marker" "$@")

    herdr pane run "$pane" "$cmdline" >/dev/null 2>&1 \
        || abort "No se pudo lanzar el pipeline en el pane $pane (herdr pane run fallo)."

    if wait_for_dispatch_marker "$marker" "$HERDR_DISPATCH_CONFIRM_TIMEOUT" \
        || ! claim_dispatch_marker "$marker"; then
        success "Pipeline '$title' corriendo en el pane $pane de este workspace."
        log "El pane muestra en vivo el visor del agente y el stdout del pipeline; el reporte completo queda en $LOG_DIR_ABS/."
        log "No hay sesion que adjuntar: el pane ya esta visible en el workspace (barra lateral de herdr)."
        return 0
    fi

    warn "El pane $pane no confirmo el arranque en ${HERDR_DISPATCH_CONFIRM_TIMEOUT}s (marcador ausente): puede tener el shell en un estado invalido. Reintentando en un pane nuevo, sin volver a escribir en $pane."

    local retry_pane retry_token retry_marker retry_cmdline
    retry_pane=$(split_new_report_pane)
    retry_token=$(next_dispatch_token)
    retry_marker=$(dispatch_marker_path "$retry_token")
    rm -f "$retry_marker"
    retry_cmdline=$(build_pane_runner_cmdline "$title" "$issues_csv" "$retry_marker" "$@")

    herdr pane run "$retry_pane" "$retry_cmdline" >/dev/null 2>&1 \
        || abort "No se pudo lanzar el pipeline en el pane de reintento $retry_pane (herdr pane run fallo). Pane sospechoso original: $pane."

    if wait_for_dispatch_marker "$retry_marker" "$HERDR_DISPATCH_CONFIRM_TIMEOUT" \
        || ! claim_dispatch_marker "$retry_marker"; then
        success "Pipeline '$title' corriendo en el pane $retry_pane de este workspace (reintento tras un arranque no confirmado en $pane)."
        log "El pane muestra en vivo el visor del agente y el stdout del pipeline; el reporte completo queda en $LOG_DIR_ABS/."
        log "No hay sesion que adjuntar: el pane ya esta visible en el workspace (barra lateral de herdr)."
        return 0
    fi

    abort "Ni el pane $pane ni el reintento $retry_pane confirmaron el arranque de '$title' en ${HERDR_DISPATCH_CONFIRM_TIMEOUT}s. Cierra ambos paneles (alguno de los dos shells puede seguir en un estado invalido) y relanza el pipeline a mano."
}

# --- Runner interno (corre DENTRO del pane de ejecucion) ---
#
# mefisto-herdr-pipeline.sh --_pane-runner --title <t> [--issues <csv>]
#                            [--started-marker <path>] -- <cmd> [args...]
#
# Mismo ciclo que el runner publicado: renombra el pane, lanza <cmd> en
# background con stdout+stderr al reporte, muestra el visor filtrado a los
# issues de ESTA corrida y a streams nacidos despues de ahora, y en paralelo
# sigue en vivo el propio .report.log con `tail -f` (issue #926) -- asi los
# hitos del pipeline (PR creado, merge, resumen) se ven en el pane mientras
# corre, no solo al final. Al terminar corta el visor y el tail, imprime el
# banner final y renombra el pane [ok]/[fallo].
#
# Si recibio --started-marker, lo crea en exclusiva de inmediato -- ANTES de
# cualquier otro paso -- para confirmar que el shell del pane ejecuto esta
# linea (issue #1563, porte #1571, CA-1); quien despacha lo espera con un
# timeout corto (HERDR_DISPATCH_CONFIRM_TIMEOUT) antes de anunciar exito.
cmd_pane_runner() {
    local title="" issues_csv="" started_marker=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --title)
                [ $# -lt 2 ] && abort "Falta el valor de --title"
                title="$2"; shift 2 ;;
            --issues)
                [ $# -lt 2 ] && abort "Falta el valor de --issues"
                issues_csv="$2"; shift 2 ;;
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

    # Paso 0: confirmar el arranque antes que nada mas (issue #1563, porte
    # #1571, CA-1). Creacion exclusiva: si el archivo ya existe, el
    # despachador lo reclamo al agotar el plazo y ya reintento en otro pane --
    # arrancar aqui duplicaria la corrida (MEF-ADR-0017).
    if [ -n "$started_marker" ]; then
        mkdir -p "$(dirname "$started_marker")" 2>/dev/null || true
        if ! ( set -C; : > "$started_marker" ) 2>/dev/null; then
            abort "Este pane arranco despues del plazo de confirmacion ($started_marker ya reclamado por el despachador): no se lanza nada para no duplicar la corrida. Cierra este pane."
        fi
    fi

    mkdir -p "$LOG_DIR_ABS"
    local ts report_log
    ts=$(date +%Y%m%d-%H%M%S)
    report_log="$LOG_DIR_ABS/mefisto-herdr-run-$ts-$$.report.log"

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

    local start_epoch
    start_epoch=$(date +%s)

    # El pipeline y TODOS sus descendientes (el runner del runtime activo,
    # gates que corren los tests del repo) arrancan con las variables HERDR_*
    # removidas:
    # con HERDR_ENV=1 heredado del pane, cualquier invocacion de
    # launch-pipeline.sh o mefisto-launch-pipeline.sh a lo largo de la corrida
    # (p. ej. las fixtures de test-launch-preparse.sh, corridas por el gate del
    # writer de un issue de Mefisto) autodetectaria herdr y crearia panes
    # REALES en el workspace del humano (visto en vivo durante la corrida del
    # issue #679). El runner conserva su propio entorno -- el rename final
    # usa HERDR_PANE_ID -- solo el hijo corre aislado. El array arranca con
    # un -u fijo para nunca expandirse vacio (bash 3.2 revienta con "unbound
    # variable" al expandir un array vacio bajo `set -u`).
    local env_unset=(-u HERDR_ENV)
    local v
    while IFS='=' read -r v _; do
        case "$v" in
            HERDR_*) env_unset+=(-u "$v") ;;
        esac
    done < <(env)

    # Se pre-crea el archivo ANTES de lanzar el pipeline en background: el
    # `tail -f` de abajo arranca inmediatamente despues y necesita que el
    # archivo ya exista para no fallar con "No such file" por una carrera
    # contra el fork del pipeline (issue #926).
    : > "$report_log"

    # $CAFF se expande sin comillas a proposito (0 o 2 palabras, "caffeinate -i"):
    # aplica el prefijo sin duplicar el lanzamiento en una rama if/else por cada
    # valor posible (issue #800). caffeinate exec-a el comando en su lugar (ver
    # caffeinate_prefix), asi que $! sigue siendo el PID del pipeline: el trap,
    # el wait y el rc de abajo conservan su semantica.
    # shellcheck disable=SC2086
    $CAFF env "${env_unset[@]}" "$@" >"$report_log" 2>&1 &
    local pipe_pid=$!

    # tail -f en vivo del propio .report.log (issue #926): el visor cubre la
    # actividad del agente, pero los hitos del pipeline (creacion/merge de PR,
    # resumen final) solo se escriben ahi, nunca al stream que lee el visor.
    # Se elige tail -f sobre tee/un pipe para no alterar $!/wait/rc y no
    # depender de que todos los descendientes del pipeline cierren su stdout.
    tail -n +1 -f "$report_log" &
    local tail_pid=$!

    local viewer_pid=""
    # El visor todavia vive en .claude/scripts/ (su neutralizacion de fuente
    # de datos fue #878; su traslado de ubicacion no es parte de este issue),
    # asi que se invoca por su ruta explicita en vez de via SCRIPT_DIR.
    if [ -n "$issues_csv" ]; then
        "$PROJECT_ROOT/.claude/scripts/mefisto-stream-watch.sh" --issues "$issues_csv" --newer-than "$start_epoch" &
    else
        "$PROJECT_ROOT/.claude/scripts/mefisto-stream-watch.sh" --newer-than "$start_epoch" &
    fi
    viewer_pid=$!

    # Ctrl+C en el pane ya llega a pipeline, tail y visor (comparten el grupo
    # de foreground); el trap solo asegura la limpieza y deja constancia.
    trap '
        kill '"$pipe_pid"' 2>/dev/null || true
        kill '"$tail_pid"' 2>/dev/null || true
        kill '"$viewer_pid"' 2>/dev/null || true
        [ -n "${HERDR_PANE_ID:-}" ] && herdr pane rename "$HERDR_PANE_ID" "[cortado] '"$title"'" >/dev/null 2>&1 || true
        echo ""
        echo "Corrida interrumpida. Reporte parcial: '"$report_log"'"
        exit 130
    ' INT TERM

    local rc=0
    wait "$pipe_pid" || rc=$?
    trap - INT TERM

    # Drenaje del tail -f antes de matarlo: en macOS (BSD, kqueue) no hace
    # falta, pero en Linux (GNU tail, con polling) sin este respiro las
    # ultimas lineas del reporte podrian no llegar a imprimirse en el pane.
    sleep 1
    kill "$tail_pid" 2>/dev/null || true
    kill "$viewer_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
    wait "$viewer_pid" 2>/dev/null || true

    echo ""
    if [ "$rc" -eq 0 ]; then
        echo -e "${GREEN}${BOLD}=== $title: pipeline terminado OK ===${NC}"
    else
        echo -e "${RED}${BOLD}=== $title: pipeline FALLO (exit $rc) ===${NC}"
    fi
    echo -e "${CYAN}Reporte completo: $report_log${NC}"
    echo ""

    if [ -n "${HERDR_PANE_ID:-}" ]; then
        if [ "$rc" -eq 0 ]; then
            herdr pane rename "$HERDR_PANE_ID" "[ok] $title" >/dev/null 2>&1 || true
        else
            herdr pane rename "$HERDR_PANE_ID" "[fallo] $title" >/dev/null 2>&1 || true
        fi
    fi

    return "$rc"
}

# --- Modos ---

cmd_tooling() {
    local issue="$1"
    local extra_args="${2:-}"
    # models: el valor crudo de --models (issue #709), como argumento propio y
    # entrecomillado -- NO concatenado a extra_args. extra_args se expande sin
    # comillas (lista de flags simples, p. ej. "--from-stage 2") y ahi un id de
    # modelo completo con corchetes (forma habitual de version de modelo) es
    # un patron glob valido que la pathname expansion podria alterar. Como
    # argumento propio llega intacto a dispatch_to_pane, que lo quotea con
    # printf %q hacia el pane.
    local models="${3:-}"
    # variant: label crudo de --variant (issue #711), mismo criterio que
    # 'models' -- argumento propio, no concatenado a extra_args. Ademas
    # distingue el titulo del pane cuando hay variante (dos corridas del mismo
    # issue en panes separados, cada una identificable en la barra lateral).
    local variant="${4:-}"
    local title="mefisto-tooling #$issue"
    [ -n "$variant" ] && title="mefisto-tooling #$issue ($variant)"
    # extra_args se expande sin comillas a proposito (lista de flags simples).
    # La directiva va sola en su linea: shellcheck no admite texto libre tras
    # el codigo (SC1072/SC1073 -- y ese error le corta el parseo del resto del
    # archivo, dejando sin analizar todo lo que sigue).
    if [ -n "$models" ] && [ -n "$variant" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/mefisto-tooling-pipeline.sh" "$issue" $extra_args --models "$models" --variant "$variant"
    elif [ -n "$models" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/mefisto-tooling-pipeline.sh" "$issue" $extra_args --models "$models"
    elif [ -n "$variant" ]; then
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/mefisto-tooling-pipeline.sh" "$issue" $extra_args --variant "$variant"
    else
        # shellcheck disable=SC2086
        dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/mefisto-tooling-pipeline.sh" "$issue" $extra_args
    fi
}

cmd_batch() {
    local issues=("$@")
    local issues_csv
    issues_csv=$(IFS=','; echo "${issues[*]}")
    dispatch_to_pane "mefisto-batch ${issues_csv}" "$issues_csv" "$SCRIPT_DIR/mefisto-batch-pipeline.sh" "${issues[@]}"
}

print_usage() {
    echo "Uso: $0 --tooling <issue> [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>]"
    echo "     $0 --batch <issue1> <issue2> ..."
    echo ""
    echo "Interfaz herdr de los pipelines internos: reutiliza (o crea) un pane"
    echo "de ejecucion en el workspace herdr actual con el visor en vivo"
    echo "(mefisto-stream-watch.sh) del agente en curso; una corrida concurrente"
    echo "abre un pane adicional."
    echo "--variant <label> (issue #711) corre el mismo issue en un pane propio,"
    echo "sin push/PR/comentario al issue -- solo valido con --tooling; --batch"
    echo "lo rechaza (seria ambiguo sobre varios issues)."
    echo "Fuera de herdr usa mefisto-launch-pipeline.sh, que autodetecta y delega"
    echo "aqui solo cuando aplica."
}

# --- Dispatcher ---
if [ $# -eq 0 ]; then
    print_usage
    exit 1
fi

# El runner interno se despacha antes del pre-parseo: sus argumentos (--title,
# el comando tras --) no deben pasar por los filtros de flags de modos.
if [ "$1" = "--_pane-runner" ]; then
    shift
    cmd_pane_runner "$@"
    exit $?
fi

# Pre-parseo con el mismo contrato que extract_wrapper_flags de
# mefisto-launch-pipeline.sh: --from-stage, --models y --variant se
# consumen de cualquier posicion.
FROM_STAGE_EXTRA=""
MODELS_SPEC=""
VARIANT_SPEC=""
REMAINING_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --from-stage)
            [ $# -lt 2 ] && abort "Falta el valor de --from-stage"
            [[ "$2" =~ ^[0-9]+$ ]] || abort "--from-stage debe ser un numero entero (recibido: '$2')"
            FROM_STAGE_EXTRA="--from-stage $2"
            shift 2
            ;;
        --models)
            # Sin este caso, --models caeria en REMAINING_ARGS y cmd_tooling
            # (que solo reenvia "$1") lo descartaria en silencio (issue #709,
            # mismo defecto que la revision del issue #708 corrigio en el lado
            # publicado). A diferencia de mefisto-launch-pipeline.sh, aqui el
            # valor se guarda crudo: el pane no lo re-parsea con un shell, viaja como
            # argv quoteado con printf %q (dispatch_to_pane).
            [ $# -lt 2 ] && abort "Falta el valor de --models"
            MODELS_SPEC="$2"
            shift 2
            ;;
        --variant)
            # Mismo criterio que --models arriba: sin este caso, --variant
            # caeria en REMAINING_ARGS y cmd_tooling (que solo reenvia "$1")
            # lo descartaria en silencio (issue #711). El valor se guarda
            # crudo: el pane no lo re-parsea con un shell, viaja como argv
            # quoteado con printf %q (dispatch_to_pane).
            [ $# -lt 2 ] && abort "Falta el valor de --variant"
            VARIANT_SPEC="$2"
            shift 2
            ;;
        --attach|--if-exists)
            abort "--attach e --if-exists ya no existen: eran del modo de sesiones retirado (MEF-ADR-0057 decision 5)."
            ;;
        *)
            REMAINING_ARGS+=("$1")
            shift
            ;;
    esac
done
if [ ${#REMAINING_ARGS[@]} -gt 0 ]; then
    set -- "${REMAINING_ARGS[@]}"
else
    set --
fi

case "${1:-}" in
    --help|-h)
        print_usage
        ;;
    --tooling)
        shift
        require_herdr_context
        [ $# -lt 1 ] && abort "Falta el numero de issue. Uso: --tooling <issue> [--from-stage N] [--models 'agente=modelo[,...]'] [--variant <label>]"
        cmd_tooling "$1" "$FROM_STAGE_EXTRA" "$MODELS_SPEC" "$VARIANT_SPEC"
        ;;
    --batch)
        shift
        [ $# -lt 1 ] && abort "Debes especificar al menos un issue. Uso: --batch 42 43 44"
        [ -n "$FROM_STAGE_EXTRA" ] && abort "--from-stage no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --from-stage N para un unico issue."
        [ -n "$MODELS_SPEC" ] && abort "--models no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --models 'agente=modelo' para un unico issue."
        [ -n "$VARIANT_SPEC" ] && abort "--variant no es valido con --batch (seria ambiguo sobre varios issues). Usa --tooling <issue> --variant <label> para un unico issue."
        require_herdr_context
        # El launcher valida la rama antes de adquirir/reutilizar/cerrar panes.
        # El --_pane-runner no pasa por este dispatcher y no lo repite.
        ensure_repo_on_base_branch
        cmd_batch "$@"
        ;;
    "")
        print_usage
        exit 1
        ;;
    *)
        abort "Argumento no reconocido: $1"
        ;;
esac
