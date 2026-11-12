#!/usr/bin/env bash
# test-watchdog-trabajo-util.sh -- Tests del watchdog de timeout y del
# criterio de recuperacion "has_work" de run_agent() (issue #424).
#
# Contexto: dos grietas de correctitud, ambas con evidencia en el historico.
#
#   1. El watchdog no mataba nada y su mensaje nunca se escribia. `kill -9
#      -$CLAUDE_PID` apunta al GRUPO de procesos, pero el subshell lanzado con
#      `&` no era lider de grupo (heredaba el PGID del script) -- el kill
#      fallaba, y como el `echo` colgaba de un `&&`, el evento TIMEOUT nunca
#      se escribia. Los stages de #416 (writer, 1883s) y #414 (reviewer,
#      1919s) excedieron el limite nominal de 1800s y events.log tuvo CERO
#      lineas TIMEOUT en todo el historico: el limite de 30 min era decorativo.
#
#   2. Un agente que muere a mitad de respuesta abria PR igual. El reviewer de
#      #416 murio con "API Error: Connection closed mid-response" tras 882s;
#      el pipeline evaluo has_work=true (bastaba cualquier archivo sucio en el
#      worktree) y abrio el PR #421 con una revision truncada a mitad de frase.
#
# Arreglo (_mefisto-common.sh, canonico en src/internal/scripts/lib/):
#   - run_agent_with_watchdog: lanza el comando en una SESION nueva (`setsid`,
#     o su fallback Perl; degrada a job control `set -m` solo si ninguno de
#     los dos esta en PATH, issue #943 aisla ademas la tty) para que sea
#     lider de su propio grupo de procesos -- asi `kill -9 -$pid` SI alcanza
#     a todo el arbol (CA-1); deja el evento TIMEOUT como sentencia
#     independiente, nunca colgada de un `&&` (CA-2); y deja una senal en
#     disco cuando dispara (CA-3).
#   - agent_failure_is_unrecoverable: deriva si el fallo admite recuperacion
#     (CA-4), leyendo `error.kind` del terminal del JSONL neutral via
#     agent_events_error_kind (issue #906) en vez de grepear el log.
#   - agent_work_is_trustworthy: el atajo has_work deja de aplicar cuando el
#     fallo es irrecuperable (CA-4), y para el resto de fallos exige ademas
#     que el resumen de stage exista y no este vacio -- evidencia de que el
#     agente llego al final de su contrato (CA-5).
#
# Casos cubiertos:
#   [pre] Las funciones nuevas estan definidas en _mefisto-common.sh.
#   [A] CA-1: el watchdog mata TODO el arbol de procesos (proceso + hijos),
#       con un stand-in de CLI que lanza hijos (`bash -c 'sleep N & ...'`).
#   [B] CA-2: el evento TIMEOUT se escribe en events.log de forma
#       incondicional al vencer el timeout.
#   [C] CA-3: la senal de timeout se crea SOLO cuando el watchdog dispara; un
#       comando que termina antes del timeout no la deja, el exit code real
#       del comando (no 137) viaja intacto, y cancelar el watchdog no deja su
#       `sleep` huerfano.
#   [D] CA-4: agent_failure_is_unrecoverable deriva bien el flag (senal de
#       timeout, exit de senal, corte de stream en el log) y
#       agent_work_is_trustworthy nunca recupera cuando el flag esta puesto,
#       sin importar cuan sucio este el worktree.
#   [E] CA-5: para fallos recuperables, has_work exige ademas el resumen de
#       stage no vacio -- fixtures de worktree sucio con y sin resumen.
#   [H] CA-4 (issue #2472): MEFISTO_WATCHDOG_TERMINATE_FILE -> SIGTERM al grupo,
#       SIGKILL a los 10 s si sigue vivo; sin el archivo nada cambia.
#
# Uso: .claude/scripts/tests/test-watchdog-trabajo-util.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre: funciones existen --------

echo "[pre] Las funciones nuevas estan definidas en _mefisto-common.sh"
for fn in run_agent_with_watchdog agent_events_error_kind agent_failure_is_unrecoverable agent_work_is_trustworthy agent_stream_completed_successfully; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: CA-1, mata todo el arbol de procesos --------

