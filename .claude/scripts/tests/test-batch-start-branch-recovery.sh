#!/usr/bin/env bash
# test-batch-start-branch-recovery.sh -- Tests de ensure_repo_on_base_branch() (issue #726).
#
# Contexto (sintoma real, 2026-08-27): `/mefisto-sequential 718` aborto porque
# el repo principal estaba en 'docs/field-notes-refinamiento-718' -- rama
# residual de la sesion del planner, ya pusheada y con el arbol de trabajo
# limpio. El gate de arranque del batch exigia main/master sin excepcion, pese
# a que el propio comentario del gate reconocia que la cadena NO depende de la
# rama activa (cada worktree nace de origin/main, issue #66) -- la razon de
# exigirlo es puramente higienica (issue #566). El humano tuvo que intervenir
# a mano ('git switch main') y relanzar.
#
# El fix (CA-1..CA-4 del issue #726): con la rama activa != main/master Y el
# arbol de trabajo LIMPIO, el gate se auto-recupera -- cambia a la rama base
# ('main' si existe local, si no 'master') y la sincroniza con origin
# ('git pull --ff-only'), dejando un warning que nombra la rama original. Con
# arbol SUCIO, o si el pull --ff-only posterior falla (divergencia real), el
# gate sigue siendo fail-loud y aborta -- la auto-recuperacion no aplica.
#
# Casos cubiertos (fixture con repos git temporales, sin red):
#   [pre] La funcion ensure_repo_on_base_branch() se pudo extraer de la
#       libreria canonica y su mensaje no atribuye el worktree a la rama
#       activa (issue #566). Que el motor la invoque antes de su cabecera lo
#       prueba mefisto-batch-pipeline.test.mts sobre la gemela TypeScript.
#   [A] Rama != main/master, arbol LIMPIO, origin adelanto de forma
#       fast-forwardeable: se auto-recupera -- switch a main, pull --ff-only
#       trae el commit nuevo, warn nombra la rama original, sin abort (CA-1).
#   [B] Rama != main/master, arbol SUCIO (archivo sin trackear): aborta
#       fail-loud, sin tocar HEAD, mensaje aclara que la auto-recuperacion
#       solo aplica con el arbol limpio (CA-2).
#   [C] Rama != main/master, arbol LIMPIO, pero 'main' LOCAL diverge de
#       origin/main (el fetch/pull por ff-only es rechazado): aborta
#       fail-loud tras el switch, mensaje explica la divergencia (CA-3).
#   [D] Ya en 'main': no-op -- ni abort ni warn, HEAD intacto.
#   [E] 'main' y 'master' locales coexisten: se prefiere 'main' (nota tecnica
#       del issue).
#   [F] HEAD detached con arbol limpio: se recupera por el mismo camino que
#       una rama con nombre.
#   [G] Ya en 'master': conserva el no-op historico aunque no exista 'main'.
#
# Uso: .claude/scripts/tests/test-batch-start-branch-recovery.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRIPT="$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# -------- Extraer la funcion REAL bajo prueba (no reimplementarla) --------

extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

echo "[pre] ensure_repo_on_base_branch() se extrae de la libreria canonica $SCRIPT"

FN_SRC=$(extract_fn "ensure_repo_on_base_branch" "$SCRIPT")
if [ -z "$FN_SRC" ]; then
    fail "no se pudo extraer ensure_repo_on_base_branch() de $SCRIPT -- el resto de los bloques se omite"
    echo ""
    echo "----------------------------------------"
    echo "  Resumen: $PASS pass, $FAIL fail"
    echo "----------------------------------------"
    exit 1
fi
pass "la funcion se extrajo del script real"

# Guard de regresion (issue #566): el mensaje del gate ya no atribuye el
# worktree a la rama activa; cita origin/main + issue #66 como la base real.
if echo "$FN_SRC" | grep -q "El batch secuencial crea cada worktree desde la rama activa del repo"; then
    fail "el mensaje del gate todavia afirma que el worktree nace de la rama activa (falso desde el issue #66)"
else
    pass "el mensaje del gate ya no afirma que el worktree nace de la rama activa"
fi
if echo "$FN_SRC" | grep -q "origin/main" && echo "$FN_SRC" | grep -q "#66"; then
    pass "el gate cita origin/main + issue #66 como la base real del worktree"
