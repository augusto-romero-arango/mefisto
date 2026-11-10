#!/usr/bin/env bash
# mefisto-run-agent.sh -- Runner neutral a runtime de una invocacion de agente
# (MEF-ADR-0049 CA-1/CA-2, issue #858). Reemplaza, para quien lo adopte
# (#869), la invocacion directa del CLI de un runtime concreto desde
# .claude/scripts/mefisto-tooling-pipeline.sh:463 por un contrato que ningun
# pipeline necesita conocer en detalle: recibe argumentos opacos, escribe
# JSONL neutral (vocabulario cerrado en
# src/runtime/contract/run-events.schema.json) y devuelve un exit code que
# resume el desenlace sin que el caller tenga que interpretar el stream crudo
# de ningun CLI.
#
# Uso:
#   mefisto-run-agent.sh --agent <id> --cwd <dir> --prompt-file <f>
#                         --event-log <jsonl>
#                         [--runtime <id>] [--model <opaco>] [--effort <opaco>]
#                         [--system-file <f>] [--timeout <s>]
#                         [--raw-log <f>] [--stderr-log <f>]
#                         [--events-log <archivo>] [--resume-session <id>]
#                         [--redact-observability]
#
#   --runtime <id>       Fuerza el runtime (precedencia sobre MEFISTO_RUNTIME
#                         y la autodeteccion, ver mefisto_resolve_runtime en
#                         lib/mefisto-runtime.sh). Opcional: sin el, se
#                         resuelve por entorno/autodeteccion (CA-2).
#   --agent <id>          Id del agente que se invoca (viaja tal cual a
#                         run.started.agent). Obligatorio.
#   --cwd <dir>           Directorio de trabajo del agente (debe existir).
#                         Obligatorio.
#   --prompt-file <f>     Archivo con el prompt (debe existir). Obligatorio.
#   --event-log <jsonl>   Ruta de salida del JSONL neutral. Obligatorio; su
#                         directorio padre se crea si falta.
#   --model <opaco>       Modelo a pasar al adaptador, opaco para este runner
#                         (un alias de Claude Code, lo que sea). Vacio o ausente = heredar
#                         (CA-1): NO llega al adaptador -- build_cmd nunca ve
#                         el flag de modelo en ese caso.
#   --effort <opaco>      Effort ya traducido a nombre nativo del runtime, opaco
#                         para este runner (solo el adaptador lo traduce a su
#                         mecanismo). Vacio o ausente = heredar: no se agrega
#                         nada al argv ni al entorno del CLI. Siempre viaja como
#                         7mo posicional de build_cmd (vacio si no se recibio) y
#                         se registra en run.started.effort (null si vacio).
#   --system-file <f>     Sustituto neutral de --append-system-prompt (debe
#                         existir si se pasa). Cada adaptador decide como
#                         inyectarlo.
#   --timeout <s>         Timeout duro en segundos del watchdog (entero > 0).
#                         Default: 1800 (mismo default que
#                         mefisto-tooling-pipeline.sh hoy).
#   --raw-log <f>         Donde conservar la traza cruda del adaptador (issue
#                         #861: ningun gate la parsea, es solo diagnostico).
#                         Sin el, se usa un archivo temporal descartable.
#   --stderr-log <f>      Donde conservar el stderr crudo del proceso. Mismo
#                         default que --raw-log si se omite.
#   --events-log <archivo> Telemetria HUMANA del pipeline (issue #863), NUNCA
#                         el JSONL neutral de --event-log (HH:MM:SS en hora
#                         local del proceso, respeta TZ): lineas
#                         "[HH:MM:SS][archivo] <ruta>" con el MISMO formato
#                         que hoy escribe el hook publicado
#                         (hooks/hooks.json), mas "[HH:MM:SS][tool] <agente>
#                         <tool> <ok|fail> <ruta-o-resumen|->" por cada
#                         tool.completed y "[HH:MM:SS][stage] <agente>
#                         <status>" en el terminal. Las lineas "[test]" y
#                         "[terraform]" siguen siendo exclusivas del hook
#                         publicado: dependen del RESULTADO de un comando,
#                         que el JSONL neutral no transporta.
#                         Sin default: omitido no escribe telemetria humana.
#                         Un fallo al escribir (directorio inexistente, sin
#                         permisos) degrada a un aviso en stderr -- nunca
#                         altera el exit code ni el evento terminal de
#                         --event-log (CA-3).
#   --resume-session <id> Reanuda una sesion previa del runtime activo en vez
#                         de arrancar una nueva (issue #968, CA-1). Opaco
#                         para este runner: viaja tal cual al adaptador, que
#                         decide su propio flag (`--resume` en Claude Code)
#                         o lo ignora si no soporta
#                         reanudacion. Vacio o ausente (default): NO llega al
#                         adaptador -- build_cmd nunca ve el flag en ese caso,
#                         y el comportamiento es identico byte a byte al de
#                         antes de #968.
#   --redact-observability Persiste una proyeccion segura del stream neutral:
#                         omite `message`, fija `tool.started.input_summary`
#                         en null y reemplaza `error.detail` por un texto
#                         estable derivado de `error.kind`. Aplica tanto a los
#                         anexos en vivo como al volcado final. No redacta los
#                         destinos explicitamente pedidos con --raw-log ni
#                         --stderr-log.
#
# --event-log en vivo (CA-1/CA-2/CA-3, issue #924): mientras el agente corre,
# este runner reanexa a --event-log, cada MEFISTO_RUN_AGENT_LIVE_INTERVAL
# segundos (entero > 0; default 2; un valor invalido cae al default con un
# aviso en stderr), los eventos NO terminales nuevos que produce el traductor
# del propio adaptador sobre el raw log parcial -- append-only, nunca trunca
# ni reescribe. Es best-effort: un fallo en un tick (jq, raw log inexistente,
# --event-log no escribible) nunca altera FINAL_EXIT ni el evento terminal,
# que siguen decidiendose exclusivamente al cierre (MEF-ADR-0031). El
# terminal (exactamente uno, ver mas abajo) solo se anexa al cierre, nunca
# en vivo.
#
# Corte tras exito declarado (issue #2472): un agente que ya declaro exito pero
# cuyo proceso no sale (p. ej. porque quedo un comando en segundo plano vivo) no
# debe caer en TIMEOUT y perder un resultado bueno. El mismo bucle en vivo que
# traduce el raw log mira el terminal: si el adaptador traduce un terminal
# `run.completed{status:"success"}`, anota el instante (una sola vez). Si el
# proceso sigue vivo MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S segundos despues
# (entero >= 1; default 120; vacio equivale a no fijarla, y un `0` o un valor
# no numerico cae al default con un aviso en stderr), el runner deja un archivo
# de solicitud en su directorio temporal y run_agent_with_watchdog (que lo
# atiende en cada rebanada, ver MEFISTO_WATCHDOG_TERMINATE_FILE en
# lib/mefisto-process.sh) manda SIGTERM al grupo, y SIGKILL si sigue vivo 10 s
# despues. Queda en --events-log
# "POST-RESULT: <agente> seguia vivo <N>s despues de declarar exito -- SIGTERM".
# La corrida cierra con el terminal de exito y exit 0 (el exito declarado manda
# sobre el exit distinto de cero posterior). Si igual se llega al timeout del
# watchdog y el raw log ya traia un terminal de exito, se usa ese terminal
# (exit 0) en vez de sintetizar `timeout`, y queda en --events-log "TIMEOUT tras
# exito declarado: <agente>". Un adaptador que no declara exito antes de salir
# conserva el comportamiento de siempre.
#
# Exit code (CA-5): 0 solo con un evento terminal run.completed{status:
# "success"}; 124 si el watchdog mato el proceso por timeout sin exito
# declarado (con exito declarado gana el 0, ver arriba); 65 si el
# protocolo resulto invalido (el adaptador emitio cero o mas de un evento
# terminal -- el runner lo normaliza SIEMPRE a exactamente uno en
# --event-log, descartando los que sobren); en cualquier otro caso, el exit
# code del adaptador (distinto de cero). Validacion de argumentos: exit 64
# (uso). Resolucion de runtime fallida: exit 69.
#
# Interfaz de adaptador (funciones por runtime, `source`adas desde
# lib/runtime-<id>.sh; este issue solo entrega runtime-fake.sh -- Claude Code
# es #859):
#   runtime_<id>_build_cmd <agent> <cwd> <prompt_file> <model> <system_file>
#                          [<resume_session_id>] [<effort>]
#     Rellena el array global MEFISTO_RUNTIME_CMD con el argv completo a
#     invocar via run_agent_with_watchdog, SIN `eval`. <resume_session_id>
#     (issue #968) es el ultimo argumento, OPCIONAL para el adaptador --
#     ignorarlo es una implementacion valida (equivale a no soportar
#     reanudacion); este runner SIEMPRE lo pasa (vacio si --resume-session no
#     se recibio). <effort> (issue #2496) es el 7mo posicional, tambien OPCIONAL
#     para el adaptador y opaco: este runner SIEMPRE lo pasa (vacio si --effort
#     no se recibio); vacio = no agregar nada, no vacio lo aplica el adaptador
#     con su mecanismo nativo. Antes de invocarse, este runner ya expuso
#     MEFISTO_RUNTIME_WORK_DIR (directorio temporal de la corrida, se borra al
#     cerrar) y dejo MEFISTO_RUNTIME_STDIN_FILE en "". Un adaptador puede
#     materializar ahi un archivo (p. ej. el prompt) y fijar
#     MEFISTO_RUNTIME_STDIN_FILE a su ruta absoluta (issue #1447): este runner
#     conecta ESE archivo a la entrada estandar del proceso en vez de
#     /dev/null -- un canal no sujeto a ARG_MAX. Dejarla vacia (default)
#     preserva el comportamiento de siempre. Si queda no vacia apuntando a
#     algo que no es un archivo regular legible, este runner aborta con exit
#     69 antes de lanzar el proceso.
#   runtime_<id>_supports_resume (issue #968, sin argumentos)
#     0 si el adaptador soporta reanudacion, 1 si no. Este runner NO la
#     consulta (reenvia --resume-session sin condicion): la decision de
#     invocar o no con el flag es del CALLER (mefisto-tooling-pipeline.sh,
#     CA-4), que la usa para decidir si vale la pena intentar reanudar antes
#     de gastar un intento.
#   runtime_<id>_translate <raw_file> <runtime_id> <model>
#                          [<exit_code>] [<stderr_file>]
#     Imprime por stdout el JSONL neutral (message/tool.*/terminal) derivado
#     de <raw_file>. Nunca emite run.started -- eso lo hace este runner,
#     directo, porque no depende de ningun dato especifico del adaptador.
#     Los dos ultimos argumentos son OPCIONALES para el adaptador (los
#     ignorar sigue siendo una implementacion valida, como hace
#     runtime-fake.sh) pero este runner SIEMPRE los pasa: sin el exit code y
#     el stderr, un adaptador no puede distinguir una muerte por senal
#     (137/143) ni el `API Error: <status>` que un CLI escribe solo por
#     stderr -- los dos canales siguen separados (#425) -- de un stream que
#     simplemente termino sin declarar nada.
#
# Ver src/runtime/contract/README.md para la interfaz y los eventos.
#
# Bash 3.2 + jq 1.7 (MEF-ADR-0049 CA-6): sin arrays asociativos.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
PROCESS_LIB="$LIB_DIR/mefisto-process.sh"