echo ""
echo "[A] CA-1: el watchdog mata TODO el arbol de procesos, no solo el subshell"

WT_A="$TMP/wt-a"; mkdir -p "$WT_A"
CHILD_PID_FILE="$TMP/a-child.pid"
EXIT_A=$(run_agent_with_watchdog "$WT_A" 1 "$TMP/a-log.txt" "$TMP/a-stderr.txt" "$TMP/a-events.log" "writer" "$TMP/a-signal" \
    bash -c "sleep 30 & echo \$! > '$CHILD_PID_FILE'; sleep 30")

if [ "$EXIT_A" = "137" ]; then
    pass "A-1: exit code 137 (grupo completo recibio SIGKILL)"
else
    fail "A-1: se esperaba exit 137, se obtuvo '$EXIT_A'"
fi

# Margen para que el sistema termine de limpiar los procesos matados.
sleep 1

CHILD_PID="$(cat "$CHILD_PID_FILE" 2>/dev/null || echo "")"
if [ -n "$CHILD_PID" ] && ! kill -0 "$CHILD_PID" 2>/dev/null; then
    pass "A-2: el hijo anidado ($CHILD_PID) tambien murio -- no solo el proceso top-level"
else
    fail "A-2: el hijo anidado ($CHILD_PID) sigue vivo -- el kill no alcanzo todo el arbol"
fi

# -------- Bloque B: CA-2, evento TIMEOUT incondicional --------

echo ""
echo "[B] CA-2: el evento TIMEOUT se escribe en events.log de forma incondicional"

if grep -q "TIMEOUT: writer supero 1s" "$TMP/a-events.log" 2>/dev/null; then
    pass "B-1: la linea TIMEOUT quedo escrita en events.log (no colgo del exito del kill)"
else
    fail "B-1: no se encontro la linea TIMEOUT en events.log: $(cat "$TMP/a-events.log" 2>/dev/null)"
fi

# -------- Bloque C: CA-3, senal de timeout solo cuando el watchdog dispara --------

echo ""
echo "[C] CA-3: la senal de timeout distingue TIMEOUT de un fallo normal"

if [ -f "$TMP/a-signal" ]; then
    pass "C-1: la corrida con timeout (bloque A) dejo la senal en disco"
else
    fail "C-1: la corrida con timeout deberia haber dejado la senal en disco"
fi

WT_C="$TMP/wt-c"; mkdir -p "$WT_C"
# Timeout deliberadamente largo y con un valor irrepetible: el comando termina
# de inmediato, asi que el watchdog tiene que quedar cancelado -- y C-5 busca
# su `sleep` por ese valor exacto para que no se confunda con ningun otro
# `sleep` de la maquina.
C_TIMEOUT=3607
EXIT_C=$(run_agent_with_watchdog "$WT_C" "$C_TIMEOUT" "$TMP/c-log.txt" "$TMP/c-stderr.txt" "$TMP/c-events.log" "writer" "$TMP/c-signal" \
    bash -c "echo hola; exit 3")

if [ "$EXIT_C" = "3" ]; then
    pass "C-2: el exit code real del comando (3) viaja intacto -- no se confunde con TIMEOUT"
else
    fail "C-2: se esperaba exit 3, se obtuvo '$EXIT_C'"
fi
if [ ! -f "$TMP/c-signal" ]; then
    pass "C-3: sin timeout, NO se crea la senal"
else
    fail "C-3: se creo la senal sin que hubiera timeout"
fi
if [ ! -s "$TMP/c-events.log" ]; then
    pass "C-4: sin timeout, events.log queda vacio (ningun evento espurio)"
else
    fail "C-4: events.log no deberia tener contenido: $(cat "$TMP/c-events.log")"
fi