else
    fail "el gate no cita origin/main ni el issue #66 como justificacion real"
fi

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

WARN_LOG="$TMP/warn.log"
ABORT_LOG="$TMP/abort.log"
STATE_LOG="$TMP/state.log"

# run_gate <workdir> -- ejecuta la funcion real en un subshell con cwd en
# <workdir>, abort()/warn() instrumentados (abort sale con 77 en vez de matar
# el proceso). Vuelca MAIN_BRANCH resultante a STATE_LOG para inspeccion.
run_gate() {
    local workdir="$1"
    : > "$WARN_LOG"; : > "$ABORT_LOG"; : > "$STATE_LOG"
    (
        cd "$workdir" || exit 9
        MEFISTO_REPO_ROOT="$workdir"
        warn()  { echo "$1" >> "$WARN_LOG"; }
        abort() { echo "$1" >> "$ABORT_LOG"; exit 77; }
        eval "$FN_SRC"
        ensure_repo_on_base_branch
        echo "MAIN_BRANCH=$MAIN_BRANCH" > "$STATE_LOG"
    )
}

# -------- Fixture de repos: bare "origin" + un clone "publisher" que simula --------
# -------- otra sesion avanzando el remoto, separado del work tree bajo prueba --------

BARE="$TMP/origin.git"
git init -q --bare "$BARE"
# No dependemos de la init.defaultBranch de la maquina: con 'master' por
# default el clone del bare no aterrizaria en 'main' y los bloques D/E/F
# medirian otra cosa.
git -C "$BARE" symbolic-ref HEAD refs/heads/main

PUBLISHER="$TMP/publisher"
git clone -q "$BARE" "$PUBLISHER"
git -C "$PUBLISHER" config user.email "test@mefisto.local"
git -C "$PUBLISHER" config user.name "Mefisto Test"
git -C "$PUBLISHER" checkout -q -b main 2>/dev/null || git -C "$PUBLISHER" checkout -q main
git -C "$PUBLISHER" commit -q --allow-empty -m "c1 (estado inicial)"
git -C "$PUBLISHER" push -q origin main

new_work_clone() {
    local name="$1"
    git clone -q "$BARE" "$TMP/$name"
    git -C "$TMP/$name" config user.email "test@mefisto.local"
    git -C "$TMP/$name" config user.name "Mefisto Test"
    echo "$TMP/$name"
}

# -------- Bloque A: arbol limpio, origin adelanto -- se auto-recupera (CA-1) --------

echo ""
echo "[A] Rama != main/master, arbol LIMPIO, origin adelanto: se auto-recupera y arranca (CA-1)"

WORK_A=$(new_work_clone "work-a")
git -C "$WORK_A" checkout -q -b docs/field-notes-refinamiento-718

git -C "$PUBLISHER" commit -q --allow-empty -m "c2 (avanza origin/main mientras el batch corria)"
git -C "$PUBLISHER" push -q origin main
HEAD_SHA_A=$(git -C "$PUBLISHER" rev-parse main)

run_gate "$WORK_A"
RC=$?

if [ "$RC" -eq 0 ]; then
    pass "A: no aborta (exit 0)"
else
    fail "A: se esperaba exit 0, se obtuvo $RC. abort: $(cat "$ABORT_LOG")"
fi

HEAD_AFTER_A=$(git -C "$WORK_A" rev-parse --abbrev-ref HEAD)
if [ "$HEAD_AFTER_A" = "main" ]; then
    pass "A: HEAD quedo en 'main' (auto-recuperado)"
else
    fail "A: HEAD deberia quedar en 'main', quedo en '$HEAD_AFTER_A'"
fi

MAIN_SHA_AFTER_A=$(git -C "$WORK_A" rev-parse main)
if [ "$MAIN_SHA_AFTER_A" = "$HEAD_SHA_A" ]; then
    pass "A: 'main' local quedo sincronizado con origin/main (pull --ff-only trajo el commit nuevo)"
else
    fail "A: 'main' deberia apuntar a $HEAD_SHA_A, quedo en $MAIN_SHA_AFTER_A"
fi

if grep -qF "docs/field-notes-refinamiento-718" "$WARN_LOG"; then
    pass "A: el warn nombra la rama original"
else
    fail "A: el warn no nombro la rama original. Contenido: $(cat "$WARN_LOG")"
fi

