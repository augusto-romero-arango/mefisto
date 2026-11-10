#!/usr/bin/env bash
# runtime-fake.sh -- Adaptador de runtime FALSO (issue #858). Unico adaptador
# que este issue entrega (Claude Code y OpenCode son #859/#860): existe para
# que mefisto-run-agent.sh y su contrato de eventos se puedan probar sin
# invocar un CLI real, guionando escenarios (exito, fallo, cuelgue, protocolo
# invalido) por variable de entorno.
#
# Implementa la interfaz de funciones que todo adaptador de runtime debe
# exponer (ver src/runtime/contract/README.md, "Interfaz de adaptador"):
#   runtime_fake_build_cmd <agent> <cwd> <prompt_file> <model> <system_file>
#                          [<resume_session_id>] [<effort>]
#     Rellena el array global MEFISTO_RUNTIME_CMD con el argv a invocar via
#     run_agent_with_watchdog (sin `eval`). <model> puede llegar vacio
#     (heredar, CA-1): en ese caso NO se agrega ningun flag de modelo al argv
#     -- el CLI fake nunca lo ve, igual que un adaptador real nunca deberia
#     pasar un --model vacio al CLI que envuelve. <resume_session_id> (issue
#     #968) sigue el mismo criterio: vacio/ausente no agrega nada al argv;
#     no vacio agrega `--fake-resume <id>`, que el "CLI fake" solo usa para
#     dejar constancia en MEFISTO_FAKE_ARGS_FILE (ver mas abajo) -- ningun
#     guion cambia de comportamiento por reanudar, porque el fake no modela
#     una sesion real con memoria. Ademas (issue #1447) fija la variable
#     global MEFISTO_RUNTIME_STDIN_FILE: materializa el prompt -- prefijado
#     con el contenido de <system_file> y una linea en blanco, si se paso uno
#     -- dentro de MEFISTO_RUNTIME_WORK_DIR (que este runner ya expuso antes
#     de llamar a esta funcion) y apunta ahi. Los guiones existentes ignoran
#     stdin, asi que fijar esta variable no les cambia el comportamiento;
#     solo el guion `dump-stdin` la consume. Sin MEFISTO_RUNTIME_WORK_DIR (un
#     caller que invoque esta funcion sin pasar por mefisto-run-agent.sh), no
#     materializa nada y deja la variable como la recibio.
#   runtime_fake_supports_resume
#     0 (soporta) solo si MEFISTO_FAKE_SUPPORTS_RESUME="1"; 1 en cualquier
#     otro caso, INCLUIDO el default sin fijar -- a proposito: el fake existe
#     para ejercer el runner sin depender de un CLI real, y el default mas
#     seguro para un adaptador de prueba es "sin soporte todavia", el mismo
#     trato que le tocaria a un runtime nuevo que no haya implementado
#     resume. Un test que quiera ejercer el camino de reanudacion fija esta
#     variable explicitamente.
#   runtime_fake_interactive_refresh
#     Retorna 1 sin imprimir si MEFISTO_FAKE_INTERACTIVE_REFRESH esta ausente o
#     vacia; con valor, retorna 0 y lo imprime literalmente como estrategia de
#     refresco interactivo.
#   runtime_fake_translate <raw_file> <runtime_id> <model>
#     Imprime por stdout el JSONL neutral derivado de <raw_file> (una linea
#     por evento, sin emitir "run.started": eso lo hace el runner). El campo
#     `duration_ms` de un evento terminal se emite en null a proposito -- el
#     runner es quien sobreescribe ese campo con el tiempo real medido
#     alrededor de la invocacion completa (ver mefisto-run-agent.sh), nunca un
#     adaptador: ninguno tiene, desde el interior del proceso, el reloj de
#     pared que envuelve al proceso entero.
#
# Este mismo archivo es tambien el "CLI fake" que build_cmd invoca: al
# ejecutarse DIRECTAMENTE (no al ser `source`ado) reproduce el guion que
# indique MEFISTO_FAKE_SCRIPT y termina con el exit code de ese guion. La
# deteccion "sourceado vs. ejecutado" es el idiom estandar de bash
# (BASH_SOURCE[0] == $0 solo cuando el archivo corre como proceso propio).
#
# Guiones soportados via MEFISTO_FAKE_SCRIPT (CA-6):
#   success        Emite message + tool.started/tool.completed + terminal
#                   status=success. Exit 0.
#   slow-success   Emite las MISMAS lineas que "success", byte a byte, pero
#                   con un `sleep ${MEFISTO_FAKE_STEP_DELAY_S:-2}` entre cada
#                   una (issue #924): existe para poder observar en un test el
#                   anexo EN VIVO de mefisto-run-agent.sh a mitad de una
#                   corrida real, algo que "success" no permite por terminar
#                   antes de que transcurra el primer intervalo. La identidad
#                   linea a linea con "success" no es cosmetica: es lo que
#                   deja comparar el --event-log de ambos y afirmar que el
#                   anexo en vivo produce la misma secuencia que el volcado
#                   al cierre (CA-2). Si se cambia un guion hay que cambiar
#                   el otro.
#   fail            Emite terminal status=failed (error.kind=nonzero_exit).
#                   Exit $MEFISTO_FAKE_EXIT_CODE (default 3, debe ser != 0).
#   hang            No termina solo: se queda dormido muy por encima de
#                   cualquier --timeout de prueba, para que el watchdog de
#                   run_agent_with_watchdog lo mate (mismo stand-in de CLI que
#                   test-watchdog-trabajo-util.sh: un `sleep` largo).
#   no-terminal     Emite un mensaje pero NUNCA un evento terminal. Exit 0.
#   two-terminals   Emite DOS eventos terminales validos. Exit 0.
#   malformed       Emite una linea valida y luego una linea JSON truncada a
#                   media escritura (nunca llega a un terminal valido). Exit 1.
#   sensitive-success Emite centinelas representativos de prompt/texto/input y
#                   auth para probar que la persistencia redactada no los deja
#                   pasar. Exit 0.
#   sensitive-fail  Emite un fallo con detail y stderr que contienen centinelas
#                   para probar que solo sobrevive error.kind. Exit no cero.
#   touch-tty       Repro determinista del aislamiento de tty (issue #943):
#                   emite un message, intenta `read -r x </dev/tty`, despues
#                   `stty -echo` (tcsetattr sobre stdin) y despues `read -r y`
#                   de stdin -- los tres disparadores de SIGTTIN/SIGTTOU que
#                   detuvieron un writer real en STAT=T. Ignora los fallos de
#                   las tres (este archivo no usa `set -e`): con terminal de
#                   control, cualquiera de ellas detiene al grupo; sin ella
#                   (sesion nueva + stdin en un archivo regular o /dev/null --
#                   desde #1447 build_cmd declara el canal de stdin, asi que
#                   el `read` de stdin lee una linea del prompt materializado
#                   en vez de ver EOF), fallan rapido y sin senal (ENXIO /
#                   "not a terminal" / EOF o linea leida): ninguna de las dos
#                   variantes es una tty, que es lo unico que #943 necesita.
#                   Termina con terminal status=success. Exit 0.
#   self-stop       Repro determinista del detector STOPPED (issue #945):
#                   emite un message y se auto-detiene con `kill -STOP $$`
#                   (SIGSTOP directo, sin depender de ninguna tty) -- solo un
#                   SIGCONT (nunca otra senal) lo reanuda. Al reanudarse,
#                   sigue con el terminal status=success. Exit 0. A
#                   diferencia de `touch-tty` (que reproduce la CAUSA de
#                   #943), este guion reproduce la CLASE de evento que #945
#                   detecta y sana, sin importar la causa.
#   dump-stdin      Repro determinista del canal de stdin (issue #1447):
#                   emite un message, copia la entrada estandar BYTE A BYTE a
#                   MEFISTO_FAKE_STDIN_DUMP_FILE (si esta vacia, descarta a
#                   /dev/null) y registra si esa entrada era una tty
#                   (`[ -t 0 ]`, ANTES de leerla) como una linea
#                   "STDIN_TTY=0|1" en MEFISTO_FAKE_ARGS_FILE si esta fijada,
#                   o si no en un archivo hermano
#                   "<MEFISTO_FAKE_STDIN_DUMP_FILE>.tty". Termina con terminal
#                   status=success. Exit 0. Existe para que un test pueda
#                   demostrar, de punta a punta, que un prompt de cualquier
#                   tamano viaja por stdin y nunca toca el argv (`exec`,
#                   sujeto a ARG_MAX -- ver runtime_fake_build_cmd arriba).
# Default sin MEFISTO_FAKE_SCRIPT: "success".
#
# Bash 3.2 + jq 1.7: sin arrays asociativos, sin dependencias de red.