# C-5: cancelar el watchdog tiene que llevarse tambien su `sleep`. Matar solo
# el PID del subshell dejaba el `sleep <timeout>` huerfano hasta media hora
# (uno por stage). Por eso el watchdog se lanza dentro de la ventana de
# `set -m` -- como lider de su propio grupo -- y se cancela con
# `kill -9 -$watchdog_pid`, que barre subshell y `sleep` de una.
sleep 1
ORPHANS=$(pgrep -f "sleep $C_TIMEOUT" 2>/dev/null | wc -l | tr -d ' ')
if [ "$ORPHANS" = "0" ]; then
    pass "C-5: cancelar el watchdog no deja el 'sleep' huerfano"
else
    fail "C-5: quedaron $ORPHANS 'sleep $C_TIMEOUT' huerfanos tras cancelar el watchdog"
fi

# C-5b: desde #945 el watchdog duerme en rebanadas de MEFISTO_WATCHDOG_POLL_S
# (default 5), asi que la corrida de arriba ya no crea ningun `sleep 3607` --
# C-5 pasaria aunque el kill de grupo dejara huerfanos, por no tener nada que
# encontrar. Esta corrida gemela fija poll_s == timeout para reconstruir la
# forma exacta que C-5 vigilaba (un unico `sleep <C_TIMEOUT>`) y volver a
# ejercitar de verdad el invariante de #424.
MEFISTO_WATCHDOG_POLL_S="$C_TIMEOUT" run_agent_with_watchdog "$WT_C" "$C_TIMEOUT" \
    "$TMP/c5b-log.txt" "$TMP/c5b-stderr.txt" "$TMP/c5b-events.log" "writer" "$TMP/c5b-signal" \
    bash -c "echo hola" >/dev/null
sleep 1
ORPHANS_5B=$(pgrep -f "sleep $C_TIMEOUT" 2>/dev/null | wc -l | tr -d ' ')
if [ "$ORPHANS_5B" = "0" ]; then
    pass "C-5b: con poll_s == timeout (rebanada unica, la forma pre-#945) tampoco queda 'sleep' huerfano"
else
    fail "C-5b: quedaron $ORPHANS_5B 'sleep $C_TIMEOUT' huerfanos con poll_s == timeout"
fi

# C-6/C-7: la senal NO puede aparecer despues de que el proceso termino solo.
# Un watchdog que sobrevive a su `sleep` alcanza a hacer su `touch` en la
# ventana entre `wait` y el `kill` que lo cancela, y deja la senal de un stage
# que en realidad termino bien -- el caller la lee como TIMEOUT y descarta
# trabajo bueno. Se manifesto como "TIMEOUT (0s, exit 0)" en el bloque G de
# test-tooling-state-paths.sh cuando el CLI responde en menos de un segundo.
# El arreglo: la rama que cancela el watchdog (la que ya decidio que NO habia
# disparado) borra cualquier senal posterior.
C6_ESPURIAS=0
for c6_i in $(seq 1 30); do
    run_agent_with_watchdog "$WT_C" 3607 "$TMP/c6-log.txt" "$TMP/c6-stderr.txt" "$TMP/c6-events.log" "writer" "$TMP/c6-signal-$c6_i" \
        /bin/echo hola >/dev/null
    # Margen para que un watchdog perdido alcance a tocar la senal.
    sleep 0.05
    [ -f "$TMP/c6-signal-$c6_i" ] && C6_ESPURIAS=$((C6_ESPURIAS+1))
done
if [ "$C6_ESPURIAS" = "0" ]; then
    pass "C-6: 30 corridas que terminan solas, cero senales de timeout espurias"
else
    fail "C-6: $C6_ESPURIAS de 30 corridas dejaron una senal espuria (se clasificarian TIMEOUT)"
fi

C7_LIB="$REPO_ROOT/src/runtime/lib/mefisto-process.sh"
C7_RM=$(grep -c 'rm -f "\$signal_file"' "$C7_LIB" 2>/dev/null || echo 0)
if [ "$C7_RM" -ge 2 ]; then
    pass "C-7: la rama que cancela el watchdog limpia la senal, ademas del rm de entrada"
else
    fail "C-7: falta el rm de la senal tras cancelar el watchdog (solo $C7_RM ocurrencia(s))"
fi

# -------- Fixtures de worktree para los bloques D y E --------

