#!/usr/bin/env bash
# test-batch-runtime.sh -- Tests del porte del motor batch interno al runtime
# neutral (MEF-ADR-0049, issue #870).
#
# Cubre:
#   [pre] mefisto-batch-pipeline.sh y mefisto-validate-batch-deps.sh viven en
#         src/internal/scripts/ con sintaxis bash valida; sus shims en
#         .claude/scripts/ siguen la plantilla exacta de exec de 3 lineas
#         (CA-1), y reenvian de verdad (mismo exit code que el canonico).
#   [A]   El pipeline canonico resuelve su estado con MEFISTO_STATE_DIR, no
#         con la ruta legacy hardcodeada (CA-4).
#   [B]   Guard de regresion (CA-4): ninguna linea de CODIGO (no comentario)
#         del pipeline canonico contiene '.claude/pipeline' ni '.claude/scripts'
#         -- mismo criterio que test-tooling-state-paths.sh bloque I: los
#         comentarios SI pueden nombrar esas rutas al documentar el shim.
#   [C]   El eslabon invoca el pipeline de tooling CANONICO desde su snapshot
#         aislado, nunca el shim ni el checkout mutable (CA-3).
#   [D]   La precondicion de dependencias comprueba git, gh, jq y llama a
#         mefisto_resolve_runtime -- ya no 'claude' a secas (CA-2).
#   [E]   Corrida real de dos issues con stubs de gh y un tooling-pipeline
#         falso, en los dos modos MEFISTO_RUNTIME=claude y =fake (CA-6):
#         - el CLI exigido es el especifico del runtime resuelto (falta
#           'claude' aborta en modo claude aunque 'fake' este presente, y
#           viceversa), el mensaje de abort indica fijar MEFISTO_RUNTIME como
#           remedio;
#         - con el CLI presente, el eslabon HEREDA MEFISTO_RUNTIME ya resuelto
#           (CA-3) -- tanto cuando llega del entorno como cuando el batch lo
#           AUTODETECTA -- y un fallo en el primer eslabon (--stop-on-error)
#           detiene la cadena ANTES de invocar el segundo eslabon.
#
# Uso: .claude/scripts/tests/test-batch-runtime.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

CANON_BATCH="$REPO_ROOT/src/internal/scripts/mefisto-batch-pipeline.sh"
CANON_DEPS="$REPO_ROOT/src/internal/scripts/mefisto-validate-batch-deps.sh"
CANON_LIB="$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"
CANON_RUNTIME="$REPO_ROOT/src/runtime"
SHIM_BATCH="$REPO_ROOT/.claude/scripts/mefisto-batch-pipeline.sh"
SHIM_DEPS="$REPO_ROOT/.claude/scripts/mefisto-validate-batch-deps.sh"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre: canonicos + shims presentes, sintaxis valida --------

echo "[pre] Canonicos y shims existen, con sintaxis bash valida"
for f in "$CANON_BATCH" "$CANON_DEPS" "$SHIM_BATCH" "$SHIM_DEPS"; do
    if [ -f "$f" ]; then
        pass "$(basename "$f"): presente"
    else
        fail "$f: ausente"
    fi
    if bash -n "$f" 2>/dev/null; then
        pass "$(basename "$f") ($f): sintaxis bash valida"
    else
        fail "$(basename "$f") ($f): sintaxis bash invalida"
    fi
done

if [ -x "$SHIM_BATCH" ] && [ -x "$SHIM_DEPS" ]; then
    pass "ambos shims tienen bit de ejecucion"
else
    fail "algun shim no es ejecutable"
fi

EXPECTED_EXEC_SHIM='exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"'
for shim in "$SHIM_BATCH" "$SHIM_DEPS"; do
    if grep -qF "$EXPECTED_EXEC_SHIM" "$shim"; then
        pass "$(basename "$shim"): usa la plantilla de exec documentada (CA-1)"
    else
        fail "$(basename "$shim"): no coincide con la plantilla de exec de src/internal/scripts/README.md"
    fi
    shim_code_lines=$(grep -vcE '^[[:space:]]*(#|$)' "$shim")
    if [ "$shim_code_lines" -eq 1 ]; then
        pass "$(basename "$shim"): no tiene logica propia (1 linea de codigo: el exec)"
    else
        fail "$(basename "$shim"): $shim_code_lines lineas de codigo (la plantilla tiene 1: el exec)"
    fi
