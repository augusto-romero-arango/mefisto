#!/usr/bin/env bash
# test-mefisto-test-executor.sh -- Tests de
# src/internal/scripts/lib/mefisto-test-executor.sh (issue #1440).
#
# Cubre:
#   [pre] La lib existe, tiene sintaxis bash valida y no usa
#         'declare -A'/'mapfile'/'readarray'/'wait -n' (bash 3.2, macOS).
#   [A] mefisto_test_executor_entries_for_lane: filtra un carril del formato
#       'carril<TAB>ruta' de mefisto-test-inventory.sh, sin la columna.
#   [B] mefisto_test_executor_results_file / log_dir: rutas deterministicas
#       derivadas de <run_dir>/<carril>, sin efectos secundarios.
#   [C] Secuencia intracarril (CA-2): tres entradas del MISMO carril escriben
#       start/end en un log compartido en el orden exacto A1,A2,A3 -- nunca
#       intercaladas -- demostrando ejecucion secuencial real, no solo
#       "resultados en orden".
#   [D] Solapamiento entre carriles (CA-2): tres carriles de una entrada cada
#       uno, cada una durmiendo 2s, terminan en bastante menos que 3x2s de
#       reloj -- prueba de concurrencia real entre carriles (con SECONDS,
#       sin depender de resolucion de sub-segundo de `date`, no disponible
#       portablemente).
#   [E] Continuidad tras fallo (CA-3): un exit no-cero no detiene ni el resto
#       del carril ni los otros carriles.
#   [F] Agregacion de exit code y cwd (CA-2/CA-3): PASS con exit 0, FAIL con
#       el exit code real de la entrada, cwd en la raiz del repo, stdout+
#       stderr combinados en el log de la entrada.
#   [G] Integridad de resultados (CA-3): muchas entradas rapidas en un mismo
#       carril producen results.tsv con tantas lineas como entradas, orden
#       1..N sin huecos ni duplicados, cada linea con 8 campos -- sin
#       escrituras concurrentes que la corrompan.
#   [J] Consumidor con 'set -euo pipefail' (CA-1/CA-3): sourceada desde un
#       pipeline interno tipico, una entrada roja no aborta el worker (el
#       carril sigue y la fila queda FAIL, no CANCELLED) y los traps de INT y
#       el monitor mode del caller quedan como estaban.
#   [H] Senal INT (CA-4): dentro de una pty real (igual que
#       test-watchdog-tty-isolation.sh), termina en <130> con las entradas no
#       completadas marcadas CANCELLED, sin descendientes huerfanos (`ps`
#       sobre el arbol real, no solo el PID del subshell).
#   [I] Senal TERM (CA-4): identico a [H] pero con 143 y SIGTERM.
#
# Requiere `python3` para [H]/[I] (fixtures/pty-run.py da la pty real) --
# igual que test-watchdog-tty-isolation.sh, sin una pty real no hay forma de
# reproducir el contrato de senales de forma determinista; si no esta en PATH,
# esos bloques FALLAN explicitamente, nunca se saltan en silencio.
#
# Uso: .claude/scripts/tests/test-mefisto-test-executor.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB="$REPO_ROOT/src/internal/scripts/lib/mefisto-test-executor.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[pre] La lib existe y tiene sintaxis valida"
if [ -f "$LIB" ]; then
    pass "mefisto-test-executor.sh presente en src/internal/scripts/lib/"
else
    fail "mefisto-test-executor.sh no existe en src/internal/scripts/lib/"
    echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
    exit 1
fi

if bash -n "$LIB" 2>/dev/null; then
    pass "sintaxis bash valida"
else
    fail "sintaxis bash invalida"
fi

CODE_ONLY="$(grep -v '^[[:space:]]*#' "$LIB")"
for forbidden in "declare -A" "mapfile" "readarray" "wait -n"; do
    if printf '%s' "$CODE_ONLY" | grep -q -- "$forbidden"; then
        fail "usa '$forbidden': rompe en bash 3.2"
    else
        pass "no usa '$forbidden' (compatible bash 3.2)"
    fi
done