usage() {
    cat <<'EOF' >&2
Uso: mefisto-run-agent.sh --agent <id> --cwd <dir> --prompt-file <f> --event-log <jsonl>
                           [--runtime <id>] [--model <opaco>] [--effort <opaco>]
                           [--system-file <f>]
                           [--timeout <s>] [--raw-log <f>] [--stderr-log <f>]
                           [--events-log <archivo>] [--resume-session <id>]
                           [--redact-observability] [--help]
EOF
}

abort_usage() {
    echo "ERROR: $1" >&2
    usage
    exit 64
}

if [ ! -f "$PROCESS_LIB" ]; then
    echo "ERROR: no se encontro '$PROCESS_LIB' (ejecucion vigilada comun)" >&2
    exit 69
fi
if [ ! -f "$LIB_DIR/mefisto-runtime.sh" ]; then
    echo "ERROR: no existe '$LIB_DIR/mefisto-runtime.sh'" >&2
    exit 69
fi
if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq no esta instalado (MEF-ADR-0049 CA-6: bash + jq, sin dependencia externa)" >&2
    exit 69
fi

# shellcheck source=/dev/null
source "$PROCESS_LIB"
# shellcheck source=/dev/null
source "$LIB_DIR/mefisto-runtime.sh"

# --- Parseo de argumentos ----------------------------------------------------