WT="$TMP/worktree"
mkdir -p "$WT/commands" "$WT/.mefisto/pipeline/summaries"
git -C "$WT" init -q
git -C "$WT" config user.email "t@t.test"
git -C "$WT" config user.name "test"
echo "base" > "$WT/commands/base.md"
# .mefisto/ replica el .gitignore real del repo (issue #856/#869, bloque E):
# sin esto, escribir el resumen de stage bajo .mefisto/pipeline/summaries/
# ensuciaria el status por si solo y el fixture de worktree LIMPIO (E-4) seria
# imposible de construir.
echo ".mefisto/" > "$WT/.gitignore"
git -C "$WT" add -A >/dev/null
git -C "$WT" commit -qm "base"
BASE_COMMIT=$(git -C "$WT" rev-parse HEAD)

reset_wt() {
    git -C "$WT" reset -q --hard "$BASE_COMMIT"
    git -C "$WT" clean -qfd
    mkdir -p "$WT/.mefisto/pipeline/summaries"
}

SUMMARY="$WT/.mefisto/pipeline/summaries/stage-1-writer.md"

# -------- Bloque D: CA-4, unrecoverable siempre gana --------

echo ""
echo "[D] CA-4: unrecoverable (TIMEOUT / corte de stream) nunca se recupera"