# bash 3.2 real (macOS): verificado en este entorno que /bin/bash es distinto
# del bash de PATH si hay uno mas nuevo instalado (p. ej. homebrew) -- mismo
# criterio que test-mefisto-test-inventory.sh y test-watchdog-tty-isolation.sh.
BASH_BIN="/bin/bash"
[ -x "$BASH_BIN" ] || BASH_BIN="bash"

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# -------- Fixture repo compartido --------------------------------------
#
# BASE/t/*.sh: entradas de prueba sinteticas, ninguna referencia al repo real
# de Mefisto -- todas las corridas de mefisto_test_executor_run en este
# archivo apuntan a BASE como <repo_root>, nunca a REPO_ROOT.

BASE="$TMPDIR_ROOT/base"
mkdir -p "$BASE/t"

printf '#!/usr/bin/env bash\nexit 0\n' > "$BASE/t/ok.sh"
printf '#!/usr/bin/env bash\nexit 7\n' > "$BASE/t/fail7.sh"
printf '#!/usr/bin/env bash\necho "stdout line"\necho "stderr line" >&2\nexit 0\n' > "$BASE/t/echo-both.sh"
printf '#!/usr/bin/env bash\n[ "$(pwd)" = "$CWD_CHECK_EXPECTED" ] && exit 0 || exit 1\n' > "$BASE/t/cwd-check.sh"

printf '#!/usr/bin/env bash\necho "SEQ1:start" >> "$SEQ_LOG"\nsleep 0.15\necho "SEQ1:end" >> "$SEQ_LOG"\nexit 0\n' > "$BASE/t/seq1.sh"
printf '#!/usr/bin/env bash\necho "SEQ2:start" >> "$SEQ_LOG"\nsleep 0.15\necho "SEQ2:end" >> "$SEQ_LOG"\nexit 0\n' > "$BASE/t/seq2.sh"
printf '#!/usr/bin/env bash\necho "SEQ3:start" >> "$SEQ_LOG"\nsleep 0.15\necho "SEQ3:end" >> "$SEQ_LOG"\nexit 0\n' > "$BASE/t/seq3.sh"

printf '#!/usr/bin/env bash\nsleep 2\nexit 0\n' > "$BASE/t/ov-a.sh"
printf '#!/usr/bin/env bash\nsleep 2\nexit 0\n' > "$BASE/t/ov-b.sh"
printf '#!/usr/bin/env bash\nsleep 2\nexit 0\n' > "$BASE/t/ov-c.sh"

printf '#!/usr/bin/env bash\nsleep 100 &\necho "$!" > "$SLEEPER_MARKER"\nsleep 100\n' > "$BASE/t/sleeper.sh"