OPT_RUNTIME=""
OPT_AGENT=""
OPT_CWD=""
OPT_PROMPT_FILE=""
OPT_EVENT_LOG=""
OPT_MODEL=""
OPT_EFFORT=""
OPT_SYSTEM_FILE=""
OPT_TIMEOUT=""
OPT_RAW_LOG=""
OPT_STDERR_LOG=""
OPT_EVENTS_LOG=""
OPT_RESUME_SESSION=""
OPT_REDACT_OBSERVABILITY=false

while [ $# -gt 0 ]; do
    case "$1" in
        --runtime)     [ $# -ge 2 ] || abort_usage "--runtime requiere un valor"; OPT_RUNTIME="$2"; shift 2 ;;
        --agent)       [ $# -ge 2 ] || abort_usage "--agent requiere un valor"; OPT_AGENT="$2"; shift 2 ;;
        --cwd)         [ $# -ge 2 ] || abort_usage "--cwd requiere un valor"; OPT_CWD="$2"; shift 2 ;;
        --prompt-file) [ $# -ge 2 ] || abort_usage "--prompt-file requiere un valor"; OPT_PROMPT_FILE="$2"; shift 2 ;;
        --event-log)   [ $# -ge 2 ] || abort_usage "--event-log requiere un valor"; OPT_EVENT_LOG="$2"; shift 2 ;;
        --model)       [ $# -ge 2 ] || abort_usage "--model requiere un valor"; OPT_MODEL="$2"; shift 2 ;;
        --effort)      [ $# -ge 2 ] || abort_usage "--effort requiere un valor"; OPT_EFFORT="$2"; shift 2 ;;
        --system-file) [ $# -ge 2 ] || abort_usage "--system-file requiere un valor"; OPT_SYSTEM_FILE="$2"; shift 2 ;;
        --timeout)     [ $# -ge 2 ] || abort_usage "--timeout requiere un valor"; OPT_TIMEOUT="$2"; shift 2 ;;
        --raw-log)     [ $# -ge 2 ] || abort_usage "--raw-log requiere un valor"; OPT_RAW_LOG="$2"; shift 2 ;;
        --stderr-log)  [ $# -ge 2 ] || abort_usage "--stderr-log requiere un valor"; OPT_STDERR_LOG="$2"; shift 2 ;;
        --events-log)  [ $# -ge 2 ] || abort_usage "--events-log requiere un valor"; OPT_EVENTS_LOG="$2"; shift 2 ;;
        --resume-session) [ $# -ge 2 ] || abort_usage "--resume-session requiere un valor"; OPT_RESUME_SESSION="$2"; shift 2 ;;
        --redact-observability) OPT_REDACT_OBSERVABILITY=true; shift ;;
        --help) usage; exit 0 ;;
        *) abort_usage "argumento desconocido: '$1'" ;;
    esac
done

[ -n "$OPT_AGENT" ]       || abort_usage "--agent es obligatorio"
[ -n "$OPT_CWD" ]         || abort_usage "--cwd es obligatorio"
[ -n "$OPT_PROMPT_FILE" ] || abort_usage "--prompt-file es obligatorio"
[ -n "$OPT_EVENT_LOG" ]   || abort_usage "--event-log es obligatorio"

[ -d "$OPT_CWD" ]         || abort_usage "--cwd '$OPT_CWD' no es un directorio existente"
[ -f "$OPT_PROMPT_FILE" ] || abort_usage "--prompt-file '$OPT_PROMPT_FILE' no existe"
if [ -n "$OPT_SYSTEM_FILE" ]; then
    [ -f "$OPT_SYSTEM_FILE" ] || abort_usage "--system-file '$OPT_SYSTEM_FILE' no existe"
fi
if [ -n "$OPT_TIMEOUT" ]; then
    case "$OPT_TIMEOUT" in
        ''|*[!0-9]*) abort_usage "--timeout '$OPT_TIMEOUT' no es un entero" ;;
    esac
    [ "$OPT_TIMEOUT" -gt 0 ] || abort_usage "--timeout debe ser mayor que 0"
fi
TIMEOUT_S="${OPT_TIMEOUT:-1800}"

# --- Intervalo del anexo en vivo (CA-1, issue #924) -------------------------
# Un valor invalido (no entero, <= 0) cae al default sin abortar la corrida:
# el anexo en vivo es best-effort, nunca una condicion de arranque (CA-3).
# Quien decide "> 0" es la comparacion NUMERICA, no la forma del literal: "00"
# es todo digitos y aun asi vale cero, y un intervalo cero convierte el bucle
# de mas abajo en una espera activa que retraduce el raw log sin pausa.
LIVE_INTERVAL_DEFAULT=2
LIVE_INTERVAL=""
case "${MEFISTO_RUN_AGENT_LIVE_INTERVAL:-}" in
    '') LIVE_INTERVAL="$LIVE_INTERVAL_DEFAULT" ;;
    *[!0-9]*) ;;
    *) [ "$MEFISTO_RUN_AGENT_LIVE_INTERVAL" -gt 0 ] && LIVE_INTERVAL="$MEFISTO_RUN_AGENT_LIVE_INTERVAL" ;;
esac
if [ -z "$LIVE_INTERVAL" ]; then
    echo "AVISO: MEFISTO_RUN_AGENT_LIVE_INTERVAL='${MEFISTO_RUN_AGENT_LIVE_INTERVAL:-}' invalido (debe ser un entero > 0); usando el default (${LIVE_INTERVAL_DEFAULT}s)" >&2
    LIVE_INTERVAL="$LIVE_INTERVAL_DEFAULT"
fi

# --- Gracia tras exito declarado (issue #2472) -----------------------------
# Mismo criterio que el intervalo en vivo: la comparacion NUMERICA decide el
# ">= 1", no la forma del literal ("00" es todo digitos y vale cero).
POST_RESULT_GRACE_DEFAULT=120
POST_RESULT_GRACE_S=""
case "${MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S:-}" in
    '') ;;
    *[!0-9]*) ;;
    *) [ "$MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S" -ge 1 ] && POST_RESULT_GRACE_S="$MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S" ;;
esac
if [ -z "$POST_RESULT_GRACE_S" ]; then
    if [ -n "${MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S:-}" ]; then
        echo "AVISO: MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S='${MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S}' invalido (debe ser un entero >= 1); usando el default (${POST_RESULT_GRACE_DEFAULT}s)" >&2
    fi
    POST_RESULT_GRACE_S="$POST_RESULT_GRACE_DEFAULT"