done

# El shim REENVIA de verdad, no solo "contiene el exec correcto": la plantilla
# compone la ruta del canonico con '$0' y un '../..' relativo, asi que un shim
# textualmente perfecto colocado a la profundidad equivocada seguiria pasando
# el grep de arriba y fallaria en ejecucion. Se invoca cada par sin argumentos
# -- camino inocuo en ambos (usage del batch, guarda fail-loud del validador):
# ni tocan disco ni llaman a gh -- y se compara el exit code observado.
for pair in "$SHIM_BATCH:$CANON_BATCH:1" "$SHIM_DEPS:$CANON_DEPS:2"; do
    shim="${pair%%:*}"; rest="${pair#*:}"
    canon="${rest%%:*}"; expected="${rest##*:}"
    ( cd "$REPO_ROOT" && "$shim" ) </dev/null >/dev/null 2>&1; shim_rc=$?
    ( cd "$REPO_ROOT" && "$canon" ) </dev/null >/dev/null 2>&1; canon_rc=$?
    if [ "$shim_rc" -eq "$expected" ] && [ "$canon_rc" -eq "$expected" ]; then
        pass "$(basename "$shim"): el shim reenvia al canonico (ambos exit $expected sin args)"
    else
        fail "$(basename "$shim"): shim exit $shim_rc, canonico exit $canon_rc (se esperaba $expected en ambos)"
    fi
done

# -------- Bloque A: estado via MEFISTO_STATE_DIR, no ruta legacy --------

echo ""
echo "[A] El pipeline canonico resuelve su estado con MEFISTO_STATE_DIR (CA-4)"

if grep -qF 'PIPELINE_DIR="$MEFISTO_STATE_DIR"' "$CANON_BATCH"; then
    pass "PIPELINE_DIR se resuelve desde MEFISTO_STATE_DIR"
else
    fail "PIPELINE_DIR ya no se resuelve desde MEFISTO_STATE_DIR"
fi

# -------- Bloque B: guard de regresion -- sin rutas legacy en CODIGO --------

echo ""
echo "[B] Guard de regresion (CA-4): sin '.claude/pipeline' ni '.claude/scripts' en lineas de CODIGO"

for needle in '\.claude/pipeline' '\.claude/scripts'; do
    hits=$(grep -vE '^\s*#' "$CANON_BATCH" | grep -c "$needle" || true)
    if [ "$hits" -eq 0 ]; then
        pass "cero lineas de codigo con '$needle' en mefisto-batch-pipeline.sh"
    else
        fail "$hits linea(s) de codigo con '$needle' en mefisto-batch-pipeline.sh"
        grep -vE '^\s*#' "$CANON_BATCH" | grep -n "$needle"
    fi
done

# -------- Bloque C: invoca el pipeline de tooling CANONICO --------

echo ""
echo "[C] El eslabon invoca el tooling-pipeline CANONICO desde snapshot, no el shim (CA-3)"

if grep -qF 'PIPELINE_SCRIPT="$EXECUTION_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"' "$CANON_BATCH"; then
    pass "PIPELINE_SCRIPT resuelve contra el snapshot aislado"
else
    fail "PIPELINE_SCRIPT no resuelve contra el snapshot aislado"
fi

# -------- Bloque D: la precondicion usa mefisto_resolve_runtime --------

echo ""
echo "[D] La precondicion comprueba git, gh, jq y el CLI del runtime resuelto (CA-2)"

if grep -qF 'for dep in git gh jq; do' "$CANON_BATCH"; then
    pass "el bucle de dependencias comprueba git, gh, jq"
else
    fail "el bucle de dependencias no comprueba exactamente git, gh, jq"
fi
if grep -qF 'source "$(cd "$SCRIPT_DIR/../../runtime/lib" && pwd)/mefisto-runtime.sh"' "$CANON_BATCH"; then
    pass "el pipeline sourcea el discovery comun de src/runtime"
else
    fail "el pipeline no sourcea el discovery comun de src/runtime"
fi
if grep -qF 'mefisto_resolve_runtime' "$CANON_BATCH" && grep -qF 'command -v "$BATCH_RUNTIME"' "$CANON_BATCH"; then
    pass "la precondicion resuelve el runtime y verifica su CLI con command -v"