# Primero la DERIVACION del flag (agent_failure_is_unrecoverable): es la
# decision que de hecho corta el paso a un PR truncado, asi que se testea la
# funcion real y no una reimplementacion del criterio. Desde el issue #906
# lee el JSONL neutral (el `<log_base>.events.jsonl` que run_agent escribe),
# no un log de texto -- las fixtures son ahora terminales `run.failed` con
# `error.kind` estructurado.
EVENTS_LIMPIO="$TMP/d-events-limpio.jsonl"
cat > "$EVENTS_LIMPIO" <<'EOF'
{"v":1,"type":"message","ts":"2026-09-06T10:00:00Z","role":"assistant","text":"todo bien"}
{"v":1,"type":"run.failed","ts":"2026-09-06T10:00:01Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"nonzero_exit","detail":"stop_reason=? subtype=? exit=1"}}
EOF
EVENTS_CORTE="$TMP/d-events-corte.jsonl"
cat > "$EVENTS_CORTE" <<'EOF'
{"v":1,"type":"message","ts":"2026-09-06T10:00:00Z","role":"assistant","text":"trabajando..."}
{"v":1,"type":"run.failed","ts":"2026-09-06T10:00:01Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"stream_cut","detail":"el stream de Claude se corto a mitad de escritura"}}
EOF

if agent_failure_is_unrecoverable "true" "0" "$EVENTS_LIMPIO"; then
    pass "D-1: la senal de TIMEOUT marca irrecuperable aunque el exit code sea 0"
else
    fail "D-1: timed_out=true deberia marcar irrecuperable"
fi

if agent_failure_is_unrecoverable "false" "137" "$EVENTS_LIMPIO"; then
    pass "D-2: exit 137 (SIGKILL) marca irrecuperable sin mirar el terminal"
else
    fail "D-2: exit 137 deberia marcar irrecuperable"
fi

# El incidente literal de #416: exit code ordinario, terminal con error.kind=stream_cut.
if agent_failure_is_unrecoverable "false" "1" "$EVENTS_CORTE"; then
    pass "D-3: error.kind == 'stream_cut' en el terminal marca irrecuperable (incidente #416)"
else
    fail "D-3: el corte de stream a mitad de respuesta deberia marcar irrecuperable"
fi

if agent_failure_is_unrecoverable "false" "1" "$EVENTS_LIMPIO"; then
    fail "D-4 (control): un fallo ordinario NO deberia marcarse irrecuperable"
else
    pass "D-4 (control): fallo ordinario (exit 1, error.kind != stream_cut) sigue siendo recuperable"
fi

# Y ahora el EFECTO del flag sobre el criterio de recuperacion.

# D-5: worktree bien sucio + resumen presente y no vacio, pero unrecoverable=true.
reset_wt
echo "cambio" > "$WT/commands/base.md"
echo "resumen del writer" > "$SUMMARY"
if agent_work_is_trustworthy "$WT" "$BASE_COMMIT" "true" "$SUMMARY"; then
    fail "D-5: unrecoverable=true NO deberia recuperar aunque el worktree este sucio y haya resumen"
else
    pass "D-5: unrecoverable=true aborta pese a worktree sucio y resumen presente"
fi

# D-6: mismo escenario pero unrecoverable=false -- debe SI recuperar (control).
if agent_work_is_trustworthy "$WT" "$BASE_COMMIT" "false" "$SUMMARY"; then
    pass "D-6 (control): unrecoverable=false SI recupera con worktree sucio y resumen"
else
    fail "D-6 (control): deberia recuperar con worktree sucio, resumen presente y unrecoverable=false"
fi

# -------- Bloque E: CA-5, has_work exige resumen de stage no vacio --------

echo ""
echo "[E] CA-5: has_work exige ademas el resumen de stage, no vacio"

# E-1: worktree sucio SIN resumen -> no recuperable.
reset_wt
echo "cambio" > "$WT/commands/base.md"
rm -f "$SUMMARY"
if agent_work_is_trustworthy "$WT" "$BASE_COMMIT" "false" "$SUMMARY"; then
    fail "E-1: sin resumen de stage NO deberia recuperar aunque el worktree este sucio"
else
    pass "E-1: worktree sucio sin resumen de stage -- no se recupera"
fi

# E-2: worktree sucio con resumen VACIO -> no recuperable.
reset_wt
echo "cambio" > "$WT/commands/base.md"
: > "$SUMMARY"
if agent_work_is_trustworthy "$WT" "$BASE_COMMIT" "false" "$SUMMARY"; then
    fail "E-2: con resumen VACIO no deberia recuperar"
else
    pass "E-2: worktree sucio con resumen vacio -- no se recupera"
fi

# E-3: worktree sucio con resumen presente y no vacio -> SI recuperable.
reset_wt
echo "cambio" > "$WT/commands/base.md"
echo "resumen del writer" > "$SUMMARY"
if agent_work_is_trustworthy "$WT" "$BASE_COMMIT" "false" "$SUMMARY"; then
    pass "E-3: worktree sucio con resumen no vacio -- se recupera"
else
    fail "E-3: deberia recuperar con worktree sucio y resumen no vacio"
fi

# E-4: worktree LIMPIO (sin diff, sin status sucio) con resumen presente -> no hay has_work, no se recupera.
reset_wt
echo "resumen del writer" > "$SUMMARY"
git -C "$WT" add -A >/dev/null 2>&1 || true
if agent_work_is_trustworthy "$WT" "$BASE_COMMIT" "false" "$SUMMARY"; then
    fail "E-4: worktree limpio (sin has_work) no deberia recuperar aunque haya resumen"
else
    pass "E-4: worktree limpio -- no hay has_work, no se recupera"
fi

# -------- Bloque G: issue #446, una senal DESPUES del exito no es un timeout --------

echo ""
echo "[G] #446: un terminal 'run.completed{status:success}' exime al stage de irrecuperable"

# JSONL neutral (issue #906): agent_stream_completed_successfully/
# agent_failure_is_unrecoverable ya no leen la traza cruda de Claude, sino el
# `<log_base>.events.jsonl` que run_agent escribe traduciendola.
EVENTS_OK="$TMP/g-ok.events.jsonl"
{
    echo '{"v":1,"type":"message","ts":"2026-07-28T10:00:00Z","role":"assistant","text":"trabajando"}'
    echo '{"v":1,"type":"run.completed","ts":"2026-07-28T10:03:37Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":217358,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":34,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}'
} > "$EVENTS_OK"

# Traza de una muerte a mitad de vuelo: nunca llega el evento terminal.
EVENTS_CORTADA="$TMP/g-cut.events.jsonl"
{
    echo '{"v":1,"type":"message","ts":"2026-07-28T10:00:00Z","role":"assistant","text":"trabajando"}'
} > "$EVENTS_CORTADA"

# Terminal de error: el CLI llego al final pero declarando fallo.
EVENTS_ERROR="$TMP/g-err.events.jsonl"
{
    echo '{"v":1,"type":"run.failed","ts":"2026-07-28T10:00:01Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"nonzero_exit","detail":"stop_reason=? subtype=error_during_execution"}}'
} > "$EVENTS_ERROR"

# Traza truncada a media linea: el proceso murio escribiendo el JSON. El
# parseo tolerante la descarta; afirmar exito aqui seria el peor falso
# positivo posible.
EVENTS_TRUNCA="$TMP/g-trunc.events.jsonl"
{
    echo '{"v":1,"type":"message","ts":"2026-07-28T10:00:00Z","role":"assistant","text":"trabajando"}'
    printf '{"v":1,"type":"run.completed","status":"suc'
} > "$EVENTS_TRUNCA"

if agent_stream_completed_successfully "$EVENTS_OK"; then
    pass "G-1: terminal run.completed{status:success} -> exito declarado"
else
    fail "G-1: no reconocio un terminal de exito"
fi

if agent_stream_completed_successfully "$EVENTS_CORTADA"; then
    fail "G-2: afirmo exito sobre una traza SIN evento terminal"
else
    pass "G-2: traza sin evento terminal -> no se afirma exito"
fi

if agent_stream_completed_successfully "$EVENTS_ERROR"; then
    fail "G-3: afirmo exito sobre un terminal run.failed"
else
    pass "G-3: terminal run.failed -> no se afirma exito"
fi

if agent_stream_completed_successfully "$EVENTS_TRUNCA"; then
    fail "G-4: afirmo exito sobre una traza truncada a media linea"
else
    pass "G-4: traza truncada -> no se afirma exito"
fi

if agent_stream_completed_successfully "$TMP/no-existe.jsonl"; then
    fail "G-5: afirmo exito sobre una traza inexistente"
else
    pass "G-5: traza inexistente -> no se afirma exito"
fi

# El caso de los dos incidentes del 2026-07-28: exit code de senal, el
# watchdog NO disparo, y el terminal declara exito. Antes de #446 esto se
# clasificaba TIMEOUT y se descartaba el trabajo.
if agent_failure_is_unrecoverable "false" "137" "$EVENTS_OK"; then
    fail "G-6: exit 137 con terminal de exito sigue marcado irrecuperable (bug de #446)"
else
    pass "G-6: exit 137 con terminal de exito -> recuperable (la muerte fue posterior)"
fi

# El incidente de #416 NO puede relajarse: sin evento terminal, sigue irrecuperable.
if agent_failure_is_unrecoverable "false" "137" "$EVENTS_CORTADA"; then
    pass "G-7: exit 137 sin evento terminal sigue irrecuperable (no se relaja #416)"
else
    fail "G-7: se relajo un corte a mitad de vuelo (regresion sobre #416)"
fi

# Un TIMEOUT real del watchdog sobre una traza cortada tampoco se relaja.
if agent_failure_is_unrecoverable "true" "0" "$EVENTS_CORTADA"; then
    pass "G-8: TIMEOUT del watchdog sin terminal sigue irrecuperable"
else
    fail "G-8: se relajo un TIMEOUT real del watchdog"
fi

# Tolerancia (issue #906): un events_file vacio/inexistente no rompe la
# funcion -- cae al mismo criterio que un fallo ordinario sin terminal.
if agent_failure_is_unrecoverable "false" "137" ""; then
    pass "G-9: sin events_file, exit 137 sigue irrecuperable (tolera archivo vacio/inexistente)"
else
    fail "G-9: agent_failure_is_unrecoverable no deberia fallar con events_file vacio"
fi

# La clasificacion de fallos se extrajo de run_agent a classify_agent_failure
# en _mefisto-common.sh (issue #534): al pasar a gobernar tambien si un stage
# se REINTENTA, inline no habia forma de ejercerla sin invocar el CLI real. La
# distincion de #446 sigue siendo obligatoria; solo cambio de archivo.
if grep -q 'SIGNAL_POST_SUCCESS' "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"; then
    pass "G-12: la clasificacion distingue una senal posterior al exito de un TIMEOUT"
else
    fail "G-12: la clasificacion no distingue SIGNAL_POST_SUCCESS"
fi

echo ""
echo "[H] CA-4 (issue #2472): MEFISTO_WATCHDOG_TERMINATE_FILE pide terminar al grupo sin ser un timeout"

WT_H="$TMP/wt-h"; mkdir -p "$WT_H"

# H-1: con el archivo presente, SIGTERM al grupo (exit 143) mucho antes del timeout.
H_TERM="$TMP/h1-terminate"; : > "$H_TERM"
H1_T0=$(date +%s)
H1_EXIT=$(MEFISTO_WATCHDOG_POLL_S=1 MEFISTO_WATCHDOG_TERMINATE_FILE="$H_TERM" \
    run_agent_with_watchdog "$WT_H" 60 "$TMP/h1-log.txt" "$TMP/h1-stderr.txt" "$TMP/h1-events.log" "writer" "$TMP/h1-signal" \
    bash -c 'sleep 60 & wait')
H1_ELAPSED=$(( $(date +%s) - H1_T0 ))
if [ "$H1_EXIT" = "143" ] && [ "$H1_ELAPSED" -lt 20 ]; then
    pass "H-1: con el archivo de solicitud, SIGTERM al grupo (exit 143 en ${H1_ELAPSED}s, tope 60s)"
else
    fail "H-1: exit $H1_EXIT en ${H1_ELAPSED}s (esperaba 143 antes de 20s)"
fi
if [ ! -f "$TMP/h1-signal" ] && ! grep -q 'TIMEOUT:' "$TMP/h1-events.log" 2>/dev/null; then
    pass "H-2: la terminacion solicitada no deja senal de timeout ni linea TIMEOUT"
else
    fail "H-2: la terminacion solicitada se registro como timeout"
fi

# H-3: un proceso que ignora SIGTERM recibe SIGKILL a los 10 s.
H3_T0=$(date +%s)
H3_EXIT=$(MEFISTO_WATCHDOG_POLL_S=1 MEFISTO_WATCHDOG_TERMINATE_FILE="$H_TERM" \
    run_agent_with_watchdog "$WT_H" 120 "$TMP/h3-log.txt" "$TMP/h3-stderr.txt" "$TMP/h3-events.log" "writer" "$TMP/h3-signal" \
    bash -c 'trap "" TERM; while :; do sleep 1; done')
H3_ELAPSED=$(( $(date +%s) - H3_T0 ))
if [ "$H3_EXIT" = "137" ] && [ "$H3_ELAPSED" -ge 9 ] && [ "$H3_ELAPSED" -lt 40 ]; then
    pass "H-3: un proceso que ignora SIGTERM recibe SIGKILL a los 10 s (exit 137 en ${H3_ELAPSED}s)"
else
    fail "H-3: exit $H3_EXIT en ${H3_ELAPSED}s (esperaba 137 tras ~10s)"
fi

# H-4: sin la variable, o con el archivo ausente, nada cambia: el exit del
# comando viaja intacto y no hay senal.
H4_EXIT=$(MEFISTO_WATCHDOG_POLL_S=1 run_agent_with_watchdog "$WT_H" 30 "$TMP/h4-log.txt" "$TMP/h4-stderr.txt" "$TMP/h4-events.log" "writer" "$TMP/h4-signal" \
    bash -c 'sleep 2; exit 7')
H5_EXIT=$(MEFISTO_WATCHDOG_POLL_S=1 MEFISTO_WATCHDOG_TERMINATE_FILE="$TMP/h5-no-existe" \
    run_agent_with_watchdog "$WT_H" 30 "$TMP/h5-log.txt" "$TMP/h5-stderr.txt" "$TMP/h5-events.log" "writer" "$TMP/h5-signal" \
    bash -c 'sleep 2; exit 7')
if [ "$H4_EXIT" = "7" ] && [ "$H5_EXIT" = "7" ] && [ ! -f "$TMP/h4-signal" ] && [ ! -f "$TMP/h5-signal" ]; then
    pass "H-4: sin variable o sin archivo, el comportamiento y la firma de 7 posicionales no cambian"
else
    fail "H-4: exits $H4_EXIT/$H5_EXIT (esperaba 7/7 sin senal)"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