fi

# --- Resolucion de runtime (CA-2) -------------------------------------------

if ! mefisto_resolve_runtime "$OPT_RUNTIME" >/dev/null; then
    echo "ERROR: $MEFISTO_RUNTIME_ERROR" >&2
    exit 69
fi
RUNTIME_ID="$MEFISTO_RESOLVED_RUNTIME"

RUNTIME_LIB="$MEFISTO_RUNTIME_LIB_DIR/runtime-${RUNTIME_ID}.sh"
# shellcheck source=/dev/null
source "$RUNTIME_LIB"

BUILD_FN="runtime_${RUNTIME_ID}_build_cmd"
TRANSLATE_FN="runtime_${RUNTIME_ID}_translate"
if ! declare -F "$BUILD_FN" >/dev/null 2>&1; then
    echo "ERROR: $RUNTIME_LIB no define $BUILD_FN" >&2
    exit 69
fi
if ! declare -F "$TRANSLATE_FN" >/dev/null 2>&1; then
    echo "ERROR: $RUNTIME_LIB no define $TRANSLATE_FN" >&2
    exit 69
fi

# --- Directorio de trabajo por corrida (CA-3, issue #1447) -----------------
# Un unico directorio temporal por corrida, del que cuelga todo lo efimero
# (traza cruda y stderr cuando no se pidieron por flag, log de texto del
# watchdog, senal de timeout y, desde este issue, lo que un adaptador
# materialice para MEFISTO_RUNTIME_STDIN_FILE). La senal NECESITA un nombre
# que ninguna otra corrida pueda recibir: si el watchdog de una corrida
# anterior sobrevive a su kill y luego hace `touch` sobre un nombre
# reciclado, ESTA corrida se clasifica como TIMEOUT sin haberse agotado --
# exactamente el riesgo que mefisto-tooling-pipeline.sh ya evita numerando su
# senal por intento. `mktemp -d` reserva el directorio en disco; `mktemp -u`
# solo proponia un nombre libre y lo dejaba disponible para el siguiente que
# preguntara.
#
# Se crea y se exporta ANTES de build_cmd (mas abajo): un adaptador que
# quiera transportar el prompt por stdin necesita un lugar donde
# materializar el archivo antes de que este runner lo valide.
RUN_TMP_DIR="$(mktemp -d -t mefisto-run-agent)"
if [ -z "$RUN_TMP_DIR" ] || [ ! -d "$RUN_TMP_DIR" ]; then
    echo "ERROR: no se pudo crear el directorio temporal de la corrida" >&2
    exit 69
fi
export MEFISTO_RUNTIME_WORK_DIR="$RUN_TMP_DIR"

# Senal de parada del bucle en vivo (CA-2/CA-3, issue #924): un archivo, nunca
# un `kill` -- el bucle puede estar a mitad de un `printf` de anexo y un
# `kill` ahi mismo lo cortaria a media escritura. `stop_live_tail` es
# idempotente (LIVE_STOPPED) porque la llama tanto el flujo normal, ANTES de
# la traduccion final (CA-2), como `cleanup` en cualquier salida temprana.
LIVE_STOP_FILE="$RUN_TMP_DIR/live.stop"
LIVE_LOOP_PID=""
LIVE_STOPPED=false

stop_live_tail() {
    [ "$LIVE_STOPPED" = "true" ] && return 0
    LIVE_STOPPED=true
    : > "$LIVE_STOP_FILE" 2>/dev/null || true
    [ -n "$LIVE_LOOP_PID" ] && wait "$LIVE_LOOP_PID" 2>/dev/null
    return 0
}

