#!/usr/bin/env bash
# Ejecucion vigilada neutral. Fuente unica del watchdog headless (issue #1045).
# Preserva argv sin eval, separa stdout/stderr y aisla la terminal de control.
#
# MEFISTO_RUNTIME_STDIN_FILE (issue #1447): variable global opcional, con
# default "" == /dev/null (comportamiento de siempre). Si un adaptador la fija
# a la ruta de un archivo regular legible (ver mefisto-run-agent.sh, que la
# valida ANTES de invocar esta funcion), las tres ramas de abajo conectan ESE
# archivo a la entrada estandar del proceso en vez de /dev/null -- el canal de
# stdin que #1447 abre para transportar un prompt sin pasar por el argv
# (sujeto a ARG_MAX). Se prefirio una variable global sobre un octavo
# posicional: la firma de 7 posicionales + argv ya la consumen
# test-watchdog-tty-isolation.sh, test-watchdog-trabajo-util.sh,
# test-stream-json-trace.sh y test-agent-retry.sh. Un archivo regular nunca es
# TTY, asi que el aislamiento de #943 (SIGTTIN/SIGTTOU imposibles) se
# conserva sin condiciones.

run_agent_with_watchdog() {
    local workdir="$1" timeout_s="$2" stdout_file="$3" stderr_file="$4" events_log="$5" label="$6" signal_file="$7"
    shift 7

    rm -f "$signal_file"

    # MEFISTO_WATCHDOG_TERMINATE_FILE (issue #2472): variable global opcional,
    # mismo patron que MEFISTO_RUNTIME_STDIN_FILE (la firma de 7 posicionales no
    # cambia). Si apunta a un archivo que EXISTE en una rebanada del watchdog,
    # alguien pidio terminar el proceso porque ya declaro exito pero no sale:
    # SIGTERM al grupo y, si sigue vivo 10 s despues, SIGKILL. No es un timeout:
    # no deja <signal_file> ni toca el reloj. Sin la variable (o sin el archivo)
    # el comportamiento es el de siempre. Se lee una vez, aqui, para que el
    # subshell del watchdog herede un valor estable.
    local terminate_file="${MEFISTO_WATCHDOG_TERMINATE_FILE:-}"

    local pid
    if command -v setsid >/dev/null 2>&1; then
        ( cd "$workdir" && exec setsid "$@" ) <"${MEFISTO_RUNTIME_STDIN_FILE:-/dev/null}" >"$stdout_file" 2>"$stderr_file" &
        pid=$!
    elif command -v perl >/dev/null 2>&1; then
        ( cd "$workdir" && exec perl -e 'use POSIX; POSIX::setsid() or die; exec @ARGV' -- "$@" ) <"${MEFISTO_RUNTIME_STDIN_FILE:-/dev/null}" >"$stdout_file" 2>"$stderr_file" &
        pid=$!
    else
        echo "[$(date +%H:%M:%S)] WARN: $label corre con terminal de control (sin setsid ni perl): riesgo de SIGTTIN" >> "$events_log"
        set -m
        ( cd "$workdir" && "$@" ) <"${MEFISTO_RUNTIME_STDIN_FILE:-/dev/null}" >"$stdout_file" 2>"$stderr_file" &
        pid=$!
        set +m
    fi

    # <poll_s> tiene que ser un entero >= 1. Con 0 (o con un valor no numerico,
    # donde el `sleep` falla al instante y la aritmetica no avanza) <elapsed>
    # nunca crece: el watchdog giraria para siempre forkeando `ps` y jamas
    # dispararia el TIMEOUT. Una variable de entorno mal puesta no puede
    # desarmar en silencio el unico limite de presupuesto del pipeline, asi que
    # cualquier valor invalido cae al default y el 0 se eleva al minimo.
    local poll_s="${MEFISTO_WATCHDOG_POLL_S:-5}"
    case "$poll_s" in
        ''|*[!0-9]*) poll_s=5 ;;
        0) poll_s=1 ;;
    esac

    set -m
    (
        # CA-1 (#945): rebanadas de <poll_s> en vez de un solo
        # `sleep <timeout_s>` -- cada rebanada es una oportunidad de revisar
        # si el grupo quedo detenido (ver CA-6 en la cabecera de esta
        # funcion) sin retrasar el disparo de TIMEOUT: la ultima rebanada se
        # recorta para que la suma de todas nunca exceda <timeout_s>.
        elapsed=0
        while [ "$elapsed" -lt "$timeout_s" ]; do
            slice="$poll_s"
            remaining=$((timeout_s - elapsed))
            [ "$slice" -gt "$remaining" ] && slice="$remaining"
            sleep "$slice"
            elapsed=$((elapsed + slice))

            # Solicitud de terminacion (#2472). La linea de evento va ANTES de
            # las senales, por la misma razon que STOPPED: apenas el grupo
            # muere, el caller cancela este watchdog con un SIGKILL. CONT tras
            # TERM porque un grupo detenido no entrega TERM hasta reanudarse.
            if [ -n "$terminate_file" ] && [ -f "$terminate_file" ]; then
                echo "[$(date +%H:%M:%S)] TERMINATE: $label -- SIGTERM al grupo por solicitud" >> "$events_log"
                kill -TERM -"$pid" 2>/dev/null
                kill -CONT -"$pid" 2>/dev/null
                term_waited=0
                while [ "$term_waited" -lt 10 ] && kill -0 -"$pid" 2>/dev/null; do
                    sleep 1
                    term_waited=$((term_waited + 1))
                done
                kill -0 -"$pid" 2>/dev/null && kill -9 -"$pid" 2>/dev/null
                exit 0
            fi

            # CA-2 (#945): STAT empieza por T/t cuando el proceso esta detenido
            # (SIGSTOP/SIGTSTP/SIGTTIN/SIGTTOU). `ps -eo pid=,pgid=,stat=`
            # filtrado por PGID con awk, no `ps -g` (su significado difiere
            # entre BSD/macOS y GNU/Linux).
            # El conteo lo cierra el propio awk (`END { print n + 0 }`) y no un
            # `| wc -l | tr -d ' '`: son dos forks menos por rebanada -- lo
            # unico que este lazo agrega al presupuesto de TIMEOUT, y se paga
            # una vez cada <poll_s> durante toda la corrida del agente.
            stopped_count=$(ps -eo pid=,pgid=,stat= 2>/dev/null | awk -v pgid="$pid" '$2 == pgid && $3 ~ /^[Tt]/ { n++ } END { print n + 0 }')
            if [ "${stopped_count:-0}" -gt 0 ]; then
                # El evento se escribe ANTES del CONT, no despues: apenas se
                # reanuda, el grupo puede terminar de inmediato y el caller
                # (wait "$pid") cancela este watchdog con un SIGKILL de grupo
                # -- si el `echo` fuera posterior al `kill -CONT`, esa
                # cancelacion podria alcanzar al watchdog antes de que
                # llegara a escribir su propia linea, perdiendo el evento.
                # Nunca otra senal que CONT por este camino: reanudar, no
                # terminar -- el grupo puede seguir trabajando.
                echo "[$(date +%H:%M:%S)] STOPPED: $label tenia $stopped_count proceso(s) detenido(s) -- SIGCONT enviado" >> "$events_log"
                kill -CONT -"$pid" 2>/dev/null
            fi
        done

        # `: >` (builtin, sin fork) y no `touch`: un `touch` es un proceso
        # externo, y si el SIGKILL con que esta funcion cancela al watchdog
        # aterriza justo entre el fork y el exit de ese `touch`, el binario
        # queda HUERFANO y termina de crear <signal_file> DESPUES del
        # `rm -f "$signal_file"` de la rama de cancelacion -- una senal de
        # timeout para un stage que termino bien, que el caller clasifica
        # como TIMEOUT y descarta trabajo bueno. Medido en la rama de #943:
        # 2-4 senales espurias por cada 300 corridas cortas con `touch`
        # (bloque C-6 de test-watchdog-trabajo-util.sh, fallo intermitente
        # que precede a este issue), cero con la redireccion builtin, que se
        # completa dentro del propio proceso del watchdog y por tanto nunca
        # sobrevive al kill.
        : > "$signal_file" 2>/dev/null
        kill -9 -"$pid" 2>/dev/null
        echo "[$(date +%H:%M:%S)] TIMEOUT: $label supero ${timeout_s}s" >> "$events_log"
    ) </dev/null >/dev/null 2>&1 &
    local watchdog_pid=$!
    set +m

    local exit_code=0
    wait "$pid" || exit_code=$?

    # Si <signal_file> ya existe aqui, el watchdog fue quien mato a <pid> --
    # esta a mitad de escribir su evento TIMEOUT (la senal precede al kill en
    # su propio cuerpo, en el mismo proceso, sin concurrencia posible entre
    # ambos). Una senal nuestra en ese instante podria cortarlo antes de
    # llegar al `echo` incondicional (CA-2) -- se lo deja terminar solo, NUNCA
    # se lo mata; solo se cancela el watchdog cuando <pid> termino por su
    # cuenta y el watchdog sigue dormido en el `sleep`.
    if [ -f "$signal_file" ]; then
        wait "$watchdog_pid" 2>/dev/null || true
    else
        kill -9 -"$watchdog_pid" 2>/dev/null || true
        # Respaldo al PID pelado por si el kill al GRUPO no alcanzo al
        # watchdog (medido: el `sleep` sobrevive al kill de grupo en ~2% de
        # las corridas cortas, ver mas abajo). Deja huerfano el `sleep` -- mal
        # menor frente a un watchdog vivo que dentro de 30 min haria
        # `kill -9` sobre un PGID ya reciclado por un proceso ajeno.
        kill -9 "$watchdog_pid" 2>/dev/null || true
        wait "$watchdog_pid" 2>/dev/null || true
        # Carrera del watchdog perdido: entre que `wait` retorno y este `kill`
        # aterrizo, un watchdog que sobrevivio a su `sleep` alcanza a hacer su
        # senal -- y deja <signal_file> creado para un stage que en realidad
        # termino solo. El caller lo leeria como TIMEOUT y descartaria trabajo
        # bueno (se observo como "TIMEOUT (0s, exit 0)" en el bloque G de
        # test-tooling-state-paths.sh, ~40% de las corridas cuando el CLI
        # responde en menos de un segundo). Aqui ya se decidio que el watchdog
        # NO habia disparado cuando el proceso termino -- esa es la rama else
        # --, asi que cualquier senal posterior es ruido y se borra. El caso
        # legitimo (el watchdog SI disparo) va por la rama de arriba y su
        # senal nunca se toca.
        rm -f "$signal_file"
    fi

    echo "$exit_code"
}
