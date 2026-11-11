#!/usr/bin/env bash
# test-watchdog-tty-isolation.sh -- Repro determinista de la clase de bug de
# issue #943: aislar el tty en la invocacion del adaptador para que ninguna
# tool Bash del agente quede suspendida por SIGTTIN/SIGTTOU.
#
# Contexto: en el batch de #928 (2026-09-06) un writer quedo 15 minutos
# detenido (STAT=T) porque una tool Bash del agente accedio a la terminal
# (read </dev/tty, stty/tcsetattr, o lectura de stdin heredado) mientras
# corria en un grupo de procesos que NO era el grupo en primer plano de la
# pty del pane -- el kernel detiene al grupo ENTERO con SIGTTIN/SIGTTOU en
# ese caso. El arreglo (_mefisto-common.sh, run_agent_with_watchdog) lanza el
# comando en una sesion nueva (setsid o su fallback Perl) sin terminal de
# control y con stdin desde /dev/null -- o desde el archivo regular que un
# adaptador declare en MEFISTO_RUNTIME_STDIN_FILE (issue #1447), que tampoco
# es una tty: sin terminal de control, SIGTTIN/SIGTTOU son imposibles.
#
# Casos cubiertos:
#   [CA-3] Repro determinista dentro de una pty real: el guion
#       'touch-tty' de runtime-fake.sh (message + read </dev/tty + stty -echo
#       + read de stdin, terminal success) corre bajo
#       mefisto-run-agent.sh --timeout 20 y jamas deja un proceso del arbol en
#       STAT=T -- exit 0, run.completed presente, duracion < 20s.
#   [control] El MISMO guion, lanzado con el patron VIEJO (set -m + '&' sin
#       setsid, sin aislar stdin) replicado inline en este test, SI deja el
#       grupo en STAT=T -- demuestra que la pty del test ejercita el
#       mecanismo real y que [CA-3] no pasa en vacio.
#   [CA-4] Degradacion explicita: con un PATH que no expone `setsid` ni
#       `perl`, run_agent_with_watchdog cae al patron viejo (set -m +
#       /dev/null) pero deja una linea WARN en events_log, nunca en silencio.
#   [945-CA-3] Detector de procesos detenidos (issue #945), dentro de la
#       misma pty real: el guion 'self-stop' de runtime-fake.sh (message +
#       `kill -STOP $$`, terminal success al reanudarse) corre bajo
#       run_agent_with_watchdog --timeout 30 y termina exit 0 en <30s con
#       exactamente una linea 'STOPPED:' en events_log -- el polling detecta
#       el STAT=T y manda SIGCONT al grupo.
#   [945-control] El MISMO guion 'self-stop', bajo el patron VIEJO (un solo
#       `sleep` sin polling ni SIGCONT) replicado inline: el proceso SI queda
#       en STAT=T, nunca imprime su evento terminal, y solo el kill de
#       timeout lo termina -- demuestra que [945-CA-3] no pasa en vacio.
#
# La pty real la da fixtures/pty-run.py (python3, modulo `pty`): corre cada
# guion como lider de una sesion nueva con terminal de control. Si `python3`
# no esta en PATH, el test FALLA con un mensaje explicito -- nunca se salta
# en silencio (CA-3): sin una pty real no hay forma de ejercitar
# SIGTTIN/SIGTTOU.
#
# Uso: .claude/scripts/tests/test-watchdog-tty-isolation.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DIR="$REPO_ROOT/src/runtime/lib"
RUNNER="$REPO_ROOT/src/runtime/mefisto-run-agent.sh"
FAKE_LIB="$LIB_DIR/runtime-fake.sh"
COMMON_LIB="$REPO_ROOT/.claude/scripts/_mefisto-common.sh"
PTY_RUN="$SCRIPT_DIR/fixtures/pty-run.py"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "FAIL: python3 no esta en PATH -- este test EXIGE una pty real para ejercitar SIGTTIN/SIGTTOU (issue #943); no puede saltarse en silencio" >&2
    exit 1
fi

TMP=$(mktemp -d)
PTY_PIDS=()
CTRL_PID=""
CTRL_STOP_PID=""

# pty_start <script> -- corre <script> en una pty real y deja en PTY_PID el
# PID del envoltorio.
pty_start() {
    python3 "$PTY_RUN" -- "$1" </dev/null >/dev/null 2>&1 &
    PTY_PID=$!
    PTY_PIDS+=("$PTY_PID")
}