cleanup() {
    stop_live_tail
    rm -rf "$RUN_TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# --- Construccion del comando del adaptador (build_cmd) ---------------------
# MEFISTO_RUNTIME_STDIN_FILE (CA-3, issue #1447): canal opcional de stdin no
# sujeto a ARG_MAX (incidente de #1407: un prompt de 3.237.916 bytes en el
# argv hizo que el kernel rechazara el `exec` antes de que el runtime
# arrancara). Se inicializa vacia -- "" == /dev/null, el comportamiento de
# siempre -- y solo un adaptador que la fije explicitamente la activa. Si la
# deja no vacia apuntando a algo que no es un archivo regular legible, este
# runner aborta ANTES de invocar run_agent_with_watchdog: un stdin roto en
# silencio (una ruta que nunca se materializo, un directorio) es peor que
# fallar rapido con un mensaje explicito.
MEFISTO_RUNTIME_CMD=()
MEFISTO_RUNTIME_STDIN_FILE=""
"$BUILD_FN" "$OPT_AGENT" "$OPT_CWD" "$OPT_PROMPT_FILE" "$OPT_MODEL" "$OPT_SYSTEM_FILE" "$OPT_RESUME_SESSION" "$OPT_EFFORT"
if [ "${#MEFISTO_RUNTIME_CMD[@]}" -eq 0 ]; then
    echo "ERROR: $BUILD_FN no genero ningun comando (MEFISTO_RUNTIME_CMD vacio)" >&2
    exit 69
fi
if [ -n "$MEFISTO_RUNTIME_STDIN_FILE" ]; then
    if [ ! -f "$MEFISTO_RUNTIME_STDIN_FILE" ] || [ ! -r "$MEFISTO_RUNTIME_STDIN_FILE" ]; then
        echo "ERROR: $BUILD_FN fijo MEFISTO_RUNTIME_STDIN_FILE='$MEFISTO_RUNTIME_STDIN_FILE', que no es un archivo regular legible" >&2
        exit 69
    fi
fi

# --- Archivos de trabajo ------------------------------------------------

mkdir -p "$(dirname "$OPT_EVENT_LOG")" 2>/dev/null || true
if ! : > "$OPT_EVENT_LOG" 2>/dev/null; then
    abort_usage "--event-log '$OPT_EVENT_LOG' no es escribible"
fi

if [ -n "$OPT_RAW_LOG" ]; then
    RAW_LOG="$OPT_RAW_LOG"
    mkdir -p "$(dirname "$RAW_LOG")" 2>/dev/null || true
else
    RAW_LOG="$RUN_TMP_DIR/raw.log"
fi

if [ -n "$OPT_STDERR_LOG" ]; then
    STDERR_LOG="$OPT_STDERR_LOG"
    mkdir -p "$(dirname "$STDERR_LOG")" 2>/dev/null || true
else
    STDERR_LOG="$RUN_TMP_DIR/stderr.log"
fi

if [ "$OPT_REDACT_OBSERVABILITY" = "true" ] && { [ -n "$OPT_RAW_LOG" ] || [ -n "$OPT_STDERR_LOG" ]; }; then
    echo "AVISO: --redact-observability no redacta los destinos solicitados explicitamente (--raw-log: '${OPT_RAW_LOG:-<no solicitado>}', --stderr-log: '${OPT_STDERR_LOG:-<no solicitado>}'); no son observabilidad segura" >&2
fi

# Telemetria humana opt-in (CA-3/#1045): el nucleo no deriva rutas de estado.
# Si el caller entrega una ruta, un fallo de escritura degrada a aviso.
if [ -n "$OPT_EVENTS_LOG" ]; then
    EVENTS_LOG_TARGET="$OPT_EVENTS_LOG"
    mkdir -p "$(dirname "$EVENTS_LOG_TARGET")" 2>/dev/null || true
else
    EVENTS_LOG_TARGET=""
fi

# events_log de run_agent_with_watchdog: solo recibe SU linea de texto plano
# de diagnostico ("[HH:MM:SS] TIMEOUT: ..."), nunca el JSONL neutral -- mezclar
# ambos formatos en --event-log corromperia el contrato (CA-3/CA-4).
WATCHDOG_EVENTS_LOG="$RUN_TMP_DIR/watchdog-events.log"
SIGNAL_FILE="$RUN_TMP_DIR/timeout.signal"

# Corte tras exito declarado (issue #2472): el bucle en vivo corre en un
# subshell, asi que su estado viaja por archivos de RUN_TMP_DIR (nombre unico
# por corrida, mismo criterio que SIGNAL_FILE). Variable de shell, NO exportada:
# el proceso del agente no tiene por que heredarla.
POST_RESULT_SINCE_FILE="$RUN_TMP_DIR/post-result.since"
MEFISTO_WATCHDOG_TERMINATE_FILE="$RUN_TMP_DIR/post-result.terminate"

# --- Helpers -----------------------------------------------------------

now_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

model_json_or_null() {
    if [ -n "$1" ]; then
        printf '%s' "$1" | jq -Rr '@json'
    else
        printf 'null'
    fi
}

# La persistencia redactada se aplica DESPUES de la traduccion nativa: los
# adaptadores conservan su capacidad de clasificar el desenlace desde wire data
# y stderr, pero ningun contenido de entrada/salida llega a la observabilidad.
# Esta es la unica transformacion y la usan por igual el tick en vivo y el
# volcado final para no exponer una linea durante el intervalo de reescritura.
redact_observability_events() {
    if [ "$OPT_REDACT_OBSERVABILITY" = "true" ]; then
        printf '%s\n' "$1" | jq -c '
            select(type == "object")
            | if .type == "message" then empty
              elif .type == "tool.started" then .input_summary = null
              elif ((.error? | type) == "object") then
                  .error.detail = ("detalle redactado: " + .error.kind)
              else .
              end
        ' 2>/dev/null
    else
        printf '%s' "$1"
    fi
}

# --- run.started (CA-3): lo emite el runner, no el adaptador ----------------

RUN_STARTED_MODEL_JSON="$(model_json_or_null "$OPT_MODEL")"
RUN_STARTED_EFFORT_JSON="$(model_json_or_null "$OPT_EFFORT")"
jq -n -c \
    --arg ts "$(now_ts)" \
    --arg runtime "$RUNTIME_ID" \
    --arg agent "$OPT_AGENT" \
    --argjson model "$RUN_STARTED_MODEL_JSON" \
    --argjson effort "$RUN_STARTED_EFFORT_JSON" \
    --arg cwd "$OPT_CWD" \
    '{v: 1, type: "run.started", ts: $ts, runtime: $runtime, agent: $agent, model: $model, effort: $effort, cwd: $cwd}' \
    > "$OPT_EVENT_LOG"

# --- Anexo en vivo de no terminales (CA-1/CA-3, issue #924) -----------------
# Arranca DESPUES de run.started (ya escrito arriba) y ANTES de
# run_agent_with_watchdog (mas abajo, invocada dentro de un `$(...)`): el
# bucle tiene que vivir en ESTE proceso -- si colgara del `$(...)` de mas
# abajo moriria junto con ese subshell antes de que el proceso del agente
# termine. Lanzado aqui, sin `set -m` activo en este shell (desde #943
# run_agent_with_watchdog ya no lo activa alrededor del CLI -- lo lanza en una
# sesion nueva con `setsid`; solo lo activa y desactiva puertas adentro
# alrededor de su propio watchdog), este `&` no se vuelve lider de un grupo de
# procesos nuevo -- por eso el `kill -9 -"$pid"` que el watchdog dispara sobre
# el GRUPO del agente jamas lo alcanza (CA-3).

# Evidencia de exito declarado (issue #2472): el terminal NEUTRAL que traduce el
# adaptador, nunca el formato crudo de ningun CLI. Primera vez que aparece, anota
# el instante; pasada la gracia con el proceso aun vivo, deja el archivo de
# solicitud que atiende run_agent_with_watchdog. Best-effort como el resto del
# tick: nunca altera FINAL_EXIT ni el terminal, que se deciden al cierre.
post_result_check() {
    local translated="$1" now since waited
    [ -f "$MEFISTO_WATCHDOG_TERMINATE_FILE" ] && return 0
    printf '%s\n' "$translated" | jq -e 'select(type == "object") | select(.type == "run.completed" and .status == "success")' >/dev/null 2>&1 || return 0

    now="$(date +%s)"
    if [ ! -f "$POST_RESULT_SINCE_FILE" ]; then
        printf '%s\n' "$now" > "$POST_RESULT_SINCE_FILE" 2>/dev/null
        return 0
    fi
    since="$(cat "$POST_RESULT_SINCE_FILE" 2>/dev/null)"
    case "$since" in ''|*[!0-9]*) return 0 ;; esac
    waited=$((now - since))
    [ "$waited" -ge "$POST_RESULT_GRACE_S" ] || return 0

    if [ -n "$EVENTS_LOG_TARGET" ]; then
        { printf '[%s] POST-RESULT: %s seguia vivo %ss despues de declarar exito -- SIGTERM\n' "$(date +%H:%M:%S)" "$OPT_AGENT" "$waited" >> "$EVENTS_LOG_TARGET"; } 2>/dev/null
    fi
    : > "$MEFISTO_WATCHDOG_TERMINATE_FILE" 2>/dev/null
    return 0
}