else
    fail "la precondicion no resuelve/verifica el CLI del runtime activo"
fi
if grep -qF 'Fija MEFISTO_RUNTIME con un runtime instalado.' "$CANON_BATCH"; then
    pass "el mensaje de remedio pide fijar MEFISTO_RUNTIME con un runtime instalado"
else
    fail "el mensaje de remedio no pide fijar MEFISTO_RUNTIME con un runtime instalado"
fi
if grep -qE '^\s*for dep in claude ' "$CANON_BATCH"; then
    fail "la precondicion todavia exige 'claude' a secas (deberia exigir el runtime resuelto)"
else
    pass "la precondicion ya no exige 'claude' a secas"
fi

# -------- Bloque E: corrida real con stubs, dos modos de runtime (CA-6) --------

echo ""
echo "[E] Corrida real de dos issues con stubs (gh + tooling-pipeline falso), MEFISTO_RUNTIME=claude/fake (CA-6)"

# setup_fake_repo <dir>
#
# Arma un repo Mefisto minimo, ya en 'main' (ensure_repo_on_base_branch hace
# no-op ahi sin importar si el arbol queda sucio despues), con los canonicos
# reales bajo prueba + un tooling-pipeline FALSO como sibling (para que
# PIPELINE_SCRIPT lo encuentre, bloque C de arriba).
setup_fake_repo() {
    local dir="$1"
    mkdir -p "$dir"
    git init -q "$dir"
    git -C "$dir" symbolic-ref HEAD refs/heads/main
    git -C "$dir" -c user.email="test@mefisto.local" -c user.name="Mefisto Test" commit -q --allow-empty -m "base"
    git -C "$dir" config user.email "test@mefisto.local"
    git -C "$dir" config user.name "Mefisto Test"
    # El batch de #1107 verifica origin/main antes de materializar su snapshot.
    # Un remoto local basta para este fixture sin proveedor y no toca red.
    git -C "$dir" remote add origin "$dir"

    mkdir -p "$dir/.claude-plugin" "$dir/src/internal/scripts/lib"
    cat > "$dir/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "0.0.0"
}
EOF
    cp "$CANON_LIB" "$dir/src/internal/scripts/lib/_mefisto-common.sh"
    cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$dir/src/internal/scripts/lib/mefisto-state.sh"
    cp -R "$CANON_RUNTIME" "$dir/src/runtime"
    cp "$CANON_BATCH" "$dir/src/internal/scripts/mefisto-batch-pipeline.sh"
    cp "$CANON_DEPS" "$dir/src/internal/scripts/mefisto-validate-batch-deps.sh"
    chmod +x "$dir/src/internal/scripts/mefisto-batch-pipeline.sh"
    chmod +x "$dir/src/internal/scripts/mefisto-validate-batch-deps.sh"
}

# fake_tooling_pipeline <dir> <call_log> <failing_issue>
#
# Sustituye el tooling-pipeline por un stub que registra cada issue invocado
# en <call_log> y falla (exit 1, sin URL de PR) solo para <failing_issue> --
# el resto "tiene exito" imprimiendo una URL de PR reconocible. Nunca se
# alcanza a invocar de verdad ningun CLI de agente: el stub reemplaza el
# pipeline COMPLETO, no un stage suyo.
fake_tooling_pipeline() {
    local dir="$1" call_log="$2" failing_issue="$3"
    cat > "$dir/src/internal/scripts/mefisto-tooling-pipeline.sh" <<EOF
#!/usr/bin/env bash
echo "\$1 MEFISTO_RUNTIME=\${MEFISTO_RUNTIME:-<sin-fijar>}" >> "$call_log"
if [ "\$1" = "$failing_issue" ]; then
    echo "fake tooling-pipeline: fallo simulado para el eslabon \$1" >&2
    exit 1
fi
echo "v PR creado: https://github.com/acme/mefisto-fake/pull/999"
exit 0
EOF
    chmod +x "$dir/src/internal/scripts/mefisto-tooling-pipeline.sh"
    git -C "$dir" add .
    git -C "$dir" commit -q -m "tooling falso"
    git -C "$dir" fetch -q origin main
}

FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/gh"