runtime_fake_is_available() {
    [ "${MEFISTO_FAKE_AVAILABLE:-}" = "1" ]
}

runtime_fake_default_model() {
    case "$1" in
        fast|balanced|deep) printf '%s' "${MEFISTO_FAKE_DEFAULT_MODEL:-}" ;;
        *) return 1 ;;
    esac
}

runtime_fake_default_effort() {
    case "$1" in
        quick|light|standard|thorough|exhaustive) printf '%s' "${MEFISTO_FAKE_DEFAULT_EFFORT:-}" ;;
        *) return 1 ;;
    esac
}

# --- runtime_fake_build_cmd ---------------------------------------------

runtime_fake_build_cmd() {
    local agent="$1" cwd="$2" prompt_file="$3" model="$4" system_file="$5" resume_session_id="${6:-}" effort="${7:-}"
    # Resuelto contra el propio BASH_SOURCE (no MEFISTO_RUNTIME_LIB_DIR): esta
    # funcion debe encontrar su propio "CLI fake" aunque quien la invoque haya
    # sourceado este archivo desde un directorio de prueba distinto al
    # canonico -- mismo criterio defensivo que el resto de rutas resueltas por
    # BASH_SOURCE en este repo (ver mefisto-state.sh).
    local self
    self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-fake.sh"

    MEFISTO_RUNTIME_CMD=(bash "$self" __mefisto-fake-emit "$agent" "$prompt_file" "$system_file")
    if [ -n "$model" ]; then
        MEFISTO_RUNTIME_CMD+=(--fake-model "$model")
    fi
    if [ -n "$effort" ]; then
        MEFISTO_RUNTIME_CMD+=(--fake-effort "$effort")
    fi
    if [ -n "$resume_session_id" ]; then
        MEFISTO_RUNTIME_CMD+=(--fake-resume "$resume_session_id")
    fi

    # MEFISTO_RUNTIME_STDIN_FILE (CA-4, issue #1447): materializa el prompt
    # (con el system file como prefijo, separado por una linea en blanco, si
    # se paso uno) dentro de MEFISTO_RUNTIME_WORK_DIR y lo declara como canal
    # de stdin. Los guiones existentes ignoran stdin: fijar esta variable no
    # les cambia el comportamiento, solo la consume el guion dump-stdin.
    if [ -n "${MEFISTO_RUNTIME_WORK_DIR:-}" ] && [ -d "$MEFISTO_RUNTIME_WORK_DIR" ]; then
        local stdin_file="$MEFISTO_RUNTIME_WORK_DIR/fake-stdin-prompt"
        if [ -n "$system_file" ] && [ -f "$system_file" ]; then
            cat "$system_file" > "$stdin_file"
            printf '\n\n' >> "$stdin_file"
            cat "$prompt_file" >> "$stdin_file"
        else
            cat "$prompt_file" > "$stdin_file"
        fi
        MEFISTO_RUNTIME_STDIN_FILE="$stdin_file"
    fi
}