live_tail_tick() {
    [ -f "$RAW_LOG" ] || return 0

    local total_lines n_prev translated non_terminal m_new pending

    # exit_code y stderr_file vacios: solo afectan al terminal que este tick
    # descarta -- un raw log parcial no tiene ninguno de los dos todavia.
    translated="$("$TRANSLATE_FN" "$RAW_LOG" "$RUNTIME_ID" "$OPT_MODEL" "" "" 2>/dev/null)" || return 0
    translated="$(redact_observability_events "$translated")" || return 0
    [ -n "$translated" ] || return 0

    post_result_check "$translated"

    [ -w "$OPT_EVENT_LOG" ] || return 0
    total_lines="$(wc -l < "$OPT_EVENT_LOG" 2>/dev/null | tr -d ' ')"
    case "$total_lines" in ''|*[!0-9]*) return 0 ;; esac
    n_prev=$((total_lines - 1))
    [ "$n_prev" -ge 0 ] || n_prev=0

    non_terminal="$(printf '%s\n' "$translated" | jq -c 'select(type == "object") | select(.type != "run.completed" and .type != "run.failed")' 2>/dev/null)"
    [ -n "$non_terminal" ] || return 0

    m_new="$(printf '%s\n' "$non_terminal" | wc -l | tr -d ' ')"
    [ "$m_new" -gt "$n_prev" ] || return 0

    pending="$(printf '%s\n' "$non_terminal" | tail -n "+$((n_prev + 1))")"
    [ -n "$pending" ] || return 0

    printf '%s\n' "$pending" >> "$OPT_EVENT_LOG" 2>/dev/null
    return 0
}

# El intervalo NO se duerme de una sola pieza. `stop_live_tail` senaliza por
# archivo y despues espera al bucle con `wait`, asi que un `sleep
# "$LIVE_INTERVAL"` entero le regalaba al cierre de CADA corrida hasta un
# intervalo completo de espera muerta -- medido en
# test-mefisto-run-agent.sh: 9,6s -> 27,7s, ~12s de puro `wait` repartidos
# entre sus 10 invocaciones del runner. Durmiendo en rebanadas cortas la
# cadencia de los ticks sigue siendo LIVE_INTERVAL, pero el cierre nunca
# espera mas de una rebanada.
LIVE_SLEEP_SLICE_S=0.25
LIVE_SLICES_PER_TICK=$((LIVE_INTERVAL * 4))

live_tail_loop() {
    local slice
    while :; do
        slice=0
        while [ "$slice" -lt "$LIVE_SLICES_PER_TICK" ]; do
            sleep "$LIVE_SLEEP_SLICE_S"
            [ -f "$LIVE_STOP_FILE" ] && return 0
            # Segunda condicion de parada, para el caso en que el runner
            # muere sin llegar a correr su `trap EXIT` (un SIGKILL desde
            # afuera, p. ej.) y por lo tanto sin dejar nunca la senal: sin
            # esto el bucle quedaria huerfano anexando al --event-log de una
            # corrida que ya no existe (CA-3, "no sobrevive al runner"). `$$`
            # no cambia en un subshell -- es el PID del runner, no el de este
            # hijo.
            kill -0 "$$" 2>/dev/null || return 0
            slice=$((slice + 1))
        done
        live_tail_tick
    done
}

live_tail_loop &
LIVE_LOOP_PID=$!

# --- Invocacion bajo watchdog (CA-5) -----------------------------------

START_EPOCH=$(date +%s)
ADAPTER_EXIT=$(run_agent_with_watchdog "$OPT_CWD" "$TIMEOUT_S" "$RAW_LOG" "$STDERR_LOG" "$WATCHDOG_EVENTS_LOG" "$OPT_AGENT" "$SIGNAL_FILE" "${MEFISTO_RUNTIME_CMD[@]}")
END_EPOCH=$(date +%s)
# run_agent_with_watchdog devuelve el exit code IMPRIMIENDOLO por stdout. Si lo
# que llega no es un entero, no se puede afirmar nada sobre el proceso: se
# asume fallo antes que arriesgar un exit 0 sobre un desenlace desconocido.
case "$ADAPTER_EXIT" in
    ''|*[!0-9]*) ADAPTER_EXIT=1 ;;
esac
ELAPSED_S=$(( END_EPOCH - START_EPOCH ))
ELAPSED_MS=$(( ELAPSED_S * 1000 ))

# Un timeout se afirma con DOS evidencias que tienen que coincidir: la senal
# que dejo el watchdog y el reloj de pared que este runner midio alrededor de
# la invocacion completa. La senal sola no alcanza -- el watchdog de
# run_agent_with_watchdog (#424) hace `sleep <timeout>` y despues `touch`, asi
# que basta con que ese `sleep` no llegue a dormir (una maquina cargada que no
# puede forkearlo, por ejemplo) para que deje la senal en el mismo instante en
# que arranco. Verificado: bajo carga aparecieron corridas con la senal puesta,
# `elapsed=0` y `--timeout 1800`, clasificadas como TIMEOUT sin haber esperado
# nada -- un gate no determinista, justo lo que MEF-ADR-0031 no admite.
#
# El corte `ELAPSED_S >= TIMEOUT_S` no puede descartar un timeout real: con
# segundos truncados, floor(fin)-floor(inicio) nunca queda por debajo de
# floor(duracion real), y una corrida que el watchdog mato duro al menos
# TIMEOUT_S. Solo descarta senales que el reloj desmiente.
TIMED_OUT=false
if [ -f "$SIGNAL_FILE" ] && [ "$ELAPSED_S" -ge "$TIMEOUT_S" ]; then
    TIMED_OUT=true
fi
rm -f "$SIGNAL_FILE"

# El bucle en vivo se detiene ANTES de traducir el raw log completo (CA-2):
# despues de este punto ya no hay mas anexos concurrentes a --event-log, asi
# que el bloque de mas abajo puede contar sus lineas sin correr con nadie.
stop_live_tail

# --- Traduccion del adaptador --------------------------------------------