if grep -qF "MAIN_BRANCH=main" "$STATE_LOG"; then
    pass "A: MAIN_BRANCH queda en 'main' tras la auto-recuperacion"
else
    fail "A: MAIN_BRANCH no quedo en 'main'. Contenido: $(cat "$STATE_LOG")"
fi

# -------- Bloque B: arbol SUCIO -- aborta, no auto-recupera (CA-2) --------

echo ""
echo "[B] Rama != main/master, arbol SUCIO: aborta fail-loud sin tocar HEAD (CA-2)"

WORK_B=$(new_work_clone "work-b")
git -C "$WORK_B" checkout -q -b feature-sucia
echo "cambio staged" > "$WORK_B/archivo-staged.txt"
git -C "$WORK_B" add archivo-staged.txt
echo "cambio modificado" > "$WORK_B/archivo-modificado.txt"
git -C "$WORK_B" add archivo-modificado.txt
echo "cambio posterior" >> "$WORK_B/archivo-modificado.txt"
echo "cambio sin trackear" > "$WORK_B/archivo-sin-trackear.txt"

run_gate "$WORK_B"
RC=$?

if [ "$RC" -eq 77 ]; then
    pass "B: aborta (exit 77 via el abort() instrumentado)"
else
    fail "B: se esperaba abort (exit 77), se obtuvo $RC"
fi

if grep -qi "limpio" "$ABORT_LOG"; then
    pass "B: el mensaje de abort aclara que la auto-recuperacion solo aplica con arbol limpio"
else
    fail "B: el mensaje de abort no menciono la condicion de arbol limpio. Contenido: $(cat "$ABORT_LOG")"
fi

HEAD_AFTER_B=$(git -C "$WORK_B" rev-parse --abbrev-ref HEAD)
if [ "$HEAD_AFTER_B" = "feature-sucia" ]; then
    pass "B: HEAD no se toco, sigue en 'feature-sucia'"
else
    fail "B: HEAD deberia seguir en 'feature-sucia', quedo en '$HEAD_AFTER_B'"
fi

if [ -f "$WORK_B/archivo-sin-trackear.txt" ]; then
    pass "B: el archivo sin commitear sigue presente (no se descarto nada)"
else
    fail "B: el archivo sin commitear desaparecio"
fi

if git -C "$WORK_B" diff --cached --quiet; then
    fail "B: el cambio staged desaparecio"
else
    pass "B: el cambio staged sigue presente"
fi

if git -C "$WORK_B" diff --quiet; then
    fail "B: el cambio modificado desaparecio"
else
    pass "B: el cambio modificado sigue presente"
fi

# -------- Bloque C: arbol limpio pero 'main' local diverge de origin (CA-3) --------

echo ""
echo "[C] Rama != main/master, arbol LIMPIO, pero main LOCAL diverge de origin/main: aborta tras el switch (CA-3)"

WORK_C=$(new_work_clone "work-c")
git -C "$WORK_C" checkout -q main
git -C "$WORK_C" commit -q --allow-empty -m "commit local divergente (nunca llego a origin)"
DIVERGENT_SHA_C=$(git -C "$WORK_C" rev-parse main)
git -C "$WORK_C" checkout -q -b feature-diverge

git -C "$PUBLISHER" commit -q --allow-empty -m "c3 (otro commit en origin, incompatible con el divergente)"
git -C "$PUBLISHER" push -q origin main

run_gate "$WORK_C"
RC=$?

if [ "$RC" -eq 77 ]; then
    pass "C: aborta (exit 77) -- el pull --ff-only fue rechazado por divergencia"
else
    fail "C: se esperaba abort (exit 77), se obtuvo $RC"
fi

if grep -qi "diverge" "$ABORT_LOG"; then
    pass "C: el mensaje de abort explica la divergencia"
else
    fail "C: el mensaje de abort no explico la divergencia. Contenido: $(cat "$ABORT_LOG")"
fi

HEAD_AFTER_C=$(git -C "$WORK_C" rev-parse --abbrev-ref HEAD)
if [ "$HEAD_AFTER_C" = "main" ]; then
    pass "C: HEAD quedo en 'main' (el switch si ocurrio antes de que el pull fallara)"
else
    fail "C: HEAD deberia quedar en 'main' (el switch precede al pull), quedo en '$HEAD_AFTER_C'"
fi