# pty_stop <pid> -- cierra la pty: el kernel manda SIGHUP a su sesion.
pty_stop() {
    kill "$1" 2>/dev/null
    wait "$1" 2>/dev/null
    return 0
}

cleanup() {
    local pid
    for pid in ${PTY_PIDS[@]+"${PTY_PIDS[@]}"}; do
        pty_stop "$pid"
    done
    [ -n "$CTRL_PID" ] && kill -9 -"$CTRL_PID" 2>/dev/null
    [ -n "$CTRL_STOP_PID" ] && kill -9 -"$CTRL_STOP_PID" 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT

# any_stopped <marker> -- exit 0 si algun proceso vivo cuyo argv contiene
# <marker> esta en STAT=T (detenido), 1 si ninguno lo esta. El anclaje `^[Tt]`
# no es cosmetico: el estado va SIEMPRE en el primer caracter de STAT y los
# flags que le siguen (`s`, `+`, `N`, `<`...) no incluyen ninguna T -- un
# `/T/` suelto podria dar un falso positivo sobre un flag futuro y volver el
# test flaky en la direccion peor (fallar cuando el arreglo funciona).
any_stopped() {
    local marker="$1"
    ps -axo stat=,command= 2>/dev/null | awk -v m="$marker" '
        index($0, m) > 0 && $1 ~ /^[Tt]/ { found=1 }
        END { exit(found ? 0 : 1) }
    '
}

# ============================================================================
echo "[CA-3] mefisto-run-agent.sh + guion touch-tty dentro de una pty real"

WORKDIR_A="$TMP/wt-a"; mkdir -p "$WORKDIR_A"
PROMPT_FILE="$TMP/prompt.txt"; echo "prompt de prueba" > "$PROMPT_FILE"
SYSTEM_FILE="$TMP/system.txt"; echo "system de prueba" > "$SYSTEM_FILE"
EVENT_LOG_A="$TMP/event-log-a.jsonl"
RC_A="$TMP/rc-a"
DONE_A="$TMP/done-a"

RUN_SCRIPT_A="$TMP/run-a.sh"
cat > "$RUN_SCRIPT_A" <<EOF
#!/usr/bin/env bash
MEFISTO_FAKE_SCRIPT=touch-tty "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR_A" --prompt-file "$PROMPT_FILE" --event-log "$EVENT_LOG_A" --timeout 20
echo \$? > "$RC_A"
touch "$DONE_A"
EOF
chmod +x "$RUN_SCRIPT_A"

START_A=$(date +%s)
pty_start "$RUN_SCRIPT_A"
PTY_A=$PTY_PID

SEEN_T_A=false
i=0
while [ "$i" -lt 400 ]; do
    [ -f "$DONE_A" ] && break
    if any_stopped "$TMP"; then
        SEEN_T_A=true
    fi
    sleep 0.05
    i=$((i + 1))
done
# Una ultima pasada tras ver DONE_A: el `break` no espera un tick mas, asi que
# una ventana de STAT=T justo antes del cierre podria perderse sin este check.
if any_stopped "$TMP"; then
    SEEN_T_A=true
fi
END_A=$(date +%s)
DURATION_A=$((END_A - START_A))

if [ "$SEEN_T_A" = "false" ]; then
    pass "CA-3-1: ningun proceso del arbol quedo en STAT=T durante la corrida (sesion nueva, sin terminal de control)"
else
    fail "CA-3-1: se observo STAT=T en el arbol -- la sesion nueva no aislo la tty"
fi

if [ -f "$DONE_A" ]; then
    pass "CA-3-2: la corrida termino dentro de la ventana de espera (< 20s)"
else
    fail "CA-3-2: la corrida no termino tras 20s de espera activa"
fi

RC_VAL_A="$(cat "$RC_A" 2>/dev/null || echo "?")"
if [ "$RC_VAL_A" = "0" ]; then
    pass "CA-3-3: mefisto-run-agent.sh termino con exit 0"
else
    fail "CA-3-3: exit '$RC_VAL_A' (esperaba 0)"
fi

if [ "$DURATION_A" -lt 20 ]; then
    pass "CA-3-4: duracion total ${DURATION_A}s < 20s"
else
    fail "CA-3-4: duracion total ${DURATION_A}s >= 20s"
fi

if [ -s "$EVENT_LOG_A" ] && jq -e 'select(.type=="run.completed")' "$EVENT_LOG_A" >/dev/null 2>&1; then
    pass "CA-3-5: --event-log trae un evento run.completed"
else
    fail "CA-3-5: no se encontro run.completed en --event-log: $(cat "$EVENT_LOG_A" 2>/dev/null)"
fi

pty_stop "$PTY_A"

# ============================================================================
echo ""
echo "[control] el patron VIEJO (set -m + '&' sin setsid, sin aislar stdin) SI detiene el grupo"

WORKDIR_CTRL="$TMP/wt-ctrl"; mkdir -p "$WORKDIR_CTRL"
CTRL_STDOUT="$TMP/ctrl-stdout.log"
CTRL_STDERR="$TMP/ctrl-stderr.log"
CTRL_PIDFILE="$TMP/ctrl.pid"

RUN_SCRIPT_CTRL="$TMP/run-ctrl.sh"
cat > "$RUN_SCRIPT_CTRL" <<EOF
#!/usr/bin/env bash
set -m
( cd "$WORKDIR_CTRL" && MEFISTO_FAKE_SCRIPT=touch-tty bash "$FAKE_LIB" __mefisto-fake-emit test-agent "$PROMPT_FILE" "$SYSTEM_FILE" ) >"$CTRL_STDOUT" 2>"$CTRL_STDERR" &
echo \$! > "$CTRL_PIDFILE"
set +m
sleep 30
EOF
chmod +x "$RUN_SCRIPT_CTRL"

pty_start "$RUN_SCRIPT_CTRL"
PTY_CTRL=$PTY_PID

SEEN_T_CTRL=false
i=0
while [ "$i" -lt 100 ]; do
    if any_stopped "$TMP"; then
        SEEN_T_CTRL=true
        break
    fi
    sleep 0.05
    i=$((i + 1))
done

if [ "$SEEN_T_CTRL" = "true" ]; then
    pass "control-1: el patron viejo SI deja el grupo en STAT=T (la pty del test ejercita el mecanismo, CA-3 no pasa en vacio)"
else
    fail "control-1: el patron viejo NO dejo el grupo en STAT=T -- la pty del test no esta ejercitando SIGTTIN/SIGTTOU"
fi

CTRL_PID="$(cat "$CTRL_PIDFILE" 2>/dev/null || echo "")"
[ -n "$CTRL_PID" ] && kill -9 -"$CTRL_PID" 2>/dev/null
pty_stop "$PTY_CTRL"

# ============================================================================
echo ""
echo "[945-CA-3] run_agent_with_watchdog detecta un proceso auto-detenido (guion self-stop) y lo reanuda con SIGCONT"

# shellcheck source=/dev/null
source "$COMMON_LIB" 2>/dev/null

WORKDIR_STOP="$TMP/wt-stop"; mkdir -p "$WORKDIR_STOP"
EVENTS_STOP="$TMP/events-stop.log"
SIGNAL_STOP="$TMP/signal-stop"
RC_STOP="$TMP/rc-stop"
DONE_STOP="$TMP/done-stop"

RUN_SCRIPT_STOP="$TMP/run-stop.sh"
cat > "$RUN_SCRIPT_STOP" <<EOF
#!/usr/bin/env bash
# shellcheck source=/dev/null
source "$COMMON_LIB" 2>/dev/null
EXIT_STOP=\$(MEFISTO_FAKE_SCRIPT=self-stop run_agent_with_watchdog "$WORKDIR_STOP" 30 "$TMP/stop-stdout.log" "$TMP/stop-stderr.log" "$EVENTS_STOP" "writer" "$SIGNAL_STOP" bash "$FAKE_LIB" __mefisto-fake-emit test-agent "$PROMPT_FILE" "$SYSTEM_FILE")
echo "\$EXIT_STOP" > "$RC_STOP"
touch "$DONE_STOP"
EOF
chmod +x "$RUN_SCRIPT_STOP"

START_STOP=$(date +%s)
pty_start "$RUN_SCRIPT_STOP"
PTY_STOP=$PTY_PID

i=0
while [ "$i" -lt 620 ]; do
    [ -f "$DONE_STOP" ] && break
    sleep 0.05
    i=$((i + 1))
done
END_STOP=$(date +%s)
DURATION_STOP=$((END_STOP - START_STOP))
pty_stop "$PTY_STOP"

if [ -f "$DONE_STOP" ]; then
    pass "945-CA-3-1: la corrida termino dentro de la ventana de espera (< 31s)"
else
    fail "945-CA-3-1: la corrida no termino tras 31s de espera activa"
fi

RC_VAL_STOP="$(cat "$RC_STOP" 2>/dev/null || echo "?")"
if [ "$RC_VAL_STOP" = "0" ]; then
    pass "945-CA-3-2: run_agent_with_watchdog termino con exit 0 (el guion se reanudo y llego a su terminal success)"
else
    fail "945-CA-3-2: exit '$RC_VAL_STOP' (esperaba 0)"
fi

if [ "$DURATION_STOP" -lt 30 ]; then
    pass "945-CA-3-3: duracion total ${DURATION_STOP}s < 30s"
else
    fail "945-CA-3-3: duracion total ${DURATION_STOP}s >= 30s"
fi

STOPPED_LINES=$(grep -c "STOPPED:" "$EVENTS_STOP" 2>/dev/null || echo 0)
if [ "$STOPPED_LINES" = "1" ]; then
    pass "945-CA-3-4: events_log contiene exactamente una linea STOPPED:"
else
    fail "945-CA-3-4: events_log tiene $STOPPED_LINES linea(s) STOPPED: (esperaba 1): $(cat "$EVENTS_STOP" 2>/dev/null)"
fi

# No se afirma "el events_log tiene UNA sola linea": en una maquina sin
# `setsid` ni `perl` la funcion degrada y escribe ademas su linea WARN (CA-4),
# perfectamente legitima. Lo que importa aqui es lo especifico: la STOPPED
# trae su "SIGCONT enviado" y NO hay ningun TIMEOUT (el detector reanudo al
# proceso a tiempo, no lo mato el presupuesto).
if grep -q "SIGCONT enviado" "$EVENTS_STOP" 2>/dev/null && ! grep -q "TIMEOUT:" "$EVENTS_STOP" 2>/dev/null; then
    pass "945-CA-3-5: la linea STOPPED trae 'SIGCONT enviado' y no hay ninguna linea TIMEOUT"
else
    fail "945-CA-3-5: events_log sin 'SIGCONT enviado' o con un TIMEOUT espurio: $(cat "$EVENTS_STOP" 2>/dev/null)"
fi

# ============================================================================
echo ""
echo "[945-control] sin polling+SIGCONT, el guion self-stop se queda detenido y solo un kill de timeout lo termina"

WORKDIR_STOP_CTRL="$TMP/wt-stop-ctrl"; mkdir -p "$WORKDIR_STOP_CTRL"
CTRL_STOP_STDOUT="$TMP/ctrl-stop-stdout.log"
CTRL_STOP_STDERR="$TMP/ctrl-stop-stderr.log"
CTRL_STOP_PIDFILE="$TMP/ctrl-stop.pid"
# Holgado a proposito: el kill del "watchdog viejo" no puede aterrizar antes
# de que la espera activa de abajo (hasta ~3s de reloj, 60 vueltas de 0.05s
# mas el fork de `ps` de cada una) alcance a ver el STAT=T. Con 2s, una
# maquina cargada mataba al proceso antes de observarlo y 945-control-1
# fallaba de forma intermitente en la direccion peor: por carrera del test, no
# por el comportamiento bajo prueba.
CTRL_STOP_TIMEOUT=8

RUN_SCRIPT_STOP_CTRL="$TMP/run-stop-ctrl.sh"
cat > "$RUN_SCRIPT_STOP_CTRL" <<EOF
#!/usr/bin/env bash
set -m
( cd "$WORKDIR_STOP_CTRL" && MEFISTO_FAKE_SCRIPT=self-stop bash "$FAKE_LIB" __mefisto-fake-emit test-agent "$PROMPT_FILE" "$SYSTEM_FILE" ) >"$CTRL_STOP_STDOUT" 2>"$CTRL_STOP_STDERR" &
echo \$! > "$CTRL_STOP_PIDFILE"
set +m
# Watchdog VIEJO (pre-#945): un solo sleep, sin polling ni SIGCONT.
sleep $CTRL_STOP_TIMEOUT
kill -9 -\$(cat "$CTRL_STOP_PIDFILE") 2>/dev/null
sleep 30
EOF
chmod +x "$RUN_SCRIPT_STOP_CTRL"

pty_start "$RUN_SCRIPT_STOP_CTRL"
PTY_STOP_CTRL=$PTY_PID

SEEN_T_STOP_CTRL=false
i=0
while [ "$i" -lt 60 ]; do
    if any_stopped "$TMP"; then
        SEEN_T_STOP_CTRL=true
        break
    fi
    sleep 0.05
    i=$((i + 1))
done

if [ "$SEEN_T_STOP_CTRL" = "true" ]; then
    pass "945-control-1: el guion self-stop SI queda en STAT=T (kill -STOP funciona, el escenario no es vacio)"
else
    fail "945-control-1: nunca se observo STAT=T -- el guion self-stop no se detuvo"
fi

# Espera acotada POR CONDICION (no un `sleep` fijo) a que el kill -9 del
# "watchdog viejo" aterrice: termina apenas el proceso muere, y solo agota el
# techo si de verdad sobrevivio.
CTRL_STOP_PID="$(cat "$CTRL_STOP_PIDFILE" 2>/dev/null || echo "")"
i=0
while [ "$i" -lt $(( (CTRL_STOP_TIMEOUT + 3) * 20 )) ]; do
    [ -n "$CTRL_STOP_PID" ] && ! kill -0 "$CTRL_STOP_PID" 2>/dev/null && break
    sleep 0.05
    i=$((i + 1))
done

if [ -n "$CTRL_STOP_PID" ] && ! kill -0 "$CTRL_STOP_PID" 2>/dev/null; then
    pass "945-control-2: sin SIGCONT, el kill de timeout es lo unico que termina al proceso detenido"
else
    fail "945-control-2: el proceso self-stop deberia estar muerto tras el timeout viejo"
fi

if ! grep -q '"terminal"' "$CTRL_STOP_STDOUT" 2>/dev/null; then
    pass "945-control-3: sin el detector, el guion NUNCA llega a imprimir su evento terminal (muere detenido)"
else
    fail "945-control-3: el guion self-stop imprimio su terminal pese a no recibir SIGCONT -- el control no es valido"
fi

pty_stop "$PTY_STOP_CTRL"
[ -n "$CTRL_STOP_PID" ] && kill -9 -"$CTRL_STOP_PID" 2>/dev/null

# ============================================================================
echo ""
echo "[CA-4] degradacion explicita: sin setsid ni perl en PATH, cae a set -m + WARN"

# shellcheck source=/dev/null
source "$COMMON_LIB" 2>/dev/null

BIN_NONE="$TMP/bin-none-degraded"; mkdir -p "$BIN_NONE"
for tool in rm sleep touch date; do
    src="$(command -v "$tool" 2>/dev/null)"
    [ -n "$src" ] && ln -sf "$src" "$BIN_NONE/$tool"
done

WT_DEG="$TMP/wt-degraded"; mkdir -p "$WT_DEG"
DEG_EVENTS="$TMP/degraded-events.log"
ORIG_PATH_DEG="$PATH"
PATH="$BIN_NONE"
EXIT_DEG=$(run_agent_with_watchdog "$WT_DEG" 5 "$TMP/deg-stdout.log" "$TMP/deg-stderr.log" "$DEG_EVENTS" "writer" "$TMP/deg-signal" \
    /bin/echo hola)
PATH="$ORIG_PATH_DEG"

if [ "$EXIT_DEG" = "0" ]; then
    pass "CA-4-1: sin setsid ni perl en PATH, el comando corre igual y su exit code viaja intacto"
else
    fail "CA-4-1: se esperaba exit 0, se obtuvo '$EXIT_DEG'"
fi

if grep -q "WARN: writer corre con terminal de control (sin setsid ni perl)" "$DEG_EVENTS" 2>/dev/null; then
    pass "CA-4-2: la degradacion deja constancia explicita (WARN) en events_log, nunca en silencio"
else
    fail "CA-4-2: no se encontro la linea WARN en events_log: $(cat "$DEG_EVENTS" 2>/dev/null)"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