chmod +x "$BASE"/t/*.sh

# N entradas rapidas para el chequeo de integridad ([G]).
mkdir -p "$BASE/t/many"
i=1
while [ "$i" -le 15 ]; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$BASE/t/many/e$(printf '%02d' "$i").sh"
    chmod +x "$BASE/t/many/e$(printf '%02d' "$i").sh"
    i=$((i + 1))
done

# -------- Runner comun para invocar mefisto_test_executor_run en bash 3.2 real --------
#
# Los 8 argumentos posicionales viajan intactos (bash preserva saltos de
# linea embebidos en un argumento citado): repo_root, run_dir, y los tres
# pares carril/entradas.
RUNNER="$TMPDIR_ROOT/.runner.sh"
cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
source "$LIB"
mefisto_test_executor_run "\$1" "\$2" "\$3" "\$4" "\$5" "\$6" "\$7" "\$8"
exit \$?
EOF
chmod +x "$RUNNER"

# run_executor <repo_root> <run_dir> <carril1> <ent1> <carril2> <ent2> <carril3> <ent3>
# Imprime nada; el rc queda en $? tras la llamada.
run_executor() {
    "$BASH_BIN" "$RUNNER" "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8"
}

# ============================================================================
echo ""
echo "[A] mefisto_test_executor_entries_for_lane filtra un carril del formato de inventario"

A_RUNNER="$TMPDIR_ROOT/.a-runner.sh"
cat > "$A_RUNNER" <<EOF
#!/usr/bin/env bash
source "$LIB"
mefisto_test_executor_entries_for_lane "\$1" "\$2"
EOF
chmod +x "$A_RUNNER"

INVENTARIO=$'publicado\tscripts/tests/test-alpha.sh\ninterno\t.claude/scripts/tests/test-beta.sh\npublicado\tscripts/tests/test-gamma.sh'
A_PUB=$("$BASH_BIN" "$A_RUNNER" publicado "$INVENTARIO")
EXPECTED_A_PUB=$'scripts/tests/test-alpha.sh\nscripts/tests/test-gamma.sh'
if [ "$A_PUB" = "$EXPECTED_A_PUB" ]; then
    pass "A-1: filtra 'publicado' preservando el orden, sin la columna de carril"
else
    fail "A-1: se esperaba '$EXPECTED_A_PUB', se obtuvo '$A_PUB'"
fi

A_INT=$("$BASH_BIN" "$A_RUNNER" interno "$INVENTARIO")
if [ "$A_INT" = ".claude/scripts/tests/test-beta.sh" ]; then
    pass "A-2: filtra 'interno' correctamente"
else
    fail "A-2: se esperaba '.claude/scripts/tests/test-beta.sh', se obtuvo '$A_INT'"
fi

A_NONE=$("$BASH_BIN" "$A_RUNNER" canonico-adicional "$INVENTARIO")
if [ -z "$A_NONE" ]; then
    pass "A-3: un carril ausente del inventario produce una lista vacia"
else
    fail "A-3: se esperaba vacio, se obtuvo '$A_NONE'"
fi

# ============================================================================
echo ""
echo "[B] mefisto_test_executor_results_file / log_dir: rutas deterministicas"

B_RUNNER="$TMPDIR_ROOT/.b-runner.sh"
cat > "$B_RUNNER" <<EOF
#!/usr/bin/env bash
source "$LIB"
"\$@"
EOF
chmod +x "$B_RUNNER"

# Ruta inexistente y unica de esta corrida (nunca un '/tmp/run1' compartido:
# B-3 comprueba que los helpers NO la crean, y con una ruta global el test
# fallaria por un directorio ajeno -- y lo borraria al limpiar).
B_FAKE_RUN="$TMPDIR_ROOT/no-such-run"

B_RESULTS=$("$BASH_BIN" "$B_RUNNER" mefisto_test_executor_results_file "$B_FAKE_RUN" publicado)
if [ "$B_RESULTS" = "$B_FAKE_RUN/publicado/results.tsv" ]; then
    pass "B-1: mefisto_test_executor_results_file compone <run_dir>/<carril>/results.tsv"
else
    fail "B-1: se esperaba '$B_FAKE_RUN/publicado/results.tsv', se obtuvo '$B_RESULTS'"
fi

B_LOGDIR=$("$BASH_BIN" "$B_RUNNER" mefisto_test_executor_log_dir "$B_FAKE_RUN" interno)
if [ "$B_LOGDIR" = "$B_FAKE_RUN/interno/logs" ]; then
    pass "B-2: mefisto_test_executor_log_dir compone <run_dir>/<carril>/logs"
else
    fail "B-2: se esperaba '$B_FAKE_RUN/interno/logs', se obtuvo '$B_LOGDIR'"
fi

if [ ! -e "$B_FAKE_RUN" ]; then
    pass "B-3: ninguno de los dos helpers crea nada en disco (solo formatea rutas)"
else
    fail "B-3: '$B_FAKE_RUN' no deberia existir -- los helpers tienen efectos secundarios"
fi

# ============================================================================
echo ""
echo "[C] Secuencia intracarril: tres entradas del mismo carril nunca se intercalan"

SEQ_LOG="$TMPDIR_ROOT/seq.log"
: > "$SEQ_LOG"
RUN_C="$TMPDIR_ROOT/run-c"
ENT_SEQ=$(printf '%s\n' "t/seq1.sh" "t/seq2.sh" "t/seq3.sh")
SEQ_LOG="$SEQ_LOG" run_executor "$BASE" "$RUN_C" laneSeq "$ENT_SEQ" laneB "" laneC ""
C_RC=$?

EXPECTED_SEQ=$'SEQ1:start\nSEQ1:end\nSEQ2:start\nSEQ2:end\nSEQ3:start\nSEQ3:end'
C_ACTUAL="$(cat "$SEQ_LOG" 2>/dev/null)"
if [ "$C_RC" -eq 0 ]; then
    pass "C-1: mefisto_test_executor_run retorna 0 en el camino feliz"
else
    fail "C-1: se esperaba rc=0, se obtuvo $C_RC"
fi
if [ "$C_ACTUAL" = "$EXPECTED_SEQ" ]; then
    pass "C-2: las tres entradas corrieron en orden estricto, sin intercalar start/end"
else
    fail "C-2: se esperaba '$EXPECTED_SEQ', se obtuvo '$C_ACTUAL'"
fi

C_RESULTS="$(cat "$RUN_C/laneSeq/results.tsv" 2>/dev/null)"
C_ORDERS="$(printf '%s\n' "$C_RESULTS" | cut -f1 | tr '\n' ' ')"
if [ "$C_ORDERS" = "1 2 3 " ]; then
    pass "C-3: results.tsv de laneSeq trae orden 1,2,3"
else
    fail "C-3: se esperaba orden '1 2 3 ', se obtuvo '$C_ORDERS'"
fi

# ============================================================================
echo ""
echo "[D] Solapamiento entre carriles: tres carriles de 2s cada uno terminan en mucho menos que 6s"

RUN_D="$TMPDIR_ROOT/run-d"
D_START=$SECONDS
run_executor "$BASE" "$RUN_D" laneA "t/ov-a.sh" laneB "t/ov-b.sh" laneC "t/ov-c.sh"
D_RC=$?
D_ELAPSED=$((SECONDS - D_START))

if [ "$D_RC" -eq 0 ]; then
    pass "D-1: rc=0"
else
    fail "D-1: se esperaba rc=0, se obtuvo $D_RC"
fi
if [ "$D_ELAPSED" -lt 4 ]; then
    pass "D-2: los tres carriles (2s cada uno) solapan -- ${D_ELAPSED}s totales, muy por debajo de 6s seriales"
else
    fail "D-2: tardo ${D_ELAPSED}s (>= 4s) -- sugiere ejecucion serial en vez de concurrente"
fi
for lane in laneA laneB laneC; do
    st="$(cut -f3 "$RUN_D/$lane/results.tsv" 2>/dev/null)"
    if [ "$st" = "PASS" ]; then
        pass "D-3 ($lane): PASS registrado"
    else
        fail "D-3 ($lane): se esperaba PASS, se obtuvo '$st'"
    fi
done

# ============================================================================
echo ""
echo "[E] Continuidad tras fallo: un exit no-cero no detiene el resto del carril ni otros carriles"

RUN_E="$TMPDIR_ROOT/run-e"
ENT_E1=$(printf '%s\n' "t/fail7.sh" "t/ok.sh")
run_executor "$BASE" "$RUN_E" laneA "$ENT_E1" laneB "t/ok.sh" laneC "t/fail7.sh"
E_RC=$?

if [ "$E_RC" -eq 0 ]; then
    pass "E-1: rc=0 pese a que hay entradas FAIL (la agregacion PASS/FAIL es del consumidor, no de esta lib)"
else
    fail "E-1: se esperaba rc=0, se obtuvo $E_RC"
fi

E_LANEA="$(cat "$RUN_E/laneA/results.tsv" 2>/dev/null)"
EXPECTED_E_LANEA=$'1\tt/fail7.sh\tFAIL\t7\t'
if printf '%s\n' "$E_LANEA" | head -1 | grep -qF "$EXPECTED_E_LANEA"; then
    pass "E-2: la primera entrada de laneA quedo FAIL con exit 7"
else
    fail "E-2: no se encontro la fila FAIL esperada en laneA: $E_LANEA"
fi
if printf '%s\n' "$E_LANEA" | sed -n '2p' | grep -qF $'2\tt/ok.sh\tPASS\t0\t'; then
    pass "E-3: la SEGUNDA entrada de laneA (tras el fallo) SI corrio y quedo PASS"
else
    fail "E-3: la segunda entrada de laneA no corrio tras el fallo: $E_LANEA"
fi

E_LANEB="$(cat "$RUN_E/laneB/results.tsv" 2>/dev/null | cut -f3)"
if [ "$E_LANEB" = "PASS" ]; then
    pass "E-4: laneB (otro carril) no se vio afectado por el fallo de laneA"
else
    fail "E-4: se esperaba PASS en laneB, se obtuvo '$E_LANEB'"
fi

# ============================================================================
echo ""
echo "[F] Exit code, cwd en la raiz del repo, y stdout+stderr combinados en el log"

RUN_F="$TMPDIR_ROOT/run-f"
ENT_F=$(printf '%s\n' "t/echo-both.sh" "t/cwd-check.sh")
CWD_CHECK_EXPECTED="$BASE" run_executor "$BASE" "$RUN_F" laneA "$ENT_F" laneB "" laneC ""
F_RC=$?

if [ "$F_RC" -eq 0 ]; then
    pass "F-1: rc=0"
else
    fail "F-1: se esperaba rc=0, se obtuvo $F_RC"
fi

F_ROW1="$(sed -n '1p' "$RUN_F/laneA/results.tsv" 2>/dev/null)"
F_LOG1="$(printf '%s' "$F_ROW1" | cut -f8)"
if [ -f "$F_LOG1" ] && grep -q "stdout line" "$F_LOG1" && grep -q "stderr line" "$F_LOG1"; then
    pass "F-2: el log de la entrada trae stdout Y stderr combinados"
else
    fail "F-2: el log '$F_LOG1' no trae ambas lineas: $(cat "$F_LOG1" 2>/dev/null)"
fi

F_ROW2_STATE="$(sed -n '2p' "$RUN_F/laneA/results.tsv" 2>/dev/null | cut -f3,4)"
if [ "$F_ROW2_STATE" = $'PASS\t0' ]; then
    pass "F-3: cwd-check.sh corrio con cwd == repo_root (PASS, exit 0)"
else
    fail "F-3: se esperaba 'PASS<TAB>0', se obtuvo '$F_ROW2_STATE' -- cwd-check.sh no vio el cwd esperado"
fi

# ============================================================================
echo ""
echo "[G] Integridad de resultados: N entradas rapidas, sin escrituras concurrentes que las corrompan"

RUN_G="$TMPDIR_ROOT/run-g"
ENT_MANY=""
i=1
while [ "$i" -le 15 ]; do
    ENT_MANY="${ENT_MANY}t/many/e$(printf '%02d' "$i").sh"$'\n'
    i=$((i + 1))
done
run_executor "$BASE" "$RUN_G" laneMany "$ENT_MANY" laneB "" laneC ""
G_RC=$?

G_RESULTS="$RUN_G/laneMany/results.tsv"
G_LINES=$(wc -l < "$G_RESULTS" 2>/dev/null | tr -d ' ')
if [ "$G_RC" -eq 0 ] && [ "$G_LINES" = "15" ]; then
    pass "G-1: results.tsv trae exactamente 15 lineas (una por entrada, sin duplicados ni perdidas)"
else
    fail "G-1: rc=$G_RC, lineas=$G_LINES (se esperaba rc=0, 15 lineas)"
fi

G_ORDERS="$(cut -f1 "$G_RESULTS" 2>/dev/null | tr '\n' ' ')"
if [ "$G_ORDERS" = "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 " ]; then
    pass "G-2: la columna 'orden' es 1..15 sin huecos ni duplicados"
else
    fail "G-2: se esperaba '1 2 ... 15', se obtuvo '$G_ORDERS'"
fi

G_BAD_LINES=$(awk -F'\t' 'NF != 8 { c++ } END { print c+0 }' "$G_RESULTS")
if [ "$G_BAD_LINES" = "0" ]; then
    pass "G-3: las 15 lineas tienen exactamente 8 campos cada una (ninguna linea torcida/corrupta)"
else
    fail "G-3: $G_BAD_LINES linea(s) con un numero de campos distinto de 8"
fi

# ============================================================================
echo ""
echo "[J] Consumidor con 'set -euo pipefail': una entrada roja no aborta el carril, y los traps del caller sobreviven"

# Regresion: todo pipeline interno de Mefisto corre con 'set -euo pipefail', y
# el consumidor #1416 sourceara esta lib desde uno. Con set -e heredado, un
# 'cmd; rc=$?' dentro del worker aborta el subshell en la PRIMERA entrada roja:
# el carril entero termina CANCELLED, las entradas siguientes no corren y la
# funcion devuelve 0 igual -- un rojo disfrazado de "cancelado", el peor modo
# de falla posible para un runner de pruebas.
J_RUNNER="$TMPDIR_ROOT/.j-runner.sh"
cat > "$J_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$LIB"
trap 'echo TRAP_PREVIO_DEL_CALLER' INT

# La llamada va DESNUDA, nunca dentro de un '|| ...': bash desactiva set -e
# durante todo el cuerpo de una funcion invocada como parte de una lista
# '&&'/'||', con lo que el propio blindaje del test ocultaria la regresion que
# este bloque existe para detectar. Si un set -e heredado aborta la corrida,
# este script muere aqui y '.rc' nunca se escribe -- J-1 lo delata.
mefisto_test_executor_run "\$1" "\$2" laneA "\$3" laneB "t/ok.sh" laneC ""
echo "rc=\$?" > "\$2/.rc"
trap -p INT > "\$2/.trap-int"
case "\$-" in *m*) echo "monitor-on" ;; *) echo "monitor-off" ;; esac > "\$2/.monitor"
EOF
chmod +x "$J_RUNNER"

RUN_J="$TMPDIR_ROOT/run-j"
mkdir -p "$RUN_J"
ENT_J=$(printf '%s\n' "t/fail7.sh" "t/ok.sh")
"$BASH_BIN" "$J_RUNNER" "$BASE" "$RUN_J" "$ENT_J" >/dev/null 2>&1
J_RC="$(cat "$RUN_J/.rc" 2>/dev/null)"

if [ "$J_RC" = "rc=0" ]; then
    pass "J-1: bajo 'set -euo pipefail' la corrida completa retorna 0 (no aborta al coordinador)"
else
    fail "J-1: se esperaba 'rc=0', se obtuvo '$J_RC'"
fi

J_LANEA="$(cat "$RUN_J/laneA/results.tsv" 2>/dev/null)"
if printf '%s\n' "$J_LANEA" | sed -n '1p' | grep -qF $'1\tt/fail7.sh\tFAIL\t7\t'; then
    pass "J-2: la entrada roja queda FAIL con su exit code real (no CANCELLED por un set -e heredado)"
else
    fail "J-2: no se encontro la fila FAIL esperada bajo set -e: $J_LANEA"
fi
if printf '%s\n' "$J_LANEA" | sed -n '2p' | grep -qF $'2\tt/ok.sh\tPASS\t0\t'; then
    pass "J-3: la entrada siguiente SI corre pese al set -e del caller (CA-3 se sostiene)"
else
    fail "J-3: la segunda entrada no corrio bajo set -e: $J_LANEA"
fi

J_LANEB="$(cut -f3 "$RUN_J/laneB/results.tsv" 2>/dev/null)"
if [ "$J_LANEB" = "PASS" ]; then
    pass "J-4: el otro carril tampoco se ve afectado bajo set -e"
else
    fail "J-4: se esperaba PASS en laneB, se obtuvo '$J_LANEB'"
fi

if grep -q "TRAP_PREVIO_DEL_CALLER" "$RUN_J/.trap-int" 2>/dev/null; then
    pass "J-5: el trap de INT del caller sigue instalado tras la corrida (la lib lo restaura, no lo borra)"
else
    fail "J-5: la lib dejo al caller sin su trap de INT: $(cat "$RUN_J/.trap-int" 2>/dev/null)"
fi

if [ "$(cat "$RUN_J/.monitor" 2>/dev/null)" = "monitor-off" ]; then
    pass "J-6: el monitor mode queda como estaba (apagado) tras la corrida"
else
    fail "J-6: la lib dejo 'set -m' encendido en el shell del caller"
fi

# ============================================================================
# [H]/[I]: contrato de senales dentro de una pty real, igual criterio
# que test-watchdog-tty-isolation.sh -- sin una pty real no hay forma de
# reproducir el contrato de forma deterministica.

PTY_RUN="$SCRIPT_DIR/fixtures/pty-run.py"

if ! command -v python3 >/dev/null 2>&1; then
    echo ""
    echo "FAIL: python3 no esta en PATH -- [H]/[I] EXIGEN una pty real para reproducir el contrato de senales (issue #1440); no pueden saltarse en silencio" >&2
    FAIL=$((FAIL + 2))
else
    # signal_case <nombre_bloque> <senal_kill> <rc_esperado>
    #
    # Corre mefisto_test_executor_run dentro de una pty real con laneA de
    # UNA entrada (sleeper.sh: forkea un descendiente huerfano-prone con '&' y
    # se queda dormido el mismo), laneB/laneC vacios. Espera a que el
    # descendiente exista (marker file), manda <senal_kill> al PID del runner
    # (el proceso real en foreground de la pty, no un PID de subshell propio),
    # y verifica: rc esperado, CANCELLED en laneA, y que NINGUN proceso vivo
    # tenga en su linea de comando el marcador unico de esta corrida (ni el
    # descendiente huerfano ni ningun otro) -- deteccion via `ps`, no solo "se
    # mando la senal".
    signal_case() {
        local block="$1" sig="$2" expected_rc="$3"

        local case_tmp marker run_dir runner pty_pid pane_pid
        case_tmp="$TMPDIR_ROOT/sig-$block"
        mkdir -p "$case_tmp"
        marker="$case_tmp/sleeper-marker"
        run_dir="$case_tmp/run"
        runner="$case_tmp/runner.sh"

        # Marcador unico embebido en el propio nombre del run_dir (que a su
        # vez aparece en el argv del arbol de procesos via $repo_root/$ruta):
        # sirve para buscar en `ps` sin falsos positivos de otras corridas
        # concurrentes de este mismo archivo de test.
        cat > "$runner" <<EOF
#!/usr/bin/env bash
source "$LIB"
ENT=\$(printf '%s\n' "t/sleeper.sh")
mefisto_test_executor_run "$BASE" "$run_dir" laneA "\$ENT" laneB "" laneC ""
echo "\$?" > "$case_tmp/rc"
EOF
        chmod +x "$runner"

        python3 "$PTY_RUN" --pid-file "$case_tmp/pane.pid" -- \
            env "SLEEPER_MARKER=$marker" "$runner" </dev/null >/dev/null 2>&1 &
        pty_pid=$!

        local i=0
        while [ ! -f "$marker" ] && [ "$i" -lt 200 ]; do
            sleep 0.05
            i=$((i + 1))
        done
        sleep 0.2

        if [ ! -f "$marker" ]; then
            fail "$block-0: el descendiente huerfano nunca arranco (marker ausente)"
            kill "$pty_pid" 2>/dev/null; wait "$pty_pid" 2>/dev/null
            return
        fi
        local child_pid
        child_pid="$(cat "$marker")"

        pane_pid="$(cat "$case_tmp/pane.pid" 2>/dev/null)"
        if [ -z "$pane_pid" ]; then
            fail "$block-0: no se pudo obtener el PID del runner dentro de la pty"
            kill "$pty_pid" 2>/dev/null; wait "$pty_pid" 2>/dev/null
            return
        fi

        kill "-$sig" "$pane_pid" 2>/dev/null

        local waited=0
        while kill -0 "$pane_pid" 2>/dev/null && [ "$waited" -lt 100 ]; do
            sleep 0.05
            waited=$((waited + 1))
        done

        if ! kill -0 "$pane_pid" 2>/dev/null; then
            pass "$block-1: el proceso raiz de la corrida termino (no quedo colgado esperando)"
        else
            fail "$block-1: el proceso raiz sigue vivo tras 5s -- no reacciono a la senal"
        fi

        local rc
        rc="$(cat "$case_tmp/rc" 2>/dev/null || echo "?")"
        if [ "$rc" = "$expected_rc" ]; then
            pass "$block-2: mefisto_test_executor_run retorno $expected_rc"
        else
            fail "$block-2: se esperaba rc=$expected_rc, se obtuvo '$rc'"
        fi

        if kill -0 "$child_pid" 2>/dev/null; then
            fail "$block-3: el descendiente huerfano (pid $child_pid, un 'sleep &' forkeado por la entrada) SIGUE VIVO -- fuga de proceso"
        else
            pass "$block-3: el descendiente huerfano no sobrevive a la corrida (ni siquiera el que la entrada forkeo con '&')"
        fi

        local results_lane_a
        results_lane_a="$(cat "$run_dir/laneA/results.tsv" 2>/dev/null)"
        if printf '%s\n' "$results_lane_a" | grep -qF $'1\tt/sleeper.sh\tCANCELLED\t'; then
            pass "$block-4: la entrada interrumpida queda marcada CANCELLED en results.tsv"
        else
            fail "$block-4: no se encontro la fila CANCELLED esperada: $results_lane_a"
        fi

        kill "$pty_pid" 2>/dev/null; wait "$pty_pid" 2>/dev/null
        kill -9 "$child_pid" 2>/dev/null
        # Barre por PID lo que sobreviva, identificado por la ruta temporal unica del caso.
        ps -axo pid=,comm=,command= | awk -v p="$case_tmp" '$2 != "awk" && index($0, p) { print $1 }' \
            | while read -r leftover; do kill -9 "$leftover" 2>/dev/null; done
    }

    echo ""
    echo "[H] Senal INT: termina en 130, cancela lo pendiente, sin descendientes huerfanos"
    signal_case "INT" INT 130

    echo ""
    echo "[I] Senal TERM: termina en 143, cancela lo pendiente, sin descendientes huerfanos"
    signal_case "TERM" TERM 143
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