MAIN_SHA_AFTER_C=$(git -C "$WORK_C" rev-parse main)
if [ "$MAIN_SHA_AFTER_C" = "$DIVERGENT_SHA_C" ]; then
    pass "C: 'main' local no se toco (el pull --ff-only rechazado no fuerza nada)"
else
    fail "C: 'main' deberia seguir en $DIVERGENT_SHA_C, quedo en $MAIN_SHA_AFTER_C"
fi

# -------- Bloque D: ya en 'main' -- no-op --------

echo ""
echo "[D] Ya en 'main': no-op, sin abort ni warn"

WORK_D=$(new_work_clone "work-d")

run_gate "$WORK_D"
RC=$?

if [ "$RC" -eq 0 ] && [ ! -s "$ABORT_LOG" ] && [ ! -s "$WARN_LOG" ]; then
    pass "D: no-op -- sin abort ni warn cuando ya se arranca en 'main'"
else
    fail "D: se esperaba no-op (exit 0, sin logs). exit=$RC abort=$(cat "$ABORT_LOG") warn=$(cat "$WARN_LOG")"
fi

if grep -qF "MAIN_BRANCH=main" "$STATE_LOG"; then
    pass "D: MAIN_BRANCH queda en 'main'"
else
    fail "D: MAIN_BRANCH inesperado. Contenido: $(cat "$STATE_LOG")"
fi

# -------- Bloque E: 'main' y 'master' locales coexisten -- se prefiere 'main' --------

echo ""
echo "[E] 'main' y 'master' locales coexisten: la auto-recuperacion prefiere 'main'"

WORK_E=$(new_work_clone "work-e")
git -C "$WORK_E" branch master main
git -C "$WORK_E" checkout -q -b feature-e

run_gate "$WORK_E"
RC=$?

HEAD_AFTER_E=$(git -C "$WORK_E" rev-parse --abbrev-ref HEAD)
if [ "$RC" -eq 0 ] && [ "$HEAD_AFTER_E" = "main" ]; then
    pass "E: se auto-recupero a 'main', no a 'master'"
else
    fail "E: se esperaba HEAD en 'main' (exit 0), obtuvo exit=$RC HEAD='$HEAD_AFTER_E'"
fi

# -------- Bloque F: HEAD detached con arbol limpio -- se recupera igual --------

echo ""
echo "[F] HEAD detached con arbol limpio: se recupera por el mismo camino (nota tecnica del issue)"

WORK_F=$(new_work_clone "work-f")
git -C "$WORK_F" checkout -q --detach main

run_gate "$WORK_F"
RC=$?

HEAD_AFTER_F=$(git -C "$WORK_F" rev-parse --abbrev-ref HEAD)
if [ "$RC" -eq 0 ] && [ "$HEAD_AFTER_F" = "main" ]; then
    pass "F: HEAD detached con arbol limpio se recupero a 'main' sin abortar"
else
    fail "F: se esperaba HEAD en 'main' (exit 0), obtuvo exit=$RC HEAD='$HEAD_AFTER_F'. abort: $(cat "$ABORT_LOG")"
fi

# -------- Bloque G: ya en 'master' -- no-op historico --------

echo ""
echo "[G] Ya en 'master' y sin 'main': no-op, sin abort ni warn"

WORK_G=$(new_work_clone "work-g")
git -C "$WORK_G" branch -m main master
git -C "$WORK_G" branch --unset-upstream >/dev/null 2>&1 || true

run_gate "$WORK_G"
RC=$?

HEAD_AFTER_G=$(git -C "$WORK_G" rev-parse --abbrev-ref HEAD)
if [ "$RC" -eq 0 ] && [ "$HEAD_AFTER_G" = "master" ] && [ ! -s "$ABORT_LOG" ] && [ ! -s "$WARN_LOG" ]; then
    pass "G: conserva el no-op cuando la rama activa ya es 'master'"
else
    fail "G: se esperaba no-op en master; exit=$RC HEAD='$HEAD_AFTER_G' abort=$(cat "$ABORT_LOG") warn=$(cat "$WARN_LOG")"
fi

if grep -qF "MAIN_BRANCH=master" "$STATE_LOG"; then
    pass "G: MAIN_BRANCH queda en 'master'"
else
    fail "G: MAIN_BRANCH inesperado. Contenido: $(cat "$STATE_LOG")"
fi

# -------- Resumen --------

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