TRANSLATED="$("$TRANSLATE_FN" "$RAW_LOG" "$RUNTIME_ID" "$OPT_MODEL" "$ADAPTER_EXIT" "$STDERR_LOG" 2>/dev/null)"
TRANSLATED="$(redact_observability_events "$TRANSLATED")"

NON_TERMINAL_JSON=""
TERMINAL_JSON=""
if [ -n "$TRANSLATED" ]; then
    NON_TERMINAL_JSON="$(printf '%s\n' "$TRANSLATED" | jq -c 'select(type == "object") | select(.type != "run.completed" and .type != "run.failed")' 2>/dev/null)"
    TERMINAL_JSON="$(printf '%s\n' "$TRANSLATED" | jq -c 'select(type == "object") | select(.type == "run.completed" or .type == "run.failed")' 2>/dev/null)"
fi

TERMINAL_COUNT=0
if [ -n "$TERMINAL_JSON" ]; then
    TERMINAL_COUNT="$(printf '%s\n' "$TERMINAL_JSON" | jq -s 'length' 2>/dev/null)"
    [ -n "$TERMINAL_COUNT" ] || TERMINAL_COUNT=0
fi

# --- Normalizacion a EXACTAMENTE un evento terminal (CA-5) ------------------

CHOSEN_TERMINAL=""
FINAL_EXIT=1

# Timeout tras exito declarado (issue #2472): si el raw log ya traia un terminal
# de exito completo, el watchdog solo mato a un proceso que no salia -- no a un
# trabajo a medias. Se conserva ese terminal (exit 0) en vez de sintetizar
# `timeout`. Sin exito declarado, el timeout se comporta como siempre.
TIMED_OUT_AFTER_SUCCESS=false
if [ "$TIMED_OUT" = "true" ] && [ "$TERMINAL_COUNT" -eq 1 ] \
    && [ "$(printf '%s' "$TERMINAL_JSON" | jq -r '.status' 2>/dev/null)" = "success" ]; then
    TIMED_OUT_AFTER_SUCCESS=true
    if [ -n "$EVENTS_LOG_TARGET" ]; then
        { printf '[%s] TIMEOUT tras exito declarado: %s\n' "$(date +%H:%M:%S)" "$OPT_AGENT" >> "$EVENTS_LOG_TARGET"; } 2>/dev/null
    fi
fi

if [ "$TIMED_OUT" = "true" ] && [ "$TIMED_OUT_AFTER_SUCCESS" = "false" ]; then
    # El watchdog mato el proceso a mitad de vuelo: cualquier terminal que el
    # adaptador haya alcanzado a traducir no es confiable (la senal pudo llegar
    # a mitad de escritura), asi que se descarta y el runner sintetiza el suyo.
    # Los eventos NO terminales si se conservan: son hechos completos y ya
    # ocurridos (mensajes, tool calls) y son justamente la evidencia con la que
    # se diagnostica DONDE se colgo la corrida. Tirarlos no protegeria de nada
    # -- una linea cortada a media escritura la descarta antes el parseo
    # tolerante del propio adaptador, y nunca llega hasta aqui.
    CHOSEN_TERMINAL="$(jq -n -c \
        --arg ts "$(now_ts)" --arg runtime "$RUNTIME_ID" --argjson model "$RUN_STARTED_MODEL_JSON" \
        --arg detail "el watchdog mato el proceso tras superar ${TIMEOUT_S}s" \
        '{v: 1, type: "run.failed", ts: $ts, status: "timeout", runtime: $runtime, model: $model,
           session_id: null, duration_ms: null, tokens: {input: null, output: null, cache_read: null, cache_write: null, reasoning: null}, estimated_cost_usd: null,
          turns: null, denials: null, ttft_ms: null, api_duration_ms: null,
          error: {kind: "timeout", detail: $detail}}')"
    FINAL_EXIT=124
elif [ "$TERMINAL_COUNT" -eq 1 ]; then
    CHOSEN_TERMINAL="$TERMINAL_JSON"
    TERMINAL_STATUS="$(printf '%s' "$CHOSEN_TERMINAL" | jq -r '.status')"
    if [ "$TERMINAL_STATUS" = "success" ]; then
        # El exito declarado por el adaptador manda sobre el exit code del CLI.
        # Es la doctrina que el pipeline ya aplica desde el PR #446 (ver
        # agent_failure_is_unrecoverable en .claude/scripts/_mefisto-common.sh):
        # si el runtime alcanzo a declarar que cumplio su contrato, una senal o
        # un exit distinto de cero POSTERIOR a esa declaracion es una muerte de
        # despues, no un trabajo a medias. El adaptador puede dejar constancia
        # de ella en `error` sin degradar el status.
        FINAL_EXIT=0
    elif [ "$ADAPTER_EXIT" -ne 0 ] 2>/dev/null; then
        FINAL_EXIT="$ADAPTER_EXIT"
    else
        FINAL_EXIT=1
    fi
else
    DETAIL="el adaptador '$RUNTIME_ID' emitio $TERMINAL_COUNT eventos terminales (se esperaba exactamente 1)"
    CHOSEN_TERMINAL="$(jq -n -c \
        --arg ts "$(now_ts)" --arg runtime "$RUNTIME_ID" --argjson model "$RUN_STARTED_MODEL_JSON" \
        --arg detail "$DETAIL" \
        '{v: 1, type: "run.failed", ts: $ts, status: "protocol_invalid", runtime: $runtime, model: $model,
           session_id: null, duration_ms: null, tokens: {input: null, output: null, cache_read: null, cache_write: null, reasoning: null}, estimated_cost_usd: null,
          turns: null, denials: null, ttft_ms: null, api_duration_ms: null,
          error: {kind: "protocol_invalid", detail: $detail}}')"
    FINAL_EXIT=65
fi

# duration_ms real (CA-5): el runner es la unica parte que tiene el reloj de
# pared alrededor de la invocacion COMPLETA -- sobreescribe lo que el
# adaptador haya (o no) traducido, nunca un cero fabricado (MEF-ADR-0049 CA-1).
CHOSEN_TERMINAL="$(printf '%s' "$CHOSEN_TERMINAL" | jq -c --argjson d "$ELAPSED_MS" '.duration_ms = $d')"
CHOSEN_TERMINAL="$(redact_observability_events "$CHOSEN_TERMINAL")"