# --- runtime_fake_supports_resume ----------------------------------------

runtime_fake_supports_resume() {
    [ "${MEFISTO_FAKE_SUPPORTS_RESUME:-}" = "1" ]
}

# --- runtime_fake_interactive_refresh ------------------------------------

# Conservador como runtime_fake_supports_resume: sin un guion explicito, el
# fake simula que el runtime no conoce una estrategia de refresh interactivo.
# Con valor, lo reenvia literal para que los tests puedan ejercer ambos modos.
runtime_fake_interactive_refresh() {
    [ -n "${MEFISTO_FAKE_INTERACTIVE_REFRESH:-}" ] || return 1
    printf '%s\n' "$MEFISTO_FAKE_INTERACTIVE_REFRESH"
}

# --- runtime_fake_translate ----------------------------------------------

runtime_fake_translate() {
    local raw_file="$1" runtime_id="$2"
    [ -f "$raw_file" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    jq -R -c --arg runtime "$runtime_id" '
        (try fromjson catch empty)
        | select(type == "object")
        | if .fake == "message" then
              {v: 1, type: "message", ts: (now | todate), role: "assistant", text: (.text // "")}
          elif .fake == "tool_start" then
              {v: 1, type: "tool.started", ts: (now | todate), tool: (.tool // "?"), input_summary: (.input_summary // null)}
          elif .fake == "tool_end" then
              {v: 1, type: "tool.completed", ts: (now | todate), tool: (.tool // "?"),
               ok: (.ok // false), duration_ms: (.duration_ms // null)}
          elif .fake == "terminal" and .status == "success" then
              {v: 1, type: "run.completed", ts: (now | todate), status: "success", runtime: $runtime,
               model: (.model // null), session_id: null, duration_ms: null,
                tokens: {input: null, output: null, cache_read: null, cache_write: null, reasoning: null}, estimated_cost_usd: null, turns: null,
               denials: null, ttft_ms: null, api_duration_ms: null, error: null}
          elif .fake == "terminal" and .status == "failed" then
              {v: 1, type: "run.failed", ts: (now | todate), status: "failed", runtime: $runtime,
               model: (.model // null), session_id: null, duration_ms: null,
                tokens: {input: null, output: null, cache_read: null, cache_write: null, reasoning: null}, estimated_cost_usd: null, turns: null,
               denials: null, ttft_ms: null, api_duration_ms: null,
               error: {kind: (.error_kind // "nonzero_exit"), detail: (.error_detail // "fallo del guion fake")}}
          else empty end
    ' "$raw_file" 2>/dev/null
    return 0
}

# --- Modo "CLI fake": logica que corre cuando este archivo se EJECUTA -------

_runtime_fake_emit_main() {
    # Args: __mefisto-fake-emit <agent> <prompt_file> <system_file>
    #       [--fake-model <valor>] [--fake-resume <valor>]

    # MEFISTO_FAKE_ARGS_FILE (issue #968): mismo patron que
    # MEFISTO_CLAUDE_STUB_ARGS_FILE de test-runtime-claude.sh -- un test que
    # necesite comprobar QUE argv exacto recibio el "CLI fake" (p. ej. que
    # --fake-resume llego con el id esperado) lo vuelca aqui, ANTES de
    # descartar ningun token.
    if [ -n "${MEFISTO_FAKE_ARGS_FILE:-}" ]; then
        local a
        : > "$MEFISTO_FAKE_ARGS_FILE"
        for a in "$@"; do
            printf '%s\n' "$a" >> "$MEFISTO_FAKE_ARGS_FILE"
        done
    fi

    shift # descarta el token __mefisto-fake-emit
    shift || true # agent (sin uso: el guion no depende del agente invocado)
    shift || true # prompt_file
    shift || true # system_file

    local fake_model="" fake_effort=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --fake-model) fake_model="${2:-}"; shift 2 ;;
            --fake-effort) fake_effort="${2:-}"; shift 2 ;;
            # --fake-resume se CONSUME sin guardarse: ningun guion del fake
            # cambia por reanudar (no modela una sesion con memoria), y lo
            # unico que un test comprueba de el es que llego al argv -- eso
            # ya quedo volcado en MEFISTO_FAKE_ARGS_FILE mas arriba.
            --fake-resume) shift 2 ;;
            *) shift ;;
        esac
    done

    local model_json="null" effort_json="null"
    [ -n "$fake_model" ] && model_json="$(printf '%s' "$fake_model" | jq -Rr '@json' 2>/dev/null)"
    [ -n "$fake_effort" ] && effort_json="$(printf '%s' "$fake_effort" | jq -Rr '@json' 2>/dev/null)"

    case "${MEFISTO_FAKE_SCRIPT:-success}" in
        success)
            echo '{"fake":"message","text":"hola desde el guion fake"}'
            echo '{"fake":"tool_start","tool":"demo"}'
            echo '{"fake":"tool_end","tool":"demo","ok":true,"duration_ms":5}'
            printf '{"fake":"terminal","status":"success","model":%s,"effort":%s}\n' "$model_json" "$effort_json"
            exit 0
            ;;
        slow-success)
            local step_delay="${MEFISTO_FAKE_STEP_DELAY_S:-2}"
            echo '{"fake":"message","text":"hola desde el guion fake"}'
            sleep "$step_delay"
            echo '{"fake":"tool_start","tool":"demo"}'
            sleep "$step_delay"
            echo '{"fake":"tool_end","tool":"demo","ok":true,"duration_ms":5}'
            sleep "$step_delay"
            printf '{"fake":"terminal","status":"success","model":%s,"effort":%s}\n' "$model_json" "$effort_json"
            exit 0
            ;;
        fail)
            printf '{"fake":"terminal","status":"failed","model":%s,"effort":%s,"error_kind":"nonzero_exit","error_detail":"guion fail"}\n' "$model_json" "$effort_json"
            exit "${MEFISTO_FAKE_EXIT_CODE:-3}"
            ;;
        hang)
            echo '{"fake":"message","text":"colgando hasta que el watchdog mate el proceso"}'
            sleep 3600
            ;;
        no-terminal)
            echo '{"fake":"message","text":"nunca emite un evento terminal"}'
            exit 0
            ;;
        two-terminals)
            printf '{"fake":"terminal","status":"success","model":%s,"effort":%s}\n' "$model_json" "$effort_json"
            printf '{"fake":"terminal","status":"failed","model":%s,"effort":%s,"error_kind":"nonzero_exit","error_detail":"segundo terminal"}\n' "$model_json" "$effort_json"
            exit 0
            ;;
        malformed)
            echo '{"fake":"message","text":"antes del corte"}'
            printf '{"fake":"terminal","status":"suc'
            exit 1
            ;;
        sensitive-success)
            echo '{"fake":"message","text":"PROMPT_SENTINEL ASSISTANT_SENTINEL AUTH_TOKEN_SENTINEL HEADER_SENTINEL"}'
            echo '{"fake":"tool_start","tool":"Bash","input_summary":"COMMAND_SENTINEL input"}'
            echo '{"fake":"tool_end","tool":"Bash","ok":true,"duration_ms":5}'
            printf '{"fake":"terminal","status":"success","model":%s,"effort":%s}\n' "$model_json" "$effort_json"
            exit 0
            ;;
        sensitive-fail)
            echo '{"fake":"message","text":"ASSISTANT_SENTINEL"}'
            printf '{"fake":"terminal","status":"failed","model":%s,"effort":%s,"error_kind":"api_error","error_detail":"STDERR_SENTINEL AUTH_TOKEN_SENTINEL"}\n' "$model_json" "$effort_json"
            echo 'STDERR_SENTINEL HEADER_SENTINEL AUTH_TOKEN_SENTINEL' >&2
            exit "${MEFISTO_FAKE_EXIT_CODE:-3}"
            ;;
        touch-tty)
            echo '{"fake":"message","text":"tocando la tty antes de terminar"}'
            read -r _touch_tty_x </dev/tty
            stty -echo
            read -r _touch_tty_y
            printf '{"fake":"terminal","status":"success","model":%s,"effort":%s}\n' "$model_json" "$effort_json"
            exit 0
            ;;
        self-stop)
            echo '{"fake":"message","text":"a punto de auto-detenerme con SIGSTOP"}'
            kill -STOP $$
            printf '{"fake":"terminal","status":"success","model":%s,"effort":%s}\n' "$model_json" "$effort_json"
            exit 0
            ;;
        dump-stdin)
            echo '{"fake":"message","text":"volcando stdin a MEFISTO_FAKE_STDIN_DUMP_FILE"}'
            # [ -t 0 ] ANTES de leer nada de stdin: la comprobacion no
            # consume datos, pero se deja constancia antes del `cat` para que
            # el orden del guion refleje el orden del check real.
            local stdin_is_tty=0
            [ -t 0 ] && stdin_is_tty=1
            if [ -n "${MEFISTO_FAKE_ARGS_FILE:-}" ]; then
                printf 'STDIN_TTY=%s\n' "$stdin_is_tty" >> "$MEFISTO_FAKE_ARGS_FILE"
            elif [ -n "${MEFISTO_FAKE_STDIN_DUMP_FILE:-}" ]; then
                printf '%s\n' "$stdin_is_tty" > "${MEFISTO_FAKE_STDIN_DUMP_FILE}.tty"
            fi
            if [ -n "${MEFISTO_FAKE_STDIN_DUMP_FILE:-}" ]; then
                cat > "$MEFISTO_FAKE_STDIN_DUMP_FILE"
            else
                cat > /dev/null
            fi
            printf '{"fake":"terminal","status":"success","model":%s,"effort":%s}\n' "$model_json" "$effort_json"
            exit 0
            ;;
        *)
            echo "runtime-fake.sh: MEFISTO_FAKE_SCRIPT desconocido: '${MEFISTO_FAKE_SCRIPT:-}'" >&2
            exit 2
            ;;
    esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    _runtime_fake_emit_main "$@"
fi