# PATH restringido a proposito (NUNCA "$FAKE_BIN:$PATH"): esta maquina de
# dogfooding tiene 'claude' realmente instalado (MEF-ADR-0049),
# tipicamente fuera de /usr/bin y /bin -- con el PATH real de fondo, el
# escenario "CLI ausente" nunca aborta porque 'command -v' sigue buscando mas
# alla de FAKE_BIN y encuentra el binario real. Solo /usr/bin:/bin:/usr/sbin:/sbin
# quedan detras de FAKE_BIN: ahi viven git/jq/coreutils (verificado en este
# entorno), nunca claude/gh.
SAFE_SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# run_batch <dir> <runtime|""> <args...>
#
# <runtime> vacio = MEFISTO_RUNTIME SIN FIJAR en el entorno: es el unico modo
# que ejerce la rama de AUTODETECCION de mefisto_resolve_runtime (y con ella el
# re-export del runtime resuelto hacia el eslabon). Con un valor, se fija en el
# entorno, que es la via de produccion (la antepone el comando generado, #867).
run_batch() {
    local dir="$1" runtime="$2"; shift 2
    local out="$TMP/stdout" err="$TMP/stderr"
    (
        cd "$dir" || exit 99
        if [ -n "$runtime" ]; then
            env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT \
                -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG -u MEFISTO_RUNTIME_LIB_DIR \
                MEFISTO_RUNTIME="$runtime" PATH="$FAKE_BIN:$SAFE_SYSTEM_PATH" \
                ./src/internal/scripts/mefisto-batch-pipeline.sh "$@"
        else
            env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT \
                -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG -u MEFISTO_RUNTIME_LIB_DIR \
                -u MEFISTO_RUNTIME PATH="$FAKE_BIN:$SAFE_SYSTEM_PATH" \
                ./src/internal/scripts/mefisto-batch-pipeline.sh "$@"
        fi
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

# E-1/E-2: el CLI exigido es el ESPECIFICO del runtime resuelto (no "alguno").
for pair in "claude:fake" "fake:claude"; do
    runtime="${pair%%:*}"
    other="${pair##*:}"

    DIR=$(mktemp -d)
    setup_fake_repo "$DIR"
    fake_tooling_pipeline "$DIR" "$TMP/call-log-missing-$runtime" "100"
    rm -f "$FAKE_BIN/claude" "$FAKE_BIN/fake"
    cat > "$FAKE_BIN/$other" <<STUB
#!/usr/bin/env bash
exit 0
STUB
    chmod +x "$FAKE_BIN/$other"

    run_batch "$DIR" "$runtime" 100 200
    if [ "$LAST_RC" -ne 0 ]; then
        pass "E: MEFISTO_RUNTIME=$runtime sin '$runtime' instalado (solo '$other' presente) aborta"
    else
        fail "E: MEFISTO_RUNTIME=$runtime sin '$runtime' instalado no deberia completar (rc=$LAST_RC)"
    fi
    # El mensaje de abort de esta precondicion viaja por stdout (mismo canal
    # que el "Dependencias faltantes" preexistente, sin '>&2'): se revisan
    # ambos flujos para no acoplar el assert a ese detalle de implementacion.
    if printf '%s\n%s' "$LAST_STDOUT" "$LAST_STDERR" | grep -qF "'$runtime'"; then
        pass "E: el mensaje de abort nombra '$runtime' especificamente (no '$other')"
    else
        fail "E: el mensaje de abort no nombro '$runtime'. stdout: $LAST_STDOUT / stderr: $LAST_STDERR"
    fi
    if printf '%s\n%s' "$LAST_STDOUT" "$LAST_STDERR" | grep -qF "Fija MEFISTO_RUNTIME con un runtime instalado."; then
        pass "E: el mensaje de abort indica fijar MEFISTO_RUNTIME como remedio"
    else
        fail "E: el mensaje de abort no indico el remedio. stdout: $LAST_STDOUT / stderr: $LAST_STDERR"
    fi
    if [ ! -s "$TMP/call-log-missing-$runtime" ]; then
        pass "E: el tooling-pipeline falso nunca se invoco (abort antes del primer eslabon)"
    else
        fail "E: el tooling-pipeline falso se invoco pese al CLI faltante: $(cat "$TMP/call-log-missing-$runtime")"
    fi
    rm -rf "$DIR"
done

# E-3/E-4: con el CLI presente, un fallo en el primer eslabon (--stop-on-error)
# detiene la cadena antes del segundo.
for runtime in claude fake; do
    DIR=$(mktemp -d)
    setup_fake_repo "$DIR"
    CALL_LOG="$TMP/call-log-stop-$runtime"
    : > "$CALL_LOG"
    fake_tooling_pipeline "$DIR" "$CALL_LOG" "100"

    rm -f "$FAKE_BIN/claude" "$FAKE_BIN/fake"
    cat > "$FAKE_BIN/$runtime" <<STUB
#!/usr/bin/env bash
exit 0
STUB
    chmod +x "$FAKE_BIN/$runtime"

    run_batch "$DIR" "$runtime" 100 200 --stop-on-error
    if [ "$LAST_RC" -ne 0 ]; then
        pass "E ($runtime): la cadena aborta (rc=$LAST_RC) cuando el primer eslabon falla con --stop-on-error"
    else
        fail "E ($runtime): la cadena no deberia completar (rc=$LAST_RC)"
    fi
    if grep -qF "100" "$CALL_LOG"; then
        pass "E ($runtime): el primer eslabon (issue 100) SI se invoco"
    else
        fail "E ($runtime): el primer eslabon nunca se invoco: $(cat "$CALL_LOG" 2>/dev/null)"
    fi
    # CA-3: el eslabon HEREDA el runtime ya resuelto por el batch. Se ejerce
    # con MEFISTO_RUNTIME fijado en el entorno, la via de produccion (lo
    # antepone el comando generado, issue #867).
    if grep -qF "100 MEFISTO_RUNTIME=$runtime" "$CALL_LOG"; then
        pass "E ($runtime): el eslabon heredo MEFISTO_RUNTIME=$runtime del batch"
    else
        fail "E ($runtime): el eslabon no heredo MEFISTO_RUNTIME=$runtime -- log: $(cat "$CALL_LOG")"
    fi
    if grep -qF "200" "$CALL_LOG"; then
        fail "E ($runtime): el segundo eslabon (issue 200) NO deberia haberse invocado -- log: $(cat "$CALL_LOG")"
    else
        pass "E ($runtime): el segundo eslabon (issue 200) nunca se invoco (el fallo del primero detuvo la cadena)"
    fi
    rm -rf "$DIR"
done

# E-5: MEFISTO_RUNTIME SIN FIJAR -- el batch autodetecta (un unico runtime
# disponible) y el eslabon debe recibir ESE runtime igual. Sin el re-export del
# valor ya resuelto, el hijo volveria a autodetectar por su cuenta y el runtime
# que el batch anuncia en su cabecera no seria el que ningun eslabon vio.
for runtime in claude fake; do
    DIR=$(mktemp -d)
    setup_fake_repo "$DIR"
    CALL_LOG="$TMP/call-log-auto-$runtime"
    : > "$CALL_LOG"
    # Falla a proposito: corta tras el Stage 1 (lo unico que este caso mide) sin
    # pagar los reintentos con sleep del sync verificado, que el stub de gh no
    # puede satisfacer.
    fake_tooling_pipeline "$DIR" "$CALL_LOG" "100"

    rm -f "$FAKE_BIN/claude" "$FAKE_BIN/fake"
    cat > "$FAKE_BIN/$runtime" <<STUB
#!/usr/bin/env bash
exit 0
STUB
    chmod +x "$FAKE_BIN/$runtime"

    # El adaptador fake solo se declara disponible con MEFISTO_FAKE_AVAILABLE=1.
    if [ "$runtime" = "fake" ]; then
        MEFISTO_FAKE_AVAILABLE=1 run_batch "$DIR" "" 100
    else
        run_batch "$DIR" "" 100
    fi
    if grep -qF "100 MEFISTO_RUNTIME=$runtime" "$CALL_LOG"; then
        pass "E (autodeteccion): el eslabon heredo MEFISTO_RUNTIME=$runtime resuelto por el batch"
    else
        fail "E (autodeteccion): el eslabon no heredo el runtime autodetectado '$runtime' -- log: $(cat "$CALL_LOG")"
    fi
    rm -rf "$DIR"
done

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