# Anexo final: solo los no terminales PENDIENTES (CA-2, issue #924). El
# bucle en vivo (ya detenido arriba, antes de traducir) pudo haber anexado
# una parte de $NON_TERMINAL_JSON mientras corria -- reanexar el conjunto
# COMPLETO los duplicaria. N = lineas de --event-log menos 1 (por
# run.started) es la cuenta de no terminales YA escritos; solo se anexa
# desde la posicion N+1 en adelante. Cuando el bucle nunca llego a tickear
# (la corrida termino antes del primer intervalo), N=0 y esto anexa el
# conjunto completo -- el comportamiento de siempre.
ALREADY_LINES="$(wc -l < "$OPT_EVENT_LOG" 2>/dev/null | tr -d ' ')"
case "$ALREADY_LINES" in ''|*[!0-9]*) ALREADY_LINES=1 ;; esac
ALREADY_NON_TERMINAL=$((ALREADY_LINES - 1))
[ "$ALREADY_NON_TERMINAL" -ge 0 ] || ALREADY_NON_TERMINAL=0

if [ -n "$NON_TERMINAL_JSON" ]; then
    NON_TERMINAL_PENDING="$(printf '%s\n' "$NON_TERMINAL_JSON" | tail -n "+$((ALREADY_NON_TERMINAL + 1))")"
    [ -n "$NON_TERMINAL_PENDING" ] && printf '%s\n' "$NON_TERMINAL_PENDING" >> "$OPT_EVENT_LOG"
fi
printf '%s\n' "$CHOSEN_TERMINAL" >> "$OPT_EVENT_LOG"

# --- events.log (CA-1/CA-2/CA-3, issue #863): telemetria HUMANA derivada del
# mismo JSONL neutral que ya se escribio arriba, best-effort -- nunca puede
# alterar $FINAL_EXIT ni el evento terminal de --event-log, que ya quedaron
# decididos por completo antes de este bloque.
#
# El emparejamiento tool.completed <-> tool.started es por NOMBRE de tool en
# orden FIFO (una cola por nombre, "q"): el JSONL neutral no trae un id de
# llamada que sobreviva la traduccion (a diferencia de Claude, que empareja
# tool_use/tool_result por id ANTES de traducir), pero dentro de una misma
# corrida los eventos de un mismo tool llegan en el orden en que ocurrieron,
# asi que la primera cola-pendiente es siempre la correcta. `$summary // "-"`
# es la unica fuente del campo "ruta-o-resumen": si el tool no es de archivo
# ni Bash (Read/Write/Edit/Bash o edit/write/read/bash), input_summary llego
# null desde el traductor y aqui se escribe "-", nunca se inventa (CA-2).
EVENTS_LOG_TERM_TS="$(printf '%s' "$CHOSEN_TERMINAL" | jq -r '.ts')"
EVENTS_LOG_TERM_STATUS="$(printf '%s' "$CHOSEN_TERMINAL" | jq -r '.status')"

EVENTS_LOG_LINES="$(printf '%s\n' "$NON_TERMINAL_JSON" | jq -s -r \
    --arg agent "$OPT_AGENT" \
    --arg term_ts "$EVENTS_LOG_TERM_TS" \
    --arg term_status "$EVENTS_LOG_TERM_STATUS" '
    def hms: try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | strflocaltime("%H:%M:%S")) catch "--:--:--";
    # Un tool.started solo produce linea [archivo] si el tool ES de archivo.
    # `Bash`/`bash` tambien trae input_summary -- los primeros 80 caracteres
    # del comando (ver "Notas tecnicas" de #863) -- pero un comando NO es una
    # ruta: emitirlo como [archivo] llenaria el events.log que lee
    # work-status-collect.sh de archivos inexistentes. CA-1 lo dice literal:
    # linea [archivo] "por cada tool.started CON RUTA DE ARCHIVO en
    # input_summary". El nombre se compara en minusculas porque es la unica
    # forma de cubrir los dos runtimes con una sola lista sin volver el runner
    # dependiente de ninguno (Edit/Write/Read en Claude Code; otro runtime puede
    # usar la misma terna con distinta capitalizacion).
    def es_tool_de_archivo:
        ((. // "") | ascii_downcase) as $t
        | $t == "edit" or $t == "write" or $t == "read";
    def tool_lines:
        reduce .[] as $ev (
            {q: {}, out: []};
            if $ev.type == "tool.started" then
                .q[$ev.tool] = ((.q[$ev.tool] // []) + [$ev.input_summary])
                | if ($ev.input_summary != null) and ($ev.tool | es_tool_de_archivo) then
                      .out += ["[" + ($ev.ts|hms) + "][archivo] " + $ev.input_summary]
                  else . end
            elif $ev.type == "tool.completed" then
                ((.q[$ev.tool] // [])[0]) as $summary
                | .q[$ev.tool] = ((.q[$ev.tool] // [])[1:])
                | .out += ["[" + ($ev.ts|hms) + "][tool] " + $agent + " " + $ev.tool + " "
                    + (if $ev.ok then "ok" else "fail" end) + " " + ($summary // "-")]
            else . end
        ) | .out[];
    tool_lines, ("[" + ($term_ts|hms) + "][stage] " + $agent + " " + $term_status)
' 2>/dev/null)"

EVENTS_LOG_WRITTEN=false
[ -z "$EVENTS_LOG_TARGET" ] && EVENTS_LOG_WRITTEN=true
if [ -n "$EVENTS_LOG_LINES" ] && [ -n "$EVENTS_LOG_TARGET" ]; then
    EVENTS_LOG_DIR="$(dirname "$EVENTS_LOG_TARGET")"
    if [ -d "$EVENTS_LOG_DIR" ] && [ -w "$EVENTS_LOG_DIR" ]; then
        # 2>/dev/null ANTES del >>: una redireccion que falla la reporta el
        # shell por el stderr vigente EN ESE MOMENTO, asi que al reves el
        # "cannot create" se escaparia a la consola pese al guard de arriba.
        if printf '%s\n' "$EVENTS_LOG_LINES" 2>/dev/null >> "$EVENTS_LOG_TARGET"; then
            EVENTS_LOG_WRITTEN=true
        fi
    fi
fi
if [ "$EVENTS_LOG_WRITTEN" = "false" ]; then
    echo "AVISO: no se pudo escribir la telemetria de herramientas en events.log (destino: '${EVENTS_LOG_TARGET:-<sin resolver>}'); se omite sin afectar el exit code ni el evento terminal de la corrida (CA-3, issue #863)" >&2
fi

exit "$FINAL_EXIT"
